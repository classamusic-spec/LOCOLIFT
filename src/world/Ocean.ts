/**
 * Loco Lift — the sea.
 *
 * Replaces the flat swell plane with an actual Caribbean bay:
 *
 *  - **Sum-of-Gerstner displacement**, four waves, analytically differentiated
 *    so the normal is exact rather than finite-differenced.
 *  - **A bathymetry field.** The layer bakes the district's terrain into a
 *    depth texture once at build time. Everything expensive downstream —
 *    turquoise shallows, wave shoaling, the shoreline foam line — is a lookup
 *    into that texture rather than a search. This is what makes the water read
 *    as *this* coast and not as a generic ocean shader.
 *  - **Depth-graded colour.** Sunlit sand through 0.5 m of water, jade over the
 *    terrace, cerulean over the bay, near-black off the shelf. Getting the
 *    green into the shallows is the whole signature (§3.5, §5).
 *  - **Foam** in three registers: the animated run-up line at the shore, crest
 *    foam driven by the Gerstner Jacobian, and distant whitecaps that keep the
 *    horizon from going flat.
 *  - **Sun glitter** from two non-parallel scrolling normal fields at 0.22 and
 *    0.09 m/s, per §5.
 *
 * **Cost.** One draw call. The mesh is a camera-centred radial disc with
 * exponential ring spacing, so triangles pile up where you can see them and
 * thin out to nothing at the horizon: ~12 k triangles at `high` covering
 * 2 km of water.
 *
 * The layer hides the world's original `world/sea` mesh on build. It does not
 * modify it, so removing this layer restores the old plane exactly.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import { clamp01 } from '../core/MathUtils';
import { fbm2D, valueNoise2D } from '../core/RNG';
import { SEA_LEVEL, DISTRICT_BOUNDS, baseTerrain } from './CityLayout';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------------ tuning */

/** Metres of water depth the bathymetry texture's red channel spans. */
const DEPTH_RANGE = 22;
/** Metres of land height the green channel spans. */
const LAND_RANGE = 12;

/** Extent of the baked bathymetry field, metres beyond the district bounds. */
const FIELD_PAD = 170;

interface TierSpec {
  /** metres */
  radius: number;
  rings: number;
  segments: number;
  fieldW: number;
  fieldH: number;
  /** detail normal sampling on/off */
  detail: boolean;
}

const TIERS: Record<QualityTier, TierSpec> = {
  low: { radius: 1500, rings: 26, segments: 64, fieldW: 256, fieldH: 208, detail: false },
  medium: { radius: 1900, rings: 38, segments: 96, fieldW: 384, fieldH: 312, detail: true },
  high: { radius: 2100, rings: 50, segments: 128, fieldW: 512, fieldH: 416, detail: true },
  ultra: { radius: 2100, rings: 64, segments: 160, fieldW: 640, fieldH: 520, detail: true },
};

/* ------------------------------------------------------------------ shader */

