/**
 * Loco Lift — time-of-day lighting presets.
 *
 * The eight anchors from `docs/ART_REFERENCE.md` §4.2 as typed data, plus the
 * continuous 0–24 h interpolator every visual module drives off. Nothing here
 * touches Three.js scene objects: it is pure data + math, so a head-less test
 * can sweep the whole clock and assert the curve.
 *
 * Sun angles use the reference convention (§4.1):
 *   `az = 0` is over −Z (the Atlantic), increasing **clockwise seen from above**,
 *   so `az = 90°` is over +X and `az = 270°` over −X.
 * `directionFromAzEl` converts that to a world-space unit vector pointing
 * *toward* the light. A world azimuth offset (derived from the road graph's
 * dominant street bearing, see `Lighting`) is added on the way out so golden
 * hour rakes down the calles largas without rotating the city.
 *
 * Numbers marked "§4.2" are verbatim from the reference table and must not be
 * "improved" without changing the reference first. The extra channels —
 * ambient, bounce, env intensity, sky/cloud/star colours, lamp level — are this
 * module's own, and exist because the reference's hemisphere fill alone crushes
 * shadowed ground to black at low sun elevation (the exact defect §8.36/§8.42
 * name).
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smootherstep } from '../core/MathUtils';

/** Mirrors `World`'s weather union; re-exported there so there is one source. */
export type SkyWeather = 'clear' | 'rain' | 'storm' | 'sunset' | 'night';

/* ------------------------------------------------------------------ types */

export interface LightingPreset {
  readonly key: string;
  /** canonical hour on the 24 h clock */
  readonly hour: number;

  /* — key light (sun by day, moon by night) — */
  /** degrees, reference frame (§4.1) */
  readonly sunAz: number;
  /** degrees above the horizon; negative = below */
  readonly sunEl: number;
  readonly sunColor: number;
  readonly sunIntensity: number;

  /* — fill — */
  readonly hemiSky: number;
  readonly hemiGround: number;
  readonly hemiIntensity: number;
  readonly ambientColor: number;
  readonly ambientIntensity: number;
  /** warm light bounced off the sunlit wall/ground opposite (§8.42) */
  readonly bounceColor: number;
  readonly bounceIntensity: number;
  /** `scene.environmentIntensity` for the sky IBL capture */
  readonly envIntensity: number;

  /* — atmosphere — */
  readonly fogColor: number;
  readonly fogDensity: number;

  /* — post — */
  readonly exposure: number;
  readonly bloomStrength: number;
  readonly bloomThreshold: number;

  /* — sky dome — */
  readonly skyZenith: number;
  readonly skyHorizon: number;
  /** the band within ~6° of the horizon (§4.2 note) */
  readonly skyBand: number;
  /** below the horizon — sea haze; kept close to the fog colour (§8.43) */
  readonly skyGround: number;
  /** radiance multiplier on the sun disc; drives how hard it blooms */
  readonly sunDisc: number;
  /** Mie forward-scatter strength around the sun */
  readonly haze: number;

  /* — clouds — */
  readonly cloudCover: number;
  readonly cloudLit: number;
  readonly cloudShade: number;
  readonly cloudOpacity: number;

  /* — night sky — */
  readonly starIntensity: number;
  readonly moonIntensity: number;
  readonly moonAz: number;
  readonly moonEl: number;

  /* — artificial light master fade (lamps, window glow) — */
  readonly lampLevel: number;
  /** 0 = full night, 1 = full day. Drives weather desaturation. */
  readonly dayFactor: number;
}

/**
 * The interpolated result. Allocated once per consumer and mutated in place —
 * `evaluateLighting` never allocates, so it is safe to call every frame.
 */
export interface LightingState {
  hour: number;
  weather: SkyWeather;
  weatherAmount: number;

  sunAz: number;
  sunEl: number;
  /** world-space unit vector pointing toward the key light */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;

  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  bounceColor: THREE.Color;
  bounceIntensity: number;
  /** world-space unit vector pointing toward the bounce fill */
  bounceDir: THREE.Vector3;
  envIntensity: number;

  fogColor: THREE.Color;
  fogDensity: number;

  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;

  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  skyBand: THREE.Color;
  skyGround: THREE.Color;
  sunDisc: number;
  haze: number;

