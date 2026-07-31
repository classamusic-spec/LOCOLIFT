/**
 * Loco Lift — the Jeep's tuning bible.
 *
 * EVERY magic number that shapes how the Jeep drives, looks and sounds lives in
 * this file. Nothing else in `src/vehicle/**` is allowed to hard-code a feel
 * constant. If the Jeep feels wrong, it gets fixed here.
 *
 * Units are SI: metres, seconds, kilograms, newtons, radians.
 * World gravity is CONFIG.gravity = -22 m/s² — deliberately ~2.2x real gravity
 * so the car plants hard, jumps punchily and lands without floating. All the
 * force numbers below are sized for that gravity, not for 9.81.
 *
 * Local axis convention for the whole vehicle module:
 *   forward = local -Z     right = local +X     up = local +Y
 * Wheel indices: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
 */

/* ------------------------------------------------------------------ chassis */

export const CHASSIS = {
  /** dry mass of the Jeep, kg. Heavy enough to feel planted, light enough to fling. */
  mass: 1400,

  /** half-extents of the single box collider, metres (≈4.2 m × 1.84 m × 1.24 m) */
  colliderHalfX: 0.92,
  colliderHalfY: 0.46,
  colliderHalfZ: 2.1,

  /**
   * The collider box is raised relative to the body origin so that even at full
   * suspension compression its underside stays ~0.18 m clear of the road and the
   * chassis never scrapes on a landing.
   */
  colliderOffsetY: 0.3,

  /**
   * Centre of mass, local space. Sits low and a touch rearward: low kills the
   * roll-over tendency of a tall off-roader, rearward loads the driven axle so
   * the tail steps out cleanly instead of understeering.
   */
  comLocalX: 0,
  comLocalY: -0.02,
  comLocalZ: 0.05,

  /** rigid body damping — most of the real damping is our own aero + tyres */
  linearDamping: 0.02,
  angularDamping: 0.12,

  /** collider surface properties; the tyre model does the real work */
  friction: 0.55,
  restitution: 0.06,

  /**
   * Principal moments of inertia about the CoM, kg·m², computed for the box
   * above at `mass`. We keep our own copy because the vehicle converts desired
   * angular ACCELERATIONS into torque impulses and the physics backend does not
   * expose its inertia tensor.
   *   Ixx (pitch) = m/12 · (dy² + dz²)
   *   Iyy (yaw)   = m/12 · (dx² + dz²)
   *   Izz (roll)  = m/12 · (dx² + dy²)
   */
  inertiaPitch: 2460,
  inertiaYaw: 2830,
  inertiaRoll: 560,
} as const;

/* --------------------------------------------------------------- suspension */

export const SUSPENSION = {
  /** wheel radius; big knobbly off-road rubber */
  wheelRadius: 0.46,
  /** tyre section width, used by the model and by the skid emitters */
  wheelWidth: 0.32,

  /** half-wheelbase — front axle at z=-1.45, rear at z=+1.45 (2.9 m wheelbase) */
  halfWheelbase: 1.45,
  /** half-track — 1.64 m between wheel centres */
  halfTrackFront: 0.82,
  halfTrackRear: 0.82,

  /** local Y of the suspension top mount (where the "strut" attaches) */
  anchorY: 0.12,

  /** maximum suspension travel, metres. Long travel = visible body movement. */
  restLength: 0.36,

  /** a little extra ray length so a wheel just off the ground still finds it */
  raySkin: 0.06,

  /**
   * Spring rate per corner, N/m. Sized so static load (1400·22/4 = 7700 N) sits
   * at ~40 % compression: 7700 / (0.36·0.40) = 53 472. Undamped corner
   * frequency ≈ 1.96 Hz — sporty, not floaty.
   */
  springRateFront: 53000,
  springRateRear: 56000,

  /**
   * Damper rates, N·s/m. Critical damping for a 350 kg corner at 53 kN/m is
   * ≈8 600, so these are ~0.48 (bump) / 0.38 (rebound) of critical: enough to
   * kill wallow, loose enough that the body still visibly pitches and squats.
   */
  damperCompress: 4200,
  damperRebound: 3300,

  /** hard ceiling on a single corner's suspension force, N — landing safety */
  maxSpringForce: 130000,

  /**
   * Anti-roll bar rate, N per unit of normalised compression difference.
   * Soft enough that the Jeep visibly heels over in a corner — that lean is
   * half the character — but stiff enough that it never trips over itself.
   */
  antiRollFront: 11000,
  antiRollRear: 8000,

  /**
   * How fast the visual wheel/body follows the raw compression signal.
   * Raw compression is noisy over cobblestones; the mesh is smoothed, the
   * physics is not.
   */
  visualSmoothRate: 26,

  /** extra droop the visual wheel hangs to when fully airborne, 0..1 of travel */
  airborneDroop: 1,
} as const;

