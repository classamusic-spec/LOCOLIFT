/**
 * Loco Lift — Piñones.
 *
 * The beach road east of the city: a fast, sweeping coastal ribbon carried out
 * of the corniche's east end on a low causeway, then run for six hundred metres
 * along a sand spit lined with **chinchorros** — the timber-and-zinc fritter
 * shacks that are the single most Puerto Rican thing on this map.
 *
 * What is here, and why:
 *
 *  - **One ribbon, one surface shader.** The causeway, the carriageway with its
 *    painted lines, the gravel parking apron, the dune berm, the golden beach,
 *    the wet run-up and the submerged shelf are all the same mesh and the same
 *    material. A per-vertex `aBeach` channel carries (lateral metres, surface
 *    kind, distance along the road) and the fragment shader paints asphalt
 *    aggregate, lane markings, sand ripples, drift mottling, an animated
 *    tideline and a foam edge from it. That is why 600 m of coast costs four
 *    draw calls.
 *  - **Two colliders, two feels.** The carriageway is one static trimesh at
 *    road friction; the sand, gravel and beach are a second at loose-surface
 *    friction. Arriving on the sand at 40 m/s and immediately having to drive
 *    it differently is the whole point of the place.
 *  - **The chinchorro clusters.** Five clusters of three to five shacks with
 *    hand-painted signs, propped shutters, zinc roofs, fryer flues, Puerto
 *    Rican flags, speakers, festoon lights and a smoke plume, plus the
 *    red-and-white umbrellas, plastic chairs, barrel tables, picnic benches,
 *    coolers, banner flags, yellow bollards and angle-parked cars that surround
 *    them. Everything merges per material or instances per type.
 *  - **The planting is `Vegetation`'s, not ours.** Rather than write a second
 *    palm, this layer hands the existing coastal-planting layer a *projected*
 *    layout — the Piñones ground surface, and one open area per cluster — and
 *    lets it plant its own coconut palms, sea grape and flowering shrubs with
 *    its own wind rig. One implementation of a palm exists in this project.
 *  - **Jumps.** Three road crests, four berm gaps that open the sand to the
 *    road, and two sand kickers at the tideline, all cut into the ribbon itself
 *    so the collider agrees with the picture.
 *
 * **Grading contract.** Every vertex of the ribbon sits at or above
 * `layout.groundHeight`, so the world's existing terrain and its collider never
 * poke through, and the carriageway is flat-graded from the maximum terrain
 * height across its own width. At the west end the deck lerps down onto the
 * existing corniche surface over 45 m so the junction has no lip.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { POI, QualityTier, RoadGraph } from '../core/types';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle, PhysicsWorldAPI } from '../physics/PhysicsTypes';
import { SEA_LEVEL } from './CityLayout';
import { GeoBuilder } from './Coast';
import type { MaterialLibrary } from './Materials';
import { Vegetation } from './Vegetation';
import {
  KIT,
  PropKit,
  buildBannerFlag,
  buildBarrelTable,
  buildBollard,
  buildChinchorro,
  buildCooler,
  buildFestoonBulb,
  buildParkedCar,
  buildPicnicBench,
  buildPlasticChair,
  buildPlasticTable,
  buildRock,
  buildSmokePlume,
  buildThicket,
  buildUmbrella,
  bunting,
  catenary,
  instanced,
  makeBuilders,
  nightFactor,
  shade,
  triangleCount,
  type KitBuilders,
  type Placement,
  type ShackSpec,
  type SignKey,
} from './ShackKit';
import type { CityLayout, DistrictZone, OpenArea, WorldLayer, WorldOpts } from './WorldTypes';

/* ========================================================================== *
 *  the road's line
 * ========================================================================== */

/**
 * Control points, west to east. The first is the east terminus of the existing
 * corniche; everything after it is new land. The line deliberately wanders in
 * `z` by ±15 m, which — because the terrain east of the district is a pure
 * north-south profile — turns into a genuinely rolling, sweeping road for free.
 */
const SPINE: ReadonlyArray<readonly [number, number]> = [
  [357, 261.4],
  [389, 272],
  [426, 286],
  [470, 296],
  [516, 301],
  [566, 299],
  [618, 295],
  [668, 299],
  [720, 306],
  [772, 310],
  [824, 307],
  [876, 300],
  [928, 296],
  [980, 299],
  [1032, 305],
  [1078, 312],
];

/** Station pitch along the road, metres. */
const STEP = 4;
/** Half-width of the carriageway. §1.1 seafront: 14 m road; this is 11.2. */
const HALF_ROAD = 5.6;
/** Where the gravel shoulder ends and the apron begins. */
const SHOULDER = 6.7;
/** Depth of water the beach's waterline aims for — this is what keeps the surf
 *  over the turquoise part of the ocean's bathymetry rather than the deep blue. */
const WATER_TARGET = -1.2;
/** How far the submerged sand shelf runs past the waterline. */
const SURF_RUN = 20;
/** Deepest point of that shelf. */
const SHELF_DEPTH = -3.4;

/** Road crests — free air at speed. `[station metres, height, width]`. */
const HUMPS: ReadonlyArray<readonly [number, number, number]> = [
  [148, 1.5, 21],
  [352, 1.15, 18],
  [560, 1.65, 24],
];

/** Berm gaps: the sand is open to the road here. `[station, half-width]`. */
const BERM_GAPS: ReadonlyArray<readonly [number, number]> = [
  [96, 13],
  [232, 11],
  [398, 14],
  [536, 12],
  [648, 16],
];

/** Sand kickers at the tideline. `[station, lateral fraction of the beach]`. */
const KICKERS: ReadonlyArray<readonly [number, number]> = [
  [188, 0.62],
  [468, 0.55],
];

type SurfaceCode = 0 | 1 | 2 | 3; // sand | asphalt | gravel | scrub

interface Column {
  /** 'abs' = fixed lateral offset; 'beach' / 'surf' = fraction of the run */
  mode: 'abs' | 'beach' | 'surf';
  v: number;
  kind: SurfaceCode;
  /** include in the drivable collider */
  solid: boolean;
}

/**
 * The cross-section, inland (negative) to seaward (positive). The inland side
 * is a cut bank that simply rides the existing hillside 5 cm proud of it; the
 * seaward side is entirely new sand the layer owns outright.
 */
