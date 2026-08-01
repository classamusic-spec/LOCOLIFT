/**
 * Loco Lift — street dressing.
 *
 * What the reference photographs of an Old San Juan side street actually
 * contain, once the architecture is right: **plants everywhere on the pavement
 * and hanging off the ironwork**, and **bunting and festoon lights strung
 * across the street from balcony to balcony**. Those two do most of the work,
 * so those two get the budget:
 *
 *  - clusters of terracotta pots, potted fan palms, flowering shrubs and
 *    stone planter boxes against the wall beside every other doorway;
 *  - hanging planters on iron brackets under the first-floor balconies,
 *    trailing bougainvillea;
 *  - **banderines** and warm festoon strings hung on catenaries across the
 *    narrow streets, anchored façade to façade;
 *  - café tables, monobloc chairs and red-and-white umbrellas on the kerb
 *    wherever the pavement is wide enough to take them;
 *  - painted A-boards in correctly accented Spanish (§7.1) outside the shops;
 *  - canvas market stalls and stacked produce crates on the *mercado* floor.
 *
 * ## Placement rules
 *
 * Every prop is anchored to a **lot front edge** — the same line the façade
 * generator builds its elevation on — and pushed outward along that lot's
 * facing normal by less than the width of the pavement. Before anything is
 * kept it is run through {@link PropKit.PlacementGuard}: outside every building
 * footprint, and clear of every carriageway by a real margin measured off the
 * road graph's own width. Bunting spans additionally have to land on a *second*
 * façade whose normal opposes the first, so a string can never terminate in
 * mid-air.
 *
 * ## Cost
 *
 * Fourteen draw calls for the whole city. Anything repeated hundreds of times
 * is instanced; the wires, bunting, market stalls and painted boards merge into
 * one mesh per material. The
 * vertex-shader distance cull in {@link ./PropKit} means nothing here
 * rasterises past `propDetailDistance`, so the dressing is free at range.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { POI, QualityTier } from '../core/types';
import { clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import {
  buildBloomBush,
  buildPlasticChair,
  buildPlasticTable,
  buildUmbrella,
} from './ShackKit';
import { destructibles } from './Destructibles';
import {
  ClusterBuilder,
  DRESS,
  DressKit,
  PlacementGuard,
  appendGeometry,
  buildAboardFaces,
  buildAboardFrame,
  buildBulb,
  buildDoorwayPot,
  buildHangingPlanter,
  buildPlanterBox,
  buildPottedPalm,
  buildProduceCrate,
  buildStall,
  buntingFlags,
  catenaryPoints,
  dressInstanced,
  distToSegment,
  frontEdgeOf,
  nightRamp,
  pointInPolygon,
  quadUV,
  signRect,
  triCount,
  wireRibbon,
} from './PropKit';
import type { ClusterRange, DressPlacement, DressSign, FrontEdge, WetnessSource } from './PropKit';
import { LodField, bucketByCell, bucketFootprint } from './LodGrid';
import type { PropSpecId } from './Destructibles';
import type { CityLayout, DistrictZone, Lot, OpenArea, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------------ tuning */

const TIER: Record<
  QualityTier,
  { density: number; spans: number; hanging: number; bulbs: boolean }
> = {
  low: { density: 0.3, spans: 0.22, hanging: 0.2, bulbs: false },
  medium: { density: 0.66, spans: 0.62, hanging: 0.6, bulbs: true },
  high: { density: 1, spans: 1, hanging: 1, bulbs: true },
  ultra: { density: 1.08, spans: 1.12, hanging: 1.1, bulbs: true },
};

/** How often a lot in each district gets planting against its wall. */
const PLANT_CHANCE: Record<DistrictZone, number> = {
  oldTown: 0.78,
  artQuarter: 0.84,
  plazaMayor: 0.72,
  marketRow: 0.6,
  waterfront: 0.3,
  hillside: 0.46,
  fortress: 0.12,
};

/** How often a lot gets a hanging planter under its balcony. */
const HANG_CHANCE: Record<DistrictZone, number> = {
  oldTown: 0.4,
  artQuarter: 0.46,
  plazaMayor: 0.36,
  marketRow: 0.24,
  waterfront: 0.1,
  hillside: 0.22,
  fortress: 0.02,
};

/** Zones that read as commercial, so they carry boards and pavement café. */
const COMMERCIAL: DistrictZone[] = ['oldTown', 'artQuarter', 'marketRow', 'plazaMayor'];

/** §7.1 — the boards a street actually carries. */
const BOARD_SIGNS: DressSign[] = [
  'abierto', 'menu', 'cafe', 'panaderia', 'artesanias', 'flores',
  'heladeria', 'jugos', 'colmado', 'pan', 'floristeria', 'piraguas',
];

