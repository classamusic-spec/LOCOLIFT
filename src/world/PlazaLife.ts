/**
 * Loco Lift — plaza life.
 *
 * The furniture that turns the district's open squares from a correct stone
 * floor into somewhere people spend an afternoon:
 *
 *  - a raised octagonal **fountain** with four carved figures, a two-bowl
 *    cascade and shader-animated water (no particles, no CPU cost);
 *  - a **glorieta** — the octagonal bandstand with an iron balustrade and a
 *    ribbed dome that every Spanish colonial plaza has at one end;
 *  - **mature shade trees** with real canopies over iron tree grates,
 *  - **stone bench arcs** ringing the fountain and cast-iron benches facing
 *    every walk,
 *  - twin-globe **cast-iron lamps**, a **flagpole group**, potted plants and
 *    kerbside planters, and a flock of **pigeons** on the paving;
 *  - **decorative paving** — a radiating rosette around the fountain and a
 *    banded border inside each island's stone kerb.
 *
 * ## Where things go
 *
 * The plazas here are *drivable* and the road graph runs straight through
 * them, so nothing is placed by eye. Each open area is rasterised at 1 m into
 * a free/blocked grid (inside the polygon, clear of every carriageway, clear
 * of every building footprint), the free cells are flood-filled into
 * **islands**, and each island is given a programme — fountain, bandstand,
 * grove — sized against its own inscribed radius. A prop can therefore never
 * end up in a traffic lane or inside a wall, whatever the seed does.
 *
 * ## Cost
 *
 * Twelve draw calls for every square in the city. Anything repeated more than
 * about thirty times is an `InstancedMesh`; everything rarer — the fountain,
 * the bandstand, the paving, the kerbs, the flagpoles, the tree grates, the
 * stone benches and the pigeons — merges into one mesh per material, because
 * below that count a whole draw call costs more than the duplicated vertices. Distance culling is in the vertex shader — see
 * {@link ./PropKit} — so nothing here rasterises past `propDetailDistance`,
 * with the fountain and the bandstand given a landmark multiplier so the
 * square still reads from the other end of a *calle larga*.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { QualityTier } from '../core/types';
import { clamp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle } from '../physics/PhysicsTypes';
import {
  buildBench,
  buildLampGlobe,
  buildLampPost,
  buildShadeTrunk,
  buildTreeGrate,
  puertoRicanFlag,
} from './ShackKit';
import {
  ClusterBuilder,
  DressKit,
  FOUNTAIN,
  PlacementGuard,
  appendGeometry,
  buildFlagpole,
  buildFountainStone,
  buildFountainWater,
  buildKiosk,
  buildDoorwayPot,
  buildPigeon,
  buildPlanterBox,
  buildPottedPalm,
  buildStoneBench,
  buildTreeCrown,
  dressInstanced,
  islandKerb,
  mergeInstances,
  nightRamp,
  pavePattern,
  pointInPolygon,
  triCount,
} from './PropKit';
import type { ClusterRange, DressPlacement, WetnessSource } from './PropKit';
import { destructibles } from './Destructibles';
import type { CityLayout, OpenArea, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------------ tuning */

/** Per-tier scatter density and detail. */
const TIER: Record<QualityTier, { density: number; pigeons: number; canopyLayers: number }> = {
  low: { density: 0.42, pigeons: 0, canopyLayers: 1 },
  medium: { density: 0.72, pigeons: 14, canopyLayers: 1 },
  high: { density: 1, pigeons: 26, canopyLayers: 2 },
  ultra: { density: 1.22, pigeons: 38, canopyLayers: 2 },
};

/**
 * The fountain is authored at documented proportions and then set up 18 % —
 * an arcade adjustment. At true scale a 7 m basin reads as street furniture
 * from a car at 45 m/s; the whole point of the thing is that it is the plaza's
 * landmark, so it is sized to hold the centre of the frame.
 */
const FOUNTAIN_SCALE = 1.18;

/** Landmarks stay visible far past the prop cut — they are the orientation. */
const LANDMARK_CULL = 3.4;
const FURNITURE_CULL = 1.15;

