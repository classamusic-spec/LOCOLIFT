/**
 * AudioSystem.ts — owns the AudioContext and everything hanging off it.
 *
 * Bus topology
 * ------------
 *   engine ─┐
 *   sfx   ──┼─▶ sfxBus  ──┐
 *   ambience ─▶ ambBus  ──┼─▶ masterPre ─▶ compressor ─▶ limiter ─▶ masterOut ─▶ out
 *   music ─▶ musicBus ─▶ musicDuck ──┘
 *
 * `masterOut` carries `settings.masterVolume`, `musicBus` carries
 * `settings.musicVolume`, `sfxBus`/`ambBus` carry `settings.sfxVolume`. The
 * compressor keeps a 12-car pile-up from clipping; the wave-shaper after it is
 * a true safety limiter so the output is mathematically bounded to ±1.
 *
 * Spatialisation — why not PannerNode
 * -----------------------------------
 * We use a manual constant-power pan + distance gain + air-absorption
 * low-pass computed from the listener-relative vector, not `PannerNode`.
 * Reasons, in order:
 *   1. HRTF panners run a per-voice convolution. With 30-40 concurrent
 *      one-shots during a pile-up that is a measurable chunk of a 16 ms frame,
 *      and this game spends its budget on the city.
 *   2. `equalpower` PannerNode plus its distance model still costs a node per
 *      voice and forces us to keep a `position` in sync per frame for loops.
 *   3. Arcade distance behaviour is deliberately *not* physical (see
 *      `distanceGain`): inverse-square makes a 60 m crash inaudible, which is
 *      wrong for a game where the interesting thing is usually 40 m away. A
 *      hand-written curve gives us exactly the falloff we want.
 *   4. It is deterministic and testable offline — the pan/gain for a given
 *      world position is a pure function we can assert on.
 * The cost is no elevation cue, which is irrelevant for a ground-based arcade
 * racer with a chase camera.
 */

import * as THREE from 'three';
import type {
  ComboEvent,
  EventKey,
  EventMap,
  GameContext,
  GameStateId,
  QualityTier,
  SettingsState,
  SfxId,
  System,
} from '../core/types';
import { clamp, clamp01, damp, lerp } from '../core/MathUtils';
import { Ambience, type AmbienceContext, type WeatherKind } from './Ambience';
import { EngineAudio, type EngineState } from './EngineAudio';
import { MusicSystem, type MusicState } from './MusicSystem';
import { SfxLibrary, type SfxPlayOptions } from './SfxLibrary';
import { distanceCutoff, distanceGain, finiteOr, gainNode, safeDisconnect, softClipCurve } from './Synth';

/* ------------------------------------------------------- duck-typed refs */

/**
 * The slice of `Vehicle` this system reads. Declared structurally on purpose:
 * the audio module must not import the vehicle module (see ARCHITECTURE.md
 * "own only your files"), and a `class Vehicle` with these getters satisfies
 * this interface automatically.
 */
export interface VehicleAudioRef {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly speed: number;
  readonly forwardSpeed: number;
  readonly isDrifting: boolean;
  readonly isAirborne: boolean;
  readonly isBoosting: boolean;
  readonly engineRpmNorm: number;
  readonly gear: number;
  readonly wheelSlip: Float32Array;
  readonly wheelsOnGround: number;
}

/**
 * The slice of `World` the ambience reads. `zoneAt` is optional — without it
 * the ambience falls back to a position-derived guess, so wiring the world in
 * is an upgrade, not a requirement.
 */
export interface WorldAudioRef {
  zoneAt?(x: number, z: number): string;
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface AudioSystemOptions {
  /** deterministic seed for all procedural variation */
  seed?: number;
  /** start the music engine as soon as the context unlocks */
  autoStartMusic?: boolean;
}

type AudioCtor = new (options?: AudioContextOptions) => AudioContext;

const GLOBAL = globalThis as unknown as {
  AudioContext?: AudioCtor;
  webkitAudioContext?: AudioCtor;
  addEventListener?: (t: string, f: () => void, o?: unknown) => void;
  removeEventListener?: (t: string, f: () => void, o?: unknown) => void;
};

/* ------------------------------------------------------------------ class */

export class AudioSystem implements System {
  readonly name = 'audio';

