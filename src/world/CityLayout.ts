/**
 * Loco Lift — Old San Juan district generator.
 *
 * Produces a fully deterministic `CityLayout` from a seeded `RNG`:
 *
 *   terrain  →  street lattice  →  specials (coast / fort / alleys / stairs)
 *            →  height relaxation  →  terrain carving  →  blocks & lots
 *            →  open areas  →  POIs  →  sidewalk network  →  validation
 *
 * Geography: a headland roughly 900 m (E-W) by 700 m (N-S). A ridge runs
 * through the middle; the ground falls steeply to the Atlantic cliffs on the
 * north side and to the bay/cruise berths on the south, climbs to a hillside in
 * the east and ends in a fortified promontory in the west.
 *
 * The street lattice is a jittered, sheared quad grid — narrow 7-9 m streets
 * with real irregularity, not a chessboard. Blocks are subdivided into a ring of
 * party-wall lots around a courtyard, which is exactly how the colonial core
 * is built: continuous façades with no gaps, patios behind.
 */
import * as THREE from 'three';
import type { POI, RoadEdge } from '../core/types';
import { RNG, fbm2D } from '../core/RNG';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RoadGraphBuilder, RoadNetworkImpl } from './RoadNetwork';
import type { Block, CityLayout, DistrictZone, Lot, OpenArea } from './WorldTypes';

/* ----------------------------------------------------------- dimensions */

export const DISTRICT_BOUNDS = { minX: -450, maxX: 450, minZ: -350, maxZ: 350 } as const;
export const SEA_LEVEL = 0;

/** height field resolution, metres */
const HEIGHT_CELL = 3;
/** zone field resolution, metres */
const ZONE_CELL = 8;

/** lattice size — 9 north-south lines x 8 east-west lines */
const COLS = 9;
const ROWS = 8;
const GRID_X0 = -330;
const GRID_X1 = 330;
const GRID_Z0 = -250;
/** the last row is the seaside corniche itself */
const GRID_Z1 = 244;

const PLAZA_CELL = { i: 2, j: 3 };
const MARKET_CELL = { i: 5, j: 4 };
const PLAZUELA_CELL = { i: 4, j: 2 };

const SIDEWALK_W = 2.4;
const KERB_H = 0.14;

const MIN_FRONTAGE = 6;
const MAX_FRONTAGE = 14;

const MAX_STREET_GRADE = 0.22;
const MAX_STAIR_GRADE = 0.5;
const MAX_TERRAIN_DEVIATION = 11;

const ZONES: DistrictZone[] = [
  'oldTown',
  'plazaMayor',
  'waterfront',
  'marketRow',
  'fortress',
  'hillside',
  'artQuarter',
];

/* ------------------------------------------------------------ 2D helpers */

type V2 = THREE.Vector2;

function v2(x: number, y: number): V2 {
  return new THREE.Vector2(x, y);
}

function signedArea(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
}

function ensureCCW(poly: V2[]): V2[] {
  if (signedArea(poly) < 0) poly.reverse();
  return poly;
}

function centroidOf(poly: readonly V2[]): V2 {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-6) {
    const c = v2(0, 0);
    for (const p of poly) c.add(p);
    return c.multiplyScalar(1 / Math.max(1, poly.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return v2(cx / (6 * a), cy / (6 * a));
}

function pointInPolygon(poly: readonly V2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi.y > y !== pj.y > y) {
      const t = (y - pi.y) / (pj.y - pi.y);
      if (x < pi.x + t * (pj.x - pi.x)) inside = !inside;
    }
  }
  return inside;
}

function polyBounds(poly: readonly V2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** squared distance from point to segment in 2D */
function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const l2 = ex * ex + ey * ey;
  let t = 0;
  if (l2 > 1e-12) t = clamp01(((px - ax) * ex + (py - ay) * ey) / l2);
  const qx = ax + ex * t;
  const qy = ay + ey * t;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

function segSegDist(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  // proper intersection => distance 0
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = dx - cx;
  const d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) > 1e-12) {
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.sqrt(
    Math.min(
      pointSegDist2(ax, ay, cx, cy, dx, dy),
      pointSegDist2(bx, by, cx, cy, dx, dy),
      pointSegDist2(cx, cy, ax, ay, bx, by),
      pointSegDist2(dx, dy, ax, ay, bx, by),
    ),
  );
}

/** minimum distance from a polygon (boundary or interior) to a segment */
function polySegDist(poly: readonly V2[], ax: number, ay: number, bx: number, by: number): number {
  if (pointInPolygon(poly, ax, ay) || pointInPolygon(poly, bx, by)) return 0;
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const d = segSegDist(p.x, p.y, q.x, q.y, ax, ay, bx, by);
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

function polysOverlap(a: readonly V2[], b: readonly V2[]): boolean {
  const ba = polyBounds(a);
  const bb = polyBounds(b);
  if (ba.maxX <= bb.minX || bb.maxX <= ba.minX || ba.maxY <= bb.minY || bb.maxY <= ba.minY) return false;
  // edge crossing
  for (let i = 0, n = a.length; i < n; i++) {
    const p = a[i];
    const q = a[(i + 1) % n];
    for (let k = 0, m = b.length; k < m; k++) {
      const r = b[k];
      const s = b[(k + 1) % m];
      const d1x = q.x - p.x;
      const d1y = q.y - p.y;
      const d2x = s.x - r.x;
      const d2y = s.y - r.y;
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-12) continue;
      const t = ((r.x - p.x) * d2y - (r.y - p.y) * d2x) / denom;
      const u = ((r.x - p.x) * d1y - (r.y - p.y) * d1x) / denom;
      // strict interior crossing only — shared party walls touch, they don't overlap
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) return true;
    }
  }
  // containment
  const ca = centroidOf(a);
  if (pointInPolygon(b, ca.x, ca.y)) return true;
  const cb = centroidOf(b);
  if (pointInPolygon(a, cb.x, cb.y)) return true;
  return false;
}

function lineIntersect(px: number, py: number, dx: number, dy: number,
  qx: number, qy: number, ex: number, ey: number): V2 | null {
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((qx - px) * ey - (qy - py) * ex) / denom;
  return v2(px + dx * t, py + dy * t);
}

/**
 * Offset every edge of a CCW polygon inward by its own distance and re-intersect.
 * Returns null when the result folds over itself.
 */
function insetPolygon(poly: readonly V2[], dists: readonly number[]): V2[] | null {
  const n = poly.length;
  if (n < 3) return null;
  const ox: number[] = [];
  const oy: number[] = [];
  const dxs: number[] = [];
  const dys: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % n];
    let ex = q.x - p.x;
    let ey = q.y - p.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) return null;
    ex /= len;
    ey /= len;
    // inward (left) normal for a CCW ring
    const nx = -ey;
    const ny = ex;
    const d = dists[k % dists.length];
    ox.push(p.x + nx * d);
    oy.push(p.y + ny * d);
    dxs.push(ex);
    dys.push(ey);
  }
  const out: V2[] = [];
  for (let k = 0; k < n; k++) {
    const prev = (k - 1 + n) % n;
    const p = lineIntersect(ox[prev], oy[prev], dxs[prev], dys[prev], ox[k], oy[k], dxs[k], dys[k]);
    if (!p) return null;
    out.push(p);
  }
  if (signedArea(out) < 1e-3) return null;
  // reject folds: every offset vertex must stay inside the original ring
  for (const p of out) if (!pointInPolygon(poly, p.x, p.y)) return null;
  return out;
}

function uniformInset(poly: readonly V2[], d: number): V2[] | null {
  return insetPolygon(poly, [d]);
}

/* ------------------------------------------------------------ base terrain */

/**
 * North-south elevation profile of the headland, metres. Atlantic cliffs at the
 * top, a broad ridge through the old town, then a long fall to the bay and the
 * cruise berths. Interpolated with smoothstep so the surface stays C1.
 */
const NS_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [-360, -11],
  [-322, -8.5],
  [-300, 1.5],
  [-286, 16],
  [-262, 20.5],
  [-200, 24],
  [-120, 29],
  [-40, 33],
  [30, 31],
  [95, 24],
  [150, 14],
  [190, 9],
  [250, 6],
  [292, 4.6],
  [316, -1.5],
  [360, -9],
];

function profile1D(z: number): number {
  const last = NS_PROFILE.length - 1;
  if (z <= NS_PROFILE[0][0]) return NS_PROFILE[0][1];
  if (z >= NS_PROFILE[last][0]) return NS_PROFILE[last][1];
  let i = 0;
  while (i < last - 1 && NS_PROFILE[i + 1][0] < z) i++;
  const z0 = NS_PROFILE[i][0];
  const h0 = NS_PROFILE[i][1];
  const z1 = NS_PROFILE[i + 1][0];
  const h1 = NS_PROFILE[i + 1][1];
  return lerp(h0, h1, smoothstep((z - z0) / (z1 - z0)));
}

/**
 * Analytic terrain for the headland. Everything else (roads, plazas) is carved
 * into a grid sampled from this, so it only has to be plausible, not exact.
 */
export function baseTerrain(x: number, z: number): number {
  // Wobble the contour lines so the district never reads as a wedding cake,
  // but fade the wobble out at the shorelines so the coast stays predictable.
  const coreW = smoothstep((z + 262) / 40) * (1 - smoothstep((z - 240) / 50));
  const zz = z + fbm2D(x * 0.0045, 2.3, 3, 7717) * 26 * coreW;
  let h = profile1D(zz);

  // mainland rise to the east, fading out before it reaches the bay
  const inland = 1 - smoothstep((z - 150) / 90);
  h += smoothstep((x - 110) / 280) * 14 * inland;
  // escarpment on the south-east — this is what makes the stair streets steep
  h -= smoothstep((z - 30) / 60) * (1 - smoothstep((z - 150) / 60)) * smoothstep((x - 30) / 120) * 16;

  // open water off the western shore
  h = lerp(h, -11, smoothstep((-x - 356) / 40));
  // the fortified promontory: a walled platform on the north-western point,
  // bounded on every side so the headland actually reads as a headland
  const tip =
    smoothstep((-x - 340) / 46) *
    (1 - smoothstep((-x - 400) / 34)) *
    (1 - smoothstep((z + 30) / 96)) *
    smoothstep((z + 292) / 46);
  h = lerp(h, 23, tip * 0.92);
  // the district is walled in by rising ground to the east
  const wall = smoothstep((x - 398) / 44) * smoothstep((z + 300) / 60) * (1 - smoothstep((z - 200) / 100));
  h = lerp(h, 42, wall);

  h += fbm2D(x * 0.011, z * 0.011, 4, 4241) * 2.6;
  h += fbm2D(x * 0.052, z * 0.052, 3, 991) * 0.7;
  return h;
}

/* ------------------------------------------------------------- height grid */

class HeightGrid {
  readonly gw: number;
  readonly gh: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly h: Float32Array;
  /** distance to the nearest carved road centreline, metres */
  readonly roadDist: Float32Array;

