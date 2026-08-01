/**
 * CameraModes.ts — the rig presets and the blending between them.
 *
 * A mode is nothing but a bag of numbers describing the shape of the rig.
 * `ChaseCamera` never branches on the mode id in its solver: it blends the two
 * modes it is transitioning between into a single `CameraModeParams` and solves
 * that. Adding a mode is therefore a data change, not a code change, and every
 * transition is automatically smooth.
 *
 * Axis convention (same as `CameraTuning.ts`): the rig's frame has forward at
 * `-Z`, right at `+X`, up at `+Y`, matching the vehicle. A positive `distance`
 * sits the camera *behind* the car; a negative one sits it in front, which is
 * how the bumper cam is expressed without a special case in the solver.
 */

import { FOV } from './CameraTuning';

export type CameraModeId = 'chase' | 'close' | 'far' | 'cockpit' | 'bumper' | 'showcase';

/** The purely numeric part of a mode — everything that can be interpolated. */
export interface CameraModeParams {
  /** metres behind the pivot along the rig's +Z; negative puts the camera ahead */
  distance: number;
  /** metres above the pivot */
  height: number;
  /** metres right of the pivot; non-zero gives an over-the-shoulder rig */
  lateral: number;

  /** extra metres of `distance` at `SPEED.top` */
  speedPullback: number;
  /** extra metres of `height` at `SPEED.top` */
  speedRise: number;

  /** metres above the pivot that the camera aims at */
  lookHeight: number;
  /** metres ahead of the pivot that the camera aims, at rest */
  lookLead: number;
  /** additional metres of look-ahead at `SPEED.top` */
  lookLeadSpeed: number;

  /** field of view at rest, degrees */
  fovBase: number;
  /** field of view at `SPEED.top`, degrees (before boost/air/drift kicks) */
  fovMax: number;

  /**
   * 0 = the rig is fully yaw-stabilised (it ignores chassis pitch and roll —
   * the only sane choice for an external camera on a car with 30 cm of
   * suspension travel). 1 = the rig is bolted rigidly to the chassis, which is
   * what makes a bumper cam feel like a bumper cam.
   */
  tiltKeep: number;

  /** multiplies every follow rate; > 1 is tighter, < 1 is floatier */
  rateScale: number;

  /**
   * How much of the rig's velocity lag is cancelled, 0..1.
   *
   * A first-order damper chasing a target moving at constant velocity `v`
   * settles a fixed distance `v / rate` behind it. For an external chase rig
   * that lag *is* the feel — it is why acceleration reads as acceleration. For
   * an interior rig it is a bug: at 50 m/s a bumper cam with no compensation
   * ends up two metres behind the bumper, i.e. inside the driver.
   *
   * `feedForward` interpolates between the two: 0 keeps the full analytic
   * trail, 1 tracks the desired position with exactly zero steady-state error.
   * See `ChaseCamera.solve` for why this stays framerate independent.
   */
  feedForward: number;

  /**
   * 0 = ignore world collision entirely (interior and showcase rigs, where the
   * camera is legitimately inside the car's own volume and a pull-in would be
   * both wrong and violent). 1 = full pull-in. Fractional values are only ever
   * produced by a mode blend and simply cross-fade the resolved position.
   */
  collisionWeight: number;

  /** scales the drift yaw swing and the drift roll */
  driftScale: number;

  /** scales trauma shake — an interior rig transmits more, a far rig less */
  shakeScale: number;

  /** extra metres of distance when fully airborne */
  airDistance: number;
  /** metres of height removed when fully airborne */
  airDrop: number;

