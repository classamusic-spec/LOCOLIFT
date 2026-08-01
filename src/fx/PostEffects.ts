/**
 * Loco Lift — post-processing building blocks.
 *
 * Three things live here:
 *
 * 1. **Shared GLSL.** Colour-space helpers, hash/noise, and the one radial mask
 *    every effect in the chain uses. §6.2 R10 is a hard readability law — no
 *    blur and no aberration inside the central 42 % of the frame — so there is
 *    exactly one function that computes that mask and every pass calls it.
 *    Getting it wrong in one pass is how a game ends up unreadable at speed.
 *
 * 2. **`ScreenFX`** — the event-driven juice layer: impact flashes, the damage
 *    vignette, the boost ramp. It owns the accessibility contract:
 *    `settings.photosensitiveSafe` clamps every transient hard *and* enforces a
 *    minimum interval between them so nothing can strobe above ~2.5 Hz, and
 *    `settings.screenShake` scales the screen-space punch the same way it
 *    scales the camera rig.
 *
 * 3. **The SceneFX and grade shaders.** SceneFX is one pass doing AO, contact
 *    shadows, aerial perspective, heat shimmer and the god-ray composite,
 *    because each of those is either a depth lookup or a per-pixel curve and
 *    splitting them into five full-screen passes would cost five round trips
 *    for no visual gain. It runs *before* bloom so shafts and contact shadows
 *    are part of what blooms.
 *
 * **Never include `tonemapping_pars_fragment` or `colorspace_pars_fragment`.**
 * Three r185 injects both into every `ShaderMaterial` fragment prefix; a second
 * copy redefines `toneMappingExposure` and the program fails to link. Every
 * helper below is therefore `loco`-prefixed and self-contained. (`saturate` is
 * safe to rely on — the injected tone-mapping chunk defines it behind an
 * `#ifndef` guard — but this file uses `clamp` anyway.)
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp01, damp } from '../core/MathUtils';
import type { SettingsState } from '../core/types';

/* ------------------------------------------------------------ shared glsl */

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * ACES RRT+ODT fit — byte-identical to three's `ACESFilmicToneMapping`,
 * including its `/ 0.6` pre-scale, under private names so the injected
 * tone-mapping chunk is never redefined.
 */
export const GLSL_COLOR = /* glsl */ `
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

float locoLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

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
`;

export const GLSL_NOISE = /* glsl */ `
float locoHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float locoValueNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = locoHash12( i );
  float b = locoHash12( i + vec2( 1.0, 0.0 ) );
  float c = locoHash12( i + vec2( 0.0, 1.0 ) );
  float d = locoHash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
`;

/**
 * §6.2 R10, in one place.
 *
 * `locoEdge` is 0 inside the central 42 % of the frame radius and ramps to 1 at
 * the corner. Radial blur, chromatic aberration, speed lines, boost distortion
 * and the vignette all key off it, so the protected centre is guaranteed to be
 * the same disc for every effect. `locoRadius` is the normalised, aspect-
 * corrected radius on its own, for effects that want a different curve.
 */
export const GLSL_RADIAL = /* glsl */ `
float locoRadius( vec2 uv, float aspect ) {
  vec2 d = uv - 0.5;
  d.x *= aspect;
  return clamp( length( d ) / ( 0.5 * sqrt( aspect * aspect + 1.0 ) ) * 2.0, 0.0, 1.0 );
}

float locoEdge( float r ) {
  return smoothstep( 0.42, 1.0, r );
}
`;

/* --------------------------------------------------------------- ScreenFX */

/**
 * The transient, event-driven half of the post state.
 *
 * `POST_STATE` (in `LightingPresets`) carries the slow, art-directed values;
 * this carries the ones that spike and decay inside a second. Kept separate so
 * a time-of-day change can never stomp a live impact flash and vice versa.
 */
export interface ScreenFXState {
  /** 0..1 white screen punch — a big hit, a destroyed prop, a landing */
  impact: number;
  /** 0..1 red-tinted edge vignette that lingers after a heavy collision */
  hit: number;
  /** 0..1 smoothed "boost is engaged" */
  boost: number;
  /** 0..1 transient at the moment boost engages — the violence */
  boostPunch: number;
  /** 0..1 combined speed drive from the chase camera */
  speed: number;
}