/* ------------------------------------------------------------------- engine */

export const ENGINE = {
  /** idle / redline in rpm; only the shape matters, this is an arcade engine */
  idleRpm: 850,
  redlineRpm: 7200,
  /** rpm at which the auto box grabs the next gear */
  shiftUpRpm: 6650,
  /** rpm the box drops back down at */
  shiftDownRpm: 2900,
  /** torque is cut for this long on a shift — the "punch" between gears */
  shiftTimeSec: 0.11,

  /**
   * Torque curve, N·m, sampled evenly from 0 rpm to redline. Fat, flat and
   * low-slung: a big ugly off-road motor with all its shove down low. Peaks at
   * ~44 % of redline and still pulls hard at the limiter.
   */
  torqueCurve: [292, 443, 516, 553, 564, 556, 534, 492, 430, 337] as readonly number[],

  /**
   * Gearbox: 5 forward speeds plus a reverse. Geared so 5th sits near the
   * limiter at the natural top speed and the shifts land at roughly
   * 18 / 26 / 36 / 46 m/s — close enough together to keep the engine shouting.
   */
  gearRatios: [4.35, 2.95, 2.15, 1.68, 1.4] as readonly number[],
  reverseRatio: 4.0,
  finalDrive: 4.1,
  /** driveline losses */
  efficiency: 0.92,

  /** torque split front/rear. Rear-biased AWD: traction off the line, tail-happy. */
  driveBiasRear: 0.72,

  /** engine braking force per m/s of forward speed when off throttle, N·s/m */
  engineBrakeCoeff: 260,
  /** flat engine-braking force so the Jeep actually slows at low speed, N */
  engineBrakeBase: 900,

  /** how fast displayed rpm chases the true value (audio smoothing), 1/s */
  rpmSmoothRate: 14,
} as const;

/* ------------------------------------------------------------------ gearbox */

/** number of forward gears, exported for HUD/audio */
export const GEAR_COUNT = ENGINE.gearRatios.length;

/* ------------------------------------------------------------------- speeds */

export const SPEED = {
  /**
   * Ceilings the soft limiter aims at. Because the limiter fades force out
   * rather than clamping velocity, the *measured* terminal speed settles a
   * little under each of these: ≈51 m/s natural, ≈58 m/s on boost.
   */
  topSpeed: 53,
  topSpeedBoost: 59,
  /** reverse is deliberately slow and comedic */
  topSpeedReverse: 13,

  /**
   * Soft limiter: drive force AND boost thrust fade out over this many m/s
   * below the cap, so the Jeep eases into its top speed instead of slamming
   * into a wall — and so boost can never rocket past the ceiling.
   */
  limiterBand: 5,

  /** quadratic aero drag: F = dragCoeff · v². 0.45·52² ≈ 1217 N at top speed. */
  dragCoeff: 0.45,
  /** extra drag while airborne so the Jeep doesn't sail forever */
  dragCoeffAir: 0.62,
  /**
   * Rolling resistance, N per wheel on the ground. Kept low: at arcade speeds
   * a realistic value just eats the first three seconds of every launch.
   */
  rollingResistance: 120,

  /** downforce: F = downforceCoeff · v², N. Plants the car at speed. */
  downforceCoeff: 1.9,
  /** cap on downforce so it never crushes the suspension, N */
  downforceMax: 9000,
} as const;

/* ------------------------------------------------------------------ braking */

export const BRAKE = {
  /**
   * Total braking force with the pedal buried, N, split across all four wheels
   * by `frontBias`. 36 kN on 1400 kg is ~26 m/s² — arcade-short stopping
   * distances, which matters when a plaza appears out of a blind alley.
   */
  maxForce: 36000,
  /** share of braking effort on the front axle — nose-heavy so it dives */
  frontBias: 0.58,
  /** handbrake force per rear wheel, N */
  handbrakeForce: 14000,
  /** below this forward speed the brake input becomes reverse throttle, m/s */
  reverseThreshold: 0.8,
  /** how long the brake must be held at a standstill before reverse engages, s */
  reverseDelay: 0.18,
} as const;