  cloudCover: number;
  cloudLit: THREE.Color;
  cloudShade: THREE.Color;
  cloudOpacity: number;

  starIntensity: number;
  moonIntensity: number;
  moonDir: THREE.Vector3;

  lampLevel: number;
  dayFactor: number;
  /** 0 = dry, 1 = streaming — the weather system's authoritative wet drive */
  rainAmount: number;
}

/* ---------------------------------------------------------------- presets */

/**
 * Eight anchors. Seven are the §4.2 time-of-day rows verbatim; `midnight` is
 * added so the clock closes smoothly across 00:00 (interpolating `night` →
 * `dawn` directly would drag the moon backwards through the sky).
 */
export const PRESETS: readonly LightingPreset[] = [
  {
    key: 'midnight',
    hour: 1.5,
    sunAz: 188,
    sunEl: 56,
    sunColor: 0x93a9cf,
    sunIntensity: 0.22,
    hemiSky: 0x1a2740,
    hemiGround: 0x0f1116,
    hemiIntensity: 0.3,
    ambientColor: 0x2a3a56,
    ambientIntensity: 0.16,
    bounceColor: 0x232c40,
    bounceIntensity: 0.08,
    envIntensity: 0.42,
    fogColor: 0x0c1320,
    fogDensity: 0.0036,
    exposure: 1.28,
    bloomStrength: 1.15,
    bloomThreshold: 0.52,
    skyZenith: 0x03060f,
    skyHorizon: 0x0a1226,
    skyBand: 0x101a30,
    skyGround: 0x05080e,
    sunDisc: 0.0,
    haze: 0.3,
    cloudCover: 0.26,
    cloudLit: 0x2a3550,
    cloudShade: 0x0b1020,
    cloudOpacity: 0.7,
    starIntensity: 1.0,
    moonIntensity: 1.0,
    moonAz: 188,
    moonEl: 56,
    lampLevel: 1,
    dayFactor: 0,
  },
  {
    key: 'dawn',
    hour: 6.25,
    sunAz: 92,
    sunEl: 3,
    sunColor: 0xffb27a,
    sunIntensity: 1.6,
    hemiSky: 0x6e86b8,
    hemiGround: 0x4a3e38,
    hemiIntensity: 0.55,
    ambientColor: 0x6b6f8c,
    ambientIntensity: 0.3,
    bounceColor: 0xb07048,
    bounceIntensity: 0.4,
    envIntensity: 0.72,
    fogColor: 0xc9a98f,
    fogDensity: 0.0022,
    exposure: 1.05,
    bloomStrength: 0.55,
    bloomThreshold: 0.78,
    skyZenith: 0x1e3e77,
    skyHorizon: 0xf0a878,
    skyBand: 0xff7a47,
    skyGround: 0x33291f,
    sunDisc: 9.0,
    haze: 1.35,
    cloudCover: 0.34,
    cloudLit: 0xffc79a,
    cloudShade: 0x5e4a5e,
    cloudOpacity: 0.92,
    starIntensity: 0.12,
    moonIntensity: 0.18,
    moonAz: 268,
    moonEl: 12,
    lampLevel: 0.45,
    dayFactor: 0.38,
  },
  {
    key: 'morning',
    hour: 9.0,
    sunAz: 128,
    sunEl: 42,
    sunColor: 0xfff0d6,
    sunIntensity: 2.9,
    hemiSky: 0x9ec4e8,
    hemiGround: 0x7a6a54,
    hemiIntensity: 0.75,
    ambientColor: 0x9db4cc,
    ambientIntensity: 0.26,
    bounceColor: 0xc9a070,
    bounceIntensity: 0.48,
    envIntensity: 0.8,
    fogColor: 0xbfd8e8,
    fogDensity: 0.0011,
    exposure: 1.0,
    bloomStrength: 0.35,
    bloomThreshold: 0.85,
    skyZenith: 0x2a6fbe,
    skyHorizon: 0xcde4f4,
    skyBand: 0xe8f2f8,
    skyGround: 0x4a565c,
    sunDisc: 16.0,
    haze: 0.72,
    cloudCover: 0.36,
    cloudLit: 0xfff8ee,
    cloudShade: 0x8fa2b8,
    cloudOpacity: 0.95,
    starIntensity: 0,
    moonIntensity: 0,
    moonAz: 300,
    moonEl: -20,
    lampLevel: 0,
    dayFactor: 1,
  },
  {
    key: 'midday',
    hour: 12.5,
    sunAz: 176,
    sunEl: 78,
    sunColor: 0xfff8ec,
    sunIntensity: 3.6,
    hemiSky: 0xa9cff0,
    hemiGround: 0x8a7a62,
    hemiIntensity: 0.9,
    ambientColor: 0xa8c0d6,
    ambientIntensity: 0.24,
    bounceColor: 0xc8b48e,
    bounceIntensity: 0.55,
    envIntensity: 0.85,
    fogColor: 0xc6dcec,
    fogDensity: 0.0009,
    exposure: 0.95,
    bloomStrength: 0.28,
    bloomThreshold: 0.9,
    skyZenith: 0x2e7bc4,
    skyHorizon: 0xbfe0f2,
    skyBand: 0xd8ecf7,
    skyGround: 0x4c5a5e,
    sunDisc: 18.0,
    haze: 0.6,
    cloudCover: 0.33,
    cloudLit: 0xfffdf6,
    cloudShade: 0x93a8c0,
    cloudOpacity: 0.96,
    starIntensity: 0,
    moonIntensity: 0,
    moonAz: 356,
    moonEl: -40,
    lampLevel: 0,
    dayFactor: 1,
  },
  {
    key: 'afternoon',
    hour: 15.5,
    sunAz: 226,
    sunEl: 50,
    sunColor: 0xffe9c2,
    sunIntensity: 3.1,
    hemiSky: 0x9cc3e6,
    hemiGround: 0x836f55,
    hemiIntensity: 0.78,
    ambientColor: 0x9fb6cc,
    ambientIntensity: 0.26,
    bounceColor: 0xc79a63,
    bounceIntensity: 0.52,
    envIntensity: 0.82,
    fogColor: 0xc4d9e6,
    fogDensity: 0.0012,
    exposure: 1.0,
    bloomStrength: 0.38,
    bloomThreshold: 0.85,
    skyZenith: 0x2d74bc,
    skyHorizon: 0xc6dff0,
    skyBand: 0xe6dcc8,
    skyGround: 0x4a5658,
    sunDisc: 16.0,
    haze: 0.78,
    cloudCover: 0.4,
    cloudLit: 0xfff6e6,
    cloudShade: 0x8d9fb6,
    cloudOpacity: 0.95,
    starIntensity: 0,
    moonIntensity: 0,
    moonAz: 46,
    moonEl: -18,
    lampLevel: 0,
    dayFactor: 1,
  },
  {
    key: 'golden',
    hour: 18.25,
    sunAz: 268,
    sunEl: 8,
    sunColor: 0xff9e4d,
    sunIntensity: 2.4,
    hemiSky: 0x7fa8d8,
    hemiGround: 0x6b4e3a,
    hemiIntensity: 0.6,
    ambientColor: 0x8b7f8c,
    ambientIntensity: 0.34,
    bounceColor: 0xc4622c,
    bounceIntensity: 0.62,
    envIntensity: 0.78,
    fogColor: 0xe8a56b,
    fogDensity: 0.0018,
    exposure: 1.08,
    bloomStrength: 0.7,
    bloomThreshold: 0.8,
    skyZenith: 0x2a4e86,
    skyHorizon: 0xffb35c,
    skyBand: 0xff6b3d,
    skyGround: 0x3c2c22,
    sunDisc: 11.0,
    haze: 1.5,
    cloudCover: 0.38,
    cloudLit: 0xffd39a,
    cloudShade: 0x6a4e63,
    cloudOpacity: 0.95,
    starIntensity: 0,
    moonIntensity: 0.15,
    moonAz: 92,
    moonEl: 16,
    lampLevel: 0.2,
    dayFactor: 0.62,
  },
  {
    key: 'dusk',
    hour: 19.083,
    sunAz: 272,
    sunEl: -4,
    sunColor: 0xc4623c,
    sunIntensity: 0.5,
    hemiSky: 0x4a6a9e,
    hemiGround: 0x2c2e3a,
    hemiIntensity: 0.5,
    ambientColor: 0x5a5a78,
    ambientIntensity: 0.3,
    bounceColor: 0x7a4a4a,
    bounceIntensity: 0.3,
    envIntensity: 0.7,
    fogColor: 0x7a6a86,
    fogDensity: 0.0026,
    exposure: 1.15,
    bloomStrength: 0.9,
    bloomThreshold: 0.7,
    skyZenith: 0x16233f,
    skyHorizon: 0xa8665f,
    skyBand: 0xe0705a,
    skyGround: 0x1e1a24,
    sunDisc: 3.0,
    haze: 1.6,
    cloudCover: 0.36,
    cloudLit: 0xd8829a,
    cloudShade: 0x3a3050,
    cloudOpacity: 0.92,
    starIntensity: 0.22,
    moonIntensity: 0.45,
    moonAz: 118,
    moonEl: 28,
    lampLevel: 0.75,
    dayFactor: 0.16,
  },
  {
    key: 'night',
    hour: 22.0,
    sunAz: 210,
    sunEl: 38,
    sunColor: 0x9fb4d8,
    sunIntensity: 0.28,
    hemiSky: 0x22304c,
    hemiGround: 0x14161c,
    hemiIntensity: 0.32,
    ambientColor: 0x33455f,
    ambientIntensity: 0.2,
    bounceColor: 0x2a3348,
    bounceIntensity: 0.1,
    envIntensity: 0.48,
    fogColor: 0x101828,
    fogDensity: 0.0034,
    exposure: 1.25,
    bloomStrength: 1.1,
    bloomThreshold: 0.55,
    skyZenith: 0x050b1c,
    skyHorizon: 0x101b33,
    skyBand: 0x18243c,
    skyGround: 0x070a12,
    sunDisc: 0.0,
    haze: 0.34,
    cloudCover: 0.28,
    cloudLit: 0x33405e,
    cloudShade: 0x0d1424,
    cloudOpacity: 0.75,
    starIntensity: 1.0,
    moonIntensity: 1.0,
    moonAz: 210,
    moonEl: 38,
    lampLevel: 1,
    dayFactor: 0,
  },
];