const OCEAN_COMMON = /* glsl */ `
/* --- four Gerstner waves. w = (dirX, dirZ, steepness, wavelength) --- */
uniform vec4 uWaveA;
uniform vec4 uWaveB;
uniform vec4 uWaveC;
uniform vec4 uWaveD;
uniform float uAmpA;
uniform float uAmpB;
uniform float uAmpC;
uniform float uAmpD;
uniform float uTime;
uniform float uSwell;

uniform sampler2D uDepthMap;
uniform vec4 uField;      // xy = min corner, zw = 1 / size
uniform float uSeaLevel;

/**
 * Bathymetry lookup. Returns:
 *   x = water depth in metres (negative on land)
 *   y = shoreline foam breakup noise, 0..1, world locked
 */
vec2 locoBathy( vec2 world ) {
  vec2 uv = ( world - uField.xy ) * uField.zw;
  vec2 over = max( -uv, uv - vec2( 1.0 ) );
  float outside = clamp( max( over.x, over.y ) * 26.0, 0.0, 1.0 );
  vec3 t = texture2D( uDepthMap, clamp( uv, vec2( 0.0005 ), vec2( 0.9995 ) ) ).rgb;
  float depth = t.r * ${DEPTH_RANGE.toFixed(1)} - t.g * ${LAND_RANGE.toFixed(1)};
  depth = mix( depth, ${DEPTH_RANGE.toFixed(1)}, outside );
  return vec2( depth, t.b );
}

/** 0 in the surf zone, 1 in water deep enough to carry the full swell. */
float locoShoal( float depth ) {
  return smoothstep( 0.25, 6.5, depth );
}

/**
 * Accumulate one Gerstner wave. 'amp' already carries the shoaling damp, and
 * 'w.z' is a plain 0..1 steepness rather than the textbook Q — Q blows up as
 * the amplitude is damped toward the shore, which pushes the surface sideways
 * in water that should be glassy.
 *
 * Returns the horizontal push in .xz, the lift in .y, and the Jacobian
 * (crest-sharpness) contribution in .w. The accumulators are 'inout' because
 * 'out' parameters are undefined on entry in GLSL.
 */
vec4 locoGerstner( vec4 w, float amp, vec2 xz, float t, inout vec3 tangentAcc, inout vec3 binormAcc ) {
  vec2 dir = normalize( w.xy );
  float k = 6.2831853 / max( w.w, 0.5 );
  float c = sqrt( 9.81 / k );
  float f = k * ( dot( dir, xz ) - c * t );
  float sf = sin( f );
  float cf = cos( f );
  float a = amp;
  float q = w.z;

  tangentAcc += vec3(
    -q * dir.x * dir.x * k * a * sf,
     dir.x * k * a * cf,
    -q * dir.x * dir.y * k * a * sf
  );
  binormAcc += vec3(
    -q * dir.x * dir.y * k * a * sf,
     dir.y * k * a * cf,
    -q * dir.y * dir.y * k * a * sf
  );

  return vec4( q * a * cf * dir.x, a * sf, q * a * cf * dir.y, q * k * a * sf );
}

/**
 * Full displacement. 'outNormal' is exact, 'outFoam.x' is the normalised crest
 * steepness (1 ≈ the sharpest crest the tuned swell can make) and 'outFoam.y'
 * the raw wave lift in metres.
 */
vec3 locoWaves( vec2 xz, float depth, out vec3 outNormal, out vec2 outFoam ) {
  float shoal = locoShoal( depth );
  // waves stand up as they shoal over the terrace, then collapse in the surf
  float standUp = 1.0 + 0.75 * smoothstep( 0.02, 0.32, shoal ) * ( 1.0 - smoothstep( 0.22, 0.86, shoal ) );
  float gain = uSwell * mix( 0.05, 1.0, shoal ) * standUp;

  // pure derivative *offsets*; the base axes are folded in below
  vec3 tang = vec3( 0.0 );
  vec3 bino = vec3( 0.0 );
  vec3 disp = vec3( 0.0 );
  float steep = 0.0;

  vec4 r;
  r = locoGerstner( uWaveA, uAmpA * gain, xz, uTime, tang, bino ); disp += r.xyz; steep += r.w;
  r = locoGerstner( uWaveB, uAmpB * gain, xz, uTime, tang, bino ); disp += r.xyz; steep += r.w;
  r = locoGerstner( uWaveC, uAmpC * gain, xz, uTime, tang, bino ); disp += r.xyz; steep += r.w;
  r = locoGerstner( uWaveD, uAmpD * gain, xz, uTime, tang, bino ); disp += r.xyz; steep += r.w;

  // tang/bino accumulated the derivative *offsets*; fold in the base axes
  vec3 T = vec3( 1.0 + tang.x, tang.y, tang.z );
  vec3 B = vec3( bino.x, bino.y, 1.0 + bino.z );
  outNormal = normalize( cross( B, T ) );
  // 8.0 maps the tuned swell's peak Jacobian on to roughly 0..1
  outFoam = vec2( steep * 8.0, disp.y );
  return disp;
}
`;

