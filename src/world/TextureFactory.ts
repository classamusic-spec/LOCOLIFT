/**
 * Loco Lift — procedural texture factory.
 *
 * Everything here is generated in code: no image files, no CDN, no network.
 * Surfaces are built as *fields* (albedo bytes, a float height map, a roughness
 * channel), then turned into `DataTexture`s. Normals are derived from the real
 * height field with a wrapping Sobel filter, so the lighting on the cobbles
 * genuinely matches their shape instead of faking it from the albedo.
 *
 * Every generator samples with wrapped integer coordinates, so every texture
 * tiles seamlessly in both axes.
 *
 * Later modules (buildings, props, sky) should pull from here rather than
 * making their own textures — the cache is keyed, so nothing is built twice.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET, PALETTE } from '../core/Config';
import type { QualityTier } from '../core/types';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';

/* -------------------------------------------------------------- utilities */

/** integer hash -> 0..1 */
function hashi(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), n | 1);
  n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
  return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
}

function wrapi(v: number, period: number): number {
  const m = v % period;
  return m < 0 ? m + period : m;
}

/** value noise on a lattice that repeats every `period` cells — tiles exactly */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hashi(wrapi(xi, period), wrapi(yi, period), seed);
  const b = hashi(wrapi(xi + 1, period), wrapi(yi, period), seed);
  const c = hashi(wrapi(xi, period), wrapi(yi + 1, period), seed);
  const d = hashi(wrapi(xi + 1, period), wrapi(yi + 1, period), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fractal tiling noise; `period` is the lattice period at the base octave */
function tileFbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += tileNoise(x * f, y * f, period * f, seed + i * 7717) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

interface VoronoiHit {
  f1: number;
  f2: number;
  id: number;
  /** 0..1 random value stable per cell */
  rand: number;
  rand2: number;
}

const voroHit: VoronoiHit = { f1: 0, f2: 0, id: 0, rand: 0, rand2: 0 };

/**
 * Voronoi on a *brick-bonded* lattice that wraps at `cx` by `cy` cells.
 * Low jitter gives the blocky, quasi-rectangular adoquín; high jitter gives
 * organic river stone. `cy` must be even for the half-row offset to tile.
 */
function tiledVoronoi(
  px: number,
  py: number,
  cx: number,
  cy: number,
  jitter: number,
  bond: number,
  seed: number,
): VoronoiHit {
  const gx = px * cx;
  const gy = py * cy;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  let r1 = 0;
  let r2 = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ci = ix + di;
      const cj = iy + dj;
      const wi = wrapi(ci, cx);
      const wj = wrapi(cj, cy);
      const h1 = hashi(wi, wj, seed);
      const h2 = hashi(wi, wj, seed ^ 0x5bf0_3a17);
      const fx = ci + 0.5 + (wj & 1 ? bond : 0) + (h1 - 0.5) * jitter;
      const fy = cj + 0.5 + (h2 - 0.5) * jitter;
      // cells are wider than tall on the ground plane; normalise the metric
      const dx = (gx - fx) / cx;
      const dy = (gy - fy) / cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = wj * cx + wi;
        r1 = h1;
        r2 = h2;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  voroHit.f1 = f1;
  voroHit.f2 = f2;
  voroHit.id = id;
  voroHit.rand = r1;
  voroHit.rand2 = r2;
  return voroHit;
}

/* ---------------------------------------------------------- normal from h */

/**
 * Sobel the height field into a tangent-space normal map. Sampling wraps, so
 * the normal map tiles exactly like the height it came from.
 *
 * Exported because buildings, props and the fort walls all need it.
 */
export function heightToNormal(
  height: Float32Array,
  w: number,
  h: number,
  strength: number,
): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const at = (x: number, y: number): number => height[wrapi(y, h) * w + wrapi(x, w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = dx * strength;
      let ny = dy * strength;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const o = (y * w + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------- data types */

export type SurfaceId =
  | 'cobblestone'
  | 'flagstone'
  | 'kerbstone'
  | 'sand'
  | 'grass'
  | 'roofTile'
  | 'sandstone'
  | 'stucco'
  | 'asphalt'
  | 'seaFoam';

export interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  /** how many metres of world one UV tile spans — drives material repeat */
  tileMeters: number;
  /** suggested normalScale for this surface */
  normalStrength: number;
}

/** Field buffers a surface generator fills in. */
interface Field {
  size: number;
  /** rgb bytes, size*size*3 */
  albedo: Uint8Array;
  /** 0..1 relief */
  height: Float32Array;
  /** 0..1 roughness */
  rough: Float32Array;
}

function makeField(size: number): Field {
  return {
    size,
    albedo: new Uint8Array(size * size * 3),
    height: new Float32Array(size * size),
    rough: new Float32Array(size * size),
  };
}

function setRGB(f: Field, i: number, r: number, g: number, b: number): void {
  f.albedo[i * 3] = clamp(r, 0, 255) | 0;
  f.albedo[i * 3 + 1] = clamp(g, 0, 255) | 0;
  f.albedo[i * 3 + 2] = clamp(b, 0, 255) | 0;
}

function hexRGB(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function mixRGB(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* ------------------------------------------------------------- generators */

/**
 * **Adoquín** — the blue-grey cobblestone that defines Old San Juan. Cast iron
 * slag blocks, brick-bonded, worn round at the edges by two centuries of
 * traffic, with the colour drifting from slate blue through teal grey.
 */
function genCobblestone(size: number): Field {
  const f = makeField(size);
  const CX = 10;
  const CY = 12; // even, so the half-row bond wraps
  const STONE_TINTS: Array<[number, number, number]> = [
    hexRGB(0x3f5670),
    hexRGB(0x4a5d78),
    hexRGB(0x546a7c),
    hexRGB(0x466c6c),
    hexRGB(0x5d6e85),
    hexRGB(0x64707a),
    hexRGB(0x3b5164),
    hexRGB(0x51667a),
  ];
  const MORTAR = hexRGB(0x2f3540);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;

      // warp the lattice slightly so the courses are not machine-perfect
      const wx = u + (tileFbm(u * 6, v * 6, 6, 3, 991) - 0.5) * 0.012;
      const wy = v + (tileFbm(u * 6 + 13, v * 6 + 7, 6, 3, 4231) - 0.5) * 0.012;
      const h = tiledVoronoi(wx, wy, CX, CY, 0.42, 0.5, 20259);

      // (f2 - f1) is ~0 exactly on a cell boundary: the mortar line
      const border = (h.f2 - h.f1) * Math.max(CX, CY);
      const joint = smoothstep(border / 0.34); // 0 in the joint, 1 on the stone
      const bevel = smoothstep(border / 0.9); // wider, for the worn round edge

      const grain = tileFbm(u * 42, v * 42, 42, 4, 7717);
      const micro = tileFbm(u * 150, v * 150, 150, 2, 313);
      const stoneRand = h.rand;
      const stoneRand2 = h.rand2;

      // relief: domed stone tops, deep recessed joints, sanded-off high spots
      const dome = Math.pow(bevel, 0.55);
      const wear = 1 - 0.16 * Math.pow(stoneRand2, 2);
      let height = 0.18 + dome * 0.62 * wear;
      height += (stoneRand - 0.5) * 0.10; // some stones sit proud
      height -= (1 - joint) * 0.30; // mortar sits low
      height += (grain - 0.5) * 0.045 * bevel;
      height += (micro - 0.5) * 0.02;
      f.height[i] = clamp01(height);

      // colour: per-stone tint, mortar in the joints, dirt in the low spots
      const tint = STONE_TINTS[h.id % STONE_TINTS.length];
      const drift = (tileNoise(u * 3.2, v * 3.2, 3, 5501) - 0.5) * 0.5;
      let col = mixRGB(tint, STONE_TINTS[(h.id * 7 + 3) % STONE_TINTS.length], clamp01(0.5 + drift));
      // teal cast on a fraction of the stones
      if (stoneRand2 > 0.78) col = mixRGB(col, hexRGB(0x3e6f6b), 0.4);
      // polished centre / darker rim
      col = mixRGB(mixRGB(col, [22, 26, 33], 0.35), col, bevel);
      // mineral speckle
      const sp = (grain - 0.5) * 34 + (micro - 0.5) * 18;
      col = [col[0] + sp, col[1] + sp, col[2] + sp * 0.9];
      // mortar / sand between the stones
      const dirt = mixRGB(MORTAR, hexRGB(0x4d4a44), tileFbm(u * 20, v * 20, 20, 3, 88));
      col = mixRGB(dirt, col, joint);
      // long-term traffic polish: the crowns get lighter
      const polish = smoothstep((height - 0.55) / 0.35) * (0.10 + 0.08 * stoneRand);
      col = mixRGB(col, [176, 186, 198], polish);

      setRGB(f, i, col[0], col[1], col[2]);
      f.rough[i] = clamp01(lerp(0.97, lerp(0.72, 0.42, polish * 4), joint) - (grain - 0.5) * 0.08);
    }
  }
  return f;
}

/** Large sawn slabs with tight joints — plaza and promenade paving. */
function genFlagstone(size: number): Field {
  const f = makeField(size);
  const CX = 4;
  const CY = 4;
  const TINTS: Array<[number, number, number]> = [
    hexRGB(0xa8a294),
    hexRGB(0x9c9789),
    hexRGB(0xb3ac9c),
    hexRGB(0x8f8d82),
    hexRGB(0xada38f),
  ];
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const h = tiledVoronoi(u, v, CX, CY, 0.22, 0.35, 3313);
      const border = (h.f2 - h.f1) * Math.max(CX, CY);
      const joint = smoothstep(border / 0.10);
      const bevel = smoothstep(border / 0.26);
      const grain = tileFbm(u * 30, v * 30, 30, 4, 1201);
      const veins = tileFbm(u * 7, v * 7, 7, 3, 6151);

      f.height[i] = clamp01(
        0.55 + bevel * 0.32 + (h.rand - 0.5) * 0.05 - (1 - joint) * 0.5 + (grain - 0.5) * 0.03,
      );

      let col = TINTS[h.id % TINTS.length];
      col = mixRGB(col, TINTS[(h.id * 5 + 1) % TINTS.length], veins);
      const sp = (grain - 0.5) * 22;
      col = [col[0] + sp, col[1] + sp, col[2] + sp];
      col = mixRGB(hexRGB(0x6b6659), col, joint);
      setRGB(f, i, col[0], col[1], col[2]);
      f.rough[i] = clamp01(lerp(0.95, 0.66, joint) + (grain - 0.5) * 0.1);
    }
  }
  return f;
}

/** Pale granite kerb stones, long blocks with chiselled tops. */
function genKerbstone(size: number): Field {
  const f = makeField(size);
  const CX = 2;
  const CY = 8;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const h = tiledVoronoi(u, v, CX, CY, 0.10, 0, 9091);
      const border = (h.f2 - h.f1) * Math.max(CX, CY);
      const joint = smoothstep(border / 0.06);
      const grain = tileFbm(u * 60, v * 60, 60, 4, 601);
      const chisel = tileFbm(u * 22, v * 110, 22, 3, 4409);
      f.height[i] = clamp01(0.62 + (chisel - 0.5) * 0.28 - (1 - joint) * 0.45);
      const base = mixRGB(hexRGB(0xb9b4a6), hexRGB(0x9a968b), grain);
      const sp = (chisel - 0.5) * 26;
      let col: [number, number, number] = [base[0] + sp, base[1] + sp, base[2] + sp];
      col = mixRGB(hexRGB(0x615d55), col, joint);
      setRGB(f, i, col[0], col[1], col[2]);
      f.rough[i] = clamp01(0.86 + (grain - 0.5) * 0.16);
    }
  }
  return f;
}