  /**
   * 0 = the rig hangs off the pivot exactly as `distance`/`height`/`lateral`
   * describe. 1 = the rig sits at the *vehicle's own driver eye point*, which
   * only the vehicle knows (`CameraTarget.getCockpitEye`).
   *
   * This is the one thing a first-person view cannot express as a preset: a
   * bus driver sits 3.5 m ahead of and 0.8 m above a Jeep driver, in the same
   * chassis-local frame, and no single triple of numbers covers both. Rather
   * than branching on the mode id — which the solver never does — the mode
   * carries a *weight* and the solver blends between the preset offset and the
   * vehicle-supplied one, exactly the way `collisionWeight` cross-fades
   * between the resolved and raw positions. A half-blend during a
   * chase→cockpit transition puts the eye halfway to the driver's seat, which
   * is precisely the shot you want.
   *
   * It also drives three secondary things, all of which want to happen for
   * *any* interior rig and none of which want a second flag: the speed/boost
   * pull-backs are gated off, the pivot's Y low-pass opens up (an interior rig
   * must not float relative to the dashboard bolted 60 cm in front of it), and
   * the aim point slides across to the eye's lateral offset so the wheel sits
   * centred in frame instead of 2° off-axis.
   *
   * A vehicle with no cockpit rig falls back to the preset offset, so the mode
   * is never broken — just generic.
   */
  interiorWeight: number;

  /**
   * How much of the chassis's pitch and roll rotates the *view*, 0..1.
   *
   * Distinct from `tiltKeep`, which only rotates the frame the rig's position
   * offset is expressed in. Every external rig wants 0 here: rolling the
   * horizon from outside the car is the single most reliable way to make
   * someone ill, and the bumper cam has shipped at 0 since it was written.
   *
   * An interior rig is the one place it is wrong to be 0. The dashboard is
   * bolted to the chassis; if the head stays gyroscopically level the dash
   * visibly swings inside the frame on every camber change and the car reads
   * as being made of rubber. Partial (rather than full) tilt is the arcade
   * compromise: the horizon still tells you which way is up.
   */
  tiltAim: number;
}

export interface CameraModeDef extends CameraModeParams {
  readonly id: CameraModeId;
  /** shown by the HUD when the view changes */
  readonly label: string;
  /** whether `input.cameraPressed` cycles through this mode */
  readonly cycles: boolean;
}

/**
 * The presets.
 *
 * Distances are tuned against the Jeep's actual footprint (≈4.4 m long, 2.0 m
 * wide over the flares) and the district's ≈7 m street width: the default chase
 * rig has to fit *inside* a colonial street without the collision solver doing
 * anything, or the camera would be permanently pulled in and the tuning would
 * be a lie.
 */
