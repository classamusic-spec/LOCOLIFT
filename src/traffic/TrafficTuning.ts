/**
 * Loco Lift — traffic, scooter and pedestrian tuning.
 *
 * Every magic number the street-life systems use lives here, named and
 * commented. Nothing in `src/traffic/**` may hard-code a feel constant.
 *
 * Units: metres, seconds, radians, m/s. Colours are 0xRRGGBB.
 *
 * Design brief this tuning serves (ART_REFERENCE §7.2):
 *  - ordinary modern Caribbean-US traffic, moving *slowly* relative to the
 *    player so the Jeep can weave through it (Crazy Taxi, not a traffic sim);
 *  - scooters that split lanes and take the callejones;
 *  - pedestrians who own the pavement, cross at corners, gather in the plazas
 *    — and who are physically incapable of being run over.
 */

/* ========================================================== agent profiles */

/**
 * Longitudinal behaviour of one class of road agent. Cars are timid, scooters
 * are not. `desiredSpeed` is scaled per-agent by `speedSpread` at spawn so a
 * queue is never uniform.
 */
export interface AgentProfileTuning {
  /** free-flow target speed on a normal street, m/s */
  desiredSpeed: number;
  /** ± fraction applied per agent at spawn (0.18 = ±18 %) */
  speedSpread: number;
  /** comfortable acceleration, m/s² */
  accel: number;
  /** comfortable deceleration, m/s² (IDM `b`) */
  brake: number;
  /** panic deceleration when something is genuinely in the way, m/s² */
  emergencyBrake: number;
  /** desired time headway to the leader, s */
  headway: number;
  /** bumper-to-bumper gap at a standstill, m */
  jamGap: number;
  /** how far the agent may slide sideways inside its lane, m */
  maxSwerve: number;
  /** lateral swerve rate, m/s */
  swerveRate: number;
  /** speed scale on a corner of 1/r curvature ~ 0.1 (tight) */
  cornerCaution: number;
}

/** Ordinary four-wheeled traffic. Deliberately slower than the player. */
export const CAR_PROFILE: AgentProfileTuning = {
  desiredSpeed: 9.5,
  speedSpread: 0.2,
  accel: 3.2,
  brake: 4.2,
  emergencyBrake: 11.0,
  headway: 1.15,
  jamGap: 2.1,
  maxSwerve: 0.85,
  swerveRate: 2.4,
  cornerCaution: 0.55,
};

/** Scooters: quicker, tighter, happy to sit in the gap between two cars. */
export const SCOOTER_PROFILE: AgentProfileTuning = {
  desiredSpeed: 13.0,
  speedSpread: 0.22,
  accel: 5.0,
  brake: 6.0,
  emergencyBrake: 13.0,
  headway: 0.72,
  jamGap: 1.1,
  maxSwerve: 1.35,
  swerveRate: 4.2,
  cornerCaution: 0.72,
};

/* ============================================================ road following */

export const ROAD = {
  /**
   * Lane centre = (laneIndex + 0.5) * (edge.width / edge.lanes), measured from
   * the centreline on the travel side. Clamped so a body never overhangs the
   * kerb by more than `kerbMargin`.
   */
  kerbMargin: 0.25,
  /** minimum usable lane half-width; below this the street is treated as 1-lane */
  minLaneCentre: 1.25,
  /**
   * Lane offset is faded toward the centreline near a node so turns read as
   * turns rather than as a lateral snap. 1 = full offset, 0.7 = 30 % pulled in.
   */
  laneFadeAtNode: 0.72,
  /** distance from a node over which the fade runs, m */
  laneFadeLength: 7.0,
  /**
   * The rendered transform chases the exact graph position through this
   * critically-damped filter, which is what actually rounds off the corners.
   * Higher = tighter to the graph, lower = wider, lazier arcs.
   */
  followRate: 7.5,
  /** above this positional error the filter snaps (spawn / recycle / teleport) */
  snapDistance: 5.0,
  /** heading smoothing rate, rad-space exponential */
  headingRate: 8.5,
  /** below this speed the heading is held rather than derived from motion */
  headingMinSpeed: 0.35,
  /** visual body roll into a corner, rad per (rad/s of yaw rate) */
  bodyRoll: 0.09,
  /** visual pitch under braking/accel, rad per m/s² */
  bodyPitch: 0.012,
  /** how fast body roll/pitch chase their target */
  bodyRate: 6.0,
  /** ride height fudge so wheels sit on the cobbles, m */
  rideLift: 0.02,
} as const;