  constructor(cell: number) {
    this.cell = cell;
    this.minX = DISTRICT_BOUNDS.minX;
    this.minZ = DISTRICT_BOUNDS.minZ;
    this.gw = Math.ceil((DISTRICT_BOUNDS.maxX - DISTRICT_BOUNDS.minX) / cell) + 1;
    this.gh = Math.ceil((DISTRICT_BOUNDS.maxZ - DISTRICT_BOUNDS.minZ) / cell) + 1;
    this.h = new Float32Array(this.gw * this.gh);
    this.roadDist = new Float32Array(this.gw * this.gh).fill(Infinity);
    for (let j = 0; j < this.gh; j++) {
      const z = this.minZ + j * cell;
      for (let i = 0; i < this.gw; i++) {
        this.h[j * this.gw + i] = baseTerrain(this.minX + i * cell, z);
      }
    }
  }

  sample(x: number, z: number): number {
    const fx = clamp((x - this.minX) / this.cell, 0, this.gw - 1.0001);
    const fz = clamp((z - this.minZ) / this.cell, 0, this.gh - 1.0001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const row0 = j * this.gw;
    const row1 = row0 + this.gw;
    const h00 = this.h[row0 + i];
    const h10 = this.h[row0 + i + 1];
    const h01 = this.h[row1 + i];
    const h11 = this.h[row1 + i + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }
}

/* ---------------------------------------------------------------- results */

export interface LayoutValidation {
  ok: boolean;
  errors: string[];
  stats: {
    nodes: number;
    edges: number;
    lots: number;
    blocks: number;
    areas: number;
    pois: number;
    sidewalkNodes: number;
    sidewalkEdges: number;
    streetLengthM: number;
    minLotFrontage: number;
    maxLotFrontage: number;
    worstRoadClearance: number;
    maxAdjacentRoadStep: number;
    connectedFraction: number;
  };
}

/* ------------------------------------------------------------- generation */

interface CellGeom {
  i: number;
  j: number;
  zone: DistrictZone;
  quad: V2[];
  buildable: V2[] | null;
  courtyard: V2[] | null;
  /** true when no lot ring is generated here (plaza, market floor) */
  open: boolean;
}

export function generateCityLayout(rng: RNG): CityLayout {
  const rLat = rng.fork(0x51);
  const rLot = rng.fork(0xa2);
  const rPoi = rng.fork(0xb3);
  const rMisc = rng.fork(0xc4);

  /* ---------------------------------------------------- 1. street lattice */

  const builder = new RoadGraphBuilder();

  const xs = spreadLine(rLat, GRID_X0, GRID_X1, COLS, 0.26);
  const zs = spreadLine(rLat, GRID_Z0, GRID_Z1, ROWS, 0.24);

  /**
   * Each grid line meanders: a bounded random walk of lateral offsets along its
   * own length. Streets stay recognisably straight over one block but drift and
   * kink over several, which is what makes a colonial grid feel hand-laid.
   */
  const colOff: number[][] = [];
  for (let i = 0; i < COLS; i++) {
    const walk: number[] = [];
    let v = rLat.range(-9, 9);
    for (let j = 0; j < ROWS; j++) {
      v = clamp(v + rLat.range(-8.5, 8.5), -13, 13);
      walk.push(v);
    }
    colOff.push(walk);
  }
  const rowOff: number[][] = [];
  for (let j = 0; j < ROWS; j++) {
    const walk: number[] = [];
    let v = rLat.range(-8, 8);
    for (let i = 0; i < COLS; i++) {
      v = clamp(v + rLat.range(-7.5, 7.5), -11, 11);
      walk.push(v);
    }
    rowOff.push(walk);
  }

  const SHEAR = 5.4;
  const latticeX: number[][] = [];
  const latticeZ: number[][] = [];
  const nodeId: number[][] = [];
  for (let i = 0; i < COLS; i++) {
    latticeX.push([]);
    latticeZ.push([]);
    nodeId.push([]);
    for (let j = 0; j < ROWS; j++) {
      const x = xs[i] + colOff[i][j] + (j - (ROWS - 1) * 0.5) * SHEAR;
      const z = zs[j] + rowOff[j][i] + (i - (COLS - 1) * 0.5) * 1.6;
      latticeX[i].push(x);
      latticeZ[i].push(z);
      nodeId[i].push(builder.addNode(new THREE.Vector3(x, baseTerrain(x, z), z)));
    }
  }

  const COAST_ROW = ROWS - 1;

  const cellZone = (i: number, j: number): DistrictZone => {
    if (i === PLAZA_CELL.i && j === PLAZA_CELL.j) return 'plazaMayor';
    if (i === MARKET_CELL.i && j === MARKET_CELL.j) return 'marketRow';
    if (j >= COAST_ROW - 2) return 'waterfront';
    if (i >= 5 && j >= 3) return 'hillside';
    if (i >= 4 && j <= 1) return 'artQuarter';
    if (i === 0 && j <= 1) return 'fortress';
    return 'oldTown';
  };

  /** streets bounding the plaza are a little wider, as they are in the real city */
  const touchesPlaza = (i: number, j: number): boolean =>
    (i === PLAZA_CELL.i || i === PLAZA_CELL.i + 1) && (j === PLAZA_CELL.j || j === PLAZA_CELL.j + 1);

  /* --- pick a few internal streets to delete, merging their blocks --- */

  interface Merge {
    i: number;
    j: number;
    /** 'h' merges (i,j) with (i+1,j) by deleting colEdge[i+1][j] */
    axis: 'h' | 'v';
  }
  const merges: Merge[] = [];
  const mergedInto = new Map<string, Merge>();
  const suppressedCol = new Set<string>();
  const suppressedRow = new Set<string>();

  const specialCell = (i: number, j: number): boolean =>
    (i === PLAZA_CELL.i && j === PLAZA_CELL.j) ||
    (i === MARKET_CELL.i && j === MARKET_CELL.j) ||
    (i === PLAZUELA_CELL.i && j === PLAZUELA_CELL.j);

  const cellPoint = (i: number, j: number): V2 => v2(latticeX[i][j], latticeZ[i][j]);
  const convex = (poly: V2[]): boolean => {
    let sign = 0;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const c = poly[(k + 2) % poly.length];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) < 1e-6) continue;
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  };

  for (let attempt = 0; attempt < 26 && merges.length < 7; attempt++) {
    const axis: 'h' | 'v' = rLat.bool(0.5) ? 'h' : 'v';
    const i = rLat.int(0, COLS - 2 - (axis === 'h' ? 1 : 0));
    const j = rLat.int(0, COAST_ROW - 2 - (axis === 'v' ? 1 : 0));
    if (j >= COAST_ROW - 1) continue;
    const a: [number, number] = [i, j];
    const b: [number, number] = axis === 'h' ? [i + 1, j] : [i, j + 1];
    if (specialCell(a[0], a[1]) || specialCell(b[0], b[1])) continue;
    if (mergedInto.has(`${a[0]},${a[1]}`) || mergedInto.has(`${b[0]},${b[1]}`)) continue;
    const key = axis === 'h' ? `c${i + 1},${j}` : `r${i},${j + 1}`;
    if (axis === 'h' ? suppressedCol.has(key) : suppressedRow.has(key)) continue;

    const poly = ensureCCW(
      axis === 'h'
        ? [
            cellPoint(i, j), cellPoint(i + 1, j), cellPoint(i + 2, j),
            cellPoint(i + 2, j + 1), cellPoint(i + 1, j + 1), cellPoint(i, j + 1),
          ]
        : [
            cellPoint(i, j), cellPoint(i + 1, j),
            cellPoint(i + 1, j + 1), cellPoint(i + 1, j + 2),
            cellPoint(i, j + 2), cellPoint(i, j + 1),
          ],
    );
    if (!convex(poly)) continue;

    const m: Merge = { i, j, axis };
    merges.push(m);
    mergedInto.set(`${a[0]},${a[1]}`, m);
    mergedInto.set(`${b[0]},${b[1]}`, m);
    if (axis === 'h') suppressedCol.add(key);
    else suppressedRow.add(key);
  }

  const colEdge: number[][] = []; // colEdge[i][j] : node(i,j) -> node(i,j+1), -1 when deleted
  const rowEdge: number[][] = []; // rowEdge[i][j] : node(i,j) -> node(i+1,j)

  for (let i = 0; i < COLS; i++) {
    colEdge.push([]);
    for (let j = 0; j < ROWS - 1; j++) {
      if (i > 0 && i < COLS - 1 && suppressedCol.has(`c${i},${j}`)) {
        colEdge[i].push(-1);
        continue;
      }
      const wide = touchesPlaza(i, j) || touchesPlaza(i, j + 1);
      const w = wide ? 10.5 : 7 + rLat.range(0, 2);
      colEdge[i].push(builder.addEdge(nodeId[i][j], nodeId[i][j + 1], { kind: 'street', width: w }));
    }
  }
  for (let i = 0; i < COLS - 1; i++) {
    rowEdge.push([]);
    for (let j = 0; j < ROWS; j++) {
      if (j > 0 && j < COAST_ROW && suppressedRow.has(`r${i},${j}`)) {
        rowEdge[i].push(-1);
        continue;
      }
      if (j === COAST_ROW) {
        // the bottom line of the grid *is* the wide seaside corniche
        const a = builder.pos(nodeId[i][j]);
        const b = builder.pos(nodeId[i + 1][j]);
        const mid = new THREE.Vector3().lerpVectors(a, b, 0.5);
        mid.z += rLat.range(-9, 9);
        mid.y = baseTerrain(mid.x, mid.z);
        rowEdge[i].push(
          builder.addEdge(nodeId[i][j], nodeId[i + 1][j], { kind: 'coastal', width: 14, via: [mid] }),
        );
        continue;
      }
      const wide = touchesPlaza(i, j) || touchesPlaza(i + 1, j);
      const w = j === 0 ? 11 : wide ? 10.5 : 7 + rLat.range(0, 2);
      rowEdge[i].push(builder.addEdge(nodeId[i][j], nodeId[i + 1][j], { kind: 'street', width: w }));
    }
  }

  /* ----------------------------------------------- 2. cell geometry pass */

  const cells: CellGeom[] = [];
  const emitCell = (i: number, j: number, poly: V2[], edgeIds: number[]): void => {
    const quad = ensureCCW(poly);
    const zone = cellZone(i, j);
    const open = zone === 'plazaMayor' || zone === 'marketRow';
    const widths = quadEdgeWidths(quad, builder, edgeIds.filter((e) => e >= 0));
    const inset = widths.map((w) => w * 0.5 + SIDEWALK_W + 0.7);
    let buildable = insetPolygon(quad, inset);
    if (!buildable) buildable = uniformInset(quad, Math.max(...inset));
    let courtyard: V2[] | null = null;
    if (buildable) {
      // per-side depths: the ring thickness varies around the block, which is
      // what makes the patios read as organic rather than stamped
      const depths = buildable.map(() => rLot.range(11, 18));
      courtyard = bestInsetVarying(buildable, depths);
    }
    cells.push({ i, j, zone, quad, buildable, courtyard, open });
  };

