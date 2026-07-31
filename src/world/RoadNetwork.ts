/**
 * Loco Lift — road graph implementation.
 *
 * A `RoadNetworkImpl` owns nodes + edges and everything derived from them:
 *
 *  - **baked polylines**: every edge is flattened once into a polyline. Edges
 *    with `via` control points run a centripetal Catmull-Rom through
 *    `[a, ...via, b]`; straight edges stay two points.
 *  - **arc-length tables**: `sample(t)` is arc-length parameterised, so a
 *    vehicle stepping `t` at a constant rate moves at a constant speed even
 *    through curves.
 *  - **uniform spatial hash** (CSR layout, no per-query allocation) over every
 *    polyline segment, so `nearest()` is cheap enough to call every frame from
 *    traffic and mission code.
 *  - **A\*** over nodes with a kind-weighted cost.
 *
 * Nothing here touches Three.js scene objects — it is pure data + math so the
 * layout generator can be validated head-less.
 */
import * as THREE from 'three';
import type { EdgeSample, RoadEdge, RoadGraph, RoadKind, RoadNode } from '../core/types';
import { clamp } from '../core/MathUtils';

/* ------------------------------------------------------------------ kinds */

export interface RoadKindDefaults {
  width: number;
  lanes: number;
  oneWay: boolean;
  noTraffic: boolean;
}

/** Sensible per-kind defaults. Old San Juan streets really are 7-9 m wide. */
export const ROAD_KIND_DEFAULTS: Readonly<Record<RoadKind, RoadKindDefaults>> = {
  street: { width: 8, lanes: 2, oneWay: false, noTraffic: false },
  alley: { width: 4, lanes: 1, oneWay: true, noTraffic: true },
  coastal: { width: 14, lanes: 4, oneWay: false, noTraffic: false },
  plaza: { width: 12, lanes: 2, oneWay: false, noTraffic: false },
  stairs: { width: 5, lanes: 1, oneWay: false, noTraffic: true },
  ramp: { width: 7, lanes: 1, oneWay: false, noTraffic: true },
  rooftop: { width: 5, lanes: 1, oneWay: false, noTraffic: true },
};

/** Routing preference. High = avoid. Stairs are a shortcut, not a highway. */
export const ROAD_KIND_COST: Readonly<Record<RoadKind, number>> = {
  street: 1.0,
  alley: 1.7,
  coastal: 0.85,
  plaza: 1.15,
  stairs: 2.8,
  ramp: 6.0,
  rooftop: 3.2,
};

/* ------------------------------------------------------------- baked edge */

/** Flattened polyline + arc-length table for one edge. */
export interface BakedEdge {
  /** flat xyz triples, `count * 3` long */
  points: Float32Array;
  /** cumulative arc length at each point, `count` long, cum[0] === 0 */
  cum: Float32Array;
  count: number;
  length: number;
}

/* ------------------------------------------------------------ small heap */

/** Binary min-heap over integer ids keyed by a float score. Reused, no GC. */
class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private size = 0;

  constructor(capacity: number) {
    this.ids = new Int32Array(Math.max(8, capacity));
    this.keys = new Float64Array(Math.max(8, capacity));
  }

  clear(): void {
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }

  private grow(): void {
    const ids = new Int32Array(this.ids.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    ids.set(this.ids);
    keys.set(this.keys);
    this.ids = ids;
    this.keys = keys;
  }

  push(id: number, key: number): void {
    if (this.size === this.ids.length) this.grow();
    let i = this.size++;
    this.ids[i] = id;
    this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      const ti = this.ids[p];
      const tk = this.keys[p];
      this.ids[p] = this.ids[i];
      this.keys[p] = this.keys[i];
      this.ids[i] = ti;
      this.keys[i] = tk;
      i = p;
    }
  }

  pop(): number {
    if (this.size === 0) return -1;
    const top = this.ids[0];
    this.size--;
    if (this.size > 0) {
      this.ids[0] = this.ids[this.size];
      this.keys[0] = this.keys[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        const ti = this.ids[m];
        const tk = this.keys[m];
        this.ids[m] = this.ids[i];
        this.keys[m] = this.keys[i];
        this.ids[i] = ti;
        this.keys[i] = tk;
        i = m;
      }
    }
    return top;
  }
}

