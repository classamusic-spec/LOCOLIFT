/**
 * Loco Lift — **El Perlo**.
 *
 * The barrio below the north wall. Two hundred metres of Atlantic cliff between
 * the fort and the Subida, filled out into four stepped terraces of small
 * concrete houses packed shoulder to shoulder, painted in colours the colonial
 * city above would never dare, and closed at the bottom by a fast seawall road
 * with the surf breaking on the rocks beside it.
 *
 * It is a real, proud, working neighbourhood, and it is built here with the
 * same care the rest of the district gets: correct Spanish signage, the flag in
 * its proper colours, hand-painted house numbers, plants on every roof.
 *
 * ## What is here
 *
 *  - **A graded bench.** The natural headland is a 50° cliff dropping straight
 *    into deep water; nothing could be built on it and nothing could be driven
 *    on it. This layer lays its own terrain over the top — four flat terraces,
 *    the lanes between them, the ramps and stair chutes that link them, and a
 *    rock revetment down into the sea. Every vertex of that bench sits at or
 *    above `layout.groundHeight`, so the world's own terrain collider never
 *    pokes through a road.
 *  - **Four levels, three of houses.** `Calle Alta`, `Calle Media`, `Calle
 *    Baja` and the `Malecón del Perlo`, each 3.4 m below the last. Every house
 *    fronts the lane below it and is *roofed at the level of the lane above*,
 *    which is the thing that makes the reference photographs read: from the
 *    top lane you look straight out over the neighbours' roof terraces, and
 *    you can drive onto them.
 *  - **Rooftop runs.** Where four or more single-storey houses sit side by
 *    side, the parapet on the lane side is dropped and the roofs are flush:
 *    a continuous drivable terrace with a kicker at the far end.
 *  - **Six connector ramps, six stair chutes and two entrances.** The Bajada
 *    del Perlo traverses the cliff face down from the corniche in the west;
 *    the Subida climbs back out through a gate in the wall in the east. In
 *    between you can zig-zag down the lanes, cut the stairs, or take the roofs.
 *  - **The muralla.** A battered masonry wall along the cliff crest with a
 *    garita on the point, two arched gates, and the barrio tumbling away
 *    below it.
 *
 * ## Cost
 *
 * Everything merges into six sector meshes (three near, three far) plus two
 * bench meshes and one cut-out sheet per sector — about a dozen draw calls for
 * the whole district, with a hard distance cull and a near/far LOD swap on top.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { POI, QualityTier } from '../core/types';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle, PhysicsWorldAPI } from '../physics/PhysicsTypes';
import { SEA_LEVEL } from './CityLayout';
import type { MaterialLibrary } from './Materials';
import { TextureFactory } from './TextureFactory';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';
import {
  CONCRETE,
  EP,
  JOINERY,
  Mesher,
  PAINT,
  TRIM,
  buildBoulder,
  buildBush,
  buildCar,
  buildGarita,
  buildHouse,
  buildMuralla,
  buildPalm,
  buildPole,
  buildRetaining,
  buildRoofClutter,
  buildSkiff,
  buildStairs,
  buildWire,
  elPerloAtlas,
  laundryLine,
  mixCol,
  rgb,
  shade,
  tile,
  type Col,
  type HouseSpec,
  type Rect,
  type TileId,
} from './ElPerloKit';

/* ========================================================================== *
 *  the site
 * ========================================================================== */

/** The bench's footprint. Everything outside this is the world's own terrain. */
const SITE = { x0: -344, x1: -58, z0: -264, z1: -348 } as const;

/**
 * North of this line the bench only exists inside the two entry ramps: the
 * rest of the strip is the city's own promenade and stays exactly as the
 * ground layer built it.
 */
const APRON_Z = -278.5;

/** Grid pitch of the graded bench, metres. */
const CELL = 1.55;

/** How far the barrio itself runs along the shore. */
const BARRIO_X0 = -306;
const BARRIO_X1 = -86;

/** The muralla's centreline and the crest it carries. */
const WALL_Z = -289.6;

interface Level {
  name: string;
  /** lane centreline z */
  z: number;
  /** lane half-width */
  hw: number;
  /** lane surface height */
  y: number;
  /** house row: seaward face and hillside face */
  rowSea: number;
  rowHill: number;
  /** storey weights for this row: 1, 2, 3 */
  storeyW: readonly [number, number, number];
}

/**
 * Four terraces, 3.4 m apart. The row of each level fronts the lane *below*
 * it and is roofed level with the lane it belongs to.
 */
const LEVELS: readonly Level[] = [
  { name: 'alta', z: -294.6, hw: 3.0, y: 13.0, rowSea: -304.6, rowHill: -297.9, storeyW: [0.6, 0.32, 0.08] },
  { name: 'media', z: -308.8, hw: 2.9, y: 9.6, rowSea: -318.8, rowHill: -312.1, storeyW: [0.46, 0.4, 0.14] },
  { name: 'baja', z: -323.0, hw: 2.9, y: 6.2, rowSea: -332.4, rowHill: -326.3, storeyW: [0.3, 0.44, 0.26] },
  { name: 'malecon', z: -338.0, hw: 5.0, y: 2.8, rowSea: -332.4, rowHill: -326.3, storeyW: [0, 0, 0] },
];

const MALECON = LEVELS[3];

/** Where the seaward rock revetment begins and ends. */
const REVET_Z = -343.4;
const TOE_Z = -347.6;
const TOE_Y = -2.4;

/** A driveable line through the district. Heights are absolute. */
interface Road {
  id: string;
  pts: ReadonlyArray<readonly [number, number, number]>;
  width: number;
  /** 0 asphalt lane, 1 concrete ramp, 2 stepped chute */
  kind: 0 | 1 | 2;
}

const LANE_W = 5.9;
const RAMP_W = 4.7;
const CHUTE_W = 3.4;

/**
 * The Bajada del Perlo — the long descending traverse off the corniche in the
 * west. It hugs the cliff face under the fort and lands on Calle Alta.
 */
const BAJADA: Road = {
  id: 'bajada',
  width: 7.2,
  kind: 1,
  pts: [
    [-338, 20.75, -266.8],
    [-339, 20.8, -277],
    [-334, 19.4, -283],
    [-322, 17.6, -286],
    [-308, 16.0, -288.4],
    [-294, 14.4, -290.6],
    [-280, 13.3, -292.6],
    [-266, 13.0, -294.6],
  ],
};

/** The Subida — up through the east gate and back onto the corniche. */
const SUBIDA: Road = {
  id: 'subida',
  width: 6.6,
  kind: 1,
  pts: [
    [-96, 13.0, -294.6],
    [-92, 13.2, -291.6],
    [-88, 13.9, -289.6],
    [-83, 15.0, -287.4],
    [-77, 16.0, -285.2],
    [-72, 17.2, -282.4],
    [-68.5, 18.6, -278],
    [-68, 19.9, -270],
    [-69.5, 20.05, -259.2],
  ],
};

