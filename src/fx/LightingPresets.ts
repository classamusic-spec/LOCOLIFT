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
 * ---------------------------------------------------------------------------
 * DEVIATIONS FROM §4.2, and why (art-direction pass, "low warm sun" brief)
 * ---------------------------------------------------------------------------
 *
 * 1. **`afternoon` (15:30) is the most-seen hour** — it is what `main.ts` boots
 *    into — and the reference's 50° elevation makes it a second, slightly
 *    yellower midday. It is retuned to a **24° raking sun at az 250°**, warm
 *    `#FFD9A8` at 3.9. A 9.6 m building now throws a 21.6 m shadow, which
 *    crosses the 9–11 m street and climbs the opposite façade: slabs of light
 *    at every cross street, which is the look §4.1 calls the game's signature.
 *    50° threw 8 m and put 84 % of the street in sun, indistinguishable from
 *    midday — measured at 0.404 vs 0.401 mean luminance before this change.
 *
 * 2. **`golden` sun intensity 2.4 → 3.6.** At 2.4 the whole calle sank to mean
 *    luminance 0.349, below the §6.4 daylight floor of 0.38, and the "slabs of
 *    orange light" never reached a stop above the shadow. The colour stays in
 *    the reference's family (`#FFA85C` vs `#FF9E4D`) — what changed is that the
 *    lit half of the frame now actually blazes.
 *
 * 3. **`envIntensity` was crushing every reflection.** It ran 0.42–0.85, and it
 *    multiplies each material's own `envMapIntensity` (0.55–1.5 here). Night
 *    was the worst case: 0.48 × 0.55 = 0.26 of the captured sky, which is most
 *    of the reason the wet-road lamp reflections §4.3 calls load-bearing did
 *    not read. Daylight now sits at 1.0 — the sky capture *is* the radiance,
 *    so anything under 1.0 is a silent, invisible exposure cut — and night at
 *    0.9. This is the failure mode that is never obviously broken, only flat.
 *
 * 4. **Night ambient 0.20 → 0.13 and desaturated.** §4.3's night contract says
 *    the driving line must read from lamp pools, and explicitly names a global
 *    ambient lift as the amateur move. The old value measured 0.56 mean centre
 *    saturation — a flat blue wash, well over the §6.4 night ceiling of 0.44.
 *
 * Everything else in the §4.2 table is verbatim and must not be "improved"
 * without changing the reference first. The extra channels — ambient, bounce,
 * env intensity, sky/cloud/star colours, lamp level, and the whole grade and
 * atmosphere block below — are this module's own.
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
  /**
   * **Display-space** luminance a pixel must reach before it blooms, 0..1.
   * `pushPostState` runs it back through the inverse of the ACES curve and
   * divides by exposure, because the bloom pass sees linear HDR: thresholding
   * a linear buffer at 0.85 blooms every sunlit stucco wall in the district,
   * which is the single most common way a bloom pass reads as amateur.
   */
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

  /* ------------------------------------------------------------ post-fx -- */

  /** 0..1 screen-space light-shaft strength (`GodRays`) */
  readonly godRays: number;
  /** in-scatter colour the far plane drifts toward (aerial perspective) */
  readonly aerialColor: number;
  /** 0..1 how hard aerial perspective bites at the draw distance */
  readonly aerialStrength: number;
  /** 0..1 heat shimmer over the cobbles. Non-zero around solar noon only. */
  readonly shimmer: number;

  /* — grade — */
  /** multiplied into the shadows, hue only: luminance is normalised out */
  readonly gradeShadowTint: number;
  /** multiplied into the highlights, hue only */
  readonly gradeHighlightTint: number;
  /** 0..1 how far toward those tints the split-tone actually goes */
  readonly gradeSplit: number;
  readonly gradeSaturation: number;
  /** S-curve strength about the 0.42 pivot; 1.0 = off */
  readonly gradeContrast: number;
  /** black-point lift colour (§6.3.5) */
  readonly gradeLiftColor: number;
  readonly gradeLift: number;
  /** added on top of the weather system's vignette (which owns the 0.22 base) */
  readonly vignetteBoost: number;
  /** §6.3.8 — 0.012 by day, more at night where the shadows are large and flat */
  readonly grain: number;
  /** §6.3.6 — fraction of screen width, edges only */
  readonly chroma: number;
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

  godRays: number;
  aerialColor: THREE.Color;
  aerialStrength: number;
  shimmer: number;

  gradeShadowTint: THREE.Color;
  gradeHighlightTint: THREE.Color;
  gradeSplit: number;
  gradeSaturation: number;
  gradeContrast: number;
  gradeLiftColor: THREE.Color;
  gradeLift: number;
  vignetteBoost: number;
  grain: number;
  chroma: number;
}