/* --------------------------------------------------------------- network */

const HASH_CELL = 14; // metres — a touch wider than the widest street
const NODE_CELL = 26;

export class RoadNetworkImpl implements RoadGraph {
  readonly nodes: RoadNode[];
  readonly edges: RoadEdge[];

  /** flattened polyline + arc-length table, index-parallel with `edges` */
  private baked: BakedEdge[] = [];

  /* -- segment spatial hash (CSR) -- */
  private minX = 0;
  private minZ = 0;
  private gw = 1;
  private gh = 1;
  private cellStart: Int32Array = new Int32Array(1);
  private cellItems: Int32Array = new Int32Array(0);
  /** per global-segment: edge index */
  private segEdge: Int32Array = new Int32Array(0);
  /** per global-segment: index of the first point inside the edge polyline */
  private segIndex: Int32Array = new Int32Array(0);
  private segStamp: Int32Array = new Int32Array(0);
  private stamp = 0;

  /* -- node spatial hash (CSR) -- */
  private nMinX = 0;
  private nMinZ = 0;
  private ngw = 1;
  private ngh = 1;
  private nodeStart: Int32Array = new Int32Array(1);
  private nodeItems: Int32Array = new Int32Array(0);

  /* -- A* scratch, sized once -- */
  private aStarG: Float64Array;
  private aStarF: Float64Array;
  private aStarPrev: Int32Array;
  private aStarState: Uint8Array;
  private heap: MinHeap;

  /* -- reusable maths temporaries; never handed to callers -- */
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpT = new THREE.Vector3();

  readonly bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  constructor(nodes: RoadNode[], edges: RoadEdge[]) {
    this.nodes = nodes;
    this.edges = edges;

    this.aStarG = new Float64Array(nodes.length);
    this.aStarF = new Float64Array(nodes.length);
    this.aStarPrev = new Int32Array(nodes.length);
    this.aStarState = new Uint8Array(nodes.length);
    this.heap = new MinHeap(Math.max(16, nodes.length));

    this.bakeAll();
    this.buildSegmentHash();
    this.buildNodeHash();
  }

  /* ------------------------------------------------------------- baking */

