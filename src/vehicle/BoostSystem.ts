/**
 * Loco Lift — the boost meter.
 *
 * One 0..1 meter, filled by driving dangerously (drifts, near misses, big air)
 * and emptied by holding the boost button. Boost must feel *violent*: a hard
 * shove, a raised speed ceiling, and a short ramp so it lands as a punch rather
 * than a fade.
 *
 * Mini-turbos from DriftModel bypass the meter entirely — they run on their own
 * timer so a perfect drift always pays out even on an empty tank.
 */
import type { EventBus } from '../core/EventBus';
import { clamp01, damp } from '../core/MathUtils';
import { BOOST } from './VehicleTuning';

export class BoostSystem {
  /** 0..1 meter fill */
  private meter = 0;
  /** true whenever thrust is being produced (meter boost or mini-turbo) */
  private active = false;
  /** 0..1 thrust envelope — ramps in and out so it never steps */
  private ramp = 0;
  /** 0..1 value the exhaust flame / underglow tracks */
  private glow = 0;

  /** seconds of free mini-turbo boost still owed */
  private autoTimer = 0;
  /** one-shot impulse queued by a mini-turbo, N·s */
  private pendingImpulse = 0;
  /** minimum-duration lock so a tap still reads as a boost */
  private holdTimer = 0;

  /** toggle-mode latch and edge detector */
  private toggled = false;
  private prevButton = false;

  reset(): void {
    this.meter = 0;
    this.active = false;
    this.ramp = 0;
    this.glow = 0;
    this.autoTimer = 0;
    this.pendingImpulse = 0;
    this.holdTimer = 0;
    this.toggled = false;
    this.prevButton = false;
  }

  get fraction(): number {
    return this.meter;
  }

  get isBoosting(): boolean {
    return this.active;
  }

  /** 0..1 thrust envelope; multiply the tuning thrust by this. */
  get thrustEnvelope(): number {
    return this.ramp;
  }

  /** 0..1 for the exhaust glow / underglow / camera FOV kick. */
  get glowLevel(): number {
    return this.glow;
  }

  /** true while a drift payout is driving the boost rather than the meter */
  get isMiniTurbo(): boolean {
    return this.autoTimer > 0;
  }

  /** Add meter. Clamped, ignores non-finite input. */
  add(amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    this.meter = clamp01(this.meter + amount);
  }

  /** Drain meter directly (crash penalties etc.). */
  drain(amount: number): void {
    if (!Number.isFinite(amount)) return;
    this.meter = clamp01(this.meter - amount);
  }

  /** Mini-turbo payout from a completed drift. */
  grantMiniTurbo(seconds: number, impulse: number, meter: number): void {
    this.autoTimer = Math.max(this.autoTimer, seconds);
    this.pendingImpulse += impulse;
    this.add(meter);
  }

  /**
   * Pull and clear the queued one-shot impulse. Vehicle applies it along the
   * chassis forward axis.
   */
  consumeImpulse(): number {
    const v = this.pendingImpulse;
    this.pendingImpulse = 0;
    return v;
  }

  /**
   * @param button raw boost input this step
   * @param holdToBoost from SettingsState — false switches to a toggle
   * @param speed current speed, m/s (drives the trickle regen)
   */
  step(
    dt: number,
    button: boolean,
    holdToBoost: boolean,
    speed: number,
    bus: EventBus,
  ): void {
    /* --- resolve the player's intent --- */
    const pressed = button && !this.prevButton;
    this.prevButton = button;

    if (holdToBoost) {
      this.toggled = false;
    } else if (pressed) {
      this.toggled = !this.toggled;
    }
    const wants = holdToBoost ? button : this.toggled;

    /* --- mini-turbo timer runs regardless of input or meter --- */
    if (this.autoTimer > 0) this.autoTimer = Math.max(0, this.autoTimer - dt);

    /* --- decide whether thrust is on this step --- */
    const wasActive = this.active;
    let on = this.autoTimer > 0;

    if (!on) {
      if (this.active) {
        /* keep going while held and there is anything left in the tank */
        on = wants && this.meter > BOOST.minToHold;
        if (this.holdTimer > 0) on = true;
      } else if (wants && this.meter >= BOOST.minToStart) {
        on = true;
        this.holdTimer = BOOST.minDuration;
      }
    }

    if (on && this.autoTimer <= 0) {
      this.meter = clamp01(this.meter - BOOST.drainPerSecond * dt);
      if (this.meter <= 0 && this.holdTimer <= 0) {
        on = false;
        this.toggled = false;
      }
    }

    if (this.holdTimer > 0) this.holdTimer = Math.max(0, this.holdTimer - dt);

    this.active = on;

    /* --- envelope --- */
    const rate = on ? 1 / Math.max(1e-4, BOOST.rampInTime) : 1 / Math.max(1e-4, BOOST.rampOutTime);
    const target = on ? 1 : 0;
    this.ramp = clamp01(this.ramp + (target - this.ramp) * Math.min(1, rate * dt * 2.2));
    if (!on && this.ramp < 0.002) this.ramp = 0;

    this.glow = damp(this.glow, on ? 1 : 0, BOOST.glowRate, dt);

    /* --- passive trickle so the player is never completely dry --- */
    if (!on && speed > BOOST.trickleSpeed) {
      this.meter = clamp01(this.meter + BOOST.trickleRegen * dt);
    }

    if (on && !wasActive) bus.emit('vehicle:boostStart', {});
    else if (!on && wasActive) bus.emit('vehicle:boostEnd', {});
  }
}