/** Wind-rippled beach sand. */
function genSand(size: number): Field {
  const f = makeField(size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const ripple = Math.sin((u * 14 + tileFbm(u * 4, v * 4, 4, 3, 71) * 6) * Math.PI * 2) * 0.5 + 0.5;
      const dune = tileFbm(u * 5, v * 5, 5, 4, 8123);
      const grain = tileFbm(u * 180, v * 180, 180, 2, 1777);
      f.height[i] = clamp01(0.4 + ripple * 0.18 + (dune - 0.5) * 0.4 + (grain - 0.5) * 0.12);
      const col = mixRGB(hexRGB(0xe4d3ae), hexRGB(0xc9b391), dune * 0.8 + ripple * 0.2);
      const sp = (grain - 0.5) * 30;
      setRGB(f, i, col[0] + sp, col[1] + sp, col[2] + sp * 0.8);
      f.rough[i] = clamp01(0.95 + (grain - 0.5) * 0.08);
    }
  }
  return f;
}

/** Clumpy tropical grass for the glacis. */
function genGrass(size: number): Field {
  const f = makeField(size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const clump = tileFbm(u * 9, v * 9, 9, 4, 4919);
      const blade = tileFbm(u * 90, v * 90, 90, 3, 2287);
      const dry = tileFbm(u * 3, v * 3, 3, 3, 6673);
      f.height[i] = clamp01(0.4 + (clump - 0.5) * 0.5 + (blade - 0.5) * 0.5);
      let col = mixRGB(hexRGB(0x5d8a3a), hexRGB(0x3f6b2c), clump);
      col = mixRGB(col, hexRGB(0x8a9a4a), clamp01((dry - 0.55) * 2.4));
      const sp = (blade - 0.5) * 40;
      setRGB(f, i, col[0] + sp * 0.6, col[1] + sp, col[2] + sp * 0.4);
      f.rough[i] = 0.94;
    }
  }
  return f;
}

