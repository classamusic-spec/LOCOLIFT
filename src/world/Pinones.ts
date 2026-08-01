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
import { clamp, clamp01, lerp, smoothstep, smootherstep } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle, PhysicsWorldAPI } from '../physics/PhysicsTypes';
import { SEA_LEVEL } from './CityLayout';
import { GeoBuilder, SURFACE_GRIP, type SurfaceGrip, type SurfaceKind } from './Coast';
import type { MaterialLibrary } from './Materials';
import { Vegetation } from './Vegetation';
import {
  KIT,
  PropKit,
  puertoRicanFlag,
  buildBannerFlag,
  buildBarrelTable,
  buildBeachGrass,
  buildBloomBush,
  buildBollard,
  buildChinchorro,
  buildCooler,
  buildDrinkBoard,
  buildFernClump,
  buildFestoonBulb,
  buildParkedCar,
  buildPicnicBench,
  buildPlasticChair,
  buildPlasticTable,
  buildRock,
  buildSeaGrape,
  buildSmokePlume,
  buildSpeakerStack,
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
import {
  PinonesLife,
  faceYaw,
  queueAnchors,
  ringAnchors,
  type CrowdAnchor,
  type PinonesSite,
} from './PinonesLife';
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

/**
 * Inland cut shelf. The mainland behind Piñones climbs to a 42 m plateau at
 * roughly 1 : 2.5, which would put a green wall on the driver's shoulder and
 * leave nowhere for the inland chinchorros to stand. So the layer cuts a
 * near-level bench out of the hillside, `CUT_V` metres from the centreline,
 * and blends onto the natural slope over `CUT_BLEND`. That bench is the gravel
 * parking, the inland shack row and the dune scrub.
 */
const CUT_V = 13;
const CUT_BLEND = 25;
/** Outermost column of the inland apron — past this the base terrain resumes. */
const BLUFF_V = -152;

/**
 * Where the mainland ends and the barrier spit begins. East of this the road
 * runs on a true sand spit: Atlantic on the seaward side, the shallow mangrove
 * lagoon on the inland side — which is both the real geography of PR-187 and
 * the only honest thing to draw, because the district's own terrain mesh stops
 * at x = 720 and there is open sea under everything past it.
 */
const SPIT_X0 = 690;
const SPIT_X1 = 806;
/** Lagoon: where its shore sits, how deep its floor goes. */
const LAGOON_SHORE = -44;
const LAGOON_FLOOR = -2.6;
const LAGOON_BED = -104;
/** Depth of water the beach's waterline aims for — this is what keeps the surf
 *  over the turquoise part of the ocean's bathymetry rather than the deep blue. */
const WATER_TARGET = -1.2;
/** How far the submerged sand shelf runs past the waterline. */
const SURF_RUN = 20;
/** Deepest point of that shelf. */
const SHELF_DEPTH = -3.4;

/** Road crests — free air at speed. `[station metres, height, width]`. */
const HUMPS: ReadonlyArray<readonly [number, number, number]> = [
  [150, 2.1, 19],
  [354, 1.6, 16],
  [562, 2.35, 22],
  [712, 1.75, 17],
];

/** Berm gaps: the sand is open to the road here. `[station, half-width]`. */
const BERM_GAPS: ReadonlyArray<readonly [number, number]> = [
  [96, 13],
  [232, 11],
  [398, 14],
  [536, 12],
  [648, 16],
];

/**
 * Seaward launch ramps. A wedge of packed sand and old boardwalk timber that
 * leaves the gravel shoulder in a berm gap, runs down-coast while drifting out
 * over the beach, and ends in a hard lip with nothing under it. Flick seaward
 * at speed and Piñones throws you at the Atlantic.
 *
 * `[station, run length, lip height, seaward drift, half-width at the lip]`.
 */
interface RampSpec {
  s: number;
  len: number;
  height: number;
  drift: number;
  halfW: number;
}
const RAMPS: readonly RampSpec[] = [
  { s: 88, len: 15, height: 3.0, drift: 4.0, halfW: 2.7 },
  { s: 226, len: 13, height: 2.5, drift: 3.2, halfW: 2.8 },
  { s: 390, len: 16, height: 3.3, drift: 4.6, halfW: 2.6 },
  { s: 530, len: 14, height: 2.8, drift: 3.6, halfW: 2.7 },
  { s: 640, len: 17, height: 3.6, drift: 5.0, halfW: 2.6 },
];

/**
 * Station of each chinchorro cluster — also where the gravel apron widens.
 *
 * Eight of them over ~740 m, so the strip reads as a *place* rather than six
 * lonely kiosks: roughly 85 m of open coast between clusters, which at 45 m/s
 * is under two seconds of quiet before the next wall of colour, music and
 * people. The spacing is deliberately uneven — a real chinchorro strip grew,
 * it was not laid out.
 */
const CLUSTERS: readonly number[] = [88, 168, 244, 322, 402, 486, 572, 660];

/** Sand kickers at the tideline. `[station, lateral fraction of the beach]`. */
const KICKERS: ReadonlyArray<readonly [number, number]> = [
  [188, 0.62],
  [468, 0.55],
  [604, 0.6],
];

/**
 * Surface families, **ordered across the cross-section**: asphalt at the
 * centreline, then gravel, sand, dune scrub, and forest floor as you walk
 * inland (and back down again as you walk seaward). The order is load-bearing.
 * The channel is interpolated across every quad, so a strip whose two ends are
 * two families apart renders as the family in between — put sand next to
 * asphalt and the verge grows a phantom lane of tarmac. Adjacent columns must
 * never be more than one step apart. 5 is off the axis: the launch ramps.
 */
const enum Surface {
  Asphalt = 0,
  Gravel = 1,
  Sand = 2,
  Scrub = 3,
  Forest = 4,
  Ramp = 5,
}
type SurfaceCode = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Collider friction classes. These are an *authoring* vocabulary — the beach
 * road has a gravel apron and packed-marl kickers, neither of which the
 * vehicle's four-way {@link SurfaceKind} enum names — and every one of them
 * resolves to a real `SurfaceKind` through {@link GRIP_KIND} before it reaches
 * physics or the grip query. Nothing downstream ever sees a class the tyre
 * model cannot price.
 */
type GripClass = 'asphalt' | 'gravel' | 'sand' | 'ramp';

/**
 * Authoring class → the surface the tyre model understands.
 *
 * `gravel` maps to `grass` rather than `sand`: a packed shell-and-marl parking
 * apron is firm enough to hold a line (lateral 0.8) but still scrubs speed
 * (drag 0.09), which is exactly the half-step between tarmac and beach that
 * makes swinging onto the apron in front of a chinchorro feel deliberate.
 * `ramp` maps to `asphalt` because a kicker you cannot predict is not a jump,
 * it is a lottery — the launch has to be repeatable at any entry speed.
 */
const GRIP_KIND: Record<GripClass, SurfaceKind> = {
  asphalt: 'asphalt',
  gravel: 'grass',
  sand: 'sand',
  ramp: 'asphalt',
};

interface Column {
  /** 'abs' = fixed lateral offset; 'beach' / 'surf' = fraction of the run */
  mode: 'abs' | 'beach' | 'surf';
  v: number;
  kind: SurfaceCode;
  /** include in the drivable collider */
  solid: boolean;
  /** collider surface class — decides the friction body this strip joins */
  grip?: GripClass;
}

/**
 * The cross-section, inland (negative) to seaward (positive).
 *
 * Inland of the carriageway the ribbon owns a **cut bench** — gravel apron,
 * shack row, dune scrub — and then climbs the mainland bluff (or falls into
 * the lagoon, east of the spit line) all the way out to {@link BLUFF_V}. That
 * is what stops the raw district terrain from ever being the thing the driver
 * looks at. Seaward it is all new sand.
 */
const COLUMNS: readonly Column[] = [
  { mode: 'abs', v: BLUFF_V, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -130, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -111, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -94, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -79, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -66, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -55, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -46, kind: Surface.Forest, solid: false },
  { mode: 'abs', v: -38, kind: Surface.Forest, solid: false },
  // the vegetated cut bench is dune scrub, not loose sand — it holds a line
  { mode: 'abs', v: -31, kind: Surface.Forest, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -25, kind: Surface.Scrub, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -20, kind: Surface.Scrub, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -16, kind: Surface.Scrub, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -13, kind: Surface.Scrub, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -10.8, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'abs', v: -9.4, kind: Surface.Gravel, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -8, kind: Surface.Gravel, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -6.7, kind: Surface.Gravel, solid: true, grip: 'gravel' },
  { mode: 'abs', v: -5.6, kind: Surface.Asphalt, solid: true, grip: 'asphalt' },
  { mode: 'abs', v: -2.8, kind: Surface.Asphalt, solid: true, grip: 'asphalt' },
  { mode: 'abs', v: 0, kind: Surface.Asphalt, solid: true, grip: 'asphalt' },
  { mode: 'abs', v: 2.8, kind: Surface.Asphalt, solid: true, grip: 'asphalt' },
  { mode: 'abs', v: 5.6, kind: Surface.Asphalt, solid: true, grip: 'asphalt' },
  { mode: 'abs', v: 6.7, kind: Surface.Gravel, solid: true, grip: 'gravel' },
  { mode: 'abs', v: 8.6, kind: Surface.Gravel, solid: true, grip: 'gravel' },
  { mode: 'beach', v: 0.0, kind: Surface.Gravel, solid: true, grip: 'sand' },
  { mode: 'beach', v: 0.18, kind: Surface.Gravel, solid: true, grip: 'sand' },
  { mode: 'beach', v: 0.34, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'beach', v: 0.46, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'beach', v: 0.58, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'beach', v: 0.72, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'beach', v: 0.86, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'beach', v: 1.0, kind: Surface.Sand, solid: true, grip: 'sand' },
  { mode: 'surf', v: 0.3, kind: Surface.Sand, solid: false },
  { mode: 'surf', v: 0.65, kind: Surface.Sand, solid: false },
  { mode: 'surf', v: 1.0, kind: Surface.Sand, solid: false },
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
/**
 * Hash on a **wrapped integer lattice**.
 *
 * The obvious "fract( p * 233.34 )" hash is fine at the city origin and
 * catastrophic here. Piñones runs from x = 357 to x = 1078, so the fine
 * detail bands evaluate the hash at |p| ~ 10^4; multiplying that by 233 puts
 * the product at ~4e6, where a float32 mantissa has an ulp of 0.5 — so
 * fract() collapsed to **two** distinct values and 1600 lattice cells yielded
 * three distinct hashes instead of ~1400. That degenerate lattice was the
 * woven cross-hatch that read as parallel streaks across the whole beach.
 *
 * The fix is two-part and both halves are load-bearing: the lattice index is
 * wrapped into 0..288 so the hash only ever sees small exact integers, and
 * the mixing itself keeps every intermediate well inside the mantissa. The
 * 289-cell period is a ~11 m repeat at the highest frequency used here, on a
 * ±0.07 modulation — below the noise floor of the surfaces it perturbs.
 */
float pnHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.x, p.y, p.x ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float pnNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  i = mod( i, 289.0 );
  vec2 i1 = mod( i + vec2( 1.0, 0.0 ), 289.0 );
  vec2 i2 = mod( i + vec2( 0.0, 1.0 ), 289.0 );
  vec2 i3 = mod( i + vec2( 1.0, 1.0 ), 289.0 );
  float a = pnHash( i );
  float b = pnHash( vec2( i1.x, i.y ) );
  float c = pnHash( vec2( i.x, i2.y ) );
  float d = pnHash( i3 );
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

  /**
   * Wind CCW seen from **above**, matching `Ground`'s convention.
   *
   * The caller hands corners in ribbon order — `a` and `b` one station apart
   * along the road, `c`/`d` one column further seaward. Since the seaward
   * normal is `(-tz, tx)`, the 3D cross `tangent × seaward` points **down**;
   * emitting `(a, b, c)` in station-then-column order therefore produced a
   * clockwise, downward-facing triangle and every square metre of this layer
   * was back-face culled from the driver's eye. Walking the column axis first
   * flips it the right way up.
   */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, d, c, a, c, b);
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
  /** 0 on the mainland, 1 out on the barrier spit with the lagoon behind */
  lagoon: number;
  /** height of the inland cut bench at this station */
  benchY: number;
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

  /** people, from the shared `PedestrianModel` fleets */
  private lifeGroup = new THREE.Group();

  private quality: QualityTier;
  private options: PinonesOptions;
  private kit: PropKit | null = null;
  private vegetation: Vegetation | null = null;
  private life: PinonesLife | null = null;
  /** where a person can plausibly stand, derived from the props as they land */
  private crowdAnchors: CrowdAnchor[] = [];

  private stations: Station[] = [];
  private layout: CityLayout | null = null;
  private physics: PhysicsWorldAPI | null = null;
  private bodies: BodyHandle[] = [];

  private geometries: THREE.BufferGeometry[] = [];
  private meshes: THREE.Object3D[] = [];
  private deckMat: THREE.MeshStandardMaterial | null = null;

  /** Running-surface footprint of each launch ramp, for {@link surfaceAt}. */
  private rampFrames: Array<{
    ox: number;
    oz: number;
    ux: number;
    uz: number;
    len: number;
    halfW: number;
  }> = [];

  private uniforms: DeckUniforms = {
    uTime: { value: 0 },
    uSeaLevel: { value: SEA_LEVEL },
    uWetness: { value: 0 },
    uSand: { value: new THREE.Color().setHex(0xd8b57e, THREE.SRGBColorSpace) },
    uSandWet: { value: new THREE.Color().setHex(0x7a6443, THREE.SRGBColorSpace) },
    uFoam: { value: new THREE.Color().setHex(0xf6fbfa, THREE.SRGBColorSpace) },
    uAsphalt: { value: new THREE.Color().setHex(0x45443f, THREE.SRGBColorSpace) },
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
    this.lifeGroup.name = 'pinones/life';
    this.group.add(this.deckGroup, this.propGroup, this.plantGroup, this.lifeGroup);
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
    this.buildLife(opts.rng.fork(0x71fe));

    this._stats.drawCalls = this.countDrawCalls();
  }

  /**
   * Hand the crowd the strip's geometry and the anchor list the props just
   * generated. Nothing about a pedestrian is re-implemented here — see
   * `PinonesLife`'s header for why the traffic layer's kit drops straight in.
   */
  private buildLife(rng: RNG): void {
    if (this.crowdAnchors.length === 0) return;
    const site: PinonesSite = {
      height: (x, z) => this.surfaceHeight(x, z),
      at: (s, v, out) => {
        const st = this.stationAtS(s);
        out.set(st.x + st.nx * v, this.profile(st, v), st.z + st.nz * v);
        // the rig faces −Z at yaw 0, so hand back a heading in that convention
        return faceYaw(st.tx, st.tz);
      },
      length: this.stations[this.stations.length - 1]?.s ?? 0,
    };
    const life = new PinonesLife(this.quality, {
      density: this.options.density ?? 1,
      cullDistance: this.options.propDistance ?? QUALITY_BUDGET[this.quality].propDetailDistance * 2.4,
    });
    life.build(site, this.crowdAnchors, rng);
    this.lifeGroup.add(life.group);
    this.life = life;
    // the list has done its job; it is pure bookkeeping and can be large
    this.crowdAnchors.length = 0;
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
      stations.push({
        x, z, tx, tz, nx, nz, s,
        y: 0,
        waterV: 20,
        bermV: 12,
        bermH: 0.5,
        lagoon: smootherstep((x - SPIT_X0) / (SPIT_X1 - SPIT_X0)),
        benchY: 0,
      });
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

    /* --- the inland cut bench: a level shelf carved out of the bluff ------- */
    // It sits a touch below the carriageway so water sheds off the road onto
    // it, and never below the natural ground at the road edge.
    const bench: number[] = stations.map((st) => st.y - 0.42 - 0.18 * Math.sin(st.s * 0.017));
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < bench.length - 1; i++) {
        bench[i] = bench[i - 1] * 0.26 + bench[i] * 0.48 + bench[i + 1] * 0.26;
      }
    }
    for (let i = 0; i < stations.length; i++) stations[i].benchY = bench[i];

    this.stations = stations;
  }

  /** Lateral offset of a cross-section column at a station. */
  private columnV(st: Station, c: Column): number {
    if (c.mode === 'abs') return c.v;
    if (c.mode === 'beach') return lerp(st.bermV, st.waterV, c.v);
    return st.waterV + SURF_RUN * c.v;
  }

  /**
   * Surface height of the ribbon at a station and lateral offset.
   *
   * Three regimes meet here and every one of them has to be C0-continuous with
   * its neighbours, because the same function drives the mesh, the analytic
   * normals, the collider and every prop's footing:
   *
   *  - **carriageway** `|v| ≤ HALF_ROAD` — flat with a 2 % crown.
   *  - **inland** — shoulder, gravel apron, then the level cut bench, then
   *    either the mainland bluff (west) or the lagoon shelf (east of the spit
   *    line), cross-faded by `st.lagoon`.
   *  - **seaward** — apron, berm, beach face, wet run-up, submerged shelf,
   *    plus the launch ramps and tideline kickers cut straight into it.
   */
  private profile(st: Station, v: number): number {
    const gh = this.layout ? this.layout.groundHeight : (): number => 0;
    const x = st.x + st.nx * v;
    const z = st.z + st.nz * v;
    const ground = gh(x, z);
    let y: number;
    // how much of the "never below the district's own terrain" clamp applies —
    // out on the spit the terrain is a phantom 42 m plateau with no mesh under
    // it, so honouring it there would build a green wall over open sea
    let clampW = 1;

    if (v >= -HALF_ROAD && v <= HALF_ROAD) {
      // 2 % crown, §1.1
      y = st.y - 0.09 * (v / HALF_ROAD) ** 2;
    } else if (v < -HALF_ROAD) {
      const d = -v - HALF_ROAD;
      const shoulder = st.y - 0.12;
      if (d < 1.9) {
        y = shoulder - d * 0.075;
      } else {
        // gravel apron rolls off the shoulder onto the cut bench
        const tb = smootherstep((d - 1.9) / 4.6);
        const benchY = lerp(shoulder - 0.14, st.benchY, tb);
        const bench = benchY;

        /* mainland: blend the bench onto the natural hillside */
        const tBank = smootherstep((-v - CUT_V) / CUT_BLEND);
        const bluff = lerp(bench, Math.max(bench, ground + 0.55), tBank);

        /* spit: the bench falls to a mangrove shore and a lagoon floor */
        const dune = bench + 1.35 * Math.exp(-(((-v - 27) / 9) ** 2));
        const lag = lerp(
          dune,
          SEA_LEVEL + LAGOON_FLOOR,
          smootherstep((-v + LAGOON_SHORE) / (-LAGOON_BED + LAGOON_SHORE)),
        );

        y = lerp(bluff, lag, st.lagoon);
        clampW = 1 - st.lagoon;
        // a dry-season crust on the bench, fine enough not to draw contour lines
        y += Math.sin(st.s * 1.9 + v * 2.7) * 0.012 * smoothstep((d - 2.5) / 3);
        /* the far edge dives under the district's own terrain, so the boundary
           between this layer's ground and the world's is a ragged intersection
           line lost in the canopy rather than a straight 60 cm lip */
        const dive = smootherstep((-v + BLUFF_V + 26) / 22);
        y -= dive * 3.2 * (1 - st.lagoon);
        clampW *= 1 - dive;
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
      // wind ripple on the loose sand — small, but it is what stops the beach
      // reading as a bedsheet and what makes a shoulder excursion chatter
      y += Math.sin(v * 0.62 + st.s * 0.11) * 0.055 * smoothstep((v - SHOULDER) / 3);

      // sand kickers: a wedge of packed sand at the tideline, lip to the sea
      for (const [ks, kf] of KICKERS) {
        const kv = lerp(st.bermV, st.waterV, kf);
        const ds = (st.s - ks) / 11;
        const dv = (v - kv) / 7;
        const bump = Math.exp(-(ds * ds) - dv * dv);
        y += bump * 2.6 * clamp01(1.35 - Math.abs(ds) * 0.9);
      }
    }
    // never below the world's own ground: the existing terrain collider and mesh
    // stay honest under everything this layer draws — except out on the spit,
    // where there is no terrain mesh to stay honest with
    return lerp(y, Math.max(y, ground + 0.04), clampW);
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

    /**
     * Per-vertex tint. The shader owns grain, ripple and wetness; the vertex
     * colour owns the *large* structure — how the dune scrub greens up as it
     * leaves the sand, how the bluff forest darkens as it climbs away from the
     * light, and how the lagoon shore bleaches back to mud.
     */
    const c1 = new THREE.Color();
    const c2 = new THREE.Color();
    const kindColour = (kind: number, v: number, st: Station): number => {
      // Only the bluff forest needs a vertex tint; sand, asphalt, gravel and
      // dune scrub are absolute colours in the shader, so they ride on white
      // and no half-step between families can band.
      if (kind < 3.5) return 0xffffff;
      // saturated tropical green deepening as it climbs out of the light,
      // cross-fading to lagoon silt out on the spit
      const climb = clamp01((this.profileHeightCache - st.y) / 22);
      c1.setHex(0x6d9a34, THREE.SRGBColorSpace);
      c2.setHex(0x255a24, THREE.SRGBColorSpace);
      c1.lerp(c2, smoothstep(climb));
      if (st.lagoon > 0.01) {
        const wet = clamp01((SEA_LEVEL + 1.6 - this.profileHeightCache) / 3.2);
        c2.setHex(0x8a8560, THREE.SRGBColorSpace);
        c1.lerp(c2, st.lagoon * wet);
      }
      // hand off to the district's own terrain tone at the far edge, so the
      // boundary between this layer's ground and the world's never reads
      c2.setHex(0x93a878, THREE.SRGBColorSpace);
      c1.lerp(c2, smoothstep((-v - 96) / 44) * (1 - st.lagoon));
      return c1.getHex(THREE.SRGBColorSpace);
    };

    /**
     * The gravel apron is not a kerb-to-kerb ribbon of dust for 700 m — it is a
     * parking bay in front of each cluster and nothing in between, where the
     * dune scrub comes right up to the white line. That intermittency is what
     * stops the inland verge reading as a desert hard shoulder.
     */
    const apron = (s: number): number => {
      let a = 0;
      for (const cs of CLUSTERS) a = Math.max(a, Math.exp(-(((s - cs) / 30) ** 2)));
      for (const r of RAMPS) a = Math.max(a, Math.exp(-(((s - r.s + 6) / 20) ** 2)) * 0.85);
      return a;
    };
    // fractional kinds are legal — the shader blends the surface families, and
    // only kind 4 carries a vertex tint, so nothing bands at the half-step
    const kindOf = (col: Column, st: Station): number => {
      if (col.v >= 0 || col.mode !== 'abs') return col.kind;
      if (col.kind !== Surface.Gravel && col.kind !== Surface.Sand) return col.kind;
      return lerp(Surface.Scrub, col.kind, apron(st.s));
    };

    /** collider strips, one array pair per friction class */
    const grip: Record<GripClass, { pos: number[]; idx: number[] }> = {
      asphalt: { pos: [], idx: [] },
      gravel: { pos: [], idx: [] },
      sand: { pos: [], idx: [] },
      ramp: { pos: [], idx: [] },
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
              kindColour(kindOf(col, st), v, st),
              v,
              kindOf(col, st),
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
        const bucket = grip[stripGrip(ca, cb)];
        pushTri(bucket.pos, bucket.idx, pa, pb, pc);
        pushTri(bucket.pos, bucket.idx, pa, pc, pd);
      }
    }

    this.buildRamps(grip.ramp);

    /**
     * One static trimesh per friction class, all in `GROUP.WORLD`.
     *
     * The body carries **both** channels a consumer might reach for: `surface`
     * is the descriptive authoring class, matching how `Ground` and `Coast`
     * already tag theirs, and `grip` is the typed {@link SurfaceKind} the tyre
     * model can price directly with `SURFACE_GRIP[ud.grip]`. Rapier's own
     * friction is derived from the same table rather than hand-tuned twice, so
     * the collider and the grip query can never drift apart.
     */
    const makeBody = (cls: GripClass): void => {
      const { pos, idx } = grip[cls];
      if (idx.length === 0) return;
      const kind = GRIP_KIND[cls];
      const body = opts.physics.createBody({
        kind: 'static',
        shape: { type: 'trimesh', vertices: new Float32Array(pos), indices: new Uint32Array(idx) },
        position: new THREE.Vector3(0, 0, 0),
        friction: 0.55 + 0.45 * SURFACE_GRIP[kind].longitudinal,
        restitution: 0.02,
        group: GROUP.WORLD,
        mask: GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS | GROUP.TRIGGER,
        userData: { kind: 'world', surface: cls, grip: kind },
      });
      this.bodies.push(body);
      this._stats.colliderTriangles += idx.length / 3;
    };
    makeBody('asphalt');
    makeBody('gravel');
    makeBody('sand');
    makeBody('ramp');
  }

  /**
   * The five launch ramps, as real swept geometry rather than a bump in the
   * height field — the ribbon's columns are 1.5–4 m apart out on the sand and
   * would smear a kicker's lip into a hill. Built on the deck material and its
   * `aBeach` channel so they take the same sand shading, and appended to the
   * loose-surface collider so the picture and the physics agree.
   */
  private buildRamps(collide: { pos: number[]; idx: number[] }): void {
    if (this.stations.length < 4) return;
    const db = new DeckBuilder();
    const SEG = 12;
    const PACKED = 0xb59d70;
    const LOOSE = 0xe4d7bf;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    const pushTri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3): void => {
      const base = collide.pos.length / 3;
      collide.pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      collide.idx.push(base, base + 1, base + 2);
    };

    for (const r of RAMPS) {
      const st0 = this.stationAtS(r.s);
      if (!st0) continue;
      const v0 = SHOULDER + 0.4;
      const ox = st0.x + st0.nx * v0;
      const oz = st0.z + st0.nz * v0;
      const entryY = this.profile(st0, v0);
      // travel direction: down-coast, drifting seaward, so it is a flick right
      const dirX = st0.tx * r.len + st0.nx * r.drift;
      const dirZ = st0.tz * r.len + st0.nz * r.drift;
      const dl = Math.hypot(dirX, dirZ) || 1;
      const ux = dirX / dl;
      const uz = dirZ / dl;
      const px = -uz;
      const pz = ux;
      this.rampFrames.push({ ox, oz, ux, uz, len: dl, halfW: 3.9 });
      /** centreline height: low at the mouth, ~16° at the lip */
      const riseAt = (t: number): number => r.height * Math.pow(t, 1.35);
      const halfAt = (t: number): number => lerp(3.9, r.halfW, t);
      /** running surface point, `side` = -1 | +1 across the ramp */
      const face = (t: number, side: number, out: THREE.Vector3): THREE.Vector3 => {
        const hw = halfAt(t);
        return out.set(
          ox + ux * dl * t + px * hw * side,
          entryY + riseAt(t) - 0.11,
          oz + uz * dl * t + pz * hw * side,
        );
      };

      // three vertex rings per station: outer skirt, running edge, running edge, outer skirt
      const rows: Array<[number, number, number, number]> = [];
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const hw = halfAt(t);
        const along = (t * dl) / 6;
        const aux = 0;
        const ring: number[] = [];
        for (const [side, out, packed] of [
          [-1, 0.9, false],
          [-1, 0, true],
          [1, 0, true],
          [1, 0.9, false],
        ] as Array<[number, number, boolean]>) {
          const wx = ox + ux * dl * t + px * (hw + out) * side;
          const wz = oz + uz * dl * t + pz * (hw + out) * side;
          const y = packed
            ? entryY + riseAt(t) - 0.11
            : Math.min(this.surfaceHeight(wx, wz), entryY + riseAt(t) - 0.35) - 0.05;
          ring.push(
            db.vertex(
              wx, y, wz,
              0, 1, 0,
              along, ((hw + out) * side) / 6,
              packed ? PACKED : LOOSE,
              (hw + out) * side, packed ? Surface.Ramp : Surface.Sand, t * 10,
            ),
          );
          void aux;
        }
        rows.push([ring[0], ring[1], ring[2], ring[3]]);
      }

      for (let i = 0; i < SEG; i++) {
        const q0 = rows[i];
        const q1 = rows[i + 1];
        // wound CCW seen from above, same convention as the deck
        for (let k = 0; k < 3; k++) db.quad(q0[k], q1[k], q1[k + 1], q0[k + 1]);

        const t0 = i / SEG;
        const t1 = (i + 1) / SEG;
        face(t0, -1, a);
        face(t0, 1, b);
        face(t1, 1, c);
        face(t1, -1, d);
        pushTri(a, b, c);
        pushTri(a, c, d);
      }

      /* the lip: a hard vertical face with nothing under it */
      const hw = halfAt(1);
      const lipY = entryY + riseAt(1) - 0.11;
      const lip: number[] = [];
      const foot: number[] = [];
      for (const side of [-1, 1]) {
        const wx = ox + ux * dl + px * hw * side;
        const wz = oz + uz * dl + pz * hw * side;
        const aux = 0;
        lip.push(db.vertex(wx, lipY, wz, ux, 0, uz, dl / 6, (hw * side) / 6, PACKED, hw * side, Surface.Ramp, 10));
        foot.push(
          db.vertex(
            wx, Math.min(this.surfaceHeight(wx, wz), lipY) - 0.35, wz,
            ux, 0, uz,
            dl / 6 + 0.4, (hw * side) / 6,
            0x8d7a58, hw * side, Surface.Ramp, 10.6,
          ),
        );
        void aux;
      }
      db.quad(lip[0], foot[0], foot[1], lip[1]);
    }

    const geo = db.build();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, this.deckMaterial());
    mesh.name = 'pinones/ramps';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.deckGroup.add(mesh);
    this.geometries.push(geo);
    this.meshes.push(mesh);
    this._stats.deckTriangles += (geo.getIndex()?.count ?? 0) / 3;
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
          [
            '#include <common>',
            'attribute vec3 aBeach;',
            'varying vec3 vBeach;',
            'varying vec3 vWorldPos;',
            'varying float vNormalUpPn;',
          ].join('\n'),
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vBeach = aBeach;',
            'vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
            'vNormalUpPn = normalize( mat3( modelMatrix ) * normal ).y;',
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
            'varying float vNormalUpPn;',
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
            // recentred on the middle of the ribbon: every noise band below is a
            // function of pnW, and halving the magnitude of the coordinate that
            // feeds them keeps the interpolation fraction well-resolved out at
            // the east end of the spit (see pnHash for the full story)
            'vec2 pnW = vWorldPos.xz - vec2( 690.0, 300.0 );',
            'vec3 pnTint = vColor.rgb;',
            'float pnRough = 0.92;',

            /* ---------------- sand ---------------- */
            'float pnGrain = pnFbm( pnW * 3.2 ) * 0.16 + pnNoise( pnW * 11.0 ) * 0.07;',
            'float pnDrift = pnFbm( pnW * 0.055 );',
            // Both ends of the drift stay WARM. The old low end was
            // ( 0.76, 0.82, 0.97 ) — a blue-white — so wherever the drift noise
            // dipped, Piñones sand went cool grey and the whole beach read
            // washed out under a midday key. Caribbean sand shifts warm-to-warm:
            // pale shell at the top end, damp ochre at the bottom.
            'vec3 pnSandC = uSand * mix( vec3( 0.86, 0.83, 0.74 ), vec3( 1.18, 1.09, 0.90 ), pnDrift );',
            'float pnRip = sin( ( pnV - vBeach.z * 0.02 ) * 1.5 + pnFbm( pnW * 0.3 ) * 7.0 ) * 0.5 + 0.5;',
            'pnSandC *= 1.0 + ( pnGrain - 0.11 ) * 1.15 + pnRip * 0.07;',
            // wind-combed ridges running up the beach, the coarse scale that stops
            // 40 m of dry sand reading as one flat card
            'pnSandC *= 1.0 + 0.11 * sin( dot( pnW, vec2( 0.22, 0.09 ) ) + pnFbm( pnW * 0.13 ) * 9.0 );',
            // shell hash and dark mineral sand along the old high-tide line
            // (named for what it is — a local called `pnHash` here would shadow
            // the hash function and is a trap for the next edit)
            'float pnShellBand = smoothstep( 1.6, 0.5, vWorldPos.y - uSeaLevel ) * smoothstep( 0.1, 0.6, vWorldPos.y - uSeaLevel );',
            'pnSandC = mix( pnSandC, pnSandC * vec3( 0.72, 0.68, 0.64 ), pnShellBand * smoothstep( 0.45, 0.8, pnFbm( pnW * 0.42 + 11.0 ) ) * 0.7 );',
            // wrack line: a broken ribbon of dried sargassum at the spring-tide mark
            'float pnWrackBand = smoothstep( 0.55, 0.0, abs( vWorldPos.y - uSeaLevel - 1.05 ) );',
            'float pnWrack = pnWrackBand * smoothstep( 0.5, 0.78, pnFbm( pnW * vec2( 0.7, 0.16 ) + 23.0 ) );',
            'pnSandC = mix( pnSandC, vec3( 0.29, 0.24, 0.13 ), clamp( pnWrack, 0.0, 0.75 ) );',
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

            /* ---------------- gravel apron ---------------- */
            'float pnSpeck = pnNoise( pnW * 14.0 );',
            'vec3 pnGravC = mix( vec3( 0.44, 0.4, 0.33 ), vec3( 0.68, 0.62, 0.51 ), pnSpeck );',
            'pnGravC = mix( pnGravC, pnSandC * 0.95, 0.35 );',
            // tyre-polished ruts where every car swings off the road onto the apron
            'pnGravC *= 1.0 - 0.14 * smoothstep( 0.58, 0.86, pnFbm( pnW * vec2( 0.5, 0.09 ) ) );',

            /* ---------------- dune scrub ---------------- */
            // clumped sea-oat / bay-bean cover: bare sand between tussocks, not a lawn
            // cover is gated by how far from the carriageway the scrub sits, not
            // by an absolute offset: between the clusters the apron narrows to
            // nothing and the sea grape comes right up to the white line
            'float pnInl = smoothstep( 3.5, 11.0, -pnV );',
            'float pnTuft = pnFbm( pnW * 0.62 + 3.0 ) + 0.15;',
            // cover was gated so tightly that the dune bench read as pale sand
            // with a few dark blobs on it rather than as planted ground. Widen
            // the ramp and lift the floor: bare sand still shows through between
            // tussocks, but the band underneath a hundred sea grapes is green.
            'float pnCover = smoothstep( 0.20, 0.52, pnTuft ) * mix( 0.72, 1.0, pnInl );',
            'vec3 pnGrassC = mix( vec3( 0.3, 0.47, 0.13 ), vec3( 0.62, 0.72, 0.24 ), pnNoise( pnW * 2.6 ) );',
            'pnGrassC *= 0.86 + 0.3 * pnFbm( pnW * 1.4 + 7.0 );',
            'vec3 pnScrubC = mix( pnSandC * 0.93, pnGrassC, pnCover );',
            // drag-out sand fans where cars leave the apron for the scrub
            'pnScrubC = mix( pnScrubC, pnSandC, smoothstep( 0.7, 0.92, pnFbm( pnW * vec2( 0.22, 0.06 ) + 9.0 ) ) * 0.6 );',

            /* ---------------- bluff forest floor / mangrove flat ---------------- */
            // canopy shadow is the whole trick here: big soft dark blotches with
            // warm sunfleck gaps, so the hillside reads as planted, not painted
            'float pnCanopy = pnFbm( pnW * 0.055 + 17.0 ) * 0.65 + pnFbm( pnW * 0.19 + 31.0 ) * 0.35;',
            'float pnShade = smoothstep( 0.3, 0.68, pnCanopy );',
            // the vertex tint carries the large structure (height, lagoon); the
            // shader carries canopy shadow, sunfleck, litter and clay
            'vec3 pnForestC = pnTint * mix( vec3( 1.34, 1.3, 1.12 ), vec3( 0.4, 0.47, 0.34 ), pnShade );',
            // leaf litter and exposed red clay where the slope is steep
            'float pnClay = smoothstep( 0.6, 0.84, pnFbm( pnW * 0.22 + 41.0 ) ) * smoothstep( 0.94, 0.6, vNormalUpPn );',
            'pnForestC = mix( pnForestC, vec3( 0.4, 0.23, 0.13 ), pnClay * 0.8 );',
            // fine frond stipple so the 15 m triangles do not read as flat facets
            'pnForestC *= 0.86 + 0.3 * pnFbm( pnW * 2.2 );',
            'pnForestC *= 0.95 + 0.1 * pnNoise( pnW * 9.0 );',
            // lagoon shallows: silty green water over pale mud, darkening with depth
            'float pnSub = clamp( ( uSeaLevel - vWorldPos.y ) / 2.6, 0.0, 1.0 );',
            'vec3 pnMudC = mix( vec3( 0.62, 0.58, 0.42 ), vec3( 0.12, 0.3, 0.26 ), pnSub );',
            'pnForestC = mix( pnForestC, pnMudC, smoothstep( 0.02, 0.3, pnSub ) );',

            /* ---------------- launch ramps ---------------- */
            // packed marl, polished into two tyre lines, with a painted hazard
            // lip so the kicker is legible from 55 m out at 45 m/s (§6.2 R4)
            'vec3 pnRampC = pnSandC * vec3( 0.66, 0.61, 0.53 );',
            'pnRampC *= 0.86 + 0.32 * pnFbm( pnW * 2.4 + 61.0 );',
            'pnRampC *= 1.0 - 0.2 * smoothstep( 1.05, 0.2, abs( abs( pnV ) - 1.1 ) );',
            'float pnLipT = smoothstep( 8.7, 9.7, pnS );',
            'float pnStripe = step( 0.5, fract( pnV * 0.62 + 0.25 ) );',
            'pnRampC = mix( pnRampC, mix( vec3( 0.72, 0.05, 0.04 ), vec3( 0.86, 0.84, 0.76 ), pnStripe ), pnLipT * 0.85 );',
            'pnRampC = mix( pnRampC, pnRampC * 0.42, smoothstep( 9.9, 10.2, pnS ) );',

            /* ---------------- blend by kind ---------------- */
            'vec3 pnCol = pnSandC;',
            'pnRough = pnSandRough;',
            // sand is family 2 and stays as the base; every other family fades
            // in over one step of the ordered channel, so nothing bands
            'float wRoad = 1.0 - clamp( abs( pnKind - 0.0 ), 0.0, 1.0 );',
            'float wGrav = 1.0 - clamp( abs( pnKind - 1.0 ), 0.0, 1.0 );',
            'float wScrub = 1.0 - clamp( abs( pnKind - 3.0 ), 0.0, 1.0 );',
            'float wWood = 1.0 - clamp( abs( pnKind - 4.0 ), 0.0, 1.0 );',
            'float wRamp = 1.0 - clamp( abs( pnKind - 5.0 ), 0.0, 1.0 );',
            'pnCol = mix( pnCol, pnRoadC, wRoad );',
            'pnRough = mix( pnRough, pnRoadRough, wRoad );',
            'pnCol = mix( pnCol, pnGravC, wGrav );',
            'pnRough = mix( pnRough, 0.9, wGrav );',
            'pnCol = mix( pnCol, pnScrubC, wScrub );',
            'pnRough = mix( pnRough, 0.88, wScrub );',
            'pnCol = mix( pnCol, pnForestC, wWood );',
            'pnRough = mix( pnRough, mix( 0.78, 0.25, pnSub ), wWood );',
            'pnCol = mix( pnCol, pnRampC, wRamp );',
            'pnRough = mix( pnRough, 0.8, wRamp );',
            // sand blown across the tarmac on the seaward edge — the single most
            // characteristic thing about a road that runs on a dune
            'float pnBlow = wRoad * smoothstep( 3.0, 5.6, pnV ) * smoothstep( 0.44, 0.78, pnFbm( pnW * vec2( 0.09, 0.55 ) ) );',
            'pnCol = mix( pnCol, pnSandC * 0.96, clamp( pnBlow, 0.0, 0.8 ) );',
            'pnRough = mix( pnRough, 0.95, clamp( pnBlow, 0.0, 0.8 ) );',
            // rain: the shared wetness drive darkens and polishes everything but
            // the already-wet sand
            'pnCol *= mix( 1.0, 0.55, uWetness * ( 1.0 - pnWet * 0.7 ) );',
            'pnRough = mix( pnRough, 0.12, uWetness * 0.8 * ( 1.0 - pnWet * 0.5 ) );',
            // absolute: every kind above already folded in whatever part of the
            // vertex tint it wanted, so a second multiply would square it
            // §6.4: lift chroma and roll the top off, measured on the capture
            'pnCol = mix( vec3( dot( pnCol, vec3( 0.2126, 0.7152, 0.0722 ) ) ), pnCol, 1.22 );',
            'pnCol = max( pnCol, vec3( 0.0 ) ) * 0.94;',
            'diffuseColor.rgb = pnCol;',
          ].join('\n'),
        )
        .replace(
          '#include <roughnessmap_fragment>',
          ['#include <roughnessmap_fragment>', 'roughnessFactor = pnRough;'].join('\n'),
        );
    };
    mat.customProgramCacheKey = () => 'loco/pinones-deck-v8';
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
    if (along > STEP * 1.6 || v < BLUFF_V || v > st.waterV + SURF_RUN) {
      return this.layout?.groundHeight(x, z) ?? 0;
    }
    return this.profile(st, v);
  }

  /**
   * What the tyres are on, in the vocabulary the vehicle already speaks.
   *
   * `Coast.surfaceAt` rasterises its answer over `DISTRICT_BOUNDS`, which stops
   * at x = 450 — the entire Piñones ribbon (x = 357 … 1078) is off the east
   * edge of that grid and comes back `'cobble'`. So the beach road answers for
   * itself, using **the same column table and the same coarser-of-two rule the
   * collider was built from**: picture, physics body and grip query are three
   * readings of one cross-section and cannot drift apart.
   *
   * Returns `'sand'` off the ribbon — a caller outside our footprint should be
   * asking the district, and loose is the safe default on a barrier spit.
   */
  surfaceAt(x: number, z: number): SurfaceKind {
    if (this.stations.length === 0) return 'sand';
    const st = this.nearestStation(x, z);
    const dx = x - st.x;
    const dz = z - st.z;
    const v = dx * st.nx + dz * st.nz;
    if (Math.abs(dx * st.tx + dz * st.tz) > STEP * 1.6) return 'sand';
    if (v < BLUFF_V || v > st.waterV + SURF_RUN) return 'sand';

    // a kicker is packed marl laid over whatever it crosses, so it wins
    for (const f of this.rampFrames) {
      const rx = x - f.ox;
      const rz = z - f.oz;
      const t = rx * f.ux + rz * f.uz;
      if (t < 0 || t > f.len) continue;
      if (Math.abs(rx * -f.uz + rz * f.ux) <= f.halfW) return GRIP_KIND.ramp;
    }

    for (let k = 0; k < COLUMNS.length - 1; k++) {
      const ca = COLUMNS[k];
      const cb = COLUMNS[k + 1];
      if (!ca.solid || !cb.solid) continue;
      if (v >= this.columnV(st, ca) && v <= this.columnV(st, cb)) {
        return GRIP_KIND[stripGrip(ca, cb)];
      }
    }
    return 'sand';
  }

  /** Convenience: the tyre multipliers for whatever is under (x, z). */
  gripAt(x: number, z: number): SurfaceGrip {
    return SURFACE_GRIP[this.surfaceAt(x, z)];
  }

  /** True where the ribbon owns the ground — the projected layout's zone test. */
  covers(x: number, z: number): boolean {
    if (this.stations.length === 0) return false;
    const st = this.nearestStation(x, z);
    const dx = x - st.x;
    const dz = z - st.z;
    const v = dx * st.nx + dz * st.nz;
    const along = Math.abs(dx * st.tx + dz * st.tz);
    return along <= STEP * 1.6 && v >= BLUFF_V && v <= st.waterV + SURF_RUN;
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
    const seagrape: Placement[] = [];
    const ferns: Placement[] = [];
    const grass: Placement[] = [];
    const blooms: Placement[] = [];
    const boards: Placement[] = [];
    const speakers: Placement[] = [];

    const total = this.stations[this.stations.length - 1].s;
    const put = (st: Station, v: number, out = new THREE.Vector3()): THREE.Vector3 =>
      out.set(st.x + st.nx * v, this.profile(st, v), st.z + st.nz * v);
    const p = new THREE.Vector3();

    /* --- the crowd's view of the set dressing ---------------------------- *
     * Anchors are pushed as the props that justify them are placed, so a
     * sitter is always on a real chair and a queue always faces a real hatch.
     * The crowd cannot drift out of register with the strip because it is
     * derived from it. */
    const anchorHeight = (x: number, z: number): number => this.surfaceHeight(x, z);
    const anchorJitter = (a: number, b: number): number => rng.range(a, b);
    const crowd = this.crowdAnchors;

    const SHACK_SIGNS: SignKey[] = ['ancla', 'carmen', 'frituras', 'pinchos', 'coco', 'marAzul', 'mofongo', 'pescado'];
    const BOARDS: SignKey[] = ['cerveza', 'malta', 'refresco', 'mabi', 'empanadillas', 'piraguas', 'abierto', 'musica'];

    /* ---------------------------------------------------- 1. the clusters */
    const clusterAt = CLUSTERS;
    for (let ci = 0; ci < clusterAt.length; ci++) {
      const cs = clusterAt[ci];
      if (cs > total - 40) continue;
      const shackCount = Math.max(3, Math.round(rng.int(4, 6) * density));
      const inland = ci % 3 === 2; // one cluster in three sits across the road
      const side = inland ? -1 : 1;
      const anchors: THREE.Vector3[] = [];

      for (let k = 0; k < shackCount; k++) {
        const s = cs + (k - (shackCount - 1) * 0.5) * rng.range(5.6, 6.9);
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

        /* --- a queue at the hatch. This is the single most important crowd
               in Piñones: a chinchorro with nobody waiting at it is a shed. */
        queueAnchors(
          crowd,
          p.x + Math.sin(spec.yaw) * spec.depth * 0.5,
          p.z + Math.cos(spec.yaw) * spec.depth * 0.5,
          spec.yaw,
          rng.int(2, 4),
          anchorHeight,
          anchorJitter,
        );

        // a fryer plume off every second shack
        if (k % 2 === 0) smoke.push({ x: p.x, y: p.y + 2.6, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.85, 1.3) });

        /* --- a painted drink board propped against the flank, and on the
               noisy shacks a speaker on a stand with dancers round it --- */
        if (rng.bool(0.62)) {
          const bv = v - side * rng.range(2.2, 3.4);
          const bst = this.stationAtS(s + rng.range(-2.4, 2.4));
          put(bst, bv, p);
          boards.push({ x: p.x, y: p.y, z: p.z, yaw: spec.yaw + rng.range(-0.4, 0.4) });
        }
        if (spec.speaker) {
          const sv = v - side * rng.range(3.0, 4.2);
          const sst = this.stationAtS(s + rng.range(-3, 3));
          put(sst, sv, p);
          speakers.push({ x: p.x, y: p.y, z: p.z, yaw: spec.yaw + Math.PI + rng.range(-0.5, 0.5) });
          ringAnchors(crowd, p.x, p.z, rng.range(1.9, 2.9), rng.int(3, 5), 'dance', anchorHeight, anchorJitter);
        }

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
      const terrace = Math.round(rng.int(4, 6) * density);
      for (let t = 0; t < terrace; t++) {
        const s = cs + rng.range(-18, 18);
        const st = this.stationAtS(s);
        if (!st) continue;
        const v = inland ? -rng.range(8.6, 10.2) : lerp(SHOULDER + 1.5, st.bermV, rng.range(0.25, 0.95));
        put(st, v, p);
        umbrellas.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28), scale: rng.range(0.92, 1.12) });
        tables.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28) });
        const seats = rng.int(3, 4);
        for (let c = 0; c < seats; c++) {
          const a = (c / seats) * Math.PI * 2 + rng.range(-0.4, 0.4);
          const r = rng.range(0.72, 0.95);
          const cx = p.x + Math.cos(a) * r;
          const cz = p.z + Math.sin(a) * r;
          const cy = this.surfaceHeight(cx, cz);
          // the chair's own seat looks along +Z of its yaw, so turn it to face
          // the table rather than away from it
          chairs.push({
            x: cx,
            y: cy,
            z: cz,
            yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) + rng.range(-0.22, 0.22),
          });
          // roughly two chairs in three have somebody in them — an empty
          // terrace beside a full one is what a real strip looks like
          if (rng.bool(0.66)) {
            crowd.push({ x: cx, y: cy, z: cz, yaw: faceYaw(-Math.cos(a), -Math.sin(a)), kind: 'seat' });
          }
        }
      }
      for (let t = 0; t < Math.round(3 * density); t++) {
        const st = this.stationAtS(cs + rng.range(-16, 16));
        if (!st) continue;
        put(st, inland ? -rng.range(8.4, 9.6) : lerp(SHOULDER + 1.2, st.bermV, rng.range(0.2, 0.8)), p);
        if (rng.bool(0.5)) {
          barrels.push({ x: p.x, y: p.y, z: p.z, yaw: rng.range(0, 6.28) });
          // a barrel table is a standing bar: people round it, drinks in hand
          ringAnchors(crowd, p.x, p.z, rng.range(0.78, 1.0), rng.int(2, 3), 'stand', anchorHeight, anchorJitter);
        } else {
          const byaw = Math.atan2(st.tx, st.tz) + rng.range(-0.3, 0.3);
          const cx0 = p.x;
          const cz0 = p.z;
          benches.push({ x: cx0, y: p.y, z: cz0, yaw: byaw });
          /* Both benches, turned in toward the table top. The seat planks sit
             at local z = ±0.62, and the instance is rotated about Y by `byaw`,
             so that maps to a world offset of ±0.62·(sin, cos) of the yaw. */
          for (const sgn of [-1, 1]) {
            if (!rng.bool(0.72)) continue;
            const px = cx0 + sgn * 0.62 * Math.sin(byaw);
            const pz = cz0 + sgn * 0.62 * Math.cos(byaw);
            crowd.push({
              x: px,
              y: this.surfaceHeight(px, pz),
              z: pz,
              yaw: faceYaw(cx0 - px, cz0 - pz),
              kind: 'bench',
            });
          }
        }
      }

      /* --- flagpoles at each end of the cluster (§7.4). The monoestrellada is
             the strongest single cultural read on this road, so every cluster
             flies one at the approach and most fly a second at the exit. --- */
      for (const fs of [cs - 14, cs + 15]) {
        if (fs !== cs - 14 && !rng.bool(0.7)) continue;
        const st = this.stationAtS(fs);
        if (!st) continue;
        const v = inland ? -rng.range(9, 11) : SHOULDER + rng.range(1.6, 3.2);
        put(st, v, p);
        const poleH = rng.range(5.6, 6.8);
        kb.wood.cylinder(p.x, p.y, p.z, 0.075, 0.055, poleH, 7, KIT.woodPale);
        puertoRicanFlag(kb.cloth, p.x, p.y + poleH - 0.3, p.z, rng.range(1.35, 1.7), Math.atan2(st.tx, st.tz), rng.next());
      }

      /* --- festoon lights: shack to shack, and a second run out over the
             terrace on two poles, which is what actually lights the tables --- */
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
        const first = anchors[0];
        const last = anchors[anchors.length - 1];
        const outV = inland ? -rng.range(5.5, 7) : lerp(SHOULDER + 2, this.nearestStation(first.x, first.z).bermV, 0.4);
        const polls: THREE.Vector3[] = [];
        for (const src of [first, last]) {
          const st = this.nearestStation(src.x, src.z);
          put(st, outV, p);
          kb.wood.cylinder(p.x, p.y, p.z, 0.07, 0.05, 3.9, 6, KIT.woodPale);
          polls.push(new THREE.Vector3(p.x, p.y + 3.7, p.z));
        }
        const pts: THREE.Vector3[] = [];
        catenary(kb.wood, polls[0], polls[1], 0.9, KIT.steelDark, 0.02, 9, pts);
        for (let q = 1; q < pts.length - 1; q++) {
          bulbs.push({ x: pts[q].x, y: pts[q].y, z: pts[q].z, yaw: 0 });
        }
        for (let q = 0; q < 2; q++) {
          const a = polls[q];
          const b = anchors[q === 0 ? 0 : anchors.length - 1];
          const link: THREE.Vector3[] = [];
          catenary(kb.wood, a, b, 0.35, KIT.steelDark, 0.02, 4, link);
          for (let r2 = 1; r2 < link.length - 1; r2++) {
            bulbs.push({ x: link[r2].x, y: link[r2].y, z: link[r2].z, yaw: 0 });
          }
        }
      }

      /* --- cars parked at an angle on the gravel --- */
      const parked = Math.round(rng.int(3, 5) * density);
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
      const st = this.stationAtS(gs - 18);
      if (!st) continue;
      put(st, SHOULDER + 1.6, p);
      kb.wood.cylinder(p.x, p.y, p.z, 0.05, 0.045, 2.1, 6, KIT.steel);
      signPanel(kb, p.x, p.y + 2.1, p.z, Math.atan2(-st.tx, -st.tz), 0.62, 0.62, 'pare');
    }
    // a pair of banner flags either side of every ramp mouth, so the kicker
    // reads as an invitation from 55 m out (§6.2 R4) rather than a sand pile
    for (const r of RAMPS) {
      const st = this.stationAtS(r.s - 3);
      if (!st) continue;
      for (const dv of [-1.4, 4.8]) {
        put(st, SHOULDER + 0.6 + dv, p);
        banners.push({ x: p.x, y: p.y, z: p.z, yaw: Math.atan2(st.tx, st.tz), scale: 1.2 });
        kb.wood.cylinder(p.x, p.y, p.z, 0.06, 0.045, 3.6, 6, KIT.woodPale);
      }
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
      // beach chairs face the water, because that is what they are for
      const seaward = faceYaw(st.nx, st.nz);
      for (let c = 0; c < rng.int(1, 3); c++) {
        const a = rng.range(0, 6.28);
        const r = rng.range(0.9, 1.6);
        const cx = p.x + Math.cos(a) * r;
        const cz = p.z + Math.sin(a) * r;
        const cy = this.surfaceHeight(cx, cz);
        chairs.push({ x: cx, y: cy, z: cz, yaw: Math.atan2(st.nx, st.nz) + rng.range(-0.5, 0.5) });
        if (rng.bool(0.45)) {
          crowd.push({ x: cx, y: cy, z: cz, yaw: seaward + rng.range(-0.4, 0.4), kind: 'seat' });
        }
      }
      // and a few people standing at the tideline looking at the Atlantic
      if (rng.bool(0.5)) {
        const wv = lerp(v, st.waterV - 1.5, rng.range(0.4, 0.95));
        put(st, wv, p);
        if (p.y > SEA_LEVEL + 0.15) {
          crowd.push({ x: p.x, y: p.y, z: p.z, yaw: seaward + rng.range(-0.6, 0.6), kind: 'shore' });
        }
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
    /* ----------------------------------------- 4a. the layered understorey *
     *
     * Piñones is not a road across a lawn — it is a road cut through a
     * thicket, and what sells that at 45 m/s is *depth*: three or four
     * distinct plant silhouettes stacked between the white line and the
     * canopy, not one shrub repeated.
     *
     * `Vegetation` cannot supply this. Its `buildUnderstorey` keys off
     * `model.spans` and `model.promenade`, both of which are empty for the
     * projected layout this layer hands it, so Piñones gets the palms and
     * nothing beneath them — which is exactly why the verge read flat and
     * patchy. The palms stay `Vegetation`'s; everything under them is placed
     * here, in bands measured from the centreline.
     */

    /** Metres from the nearest chinchorro cluster centre. */
    const distToCluster = (s: number): number => {
      let d = Infinity;
      for (const cs of CLUSTERS) d = Math.min(d, Math.abs(s - cs));
      return d;
    };

    /**
     * One planting pass: `n` plants scattered over a lateral band.
     *
     * `clearCluster` keeps a band off the parking aprons — between the
     * clusters the scrub is allowed right up to the white line, but planting a
     * bush in the middle of somebody's parking is how you get a hedge growing
     * through a car.
     */
    const scatter = (
      list: Placement[],
      n: number,
      v0: number,
      v1: number,
      s0: number,
      s1: number,
      lo: number,
      hi: number,
      clearCluster = 0,
    ): void => {
      for (let i = 0; i < n; i++) {
        const s = rng.range(s0, Math.max(s0 + 1, s1));
        if (clearCluster > 0 && distToCluster(s) < clearCluster) continue;
        const st = this.stationAtS(s);
        if (!st) continue;
        const v = rng.range(v0, v1);
        put(st, v, p);
        if (p.y < SEA_LEVEL + 0.7) continue;
        list.push({
          x: p.x,
          y: p.y - 0.1,
          z: p.z,
          yaw: rng.range(0, 6.28),
          scale: rng.range(lo, hi),
        });
      }
    };

    const S0 = 6;
    const S1 = total - 6;

    /* --- midstorey: sea grape is the signature plant of this coast and the
           mass that actually crowds the road. Densest right behind the bench,
           thinning as it climbs, plus a belt holding the dune crest. --- */
    scatter(seagrape, Math.round(300 * density), -13, -30, S0, S1, 1.0, 1.9);
    scatter(seagrape, Math.round(90 * density), -30, -58, S0, S1, 0.8, 1.5);
    scatter(seagrape, Math.round(70 * density), 8.5, 15, S0, S1, 0.7, 1.25);
    // and a hedge crowding the white line itself, wherever there is no apron
    // to keep clear: this is what makes the road feel *cut through* something
    scatter(seagrape, Math.round(130 * density), -7.6, -12.5, S0, S1, 0.7, 1.3, 34);

    /* --- understorey: ferns in the shade the bluff throws, tall grass on the
           open dune and the sunlit verge where nothing shades it out --- */
    scatter(ferns, Math.round(240 * density), -26, -74, S0, S1, 0.8, 1.6);
    scatter(grass, Math.round(300 * density), -10.5, -24, S0, S1, 0.7, 1.5);
    scatter(grass, Math.round(240 * density), 7.2, 16, S0, S1, 0.6, 1.35);
    scatter(grass, Math.round(150 * density), -7.2, -11, S0, S1, 0.55, 1.1, 30);

    /* --- flowering shrubs: the magenta and coral §3.2 wants, kept to the
           roadside where they read against the green at speed --- */
    scatter(blooms, Math.round(120 * density), -11, -26, S0, S1, 0.8, 1.5);

    /* --- and the original thicket, now a supporting player rather than the
           whole planting: broken clumps up the bluff face --- */
    const thicketCount = Math.round(260 * density);
    for (let i = 0; i < thicketCount; i++) {
      const st = this.stationAtS(rng.range(S0, S1));
      if (!st) continue;
      const roll = rng.next();
      const v = roll < 0.45 ? -rng.range(16, 34) : -rng.range(34, 96);
      put(st, v, p);
      if (p.y < SEA_LEVEL + 0.7) continue;
      const scale = roll < 0.45 ? rng.range(1.2, 2.3) : rng.range(0.85, 1.8);
      thickets.push({ x: p.x, y: p.y - 0.12, z: p.z, yaw: rng.range(0, 6.28), scale });
    }

    /* ------------------------------------- 4b. the lagoon mangrove fringe */
    const mangroves = Math.round(180 * density);
    for (let i = 0; i < mangroves; i++) {
      const st = this.stationAtS(rng.range(300, total - 4));
      if (!st || st.lagoon < 0.15) continue;
      const v = -rng.range(26, 74);
      put(st, v, p);
      // they stand in the shallows and on the mud, never on the dry dune
      if (p.y > SEA_LEVEL + 1.6 || p.y < SEA_LEVEL - 1.1) continue;
      thickets.push({
        x: p.x,
        y: Math.max(p.y, SEA_LEVEL - 0.35) - 0.1,
        z: p.z,
        yaw: rng.range(0, 6.28),
        scale: rng.range(1.1, 2.4),
      });
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
    addInstanced(buildSeaGrape(rng.fork(0x3f)), kit.foliage, seagrape, 'pinones/seagrape');
    addInstanced(buildFernClump(rng.fork(0x4a)), kit.foliage, ferns, 'pinones/ferns');
    addInstanced(buildBeachGrass(rng.fork(0x5b)), kit.foliage, grass, 'pinones/grass');
    addInstanced(buildBloomBush(rng.fork(0x6c), KIT.bloom[0]), kit.foliage, blooms, 'pinones/blooms');
    addInstanced(buildDrinkBoard('cerveza'), kit.sign, boards, 'pinones/boards');
    addInstanced(buildSpeakerStack(), kit.paint, speakers, 'pinones/speakers');
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
      // the palm belt behind the shacks, the bluff forest above it, and the
      // scattered beach palms out on the sand
      for (const [v0, v1] of [
        [-34, -11],
        [-88, -34],
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
    this.elapsed += dt;
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

    // the crowd rides the props' cull: there is no reason to pay for a hundred
    // instance writes when the shacks they are queuing at are not being drawn
    const crowdOn = near < propCut;
    this.life?.setVisible(crowdOn);
    if (crowdOn) this.life?.update(cameraPos, dt, this.elapsed);
  }

  /** Wall clock since build, for the crowd's per-person phase offsets. */
  private elapsed = 0;

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
    this.life?.onQualityChange(tier);
  }

  private countDrawCalls(): number {
    let n = this.deckGroup.children.length + this.propGroup.children.length;
    if (this.vegetation) n += this.vegetation.group.children.length;
    if (this.life) n += this.life.drawCalls;
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
      ...(this.life?.stats() ?? {}),
    };
  }

  dispose(): void {
    if (this.physics) for (const b of this.bodies) this.physics.removeBody(b);
    this.bodies.length = 0;
    this.life?.dispose();
    this.life = null;
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

/**
 * Friction class of the strip between two cross-section columns. The coarser
 * of the two wins, so the asphalt body never claims a triangle that is half
 * apron — a wheel straddling the white line gets the shoulder's grip, not the
 * carriageway's, which is what makes running wide onto the gravel cost you
 * something.
 */
function stripGrip(ca: Column, cb: Column): GripClass {
  const a = ca.grip ?? 'sand';
  const b = cb.grip ?? 'sand';
  if (a === b) return a;
  return a === 'asphalt' || b === 'asphalt' ? 'gravel' : 'sand';
}

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