export const CAMERA_MODES: Record<CameraModeId, CameraModeDef> = {
  /** The default. Reads the road, the car and the corner exit all at once. */
  chase: {
    id: 'chase',
    label: 'Chase',
    cycles: true,
    distance: 7.2,
    height: 2.35,
    lateral: 0,
    speedPullback: 3.9,
    speedRise: 0.55,
    lookHeight: 0.55,
    lookLead: 3.2,
    lookLeadSpeed: 13.0,
    fovBase: 62,
    fovMax: 86,
    tiltKeep: 0,
    rateScale: 1,
    feedForward: 0.5,
    collisionWeight: 1,
    driftScale: 1,
    shakeScale: 1,
    airDistance: 2.8,
    airDrop: 0.75,
    interiorWeight: 0,
    tiltAim: 0,
  },

  /**
   * Tight and wide. Closer plus a wider FOV is the oldest trick in the arcade
   * book — the peripheral geometry sweeps past faster, so it feels quicker than
   * the chase rig at the same speed while showing less of the road.
   */
  close: {
    id: 'close',
    label: 'Close',
    cycles: true,
    distance: 4.9,
    height: 1.85,
    lateral: 0,
    speedPullback: 2.6,
    speedRise: 0.4,
    lookHeight: 0.5,
    lookLead: 2.6,
    lookLeadSpeed: 11.0,
    fovBase: 67,
    fovMax: 90,
    tiltKeep: 0.12,
    rateScale: 1.22,
    feedForward: 0.58,
    collisionWeight: 1,
    driftScale: 1.1,
    shakeScale: 1.15,
    airDistance: 3.2,
    airDrop: 0.6,
    interiorWeight: 0,
    tiltAim: 0,
  },

  /**
   * Cinematic. Further back with a *narrower* FOV — the long lens compresses
   * the street and flattens the façades, which is what makes replay-style
   * footage look expensive. Slower rates let the car breathe in frame.
   */
  far: {
    id: 'far',
    label: 'Cinematic',
    cycles: true,
    distance: 11.5,
    height: 4.35,
    lateral: 0.9,
    speedPullback: 5.2,
    speedRise: 1.1,
    lookHeight: 0.7,
    lookLead: 4.2,
    lookLeadSpeed: 15.0,
    fovBase: 52,
    fovMax: 72,
    tiltKeep: 0,
    rateScale: 0.74,
    feedForward: 0.4,
    collisionWeight: 1,
    driftScale: 0.85,
    shakeScale: 0.7,
    airDistance: 4.0,
    airDrop: 1.1,
    interiorWeight: 0,
    tiltAim: 0,
  },

  /**
   * The driver's seat.
   *
   * Almost every number here is a consequence of `interiorWeight: 1` rather
   * than an independent choice, because at weight 1 the position triple is
   * *replaced* by whatever `CameraTarget.getCockpitEye` reports. What is left
   * below is the fallback pose (a Jeep-shaped driver, so a vehicle with no
   * cockpit rig still lands somewhere sane) plus the four things that really
   * are the mode's character:
   *
   *   `fovBase` 68 — a touch wider than chase. A cockpit view loses the whole
   *     periphery to the car itself, and a 62° lens through a windscreen feels
   *     like driving down a drainpipe. It is *not* pushed further: past ~72°
   *     the near-field dashboard starts to distort at the frame edges, which
   *     is exactly where the dashboard is.
   *
   *   `tiltKeep` 0.88 — high, because the eye is bolted into the chassis and
   *     the whole point of the view is feeling the suspension work. Not 1.0:
   *     the Jeep has 36 cm of travel and a 2.9 m wheelbase, so full rigidity
   *     reproduces every 8–20 Hz cobble the springs pass through, and over a
   *     five-minute shift that is a sickness generator rather than a feature.
   *     The remaining 12% plus the pivot's Y low-pass is the driver's neck.
   *
   *   `tiltAim` 0.62 — the head follows most of the chassis roll and pitch, so
   *     the dash stays put in frame and the horizon tilts. Full 1.0 is what a
   *     helmet cam does and it is genuinely unpleasant on a vehicle that leans
   *     as hard as these do; 0 leaves the dashboard swinging like a pendulum.
   *
   *   `rateScale` 3.0 with `feedForward` 1 — the eye must track the seat with
   *     no lag whatsoever. Any trail at all puts the camera behind the seat,
   *     i.e. inside the driver's own headrest.
   *
   * `collisionWeight` 0 for the same reason as the bumper cam: the eye is
   * legitimately inside the vehicle's own volume. `driftScale` 0.2 keeps a
   * whisper of the yaw swing so a slide still reads, without the head sliding
   * sideways out of the car.
   */
  cockpit: {
    id: 'cockpit',
    label: 'Cockpit',
    cycles: true,
    /* fallback only — a Jeep-sized driver, left-hand drive */
    distance: 0.12,
    height: 0.07,
    lateral: -0.37,
    speedPullback: 0,
    speedRise: 0,
    lookHeight: 0.1,
    lookLead: 18.0,
    lookLeadSpeed: 10.0,
    fovBase: 68,
    fovMax: 88,
    tiltKeep: 0.88,
    rateScale: 3.0,
    feedForward: 1.0,
    collisionWeight: 0,
    driftScale: 0.2,
    /**
     * *Below* 1, which is the opposite of what an interior rig usually wants —
     * and the reason is geometric, not aesthetic. Positional shake is applied
     * as a raw world offset of up to `SHAKE.positionAmplitude` (0.42 m) times
     * this scale at full trauma. The nearest interior surface to the eye is
     * the bus's steering wheel rim at 0.47 m, so anything at or above 1.0 can
     * punch the camera through its own dashboard on a heavy collision. At 0.85
     * the worst case is 0.36 m and the rim stays in front of the near plane.
     * The impact is not lost: rotational shake is untouched, and 3° of it
     * reads far harder from inside a cabin than it does from a chase rig.
     */
    shakeScale: 0.85,
    airDistance: 0,
    airDrop: 0,
    interiorWeight: 1,
    tiltAim: 0.62,
  },

  /**
   * Bumper / first-person. Sits at the bull bar (1.85 m ahead of the pivot,
   * 0.35 m below it → ≈0.6 m above the chassis origin, just over the grille).
   * `tiltKeep` 0.78 keeps most of the chassis pitch and roll so kerbs and
   * landings punch, but not all of it — full rigidity plus 30 cm of suspension
   * travel is a motion-sickness generator. `collisionWeight` 0 because the
   * camera is inside the car's own excluded volume; a pull-in here would drag
   * the eye backwards through the driver every time a wall came close.
   */
  bumper: {
    id: 'bumper',
    label: 'Bumper',
    cycles: true,
    distance: -1.85,
    height: -0.35,
    lateral: 0,
    speedPullback: 0,
    speedRise: 0,
    lookHeight: -0.22,
    lookLead: 6.0,
    lookLeadSpeed: 16.0,
    fovBase: 72,
    fovMax: 94,
    tiltKeep: 0.78,
    rateScale: 2.6,
    feedForward: 1.0,
    collisionWeight: 0,
    driftScale: 0.25,
    shakeScale: 1.45,
    airDistance: 0,
    airDrop: 0,
    interiorWeight: 0,
    tiltAim: 0,
  },

  /**
   * Title screen / garage turntable. Driven by an orbit angle rather than the
   * vehicle heading (see `ChaseCamera.setShowcase`), long lens, no collision,
   * almost no shake. `rateScale` below 1 makes the ease-in from gameplay feel
   * like a deliberate camera move rather than a cut.
   */
  showcase: {
    id: 'showcase',
    label: 'Showcase',
    cycles: false,
    distance: 8.6,
    height: 2.5,
    lateral: 0,
    speedPullback: 0,
    speedRise: 0,
    lookHeight: 0.55,
    lookLead: 0,
    lookLeadSpeed: 0,
    fovBase: 42,
    fovMax: 42,
    tiltKeep: 0,
    rateScale: 0.62,
    feedForward: 1.0,
    collisionWeight: 0,
    driftScale: 0,
    shakeScale: 0.15,
    airDistance: 0,
    airDrop: 0,
    interiorWeight: 0,
    tiltAim: 0,
  },
};