/** Preset lookup by key, for tests and debug UI. */
export const PRESET_BY_KEY: Readonly<Record<string, LightingPreset>> = (() => {
  const m: Record<string, LightingPreset> = {};
  for (const p of PRESETS) m[p.key] = p;
  return m;
})();

/* ------------------------------------------------------- weather variants */

interface WeatherVariant {
  sunColor: number;
  /** multiplies the inherited sun intensity (§4.2) */
  sunScale: number;
  /** the sun is pushed up to at least this elevation while it is above the horizon */
  minElevation: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  bounceScale: number;
  envScale: number;
  fogColor: number;
  fogDensity: number;
  exposure: number;
  bloomStrength: number;
  skyZenith: number;
  skyHorizon: number;
  skyBand: number;
  cloudCover: number;
  cloudLit: number;
  cloudShade: number;
  cloudOpacity: number;
  hazeScale: number;
  sunDiscScale: number;
  starScale: number;
  /** target for `MaterialLibrary.setWetness` while this weather is fully in */
  rain: number;
  lampBoost: number;
}

const RAIN: WeatherVariant = {
  sunColor: 0xdce2e6,
  sunScale: 0.35,
  minElevation: 20,
  hemiSky: 0x7e8c98,
  hemiGround: 0x4a4f52,
  hemiIntensity: 0.85,
  ambientColor: 0x8695a0,
  ambientIntensity: 0.4,
  bounceScale: 0.45,
  envScale: 0.95,
  fogColor: 0x97a5ae,
  fogDensity: 0.0038,
  exposure: 1.1,
  bloomStrength: 0.45,
  skyZenith: 0x5d6b78,
  skyHorizon: 0x97a5ae,
  skyBand: 0xa8b4bb,
  cloudCover: 0.92,
  cloudLit: 0x9dabb6,
  cloudShade: 0x4c565e,
  cloudOpacity: 1.0,
  hazeScale: 0.35,
  sunDiscScale: 0.12,
  starScale: 0.05,
  rain: 1.0,
  lampBoost: 0.55,
};