/* ============================================================ intersections */

export const INTERSECTION = {
  /** an agent starts asking for permission this far from the node, m */
  claimDistance: 13.0,
  /** it stops this far short of the node centre when refused, m */
  stopLineOffset: 5.4,
  /** the claim is released once the agent is this far past the node, m */
  clearDistance: 6.5,
  /** hard expiry on a claim so a wedged agent can never gridlock a junction, s */
  claimTimeout: 4.5,
  /** concurrent non-conflicting movements allowed through one node */
  maxClaims: 4,
  /**
   * Lateral offset of the entry/exit point on the junction circle, expressed
   * as an angle. Sets how "right-hand-drive" the conflict chords are — larger
   * values make opposing straight-throughs more obviously independent.
   */
  chordOffsetRad: 0.22,
  /**
   * Don't enter the box unless there is at least this much room on the exit
   * edge. This is the "no bloqueé la intersección" rule and it is the single
   * thing that stops city-wide gridlock.
   */
  exitClearance: 7.0,
  /** speed cap while inside the junction, m/s */
  crossSpeed: 7.0,
  /** speed cap for a turn tighter than 60°, m/s */
  turnSpeed: 5.0,
} as const;

export const SIGNAL = {
  /** nodes with at least this many drivable edges get a light; the rest yield */
  minDegree: 4,
  /** green per axis, s */
  green: 7.0,
  /** amber per axis, s */
  amber: 1.6,
  /** all-red safety gap, s */
  allRed: 0.7,
  /** `RoadNode.signalOffset` (0..8 s) is multiplied by this to spread phases */
  offsetScale: 1.9,
  /** an agent already inside the amber window this close to the line runs it, m */
  amberRunDistance: 9.0,
} as const;

/** Full cycle length, derived. Both axes get one green + amber + all-red. */
export const SIGNAL_CYCLE = 2 * (SIGNAL.green + SIGNAL.amber + SIGNAL.allRed);

/* =========================================================== routing weights */

export const ROUTE = {
  /** relative weight of continuing roughly straight through a node */
  straight: 1.0,
  /** weight of a left/right turn */
  turn: 0.42,
  /** weight of a U-turn — only really used at dead ends */
  uTurn: 0.015,
  /** angle under which a movement counts as "straight", rad */
  straightAngle: 0.62,
  /** cars avoid the seafront boulevard slightly less than the back streets */
  coastalBonus: 1.25,
  /** plazas are open squares — traffic crosses them but doesn't seek them out */
  plazaPenalty: 0.6,
} as const;

/* ======================================================= player interaction */

export const PLAYER_REACT = {
  /** nothing reacts to the player beyond this, m */
  noticeRadius: 26.0,
  /** full-strength reaction inside this, m */
  alarmRadius: 11.0,
  /** the player must be closing faster than this for traffic to care, m/s */
  minClosingSpeed: 4.0,
  /** lateral shove applied away from the player, m (added to swerve) */
  swerveStrength: 1.05,
  /** fraction of desired speed retained during an evasive brake */
  brakeFactor: 0.35,
  /** seconds a vehicle keeps reacting after the player has gone */
  memory: 1.1,
  /** minimum seconds between two honks from the same vehicle */
  hornCooldown: 3.2,
  /** minimum seconds between honks anywhere (keeps the mix clean) */
  hornGlobalCooldown: 0.55,
  /** player must be at least this fast for a honk to trigger, m/s */
  hornMinPlayerSpeed: 9.0,
  /** chance a given close pass produces a honk at all */
  hornChance: 0.55,
  /** brake lights stay lit this long after a scare, s */
  brakeFlash: 0.9,
} as const;