/** Barrel roof tiles — half-cylinders in alternating pan/cover courses. */
function genRoofTile(size: number): Field {
  const f = makeField(size);
  const COLS = 8;
  const ROWS = 5;
  const TINTS = PALETTE.roofTile.map(hexRGB);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const cu = u * COLS;
      const cv = v * ROWS;
      const ci = Math.floor(cu);
      const cj = Math.floor(cv);
      const fu = cu - ci;
      const fv = cv - cj;
      // cylinder cross-section across the course
      const barrel = Math.sqrt(Math.max(0, 1 - (fu * 2 - 1) * (fu * 2 - 1)));
      // each course laps over the one below
      const lap = smoothstep(fv / 0.16);
      const grain = tileFbm(u * 70, v * 70, 70, 3, 5077);
      const weather = tileFbm(u * 6, v * 6, 6, 4, 1913);
      f.height[i] = clamp01(0.25 + barrel * 0.6 * lap + (grain - 0.5) * 0.05 + lap * 0.1);

      const idx = (Math.imul(ci + 1, 73) ^ Math.imul(cj + 1, 151)) >>> 0;
      let col = TINTS[idx % TINTS.length];
      col = mixRGB(col, hexRGB(0x7a5a44), weather * 0.55);
      // moss and salt bloom in the pans
      col = mixRGB(col, hexRGB(0x6d7a52), clamp01((weather - 0.68) * 2.2) * (1 - barrel));
      const shade = lerp(0.55, 1.12, barrel) * lerp(0.7, 1, lap);
      const sp = (grain - 0.5) * 24;
      setRGB(f, i, col[0] * shade + sp, col[1] * shade + sp, col[2] * shade + sp);
      f.rough[i] = clamp01(0.82 + (grain - 0.5) * 0.14);
    }
  }
  return f;
}

