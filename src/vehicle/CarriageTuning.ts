/**
 * Loco Lift — el coche de caballos: tuning bible.
 *
 * A working tourist carriage of the kind that still turns out of the plazas of
 * the old city: a black-lacquered open victoria on chrome-yellow spoked wheels,
 * a blue-and-white striped canopy over the passenger bench, and one dapple-grey
 * Paso Fino in full harness between the shafts.
 *
 * It is the third point of the roster triangle. The Jeep is fast and loose, the
 * bus is heavy and hilarious; the carriage is **small, springy and impossibly
 * manoeuvrable**, and it earns its speed instead of just having it.
 *
 *              Jeep            Bus             Carriage
 *   mass       1 400 kg        8 200 kg        1 150 kg
 *   top        ~50 m/s         ~34 m/s         ~13 m/s   (~19 at a gallop)
 *   0–10       ~1.2 s          ~2.4 s          ~4.3 s
 *   lock       38°             29°             41°  on a 1.40 m wheelbase
 *   turn circle ~9 m           ~24 m           ~3.6 m
 *   width      1.84 m          2.56 m          1.56 m
 *   gears      5               5               3 = walk · trot · canter
 *
 * The three design commitments every number below serves:
 *
 *  1. **Nimble, not fast.** A 1.40 m wheelbase, 41° of lock and a yaw assist
 *     with a high rate ceiling but a low speed floor. It turns inside its own
 *     length in a plaza, threads a 2 m callejón, and hops kerbs and stair
 *     nosings the other two beach themselves on (the collider floats 0.38 m off
 *     the road, which is the whole trick).
 *  2. **The gallop is the boost.** `boost.thrust` is worth 6.5 m/s² on top of a
 *     drivetrain that only makes ~1 m/s² at speed, so spurring the horse very
 *     nearly doubles the vehicle. And the meter fills from *near misses at
 *     walking pace* — `nearMiss.minSpeed` is 4.5 m/s against the Jeep's 13 —
 *     so the carriage is paid for going where nothing else fits, which is
 *     exactly what it is for.
 *  3. **It rocks.** Soft springs (1.92 Hz), a rebound damper at 0.21 of critical
 *     and the biggest cosmetic pitch gain in the game. The body is never still.
 *
 * The horse is **never** shown being hurt, driven down or struck. There is no
 * whip on the box, the reins hang in a loose loop, and every reaction in the
 * rig (a shy, a head toss, a snort) is a startle, never an injury. The carriage
 * trade in Old San Juan is a real, licensed, affectionate thing and it is drawn
 * that way. See `docs/ART_REFERENCE.md` §7.
 *
 * Units are SI. World gravity is CONFIG.gravity = -22 m/s², so every force here
 * is sized for 2.24 g, not for 9.81.
 *
 * Local axes: forward = -Z, right = +X, up = +Y.
 * Wheel indices: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
 *
 * The body origin sits at the **centre of the whole rig**, horse included, so
 * the single symmetric box collider wraps the animal as well as the carriage
 * and you can never push a horse's head through a wall. The mass is then
 * re-anchored over the wheels with `comLocalZ`.
 */
import type {
  ModelFeel,
  TerrainTuning,
  VehicleTuningSet,
  WheelPlacement,
} from './VehicleTuning';

/* ------------------------------------------------------------------ chassis */

export const CARRIAGE_CHASSIS = {
  /** carriage ~600 kg, horse ~340 kg, driver and two fares ~210 kg */
  mass: 1150,

  /**
   * Half-extents of the single box collider: 1.56 m × 1.90 m × 5.50 m. Long,
   * narrow and lifted clear of the road by `colliderOffsetY` — the box spans
   * local Y −0.23…+1.67 with the road at −0.6394, so there is 0.41 m of air
   * under it. That clearance is a *gameplay* number: the carriage rides over
   * kerbs, plaza thresholds and stair nosings that stop the Jeep dead.
   */
  colliderHalfX: 0.78,
  colliderHalfY: 0.95,
  colliderHalfZ: 2.75,
  colliderOffsetY: 0.72,

  /**
   * Centre of mass. `comLocalZ` is the mid-point of the two axles (0.90 and
   * 2.30), which is what stops a rig whose geometry runs 2.75 m forward of the
   * origin from pitching onto its nose: the springs and the weight agree about
   * where the vehicle is. Y is a hair below the origin, ~0.59 m over the road —
   * low enough that a narrow-tracked carriage cannot trip itself up.
   */
  comLocalX: 0,
  comLocalY: -0.05,
  comLocalZ: 1.6,

  linearDamping: 0.02,
  /** iron tyres on adoquín scrub off yaw quickly; this is most of that feel */
  angularDamping: 0.22,

  friction: 0.5,
  restitution: 0.05,

  /**
   * Principal moments about the CoM, kg·m². These MUST match the tensor the
   * physics layer derives from the collider box (m/3 · (h² + h²)) or the yaw
   * assist asks for the wrong torque:
   *   k = 1150/3 = 383.33
   *   pitch = k·(hy² + hz²) = 383.33·(0.9025 + 7.5625) = 3 245
   *   yaw   = k·(hx² + hz²) = 383.33·(0.6084 + 7.5625) = 3 132
   *   roll  = k·(hx² + hy²) = 383.33·(0.6084 + 0.9025) =   579
   * The roll figure is the interesting one: at a fifth of the Jeep's, the body
   * answers a kerb strike instantly, which is why it feels so light.
   */
  inertiaPitch: 3245,
  inertiaYaw: 3132,
  inertiaRoll: 579,
} as const;