/**
 * Hurricane.
 *
 * The one row here that is *not* a straight read of the §4.2 table, and
 * deliberately so. A tropical storm with a shelf cloud over it does not go
 * neutral grey: the zenith goes to a near-black slate with a green bias, the
 * horizon band underneath turns the sickly yellow-green everyone who has stood
 * under one remembers, and the whole frame picks up an olive cast from the fog.
 * The trick is keeping the *ratio* between them big — a uniformly green frame
 * reads as a broken white balance, whereas black-green above a luminous olive
 * band reads as weather.
 *
 * The sun is cut harder than the reference's rain row (×0.15 rather than ×0.18)
 * because everything else here is darker, and the lamp boost goes to full: in a
 * daytime hurricane the street lighting is on, and it is most of what keeps the
 * driving line legible once the fog density and the gust multiplier stack up.
 */
const STORM: WeatherVariant = {
  sunColor: 0xc6cdb2,
  sunScale: 0.15,
  minElevation: 20,
  hemiSky: 0x5c6852,
  hemiGround: 0x31352b,
  hemiIntensity: 0.8,
  ambientColor: 0x69725d,
  ambientIntensity: 0.42,
  bounceScale: 0.28,
  envScale: 0.88,
  fogColor: 0x6d7663,
  fogDensity: 0.0068,
  exposure: 1.14,
  bloomStrength: 0.55,
  skyZenith: 0x242b22,
  skyHorizon: 0x747d5c,
  skyBand: 0x9aa06a,
  cloudCover: 1.0,
  cloudLit: 0x7d8464,
  cloudShade: 0x24281f,
  cloudOpacity: 1.0,
  hazeScale: 0.22,
  sunDiscScale: 0.0,
  starScale: 0.0,
  rain: 1.0,
  lampBoost: 0.95,
};

