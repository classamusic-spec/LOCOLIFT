/**
 * Loco Lift — parametric townhouse parts kit.
 *
 * Every dimension here is from `docs/ART_REFERENCE.md` §1. The kit works in a
 * **façade frame**: local `x` runs along the street frontage, `y` up from the
 * ground-floor level, `z` outward from the wall plane. Walls really are 0.75 m
 * thick and openings really are set back 0.28 m, because that reveal depth is
 * what makes a window read as a hole instead of a decal.
 *
 * Geometry is accumulated into a {@link GeomBuilder} and merged per block by
 * `Buildings.ts`, so 1100 lots cost a few dozen draw calls. Anything repeated
 * across the whole district (balcony assemblies, plant pots, water tanks) goes
 * through {@link InstanceRegistry} instead and comes out as `InstancedMesh`.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import type { AtlasRect, FacadeAtlas } from './FacadeTextures';

/* ------------------------------------------------------------- dimensions */

/** §1.2 / §1.3 / §10 — the townhouse constants. All metres. */
export const CASA = {
  bay: 2.9,
  groundH: 4.3,
  upperH: 3.8,
  corniceH: 0.42,
  cornicePr: 0.3,
  parapetH: 1.1,
  parapetT: 0.34,
  copingW: 0.28,
  copingH: 0.1,
  wallT: 0.75,
  partyT: 0.5,
  revealD: 0.28,
  plinthH: 0.55,
  plinthPr: 0.05,
  doorW: 1.4,
  doorH: 3.2,
  fanlightH: 0.55,
  windowW: 1.2,
  windowH: 2.6,
  windowSill: 0.85,
  balconyDoorW: 1.1,
  balconyDoorH: 2.7,
  transomH: 0.4,
  encadrementW: 0.2,
  encadrementPr: 0.035,
  stringH: 0.16,
  stringPr: 0.09,
  /** metres of wall covered by one stucco tile */
  stuccoTile: 3.1,
} as const;

/** §1.4 — balconies and balconettes. */
export const BALCON = {
  ironDepth: 0.95,
  ironSlabT: 0.15,
  railH: 1.02,
  barPitch: 0.115,
  barD: 0.018,
  topRailD: 0.032,
  bracketPitch: 1.45,
  bracketPr: 0.85,
  bracketT: 0.05,
  woodDepth: 1.15,
  woodRailH: 1.0,
  woodRoofH: 2.45,
  woodRoofPitchDeg: 12,
  woodRoofOver: 0.2,
  balconetteDepth: 0.16,
  balconetteH: 1.0,
} as const;

/* ------------------------------------------------------------------ colour */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const scratchColor = new THREE.Color();

/** sRGB hex -> linear working-space rgb, which is what a vertex colour needs */
export function linearRGB(hex: number, mul = 1): RGB {
  scratchColor.setHex(hex);
  return { r: scratchColor.r * mul, g: scratchColor.g * mul, b: scratchColor.b * mul };
}

export function shadeRGB(c: RGB, mul: number): RGB {
  return { r: c.r * mul, g: c.g * mul, b: c.b * mul };
}

export const WHITE: RGB = { r: 1, g: 1, b: 1 };

/* ------------------------------------------------------------- geom builder */

/**
 * Position / normal / uv / colour / glow accumulator. `aGlow` is a per-vertex
 * `(intensity, warmth, phase)` triple that `Buildings.ts` turns into windows
 * that light up after dusk, each at its own moment and its own colour temp.
 */
export class GeomBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private glw: number[] = [];
  private idx: number[] = [];
  private n = 0;

  get vertexCount(): number {
    return this.n;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    c: RGB,
    gi = 0,
    gw = 0,
    gp = 0,
  ): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.col.push(c.r, c.g, c.b);
    this.glw.push(gi, gw, gp);
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
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glw, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  clear(): void {
    this.pos.length = 0;
    this.nrm.length = 0;
    this.uvs.length = 0;
    this.col.length = 0;
    this.glw.length = 0;
    this.idx.length = 0;
    this.n = 0;
  }
}

/* ------------------------------------------------------------------- frame */

/**
 * A façade coordinate frame anchored on a lot's street edge.
 * `x` along the frontage, `y` up from the ground-floor level, `z` outward.
 */
export interface Frame {
  ox: number;
  oz: number;
  /** unit vector along the frontage, in world xz */
  ux: number;
  uz: number;
  /** outward unit normal, in world xz */
  nx: number;
  nz: number;
  /** world Y of the ground-floor level */
  y0: number;
  /** frontage length */
  len: number;
}

export function makeFrame(
  p0x: number,
  p0z: number,
  p1x: number,
  p1z: number,
  y0: number,
): Frame {
  const dx = p1x - p0x;
  const dz = p1z - p0z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  // the lot rings are CCW in (x, z), so the outward normal is (uz, -ux)
  return { ox: p0x, oz: p0z, ux, uz, nx: uz, nz: -ux, y0, len };
}

/** Shift a frame's origin along its own axes — used for sides, rears, wings. */
export function offsetFrame(f: Frame, dx: number, dz: number, dy = 0): Frame {
  return {
    ...f,
    ox: f.ox + f.ux * dx + f.nx * dz,
    oz: f.oz + f.uz * dx + f.nz * dz,
    y0: f.y0 + dy,
  };
}