/* ----------------------------------------------------------------- steering */

export const STEER = {
  /** maximum front wheel angle at a standstill, radians (≈38°) */
  maxAngleLow: 0.66,
  /** maximum front wheel angle at/above `speedForMinAngle`, radians (≈11°) */
  maxAngleHigh: 0.19,
  /** speed at which steering has tightened all the way down, m/s */
  speedForMinAngle: 42,
  /** curve shape for the speed-sensitive falloff; >1 keeps angle longer */
  speedCurvePower: 1.45,

  /** how fast the wheels can sweep toward the target angle, rad/s */
  rateToCentre: 7.5,
  rateAwayFromCentre: 5.2,
  /** the wheels return to centre faster than they turn away at speed */
  returnRateBonus: 3.0,

  /** extra steering lock available while drifting, radians */
  driftExtraAngle: 0.24,

  /**
   * Counter-steer assist. Scaled by SettingsState.assistSteering (0..1).
   * At full assist the car quietly adds this fraction of the correction the
   * player *should* be dialling in during a slide.
   */
  counterSteerGain: 0.55,
  /** the assist only wakes up above this slip angle, radians */
  counterSteerMinSlip: 0.12,
  /** and above this speed, m/s */
  counterSteerMinSpeed: 6,

  /**
   * Yaw-rate assist — the single most important arcade cheat. Tyres alone make
   * an off-roader wallow; a bounded nudge toward the yaw rate the steering
   * angle implies makes turn-in instant without ever feeling like rails.
   * Value is the fraction of the error closed per second.
   */
  yawAssistRate: 5.5,
  /** hard cap on assist-generated yaw acceleration, rad/s² */
  yawAssistMaxAccel: 5.0,
  /** yaw assist authority ramps in over this speed, m/s */
  yawAssistMinSpeed: 2.5,
  /** ... and reaches full authority this many m/s above that */
  yawAssistRampBand: 8,
  /** while drifting the target yaw rate is multiplied by this — rotate harder */
  yawAssistDriftGain: 1.5,

  /** upper bound on the yaw rate the assist will ever ask for, rad/s */
  maxYawRate: 2.7,
} as const;

/* --------------------------------------------------------------------- tyre */

export const TYRE = {
  /**
   * Lateral grip coefficient (peak µ). Arcade-high: the Jeep sticks hard until
   * you deliberately break it loose.
   */
  latGripFront: 2.35,
  latGripRear: 2.2,

  /**
   * Slip-angle curve. Grip rises linearly to `peakSlip`, then falls off toward
   * `tailGrip` (as a fraction of peak) by `tailSlip`. The plateau after that is
   * what lets the player hold a slide instead of snapping.
   */
  peakSlip: 0.19,
  tailSlip: 0.75,
  tailGrip: 0.68,

  /** longitudinal grip coefficient — traction limit for drive and brake force */
  longGrip: 2.6,

  /**
   * Combined-slip softness. 1 = a strict friction circle (realistic, twitchy),
   * 0 = longitudinal and lateral forces are fully independent (arcade, sloppy).
   */
  combinedSlip: 0.65,

  /** minimum normal load a wheel is credited with, N — keeps inside wheels alive */
  minLoad: 900,
  /** maximum normal load any one wheel contributes to grip, N */
  maxLoad: 26000,

  /**
   * Load sensitivity: real tyres lose µ as load rises. A little of this makes
   * weight transfer meaningful. 0 = none, 1 = strong.
   */
  loadSensitivity: 0.22,
  /** the load at which load sensitivity is neutral, N (≈ static corner load) */
  loadReference: 7700,

  /** lateral velocity below which a wheel is considered fully stuck, m/s */
  latDeadband: 0.05,

  /** how much of the remaining lateral velocity a stuck tyre kills per step */
  latRecoveryFraction: 0.9,

  /** slip value (m/s of contact-patch slide) that maps to wheelSlip = 1 */
  slipNormalise: 11,

  /**
   * Lateral force is applied this far ABOVE the contact patch. Raising the roll
   * centre is the cheapest possible rollover fix: the Jeep still leans hard on
   * its springs but it stops tripping over itself in a hairpin.
   */
  lateralForceHeight: 0.3,

  /**
   * Wheelspin visualisation. Contact-patch slide speed produced per unit of
   * over-demand (demand/limit - 1), m/s. Purely cosmetic + drives wheelSlip.
   */
  slipSpeedGain: 14,
} as const;