/** Big ashlar blocks of pitted sandstone — the fort walls and garitas. */
function genSandstone(size: number): Field {
  const f = makeField(size);
  const CX = 3;
  const CY = 6;
  const base = hexRGB(PALETTE.fortStone);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const h = tiledVoronoi(u, v, CX, CY, 0.12, 0.5, 12289);
      const border = (h.f2 - h.f1) * Math.max(CX, CY);
      const joint = smoothstep(border / 0.09);
      const pit = tileFbm(u * 46, v * 46, 46, 4, 2609);
      const salt = tileFbm(u * 8, v * 8, 8, 4, 7919);
      const coarse = tileFbm(u * 16, v * 16, 16, 3, 3517);

      const pitting = clamp01((pit - 0.62) * 3) * 0.35;
      f.height[i] = clamp01(
        0.66 + (h.rand - 0.5) * 0.07 + (coarse - 0.5) * 0.12 - pitting - (1 - joint) * 0.42,
      );

      let col = mixRGB(base, hexRGB(0xa89a7c), coarse);
      col = mixRGB(col, hexRGB(0xd9d2bd), clamp01((salt - 0.6) * 2.2) * 0.6); // salt bloom
      col = mixRGB(col, hexRGB(0x6d7a58), clamp01((salt - 0.78) * 3) * 0.5); // sea moss
      col = mixRGB(col, hexRGB(0x6f6551), pitting * 1.6);
      const sp = (pit - 0.5) * 20;
      col = [col[0] + sp, col[1] + sp, col[2] + sp * 0.8];
      col = mixRGB(hexRGB(0x8d8571), col, joint);
      setRGB(f, i, col[0], col[1], col[2]);
      f.rough[i] = clamp01(0.9 + (coarse - 0.5) * 0.12);
    }
  }
  return f;
}