/* ---------------------------------------------------------------- presets */

/**
 * Eight anchors. Seven are the §4.2 time-of-day rows (see the deviations noted
 * in the file header); `midnight` is added so the clock closes smoothly across
 * 00:00 — interpolating `night` → `dawn` directly would drag the moon backwards
 * through the sky.
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
    hemiIntensity: 0.24,
    ambientColor: 0x27334a,
    ambientIntensity: 0.1,
    bounceColor: 0x232c40,
    bounceIntensity: 0.07,
    envIntensity: 0.88,
    fogColor: 0x0c1320,
    fogDensity: 0.0036,
    exposure: 1.14,
    bloomStrength: 0.8,
    bloomThreshold: 0.66,
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
    godRays: 0.05,
    aerialColor: 0x121c33,
    aerialStrength: 0.55,
    shimmer: 0,
    gradeShadowTint: 0x7d90c8,
    gradeHighlightTint: 0xffd9a8,
    gradeSplit: 0.5,
    gradeSaturation: 0.86,
    gradeContrast: 1.08,
    gradeLiftColor: 0x16243c,
    gradeLift: 0.038,
    vignetteBoost: 0.08,
    grain: 0.02,
    chroma: 0.0014,
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
    ambientIntensity: 0.24,
    bounceColor: 0xb07048,
    bounceIntensity: 0.4,
    envIntensity: 0.95,
    fogColor: 0xc9a98f,
    fogDensity: 0.0022,
    exposure: 1.05,
    bloomStrength: 0.55,
    bloomThreshold: 0.87,
    skyZenith: 0x1e3e77,
    skyHorizon: 0xf0a878,
    skyBand: 0xff7a47,
    skyGround: 0x33291f,
    sunDisc: 10.0,
    haze: 1.45,
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
    godRays: 0.95,
    aerialColor: 0xd9a882,
    aerialStrength: 0.7,
    shimmer: 0,
    gradeShadowTint: 0xffc49a,
    gradeHighlightTint: 0xd6e4ff,
    gradeSplit: 0.65,
    gradeSaturation: 1.35,
    gradeContrast: 1.06,
    gradeLiftColor: 0x1a1c2e,
    gradeLift: 0.038,
    vignetteBoost: 0.03,
    grain: 0.014,
    chroma: 0.0013,
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
    ambientIntensity: 0.22,
    bounceColor: 0xc9a070,
    bounceIntensity: 0.48,
    envIntensity: 1.0,
    fogColor: 0xbfd8e8,
    fogDensity: 0.0011,
    exposure: 1.0,
    bloomStrength: 0.4,
    bloomThreshold: 0.92,
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
    godRays: 0.55,
    aerialColor: 0xa8c8de,
    aerialStrength: 0.62,
    shimmer: 0.3,
    gradeShadowTint: 0xffc98e,
    gradeHighlightTint: 0xdcecff,
    gradeSplit: 0.7,
    gradeSaturation: 1.55,
    gradeContrast: 1.1,
    gradeLiftColor: 0x0e1a28,
    gradeLift: 0.03,
    vignetteBoost: 0,
    grain: 0.011,
    chroma: 0.0012,
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
    ambientIntensity: 0.2,
    bounceColor: 0xc8b48e,
    bounceIntensity: 0.55,
    envIntensity: 1.0,
    fogColor: 0xc6dcec,
    fogDensity: 0.0009,
    exposure: 1.0,
    bloomStrength: 0.34,
    bloomThreshold: 0.94,
    skyZenith: 0x2e7bc4,
    skyHorizon: 0xbfe0f2,
    skyBand: 0xd8ecf7,
    skyGround: 0x4c5a5e,
    sunDisc: 20.0,
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
    // a near-vertical sun makes almost no horizontal shafts; what it does make
    // is glare off the sea and off the crowns of the cobbles
    godRays: 0.28,
    aerialColor: 0xb6d6ea,
    aerialStrength: 0.58,
    shimmer: 1.0,
    gradeShadowTint: 0xffbf7d,
    gradeHighlightTint: 0xd4e8ff,
    gradeSplit: 0.85,
    gradeSaturation: 1.60,
    gradeContrast: 1.14,
    gradeLiftColor: 0x0e1a28,
    gradeLift: 0.028,
    vignetteBoost: 0,
    grain: 0.01,
    chroma: 0.0012,
  },
  {
    /**
     * 15:30 — the hour the game boots into, and therefore the one that has to
     * carry the art direction. A low warm raking key, not a second midday.
     */
    key: 'afternoon',
    hour: 15.5,
    sunAz: 250,
    sunEl: 24,
    sunColor: 0xffd9a8,
    sunIntensity: 3.9,
    hemiSky: 0x9dbcd8,
    hemiGround: 0x7a6248,
    hemiIntensity: 0.72,
    ambientColor: 0xa8aab0,
    ambientIntensity: 0.24,
    bounceColor: 0xd8a468,
    bounceIntensity: 0.66,
    envIntensity: 1.0,
    fogColor: 0xd6c8b4,
    fogDensity: 0.0013,
    exposure: 1.02,
    bloomStrength: 0.5,
    bloomThreshold: 0.92,
    skyZenith: 0x3f74c4,
    skyHorizon: 0xffd0a0,
    skyBand: 0xffc07a,
    skyGround: 0x4a4640,
    sunDisc: 15.0,
    haze: 1.15,
    cloudCover: 0.4,
    cloudLit: 0xfff0dc,
    cloudShade: 0x8496b4,
    cloudOpacity: 0.95,
    starIntensity: 0,
    moonIntensity: 0,
    moonAz: 46,
    moonEl: -18,
    lampLevel: 0,
    dayFactor: 1,
    godRays: 0.9,
    aerialColor: 0xdcc6a8,
    aerialStrength: 0.68,
    shimmer: 0.35,
    gradeShadowTint: 0xffc48e,
    gradeHighlightTint: 0xcfe2ff,
    gradeSplit: 0.75,
    gradeSaturation: 1.75,
    gradeContrast: 1.13,
    gradeLiftColor: 0x101c2c,
    gradeLift: 0.03,
    vignetteBoost: 0.01,
    grain: 0.011,
    chroma: 0.0012,
  },
  {
    key: 'golden',
    hour: 18.25,
    sunAz: 268,
    sunEl: 8,
    sunColor: 0xffa85c,
    sunIntensity: 3.6,
    hemiSky: 0x8fa8c8,
    hemiGround: 0x6b4e3a,
    hemiIntensity: 0.6,
    ambientColor: 0x93849a,
    ambientIntensity: 0.34,
    bounceColor: 0xd4702e,
    bounceIntensity: 0.78,
    envIntensity: 1.0,
    fogColor: 0xe8a56b,
    fogDensity: 0.0018,
    exposure: 1.22,
    bloomStrength: 0.78,
    bloomThreshold: 0.90,
    skyZenith: 0x2f5a9c,
    skyHorizon: 0xffb35c,
    skyBand: 0xff6b3d,
    skyGround: 0x3c2c22,
    sunDisc: 14.0,
    haze: 1.7,
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
    godRays: 1.0,
    aerialColor: 0xffab63,
    aerialStrength: 0.82,
    shimmer: 0,
    gradeShadowTint: 0xffb877,
    gradeHighlightTint: 0xcfe0ff,
    gradeSplit: 0.8,
    gradeSaturation: 1.55,
    gradeContrast: 1.12,
    gradeLiftColor: 0x171e38,
    gradeLift: 0.036,
    vignetteBoost: 0.03,
    grain: 0.012,
    chroma: 0.0014,
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
    hemiIntensity: 0.46,
    ambientColor: 0x565274,
    ambientIntensity: 0.24,
    bounceColor: 0x7a4a4a,
    bounceIntensity: 0.3,
    envIntensity: 0.98,
    fogColor: 0x7a6a86,
    fogDensity: 0.0026,
    exposure: 1.15,
    bloomStrength: 0.95,
    bloomThreshold: 0.82,
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
    godRays: 0.55,
    aerialColor: 0x8a7096,
    aerialStrength: 0.72,
    shimmer: 0,
    gradeShadowTint: 0x8a9ad8,
    gradeHighlightTint: 0xffc38c,
    gradeSplit: 0.85,
    gradeSaturation: 1.25,
    gradeContrast: 1.1,
    gradeLiftColor: 0x141c34,
    gradeLift: 0.045,
    vignetteBoost: 0.06,
    grain: 0.016,
    chroma: 0.0014,
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
    hemiIntensity: 0.26,
    ambientColor: 0x2a3850,
    ambientIntensity: 0.13,
    bounceColor: 0x2a3348,
    bounceIntensity: 0.1,
    envIntensity: 0.9,
    fogColor: 0x101828,
    fogDensity: 0.0034,
    exposure: 1.10,
    bloomStrength: 0.45,
    bloomThreshold: 0.78,
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
    godRays: 0.07,
    aerialColor: 0x16243e,
    aerialStrength: 0.6,
    shimmer: 0,
    // the split is what stops night reading as monochrome blue: the lamp pools
    // land in the highlights and are pushed warm, the sky sits in the shadows
    gradeShadowTint: 0x6f86bc,
    gradeHighlightTint: 0xffc98a,
    gradeSplit: 0.95,
    gradeSaturation: 0.86,
    gradeContrast: 1.12,
    gradeLiftColor: 0x14223a,
    gradeLift: 0.032,
    vignetteBoost: 0.07,
    grain: 0.019,
    chroma: 0.0014,
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
  bloomThreshold: number;
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

  godRays: number;
  aerialColor: number;
  aerialStrength: number;
  gradeShadowTint: number;
  gradeHighlightTint: number;
  gradeSaturation: number;
  gradeContrast: number;
  vignetteBoost: number;
  grain: number;
  gradeLift: number;
}

