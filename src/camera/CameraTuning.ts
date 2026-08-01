/**
 * CameraTuning.ts — every constant the chase camera uses, in one place.
 *
 * Nothing in `ChaseCamera.ts`, `CameraShake.ts` or `CameraModes.ts` contains a
 * bare number that affects feel; it all lives here so the rig can be re-tuned
 * without reading a line of the solver.
 *
 * Two conventions used throughout:
 *
 *  - **Rates** are the `rate` argument of `damp()` from `core/MathUtils`: the
 *    fraction of the remaining gap closed per second is `1 - e^(-rate·dt)`.
 *    A rate of `r` has a time constant of `1/r` seconds — rate 10 settles ~63%
 *    of the way in 100 ms, ~95% in 300 ms. Higher = snappier.
 *  - **Local rig axes** are the vehicle's: forward is `-Z`, right is `+X`,
 *    up is `+Y`. So a *positive* `distance` puts the camera *behind* the car,
 *    and a negative one puts it in front (that's how the bumper cam works).
 *
 * These are deliberately plain mutable numbers rather than `as const` so a dev
 * overlay can hot-tune them at runtime without a rebuild.
 */

/** Reference speeds, m/s. Matches the vehicle's natural top speed of 52 m/s. */
export const SPEED = {
  /** speed that maps to "full" framing — pull-back, FOV and lead all max here */
  top: 52,
  /** below this the velocity vector is too noisy to aim the camera with */
  velocityValid: 2.5,
  /** velocity fully overrides the chassis facing for look-ahead above this */
  velocityFull: 9.0,
  /**
   * The speed→framing curve exponent. <1 front-loads the effect so the first
   * 20 m/s already feel fast; a linear ramp makes low speed feel inert.
   */
  curveExponent: 0.78,
};

/** Where the rig is anchored on the car, and how it filters chassis motion. */
export const PIVOT = {
  /**
   * Metres above the chassis origin that the rig orbits and aims through.
   * The Jeep's cage top is ~1.18 local; 0.95 puts the pivot at driver-chest
   * height so the bonnet stays low in frame and the road reads clearly.
   */
  height: 0.95,

  /**
   * Low-pass rate on the pivot's *world Y*. This is the single most important
   * anti-nausea number in the file: suspension travel over adoquín cobbles is a
   * 8–20 Hz signal, and a camera that reproduces it is unwatchable. Filtering
   * the rig's *input* (here) rather than lagging its *output* means the camera
   * still tracks real elevation change — hills, ramps, the fort ramparts — at
   * full speed while bump chatter never reaches it.
   */
  yFilterRate: 9.0,

  /**
   * ...but the filter is not allowed to fall more than this far behind the real
   * chassis height, so driving off a sea wall doesn't leave the camera hanging
   * in the sky for half a second.
   */
  yMaxLag: 2.6,

  /** while airborne the filter opens right up — a jump arc is signal, not noise */
  yFilterRateAir: 22.0,

  /**
   * `yFilterRate` is multiplied by this at `interiorWeight` 1.
   *
   * The low-pass exists because an external camera must not reproduce
   * suspension chatter. An *interior* camera has the opposite problem: the
   * dashboard is rigidly bolted 60 cm in front of the eye, so any lag between
   * the eye's world Y and the chassis's shows up as the whole dash bobbing
   * inside the frame — far more obvious, and far worse, than the chatter the
   * filter was put there to remove. Rate 9 → 32 takes the time constant from
   * 111 ms to 31 ms: fast enough that the dash sits still, slow enough that
   * the sharpest single-frame spikes are still clipped.
   */
  interiorRateMultiplier: 3.6,
};

/**
 * Interior (cockpit) rig specifics — the numbers that only mean anything when
 * `CameraModeParams.interiorWeight` and `tiltAim` are non-zero.
 */
export const INTERIOR = {
  /**
   * How fast the head's borrowed chassis pitch/roll eases toward the chassis's
   * true attitude, 1/s. The chassis quaternion is the *physics body's*, which
   * bounces on every cobble; damping it here is the driver's neck. Fast enough
   * (90 ms) that a kerb strike still punches.
   */
  tiltRate: 11.0,
  /** clamp on borrowed pitch, radians (≈17°) — a backflip must not spin the head */
  maxPitch: 0.3,
  /** clamp on borrowed roll, radians (≈20°) */
  maxRoll: 0.35,
  /**
   * Borrowed tilt is faded out with the airborne blend. Mid-flip the chassis
   * attitude is meaningless to a driver's inner ear and following it is the
   * single most nauseating thing the rig could do.
   */
  airFade: 1.0,
};