const COLUMNS: readonly Column[] = [
  { mode: 'abs', v: -34, kind: 3, solid: false },
  { mode: 'abs', v: -26, kind: 3, solid: false },
  { mode: 'abs', v: -20, kind: 3, solid: false },
  { mode: 'abs', v: -16, kind: 3, solid: true },
  { mode: 'abs', v: -13, kind: 0, solid: true },
  { mode: 'abs', v: -11, kind: 0, solid: true },
  { mode: 'abs', v: -9.4, kind: 2, solid: true },
  { mode: 'abs', v: -8, kind: 2, solid: true },
  { mode: 'abs', v: -6.7, kind: 2, solid: true },
  { mode: 'abs', v: -5.6, kind: 1, solid: true },
  { mode: 'abs', v: -2.8, kind: 1, solid: true },
  { mode: 'abs', v: 0, kind: 1, solid: true },
  { mode: 'abs', v: 2.8, kind: 1, solid: true },
  { mode: 'abs', v: 5.6, kind: 1, solid: true },
  { mode: 'abs', v: 6.7, kind: 2, solid: true },
  { mode: 'beach', v: 0.0, kind: 2, solid: true },
  { mode: 'beach', v: 0.18, kind: 2, solid: true },
  { mode: 'beach', v: 0.34, kind: 2, solid: true },
  { mode: 'beach', v: 0.46, kind: 0, solid: true },
  { mode: 'beach', v: 0.58, kind: 0, solid: true },
  { mode: 'beach', v: 0.72, kind: 0, solid: true },
  { mode: 'beach', v: 0.86, kind: 0, solid: true },
  { mode: 'beach', v: 1.0, kind: 0, solid: true },
  { mode: 'surf', v: 0.3, kind: 0, solid: false },
  { mode: 'surf', v: 0.65, kind: 0, solid: false },
  { mode: 'surf', v: 1.0, kind: 0, solid: false },
];

/* ========================================================================== *
 *  the surface shader
 * ========================================================================== */

interface DeckUniforms {
  uTime: { value: number };
  uSeaLevel: { value: number };
  uWetness: { value: number };
  uSand: { value: THREE.Color };
  uSandWet: { value: THREE.Color };
  uFoam: { value: THREE.Color };
  uAsphalt: { value: THREE.Color };
  uLineY: { value: THREE.Color };
  uLineW: { value: THREE.Color };
}

const DECK_COMMON = /* glsl */ `
float pnHash( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}
float pnNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = pnHash( i );
  float b = pnHash( i + vec2( 1.0, 0.0 ) );
  float c = pnHash( i + vec2( 0.0, 1.0 ) );
  float d = pnHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float pnFbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 4; i ++ ) {
    s += pnNoise( p ) * a;
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}
/** metres above sea level the water's edge reaches, at this point along shore */
float pnRunUp( float t, float along ) {
  return 0.26 * sin( t * 0.36 + along * 0.021 )
       + 0.17 * sin( t * 0.61 - along * 0.033 + 1.7 )
       + 0.10 * sin( t * 1.07 + along * 0.049 + 4.1 );
}
`;

/* ========================================================================== *
 *  deck builder — positions, analytic normals, aux channel, collider
 * ========================================================================== */

class DeckBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly aux: number[] = [];
  readonly idx: number[] = [];
  private n = 0;
  private c = new THREE.Color();

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    colour: number,
    av: number,
    ak: number,
    as: number,
  ): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.c.setHex(colour, THREE.SRGBColorSpace);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.aux.push(av, ak, as);
    return this.n++;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  get vertexCount(): number {
    return this.n;
  }

  build(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBeach', new THREE.Float32BufferAttribute(this.aux, 3));
    g.setIndex(
      this.n > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1),
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ========================================================================== *
 *  the layer
 * ========================================================================== */

export interface PinonesOptions {
  /** multiplier on every scatter count */
  density?: number;
  /** share the world's wetness uniform so rain darkens the beach road too */
  materials?: MaterialLibrary;
  /** hand the planting to `Vegetation` (default true) */
  planting?: boolean;
  /** metres past which the shack clusters stop drawing */
  propDistance?: number;
}

interface Station {
  x: number;
  z: number;
  /** unit tangent along the road */
  tx: number;
  tz: number;
  /** unit seaward normal */
  nx: number;
  nz: number;
  /** arc length from the causeway mouth */
  s: number;
  /** graded carriageway height */
  y: number;
  /** lateral offset of the waterline */
  waterV: number;
  /** lateral offset of the berm crest */
  bermV: number;
  /** height added to the berm crest, 0 in a gap */
  bermH: number;
}

export class Pinones implements WorldLayer {
  readonly name = 'pinones';
  readonly group = new THREE.Group();

  /** the graded ground, always drawn */
  private deckGroup = new THREE.Group();
  /** shacks, furniture, cars — culled hard by distance */
  private propGroup = new THREE.Group();
  /** palms and understorey, from the shared `Vegetation` layer */
  private plantGroup = new THREE.Group();

  private quality: QualityTier;
  private options: PinonesOptions;
  private kit: PropKit | null = null;
  private vegetation: Vegetation | null = null;

  private stations: Station[] = [];
  private layout: CityLayout | null = null;
  private physics: PhysicsWorldAPI | null = null;
  private bodies: BodyHandle[] = [];

  private geometries: THREE.BufferGeometry[] = [];
  private meshes: THREE.Object3D[] = [];
  private deckMat: THREE.MeshStandardMaterial | null = null;

  private uniforms: DeckUniforms = {
    uTime: { value: 0 },
    uSeaLevel: { value: SEA_LEVEL },
    uWetness: { value: 0 },
    uSand: { value: new THREE.Color().setHex(0xe6d3a6, THREE.SRGBColorSpace) },
    uSandWet: { value: new THREE.Color().setHex(0x8a7757, THREE.SRGBColorSpace) },
    uFoam: { value: new THREE.Color().setHex(0xf6fbfa, THREE.SRGBColorSpace) },
    uAsphalt: { value: new THREE.Color().setHex(0x4b4a48, THREE.SRGBColorSpace) },
    uLineY: { value: new THREE.Color().setHex(0xe8b83c, THREE.SRGBColorSpace) },
    uLineW: { value: new THREE.Color().setHex(0xe4e0d4, THREE.SRGBColorSpace) },
  };

  private _stats = {
    shacks: 0,
    umbrellas: 0,
    chairs: 0,
    cars: 0,
    bollards: 0,
    palms: 0,
    deckTriangles: 0,
    propTriangles: 0,
    colliderTriangles: 0,
    drawCalls: 0,
    length: 0,
  };

  constructor(quality: QualityTier, options: PinonesOptions = {}) {
    this.quality = quality;
    this.options = { density: 1, planting: true, ...options };
    this.group.name = 'world/pinones';
    this.deckGroup.name = 'pinones/deck';
    this.propGroup.name = 'pinones/props';
    this.plantGroup.name = 'pinones/planting';
    this.group.add(this.deckGroup, this.propGroup, this.plantGroup);
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.layout = layout;
    this.physics = opts.physics;
    this.kit = PropKit.acquire(this.quality);
    if (this.options.materials) {
      // bind the world's shared rain drive without joining its program cache key
      this.uniforms.uWetness = this.options.materials.wetnessUniform;
    }

    this.buildStations(layout);
    this.buildDeck(opts);

    const rng = opts.rng.fork(0x9151);
    this.buildProps(rng);
    if (this.options.planting !== false) this.buildPlanting(layout, opts);

    this._stats.drawCalls = this.countDrawCalls();
  }

  /* ------------------------------------------------------------ geometry */

  /** Catmull-Rom through {@link SPINE}, resampled at a constant arc pitch. */
  private buildStations(layout: CityLayout): void {
    const pts: THREE.Vector2[] = SPINE.map(([x, z]) => new THREE.Vector2(x, z));
    const dense: THREE.Vector2[] = [];
    const p = new THREE.Vector2();
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const sub = 12;
      for (let k = 0; k < sub; k++) {
        const t = k / sub;
        const t2 = t * t;
        const t3 = t2 * t;
        p.set(
          0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        );
        dense.push(p.clone());
      }
    }
    dense.push(pts[pts.length - 1].clone());

    // arc-length resample
    let acc = 0;
    const path: Array<{ x: number; z: number; s: number }> = [{ x: dense[0].x, z: dense[0].y, s: 0 }];
    for (let i = 1; i < dense.length; i++) {
      acc += dense[i].distanceTo(dense[i - 1]);
      path.push({ x: dense[i].x, z: dense[i].y, s: acc });
    }
    const total = acc;
    this._stats.length = total;

    const gh = (x: number, z: number): number => layout.groundHeight(x, z);
    const nodeY = gh(SPINE[0][0], SPINE[0][1]);

    const stations: Station[] = [];
    for (let s = 0; s <= total; s += STEP) {
      // locate s in the dense path
      let i = 1;
      while (i < path.length - 1 && path[i].s < s) i++;
      const a = path[i - 1];
      const b = path[i];
      const t = (s - a.s) / Math.max(1e-4, b.s - a.s);
      const x = lerp(a.x, b.x, t);
      const z = lerp(a.z, b.z, t);
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      // seaward normal: the perpendicular with the larger +z component
      let nx = -tz;
      let nz = tx;
      if (nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      stations.push({ x, z, tx, tz, nx, nz, s, y: 0, waterV: 20, bermV: 12, bermH: 0.5 });
    }

    /* --- grade the carriageway: flat across its own width, above the ground - */
    const raw: number[] = [];
    for (const st of stations) {
      let maxY = -Infinity;
      for (let v = -HALF_ROAD - 1.4; v <= HALF_ROAD + 1.4; v += 1.6) {
        maxY = Math.max(maxY, gh(st.x + st.nx * v, st.z + st.nz * v));
      }
      raw.push(maxY);
    }
    // a 5-tap smooth so the road does not inherit the terrain's noise
    const smooth: number[] = raw.slice();
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < smooth.length - 1; i++) {
        smooth[i] = smooth[i - 1] * 0.25 + smooth[i] * 0.5 + smooth[i + 1] * 0.25;
      }
    }
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      const lift = lerp(0.06, 0.4, smoothstep(st.s / 45));
      let y = Math.max(smooth[i], raw[i]) + lift;
      // crests
      for (const [hs, hh, hw] of HUMPS) y += hh * Math.exp(-(((st.s - hs) / hw) ** 2));
      // tie into the existing corniche surface
      const tie = smoothstep(st.s / 45);
      st.y = lerp(nodeY + 0.04, y, tie);
    }

    /* --- the waterline: march seaward until the ground reaches wading depth - */
    for (const st of stations) {
      let waterV = 14;
      for (let v = 8; v <= 46; v += 1) {
        if (gh(st.x + st.nx * v, st.z + st.nz * v) <= WATER_TARGET) {
          waterV = v;
          break;
        }
        waterV = v;
      }
      st.waterV = clamp(waterV, 13, 42);
    }
    // smooth the shoreline; a shore that follows a 3 m height grid is a saw
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i < stations.length - 1; i++) {
        stations[i].waterV =
          stations[i - 1].waterV * 0.27 + stations[i].waterV * 0.46 + stations[i + 1].waterV * 0.27;
      }
    }
    for (const st of stations) {
      st.bermV = SHOULDER + (st.waterV - SHOULDER) * 0.46;
      let gap = 0;
      for (const [gs, gw] of BERM_GAPS) gap = Math.max(gap, Math.exp(-(((st.s - gs) / gw) ** 2)));
      st.bermH = lerp(0.55 + 0.35 * Math.sin(st.s * 0.031), -0.25, clamp01(gap * 1.25));
    }

    this.stations = stations;
  }

  /** Lateral offset of a cross-section column at a station. */
  private columnV(st: Station, c: Column): number {
    if (c.mode === 'abs') return c.v;
    if (c.mode === 'beach') return lerp(st.bermV, st.waterV, c.v);
    return st.waterV + SURF_RUN * c.v;
  }

  /** Surface height of the ribbon at a station and lateral offset. */
  private profile(st: Station, v: number): number {
    const gh = this.layout ? this.layout.groundHeight : (): number => 0;
    const x = st.x + st.nx * v;
    const z = st.z + st.nz * v;
    const ground = gh(x, z);
    let y: number;

    if (v >= -HALF_ROAD && v <= HALF_ROAD) {
      // 2 % crown, §1.1
      y = st.y - 0.09 * (v / HALF_ROAD) ** 2;
    } else if (v < -HALF_ROAD) {
      const shoulder = st.y - 0.12;
      const d = -v - HALF_ROAD;
      if (d < 2.4) {
        y = shoulder - d * 0.06;
      } else {
        // the cut bank simply rides the hillside, blended off the shoulder
        const t = clamp01((d - 2.4) / 4.5);
        y = lerp(shoulder - 0.14, ground + 0.06, t);
      }
    } else {
      const bermY = st.y - 0.55 + st.bermH;
      if (v <= SHOULDER) {
        y = st.y - 0.09 - (v - HALF_ROAD) * 0.1;
      } else if (v <= st.bermV) {
        const t = clamp01((v - SHOULDER) / Math.max(0.001, st.bermV - SHOULDER));
        // gravel apron falls away from the shoulder, then lifts onto the berm
        y = lerp(st.y - 0.2, bermY, t * t * (3 - 2 * t));
      } else if (v <= st.waterV) {
        const t = clamp01((v - st.bermV) / Math.max(0.001, st.waterV - st.bermV));
        const face = (1 - t) ** 1.7;
        y = SEA_LEVEL + (bermY - SEA_LEVEL) * face;
        // scalloped berm face and a low cusp line near the water
        y += Math.sin(st.s * 0.09 + t * 2.2) * 0.09 * (1 - t) * t * 4;
      } else {
        const t = clamp01((v - st.waterV) / SURF_RUN);
        y = SEA_LEVEL + SHELF_DEPTH * t ** 1.25;
      }
      // sand kickers: a wedge of packed sand at the tideline, lip to the sea
      for (const [ks, kf] of KICKERS) {
        const kv = lerp(st.bermV, st.waterV, kf);
        const ds = (st.s - ks) / 11;
        const dv = (v - kv) / 7;
        const bump = Math.exp(-(ds * ds) - dv * dv);
        y += bump * 2.3 * clamp01(1.35 - Math.abs(ds) * 0.9);
      }
    }
    // never below the world's own ground: the existing terrain collider and mesh
    // stay honest under everything this layer draws
    return Math.max(y, ground + 0.04);
  }

  /** Analytic normal of the ribbon surface. */
  private normalAt(st: Station, stNext: Station, v: number, out: THREE.Vector3): THREE.Vector3 {
    const d = 0.7;
    const y0 = this.profile(st, v - d);
    const y1 = this.profile(st, v + d);
    const ya = this.profile(st, v);
    const yb = this.profile(stNext, v);
    const ds = Math.max(1e-3, Math.hypot(stNext.x - st.x, stNext.z - st.z));
    // dP/dv = (nx, (y1-y0)/2d, nz); dP/ds = (tx, (yb-ya)/ds, tz)
    const av = new THREE.Vector3(st.nx, (y1 - y0) / (2 * d), st.nz);
    const as = new THREE.Vector3(st.tx, (yb - ya) / ds, st.tz);
    out.crossVectors(as, av).normalize();
    if (out.y < 0) out.multiplyScalar(-1);
    return out;
  }

  private buildDeck(opts: WorldOpts): void {
    const sts = this.stations;
    if (sts.length < 2) return;
    const chunks = this.quality === 'low' ? 2 : 4;
    const perChunk = Math.ceil((sts.length - 1) / chunks);
    const nrm = new THREE.Vector3();

    const colPos: number[] = [];
    const colIdx: number[] = [];
    const sandPos: number[] = [];
    const sandIdx: number[] = [];

    const kindColour = (kind: SurfaceCode, v: number, st: Station): number => {
      switch (kind) {
        case 1:
          return 0xffffff;
        case 2:
          return v < 0 ? 0xcfc3a8 : 0xd7cbb0;
        case 3: {
          // the cut bank dissolves from dune sand into the district's own green
          const t = clamp01((-v - 13) / 18);
          return shade(0xb9b481, 1 - t * 0.22) & (t > 0.5 ? 0xffffff : 0xffffff);
        }
        default: {
          const dry = clamp01((this.profileHeightCache - SEA_LEVEL) / 2.4);
          void dry;
          void st;
          return 0xffffff;
        }
      }
    };

    for (let c = 0; c < chunks; c++) {
      const i0 = c * perChunk;
      const i1 = Math.min(sts.length - 1, (c + 1) * perChunk);
      if (i1 <= i0) continue;
      const db = new DeckBuilder();
      const rowIndex: number[][] = [];

      for (let i = i0; i <= i1; i++) {
        const st = sts[i];
        const stNext = sts[Math.min(sts.length - 1, i + 1)];
        const row: number[] = [];
        for (const col of COLUMNS) {
          const v = this.columnV(st, col);
          const y = this.profile(st, v);
          this.profileHeightCache = y;
          const x = st.x + st.nx * v;
          const z = st.z + st.nz * v;
          this.normalAt(st, stNext, v, nrm);
          row.push(
            db.vertex(
              x,
              y,
              z,
              nrm.x,
              nrm.y,
              nrm.z,
              st.s / 6,
              v / 6,
              kindColour(col.kind, v, st),
              v,
              col.kind,
              st.s,
            ),
          );
        }
        rowIndex.push(row);
      }

      for (let r = 0; r < rowIndex.length - 1; r++) {
        const a = rowIndex[r];
        const b = rowIndex[r + 1];
        for (let k = 0; k < COLUMNS.length - 1; k++) {
          db.quad(a[k], b[k], b[k + 1], a[k + 1]);
        }
      }

      const geo = db.build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.deckMaterial());
      mesh.name = `pinones/deck${c}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.deckGroup.add(mesh);
      this.geometries.push(geo);
      this.meshes.push(mesh);
      this._stats.deckTriangles += (geo.getIndex()?.count ?? 0) / 3;
    }

    /* --- colliders: carriageway and loose surface get their own friction --- */
    const pushTri = (
      pos: number[],
      idx: number[],
      a: THREE.Vector3,
      b: THREE.Vector3,
      c2: THREE.Vector3,
    ): void => {
      const base = pos.length / 3;
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c2.x, c2.y, c2.z);
      idx.push(base, base + 1, base + 2);
    };
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();
    const pc = new THREE.Vector3();
    const pd = new THREE.Vector3();
    const put = (st: Station, v: number, out: THREE.Vector3): THREE.Vector3 =>
      out.set(st.x + st.nx * v, this.profile(st, v), st.z + st.nz * v);

    for (let i = 0; i < sts.length - 1; i++) {
      const s0 = sts[i];
      const s1 = sts[i + 1];
      for (let k = 0; k < COLUMNS.length - 1; k++) {
        const ca = COLUMNS[k];
        const cb = COLUMNS[k + 1];
        if (!ca.solid || !cb.solid) continue;
        const va0 = this.columnV(s0, ca);
        const vb0 = this.columnV(s0, cb);
        const va1 = this.columnV(s1, ca);
        const vb1 = this.columnV(s1, cb);
        put(s0, va0, pa);
        put(s1, va1, pb);
        put(s1, vb1, pc);
        put(s0, vb0, pd);
        const road = ca.kind === 1 && cb.kind === 1;
        const pos = road ? colPos : sandPos;
        const idx = road ? colIdx : sandIdx;
        pushTri(pos, idx, pa, pb, pc);
        pushTri(pos, idx, pa, pc, pd);
      }
    }

    const makeBody = (pos: number[], idx: number[], friction: number, surface: string): void => {
      if (idx.length === 0) return;
      const body = opts.physics.createBody({
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
    };
    makeBody(colPos, colIdx, 1.0, 'asphalt');
    makeBody(sandPos, sandIdx, 0.72, 'sand');
  }

  private profileHeightCache = 0;

  private deckMaterial(): THREE.MeshStandardMaterial {
    if (this.deckMat) return this.deckMat;
    const mat = new THREE.MeshStandardMaterial({
      name: 'loco/pinonesDeck',
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.75,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uSeaLevel = u.uSeaLevel;
      shader.uniforms.uWetness = u.uWetness;
      shader.uniforms.uSand = u.uSand;
      shader.uniforms.uSandWet = u.uSandWet;
      shader.uniforms.uFoam = u.uFoam;
      shader.uniforms.uAsphalt = u.uAsphalt;
      shader.uniforms.uLineY = u.uLineY;
      shader.uniforms.uLineW = u.uLineW;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          ['#include <common>', 'attribute vec3 aBeach;', 'varying vec3 vBeach;', 'varying vec3 vWorldPos;'].join('\n'),
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vBeach = aBeach;',
            'vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
          ].join('\n'),
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform float uTime;',
            'uniform float uSeaLevel;',
            'uniform float uWetness;',
            'uniform vec3 uSand;',
            'uniform vec3 uSandWet;',
            'uniform vec3 uFoam;',
            'uniform vec3 uAsphalt;',
            'uniform vec3 uLineY;',
            'uniform vec3 uLineW;',
            'varying vec3 vBeach;',
            'varying vec3 vWorldPos;',
            DECK_COMMON,
          ].join('\n'),
        )
        .replace(
          '#include <map_fragment>',
          [
            '#include <map_fragment>',
            'float pnV = vBeach.x;',
            'float pnKind = vBeach.y;',
            'float pnS = vBeach.z;',
            'vec2 pnW = vWorldPos.xz;',
            'float pnRough = 0.92;',

            /* ---------------- sand ---------------- */
            'float pnGrain = pnFbm( pnW * 3.2 ) * 0.16 + pnNoise( pnW * 11.0 ) * 0.07;',
            'float pnDrift = pnFbm( pnW * 0.055 );',
            'vec3 pnSandC = uSand * mix( vec3( 0.93, 0.95, 1.03 ), vec3( 1.08, 1.03, 0.92 ), pnDrift );',
            'float pnRip = sin( ( pnV - vBeach.z * 0.02 ) * 1.5 + pnFbm( pnW * 0.3 ) * 7.0 ) * 0.5 + 0.5;',
            'pnSandC *= 1.0 + ( pnGrain - 0.11 ) * 0.95 + pnRip * 0.05;',
            // shell hash and dark mineral sand along the old high-tide line
            'float pnHash = smoothstep( 1.6, 0.5, vWorldPos.y - uSeaLevel ) * smoothstep( 0.1, 0.6, vWorldPos.y - uSeaLevel );',
            'pnSandC = mix( pnSandC, pnSandC * vec3( 0.76, 0.72, 0.68 ), pnHash * smoothstep( 0.45, 0.8, pnFbm( pnW * 0.42 + 11.0 ) ) * 0.6 );',
            // the animated water edge
            'float pnEdge = uSeaLevel + pnRunUp( uTime, pnS ) + pnFbm( vec2( pnS * 0.05, uTime * 0.07 ) ) * 0.38 - 0.16;',
            'float pnAbove = vWorldPos.y - pnEdge;',
            'float pnWet = 1.0 - smoothstep( -0.05, 1.05, pnAbove );',
            'pnWet = clamp( max( pnWet, 1.0 - smoothstep( -0.3, 2.2, vWorldPos.y - uSeaLevel ) * 0.6 ), 0.0, 1.0 );',
            'float pnFoamBand = smoothstep( 0.5, 0.0, abs( pnAbove - 0.09 ) );',
            'float pnFoam = pnFoamBand * smoothstep( 0.3, 0.72, pnFbm( pnW * 0.95 + vec2( 0.0, uTime * 0.6 ) ) ) * 1.2;',
            'pnFoam += smoothstep( 0.2, 0.0, abs( pnAbove - 0.01 ) ) * 0.5;',
            'pnFoam *= step( -1.8, pnAbove );',
            'pnSandC = mix( pnSandC, uSandWet, pnWet );',
            'pnSandC = mix( pnSandC, uFoam, clamp( pnFoam, 0.0, 0.9 ) );',
            'float pnSandRough = mix( 0.95, 0.42, pnWet );',

            /* ---------------- asphalt + markings ---------------- */
            'float pnAgg = pnFbm( pnW * 6.5 ) * 0.22 + pnNoise( pnW * 26.0 ) * 0.1;',
            'vec3 pnRoadC = uAsphalt * ( 0.86 + pnAgg );',
            // wear paths where the tyres run, and a patched repair now and then
            'pnRoadC *= 1.0 + 0.11 * smoothstep( 1.4, 0.4, abs( abs( pnV ) - 2.6 ) );',
            'pnRoadC = mix( pnRoadC, pnRoadC * 0.78, smoothstep( 0.62, 0.78, pnFbm( pnW * 0.06 ) ) );',
            // double yellow centre line and white edge lines, worn by noise
            'float pnWear = 0.55 + 0.45 * pnFbm( vec2( pnS * 0.35, 0.0 ) );',
            'float pnCentre = smoothstep( 0.09, 0.05, abs( abs( pnV ) - 0.16 ) );',
            'float pnEdgeLine = smoothstep( 0.09, 0.05, abs( abs( pnV ) - 4.95 ) );',
            'pnRoadC = mix( pnRoadC, uLineY, pnCentre * pnWear );',
            'pnRoadC = mix( pnRoadC, uLineW, pnEdgeLine * pnWear * 0.9 );',
            'float pnRoadRough = mix( 0.86, 0.72, pnCentre + pnEdgeLine );',

            /* ---------------- gravel and scrub ---------------- */
            'float pnSpeck = pnNoise( pnW * 14.0 );',
            'vec3 pnGravC = mix( vec3( 0.62, 0.58, 0.5 ), vec3( 0.82, 0.78, 0.68 ), pnSpeck );',
            'pnGravC = mix( pnGravC, pnSandC * 0.95, 0.35 );',
            'vec3 pnScrubC = mix( vec3( 0.32, 0.4, 0.22 ), vec3( 0.5, 0.55, 0.33 ), pnFbm( pnW * 0.28 ) );',
            'pnScrubC = mix( pnScrubC, pnSandC * 0.8, smoothstep( 0.45, 0.0, pnFbm( pnW * 0.11 ) ) );',

            /* ---------------- blend by kind ---------------- */
            'vec3 pnCol = pnSandC;',
            'pnRough = pnSandRough;',
            'float wRoad = 1.0 - clamp( abs( pnKind - 1.0 ), 0.0, 1.0 );',
            'float wGrav = 1.0 - clamp( abs( pnKind - 2.0 ), 0.0, 1.0 );',
            'float wScrub = 1.0 - clamp( abs( pnKind - 3.0 ), 0.0, 1.0 );',
            'pnCol = mix( pnCol, pnRoadC, wRoad );',
            'pnRough = mix( pnRough, pnRoadRough, wRoad );',
            'pnCol = mix( pnCol, pnGravC, wGrav );',
            'pnRough = mix( pnRough, 0.9, wGrav );',
            'pnCol = mix( pnCol, pnScrubC, wScrub );',
            'pnRough = mix( pnRough, 0.88, wScrub );',
            // rain: the shared wetness drive darkens and polishes everything but
            // the already-wet sand
            'pnCol *= mix( 1.0, 0.55, uWetness * ( 1.0 - pnWet * 0.7 ) );',
            'pnRough = mix( pnRough, 0.12, uWetness * 0.8 * ( 1.0 - pnWet * 0.5 ) );',
            'diffuseColor.rgb *= pnCol;',
          ].join('\n'),
        )
        .replace(
          '#include <roughnessmap_fragment>',
          ['#include <roughnessmap_fragment>', 'roughnessFactor = pnRough;'].join('\n'),
        );
    };
    mat.customProgramCacheKey = () => 'loco/pinones-deck-v1';
    this.deckMat = mat;
    return mat;
  }

  /* --------------------------------------------------------------- props */

  /** Nearest station index to a world point, by brute force over the spine. */
  private nearestStation(x: number, z: number): Station {
    let best = this.stations[0];
    let bestD = Infinity;
    for (const st of this.stations) {
      const d = (st.x - x) ** 2 + (st.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return best;
  }

  /**
   * Height of the Piñones ground at a world point — the ribbon where it covers,
   * the district's own terrain everywhere else. Props, planting and the
   * projected layout handed to `Vegetation` all read this, so nothing in the
   * area can float or sink.
   */
  surfaceHeight(x: number, z: number): number {
    if (this.stations.length === 0) return this.layout?.groundHeight(x, z) ?? 0;
    const st = this.nearestStation(x, z);
    const dx = x - st.x;
    const dz = z - st.z;
    const v = dx * st.nx + dz * st.nz;
    const along = Math.abs(dx * st.tx + dz * st.tz);
    if (along > STEP * 1.6 || v < -36 || v > st.waterV + SURF_RUN) {
      return this.layout?.groundHeight(x, z) ?? 0;
    }
    return this.profile(st, v);
  }

  /** True where the ribbon owns the ground — the projected layout's zone test. */
  covers(x: number, z: number): boolean {
    if (this.stations.length === 0) return false;
    const st = this.nearestStation(x, z);
    const dx = x - st.x;
    const dz = z - st.z;
    const v = dx * st.nx + dz * st.nz;
    const along = Math.abs(dx * st.tx + dz * st.tz);
    return along <= STEP * 1.6 && v >= -36 && v <= st.waterV + SURF_RUN;
  }

  private stationAtS(s: number): Station {
    const i = clamp(Math.round(s / STEP), 0, this.stations.length - 1);
    return this.stations[i];
  }

  private buildProps(rng: RNG): void {
    const kit = this.kit;
    if (!kit || this.stations.length === 0) return;
    const density = (this.options.density ?? 1) * (this.quality === 'low' ? 0.5 : this.quality === 'medium' ? 0.78 : 1);
    const kb = makeBuilders();

    const umbrellas: Placement[] = [];
    const chairs: Placement[] = [];
    const tables: Placement[] = [];
    const barrels: Placement[] = [];
    const benches: Placement[] = [];
    const coolers: Placement[] = [];
    const bollards: Placement[] = [];
    const cars: Placement[] = [];
    const banners: Placement[] = [];
    const rocks: Placement[] = [];
    const thickets: Placement[] = [];
    const smoke: Placement[] = [];
    const bulbs: Placement[] = [];

    const total = this.stations[this.stations.length - 1].s;
    const put = (st: Station, v: number, out = new THREE.Vector3()): THREE.Vector3 =>
      out.set(st.x + st.nx * v, this.profile(st, v), st.z + st.nz * v);
    const p = new THREE.Vector3();

    const SHACK_SIGNS: SignKey[] = ['ancla', 'carmen', 'frituras', 'pinchos', 'coco', 'marAzul', 'mofongo', 'pescado'];
    const BOARDS: SignKey[] = ['cerveza', 'malta', 'refresco', 'mabi', 'empanadillas', 'piraguas', 'abierto', 'musica'];

    /* ---------------------------------------------------- 1. the clusters */
    const clusterAt = [92, 208, 322, 436, 560, 660];
    for (let ci = 0; ci < clusterAt.length; ci++) {
      const cs = clusterAt[ci];
      if (cs > total - 40) continue;
      const shackCount = Math.max(2, Math.round(rng.int(3, 5) * density));
      const inland = ci % 3 === 2; // one cluster in three sits across the road
      const side = inland ? -1 : 1;
      const anchors: THREE.Vector3[] = [];

      for (let k = 0; k < shackCount; k++) {
        const s = cs + (k - (shackCount - 1) * 0.5) * rng.range(6.2, 7.6);
        const st = this.stationAtS(s);
        if (!st) continue;
        const v = inland ? -rng.range(10.5, 13.5) : lerp(st.bermV, st.waterV, rng.range(0.02, 0.2));
        put(st, v, p);
        const facing = Math.atan2(-st.nx * side, -st.nz * side);
        const spec: ShackSpec = {
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: facing + rng.range(-0.16, 0.16),
          width: rng.range(3.1, 4.4),
          depth: rng.range(2.4, 3.2),
          height: rng.range(2.55, 2.95),
          wall: KIT.shackWall[(ci * 3 + k) % KIT.shackWall.length],
          trim: KIT.shackTrim[(k + ci) % KIT.shackTrim.length],
          sign: SHACK_SIGNS[(ci * 2 + k) % SHACK_SIGNS.length],
          board: BOARDS[(ci + k * 3) % BOARDS.length],
          flag: rng.bool(0.5),
          speaker: rng.bool(0.45),
          seed: rng.int(1, 0x7ffffff),
        };
        buildChinchorro(kb, spec);
        this._stats.shacks++;
        anchors.push(new THREE.Vector3(p.x, p.y + 2.9, p.z));

        // a fryer plume off every second shack
        if (k % 2 === 0) smoke.push({ x: p.x, y: p.y + 2.6, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.85, 1.3) });

        // stacked coolers and a banner beside the counter
        for (let c = 0; c < rng.int(1, 2); c++) {
          const cv = v - side * rng.range(1.6, 2.6);
          const cst = this.stationAtS(s + rng.range(-2, 2));
          put(cst, cv, p);
          coolers.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28) });
          if (rng.bool(0.4)) coolers.push({ x: p.x, y: p.y + 0.5, z: p.z, yaw: rng.range(0, 6.28), scale: 0.94 });
        }
        if (rng.bool(0.55)) {
          const bst = this.stationAtS(s + rng.range(-3, 3));
          put(bst, v - side * rng.range(3.2, 4.6), p);
          banners.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.9, 1.15) });
          // its pole is merged rather than instanced, so the banner card can flap
          kb.wood.cylinder(p.x, p.y, p.z, 0.055, 0.04, 3.3, 6, KIT.woodPale);
        }
      }

      /* --- the terrace in front: umbrellas, tables, chairs, benches --- */
      const terrace = Math.round(rng.int(3, 5) * density);
      for (let t = 0; t < terrace; t++) {
        const s = cs + rng.range(-18, 18);
        const st = this.stationAtS(s);
        if (!st) continue;
        const v = inland ? -rng.range(8.6, 10.2) : lerp(SHOULDER + 1.5, st.bermV, rng.range(0.25, 0.95));
        put(st, v, p);
        umbrellas.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.92, 1.12) });
        tables.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28) });
        const seats = rng.int(2, 4);
        for (let c = 0; c < seats; c++) {
          const a = (c / seats) * Math.PI * 2 + rng.range(-0.4, 0.4);
          const r = rng.range(0.72, 0.95);
          const cx = p.x + Math.cos(a) * r;
          const cz = p.z + Math.sin(a) * r;
          chairs.push({ x: cx, y: this.surfaceHeight(cx, cz), z: cz, yaw: -a + Math.PI * 0.5 + rng.range(-0.3, 0.3) });
        }
      }
      for (let t = 0; t < Math.round(2 * density); t++) {
        const st = this.stationAtS(cs + rng.range(-16, 16));
        if (!st) continue;
        put(st, inland ? -rng.range(8.4, 9.6) : lerp(SHOULDER + 1.2, st.bermV, rng.range(0.2, 0.8)), p);
        if (rng.bool(0.5)) barrels.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28) });
        else benches.push({ x: p.x, y: p.y, z: p.z, yaw: Math.atan2(st.tx, st.tz) + rng.range(-0.3, 0.3) });
      }

      /* --- festoon lights strung shack to shack --- */
      if (anchors.length >= 2) {
        for (let k = 0; k < anchors.length - 1; k++) {
          const a = anchors[k];
          const b = anchors[k + 1];
          const pts: THREE.Vector3[] = [];
          catenary(kb.wood, a, b, 0.55, KIT.steelDark, 0.02, 6, pts);
          for (let q = 1; q < pts.length - 1; q++) {
            bulbs.push({ x: pts[q].x, y: pts[q].y, z: pts[q].z, yaw: 0 });
          }
          if (rng.bool(0.5)) bunting(kb.cloth, pts, 0.3, [KIT.flagRed, KIT.flagWhite, KIT.flagBlue, 0xf2c230], rng.next());
        }
      }

      /* --- cars parked at an angle on the gravel --- */
      const parked = Math.round(rng.int(2, 4) * density);
      for (let k = 0; k < parked; k++) {
        const st = this.stationAtS(cs + rng.range(-26, 26));
        if (!st) continue;
        const v = inland ? -rng.range(8.2, 9.4) : rng.range(SHOULDER + 1.8, Math.max(SHOULDER + 2.2, st.bermV - 1.2));
        put(st, v, p);
        const along = Math.atan2(st.tx, st.tz);
        cars.push({
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: along + (rng.bool() ? 1 : -1) * rng.range(0.45, 0.75) * side,
          tint: KIT.carBody[rng.int(0, KIT.carBody.length - 1)],
        });
      }
    }

    /* ---------------------------------------------- 2. bollards and signs */
    for (let s = 26; s < total - 20; s += 4.2) {
      const st = this.stationAtS(s);
      if (!st) continue;
      let inGap = false;
      for (const [gs, gw] of BERM_GAPS) if (Math.abs(s - gs) < gw * 0.85) inGap = true;
      if (inGap) continue;
      put(st, SHOULDER + 0.55, p);
      bollards.push({ x: p.x, y: p.y, z: p.z, yaw: 0 });
      this._stats.bollards++;
    }
    // a road sign at the causeway mouth, and a PARE where the sand crosses
    {
      const st = this.stationAtS(30);
      put(st, -SHOULDER - 1.6, p);
      kb.wood.cylinder(p.x, p.y, p.z, 0.06, 0.055, 2.3, 6, KIT.steel);
      const dir = Math.atan2(-st.nx, -st.nz);
      signPanel(kb, p.x, p.y + 2.3, p.z, dir, 1.5, 0.7, 'pinones');
    }
    for (const [gs] of BERM_GAPS) {
      const st = this.stationAtS(gs);
      if (!st) continue;
      put(st, SHOULDER + 1.4, p);
      kb.wood.cylinder(p.x, p.y, p.z, 0.05, 0.045, 2.1, 6, KIT.steel);
      signPanel(kb, p.x, p.y + 2.1, p.z, Math.atan2(-st.tx, -st.tz), 0.62, 0.62, 'pare');
    }

    /* -------------------------------------------- 3. beach: umbrellas etc */
    const beachUmbrellas = Math.round(16 * density);
    for (let i = 0; i < beachUmbrellas; i++) {
      const st = this.stationAtS(rng.range(40, total - 40));
      if (!st) continue;
      const v = lerp(st.bermV + 2, st.waterV - 3, rng.range(0.1, 0.85));
      put(st, v, p);
      if (p.y < SEA_LEVEL + 0.45) continue;
      umbrellas.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.9, 1.15) });
      for (let c = 0; c < rng.int(1, 3); c++) {
        const a = rng.range(0, 6.28);
        const r = rng.range(0.9, 1.6);
        const cx = p.x + Math.cos(a) * r;
        const cz = p.z + Math.sin(a) * r;
        chairs.push({ x: cx, y: this.surfaceHeight(cx, cz), z: cz, yaw: rng.range(0, 6.28) });
      }
    }

    /* ------------------------------------------------ 4. rocks and scrub */
    const rockCount = Math.round(48 * density);
    for (let i = 0; i < rockCount; i++) {
      const st = this.stationAtS(rng.range(10, total - 10));
      if (!st) continue;
      const v = st.waterV + rng.range(-4, 14);
      put(st, v, p);
      if (p.y > SEA_LEVEL + 1.4) continue;
      rocks.push({
        x: p.x,
        y: p.y - rng.range(0.1, 0.7),
        z: p.z,
        yaw: rng.range(0, 6.28),
        scale: rng.range(0.55, 2.1),
        scaleY: rng.range(0.4, 1.0),
      });
    }
    const thicketCount = Math.round(150 * density);
    for (let i = 0; i < thicketCount; i++) {
      const st = this.stationAtS(rng.range(6, total - 6));
      if (!st) continue;
      const v = rng.bool(0.78) ? -rng.range(11, 33) : st.bermV + rng.range(-3, 3);
      put(st, v, p);
      if (p.y < SEA_LEVEL + 0.9) continue;
      thickets.push({ x: p.x, y: p.y - 0.1, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.75, 1.7) });
    }

    /* --------------------------------------------------- 5. realise them */
    const kitMats: Array<[GeoBuilder, THREE.Material, string, boolean]> = [
      [kb.wood, kit.wood, 'pinones/wood', false],
      [kb.zinc, kit.zinc, 'pinones/zinc', false],
      [kb.paint, kit.paint, 'pinones/paint', false],
      [kb.sign, kit.sign, 'pinones/sign', true],
      [kb.cloth, kit.cloth, 'pinones/cloth', true],
      [kb.glow, kit.glow, 'pinones/glow', false],
    ];
    for (const [builder, mat, name, aux] of kitMats) {
      const geo = builder.build(aux ? 'aWave' : 'aKit');
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.propGroup.add(mesh);
      this.geometries.push(geo);
      this.meshes.push(mesh);
      this._stats.propTriangles += (geo.getIndex()?.count ?? 0) / 3;
    }

    const addInstanced = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      list: Placement[],
      name: string,
      tinted = false,
    ): void => {
      const mesh = instanced(geo, mat, list, name, tinted);
      if (!mesh) {
        geo.dispose();
        return;
      }
      this.propGroup.add(mesh);
      this.geometries.push(geo);
      this.meshes.push(mesh);
      this._stats.propTriangles += triangleCount(geo) * list.length;
    };

    addInstanced(buildUmbrella(), kit.cloth, umbrellas, 'pinones/umbrellas');
    addInstanced(buildPlasticChair(), kit.paint, chairs, 'pinones/chairs');
    addInstanced(buildPlasticTable(), kit.paint, tables, 'pinones/tables');
    addInstanced(buildBarrelTable(), kit.paint, barrels, 'pinones/barrels');
    addInstanced(buildPicnicBench(), kit.wood, benches, 'pinones/benches');
    addInstanced(buildCooler(), kit.paint, coolers, 'pinones/coolers');
    addInstanced(buildBollard(), kit.paint, bollards, 'pinones/bollards');
    addInstanced(buildParkedCar(), kit.paint, cars, 'pinones/cars', true);
    addInstanced(buildBannerFlag('cerveza'), kit.sign, banners, 'pinones/banners');
    addInstanced(buildRock(rng.fork(0x0c)), kit.paint, rocks, 'pinones/rocks');
    addInstanced(buildThicket(rng.fork(0x1d)), kit.foliage, thickets, 'pinones/thickets');
    addInstanced(buildFestoonBulb(), kit.glow, bulbs, 'pinones/festoon');
    addInstanced(buildSmokePlume(rng.fork(0x2e)), kit.foliage, smoke, 'pinones/smoke');

    this._stats.umbrellas = umbrellas.length;
    this._stats.chairs = chairs.length;
    this._stats.cars = cars.length;
  }

  /* ------------------------------------------------------------ planting */

  /**
   * Hand `Vegetation` a projected layout — Piñones' own ground surface, and one
   * open area per stretch of coast — so the district's palm, sea grape and
   * bougainvillea implementation plants this beach too. Nothing about a palm is
   * re-implemented here.
   */
  private buildPlanting(layout: CityLayout, opts: WorldOpts): void {
    const areas: OpenArea[] = [];
    const total = this.stations[this.stations.length - 1]?.s ?? 0;
    const span = 58;
    let id = 0;
    for (let s = 8; s < total - span * 0.5; s += span) {
      const a = this.stationAtS(s);
      const b = this.stationAtS(Math.min(total, s + span));
      if (!a || !b) continue;
      // a strip behind the shacks and up the cut bank, plus a strip on the sand
      for (const [v0, v1] of [
        [-30, -9],
        [SHOULDER + 2, 0],
      ] as Array<[number, number]>) {
        const outer = v1 === 0 ? Math.min(a.waterV, b.waterV) - 3 : v1;
        const poly = [
          new THREE.Vector2(a.x + a.nx * v0, a.z + a.nz * v0),
          new THREE.Vector2(b.x + b.nx * v0, b.z + b.nz * v0),
          new THREE.Vector2(b.x + b.nx * outer, b.z + b.nz * outer),
          new THREE.Vector2(a.x + a.nx * outer, a.z + a.nz * outer),
        ];
        const cx = (poly[0].x + poly[2].x) * 0.5;
        const cz = (poly[0].y + poly[2].y) * 0.5;
        areas.push({
          id: id++,
          zone: 'waterfront' as DistrictZone,
          polygon: poly,
          center: new THREE.Vector3(cx, this.surfaceHeight(cx, cz), cz),
          surface: 'sand',
          drivable: true,
        });
      }
    }
    if (areas.length === 0) return;

    const empty: RoadGraph = {
      nodes: [],
      edges: [],
      sample: (_e, _t, _o, out = new THREE.Vector3()) => out.set(0, 0, 0),
      tangent: (_e, _t, out = new THREE.Vector3()) => out.set(0, 0, 1),
      nearest: () => null,
      path: () => [],
      nearestNode: () => -1,
    };

    const projected: CityLayout = {
      lots: [],
      blocks: [],
      areas,
      roads: empty,
      sidewalks: empty,
      pois: [] as POI[],
      bounds: layout.bounds,
      spawn: layout.spawn,
      // outside the ribbon the projection is deep water, which is what stops the
      // shared coast model from re-deriving (and re-planting) the city's own shore
      groundHeight: (x, z) => (this.covers(x, z) ? this.surfaceHeight(x, z) : -30),
      zoneAt: () => 'waterfront' as DistrictZone,
    };

    const veg = new Vegetation(this.quality, {
      density: 2.4 * (this.options.density ?? 1),
      wind: 1,
    });
    veg.build(projected, { ...opts, rng: opts.rng.fork(0x9e60) });
    this.plantGroup.add(veg.group);
    this.vegetation = veg;
    const s = veg.stats();
    this._stats.palms = s.vegPalms ?? 0;
    this._stats.propTriangles += s.vegTriangles ?? 0;
  }

  /* ------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number, timeOfDay: number): void {
    this.uniforms.uTime.value += dt;
    this.kit?.update(dt, nightFactor(timeOfDay));
    // Vegetation only sways; it does not read the clock.
    this.vegetation?.update?.(cameraPos, dt);

    // hard LOD: nothing here is worth a draw call from the far side of the city
    const first = this.stations[0];
    const last = this.stations[this.stations.length - 1];
    if (!first || !last) return;
    const near = Math.min(
      Math.hypot(cameraPos.x - first.x, cameraPos.z - first.z),
      Math.hypot(cameraPos.x - last.x, cameraPos.z - last.z),
      this.distanceToRoad(cameraPos),
    );
    const propCut = this.options.propDistance ?? QUALITY_BUDGET[this.quality].propDetailDistance * 2.4;
    this.propGroup.visible = near < propCut;
    this.plantGroup.visible = near < propCut * 2.1;
    this.deckGroup.visible = near < 1500;
  }

  private distanceToRoad(p: THREE.Vector3): number {
    let best = Infinity;
    for (let i = 0; i < this.stations.length; i += 4) {
      const st = this.stations[i];
      const d = (st.x - p.x) ** 2 + (st.z - p.z) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    this.vegetation?.onQualityChange?.(tier);
  }

  private countDrawCalls(): number {
    let n = this.deckGroup.children.length + this.propGroup.children.length;
    if (this.vegetation) n += this.vegetation.group.children.length;
    return n;
  }

  stats(): Record<string, number> {
    return {
      pinonesShacks: this._stats.shacks,
      pinonesUmbrellas: this._stats.umbrellas,
      pinonesChairs: this._stats.chairs,
      pinonesCars: this._stats.cars,
      pinonesBollards: this._stats.bollards,
      pinonesPalms: this._stats.palms,
      pinonesDeckTriangles: Math.round(this._stats.deckTriangles),
      pinonesPropTriangles: Math.round(this._stats.propTriangles),
      pinonesColliderTriangles: this._stats.colliderTriangles,
      pinonesDrawCalls: this._stats.drawCalls,
      pinonesLength: Math.round(this._stats.length),
    };
  }

  dispose(): void {
    if (this.physics) for (const b of this.bodies) this.physics.removeBody(b);
    this.bodies.length = 0;
    this.vegetation?.dispose();
    this.vegetation = null;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.meshes.length = 0;
    this.deckMat?.dispose();
    this.deckMat = null;
    this.kit?.release();
    this.kit = null;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ========================================================================== *
 *  helpers
 * ========================================================================== */

/** A double-sided sign panel on the atlas material, centred on a post top. */
function signPanel(
  kb: KitBuilders,
  x: number,
  y: number,
  z: number,
  yaw: number,
  w: number,
  h: number,
  key: SignKey,
): void {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const hw = w * 0.5;
  const at = (lx: number, ly: number): THREE.Vector3 =>
    new THREE.Vector3(x + lx * cs, y + ly, z - lx * sn);
  const r = signRectOf(key);
  const a = at(-hw, -h * 0.5);
  const b = at(hw, -h * 0.5);
  const c = at(hw, h * 0.5);
  const d = at(-hw, h * 0.5);
  quadUVLocal(kb, a, b, c, d, r);
  // plain back so the panel is not a one-sided decal
  kb.wood.quad(d.clone(), c.clone(), b.clone(), a.clone(), 0x9aa2a6, 0.6);
}

import { quadUV as kitQuadUV, signRect as kitSignRect, type UVRect } from './ShackKit';

function signRectOf(key: SignKey): UVRect {
  return kitSignRect(key);
}

function quadUVLocal(
  kb: KitBuilders,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  rect: UVRect,
): void {
  kitQuadUV(kb.sign, a, b, c, d, rect);
}
