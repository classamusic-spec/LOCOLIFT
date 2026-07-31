/**
 * Loco Lift — the drift.
 *
 * The signature mechanic. A drift is a *state*, not an emergent accident: the
 * player arms it with the handbrake (or by throwing the Jeep hard at speed), the
 * rear tyres lose a defined fraction of their grip, the yaw assist starts
 * rotating the chassis into the corner, and charge accumulates the longer and
 * wider the slide is held. Letting go pays out a Mario-Kart-style mini-turbo
 * scaled by how committed the slide was.
 *
 * This class owns no physics. It reads the chassis state and publishes grip
 * multipliers and a yaw-assist gain that Vehicle applies to the tyre model.
 * That separation is deliberate: drift feel is tuned by changing what this
 * object outputs, never by special-casing the tyre code.
 */
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01, damp, lerp } from '../core/MathUtils';
import { DRIFT, STEER } from './VehicleTuning';
import type { VehicleFrame } from './Suspension';

/** Payout handed to BoostSystem when a drift ends with enough charge. */
export interface DriftReward {
  /** 0,1,2 — mini-turbo tier. -1 means no payout. */
  tier: number;
  /** seconds of automatic boost granted */
  boostSeconds: number;
  /** instant forward impulse, N·s */
  impulse: number;
  /** boost meter refilled, 0..1 */
  meter: number;
}

export class DriftModel {
  /** true while the drift state machine is armed */
  active = false;
  /** seconds the current drift has run */
  duration = 0;
  /** integral of |slip angle| over the drift, rad·s — the "how sideways" score */
  angleIntegral = 0;
  /** accumulated mini-turbo charge */
  charge = 0;
  /** which mini-turbo tier the current charge has reached, -1..2 */
  tier = -1;
  /** -1 = sliding one way, +1 the other, 0 = straight. Follows the slip sign. */
  slipSign = 0;

  /* --- outputs consumed by the tyre model, all smoothed --- */
  frontGripMul = 1;
  rearGripMul = 1;
  /** multiplier on the assist's target yaw rate */
  yawGain = 1;
  /** extra front steering lock available, radians */
  steerBonus = 0;

  /** true only on the step the drift ended, so Vehicle can react once */
  private rewardPending = false;
  private readonly reward: DriftReward = { tier: -1, boostSeconds: 0, impulse: 0, meter: 0 };

  private belowExitFor = 0;
  private airtimeInDrift = 0;
  /** blocks an instant re-entry on the same handbrake press */
  private reentryLock = 0;

  /** Hard reset — respawn, kill plane, mode change. */
  reset(): void {
    this.active = false;
    this.duration = 0;
    this.angleIntegral = 0;
    this.charge = 0;
    this.tier = -1;
    this.slipSign = 0;
    this.frontGripMul = 1;
    this.rearGripMul = 1;
    this.yawGain = 1;
    this.steerBonus = 0;
    this.rewardPending = false;
    this.reward.tier = -1;
    this.belowExitFor = 0;
    this.airtimeInDrift = 0;
    this.reentryLock = 0;
  }

