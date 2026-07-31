/**
 * Loco Lift — one AI road agent, plus the shared road-agent maths.
 *
 * A `RoadAgent` is a car, van, trolley or scooter riding the road graph. It
 * owns *no* Three.js objects and *no* physics: `TrafficSystem` drives it,
 * `VehicleKit`/`ScooterKit` draw it. That split is what lets the whole fleet
 * be simulated head-less in the test harness.
 *
 * ## The model
 *
 *  - **Position** is `(edge, dir, s)` where `s` is metres travelled from the
 *    entry node. That is exact, cheap and can never leave the network.
 *  - **Lane** is a signed lateral offset in the edge's a→b frame, faded toward
 *    the centreline near a node so turns read as arcs.
 *  - **Rendering** chases the exact graph point through a critically-damped
 *    filter, which rounds the corners without any spline work, and the heading
 *    comes from the *filtered* motion so the car faces where it is actually
 *    going.
 *  - **Longitudinal** control is IDM (intelligent driver model) against the
 *    nearest leader, clamped by an intersection stop-line constraint and by
 *    the player-avoidance reaction.
 *
 * Everything here is allocation-free once constructed.
 */
import * as THREE from 'three';
import type { EdgeSample, RoadEdge, RoadGraph, RoadNode } from '../core/types';
import { clamp, damp, wrapAngle } from '../core/MathUtils';
import { ROAD, type AgentProfileTuning } from './TrafficTuning';

/* ============================================================ graph access */

/**
 * The road/sidewalk graph as traffic uses it. `RoadNetworkImpl` supplies
 * `nearestInto` (allocation-free); the optional signature keeps the public
 * `RoadGraph` contract assignable so `main.ts` can pass `world.roads` directly.
 */
export interface NearestIntoGraph {
  nearestInto?(p: THREE.Vector3, maxDist: number, out: EdgeSample): boolean;
}

export type TrafficRoadGraph = RoadGraph & NearestIntoGraph;

/** Allocation-free nearest query with a safe fallback for plain `RoadGraph`s. */
export function nearestOnGraph(
  graph: TrafficRoadGraph,
  p: THREE.Vector3,
  maxDist: number,
  out: EdgeSample,
): boolean {
  if (graph.nearestInto) return graph.nearestInto(p, maxDist, out);
  const hit = graph.nearest(p, maxDist);
  if (!hit) return false;
  out.edgeId = hit.edgeId;
  out.t = hit.t;
  out.dist = hit.dist;
  out.point.copy(hit.point);
  out.tangent.copy(hit.tangent);
  return true;
}

/** A reusable `EdgeSample`, so callers never allocate one per query. */
export function makeEdgeSample(): EdgeSample {
  return {
    edgeId: -1,
    t: 0,
    dist: 0,
    point: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
  };
}

/* =============================================================== lane maths */

/**
 * Signed lane centre offset in metres, measured to the **right of travel**.
 *
 * Puerto Rico drives on the right, so an agent going a→b sits at `+centre`
 * in the graph's a→b frame and one going b→a sits at `−centre`.
 *
 * Single-lane routes (callejones) put everyone on the centreline.
 */
export function laneCentreFor(edge: RoadEdge, lane: number, halfWidth: number): number {
  const half = edge.width * 0.5;
  const maxOffset = Math.max(0, half - halfWidth - ROAD.kerbMargin);
  if (edge.lanes <= 1) return 0;
  const lanesPerDir = Math.max(1, Math.floor(edge.lanes / 2));
  const laneW = edge.width / edge.lanes;
  const idx = clamp(lane, 0, lanesPerDir - 1);
  const centre = (idx + 0.5) * laneW;
  if (centre > maxOffset) return Math.max(0, maxOffset);
  return centre;
}

/** How many lanes this edge offers in one direction. */
export function lanesPerDirection(edge: RoadEdge): number {
  return edge.lanes <= 1 ? 1 : Math.max(1, Math.floor(edge.lanes / 2));
}

/* ================================================================== IDM */

