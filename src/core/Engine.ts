import * as THREE from 'three';
import { CONFIG, QUALITY_BUDGET } from './Config';
import { EventBus } from './EventBus';
import { RNG } from './RNG';
import { clamp } from './MathUtils';
import type { GameContext, QualityTier, SettingsState, System } from './types';

/** Add `ms` to `key`'s running total. Hoisted so the hot path stays flat. */
function accum(map: Map<string, number>, key: string, ms: number): void {
  map.set(key, (map.get(key) ?? 0) + ms);
}

export interface PerfSample {
  fps: number;
  /** 1% low fps — the number that actually reveals stutter */
  p1: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
}

/**
 * Owns the renderer, the clock and the fixed-timestep loop, and drives every
 * registered System. Rendering itself is delegated: if a system registers as
 * the renderer hook (the post-processing pipeline), the engine calls that
 * instead of renderer.render().
 */
export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly bus = new EventBus();
  readonly rng: RNG;
  readonly canvas: HTMLCanvasElement;

  private systems: System[] = [];
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** swapped in by the post-processing pipeline */
  private renderHook: ((dt: number) => void) | null = null;

  /**
   * Runs once per frame before the fixed-step loop. Input must be sampled here:
   * polling it per fixed step would read the same edge-triggered press several
   * times in one frame.
   */
  private preFrameHook: ((dt: number) => void) | null = null;

  /** rolling frame-time ring buffer for perf stats */
  private frameTimes = new Float32Array(180);
  private frameCursor = 0;
  private frameCount = 0;

  /**
   * Per-system CPU profiling. Off by default and genuinely free when off: the
   * hot loops branch on one boolean and never call `performance.now()`.
   *
   * This exists because "the game is choppy" is not actionable. Frame time
   * tells you *that* a frame was slow; only a per-system breakdown tells you
   * *which* system spent it, and whether it went to `fixedUpdate` (which runs
   * up to `maxSubSteps` times per frame, so its cost rises as the frame rate
   * falls) or to `update`/`lateUpdate` (once per frame). Those two profiles
   * call for opposite fixes, and guessing between them wastes the pass.
   */
  private profiling = false;
  private profFixed = new Map<string, number>();
  private profUpdate = new Map<string, number>();
  private profLate = new Map<string, number>();
  private profFrames = 0;
  private profSubSteps = 0;
  private profRenderMs = 0;

  private ctx: GameContext;
  private settings: SettingsState;
  private _paused = false;
  private _timeOfDay = 12;
  private elapsed = 0;

  constructor(canvas: HTMLCanvasElement, settings: SettingsState) {
    this.canvas = canvas;
    this.settings = settings;
    this.rng = new RNG(CONFIG.worldSeed);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
      // the composer owns depth; keeping the default buffer lean helps mobile
      alpha: false,
    });
    this.renderer.setClearColor(0x0b1d2a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      1,
      CONFIG.camera.near,
      CONFIG.camera.far,
    );
    this.camera.position.set(0, 6, 14);

    this.ctx = {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      bus: this.bus,
      input: null as never, // wired by main before the first tick
      settings,
      rng: this.rng,
      elapsed: 0,
      dt: 0,
      rawDt: 0,
      fixedDt: 1 / CONFIG.fixedHz,
      paused: false,
      timeOfDay: 12,
    };

    this.applyQuality(settings.quality);
    this.resize();
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get context(): GameContext {
    return this.ctx;
  }

  get paused(): boolean {
    return this._paused;
  }

  set paused(v: boolean) {
    this._paused = v;
    this.ctx.paused = v;
  }

  get timeOfDay(): number {
    return this._timeOfDay;
  }

  set timeOfDay(h: number) {
    this._timeOfDay = ((h % 24) + 24) % 24;
    this.ctx.timeOfDay = this._timeOfDay;
  }

  /** Systems tick in registration order. Register foundations first. */
  add(system: System): void {
    this.systems.push(system);
  }

  remove(system: System): void {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  get<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  setRenderHook(fn: ((dt: number) => void) | null): void {
    this.renderHook = fn;
  }

  setPreFrameHook(fn: ((dt: number) => void) | null): void {
    this.preFrameHook = fn;
  }

  setInput(input: GameContext['input']): void {
    this.ctx.input = input;
  }

  applySettings(settings: SettingsState): void {
    this.settings = settings;
    this.ctx.settings = settings;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.applyQuality(settings.quality);
    this.resize();
    for (const s of this.systems) s.onQualityChange?.(settings.quality, settings);
    this.bus.emit('game:settingsChanged', { settings });
  }

  private applyQuality(tier: QualityTier): void {
    const budget = QUALITY_BUDGET[tier];
    this.renderer.shadowMap.type =
      tier === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.camera.far = Math.max(600, budget.drawDistance * 1.6);
    this.camera.updateProjectionMatrix();
  }

  resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // cap DPR — a retina phone at dpr 3 will not hold 60fps with this scene
    const maxDpr = this.settings.quality === 'low' ? 1 : this.settings.quality === 'ultra' ? 2 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * clamp(this.settings.renderScale, 0.5, 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  private onVisibility = (): void => {
    // Coming back from a hidden tab produces an enormous delta; drop it.
    if (!document.hidden) this.lastTime = performance.now();
  };

  async initSystems(): Promise<void> {
    for (const s of this.systems) {
      // Logged *before* the call: an init that never returns is otherwise
      // invisible, since a completion-only log prints nothing for the one
      // system that matters.
      console.info(`[boot] init -> ${s.name}`);
      const t0 = performance.now();
      await s.init?.(this.ctx);
      console.info(`[boot] init ok ${s.name}: ${Math.round(performance.now() - t0)}ms`);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const rawDt = Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.frameTimes[this.frameCursor] = rawDt * 1000;
    this.frameCursor = (this.frameCursor + 1) % this.frameTimes.length;
    this.frameCount++;

    const dt = Math.min(rawDt, CONFIG.maxFrameDelta);
    const ctx = this.ctx;
    ctx.rawDt = rawDt;
    ctx.dt = this._paused ? 0 : dt;
    ctx.timeOfDay = this._timeOfDay;

    this.renderer.info.reset();

    // Sampled before the fixed loop so edge-triggered presses fire exactly once.
    this.preFrameHook?.(dt);

    const prof = this.profiling;
    if (prof) this.profFrames++;

    if (!this._paused) {
      this.elapsed += dt;
      ctx.elapsed = this.elapsed;

      /* ---- fixed steps ---- */
      const fixed = ctx.fixedDt;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= fixed && steps < CONFIG.maxSubSteps) {
        if (prof) {
          for (const s of this.systems) {
            if (!s.fixedUpdate) continue;
            const t0 = performance.now();
            s.fixedUpdate(ctx, fixed);
            accum(this.profFixed, s.name, performance.now() - t0);
          }
        } else {
          for (const s of this.systems) s.fixedUpdate?.(ctx, fixed);
        }
        this.accumulator -= fixed;
        steps++;
      }
      // Bail out of a death spiral rather than falling further behind.
      if (steps === CONFIG.maxSubSteps) this.accumulator = 0;
      if (prof) this.profSubSteps += steps;

      if (prof) {
        for (const s of this.systems) {
          if (!s.update) continue;
          const t0 = performance.now();
          s.update(ctx, dt);
          accum(this.profUpdate, s.name, performance.now() - t0);
        }
      } else {
        for (const s of this.systems) s.update?.(ctx, dt);
      }
    }

    // lateUpdate always runs — the camera and HUD must keep working while paused.
    const lateDt = this._paused ? 0 : dt;
    if (prof) {
      for (const s of this.systems) {
        if (!s.lateUpdate) continue;
        const t0 = performance.now();
        s.lateUpdate(ctx, lateDt);
        accum(this.profLate, s.name, performance.now() - t0);
      }
    } else {
      for (const s of this.systems) s.lateUpdate?.(ctx, lateDt);
    }

    if (prof) {
      const t0 = performance.now();
      if (this.renderHook) this.renderHook(dt);
      else this.renderer.render(this.scene, this.camera);
      this.profRenderMs += performance.now() - t0;
    } else if (this.renderHook) {
      this.renderHook(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  };

  /**
   * QA only: advance the simulation `frames` times in game-time, ignoring the
   * wall clock and skipping render.
   *
   * The headless capture rig renders through SwiftShader at roughly one frame a
   * second, and the fixed-step accumulator clamps a frame to `maxFrameDelta`
   * (1/15 s) — so real-time drive tests advance sim-time at about 1/15 speed and
   * a car appears never to move. This runs the same per-frame body the RAF loop
   * runs (input sample, fixed substeps, update, lateUpdate) at a fixed
   * `maxFrameDelta` dt each, so a few hundred calls cover several seconds of
   * driving deterministically. It never renders and does nothing while paused.
   */
  advanceSimForTest(frames: number): void {
    if (this._paused) return;
    const ctx = this.ctx;
    const fixed = ctx.fixedDt;
    // A realistic per-frame dt (60 Hz), NOT maxFrameDelta: the physics is in
    // fixedUpdate either way, but steering smoothing, camera and other
    // per-frame `update` logic misbehave at a 1/15 s step, so a coarse dt makes
    // the car veer and oscillate. 60 Hz makes a sim-frame behave like a real one.
    const dt = 1 / 60;
    for (let f = 0; f < frames; f++) {
      ctx.rawDt = dt;
      ctx.dt = dt;
      ctx.timeOfDay = this._timeOfDay;
      this.preFrameHook?.(dt);
      this.elapsed += dt;
      ctx.elapsed = this.elapsed;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= fixed && steps < CONFIG.maxSubSteps) {
        for (const s of this.systems) s.fixedUpdate?.(ctx, fixed);
        this.accumulator -= fixed;
        steps++;
      }
      if (steps === CONFIG.maxSubSteps) this.accumulator = 0;
      for (const s of this.systems) s.update?.(ctx, dt);
      for (const s of this.systems) s.lateUpdate?.(ctx, dt);
    }
  }

  /* ------------------------------------------------------------ profiling */

  /** Begin (or restart) a per-system CPU profile. */
  profileStart(): void {
    this.profFixed.clear();
    this.profUpdate.clear();
    this.profLate.clear();
    this.profFrames = 0;
    this.profSubSteps = 0;
    this.profRenderMs = 0;
    this.profiling = true;
  }

  /**
   * Stop profiling and return per-frame averages in milliseconds.
   *
   * `fixedMs` is the cost *per frame*, already summed over however many
   * sub-steps that frame ran — that is the number that matters, because a
   * system whose `fixedUpdate` costs 0.4 ms costs 3.2 ms per frame once the
   * frame rate has fallen far enough to demand eight sub-steps. `subStepsPerFrame`
   * is reported alongside so the two can be told apart.
   *
   * `renderMs` is CPU time spent inside the render hook — command submission and
   * post-chain setup, not GPU execution. A browser cannot measure GPU time
   * without `EXT_disjoint_timer_query_webgl2`, so treat a small `renderMs` on a
   * slow frame as evidence the cost is on the GPU, not as evidence of health.
   */
  profileStop(): {
    frames: number;
    subStepsPerFrame: number;
    renderMs: number;
    fixed: Array<{ name: string; ms: number }>;
    update: Array<{ name: string; ms: number }>;
    late: Array<{ name: string; ms: number }>;
    totalMs: number;
  } {
    this.profiling = false;
    const n = Math.max(1, this.profFrames);
    const per = (m: Map<string, number>): Array<{ name: string; ms: number }> =>
      [...m.entries()]
        .map(([name, ms]) => ({ name, ms: Number((ms / n).toFixed(3)) }))
        .sort((a, b) => b.ms - a.ms);
    const fixed = per(this.profFixed);
    const update = per(this.profUpdate);
    const late = per(this.profLate);
    const sum = (a: Array<{ ms: number }>): number => a.reduce((t, x) => t + x.ms, 0);
    const renderMs = Number((this.profRenderMs / n).toFixed(3));
    return {
      frames: this.profFrames,
      subStepsPerFrame: Number((this.profSubSteps / n).toFixed(2)),
      renderMs,
      fixed,
      update,
      late,
      totalMs: Number((sum(fixed) + sum(update) + sum(late) + renderMs).toFixed(3)),
    };
  }

  /** Average + 1% low over the last `ms` of frames. */
  async perfSample(ms: number): Promise<PerfSample> {
    const startFrame = this.frameCount;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    const captured = Math.min(this.frameCount - startFrame, this.frameTimes.length);
    const times: number[] = [];
    for (let i = 0; i < captured; i++) {
      const idx = (this.frameCursor - 1 - i + this.frameTimes.length * 2) % this.frameTimes.length;
      const v = this.frameTimes[idx];
      if (v > 0) times.push(v);
    }
    if (times.length === 0) {
      return { fps: 0, p1: 0, frameMs: 0, drawCalls: 0, triangles: 0, programs: 0 };
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const sorted = times.slice().sort((a, b) => b - a);
    const p1Idx = Math.max(0, Math.floor(sorted.length * 0.01));
    const info = this.renderer.info;
    return {
      fps: Math.round(1000 / avg),
      p1: Math.round(1000 / sorted[p1Idx]),
      frameMs: Number(avg.toFixed(2)),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
    };
  }

  stats(): Record<string, number> {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      systems: this.systems.length,
      elapsed: Number(this.elapsed.toFixed(1)),
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const s of this.systems) s.dispose?.();
    this.systems = [];
    this.bus.clear();
    this.renderer.dispose();
  }
}