/**
 * Lime stucco: trowel sweeps, hairline crazing and weathering streaks running
 * down from the sills. Kept near-white so the façade tint can be a material
 * colour multiply.
 */
function genStucco(size: number): Field {
  const f = makeField(size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      // trowel arcs: low-frequency noise smeared along a swept direction
      const sweep = tileFbm(u * 5 + v * 1.5, v * 4, 5, 3, 8237);
      const fine = tileFbm(u * 38, v * 38, 38, 4, 1009);
      const crazing = Math.abs(tileFbm(u * 26, v * 26, 26, 3, 6689) - 0.5);
      const crack = smoothstep((0.045 - crazing) / 0.045);
      // vertical weathering streaks (rain running off balconies)
      const streakSeed = tileFbm(u * 22, v * 1.2, 22, 2, 4441);
      const streak = clamp01((streakSeed - 0.55) * 2.6) * smoothstep(v * 1.4);

      f.height[i] = clamp01(0.6 + (sweep - 0.5) * 0.34 + (fine - 0.5) * 0.14 - crack * 0.35);

      let col = mixRGB(hexRGB(0xf3ece0), hexRGB(0xdcd3c4), sweep);
      col = mixRGB(col, hexRGB(0xbcb2a2), streak * 0.55);
      col = mixRGB(col, hexRGB(0x9c9382), crack * 0.5);
      const sp = (fine - 0.5) * 16;
      setRGB(f, i, col[0] + sp, col[1] + sp, col[2] + sp);
      f.rough[i] = clamp01(0.88 + (sweep - 0.5) * 0.12 - streak * 0.08);
    }
  }
  return f;
}

/** Modern asphalt for the cruise apron and the coastal carriageway. */
function genAsphalt(size: number): Field {
  const f = makeField(size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const chip = tileFbm(u * 110, v * 110, 110, 3, 5261);
      const patch = tileFbm(u * 5, v * 5, 5, 4, 1493);
      const crack = Math.abs(tileFbm(u * 14, v * 14, 14, 3, 8677) - 0.5);
      const crackLine = smoothstep((0.03 - crack) / 0.03);
      f.height[i] = clamp01(0.55 + (chip - 0.5) * 0.42 - crackLine * 0.4);
      const g = lerp(46, 78, patch) + (chip - 0.5) * 46;
      let col: [number, number, number] = [g, g * 1.01, g * 1.05];
      col = mixRGB(col, [26, 26, 28], crackLine);
      setRGB(f, i, col[0], col[1], col[2]);
      f.rough[i] = clamp01(0.9 + (chip - 0.5) * 0.16 - patch * 0.1);
    }
  }
  return f;
}

