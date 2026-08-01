/**
 * Loco Lift — the Chinchorreo party bus: tuning bible.
 *
 * A retired American school bus, eleven metres of it, converted into a rolling
 * chinchorreo (the Puerto Rican bar-and-food-shack crawl). It is the exact
 * opposite of the Jeep in every axis that matters:
 *
 *            Jeep                      Bus
 *   mass     1 400 kg                  8 200 kg
 *   0–30     ~3.6 s                    ~10 s
 *   top      ~50 m/s                   ~34 m/s
 *   30–0     ~18 m                     ~50 m
 *   steering 38° lock, 7.5 rad/s       25° lock, 2.4 rad/s
 *   roll     ~5° of visible lean       ~13° of visible lean
 *
 * The design brief is "heavy and hilarious", never "heavy and miserable". Every
 * number below is chosen so the bus is slow to *change* what it is doing and
 * enormously satisfying once it is doing it: it takes a block to wind up, a
 * block to stop, it leans onto its door handles in a corner, and it removes
 * street furniture without noticing. The anti-frustration nets (yaw assist,
 * auto-level, auto-right) are all *stronger* than the Jeep's, not weaker —
 * the comedy comes from the momentum, not from fighting the controls.
 *
 * Units are SI. World gravity is CONFIG.gravity = -22 m/s², so every force here
 * is sized for 2.24 g, not for 9.81.
 *
 * Local axes: forward = -Z, right = +X, up = +Y.
 * Wheel indices: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right
 * (the rears carry two tyres each visually — a real bus has six wheels, the
 * simulation only needs four struts).
 */
import { PALETTE } from '../core/Config';
import type {
  ModelFeel,
  TerrainTuning,
  VehicleTuningSet,
  WheelPlacement,
} from './VehicleTuning';

/* ------------------------------------------------------------------ chassis */

export const BUS_CHASSIS = {
  /** kerb mass plus a full load of party, kg. 5.9× the Jeep. */
  mass: 8200,

  /**
   * Half-extents of the single box collider (2.56 m × 2.56 m × 11 m). The box
   * is raised by `colliderOffsetY` so it wraps the *body* rather than being
   * centred on the axle line — see BUS_TUNING.colliderOffsetY.
   */
  colliderHalfX: 1.28,
  colliderHalfY: 1.28,
  colliderHalfZ: 5.5,
  colliderOffsetY: 0.8,

  /**
   * Centre of mass: 0.55 m above the body origin, i.e. ~1.33 m above the road —
   * genuinely high, which is what produces the lean. It is kept survivable by
   * `lateralForceHeight` below, which raises the roll centre to 0.85 m and puts
   * the rollover threshold well outside anything the tyres can generate.
   * A touch forward, because a flat-front bus carries its engine over the nose.
   */
  comLocalX: 0,
  comLocalY: 0.55,
  comLocalZ: -0.1,

  linearDamping: 0.015,
  /** more angular damping than the Jeep: a bus does not pirouette */
  angularDamping: 0.3,

  friction: 0.6,
  restitution: 0.04,

  /**
   * Principal moments about the CoM, kg·m². These MUST agree with the tensor
   * the physics backend derives from the collider box (m/3 · (h² + h²)) or the
   * yaw assist will ask for the wrong torque:
   *   k = 8200/3 = 2733.3
   *   pitch = k·(hy² + hz²) = 2733.3·(1.638 + 30.25) = 87 164
   *   yaw   = k·(hx² + hz²) = 87 164
   *   roll  = k·(hx² + hy²) = 2733.3·(1.638 + 1.638) = 8 956
   * The yaw figure is 31× the Jeep's — that single number is most of why the
   * bus feels like it has to be *aimed* rather than steered.
   */
  inertiaPitch: 87164,
  inertiaYaw: 87164,
  inertiaRoll: 8956,
} as const;

/* --------------------------------------------------------------- suspension */

