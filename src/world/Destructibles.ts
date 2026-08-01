/**
 * Loco Lift — destructible street furniture.
 *
 * San Viejo is dressed with about three and a half thousand chairs, tables,
 * umbrellas, pots, planters, A-boards, crates, benches and market stalls. Every
 * one of them used to be paint: the Jeep drove straight through a café terrace
 * and nothing happened. This module makes all of them hittable, without paying
 * for three and a half thousand rigid bodies.
 *
 * ## How the pooling works
 *
 * A prop has four states and only ever costs what its state needs:
 *
 *  - **REST** — the overwhelming majority. Pure geometry inside somebody else's
 *    `InstancedMesh` (or inside a merged cluster). Zero physics, zero CPU: the
 *    prop is not even visited by the update loop, because the only thing that
 *    walks props is a query against a 16 m spatial hash.
 *  - **LIVE** — the player is close. A dynamic body is *checked out of a pool*
 *    and parked at the prop's authored transform. Rapier puts it straight to
 *    sleep, so a live prop costs a broad-phase AABB and nothing else until
 *    something touches it. The pool is capped (72 bodies on `high`), handed out
 *    nearest-first, and returned with hysteresis so a prop on the activation
 *    boundary does not thrash.
 *  - **FLYING** — it has just been hit. The body is awake and the prop's
 *    *instance matrix* is rewritten from it every frame, so the thing tumbling
 *    down the street is the same triangles and the same draw call it always
 *    was. No new geometry, no new material, no new draw call.
 *  - **WRECK** — it has come to rest. The body goes back to the pool, the
 *    visual freezes where it landed, and a respawn timer starts. The prop
 *    returns to REST once the timer is up *and* the player is far enough away
 *    to not see it happen, so a long shift never strips the district bare.
 *
 * Merged props (the market stalls, which share one cloth draw call and each
 * carry their own awning colour) cannot be moved instance-by-instance, so they
 * take the other route: on impact their cluster's cull multiplier is set to
 * zero, the shared vertex shader collapses them onto their anchor, and a fat
 * burst of debris covers the moment. See `PropKit.setClusterVisible`.
 *
 * ## Who drives it
 *
 * `PlazaLife` and `StreetDressing` *register* props while they build; the
 * player's `Vehicle` *attaches* and ticks it. The vehicle is the only thing in
 * the game that destroys anything, it is the only thing that has to be close
 * for a prop to matter, and it owns the physics world — so it drives the
 * update. This module imports nothing from `src/vehicle`; the player is passed
 * in through the structural {@link DestructiblePlayer} interface.
 *
 * ## Feedback
 *
 * Every break emits `prop:destroyed`, which five systems already listen for:
 * the floating score popup, the impact sound, the combo chain (and therefore
 * boost), the camera trauma with distance falloff, and the smash challenge
 * counter. Wiring one event lights all five.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { GROUP, type BodyHandle, type PhysicsWorldAPI } from '../physics/PhysicsTypes';
import { setClusterVisible, type ClusterRange, type DressPlacement } from './PropKit';

/* ========================================================================== *
 *  the catalogue
 * ========================================================================== */

/**
 * Every destructible in the district. `wire` is the string that reaches the
 * combo system and the challenge counter — `ComboSystem.propLabel` already
 * knows `chair`, `table`, `planter`, `crate` and `sign`, so those share the
 * good Spanish callouts and the rest fall through to *¡DESTROZO!*.
 */
export interface PropSpec {
  readonly id: string;
  /** emitted as `prop:destroyed.kind` */
  readonly wire: string;
  /** base score; a plastic chair is pocket change, a market stall is a payday */
  readonly points: number;
  /** kg — kept low on purpose, nothing here may slow the player down */
  readonly mass: number;
  /** collider half-extents, metres */
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  /** collider centre above the prop's base, metres */
  readonly cy: number;
  /** impact speed that breaks it rather than shoving it, m/s */
  readonly breakSpeed: number;
  /** debris chips thrown on a break */
  readonly chips: number;
  /** debris colour, sRGB */
  readonly tint: number;
  /** chip size, metres */
  readonly chipSize: number;
  /** `knock` tumbles on a live body; `shatter` collapses in place */
  readonly mode: 'knock' | 'shatter';
  /** seconds before it may come back */
  readonly respawn: number;
}

function spec(s: PropSpec): PropSpec {
  return s;
}