/** Raster cell for the free-space map, metres. */
const CELL = 1.0;

/** Minimum free cells for a flood-filled component to count as an island. */
const MIN_ISLAND_CELLS = 26;

/* ------------------------------------------------------------------- types */

interface Island {
  cells: number[];
  count: number;
  /** world position of the cell with the greatest clearance */
  coreX: number;
  coreZ: number;
  /** metres from the core to the nearest blocked cell */
  coreR: number;
}

interface FreeGrid {
  w: number;
  h: number;
  minX: number;
  minZ: number;
  free: Uint8Array;
  /** chamfer distance to the nearest blocked cell, in metres */
  dist: Float32Array;
  x(i: number): number;
  z(i: number): number;
}

export interface PlazaLifeOptions {
  /** multiplier on every scatter count */
  density?: number;
  /**
   * The world's `MaterialLibrary`, so the dressing picks up the shared rain
   * wetness drive. Optional — the layer builds fine without it.
   */
  materials?: WetnessSource | null;
  /** build static colliders for the fountain, bandstand and trees */
  colliders?: boolean;
}

/* ------------------------------------------------------------------- layer */

export class PlazaLife implements WorldLayer {
  readonly name = 'plazaLife';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: PlazaLifeOptions;
  private kit: DressKit | null = null;
  private physics: WorldOpts['physics'] | null = null;

  private geometries: THREE.BufferGeometry[] = [];
  private meshes: THREE.Object3D[] = [];
  private bodies: BodyHandle[] = [];
  private _stats = { instances: 0, triangles: 0, trees: 0, benches: 0, islands: 0, fountains: 0 };

  /* placement accumulators, drained in `finish` */
  private trees: DressPlacement[] = [];
  private canopies: DressPlacement[] = [];
  private blooms: DressPlacement[] = [];
  private grates: DressPlacement[] = [];
  private benches: DressPlacement[] = [];
  private stoneBenches: DressPlacement[] = [];
  private lamps: DressPlacement[] = [];
  private pots: DressPlacement[] = [];
  private palms: DressPlacement[] = [];
  private planters: DressPlacement[] = [];
  private pigeons: DressPlacement[] = [];
  private poles: DressPlacement[] = [];

  private solid = new ClusterBuilder();
  private cloth = new ClusterBuilder(true);
  private glow = new ClusterBuilder();
  private paving = new ClusterBuilder();
  private water = new ClusterBuilder(true);