/** Two-scale ripple normal source for the sea. Albedo is near-flat. */
function genSeaFoam(size: number): Field {
  const f = makeField(size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const big = tileFbm(u * 4, v * 4, 4, 3, 3229);
      const small = tileFbm(u * 17, v * 17, 17, 4, 7433);
      const chop = Math.sin((u * 3 + big * 2) * Math.PI * 2) * 0.5 + 0.5;
      f.height[i] = clamp01(0.4 + (big - 0.5) * 0.5 + (small - 0.5) * 0.34 + chop * 0.12);
      const foam = clamp01((small - 0.60) * 4.2) * clamp01((big - 0.46) * 2.6);
      const col = mixRGB(hexRGB(PALETTE.sea), hexRGB(0xd8ecf4), foam * 0.85);
      setRGB(f, i, col[0], col[1], col[2]);
      f.rough[i] = clamp01(0.10 + foam * 0.55);
    }
  }
  return f;
}

/* ------------------------------------------------------------- descriptors */

interface SurfaceSpec {
  gen: (size: number) => Field;
  baseSize: number;
  /** hard ceiling — only the hero surface earns a 1k map */
  maxSize?: number;
  tileMeters: number;
  normalStrength: number;
  /** relief scale fed to the Sobel — bigger = deeper apparent relief */
  relief: number;
  wantNormal: boolean;
  wantRoughness: boolean;
}

const SPECS: Record<SurfaceId, SurfaceSpec> = {
  cobblestone: { gen: genCobblestone, baseSize: 512, maxSize: 1024, tileMeters: 1.9, normalStrength: 1.15, relief: 3.4, wantNormal: true, wantRoughness: true },
  flagstone: { gen: genFlagstone, baseSize: 512, tileMeters: 4.2, normalStrength: 0.7, relief: 2.4, wantNormal: true, wantRoughness: true },
  kerbstone: { gen: genKerbstone, baseSize: 256, tileMeters: 2.6, normalStrength: 0.8, relief: 2.6, wantNormal: true, wantRoughness: true },
  sand: { gen: genSand, baseSize: 256, tileMeters: 5.0, normalStrength: 0.55, relief: 1.6, wantNormal: true, wantRoughness: false },
  grass: { gen: genGrass, baseSize: 256, tileMeters: 4.0, normalStrength: 0.6, relief: 1.4, wantNormal: true, wantRoughness: false },
  roofTile: { gen: genRoofTile, baseSize: 512, tileMeters: 2.2, normalStrength: 1.0, relief: 3.0, wantNormal: true, wantRoughness: true },
  sandstone: { gen: genSandstone, baseSize: 512, tileMeters: 4.5, normalStrength: 0.9, relief: 2.8, wantNormal: true, wantRoughness: true },
  stucco: { gen: genStucco, baseSize: 512, tileMeters: 3.2, normalStrength: 0.45, relief: 1.5, wantNormal: true, wantRoughness: true },
  asphalt: { gen: genAsphalt, baseSize: 256, tileMeters: 5.5, normalStrength: 0.5, relief: 1.8, wantNormal: true, wantRoughness: true },
  seaFoam: { gen: genSeaFoam, baseSize: 256, tileMeters: 26, normalStrength: 0.6, relief: 2.2, wantNormal: true, wantRoughness: false },
};

const TIER_SCALE: Record<QualityTier, number> = { low: 0.5, medium: 0.75, high: 1, ultra: 1.5 };

function pow2(n: number): number {
  return Math.max(64, Math.min(2048, 1 << Math.round(Math.log2(n))));
}

/* ------------------------------------------------------------------ factory */

/**
 * Caches every generated texture by key. Later world layers should reuse this
 * instance (`World.textures`) rather than constructing their own.
 */
export class TextureFactory {
  readonly quality: QualityTier;
  readonly anisotropy: number;

  private cache = new Map<string, THREE.Texture>();
  private surfaces = new Map<SurfaceId, SurfaceMaps>();
  private disposed = false;

  constructor(quality: QualityTier, maxAnisotropy = Infinity) {
    this.quality = quality;
    this.anisotropy = Math.max(1, Math.min(QUALITY_BUDGET[quality].anisotropy, maxAnisotropy));
  }