/** Ramps linking one terrace to the next, cut diagonally through a house row. */
const RAMPS: readonly Road[] = [
  { id: 'r-alta-media-w', width: RAMP_W, kind: 1, pts: [[-250, 13.0, -295.6], [-244, 12.4, -298.6], [-236, 10.6, -303.6], [-232.5, 9.6, -307.2]] },
  { id: 'r-alta-media-e', width: RAMP_W, kind: 1, pts: [[-140, 13.0, -295.6], [-146, 12.4, -298.6], [-154, 10.6, -303.6], [-157.5, 9.6, -307.2]] },
  { id: 'r-media-baja-w', width: RAMP_W, kind: 1, pts: [[-288, 9.6, -309.8], [-294, 8.7, -312.8], [-300, 7.1, -317.6], [-302, 6.2, -321.3]] },
  { id: 'r-media-baja-e', width: RAMP_W, kind: 1, pts: [[-170, 9.6, -309.8], [-164, 8.7, -312.8], [-156, 7.1, -317.6], [-153.5, 6.2, -321.3]] },
  { id: 'r-baja-mal-w', width: RAMP_W, kind: 1, pts: [[-268, 6.2, -324], [-274, 5.4, -327], [-282, 3.9, -331.4], [-285, 2.8, -335]] },
  { id: 'r-baja-mal-m', width: RAMP_W, kind: 1, pts: [[-200, 6.2, -324], [-194, 5.4, -327], [-186, 3.9, -331.4], [-183, 2.8, -335]] },
  { id: 'r-baja-mal-e', width: RAMP_W, kind: 1, pts: [[-118, 6.2, -324], [-112, 5.4, -327], [-104, 3.9, -331.4], [-101, 2.8, -335]] },
];

/** Stair chutes: steep, straight, rattly, and much faster if you make them. */
const CHUTES: readonly Road[] = [
  { id: 'c-alta-media-1', width: CHUTE_W, kind: 2, pts: [[-222, 13.0, -296.6], [-220, 9.6, -306.6]] },
  { id: 'c-alta-media-2', width: CHUTE_W, kind: 2, pts: [[-118, 13.0, -296.6], [-120, 9.6, -306.6]] },
  { id: 'c-media-baja-1', width: CHUTE_W, kind: 2, pts: [[-262, 9.6, -310.8], [-260, 6.2, -320.6]] },
  { id: 'c-media-baja-2', width: CHUTE_W, kind: 2, pts: [[-176, 9.6, -310.8], [-178, 6.2, -320.6]] },
  { id: 'c-baja-mal-1', width: CHUTE_W, kind: 2, pts: [[-238, 6.2, -325], [-236, 2.8, -334]] },
  { id: 'c-baja-mal-2', width: CHUTE_W, kind: 2, pts: [[-146, 6.2, -325], [-148, 2.8, -334]] },
];

/** Gates through the muralla, as x spans. */
const GATES: ReadonlyArray<readonly [number, number]> = [
  [-92.5, -84.5],
  [-186, -179],
];

/* ========================================================================== *
 *  bench field
 * ========================================================================== */

/** Which surface a bench cell carries, for tinting and for tyre friction. */
const SURF_TERRACE = 0;
const SURF_LANE = 1;
const SURF_RAMP = 2;
const SURF_ROCK = 3;
const SURF_SCARP = 4;
const SURF_SHINGLE = 5;

interface Sample {
  y: number;
  surf: number;
  /** 0..1 lateral position across a road, for the kerb and the crown */
  edge: number;
}

/* ========================================================================== *
 *  the layer
 * ========================================================================== */

export interface ElPerloOptions {
  /** share the world's texture cache (recommended) */
  textures?: TextureFactory;
  /** share the world's rain wetness drive */
  materials?: MaterialLibrary;
  /** multiplier on prop and planting counts */
  density?: number;
  /** metres past which the near LOD is swapped for the far one */
  lodDistance?: number;
}

const SECTORS = 4;

export class ElPerlo implements WorldLayer {
  readonly name = 'elPerlo';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: ElPerloOptions;

  private layout: CityLayout | null = null;
  private physics: PhysicsWorldAPI | null = null;
  private bodies: BodyHandle[] = [];

  private textures: TextureFactory | null = null;
  private ownTextures = false;
  private atlasSize = 1024;

  private shellMat: THREE.MeshStandardMaterial | null = null;
  private cutMat: THREE.MeshStandardMaterial | null = null;
  private benchMat: THREE.MeshStandardMaterial | null = null;

  private nightUniform = { value: 0 };
  private wetUniform: { value: number } = { value: 0 };

  private nearMeshes: THREE.Mesh[] = [];
  private farMeshes: THREE.Mesh[] = [];
  private cutMeshes: THREE.Mesh[] = [];
  private benchMeshes: THREE.Mesh[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  /** the graded height field, sampled on a CELL grid */
  private gw = 0;
  private gh = 0;
  private grid: Float32Array = new Float32Array(0);
  private surf: Uint8Array = new Uint8Array(0);
  private glow: Float32Array = new Float32Array(0);

  private roads: Road[] = [];
  private houses: HouseSpec[] = [];

  private _stats = {
    houses: 0,
    palms: 0,
    poles: 0,
    cars: 0,
    benchTriangles: 0,
    shellTriangles: 0,
    cutTriangles: 0,
    farTriangles: 0,
    colliderTriangles: 0,
    drawCalls: 0,
  };

  constructor(quality: QualityTier, options: ElPerloOptions = {}) {
    this.quality = quality;
    this.options = { density: 1, lodDistance: 210, ...options };
    this.group.name = 'world/elPerlo';
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.layout = layout;
    this.physics = opts.physics;
    this.textures = this.options.textures ?? new TextureFactory(this.quality);
    this.ownTextures = !this.options.textures;
    if (this.options.materials) this.wetUniform = this.options.materials.wetnessUniform;

    const maps = elPerloAtlas(this.textures, this.quality);
    this.atlasSize = maps.size;
    this.makeMaterials(maps);

    this.roads = [BAJADA, SUBIDA, ...RAMPS, ...CHUTES, ...this.laneRoads()];
    this.buildField();

    const rng = opts.rng.fork(0x9e2b);
    this.planHouses(rng.fork(1));
    this.emit(rng.fork(2), opts);
    this._stats.drawCalls = this.countDrawCalls();
  }

  /* ------------------------------------------------- the lanes as roads */

  private laneRoads(): Road[] {
    const out: Road[] = [];
    for (let i = 0; i < LEVELS.length; i++) {
      const L = LEVELS[i];
      const x0 = i === 3 ? BARRIO_X0 - 16 : BARRIO_X0 - 4;
      const x1 = i === 3 ? BARRIO_X1 + 16 : BARRIO_X1 + 4;
      // a lane that drifts a little: dead-straight roads read as a car park
      const pts: Array<[number, number, number]> = [];
      const n = 8;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = lerp(x0, x1, t);
        const wob = Math.sin(t * Math.PI * (1.6 + i * 0.5) + i) * (i === 3 ? 1.9 : 1.1);
        const grade = Math.sin(t * Math.PI * 2 + i * 1.3) * 0.35;
        pts.push([x, L.y + grade, L.z + wob]);
      }
      out.push({ id: `lane-${L.name}`, pts, width: i === 3 ? LANE_W * 1.55 : LANE_W, kind: 0 });
    }
    return out;
  }

  /* ------------------------------------------------------- height field */

