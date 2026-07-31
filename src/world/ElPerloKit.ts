/**
 * Loco Lift — El Perlo kit.
 *
 * Everything the {@link ElPerlo} district is made of: its palette, its texture
 * atlas, a small world-space mesh accumulator, and the part builders for the
 * concrete houses, retaining walls, city wall, roof clutter, utility poles,
 * stairs, planting and shore rock that make up the barrio.
 *
 * Design notes that matter:
 *
 *  - **One atlas, one opaque material, one cut-out material.** Every wall,
 *    roof, parapet, door, tank, pole and car in El Perlo samples the same
 *    2D atlas and is merged into a handful of sector meshes. The whole
 *    district costs about a dozen draw calls.
 *  - **Walls are white in the texture and coloured by the vertex stream.**
 *    The barrio's defining feature is whole walls in one flat, ferociously
 *    saturated colour — cobalt, hot yellow, lime, turquoise, coral. Keeping
 *    the paint in `aColor` means 200 houses in 40 colours cost one texture.
 *  - **Anti-tiling by window, not by tile.** Two rows of the atlas hold a
 *    continuous field of weathered render; every wall face picks its own
 *    random window (and flip) out of that field, so no two walls in the
 *    district carry the same stain pattern (§2.3, §8.17).
 *  - **Gravity-correct weathering is in the vertex colours.** Every wall is
 *    banded top to bottom: bleached at the parapet, saturated in the middle,
 *    splash-stained and contact-dark at the pavement (§8.2, §8.18).
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { QualityTier } from '../core/types';
import { TextureFactory, createCanvas, heightToNormal } from './TextureFactory';
import type { Canvas2D } from './TextureFactory';

/* ========================================================================== *
 *  dimensions
 * ========================================================================== */

/** Every number the barrio is built from, metres. */
export const EP = {
  /** floor-to-floor of a concrete barrio house — deliberately short */
  storey: 3.35,
  /** vertical step between one lane and the next */
  step: 3.4,
  /** roof parapet above the deck */
  parapet: 0.62,
  /** parapet thickness */
  parapetT: 0.17,
  /** roof slab thickness seen at the eaves */
  slab: 0.24,
  /** exterior wall thickness — visible in every reveal (§8.3) */
  wallT: 0.3,
  /** window reveal depth */
  reveal: 0.24,
  /** typical window */
  winW: 0.98,
  winH: 1.26,
  winSill: 1.06,
  /** typical door */
  doorW: 0.94,
  doorH: 2.14,
  /** kerb along the lanes */
  kerbH: 0.13,
} as const;

/* ========================================================================== *
 *  colour
 * ========================================================================== */

export interface Col {
  r: number;
  g: number;
  b: number;
}

const _c = new THREE.Color();

/** sRGB hex → the linear triple three's `vertexColors` expects. */
export function rgb(hex: number, mul = 1): Col {
  _c.setHex(hex, THREE.SRGBColorSpace);
  return { r: _c.r * mul, g: _c.g * mul, b: _c.b * mul };
}

export function shade(c: Col, k: number): Col {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

export function mixCol(a: Col, b: Col, t: number): Col {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

export const WHITE: Col = { r: 1, g: 1, b: 1 };

/**
 * The barrio palette. Far louder than the colonial city above it: these are
 * hardware-store enamels straight from the tin, sun-bleached over ten years.
 * Ordered so neighbouring entries are never close in hue — the placer walks
 * the list with a stride so two adjacent houses can never share a family
 * (§8.27).
 */
export const PAINT: readonly number[] = [
  0x1f5fd8, // cobalt
  0xffc714, // hot yellow
  0x2fc36a, // lime green
  0xff6a1f, // orange
  0x18b6c4, // turquoise
  0xf0468f, // hot pink
  0x8fe0b0, // mint
  0xe23b34, // pillar-box red
  0x6d5ec9, // violet
  0xc9e246, // acid lime
  0x0f8fa8, // deep teal
  0xffb0c8, // candy pink
  0x3fae3a, // grass green
  0xf7f0dc, // bone white
  0xffe36b, // pale yellow
  0x27407e, // navy
  0xff8a4f, // apricot
  0x00a3a3, // peacock
  0xd8d2c4, // bare render
  0xe8557a, // rose
] as const;

/** Trim: door surrounds, sills, parapet copings. Always lighter than the wall. */
export const TRIM: readonly number[] = [0xfbf7ef, 0xf3ece0, 0xffffff, 0xe9f2f7, 0xfdf3d8] as const;

/** Joinery: doors, shutters, gates, rejas. Always darker than the wall (§L2). */
export const JOINERY: readonly number[] = [
  0x14324f, 0x7a1f1f, 0x1c4a2b, 0x3a2a1c, 0x2b2f36, 0x5c1f4a, 0x0f4650,
] as const;

/** Concrete family: bare block, raw slab, weathered render. */
export const CONCRETE = {
  bare: 0xb8b2a4,
  raw: 0x9d9a92,
  roof: 0xa8a498,
  dark: 0x6f6c66,
  rust: 0x8a4a24,
} as const;

/* ========================================================================== *
 *  atlas
 * ========================================================================== */

export interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Named atlas cells. Grid is 8 × 8; rows 6–7 are the continuous wall field. */
export type TileId =
  | 'render0'
  | 'render1'
  | 'render2'
  | 'block'
  | 'rawcrete'
  | 'patched'
  | 'roofdeck'
  | 'tarpatch'
  | 'asphalt'
  | 'concrete'
  | 'rock'
  | 'shingle'
  | 'zinc'
  | 'zincRust'
  | 'rubble'
  | 'plastic'
  | 'doorPanel'
  | 'doorSteel'
  | 'doorLouvre'
  | 'window'
  | 'shutter'
  | 'tank'
  | 'tread'
  | 'tarp'
  | 'muralWave'
  | 'muralFlag'
  | 'muralFish'
  | 'signColmado'
  | 'signBarberia'
  | 'signLavanderia'
  | 'signPerlo'
  | 'azulejo'
  | 'reja'
  | 'rail'
  | 'aerial'
  | 'dish'
  | 'clothA'
  | 'clothB'
  | 'sprig'
  | 'frond'
  | 'banana'
  | 'tuft'
  | 'flowers'
  | 'carBody'
  | 'wire'
  | 'numberTile';

const GRID = 8;

const CELLS: Record<TileId, readonly [number, number]> = {
  render0: [0, 0],
  render1: [1, 0],
  render2: [2, 0],
  block: [3, 0],
  rawcrete: [4, 0],
  patched: [5, 0],
  roofdeck: [6, 0],
  tarpatch: [7, 0],

  asphalt: [0, 1],
  concrete: [1, 1],
  rock: [2, 1],
  shingle: [3, 1],
  zinc: [4, 1],
  zincRust: [5, 1],
  rubble: [6, 1],
  plastic: [7, 1],

  doorPanel: [0, 2],
  doorSteel: [1, 2],
  doorLouvre: [2, 2],
  window: [3, 2],
  shutter: [4, 2],
  tank: [5, 2],
  tread: [6, 2],
  tarp: [7, 2],

  muralWave: [0, 3],
  muralFlag: [1, 3],
  muralFish: [2, 3],
  signColmado: [3, 3],
  signBarberia: [4, 3],
  signLavanderia: [5, 3],
  signPerlo: [6, 3],
  azulejo: [7, 3],

  reja: [0, 4],
  rail: [1, 4],
  aerial: [2, 4],
  dish: [3, 4],
  clothA: [4, 4],
  clothB: [5, 4],
  sprig: [6, 4],
  frond: [7, 4],

  banana: [0, 5],
  tuft: [1, 5],
  flowers: [2, 5],
  carBody: [3, 5],
  wire: [4, 5],
  numberTile: [5, 5],
  // [6,5] and [7,5] are spare weathering swatches folded into the wall field
} as const;

/** Cells whose alpha channel is meaningful — they render on the cut material. */
const CUTOUT: ReadonlySet<TileId> = new Set<TileId>([
  'reja',
  'rail',
  'aerial',
  'dish',
  'clothA',
  'clothB',
  'sprig',
  'frond',
  'banana',
  'tuft',
  'flowers',
  'wire',
]);

/* ------------------------------------------------------------ tiny noise */

function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(xi, yi, s);
  const b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s);
  const d = hash2(xi + 1, yi + 1, s);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function fbm(x: number, y: number, oct: number, s: number): number {
  let f = 0;
  let amp = 0.5;
  let sum = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < oct; i++) {
    f += vnoise(fx, fy, s + i * 31) * amp;
    sum += amp;
    amp *= 0.5;
    fx *= 2.03;
    fy *= 1.97;
  }
  return f / sum;
}

/* --------------------------------------------------------- pixel writers */

interface Px {
  r: number;
  g: number;
  b: number;
  a: number;
  /** 0..1 relief height, fed to the Sobel */
  h: number;
  /** 0..1 roughness */
  ro: number;
}

type CellGen = (u: number, v: number, px: Px, size: number) => void;

function setPx(px: Px, r: number, g: number, b: number, a = 1, h = 0.5, ro = 0.9): void {
  px.r = r;
  px.g = g;
  px.b = b;
  px.a = a;
  px.h = h;
  px.ro = ro;
}

/**
 * Weathered painted render. Authored near-white so the vertex stream can turn
 * it into any of the twenty barrio colours; the variation is all value.
 * `grit` drives how far the wall has gone: 0 is a fresh coat, 1 is ten years of
 * salt with the render blown off in patches.
 */
function renderCell(grit: number, seed: number): CellGen {
  return (u, v, px) => {
    const x = u * 7;
    const y = v * 7;
    // broad blotching from repainting and salt bloom
    const blotch = fbm(x * 0.9, y * 0.9, 4, seed);
    const fine = fbm(x * 9, y * 9, 3, seed + 7);
    const grain = vnoise(u * 220, v * 220, seed + 21);
    let l = 0.9 + (blotch - 0.5) * 0.24 * (0.4 + grit) + (fine - 0.5) * 0.1 + (grain - 0.5) * 0.055;

    // vertical run-off streaks — gravity, always downward
    const streak = fbm(x * 5.5, y * 0.55, 3, seed + 33);
    const runoff = clamp01((streak - 0.56) * 3.4) * clamp01(v * 1.4) * (0.18 + grit * 0.3);
    l -= runoff * 0.3;

    // blown render showing the block underneath
    let h = 0.55 + (fine - 0.5) * 0.3;
    const spall = fbm(x * 1.7 + 11, y * 1.7 - 5, 3, seed + 51);
    const spalled = clamp01((spall - (0.72 - grit * 0.2)) * 9) * grit;
    let r = l;
    let g = l;
    let b = l * 0.995;
    if (spalled > 0.01) {
      // exposed grey block: courses, slightly cooler and much rougher
      const course = Math.abs(((v * 22) % 1) - 0.5) < 0.06 ? 0.86 : 1;
      const grey = (0.7 + (grain - 0.5) * 0.12) * course;
      r = lerp(r, grey * 1.02, spalled);
      g = lerp(g, grey, spalled);
      b = lerp(b, grey * 0.97, spalled);
      h = lerp(h, 0.3, spalled);
    }
    // rust bleed from reinforcement, near the top and around spalls
    const rust = clamp01((fbm(x * 3.1 - 8, y * 3.1 + 3, 3, seed + 77) - 0.68) * 6) * grit;
    r = lerp(r, r * 1.05 + 0.16, rust * 0.55);
    g = lerp(g, g * 0.7, rust * 0.55);
    b = lerp(b, b * 0.5, rust * 0.55);

    setPx(px, r, g, b, 1, h, 0.93 - (spalled ? 0 : 0.12) + (grain - 0.5) * 0.06);
  };
}

/** Bare concrete masonry unit — coursed, chalky, with the odd chipped corner. */
const blockCell: CellGen = (u, v, px) => {
  const cw = 1 / 4;
  const ch = 1 / 8;
  const row = Math.floor(v / ch);
  const off = (row & 1) * 0.5;
  const cu = (u / cw + off) % 1;
  const cv = (v / ch) % 1;
  const joint = 0.045;
  const inJoint = cu < joint || cu > 1 - joint || cv < joint * 3 || cv > 1 - joint * 3;
  const grain = vnoise(u * 190, v * 190, 5);
  const mottle = fbm(u * 12, v * 12, 3, 9);
  let l = 0.74 + (mottle - 0.5) * 0.13 + (grain - 0.5) * 0.07;
  let h = 0.68;
  if (inJoint) {
    l *= 0.78;
    h = 0.24;
  }
  setPx(px, l * 1.01, l, l * 0.96, 1, h, 0.96);
};

/** Poured concrete: board-form marks, tie holes, a chalky bloom. */
const rawCell: CellGen = (u, v, px) => {
  const board = Math.abs(((v * 9) % 1) - 0.5);
  const seam = clamp01((0.06 - board) * 14);
  const grain = vnoise(u * 200, v * 200, 13);
  const mottle = fbm(u * 4, v * 4, 4, 17);
  let l = 0.7 + (mottle - 0.5) * 0.18 + (grain - 0.5) * 0.06;
  l -= seam * 0.16;
  const tie = hash2(Math.floor(u * 6), Math.floor(v * 9), 3) > 0.93 ? 1 : 0;
  const td = Math.hypot((u * 6) % 1 - 0.5, (v * 9) % 1 - 0.5);
  if (tie && td < 0.09) l *= 0.6;
  setPx(px, l * 1.005, l, l * 0.98, 1, 0.6 - seam * 0.4, 0.95);
};

/** Patched plaster: rectangular repairs at a different value. */
const patchCell: CellGen = (u, v, px) => {
  const base = renderCell(0.45, 101);
  base(u, v, px, 0);
  const px2 = Math.floor(u * 5 + fbm(u * 2, v * 2, 2, 5) * 2);
  const py2 = Math.floor(v * 6 + fbm(u * 2 + 3, v * 2, 2, 6) * 2);
  const patch = hash2(px2, py2, 41);
  if (patch > 0.74) {
    const k = 0.82 + (patch - 0.74) * 0.9;
    px.r *= k;
    px.g *= k;
    px.b *= k * 0.99;
    px.h = 0.62;
  }
};