  for (let i = 0; i < COLS - 1; i++) {
    for (let j = 0; j < COAST_ROW; j++) {
      const merge = mergedInto.get(`${i},${j}`);
      if (merge) {
        if (merge.i !== i || merge.j !== j) continue; // emitted by the anchor cell
        if (merge.axis === 'h') {
          emitCell(i, j, [
            cellPoint(i, j), cellPoint(i + 1, j), cellPoint(i + 2, j),
            cellPoint(i + 2, j + 1), cellPoint(i + 1, j + 1), cellPoint(i, j + 1),
          ], [
            rowEdge[i][j], rowEdge[i + 1][j], colEdge[i + 2][j],
            rowEdge[i + 1][j + 1], rowEdge[i][j + 1], colEdge[i][j],
          ]);
        } else {
          emitCell(i, j, [
            cellPoint(i, j), cellPoint(i + 1, j),
            cellPoint(i + 1, j + 1), cellPoint(i + 1, j + 2),
            cellPoint(i, j + 2), cellPoint(i, j + 1),
          ], [
            rowEdge[i][j], colEdge[i + 1][j], colEdge[i + 1][j + 1],
            rowEdge[i][j + 2], colEdge[i][j + 1], colEdge[i][j],
          ]);
        }
        continue;
      }
      emitCell(i, j, [
        cellPoint(i, j), cellPoint(i + 1, j), cellPoint(i + 1, j + 1), cellPoint(i, j + 1),
      ], [rowEdge[i][j], colEdge[i + 1][j], rowEdge[i][j + 1], colEdge[i][j]]);
    }
  }

  const cellAt = (i: number, j: number): CellGeom | undefined =>
    cells.find((c) => c.i === i && c.j === j);

  /* --------------------------------------------- 3. plaza crossing roads */

  const plazaCell = cellAt(PLAZA_CELL.i, PLAZA_CELL.j);
  const plazaPoly = plazaCell?.buildable ? plazaCell.buildable.map((p) => p.clone()) : null;
  if (plazaCell && plazaPoly) {
    const c = centroidOf(plazaPoly);
    const centreId = builder.addNode(new THREE.Vector3(c.x, baseTerrain(c.x, c.y), c.y), 'plaza');
    const ring = [
      rowEdge[PLAZA_CELL.i][PLAZA_CELL.j],
      colEdge[PLAZA_CELL.i + 1][PLAZA_CELL.j],
      rowEdge[PLAZA_CELL.i][PLAZA_CELL.j + 1],
      colEdge[PLAZA_CELL.i][PLAZA_CELL.j],
    ];
    for (const e of ring) {
      if (e < 0 || builder.edge(e).via.length > 0) continue;
      const nid = builder.splitEdge(e, 0.5, 'plaza');
      builder.addEdge(nid, centreId, { kind: 'plaza', width: 12, noTraffic: false });
    }
  }

  /* ------------------------------------------------ 4. berths & the apron */

  // Cruise berths hang off the corniche on piles, over the bay.
  const berthApron: number[] = [];
  for (const i of [2, 4]) {
    const base = builder.pos(nodeId[i][COAST_ROW]);
    const bx = base.x + rLat.range(-8, 8);
    const bz = base.z + 32;
    const apron = builder.addNode(new THREE.Vector3(bx, baseTerrain(bx, bz), bz));
    builder.addEdge(nodeId[i][COAST_ROW], apron, { kind: 'street', width: 12 });
    berthApron.push(apron);
  }
  if (berthApron.length === 2) {
    const a = builder.pos(berthApron[0]);
    const b = builder.pos(berthApron[1]);
    const mid = new THREE.Vector3().lerpVectors(a, b, 0.5);
    mid.z += 7;
    mid.y = baseTerrain(mid.x, mid.z);
    builder.addEdge(berthApron[0], berthApron[1], { kind: 'coastal', width: 12, via: [mid] });
  }

  /* --------------------------------------------- 5. fortress spur & glacis */

  const fortGateX = -382;
  const fortGateZ = -146;
  const gateNode = builder.addNode(
    new THREE.Vector3(fortGateX, baseTerrain(fortGateX, fortGateZ), fortGateZ),
  );
  // approach road from the westernmost lattice column, hugging the promontory
  {
    const from = builder.pos(nodeId[0][2]);
    const mid = new THREE.Vector3((from.x + fortGateX) * 0.5 - 6, 0, (from.z + fortGateZ) * 0.5 + 10);
    mid.y = baseTerrain(mid.x, mid.z);
    builder.addEdge(nodeId[0][2], gateNode, { kind: 'street', width: 10, via: [mid] });
  }
  // the covered way running north along the ramparts to the cliff-top corniche
  const rampartNodes: number[] = [];
  for (const p of [
    [-396, -196],
    [-390, -246],
  ] as const) {
    rampartNodes.push(builder.addNode(new THREE.Vector3(p[0], baseTerrain(p[0], p[1]), p[1])));
  }
  builder.addEdge(gateNode, rampartNodes[0], { kind: 'street', width: 9 });
  builder.addEdge(rampartNodes[0], rampartNodes[1], { kind: 'street', width: 9 });
  builder.addEdge(rampartNodes[1], nodeId[0][0], { kind: 'street', width: 9 });
  // southern battery road, out along the point and back to the same street the
  // approach leaves from — a triangle, so the two never cross mid-block
  const battery = builder.addNode(new THREE.Vector3(-390, baseTerrain(-390, -92), -92));
  builder.addEdge(gateNode, battery, { kind: 'street', width: 8 });
  builder.addEdge(battery, nodeId[0][2], { kind: 'street', width: 8 });
  // a postern gate: narrow, steep, a shortcut only a taxi driver would take
  const postern = new THREE.Vector3(-364, 0, -184);
  postern.y = baseTerrain(postern.x, postern.z);
  const posternNode = builder.addNode(postern);
  builder.addEdge(gateNode, posternNode, { kind: 'alley', width: 4.5, noTraffic: true, oneWay: false });
  builder.addEdge(posternNode, nodeId[0][1], { kind: 'alley', width: 4.5, noTraffic: true, oneWay: false });

  /* --------------------------------------------------- 6. alleys & stairs */

  const alleyCells: Array<[number, number]> = [
    [PLAZUELA_CELL.i, PLAZUELA_CELL.j],
    [1, 1],
    [3, 1],
    [1, 4],
    [4, 3],
    [6, 1],
    [2, 5],
    [5, 2],
    [7, 1],
    [0, 3],
  ];
  for (const [ci, cj] of alleyCells) {
    if (ci < 0 || ci >= COLS - 1 || cj < 0 || cj >= ROWS - 1) continue;
    const cell = cellAt(ci, cj);
    if (!cell || cell.open) continue;
    const vertical = rMisc.bool(0.5);
    const eTop = vertical ? rowEdge[ci][cj] : colEdge[ci][cj];
    const eBot = vertical ? rowEdge[ci][cj + 1] : colEdge[ci + 1][cj];
    if (!splittable(builder, eTop) || !splittable(builder, eBot)) continue;
    const t0 = rMisc.range(0.38, 0.62);
    const t1 = rMisc.range(0.38, 0.62);
    const nA = builder.splitEdge(eTop, t0);
    const nB = builder.splitEdge(eBot, t1);
    builder.addEdge(nA, nB, { kind: 'alley', width: 4, noTraffic: true, oneWay: false });
  }

  // Stair streets go where the ground falls hardest: score every hillside block
  // by the drop across it and cut the steepest ones.
  const stairCandidates: Array<{ i: number; j: number; drop: number }> = [];
  for (let ci = 3; ci < COLS - 1; ci++) {
    for (let cj = 1; cj < COAST_ROW - 1; cj++) {
      const cell = cellAt(ci, cj);
      if (!cell || cell.open) continue;
      if (!splittable(builder, rowEdge[ci][cj]) || !splittable(builder, rowEdge[ci][cj + 1])) continue;
      const top = builder.pos(nodeId[ci][cj]).y;
      const bot = builder.pos(nodeId[ci][cj + 1]).y;
      const run = Math.max(20, Math.abs(latticeZ[ci][cj + 1] - latticeZ[ci][cj]));
      stairCandidates.push({ i: ci, j: cj, drop: Math.abs(top - bot) / run });
    }
  }
  stairCandidates.sort((a, b) => b.drop - a.drop);
  const stairUsed = new Set<string>();
  let stairsPlaced = 0;
  for (const cand of stairCandidates) {
    if (stairsPlaced >= 5) break;
    if (stairUsed.has(`${cand.i},${cand.j}`)) continue;
    if (!splittable(builder, rowEdge[cand.i][cand.j]) || !splittable(builder, rowEdge[cand.i][cand.j + 1])) continue;
    const nA = builder.splitEdge(rowEdge[cand.i][cand.j], rMisc.range(0.32, 0.5));
    const nB = builder.splitEdge(rowEdge[cand.i][cand.j + 1], rMisc.range(0.5, 0.68));
    builder.addEdge(nA, nB, { kind: 'stairs', width: 5, noTraffic: true });
    stairUsed.add(`${cand.i},${cand.j}`);
    stairUsed.add(`${cand.i - 1},${cand.j}`);
    stairUsed.add(`${cand.i + 1},${cand.j}`);
    stairsPlaced++;
  }

  /* ---------------------------------------------------------- 7. ramps */

  const rampSpecs: Array<{ from: number; dir: THREE.Vector2; rise: number; len: number }> = [
    // a timber ramp off the fort ravelin, out over the glacis
    { from: gateNode, dir: new THREE.Vector2(0.62, -0.78), rise: 2.9, len: 16 },
    // a loading ramp on the cruise apron
    { from: berthApron.length ? berthApron[0] : nodeId[3][COAST_ROW], dir: new THREE.Vector2(0.97, 0.24), rise: 2.4, len: 14 },
    // builders' ramp where the hillside meets the boundary wall
    { from: nodeId[COLS - 1][4], dir: new THREE.Vector2(0.98, 0.2), rise: 3.2, len: 17 },
  ];
  for (const spec of rampSpecs) {
    const base = builder.pos(spec.from);
    const d = clearRampDirection(builder, spec.from, spec.dir.clone().normalize());
    if (!d) continue;
    const tip = new THREE.Vector3(base.x + d.x * spec.len, base.y + spec.rise, base.z + d.y * spec.len);
    const tipId = builder.addNode(tip, 'ramp');
    builder.addEdge(spec.from, tipId, { kind: 'ramp', width: 7, noTraffic: true });
  }

  /* ------------------------------------------- 8. relax the street grades */

  relaxNodeHeights(builder);

  // rebuild via-point heights so curved edges keep a constant grade
  for (let e = 0; e < builder.edgeCount; e++) {
    const ed = builder.edge(e);
    if (ed.via.length === 0) continue;
    const ya = builder.pos(ed.a).y;
    const yb = builder.pos(ed.b).y;
    for (let k = 0; k < ed.via.length; k++) {
      ed.via[k].y = lerp(ya, yb, (k + 1) / (ed.via.length + 1));
    }
  }

  // traffic-light phases at real intersections
  for (let i = 0; i < builder.nodeCount; i++) {
    const n = builder.node(i);
    n.signalOffset = n.edges.length >= 3 && n.kind === 'intersection' ? rMisc.range(0, 8) : -1;
  }