/** The order `input.cameraPressed` walks. Showcase is deliberately excluded. */
export const CAMERA_CYCLE: readonly CameraModeId[] = [
  'chase',
  'close',
  'far',
  'cockpit',
  'bumper',
];

/** Next mode in the player-facing cycle. Unknown/showcase ids restart at chase. */
export function nextCameraMode(current: CameraModeId): CameraModeId {
  const i = CAMERA_CYCLE.indexOf(current);
  if (i < 0) return CAMERA_CYCLE[0];
  return CAMERA_CYCLE[(i + 1) % CAMERA_CYCLE.length];
}

/** A zeroed params block, for preallocating the blend destination. */
export function createModeParams(): CameraModeParams {
  return {
    distance: 0,
    height: 0,
    lateral: 0,
    speedPullback: 0,
    speedRise: 0,
    lookHeight: 0,
    lookLead: 0,
    lookLeadSpeed: 0,
    fovBase: FOV.hardMin,
    fovMax: FOV.hardMin,
    tiltKeep: 0,
    rateScale: 1,
    feedForward: 0.5,
    collisionWeight: 1,
    driftScale: 1,
    shakeScale: 1,
    airDistance: 0,
    airDrop: 0,
    interiorWeight: 0,
    tiltAim: 0,
  };
}

/** Copy `src` into `out` without allocating. */
export function copyModeParams(src: CameraModeParams, out: CameraModeParams): CameraModeParams {
  out.distance = src.distance;
  out.height = src.height;
  out.lateral = src.lateral;
  out.speedPullback = src.speedPullback;
  out.speedRise = src.speedRise;
  out.lookHeight = src.lookHeight;
  out.lookLead = src.lookLead;
  out.lookLeadSpeed = src.lookLeadSpeed;
  out.fovBase = src.fovBase;
  out.fovMax = src.fovMax;
  out.tiltKeep = src.tiltKeep;
  out.rateScale = src.rateScale;
  out.feedForward = src.feedForward;
  out.collisionWeight = src.collisionWeight;
  out.driftScale = src.driftScale;
  out.shakeScale = src.shakeScale;
  out.airDistance = src.airDistance;
  out.airDrop = src.airDrop;
  out.interiorWeight = src.interiorWeight;
  out.tiltAim = src.tiltAim;
  return out;
}