/** Spring-damper follow rates. See the note at the top of the file. */
export const FOLLOW = {
  /**
   * Along the rig's Z (the trailing axis). Deliberately the *loosest* rate:
   * the camera falling behind under acceleration and catching up under braking
   * is most of what "speed" feels like in an arcade racer.
   */
  longitudinal: 5.4,

  /**
   * Along the rig's X. Loose too, so hard direction changes let the car slide
   * across frame before the camera swings in behind it.
   */
  lateral: 4.6,

  /**
   * Along world-ish Y. Much stiffer than the horizontal rates — vertical lag
   * reads as bobbing/floating and is the classic nausea source. Combined with
   * `PIVOT.yFilterRate` this is a two-stage vertical filter: smooth input,
   * tight output.
   */
  vertical: 13.0,

  /** how fast the aim point chases its target — stiffer than position, so the car stays centred */
  look: 9.5,

  /** how fast the rig's yaw chases the blended heading */
  yaw: 5.2,

  /** how fast the camera rolls into and out of a slide */
  roll: 4.5,

  /** FOV easing. Slow on purpose: a snapping FOV is instantly cheap-looking. */
  fov: 3.4,

  /**
   * Rates are multiplied by `1 + speedNorm · speedTighten`. Without this the
   * rig keeps falling further behind the faster you go and eventually the car
   * is a dot; with it the trailing distance stays roughly constant.
   */
  speedTighten: 0.55,

  /**
   * Hard clamp on the analytic trail offset, metres per axis. Only a physics
   * blow-up can reach it; it exists so an absurd reported velocity cannot
   * teleport the rig into the next district.
   */
  maxTrail: 6.0,

  /**
   * Hard leash: the camera is never allowed further from the pivot than
   * `desiredDistance · leashFactor + leashSlack` metres. Catches pathological
   * frames (a 200 ms hitch, a physics teleport) before they become a fly-across.
   */
  leashFactor: 1.65,
  leashSlack: 5.0,

  /**
   * If the target moves further than this in one frame it was teleported, not
   * driven — snap instead of interpolating across Old San Juan.
   */
  teleportDistance: 45.0,
};

/** Field of view, degrees. Base 62 matches `CONFIG.camera.fov`. */
export const FOV = {
  /** extra degrees while `isBoosting`, on top of the speed curve */
  boostKick: 7.5,
  /**
   * The boost kick scales with how full the meter is — a boost fired on fumes
   * shouldn't punch as hard as one off a full bar.
   */
  boostKickMeterFloor: 0.55,
  /** extra degrees while airborne — opens the frame up so the horizon reads */
  airKick: 3.0,
  /** extra degrees at full drift — subtle, the yaw swing does the heavy lifting */
  driftKick: 2.5,
  /** absolute clamp so no combination of kicks can produce a fisheye */
  hardMax: 96,
  hardMin: 32,
  /** skip `updateProjectionMatrix()` when the change is below this many degrees */
  epsilon: 0.004,
};

/** Look-ahead framing: where the camera aims, versus where the car is. */
export const LOOK = {
  /**
   * While looking backwards the lead flips behind the car, but shortened —
   * you want to see what's chasing you, not the horizon behind it.
   */
  leadBackScale: 0.45,
  /**
   * Airborne: bias the aim point down toward the landing, proportional to how
   * fast we're falling. Metres of drop per m/s of downward velocity...
   */
  airDropPerFallSpeed: 0.22,
  /** ...clamped to this many metres so a long fall doesn't aim at your feet */
  airDropMax: 5.0,
  /**
   * The aim point is never allowed closer to the eye than this, otherwise the
   * lookAt basis degenerates and the view spins.
   */
  minAimDistance: 1.2,
};

