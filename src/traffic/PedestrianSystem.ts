/**
 * Loco Lift — pedestrians.
 *
 * People on the pavement: walking the sidewalk graph, waiting at the kerb,
 * crossing when it's clear, and gathering in the plazas, outside the cafés and
 * around the market — where some of them dance.
 *
 * ## The two rules that matter
 *
 * 1. **Pedestrians stay on the pavement.** Their logical position is always a
 *    point on the sidewalk graph, and every sidewalk edge is classified at boot
 *    by how much of it lies inside a carriageway. Fully-exposed edges (the long
 *    plaza stitches, the alley centrelines) are removed from the walkable set;
 *    short exposed edges become **crossings**, which are only entered when the
 *    hazard field says the road is clear.
 *
 * 2. **Nobody is ever run over.** This is a comedy beat, not a gore mechanic.
 *    Peds get a `dodge` offset, layered on top of their graph position, which
 *    is driven hard away from the player when he comes at them — and after all
 *    movement a *hard positional constraint* projects anyone still inside the
 *    Jeep's footprint back out of it. They scatter, hop back onto the kerb and
 *    throw their arms up; they never go under the wheels.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { RNG } from '../core/RNG';
import type {
  EdgeSample,
  GameContext,
  POI,
  POIKind,
  QualityTier,
  SettingsState,
  System,
} from '../core/types';
import { clamp, clamp01, damp, wrapAngle } from '../core/MathUtils';
import { GROUP, type BodyHandle, type PhysicsWorldAPI } from '../physics/PhysicsTypes';
import {
  HazardField,
  makeEdgeSample,
  nearestOnGraph,
  type TrafficRoadGraph,
} from './TrafficVehicle';
import {
  CLIP,
  CLIP_RATE,
  PedLook,
  PedestrianKit,
  type PedRole,
} from './PedestrianModel';
import {
  LIMITS,
  PED,
  PED_ANIM,
  PED_CROSS,
  PED_PANIC,
  PED_SPAWN,
} from './TrafficTuning';

/* ============================================================== interfaces */

/** The slice of the world pedestrians need. `World` satisfies this. */
export interface PedWorldRef {
  roads: TrafficRoadGraph;
  sidewalks: TrafficRoadGraph;
  pois: readonly POI[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  groundHeight(x: number, z: number): number;
}

export interface PedPlayerRef {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly speed: number;
  /**
   * Chassis orientation. Optional so any stand-in still satisfies the shape,
   * but supplying it matters: the anti-tunnelling sweep is aligned to *travel*,
   * and a drifting car's bodywork is nowhere near its direction of travel. See
   * {@link PedestrianSystem.enforceClearance}.
   */
  readonly quaternion?: THREE.Quaternion;
}

export interface PedestrianSystemOpts {
  scene: THREE.Scene;
  physics: PhysicsWorldAPI;
  world: PedWorldRef;
  player: PedPlayerRef;
  rng: RNG;
  quality: QualityTier;
  /** shared with `TrafficSystem` so peds can see cars coming */
  hazard?: HazardField | null;
}

/* ================================================================= states */

const PSTATE = {
  WALK: 0,
  IDLE: 1,
  WAIT: 2,
  CROSS: 3,
  FLEE: 4,
  ANCHOR: 5,
} as const;

/* ---------------------------------------------------------------- agent */

class Pedestrian {
  index = -1;
  active = false;
  anchored = false;
  role: PedRole = 'walker';
  readonly look = new PedLook();

  /* graph position (roamers) */
  edge = -1;
  dir = 1;
  s = 0;
  edgeLen = 1;
  entryNode = -1;
  exitNode = -1;
  nextEdge = -1;
  nextDir = 1;

  /* anchored */
  anchorSpot = -1;

  state: number = PSTATE.WALK;
  speed = 0;
  targetSpeed = 0;
  /** widened: scaled per role and jittered per pedestrian */
  baseSpeed: number = PED.walkSpeed;

  readonly pos = new THREE.Vector3();
  readonly graphPos = new THREE.Vector3();
  readonly dodge = new THREE.Vector3();
  heading = 0;
  targetHeading = 0;

  clip: number = CLIP.WALK;
  phase = 0;
  clipRate = 1;

  idleTimer = 0;
  waitTimer = 0;
  panicTimer = 0;
  hopTimer = 0;
  /**
   * Seconds during which the dodge offset is exempt from the `maxDodge` clamp.
   * Set when the hard clearance shoves someone out from under the car: without
   * it the clamp would haul them straight back under the wheels on the next
   * frame while the car is still parked on top of them.
   */
  dodgeHold = 0;
  stuckTimer = 0;
  animTimer = 0;

  /** cached crossing midpoint of `nextEdge`, so the wait test is O(1) */
  crossX = 0;
  crossZ = 0;
  wantsCross = false;

  reset(): void {
    this.active = false;
    this.anchored = false;
    this.edge = -1;
    this.nextEdge = -1;
    this.anchorSpot = -1;
    this.state = PSTATE.WALK;
    this.speed = 0;
    this.dodge.set(0, 0, 0);
    this.dodgeHold = 0;
    this.idleTimer = 0;
    this.waitTimer = 0;
    this.panicTimer = 0;
    this.hopTimer = 0;
    this.stuckTimer = 0;
    this.animTimer = 0;
    this.wantsCross = false;
  }
}

/* ------------------------------------------------------------ anchor spot */

interface AnchorSpot {
  x: number;
  y: number;
  z: number;
  heading: number;
  role: PedRole;
  clip: number;
  occupied: boolean;
}

/* ------------------------------------------------------------- successors */

interface PedSuccessors {
  start: Int32Array;
  edge: Int32Array;
  dir: Int8Array;
  weight: Float32Array;
  /** weight used when leaving a node that sits inside the carriageway */
  weightOnRoad: Float32Array;
}

/* ---------------------------------------------------------------- scratch */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _m1 = new THREE.Matrix4();
const _s1 = new THREE.Vector3();
const _rows = new Float32Array(3);
const _up = new THREE.Vector3(0, 1, 0);

/** Sensor bodies: reported to the near-miss query, but never solid. */
const PED_MASK = GROUP.VEHICLE;

/* ================================================================= system */

export class PedestrianSystem implements System {
  readonly name = 'pedestrians';
  readonly group = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly physics: PhysicsWorldAPI;
  private readonly world: PedWorldRef;
  private readonly walk: TrafficRoadGraph;
  private readonly roads: TrafficRoadGraph;
  private readonly player: PedPlayerRef;
  private readonly rng: RNG;
  private readonly kit: PedestrianKit;
  private hazard: HazardField | null;