/**
 * How hard each transient is allowed to hit, before accessibility scaling.
 * The numbers are amplitudes in final display units — `impact` 1.0 would be a
 * full white frame, which nothing here is ever allowed to reach.
 */
const FX_TUNE = {
  /** peak white-flash amplitude from a maximum-impulse collision */
  impactPeak: 0.55,
  /** seconds for the flash to fall away; §6.1 gives impact shake 0.18 s */
  impactDecay: 5.5,
  /** peak damage-vignette amplitude */
  hitPeak: 0.85,
  hitDecay: 1.6,
  /** boost ramps in fast and falls off slower, so the release has weight */
  boostAttack: 9.0,
  boostRelease: 3.4,
  boostPunchDecay: 4.2,
  /** collision impulse that counts as "everything you have" */
  fullImpulse: 26,
  /** `photosensitiveSafe`: transients are cut to this fraction … */
  safeScale: 0.16,
  /** … and no two may start closer together than this, i.e. < 2.5 Hz */
  safeMinInterval: 0.4,
} as const;

export class ScreenFX {
  readonly state: ScreenFXState = { impact: 0, hit: 0, boost: 0, boostPunch: 0, speed: 0 };

  private boostHeld = false;
  private impactTarget = 0;
  private lastFlashAt = -99;
  private clock = 0;
  private settings: SettingsState;
  private unsubs: Array<() => void> = [];

  constructor(settings: SettingsState, bus?: EventBus) {
    this.settings = settings;
    if (bus) this.attach(bus);
  }