  private bakeAll(): void {
    this.baked.length = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const baked = this.bakeEdge(e);
      this.baked.push(baked);
      e.length = baked.length;
    }
  }

  private bakeEdge(e: RoadEdge): BakedEdge {
    const a = this.nodes[e.a].pos;
    const b = this.nodes[e.b].pos;
    let pts: THREE.Vector3[];

    if (e.via.length === 0) {
      pts = [a.clone(), b.clone()];
    } else {
      const ctrl: THREE.Vector3[] = [a.clone()];
      for (const v of e.via) ctrl.push(v.clone());
      ctrl.push(b.clone());
      const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal', 0.5);
      let chord = 0;
      for (let i = 1; i < ctrl.length; i++) chord += ctrl[i].distanceTo(ctrl[i - 1]);
      const n = Math.round(clamp(chord / 3.5, 10, 220));
      pts = curve.getPoints(n);
      // Catmull-Rom is interpolating: pin the ends exactly onto the nodes.
      pts[0].copy(a);
      pts[pts.length - 1].copy(b);
    }

    const count = pts.length;
    const points = new Float32Array(count * 3);
    const cum = new Float32Array(count);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const p = pts[i];
      points[i * 3] = p.x;
      points[i * 3 + 1] = p.y;
      points[i * 3 + 2] = p.z;
      if (i > 0) {
        const dx = p.x - pts[i - 1].x;
        const dy = p.y - pts[i - 1].y;
        const dz = p.z - pts[i - 1].z;
        total += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      cum[i] = total;
    }
    return { points, cum, count, length: Math.max(total, 1e-4) };
  }

  /** Read-only access to an edge's baked polyline (ground meshing, carving). */
  polyline(edgeId: number): BakedEdge {
    return this.baked[edgeId];
  }

  /* --------------------------------------------------------- hash build */

  private buildSegmentHash(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let segCount = 0;
    for (const b of this.baked) {
      segCount += b.count - 1;
      for (let i = 0; i < b.count; i++) {
        const x = b.points[i * 3];
        const z = b.points[i * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    if (!Number.isFinite(minX)) {
      minX = maxX = minZ = maxZ = 0;
    }
    this.bounds.minX = minX;
    this.bounds.maxX = maxX;
    this.bounds.minZ = minZ;
    this.bounds.maxZ = maxZ;

    this.minX = minX - HASH_CELL;
    this.minZ = minZ - HASH_CELL;
    this.gw = Math.max(1, Math.ceil((maxX - minX) / HASH_CELL) + 3);
    this.gh = Math.max(1, Math.ceil((maxZ - minZ) / HASH_CELL) + 3);

    this.segEdge = new Int32Array(segCount);
    this.segIndex = new Int32Array(segCount);
    this.segStamp = new Int32Array(segCount);

    let s = 0;
    for (let ei = 0; ei < this.baked.length; ei++) {
      const b = this.baked[ei];
      for (let i = 0; i < b.count - 1; i++) {
        this.segEdge[s] = ei;
        this.segIndex[s] = i;
        s++;
      }
    }

    const cells = this.gw * this.gh;
    const counts = new Int32Array(cells + 1);

    // pass 1 — count
    for (let si = 0; si < segCount; si++) {
      const b = this.baked[this.segEdge[si]];
      const i = this.segIndex[si];
      const x0 = b.points[i * 3];
      const z0 = b.points[i * 3 + 2];
      const x1 = b.points[i * 3 + 3];
      const z1 = b.points[i * 3 + 5];
      const cx0 = this.cellX(Math.min(x0, x1));
      const cx1 = this.cellX(Math.max(x0, x1));
      const cz0 = this.cellZ(Math.min(z0, z1));
      const cz1 = this.cellZ(Math.max(z0, z1));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) counts[cz * this.gw + cx + 1]++;
      }
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[cells]);
    const cursor = new Int32Array(cells);

    // pass 2 — fill
    for (let si = 0; si < segCount; si++) {
      const b = this.baked[this.segEdge[si]];
      const i = this.segIndex[si];
      const x0 = b.points[i * 3];
      const z0 = b.points[i * 3 + 2];
      const x1 = b.points[i * 3 + 3];
      const z1 = b.points[i * 3 + 5];
      const cx0 = this.cellX(Math.min(x0, x1));
      const cx1 = this.cellX(Math.max(x0, x1));
      const cz0 = this.cellZ(Math.min(z0, z1));
      const cz1 = this.cellZ(Math.max(z0, z1));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cz * this.gw + cx;
          this.cellItems[this.cellStart[c] + cursor[c]] = si;
          cursor[c]++;
        }
      }
    }
  }

  private buildNodeHash(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const n of this.nodes) {
      if (n.pos.x < minX) minX = n.pos.x;
      if (n.pos.x > maxX) maxX = n.pos.x;
      if (n.pos.z < minZ) minZ = n.pos.z;
      if (n.pos.z > maxZ) maxZ = n.pos.z;
    }
    if (!Number.isFinite(minX)) minX = maxX = minZ = maxZ = 0;
    this.nMinX = minX - NODE_CELL;
    this.nMinZ = minZ - NODE_CELL;
    this.ngw = Math.max(1, Math.ceil((maxX - minX) / NODE_CELL) + 3);
    this.ngh = Math.max(1, Math.ceil((maxZ - minZ) / NODE_CELL) + 3);

    const cells = this.ngw * this.ngh;
    const counts = new Int32Array(cells + 1);
    for (const n of this.nodes) {
      const c = this.nodeCell(n.pos.x, n.pos.z);
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.nodeStart = counts;
    this.nodeItems = new Int32Array(this.nodes.length);
    const cursor = new Int32Array(cells);
    for (let i = 0; i < this.nodes.length; i++) {
      const c = this.nodeCell(this.nodes[i].pos.x, this.nodes[i].pos.z);
      this.nodeItems[this.nodeStart[c] + cursor[c]] = i;
      cursor[c]++;
    }
  }

  private cellX(x: number): number {
    return clamp(Math.floor((x - this.minX) / HASH_CELL), 0, this.gw - 1);
  }

  private cellZ(z: number): number {
    return clamp(Math.floor((z - this.minZ) / HASH_CELL), 0, this.gh - 1);
  }

  private nodeCell(x: number, z: number): number {
    const cx = clamp(Math.floor((x - this.nMinX) / NODE_CELL), 0, this.ngw - 1);
    const cz = clamp(Math.floor((z - this.nMinZ) / NODE_CELL), 0, this.ngh - 1);
    return cz * this.ngw + cx;
  }

  /* --------------------------------------------------------- evaluation */

  /** index of the polyline segment containing arc length `s` */
  private locate(b: BakedEdge, s: number): number {
    let lo = 0;
    let hi = b.count - 1;
    if (s <= 0) return 0;
    if (s >= b.length) return b.count - 2;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  sample(edgeId: number, t: number, laneOffset: number, out?: THREE.Vector3): THREE.Vector3 {
    const o = out ?? new THREE.Vector3();
    const b = this.baked[edgeId];
    if (!b) return o.set(0, 0, 0);
    const s = clamp(t, 0, 1) * b.length;
    const i = this.locate(b, s);
    const seg = Math.max(1e-6, b.cum[i + 1] - b.cum[i]);
    const f = clamp((s - b.cum[i]) / seg, 0, 1);
    const x0 = b.points[i * 3];
    const y0 = b.points[i * 3 + 1];
    const z0 = b.points[i * 3 + 2];
    const x1 = b.points[i * 3 + 3];
    const y1 = b.points[i * 3 + 4];
    const z1 = b.points[i * 3 + 5];
    o.set(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f);
    if (laneOffset !== 0) {
      this.tangentAtSegment(b, i, this.tmpT);
      // right-hand side of travel: forward x up  ->  (-tz, 0, tx)
      o.x += -this.tmpT.z * laneOffset;
      o.z += this.tmpT.x * laneOffset;
    }
    return o;
  }

  tangent(edgeId: number, t: number, out?: THREE.Vector3): THREE.Vector3 {
    const o = out ?? new THREE.Vector3();
    const b = this.baked[edgeId];
    if (!b) return o.set(0, 0, 1);
    const s = clamp(t, 0, 1) * b.length;
    const i = this.locate(b, s);
    return this.tangentAtSegment(b, i, o);
  }

  private tangentAtSegment(b: BakedEdge, i: number, out: THREE.Vector3): THREE.Vector3 {
    const x0 = b.points[i * 3];
    const y0 = b.points[i * 3 + 1];
    const z0 = b.points[i * 3 + 2];
    const x1 = b.points[i * 3 + 3];
    const y1 = b.points[i * 3 + 4];
    const z1 = b.points[i * 3 + 5];
    out.set(x1 - x0, y1 - y0, z1 - z0);
    const len = out.length();
    if (len < 1e-6) out.set(0, 0, 1);
    else out.multiplyScalar(1 / len);
    return out;
  }

  /** unit "right of travel" vector at t (perpendicular, horizontal) */
  right(edgeId: number, t: number, out?: THREE.Vector3): THREE.Vector3 {
    const o = out ?? new THREE.Vector3();
    this.tangent(edgeId, t, this.tmpT);
    o.set(-this.tmpT.z, 0, this.tmpT.x);
    const l = Math.hypot(o.x, o.z);
    if (l > 1e-6) o.multiplyScalar(1 / l);
    else o.set(1, 0, 0);
    return o;
  }

  /* ------------------------------------------------------------ nearest */

  /**
   * Closest point on the network. Allocates one small result object; hot loops
   * that run per-frame per-agent should use {@link nearestInto} instead.
   */
  nearest(p: THREE.Vector3, maxDist = 60): EdgeSample | null {
    const out: EdgeSample = {
      edgeId: -1,
      t: 0,
      dist: Infinity,
      point: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
    };
    return this.nearestInto(p, maxDist, out) ? out : null;
  }

  /** Allocation-free variant. Returns false when nothing is within `maxDist`. */
  nearestInto(p: THREE.Vector3, maxDist: number, out: EdgeSample): boolean {
    const radius = Number.isFinite(maxDist) ? Math.max(0.5, maxDist) : 400;
    const cx0 = this.cellX(p.x - radius);
    const cx1 = this.cellX(p.x + radius);
    const cz0 = this.cellZ(p.z - radius);
    const cz1 = this.cellZ(p.z + radius);

    this.stamp++;
    const st = this.stamp;
    let bestD2 = radius * radius;
    let bestSeg = -1;
    let bestF = 0;

    for (let cz = cz0; cz <= cz1; cz++) {
      const rowBase = cz * this.gw;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = rowBase + cx;
        const s0 = this.cellStart[c];
        const s1 = this.cellStart[c + 1];
        for (let k = s0; k < s1; k++) {
          const si = this.cellItems[k];
          if (this.segStamp[si] === st) continue;
          this.segStamp[si] = st;
          const b = this.baked[this.segEdge[si]];
          const i = this.segIndex[si];
          const ax = b.points[i * 3];
          const az = b.points[i * 3 + 2];
          const bx = b.points[i * 3 + 3];
          const bz = b.points[i * 3 + 5];
          const ex = bx - ax;
          const ez = bz - az;
          const len2 = ex * ex + ez * ez;
          let f = 0;
          if (len2 > 1e-9) f = clamp(((p.x - ax) * ex + (p.z - az) * ez) / len2, 0, 1);
          const qx = ax + ex * f;
          const qz = az + ez * f;
          const dx = p.x - qx;
          const dz = p.z - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestSeg = si;
            bestF = f;
          }
        }
      }
    }

    if (bestSeg < 0) return false;

    const ei = this.segEdge[bestSeg];
    const i = this.segIndex[bestSeg];
    const b = this.baked[ei];
    const s = b.cum[i] + (b.cum[i + 1] - b.cum[i]) * bestF;
    out.edgeId = ei;
    out.t = clamp(s / b.length, 0, 1);
    out.dist = Math.sqrt(bestD2);
    const x0 = b.points[i * 3];
    const y0 = b.points[i * 3 + 1];
    const z0 = b.points[i * 3 + 2];
    out.point.set(
      x0 + (b.points[i * 3 + 3] - x0) * bestF,
      y0 + (b.points[i * 3 + 4] - y0) * bestF,
      z0 + (b.points[i * 3 + 5] - z0) * bestF,
    );
    this.tangentAtSegment(b, i, out.tangent);
    return true;
  }

  nearestNode(p: THREE.Vector3): number {
    let best = -1;
    let bestD2 = Infinity;
    for (let ring = 0; ring < 24; ring++) {
      const cx = clamp(Math.floor((p.x - this.nMinX) / NODE_CELL), 0, this.ngw - 1);
      const cz = clamp(Math.floor((p.z - this.nMinZ) / NODE_CELL), 0, this.ngh - 1);
      const x0 = Math.max(0, cx - ring);
      const x1 = Math.min(this.ngw - 1, cx + ring);
      const z0 = Math.max(0, cz - ring);
      const z1 = Math.min(this.ngh - 1, cz + ring);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          // only walk the newly added ring
          if (ring > 0 && x > cx - ring && x < cx + ring && z > cz - ring && z < cz + ring) continue;
          const c = z * this.ngw + x;
          for (let k = this.nodeStart[c]; k < this.nodeStart[c + 1]; k++) {
            const ni = this.nodeItems[k];
            const q = this.nodes[ni].pos;
            const dx = q.x - p.x;
            const dz = q.z - p.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = ni;
            }
          }
        }
      }
      // one extra ring after a hit guarantees correctness for the L-inf metric
      if (best >= 0 && Math.sqrt(bestD2) <= ring * NODE_CELL) break;
      if (x0 === 0 && z0 === 0 && x1 === this.ngw - 1 && z1 === this.ngh - 1) break;
    }
    return best;
  }

  /** Nearest node that has at least one edge of a kind traffic can use. */
  nearestDrivableNode(p: THREE.Vector3): number {
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      let ok = false;
      for (const e of n.edges) {
        if (!this.edges[e].noTraffic) {
          ok = true;
          break;
        }
      }
      if (!ok) continue;
      const dx = n.pos.x - p.x;
      const dz = n.pos.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  /* --------------------------------------------------------------- A* */

  path(fromNode: number, toNode: number): number[] {
    const n = this.nodes.length;
    if (fromNode < 0 || toNode < 0 || fromNode >= n || toNode >= n) return [];
    if (fromNode === toNode) return [fromNode];

    const g = this.aStarG;
    const f = this.aStarF;
    const prev = this.aStarPrev;
    const state = this.aStarState;
    g.fill(Infinity);
    f.fill(Infinity);
    prev.fill(-1);
    state.fill(0);

    const goal = this.nodes[toNode].pos;
    const heur = (i: number): number => {
      const p = this.nodes[i].pos;
      return Math.hypot(p.x - goal.x, p.z - goal.z) * 0.85;
    };

    this.heap.clear();
    g[fromNode] = 0;
    f[fromNode] = heur(fromNode);
    this.heap.push(fromNode, f[fromNode]);

    while (this.heap.length > 0) {
      const cur = this.heap.pop();
      if (cur < 0) break;
      if (state[cur] === 2) continue;
      state[cur] = 2;
      if (cur === toNode) break;
      const node = this.nodes[cur];
      for (let k = 0; k < node.edges.length; k++) {
        const e = this.edges[node.edges[k]];
        const other = e.a === cur ? e.b : e.a;
        if (state[other] === 2) continue;
        if (e.oneWay && e.a !== cur) continue;
        const cost = e.length * ROAD_KIND_COST[e.kind];
        const ng = g[cur] + cost;
        if (ng < g[other]) {
          g[other] = ng;
          prev[other] = cur;
          f[other] = ng + heur(other);
          state[other] = 1;
          this.heap.push(other, f[other]);
        }
      }
    }

    if (state[toNode] !== 2 && prev[toNode] < 0) return [];
    const out: number[] = [];
    let cur = toNode;
    let guard = 0;
    while (cur !== -1 && guard++ < n + 2) {
      out.push(cur);
      if (cur === fromNode) break;
      cur = prev[cur];
    }
    if (out[out.length - 1] !== fromNode) return [];
    out.reverse();
    return out;
  }

  /** Edge id joining two adjacent nodes, or -1. */
  edgeBetween(a: number, b: number): number {
    const na = this.nodes[a];
    if (!na) return -1;
    for (const e of na.edges) {
      const ed = this.edges[e];
      if ((ed.a === a && ed.b === b) || (ed.b === a && ed.a === b)) return e;
    }
    return -1;
  }

  /** Total drivable centreline length, metres. Useful for traffic budgeting. */
  totalLength(includeNoTraffic = false): number {
    let sum = 0;
    for (const e of this.edges) {
      if (!includeNoTraffic && e.noTraffic) continue;
      sum += e.length;
    }
    return sum;
  }
}

