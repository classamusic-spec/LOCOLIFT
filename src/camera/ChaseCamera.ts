/**
 * ChaseCamera.ts — the Loco Lift chase camera.
 *
 * Design in one paragraph: the rig is a **yaw-stabilised arm**. Every frame we
 * build a heading (blended from the chassis facing, the velocity heading and,
 * in the air, pure velocity), hang a desired eye position off the pivot in that
 * frame, and pull the real eye toward it with three independent first-order
 * dampers expressed *in that frame* — loose along the trailing axis, loose
 * laterally, stiff vertically. Then we sphere-cast pivot → eye and hard-clamp
 * the result so the eye can never be inside the city. Aim, FOV, roll and shake
 * are separate, independently eased channels layered on top.
 *
 * Why first-order dampers rather than a literal mass-spring: `damp()` is
 * *exactly* framerate independent (`1 - e^(-rate·dt)` composes correctly over
 * any subdivision of dt) and can never overshoot. A second-order spring
 * overshoots by construction, and overshoot on a camera that is already moving
 * at 50 m/s through 7 m streets is both a nausea source and a wall-clipping
 * source. Three separately-rated first-order channels give all the "arm" feel
 * with none of the ringing.
 *
 * Frame budget: one sphere-cast, no allocations, no `Math` transcendentals in
 * the hot path beyond a handful of `exp`/`atan2`/`sin`/`cos`.
 *
 * Ownership: this file, `CameraShake.ts`, `CameraModes.ts` and
 * `CameraTuning.ts`. It deliberately does **not** import the vehicle module —
 * `CameraTarget` below is a structural interface that the real `Vehicle`
 * satisfies by shape.
 */

import * as THREE from 'three';
import { DEFAULT_SETTINGS } from '../core/Config';
import type { EventBus } from '../core/EventBus';
import {
  angleDelta,
  clamp,
  clamp01,
  damp,
  dampVec3,
  invLerp,
  lerp,
  scratch,
  smoothstep,
  wrapAngle,
} from '../core/MathUtils';
import { valueNoise2D } from '../core/RNG';
import type { GameContext, InputState, QualityTier, SettingsState, System } from '../core/types';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle, PhysicsWorldAPI } from '../physics/PhysicsTypes';
import {
  CAMERA_CYCLE,
  CAMERA_MODES,
  MODE_BLEND_TIME,
  blendModeParams,
  cameraViewChannel,
  copyModeParams,
  createModeParams,
  isCyclableCameraView,
  nextCameraMode,
  requestCameraView,
} from './CameraModes';
import type { CameraModeId, CameraModeParams } from './CameraModes';
import { CameraShake } from './CameraShake';
import {
  AIR,
  BOOST,
  COLLISION,
  DRIFT,
  FOLLOW,
  FOV,
  FX,
  INTERIOR,
  LOOK,
  LOOK_BACK,
  PIVOT,
  SAFETY,
  SHOWCASE,
  SPEED,
  SWAY,
} from './CameraTuning';

/**
 * What the camera needs from whatever it is following.
 *
 * This is duck-typed against the documented `Vehicle` public surface in
 * `docs/ARCHITECTURE.md`; the real vehicle satisfies it structurally, and the
 * camera never imports it. Anything else with these members — a spectator
 * drone, a replay playback head, a test double — works identically.
 *
 * Every member is treated as untrusted: the solver validates the transform and
 * clamps or ignores non-finite scalars rather than propagating them.
 */
export interface CameraTarget {
  /** root transform of the followed object */
  readonly object3d: THREE.Object3D;
  /** physics body, excluded from the camera's collision casts */
  readonly body: BodyHandle;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
  /** m/s, always >= 0 */
  readonly speed: number;
  /** m/s along local -Z, signed */
  readonly forwardSpeed: number;
  readonly isDrifting: boolean;
  /** radians of slip */
  readonly driftAngle: number;
  readonly isAirborne: boolean;
  /** seconds since leaving the ground */
  readonly airtime: number;
  readonly isBoosting: boolean;
  /** 0..1 boost meter fill */
  readonly boostFraction: number;
  /** 0..4 */
  readonly wheelsOnGround: number;

  /**
   * Optional: where this target's driver's eye is, in the target's own local
   * frame, metres. Returns `out` when the target has a cockpit, `null` when it
   * does not — in which case the cockpit mode falls back to its preset offset.
   *
   * Local (not world) because the rig has to apply its own tilt-keep frame to
   * it, and because the vehicle is entitled to fold its cosmetic body lean in
   * before answering: the dashboard leans with the body, so the eye must too,
   * or the two visibly slide apart on every corner.
   */
  getCockpitEye?(out: THREE.Vector3): THREE.Vector3 | null;

  /**
   * Optional: how much the rig is inside this target right now, 0..1.
   *
   * The camera calls this every frame with the live blended `interiorWeight`,
   * which is how interior geometry gets built and shown *only* while it can be
   * seen — a chase-cam frame must not pay a single triangle for a dashboard
   * nobody is looking at. Ramped rather than boolean so the vehicle can fade
   * a driver figure out as the eye moves into its head.
   */
  setInteriorAmount?(amount: number): void;
}

/**
 * The rig's QA surface, published on `window`.
 *
 * Declared here rather than in the boot module because the boot module has no
 * reason to know a camera is testable, and a harness that has to reach through
 * five layers of wiring to switch view is a harness that stops being run.
 */
export interface LocoCameraTestHook {
  /** the view the rig is in right now */
  readonly mode: string;
  /** live blended `interiorWeight`, 0..1 */
  readonly interior: number;
  /** every view `V` walks, in order */
  views(): string[];
  /** ask for a view by id; unknown ids are ignored */
  request(view: string): void;
  cycle(): void;
  pose(): Record<string, number>;
  /**
   * Raycast from the live camera, `yawDeg` right and `pitchDeg` up from where
   * it points, and name what it hits. `mine` is true when the hit belongs to
   * the followed vehicle. The only reliable way to answer "what is in front of
   * the cockpit camera".
   */
  probe(
    yawDeg?: number,
    pitchDeg?: number,
    limit?: number,
  ): Array<{ name: string; mat: string; dist: number; mine: boolean; y: number }>;
}

declare global {
  interface Window {
    __locoCam?: LocoCameraTestHook;
  }
}

const AXIS_Y = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** The camera collides with static world geometry and props. Nothing else. */
const CAMERA_MASK = GROUP.WORLD | GROUP.PROP;

/** Noise rows for the idle handheld drift — distinct from the shake's seeds. */
const HANDHELD_SEED_X = 0xc0de;
const HANDHELD_SEED_Y = 0xbead;

export class ChaseCamera implements System {
  readonly name = 'camera';

  /** Public so fx/UI/haptics can add trauma or read intensity. */
  readonly shake: CameraShake;

  private readonly camera: THREE.PerspectiveCamera;
  private target: CameraTarget;
  private physics: PhysicsWorldAPI | null;

  /* ------------------------------------------------------------- mode state */

  private modeId: CameraModeId = 'chase';
  private prevModeId: CameraModeId = 'chase';
  /** 0..1 progress from `prevModeId` to `modeId` */
  private modeBlend = 1;
  /** which mode showcase should return to */
  private modeBeforeShowcase: CameraModeId = 'chase';
  private showcaseObject: THREE.Object3D | null = null;
  private showcaseActive = false;
  private orbitAngle = 0;
  private orbitTime = 0;

  /** blended mode parameters — preallocated, rewritten every frame */
  private readonly params: CameraModeParams = createModeParams();
  /** "from" pose captured when a mode change interrupts an in-flight blend */
  private readonly frozenFrom: CameraModeParams = createModeParams();
  private useFrozenFrom = false;

  /* ---------------------------------------------------------- solver state */

  /** the eye position the rig has actually reached (world) */
  private readonly eye = new THREE.Vector3();
  /** the point the camera is actually aiming at (world), independently damped */
  private readonly look = new THREE.Vector3();
  /** filtered pivot (world) */
  private readonly anchor = new THREE.Vector3();
  private anchorY = 0;
  private anchorInitialised = false;

  private followYaw = 0;
  private lastCarYaw = 0;
  private roll = 0;
  private fovCurrent = CAMERA_MODES.chase.fovBase;

  private driftBlend = 0;
  private airBlend = 0;
  private boostBlend = 0;
  private lookBackAmount = 0;