  constructor(quality: QualityTier, options: PlazaLifeOptions = {}) {
    this.quality = quality;
    this.options = { density: 1, colliders: true, ...options };
    this.group.name = 'world/plazaLife';
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.physics = opts.physics;
    const kit = DressKit.acquire(opts.quality);
    kit.useWetness(this.options.materials);
    this.kit = kit;
    const guard = new PlacementGuard(layout);
    const rng = opts.rng.fork(0x91a2_a17d);

    const areas = layout.areas.filter((a) => isSquare(a));
    // biggest first, so the main plaza always gets the fountain
    areas.sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon));

    let fountainPlaced = false;
    let kioskPlaced = false;
    for (const area of areas) {
      const grid = this.rasterise(area, guard, layout);
      const islands = this.findIslands(grid);
      if (islands.length === 0) continue;
      this._stats.islands += islands.length;
      islands.sort((a, b) => b.coreR - a.coreR || b.count - a.count);

      for (let i = 0; i < islands.length; i++) {
        const island = islands[i];
        const wantFountain =
          !fountainPlaced && area.zone === 'plazaMayor' && island.coreR >= 5.4;
        const wantKiosk =
          !kioskPlaced && !wantFountain && area.zone !== 'marketRow' && island.coreR >= 4.6 &&
          (fountainPlaced || i > 0);

        if (wantFountain) {
          this.placeFountain(island, grid, layout, rng);
          fountainPlaced = true;
        } else if (wantKiosk) {
          this.placeKiosk(island, grid, layout, rng);
          kioskPlaced = true;
        }
        this.dressIsland(area, island, grid, layout, rng, wantFountain, wantKiosk);
      }

      this.dressPerimeter(area, grid, layout, rng);
    }

    this.finish();
  }

  /* ----------------------------------------------------------- free space */

  private rasterise(area: OpenArea, guard: PlacementGuard, layout: CityLayout): FreeGrid {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of area.polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y;
      if (p.y > maxZ) maxZ = p.y;
    }
    const w = Math.max(1, Math.ceil((maxX - minX) / CELL));
    const h = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
    const free = new Uint8Array(w * h);
    const dist = new Float32Array(w * h);

    const grid: FreeGrid = {
      w,
      h,
      minX,
      minZ,
      free,
      dist,
      x: (i: number) => minX + ((i % w) + 0.5) * CELL,
      z: (i: number) => minZ + (Math.floor(i / w) + 0.5) * CELL,
    };

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = minX + (i + 0.5) * CELL;
        const z = minZ + (j + 0.5) * CELL;
        const idx = j * w + i;
        if (!pointInPolygon(x, z, area.polygon)) continue;
        if (guard.inFootprint(x, z, 0.8)) continue;
        if (guard.roadClearance(x, z) < 1.6) continue;
        // keep clear of the area's own boundary so nothing overhangs a kerb
        if (edgeDistance(x, z, area.polygon) < 1.1) continue;
        free[idx] = 1;
      }
    }
    void layout;

    // two-pass chamfer distance transform, in metres
    const BIG = 1e6;
    for (let i = 0; i < dist.length; i++) dist[i] = free[i] ? BIG : 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!free[k]) continue;
        let d = dist[k];
        if (i > 0) d = Math.min(d, dist[k - 1] + 1);
        if (j > 0) d = Math.min(d, dist[k - w] + 1);
        if (i > 0 && j > 0) d = Math.min(d, dist[k - w - 1] + 1.41421);
        if (i < w - 1 && j > 0) d = Math.min(d, dist[k - w + 1] + 1.41421);
        dist[k] = d;
      }
    }
    for (let j = h - 1; j >= 0; j--) {
      for (let i = w - 1; i >= 0; i--) {
        const k = j * w + i;
        if (!free[k]) continue;
        let d = dist[k];
        if (i < w - 1) d = Math.min(d, dist[k + 1] + 1);
        if (j < h - 1) d = Math.min(d, dist[k + w] + 1);
        if (i < w - 1 && j < h - 1) d = Math.min(d, dist[k + w + 1] + 1.41421);
        if (i > 0 && j < h - 1) d = Math.min(d, dist[k + w - 1] + 1.41421);
        dist[k] = Math.min(d, BIG) * 1;
      }
    }
    for (let i = 0; i < dist.length; i++) dist[i] = Math.min(dist[i], 60) * CELL;
    return grid;
  }

  private findIslands(g: FreeGrid): Island[] {
    const seen = new Uint8Array(g.w * g.h);
    const out: Island[] = [];
    const stack: number[] = [];
    for (let start = 0; start < g.free.length; start++) {
      if (!g.free[start] || seen[start]) continue;
      stack.length = 0;
      stack.push(start);
      seen[start] = 1;
      const cells: number[] = [];
      while (stack.length > 0) {
        const k = stack.pop() as number;
        cells.push(k);
        const i = k % g.w;
        const j = Math.floor(k / g.w);
        if (i > 0 && g.free[k - 1] && !seen[k - 1]) {
          seen[k - 1] = 1;
          stack.push(k - 1);
        }
        if (i < g.w - 1 && g.free[k + 1] && !seen[k + 1]) {
          seen[k + 1] = 1;
          stack.push(k + 1);
        }
        if (j > 0 && g.free[k - g.w] && !seen[k - g.w]) {
          seen[k - g.w] = 1;
          stack.push(k - g.w);
        }
        if (j < g.h - 1 && g.free[k + g.w] && !seen[k + g.w]) {
          seen[k + g.w] = 1;
          stack.push(k + g.w);
        }
      }
      if (cells.length < MIN_ISLAND_CELLS) continue;
      let core = cells[0];
      for (const c of cells) if (g.dist[c] > g.dist[core]) core = c;
      out.push({
        cells,
        count: cells.length,
        coreX: g.x(core),
        coreZ: g.z(core),
        coreR: g.dist[core],
      });
    }
    return out;
  }

  /** Free and at least `r` metres from anything blocked. */
  private clearAt(g: FreeGrid, x: number, z: number, r: number): boolean {
    const i = Math.floor((x - g.minX) / CELL);
    const j = Math.floor((z - g.minZ) / CELL);
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) return false;
    const k = j * g.w + i;
    return g.free[k] === 1 && g.dist[k] >= r;
  }

  /* -------------------------------------------------------- the fountain */

  private placeFountain(island: Island, g: FreeGrid, layout: CityLayout, rng: RNG): void {
    const x = island.coreX;
    const z = island.coreZ;
    const y = layout.groundHeight(x, z) + 0.014;

    // paving first, so the rosette is centred on the basin
    pavePattern(
      this.paving,
      insetPolygonAround(island, g),
      { x, z },
      (px, pz) => layout.groundHeight(px, pz),
      rng,
      LANDMARK_CULL,
    );

    const stone = buildFountainStone(rng.fork(0x1f0c));
    const water = buildFountainWater();
    this.solid.open(x, y, z, LANDMARK_CULL);
    appendGeometry(this.solid, stone, x, y, z, 0, FOUNTAIN_SCALE, FOUNTAIN_SCALE);
    this.solid.close();
    this.water.open(x, y, z, LANDMARK_CULL);
    appendGeometry(this.water, water, x, y, z, 0, FOUNTAIN_SCALE, FOUNTAIN_SCALE);
    this.water.close();
    stone.dispose();
    water.dispose();
    this._stats.fountains++;

    // ring of stone bench arcs, with two gaps to walk through
    const R = FOUNTAIN.stepR * FOUNTAIN_SCALE + 1.7;
    for (let i = 0; i < 8; i++) {
      if (i === 2 || i === 6) continue;
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const bx = x + Math.sin(a) * R;
      const bz = z + Math.cos(a) * R;
      if (!this.clearAt(g, bx, bz, 1.2)) continue;
      this.stoneBenches.push({
        x,
        y: layout.groundHeight(bx, bz) + 0.014,
        z,
        yaw: a,
        cull: LANDMARK_CULL,
      });
    }

    // four twin-globe lamps on the diagonals
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const lx = x + Math.cos(a) * (R + 3.1);
      const lz = z + Math.sin(a) * (R + 3.1);
      if (!this.clearAt(g, lx, lz, 1.1)) continue;
      this.lamps.push({
        x: lx,
        y: layout.groundHeight(lx, lz) + 0.014,
        z: lz,
        yaw: rng.range(0, Math.PI * 2),
        cull: LANDMARK_CULL,
      });
    }

    // the flagpole group — three poles, one flying the standard flag (§7.4)
    const dirA = rng.range(0, Math.PI * 2);
    for (let i = -1; i <= 1; i++) {
      const px = x + Math.cos(dirA) * (R + 6.2) + Math.cos(dirA + Math.PI / 2) * i * 2.6;
      const pz = z + Math.sin(dirA) * (R + 6.2) + Math.sin(dirA + Math.PI / 2) * i * 2.6;
      if (!this.clearAt(g, px, pz, 1.0)) continue;
      const py = layout.groundHeight(px, pz) + 0.014;
      this.poles.push({ x: px, y: py, z: pz, yaw: 0, cull: LANDMARK_CULL });
      if (i === 0) {
        this.cloth.open(px, py, pz, LANDMARK_CULL);
        puertoRicanFlag(this.cloth.g, px + 0.08, py + 7.9, pz, 1.55, dirA + Math.PI / 2, rng.next());
        this.cloth.close();
      }
    }

    // pigeons — Parque de las Palomas (§7.2)
    const want = Math.round(TIER[this.quality].pigeons * (this.options.density ?? 1));
    for (let i = 0; i < want; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = FOUNTAIN.stepR + rng.range(0.6, 7.5);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (!this.clearAt(g, px, pz, 0.6)) continue;
      this.pigeons.push({
        x: px,
        y: layout.groundHeight(px, pz) + 0.016,
        z: pz,
        yaw: rng.range(0, Math.PI * 2),
        scale: rng.range(0.88, 1.12),
        cull: 0.55,
      });
    }

    if (this.options.colliders && this.physics) {
      this.bodies.push(
        this.physics.createBody({
          kind: 'static',
          shape: { type: 'cylinder', radius: FOUNTAIN.basinR * FOUNTAIN_SCALE + 0.18, halfHeight: 0.85 },
          position: new THREE.Vector3(x, y + 0.85, z),
          friction: 0.9,
          restitution: 0.05,
          group: GROUP.WORLD,
          mask: GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS,
          userData: { kind: 'world', surface: 'fountain' },
        }),
      );
    }
  }

  /* --------------------------------------------------------- the glorieta */

  private placeKiosk(island: Island, g: FreeGrid, layout: CityLayout, rng: RNG): void {
    const x = island.coreX;
    const z = island.coreZ;
    const y = layout.groundHeight(x, z) + 0.014;
    const parts = buildKiosk(rng.fork(0x4b10));
    const yaw = rng.range(0, Math.PI * 2);
    this.solid.open(x, y, z, LANDMARK_CULL);
    appendGeometry(this.solid, parts.solid, x, y, z, yaw);
    this.solid.close();
    this.glow.open(x, y, z, LANDMARK_CULL);
    appendGeometry(this.glow, parts.glow, x, y, z, yaw);
    this.glow.close();
    parts.solid.dispose();
    parts.glow.dispose();

    // benches facing the bandstand
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const bx = x + Math.cos(a) * 6.6;
      const bz = z + Math.sin(a) * 6.6;
      if (!this.clearAt(g, bx, bz, 1.1)) continue;
      this.benches.push({
        x: bx,
        y: layout.groundHeight(bx, bz) + 0.014,
        z: bz,
        yaw: Math.atan2(x - bx, z - bz),
        cull: FURNITURE_CULL,
      });
    }

    if (this.options.colliders && this.physics) {
      this.bodies.push(
        this.physics.createBody({
          kind: 'static',
          shape: { type: 'cylinder', radius: 4.15, halfHeight: 1.9 },
          position: new THREE.Vector3(x, y + 1.9, z),
          friction: 0.9,
          restitution: 0.05,
          group: GROUP.WORLD,
          mask: GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS,
          userData: { kind: 'world', surface: 'kiosk' },
        }),
      );
    }
  }

  /* -------------------------------------------------------------- islands */

  private dressIsland(
    area: OpenArea,
    island: Island,
    g: FreeGrid,
    layout: CityLayout,
    rng: RNG,
    hasFountain: boolean,
    hasKiosk: boolean,
  ): void {
    // the market floor is a working square: it carries a fringe of shade but
    // the middle has to stay clear for the stalls StreetDressing lays out
    const market = area.zone === 'marketRow';
    const density = TIER[this.quality].density * (this.options.density ?? 1) * (market ? 0.45 : 1);
    const taken: Array<{ x: number; z: number; r: number }> = [];
    if (market) taken.push({ x: area.center.x, z: area.center.z, r: 22 });
    if (hasFountain) taken.push({ x: island.coreX, z: island.coreZ, r: FOUNTAIN.stepR * FOUNTAIN_SCALE + 7.6 });
    if (hasKiosk) taken.push({ x: island.coreX, z: island.coreZ, r: 9.2 });

    const fits = (x: number, z: number, r: number): boolean => {
      for (const t of taken) {
        if (Math.hypot(t.x - x, t.z - z) < t.r + r) return false;
      }
      return true;
    };

    const cells = island.cells;
    const pick = (): number => cells[rng.int(0, cells.length - 1)];

    // — shade trees, the single most valuable thing in a tropical square —
    const treeBudget = Math.round(clamp((island.count / 26) * density, 0, 14));
    const layers = TIER[this.quality].canopyLayers;
    for (let n = 0, tries = 0; n < treeBudget && tries < treeBudget * 26; tries++) {
      const k = pick();
      const x = g.x(k) + rng.range(-0.35, 0.35);
      const z = g.z(k) + rng.range(-0.35, 0.35);
      if (!this.clearAt(g, x, z, 2.6)) continue;
      if (!fits(x, z, 4.4)) continue;
      const y = layout.groundHeight(x, z) + 0.014;
      const s = rng.range(0.88, 1.28);
      const yaw = rng.range(0, Math.PI * 2);
      this.trees.push({ x, y, z, yaw, scale: s, cull: LANDMARK_CULL });
      this.grates.push({ x, y: y + 0.002, z, yaw, scale: s * 1.05, cull: FURNITURE_CULL });
      // roughly one tree in four is a flamboyán in flower (§7.4)
      const list = rng.bool(0.26) ? this.blooms : this.canopies;
      for (let l = 0; l < layers; l++) {
        list.push({
          x,
          y: y + l * 0.48,
          z,
          yaw: yaw + l * 1.9,
          scale: s * (l === 0 ? 1 : 0.78),
          cull: LANDMARK_CULL,
        });
      }
      taken.push({ x, z, r: 4.6 });
      n++;
      this._stats.trees++;
    }

    // — benches under the trees, facing the island core —
    const benchBudget = Math.round(clamp((island.count / 34) * density, 0, 10));
    for (let n = 0, tries = 0; n < benchBudget && tries < benchBudget * 24; tries++) {
      const k = pick();
      const x = g.x(k);
      const z = g.z(k);
      if (!this.clearAt(g, x, z, 1.5)) continue;
      if (!fits(x, z, 2.1)) continue;
      const dx = island.coreX - x;
      const dz = island.coreZ - z;
      this.benches.push({
        x,
        y: layout.groundHeight(x, z) + 0.014,
        z,
        yaw: Math.atan2(dx, dz) + rng.range(-0.18, 0.18),
        cull: FURNITURE_CULL,
      });
      taken.push({ x, z, r: 2.0 });
      n++;
      this._stats.benches++;
    }

    // — planters, pots and a few potted palms around the island edge —
    const potBudget = Math.round(clamp((island.count / 26) * density, 0, 16));
    for (let n = 0, tries = 0; n < potBudget && tries < potBudget * 20; tries++) {
      const k = pick();
      const x = g.x(k) + rng.range(-0.4, 0.4);
      const z = g.z(k) + rng.range(-0.4, 0.4);
      if (!this.clearAt(g, x, z, 1.15)) continue;
      if (!fits(x, z, 1.3)) continue;
      const y = layout.groundHeight(x, z) + 0.014;
      const yaw = rng.range(0, Math.PI * 2);
      const roll = rng.next();
      if (roll < 0.34) this.planters.push({ x, y, z, yaw, cull: FURNITURE_CULL });
      else if (roll < 0.62) this.palms.push({ x, y, z, yaw, scale: rng.range(0.9, 1.3), cull: FURNITURE_CULL });
      else this.pots.push({ x, y, z, yaw, scale: rng.range(0.9, 1.25), cull: FURNITURE_CULL });
      taken.push({ x, z, r: 1.25 });
      n++;
    }

    // — the island's stone kerb and its banded border —
    if (!hasFountain && island.count > 40) {
      const poly = insetPolygonAround(island, g);
      if (poly.length >= 3) {
        islandKerb(this.paving, poly, (px, pz) => layout.groundHeight(px, pz), LANDMARK_CULL);
      }
    }
  }

  /* ------------------------------------------------------------ perimeter */

  private dressPerimeter(area: OpenArea, g: FreeGrid, layout: CityLayout, rng: RNG): void {
    const density = TIER[this.quality].density * (this.options.density ?? 1);
    const poly = area.polygon;
    const cx = area.center.x;
    const cz = area.center.z;
    let placed = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const step = 17 / Math.max(0.35, density);
      const n = Math.max(1, Math.floor(len / step));
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const ex = a.x + (b.x - a.x) * t;
        const ez = a.y + (b.y - a.y) * t;
        // walk inward until the cell is free
        const dx = cx - ex;
        const dz = cz - ez;
        const l = Math.hypot(dx, dz) || 1;
        let px = 0;
        let pz = 0;
        let found = false;
        for (let d = 1.6; d < 9; d += 0.8) {
          px = ex + (dx / l) * d;
          pz = ez + (dz / l) * d;
          if (this.clearAt(g, px, pz, 1.2)) {
            found = true;
            break;
          }
        }
        if (!found) continue;
        const y = layout.groundHeight(px, pz) + 0.014;
        this.lamps.push({ x: px, y, z: pz, yaw: rng.range(0, Math.PI * 2), cull: FURNITURE_CULL });
        placed++;
        // a bench beside every other lamp, facing across the square
        if (placed % 2 === 0) {
          const bx = px + (-dz / l) * 2.6;
          const bz = pz + (dx / l) * 2.6;
          if (this.clearAt(g, bx, bz, 1.3)) {
            this.benches.push({
              x: bx,
              y: layout.groundHeight(bx, bz) + 0.014,
              z: bz,
              yaw: Math.atan2(cx - bx, cz - bz),
              cull: FURNITURE_CULL,
            });
            this._stats.benches++;
          }
        }
      }
    }
  }

  /* --------------------------------------------------------------- finish */

  private finish(): void {
    const kit = this.kit;
    if (!kit) return;
    const rng = new RNG(0x7c2a_9411);

    this.addMerged(this.paving.build('aDress'), kit.paving, 'plaza/paving', false);
    this.addMerged(this.cloth.build('aWave'), kit.cloth, 'plaza/cloth');
    this.addMerged(this.glow.build('aDress'), kit.glow, 'plaza/glow');
    this.addMerged(this.water.build('aWater'), kit.water, 'plaza/water', false);

    // Low-count props merge into the shared solid mesh rather than paying a
    // draw call each; every merged prop still carries its own cluster anchor,
    // so the vertex cull treats it exactly like an instance.
    mergeInstances(this.solid, buildStoneBench(FOUNTAIN.stepR * FOUNTAIN_SCALE + 1.7, 0.6), this.stoneBenches, true);
    mergeInstances(this.solid, buildFlagpole(8.6), this.poles, true);
    mergeInstances(this.solid, buildTreeGrate(), this.grates, true);
    const planterRanges: ClusterRange[] = [];
    mergeInstances(this.solid, buildPlanterBox(rng.fork(0x13)), this.planters, true, planterRanges);
    mergeInstances(this.solid, buildPigeon(), this.pigeons, true);

    const solidGeo = this.solid.build('aDress');
    this.addMerged(solidGeo, kit.solid, 'plaza/solid');

    this.addInstanced(buildShadeTrunk(rng.fork(0x11)), kit.solid, this.trees, 'plaza/treeTrunk');
    this.addInstanced(
      buildTreeCrown(rng.fork(0x12), 4.4, false),
      kit.foliage,
      this.canopies,
      'plaza/treeCanopy',
    );
    this.addInstanced(
      buildTreeCrown(rng.fork(0x16), 4.1, true),
      kit.foliage,
      this.blooms,
      'plaza/treeBloom',
    );
    const benchMesh = this.addInstanced(buildBench(), kit.solid, this.benches, 'plaza/bench');
    this.addInstanced(buildLampPost(true), kit.solid, this.lamps, 'plaza/lampPost');
    this.addInstanced(buildLampGlobe(true), kit.glow, this.lamps, 'plaza/lampGlobe');
    const potMesh = this.addInstanced(buildDoorwayPot(rng.fork(0x14), true), kit.foliage, this.pots, 'plaza/pot');
    const palmMesh = this.addInstanced(buildPottedPalm(rng.fork(0x15)), kit.foliage, this.palms, 'plaza/palm');

    /* --- what the square is willing to lose when a taxi comes through --- */
    destructibles.registerInstanced(this, benchMesh, 'bench', this.benches);
    destructibles.registerInstanced(this, potMesh, 'bigPot', this.pots);
    destructibles.registerInstanced(this, palmMesh, 'palm', this.palms);
    // The kerbside planters are merged into the shared solid mesh, so they
    // collapse in place rather than tumbling — a stone box does not bounce.
    if (solidGeo) {
      for (let i = 0; i < this.planters.length && i < planterRanges.length; i++) {
        const p = this.planters[i];
        destructibles.registerCluster(
          this,
          'stonePlanter',
          { x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale ?? 1 },
          [{ geo: solidGeo, range: planterRanges[i] }],
        );
      }
    }

    // the accumulators are only needed while building
    this.trees = [];
    this.canopies = [];
    this.blooms = [];
    this.grates = [];
    this.benches = [];
    this.stoneBenches = [];
    this.lamps = [];
    this.pots = [];
    this.palms = [];
    this.planters = [];
    this.pigeons = [];
    this.poles = [];
  }

  private addMerged(
    geo: THREE.BufferGeometry | null,
    mat: THREE.Material,
    name: string,
    shadow = true,
  ): void {
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geo);
    this._stats.triangles += triCount(geo);
  }

  private addInstanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    list: DressPlacement[],
    name: string,
  ): THREE.InstancedMesh | null {
    const mesh = dressInstanced(geo, mat, list, name);
    if (!mesh) {
      geo.dispose();
      return null;
    }
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(mesh.geometry);
    this._stats.instances += mesh.count;
    this._stats.triangles += triCount(mesh.geometry) * mesh.count;
    return mesh;
  }

  /* -------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number, timeOfDay: number): void {
    this.kit?.update(
      dt,
      nightRamp(timeOfDay),
      cameraPos,
      QUALITY_BUDGET[this.quality].propDetailDistance,
      this,
    );
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const d = QUALITY_BUDGET[tier].propDetailDistance;
    for (const m of this.meshes) {
      if (m.name === 'plaza/pigeon') m.visible = d >= 100;
      else if (m.name === 'plaza/pot' || m.name === 'plaza/palm') m.visible = d >= 90;
    }
  }

  stats(): Record<string, number> {
    return {
      plazaDrawCalls: this.group.children.length,
      plazaInstances: this._stats.instances,
      plazaTriangles: Math.round(this._stats.triangles),
      plazaTrees: this._stats.trees,
      plazaBenches: this._stats.benches,
      plazaIslands: this._stats.islands,
      plazaFountains: this._stats.fountains,
      plazaBodies: this.bodies.length,
    };
  }

  dispose(): void {
    destructibles.unregisterOwner(this);
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.meshes) {
      if (m instanceof THREE.InstancedMesh) m.dispose();
    }
    this.meshes.length = 0;
    if (this.physics) for (const b of this.bodies) this.physics.removeBody(b);
    this.bodies.length = 0;
    this.kit?.release(this);
    this.kit = null;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ------------------------------------------------------------------ utils */