export function worldX(f: Frame, x: number, z: number): number {
  return f.ox + f.ux * x + f.nx * z;
}

export function worldZ(f: Frame, x: number, z: number): number {
  return f.oz + f.uz * x + f.nz * z;
}

/* -------------------------------------------------------------- primitives */

export interface PanelOpts {
  /** metres per stucco tile; 0 stretches the rect over the whole panel */
  tile?: number;
  /** vertex-colour multiplier at the bottom / top edge */
  shadeBottom?: number;
  shadeTop?: number;
  /** window glow (intensity, warmth, phase) */
  glow?: [number, number, number];
  /** -1 flips the surface to face inward */
  face?: number;
  /** override the normal to point along local +x (side walls drawn in-frame) */
  axis?: 'z' | 'x' | 'y';
}

/**
 * A rectangular panel in the façade plane at depth `z`, subdivided so a
 * seamless atlas tile repeats at a roughly constant physical size.
 */
export function panel(
  b: GeomBuilder,
  f: Frame,
  atlas: FacadeAtlas,
  rect: AtlasRect,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  col: RGB,
  opts: PanelOpts = {},
): void {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 1e-4 || h <= 1e-4) return;
  const tile = opts.tile ?? 0;
  const nu = tile > 0 ? Math.max(1, Math.round(w / tile)) : 1;
  const nv = tile > 0 ? Math.max(1, Math.round(h / tile)) : 1;
  const face = opts.face ?? 1;
  const nx = f.nx * face;
  const nz = f.nz * face;
  const sb = opts.shadeBottom ?? 1;
  const st = opts.shadeTop ?? 1;
  const g = opts.glow ?? [0, 0, 0];

  for (let j = 0; j < nv; j++) {
    const ya = y0 + (h * j) / nv;
    const yb = y0 + (h * (j + 1)) / nv;
    const ca = shadeRGB(col, lerp(sb, st, (ya - y0) / h));
    const cb = shadeRGB(col, lerp(sb, st, (yb - y0) / h));
    for (let i = 0; i < nu; i++) {
      const xa = x0 + (w * i) / nu;
      const xb = x0 + (w * (i + 1)) / nu;
      const u0 = atlas.u(rect, 0);
      const u1 = atlas.u(rect, 1);
      const v0 = atlas.v(rect, 0);
      const v1 = atlas.v(rect, 1);
      const a = b.vertex(worldX(f, xa, z), f.y0 + ya, worldZ(f, xa, z), nx, 0, nz, u0, v0, ca, g[0], g[1], g[2]);
      const c = b.vertex(worldX(f, xb, z), f.y0 + ya, worldZ(f, xb, z), nx, 0, nz, u1, v0, ca, g[0], g[1], g[2]);
      const d = b.vertex(worldX(f, xb, z), f.y0 + yb, worldZ(f, xb, z), nx, 0, nz, u1, v1, cb, g[0], g[1], g[2]);
      const e = b.vertex(worldX(f, xa, z), f.y0 + yb, worldZ(f, xa, z), nx, 0, nz, u0, v1, cb, g[0], g[1], g[2]);
      if (face > 0) b.quad(a, c, d, e);
      else b.quad(a, e, d, c);
    }
  }
}

/** A horizontal panel (soffit, sill top, roof deck, balcony floor). */
export function deck(
  b: GeomBuilder,
  f: Frame,
  atlas: FacadeAtlas,
  rect: AtlasRect,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  col: RGB,
  up = 1,
  tile = 0,
): void {
  const w = x1 - x0;
  const d = z1 - z0;
  if (Math.abs(w) < 1e-4 || Math.abs(d) < 1e-4) return;
  const nu = tile > 0 ? Math.max(1, Math.round(Math.abs(w) / tile)) : 1;
  const nv = tile > 0 ? Math.max(1, Math.round(Math.abs(d) / tile)) : 1;
  for (let j = 0; j < nv; j++) {
    const za = z0 + (d * j) / nv;
    const zb = z0 + (d * (j + 1)) / nv;
    for (let i = 0; i < nu; i++) {
      const xa = x0 + (w * i) / nu;
      const xb = x0 + (w * (i + 1)) / nu;
      const u0 = atlas.u(rect, 0);
      const u1 = atlas.u(rect, 1);
      const v0 = atlas.v(rect, 0);
      const v1 = atlas.v(rect, 1);
      const p1 = b.vertex(worldX(f, xa, za), f.y0 + y, worldZ(f, xa, za), 0, up, 0, u0, v0, col);
      const p2 = b.vertex(worldX(f, xb, za), f.y0 + y, worldZ(f, xb, za), 0, up, 0, u1, v0, col);
      const p3 = b.vertex(worldX(f, xb, zb), f.y0 + y, worldZ(f, xb, zb), 0, up, 0, u1, v1, col);
      const p4 = b.vertex(worldX(f, xa, zb), f.y0 + y, worldZ(f, xa, zb), 0, up, 0, u0, v1, col);
      if (up > 0) b.quad(p1, p4, p3, p2);
      else b.quad(p1, p2, p3, p4);
    }
  }
}