export const PROP_SPECS = {
  chair: spec({
    id: 'chair', wire: 'chair', points: 30, mass: 3,
    hx: 0.26, hy: 0.34, hz: 0.26, cy: 0.4,
    breakSpeed: 2.4, chips: 5, tint: 0xf2efe6, chipSize: 0.1,
    mode: 'knock', respawn: 40,
  }),
  table: spec({
    id: 'table', wire: 'table', points: 70, mass: 8,
    hx: 0.44, hy: 0.38, hz: 0.44, cy: 0.38,
    breakSpeed: 2.6, chips: 7, tint: 0xf2efe6, chipSize: 0.12,
    mode: 'knock', respawn: 46,
  }),
  umbrella: spec({
    id: 'umbrella', wire: 'umbrella', points: 120, mass: 6,
    hx: 0.32, hy: 0.9, hz: 0.32, cy: 0.95,
    breakSpeed: 2.2, chips: 9, tint: 0xd8453a, chipSize: 0.16,
    mode: 'knock', respawn: 55,
  }),
  pot: spec({
    id: 'pot', wire: 'planter', points: 45, mass: 9,
    hx: 0.25, hy: 0.28, hz: 0.25, cy: 0.3,
    breakSpeed: 2.0, chips: 7, tint: 0xb0603c, chipSize: 0.09,
    mode: 'knock', respawn: 42,
  }),
  bigPot: spec({
    id: 'bigPot', wire: 'planter', points: 60, mass: 13,
    hx: 0.34, hy: 0.4, hz: 0.34, cy: 0.42,
    breakSpeed: 2.4, chips: 9, tint: 0xb0603c, chipSize: 0.11,
    mode: 'knock', respawn: 48,
  }),
  palm: spec({
    id: 'palm', wire: 'planter', points: 60, mass: 12,
    hx: 0.31, hy: 0.46, hz: 0.31, cy: 0.48,
    breakSpeed: 2.4, chips: 8, tint: 0x4e7a3a, chipSize: 0.13,
    mode: 'knock', respawn: 50,
  }),
  bush: spec({
    id: 'bush', wire: 'planter', points: 40, mass: 5,
    hx: 0.38, hy: 0.5, hz: 0.38, cy: 0.52,
    breakSpeed: 2.0, chips: 7, tint: 0x5b8a3c, chipSize: 0.14,
    mode: 'knock', respawn: 44,
  }),
  planter: spec({
    id: 'planter', wire: 'planter', points: 130, mass: 34,
    hx: 0.34, hy: 0.3, hz: 0.34, cy: 0.3,
    breakSpeed: 3.6, chips: 10, tint: 0xa9a08c, chipSize: 0.12,
    mode: 'knock', respawn: 60,
  }),
  board: spec({
    id: 'board', wire: 'sign', points: 80, mass: 8,
    hx: 0.34, hy: 0.46, hz: 0.3, cy: 0.46,
    breakSpeed: 2.0, chips: 7, tint: 0x6a5238, chipSize: 0.13,
    mode: 'knock', respawn: 50,
  }),
  crate: spec({
    id: 'crate', wire: 'crate', points: 55, mass: 8,
    hx: 0.3, hy: 0.18, hz: 0.24, cy: 0.18,
    breakSpeed: 2.0, chips: 8, tint: 0xc99a5b, chipSize: 0.1,
    mode: 'knock', respawn: 38,
  }),
  bench: spec({
    id: 'bench', wire: 'bench', points: 170, mass: 46,
    hx: 0.9, hy: 0.4, hz: 0.3, cy: 0.42,
    breakSpeed: 4.5, chips: 12, tint: 0x8a6a44, chipSize: 0.15,
    mode: 'knock', respawn: 70,
  }),
  /**
   * The plaza's kerbside stone planters. They are merged into the shared solid
   * mesh so they cannot tumble instance-by-instance; a stone box would not
   * bounce convincingly anyway, so it stands as solid scenery and then bursts.
   */
  stonePlanter: spec({
    id: 'stonePlanter', wire: 'planter', points: 140, mass: 0,
    hx: 0.34, hy: 0.3, hz: 0.34, cy: 0.3,
    breakSpeed: 3.0, chips: 12, tint: 0xa9a08c, chipSize: 0.13,
    mode: 'shatter', respawn: 75,
  }),
  stall: spec({
    id: 'stall', wire: 'stall', points: 450, mass: 0,
    hx: 1.6, hy: 1.1, hz: 1.05, cy: 1.1,
    breakSpeed: 3.5, chips: 26, tint: 0xe8b23a, chipSize: 0.19,
    mode: 'shatter', respawn: 95,
  }),
} as const satisfies Record<string, PropSpec>;

export type PropSpecId = keyof typeof PROP_SPECS;

/* ========================================================================== *
 *  tuning
 * ========================================================================== */

/** Live-body budget per tier. Everything else is inert geometry. */
const LIVE_BUDGET: Record<QualityTier, number> = {
  low: 28,
  medium: 48,
  high: 72,
  ultra: 96,
};

/** Debris chips in the shared pool per tier. One draw call whatever the count. */
const CHIP_BUDGET: Record<QualityTier, number> = {
  low: 80,
  medium: 160,
  high: 240,
  ultra: 320,
};

/** Props get a body inside this radius … */
const ACTIVATE_R = 34;
/** … and give it back outside this one. The gap is the anti-thrash hysteresis. */
const DEACTIVATE_R = 44;
/** A wreck only pops back when the player is at least this far away. */
const RESPAWN_R = 62;
/** Hard ceiling on the respawn wait, so a camper never sees a bare street. */
const RESPAWN_FORCE_AFTER = 210;

/** Spatial-hash cell, metres. */
const CELL = 16;

/** Seconds between activation rescans, and the distance that forces an early one. */
const RESCAN_INTERVAL = 0.14;
const RESCAN_DISTANCE = 3.5;

/** A knocked prop is given back to the pool once it is this calm … */
const SETTLE_SPEED = 0.55;
/** … for this long, or after `FLY_TIMEOUT` whatever happens. */
const SETTLE_TIME = 0.9;
const FLY_TIMEOUT = 7.5;

/** Metres a body must move from rest before the visual starts following it. */
const DISTURB_DISTANCE = 0.035;

/** Extra impulse per m/s of impact, as a multiple of the prop's own mass. */
const KICK_PER_SPEED = 1.35;
/** Fraction of the kick redirected upward, so props fly rather than skid. */
const KICK_LIFT = 0.55;
/** Random tumble, N·m·s per kg. */
const KICK_SPIN = 0.9;

/** Score bonus at ramming speed, as a fraction of the prop's base points. */
const SPEED_BONUS = 0.6;
const SPEED_BONUS_FULL = 28;

