/**
 * Loco Lift — the player's vehicle.
 *
 * One dynamic box body plus four raycast struts. Everything the player feels is
 * produced here: torque curve and gearbox, per-wheel slip-angle tyres,
 * speed-sensitive steering with a bounded yaw-rate assist, drift, boost, air
 * control and every anti-frustration net that stops the player getting stuck.
 *
 * This class is vehicle-agnostic. Which vehicle it is comes entirely from the
 * `VehicleTuningSet` it is handed at construction (`opts.vehicleId`, resolved
 * through `VehicleRoster`): the Jeep and the Chinchorreo bus run the exact same
 * code and feel nothing alike. There is not one branch on vehicle type below.
 *
 * Design rules this file follows without exception:
 *  - No realistic tyre sim. Arcade responsiveness wins every argument.
 *  - Every feel constant lives in a tuning record. Nothing is hard-coded here.
 *  - Forces are applied as impulses (force · dt) so we never depend on whether
 *    the physics backend clears accumulated forces between steps.
 *  - Zero allocation in fixedUpdate / update / lateUpdate.
 *
 * Local axes: forward = -Z, right = +X, up = +Y.
 * Wheels: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
 */
import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import type { EventBus } from '../core/EventBus';
import {
  clamp,
  clamp01,
  damp,
  lerp,
  moveTowards,
  scratch,
  smoothstep,
} from '../core/MathUtils';
import type { GameContext, QualityTier, SettingsState, System } from '../core/types';
import type {
  BodyDesc,
  BodyHandle,
  ContactEvent,
  PhysicsWorldAPI,
} from '../physics/PhysicsTypes';
import { GROUP } from '../physics/PhysicsTypes';
import { AirControl } from './AirControl';
import { BoostSystem } from './BoostSystem';
import { DriftModel } from './DriftModel';
import { Suspension } from './Suspension';
import type { VehicleFrame } from './Suspension';
import {
  DEFAULT_VEHICLE_ID,
  getVehicleDefinition,
  type VehicleDefinition,
  type VehicleId,
} from './VehicleRoster';
import {
  JEEP_TUNING,
  staticCompression,
  staticRideHeight,
} from './VehicleTuning';
import type {
  BeatSource,
  BoostTuning,
  BrakeTuning,
  ChassisTuning,
  CollisionTuning,
  EngineTuning,
  ModelFeel,
  NearMissTuning,
  RecoveryTuning,
  SpeedTuning,
  SteerTuning,
  SuspensionTuning,
  TwoWheelTuning,
  TyreTuning,
  VehicleModel,
  VehicleTuningSet,
} from './VehicleTuning';

export interface VehicleOpts {
  scene: THREE.Scene;
  physics: PhysicsWorldAPI;
  /** where the vehicle starts; defaults to the origin at ride height */
  position?: THREE.Vector3;
  /** starting heading in radians (rotation about +Y) */
  heading?: number;
  quality?: QualityTier;
  /**
   * Which vehicle to drive. Defaults to the Jeep, so every existing call site
   * keeps exactly the vehicle it always had. See `VehicleRoster.ts`.
   */
  vehicleId?: VehicleId;
}

type CollisionKind = 'traffic' | 'prop' | 'wall' | 'ped';

/**
 * Optional reactions a vehicle's mesh may implement, over and above the
 * `VehicleModel` contract.
 *
 * A machine does not care that it was hit; an animal does. The carriage's horse
 * shies away from an impact or a near miss, and nothing in `VehicleModel`
 * carries that signal, so it is declared here structurally rather than widening
 * the contract every vehicle has to satisfy. Models that don't implement these
 * are unaffected — the Jeep and the bus never notice.
 */
interface ReactiveModel {
  /** something hit us. `fromRight` is the side it came from: +1 right, −1 left */
  reactToImpact?(impulse: number, fromRight: number): void;
  /** something just missed us, at `speed` m/s, from the same signed side */
  reactToNearMiss?(speed: number, fromRight: number): void;
}

/** Static ride height of the Jeep's body origin above the road, metres. */
const STATIC_RIDE_HEIGHT = staticRideHeight(JEEP_TUNING, CONFIG.gravity);

/** Static compression the Jeep's springs settle at under its own weight, 0..1 */
const STATIC_COMPRESSION = staticCompression(JEEP_TUNING, CONFIG.gravity);

const WORLD_UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const NEAR_MISS_MASK = GROUP.TRAFFIC | GROUP.PED;

export class Vehicle implements System {
  readonly name = 'vehicle';

  /** root transform of the vehicle — the chase camera parents/reads off this */
  readonly object3d: THREE.Object3D;
  readonly body: BodyHandle;
  readonly model: VehicleModel;
  /** the same model, viewed through the optional-reactions lens (see above) */
  private readonly reactive: ReactiveModel;

  /** which vehicle from the roster this is */
  readonly definition: VehicleDefinition;
  /** every feel constant for this vehicle, in one record */
  readonly tuning: VehicleTuningSet;

  private readonly physics: PhysicsWorldAPI;
  private readonly scene: THREE.Scene;

  private readonly suspension: Suspension;
  private readonly drift: DriftModel;
  private readonly boost: BoostSystem;
  private readonly air: AirControl;

  /* ---------------------------------------------------------------- tuning
   * Local aliases onto `tuning`, so the simulation below reads exactly as it
   * did when these were module constants. Assigned in the constructor because
   * class field initialisers run before it. */
  private readonly chassisT: ChassisTuning;
  private readonly suspT: SuspensionTuning;
  private readonly engineT: EngineTuning;
  private readonly speedT: SpeedTuning;
  private readonly brakeT: BrakeTuning;
  private readonly steerT: SteerTuning;
  private readonly tyreT: TyreTuning;
  private readonly boostT: BoostTuning;
  private readonly modelT: ModelFeel;
  private readonly twoWheelsT: TwoWheelTuning;
  private readonly nearMissT: NearMissTuning;
  private readonly collisionT: CollisionTuning;
  private readonly recoveryT: RecoveryTuning;

  /** static ride height and spring compression for THIS vehicle */
  private readonly rideHeight: number;
  private readonly restCompression: number;

