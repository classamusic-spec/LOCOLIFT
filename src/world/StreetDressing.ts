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

export interface StreetDressingOptions {
  density?: number;
  /** the world's `MaterialLibrary`, for the shared rain wetness drive */
  materials?: WetnessSource | null;
  /** dress the market floor with stalls */
  market?: boolean;
}

/* -------------------------------------------------------------------- data */

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
          this.signs.close();

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
    for (const b of this.boards) {
      const faces = buildAboardFaces(rng.pick(BOARD_SIGNS));
      this.signs.open(b.x, b.y, b.z, 1);
      appendGeometry(this.signs, faces, b.x, b.y, b.z, b.yaw);
      this.signs.close();
      faces.dispose();
    }

    // Only a couple of dozen stalls, and every one wants its own awning
    // colour, so they merge into the shared cloth mesh instead of sharing one
    // instanced geometry — a draw call cheaper and far less repetitive. This
    // has to happen before the cloth builder is closed out below.
    for (let i = 0; i < this.stalls.length; i++) {
      const st = this.stalls[i];
      const geo = buildStall(rng.fork(0x26 + i), st.tint);
      this.cloth.open(st.x, st.y + 1.4, st.z, 1.5);
      appendGeometry(this.cloth, geo, st.x, st.y, st.z, st.yaw, st.scale ?? 1, st.scale ?? 1);
      this.cloth.close();
      geo.dispose();
    }

    this.addMerged(this.wires.build('aDress'), kit.solid, 'street/wires', false);
    this.addMerged(this.cloth.build('aWave'), kit.cloth, 'street/cloth', false);
    this.addMerged(this.signs.build('aDress'), kit.sign, 'street/signs', false);

    this.addInstanced(buildDoorwayPot(rng.fork(0x21), false), kit.foliage, this.pots, 'street/pot');
    this.addInstanced(buildPottedPalm(rng.fork(0x22)), kit.foliage, this.palms, 'street/palm');
    this.addInstanced(
      buildBloomBush(rng.fork(0x23), rng.pick(DRESS.bloom)),
      kit.foliage,
      this.blooms,
      'street/bloom',
    );
    this.addInstanced(buildPlanterBox(rng.fork(0x24)), kit.solid, this.planters, 'street/planter');
    this.addInstanced(
      buildHangingPlanter(rng.fork(0x25), rng.pick(DRESS.bloom)),
      kit.foliage,
      this.hanging,
      'street/hanging',
    );
    this.addInstanced(buildPlasticTable(), kit.solid, this.tables, 'street/table');
    this.addInstanced(buildPlasticChair(), kit.solid, this.chairs, 'street/chair');
    this.addInstanced(buildUmbrella(1.5, 2.35), kit.cloth, this.umbrellas, 'street/umbrella');
    this.addInstanced(buildAboardFrame(), kit.solid, this.boards, 'street/board');
    this.addInstanced(buildProduceCrate(rng.fork(0x27)), kit.solid, this.crates, 'street/crate');
    this.addInstanced(buildBulb(), kit.glow, this.bulbs, 'street/bulb');

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

  private addInstanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    list: DressPlacement[],
    name: string,
  ): void {
    const mesh = dressInstanced(geo, mat, list, name);
    if (!mesh) {
      geo.dispose();
      return;
    }
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(mesh.geometry);
    this._stats.instances += mesh.count;
    this._stats.triangles += triCount(mesh.geometry) * mesh.count;
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
      if (m.name === 'street/crate' || m.name === 'street/chair') m.visible = d >= 100;
      else if (m.name === 'street/bulb') m.visible = d >= 90;
      else if (m.name === 'street/hanging') m.visible = d >= 80;
    }
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