/** Arcade "shunt": what a kinematic traffic car does when the Jeep hits it. */
export const SHUNT = {
  /** the player must be this fast for a hit to shove the car, m/s */
  minSpeed: 7.0,
  /** contact test radius padding on top of the two half-lengths, m */
  contactPad: 0.35,
  /** shove speed as a fraction of the player's closing speed */
  transfer: 0.55,
  /** maximum shove speed, m/s */
  maxSpeed: 13.0,
  /** yaw spin imparted, rad/s per m/s of shove */
  spin: 0.22,
  /** how long the car stays off the rails, s */
  duration: 1.35,
  /** linear drag while shunted, 1/s */
  drag: 2.4,
  /** how hard the car is pulled back onto its lane once the timer expires */
  recoverRate: 3.0,
  /** the same car cannot be shunted again for this long, s */
  cooldown: 1.8,
} as const;

/* ============================================================ spawn / stream */

export const SPAWN = {
  /** nothing spawns closer than this to the player, m */
  minDistance: 62.0,
  /** …or further than this, m */
  maxDistance: 165.0,
  /** hard despawn distance, m (also clamped to the quality draw distance) */
  despawnDistance: 235.0,
  /** despawn distance for anything the camera cannot see, m */
  despawnDistanceHidden: 150.0,
  /** candidate positions tried per spawn attempt before giving up this frame */
  candidates: 12,
  /** spawn attempts per second while under the target population */
  attemptsPerSecond: 9,
  /**
   * A candidate inside the camera frustum is rejected unless it is at least
   * this far away — that is the "never pop in front of the camera" rule.
   */
  onScreenMinDistance: 190.0,
  /** NDC margin used when testing "is this on screen" (1 = exactly the edge) */
  frustumMargin: 1.18,
  /** minimum clear gap along the lane needed to drop a new car in, m */
  clearance: 11.0,
  /** fraction of the traffic budget spent on scooters */
  scooterFraction: 0.2,
  /** minimum scooters once the budget allows any at all */
  minScooters: 2,
  /** an agent stuck below `stuckSpeed` for this long is recycled, s */
  stuckTimeout: 9.0,
  /** m/s below which an agent counts as stuck */
  stuckSpeed: 0.35,
  /** distance beyond which the vehicle switches to the shared imposter mesh, m */
  imposterDistance: 115.0,
} as const;

/* ================================================================== lighting */

export const LIGHTS = {
  /** hour after which headlights come on */
  duskHour: 18.1,
  /** hour before which headlights are still on */
  dawnHour: 6.5,
  /** minutes of fade around dusk/dawn, expressed in hours */
  fadeHours: 0.55,
  /** headlights also come on in this weather */
  rainHeadlights: 0.75,
  /** indicator blink period, s */
  blinkPeriod: 0.78,
  /** indicator duty cycle */
  blinkDuty: 0.52,
  /** an indicator runs for this long before the turn */
  indicateLead: 2.4,
  /** …and this long after it */
  indicateTrail: 0.35,
  /** brake lights light up below this deceleration, m/s² (negative accel) */
  brakeThreshold: -0.9,
  /** emissive multiplier for brake lamps */
  brakeGain: 3.1,
  /** emissive multiplier for indicators */
  indicatorGain: 3.4,
  /** emissive multiplier for headlights */
  headGain: 2.6,
  /** daytime residual on lamps so they never read as dead plastic */
  dayResidual: 0.06,
} as const;

/* ================================================================== scooters */