const STALL_SIGNS: DressSign[] = ['frutas', 'artesanias', 'flores', 'piraguas', 'jugos', 'alcapurrias'];

/** §3.2 — the bunting palette. Festival colour, never a national-flag run. */
const BUNTING_PALETTE = [0xf2c230, 0xd52b1e, 0x2e5e86, 0xf7f4ec, 0x4fbfb1, 0xe8563f, 0xb43fa8];

/** Height a string is tied off at, above the pavement. */
const SPAN_Y = 5.95;
const FESTOON_Y = 5.35;

/**
 * Cell size for the instanced dressing, metres.
 *
 * Sized against `propDetailDistance` (70 m on `low`, 190 m on `high`) rather
 * than against the district: the live set is a disc a couple of cells across,
 * so a cell much finer than the cull radius buys draw calls and no triangles.
 * 130 m keeps the working set to roughly a 3 × 3 neighbourhood at `high`.
 */
const DRESS_CELL = 130;

/** Slack on a cell's footprint: prop reach plus the shader's fade band. */
const DRESS_PAD = 6;

export interface StreetDressingOptions {
  density?: number;
  /** the world's `MaterialLibrary`, for the shared rain wetness drive */
  materials?: WetnessSource | null;
  /** dress the market floor with stalls */
  market?: boolean;
}

/* -------------------------------------------------------------------- data */

/** The per-cell meshes one prop type expanded into, with their placements. */
type DressBuckets = Array<{ mesh: THREE.InstancedMesh; items: DressPlacement[] }>;

interface FrontRef {
  lot: Lot;
  edge: FrontEdge;
  /** metres of clear pavement between the façade line and the kerb */
  apron: number;
  /** perpendicular distance from the façade line to the road centreline */
  half: number;
  /** pavement height at the front edge midpoint */
  y: number;
  roadKind: string;
}

/* ------------------------------------------------------------------- layer */

export class StreetDressing implements WorldLayer {
  readonly name = 'streetDressing';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: StreetDressingOptions;
  private kit: DressKit | null = null;

  private geometries: THREE.BufferGeometry[] = [];
  private meshes: THREE.Object3D[] = [];
  /** the per-cell instanced meshes, culled together every frame */
  private lod = new LodField();
  private _stats = {
    instances: 0,
    triangles: 0,
    spans: 0,
    pots: 0,
    hanging: 0,
    cafes: 0,
    stalls: 0,
    boards: 0,
  };

  private pots: DressPlacement[] = [];
  private palms: DressPlacement[] = [];
  private blooms: DressPlacement[] = [];
  private planters: DressPlacement[] = [];
  private hanging: DressPlacement[] = [];
  private tables: DressPlacement[] = [];
  private chairs: DressPlacement[] = [];
  private umbrellas: DressPlacement[] = [];
  private boards: DressPlacement[] = [];
  private stalls: DressPlacement[] = [];
  private crates: DressPlacement[] = [];
  private bulbs: DressPlacement[] = [];
  /** one per stall, in `stalls` order: the span its painted banner occupies */
  private stallBanners: ClusterRange[] = [];

  private wires = new ClusterBuilder();
  private cloth = new ClusterBuilder(true);
  private signs = new ClusterBuilder();

  constructor(quality: QualityTier, options: StreetDressingOptions = {}) {
    this.quality = quality;
    this.options = { density: 1, market: true, ...options };
    this.group.name = 'world/streetDressing';
  }

  /* ---------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    const kit = DressKit.acquire(opts.quality);
    kit.useWetness(this.options.materials);
    this.kit = kit;
    const guard = new PlacementGuard(layout);
    const rng = opts.rng.fork(0x2d71_c05a);
    const tier = TIER[this.quality];
    const density = tier.density * (this.options.density ?? 1);

    const fronts = this.collectFronts(layout, guard);
    const heat = poiHeat(layout.pois);

    this.dressDoorways(fronts, guard, rng, density, heat);
    this.hangStrings(fronts, layout, rng, tier.spans * (this.options.density ?? 1), tier.bulbs);
    if (this.options.market) this.dressMarket(layout, guard, rng, density);

    this.finish(rng);
  }

  /* --------------------------------------------------------------- fronts */