/** Flat concrete roof deck: screed, tar patches, drains, sun bleach. */
const roofDeckCell: CellGen = (u, v, px) => {
  const grain = vnoise(u * 200, v * 200, 23);
  const mottle = fbm(u * 6, v * 6, 4, 29);
  const l = 0.72 + (mottle - 0.5) * 0.2 + (grain - 0.5) * 0.07;
  const tar = fbm(u * 2.4 + 4, v * 2.4 - 2, 3, 31);
  const isTar = clamp01((tar - 0.62) * 8);
  const r = lerp(l * 1.02, 0.16, isTar);
  const g = lerp(l, 0.15, isTar);
  const b = lerp(l * 0.96, 0.15, isTar);
  setPx(px, r, g, b, 1, 0.5 + isTar * 0.08, lerp(0.94, 0.62, isTar));
};

/** Roofing felt / tar sheet. */
const tarCell: CellGen = (u, v, px) => {
  const grain = vnoise(u * 300, v * 300, 37);
  const l = 0.16 + (grain - 0.5) * 0.05 + fbm(u * 8, v * 8, 3, 41) * 0.06;
  setPx(px, l, l * 0.98, l * 0.96, 1, 0.5, 0.72);
};

/** Lane asphalt, patched and cracked. */
const asphaltCell: CellGen = (u, v, px) => {
  const grain = vnoise(u * 260, v * 260, 43);
  const agg = fbm(u * 40, v * 40, 3, 47);
  const patch = fbm(u * 3, v * 3, 3, 53);
  let l = 0.2 + (agg - 0.5) * 0.11 + (grain - 0.5) * 0.07;
  l = lerp(l, l * 1.5, clamp01((patch - 0.62) * 5));
  const crack = clamp01((fbm(u * 7, v * 7, 4, 59) - 0.5) * 14);
  const cr = 1 - clamp01(Math.abs(crack - 0.5) < 0.03 ? 1 : 0) * 0.4;
  setPx(px, l * 1.02 * cr, l * cr, l * 0.99 * cr, 1, 0.5 + (agg - 0.5) * 0.5, 0.88 - (agg - 0.5) * 0.2);
};

/** Hand-laid concrete lane: float marks, expansion joints, moss in the cracks. */
const concreteCell: CellGen = (u, v, px) => {
  const grain = vnoise(u * 230, v * 230, 61);
  const mottle = fbm(u * 5, v * 5, 4, 67);
  let l = 0.62 + (mottle - 0.5) * 0.19 + (grain - 0.5) * 0.07;
  const jx = Math.abs(((u * 3) % 1) - 0.5);
  const jz = Math.abs(((v * 3) % 1) - 0.5);
  const joint = clamp01((0.03 - Math.min(jx, jz)) * 30);
  l -= joint * 0.2;
  const moss = clamp01((fbm(u * 9, v * 9, 3, 71) - 0.7) * 6) * joint;
  setPx(px, l * (1 - moss * 0.45), l * (1 + moss * 0.1), l * 0.95 * (1 - moss * 0.4), 1, 0.55 - joint * 0.35, 0.9);
};

/** Dark volcanic shore rock, wet-looking, barnacled at the water. */
const rockCell: CellGen = (u, v, px) => {
  const big = fbm(u * 3.2, v * 3.2, 4, 73);
  const mid = fbm(u * 11, v * 11, 3, 79);
  const grain = vnoise(u * 260, v * 260, 83);
  let l = 0.2 + big * 0.16 + (mid - 0.5) * 0.11 + (grain - 0.5) * 0.06;
  const salt = clamp01((mid - 0.72) * 5);
  const r = lerp(l * 1.03, 0.62, salt * 0.5);
  const g = lerp(l, 0.6, salt * 0.5);
  const b = lerp(l * 1.06, 0.57, salt * 0.5);
  setPx(px, r, g, b, 1, big * 0.7 + mid * 0.3, 0.9 - salt * 0.25);
};

/** Coarse dark shingle / crushed shell at the water's edge. */
const shingleCell: CellGen = (u, v, px) => {
  const p = fbm(u * 26, v * 26, 3, 89);
  const grain = vnoise(u * 300, v * 300, 97);
  const l = 0.3 + p * 0.26 + (grain - 0.5) * 0.09;
  setPx(px, l * 1.06, l * 1.0, l * 0.9, 1, p, 0.94);
};

function zincCell(rusty: number, seed: number): CellGen {
  return (u, v, px) => {
    const rib = Math.cos(u * Math.PI * 2 * 16);
    const shape = rib * 0.5 + 0.5;
    const grain = vnoise(u * 200, v * 200, seed);
    let l = 0.55 + shape * 0.3 + (grain - 0.5) * 0.05;
    const rust = clamp01((fbm(u * 4, v * 2.5, 4, seed + 5) - 0.5 + rusty * 0.35) * 3.2) * rusty;
    const r = lerp(l, 0.44 + (grain - 0.5) * 0.1, rust);
    const g = lerp(l, 0.22, rust);
    const b = lerp(l * 1.02, 0.12, rust);
    setPx(px, r, g, b, 1, shape, lerp(0.42, 0.92, rust));
  };
}

/** Rubble / broken block fill. */
const rubbleCell: CellGen = (u, v, px) => {
  const p = fbm(u * 16, v * 16, 3, 103);
  const grain = vnoise(u * 280, v * 280, 107);
  const l = 0.5 + p * 0.26 + (grain - 0.5) * 0.09;
  setPx(px, l * 1.02, l, l * 0.95, 1, p, 0.95);
};

/** Injection-moulded plastic — chairs, buckets, tanks. */
const plasticCell: CellGen = (u, v, px) => {
  const grain = vnoise(u * 260, v * 260, 109);
  const l = 0.9 + (grain - 0.5) * 0.04;
  setPx(px, l, l, l, 1, 0.5, 0.44);
};

const tankCell: CellGen = (u, v, px) => {
  const ring = Math.abs(((v * 7) % 1) - 0.5);
  const r = clamp01((0.1 - ring) * 8);
  const grain = vnoise(u * 200, v * 200, 113);
  const l = 0.88 + (grain - 0.5) * 0.05 - r * 0.08;
  setPx(px, l, l, l, 1, 0.5 + r * 0.3, 0.48);
};

const treadCell: CellGen = (u, v, px) => {
  const nose = clamp01((0.08 - Math.abs(v - 0.06)) * 12);
  const grain = vnoise(u * 230, v * 230, 127);
  const l = 0.66 + (grain - 0.5) * 0.09 - nose * 0.12;
  setPx(px, l * 1.01, l, l * 0.96, 1, 0.5 + nose * 0.4, 0.93);
};

const tarpCell: CellGen = (u, v, px) => {
  const weave = (Math.abs(((u * 90) % 1) - 0.5) + Math.abs(((v * 90) % 1) - 0.5)) * 0.5;
  const l = 0.82 + (weave - 0.25) * 0.2;
  setPx(px, l, l, l, 1, 0.5, 0.6);
};

const carCell: CellGen = (u, v, px) => {
  const grain = vnoise(u * 190, v * 190, 131);
  const dust = fbm(u * 4, v * 4, 3, 137);
  const l = 0.9 + (grain - 0.5) * 0.03 - clamp01((v - 0.55) * 2) * 0.12 * dust;
  setPx(px, l, l, l, 1, 0.5, 0.42 + clamp01((v - 0.5) * 2) * 0.3);
};

const windowCell: CellGen = (u, v, px) => {
  // dark interior with a soft top-lit falloff and a hint of a curtain
  const depth = clamp01(1 - v * 0.8);
  const curtain = clamp01((fbm(u * 6, v * 2, 3, 139) - 0.5) * 4) * clamp01((u - 0.55) * 3);
  let l = 0.045 + depth * 0.05;
  const r = lerp(l, 0.5, curtain * 0.7);
  const g = lerp(l * 1.05, 0.48, curtain * 0.7);
  const b = lerp(l * 1.2, 0.45, curtain * 0.7);
  setPx(px, r, g, b, 1, 0.5, 0.28);
};

/* ---------------------------------------------------------- vector cells */

function drawDoorPanel(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, s, s);
  ctx.strokeStyle = 'rgba(0,0,0,0.40)';
  ctx.lineWidth = Math.max(1, s * 0.018);
  // four recessed panels, 2 wide × 2 tall, plus a top rail
  const m = s * 0.11;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      const pw = (s - m * 3) / 2;
      const ph = (s - m * 4) / 3;
      const px = x + m + c * (pw + m);
      const py = y + m + r * (ph + m);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(px, py, pw, ph * 0.06);
      ctx.strokeRect(px, py, pw, ph);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(x + s * 0.9, y + s * 0.52, s * 0.028, 0, Math.PI * 2);
  ctx.fill();
}

function drawDoorSteel(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, s, s);
  // roll-down shutter: horizontal ribs
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.10)';
    ctx.fillRect(x, y + t * s, s, s / 26);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.fillRect(x, y + s * 0.94, s, s * 0.06);
}

function drawDoorLouvre(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, s, s);
  const n = 22;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const g = ctx.createLinearGradient(0, y + t * s, 0, y + (t + 1 / n) * s);
    g.addColorStop(0, 'rgba(0,0,0,0.38)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0.06)');
    ctx.fillStyle = g;
    ctx.fillRect(x + s * 0.06, y + t * s, s * 0.88, s / n);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  ctx.lineWidth = Math.max(1, s * 0.022);
  ctx.strokeRect(x + s * 0.05, y + s * 0.02, s * 0.9, s * 0.96);
}

function drawShutter(ctx: Canvas2D, x: number, y: number, s: number): void {
  drawDoorLouvre(ctx, x, y, s);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.5, y);
  ctx.lineTo(x + s * 0.5, y + s);
  ctx.stroke();
}

function drawReja(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.clearRect(x, y, s, s);
  ctx.fillStyle = '#ffffff';
  const bar = s * 0.052;
  // frame
  ctx.fillRect(x, y, s, bar);
  ctx.fillRect(x, y + s - bar, s, bar);
  ctx.fillRect(x, y, bar, s);
  ctx.fillRect(x + s - bar, y, bar, s);
  // verticals
  for (let i = 1; i < 5; i++) {
    ctx.fillRect(x + (i / 5) * s - bar * 0.4, y, bar * 0.8, s);
  }
  // one mid rail and a decorative scroll
  ctx.fillRect(x, y + s * 0.5 - bar * 0.4, s, bar * 0.8);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = bar * 0.75;
  ctx.beginPath();
  ctx.arc(x + s * 0.5, y + s * 0.5, s * 0.17, 0, Math.PI * 2);
  ctx.stroke();
}

function drawRail(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.clearRect(x, y, s, s);
  ctx.fillStyle = '#ffffff';
  const bar = s * 0.05;
  ctx.fillRect(x, y + s * 0.02, s, bar * 1.4);
  ctx.fillRect(x, y + s - bar * 1.6, s, bar * 1.4);
  for (let i = 0; i <= 9; i++) ctx.fillRect(x + (i / 9) * (s - bar), y, bar, s);
}

function drawAerial(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.clearRect(x, y, s, s);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, s * 0.022);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.5, y + s);
  ctx.lineTo(x + s * 0.5, y + s * 0.04);
  ctx.stroke();
  for (let i = 0; i < 7; i++) {
    const t = 0.1 + i * 0.11;
    const w = s * (0.42 - i * 0.035);
    ctx.beginPath();
    ctx.moveTo(x + s * 0.5 - w, y + t * s);
    ctx.lineTo(x + s * 0.5 + w, y + t * s);
    ctx.stroke();
  }
}

function drawDish(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.clearRect(x, y, s, s);
  const g = ctx.createRadialGradient(
    x + s * 0.42, y + s * 0.4, s * 0.04,
    x + s * 0.5, y + s * 0.5, s * 0.46,
  );
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.7, '#d8d8d4');
  g.addColorStop(1, '#a8a8a2');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x + s * 0.5, y + s * 0.5, s * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.arc(x + s * 0.5, y + s * 0.5, s * 0.1, 0, Math.PI * 2);
  ctx.fill();
}

function drawCloth(ctx: Canvas2D, x: number, y: number, s: number, kind: number): void {
  ctx.clearRect(x, y, s, s);
  ctx.fillStyle = '#ffffff';
  if (kind === 0) {
    // t-shirt silhouette
    ctx.beginPath();
    ctx.moveTo(x + s * 0.22, y + s * 0.08);
    ctx.lineTo(x + s * 0.38, y + s * 0.02);
    ctx.lineTo(x + s * 0.62, y + s * 0.02);
    ctx.lineTo(x + s * 0.78, y + s * 0.08);
    ctx.lineTo(x + s * 0.9, y + s * 0.34);
    ctx.lineTo(x + s * 0.74, y + s * 0.4);
    ctx.lineTo(x + s * 0.74, y + s * 0.95);
    ctx.lineTo(x + s * 0.26, y + s * 0.95);
    ctx.lineTo(x + s * 0.26, y + s * 0.4);
    ctx.lineTo(x + s * 0.1, y + s * 0.34);
    ctx.closePath();
    ctx.fill();
  } else {
    // towel / sheet with a soft wavy hem
    ctx.beginPath();
    ctx.moveTo(x + s * 0.12, y + s * 0.02);
    ctx.lineTo(x + s * 0.88, y + s * 0.02);
    ctx.lineTo(x + s * 0.9, y + s * 0.86);
    for (let i = 8; i >= 0; i--) {
      const t = i / 8;
      ctx.lineTo(x + s * (0.1 + t * 0.8), y + s * (0.86 + Math.sin(t * 9) * 0.05));
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let i = 0; i < 4; i++) ctx.fillRect(x + s * 0.12, y + s * (0.2 + i * 0.16), s * 0.78, s * 0.05);
  }
  // soft shading down the folds
  const g = ctx.createLinearGradient(x, y, x + s, y);
  g.addColorStop(0, 'rgba(0,0,0,0.18)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.0)');
  g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = g;
  ctx.fillRect(x, y, s, s);
  ctx.globalCompositeOperation = 'source-over';
}