  /** Every texture this factory hands out has already been registered here. */
  private register(key: string, tex: THREE.Texture): THREE.Texture {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;
    this.cache.set(key, tex);
    return tex;
  }

  /** Generic memoised slot — build once, share forever. */
  texture(key: string, build: () => THREE.Texture): THREE.Texture {
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.register(key, build());
  }

  /**
   * Canvas2D escape hatch for later modules (signage, murals, decals). Returns
   * a cached, wrapped, anisotropic texture. Throws when no canvas is available,
   * which only happens in a head-less context.
   */
  canvasTexture(
    key: string,
    width: number,
    height: number,
    draw: (ctx: Canvas2D, w: number, h: number) => void,
    colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
  ): THREE.Texture {
    return this.texture(key, () => {
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d') as Canvas2D | null;
      if (!ctx) throw new Error('TextureFactory: 2D canvas context unavailable');
      draw(ctx, width, height);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = colorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      return tex;
    });
  }

  /** Flat 1x1 colour texture — handy for tinting shared materials. */
  solid(hex: number): THREE.Texture {
    return this.texture(`solid:${hex.toString(16)}`, () => {
      const [r, g, b] = hexRGB(hex);
      const tex = new THREE.DataTexture(
        new Uint8Array([r, g, b, 255]),
        1,
        1,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
  }

  /** Albedo + normal + roughness for one of the standard world surfaces. */
  surface(id: SurfaceId): SurfaceMaps {
    const hit = this.surfaces.get(id);
    if (hit) return hit;

    const spec = SPECS[id];
    const size = this.sizeFor(spec);
    const field = spec.gen(size);

    const albedo = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      albedo[i * 4] = field.albedo[i * 3];
      albedo[i * 4 + 1] = field.albedo[i * 3 + 1];
      albedo[i * 4 + 2] = field.albedo[i * 3 + 2];
      albedo[i * 4 + 3] = 255;
    }
    const map = this.register(
      `surface:${id}:map`,
      (() => {
        const t = new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        return t;
      })(),
    );

    let normalMap: THREE.Texture | null = null;
    if (spec.wantNormal) {
      normalMap = this.register(
        `surface:${id}:normal`,
        heightToNormal(field.height, size, size, spec.relief),
      );
    }

    let roughnessMap: THREE.Texture | null = null;
    if (spec.wantRoughness) {
      // three reads roughness from G and metalness from B; write all three so
      // the same texture can double as an ORM source for later modules.
      const rough = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const r = clamp(field.rough[i], 0, 1) * 255;
        rough[i * 4] = 255; // AO left free
        rough[i * 4 + 1] = r;
        rough[i * 4 + 2] = 0; // non-metal
        rough[i * 4 + 3] = 255;
      }
      roughnessMap = this.register(
        `surface:${id}:rough`,
        (() => {
          const t = new THREE.DataTexture(rough, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
          t.colorSpace = THREE.NoColorSpace;
          t.magFilter = THREE.LinearFilter;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.generateMipmaps = true;
          return t;
        })(),
      );
    }

    const maps: SurfaceMaps = {
      map,
      normalMap,
      roughnessMap,
      tileMeters: spec.tileMeters,
      normalStrength: spec.normalStrength,
    };
    this.surfaces.set(id, maps);
    return maps;
  }

  private sizeFor(spec: SurfaceSpec): number {
    return pow2(Math.min(spec.baseSize * TIER_SCALE[this.quality], spec.maxSize ?? 512));
  }

  /** Raw height field for a surface — useful for displacement or decals. */
  heightField(id: SurfaceId): { data: Float32Array; size: number } {
    const spec = SPECS[id];
    const size = this.sizeFor(spec);
    return { data: spec.gen(size).height, size };
  }

  get textureCount(): number {
    return this.cache.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
    this.surfaces.clear();
  }
}

/* --------------------------------------------------------------- canvas 2d */

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Either flavour of 2D context — the drawing API surface is identical. */
export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Prefers OffscreenCanvas so texture baking never touches the DOM. */
export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('TextureFactory: no canvas implementation available');
}