export const BUS_SUSPENSION = {
  /** 1.1 m truck rubber */
  wheelRadius: 0.55,
  wheelWidth: 0.34,

  /** 6.1 m wheelbase — front axle at z=-3.05, rear at z=+3.05 */
  halfWheelbase: 3.05,
  /** 2.10 m front track; the rears are tucked in to make room for the duals */
  halfTrackFront: 1.05,
  halfTrackRear: 0.92,

  /** the strut top mounts sit on the body origin itself */
  anchorY: 0.0,

  /** long, soft travel — the bus should visibly heave and float */
  restLength: 0.42,

  raySkin: 0.08,

  /**
   * Spring rate per corner, N/m. Static corner load is 8200·22/4 = 45 100 N;
   * at 237 500 N/m average that settles at 0.190 m, i.e. 45 % of travel, and
   * gives a 1.71 Hz corner frequency — softer and floatier than the Jeep's
   * 1.96 Hz, which is exactly the wallow we want.
   */
  springRateFront: 225000,
  springRateRear: 250000,

  /**
   * Critical damping for a 2 050 kg corner at 237 kN/m is ≈44 000 N·s/m, so
   * these are 0.39 (bump) and 0.24 (rebound) of critical. Deliberately
   * under-damped on rebound: the bus keeps bobbing for a beat after a kerb,
   * which reads as mass.
   */
  damperCompress: 17000,
  damperRebound: 10500,

  maxSpringForce: 700000,

  /**
   * Anti-roll, N per unit of normalised compression difference. Soft relative
   * to the spring rate (0.08 vs the Jeep's 0.21) so the body heels right over
   * in a corner. The front bar is much stiffer than the rear, which dials in
   * understeer — the bus pushes wide rather than swapping ends.
   */
  antiRollFront: 22000,
  antiRollRear: 9000,

  /** slower visual smoothing to match the heavier body */
  visualSmoothRate: 20,

  airborneDroop: 1,
} as const;

/* ------------------------------------------------------------------- engine */

export const BUS_ENGINE = {
  /** a big lazy diesel: nothing above 3 000 rpm ever happens */
  idleRpm: 620,
  redlineRpm: 2900,
  shiftUpRpm: 2550,
  shiftDownRpm: 1150,
  /**
   * A third of a second with no torque at all on every shift. This is the
   * single funniest number in the file: the bus audibly gathers itself, goes
   * quiet, then lurches into the next gear.
   */
  shiftTimeSec: 0.3,

  /**
   * Torque, N·m, sampled evenly from 0 rpm to redline. Peak 2 700 N·m at ~970
   * rpm and still 1 850 N·m at the limiter: all shove, no revs.
   */
  torqueCurve: [
    1400, 2320, 2760, 2820, 2760, 2680, 2580, 2460, 2300, 2080,
  ] as readonly number[],

  /**
   * Five very long gears. Shift points land at roughly 5 / 9 / 14.5 / 21 m/s
   * and top gear runs out of revs at ~34 m/s.
   */
  gearRatios: [6.0, 3.5, 2.2, 1.5, 1.05] as readonly number[],
  reverseRatio: 5.5,
  finalDrive: 4.6,
  efficiency: 0.9,

  /** rear-drive, as every bus on earth is */
  driveBiasRear: 0.95,

  /**
   * Engine braking is enormous — an unloaded diesel with a Jake brake hauls
   * itself down hard the moment you lift, which makes the throttle feel like a
   * commitment rather than a suggestion.
   */
  engineBrakeCoeff: 900,
  engineBrakeBase: 3200,

  rpmSmoothRate: 9,
} as const;

/* ------------------------------------------------------------------- speeds */

export const BUS_SPEED = {
  /** ~123 km/h. Absurd for a school bus, and still only 68 % of the Jeep. */
  topSpeed: 35,
  topSpeedBoost: 42,
  /** reverse is glacial and beeps a lot */
  topSpeedReverse: 9,

  limiterBand: 4,

  /** a brick with windows: 2.5× the Jeep's drag */
  dragCoeff: 1.15,
  dragCoeffAir: 1.5,
  /** four very heavy wheels */
  rollingResistance: 320,

  /** buses make no downforce; this is purely a stability floor */
  downforceCoeff: 1.1,
  downforceMax: 14000,
} as const;

/* ------------------------------------------------------------------ braking */