function drawLeaves(ctx: Canvas2D, x: number, y: number, s: number, kind: number, rng: RNG): void {
  ctx.clearRect(x, y, s, s);
  const leaf = (cx: number, cy: number, len: number, wid: number, ang: number, c: string): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(wid, len * 0.42, 0, len);
    ctx.quadraticCurveTo(-wid, len * 0.42, 0, 0);
    ctx.fill();
    ctx.restore();
  };
  if (kind === 0) {
    // bougainvillea sprig: small leaves plus magenta bracts
    for (let i = 0; i < 34; i++) {
      const a = rng.range(-Math.PI, Math.PI);
      const r = rng.range(0.05, 0.46) * s;
      const g = Math.floor(rng.range(120, 190));
      leaf(
        x + s * 0.5 + Math.cos(a) * r,
        y + s * 0.5 + Math.sin(a) * r,
        s * rng.range(0.1, 0.2),
        s * rng.range(0.035, 0.07),
        a + Math.PI * 0.5,
        `rgb(${Math.floor(g * 0.36)},${g},${Math.floor(g * 0.42)})`,
      );
    }
    for (let i = 0; i < 16; i++) {
      const a = rng.range(-Math.PI, Math.PI);
      const r = rng.range(0.05, 0.42) * s;
      ctx.fillStyle = rng.bool(0.55) ? '#e0338c' : '#f2529f';
      ctx.beginPath();
      ctx.arc(x + s * 0.5 + Math.cos(a) * r, y + s * 0.5 + Math.sin(a) * r, s * rng.range(0.028, 0.055), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === 1) {
    // palm frond, drawn along the +y axis so the mesh can bend it
    ctx.strokeStyle = '#5d7f31';
    ctx.lineWidth = s * 0.028;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.5, y + s);
    ctx.quadraticCurveTo(x + s * 0.52, y + s * 0.4, x + s * 0.5, y);
    ctx.stroke();
    for (let i = 0; i < 34; i++) {
      const t = i / 34;
      const py = y + s * (1 - t);
      const len = s * (0.06 + Math.sin(t * Math.PI) * 0.36);
      const g = Math.floor(lerp(150, 196, rng.next()));
      const col = `rgb(${Math.floor(g * 0.44)},${g},${Math.floor(g * 0.36)})`;
      leaf(x + s * 0.5, py, len, s * 0.028, Math.PI * 0.5 + t * 0.5, col);
      leaf(x + s * 0.5, py, len, s * 0.028, -Math.PI * 0.5 - t * 0.5, col);
    }
  } else if (kind === 2) {
    // banana / heliconia blade
    ctx.fillStyle = '#3f8a2f';
    ctx.beginPath();
    ctx.moveTo(x + s * 0.5, y + s);
    ctx.quadraticCurveTo(x + s * 0.96, y + s * 0.5, x + s * 0.56, y + s * 0.02);
    ctx.quadraticCurveTo(x + s * 0.44, y + s * 0.02, x + s * 0.5, y + s);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + s * 0.5, y + s);
    ctx.quadraticCurveTo(x + s * 0.04, y + s * 0.5, x + s * 0.44, y + s * 0.02);
    ctx.quadraticCurveTo(x + s * 0.56, y + s * 0.02, x + s * 0.5, y + s);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = s * 0.012;
    for (let i = 0; i < 16; i++) {
      const t = 0.05 + (i / 16) * 0.9;
      ctx.beginPath();
      ctx.moveTo(x + s * 0.5, y + s * (1 - t));
      ctx.lineTo(x + s * (0.5 + (i % 2 ? 0.4 : -0.4) * Math.sin(t * 3.1)), y + s * (1 - t + 0.1));
      ctx.stroke();
    }
  } else if (kind === 3) {
    // coarse grass / lemongrass tuft
    for (let i = 0; i < 40; i++) {
      const bx = x + s * rng.range(0.2, 0.8);
      const h = s * rng.range(0.4, 0.95);
      const bend = s * rng.range(-0.3, 0.3);
      const g = Math.floor(rng.range(120, 180));
      ctx.strokeStyle = `rgb(${Math.floor(g * 0.5)},${g},${Math.floor(g * 0.34)})`;
      ctx.lineWidth = s * rng.range(0.012, 0.026);
      ctx.beginPath();
      ctx.moveTo(bx, y + s);
      ctx.quadraticCurveTo(bx + bend * 0.4, y + s - h * 0.6, bx + bend, y + s - h);
      ctx.stroke();
    }
  } else {
    // flowering shrub — hibiscus red on deep green
    for (let i = 0; i < 44; i++) {
      const a = rng.range(-Math.PI, Math.PI);
      const r = rng.range(0.03, 0.47) * s;
      const g = Math.floor(rng.range(110, 165));
      leaf(
        x + s * 0.5 + Math.cos(a) * r,
        y + s * 0.5 + Math.sin(a) * r,
        s * rng.range(0.12, 0.24),
        s * rng.range(0.05, 0.09),
        a,
        `rgb(${Math.floor(g * 0.3)},${g},${Math.floor(g * 0.38)})`,
      );
    }
    for (let i = 0; i < 11; i++) {
      const a = rng.range(-Math.PI, Math.PI);
      const r = rng.range(0.05, 0.4) * s;
      const cx = x + s * 0.5 + Math.cos(a) * r;
      const cy = y + s * 0.5 + Math.sin(a) * r;
      ctx.fillStyle = ['#e03a2f', '#f26a1b', '#ffd400'][i % 3];
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(pa) * s * 0.03, cy + Math.sin(pa) * s * 0.03, s * 0.033, s * 0.022, pa, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawWire(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.clearRect(x, y, s, s);
  ctx.fillStyle = '#2a2723';
  ctx.fillRect(x, y + s * 0.44, s, s * 0.12);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x, y + s * 0.45, s, s * 0.02);
}

/**
 * Hand-painted mural. Kept to the three subjects the reference actually
 * supports on a barrio party wall: sea, flag, and marine life. No text.
 */
function drawMural(ctx: Canvas2D, x: number, y: number, s: number, kind: number, rng: RNG): void {
  if (kind === 0) {
    // waves and sun
    ctx.fillStyle = '#0f3f78';
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(x + s * 0.7, y + s * 0.26, s * 0.16, 0, Math.PI * 2);
    ctx.fill();
    const bands = ['#19a5c9', '#3fd2c4', '#8ff0dc', '#ffffff'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = bands[i];
      ctx.beginPath();
      ctx.moveTo(x, y + s * (0.52 + i * 0.11));
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        ctx.lineTo(x + t * s, y + s * (0.52 + i * 0.11 + Math.sin(t * 7 + i) * 0.035));
      }
      ctx.lineTo(x + s, y + s);
      ctx.lineTo(x, y + s);
      ctx.closePath();
      ctx.fill();
    }
  } else if (kind === 1) {
    // the flag, standard colours (§7.4)
    ctx.fillStyle = '#f4f1e8';
    ctx.fillRect(x, y, s, s);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#ed0000' : '#f7f4ec';
      ctx.fillRect(x, y + (i / 5) * s, s, s / 5);
    }
    ctx.fillStyle = '#0050f0';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + s * 0.56, y + s * 0.5);
    ctx.lineTo(x, y + s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const cx = x + s * 0.19;
    const cy = y + s * 0.5;
    const R = s * 0.15;
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? R : R * 0.42;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  } else {
    // reef fish
    ctx.fillStyle = '#0b6f8f';
    ctx.fillRect(x, y, s, s);
    for (let i = 0; i < 9; i++) {
      const fx = x + s * rng.range(0.12, 0.88);
      const fy = y + s * rng.range(0.14, 0.86);
      const fs = s * rng.range(0.07, 0.16);
      ctx.fillStyle = ['#ffd23f', '#ff7a2f', '#3fd2c4', '#f2529f'][i % 4];
      ctx.beginPath();
      ctx.ellipse(fx, fy, fs, fs * 0.55, rng.range(-0.4, 0.4), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(fx - fs, fy);
      ctx.lineTo(fx - fs * 1.7, fy - fs * 0.4);
      ctx.lineTo(fx - fs * 1.7, fy + fs * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0b2f3f';
      ctx.beginPath();
      ctx.arc(fx + fs * 0.45, fy - fs * 0.12, fs * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Hand-painted shop board. `text` must already be correct Spanish. */
function drawSign(ctx: Canvas2D, x: number, y: number, s: number, text: string, sub: string, bg: string, fg: string): void {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(x, y + s * 0.86, s, s * 0.14);
  ctx.strokeStyle = fg;
  ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.strokeRect(x + s * 0.05, y + s * 0.06, s * 0.9, s * 0.7);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fs = s * 0.2;
  ctx.font = `700 ${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  while (ctx.measureText(text).width > s * 0.8 && fs > 6) {
    fs *= 0.92;
    ctx.font = `700 ${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  }
  ctx.fillText(text, x + s * 0.5, y + s * (sub ? 0.33 : 0.41));
  if (sub) {
    let ss = s * 0.11;
    ctx.font = `600 ${ss}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    while (ctx.measureText(sub).width > s * 0.78 && ss > 5) {
      ss *= 0.92;
      ctx.font = `600 ${ss}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    }
    ctx.fillText(sub, x + s * 0.5, y + s * 0.57);
  }
}

/** Blue-on-cream ceramic street plaque — the city's own convention (§7.1). */
function drawAzulejo(ctx: Canvas2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#f4f1e8';
  ctx.fillRect(x, y, s, s);
  ctx.strokeStyle = '#1f4e8c';
  ctx.lineWidth = Math.max(1, s * 0.035);
  ctx.strokeRect(x + s * 0.07, y + s * 0.09, s * 0.86, s * 0.82);
  ctx.lineWidth = Math.max(1, s * 0.012);
  ctx.strokeRect(x + s * 0.11, y + s * 0.13, s * 0.78, s * 0.74);
  ctx.fillStyle = '#1f4e8c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${s * 0.13}px Georgia, "Times New Roman", serif`;
  ctx.fillText('CALLE DEL', x + s * 0.5, y + s * 0.36);
  ctx.font = `700 ${s * 0.21}px Georgia, "Times New Roman", serif`;
  ctx.fillText('PERLO', x + s * 0.5, y + s * 0.62);
}

/** Four painted house numbers in one cell, quartered. */
function drawNumbers(ctx: Canvas2D, x: number, y: number, s: number): void {
  const nums = ['7', '12', '23', '4B'];
  const h = s / 2;
  for (let i = 0; i < 4; i++) {
    const qx = x + (i % 2) * h;
    const qy = y + Math.floor(i / 2) * h;
    ctx.fillStyle = '#f4f1e8';
    ctx.fillRect(qx, qy, h, h);
    ctx.strokeStyle = '#1f4e8c';
    ctx.lineWidth = Math.max(1, h * 0.05);
    ctx.strokeRect(qx + h * 0.1, qy + h * 0.1, h * 0.8, h * 0.8);
    ctx.fillStyle = '#1f4e8c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${h * 0.44}px Georgia, "Times New Roman", serif`;
    ctx.fillText(nums[i], qx + h * 0.5, qy + h * 0.53);
  }
}

/* -------------------------------------------------------------- the atlas */

export interface EPAtlasMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  size: number;
}

const ATLAS_SIZE: Record<QualityTier, number> = { low: 512, medium: 1024, high: 1024, ultra: 2048 };

/**
 * Bakes El Perlo's one and only atlas. Material cells are written per-pixel
 * from the noise generators above; signage, murals, doors and cut-outs are
 * drawn as vectors on top. The relief and roughness channels come out of the
 * same pass, so the normal map agrees with the albedo everywhere.
 */
export function elPerloAtlas(tf: TextureFactory, quality: QualityTier): EPAtlasMaps {
  const size = ATLAS_SIZE[quality];
  const cell = size / GRID;
  const key = `elperlo/atlas/${size}`;

  const gens = new Map<string, CellGen>();
  const put = (id: TileId, gen: CellGen): void => {
    const [c, r] = CELLS[id];
    gens.set(`${c},${r}`, gen);
  };
  put('render0', renderCell(0.15, 211));
  put('render1', renderCell(0.5, 223));
  put('render2', renderCell(0.88, 227));
  put('block', blockCell);
  put('rawcrete', rawCell);
  put('patched', patchCell);
  put('roofdeck', roofDeckCell);
  put('tarpatch', tarCell);
  put('asphalt', asphaltCell);
  put('concrete', concreteCell);
  put('rock', rockCell);
  put('shingle', shingleCell);
  put('zinc', zincCell(0.1, 229));
  put('zincRust', zincCell(0.85, 233));
  put('rubble', rubbleCell);
  put('plastic', plasticCell);
  put('tank', tankCell);
  put('tread', treadCell);
  put('tarp', tarpCell);
  put('carBody', carCell);
  put('window', windowCell);

  // rows 6 and 7 are one continuous field of weathered render
  const field = renderCell(0.62, 307);
  const field2 = renderCell(0.3, 311);
  for (let c = 0; c < GRID; c++) {
    gens.set(`${c},6`, field);
    gens.set(`${c},7`, field2);
  }
  gens.set('6,5', renderCell(0.72, 313));
  gens.set('7,5', renderCell(0.42, 317));

  const height = new Float32Array(size * size);
  const rough = new Uint8Array(size * size * 4);

  const map = tf.texture(key, () => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d') as Canvas2D | null;
    if (!ctx) throw new Error('ElPerlo: 2D canvas unavailable');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const px: Px = { r: 0.5, g: 0.5, b: 0.5, a: 1, h: 0.5, ro: 0.9 };

    for (let y = 0; y < size; y++) {
      const cr = Math.floor(y / cell);
      const lv = (y - cr * cell) / cell;
      for (let x = 0; x < size; x++) {
        const cc = Math.floor(x / cell);
        const gen = gens.get(`${cc},${cr}`);
        const i = y * size + x;
        if (!gen) {
          // vector-only cell: leave a mid grey the drawing pass overwrites
          data[i * 4] = 200;
          data[i * 4 + 1] = 200;
          data[i * 4 + 2] = 200;
          data[i * 4 + 3] = 255;
          height[i] = 0.5;
          rough[i * 4] = 255;
          rough[i * 4 + 1] = 220;
          rough[i * 4 + 2] = 0;
          rough[i * 4 + 3] = 255;
          continue;
        }
        // Rows 6–7 are one continuous field, so their generator is fed whole-
        // texture coordinates: a window cut out of it never shows a cell seam.
        if (cr >= 6) gen((x / size) * 3.3, (y / size) * 3.3, px, size);
        else gen((x - cc * cell) / cell, lv, px, size);
        data[i * 4] = clamp(px.r, 0, 1) * 255;
        data[i * 4 + 1] = clamp(px.g, 0, 1) * 255;
        data[i * 4 + 2] = clamp(px.b, 0, 1) * 255;
        data[i * 4 + 3] = clamp01(px.a) * 255;
        height[i] = px.h;
        rough[i * 4] = 255;
        rough[i * 4 + 1] = clamp01(px.ro) * 255;
        rough[i * 4 + 2] = 0;
        rough[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    /* ---- vector pass ---- */
    const rng = new RNG(0x5150);
    const at = (id: TileId): [number, number] => {
      const [c, r] = CELLS[id];
      return [c * cell, r * cell];
    };
    let p = at('doorPanel');
    drawDoorPanel(ctx, p[0], p[1], cell);
    p = at('doorSteel');
    drawDoorSteel(ctx, p[0], p[1], cell);
    p = at('doorLouvre');
    drawDoorLouvre(ctx, p[0], p[1], cell);
    p = at('shutter');
    drawShutter(ctx, p[0], p[1], cell);
    p = at('reja');
    drawReja(ctx, p[0], p[1], cell);
    p = at('rail');
    drawRail(ctx, p[0], p[1], cell);
    p = at('aerial');
    drawAerial(ctx, p[0], p[1], cell);
    p = at('dish');
    drawDish(ctx, p[0], p[1], cell);
    p = at('clothA');
    drawCloth(ctx, p[0], p[1], cell, 0);
    p = at('clothB');
    drawCloth(ctx, p[0], p[1], cell, 1);
    p = at('sprig');
    drawLeaves(ctx, p[0], p[1], cell, 0, rng);
    p = at('frond');
    drawLeaves(ctx, p[0], p[1], cell, 1, rng);
    p = at('banana');
    drawLeaves(ctx, p[0], p[1], cell, 2, rng);
    p = at('tuft');
    drawLeaves(ctx, p[0], p[1], cell, 3, rng);
    p = at('flowers');
    drawLeaves(ctx, p[0], p[1], cell, 4, rng);
    p = at('wire');
    drawWire(ctx, p[0], p[1], cell);
    p = at('muralWave');
    drawMural(ctx, p[0], p[1], cell, 0, rng);
    p = at('muralFlag');
    drawMural(ctx, p[0], p[1], cell, 1, rng);
    p = at('muralFish');
    drawMural(ctx, p[0], p[1], cell, 2, rng);
    p = at('signColmado');
    drawSign(ctx, p[0], p[1], cell, 'COLMADO', 'LA OLA', '#f4d03f', '#12355b');
    p = at('signBarberia');
    drawSign(ctx, p[0], p[1], cell, 'BARBERÍA', 'EL PERLO', '#f4f1e8', '#b32020');
    p = at('signLavanderia');
    drawSign(ctx, p[0], p[1], cell, 'LAVANDERÍA', 'ABIERTO', '#2f8fc4', '#f8f6ee');
    p = at('signPerlo');
    drawSign(ctx, p[0], p[1], cell, 'EL PERLO', 'BIENVENIDOS', '#e8442f', '#fff6dc');
    p = at('azulejo');
    drawAzulejo(ctx, p[0], p[1], cell);
    p = at('numberTile');
    drawNumbers(ctx, p[0], p[1], cell);

    // fold the vector cells back into the relief / roughness channels
    const back = ctx.getImageData(0, 0, size, size).data;
    for (const id of Object.keys(CELLS) as TileId[]) {
      const [c, r] = CELLS[id];
      if (gens.has(`${c},${r}`)) continue;
      const x0 = c * cell;
      const y0 = r * cell;
      const cut = CUTOUT.has(id);
      for (let y = y0; y < y0 + cell; y++) {
        for (let x = x0; x < x0 + cell; x++) {
          const i = y * size + x;
          const lum = (back[i * 4] * 0.3 + back[i * 4 + 1] * 0.59 + back[i * 4 + 2] * 0.11) / 255;
          height[i] = cut ? 0.5 : 0.35 + lum * 0.3;
          rough[i * 4 + 1] = Math.round(clamp01(0.9 - lum * 0.16) * 255);
        }
      }
    }

    const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });

  const normalMap = tf.texture(`${key}/n`, () => {
    const t = heightToNormal(height, size, size, 1.6);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });

  const roughnessMap = tf.texture(`${key}/r`, () => {
    const t = new THREE.DataTexture(rough, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  });

  return { map, normalMap, roughnessMap, size };
}

/* --------------------------------------------------------------- rects */

/** UV rect of a named cell, inset so mip bleed never crosses a cell edge. */
export function tile(id: TileId, size = 1024): Rect {
  const [c, r] = CELLS[id];
  const s = 1 / GRID;
  const pad = 1.5 / size;
  return { u0: c * s + pad, v0: 1 - (r + 1) * s + pad, u1: (c + 1) * s - pad, v1: 1 - r * s - pad };
}

/**
 * A random window into the continuous wall field. Two walls in the district
 * essentially never draw the same stain pattern — the anti-tiling protocol
 * done with UVs instead of geometry.
 */
export function wallWindow(rng: RNG, size = 1024): Rect {
  const s = 1 / GRID;
  const pad = 2 / size;
  const v0 = 1 - 8 * s + pad; // rows 6..7
  const v1 = 1 - 6 * s - pad;
  const h = (v1 - v0) * rng.range(0.34, 0.5);
  const w = h * rng.range(0.85, 1.3);
  const u = rng.range(pad, 1 - w - pad);
  const v = rng.range(v0, v1 - h);
  const flip = rng.bool();
  return flip ? { u0: u + w, v0: v, u1: u, v1: v + h } : { u0: u, v0: v, u1: u + w, v1: v + h };
}

/* ========================================================================== *
 *  mesher
 * ========================================================================== */

/**
 * World-space position / normal / uv / colour / glow accumulator. Every part
 * in El Perlo writes straight into one of these; the layer then splits them
 * into a handful of sector meshes.
 *
 * `aGlow` packs `(intensity, warmth, phase)` exactly as the city's façade
 * shader does, so windows come on across dusk one at a time.
 */
/** A rectangular hole punched through a wall, in (along-axis, height) space. */
export interface Hole {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

export class Mesher {
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

  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    c: Col, gi = 0, gw = 0, gp = 0,
  ): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.col.push(c.r, c.g, c.b);
    this.glw.push(gi, gw, gp);
    return this.n++;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /**
   * An arbitrary planar quad, wound `p0 → p1 → p2 → p3`. `cBot` is applied at
   * p0/p1 and `cTop` at p2/p3, which is how every wall in the barrio gets its
   * splash-dark base and sun-bleached head without extra geometry.
   */
  face(
    p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
    r: Rect, cBot: Col, cTop: Col, glow = 0, warm = 0, phase = 0,
  ): void {
    _e1.subVectors(p1, p0);
    _e2.subVectors(p3, p0);
    _nv.crossVectors(_e1, _e2);
    const l = _nv.length();
    if (l < 1e-9) return;
    _nv.multiplyScalar(1 / l);
    const a = this.vert(p0.x, p0.y, p0.z, _nv.x, _nv.y, _nv.z, r.u0, r.v0, cBot, glow, warm, phase);
    const b = this.vert(p1.x, p1.y, p1.z, _nv.x, _nv.y, _nv.z, r.u1, r.v0, cBot, glow, warm, phase);
    const c = this.vert(p2.x, p2.y, p2.z, _nv.x, _nv.y, _nv.z, r.u1, r.v1, cTop, glow, warm, phase);
    const d = this.vert(p3.x, p3.y, p3.z, _nv.x, _nv.y, _nv.z, r.u0, r.v1, cTop, glow, warm, phase);
    this.quad(a, b, c, d);
  }

  /** One flat wall quad. `side`: 0 = -Z, 1 = +X, 2 = +Z, 3 = -X. */
  private wallRaw(
    side: 0 | 1 | 2 | 3,
    a0: number, a1: number, y0: number, y1: number, at: number,
    r: Rect, cBot: Col, cTop: Col, glow: number, warm: number, phase: number,
  ): void {
    if (side === 0) {
      _p0.set(a1, y0, at); _p1.set(a0, y0, at); _p2.set(a0, y1, at); _p3.set(a1, y1, at);
    } else if (side === 2) {
      _p0.set(a0, y0, at); _p1.set(a1, y0, at); _p2.set(a1, y1, at); _p3.set(a0, y1, at);
    } else if (side === 1) {
      _p0.set(at, y0, a1); _p1.set(at, y0, a0); _p2.set(at, y1, a0); _p3.set(at, y1, a1);
    } else {
      _p0.set(at, y0, a0); _p1.set(at, y0, a1); _p2.set(at, y1, a1); _p3.set(at, y1, a0);
    }
    this.face(_p0, _p1, _p2, _p3, r, cBot, cTop, glow, warm, phase);
  }

  /**
   * A vertical wall face, subdivided into horizontal strips so the gravity
   * gradient from splash-dark base to bleached head is smooth (§8.18).
   */
  wall(
    side: 0 | 1 | 2 | 3,
    a0: number, a1: number, y0: number, y1: number, at: number,
    r: Rect, cBot: Col, cTop: Col, bands = 3, glow = 0, warm = 0, phase = 0,
  ): void {
    if (y1 - y0 < 0.004 || Math.abs(a1 - a0) < 0.004) return;
    const nb = Math.max(1, Math.min(bands, Math.ceil((y1 - y0) / 1.1)));
    for (let i = 0; i < nb; i++) {
      const t0 = i / nb;
      const t1 = (i + 1) / nb;
      this.wallRaw(
        side, a0, a1, lerp(y0, y1, t0), lerp(y0, y1, t1), at,
        { u0: r.u0, v0: lerp(r.v0, r.v1, t0), u1: r.u1, v1: lerp(r.v0, r.v1, t1) },
        mixCol(cBot, cTop, t0), mixCol(cBot, cTop, t1), glow, warm, phase,
      );
    }
  }

  /**
   * A wall with real holes in it. Openings are given in (along-axis, height)
   * space and the wall is emitted as the complement, so a window is a hole
   * you can see 0.24 m of reveal into rather than a decal (§8.3).
   */
  wallOpen(
    side: 0 | 1 | 2 | 3,
    a0: number, a1: number, y0: number, y1: number, at: number,
    r: Rect, cBot: Col, cTop: Col, holes: readonly Hole[], bands = 4,
  ): void {
    if (y1 - y0 < 0.004 || Math.abs(a1 - a0) < 0.004) return;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    const cuts: number[] = [y0, y1];
    for (const h of holes) {
      if (h.y1 <= y0 + 1e-4 || h.y0 >= y1 - 1e-4) continue;
      cuts.push(clamp(h.y0, y0, y1), clamp(h.y1, y0, y1));
    }
    // keep the gradient smooth in the tall uninterrupted stretches too
    const nb = Math.max(1, Math.min(bands, Math.ceil((y1 - y0) / 1.2)));
    for (let i = 1; i < nb; i++) cuts.push(lerp(y0, y1, i / nb));
    cuts.sort((p, q) => p - q);

    const uAt = (a: number): number => lerp(r.u0, r.u1, (a - lo) / Math.max(1e-6, hi - lo));
    const vAt = (y: number): number => lerp(r.v0, r.v1, (y - y0) / Math.max(1e-6, y1 - y0));
    const cAt = (y: number): Col => mixCol(cBot, cTop, (y - y0) / Math.max(1e-6, y1 - y0));

    for (let i = 0; i < cuts.length - 1; i++) {
      const yA = cuts[i];
      const yB = cuts[i + 1];
      if (yB - yA < 0.01) continue;
      const mid = (yA + yB) * 0.5;
      const spans: Array<[number, number]> = [];
      for (const h of holes) {
        if (h.y0 <= mid && h.y1 >= mid) {
          const s0 = clamp(Math.min(h.a0, h.a1), lo, hi);
          const s1 = clamp(Math.max(h.a0, h.a1), lo, hi);
          if (s1 - s0 > 0.01) spans.push([s0, s1]);
        }
      }
      spans.sort((p, q) => p[0] - q[0]);
      let cursor = lo;
      const emit = (p: number, q: number): void => {
        if (q - p < 0.01) return;
        this.wallRaw(
          side, p, q, yA, yB, at,
          { u0: uAt(p), v0: vAt(yA), u1: uAt(q), v1: vAt(yB) },
          cAt(yA), cAt(yB), 0, 0, 0,
        );
      };
      for (const s of spans) {
        if (s[0] > cursor) emit(cursor, s[0]);
        cursor = Math.max(cursor, s[1]);
      }
      emit(cursor, hi);
    }
  }

  /** Horizontal slab face at height `y`. `up` false makes it a soffit. */
  deck(
    x0: number, z0: number, x1: number, z1: number, y: number,
    r: Rect, c: Col, up = true, glow = 0,
  ): void {
    if (Math.abs(x1 - x0) < 0.003 || Math.abs(z1 - z0) < 0.003) return;
    if (up) {
      _p0.set(x0, y, z1); _p1.set(x1, y, z1); _p2.set(x1, y, z0); _p3.set(x0, y, z0);
    } else {
      _p0.set(x0, y, z0); _p1.set(x1, y, z0); _p2.set(x1, y, z1); _p3.set(x0, y, z1);
    }
    this.face(_p0, _p1, _p2, _p3, r, c, c, glow);
  }

  /** Axis-aligned box. `faces` is a bitmask: 1 -Z, 2 +X, 4 +Z, 8 -X, 16 top, 32 bottom. */
  box(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    r: Rect, c: Col, faces = 0x1f, bands = 1, cTop?: Col,
  ): void {
    const top = cTop ?? c;
    if (faces & 1) this.wall(0, x0, x1, y0, y1, z0, r, c, top, bands);
    if (faces & 2) this.wall(1, z0, z1, y0, y1, x1, r, shade(c, 0.94), shade(top, 0.94), bands);
    if (faces & 4) this.wall(2, x0, x1, y0, y1, z1, r, shade(c, 0.88), shade(top, 0.88), bands);
    if (faces & 8) this.wall(3, z0, z1, y0, y1, x0, r, shade(c, 0.94), shade(top, 0.94), bands);
    if (faces & 16) this.deck(x0, z0, x1, z1, y1, r, shade(top, 1.06), true);
    if (faces & 32) this.deck(x0, z0, x1, z1, y0, r, shade(c, 0.42), false);
  }

  /** An N-sided prism about the Y axis — tanks, drums, pole bases. */
  prism(
    cx: number, cz: number, r0: number, r1: number, y0: number, y1: number,
    sides: number, rect: Rect, c: Col, cap = true, glow = 0,
  ): void {
    const top: number[] = [];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const nx = Math.cos((a0 + a1) * 0.5);
      const nz = Math.sin((a0 + a1) * 0.5);
      const k = lerp(0.74, 1.1, clamp01(nx * 0.4 + nz * 0.25 + 0.6));
      const cs = shade(c, k);
      const i0 = this.vert(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0, nx, 0, nz, rect.u0, rect.v0, shade(cs, 0.86), glow);
      const i1 = this.vert(cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0, nx, 0, nz, rect.u1, rect.v0, shade(cs, 0.86), glow);
      const i2 = this.vert(cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1, nx, 0, nz, rect.u1, rect.v1, cs, glow);
      const i3 = this.vert(cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1, nx, 0, nz, rect.u0, rect.v1, cs, glow);
      this.quad(i0, i1, i2, i3);
      if (cap) {
        top.push(this.vert(cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1, 0, 1, 0,
          lerp(rect.u0, rect.u1, 0.5 + Math.cos(a0) * 0.45),
          lerp(rect.v0, rect.v1, 0.5 + Math.sin(a0) * 0.45), shade(c, 1.12), glow));
      }
    }
    if (cap) for (let i = 1; i < top.length - 1; i++) this.tri(top[0], top[i], top[i + 1]);
  }

  /** A billboard-ish card in the XY plane at z, facing ±Z. */
  cardZ(
    x0: number, y0: number, x1: number, y1: number, z: number,
    r: Rect, c: Col, front = true, glow = 0, warm = 0, phase = 0,
  ): void {
    if (front) {
      _p0.set(x1, y0, z); _p1.set(x0, y0, z); _p2.set(x0, y1, z); _p3.set(x1, y1, z);
    } else {
      _p0.set(x0, y0, z); _p1.set(x1, y0, z); _p2.set(x1, y1, z); _p3.set(x0, y1, z);
    }
    this.face(_p0, _p1, _p2, _p3, r, c, c, glow, warm, phase);
  }

  /** A card in the ZY plane at x. `front` true faces +X. */
  cardX(z0: number, y0: number, z1: number, y1: number, x: number, r: Rect, c: Col, front = true): void {
    if (front) {
      _p0.set(x, y0, z1); _p1.set(x, y0, z0); _p2.set(x, y1, z0); _p3.set(x, y1, z1);
    } else {
      _p0.set(x, y0, z0); _p1.set(x, y0, z1); _p2.set(x, y1, z1); _p3.set(x, y1, z0);
    }
    this.face(_p0, _p1, _p2, _p3, r, c, c);
  }

  /** Copy every triangle into a flat collider buffer. */
  intoCollider(pos: number[], idx: number[]): void {
    const base = pos.length / 3;
    for (let i = 0; i < this.pos.length; i++) pos.push(this.pos[i]);
    for (let i = 0; i < this.idx.length; i++) idx.push(base + this.idx[i]);
  }

  build(name: string): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glw, 3));
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

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _nv = new THREE.Vector3();

/* ========================================================================== *
 *  parts
 * ========================================================================== */

/** Everything one barrio house needs to know about itself. */
export interface HouseSpec {
  x0: number;
  x1: number;
  /** seaward face (more negative z) */
  zSea: number;
  /** hillside face */
  zHill: number;
  /** ground level at the seaward face — the lane the front door opens onto */
  yFront: number;
  /** ground level behind, one terrace up */
  yBack: number;
  /** number of full storeys above `yFront` */
  storeys: number;
  /** wall paint, sRGB hex */
  paint: number;
  /** trim / encadrement, always lighter */
  trim: number;
  /** doors, shutters and rejas, always darker */
  joinery: number;
  /** true when the neighbour on -x is absent and this side wall shows */
  openMinus: boolean;
  openPlus: boolean;
  /** unfinished top floor: rebar columns and a half-built wall */
  unfinished: boolean;
  /** the parapet on the hill side is dropped so the roof is drivable */
  roofRun: boolean;
  /** 0 none, 1 shop board, 2 mural on the exposed side wall */
  dressing: number;
  seed: number;
}

const RECT_CACHE = new Map<string, Rect>();
function T(id: TileId, size: number): Rect {
  const k = `${id}:${size}`;
  let r = RECT_CACHE.get(k);
  if (!r) {
    r = tile(id, size);
    RECT_CACHE.set(k, r);
  }
  return r;
}

/** Vertical colour ramp for a painted wall: dark and stained low, bleached high. */
function wallRamp(paint: Col): { bot: Col; mid: Col; top: Col } {
  return {
    bot: shade(paint, 0.5),
    mid: paint,
    top: mixCol(shade(paint, 1.1), WHITE, 0.16),
  };
}

/**
 * One house. Concrete box, flat roof, parapet, and — the thing that makes
 * El Perlo read — a front wall that is a full storey taller than the back
 * because the ground behind it is one terrace up. From the lane above these
 * are single-storey cottages; from the lane below they are three-storey
 * blocks standing on their own retaining walls.
 */
export function buildHouse(op: Mesher, cut: Mesher, s: HouseSpec, atlasSize: number): void {
  const rng = new RNG(s.seed);
  const paint = rgb(s.paint);
  const ramp = wallRamp(paint);
  const trim = rgb(s.trim);
  const join = rgb(s.joinery);
  const roofY = s.yFront + EP.storey * s.storeys;
  const wallField = wallWindow(rng, atlasSize);
  const wallField2 = wallWindow(rng, atlasSize);
  const roofRect = T('roofdeck', atlasSize);
  const rc = T('rawcrete', atlasSize);
  const w = s.x1 - s.x0;
  const phase = rng.next();
  /** outward is -Z on the seaward face, so the wall's inside is at +Z */
  const zIn = s.zSea + EP.reveal;

  /* ---- plan the seaward elevation before anything is drawn ---- */
  const bays = Math.max(1, Math.floor(w / 2.55));
  const bayW = w / bays;
  const doorBay = rng.int(0, bays - 1);
  interface Opening {
    a0: number;
    a1: number;
    y0: number;
    y1: number;
    kind: 'door' | 'window';
    lit: number;
    warm: number;
    shutter: boolean;
  }
  const holes: Opening[] = [];
  for (let st = 0; st < s.storeys; st++) {
    const fy = s.yFront + st * EP.storey;
    for (let b = 0; b < bays; b++) {
      const cx = s.x0 + (b + 0.5) * bayW;
      if (st === 0 && b === doorBay && bayW > 1.6) {
        holes.push({
          a0: cx - EP.doorW * 0.5, a1: cx + EP.doorW * 0.5,
          y0: fy + 0.06, y1: fy + 0.06 + EP.doorH,
          kind: 'door', lit: rng.range(0.3, 0.8), warm: rng.next(), shutter: false,
        });
      } else if (bayW > 1.4) {
        const ww = Math.min(EP.winW, bayW - 0.62);
        holes.push({
          a0: cx - ww * 0.5, a1: cx + ww * 0.5,
          y0: fy + EP.winSill, y1: fy + EP.winSill + EP.winH,
          kind: 'window', lit: rng.range(0.34, 0.92), warm: rng.next(), shutter: rng.bool(0.4),
        });
      }
    }
  }

  /* ---- shell ---- */
  // The seaward face. Its foot sinks 0.45 m so there is never a floating seam.
  const frontBase = s.yFront - 0.45;
  op.wallOpen(0, s.x0, s.x1, frontBase, roofY, s.zSea, wallField, ramp.bot, ramp.top, holes, 4);
  // hillside face — only the part that clears the terrace behind it
  const backBase = Math.min(s.yBack - 0.4, roofY - 0.05);
  if (roofY - backBase > 0.06) {
    const backHoles: Hole[] = [];
    if (roofY - backBase > 1.9 && w > 2.4) {
      const cx = s.x0 + w * rng.range(0.3, 0.7);
      backHoles.push({ a0: cx - 0.45, a1: cx + 0.45, y0: backBase + 0.9, y1: backBase + 2.0 });
    }
    op.wallOpen(2, s.x0, s.x1, backBase, roofY, s.zHill, wallField2,
      shade(ramp.mid, 0.8), shade(ramp.top, 0.9), backHoles, 3);
    for (const h of backHoles) {
      op.wall(0, h.a0, h.a1, h.y0, h.y1, s.zHill - 0.16, T('window', atlasSize), WHITE, WHITE, 1, 0.4, rng.next(), phase);
      op.box(h.a0 - 0.1, h.y0 - 0.1, s.zHill, h.a1 + 0.1, h.y0, s.zHill + 0.04, rc, trim, 0x04, 1);
      cut.cardZ(h.a0, h.y0, h.a1, h.y1, s.zHill + 0.03, T('reja', atlasSize), join, false);
    }
  }
  // sides: a stepped trapezoid from the front ground up to the back ground
  for (const side of [0, 1] as const) {
    const open = side === 0 ? s.openMinus : s.openPlus;
    if (!open) continue;
    const x = side === 0 ? s.x0 : s.x1;
    const dir: 1 | 3 = side === 0 ? 3 : 1;
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const za = lerp(s.zSea, s.zHill, t0);
      const zb2 = lerp(s.zSea, s.zHill, t1);
      const yb = lerp(frontBase, backBase, (t0 + t1) * 0.5);
      op.wall(dir, za, zb2, yb, roofY, x, wallField, shade(ramp.bot, 0.96), shade(ramp.top, 0.96), 3);
    }
  }

  /* ---- roof ---- */
  op.deck(s.x0, s.zSea, s.x1, s.zHill, roofY, roofRect, rgb(CONCRETE.roof));
  const pt = EP.parapetT;
  const ph = EP.parapet + rng.range(-0.1, 0.18);
  const cop = mixCol(trim, WHITE, 0.2);
  op.box(s.x0, roofY, s.zSea, s.x1, roofY + ph, s.zSea + pt, rc, ramp.mid, 0x1f, 1, cop);
  op.box(s.x0, roofY, s.zHill - pt, s.x1, roofY + (s.roofRun ? 0.13 : ph), s.zHill, rc, ramp.mid, 0x1f, 1, cop);
  op.box(s.x0, roofY, s.zSea + pt, s.x0 + pt, roofY + ph, s.zHill - pt, rc, ramp.mid, 0x1f, 1, cop);
  op.box(s.x1 - pt, roofY, s.zSea + pt, s.x1, roofY + ph, s.zHill - pt, rc, ramp.mid, 0x1f, 1, cop);
  // slab edge, so the roof is never infinitely thin (§8.7)
  op.wall(0, s.x0 - 0.07, s.x1 + 0.07, roofY - EP.slab, roofY, s.zSea - 0.07, rc, shade(ramp.bot, 0.8), shade(ramp.mid, 0.86), 1);
  op.deck(s.x0 - 0.07, s.zSea - 0.07, s.x1 + 0.07, s.zSea, roofY, rc, shade(cop, 0.98));
  op.deck(s.x0 - 0.07, s.zSea - 0.07, s.x1 + 0.07, s.zSea, roofY - EP.slab, rc, shade(ramp.bot, 0.4), false);

  /* ---- the openings themselves ---- */
  for (const h of holes) {
    // reveals, cut inward
    op.wall(1, s.zSea, zIn, h.y0, h.y1, h.a0, rc, shade(trim, 0.5), shade(trim, 0.7), 1);
    op.wall(3, s.zSea, zIn, h.y0, h.y1, h.a1, rc, shade(trim, 0.62), shade(trim, 0.8), 1);
    op.deck(h.a0, s.zSea, h.a1, zIn, h.y1, rc, shade(trim, 0.36), false);
    op.deck(h.a0, s.zSea, h.a1, zIn, h.y0, rc, shade(trim, 0.92), true);
    // encadrement — a painted border, always lighter than the wall (§L1)
    const e = h.kind === 'door' ? 0.15 : 0.13;
    const zo = s.zSea - 0.035;
    op.wall(0, h.a0 - e, h.a1 + e, h.y1, h.y1 + e, zo, rc, trim, mixCol(trim, WHITE, 0.2), 1);
    op.wall(0, h.a0 - e, h.a0, h.y0 - e, h.y1 + e, zo, rc, shade(trim, 0.92), trim, 1);
    op.wall(0, h.a1, h.a1 + e, h.y0 - e, h.y1 + e, zo, rc, shade(trim, 0.92), trim, 1);
    op.wall(0, h.a0 - e, h.a1 + e, h.y0 - e, h.y0, zo, rc, shade(trim, 0.8), trim, 1);
    op.deck(h.a0 - e, zo, h.a1 + e, s.zSea, h.y1 + e, rc, shade(trim, 1.05));

    if (h.kind === 'door') {
      const leaf = rng.weighted(['doorPanel', 'doorSteel', 'doorLouvre'] as TileId[], [4, 2, 3]);
      op.wall(0, h.a0, h.a1, h.y0, h.y1 - 0.34, zIn - 0.05, T(leaf, atlasSize), shade(join, 0.85), join, 1);
      // fanlight over the leaf, lit from inside at night
      op.wall(0, h.a0, h.a1, h.y1 - 0.34, h.y1, zIn - 0.03, T('window', atlasSize), WHITE, WHITE, 1, h.lit, h.warm, phase);
      // step down to the lane
      op.box(h.a0 - 0.16, s.yFront - 0.16, s.zSea - 0.42, h.a1 + 0.16, h.y0, s.zSea, T('concrete', atlasSize),
        mixCol(rgb(CONCRETE.raw), trim, 0.3), 0x3f, 1);
    } else {
      op.wall(0, h.a0, h.a1, h.y0, h.y1, zIn, T('window', atlasSize), WHITE, WHITE, 1, h.lit, h.warm, phase);
      cut.cardZ(h.a0, h.y0, h.a1, h.y1, s.zSea - 0.055, T('reja', atlasSize), join, true);
      if (h.shutter) {
        const sw = (h.a1 - h.a0) * 0.46;
        const side = rng.bool() ? -1 : 1;
        const sx = side < 0 ? h.a0 - e - sw : h.a1 + e;
        op.box(sx, h.y0, s.zSea - 0.09, sx + sw, h.y1, s.zSea - 0.04, T('shutter', atlasSize), join, 0x1f, 1);
      }
      // sill with a drip, and the stain it has left below it (§8.18)
      op.box(h.a0 - e - 0.05, h.y0 - e - 0.09, s.zSea - 0.11, h.a1 + e + 0.05, h.y0 - e, s.zSea + 0.02, rc,
        mixCol(trim, WHITE, 0.12), 0x3f, 1);
      op.wall(0, h.a0 - e * 0.6, h.a1 + e * 0.6, h.y0 - e - 0.86, h.y0 - e - 0.09, s.zSea - 0.014,
        T('render2', atlasSize), ramp.mid, shade(ramp.mid, 0.6), 1);
    }
  }

  /* ---- plinth: the splash-stained base course at the pavement ---- */
  const plinth = mixCol(shade(paint, 0.42), rgb(CONCRETE.dark), 0.45);
  op.wall(0, s.x0 - 0.05, s.x1 + 0.05, frontBase, s.yFront + 0.5, s.zSea - 0.05, rc, shade(plinth, 0.7), plinth, 1);
  op.deck(s.x0 - 0.05, s.zSea - 0.05, s.x1 + 0.05, s.zSea, s.yFront + 0.5, rc, shade(plinth, 1.12));

  /* ---- optional cantilevered balcony over the lane ---- */
  if (s.storeys >= 2 && rng.bool(0.42)) {
    const by = s.yFront + EP.storey;
    const bx0 = s.x0 + w * 0.1;
    const bx1 = s.x1 - w * 0.1;
    const proj = rng.range(0.8, 1.15);
    op.box(bx0, by - 0.18, s.zSea - proj, bx1, by, s.zSea, rc, rgb(CONCRETE.raw), 0x3f);
    for (const dx of [bx0 + 0.1, bx1 - 0.22]) {
      op.box(dx, by - 0.62, s.zSea - proj * 0.5, dx + 0.12, by - 0.18, s.zSea, rc, rgb(CONCRETE.raw), 0x0f);
    }
    cut.cardZ(bx0, by, bx1, by + 0.95, s.zSea - proj + 0.02, T('rail', atlasSize), join, true);
    cut.cardZ(bx0, by, bx1, by + 0.95, s.zSea - proj + 0.02, T('rail', atlasSize), join, false);
    if (rng.bool(0.7)) {
      const lw = (bx1 - bx0) * rng.range(0.32, 0.6);
      const lx = rng.range(bx0, bx1 - lw);
      const cloth = rgb(rng.pick([0xffffff, 0xffd166, 0x4c8bf5, 0xef476f, 0x8bc34a, 0xf2f0e6]));
      cut.cardZ(lx, by - 0.6, lx + lw, by + 0.5, s.zSea - proj - 0.04, T('clothB', atlasSize), cloth, true);
      cut.cardZ(lx, by - 0.6, lx + lw, by + 0.5, s.zSea - proj - 0.04, T('clothB', atlasSize), shade(cloth, 0.72), false);
    }
  }

  /* ---- unfinished top floor: four columns and a half-built wall ---- */
  if (s.unfinished) {
    const cy = roofY + ph;
    const ch = rng.range(1.5, 2.6);
    const cw = 0.22;
    const craw = rgb(CONCRETE.bare);
    for (const cx of [s.x0 + 0.35, s.x1 - 0.35 - cw]) {
      for (const cz of [s.zSea + 0.35, s.zHill - 0.35 - cw]) {
        op.box(cx, cy, cz, cx + cw, cy + ch, cz + cw, rc, craw, 0x1f);
        for (let i = 0; i < 3; i++) {
          const rx = cx + 0.04 + i * 0.06;
          op.box(rx, cy + ch, cz + 0.06, rx + 0.022, cy + ch + rng.range(0.3, 0.6), cz + 0.082,
            T('zincRust', atlasSize), rgb(CONCRETE.rust), 0x0f);
        }
      }
    }
    op.box(s.x0 + 0.35, cy, s.zHill - 0.55, s.x1 - 0.35, cy + ch * rng.range(0.4, 0.8), s.zHill - 0.35,
      T('block', atlasSize), craw, 0x1f);
  }

  /* ---- dressing ---- */
  if (s.dressing === 1 && w > 3.2) {
    const sign = T(rng.pick(['signColmado', 'signBarberia', 'signLavanderia'] as TileId[]), atlasSize);
    const sw = Math.min(w * 0.78, 2.6);
    const sy = s.yFront + EP.storey - 0.82;
    op.cardZ(s.x0 + (w - sw) * 0.5, sy, s.x0 + (w + sw) * 0.5, sy + sw * 0.4, s.zSea - 0.1, sign, WHITE, true, 0.42, 0.2, phase);
    const ay = s.yFront + 2.62;
    const stripe = rgb(rng.pick([0xe8442f, 0x1f5fd8, 0x2fc36a, 0xffc714]));
    op.face(
      _q0.set(s.x0 + 0.1, ay, s.zSea), _q1.set(s.x1 - 0.1, ay, s.zSea),
      _q2.set(s.x1 - 0.1, ay - 0.5, s.zSea - 1.3), _q3.set(s.x0 + 0.1, ay - 0.5, s.zSea - 1.3),
      T('tarp', atlasSize), stripe, shade(stripe, 1.12),
    );
    op.face(
      _q0.set(s.x1 - 0.1, ay, s.zSea), _q1.set(s.x0 + 0.1, ay, s.zSea),
      _q2.set(s.x0 + 0.1, ay - 0.5, s.zSea - 1.3), _q3.set(s.x1 - 0.1, ay - 0.5, s.zSea - 1.3),
      T('tarp', atlasSize), shade(stripe, 0.38), shade(stripe, 0.48),
    );
    op.wall(0, s.x0 + 0.1, s.x1 - 0.1, ay - 0.66, ay - 0.5, s.zSea - 1.3, T('tarp', atlasSize),
      shade(stripe, 0.6), shade(stripe, 0.7), 1);
  }
  if (s.dressing === 2 && (s.openPlus || s.openMinus)) {
    const x = s.openPlus ? s.x1 + 0.025 : s.x0 - 0.025;
    const mural = T(rng.pick(['muralWave', 'muralFlag', 'muralFish'] as TileId[]), atlasSize);
    const mz0 = s.zSea + 0.5;
    const mz1 = Math.min(s.zHill - 0.5, mz0 + 4.4);
    const my0 = s.yFront + 0.6;
    op.cardX(mz0, my0, mz1, my0 + (mz1 - mz0) * 0.92, x, mural, WHITE, s.openPlus);
  }

  /* ---- house number beside the door ---- */
  const door = holes.find((h) => h.kind === 'door');
  if (door) {
    const nx = door.a1 + 0.2;
    if (nx < s.x1 - 0.22) {
      const nr = T('numberTile', atlasSize);
      const q = rng.int(0, 3);
      const half: Rect = {
        u0: lerp(nr.u0, nr.u1, (q % 2) * 0.5),
        v0: lerp(nr.v0, nr.v1, q < 2 ? 0.5 : 0),
        u1: lerp(nr.u0, nr.u1, (q % 2) * 0.5 + 0.5),
        v1: lerp(nr.v0, nr.v1, q < 2 ? 1 : 0.5),
      };
      op.cardZ(nx, s.yFront + 1.86, nx + 0.21, s.yFront + 2.07, s.zSea - 0.04, half, WHITE);
    }
  }
}

const _q0 = new THREE.Vector3();
const _q1 = new THREE.Vector3();
const _q2 = new THREE.Vector3();
const _q3 = new THREE.Vector3();

/* ------------------------------------------------------------ roof clutter */

export interface RoofClutterOpts {
  x0: number;
  x1: number;
  zSea: number;
  zHill: number;
  y: number;
  /** keep the deck clear so it can be driven */
  keepClear: boolean;
  density: number;
}

/**
 * What is actually on a barrio roof: the black polyethylene cistern on its
 * frame, a dish, an aerial, plastic chairs, buckets of plants, a length of
 * washing line, a water heater, and the stub of the staircase that gets you
 * up there.
 */
export function buildRoofClutter(op: Mesher, cut: Mesher, o: RoofClutterOpts, rng: RNG, size: number): void {
  const w = o.x1 - o.x0;
  const d = o.zHill - o.zSea;
  if (w < 1.6 || d < 1.6) return;
  const inset = 0.55;
  const px = (t: number): number => lerp(o.x0 + inset, o.x1 - inset, t);
  const pz = (t: number): number => lerp(o.zSea + inset, o.zHill - inset, t);
  const n = Math.round((o.keepClear ? 1.2 : 3.4) * o.density * clamp(w / 5, 0.5, 2));

  // the cistern is near-universal
  if (!o.keepClear || rng.bool(0.4)) {
    const cx = px(rng.range(0.15, 0.85));
    const cz = pz(rng.range(0.55, 0.9));
    const r = rng.range(0.42, 0.62);
    const hh = rng.range(0.75, 1.05);
    const frameY = o.y + 0.34;
    // steel frame
    const fr = T('zincRust', size);
    for (const dx of [-r * 0.8, r * 0.8]) {
      for (const dz of [-r * 0.8, r * 0.8]) {
        op.box(cx + dx - 0.045, o.y, cz + dz - 0.045, cx + dx + 0.045, frameY, cz + dz + 0.045, fr, rgb(0x8d8a82), 0x0f);
      }
    }
    const dark = rng.bool(0.62);
    op.prism(cx, cz, r, r * 0.96, frameY, frameY + hh, 10, T('tank', size), rgb(dark ? 0x23282c : 0xdfe3e0));
    op.prism(cx, cz, r * 0.24, r * 0.24, frameY + hh, frameY + hh + 0.1, 8, T('plastic', size), rgb(dark ? 0x2f3438 : 0xc8ccc8));
    // the pipe down to the parapet
    op.box(cx + r * 0.9, o.y, cz, cx + r * 0.9 + 0.05, frameY + hh * 0.5, cz + 0.05, T('plastic', size), rgb(0xd8d4c8), 0x0f);
  }

  for (let i = 0; i < n; i++) {
    const t = rng.next();
    const cx = px(rng.next());
    const cz = pz(rng.range(0.35, 0.95));
    if (t < 0.16) {
      // satellite dish on a short mast
      op.box(cx - 0.03, o.y, cz - 0.03, cx + 0.03, o.y + 0.55, cz + 0.03, T('zinc', size), rgb(0x9a9a94), 0x0f);
      cut.cardZ(cx - 0.32, o.y + 0.55, cx + 0.32, o.y + 1.19, cz, T('dish', size), WHITE, true);
      cut.cardZ(cx - 0.32, o.y + 0.55, cx + 0.32, o.y + 1.19, cz, T('dish', size), shade(WHITE, 0.55), false);
    } else if (t < 0.3) {
      cut.cardZ(cx - 0.5, o.y, cx + 0.5, o.y + 1.9, cz, T('aerial', size), rgb(0x6f6c62), true);
      cut.cardZ(cx - 0.5, o.y, cx + 0.5, o.y + 1.9, cz, T('aerial', size), rgb(0x6f6c62), false);
    } else if (t < 0.46) {
      plasticChair(op, cx, o.y, cz, rng, size);
    } else if (t < 0.66) {
      pottedPlant(op, cut, cx, o.y, cz, rng, size);
    } else if (t < 0.78) {
      // stack of crates / buckets
      const c = rgb(rng.pick([0x2f6fd8, 0xe8442f, 0xffc714, 0x2fc36a]));
      const k = rng.int(1, 3);
      for (let j = 0; j < k; j++) {
        const s2 = 0.28 - j * 0.02;
        op.prism(cx, cz, s2, s2 * 0.86, o.y + j * 0.3, o.y + (j + 1) * 0.3, 8, T('plastic', size), c);
      }
    } else if (t < 0.9) {
      // solar water heater / tank on its side
      op.box(cx - 0.5, o.y + 0.05, cz - 0.3, cx + 0.5, o.y + 0.22, cz + 0.3, T('zinc', size), rgb(0x8f9298), 0x1f);
      op.prism(cx, cz, 0.22, 0.22, o.y + 0.22, o.y + 0.9, 8, T('zinc', size), rgb(0xc4c8c8));
    } else {
      // a zinc-roofed roof shack — the extra room nobody permitted
      const sw = rng.range(1.4, 2.2);
      const sd = rng.range(1.3, 1.9);
      const sh = rng.range(1.9, 2.3);
      const c = rgb(rng.pick(PAINT));
      op.box(cx - sw * 0.5, o.y, cz - sd * 0.5, cx + sw * 0.5, o.y + sh, cz + sd * 0.5, T('block', size), c, 0x0f, 2);
      op.box(cx - sw * 0.55, o.y + sh, cz - sd * 0.55, cx + sw * 0.55, o.y + sh + 0.09, cz + sd * 0.55, T('zincRust', size), rgb(0xb0aca0), 0x1f);
    }
  }

  // washing line strung across the roof
  if (rng.bool(o.keepClear ? 0.35 : 0.75) && w > 3) {
    const y = o.y + 1.7;
    const z = pz(rng.range(0.3, 0.8));
    const a = o.x0 + 0.4;
    const b = o.x1 - 0.4;
    op.box(a - 0.04, o.y, z - 0.04, a + 0.04, y, z + 0.04, T('zinc', size), rgb(0x8d8a82), 0x0f);
    op.box(b - 0.04, o.y, z - 0.04, b + 0.04, y, z + 0.04, T('zinc', size), rgb(0x8d8a82), 0x0f);
    laundryLine(cut, a, b, y, z, rng, size);
  }
}

export function laundryLine(cut: Mesher, x0: number, x1: number, y: number, z: number, rng: RNG, size: number): void {
  const span = x1 - x0;
  const segs = Math.max(3, Math.round(span / 1.1));
  const sag = Math.min(0.34, span * 0.045);
  const wire = T('wire', size);
  const dark = rgb(0x2a2723);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const xa = lerp(x0, x1, t0);
    const xb = lerp(x0, x1, t1);
    const ya = y - Math.sin(t0 * Math.PI) * sag;
    const yb = y - Math.sin(t1 * Math.PI) * sag;
    cut.face(
      _q0.set(xa, ya - 0.022, z), _q1.set(xb, yb - 0.022, z),
      _q2.set(xb, yb + 0.022, z), _q3.set(xa, ya + 0.022, z), wire, dark, dark,
    );
    cut.face(
      _q0.set(xb, yb - 0.022, z), _q1.set(xa, ya - 0.022, z),
      _q2.set(xa, ya + 0.022, z), _q3.set(xb, yb + 0.022, z), wire, dark, dark,
    );
  }
  const items = Math.max(2, Math.round(span / 0.85));
  for (let i = 0; i < items; i++) {
    if (rng.bool(0.22)) continue;
    const t = (i + 0.5) / items;
    const cx = lerp(x0, x1, t);
    const cy = y - Math.sin(t * Math.PI) * sag;
    const w = rng.range(0.42, 0.7);
    const h = rng.range(0.5, 0.95);
    const cloth = rgb(rng.pick([0xffffff, 0xffd166, 0x4c8bf5, 0xef476f, 0x8bc34a, 0xf2f0e6, 0xff6a1f, 0x18b6c4]));
    const rect = T(rng.bool() ? 'clothA' : 'clothB', size);
    cut.cardZ(cx - w * 0.5, cy - h, cx + w * 0.5, cy + 0.04, z + 0.01, rect, cloth, true);
    cut.cardZ(cx - w * 0.5, cy - h, cx + w * 0.5, cy + 0.04, z + 0.01, rect, shade(cloth, 0.7), false);
  }
}

export function plasticChair(op: Mesher, x: number, y: number, z: number, rng: RNG, size: number): void {
  const c = rgb(rng.pick([0xf2f0e6, 0x2f6fd8, 0xe8442f, 0x2fc36a, 0xffc714]));
  const r = T('plastic', size);
  const s = 0.24;
  for (const dx of [-s, s]) {
    for (const dz of [-s, s]) {
      op.box(x + dx - 0.028, y, z + dz - 0.028, x + dx + 0.028, y + 0.42, z + dz + 0.028, r, shade(c, 0.9), 0x0f);
    }
  }
  op.box(x - s - 0.04, y + 0.42, z - s - 0.04, x + s + 0.04, y + 0.48, z + s + 0.04, r, c, 0x1f);
  op.box(x - s - 0.04, y + 0.48, z + s - 0.02, x + s + 0.04, y + 0.94, z + s + 0.04, r, c, 0x1f);
}

export function pottedPlant(op: Mesher, cut: Mesher, x: number, y: number, z: number, rng: RNG, size: number): void {
  const potc = rgb(rng.pick([0xc4693f, 0xf2f0e6, 0x2f6fd8, 0xe8442f, 0xd8d2c4]));
  const r = rng.range(0.15, 0.3);
  op.prism(x, z, r * 0.75, r, y, y + r * 1.5, 8, T('plastic', size), potc);
  const kind = rng.weighted(['sprig', 'flowers', 'banana', 'tuft'] as TileId[], [3, 3, 1.6, 2]);
  const h = kind === 'banana' ? rng.range(1.0, 1.7) : rng.range(0.5, 0.95);
  const w = kind === 'banana' ? h * 0.7 : h * 1.1;
  const base = y + r * 1.4;
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI * 0.5 + rng.range(0, 0.6);
    const dx = Math.cos(a) * w * 0.5;
    const dz = Math.sin(a) * w * 0.5;
    cut.face(
      _q0.set(x - dx, base, z - dz), _q1.set(x + dx, base, z + dz),
      _q2.set(x + dx, base + h, z + dz), _q3.set(x - dx, base + h, z - dz),
      T(kind, size), WHITE, WHITE,
    );
    cut.face(
      _q0.set(x + dx, base, z + dz), _q1.set(x - dx, base, z - dz),
      _q2.set(x - dx, base + h, z - dz), _q3.set(x + dx, base + h, z + dz),
      T(kind, size), shade(WHITE, 0.7), shade(WHITE, 0.7),
    );
  }
}

/* --------------------------------------------------------- retaining wall */

/**
 * The concrete face that holds one terrace up over the next. Weep holes,
 * a coping, a run of rust bleed, and a hand-painted stripe where somebody
 * has claimed the bit outside their door.
 */
export function buildRetaining(
  op: Mesher, x0: number, x1: number, z: number, yBot: number, yTop: number,
  rng: RNG, size: number, painted: number,
): void {
  if (yTop - yBot < 0.15 || x1 - x0 < 0.1) return;
  const face = rgb(CONCRETE.raw);
  const stained = shade(face, 0.62);
  op.wall(0, x0, x1, yBot - 0.4, yTop, z, T('rawcrete', size), stained, face, 4);
  // coping
  op.box(x0, yTop, z - 0.12, x1, yTop + 0.17, z + 0.2, T('concrete', size), rgb(CONCRETE.bare), 0x1f, 1);
  // weep holes
  const n = Math.max(1, Math.floor((x1 - x0) / 3.5));
  for (let i = 0; i < n; i++) {
    const cx = lerp(x0 + 1, x1 - 1, n === 1 ? 0.5 : i / (n - 1));
    const wy = yBot + (yTop - yBot) * 0.32;
    op.box(cx - 0.07, wy, z - 0.02, cx + 0.07, wy + 0.1, z + 0.02, T('rawcrete', size), shade(face, 0.22), 0x01);
    op.wall(0, cx - 0.09, cx + 0.09, wy - 1.2, wy, z - 0.008, T('render2', size), shade(face, 0.5), shade(face, 0.72), 1);
  }
  // somebody's paint job on the bottom third
  if (painted >= 0) {
    const c = rgb(painted);
    const px0 = lerp(x0, x1, rng.range(0, 0.4));
    const px1 = Math.min(x1, px0 + rng.range(3, 9));
    op.wall(0, px0, px1, yBot, yBot + (yTop - yBot) * rng.range(0.35, 0.6), z - 0.01, T('render1', size), shade(c, 0.6), c, 2);
  }
}

/* ------------------------------------------------------------- the muralla */

/**
 * The city wall above the barrio. Battered (never vertical — §8.13), coursed
 * sandstone, with a cordon string course, a coping and a parapet walk on top.
 */
export function buildMuralla(
  op: Mesher, x0: number, x1: number, z: number,
  crest: (x: number) => number, base: (x: number) => number,
  size: number, gates: ReadonlyArray<readonly [number, number]> = [], step = 3.5,
): void {
  const stone = rgb(0xc8bda4);
  const stoneDark = rgb(0x9d947f);
  const cop = rgb(0xd8cdb2);
  const rect = T('rubble', size);
  const THICK = 2.1;
  const BATTER = 0.15; // metres the face leans out per metre of drop (§8.13)
  const zOut = z - THICK * 0.5;
  const zIn = z + THICK * 0.5;
  const n = Math.max(1, Math.round((x1 - x0) / step));

  const inGate = (x: number): boolean => {
    for (const g of gates) if (x > g[0] && x < g[1]) return true;
    return false;
  };

  for (let i = 0; i < n; i++) {
    const xa = lerp(x0, x1, i / n);
    const xb = lerp(x0, x1, (i + 1) / n);
    const ca = crest(xa);
    const cb = crest(xb);
    const gate = inGate((xa + xb) * 0.5);
    // a gate leaves an arch: the wall springs from 3.4 m instead of the ground
    const ba = gate ? Math.min(ca - 1.6, crest(xa) - 1.6) : base(xa) - 0.7;
    const bb = gate ? Math.min(cb - 1.6, crest(xb) - 1.6) : base(xb) - 0.7;
    // outer (seaward) face: the foot is pushed further out than the head
    const oa = zOut - (ca - ba) * BATTER;
    const ob = zOut - (cb - bb) * BATTER;
    op.face(
      _q0.set(xb, bb, ob), _q1.set(xa, ba, oa), _q2.set(xa, ca, zOut), _q3.set(xb, cb, zOut),
      rect, shade(stoneDark, 0.8), stone,
    );
    // inner face — mostly buried, only the top 2 m of it ever shows
    op.face(
      _q0.set(xa, Math.max(ba, ca - 2.4), zIn), _q1.set(xb, Math.max(bb, cb - 2.4), zIn),
      _q2.set(xb, cb, zIn), _q3.set(xa, ca, zIn),
      rect, shade(stoneDark, 0.76), shade(stone, 0.92),
    );
    // wall walk / coping
    op.face(
      _q0.set(xa, ca, zOut), _q1.set(xb, cb, zOut), _q2.set(xb, cb, zIn), _q3.set(xa, ca, zIn),
      T('concrete', size), cop, cop,
    );
    // cordon string course, two thirds of the way down the batter
    const ya = lerp(ba, ca, 0.68);
    const yb2 = lerp(bb, cb, 0.68);
    const sa = zOut - (ca - ya) * BATTER - 0.14;
    const sb = zOut - (cb - yb2) * BATTER - 0.14;
    op.face(
      _q0.set(xb, yb2 - 0.17, sb), _q1.set(xa, ya - 0.17, sa),
      _q2.set(xa, ya + 0.17, sa), _q3.set(xb, yb2 + 0.17, sb),
      rect, shade(cop, 0.82), cop,
    );
    op.face(
      _q0.set(xa, ya + 0.17, sa), _q1.set(xb, yb2 + 0.17, sb),
      _q2.set(xb, yb2 + 0.17, zOut - (cb - yb2) * BATTER), _q3.set(xa, ya + 0.17, zOut - (ca - ya) * BATTER),
      T('concrete', size), shade(cop, 1.06), shade(cop, 1.06),
    );
    if (gate) {
      // the arch soffit, so a gate reads as a hole through 2.1 m of masonry
      op.face(
        _q0.set(xa, ba, oa), _q1.set(xb, bb, ob), _q2.set(xb, bb, zIn), _q3.set(xa, ba, zIn),
        rect, shade(stoneDark, 0.4), shade(stoneDark, 0.4),
      );
    }
  }

  // jambs and voussoirs on each gate
  for (const g of gates) {
    for (const gx of [g[0], g[1]]) {
      const c = crest(gx);
      const b = base(gx) - 0.7;
      const s2 = gx === g[0] ? -0.45 : 0.45;
      op.box(
        Math.min(gx, gx + s2), b, zOut - (c - b) * BATTER - 0.06,
        Math.max(gx, gx + s2), Math.min(c - 1.4, c), zIn + 0.06,
        T('rubble', size), shade(stone, 1.06), 0x0f, 2,
      );
    }
    const cx = (g[0] + g[1]) * 0.5;
    const c = crest(cx);
    const r = (g[1] - g[0]) * 0.5;
    const springs = Math.min(c - 1.6, c);
    for (let k = 0; k < 7; k++) {
      const a0 = Math.PI * (k / 7);
      const a1 = Math.PI * ((k + 1) / 7);
      const xA = cx + Math.cos(Math.PI - a0) * r;
      const xB = cx + Math.cos(Math.PI - a1) * r;
      const yA = springs + Math.sin(a0) * r * 0.9;
      const yB = springs + Math.sin(a1) * r * 0.9;
      op.face(
        _q0.set(xA, yA, zOut - 0.02), _q1.set(xB, yB, zOut - 0.02),
        _q2.set(xB, yB + 0.42, zOut - 0.02), _q3.set(xA, yA + 0.42, zOut - 0.02),
        T('rubble', size), shade(stone, 1.1), shade(stone, 1.1),
      );
    }
  }
}

/**
 * A garita — the corbelled octagonal sentry box that is the island's de-facto
 * emblem (§7.4). Drum, corbel, ribbed dome, finial.
 */
export function buildGarita(op: Mesher, x: number, y: number, z: number, size: number): void {
  const stone = rgb(0xd2c7ad);
  const dark = rgb(0xa89c82);
  const rect = T('rubble', size);
  // corbelled bracket under the drum
  op.prism(x, z, 0.55, 1.05, y - 1.5, y, 8, rect, dark, false);
  // drum
  op.prism(x, z, 1.05, 1.02, y, y + 2.1, 8, rect, stone, false);
  // loopholes: four dark slots
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const px = x + Math.cos(a) * 1.0;
    const pz = z + Math.sin(a) * 1.0;
    op.prism(px, pz, 0.12, 0.12, y + 0.9, y + 1.5, 4, rect, shade(dark, 0.25), false);
  }
  // cornice
  op.prism(x, z, 1.08, 1.24, y + 2.1, y + 2.32, 8, rect, stone, false);
  op.prism(x, z, 1.24, 1.18, y + 2.32, y + 2.46, 8, rect, stone, false);
  // ribbed dome
  const rings = 5;
  for (let i = 0; i < rings; i++) {
    const t0 = i / rings;
    const t1 = (i + 1) / rings;
    const r0 = 1.18 * Math.cos(t0 * Math.PI * 0.5);
    const r1 = 1.18 * Math.cos(t1 * Math.PI * 0.5);
    const y0 = y + 2.46 + Math.sin(t0 * Math.PI * 0.5) * 1.05;
    const y1 = y + 2.46 + Math.sin(t1 * Math.PI * 0.5) * 1.05;
    op.prism(x, z, r0, r1, y0, y1, 8, rect, shade(stone, lerp(1.0, 1.12, t0)), i === rings - 1);
  }
  // finial
  op.prism(x, z, 0.12, 0.07, y + 3.5, y + 3.85, 6, rect, shade(stone, 1.15));
}