  private collectFronts(layout: CityLayout, guard: PlacementGuard): FrontRef[] {
    const out: FrontRef[] = [];
    const probe = new THREE.Vector3();
    for (const lot of layout.lots) {
      const edge = frontEdgeOf(lot);
      probe.set(edge.mx + edge.nx * 0.9, 0, edge.mz + edge.nz * 0.9);
      const s = layout.roads.nearest(probe, 22);
      if (!s) continue;
      const road = layout.roads.edges[s.edgeId];
      if (road.kind === 'rooftop' || road.kind === 'ramp') continue;
      // perpendicular distance from the façade line itself to the centreline
      probe.set(edge.mx, 0, edge.mz);
      const s2 = layout.roads.nearest(probe, 24);
      if (!s2) continue;
      const half = s2.dist;
      const apron = half - layout.roads.edges[s2.edgeId].width * 0.5;
      if (apron < 0.62) continue;
      out.push({
        lot,
        edge,
        apron,
        half,
        y: guard.surfaceY(edge.mx + edge.nx * 0.7, edge.mz + edge.nz * 0.7, false),
        roadKind: layout.roads.edges[s2.edgeId].kind,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------- doorways */

  private dressDoorways(
    fronts: readonly FrontRef[],
    guard: PlacementGuard,
    rng: RNG,
    density: number,
    heat: (x: number, z: number) => number,
  ): void {
    const hangScale = TIER[this.quality].hanging * (this.options.density ?? 1);

    for (const f of fronts) {
      const e = f.edge;
      const zone = f.lot.zone;
      const warmth = heat(e.mx, e.mz);
      const plantP = (PLANT_CHANCE[zone] ?? 0.2) * density * (0.85 + warmth * 0.6);
      const commercial = COMMERCIAL.includes(zone);

      /* — planting against the wall, in a cluster beside a doorway — */
      if (rng.next() < plantP) {
        // pick a bay to stand beside, avoiding the extreme ends of the frontage
        const t = rng.range(0.16, 0.84);
        const bx = e.x0 + (e.x1 - e.x0) * t;
        const bz = e.z0 + (e.z1 - e.z0) * t;
        const n = rng.int(2, e.len > 9 ? 4 : 3);
        for (let i = 0; i < n; i++) {
          const along = (i - (n - 1) * 0.5) * rng.range(0.52, 0.78);
          const outward = Math.min(f.apron - 0.42, rng.range(0.46, 0.78));
          if (outward < 0.36) break;
          const x = bx + e.ux * along + e.nx * outward;
          const z = bz + e.uz * along + e.nz * outward;
          if (!guard.ok(x, z, 0.3, 0.1)) continue;
          const y = guard.surfaceY(x, z, false);
          const yaw = e.yaw + rng.range(-0.5, 0.5);
          const roll = rng.next();
          if (roll < 0.46) {
            this.pots.push({ x, y, z, yaw, scale: rng.range(0.85, 1.2) });
          } else if (roll < 0.74) {
            this.palms.push({ x, y, z, yaw, scale: rng.range(0.88, 1.22) });
          } else if (roll < 0.9) {
            this.blooms.push({ x, y, z, yaw, scale: rng.range(0.62, 0.92) });
          } else {
            this.planters.push({ x, y, z, yaw });
          }
          this._stats.pots++;
        }
      }

      /* — a hanging planter on the ironwork above — */
      if (rng.next() < (HANG_CHANCE[zone] ?? 0.1) * hangScale) {
        const t = rng.range(0.2, 0.8);
        const x = e.x0 + (e.x1 - e.x0) * t + e.nx * 0.12;
        const z = e.z0 + (e.z1 - e.z0) * t + e.nz * 0.12;
        this.hanging.push({
          x,
          y: f.y + rng.range(3.55, 4.05),
          z,
          yaw: e.yaw,
          scale: rng.range(0.9, 1.15),
        });
        this._stats.hanging++;
      }

      /* — pavement café: a table, chairs and an umbrella on the kerb — */
      if (commercial && f.apron > 2.15 && rng.next() < 0.1 * density * (0.5 + warmth * 1.6)) {
        const t = rng.range(0.28, 0.72);
        const cx = e.x0 + (e.x1 - e.x0) * t + e.nx * (f.apron * 0.52);
        const cz = e.z0 + (e.z1 - e.z0) * t + e.nz * (f.apron * 0.52);
        if (guard.ok(cx, cz, 0.55, 0.2)) {
          const y = guard.surfaceY(cx, cz, false);
          this.tables.push({ x: cx, y, z: cz, yaw: rng.range(0, Math.PI * 2) });
          if (rng.bool(0.72)) {
            this.umbrellas.push({ x: cx, y, z: cz, yaw: rng.range(0, Math.PI * 2), scale: 0.86 });
          }
          const seats = rng.int(2, 3);
          for (let s = 0; s < seats; s++) {
            const a = (s / seats) * Math.PI * 2 + rng.range(-0.4, 0.4);
            const sx = cx + Math.cos(a) * 0.78;
            const sz = cz + Math.sin(a) * 0.78;
            if (!guard.ok(sx, sz, 0.35, 0.15)) continue;
            this.chairs.push({
              x: sx,
              y: guard.surfaceY(sx, sz, false),
              z: sz,
              yaw: Math.atan2(cx - sx, cz - sz),
            });
          }
          this._stats.cafes++;
        }
      }

      /* — an A-board out on the pavement — */
      if (commercial && f.apron > 1.35 && rng.next() < 0.09 * density * (0.6 + warmth)) {
        const t = rng.range(0.2, 0.8);
        const outward = Math.min(f.apron - 0.5, 1.0);
        const x = e.x0 + (e.x1 - e.x0) * t + e.nx * outward;
        const z = e.z0 + (e.z1 - e.z0) * t + e.nz * outward;
        if (guard.ok(x, z, 0.4, 0.15)) {
          this.boards.push({
            x,
            y: guard.surfaceY(x, z, false),
            z,
            yaw: e.yaw + rng.range(-0.35, 0.35),
          });
          this._stats.boards++;
        }
      }

      /* — stacked crates outside a colmado — */
      if (commercial && f.apron > 1.0 && rng.next() < 0.07 * density) {
        const t = rng.range(0.15, 0.85);
        const n = rng.int(1, 3);
        for (let i = 0; i < n; i++) {
          const x = e.x0 + (e.x1 - e.x0) * t + e.ux * i * 0.34 + e.nx * rng.range(0.45, 0.72);
          const z = e.z0 + (e.z1 - e.z0) * t + e.uz * i * 0.34 + e.nz * rng.range(0.45, 0.72);
          if (!guard.ok(x, z, 0.3, 0.1)) continue;
          this.crates.push({
            x,
            y: guard.surfaceY(x, z, false) + (i === 2 ? 0.34 : 0),
            z,
            yaw: e.yaw + rng.range(-0.4, 0.4),
          });
        }
      }
    }
  }

  /* --------------------------------------------------------------- spans */

  /**
   * Bunting and festoon strings, hung between opposing façades.
   *
   * A span is only kept when the far end lands within 2.4 m of another lot's
   * front edge *and* that edge faces back this way — which is what stops a
   * string running off across a junction and terminating in the sky.
   */
  private hangStrings(
    fronts: readonly FrontRef[],
    layout: CityLayout,
    rng: RNG,
    scale: number,
    bulbs: boolean,
  ): void {
    const index = new SegmentIndex(fronts);
    const used = new Set<number>();
    const order = fronts.map((_, i) => i);
    rng.shuffle(order);

    const budget = Math.round(210 * scale);
    let made = 0;

    for (const fi of order) {
      if (made >= budget) break;
      const f = fronts[fi];
      if (used.has(f.lot.id)) continue;
      // narrow streets only: a 16 m boulevard does not carry bunting
      if (f.half > 9.5 || f.roadKind === 'coastal') continue;
      const zone = f.lot.zone;
      if (zone !== 'oldTown' && zone !== 'artQuarter' && zone !== 'plazaMayor' && zone !== 'marketRow') {
        continue;
      }

      const e = f.edge;
      const t = rng.range(0.3, 0.7);
      const ax = e.x0 + (e.x1 - e.x0) * t;
      const az = e.z0 + (e.z1 - e.z0) * t;
      const reach = f.half * 2;
      const qx = ax + e.nx * reach;
      const qz = az + e.nz * reach;
      const far = index.nearest(qx, qz, 2.6, -e.nx, -e.nz);
      if (!far) continue;
      if (used.has(far.lot.id)) continue;

      const bx = qx - e.nx * 0.22;
      const bz = qz - e.nz * 0.22;
      const ax2 = ax + e.nx * 0.22;
      const az2 = az + e.nz * 0.22;
      const yA = f.y + SPAN_Y + rng.range(-0.3, 0.45);
      const yB = far.y + SPAN_Y + rng.range(-0.3, 0.45);
      const span = Math.hypot(bx - ax2, bz - az2);
      if (span < 4 || span > 20) continue;

      const a = new THREE.Vector3(ax2, yA, az2);
      const b = new THREE.Vector3(bx, yB, bz);
      const mid = { x: (ax2 + bx) * 0.5, y: (yA + yB) * 0.5, z: (az2 + bz) * 0.5 };
      const roll = rng.next();

      // bunting on most, a festoon string on the rest, both on a few
      if (roll < 0.66) {
        const pts = catenaryPoints(a, b, span * 0.11 + 0.45, 11);
        this.cloth.open(mid.x, mid.y, mid.z, 1.35);
        buntingFlags(this.cloth.g, pts, 0.6, BUNTING_PALETTE, rng.next());
        this.cloth.close();
        this.wires.open(mid.x, mid.y, mid.z, 1.35);
        wireRibbon(this.wires.g, pts, 0x2b2b2b, 0.016);
        this.wires.close();
      }
      if (roll > 0.42) {
        const ay = yA - (SPAN_Y - FESTOON_Y);
        const by = yB - (SPAN_Y - FESTOON_Y);
        const fa = new THREE.Vector3(ax2, ay, az2);
        const fb = new THREE.Vector3(bx, by, bz);
        const pts = catenaryPoints(fa, fb, span * 0.13 + 0.55, 7);
        this.wires.open(mid.x, mid.y, mid.z, 1.35);
        wireRibbon(this.wires.g, pts, 0x23282b, 0.014);
        this.wires.close();
        if (bulbs) {
          for (let i = 1; i < pts.length - 1; i++) {
            this.bulbs.push({
              x: pts[i].x,
              y: pts[i].y,
              z: pts[i].z,
              yaw: rng.range(0, Math.PI * 2),
              cull: 1.35,
            });
          }
        }
      }

      used.add(f.lot.id);
      used.add(far.lot.id);
      made++;
      this._stats.spans++;
    }
    void layout;
  }

  /* -------------------------------------------------------------- market */

  private dressMarket(layout: CityLayout, guard: PlacementGuard, rng: RNG, density: number): void {
    const areas = layout.areas.filter((a: OpenArea) => a.zone === 'marketRow');
    for (const area of areas) {
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
      // two aisles of stalls running along the long axis, back to back
      const along = maxX - minX > maxZ - minZ;
      const lengthM = along ? maxX - minX : maxZ - minZ;
      const rows = 2;
      const perRow = Math.max(2, Math.round(((lengthM - 12) / 5.4) * Math.min(1, density)));
      for (let r = 0; r < rows; r++) {
        const lateral = (r - (rows - 1) * 0.5) * 9.5;
        for (let i = 0; i < perRow; i++) {
          const t = (i + 0.5) / perRow;
          const u = (along ? minX : minZ) + 6 + (lengthM - 12) * t;
          const x = along ? u : area.center.x + lateral;
          const z = along ? area.center.z + lateral : u;
          if (!pointInPolygon(x, z, area.polygon)) continue;
          if (!guard.ok(x, z, 2.4, 1.2)) continue;
          const y = layout.groundHeight(x, z) + 0.014;
          const yaw = (along ? 0 : Math.PI / 2) + (r === 0 ? 0 : Math.PI) + rng.range(-0.05, 0.05);
          this.stalls.push({ x, y, z, yaw, scale: rng.range(0.94, 1.08), tint: rng.pick(DRESS.awning) });
          this._stats.stalls++;

          // the painted banner over the counter
          const key = rng.pick(STALL_SIGNS);
          this.signs.open(x, y + 2.4, z, 1.6);
          stallBanner(this.signs, x, y, z, yaw, key);
          this.stallBanners.push(this.signs.close() ?? { start: 0, end: 0, mul: 1.6 });

          // crates at the stall's feet
          const n = rng.int(1, 3);
          for (let c = 0; c < n; c++) {
            const a = yaw + Math.PI * 0.5;
            const cx = x + Math.cos(a) * rng.range(-1.4, 1.4) - Math.sin(yaw) * 1.25;
            const cz = z + Math.sin(a) * rng.range(-1.4, 1.4) - Math.cos(yaw) * 1.25;
            if (!guard.ok(cx, cz, 1.6, 1.0)) continue;
            this.crates.push({
              x: cx,
              y: layout.groundHeight(cx, cz) + 0.014,
              z: cz,
              yaw: rng.range(0, Math.PI * 2),
            });
          }
        }
      }
    }
  }

  /* --------------------------------------------------------------- finish */

  private finish(rng: RNG): void {
    const kit = this.kit;
    if (!kit) return;

    // the painted board faces are four triangles each — merging them into the
    // stall banners keeps the sign atlas to a single draw call
    const boardFaceRanges: ClusterRange[] = [];
    for (const b of this.boards) {
      const faces = buildAboardFaces(rng.pick(BOARD_SIGNS));
      this.signs.open(b.x, b.y, b.z, 1);
      appendGeometry(this.signs, faces, b.x, b.y, b.z, b.yaw);
      const r = this.signs.close();
      boardFaceRanges.push(r ?? { start: 0, end: 0, mul: 1 });
      faces.dispose();
    }

    // Only a couple of dozen stalls, and every one wants its own awning
    // colour, so they merge into the shared cloth mesh instead of sharing one
    // instanced geometry — a draw call cheaper and far less repetitive. This
    // has to happen before the cloth builder is closed out below.
    const stallClothRanges: ClusterRange[] = [];
    for (let i = 0; i < this.stalls.length; i++) {
      const st = this.stalls[i];
      const geo = buildStall(rng.fork(0x26 + i), st.tint);
      this.cloth.open(st.x, st.y + 1.4, st.z, 1.5);
      appendGeometry(this.cloth, geo, st.x, st.y, st.z, st.yaw, st.scale ?? 1, st.scale ?? 1);
      const r = this.cloth.close();
      stallClothRanges.push(r ?? { start: 0, end: 0, mul: 1.5 });
      geo.dispose();
    }

    // the strung ironwork and its fixings are metal; same merged mesh as before
    this.addMerged(this.wires.build('aDress'), kit.metal, 'street/wires', false);
    const clothGeo = this.cloth.build('aWave');
    this.addMerged(clothGeo, kit.cloth, 'street/cloth', false);
    const signGeo = this.signs.build('aDress');
    this.addMerged(signGeo, kit.sign, 'street/signs', false);

    const pots = this.addInstanced(buildDoorwayPot(rng.fork(0x21), false), kit.foliage, this.pots, 'street/pot');
    const palms = this.addInstanced(buildPottedPalm(rng.fork(0x22)), kit.foliage, this.palms, 'street/palm');
    const blooms = this.addInstanced(
      buildBloomBush(rng.fork(0x23), rng.pick(DRESS.bloom)),
      kit.foliage,
      this.blooms,
      'street/bloom',
    );
    const planters = this.addInstanced(buildPlanterBox(rng.fork(0x24)), kit.solid, this.planters, 'street/planter');
    this.addInstanced(
      buildHangingPlanter(rng.fork(0x25), rng.pick(DRESS.bloom)),
      kit.foliage,
      this.hanging,
      'street/hanging',
    );
    const tables = this.addInstanced(buildPlasticTable(), kit.solid, this.tables, 'street/table');
    const chairs = this.addInstanced(buildPlasticChair(), kit.solid, this.chairs, 'street/chair');
    const umbrellas = this.addInstanced(buildUmbrella(1.5, 2.35), kit.cloth, this.umbrellas, 'street/umbrella');
    const boards = this.addInstanced(buildAboardFrame(), kit.solid, this.boards, 'street/board');
    const crates = this.addInstanced(buildProduceCrate(rng.fork(0x27)), kit.solid, this.crates, 'street/crate');
    this.addInstanced(buildBulb(), kit.glow, this.bulbs, 'street/bulb');

    /* --- hand the smashable half of the street to the destructible pool --- */
    this.registerDestructibles({
      pots, palms, blooms, planters, tables, chairs, umbrellas, boards, crates,
      clothGeo, signGeo, stallClothRanges, boardFaceRanges,
    });

    this.pots = [];
    this.palms = [];
    this.blooms = [];
    this.planters = [];
    this.hanging = [];
    this.tables = [];
    this.chairs = [];
    this.umbrellas = [];
    this.boards = [];
    this.stalls = [];
    this.crates = [];
    this.bulbs = [];
    this.stallBanners = [];
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
    // these span the whole district, so per-object frustum culling is useless;
    // the vertex cull is what actually removes them
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geo);
    this._stats.triangles += triCount(geo);
  }

  /**
   * One `InstancedMesh` per prop **per cell**, not one for the whole district.
   *
   * The vertex cull in `PropKit` already collapses every one of these props to
   * a point past `propDetailDistance` — but a single district-wide mesh still
   * submits all of its triangles, and the shadow camera submits them again. On
   * `high` that was 169 k triangles of pots, palms, planters and festoon bulbs
   * transformed every frame from every viewpoint to produce no pixels at all.
   *
   * Splitting on a {@link DRESS_CELL} grid gives each mesh a footprint smaller
   * than the cull radius, so {@link LodField} can drop the ones the shader has
   * already emptied and three can frustum-cull the rest — in the shadow pass
   * as well as the main one. It costs draw calls only for the cells that are
   * genuinely in range, which is three or four of them.
   */
  private addInstanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    list: DressPlacement[],
    name: string,
  ): Array<{ mesh: THREE.InstancedMesh; items: DressPlacement[] }> {
    const out: Array<{ mesh: THREE.InstancedMesh; items: DressPlacement[] }> = [];
    if (list.length === 0) {
      geo.dispose();
      return out;
    }
    const buckets = bucketByCell(list, DRESS_CELL, (p) => p);
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      // Each bucket needs its own `aCullMul`, which `dressInstanced` attaches
      // to the geometry, so the geometry cannot be shared between them. These
      // are 20–90 triangle props; a clone per cell is nothing.
      const g = buckets.length === 1 ? geo : geo.clone();
      const mesh = dressInstanced(g, mat, bucket.items, `${name}/${b}`);
      if (!mesh) {
        g.dispose();
        continue;
      }
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.geometries.push(mesh.geometry);
      this._stats.instances += mesh.count;
      this._stats.triangles += triCount(mesh.geometry) * mesh.count;

      // A landmark prop authored with `cull > 1` keeps the whole cell alive
      // that much longer; taking the max is the only safe reduction.
      let mul = 1;
      for (const it of bucket.items) mul = Math.max(mul, it.cull ?? 1);
      const f = bucketFootprint(bucket, DRESS_PAD);
      this.lod.add(mesh, f.cx, f.cz, f.radius, mul);

      out.push({ mesh, items: bucket.items });
    }
    if (buckets.length !== 1) geo.dispose();
    return out;
  }

  /* ------------------------------------------------------- destructibility */

  /**
   * Everything on this street that ought to go flying when the Jeep mounts the
   * pavement. The pool is proximity-driven, so registering two thousand props
   * costs two thousand records and no rigid bodies — see `Destructibles`.
   *
   * The market stall is the odd one out: twenty-odd of them share one merged
   * cloth mesh so each can carry its own awning colour, which means it cannot
   * be tumbled instance-by-instance. It registers its cloth span and its
   * painted banner span instead and collapses in place, which for a canvas
   * stall reads better than a rigid box cartwheeling down the aisle anyway.
   */
  private registerDestructibles(m: {
    pots: DressBuckets;
    palms: DressBuckets;
    blooms: DressBuckets;
    planters: DressBuckets;
    tables: DressBuckets;
    chairs: DressBuckets;
    umbrellas: DressBuckets;
    boards: DressBuckets;
    crates: DressBuckets;
    clothGeo: THREE.BufferGeometry | null;
    signGeo: THREE.BufferGeometry | null;
    stallClothRanges: ClusterRange[];
    boardFaceRanges: ClusterRange[];
  }): void {
    /* `Destructibles` addresses a prop by `(mesh, instance index)`, so each
     * spatial bucket registers with its own sub-list — the order inside a
     * bucket is exactly the order it was instanced in. */
    const reg = (buckets: DressBuckets, id: PropSpecId): void => {
      for (const b of buckets) destructibles.registerInstanced(this, b.mesh, id, b.items);
    };

    reg(m.pots, 'pot');
    reg(m.palms, 'palm');
    reg(m.blooms, 'bush');
    reg(m.planters, 'planter');
    reg(m.tables, 'table');
    reg(m.chairs, 'chair');
    reg(m.umbrellas, 'umbrella');
    reg(m.crates, 'crate');

    // An A-board's frame is instanced but its two painted faces live in the
    // shared sign mesh, so the cluster span has to travel with the instance it
    // belongs to — which now means finding it by identity rather than index.
    const sign = m.signGeo;
    if (sign) {
      const faceOf = new Map<DressPlacement, ClusterRange>();
      for (let i = 0; i < this.boards.length && i < m.boardFaceRanges.length; i++) {
        faceOf.set(this.boards[i], m.boardFaceRanges[i]);
      }
      for (const b of m.boards) {
        destructibles.registerInstanced(
          this,
          b.mesh,
          'board',
          b.items,
          b.items.map((it) => {
            const range = faceOf.get(it);
            return range ? [{ geo: sign, range }] : null;
          }),
        );
      }
    } else {
      reg(m.boards, 'board');
    }

    if (m.clothGeo) {
      const cloth = m.clothGeo;
      const sign = m.signGeo;
      for (let i = 0; i < this.stalls.length; i++) {
        const st = this.stalls[i];
        const parts: Array<{ geo: THREE.BufferGeometry; range: ClusterRange }> = [];
        const clothRange = m.stallClothRanges[i];
        if (clothRange) parts.push({ geo: cloth, range: clothRange });
        const banner = this.stallBanners[i];
        if (sign && banner) parts.push({ geo: sign, range: banner });
        destructibles.registerCluster(
          this,
          'stall',
          { x: st.x, y: st.y, z: st.z, yaw: st.yaw, scale: st.scale ?? 1 },
          parts,
        );
      }
    }
  }

  /* -------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number, timeOfDay: number): void {
    const cut = QUALITY_BUDGET[this.quality].propDetailDistance;
    this.kit?.update(dt, nightRamp(timeOfDay), cameraPos, cut, this);
    /* The cut is exactly the shader's own cull radius, so a cell that goes
     * invisible here was already collapsed to a point on the GPU — nothing
     * leaves the frame, only the transform cost does. The shadow pass needs no
     * separate rule: three frustum-tests every caster against the sun's box,
     * and a cell-sized bounding sphere finally makes that test say no. */
    this.lod.update(cameraPos, cut);
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const d = QUALITY_BUDGET[tier].propDetailDistance;
    // Enable/disable by tier, not by `visible` — `LodField` owns `visible` now
    // and would put a tier-dropped prop straight back on the next frame.
    this.lod.setEnabled(
      (m) => m.name.startsWith('street/crate') || m.name.startsWith('street/chair'),
      d >= 100,
    );
    this.lod.setEnabled((m) => m.name.startsWith('street/bulb'), d >= 90);
    this.lod.setEnabled((m) => m.name.startsWith('street/hanging'), d >= 80);
  }