/**
 * Intelligent-driver-model acceleration.
 *
 * @param v      current speed, m/s
 * @param v0     desired free-flow speed, m/s
 * @param gap    bumper-to-bumper distance to the leader, m (Infinity = clear)
 * @param dv     closing speed (v − leaderV), m/s
 * @param p      profile supplying accel/brake/headway/jamGap
 */
export function idmAcceleration(
  v: number,
  v0: number,
  gap: number,
  dv: number,
  p: AgentProfileTuning,
): number {
  const free = 1 - Math.pow(Math.max(0, v) / Math.max(0.5, v0), 4);
  if (!Number.isFinite(gap) || gap > 400) return p.accel * free;
  const g = Math.max(0.35, gap);
  const sStar =
    p.jamGap + Math.max(0, v * p.headway + (v * dv) / (2 * Math.sqrt(p.accel * p.brake)));
  const interaction = (sStar / g) * (sStar / g);
  return p.accel * (free - interaction);
}

/**
 * Deceleration needed to stop in `distance` metres from `v`, as a *negative*
 * acceleration. Returns `-Infinity` when already past the line.
 */
export function stopAcceleration(v: number, distance: number): number {
  if (distance <= 0.05) return -Infinity;
  return -(v * v) / (2 * distance);
}

/* ======================================================= junction conflicts */

const TWO_PI = Math.PI * 2;

const norm = (a: number): number => {
  let x = a % TWO_PI;
  if (x < 0) x += TWO_PI;
  return x;
};

/**
 * Do two movements through the same node conflict?
 *
 * Each movement is a **chord** across the junction circle, from the point where
 * the vehicle enters (on the right-hand side of its approach) to the point
 * where it leaves (again on the right of its exit). Two chords conflict exactly
 * when their endpoints interleave around the circle — which is the textbook
 * definition of two paths crossing, and it correctly says:
 *
 *  - opposing straight-throughs **do not** conflict (right-hand lanes),
 *  - a left turn **does** conflict with the opposing straight,
 *  - a right turn conflicts with almost nothing,
 *  - two movements into the same exit conflict (a merge).
 */
export function movementsConflict(
  inA1: number,
  outA1: number,
  inA2: number,
  outA2: number,
  sameEntry: boolean,
  sameExit: boolean,
): boolean {
  // Same approach: they are simply queued behind one another.
  if (sameEntry) return false;
  // Same exit: a merge. Always yield.
  if (sameExit) return true;
  const b1 = norm(outA1 - inA1);
  const a2 = norm(inA2 - inA1);
  const b2 = norm(outA2 - inA1);
  const inside1 = a2 > 1e-4 && a2 < b1 - 1e-4;
  const inside2 = b2 > 1e-4 && b2 < b1 - 1e-4;
  return inside1 !== inside2;
}

/* ============================================================ hazard field */

/**
 * Coarse "a vehicle is about to be here" grid, in m/s.
 *
 * Traffic and the player stamp their projected path into it every frame;
 * pedestrians read it to decide whether the road is safe to cross. One
 * `Float32Array`, no allocation, O(1) lookups.
 */
export class HazardField {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly data: Float32Array;

  constructor(
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    cell: number,
  ) {
    this.cell = cell;
    this.minX = bounds.minX - cell * 2;
    this.minZ = bounds.minZ - cell * 2;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell) + 4);
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 4);
    this.data = new Float32Array(this.cols * this.rows);
  }

  clear(): void {
    this.data.fill(0);
  }

  /** Stamp one point with a radius in cells. */
  stamp(x: number, z: number, value: number, radiusCells: number): void {
    if (value <= 0) return;
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    const x0 = Math.max(0, cx - radiusCells);
    const x1 = Math.min(this.cols - 1, cx + radiusCells);
    const z0 = Math.max(0, cz - radiusCells);
    const z1 = Math.min(this.rows - 1, cz + radiusCells);
    for (let j = z0; j <= z1; j++) {
      const row = j * this.cols;
      for (let i = x0; i <= x1; i++) {
        const k = row + i;
        if (this.data[k] < value) this.data[k] = value;
      }
    }
  }

  /** Stamp a body's projected path over `lookahead` seconds. */
  stampMotion(
    x: number,
    z: number,
    vx: number,
    vz: number,
    weight: number,
    lookahead: number,
    steps: number,
    radiusCells: number,
  ): void {
    const speed = Math.hypot(vx, vz);
    const value = Math.max(speed * weight, weight * 0.6);
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * lookahead;
      this.stamp(x + vx * t, z + vz * t, value * (1 - (i / steps) * 0.35), radiusCells);
    }
  }

  at(x: number, z: number): number {
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return 0;
    return this.data[cz * this.cols + cx];
  }
}