/* ------------------------------------------------------------------ poles */

/** Utility pole with crossarm, transformer can and insulators. */
export function buildPole(op: Mesher, cut: Mesher, x: number, y: number, z: number, h: number, rng: RNG, size: number): void {
  const wood = rgb(0x6b5d4c);
  const rect = T('rawcrete', size);
  op.prism(x, z, 0.15, 0.12, y - 0.3, y + h, 6, rect, wood, false);
  const ay = y + h - rng.range(0.6, 1.2);
  const armR = T('zincRust', size);
  op.box(x - 1.15, ay, z - 0.06, x + 1.15, ay + 0.13, z + 0.06, armR, rgb(0x726858), 0x1f);
  for (const dx of [-0.95, -0.35, 0.35, 0.95]) {
    op.prism(x + dx, z, 0.055, 0.05, ay + 0.13, ay + 0.28, 6, T('plastic', size), rgb(0x3c4a44));
  }
  if (rng.bool(0.35)) {
    op.prism(x + 0.28, z, 0.24, 0.24, y + h - 2.6, y + h - 1.7, 8, armR, rgb(0x8d8a80));
  }
  // a knot of low-voltage drops and a bare bulb
  if (rng.bool(0.5)) {
    const by = ay - 0.9;
    op.box(x - 0.05, by, z - 0.05, x + 0.05, by + 0.3, z + 0.05, armR, rgb(0x4a4a44), 0x0f);
    op.prism(x, z, 0.07, 0.05, by - 0.16, by, 6, T('plastic', size), rgb(0xfff0c8), true, 0.95);
  }
  void cut;
}