/* --------------------------------------------------------------- suspension */

export const CARRIAGE_SUSPENSION = {
  /**
   * The REAR wheel — 1.10 m across, the signature of the whole vehicle. The
   * simulation runs one radius for all four struts; the front wheels are
   * genuinely smaller (0.75 m) and `CarriageModel` drops their hubs by the
   * difference so the small wheel still meets the same road.
   */
  wheelRadius: 0.55,
  /** iron tyre on a wooden felloe — a hand's width, no more */
  wheelWidth: 0.09,

  /** 1.40 m wheelbase: front axle at z = +0.90, rear at z = +2.30 */
  halfWheelbase: 0.7,
  /** 1.20 m front track (it has to tuck under the body at full lock) */
  halfTrackFront: 0.6,
  /** 1.32 m rear track */
  halfTrackRear: 0.66,

  /** strut top mounts sit just above the body origin */
  anchorY: 0.1,

  /** long soft travel — leaf springs and no dampers worth the name */
  restLength: 0.34,

  raySkin: 0.06,

  /**
   * Spring rate per corner, N/m. Static corner load is 1150·22/4 = 6 325 N; at
   * 42 000 N/m average that settles at 0.1506 m — 44 % of travel — for a
   * 1.92 Hz corner frequency. Softer than the Jeep and only a little stiffer
   * than the bus, on a fifth of the bus's mass.
   */
  springRateFront: 40000,
  springRateRear: 44000,

  /**
   * Critical damping for a 287.5 kg corner at 42 kN/m is ≈6 950 N·s/m, so these
   * are 0.35 (bump) and 0.21 (rebound) of critical. A carriage has *no* dampers
   * at all — the friction in the leaves is the only thing stopping it — and
   * this is as close to that as is drivable. It bobs for a beat after every
   * kerb, and that bobbing is the vehicle's whole personality.
   */
  damperCompress: 2450,
  damperRebound: 1450,

  maxSpringForce: 90000,

  /**
   * Very soft anti-roll: a carriage sways onto its outside springs and stays
   * there for a moment. The front bar is stiffer so it pushes wide rather than
   * pivoting on the rear.
   */
  antiRollFront: 5200,
  antiRollRear: 3400,

  visualSmoothRate: 24,

  airborneDroop: 1,
} as const;

/* ------------------------------------------------------------------- engine *
 * There is no engine. There is a horse.                                       *
 *                                                                             *
 * The drivetrain block is repurposed wholesale as the animal's effort curve,   *
 * and the mapping is deliberately literal so the rest of the game gets a       *
 * signal it can use without knowing what a horse is:                           *
 *                                                                             *
 *   `gear`          1 · 2 · 3        = walk · trot · canter                    *
 *   `engineRpmNorm` 0..1             = stride rate, 45..200 strides/minute     *
 *   `shiftTimeSec`  0.22 s           = the beat where the horse changes gait   *
 *                                                                             *
 * An audio module can drive hoofbeats straight off `engineRpmNorm` and the     *
 * gait straight off `gear`, with no new API. `finalDrive` is 1 so the ratios   *
 * read as what they are: the road speed each gait tops out at.                 */

export const CARRIAGE_ENGINE = {
  /** strides/minute at a standstill — the horse fidgets, it never idles at 0 */
  idleRpm: 45,
  /** flat gallop */
  redlineRpm: 200,
  /** the horse breaks into the next gait here ... */
  shiftUpRpm: 175,
  /** ... and drops back to the last one here. A wide band: gaits are sticky. */
  shiftDownRpm: 78,
  /** the gathering beat as it changes gait — long, and you feel every one */
  shiftTimeSec: 0.22,

  /**
   * Effort curve, N·m, sampled evenly from 0 to redline. Front-loaded to a
   * degree no engine manages: a horse leans into the collar and *goes*, then
   * runs out of anything more to give. Peak at ~22 % of stride rate, and only
   * 62 % of peak left at a flat gallop.
   */
  torqueCurve: [
    1250, 1600, 1620, 1560, 1480, 1400, 1320, 1240, 1140, 1000,
  ] as readonly number[],

  /**
   * Three gaits, not five gears. With finalDrive = 1 and a 0.55 m wheel the
   * stride rate is v · ratio · 18.364, so the shift points land at
   *   walk → trot   5.0 m/s
   *   trot → canter 7.8 m/s
   * and the canter reaches redline at 14 m/s.
   */
  gearRatios: [1.9, 1.22, 0.78] as readonly number[],
  /** backing up is a slow, careful, one-step-at-a-time business */
  reverseRatio: 2.6,
  finalDrive: 1.0,
  /** harness and traces lose almost nothing */
  efficiency: 0.95,

  /** the horse is in front — this is a pure "front wheel drive" vehicle */
  driveBiasRear: 0.06,

  /**
   * Lift the reins and the horse simply stops driving; a carriage with no
   * brakes on the horse's end still slows hard because 340 kg of animal stops
   * pulling. Big flat term, small speed term.
   */
  engineBrakeCoeff: 190,
  engineBrakeBase: 1500,

  rpmSmoothRate: 11,
} as const;

/* ------------------------------------------------------------------- speeds */