const RAIN: WeatherVariant = {
  sunColor: 0xdce2e6,
  sunScale: 0.35,
  minElevation: 20,
  hemiSky: 0x7e8c98,
  hemiGround: 0x4a4f52,
  hemiIntensity: 0.85,
  ambientColor: 0x8695a0,
  ambientIntensity: 0.42,
  bounceScale: 0.45,
  envScale: 1.0,
  fogColor: 0x97a5ae,
  fogDensity: 0.0038,
  exposure: 1.46,
  bloomStrength: 0.62,
  // a wet street is nothing but specular highlights; drop the gate so they glow
  bloomThreshold: 0.86,
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
  godRays: 0.3,
  aerialColor: 0x9aa8b2,
  aerialStrength: 0.85,
  gradeShadowTint: 0x9fb0c4,
  gradeHighlightTint: 0xffebd2,
  gradeSaturation: 1.45,
  gradeContrast: 1.12,
  vignetteBoost: 0.05,
  grain: 0.016,
  gradeLift: 0.05,
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
  ambientIntensity: 0.44,
  bounceScale: 0.28,
  envScale: 0.95,
  fogColor: 0x6d7663,
  fogDensity: 0.0068,
  exposure: 1.48,
  bloomStrength: 0.7,
  bloomThreshold: 0.85,
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
  godRays: 0.12,
  aerialColor: 0x6f7865,
  aerialStrength: 0.95,
  gradeShadowTint: 0x9ab0c0,
  gradeHighlightTint: 0xffe4b0,
  gradeSaturation: 1.60,
  gradeContrast: 1.14,
  vignetteBoost: 0.09,
  grain: 0.022,
  gradeLift: 0.062,
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
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

function setHexLinear(c: THREE.Color, hex: number): THREE.Color {
  return c.setHex(hex, THREE.SRGBColorSpace);
}

/**
 * Inverse of the ACES filmic curve three applies, so a threshold authored in
 * display space can be handed to a pass that only sees linear HDR. Narkowicz's
 * rational fit inverted, then un-doing three's `/ 0.6` pre-scale.
 *
 * Sanity: `displayToLinear(0.85) ≈ 0.76`, and a sunlit cream façade measures
 * ~0.80 linear at midday. That 0.04 of headroom is exactly the difference
 * between "the sun disc and the chrome bloom" and "the whole wall glows".
 */
export function displayToLinear(display: number): number {
  const d = clamp(display, 0, 0.997);
  const a = 2.51 - 2.43 * d;
  const b = 0.03 - 0.59 * d;
  const c = -0.14 * d;
  const disc = Math.max(0, b * b - 4 * a * c);
  const x = a > 1e-5 ? (-b + Math.sqrt(disc)) / (2 * a) : 4;
  return Math.max(0, x * 0.6);
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
    envIntensity: 1,
    fogColor: new THREE.Color(1, 1, 1),
    fogDensity: 0.0009,
    exposure: 0.95,
    bloomStrength: 0.34,
    bloomThreshold: 0.91,
    skyZenith: new THREE.Color(1, 1, 1),
    skyHorizon: new THREE.Color(1, 1, 1),
    skyBand: new THREE.Color(1, 1, 1),
    skyGround: new THREE.Color(1, 1, 1),
    sunDisc: 20,
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
    godRays: 0.3,
    aerialColor: new THREE.Color(1, 1, 1),
    aerialStrength: 0.6,
    shimmer: 0,
    gradeShadowTint: new THREE.Color(1, 1, 1),
    gradeHighlightTint: new THREE.Color(1, 1, 1),
    gradeSplit: 0.8,
    gradeSaturation: 1.2,
    gradeContrast: 1.12,
    gradeLiftColor: new THREE.Color(1, 1, 1),
    gradeLift: 0.03,
    vignetteBoost: 0,
    grain: 0.012,
    chroma: 0.0012,
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

  out.godRays = lerp(a.godRays, b.godRays, t);
  setHexLinear(out.aerialColor, a.aerialColor).lerp(setHexLinear(_tmpColor, b.aerialColor), t);
  out.aerialStrength = lerp(a.aerialStrength, b.aerialStrength, t);
  out.shimmer = lerp(a.shimmer, b.shimmer, t);

  setHexLinear(out.gradeShadowTint, a.gradeShadowTint).lerp(
    setHexLinear(_tmpColor, b.gradeShadowTint),
    t,
  );
  setHexLinear(out.gradeHighlightTint, a.gradeHighlightTint).lerp(
    setHexLinear(_tmpColor, b.gradeHighlightTint),
    t,
  );
  out.gradeSplit = lerp(a.gradeSplit, b.gradeSplit, t);
  out.gradeSaturation = lerp(a.gradeSaturation, b.gradeSaturation, t);
  out.gradeContrast = lerp(a.gradeContrast, b.gradeContrast, t);
  setHexLinear(out.gradeLiftColor, a.gradeLiftColor).lerp(
    setHexLinear(_tmpColor, b.gradeLiftColor),
    t,
  );
  out.gradeLift = lerp(a.gradeLift, b.gradeLift, t);
  out.vignetteBoost = lerp(a.vignetteBoost, b.vignetteBoost, t);
  out.grain = lerp(a.grain, b.grain, t);
  out.chroma = lerp(a.chroma, b.chroma, t);

  /* — bounce comes back at the player from the sunlit surfaces opposite — */
  directionFromAzEl(
    out.sunAz + 180,
    Math.max(12, 40 - Math.abs(out.sunEl) * 0.35),
    azOffsetDeg,
    out.bounceDir,
  );

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
  s.bloomThreshold = lerp(s.bloomThreshold, v.bloomThreshold, wa);

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

  s.godRays = lerp(s.godRays, v.godRays, wa);
  setHexLinear(_tmpColor, v.aerialColor).multiplyScalar(dayScale);
  s.aerialColor.lerp(_tmpColor, wa);
  s.aerialStrength = lerp(s.aerialStrength, v.aerialStrength, wa);
  s.shimmer *= 1 - wa;

  setHexLinear(_tmpColor, v.gradeShadowTint);
  s.gradeShadowTint.lerp(_tmpColor, wa);
  setHexLinear(_tmpColor, v.gradeHighlightTint);
  s.gradeHighlightTint.lerp(_tmpColor, wa);
  s.gradeSaturation = lerp(s.gradeSaturation, v.gradeSaturation, wa);
  s.gradeContrast = lerp(s.gradeContrast, v.gradeContrast, wa);
  s.vignetteBoost = lerp(s.vignetteBoost, v.vignetteBoost, wa);
  s.grain = lerp(s.grain, v.grain, wa);
  s.gradeLift = lerp(s.gradeLift, v.gradeLift, wa);
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
 *
 * **Ownership inside this object matters.** `vignette` and `wet` are written by
 * `Weather` every frame (it owns the §6.3.7 base of 0.22 plus its storm ramp);
 * everything else is written by `Lighting`. The composer *adds* `vignetteBoost`
 * to `vignette` rather than overwriting it, so the two never fight.
 */
export interface PostState {
  exposure: number;
  bloomStrength: number;
  /** already converted to the linear-HDR value the bloom pass needs */
  bloomThreshold: number;
  bloomRadius: number;
  /** high-pass knee, so bloom fades in instead of popping at the threshold */
  bloomKnee: number;
  /** 0..1 — screen-wide punch from a lightning strike */
  flash: number;
  /** grade: multiply applied to shadows (warm) and highlights (cool) */
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  /** lifts the black point so daylight shadows never crush (§6.3.5) */
  liftColor: THREE.Color;
  lift: number;
  saturation: number;
  contrast: number;
  /** owned by `Weather`: §6.3.7 base 0.22 plus its storm ramp */
  vignette: number;
  /** owned by `Lighting`: per-time-of-day addition on top of the above */
  vignetteBoost: number;
  grain: number;
  chroma: number;
  /** 0..1 — how wet the world is, for a touch of extra contrast in the grade */
  wet: number;

  /* — atmosphere the composer needs to build shafts and depth — */
  /** world-space unit vector toward the key light */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** 0..1 shaft strength */
  godRays: number;
  aerialColor: THREE.Color;
  aerialStrength: number;
  shimmer: number;
  /** 0 = night, 1 = day; gates the effects that only make sense in daylight */
  dayFactor: number;
  /** 0..1 street-lamp master level */
  lampLevel: number;
  /** FogExp2 density in force this frame, for the aerial-perspective ramp */
  fogDensity: number;
}

export const POST_STATE: PostState = {
  exposure: 1.0,
  bloomStrength: 0.4,
  bloomThreshold: 1.2,
  bloomRadius: 0.55,
  bloomKnee: 0.28,
  flash: 0,
  shadowTint: new THREE.Color(1, 1, 1),
  highlightTint: new THREE.Color(1, 1, 1),
  liftColor: new THREE.Color(0x0e1a28).convertSRGBToLinear(),
  lift: 0.03,
  saturation: 1.18,
  contrast: 1.12,
  vignette: 0.22,
  vignetteBoost: 0,
  grain: 0.012,
  chroma: 0.0012,
  wet: 0,
  sunDir: new THREE.Vector3(0, 1, 0),
  sunColor: new THREE.Color(1, 1, 1),
  godRays: 0.4,
  aerialColor: new THREE.Color(1, 1, 1),
  aerialStrength: 0.6,
  shimmer: 0,
  dayFactor: 1,
  lampLevel: 0,
  fogDensity: 0.0009,
};

const _tint = new THREE.Color();

/**
 * Maximum per-channel deviation from neutral a split-tone may apply.
 *
 * This exists because normalising a tint to luminance 1 preserves *exposure*
 * but does nothing to bound *chroma*, and the two are easy to confuse. A tint
 * authored as `#FFBF7D` normalises to `(1.69, 0.86, 0.36)` — a multiply that
 * removes two thirds of the blue channel. On a sunny frame that reads as a
 * warm grade; on an overcast one, where every pixel sits in the shadow half of
 * the split, it turns the entire district sepia. That was a real capture.
 *
 * 0.16 keeps the grade inside roughly ±1/6 stop per channel, which is where
 * film split-toning actually lives.
 */
const TINT_MAX_DEVIATION = 0.16;

/**
 * Normalise a tint to luminance 1 so it shifts hue without moving exposure,
 * clamp how far from neutral it is allowed to travel, then walk it back toward
 * white by `1 - split`.
 */
function bakeTint(src: THREE.Color, split: number, out: THREE.Color): void {
  _tint.copy(src);
  const lum = 0.2126 * _tint.r + 0.7152 * _tint.g + 0.0722 * _tint.b;
  if (lum > 1e-4) _tint.multiplyScalar(1 / lum);
  const lo = 1 - TINT_MAX_DEVIATION;
  const hi = 1 + TINT_MAX_DEVIATION;
  out.setRGB(
    lerp(1, clamp(_tint.r, lo, hi), split),
    lerp(1, clamp(_tint.g, lo, hi), split),
    lerp(1, clamp(_tint.b, lo, hi), split),
  );
}

/** Push the parts of a lighting state the composer needs. Called by `Lighting`. */
export function pushPostState(s: LightingState): void {
  POST_STATE.exposure = s.exposure;
  POST_STATE.bloomStrength = s.bloomStrength;
  // display-space authored -> linear HDR, then un-do the exposure the grade
  // will apply later, so the gate lands on the pixel the player actually sees
  POST_STATE.bloomThreshold = displayToLinear(s.bloomThreshold) / Math.max(0.2, s.exposure);
  POST_STATE.bloomKnee = 0.22 + (1 - clamp01(s.dayFactor)) * 0.16;
  POST_STATE.wet = s.rainAmount;

  bakeTint(s.gradeShadowTint, s.gradeSplit, POST_STATE.shadowTint);
  bakeTint(s.gradeHighlightTint, s.gradeSplit, POST_STATE.highlightTint);

  POST_STATE.liftColor.copy(s.gradeLiftColor);
  POST_STATE.lift = s.gradeLift;
  POST_STATE.saturation = s.gradeSaturation;
  POST_STATE.contrast = s.gradeContrast;
  POST_STATE.vignetteBoost = s.vignetteBoost;
  POST_STATE.grain = s.grain;
  POST_STATE.chroma = s.chroma;

  POST_STATE.sunDir.copy(s.sunDir);
  POST_STATE.sunColor.copy(s.sunColor);
  POST_STATE.godRays = s.godRays;
  POST_STATE.aerialColor.copy(s.aerialColor);
  POST_STATE.aerialStrength = s.aerialStrength;
  POST_STATE.shimmer = s.shimmer;
  POST_STATE.dayFactor = s.dayFactor;
  POST_STATE.lampLevel = s.lampLevel;
  POST_STATE.fogDensity = s.fogDensity;
}