/**
 * Drift framing.
 *
 * The maths, because this is the subtle bit:
 *
 *   `slip = angleDelta(carYaw, velocityYaw)` — the signed shortest rotation
 *   from where the nose points to where the car is actually travelling.
 *   In a right-hand drift the nose is right of the travel direction, so the
 *   travel direction is counter-clockwise from the nose, so `slip > 0`
 *   (positive yaw about +Y is counter-clockwise seen from above).
 *
 *   The rig's yaw target becomes `carYaw + slip · k`, with `k ∈ [0, blendMax]`.
 *   `k = 0` glues the camera behind the nose (you see a beautiful sideways car
 *   but have no idea where you're going); `k = 1` glues it behind the velocity
 *   vector (you can see where you're going but the car looks straight). The
 *   money shot is in between — the camera sits *between* the two headings, so
 *   the car is visibly sideways in frame **and** the corner exit is visible.
 *
 *   `k` itself ramps with `|slip|` (smoothstep between `slipStart` and
 *   `slipFull`), so gentle cornering slip barely moves the camera and a real
 *   handbrake drift swings it hard. That makes the total offset super-linear
 *   in slip, which is why it's clamped by `yawOffsetMax`.
 *
 *   Two guards keep it sane:
 *   - `maxSlip` — beyond ~75° of slip the car is spinning out, not drifting.
 *     Blending there would whip the camera through a full circle; instead the
 *     blend decays to zero and the rig stays behind the nose.
 *   - reversing — `forwardSpeed < 0` makes slip ≈ π, which would flip the
 *     camera to the front of the car. Gated off entirely.
 */
export const DRIFT = {
  /** slip below this contributes nothing (rad, ≈7°) */
  slipStart: 0.12,
  /** slip at which the blend factor is fully open (rad, ≈40°) */
  slipFull: 0.70,
  /** hard gate — above this the car is spinning, not drifting (rad, ≈75°) */
  maxSlip: 1.30,
  /** minimum forward speed for the drift blend to engage at all, m/s */
  minForwardSpeed: 1.0,

  /** maximum fraction of the slip angle the camera swings toward */
  blendMax: 0.58,
  /** absolute clamp on the yaw swing (rad, ≈33°) */
  yawOffsetMax: 0.58,

  /**
   * How much of the blend applies when the vehicle is *not* flagged as
   * drifting. Ordinary cornering slip still gets a little life, just less.
   */
  passiveWeight: 0.45,

  /** how fast the drift blend engages and releases */
  engageRate: 7.0,
  releaseRate: 3.6,

  /**
   * Camera roll, radians per radian of slip. Negative because a *positive*
   * rotation about the camera's local +Z (which points backwards, out of the
   * screen) rotates the image clockwise, and banking into a right-hand drift
   * (slip > 0) should rotate the horizon counter-clockwise — right wing down,
   * exactly like an aircraft banking right.
   */
  rollPerSlipRad: -0.16,
  /** absolute roll clamp (rad, ≈7.5°) — more than this and it reads as a bug */
  rollMax: 0.13,

  /** extra metres of pull-back at full drift, so the sideways car still fits */
  pullback: 1.3,
};

/** Airborne framing. */
export const AIR = {
  /** seconds of airtime before the airborne framing is fully in */
  rampTime: 0.42,
  /** how fast the airborne blend engages / recovers on landing */
  engageRate: 5.5,
  landRate: 7.5,

  /** extra metres of distance while fully airborne — drop back off the car */
  extraDistance: 2.8,
  /** metres of height *removed* while airborne — drop down so the horizon reads */
  dropHeight: 0.75,

  /**
   * Damping rates are multiplied by this while airborne. The looser rig is what
   * produces the "slow-mo" hang: the camera drifts languidly rather than
   * tracking the car's arc rigidly, and lands back on it as the blend releases.
   */
  easeRateScale: 0.62,

  /**
   * How much of the rig's heading switches from the chassis yaw to the velocity
   * heading while airborne. The car can barrel-roll and spin freely in the air;
   * following its yaw would spin the camera with it, which is genuinely
   * sickening. Following the velocity heading keeps the world stable.
   */
  yawToVelocity: 0.85,

  /** the drift blend is scaled by this while airborne (slip is meaningless in air) */
  driftScale: 0.15,
};

/** Boost framing — a short punch layered on top of the speed curve. */
export const BOOST = {
  /** extra metres of pull-back while boosting */
  pullback: 1.1,
  /** how fast the boost blend rises and falls */
  engageRate: 9.0,
  releaseRate: 4.0,
  /** continuous shake rumble while boosting, 0..1 */
  rumble: 0.34,
};