  /* ------------------------------------------------------------ frame state */
  private readonly frame: VehicleFrame = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    com: new THREE.Vector3(),
    linVel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    speed: 0,
    forwardSpeed: 0,
    lateralSpeed: 0,
    verticalSpeed: 0,
    slipAngle: 0,
    yawRate: 0,
    pitchRate: 0,
    rollRate: 0,
    pitch: 0,
    roll: 0,
    upDot: 1,
  };

  /* ------------------------------------------------------------- drivetrain */
  private gearIndex = 0;
  private reverseMode = false;
  private reverseHold = 0;
  private shiftTimer = 0;
  private rpm = 0;
  private rpmSmoothed = 0;

  /* ---------------------------------------------------------------- steering */
  private _steerAngle = 0;

  /** 0..1 soft-limiter factor from the last drivetrain update; boost reads it */
  private speedHeadroom = 1;

  /* ---------------------------------------------------------------- controls */
  private throttleInput = 0;
  private brakeInput = 0;
  private steerInput = 0;
  private handbrakeInput = 0;
  private boostInput = false;
  private airPitchInput = 0;
  private airRollInput = 0;
  private assistSteering = 0.35;
  private holdToBoost = true;

  /* ------------------------------------------------------------ two wheeler */
  private twoWheelTimer = 0;
  private twoWheelGrace = 0;

  /* ------------------------------------------------------------ frustration */
  private flipTimer = 0;
  private safePointTimer = 0;
  private readonly safePos = new THREE.Vector3();
  private safeHeading = 0;
  private respawnFreeze = 0;

  /* ------------------------------------------------------------- near misses */
  private nearMissTimer = 0;
  private readonly nearMissSeen = new Map<number, number>();
  private readonly collisionLock = new Map<number, number>();
  private readonly nearMissPool: THREE.Vector3[] = [];
  private nearMissCursor = 0;
  private elapsed = 0;

  /* -------------------------------------------------------------- collisions */
  private unsubContact: (() => void) | null = null;
  private lastCollisionAt = -999;
  private hardHitPending = false;
  private lastImpulse = 0;
  private lastImpulseAt = -999;

  /* -------------------------------------------------------------- public out */
  private readonly _compression = new Float32Array(4);
  private readonly _slip = new Float32Array(4);
  private readonly _tilt = { pitch: 0, roll: 0 };
  private readonly _wheelContacts: THREE.Vector3[] = [];
  private readonly _wheelHubs: THREE.Vector3[] = [];

  /* ------------------------------------------------------------------ visual */
  private visualPitch = 0;
  private visualRoll = 0;
  private visualHeave = 0;
  private headlightsOn = false;
  private brakeLightsOn = false;
  private lightShowScale = -1;

  /* -------------------------------------------------------- horn + air brakes */
  private hornWasDown = false;
  private lastHornAt = -999;
  /** seconds of hard braking banked in the air reservoir */
  private airBrakeCharge = 0;
  private lastHissAt = -999;

  /* ------------------------------------------------------------------ scratch */
  private readonly tmpForce = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpPoint = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly wheelDrive = new Float32Array(4);
  private readonly wheelBrake = new Float32Array(4);

  private disposed = false;
  private busRef: EventBus | null = null;

  constructor(opts: VehicleOpts) {
    this.physics = opts.physics;
    this.scene = opts.scene;

    /* --- pick the vehicle and unpack its tuning before anything else --- */
    this.definition = getVehicleDefinition(opts.vehicleId ?? DEFAULT_VEHICLE_ID);
    const t = this.definition.tuning;
    this.tuning = t;
    this.chassisT = t.chassis;
    this.suspT = t.suspension;
    this.engineT = t.engine;
    this.speedT = t.speed;
    this.brakeT = t.brake;
    this.steerT = t.steer;
    this.tyreT = t.tyre;
    this.boostT = t.boost;
    this.modelT = t.model;
    this.twoWheelsT = t.twoWheels;
    this.nearMissT = t.nearMiss;
    this.collisionT = t.collision;
    this.recoveryT = t.recovery;
    this.rideHeight = staticRideHeight(t, CONFIG.gravity);
    this.restCompression = staticCompression(t, CONFIG.gravity);

    this.suspension = new Suspension(t);
    this.drift = new DriftModel(t);
    this.boost = new BoostSystem(t);
    this.air = new AirControl(t);

    this.rpm = this.engineT.idleRpm;
    this.rpmSmoothed = this.engineT.idleRpm;

    const spawn = opts.position
      ? scratch.v1.copy(opts.position)
      : scratch.v1.set(0, this.rideHeight, 0);
    const heading = opts.heading ?? 0;
    const quat = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, heading);

    const desc: BodyDesc = {
      kind: 'dynamic',
      shape: {
        type: 'box',
        hx: this.chassisT.colliderHalfX,
        hy: this.chassisT.colliderHalfY,
        hz: this.chassisT.colliderHalfZ,
      },
      position: spawn.clone(),
      quaternion: quat,
      mass: this.chassisT.mass,
      friction: this.chassisT.friction,
      restitution: this.chassisT.restitution,
      linearDamping: this.chassisT.linearDamping,
      angularDamping: this.chassisT.angularDamping,
      group: GROUP.VEHICLE,
      mask: GROUP.WORLD | GROUP.PROP | GROUP.TRAFFIC | GROUP.PED | GROUP.TRIGGER | GROUP.DEBRIS,
      ccd: true,
      centerOfMass: new THREE.Vector3(this.chassisT.comLocalX, this.chassisT.comLocalY, this.chassisT.comLocalZ),
      userData: { kind: 'vehicle', tag: 'player' },
    };

    /* A tall body (the bus) needs its collider lifted clear of the axle line,
     * which the physics layer supports as a collider-local translation. The
     * Jeep's offset is 0, so its box is authored symmetric about the origin
     * exactly as it always was. */
    if (t.colliderOffsetY !== 0) {
      desc.colliderOffset = new THREE.Vector3(0, t.colliderOffsetY, 0);
    }

    this.body = this.physics.createBody(desc);

    this.model = this.definition.createModel(opts.quality ?? 'high');
    this.reactive = this.model as ReactiveModel;
    this.object3d = this.model.object3d;
    this.object3d.position.copy(spawn);
    this.object3d.quaternion.copy(quat);
    this.scene.add(this.object3d);

    this.safePos.copy(spawn);
    this.safeHeading = heading;

    for (let i = 0; i < 4; i++) {
      this._wheelContacts.push(new THREE.Vector3());
      this._wheelHubs.push(new THREE.Vector3());
    }
    for (let i = 0; i < 8; i++) this.nearMissPool.push(new THREE.Vector3());

    this.readFrame();
    this.syncTransform();
  }

  /** Symmetry with the other modules' factories. */
  static create(opts: VehicleOpts): Vehicle {
    return new Vehicle(opts);
  }

  /* ==================================================================== init */

  init(ctx: GameContext): void {
    this.busRef = ctx.bus;
    this.unsubContact = this.physics.onContact(this.handleContact, this.collisionT.minImpulse);
    this.model.setHeadlights(this.isNight(ctx.timeOfDay));
  }

  onQualityChange(tier: QualityTier): void {
    this.model.setQuality(tier);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubContact?.();
    this.unsubContact = null;
    this.physics.removeBody(this.body);
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this.model.dispose();
    this.nearMissSeen.clear();
    this.collisionLock.clear();
  }

  /* ============================================================= fixedUpdate */

  fixedUpdate(ctx: GameContext, dt: number): void {
    if (this.disposed || dt <= 0) return;

    this.readFrame();
    if (!this.frameIsFinite()) {
      this.hardRecover();
      return;
    }

    this.elapsed = ctx.elapsed;
    this.captureInput(ctx);

    if (this.respawnFreeze > 0) {
      this.respawnFreeze = Math.max(0, this.respawnFreeze - dt);
      this.throttleInput = 0;
      this.brakeInput = 0;
      this.handbrakeInput = 0;
      this.steerInput = 0;
      this.boostInput = false;
    }

    if (this.hardHitPending) {
      this.hardHitPending = false;
      this.drift.cancel();
    }

    /* 1. steering geometry -------------------------------------------------- */
    this.updateSteering(dt);

    /* 2. suspension: rays, springs, dampers, anti-roll ---------------------- */
    this.suspension.step(this.physics, this.body, this.frame, dt);
    const grounded = this.suspension.groundedCount;

    /* 3. drift state machine — produces the grip multipliers ---------------- */
    this.drift.step(
      dt,
      this.frame,
      this.handbrakeInput,
      this.steerInput,
      this.throttleInput,
      grounded,
      ctx.bus,
    );
    const reward = this.drift.consumeReward();
    if (reward) {
      this.boost.grantMiniTurbo(reward.boostSeconds, reward.impulse, reward.meter);
    }

    /* 4. boost meter — resolved before the drivetrain so the speed ceiling,
     *    the limiter and the thrust all agree on the same step ------------- */
    this.boost.step(dt, this.boostInput, this.holdToBoost, this.frame.speed, ctx.bus);

    /* 5. engine, gearbox, drive + brake demand per wheel -------------------- */
    this.updateDrivetrain(dt, grounded);

    /* 6. tyres: the actual grip ------------------------------------------- */
    this.applyTyreForces(dt, grounded);

    /* 7. arcade yaw assist -------------------------------------------------- */
    this.applyYawAssist(dt, grounded);

    /* 8. aero ---------------------------------------------------------------*/
    this.applyAero(dt, grounded);

    /* 9. boost thrust -------------------------------------------------------*/
    this.applyBoostThrust(dt, grounded);

    /* 10. air control, tricks, landings -------------------------------------*/
    const landPoints = this.air.step(
      dt,
      this.frame,
      this.body,
      this.airPitchInput,
      this.airRollInput,
      grounded,
      ctx.bus,
    );
    if (landPoints > 0 && this.air.lastLandingClean) {
      /* `air.airtime` is already zeroed by the landing — use the recorded value */
      this.boost.add(
        this.boostT.gainCleanLandingPerSecond * Math.min(3, this.air.lastLandingAirtime),
      );
    }
    if (grounded === 0) {
      this.boost.add(this.boostT.gainAirtimePerSecond * dt);
    }

    /* 11. two-wheel stunt ---------------------------------------------------*/
    this.updateTwoWheels(dt, ctx.bus);

    /* 12. never let the player get stuck ------------------------------------*/
    this.updateRecovery(dt, ctx.bus);

    /* 13. publish -----------------------------------------------------------*/
    this.publishWheelData(dt, grounded);
  }

  /* =================================================================== update */

  update(ctx: GameContext, dt: number): void {
    if (this.disposed) return;

    this.elapsed = ctx.elapsed;
    this.captureInput(ctx);

    if (ctx.input && ctx.input.resetPressed) {
      this.respawn(this.safePos, this.safeHeading);
      ctx.bus.emit('ui:toast', { text: 'Recolocado', icon: 'reset', ms: 1200 });
    }

    this.updateHornAndAir(ctx, dt);
    this.updateNearMiss(dt, ctx.bus);
    this.suspension.updateVisual(dt);
    this.updateModel(ctx, dt);
    this.syncTransform();
  }

  /* ============================================================== public API */

  /** roster id of the vehicle being driven — save data and UI key off this */
  get vehicleId(): VehicleId {
    return this.definition.id;
  }

  /**
   * Hand the model a musical clock so any light show it has can pulse in time
   * with the score. Anything exposing a `beatPhase` getter works; the vehicle
   * module never imports the audio module.
   */
  setBeatSource(src: BeatSource | null): void {
    this.model.setBeatSource?.(src);
  }

  get position(): THREE.Vector3 {
    return this.frame.pos;
  }

  get quaternion(): THREE.Quaternion {
    return this.frame.quat;
  }

  get velocity(): THREE.Vector3 {
    return this.frame.linVel;
  }

  /** m/s, always >= 0 */
  get speed(): number {
    return this.frame.speed;
  }

  /** m/s along local -Z; negative when reversing */
  get forwardSpeed(): number {
    return this.frame.forwardSpeed;
  }

  get isDrifting(): boolean {
    return this.drift.active;
  }

  /**
   * Signed chassis slip angle in radians. Positive means the velocity vector
   * points to the right of the nose, i.e. the tail has swung right and the Jeep
   * is rotating to the left.
   */
  get driftAngle(): number {
    return this.frame.slipAngle;
  }

  get isAirborne(): boolean {
    return this.air.airborne;
  }

  get airtime(): number {
    return this.air.airtime;
  }

  get wheelsOnGround(): number {
    return this.suspension.groundedCount;
  }

  get boostFraction(): number {
    return this.boost.fraction;
  }

  get isBoosting(): boolean {
    return this.boost.isBoosting;
  }

  /** 0..1 between idle and redline, smoothed for engine audio */
  get engineRpmNorm(): number {
    return clamp01(
      (this.rpmSmoothed - this.engineT.idleRpm) / (this.engineT.redlineRpm - this.engineT.idleRpm),
    );
  }

  /** raw rpm, for a tachometer needle */
  get engineRpm(): number {
    return this.rpmSmoothed;
  }

  /** 1..5 forward, -1 reverse */
  get gear(): number {
    return this.reverseMode ? -1 : this.gearIndex + 1;
  }

  /** visual front-wheel angle in radians; positive = steering right */
  get steerAngle(): number {
    return this._steerAngle;
  }

  /** 4 values, 0 (drooped) .. 1 (bottomed out) */
  get suspensionCompression(): Float32Array {
    return this._compression;
  }

  /**
   * The four tyre contact patches in world space — this is what smoke, skid
   * marks and dust want. Ground positions, not hub positions.
   */
  get wheelWorldPositions(): THREE.Vector3[] {
    return this._wheelContacts;
  }

  /** The four wheel hub centres in world space, for wheel-mounted effects. */
  get wheelHubPositions(): THREE.Vector3[] {
    return this._wheelHubs;
  }

  /** 4 values, 0..1 combined lateral + longitudinal slip */
  get wheelSlip(): Float32Array {
    return this._slip;
  }

  /** radians; pitch positive = nose up, roll positive = right side down */
  get chassisTilt(): { pitch: number; roll: number } {
    return this._tilt;
  }

  /* --- extras the rest of the game finds useful --------------------------- */

  /** 0..1 boost visual intensity, for exhaust flames and camera FOV kick */
  get boostGlow(): number {
    return this.boost.glowLevel;
  }

  /** true while the drift payout is firing rather than the meter draining */
  get isMiniTurbo(): boolean {
    return this.boost.isMiniTurbo;
  }

  /** accumulated mini-turbo charge of the drift in progress */
  get driftCharge(): number {
    return this.drift.charge;
  }

  /** -1..2 mini-turbo tier the drift in progress has banked */
  get driftTier(): number {
    return this.drift.tier;
  }

  /** magnitude of the most recent significant impact, N·s */
  get lastImpactImpulse(): number {
    return this.elapsed - this.lastImpulseAt < 0.35 ? this.lastImpulse : 0;
  }

  /** normal load carried by each corner this step, newtons */
  wheelLoad(i: number): number {
    return this.suspension.wheels[i]?.load ?? 0;
  }

  /** Add boost meter, 0..1. Combos, near misses and score events call this. */
  addBoost(amount: number): void {
    this.boost.add(amount);
  }

  /** Place the Jeep upright at `pos`, facing `heading` (radians about +Y). */
  respawn(pos: THREE.Vector3, heading: number): void {
    if (this.disposed) return;

    this.tmpPoint.copy(pos);
    if (!Number.isFinite(this.tmpPoint.x)) this.tmpPoint.set(0, this.rideHeight, 0);
    this.tmpPoint.y += this.recoveryT.respawnHeight;

    const h = Number.isFinite(heading) ? heading : 0;
    this.tmpQuat.setFromAxisAngle(WORLD_UP, h);

    this.body.setPosition(this.tmpPoint);
    this.body.setQuaternion(this.tmpQuat);
    this.tmpVec.set(0, 0, 0);
    this.body.setLinearVelocity(this.tmpVec);
    this.body.setAngularVelocity(this.tmpVec);
    this.body.wake();

    this.suspension.reset();
    this.drift.cancel();
    this.air.reset();
    this.gearIndex = 0;
    this.reverseMode = false;
    this.reverseHold = 0;
    this.shiftTimer = 0;
    this.rpm = this.engineT.idleRpm;
    this.rpmSmoothed = this.engineT.idleRpm;
    this._steerAngle = 0;
    this.flipTimer = 0;
    this.twoWheelTimer = 0;
    this.twoWheelGrace = 0;
    this.respawnFreeze = this.recoveryT.respawnSettleTime;
    this.visualPitch = 0;
    this.visualRoll = 0;
    this.visualHeave = 0;

    this.safePos.copy(pos);
    this.safeHeading = h;

    this.readFrame();
    this.syncTransform();

    this.busRef?.emit('vehicle:reset', {});
  }

  /** Show or hide the passenger in the rear bed. */
  setSeatVisual(occupied: boolean, archetypeId?: string): void {
    this.model.setSeatOccupied(occupied, archetypeId);
  }

  /* ============================================================ frame reading */

  private readFrame(): void {
    const f = this.frame;
    this.body.getPosition(f.pos);
    this.body.getQuaternion(f.quat);
    this.body.getLinearVelocity(f.linVel);
    this.body.getAngularVelocity(f.angVel);

    f.forward.set(0, 0, -1).applyQuaternion(f.quat);
    f.right.set(1, 0, 0).applyQuaternion(f.quat);
    f.up.set(0, 1, 0).applyQuaternion(f.quat);

    f.com
      .set(this.chassisT.comLocalX, this.chassisT.comLocalY, this.chassisT.comLocalZ)
      .applyQuaternion(f.quat)
      .add(f.pos);

    f.speed = f.linVel.length();
    f.forwardSpeed = f.linVel.dot(f.forward);
    f.lateralSpeed = f.linVel.dot(f.right);
    f.verticalSpeed = f.linVel.dot(f.up);

    /* slip angle is meaningless when parked — gate it so it never jitters */
    f.slipAngle =
      f.speed > 1.2 ? Math.atan2(f.lateralSpeed, Math.abs(f.forwardSpeed) + 0.35) : 0;

    f.yawRate = f.angVel.dot(f.up);
    f.pitchRate = f.angVel.dot(f.right);
    f.rollRate = f.angVel.dot(f.forward);

    f.upDot = f.up.y;
    f.pitch = Math.asin(clamp(f.forward.y, -1, 1));
    f.roll = Math.atan2(-f.right.y, f.up.y);

    this._tilt.pitch = f.pitch;
    this._tilt.roll = f.roll;
  }

  private frameIsFinite(): boolean {
    const f = this.frame;
    return (
      Number.isFinite(f.pos.x) &&
      Number.isFinite(f.pos.y) &&
      Number.isFinite(f.pos.z) &&
      Number.isFinite(f.linVel.x) &&
      Number.isFinite(f.linVel.y) &&
      Number.isFinite(f.linVel.z) &&
      Number.isFinite(f.quat.w)
    );
  }

  /** Last-resort NaN escape hatch — put the Jeep back on the last safe road. */
  private hardRecover(): void {
    this.body.setQuaternion(this.tmpQuat.setFromAxisAngle(WORLD_UP, this.safeHeading));
    this.respawn(this.safePos, this.safeHeading);
  }

  private captureInput(ctx: GameContext): void {
    const input = ctx.input;
    const settings: SettingsState | undefined = ctx.settings;
    if (!input) return;
    this.throttleInput = clamp01(input.throttle);
    this.brakeInput = clamp01(input.brake);
    this.steerInput = clamp(input.steer, -1, 1);
    this.handbrakeInput = clamp01(input.handbrake);
    this.boostInput = input.boost === true;
    this.airPitchInput = clamp(input.airPitch, -1, 1);
    this.airRollInput = clamp(input.airRoll, -1, 1);
    if (settings) {
      this.assistSteering = clamp01(settings.assistSteering);
      this.holdToBoost = settings.holdToBoost !== false;
      if (settings.autoAccelerate && this.brakeInput < 0.05) {
        this.throttleInput = Math.max(this.throttleInput, 1);
      }
    }
  }

  /* ================================================================ steering */

  private updateSteering(dt: number): void {
    const f = this.frame;

    /* speed-sensitive lock: wide at walking pace, tight at 100 mph */
    const t = Math.pow(
      clamp01(f.speed / this.steerT.speedForMinAngle),
      this.steerT.speedCurvePower,
    );
    const maxAngle = lerp(this.steerT.maxAngleLow, this.steerT.maxAngleHigh, t) + this.drift.steerBonus;

    let target = this.steerInput * maxAngle;

    /* counter-steer assist: quietly dial in the correction the player should be
     * making. Positive slip angle = tail out to the right = steer right. */
    if (
      this.assistSteering > 0 &&
      f.speed > this.steerT.counterSteerMinSpeed &&
      Math.abs(f.slipAngle) > this.steerT.counterSteerMinSlip &&
      f.forwardSpeed > 0
    ) {
      const correction =
        f.slipAngle * this.steerT.counterSteerGain * this.assistSteering;
      target = clamp(target + correction, -maxAngle, maxAngle);
    }

    const towardCentre = Math.abs(target) < Math.abs(this._steerAngle);
    const speedFrac = clamp01(f.speed / this.steerT.speedForMinAngle);
    const rate = towardCentre
      ? this.steerT.rateToCentre + this.steerT.returnRateBonus * speedFrac
      : this.steerT.rateAwayFromCentre;

    this._steerAngle = moveTowards(this._steerAngle, target, rate * dt);
  }

  /* ============================================================== drivetrain */

  private updateDrivetrain(dt: number, grounded: number): void {
    const f = this.frame;
    const fwd = f.forwardSpeed;

    /* --- reverse latch: hold the brake at a standstill and it flips --- */
    if (!this.reverseMode) {
      if (this.brakeInput > 0.25 && fwd < this.brakeT.reverseThreshold) {
        this.reverseHold += dt;
        if (this.reverseHold >= this.brakeT.reverseDelay) {
          this.reverseMode = true;
          this.reverseHold = 0;
        }
      } else {
        this.reverseHold = 0;
      }
    } else if (this.throttleInput > 0.1 && fwd > -this.brakeT.reverseThreshold) {
      this.reverseMode = false;
      this.reverseHold = 0;
      this.gearIndex = 0;
    }

    /* --- rpm from road speed through the current ratio --- */
    const wheelOmega = Math.abs(fwd) / this.suspT.wheelRadius;
    const ratio = this.reverseMode ? this.engineT.reverseRatio : this.engineT.gearRatios[this.gearIndex];
    const rawRpm = (wheelOmega * ratio * this.engineT.finalDrive * 60) / (Math.PI * 2);

    /* an unloaded engine still revs with the throttle — flare on gearchanges */
    const demand = this.reverseMode ? this.brakeInput : this.throttleInput;
    const flare = grounded === 0 ? demand * this.engineT.redlineRpm * 0.75 : 0;
    this.rpm = clamp(Math.max(rawRpm, flare), this.engineT.idleRpm, this.engineT.redlineRpm);

    /* --- automatic gearbox --- */
    if (this.shiftTimer > 0) {
      this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    } else if (!this.reverseMode) {
      if (this.rpm >= this.engineT.shiftUpRpm && this.gearIndex < this.engineT.gearRatios.length - 1) {
        this.gearIndex++;
        this.shiftTimer = this.engineT.shiftTimeSec;
      } else if (this.rpm <= this.engineT.shiftDownRpm && this.gearIndex > 0) {
        this.gearIndex--;
        this.shiftTimer = this.engineT.shiftTimeSec * 0.5;
      }
    }

    this.rpmSmoothed = damp(this.rpmSmoothed, this.rpm, this.engineT.rpmSmoothRate, dt);

    /* --- torque -> tractive force at the contact patch --- */
    const activeRatio = this.reverseMode
      ? this.engineT.reverseRatio
      : this.engineT.gearRatios[this.gearIndex];
    const torque = this.shiftTimer > 0 ? 0 : this.torqueAt(this.rpm);
    let tractive =
      (torque * activeRatio * this.engineT.finalDrive * this.engineT.efficiency) / this.suspT.wheelRadius;

    tractive *= demand;
    if (this.reverseMode) tractive = -tractive;

    /* --- soft speed limiter: ease into the top speed, never slam into it --- */
    const cap = this.reverseMode
      ? this.speedT.topSpeedReverse
      : lerp(this.speedT.topSpeed, this.speedT.topSpeedBoost, this.boost.thrustEnvelope);
    const signedSpeed = this.reverseMode ? -fwd : fwd;
    const headroom = smoothstep((cap - signedSpeed) / this.speedT.limiterBand);
    this.speedHeadroom = headroom;
    tractive *= headroom;

    /* --- engine braking when coasting --- */
    let engineBrake = 0;
    if (demand < 0.05 && this.brakeInput < 0.05 && Math.abs(fwd) > 0.15) {
      engineBrake =
        (this.engineT.engineBrakeBase + this.engineT.engineBrakeCoeff * Math.abs(fwd)) * -Math.sign(fwd);
    }

    /* --- distribute drive + brake to the four wheels --- */
    const rearShare = this.engineT.driveBiasRear * 0.5;
    const frontShare = (1 - this.engineT.driveBiasRear) * 0.5;
    const total = tractive + engineBrake;
    this.wheelDrive[0] = total * frontShare;
    this.wheelDrive[1] = total * frontShare;
    this.wheelDrive[2] = total * rearShare;
    this.wheelDrive[3] = total * rearShare;

    const braking = this.reverseMode ? this.throttleInput : this.brakeInput;
    const brakeFront = braking * this.brakeT.maxForce * this.brakeT.frontBias * 0.5;
    const brakeRear = braking * this.brakeT.maxForce * (1 - this.brakeT.frontBias) * 0.5;
    const hb = this.handbrakeInput * this.brakeT.handbrakeForce;
    this.wheelBrake[0] = brakeFront;
    this.wheelBrake[1] = brakeFront;
    this.wheelBrake[2] = brakeRear + hb;
    this.wheelBrake[3] = brakeRear + hb;
  }

  /** Linear interpolation through the torque curve, indexed by rpm fraction. */
  private torqueAt(rpm: number): number {
    const curve = this.engineT.torqueCurve;
    const t = clamp01(rpm / this.engineT.redlineRpm) * (curve.length - 1);
    const i = Math.min(curve.length - 2, Math.floor(t));
    return lerp(curve[i], curve[i + 1], t - i);
  }

  /* ==================================================================== tyres */

  private applyTyreForces(dt: number, grounded: number): void {
    if (grounded === 0) {
      /* wheels freewheel in the air; the throttle still spins them up */
      for (let i = 0; i < 4; i++) {
        const w = this.suspension.wheels[i];
        const target = this.throttleInput > 0.1 ? 90 * this.throttleInput : 0;
        w.spinRate = damp(w.spinRate, target, 1.6, dt);
        w.slipLat = 0;
        w.slipLong = 0;
        w.slip = 0;
      }
      return;
    }

    const f = this.frame;
    const massShare = this.chassisT.mass / grounded;
    const invDt = 1 / dt;

    for (let i = 0; i < 4; i++) {
      const w = this.suspension.wheels[i];
      if (!w.grounded) {
        const target = this.throttleInput > 0.1 ? 90 * this.throttleInput : 0;
        w.spinRate = damp(w.spinRate, target, 1.6, dt);
        w.slipLat = 0;
        w.slipLong = 0;
        w.slip = 0;
        continue;
      }

      /* --- wheel basis projected onto the contact plane --- */
      w.steer = w.isFront ? this._steerAngle : 0;
      const dir = this.tmpDir.copy(f.forward);
      if (w.steer !== 0) dir.applyAxisAngle(f.up, -w.steer);
      dir.addScaledVector(w.contactNormal, -dir.dot(w.contactNormal));
      const dirLen = dir.length();
      if (dirLen < 1e-4) continue;
      dir.multiplyScalar(1 / dirLen);

      const right = this.tmpRight.copy(dir).cross(w.contactNormal);
      const rightLen = right.length();
      if (rightLen < 1e-4) continue;
      right.multiplyScalar(1 / rightLen);

      w.forwardDir.copy(dir);
      w.rightDir.copy(right);

      const vLong = w.contactVel.dot(dir);
      const vLat = w.contactVel.dot(right);

      /* --- load, with a little load sensitivity so weight transfer matters --- */
      const load = clamp(w.load, this.tyreT.minLoad, this.tyreT.maxLoad);
      const muScale = clamp(
        1 - this.tyreT.loadSensitivity * (load / this.tyreT.loadReference - 1),
        0.55,
        1.4,
      );

      /* --- lateral: slip-angle curve with a defined peak and a held plateau -- */
      const slipAngle = Math.atan2(vLat, Math.abs(vLong) + 0.6);
      const gripShape = slipCurve(Math.abs(slipAngle), this.tyreT);
      const gripMul = w.isFront ? this.drift.frontGripMul : this.drift.rearGripMul;
      const baseMu = w.isFront ? this.tyreT.latGripFront : this.tyreT.latGripRear;
      const maxLat = baseMu * gripShape * muScale * gripMul * load;

      /* the force that would kill the slide outright, under-relaxed for stability */
      const wantLat = -vLat * massShare * invDt * this.tyreT.latRecoveryFraction;
      const fLat =
        Math.abs(vLat) < this.tyreT.latDeadband ? 0 : clamp(wantLat, -maxLat, maxLat);

      /* --- longitudinal, sharing the friction budget with the lateral force -- */
      const maxLong = this.tyreT.longGrip * muScale * load;
      const latUse = maxLat > 1 ? Math.abs(fLat) / maxLat : 0;
      const longBudget =
        maxLong * Math.sqrt(Math.max(0, 1 - this.tyreT.combinedSlip * latUse * latUse));

      let wantLong = this.wheelDrive[i];
      const rollDrag = this.speedT.rollingResistance * Math.sign(vLong);
      wantLong -= rollDrag;
      if (this.wheelBrake[i] > 0) {
        /* brakes can only ever oppose motion, never drive it */
        const stopping = -Math.sign(vLong) * this.wheelBrake[i];
        const maxStop = Math.abs(vLong) * massShare * invDt;
        wantLong += Math.abs(stopping) > maxStop ? -Math.sign(vLong) * maxStop : stopping;
      }
      const fLong = clamp(wantLong, -longBudget, longBudget);

      /* --- apply --- */
      this.tmpForce.copy(dir).multiplyScalar(fLong * dt);
      this.body.applyImpulse(this.tmpForce, w.contactPoint);

      /* lateral goes in slightly above the patch: raising the roll centre is the
       * cheapest rollover fix there is, and the springs still do the leaning */
      this.tmpPoint
        .copy(w.contactNormal)
        .multiplyScalar(this.tyreT.lateralForceHeight)
        .add(w.contactPoint);
      this.tmpForce.copy(right).multiplyScalar(fLat * dt);
      this.body.applyImpulse(this.tmpForce, this.tmpPoint);

      /* --- slip readouts for smoke, skids and audio --- */
      const killed = (fLat * dt) / massShare;
      w.slipLat = vLat + killed;

      const overDemand = Math.abs(wantLong) - longBudget;
      let slipLong = 0;
      if (overDemand > 0) {
        slipLong =
          clamp((overDemand / Math.max(1, maxLong)) * this.tyreT.slipSpeedGain, 0, 24) *
          Math.sign(wantLong);
      }
      w.slipLong = slipLong;

      let spin = (vLong + slipLong) / this.suspT.wheelRadius;
      if (this.wheelBrake[i] > 0 && slipLong * vLong < 0) {
        const surface = vLong / this.suspT.wheelRadius;
        spin = clamp(spin, Math.min(0, surface), Math.max(0, surface));
      }
      w.spinRate = spin;

      w.slip = clamp01(Math.hypot(w.slipLat, slipLong) / this.tyreT.slipNormalise);
    }
  }

  /* =============================================================== yaw assist */

  private applyYawAssist(dt: number, grounded: number): void {
    if (grounded === 0) return;
    const f = this.frame;

    const authority =
      clamp01((f.speed - this.steerT.yawAssistMinSpeed) / this.steerT.yawAssistRampBand) *
      (grounded / 4);
    if (authority <= 0) return;

    /* bicycle model: turning right (positive steer) is negative yaw about +Y */
    const wheelbase = this.suspT.halfWheelbase * 2;
    let target = (-Math.tan(this._steerAngle) * f.forwardSpeed) / wheelbase;
    target *= this.drift.yawGain;
    target = clamp(target, -this.steerT.maxYawRate, this.steerT.maxYawRate);

    const err = target - f.yawRate;
    const accel = clamp(
      err * this.steerT.yawAssistRate,
      -this.steerT.yawAssistMaxAccel,
      this.steerT.yawAssistMaxAccel,
    ) * authority;

    this.tmpForce.copy(f.up).multiplyScalar(accel * this.chassisT.inertiaYaw * dt);
    this.body.applyTorqueImpulse(this.tmpForce);
  }

  /* ===================================================================== aero */

  private applyAero(dt: number, grounded: number): void {
    const f = this.frame;
    const v2 = f.speed * f.speed;
    if (v2 > 1e-4) {
      const c = grounded > 0 ? this.speedT.dragCoeff : this.speedT.dragCoeffAir;
      this.tmpForce
        .copy(f.linVel)
        .multiplyScalar((-c * v2 * dt) / Math.max(1e-4, f.speed));
      this.body.applyImpulse(this.tmpForce);
    }

    if (grounded > 0 && f.upDot > 0.2) {
      const df = Math.min(this.speedT.downforceCoeff * v2, this.speedT.downforceMax);
      if (df > 1) {
        this.tmpForce.copy(f.up).multiplyScalar(-df * dt);
        this.body.applyImpulse(this.tmpForce);
      }
    }
  }

  /* ==================================================================== boost */

  private applyBoostThrust(dt: number, grounded: number): void {
    /* Boost obeys the same soft limiter as the engine. Without that, a constant
     * 21 kN of thrust simply integrates against quadratic drag and the Jeep ends
     * up at four hundred miles an hour. */
    const headroom = this.speedHeadroom;

    const impulse = this.boost.consumeImpulse();
    if (impulse > 0) {
      this.tmpForce.copy(this.frame.forward).multiplyScalar(impulse * headroom);
      this.body.applyImpulse(this.tmpForce);
    }

    const env = this.boost.thrustEnvelope;
    if (env <= 0) return;
    const scale = grounded === 0 ? this.boostT.thrustAirScale : 1;
    this.tmpForce
      .copy(this.frame.forward)
      .multiplyScalar(this.boostT.thrust * env * scale * headroom * dt);
    this.body.applyImpulse(this.tmpForce);
  }

  /* =============================================================== two wheels */

  private updateTwoWheels(dt: number, bus: EventBus): void {
    const side = this.suspension.twoWheelSide();
    const f = this.frame;
    const qualifies =
      side !== 0 &&
      Math.abs(f.roll) > this.twoWheelsT.minRoll &&
      f.speed > this.twoWheelsT.minSpeed &&
      f.upDot > 0.15;

    if (qualifies) {
      this.twoWheelTimer += dt;
      this.twoWheelGrace = this.twoWheelsT.graceTime;
    } else if (this.twoWheelTimer > 0) {
      this.twoWheelGrace -= dt;
      if (this.twoWheelGrace <= 0) {
        if (this.twoWheelTimer >= this.twoWheelsT.minDuration) {
          bus.emit('vehicle:twoWheels', { duration: this.twoWheelTimer });
        }
        this.twoWheelTimer = 0;
      }
    }
  }

  /* ========================================================= anti-frustration */

  private updateRecovery(dt: number, bus: EventBus): void {
    const f = this.frame;

    /* kill plane — fell out of the world */
    if (f.pos.y < CONFIG.killPlaneY) {
      this.respawn(this.safePos, this.safeHeading);
      return;
    }

    /* on its roof or wedged on its side and going nowhere */
    const flipped = f.upDot < this.recoveryT.flippedDot;
    if (flipped && f.speed < this.recoveryT.stuckSpeed) {
      this.flipTimer += dt;
      if (this.flipTimer >= this.recoveryT.flippedTime) {
        this.flipTimer = 0;
        this.autoRight(bus);
        return;
      }
    } else {
      this.flipTimer = 0;
    }

    /* remember somewhere sensible to come back to */
    this.safePointTimer += dt;
    if (this.safePointTimer >= this.recoveryT.safePointInterval) {
      this.safePointTimer = 0;
      if (
        this.suspension.groundedCount >= this.recoveryT.safePointWheels &&
        f.speed >= this.recoveryT.safePointMinSpeed &&
        f.upDot > 0.75
      ) {
        this.safePos.copy(f.pos);
        this.safeHeading = Math.atan2(-f.forward.x, -f.forward.z);
      }
    }
  }

  /**
   * Flip the Jeep back over in place, keeping its heading. Cheaper and less
   * disorienting than a full respawn — you land where you crashed.
   */
  private autoRight(bus: EventBus): void {
    const f = this.frame;
    const heading = Math.atan2(-f.forward.x, -f.forward.z);
    this.tmpPoint.copy(f.pos);
    this.tmpPoint.y += this.recoveryT.rightingLift;
    this.tmpQuat.setFromAxisAngle(WORLD_UP, heading);

    this.body.setPosition(this.tmpPoint);
    this.body.setQuaternion(this.tmpQuat);
    this.tmpVec.set(0, 0, 0);
    this.body.setAngularVelocity(this.tmpVec);
    this.tmpVec.copy(f.linVel).multiplyScalar(0.25);
    this.tmpVec.y = 0;
    this.body.setLinearVelocity(this.tmpVec);
    this.body.wake();

    this.suspension.reset();
    this.drift.cancel();
    this.air.reset();
    this.respawnFreeze = this.recoveryT.respawnSettleTime;

    this.readFrame();
    bus.emit('vehicle:reset', {});
  }

  /* ========================================================= horn + air brakes */

  /**
   * The two noises a vehicle makes that are not the engine.
   *
   * The horn is a straight edge-triggered honk, pitched by the tuning record —
   * the same dual-tone reeds dropped two octaves become a freight-train air
   * horn on the bus.
   *
   * The air brakes model a reservoir: holding the pedal at speed charges it,
   * and letting go — or finally coming to a stop at a chinchorro — bleeds it
   * off with a hiss. `boostLoop` is the library's filtered-noise burst, which
   * is the closest thing it has to a psshht; the pitch and volume come from
   * the tuning record so a dedicated hiss can be swapped in later without
   * touching this file.
   */
  private updateHornAndAir(ctx: GameContext, dt: number): void {
    const bus = ctx.bus;

    const hornDown = ctx.input?.horn === true;
    if (
      hornDown &&
      !this.hornWasDown &&
      this.elapsed - this.lastHornAt >= this.tuning.horn.cooldown
    ) {
      this.lastHornAt = this.elapsed;
      bus.emit('audio:sfx', {
        id: 'horn',
        at: this.frame.pos,
        volume: this.tuning.horn.volume,
        pitch: this.tuning.horn.pitch,
      });
      this.model.pulseHorn?.();
    }
    this.hornWasDown = hornDown;

    const ab = this.tuning.airBrake;
    if (!ab.enabled) return;

    const braking =
      this.brakeInput >= ab.brakeThreshold || this.handbrakeInput >= ab.brakeThreshold;
    if (braking && this.frame.speed > ab.stopSpeed) {
      this.airBrakeCharge = Math.min(1.4, this.airBrakeCharge + dt);
      return;
    }

    if (
      this.airBrakeCharge >= ab.chargeToFire &&
      this.elapsed - this.lastHissAt >= ab.cooldown
    ) {
      const strength = clamp01(this.airBrakeCharge / 1.2);
      this.lastHissAt = this.elapsed;
      this.airBrakeCharge = 0;
      bus.emit('audio:sfx', {
        id: 'boostLoop',
        at: this.frame.pos,
        volume: ab.volume * (0.6 + strength * 0.4),
        pitch: ab.pitch,
      });
      this.model.pulseAirBrake?.(strength);
    } else {
      this.airBrakeCharge = Math.max(0, this.airBrakeCharge - dt * ab.decayRate);
    }
  }

  /* ============================================================== near misses */

  private updateNearMiss(dt: number, bus: EventBus): void {
    this.nearMissTimer += dt;
    if (this.nearMissTimer < this.nearMissT.interval) return;
    this.nearMissTimer = 0;

    if (this.frame.speed < this.nearMissT.minSpeed) return;

    /* keep the bookkeeping maps from growing without bound */
    if (this.nearMissSeen.size > 64) this.nearMissSeen.clear();
    if (this.collisionLock.size > 64) this.collisionLock.clear();

    const found = this.physics.overlapSphere(
      this.frame.pos,
      this.nearMissT.radius,
      NEAR_MISS_MASK,
    );
    if (found.length === 0) return;

    const now = this.elapsed;
    for (let i = 0; i < found.length; i++) {
      const other = found[i];
      if (other.id === this.body.id) continue;

      const lastHit = this.collisionLock.get(other.id);
      if (lastHit !== undefined && now - lastHit < this.nearMissT.collisionLockout) continue;

      const lastSeen = this.nearMissSeen.get(other.id);
      if (lastSeen !== undefined && now - lastSeen < this.nearMissT.cooldown) continue;

      this.nearMissSeen.set(other.id, now);

      const at = this.nearMissPool[this.nearMissCursor];
      this.nearMissCursor = (this.nearMissCursor + 1) % this.nearMissPool.length;
      other.getPosition(at);

      this.boost.add(this.boostT.gainNearMiss);
      this.reactive.reactToNearMiss?.(
        this.frame.speed,
        this.tmpVec.copy(at).sub(this.frame.pos).dot(this.frame.right) >= 0 ? 1 : -1,
      );
      bus.emit('vehicle:nearMiss', { speed: this.frame.speed, at });
    }
  }

  /* ================================================================ collisions */

  private handleContact = (e: ContactEvent): void => {
    if (this.disposed) return;
    const aMine = e.a.id === this.body.id;
    const bMine = e.b.id === this.body.id;
    if (!aMine && !bMine) return;

    const other = aMine ? e.b : e.a;
    this.collisionLock.set(other.id, this.elapsed);

    if (this.elapsed - this.lastCollisionAt < this.collisionT.cooldown) return;
    this.lastCollisionAt = this.elapsed;
    this.lastImpulse = e.impulse;
    this.lastImpulseAt = this.elapsed;

    if (e.impulse >= this.collisionT.heavyImpulse) this.hardHitPending = true;

    /* which side did it come from? Models that care (the carriage's horse)
     * shy away from it rather than into it. */
    this.reactive.reactToImpact?.(
      e.impulse,
      this.tmpVec.copy(e.point).sub(this.frame.pos).dot(this.frame.right) >= 0 ? 1 : -1,
    );

    this.busRef?.emit('vehicle:collision', {
      impulse: e.impulse,
      kind: classifyBody(other),
    });
  };

  /* ============================================================ publish + mesh */

  private publishWheelData(dt: number, grounded: number): void {
    for (let i = 0; i < 4; i++) {
      const w = this.suspension.wheels[i];
      this._compression[i] = w.compression;
      this._slip[i] = w.slip;
      this._wheelContacts[i].copy(w.contactPoint);
      this._wheelHubs[i].copy(w.centerWorld);
      w.spinAngle += w.spinRate * dt;
      if (w.spinAngle > 1e6 || w.spinAngle < -1e6) w.spinAngle = 0;
    }
  }

  private syncTransform(): void {
    this.object3d.position.copy(this.frame.pos);
    this.object3d.quaternion.copy(this.frame.quat);
  }

  private updateModel(ctx: GameContext, dt: number): void {
    const s = this.suspension;

    /* a vehicle with a strobing light show has to respect the accessibility
     * setting; pushed only on change so it costs nothing per frame */
    const showScale = ctx.settings?.photosensitiveSafe ? 0.22 : 1;
    if (showScale !== this.lightShowScale) {
      this.lightShowScale = showScale;
      this.model.setLightShowIntensity?.(showScale);
    }

    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      this.model.setSuspension(i, w.visualCompression);
      this.model.setWheelSpin(i, w.spinAngle);
    }
    this.model.setSteer(this._steerAngle);

    /* cosmetic lean on top of the body's real motion — the arcade squash */
    const frontC = s.axleCompression(true);
    const rearC = s.axleCompression(false);
    const leftC = s.sideCompression(true);
    const rightC = s.sideCompression(false);

    const pitchTarget = clamp(
      (rearC - frontC) * this.modelT.bodyPitchGain,
      -this.modelT.bodyLeanMax,
      this.modelT.bodyLeanMax,
    );
    const rollTarget = clamp(
      (rightC - leftC) * this.modelT.bodyRollGain,
      -this.modelT.bodyLeanMax,
      this.modelT.bodyLeanMax,
    );
    const heaveTarget =
      -((frontC + rearC) * 0.5 - this.restCompression) * this.modelT.bodyBounceGain;

    this.visualPitch = damp(this.visualPitch, pitchTarget, this.modelT.bodyLeanRate, dt);
    this.visualRoll = damp(this.visualRoll, rollTarget, this.modelT.bodyLeanRate, dt);
    this.visualHeave = damp(this.visualHeave, heaveTarget, this.modelT.bodyLeanRate, dt);
    this.model.setChassisLean(this.visualPitch, this.visualRoll, this.visualHeave);

    const braking =
      this.brakeInput > 0.05 || this.handbrakeInput > 0.05 || this.reverseMode;
    if (braking !== this.brakeLightsOn) {
      this.brakeLightsOn = braking;
      this.model.setBrakeLights(braking);
    }

    const night = this.isNight(ctx.timeOfDay);
    if (night !== this.headlightsOn) {
      this.headlightsOn = night;
      this.model.setHeadlights(night);
    }

    this.model.setBoostGlow(this.boost.glowLevel);
    this.model.tick(dt, this.frame.speed);
  }

  private isNight(hours: number): boolean {
    return hours < this.modelT.headlightOnBefore || hours > this.modelT.headlightOnAfter;
  }
}

