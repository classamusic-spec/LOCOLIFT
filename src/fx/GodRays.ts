/**
 * Loco Lift — screen-space light shafts.
 *
 * Not volumetrics. This is the 2007 Mitchell radial-blur trick done carefully,
 * which is the right call here for three reasons: the city is a grid of hard
 * vertical occluders (façades, garitas, palms, the fort wall) so screen-space
 * occlusion is nearly exact; the sun at golden hour sits 8° above the horizon
 * and straight down the calles largas, so the shafts are almost entirely in
 * frame; and a real march through a froxel volume would cost more than the
 * whole rest of the chain put together for a game that has to hold 60 fps on a
 * laptop iGPU.
 *
 * How it differs from the naive version, and why each part matters:
 *
 * - The source is **sky colour**, not a white mask, so a `#FF6B3D` sunset band
 *   throws orange shafts and a slate storm sky throws grey ones, for free.
 * - The buffer is **quarter resolution**. Shafts are low-frequency by nature;
 *   the only thing full res buys is aliasing on the occluder edges.
 * - The march start is **jittered per pixel**, otherwise 16 samples band into
 *   visible steps across a large flat wall.
 * - Shafts **fade out as the sun leaves the frame** rather than popping, and
 *   are killed entirely once it is behind the camera. Screen-space shafts with
 *   an off-screen source are the single most recognisable artefact of this
 *   technique.
 *
 * Cost: one quarter-res pass, `LOCO_RAY_STEPS` × 2 texture fetches per pixel.
 * At 1280×720 that is 320×180 × 16 × 2 ≈ 1.8 M fetches, well under a
 * full-resolution 5-tap blur. The pass does not run at all when the preset's
 * `godRays` is ~0, when the sun is below the horizon, or on `low`.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { clamp01 } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { GLSL_COLOR, GLSL_NOISE, QUAD_VERT } from './PostEffects';

/** Radial march steps. The shafts get longer, not sharper, with more. */
const RAY_STEPS: Record<QualityTier, number> = { low: 0, medium: 12, high: 16, ultra: 24 };

/** Buffer divisor off the composer's resolution. */
const RAY_SCALE = 4;

const RAY_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uSunScreen;
uniform vec3 uSunColor;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uOnScreen;
uniform float uAspect;
uniform float uTime;
varying vec2 vUv;

${GLSL_COLOR}
${GLSL_NOISE}

void main() {
  vec2 delta = ( vUv - uSunScreen ) * ( uDensity / float( LOCO_RAY_STEPS ) );
  vec2 uv = vUv;
  float illum = 1.0;
  vec3 acc = vec3( 0.0 );

  /* jitter the first step so the march does not band across flat walls */
  uv -= delta * locoHash12( gl_FragCoord.xy + fract( uTime ) * 37.0 );

  for ( int i = 0; i < LOCO_RAY_STEPS; i ++ ) {
    uv -= delta;
    vec2 c = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
    /* depth == far plane means sky: that is the only thing that emits */
    float d = texture2D( tDepth, c ).x;
    float sky = step( 0.99999, d );
    vec3 s = texture2D( tScene, c ).rgb * sky;
    acc += s * illum;
    illum *= uDecay;
  }

  acc *= uWeight / float( LOCO_RAY_STEPS );
  /* tint toward the key light so shafts belong to the sun, not to whatever
   * cloud happened to be behind them */
  acc = mix( acc, uSunColor * locoLum( acc ), 0.45 );

  gl_FragColor = vec4( max( acc, vec3( 0.0 ) ) * uOnScreen, 1.0 );
}
`;

export class GodRays {
  private rt: THREE.WebGLRenderTarget | null = null;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private quality: QualityTier;
  private width = 1;
  private height = 1;
  private _active = false;
  private disposed = false;

  private readonly sunWorld = new THREE.Vector3();
  private readonly sunClip = new THREE.Vector4();

  constructor(quality: QualityTier) {
    this.quality = quality;
    this.material = new THREE.ShaderMaterial({
      name: 'loco/godrays',
      defines: { LOCO_RAY_STEPS: String(Math.max(1, RAY_STEPS[quality])) },
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        /**
         * `uDecay` and `uWeight` together set the total gain of the march:
         * `sum(decay^i) * weight / steps`. At decay 0.88 over 16 steps the sum
         * is 7.25, so a weight of 0.9 gives a maximum additive gain of ~0.41 ×
         * the sky radiance for a pixel that sees sky the whole way. That is a
         * shaft. The textbook 0.95/3.4 gives a gain of 2.4 ×, which is not a
         * shaft — it is a milky wash over the entire frame, and it is what this
         * pass looked like on the first capture.
         */
        uDensity: { value: 0.72 },
        uDecay: { value: 0.88 },
        uWeight: { value: 0.9 },
        uOnScreen: { value: 0 },
        uAspect: { value: 16 / 9 },
        uTime: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: RAY_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** The shaft buffer, or null before the first successful render. */
  get texture(): THREE.Texture | null {
    return this._active ? (this.rt?.texture ?? null) : null;
  }

  /** True when the last `render` actually produced shafts. */
  get active(): boolean {
    return this._active;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(32, Math.floor(width / RAY_SCALE));
    const h = Math.max(18, Math.floor(height / RAY_SCALE));
    if (w === this.width && h === this.height && this.rt) return;
    this.width = w;
    this.height = h;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this.rt.texture.name = 'loco/godrays';
    this.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.material.defines.LOCO_RAY_STEPS = String(Math.max(1, RAY_STEPS[tier]));
    this.material.needsUpdate = true;
  }

  /**
   * Build the shaft buffer for this frame.
   *
   * @param sunDir world-space unit vector pointing **toward** the light
   * @param strength preset shaft strength, 0..1
   * @returns true if shafts were produced; false means the caller should skip
   *          the composite entirely this frame
   */
  render(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Texture,
    depth: THREE.Texture,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    strength: number,
    time: number,
  ): boolean {
    this._active = false;
    if (this.disposed || !this.rt || RAY_STEPS[this.quality] <= 0) return false;
    if (strength <= 0.004 || sunDir.y <= 0.005) return false;

    /* The source has to be in front of the camera, or the radial march runs
     * away from the light and draws shafts that lean the wrong way. */
    camera.getWorldDirection(this.sunWorld);
    const facing = this.sunWorld.dot(sunDir);
    if (facing <= -0.15) return false;

    this.sunWorld.copy(camera.position).addScaledVector(sunDir, 6000);
    this.sunClip.set(this.sunWorld.x, this.sunWorld.y, this.sunWorld.z, 1);
    this.sunClip.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    if (this.sunClip.w <= 1e-5) return false;
    const sx = this.sunClip.x / this.sunClip.w * 0.5 + 0.5;
    const sy = this.sunClip.y / this.sunClip.w * 0.5 + 0.5;

    /* Fade out over a 60 % margin instead of popping when the disc exits. */
    const off = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) * 2;
    const onScreen = clamp01(1 - (off - 1) / 0.6) * clamp01((facing + 0.15) / 0.45);
    if (onScreen <= 0.004) return false;

    const u = this.material.uniforms;
    (u.uSunScreen.value as THREE.Vector2).set(sx, sy);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    u.tScene.value = scene;
    u.tDepth.value = depth;
    u.uOnScreen.value = onScreen * strength;
    u.uTime.value = time;
    // a low sun rakes further across the frame than a high one
    u.uDensity.value = 0.58 + (1 - clamp01(sunDir.y * 2.2)) * 0.34;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    this._active = true;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.quad.dispose();
    this.material.dispose();
    this.rt?.dispose();
    this.rt = null;
  }
}