/* ================================================================== agent */

export type AgentKind = 'car' | 'scooter';

/** Reasons an agent is currently braking, for the light logic and debugging. */
export const AGENT_STATE = {
  CRUISE: 0,
  FOLLOW: 1,
  YIELD: 2,
  SIGNAL: 3,
  EVADE: 4,
  SHUNTED: 5,
} as const;

const _v1 = new THREE.Vector3();

export class RoadAgent {
  /** slot index in the pool; stable for the agent's lifetime */
  index = -1;
  active = false;
  kind: AgentKind = 'car';
  /** index into `VehicleKit.types` or `ScooterKit.types` */
  typeIndex = 0;

  /* ---- geometry (copied from the type at spawn) ---- */
  halfLength = 2.2;
  halfWidth = 0.9;
  height = 1.5;
  wheelRadius = 0.33;

  /* ---- graph position ---- */
  edge = -1;
  /** +1 = travelling a→b, −1 = b→a */
  dir = 1;
  /** metres from the entry node along the edge */
  s = 0;
  edgeLen = 1;
  entryNode = -1;
  exitNode = -1;
  /** chosen successor, decided the moment the agent enters an edge */
  nextEdge = -1;
  nextDir = 1;
  /** signed turn angle at the exit node, rad (−left, +right) */
  nextTurn = 0;
  lane = 0;
  laneOffset = 0;

  /* ---- longitudinal ---- */
  speed = 0;
  desiredSpeed = 9;
  baseDesiredSpeed = 9;
  accel = 0;
  state: number = AGENT_STATE.CRUISE;

  /* ---- lateral ---- */
  swerve = 0;
  swerveTarget = 0;
  /** scooters only: extra pull toward the centreline when filtering */
  split = 0;

  /* ---- visual state ---- */
  readonly pos = new THREE.Vector3();
  readonly graphPos = new THREE.Vector3();
  readonly tangent = new THREE.Vector3(0, 0, 1);
  heading = 0;
  roll = 0;
  pitch = 0;
  wheelRoll = 0;
  steer = 0;
  yawRate = 0;

  /* ---- lamps ---- */
  brake = 0;
  indL = 0;
  indR = 0;
  head = 0;

  /* ---- interaction ---- */
  reactTimer = 0;
  hornTimer = 0;
  brakeFlash = 0;
  shuntTimer = 0;
  shuntCooldown = 0;
  readonly shuntVel = new THREE.Vector3();
  shuntSpin = 0;
  claimNode = -1;
  claimSlot = -1;
  stuckTimer = 0;
  age = 0;

  /* ---- appearance ---- */
  readonly paint = new THREE.Color();
  readonly trim = new THREE.Color();

  /* ---- physics ---- */
  bodyIndex = -1;

  /** Radius that fully contains the agent — used for broad-phase tests. */
  get boundRadius(): number {
    return Math.hypot(this.halfLength, this.halfWidth);
  }

  /** Distance remaining on the current edge, metres. */
  get remaining(): number {
    return this.edgeLen - this.s;
  }

  /** Arc parameter in the edge's own a→b frame. */
  get t(): number {
    const f = clamp(this.s / Math.max(1e-4, this.edgeLen), 0, 1);
    return this.dir > 0 ? f : 1 - f;
  }