/* --------------------------------------------------------------- builder */

export interface EdgeOptions {
  kind?: RoadKind;
  width?: number;
  lanes?: number;
  oneWay?: boolean;
  noTraffic?: boolean;
  via?: THREE.Vector3[];
}

/**
 * Mutable staging area for a road graph. `CityLayout` pushes nodes and edges in
 * whatever order is convenient, splits edges to hang alleys off them, then
 * calls `build()` once to get an immutable, baked `RoadNetworkImpl`.
 */
export class RoadGraphBuilder {
  private _nodes: RoadNode[] = [];
  private _edges: RoadEdge[] = [];

  get nodeCount(): number {
    return this._nodes.length;
  }

  get edgeCount(): number {
    return this._edges.length;
  }

  get nodes(): readonly RoadNode[] {
    return this._nodes;
  }

  get edges(): readonly RoadEdge[] {
    return this._edges;
  }

  addNode(pos: THREE.Vector3, kind: RoadNode['kind'] = 'intersection', signalOffset = -1): number {
    const id = this._nodes.length;
    this._nodes.push({ id, pos: pos.clone(), edges: [], kind, signalOffset });
    return id;
  }

  node(id: number): RoadNode {
    return this._nodes[id];
  }

  edge(id: number): RoadEdge {
    return this._edges[id];
  }

