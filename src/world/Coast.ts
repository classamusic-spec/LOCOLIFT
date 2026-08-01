/**
 * Loco Lift — the coast.
 *
 * Owns everything where the city stops being stone and starts being sand:
 *
 *  - **the beach**, a graded sand apron running from the malecón kerb down
 *    across the berm, through the wet tideline and on under the water into a
 *    submerged terrace the ocean shader reads as turquoise shallows;
 *  - **the malecón**, the seawall / promenade edge that closes the coastal road
 *    off from the drop, with pilasters, a coping band and deliberate gaps;
 *  - **launch geometry** — a boat slipway, three seawall kickers and two sand
 *    kickers at the tideline. These carry real trimesh colliders, because a
 *    ramp you cannot actually hit is set dressing, not gameplay;
 *  - **rock** — headland boulders, tideline scatter, and the riprap armouring
 *    the cruise-dock frontage;
 *  - **{@link Coast.surfaceAt}**, the grip query the vehicle reads so sand
 *    drives like sand and adoquín drives like adoquín.
 *
 * The layer also publishes a shared, memoised {@link CoastModel}: the shoreline
 * stations, beach spans, promenade stations and ramp specs that `Vegetation`
 * and `CoastProps` place against. That model is derived purely from the layout,
 * so every coast layer agrees on where the water is without any of them having
 * to be built first.
 *
 * **Grading contract.** The sand hugs `layout.groundHeight` to within ~0.3 m so
 * the world's existing terrain collider stays honest under the tyres; the only
 * places the visual and the collision surface part company are the ramps, which
 * bring their own colliders.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { EdgeSample, QualityTier } from '../core/types';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RNG, fbm2D, valueNoise2D } from '../core/RNG';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle } from '../physics/PhysicsTypes';
import { SEA_LEVEL, DISTRICT_BOUNDS } from './CityLayout';
import { RoadNetworkImpl } from './RoadNetwork';
import { SURFACE_GRIP, setSurfaceProbe } from './Surfaces';
import type { SurfaceGrip, SurfaceKind } from './Surfaces';
import type { CityLayout, OpenArea, WorldLayer, WorldOpts } from './WorldTypes';
import { LodField, TALL_SHADOW_CUT, bucketByCell, bucketFootprint } from './LodGrid';

/** Cell size for the boulder/riprap LOD grid, metres. */
const ROCK_CELL = 160;

/* ========================================================================== *
 *  public types
 * ========================================================================== */

/**
 * The surface classification lives in {@link ./Surfaces} so that the vehicle
 * can read it without this file and `src/vehicle` importing each other. It is
 * re-exported here unchanged: every existing
 * `import { SURFACE_GRIP } from './Coast'` still resolves.
 */
export { SURFACE_GRIP, SURFACE_PLUME } from './Surfaces';
export type { SurfaceGrip, SurfaceKind } from './Surfaces';

/** One sample of the waterline, marching along the shore. */
export interface ShoreStation {
  /** waterline position */
  x: number;
  z: number;
  /** unit vector pointing out to sea, horizontal */
  nx: number;
  nz: number;
  /** unit vector along the shore, horizontal */
  tx: number;
  tz: number;
  /** arc length from the start of the span, metres */
  s: number;
  /** z of the inland edge of the sand (under the promenade) */
  inlandZ: number;
  /** ground height at the inland edge */
  inlandY: number;
  /** metres of sand between the inland edge and the waterline */
  width: number;
  /**
   * True where the cruise apron owns the shore. The sand still runs through —
   * it is punched back out around the paving — but nothing sunbathes here and
   * the waterline is armoured with riprap rather than left as beach.
   */
  dock: boolean;
}

/**
 * A continuous run of shore.
 *
 * Spans break only where the land genuinely stops, never at a change of
 * character. Splitting on character was the earlier design and it left a
 * lawn showing through at every junction, because both neighbours dissolved
 * their own edge into the same seam.
 */
export interface BeachSpan {
  id: number;
  kind: 'beach' | 'dock';
  stations: ShoreStation[];
  length: number;
}

/** A sample of the malecón, on the sea side of the coastal carriageway. */
export interface PromenadeStation {
  /** kerb line position, at road height */
  x: number;
  y: number;
  z: number;
  /** unit vector pointing out to sea */
  nx: number;
  nz: number;
  /** unit vector along the road */
  tx: number;
  tz: number;
  /** arc length along the whole promenade run */
  s: number;
  /** true where the parapet is deliberately broken (ramp, slipway, stair) */
  gap: boolean;
}

export type RampKind = 'slipway' | 'kicker' | 'sandKicker';

/** A launch (or descent) built into the coast. */
export interface RampSpec {
  kind: RampKind;
  /** centre of the ramp foot, world space */
  x: number;
  y: number;
  z: number;
  /** direction of travel across the ramp, unit, horizontal */
  dx: number;
  dz: number;
  /** metres from foot to lip along `d` */
  length: number;
  /** metres of rise from foot to lip */
  rise: number;
  /** metres */
  width: number;
  /** how far past the lip the deck overhangs before the drop */
  lip: number;
}

/* ========================================================================== *
 *  tuning
 * ========================================================================== */

/** Height at which the sand mesh sits above the terrain mesh (which is -0.07). */
const SAND_LIFT = 0.075;
/** How far the sand runs out past the waterline, metres. */
const SUBMERGED_RUN = 30;
/** Deepest point of the submerged sand terrace, metres below sea level. */
const TERRACE_DEPTH = 3.4;
/** Grid pitch of the beach mesh, metres, at `high`. */
const BEACH_CELL = 2.4;
/** Shore marching pitch, metres. */
const SHORE_STEP = 4;
/** Cell size of the surface raster, metres. */
const SURFACE_CELL = 2.5;
/** Metres of beach one tile of the sand normal map covers. */
const SAND_TILE = 3.2;

/** Sea-side clearance from the coastal road centreline to the parapet. */
const PARAPET_CLEAR = 3.9;
const PARAPET_H = 0.98;
const PARAPET_T = 0.62;

const SURFACE_CODE: Record<SurfaceKind, number> = {
  cobble: 0,
  sand: 1,
  asphalt: 2,
  grass: 3,
};
const SURFACE_NAME: SurfaceKind[] = ['cobble', 'sand', 'asphalt', 'grass'];

/** Density multipliers for everything the coast scatters. */
export const COAST_DENSITY: Record<QualityTier, number> = {
  low: 0.38,
  medium: 0.66,
  high: 1,
  ultra: 1.3,
};

/* ========================================================================== *
 *  small geometry builder — shared with CoastProps and Vegetation
 * ========================================================================== */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** shared, never mutated */
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Non-indexed-friendly triangle soup with position / normal / uv / colour.
 *
 * Every coast prop is authored as one of these and then merged, so an entire
 * family of objects — a whole pier, every kiosk in the district — costs a
 * single draw call against one shared vertex-coloured material.
 */