/** A vertical panel facing along local ±x (jambs, side walls, returns). */
export function sidePanel(
  b: GeomBuilder,
  f: Frame,
  atlas: FacadeAtlas,
  rect: AtlasRect,
  z0: number,
  y0: number,
  z1: number,
  y1: number,
  x: number,
  col: RGB,
  face: number,
  shadeBottom = 1,
  shadeTop = 1,
  tile = 0,
): void {
  const w = z1 - z0;
  const h = y1 - y0;
  if (Math.abs(w) < 1e-4 || Math.abs(h) < 1e-4) return;
  const nu = tile > 0 ? Math.max(1, Math.round(Math.abs(w) / tile)) : 1;
  const nv = tile > 0 ? Math.max(1, Math.round(Math.abs(h) / tile)) : 1;
  const nx = f.ux * face;
  const nz = f.uz * face;
  for (let j = 0; j < nv; j++) {
    const ya = y0 + (h * j) / nv;
    const yb = y0 + (h * (j + 1)) / nv;
    const ca = shadeRGB(col, lerp(shadeBottom, shadeTop, (ya - y0) / h));
    const cb = shadeRGB(col, lerp(shadeBottom, shadeTop, (yb - y0) / h));
    for (let i = 0; i < nu; i++) {
      const za = z0 + (w * i) / nu;
      const zb = z0 + (w * (i + 1)) / nu;
      const u0 = atlas.u(rect, 0);
      const u1 = atlas.u(rect, 1);
      const v0 = atlas.v(rect, 0);
      const v1 = atlas.v(rect, 1);
      const p1 = b.vertex(worldX(f, x, za), f.y0 + ya, worldZ(f, x, za), nx, 0, nz, u0, v0, ca);
      const p2 = b.vertex(worldX(f, x, zb), f.y0 + ya, worldZ(f, x, zb), nx, 0, nz, u1, v0, ca);
      const p3 = b.vertex(worldX(f, x, zb), f.y0 + yb, worldZ(f, x, zb), nx, 0, nz, u1, v1, cb);
      const p4 = b.vertex(worldX(f, x, za), f.y0 + yb, worldZ(f, x, za), nx, 0, nz, u0, v1, cb);
      if (face > 0) b.quad(p1, p2, p3, p4);
      else b.quad(p1, p4, p3, p2);
    }
  }
}

export const FACE_PX = 1;
export const FACE_NX = 2;
export const FACE_PY = 4;
export const FACE_NY = 8;
export const FACE_PZ = 16;
export const FACE_NZ = 32;
export const FACE_ALL = 63;
/** everything except the back and the underside — the usual applied-trim case */
export const FACE_TRIM = FACE_PX | FACE_NX | FACE_PY | FACE_NY | FACE_PZ;

/** An axis-aligned box in the façade frame. */
export function box(
  b: GeomBuilder,
  f: Frame,
  atlas: FacadeAtlas,
  rect: AtlasRect,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  col: RGB,
  faces = FACE_ALL,
  tile = 0,
): void {
  if (faces & FACE_PZ) panel(b, f, atlas, rect, x0, y0, x1, y1, z1, col, { tile });
  if (faces & FACE_NZ) panel(b, f, atlas, rect, x0, y0, x1, y1, z0, shadeRGB(col, 0.8), { tile, face: -1 });
  if (faces & FACE_PX) sidePanel(b, f, atlas, rect, z0, y0, z1, y1, x1, shadeRGB(col, 0.9), 1, 1, 1, tile);
  if (faces & FACE_NX) sidePanel(b, f, atlas, rect, z0, y0, z1, y1, x0, shadeRGB(col, 0.9), -1, 1, 1, tile);
  if (faces & FACE_PY) deck(b, f, atlas, rect, x0, z0, x1, z1, y1, shadeRGB(col, 1.06), 1, tile);
  if (faces & FACE_NY) deck(b, f, atlas, rect, x0, z0, x1, z1, y0, shadeRGB(col, 0.55), -1, tile);
}

/** Arbitrary world-space quad — used for roof slopes and lot polygons. */
export function worldQuad(
  b: GeomBuilder,
  atlas: FacadeAtlas,
  rect: AtlasRect,
  a: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  e: THREE.Vector3,
  col: RGB,
): void {
  const n = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(e, a)).normalize();
  const u0 = atlas.u(rect, 0);
  const u1 = atlas.u(rect, 1);
  const v0 = atlas.v(rect, 0);
  const v1 = atlas.v(rect, 1);
  const i0 = b.vertex(a.x, a.y, a.z, n.x, n.y, n.z, u0, v0, col);
  const i1 = b.vertex(c.x, c.y, c.z, n.x, n.y, n.z, u1, v0, col);
  const i2 = b.vertex(d.x, d.y, d.z, n.x, n.y, n.z, u1, v1, col);
  const i3 = b.vertex(e.x, e.y, e.z, n.x, n.y, n.z, u0, v1, col);
  b.quad(i0, i1, i2, i3);
}

/* ------------------------------------------------------------------- parts */

export interface KitCtx {
  b: GeomBuilder;
  f: Frame;
  atlas: FacadeAtlas;
  wall: RGB;
  trim: RGB;
  joinery: RGB;
  stucco: AtlasRect;
  /** 0 = near LOD (modelled reveals), 1 = far LOD (flat) */
  lod: 0 | 1;
}

/**
 * **Cornice** — §1.2: 0.42 tall, projecting 0.30, dead level, continuous across
 * the whole façade. Modelled as a real three-step profile so it casts the
 * shadow the reference demands, not a painted stripe.
 */
