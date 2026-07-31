import * as THREE from 'three';
import { CONFIG, QUALITY_BUDGET } from './Config';
import { EventBus } from './EventBus';
import { RNG } from './RNG';
import { clamp } from './MathUtils';
import type { GameContext, QualityTier, SettingsState, System } from './types';

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
    for (const s of this.systems) await s.init?.(this.ctx);
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

    if (!this._paused) {
      this.elapsed += dt;
      ctx.elapsed = this.elapsed;

      /* ---- fixed steps ---- */
      const fixed = ctx.fixedDt;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= fixed && steps < CONFIG.maxSubSteps) {
        for (const s of this.systems) s.fixedUpdate?.(ctx, fixed);
        this.accumulator -= fixed;
        steps++;
      }
      // Bail out of a death spiral rather than falling further behind.
      if (steps === CONFIG.maxSubSteps) this.accumulator = 0;

      for (const s of this.systems) s.update?.(ctx, dt);
    }

    // lateUpdate always runs — the camera and HUD must keep working while paused.
    for (const s of this.systems) s.lateUpdate?.(ctx, this._paused ? 0 : dt);

    if (this.renderHook) this.renderHook(dt);
    else this.renderer.render(this.scene, this.camera);
  };

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