/* -------------------------------------------------------------------- drift */

export const DRIFT = {
  /** below this speed you simply cannot drift, m/s */
  minSpeed: 9,
  /** handbrake input above this arms the drift immediately */
  handbrakeThreshold: 0.4,
  /** ... or a slip angle above this at speed with steering held, radians (≈17°) */
  entrySlip: 0.3,
  /** steering input needed to enter a drift without the handbrake */
  entrySteer: 0.45,

  /** drift ends when slip falls below this, radians (≈9°) ... */
  exitSlip: 0.155,
  /** ... and stays below it for this long, seconds. Short = snappy exits. */
  exitHold: 0.22,
  /** drift also ends after this long fully airborne, seconds */
  exitAirtime: 0.9,

  /** rear lateral grip multiplier while the handbrake is pulled */
  handbrakeRearGrip: 0.28,
  /** rear lateral grip multiplier while drifting without the handbrake */
  driftRearGrip: 0.55,
  /** front grip is trimmed slightly too so the nose doesn't bite and snap back */
  driftFrontGrip: 0.94,
  /** how fast grip multipliers blend in/out, 1/s — this is the "feel" of entry */
  gripBlendRate: 12,

  /**
   * Power oversteer. Rear grip is scaled between `liftOffGripRecovery` (fully
   * off the throttle — the tail hooks back up and the slide ends) and 1.0 (pinned
   * throttle — the slide sustains). This is what makes the throttle the drift
   * control rather than just an accelerator.
   */
  liftOffGripRecovery: 1.22,

  /** slip angle beyond which the drift is "spun out" and auto-cancels, radians */
  spinOutSlip: 1.75,

  /** charge earned per second of drift at 45° of slip */
  chargePerSecond: 0.62,
  /** charge is scaled by (|slip| / this), clamped to 1.6 */
  chargeSlipReference: 0.7,
  /** mini-turbo tier thresholds in accumulated charge */
  tierCharge: [0.55, 1.25, 2.2] as readonly number[],
  /** auto-boost seconds granted per tier */
  tierBoostSeconds: [0.55, 1.1, 1.9] as readonly number[],
  /**
   * Instant forward impulse per tier, N·s. On 1400 kg these are worth roughly
   * +3, +5 and +8 m/s of immediate shove. Scaled by the speed limiter so a
   * mini-turbo at the ceiling shoves you along instead of past it.
   */
  tierImpulse: [4000, 7000, 11000] as readonly number[],
  /** boost meter refilled per tier, 0..1 */
  tierMeterRefill: [0.1, 0.22, 0.38] as readonly number[],

  /** score: base points per second of drift */
  pointsPerSecond: 140,
  /** score: points per radian·second of accumulated slip */
  pointsPerAngleIntegral: 260,
  /** drifts shorter than this award nothing, seconds */
  minScoringDuration: 0.35,
} as const;

/* -------------------------------------------------------------------- boost */

export const BOOST = {
  /** meter drain while boosting, per second */
  drainPerSecond: 0.42,
  /** you need at least this much in the meter to start a boost */
  minToStart: 0.1,
  /** boost cuts out when the meter empties below this */
  minToHold: 0.0,

  /** thrust force along forward while boosting, N. Violent by design. */
  thrust: 21000,
  /** thrust while airborne is reduced — no wheels, but still some rocket */
  thrustAirScale: 0.45,
  /** thrust ramps in over this long for a shove rather than a step, s */
  rampInTime: 0.14,
  /** and fades out over this long */
  rampOutTime: 0.22,

  /** a boost is forced to last at least this long once started, s */
  minDuration: 0.18,

  /** meter gained per near miss */
  gainNearMiss: 0.055,
  /** meter gained per second of clean airtime */
  gainAirtimePerSecond: 0.12,
  /** meter gained on a clean landing, scaled by airtime */
  gainCleanLandingPerSecond: 0.09,
  /** meter gained per unit of drift angle-integral (rad·s) */
  gainPerDriftRadSecond: 0.09,
  /** hard cap on meter gained from any single drift */
  gainDriftMax: 0.45,

  /** passive trickle regeneration per second while driving above trickleSpeed */
  trickleRegen: 0.012,
  trickleSpeed: 18,

  /** exhaust/underglow visual response rate, 1/s */
  glowRate: 9,
} as const;