export function cornice(
  k: KitCtx,
  x0: number,
  x1: number,
  y: number,
  pr = CASA.cornicePr,
  h = CASA.corniceH,
): void {
  const { b, f, atlas, trim, stucco } = k;
  if (k.lod === 1) {
    box(b, f, atlas, stucco, x0, y, 0, x1, y + h, pr * 0.7, trim, FACE_PZ | FACE_PY | FACE_NY);
    return;
  }
  const steps: Array<[number, number, number]> = [
    // [yFrom, yTo, projection]
    [0, h * 0.24, pr * 0.32],
    [h * 0.24, h * 0.72, pr],
    [h * 0.72, h, pr * 0.68],
  ];
  let prevPr = 0;
  for (const [a, c, p] of steps) {
    // vertical face
    panel(b, f, atlas, stucco, x0, y + a, x1, y + c, p, trim, { shadeBottom: 0.88, shadeTop: 1.04 });
    // horizontal weathering (or soffit) between the steps
    if (p > prevPr) deck(b, f, atlas, stucco, x0, prevPr, x1, p, y + a, shadeRGB(trim, 0.62), -1);
    else deck(b, f, atlas, stucco, x0, p, x1, prevPr, y + a, shadeRGB(trim, 1.08), 1);
    prevPr = p;
  }
  deck(b, f, atlas, stucco, x0, 0, x1, prevPr, y + h, shadeRGB(trim, 1.1), 1);
  // returns at the ends so the moulding does not float in section
  sidePanel(b, f, atlas, stucco, 0, y, pr, y + h, x1, shadeRGB(trim, 0.94), 1);
  sidePanel(b, f, atlas, stucco, 0, y, pr, y + h, x0, shadeRGB(trim, 0.94), -1);
}

/**
 * **Parapet** — §1.6: 1.10 above the cornice with a 0.28 x 0.10 coping
 * projecting 0.04 each side. Adjacent buildings must never share a height,
 * which the caller enforces; the geometry just has to read as a real wall with
 * a real cap.
 */
export function parapet(
  k: KitCtx,
  x0: number,
  x1: number,
  yBase: number,
  h: number,
  zFront: number,
  thickness = CASA.parapetT,
): void {
  const { b, f, atlas, wall, trim, stucco } = k;
  const zBack = zFront - thickness;
  const top = yBase + h;
  panel(b, f, atlas, stucco, x0, yBase, x1, top, zFront, wall, {
    tile: CASA.stuccoTile,
    shadeBottom: 0.94,
    shadeTop: 1.02,
  });
  panel(b, f, atlas, stucco, x0, yBase, x1, top, zBack, shadeRGB(wall, 0.74), {
    tile: CASA.stuccoTile,
    face: -1,
  });
  if (k.lod === 1) {
    deck(b, f, atlas, stucco, x0, zBack, x1, zFront, top, shadeRGB(trim, 1.05), 1);
    return;
  }
  // coping
  const cy = top;
  const ch = CASA.copingH;
  const over = 0.04;
  box(b, f, atlas, stucco, x0, cy, zBack - over, x1, cy + ch, zFront + over, trim, FACE_PZ | FACE_NZ | FACE_PY);
  sidePanel(b, f, atlas, stucco, zBack, yBase, zFront, cy + ch, x1, shadeRGB(wall, 0.9), 1);
  sidePanel(b, f, atlas, stucco, zBack, yBase, zFront, cy + ch, x0, shadeRGB(wall, 0.9), -1);
}

/**
 * **Plinth / podium** — §1.2: a 0.55 base course, darker and dirtier. The
 * bottom edge follows the pavement, so a building on a 12 % street sits on a
 * wedge instead of floating at one end and burying itself at the other.
 */
export function plinth(
  k: KitCtx,
  x0: number,
  x1: number,
  yTop: number,
  groundAt: (x: number) => number,
  bury = 0.5,
): void {
  const { b, f, atlas } = k;
  const rect = k.atlas.rect('plinth');
  const col = shadeRGB(k.wall, 0.7);
  const z = CASA.plinthPr;
  const n = Math.max(2, Math.round((x1 - x0) / 1.6));
  const u0 = atlas.u(rect, 0);
  const u1 = atlas.u(rect, 1);
  const v0 = atlas.v(rect, 0);
  const v1 = atlas.v(rect, 1);
  for (let i = 0; i < n; i++) {
    const xa = x0 + ((x1 - x0) * i) / n;
    const xb = x0 + ((x1 - x0) * (i + 1)) / n;
    const ya = groundAt(xa) - bury;
    const yb = groundAt(xb) - bury;
    const dark = shadeRGB(col, 0.72);
    const p0 = b.vertex(worldX(f, xa, z), f.y0 + ya, worldZ(f, xa, z), f.nx, 0, f.nz, u0, v0, dark);
    const p1 = b.vertex(worldX(f, xb, z), f.y0 + yb, worldZ(f, xb, z), f.nx, 0, f.nz, u1, v0, dark);
    const p2 = b.vertex(worldX(f, xb, z), f.y0 + yTop, worldZ(f, xb, z), f.nx, 0, f.nz, u1, v1, col);
    const p3 = b.vertex(worldX(f, xa, z), f.y0 + yTop, worldZ(f, xa, z), f.nx, 0, f.nz, u0, v1, col);
    b.quad(p0, p1, p2, p3);
  }
  // the small weathering slope back to the wall plane
  deck(b, f, atlas, rect, x0, 0, x1, z, yTop, shadeRGB(col, 1.06), 1);
}

