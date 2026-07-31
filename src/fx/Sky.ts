/**
 * Loco Lift — procedural sky.
 *
 * One camera-locked dome plus a tiny equirectangular capture of the same shader
 * that becomes `scene.environment`. Everything is generated in GLSL: gradient,
 * horizon band, Mie halo, limb-darkened sun disc, drifting trade-wind cumulus,
 * a star field with a Milky Way band, and a moon. No textures, no assets, works
 * offline.
 *
 * Three notes an implementer needs:
 *
 * 1. **Do not include `tonemapping_pars_fragment` or `colorspace_pars_fragment`.**
 *    Three r185 injects both into every `ShaderMaterial` fragment prefix;
 *    including them again redefines `toneMappingExposure` and every tone-mapping
 *    function, and the program fails to link. The *apply* chunks
 *    (`<tonemapping_fragment>` / `<colorspace_fragment>`) are ours to include and
 *    are what makes the dome correct when the post pipeline is switched off.
 * 2. The dome renders with `depthTest: false`, `depthWrite: false` and
 *    `renderOrder = -1000`, and is re-centred on the camera every frame, so it
 *    can neither z-fight nor clip against the far plane.
 * 3. The environment capture is the reason shadowed ground stays readable. A
 *    hemisphere light is a two-colour approximation; a PMREM of the actual sky
 *    puts the right warm orange into a golden-hour shadow and the right cool
 *    blue into a midday one, and gives the wet road something to reflect.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import type { LightingState } from './LightingPresets';

/* ------------------------------------------------------------------ glsl */

/**
 * Shared sky evaluation. Included by both the dome and the environment capture
 * so there is exactly one definition of what the sky looks like.
 */
