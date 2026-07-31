/**
 * Loco Lift — midair control, tricks and landings.
 *
 * The moment the last wheel leaves the ground the Jeep becomes a stunt toy.
 * The player gets direct, immediate pitch and roll authority; the instant they
 * let go, an auto-level assist quietly rights the chassis so the landing is
 * clean. That combination — total freedom while inputting, forgiveness while
 * not — is what stops big air from being a punishment.
 *
 * Air rotation is applied by writing angular velocity directly rather than by
 * torque. With no contacts in play that is stable, exactly controllable, and
 * completely independent of whatever inertia tensor the backend computed.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import type { BodyHandle } from '../physics/PhysicsTypes';
import { JEEP_TUNING } from './VehicleTuning';
import type { AirTuning, VehicleTuningSet } from './VehicleTuning';
import type { VehicleFrame } from './Suspension';

const WORLD_UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

export class AirControl {
  /** this vehicle's air constants */
  private readonly T: AirTuning;

  constructor(tuning: VehicleTuningSet = JEEP_TUNING) {
    this.T = tuning.air;
  }

  /** seconds since the last wheel left the ground; 0 while grounded */
  airtime = 0;
  /** true once airtime passed the jump threshold — the public `isAirborne` */
  airborne = false;
  /** metres gained above the take-off point on the current jump */
  height = 0;
  /** true when the chassis is within the clean-landing cone right now */
  levelEnough = true;

  /** airtime of the landing that just happened — `airtime` is already zeroed */
  lastLandingAirtime = 0;
  /** whether that landing was inside the clean cone */
  lastLandingClean = false;

  private takeoffY = 0;
  private peakY = 0;
  private jumpAnnounced = false;
  private wasGrounded = true;

  /* trick accumulators, radians of rotation about the local axes */
  private rollAccum = 0;
  private pitchAccum = 0;
  private yawAccum = 0;
  private rollCount = 0;
  private flipCount = 0;
  private spinCount = 0;
  /** total trick points banked during this flight, handed to the land event */
  private trickPoints = 0;

  /* preallocated working vectors */
  private readonly ang = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();

  reset(): void {
    this.airtime = 0;
    this.airborne = false;
    this.height = 0;
    this.levelEnough = true;
    this.takeoffY = 0;
    this.peakY = 0;
    this.jumpAnnounced = false;
    this.wasGrounded = true;
    this.lastLandingAirtime = 0;
    this.lastLandingClean = false;
    this.clearTricks();
  }

  private clearTricks(): void {
    this.rollAccum = 0;
    this.pitchAccum = 0;
    this.yawAccum = 0;
    this.rollCount = 0;
    this.flipCount = 0;
    this.spinCount = 0;
    this.trickPoints = 0;
  }

  /**
   * @param airPitch -1 (nose down) .. 1 (nose up)
   * @param airRoll  -1 (roll left) .. 1 (roll right)
   * @param groundedCount 0..4
   * @returns points scored by the landing this step, 0 otherwise
   */
  step(
    dt: number,
    frame: VehicleFrame,
    body: BodyHandle,
    airPitch: number,
    airRoll: number,
    groundedCount: number,
    bus: EventBus,
  ): number {
    const grounded = groundedCount > 0;
    this.levelEnough = Math.acos(clamp(frame.upDot, -1, 1)) <= this.T.cleanLandingAngle;

    if (grounded) {
      let landedPoints = 0;
      if (!this.wasGrounded && this.jumpAnnounced) {
        landedPoints = this.land(frame, bus);
      }
      this.wasGrounded = true;
      this.airborne = false;
      this.airtime = 0;
      this.height = 0;
      this.jumpAnnounced = false;
      this.clearTricks();
      return landedPoints;
    }

    /* ---------------------------------------------------------- airborne */
    if (this.wasGrounded) {
      this.takeoffY = frame.pos.y;
      this.peakY = frame.pos.y;
      this.clearTricks();
    }
    this.wasGrounded = false;

    this.airtime += dt;
    if (frame.pos.y > this.peakY) this.peakY = frame.pos.y;
    this.height = this.peakY - this.takeoffY;

    if (!this.jumpAnnounced && this.airtime >= this.T.minAirtimeForJump) {
      this.jumpAnnounced = true;
      this.airborne = true;
      bus.emit('vehicle:jumpStart', { speed: frame.speed });
    }
    if (this.airtime >= this.T.minAirtimeForJump) this.airborne = true;

    this.integrateTricks(dt, frame, bus);
    this.applyRotation(dt, frame, body, airPitch, airRoll);
    return 0;
  }

  /** Roll/pitch/yaw the chassis from player input plus the auto-level assist. */
  private applyRotation(
    dt: number,
    frame: VehicleFrame,
    body: BodyHandle,
    airPitch: number,
    airRoll: number,
  ): void {
    const pitchIn = clamp(airPitch, -1, 1);
    const rollIn = clamp(airRoll, -1, 1);
    const pitchActive = Math.abs(pitchIn) > this.T.autoLevelInputDeadzone;
    const rollActive = Math.abs(rollIn) > this.T.autoLevelInputDeadzone;

    /* read live rather than trusting the frame snapshot: impulses applied
     * earlier this step have already changed the body's angular velocity */
    const ang = body.getAngularVelocity(this.ang);

    /* --- player authority ---
     * +rate about `right`   = nose up
     * +rate about `forward` = right side down (roll right)
     * +rate about `up`      = nose swings left                                */
    ang.addScaledVector(frame.right, this.T.pitchAccel * pitchIn * dt);
    ang.addScaledVector(frame.forward, this.T.rollAccel * rollIn * dt);
    ang.addScaledVector(frame.up, -this.T.yawAccel * rollIn * dt);

    clampAxis(ang, frame.right, this.T.maxPitchRate);
    clampAxis(ang, frame.forward, this.T.maxRollRate);
    clampAxis(ang, frame.up, this.T.maxYawRate);

    /* --- passive damping: a real car in the air does not spin forever --- */
    ang.multiplyScalar(Math.exp(-this.T.angularDamping * dt));
    if (!pitchActive) dampAxis(ang, frame.right, this.T.idleAxisDamping, dt);
    if (!rollActive) dampAxis(ang, frame.forward, this.T.idleAxisDamping, dt);
    dampAxis(ang, frame.up, this.T.idleAxisDamping * 0.5, dt);

    /* --- auto-level assist ---
     * A PD controller that drives the chassis up-axis back to vertical. It
     * ramps in over the first fraction of a second (so kerb hops are untouched)
     * and gets more urgent the faster the Jeep is falling, which is what turns
     * a wild showboat into a clean landing. Yaw is deliberately untouched — the
     * player keeps whatever heading they chose. */
    if (!pitchActive && !rollActive) {
      const ramp =
        clamp01(this.airtime / Math.max(1e-3, this.T.autoLevelRampTime)) *
        (1 +
          this.T.autoLevelDescentBoost *
            clamp01(-frame.linVel.y / this.T.autoLevelDescentSpeed));
      const axis = this.axis.copy(frame.up).cross(WORLD_UP);
      const sinA = axis.length();
      if (sinA > 1e-5) {
        axis.multiplyScalar(1 / sinA);
        const angle = Math.atan2(sinA, clamp(frame.upDot, -1, 1));
        const rateAlong = ang.dot(axis);
        const accel = clamp(
          this.T.autoLevelStrength * angle * ramp - this.T.autoLevelDamping * rateAlong,
          -this.T.autoLevelMaxAccel,
          this.T.autoLevelMaxAccel,
        );
        ang.addScaledVector(axis, accel * dt);
      }
    }

    if (
      Number.isFinite(ang.x) &&
      Number.isFinite(ang.y) &&
      Number.isFinite(ang.z)
    ) {
      body.setAngularVelocity(ang);
    }
  }

  /** Watch for completed rotations and pay them out the instant they land. */
  private integrateTricks(dt: number, frame: VehicleFrame, bus: EventBus): void {
    if (this.airtime < this.T.minAirtimeForJump) return;

    this.rollAccum += frame.rollRate * dt;
    this.pitchAccum += frame.pitchRate * dt;
    this.yawAccum += frame.yawRate * dt;

    const full = this.T.trickFullTurn;

    while (Math.abs(this.rollAccum) >= full) {
      this.rollAccum -= Math.sign(this.rollAccum) * full;
      this.rollCount++;
      this.award(bus, chainName('Barrel Roll', this.rollCount), this.T.barrelRollPoints, this.rollCount);
    }

    while (Math.abs(this.pitchAccum) >= full) {
      const sign = Math.sign(this.pitchAccum);
      this.pitchAccum -= sign * full;
      this.flipCount++;
      const base = sign > 0 ? 'Backflip' : 'Frontflip';
      this.award(bus, chainName(base, this.flipCount), this.T.flipPoints, this.flipCount);
    }

    while (Math.abs(this.yawAccum) >= full) {
      this.yawAccum -= Math.sign(this.yawAccum) * full;
      this.spinCount++;
      this.award(bus, `${this.spinCount * 360} Spin`, this.T.spinPoints, this.spinCount);
    }
  }

  private award(bus: EventBus, name: string, base: number, chain: number): void {
    const points = Math.round(base * Math.pow(this.T.trickChainMultiplier, chain - 1));
    this.trickPoints += points;
    bus.emit('vehicle:airTrick', { name, points });
  }

  private land(frame: VehicleFrame, bus: EventBus): number {
    const airtime = this.airtime;
    const height = Math.max(0, this.height);
    const clean = this.levelEnough;
    this.lastLandingAirtime = airtime;
    this.lastLandingClean = clean;

    let points = 0;
    if (airtime >= this.T.minScoringAirtime) {
      points = Math.round(
        (airtime * this.T.pointsPerSecond + height * this.T.pointsPerMetre) *
          (clean ? this.T.cleanLandingBonus : 1),
      );
    }
    points += this.trickPoints;

    bus.emit('vehicle:jumpLand', { airtime, height, clean, points });
    return points;
  }
}

/* -------------------------------------------------------------- helpers */

/** Clamp the component of `v` along the unit axis `a` to ±max, in place. */
function clampAxis(v: THREE.Vector3, a: THREE.Vector3, max: number): void {
  const c = v.dot(a);
  if (c > max) v.addScaledVector(a, max - c);
  else if (c < -max) v.addScaledVector(a, -max - c);
}

/** Exponentially damp the component of `v` along the unit axis `a`, in place. */
function dampAxis(v: THREE.Vector3, a: THREE.Vector3, rate: number, dt: number): void {
  const c = v.dot(a);
  v.addScaledVector(a, c * (Math.exp(-rate * dt) - 1));
}

const CHAIN_PREFIX = ['', 'Double ', 'Triple ', 'Quad '];

function chainName(base: string, count: number): string {
  if (count <= 1) return base;
  if (count < CHAIN_PREFIX.length) return CHAIN_PREFIX[count - 1] + base;
  return `${count}x ${base}`;
}