export const CARRIAGE_SPEED = {
  /**
   * A hard road canter. The limiter fades force out rather than clamping
   * velocity, so the measured terminal speed lands a little under each of
   * these: ≈13.4 m/s natural, ≈18.8 m/s at a gallop.
   */
  topSpeed: 14.4,
  topSpeedBoost: 19.8,
  /** you back a horse at a walk or not at all */
  topSpeedReverse: 2.6,

  /** narrow band — a horse hits its limit and holds there */
  limiterBand: 2.5,

  /** small frontal area, but a very draggy shape once you add a horse to it */
  dragCoeff: 3.0,
  dragCoeffAir: 3.6,
  /** iron tyres on adoquín, per wheel on the ground */
  rollingResistance: 90,

  /** no aero whatsoever; this is a stability floor and nothing else */
  downforceCoeff: 0.8,
  downforceMax: 5000,
} as const;

/* ------------------------------------------------------------------ braking */

export const CARRIAGE_BRAKE = {
  /**
   * 15 kN on 1 150 kg is 13 m/s² — half the Jeep's retardation but on a
   * vehicle doing a third of the speed, so it stops in a *shorter distance*
   * than either of the others: ~7 m from 13 m/s. Half of that is the horse
   * checking, half is a screw brake on the rear tyres.
   */
  maxForce: 15000,
  /** the drag shoe works the REAR wheels — this is a rear-braked vehicle */
  frontBias: 0.3,
  /** the rear brake locks the big wheels outright; that is the skid */
  handbrakeForce: 9000,
  reverseThreshold: 0.7,
  /** a beat of "whoa, back" before it actually backs */
  reverseDelay: 0.35,
} as const;

/* ----------------------------------------------------------------- steering */

export const CARRIAGE_STEER = {
  /**
   * ≈41° of lock. A carriage front axle is a turntable and the wheels are small
   * precisely so they can swing right under the body: on a 1.40 m wheelbase
   * that is a 1.6 m steered radius and a ~3.6 m turning circle for the body
   * origin, against the Jeep's ~9 m. This one number is the vehicle.
   */
  maxAngleLow: 0.72,
  /** ≈16° at speed — still far more than either of the others keeps */
  maxAngleHigh: 0.28,
  /** and "speed" for a carriage is 12 m/s, so it keeps most of its lock */
  speedForMinAngle: 12.5,
  speedCurvePower: 1.3,

  /** the axle swings quickly and comes back quickly — it is light */
  rateToCentre: 6.4,
  rateAwayFromCentre: 4.6,
  returnRateBonus: 2.2,

  driftExtraAngle: 0.16,

  counterSteerGain: 0.45,
  counterSteerMinSlip: 0.13,
  counterSteerMinSpeed: 4,

  /**
   * The yaw assist is what makes a 5.5 m rig feel like a go-kart. The *rate*
   * ceiling is the highest in the game because the geometry genuinely supports
   * it, and the speed floor is the lowest (1.2 m/s) because the carriage does
   * most of its interesting work at walking pace, threading things.
   */
  yawAssistRate: 6.5,
  yawAssistMaxAccel: 7.0,
  yawAssistMinSpeed: 1.2,
  yawAssistRampBand: 4.5,
  yawAssistDriftGain: 1.4,

  maxYawRate: 2.6,
} as const;

/* --------------------------------------------------------------------- tyre */

export const CARRIAGE_TYRE = {
  /**
   * Iron-shod wooden wheels. Grip is *low* in absolute terms and the vehicle is
   * still glued to the road, because grip only has to beat the forces a 13 m/s
   * vehicle can generate. What low µ buys is the skid: lock the rear wheels and
   * they go, every time, at any speed.
   */
  latGripFront: 1.55,
  latGripRear: 1.35,

  /** a narrow, sharp curve — an iron tyre grips or it doesn't */
  peakSlip: 0.16,
  tailSlip: 0.62,
  tailGrip: 0.6,

  longGrip: 1.5,

  combinedSlip: 0.7,

  minLoad: 600,
  maxLoad: 22000,

  loadSensitivity: 0.18,
  /** static corner load, N */
  loadReference: 6325,

  latDeadband: 0.04,
  /** thin iron tyres bite fast when they bite at all */
  latRecoveryFraction: 0.88,

  slipNormalise: 7,

  /**
   * Lateral force goes in 0.40 m above the contact patch, which puts the roll
   * centre 0.45 m below a low centre of mass. Rollover would need ~90 m/s² and
   * the tyres can only ever make ~30, so the carriage heels right over onto its
   * springs and physically cannot fall down. It needs that margin: 1.32 m of
   * rear track is the narrowest vehicle in the game.
   */
  lateralForceHeight: 0.4,

  slipSpeedGain: 9,
} as const;

/* -------------------------------------------------------------------- drift *
 * A carriage cannot drift. A carriage on wet adoquín with the rear wheels     *
 * locked absolutely can, and it is glorious — but it is a *skid*: you commit   *
 * with the brake, the tail steps out, and it hooks back up the moment you      *
 * release. Entry without the handbrake is deliberately almost impossible       *
 * (`entrySlip` 0.5 rad, `entrySteer` 0.9) and `spinOutSlip` is low, so it      *
 * never becomes a Jeep-style sustained drift.                                  */

