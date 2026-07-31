/**
 * Loco Lift — traffic system.
 *
 * Owns the population of AI road agents: cars from `VehicleKit`, two-wheelers
 * from `ScooterKit`. Drives them along the road graph, keeps them out of each
 * other, out of the callejones (scooters excepted), and out of the player's
 * way — while still being solid enough to crash into.
 *
 * ## What it guarantees
 *
 *  - an agent's logical position is always `(edge, t)` on a **drivable** edge,
 *    so it can never leave the carriageway or wander onto stairs or a rooftop;
 *  - no two agents in the same lane interpenetrate (IDM car-following);
 *  - junctions are arbitrated by a **non-conflicting claim** model — two
 *    movements may hold a node at once when their chords don't cross — which is
 *    deadlock-free by construction: an agent that is refused holds nothing;
 *  - nothing ever spawns inside the camera frustum at close range;
 *  - the population is recycled from a fixed pool, so a long shift allocates
 *    nothing.
 *
 * ## Cost
 *
 * One InstancedMesh per vehicle type (7) + two scooter meshes + one shared
 * distance imposter = **10 draw calls** for the entire traffic population,
 * whatever the tier.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { RNG } from '../core/RNG';
import type {
  EdgeSample,
  GameContext,
  QualityTier,
  RoadEdge,
  SettingsState,
  System,
} from '../core/types';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../core/MathUtils';
import { GROUP, type BodyHandle, type PhysicsWorldAPI } from '../physics/PhysicsTypes';
import {
  AGENT_STATE,
  HazardField,
  RoadAgent,
  approachBearing,
  bearingAxis,
  idmAcceleration,
  lanesPerDirection,
  laneCentreFor,
  lateralOffset,
  makeEdgeSample,
  movementsConflict,
  nearestOnGraph,
  stopAcceleration,
  type TrafficRoadGraph,
} from './TrafficVehicle';
import {
  ScooterKit,
  scooterEdgeAllowed,
  scooterBob,
  updateScooterLean,
  updateScooterSplit,
} from './Scooters';
import { VehicleKit } from './VehicleKit';
import {
  CAR_PROFILE,
  HAZARD,
  INTERSECTION,
  LIGHTS,
  LIMITS,
  PLAYER_REACT,
  ROAD,
  ROUTE,
  SCOOTER,
  SCOOTER_PROFILE,
  SHUNT,
  SIGNAL,
  SIGNAL_CYCLE,
  SPAWN,
  type AgentProfileTuning,
} from './TrafficTuning';

/* ============================================================== interfaces */

/** The slice of the world traffic needs. `World` satisfies this structurally. */
export interface TrafficWorldRef {
  roads: TrafficRoadGraph;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  groundHeight(x: number, z: number): number;
}

/** The slice of the player's vehicle traffic needs. `Vehicle` satisfies this. */
export interface TrafficPlayerRef {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly speed: number;
}

export interface TrafficSystemOpts {
  scene: THREE.Scene;
  physics: PhysicsWorldAPI;
  world: TrafficWorldRef;
  player: TrafficPlayerRef;
  rng: RNG;
  quality: QualityTier;
}

/* ------------------------------------------------------------ successor CSR */

interface SuccessorTable {
  /** start index per (edge*2 + dirFlag); length = edgeCount*2 + 1 */
  start: Int32Array;
  edge: Int32Array;
  dir: Int8Array;
  turn: Float32Array;
  weight: Float32Array;
}

/* ------------------------------------------------------------- scratch */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _m1 = new THREE.Matrix4();
const _scale1 = new THREE.Vector3(1, 1, 1);

/** Traffic bodies only ever need to interact with the player's Jeep. */
const TRAFFIC_MASK = GROUP.VEHICLE;

/* ================================================================= system */

export class TrafficSystem implements System {
  readonly name = 'traffic';
  readonly group = new THREE.Group();
  readonly hazard: HazardField;

  private readonly scene: THREE.Scene;
  private readonly physics: PhysicsWorldAPI;
  private readonly world: TrafficWorldRef;
  private readonly roads: TrafficRoadGraph;
  private readonly player: TrafficPlayerRef;
  private readonly rng: RNG;

  private readonly cars: VehicleKit;
  private readonly scooters: ScooterKit;

  private quality: QualityTier;
  private targetCars = 0;
  private targetScooters = 0;
  private castShadows = true;

  /* ---- pool ---- */
  private readonly agents: RoadAgent[] = [];
  private readonly free: number[] = [];
  private readonly bodies: Array<BodyHandle | null> = [];
  private readonly bodyPool = new Map<number, BodyHandle[]>();
  private activeCount = 0;
  private activeScooters = 0;

  /* ---- per-frame buckets ---- */
  private readonly edgeHead: Int32Array;
  private readonly agentNext: Int32Array;

  /* ---- precomputed graph data ---- */
  private readonly drivableEdges: number[] = [];
  private readonly scooterEdges: number[] = [];
  private readonly edgeMid: Float32Array;
  private readonly edgeBearingA: Float32Array;
  private readonly edgeBearingB: Float32Array;
  private readonly edgeAxisA: Uint8Array;
  private readonly edgeAxisB: Uint8Array;
  private readonly nodeSignalled: Uint8Array;
  private readonly nodeSignalOffset: Float32Array;
  private succCar: SuccessorTable;
  private succScooter: SuccessorTable;

  /* ---- junction claims ---- */
  private readonly claimAgent: Int32Array;
  private readonly claimIn: Float32Array;
  private readonly claimOut: Float32Array;
  private readonly claimInEdge: Int32Array;
  private readonly claimOutEdge: Int32Array;
  private readonly claimExpiry: Float32Array;

  /* ---- runtime ---- */
  private elapsed = 0;
  private spawnCredit = 0;
  private nightAmount = 0;
  private wetHeadlights = 0;
  private hornGlobalTimer = 0;
  private readonly sample: EdgeSample = makeEdgeSample();
  private readonly hornPool: THREE.Vector3[] = [];
  private hornCursor = 0;
  private unsubs: Array<() => void> = [];
  private disposed = false;

  /* ---- stats ---- */
  private statDrawCalls = 0;
  private statTriangles = 0;
  private statImposters = 0;
  private statStopped = 0;

