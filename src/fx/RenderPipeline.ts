/**
 * Loco Lift — post-processing pipeline.
 *
 * The §6.3 chain, in order, with quality gating:
 *
 * ```
 * RenderPass  ->  AO  ->  Bloom  ->  radial speed blur  ->  grade  ->  AA  ->  CAS
 *   (linear HDR ......................................)   (sRGB ...............)
 * ```
 *
 * `grade` is one pass that does chromatic aberration, exposure, the Caribbean
 * split-tone, ACES, the shadow lift, saturation, vignette and grain, because
 * every one of those is a per-pixel curve and splitting them into six
 * full-screen passes would cost six round trips for no visual gain.
 *
 * Notes:
 *
 * - The composer's two colour targets each carry a `DepthTexture`, so the AO
 *   pass reconstructs view-space position and normals from the depth the scene
 *   render already wrote. That is one extra full-screen pass, versus `SSAOPass`
 *   / `GTAOPass` which re-render the whole scene into a normal buffer and would
 *   double the draw-call budget.
 * - Tone mapping happens **inside** the grade pass, not via `OutputPass`, so
 *   the grade can work in linear before the curve and in display space after.
 *   Nothing in this file includes `tonemapping_pars_fragment` or
 *   `colorspace_pars_fragment` — three injects both into every `ShaderMaterial`
 *   and a second copy fails to link.
 * - Per-time-of-day exposure/bloom come from `POST_STATE`, which `Lighting`
 *   writes. That keeps the `main.ts` wiring down to a single `setRenderHook`
 *   call and means the composer tracks the clock with no explicit plumbing.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { clamp, clamp01, damp } from '../core/MathUtils';
import type { QualityTier, SettingsState } from '../core/types';
import { POST_STATE } from './LightingPresets';

/* ------------------------------------------------------------ shared glsl */

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/* ------------------------------------------------------------------- SSAO */

/**
 * Depth-only hemisphere AO. Radius 0.55 m, 12 samples, bias 0.02 (§6.3.1).
 * Normals are reconstructed from the closest depth neighbours rather than from
 * derivatives so a silhouette edge does not produce a bogus normal (and a black
 * halo) around every balcony.
 */