export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  /** optional extra vec3 channel, used by the beach and by wind animation */
  readonly aux: number[] = [];
  private useAux = false;

  private _c = new THREE.Color();

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  enableAux(): this {
    this.useAux = true;
    return this;
  }

  vertex(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    r: number,
    g: number,
    b: number,
    ax = 0,
    ay = 0,
    az = 0,
  ): number {
    const id = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    if (this.useAux) this.aux.push(ax, ay, az);
    return id;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quadIdx(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Flat quad, CCW as seen from the side the normal points at. */
  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    color: number,
    uvScale = 0.5,
    aux?: THREE.Vector3,
  ): void {
    _e1.subVectors(b, a);
    _e2.subVectors(d, a);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-12) return;
    _n.normalize();
    this._c.setHex(color, THREE.SRGBColorSpace);
    const r = this._c.r;
    const g = this._c.g;
    const bl = this._c.b;
    const w = _e1.length() * uvScale;
    const h = _e2.length() * uvScale;
    const ax = aux?.x ?? 0;
    const ay = aux?.y ?? 0;
    const az = aux?.z ?? 0;
    const i0 = this.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, 0, 0, r, g, bl, ax, ay, az);
    const i1 = this.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, w, 0, r, g, bl, ax, ay, az);
    const i2 = this.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, w, h, r, g, bl, ax, ay, az);
    const i3 = this.vertex(d.x, d.y, d.z, _n.x, _n.y, _n.z, 0, h, r, g, bl, ax, ay, az);
    this.quadIdx(i0, i1, i2, i3);
  }

  /**
   * Quad whose front face is forced to point the same way as `face`. Use this
   * anywhere the winding depends on data (a shore tangent, a ramp side) rather
   * than on a literal ordering you can read off the page.
   */
  quadTowards(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    color: number,
    uvScale: number,
    face: THREE.Vector3,
    aux?: THREE.Vector3,
  ): void {
    _e1.subVectors(b, a);
    _e2.subVectors(d, a);
    _n.crossVectors(_e1, _e2);
    if (_n.dot(face) < 0) this.quad(a, d, c, b, color, uvScale, aux);
    else this.quad(a, b, c, d, color, uvScale, aux);
  }

  /**
   * Axis-aligned box, optionally rotated about Y then translated. Cheap and
   * covers 90 % of what props need.
   */
  box(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    color: number,
    yaw = 0,
    aux?: THREE.Vector3,
  ): void {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const put = (lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 =>
      out.set(cx + lx * cs + lz * sn, cy + ly, cz - lx * sn + lz * cs);

    // +Y
    this.quad(
      put(-hx, hy, -hz, _v0).clone(),
      put(hx, hy, -hz, _v1).clone(),
      put(hx, hy, hz, _v2).clone(),
      put(-hx, hy, hz, _v3).clone(),
      color,
      0.5,
      aux,
    );
    // -Y
    this.quad(
      put(-hx, -hy, hz, _v0).clone(),
      put(hx, -hy, hz, _v1).clone(),
      put(hx, -hy, -hz, _v2).clone(),
      put(-hx, -hy, -hz, _v3).clone(),
      color,
      0.5,
      aux,
    );
    // +Z (local)
    this.quad(
      put(-hx, -hy, hz, _v0).clone(),
      put(hx, -hy, hz, _v1).clone(),
      put(hx, hy, hz, _v2).clone(),
      put(-hx, hy, hz, _v3).clone(),
      color,
      0.5,
      aux,
    );
    // -Z
    this.quad(
      put(hx, -hy, -hz, _v0).clone(),
      put(-hx, -hy, -hz, _v1).clone(),
      put(-hx, hy, -hz, _v2).clone(),
      put(hx, hy, -hz, _v3).clone(),
      color,
      0.5,
      aux,
    );
    // +X
    this.quad(
      put(hx, -hy, hz, _v0).clone(),
      put(hx, -hy, -hz, _v1).clone(),
      put(hx, hy, -hz, _v2).clone(),
      put(hx, hy, hz, _v3).clone(),
      color,
      0.5,
      aux,
    );
    // -X
    this.quad(
      put(-hx, -hy, -hz, _v0).clone(),
      put(-hx, -hy, hz, _v1).clone(),
      put(-hx, hy, hz, _v2).clone(),
      put(-hx, hy, -hz, _v3).clone(),
      color,
      0.5,
      aux,
    );
  }

  /**
   * Tapered cylinder along +Y, `sides` around. Used for pilings, trunks,
   * poles, bottles and umbrella masts.
   */
  cylinder(
    cx: number,
    cy: number,
    cz: number,
    rBottom: number,
    rTop: number,
    height: number,
    sides: number,
    color: number,
    cap = true,
    aux?: THREE.Vector3,
  ): void {
    this._c.setHex(color, THREE.SRGBColorSpace);
    const r = this._c.r;
    const g = this._c.g;
    const b = this._c.b;
    const ax = aux?.x ?? 0;
    const ay = aux?.y ?? 0;
    const az = aux?.z ?? 0;
    const slope = (rBottom - rTop) / Math.max(height, 1e-4);
    const ring0: number[] = [];
    const ring1: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const inv = 1 / Math.hypot(1, slope);
      const nx = ca * inv;
      const nz = sa * inv;
      const ny = slope * inv;
      ring0.push(
        this.vertex(cx + ca * rBottom, cy, cz + sa * rBottom, nx, ny, nz, i / sides, 0, r, g, b, ax, ay, az),
      );
      ring1.push(
        this.vertex(
          cx + ca * rTop,
          cy + height,
          cz + sa * rTop,
          nx,
          ny,
          nz,
          i / sides,
          height * 0.35,
          r,
          g,
          b,
          ax,
          ay,
          az,
        ),
      );
    }
    for (let i = 0; i < sides; i++) {
      this.quadIdx(ring0[i], ring0[i + 1], ring1[i + 1], ring1[i]);
    }
    if (cap && rTop > 1e-4) {
      const centre = this.vertex(cx, cy + height, cz, 0, 1, 0, 0.5, 0.5, r, g, b, ax, ay, az);
      const cr: number[] = [];
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        cr.push(
          this.vertex(
            cx + Math.cos(a) * rTop,
            cy + height,
            cz + Math.sin(a) * rTop,
            0,
            1,
            0,
            0.5 + Math.cos(a) * 0.5,
            0.5 + Math.sin(a) * 0.5,
            r,
            g,
            b,
            ax,
            ay,
            az,
          ),
        );
      }
      for (let i = 0; i < sides; i++) this.tri(centre, cr[i], cr[i + 1]);
    }
  }

  /** Append another builder's contents, offset by (dx,dy,dz). */
  append(other: GeoBuilder, dx = 0, dy = 0, dz = 0): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < other.pos.length; i += 3) {
      this.pos.push(other.pos[i] + dx, other.pos[i + 1] + dy, other.pos[i + 2] + dz);
    }
    for (const v of other.nrm) this.nrm.push(v);
    for (const v of other.uv) this.uv.push(v);
    for (const v of other.col) this.col.push(v);
    if (this.useAux) {
      if (other.aux.length === other.pos.length) for (const v of other.aux) this.aux.push(v);
      else for (let i = 0; i < other.pos.length; i++) this.aux.push(0);
    }
    for (const v of other.idx) this.idx.push(v + base);
  }

  /** `auxName` names the optional third channel in the resulting geometry. */
  build(auxName = 'aCoast'): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.useAux && this.aux.length === this.pos.length) {
      g.setAttribute(auxName, new THREE.Float32BufferAttribute(this.aux, 3));
    }
    const use32 = this.pos.length / 3 > 65535;
    g.setIndex(
      use32
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1),
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ========================================================================== *
 *  shared coast model
 * ========================================================================== */

const MODEL_CACHE = new WeakMap<CityLayout, CoastModel>();

/**
 * Derived shoreline geometry, memoised per layout.
 *
 * Every coast layer calls this in its own `build`, so the layers agree on where
 * the water is regardless of the order the world registers them in.
 */
export function coastModel(layout: CityLayout): CoastModel {
  let m = MODEL_CACHE.get(layout);
  if (!m) {
    m = new CoastModel(layout);
    MODEL_CACHE.set(layout, m);
  }
  return m;
}

export class CoastModel {
  readonly layout: CityLayout;
  readonly spans: BeachSpan[] = [];
  readonly promenade: PromenadeStation[] = [];
  readonly ramps: RampSpec[] = [];
  /** the cruise-dock apron polygon, if the layout has one */
  readonly apron: OpenArea | null;

  private surfaceGrid: Uint8Array | null = null;
  private sgw = 0;
  private sgh = 0;
  private sMinX = 0;
  private sMinZ = 0;

  /** shore lookup: x -> station, for beachHeight */
  private shoreZByX: Float32Array;
  private inlandZByX: Float32Array;
  private shoreX0: number;
  private shoreDX = 2;

  constructor(layout: CityLayout) {
    this.layout = layout;
    this.apron =
      layout.areas.find((a) => a.zone === 'waterfront' && a.surface === 'asphalt') ?? null;

    this.buildPromenade();
    this.buildSpans();

    this.shoreX0 = DISTRICT_BOUNDS.minX;
    const n = Math.ceil((DISTRICT_BOUNDS.maxX - DISTRICT_BOUNDS.minX) / this.shoreDX) + 1;
    this.shoreZByX = new Float32Array(n).fill(NaN);
    this.inlandZByX = new Float32Array(n).fill(NaN);
    this.rasteriseShoreLookup();

    this.buildRamps();
  }

  /* ------------------------------------------------------------ shoreline */