  const roads = builder.build();

  /* --------------------------------------------------- 9. carve the terrain */

  const grid = new HeightGrid(HEIGHT_CELL);
  carveRoads(grid, roads, 11);
  const groundHeight = (x: number, z: number): number => grid.sample(x, z);
  const clearance = new RoadClearanceIndex(roads);

  /* ------------------------------------------------------- 10. open areas */

  const areas: OpenArea[] = [];
  let areaId = 0;
  const pushArea = (
    polygon: V2[],
    zone: DistrictZone,
    surface: OpenArea['surface'],
    drivable: boolean,
    flatten: boolean,
  ): OpenArea => {
    ensureCCW(polygon);
    const c = centroidOf(polygon);
    if (flatten) carveArea(grid, polygon);
    const area: OpenArea = {
      id: areaId++,
      zone,
      polygon,
      center: new THREE.Vector3(c.x, 0, c.y),
      surface,
      drivable,
    };
    areas.push(area);
    return area;
  };

  const mainPlaza = plazaPoly
    ? pushArea(plazaPoly.map((p) => p.clone()), 'plazaMayor', 'flagstone', true, true)
    : null;

  const marketCell = cellAt(MARKET_CELL.i, MARKET_CELL.j);
  const marketArea = marketCell?.buildable
    ? pushArea(marketCell.buildable.map((p) => p.clone()), 'marketRow', 'tile', true, true)
    : null;

  const plazuelaCell = cellAt(PLAZUELA_CELL.i, PLAZUELA_CELL.j);
  const plazuela = plazuelaCell?.courtyard
    ? pushArea(plazuelaCell.courtyard.map((p) => p.clone()), 'oldTown', 'cobble', true, true)
    : null;

  // the fort's cleared field of fire, west of the last street
  const glacis = pushArea(
    [v2(-404, -252), v2(-352, -258), v2(-348, -74), v2(-398, -66)],
    'fortress',
    'grass',
    true,
    false,
  );

  // paseo along the top of the Atlantic cliffs, north of the corniche
  const promenade = pushArea(
    [v2(-322, -282), v2(150, -274), v2(150, -262), v2(-322, -270)],
    'fortress',
    'flagstone',
    false,
    true,
  );

  const dockApron = pushArea(
    [v2(-150, 266), v2(160, 270), v2(160, 296), v2(-150, 292)],
    'waterfront',
    'asphalt',
    true,
    true,
  );

  // small sand cove west of the berths, waterline runs through it
  const caleta = pushArea(
    [v2(-300, 278), v2(-206, 284), v2(-204, 320), v2(-302, 312)],
    'waterfront',
    'sand',
    true,
    false,
  );

  // Roads win the final say: a second, tighter pass puts every carriageway back
  // exactly on its own centreline, including where one crosses a plaza floor.
  carveRoads(grid, roads, 9);

  for (const a of areas) a.center.y = groundHeight(a.center.x, a.center.z);

  /* ------------------------------------------------------ 11. blocks & lots */

  const lots: Lot[] = [];
  const blocks: Block[] = [];
  let lotId = 0;
  let blockId = 0;

  for (const cell of cells) {
    if (cell.open || !cell.buildable) continue;
    const buildable = cell.buildable;
    const court =
      cell.courtyard ??
      (() => {
        const c = centroidOf(buildable);
        return buildable.map((p) => v2(lerp(c.x, p.x, 0.09), lerp(c.y, p.y, 0.09)));
      })();
    const isPlazuela = cell.i === PLAZUELA_CELL.i && cell.j === PLAZUELA_CELL.j;

    const ring: Lot[] = [];
    const n = buildable.length;
    for (let k = 0; k < n; k++) {
      const A = buildable[k];
      const B = buildable[(k + 1) % n];
      const CA = court[k];
      const CB = court[(k + 1) % n];
      const sideLen = A.distanceTo(B);
      const cuts = splitSide(rLot, sideLen);
      for (let m = 0; m < cuts.length - 1; m++) {
        const f0 = cuts[m];
        const f1 = cuts[m + 1];
        const p0 = v2(lerp(A.x, B.x, f0), lerp(A.y, B.y, f0));
        const p1 = v2(lerp(A.x, B.x, f1), lerp(A.y, B.y, f1));
        const q1 = v2(lerp(CA.x, CB.x, f1), lerp(CA.y, CB.y, f1));
        const q0 = v2(lerp(CA.x, CB.x, f0), lerp(CA.y, CB.y, f0));
        const polygon = [p0, p1, q1, q0];
        if (signedArea(polygon) < 4) continue;

        const frontage = p0.distanceTo(p1);
        const fmx = (p0.x + p1.x) * 0.5;
        const fmy = (p0.y + p1.y) * 0.5;
        const bmx = (q0.x + q1.x) * 0.5;
        const bmy = (q0.y + q1.y) * 0.5;
        const depth = Math.hypot(bmx - fmx, bmy - fmy);
        let ex = p1.x - p0.x;
        let ey = p1.y - p0.y;
        const el = Math.hypot(ex, ey) || 1;
        ex /= el;
        ey /= el;
        const groundY = groundHeight(fmx, fmy);
        const c = centroidOf(polygon);

        const lot: Lot = {
          id: lotId,
          zone: cell.zone,
          polygon,
          center: new THREE.Vector3(c.x, groundHeight(c.x, c.y), c.y),
          facing: v2(ey, -ex),
          frontEdge: 0,
          frontage,
          depth,
          storeys: storeysFor(cell.zone, rLot, isPlazaFront(cell, mainPlaza, fmx, fmy)),
          groundY,
          neighbours: [],
          exposedRear: cell.courtyard === null || cell.zone === 'waterfront' || cell.zone === 'fortress',
          seed: (rLot.int(0, 0x7ffffffe) ^ (lotId * 0x9e3779b1)) >>> 0,
        };
        lotId++;
        ring.push(lot);
      }
    }

    // drop anything a street, alley, stair run or plazuela occupies — this is
    // what turns a hand-placed shortcut into a real gap in the façade line
    const kept = ring.filter((lot) => {
      if (!clearance.isClear(lot.polygon)) return false;
      if (isPlazuela && plazuela && polysOverlap(lot.polygon, plazuela.polygon)) return false;
      return true;
    });
    // re-id and wire party walls
    for (let k = 0; k < kept.length; k++) kept[k].id = lots.length + k;
    for (let k = 0; k < kept.length; k++) {
      const prev = kept[(k - 1 + kept.length) % kept.length];
      const next = kept[(k + 1) % kept.length];
      if (kept.length > 1) {
        if (touching(kept[k], prev)) kept[k].neighbours.push(prev.id);
        if (touching(kept[k], next) && next.id !== prev.id) kept[k].neighbours.push(next.id);
      }
    }
    if (kept.length === 0) continue;

    const bc = centroidOf(buildable);
    blocks.push({
      id: blockId++,
      zone: cell.zone,
      lots: kept.map((l) => l.id),
      courtyard: cell.courtyard ? court.map((p) => p.clone()) : [],
      center: new THREE.Vector3(bc.x, groundHeight(bc.x, bc.y), bc.y),
    });
    for (const l of kept) lots.push(l);
  }

  /* ------------------------------------------------------------ 12. zones */

  const zoneGrid = buildZoneGrid(cells, areas);
  const zoneAt = (x: number, z: number): DistrictZone => {
    const i = clamp(Math.round((x - DISTRICT_BOUNDS.minX) / ZONE_CELL), 0, zoneGrid.gw - 1);
    const j = clamp(Math.round((z - DISTRICT_BOUNDS.minZ) / ZONE_CELL), 0, zoneGrid.gh - 1);
    return ZONES[zoneGrid.data[j * zoneGrid.gw + i]];
  };

  /* -------------------------------------------------------------- 13. POIs */

  const pois = buildPOIs(
    rPoi,
    groundHeight,
    { mainPlaza, plazuela, marketArea, glacis, promenade, dockApron, caleta },
    lots,
    roads,
  );

  /* --------------------------------------------------------- 14. sidewalks */

  const sidewalks = buildSidewalkGraph(roads, groundHeight, areas);

  /* ------------------------------------------------------------- 15. spawn */

  const spawn = pickSpawn(roads, groundHeight, mainPlaza);

  const layout: CityLayout = {
    lots,
    blocks,
    areas,
    roads,
    sidewalks,
    pois,
    bounds: {
      minX: DISTRICT_BOUNDS.minX,
      maxX: DISTRICT_BOUNDS.maxX,
      minZ: DISTRICT_BOUNDS.minZ,
      maxZ: DISTRICT_BOUNDS.maxZ,
    },
    spawn,
    groundHeight,
    zoneAt,
  };

  const report = validateCityLayout(layout);
  if (!report.ok) {
    throw new Error(`generateCityLayout: invalid layout\n  - ${report.errors.join('\n  - ')}`);
  }
  return layout;
}

/* ------------------------------------------------------------- utilities */

/**
 * A ramp deck must not overhang the streets meeting the same junction, or the
 * car drives into the underside of it. Rotate the requested heading until it
 * clears every incident approach by a comfortable margin.
 */