  private ctxAudio: AudioContext | null = null;
  private ok = false;

  /* buses */
  private masterOut!: GainNode;
  private limiter!: WaveShaperNode;
  private compressor!: DynamicsCompressorNode;
  private masterPre!: GainNode;
  private musicBus!: GainNode;
  private musicDuck!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;

  /* subsystems */
  private sfx: SfxLibrary | null = null;
  private music: MusicSystem | null = null;
  private engine: EngineAudio | null = null;
  private ambience: Ambience | null = null;

  /* wiring */
  private unsubs: Array<() => void> = [];
  private vehicle: VehicleAudioRef | null = null;
  private world: WorldAudioRef | null = null;
  private bus: GameContext['bus'] | null = null;

  /* listener frame */
  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerRight = new THREE.Vector3(1, 0, 0);
  private readonly listenerFwd = new THREE.Vector3(0, 0, -1);
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpMat = new THREE.Matrix4();

  /* mix state */
  private duckAmount = 0;
  private duckHold = 0;
  private explicitIntensity = 0;
  private explicitDecay = 0;
  private heat = 0.3;
  private timePressure = 0;
  private comboCount = 0;
  private comboMultiplier = 1;
  private gameState: GameStateId = 'boot';
  private weather: WeatherKind = 'clear';
  private screechLevel = 0;
  /** state requested before the context was unlocked */
  private pendingMusicState: MusicState | null = null;

  /* cached settings */
  private lastMaster = -1;
  private lastMusic = -1;
  private lastSfx = -1;

  private readonly seed: number;
  private readonly autoStartMusic: boolean;
  private unlocked = false;
  private disposed = false;
  private gestureHandler: (() => void) | null = null;

  /* reusable ambience payload — no per-frame allocation */
  private readonly ambCtx: AmbienceContext = {
    x: 0,
    z: 0,
    timeOfDay: 12,
    zone: 'oldTown',
    speed: 0,
    paused: false,
  };

  /* reusable engine payload */
  private readonly engState: EngineState = {
    rpmNorm: 0,
    gear: 1,
    throttle: 0,
    brake: 0,
    speed: 0,
    boosting: false,
    airborne: false,
    wheelsOnGround: 4,
  };

  constructor(opts: AudioSystemOptions = {}) {
    this.seed = (opts.seed ?? 0x10c0_11f7) >>> 0;
    this.autoStartMusic = opts.autoStartMusic ?? true;
    this.build();
  }

  /* ------------------------------------------------------------- lifecycle */

  private build(): void {
    const Ctor = GLOBAL.AudioContext ?? GLOBAL.webkitAudioContext;
    if (!Ctor) {
      // No Web Audio (headless, ancient browser, blocked). Degrade silently:
      // every public method becomes a no-op and the game runs fine.
      this.ok = false;
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      this.ok = false;
      return;
    }
    this.ctxAudio = ctx;

    try {
      this.masterOut = gainNode(ctx, 0.9);
      this.limiter = ctx.createWaveShaper();
      // Bounded to ±1 by construction — nothing downstream can ever clip.
      this.limiter.curve = softClipCurve(1.35);
      this.limiter.oversample = '2x';
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -13;
      this.compressor.knee.value = 22;
      this.compressor.ratio.value = 3.4;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.19;
      this.masterPre = gainNode(ctx, 1);

      this.masterPre.connect(this.compressor);
      this.compressor.connect(this.limiter);
      this.limiter.connect(this.masterOut);
      this.masterOut.connect(ctx.destination);

      this.musicBus = gainNode(ctx, 0.55);
      this.musicDuck = gainNode(ctx, 1);
      this.musicBus.connect(this.musicDuck);
      this.musicDuck.connect(this.masterPre);

      this.sfxBus = gainNode(ctx, 0.85);
      this.sfxBus.connect(this.masterPre);

      this.ambBus = gainNode(ctx, 0.45);
      this.ambBus.connect(this.masterPre);

      this.sfx = new SfxLibrary(ctx, this.sfxBus, this.seed ^ 0x51f1);
      this.music = new MusicSystem(ctx, this.musicBus, this.seed ^ 0x3011, true);
      this.engine = new EngineAudio(ctx, this.sfxBus, {});
      this.ambience = new Ambience(ctx, this.ambBus, this.sfx, this.seed ^ 0x0a3b);
      this.ok = true;
    } catch {
      this.ok = false;
      this.teardownGraph();
    }
  }