  /**
   * Lane offset expressed in the edge's a→b frame, with the near-node fade
   * applied. `sample(edge, t, thisValue)` puts the agent exactly where it
   * should be.
   */
  sampleOffset(): number {
    const fadeLen = ROAD.laneFadeLength;
    const dEnd = Math.min(this.s, this.edgeLen - this.s);
    const f =
      fadeLen <= 0
        ? 1
        : ROAD.laneFadeAtNode + (1 - ROAD.laneFadeAtNode) * clamp(dEnd / fadeLen, 0, 1);
    return this.dir * (this.laneOffset * f + this.swerve - this.split);
  }

  /** Bind the agent to an edge; recomputes cached edge data. */
  enterEdge(graph: TrafficRoadGraph, edgeId: number, dir: number, s: number): void {
    const e = graph.edges[edgeId];
    this.edge = edgeId;
    this.dir = dir >= 0 ? 1 : -1;
    this.edgeLen = Math.max(0.5, e.length);
    this.s = clamp(s, 0, this.edgeLen);
    this.entryNode = this.dir > 0 ? e.a : e.b;
    this.exitNode = this.dir > 0 ? e.b : e.a;
    this.laneOffset = laneCentreFor(e, this.lane, this.halfWidth);
    this.nextEdge = -1;
  }

  /** Exact graph position + tangent for the current `(edge, dir, s)`. */
  evaluate(graph: TrafficRoadGraph): void {
    const t = this.t;
    graph.sample(this.edge, t, this.sampleOffset(), this.graphPos);
    graph.tangent(this.edge, t, this.tangent);
    if (this.dir < 0) this.tangent.multiplyScalar(-1);
    this.graphPos.y += ROAD.rideLift;
  }

  /** Snap the rendered transform straight onto the graph (spawn / recycle). */
  snapToGraph(): void {
    this.pos.copy(this.graphPos);
    this.heading = Math.atan2(-this.tangent.x, -this.tangent.z);
    this.roll = 0;
    this.pitch = 0;
    this.yawRate = 0;
  }

  /**
   * Chase the graph position. Corner rounding, body roll and the derived
   * heading all fall out of this one filter.
   */
  followGraph(dt: number): void {
    const dx = this.graphPos.x - this.pos.x;
    const dy = this.graphPos.y - this.pos.y;
    const dz = this.graphPos.z - this.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > ROAD.snapDistance * ROAD.snapDistance) {
      this.snapToGraph();
      return;
    }
    const k = 1 - Math.exp(-ROAD.followRate * dt);
    const mx = dx * k;
    const my = dy * k;
    const mz = dz * k;
    this.pos.x += mx;
    this.pos.y += my;
    this.pos.z += mz;