function clearRampDirection(
  builder: RoadGraphBuilder,
  fromNode: number,
  want: THREE.Vector2,
): THREE.Vector2 | null {
  const node = builder.node(fromNode);
  const base = builder.pos(fromNode);
  const taken: number[] = [];
  for (const e of node.edges) {
    const ed = builder.edge(e);
    const other = ed.a === fromNode ? ed.b : ed.a;
    const p = ed.via.length > 0 && ed.a === fromNode ? ed.via[0] : builder.pos(other);
    taken.push(Math.atan2(p.z - base.z, p.x - base.x));
  }
  const wantA = Math.atan2(want.y, want.x);
  const MIN_SEP = (46 * Math.PI) / 180;
  for (let step = 0; step <= 10; step++) {
    for (const sign of step === 0 ? [1] : [1, -1]) {
      const a = wantA + sign * step * ((18 * Math.PI) / 180);
      let ok = true;
      for (const t of taken) {
        let d = Math.abs(((a - t + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        d = Math.PI - d;
        if (d < MIN_SEP) {
          ok = false;
          break;
        }
      }
      if (ok) return new THREE.Vector2(Math.cos(a), Math.sin(a));
    }
  }
  return null;
}

/** an edge can host an alley or stair mouth only if it exists and is straight */
function splittable(builder: RoadGraphBuilder, edgeId: number): boolean {
  if (edgeId < 0) return false;
  const e = builder.edge(edgeId);
  return !!e && e.via.length === 0 && e.length > 22;
}

/** n positions between a and b with jittered but monotone spacing */
function spreadLine(rng: RNG, a: number, b: number, n: number, jitter: number): number[] {
  const raw: number[] = [0];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1] + 1 + rng.range(-jitter, jitter));
  const span = raw[n - 1];
  return raw.map((v) => a + (v / span) * (b - a));
}

function quadEdgeWidths(quad: V2[], builder: RoadGraphBuilder, edgeIds: number[]): number[] {
  // quad may have been re-wound by ensureCCW, so match edges by midpoint proximity
  const out: number[] = [];
  for (let k = 0; k < quad.length; k++) {
    const p = quad[k];
    const q = quad[(k + 1) % quad.length];
    const mx = (p.x + q.x) * 0.5;
    const my = (p.y + q.y) * 0.5;
    let best = 8;
    let bestD = Infinity;
    for (const id of edgeIds) {
      const e = builder.edge(id);
      if (!e) continue;
      const a = builder.pos(e.a);
      const b = builder.pos(e.b);
      const d = Math.hypot((a.x + b.x) * 0.5 - mx, (a.z + b.z) * 0.5 - my);
      if (d < bestD) {
        bestD = d;
        best = e.width;
      }
    }
    out.push(best);
  }
  return out;
}

/** biggest inset up to `want` that still yields a healthy courtyard */
function bestInset(poly: V2[], want: number): V2[] | null {
  let d = want;
  const target = signedArea(poly) * 0.09;
  for (let k = 0; k < 9; k++) {
    const r = uniformInset(poly, d);
    if (r && signedArea(r) > target) return r;
    d *= 0.78;
    if (d < 4.5) break;
  }
  return null;
}

/**
 * A courtyard is only usable if the ring between it and the block boundary
 * partitions cleanly: every segment must have positive area and no two spokes
 * (the party walls running back from the street) may cross. Without this an
 * uneven inset silently produces overlapping lots.
 */
function validRing(outer: readonly V2[], inner: readonly V2[]): boolean {
  const n = outer.length;
  if (inner.length !== n) return false;
  if (signedArea(inner) < signedArea(outer) * 0.05) return false;
  for (let k = 0; k < n; k++) {
    if (!pointInPolygon(outer, inner[k].x, inner[k].y)) return false;
    const back = Math.hypot(inner[k].x - outer[k].x, inner[k].y - outer[k].y);
    if (back < 7 || back > 28) return false;
  }
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    // ring segment must wind the same way as the block
    const quad = [outer[k], outer[k1], inner[k1], inner[k]];
    if (signedArea(quad) < 4) return false;
    // spokes must stay clear of one another
    for (let m = k + 1; m < n; m++) {
      if (m === k1 || (k === 0 && m === n - 1)) continue;
      if (
        segSegDist(
          outer[k].x, outer[k].y, inner[k].x, inner[k].y,
          outer[m].x, outer[m].y, inner[m].x, inner[m].y,
        ) < 0.05
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Courtyard inset with a different depth on every side — the block ring ends up
 * thicker on some frontages than others, like a real patio block.
 */
function bestInsetVarying(poly: V2[], depths: number[]): V2[] | null {
  let scale = 1;
  for (let k = 0; k < 10; k++) {
    const r = insetPolygon(poly, depths.map((d) => d * scale));
    if (r && validRing(poly, r)) return r;
    scale *= 0.84;
    if (scale < 0.35) break;
  }
  // fall back to a uniform ring, then to a solid block
  let d = Math.min(...depths);
  for (let k = 0; k < 10; k++) {
    const r = uniformInset(poly, d);
    if (r && validRing(poly, r)) return r;
    d *= 0.86;
    if (d < 7) break;
  }
  return null;
}

/** cut a block side into lots with legal street frontage */
function splitSide(rng: RNG, sideLen: number): number[] {
  const minCount = Math.max(1, Math.ceil(sideLen / MAX_FRONTAGE));
  const maxCount = Math.max(1, Math.floor(sideLen / MIN_FRONTAGE));
  let count = Math.round(sideLen / 11);
  count = clamp(count, minCount, maxCount) | 0;
  if (count < 1) count = 1;

  const w: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = rng.range(0.76, 1.3);
    w.push(v);
    sum += v;
  }
  for (let i = 0; i < count; i++) w[i] = (w[i] / sum) * sideLen;
  for (let iter = 0; iter < 10; iter++) {
    let s = 0;
    for (let i = 0; i < count; i++) {
      w[i] = clamp(w[i], MIN_FRONTAGE, MAX_FRONTAGE);
      s += w[i];
    }
    if (Math.abs(s - sideLen) < 1e-3) break;
    const scale = sideLen / s;
    for (let i = 0; i < count; i++) w[i] *= scale;
  }
  const cuts = [0];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += w[i];
    cuts.push(clamp01(acc / sideLen));
  }
  cuts[cuts.length - 1] = 1;
  return cuts;
}

function storeysFor(zone: DistrictZone, rng: RNG, onPlaza: boolean): number {
  let base: number;
  switch (zone) {
    case 'plazaMayor':
      base = 4;
      break;
    case 'marketRow':
      base = 2;
      break;
    case 'hillside':
      base = rng.bool(0.65) ? 2 : 3;
      break;
    case 'waterfront':
      base = rng.bool(0.5) ? 2 : 3;
      break;
    case 'artQuarter':
      base = rng.bool(0.45) ? 3 : 2;
      break;
    case 'fortress':
      base = 2;
      break;
    default:
      base = rng.bool(0.55) ? 3 : 2;
      break;
  }
  if (onPlaza) base += 1;
  return clamp(base, 1, 4) | 0;
}

function isPlazaFront(cell: CellGeom, plaza: OpenArea | null, x: number, y: number): boolean {
  if (!plaza) return false;
  const c = plaza.center;
  return Math.hypot(x - c.x, y - c.z) < 78 && cell.zone !== 'plazaMayor';
}

function touching(a: Lot, b: Lot): boolean {
  if (a.id === b.id) return false;
  for (const pa of a.polygon) {
    for (const pb of b.polygon) {
      if (pa.distanceToSquared(pb) < 0.25) return true;
    }
  }
  return false;
}

/* --------------------------------------------------- height relaxation */

/**
 * Streets in a hill city are graded: they follow the land, but they never jump.
 * Relax node heights so every edge respects a maximum grade while staying close
 * to the underlying terrain, then let the terrain carve follow the roads.
 */
function relaxNodeHeights(builder: RoadGraphBuilder): void {
  const n = builder.nodeCount;
  const base = new Float64Array(n);
  const y = new Float64Array(n);
  const pinned = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = builder.pos(i);
    base[i] = p.y;
    y[i] = p.y;
    if (builder.node(i).kind === 'ramp') pinned[i] = 1;
  }

  const accum = new Float64Array(n);
  const weight = new Float64Array(n);

  /**
   * Pass 1 — two light Laplacian passes only, just enough to take the fbm
   * speckle out of the node heights. Anything more and the whole hill city
   * flattens into a table, which is exactly what we do not want.
   */
  for (let iter = 0; iter < 2; iter++) {
    accum.fill(0);
    weight.fill(0);
    for (let e = 0; e < builder.edgeCount; e++) {
      const ed = builder.edge(e);
      if (ed.kind === 'ramp' || ed.kind === 'rooftop') continue;
      accum[ed.a] += y[ed.b];
      weight[ed.a] += 1;
      accum[ed.b] += y[ed.a];
      weight[ed.b] += 1;
    }
    for (let i = 0; i < n; i++) {
      if (pinned[i] || weight[i] === 0) continue;
      y[i] = lerp(y[i], accum[i] / weight[i], 0.22);
    }
  }

  /**
   * Pass 2 — pure grade projection. Repeatedly pull the ends of any edge that
   * exceeds its maximum grade toward each other, clamped so the streets never
   * float far from the land they are cut into. Converges to the steepest legal
   * profile rather than to a flat one.
   */
  for (let iter = 0; iter < 260; iter++) {
    accum.fill(0);
    weight.fill(0);
    let worst = 0;
    for (let e = 0; e < builder.edgeCount; e++) {
      const ed = builder.edge(e);
      if (ed.kind === 'ramp' || ed.kind === 'rooftop') continue;
      const a = ed.a;
      const b = ed.b;
      const pa = builder.pos(a);
      const pb = builder.pos(b);
      const run = Math.max(2, Math.hypot(pb.x - pa.x, pb.z - pa.z));
      const maxDrop = run * (ed.kind === 'stairs' ? MAX_STAIR_GRADE : MAX_STREET_GRADE);
      const dy = y[b] - y[a];
      let ta = y[a];
      let tb = y[b];
      const over = Math.abs(dy) - maxDrop;
      if (over > 0) {
        worst = Math.max(worst, over / run);
        const fix = over * 0.5 * Math.sign(dy);
        ta += fix;
        tb -= fix;
      }
      accum[a] += ta;
      weight[a] += 1;
      accum[b] += tb;
      weight[b] += 1;
    }
    if (worst < 1e-3) break;
    for (let i = 0; i < n; i++) {
      if (pinned[i] || weight[i] === 0) continue;
      y[i] = clamp(
        accum[i] / weight[i],
        base[i] - MAX_TERRAIN_DEVIATION,
        base[i] + MAX_TERRAIN_DEVIATION,
      );
    }
  }

  for (let i = 0; i < n; i++) {
    if (pinned[i]) continue;
    builder.pos(i).y = y[i];
  }
  // ramp tips ride on top of whatever their base ended up at
  for (let e = 0; e < builder.edgeCount; e++) {
    const ed = builder.edge(e);
    if (ed.kind !== 'ramp') continue;
    const tip = builder.node(ed.b).kind === 'ramp' ? ed.b : ed.a;
    const foot = tip === ed.b ? ed.a : ed.b;
    builder.pos(tip).y = builder.pos(foot).y + 2.9;
  }
}

/* ----------------------------------------------------------- terrain carve */

/** road shoulder half-width: carriageway + gutter + pavement */
function carveHalfWidth(e: RoadEdge): number {
  if (e.kind === 'alley' || e.kind === 'stairs') return e.width * 0.5 + 0.6;
  return e.width * 0.5 + 0.35 + SIDEWALK_W;
}

function carveRoads(grid: HeightGrid, roads: RoadNetworkImpl, BLEND: number): void {
  const cells = grid.gw * grid.gh;
  const roadH = new Float32Array(cells);
  const roadHW = new Float32Array(cells);
  const dist = grid.roadDist;
  dist.fill(Infinity);

  for (let ei = 0; ei < roads.edges.length; ei++) {
    const e = roads.edges[ei];
    if (e.kind === 'ramp' || e.kind === 'rooftop') continue;
    const b = roads.polyline(ei);
    const hw = carveHalfWidth(e);
    const R = hw + BLEND;
    for (let s = 0; s < b.count - 1; s++) {
      const ax = b.points[s * 3];
      const ay = b.points[s * 3 + 1];
      const az = b.points[s * 3 + 2];
      const bx = b.points[s * 3 + 3];
      const by = b.points[s * 3 + 4];
      const bz = b.points[s * 3 + 5];
      const i0 = clamp(Math.floor((Math.min(ax, bx) - R - grid.minX) / grid.cell), 0, grid.gw - 1);
      const i1 = clamp(Math.ceil((Math.max(ax, bx) + R - grid.minX) / grid.cell), 0, grid.gw - 1);
      const j0 = clamp(Math.floor((Math.min(az, bz) - R - grid.minZ) / grid.cell), 0, grid.gh - 1);
      const j1 = clamp(Math.ceil((Math.max(az, bz) + R - grid.minZ) / grid.cell), 0, grid.gh - 1);
      const ex = bx - ax;
      const ez = bz - az;
      const l2 = ex * ex + ez * ez;
      for (let j = j0; j <= j1; j++) {
        const pz = grid.minZ + j * grid.cell;
        const row = j * grid.gw;
        for (let i = i0; i <= i1; i++) {
          const px = grid.minX + i * grid.cell;
          let t = 0;
          if (l2 > 1e-9) t = clamp01(((px - ax) * ex + (pz - az) * ez) / l2);
          const qx = ax + ex * t;
          const qz = az + ez * t;
          const d = Math.hypot(px - qx, pz - qz);
          if (d >= R) continue;
          const idx = row + i;
          if (d < dist[idx]) {
            dist[idx] = d;
            roadH[idx] = ay + (by - ay) * t;
            roadHW[idx] = hw;
          }
        }
      }
    }
  }

  for (let idx = 0; idx < cells; idx++) {
    const d = dist[idx];
    if (!Number.isFinite(d)) continue;
    const hw = roadHW[idx];
    const R = hw + BLEND;
    const w = 1 - smoothstep((d - hw) / Math.max(0.001, R - hw));
    grid.h[idx] = lerp(grid.h[idx], roadH[idx], w);
  }
}

/* ----------------------------------------------------- road clearance index */

/**
 * Broad-phase for "does this polygon sit on a road?". Every baked road segment
 * is bucketed into a coarse grid together with the keep-out half width it
 * demands (carriageway plus a margin), so lot rejection is a local query.
 */
class RoadClearanceIndex {
  private readonly cell = 24;
  private readonly buckets = new Map<number, number[]>();
  /** ax, az, bx, bz, half per segment */
  private readonly segs: number[] = [];

  constructor(roads: RoadNetworkImpl) {
    for (let ei = 0; ei < roads.edges.length; ei++) {
      const e = roads.edges[ei];
      if (e.kind === 'rooftop') continue;
      const narrow = e.kind === 'alley' || e.kind === 'stairs' || e.kind === 'ramp';
      const half = e.width * 0.5 + (narrow ? 1.5 : 1.0);
      const b = roads.polyline(ei);
      for (let s = 0; s < b.count - 1; s++) {
        const idx = this.segs.length / 5;
        this.segs.push(
          b.points[s * 3],
          b.points[s * 3 + 2],
          b.points[s * 3 + 3],
          b.points[s * 3 + 5],
          half,
        );
        const i0 = Math.floor((Math.min(this.segs[idx * 5], this.segs[idx * 5 + 2]) - half) / this.cell);
        const i1 = Math.floor((Math.max(this.segs[idx * 5], this.segs[idx * 5 + 2]) + half) / this.cell);
        const j0 = Math.floor((Math.min(this.segs[idx * 5 + 1], this.segs[idx * 5 + 3]) - half) / this.cell);
        const j1 = Math.floor((Math.max(this.segs[idx * 5 + 1], this.segs[idx * 5 + 3]) + half) / this.cell);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const k = i * 100003 + j;
            let list = this.buckets.get(k);
            if (!list) this.buckets.set(k, (list = []));
            list.push(idx);
          }
        }
      }
    }
  }

  /** true when no road's keep-out corridor touches the polygon */
  isClear(poly: readonly V2[]): boolean {
    const bb = polyBounds(poly);
    const i0 = Math.floor(bb.minX / this.cell);
    const i1 = Math.floor(bb.maxX / this.cell);
    const j0 = Math.floor(bb.minY / this.cell);
    const j1 = Math.floor(bb.maxY / this.cell);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.buckets.get(i * 100003 + j);
        if (!list) continue;
        for (const s of list) {
          const half = this.segs[s * 5 + 4];
          if (
            bb.minX - half > Math.max(this.segs[s * 5], this.segs[s * 5 + 2]) ||
            bb.maxX + half < Math.min(this.segs[s * 5], this.segs[s * 5 + 2]) ||
            bb.minY - half > Math.max(this.segs[s * 5 + 1], this.segs[s * 5 + 3]) ||
            bb.maxY + half < Math.min(this.segs[s * 5 + 1], this.segs[s * 5 + 3])
          ) {
            continue;
          }
          const d = polySegDist(
            poly,
            this.segs[s * 5],
            this.segs[s * 5 + 1],
            this.segs[s * 5 + 2],
            this.segs[s * 5 + 3],
          );
          if (d < half) return false;
        }
      }
    }
    return true;
  }
}