  get available(): boolean {
    return this.ok && !this.disposed;
  }

  get context(): AudioContext | null {
    return this.ctxAudio;
  }

  /** True once the context has actually been resumed by a user gesture. */
  get isUnlocked(): boolean {
    return this.unlocked;
  }

  init(ctx: GameContext): void {
    if (!this.ok) return;
    this.bus = ctx.bus;
    this.applySettings(ctx.settings, true);
    this.subscribe(ctx);
    this.installGestureUnlock();

    if (this.world?.bounds && this.ambience) {
      this.ambience.setSeaExtent(Math.max(Math.abs(this.world.bounds.minZ), this.world.bounds.maxZ));
    }
  }

  /**
   * Resume the AudioContext. Browsers start it suspended until a user gesture;
   * call this from any click/keypress. Safe to call repeatedly.
   */
  async unlock(): Promise<void> {
    if (!this.ok || !this.ctxAudio) return;
    try {
      if (this.ctxAudio.state === 'suspended') await this.ctxAudio.resume();
    } catch {
      return;
    }
    if (this.unlocked) return;
    this.unlocked = true;

    // A one-sample silent buffer satisfies the stricter iOS unlock path.
    try {
      const b = this.ctxAudio.createBuffer(1, 1, this.ctxAudio.sampleRate);
      const s = this.ctxAudio.createBufferSource();
      s.buffer = b;
      s.connect(this.ctxAudio.destination);
      s.start(0);
    } catch {
      /* ignore */
    }

    this.engine?.start();
    this.ambience?.start();
    if (this.autoStartMusic && this.music) {
      this.music.start(this.pendingMusicState ?? this.musicStateFor(this.gameState));
      this.pendingMusicState = null;
    }
    this.removeGestureUnlock();
  }

  setVehicle(v: VehicleAudioRef | null): void {
    this.vehicle = v;
  }

  setWorld(w: WorldAudioRef | null): void {
    this.world = w;
    if (w?.bounds && this.ambience) {
      this.ambience.setSeaExtent(Math.max(Math.abs(w.bounds.minZ), w.bounds.maxZ));
    }
  }