/** Look-back (the `input.lookBack` 180° swing). */
export const LOOK_BACK = {
  /**
   * Engage/release rates for the 0..1 blend. The blend is added to the yaw
   * target as `amount · π` rather than damping the yaw *across* the wrap point,
   * so the swing direction is deterministic and can't take the "short way"
   * differently on the way out than on the way in.
   */
  engageRate: 9.0,
  releaseRate: 8.0,
  /** the drift yaw swing is scaled by this while looking back */
  driftScale: 0.2,
  /** the rig tightens while looking back so the swing lands crisply */
  rateScale: 1.5,
};

/**
 * World collision.
 *
 * Recovery model, and why it is asymmetric:
 *
 *   Every frame we sphere-cast from the pivot to the *desired* camera position.
 *   If something in `GROUP.WORLD | GROUP.PROP` is in the way, the camera has to
 *   come in along that ray. Pulling in is a **hard clamp**, applied
 *   unconditionally after any smoothing: a rate-limited pull-in means that for
 *   some number of frames the camera is provably inside a wall, and in Old San
 *   Juan's 3 m alleys that happens constantly. There is no tuning value that
 *   makes a lagged pull-in safe, so there isn't one — it's `Math.min`.
 *
 *   Pushing back *out* is the opposite problem. It is always safe (the cast
 *   re-validates the new distance every frame), but it is very visible, so it
 *   is damped at `recoverRate` and gated behind `recoverDelay`. The delay is
 *   what stops the classic alley chatter: driving past a doorway briefly opens
 *   the ray, and without a hold the camera lunges out and slams back in on the
 *   next frame. Holding for ~120 ms means only sustained clearance recovers.
 *
 *   `recoverRate` is intentionally brisk (0.35 s time constant) rather than
 *   cinematic-slow: a camera that recovers too lazily stays uncomfortably close
 *   to the car for the whole street after one clipped corner.
 *
 * Near-plane safety:
 *
 *   `probeRadius` is not a constant — it is recomputed from the *live* FOV,
 *   aspect and near distance as the radius of the circle circumscribing the
 *   near-plane rectangle, plus `probeMargin`. That is the exact radius of the
 *   sphere that the visible frustum corner sweeps, so if the sphere cast is
 *   clear, no near-plane corner can be inside geometry. `probeRadiusMin` is a
 *   floor for absurdly narrow FOVs.
 */
export const COLLISION = {
  /** groups the camera collides against — never TRAFFIC, PED, TRIGGER or DEBRIS */
  probeRadiusMin: 0.34,
  /** slack added to the geometric near-plane corner radius, metres */
  probeMargin: 0.16,
  /** back off this far from the reported contact point, metres */
  skin: 0.07,

  /**
   * Absolute floor on pivot→camera distance. Must comfortably exceed
   * `CONFIG.camera.near` (0.3) plus the probe radius, and is the distance the
   * camera ends up at when the Jeep is wedged nose-first into a wall.
   */
  hardMinDistance: 1.15,

  /** how fast the camera pushes back out once the way is clear */
  recoverRate: 2.9,
  /** seconds of continuous clearance required before recovery starts */
  recoverDelay: 0.12,

  /**
   * Extra metres the probe is cast beyond wherever the rig currently wants to
   * be. Without it the cast length equals the pinned-in distance, the "clear"
   * distance the recovery damper aims at equals the distance it is already at,
   * and the camera never pushes back out at all — the recovery deadlocks. The
   * cast always runs to at least the *desired* distance plus this slack.
   */
  recoverProbeSlack: 0.75,

  /**
   * When the ray is heavily blocked the rig lifts and shortens instead of just
   * jamming against the wall. This is the escape hatch for the worst case (the
   * pivot itself inside the probe radius of a façade, where the cast reports
   * distance 0): tilting the offset upward re-aims the ray at open sky, which
   * always clears. Without it, a car parked against a wall pins the camera at
   * `hardMinDistance` inside the masonry.
   */
  tightLift: 2.4,
  /** at full block the horizontal offset is scaled by this */
  tightPullFactor: 0.45,
  /** rates for the blocked-ness blend that drives the lift */
  tightEngageRate: 8.0,
  tightReleaseRate: 3.0,
};

/** Slow orbiting showcase rig for the title screen and garage. */
export const SHOWCASE = {
  /** radians per second — one full revolution every ~34 s */
  orbitSpeed: 0.185,
  /** metres of vertical bob */
  bobAmplitude: 0.45,
  /** bob cycles per second */
  bobRate: 0.13,
  /**
   * The showcase rig runs on *unpaused* wall-clock time so the title screen
   * keeps turning behind a pause menu. This clamps a tab-switch spike.
   */
  maxStep: 1 / 15,
};