/**
 * Linear blend of two mode presets into `out`, allocation-free.
 *
 * Every field interpolates cleanly, including `collisionWeight` — a half-blend
 * between chase and bumper cross-fades between the collision-resolved and raw
 * positions, which is exactly right: as the camera dives toward the grille it
 * progressively stops caring about the wall it is passing through, and by the
 * time it is inside the car it ignores the world completely.
 */
export function blendModeParams(
  a: CameraModeParams,
  b: CameraModeParams,
  t: number,
  out: CameraModeParams,
): CameraModeParams {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const m = 1 - k;
  out.distance = a.distance * m + b.distance * k;
  out.height = a.height * m + b.height * k;
  out.lateral = a.lateral * m + b.lateral * k;
  out.speedPullback = a.speedPullback * m + b.speedPullback * k;
  out.speedRise = a.speedRise * m + b.speedRise * k;
  out.lookHeight = a.lookHeight * m + b.lookHeight * k;
  out.lookLead = a.lookLead * m + b.lookLead * k;
  out.lookLeadSpeed = a.lookLeadSpeed * m + b.lookLeadSpeed * k;
  out.fovBase = a.fovBase * m + b.fovBase * k;
  out.fovMax = a.fovMax * m + b.fovMax * k;
  out.tiltKeep = a.tiltKeep * m + b.tiltKeep * k;
  out.rateScale = a.rateScale * m + b.rateScale * k;
  out.feedForward = a.feedForward * m + b.feedForward * k;
  out.collisionWeight = a.collisionWeight * m + b.collisionWeight * k;
  out.driftScale = a.driftScale * m + b.driftScale * k;
  out.shakeScale = a.shakeScale * m + b.shakeScale * k;
  out.airDistance = a.airDistance * m + b.airDistance * k;
  out.airDrop = a.airDrop * m + b.airDrop * k;
  out.interiorWeight = a.interiorWeight * m + b.interiorWeight * k;
  out.tiltAim = a.tiltAim * m + b.tiltAim * k;
  return out;
}

/**
 * How long a mode change takes, seconds. Short enough to feel responsive to a
 * button press, long enough that the position damper does the visual work
 * rather than the parameter blend snapping the rig into a new shape.
 */
export const MODE_BLEND_TIME = 0.5;


/* ========================================================================== */
/*                      the view channel (UI ⇆ rig)                           */
/* ========================================================================== */

/**
 * The one shared record connecting "what view is the player in" to the two
 * places that care and cannot see each other.
 *
 * The settings menu is built by the UI layer, which never gets a reference to
 * the `ChaseCamera` the boot code constructed; the camera, symmetrically, only
 * ever sees a frozen `SettingsState` and has no way to write one. This is the
 * same trick `core/Input.ts` already uses for `touchChannel`, and for the same
 * reason: one plain mutable module-level object is cheaper and far less
 * fragile than threading a reference through five constructors.
 *
 * `current` is written by the rig and read by the UI (so a `V` press updates
 * what the menu shows). `requested` is written by the UI and consumed by the
 * rig on its next frame, which keeps the hand-off single-threaded and edge-
 * triggered — the menu cannot fight the player's button press.
 */
export const cameraViewChannel: {
  current: CameraModeId;
  requested: CameraModeId | null;
} = {
  current: 'chase',
  requested: null,
};

/** Ask the rig to change view. Consumed on the next camera frame. */
export function requestCameraView(id: CameraModeId): void {
  cameraViewChannel.requested = id;
}

/** Narrow an unknown (a save field, a URL parameter) to a cyclable view id. */
export function isCyclableCameraView(v: unknown): v is CameraModeId {
  return typeof v === 'string' && (CAMERA_CYCLE as readonly string[]).includes(v);
}