/** A slung wire between two points, as a thin double-sided ribbon. */
export function buildWire(
  cut: Mesher, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  sag: number, size: number,
): void {
  const segs = 6;
  const rect = T('wire', size);
  const c = rgb(0x22201d);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const s0 = Math.sin(t0 * Math.PI) * sag;
    const s1 = Math.sin(t1 * Math.PI) * sag;
    const ax = lerp(x0, x1, t0);
    const az = lerp(z0, z1, t0);
    const ay = lerp(y0, y1, t0) - s0;
    const bx = lerp(x0, x1, t1);
    const bz = lerp(z0, z1, t1);
    const by = lerp(y0, y1, t1) - s1;
    cut.face(
      _q0.set(ax, ay - 0.03, az), _q1.set(bx, by - 0.03, bz),
      _q2.set(bx, by + 0.03, bz), _q3.set(ax, ay + 0.03, az), rect, c, c,
    );
    cut.face(
      _q0.set(bx, by - 0.03, bz), _q1.set(ax, ay - 0.03, az),
      _q2.set(ax, ay + 0.03, az), _q3.set(bx, by + 0.03, bz), rect, c, c,
    );
  }
}

/* ----------------------------------------------------------------- stairs */

/** A flight of concrete steps, with a hand rail on one side. */
export function buildStairs(
  op: Mesher, cut: Mesher, x0: number, x1: number, zTop: number, yTop: number, zBot: number, yBot: number,
  size: number, rail = true,
): void {
  const run = Math.abs(zTop - zBot);
  const rise = yTop - yBot;
  if (run < 0.4 || rise < 0.2) return;
  const steps = Math.max(3, Math.round(rise / 0.19));
  const rect = T('tread', size);
  const c = rgb(CONCRETE.bare);
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const za = lerp(zTop, zBot, t0);
    const zb2 = lerp(zTop, zBot, t1);
    const ya = lerp(yTop, yBot, t0);
    const yb2 = lerp(yTop, yBot, t1);
    op.deck(x0, zb2, x1, za, ya, rect, shade(c, 1.04));
    op.wall(0, x0, x1, yb2, ya, zb2, rect, shade(c, 0.62), shade(c, 0.8), 1);
  }
  if (rail) {
    const seg = 5;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg;
      const t1 = (i + 1) / seg;
      const za = lerp(zTop, zBot, t0);
      const zb2 = lerp(zTop, zBot, t1);
      const ya = lerp(yTop, yBot, t0) + 0.95;
      const yb2 = lerp(yTop, yBot, t1) + 0.95;
      cut.face(
        _q0.set(x1 - 0.06, ya - 0.85, za), _q1.set(x1 - 0.06, yb2 - 0.85, zb2),
        _q2.set(x1 - 0.06, yb2, zb2), _q3.set(x1 - 0.06, ya, za), T('rail', size), rgb(0x2b3138), rgb(0x2b3138),
      );
      cut.face(
        _q0.set(x1 - 0.06, yb2 - 0.85, zb2), _q1.set(x1 - 0.06, ya - 0.85, za),
        _q2.set(x1 - 0.06, ya, za), _q3.set(x1 - 0.06, yb2, zb2), T('rail', size), rgb(0x2b3138), rgb(0x2b3138),
      );
    }
  }
}