/* ------------------------------------------------------------------- math */

const DEG = Math.PI / 180;

/**
 * Reference azimuth/elevation → world unit vector pointing toward the light.
 * `azOffsetDeg` rotates the whole solar frame onto the city's dominant street
 * bearing (see `ARCHITECTURE.md` "Reconciliation notes").
 */
export function directionFromAzEl(
  azDeg: number,
  elDeg: number,
  azOffsetDeg = 0,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const az = (azDeg + azOffsetDeg) * DEG;
  const el = elDeg * DEG;
  const ce = Math.cos(el);
  out.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce);
  const len = out.length();
  if (!(len > 1e-6)) out.set(0, 1, 0);
  else out.multiplyScalar(1 / len);
  return out;
}

/** Great-circle interpolation between two unit vectors, robust at the poles. */
function slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const d = clamp(a.dot(b), -1, 1);
  if (d > 0.9995 || d < -0.9995) {
    out.copy(a).lerp(b, t);
    const l = out.length();
    if (l < 1e-5) out.copy(a);
    else out.multiplyScalar(1 / l);
    return out;
  }
  const theta = Math.acos(d);
  const st = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / st;
  const wb = Math.sin(t * theta) / st;
  out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb);
  return out.normalize();
}

/** Shortest-path lerp for a value in degrees on a 360° circle. */
function lerpAngleDeg(a: number, b: number, t: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

function setHexLinear(c: THREE.Color, hex: number): THREE.Color {
  return c.setHex(hex, THREE.SRGBColorSpace);
}

/* ------------------------------------------------------------- evaluation */

/** A zeroed state object. Allocate one per consumer and reuse it. */
export function createLightingState(): LightingState {
  return {
    hour: 12,
    weather: 'clear',
    weatherAmount: 0,
    sunAz: 176,
    sunEl: 78,
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 1, 1),
    sunIntensity: 3.6,
    hemiSky: new THREE.Color(1, 1, 1),
    hemiGround: new THREE.Color(1, 1, 1),
    hemiIntensity: 0.9,
    ambientColor: new THREE.Color(1, 1, 1),
    ambientIntensity: 0.24,
    bounceColor: new THREE.Color(1, 1, 1),
    bounceIntensity: 0.55,
    bounceDir: new THREE.Vector3(0, 1, 0),
    envIntensity: 0.85,
    fogColor: new THREE.Color(1, 1, 1),
    fogDensity: 0.0009,
    exposure: 0.95,
    bloomStrength: 0.28,
    bloomThreshold: 0.9,
    skyZenith: new THREE.Color(1, 1, 1),
    skyHorizon: new THREE.Color(1, 1, 1),
    skyBand: new THREE.Color(1, 1, 1),
    skyGround: new THREE.Color(1, 1, 1),
    sunDisc: 18,
    haze: 0.6,
    cloudCover: 0.33,
    cloudLit: new THREE.Color(1, 1, 1),
    cloudShade: new THREE.Color(1, 1, 1),
    cloudOpacity: 0.96,
    starIntensity: 0,
    moonIntensity: 0,
    moonDir: new THREE.Vector3(0, -1, 0),
    lampLevel: 0,
    dayFactor: 1,
    rainAmount: 0,
  };
}