/** Accessibility scaling for trailing/sway motion (`settings.cameraSway`). */
export const SWAY = {
  /**
   * At `cameraSway = 0` every follow rate is multiplied by this — the rig
   * becomes near-rigid, so there is no trailing, no swing and no float. At
   * `cameraSway = 1` the multiplier is 1 (the tuned feel above).
   */
  rigidRateMultiplier: 2.6,
  /** the drift yaw swing keeps at least this fraction at cameraSway 0 */
  driftFloor: 0.35,
  /** amplitude of the idle handheld drift, metres, at cameraSway 1 */
  handheldAmplitude: 0.055,
  /** handheld noise frequency, Hz */
  handheldFrequency: 0.21,
  /** handheld noise is suppressed below this speed fraction and above it too */
  handheldSpeedPeak: 0.35,
};

/** Values the fx module reads (`speedBlurAmount`, `fovKick`). */
export const FX = {
  /** speed fraction at which radial blur starts to appear */
  blurStart: 0.28,
  /** weight of the raw speed term in `speedBlurAmount` */
  blurSpeedWeight: 0.78,
  /** additive weight while boosting */
  blurBoostWeight: 0.34,
  /** additive weight at full drift */
  blurDriftWeight: 0.16,
  /** how fast `speedBlurAmount` eases — matched to the FOV rate so they agree */
  easeRate: 5.0,
};

/** Trauma-based screen shake. */
export const SHAKE = {
  /** trauma lost per second — linear decay, the classic Eiserloh model */
  decayPerSecond: 1.35,

  /**
   * Shake magnitude is `trauma²`. The square is what makes small hits read as
   * a tap and big ones as a slam, instead of everything feeling the same.
   */
  positionAmplitude: 0.42,
  /** radians of rotational shake at full trauma */
  rotationAmplitude: 0.052,
  /** roll shakes less than pitch/yaw — rolling the horizon is the nauseating axis */
  rollScale: 0.45,

  /** primary noise frequency, Hz */
  frequency: 13.5,
  /** second octave multiplier and weight — adds grit without becoming jitter */
  octaveFrequency: 2.37,
  octaveWeight: 0.38,

  /** continuous rumble (boost, rough ground) is quieter and slower than trauma */
  rumbleAmplitude: 0.35,
  rumbleFrequency: 8.5,

  /** `photosensitiveSafe` multiplies all shake by this */
  photosensitiveScale: 0.45,

  /* ---- event → trauma mapping ---- */

  /** contact impulse (N·s) that produces full trauma from a collision */
  collisionFullImpulse: 5200,
  /** per-kind weighting for `vehicle:collision` */
  collisionWeightWall: 1.0,
  collisionWeightTraffic: 0.92,
  collisionWeightProp: 0.42,
  collisionWeightPed: 0.22,
  /** ceiling on trauma from a single collision, so a pile-up can't max out */
  collisionMax: 0.85,

  /** drop height (m) that produces full landing trauma */
  landFullHeight: 9.0,
  /** landing trauma weight from height and from airtime */
  landHeightWeight: 0.62,
  landAirtimeWeight: 0.18,
  /** airtime (s) that saturates the airtime term */
  landFullAirtime: 2.2,
  /** a clean (wheels-level) landing shakes less */
  landCleanScale: 0.62,

  /** trauma from a destroyed prop, at zero distance */
  propTrauma: 0.30,
  /** metres beyond which a prop break contributes nothing */
  propFalloffDistance: 26.0,

  /** trauma punch when a boost fires */
  boostTrauma: 0.30,

  /** noise seeds — distinct per channel so the axes never correlate */
  seedPosX: 0x1a2b,
  seedPosY: 0x3c4d,
  seedPosZ: 0x5e6f,
  seedRotX: 0x7081,
  seedRotY: 0x9293,
  seedRotZ: 0xa4b5,
};

/** Belt-and-braces numerical guards. */
export const SAFETY = {
  /** below this the rig treats a vector as zero-length */
  epsilon: 1e-6,
  /**
   * Horizontal length of the chassis forward vector below which the yaw is
   * degenerate (car pointing straight up or down mid-flip) and we fall back to
   * the roof direction, then to the last valid yaw.
   */
  yawDegenerateThreshold: 0.08,
  /** frame delta is clamped to this before any rig maths, seconds */
  maxStep: 1 / 15,
};