  private quality: QualityTier;
  private target = 0;

  private readonly peds: Pedestrian[] = [];
  private readonly free: number[] = [];
  private readonly bodies: Array<BodyHandle | null> = [];
  private readonly bodyPool: BodyHandle[] = [];
  private activeCount = 0;

  /* ---- baked sidewalk data ---- */
  private readonly usable: Uint8Array;
  private readonly crossing: Uint8Array;
  private readonly onRoad: Uint8Array;
  private readonly edgeMid: Float32Array;
  private readonly walkable: number[] = [];
  private succ: PedSuccessors;

  /* ---- gathering ---- */
  private readonly spots: AnchorSpot[] = [];

  private elapsed = 0;
  private spawnCredit = 0;
  private readonly sample: EdgeSample = makeEdgeSample();
  private readonly sample2: EdgeSample = makeEdgeSample();
  private disposed = false;

  /* ---- stats ---- */
  private statHigh = 0;
  private statLow = 0;
  private statPanic = 0;
  /** peds inside the player's swept footprint this frame — must reach zero */
  private statOverlaps = 0;
  /** closest anyone got to the player's centre this frame, metres */
  private statMinPlayerDist = Infinity;
  /** the player's position last frame, for the swept clearance test */
  private readonly prevPlayer = new THREE.Vector3();
  private hasPrevPlayer = false;
  private shoutCooldown = 0;
  /** peds the clearance pass had to push out this frame */
  private worstOverlap = 0;
  /** peds still inside the chassis footprint *after* the push — must be zero */
  private statResidual = 0;
  private worstResidual = 0;
  /**
   * The player's chassis half-extents. The Jeep is 4.2 x 1.84 m; the exclusion
   * box (2.4 x 2.15 half-extents) comfortably contains every roster vehicle, so
   * "outside the exclusion box" implies "outside the bodywork".
   */
  private readonly playerHalfLength = 2.2;
  private readonly playerHalfWidth = 1.0;
  private minEverPlayerDist = Infinity;
  private safetyFrames = 0;
  private statCrossing = 0;
  private statDodged = 0;

  constructor(opts: PedestrianSystemOpts) {
    this.scene = opts.scene;
    this.physics = opts.physics;
    this.world = opts.world;
    this.walk = opts.world.sidewalks;
    this.roads = opts.world.roads;
    this.player = opts.player;
    this.rng = opts.rng.fork(0x9d21);
    this.quality = opts.quality;
    this.hazard = opts.hazard ?? null;

    this.group.name = 'loco/pedestrians';
    this.kit = new PedestrianKit(LIMITS.maxPeds, LIMITS.maxCarts, opts.quality !== 'low');
    this.group.add(this.kit.group);
    this.scene.add(this.group);

    const edges = this.walk.edges;
    const nodes = this.walk.nodes;
    this.usable = new Uint8Array(edges.length);
    this.crossing = new Uint8Array(edges.length);
    this.onRoad = new Uint8Array(nodes.length);
    this.edgeMid = new Float32Array(edges.length * 3);

    this.classifySidewalks();
    this.succ = this.buildSuccessors();
    this.buildAnchors();
    this.placeCarts();

    for (let i = 0; i < LIMITS.maxPeds; i++) {
      const p = new Pedestrian();
      p.index = i;
      this.peds.push(p);
      this.bodies.push(null);
      this.free.push(i);
    }

    this.applyBudget(opts.quality);
  }

  /** Late binding for the hazard field, if traffic is constructed after us. */
  setHazard(h: HazardField | null): void {
    this.hazard = h;
  }

  /* --------------------------------------------------------- classification */

  /**
   * Work out which sidewalk edges are actually walkable.
   *
   * The sidewalk graph puts a hub node in the *centre* of every intersection
   * and hangs spokes off it, so a naive walker would spend its life standing in
   * the road. Here every edge is probed at five points against the carriageway:
   *
   *  - no exposure          → ordinary pavement,
   *  - partial + short      → a **crossing** (wait at the kerb, then hurry),
   *  - heavily exposed      → dropped from the network entirely.
   */
  private classifySidewalks(): void {
    const edges = this.walk.edges;
    const nodes = this.walk.nodes;

    for (let i = 0; i < nodes.length; i++) {
      this.onRoad[i] = this.insideCarriageway(nodes[i].pos, 0.5) ? 1 : 0;
    }

    for (let i = 0; i < edges.length; i++) {
      this.walk.sample(i, 0.5, 0, _v1);
      this.edgeMid[i * 3] = _v1.x;
      this.edgeMid[i * 3 + 1] = _v1.y;
      this.edgeMid[i * 3 + 2] = _v1.z;

      const e = edges[i];
      let exposed = 0;
      const probes = 5;
      for (let k = 0; k < probes; k++) {
        const t = (k + 0.5) / probes;
        this.walk.sample(i, t, 0, _v2);
        if (this.insideCarriageway(_v2, 0.35)) exposed++;
      }
      const frac = exposed / probes;
      if (frac <= 0.001) {
        this.usable[i] = 1;
        this.crossing[i] = 0;
      } else if (frac <= 0.75 && e.length <= 30) {
        this.usable[i] = 1;
        this.crossing[i] = 1;
      } else {
        this.usable[i] = 0;
        this.crossing[i] = 0;
      }
    }

    // never orphan a node: if everything at a node was dropped, keep the
    // shortest edge so a walker can always leave.
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n];
      let any = false;
      for (let k = 0; k < node.edges.length; k++) {
        if (this.usable[node.edges[k]] === 1) {
          any = true;
          break;
        }
      }
      if (any || node.edges.length === 0) continue;
      let best = node.edges[0];
      for (let k = 1; k < node.edges.length; k++) {
        if (edges[node.edges[k]].length < edges[best].length) best = node.edges[k];
      }
      this.usable[best] = 1;
      this.crossing[best] = 1;
    }