const _dirA = new THREE.Vector3();
const _dirB = new THREE.Vector3();
const _tmpColor = new THREE.Color();

/** Index of the preset whose hour bracket contains `hour` (circular). */
function bracket(hour: number): { a: LightingPreset; b: LightingPreset; t: number } {
  const n = PRESETS.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    const h0 = PRESETS[k].hour;
    const h1 = PRESETS[(k + 1) % n].hour;
    const span = h1 > h0 ? h1 - h0 : h1 + 24 - h0;
    const rel = hour >= h0 ? hour - h0 : hour + 24 - h0;
    if (rel < span) {
      i = k;
      const t = span > 1e-6 ? rel / span : 0;
      return { a: PRESETS[k], b: PRESETS[(k + 1) % n], t };
    }
  }
  return { a: PRESETS[i], b: PRESETS[(i + 1) % n], t: 0 };
}

/**
 * Interpolate the preset table at `hour`, modulate by weather, and write the
 * result into `out`. Allocation-free.
 *
 * @param hour           0..24 (values outside are wrapped)
 * @param weather        current weather kind
 * @param weatherAmount  0..1 blend so showers can fade in and out
 * @param azOffsetDeg    rotation of the solar frame onto the street grid
 */
export function evaluateLighting(
  hour: number,
  weather: SkyWeather,
  weatherAmount: number,
  azOffsetDeg: number,
  out: LightingState,
): LightingState {
  const h = ((hour % 24) + 24) % 24;
  const { a, b, t: raw } = bracket(h);
  // ease the crossfade so the anchors read as held moments, not as a linear ramp
  const t = smootherstep(raw);

  out.hour = h;
  out.weather = weather;

  /* — key light direction: slerp so the sun never swings backwards — */
  directionFromAzEl(a.sunAz, a.sunEl, azOffsetDeg, _dirA);
  directionFromAzEl(b.sunAz, b.sunEl, azOffsetDeg, _dirB);
  slerpDir(_dirA, _dirB, t, out.sunDir);
  out.sunAz = lerpAngleDeg(a.sunAz, b.sunAz, t);
  out.sunEl = lerp(a.sunEl, b.sunEl, t);

  directionFromAzEl(a.moonAz, a.moonEl, azOffsetDeg, _dirA);
  directionFromAzEl(b.moonAz, b.moonEl, azOffsetDeg, _dirB);
  slerpDir(_dirA, _dirB, t, out.moonDir);

  setHexLinear(out.sunColor, a.sunColor).lerp(setHexLinear(_tmpColor, b.sunColor), t);
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);

  setHexLinear(out.hemiSky, a.hemiSky).lerp(setHexLinear(_tmpColor, b.hemiSky), t);
  setHexLinear(out.hemiGround, a.hemiGround).lerp(setHexLinear(_tmpColor, b.hemiGround), t);
  out.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);

  setHexLinear(out.ambientColor, a.ambientColor).lerp(setHexLinear(_tmpColor, b.ambientColor), t);
  out.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity, t);

  setHexLinear(out.bounceColor, a.bounceColor).lerp(setHexLinear(_tmpColor, b.bounceColor), t);
  out.bounceIntensity = lerp(a.bounceIntensity, b.bounceIntensity, t);
  out.envIntensity = lerp(a.envIntensity, b.envIntensity, t);

  setHexLinear(out.fogColor, a.fogColor).lerp(setHexLinear(_tmpColor, b.fogColor), t);
  out.fogDensity = lerp(a.fogDensity, b.fogDensity, t);

  out.exposure = lerp(a.exposure, b.exposure, t);
  out.bloomStrength = lerp(a.bloomStrength, b.bloomStrength, t);
  out.bloomThreshold = lerp(a.bloomThreshold, b.bloomThreshold, t);

  setHexLinear(out.skyZenith, a.skyZenith).lerp(setHexLinear(_tmpColor, b.skyZenith), t);
  setHexLinear(out.skyHorizon, a.skyHorizon).lerp(setHexLinear(_tmpColor, b.skyHorizon), t);
  setHexLinear(out.skyBand, a.skyBand).lerp(setHexLinear(_tmpColor, b.skyBand), t);
  setHexLinear(out.skyGround, a.skyGround).lerp(setHexLinear(_tmpColor, b.skyGround), t);
  out.sunDisc = lerp(a.sunDisc, b.sunDisc, t);
  out.haze = lerp(a.haze, b.haze, t);

  out.cloudCover = lerp(a.cloudCover, b.cloudCover, t);
  setHexLinear(out.cloudLit, a.cloudLit).lerp(setHexLinear(_tmpColor, b.cloudLit), t);
  setHexLinear(out.cloudShade, a.cloudShade).lerp(setHexLinear(_tmpColor, b.cloudShade), t);
  out.cloudOpacity = lerp(a.cloudOpacity, b.cloudOpacity, t);

  out.starIntensity = lerp(a.starIntensity, b.starIntensity, t);
  out.moonIntensity = lerp(a.moonIntensity, b.moonIntensity, t);

  out.lampLevel = lerp(a.lampLevel, b.lampLevel, t);
  out.dayFactor = lerp(a.dayFactor, b.dayFactor, t);
  out.rainAmount = 0;

  /* — bounce comes back at the player from the sunlit surfaces opposite — */
  directionFromAzEl(out.sunAz + 180, Math.max(12, 40 - Math.abs(out.sunEl) * 0.35), azOffsetDeg, out.bounceDir);

  /* — weather — */
  const wa = clamp01(weatherAmount);
  out.weatherAmount = wa;
  if (wa > 0.0005 && (weather === 'rain' || weather === 'storm')) {
    applyVariant(out, weather === 'storm' ? STORM : RAIN, wa, azOffsetDeg);
  }

  return out;
}

