/**
 * CameraShake.ts — trauma-based screen shake.
 *
 * The model is the standard one (Squirrel Eiserloh's "Math for Game
 * Programmers: Juicing Your Cameras With Math"), because it is still the right
 * answer:
 *
 *   - Events add **trauma** (0..1). Trauma decays *linearly* over time.
 *   - Displacement is proportional to **trauma²**.
 *   - The actual offsets come from smooth **noise**, never from `Math.random()`.
 *
 * Why each of those matters here:
 *
 *   Linear decay means a hit has a definite, predictable end — exponential
 *   decay leaves a long inaudible tail that makes the camera feel permanently
 *   loose. Squaring means a light kerb strike and a head-on with a guagua are
 *   obviously different events instead of both reading as "shake". And noise
 *   rather than random is the difference between a camera being *shaken* and a
 *   camera *vibrating*: per-frame random is a white-noise signal whose apparent
 *   frequency changes with framerate, aliases horribly, and is a well-known
 *   nausea and photosensitivity trigger. `valueNoise2D` sampled against a time
 *   accumulator is C1-continuous, framerate-independent, and looks like a
 *   physical camera operator being jolted.
 *
 * Accessibility (non-negotiable): every output is multiplied by
 * `settings.screenShake`, and at exactly 0 the system short-circuits before it
 * samples anything — the offsets are hard zero, not "very small". A second,
 * softer reduction applies under `settings.photosensitiveSafe`.
 */

import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp01 } from '../core/MathUtils';
import { valueNoise2D } from '../core/RNG';
import { SHAKE } from './CameraTuning';

/** Kinds of `vehicle:collision`, weighted so a bin isn't a building. */
function collisionWeight(kind: 'traffic' | 'prop' | 'wall' | 'ped'): number {
  switch (kind) {
    case 'wall':
      return SHAKE.collisionWeightWall;
    case 'traffic':
      return SHAKE.collisionWeightTraffic;
    case 'prop':
      return SHAKE.collisionWeightProp;
    case 'ped':
      return SHAKE.collisionWeightPed;
  }
}

export class CameraShake {
  /**
   * Positional offset in **camera-local** space, metres. The consumer applies
   * it after orienting the camera, so shake always translates across the screen
   * rather than through the world (a world-space shake would push the camera
   * into walls, and the collision solver has already run by then).
   */
  readonly positionOffset = new THREE.Vector3();

  /**
   * Rotational offset in radians as (pitch, yaw, roll), applied in the camera's
   * local frame with `YXZ` order — the natural order for a camera head.
   */
  readonly rotationOffset = new THREE.Vector3();

  private _trauma = 0;
  private _rumble = 0;
  private _intensity = 0;
  private time = 0;

  /** Last known camera position, used for distance falloff on world events. */
  private readonly refPos = new THREE.Vector3();
  private hasRef = false;

  private readonly unsubscribers: Array<() => void> = [];

  constructor(bus: EventBus) {
    this.unsubscribers.push(
      bus.on('vehicle:collision', (e) => {
        const raw = clamp01(e.impulse / SHAKE.collisionFullImpulse) * collisionWeight(e.kind);
        this.addTrauma(Math.min(raw, SHAKE.collisionMax));
      }),

      bus.on('vehicle:jumpLand', (e) => {
        const fromHeight = clamp01(e.height / SHAKE.landFullHeight) * SHAKE.landHeightWeight;
        const fromAir = clamp01(e.airtime / SHAKE.landFullAirtime) * SHAKE.landAirtimeWeight;
        const clean = e.clean ? SHAKE.landCleanScale : 1;
        this.addTrauma((fromHeight + fromAir) * clean);
      }),

      bus.on('prop:destroyed', (e) => {
        // Breaking a crate on the other side of the plaza must not shake the
        // camera; falloff is linear in distance from the eye.
        let scale = 1;
        if (this.hasRef && e.at) {
          const d = this.refPos.distanceTo(e.at);
          scale = 1 - clamp01(d / SHAKE.propFalloffDistance);
        }
        this.addTrauma(SHAKE.propTrauma * scale);
      }),

      bus.on('vehicle:boostStart', () => {
        this.addTrauma(SHAKE.boostTrauma);
      }),
    );
  }

  /** Current trauma, 0..1. */
  get trauma(): number {
    return this._trauma;
  }

  /** Effective shake intensity after settings scaling, 0..1. For fx/haptics. */
  get intensity(): number {
    return this._intensity;
  }

  /**
   * Add trauma. Values accumulate but saturate at 1, so a multi-car pile-up
   * cannot produce an unbounded shake. Negative and non-finite input is ignored
   * rather than trusted — this is a public entry point other systems call.
   */
  addTrauma(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this._trauma = clamp01(this._trauma + amount);
  }