  /** Position of a node — convenience so callers don't reach through `node()`. */
  pos(id: number): THREE.Vector3 {
    return this._nodes[id].pos;
  }

  addEdge(a: number, b: number, opts: EdgeOptions = {}): number {
    if (a === b) throw new Error(`RoadGraphBuilder: degenerate edge on node ${a}`);
    if (!this._nodes[a] || !this._nodes[b]) {
      throw new Error(`RoadGraphBuilder: edge references missing node (${a} -> ${b})`);
    }
    const existing = this.find(a, b);
    if (existing >= 0) return existing;

    const kind: RoadKind = opts.kind ?? 'street';
    const d = ROAD_KIND_DEFAULTS[kind];
    const via = (opts.via ?? []).map((v) => v.clone());
    const id = this._edges.length;
    const pa = this._nodes[a].pos;
    const pb = this._nodes[b].pos;
    let length = 0;
    let prev = pa;
    for (const v of via) {
      length += prev.distanceTo(v);
      prev = v;
    }
    length += prev.distanceTo(pb);

    this._edges.push({
      id,
      a,
      b,
      width: opts.width ?? d.width,
      lanes: opts.lanes ?? d.lanes,
      oneWay: opts.oneWay ?? d.oneWay,
      kind,
      length,
      via,
      noTraffic: opts.noTraffic ?? d.noTraffic,
    });
    this._nodes[a].edges.push(id);
    this._nodes[b].edges.push(id);
    return id;
  }