  /** The terrace profile before any road is carved into it. */
  private terraceY(x: number, z: number): { y: number; surf: number } {
    // Behind the wall the bench simply follows the world.
    const gh = this.layout ? this.layout.groundHeight(x, z) : 0;
    if (z > WALL_Z + 1.5) return { y: gh + (z > APRON_Z ? 0.07 : 0.12), surf: SURF_SCARP };

    // The barrio only fills the middle of the site; the ends are rock headland.
    const endW = 26;
    const inX =
      smoothstep((x - (BARRIO_X0 - endW)) / endW) * (1 - smoothstep((x - (BARRIO_X1)) / endW));

    // stepped platforms
    let plat = LEVELS[0].y;
    let surf = SURF_TERRACE;
    const riser = 1.15;
    const edges: Array<[number, number]> = [
      [LEVELS[0].rowSea, LEVELS[1].y],
      [LEVELS[1].rowSea, LEVELS[2].y],
      [LEVELS[2].rowSea, LEVELS[3].y],
    ];
    for (const [zEdge, y] of edges) {
      const t = smoothstep((zEdge - z) / riser);
      plat = lerp(plat, y, t);
      if (t > 0.02 && t < 0.98) surf = SURF_SCARP;
    }
    // scarp above Calle Alta: rise from the top terrace to the wall footing
    const back = smoothstep((z - (LEVELS[0].z - LEVELS[0].hw - 0.6)) / 3.2);
    if (back > 0.01) {
      const wallFoot = Math.max(LEVELS[0].y, gh);
      plat = lerp(plat, wallFoot, back);
      if (back > 0.06) surf = SURF_SCARP;
    }

    // seaward of the malecón: seawall, then the rock revetment into the water
    if (z < REVET_Z) {
      const t = clamp01((REVET_Z - z) / (REVET_Z - TOE_Z));
      plat = lerp(LEVELS[3].y, TOE_Y, t * t * (3 - 2 * t));
      surf = t > 0.25 ? SURF_ROCK : SURF_SCARP;
      if (t > 0.86) surf = SURF_SHINGLE;
    }

    // the headland ends fall away to the sea
    const y = lerp(Math.min(gh + 0.12, LEVELS[3].y - 1.4), plat, inX);
    if (inX < 0.72) surf = SURF_ROCK;
    return { y: Math.max(y, gh + 0.12), surf };
  }