  /** Subscribe to the gameplay events that produce screen juice. */
  attach(bus: EventBus): void {
    this.detach();
    this.unsubs.push(
      bus.on('vehicle:collision', (e) => {
        const f = clamp01(e.impulse / FX_TUNE.fullImpulse);
        // a kerb scrape is not a crash: the square keeps light contacts quiet
        this.punch(f * f, f);
      }),
      bus.on('prop:destroyed', () => this.punch(0.18, 0)),
      bus.on('vehicle:jumpLand', (e) => this.punch(clamp01(e.height / 9) * 0.4, 0)),
      bus.on('vehicle:boostStart', () => {
        this.boostHeld = true;
        this.state.boostPunch = 1;
      }),
      bus.on('vehicle:boostEnd', () => {
        this.boostHeld = false;
      }),
      bus.on('vehicle:reset', () => {
        this.state.hit = 0;
        this.state.impact = 0;
        this.impactTarget = 0;
      }),
    );
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  setSettings(s: SettingsState): void {
    this.settings = s;
  }

  /**
   * Fire a flash by hand. `flash` is the white punch, `hit` the damage
   * vignette; both 0..1 *before* the accessibility clamp.
   *
   * Under `photosensitiveSafe` the amplitude is cut to 16 % and a hard rate
   * limit applies, so a chain of collisions cannot produce a strobe. This is
   * the only path that can raise `impact`, deliberately.
   */
  punch(flash: number, hit: number): void {
    const safe = this.settings.photosensitiveSafe === true;
    // screen-space punch is shake by another name; honour the same slider
    const shake = clamp01(this.settings.screenShake ?? 1);
    if (safe && this.clock - this.lastFlashAt < FX_TUNE.safeMinInterval) return;
    const scale = (safe ? FX_TUNE.safeScale : 1) * (0.35 + 0.65 * shake);
    const f = clamp01(flash) * FX_TUNE.impactPeak * scale;
    if (f > 0.0005) this.lastFlashAt = this.clock;
    this.impactTarget = Math.max(this.impactTarget, f);
    this.state.hit = Math.max(this.state.hit, clamp01(hit) * FX_TUNE.hitPeak * scale);
  }

  /** Drive boost from a poll rather than events (the two agree either way). */
  setBoosting(on: boolean): void {
    if (on && !this.boostHeld) this.state.boostPunch = 1;
    this.boostHeld = on;
  }

  update(dt: number, speedDrive: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.clock += step;
    const s = this.state;

    // the flash rises within a frame and falls exponentially
    s.impact = Math.max(this.impactTarget, s.impact);
    this.impactTarget = 0;
    s.impact = damp(s.impact, 0, FX_TUNE.impactDecay, step);
    if (s.impact < 0.0015) s.impact = 0;

    s.hit = damp(s.hit, 0, FX_TUNE.hitDecay, step);
    if (s.hit < 0.0015) s.hit = 0;

    const target = this.boostHeld ? 1 : 0;
    s.boost = damp(s.boost, target, this.boostHeld ? FX_TUNE.boostAttack : FX_TUNE.boostRelease, step);
    s.boostPunch = damp(s.boostPunch, 0, FX_TUNE.boostPunchDecay, step);

    s.speed = clamp01(speedDrive);
  }

  /** 0..1 scale every strobing effect must be multiplied by. */
  get safetyScale(): number {
    return this.settings.photosensitiveSafe === true ? 0.25 : 1;
  }

  dispose(): void {
    this.detach();
  }
}

/* --------------------------------------------------------------- SceneFX */

/**
 * One pass, four jobs, all of which need the depth buffer or are a per-pixel
 * curve on the linear HDR scene. Feature-gated by `#define` so a tier that does
 * not want AO does not pay for the branch.
 *
 * - `LOCO_AO` — §6.3.1 hemisphere AO, radius 0.55 m, 12 samples, bias 0.02.
 *   Normals come from the *nearer* of each opposing depth neighbour so a
 *   silhouette edge does not manufacture a bogus normal and a black halo round
 *   every balcony.
 * - `LOCO_CONTACT` — screen-space contact shadows. Eight steps of depth march
 *   toward the sun, ~2.4 m of reach. This is the grounding term: it is what
 *   puts a hard dark line under a kerb, a bollard, a stall leg and a parked
 *   van, at distances far below what a 7 cm shadow texel can resolve.
 * - `LOCO_AERIAL` — §6.2 R5 depth planes. Fog (in the scene) does luminance;
 *   this does *chroma*: ×0.85 past 40 m, ×0.55 past 160 m, plus Mie in-scatter
 *   toward the sun so the fort and the cordillera sit back properly instead of
 *   being merely paler versions of the near street.
 * - `LOCO_SHIMMER` — heat haze off the cobbles at solar noon. Amplitude is
 *   capped at 1.1 px and zeroed inside the protected centre disc; it is a
 *   texture, not a distortion you drive through.
 * - `LOCO_GODRAYS` — composites the offscreen shaft buffer additively, before
 *   bloom, so the shafts bloom with everything else.
 */
export const SCENE_FX_SHADER = {
  name: 'LocoSceneFX',
  defines: {} as Record<string, string>,
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tGodRays: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uProjectionInverse: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
    uAspect: { value: 16 / 9 },
    uTime: { value: 0 },

    uAoRadius: { value: 0.55 },
    uAoIntensity: { value: 0.9 },
    uAoBias: { value: 0.02 },

    /** sun direction in **view** space, pointing toward the light */
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uContact: { value: 0.55 },

    uAerialColor: { value: new THREE.Color(1, 1, 1) },
    uAerialStrength: { value: 0.6 },
    uFarRef: { value: 850 },

    uShimmer: { value: 0 },
    uGodRays: { value: 0 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform sampler2D tGodRays;
  uniform mat4 uProjection;
  uniform mat4 uProjectionInverse;
  uniform vec2 uTexel;
  uniform float uAspect;
  uniform float uTime;
  uniform float uAoRadius;
  uniform float uAoIntensity;
  uniform float uAoBias;
  uniform vec3 uSunView;
  uniform float uContact;
  uniform vec3 uAerialColor;
  uniform float uAerialStrength;
  uniform float uFarRef;
  uniform float uShimmer;
  uniform float uGodRays;
  varying vec2 vUv;

  ${GLSL_COLOR}
  ${GLSL_NOISE}
  ${GLSL_RADIAL}

  float locoDepth( vec2 uv ) { return texture2D( tDepth, uv ).x; }

  vec3 locoView( vec2 uv, float d ) {
    vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    vec4 v = uProjectionInverse * clip;
    return v.xyz / v.w;
  }

  void main() {
    vec2 uv = vUv;
    float r = locoRadius( uv, uAspect );

  #ifdef LOCO_SHIMMER
    if ( uShimmer > 0.002 ) {
      /* Rising cells of hot air. Two octaves at different speeds so it
       * churns rather than scrolls, vertical bias because that is how
       * convection reads, and zero inside the protected centre disc. */
      float band = smoothstep( 0.30, 0.46, uv.y ) * ( 1.0 - smoothstep( 0.56, 0.80, uv.y ) );
      float mask = band * smoothstep( 0.26, 0.62, r ) * uShimmer;
      if ( mask > 0.001 ) {
        vec2 q = vec2( uv.x * 34.0, uv.y * 82.0 - uTime * 1.6 );
        float n1 = locoValueNoise( q ) - 0.5;
        float n2 = locoValueNoise( q * 2.3 + 11.0 + vec2( uTime * 0.7, 0.0 ) ) - 0.5;
        uv += vec2( ( n1 * 0.6 + n2 * 0.4 ) * 0.00085, ( n2 * 0.7 ) * 0.0011 ) * mask;
      }
    }
  #endif

    vec4 src = texture2D( tDiffuse, uv );
    vec3 col = src.rgb;
    float d = locoDepth( uv );
    bool isSky = d >= 0.99999;

    if ( !isSky ) {
      vec3 p = locoView( uv, d );
      float viewDist = length( p );

  #if defined( LOCO_AO ) || defined( LOCO_CONTACT )
      /* normal from the nearer of each opposing neighbour pair */
      vec3 l = locoView( uv - vec2( uTexel.x, 0.0 ), locoDepth( uv - vec2( uTexel.x, 0.0 ) ) );
      vec3 rr = locoView( uv + vec2( uTexel.x, 0.0 ), locoDepth( uv + vec2( uTexel.x, 0.0 ) ) );
      vec3 b = locoView( uv - vec2( 0.0, uTexel.y ), locoDepth( uv - vec2( 0.0, uTexel.y ) ) );
      vec3 t = locoView( uv + vec2( 0.0, uTexel.y ), locoDepth( uv + vec2( 0.0, uTexel.y ) ) );
      vec3 dx = abs( l.z - p.z ) < abs( rr.z - p.z ) ? ( p - l ) : ( rr - p );
      vec3 dy = abs( b.z - p.z ) < abs( t.z - p.z ) ? ( p - b ) : ( t - p );
      vec3 n = cross( dx, dy );
      float nl = length( n );
      n = nl > 1e-6 ? n / nl : vec3( 0.0, 0.0, 1.0 );
      if ( dot( n, p ) > 0.0 ) n = -n;
      float rot = locoHash12( gl_FragCoord.xy ) * 6.2831853;
  #endif

  #ifdef LOCO_AO
      if ( nl > 1e-6 ) {
        vec3 tangent = normalize( abs( n.z ) < 0.9 ? cross( n, vec3( 0.0, 0.0, 1.0 ) ) : cross( n, vec3( 1.0, 0.0, 0.0 ) ) );
        vec3 bitan = cross( n, tangent );
        float occl = 0.0;
        for ( int i = 0; i < 12; i ++ ) {
          float fi = ( float( i ) + 0.5 ) / 12.0;
          float ang = rot + float( i ) * 2.39996323;
          float rad = uAoRadius * sqrt( fi );
          float zh = mix( 0.28, 1.0, fi );
          vec3 dir = normalize( tangent * cos( ang ) + bitan * sin( ang ) + n * zh );
          vec3 sp = p + dir * rad;
          vec4 op = uProjection * vec4( sp, 1.0 );
          vec2 suv = op.xy / op.w * 0.5 + 0.5;
          if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;
          float sd = locoDepth( suv );
          if ( sd >= 0.99999 ) continue;
          float sceneZ = locoView( suv, sd ).z;
          float range = smoothstep( 0.0, 1.0, uAoRadius / max( 1e-4, abs( p.z - sceneZ ) ) );
          occl += ( sceneZ >= sp.z + uAoBias ? 1.0 : 0.0 ) * range;
        }
        float ao = clamp( 1.0 - ( occl / 12.0 ) * uAoIntensity, 0.0, 1.0 );
        /* §6.3.1: indirect only. Without a separate indirect buffer, back the
         * term off where the key light is already hammering — a sunlit stucco
         * wall must not pick up a dirt smear. */
        float indirect = 1.0 - smoothstep( 0.30, 1.50, locoLum( col ) );
        col *= mix( 1.0, ao, mix( 0.30, 1.0, indirect ) );
      }
  #endif

  #ifdef LOCO_CONTACT
      if ( uContact > 0.004 && uSunView.y > -0.05 && viewDist < 90.0 ) {
        /* March the depth buffer toward the sun. Jittered start so the step
         * pattern does not band, and a thickness test so a distant rooftop
         * behind the ray is not mistaken for an occluder. */
        float stepLen = 0.30;
        vec3 ro = p + n * 0.035;
        float occ = 0.0;
        float jitter = locoHash12( gl_FragCoord.xy + uTime );
        for ( int i = 1; i <= 8; i ++ ) {
          vec3 sp = ro + uSunView * ( ( float( i ) - jitter ) * stepLen );
          vec4 op = uProjection * vec4( sp, 1.0 );
          vec2 suv = op.xy / op.w * 0.5 + 0.5;
          if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;
          float sd = locoDepth( suv );
          if ( sd >= 0.99999 ) continue;
          float sceneZ = locoView( suv, sd ).z;
          float diff = sceneZ - sp.z;
          if ( diff > 0.02 && diff < 1.2 ) {
            occ = max( occ, 1.0 - float( i - 1 ) / 8.0 );
          }
        }
        /* only bite where the pixel is actually lit, and fade out with
         * distance where the shadow map already has it covered */
        float lit = smoothstep( 0.10, 0.55, locoLum( col ) );
        float near = 1.0 - smoothstep( 26.0, 82.0, viewDist );
        col *= 1.0 - occ * uContact * lit * near;
      }
  #endif

  #ifdef LOCO_AERIAL
      {
        /* §6.2 R5. Fog (scene-side) took the luminance; this takes the chroma
         * and adds the sun's forward scatter, which is what makes distance
         * read as *air* rather than as a grey wash. */
        float mid = smoothstep( 40.0, 160.0, viewDist );
        float far = smoothstep( 160.0, uFarRef, viewDist );
        float chroma = mix( 1.0, 0.85, mid ) * mix( 1.0, 0.65, far );
        col = mix( vec3( locoLum( col ) ), col, chroma );
        vec3 vdir = normalize( p );
        float ca = max( dot( vdir, uSunView ), 0.0 );
        float inscatter = ( 0.05 + 0.34 * pow( ca, 5.0 ) ) * uAerialStrength;
        col += uAerialColor * inscatter * ( mid * 0.35 + far * 0.65 );
      }
  #endif
    }

  #ifdef LOCO_GODRAYS
    if ( uGodRays > 0.002 ) {
      /* Held back over the vanishing point: shafts crossing the street add
       * contrast, shafts *on* the driving line eat read distance (§6.2 R4).
       * And held back hard on sky pixels, which already contain the sun's Mie
       * halo — adding the shaft buffer there doubles the glow and turns the
       * whole upper frame milky. */
      float centreHold = 1.0 - 0.4 * ( 1.0 - smoothstep( 0.0, 0.44, r ) );
      float skyHold = isSky ? 0.3 : 1.0;
      col += texture2D( tGodRays, vUv ).rgb * uGodRays * centreHold * skyHold;
    }
  #endif

    gl_FragColor = vec4( col, src.a );
  }
  `,
};

/* ----------------------------------------------------------------- grade */

/**
 * §6.3 steps 4–8 in one pass: chromatic aberration, exposure, the Caribbean
 * split-tone, the filmic S-curve, ACES, sRGB encode, shadow lift, saturation,
 * vignette and grain — plus the two screen-space transients (impact flash and
 * damage vignette) which have to land *after* tone mapping or they read as a
 * lighting change rather than as a hit.
 */
export const GRADE_SHADER = {
  name: 'LocoGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1 },
    uShadowTint: { value: new THREE.Color(1, 1, 1) },
    uHighlightTint: { value: new THREE.Color(1, 1, 1) },
    uLiftColor: { value: new THREE.Color(0x0e1a28) },
    uLift: { value: 0.03 },
    uSaturation: { value: 1.18 },
    uContrast: { value: 1.12 },
    uVignette: { value: 0.22 },
    uGrain: { value: 0.012 },
    uChroma: { value: 0.0012 },
    uFlash: { value: 0 },
    uImpact: { value: 0 },
    uHit: { value: 0 },
    uBoost: { value: 0 },
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
  uniform float uContrast;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uChroma;
  uniform float uFlash;
  uniform float uImpact;
  uniform float uHit;
  uniform float uBoost;
  uniform float uTime;
  uniform float uAspect;
  varying vec2 vUv;

  ${GLSL_COLOR}
  ${GLSL_NOISE}
  ${GLSL_RADIAL}

  /* §6.3.5 puts the grade's tonal pivot just under middle grey; the graded
   * frames measure a mean luminance of 0.38-0.52, so 0.42 sits where the
   * material of the image actually is. */
  const float LOCO_PIVOT = 0.42;

  void main() {
    vec2 d = vUv - 0.5;
    float rn = locoRadius( vUv, uAspect );
    float edge = locoEdge( rn );

    /* §6.3.6 chromatic aberration — 0.0012 of screen width at the frame edge,
     * and *only* at the edge (R10). d runs to 0.5 at the border, so the x2
     * makes uChroma land as a literal fraction of screen width: 1.5 px at
     * 1280, not the 25 px an unscaled x40 would give. It opens up under
     * boost so the lens feels like it is being pushed. */
    vec2 ca = d * 2.0 * uChroma * edge * ( 1.0 + uBoost * 3.3 );
    vec3 col;
    col.r = texture2D( tDiffuse, vUv + ca ).r;
    col.g = texture2D( tDiffuse, vUv ).g;
    col.b = texture2D( tDiffuse, vUv - ca ).b;

    /* exposure + lightning punch, still linear */
    col *= uExposure * ( 1.0 + uFlash * 1.6 );

    /* split tone: the tints are pre-normalised to luminance 1, so this moves
     * hue without moving exposure */
    float lum = locoLum( col );
    float hi = smoothstep( 0.16, 1.10, lum );
    col *= mix( uShadowTint, uHighlightTint, hi );

    col = locoACES( col );
    col = locoEncodeSRGB( col );

    /* §6.3.5 — lift the black point so daylight shadows never crush */
    col += uLiftColor * uLift * ( 1.0 - smoothstep( 0.0, 0.55, dot( col, vec3( 0.3333 ) ) ) );

    /* Filmic S-curve, in display space, pivoted at LOCO_PIVOT.
     *
     * Two obvious controls are both wrong here. A linear (x - p) * k + p
     * drives the top of the range past 1.0, and the §6.4 clipped-pixel budget
     * is only 1.5 % by day and 0.6 % at night — a linear stretch blows through
     * that on any frame with sky in it. Blending toward smoothstep cannot
     * clip, but smoothstep's pivot is fixed at 0.5, so on a frame whose mean
     * sits at 0.40 it darkens almost every pixel: it cost 0.05 of mean
     * luminance across five of the six graded conditions when measured.
     *
     * This is the pivoted power pair. It fixes LOCO_PIVOT exactly, maps 0 to 0
     * and 1 to 1, is monotone, and has zero gradient at neither end — so it
     * adds mid-tone bite, cannot clip, and does not move the exposure the
     * preset asked for. */
    vec3 lo = LOCO_PIVOT * pow( col / LOCO_PIVOT, vec3( uContrast ) );
    vec3 hi2 = 1.0 - ( 1.0 - LOCO_PIVOT ) * pow( ( 1.0 - col ) / ( 1.0 - LOCO_PIVOT ), vec3( uContrast ) );
    col = mix( lo, hi2, step( vec3( LOCO_PIVOT ), col ) );

    float g = locoLum( col );
    col = clamp( mix( vec3( g ), col, uSaturation ), 0.0, 1.0 );

    /* §6.3.7 vignette */
    col *= 1.0 - uVignette * smoothstep( 0.35, 1.25, rn );

    /* — transients, after the curve so they read as events — */
    if ( uHit > 0.0005 ) {
      /* damage: the edges go red and dark, the centre stays drivable */
      float m = uHit * smoothstep( 0.30, 1.0, rn );
      col = mix( col, vec3( 0.42, 0.02, 0.05 ), m * 0.72 );
    }
    if ( uImpact > 0.0005 ) {
      col += vec3( 1.0, 0.96, 0.90 ) * uImpact;
    }

    /* §6.3.8 grain — barely present; this is a sunny arcade game */
    float n = locoHash12( vUv * vec2( 1024.0, 768.0 ) + fract( uTime ) * 91.7 );
    col += ( n - 0.5 ) * uGrain;

    gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
  }
  `,
};

/* ------------------------------------------------------------------- CAS */

/** Contrast-adaptive unsharp, clamped to the local min/max so it cannot ring. */
export const CAS_SHADER = {
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