/** **String course** — §1.2 adjunct: a thin band marking a floor line. */
export function stringCourse(k: KitCtx, x0: number, x1: number, y: number): void {
  const { b, f, atlas, trim, stucco } = k;
  box(b, f, atlas, stucco, x0, y, 0, x1, y + CASA.stringH, CASA.stringPr, trim, FACE_TRIM);
}

/**
 * **Encadrement** — §1.3: a 0.20 painted border projecting 0.035, always
 * lighter than the wall. This is the frame half of the value sandwich.
 */
export function encadrement(
  k: KitCtx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w = CASA.encadrementW,
  pr = CASA.encadrementPr,
): void {
  const { b, f, atlas, trim, stucco } = k;
  const ox0 = x0 - w;
  const ox1 = x1 + w;
  const oy1 = y1 + w;
  const faces = FACE_PZ | FACE_PX | FACE_NX | FACE_PY;
  box(b, f, atlas, stucco, ox0, y0, 0, x0, oy1, pr, trim, faces);
  box(b, f, atlas, stucco, x1, y0, 0, ox1, oy1, pr, trim, faces);
  box(b, f, atlas, stucco, x0, y1, 0, x1, oy1, pr, trim, FACE_PZ | FACE_PY | FACE_NY);
}

/** **Floating lintel** — §1.3: a stucco band hovering 0.10 above the head. */
export function floatingLintel(k: KitCtx, x0: number, x1: number, yHead: number): void {
  const { b, f, atlas, trim, stucco } = k;
  const y = yHead + CASA.encadrementW + 0.1;
  box(b, f, atlas, stucco, x0 - 0.34, y, 0, x1 + 0.34, y + 0.16, CASA.encadrementPr * 2.2, trim, FACE_TRIM);
}

export interface OpeningOpts {
  /** atlas tile for the leaf sitting at the back of the reveal */
  leaf: AtlasRect;
  /** optional transom / fanlight tile above the head */
  head?: AtlasRect;
  headH?: number;
  /** window glow packed as (intensity, warmth, phase) */
  glow?: [number, number, number];
  /** tint applied to the leaf (joinery colour, or white for art tiles) */
  leafColor?: RGB;
  /** how far back the leaf sits; defaults to the 0.28 reveal */
  depth?: number;
  /** draw a sill projecting from the bottom of the opening */
  sill?: boolean;
}

/**
 * **Opening with a real reveal** — §1.2: the leaf sits 0.28 back inside a
 * 0.75 wall, with jambs, head soffit and (optionally) a sill modelled. Failure
 * item 3 in §8 is "walls are paper thin"; this is the fix.
 */
export function opening(k: KitCtx, x0: number, y0: number, x1: number, y1: number, o: OpeningOpts): void {
  const { b, f, atlas, wall, trim, stucco } = k;
  const d = -(o.depth ?? CASA.revealD);
  const leafCol = o.leafColor ?? k.joinery;
  const headH = o.headH ?? 0;
  const yLeafTop = y1 - headH;

  if (k.lod === 1) {
    // far LOD: no reveal, the leaf is painted flat on the wall plane
    panel(b, f, atlas, o.leaf, x0, y0, x1, yLeafTop, 0.004, leafCol, { glow: o.glow });
    if (o.head) panel(b, f, atlas, o.head, x0, yLeafTop, x1, y1, 0.004, trim, { glow: o.glow });
    return;
  }

  // jambs and head soffit — the depth cue
  const revealCol = shadeRGB(trim, 0.86);
  sidePanel(b, f, atlas, stucco, d, y0, 0, y1, x0, revealCol, 1);
  sidePanel(b, f, atlas, stucco, d, y0, 0, y1, x1, revealCol, -1);
  deck(b, f, atlas, stucco, x0, d, x1, 0, y1, shadeRGB(trim, 0.6), -1);

  // the leaf itself
  panel(b, f, atlas, o.leaf, x0, y0, x1, yLeafTop, d, leafCol, { glow: o.glow });
  if (o.head) panel(b, f, atlas, o.head, x0, yLeafTop, x1, y1, d, trim, { glow: o.glow });

  if (o.sill) {
    const sd = 0.09;
    box(b, f, atlas, stucco, x0 - 0.08, y0 - 0.1, d, x1 + 0.08, y0, sd, trim, FACE_TRIM);
    // §3.2: a drip streak under the sill, always aligned with gravity
    deck(b, f, atlas, stucco, x0, d, x1, 0, y0, shadeRGB(wall, 0.55), -1);
  } else {
    deck(b, f, atlas, stucco, x0, d, x1, 0, y0, shadeRGB(wall, 0.5), 1);
  }
}

/** A weathering streak below a sill, cornice or balcony — §3.2, 35 % of them. */
export function dripStreak(k: KitCtx, x0: number, x1: number, yTop: number, len: number): void {
  const { b, f, atlas, wall, stucco } = k;
  panel(b, f, atlas, stucco, x0, yTop - len, x1, yTop, 0.002, shadeRGB(wall, 0.85), {
    shadeBottom: 1.06,
    shadeTop: 0.88,
  });
}