export const SCOOTER = {
  /** scooters use callejones; cars never do */
  useAlleys: true,
  /** extra routing weight for an alley, relative to `ROUTE.straight` */
  alleyWeight: 0.85,
  /** lateral offset toward the centreline when filtering past a queue, m */
  splitOffset: 1.15,
  /** a leader slower than this triggers lane-splitting, m/s */
  splitLeaderSpeed: 4.5,
  /** gap under which the scooter starts filtering, m */
  splitGap: 9.0,
  /** how fast the split offset is taken up, m/s */
  splitRate: 2.2,
  /** lean into a corner, rad per (rad/s of yaw) per (m/s) */
  leanGain: 0.115,
  /** maximum lean, rad (~26°) */
  maxLean: 0.46,
  /** lean smoothing rate */
  leanRate: 7.0,
  /** rider bob amplitude over cobbles, m */
  bob: 0.018,
  /** ratio of mopeds/Vespas to sports motorcycles */
  vespaShare: 0.62,
} as const;

/* =============================================================== hazard field */

export const HAZARD = {
  /** grid cell size, m */
  cell: 6.0,
  /** how far ahead a moving body's danger is projected, s */
  lookahead: 1.5,
  /** samples along that projection */
  steps: 5,
  /** lateral radius stamped around each sample, cells */
  radiusCells: 1,
  /** the player is stamped with this multiplier on top of raw speed */
  playerWeight: 1.6,
  /** a cell above this reading is "a car is coming", m/s */
  dangerous: 3.0,
} as const;

/* ============================================================== pedestrians */

export const PED = {
  /** normal pavement pace, m/s (≈ 4.9 km/h) */
  walkSpeed: 1.36,
  /** ± spread applied per person */
  walkSpread: 0.22,
  /** hurrying across a street, m/s */
  crossSpeed: 1.95,
  /** joggers on the Paseo */
  jogSpeed: 3.1,
  /** flat-out panic run, m/s. A scared person outruns a jogger. */
  panicSpeed: 5.6,
  /** how quickly a walker reaches its target speed, m/s² */
  accel: 3.5,
  /** …and how fast a *frightened* one does. Adrenaline is not gradual. */
  panicAccel: 14.0,
  /** capsule radius used for personal space and the no-run-over constraint, m */
  radius: 0.32,
  /** eye height for the sensor body centre, m */
  bodyHalfHeight: 0.62,
  /** seconds a roamer will idle at a corner before moving on */
  idleMin: 1.2,
  idleMax: 5.0,
  /** chance a roamer idles at all when it reaches a node */
  idleChance: 0.13,
  /** an agent this far off its graph position is snapped back, m */
  maxDodge: 3.4,
  /**
   * …raised to this for a moment after the car has physically shoved someone
   * out of its footprint. The ordinary clamp is what keeps the crowd tidy, but
   * applied to somebody the Jeep is currently parked on top of it would drag
   * them straight back under the wheels. See `PedestrianSystem.enforceClearance`.
   */
  maxDodgeShoved: 5.6,
  /** dodge offset spring-back rate, 1/s */
  dodgeRecover: 1.9,
  /** ped-vs-ped separation impulse, m/s per metre of overlap */
  separation: 2.2,
  /** neighbours considered for separation (spatial hash cell, m) */
  separationCell: 2.4,
  /** stuck timeout, s */
  stuckTimeout: 12.0,
} as const;

export const PED_CROSS = {
  /** a crossing is only attempted if the hazard reading is below this, m/s */
  safeHazard: 2.2,
  /** …and if the player is at least this far away, m */
  safePlayerDistance: 16.0,
  /** maximum patience at the kerb before jaywalking, s */
  maxWait: 9.0,
  /** minimum wait so a crowd doesn't all step off together, s */
  minWait: 0.35,
  /** once committed, the crossing is finished even if a car appears */
  commitBonusSpeed: 1.35,
} as const;

