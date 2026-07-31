/**
 * Loco Lift — **El Torro**.
 *
 * The road on top of the sea wall. It starts at the portón under the castillo,
 * runs the whole northern rim of San Viejo above the Atlantic, and comes out
 * the far side by the galerías — one long, fast, sweeping line with the water
 * on your left, the garitas flicking past on the right, and nothing in the way.
 * It is the drive the whole game is pointing at: the time trial runs it, three
 * story beats run it, the scenic tourist job runs it slowly on purpose, and the
 * finale runs it at sunset with your uncle in the back seat.
 *
 * The route is *derived*, never hard-coded, because the world module owns the
 * road graph and may move it. The derivation is:
 *
 *   1. take every road node in the seaward band of the playable bounds,
 *   2. A* from the west-most to the east-most of them,
 *   3. densify the resulting edge chain into a centreline at ~8 m,
 *   4. place the seven garitas at authored fractions along it, pushed off the
 *      carriageway toward the water,
 *   5. bind each garita to a real POI: the registered `garita-*` id if the
 *      world has it, otherwise the nearest unused POI within reach, so the
 *      destination arrow and the minimap keep working on a world that has not
 *      registered them yet.
 *
 * Everything is built once, at shift start. `distanceTo` is called at 5 Hz by
 * the mission system and allocates nothing.
 */
import * as THREE from 'three';
import type { POI, POIKind, RoadGraph } from '../core/types';
import { EL_TORRO_WAYPOINTS } from '../passengers/MissionCatalog';

/* ------------------------------------------------------ structural inputs */

/** The slice of the world the route needs. Structurally a `WorldAPI`. */
export interface RouteWorld {
  roads: RoadGraph;
  pois: ReadonlyArray<POI>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  groundHeight?(x: number, z: number): number;
  poiById?(id: string): POI | undefined;
}

/* -------------------------------------------------------------- the spec */

export interface GaritaSpec {
  /** the POI id we would like registered in the world table */
  id: string;
  name: string;
  /** 0..1 along the wall road, west → east */
  t: number;
  /** metres off the carriageway, toward the water */
  offset: number;
  /** one line for the tour, used by the scenic run and the HUD toast */
  line: string;
}

/**
 * Seven sentry boxes, west to east. Names are invented in the San Viejo
 * register — plausible, correct Spanish, none of them a real landmark.
 */
export const GARITAS: readonly GaritaSpec[] = [
  {
    id: EL_TORRO_WAYPOINTS[0],
    name: 'Garita de los Vientos',
    t: 0.04,
    offset: 11,
    line: 'La primera. Aquí el viento entra de frente y no para hasta diciembre.',
  },
  {
    id: EL_TORRO_WAYPOINTS[1],
    name: 'Garita de la Sal',
    t: 0.18,
    offset: 11,
    line: 'A esta la come la sal. La pican, la pintan, y en dos años otra vez.',
  },
  {
    id: EL_TORRO_WAYPOINTS[2],
    name: 'Garita del Farol',
    t: 0.39,
    offset: 12,
    line: 'Aquí colgaban un farol para avisar a las lanchas. Hoy avisa el celular.',
  },
  {
    id: EL_TORRO_WAYPOINTS[3],
    name: 'Garita de las Ánimas',
    t: 0.58,
    offset: 11,
    line: 'Los guardias juraban que aquí se oye gente. Era el viento. Casi siempre.',
  },
  {
    id: EL_TORRO_WAYPOINTS[4],
    name: 'Garita del Vigía',
    t: 0.70,
    offset: 12,
    line: 'La más alta. Desde aquí se veía el barco antes que desde el castillo.',
  },
  {
    id: EL_TORRO_WAYPOINTS[5],
    name: 'Garita de la Espuma',
    t: 0.84,
    offset: 11,
    line: 'Cuando pica el mar, la espuma llega hasta la carretera. Hasta aquí mismo.',
  },
  {
    id: EL_TORRO_WAYPOINTS[6],
    name: 'Garita del Aguacero',
    t: 0.97,
    offset: 11,
    line: 'La última. Aquí se paraba la gente a esperar que escampara. Todavía se para.',
  },
];