const OCEAN_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${OCEAN_COMMON}

varying vec3 vWorld;
varying vec3 vNormal_;
varying vec2 vFoam;
varying float vDepth;
varying float vShoreNoise;
varying float vRadial;

void main() {
  vec3 local = position;
  vec4 wp = modelMatrix * vec4( local, 1.0 );

  vec2 bathy = locoBathy( wp.xz );
  vDepth = bathy.x;
  vShoreNoise = bathy.y;

  vec3 nrm;
  vec2 foam;
  vec3 disp = locoWaves( wp.xz, bathy.x, nrm, foam );

  // sink the mesh under the sand as it crosses on to land, so the water edge
  // is a real intersection with the beach instead of a drawn line
  float land = clamp( -bathy.x, 0.0, 6.0 );
  wp.xyz += disp;
  wp.y -= land * 0.85;

  vWorld = wp.xyz;
  vNormal_ = nrm;
  vFoam = foam;
  vRadial = length( local.xz );

  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;

  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}
`;

const OCEAN_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${OCEAN_COMMON}

uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uSandLit;
uniform vec3 uFoamCol;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uSunPower;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform float uAmbient;
uniform sampler2D uDetail;
uniform float uDetailOn;
uniform float uRadius;
/**
 * Irradiance on the water, pushed in from the CPU each frame.
 *
 * This layer is not a lit material, so nothing multiplies the sun into it for
 * us — and the rest of the district is standing under a 3.6-intensity key
 * light. Without this the sea renders roughly a stop and a half under
 * everything around it, which is exactly what turns a turquoise bay into grey
 * slate.
 */
uniform vec3 uLight;

varying vec3 vWorld;
varying vec3 vNormal_;
varying vec2 vFoam;
varying float vDepth;
varying float vShoreNoise;
varying float vRadial;

float locoHash21( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}
float locoNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( locoHash21( i ), locoHash21( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( locoHash21( i + vec2( 0.0, 1.0 ) ), locoHash21( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y
  );
}

/** cheap analytic sky for the reflection term — matches the dome's gradient */
vec3 locoSkyOf( vec3 d ) {
  float up = clamp( d.y, 0.0, 1.0 );
  vec3 col = mix( uSkyHorizon, uSkyZenith, pow( up, 0.42 ) );
  float ca = max( dot( normalize( d ), uSunDir ), 0.0 );
  col += uSunCol * pow( ca, 8.0 ) * 0.16 * uSunPower;
  col += uSunCol * pow( ca, 120.0 ) * 0.55 * uSunPower;
  return col;
}

void main() {
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 N = normalize( vNormal_ );

  float dist = length( cameraPosition.xz - vWorld.xz );
  // the fine chop dies out first; the long swell ripple carries the glitter
  // most of the way to the horizon, which is where the sun path lives
  float fineFade = 1.0 - smoothstep( 40.0, 260.0, dist );
  float longFade = 1.0 - smoothstep( 300.0, 1400.0, dist );

  /* --- two non-parallel scrolling normal fields: §5, 0.22 and 0.09 m/s --- */
  if ( uDetailOn > 0.5 && longFade > 0.002 ) {
    vec2 uv1 = vWorld.xz * 0.055 + vec2( 0.22, 0.06 ) * uTime * 0.055;
    vec2 uv2 = vWorld.xz * 0.0155 + vec2( -0.07, 0.09 ) * uTime * 0.0155;
    vec3 d1 = texture2D( uDetail, uv1 ).xyz * 2.0 - 1.0;
    vec3 d2 = texture2D( uDetail, uv2 ).xyz * 2.0 - 1.0;
    vec3 bump = vec3(
      d1.x * 0.9 * fineFade + d2.x * 1.25 * longFade,
      0.0,
      d1.z * 0.9 * fineFade + d2.z * 1.25 * longFade
    );
    N = normalize( N + bump * 0.5 );
  }

  /* --- depth-graded body colour --------------------------------------- */
  float d = max( vDepth, 0.0 );
  // wide, overlapping ramps: the sea floor drops fast here, so tight ramps
  // would put a hard contour ring in the water a few tens of metres out
  vec3 water = mix( uShallow, uMid, smoothstep( 1.2, 13.0, d ) );
  water = mix( water, uDeep, smoothstep( 10.0, 24.0, d ) );
  // sunlit sand read through very shallow water — the Caribbean signature
  float sandSee = 1.0 - smoothstep( 0.0, 4.2, d );
  water = mix( water, mix( uSandLit, uShallow, 0.34 ), sandSee * 0.85 );
  // light bouncing back off the bottom brightens the whole shallow shelf
  water *= 1.0 + sandSee * 0.6;

  /* --- subsurface scattering through the back of a wave ---------------- */
  float lift = clamp( vFoam.y, 0.0, 3.0 );
  float sss = pow( clamp( dot( V, -normalize( vec3( uSunDir.x, -0.15, uSunDir.z ) ) ), 0.0, 1.0 ), 3.0 );
  water += uShallow * sss * lift * 0.55 * smoothstep( 0.4, 4.0, d );

  // the body colour is what the sun actually lands on
  water *= uLight;

  /* --- sky reflection, Fresnel weighted -------------------------------- */
  vec3 R = reflect( -V, N );
  // A mirror reflection at the grazing angle you actually drive at samples the
  // horizon band — which is the palest, greyest part of the sky — and paints
  // the entire bay with it. Real water is rough: the reflection lobe is wide
  // and pulls in the blue overhead, so the sample is lifted off the horizon.
  R.y = abs( R.y ) * 0.62 + 0.34;
  float fres = clamp( pow( 1.0 - max( dot( N, V ), 0.0 ), 5.0 ), 0.0, 1.0 );
  fres = mix( 0.022, 1.0, fres );
  // Over a bright sand bottom the upwelling light genuinely wins, so the
  // shallows keep their own colour and only the deep water goes mirror.
  float reflAmt = fres * mix( 0.15, 0.46, smoothstep( 1.2, 13.0, d ) );
  vec3 col = mix( water, locoSkyOf( R ), reflAmt );

  /* --- sun glitter ----------------------------------------------------- */
  vec3 H = normalize( uSunDir + V );
  float ndh = max( dot( N, H ), 0.0 );
  // the tight spark, the broad sheen, and the wide sun path that survives even
  // where the surface normal never quite lines up
  col += uSunCol * pow( ndh, 420.0 ) * 7.0 * uSunPower;
  col += uSunCol * pow( ndh, 42.0 ) * 0.55 * uSunPower;
  float path = pow( max( dot( normalize( vec3( R.x, 0.0, R.z ) ), normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) ) ), 0.0 ), 26.0 );
  col += uSunCol * path * fres * 0.42 * uSunPower * smoothstep( 0.02, 0.35, uSunDir.y );

  /* --- foam ------------------------------------------------------------ */
  // 1. crest foam from the Gerstner Jacobian
  float crest = smoothstep( 0.58, 0.92, vFoam.x );
  crest *= 0.35 + 0.65 * locoNoise2( vWorld.xz * 0.55 + uTime * 0.09 );

  // 2. distant whitecaps so the horizon is not a flat band
  float caps = smoothstep( 0.30, 0.75, vFoam.x ) * smoothstep( 300.0, 900.0, dist ) * 0.55;

  // 3. the shoreline run-up: a breaking line that advances and retreats
  float swash = 0.55 + 0.45 * sin( uTime * 0.62 + vShoreNoise * 6.2831 + vWorld.x * 0.021 );
  float effective = d - vFoam.y - swash * 0.55;
  float shore = 1.0 - smoothstep( 0.0, 1.35, effective );
  shore *= smoothstep( -1.4, -0.3, vDepth );
  shore *= 0.42 + 0.58 * locoNoise2( vWorld.xz * 0.62 + vec2( 0.0, uTime * 0.5 ) );
  // the breaker line itself: brightest right where the wave trips
  float breakLine = smoothstep( 0.55, 0.0, abs( effective - 0.35 ) ) * 0.9;
  breakLine *= smoothstep( 0.25, 0.62, locoNoise2( vWorld.xz * 0.9 - vec2( 0.0, uTime * 0.75 ) ) );

  float foam = clamp( crest + caps + shore * 0.95 + breakLine, 0.0, 1.0 );
  foam *= 0.35 + 0.65 * smoothstep( 0.15, 0.72, locoNoise2( vWorld.xz * 2.7 + uTime * 0.22 ) + 0.28 );
  col = mix( col, uFoamCol * uLight * 0.92, clamp( foam, 0.0, 0.94 ) );

  /* --- chroma ---------------------------------------------------------- */
  // §6.4 wants 0.34–0.52 mean saturation. Mixing any sky into water costs
  // chroma, and the district's haze takes more; a modest push back keeps the
  // bay the most saturated large area in frame without going into postcard.
  float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  col = mix( vec3( lum ), col, 1.22 );

  /* --- the horizon --------------------------------------------------- */
  // The far disc has to arrive at the same value the sky dome sits at, or the
  // sea reads as a dark band pasted under a bright sky. Fog gets most of the
  // way there; the rim closes the last of it.
  float rim = smoothstep( uRadius * 0.55, uRadius * 0.97, vRadial );
  col = mix( col, uSkyHorizon, rim * 0.85 );

  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );

  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ---------------------------------------------------------------- uniforms */

interface OceanUniforms {
  uTime: { value: number };
  uSwell: { value: number };
  uWaveA: { value: THREE.Vector4 };
  uWaveB: { value: THREE.Vector4 };
  uWaveC: { value: THREE.Vector4 };
  uWaveD: { value: THREE.Vector4 };
  uAmpA: { value: number };
  uAmpB: { value: number };
  uAmpC: { value: number };
  uAmpD: { value: number };
  uDepthMap: { value: THREE.Texture | null };
  uField: { value: THREE.Vector4 };
  uSeaLevel: { value: number };
  uShallow: { value: THREE.Color };
  uMid: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  uSandLit: { value: THREE.Color };
  uFoamCol: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
  uSunPower: { value: number };
  uSkyHorizon: { value: THREE.Color };
  uSkyZenith: { value: THREE.Color };
  uAmbient: { value: number };
  uDetail: { value: THREE.Texture | null };
  uDetailOn: { value: number };
  uRadius: { value: number };
  uLight: { value: THREE.Color };
  [k: string]: THREE.IUniform;
}

/* ------------------------------------------------------------------- layer */

export interface OceanOptions {
  /** hide the world's original flat sea plane (default true) */
  replaceExisting?: boolean;
  /** overall swell scale, 1 = the tuned Caribbean bay */
  swell?: number;
}

export class Ocean implements WorldLayer {
  readonly name = 'ocean';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: OceanOptions;

  private mesh: THREE.Mesh | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private depthTex: THREE.DataTexture | null = null;
  private detailTex: THREE.DataTexture | null = null;

  private layout: CityLayout | null = null;
  private scene: THREE.Scene | null = null;
  private hidden: THREE.Object3D[] = [];
  private sun: THREE.DirectionalLight | null = null;

  private uniforms: OceanUniforms;
  private _tris = 0;

  constructor(quality: QualityTier, options: OceanOptions = {}) {
    this.quality = quality;
    this.options = { replaceExisting: true, swell: 1, ...options };
    this.group.name = 'world/ocean';

    const srgb = (hex: number): THREE.Color =>
      new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

    this.uniforms = {
      uTime: { value: 0 },
      uSwell: { value: this.options.swell ?? 1 },
      // (dirX, dirZ, steepness, wavelength m) — the bay opens to the south,
      // so the swell runs shoreward on -z with a spread either side
      uWaveA: { value: new THREE.Vector4(0.12, -1.0, 0.72, 58) },
      uWaveB: { value: new THREE.Vector4(-0.42, -1.0, 0.62, 33) },
      uWaveC: { value: new THREE.Vector4(0.63, -1.0, 0.5, 17.5) },
      uWaveD: { value: new THREE.Vector4(-0.85, -1.0, 0.42, 9.2) },
      uAmpA: { value: 0.56 },
      uAmpB: { value: 0.3 },
      uAmpC: { value: 0.145 },
      uAmpD: { value: 0.07 },
      uDepthMap: { value: null },
      uField: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSeaLevel: { value: SEA_LEVEL },
      /* §3.5 / §5: bay water is jade-turquoise, the shelf goes cerulean, the
       * open Atlantic goes deep navy. */
      uShallow: { value: srgb(0x54ded0) },
      uMid: { value: srgb(0x1794c4) },
      uDeep: { value: srgb(0x11507f) },
      uSandLit: { value: srgb(0xe4dcb2) },
      uFoamCol: { value: srgb(0xf6fcfb) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.72, 0.56) },
      uSunCol: { value: srgb(0xfff6e6) },
      uSunPower: { value: 1 },
      uSkyHorizon: { value: srgb(0xc6dcec) },
      uSkyZenith: { value: srgb(0x4d92d4) },
      uAmbient: { value: 1 },
      uLight: { value: new THREE.Color(1.2, 1.2, 1.2) },
      uDetail: { value: null },
      uDetailOn: { value: 1 },
      uRadius: { value: TIERS[quality].radius },
    };
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.layout = layout;
    this.scene = opts.scene;

    const spec = TIERS[this.quality];
    this.depthTex = buildBathymetry(layout, spec.fieldW, spec.fieldH, this.uniforms.uField.value);
    this.detailTex = buildDetailNormal(256);
    this.uniforms.uDepthMap.value = this.depthTex;
    this.uniforms.uDetail.value = this.detailTex;
    this.uniforms.uDetailOn.value = spec.detail ? 1 : 0;
    this.uniforms.uRadius.value = spec.radius;

    this.material = new THREE.ShaderMaterial({
      name: 'loco/ocean',
      uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      side: THREE.FrontSide,
      fog: true,
      transparent: false,
      depthWrite: true,
    });
    // merge() deep-clones, which would sever the shared colour/vector objects,
    // so the ocean's own uniforms are attached afterwards by reference
    Object.assign(this.material.uniforms, this.uniforms);

    this.geo = buildDisc(spec.radius, spec.rings, spec.segments);
    this._tris = (this.geo.index?.count ?? 0) / 3;

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'ocean/surface';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -2;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.position.set(0, SEA_LEVEL, 0);
    this.mesh.updateMatrix();
    this.group.add(this.mesh);

    if (this.options.replaceExisting) this.hideLegacySea(opts.scene);
    this.sun = (opts.scene.getObjectByName('world/sun') as THREE.DirectionalLight) ?? null;
  }

  /** Turn off the world's flat swell plane; we do not touch or own it. */
  private hideLegacySea(scene: THREE.Scene): void {
    scene.traverse((o) => {
      if (o.name === 'world/sea' && o.visible) {
        o.visible = false;
        this.hidden.push(o);
      }
    });
  }

  /* ------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number): void {
    const u = this.uniforms;
    u.uTime.value += dt;

    if (this.mesh) {
      // snap to a coarse grid: the disc follows the camera, but jumping in
      // discrete steps stops the tessellation shimmering under the waves
      const snap = 4;
      this.mesh.position.set(
        Math.round(cameraPos.x / snap) * snap,
        SEA_LEVEL,
        Math.round(cameraPos.z / snap) * snap,
      );
      this.mesh.updateMatrix();
    }

    // read the lighting rig without owning it
    const sun = this.sun;
    let sunIntensity = 3.6;
    if (sun) {
      u.uSunDir.value.copy(sun.position).sub(sun.target.position);
      const l = u.uSunDir.value.length();
      if (l > 1e-4) u.uSunDir.value.multiplyScalar(1 / l);
      else u.uSunDir.value.set(0, 1, 0);
      u.uSunCol.value.copy(sun.color);
      sunIntensity = sun.intensity;
      u.uSunPower.value = clamp01(sunIntensity / 3.6) * 0.85 + 0.15;
    }
    const fog = this.scene?.fog;
    if (fog) {
      // the sky's horizon band sits brighter than the fog colour; matching the
      // fog exactly leaves a dark strip of sea under a bright sky
      u.uSkyHorizon.value.copy(fog.color).lerp(WHITE, 0.16);
      u.uSkyZenith.value.copy(fog.color).lerp(SKY_BLUE, 0.72);
    }
    const above = clamp01((u.uSunDir.value.y + 0.12) / 0.5);
    // night: drop the ambient body light so the sea goes ink, not grey
    u.uAmbient.value = 0.16 + 0.84 * above;

    // Irradiance the water body is standing in: direct sun by elevation plus a
    // sky-dome term. Tuned so noon water sits alongside the sunlit sand rather
    // than a stop and a half under it.
    const direct = sunIntensity * 0.26 * Math.max(u.uSunDir.value.y, 0);
    const sky = 0.55 * (0.25 + 0.75 * above);
    u.uLight.value.copy(u.uSunCol.value).multiplyScalar(direct);
    u.uLight.value.r += u.uSkyZenith.value.r * sky;
    u.uLight.value.g += u.uSkyZenith.value.g * sky;
    u.uLight.value.b += u.uSkyZenith.value.b * sky;
    // never let it collapse to black; moonlit water still reads
    const lum = u.uLight.value.r * 0.3 + u.uLight.value.g * 0.6 + u.uLight.value.b * 0.1;
    if (lum < 0.1) u.uLight.value.setScalar(0.1);
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    const spec = TIERS[tier];
    this.uniforms.uDetailOn.value = spec.detail ? 1 : 0;
    this.uniforms.uRadius.value = spec.radius;
    const old = this.geo;
    this.geo = buildDisc(spec.radius, spec.rings, spec.segments);
    this._tris = (this.geo.index?.count ?? 0) / 3;
    if (this.mesh) this.mesh.geometry = this.geo;
    old?.dispose();
  }

  stats(): Record<string, number> {
    return { oceanTriangles: this._tris, oceanDrawCalls: 1 };
  }

  dispose(): void {
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
    this.geo?.dispose();
    this.material?.dispose();
    this.depthTex?.dispose();
    this.detailTex?.dispose();
    this.geo = null;
    this.material = null;
    this.depthTex = null;
    this.detailTex = null;
    this.mesh = null;
    this.group.removeFromParent();
    this.group.clear();
  }
}

const SKY_BLUE = new THREE.Color().setHex(0x3d7fc4, THREE.SRGBColorSpace);
const WHITE = new THREE.Color(1, 1, 1);

/* ------------------------------------------------------------------ geometry */

/**
 * Radial disc, exponentially graded: the innermost ring is ~1.5 m across and
 * the outermost spans hundreds of metres, which is exactly where the pixels
 * are. Centre is a fan so there is no hole under the camera.
 */
function buildDisc(radius: number, rings: number, segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];

  pos.push(0, 0, 0); // centre
  const ringStart: number[] = [];
  // geometric ring spacing: 1.2 m at the camera, growing ~16 % a ring, so the
  // near field gets sub-metre wave detail and the horizon costs almost nothing
  const r0 = 1.2;
  const growth = Math.pow(radius / r0, 1 / Math.max(1, rings - 1));
  for (let r = 1; r <= rings; r++) {
    const rad = r0 * Math.pow(growth, r - 1);
    ringStart.push(pos.length / 3);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }

  // Winding: vertices run counter-clockwise in XZ as the angle increases, so
  // the triangles have to be emitted in reverse to face +Y. Getting this
  // backwards makes the entire sea back-face cull, and what you are then
  // looking at is the sky dome's below-horizon colour — which is close enough
  // to plausible water that it does not read as a bug.
  for (let s = 0; s < segments; s++) {
    const a = ringStart[0] + s;
    const b = ringStart[0] + ((s + 1) % segments);
    idx.push(0, b, a);
  }
  for (let r = 0; r < rings - 1; r++) {
    const i0 = ringStart[r];
    const i1 = ringStart[r + 1];
    for (let s = 0; s < segments; s++) {
      const sn = (s + 1) % segments;
      idx.push(i0 + s, i1 + sn, i1 + s);
      idx.push(i0 + s, i0 + sn, i1 + sn);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius * 1.2);
  return g;
}

/* --------------------------------------------------------------- textures */

/**
 * Bake the district's terrain into a depth field.
 *
 * R = water depth / DEPTH_RANGE, G = land height / LAND_RANGE (they are
 * mutually exclusive), B = a world-locked noise the shore foam breaks up with.
 */
function buildBathymetry(
  layout: CityLayout,
  w: number,
  h: number,
  fieldOut: THREE.Vector4,
): THREE.DataTexture {
  const minX = DISTRICT_BOUNDS.minX - FIELD_PAD;
  const maxX = DISTRICT_BOUNDS.maxX + FIELD_PAD;
  const minZ = DISTRICT_BOUNDS.minZ - FIELD_PAD;
  const maxZ = DISTRICT_BOUNDS.maxZ + FIELD_PAD;
  fieldOut.set(minX, minZ, 1 / (maxX - minX), 1 / (maxZ - minZ));

  const data = new Uint8Array(w * h * 4);
  const inMinX = DISTRICT_BOUNDS.minX + 2;
  const inMaxX = DISTRICT_BOUNDS.maxX - 2;
  const inMinZ = DISTRICT_BOUNDS.minZ + 2;
  const inMaxZ = DISTRICT_BOUNDS.maxZ - 2;

  for (let j = 0; j < h; j++) {
    const z = minZ + ((j + 0.5) / h) * (maxZ - minZ);
    for (let i = 0; i < w; i++) {
      const x = minX + ((i + 0.5) / w) * (maxX - minX);
      const inside = x > inMinX && x < inMaxX && z > inMinZ && z < inMaxZ;
      // inside the district the carved height field is authoritative; outside
      // it, the analytic profile still gives a plausible sea floor
      const y = inside ? layout.groundHeight(x, z) : baseTerrain(x, z);
      const depth = SEA_LEVEL - y;
      const o = (j * w + i) * 4;
      data[o] = Math.round(clamp01(depth / DEPTH_RANGE) * 255);
      data[o + 1] = Math.round(clamp01(-depth / LAND_RANGE) * 255);
      data[o + 2] = Math.round(clamp01(fbm2D(x * 0.05, z * 0.05, 3, 8123) * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/bathymetry';
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A tiling ripple normal map. Two crossed sets of stretched wavelets plus fbm
 * chop — enough structure that the glitter breaks into discrete sparkles
 * instead of a smeared highlight.
 */
function buildDetailNormal(size: number): THREE.DataTexture {
  const height = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      // periodic coordinates so the tile is seamless
      const ang1 = (u * 7 + v * 3) * Math.PI * 2;
      const ang2 = (u * -4 + v * 9) * Math.PI * 2;
      let e = Math.sin(ang1) * 0.36 + Math.sin(ang2) * 0.3;
      e += Math.sin((u * 17 - v * 11) * Math.PI * 2) * 0.13;
      e += fbm2D(u * 8, v * 8, 3, 3301) * 0.42;
      e += valueNoise2D(u * 26, v * 26, 771) * 0.1;
      height[j * size + i] = e;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const wrap = (v: number): number => ((v % size) + size) % size;
  const at = (x: number, y: number): number => height[wrap(y) * size + wrap(x)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x - 1, y) - at(x + 1, y);
      const dy = at(x, y - 1) - at(x, y + 1);
      let nx = dx * 2.4;
      let nz = dy * 2.4;
      let ny = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const o = (y * size + x) * 4;
      // stored as xyz with y up, sampled directly as a world-space nudge
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/oceanDetail';
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