  /** Distance from `(x,z)` to a polyline, plus the interpolated height. */
  private roadAt(r: Road, x: number, z: number, out: { d: number; y: number; t: number }): boolean {
    let bestD = Infinity;
    let bestY = 0;
    let bestT = 0;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-6 ? ((x - a[0]) * dx + (z - a[2]) * dz) / len2 : 0;
      t = clamp01(t);
      const px = a[0] + dx * t;
      const pz = a[2] + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) {
        bestD = d;
        bestY = lerp(a[1], b[1], t);
        bestT = (i + t) / (r.pts.length - 1);
      }
    }
    out.d = bestD;
    out.y = bestY;
    out.t = bestT;
    return bestD < r.width * 0.5 + 6;
  }

  private sampleField(x: number, z: number, out: Sample): void {
    const base = this.terraceY(x, z);
    let y = base.y;
    let surf = base.surf;
    let edge = 1;
    const hit = { d: 0, y: 0, t: 0 };
    let bestPriority = -1;
    for (const r of this.roads) {
      if (!this.roadAt(r, x, z, hit)) continue;
      const hw = r.width * 0.5;
      const blend = r.kind === 0 ? 3.6 : 2.6;
      if (hit.d > hw + blend) continue;
      // the carriageway crown: 2 % cross-fall, exactly as the city's streets
      const lateral = clamp01(hit.d / hw);
      const crown = r.kind === 0 ? -lateral * lateral * hw * 0.02 : 0;
      const roadY = hit.y + crown;
      const w = 1 - smoothstep(clamp01((hit.d - hw) / blend));
      const priority = r.kind === 0 ? 3 : r.kind === 1 ? 2 : 1;
      if (w > 0.001 && priority >= bestPriority) {
        y = lerp(y, roadY, w);
        if (w > 0.5) {
          surf = r.kind === 0 ? SURF_LANE : SURF_RAMP;
          edge = Math.min(edge, lateral);
          bestPriority = priority;
        }
      }
    }
    const gh = this.layout ? this.layout.groundHeight(x, z) : 0;
    out.y = Math.max(y, gh + 0.1);
    out.surf = surf;
    out.edge = edge;
  }

  private buildField(): void {
    this.gw = Math.ceil((SITE.x1 - SITE.x0) / CELL) + 1;
    this.gh = Math.ceil((SITE.z0 - SITE.z1) / CELL) + 1;
    this.grid = new Float32Array(this.gw * this.gh);
    this.surf = new Uint8Array(this.gw * this.gh);
    this.glow = new Float32Array(this.gw * this.gh);
    const s: Sample = { y: 0, surf: 0, edge: 1 };
    for (let j = 0; j < this.gh; j++) {
      const z = SITE.z0 - j * CELL;
      for (let i = 0; i < this.gw; i++) {
        const x = SITE.x0 + i * CELL;
        this.sampleField(x, z, s);
        const k = j * this.gw + i;
        this.grid[k] = s.y;
        this.surf[k] = s.surf;
      }
    }
    // one light smoothing pass so the collider has no single-cell spikes
    const copy = this.grid.slice();
    for (let j = 1; j < this.gh - 1; j++) {
      for (let i = 1; i < this.gw - 1; i++) {
        const k = j * this.gw + i;
        if (this.surf[k] === SURF_SCARP || this.surf[k] === SURF_ROCK) continue;
        const avg =
          (copy[k] * 4 + copy[k - 1] + copy[k + 1] + copy[k - this.gw] + copy[k + this.gw]) / 8;
        this.grid[k] = lerp(copy[k], avg, 0.55);
      }
    }
    /* Never dip below the world's own terrain after smoothing. The bench is
     * sampled bilinearly, so clamping node-by-node is not enough where the
     * terrain is convex between two nodes: take the maximum over a half-cell
     * neighbourhood instead. */
    if (this.layout) {
      const gh = this.layout.groundHeight;
      const h = CELL * 0.5;
      for (let j = 0; j < this.gh; j++) {
        const z = SITE.z0 - j * CELL;
        for (let i = 0; i < this.gw; i++) {
          const x = SITE.x0 + i * CELL;
          let g = gh(x, z);
          for (const dx of [-h, 0, h]) {
            for (const dz of [-h, 0, h]) {
              const q = gh(x + dx, z + dz);
              if (q > g) g = q;
            }
          }
          const k = j * this.gw + i;
          const lift = z > APRON_Z ? 0.07 : 0.12;
          if (this.grid[k] < g + lift) this.grid[k] = g + lift;
        }
      }
    }
  }

  /** Bilinear height of the graded bench. */
  benchHeight(x: number, z: number): number {
    const fx = clamp((x - SITE.x0) / CELL, 0, this.gw - 1.0001);
    const fz = clamp((SITE.z0 - z) / CELL, 0, this.gh - 1.0001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const r0 = j * this.gw;
    const r1 = r0 + this.gw;
    return lerp(
      lerp(this.grid[r0 + i], this.grid[r0 + i + 1], tx),
      lerp(this.grid[r1 + i], this.grid[r1 + i + 1], tx),
      tz,
    );
  }

  private surfaceAt(x: number, z: number): number {
    const i = clamp(Math.round((x - SITE.x0) / CELL), 0, this.gw - 1);
    const j = clamp(Math.round((SITE.z0 - z) / CELL), 0, this.gh - 1);
    return this.surf[j * this.gw + i];
  }

  /** Add a soft pool of night light around a lamp, baked into the bench. */
  private addLampPool(x: number, z: number, radius: number, amount: number): void {
    const i0 = clamp(Math.floor((x - radius - SITE.x0) / CELL), 0, this.gw - 1);
    const i1 = clamp(Math.ceil((x + radius - SITE.x0) / CELL), 0, this.gw - 1);
    const j0 = clamp(Math.floor((SITE.z0 - z - radius) / CELL), 0, this.gh - 1);
    const j1 = clamp(Math.ceil((SITE.z0 - z + radius) / CELL), 0, this.gh - 1);
    for (let j = j0; j <= j1; j++) {
      const cz = SITE.z0 - j * CELL;
      for (let i = i0; i <= i1; i++) {
        const cx = SITE.x0 + i * CELL;
        const d = Math.hypot(cx - x, cz - z) / radius;
        if (d >= 1) continue;
        const k = j * this.gw + i;
        this.glow[k] = Math.min(1.4, this.glow[k] + amount * (1 - d) * (1 - d));
      }
    }
  }

  /* ------------------------------------------------------------ planning */

  private planHouses(rng: RNG): void {
    this.houses = [];
    let paintCursor = rng.int(0, PAINT.length - 1);
    for (let li = 0; li < 3; li++) {
      const L = LEVELS[li];
      const below = LEVELS[li + 1];
      let x = BARRIO_X0 + rng.range(0, 3);
      const end = BARRIO_X1;
      let run = 0;
      let runStorey = 0;
      let prevOpen = true;
      const row: HouseSpec[] = [];
      while (x < end - 3.6) {
        const w = rng.range(3.5, 6.1);
        if (x + w > end) break;
        // gaps: a callejón, a stair, or just a slot nobody ever built on
        const gapAfter = run >= rng.int(4, 10);
        const storeys = rng.weighted([1, 2, 3], L.storeyW as unknown as number[]);
        // keep runs of equal-height houses together so the roofs stay flush
        const st = run > 0 && runStorey === 1 && rng.bool(0.62) ? 1 : storeys;
        paintCursor = (paintCursor + rng.int(5, 9)) % PAINT.length;
        const jitterSea = rng.range(-0.55, 0.35);
        const jitterHill = rng.range(-0.3, 0.5);
        if (this.onRamp(x, x + w, L.rowSea, L.rowHill)) {
          x += w + rng.range(0.4, 1.2);
          prevOpen = true;
          run = 0;
          continue;
        }
        const spec: HouseSpec = {
          x0: x,
          x1: x + w,
          zSea: L.rowSea + jitterSea,
          zHill: L.rowHill + jitterHill,
          yFront: below.y,
          yBack: L.y,
          storeys: st,
          paint: PAINT[paintCursor],
          trim: TRIM[rng.int(0, TRIM.length - 1)],
          joinery: JOINERY[rng.int(0, JOINERY.length - 1)],
          openMinus: prevOpen,
          openPlus: gapAfter,
          unfinished: st < 3 && rng.bool(0.16),
          roofRun: false,
          dressing: rng.weighted([0, 1, 2], [7, 1.4, 0.9]),
          seed: rng.int(1, 0x7fffffff),
        };
        row.push(spec);
        x += w + (gapAfter ? rng.range(1.4, 2.9) : rng.range(0, 0.12));
        prevOpen = gapAfter;
        run = gapAfter ? 0 : run + 1;
        runStorey = st;
      }
      // designate rooftop runs: four or more flush single-storey roofs in a row
      let i = 0;
      while (i < row.length) {
        let j = i;
        while (j < row.length && row[j].storeys === 1 && !row[j].openPlus) j++;
        if (j < row.length && row[j].storeys === 1) j++;
        if (j - i >= 4) {
          for (let k = i; k < j; k++) {
            row[k].roofRun = true;
            row[k].zHill = L.rowHill;
            row[k].zSea = L.rowSea;
            row[k].unfinished = false;
          }
        }
        i = Math.max(j, i + 1);
      }
      this.houses.push(...row);
    }
    this._stats.houses = this.houses.length;
  }

  /* -------------------------------------------------------------- emit */

  private sectorOf(x: number): number {
    const t = (x - SITE.x0) / (SITE.x1 - SITE.x0);
    return clamp(Math.floor(t * SECTORS), 0, SECTORS - 1);
  }

  private emit(rng: RNG, opts: WorldOpts): void {
    const size = this.atlasSize;
    const near: Mesher[] = [];
    const far: Mesher[] = [];
    const cut: Mesher[] = [];
    for (let i = 0; i < SECTORS; i++) {
      near.push(new Mesher());
      far.push(new Mesher());
      cut.push(new Mesher());
    }
    const colPos: number[] = [];
    const colIdx: number[] = [];

    /* ---- houses ---- */
    for (const h of this.houses) {
      const s = this.sectorOf((h.x0 + h.x1) * 0.5);
      buildHouse(near[s], cut[s], h, size);
      this.farHouse(far[s], h, size);
      const roofY = h.yFront + EP.storey * h.storeys;
      const hr = new RNG(h.seed ^ 0x51ed);
      buildRoofClutter(
        near[s], cut[s],
        { x0: h.x0, x1: h.x1, zSea: h.zSea, zHill: h.zHill, y: roofY, keepClear: h.roofRun, density: this.options.density ?? 1 },
        hr, size,
      );
      this.houseCollider(colPos, colIdx, h, roofY);
      if (h.roofRun) this.addLampPool((h.x0 + h.x1) * 0.5, (h.zSea + h.zHill) * 0.5, 5, 0.1);
    }

    /* ---- retaining walls under each row, and the lane kerbs ---- */
    for (let li = 0; li < 3; li++) {
      const L = LEVELS[li];
      const below = LEVELS[li + 1];
      const gaps = this.rowGaps(li);
      for (const [gx0, gx1] of gaps) {
        const s = this.sectorOf((gx0 + gx1) * 0.5);
        buildRetaining(near[s], gx0, gx1, L.rowSea, below.y, L.y - 0.1, rng, size,
          rng.bool(0.4) ? PAINT[rng.int(0, PAINT.length - 1)] : -1);
      }
    }

    /* ---- the muralla, its garita and its gates ---- */
    const crest = (x: number): number =>
      lerp(19.9, 18.4, clamp01((x - (BARRIO_X0 - 12)) / (BARRIO_X1 + 12 - (BARRIO_X0 - 12)))) +
      Math.sin(x * 0.021) * 0.35;
    const wallBase = (x: number): number =>
      Math.max(LEVELS[0].y + 0.6, this.layout ? this.layout.groundHeight(x, WALL_Z + 1.2) : 12);
    for (let s = 0; s < SECTORS; s++) {
      const wx0 = Math.max(BARRIO_X0 - 14, SITE.x0 + (s * (SITE.x1 - SITE.x0)) / SECTORS);
      const wx1 = Math.min(BARRIO_X1 + 14, SITE.x0 + ((s + 1) * (SITE.x1 - SITE.x0)) / SECTORS);
      if (wx1 - wx0 < 2) continue;
      buildMuralla(near[s], wx0, wx1, WALL_Z, crest, wallBase, size, GATES);
      buildMuralla(far[s], wx0, wx1, WALL_Z, crest, wallBase, size, GATES, 9);
    }
    buildGarita(near[this.sectorOf(-268)], -268, crest(-268), WALL_Z - 1.4, size);
    buildGarita(far[this.sectorOf(-268)], -268, crest(-268), WALL_Z - 1.4, size);
    this.wallCollider(colPos, colIdx, crest, wallBase);
    // the azulejo plaque naming the barrio, on the jamb of the west gate
    {
      const s = this.sectorOf(-182.5);
      const cy = crest(-182.5);
      near[s].cardZ(-183.6, cy - 3.0, -182.4, cy - 1.8, WALL_Z - 1.12, tile('azulejo', size), rgb(0xffffff));
      near[s].cardZ(-100, 14.2, -96.6, 15.6, LEVELS[0].rowSea - 0.62, tile('signPerlo', size), rgb(0xffffff), true, 0.5);
    }

    /* ---- shore: boulders, skiffs, a slipway ---- */
    for (let i = 0; i < Math.round(46 * (this.options.density ?? 1)); i++) {
      const x = rng.range(SITE.x0 + 12, SITE.x1 - 12);
      const z = rng.range(REVET_Z - 1, TOE_Z + 1.5);
      const y = this.benchHeight(x, z);
      if (y > 3.6) continue;
      buildBoulder(near[this.sectorOf(x)], x, y + 0.1, z, rng.range(0.8, 2.6), rng.range(0.5, 2.0), rng, size);
    }
    for (let i = 0; i < 3; i++) {
      const x = rng.range(BARRIO_X0 + 20, BARRIO_X1 - 20);
      const z = REVET_Z - rng.range(0.5, 2.5);
      buildSkiff(near[this.sectorOf(x)], x, this.benchHeight(x, z) + 0.15, z, rng.range(-0.5, 0.5) + Math.PI * 0.5, rng, size);
    }

    /* ---- planting: palms in the gaps and behind the top row ---- */
    const palmCount = Math.round(70 * (this.options.density ?? 1));
    for (let i = 0; i < palmCount; i++) {
      const x = rng.range(BARRIO_X0 - 24, BARRIO_X1 + 24);
      const z = rng.range(WALL_Z + 8, TOE_Z + 6);
      const y = this.benchHeight(x, z);
      const sf = this.surfaceAt(x, z);
      if (sf === SURF_LANE || sf === SURF_RAMP) continue;
      if (this.overlapsHouse(x, z, 3.2)) continue;
      buildPalm(near[this.sectorOf(x)], cut[this.sectorOf(x)], x, y - 0.2, z, rng, size);
      this._stats.palms++;
    }
    const bushKinds: TileId[] = ['sprig', 'flowers', 'tuft', 'banana'];
    for (let i = 0; i < Math.round(300 * (this.options.density ?? 1)); i++) {
      const x = rng.range(SITE.x0 + 6, SITE.x1 - 6);
      const z = rng.range(WALL_Z + 10, TOE_Z + 4);
      const y = this.benchHeight(x, z);
      const sf = this.surfaceAt(x, z);
      if (sf === SURF_LANE || sf === SURF_RAMP || sf === SURF_SHINGLE) continue;
      if (this.overlapsHouse(x, z, 1.4)) continue;
      buildBush(cut[this.sectorOf(x)], x, y - 0.15, z, rng.range(0.5, 1.5), rng.pick(bushKinds), rng, size);
    }

    /* ---- utility poles and the wires between them ---- */
    const poleRows: Array<{ z: number; y: number }> = [
      { z: LEVELS[0].z + LEVELS[0].hw + 0.8, y: LEVELS[0].y },
      { z: LEVELS[1].z + LEVELS[1].hw + 0.8, y: LEVELS[1].y },
      { z: LEVELS[2].z + LEVELS[2].hw + 0.8, y: LEVELS[2].y },
      { z: MALECON.z + MALECON.hw + 1.2, y: MALECON.y },
    ];
    for (const row of poleRows) {
      let prev: [number, number, number] | null = null;
      for (let x = BARRIO_X0 - 4; x < BARRIO_X1 + 6; x += rng.range(24, 34)) {
        const zz = row.z + rng.range(-0.6, 0.6);
        const y = this.benchHeight(x, zz);
        if (y < SEA_LEVEL + 1) continue;
        const h = rng.range(7.5, 9.4);
        const s = this.sectorOf(x);
        buildPole(near[s], cut[s], x, y, zz, h, rng, size);
        this._stats.poles++;
        this.addLampPool(x, zz, 9.5, 0.55);
        if (prev) {
          for (const dy of [0, -0.55, -1.0]) {
            buildWire(cut[s], prev[0], prev[1] + dy, prev[2], x, y + h - 0.9 + dy, zz, 1.3, size);
          }
        }
        prev = [x, y + h - 0.9, zz];
      }
    }
    // washing strung across the narrow lanes, which is what actually happens
    for (let i = 0; i < Math.round(16 * (this.options.density ?? 1)); i++) {
      const li = rng.int(0, 2);
      const L = LEVELS[li];
      const x = rng.range(BARRIO_X0 + 8, BARRIO_X1 - 14);
      const y = L.y + rng.range(4.4, 5.6);
      laundryLine(cut[this.sectorOf(x)], x, x + rng.range(6, 11), y, L.rowHill + rng.range(-1.2, 1.2), rng, size);
    }

    /* ---- parked cars wherever they fit ---- */
    const carCount = Math.round(22 * (this.options.density ?? 1));
    for (let i = 0; i < carCount; i++) {
      const li = rng.int(0, 3);
      const L = LEVELS[li];
      const x = rng.range(BARRIO_X0 + 4, BARRIO_X1 - 4);
      const side = rng.bool() ? 1 : -1;
      const z = L.z + side * (L.hw - 1.2);
      const y = this.benchHeight(x, z);
      if (this.surfaceAt(x, z) !== SURF_LANE) continue;
      buildCar(near[this.sectorOf(x)], x, y, z, rng.bool(0.82) ? 0 : Math.PI * 0.5, rng, size);
      this._stats.cars++;
    }

    /* ---- public stairs in the gaps between houses ---- */
    for (let li = 0; li < 3; li++) {
      const L = LEVELS[li];
      const below = LEVELS[li + 1];
      for (const [gx0, gx1] of this.rowGaps(li)) {
        if (gx1 - gx0 < 1.4 || gx1 - gx0 > 3.6) continue;
        const s = this.sectorOf((gx0 + gx1) * 0.5);
        buildStairs(near[s], cut[s], gx0 + 0.25, gx1 - 0.25, L.rowSea + 0.2, L.y, below.z - below.hw - 0.4, below.y, size);
      }
    }

    /* ---- the bench itself ---- */
    this.buildBench(colPos, colIdx);

    /* ---- publish ---- */
    for (let s = 0; s < SECTORS; s++) {
      const g = near[s].build(`elPerlo/shell${s}`);
      if (g && this.shellMat) {
        const m = new THREE.Mesh(g, this.shellMat);
        m.name = `elPerlo/shell${s}`;
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        this.nearMeshes.push(m);
        this.geometries.push(g);
        this._stats.shellTriangles += near[s].triangleCount;
      }
      const gf = far[s].build(`elPerlo/far${s}`);
      if (gf && this.shellMat) {
        const m = new THREE.Mesh(gf, this.shellMat);
        m.name = `elPerlo/far${s}`;
        m.castShadow = true;
        m.receiveShadow = true;
        m.visible = false;
        this.group.add(m);
        this.farMeshes.push(m);
        this.geometries.push(gf);
        this._stats.farTriangles += far[s].triangleCount;
      }
      const gc = cut[s].build(`elPerlo/cut${s}`);
      if (gc && this.cutMat) {
        const m = new THREE.Mesh(gc, this.cutMat);
        m.name = `elPerlo/cut${s}`;
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        this.cutMeshes.push(m);
        this.geometries.push(gc);
        this._stats.cutTriangles += cut[s].triangleCount;
      }
    }

    /* ---- colliders ---- */
    this.makeBody(colPos, colIdx, 0.98, 'concrete', opts.physics);
  }

  /** Spans of `x` where a row has no house — alleys, stair gaps, empty plots. */
  private rowGaps(li: number): Array<[number, number]> {
    const L = LEVELS[li];
    const row = this.houses.filter((h) => Math.abs(h.zHill - L.rowHill) < 3.5);
    row.sort((a, b) => a.x0 - b.x0);
    const gaps: Array<[number, number]> = [];
    let cursor = BARRIO_X0;
    for (const h of row) {
      if (h.x0 - cursor > 0.4) gaps.push([cursor, h.x0]);
      cursor = Math.max(cursor, h.x1);
    }
    if (BARRIO_X1 - cursor > 0.4) gaps.push([cursor, BARRIO_X1]);
    return gaps;
  }

  /** True when a footprint straddles one of the connector ramps or chutes. */
  private onRamp(x0: number, x1: number, zSea: number, zHill: number): boolean {
    const hit = { d: 0, y: 0, t: 0 };
    for (const r of this.roads) {
      if (r.kind === 0 || r.id === 'bajada' || r.id === 'subida') continue;
      const pad = r.width * 0.5 + 1.9;
      for (let x = x0; x <= x1 + 0.01; x += 1) {
        for (const z of [zSea + 0.5, (zSea + zHill) * 0.5, zHill - 0.5]) {
          this.roadAt(r, x, z, hit);
          if (hit.d < pad) return true;
        }
      }
    }
    return false;
  }

  private overlapsHouse(x: number, z: number, pad: number): boolean {
    for (const h of this.houses) {
      if (x > h.x0 - pad && x < h.x1 + pad && z > h.zSea - pad && z < h.zHill + pad) return true;
    }
    return false;
  }

  /** The far LOD: the painted box, its parapet, and nothing else. */
  private farHouse(m: Mesher, h: HouseSpec, size: number): void {
    const paint = rgb(h.paint);
    const roofY = h.yFront + EP.storey * h.storeys;
    const rect = tile('render1', size);
    const bot = shade(paint, 0.58);
    const top = mixCol(shade(paint, 1.08), { r: 1, g: 1, b: 1 }, 0.14);
    m.wall(0, h.x0, h.x1, h.yFront - 0.45, roofY + EP.parapet, h.zSea, rect, bot, top, 2);
    if (h.openMinus) m.wall(3, h.zSea, h.zHill, h.yFront - 0.2, roofY + EP.parapet, h.x0, rect, bot, top, 1);
    if (h.openPlus) m.wall(1, h.zSea, h.zHill, h.yFront - 0.2, roofY + EP.parapet, h.x1, rect, bot, top, 1);
    m.wall(2, h.x0, h.x1, Math.min(h.yBack - 0.4, roofY - 0.05), roofY + EP.parapet, h.zHill, rect, shade(bot, 0.9), shade(top, 0.9), 1);
    m.deck(h.x0, h.zSea, h.x1, h.zHill, roofY, tile('roofdeck', size), rgb(CONCRETE.roof));
  }

  /* --------------------------------------------------------- the bench */

  private buildBench(colPos: number[], colIdx: number[]): void {
    const size = this.atlasSize;
    const tints: Col[] = [
      rgb(0xa39c8c), // terrace concrete
      rgb(0x8d8d8a), // lane asphalt
      rgb(0xb2ada0), // concrete ramp
      rgb(0x5f5d59), // rock
      rgb(0x8f8b76), // scarp / earth
      rgb(0x7d7364), // shingle
    ];
    const rects: Rect[] = [
      tile('concrete', size),
      tile('asphalt', size),
      tile('concrete', size),
      tile('rock', size),
      tile('rubble', size),
      tile('shingle', size),
    ];
    // A whole-metre UV lattice: the bench uses one atlas cell per surface, so
    // each quad maps its own slice of that cell rather than stretching it.
    const meshers: Mesher[] = [];
    for (let s = 0; s < SECTORS; s++) meshers.push(new Mesher());

    const colOf = (i: number, j: number): { c: Col; r: Rect } => {
      const k = j * this.gw + i;
      const sf = this.surf[k];
      let c = tints[sf];
      // wear the wheel paths into the lanes and bleach the seaward faces
      const y = this.grid[k];
      if (sf === SURF_ROCK || sf === SURF_SHINGLE) {
        const wet = clamp01((2.4 - y) / 3.2);
        c = mixCol(c, shade(c, 0.42), wet * 0.8);
      } else {
        const salt = clamp01((y - 1) / 16);
        c = mixCol(c, shade(c, 1.14), salt * 0.5);
      }
      return { c, r: rects[sf] };
    };

    const uvScale = 0.11;
    for (let j = 0; j < this.gh - 1; j++) {
      for (let i = 0; i < this.gw - 1; i++) {
        const x0 = SITE.x0 + i * CELL;
        const x1 = x0 + CELL;
        const z0 = SITE.z0 - j * CELL;
        const z1 = z0 - CELL;
        const y00 = this.grid[j * this.gw + i];
        const y10 = this.grid[j * this.gw + i + 1];
        const y01 = this.grid[(j + 1) * this.gw + i];
        const y11 = this.grid[(j + 1) * this.gw + i + 1];
        // On the promenade strip the bench only exists where a ramp crosses it.
        if (z0 > APRON_Z) {
          const k00 = this.surf[j * this.gw + i];
          const k10 = this.surf[j * this.gw + i + 1];
          const k01 = this.surf[(j + 1) * this.gw + i];
          const k11 = this.surf[(j + 1) * this.gw + i + 1];
          const road = (v: number): boolean => v === SURF_LANE || v === SURF_RAMP;
          if (!road(k00) && !road(k10) && !road(k01) && !road(k11)) continue;
        }
        const { c, r } = colOf(i, j);
        const m = meshers[this.sectorOf((x0 + x1) * 0.5)];
        // per-quad UV slice, so the atlas cell is walked rather than stretched
        const uu0 = lerp(r.u0, r.u1, ((i * CELL * uvScale) % 1) * 0.86 + 0.07);
        const uu1 = lerp(r.u0, r.u1, (((i + 1) * CELL * uvScale) % 1) * 0.86 + 0.07);
        const vv0 = lerp(r.v0, r.v1, ((j * CELL * uvScale) % 1) * 0.86 + 0.07);
        const vv1 = lerp(r.v0, r.v1, (((j + 1) * CELL * uvScale) % 1) * 0.86 + 0.07);
        const sub: Rect = { u0: uu0, v0: vv0, u1: uu1, v1: vv1 };
        const g00 = this.glow[j * this.gw + i];
        const g10 = this.glow[j * this.gw + i + 1];
        const g01 = this.glow[(j + 1) * this.gw + i];
        const g11 = this.glow[(j + 1) * this.gw + i + 1];
        _a.set(x0, y00, z0);
        _b.set(x1, y10, z0);
        _cv.set(x1, y11, z1);
        _d.set(x0, y01, z1);
        _n1.subVectors(_b, _a).cross(_e.subVectors(_d, _a)).normalize();
        const ia = m.vert(_a.x, _a.y, _a.z, _n1.x, _n1.y, _n1.z, sub.u0, sub.v0, c, g00 * 0.22, 0.15, 0.5);
        const ib = m.vert(_b.x, _b.y, _b.z, _n1.x, _n1.y, _n1.z, sub.u1, sub.v0, c, g10 * 0.22, 0.15, 0.5);
        const ic = m.vert(_cv.x, _cv.y, _cv.z, _n1.x, _n1.y, _n1.z, sub.u1, sub.v1, c, g11 * 0.22, 0.15, 0.5);
        const id = m.vert(_d.x, _d.y, _d.z, _n1.x, _n1.y, _n1.z, sub.u0, sub.v1, c, g01 * 0.22, 0.15, 0.5);
        m.tri(ia, ib, ic);
        m.tri(ia, ic, id);
        const base = colPos.length / 3;
        colPos.push(x0, y00, z0, x1, y10, z0, x1, y11, z1, x0, y01, z1);
        colIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    for (let s = 0; s < SECTORS; s++) {
      const g = meshers[s].build(`elPerlo/bench${s}`);
      if (!g || !this.benchMat) continue;
      const m = new THREE.Mesh(g, this.benchMat);
      m.name = `elPerlo/bench${s}`;
      m.receiveShadow = true;
      m.castShadow = false;
      this.group.add(m);
      this.benchMeshes.push(m);
      this.geometries.push(g);
      this._stats.benchTriangles += meshers[s].triangleCount;
    }
  }

  /* ------------------------------------------------------------ colliders */

  private houseCollider(pos: number[], idx: number[], h: HouseSpec, roofY: number): void {
    const top = roofY + EP.parapet;
    const y0 = Math.min(h.yFront, h.yBack) - 0.5;
    const push = (
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    ): void => {
      const b = pos.length / 3;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    // four sides up to the parapet, plus the drivable roof deck
    push(h.x0, y0, h.zSea, h.x1, y0, h.zSea, h.x1, top, h.zSea, h.x0, top, h.zSea);
    push(h.x1, y0, h.zHill, h.x0, y0, h.zHill, h.x0, top, h.zHill, h.x1, top, h.zHill);
    push(h.x0, y0, h.zHill, h.x0, y0, h.zSea, h.x0, top, h.zSea, h.x0, top, h.zHill);
    push(h.x1, y0, h.zSea, h.x1, y0, h.zHill, h.x1, top, h.zHill, h.x1, top, h.zSea);
    push(h.x0, roofY, h.zSea, h.x1, roofY, h.zSea, h.x1, roofY, h.zHill, h.x0, roofY, h.zHill);
    // the parapet ring, so you cannot slide off a roof by accident
    const pt = EP.parapetT;
    const ph = h.roofRun ? 0.13 : EP.parapet;
    push(h.x0, roofY, h.zSea + pt, h.x1, roofY, h.zSea + pt, h.x1, roofY + EP.parapet, h.zSea + pt, h.x0, roofY + EP.parapet, h.zSea + pt);
    push(h.x1, roofY, h.zHill - pt, h.x0, roofY, h.zHill - pt, h.x0, roofY + ph, h.zHill - pt, h.x1, roofY + ph, h.zHill - pt);
    push(h.x0, roofY, h.zSea, h.x0 + pt, roofY, h.zSea, h.x0 + pt, roofY, h.zHill, h.x0, roofY, h.zHill);
    this._stats.colliderTriangles += 16;
  }

  private wallCollider(
    pos: number[], idx: number[],
    crest: (x: number) => number, base: (x: number) => number,
  ): void {
    const step = 6;
    for (let x = BARRIO_X0 - 14; x < BARRIO_X1 + 14; x += step) {
      let gated = false;
      for (const g of GATES) if (x + step > g[0] && x < g[1]) gated = true;
      if (gated) continue;
      const xa = x;
      const xb = Math.min(x + step, BARRIO_X1 + 14);
      const ca = crest(xa);
      const cb = crest(xb);
      const ba = base(xa) - 0.7;
      const bb = base(xb) - 0.7;
      const zo = WALL_Z - 1.05;
      const b = pos.length / 3;
      pos.push(xa, ba, zo - (ca - ba) * 0.15, xb, bb, zo - (cb - bb) * 0.15, xb, cb, zo, xa, ca, zo);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }

  private makeBody(pos: number[], idx: number[], friction: number, surface: string, physics: PhysicsWorldAPI): void {
    if (idx.length === 0) return;
    const body = physics.createBody({
      kind: 'static',
      shape: { type: 'trimesh', vertices: new Float32Array(pos), indices: new Uint32Array(idx) },
      position: new THREE.Vector3(0, 0, 0),
      friction,
      restitution: 0.02,
      group: GROUP.WORLD,
      mask: GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS | GROUP.TRIGGER,
      userData: { kind: 'world', surface },
    });
    this.bodies.push(body);
    this._stats.colliderTriangles += idx.length / 3;
  }

  /* ------------------------------------------------------------ materials */

  private makeMaterials(maps: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }): void {
    const aniso = QUALITY_BUDGET[this.quality].anisotropy;
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.anisotropy = aniso;

    /**
     * The shell is where the zinc lives, and a corrugated zinc roof in rain is
     * the single most recognisable thing about this place. A wet-only clearcoat
     * (nothing at all when dry — the shell's atlas is deliberately chalky) buys
     * that for one program and no extra texture.
     */
    const shellParams = {
      name: 'elPerlo/shell',
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.85,
    };
    const coat = this.quality !== 'low';
    this.shellMat = coat
      ? new THREE.MeshPhysicalMaterial({ ...shellParams, clearcoat: 0.02, clearcoatRoughness: 0.12 })
      : new THREE.MeshStandardMaterial(shellParams);
    // §5 / §8.22 — painted render is not plastic; keep the normal quiet
    this.shellMat.normalScale.set(0.5, 0.5);
    this.patch(this.shellMat, 'shell', 0.8);

    this.cutMat = new THREE.MeshStandardMaterial({
      name: 'elPerlo/cut',
      map: maps.map,
      normalMap: maps.normalMap,
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.08,
      alphaTest: 0.45,
      transparent: false,
      side: THREE.DoubleSide,
    });
    this.cutMat.normalScale.set(0.3, 0.3);
    this.patch(this.cutMat, 'cut', 0.5);

    this.benchMat = new THREE.MeshStandardMaterial({
      name: 'elPerlo/bench',
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.7,
    });
    this.benchMat.normalScale.set(0.85, 0.85);
    this.patch(this.benchMat, 'bench', 1);
  }

  /**
   * One shader patch for all three materials: the per-vertex `aGlow` channel
   * that lights windows and lamp pools after dusk, and the shared rain drive
   * so El Perlo goes dark and glossy with the rest of the city.
   *
   * The programme cache key is unique to this layer, so folding the wetness
   * hook in by hand here — rather than through `MaterialLibrary.register` —
   * keeps El Perlo's programme from ever being confused with the ground's.
   */
  private patch(mat: THREE.MeshStandardMaterial, key: string, wet: number): void {
    const night = this.nightUniform;
    const wetness = this.wetUniform;
    const amount = { value: wet };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = night;
      shader.uniforms.uWetness = wetness;
      shader.uniforms.uWetAmount = amount;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vEPGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvEPGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform float uNight;',
            'uniform float uWetness;',
            'uniform float uWetAmount;',
            'varying vec3 vEPGlow;',
            'const vec3 EP_WARM = vec3(1.0, 0.66, 0.33);',
            'const vec3 EP_COOL = vec3(0.78, 0.87, 1.0);',
          ].join('\n'),
        )
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n\tdiffuseColor.rgb *= mix( 1.0, 0.46, uWetness * uWetAmount );',
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, roughnessFactor * 0.14 + 0.03, uWetness * uWetAmount );',
        )
        .replace(
          '#include <lights_physical_fragment>',
          [
            '#include <lights_physical_fragment>',
            '#ifdef USE_CLEARCOAT',
            // horizontal zinc holds a film of water; a vertical board sheds it
            'vec3 epUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );',
            'float epUp = clamp( dot( nonPerturbedNormal, epUpV ) * 1.6 - 0.2, 0.0, 1.0 );',
            'float epWet = clamp( uWetness * uWetAmount, 0.0, 1.0 ) * mix( 0.25, 1.0, epUp );',
            'material.clearcoat = clamp( epWet * 0.85, 0.0, 1.0 );',
            'material.clearcoatRoughness = max( 0.0525, mix( 0.25, 0.08, epWet ) );',
            'clearcoatNormal = normalize( mix( normal, nonPerturbedNormal, epWet ) );',
            '#endif',
          ].join('\n\t'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'vec3 epLamp = mix(EP_WARM, EP_COOL, clamp(vEPGlow.y, 0.0, 1.0));',
            'float epAmp = vEPGlow.x * (0.7 + 0.55 * vEPGlow.z);',
            'gl_FragColor.rgb += epLamp * epAmp * uNight;',
            '#include <dithering_fragment>',
          ].join('\n\t'),
        );
    };
    const coated = mat instanceof THREE.MeshPhysicalMaterial && mat.clearcoat > 0;
    mat.customProgramCacheKey = () => `loco/elperlo/${key}${coated ? '/cc' : ''}`;
  }

  /* --------------------------------------------------------------- frame */

  update(cameraPos: THREE.Vector3, _dt: number, timeOfDay: number): void {
    const dusk = smoothstep((timeOfDay - 17.6) / 1.5);
    const dawn = 1 - smoothstep((timeOfDay - 5.6) / 1.4);
    this.nightUniform.value = clamp01(Math.max(dusk, dawn));

    const budget = QUALITY_BUDGET[this.quality];
    const drawLimit = budget.drawDistance;
    const lod = this.options.lodDistance ?? 210;
    const detail = budget.propDetailDistance * 2.4;

    for (let i = 0; i < this.nearMeshes.length; i++) {
      const near = this.nearMeshes[i];
      const far = this.farMeshes[i];
      const s = near.geometry.boundingSphere;
      const d = s ? cameraPos.distanceTo(s.center) - s.radius : 0;
      const inRange = d < drawLimit;
      near.visible = inRange && d < lod;
      if (far) far.visible = inRange && d >= lod;
    }
    for (const m of this.cutMeshes) {
      const s = m.geometry.boundingSphere;
      m.visible = s ? cameraPos.distanceTo(s.center) - s.radius < detail : true;
    }
    for (const m of this.benchMeshes) {
      const s = m.geometry.boundingSphere;
      m.visible = s ? cameraPos.distanceTo(s.center) - s.radius < drawLimit * 1.2 : true;
    }
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const aniso = QUALITY_BUDGET[tier].anisotropy;
    for (const mat of [this.shellMat, this.cutMat, this.benchMat]) {
      if (!mat) continue;
      for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) {
        if (t) {
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
    }
  }

  dispose(): void {
    if (this.physics) for (const b of this.bodies) this.physics.removeBody(b);
    this.bodies.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.shellMat?.dispose();
    this.cutMat?.dispose();
    this.benchMat?.dispose();
    if (this.ownTextures) this.textures?.dispose();
    this.group.clear();
    this.group.removeFromParent();
    this.nearMeshes.length = 0;
    this.farMeshes.length = 0;
    this.cutMeshes.length = 0;
    this.benchMeshes.length = 0;
  }

  private countDrawCalls(): number {
    return this.nearMeshes.length + this.cutMeshes.length + this.benchMeshes.length;
  }

  /** Numbers the QA harness wants. */
  stats(): Record<string, number> {
    return { ...this._stats };
  }
}