  /** current cleared pivot→eye distance, metres */
  private collisionDist = Infinity;
  /** seconds of clearance still required before the camera may push back out */
  private recoverHold = 0;
  /** raw 0..1 blocked-ness this frame, and its smoothed form driving the lift */
  private blockedRaw = 0;
  private blockedBlend = 0;

  private _speedBlur = 0;
  private _fovKick = 0;
  private noiseTime = 0;

  /** eased chassis pitch/roll borrowed by the head in an interior rig, radians */
  private headPitch = 0;
  private headRoll = 0;
  /** last `interiorWeight` published to the target, so we only call on change */
  private interiorSent = -1;
  /** last `settings.cameraView` acted on, so other settings edits don't re-apply */
  private appliedView: CameraModeId | null = null;

  private readonly lastTargetPos = new THREE.Vector3();
  private hasLastTargetPos = false;

  private settings: SettingsState = DEFAULT_SETTINGS;
  private lastInput: InputState | null = null;
  /** guards the NaN recovery path against recursing */
  private recovering = false;

  /* -------------------------------------------------- preallocated scratch */

  private readonly desired = new THREE.Vector3();
  private readonly err = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly leadDir = new THREE.Vector3();
  private readonly resolved = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3();
  private readonly localOffset = new THREE.Vector3();
  private readonly cockpitEye = new THREE.Vector3();
  private readonly tiltFwd = new THREE.Vector3();
  private readonly tiltRight = new THREE.Vector3();
  private readonly tiltUp = new THREE.Vector3();
  private readonly qYaw = new THREE.Quaternion();
  private readonly qFrame = new THREE.Quaternion();
  private readonly qFrameInv = new THREE.Quaternion();
  private readonly qLocal = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly mat = new THREE.Matrix4();
  private readonly viewSize = new THREE.Vector2();