/* ------------------------------------------------------------------- cars */

/** A parked car — modern Caribbean-US saloon or pickup, dusty (§7.2). */
export function buildCar(op: Mesher, x: number, y: number, z: number, yaw: number, rng: RNG, size: number): void {
  const body = rgb(rng.pick([0xd8d8d4, 0x2b3f6b, 0x9d2b2b, 0x2f4f3f, 0x1c1c1e, 0xb0b4b8, 0xe0e2e0, 0x5a6b7a]));
  const glass = rgb(0x2a3540);
  const rect = T('carBody', size);
  const pickup = rng.bool(0.32);
  const L = pickup ? 5.3 : 4.5;
  const W = 1.82;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const put = (lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(x + lx * cs - lz * sn, y + ly, z + lx * sn + lz * cs);

  const boxL = (
    lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number, c: Col, glow = 0,
  ): void => {
    const corners: Array<[number, number, number]> = [
      [lx0, ly0, lz0], [lx1, ly0, lz0], [lx1, ly0, lz1], [lx0, ly0, lz1],
      [lx0, ly1, lz0], [lx1, ly1, lz0], [lx1, ly1, lz1], [lx0, ly1, lz1],
    ];
    const v: THREE.Vector3[] = corners.map((cc) => put(cc[0], cc[1], cc[2], new THREE.Vector3()));
    const f = (a: number, b: number, cq: number, d: number, k: number): void => {
      op.face(v[a], v[b], v[cq], v[d], rect, shade(c, k), shade(c, k * 1.04), glow);
    };
    f(0, 1, 5, 4, 0.9);
    f(2, 3, 7, 6, 0.82);
    f(1, 2, 6, 5, 0.96);
    f(3, 0, 4, 7, 0.96);
    f(4, 5, 6, 7, 1.12);
  };

  boxL(-L * 0.5, 0.34, -W * 0.5, L * 0.5, 0.98, W * 0.5, body);
  if (pickup) {
    boxL(-L * 0.5 + 0.5, 0.98, -W * 0.46, L * 0.5 - 2.4, 1.72, W * 0.46, glass);
    boxL(L * 0.5 - 2.35, 0.98, -W * 0.48, L * 0.5, 1.32, W * 0.48, body);
  } else {
    boxL(-L * 0.32, 0.98, -W * 0.45, L * 0.28, 1.56, W * 0.45, glass);
  }
  // wheels
  const wr = 0.33;
  for (const wx of [-L * 0.32, L * 0.32]) {
    for (const wz of [-W * 0.5, W * 0.5]) {
      const p = put(wx, wr, wz, new THREE.Vector3());
      op.prism(p.x, p.z, wr, wr, y + 0.02, y + 0.2, 8, T('plastic', size), rgb(0x18191a));
      void p;
    }
  }
  // lamps
  boxL(L * 0.5 - 0.06, 0.62, -W * 0.42, L * 0.5, 0.86, -W * 0.16, rgb(0xfff2d0), 0.2);
  boxL(L * 0.5 - 0.06, 0.62, W * 0.16, L * 0.5, 0.86, W * 0.42, rgb(0xfff2d0), 0.2);
  boxL(-L * 0.5, 0.62, -W * 0.42, -L * 0.5 + 0.06, 0.86, -W * 0.16, rgb(0xd83a2a), 0.25);
  boxL(-L * 0.5, 0.62, W * 0.16, -L * 0.5 + 0.06, 0.86, W * 0.42, rgb(0xd83a2a), 0.25);
}

/* ------------------------------------------------------------- vegetation */

/** A coconut palm: tapered leaning trunk plus six cut-out fronds. */
export function buildPalm(op: Mesher, cut: Mesher, x: number, y: number, z: number, rng: RNG, size: number): void {
  const h = rng.range(7, 13);
  const lean = rng.range(0.06, 0.2);
  const la = rng.range(0, Math.PI * 2);
  const lx = Math.cos(la) * lean;
  const lz = Math.sin(la) * lean;
  const segs = 5;
  const trunk = rgb(0x9a8a6e);
  const rect = T('rubble', size);
  let px = x;
  let pz = z;
  let py = y;
  for (let i = 0; i < segs; i++) {
    const t1 = (i + 1) / segs;
    const nx = x + lx * h * t1 * t1;
    const nz = z + lz * h * t1 * t1;
    const ny = y + h * t1;
    const r0 = lerp(0.3, 0.16, i / segs);
    const r1 = lerp(0.3, 0.16, t1);
    // approximate a leaning cylinder with a short prism between the two rings
    op.prism(lerp(px, nx, 0.5), lerp(pz, nz, 0.5), r0, r1, py, ny, 6, rect, shade(trunk, lerp(0.86, 1.06, t1)), false);
    px = nx;
    pz = nz;
    py = ny;
  }
  const cy = py;
  const nFronds = 7;
  for (let i = 0; i < nFronds; i++) {
    const a = (i / nFronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = rng.range(2.6, 3.7);
    const drop = rng.range(0.6, 1.5);
    const dx = Math.cos(a) * len;
    const dz = Math.sin(a) * len;
    const wid = 0.62;
    const wx = -Math.sin(a) * wid;
    const wz = Math.cos(a) * wid;
    cut.face(
      _q0.set(px - wx, cy, pz - wz), _q1.set(px + wx, cy, pz + wz),
      _q2.set(px + dx + wx, cy - drop, pz + dz + wz), _q3.set(px + dx - wx, cy - drop, pz + dz - wz),
      T('frond', size), WHITE, WHITE,
    );
    cut.face(
      _q0.set(px + wx, cy, pz + wz), _q1.set(px - wx, cy, pz - wz),
      _q2.set(px + dx - wx, cy - drop, pz + dz - wz), _q3.set(px + dx + wx, cy - drop, pz + dz + wz),
      T('frond', size), shade(WHITE, 0.62), shade(WHITE, 0.62),
    );
  }
  // coconuts
  for (let i = 0; i < 4; i++) {
    const a = rng.range(0, Math.PI * 2);
    op.prism(px + Math.cos(a) * 0.28, pz + Math.sin(a) * 0.28, 0.11, 0.09, cy - 0.42, cy - 0.2, 5, rect, rgb(0x6f5a34));
  }
}

/** A low bush: two crossed cut-out cards. */
export function buildBush(cut: Mesher, x: number, y: number, z: number, r: number, kind: TileId, rng: RNG, size: number): void {
  const h = r * rng.range(1.2, 1.9);
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI * 0.5 + rng.range(0, 0.7);
    const dx = Math.cos(a) * r;
    const dz = Math.sin(a) * r;
    cut.face(
      _q0.set(x - dx, y, z - dz), _q1.set(x + dx, y, z + dz),
      _q2.set(x + dx, y + h, z + dz), _q3.set(x - dx, y + h, z - dz), T(kind, size), WHITE, WHITE,
    );
    cut.face(
      _q0.set(x + dx, y, z + dz), _q1.set(x - dx, y, z - dz),
      _q2.set(x - dx, y + h, z - dz), _q3.set(x + dx, y + h, z + dz), T(kind, size), shade(WHITE, 0.66), shade(WHITE, 0.66),
    );
  }
}

/** A shore boulder — an irregular low prism, dark and wet at the base. */
export function buildBoulder(op: Mesher, x: number, y: number, z: number, r: number, h: number, rng: RNG, size: number): void {
  const sides = 6;
  const rect = T('rock', size);
  const c = rgb(0x4c4a46);
  const top: number[] = [];
  const rr: number[] = [];
  for (let i = 0; i < sides; i++) rr.push(r * rng.range(0.7, 1.25));
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const r0 = rr[i];
    const r1 = rr[(i + 1) % sides];
    const mx = Math.cos((a0 + a1) * 0.5);
    const mz = Math.sin((a0 + a1) * 0.5);
    // the face leans in as it rises, so the normal has to lean out with it
    const inv = 1 / Math.hypot(mx, 0.42, mz);
    const nx = mx * inv;
    const ny = 0.42 * inv;
    const nz = mz * inv;
    const k = lerp(0.7, 1.14, clamp01(mx * 0.4 + mz * 0.3 + 0.6));
    const i0 = op.vert(x + Math.cos(a0) * r0, y - 0.4, z + Math.sin(a0) * r0, nx, ny, nz, rect.u0, rect.v0, shade(c, k * 0.6));
    const i1 = op.vert(x + Math.cos(a1) * r1, y - 0.4, z + Math.sin(a1) * r1, nx, ny, nz, rect.u1, rect.v0, shade(c, k * 0.6));
    const i2 = op.vert(x + Math.cos(a1) * r1 * 0.55, y + h, z + Math.sin(a1) * r1 * 0.55, nx, ny, nz, rect.u1, rect.v1, shade(c, k));
    const i3 = op.vert(x + Math.cos(a0) * r0 * 0.55, y + h, z + Math.sin(a0) * r0 * 0.55, nx, ny, nz, rect.u0, rect.v1, shade(c, k));
    op.quad(i0, i1, i2, i3);
    top.push(op.vert(x + Math.cos(a0) * r0 * 0.55, y + h, z + Math.sin(a0) * r0 * 0.55, 0, 1, 0,
      lerp(rect.u0, rect.u1, 0.5 + Math.cos(a0) * 0.4), lerp(rect.v0, rect.v1, 0.5 + Math.sin(a0) * 0.4), shade(c, 1.2)));
  }
  for (let i = 1; i < top.length - 1; i++) op.tri(top[0], top[i], top[i + 1]);
}