function carveArea(grid: HeightGrid, poly: readonly V2[]): void {
  const bb = polyBounds(poly);
  const BLEND = 7;
  // fit a plane to the ground just outside the polygon so the square meets the
  // surrounding streets cleanly instead of sitting in a bathtub
  const c = centroidOf(poly);
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let sx = 0;
  let sz = 0;
  let sh = 0;
  let shx = 0;
  let shz = 0;
  let count = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    const steps = Math.max(2, Math.round(p.distanceTo(q) / 6));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = lerp(p.x, q.x, t);
      const z = lerp(p.y, q.y, t);
      // sample just outside the boundary
      const ox = x + (x - c.x) * 0.06;
      const oz = z + (z - c.y) * 0.06;
      const h = grid.sample(ox, oz);
      const dx = ox - c.x;
      const dz = oz - c.y;
      sxx += dx * dx;
      sxz += dx * dz;
      szz += dz * dz;
      sx += dx;
      sz += dz;
      sh += h;
      shx += h * dx;
      shz += h * dz;
      count++;
    }
  }
  if (count === 0) return;
  const h0 = sh / count;
  // solve the 2x2 normal equations for the tilt (centred, so the mean cancels)
  const a11 = sxx - (sx * sx) / count;
  const a12 = sxz - (sx * sz) / count;
  const a22 = szz - (sz * sz) / count;
  const b1 = shx - (sh * sx) / count;
  const b2 = shz - (sh * sz) / count;
  const det = a11 * a22 - a12 * a12;
  let gx = 0;
  let gz = 0;
  if (Math.abs(det) > 1e-6) {
    gx = (b1 * a22 - b2 * a12) / det;
    gz = (a11 * b2 - a12 * b1) / det;
    const slope = Math.hypot(gx, gz);
    if (slope > 0.22) {
      gx *= 0.22 / slope;
      gz *= 0.22 / slope;
    }
  }
  const planeAt = (x: number, z: number): number => h0 + gx * (x - c.x) + gz * (z - c.y);

  const i0 = clamp(Math.floor((bb.minX - BLEND - grid.minX) / grid.cell), 0, grid.gw - 1);
  const i1 = clamp(Math.ceil((bb.maxX + BLEND - grid.minX) / grid.cell), 0, grid.gw - 1);
  const j0 = clamp(Math.floor((bb.minY - BLEND - grid.minZ) / grid.cell), 0, grid.gh - 1);
  const j1 = clamp(Math.ceil((bb.maxY + BLEND - grid.minZ) / grid.cell), 0, grid.gh - 1);
  for (let j = j0; j <= j1; j++) {
    const z = grid.minZ + j * grid.cell;
    for (let i = i0; i <= i1; i++) {
      const x = grid.minX + i * grid.cell;
      const inside = pointInPolygon(poly, x, z);
      let w: number;
      if (inside) w = 1;
      else {
        let d = Infinity;
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k];
          const q = poly[(k + 1) % poly.length];
          const dd = pointSegDist2(x, z, p.x, p.y, q.x, q.y);
          if (dd < d) d = dd;
        }
        d = Math.sqrt(d);
        if (d >= BLEND) continue;
        w = 1 - smoothstep(d / BLEND);
      }
      const idx = j * grid.gw + i;
      grid.h[idx] = lerp(grid.h[idx], planeAt(x, z), w);
    }
  }
}

/* ------------------------------------------------------------- zone field */

interface ZoneGrid {
  gw: number;
  gh: number;
  data: Uint8Array;
}

function buildZoneGrid(cells: CellGeom[], areas: OpenArea[]): ZoneGrid {
  const gw = Math.ceil((DISTRICT_BOUNDS.maxX - DISTRICT_BOUNDS.minX) / ZONE_CELL) + 1;
  const gh = Math.ceil((DISTRICT_BOUNDS.maxZ - DISTRICT_BOUNDS.minZ) / ZONE_CELL) + 1;
  const data = new Uint8Array(gw * gh);
  const idxOf = (z: DistrictZone): number => ZONES.indexOf(z);

  for (let j = 0; j < gh; j++) {
    const z = DISTRICT_BOUNDS.minZ + j * ZONE_CELL;
    for (let i = 0; i < gw; i++) {
      const x = DISTRICT_BOUNDS.minX + i * ZONE_CELL;
      let zone: DistrictZone;
      if (x < -330) zone = 'fortress';
      else if (z > 200) zone = 'waterfront';
      else if (z < -250) zone = x < -140 ? 'fortress' : 'artQuarter';
      else if (x > 330) zone = 'hillside';
      else zone = 'oldTown';
      data[j * gw + i] = idxOf(zone);
    }
  }

  // stamp lattice cells (grown slightly so streets take the neighbouring zone)
  for (const cell of cells) {
    const bb = polyBounds(cell.quad);
    const i0 = clamp(Math.floor((bb.minX - DISTRICT_BOUNDS.minX) / ZONE_CELL), 0, gw - 1);
    const i1 = clamp(Math.ceil((bb.maxX - DISTRICT_BOUNDS.minX) / ZONE_CELL), 0, gw - 1);
    const j0 = clamp(Math.floor((bb.minY - DISTRICT_BOUNDS.minZ) / ZONE_CELL), 0, gh - 1);
    const j1 = clamp(Math.ceil((bb.maxY - DISTRICT_BOUNDS.minZ) / ZONE_CELL), 0, gh - 1);
    const zi = idxOf(cell.zone);
    for (let j = j0; j <= j1; j++) {
      const z = DISTRICT_BOUNDS.minZ + j * ZONE_CELL;
      for (let i = i0; i <= i1; i++) {
        const x = DISTRICT_BOUNDS.minX + i * ZONE_CELL;
        if (pointInPolygon(cell.quad, x, z)) data[j * gw + i] = zi;
      }
    }
  }

  for (const area of areas) {
    const bb = polyBounds(area.polygon);
    const i0 = clamp(Math.floor((bb.minX - DISTRICT_BOUNDS.minX) / ZONE_CELL), 0, gw - 1);
    const i1 = clamp(Math.ceil((bb.maxX - DISTRICT_BOUNDS.minX) / ZONE_CELL), 0, gw - 1);
    const j0 = clamp(Math.floor((bb.minY - DISTRICT_BOUNDS.minZ) / ZONE_CELL), 0, gh - 1);
    const j1 = clamp(Math.ceil((bb.maxY - DISTRICT_BOUNDS.minZ) / ZONE_CELL), 0, gh - 1);
    const zi = idxOf(area.zone);
    for (let j = j0; j <= j1; j++) {
      const z = DISTRICT_BOUNDS.minZ + j * ZONE_CELL;
      for (let i = i0; i <= i1; i++) {
        const x = DISTRICT_BOUNDS.minX + i * ZONE_CELL;
        if (pointInPolygon(area.polygon, x, z)) data[j * gw + i] = zi;
      }
    }
  }

  return { gw, gh, data };
}