  find(a: number, b: number): number {
    for (const e of this._nodes[a]?.edges ?? []) {
      const ed = this._edges[e];
      if ((ed.a === a && ed.b === b) || (ed.b === a && ed.a === b)) return e;
    }
    return -1;
  }

  /**
   * Insert a node at parameter `t` along a straight edge and rewire. Returns the
   * new node id. Only valid for edges without `via` control points — alleys and
   * ramps only ever hang off straight lattice streets.
   */
  splitEdge(edgeId: number, t: number, kind: RoadNode['kind'] = 'intersection'): number {
    const e = this._edges[edgeId];
    if (!e) throw new Error(`RoadGraphBuilder: split of missing edge ${edgeId}`);
    if (e.via.length > 0) throw new Error('RoadGraphBuilder: cannot split a curved edge');
    const pa = this._nodes[e.a].pos;
    const pb = this._nodes[e.b].pos;
    const f = clamp(t, 0.08, 0.92);
    const mid = new THREE.Vector3().lerpVectors(pa, pb, f);
    const nid = this.addNode(mid, kind, -1);

    const bOld = e.b;
    // shrink the existing edge to a -> mid
    const ni = this._nodes[bOld].edges.indexOf(edgeId);
    if (ni >= 0) this._nodes[bOld].edges.splice(ni, 1);
    e.b = nid;
    e.length = pa.distanceTo(mid);
    this._nodes[nid].edges.push(edgeId);

    this.addEdge(nid, bOld, {
      kind: e.kind,
      width: e.width,
      lanes: e.lanes,
      oneWay: e.oneWay,
      noTraffic: e.noTraffic,
    });
    return nid;
  }