export const CARRIAGE_DRIFT = {
  /** you can skid a carriage at jogging pace, which nothing else can do */
  minSpeed: 4.5,
  handbrakeThreshold: 0.32,
  entrySlip: 0.5,
  entrySteer: 0.9,

  exitSlip: 0.14,
  /** snappy exits: let go and it hooks up immediately */
  exitHold: 0.16,
  exitAirtime: 0.7,

  /** locked iron on wet stone — the rears simply let go */
  handbrakeRearGrip: 0.2,
  driftRearGrip: 0.62,
  driftFrontGrip: 0.98,
  /** the fastest weight transfer in the game; it is a very light vehicle */
  gripBlendRate: 15,

  liftOffGripRecovery: 1.3,

  /** past 65° it is not a skid any more, it is a spin, and it cancels */
  spinOutSlip: 1.15,

  chargePerSecond: 0.8,
  chargeSlipReference: 0.55,
  tierCharge: [0.4, 0.95, 1.7] as readonly number[],
  tierBoostSeconds: [0.5, 1.0, 1.7] as readonly number[],
  /** N·s — on 1 150 kg these are worth +2.4, +4.3 and +6.5 m/s */
  tierImpulse: [2800, 5000, 7500] as readonly number[],
  tierMeterRefill: [0.12, 0.24, 0.4] as readonly number[],

  pointsPerSecond: 260,
  pointsPerAngleIntegral: 420,
  minScoringDuration: 0.3,
} as const;

/* -------------------------------------------------------------------- boost *
 * The gallop.                                                                 */

export const CARRIAGE_BOOST = {
  /** a horse cannot hold a gallop; the meter empties faster than anyone's */
  drainPerSecond: 0.5,
  minToStart: 0.08,
  minToHold: 0.0,

  /**
   * 7 500 N is 6.5 m/s² on 1 150 kg. The drivetrain makes about 1 m/s² at
   * 10 m/s, so asking for the gallop very nearly *doubles* the vehicle — the
   * single biggest proportional boost in the roster. It ramps in over a fifth
   * of a second (the horse gathering) and hangs on afterwards.
   */
  thrust: 7500,
  /** almost nothing in the air: hooves need ground */
  thrustAirScale: 0.2,
  rampInTime: 0.2,
  rampOutTime: 0.28,

  minDuration: 0.3,

  /**
   * THE gameplay hook. Three times the Jeep's near-miss payout, on a near-miss
   * trigger that arms at 4.5 m/s instead of 13. The carriage is paid for
   * threading crowds, market stalls, plaza furniture and alley mouths at a
   * trot — for going where nothing else fits — and it spends that on the
   * gallop. Drive it like a delivery van and the meter stays empty.
   */
  gainNearMiss: 0.16,
  gainAirtimePerSecond: 0.1,
  gainCleanLandingPerSecond: 0.08,
  gainPerDriftRadSecond: 0.1,
  gainDriftMax: 0.4,

  /** and it always has *something*: the horse recovers its wind at a trot */
  trickleRegen: 0.03,
  trickleSpeed: 5.5,

  glowRate: 8,
} as const;

/* ---------------------------------------------------------------------- air *
 * It jumps — off stair heads, plaza thresholds and the odd ramp — but it is a *
 * carriage, so it flies like a shed and lands flat because the alternative is *
 * not entertaining.                                                            */

export const CARRIAGE_AIR = {
  minAirtimeForJump: 0.12,

  pitchAccel: 3.4,
  rollAccel: 4.0,
  yawAccel: 1.4,

  maxPitchRate: 2.6,
  maxRollRate: 3.0,
  maxYawRate: 2.0,

  angularDamping: 1.2,
  idleAxisDamping: 3.0,

  /** the strongest auto-level in the game, for the obvious reason */
  autoLevelStrength: 10.0,
  autoLevelRampTime: 0.18,
  autoLevelInputDeadzone: 0.15,
  autoLevelMaxAccel: 18,
  autoLevelDamping: 3.4,
  autoLevelDescentBoost: 1.6,
  autoLevelDescentSpeed: 12,

  cleanLandingAngle: 0.72,

  /** an airborne carriage is absurd and scores accordingly */
  pointsPerSecond: 170,
  pointsPerMetre: 80,
  cleanLandingBonus: 1.9,
  minScoringAirtime: 0.28,

  trickFullTurn: Math.PI * 2,
  barrelRollPoints: 2200,
  flipPoints: 3000,
  spinPoints: 1300,
  trickChainMultiplier: 1.7,
} as const;

/* -------------------------------------------------------------- two wheeler */

export const CARRIAGE_TWO_WHEELS = {
  /** ≈17°; it heels this far routinely, so the bar sits above the sway */
  minRoll: 0.3,
  minDuration: 0.35,
  graceTime: 0.18,
  /** and at carriage speeds, 4 m/s counts */
  minSpeed: 4,
} as const;

/* -------------------------------------------------------------- near misses */

export const CARRIAGE_NEAR_MISS = {
  /** 20 Hz: at walking pace things enter and leave the sphere slowly */
  interval: 1 / 20,
  /** a narrow vehicle sweeps a narrow volume of "that was close" */
  radius: 3.0,
  /** the low bar that makes threading a crowd pay — see CARRIAGE_BOOST */
  minSpeed: 4.5,
  cooldown: 1.6,
  collisionLockout: 2.6,
} as const;

/* ---------------------------------------------------------------- collision */

export const CARRIAGE_COLLISION = {
  /** light and springy: it notices everything it touches */
  minImpulse: 600,
  cooldown: 0.09,
  /** and the horse shies at anything past this — see CarriageModel.reactToImpact */
  heavyImpulse: 6000,
} as const;

/* --------------------------------------------------------- anti-frustration */