  /**
   * Continuous, non-decaying shake for sustained states (boost thrust, driving
   * across cobbles on two wheels). Set every frame; it is not additive.
   */
  setRumble(amount: number): void {
    this._rumble = Number.isFinite(amount) ? clamp01(amount) : 0;
  }

  /** Instantly silence the shake — used on respawn and state transitions. */
  reset(): void {
    this._trauma = 0;
    this._rumble = 0;
    this._intensity = 0;
    this.positionOffset.set(0, 0, 0);
    this.rotationOffset.set(0, 0, 0);
  }

  /**
   * Advance and sample. Allocation-free.
   *
   * @param dt          seconds; 0 freezes the shake (paused) without decaying it
   * @param screenShake `settings.screenShake`, 0..1 — 0 disables entirely
   * @param photosensitiveSafe `settings.photosensitiveSafe`
   * @param scale       per-mode multiplier from `CameraModeParams.shakeScale`
   * @param cameraPos   current eye position, cached for event distance falloff
   */
  update(
    dt: number,
    screenShake: number,
    photosensitiveSafe: boolean,
    scale: number,
    cameraPos: THREE.Vector3,
  ): void {
    this.refPos.copy(cameraPos);
    this.hasRef = true;

    // Linear decay. Runs even when the shake is muted so trauma doesn't pile up
    // invisibly and then erupt the moment the player re-enables shake.
    if (dt > 0) {
      this._trauma = Math.max(0, this._trauma - SHAKE.decayPerSecond * dt);
      this.time += dt;
    }

    const settingScale = clamp01(screenShake) * (photosensitiveSafe ? SHAKE.photosensitiveScale : 1);
    const modeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
    const gain = settingScale * modeScale;

    // Accessibility short-circuit: hard zero, no sampling, no residue.
    if (gain <= 0) {
      this._intensity = 0;
      this.positionOffset.set(0, 0, 0);
      this.rotationOffset.set(0, 0, 0);
      return;
    }

    // trauma² is the shake curve; rumble is applied linearly because it is a
    // deliberate steady-state texture rather than an impulse response.
    const traumaMag = this._trauma * this._trauma;
    this._intensity = clamp01(traumaMag + this._rumble * SHAKE.rumbleAmplitude);

    if (traumaMag <= 0 && this._rumble <= 0) {
      this.positionOffset.set(0, 0, 0);
      this.rotationOffset.set(0, 0, 0);
      return;
    }

    const t = this.time;
    const tp = t * SHAKE.frequency;
    const to = t * SHAKE.frequency * SHAKE.octaveFrequency;
    const tr = t * SHAKE.rumbleFrequency;

    // metres of positional shake and radians of rotational shake at the current
    // trauma, already scaled by settings and mode.
    const posGain = traumaMag * SHAKE.positionAmplitude * gain;
    const rotGain = traumaMag * SHAKE.rotationAmplitude * gain;
    const rumPos = this._rumble * SHAKE.rumbleAmplitude * SHAKE.positionAmplitude * gain;
    const rumRot = this._rumble * SHAKE.rumbleAmplitude * SHAKE.rotationAmplitude * gain;

    this.positionOffset.set(
      this.n(tp, to, SHAKE.seedPosX) * posGain + this.r(tr, SHAKE.seedPosX) * rumPos,
      this.n(tp, to, SHAKE.seedPosY) * posGain + this.r(tr, SHAKE.seedPosY) * rumPos,
      // Z (along the view axis) shakes least — dolly jitter reads as a focus
      // problem rather than an impact, and it is the axis most likely to punch
      // the near plane through a wall the collision solver just cleared.
      this.n(tp, to, SHAKE.seedPosZ) * posGain * 0.35,
    );

    this.rotationOffset.set(
      this.n(tp, to, SHAKE.seedRotX) * rotGain + this.r(tr, SHAKE.seedRotX) * rumRot,
      this.n(tp, to, SHAKE.seedRotY) * rotGain + this.r(tr, SHAKE.seedRotY) * rumRot,
      this.n(tp, to, SHAKE.seedRotZ) * rotGain * SHAKE.rollScale,
    );
  }

  /**
   * Two-octave smooth noise in roughly [-1, 1]. The second octave adds the
   * high-frequency grit that makes an impact feel sharp, while the base octave
   * keeps the overall motion readable. `valueNoise2D` is sampled along X with a
   * fixed Y so each seed gives an independent, C1-continuous 1D signal.
   */
  private n(base: number, octave: number, seed: number): number {
    const a = valueNoise2D(base, 0.5, seed);
    const b = valueNoise2D(octave, 0.5, seed ^ 0x5bf0);
    return (a + b * SHAKE.octaveWeight) / (1 + SHAKE.octaveWeight);
  }

  /** Single-octave, slower noise for the continuous rumble channel. */
  private r(t: number, seed: number): number {
    return valueNoise2D(t, 0.5, seed ^ 0x2c9d);
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.reset();
  }
}
