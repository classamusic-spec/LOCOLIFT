/**
 * Loco Lift — raycast suspension.
 *
 * Four independent spring/damper struts hung off the single dynamic chassis
 * body. Each strut fires one downward ray along the *vehicle's* up axis, finds
 * the road, and pushes the chassis away from it along the contact normal.
 * Anti-roll bars tie each axle together so the Jeep leans instead of flopping.
 *
 * Nothing here allocates after construction. Every vector is a preallocated
 * field; the only garbage produced per step is whatever the physics backend
 * returns from `raycast`, which we do not control.
 *
 * Forces are applied as impulses (force · dt) rather than persistent forces so
 * the module is immune to whether the physics backend clears accumulated forces
 * between steps.
 */
import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/MathUtils';
import type { BodyHandle, PhysicsWorldAPI } from '../physics/PhysicsTypes';
import { GROUP } from '../physics/PhysicsTypes';
import { JEEP_TUNING } from './VehicleTuning';
import type { SuspensionTuning, VehicleTuningSet, WheelPlacement } from './VehicleTuning';

/** Everything about the chassis this step, computed once and shared. */
export interface VehicleFrame {
  /** body origin, world space */
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** world-space centre of mass */
  com: THREE.Vector3;
  /** linear velocity of the centre of mass */
  linVel: THREE.Vector3;
  angVel: THREE.Vector3;
  /** unit world-space basis of the chassis */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** |linVel| */
  speed: number;
  /** signed velocity along `forward` */
  forwardSpeed: number;
  /** signed velocity along `right` */
  lateralSpeed: number;
  /** signed velocity along `up` */
  verticalSpeed: number;
  /** chassis slip angle, radians; positive = tail sliding so the nose points left */
  slipAngle: number;
  /** angular velocity about the chassis up axis, rad/s */
  yawRate: number;
  /** angular velocity about the chassis right axis (nose up positive), rad/s */
  pitchRate: number;
  /** angular velocity about the chassis forward axis, rad/s */
  rollRate: number;
  /** chassis pitch relative to level, radians (nose up positive) */
  pitch: number;
  /** chassis roll relative to level, radians (right side down positive) */
  roll: number;
  /** up · worldUp — 1 upright, -1 on its roof */
  upDot: number;
}

/** Per-wheel state. Read by the tyre model, the Jeep mesh and the FX system. */
export interface WheelState {
  readonly index: number;
  readonly isFront: boolean;
  readonly isLeft: boolean;
  /** suspension top mount, chassis local space */
  readonly anchorLocal: THREE.Vector3;

  /** suspension top mount, world space */
  anchorWorld: THREE.Vector3;
  /** true when the ray found drivable ground within travel */
  grounded: boolean;
  /** 0 = fully drooped, 1 = bottomed out */
  compression: number;
  /** smoothed copy used by the mesh only */
  visualCompression: number;
  /** anchor -> wheel-centre distance along the strut, metres */
  springLength: number;

  contactPoint: THREE.Vector3;
  contactNormal: THREE.Vector3;
  /** wheel hub position, world space */
  centerWorld: THREE.Vector3;
  /** velocity of the contact patch, world space */
  contactVel: THREE.Vector3;

  /** normal load carried by this corner, N */
  load: number;
  /** whatever the physics backend tagged the surface body with */
  surface: unknown;

  /** steer angle applied to this wheel, radians */
  steer: number;
  /** accumulated wheel rotation for the mesh, radians */
  spinAngle: number;
  /** wheel angular velocity, rad/s */
  spinRate: number;

  /** contact-patch slide speeds, m/s */
  slipLat: number;
  slipLong: number;
  /** 0..1 combined slip for skid marks and smoke */
  slip: number;

  /** wheel heading projected onto the contact plane */
  forwardDir: THREE.Vector3;
  rightDir: THREE.Vector3;
}

const WORLD_UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

export class Suspension {
  readonly wheels: WheelState[] = [];

  /** 0..4 */
  groundedCount = 0;
  /** sum of all four normal loads this step, N */
  totalLoad = 0;

  /** this vehicle's suspension constants */
  private readonly T: SuspensionTuning;
  private readonly layout: readonly WheelPlacement[];