export const CARRIAGE_RECOVERY = {
  flippedDot: 0.34,
  /** picked up fastest of the three; an upended carriage is not a joke */
  flippedTime: 1.1,
  stuckSpeed: 2.0,
  rightingLift: 1.0,

  safePointInterval: 0.7,
  safePointWheels: 3,
  safePointMinSpeed: 1.2,

  respawnHeight: 0.7,
  respawnSettleTime: 0.25,

  // light and short — a gentler nudge is plenty to clear a step
  stuckClimbSpeed: 1.5,
  stuckClimbDelay: 0.28,
  stuckClimbRamp: 0.5,
  stuckClimbUpAccel: 28,
  stuckClimbForwardAccel: 14,
} as const;

/* ---------------------------------------------------------- cosmetic motion */

export const CARRIAGE_MODEL_FEEL: ModelFeel = {
  /**
   * The biggest pitch gain in the game. A carriage body hangs off leaf springs
   * with nothing damping it: it rocks fore and aft over every stone, dives on
   * the brake and sits back the instant the horse leans into the collar.
   */
  bodyPitchGain: 0.62,
  /** and it sways — the canopy leans a beat after the body does */
  bodyRollGain: 0.7,
  bodyBounceGain: 0.15,
  /** slow enough that the body is always a moment behind the wheels */
  bodyLeanRate: 9,
  bodyLeanMax: 0.24,

  /** the carriage lamps are lit earlier than headlights — they are lamps */
  headlightOnBefore: 7.1,
  headlightOnAfter: 17.9,
};

/* -------------------------------------------------------------- wheel layout */

export const CARRIAGE_WHEEL_LAYOUT: readonly WheelPlacement[] = [
  { x: -CARRIAGE_SUSPENSION.halfTrackFront, z: 0.9, front: true, left: true },
  { x: CARRIAGE_SUSPENSION.halfTrackFront, z: 0.9, front: true, left: false },
  { x: -CARRIAGE_SUSPENSION.halfTrackRear, z: 2.3, front: false, left: true },
  { x: CARRIAGE_SUSPENSION.halfTrackRear, z: 2.3, front: false, left: false },
];

/* ----------------------------------------------------------------- terrain */

/**
 * A horse and a wooden cart. Iron-shod wheels on sand genuinely bog down, so
 * the surface term is dialled *up*, not down — but the horse simply steps onto
 * a kerb, so there is no launch assist at all.
 */
export const CARRIAGE_TERRAIN: TerrainTuning = {
  surfaceSensitivity: 1.05,
  surfaceDragForce: 1100,
  kerbStep: 0.06,
  kerbMinSpeed: 99,
  kerbKick: 0,
  kerbKickMax: 0,
  kerbCooldown: 1,
};

/* ============================================================== the bundle */

export const CARRIAGE_TUNING: VehicleTuningSet = {
  chassis: CARRIAGE_CHASSIS,
  suspension: CARRIAGE_SUSPENSION,
  wheels: CARRIAGE_WHEEL_LAYOUT,
  engine: CARRIAGE_ENGINE,
  speed: CARRIAGE_SPEED,
  brake: CARRIAGE_BRAKE,
  steer: CARRIAGE_STEER,
  tyre: CARRIAGE_TYRE,
  terrain: CARRIAGE_TERRAIN,
  drift: CARRIAGE_DRIFT,
  boost: CARRIAGE_BOOST,
  air: CARRIAGE_AIR,
  twoWheels: CARRIAGE_TWO_WHEELS,
  nearMiss: CARRIAGE_NEAR_MISS,
  collision: CARRIAGE_COLLISION,
  recovery: CARRIAGE_RECOVERY,
  model: CARRIAGE_MODEL_FEEL,
  /**
   * There is no horn. There is a brass harness bell on the hames and a driver
   * who calls out, which is the same two-reed sample two octaves up and short.
   * `CarriageModel.pulseHorn` throws the horse's head up with it.
   */
  horn: { pitch: 2.35, volume: 0.6, cooldown: 0.4 },
  /**
   * There is no air system either. What there is, is a horse that blows out
   * hard through its nose the moment it is pulled up — and the sfx library's
   * filtered-noise burst, dropped low and made breathy, is exactly that sound.
   * `CarriageModel.pulseAirBrake` flares the nostrils and shakes the head.
   */
  airBrake: {
    enabled: true,
    pitch: 0.52,
    volume: 0.5,
    brakeThreshold: 0.4,
    chargeToFire: 0.22,
    decayRate: 1.4,
    stopSpeed: 1.6,
    cooldown: 1.15,
  },
  colliderOffsetY: CARRIAGE_CHASSIS.colliderOffsetY,
};

/* ========================================================================== */
/*                          geometry + livery constants                       */
/* ========================================================================== */

/**
 * Static spring sag, metres. Kept as a literal so the mesh's ground plane and
 * the simulation's ride height can never drift apart:
 *   6 325 N / ((40 000 + 44 000)/2) = 0.150595 m
 */
const CARRIAGE_STATIC_SAG = 0.150595;

/**
 * Everything the procedural carriage is built from. Local space, body origin at
 * the centre of the whole rig, -Z forward.
 *
 * Heights are given as `h*` = metres above the road, and the model converts
 * with `Y(h) = groundLocalY + h`; that way every number below can be read
 * against a photograph instead of against a spring datum.
 */