/** The gate at the western end — where a run of El Torro properly begins. */
export const EL_TORRO_GATE = {
  id: 'porton-torro',
  name: 'Portón de El Torro',
  kind: 'fort' as POIKind,
  /** 0..1 along the route */
  t: 0.0,
  offset: 0,
};

/* ------------------------------------------------------------- the route */

export interface Garita {
  spec: GaritaSpec;
  /** the POI the HUD points at — a registered garita, or a bound stand-in */
  poi: POI | null;
  /** the garita's own world position, off the carriageway toward the sea */
  x: number;
  z: number;
  y: number;
  /** metres along the route */
  s: number;
}

export class ElTorroRoute {
  /** densified centreline, west → east; flat xz pairs so nothing allocates */
  private readonly pts: Float64Array;
  private readonly count: number;
  /** cumulative distance at each point */
  private readonly cum: Float64Array;

  readonly length: number;
  readonly garitas: readonly Garita[];
  /** the POI a run starts from, when the world has something usable */
  readonly gate: POI | null;

  constructor(pts: Float64Array, count: number, garitas: Garita[], gate: POI | null) {
    this.pts = pts;
    this.count = count;
    this.cum = new Float64Array(count);
    let total = 0;
    for (let i = 1; i < count; i++) {
      const dx = pts[i * 2] - pts[(i - 1) * 2];
      const dz = pts[i * 2 + 1] - pts[(i - 1) * 2 + 1];
      total += Math.sqrt(dx * dx + dz * dz);
      this.cum[i] = total;
    }
    this.length = total;
    this.garitas = garitas;
    this.gate = gate;
  }

  get pointCount(): number {
    return this.count;
  }

  /** World position of centreline point `i`, written into `out`. */
  pointAt(i: number, out: { x: number; z: number }): void {
    const k = Math.max(0, Math.min(this.count - 1, i | 0));
    out.x = this.pts[k * 2];
    out.z = this.pts[k * 2 + 1];
  }

