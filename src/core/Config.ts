import type { QualityTier, SettingsState } from './types';

/** Global constants. Per-system feel tuning lives next to that system. */
export const CONFIG = {
  /** deterministic city seed */
  worldSeed: 0x10c0_11f7,

  /** physics runs at a fixed 120Hz — arcade suspension needs the headroom */
  fixedHz: 120,
  /** never simulate more than this many fixed steps in one frame */
  maxSubSteps: 8,
  /** clamp a frame delta to this many seconds before it reaches gameplay */
  maxFrameDelta: 1 / 15,

  gravity: -22.0,

  /** metres; the vertical drop that triggers an auto-reset */
  killPlaneY: -40,

  camera: {
    fov: 62,
    near: 0.3,
    far: 2200,
  },

  /** an arcade shift's clock */
  shift: {
    startSeconds: 90,
    maxSeconds: 180,
    warnAt: 15,
  },
} as const;

export const QUALITY_PRESETS: Record<QualityTier, Partial<SettingsState>> = {
  low: {
    renderScale: 0.7,
    shadows: false,
    postProcessing: false,
    bloom: false,
    motionBlur: false,
    ssao: false,
  },
  medium: {
    renderScale: 0.85,
    shadows: true,
    postProcessing: true,
    bloom: true,
    motionBlur: false,
    ssao: false,
  },
  high: {
    renderScale: 1.0,
    shadows: true,
    postProcessing: true,
    bloom: true,
    motionBlur: true,
    ssao: true,
  },
  ultra: {
    renderScale: 1.0,
    shadows: true,
    postProcessing: true,
    bloom: true,
    motionBlur: true,
    ssao: true,
  },
};

/** Draw-distance and density knobs the world/traffic/fx systems read. */
export const QUALITY_BUDGET: Record<
  QualityTier,
  {
    shadowMapSize: number;
    /** metres */
    drawDistance: number;
    trafficCount: number;
    pedCount: number;
    maxParticles: number;
    skidSegments: number;
    /** cascade count for the sun */
    propDetailDistance: number;
    windowLightDistance: number;
    anisotropy: number;
  }
> = {
  low: {
    shadowMapSize: 1024,
    drawDistance: 320,
    trafficCount: 14,
    pedCount: 24,
    maxParticles: 400,
    skidSegments: 220,
    propDetailDistance: 70,
    windowLightDistance: 140,
    anisotropy: 2,
  },
  medium: {
    shadowMapSize: 2048,
    drawDistance: 520,
    trafficCount: 26,
    pedCount: 55,
    maxParticles: 1100,
    skidSegments: 520,
    propDetailDistance: 120,
    windowLightDistance: 240,
    anisotropy: 4,
  },
  high: {
    shadowMapSize: 3072,
    drawDistance: 850,
    trafficCount: 40,
    pedCount: 95,
    maxParticles: 2400,
    skidSegments: 900,
    propDetailDistance: 190,
    windowLightDistance: 400,
    anisotropy: 8,
  },
  ultra: {
    shadowMapSize: 4096,
    drawDistance: 1300,
    trafficCount: 56,
    pedCount: 140,
    maxParticles: 4000,
    skidSegments: 1400,
    propDetailDistance: 280,
    windowLightDistance: 600,
    anisotropy: 16,
  },
};

export const DEFAULT_SETTINGS: SettingsState = {
  quality: 'high',
  renderScale: 1,
  shadows: true,
  postProcessing: true,
  bloom: true,
  motionBlur: true,
  ssao: true,
  masterVolume: 0.9,
  musicVolume: 0.55,
  sfxVolume: 0.85,
  screenShake: 1,
  cameraSway: 1,
  photosensitiveSafe: false,
  colorBlindMode: 'none',
  subtitles: true,
  largeText: false,
  highContrastHud: false,
  holdToBoost: true,
  assistSteering: 0.35,
  autoAccelerate: false,
  invertLook: false,
  uiScale: 1,
  minimapRotates: true,
  showSpeedUnits: 'mph',
};

/**
 * The Loco Lift palette. Old San Juan's façades are the game's signature —
 * saturated pastels against blue-grey adoquín cobblestone and a warm sky.
 */
export const PALETTE = {
  facade: [
    0xf2b134, // mustard
    0xe4572e, // terracotta
    0x2fa8a0, // caribbean teal
    0x4c8bf5, // colonial blue
    0xf05d8f, // bougainvillea pink
    0x8bc34a, // lime
    0xf7e3af, // cream
    0xa663cc, // violet
    0xef476f, // rose
    0x06a77d, // jade
    0xffd166, // sun yellow
    0x577590, // slate blue
  ],
  trim: [0xfffaf0, 0xf5f0e6, 0xe8dcc8, 0x2b2b2b, 0x1d3557],
  roofTile: [0xb5502f, 0xa14328, 0xc9663a, 0x8c3b22],
  /** adoquín — the blue-grey cobblestone that defines the old city */
  cobble: 0x4a5d78,
  cobbleWarm: 0x5d6e85,
  sea: 0x1b6fa8,
  seaDeep: 0x0d3f66,
  fortStone: 0xc8bda4,
} as const;