export const CARRIAGE_GEO = {
  /** where the tyres touch at static ride height — the model's "road" */
  groundLocalY: -(
    CARRIAGE_SUSPENSION.wheelRadius +
    (CARRIAGE_SUSPENSION.restLength - CARRIAGE_STATIC_SAG) -
    CARRIAGE_SUSPENSION.anchorY
  ),
  /** static compression the springs settle at, 0..1 — the mesh rest pose */
  staticCompression: CARRIAGE_STATIC_SAG / CARRIAGE_SUSPENSION.restLength,

  /* --- wheels ---------------------------------------------------------- */
  /** rear wheel: 1.10 m across, 14 slender spokes */
  rearRadius: 0.55,
  rearSpokes: 14,
  /** front wheel: 0.75 m across, 12 spokes, so it swings under the body */
  frontRadius: 0.375,
  frontSpokes: 12,
  /** how much lower the small front hub sits than the strut's nominal centre */
  frontHubDrop: 0.55 - 0.375,
  /** the front wheel turns 1.467× as fast for the same road speed */
  frontSpinRatio: 0.55 / 0.375,
  /** black iron tyre thickness on the felloe */
  tyreThickness: 0.032,
  /** wooden felloe (rim) depth */
  felloeDepth: 0.052,
  /** spoke radius at the hub, tapering to `spokeTipR` at the felloe */
  spokeRootR: 0.0165,
  spokeTipR: 0.0105,
  /** the wheel is dished: the felloe stands this far outboard of the nave */
  wheelDish: 0.022,
  /** alternate spokes are staggered this far either side in the nave */
  spokeStagger: 0.012,
  hubRadius: 0.078,
  hubLength: 0.17,

  /* --- longitudinal landmarks, local Z (negative = forward) ------------- */
  /** the horse's muzzle, and the front face of the collider */
  zNose: -2.72,
  /** where the shafts end, at the horse's shoulder */
  zShaftTip: -1.78,
  /** the horse rig's origin — ground under the middle of the barrel */
  zHorse: -1.15,
  /** swingletree, where the traces pull on the carriage */
  zSwingletree: 0.5,
  /** splash board / dash at the front of the body */
  zDash: 0.55,
  zFrontAxle: 0.9,
  /** the driver's box */
  zBox: 1.05,
  /** front canopy posts */
  zCanopyFront: 1.72,
  /** passenger bench cushion */
  zBench: 2.06,
  /** rear canopy posts */
  zCanopyRear: 2.52,
  zRearAxle: 2.3,
  /** the back panel of the body */
  zBodyRear: 2.68,
  /** the folded hood, stacked behind the bench */
  zHood: 2.6,

  /* --- heights above the road ------------------------------------------ */
  /** underside of the body shell at its lowest, over the front axle */
  hBodyFloor: 0.79,
  /** top rail / capping moulding of the body sides */
  hBodyRail: 1.3,
  /** the swooping lower edge of the body at the rear quarter */
  hBodyKeel: 0.62,
  /** passenger bench cushion */
  hBench: 1.0,
  /** top of the passenger backrest */
  hBenchBack: 1.5,
  /** driver's box cushion — a coachman sits high */
  hBox: 1.28,
  hBoxBack: 1.62,
  /** underside of the canopy */
  hCanopy: 2.02,
  /** crown of the canopy's slight dome */
  hCanopyCrown: 2.12,
  /** the folded hood's top bow */
  hHood: 1.76,
  /** the brass lamps, either side of the box */
  hLamp: 1.4,
  /** the mounting step */
  hStep: 0.44,
  /** the shafts where they pass the horse's shoulder */
  hShaftTip: 0.82,
  /** the shafts where they meet the front axle */
  hShaftRoot: 0.6,

  /* --- widths ---------------------------------------------------------- */
  /** half width of the body shell at its widest */
  halfBody: 0.6,
  /** half width at the dash — the body tapers forward */
  halfBodyFront: 0.5,
  /** canopy posts */
  halfPost: 0.6,
  halfCanopy: 0.74,
  /** the shafts either side of the horse */
  halfShaft: 0.28,

  /* --- emissive intensities -------------------------------------------- */
  lampIntensityOn: 2.4,
  lampIntensityOff: 0.05,
  rearLampOn: 2.8,
  rearLampOff: 0.25,

  /* --- idle life -------------------------------------------------------- */
  /** how far the whole body shivers at a standstill, metres */
  idleShiver: 0.0018,
} as const;

/**
 * The livery. Black lacquer, chrome yellow, brass and cream — the exact palette
 * a working coche has carried for a hundred and fifty years, with the canopy in
 * the blue-and-white the trade still uses.
 */
export const CARRIAGE_PAINT = {
  /** black lacquer: near-black with a little blue in it, and very glossy */
  lacquer: 0x0d0e14,
  /** the highlight coat on the mouldings */
  lacquerLit: 0x1b1d26,
  /** chrome yellow — wheels, undercarriage, shafts, coach lines */
  yellow: 0xf0ad12,
  /** the darker yellow in the wheel's shadow side and the spring leaves */
  yellowDeep: 0xc98a08,
  /** polished brass: lamps, hames, buckles, axle caps */
  brass: 0xc8992f,
  brassDark: 0x8a6a1c,
  /** black patent leather: hood, dash, harness */
  leather: 0x1a1a20,
  leatherLit: 0x2a2a33,
  /** cream buttoned upholstery */
  cushion: 0xece2c8,
  cushionShadow: 0xd3c6a6,
  /** the striped canopy */
  canopyBlue: 0x2c5ea8,
  canopyWhite: 0xf5f2e8,
  /** iron tyre and hardware */
  iron: 0x15161c,
  steel: 0x8d97a3,
  /** the lamp flame */
  lamp: 0xffe4a8,
  /** the red rear lens on the lamps */
  lampRear: 0xd8232a,
} as const;