/* ========================================================== free functions */

/**
 * Tyre lateral grip as a function of slip angle. Linear rise to a defined peak,
 * then a controlled fall to a plateau. The plateau is the whole point: past the
 * peak the rear stays predictable instead of snapping, so a drift can be held.
 */
function slipCurve(slip: number, tyre: TyreTuning): number {
  if (slip <= tyre.peakSlip) return slip / tyre.peakSlip;
  if (slip >= tyre.tailSlip) return tyre.tailGrip;
  const t = (slip - tyre.peakSlip) / (tyre.tailSlip - tyre.peakSlip);
  return lerp(1, tyre.tailGrip, smoothstep(t));
}

const KIND_SET: readonly CollisionKind[] = ['traffic', 'prop', 'wall', 'ped'];

function asKind(v: unknown): CollisionKind | null {
  if (typeof v !== 'string') return null;
  for (let i = 0; i < KIND_SET.length; i++) {
    if (KIND_SET[i] === v) return KIND_SET[i];
  }
  if (v === 'building' || v === 'ground' || v === 'terrain' || v === 'road') return 'wall';
  if (v === 'pedestrian') return 'ped';
  if (v === 'car' || v === 'vehicle' || v === 'bus' || v === 'truck') return 'traffic';
  return null;
}

/**
 * Work out what we just hit from whatever the other module tagged its body
 * with. Every producer labels things differently, so probe the common shapes
 * and fall back on the body kind: a static body is scenery, anything else is a
 * prop we can knock over.
 */
function classifyBody(other: BodyHandle): CollisionKind {
  const ud = other.userData;

  const direct = asKind(ud);
  if (direct) return direct;

  if (ud !== null && typeof ud === 'object') {
    const rec = ud as Record<string, unknown>;
    const byKind = asKind(rec.kind) ?? asKind(rec.type) ?? asKind(rec.tag) ?? asKind(rec.category);
    if (byKind) return byKind;

    const g = rec.group;
    if (typeof g === 'number') {
      if (g & GROUP.TRAFFIC) return 'traffic';
      if (g & GROUP.PED) return 'ped';
      if (g & GROUP.PROP) return 'prop';
      if (g & GROUP.WORLD) return 'wall';
    }
  }

  return other.kind === 'static' ? 'wall' : 'prop';
}

export { STATIC_RIDE_HEIGHT, STATIC_COMPRESSION };