  /** Bisect the terrain for the z where it crosses sea level, marching south. */
  private waterlineZ(x: number): number {
    const gh = this.layout.groundHeight;
    let lo = 250;
    let hi = 348;
    if (gh(x, lo) <= SEA_LEVEL) return NaN;
    if (gh(x, hi) > SEA_LEVEL) return NaN;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) * 0.5;
      if (gh(x, mid) > SEA_LEVEL) lo = mid;
      else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  private buildPromenade(): void {
    const roads = this.layout.roads;
    const pt = new THREE.Vector3();
    const tan = new THREE.Vector3();
    type Run = { pts: PromenadeStation[] };
    const runs: Run[] = [];

    for (let e = 0; e < roads.edges.length; e++) {
      const ed = roads.edges[e];
      if (ed.kind !== 'coastal') continue;
      const steps = Math.max(2, Math.round(ed.length / 4));
      const pts: PromenadeStation[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        roads.sample(e, t, 0, pt);
        roads.tangent(e, t, tan);
        // sea side = the perpendicular with the larger +z component
        let nx = -tan.z;
        let nz = tan.x;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l;
        nz /= l;
        if (nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        const off = ed.width * 0.5 + PARAPET_CLEAR;
        pts.push({
          x: pt.x + nx * off,
          y: pt.y,
          z: pt.z + nz * off,
          nx,
          nz,
          tx: tan.x,
          tz: tan.z,
          s: 0,
          gap: false,
        });
      }
      runs.push({ pts });
    }
    // order the runs west to east and concatenate, dropping duplicate joints
    runs.sort((a, b) => a.pts[0].x - b.pts[0].x);
    let s = 0;
    for (const run of runs) {
      for (const p of run.pts) {
        const prev = this.promenade[this.promenade.length - 1];
        if (prev) {
          const d = Math.hypot(p.x - prev.x, p.z - prev.z);
          if (d < 0.6) continue;
          s += d;
        }
        p.s = s;
        this.promenade.push(p);
      }
    }
  }

  private buildSpans(): void {
    const gh = this.layout.groundHeight;
    let apMinX = Infinity;
    let apMaxX = -Infinity;
    if (this.apron) {
      for (const p of this.apron.polygon) {
        apMinX = Math.min(apMinX, p.x);
        apMaxX = Math.max(apMaxX, p.x);
      }
      apMinX -= 8;
      apMaxX += 8;
    }

    const x0 = DISTRICT_BOUNDS.minX + 20;
    const x1 = DISTRICT_BOUNDS.maxX - 20;
    let current: ShoreStation[] = [];

    const flush = (): void => {
      if (current.length >= 6) {
        let len = 0;
        for (let i = 1; i < current.length; i++) {
          len += Math.hypot(current[i].x - current[i - 1].x, current[i].z - current[i - 1].z);
          current[i].s = len;
        }
        if (len > 32) {
          const dockShare = current.filter((s) => s.dock).length / current.length;
          this.spans.push({
            id: this.spans.length,
            kind: dockShare > 0.6 ? 'dock' : 'beach',
            stations: current,
            length: len,
          });
        }
      }
      current = [];
    };

    for (let x = x0; x <= x1; x += SHORE_STEP) {
      const wz = this.waterlineZ(x);
      // land ran out — this is a real break in the shore, so end the span
      if (!Number.isFinite(wz) || gh(x, 262) < 0.8) {
        flush();
        continue;
      }
      // The inland edge runs right up under the promenade parapet, everywhere,
      // including along the dock: the paved apron is punched back out of the
      // sand by the dissolve mask instead. Stopping the sand short leaves a
      // band of lawn running down to the sea, which is the single most
      // obviously wrong thing a coast can do.
      let inZ = this.promenadeZAt(x) - 0.6;
      inZ = Math.min(inZ, wz - 10);
      current.push({
        x,
        z: wz,
        nx: 0,
        nz: 1,
        tx: 1,
        tz: 0,
        s: 0,
        inlandZ: inZ,
        inlandY: gh(x, inZ),
        width: wz - inZ,
        dock: x > apMinX && x < apMaxX,
      });
    }
    flush();

    // shore normals and tangents from finite differences
    for (const span of this.spans) {
      const st = span.stations;
      for (let i = 0; i < st.length; i++) {
        const a = st[Math.max(0, i - 1)];
        const b = st[Math.min(st.length - 1, i + 1)];
        let tx = b.x - a.x;
        let tz = b.z - a.z;
        const l = Math.hypot(tx, tz) || 1;
        tx /= l;
        tz /= l;
        st[i].tx = tx;
        st[i].tz = tz;
        // seaward normal: rotate the tangent so it points to +z
        let nx = -tz;
        let nz = tx;
        if (nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        st[i].nx = nx;
        st[i].nz = nz;
      }
    }
  }

  /** z of the promenade parapet line at a given x (or a sane fallback). */
  private promenadeZAt(x: number): number {
    let best = 262;
    let bestD = Infinity;
    for (const p of this.promenade) {
      const d = Math.abs(p.x - x);
      if (d < bestD) {
        bestD = d;
        best = p.z;
      }
    }
    return bestD < 60 ? best : 262;
  }

  private rasteriseShoreLookup(): void {
    for (const span of this.spans) {
      for (const st of span.stations) {
        const i0 = Math.max(0, Math.round((st.x - SHORE_STEP * 0.5 - this.shoreX0) / this.shoreDX));
        const i1 = Math.min(
          this.shoreZByX.length - 1,
          Math.round((st.x + SHORE_STEP * 0.5 - this.shoreX0) / this.shoreDX),
        );
        for (let i = i0; i <= i1; i++) {
          this.shoreZByX[i] = st.z;
          this.inlandZByX[i] = st.inlandZ;
        }
      }
    }
  }

  /** z of the waterline at x, or NaN where there is no beach. */
  shoreZ(x: number): number {
    const i = Math.round((x - this.shoreX0) / this.shoreDX);
    if (i < 0 || i >= this.shoreZByX.length) return NaN;
    return this.shoreZByX[i];
  }

  /** z of the inland edge of the sand at x, or NaN. */
  beachInlandZ(x: number): number {
    const i = Math.round((x - this.shoreX0) / this.shoreDX);
    if (i < 0 || i >= this.inlandZByX.length) return NaN;
    return this.inlandZByX[i];
  }

  /**
   * True when (x,z) is on the sand apron this layer paints — including the
   * submerged terrace, which is why `Vegetation` and `CoastProps` also test
   * height before placing anything.
   */
  onBeach(x: number, z: number): boolean {
    const sz = this.shoreZ(x);
    if (!Number.isFinite(sz)) return false;
    const iz = this.inlandZByX[Math.round((x - this.shoreX0) / this.shoreDX)];
    return z > iz && z < sz + SUBMERGED_RUN;
  }

  /**
   * Height of the visible sand surface. Terrain plus the berm shaping the
   * beach mesh applies, so props sit exactly on the sand they are drawn on.
   */
  beachHeight(x: number, z: number): number {
    const base = this.layout.groundHeight(x, z);
    const sz = this.shoreZ(x);
    if (!Number.isFinite(sz)) return base + SAND_LIFT;
    return base + SAND_LIFT + bermProfile(x, z, sz);
  }

  /* ---------------------------------------------------------------- ramps */

  private buildRamps(): void {
    const rng = new RNG(0x5ea51de);
    const prom = this.promenade;
    if (prom.length < 8) return;

    /**
     * Walk to the nearest open-beach station at or after `f`. The shore is one
     * continuous span now, and a good chunk of its middle is cruise apron, so
     * a fraction alone is not a placement.
     */
    const openStation = (span: BeachSpan, f: number): ShoreStation | null => {
      const n = span.stations.length;
      const start = Math.floor(clamp(f, 0, 0.999) * n);
      for (let k = 0; k < n; k++) {
        // search outward from the target so a ramp lands near where it was asked for
        for (const i of [start + k, start - k]) {
          if (i < 2 || i >= n - 2) continue;
          const st = span.stations[i];
          if (!st.dock && st.width > 24) return st;
        }
      }
      return null;
    };

    /* --- slipways: wide concrete ramps letting you off the malecón --- */
    const beachSpans = this.spans.filter((s) => s.length > 90);
    for (const span of beachSpans) {
      for (const f of [0.12, 0.88]) {
        const st = openStation(span, f);
        if (!st) continue;
        const p = this.nearestPromenade(st.x, st.z);
        if (!p) continue;
        if (this.distToRamp(p.x, p.z) < 40) continue;
        this.ramps.push({
          kind: 'slipway',
          x: p.x + p.nx * 0.5,
          y: p.y,
          z: p.z + p.nz * 0.5,
          dx: p.nx,
          dz: p.nz,
          length: 22,
          rise: -(p.y - this.layout.groundHeight(p.x + p.nx * 22, p.z + p.nz * 22)),
          width: 11,
          lip: 0,
        });
      }
    }

    /* --- seawall kickers: launches off the malecón, out over the sand --- */
    const kickerAt = [0.2, 0.36, 0.62, 0.84];
    const total = prom[prom.length - 1].s;
    for (const f of kickerAt) {
      const target = total * f;
      const p = this.promenadeAtS(target);
      if (!p) continue;
      // only where there is actually beach to land on
      const sz = this.shoreZ(p.x);
      if (!Number.isFinite(sz)) continue;
      if (this.distToRamp(p.x, p.z) < 34) continue;
      this.ramps.push({
        kind: 'kicker',
        x: p.x - p.nx * 8,
        y: p.y,
        z: p.z - p.nz * 8,
        dx: p.nx,
        dz: p.nz,
        length: 11.5,
        rise: 2.15 + rng.range(-0.15, 0.35),
        width: 9,
        lip: 1.6,
      });
    }

    /* --- sand kickers: hit the tideline flat out and fly over the water --- */
    for (const span of beachSpans) {
      for (const f of [0.26, 0.74]) {
        const st = openStation(span, f);
        if (!st) continue;
        const foot = 16;
        const fx = st.x - st.nx * foot;
        const fz = st.z - st.nz * foot;
        if (this.distToRamp(fx, fz) < 34) continue;
        this.ramps.push({
          kind: 'sandKicker',
          x: fx,
          y: this.layout.groundHeight(fx, fz) + SAND_LIFT,
          z: fz,
          dx: st.nx,
          dz: st.nz,
          length: 13,
          rise: 2.6,
          width: 10,
          lip: 1.2,
        });
      }
    }
  }

  nearestPromenade(x: number, z: number): PromenadeStation | null {
    let best: PromenadeStation | null = null;
    let bestD = Infinity;
    for (const p of this.promenade) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  promenadeAtS(s: number): PromenadeStation | null {
    let best: PromenadeStation | null = null;
    let bestD = Infinity;
    for (const p of this.promenade) {
      const d = Math.abs(p.s - s);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Distance from (x,z) to the nearest ramp footprint centre, metres. */
  distToRamp(x: number, z: number): number {
    let best = Infinity;
    for (const r of this.ramps) {
      const cx = r.x + r.dx * r.length * 0.5;
      const cz = r.z + r.dz * r.length * 0.5;
      best = Math.min(best, Math.hypot(x - cx, z - cz));
    }
    return best;
  }

  /* -------------------------------------------------------------- surface */

  /** Lazily rasterised surface field. Built once, then O(1) per query. */
  surfaceAt(x: number, z: number): SurfaceKind {
    if (!this.surfaceGrid) this.buildSurfaceGrid();
    const g = this.surfaceGrid as Uint8Array;
    const i = Math.round((x - this.sMinX) / SURFACE_CELL);
    const j = Math.round((z - this.sMinZ) / SURFACE_CELL);
    if (i < 0 || j < 0 || i >= this.sgw || j >= this.sgh) return 'cobble';
    return SURFACE_NAME[g[j * this.sgw + i]];
  }

  private buildSurfaceGrid(): void {
    const b = DISTRICT_BOUNDS;
    this.sMinX = b.minX;
    this.sMinZ = b.minZ;
    this.sgw = Math.ceil((b.maxX - b.minX) / SURFACE_CELL) + 1;
    this.sgh = Math.ceil((b.maxZ - b.minZ) / SURFACE_CELL) + 1;
    const g = new Uint8Array(this.sgw * this.sgh).fill(SURFACE_CODE.cobble);
    this.surfaceGrid = g;

    const layout = this.layout;
    const roads = layout.roads;
    // the concrete network exposes an allocation-free query; 100 k `nearest`
    // calls each minting a result object is measurable at load time
    const fast = roads instanceof RoadNetworkImpl ? roads : null;
    const probe = new THREE.Vector3();
    const sample: EdgeSample = {
      edgeId: -1,
      t: 0,
      dist: Infinity,
      point: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
    };
    const query = (x: number, z: number): boolean => {
      probe.set(x, 0, z);
      if (fast) return fast.nearestInto(probe, 30, sample);
      const hit = roads.nearest(probe, 30);
      if (!hit) return false;
      sample.edgeId = hit.edgeId;
      sample.dist = hit.dist;
      return true;
    };

    const areaBox = layout.areas.map((area) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of area.polygon) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.y);
        maxZ = Math.max(maxZ, p.y);
      }
      return { minX, maxX, minZ, maxZ, area };
    });

    for (let j = 0; j < this.sgh; j++) {
      const z = this.sMinZ + j * SURFACE_CELL;
      const row = j * this.sgw;
      for (let i = 0; i < this.sgw; i++) {
        const x = this.sMinX + i * SURFACE_CELL;
        // Default is grass — the terrain mesh's own material. Anywhere with a
        // street within ~20 m is *inside* the built city, though, where the
        // gaps between buildings are paved yard and forecourt, not lawn; and a
        // surprise loss of grip in a courtyard is worse than a slightly
        // generous cobble reading.
        let code = SURFACE_CODE.grass;

        if (query(x, z)) {
          const ed = roads.edges[sample.edgeId];
          const sw = ed.kind === 'coastal' ? 3.2 : ed.kind === 'street' ? 2.4 : 0;
          if (sample.dist < ed.width * 0.5 + 0.7 + sw) {
            code =
              ed.kind === 'coastal' || ed.kind === 'ramp' ? SURFACE_CODE.asphalt : SURFACE_CODE.cobble;
          } else if (sample.dist < 20) {
            code = SURFACE_CODE.cobble;
          }
        }

        for (const box of areaBox) {
          if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
          if (!pointInPoly(box.area.polygon, x, z)) continue;
          code =
            box.area.surface === 'sand'
              ? SURFACE_CODE.sand
              : box.area.surface === 'grass'
                ? SURFACE_CODE.grass
                : box.area.surface === 'asphalt'
                  ? SURFACE_CODE.asphalt
                  : SURFACE_CODE.cobble;
        }

        // the beach always wins: it is painted over everything it touches
        if (code !== SURFACE_CODE.asphalt && this.onBeach(x, z)) code = SURFACE_CODE.sand;

        g[row + i] = code;
      }
    }
  }
}

/**
 * The berm: a low ridge of wind-blown sand a little inland of the waterline,
 * plus a wide, gentle swale behind it. Bounded to ±0.30 m so the visible sand
 * never parts company with the terrain collider under it.
 */
function bermProfile(x: number, z: number, shoreZ: number): number {
  const d = shoreZ - z; // metres inland of the waterline
  if (d < -2) return 0;
  const crest = 15 + fbm2D(x * 0.014, 3.1, 2, 6631) * 7;
  const ridge = Math.exp(-(((d - crest) / 9) ** 2)) * 0.30;
  const scour = -Math.exp(-(((d - 2.5) / 4.5) ** 2)) * 0.11;
  const ripple = Math.sin(d * 0.62 + fbm2D(x * 0.05, 1.7, 2, 33) * 3) * 0.045 * clamp01((d - 1) / 6);
  return (ridge + scour + ripple) * clamp01((d + 2) / 4);
}

function pointInPoly(poly: readonly THREE.Vector2[], x: number, y: number): boolean {
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

/* ========================================================================== *
 *  sand material
 * ========================================================================== */

interface SandUniforms {
  uTime: { value: number };
  uSeaLevel: { value: number };
  uDryCol: { value: THREE.Color };
  uWetCol: { value: THREE.Color };
  uFoamCol: { value: THREE.Color };
  uDuneCol: { value: THREE.Color };
}

/**
 * Sand shading, patched into a standard material so it still takes the sun,
 * the shadows and the wetness rig.
 *
 * `aCoast` carries, per vertex: `x` = 0 at the dune line → 1 at the waterline,
 * `y` = lateral dissolve mask, `z` = metres seaward of the waterline (signed).
 * The tideline itself is *not* baked: it is recomputed every frame from the
 * animated run-up so the foam line actually breathes up and down the beach.
 */
const SAND_COMMON = /* glsl */ `
float locoHash21( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}
float locoNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = locoHash21( i );
  float b = locoHash21( i + vec2( 1.0, 0.0 ) );
  float c = locoHash21( i + vec2( 0.0, 1.0 ) );
  float d = locoHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float locoFbm2( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 4; i ++ ) {
    s += locoNoise2( p ) * a;
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}
/** water edge height, in metres above sea level, at this point along the shore */
float locoRunUp( float t, float along ) {
  return 0.30 * sin( t * 0.34 + along * 0.019 )
       + 0.19 * sin( t * 0.58 - along * 0.031 + 1.7 )
       + 0.11 * sin( t * 1.02 + along * 0.047 + 4.1 );
}
`;

function makeSandMaterial(
  uniforms: SandUniforms,
  normalMap: THREE.Texture,
  tileMeters: number,
  coat: boolean,
): THREE.MeshStandardMaterial {
  /**
   * The tideline is the one place in the game where a mirror is *correct*:
   * the sheet of water left behind by a spent wave is millimetres deep over
   * packed sand, and it reflects the sky and the horizon almost perfectly. The
   * shader already computes `locoWet`; a clearcoat lobe keyed to it turns that
   * band from "darker sand" into water, which is the difference between a beach
   * and a beach-coloured surface. The lobe rides `nonPerturbedNormal`, so the
   * ripple normal map stops perturbing the reflection exactly where the water
   * covers the ripples.
   */
  const params = {
    name: 'loco/coastSand',
    color: 0xffffff,
    vertexColors: true,
    normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.94,
    metalness: 0,
    envMapIntensity: 0.85,
    alphaTest: 0.5,
    transparent: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  };
  const mat: THREE.MeshStandardMaterial = coat
    ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: 0.02, clearcoatRoughness: 0.08 })
    : new THREE.MeshStandardMaterial(params);
  // geometry hands UVs in tiles already, so the map itself stays at repeat 1
  normalMap.repeat.set(1, 1);
  void tileMeters;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'attribute vec3 aCoast;',
          'varying vec3 vCoast;',
          'varying vec3 vWorld;',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vCoast = aCoast;',
          'vWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
        ].join('\n'),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uTime;',
          'uniform float uSeaLevel;',
          'uniform vec3 uDryCol;',
          'uniform vec3 uWetCol;',
          'uniform vec3 uFoamCol;',
          'uniform vec3 uDuneCol;',
          'varying vec3 vCoast;',
          'varying vec3 vWorld;',
          SAND_COMMON,
        ].join('\n'),
      )
      .replace(
        '#include <alphamap_fragment>',
        [
          '#include <alphamap_fragment>',
          // --- lateral dissolve so the sand fades into the terrain, not a seam.
          // Alpha is binary (alphaTest 0.5): the noise decides which fragments
          // survive, which dithers the two surfaces together instead of drawing
          // a straight cut across the beach.
          // fine-grained, so the transition dissolves rather than breaking into
          // islands of lawn you can see from the road
          'float locoDither = clamp( locoFbm2( vWorld.xz * 1.35 ) * 1.1 + locoNoise2( vWorld.xz * 5.5 ) * 0.4 - 0.22, 0.0, 1.0 );',
          'float locoKeep = clamp( vCoast.y, 0.0, 1.0 );',
          'diffuseColor.a *= step( 1.0 - locoKeep, locoDither ) * step( 0.002, locoKeep );',
          // --- grain and ripples
          'float locoGrain = locoFbm2( vWorld.xz * 3.1 ) * 0.16 + locoNoise2( vWorld.xz * 11.0 ) * 0.07;',
          'float locoRip = sin( vWorld.z * 1.35 + locoFbm2( vWorld.xz * 0.28 ) * 7.0 ) * 0.5 + 0.5;',
          'locoRip *= smoothstep( 0.05, 0.55, vCoast.x ) * ( 1.0 - smoothstep( 0.86, 1.0, vCoast.x ) );',
          // --- the animated tideline
          'float locoAlong = vWorld.x;',
          'float locoEdge = uSeaLevel + locoRunUp( uTime, locoAlong ) + locoFbm2( vec2( locoAlong * 0.05, uTime * 0.07 ) ) * 0.42 - 0.2;',
          'float locoAbove = vWorld.y - locoEdge;',
          'float locoWet = 1.0 - smoothstep( -0.05, 1.15, locoAbove );',
          'locoWet = max( locoWet, 1.0 - smoothstep( -0.2, 2.4, vWorld.y - uSeaLevel ) * 0.55 );',
          'locoWet = clamp( locoWet, 0.0, 1.0 );',
          // --- foam: a bright ragged line right at the run-up edge
          'float locoFoamBand = smoothstep( 0.52, 0.0, abs( locoAbove - 0.10 ) );',
          'float locoFoamN = locoFbm2( vWorld.xz * 0.9 + vec2( 0.0, uTime * 0.55 ) );',
          'float locoFoam = locoFoamBand * smoothstep( 0.30, 0.72, locoFoamN ) * 1.15;',
          'locoFoam += smoothstep( 0.22, 0.0, abs( locoAbove - 0.02 ) ) * 0.45;',
          'locoFoam *= step( -1.6, locoAbove );',
          // --- assemble
          'vec3 locoSand = mix( uDryCol, uDuneCol, smoothstep( 0.34, 0.0, vCoast.x ) );',
          // broad drifts of slightly warmer and cooler sand, plus a band of
          // shell hash and dark mineral sand along the old high-tide line —
          // an unbroken field of one cream is what makes CG beaches look fake
          'float locoDrift = locoFbm2( vWorld.xz * 0.055 );',
          'locoSand *= mix( vec3( 0.93, 0.95, 1.02 ), vec3( 1.07, 1.03, 0.93 ), locoDrift );',
          'float locoHash = smoothstep( 0.55, 0.9, vCoast.x ) * ( 1.0 - smoothstep( 0.86, 0.99, vCoast.x ) );',
          'locoHash *= smoothstep( 0.42, 0.78, locoFbm2( vWorld.xz * 0.42 + 11.0 ) );',
          'locoSand = mix( locoSand, locoSand * vec3( 0.74, 0.71, 0.68 ), locoHash * 0.55 );',
          'locoSand *= 1.0 + ( locoGrain - 0.11 ) * 0.9 + locoRip * 0.055;',
          'locoSand = mix( locoSand, uWetCol, locoWet );',
          'locoSand = mix( locoSand, uFoamCol, clamp( locoFoam, 0.0, 0.92 ) );',
          'diffuseColor.rgb *= locoSand;',
          'float locoRough = mix( 0.95, 0.42, locoWet );',
          'locoRough = mix( locoRough, 0.72, clamp( locoFoam, 0.0, 1.0 ) );',
          'float locoFoamClamped = clamp( locoFoam, 0.0, 1.0 );',
        ].join('\n'),
      )
      .replace(
        '#include <roughnessmap_fragment>',
        ['#include <roughnessmap_fragment>', 'roughnessFactor = locoRough;'].join('\n'),
      );

    if (coat) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        [
          '#include <lights_physical_fragment>',
          // a sheet of water over packed sand, not a wet-looking powder: the
          // coat goes flat and near-mirror under the run-up and is killed by
          // foam, which is air, not water
          'material.clearcoat = clamp( locoWet * 0.92 * ( 1.0 - locoFoamClamped * 0.9 ), 0.0, 1.0 );',
          'material.clearcoatRoughness = max( 0.0525, mix( 0.30, 0.07, locoWet ) );',
          'clearcoatNormal = normalize( mix( normal, nonPerturbedNormal, locoWet ) );',
        ].join('\n'),
      );
    }
  };
  mat.customProgramCacheKey = () => (coat ? 'loco/coast-sand-v2cc' : 'loco/coast-sand-v2');
  return mat;
}