/* ---------------------------------------------------------------------- air */

export const AIR = {
  /** must be off the ground this long before it counts as a jump, s */
  minAirtimeForJump: 0.12,

  /** angular acceleration authority from player input, rad/s² */
  pitchAccel: 7.5,
  rollAccel: 10.5,
  /** yaw authority is deliberately weak — you steer with roll+pitch in the air */
  yawAccel: 2.2,

  /** hard caps on player-driven rotation rates, rad/s */
  maxPitchRate: 5.5,
  maxRollRate: 7.5,
  maxYawRate: 3.5,

  /** passive angular damping in the air, 1/s */
  angularDamping: 0.9,
  /** extra damping applied to an axis the player is NOT commanding, 1/s */
  idleAxisDamping: 2.6,

  /**
   * Auto-level assist. When the player isn't touching the air stick, the Jeep
   * quietly rights itself so landings are clean. Strength ramps up the longer
   * you're airborne, so a small kerb hop is untouched but a big jump lands flat.
   */
  autoLevelStrength: 6.5,
  /** seconds of airtime before auto-level reaches full strength */
  autoLevelRampTime: 0.3,
  /** auto-level is suppressed while the player is inputting more than this */
  autoLevelInputDeadzone: 0.15,
  /** auto-level never generates more than this angular accel, rad/s² */
  autoLevelMaxAccel: 12,
  /** derivative gain — damps the approach so it settles instead of wobbling */
  autoLevelDamping: 2.6,
  /**
   * Urgency multiplier applied as the Jeep falls: the assist gets stronger the
   * faster you are coming down, so a long drop off a fort wall still lands flat
   * even if you were showboating right up to the last moment.
   */
  autoLevelDescentBoost: 1.3,
  /** descent speed at which that boost is fully applied, m/s */
  autoLevelDescentSpeed: 14,
  /** auto-level ignores yaw entirely — the player keeps their heading */

  /** landing counts as clean within this many radians of level (35°) */
  cleanLandingAngle: 0.611,

  /** score for a jump: points per second of airtime */
  pointsPerSecond: 90,
  /** score: points per metre of peak height above take-off */
  pointsPerMetre: 45,
  /** multiplier applied to jump points for a clean landing */
  cleanLandingBonus: 1.6,
  /** jumps shorter than this score nothing, s */
  minScoringAirtime: 0.35,

  /* --- tricks --- */
  /** a full rotation about an axis, radians */
  trickFullTurn: Math.PI * 2,
  /** points for each completed barrel roll */
  barrelRollPoints: 900,
  /** points for each completed back/front flip */
  flipPoints: 1400,
  /** points for each completed 360 spin */
  spinPoints: 600,
  /** every extra rotation in the same air is worth this much more */
  trickChainMultiplier: 1.5,
} as const;

/* -------------------------------------------------------------- two wheeler */

export const TWO_WHEELS = {
  /** roll angle beyond which we call it a two-wheeler, radians (≈20°) */
  minRoll: 0.35,
  /** must be held this long before it starts counting, s */
  minDuration: 0.4,
  /** allowed gap before the run is considered over, s */
  graceTime: 0.15,
  /** minimum speed for a two-wheeler to count, m/s */
  minSpeed: 6,
} as const;

/* ------------------------------------------------------------- near misses */

export const NEAR_MISS = {
  /** how often the overlap query runs, seconds (15 Hz — cheap) */
  interval: 1 / 15,
  /** radius of the near-miss sphere around the Jeep, metres */
  radius: 3.4,
  /** minimum speed for anything to count as a near miss, m/s */
  minSpeed: 13,
  /** the same body cannot score another near miss for this long, s */
  cooldown: 2.2,
  /** a body we actually hit is locked out for this long, s */
  collisionLockout: 3.0,
} as const;

/* ---------------------------------------------------------------- collision */

export const COLLISION = {
  /** contacts below this impulse are ignored entirely, N·s */
  minImpulse: 900,
  /** we won't re-emit a collision event for this long, s */
  cooldown: 0.09,
  /** impulse considered a "heavy" hit — used by fx/audio via the payload */
  heavyImpulse: 9000,
} as const;