  constructor(opts: TrafficSystemOpts) {
    this.scene = opts.scene;
    this.physics = opts.physics;
    this.world = opts.world;
    this.roads = opts.world.roads;
    this.player = opts.player;
    this.rng = opts.rng.fork(0x7a4f);
    this.quality = opts.quality;
    this.castShadows = opts.quality !== 'low';

    this.group.name = 'loco/traffic';
    this.cars = new VehicleKit(LIMITS.maxAgents, this.castShadows);
    this.scooters = new ScooterKit(
      LIMITS.maxAgents,
      this.cars.material,
      this.cars.depthMaterial,
      this.castShadows,
    );
    this.group.add(this.cars.group);
    this.group.add(this.scooters.group);
    this.scene.add(this.group);

    this.hazard = new HazardField(opts.world.bounds, HAZARD.cell);

    const edges = this.roads.edges;
    const nodes = this.roads.nodes;
    // These are linked lists over agent indices with -1 as the empty sentinel.
    // A zero-filled Int32Array means "index 0", and agentNext[0] === 0 makes
    // laneIsClear() walk a self-referencing node forever. buildBuckets() resets
    // edgeHead every frame, but warmUp() spawns before the first update, so
    // both must start valid here.
    this.edgeHead = new Int32Array(edges.length).fill(-1);
    this.agentNext = new Int32Array(LIMITS.maxAgents).fill(-1);
    this.edgeMid = new Float32Array(edges.length * 3);
    this.edgeBearingA = new Float32Array(edges.length);
    this.edgeBearingB = new Float32Array(edges.length);
    this.edgeAxisA = new Uint8Array(edges.length);
    this.edgeAxisB = new Uint8Array(edges.length);
    this.nodeSignalled = new Uint8Array(nodes.length);
    this.nodeSignalOffset = new Float32Array(nodes.length);

    this.claimAgent = new Int32Array(nodes.length * INTERSECTION.maxClaims).fill(-1);
    this.claimIn = new Float32Array(nodes.length * INTERSECTION.maxClaims);
    this.claimOut = new Float32Array(nodes.length * INTERSECTION.maxClaims);
    this.claimInEdge = new Int32Array(nodes.length * INTERSECTION.maxClaims).fill(-1);
    this.claimOutEdge = new Int32Array(nodes.length * INTERSECTION.maxClaims).fill(-1);
    this.claimExpiry = new Float32Array(nodes.length * INTERSECTION.maxClaims);

    this.bakeGraph();
    this.succCar = this.buildSuccessors(false);
    this.succScooter = this.buildSuccessors(true);

    for (let i = 0; i < LIMITS.maxAgents; i++) {
      const a = new RoadAgent();
      a.index = i;
      this.agents.push(a);
      this.bodies.push(null);
      this.free.push(i);
    }
    for (let i = 0; i < this.cars.types.length; i++) this.bodyPool.set(i, []);
    for (let i = 0; i < this.scooters.types.length; i++) this.bodyPool.set(100 + i, []);
    for (let i = 0; i < 8; i++) this.hornPool.push(new THREE.Vector3());

    this.applyBudget(opts.quality);
  }

  /* ------------------------------------------------------------- baking */