/* ========================================================================== *
 *  the layer
 * ========================================================================== */

export interface CoastOptions {
  /** metres of sand-mesh grid pitch; smaller = smoother tideline */
  cell?: number;
  /** build the seawall / promenade parapet */
  seawall?: boolean;
  /** build launch ramps and their colliders */
  ramps?: boolean;
  /** scatter rocks and riprap */
  rocks?: boolean;
}

export class Coast implements WorldLayer {
  readonly name = 'coast';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private opts: CoastOptions;
  private model: CoastModel | null = null;

  private uniforms: SandUniforms = {
    uTime: { value: 0 },
    uSeaLevel: { value: SEA_LEVEL },
    uDryCol: { value: new THREE.Color().setHex(0xe7d6ac, THREE.SRGBColorSpace) },
    uWetCol: { value: new THREE.Color().setHex(0x8d7a5c, THREE.SRGBColorSpace) },
    uFoamCol: { value: new THREE.Color().setHex(0xf6fbfa, THREE.SRGBColorSpace) },
    uDuneCol: { value: new THREE.Color().setHex(0xb2ab7d, THREE.SRGBColorSpace) },
  };

  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  /** per-cell riprap and boulder meshes, culled together */
  private rocks: THREE.InstancedMesh[] = [];
  private rockLod = new LodField();
  private textures: THREE.Texture[] = [];
  private bodies: BodyHandle[] = [];
  private physics: WorldOpts['physics'] | null = null;
  private _stats = { triangles: 0, drawCalls: 0, rocks: 0, ramps: 0 };