  stats(): Record<string, number> {
    return {
      streetDrawCalls: this.group.children.length,
      streetInstances: this._stats.instances,
      streetTriangles: Math.round(this._stats.triangles),
      streetSpans: this._stats.spans,
      streetPots: this._stats.pots,
      streetHanging: this._stats.hanging,
      streetCafes: this._stats.cafes,
      streetStalls: this._stats.stalls,
      streetBoards: this._stats.boards,
    };
  }

  dispose(): void {
    destructibles.unregisterOwner(this);
    this.lod.clear();
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.meshes) {
      if (m instanceof THREE.InstancedMesh) m.dispose();
    }
    this.meshes.length = 0;
    this.kit?.release(this);
    this.kit = null;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ------------------------------------------------------------------ utils */

/** The painted board over a market stall's counter, on the sign material. */
function stallBanner(cb: ClusterBuilder, x: number, y: number, z: number, yaw: number, key: DressSign): void {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const to = (lx: number, ly: number, lz: number): THREE.Vector3 =>
    new THREE.Vector3(x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs);
  const w = 1.2;
  const d = 1.08;
  const y0 = 2.56;
  const y1 = 3.06;
  const rect = signRect(key);
  quadUV(cb.g, to(-w, y0, d), to(w, y0, d), to(w, y1, d), to(-w, y1, d), rect);
  quadUV(
    cb.g,
    to(w, y0, d - 0.02),
    to(-w, y0, d - 0.02),
    to(-w, y1, d - 0.02),
    to(w, y1, d - 0.02),
    { u0: rect.u1, v0: rect.v0, u1: rect.u0, v1: rect.v1 },
  );
}

/**
 * Nearest opposing façade lookup, over a uniform grid of lot front edges.
 * Used only by the bunting pass.
 */
class SegmentIndex {
  private cell = 14;
  private grid = new Map<number, number[]>();
  private fronts: readonly FrontRef[];