export const BUS_BRAKE = {
  /**
   * 70 kN on 8 200 kg is 8.5 m/s² — a third of the Jeep's retardation, which
   * puts a 30 m/s stop at ~50 m instead of ~18 m. Every junction has to be
   * planned for, and that planning is the fun.
   */
  maxForce: 70000,
  frontBias: 0.55,
  /** the handbrake on a bus is a party trick, not a tool */
  handbrakeForce: 34000,
  reverseThreshold: 0.8,
  reverseDelay: 0.22,
} as const;

/* ----------------------------------------------------------------- steering */

export const BUS_STEER = {
  /** ≈29° of lock — a ~12 m turning radius at walking pace */
  maxAngleLow: 0.5,
  /** ≈7.4° at speed */
  maxAngleHigh: 0.13,
  speedForMinAngle: 26,
  speedCurvePower: 1.25,

  /**
   * A third of the Jeep's steering rate. You wind lock on hand over hand and
   * you wind it back off again; snap direction changes are simply not on the
   * menu.
   */
  rateToCentre: 2.4,
  rateAwayFromCentre: 1.55,
  returnRateBonus: 1.1,

  driftExtraAngle: 0.13,

  counterSteerGain: 0.4,
  counterSteerMinSlip: 0.14,
  counterSteerMinSpeed: 6,

  /**
   * The yaw assist is the anti-frustration net that stops 87 000 kg·m² of yaw
   * inertia feeling like steering a building. It is a little *stronger* in
   * proportion than the Jeep's, but the rate it can ask for is a third: the
   * bus turns in willingly, it just cannot turn in *fast*.
   */
  yawAssistRate: 4.0,
  yawAssistMaxAccel: 1.8,
  yawAssistMinSpeed: 2,
  yawAssistRampBand: 9,
  yawAssistDriftGain: 1.35,

  maxYawRate: 1.1,
} as const;

/* --------------------------------------------------------------------- tyre */

export const BUS_TYRE = {
  /**
   * Hard, tall commercial tyres with far less grip than the Jeep's sticky
   * arcade rubber, and deliberately front-limited so the bus understeers and
   * ploughs before it ever swaps ends.
   */
  latGripFront: 1.62,
  latGripRear: 1.72,

  /** a lazy, rounded slip curve: slow to build, slow to let go */
  peakSlip: 0.26,
  tailSlip: 1.0,
  tailGrip: 0.74,

  longGrip: 1.7,

  combinedSlip: 0.5,

  minLoad: 3000,
  maxLoad: 160000,

  loadSensitivity: 0.3,
  /** static corner load, N */
  loadReference: 45100,

  latDeadband: 0.06,
  /**
   * Mushy sidewalls: a bus tyre takes its time killing lateral velocity, which
   * is what gives the whole vehicle its lazy, floaty cornering.
   */
  latRecoveryFraction: 0.72,

  slipNormalise: 13,

  /**
   * THE most important number in this file. Lateral force is applied 0.85 m
   * above the contact patch, which puts the roll centre just 0.48 m under a
   * very high centre of mass. Rollover then needs 48 m/s² of lateral
   * acceleration and the tyres can only ever produce ~35, so the bus leans
   * spectacularly and never actually falls over.
   */
  lateralForceHeight: 0.85,

  slipSpeedGain: 12,
} as const;

/* -------------------------------------------------------------------- drift */

export const BUS_DRIFT = {
  minSpeed: 10,
  handbrakeThreshold: 0.4,
  entrySlip: 0.26,
  entrySteer: 0.5,

  exitSlip: 0.15,
  /** longer than the Jeep's: the bus takes a while to decide it has stopped */
  exitHold: 0.32,
  exitAirtime: 1.0,

  /** the rears let go properly on the handbrake — a sideways bus is the point */
  handbrakeRearGrip: 0.2,
  driftRearGrip: 0.68,
  driftFrontGrip: 0.96,
  /** slow, heavy weight transfer into and out of the slide */
  gripBlendRate: 7,

  liftOffGripRecovery: 1.18,

  spinOutSlip: 1.5,

  /** sideways bus is the best thing in the game, so it pays well */
  chargePerSecond: 0.7,
  chargeSlipReference: 0.6,
  tierCharge: [0.5, 1.1, 1.9] as readonly number[],
  tierBoostSeconds: [0.7, 1.3, 2.2] as readonly number[],
  /** N·s — scaled to mass, these are worth +2.7, +4.9 and +7.6 m/s */
  tierImpulse: [22000, 40000, 62000] as readonly number[],
  tierMeterRefill: [0.12, 0.25, 0.4] as readonly number[],

  pointsPerSecond: 220,
  pointsPerAngleIntegral: 380,
  minScoringDuration: 0.35,
} as const;