/** A beached fishing skiff — the yola every seaside barrio keeps on the rocks. */
export function buildSkiff(op: Mesher, x: number, y: number, z: number, yaw: number, rng: RNG, size: number): void {
  const hull = rgb(rng.pick([0xf2f0e6, 0x2f6fd8, 0x18b6c4, 0xffc714]));
  const stripe = rgb(rng.pick([0xe8442f, 0x1f5fd8, 0x14324f]));
  const rect = T('render0', size);
  const L = 4.4;
  const W = 1.5;
  const H = 0.74;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number): THREE.Vector3 =>
    new THREE.Vector3(x + lx * cs - lz * sn, y + ly, z + lx * sn + lz * cs);

  const N = 7;
  const keel: THREE.Vector3[] = [];
  const gunL: THREE.Vector3[] = [];
  const gunR: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const lx = lerp(-L * 0.5, L * 0.5, t);
    const taper = Math.pow(Math.sin(t * Math.PI), 0.6);
    keel.push(P(lx, 0.1, 0));
    gunL.push(P(lx, H, -W * 0.5 * taper));
    gunR.push(P(lx, H, W * 0.5 * taper));
  }
  for (let i = 0; i < N; i++) {
    op.face(keel[i], keel[i + 1], gunR[i + 1], gunR[i], rect, shade(hull, 0.68), hull);
    op.face(keel[i + 1], keel[i], gunL[i], gunL[i + 1], rect, shade(hull, 0.68), hull);
    // the inside, dark
    op.face(gunL[i], gunL[i + 1], gunR[i + 1], gunR[i], rect, shade(hull, 0.34), shade(hull, 0.4));
  }
  // gunwale stripe: a thin band along each sheer line
  for (const side of [gunL, gunR]) {
    for (let i = 0; i < N; i++) {
      const a = side[i];
      const b = side[i + 1];
      op.face(
        new THREE.Vector3(a.x, a.y - 0.13, a.z), new THREE.Vector3(b.x, b.y - 0.13, b.z),
        new THREE.Vector3(b.x, b.y, b.z), new THREE.Vector3(a.x, a.y, a.z),
        rect, stripe, shade(stripe, 1.1),
      );
      op.face(
        new THREE.Vector3(b.x, b.y - 0.13, b.z), new THREE.Vector3(a.x, a.y - 0.13, a.z),
        new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z),
        rect, shade(stripe, 0.7), shade(stripe, 0.8),
      );
    }
  }
  // two thwarts
  for (const t of [0.34, 0.62]) {
    const i = Math.round(t * N);
    op.face(gunL[i], gunR[i], gunR[i], gunL[i], rect, shade(hull, 0.5), shade(hull, 0.5));
    const a = gunL[i];
    const b = gunR[i];
    op.face(
      new THREE.Vector3(a.x - sn * 0.16, a.y - 0.06, a.z + cs * 0.16),
      new THREE.Vector3(b.x - sn * 0.16, b.y - 0.06, b.z + cs * 0.16),
      new THREE.Vector3(b.x + sn * 0.16, b.y - 0.06, b.z - cs * 0.16),
      new THREE.Vector3(a.x + sn * 0.16, a.y - 0.06, a.z - cs * 0.16),
      rect, shade(hull, 0.86), shade(hull, 0.86),
    );
  }
}