  onQualityChange(tier: QualityTier, _settings: SettingsState): void {
    if (!this.ok) return;
    // Low tier trims the wet sends and the polyphony budget; the mix stays
    // recognisable, it just costs less.
    const wet = tier === 'low' ? 0 : tier === 'medium' ? 0.6 : 1;
    this.music?.setReverbAmount(0.16 * wet);
    this.music?.setEchoAmount(0.2 * (tier === 'low' ? 0.3 : 1));
    this.sfx?.setTrim(tier === 'low' ? 0.9 : 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.unsubs = [];
    this.removeGestureUnlock();

    this.engine?.dispose();
    this.music?.dispose();
    this.ambience?.dispose();
    this.sfx?.dispose();
    this.engine = null;
    this.music = null;
    this.ambience = null;
    this.sfx = null;

    this.teardownGraph();

    if (this.ctxAudio) {
      const c = this.ctxAudio;
      this.ctxAudio = null;
      try {
        void c.close();
      } catch {
        /* ignore */
      }
    }
    this.ok = false;
    this.vehicle = null;
    this.world = null;
    this.bus = null;
  }

  private teardownGraph(): void {
    for (const n of [
      this.musicBus,
      this.musicDuck,
      this.sfxBus,
      this.ambBus,
      this.masterPre,
      this.compressor,
      this.limiter,
      this.masterOut,
    ]) {
      safeDisconnect(n as AudioNode | undefined);
    }
  }

  /* ---------------------------------------------------------------- frame */

  update(ctx: GameContext, dt: number): void {
    if (!this.ok || !this.ctxAudio) return;
    const step = clamp(finiteOr(dt, 1 / 60), 0, 0.25);

    this.applySettings(ctx.settings, false);

    /* ------------------------------------------------------------ ducking */
    if (this.duckHold > 0) this.duckHold = Math.max(0, this.duckHold - step);
    else this.duckAmount = damp(this.duckAmount, 0, 3.2, step);
    if (this.musicDuck) {
      this.musicDuck.gain.setTargetAtTime(
        clamp01(1 - this.duckAmount),
        this.ctxAudio.currentTime,
        0.05,
      );
    }

    /* --------------------------------------------------------- gameplay */
    const v = this.vehicle;
    const paused = ctx.paused || this.gameState === 'paused';

    if (v) {
      this.engState.rpmNorm = clamp01(finiteOr(v.engineRpmNorm, 0));
      this.engState.gear = Math.round(finiteOr(v.gear, 1));
      this.engState.throttle = paused ? 0 : clamp01(finiteOr(ctx.input.throttle, 0));
      this.engState.brake = clamp01(finiteOr(ctx.input.brake, 0));
      this.engState.speed = Math.max(0, finiteOr(v.speed, 0));
      this.engState.boosting = !!v.isBoosting;
      this.engState.airborne = !!v.isAirborne;
      this.engState.wheelsOnGround = clamp(Math.round(finiteOr(v.wheelsOnGround, 4)), 0, 4);
      this.engine?.update(step, this.engState);

      this.updateTyres(v, step, paused);
      this.updateHeat(v, step);
    } else {
      this.engState.throttle = 0;
      this.engine?.update(step, this.engState);
    }

    /* --------------------------------------------------------- ambience */
    if (this.ambience) {
      const px = v ? v.position.x : this.listenerPos.x;
      const pz = v ? v.position.z : this.listenerPos.z;
      this.ambCtx.x = finiteOr(px, 0);
      this.ambCtx.z = finiteOr(pz, 0);
      this.ambCtx.timeOfDay = finiteOr(ctx.timeOfDay, 12);
      this.ambCtx.zone = this.zoneAt(this.ambCtx.x, this.ambCtx.z);
      this.ambCtx.speed = v ? Math.max(0, finiteOr(v.speed, 0)) : 0;
      this.ambCtx.paused = paused;
      this.ambience.update(step, this.ambCtx);
    }

    /* ------------------------------------------------------------- music */
    if (this.music) {
      if (this.explicitDecay > 0) {
        this.explicitDecay = Math.max(0, this.explicitDecay - step);
        if (this.explicitDecay === 0) this.explicitIntensity = 0;
      }
      this.music.setIntensity(Math.max(this.heat, this.explicitIntensity));
      this.music.tick(step);
    }

    this.sfx?.update();
  }

  /** Listener is refreshed after the camera has settled for the frame. */
  lateUpdate(ctx: GameContext, _dt: number): void {
    if (!this.ok) return;
    const cam = ctx.camera;
    if (!cam) return;
    this.tmpMat.copy(cam.matrixWorld);
    this.listenerPos.setFromMatrixPosition(this.tmpMat);
    // Columns of the world matrix are the camera basis vectors.
    this.listenerRight.set(this.tmpMat.elements[0], this.tmpMat.elements[1], this.tmpMat.elements[2]).normalize();
    this.listenerFwd
      .set(-this.tmpMat.elements[8], -this.tmpMat.elements[9], -this.tmpMat.elements[10])
      .normalize();
  }

  /* --------------------------------------------------------------- public */

  /** Fire a sound. `at` spatialises it relative to the listener. */
  playSfx(id: SfxId, at?: THREE.Vector3, volume = 1, pitch = 1): void {
    if (!this.ok || !this.sfx) return;
    const opts: SfxPlayOptions = { volume, pitch };
    if (at) this.spatialise(at, opts, volume);
    if ((opts.volume ?? 0) <= 0.0008) return;
    this.sfx.play(id, opts);
  }

  setMusicIntensity(v: number): void {
    this.explicitIntensity = clamp01(finiteOr(v, 0));
    this.explicitDecay = 9;
  }

  setMusicState(s: MusicState, immediate = false): void {
    this.applyMusicState(s, immediate);
  }

  /**
   * Music must not start scheduling against a suspended context — its clock
   * would not advance and it would have to catch up on resume. Until the first
   * gesture we just remember what was asked for.
   */
  private applyMusicState(s: MusicState, immediate = false): void {
    if (!this.unlocked) {
      this.pendingMusicState = s;
      return;
    }
    this.music?.setState(s, immediate);
  }

  /** Duck the music bus. `amount` 0..1, `hold` seconds before it recovers. */
  duckMusic(amount: number, hold = 0.15): void {
    this.duckAmount = Math.max(this.duckAmount, clamp01(finiteOr(amount, 0)));
    this.duckHold = Math.max(this.duckHold, Math.max(0, finiteOr(hold, 0)));
  }

  /** Musical beat phase (0..1) — the HUD can pulse in time with the score. */
  get beatPhase(): number {
    return this.music ? this.music.beatPhase : 0;
  }

  /* ------------------------------------------------------------- internals */

  private zoneAt(x: number, z: number): string {
    const w = this.world;
    if (w && typeof w.zoneAt === 'function') {
      try {
        return w.zoneAt(x, z);
      } catch {
        /* fall through */
      }
    }
    // Fallback heuristic matching the district layout: forts to −X and the
    // far −Z edge, docks to +Z, hillside to +X, old town in the middle.
    if (x < -330) return 'fortress';
    if (z > 200) return 'waterfront';
    if (z < -250) return x < -140 ? 'fortress' : 'artQuarter';
    if (x > 330) return 'hillside';
    return 'oldTown';
  }

  /**
   * Convert a world position into pan / gain / cutoff for the listener frame.
   * Writes into `opts` so we never allocate in the hot path.
   */
  private spatialise(at: THREE.Vector3, opts: SfxPlayOptions, baseVolume: number): void {
    this.tmpVec.copy(at).sub(this.listenerPos);
    const dist = this.tmpVec.length();
    const g = distanceGain(dist);
    opts.volume = baseVolume * g;
    if (g <= 0) return;

    if (dist > 1e-4) {
      this.tmpVec.multiplyScalar(1 / dist);
      let pan = clamp(this.tmpVec.dot(this.listenerRight) * 1.2, -1, 1);
      // Very close sounds collapse toward the centre — hard-panning something
      // 1 m from the camera is disorienting.
      pan *= clamp01((dist - 1.2) / 5);
      opts.pan = pan;
      // Behind the listener loses presence.
      const front = this.tmpVec.dot(this.listenerFwd);
      if (front < 0) opts.volume *= lerp(1, 0.78, -front);
      opts.cutoff = distanceCutoff(dist) * (front < 0 ? 0.72 : 1);
    } else {
      opts.pan = 0;
      opts.cutoff = 20000;
    }
  }

  private applySettings(s: SettingsState, force: boolean): void {
    if (!this.ctxAudio) return;
    const t = this.ctxAudio.currentTime;
    const master = clamp01(finiteOr(s.masterVolume, 0.9));
    const musicV = clamp01(finiteOr(s.musicVolume, 0.55));
    const sfxV = clamp01(finiteOr(s.sfxVolume, 0.85));

    if (force || Math.abs(master - this.lastMaster) > 1e-3) {
      this.lastMaster = master;
      this.masterOut.gain.setTargetAtTime(master, t, 0.05);
    }
    if (force || Math.abs(musicV - this.lastMusic) > 1e-3) {
      this.lastMusic = musicV;
      this.musicBus.gain.setTargetAtTime(musicV * 0.82, t, 0.08);
    }
    if (force || Math.abs(sfxV - this.lastSfx) > 1e-3) {
      this.lastSfx = sfxV;
      this.sfxBus.gain.setTargetAtTime(sfxV, t, 0.05);
      this.ambBus.gain.setTargetAtTime(sfxV * 0.5, t, 0.12);
    }
  }

  /** Tyre screech + boost loops, driven by the vehicle's slip state. */
  private updateTyres(v: VehicleAudioRef, dt: number, paused: boolean): void {
    if (!this.sfx) return;
    let slip = 0;
    const ws = v.wheelSlip;
    if (ws && ws.length) {
      for (let i = 0; i < ws.length; i++) {
        const s = finiteOr(ws[i], 0);
        if (s > slip) slip = s;
      }
    }
    const grounded = v.wheelsOnGround > 0 && !v.isAirborne;
    const speedGate = clamp01((v.speed - 3.5) / 8);
    const target =
      paused || !grounded ? 0 : clamp01((slip - 0.22) / 0.55) * speedGate * (v.isDrifting ? 1 : 0.82);
    this.screechLevel = damp(this.screechLevel, target, target > this.screechLevel ? 16 : 7, dt);

    if (this.screechLevel > 0.02) {
      // Pitch tracks slip: more slip, higher and more anguished.
      const pitch = 0.82 + this.screechLevel * 0.5 + clamp01(v.speed / 60) * 0.18;
      this.sfx.startLoop('tireScreech', {
        volume: this.screechLevel * 0.85,
        pitch,
        pan: 0,
      });
    } else if (this.sfx.isLooping('tireScreech')) {
      this.sfx.stopLoop('tireScreech', 0.18);
    }

    if (v.isBoosting && !paused) {
      this.sfx.startLoop('boostLoop', { volume: 0.75, pitch: 0.95 + clamp01(v.speed / 60) * 0.3 });
    } else if (this.sfx.isLooping('boostLoop')) {
      this.sfx.stopLoop('boostLoop', 0.22);
    }
  }

  /** Gameplay heat -> musical intensity. */
  private updateHeat(v: VehicleAudioRef, dt: number): void {
    if (this.timePressure > 0) this.timePressure = Math.max(0, this.timePressure - dt * 0.06);
    const speedTerm = clamp01(v.speed / 42) * 0.4;
    const comboTerm = clamp01((this.comboMultiplier - 1) / 5) * 0.28;
    const boostTerm = v.isBoosting ? 0.18 : 0;
    const driftTerm = v.isDrifting ? 0.1 : 0;
    const airTerm = v.isAirborne ? 0.08 : 0;
    const target = clamp01(
      0.26 + speedTerm + comboTerm + boostTerm + driftTerm + airTerm + this.timePressure * 0.3,
    );
    this.heat = damp(this.heat, target, 1.4, dt);
  }

  private musicStateFor(state: GameStateId): MusicState {
    switch (state) {
      case 'title':
      case 'modeSelect':
      case 'settings':
        return 'title';
      case 'garage':
        return 'garage';
      case 'playing':
        return this.timePressure > 0.4 ? 'urgent' : 'shift';
      case 'results':
        return 'results';
      case 'paused':
      case 'boot':
      default:
        return 'title';
    }
  }

  /* --------------------------------------------------------- gesture hook */

  private installGestureUnlock(): void {
    if (this.gestureHandler || typeof GLOBAL.addEventListener !== 'function') return;
    const handler = (): void => {
      void this.unlock();
    };
    this.gestureHandler = handler;
    for (const evt of ['pointerdown', 'keydown', 'touchstart', 'mousedown']) {
      GLOBAL.addEventListener(evt, handler, { passive: true });
    }
  }

  private removeGestureUnlock(): void {
    if (!this.gestureHandler || typeof GLOBAL.removeEventListener !== 'function') return;
    for (const evt of ['pointerdown', 'keydown', 'touchstart', 'mousedown']) {
      GLOBAL.removeEventListener(evt, this.gestureHandler);
    }
    this.gestureHandler = null;
  }

  /* ------------------------------------------------------------ event wiring */

  private subscribe(gctx: GameContext): void {
    const bus = gctx.bus;
    const on = <K extends EventKey>(key: K, fn: (payload: EventMap[K]) => void): void => {
      this.unsubs.push(bus.on(key, fn));
    };

    /* ------------------------------------------------------------- state */
    on('game:state', ({ to }) => {
      const prev = this.gameState;
      this.gameState = to;
      if (to === 'paused') {
        this.duckMusic(0.35, 3600);
        this.sfx?.stopLoop('tireScreech', 0.1);
        this.sfx?.stopLoop('boostLoop', 0.1);
      } else if (prev === 'paused') {
        this.duckHold = 0;
        this.duckAmount = 0;
      }
      if (to !== 'paused') this.applyMusicState(this.musicStateFor(to), to === 'boot');
      if (to === 'results') this.sfx?.play('crowdCheer', { volume: 0.5 });
    });

    on('game:settingsChanged', ({ settings }) => this.applySettings(settings, true));
    on('game:quality', ({ tier }) => this.onQualityChange(tier, gctx.settings));

    /* ----------------------------------------------------------- vehicle */
    on('vehicle:driftStart', ({ speed }) => {
      this.sfx?.play('tireScreech', {
        volume: clamp01(speed / 30) * 0.5,
        pitch: 0.95 + clamp01(speed / 50) * 0.2,
      });
    });

    on('vehicle:driftEnd', ({ points, duration }) => {
      if (duration > 1.2 && points > 0) {
        this.sfx?.play('comboUp', { volume: 0.5, pitch: 1 + clamp01(duration / 6) * 0.4 });
      }
    });

    on('vehicle:jumpStart', ({ speed }) => {
      this.sfx?.play('jumpTakeoff', {
        volume: 0.5 + clamp01(speed / 40) * 0.4,
        pitch: 0.92 + clamp01(speed / 45) * 0.25,
      });
    });

    on('vehicle:jumpLand', ({ airtime, height, clean }) => {
      const force = clamp01((airtime * 0.6 + height * 0.08) / 1.6);
      this.sfx?.play('landing', { volume: 0.45 + force * 0.55, pitch: 1.08 - force * 0.22 });
      if (force > 0.55) this.duckMusic(0.28 * force, 0.1);
      if (clean && force > 0.4) {
        this.sfx?.play('comboUp', { volume: 0.4, pitch: 1.25 });
        this.music?.fill();
      }
    });

    on('vehicle:collision', ({ impulse, kind }) => {
      // Impulse comes in Newton-seconds; map it onto a perceptual 0..1.
      const f = clamp01(impulse / 2600);
      const heavy = f > 0.32 || kind === 'wall';
      const id: SfxId = heavy ? 'impactHeavy' : 'impactLight';
      const vol = clamp(0.25 + f * 0.9, 0.15, 1.3);
      this.sfx?.play(id, { volume: vol, pitch: lerp(1.18, 0.82, f) });
      if (f > 0.25) this.duckMusic(clamp01(0.2 + f * 0.5), 0.12);
      if (f > 0.5) this.sfx?.play('propBreak', { volume: f * 0.4, pitch: 0.9 });
    });

    on('vehicle:nearMiss', ({ speed, at }) => {
      this.playSfx('nearMiss', at, clamp01(speed / 34) * 0.85, 0.9 + clamp01(speed / 50) * 0.35);
      this.music?.fill();
    });

    on('vehicle:boostStart', () => {
      this.sfx?.play('boostStart', { volume: 0.75 });
      this.setMusicIntensity(Math.max(this.explicitIntensity, 0.85));
    });

    on('vehicle:boostEnd', () => {
      this.sfx?.stopLoop('boostLoop', 0.25);
    });

    on('vehicle:airTrick', ({ points }) => {
      this.sfx?.play('comboUp', { volume: 0.6, pitch: 1.1 + clamp01(points / 900) * 0.5 });
    });

    on('vehicle:reset', () => {
      this.sfx?.play('uiBack', { volume: 0.6 });
      this.sfx?.stopLoop('tireScreech', 0.05);
      this.screechLevel = 0;
    });

    on('vehicle:twoWheels', ({ duration }) => {
      if (duration > 0.8) this.sfx?.play('comboUp', { volume: 0.35, pitch: 1.35 });
    });

    /* -------------------------------------------------------------- props */
    on('prop:destroyed', ({ at, points }) => {
      this.playSfx('propBreak', at, 0.7 + clamp01(points / 500) * 0.3, 0.85 + Math.random() * 0.35);
    });

    /* ------------------------------------------------------------- combo */
    on('combo:add', (e: ComboEvent) => {
      this.comboCount++;
      const pitch = 1 + Math.min(this.comboCount, 10) * 0.062;
      this.playSfx('comboUp', e.at, 0.5, pitch);
    });

    on('combo:break', () => {
      if (this.comboCount > 2) this.sfx?.play('comboBreak', { volume: 0.55 });
      this.comboCount = 0;
      this.comboMultiplier = 1;
    });

    on('combo:multiplier', ({ multiplier }) => {
      this.comboMultiplier = Math.max(1, finiteOr(multiplier, 1));
      this.sfx?.play('comboUp', { volume: 0.6, pitch: 1 + clamp01((multiplier - 1) / 6) * 0.7 });
    });

    /* -------------------------------------------------------- passengers */
    on('passenger:hail', ({ at }) => {
      this.playSfx('uiMove', at, 0.55, 1.15);
    });

    on('passenger:pickup', () => {
      this.sfx?.play('pickup', { volume: 0.8 });
      this.music?.fill();
      this.setMusicIntensity(Math.max(this.explicitIntensity, 0.6));
    });

    on('passenger:dropoff', ({ result }) => {
      this.sfx?.play('dropoff', { volume: 0.85 });
      this.sfx?.play('cashRegister', { volume: 0.7, when: this.now() + 0.16 });
      const great = result.rating >= 4;
      if (great) this.sfx?.play('crowdCheer', { volume: 0.4, when: this.now() + 0.25 });
      this.music?.celebrate();
    });

    on('passenger:bail', () => {
      this.sfx?.play('comboBreak', { volume: 0.6, pitch: 0.9 });
    });

    on('passenger:say', () => {
      // Dialogue duck: pull the music back so the line reads, then recover.
      this.duckMusic(0.4, 1.5);
    });

    /* ---------------------------------------------------------- missions */
    on('mission:start', () => this.sfx?.play('uiConfirm', { volume: 0.6 }));
    on('mission:complete', () => this.sfx?.play('cashRegister', { volume: 0.75 }));
    on('mission:fail', () => this.sfx?.play('comboBreak', { volume: 0.65, pitch: 0.85 }));

    /* ------------------------------------------------------------- shift */
    on('shift:start', () => {
      this.comboCount = 0;
      this.comboMultiplier = 1;
      this.timePressure = 0;
      this.sfx?.play('countdownGo', { volume: 0.85 });
      this.applyMusicState('shift');
      this.setMusicIntensity(0.6);
    });

    on('shift:end', ({ rating }) => {
      this.timePressure = 0;
      this.sfx?.play('crowdCheer', { volume: 0.35 + clamp01(rating / 5) * 0.4 });
      this.applyMusicState('results');
    });

    on('shift:timeAdded', ({ seconds }) => {
      this.sfx?.play('timeExtend', { volume: 0.7, pitch: 1 + clamp01(seconds / 40) * 0.2 });
      this.timePressure = Math.max(0, this.timePressure - 0.5);
      if (this.timePressure < 0.35 && this.gameState === 'playing') this.applyMusicState('shift');
    });

    on('shift:timeWarning', ({ remaining }) => {
      this.timePressure = clamp01(1 - remaining / 20);
      this.sfx?.play('countdownTick', {
        volume: 0.45 + this.timePressure * 0.4,
        pitch: 0.95 + this.timePressure * 0.35,
      });
      if (remaining <= 15 && this.gameState === 'playing') this.applyMusicState('urgent');
    });

    /* -------------------------------------------------------- direct audio */
    on('audio:sfx', ({ id, at, volume, pitch }) => {
      this.playSfx(id, at, volume ?? 1, pitch ?? 1);
    });

    on('audio:music', ({ intensity }) => {
      this.setMusicIntensity(intensity);
    });

    /* ----------------------------------------------------------- weather */
    on('weather:changed', ({ kind }) => {
      this.weather = kind;
      this.ambience?.setWeather(kind);
      if (kind === 'storm') this.duckMusic(0.12, 0.4);
    });

    /* ---------------------------------------------------------------- ui */
    on('ui:notice', ({ big }) => {
      this.sfx?.play(big ? 'uiConfirm' : 'uiMove', { volume: big ? 0.55 : 0.3 });
    });
  }

  private now(): number {
    return this.ctxAudio ? this.ctxAudio.currentTime : 0;
  }

  /** Current weather, exposed for debug overlays. */
  get currentWeather(): WeatherKind {
    return this.weather;
  }
}