  constructor(fronts: readonly FrontRef[]) {
    this.fronts = fronts;
    for (let i = 0; i < fronts.length; i++) {
      const e = fronts[i].edge;
      for (const [px, pz] of [
        [e.x0, e.z0],
        [e.mx, e.mz],
        [e.x1, e.z1],
      ]) {
        const key = Math.floor(px / this.cell) * 100003 + Math.floor(pz / this.cell);
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        if (!list.includes(i)) list.push(i);
      }
    }
  }

  /** Closest front edge to (x,z) whose outward normal points along (nx,nz). */
  nearest(x: number, z: number, maxDist: number, nx: number, nz: number): FrontRef | null {
    let best: FrontRef | null = null;
    let bestD = maxDist;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const key = (Math.floor(x / this.cell) + di) * 100003 + (Math.floor(z / this.cell) + dj);
        const list = this.grid.get(key);
        if (!list) continue;
        for (const i of list) {
          const f = this.fronts[i];
          const e = f.edge;
          if (e.nx * nx + e.nz * nz < 0.72) continue;
          const d = distToSegment(x, z, e.x0, e.z0, e.x1, e.z1);
          if (d < bestD) {
            bestD = d;
            best = f;
          }
        }
      }
    }
    return best;
  }
}

/** 0..1 field that concentrates café tables and boards around the venues. */
function poiHeat(pois: readonly POI[]): (x: number, z: number) => number {
  const hot = pois.filter(
    (p) =>
      p.kind === 'cafe' ||
      p.kind === 'bakery' ||
      p.kind === 'gallery' ||
      p.kind === 'market' ||
      p.kind === 'plaza',
  );
  return (x: number, z: number): number => {
    let best = 0;
    for (const p of hot) {
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      best = Math.max(best, clamp01(1 - d / 62));
    }
    return best;
  };
}