/* ------------------------------------------------------------------ POIs */

interface AreaRefs {
  mainPlaza: OpenArea | null;
  plazuela: OpenArea | null;
  marketArea: OpenArea | null;
  glacis: OpenArea;
  promenade: OpenArea;
  dockApron: OpenArea;
  caleta: OpenArea;
}

function buildPOIs(
  rng: RNG,
  groundHeight: (x: number, z: number) => number,
  areas: AreaRefs,
  lots: Lot[],
  roads: RoadNetworkImpl,
): POI[] {
  const out: POI[] = [];
  const tmp = new THREE.Vector3();

  const add = (
    id: string,
    name: string,
    kind: POI['kind'],
    x: number,
    z: number,
    radius: number,
    facing = NaN,
  ): POI => {
    const poi: POI = {
      id,
      name,
      kind,
      pos: new THREE.Vector3(x, groundHeight(x, z), z),
      radius,
      facing,
    };
    out.push(poi);
    return poi;
  };

  /** heading that points from a POI toward the nearest street */
  const facingRoad = (x: number, z: number): number => {
    tmp.set(x, 0, z);
    const s = roads.nearest(tmp, 90);
    if (!s) return NaN;
    return Math.atan2(-(s.point.x - x), -(s.point.z - z));
  };

  const plazaC = areas.mainPlaza ? areas.mainPlaza.center : new THREE.Vector3(-120, 0, 6);
  add('plaza-farolito', 'Plaza del Farolito', 'plaza', plazaC.x, plazaC.z, 26, facingRoad(plazaC.x, plazaC.z));

  if (areas.plazuela) {
    const c = areas.plazuela.center;
    add('plazuela-sombra', 'Plazuela de la Sombra', 'plaza', c.x, c.z, 13, facingRoad(c.x, c.z));
  } else {
    add('plazuela-sombra', 'Plazuela de la Sombra', 'plaza', 60, -110, 13);
  }

  if (areas.marketArea) {
    const c = areas.marketArea.center;
    add('mercado-marina', 'Mercado de la Marina', 'market', c.x, c.z, 22, facingRoad(c.x, c.z));
  }

  const apron = areas.dockApron.center;
  add('muelle-cruceros', 'Muelle de los Cruceros', 'dock', apron.x - 40, apron.z + 6, 24, facingRoad(apron.x - 40, apron.z + 6));
  add('muelle-pesquero', 'Muelle Pesquero', 'dock', apron.x + 96, apron.z + 2, 16, facingRoad(apron.x + 96, apron.z + 2));

  const glac = areas.glacis.center;
  add('castillo-bartolome', 'Castillo de San Bartolomé', 'fort', -366, -168, 30, facingRoad(-366, -168));
  add('mirador-garitas', 'Mirador de las Garitas', 'lookout', glac.x + 26, glac.z - 34, 14, facingRoad(glac.x + 26, glac.z - 34));

  const prom = areas.promenade.center;
  add('paseo-muralla', 'Paseo de la Muralla', 'lookout', prom.x, prom.z + 2, 18, facingRoad(prom.x, prom.z + 2));

  const cal = areas.caleta.center;
  add('playita-caleta', 'Playita de la Caleta', 'beach', cal.x, cal.z, 18, facingRoad(cal.x, cal.z));

  /* — venues that live in real lots, so props and doors can be placed on them — */
  const pickLot = (zone: DistrictZone, near: THREE.Vector2, used: Set<number>): Lot | null => {
    let best: Lot | null = null;
    let bestD = Infinity;
    for (const l of lots) {
      if (used.has(l.id)) continue;
      if (l.zone !== zone) continue;
      const d = (l.center.x - near.x) ** 2 + (l.center.z - near.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    if (best) used.add(best.id);
    return best;
  };

  const used = new Set<number>();
  const venue: Array<{
    id: string;
    name: string;
    kind: POI['kind'];
    zone: DistrictZone;
    near: THREE.Vector2;
  }> = [
    { id: 'cafe-mediodia', name: 'Café Mediodía', kind: 'cafe', zone: 'plazaMayor', near: new THREE.Vector2(plazaC.x + 40, plazaC.z) },
    { id: 'cafetin-cotorra', name: 'Cafetín La Cotorra', kind: 'cafe', zone: 'artQuarter', near: new THREE.Vector2(120, -180) },
    { id: 'panaderia-aurora', name: 'Panadería La Aurora', kind: 'bakery', zone: 'oldTown', near: new THREE.Vector2(-40, -120) },
    { id: 'salon-bomba', name: 'Salón de Bomba y Plena', kind: 'venue', zone: 'oldTown', near: new THREE.Vector2(-190, 90) },
    { id: 'galeria-adoquin', name: 'Galería Adoquín', kind: 'gallery', zone: 'artQuarter', near: new THREE.Vector2(230, -210) },
    { id: 'galeria-tres-ventanas', name: 'Galería Tres Ventanas', kind: 'gallery', zone: 'artQuarter', near: new THREE.Vector2(170, -90) },
    { id: 'capilla-san-telmo', name: 'Capilla de San Telmo', kind: 'chapel', zone: 'oldTown', near: new THREE.Vector2(-250, -60) },
    { id: 'azotea-sereno', name: 'Azotea del Sereno', kind: 'rooftop', zone: 'oldTown', near: new THREE.Vector2(-96, -190) },
    { id: 'terraza-canon', name: 'Terraza del Cañón', kind: 'rooftop', zone: 'fortress', near: new THREE.Vector2(-300, -212) },
    { id: 'azotea-verde', name: 'Azotea Verde', kind: 'rooftop', zone: 'hillside', near: new THREE.Vector2(250, 90) },
    { id: 'mirador-bahia', name: 'Mirador de la Bahía', kind: 'lookout', zone: 'hillside', near: new THREE.Vector2(300, 150) },
    { id: 'cafe-tinglado', name: 'Café del Tinglado', kind: 'cafe', zone: 'waterfront', near: new THREE.Vector2(40, 170) },
  ];

  for (const v of venue) {
    let lot = pickLot(v.zone, v.near, used);
    if (!lot) lot = pickLot('oldTown', v.near, used);
    if (!lot) continue;
    const fx = lot.center.x + lot.facing.x * (lot.depth * 0.5 + 2);
    const fz = lot.center.z + lot.facing.y * (lot.depth * 0.5 + 2);
    const facing = Math.atan2(lot.facing.x, lot.facing.y);
    add(v.id, v.name, v.kind, fx, fz, v.kind === 'rooftop' ? 10 : 9, facing);
  }

  // vary the RNG stream deterministically so re-seeding shifts POI radii
  for (const p of out) p.radius += rng.range(-1, 1.5);

  return out;
}

/* -------------------------------------------------------------- sidewalks */

/**
 * Pedestrian network derived from the streets: a hub node in each intersection,
 * kerb-corner nodes around it, runs down both kerbs of every street, and rings
 * around every open area.
 */
function buildSidewalkGraph(
  roads: RoadNetworkImpl,
  groundHeight: (x: number, z: number) => number,
  areas: OpenArea[],
): RoadNetworkImpl {
  const sb = new RoadGraphBuilder();
  const CENTRE_KINDS = new Set(['alley', 'stairs', 'ramp', 'rooftop']);

  const hub: number[] = new Array(roads.nodes.length).fill(-1);
  for (let i = 0; i < roads.nodes.length; i++) {
    const p = roads.nodes[i].pos;
    hub[i] = sb.addNode(new THREE.Vector3(p.x, groundHeight(p.x, p.z) + KERB_H, p.z), 'intersection');
  }

  /** corner[edgeId * 4 + end * 2 + side] where side 0 = +right(outgoing) */
  const corner = new Int32Array(roads.edges.length * 4).fill(-1);
  const dir = new THREE.Vector3();

  for (let ni = 0; ni < roads.nodes.length; ni++) {
    const node = roads.nodes[ni];
    const incident = node.edges.filter((e) => !CENTRE_KINDS.has(roads.edges[e].kind));
    if (incident.length === 0) continue;

    let r = 0;
    for (const e of node.edges) r = Math.max(r, roads.edges[e].width * 0.5);
    r += 1.6;

    const entries: Array<{ edge: number; angle: number; end: number }> = [];
    for (const e of incident) {
      const ed = roads.edges[e];
      const end = ed.a === ni ? 0 : 1;
      roads.tangent(e, end === 0 ? 0 : 1, dir);
      if (end === 1) dir.multiplyScalar(-1);
      const angle = Math.atan2(dir.z, dir.x);
      entries.push({ edge: e, angle, end });

      const off = ed.width * 0.5 + SIDEWALK_W * 0.5;
      const rx = -dir.z;
      const rz = dir.x;
      const bx = node.pos.x + dir.x * r;
      const bz = node.pos.z + dir.z * r;
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? 1 : -1;
        const x = bx + rx * off * sign;
        const z = bz + rz * off * sign;
        const id = sb.addNode(new THREE.Vector3(x, groundHeight(x, z) + KERB_H, z), 'intersection');
        corner[e * 4 + end * 2 + s] = id;
        sb.addEdge(hub[ni], id, { kind: 'plaza', width: 2.4, noTraffic: true, lanes: 1 });
      }
    }

    entries.sort((a, b) => a.angle - b.angle);
    for (let k = 0; k < entries.length; k++) {
      const cur = entries[k];
      const nxt = entries[(k + 1) % entries.length];
      if (entries.length === 1) break;
      const from = corner[cur.edge * 4 + cur.end * 2 + 0];
      const to = corner[nxt.edge * 4 + nxt.end * 2 + 1];
      if (from >= 0 && to >= 0 && from !== to) {
        sb.addEdge(from, to, { kind: 'plaza', width: 2.4, noTraffic: true, lanes: 1 });
      }
    }
  }

  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let e = 0; e < roads.edges.length; e++) {
    const ed = roads.edges[e];
    if (CENTRE_KINDS.has(ed.kind)) {
      // narrow routes: pedestrians share the centreline
      if (hub[ed.a] >= 0 && hub[ed.b] >= 0) {
        sb.addEdge(hub[ed.a], hub[ed.b], {
          kind: ed.kind === 'stairs' ? 'stairs' : 'alley',
          width: Math.min(3, ed.width),
          noTraffic: true,
          lanes: 1,
        });
      }
      continue;
    }
    const off = ed.width * 0.5 + SIDEWALK_W * 0.5;
    const baked = roads.polyline(e);
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? 1 : -1;
      // side +right(a->b) is the "+right outgoing" corner at a and the
      // "-right outgoing" corner at b, since the outgoing direction flips.
      const from = corner[e * 4 + 0 * 2 + (sign > 0 ? 0 : 1)];
      const to = corner[e * 4 + 1 * 2 + (sign > 0 ? 1 : 0)];
      if (from < 0 || to < 0) continue;
      const via: THREE.Vector3[] = [];
      if (baked.count > 2) {
        for (let k = 1; k < baked.count - 1; k += 2) {
          const tt = baked.cum[k] / baked.length;
          roads.sample(e, tt, off * sign, p);
          roads.tangent(e, tt, t);
          via.push(new THREE.Vector3(p.x, groundHeight(p.x, p.z) + KERB_H, p.z));
        }
      }
      sb.addEdge(from, to, { kind: 'street', width: SIDEWALK_W, noTraffic: true, lanes: 1, via });
    }
  }

  /* rings around plazas, market floors and the promenade */
  for (const area of areas) {
    const ring: number[] = [];
    const poly = area.polygon;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const steps = Math.max(1, Math.round(a.distanceTo(b) / 11));
      for (let s = 0; s < steps; s++) {
        const f = s / steps;
        const x = lerp(a.x, b.x, f);
        const z = lerp(a.y, b.y, f);
        ring.push(sb.addNode(new THREE.Vector3(x, groundHeight(x, z) + 0.05, z), 'plaza'));
      }
    }
    for (let k = 0; k < ring.length; k++) {
      sb.addEdge(ring[k], ring[(k + 1) % ring.length], {
        kind: 'plaza',
        width: 3,
        noTraffic: true,
        lanes: 1,
      });
    }
    // stitch the ring into the street pavements at a few points
    const stitches = Math.min(4, ring.length);
    for (let s = 0; s < stitches; s++) {
      const rid = ring[Math.floor((s * ring.length) / stitches)];
      const rp = sb.pos(rid);
      let best = -1;
      let bestD = Infinity;
      for (let ni = 0; ni < roads.nodes.length; ni++) {
        const d = roads.nodes[ni].pos.distanceToSquared(rp);
        if (d < bestD) {
          bestD = d;
          best = ni;
        }
      }
      if (best >= 0 && hub[best] >= 0 && Math.sqrt(bestD) < 130) sb.addEdge(rid, hub[best], {
        kind: 'plaza',
        width: 3,
        noTraffic: true,
        lanes: 1,
      });
    }
  }

  return sb.build();
}