export const PED_PANIC = {
  /** base radius the player is noticed at, m */
  baseRadius: 7.0,
  /**
   * …plus this per m/s of player speed. At the Jeep's 50 m/s ceiling the notice
   * radius saturates at `maxRadius`, which at that speed is only about half a
   * second of warning — hence the very high `dodgeRate` and `panicAccel`.
   * People have to move *now*, not realistically.
   */
  speedRadius: 0.62,
  /** hard cap on the panic radius, m */
  maxRadius: 26.0,
  /** the player must be closing this fast to trigger a scatter, m/s */
  minSpeed: 4.0,
  /** how long the arms stay up after the scare, s */
  duration: 2.8,
  /** how hard the dodge offset is driven away from the player, m/s */
  dodgeRate: 11.5,
  /**
   * How long a shoved pedestrian keeps the widened dodge cap, s. Long enough
   * to walk out from under a parked car, short enough that the crowd tidies
   * itself up again immediately afterwards.
   */
  shoveHold: 1.6,
  /**
   * Hard guarantee. Nothing may ever be inside this radius of the player's
   * centre: after all movement the ped is projected out of it. Comedy, not
   * gore — this is why nobody is ever run over.
   */
  clearRadius: 2.15,
  /** the player capsule is treated as this long front-to-back, m */
  clearHalfLength: 2.4,
  /** at least this many people must be running for the crowd to shout */
  shoutMinPeople: 4,
  /** …and the player must be doing at least this, m/s */
  shoutMinSpeed: 12,
  /** seconds between crowd shouts */
  shoutCooldown: 3.2,
  /** the jump-back is this tall, m */
  hopHeight: 0.22,
  /** and lasts this long, s */
  hopTime: 0.42,
} as const;

export const PED_SPAWN = {
  /** peds exist in this ring around the player, m */
  minDistance: 8.0,
  maxDistance: 118.0,
  despawnDistance: 145.0,
  /** spawn attempts per second while under budget */
  attemptsPerSecond: 26,
  candidates: 8,
  /** fraction of the population anchored to a POI rather than roaming */
  anchoredFraction: 0.42,
  /** anchored people scatter this far around their POI, m */
  anchorSpread: 0.85,
  /** peds beyond this distance switch to the low-detail figure, m */
  lodDistance: 46.0,
  /** peds beyond this distance stop being drawn at all, m */
  cullDistance: 138.0,
  /** animation is re-evaluated at this rate beyond `lodDistance`, Hz */
  farAnimHz: 12,
} as const;

/* ---------------------------------------------------------------- ped anims */

/** Clip order must match `PED_CLIPS` in PedestrianModel.ts. */
export const PED_ANIM = {
  /** frames baked per clip */
  frames: 24,
  /** playback rates, cycles per second, at nominal scale */
  idleRate: 0.55,
  walkRate: 0.92,
  jogRate: 1.45,
  panicRate: 2.1,
  danceRate: 0.78,
  clapRate: 1.1,
  sitRate: 0.35,
  playRate: 1.25,
  vendRate: 0.5,
  talkRate: 0.62,
  /** a walk cycle covers this much ground, m — used to sync feet to speed */
  strideLength: 1.48,
} as const;

/* ================================================================= palettes */

/**
 * Modern Caribbean-US car colours. White dominates because it does in the real
 * Antilles — heat, resale, and rental fleets. **No 1950s Havana pastels.**
 */
export const CAR_PAINT = [
  0xe9ecee, // white
  0xdfe2e2, // off-white
  0xf2f3f0, // fleet white
  0xb4bbc1, // silver
  0x9aa2a8, // grey
  0x5c6369, // graphite
  0x2b2f33, // black
  0xb0231f, // red
  0x8f1f2a, // maroon
  0x27417e, // deep blue
  0x3f6f8f, // steel blue
  0x2c6a4f, // bottle green
  0xcbb98d, // sand beige
  0xd8862a, // ochre
] as const;

/** Weights parallel to CAR_PAINT — white/silver are far more common. */
export const CAR_PAINT_WEIGHTS = [
  16, 10, 9, 12, 8, 5, 6, 5, 2, 5, 3, 2, 4, 2,
] as const;

/** Público vans are white, near-universally, with a faded stripe. */
export const PUBLICO_PAINT = [0xf3f3ef, 0xeceade, 0xf6f5f0] as const;
export const PUBLICO_STRIPE = [0x1f5c8b, 0x2f7d4f, 0xb8362c, 0xd39b28] as const;