const SKY_COMMON = /* glsl */ `
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uBand;
uniform vec3  uGroundCol;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunDisc;
uniform float uHaze;
uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
uniform float uMoonInt;
uniform float uCloudCover;
uniform float uCloudOpacity;
uniform vec3  uCloudLit;
uniform vec3  uCloudShade;
uniform vec2  uWind;
uniform float uTime;
uniform float uStars;
uniform float uCloudHeight;

float locoHash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 locoHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}

float locoNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = locoHash21( i );
  float b = locoHash21( i + vec2( 1.0, 0.0 ) );
  float c = locoHash21( i + vec2( 0.0, 1.0 ) );
  float d = locoHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

float locoFbm( vec2 p ) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2( 1.62, 1.18, -1.18, 1.62 );
  for ( int i = 0; i < LOCO_CLOUD_OCT; i ++ ) {
    v += amp * locoNoise( p );
    p = rot * p;
    amp *= 0.5;
  }
  return v;
}

/* Cloud density at a sky direction, plus a cheap toward-the-sun self shadow. */
vec2 locoClouds( vec3 d, float detailFade ) {
  float dist = uCloudHeight / max( d.y, 0.010 );
  vec2 p = d.xz * dist * 0.00088 + uWind * uTime * 0.0021;
  float edge = 1.0 - uCloudCover * 0.92;

  float base = locoFbm( p );
  float detail = locoFbm( p * 3.4 + 19.7 ) * 0.30 * detailFade;
  float dens = smoothstep( edge, edge + 0.26, base + detail );

  vec2 toSun = uSunDir.xz;
  float l = length( toSun );
  toSun = l > 1e-4 ? toSun / l : vec2( 1.0, 0.0 );
  vec2 sp = p + toSun * 0.085;
  float sBase = locoFbm( sp );
  float sDetail = locoFbm( sp * 3.4 + 19.7 ) * 0.30 * detailFade;
  float shadow = smoothstep( edge, edge + 0.26, sBase + sDetail );

  return vec2( dens, shadow );
}

/* Star field + Milky Way band. Costs one hash per pixel when uStars is 0. */
vec3 locoStars( vec3 d ) {
  if ( uStars < 0.002 || d.y < -0.03 ) return vec3( 0.0 );

  vec2 sph = vec2( atan( d.z, d.x ), asin( clamp( d.y, -1.0, 1.0 ) ) );

  // Milky Way: a great-circle band with fbm dust lanes.
  vec3 axis = normalize( vec3( 0.56, 0.40, -0.73 ) );
  float band = 1.0 - abs( dot( d, axis ) );
  float mw = smoothstep( 0.74, 1.0, band );
  float dust = locoFbm( sph * vec2( 5.5, 9.0 ) + 4.3 );
  mw *= mix( 0.25, 1.0, smoothstep( 0.35, 0.78, dust ) );
  vec3 col = mix( vec3( 0.36, 0.40, 0.62 ), vec3( 0.62, 0.60, 0.70 ), dust ) * mw * 0.085;

  // point stars, denser inside the band
  vec2 g = sph * vec2( 150.0, 96.0 );
  vec2 id = floor( g );
  vec2 f = fract( g );
  vec2 off = locoHash22( id );
  float mag = locoHash21( id + 7.31 );
  float thresh = 0.845 - mw * 0.10;
  float dist = length( f - off );
  float star = smoothstep( 0.085, 0.0, dist ) * step( thresh, mag );
  float bright = pow( ( mag - thresh ) / max( 1.0 - thresh, 1e-3 ), 2.2 );
  float twinkle = 0.72 + 0.28 * sin( uTime * 2.4 + mag * 41.0 );
  vec3 tint = mix( vec3( 0.78, 0.86, 1.0 ), vec3( 1.0, 0.88, 0.72 ), locoHash21( id + 2.7 ) );
  col += tint * star * bright * twinkle * 1.5;

  float horizonFade = smoothstep( -0.02, 0.16, d.y );
  return col * uStars * horizonFade;
}

vec3 locoSky( vec3 dir ) {
  vec3 d = normalize( dir );
  float up = d.y;

  /* ---- gradient: zenith -> horizon, then the 6 degree band ---- */
  float t = pow( clamp( up, 0.0, 1.0 ), 0.44 );
  vec3 col = mix( uHorizon, uZenith, t );
  float bandMask = exp( -max( up, 0.0 ) * 13.0 );
  col = mix( col, uBand, bandMask * 0.62 );

  /* ---- night sky content, before clouds so clouds occlude it ---- */
  col += locoStars( d );

  /* ---- moon ---- */
  if ( uMoonInt > 0.002 ) {
    float mc = dot( d, uMoonDir );
    float mang = acos( clamp( mc, -1.0, 1.0 ) );
    float mR = 0.0058;
    float mdisc = smoothstep( mR, mR * 0.82, mang );
    vec3 tangent = d - uMoonDir * mc;
    float maria = locoNoise( tangent.xz * 260.0 + tangent.y * 130.0 );
    float lit = mix( 0.82, 1.0, maria );
    col += uMoonColor * mdisc * lit * uMoonInt * 4.2;
    col += uMoonColor * pow( max( mc, 0.0 ), 900.0 ) * uMoonInt * 0.55;
    col += uMoonColor * pow( max( mc, 0.0 ), 24.0 ) * uMoonInt * 0.035;
  }

  /* ---- sun: broad Mie halo, tight glow, limb-darkened disc ---- */
  float ca = dot( d, uSunDir );
  float above = smoothstep( -0.09, 0.03, uSunDir.y );
  float lowSun = 1.0 - clamp( uSunDir.y * 2.6, 0.0, 1.0 );
  col += uSunColor * pow( max( ca, 0.0 ), 5.0 ) * 0.13 * uHaze * ( 1.0 + 2.2 * lowSun ) * above;
  col += uSunColor * pow( max( ca, 0.0 ), 90.0 ) * 0.55 * uHaze * above;

  if ( uSunDisc > 0.02 ) {
    float ang = acos( clamp( ca, -1.0, 1.0 ) );
    float R = 0.0092;
    float r = clamp( ang / R, 0.0, 1.0 );
    float limb = pow( max( 1.0 - r * r * 0.88, 0.0 ), 0.34 );
    float disc = smoothstep( R, R * 0.84, ang );
    col += uSunColor * disc * limb * uSunDisc * above;
  }

  /* ---- clouds ---- */
  float hf = smoothstep( 0.004, 0.055, up );
  if ( hf > 0.001 ) {
    vec2 cl = locoClouds( d, hf );
    float dens = cl.x;
    float litAmt = clamp( 1.0 - cl.y * 0.82, 0.0, 1.0 );
    vec3 cc = mix( uCloudShade, uCloudLit, litAmt );
    // silver lining on the sun side
    cc += uSunColor * pow( max( ca, 0.0 ), 7.0 ) * litAmt * 0.30 * above;
    // clouds recede into the horizon haze
    cc = mix( uHorizon, cc, clamp( hf * 1.2, 0.0, 1.0 ) );
    col = mix( col, cc, dens * uCloudOpacity * hf );
  }

  /* ---- below the horizon: sea haze, matched to the fog colour ---- */
  col = mix( uGroundCol, col, smoothstep( -0.17, 0.004, up ) );

  return max( col, vec3( 0.0 ) );
}
`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const DOME_FRAG = /* glsl */ `
#include <common>
${SKY_COMMON}
varying vec3 vDir;
void main() {
  gl_FragColor = vec4( locoSky( vDir ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ENV_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/**
 * Equirectangular capture. Matches three's `equirectUv`:
 * `u = atan2(z, x) / 2π + 0.5`, `v = asin(y) / π + 0.5`.
 */
const ENV_FRAG = /* glsl */ `
#include <common>
${SKY_COMMON}
varying vec2 vUv;
void main() {
  float phi = ( vUv.x - 0.5 ) * 6.2831853;
  float th = ( vUv.y - 0.5 ) * 3.1415927;
  float ct = cos( th );
  vec3 d = vec3( cos( phi ) * ct, sin( th ), sin( phi ) * ct );
  gl_FragColor = vec4( locoSky( d ), 1.0 );
}
`;

/* --------------------------------------------------------------- uniforms */

interface SkyUniforms {
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uBand: { value: THREE.Color };
  uGroundCol: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSunDisc: { value: number };
  uHaze: { value: number };
  uMoonDir: { value: THREE.Vector3 };
  uMoonColor: { value: THREE.Color };
  uMoonInt: { value: number };
  uCloudCover: { value: number };
  uCloudOpacity: { value: number };
  uCloudLit: { value: THREE.Color };
  uCloudShade: { value: THREE.Color };
  uWind: { value: THREE.Vector2 };
  uTime: { value: number };
  uStars: { value: number };
  uCloudHeight: { value: number };
  [key: string]: THREE.IUniform;
}

const CLOUD_OCTAVES: Record<QualityTier, number> = { low: 2, medium: 3, high: 4, ultra: 5 };
const ENV_SIZE: Record<QualityTier, number> = { low: 64, medium: 128, high: 192, ultra: 256 };

/* ------------------------------------------------------------------- sky */

export class Sky {
  readonly mesh: THREE.Mesh;

  private uniforms: SkyUniforms;
  private domeMat: THREE.ShaderMaterial;
  private envMat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private envCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private envQuad: THREE.Mesh;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envSize: number;
  private envTimer = 1e9;
  private envDirty = true;
  /**
   * Scalar fingerprint of the sky state. The environment capture is only
   * re-rendered when this drifts, so a static sky costs nothing per frame.
   */
  private envSig = Number.NaN;
  private quality: QualityTier;
  private time = 0;
  private disposed = false;
  private boundScene: THREE.Scene | null = null;

  /** metres/second of trade wind pushing the cloud deck, world XZ */
  readonly wind = new THREE.Vector2(9.5, 3.2);

  constructor(quality: QualityTier) {
    this.quality = quality;
    this.envSize = ENV_SIZE[quality];

    this.uniforms = {
      uZenith: { value: new THREE.Color(0x2e7bc4).convertSRGBToLinear() },
      uHorizon: { value: new THREE.Color(0xbfe0f2).convertSRGBToLinear() },
      uBand: { value: new THREE.Color(0xd8ecf7).convertSRGBToLinear() },
      uGroundCol: { value: new THREE.Color(0x4c5a5e).convertSRGBToLinear() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xfff8ec).convertSRGBToLinear() },
      uSunDisc: { value: 18 },
      uHaze: { value: 0.6 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor: { value: new THREE.Color(0xe8eeff).convertSRGBToLinear() },
      uMoonInt: { value: 0 },
      uCloudCover: { value: 0.33 },
      uCloudOpacity: { value: 0.96 },
      uCloudLit: { value: new THREE.Color(0xfffdf6).convertSRGBToLinear() },
      uCloudShade: { value: new THREE.Color(0x93a8c0).convertSRGBToLinear() },
      uWind: { value: new THREE.Vector2(9.5, 3.2) },
      uTime: { value: 0 },
      uStars: { value: 0 },
      uCloudHeight: { value: 700 },
    };

    const defines = { LOCO_CLOUD_OCT: String(CLOUD_OCTAVES[quality]) };

    this.domeMat = new THREE.ShaderMaterial({
      name: 'loco/sky-dome',
      uniforms: this.uniforms,
      defines: { ...defines },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    const geo = new THREE.SphereGeometry(1, 48, 28);
    this.mesh = new THREE.Mesh(geo, this.domeMat);
    this.mesh.name = 'fx/sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.scale.setScalar(600);

    this.envMat = new THREE.ShaderMaterial({
      name: 'loco/sky-env',
      uniforms: this.uniforms,
      defines: { ...defines },
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    this.envQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.envMat);
    this.envQuad.frustumCulled = false;
    this.envScene.add(this.envQuad);
  }

  /** Copy a lighting state into the sky uniforms. Cheap; call on any change. */
  apply(s: LightingState): void {
    const u = this.uniforms;
    u.uZenith.value.copy(s.skyZenith);
    u.uHorizon.value.copy(s.skyHorizon);
    u.uBand.value.copy(s.skyBand);
    u.uGroundCol.value.copy(s.skyGround);
    u.uSunDir.value.copy(s.sunDir);
    u.uSunColor.value.copy(s.sunColor);
    u.uSunDisc.value = s.sunDisc;
    u.uHaze.value = s.haze;
    u.uMoonDir.value.copy(s.moonDir);
    u.uMoonInt.value = s.moonIntensity;
    u.uCloudCover.value = s.cloudCover;
    u.uCloudOpacity.value = s.cloudOpacity;
    u.uCloudLit.value.copy(s.cloudLit);
    u.uCloudShade.value.copy(s.cloudShade);
    u.uStars.value = s.starIntensity;

    /* Only re-capture the environment when the sky has actually moved. A
     * signature comparison keeps a static frame at one capture and still
     * catches a time-of-day scrub or a shower rolling in. */
    const sig =
      s.sunDir.y * 9 +
      s.sunDir.x * 3 +
      s.sunIntensity +
      s.cloudCover * 4 +
      s.skyZenith.r * 6 +
      s.skyZenith.b * 6 +
      s.skyHorizon.g * 6 +
      s.starIntensity * 2 +
      s.haze;
    if (Math.abs(sig - this.envSig) > 0.0035) {
      this.envSig = sig;
      this.envDirty = true;
    }
  }

  /**
   * Re-centre the dome, advance the cloud drift, and refresh the environment
   * capture. Must run before the frame is rendered.
   */
  update(dt: number, camera: THREE.Camera, renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (this.disposed) return;

    // keep uTime bounded — an unbounded float wrecks noise precision after an hour
    this.time = (this.time + dt) % 3600;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uWind.value.copy(this.wind);

    this.mesh.position.setFromMatrixPosition(camera.matrixWorld);
    const far = (camera as THREE.PerspectiveCamera).far ?? 2000;
    const radius = Math.min(Math.max(far * 0.42, 250), 4000);
    if (Math.abs(this.mesh.scale.x - radius) > 1) this.mesh.scale.setScalar(radius);

    this.envTimer += dt;
    const interval = this.quality === 'low' ? 1.2 : 0.34;
    if (this.envTimer >= interval || this.envDirty) {
      this.envTimer = 0;
      this.envDirty = false;
      this.renderEnv(renderer, scene);
    }
  }

  /** Renders the equirect capture and hands it to the scene as the IBL source. */
  private renderEnv(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (!this.envRT) {
      this.envRT = new THREE.WebGLRenderTarget(this.envSize, this.envSize / 2, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
      });
      this.envRT.texture.name = 'loco/sky-env';
      this.envRT.texture.mapping = THREE.EquirectangularReflectionMapping;
      this.envRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.envRT);
    renderer.render(this.envScene, this.envCam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    // tells the renderer's cube-UV cache to regenerate the PMREM from the new pixels
    this.envRT.texture.needsPMREMUpdate = true;
    if (scene.environment !== this.envRT.texture) {
      scene.environment = this.envRT.texture;
      this.boundScene = scene;
    }
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    const oct = String(CLOUD_OCTAVES[tier]);
    this.domeMat.defines.LOCO_CLOUD_OCT = oct;
    this.envMat.defines.LOCO_CLOUD_OCT = oct;
    this.domeMat.needsUpdate = true;
    this.envMat.needsUpdate = true;

    const size = ENV_SIZE[tier];
    if (size !== this.envSize) {
      this.envSize = size;
      this.envRT?.dispose();
      this.envRT = null;
      if (this.boundScene) this.boundScene.environment = null;
    }
    this.envDirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.boundScene && this.boundScene.environment === this.envRT?.texture) {
      this.boundScene.environment = null;
    }
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.domeMat.dispose();
    this.envQuad.geometry.dispose();
    this.envMat.dispose();
    this.envScene.clear();
    this.envRT?.dispose();
    this.envRT = null;
  }
}