  private bakeGraph(): void {
    const edges = this.roads.edges;
    const nodes = this.roads.nodes;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e.noTraffic) this.drivableEdges.push(i);
      if (scooterEdgeAllowed(e)) this.scooterEdges.push(i);
      this.roads.sample(i, 0.5, 0, _v1);
      this.edgeMid[i * 3] = _v1.x;
      this.edgeMid[i * 3 + 1] = _v1.y;
      this.edgeMid[i * 3 + 2] = _v1.z;
      const ba = approachBearing(this.roads, i, e.a, _v1);
      const bb = approachBearing(this.roads, i, e.b, _v1);
      this.edgeBearingA[i] = ba;
      this.edgeBearingB[i] = bb;
      this.edgeAxisA[i] = bearingAxis(ba);
      this.edgeAxisB[i] = bearingAxis(bb);
    }
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n];
      let deg = 0;
      for (let k = 0; k < node.edges.length; k++) {
        if (!edges[node.edges[k]].noTraffic) deg++;
      }
      const signalled = node.signalOffset >= 0 && deg >= SIGNAL.minDegree;
      this.nodeSignalled[n] = signalled ? 1 : 0;
      this.nodeSignalOffset[n] = Math.max(0, node.signalOffset) * SIGNAL.offsetScale;
    }
  }

  /** Bearing of the direction leaving `node` along `edge`. */
  private bearingAway(edge: number, node: number): number {
    return this.roads.edges[edge].a === node ? this.edgeBearingA[edge] : this.edgeBearingB[edge];
  }

  private axisAt(edge: number, node: number): number {
    return this.roads.edges[edge].a === node ? this.edgeAxisA[edge] : this.edgeAxisB[edge];
  }

  private allows(e: RoadEdge, scooter: boolean): boolean {
    return scooter ? scooterEdgeAllowed(e) : !e.noTraffic;
  }

  /**
   * Successor table: for every (edge, direction) the legal exits at the far
   * node, pre-weighted so traffic mostly goes straight on.
   */
  private buildSuccessors(scooter: boolean): SuccessorTable {
    const edges = this.roads.edges;
    const nodes = this.roads.nodes;
    const keys = edges.length * 2;
    const start = new Int32Array(keys + 1);
    const outEdge: number[] = [];
    const outDir: number[] = [];
    const outTurn: number[] = [];
    const outWeight: number[] = [];

    for (let key = 0; key < keys; key++) {
      start[key] = outEdge.length;
      const ei = key >> 1;
      const e = edges[ei];
      if (!this.allows(e, scooter)) continue;
      const dirFlag = key & 1; // 0 = a→b, 1 = b→a
      const exitNode = dirFlag === 0 ? e.b : e.a;
      const node = nodes[exitNode];
      if (!node) continue;
      const inBearing = this.bearingAway(ei, exitNode);

      const first = outEdge.length;
      let nonSelf = 0;
      for (let k = 0; k < node.edges.length; k++) {
        const ce = node.edges[k];
        const cand = edges[ce];
        if (!this.allows(cand, scooter)) continue;
        const nd = cand.a === exitNode ? 1 : -1;
        if (cand.oneWay && nd < 0) continue;
        const outBearing = this.bearingAway(ce, exitNode);
        const turn = wrapAngle(outBearing - (inBearing + Math.PI));
        let w: number;
        if (ce === ei) {
          w = ROUTE.uTurn;
        } else {
          nonSelf++;
          w = Math.abs(turn) < ROUTE.straightAngle ? ROUTE.straight : ROUTE.turn;
          if (cand.kind === 'coastal') w *= ROUTE.coastalBonus;
          else if (cand.kind === 'plaza') w *= ROUTE.plazaPenalty;
          else if (cand.kind === 'alley') w *= SCOOTER.alleyWeight;
        }
        outEdge.push(ce);
        outDir.push(nd);
        outTurn.push(turn);
        outWeight.push(w);
      }
      // a cul-de-sac must still be escapable: promote the U-turn
      if (nonSelf === 0) {
        for (let i = first; i < outEdge.length; i++) outWeight[i] = 1;
      }
    }
    start[keys] = outEdge.length;
    return {
      start,
      edge: Int32Array.from(outEdge),
      dir: Int8Array.from(outDir),
      turn: Float32Array.from(outTurn),
      weight: Float32Array.from(outWeight),
    };
  }

  /* -------------------------------------------------------------- budget */

  private applyBudget(tier: QualityTier): void {
    const total = Math.min(LIMITS.maxAgents, QUALITY_BUDGET[tier].trafficCount);
    const scooters = Math.max(
      total > 6 ? SPAWN.minScooters : 0,
      Math.round(total * SPAWN.scooterFraction),
    );
    this.targetScooters = Math.min(scooters, Math.max(0, total - 2));
    this.targetCars = total - this.targetScooters;
  }

  /* ---------------------------------------------------------------- system */

  init(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('weather:changed', (e) => {
        this.wetHeadlights = e.kind === 'rain' || e.kind === 'storm' ? LIGHTS.rainHeadlights : 0;
      }),
    );
    // prime the streets so the first frame is already populated
    this.warmUp(24);
  }

  /** Fill the population immediately (boot, respawn, teleport). */
  warmUp(attempts: number): void {
    for (let i = 0; i < attempts; i++) {
      if (this.activeCount >= this.targetCars + this.targetScooters) break;
      this.trySpawn(null, true);
    }
  }

  onQualityChange(tier: QualityTier, _settings: SettingsState): void {
    this.quality = tier;
    this.applyBudget(tier);
    const want = tier !== 'low';
    if (want !== this.castShadows) {
      this.castShadows = want;
      for (const f of this.cars.fleets) f.mesh.castShadow = want;
      for (const f of this.scooters.fleets) f.mesh.castShadow = want;
    }
    // shed anything above the new budget, furthest first
    const total = this.targetCars + this.targetScooters;
    while (this.activeCount > total) {
      let worst = -1;
      let worstD = -1;
      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i];
        if (!a.active) continue;
        const d = a.pos.distanceToSquared(this.player.position);
        if (d > worstD) {
          worstD = d;
          worst = i;
        }
      }
      if (worst < 0) break;
      this.despawn(this.agents[worst]);
    }
  }

  update(ctx: GameContext, dtRaw: number): void {
    if (this.disposed) return;
    const dt = Math.min(dtRaw, 0.05);
    this.elapsed += dt;
    this.hornGlobalTimer = Math.max(0, this.hornGlobalTimer - dt);
    this.nightAmount = Math.max(nightAmount(ctx.timeOfDay), this.wetHeadlights);

    this.buildBuckets();
    this.hazard.clear();

    const player = this.player.position;
    const pv = this.player.velocity;
    this.hazard.stampMotion(
      player.x,
      player.z,
      pv.x,
      pv.z,
      HAZARD.playerWeight,
      HAZARD.lookahead,
      HAZARD.steps,
      HAZARD.radiusCells + 1,
    );

    this.statStopped = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.active) this.think(a, dt, ctx);
    }
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.active) this.integrate(a, dt, ctx);
    }

    this.stream(ctx, dt);
    this.writeInstances(ctx);
    this.syncBodies();
  }

  /* ---------------------------------------------------------- bookkeeping */

  private buildBuckets(): void {
    this.edgeHead.fill(-1);
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active || a.edge < 0) continue;
      this.agentNext[i] = this.edgeHead[a.edge];
      this.edgeHead[a.edge] = i;
    }
  }

  /* --------------------------------------------------------------- think */

  /** Decide this agent's acceleration and lateral intent for the frame. */
  private think(a: RoadAgent, dt: number, ctx: GameContext): void {
    a.age += dt;
    a.shuntCooldown = Math.max(0, a.shuntCooldown - dt);
    a.hornTimer = Math.max(0, a.hornTimer - dt);
    a.brakeFlash = Math.max(0, a.brakeFlash - dt);
    a.reactTimer = Math.max(0, a.reactTimer - dt);

    if (a.shuntTimer > 0) {
      a.state = AGENT_STATE.SHUNTED;
      a.accel = 0;
      return;
    }

    const profile = a.kind === 'scooter' ? SCOOTER_PROFILE : CAR_PROFILE;
    const edge = this.roads.edges[a.edge];

    /* --- desired speed for this stretch --- */
    let desired = a.baseDesiredSpeed * edgeSpeedFactor(edge);
    // slow for the curve we are actually taking
    const yawMag = Math.abs(a.yawRate);
    if (yawMag > 0.35) {
      desired *= 1 - profile.cornerCaution * clamp01((yawMag - 0.35) / 0.9);
    }
    // slow for the turn coming up
    if (a.nextEdge >= 0 && Math.abs(a.nextTurn) > ROUTE.straightAngle && a.remaining < 14) {
      desired = Math.min(desired, INTERSECTION.turnSpeed);
    } else if (a.remaining < INTERSECTION.stopLineOffset) {
      desired = Math.min(desired, INTERSECTION.crossSpeed);
    }

    /* --- car following --- */
    let gap = Infinity;
    let leaderSpeed = 0;
    const lead = this.findLeader(a);
    if (lead >= 0) {
      gap = this.leaderGap;
      leaderSpeed = this.leaderSpeed;
    }

    // two-wheelers filter past a stopped queue instead of joining it
    if (a.kind === 'scooter') {
      const filtering = updateScooterSplit(a, gap, leaderSpeed, dt);
      if (filtering) {
        gap = Math.max(gap, SCOOTER.splitGap * 1.6);
        leaderSpeed = Math.max(leaderSpeed, a.speed);
      }
    }

    let accel = idmAcceleration(a.speed, desired, gap, a.speed - leaderSpeed, profile);
    a.state = gap < 40 ? AGENT_STATE.FOLLOW : AGENT_STATE.CRUISE;

    /* --- junction --- */
    const junctionAccel = this.junctionConstraint(a, profile);
    if (junctionAccel < accel) {
      accel = junctionAccel;
      a.state = this.junctionState;
    }

    /* --- the player --- */
    accel = this.playerReaction(a, accel, dt, ctx, profile);

    a.accel = clamp(accel, -profile.emergencyBrake, profile.accel);
    a.desiredSpeed = desired;

    /* --- lateral --- */
    const swerveStep = profile.swerveRate * dt;
    if (a.swerve < a.swerveTarget) a.swerve = Math.min(a.swerveTarget, a.swerve + swerveStep);
    else a.swerve = Math.max(a.swerveTarget, a.swerve - swerveStep);
    const maxSwerve = Math.max(
      0,
      edge.width * 0.5 - a.halfWidth - ROAD.kerbMargin - Math.abs(a.laneOffset),
    );
    a.swerve = clamp(a.swerve, -Math.min(profile.maxSwerve, maxSwerve + Math.abs(a.laneOffset)), Math.min(profile.maxSwerve, maxSwerve));
    a.swerveTarget = damp(a.swerveTarget, 0, 2.2, dt);
  }

  /* ------------------------------------------------------- leader search */

  private leaderGap = Infinity;
  private leaderSpeed = 0;

  /** Nearest agent ahead in the same lane, on this edge or the next one. */
  private findLeader(a: RoadAgent): number {
    let best = -1;
    let bestGap = Infinity;
    let bestSpeed = 0;

    const myLat = a.laneOffset - a.split;
    for (let j = this.edgeHead[a.edge]; j >= 0; j = this.agentNext[j]) {
      if (j === a.index) continue;
      const b = this.agents[j];
      if (b.dir !== a.dir || b.s <= a.s) continue;
      if (Math.abs(b.laneOffset - b.split - myLat) > a.halfWidth + b.halfWidth + 0.35) continue;
      const gap = b.s - b.halfLength - (a.s + a.halfLength);
      if (gap < bestGap) {
        bestGap = gap;
        bestSpeed = b.speed;
        best = j;
      }
    }

    if (a.nextEdge >= 0 && a.remaining < 34) {
      for (let j = this.edgeHead[a.nextEdge]; j >= 0; j = this.agentNext[j]) {
        const b = this.agents[j];
        if (b.dir !== a.nextDir) continue;
        const gap = a.remaining + (b.s - b.halfLength) - a.halfLength;
        if (gap >= 0 && gap < bestGap) {
          bestGap = gap;
          bestSpeed = b.speed;
          best = j;
        }
      }
    }

    this.leaderGap = bestGap;
    this.leaderSpeed = bestSpeed;
    return best;
  }

  /* ---------------------------------------------------------- junctions */

  /** widened: assigned every AGENT_STATE value, not just CRUISE */
  private junctionState: number = AGENT_STATE.CRUISE;

  /**
   * Returns the acceleration the junction ahead demands (`Infinity` when the
   * agent may proceed freely). Also acquires and holds the node claim.
   */
  private junctionConstraint(a: RoadAgent, _profile: AgentProfileTuning): number {
    this.junctionState = AGENT_STATE.CRUISE;
    const node = a.exitNode;
    if (node < 0) return Infinity;

    // already through this junction? release once physically clear
    if (a.claimNode >= 0 && a.claimNode !== node) {
      const np = this.roads.nodes[a.claimNode].pos;
      if (a.pos.distanceToSquared(np) > INTERSECTION.clearDistance * INTERSECTION.clearDistance) {
        this.releaseClaim(a);
      }
    }
    if (a.claimNode === node) return Infinity;

    const dist = a.remaining;
    if (dist > INTERSECTION.claimDistance) return Infinity;

    if (a.nextEdge < 0) this.chooseNext(a);
    if (a.nextEdge < 0) return Infinity;

    const stopDist = dist - INTERSECTION.stopLineOffset;

    /* --- traffic signal --- */
    if (this.nodeSignalled[node] === 1) {
      const axis = this.axisAt(a.edge, node);
      const phase = this.signalPhase(node, axis);
      if (phase === 0 || (phase === 1 && dist > SIGNAL.amberRunDistance)) {
        this.junctionState = AGENT_STATE.SIGNAL;
        if (stopDist < -1.5) return Infinity; // already committed, clear the box
        return stopAcceleration(a.speed, Math.max(0.05, stopDist));
      }
    }

    /* --- do not block the box --- */
    if (!this.exitHasRoom(a)) {
      this.junctionState = AGENT_STATE.YIELD;
      if (stopDist < -1.5) return Infinity;
      return stopAcceleration(a.speed, Math.max(0.05, stopDist));
    }

    /* --- claim the movement --- */
    const inAng = this.bearingAway(a.edge, node) - INTERSECTION.chordOffsetRad;
    const outAng = this.bearingAway(a.nextEdge, node) + INTERSECTION.chordOffsetRad;
    if (this.tryClaim(a, node, inAng, outAng)) return Infinity;

    this.junctionState = AGENT_STATE.YIELD;
    if (stopDist < -1.5) return Infinity;
    return stopAcceleration(a.speed, Math.max(0.05, stopDist));
  }

  /** 0 = red, 1 = amber, 2 = green for `axis` at this node right now. */
  private signalPhase(node: number, axis: number): number {
    const seg = SIGNAL.green + SIGNAL.amber + SIGNAL.allRed;
    let p = (this.elapsed + this.nodeSignalOffset[node]) % SIGNAL_CYCLE;
    if (p < 0) p += SIGNAL_CYCLE;
    const activeAxis = p < seg ? 0 : 1;
    const local = p < seg ? p : p - seg;
    if (activeAxis !== axis) return 0;
    if (local < SIGNAL.green) return 2;
    if (local < SIGNAL.green + SIGNAL.amber) return 1;
    return 0;
  }

  /** Is there space on the exit edge for this agent to land in? */
  private exitHasRoom(a: RoadAgent): boolean {
    const need = INTERSECTION.exitClearance + a.halfLength * 2;
    for (let j = this.edgeHead[a.nextEdge]; j >= 0; j = this.agentNext[j]) {
      const b = this.agents[j];
      if (b.dir !== a.nextDir) continue;
      if (b.s - b.halfLength < need && b.speed < 1.6) return false;
    }
    return true;
  }

  private tryClaim(a: RoadAgent, node: number, inAng: number, outAng: number): boolean {
    const base = node * INTERSECTION.maxClaims;
    let freeSlot = -1;
    for (let k = 0; k < INTERSECTION.maxClaims; k++) {
      const i = base + k;
      const owner = this.claimAgent[i];
      if (owner < 0 || this.claimExpiry[i] <= this.elapsed) {
        if (owner >= 0) this.clearSlot(i);
        if (freeSlot < 0) freeSlot = i;
        continue;
      }
      if (owner === a.index) return true;
      if (
        movementsConflict(
          inAng,
          outAng,
          this.claimIn[i],
          this.claimOut[i],
          this.claimInEdge[i] === a.edge,
          this.claimOutEdge[i] === a.nextEdge,
        )
      ) {
        return false;
      }
    }
    if (freeSlot < 0) return false;
    this.releaseClaim(a);
    this.claimAgent[freeSlot] = a.index;
    this.claimIn[freeSlot] = inAng;
    this.claimOut[freeSlot] = outAng;
    this.claimInEdge[freeSlot] = a.edge;
    this.claimOutEdge[freeSlot] = a.nextEdge;
    this.claimExpiry[freeSlot] = this.elapsed + INTERSECTION.claimTimeout;
    a.claimNode = node;
    a.claimSlot = freeSlot;
    return true;
  }

  private clearSlot(i: number): void {
    const owner = this.claimAgent[i];
    if (owner >= 0) {
      const a = this.agents[owner];
      if (a && a.claimSlot === i) {
        a.claimNode = -1;
        a.claimSlot = -1;
      }
    }
    this.claimAgent[i] = -1;
    this.claimInEdge[i] = -1;
    this.claimOutEdge[i] = -1;
    this.claimExpiry[i] = 0;
  }

  private releaseClaim(a: RoadAgent): void {
    if (a.claimSlot >= 0 && this.claimAgent[a.claimSlot] === a.index) {
      this.claimAgent[a.claimSlot] = -1;
      this.claimInEdge[a.claimSlot] = -1;
      this.claimOutEdge[a.claimSlot] = -1;
      this.claimExpiry[a.claimSlot] = 0;
    }
    a.claimNode = -1;
    a.claimSlot = -1;
  }

  /* ------------------------------------------------------ player reaction */

  private playerReaction(
    a: RoadAgent,
    accelIn: number,
    dt: number,
    ctx: GameContext,
    profile: AgentProfileTuning,
  ): number {
    const p = this.player.position;
    const dx = a.pos.x - p.x;
    const dz = a.pos.z - p.z;
    const d2 = dx * dx + dz * dz;
    const notice = PLAYER_REACT.noticeRadius;
    if (d2 > notice * notice) return accelIn;

    const dist = Math.sqrt(Math.max(1e-4, d2));
    const pv = this.player.velocity;
    // positive when the player is heading toward us
    const closing = (pv.x * dx + pv.z * dz) / dist;

    /* --- contact: an arcade shunt, not a physics reaction --- */
    if (
      a.shuntTimer <= 0 &&
      a.shuntCooldown <= 0 &&
      this.player.speed > SHUNT.minSpeed &&
      dist < a.boundRadius + 2.6 &&
      a.containsPoint(p, SHUNT.contactPad + 1.1)
    ) {
      this.applyShunt(a, dx, dz, dist);
      return accelIn;
    }

    if (closing < PLAYER_REACT.minClosingSpeed && a.reactTimer <= 0) return accelIn;
    if (closing >= PLAYER_REACT.minClosingSpeed) a.reactTimer = PLAYER_REACT.memory;

    const t = clamp01(
      1 - (dist - PLAYER_REACT.alarmRadius) / (notice - PLAYER_REACT.alarmRadius),
    );
    if (t <= 0.001) return accelIn;

    a.state = AGENT_STATE.EVADE;
    // move away from the side the player is on
    const lat = lateralOffset(a, p);
    a.swerveTarget = -Math.sign(lat || 1) * PLAYER_REACT.swerveStrength * t;
    a.brakeFlash = Math.max(a.brakeFlash, PLAYER_REACT.brakeFlash * t);

    // brake toward a fraction of the desired speed
    const target = a.desiredSpeed * lerp(1, PLAYER_REACT.brakeFactor, t);
    const braking = clamp((target - a.speed) * 2.2, -profile.emergencyBrake, profile.accel);

    /* --- horn --- */
    if (
      a.hornTimer <= 0 &&
      this.hornGlobalTimer <= 0 &&
      t > 0.55 &&
      this.player.speed > PLAYER_REACT.hornMinPlayerSpeed &&
      this.rng.next() < PLAYER_REACT.hornChance * dt * 12
    ) {
      a.hornTimer = PLAYER_REACT.hornCooldown;
      this.hornGlobalTimer = PLAYER_REACT.hornGlobalCooldown;
      const at = this.hornPool[this.hornCursor];
      this.hornCursor = (this.hornCursor + 1) % this.hornPool.length;
      at.copy(a.pos);
      at.y += 1;
      ctx.bus.emit('audio:sfx', {
        id: 'horn',
        at,
        volume: 0.5 + 0.35 * t,
        pitch: a.kind === 'scooter' ? 1.5 : 0.82 + this.rng.next() * 0.35,
      });
    }

    return Math.min(accelIn, braking);
  }

  private applyShunt(a: RoadAgent, dx: number, dz: number, dist: number): void {
    const pv = this.player.velocity;
    const push = Math.min(SHUNT.maxSpeed, this.player.speed * SHUNT.transfer);
    const nx = dx / dist;
    const nz = dz / dist;
    a.shuntVel.set(nx * push * 0.72 + pv.x * 0.28, 0.35, nz * push * 0.72 + pv.z * 0.28);
    const side = Math.sign(lateralOffset(a, this.player.position) || 1);
    a.shuntSpin = -side * SHUNT.spin * push * (0.6 + this.rng.next() * 0.8);
    a.shuntTimer = SHUNT.duration;
    a.shuntCooldown = SHUNT.duration + SHUNT.cooldown;
    a.brakeFlash = SHUNT.duration;
    a.speed *= 0.4;
    this.releaseClaim(a);
  }

  /* ----------------------------------------------------------- integrate */

  private integrate(a: RoadAgent, dt: number, ctx: GameContext): void {
    if (a.shuntTimer > 0) {
      a.shuntTimer -= dt;
      a.followShunt(dt);
      a.updateWheels(dt);
      if (a.shuntTimer <= 0) this.recoverFromShunt(a);
      this.finishFrame(a, dt, ctx);
      return;
    }

    a.speed = Math.max(0, a.speed + a.accel * dt);
    if (!Number.isFinite(a.speed)) a.speed = 0;

    if (a.speed < SPAWN.stuckSpeed) {
      a.stuckTimer += dt;
      this.statStopped++;
    } else {
      a.stuckTimer = 0;
    }

    a.s += a.speed * dt;

    let guard = 0;
    while (a.s >= a.edgeLen && guard++ < 4) {
      const over = a.s - a.edgeLen;
      if (a.nextEdge < 0) this.chooseNext(a);
      if (a.nextEdge < 0) {
        this.despawn(a);
        return;
      }
      const ne = a.nextEdge;
      const nd = a.nextDir;
      const perDir = lanesPerDirection(this.roads.edges[ne]);
      a.lane = perDir > 1 ? (this.rng.next() < 0.7 ? 0 : 1) : 0;
      a.enterEdge(this.roads, ne, nd, over);
      this.chooseNext(a);
    }

    a.evaluate(this.roads);
    a.followGraph(dt);
    this.finishFrame(a, dt, ctx);
  }

  /** Shared tail of `integrate`: attitude, wheels, lamps and hazard stamp. */
  private finishFrame(a: RoadAgent, dt: number, _ctx: GameContext): void {
    a.updateWheels(dt);
    if (a.kind === 'scooter') updateScooterLean(a, dt);
    else a.updateBodyAttitude(dt, ROAD.bodyRoll, 0.12);
    this.updateLamps(a, dt);

    a.forward(_v1);
    this.hazard.stampMotion(
      a.pos.x,
      a.pos.z,
      _v1.x * a.speed,
      _v1.z * a.speed,
      1,
      HAZARD.lookahead,
      HAZARD.steps,
      HAZARD.radiusCells,
    );
  }

  private recoverFromShunt(a: RoadAgent): void {
    a.shuntVel.set(0, 0, 0);
    a.shuntSpin = 0;
    if (!nearestOnGraph(this.roads, a.pos, 45, this.sample)) {
      this.despawn(a);
      return;
    }
    const e = this.roads.edges[this.sample.edgeId];
    if (!this.allows(e, a.kind === 'scooter')) {
      this.despawn(a);
      return;
    }
    // keep going the way the nose is pointing
    a.forward(_v1);
    const dir = _v1.x * this.sample.tangent.x + _v1.z * this.sample.tangent.z >= 0 ? 1 : -1;
    const len = Math.max(0.5, e.length);
    const s = dir > 0 ? this.sample.t * len : (1 - this.sample.t) * len;
    a.lane = 0;
    a.enterEdge(this.roads, this.sample.edgeId, dir, s);
    this.chooseNext(a);
    a.evaluate(this.roads);
    a.speed = Math.min(a.speed, 4);
    a.stuckTimer = 0;
  }

  private chooseNext(a: RoadAgent): void {
    const table = a.kind === 'scooter' ? this.succScooter : this.succCar;
    const key = a.edge * 2 + (a.dir > 0 ? 0 : 1);
    const s0 = table.start[key];
    const s1 = table.start[key + 1];
    if (s1 <= s0) {
      a.nextEdge = -1;
      return;
    }
    let total = 0;
    for (let i = s0; i < s1; i++) total += table.weight[i];
    let r = this.rng.next() * total;
    let chosen = s0;
    for (let i = s0; i < s1; i++) {
      r -= table.weight[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    a.nextEdge = table.edge[chosen];
    a.nextDir = table.dir[chosen];
    a.nextTurn = table.turn[chosen];
  }

  /* --------------------------------------------------------------- lamps */

  private updateLamps(a: RoadAgent, dt: number): void {
    const braking = a.accel < LIGHTS.brakeThreshold || a.brakeFlash > 0 || a.speed < 0.4;
    a.brake = damp(a.brake, braking ? 1 : 0, 14, dt);
    a.head = damp(a.head, this.nightAmount, 3, dt);

    const blink =
      ((this.elapsed + a.index * 0.137) % LIGHTS.blinkPeriod) / LIGHTS.blinkPeriod <
      LIGHTS.blinkDuty
        ? 1
        : 0;

    const def = a.kind === 'car' ? this.cars.types[a.typeIndex] : null;
    if (def && def.emergency) {
      // police bar: hard alternation, always live
      const fast = (this.elapsed * 4.4 + a.index) % 1;
      a.indL = fast < 0.25 || (fast >= 0.5 && fast < 0.62) ? 1 : 0;
      a.indR = (fast >= 0.25 && fast < 0.5) || fast >= 0.75 ? 1 : 0;
      return;
    }

    let want = 0;
    if (a.nextEdge >= 0 && Math.abs(a.nextTurn) > ROUTE.straightAngle) {
      const lead = a.speed * LIGHTS.indicateLead + 6;
      if (a.remaining < lead) want = a.nextTurn > 0 ? 1 : -1;
    }
    a.indL = want < 0 ? blink : 0;
    a.indR = want > 0 ? blink : 0;
  }

  /* -------------------------------------------------------------- stream */

  private stream(ctx: GameContext, dt: number): void {
    const cam = ctx.camera;
    const player = this.player.position;
    const budget = QUALITY_BUDGET[this.quality];
    const despawnFar = Math.min(SPAWN.despawnDistance, budget.drawDistance * 0.95);

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active) continue;
      const d = a.pos.distanceTo(player);
      if (d > despawnFar) {
        this.despawn(a);
        continue;
      }
      if (d > SPAWN.despawnDistanceHidden && !this.onScreen(a.pos, cam)) {
        this.despawn(a);
        continue;
      }
      if (a.stuckTimer > SPAWN.stuckTimeout) {
        // never yank a car out of shot; free its claim and give it a shove
        this.releaseClaim(a);
        a.stuckTimer = 0;
        if (!this.onScreen(a.pos, cam)) this.despawn(a);
        else a.speed = Math.max(a.speed, 1.5);
        continue;
      }
      if (!Number.isFinite(a.pos.x) || !Number.isFinite(a.pos.z)) this.despawn(a);
    }

    const want = this.targetCars + this.targetScooters;
    if (this.activeCount >= want) {
      this.spawnCredit = 0;
      return;
    }
    this.spawnCredit += dt * SPAWN.attemptsPerSecond;
    let budgetAttempts = Math.min(4, Math.floor(this.spawnCredit));
    this.spawnCredit -= budgetAttempts;
    while (budgetAttempts-- > 0 && this.activeCount < want) {
      this.trySpawn(cam, false);
    }
  }

  /** True when `p` is inside the camera frustum (with a small margin). */
  private onScreen(p: THREE.Vector3, cam: THREE.PerspectiveCamera): boolean {
    _v2.copy(p).project(cam);
    if (_v2.z < -1 || _v2.z > 1) return false;
    const m = SPAWN.frustumMargin;
    return _v2.x > -m && _v2.x < m && _v2.y > -m && _v2.y < m;
  }

  /**
   * Try once to drop a new agent into the ring around the player. Returns true
   * on success. `cam` may be null during the boot warm-up.
   */
  private trySpawn(cam: THREE.PerspectiveCamera | null, warm: boolean): boolean {
    if (this.free.length === 0) return false;
    const wantScooter = this.activeScooters < this.targetScooters;
    const list = wantScooter ? this.scooterEdges : this.drivableEdges;
    if (list.length === 0) return false;
    const player = this.player.position;

    for (let attempt = 0; attempt < SPAWN.candidates; attempt++) {
      const edgeId = list[this.rng.int(0, list.length - 1)];
      const e = this.roads.edges[edgeId];
      if (e.length < 12) continue;

      const mx = this.edgeMid[edgeId * 3];
      const mz = this.edgeMid[edgeId * 3 + 2];
      const midD = Math.hypot(mx - player.x, mz - player.z);
      if (midD > SPAWN.maxDistance + e.length * 0.5) continue;
      if (midD < SPAWN.minDistance - e.length * 0.5) continue;

      const t = this.rng.range(0.1, 0.9);
      const dir = this.rng.bool() ? 1 : -1;
      if (e.oneWay && dir < 0) continue;

      this.roads.sample(edgeId, t, 0, _v1);
      const d = Math.hypot(_v1.x - player.x, _v1.z - player.z);
      if (d < SPAWN.minDistance || d > SPAWN.maxDistance) continue;
      if (cam && d < SPAWN.onScreenMinDistance && this.onScreen(_v1, cam)) continue;

      const s = dir > 0 ? t * e.length : (1 - t) * e.length;
      if (!this.laneIsClear(edgeId, dir, s)) continue;

      this.spawnAt(edgeId, dir, s, wantScooter, warm);
      return true;
    }
    return false;
  }

  private laneIsClear(edgeId: number, dir: number, s: number): boolean {
    for (let j = this.edgeHead[edgeId]; j >= 0; j = this.agentNext[j]) {
      const b = this.agents[j];
      if (b.dir !== dir) continue;
      if (Math.abs(b.s - s) < SPAWN.clearance) return false;
    }
    return true;
  }

  private spawnAt(
    edgeId: number,
    dir: number,
    s: number,
    scooter: boolean,
    warm: boolean,
  ): void {
    const slot = this.free.pop();
    if (slot === undefined) return;
    const a = this.agents[slot];
    a.reset();
    a.active = true;
    a.kind = scooter ? 'scooter' : 'car';

    const kit = scooter ? this.scooters : this.cars;
    const typeIndex = scooter ? this.scooters.pickType(this.rng) : this.cars.pickType(this.rng);
    const def = kit.types[typeIndex];
    a.typeIndex = typeIndex;
    a.halfLength = def.length * 0.5;
    a.halfWidth = def.width * 0.5;
    a.height = def.height;
    a.wheelRadius = def.wheelRadius;

    const paint = scooter ? this.scooters.pickPaint(this.rng) : this.cars.pickPaint(typeIndex, this.rng);
    const trim = scooter ? this.scooters.pickTrim(this.rng) : this.cars.pickTrim(typeIndex, this.rng);
    a.paint.setHex(paint, THREE.SRGBColorSpace);
    a.trim.setHex(trim, THREE.SRGBColorSpace);
    // sun-faded, dusty: pull a little chroma and value out of every car
    const fade = 0.86 + this.rng.next() * 0.16;
    a.paint.multiplyScalar(fade);
    a.trim.multiplyScalar(0.9 + this.rng.next() * 0.14);

    const profile = scooter ? SCOOTER_PROFILE : CAR_PROFILE;
    a.baseDesiredSpeed =
      profile.desiredSpeed * def.speedScale * (1 + (this.rng.next() * 2 - 1) * profile.speedSpread);
    a.desiredSpeed = a.baseDesiredSpeed;

    const perDir = lanesPerDirection(this.roads.edges[edgeId]);
    a.lane = perDir > 1 ? (this.rng.next() < 0.7 ? 0 : 1) : 0;
    a.enterEdge(this.roads, edgeId, dir, s);
    a.laneOffset = laneCentreFor(this.roads.edges[edgeId], a.lane, a.halfWidth);
    this.chooseNext(a);
    a.evaluate(this.roads);
    a.snapToGraph();
    a.speed = warm ? a.baseDesiredSpeed * 0.7 : a.baseDesiredSpeed * (0.55 + this.rng.next() * 0.4);
    a.wheelRoll = this.rng.next() * 6.28;

    this.attachBody(a);
    this.activeCount++;
    if (scooter) this.activeScooters++;
  }

  private despawn(a: RoadAgent): void {
    if (!a.active) return;
    this.releaseClaim(a);
    this.detachBody(a);
    if (a.kind === 'scooter') this.activeScooters--;
    this.activeCount--;
    a.reset();
    this.free.push(a.index);
  }

  /* -------------------------------------------------------------- physics */

  private bodyKey(a: RoadAgent): number {
    return a.kind === 'scooter' ? 100 + a.typeIndex : a.typeIndex;
  }

  private attachBody(a: RoadAgent): void {
    const key = this.bodyKey(a);
    const pool = this.bodyPool.get(key);
    let body = pool && pool.length > 0 ? pool.pop() ?? null : null;
    if (body) {
      body.setEnabled(true);
    } else {
      _v1.copy(a.pos);
      _v1.y += a.height * 0.5;
      body = this.physics.createBody({
        kind: 'kinematic',
        shape: {
          type: 'box',
          hx: a.halfWidth,
          hy: a.height * 0.5,
          hz: a.halfLength,
        },
        position: _v1,
        friction: 0.85,
        restitution: 0.05,
        group: GROUP.TRAFFIC,
        mask: TRAFFIC_MASK,
        userData: { kind: 'traffic', agent: a.index },
      });
    }
    this.bodies[a.index] = body;
    this.moveBody(a, body);
  }

  private detachBody(a: RoadAgent): void {
    const body = this.bodies[a.index];
    if (!body) return;
    this.bodies[a.index] = null;
    body.setEnabled(false);
    // park it far below the city so a disabled body can never be queried
    _v1.set(0, -500, 0);
    body.setPosition(_v1);
    const pool = this.bodyPool.get(this.bodyKey(a));
    if (pool) pool.push(body);
    else this.physics.removeBody(body);
  }

  private moveBody(a: RoadAgent, body: BodyHandle): void {
    _v1.copy(a.pos);
    _v1.y += a.height * 0.5;
    body.setPosition(_v1);
    _e1.set(a.pitch, a.heading, a.roll);
    _q1.setFromEuler(_e1);
    body.setQuaternion(_q1);
  }

  private syncBodies(): void {
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active) continue;
      const body = this.bodies[i];
      if (body) this.moveBody(a, body);
    }
  }

  /* ------------------------------------------------------------ rendering */

  private writeInstances(ctx: GameContext): void {
    this.cars.beginFrame();
    this.scooters.beginFrame();
    const camPos = ctx.camera.position;
    const imposterD2 = SPAWN.imposterDistance * SPAWN.imposterDistance;
    this.statImposters = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active) continue;

      const bob = a.kind === 'scooter' ? scooterBob(a, this.elapsed) : 0;
      _v1.set(a.pos.x, a.pos.y + bob, a.pos.z);
      _e1.set(a.pitch, a.heading, a.roll);
      _q1.setFromEuler(_e1);

      const d2 = camPos.distanceToSquared(a.pos);
      if (a.kind === 'car' && d2 > imposterD2) {
        const def = this.cars.types[a.typeIndex];
        _scale1.set(def.width, def.height, def.length);
        _m1.compose(_v1, _q1, _scale1);
        this.cars.imposter.push(
          _m1,
          a.paint.r,
          a.paint.g,
          a.paint.b,
          a.trim.r,
          a.trim.g,
          a.trim.b,
          a.brake,
          a.indL,
          a.indR,
          a.head,
          0,
          0,
        );
        this.statImposters++;
        continue;
      }

      _scale1.set(1, 1, 1);
      _m1.compose(_v1, _q1, _scale1);
      const fleet =
        a.kind === 'scooter' ? this.scooters.fleets[a.typeIndex] : this.cars.fleets[a.typeIndex];
      fleet.push(
        _m1,
        a.paint.r,
        a.paint.g,
        a.paint.b,
        a.trim.r,
        a.trim.g,
        a.trim.b,
        a.brake,
        a.indL,
        a.indR,
        a.head,
        a.wheelRoll,
        a.steer,
      );
    }

    this.cars.endFrame();
    this.scooters.endFrame();
    this.statDrawCalls = this.cars.drawCalls + this.scooters.drawCalls;
    this.statTriangles = this.cars.liveTriangles + this.scooters.liveTriangles;
  }

  /* ---------------------------------------------------------------- misc */

  /** Read-only view of the pool, for the pedestrian system and the harness. */
  get pool(): readonly RoadAgent[] {
    return this.agents;
  }

  get population(): number {
    return this.activeCount;
  }

  stats(): Record<string, number> {
    return {
      trafficAgents: this.activeCount,
      trafficScooters: this.activeScooters,
      trafficTarget: this.targetCars + this.targetScooters,
      trafficDrawCalls: this.statDrawCalls,
      trafficTriangles: this.statTriangles,
      trafficImposters: this.statImposters,
      trafficStopped: this.statStopped,
      trafficBodies: this.activeCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.active) this.despawn(a);
    }
    for (const pool of this.bodyPool.values()) {
      for (const b of pool) this.physics.removeBody(b);
      pool.length = 0;
    }
    this.bodyPool.clear();
    this.cars.dispose();
    this.scooters.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ------------------------------------------------------------- helpers */

/** How much faster or slower traffic runs on a given road class. */
function edgeSpeedFactor(e: RoadEdge): number {
  switch (e.kind) {
    case 'coastal':
      return 1.45;
    case 'plaza':
      return 0.78;
    case 'alley':
      return 0.7;
    default:
      return 1;
  }
}

/** 0 in daylight, 1 in the dark, with a soft dusk/dawn ramp. */
export function nightAmount(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const f = Math.max(0.01, LIGHTS.fadeHours);
  if (h >= LIGHTS.duskHour) return clamp01((h - LIGHTS.duskHour) / f);
  if (h <= LIGHTS.dawnHour) return clamp01((LIGHTS.dawnHour - h) / f);
  return 0;
}