/** The free Old San Juan trolley: white body, bottle-green trim. */
export const TROLLEY_PAINT = [0xf5f4ee] as const;
export const TROLLEY_TRIM = [0x1d6b3c] as const;

/** Policía de Puerto Rico — navy with white doors. */
export const POLICE_PAINT = [0x18305e] as const;
export const POLICE_TRIM = [0xf0f2f4] as const;

/** Small box-van livery: white or silver body, a bold company stripe. */
export const VAN_STRIPE = [0xc9302c, 0x1f6fb2, 0x2f8f5b, 0xe2A32a, 0x37474f] as const;

/** Scooter and motorcycle bodywork. Louder than cars — they always are. */
export const SCOOTER_PAINT = [
  0xf24b3d, 0x2f9ec4, 0xf2c130, 0xf0f0ea, 0x2b2f33,
  0x6c4fa8, 0x2f9e5c, 0xe0722f, 0xb52a5e, 0x4a6fa5,
] as const;

/* ------------------------------------------------------------ people colour */

/**
 * Continuous melanin ramp, dark → light. Sampled with a *uniform* random per
 * person, so a crowd spans the actual Puerto Rican range instead of clustering
 * on three presets (ART_REFERENCE §7.2).
 */
export const SKIN_RAMP = [
  0x2e1c12, 0x3d2517, 0x4d301c, 0x5e3b22, 0x714829,
  0x855733, 0x996842, 0xad7c53, 0xc09268, 0xd0a67f,
  0xdcb896, 0xe6c8ab, 0xefd6bd, 0xf4e0cb,
] as const;

/** Hair, spanning coily black through to grey and dyed. */
export const HAIR_COLORS = [
  0x120d0a, 0x1c1410, 0x2a1a12, 0x3b2418, 0x4d3020,
  0x63412a, 0x7a5334, 0x2d2320, 0x8a7d72, 0xb9b2ac,
  0xd9d4cf, 0x7a2f2f, 0xa8452a,
] as const;

/** Light cotton — shorts, tees, sundresses, linen, the odd guayabera. */
export const SHIRT_COLORS = [
  0xf5f3ee, 0xe9edf2, 0xf2e2c8, 0xf6d2a8, 0xefb8a2,
  0xe98a7a, 0xd9534f, 0xf2c14e, 0x8fc9a8, 0x4fa3a0,
  0x3f7fb5, 0x2f5f8f, 0xa07fc0, 0xe0779f, 0xf0f0f0,
  0xcfe0d5, 0xd8d2c0, 0x6f8f5f,
] as const;

/** Trousers, shorts, skirts. */
export const PANTS_COLORS = [
  0x2f3a4a, 0x3d4757, 0x1f2733, 0x5b6472, 0x7d735f,
  0xb9ad95, 0xe8e4da, 0x4a5d78, 0x6b4a3a, 0x33465c,
] as const;

/** School uniforms: white/blue tops with navy or khaki bottoms. */
export const UNIFORM_SHIRT = [0xf2f4f6, 0xd6e4f2, 0xbfd6ea] as const;
export const UNIFORM_PANTS = [0x1f2f56, 0x2b3a63, 0x6b5f43] as const;

/** Guayabera cream/white — an older man's shirt, correctly used. */
export const GUAYABERA = [0xf4f1e6, 0xeef0ea, 0xe8e2d0] as const;

/** Shaved-ice cart paint and the striped umbrella. */
export const CART_PAINT = [0xe23b34, 0x2f8fc4, 0xf2b134, 0x2f9e5c] as const;

/* ============================================================= misc caps */

export const LIMITS = {
  /** absolute ceiling on simultaneous road agents (ultra tier + headroom) */
  maxAgents: 64,
  /** absolute ceiling on simultaneous pedestrians */
  maxPeds: 152,
  /** how many pedestrians get a physics sensor body (nearest to the player) */
  pedBodies: 30,
  /** distance inside which a ped is given a sensor body, m */
  pedBodyDistance: 42.0,
  /** static street-furniture props (vendor carts) placed once at build */
  maxCarts: 10,
} as const;