/* ========================================================================== *
 *  points of interest
 * ========================================================================== */

/**
 * The POIs El Perlo wants registered. Names are in the same
 * close-but-not-quite register as the rest of the map.
 */
export const EL_PERLO_POIS: ReadonlyArray<{
  id: string;
  name: string;
  kind: POI['kind'];
  x: number;
  y: number;
  z: number;
  radius: number;
  facing: number;
}> = [
  { id: 'perlo-malecon', name: 'Malec\u00f3n del Perlo', kind: 'venue', x: -196, y: 3.0, z: -337.4, radius: 15, facing: 0 },
  { id: 'perlo-colmado', name: 'Colmado La Ola', kind: 'cafe', x: -246, y: 9.8, z: -307.6, radius: 11, facing: Math.PI },
  { id: 'perlo-mirador', name: 'Mirador del Perlo', kind: 'lookout', x: -334, y: 19.5, z: -282.6, radius: 12, facing: 0 },
  { id: 'perlo-escalinata', name: 'Escalinata del Perlo', kind: 'plaza', x: -222, y: 13.2, z: -296.0, radius: 10, facing: 0 },
  { id: 'perlo-rompeolas', name: 'Rompeolas del Perlo', kind: 'dock', x: -128, y: 3.0, z: -337.6, radius: 13, facing: Math.PI * 0.5 },
];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cv = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _n1 = new THREE.Vector3();