/** Squares this layer dresses: the plazas and the market floor. */
function isSquare(a: OpenArea): boolean {
  if (a.zone === 'plazaMayor') return true;
  if (a.zone === 'marketRow') return true;
  if (a.zone === 'oldTown' && (a.surface === 'cobble' || a.surface === 'flagstone')) return true;
  return false;
}

function polygonArea(poly: readonly THREE.Vector2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(s) * 0.5;
}

/** Metres from (x,z) to the nearest polygon edge. */
function edgeDistance(x: number, z: number, poly: readonly THREE.Vector2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x;
    const az = poly[j].y;
    const bx = poly[i].x;
    const bz = poly[i].y;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

/**
 * A convex-ish outline of an island, for its kerb and its paving border:
 * the extreme free cell in each of 16 directions from the island core.
 */
function insetPolygonAround(island: Island, g: FreeGrid): THREE.Vector2[] {
  const DIRS = 16;
  const out: THREE.Vector2[] = [];
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    let r = 0;
    for (let step = 0.6; step < 70; step += 0.6) {
      const x = island.coreX + cx * step;
      const z = island.coreZ + cz * step;
      const i = Math.floor((x - g.minX) / CELL);
      const j = Math.floor((z - g.minZ) / CELL);
      if (i < 0 || j < 0 || i >= g.w || j >= g.h) break;
      if (!g.free[j * g.w + i]) break;
      r = step;
    }
    if (r < 1.2) return [];
    out.push(new THREE.Vector2(island.coreX + cx * r, island.coreZ + cz * r));
  }
  return out;
}