const AO_SHADER = {
  name: 'LocoAO',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uProjectionInverse: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
    uRadius: { value: 0.55 },
    uIntensity: { value: 0.9 },
    uBias: { value: 0.02 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform mat4 uProjection;
  uniform mat4 uProjectionInverse;
  uniform vec2 uTexel;
  uniform float uRadius;
  uniform float uIntensity;
  uniform float uBias;
  varying vec2 vUv;

  const int LOCO_AO_SAMPLES = 12;

  float locoDepth( vec2 uv ) { return texture2D( tDepth, uv ).x; }

  vec3 locoView( vec2 uv, float d ) {
    vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    vec4 v = uProjectionInverse * clip;
    return v.xyz / v.w;
  }

  void main() {
    vec4 src = texture2D( tDiffuse, vUv );
    float d = locoDepth( vUv );
    if ( d >= 0.99999 ) { gl_FragColor = src; return; }

    vec3 p = locoView( vUv, d );

    /* normal from the nearer of each opposing neighbour pair */
    vec3 l = locoView( vUv - vec2( uTexel.x, 0.0 ), locoDepth( vUv - vec2( uTexel.x, 0.0 ) ) );
    vec3 r = locoView( vUv + vec2( uTexel.x, 0.0 ), locoDepth( vUv + vec2( uTexel.x, 0.0 ) ) );
    vec3 b = locoView( vUv - vec2( 0.0, uTexel.y ), locoDepth( vUv - vec2( 0.0, uTexel.y ) ) );
    vec3 t = locoView( vUv + vec2( 0.0, uTexel.y ), locoDepth( vUv + vec2( 0.0, uTexel.y ) ) );
    vec3 dx = abs( l.z - p.z ) < abs( r.z - p.z ) ? ( p - l ) : ( r - p );
    vec3 dy = abs( b.z - p.z ) < abs( t.z - p.z ) ? ( p - b ) : ( t - p );
    vec3 n = cross( dx, dy );
    float nl = length( n );
    if ( nl < 1e-6 ) { gl_FragColor = src; return; }
    n /= nl;
    if ( dot( n, p ) > 0.0 ) n = -n;

    /* golden-angle spiral, rotated per pixel so the pattern does not band */
    float rot = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
    vec3 tangent = normalize( abs( n.z ) < 0.9 ? cross( n, vec3( 0.0, 0.0, 1.0 ) ) : cross( n, vec3( 1.0, 0.0, 0.0 ) ) );
    vec3 bitan = cross( n, tangent );

    float occl = 0.0;
    for ( int i = 0; i < LOCO_AO_SAMPLES; i ++ ) {
      float fi = ( float( i ) + 0.5 ) / float( LOCO_AO_SAMPLES );
      float ang = rot + float( i ) * 2.39996323;
      float rad = uRadius * sqrt( fi );
      float zh = mix( 0.28, 1.0, fi );
      vec3 dir = normalize( tangent * cos( ang ) + bitan * sin( ang ) + n * zh );
      vec3 sp = p + dir * rad;

      vec4 op = uProjection * vec4( sp, 1.0 );
      vec2 suv = op.xy / op.w * 0.5 + 0.5;
      if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;
      float sd = locoDepth( suv );
      if ( sd >= 0.99999 ) continue;
      float sceneZ = locoView( suv, sd ).z;

      float range = smoothstep( 0.0, 1.0, uRadius / max( 1e-4, abs( p.z - sceneZ ) ) );
      occl += ( sceneZ >= sp.z + uBias ? 1.0 : 0.0 ) * range;
    }

    float ao = 1.0 - ( occl / float( LOCO_AO_SAMPLES ) ) * uIntensity;
    ao = clamp( ao, 0.0, 1.0 );

    /* §6.3.1: applies to indirect only. Without a separate indirect buffer,
     * approximate it by backing the term off on surfaces the key light is
     * already hammering — a sunlit stucco wall must not get a dirt smear. */
    float lum = dot( src.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    float indirect = 1.0 - smoothstep( 0.30, 1.50, lum );
    gl_FragColor = vec4( src.rgb * mix( 1.0, ao, mix( 0.30, 1.0, indirect ) ), src.a );
  }
  `,
};

/* -------------------------------------------------------------- speed blur */

/** R10: radial blur strength 0.18 at the edge, exactly 0 inside the centre 42 %. */
const SPEED_SHADER = {
  name: 'LocoSpeedBlur',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAmount: { value: 0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uAmount;
  uniform float uAspect;
  varying vec2 vUv;

  void main() {
    vec2 d = vUv - 0.5;
    float r = clamp( length( vec2( d.x * uAspect, d.y ) ) / ( 0.5 * sqrt( uAspect * uAspect + 1.0 ) ) * 2.0, 0.0, 1.0 );
    float k = smoothstep( 0.42, 1.0, r ) * uAmount * 0.18;
    if ( k < 0.0008 ) { gl_FragColor = texture2D( tDiffuse, vUv ); return; }

    vec3 acc = vec3( 0.0 );
    float wsum = 0.0;
    for ( int i = 0; i < 8; i ++ ) {
      float f = float( i ) / 7.0;
      float w = 1.0 - f * 0.45;
      acc += texture2D( tDiffuse, vUv - d * f * k ).rgb * w;
      wsum += w;
    }
    gl_FragColor = vec4( acc / wsum, 1.0 );
  }
  `,
};

/* ------------------------------------------------------------------ grade */

const GRADE_SHADER = {
  name: 'LocoGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1 },
    uShadowTint: { value: new THREE.Color(1, 1, 1) },
    uHighlightTint: { value: new THREE.Color(1, 1, 1) },
    uLiftColor: { value: new THREE.Color(0x0e1a28) },
    uLift: { value: 0.03 },
    uSaturation: { value: 1.08 },
    uVignette: { value: 0.22 },
    uGrain: { value: 0.012 },
    uChroma: { value: 0.0012 },
    uFlash: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uExposure;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  uniform vec3 uLiftColor;
  uniform float uLift;
  uniform float uSaturation;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uChroma;
  uniform float uFlash;
  uniform float uTime;
  uniform float uAspect;
  varying vec2 vUv;

  /* ACES RRT+ODT fit — same curve three uses, under a private name so the
   * injected tonemapping_pars_fragment is never redefined. */
  const mat3 LOCO_ACES_IN = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 LOCO_ACES_OUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );

  vec3 locoRRT( vec3 v ) {
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return a / b;
  }

  vec3 locoACES( vec3 color ) {
    color *= 1.0 / 0.6;
    color = LOCO_ACES_IN * color;
    color = locoRRT( color );
    color = LOCO_ACES_OUT * color;
    return clamp( color, 0.0, 1.0 );
  }

  vec3 locoEncodeSRGB( vec3 c ) {
    c = max( c, vec3( 0.0 ) );
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055;
    return mix( lo, hi, step( vec3( 0.0031308 ), c ) );
  }

  void main() {
    vec2 d = vUv - 0.5;
    float rn = clamp( length( vec2( d.x * uAspect, d.y ) ) / ( 0.5 * sqrt( uAspect * uAspect + 1.0 ) ) * 2.0, 0.0, 1.0 );
    float edge = smoothstep( 0.42, 1.0, rn );

    /* chromatic aberration — edges only (R10) */
    vec2 ca = d * uChroma * edge * 40.0;
    vec3 col;
    col.r = texture2D( tDiffuse, vUv + ca ).r;
    col.g = texture2D( tDiffuse, vUv ).g;
    col.b = texture2D( tDiffuse, vUv - ca ).b;

    /* exposure + storm flash, still linear */
    col *= uExposure * ( 1.0 + uFlash * 1.6 );

    /* split tone: warm shadows, cool highlights, weighted by luminance */
    float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    float hi = smoothstep( 0.22, 1.6, lum );
    col *= mix( uShadowTint, uHighlightTint, hi );

    /* tone map */
    col = locoACES( col );

    /* display-space finish */
    col = locoEncodeSRGB( col );
    col += uLiftColor * uLift * ( 1.0 - smoothstep( 0.0, 0.55, dot( col, vec3( 0.333 ) ) ) );

    float g = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col = clamp( mix( vec3( g ), col, uSaturation ), 0.0, 1.0 );

    col *= 1.0 - uVignette * smoothstep( 0.35, 1.25, rn );

    float n = fract( sin( dot( vUv * vec2( 1024.0, 768.0 ) + uTime, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    col += ( n - 0.5 ) * uGrain;

    gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
  }
  `,
};

/* -------------------------------------------------------------------- CAS */

/** Contrast-adaptive unsharp, clamped to the local min/max so it cannot ring. */
const CAS_SHADER = {
  name: 'LocoCAS',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
    uSharpness: { value: 0.35 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uSharpness;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D( tDiffuse, vUv ).rgb;
    vec3 n = texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb;
    vec3 s = texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
    vec3 e = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb;
    vec3 w = texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb;

    vec3 mn = min( c, min( min( n, s ), min( e, w ) ) );
    vec3 mx = max( c, max( max( n, s ), max( e, w ) ) );
    vec3 sharp = c + ( c * 4.0 - ( n + s + e + w ) ) * uSharpness * 0.25;
    gl_FragColor = vec4( clamp( sharp, mn, mx ), 1.0 );
  }
  `,
};

/* --------------------------------------------------------------- pipeline */

export interface SpeedSource {
  /** 0..1 radial blur / aberration drive, e.g. `ChaseCamera.speedBlurAmount` */
  speedBlurAmount: number;
  /** 0..1 lens kick, e.g. `ChaseCamera.fovKick` */
  fovKick: number;
}

export class RenderPipeline {
  readonly composer: EffectComposer;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private quality: QualityTier;
  private settings: SettingsState;

  private renderPass: RenderPass;
  private aoPass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private speedPass: ShaderPass;
  private gradePass: ShaderPass;
  private smaaPass: SMAAPass;
  private fxaaPass: ShaderPass;
  private casPass: ShaderPass;

  private rtA: THREE.WebGLRenderTarget;

  private _speedAmount = 0;
  private _speedSmoothed = 0;
  private speedSource: (() => SpeedSource) | null = null;

  private width = 1;
  private height = 1;
  private time = 0;
  private enabled = true;
  private disposed = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    settings: SettingsState,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;
    this.quality = settings.quality;

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

    this.renderPass = new RenderPass(scene, camera);
    this.aoPass = new ShaderPass(AO_SHADER);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.55, 0.85);
    this.speedPass = new ShaderPass(SPEED_SHADER);
    this.gradePass = new ShaderPass(GRADE_SHADER);
    this.smaaPass = new SMAAPass();
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.casPass = new ShaderPass(CAS_SHADER);

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.aoPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.speedPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.smaaPass);
    this.composer.addPass(this.fxaaPass);
    this.composer.addPass(this.casPass);

    this.applyQuality();
    const size = renderer.getSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
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
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(this.width, this.height);

    const bw = Math.max(1, Math.round(this.width * dpr));
    const bh = Math.max(1, Math.round(this.height * dpr));
    (this.aoPass.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);
    (this.casPass.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);
    (this.fxaaPass.uniforms.resolution.value as THREE.Vector2).set(1 / bw, 1 / bh);
    const aspect = bw / bh;
    this.speedPass.uniforms.uAspect.value = aspect;
    this.gradePass.uniforms.uAspect.value = aspect;
  }

  setQuality(tier: QualityTier, settings?: SettingsState): void {
    this.quality = tier;
    if (settings) this.settings = settings;
    this.applyQuality();
    this.setSize(this.width, this.height);
  }

  private applyQuality(): void {
    const s = this.settings;
    const tier = this.quality;

    // §6.3 / QUALITY_PRESETS: post is off entirely on low.
    this.enabled = tier !== 'low' && s.postProcessing !== false;

    this.aoPass.enabled = this.enabled && s.ssao !== false && (tier === 'high' || tier === 'ultra');
    this.bloomPass.enabled = this.enabled && s.bloom !== false;
    this.speedPass.enabled = this.enabled && s.motionBlur !== false && tier !== 'medium';
    this.gradePass.enabled = this.enabled;
    // SMAA on high/ultra, FXAA on medium — never both.
    this.smaaPass.enabled = this.enabled && (tier === 'high' || tier === 'ultra');
    this.fxaaPass.enabled = this.enabled && tier === 'medium';
    this.casPass.enabled =
      this.enabled && (tier === 'ultra' || (tier !== 'low' && s.renderScale < 0.98));
    this.renderPass.enabled = this.enabled;

    this.bloomPass.radius = POST_STATE.bloomRadius;
    this.casPass.uniforms.uSharpness.value = 0.35;
  }

  /* --------------------------------------------------------------- render */

  render(dt: number): void {
    if (this.disposed) return;

    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const step = Math.min(Math.max(dt, 0), 0.1);
    this.time = (this.time + step) % 1000;

    /* — speed drive — */
    const src = this.speedSource?.();
    if (src) this._speedAmount = clamp01(src.speedBlurAmount * 0.72 + src.fovKick * 0.38);
    this._speedSmoothed = damp(this._speedSmoothed, this._speedAmount, 9, step);

    /* — per-frame uniforms — */
    if (this.aoPass.enabled) {
      const depthTex = this.composer.readBuffer.depthTexture;
      this.aoPass.uniforms.tDepth.value = depthTex ?? null;
      (this.aoPass.uniforms.uProjection.value as THREE.Matrix4).copy(this.camera.projectionMatrix);
      (this.aoPass.uniforms.uProjectionInverse.value as THREE.Matrix4).copy(
        this.camera.projectionMatrixInverse,
      );
      if (!depthTex) this.aoPass.enabled = false;
    }

    if (this.bloomPass.enabled) {
      this.bloomPass.strength = POST_STATE.bloomStrength;
      this.bloomPass.threshold = POST_STATE.bloomThreshold;
      this.bloomPass.radius = POST_STATE.bloomRadius;
    }

    this.speedPass.uniforms.uAmount.value = this._speedSmoothed;

    const g = this.gradePass.uniforms;
    g.uExposure.value = POST_STATE.exposure;
    (g.uShadowTint.value as THREE.Color).copy(POST_STATE.shadowTint);
    (g.uHighlightTint.value as THREE.Color).copy(POST_STATE.highlightTint);
    (g.uLiftColor.value as THREE.Color).copy(POST_STATE.liftColor);
    g.uLift.value = POST_STATE.lift;
    // wet streets carry more specular; a touch more saturation stops them
    // reading as grey slush
    g.uSaturation.value = POST_STATE.saturation + POST_STATE.wet * 0.05;
    g.uVignette.value = POST_STATE.vignette;
    g.uGrain.value = POST_STATE.grain;
    g.uChroma.value = POST_STATE.chroma * (0.35 + this._speedSmoothed * 1.4);
    g.uFlash.value = POST_STATE.flash;
    g.uTime.value = this.time;

    this.composer.render(step);
  }

  /* -------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderPass.dispose?.();
    this.aoPass.dispose?.();
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

  /** Numbers the QA harness wants. */
  stats(): Record<string, number> {
    return {
      postEnabled: this.enabled ? 1 : 0,
      passes: this.composer.passes.filter((p) => p.enabled).length,
      ao: this.aoPass.enabled ? 1 : 0,
      bloom: this.bloomPass.enabled ? 1 : 0,
      bloomStrength: Number(POST_STATE.bloomStrength.toFixed(3)),
      bloomThreshold: Number(POST_STATE.bloomThreshold.toFixed(3)),
      exposure: Number(POST_STATE.exposure.toFixed(3)),
      speedAmount: Number(this._speedSmoothed.toFixed(3)),
      smaa: this.smaaPass.enabled ? 1 : 0,
      cas: this.casPass.enabled ? 1 : 0,
    };
  }
}

