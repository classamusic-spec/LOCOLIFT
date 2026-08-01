/**
 * Loco Lift — post-processing pipeline.
 *
 * The §6.3 chain, in order, with quality gating:
 *
 * ```
 * RenderPass -> GodRays -> SceneFX -> Bloom -> SpeedFX -> Grade -> AA -> CAS
 *   (linear HDR .................................)   (display ...............)
 *                 |            |
 *                 |            +-- AO, contact shadows, aerial perspective,
 *                 |                heat shimmer, shaft composite (one pass)
 *                 +-- quarter-res, offscreen, does not touch the chain
 * ```
 *
 * Design notes an implementer needs:
 *
 * - **Two full-screen passes carry nine effects.** `SceneFX` folds AO, contact
 *   shadows, aerial perspective, shimmer and the shaft composite together, and
 *   `Grade` folds aberration, exposure, split-tone, contrast, ACES, lift,
 *   saturation, vignette, grain and the two hit transients together. Each of
 *   those is a depth lookup or a per-pixel curve; running them as nine separate
 *   passes would cost nine round trips of bandwidth for identical pixels.
 *
 * - **The composer's colour targets each carry a `DepthTexture`**, so AO,
 *   contact shadows, aerial perspective and the shafts all reconstruct
 *   view-space position from the depth the scene render already wrote. Versus
 *   `SSAOPass`/`GTAOPass`, which re-render the whole scene into a normal buffer
 *   and would double the draw-call budget.
 *
 * - **Tone mapping happens inside the grade**, not via `OutputPass`, so the
 *   grade can work in linear before the curve and in display space after.
 *   Nothing in this file or its dependencies includes
 *   `tonemapping_pars_fragment` or `colorspace_pars_fragment` — three injects
 *   both into every `ShaderMaterial` and a second copy fails to link. Three
 *   only applies tone mapping when the destination is the canvas *and* the
 *   shader includes the apply chunk, and no pass here does, so the grade's
 *   output reaches the framebuffer untouched.
 *
 * - **Bloom is thresholded in display space.** `POST_STATE.bloomThreshold`
 *   arrives already converted from the authored display value through the
 *   inverse ACES curve and divided by exposure. Thresholding the raw linear
 *   buffer at the §6.3 value of 0.85 blooms every sunlit stucco wall in the
 *   district; this way only pixels that will actually reach 0.85 *on screen*
 *   — the sun disc, lamp globes, emissives, wet specular — get through.
 *
 * - Per-time-of-day exposure/bloom/atmosphere come from `POST_STATE`, which
 *   `Lighting` writes. That keeps the `main.ts` wiring to one `setRenderHook`
 *   call and means the composer tracks the clock with no explicit plumbing.
 *
 * WIRING (this class is inert until `main.ts` installs it):
 *
 * ```ts
 * const pipeline = new RenderPipeline(
 *   engine.renderer, engine.scene, engine.camera, settingsStore.current, engine.bus,
 * );
 * pipeline.setSpeedSource(() => camera);   // the ChaseCamera instance
 * engine.add(pipeline);                    // System: quality changes + dispose
 * engine.setRenderHook((dt) => pipeline.render(dt));
 * ```
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { QUALITY_BUDGET } from '../core/Config';
import type { EventBus } from '../core/EventBus';
import { clamp01 } from '../core/MathUtils';
import type { GameContext, QualityTier, SettingsState, System } from '../core/types';
import { GodRays } from './GodRays';
import { POST_STATE } from './LightingPresets';
import { CAS_SHADER, GRADE_SHADER, SCENE_FX_SHADER, ScreenFX } from './PostEffects';
import { SPEED_SAMPLES, SPEED_SHADER, SpeedDrive } from './SpeedFX';

/* ------------------------------------------------------------ godray pass */

/**
 * Runs the offscreen shaft build in the right place in the chain: after the
 * scene render (so depth and colour are current) and before `SceneFX` (which
 * composites the result). `needsSwap = false` — it writes to its own target and
 * leaves the composer's buffers exactly as it found them.
 */