/**
 * Destructibles live in `GROUP.DEBRIS`, not `GROUP.PROP`, and it matters.
 * `GROUP.PROP` is in the chase camera's occlusion mask and in the suspension's
 * ray mask, so a café chair in that group would jerk the camera in every time
 * the Jeep parked near a terrace and pop a wheel every time it clipped one.
 * `GROUP.DEBRIS` is already in the vehicle's, the ground's, the coast's and
 * Piñones' collision masks, so the props collide with everything they should
 * and nothing they should not. `userData.kind` is still `'prop'`, which is what
 * `Vehicle.classifyBody` reads, so `vehicle:collision` still reports `'prop'`.
 */
const PROP_GROUP = GROUP.DEBRIS;
const PROP_MASK = GROUP.WORLD | GROUP.VEHICLE | GROUP.DEBRIS;

/* ========================================================================== *
 *  records
 * ========================================================================== */

const REST = 0;
const LIVE = 1;
const FLYING = 2;
const WRECK = 3;

interface ClusterPart {
  geo: THREE.BufferGeometry;
  range: ClusterRange;
}

interface PropRecord {
  spec: PropSpec;
  owner: object;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  scaleY: number;
  /** instanced visual, or null for a merged-cluster prop */
  mesh: THREE.InstancedMesh | null;
  index: number;
  cluster: ClusterPart[] | null;
  state: number;
  body: BodyHandle | null;
  /** the visual has started following the body */
  disturbed: boolean;
  /** seconds the body has been calm since the break */
  calm: number;
  /** seconds since the break */
  flying: number;
  respawnAt: number;
  brokenAt: number;
}

/** What `Destructibles` needs to know about the thing doing the smashing. */
export interface DestructiblePlayer {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
  readonly speed: number;
  /** chassis collider half-extents, metres */
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly halfHeight: number;
}

export interface DestructiblesAttachOpts {
  scene: THREE.Scene;
  physics: PhysicsWorldAPI;
  bus: EventBus;
  quality: QualityTier;
  player: DestructiblePlayer;
}

/* ========================================================================== *
 *  the system
 * ========================================================================== */

export class Destructibles {
  readonly group = new THREE.Group();

  private props: PropRecord[] = [];
  private grid = new Map<number, number[]>();
  private sealed = false;

  private scene: THREE.Scene | null = null;
  private physics: PhysicsWorldAPI | null = null;
  private bus: EventBus | null = null;
  private player: DestructiblePlayer | null = null;
  private quality: QualityTier = 'high';

  private chips: ChipPool | null = null;

  /* --- body pool --- */
  private free = new Map<string, BodyHandle[]>();
  private created = 0;
  private maxLive = LIVE_BUDGET.high;
  private maxBodies = LIVE_BUDGET.high * 2;
  private liveList: PropRecord[] = [];
  private wreckList: PropRecord[] = [];

  /* --- scheduling --- */
  private time = 0;
  private rescanTimer = 0;
  private readonly lastScanPos = new THREE.Vector3(1e9, 1e9, 1e9);
  private readonly prevPlayer = new THREE.Vector3();
  private hasPrev = false;

  /* --- counters, surfaced for QA --- */
  private _destroyed = 0;
  private _lastKind = '';

  /* --- scratch: nothing below allocates per frame --- */
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpS = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly candidates: number[] = [];
  private readonly candidateDist: number[] = [];
  private readonly candidateOrder: number[] = [];

  constructor() {
    this.group.name = 'loco/destructibles';
  }

  /* ---------------------------------------------------------- registration */

  /**
   * Register a whole `InstancedMesh` as destructible. `list` must be the same
   * placement list the mesh was built from — `dressInstanced` writes instances
   * in list order, so index *i* of the list is instance *i* of the mesh.
   */
  registerInstanced(
    owner: object,
    mesh: THREE.InstancedMesh | null,
    specId: PropSpecId,
    list: readonly DressPlacement[],
    /**
     * Optional merged-geometry spans that belong to the same prop, parallel to
     * `list`. An A-board's frame is instanced but its two painted faces live in
     * the shared sign mesh; both have to leave together.
     */
    clusters?: ReadonlyArray<ClusterPart[] | null>,
  ): void {
    if (!mesh || list.length === 0) return;
    // The matrices are rewritten whenever one of these tumbles.
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // A prop can end up well outside the mesh's authored bounds once it has
    // been launched; widen the sphere so it is never frustum-culled mid-flight.
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 14;
    const s = PROP_SPECS[specId];
    for (let i = 0; i < list.length && i < mesh.count; i++) {
      const it = list[i];
      this.push({
        spec: s,
        owner,
        x: it.x,
        y: it.y,
        z: it.z,
        yaw: it.yaw,
        scale: it.scale ?? 1,
        scaleY: it.scaleY ?? it.scale ?? 1,
        mesh,
        index: i,
        cluster: clusters?.[i] ?? null,
        state: REST,
        body: null,
        disturbed: false,
        calm: 0,
        flying: 0,
        respawnAt: 0,
        brokenAt: 0,
      });
    }
  }