/**
 * The horse. A **Paso Fino** — the Puerto Rican breed, and the right animal for
 * this job: compact, deep-chested, short-backed, famously smooth-gaited and
 * about 1.45 m at the withers, which is a hand and a half shorter than a
 * European carriage horse and reads instantly as *from here*.
 *
 * Coat is dapple grey going white, which is what an older grey greys into.
 *
 * All dimensions are in the rig's own space: origin on the road under the
 * middle of the barrel, +Y up, -Z forward, +X right.
 */
export const HORSE_GEO = {
  /** withers height — the standard measurement of a horse */
  withers: 1.45,
  /** croup (top of the hindquarters) — a hair lower, as it should be */
  croup: 1.42,

  /** the barrel: front of the chest to the back of the rump */
  zChest: -0.75,
  zRump: 0.7,
  /** half width of the barrel at its deepest */
  halfBarrel: 0.26,
  /** the underline — how far the belly hangs */
  hBelly: 0.72,
  /** the topline at the withers and at the loins */
  hWithers: 1.45,
  hLoin: 1.36,

  /**
   * The body rotates about a point inside the barrel, not about the road. A
   * degree of stride pitch applied at ground level swings the whole animal two
   * centimetres fore and aft, which reads as the horse sliding on ice.
   */
  pitchPivotY: 1.05,
  pitchPivotZ: -0.05,

  /* --- forelimb ---------------------------------------------------------
   * THE CONSTRAINT THAT SIZES EVERY GAIT: a limb of length L pivoting at
   * height H can only reach ±√(L² − H²) along the ground, so the stride
   * excursion (stride · duty / 2) is hard-capped by the leg geometry. Get this
   * wrong and the hooves either hover or the IK clamps and they skate.
   *
   * Fore: pivot 1.22, chain 1.36  →  ground reach ±0.601
   * Hind: pivot 1.06, chain 1.30  →  ground reach ±0.717
   *
   * The pivot is the top of the scapula rather than the shoulder joint, which
   * is both where a horse's forelimb actually swings from and the only way to
   * get the reach a trot needs.
   */
  forePivotX: 0.19,
  forePivotY: 1.22,
  forePivotZ: -0.55,
  /** scapula + humerus: pivot → elbow */
  foreUpper: 0.54,
  /** forearm: elbow → knee (carpus) */
  foreLower: 0.38,
  /** knee → hoof: cannon, fetlock and pastern as one rigid piece */
  foreCannon: 0.44,
  /** how closely the cannon follows the pivot→hoof line; <1 keeps it upright */
  foreCannonFollow: 0.75,
  /** the elbow trails backward, so the knee can only break forward */
  foreKneeLead: 0.06,
  /** where the forefoot sits at mid-stance, just behind the pivot */
  foreNeutralZ: -0.56,

  /* --- hind limb -------------------------------------------------------- */
  hipX: 0.21,
  hipY: 1.06,
  hipZ: 0.52,
  /** femur: hip → stifle */
  hindUpper: 0.36,
  /** tibia: stifle → hock */
  hindLower: 0.44,
  /** hock → hoof */
  hindCannon: 0.5,
  hindCannonFollow: 0.5,
  /**
   * How far behind the vertical the hock is carried, radians. This single
   * number is the horse's iconic zigzag hind leg; get it wrong and the animal
   * reads as a dog. At rest it puts the hock 0.32 m behind the hip and the
   * stifle at (0.70, 0.48), which is a horse.
   */
  hindHockRake: 0.5,
  hindNeutralZ: 0.62,

  /* --- neck and head ---------------------------------------------------- */
  /** base of the neck, on the withers */
  neckBaseY: 1.32,
  neckBaseZ: -0.6,
  /** lower neck segment length, and upper */
  neckLower: 0.34,
  neckUpper: 0.3,
  /** the head, poll to muzzle */
  headLength: 0.44,
  /** neutral neck angles: lower segment up-and-forward, upper more forward */
  neckPitchLow: -0.62,
  neckPitchHigh: -0.38,
  /** neutral head angle relative to the neck — a horse in harness flexes */
  headPitch: 0.78,

  /* --- tail ------------------------------------------------------------- */
  tailRootY: 1.33,
  tailRootZ: 0.66,
  tailSegments: 4,
  tailSegLength: 0.16,
  /** how far the dock droops at rest, radians per segment */
  tailDroop: 0.44,

  /* --- hooves and detail ------------------------------------------------ */
  hoofRadius: 0.062,
  hoofHeight: 0.075,
  hoofColor: 0x3a3238,
  earLength: 0.11,

  /* --- coat ------------------------------------------------------------- */
  /** dapple grey: a light body with darker dapples and dark points */
  coat: 0xd8d6d2,
  coatShade: 0xa9a8a8,
  /** knees down, muzzle and ear tips go dark on a grey */
  points: 0x565660,
  /** mane and tail on a grey are near-white */
  hair: 0xf0eee9,
  hairShade: 0xcfccc5,
  /** the pink-grey of a grey horse's muzzle */
  muzzle: 0x6a5f60,
  eye: 0x14100f,
  /** black harness leather and brass furniture */
  harness: 0x141419,
  harnessBrass: 0xc8992f,
  /** the collar's padded roll */
  collar: 0x2a2118,
} as const;

/* -------------------------------------------------------------------- gaits */