/* ------------------------------------------------------------------ spawn */

function pickSpawn(
  roads: RoadNetworkImpl,
  groundHeight: (x: number, z: number) => number,
  plaza: OpenArea | null,
): { pos: THREE.Vector3; heading: number } {
  // A street a couple of blocks west of the plaza, running downhill toward the
  // fort and the open Atlantic — the postcard shot the game opens on.
  const target = new THREE.Vector3(plaza ? plaza.center.x - 90 : -220, 0, plaza ? plaza.center.z : 0);
  let bestEdge = -1;
  let bestDir = 1;
  let bestScore = -Infinity;
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let e = 0; e < roads.edges.length; e++) {
    const ed = roads.edges[e];
    if (ed.kind !== 'street') continue;
    if (ed.length < 45 || ed.width < 7.5) continue;
    roads.sample(e, 0.5, 0, p);
    roads.tangent(e, 0.5, t);
    const inv = 1 / Math.max(1e-3, Math.hypot(t.x, t.z));
    const proximity = -p.distanceTo(target) * 0.4;
    for (let s = 0; s < 2; s++) {
      const dir = s === 0 ? 1 : -1;
      const west = -t.x * inv * dir;
      const downhill = -t.y * inv * dir;
      const score = west * 34 + downhill * 26 + proximity + ed.width;
      if (score > bestScore) {
        bestScore = score;
        bestEdge = e;
        bestDir = dir;
      }
    }
  }
  if (bestEdge < 0) bestEdge = 0;
  const at = bestDir > 0 ? 0.4 : 0.6;
  roads.sample(bestEdge, at, 2.2 * bestDir, p);
  roads.tangent(bestEdge, at, t).multiplyScalar(bestDir);
  const pos = new THREE.Vector3(p.x, groundHeight(p.x, p.z) + 0.75, p.z);
  // heading is the Y rotation that aims the object's -Z axis along the tangent
  const heading = Math.atan2(-t.x, -t.z);
  return { pos, heading };
}

/* ------------------------------------------------------------- validation */

/**
 * Structural checks. `generateCityLayout` throws when this fails, so a broken
 * layout never reaches the renderer.
 */
export function validateCityLayout(layout: CityLayout): LayoutValidation {
  const errors: string[] = [];
  const roads = layout.roads;
  const nodeCount = roads.nodes.length;

  for (const e of roads.edges) {
    if (!roads.nodes[e.a] || !roads.nodes[e.b]) errors.push(`edge ${e.id} has a dangling endpoint`);
    if (!(e.length > 0.5)) errors.push(`edge ${e.id} has zero length`);
    if (e.a === e.b) errors.push(`edge ${e.id} is a self loop`);
  }
  for (const n of roads.nodes) {
    for (const e of n.edges) {
      const ed = roads.edges[e];
      if (!ed || (ed.a !== n.id && ed.b !== n.id)) errors.push(`node ${n.id} lists a foreign edge ${e}`);
    }
  }

  /* no two streets may cross except at a shared node — the district has no
     grade separation, so a crossing is always a missing intersection */
  const net = roads as RoadNetworkImpl;
  let crossings = 0;
  const box = roads.edges.map((e) => {
    const b = net.polyline(e.id);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < b.count; i++) {
      const x = b.points[i * 3];
      const z = b.points[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    return { minX, maxX, minZ, maxZ };
  });
  for (let a = 0; a < roads.edges.length; a++) {
    const ea = roads.edges[a];
    if (ea.kind === 'ramp' || ea.kind === 'rooftop') continue;
    const ba = net.polyline(a);
    for (let b = a + 1; b < roads.edges.length; b++) {
      const eb = roads.edges[b];
      if (eb.kind === 'ramp' || eb.kind === 'rooftop') continue;
      if (ea.a === eb.a || ea.a === eb.b || ea.b === eb.a || ea.b === eb.b) continue;
      if (
        box[a].maxX < box[b].minX || box[b].maxX < box[a].minX ||
        box[a].maxZ < box[b].minZ || box[b].maxZ < box[a].minZ
      ) {
        continue;
      }
      const bb = net.polyline(b);
      let hit = false;
      for (let i = 0; i < ba.count - 1 && !hit; i++) {
        for (let k = 0; k < bb.count - 1; k++) {
          if (
            segSegDist(
              ba.points[i * 3], ba.points[i * 3 + 2], ba.points[i * 3 + 3], ba.points[i * 3 + 5],
              bb.points[k * 3], bb.points[k * 3 + 2], bb.points[k * 3 + 3], bb.points[k * 3 + 5],
            ) < 0.01
          ) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        crossings++;
        if (crossings <= 6) errors.push(`edges ${a} (${ea.kind}) and ${b} (${eb.kind}) cross without an intersection`);
      }
    }
  }

  /* connectivity from the spawn */
  const startNode = roads.nearestNode(layout.spawn.pos);
  const seen = new Uint8Array(nodeCount);
  const queue = new Int32Array(nodeCount);
  let head = 0;
  let tail = 0;
  if (startNode >= 0) {
    seen[startNode] = 1;
    queue[tail++] = startNode;
  }
  let reached = startNode >= 0 ? 1 : 0;
  while (head < tail) {
    const cur = queue[head++];
    for (const e of roads.nodes[cur].edges) {
      const ed = roads.edges[e];
      const other = ed.a === cur ? ed.b : ed.a;
      if (!seen[other]) {
        seen[other] = 1;
        queue[tail++] = other;
        reached++;
      }
    }
  }
  const connectedFraction = nodeCount > 0 ? reached / nodeCount : 0;
  if (connectedFraction < 0.95) {
    errors.push(`road graph is fragmented: only ${(connectedFraction * 100).toFixed(1)}% reachable`);
  }

  /* lots must not sit on a carriageway */
  let worstClearance = Infinity;
  let minFront = Infinity;
  let maxFront = -Infinity;
  const probe = new THREE.Vector3();
  for (const lot of layout.lots) {
    minFront = Math.min(minFront, lot.frontage);
    maxFront = Math.max(maxFront, lot.frontage);
    if (lot.polygon.length < 3) {
      errors.push(`lot ${lot.id} has a degenerate polygon`);
      continue;
    }
    for (let k = 0; k < lot.polygon.length; k++) {
      const a = lot.polygon[k];
      const b = lot.polygon[(k + 1) % lot.polygon.length];
      const steps = Math.max(2, Math.round(a.distanceTo(b) / 3));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        probe.set(lerp(a.x, b.x, f), 0, lerp(a.y, b.y, f));
        const hit = roads.nearest(probe, 40);
        if (!hit) continue;
        const half = roads.edges[hit.edgeId].width * 0.5;
        const clearance = hit.dist - half;
        if (clearance < worstClearance) worstClearance = clearance;
        if (clearance < -0.05) {
          errors.push(
            `lot ${lot.id} overlaps the carriageway of edge ${hit.edgeId} by ${(-clearance).toFixed(2)} m`,
          );
        }
      }
    }
  }
  if (!Number.isFinite(worstClearance)) worstClearance = 0;

  /* height continuity along drivable centrelines */
  let maxStep = 0;
  const pa = new THREE.Vector3();
  for (const e of roads.edges) {
    if (e.kind === 'ramp' || e.kind === 'rooftop') continue;
    const steps = Math.max(2, Math.round(e.length / 2));
    let prev = Number.NaN;
    for (let s = 0; s <= steps; s++) {
      roads.sample(e.id, s / steps, 0, pa);
      const h = layout.groundHeight(pa.x, pa.z);
      if (!Number.isNaN(prev)) maxStep = Math.max(maxStep, Math.abs(h - prev));
      prev = h;
    }
  }
  if (maxStep > 3) {
    errors.push(`ground height jumps ${maxStep.toFixed(2)} m between adjacent road samples`);
  }

  if (layout.pois.length < 14) errors.push(`only ${layout.pois.length} POIs, expected at least 14`);
  if (layout.areas.length < 5) errors.push(`only ${layout.areas.length} open areas, expected at least 5`);
  if (layout.lots.length < 200) errors.push(`only ${layout.lots.length} lots — the district is too sparse`);

  let streetLength = 0;
  for (const e of roads.edges) streetLength += e.length;

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      nodes: nodeCount,
      edges: roads.edges.length,
      lots: layout.lots.length,
      blocks: layout.blocks.length,
      areas: layout.areas.length,
      pois: layout.pois.length,
      sidewalkNodes: layout.sidewalks.nodes.length,
      sidewalkEdges: layout.sidewalks.edges.length,
      streetLengthM: Math.round(streetLength),
      minLotFrontage: Number.isFinite(minFront) ? Number(minFront.toFixed(2)) : 0,
      maxLotFrontage: Number.isFinite(maxFront) ? Number(maxFront.toFixed(2)) : 0,
      worstRoadClearance: Number(worstClearance.toFixed(3)),
      maxAdjacentRoadStep: Number(maxStep.toFixed(3)),
      connectedFraction: Number(connectedFraction.toFixed(4)),
    },
  };
}