class GodRayPass extends Pass {
  constructor(
    private rays: GodRays,
    private cam: THREE.PerspectiveCamera,
    private timeRef: { value: number },
  ) {
    super();
    this.needsSwap = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const depth = readBuffer.depthTexture;
    if (!depth) return;
    this.rays.render(
      renderer,
      this.cam,
      readBuffer.texture,
      depth,
      POST_STATE.sunDir,
      POST_STATE.sunColor,
      POST_STATE.godRays,
      this.timeRef.value,
    );
  }

  setSize(): void {
    /* the pipeline sizes `GodRays` directly; the composer must not */
  }
}

/* --------------------------------------------------------------- pipeline */

export interface SpeedSource {
  /** 0..1 radial blur / aberration drive, e.g. `ChaseCamera.speedBlurAmount` */
  speedBlurAmount: number;
  /** 0..1 lens kick, e.g. `ChaseCamera.fovKick` */
  fovKick: number;
}

export class RenderPipeline implements System {
  readonly name = 'renderPipeline';
  readonly composer: EffectComposer;
  /** Impact flashes, damage vignette, boost. Exposed so gameplay can punch it. */
  readonly screenFX: ScreenFX;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private quality: QualityTier;
  private settings: SettingsState;

  private renderPass: RenderPass;
  private godRays: GodRays;
  private godRayPass: GodRayPass;
  private sceneFxPass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private speedPass: ShaderPass;
  private gradePass: ShaderPass;
  private smaaPass: SMAAPass;
  private fxaaPass: ShaderPass;
  private casPass: ShaderPass;

  private rtA: THREE.WebGLRenderTarget;

  private speedDrive = new SpeedDrive();
  private _speedAmount = 0;
  private speedSource: (() => SpeedSource) | null = null;

  private width = 1;
  private height = 1;
  private timeRef = { value: 0 };
  private enabled = true;
  private disposed = false;

  private readonly sunView = new THREE.Vector3();
  private readonly sizeProbe = new THREE.Vector2();
  private lastDpr = 1;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    settings: SettingsState,
    bus?: EventBus,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;
    this.quality = settings.quality;
    this.screenFX = new ScreenFX(settings, bus);

    const depth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.rtA = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.rtA.texture.name = 'loco/postA';

    this.composer = new EffectComposer(renderer, this.rtA);
    this.composer.renderTarget2.texture.name = 'loco/postB';
    // the clone brings its own DepthTexture across; make sure of it, because the
    // composer alternates which target the scene render lands in
    if (!this.composer.renderTarget2.depthTexture) {
      const d2 = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
      d2.format = THREE.DepthFormat;
      d2.minFilter = THREE.NearestFilter;
      d2.magFilter = THREE.NearestFilter;
      this.composer.renderTarget2.depthTexture = d2;
    }