  /**
   * Shortest distance from `(x, z)` to the wall road, metres. Straight scan of
   * the polyline — no allocation, no sqrt until the end.
   */
  distanceTo(x: number, z: number): number {
    let best = Infinity;
    const p = this.pts;
    for (let i = 1; i < this.count; i++) {
      const ax = p[(i - 1) * 2];
      const az = p[(i - 1) * 2 + 1];
      const bx = p[i * 2];
      const bz = p[i * 2 + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-6 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const dx = x - (ax + ex * t);
      const dz = z - (az + ez * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }

  /** 0..1 west → east, by nearest point on the centreline. */
  progressAt(x: number, z: number): number {
    if (this.length <= 0) return 0;
    let best = Infinity;
    let bestS = 0;
    const p = this.pts;
    for (let i = 1; i < this.count; i++) {
      const ax = p[(i - 1) * 2];
      const az = p[(i - 1) * 2 + 1];
      const bx = p[i * 2];
      const bz = p[i * 2 + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-6 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const dx = x - (ax + ex * t);
      const dz = z - (az + ez * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bestS = this.cum[i - 1] + Math.sqrt(len2) * t;
      }
    }
    return Math.max(0, Math.min(1, bestS / this.length));
  }

  /** POIs bound to the garitas, in order, skipping any that could not bind. */
  garitaPOIs(): POI[] {
    const out: POI[] = [];
    for (const g of this.garitas) if (g.poi) out.push(g.poi);
    return out;
  }

  /** Ordered POI ids for a mission `waypoints` list. */
  waypointIds(): string[] {
    const out: string[] = [];
    for (const g of this.garitas) if (g.poi) out.push(g.poi.id);
    return out;
  }

  /** True when the world actually registered the authored garita POIs. */
  get fullyRegistered(): boolean {
    for (const g of this.garitas) {
      if (!g.poi || g.poi.id !== g.spec.id) return false;
    }
    return true;
  }
}

/* ------------------------------------------------------------ derivation */

export interface BuildRouteOptions {
  /** how wide the seaward band is, as a fraction of the map's short axis */
  band?: number;
  /** centreline sample spacing, metres */
  stride?: number;
  /** how far a stand-in POI may sit from its garita, metres */
  bindRadius?: number;
}

/**
 * Derive El Torro from the live road graph. Returns null only when the world
 * has no usable road chain along a rim at all, in which case callers fall back
 * to ordinary POI routing.
 */
export function buildElTorroRoute(
  world: RouteWorld,
  opts: BuildRouteOptions = {},
): ElTorroRoute | null {
  const roads = world.roads;
  if (!roads || roads.nodes.length < 4 || roads.edges.length < 3) return null;

  const band = opts.band ?? 0.25;
  const stride = opts.stride ?? 8;
  const bindRadius = opts.bindRadius ?? 95;

  const b = world.bounds;
  const spanX = b.maxX - b.minX;
  const spanZ = b.maxZ - b.minZ;
  if (!Number.isFinite(spanX) || !Number.isFinite(spanZ) || spanX <= 1 || spanZ <= 1) return null;
  const cx = (b.minX + b.maxX) * 0.5;
  const cz = (b.minZ + b.maxZ) * 0.5;

  /* the seaward rim: the northern band, where the fort wall stands */
  const cut = b.minZ + spanZ * band;
  let westId = -1;
  let eastId = -1;
  let westX = Infinity;
  let eastX = -Infinity;
  for (const node of roads.nodes) {
    if (node.pos.z > cut) continue;
    if (node.edges.length === 0) continue;
    if (node.pos.x < westX) {
      westX = node.pos.x;
      westId = node.id;
    }
    if (node.pos.x > eastX) {
      eastX = node.pos.x;
      eastId = node.id;
    }
  }
  if (westId < 0 || eastId < 0 || westId === eastId) return null;

  const path = roads.path(westId, eastId);
  if (path.length < 3) return null;

  /* --- densify the node chain into a centreline ------------------------- */

  const raw: number[] = [];
  const push = (x: number, z: number): void => {
    const n = raw.length;
    if (n >= 2) {
      const dx = x - raw[n - 2];
      const dz = z - raw[n - 1];
      if (dx * dx + dz * dz < 0.25) return;
    }
    raw.push(x, z);
  };

  /* built once per shift, so a real Vector3 here costs nothing */
  const tmp = new THREE.Vector3();
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1];
    const to = path[i];
    const edge = findEdge(roads, from, to);
    if (!edge) {
      const p = roads.nodes[to].pos;
      push(p.x, p.z);
      continue;
    }
    const forward = edge.a === from;
    const steps = Math.max(1, Math.round(edge.length / stride));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const t = forward ? f : 1 - f;
      const sample = roads.sample(edge.id, t, 0, tmp);
      push(sample.x, sample.z);
    }
  }
  const count = raw.length / 2;
  if (count < 4) return null;
  const pts = Float64Array.from(raw);

  /* the route must genuinely run west → east; flip it if A* walked backwards */
  if (pts[0] > pts[(count - 1) * 2]) {
    for (let i = 0, j = count - 1; i < j; i++, j--) {
      const ax = pts[i * 2];
      const az = pts[i * 2 + 1];
      pts[i * 2] = pts[j * 2];
      pts[i * 2 + 1] = pts[j * 2 + 1];
      pts[j * 2] = ax;
      pts[j * 2 + 1] = az;
    }
  }

  /* --- cumulative length, so garitas can be placed by fraction ---------- */

  let total = 0;
  const cum = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const dx = pts[i * 2] - pts[(i - 1) * 2];
    const dz = pts[i * 2 + 1] - pts[(i - 1) * 2 + 1];
    total += Math.sqrt(dx * dx + dz * dz);
    cum[i] = total;
  }
  if (total < 200) return null;

  /* --- place and bind the garitas --------------------------------------- */