/** One gait, fully described. `HorseRig` blends between adjacent entries. */
export interface Gait {
  readonly name: string;
  /** metres of ground covered per complete stride cycle */
  readonly stride: number;
  /** fraction of the cycle each hoof spends planted, 0..1 */
  readonly duty: number;
  /**
   * Phase offset of each leg within the cycle, in the order
   * [fore-left, fore-right, hind-left, hind-right].
   */
  readonly offsets: readonly [number, number, number, number];
  /** peak hoof lift during the swing, metres */
  readonly lift: number;
  /** how far the hoof folds up under the horse during swing, radians */
  readonly fold: number;
  /** vertical body travel, metres, and how many times per stride it happens */
  readonly bobAmp: number;
  readonly bobHarmonic: 1 | 2;
  readonly bobPhase: number;
  /** body pitch amplitude over the stride, radians */
  readonly pitchAmp: number;
  /** lateral body sway, metres, at one per stride */
  readonly swayAmp: number;
  /** head nod amplitude, radians, at one per stride */
  readonly nodAmp: number;
  /** how far forward and down the head is carried in this gait, radians */
  readonly headReach: number;
  /** tail sway amplitude, radians */
  readonly tailAmp: number;
  /** how far the tail streams out behind, radians */
  readonly tailLift: number;
}

/**
 * The four gaits, in speed order. The phase offsets are the real footfall
 * sequences, not decoration:
 *
 *  - **walk** — four beats, lateral sequence: left hind, left fore, right hind,
 *    right fore. Two or three feet down at all times, duty 0.62.
 *  - **trot** — two beats, *diagonal* pairs: left fore with right hind, right
 *    fore with left hind, with a moment of suspension between.
 *  - **canter** — three beats on the right lead: left hind, then the diagonal
 *    pair (right hind + left fore), then the leading right fore, then air.
 *  - **gallop** — four beats, the canter's diagonal pair split apart, and the
 *    duty down to 0.21 so the horse spends most of the cycle airborne. This is
 *    what the boost buys.
 *
 * `stride × duty / 2` is the hoof's ground excursion, and it is NOT free: the
 * forelimb can only reach ±0.601 m (see HORSE_GEO). Every entry below is sized
 * against that ceiling, which is why the fast gaits buy their longer strides
 * with a lower duty rather than with a bigger swing:
 *
 *     walk   1.58 × 0.62 → ±0.490    0.95 Hz at 1.5 m/s
 *     trot   2.70 × 0.35 → ±0.473    1.85 Hz at 5 m/s
 *     canter 4.20 × 0.28 → ±0.588    2.14 Hz at 9 m/s
 *     gallop 5.60 × 0.21 → ±0.588    2.68 Hz at 15 m/s
 *
 * The bob amplitudes are capped for the same reason: a body rising at the
 * moment a hoof is fully extended steals the reach that hoof needs, and the
 * leg straightens and skates. That is the failure this table exists to avoid.
 */
export const GAITS: readonly Gait[] = [
  {
    name: 'walk',
    stride: 1.58,
    duty: 0.62,
    offsets: [0.25, 0.75, 0.0, 0.5],
    lift: 0.09,
    fold: 0.5,
    bobAmp: 0.012,
    bobHarmonic: 2,
    bobPhase: 0.1,
    pitchAmp: 0.008,
    swayAmp: 0.022,
    nodAmp: 0.1,
    headReach: 0.0,
    tailAmp: 0.06,
    tailLift: 0.0,
  },
  {
    name: 'trot',
    stride: 2.7,
    duty: 0.35,
    offsets: [0.0, 0.5, 0.5, 0.0],
    lift: 0.17,
    fold: 0.85,
    bobAmp: 0.05,
    bobHarmonic: 2,
    bobPhase: 0.25,
    pitchAmp: 0.012,
    swayAmp: 0.008,
    nodAmp: 0.03,
    headReach: 0.06,
    tailAmp: 0.09,
    tailLift: 0.12,
  },
  {
    name: 'canter',
    stride: 4.2,
    duty: 0.28,
    offsets: [0.34, 0.67, 0.0, 0.34],
    lift: 0.24,
    fold: 1.15,
    bobAmp: 0.07,
    bobHarmonic: 1,
    bobPhase: 0.42,
    pitchAmp: 0.055,
    swayAmp: 0.02,
    nodAmp: 0.14,
    headReach: 0.16,
    tailAmp: 0.14,
    tailLift: 0.3,
  },
  {
    name: 'gallop',
    stride: 5.6,
    duty: 0.21,
    offsets: [0.52, 0.7, 0.0, 0.2],
    lift: 0.3,
    fold: 1.35,
    bobAmp: 0.085,
    bobHarmonic: 1,
    bobPhase: 0.46,
    pitchAmp: 0.085,
    swayAmp: 0.012,
    nodAmp: 0.2,
    headReach: 0.34,
    tailAmp: 0.1,
    tailLift: 0.5,
  },
];

/**
 * Where each gait takes over, m/s. The rig walks a continuous 0..3 "gait axis"
 * through these bands and blends the two entries either side of it, so there is
 * never a pop — and because the stride *phase* is driven by measured ground
 * distance rather than a clock, the planted hoof stays planted right through a
 * transition.
 */
export const GAIT_BANDS = {
  /** walk → trot */
  trotFrom: 1.6,
  trotTo: 3.3,
  /** trot → canter */
  canterFrom: 5.6,
  canterTo: 8.0,
  /** canter → gallop, on speed alone */
  gallopFrom: 11.0,
  gallopTo: 14.5,
  /**
   * ... and on the boost, which drags the axis straight to a gallop — but only
   * once the horse is moving. You cannot gallop out of a standstill.
   */
  boostGallopMinSpeed: 2.5,
  boostGallopFullSpeed: 6.0,
} as const;