    this.godRays = new GodRays(this.quality);
    this.renderPass = new RenderPass(scene, camera);
    this.godRayPass = new GodRayPass(this.godRays, camera, this.timeRef);
    this.sceneFxPass = new ShaderPass(SCENE_FX_SHADER);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.4, 0.55, 1.2);
    this.speedPass = new ShaderPass(SPEED_SHADER);
    this.gradePass = new ShaderPass(GRADE_SHADER);
    this.smaaPass = new SMAAPass();
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.casPass = new ShaderPass(CAS_SHADER);

    // nothing here writes a tone-mapped result but the grade, and it does its
    // own ACES and sRGB encode; keep three's automatic path out of it entirely
    for (const p of [
      this.sceneFxPass,
      this.speedPass,
      this.gradePass,
      this.fxaaPass,
      this.casPass,
    ]) {
      (p.material as THREE.ShaderMaterial).toneMapped = false;
    }

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.godRayPass);
    this.composer.addPass(this.sceneFxPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.speedPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.smaaPass);
    this.composer.addPass(this.fxaaPass);
    this.composer.addPass(this.casPass);

    this.applyQuality();
    renderer.getSize(this.sizeProbe);
    this.setSize(this.sizeProbe.x, this.sizeProbe.y);

    /* QA hook, mirroring `window.__loco`. The harness needs to A/B the chain
     * at runtime — measuring the post cost by rebuilding twice measures the
     * rest of the district drifting under it as well. */
    if (typeof window !== 'undefined') {
      (window as unknown as { __locoFx?: RenderPipeline }).__locoFx = this;
    }
  }

  /**
   * QA/debug: force the whole chain off (`false`) or back to whatever the
   * current tier and settings allow (`true`). Not a settings path — the
   * settings path is `postProcessing`, which `applyQuality` reads.
   */
  setEnabledForTest(on: boolean): void {
    if (on) {
      this.applyQuality();
    } else {
      this.enabled = false;
      for (const p of this.composer.passes) p.enabled = false;
    }
  }

  /* ---------------------------------------------------------------- setup */

  /**
   * Pull the speed drive straight off the chase camera each frame.
   * `pipeline.setSpeedSource(() => camera)` is all the wiring it needs.
   */
  setSpeedSource(fn: (() => SpeedSource) | null): void {
    this.speedSource = fn;
  }

  /** 0..1. Ignored while a speed source is installed. */
  set speedAmount(v: number) {
    this._speedAmount = clamp01(v);
  }

  get speedAmount(): number {
    return this._speedAmount;
  }

  /** True when the composer is doing the work; false = plain forward render. */
  get active(): boolean {
    return this.enabled;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const dpr = this.renderer.getPixelRatio();
    this.lastDpr = dpr;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(this.width, this.height);

    const bw = Math.max(1, Math.round(this.width * dpr));
    const bh = Math.max(1, Math.round(this.height * dpr));
    (this.sceneFxPass.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);
    (this.casPass.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);
    (this.fxaaPass.uniforms.resolution.value as THREE.Vector2).set(1 / bw, 1 / bh);
    const aspect = bw / bh;
    this.sceneFxPass.uniforms.uAspect.value = aspect;
    this.speedPass.uniforms.uAspect.value = aspect;
    this.gradePass.uniforms.uAspect.value = aspect;
    this.godRays.setSize(bw, bh);
  }

  /** `System` hook — the engine calls this on any settings or tier change. */
  onQualityChange(tier: QualityTier, settings: SettingsState): void {
    this.setQuality(tier, settings);
  }

  setQuality(tier: QualityTier, settings?: SettingsState): void {
    this.quality = tier;
    if (settings) {
      this.settings = settings;
      this.screenFX.setSettings(settings);
    }
    this.godRays.onQualityChange(tier);
    this.applyQuality();
    this.setSize(this.width, this.height);
  }

  private applyQuality(): void {
    const s = this.settings;
    const tier = this.quality;

    // §6.3 / QUALITY_PRESETS: post is off entirely on low (phones).
    this.enabled = tier !== 'low' && s.postProcessing !== false;
    const heavy = tier === 'high' || tier === 'ultra';

    const wantAO = this.enabled && s.ssao !== false && heavy;
    const wantContact = this.enabled && s.shadows !== false && heavy;
    const wantAerial = this.enabled;
    const wantShimmer = this.enabled && heavy;
    const wantRays = this.enabled && heavy;

    /* One material, five feature switches. Recompiling on a settings change is
     * fine; recompiling per frame would not be, which is why none of these are
     * driven by a runtime value. */
    const defines: Record<string, string> = {};
    if (wantAO) defines.LOCO_AO = '1';
    if (wantContact) defines.LOCO_CONTACT = '1';
    if (wantAerial) defines.LOCO_AERIAL = '1';
    if (wantShimmer) defines.LOCO_SHIMMER = '1';
    if (wantRays) defines.LOCO_GODRAYS = '1';
    const mat = this.sceneFxPass.material as THREE.ShaderMaterial;
    const prev = Object.keys(mat.defines ?? {}).sort().join(',');
    const next = Object.keys(defines).sort().join(',');
    if (prev !== next) {
      mat.defines = defines;
      mat.needsUpdate = true;
    }

    this.sceneFxPass.enabled = this.enabled && next.length > 0;
    this.godRayPass.enabled = wantRays;
    this.bloomPass.enabled = this.enabled && s.bloom !== false;
    this.speedPass.enabled = this.enabled && s.motionBlur !== false && SPEED_SAMPLES[tier] > 0;
    this.gradePass.enabled = this.enabled;
    // SMAA on high/ultra, FXAA on medium — never both.
    this.smaaPass.enabled = this.enabled && heavy;
    this.fxaaPass.enabled = this.enabled && tier === 'medium';
    this.casPass.enabled = this.enabled && (tier === 'ultra' || s.renderScale < 0.98);
    this.renderPass.enabled = this.enabled;

    const speedMat = this.speedPass.material as THREE.ShaderMaterial;
    const taps = String(Math.max(2, SPEED_SAMPLES[tier]));
    if (speedMat.defines.LOCO_SPEED_SAMPLES !== taps) {
      speedMat.defines.LOCO_SPEED_SAMPLES = taps;
      speedMat.needsUpdate = true;
    }

    this.sceneFxPass.uniforms.uFarRef.value = QUALITY_BUDGET[tier].drawDistance;
    this.bloomPass.radius = POST_STATE.bloomRadius;
    this.casPass.uniforms.uSharpness.value = tier === 'ultra' ? 0.35 : 0.28;
  }

  /* --------------------------------------------------------------- render */

  render(dt: number): void {
    if (this.disposed) return;

    // the engine owns the canvas resize; notice it here rather than adding a
    // second window listener whose ordering against the engine's is undefined
    this.renderer.getSize(this.sizeProbe);
    const dpr = this.renderer.getPixelRatio();
    if (
      Math.abs(this.sizeProbe.x - this.width) > 0.5 ||
      Math.abs(this.sizeProbe.y - this.height) > 0.5 ||
      Math.abs(dpr - this.lastDpr) > 1e-3
    ) {
      this.setSize(this.sizeProbe.x, this.sizeProbe.y);
    }

    const step = Math.min(Math.max(dt, 0), 0.1);
    this.timeRef.value = (this.timeRef.value + step) % 1000;

    /* — drives — */
    const src = this.speedSource?.();
    if (src) this._speedAmount = clamp01(src.speedBlurAmount * 0.72 + src.fovKick * 0.38);
    const speed = this.speedDrive.update(this._speedAmount, step);
    this.screenFX.update(step, speed);

    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const fx = this.screenFX.state;
    const time = this.timeRef.value;

    /* — SceneFX — */
    if (this.sceneFxPass.enabled) {
      const u = this.sceneFxPass.uniforms;
      const depthTex = this.composer.readBuffer.depthTexture;
      u.tDepth.value = depthTex ?? null;
      (u.uProjection.value as THREE.Matrix4).copy(this.camera.projectionMatrix);
      (u.uProjectionInverse.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
      u.uTime.value = time;

      // sun in view space, for contact shadows and the aerial in-scatter
      this.sunView.copy(POST_STATE.sunDir).transformDirection(this.camera.matrixWorldInverse);
      (u.uSunView.value as THREE.Vector3).copy(this.sunView);

      // contact shadows only mean anything under a directional key
      u.uContact.value = 0.55 * clamp01(POST_STATE.dayFactor * 1.4) * (1 - POST_STATE.wet * 0.4);
      (u.uAerialColor.value as THREE.Color).copy(POST_STATE.aerialColor);
      u.uAerialStrength.value = POST_STATE.aerialStrength;
      // heat off the cobbles: solar noon, dry, and pulled back under boost
      // where it would read as a rendering fault rather than as air
      u.uShimmer.value = POST_STATE.shimmer * (1 - POST_STATE.wet) * (1 - fx.boost * 0.6);

      const rayTex = this.godRays.texture;
      u.tGodRays.value = rayTex;
      u.uGodRays.value = rayTex ? 1 : 0;
      if (!depthTex) this.sceneFxPass.enabled = false;
    }

    /* — bloom — */
    if (this.bloomPass.enabled) {
      this.bloomPass.strength = POST_STATE.bloomStrength * (1 + fx.boost * 0.35);
      this.bloomPass.threshold = POST_STATE.bloomThreshold;
      this.bloomPass.radius = POST_STATE.bloomRadius;
      // `highPassUniforms` is typed as a bare object upstream; the knee is the
      // only reason bloom fades in over a stop instead of switching on
      const knee = (this.bloomPass.highPassUniforms as Record<string, THREE.IUniform>).smoothWidth;
      if (knee) knee.value = POST_STATE.bloomKnee;
    }

    /* — speed / boost — */
    if (this.speedPass.enabled) {
      const u = this.speedPass.uniforms;
      u.uAmount.value = speed;
      u.uBoost.value = fx.boost;
      u.uPunch.value = fx.boostPunch * clamp01(this.settings.screenShake ?? 1);
      u.uSafety.value = this.screenFX.safetyScale;
      u.uTime.value = time;
    }

    /* — grade — */
    const g = this.gradePass.uniforms;
    g.uExposure.value = POST_STATE.exposure;
    (g.uShadowTint.value as THREE.Color).copy(POST_STATE.shadowTint);
    (g.uHighlightTint.value as THREE.Color).copy(POST_STATE.highlightTint);
    (g.uLiftColor.value as THREE.Color).copy(POST_STATE.liftColor);
    g.uLift.value = POST_STATE.lift;
    // wet streets carry more specular; a touch more saturation stops them
    // reading as grey slush
    g.uSaturation.value = POST_STATE.saturation + POST_STATE.wet * 0.05;
    g.uContrast.value = POST_STATE.contrast;
    // Weather owns the 0.22 base and the storm ramp; this adds the per-hour
    // boost and a little more as the lens is pushed
    g.uVignette.value =
      POST_STATE.vignette + POST_STATE.vignetteBoost + speed * 0.05 + fx.boost * 0.06;
    g.uGrain.value = POST_STATE.grain;
    g.uChroma.value = POST_STATE.chroma * (0.35 + speed * 1.4);
    g.uFlash.value = POST_STATE.flash;
    g.uImpact.value = fx.impact;
    g.uHit.value = fx.hit;
    g.uBoost.value = fx.boost * this.screenFX.safetyScale;
    g.uTime.value = time;

    this.composer.render(step);
  }

  /* -------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.screenFX.dispose();
    this.godRays.dispose();
    this.renderPass.dispose?.();
    this.sceneFxPass.dispose?.();
    this.bloomPass.dispose?.();
    this.speedPass.dispose?.();
    this.gradePass.dispose?.();
    this.smaaPass.dispose?.();
    this.fxaaPass.dispose?.();
    this.casPass.dispose?.();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
  }

  /** `System` hook. The render itself is driven by `Engine.setRenderHook`. */
  update(_ctx: GameContext, _dt: number): void {
    /* nothing per tick; the render hook does the work */
  }

  /** Numbers the QA harness wants. */
  stats(): Record<string, number> {
    return {
      postEnabled: this.enabled ? 1 : 0,
      passes: this.composer.passes.filter((p) => p.enabled).length,
      sceneFx: this.sceneFxPass.enabled ? 1 : 0,
      godRays: this.godRays.active ? 1 : 0,
      bloom: this.bloomPass.enabled ? 1 : 0,
      bloomStrength: Number(POST_STATE.bloomStrength.toFixed(3)),
      bloomThreshold: Number(POST_STATE.bloomThreshold.toFixed(3)),
      exposure: Number(POST_STATE.exposure.toFixed(3)),
      speedAmount: Number(this.speedDrive.amount.toFixed(3)),
      boost: Number(this.screenFX.state.boost.toFixed(3)),
      impact: Number(this.screenFX.state.impact.toFixed(3)),
      smaa: this.smaaPass.enabled ? 1 : 0,
      cas: this.casPass.enabled ? 1 : 0,
    };
  }
}