/* --------------------------------------------------------- anti-frustration */

export const RECOVERY = {
  /** vehicle up · world up below this counts as "on its roof / side" */
  flippedDot: 0.32,
  /** must be flipped AND slow for this long before we auto-right, s */
  flippedTime: 1.6,
  /** speed under which "stuck" counts, m/s */
  stuckSpeed: 2.2,
  /** how far above the road the auto-right lifts the Jeep, metres */
  rightingLift: 0.9,

  /** how often a safe respawn point is recorded while driving normally, s */
  safePointInterval: 0.75,
  /** a safe point requires at least this many wheels on the ground */
  safePointWheels: 3,
  /** ... and at least this much speed, so we don't record a wall we're wedged in */
  safePointMinSpeed: 1.5,

  /** respawn drops the Jeep from this height above the target point, metres */
  respawnHeight: 0.9,
  /** control is briefly frozen after a respawn so it settles, s */
  respawnSettleTime: 0.25,
} as const;

/* ---------------------------------------------------------------- the model */

/**
 * Everything the procedural Jeep mesh needs. Kept here so the visual proportions
 * and the physical proportions can never drift apart.
 */
export const MODEL = {
  /** ground plane in local space at static ride height — where the tyres touch */
  groundLocalY: -(
    SUSPENSION.wheelRadius +
    (SUSPENSION.restLength - 0.1453) -
    SUSPENSION.anchorY
  ),

  /** overall bodywork half width (before flares) */
  halfWidth: 0.78,
  /** flares stick out to here */
  halfWidthFlare: 1.0,

  /** longitudinal landmarks, local Z (negative = forward) */
  zBullBar: -2.16,
  zGrille: -2.0,
  zBonnetFront: -1.98,
  zFrontAxle: -1.45,
  zCowl: -0.62,
  zWindscreenBase: -0.5,
  zSeatFront: 0.02,
  zBedFront: 0.5,
  zRearAxle: 1.45,
  zTailgate: 2.04,
  zSpare: 2.3,

  /** vertical landmarks, local Y */
  yFloor: 0.0,
  yBonnet: 0.5,
  ySide: 0.62,
  yWindscreenTop: 1.04,
  yCage: 1.18,
  ySign: 1.32,

  /** headlight radius */
  headlightRadius: 0.155,

  /**
   * Cosmetic body lean layered on TOP of the rigid body's real motion. The
   * chassis already squats and dives for real; this exaggerates it so it reads
   * from the chase camera. Radians per unit of axle/side compression difference.
   */
  bodyPitchGain: 0.3,
  bodyRollGain: 0.36,
  /** metres the body sinks per unit of average compression above static */
  bodyBounceGain: 0.07,
  /** rate the body lean chases its target, 1/s */
  bodyLeanRate: 11,
  /** cosmetic lean is clamped to this many radians so it never clips */
  bodyLeanMax: 0.2,

  /** steering wheel turns this many times the road wheels */
  steeringWheelRatio: 3.2,

  /** night threshold in hours — headlights on outside 6.5..18.5 */
  headlightOnBefore: 6.8,
  headlightOnAfter: 18.2,

  /** emissive intensities */
  headlightIntensityOn: 2.6,
  headlightIntensityOff: 0.06,
  taillightIntensityOn: 3.4,
  taillightIntensityOff: 0.35,
  signIntensity: 1.6,
  boostGlowIntensity: 5.5,
} as const;

/**
 * Wheel layout, derived once. Front wheels steer; rear wheels take the
 * handbrake and the bigger share of drive torque.
 */
export const WHEEL_LAYOUT: ReadonlyArray<{
  x: number;
  z: number;
  front: boolean;
  left: boolean;
}> = [
  { x: -SUSPENSION.halfTrackFront, z: -SUSPENSION.halfWheelbase, front: true, left: true },
  { x: SUSPENSION.halfTrackFront, z: -SUSPENSION.halfWheelbase, front: true, left: false },
  { x: -SUSPENSION.halfTrackRear, z: SUSPENSION.halfWheelbase, front: false, left: true },
  { x: SUSPENSION.halfTrackRear, z: SUSPENSION.halfWheelbase, front: false, left: false },
];

/** Handy shared indices. */
export const WHEEL_FL = 0;
export const WHEEL_FR = 1;
export const WHEEL_RL = 2;
export const WHEEL_RR = 3;