  /**
   * Register one merged prop. `parts` are the cluster spans it occupies across
   * however many per-material meshes it was built into — a market stall is a
   * span of the shared cloth mesh plus a span of the shared sign mesh.
   */
  registerCluster(
    owner: object,
    specId: PropSpecId,
    at: { x: number; y: number; z: number; yaw: number; scale?: number },
    parts: ClusterPart[],
  ): void {
    if (parts.length === 0) return;
    this.push({
      spec: PROP_SPECS[specId],
      owner,
      x: at.x,
      y: at.y,
      z: at.z,
      yaw: at.yaw,
      scale: at.scale ?? 1,
      scaleY: at.scale ?? 1,
      mesh: null,
      index: -1,
      cluster: parts,
      state: REST,
      body: null,
      disturbed: false,
      calm: 0,
      flying: 0,
      respawnAt: 0,
      brokenAt: 0,
    });
  }

  /** Drop everything a layer registered. Called from that layer's `dispose`. */
  unregisterOwner(owner: object): void {
    let touched = false;
    for (const rec of this.props) {
      if (rec.owner !== owner) continue;
      touched = true;
      this.returnBody(rec);
    }
    if (!touched) return;
    this.props = this.props.filter((r) => r.owner !== owner);
    this.liveList = this.liveList.filter((r) => r.owner !== owner);
    this.wreckList = this.wreckList.filter((r) => r.owner !== owner);
    this.sealed = false;
    this.rebuildGrid();
  }

  private push(rec: PropRecord): void {
    this.props.push(rec);
    this.sealed = false;
  }

  private rebuildGrid(): void {
    this.grid.clear();
    for (let i = 0; i < this.props.length; i++) {
      const r = this.props[i];
      const key = cellKey(r.x, r.z);
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(i);
    }
    this.sealed = true;
  }

  /* --------------------------------------------------------------- attach */

  /**
   * Bring the system to life. Safe to call before or after registration — the
   * spatial index is (re)built lazily on the first tick.
   */
  attach(opts: DestructiblesAttachOpts): void {
    this.detach();
    this.scene = opts.scene;
    this.physics = opts.physics;
    this.bus = opts.bus;
    this.player = opts.player;
    this.quality = opts.quality;
    this.maxLive = LIVE_BUDGET[opts.quality];
    this.maxBodies = Math.round(this.maxLive * 1.8);

    this.chips = new ChipPool(CHIP_BUDGET[opts.quality]);
    this.group.add(this.chips.mesh);
    opts.scene.add(this.group);

    this.hasPrev = false;
    this.lastScanPos.set(1e9, 1e9, 1e9);
    installDebugHook(this);
  }

  detach(): void {
    for (const rec of this.props) this.returnBody(rec);
    if (this.physics) {
      for (const list of this.free.values()) {
        for (const b of list) this.physics.removeBody(b);
      }
    }
    this.free.clear();
    this.created = 0;
    this.liveList.length = 0;
    this.wreckList.length = 0;
    this.chips?.dispose();
    this.chips = null;
    this.group.removeFromParent();
    this.group.clear();
    this.scene = null;
    this.physics = null;
    this.bus = null;
    this.player = null;
  }

  /* --------------------------------------------------------------- update */

  /**
   * Activation and the hit test, run on the **fixed step, before the solver**.
   *
   * The ordering is the whole trick. `Vehicle.fixedUpdate` runs before
   * `PhysicsStepper.fixedUpdate`, so a market stall that is about to be hit is
   * already gone by the time Rapier builds its contact manifolds. Ploughing a
   * terrace at 45 m/s therefore reads as an explosion rather than as a wall,
   * and the solver never has to resolve a 1400 kg car against a static box.
   */
  fixedUpdate(dt: number): void {
    const player = this.player;
    if (!player || !this.physics || dt <= 0) return;
    if (!this.sealed) this.rebuildGrid();

    this.time += dt;

    if (!this.hasPrev) {
      this.prevPlayer.copy(player.position);
      this.hasPrev = true;
    }

    this.rescanTimer -= dt;
    if (
      this.rescanTimer <= 0 ||
      this.lastScanPos.distanceToSquared(player.position) > RESCAN_DISTANCE * RESCAN_DISTANCE
    ) {
      this.rescanTimer = RESCAN_INTERVAL;
      this.lastScanPos.copy(player.position);
      this.rescan(player);
    }

    this.sweep(player, dt);
    this.prevPlayer.copy(player.position);
  }

  /**
   * Presentation, run once per frame **after** the solver: the tumbling props
   * copy their bodies, the debris integrates, and wrecks the player has driven
   * away from quietly come back.
   */
  update(dt: number): void {
    if (!this.player || !this.physics || dt <= 0) return;
    this.followBodies(dt);
    this.respawn(this.player);
    this.chips?.update(dt);
  }

  /* ------------------------------------------------------------ activation */