/**
 * **Quoins** — alternating corner blocks. Reserved for the grander houses on
 * the plaza, per §9's "typology-literate" anchor.
 */
export function quoins(k: KitCtx, x: number, y0: number, y1: number, side: 1 | -1): void {
  const { b, f, atlas, trim, stucco } = k;
  const bh = 0.46;
  const n = Math.floor((y1 - y0) / bh);
  for (let i = 0; i < n; i++) {
    const w = i % 2 === 0 ? 0.62 : 0.38;
    const xa = side > 0 ? x - w : x;
    const xb = side > 0 ? x : x + w;
    box(b, f, atlas, stucco, xa, y0 + i * bh, 0, xb, y0 + (i + 1) * bh - 0.03, 0.05, trim, FACE_TRIM);
  }
}

/**
 * **Cuarto esquinero** — the corner room. A chamfered, slightly projecting
 * corner bay carried up the full height with its own cornice return. §1.4 puts
 * one on 1 in 6 corner buildings; they are the best silhouette moment on the
 * street.
 */
export function cuartoEsquinero(k: KitCtx, x: number, y0: number, y1: number, side: 1 | -1, depth = 0.38): void {
  const { b, f, atlas, wall, trim, stucco } = k;
  const w = 1.15;
  const xa = side > 0 ? x - w : x;
  const xb = side > 0 ? x : x + w;
  box(b, f, atlas, stucco, xa, y0, 0, xb, y1, depth, wall, FACE_PZ | FACE_PX | FACE_NX, CASA.stuccoTile);
  // a corbel under it and a cap over it
  box(b, f, atlas, stucco, xa - 0.08, y0 - 0.28, 0, xb + 0.08, y0, depth + 0.08, trim, FACE_TRIM);
  box(b, f, atlas, stucco, xa - 0.1, y1, 0, xb + 0.1, y1 + 0.22, depth + 0.1, trim, FACE_TRIM);
}

/** An azulejo street plaque set into the wall — §1.1, mandatory per corner. */
export function azulejoPlaque(k: KitCtx, x: number, y: number): void {
  const { b, f, atlas, stucco, trim } = k;
  const w = 0.42;
  const h = 0.3;
  box(b, f, atlas, stucco, x - w * 0.5 - 0.03, y - h * 0.5 - 0.03, 0, x + w * 0.5 + 0.03, y + h * 0.5 + 0.03, 0.02, trim, FACE_TRIM);
  panel(b, f, atlas, atlas.rect('azulejo'), x - w * 0.5, y - h * 0.5, x + w * 0.5, y + h * 0.5, 0.026, WHITE);
}

/** The little matching number tile beside the door. */
export function numberTile(k: KitCtx, x: number, y: number): void {
  const { b, f, atlas } = k;
  panel(b, f, atlas, atlas.rect('numberTile'), x - 0.07, y - 0.09, x + 0.07, y + 0.09, 0.022, WHITE);
}

/**
 * **Shopfront** — §7.1: a stocked window, a painted fascia in correct Spanish
 * and a striped awning. Blank rectangles are §8 failure 58.
 */
export function shopfront(
  k: KitCtx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sign: AtlasRect,
  shuttered: boolean,
  awning: boolean,
): void {
  const { b, f, atlas, trim, joinery } = k;
  opening(k, x0, y0, x1, y1, {
    leaf: shuttered ? atlas.rect('shutterRoll') : atlas.rect('shopGlass'),
    leafColor: shuttered ? joinery : WHITE,
    glow: shuttered ? [0, 0, 0] : [0.85, 0.15, 0.2],
    depth: 0.22,
  });
  // fascia board
  const fy = y1 + 0.1;
  box(b, f, atlas, k.stucco, x0 - 0.16, fy, 0, x1 + 0.16, fy + 0.62, 0.09, trim, FACE_TRIM);
  panel(b, f, atlas, sign, x0 - 0.1, fy + 0.05, x1 + 0.1, fy + 0.57, 0.1, WHITE);
  if (awning) {
    // a canted canvas over the pavement, plus its shadow-catching soffit
    const ay = fy - 0.06;
    const proj = 1.05;
    const drop = 0.42;
    const rect = atlas.rect('awning');
    const u0 = atlas.u(rect, 0);
    const u1 = atlas.u(rect, 3);
    const v0 = atlas.v(rect, 0);
    const v1 = atlas.v(rect, 1);
    const nx = f.nx * 0.55;
    const nz = f.nz * 0.55;
    const p0 = b.vertex(worldX(f, x0 - 0.16, 0.05), f.y0 + ay, worldZ(f, x0 - 0.16, 0.05), nx, 0.83, nz, u0, v0, WHITE);
    const p1 = b.vertex(worldX(f, x1 + 0.16, 0.05), f.y0 + ay, worldZ(f, x1 + 0.16, 0.05), nx, 0.83, nz, u1, v0, WHITE);
    const p2 = b.vertex(worldX(f, x1 + 0.16, proj), f.y0 + ay - drop, worldZ(f, x1 + 0.16, proj), nx, 0.83, nz, u1, v1, WHITE);
    const p3 = b.vertex(worldX(f, x0 - 0.16, proj), f.y0 + ay - drop, worldZ(f, x0 - 0.16, proj), nx, 0.83, nz, u0, v1, WHITE);
    b.quad(p0, p1, p2, p3);
    const q0 = b.vertex(worldX(f, x0 - 0.16, 0.05), f.y0 + ay, worldZ(f, x0 - 0.16, 0.05), -nx, -0.83, -nz, u0, v0, shadeRGB(WHITE, 0.35));
    const q1 = b.vertex(worldX(f, x0 - 0.16, proj), f.y0 + ay - drop, worldZ(f, x0 - 0.16, proj), -nx, -0.83, -nz, u0, v1, shadeRGB(WHITE, 0.35));
    const q2 = b.vertex(worldX(f, x1 + 0.16, proj), f.y0 + ay - drop, worldZ(f, x1 + 0.16, proj), -nx, -0.83, -nz, u1, v1, shadeRGB(WHITE, 0.35));
    const q3 = b.vertex(worldX(f, x1 + 0.16, 0.05), f.y0 + ay, worldZ(f, x1 + 0.16, 0.05), -nx, -0.83, -nz, u1, v0, shadeRGB(WHITE, 0.35));
    b.quad(q0, q1, q2, q3);
  }
}