/**
 * Blend a weather row over the interpolated preset.
 *
 * The overcast colours are scaled by `dayFactor` before they are blended in:
 * a literal `#97A5AE` sky at 22:00 is the bug that made the old rig render a
 * bright grey overcast over a pitch-black street.
 */
function applyVariant(s: LightingState, v: WeatherVariant, wa: number, azOffsetDeg: number): void {
  const dayScale = lerp(0.075, 1, clamp01(s.dayFactor));
  const lightScale = lerp(0.18, 1, clamp01(s.dayFactor));

  setHexLinear(_tmpColor, v.sunColor);
  s.sunColor.lerp(_tmpColor, wa * 0.9);
  s.sunIntensity *= lerp(1, v.sunScale, wa);

  // an overcast key is a bright dome, not a raking beam: lift the sun while it
  // is above the horizon so the shadows go soft and near-vertical
  if (s.sunEl > 1) {
    const target = Math.max(s.sunEl, v.minElevation);
    s.sunEl = lerp(s.sunEl, target, wa);
    directionFromAzEl(s.sunAz, s.sunEl, azOffsetDeg, s.sunDir);
  }

  setHexLinear(_tmpColor, v.hemiSky).multiplyScalar(dayScale);
  s.hemiSky.lerp(_tmpColor, wa);
  setHexLinear(_tmpColor, v.hemiGround).multiplyScalar(dayScale);
  s.hemiGround.lerp(_tmpColor, wa);
  s.hemiIntensity = lerp(s.hemiIntensity, v.hemiIntensity, wa);

  setHexLinear(_tmpColor, v.ambientColor).multiplyScalar(lightScale);
  s.ambientColor.lerp(_tmpColor, wa);
  s.ambientIntensity = lerp(s.ambientIntensity, v.ambientIntensity * lightScale, wa);

  s.bounceIntensity *= lerp(1, v.bounceScale, wa);
  s.envIntensity *= lerp(1, v.envScale, wa);

  setHexLinear(_tmpColor, v.fogColor).multiplyScalar(dayScale);
  s.fogColor.lerp(_tmpColor, wa);
  s.fogDensity = lerp(s.fogDensity, Math.max(s.fogDensity, v.fogDensity), wa);

  s.exposure = lerp(s.exposure, v.exposure, wa);
  s.bloomStrength = lerp(s.bloomStrength, v.bloomStrength, wa);

  setHexLinear(_tmpColor, v.skyZenith).multiplyScalar(dayScale);
  s.skyZenith.lerp(_tmpColor, wa);
  setHexLinear(_tmpColor, v.skyHorizon).multiplyScalar(dayScale);
  s.skyHorizon.lerp(_tmpColor, wa);
  setHexLinear(_tmpColor, v.skyBand).multiplyScalar(dayScale);
  s.skyBand.lerp(_tmpColor, wa);
  s.skyGround.lerp(_tmpColor, wa * 0.5);

  s.cloudCover = lerp(s.cloudCover, v.cloudCover, wa);
  setHexLinear(_tmpColor, v.cloudLit).multiplyScalar(dayScale);
  s.cloudLit.lerp(_tmpColor, wa);
  setHexLinear(_tmpColor, v.cloudShade).multiplyScalar(dayScale);
  s.cloudShade.lerp(_tmpColor, wa);
  s.cloudOpacity = lerp(s.cloudOpacity, v.cloudOpacity, wa);

  s.haze *= lerp(1, v.hazeScale, wa);
  s.sunDisc *= lerp(1, v.sunDiscScale, wa);
  s.starIntensity *= lerp(1, v.starScale, wa);
  s.moonIntensity *= lerp(1, v.starScale, wa);
  s.lampLevel = clamp01(Math.max(s.lampLevel, v.lampBoost * wa));
  s.rainAmount = v.rain * wa;
}