  /** Drop every node that ended up with no edges (keeps ids contiguous). */
  pruneOrphans(): void {
    const keep: number[] = [];
    const remap = new Int32Array(this._nodes.length).fill(-1);
    for (let i = 0; i < this._nodes.length; i++) {
      if (this._nodes[i].edges.length > 0) {
        remap[i] = keep.length;
        keep.push(i);
      }
    }
    if (keep.length === this._nodes.length) return;
    const nodes: RoadNode[] = keep.map((old, idx) => {
      const n = this._nodes[old];
      n.id = idx;
      return n;
    });
    for (const e of this._edges) {
      e.a = remap[e.a];
      e.b = remap[e.b];
    }
    this._nodes = nodes;
  }

  build(): RoadNetworkImpl {
    this.pruneOrphans();
    for (const n of this._nodes) {
      // deterministic edge order keeps traversal + corner fans stable
      n.edges.sort((x, y) => x - y);
      if (n.edges.length === 1) n.kind = n.kind === 'ramp' ? 'ramp' : 'deadend';
    }
    for (const e of this._edges) {
      if (!this._nodes[e.a] || !this._nodes[e.b]) {
        throw new Error(`RoadGraphBuilder: edge ${e.id} references a missing node`);
      }
    }
    return new RoadNetworkImpl(this._nodes, this._edges);
  }
}