/* ------------------------------------------------------- instance registry */

export type InstanceMaterial = 'atlas' | 'iron' | 'foliage';

interface InstanceDef {
  geometry: THREE.BufferGeometry;
  material: InstanceMaterial;
  /** matrices bucketed by spatial region */
  regions: THREE.Matrix4[][];
}

/**
 * Collects everything that repeats across the district and emits it as
 * `InstancedMesh` — bucketed into spatial regions so the frustum can still
 * throw half the city away.
 */
export class InstanceRegistry {
  readonly cols: number;
  readonly rows: number;

  private defs = new Map<string, InstanceDef>();
  private minX: number;
  private minZ: number;
  private spanX: number;
  private spanZ: number;
  private _count = 0;

  constructor(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, cols = 3, rows = 2) {
    this.cols = cols;
    this.rows = rows;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.spanX = Math.max(1, bounds.maxX - bounds.minX);
    this.spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
  }

  get regionCount(): number {
    return this.cols * this.rows;
  }

  get instanceCount(): number {
    return this._count;
  }

  region(x: number, z: number): number {
    const i = clamp(Math.floor(((x - this.minX) / this.spanX) * this.cols), 0, this.cols - 1);
    const j = clamp(Math.floor(((z - this.minZ) / this.spanZ) * this.rows), 0, this.rows - 1);
    return j * this.cols + i;
  }

  define(key: string, geometry: THREE.BufferGeometry, material: InstanceMaterial): void {
    if (this.defs.has(key)) return;
    // instanced geometry shares the shell material, which reads aGlow
    if (!geometry.getAttribute('aGlow')) {
      const n = geometry.getAttribute('position').count;
      geometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    }
    const regions: THREE.Matrix4[][] = [];
    for (let i = 0; i < this.regionCount; i++) regions.push([]);
    this.defs.set(key, { geometry, material, regions });
  }

  add(key: string, m: THREE.Matrix4, x: number, z: number): void {
    const def = this.defs.get(key);
    if (!def) return;
    def.regions[this.region(x, z)].push(m.clone());
    this._count++;
  }

  /** Build one `InstancedMesh` per (definition, non-empty region). */
  build(materials: Record<InstanceMaterial, THREE.Material>): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const [key, def] of this.defs) {
      for (let r = 0; r < def.regions.length; r++) {
        const list = def.regions[r];
        if (list.length === 0) continue;
        const mesh = new THREE.InstancedMesh(def.geometry, materials[def.material], list.length);
        mesh.name = `buildings/inst/${key}/${r}`;
        for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i]);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        out.push(mesh);
      }
    }
    return out;
  }

  geometries(): THREE.BufferGeometry[] {
    return [...this.defs.values()].map((d) => d.geometry);
  }

  dispose(): void {
    for (const d of this.defs.values()) d.geometry.dispose();
    this.defs.clear();
  }
}

/* --------------------------------------------------------------- geo utils */