    // heading from actual motion, so the nose leads through a corner
    const moved = Math.hypot(mx, mz);
    if (moved > ROAD.headingMinSpeed * dt) {
      const want = Math.atan2(-mx, -mz);
      const delta = wrapAngle(want - this.heading);
      const step = delta * (1 - Math.exp(-ROAD.headingRate * dt));
      this.heading += step;
      this.yawRate = dt > 1e-5 ? step / dt : 0;
    } else {
      this.yawRate = damp(this.yawRate, 0, 6, dt);
    }
  }

  /** Free-body motion while shunted by the player. */
  followShunt(dt: number): void {
    const drag = Math.exp(-2.4 * dt);
    this.shuntVel.multiplyScalar(drag);
    this.pos.x += this.shuntVel.x * dt;
    this.pos.y += this.shuntVel.y * dt;
    this.pos.z += this.shuntVel.z * dt;
    this.heading += this.shuntSpin * dt;
    this.yawRate = this.shuntSpin;
    this.shuntSpin *= drag;
  }

  /** Body roll/pitch from yaw rate and longitudinal acceleration. */
  updateBodyAttitude(dt: number, rollGain: number, maxRoll: number): void {
    const targetRoll = clamp(-this.yawRate * this.speed * rollGain, -maxRoll, maxRoll);
    const targetPitch = clamp(-this.accel * ROAD.bodyPitch, -0.07, 0.07);
    this.roll = damp(this.roll, targetRoll, ROAD.bodyRate, dt);
    this.pitch = damp(this.pitch, targetPitch, ROAD.bodyRate, dt);
  }

  /** Spin the wheels to match ground speed and point the fronts at the turn. */
  updateWheels(dt: number): void {
    this.wheelRoll -= (this.speed * dt) / Math.max(0.12, this.wheelRadius);
    if (this.wheelRoll < -1e6 || this.wheelRoll > 1e6) this.wheelRoll = 0;
    const want =
      this.speed > 0.6 ? clamp((-this.yawRate / Math.max(1, this.speed)) * 3.4, -0.52, 0.52) : 0;
    this.steer = damp(this.steer, want, 9, dt);
  }

  /** Forward vector in world space (the agent faces −Z in its own frame). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  /** True when `p` is inside the agent's oriented bounding box + `pad`. */
  containsPoint(p: THREE.Vector3, pad: number): boolean {
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    const c = Math.cos(this.heading);
    const sn = Math.sin(this.heading);
    // world → local: forward is −Z, so local z = −(dx·(−sin) + dz·(−cos))
    const lz = -(dx * -sn + dz * -c);
    const lx = dx * c - dz * sn;
    return (
      Math.abs(lx) <= this.halfWidth + pad && Math.abs(lz) <= this.halfLength + pad
    );
  }

  /** Reset every transient so a recycled slot never inherits old behaviour. */
  reset(): void {
    this.active = false;
    this.edge = -1;
    this.nextEdge = -1;
    this.speed = 0;
    this.accel = 0;
    this.swerve = 0;
    this.swerveTarget = 0;
    this.split = 0;
    this.brake = 0;
    this.indL = 0;
    this.indR = 0;
    this.head = 0;
    this.reactTimer = 0;
    this.hornTimer = 0;
    this.brakeFlash = 0;
    this.shuntTimer = 0;
    this.shuntCooldown = 0;
    this.shuntVel.set(0, 0, 0);
    this.shuntSpin = 0;
    this.claimNode = -1;
    this.claimSlot = -1;
    this.stuckTimer = 0;
    this.age = 0;
    this.roll = 0;
    this.pitch = 0;
    this.yawRate = 0;
    this.state = AGENT_STATE.CRUISE;
  }
}

/* ====================================================== junction geometry */

/**
 * Bearing of the direction that leaves `node` along `edge`, in the XZ plane.
 * Precomputed once per (edge, end) by the traffic system.
 */
export function approachBearing(
  graph: TrafficRoadGraph,
  edgeId: number,
  node: number,
  out: THREE.Vector3,
): number {
  const e = graph.edges[edgeId];
  const atA = e.a === node;
  graph.tangent(edgeId, atA ? 0 : 1, out);
  if (!atA) out.multiplyScalar(-1);
  return Math.atan2(out.z, out.x);
}

/** Signed turn angle going from approach `inB` to approach `outB`, rad. */
export function turnAngle(inBearing: number, outBearing: number): number {
  // the vehicle arrives travelling along −inBearing, leaves along +outBearing
  return wrapAngle(outBearing - (inBearing + Math.PI));
}

/** True when a node has at least one edge traffic may legally use. */
export function nodeHasTraffic(graph: TrafficRoadGraph, node: RoadNode): boolean {
  for (let i = 0; i < node.edges.length; i++) {
    if (!graph.edges[node.edges[i]].noTraffic) return true;
  }
  return false;
}

/** Number of drivable edges at a node. */
export function drivableDegree(graph: TrafficRoadGraph, node: RoadNode): number {
  let n = 0;
  for (let i = 0; i < node.edges.length; i++) {
    if (!graph.edges[node.edges[i]].noTraffic) n++;
  }
  return n;
}

/** Angle-axis bin (0 or 1) used for the two-phase signal cycle. */
export function bearingAxis(bearing: number): number {
  let a = bearing % Math.PI;
  if (a < 0) a += Math.PI;
  return a < Math.PI * 0.5 ? 0 : 1;
}

/** Lateral distance of `p` from the agent's travel line, signed to the right. */
export function lateralOffset(agent: RoadAgent, p: THREE.Vector3): number {
  agent.forward(_v1);
  const rx = -_v1.z;
  const rz = _v1.x;
  return (p.x - agent.pos.x) * rx + (p.z - agent.pos.z) * rz;
}