  /** ray length: full travel + the tyre + a little slack */
  private readonly rayLength: number;
  private readonly rayMask = GROUP.WORLD | GROUP.PROP;

  /* preallocated scratch — nothing in this class allocates per step */
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpArm = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();
  private readonly tmpImpulse = new THREE.Vector3();

  constructor(tuning: VehicleTuningSet = JEEP_TUNING) {
    this.T = tuning.suspension;
    this.layout = tuning.wheels;
    this.rayLength = this.T.restLength + this.T.wheelRadius + this.T.raySkin;
    for (let i = 0; i < this.layout.length; i++) {
      const l = this.layout[i];
      this.wheels.push({
        index: i,
        isFront: l.front,
        isLeft: l.left,
        anchorLocal: new THREE.Vector3(l.x, this.T.anchorY, l.z),
        anchorWorld: new THREE.Vector3(),
        grounded: false,
        compression: 0,
        visualCompression: 0,
        springLength: this.T.restLength,
        contactPoint: new THREE.Vector3(),
        contactNormal: new THREE.Vector3(0, 1, 0),
        centerWorld: new THREE.Vector3(),
        contactVel: new THREE.Vector3(),
        load: 0,
        surface: null,
        steer: 0,
        spinAngle: 0,
        spinRate: 0,
        slipLat: 0,
        slipLong: 0,
        slip: 0,
        forwardDir: new THREE.Vector3(0, 0, -1),
        rightDir: new THREE.Vector3(1, 0, 0),
      });
    }
  }