  constructor(quality: QualityTier, opts: CoastOptions = {}) {
    this.quality = quality;
    this.opts = { seawall: true, ramps: true, rocks: true, ...opts };
    this.group.name = 'world/coast';
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.physics = opts.physics;
    const model = coastModel(layout);
    this.model = model;
    const rng = opts.rng.fork(0xc0a5);

    this.buildBeach(model);
    if (this.opts.seawall) this.buildSeawall(model);
    if (this.opts.ramps) this.buildRamps(model, opts);
    if (this.opts.rocks) this.buildRocks(model, rng);

    // Build the grip raster now rather than on the vehicle's first query, so
    // the cost lands in the loading screen instead of in frame one.
    model.surfaceAt(0, 0);
    // …and publish it, so the tyre model can actually price sand and grass.
    // The vehicle module never imports the world; the world pushes this in.
    setSurfaceProbe((x, z) => model.surfaceAt(x, z));

    this._stats.drawCalls = this.group.children.length;
  }

  /**
   * Grip query for the vehicle. O(1) — a lookup into a 2.5 m raster built
   * during `build`. Safe to call per wheel per fixed step (measured at
   * ~0.1 µs, so 480 calls a second costs nothing).
   *
   * Returns `'cobble'` before the layer has built, which is the reference
   * surface the vehicle is already tuned for.
   */
  surfaceAt(x: number, z: number): SurfaceKind {
    return this.model ? this.model.surfaceAt(x, z) : 'cobble';
  }