  private readonly unsubscribers: Array<() => void> = [];
  private resizeBound: (() => void) | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    target: CameraTarget,
    physics: PhysicsWorldAPI | null,
    bus: EventBus,
  ) {
    this.camera = camera;
    this.target = target;
    this.physics = physics;
    this.shake = new CameraShake(bus);

    copyModeParams(CAMERA_MODES.chase, this.params);
    this.fovCurrent = CAMERA_MODES.chase.fovBase;
    this.eye.copy(camera.position);
    this.look.copy(camera.position).add(scratch.v1.set(0, 0, -10).applyQuaternion(camera.quaternion));

    // A respawn teleports the chassis across the district; without this the rig
    // would interpolate the whole way and the player would watch the city fly
    // past for half a second.
    this.unsubscribers.push(
      bus.on('vehicle:reset', () => {
        this.snapToTarget();
      }),
    );

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.resizeBound = (): void => {
        const h = Math.max(1, window.innerHeight);
        this.setAspect(window.innerWidth / h);
      };
      window.addEventListener('resize', this.resizeBound);
    }
  }

  /* ------------------------------------------------------------ public API */

  /** Retarget the rig (vehicle swap, spectator hand-off). Does not snap. */
  setTarget(target: CameraTarget): void {
    // The outgoing vehicle must not be left holding a lit cockpit it can no
    // longer see out of — that is a permanent leak of geometry into the scene.
    if (this.target !== target) this.target?.setInteriorAmount?.(0);
    this.target = target;
    this.hasLastTargetPos = false;
    this.interiorSent = -1;
  }

  /** Late-bound physics — the world is created asynchronously. */
  setPhysics(physics: PhysicsWorldAPI | null): void {
    this.physics = physics;
    this.collisionDist = Infinity;
  }

  get mode(): CameraModeId {
    return this.modeId;
  }

  get isShowcase(): boolean {
    return this.showcaseActive;
  }

  /** Current vertical field of view in degrees (already eased). */
  get fov(): number {
    return this.fovCurrent;
  }

  /**
   * Scales the whole rig — pivot height, follow distance and ride height — for
   * vehicles much larger than the Jeep the tuning was authored against. An 11m
   * party bus at scale 1 puts the camera on its roof.
   */
  private rigScale = 1;

  /** Size the rig to the vehicle. 1 = the Jeep; ~2 suits the bus. */
  setRigScale(scale: number): void {
    this.rigScale = clamp(scale, 0.5, 4);
  }

  /** Current pivot→eye distance in metres, after collision resolution. */
  get distance(): number {
    return this.eye.distanceTo(this.anchor);
  }

  /** 0 = clear, 1 = the rig is fully jammed against geometry. For debug/HUD. */
  get blockedAmount(): number {
    return this.blockedBlend;
  }

  /**
   * 0..1 speed-effect drive for the fx module: radial blur strength, chromatic
   * aberration, speed-line opacity. Combines raw speed, boost and drift, and is
   * eased on the same clock as the FOV so the two never disagree.
   * The camera renders none of this itself.
   */
  get speedBlurAmount(): number {
    return this._speedBlur;
  }

  /**
   * 0..1 normalised FOV kick: how far the live FOV sits above the current
   * mode's resting FOV, relative to the maximum this mode can reach with every
   * kick stacked. Use it to drive aberration/vignette punch that should track
   * the *lens*, not the speedometer.
   */
  get fovKick(): number {
    return this._fovKick;
  }

  /**
   * The solved rig position, *before* shake and handheld sway are applied.
   * Copy-out, no allocation. This — not `camera.position` — is what an audio
   * listener or a spatial-audio panner should follow: a listener that shakes
   * with the camera smears every positional sound on impact.
   */
  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.eye);
  }

  /** Convenience passthrough so gameplay can shake without reaching for `.shake`. */
  addTrauma(amount: number): void {
    this.shake.addTrauma(amount);
  }

  /**
   * Change view. `immediate` skips the blend — use it on state transitions,
   * never in response to a button, where the blend *is* the feedback.
   */
  setMode(id: CameraModeId, immediate = false): void {
    if (id === this.modeId) return;
    // Freeze the currently-blended params as the "from" pose, so pressing the
    // view button twice quickly blends from where the rig actually is rather
    // than snapping back to the preset it was leaving.
    this.useFrozenFrom = !immediate && this.modeBlend < 1;
    if (this.useFrozenFrom) copyModeParams(this.params, this.frozenFrom);
    this.prevModeId = this.modeId;
    this.modeId = id;
    this.modeBlend = immediate ? 1 : 0;
    if (!this.showcaseActive && id !== 'showcase') this.modeBeforeShowcase = id;
    // Publish, so the settings menu shows the view the player is actually in
    // rather than the one they last picked from a list.
    if (id !== 'showcase') cameraViewChannel.current = id;
  }

  /** Advance to the next player-facing view. Ignored while in showcase. */
  cycleMode(): void {
    if (this.showcaseActive) return;
    this.setMode(nextCameraMode(this.modeId));
  }

  /**
   * Slow orbiting turntable for the title screen and the garage.
   *
   * The orbit does not use a separate code path: it substitutes the orbit angle
   * for the rig heading and (optionally) the showcase object for the pivot, and
   * then runs the ordinary solver. That means entering and leaving showcase is
   * eased by the same dampers as everything else — no cuts, no special-casing.
   * It runs on unpaused wall-clock time so it keeps turning behind a menu.
   */
  setShowcase(enabled: boolean, target?: THREE.Object3D): void {
    if (enabled) {
      this.showcaseObject = target ?? null;
      if (!this.showcaseActive) {
        this.modeBeforeShowcase = this.modeId === 'showcase' ? this.modeBeforeShowcase : this.modeId;
        this.showcaseActive = true;
        this.setMode('showcase');
      }
    } else if (this.showcaseActive) {
      this.showcaseActive = false;
      this.showcaseObject = null;
      this.setMode(this.modeBeforeShowcase);
    }
  }

  /**
   * Collapse every smoother onto its target immediately. Call after a respawn,
   * a teleport, or any state transition that moves the vehicle discontinuously.
   * Safe to call before `init` and outside the frame loop.
   */
  snapToTarget(): void {
    this.collisionDist = Infinity;
    this.recoverHold = 0;
    this.blockedRaw = 0;
    this.blockedBlend = 0;
    this.anchorInitialised = false;
    this.hasLastTargetPos = false;
    this.shake.reset();
    this.solve(0, 0, this.settings, this.lastInput, true);
  }

  /** Window/viewport aspect changed. Idempotent and allocation-free. */
  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    if (Math.abs(this.camera.aspect - aspect) < 1e-6) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /* --------------------------------------------------------------- System */

  init(ctx: GameContext): void {
    this.settings = ctx.settings;
    this.lastInput = ctx.input ?? null;
    if (ctx.renderer && typeof ctx.renderer.getSize === 'function') {
      ctx.renderer.getSize(this.viewSize);
      if (this.viewSize.y > 0) this.setAspect(this.viewSize.x / this.viewSize.y);
    }
    // Restore the persisted view before the first frame is solved, so a player
    // who plays in the cockpit boots into the cockpit rather than watching the
    // rig dive into it half a second after the shift starts.
    this.applyViewSetting(ctx.settings, true);
    this.installTestHook();
    this.snapToTarget();
  }

  /**
   * All camera work happens here, after `update`, so it reads the final vehicle
   * transform for this frame rather than last frame's.
   */
  lateUpdate(ctx: GameContext, dt: number): void {
    this.settings = ctx.settings;
    this.lastInput = ctx.input ?? null;

    const input = this.lastInput;
    if (input) {
      if (input.cameraPressed) this.cycleMode();
    }

    /* A view asked for by the UI wins over the persisted default, and is
     * edge-consumed so it can never fight the player's own button press.
     *
     * `appliedView` is deliberately NOT written here. It records the last
     * value of `settings.cameraView` this rig acted on, and nothing else —
     * stamping the *request* into it made the very next frame's
     * `applyViewSetting` see a difference between the stored default (still
     * 'chase') and `appliedView` ('cockpit') and immediately switch back. The
     * live symptom was a cockpit that flickered in for two frames and
     * vanished, which is exactly as confusing to debug as it sounds. */
    const requested = cameraViewChannel.requested;
    if (requested !== null) {
      cameraViewChannel.requested = null;
      if (!this.showcaseActive) this.setMode(requested);
    } else {
      this.applyViewSetting(ctx.settings, false);
    }

    this.solve(dt, ctx.rawDt, ctx.settings, input, false);
  }

  /**
   * Adopt `settings.cameraView` when — and only when — it *changes*.
   *
   * Watching for a change rather than asserting the value every frame is what
   * lets the `V` key and the menu coexist: cycling the view with the button
   * leaves the stored default alone, and editing an unrelated setting (which
   * hands the camera a whole new frozen `SettingsState`) does not yank the
   * player back out of the cockpit.
   */
  private applyViewSetting(settings: SettingsState, immediate: boolean): void {
    const want = settings.cameraView;
    if (!isCyclableCameraView(want) || want === this.appliedView) return;
    this.appliedView = want;
    if (this.showcaseActive) {
      this.modeBeforeShowcase = want;
      return;
    }
    this.setMode(want, immediate);
  }

  /**
   * QA surface. Installed by the rig itself, exactly as `TouchControls` does,
   * because the boot code has no reason to know that a camera is testable.
   */
  private installTestHook(): void {
    if (typeof window === 'undefined') return;
    const self = this;
    window.__locoCam = {
      get mode(): string {
        return self.modeId;
      },
      get interior(): number {
        return self.params.interiorWeight;
      },
      views: () => [...CAMERA_CYCLE],
      request: (v: string) => {
        if (isCyclableCameraView(v)) requestCameraView(v);
      },
      cycle: () => self.cycleMode(),
      pose: () => ({
        x: Number(self.camera.position.x.toFixed(3)),
        y: Number(self.camera.position.y.toFixed(3)),
        z: Number(self.camera.position.z.toFixed(3)),
        fov: Number(self.fovCurrent.toFixed(2)),
        roll: Number(self.roll.toFixed(4)),
        headPitch: Number(self.headPitch.toFixed(4)),
        headRoll: Number(self.headRoll.toFixed(4)),
      }),
      probe: (yawDeg = 0, pitchDeg = 0, limit = 6) => self.probe(yawDeg, pitchDeg, limit),
    };
  }

  /**
   * What is the rig actually looking at?
   *
   * Casts a ray from the live camera position, `yawDeg` right and `pitchDeg`
   * up from where it is pointing, and names what it hits. This exists because
   * "the cockpit view is a black rectangle" is not a debuggable statement and
   * reading the geometry to guess which box is in the way does not converge —
   * the first time this was needed, four separate suspects were wrong and the
   * real occluder was a mesh nobody had considered. One raycast answered it.
   *
   * Debug-only: allocates, walks the whole scene graph, and is reached solely
   * through `window.__locoCam`.
   */
  private probe(
    yawDeg: number,
    pitchDeg: number,
    limit: number,
  ): Array<{ name: string; mat: string; dist: number; mine: boolean; y: number }> {
    const root = this.target?.object3d?.parent ?? this.target?.object3d;
    if (!root) return [];
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(
        (pitchDeg * Math.PI) / 180,
        (yawDeg * Math.PI) / 180,
        0,
        'YXZ',
      ),
    );
    dir.applyQuaternion(this.camera.quaternion);
    root.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(this.camera.position, dir, 0.01, 400);
    const vehicle = this.target.object3d;
    return rc
      .intersectObject(root, true)
      /* Three's raycaster deliberately ignores `visible` — it tests layers and
       * nothing else — so a hidden subtree still reports hits. For a probe whose
       * entire job is "what can I actually see", that is not a detail: the first
       * run of this pointed at a hidden coachman's head and sent the search off
       * in the wrong direction for a while. */
      .filter((h) => {
        let node: THREE.Object3D | null = h.object;
        while (node) {
          if (node.visible === false) return false;
          node = node.parent;
        }
        return true;
      })
      .slice(0, limit)
      .map((h) => {
        let node: THREE.Object3D | null = h.object;
        let mine = false;
        let name = h.object.name;
        while (node) {
          if (node === vehicle) mine = true;
          if (!name && node.name) name = node.name;
          node = node.parent;
        }
        const mat = (h.object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        return {
          name: name || h.object.type,
          /* the material colour identifies an unnamed merged shell instantly */
          mat: mat && mat.color ? `#${mat.color.getHexString()}` : '?',
          dist: Number(h.distance.toFixed(3)),
          mine,
          y: Number(h.point.y.toFixed(2)),
        };
      });
  }

  /**
   * The rig costs one sphere-cast a frame at every tier, so there is nothing to
   * scale down. What matters here is re-reading `settings`: `screenShake`,
   * `cameraSway` and `photosensitiveSafe` all change the rig's behaviour and a
   * settings apply can land between frames.
   */
  onQualityChange(_tier: QualityTier, settings: SettingsState): void {
    this.settings = settings;
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.target?.setInteriorAmount?.(0);
    if (typeof window !== 'undefined' && window.__locoCam) delete window.__locoCam;
    this.shake.dispose();
    if (this.resizeBound && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.resizeBound);
      this.resizeBound = null;
    }
  }

  /* --------------------------------------------------------------- solver */

  /**
   * The whole rig, in one allocation-free pass.
   *
   * @param dtIn    clamped frame delta, seconds (0 while paused)
   * @param rawDtIn unclamped wall-clock delta — drives the showcase orbit only
   * @param snap    collapse every smoother onto its target
   */
  private solve(
    dtIn: number,
    rawDtIn: number,
    settings: SettingsState,
    input: InputState | null,
    snap: boolean,
  ): void {
    const cam = this.camera;
    const t = this.target;
    if (!t) return;

    const dt = clamp(Number.isFinite(dtIn) ? dtIn : 0, 0, SAFETY.maxStep);
    const rawDt = clamp(Number.isFinite(rawDtIn) ? rawDtIn : 0, 0, SHOWCASE.maxStep);

    /* ---- target transform validation ------------------------------------
     * A physics blow-up must not be able to poison the camera. If the chassis
     * transform is not finite we hold the previous frame's pose exactly — a
     * frozen camera is recoverable, a NaN camera is a black screen forever. */
    const tp = t.position;
    const tq = t.quaternion;
    if (
      !tp ||
      !tq ||
      !Number.isFinite(tp.x) ||
      !Number.isFinite(tp.y) ||
      !Number.isFinite(tp.z) ||
      !Number.isFinite(tq.x) ||
      !Number.isFinite(tq.y) ||
      !Number.isFinite(tq.z) ||
      !Number.isFinite(tq.w)
    ) {
      return;
    }

    /* ---- teleport detection --------------------------------------------
     * Cheaper and more reliable than trusting every caller to remember
     * snapToTarget(): if the chassis moved further in one frame than it could
     * possibly have driven, treat it as a cut. */
    let doSnap = snap;
    if (this.hasLastTargetPos && !doSnap) {
      if (this.lastTargetPos.distanceToSquared(tp) > FOLLOW.teleportDistance * FOLLOW.teleportDistance) {
        doSnap = true;
        this.collisionDist = Infinity;
        this.anchorInitialised = false;
      }
    }
    this.lastTargetPos.copy(tp);
    this.hasLastTargetPos = true;

    /* The showcase rig runs on unpaused wall-clock time so the title screen and
     * the garage keep turning behind a pause menu — `ctx.dt` is zero there.
     * Everything else uses the gameplay delta, which freezes the rig on pause
     * exactly as it should. */
    const showcase = this.showcaseActive;
    const step = showcase ? rawDt : dt;

    /* `sdt` drives every damper. An enormous step makes `1 - e^(-rate·sdt)`
     * evaluate to exactly 1, so `snap` collapses all of them without a second
     * code path and without any risk of the two paths diverging. */
    const sdt = doSnap ? 1e3 : step;

    /* ---- mode parameters ------------------------------------------------ */
    if (this.modeBlend < 1) {
      this.modeBlend = doSnap ? 1 : clamp01(this.modeBlend + step / MODE_BLEND_TIME);
      if (this.modeBlend >= 1) this.useFrozenFrom = false;
    }
    const from = this.useFrozenFrom ? this.frozenFrom : CAMERA_MODES[this.prevModeId];
    const p = this.params;
    if (this.modeBlend >= 1) copyModeParams(CAMERA_MODES[this.modeId], p);
    else blendModeParams(from, CAMERA_MODES[this.modeId], smoothstep(this.modeBlend), p);

    if (showcase) {
      this.orbitTime += rawDt;
      this.orbitAngle = wrapAngle(this.orbitAngle + SHOWCASE.orbitSpeed * rawDt);
    }

    /* ---- accessibility scaling ------------------------------------------ */
    const sway = clamp01(Number.isFinite(settings.cameraSway) ? settings.cameraSway : 1);
    /** at sway 0 every rate is multiplied up, so nothing trails or floats */
    const swayRateMul = lerp(SWAY.rigidRateMultiplier, 1, sway);

    /* ---- vehicle state --------------------------------------------------- */
    const speed = Number.isFinite(t.speed) ? Math.max(0, t.speed) : 0;
    const speedNorm = clamp01(speed / SPEED.top);
    const speedCurve = Math.pow(speedNorm, SPEED.curveExponent);
    const fwdSpeed = Number.isFinite(t.forwardSpeed) ? t.forwardSpeed : 0;

    const vel = t.velocity;
    const vx = vel && Number.isFinite(vel.x) ? vel.x : 0;
    const vy = vel && Number.isFinite(vel.y) ? vel.y : 0;
    const vz = vel && Number.isFinite(vel.z) ? vel.z : 0;
    const hSpeed = Math.sqrt(vx * vx + vz * vz);
    const velValid = hSpeed >= SPEED.velocityValid;

    const airborne = t.isAirborne === true;
    const airtime = Number.isFinite(t.airtime) ? Math.max(0, t.airtime) : 0;
    const boosting = t.isBoosting === true;
    const boostFrac = clamp01(Number.isFinite(t.boostFraction) ? t.boostFraction : 0);
    const wheels = clamp(Number.isFinite(t.wheelsOnGround) ? t.wheelsOnGround : 4, 0, 4);

    /* ---- headings --------------------------------------------------------
     * Yaw convention: forward = R_y(yaw)·(0,0,-1) = (-sin yaw, 0, -cos yaw),
     * so yaw = atan2(-f.x, -f.z). Positive yaw is counter-clockwise seen from
     * above, which makes a right-hand turn a *decreasing* yaw. */
    const carYaw = this.extractYaw(tq);
    const velYaw = velValid ? Math.atan2(-vx / hSpeed, -vz / hSpeed) : carYaw;

    /* ---- drift blend -----------------------------------------------------
     * `slip` is the signed shortest rotation from where the nose points to
     * where the car is actually going. Right-hand drift → nose right of travel
     * → travel is CCW of nose → slip > 0.
     *
     * The gate is the important part. Two states produce a large |slip| that
     * must NOT be interpreted as a drift:
     *   - reversing, where slip ≈ π and blending would swing the camera around
     *     to the front of the car;
     *   - spinning out (> ~75°), where the car is no longer travelling in any
     *     meaningful direction and following the velocity would whip the rig
     *     through a full revolution.
     * In both cases the blend decays to zero over `releaseRate` and the rig
     * simply sits behind the nose, which is exactly what you want while
     * reversing out of an alley or recovering from a spin. */
    const slipRaw = angleDelta(carYaw, velYaw);
    const gate =
      velValid && fwdSpeed > DRIFT.minForwardSpeed && Math.abs(slipRaw) < DRIFT.maxSlip && !showcase;
    const driftTarget = gate ? (t.isDrifting === true ? 1 : DRIFT.passiveWeight) : 0;
    this.driftBlend = damp(
      this.driftBlend,
      driftTarget,
      driftTarget > this.driftBlend ? DRIFT.engageRate : DRIFT.releaseRate,
      sdt,
    );

    /* The vehicle's own `driftAngle` is authoritative — it knows tyre slip, not
     * just chassis-versus-velocity — so it drives the *magnitude* of the ramp.
     * The *sign* comes from our own measurement, which is always well-defined
     * and can never disagree with the geometry the camera is actually framing. */
    const reportedSlip = Number.isFinite(t.driftAngle) ? Math.abs(t.driftAngle) : 0;
    const slipMag = Math.min(DRIFT.maxSlip, Math.max(Math.abs(slipRaw), gate ? reportedSlip : 0));
    const slipSigned = clamp(slipRaw, -DRIFT.maxSlip, DRIFT.maxSlip);

    /* Per-context scaling of the whole drift effect. Airborne slip is
     * meaningless, look-back wants a stable frame, and the mode/accessibility
     * scalars apply on top. The sway floor keeps *some* drift framing at
     * cameraSway 0 because it is gameplay-readability, not decoration. */
    const driftScale =
      p.driftScale *
      lerp(SWAY.driftFloor, 1, sway) *
      lerp(1, AIR.driftScale, this.airBlend) *
      lerp(1, LOOK_BACK.driftScale, this.lookBackAmount);

    /* k ∈ [0, blendMax]: the fraction of the slip angle the camera swings
     * toward the travel direction. Ramping k with |slip| makes the offset
     * super-linear, hence the explicit clamp on the result. */
    const k =
      DRIFT.blendMax *
      smoothstep(invLerp(DRIFT.slipStart, DRIFT.slipFull, slipMag)) *
      this.driftBlend *
      driftScale;
    const driftYaw = clamp(slipSigned * k, -DRIFT.yawOffsetMax, DRIFT.yawOffsetMax);
    /** 0..1 "how hard are we drifting", for FOV/blur/pull-back */
    const driftStrength = clamp01(
      (slipMag <= DRIFT.slipStart ? 0 : invLerp(DRIFT.slipStart, DRIFT.slipFull, slipMag)) *
        this.driftBlend,
    );

    /* ---- airborne blend --------------------------------------------------
     * Ramped by airtime rather than switched on `isAirborne`, so cresting a
     * kerb (30 ms of air) does nothing at all while a real ramp launch opens
     * the framing up over ~0.4 s. */
    const airTarget = airborne ? clamp01(airtime / AIR.rampTime) : 0;
    this.airBlend = damp(
      this.airBlend,
      airTarget,
      airTarget > this.airBlend ? AIR.engageRate : AIR.landRate,
      sdt,
    );

    /* ---- boost blend ---- */
    this.boostBlend = damp(
      this.boostBlend,
      boosting ? 1 : 0,
      boosting ? BOOST.engageRate : BOOST.releaseRate,
      sdt,
    );

    /* ---- look-back -------------------------------------------------------
     * Driven as a 0..1 amount added to the yaw target as `amount · π`, never by
     * damping the yaw *across* the wrap point. That keeps the swing direction
     * deterministic (it can't take the short way out and the long way back) and
     * makes the return trip retrace the outbound arc exactly. */
    const wantsBack = input?.lookBack === true && !showcase;
    this.lookBackAmount = damp(
      this.lookBackAmount,
      wantsBack ? 1 : 0,
      wantsBack ? LOOK_BACK.engageRate : LOOK_BACK.releaseRate,
      sdt,
    );

    /* ---- rig heading ---- */
    let yawTarget = carYaw + driftYaw;
    if (this.airBlend > 0.001 && velValid) {
      /* In the air the chassis can barrel-roll and spin freely; following its
       * yaw spins the whole world and is genuinely sickening. Rotate the target
       * toward the velocity heading instead — the horizon stays put and the
       * landing stays framed. Interpolated through `angleDelta` so it always
       * takes the short arc. */
      yawTarget += angleDelta(yawTarget, velYaw) * (this.airBlend * AIR.yawToVelocity);
    }
    yawTarget += this.lookBackAmount * Math.PI;
    if (showcase) yawTarget = this.orbitAngle;

    /* ---- rate scaling ---- */
    const rateScale =
      p.rateScale *
      swayRateMul *
      (1 + speedNorm * FOLLOW.speedTighten) *
      lerp(1, AIR.easeRateScale, this.airBlend) *
      lerp(1, LOOK_BACK.rateScale, this.lookBackAmount);

    this.followYaw = wrapAngle(
      this.followYaw + damp(0, angleDelta(this.followYaw, yawTarget), FOLLOW.yaw * rateScale, sdt),
    );

    /* ---- roll ------------------------------------------------------------
     * `rollPerSlipRad` is negative: a positive rotation about the camera's
     * local +Z (which points backwards, out of the screen) rotates the image
     * clockwise, and banking into a right-hand drift (slip > 0) should rotate
     * the horizon counter-clockwise — right wing down, like an aircraft. */
    const rollTarget = showcase
      ? 0
      : clamp(
          slipSigned * DRIFT.rollPerSlipRad * this.driftBlend * driftScale,
          -DRIFT.rollMax,
          DRIFT.rollMax,
        );
    this.roll = damp(this.roll, rollTarget, FOLLOW.roll * rateScale, sdt);

    /* ---- interior weight --------------------------------------------------
     * Published to the target first, so the vehicle's cockpit geometry is
     * already built and visible on the frame the blend starts rather than a
     * frame after it. `interiorSent` makes the call an edge, not a per-frame
     * poke: a vehicle rebuilding a dashboard 60 times a second would be worse
     * than not having one. */
    const interior = clamp01(showcase ? 0 : p.interiorWeight);
    if (Math.abs(interior - this.interiorSent) > 0.002) {
      this.interiorSent = interior;
      this.target.setInteriorAmount?.(interior);
    }

    /* ---- desired offset --------------------------------------------------
     * `externalRig` is 1 for any rig that sits behind the car and 0 for one
     * that sits on it (bumper). It gates the global pull-backs so a bumper cam
     * doesn't slide backwards through the driver every time you boost, and it
     * blends smoothly during a chase↔bumper transition. The interior weight
     * gates it too: a cockpit's fallback `distance` is a small *positive*
     * number (the driver sits behind the pivot), and without this a boost
     * would shove the eye backwards out through the seat. */
    const externalRig = showcase ? 0 : clamp01(p.distance / 2) * (1 - interior);
    let dist =
      p.distance +
      (p.speedPullback * speedCurve +
        p.airDistance * this.airBlend +
        DRIFT.pullback * driftStrength +
        BOOST.pullback * this.boostBlend) *
        externalRig;
    let height = p.height + (p.speedRise * speedCurve - p.airDrop * this.airBlend) * (showcase ? 0 : 1);
    // Bigger vehicle, bigger rig — applied after the speed/air/drift terms so
    // their tuned proportions are preserved rather than re-authored per vehicle.
    dist *= this.rigScale;
    height *= this.rigScale;

    /* Blocked-rig escape hatch: when the collision ray is heavily obstructed,
     * lift and shorten the arm rather than jamming it flat against masonry.
     * Uses last frame's smoothed blocked-ness (one frame of lag, no second
     * cast). Tilting the offset upward re-aims the ray at open sky, which is
     * the only direction guaranteed clear in a 3 m alley. */
    const tight = this.blockedBlend * p.collisionWeight;
    if (tight > 0.001) {
      height += COLLISION.tightLift * tight;
      dist *= lerp(1, COLLISION.tightPullFactor, tight);
    }

    if (showcase) {
      height += Math.sin(this.orbitTime * TAU * SHOWCASE.bobRate) * SHOWCASE.bobAmplitude;
    }

    /* ---- pivot -----------------------------------------------------------
     * The single most important anti-nausea step: low-pass the pivot's world Y.
     * Suspension chatter over adoquín is an 8–20 Hz signal; filtering the rig's
     * *input* here (rather than lagging its output) removes it while leaving
     * real elevation change — hills, ramps, the ramparts — fully tracked. */
    let ax = tp.x;
    let ay = tp.y + PIVOT.height * this.rigScale;
    let az = tp.z;
    if (showcase && this.showcaseObject) {
      this.showcaseObject.getWorldPosition(scratch.v1);
      ax = scratch.v1.x;
      ay = scratch.v1.y + PIVOT.height * this.rigScale;
      az = scratch.v1.z;
    }
    if (doSnap || !this.anchorInitialised) {
      this.anchorY = ay;
      this.anchorInitialised = true;
    } else {
      const yRate =
        lerp(PIVOT.yFilterRate, PIVOT.yFilterRateAir, this.airBlend) *
        swayRateMul *
        lerp(1, PIVOT.interiorRateMultiplier, interior);
      this.anchorY = clamp(
        damp(this.anchorY, ay, yRate, sdt),
        ay - PIVOT.yMaxLag,
        ay + PIVOT.yMaxLag,
      );
    }
    this.anchor.set(ax, this.anchorY, az);

    /* ---- rig frame -------------------------------------------------------
     * Yaw-only by default. `tiltKeep` slerps toward the raw chassis orientation
     * for interior rigs, faded out while looking back (where chassis pitch
     * fights the 180° swing) and partly in the air (where the chassis is
     * tumbling and the rig must not tumble with it). */
    this.qYaw.setFromAxisAngle(AXIS_Y, this.followYaw);
    const tilt = showcase
      ? 0
      : p.tiltKeep * (1 - this.lookBackAmount) * (1 - this.airBlend * 0.5);
    if (tilt > 0.001) this.qFrame.copy(this.qYaw).slerp(tq, tilt);
    else this.qFrame.copy(this.qYaw);
    this.qFrameInv.copy(this.qFrame).invert();

    /* ---- the offset, in the rig frame -------------------------------------
     * Normally this is just the mode's `(lateral, height, distance)`. An
     * interior rig replaces it — proportionally to `interiorWeight` — with the
     * driver's eye point the *vehicle* reported, re-expressed relative to the
     * pivot (which sits `PIVOT.height · rigScale` above the chassis origin).
     *
     * Deliberately NOT multiplied by `rigScale`: the eye point is a real
     * measurement of a real seat in the vehicle's own local metres, not a
     * proportion of a Jeep. Scaling it would put the bus driver 7 m ahead of
     * the windscreen. */
    let offX = p.lateral;
    let offY = height;
    let offZ = dist;
    let eyeLateral = 0;
    if (interior > 0.0001 && this.target.getCockpitEye) {
      const eye = this.target.getCockpitEye(this.cockpitEye);
      if (
        eye &&
        Number.isFinite(eye.x) &&
        Number.isFinite(eye.y) &&
        Number.isFinite(eye.z)
      ) {
        offX = lerp(offX, eye.x, interior);
        offY = lerp(offY, eye.y - PIVOT.height * this.rigScale, interior);
        offZ = lerp(offZ, eye.z, interior);
        eyeLateral = eye.x * interior;
      }
    }

    this.desired.set(offX, offY, offZ).applyQuaternion(this.qFrame).add(this.anchor);

    /* ---- position follow -------------------------------------------------
     * Three independent first-order dampers, expressed in the rig frame:
     *   Z (trailing) — loosest; the camera falling behind under power and
     *     catching up under braking is most of what "speed" feels like.
     *   X (lateral)  — loose; lets the car slide across frame in a direction
     *     change before the rig swings in behind it.
     *   Y (vertical) — stiff; vertical lag reads as bobbing and floating, and
     *     is the classic nausea source. Paired with the pivot low-pass above,
     *     this is smooth input into a tight output.
     *
     * The subtlety, and it is worth spelling out because getting it wrong is
     * invisible until someone plays on a 144 Hz monitor: the thing being chased
     * is *moving*, and `desired` is recomputed from this frame's transform. So
     * `eye - desired` is the error against the position the rig should reach at
     * the *end* of the step, not the start — the desired has already advanced by
     * `v·dt` underneath us. Damping that quantity toward zero has fixed point
     * `v·dt·e^(-r·dt) / (1 - e^(-r·dt))`, which is ~`v/r` only in the limit and
     * is measurably larger at 30 fps than at 144 fps. The camera would literally
     * sit further behind the car on a slower machine.
     *
     * Undoing the re-anchoring (`err += v·dt`) restores the error against the
     * previous desired, and the update becomes the exact solution of
     * `ė = -r·e - v` over the step:
     *
     *     e(t+dt) = e·e^(-r·dt) + T·(1 - e^(-r·dt))  ≡  damp(e, T, r, dt)
     *
     * whose fixed point is exactly `T`. Setting `T = -v/r` reproduces the ideal
     * continuous trail at any frame rate; `feedForward` then scales that trail
     * down per mode. The chase rig keeps half of it, because the lag *is* the
     * sensation of speed. A bumper cam cancels it entirely (`T = 0`) and tracks
     * the bull bar with exactly zero steady-state error at 50 m/s. */
    const rateLat = FOLLOW.lateral * rateScale;
    const rateVert = FOLLOW.vertical * rateScale;
    const rateLong = FOLLOW.longitudinal * rateScale;
    const trailW = 1 - clamp01(p.feedForward);
    scratch.v4.set(vx, vy, vz).applyQuaternion(this.qFrameInv);
    const trailX = clamp((-scratch.v4.x / rateLat) * trailW, -FOLLOW.maxTrail, FOLLOW.maxTrail);
    const trailY = clamp((-scratch.v4.y / rateVert) * trailW, -FOLLOW.maxTrail, FOLLOW.maxTrail);
    const trailZ = clamp((-scratch.v4.z / rateLong) * trailW, -FOLLOW.maxTrail, FOLLOW.maxTrail);

    if (doSnap) {
      // Land directly in the steady state, so a snap is followed by stillness
      // rather than by the rig sliding out to its trail over the next second.
      this.err.set(trailX, trailY, trailZ).applyQuaternion(this.qFrame);
      this.eye.copy(this.desired).add(this.err);
    } else {
      this.err.copy(this.eye).sub(this.desired).applyQuaternion(this.qFrameInv);
      // undo this frame's re-anchoring — see the derivation above
      this.err.x += scratch.v4.x * step;
      this.err.y += scratch.v4.y * step;
      this.err.z += scratch.v4.z * step;
      this.err.x = damp(this.err.x, trailX, rateLat, sdt);
      this.err.y = damp(this.err.y, trailY, rateVert, sdt);
      this.err.z = damp(this.err.z, trailZ, rateLong, sdt);
      this.err.applyQuaternion(this.qFrame);
      this.eye.copy(this.desired).add(this.err);
    }

    /* ---- leash -----------------------------------------------------------
     * Backstop for pathological frames (a 200 ms hitch, a physics warp that
     * slipped under the teleport threshold). Never fires in normal play. */
    const desiredLen = this.desired.distanceTo(this.anchor);
    const maxLen = desiredLen * FOLLOW.leashFactor + FOLLOW.leashSlack;
    this.err.copy(this.eye).sub(this.anchor);
    const eyeLen = this.err.length();
    if (eyeLen > maxLen && eyeLen > SAFETY.epsilon) {
      this.eye.copy(this.anchor).addScaledVector(this.err, maxLen / eyeLen);
    }

    /* ---- FOV -------------------------------------------------------------
     * ~62° at rest to ~86° at top speed, plus boost, air and drift kicks. Eased
     * slowly and deliberately; a snapping FOV is instantly cheap-looking. */
    let fovTarget = showcase ? p.fovBase : lerp(p.fovBase, p.fovMax, speedCurve);
    if (!showcase) {
      fovTarget +=
        FOV.boostKick * this.boostBlend * lerp(FOV.boostKickMeterFloor, 1, boostFrac) * externalRig;
      fovTarget += FOV.airKick * this.airBlend;
      fovTarget += FOV.driftKick * driftStrength;
    }
    fovTarget = clamp(fovTarget, FOV.hardMin, FOV.hardMax);
    this.fovCurrent = clamp(
      damp(this.fovCurrent, fovTarget, FOLLOW.fov * p.rateScale, sdt),
      FOV.hardMin,
      FOV.hardMax,
    );

    const fovSpan = p.fovMax + FOV.boostKick + FOV.airKick + FOV.driftKick - p.fovBase;
    this._fovKick = fovSpan > 0.001 ? clamp01((this.fovCurrent - p.fovBase) / fovSpan) : 0;

    /* ---- shake -----------------------------------------------------------
     * Continuous rumble from boost and from wheels leaving the ground on rough
     * ground; impulses arrive over the bus. Sampled here, applied after the
     * collision solve so the probe can account for it. */
    let rumble = showcase ? 0 : BOOST.rumble * this.boostBlend;
    if (!airborne && !showcase) rumble += ((4 - wheels) / 4) * 0.1 * speedNorm;
    this.shake.setRumble(rumble);
    this.shake.update(
      step,
      settings.screenShake,
      settings.photosensitiveSafe === true,
      p.shakeScale,
      this.eye,
    );

    /* ---- collision -------------------------------------------------------
     * The probe radius is derived from the *live* lens: it is the radius of the
     * circle circumscribing the near-plane rectangle, plus a margin, plus the
     * current shake displacement. If that sphere sweeps the pivot→eye segment
     * cleanly, then no corner of the near plane can be inside geometry — which
     * is the actual guarantee we need, not "the camera origin is outside the
     * wall". */
    if (p.collisionWeight > 0.0001 && this.physics) {
      const probe = this.probeRadius() + this.shake.positionOffset.length();
      this.resolveCollision(step, doSnap, probe, desiredLen);
      if (p.collisionWeight >= 0.9999) this.eye.copy(this.resolved);
      else this.eye.lerp(this.resolved, p.collisionWeight);
    } else {
      this.blockedRaw = 0;
      this.collisionDist = Infinity;
      this.recoverHold = 0;
    }
    this.blockedBlend = damp(
      this.blockedBlend,
      this.blockedRaw,
      this.blockedRaw > this.blockedBlend ? COLLISION.tightEngageRate : COLLISION.tightReleaseRate,
      sdt,
    );

    /* ---- aim point -------------------------------------------------------
     * Look ahead along where the car is *going*, not where it is pointing. At
     * low speed the velocity vector is noise, so the chassis facing carries it;
     * the crossfade completes by ~9 m/s. Reversing pins it to the facing. */
    const velWeight = velValid && fwdSpeed >= 0 ? clamp01(invLerp(SPEED.velocityValid, SPEED.velocityFull, hSpeed)) : 0;
    this.leadDir.set(-Math.sin(carYaw), 0, -Math.cos(carYaw));
    if (velWeight > 0) {
      scratch.v2.set(vx / hSpeed, 0, vz / hSpeed);
      this.leadDir.lerp(scratch.v2, velWeight);
      const l = this.leadDir.length();
      if (l > SAFETY.epsilon) this.leadDir.multiplyScalar(1 / l);
      else this.leadDir.set(-Math.sin(carYaw), 0, -Math.cos(carYaw));
    }

    /* Looking back flips the lead behind the car and shortens it — you want to
     * see what is chasing you, not the horizon beyond it. */
    const lead = (p.lookLead + p.lookLeadSpeed * speedCurve) * lerp(1, -LOOK.leadBackScale, this.lookBackAmount);
    this.lookTarget
      .set(this.anchor.x, this.anchor.y + p.lookHeight, this.anchor.z)
      .addScaledVector(this.leadDir, lead);

    /* A driver sits well off the centreline — 0.66 m in the bus. Aiming at a
     * point on the centreline from there yaws the whole view a couple of
     * degrees toward the middle of the road, which puts the steering wheel
     * visibly off-centre in frame and reads as a broken camera. Sliding the
     * aim point sideways by the same offset makes the view exactly parallel to
     * the vehicle's forward axis. Zero for every external rig. */
    if (eyeLateral !== 0) {
      scratch.v1.set(1, 0, 0).applyQuaternion(this.qFrame);
      this.lookTarget.addScaledVector(scratch.v1, eyeLateral);
    }

    /* Airborne: bias the aim toward the landing, proportional to fall speed, so
     * the horizon sits high and the touchdown point is visible on the way down. */
    if (this.airBlend > 0.001) {
      const fall = clamp(-vy, 0, 60);
      this.lookTarget.y -= Math.min(LOOK.airDropMax, fall * LOOK.airDropPerFallSpeed) * this.airBlend;
    }

    if (doSnap) this.look.copy(this.lookTarget);
    else dampVec3(this.look, this.lookTarget, FOLLOW.look * rateScale, sdt);

    /* ---- borrowed chassis attitude (interior rigs only) -------------------
     * `lookAt` always builds a world-up basis, so on its own no mode can ever
     * roll or pitch the *view* — which is exactly right for a camera hanging
     * behind the car and exactly wrong for one bolted into its dashboard. A
     * cockpit whose head stays gyroscopically level leaves the dash swinging
     * inside the frame on every camber change.
     *
     * Roll: rotating the chassis right-side-down by α maps its local +X to a
     * world vector with `y = -sin α` and its local +Y to `y = cos α`, so
     * `atan2(-r.y, u.y)` recovers α with the right sign through the poles. The
     * camera's compensating roll is `-α`, matching the drift-roll convention
     * documented in `CameraTuning.DRIFT.rollPerSlipRad`: a positive rotation
     * about the camera's local +Z spins the image clockwise, and a right-hand
     * bank must tilt the horizon counter-clockwise.
     *
     * Faded to nothing while airborne (a tumbling chassis has no attitude a
     * driver's inner ear would recognise) and while looking back (where the
     * borrowed roll fights the 180° swing), damped so cobblestones don't reach
     * the head, and hard-clamped so a barrel roll can never spin the view. */
    const aim =
      showcase || this.recovering
        ? 0
        : p.tiltAim *
          (1 - clamp01(this.airBlend * INTERIOR.airFade)) *
          (1 - this.lookBackAmount) *
          lerp(SWAY.driftFloor, 1, sway);
    let pitchTarget = 0;
    let rollTarget2 = 0;
    if (aim > 0.001) {
      this.tiltFwd.set(0, 0, -1).applyQuaternion(tq);
      this.tiltRight.set(1, 0, 0).applyQuaternion(tq);
      this.tiltUp.set(0, 1, 0).applyQuaternion(tq);
      pitchTarget = clamp(
        Math.asin(clamp(this.tiltFwd.y, -1, 1)) * aim,
        -INTERIOR.maxPitch,
        INTERIOR.maxPitch,
      );
      rollTarget2 = clamp(
        -Math.atan2(-this.tiltRight.y, this.tiltUp.y) * aim,
        -INTERIOR.maxRoll,
        INTERIOR.maxRoll,
      );
    }
    this.headPitch = damp(this.headPitch, pitchTarget, INTERIOR.tiltRate * swayRateMul, sdt);
    this.headRoll = damp(this.headRoll, rollTarget2, INTERIOR.tiltRate * swayRateMul, sdt);

    /* ---- orientation ---- */
    scratch.v3.copy(this.look).sub(this.eye);
    if (scratch.v3.lengthSq() < LOOK.minAimDistance * LOOK.minAimDistance) {
      /* Degenerate aim (the rig collapsed onto its own aim point). Re-derive it
       * from the rig's forward axis so `lookAt` can never produce a spin. */
      scratch.v3.set(0, 0, -1).applyQuaternion(this.qFrame).multiplyScalar(LOOK.minAimDistance);
      this.look.copy(this.eye).add(scratch.v3);
    }
    this.mat.lookAt(this.eye, this.look, AXIS_Y);
    cam.quaternion.setFromRotationMatrix(this.mat);

    /* Roll and rotational shake are applied in the camera's *local* frame, so
     * they compose with the aim rather than replacing it. YXZ is the natural
     * order for a camera head: yaw, then pitch, then roll. */
    this.euler.set(
      this.shake.rotationOffset.x + this.headPitch,
      this.shake.rotationOffset.y,
      this.roll + this.headRoll + this.shake.rotationOffset.z,
      'YXZ',
    );
    this.qLocal.setFromEuler(this.euler);
    cam.quaternion.multiply(this.qLocal);

    /* ---- local-space offsets: shake + idle handheld ----------------------
     * Positional shake is scaled down as the rig gets blocked: when the camera
     * is already pinned near a wall, translating it is the one thing that can
     * still punch it through, and rotational shake carries the impact just as
     * well. Applied in camera-local space so shake always reads as screen
     * motion rather than as the camera wandering through the world. */
    this.localOffset.copy(this.shake.positionOffset).multiplyScalar(1 - this.blockedBlend * p.collisionWeight);

    if (sway > 0.001 && !showcase) {
      /* A slow, tiny handheld drift. Peaks at cruising speed and fades at both
       * ends: at a standstill it would look like a bug, and at 50 m/s the FOV
       * and the world are already doing the work. */
      this.noiseTime += step;
      const speedWindow = clamp01(
        1 -
          Math.abs(speedNorm - SWAY.handheldSpeedPeak) /
            Math.max(SWAY.handheldSpeedPeak, 1 - SWAY.handheldSpeedPeak),
      );
      const amp = SWAY.handheldAmplitude * sway * speedWindow;
      if (amp > 0) {
        const nt = this.noiseTime * SWAY.handheldFrequency;
        this.localOffset.x += valueNoise2D(nt, 0.5, HANDHELD_SEED_X) * amp;
        this.localOffset.y += valueNoise2D(nt, 0.5, HANDHELD_SEED_Y) * amp;
      }
    }

    /* Crucially the offsets are applied to the *output* only — `this.eye` stays
     * the clean solved rig position. Folding them back into the rig state would
     * make the next frame's damper start from the shaken pose and add a fresh
     * offset on top, turning a ±3 cm noise signal into an amplified random walk
     * (the damper's DC gain is ~1/(rate·dt), so about 5× at 60 fps). */
    cam.position.copy(this.eye);
    if (this.localOffset.lengthSq() > 0) {
      this.localOffset.applyQuaternion(cam.quaternion);
      cam.position.add(this.localOffset);
    }

    /* ---- speed-effect hooks ---- */
    const blurTarget = clamp01(
      clamp01(invLerp(FX.blurStart, 1, speedNorm)) * FX.blurSpeedWeight +
        this.boostBlend * FX.blurBoostWeight +
        driftStrength * FX.blurDriftWeight,
    );
    this._speedBlur = damp(this._speedBlur, blurTarget, FX.easeRate, sdt);

    /* ---- commit ---- */
    if (Math.abs(cam.fov - this.fovCurrent) > FOV.epsilon) {
      cam.fov = this.fovCurrent;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);

    /* ---- final numerical guard ------------------------------------------
     * Nothing above should be able to produce a non-finite value, but the
     * camera transform is the one piece of state whose corruption is
     * unrecoverable and invisible in a stack trace (the screen simply goes
     * black). One cheap check per frame buys a guaranteed recovery. */
    if (!this.isFinitePose()) this.hardReset();
  }

  /* --------------------------------------------------------------- helpers */

  /**
   * Chassis yaw, robust to gimbal-degenerate orientations.
   *
   * The usual `atan2` on the transformed forward vector fails when the car is
   * pointing straight up or down — mid-backflip off a ramp, which happens
   * constantly in this game. There, the horizontal projection of forward
   * collapses and the yaw is genuinely undefined. The fallback uses the roof
   * direction instead (for a nose-up car the roof points backwards, so
   * `-sign(forward.y) · up` recovers the heading the driver would name), and
   * failing that holds the last valid yaw so the rig never snaps.
   */
  private extractYaw(q: THREE.Quaternion): number {
    const f = scratch.v1.set(0, 0, -1).applyQuaternion(q);
    if (f.x * f.x + f.z * f.z >= SAFETY.yawDegenerateThreshold * SAFETY.yawDegenerateThreshold) {
      this.lastCarYaw = Math.atan2(-f.x, -f.z);
      return this.lastCarYaw;
    }
    const s = f.y >= 0 ? -1 : 1;
    const u = scratch.v2.set(0, 1, 0).applyQuaternion(q).multiplyScalar(s);
    if (u.x * u.x + u.z * u.z >= SAFETY.yawDegenerateThreshold * SAFETY.yawDegenerateThreshold) {
      this.lastCarYaw = Math.atan2(-u.x, -u.z);
    }
    return this.lastCarYaw;
  }

  /**
   * Radius of the sphere that must sweep the pivot→eye segment cleanly.
   *
   * It is the circumradius of the near-plane rectangle (half-height from the
   * live FOV, half-width from the live aspect) plus a margin. Any geometry the
   * sphere misses is provably outside the near plane, which is the guarantee
   * that actually matters — a camera origin 5 cm outside a wall still renders
   * the wall's interior across half the screen.
   */
  private probeRadius(): number {
    const near = this.camera.near > 0 ? this.camera.near : 0.3;
    const fovDeg = clamp(this.fovCurrent, FOV.hardMin, FOV.hardMax);
    const halfH = near * Math.tan(fovDeg * DEG2RAD * 0.5);
    const aspect = Number.isFinite(this.camera.aspect) && this.camera.aspect > 0 ? this.camera.aspect : 1;
    const halfW = halfH * aspect;
    return Math.max(
      COLLISION.probeRadiusMin,
      Math.sqrt(halfW * halfW + halfH * halfH) + COLLISION.probeMargin,
    );
  }

  /**
   * Sphere-cast pivot → eye and clamp the eye onto the cleared segment.
   *
   * Asymmetry, restated because it is the crux of the whole file:
   *
   *   **Pulling in is a hard clamp, never a damper.** Any rate-limited pull-in
   *   means the camera is provably inside geometry for some number of frames,
   *   and in this district that happens every time you clip a corner. There is
   *   no rate that makes it safe, so `collisionDist` is unconditionally
   *   `Math.min`-ed against the cleared distance as the last statement before
   *   the position is written.
   *
   *   **Pushing out is damped and gated.** It is always safe — the cast
   *   re-validates every frame — but very visible. The `recoverDelay` hold is
   *   what kills alley chatter: passing a doorway briefly opens the ray, and
   *   without a hold the rig lunges out and slams back on the next frame.
   *   Requiring ~120 ms of *continuous* clearance means only real openings
   *   recover, while the damped ramp keeps the recovery itself smooth.
   *
   * Worst case (chassis wedged nose-first into a façade, cast reporting a
   * contact at distance 0): the clamp floors at `hardMinDistance`, the reported
   * blocked-ness saturates, and next frame the rig lifts (see `tightLift`),
   * re-aiming the ray at open sky where it always clears.
   */
  private resolveCollision(dt: number, snap: boolean, probe: number, desiredDist: number): void {
    const physics = this.physics;
    if (!physics) {
      this.resolved.copy(this.eye);
      this.blockedRaw = 0;
      return;
    }

    this.rayDir.copy(this.eye).sub(this.anchor);
    const eyeDist = this.rayDir.length();
    if (eyeDist < SAFETY.epsilon) {
      this.resolved.copy(this.eye);
      this.blockedRaw = 0;
      return;
    }
    this.rayDir.multiplyScalar(1 / eyeDist);

    /* The cast must reach past wherever the rig currently is, out to where it
     * *wants* to be. Casting only as far as the pinned-in eye would make the
     * "cleared" distance equal to the distance the camera already sits at, so
     * the recovery damper would have nothing to aim for and the camera would
     * stay jammed against a wall that had already been driven past. */
    const castLen = Math.max(eyeDist, desiredDist) + COLLISION.recoverProbeSlack;

    const hit = physics.spherecast(
      this.anchor,
      this.rayDir,
      probe,
      castLen,
      CAMERA_MASK,
      this.target.body ?? null,
    );

    let safe = castLen;
    if (hit && Number.isFinite(hit.distance)) {
      const floor = Math.min(COLLISION.hardMinDistance, castLen);
      safe = clamp(hit.distance - COLLISION.skin, floor, castLen);
    }

    if (snap || !Number.isFinite(this.collisionDist)) {
      this.collisionDist = safe;
      this.recoverHold = 0;
    } else if (safe < this.collisionDist) {
      this.collisionDist = safe; // immediate, unconditional
      this.recoverHold = COLLISION.recoverDelay;
    } else {
      this.recoverHold -= dt;
      if (this.recoverHold <= 0) {
        this.recoverHold = 0;
        this.collisionDist = damp(this.collisionDist, safe, COLLISION.recoverRate, dt);
      }
    }

    // Hard safety clamp. Whatever the smoothing above did, the cap ends up on
    // the cleared segment.
    if (!(this.collisionDist <= safe)) this.collisionDist = safe;
    if (!(this.collisionDist > 0)) this.collisionDist = Math.min(safe, COLLISION.hardMinDistance);

    // The cap only ever pulls the camera *in*; pushing it out is the position
    // damper's job, so the recovery inherits the rig's easing for free.
    const finalDist = Math.min(eyeDist, this.collisionDist);
    this.resolved.copy(this.anchor).addScaledVector(this.rayDir, finalDist);

    /* Depenetration along the contact normal.
     *
     * Sliding along the ray is not sufficient in one specific case, and it is a
     * case Old San Juan produces constantly: when the *pivot itself* is within
     * the probe radius of a façade — the Jeep nosed into a wall in a 3 m alley —
     * the cast reports contact at distance 0, and the floor at
     * `hardMinDistance` then places the camera 1.15 m along a ray that is
     * already heading into the masonry. No amount of clamping along that ray
     * can help; the ray is the problem.
     *
     * The hit's own surface data fixes it exactly. `(resolved - point)·normal`
     * is the signed clearance from the contact plane; if it is less than the
     * probe radius, pushing along the normal by the shortfall puts the camera
     * precisely on the safe side with no overshoot. Guarded on the normal being
     * unit length, since a physics backend may report a degenerate normal for a
     * deeply-overlapping cast, and clamped so a bad normal cannot launch the
     * camera. */
    if (hit && hit.normal) {
      const n = hit.normal;
      const nLenSq = n.x * n.x + n.y * n.y + n.z * n.z;
      if (nLenSq > 0.5 && nLenSq < 1.5 && hit.point) {
        const clearance =
          (this.resolved.x - hit.point.x) * n.x +
          (this.resolved.y - hit.point.y) * n.y +
          (this.resolved.z - hit.point.z) * n.z;
        if (clearance < probe) {
          const push = Math.min(probe - clearance, probe + COLLISION.hardMinDistance);
          this.resolved.addScaledVector(n, push);
        }
      }
    }

    this.blockedRaw = clamp01(1 - this.collisionDist / Math.max(desiredDist, SAFETY.epsilon));
  }

  private isFinitePose(): boolean {
    const p = this.camera.position;
    const q = this.camera.quaternion;
    return (
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Number.isFinite(p.z) &&
      Number.isFinite(q.x) &&
      Number.isFinite(q.y) &&
      Number.isFinite(q.z) &&
      Number.isFinite(q.w) &&
      Number.isFinite(this.camera.fov) &&
      this.camera.fov > 0
    );
  }

  /**
   * Last-resort recovery: rebuild the pose analytically from the target's raw
   * transform without touching any of the accumulated state, then zero that
   * state. Guarded against recursion — if the target itself is corrupt we park
   * the camera at the world origin rather than loop.
   */
  private hardReset(): void {
    if (this.recovering) return;
    this.recovering = true;

    const t = this.target;
    const preset = CAMERA_MODES[this.modeId];
    const tp = t?.position;
    const valid =
      !!tp && Number.isFinite(tp.x) && Number.isFinite(tp.y) && Number.isFinite(tp.z);

    this.followYaw = 0;
    this.lastCarYaw = 0;
    this.roll = 0;
    this.driftBlend = 0;
    this.airBlend = 0;
    this.boostBlend = 0;
    this.lookBackAmount = 0;
    this.blockedRaw = 0;
    this.blockedBlend = 0;
    this.collisionDist = Infinity;
    this.recoverHold = 0;
    this.headPitch = 0;
    this.headRoll = 0;
    this._speedBlur = 0;
    this._fovKick = 0;
    this.fovCurrent = preset.fovBase;
    this.shake.reset();

    const ax = valid ? tp.x : 0;
    const ay = (valid ? tp.y : 0) + PIVOT.height * this.rigScale;
    const az = valid ? tp.z : 0;
    this.anchor.set(ax, ay, az);
    this.anchorY = ay;
    this.anchorInitialised = true;
    this.eye.set(ax, ay + preset.height, az + preset.distance);
    this.look.set(ax, ay + preset.lookHeight, az - preset.lookLead);
    this.lastTargetPos.set(ax, ay - PIVOT.height * this.rigScale, az);
    this.hasLastTargetPos = valid;

    this.mat.lookAt(this.eye, this.look, AXIS_Y);
    this.camera.quaternion.setFromRotationMatrix(this.mat);
    this.camera.position.copy(this.eye);
    this.camera.fov = this.fovCurrent;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this.recovering = false;
  }
}