/* -------------------------------------------------------------------- boost */

export const BUS_BOOST = {
  drainPerSecond: 0.38,
  minToStart: 0.12,
  minToHold: 0.0,

  /**
   * 92 kN is 11.2 m/s² on 8 200 kg — three quarters of the Jeep's boost
   * acceleration, delivered by what is visibly a school bus. It ramps in
   * slowly and hangs on afterwards, so it reads as a freight train getting
   * away from you rather than a kick.
   */
  thrust: 92000,
  thrustAirScale: 0.35,
  rampInTime: 0.22,
  rampOutTime: 0.3,

  minDuration: 0.25,

  gainNearMiss: 0.07,
  gainAirtimePerSecond: 0.16,
  gainCleanLandingPerSecond: 0.12,
  gainPerDriftRadSecond: 0.11,
  gainDriftMax: 0.5,

  trickleRegen: 0.016,
  trickleSpeed: 14,

  glowRate: 7,
} as const;

/* ---------------------------------------------------------------------- air */

export const BUS_AIR = {
  minAirtimeForJump: 0.14,

  /** less than half the Jeep's air authority — it is a brick, and it flies like one */
  pitchAccel: 3.0,
  rollAccel: 3.6,
  yawAccel: 1.0,

  maxPitchRate: 2.4,
  maxRollRate: 2.8,
  maxYawRate: 1.8,

  angularDamping: 1.1,
  idleAxisDamping: 2.8,

  /**
   * Auto-level is *stronger* than the Jeep's. Landing eight tonnes on its nose
   * is not funny, it is just a reset, so the assist works harder to put the
   * bus back on its wheels.
   */
  autoLevelStrength: 8.5,
  autoLevelRampTime: 0.25,
  autoLevelInputDeadzone: 0.15,
  autoLevelMaxAccel: 15,
  autoLevelDamping: 3.0,
  autoLevelDescentBoost: 1.5,
  autoLevelDescentSpeed: 14,

  /** a wider clean-landing cone, for the same reason */
  cleanLandingAngle: 0.7,

  /** an airborne bus is a genuine event and scores like one */
  pointsPerSecond: 150,
  pointsPerMetre: 70,
  cleanLandingBonus: 1.8,
  minScoringAirtime: 0.3,

  trickFullTurn: Math.PI * 2,
  barrelRollPoints: 1600,
  flipPoints: 2400,
  spinPoints: 1100,
  trickChainMultiplier: 1.6,
} as const;

/* -------------------------------------------------------------- two wheeler */

export const BUS_TWO_WHEELS = {
  /** ≈15°: the bus leans so hard that the bar is lower than the Jeep's */
  minRoll: 0.26,
  minDuration: 0.4,
  graceTime: 0.2,
  minSpeed: 6,
} as const;

/* -------------------------------------------------------------- near misses */

export const BUS_NEAR_MISS = {
  interval: 1 / 15,
  /** a much bigger vehicle sweeps a much bigger volume of "that was close" */
  radius: 5.6,
  minSpeed: 10,
  cooldown: 2.2,
  collisionLockout: 3.0,
} as const;

/* ---------------------------------------------------------------- collision */

export const BUS_COLLISION = {
  /**
   * Both thresholds are scaled by mass, which is what makes the bus *plough*:
   * a bollard that would rattle the Jeep and cancel its drift does not even
   * register as a collision event here.
   */
  minImpulse: 3000,
  cooldown: 0.1,
  heavyImpulse: 42000,
} as const;

/* --------------------------------------------------------- anti-frustration */

export const BUS_RECOVERY = {
  flippedDot: 0.32,
  /** picked back up faster than the Jeep — a beached bus is not entertaining */
  flippedTime: 1.4,
  stuckSpeed: 2.2,
  rightingLift: 1.8,

  safePointInterval: 0.75,
  safePointWheels: 3,
  safePointMinSpeed: 1.5,

  respawnHeight: 1.2,
  respawnSettleTime: 0.3,
} as const;

