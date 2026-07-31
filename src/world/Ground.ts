/**
 * Loco Lift — drivable surface construction.
 *
 * Turns the abstract `CityLayout` into real geometry and one physics collider:
 *
 *  - **street ribbons** extruded along every road edge with a proper kerbed
 *    cross-section (crowned carriageway, gutter, kerb face, kerb stone,
 *    pavement), stepped treads and risers for the stair streets, wedges for
 *    the jump ramps and a central channel for the alleys;
 *  - **intersection pads** fanned through every incoming ribbon corner in
 *    bearing order, so junctions read as one continuous stone surface even
 *    where a 20% street meets a 4 m alley;
 *  - **open areas** (plazas, market floor, glacis, apron, beach) triangulated
 *    and uniformly subdivided so they conform to the carved ground;
 *  - **filler terrain** on a coarse grid, with every quad that lives under a
 *    road or a plaza culled away;
 *  - **the sea**, a wide plane driven by the material library's swell shader.
 *
 * Everything is accumulated into buckets keyed by `material | spatial chunk`,
 * so the district draws in a few dozen calls and still frustum-culls properly.
 * The physics collider is one static trimesh built from the same buckets
 * (minus the sea), which keeps the collision surface exactly where the player
 * sees it without a second, denser mesh.
 */
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle, PhysicsWorldAPI } from '../physics/PhysicsTypes';
import { DISTRICT_BOUNDS, SEA_LEVEL } from './CityLayout';
import type { MaterialId, MaterialLibrary } from './Materials';
import { RoadNetworkImpl } from './RoadNetwork';
import type { CityLayout, OpenArea, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------- constants */

const SIDEWALK_W = 2.4;
const COASTAL_SIDEWALK_W = 3.2;
const GUTTER_W = 0.4;
const KERB_W = 0.22;
const KERB_H = 0.14;
const CROWN = 0.055;
const STAIR_RISE = 0.17;
/** filler terrain resolution, metres */
const TERRAIN_CELL = 6;
/** how far past the district bounds the terrain skirt runs */
const TERRAIN_SKIRT = 90;
const SEA_SPAN = 2600;
/** spatial chunk grid for frustum culling */
const CHUNKS = 3;

/* ---------------------------------------------------------------- buckets */

class MeshBucket {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] | null;
  readonly idx: number[] = [];
  private n = 0;

  constructor(withColor: boolean) {
    this.col = withColor ? [] : null;
  }

  get vertexCount(): number {
    return this.n;
  }

  vertex(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r = 1, g = 1, b = 1,
  ): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    if (this.col) this.col.push(r, g, b);
    return this.n++;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ----------------------------------------------------------- cross-section */

/** one lateral span of a road cross-section, painted with a single material */
interface Lane {
  from: number;
  to: number;
  mat: MaterialId;
}

interface Profile {
  /** [lateral offset in metres, height above the centreline] */
  pts: Array<[number, number]>;
  lanes: Lane[];
}

function streetProfile(hw: number, sidewalk: number, roadMat: MaterialId): Profile {
  const k0 = hw + GUTTER_W;
  const k1 = k0 + KERB_W;
  const s1 = k1 + sidewalk;
  return {
    pts: [
      [-s1, KERB_H + 0.05],
      [-k1, KERB_H + 0.01],
      [-k0, KERB_H],
      [-k0, -0.05],
      [-hw, -0.02],
      [0, CROWN],
      [hw, -0.02],
      [k0, -0.05],
      [k0, KERB_H],
      [k1, KERB_H + 0.01],
      [s1, KERB_H + 0.05],
    ],
    lanes: [
      { from: 0, to: 1, mat: 'sidewalk' },
      { from: 1, to: 2, mat: 'kerb' },
      { from: 2, to: 3, mat: 'kerb' },
      { from: 3, to: 4, mat: 'gutter' },
      { from: 4, to: 5, mat: roadMat },
      { from: 5, to: 6, mat: roadMat },
      { from: 6, to: 7, mat: 'gutter' },
      { from: 7, to: 8, mat: 'kerb' },
      { from: 8, to: 9, mat: 'kerb' },
      { from: 9, to: 10, mat: 'sidewalk' },
    ],
  };
}

function alleyProfile(hw: number): Profile {
  return {
    pts: [
      [-hw, 0.06],
      [-hw * 0.34, -0.015],
      [0, -0.09],
      [hw * 0.34, -0.015],
      [hw, 0.06],
    ],
    lanes: [
      { from: 0, to: 1, mat: 'alley' },
      { from: 1, to: 2, mat: 'gutter' },
      { from: 2, to: 3, mat: 'gutter' },
      { from: 3, to: 4, mat: 'alley' },
    ],
  };
}

function stairProfile(hw: number): Profile {
  return {
    pts: [
      [-hw, 0.24],
      [-hw + 0.38, 0],
      [0, 0.01],
      [hw - 0.38, 0],
      [hw, 0.24],
    ],
    lanes: [
      { from: 0, to: 1, mat: 'stairs' },
      { from: 1, to: 2, mat: 'stairs' },
      { from: 2, to: 3, mat: 'stairs' },
      { from: 3, to: 4, mat: 'stairs' },
    ],
  };
}

function flatProfile(hw: number, mat: MaterialId, crown = 0.04): Profile {
  return {
    pts: [
      [-hw, 0],
      [0, crown],
      [hw, 0],
    ],
    lanes: [
      { from: 0, to: 1, mat },
      { from: 1, to: 2, mat },
    ],
  };
}

/* ----------------------------------------------------------------- ground */

export interface GroundStats {
  meshes: number;
  triangles: number;
  colliderTriangles: number;
  buildMs: number;
}

export class Ground implements WorldLayer {
  readonly name = 'ground';
  readonly group = new THREE.Group();

  private materials: MaterialLibrary;
  private physics: PhysicsWorldAPI;
  private quality: QualityTier;

  private buckets = new Map<string, MeshBucket>();
  private meshes: THREE.Mesh[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private body: BodyHandle | null = null;

  /** collision accumulation, filled in parallel with the visual buckets */
  private colPos: number[] = [];
  private colIdx: number[] = [];

  private layout: CityLayout | null = null;
  private _stats: GroundStats = { meshes: 0, triangles: 0, colliderTriangles: 0, buildMs: 0 };

  private tmpP = new THREE.Vector3();
  private tmpT = new THREE.Vector3();
  private tmpR = new THREE.Vector3();

  constructor(materials: MaterialLibrary, physics: PhysicsWorldAPI, quality: QualityTier) {
    this.materials = materials;
    this.physics = physics;
    this.quality = quality;
    this.group.name = 'world/ground';
  }

  get stats(): GroundStats {
    return this._stats;
  }

  /* ------------------------------------------------------------- build */

  build(layout: CityLayout, _opts: WorldOpts): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.layout = layout;
    const roads = layout.roads as RoadNetworkImpl;

    this.buildRoads(roads);
    this.buildIntersections(roads);
    this.buildAreas(layout);
    this.buildTerrain(layout, roads);

    this.flushBuckets();
    this.buildSea();
    this.buildCollider();

    this._stats.buildMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    );
  }

  /* ------------------------------------------------------------ helpers */

  private chunkOf(x: number, z: number): number {
    const fx = clamp(
      Math.floor(((x - DISTRICT_BOUNDS.minX) / (DISTRICT_BOUNDS.maxX - DISTRICT_BOUNDS.minX)) * CHUNKS),
      0, CHUNKS - 1,
    );
    const fz = clamp(
      Math.floor(((z - DISTRICT_BOUNDS.minZ) / (DISTRICT_BOUNDS.maxZ - DISTRICT_BOUNDS.minZ)) * CHUNKS),
      0, CHUNKS - 1,
    );
    return fz * CHUNKS + fx;
  }

  private bucket(mat: MaterialId, chunk: number, withColor = false): MeshBucket {
    const key = `${mat}|${chunk}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = new MeshBucket(withColor);
      this.buckets.set(key, b);
    }
    return b;
  }

  /**
   * Emit a quad into the right bucket and mirror it into the collision mesh.
   * `a..d` are world-space corners in winding order.
   */
  private emitQuad(
    mat: MaterialId,
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    ua: THREE.Vector2, ub: THREE.Vector2, uc: THREE.Vector2, ud: THREE.Vector2,
    collide = true,
  ): void {
    const cx = (a.x + b.x + c.x + d.x) * 0.25;
    const cz = (a.z + b.z + c.z + d.z) * 0.25;
    const bucket = this.bucket(mat, this.chunkOf(cx, cz));

    // face normal from the diagonals — robust for skewed ribbon quads
    const e1x = c.x - a.x;
    const e1y = c.y - a.y;
    const e1z = c.z - a.z;
    const e2x = d.x - b.x;
    const e2y = d.y - b.y;
    const e2z = d.z - b.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len;
    ny /= len;
    nz /= len;
    if (ny < 0) {
      // ribbons are viewed from above; keep every face pointing up-ish
      nx = -nx; ny = -ny; nz = -nz;
      const i0 = bucket.vertex(d.x, d.y, d.z, nx, ny, nz, ud.x, ud.y);
      const i1 = bucket.vertex(c.x, c.y, c.z, nx, ny, nz, uc.x, uc.y);
      const i2 = bucket.vertex(b.x, b.y, b.z, nx, ny, nz, ub.x, ub.y);
      const i3 = bucket.vertex(a.x, a.y, a.z, nx, ny, nz, ua.x, ua.y);
      bucket.quad(i0, i1, i2, i3);
      if (collide) this.collideQuad(d, c, b, a);
      return;
    }
    const i0 = bucket.vertex(a.x, a.y, a.z, nx, ny, nz, ua.x, ua.y);
    const i1 = bucket.vertex(b.x, b.y, b.z, nx, ny, nz, ub.x, ub.y);
    const i2 = bucket.vertex(c.x, c.y, c.z, nx, ny, nz, uc.x, uc.y);
    const i3 = bucket.vertex(d.x, d.y, d.z, nx, ny, nz, ud.x, ud.y);
    bucket.quad(i0, i1, i2, i3);
    if (collide) this.collideQuad(a, b, c, d);
  }

  private collideQuad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
    const base = this.colPos.length / 3;
    this.colPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    this.colIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  private collideTri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const base = this.colPos.length / 3;
    this.colPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.colIdx.push(base, base + 1, base + 2);
  }

  /* -------------------------------------------------------- road ribbons */

  /** how far back from a node the ribbon stops so the junction pad can fill in */
  private padRadius(roads: RoadNetworkImpl, nodeId: number): number {
    const node = roads.nodes[nodeId];
    let widest = 0;
    let shortest = Infinity;
    for (const e of node.edges) {
      const ed = roads.edges[e];
      if (ed.kind === 'ramp') continue;
      widest = Math.max(widest, ed.width);
      shortest = Math.min(shortest, ed.length);
    }
    if (widest === 0) return 0;
    return Math.min(widest * 0.62 + 0.5, shortest * 0.32);
  }

  private profileFor(kind: string, hw: number): Profile {
    switch (kind) {
      case 'coastal':
        return streetProfile(hw, COASTAL_SIDEWALK_W, 'roadCoastal');
      case 'alley':
        return alleyProfile(hw);
      case 'stairs':
        return stairProfile(hw);
      case 'ramp':
        return flatProfile(hw, 'ramp', 0.09);
      case 'plaza':
        return flatProfile(hw, 'roadPlaza', 0.05);
      default:
        return streetProfile(hw, SIDEWALK_W, 'road');
    }
  }

  private buildRoads(roads: RoadNetworkImpl): void {
    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];
    const lateral: number[] = [];

    for (let e = 0; e < roads.edges.length; e++) {
      const ed = roads.edges[e];
      if (ed.kind === 'rooftop') continue;
      const hw = ed.width * 0.5;
      const profile = this.profileFor(ed.kind, hw);

      // cumulative lateral distance for U coordinates
      lateral.length = 0;
      let acc = 0;
      lateral.push(0);
      for (let i = 1; i < profile.pts.length; i++) {
        acc += Math.hypot(
          profile.pts[i][0] - profile.pts[i - 1][0],
          profile.pts[i][1] - profile.pts[i - 1][1],
        );
        lateral.push(acc);
      }

      // a ramp starts at its foot node so its deck meets the junction pad
      const rA = ed.kind === 'ramp' ? 0 : this.padRadius(roads, ed.a);
      const rB = ed.kind === 'ramp' ? 0 : this.padRadius(roads, ed.b);
      const t0 = clamp01(rA / ed.length);
      const t1 = 1 - clamp01(rB / ed.length);
      const usable = ed.length * (t1 - t0);
      if (usable < 1.2) continue;

      const isStairs = ed.kind === 'stairs';
      const spacing = isStairs ? 1.1 : ed.via.length > 0 ? 4 : 12;
      const steps = Math.max(1, Math.round(usable / spacing));

      // pre-sample the stations
      const px: number[] = [];
      const py: number[] = [];
      const pz: number[] = [];
      const rx: number[] = [];
      const rz: number[] = [];
      const arc: number[] = [];
      for (let s = 0; s <= steps; s++) {
        const t = lerp(t0, t1, s / steps);
        roads.sample(e, t, 0, this.tmpP);
        roads.tangent(e, t, this.tmpT);
        const inv = 1 / Math.max(1e-5, Math.hypot(this.tmpT.x, this.tmpT.z));
        px.push(this.tmpP.x);
        py.push(this.tmpP.y);
        pz.push(this.tmpP.z);
        rx.push(-this.tmpT.z * inv);
        rz.push(this.tmpT.x * inv);
        arc.push(ed.length * (t - t0));
      }

      // stair streets: quantise the profile into treads
      const yUse = py.slice();
      if (isStairs) {
        const y0 = py[0];
        for (let s = 0; s <= steps; s++) {
          yUse[s] = y0 + Math.round((py[s] - y0) / STAIR_RISE) * STAIR_RISE;
        }
      }

      for (let s = 0; s < steps; s++) {
        const yA = yUse[s];
        const yB = isStairs ? yUse[s] : yUse[s + 1];
        this.fillStation(left, profile, px[s], yA, pz[s], rx[s], rz[s]);
        this.fillStation(right, profile, px[s + 1], yB, pz[s + 1], rx[s + 1], rz[s + 1]);
        this.emitLanes(profile, lateral, left, right, arc[s], arc[s + 1]);

        if (isStairs && yUse[s + 1] !== yUse[s]) {
          // vertical riser at the far station
          this.fillStation(left, profile, px[s + 1], yUse[s], pz[s + 1], rx[s + 1], rz[s + 1]);
          this.fillStation(right, profile, px[s + 1], yUse[s + 1], pz[s + 1], rx[s + 1], rz[s + 1]);
          this.emitLanes(profile, lateral, left, right, arc[s + 1], arc[s + 1] + STAIR_RISE);
        }
      }

      if (ed.kind === 'ramp') this.skirtRamp(roads, e, px, py, pz, rx, rz, hw, steps);
    }
  }

  private fillStation(
    out: THREE.Vector3[],
    profile: Profile,
    x: number, y: number, z: number,
    rx: number, rz: number,
  ): void {
    while (out.length < profile.pts.length) out.push(new THREE.Vector3());
    for (let i = 0; i < profile.pts.length; i++) {
      const off = profile.pts[i][0];
      out[i].set(x + rx * off, y + profile.pts[i][1], z + rz * off);
    }
  }

  private uvA = new THREE.Vector2();
  private uvB = new THREE.Vector2();
  private uvC = new THREE.Vector2();
  private uvD = new THREE.Vector2();

  private emitLanes(
    profile: Profile,
    lateral: number[],
    left: THREE.Vector3[],
    right: THREE.Vector3[],
    arc0: number,
    arc1: number,
  ): void {
    for (const lane of profile.lanes) {
      const tile = this.materials.tileMeters(lane.mat);
      const u0 = lateral[lane.from] / tile;
      const u1 = lateral[lane.to] / tile;
      const v0 = arc0 / tile;
      const v1 = arc1 / tile;
      this.uvA.set(u0, v0);
      this.uvB.set(u0, v1);
      this.uvC.set(u1, v1);
      this.uvD.set(u1, v0);
      this.emitQuad(
        lane.mat,
        left[lane.from], right[lane.from], right[lane.to], left[lane.to],
        this.uvA, this.uvB, this.uvC, this.uvD,
      );
    }
  }

  /** close the sides and the nose of a jump ramp so it is a solid wedge */
  private skirtRamp(
    roads: RoadNetworkImpl, edgeId: number,
    px: number[], py: number[], pz: number[],
    rx: number[], rz: number[], hw: number, steps: number,
  ): void {
    const layout = this.layout;
    if (!layout) return;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    const tile = this.materials.tileMeters('ramp');
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      for (let s = 0; s < steps; s++) {
        const x0 = px[s] + rx[s] * hw * sgn;
        const z0 = pz[s] + rz[s] * hw * sgn;
        const x1 = px[s + 1] + rx[s + 1] * hw * sgn;
        const z1 = pz[s + 1] + rz[s + 1] * hw * sgn;
        a.set(x0, py[s], z0);
        b.set(x1, py[s + 1], z1);
        c.set(x1, layout.groundHeight(x1, z1) - 0.2, z1);
        d.set(x0, layout.groundHeight(x0, z0) - 0.2, z0);
        const centreX = (a.x + b.x + c.x + d.x) * 0.25;
        const centreZ = (a.z + b.z + c.z + d.z) * 0.25;
        const bucket = this.bucket('ramp', this.chunkOf(centreX, centreZ));
        const nx = sgn * rx[s];
        const nz = sgn * rz[s];
        // orient the face outward: (b-a) x (d-a) must agree with the side normal
        const fx = (b.y - a.y) * (d.z - a.z) - (b.z - a.z) * (d.y - a.y);
        const fz = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
        const outward = fx * nx + fz * nz > 0;
        const run = Math.hypot(b.x - a.x, b.z - a.z) / tile;
        const i0 = bucket.vertex(a.x, a.y, a.z, nx, 0, nz, 0, py[s] / tile);
        const i1 = bucket.vertex(b.x, b.y, b.z, nx, 0, nz, run, py[s + 1] / tile);
        const i2 = bucket.vertex(c.x, c.y, c.z, nx, 0, nz, run, c.y / tile);
        const i3 = bucket.vertex(d.x, d.y, d.z, nx, 0, nz, 0, d.y / tile);
        if (outward) bucket.quad(i0, i1, i2, i3);
        else bucket.quad(i3, i2, i1, i0);
        this.collideQuad(a, b, c, d);
      }
    }
    void roads;
    void edgeId;
  }

  /* --------------------------------------------------------- intersections */

  private buildIntersections(roads: RoadNetworkImpl): void {
    const dir = new THREE.Vector3();
    const p = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();

    for (let ni = 0; ni < roads.nodes.length; ni++) {
      const node = roads.nodes[ni];
      // Ramps are separate wedges: their deck climbs away from the junction, so
      // folding their corners into the pad fan lifts the whole intersection.
      const incident = node.edges.filter(
        (e) => roads.edges[e].kind !== 'rooftop' && roads.edges[e].kind !== 'ramp',
      );
      if (incident.length === 0) continue;
      const r = this.padRadius(roads, ni);
      if (r <= 0.2) continue;

      interface Corner {
        x: number; y: number; z: number;
        dx: number; dz: number;
        rx: number; rz: number;
        hw: number;
        angle: number;
        kerbed: boolean;
        sidewalk: number;
        mat: MaterialId;
      }
      const corners: Corner[] = [];
      let widest = 0;
      let padMat: MaterialId = 'road';

      for (const e of incident) {
        const ed = roads.edges[e];
        const at = ed.a === ni ? 0 : 1;
        const t = clamp01(at === 0 ? r / ed.length : 1 - r / ed.length);
        roads.sample(e, t, 0, p);
        roads.tangent(e, t, dir);
        if (at === 1) dir.multiplyScalar(-1);
        const inv = 1 / Math.max(1e-5, Math.hypot(dir.x, dir.z));
        const dx = dir.x * inv;
        const dz = dir.z * inv;
        const kerbed = ed.kind === 'street' || ed.kind === 'coastal';
        const mat: MaterialId =
          ed.kind === 'coastal' ? 'roadCoastal'
            : ed.kind === 'alley' ? 'alley'
              : ed.kind === 'stairs' ? 'stairs'
                : ed.kind === 'plaza' ? 'roadPlaza'
                  : ed.kind === 'ramp' ? 'ramp' : 'road';
        if (ed.width > widest) {
          widest = ed.width;
          padMat = mat;
        }
        corners.push({
          x: p.x, y: p.y, z: p.z,
          dx, dz,
          rx: -dz, rz: dx,
          hw: ed.width * 0.5,
          angle: Math.atan2(dz, dx),
          kerbed,
          sidewalk: ed.kind === 'coastal' ? COASTAL_SIDEWALK_W : SIDEWALK_W,
          mat,
        });
      }

      /*
       * The carriageway pad is a star fan through *every* incoming ribbon
       * corner, sorted by bearing around the node — not a convex hull. A hull
       * discards the corners of the narrow approaches and then bulges past
       * them, which on a 20% street leaves a knee-high lip across the alley
       * mouth. The star always meets each ribbon exactly where it starts.
       */
      const ringPts: Array<{ x: number; y: number; z: number; ang: number }> = [];
      for (const co of corners) {
        for (const sgn of [1, -1]) {
          const x = co.x + co.rx * co.hw * sgn;
          const z = co.z + co.rz * co.hw * sgn;
          ringPts.push({ x, y: co.y, z, ang: Math.atan2(z - node.pos.z, x - node.pos.x) });
        }
      }
      ringPts.sort((u, v) => u.ang - v.ang);
      const cy = node.pos.y + CROWN;
      const tile = this.materials.tileMeters(padMat);
      const bucket = this.bucket(padMat, this.chunkOf(node.pos.x, node.pos.z));
      if (ringPts.length >= 3) {
        const centreIdx = bucket.vertex(
          node.pos.x, cy, node.pos.z, 0, 1, 0,
          node.pos.x / tile, node.pos.z / tile,
        );
        const ring: number[] = [];
        for (const h of ringPts) {
          ring.push(bucket.vertex(h.x, h.y, h.z, 0, 1, 0, h.x / tile, h.z / tile));
        }
        for (let k = 0; k < ring.length; k++) {
          const k1 = (k + 1) % ring.length;
          const n0 = ringPts[k];
          const n1 = ringPts[k1];
          const cross = (n0.x - node.pos.x) * (n1.z - node.pos.z) - (n0.z - node.pos.z) * (n1.x - node.pos.x);
          if (Math.abs(cross) < 1e-5) continue;
          a.set(node.pos.x, cy, node.pos.z);
          b.set(n0.x, n0.y, n0.z);
          c.set(n1.x, n1.y, n1.z);
          if (cross < 0) bucket.tri(centreIdx, ring[k], ring[k1]);
          else bucket.tri(centreIdx, ring[k1], ring[k]);
          this.collideTri(a, b, c);
        }
      }

      /* — pavement corners between consecutive approaches — */
      if (corners.length < 2) continue;
      corners.sort((u, v) => u.angle - v.angle);
      const uvTile = this.materials.tileMeters('sidewalk');
      const kerbTile = this.materials.tileMeters('kerb');
      for (let k = 0; k < corners.length; k++) {
        const cur = corners[k];
        const nxt = corners[(k + 1) % corners.length];
        if (!cur.kerbed || !nxt.kerbed) continue;
        const o0 = cur.hw + GUTTER_W + KERB_W;
        const o1 = nxt.hw + GUTTER_W + KERB_W;
        // outer kerb corner on the CCW side of `cur`, and the CW side of `nxt`
        const kx0 = cur.x + cur.rx * o0;
        const kz0 = cur.z + cur.rz * o0;
        const kx1 = nxt.x - nxt.rx * o1;
        const kz1 = nxt.z - nxt.rz * o1;
        const sx0 = kx0 + cur.rx * cur.sidewalk;
        const sz0 = kz0 + cur.rz * cur.sidewalk;
        const sx1 = kx1 - nxt.rx * nxt.sidewalk;
        const sz1 = kz1 - nxt.rz * nxt.sidewalk;
        const y = Math.max(cur.y, nxt.y) + KERB_H + 0.02;

        a.set(kx0, y, kz0);
        b.set(sx0, y + 0.03, sz0);
        c.set(sx1, y + 0.03, sz1);
        d.set(kx1, y, kz1);
        this.uvA.set(kx0 / uvTile, kz0 / uvTile);
        this.uvB.set(sx0 / uvTile, sz0 / uvTile);
        this.uvC.set(sx1 / uvTile, sz1 / uvTile);
        this.uvD.set(kx1 / uvTile, kz1 / uvTile);
        this.emitQuad('sidewalk', a, b, c, d, this.uvA, this.uvB, this.uvC, this.uvD);

        // the kerb face closing the gap between the pad and the pavement
        const px0 = cur.x + cur.rx * cur.hw;
        const pz0 = cur.z + cur.rz * cur.hw;
        const px1 = nxt.x - nxt.rx * nxt.hw;
        const pz1 = nxt.z - nxt.rz * nxt.hw;
        a.set(px0, cur.y - 0.05, pz0);
        b.set(px1, nxt.y - 0.05, pz1);
        c.set(kx1, y, kz1);
        d.set(kx0, y, kz0);
        this.uvA.set(0, 0);
        this.uvB.set(Math.hypot(px1 - px0, pz1 - pz0) / kerbTile, 0);
        this.uvC.set(Math.hypot(px1 - px0, pz1 - pz0) / kerbTile, 0.3);
        this.uvD.set(0, 0.3);
        this.emitQuad('kerb', a, b, c, d, this.uvA, this.uvB, this.uvC, this.uvD);
      }
    }
  }

  /* --------------------------------------------------------------- areas */

  private areaMaterial(area: OpenArea): MaterialId {
    switch (area.surface) {
      case 'flagstone':
        return area.zone === 'fortress' ? 'promenade' : 'plazaFlagstone';
      case 'cobble':
        return 'plazaCobble';
      case 'sand':
        return 'sand';
      case 'grass':
        return 'grass';
      case 'tile':
        return 'marketFloor';
      case 'asphalt':
        return 'apron';
      default:
        return 'plazaFlagstone';
    }
  }

  private buildAreas(layout: CityLayout): void {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();

    for (const area of layout.areas) {
      const mat = this.areaMaterial(area);
      const tile = this.materials.tileMeters(mat);
      const contour = area.polygon.map((p) => p.clone());
      if (contour.length < 3) continue;
      // ShapeUtils wants a clockwise-free simple contour; triangulate handles both
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      if (tris.length === 0) continue;

      let maxEdge = 0;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          maxEdge = Math.max(maxEdge, contour[t[k]].distanceTo(contour[t[(k + 1) % 3]]));
        }
      }
      const k = clamp(Math.ceil(maxEdge / 5), 1, 14) | 0;

      for (const t of tris) {
        const P = contour[t[0]];
        const Q = contour[t[1]];
        const R = contour[t[2]];
        // uniform barycentric subdivision: shared edges split identically, so
        // neighbouring triangles stay watertight
        for (let i = 0; i < k; i++) {
          for (let j = 0; j < k - i; j++) {
            const u0 = i / k;
            const v0 = j / k;
            const s = 1 / k;
            this.areaTri(mat, tile, layout, P, Q, R, u0, v0, u0 + s, v0, u0, v0 + s, a, b, c);
            if (j < k - i - 1) {
              this.areaTri(mat, tile, layout, P, Q, R, u0 + s, v0, u0 + s, v0 + s, u0, v0 + s, a, b, c);
            }
          }
        }
      }
    }
  }

  private areaTri(
    mat: MaterialId, tile: number, layout: CityLayout,
    P: THREE.Vector2, Q: THREE.Vector2, R: THREE.Vector2,
    u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  ): void {
    const bary = (u: number, v: number, out: THREE.Vector3): void => {
      const w = 1 - u - v;
      const x = P.x * w + Q.x * u + R.x * v;
      const z = P.y * w + Q.y * u + R.y * v;
      out.set(x, layout.groundHeight(x, z) + 0.012, z);
    };
    bary(u0, v0, a);
    bary(u1, v1, b);
    bary(u2, v2, c);

    const cx = (a.x + b.x + c.x) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    const bucket = this.bucket(mat, this.chunkOf(cx, cz));
    let nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    let ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    let nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    let flip = false;
    if (ny < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      flip = true;
    }
    const i0 = bucket.vertex(a.x, a.y, a.z, nx, ny, nz, a.x / tile, a.z / tile);
    const i1 = bucket.vertex(b.x, b.y, b.z, nx, ny, nz, b.x / tile, b.z / tile);
    const i2 = bucket.vertex(c.x, c.y, c.z, nx, ny, nz, c.x / tile, c.z / tile);
    if (flip) bucket.tri(i0, i2, i1);
    else bucket.tri(i0, i1, i2);
    this.collideTri(a, b, c);
  }

  /* ------------------------------------------------------------- terrain */

  private buildTerrain(layout: CityLayout, roads: RoadNetworkImpl): void {
    const minX = DISTRICT_BOUNDS.minX - TERRAIN_SKIRT;
    const maxX = DISTRICT_BOUNDS.maxX + TERRAIN_SKIRT * 3;
    const minZ = DISTRICT_BOUNDS.minZ - TERRAIN_SKIRT;
    const maxZ = DISTRICT_BOUNDS.maxZ + TERRAIN_SKIRT;
    const cell = this.quality === 'low' ? TERRAIN_CELL * 1.5 : TERRAIN_CELL;
    const gw = Math.ceil((maxX - minX) / cell);
    const gh = Math.ceil((maxZ - minZ) / cell);

    const mat: MaterialId = 'terrain';
    const tile = this.materials.tileMeters(mat);
    const probe = new THREE.Vector3();
    const sample = {
      edgeId: -1, t: 0, dist: Infinity,
      point: new THREE.Vector3(), tangent: new THREE.Vector3(),
    };

    // bboxes so the per-corner area test is a cheap reject in the common case
    const areaBox = layout.areas.map((area) => {
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
      return { minX, maxX, minZ, maxZ, poly: area.polygon };
    });

    /** true when this point already has a paved surface over it */
    const covered = (x: number, z: number): boolean => {
      probe.set(x, 0, z);
      if (roads.nearestInto(probe, 26, sample)) {
        const ed = roads.edges[sample.edgeId];
        if (ed.kind !== 'ramp' && ed.kind !== 'rooftop') {
          const sw = ed.kind === 'street' ? SIDEWALK_W : ed.kind === 'coastal' ? COASTAL_SIDEWALK_W : 0;
          if (sample.dist < ed.width * 0.5 + GUTTER_W + KERB_W + sw + 0.4) return true;
        }
      }
      for (const box of areaBox) {
        if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
        if (pointInPoly(box.poly, x, z)) return true;
      }
      return false;
    };

    const h = (x: number, z: number): number => layout.groundHeight(x, z) - 0.07;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();

    for (let j = 0; j < gh; j++) {
      const z0 = minZ + j * cell;
      const z1 = z0 + cell;
      for (let i = 0; i < gw; i++) {
        const x0 = minX + i * cell;
        const x1 = x0 + cell;
        const mx = (x0 + x1) * 0.5;
        const mz = (z0 + z1) * 0.5;

        const y00 = h(x0, z0);
        const y10 = h(x1, z0);
        const y11 = h(x1, z1);
        const y01 = h(x0, z1);

        // skip anything wholly beneath the sea — the water plane covers it
        if (y00 < SEA_LEVEL - 7 && y10 < SEA_LEVEL - 7 && y11 < SEA_LEVEL - 7 && y01 < SEA_LEVEL - 7) {
          continue;
        }
        if (
          covered(mx, mz) &&
          covered(x0, z0) && covered(x1, z0) && covered(x1, z1) && covered(x0, z1)
        ) {
          continue;
        }

        a.set(x0, y00, z0);
        b.set(x1, y10, z0);
        c.set(x1, y11, z1);
        d.set(x0, y01, z1);

        const bucket = this.bucket(mat, this.chunkOf(mx, mz), true);
        const idx: number[] = [];
        const corners = [a, b, c, d];
        for (const p of corners) {
          // normal straight off the height field gradient
          const hx = h(p.x + 1.5, p.z) - h(p.x - 1.5, p.z);
          const hz = h(p.x, p.z + 1.5) - h(p.x, p.z - 1.5);
          let nx = -hx / 3;
          let ny = 1;
          let nz = -hz / 3;
          const l = Math.hypot(nx, ny, nz);
          nx /= l; ny /= l; nz /= l;
          const slope = 1 - ny;
          const beach = 1 - smoothstep((p.y - 0.4) / 3.2);
          const dry = clamp01(smoothstep(slope / 0.45) * 0.8 + beach);
          const r = lerp(0.82, 1.24, dry);
          const g = lerp(0.9, 1.14, dry);
          const bl = lerp(0.74, 0.98, dry);
          idx.push(bucket.vertex(p.x, p.y, p.z, nx, ny, nz, p.x / tile, p.z / tile, r, g, bl));
        }
        // wind CCW seen from above (+Y): (x0,z0) -> (x0,z1) -> (x1,z1) -> (x1,z0)
        bucket.quad(idx[0], idx[3], idx[2], idx[1]);
        this.collideQuad(a, d, c, b);
      }
    }
  }

  /* ----------------------------------------------------------------- sea */

  private buildSea(): void {
    const seg = this.quality === 'low' ? 48 : this.quality === 'ultra' ? 128 : 88;
    const tile = this.materials.tileMeters('sea');
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const cx = (DISTRICT_BOUNDS.minX + DISTRICT_BOUNDS.maxX) * 0.5;
    const cz = (DISTRICT_BOUNDS.minZ + DISTRICT_BOUNDS.maxZ) * 0.5;
    for (let j = 0; j <= seg; j++) {
      const z = cz - SEA_SPAN * 0.5 + (SEA_SPAN * j) / seg;
      for (let i = 0; i <= seg; i++) {
        const x = cx - SEA_SPAN * 0.5 + (SEA_SPAN * i) / seg;
        pos.push(x, 0, z);
        nrm.push(0, 1, 0);
        uv.push(x / tile, z / tile);
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const p0 = j * (seg + 1) + i;
        const p1 = p0 + 1;
        const p2 = p0 + seg + 1;
        const p3 = p2 + 1;
        idx.push(p0, p2, p1, p1, p2, p3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.materials.get('sea'));
    mesh.name = 'world/sea';
    mesh.position.y = SEA_LEVEL;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geo);
    this._stats.triangles += idx.length / 3;
  }

  /* -------------------------------------------------------------- output */

  private flushBuckets(): void {
    let tris = 0;
    for (const [key, bucket] of this.buckets) {
      const geo = bucket.build();
      if (!geo) continue;
      const matId = key.slice(0, key.indexOf('|')) as MaterialId;
      const material =
        matId === 'terrain'
          ? this.terrainMaterial()
          : this.materials.get(matId);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `world/${key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.geometries.push(geo);
      tris += bucket.idx.length / 3;
    }
    this._stats.meshes = this.meshes.length;
    this._stats.triangles += tris;
  }

  /** terrain wants vertex colours, which the shared spec material does not use */
  private terrainMaterial(): THREE.Material {
    return this.materials.custom(
      'ground/terrainVC',
      () => {
        const maps = this.materials.textures.surface('grass');
        const m = new THREE.MeshStandardMaterial({
          name: 'loco/terrain',
          color: 0xa9b98d,
          map: maps.map,
          normalMap: maps.normalMap ?? undefined,
          roughness: 1,
          metalness: 0,
          vertexColors: true,
          envMapIntensity: 0.75,
        });
        if (maps.normalMap) m.normalScale = new THREE.Vector2(0.6, 0.6);
        return m;
      },
      0.6,
    );
  }

  private buildCollider(): void {
    if (this.colIdx.length === 0) return;
    const vertices = new Float32Array(this.colPos);
    const indices = new Uint32Array(this.colIdx);
    this._stats.colliderTriangles = indices.length / 3;
    this.body = this.physics.createBody({
      kind: 'static',
      shape: { type: 'trimesh', vertices, indices },
      position: new THREE.Vector3(0, 0, 0),
      friction: 1.0,
      restitution: 0.02,
      group: GROUP.WORLD,
      mask:
        GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS | GROUP.TRIGGER,
      userData: { kind: 'world', surface: 'ground' },
    });
    // arrays are large; let them go once Rapier owns a copy
    this.colPos.length = 0;
    this.colIdx.length = 0;
  }

  /**
   * Merged copy of every visual ground geometry. Kept as a utility for tooling
   * (nav-mesh baking, occlusion pre-pass) rather than used at runtime.
   */
  mergedGeometry(): THREE.BufferGeometry | null {
    const parts = this.geometries.filter((g) => g.getAttribute('position'));
    if (parts.length === 0) return null;
    const stripped = parts.map((g) => {
      const c = new THREE.BufferGeometry();
      c.setAttribute('position', g.getAttribute('position'));
      c.setIndex(g.getIndex());
      return c;
    });
    return BufferGeometryUtils.mergeGeometries(stripped, false);
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
  }

  dispose(): void {
    if (this.body) {
      this.physics.removeBody(this.body);
      this.body = null;
    }
    for (const m of this.meshes) this.group.remove(m);
    for (const g of this.geometries) g.dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
    this.buckets.clear();
    this.group.clear();
  }
}

/* ---------------------------------------------------------------- helpers */

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