  /** Convenience: the tuning multipliers for whatever is under (x, z). */
  gripAt(x: number, z: number): SurfaceGrip {
    return SURFACE_GRIP[this.surfaceAt(x, z)];
  }

  /** The shared shoreline model, for anything that wants to place props. */
  get coast(): CoastModel | null {
    return this.model;
  }

  /* ---------------------------------------------------------------- beach */

  private buildBeach(model: CoastModel): void {
    const cell = this.quality === 'low' ? BEACH_CELL * 1.6 : BEACH_CELL;
    const gb = new GeoBuilder().enableAux();
    const layout = model.layout;

    // Paved areas the sand must not cover: it runs *under* them and is cut
    // back out by the dissolve mask, so the cruise apron stays asphalt while
    // the ground either side of it still reads as shore.
    const cutouts = layout.areas
      .filter((a) => a.drivable && a.surface !== 'sand' && a.surface !== 'grass')
      .map((a) => {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of a.polygon) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.y);
          maxZ = Math.max(maxZ, p.y);
        }
        return { minX, maxX, minZ, maxZ, poly: a.polygon };
      });

    /** 0 inside a paved cutout, 1 clear of it, feathered over ~3 m. */
    const clearOfPaving = (x: number, z: number): number => {
      let keep = 1;
      for (const c of cutouts) {
        if (x < c.minX - 4 || x > c.maxX + 4 || z < c.minZ - 4 || z > c.maxZ + 4) continue;
        if (pointInPoly(c.poly, x, z)) return 0;
        // feather just outside so the sand does not butt hard against the kerb
        const dx = Math.max(c.minX - x, x - c.maxX, 0);
        const dz = Math.max(c.minZ - z, z - c.maxZ, 0);
        keep = Math.min(keep, clamp01(Math.hypot(dx, dz) / 3));
      }
      return keep;
    };

    for (const span of model.spans) {
      const st = span.stations;
      // resample the span at the mesh pitch so the tideline is smooth
      const cols = Math.max(2, Math.round(span.length / cell));
      const grid: Array<Array<{ p: THREE.Vector3; a: THREE.Vector3 }>> = [];

      for (let ci = 0; ci <= cols; ci++) {
        const s = (ci / cols) * span.length;
        const stn = sampleSpan(st, s);
        const inZ = stn.inlandZ;
        const outZ = stn.z + SUBMERGED_RUN;
        const rows = Math.max(4, Math.round((outZ - inZ) / cell));
        const col: Array<{ p: THREE.Vector3; a: THREE.Vector3 }> = [];
        for (let ri = 0; ri <= rows; ri++) {
          const f = ri / rows;
          const z = lerp(inZ, outZ, f);
          const x = stn.x;
          // 0 at the dune line, 1 at the waterline, >1 under water
          const inland01 = clamp((z - inZ) / Math.max(1, stn.z - inZ), 0, 1.6);
          let y: number;
          if (z <= stn.z) {
            y = layout.groundHeight(x, z) + SAND_LIFT + bermProfile(x, z, stn.z);
          } else {
            // submerged terrace: leave the terrain and settle onto a shelf, so
            // the shallows read as a broad turquoise sand bar rather than a cliff
            const t = clamp01((z - stn.z) / SUBMERGED_RUN);
            const shelf = SEA_LEVEL - TERRACE_DEPTH * smoothstep(t * 1.25);
            const terr = layout.groundHeight(x, z);
            y = Math.max(Math.min(shelf, terr + 0.4), terr - 2.2);
            y += Math.sin(z * 0.22 + x * 0.06) * 0.12 * (1 - t);
          }
          // lateral dissolve at the two ends of the span, and a hard cut
          // wherever a paved area already owns this ground
          const endFade = clamp01(Math.min(s, span.length - s) / 7);
          const keep = Math.min(endFade, clearOfPaving(x, z));
          col.push({
            p: new THREE.Vector3(x, y, z),
            a: new THREE.Vector3(Math.min(inland01, 1), keep, z - stn.z),
          });
        }
        grid.push(col);
      }

      // stitch: columns can differ in row count, so index by fraction
      const dryCol = 0xffffff;
      for (let ci = 0; ci < grid.length - 1; ci++) {
        const A = grid[ci];
        const B = grid[ci + 1];
        const n = Math.max(A.length, B.length) - 1;
        for (let ri = 0; ri < n; ri++) {
          const f0 = ri / n;
          const f1 = (ri + 1) / n;
          const a0 = pick(A, f0);
          const a1 = pick(A, f1);
          const b0 = pick(B, f0);
          const b1 = pick(B, f1);
          // rows march +z, columns march +x, so a0 -> a1 -> b1 -> b0 faces up
          const before = gb.aux.length;
          gb.quad(a0.p, a1.p, b1.p, b0.p, dryCol, 0.34, a0.a);
          if (gb.aux.length !== before + 12) continue; // degenerate, nothing emitted
          // quad() stamps one aux for all four corners; give each its own
          writeAux(gb.aux, before + 0, a0.a);
          writeAux(gb.aux, before + 3, a1.a);
          writeAux(gb.aux, before + 6, b1.a);
          writeAux(gb.aux, before + 9, b0.a);
        }
      }
    }

    const geo = gb.build();
    if (!geo) return;
    smoothNormals(geo);
    // World-space UVs. GeoBuilder gives every quad its own 0..1 span, which is
    // fine for a flat colour but would put a seam in the ripple normal map
    // every 2.4 m across the entire beach.
    worldUVs(geo, SAND_TILE);
    const normalMap = sandNormalTexture(256);
    this.textures.push(normalMap);
    const mat = makeSandMaterial(this.uniforms, normalMap, SAND_TILE, this.quality !== 'low');
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'coast/sand';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.materials.push(mat);
    this.geometries.push(geo);
    this._stats.triangles += gb.triangleCount;
  }

  /* -------------------------------------------------------------- seawall */

  private buildSeawall(model: CoastModel): void {
    const gb = new GeoBuilder();
    const prom = model.promenade;
    if (prom.length < 4) return;

    const STONE = 0xd9cfb4;
    const COPING = 0xefe9d8;
    const SHADOW = 0xbdb296;

    // mark gaps around every ramp so you can actually get through the parapet
    for (const p of prom) {
      p.gap = model.distToRamp(p.x, p.z) < 9.5;
    }

    let pilaster = 0;
    for (let i = 0; i < prom.length - 1; i++) {
      const a = prom[i];
      const b = prom[i + 1];
      if (a.gap || b.gap) continue;
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (seg < 0.05 || seg > 12) continue;

      const ay = a.y + 0.06;
      const by = b.y + 0.06;
      const t = PARAPET_T * 0.5;
      const h = PARAPET_H;

      // wall body — inner face, outer face, top
      const ai = _v0.set(a.x - a.nx * t, ay, a.z - a.nz * t);
      const ao = _v1.set(a.x + a.nx * t, ay, a.z + a.nz * t);
      const bi = _v2.set(b.x - b.nx * t, by, b.z - b.nz * t);
      const bo = _v3.set(b.x + b.nx * t, by, b.z + b.nz * t);

      const aiT = ai.clone().setY(ay + h);
      const aoT = ao.clone().setY(ay + h);
      const biT = bi.clone().setY(by + h);
      const boT = bo.clone().setY(by + h);

      const seaward = new THREE.Vector3(a.nx, 0, a.nz);
      const landward = seaward.clone().negate();

      gb.quadTowards(ai.clone(), aiT, biT, bi.clone(), STONE, 0.55, landward);
      gb.quadTowards(ao.clone(), aoT, boT, bo.clone(), SHADOW, 0.55, seaward);
      gb.quadTowards(aiT, aoT, boT, biT, COPING, 0.9, UP);

      // the drop below the coping on the sea side: a rubble skirt
      const drop = 1.5;
      gb.quadTowards(
        ao.clone(),
        ao.clone().setY(ay - drop),
        bo.clone().setY(by - drop),
        bo.clone(),
        SHADOW,
        0.45,
        seaward,
      );

      // pilasters every ~13 m, which is what stops the run reading as extruded
      pilaster += seg;
      if (pilaster > 13) {
        pilaster = 0;
        gb.box(a.x, ay + h * 0.5 + 0.16, a.z, 0.46, h * 0.5 + 0.16, 0.46, COPING, Math.atan2(a.nx, a.nz));
        gb.box(a.x, ay + h + 0.36, a.z, 0.30, 0.2, 0.30, STONE, Math.atan2(a.nx, a.nz));
      }
    }

    const geo = gb.build();
    if (!geo) return;
    const mat = new THREE.MeshStandardMaterial({
      name: 'loco/coastSeawall',
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
      envMapIntensity: 0.8,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'coast/seawall';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.materials.push(mat);
    this.geometries.push(geo);
    this._stats.triangles += gb.triangleCount;
  }

  /* ---------------------------------------------------------------- ramps */

  private buildRamps(model: CoastModel, opts: WorldOpts): void {
    const gb = new GeoBuilder();
    const colPos: number[] = [];
    const colIdx: number[] = [];

    for (const r of model.ramps) {
      buildRamp(r, gb, colPos, colIdx, model);
      this._stats.ramps++;
    }

    const geo = gb.build();
    if (geo) {
      const mat = new THREE.MeshStandardMaterial({
        name: 'loco/coastRamp',
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.75,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'coast/ramps';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.materials.push(mat);
      this.geometries.push(geo);
      this._stats.triangles += gb.triangleCount;
    }

    if (colIdx.length > 0) {
      this.bodies.push(
        opts.physics.createBody({
          kind: 'static',
          shape: {
            type: 'trimesh',
            vertices: new Float32Array(colPos),
            indices: new Uint32Array(colIdx),
          },
          position: new THREE.Vector3(0, 0, 0),
          friction: 0.95,
          restitution: 0.02,
          group: GROUP.WORLD,
          mask: GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS,
          userData: { kind: 'world', surface: 'ramp' },
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- rocks */

  private buildRocks(model: CoastModel, rng: RNG): void {
    const density = COAST_DENSITY[this.quality];
    const variants = 4;
    const geos: THREE.BufferGeometry[] = [];
    for (let v = 0; v < variants; v++) geos.push(rockGeometry(rng.fork(v * 977 + 3)));

    const mat = new THREE.MeshStandardMaterial({
      name: 'loco/coastRock',
      vertexColors: true,
      roughness: 0.93,
      metalness: 0,
      envMapIntensity: 0.7,
      flatShading: true,
    });
    this.materials.push(mat);

    const buckets: THREE.Matrix4[][] = geos.map(() => []);
    const scratch = new THREE.Vector3();
    const scale = new THREE.Vector3();

    for (const span of model.spans) {
      const st = span.stations;
      const count = Math.round(span.length * 0.34 * density);
      for (let i = 0; i < count; i++) {
        const s = rng.next() * span.length;
        const stn = sampleSpan(st, s);
        // the armoured dock frontage is dense riprap right on the waterline;
        // open beach gets a sparse scatter across the whole apron
        const riprap = stn.dock;
        if (!riprap && rng.bool(0.55)) continue;
        const off = riprap ? rng.range(-4, 7) : rng.range(-26, 16);
        const x = stn.x + stn.nx * off + rng.range(-2.4, 2.4);
        const z = stn.z + stn.nz * off + rng.range(-2.4, 2.4);
        if (model.distToRamp(x, z) < 11) continue;
        const y = model.beachHeight(x, z);
        if (!riprap && y > stn.inlandY + 0.6) continue;
        const size = riprap ? rng.range(0.85, 2.2) : rng.range(0.28, 1.25);
        scale.set(size * rng.range(0.8, 1.3), size * rng.range(0.55, 0.95), size * rng.range(0.8, 1.3));
        scratch.set(x, y - size * 0.22, z);
        _q.setFromEuler(new THREE.Euler(rng.range(-0.2, 0.2), rng.range(0, Math.PI * 2), rng.range(-0.2, 0.2)));
        const m = new THREE.Matrix4().compose(scratch, _q, scale);
        buckets[rng.int(0, variants - 1)].push(m);
      }
    }

    // headland boulders where the west shore meets the fort promontory
    for (let i = 0; i < Math.round(46 * density); i++) {
      const x = rng.range(-372, -330);
      const z = rng.range(258, 322);
      const y = model.layout.groundHeight(x, z);
      if (y < -3.4 || y > 7) continue;
      const size = rng.range(0.9, 2.9);
      scale.set(size * rng.range(0.8, 1.35), size * rng.range(0.6, 1.1), size * rng.range(0.8, 1.35));
      scratch.set(x, y - size * 0.25, z);
      _q.setFromEuler(new THREE.Euler(rng.range(-0.25, 0.25), rng.range(0, Math.PI * 2), rng.range(-0.25, 0.25)));
      buckets[rng.int(0, variants - 1)].push(new THREE.Matrix4().compose(scratch, _q, scale));
    }

    for (let v = 0; v < variants; v++) {
      const list = buckets[v];
      if (list.length === 0) {
        geos[v].dispose();
        continue;
      }
      /* One mesh per variant *per cell*. The riprap runs the length of the
       * shore, so a single mesh per variant has a district-sized bounding
       * sphere and is drawn — and shadow-cast — from anywhere on the map. */
      const cells = bucketByCell(list, ROCK_CELL, (m) => ({
        x: m.elements[12],
        z: m.elements[14],
      }));
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const inst = new THREE.InstancedMesh(geos[v], mat, cell.items.length);
        inst.name = `coast/rocks${v}/${c}`;
        for (let i = 0; i < cell.items.length; i++) inst.setMatrixAt(i, cell.items[i]);
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = true;
        inst.computeBoundingSphere();
        this.group.add(inst);
        this.rocks.push(inst);
        const foot = bucketFootprint(cell, 4);
        this.rockLod.add(inst, foot.cx, foot.cz, foot.radius);
        this._stats.rocks += cell.items.length;
      }
      // the variant geometry is shared by every cell that uses it; it carries
      // no per-instance attribute, so one copy is enough
      this.geometries.push(geos[v]);
      const tri = (geos[v].index?.count ?? geos[v].getAttribute('position').count) / 3;
      this._stats.triangles += tri * list.length;
    }
  }

  /* -------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number): void {
    this.uniforms.uTime.value += dt;
    // Boulders read as the shore's silhouette, so they hold to `drawDistance`
    // rather than the prop cut; the win here is the frustum, not the range.
    this.rockLod.update(
      cameraPos,
      QUALITY_BUDGET[this.quality].drawDistance,
      TALL_SHADOW_CUT[this.quality],
    );
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const d = QUALITY_BUDGET[tier].propDetailDistance;
    this.rockLod.setEnabled(() => true, d > 60);
  }

  stats(): Record<string, number> {
    return {
      coastTriangles: Math.round(this._stats.triangles),
      coastDrawCalls: this.group.children.length,
      coastRocks: this._stats.rocks,
      coastRamps: this._stats.ramps,
      coastSpans: this.model?.spans.length ?? 0,
    };
  }

  dispose(): void {
    setSurfaceProbe(null);
    this.rockLod.clear();
    for (const m of this.rocks) m.dispose();
    this.rocks.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    if (this.physics) for (const b of this.bodies) this.physics.removeBody(b);
    this.bodies.length = 0;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ========================================================================== *
 *  helpers
 * ========================================================================== */

function writeAux(aux: number[], at: number, v: THREE.Vector3): void {
  if (at < 0 || at + 2 >= aux.length) return;
  aux[at] = v.x;
  aux[at + 1] = v.y;
  aux[at + 2] = v.z;
}

function pick<T>(arr: T[], f: number): T {
  return arr[clamp(Math.round(f * (arr.length - 1)), 0, arr.length - 1)];
}

/** Linear interpolation of a shore span at arc length `s`. */
export function sampleSpan(st: ShoreStation[], s: number): ShoreStation {
  if (st.length === 1 || s <= st[0].s) return st[0];
  const last = st[st.length - 1];
  if (s >= last.s) return last;
  let lo = 0;
  let hi = st.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = st[lo];
  const b = st[hi];
  const f = (s - a.s) / Math.max(1e-4, b.s - a.s);
  return {
    x: lerp(a.x, b.x, f),
    z: lerp(a.z, b.z, f),
    nx: lerp(a.nx, b.nx, f),
    nz: lerp(a.nz, b.nz, f),
    tx: lerp(a.tx, b.tx, f),
    tz: lerp(a.tz, b.tz, f),
    s,
    inlandZ: lerp(a.inlandZ, b.inlandZ, f),
    inlandY: lerp(a.inlandY, b.inlandY, f),
    width: lerp(a.width, b.width, f),
    dock: f < 0.5 ? a.dock : b.dock,
  };
}

/** Replaces per-quad UVs with continuous world-space ones, in tiles. */
function worldUVs(geo: THREE.BufferGeometry, tileMeters: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const inv = 1 / tileMeters;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) * inv, pos.getZ(i) * inv);
  }
  uv.needsUpdate = true;
}

/**
 * Sand relief: wind ripples running roughly shore-parallel, a coarser swale
 * modulation, and a fine grain so the beach is not a flat matte plane under
 * a low sun. Tiles seamlessly.
 */
function sandNormalTexture(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      // periodic ripple trains at two angles so they never read as stripes
      let e = Math.sin((v * 9 + u * 2) * Math.PI * 2 + Math.sin(u * Math.PI * 4) * 0.9) * 0.34;
      e += Math.sin((v * 21 - u * 5) * Math.PI * 2) * 0.13;
      e += fbm2D(u * 6, v * 6, 4, 4409) * 0.55;
      e += valueNoise2D(u * 42, v * 42, 613) * 0.13;
      // scattered shell / pebble pits
      const pit = valueNoise2D(u * 17 + 3, v * 17 + 9, 271);
      if (pit > 0.72) e -= (pit - 0.72) * 1.6;
      h[j * size + i] = e;
    }
  }
  const wrap = (x: number): number => ((x % size) + size) % size;
  const at = (x: number, y: number): number => h[wrap(y) * size + wrap(x)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * 2.1;
      const dy = (at(x, y - 1) - at(x, y + 1)) * 2.1;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((dx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/sandNormal';
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Averages normals across shared positions so the beach shades smoothly. */
function smoothNormals(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  if (!idx) return;
  const map = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 8)},${Math.round(pos.getZ(i) * 8)}`;
    let l = map.get(key);
    if (!l) map.set(key, (l = []));
    l.push(i);
  }
  for (const list of map.values()) {
    if (list.length < 2) continue;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const i of list) {
      nx += nrm.getX(i);
      ny += nrm.getY(i);
      nz += nrm.getZ(i);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const i of list) nrm.setXYZ(i, nx, ny, nz);
  }
  nrm.needsUpdate = true;
}

/**
 * One ramp: a curved deck (so it flicks the nose up instead of stubbing it),
 * kerbs down both sides and a solid apron underneath. Writes both render
 * geometry and a matching collider.
 */
function buildRamp(
  r: RampSpec,
  gb: GeoBuilder,
  colPos: number[],
  colIdx: number[],
  model: CoastModel,
): void {
  const SEG = 18;
  const dx = r.dx;
  const dz = r.dz;
  const px = -dz;
  const pz = dx;
  const hw = r.width * 0.5;

  // Real slipways and ramps are cast with transverse grip ribs, which is both
  // what they look like and what makes an otherwise blank wedge read as a
  // surface with a direction from 55 m out (§6.2 R4).
  const sandy = r.kind === 'sandKicker';
  const concrete = sandy ? 0xc9b894 : 0xc3bfb2;
  const ribCol = sandy ? 0xb2a17c : 0xa9a598;
  const kerbCol = sandy ? 0xb08d5a : 0xb9553a;
  const flankCol = sandy ? 0xd2c19a : 0xbeb9ab;
  const flankMid = sandy ? 0xb9a684 : 0xa8a396;
  const flankLow = sandy ? 0x97866a : 0x8b877d;

  const deckY = (t: number): number => {
    if (r.kind === 'slipway') return r.y + r.rise * t;
    // ease-in curve: shallow at the foot, steep at the lip
    const e = t * t * (3 - 2 * t) * 0.35 + t * t * 0.65;
    return r.y + r.rise * e;
  };
  const at = (t: number, side: number, out: THREE.Vector3): THREE.Vector3 => {
    const d = t * r.length;
    return out.set(r.x + dx * d + px * side * hw, deckY(t), r.z + dz * d + pz * side * hw);
  };

  const addColQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
    const base = colPos.length / 3;
    colPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    colIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const outward = new THREE.Vector3();

  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG;
    const t1 = (i + 1) / SEG;
    at(t0, -1, a);
    at(t0, 1, b);
    at(t1, 1, c);
    at(t1, -1, d);
    // grip ribs: alternating cast bands. Colour only — a real raised rib would
    // put a 3 cm staircase into the collider and make the launch judder.
    const rib = (i & 1) === 0;
    gb.quad(a.clone(), b.clone(), c.clone(), d.clone(), rib ? ribCol : concrete, 0.4);
    addColQuad(a.clone(), b.clone(), c.clone(), d.clone());

    // Flanks down to the ground on both sides. A ramp on a falling beach can
    // stand four metres proud at its lip, and one flat quad that size reads as
    // a blank wall dropped on the sand — so it is coursed, and a sand kicker is
    // faced in sand because that is what it is: a bermed-up ramp, not a slab.
    for (const side of [-1, 1]) {
      at(t0, side, a);
      at(t1, side, b);
      const g0 = model.layout.groundHeight(a.x, a.z) - 1.1;
      const g1 = model.layout.groundHeight(b.x, b.z) - 1.1;
      outward.set(px * side, 0, pz * side);
      const COURSES = 3;
      for (let k = 0; k < COURSES; k++) {
        const f0 = k / COURSES;
        const f1 = (k + 1) / COURSES;
        const top0 = lerp(a.y, Math.min(g0, a.y), f0);
        const top1 = lerp(b.y, Math.min(g1, b.y), f0);
        const bot0 = lerp(a.y, Math.min(g0, a.y), f1);
        const bot1 = lerp(b.y, Math.min(g1, b.y), f1);
        // courses darken downward: contact shadow at the foot, per §8
        const shade = k === 0 ? flankCol : k === 1 ? flankMid : flankLow;
        gb.quadTowards(
          a.clone().setY(top0),
          b.clone().setY(top1),
          b.clone().setY(bot1),
          a.clone().setY(bot0),
          shade,
          0.45,
          outward,
        );
      }
    }
  }

  // kerbs: 0.18 m raised edges, painted, so the ramp reads from 55 m (R4)
  if (r.kind !== 'slipway') {
    for (const side of [-1, 1]) {
      for (let i = 0; i < SEG; i++) {
        const t0 = i / SEG;
        const t1 = (i + 1) / SEG;
        at(t0, side, a);
        at(t1, side, b);
        const stripe = (i & 1) === 0 ? kerbCol : 0xf4efe2;
        outward.set(px * side, 0, pz * side);
        // outer face of the kerb
        gb.quadTowards(
          a.clone(),
          b.clone(),
          b.clone().setY(b.y + 0.2),
          a.clone().setY(a.y + 0.2),
          stripe,
          0.6,
          outward,
        );
        // top of the kerb, kicked slightly outboard
        const oa = a.clone().setY(a.y + 0.2).addScaledVector(outward, 0.22);
        const ob = b.clone().setY(b.y + 0.2).addScaledVector(outward, 0.22);
        gb.quadTowards(
          a.clone().setY(a.y + 0.2),
          b.clone().setY(b.y + 0.2),
          ob,
          oa,
          stripe,
          0.6,
          UP,
        );
      }
    }
  }

  // the lip: a short flat overhang so the launch angle is crisp
  if (r.lip > 0) {
    at(1, -1, a);
    at(1, 1, b);
    c.set(b.x + dx * r.lip, b.y + 0.04, b.z + dz * r.lip);
    d.set(a.x + dx * r.lip, a.y + 0.04, a.z + dz * r.lip);
    gb.quad(a.clone(), b.clone(), c.clone(), d.clone(), 0xf4efe2, 0.5);
    addColQuad(a.clone(), b.clone(), c.clone(), d.clone());
    // front face of the lip
    gb.quad(
      d.clone(),
      c.clone(),
      c.clone().setY(c.y - 1.4),
      d.clone().setY(d.y - 1.4),
      0xb9553a,
      0.5,
    );
  }
}

/** A blocky, believable beach boulder. Flat-shaded, ~64 triangles. */
function rockGeometry(rng: RNG): THREE.BufferGeometry {
  const src = new THREE.IcosahedronGeometry(1, 1);
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const col: number[] = [];
  const c = new THREE.Color();
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let v = seen.get(key);
    if (!v) {
      v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const f = 1 + fbm2D(v.x * 1.9 + 3, v.z * 1.9 + rng.next() * 40, 3, 5501) * 0.55;
      v.multiplyScalar(f);
      v.x *= 1 + rng.range(-0.18, 0.18);
      v.z *= 1 + rng.range(-0.18, 0.18);
      v.y *= 0.78;
      seen.set(key, v);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  src.computeVertexNormals();
  for (let i = 0; i < pos.count; i++) {
    const shade = 0.72 + fbm2D(pos.getX(i) * 3.1, pos.getZ(i) * 3.1, 2, 811) * 0.5;
    c.setHex(0x8e8a80, THREE.SRGBColorSpace);
    col.push(c.r * shade, c.g * shade * 0.99, c.b * shade * 0.93);
  }
  src.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  src.computeBoundingSphere();
  return src;
}