  /** Drop every wheel to full droop — used on respawn so nothing lingers. */
  reset(): void {
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.grounded = false;
      w.compression = 0;
      w.visualCompression = 0;
      w.springLength = this.T.restLength;
      w.load = 0;
      w.slip = 0;
      w.slipLat = 0;
      w.slipLong = 0;
      w.spinRate = 0;
      w.surface = null;
      w.contactNormal.set(0, 1, 0);
    }
    this.groundedCount = 0;
    this.totalLoad = 0;
  }

  /**
   * Cast the four rays and apply spring, damper and anti-roll impulses.
   * Must run before the tyre model — it produces the normal loads the tyres
   * turn into grip.
   */
  step(
    physics: PhysicsWorldAPI,
    body: BodyHandle,
    frame: VehicleFrame,
    dt: number,
  ): void {
    const dir = this.tmpDir.copy(frame.up).multiplyScalar(-1);
    let grounded = 0;
    let total = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];

      /* --- ray origin: the strut top mount, in world space --- */
      this.tmpOrigin.copy(w.anchorLocal).applyQuaternion(frame.quat).add(frame.pos);
      w.anchorWorld.copy(this.tmpOrigin);

      const hit = physics.raycast(this.tmpOrigin, dir, this.rayLength, this.rayMask, body);

      /* a near-vertical wall is not ground; refuse to spring off it */
      const usable = hit !== null && hit.normal.dot(frame.up) > 0.35 && hit.distance >= 0;

      if (!usable || hit === null) {
        w.grounded = false;
        w.compression = 0;
        w.springLength = this.T.restLength;
        w.load = 0;
        w.surface = null;
        w.contactNormal.copy(frame.up);
        w.centerWorld
          .copy(dir)
          .multiplyScalar(this.T.restLength)
          .add(w.anchorWorld);
        w.contactPoint
          .copy(dir)
          .multiplyScalar(this.T.restLength + this.T.wheelRadius)
          .add(w.anchorWorld);
        w.contactVel.set(0, 0, 0);
        continue;
      }

      /* --- geometry --- */
      const centreDist = hit.distance - this.T.wheelRadius;
      if (centreDist > this.T.restLength) {
        /* the tyre is hanging in space just past full droop */
        w.grounded = false;
        w.compression = 0;
        w.springLength = this.T.restLength;
        w.load = 0;
        w.surface = null;
        w.contactNormal.copy(hit.normal);
        w.centerWorld
          .copy(dir)
          .multiplyScalar(this.T.restLength)
          .add(w.anchorWorld);
        w.contactPoint.copy(hit.point);
        w.contactVel.set(0, 0, 0);
        continue;
      }

      const springLength = clamp(centreDist, 0, this.T.restLength);
      const compression = clamp01(1 - springLength / this.T.restLength);

      w.grounded = true;
      w.compression = compression;
      w.springLength = springLength;
      w.contactPoint.copy(hit.point);
      w.contactNormal.copy(hit.normal);
      w.surface = hit.userData ?? hit.body?.userData ?? null;
      w.centerWorld.copy(dir).multiplyScalar(springLength).add(w.anchorWorld);
      grounded++;

      /* --- velocity of the contact patch --- */
      this.tmpArm.copy(w.contactPoint).sub(frame.com);
      this.tmpVel.copy(frame.angVel).cross(this.tmpArm).add(frame.linVel);
      w.contactVel.copy(this.tmpVel);

      /* --- spring + damper along the contact normal --- */
      const rate = w.isFront ? this.T.springRateFront : this.T.springRateRear;
      const springForce = rate * compression * this.T.restLength;

      const vNormal = this.tmpVel.dot(w.contactNormal);
      const damperRate =
        vNormal < 0 ? this.T.damperCompress : this.T.damperRebound;
      const damperForce = -damperRate * vNormal;

      const force = clamp(springForce + damperForce, 0, this.T.maxSpringForce);
      w.load = force;
      total += force;

      this.tmpImpulse.copy(w.contactNormal).multiplyScalar(force * dt);
      body.applyImpulse(this.tmpImpulse, w.contactPoint);
    }

    this.groundedCount = grounded;
    this.totalLoad = total;

    this.applyAntiRoll(body, frame, dt, 0, 1, this.T.antiRollFront);
    this.applyAntiRoll(body, frame, dt, 2, 3, this.T.antiRollRear);
  }

  /**
   * Anti-roll bar for one axle. Pushes the compressed corner up and the drooping
   * corner down, proportional to the compression difference. Without this a tall
   * off-roader with long travel flops onto its door handles in every corner.
   */
  private applyAntiRoll(
    body: BodyHandle,
    frame: VehicleFrame,
    dt: number,
    leftIdx: number,
    rightIdx: number,
    rate: number,
  ): void {
    const l = this.wheels[leftIdx];
    const r = this.wheels[rightIdx];
    if (!l.grounded && !r.grounded) return;

    const diff = l.compression - r.compression;
    if (diff === 0) return;

    /* cap the transferred force so a one-wheel-in-a-pothole event stays sane */
    const force = clamp(diff * rate, -this.T.maxSpringForce * 0.5, this.T.maxSpringForce * 0.5);

    this.tmpImpulse.copy(frame.up).multiplyScalar(force * dt);
    body.applyImpulse(this.tmpImpulse, l.anchorWorld);

    this.tmpImpulse.copy(frame.up).multiplyScalar(-force * dt);
    body.applyImpulse(this.tmpImpulse, r.anchorWorld);
  }

  /**
   * Smooth the compression signal for the mesh only. Cobblestones make the raw
   * value jitter at 120 Hz; the wheels should not vibrate, the chassis should.
   */
  updateVisual(dt: number): void {
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const target = w.grounded ? w.compression : 1 - this.T.airborneDroop;
      w.visualCompression = damp(
        w.visualCompression,
        target,
        this.T.visualSmoothRate,
        dt,
      );
    }
  }

  /** Average compression of one axle, 0..1. Used for the visual body pitch. */
  axleCompression(front: boolean): number {
    const a = this.wheels[front ? 0 : 2].compression;
    const b = this.wheels[front ? 1 : 3].compression;
    return (a + b) * 0.5;
  }

  /** Average compression of one side, 0..1. Used for the visual body roll. */
  sideCompression(left: boolean): number {
    const a = this.wheels[left ? 0 : 1].compression;
    const b = this.wheels[left ? 2 : 3].compression;
    return (a + b) * 0.5;
  }

  /** True when the only wheels touching are both on the same side. */
  twoWheelSide(): -1 | 0 | 1 {
    const fl = this.wheels[0].grounded;
    const fr = this.wheels[1].grounded;
    const rl = this.wheels[2].grounded;
    const rr = this.wheels[3].grounded;
    if (fl && rl && !fr && !rr) return -1;
    if (fr && rr && !fl && !rl) return 1;
    return 0;
  }

  /** World up, exposed so callers don't allocate their own. */
  static get worldUp(): THREE.Vector3 {
    return WORLD_UP;
  }
}