  const taken = new Set<string>();
  const garitas: Garita[] = [];
  for (const spec of GARITAS) {
    const target = Math.max(0, Math.min(1, spec.t)) * total;
    let i = 1;
    while (i < count - 1 && cum[i] < target) i++;
    const seg = cum[i] - cum[i - 1];
    const f = seg > 1e-6 ? (target - cum[i - 1]) / seg : 0;
    const ax = pts[(i - 1) * 2];
    const az = pts[(i - 1) * 2 + 1];
    const bx = pts[i * 2];
    const bz = pts[i * 2 + 1];
    const px = ax + (bx - ax) * f;
    const pz = az + (bz - az) * f;

    /* perpendicular, pushed away from the middle of the map = toward the sea */
    let nx = -(bz - az);
    let nz = bx - ax;
    const nl = Math.hypot(nx, nz);
    if (nl > 1e-6) {
      nx /= nl;
      nz /= nl;
    } else {
      nx = 0;
      nz = -1;
    }
    if (nx * (px - cx) + nz * (pz - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const gx = px + nx * spec.offset;
    const gz = pz + nz * spec.offset;
    const gy = world.groundHeight ? world.groundHeight(gx, gz) : 0;

    garitas.push({
      spec,
      poi: bindGarita(world, spec, gx, gz, bindRadius, taken),
      x: gx,
      z: gz,
      y: Number.isFinite(gy) ? gy : 0,
      s: target,
    });
  }

  /* --- the western gate -------------------------------------------------- */

  let gate = world.poiById?.(EL_TORRO_GATE.id) ?? null;
  if (!gate) {
    gate = nearestPOI(world.pois, pts[0], pts[1], 180, taken);
    if (gate) taken.add(gate.id);
  } else {
    taken.add(gate.id);
  }

  return new ElTorroRoute(pts, count, garitas, gate);
}

/**
 * Prefer the authored garita POI; otherwise adopt the nearest unclaimed POI so
 * the HUD arrow, the minimap pin and the mission destination all still resolve.
 */
function bindGarita(
  world: RouteWorld,
  spec: GaritaSpec,
  x: number,
  z: number,
  radius: number,
  taken: Set<string>,
): POI | null {
  const exact = world.poiById
    ? world.poiById(spec.id)
    : world.pois.find((p) => p.id === spec.id);
  if (exact) {
    taken.add(exact.id);
    return exact;
  }
  const near = nearestPOI(world.pois, x, z, radius, taken);
  if (near) taken.add(near.id);
  return near;
}

function nearestPOI(
  pois: ReadonlyArray<POI>,
  x: number,
  z: number,
  radius: number,
  taken: ReadonlySet<string>,
): POI | null {
  let best: POI | null = null;
  let bestD = radius * radius;
  for (const poi of pois) {
    if (taken.has(poi.id)) continue;
    const d = (poi.pos.x - x) ** 2 + (poi.pos.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = poi;
    }
  }
  return best;
}

function findEdge(
  roads: RoadGraph,
  from: number,
  to: number,
): { id: number; a: number; b: number; length: number } | null {
  const node = roads.nodes[from];
  if (!node) return null;
  let best: { id: number; a: number; b: number; length: number } | null = null;
  for (const id of node.edges) {
    const e = roads.edges[id];
    if (!e) continue;
    if ((e.a === from && e.b === to) || (e.b === from && e.a === to)) {
      if (!best || e.length < best.length) best = e;
    }
  }
  return best;
}

/* ---------------------------------------------------------- registration */

export interface POISpec {
  id: string;
  name: string;
  kind: POIKind;
  x: number;
  z: number;
  radius: number;
}

/**
 * The POI table the world should register for El Torro, with the coordinates
 * the derivation actually produced. Printed by the harness so the integrator
 * can paste real numbers rather than guesses.
 */
export function describeRoutePOIs(route: ElTorroRoute): POISpec[] {
  const out: POISpec[] = [];
  for (const g of route.garitas) {
    out.push({
      id: g.spec.id,
      name: g.spec.name,
      kind: 'lookout',
      x: Math.round(g.x * 10) / 10,
      z: Math.round(g.z * 10) / 10,
      radius: 13,
    });
  }
  return out;
}