/** A small standalone geometry builder for instanced parts (own local space). */
export class PartBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private n = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: RGB): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.col.push(c.r, c.g, c.b);
    return this.n++;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** axis-aligned box in local space */
  box(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    rect: AtlasRect, atlas: FacadeAtlas, c: RGB, faces = FACE_ALL,
  ): void {
    const u0 = atlas.u(rect, 0.08);
    const u1 = atlas.u(rect, 0.92);
    const v0 = atlas.v(rect, 0.08);
    const v1 = atlas.v(rect, 0.92);
    const add = (
      p: Array<[number, number, number]>,
      nx: number, ny: number, nz: number, cc: RGB,
    ): void => {
      const a = this.vert(p[0][0], p[0][1], p[0][2], nx, ny, nz, u0, v0, cc);
      const b = this.vert(p[1][0], p[1][1], p[1][2], nx, ny, nz, u1, v0, cc);
      const d = this.vert(p[2][0], p[2][1], p[2][2], nx, ny, nz, u1, v1, cc);
      const e = this.vert(p[3][0], p[3][1], p[3][2], nx, ny, nz, u0, v1, cc);
      this.quad(a, b, d, e);
    };
    if (faces & FACE_PZ) add([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0, 0, 1, c);
    if (faces & FACE_NZ) add([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 0, 0, -1, shadeRGB(c, 0.8));
    if (faces & FACE_PX) add([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 1, 0, 0, shadeRGB(c, 0.9));
    if (faces & FACE_NX) add([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], -1, 0, 0, shadeRGB(c, 0.9));
    if (faces & FACE_PY) add([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 0, 1, 0, shadeRGB(c, 1.08));
    if (faces & FACE_NY) add([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 0, -1, 0, shadeRGB(c, 0.5));
  }

  /** a flat card in the local XY plane at depth z, with explicit UVs */
  cardXY(
    x0: number, y0: number, x1: number, y1: number, z: number,
    u0: number, v0: number, u1: number, v1: number, c: RGB, nz = 1,
  ): void {
    const a = this.vert(x0, y0, z, 0, 0, nz, u0, v0, c);
    const b = this.vert(x1, y0, z, 0, 0, nz, u1, v0, c);
    const d = this.vert(x1, y1, z, 0, 0, nz, u1, v1, c);
    const e = this.vert(x0, y1, z, 0, 0, nz, u0, v1, c);
    if (nz > 0) this.quad(a, b, d, e);
    else this.quad(a, e, d, b);
  }

  /** a flat card in the local ZY plane at x, with explicit UVs */
  cardZY(
    z0: number, y0: number, z1: number, y1: number, x: number,
    u0: number, v0: number, u1: number, v1: number, c: RGB, nx = 1,
  ): void {
    const a = this.vert(x, y0, z0, nx, 0, 0, u0, v0, c);
    const b = this.vert(x, y0, z1, nx, 0, 0, u1, v0, c);
    const d = this.vert(x, y1, z1, nx, 0, 0, u1, v1, c);
    const e = this.vert(x, y1, z0, nx, 0, 0, u0, v1, c);
    if (nx > 0) this.quad(a, b, d, e);
    else this.quad(a, e, d, b);
  }

  /** a box with explicit UVs (for non-atlas materials) */
  boxUV(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    u0: number, v0: number, u1: number, v1: number, c: RGB, faces = FACE_ALL,
  ): void {
    const add = (
      p: Array<[number, number, number]>,
      nx: number, ny: number, nz: number, cc: RGB,
    ): void => {
      const a = this.vert(p[0][0], p[0][1], p[0][2], nx, ny, nz, u0, v0, cc);
      const b = this.vert(p[1][0], p[1][1], p[1][2], nx, ny, nz, u1, v0, cc);
      const d = this.vert(p[2][0], p[2][1], p[2][2], nx, ny, nz, u1, v1, cc);
      const e = this.vert(p[3][0], p[3][1], p[3][2], nx, ny, nz, u0, v1, cc);
      this.quad(a, b, d, e);
    };
    if (faces & FACE_PZ) add([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0, 0, 1, c);
    if (faces & FACE_NZ) add([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 0, 0, -1, shadeRGB(c, 0.78));
    if (faces & FACE_PX) add([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 1, 0, 0, shadeRGB(c, 0.9));
    if (faces & FACE_NX) add([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], -1, 0, 0, shadeRGB(c, 0.9));
    if (faces & FACE_PY) add([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 0, 1, 0, shadeRGB(c, 1.1));
    if (faces & FACE_NY) add([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 0, -1, 0, shadeRGB(c, 0.48));
  }

  /** an n-gon prism about the Y axis */
  prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, rect: AtlasRect, atlas: FacadeAtlas, c: RGB, cap = true): void {
    const u0 = atlas.u(rect, 0.1);
    const u1 = atlas.u(rect, 0.9);
    const v0 = atlas.v(rect, 0.1);
    const v1 = atlas.v(rect, 0.9);
    const top: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const nx = Math.cos((a0 + a1) * 0.5);
      const nz = Math.sin((a0 + a1) * 0.5);
      const shade = shadeRGB(c, lerp(0.72, 1.1, clamp01(nx * 0.5 + 0.6)));
      const p0 = this.vert(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0, nx, 0, nz, u0, v0, shadeRGB(shade, 0.85));
      const p1 = this.vert(cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0, nx, 0, nz, u1, v0, shadeRGB(shade, 0.85));
      const p2 = this.vert(cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1, nx, 0, nz, u1, v1, shade);
      const p3 = this.vert(cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1, nx, 0, nz, u0, v1, shade);
      this.quad(p0, p1, p2, p3);
      if (cap) top.push(this.vert(cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1, 0, 1, 0, u0, v0, shadeRGB(c, 1.1)));
    }
    if (cap && top.length >= 3) {
      for (let i = 1; i < top.length - 1; i++) this.tri(top[0], top[i], top[i + 1]);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Compose an instance matrix: translate, yaw, then scale along local X only. */
export function instanceMatrix(
  out: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1,
): THREE.Matrix4 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.set(
    c * scaleX, 0, s * scaleZ, x,
    0, scaleY, 0, y,
    -s * scaleX, 0, c * scaleZ, z,
    0, 0, 0, 1,
  );
  return out;
}

/**
 * Yaw that maps a part's local **+Z onto the façade's outward normal** (and
 * local +X onto the reverse of the frontage direction, which keeps the basis a
 * proper right-handed rotation so winding and back-face culling stay correct).
 * Instanced parts are authored symmetric about local X for exactly this reason.
 */
export function frameYaw(f: Frame): number {
  return Math.atan2(f.nx, f.nz);
}