    for (let i = 0; i < edges.length; i++) {
      if (this.usable[i] === 1 && this.crossing[i] === 0 && edges[i].length > 3) {
        this.walkable.push(i);
      }
    }
  }

  /** True when `p` sits inside a road carriageway (with a safety inset). */
  private insideCarriageway(p: THREE.Vector3, inset: number): boolean {
    if (!nearestOnGraph(this.roads, p, 40, this.sample2)) return false;
    const half = this.roads.edges[this.sample2.edgeId].width * 0.5;
    return this.sample2.dist < half - inset;
  }

  private buildSuccessors(): PedSuccessors {
    const edges = this.walk.edges;
    const nodes = this.walk.nodes;
    const keys = edges.length * 2;
    const start = new Int32Array(keys + 1);
    const outEdge: number[] = [];
    const outDir: number[] = [];
    const outW: number[] = [];
    const outWRoad: number[] = [];
    const dirVec = new THREE.Vector3();

    for (let key = 0; key < keys; key++) {
      start[key] = outEdge.length;
      const ei = key >> 1;
      if (this.usable[ei] === 0) continue;
      const e = edges[ei];
      const dirFlag = key & 1;
      const exitNode = dirFlag === 0 ? e.b : e.a;
      const node = nodes[exitNode];
      if (!node) continue;

      // bearing back the way we came
      this.walk.tangent(ei, e.a === exitNode ? 0 : 1, dirVec);
      if (e.b === exitNode) dirVec.multiplyScalar(-1);
      const inBearing = Math.atan2(dirVec.z, dirVec.x);

      for (let k = 0; k < node.edges.length; k++) {
        const ce = node.edges[k];
        if (this.usable[ce] === 0) continue;
        const cand = edges[ce];
        const nd = cand.a === exitNode ? 1 : -1;
        this.walk.tangent(ce, cand.a === exitNode ? 0 : 1, dirVec);
        if (cand.b === exitNode) dirVec.multiplyScalar(-1);
        const outBearing = Math.atan2(dirVec.z, dirVec.x);
        const turn = Math.abs(wrapAngle(outBearing - (inBearing + Math.PI)));

        let w: number;
        if (ce === ei) w = 0.05;
        else if (turn < 0.7) w = 1;
        else if (turn < 2.2) w = 0.55;
        else w = 0.12;
        let wRoad = w;
        if (this.crossing[ce] === 1) {
          w *= 0.3;
          // leaving the middle of a junction: getting off the road is the
          // whole point, so the crossing penalty is dropped
          wRoad *= 1.6;
        }
        outEdge.push(ce);
        outDir.push(nd);
        outW.push(w);
        outWRoad.push(wRoad);
      }
    }
    start[keys] = outEdge.length;
    return {
      start,
      edge: Int32Array.from(outEdge),
      dir: Int8Array.from(outDir),
      weight: Float32Array.from(outW),
      weightOnRoad: Float32Array.from(outWRoad),
    };
  }

  /* ------------------------------------------------------------- anchors */

  /** Which roles gather at which kind of place. */
  private rolesFor(kind: POIKind): readonly PedRole[] {
    switch (kind) {
      case 'venue':
        return ['dancer', 'dancer', 'clapper', 'musician', 'talker'];
      case 'plaza':
        return ['dancer', 'clapper', 'sitter', 'talker', 'kid', 'elder', 'vendor', 'musician'];
      case 'market':
        return ['vendor', 'shopper', 'talker', 'shopper', 'clapper'];
      case 'cafe':
      case 'bakery':
        return ['sitter', 'sitter', 'talker', 'shopper'];
      case 'dock':
        return ['tourist', 'tourist', 'vendor', 'talker'];
      case 'gallery':
        return ['talker', 'tourist', 'shopper'];
      case 'lookout':
        return ['tourist', 'talker', 'elder', 'kid'];
      case 'beach':
        return ['tourist', 'kid', 'talker'];
      case 'chapel':
        return ['elder', 'talker', 'walker'];
      default:
        return ['talker', 'walker'];
    }
  }

  private clipFor(role: PedRole): number {
    switch (role) {
      case 'dancer':
        return CLIP.DANCE;
      case 'clapper':
        return CLIP.CLAP;
      case 'musician':
        return CLIP.PLAY;
      case 'vendor':
        return CLIP.VEND;
      case 'sitter':
        return CLIP.SIT;
      case 'talker':
        return CLIP.TALK;
      case 'jogger':
        return CLIP.JOG;
      default:
        return CLIP.IDLE;
    }
  }

  /**
   * Pre-place standing spots around every gathering POI. Each spot is snapped
   * onto real pavement and rejected if it lands in the road.
   */
  private buildAnchors(): void {
    const wanted: POIKind[] = [
      'plaza',
      'venue',
      'market',
      'cafe',
      'bakery',
      'dock',
      'gallery',
      'lookout',
      'beach',
      'chapel',
    ];
    for (const poi of this.world.pois) {
      if (!wanted.includes(poi.kind)) continue;
      const roles = this.rolesFor(poi.kind);
      const count = poi.kind === 'plaza' || poi.kind === 'market' ? 14 : 8;
      for (let i = 0; i < count; i++) {
        const ang = this.rng.next() * Math.PI * 2;
        const rad = poi.radius * (0.35 + this.rng.next() * 0.62);
        _v1.set(poi.pos.x + Math.cos(ang) * rad, poi.pos.y, poi.pos.z + Math.sin(ang) * rad);
        if (!nearestOnGraph(this.walk, _v1, 22, this.sample)) continue;
        if (this.usable[this.sample.edgeId] === 0) continue;
        if (this.crossing[this.sample.edgeId] === 1) continue;
        _v2.copy(this.sample.point);
        // a little scatter off the centreline, then re-check the road
        _v2.x += (this.rng.next() * 2 - 1) * PED_SPAWN.anchorSpread;
        _v2.z += (this.rng.next() * 2 - 1) * PED_SPAWN.anchorSpread;
        if (this.insideCarriageway(_v2, 0.2)) continue;
        const role = roles[this.rng.int(0, roles.length - 1)];
        this.spots.push({
          x: _v2.x,
          y: this.sample.point.y,
          z: _v2.z,
          heading: Math.atan2(-(poi.pos.x - _v2.x), -(poi.pos.z - _v2.z)) + (this.rng.next() - 0.5),
          role,
          clip: this.clipFor(role),
          occupied: false,
        });
      }
    }
  }

  /** Vendor carts: static street furniture beside the market and the piers. */
  private placeCarts(): void {
    const kinds: POIKind[] = ['market', 'plaza', 'dock', 'beach'];
    let n = 0;
    for (const poi of this.world.pois) {
      if (n >= LIMITS.maxCarts) break;
      if (!kinds.includes(poi.kind)) continue;
      for (let attempt = 0; attempt < 8 && n < LIMITS.maxCarts; attempt++) {
        const ang = this.rng.next() * Math.PI * 2;
        const rad = poi.radius * (0.5 + this.rng.next() * 0.45);
        _v1.set(poi.pos.x + Math.cos(ang) * rad, poi.pos.y, poi.pos.z + Math.sin(ang) * rad);
        if (!nearestOnGraph(this.walk, _v1, 20, this.sample)) continue;
        if (this.crossing[this.sample.edgeId] === 1) continue;
        _v2.copy(this.sample.point);
        if (this.insideCarriageway(_v2, 0.1)) continue;
        _q1.setFromAxisAngle(_up, this.rng.next() * Math.PI * 2);
        _s1.set(1, 1, 1);
        _m1.compose(_v2, _q1, _s1);
        this.kit.carts.setMatrixAt(n, _m1);
        n++;
        break;
      }
    }
    this.kit.carts.count = n;
    this.kit.carts.instanceMatrix.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- budget */

  private applyBudget(tier: QualityTier): void {
    this.target = Math.min(LIMITS.maxPeds, QUALITY_BUDGET[tier].pedCount);
  }

  /* ---------------------------------------------------------------- system */

  init(_ctx: GameContext): void {
    this.warmUp(180);
    this.installDebugHook();
  }

  /** Populate the pavements immediately. */
  warmUp(attempts: number): void {
    for (let i = 0; i < attempts; i++) {
      if (this.activeCount >= this.target) break;
      this.trySpawn(null);
    }
  }

  onQualityChange(tier: QualityTier, _settings: SettingsState): void {
    this.quality = tier;
    this.applyBudget(tier);
    this.kit.setCastShadow(tier !== 'low');
    while (this.activeCount > this.target) {
      let worst = -1;
      let worstD = -1;
      for (let i = 0; i < this.peds.length; i++) {
        const p = this.peds[i];
        if (!p.active) continue;
        const d = p.pos.distanceToSquared(this.player.position);
        if (d > worstD) {
          worstD = d;
          worst = i;
        }
      }
      if (worst < 0) break;
      this.despawn(this.peds[worst]);
    }
  }

  update(ctx: GameContext, dtRaw: number): void {
    if (this.disposed) return;
    const dt = Math.min(dtRaw, 0.05);
    this.elapsed += dt;

    this.statPanic = 0;
    this.statCrossing = 0;
    this.statDodged = 0;

    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (p.active) this.step(p, dt);
    }
    this.separate(dt);
    this.enforceClearance();
    this.scatterShout(ctx, dt);
    this.stream(ctx, dt);
    this.writeInstances(ctx, dt);
    this.syncBodies();
  }

  /* ----------------------------------------------------------------- step */

  private step(p: Pedestrian, dt: number): void {
    const player = this.player.position;
    const dx = p.pos.x - player.x;
    const dz = p.pos.z - player.z;
    const dist = Math.hypot(dx, dz);

    /* --- panic --- */
    const panicRadius = Math.min(
      PED_PANIC.maxRadius,
      PED_PANIC.baseRadius + this.player.speed * PED_PANIC.speedRadius,
    );
    if (dist < panicRadius && this.player.speed > PED_PANIC.minSpeed) {
      const pv = this.player.velocity;
      const closing = dist > 1e-3 ? -(pv.x * dx + pv.z * dz) / dist : this.player.speed;
      if (closing > 1.5 || dist < PED_PANIC.clearRadius * 1.6) {
        if (p.panicTimer <= 0) p.hopTimer = PED_PANIC.hopTime;
        p.panicTimer = PED_PANIC.duration;
      }
    }
    if (p.panicTimer > 0) {
      p.panicTimer -= dt;
      p.state = PSTATE.FLEE;
      this.statPanic++;
      // drive the dodge offset away from the player, laterally to his path
      const inv = dist > 1e-3 ? 1 / dist : 0;
      const nx = dx * inv;
      const nz = dz * inv;
      const strength = PED_PANIC.dodgeRate * clamp01(1.6 - dist / Math.max(1, panicRadius));
      p.dodge.x += nx * strength * dt;
      p.dodge.z += nz * strength * dt;
    }
    if (p.hopTimer > 0) p.hopTimer -= dt;

    /* --- movement --- */
    if (p.anchored) {
      this.stepAnchored(p, dt);
    } else {
      this.stepRoaming(p, dt);
    }

    /* --- dodge relaxation --- */
    if (p.dodgeHold > 0) p.dodgeHold -= dt;
    const dodgeLen = Math.hypot(p.dodge.x, p.dodge.z);
    // The clamp keeps people near their graph position — except right after
    // the car has physically shoved them off it, when obeying it would put
    // them straight back under the wheels.
    const cap = p.dodgeHold > 0 ? PED.maxDodgeShoved : PED.maxDodge;
    if (dodgeLen > cap) {
      const k = cap / dodgeLen;
      p.dodge.x *= k;
      p.dodge.z *= k;
    }
    if (p.panicTimer <= 0) {
      const decay = Math.exp(-PED.dodgeRecover * dt);
      p.dodge.x *= decay;
      p.dodge.z *= decay;
    }
    if (dodgeLen > 0.05) this.statDodged++;

    p.pos.set(p.graphPos.x + p.dodge.x, p.graphPos.y, p.graphPos.z + p.dodge.z);

    /* --- facing --- */
    const dh = wrapAngle(p.targetHeading - p.heading);
    p.heading += dh * (1 - Math.exp(-9 * dt));
  }

  private stepAnchored(p: Pedestrian, dt: number): void {
    const spot = this.spots[p.anchorSpot];
    if (!spot) {
      this.despawn(p);
      return;
    }
    p.graphPos.set(spot.x, spot.y, spot.z);
    p.targetHeading = spot.heading;
    if (p.panicTimer > 0) {
      p.clip = CLIP.PANIC;
      p.clipRate = CLIP_RATE[CLIP.PANIC];
      // face away from the player, and *run* — a group outside a café has to
      // scatter as a group, not stand there waving while the Jeep comes through
      p.targetHeading = Math.atan2(-p.dodge.x, -p.dodge.z);
      p.state = PSTATE.FLEE;
      p.speed = Math.min(PED.panicSpeed, p.speed + PED.panicAccel * dt);
    } else {
      p.state = PSTATE.ANCHOR;
      p.clip = spot.clip;
      p.clipRate = CLIP_RATE[spot.clip];
    }
    p.phase = (p.phase + p.clipRate * dt) % 1;
  }

  private stepRoaming(p: Pedestrian, dt: number): void {
    /* --- pick the pace --- */
    let want: number;
    if (p.panicTimer > 0) want = PED.panicSpeed;
    else if (p.state === PSTATE.WAIT) want = 0;
    else if (p.state === PSTATE.IDLE) want = 0;
    else if (p.state === PSTATE.CROSS) want = PED.crossSpeed * PED_CROSS.commitBonusSpeed;
    else if (p.role === 'jogger') want = PED.jogSpeed;
    else want = p.baseSpeed;
    p.targetSpeed = want;

    // a frightened person does not ease up to a run
    const rate = (p.panicTimer > 0 ? PED.panicAccel : PED.accel) * dt;
    if (p.speed < want) p.speed = Math.min(want, p.speed + rate);
    else p.speed = Math.max(want, p.speed - rate * 2);

    /* --- idle timer --- */
    if (p.state === PSTATE.IDLE) {
      p.idleTimer -= dt;
      if (p.idleTimer <= 0) p.state = PSTATE.WALK;
    }

    /* --- waiting at the kerb --- */
    if (p.state === PSTATE.WAIT) {
      p.waitTimer += dt;
      this.statCrossing++;
      if (p.waitTimer > PED_CROSS.minWait && this.crossingSafe(p)) {
        p.state = PSTATE.CROSS;
      } else if (p.waitTimer > PED_CROSS.maxWait) {
        p.state = PSTATE.CROSS; // jaywalk: patience exhausted
      }
    }

    /* --- advance --- */
    if (p.speed > 0.001) {
      p.s += p.speed * dt;
      let guard = 0;
      while (p.s >= p.edgeLen && guard++ < 4) {
        const over = p.s - p.edgeLen;
        if (p.nextEdge < 0) this.chooseNext(p);
        if (p.nextEdge < 0) {
          this.despawn(p);
          return;
        }
        // about to step into the road? stop at the kerb and look
        if (
          this.crossing[p.nextEdge] === 1 &&
          this.onRoad[p.exitNode] === 0 &&
          p.state !== PSTATE.CROSS
        ) {
          p.s = p.edgeLen;
          p.speed = 0;
          p.state = PSTATE.WAIT;
          p.waitTimer = 0;
          this.crossMid(p.nextEdge, p);
          break;
        }
        const wasCrossing = this.crossing[p.edge] === 1;
        this.enterEdge(p, p.nextEdge, p.nextDir, over);
        this.chooseNext(p);
        if (this.crossing[p.edge] === 0 && wasCrossing) p.state = PSTATE.WALK;
        // occasionally stop and look at something
        if (
          p.state === PSTATE.WALK &&
          this.crossing[p.edge] === 0 &&
          this.rng.next() < PED.idleChance
        ) {
          p.state = PSTATE.IDLE;
          p.idleTimer = this.rng.range(PED.idleMin, PED.idleMax);
        }
      }
    }

    /* --- evaluate --- */
    const t = clamp(p.s / Math.max(1e-4, p.edgeLen), 0, 1);
    const tt = p.dir > 0 ? t : 1 - t;
    this.walk.sample(p.edge, tt, 0, p.graphPos);
    this.walk.tangent(p.edge, tt, _v1);
    if (p.dir < 0) _v1.multiplyScalar(-1);
    if (p.speed > 0.05) p.targetHeading = Math.atan2(-_v1.x, -_v1.z);

    /* --- animation --- */
    let clip: number;
    if (p.panicTimer > 0) clip = CLIP.PANIC;
    else if (p.speed > PED.jogSpeed * 0.72) clip = CLIP.JOG;
    else if (p.speed > 0.22) clip = CLIP.WALK;
    else if (p.state === PSTATE.WAIT) clip = CLIP.IDLE;
    else clip = p.role === 'talker' ? CLIP.TALK : CLIP.IDLE;
    p.clip = clip;
    p.clipRate =
      clip === CLIP.WALK || clip === CLIP.JOG
        ? Math.max(0.25, p.speed / PED_ANIM.strideLength)
        : CLIP_RATE[clip];
    p.phase = (p.phase + p.clipRate * dt) % 1;

    /* --- anti-wedge --- */
    if (p.speed < 0.05 && p.state !== PSTATE.IDLE && p.state !== PSTATE.ANCHOR) {
      p.stuckTimer += dt;
      if (p.stuckTimer > PED.stuckTimeout) {
        p.stuckTimer = 0;
        p.state = PSTATE.WALK;
        p.waitTimer = 0;
      }
    } else {
      p.stuckTimer = 0;
    }
  }

  private crossMid(edgeId: number, p: Pedestrian): void {
    p.crossX = this.edgeMid[edgeId * 3];
    p.crossZ = this.edgeMid[edgeId * 3 + 2];
  }

  /** Is it safe to step off the kerb right now? */
  private crossingSafe(p: Pedestrian): boolean {
    const player = this.player.position;
    const pdx = p.crossX - player.x;
    const pdz = p.crossZ - player.z;
    if (pdx * pdx + pdz * pdz < PED_CROSS.safePlayerDistance * PED_CROSS.safePlayerDistance) {
      return false;
    }
    if (this.hazard && this.hazard.at(p.crossX, p.crossZ) > PED_CROSS.safeHazard) return false;
    return true;
  }

  private enterEdge(p: Pedestrian, edgeId: number, dir: number, s: number): void {
    const e = this.walk.edges[edgeId];
    p.edge = edgeId;
    p.dir = dir >= 0 ? 1 : -1;
    p.edgeLen = Math.max(0.4, e.length);
    p.s = clamp(s, 0, p.edgeLen);
    p.entryNode = p.dir > 0 ? e.a : e.b;
    p.exitNode = p.dir > 0 ? e.b : e.a;
    p.nextEdge = -1;
  }

  private chooseNext(p: Pedestrian): void {
    const key = p.edge * 2 + (p.dir > 0 ? 0 : 1);
    const s0 = this.succ.start[key];
    const s1 = this.succ.start[key + 1];
    if (s1 <= s0) {
      // dead end: turn round
      p.nextEdge = p.edge;
      p.nextDir = -p.dir;
      return;
    }
    const onRoad = this.onRoad[p.exitNode] === 1;
    const w = onRoad ? this.succ.weightOnRoad : this.succ.weight;
    let total = 0;
    for (let i = s0; i < s1; i++) total += w[i];
    let r = this.rng.next() * total;
    let chosen = s0;
    for (let i = s0; i < s1; i++) {
      r -= w[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    p.nextEdge = this.succ.edge[chosen];
    p.nextDir = this.succ.dir[chosen];
  }

  /* ------------------------------------------------------------ crowding */

  /** Cheap O(n²) personal-space pass — 140 people is 10 k pairs, ~0.05 ms. */
  private separate(dt: number): void {
    const min = PED.radius * 2;
    const min2 = min * min;
    for (let i = 0; i < this.peds.length; i++) {
      const a = this.peds[i];
      if (!a.active) continue;
      for (let j = i + 1; j < this.peds.length; j++) {
        const b = this.peds[j];
        if (!b.active) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min2 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5 * PED.separation * dt;
        const nx = (dx / d) * push;
        const nz = (dz / d) * push;
        a.dodge.x -= nx;
        a.dodge.z -= nz;
        a.pos.x -= nx;
        a.pos.z -= nz;
        b.dodge.x += nx;
        b.dodge.z += nz;
        b.pos.x += nx;
        b.pos.z += nz;
      }
    }
  }

  /**
   * The hard guarantee. After everything else has moved, project anybody still
   * inside the Jeep's footprint straight back out of it. Nobody is ever run
   * over — they get shoved aside, arms up, and the comedy lands.
   *
   * The exclusion volume is **swept**, from where the player was last frame to
   * where he is now, not a box around his current position. That distinction is
   * the whole safety argument at 50 m/s: at 20 fps the Jeep covers 2.5 m
   * between frames, more than the box is long, so a static test would let a
   * pedestrian pass clean through the car between two samples and pop out
   * behind it. Sweeping the box closes that hole at any frame rate.
   *
   * The projection is always sideways — out through the nearest flank — because
   * pushing someone forwards would shove them *along* the car's path, and
   * pushing them backwards would drag them under it.
   */
  private enforceClearance(): void {
    const player = this.player.position;
    const v = this.player.velocity;
    const speed = this.player.speed;

    if (!this.hasPrevPlayer) {
      this.prevPlayer.copy(player);
      this.hasPrevPlayer = true;
    }

    // Travel direction: prefer the actual step taken, fall back to velocity.
    let fx = this.prevPlayer.x === player.x ? 0 : player.x - this.prevPlayer.x;
    let fz = this.prevPlayer.z === player.z ? 0 : player.z - this.prevPlayer.z;
    let travel = Math.hypot(fx, fz);
    if (travel > 1e-4) {
      fx /= travel;
      fz /= travel;
    } else if (speed > 0.6) {
      fx = v.x / speed;
      fz = v.z / speed;
      travel = 0;
    } else {
      fx = 0;
      fz = 1;
      travel = 0;
    }

    // centre of the swept capsule, and its half-length including the sweep
    const cx = (player.x + this.prevPlayer.x) * 0.5;
    const cz = (player.z + this.prevPlayer.z) * 0.5;
    const halfLen =
      (speed > 0.6 || travel > 0.02 ? PED_PANIC.clearHalfLength : PED_PANIC.clearRadius) +
      travel * 0.5;
    const halfWide = PED_PANIC.clearRadius;
    const cull = (halfLen + halfWide) * (halfLen + halfWide);

    this.statOverlaps = 0;

    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) continue;
      const dx = p.pos.x - cx;
      const dz = p.pos.z - cz;
      if (dx * dx + dz * dz > cull) continue;
      // project into the player's frame
      const along = dx * fx + dz * fz;
      const side = dx * -fz + dz * fx;
      if (Math.abs(along) > halfLen || Math.abs(side) > halfWide) continue;
      this.statOverlaps++;
      // push sideways — the short way out, and never through the car
      const sign = side >= 0 ? 1 : -1;
      const need = halfWide - Math.abs(side) + 0.05;
      const ox = -fz * sign * need;
      const oz = fx * sign * need;
      p.pos.x += ox;
      p.pos.z += oz;
      p.dodge.x += ox;
      p.dodge.z += oz;
      // and let them keep the offset: the dodge clamp must not drag them back
      // under the wheels next frame while the car is still on top of them
      p.dodgeHold = Math.max(p.dodgeHold, PED_PANIC.shoveHold);
      p.panicTimer = Math.max(p.panicTimer, PED_PANIC.duration);
      if (p.hopTimer <= 0) p.hopTimer = PED_PANIC.hopTime;
    }

    this.prevPlayer.copy(player);
    if (this.statOverlaps > this.worstOverlap) this.worstOverlap = this.statOverlaps;

    /* --- second pass: the bodywork itself ---------------------------------
     * The sweep above is aligned to *travel*, which is what stops anyone being
     * tunnelled through between two frames. It is not where the car IS: at
     * eighty degrees of drift the chassis lies almost across its own velocity,
     * and a pedestrian beside the flank sits outside a travel-aligned box while
     * being very much underneath the door. This pass uses the real chassis
     * axes, so the exclusion volume always contains the bodywork whatever the
     * car is doing. */
    let bx = 0;
    let bz = 1;
    const quat = this.player.quaternion;
    if (quat) {
      _v2.set(0, 0, -1).applyQuaternion(quat);
      _v2.y = 0;
      if (_v2.lengthSq() > 1e-8) {
        _v2.normalize();
        bx = _v2.x;
        bz = _v2.z;
      }
    } else {
      bx = fx;
      bz = fz;
    }
    const bodyLen = PED_PANIC.clearHalfLength;
    const bodyWide = PED_PANIC.clearRadius;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) continue;
      const dx = p.pos.x - player.x;
      const dz = p.pos.z - player.z;
      if (dx * dx + dz * dz > (bodyLen + bodyWide) * (bodyLen + bodyWide)) continue;
      const along = dx * bx + dz * bz;
      const side = dx * -bz + dz * bx;
      if (Math.abs(along) > bodyLen || Math.abs(side) > bodyWide) continue;
      this.statOverlaps++;
      const sign = side >= 0 ? 1 : -1;
      const need = bodyWide - Math.abs(side) + 0.05;
      const ox = -bz * sign * need;
      const oz = bx * sign * need;
      p.pos.x += ox;
      p.pos.z += oz;
      p.dodge.x += ox;
      p.dodge.z += oz;
      p.dodgeHold = Math.max(p.dodgeHold, PED_PANIC.shoveHold);
      p.panicTimer = Math.max(p.panicTimer, PED_PANIC.duration);
      if (p.hopTimer <= 0) p.hopTimer = PED_PANIC.hopTime;
    }

    /* --- third pass: the audit --------------------------------------------
     * Nothing moves a pedestrian between here and `writeInstances`, so this is
     * measured on exactly the geometry that will be drawn. `residual` counts
     * anyone still inside the chassis box; by construction it is zero, and the
     * QA harness asserts on it. */
    this.statMinPlayerDist = Infinity;
    let residual = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) continue;
      const dx = p.pos.x - player.x;
      const dz = p.pos.z - player.z;
      const d = Math.hypot(dx, dz);
      if (d < this.statMinPlayerDist) this.statMinPlayerDist = d;
      const along = dx * bx + dz * bz;
      const side = dx * -bz + dz * bx;
      if (Math.abs(along) <= this.playerHalfLength && Math.abs(side) <= this.playerHalfWidth) {
        residual++;
      }
    }
    this.statResidual = residual;
    if (residual > this.worstResidual) this.worstResidual = residual;
    if (this.activeCount > 0 && this.statMinPlayerDist < this.minEverPlayerDist) {
      this.minEverPlayerDist = this.statMinPlayerDist;
    }
    this.safetyFrames++;
    if (this.statOverlaps > this.worstOverlap) this.worstOverlap = this.statOverlaps;
  }

  /**
   * The noise a scattering crowd makes.
   *
   * Comedy needs sound. When enough people panic at once — a terrace emptying,
   * a plaza clearing — one crowd vocalisation is fired at the middle of the
   * group. Heavily rate-limited: this is a punctuation mark, not an ambience
   * bed, and it uses the library's existing `crowdCheer` rather than adding an
   * asset.
   */
  private scatterShout(ctx: GameContext, dt: number): void {
    if (this.shoutCooldown > 0) {
      this.shoutCooldown -= dt;
      return;
    }
    if (this.statPanic < PED_PANIC.shoutMinPeople) return;
    if (this.player.speed < PED_PANIC.shoutMinSpeed) return;
    this.shoutCooldown = PED_PANIC.shoutCooldown;
    _v1.copy(this.player.position);
    ctx.bus.emit('audio:sfx', {
      id: 'crowdCheer',
      at: _v1,
      volume: Math.min(0.5, 0.16 + this.statPanic * 0.03),
      pitch: 1.25 + Math.random() * 0.3,
    });
  }

  /* -------------------------------------------------------------- stream */

  private stream(ctx: GameContext, dt: number): void {
    const player = this.player.position;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) continue;
      if (p.pos.distanceTo(player) > PED_SPAWN.despawnDistance) this.despawn(p);
      else if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.pos.z)) this.despawn(p);
    }

    if (this.activeCount >= this.target) {
      this.spawnCredit = 0;
      return;
    }
    this.spawnCredit += dt * PED_SPAWN.attemptsPerSecond;
    let attempts = Math.min(8, Math.floor(this.spawnCredit));
    this.spawnCredit -= attempts;
    while (attempts-- > 0 && this.activeCount < this.target) {
      this.trySpawn(ctx.camera);
    }
  }

  private trySpawn(_cam: THREE.PerspectiveCamera | null): boolean {
    if (this.free.length === 0) return false;
    const anchoredWanted =
      this.rng.next() < PED_SPAWN.anchoredFraction && this.spots.length > 0;
    return anchoredWanted ? this.spawnAnchored() : this.spawnRoamer();
  }

  private spawnAnchored(): boolean {
    const player = this.player.position;
    for (let attempt = 0; attempt < PED_SPAWN.candidates; attempt++) {
      const si = this.rng.int(0, this.spots.length - 1);
      const spot = this.spots[si];
      if (spot.occupied) continue;
      const d = Math.hypot(spot.x - player.x, spot.z - player.z);
      if (d < PED_SPAWN.minDistance || d > PED_SPAWN.maxDistance) continue;
      const slot = this.free.pop();
      if (slot === undefined) return false;
      const p = this.peds[slot];
      p.reset();
      p.active = true;
      p.anchored = true;
      p.anchorSpot = si;
      p.role = spot.role;
      p.clip = spot.clip;
      p.clipRate = CLIP_RATE[spot.clip];
      p.phase = this.rng.next();
      p.state = PSTATE.ANCHOR;
      p.look.randomise(this.rng, spot.role);
      this.dressForRole(p);
      p.graphPos.set(spot.x, spot.y, spot.z);
      p.pos.copy(p.graphPos);
      p.heading = spot.heading;
      p.targetHeading = spot.heading;
      spot.occupied = true;
      this.activeCount++;
      return true;
    }
    return false;
  }

  private spawnRoamer(): boolean {
    if (this.walkable.length === 0) return false;
    const player = this.player.position;
    for (let attempt = 0; attempt < PED_SPAWN.candidates; attempt++) {
      const edgeId = this.walkable[this.rng.int(0, this.walkable.length - 1)];
      const mx = this.edgeMid[edgeId * 3];
      const mz = this.edgeMid[edgeId * 3 + 2];
      const d = Math.hypot(mx - player.x, mz - player.z);
      if (d < PED_SPAWN.minDistance || d > PED_SPAWN.maxDistance) continue;

      const slot = this.free.pop();
      if (slot === undefined) return false;
      const p = this.peds[slot];
      p.reset();
      p.active = true;
      p.anchored = false;

      const roll = this.rng.next();
      p.role =
        roll < 0.14
          ? 'shopper'
          : roll < 0.3
            ? 'tourist'
            : roll < 0.38
              ? 'kid'
              : roll < 0.46
                ? 'elder'
                : roll < 0.52
                  ? 'jogger'
                  : 'walker';
      p.look.randomise(this.rng, p.role);
      this.dressForRole(p);
      p.baseSpeed =
        (p.role === 'elder' ? 0.78 : p.role === 'kid' ? 1.05 : 1) *
        PED.walkSpeed *
        (1 + (this.rng.next() * 2 - 1) * PED.walkSpread);

      const t = this.rng.range(0.1, 0.9);
      const dir = this.rng.bool() ? 1 : -1;
      const e = this.walk.edges[edgeId];
      const s = dir > 0 ? t * e.length : (1 - t) * e.length;
      this.enterEdge(p, edgeId, dir, s);
      this.chooseNext(p);
      const tt = dir > 0 ? t : 1 - t;
      this.walk.sample(edgeId, tt, 0, p.graphPos);
      this.walk.tangent(edgeId, tt, _v1);
      if (dir < 0) _v1.multiplyScalar(-1);
      p.heading = Math.atan2(-_v1.x, -_v1.z);
      p.targetHeading = p.heading;
      p.pos.copy(p.graphPos);
      p.state = PSTATE.WALK;
      p.speed = p.baseSpeed * (0.4 + this.rng.next() * 0.6);
      p.clip = CLIP.WALK;
      p.phase = this.rng.next();
      this.activeCount++;
      return true;
    }
    return false;
  }

  /** Props that go with a role: bags, panderos, cuatros, plaza stools. */
  private dressForRole(p: Pedestrian): void {
    switch (p.role) {
      case 'shopper':
        p.look.heldProp = 1;
        break;
      case 'musician':
        p.look.heldProp = this.rng.bool() ? 2 : 3;
        break;
      case 'sitter':
        p.look.heldProp = 4;
        break;
      case 'tourist':
        p.look.heldProp = this.rng.next() < 0.5 ? 1 : 0;
        break;
      default:
        p.look.heldProp = this.rng.next() < 0.12 ? 1 : 0;
        break;
    }
  }

  private despawn(p: Pedestrian): void {
    if (!p.active) return;
    if (p.anchored && p.anchorSpot >= 0 && this.spots[p.anchorSpot]) {
      this.spots[p.anchorSpot].occupied = false;
    }
    this.detachBody(p);
    this.activeCount--;
    p.reset();
    this.free.push(p.index);
  }

  /* -------------------------------------------------------------- physics */

  private attachBody(p: Pedestrian): void {
    let body = this.bodyPool.pop() ?? null;
    if (body) {
      body.setEnabled(true);
    } else {
      _v1.copy(p.pos);
      _v1.y += PED.bodyHalfHeight;
      body = this.physics.createBody({
        kind: 'kinematic',
        shape: { type: 'capsule', radius: PED.radius, halfHeight: PED.bodyHalfHeight * 0.6 },
        position: _v1,
        sensor: true,
        group: GROUP.PED,
        mask: PED_MASK,
        userData: { kind: 'ped' },
      });
    }
    this.bodies[p.index] = body;
  }

  private detachBody(p: Pedestrian): void {
    const body = this.bodies[p.index];
    if (!body) return;
    this.bodies[p.index] = null;
    body.setEnabled(false);
    _v1.set(0, -500, 0);
    body.setPosition(_v1);
    this.bodyPool.push(body);
  }

  private syncBodies(): void {
    const player = this.player.position;
    const near = LIMITS.pedBodyDistance;
    const near2 = near * near;
    const far2 = near * 1.2 * (near * 1.2);
    let used = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) {
        continue;
      }
      const dx = p.pos.x - player.x;
      const dz = p.pos.z - player.z;
      const d2 = dx * dx + dz * dz;
      const has = this.bodies[i] !== null;
      if (has) {
        if (d2 > far2) {
          this.detachBody(p);
          continue;
        }
        used++;
      } else if (d2 < near2 && used < LIMITS.pedBodies) {
        this.attachBody(p);
        used++;
      }
      const body = this.bodies[i];
      if (body) {
        _v1.set(p.pos.x, p.pos.y + PED.bodyHalfHeight, p.pos.z);
        body.setPosition(_v1);
      }
    }
  }

  /**
   * QA hook, shared with `Destructibles` and `Vehicle`. The scripted charge-a-
   * crowd test reads `worstOverlap` and `minPlayerDistance` off this to prove
   * the no-run-over guarantee holds at top speed. Absent outside a browser.
   */
  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __locoDebug?: Record<string, unknown> };
    const bag = (w.__locoDebug ??= {});
    bag.peds = (): Record<string, number> => ({
      active: this.activeCount,
      panicking: this.statPanic,
      dodging: this.statDodged,
      overlaps: this.statOverlaps,
      worstOverlap: this.worstOverlap,
      residual: this.statResidual,
      worstResidual: this.worstResidual,
      minPlayerDistance:
        this.minEverPlayerDist === Infinity ? -1 : Number(this.minEverPlayerDist.toFixed(3)),
      frames: this.safetyFrames,
    });
    bag.resetPeds = (): void => {
      this.worstOverlap = 0;
      this.worstResidual = 0;
      this.minEverPlayerDist = Infinity;
      this.safetyFrames = 0;
    };
    // the pedestrian system is the one place holding a `WorldAPI` reference,
    // so it is the cheapest place to expose the ground query the QA harness
    // needs to drop the vehicle onto a real surface instead of into a hill
    bag.groundHeight = (x: number, z: number): number => this.world.groundHeight(x, z);
    bag.nearestPeds = (
      x: number,
      z: number,
      n = 8,
    ): Array<{ x: number; y: number; z: number; d: number; state: number }> => {
      const out: Array<{ x: number; y: number; z: number; d: number; state: number }> = [];
      for (const ped of this.peds) {
        if (!ped.active) continue;
        out.push({
          x: ped.pos.x,
          y: ped.pos.y,
          z: ped.pos.z,
          d: Math.hypot(ped.pos.x - x, ped.pos.z - z),
          state: ped.state,
        });
      }
      out.sort((a, b) => a.d - b.d);
      return out.slice(0, n);
    };
  }

  /* ------------------------------------------------------------ rendering */

  private writeInstances(ctx: GameContext, dt: number): void {
    this.kit.beginFrame();
    const cam = ctx.camera.position;
    const lod2 = PED_SPAWN.lodDistance * PED_SPAWN.lodDistance;
    const cull2 = PED_SPAWN.cullDistance * PED_SPAWN.cullDistance;
    this.statHigh = 0;
    this.statLow = 0;

    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) continue;
      const d2 = cam.distanceToSquared(p.pos);
      if (d2 > cull2) continue;

      // far figures re-evaluate their pose at a lower rate
      let hop = 0;
      if (p.hopTimer > 0) {
        const f = 1 - p.hopTimer / PED_PANIC.hopTime;
        hop = Math.sin(Math.PI * clamp01(f)) * PED_PANIC.hopHeight;
      }
      _v1.set(p.pos.x, p.pos.y + hop, p.pos.z);
      _e1.set(0, p.heading, 0);
      _q1.setFromEuler(_e1);
      _s1.set(p.look.scale, p.look.scale, p.look.scale);
      _m1.compose(_v1, _q1, _s1);

      this.kit.rows(p.clip, p.phase, _rows);
      const fleet = d2 > lod2 ? this.kit.low : this.kit.high;
      fleet.push(_m1, _rows[0], _rows[1], _rows[2], p.look);
      if (d2 > lod2) this.statLow++;
      else this.statHigh++;
    }

    this.kit.endFrame();
    void dt;
  }

  /* ---------------------------------------------------------------- misc */

  get population(): number {
    return this.activeCount;
  }

  stats(): Record<string, number> {
    return {
      peds: this.activeCount,
      pedTarget: this.target,
      pedHigh: this.statHigh,
      pedLow: this.statLow,
      pedPanicking: this.statPanic,
      pedWaitingToCross: this.statCrossing,
      pedDodging: this.statDodged,
      pedDrawCalls: this.kit.drawCalls,
      pedTriangles: this.kit.liveTriangles,
      pedOverlaps: this.statOverlaps,
      pedInsideChassis: this.statResidual,
      pedMinPlayerDistance:
        this.statMinPlayerDist === Infinity ? -1 : Number(this.statMinPlayerDist.toFixed(3)),
      pedAnchorSpots: this.spots.length,
      pedWalkableEdges: this.walkable.length,
      pedCarts: this.kit.carts.count,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (p.active) this.despawn(p);
    }
    for (const b of this.bodyPool) this.physics.removeBody(b);
    this.bodyPool.length = 0;
    this.kit.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