  private rescan(player: DestructiblePlayer): void {
    const px = player.position.x;
    const pz = player.position.z;

    /* --- give back anything that has drifted out of range --- */
    for (let i = this.liveList.length - 1; i >= 0; i--) {
      const rec = this.liveList[i];
      if (rec.state === FLYING) continue;
      const d = Math.hypot(rec.x - px, rec.z - pz);
      if (d <= DEACTIVATE_R) continue;
      this.returnBody(rec);
      rec.state = REST;
      // A prop nudged out of place but never destroyed goes back where it was.
      if (rec.disturbed) {
        rec.disturbed = false;
        this.writeRestMatrix(rec);
      }
      this.liveList.splice(i, 1);
    }

    if (this.liveList.length >= this.maxLive) return;

    /* --- gather everything in range, nearest first --- */
    const cand = this.candidates;
    const dist = this.candidateDist;
    cand.length = 0;
    dist.length = 0;
    const i0 = Math.floor((px - ACTIVATE_R) / CELL);
    const i1 = Math.floor((px + ACTIVATE_R) / CELL);
    const j0 = Math.floor((pz - ACTIVATE_R) / CELL);
    const j1 = Math.floor((pz + ACTIVATE_R) / CELL);
    const r2 = ACTIVATE_R * ACTIVATE_R;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.grid.get(i * 100003 + j);
        if (!list) continue;
        for (const idx of list) {
          const rec = this.props[idx];
          if (rec.state !== REST) continue;
          const dx = rec.x - px;
          const dz = rec.z - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          cand.push(idx);
          dist.push(d2);
        }
      }
    }
    if (cand.length === 0) return;

    // nearest first, so the pool always goes to what the player can actually
    // reach; the list is a few dozen entries, so the sort is free
    const order = this.candidateOrder;
    order.length = 0;
    for (let k = 0; k < cand.length; k++) order.push(k);
    order.sort((a, b) => dist[a] - dist[b]);

    for (const k of order) {
      if (this.liveList.length >= this.maxLive) break;
      const rec = this.props[cand[k]];
      if (!this.checkoutBody(rec)) break;
      rec.state = LIVE;
      rec.disturbed = false;
      this.liveList.push(rec);
    }
  }

  /* ------------------------------------------------------------- the pool */

  private freeList(id: string): BodyHandle[] {
    let list = this.free.get(id);
    if (!list) this.free.set(id, (list = []));
    return list;
  }

  private checkoutBody(rec: PropRecord): boolean {
    const physics = this.physics;
    if (!physics) return false;
    const s = rec.spec;
    if (s.mass <= 0) {
      // `shatter` props are solid scenery until they are hit; a fixed body
      // costs nothing in the solver and never drifts out of its own footprint.
      rec.body = physics.createBody({
        kind: 'static',
        shape: { type: 'box', hx: s.hx, hy: s.hy, hz: s.hz },
        position: this.tmpV.set(rec.x, rec.y + s.cy, rec.z),
        quaternion: this.tmpQ.setFromAxisAngle(UP, rec.yaw),
        friction: 0.8,
        restitution: 0.05,
        group: PROP_GROUP,
        mask: PROP_MASK,
        userData: { kind: 'prop', spec: s.id },
      });
      this.created++;
      return true;
    }

    let body = this.freeList(s.id).pop() ?? null;
    if (!body) {
      if (this.created >= this.maxBodies && !this.evictFree()) return false;
      body = physics.createBody({
        kind: 'dynamic',
        shape: { type: 'box', hx: s.hx, hy: s.hy, hz: s.hz },
        position: this.tmpV.set(rec.x, rec.y + s.cy, rec.z),
        quaternion: this.tmpQ.setFromAxisAngle(UP, rec.yaw),
        mass: s.mass,
        friction: 0.72,
        restitution: 0.18,
        linearDamping: 0.14,
        angularDamping: 0.22,
        group: PROP_GROUP,
        mask: PROP_MASK,
        userData: { kind: 'prop', spec: s.id },
      });
      this.created++;
      rec.body = body;
      return true;
    }

    body.setEnabled(true);
    body.setPosition(this.tmpV.set(rec.x, rec.y + s.cy, rec.z));
    body.setQuaternion(this.tmpQ.setFromAxisAngle(UP, rec.yaw));
    body.setLinearVelocity(ZERO);
    body.setAngularVelocity(ZERO);
    body.userData = { kind: 'prop', spec: s.id };
    rec.body = body;
    return true;
  }

  /** Free one pooled body so a different shape can take its slot. */
  private evictFree(): boolean {
    const physics = this.physics;
    if (!physics) return false;
    let bestKey: string | null = null;
    let bestLen = 0;
    for (const [key, list] of this.free) {
      if (list.length > bestLen) {
        bestLen = list.length;
        bestKey = key;
      }
    }
    if (!bestKey || bestLen === 0) return false;
    const body = this.free.get(bestKey)?.pop();
    if (!body) return false;
    physics.removeBody(body);
    this.created--;
    return true;
  }

  private returnBody(rec: PropRecord): void {
    const body = rec.body;
    if (!body || !this.physics) return;
    rec.body = null;
    if (rec.spec.mass <= 0) {
      // static bodies are not pooled: their shapes are one-offs
      this.physics.removeBody(body);
      this.created--;
      return;
    }
    body.setLinearVelocity(ZERO);
    body.setAngularVelocity(ZERO);
    body.setPosition(this.tmpV.set(0, -900, 0));
    body.setEnabled(false);
    this.freeList(rec.spec.id).push(body);
  }

  /* ---------------------------------------------------------------- sweep */

  /**
   * The hit test. Rapier contacts alone are not enough: at 50 m/s the Jeep
   * covers 0.42 m in a physics step and a café chair is 0.5 m wide, so a
   * contact-only test tunnels. Instead the chassis footprint is swept from last
   * frame's position to this one and every live prop centre is projected into
   * that box. Nothing is ever missed, and no impulse threshold needs tuning.
   */
  private sweep(player: DestructiblePlayer, dt: number): void {
    if (this.liveList.length === 0) return;

    const pos = player.position;
    const prev = this.prevPlayer;
    const travel = Math.hypot(pos.x - prev.x, pos.z - prev.z);
    const speed = player.speed;
    if (speed < 0.4 && travel < 0.02) return;

    this.fwd.set(0, 0, -1).applyQuaternion(player.quaternion);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    this.right.set(this.fwd.z, 0, -this.fwd.x);

    // Centre of the swept box, plus the half-length the travel adds and a
    // small lead so the prop is removed a step *before* the bumper reaches it.
    const cx = (pos.x + prev.x) * 0.5;
    const cz = (pos.z + prev.z) * 0.5;
    const halfLen = player.halfLength + travel * 0.5 + 0.28;
    const halfWide = player.halfWidth + 0.1;
    const reach = Math.hypot(halfLen, halfWide) + 2.0;
    const reach2 = reach * reach;

    for (let i = this.liveList.length - 1; i >= 0; i--) {
      const rec = this.liveList[i];
      if (rec.state !== LIVE) continue;
      const s = rec.spec;

      const dx = rec.x - cx;
      const dz = rec.z - cz;
      if (dx * dx + dz * dz > reach2) continue;

      // vertical gate: never smash something on a roof or under a bridge
      if (Math.abs(rec.y + s.cy - pos.y) > 2.2) continue;

      const propR = Math.max(s.hx, s.hz) * 0.85;
      const along = dx * this.fwd.x + dz * this.fwd.z;
      const side = dx * this.right.x + dz * this.right.z;
      if (Math.abs(along) > halfLen + propR) continue;
      if (Math.abs(side) > halfWide + propR) continue;

      const impact = Math.max(speed, travel / Math.max(dt, 1e-4));
      const inv = 1 / Math.max(0.05, Math.hypot(dx, dz));
      if (impact < s.breakSpeed) {
        // too slow to break it: shove it, and leave it standing
        this.nudge(rec, dx * inv, dz * inv, impact, dt);
        continue;
      }
      this.destroy(rec, dx * inv, dz * inv, impact);
      // A `shatter` prop is finished the instant it breaks; a `knock` prop
      // stays on the live list until its body has stopped tumbling.
      if (s.mode === 'shatter') this.liveList.splice(i, 1);
    }
  }

  /**
   * Below the break speed a prop is shoved rather than smashed. The impulse is
   * metered by `dt` because the overlap persists across frames — a flat impulse
   * would fire sixty times a second and launch a chair the player is merely
   * leaning on.
   */
  private nudge(rec: PropRecord, nx: number, nz: number, impact: number, dt: number): void {
    const body = rec.body;
    if (!body || rec.spec.mass <= 0) return;
    const k = rec.spec.mass * impact * 0.55 * Math.min(1, dt * 12);
    body.wake();
    body.applyImpulse(this.tmpV.set(nx * k, k * 0.18, nz * k));
    rec.disturbed = true;
  }

  /* -------------------------------------------------------------- destroy */

  private destroy(rec: PropRecord, nx: number, nz: number, impact: number): void {
    const s = rec.spec;
    const bonus = 1 + SPEED_BONUS * clamp01(impact / SPEED_BONUS_FULL);
    const points = Math.round(s.points * bonus);

    rec.state = s.mode === 'shatter' ? WRECK : FLYING;
    rec.brokenAt = this.time;
    rec.flying = 0;
    rec.calm = 0;
    rec.respawnAt = this.time + s.respawn;
    this._destroyed++;
    this._lastKind = s.wire;
    this.wreckList.push(rec);

    const atY = rec.y + s.cy;
    // Whatever mode this is, any merged spans it owns leave with it — an
    // A-board's painted faces must not hang in mid-air once the frame is gone.
    this.setClusterOn(rec, false);
    if (s.mode === 'shatter') {
      this.returnBody(rec);
      this.hideInstance(rec);
    } else {
      const body = rec.body;
      if (body) {
        const k = s.mass * (impact * KICK_PER_SPEED + 2.4);
        body.wake();
        body.applyImpulse(
          this.tmpV.set(nx * k, k * KICK_LIFT + s.mass * 2.2, nz * k),
          this.tmpV2.set(rec.x, atY + s.hy * 0.6, rec.z),
        );
        const spin = s.mass * KICK_SPIN * (0.6 + impact * 0.06);
        body.applyTorqueImpulse(
          this.tmpV.set(
            (Math.random() - 0.5) * spin,
            (Math.random() - 0.5) * spin,
            (Math.random() - 0.5) * spin,
          ),
        );
      }
      rec.disturbed = true;
    }

    this.chips?.burst(rec.x, atY, rec.z, nx, nz, impact, s, rec.y);

    // A fresh vector every time: the listeners (score popups, camera trauma,
    // combo chain) may hold on to it for longer than one frame.
    this.bus?.emit('prop:destroyed', {
      at: new THREE.Vector3(rec.x, atY, rec.z),
      kind: s.wire,
      points,
    });
  }

  /* --------------------------------------------------------- visual follow */

  private followBodies(dt: number): void {
    for (let i = this.liveList.length - 1; i >= 0; i--) {
      const rec = this.liveList[i];
      const body = rec.body;
      if (!body) continue;

      if (rec.state === FLYING) {
        rec.flying += dt;
        body.getLinearVelocity(this.tmpV);
        const v = this.tmpV.length();
        if (v < SETTLE_SPEED) rec.calm += dt;
        else rec.calm = 0;
        this.writeBodyMatrix(rec, body);
        if (rec.calm >= SETTLE_TIME || rec.flying >= FLY_TIMEOUT) {
          // leave the wreck lying exactly where it stopped, and hand the body back
          this.returnBody(rec);
          rec.state = WRECK;
          this.liveList.splice(i, 1);
        }
        continue;
      }

      if (rec.state !== LIVE || rec.spec.mass <= 0) continue;

      // An intact prop only starts following its body once something has
      // actually moved it — otherwise every chair in the district would jitter
      // by a millimetre as Rapier settles it onto the pavement.
      if (!rec.disturbed) {
        body.getPosition(this.tmpV);
        const dx = this.tmpV.x - rec.x;
        const dy = this.tmpV.y - (rec.y + rec.spec.cy);
        const dz = this.tmpV.z - rec.z;
        if (dx * dx + dy * dy + dz * dz < DISTURB_DISTANCE * DISTURB_DISTANCE) continue;
        rec.disturbed = true;
      }
      this.writeBodyMatrix(rec, body);
    }
  }

  private writeBodyMatrix(rec: PropRecord, body: BodyHandle): void {
    const mesh = rec.mesh;
    if (!mesh) return;
    body.getPosition(this.tmpV);
    body.getQuaternion(this.tmpQ);
    // the geometry's origin sits at the prop's base; the body is at its centre
    this.tmpV2.set(0, rec.spec.cy, 0).applyQuaternion(this.tmpQ);
    this.tmpV.sub(this.tmpV2);
    this.tmpS.set(rec.scale, rec.scaleY, rec.scale);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    mesh.setMatrixAt(rec.index, this.tmpM);
    mesh.instanceMatrix.needsUpdate = true;
  }

  private writeRestMatrix(rec: PropRecord): void {
    const mesh = rec.mesh;
    if (!mesh) return;
    this.tmpV.set(rec.x, rec.y, rec.z);
    this.tmpQ.setFromAxisAngle(UP, rec.yaw);
    this.tmpS.set(rec.scale, rec.scaleY, rec.scale);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    mesh.setMatrixAt(rec.index, this.tmpM);
    mesh.instanceMatrix.needsUpdate = true;
  }

  private setClusterOn(rec: PropRecord, on: boolean): void {
    if (!rec.cluster) return;
    for (const part of rec.cluster) setClusterVisible(part.geo, part.range, on);
  }

  /** Collapse an instanced prop to nothing — the `shatter` disappearing act. */
  private hideInstance(rec: PropRecord): void {
    const mesh = rec.mesh;
    if (!mesh) return;
    this.tmpM.compose(HIDDEN, IDENTITY, ZERO_SCALE);
    mesh.setMatrixAt(rec.index, this.tmpM);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /* -------------------------------------------------------------- respawn */

  private respawn(player: DestructiblePlayer): void {
    if (this.wreckList.length === 0) return;
    const px = player.position.x;
    const pz = player.position.z;
    for (let i = this.wreckList.length - 1; i >= 0; i--) {
      const rec = this.wreckList[i];
      if (rec.state !== WRECK) continue;
      if (this.time < rec.respawnAt) continue;
      const far = Math.hypot(rec.x - px, rec.z - pz) > RESPAWN_R;
      if (!far && this.time - rec.brokenAt < RESPAWN_FORCE_AFTER) continue;
      this.setClusterOn(rec, true);
      this.writeRestMatrix(rec);
      rec.state = REST;
      rec.disturbed = false;
      this.wreckList.splice(i, 1);
    }
  }

  /* ---------------------------------------------------------------- stats */

  stats(): Record<string, number | string> {
    return {
      props: this.props.length,
      live: this.liveList.length,
      wrecked: this.wreckList.length,
      bodies: this.created,
      pooled: countPooled(this.free),
      destroyed: this._destroyed,
      chips: this.chips ? this.chips.liveCount : 0,
      lastKind: this._lastKind,
      quality: this.quality,
    };
  }

  get destroyedCount(): number {
    return this._destroyed;
  }

  /** Test-only: forget every break so a scripted run can count from zero. */
  resetCounters(): void {
    this._destroyed = 0;
    this._lastKind = '';
  }

  /**
   * The `n` intact props nearest a point. Used by the QA harness to aim a run
   * at a real café terrace instead of guessing a heading, and by nothing else.
   */
  nearestProps(
    x: number,
    z: number,
    n = 8,
    maxDist = 90,
  ): Array<{ kind: string; x: number; y: number; z: number; d: number }> {
    if (!this.sealed) this.rebuildGrid();
    const out: Array<{ kind: string; x: number; y: number; z: number; d: number }> = [];
    for (const rec of this.props) {
      if (rec.state === WRECK) continue;
      const d = Math.hypot(rec.x - x, rec.z - z);
      if (d > maxDist) continue;
      out.push({ kind: rec.spec.id, x: rec.x, y: rec.y, z: rec.z, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, n);
  }
}

/* ========================================================================== *
 *  debris
 * ========================================================================== */

interface Chip {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  spin: number;
  angle: number;
  t: number;
  life: number;
  size: number;
  floor: number;
}

const CHIP_GRAVITY = -24;

/**
 * The shared debris pool: one `InstancedMesh` of small chips, one draw call
 * whatever is breaking. Chips are integrated on the CPU — there are only a
 * couple of hundred of them and they need real spawn positions, which the GPU
 * has no way to know — and they bounce once off the height the prop was
 * standing at before shrinking away.
 *
 * The material is deliberately its own bare `MeshStandardMaterial` rather than
 * a borrowed dressing-kit one: the kit's materials are canvas-textured, which
 * makes them unavailable in a headless harness, and the vertex-shader distance
 * cull they carry is pointless for debris that only ever exists next to the
 * camera. Vertex colours are white; `instanceColor` alone says what broke.
 */
class ChipPool {
  readonly mesh: THREE.InstancedMesh;
  private parts: Chip[] = [];
  private next = 0;
  private live = 0;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;

  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly col = new THREE.Color();

  constructor(count: number) {
    this.geo = chipGeometry();
    this.mat = new THREE.MeshStandardMaterial({
      name: 'loco/propDebris',
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
      envMapIntensity: 0.7,
    });

    const mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    mesh.name = 'destructibles/chips';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.count = count;
    this.mesh = mesh;

    for (let i = 0; i < count; i++) {
      this.parts.push({
        x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 1, az: 0, spin: 0, angle: 0,
        t: 1, life: 1, size: 0.1, floor: -9999,
      });
      this.m.compose(HIDDEN, IDENTITY, ZERO_SCALE);
      mesh.setMatrixAt(i, this.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  get liveCount(): number {
    return this.live;
  }

  /** Throw one prop's worth of debris away from the impact. */
  burst(
    x: number,
    y: number,
    z: number,
    nx: number,
    nz: number,
    impact: number,
    spec: PropSpec,
    floor: number,
  ): void {
    const n = this.parts.length;
    if (n === 0) return;
    const speed = clamp(2.5 + impact * 0.42, 3, 16);
    this.col.setHex(spec.tint, THREE.SRGBColorSpace);
    for (let i = 0; i < spec.chips; i++) {
      const p = this.parts[this.next];
      const slot = this.next;
      this.next = (this.next + 1) % n;
      const spread = 0.55;
      const jx = nx + (Math.random() - 0.5) * spread * 2;
      const jz = nz + (Math.random() - 0.5) * spread * 2;
      const inv = 1 / Math.max(0.2, Math.hypot(jx, jz));
      const v = speed * (0.55 + Math.random() * 0.85);
      p.x = x + (Math.random() - 0.5) * spec.hx * 1.4;
      p.y = y + (Math.random() - 0.5) * spec.hy * 1.4;
      p.z = z + (Math.random() - 0.5) * spec.hz * 1.4;
      p.vx = jx * inv * v;
      p.vy = 2.4 + Math.random() * v * 0.7;
      p.vz = jz * inv * v;
      this.axis
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize();
      p.ax = this.axis.x;
      p.ay = this.axis.y;
      p.az = this.axis.z;
      p.spin = (Math.random() - 0.5) * 22;
      p.angle = Math.random() * 6.283;
      p.t = 0;
      p.life = 1.5 + Math.random() * 1.4;
      p.size = spec.chipSize * (0.55 + Math.random() * 0.85);
      p.floor = floor;
      const c = this.mesh.instanceColor;
      if (c) {
        const shade = 0.72 + Math.random() * 0.42;
        c.setXYZ(slot, this.col.r * shade, this.col.g * shade, this.col.b * shade);
      }
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    const mesh = this.mesh;
    let live = 0;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (p.t >= p.life) {
        this.m.compose(HIDDEN, IDENTITY, ZERO_SCALE);
        mesh.setMatrixAt(i, this.m);
        continue;
      }
      p.t += dt;
      p.vy += CHIP_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.angle += p.spin * dt;
      if (p.y < p.floor + p.size * 0.5) {
        p.y = p.floor + p.size * 0.5;
        if (p.vy < 0) {
          p.vy = -p.vy * 0.32;
          p.vx *= 0.62;
          p.vz *= 0.62;
          p.spin *= 0.5;
        }
      }
      const k = clamp01(p.t / p.life);
      const scale = p.size * (1 - k * k * 0.85);
      this.p.set(p.x, p.y, p.z);
      this.axis.set(p.ax, p.ay, p.az);
      this.q.setFromAxisAngle(this.axis, p.angle);
      this.s.set(scale, scale, scale);
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(i, this.m);
      live++;
    }
    this.live = live;
    mesh.visible = live > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
    this.parts.length = 0;
  }
}

/**
 * A chip: a flat splinter, not a cube. Authored 1×1×1 and scaled per instance,
 * with a white vertex colour so `instanceColor` alone decides what material it
 * broke off.
 */
function chipGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.34, 0.62);
  const count = g.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  col.fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/* ========================================================================== *
 *  helpers
 * ========================================================================== */

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const ZERO = /* @__PURE__ */ new THREE.Vector3(0, 0, 0);
const HIDDEN = /* @__PURE__ */ new THREE.Vector3(0, -9999, 0);
const IDENTITY = /* @__PURE__ */ new THREE.Quaternion();
const ZERO_SCALE = /* @__PURE__ */ new THREE.Vector3(0, 0, 0);

function cellKey(x: number, z: number): number {
  return Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
}

function countPooled(free: Map<string, BodyHandle[]>): number {
  let n = 0;
  for (const list of free.values()) n += list.length;
  return n;
}

/**
 * QA hook. `main.ts` installs `window.__loco` only once boot has finished, and
 * this module attaches during `initSystems`, so it publishes into a shared
 * `window.__locoDebug` bag that the vehicle and the pedestrian system also
 * write to. Read-only, and absent entirely outside a browser.
 */
function installDebugHook(d: Destructibles): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __locoDebug?: Record<string, unknown> };
  const bag = (w.__locoDebug ??= {});
  bag.props = (): Record<string, number | string> => d.stats();
  bag.resetProps = (): void => d.resetCounters();
  bag.nearestProps = (
    x: number,
    z: number,
    n?: number,
    maxDist?: number,
  ): ReturnType<Destructibles['nearestProps']> => d.nearestProps(x, z, n, maxDist);
}

/* ========================================================================== *
 *  the shared instance
 * ========================================================================== */

/**
 * One per page. The dressing layers register into it while the world builds;
 * the player's vehicle attaches to it once physics and the bus exist.
 */
export const destructibles = new Destructibles();