  /**
   * Advance the drift state machine.
   *
   * @param handbrake 0..1 raw handbrake input
   * @param steerInput -1..1 raw steering input
   * @param throttle 0..1
   * @param groundedCount 0..4
   */
  step(
    dt: number,
    frame: VehicleFrame,
    handbrake: number,
    steerInput: number,
    throttle: number,
    groundedCount: number,
    bus: EventBus,
  ): void {
    const slip = Math.abs(frame.slipAngle);
    const speed = frame.speed;
    const airborne = groundedCount === 0;

    if (this.reentryLock > 0) this.reentryLock = Math.max(0, this.reentryLock - dt);

    if (this.active) {
      this.duration += dt;
      this.angleIntegral += slip * dt;
      this.charge +=
        dt * DRIFT.chargePerSecond * clamp(slip / DRIFT.chargeSlipReference, 0, 1.6);
      this.slipSign = Math.sign(frame.slipAngle);

      const newTier = this.tierForCharge(this.charge);
      if (newTier > this.tier) this.tier = newTier;

      this.airtimeInDrift = airborne ? this.airtimeInDrift + dt : 0;

      if (slip < DRIFT.exitSlip) this.belowExitFor += dt;
      else this.belowExitFor = 0;

      const spunOut = slip > DRIFT.spinOutSlip;
      const tooSlow = speed < DRIFT.minSpeed * 0.7;
      const settled = this.belowExitFor >= DRIFT.exitHold && handbrake < DRIFT.handbrakeThreshold;
      const flew = this.airtimeInDrift > DRIFT.exitAirtime;

      if (spunOut || tooSlow || settled || flew) {
        this.end(bus);
      }
    } else if (
      !airborne &&
      speed >= DRIFT.minSpeed &&
      this.reentryLock <= 0 &&
      (handbrake >= DRIFT.handbrakeThreshold ||
        (slip >= DRIFT.entrySlip && Math.abs(steerInput) >= DRIFT.entrySteer))
    ) {
      this.active = true;
      this.duration = 0;
      this.angleIntegral = 0;
      this.charge = 0;
      this.tier = -1;
      this.belowExitFor = 0;
      this.airtimeInDrift = 0;
      this.slipSign = Math.sign(frame.slipAngle) || Math.sign(steerInput);
      bus.emit('vehicle:driftStart', { speed });
    }

    /* ---- grip and assist targets ---- */
    let targetRear = 1;
    let targetFront = 1;
    let targetYaw = 1;
    let targetSteerBonus = 0;

    const handbraking = handbrake >= DRIFT.handbrakeThreshold && speed > 1.5;

    if (handbraking) {
      targetRear = DRIFT.handbrakeRearGrip;
      targetFront = DRIFT.driftFrontGrip;
    } else if (this.active) {
      targetRear = DRIFT.driftRearGrip;
      targetFront = DRIFT.driftFrontGrip;
    }

    if (this.active || handbraking) {
      /* lift off and the tail hooks back up; stay pinned and it keeps sliding */
      targetRear *= lerp(DRIFT.liftOffGripRecovery, 1, clamp01(throttle));
      targetYaw = STEER.yawAssistDriftGain;
      targetSteerBonus = STEER.driftExtraAngle;
    }

    this.frontGripMul = damp(this.frontGripMul, targetFront, DRIFT.gripBlendRate, dt);
    this.rearGripMul = damp(this.rearGripMul, targetRear, DRIFT.gripBlendRate, dt);
    this.yawGain = damp(this.yawGain, targetYaw, DRIFT.gripBlendRate, dt);
    this.steerBonus = damp(this.steerBonus, targetSteerBonus, DRIFT.gripBlendRate, dt);
  }

  /** Force the drift closed (respawn, flip, mode change) without a payout. */
  cancel(): void {
    this.active = false;
    this.duration = 0;
    this.angleIntegral = 0;
    this.charge = 0;
    this.tier = -1;
    this.belowExitFor = 0;
    this.airtimeInDrift = 0;
  }

  /**
   * Pull the mini-turbo payout, if any. Returns null unless a drift ended on the
   * previous `step`. The returned object is reused — read it immediately.
   */
  consumeReward(): DriftReward | null {
    if (!this.rewardPending) return null;
    this.rewardPending = false;
    return this.reward;
  }

  private end(bus: EventBus): void {
    const duration = this.duration;
    const angleIntegral = this.angleIntegral;
    const tier = this.tier;

    let points = 0;
    if (duration >= DRIFT.minScoringDuration) {
      points = Math.round(
        duration * DRIFT.pointsPerSecond + angleIntegral * DRIFT.pointsPerAngleIntegral,
      );
    }

    this.active = false;
    this.duration = 0;
    this.angleIntegral = 0;
    this.charge = 0;
    this.tier = -1;
    this.belowExitFor = 0;
    this.airtimeInDrift = 0;
    /* short lock so the exit reads as a clean, snappy release rather than chatter */
    this.reentryLock = 0.12;

    if (tier >= 0) {
      this.reward.tier = tier;
      this.reward.boostSeconds = DRIFT.tierBoostSeconds[tier];
      this.reward.impulse = DRIFT.tierImpulse[tier];
      this.reward.meter = DRIFT.tierMeterRefill[tier];
      this.rewardPending = true;
    }

    bus.emit('vehicle:driftEnd', { duration, angleIntegral, points });
  }

  private tierForCharge(charge: number): number {
    let t = -1;
    for (let i = 0; i < DRIFT.tierCharge.length; i++) {
      if (charge >= DRIFT.tierCharge[i]) t = i;
    }
    return t;
  }
}