/* ---------------------------------------------------------- cosmetic motion */

export const BUS_MODEL_FEEL: ModelFeel = {
  /** dive and squat are enormous — the nose drops visibly under braking */
  bodyPitchGain: 0.5,
  /**
   * ~13° of visible lean at the limit, against the Jeep's ~5°. This is the
   * single most important *look* in the vehicle: the bus heels over onto its
   * outside springs and the whole light show tips with it.
   */
  bodyRollGain: 0.8,
  bodyBounceGain: 0.12,
  /** slow to arrive, slow to leave */
  bodyLeanRate: 7.5,
  bodyLeanMax: 0.26,

  headlightOnBefore: 6.8,
  headlightOnAfter: 18.2,
};

/* -------------------------------------------------------------- wheel layout */

export const BUS_WHEEL_LAYOUT: readonly WheelPlacement[] = [
  { x: -BUS_SUSPENSION.halfTrackFront, z: -BUS_SUSPENSION.halfWheelbase, front: true, left: true },
  { x: BUS_SUSPENSION.halfTrackFront, z: -BUS_SUSPENSION.halfWheelbase, front: true, left: false },
  { x: -BUS_SUSPENSION.halfTrackRear, z: BUS_SUSPENSION.halfWheelbase, front: false, left: true },
  { x: BUS_SUSPENSION.halfTrackRear, z: BUS_SUSPENSION.halfWheelbase, front: false, left: false },
];

/* ----------------------------------------------------------------- terrain */

/**
 * Twelve tonnes on leaf springs. The bus notices sand, but it does not get
 * shoved around by it the way the Jeep does, and a kerb barely registers under
 * that much unsprung weight — it goes over the pavement like the pavement is
 * not there, which is exactly the joke.
 */
export const BUS_TERRAIN: TerrainTuning = {
  surfaceSensitivity: 0.55,
  surfaceDragForce: 11000,
  kerbStep: 0.06,
  kerbMinSpeed: 8,
  kerbKick: 130,
  kerbKickMax: 5200,
  kerbCooldown: 0.34,
};

/* ============================================================== the bundle */

export const BUS_TUNING: VehicleTuningSet = {
  chassis: BUS_CHASSIS,
  suspension: BUS_SUSPENSION,
  wheels: BUS_WHEEL_LAYOUT,
  engine: BUS_ENGINE,
  speed: BUS_SPEED,
  brake: BUS_BRAKE,
  steer: BUS_STEER,
  tyre: BUS_TYRE,
  terrain: BUS_TERRAIN,
  drift: BUS_DRIFT,
  boost: BUS_BOOST,
  air: BUS_AIR,
  twoWheels: BUS_TWO_WHEELS,
  nearMiss: BUS_NEAR_MISS,
  collision: BUS_COLLISION,
  recovery: BUS_RECOVERY,
  model: BUS_MODEL_FEEL,
  /** a genuine dual-tone air horn: the same reeds, dropped two octaves */
  horn: { pitch: 0.42, volume: 1.0, cooldown: 0.55 },
  airBrake: {
    enabled: true,
    pitch: 1.85,
    volume: 0.6,
    brakeThreshold: 0.45,
    chargeToFire: 0.25,
    decayRate: 1.2,
    stopSpeed: 2.0,
    cooldown: 0.9,
  },
  /** the body box is lifted clear of the axle line — see BUS_CHASSIS */
  colliderOffsetY: BUS_CHASSIS.colliderOffsetY,
};

/* ========================================================================== */
/*                          geometry + livery constants                       */
/* ========================================================================== */

/**
 * Static spring sag, metres. Kept as a literal so the mesh's ground plane and
 * the simulation's ride height can never drift apart:
 *   45 100 N / ((225 000 + 250 000)/2) = 0.18989 m
 */
const BUS_STATIC_SAG = 0.18989;

/**
 * Everything the procedural bus mesh is built from. Local space, with the body
 * origin at the top of the suspension travel and -Z forward.
 */