/* --------------------------------------------------------- post-fx bridge */

/**
 * Shared, mutable post-processing state.
 *
 * `Lighting` writes it whenever the time of day or weather changes;
 * `RenderPipeline` reads it every frame. A module-level singleton rather than a
 * constructor argument so the render pipeline can be installed by `main.ts`
 * with a single `engine.setRenderHook(...)` call and still track the clock —
 * there is exactly one world and one composer per document.
 */
export interface PostState {
  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  /** 0..1 — screen-wide punch from a lightning strike */
  flash: number;
  /** grade: multiply applied to shadows (warm) and highlights (cool) */
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  /** lifts the black point so daylight shadows never crush (§6.3.5) */
  liftColor: THREE.Color;
  lift: number;
  saturation: number;
  vignette: number;
  grain: number;
  chroma: number;
  /** 0..1 — how wet the world is, for a touch of extra contrast in the grade */
  wet: number;
}

export const POST_STATE: PostState = {
  exposure: 1.0,
  bloomStrength: 0.35,
  bloomThreshold: 0.85,
  bloomRadius: 0.55,
  flash: 0,
  shadowTint: new THREE.Color(0xffd9b0).convertSRGBToLinear(),
  highlightTint: new THREE.Color(0xdcecff).convertSRGBToLinear(),
  liftColor: new THREE.Color(0x0e1a28).convertSRGBToLinear(),
  lift: 0.03,
  saturation: 1.08,
  vignette: 0.22,
  grain: 0.012,
  chroma: 0.0012,
  wet: 0,
};

/** Push the parts of a lighting state the composer needs. Called by `Lighting`. */
export function pushPostState(s: LightingState): void {
  POST_STATE.exposure = s.exposure;
  POST_STATE.bloomStrength = s.bloomStrength;
  POST_STATE.bloomThreshold = s.bloomThreshold;
  POST_STATE.wet = s.rainAmount;
  // Caribbean split: warmer shadows at golden hour, cooler at midday and night.
  const warm = clamp01(1 - s.dayFactor * 0.55);
  POST_STATE.shadowTint.setRGB(
    lerp(1.0, 1.09, warm),
    lerp(1.0, 1.005, warm),
    lerp(1.0, 0.9, warm),
  );
  POST_STATE.highlightTint.setRGB(
    lerp(1.0, 0.985, 1),
    1.0,
    lerp(1.0, 1.035, 1),
  );
  POST_STATE.saturation = lerp(1.04, 1.1, clamp01(s.dayFactor));
  POST_STATE.lift = lerp(0.045, 0.03, clamp01(s.dayFactor));
}