export const BUS_GEO = {
  /** where the tyres touch at static ride height — the model's "road" */
  groundLocalY: -(
    BUS_SUSPENSION.wheelRadius +
    (BUS_SUSPENSION.restLength - BUS_STATIC_SAG) -
    BUS_SUSPENSION.anchorY
  ),
  /** static compression the springs settle at, 0..1 — the mesh rest pose */
  staticCompression: BUS_STATIC_SAG / BUS_SUSPENSION.restLength,

  /** body half width, and the skirt/flare that stands proud of it */
  halfWidth: 1.27,
  halfSkirt: 1.31,

  /* --- longitudinal landmarks, local Z (negative = forward) --- */
  zBumper: -5.5,
  zGrille: -5.3,
  zHoodFront: -5.28,
  zCowl: -4.3,
  zWindscreen: -4.22,
  zDoorFront: -4.28,
  zDoorRear: -3.6,
  zFrontAxle: -BUS_SUSPENSION.halfWheelbase,
  zRearAxle: BUS_SUSPENSION.halfWheelbase,
  zBodyRear: 5.5,
  zRearBumper: 5.56,

  /* --- vertical landmarks, local Y --- */
  /** bottom of the side skirt */
  ySkirt: -0.42,
  /** top of the lime rocker band */
  yRocker: -0.1,
  /** passenger floor, ~1.1 m above the road */
  yFloor: 0.32,
  /** bottom of the window band */
  yBeltline: 1.28,
  /** top of the window band */
  yWindowTop: 1.96,
  /** roof plane */
  yRoof: 2.06,
  /** crown of the rounded roof cap */
  yRoofCrown: 2.24,
  /** hood top */
  yHood: 1.24,
  /** windscreen top */
  yWindscreenTop: 2.02,

  /** wheel arch opening radius */
  archRadius: 0.8,
  /** the rear axle carries two tyres a side, this far either side of centre */
  dualOffset: 0.19,

  headlightRadius: 0.155,

  /** steering wheel turns this many times the road wheels — big bus box */
  steeringWheelRatio: 4.2,

  /* --- emissive intensities --- */
  headlightIntensityOn: 2.8,
  headlightIntensityOff: 0.06,
  taillightIntensityOn: 3.6,
  taillightIntensityOff: 0.4,
  markerIntensity: 1.5,
  lightBarIntensity: 3.4,
  festoonIntensity: 3.0,
  interiorIntensity: 1.9,
  signIntensity: 2.2,
  underglowIntensity: 4.5,

  /** how hard the light show pumps on the beat, 0..1 of extra intensity */
  beatDepth: 0.72,
  /** free-running fallback beat when no music clock is attached, Hz */
  fallbackBeatHz: 2.1,
} as const;

/**
 * The livery. School-bus yellow with lime green trim and a red nose — the
 * colours are pulled from the city palette wherever one fits so the bus sits
 * in Old San Juan rather than on top of it.
 */
export const BUS_PAINT = {
  /** school-bus yellow */
  body: 0xf5b81c,
  /** a darker yellow for panel shadow lines */
  bodyDark: 0xd99a10,
  /** lime green — door, flares, skirt, mirror arms, rear bumper */
  lime: PALETTE.facade[5],
  /** the red nose, hood and grille surround */
  red: 0xd0261f,
  redDark: 0x9c1a15,
  chrome: 0xe4ebf2,
  steel: 0x8d97a3,
  matte: 0x1a1a1f,
  rubber: 0x121216,
  glass: 0xbfe6f2,
  /** red vinyl bench seats */
  seat: 0xc4262c,
  seatDark: 0x8d1a1f,
  /** cream ceiling, so the interior lights have something to bounce off */
  ceiling: 0xf7e3af,
  headlight: 0xfff3d0,
  taillight: 0xff2b3c,
  amber: 0xffb020,
  sign: 0xfff0b8,
  underglow: 0xff3fa4,
} as const;

/**
 * The festoon strings. Six chase groups, each a different bulb colour; group i
 * lights on beat phase (i / 6), so the whole bus runs a chase in time with the
 * music.
 */
export const BUS_FESTOON_COLORS: readonly number[] = [
  0xff3fa4, // hot pink
  0xffd166, // sun yellow
  0x2fa8a0, // caribbean teal
  0x8bc34a, // lime
  0xff6b35, // orange
  0xa663cc, // violet
];
