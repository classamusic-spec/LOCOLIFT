/**
 * Loco Lift — the roadside kit.
 *
 * Everything the outer world is *dressed* with, in one place: the timber and
 * zinc chinchorro shack itself, the umbrellas, plastic chairs, barrel tables,
 * coolers, gas bottles, speakers, bollards, flags, banners and parked cars that
 * cluster around it, plus the plaza and street furniture (benches, cast-iron
 * lamps, planters, market stalls) that `PlazaLife` and `StreetDressing` place.
 *
 * Three rules hold this file together:
 *
 *  1. **One material set for the whole outer world.** {@link PropKit} owns
 *     seven materials and four textures, refcounted and shared between every
 *     layer that imports this module, so four world layers cost seven
 *     *programs*, not forty. Colour is carried per-vertex; a hand-painted sign
 *     is a rect in one shared canvas atlas.
 *  2. **Every prop is a `GeoBuilder`.** The coast layer's builder
 *     (`src/world/Coast.ts`) is reused rather than duplicated. Props authored
 *     into a shared builder merge into one mesh; props authored on their own
 *     become one `InstancedMesh`. Nothing is ever a mesh per object.
 *  3. **Wind is in the vertex shader.** Cloth and foliage carry an `aWave` aux
 *     channel — x = sway weight, y = per-object phase, z = flutter weight — so
 *     every awning, flag, banner and leaf breathes on its own clock for free.
 *
 * Cultural note (§7): the signage here is Puerto Rican roadside Spanish —
 * *alcapurrias*, *bacalaítos*, *pinchos*, *mabí*, *limbers*, *coco frío* — and
 * every brand name on a painted beer or soda board is invented. No real
 * trademark is reproduced.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import { clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GeoBuilder } from './Coast';
import { createCanvas, type Canvas2D } from './TextureFactory';

/* ========================================================================== *
 *  palette
 * ========================================================================== */

/** Every colour the roadside kit uses, sRGB. */
export const KIT = {
  /* painted timber — the shacks are the brightest thing on the beach */
  shackWall: [0x1e9baa, 0xe8a93b, 0xe8836f, 0x6fa84a, 0x4fbfb1, 0xd9573f, 0xf2e4c4, 0x3e6e9e] as const,
  shackTrim: [0xfbf7ee, 0xf1ebdd, 0xffd166] as const,
  woodRaw: 0x8b6f4e,
  woodPale: 0xa8927a,
  woodDark: 0x5c4630,
  post: 0x6f573d,
  zinc: 0xb9c0c4,
  zincOld: 0x9aa2a6,
  rust: 0x8a5233,
  concrete: 0xc9c3b4,
  bollard: 0xf2c230,
  bollardTop: 0xf7f3e6,

  /* cloth */
  umbrellaRed: 0xd52b1e,
  umbrellaWhite: 0xf7f4ec,
  awningBlue: 0x2e5e86,
  awningGreen: 0x14523c,

  /* plastic and steel */
  plasticWhite: 0xf2f0e8,
  plasticRed: 0xc33227,
  plasticBlue: 0x2e5e86,
  coolerBody: 0xe8e4d8,
  coolerLid: 0xc33227,
  steel: 0x8d949a,
  steelDark: 0x4a5054,
  propane: 0xd8cfae,
  black: 0x1a1d20,

  /* flag — §7.4, the standard Puerto Rican flag */
  flagRed: 0xed0000,
  flagBlue: 0x0050f0,
  flagWhite: 0xf7f7f7,

  /* planting */
  leafDark: 0x2f5e29,
  leafMid: 0x487f30,
  leafLit: 0x7aa93c,
  bloom: [0xd6217a, 0xe8563f, 0xf4f0e6, 0xb43fa8, 0xf6a01f] as const,
  soil: 0x3c2f24,
  terracotta: 0xb4643c,

  /* stone furniture */
  stoneLight: 0xd8d2c2,
  stoneMid: 0xb8b1a0,
  stoneShadow: 0x8d8878,
  iron: 0x1e2a26,
  ironWorn: 0x3a4046,

  /* cars, sun-faded modern Caribbean traffic (§7.2) */
  carBody: [0xd9d4c8, 0x3f6ea8, 0xb03a2e, 0x6b7a52, 0x2b2f33, 0xe0c14a, 0x8c8f94] as const,
  carGlass: 0x24303a,
  tyre: 0x14161a,
} as const;

/* ========================================================================== *
 *  wind shader — shared by cloth and foliage
 * ========================================================================== */

/**
 * `aWave`: x = sway weight (0 anchored, 1 free tip), y = per-object phase 0..1,
 * z = flutter weight. Instanced geometry additionally picks up a phase from its
 * instance origin, so a row of identical umbrellas never pulses in unison.
 */
const WAVE_PARS = /* glsl */ `
uniform float uKitTime;
uniform vec2 uKitWind;
uniform float uKitGust;
attribute vec3 aWave;
`;

const WAVE_BEGIN = /* glsl */ `
#include <begin_vertex>
{
  float kphase = aWave.y * 6.2831853;
  #ifdef USE_INSTANCING
    kphase += dot( instanceMatrix[ 3 ].xyz, vec3( 0.137, 0.079, 0.113 ) );
  #endif
  float kt = uKitTime;
  float kgust = 0.62 + 0.38 * sin( kt * 0.21 + kphase * 0.37 );
  float ksway = sin( kt * 2.05 + kphase ) * 0.63 + sin( kt * 1.24 + kphase * 1.7 ) * 0.37;
  float kflut = sin( kt * 7.1 + kphase * 3.3 ) * 0.55 + sin( kt * 4.6 + kphase * 2.1 ) * 0.45;
  float kamp = uKitGust * kgust;
  transformed.xz += uKitWind * ( ksway * aWave.x * kamp );
  transformed.y -= aWave.x * aWave.x * abs( ksway ) * kamp * 0.3;
  transformed.xz += uKitWind.yx * vec2( 1.0, -1.0 ) * ( kflut * aWave.z * kamp * 0.5 );
  transformed.y += kflut * aWave.z * kamp * 0.35;
}
`;

/** Night-driven emissive lift, used by festoon bulbs, lamps and shack interiors. */
const GLOW_FRAG = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * uKitNight * 2.6;
`;

interface KitUniforms {
  uKitTime: { value: number };
  uKitWind: { value: THREE.Vector2 };
  uKitGust: { value: number };
  uKitNight: { value: number };
}

/* ========================================================================== *
 *  procedural textures
 * ========================================================================== */

function normalFromHeight(h: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 65536) / 65536;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Sawn timber: long grain streaks, plank joints every 32 texels. */
function woodNormalTexture(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain =
        Math.sin(y * 0.9 + valueNoise(x * 0.05, y * 0.4, 11) * 9) * 0.5 +
        valueNoise(x * 0.35, y * 3.1, 23) * 0.5;
      const plank = x % 32 < 1.2 ? -1.6 : 0;
      h[y * size + x] = grain * 0.5 + plank;
    }
  }
  return normalFromHeight(h, size, 1.1);
}

/** Corrugated zinc: a hard sine profile across U, plus dents and rust pitting. */
function zincNormalTexture(size: number): THREE.DataTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const corr = Math.sin((x / size) * Math.PI * 2 * 10) * 1.0;
      const dent = valueNoise(x * 0.08, y * 0.08, 71) * 0.35;
      const pit = valueNoise(x * 0.9, y * 0.9, 97) * 0.12;
      h[y * size + x] = corr + dent + pit;
    }
  }
  return normalFromHeight(h, size, 2.0);
}

/**
 * Leaf comb for planters, canopies and thatch: an alpha-cut card of overlapping
 * leaflets. RGB carries a value ramp, alpha the cutout (§5 `alphaTest 0.4`).
 */
function leafTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let a = 0;
      let shadeV = 0;
      for (let k = 0; k < 7; k++) {
        const ang = (k / 6 - 0.5) * 2.1;
        const dx = u - 0.5;
        const dy = v;
        const rx = dx * Math.cos(ang) - dy * Math.sin(ang);
        const ry = dx * Math.sin(ang) + dy * Math.cos(ang);
        if (ry < 0.02 || ry > 0.96) continue;
        const w = 0.085 * Math.sin(Math.PI * Math.min(1, ry / 0.96)) ** 0.7;
        const d = Math.abs(rx) / Math.max(1e-4, w);
        if (d < 1) {
          a = 1;
          shadeV = Math.max(shadeV, 1 - d * 0.55 + (1 - ry) * 0.2);
        }
      }
      const i = (y * size + x) * 4;
      const val = Math.round(clamp01(0.55 + shadeV * 0.45) * 255);
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = a > 0 ? 255 : 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ---------------------------------------------------------------- signage */

export type SignKey =
  | 'ancla'
  | 'carmen'
  | 'frituras'
  | 'pinchos'
  | 'coco'
  | 'marAzul'
  | 'abierto'
  | 'cerveza'
  | 'malta'
  | 'refresco'
  | 'mabi'
  | 'empanadillas'
  | 'musica'
  | 'piraguas'
  | 'pescado'
  | 'mofongo'
  | 'artesanias'
  | 'frutas'
  | 'piraguaCart'
  | 'panaderia'
  | 'floristeria'
  | 'pare'
  | 'noEstacione'
  | 'pinones';

/** One hand-painted board. `bg`/`fg` are CSS colours, `lines` the Spanish text. */
interface SignSpec {
  key: SignKey;
  bg: string;
  fg: string;
  accent?: string;
  lines: string[];
  /** 0 = painted board, 1 = brand board with bands, 2 = enamel road sign */
  style: 0 | 1 | 2;
}

const SIGNS: readonly SignSpec[] = [
  { key: 'ancla', bg: '#123f6b', fg: '#f7efd8', accent: '#e8a93b', lines: ['CHINCHORRO', 'EL ANCLA'], style: 0 },
  { key: 'carmen', bg: '#e8a93b', fg: '#3a2410', accent: '#9e2b25', lines: ['FRITURAS', 'DOÑA CARMEN'], style: 0 },
  { key: 'frituras', bg: '#f4ecd8', fg: '#14523c', accent: '#9e2b25', lines: ['ALCAPURRIAS', 'BACALAÍTOS'], style: 0 },
  { key: 'pinchos', bg: '#9e2b25', fg: '#fbf3dc', accent: '#e8a93b', lines: ['PINCHOS', 'CERVEZA FRÍA'], style: 0 },
  { key: 'coco', bg: '#2fa88a', fg: '#fdf6e3', accent: '#f2c230', lines: ['COCO FRÍO', '$3'], style: 0 },
  { key: 'marAzul', bg: '#1e9baa', fg: '#fdf6e3', accent: '#ffd166', lines: ['KIOSKO', 'MAR AZUL'], style: 0 },
  { key: 'abierto', bg: '#f4ecd8', fg: '#14523c', accent: '#9e2b25', lines: ['ABIERTO'], style: 0 },
  { key: 'cerveza', bg: '#f2c230', fg: '#a52a1e', accent: '#a52a1e', lines: ['CERVEZA', 'CANGREJA'], style: 1 },
  { key: 'malta', bg: '#a52a1e', fg: '#f7e6a8', accent: '#f2c230', lines: ['MALTA', 'SOLIMAR'], style: 1 },
  { key: 'refresco', bg: '#f2c230', fg: '#1d5c3a', accent: '#e0563f', lines: ['REFRESCOS', 'FLAMBOYÁN'], style: 1 },
  { key: 'mabi', bg: '#6b3b1e', fg: '#f6e2b8', accent: '#e8a93b', lines: ['MABÍ', 'LIMBERS'], style: 0 },
  { key: 'empanadillas', bg: '#f4ecd8', fg: '#a52a1e', accent: '#14523c', lines: ['EMPANADILLAS', '$2'], style: 0 },
  { key: 'musica', bg: '#2b1d4a', fg: '#f6e2b8', accent: '#e0563f', lines: ['MÚSICA', 'EN VIVO'], style: 0 },
  { key: 'piraguas', bg: '#e0563f', fg: '#fdf6e3', accent: '#4fbfb1', lines: ['PIRAGUAS'], style: 0 },
  { key: 'pescado', bg: '#f4ecd8', fg: '#123f6b', accent: '#1e9baa', lines: ['PESCADO', 'FRESCO'], style: 0 },
  { key: 'mofongo', bg: '#14523c', fg: '#f6e2b8', accent: '#e8a93b', lines: ['TOSTONES', 'MOFONGO'], style: 0 },
  { key: 'artesanias', bg: '#7a3f8c', fg: '#f7efd8', accent: '#f2c230', lines: ['ARTESANÍAS'], style: 0 },
  { key: 'frutas', bg: '#6fa84a', fg: '#fdf6e3', accent: '#e0563f', lines: ['FRUTAS', 'DEL PAÍS'], style: 0 },
  { key: 'piraguaCart', bg: '#f7f4ec', fg: '#c8102e', accent: '#1e9baa', lines: ['PIRAGUAS', 'COCO · TAMARINDO'], style: 0 },
  { key: 'panaderia', bg: '#e8a93b', fg: '#5a2e1b', accent: '#fbf7ee', lines: ['PANADERÍA', 'REPOSTERÍA'], style: 0 },
  { key: 'floristeria', bg: '#f4ecd8', fg: '#b4327a', accent: '#6fa84a', lines: ['FLORISTERÍA'], style: 0 },
  { key: 'pare', bg: '#c8102e', fg: '#ffffff', lines: ['PARE'], style: 2 },
  { key: 'noEstacione', bg: '#f7f4ec', fg: '#c8102e', lines: ['NO', 'ESTACIONE'], style: 2 },
  { key: 'pinones', bg: '#1d5c3a', fg: '#ffffff', lines: ['PIÑONES', '2 km'], style: 2 },
];

const ATLAS_COLS = 4;
const ATLAS_ROWS = 6;

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** UV rect of a sign in the shared atlas, inset so no cell bleeds into another. */
export function signRect(key: SignKey): UVRect {
  const i = Math.max(0, SIGNS.findIndex((s) => s.key === key));
  const cx = i % ATLAS_COLS;
  const cy = Math.floor(i / ATLAS_COLS);
  const w = 1 / ATLAS_COLS;
  const h = 1 / ATLAS_ROWS;
  const pad = 0.003;
  // canvas row 0 is the top of the image, which is v = 1
  return { u0: cx * w + pad, v0: 1 - (cy + 1) * h + pad, u1: (cx + 1) * w - pad, v1: 1 - cy * h - pad };
}

function drawSign(ctx: Canvas2D, spec: SignSpec, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = spec.bg;
  ctx.fillRect(0, 0, w, h);

  if (spec.style === 1) {
    ctx.fillStyle = spec.accent ?? spec.fg;
    ctx.fillRect(0, 0, w, h * 0.12);
    ctx.fillRect(0, h * 0.88, w, h * 0.12);
  } else if (spec.style === 2) {
    ctx.strokeStyle = spec.fg;
    ctx.lineWidth = Math.max(3, w * 0.035);
    ctx.strokeRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88);
  } else {
    ctx.strokeStyle = spec.accent ?? spec.fg;
    ctx.lineWidth = Math.max(2, w * 0.022);
    ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
  }

  // sun bleaching: a few horizontal wash streaks
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 7; i++) ctx.fillRect(0, ((i * 37) % 100) * h * 0.01, w, h * 0.018);
  ctx.globalAlpha = 1;

  ctx.fillStyle = spec.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const n = spec.lines.length;
  for (let i = 0; i < n; i++) {
    const line = spec.lines[i];
    const fit = Math.min(1, 12 / Math.max(6, line.length));
    const size = Math.max(14, Math.floor(h * (n === 1 ? 0.44 : 0.3) * fit * 1.7));
    ctx.font = `bold ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(line, w * 0.5, h * (n === 1 ? 0.5 : 0.34 + i * 0.32), w * 0.86);
  }
  ctx.restore();
}

/** The whole signage atlas. Falls back to flat colour blocks where no canvas. */
function signAtlasTexture(size: number): THREE.Texture {
  const w = size;
  const h = Math.round((size / ATLAS_COLS) * ATLAS_ROWS);
  const cw = w / ATLAS_COLS;
  const ch = h / ATLAS_ROWS;
  let ctx: Canvas2D | null = null;
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  try {
    canvas = createCanvas(w, h);
    ctx = canvas.getContext('2d') as Canvas2D | null;
  } catch {
    canvas = null;
    ctx = null;
  }
  if (canvas && ctx) {
    ctx.fillStyle = '#f4ecd8';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < SIGNS.length; i++) {
      drawSign(ctx, SIGNS[i], (i % ATLAS_COLS) * cw, Math.floor(i / ATLAS_COLS) * ch, cw, ch);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  }
  // head-less (the offline geometry harness): flat boards per sign colour, so
  // UV placement stays verifiable without a 2D context
  const px = 16;
  const tw = ATLAS_COLS * px;
  const th = ATLAS_ROWS * px;
  const data = new Uint8Array(tw * th * 4);
  const c = new THREE.Color();
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const idx = Math.floor(y / px) * ATLAS_COLS + Math.floor(x / px);
      c.set(SIGNS[Math.min(SIGNS.length - 1, idx)].bg);
      const i = (y * tw + x) * 4;
      data[i] = Math.round(c.r * 255);
      data[i + 1] = Math.round(c.g * 255);
      data[i + 2] = Math.round(c.b * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ========================================================================== *
 *  the shared material kit
 * ========================================================================== */

const KIT_CACHE = new Map<QualityTier, PropKit>();

/**
 * Seven materials and four textures, shared by every layer in this module set.
 * Refcounted: `acquire` on build, `release` on dispose, freed when the last
 * holder lets go.
 */
export class PropKit {
  readonly quality: QualityTier;

  readonly paint: THREE.MeshStandardMaterial;
  readonly wood: THREE.MeshStandardMaterial;
  readonly zinc: THREE.MeshStandardMaterial;
  readonly cloth: THREE.MeshStandardMaterial;
  readonly sign: THREE.MeshStandardMaterial;
  readonly foliage: THREE.MeshStandardMaterial;
  readonly glow: THREE.MeshStandardMaterial;

  readonly uniforms: KitUniforms = {
    uKitTime: { value: 0 },
    uKitWind: { value: new THREE.Vector2(0.86, -0.51) },
    uKitGust: { value: 0.22 },
    uKitNight: { value: 0 },
  };

  private textures: THREE.Texture[] = [];
  private refs = 0;

  private constructor(quality: QualityTier) {
    this.quality = quality;
    const detail = quality === 'low' ? 64 : 128;

    const woodN = woodNormalTexture(detail);
    const zincN = zincNormalTexture(detail);
    const leaf = leafTexture(detail);
    const atlas = signAtlasTexture(quality === 'low' ? 512 : 1024);
    this.textures.push(woodN, zincN, leaf, atlas);

    this.paint = new THREE.MeshStandardMaterial({
      name: 'loco/kitPaint',
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.04,
      envMapIntensity: 0.8,
    });

    this.wood = new THREE.MeshStandardMaterial({
      name: 'loco/kitWood',
      vertexColors: true,
      normalMap: woodN,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.86,
      metalness: 0,
      envMapIntensity: 0.7,
    });

    this.zinc = new THREE.MeshStandardMaterial({
      name: 'loco/kitZinc',
      vertexColors: true,
      normalMap: zincN,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.58,
      metalness: 0.42,
      envMapIntensity: 1.0,
    });

    this.cloth = new THREE.MeshStandardMaterial({
      name: 'loco/kitCloth',
      vertexColors: true,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.65,
    });
    this.patchWave(this.cloth, 'loco/kit-cloth-v1');

    this.sign = new THREE.MeshStandardMaterial({
      name: 'loco/kitSign',
      map: atlas,
      roughness: 0.72,
      metalness: 0,
      envMapIntensity: 0.7,
    });

    this.foliage = new THREE.MeshStandardMaterial({
      name: 'loco/kitFoliage',
      map: leaf,
      vertexColors: true,
      roughness: 0.64,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.4,
      envMapIntensity: 0.6,
    });
    this.patchWave(this.foliage, 'loco/kit-foliage-v1');

    this.glow = new THREE.MeshStandardMaterial({
      name: 'loco/kitGlow',
      vertexColors: true,
      roughness: 0.5,
      metalness: 0,
      emissive: 0x000000,
      envMapIntensity: 0.5,
    });
    this.patchGlow(this.glow);
  }

  /** Shared per-quality instance. Every holder must `release()` on dispose. */
  static acquire(quality: QualityTier): PropKit {
    let kit = KIT_CACHE.get(quality);
    if (!kit) {
      kit = new PropKit(quality);
      KIT_CACHE.set(quality, kit);
    }
    kit.refs++;
    return kit;
  }

  private patchWave(mat: THREE.MeshStandardMaterial, key: string): void {
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uKitTime = u.uKitTime;
      shader.uniforms.uKitWind = u.uKitWind;
      shader.uniforms.uKitGust = u.uKitGust;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WAVE_PARS}`)
        .replace('#include <begin_vertex>', WAVE_BEGIN);
    };
    mat.customProgramCacheKey = () => key;
  }

  private patchGlow(mat: THREE.MeshStandardMaterial): void {
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uKitNight = u.uKitNight;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uKitNight;')
        .replace('#include <emissivemap_fragment>', GLOW_FRAG);
    };
    mat.customProgramCacheKey = () => 'loco/kit-glow-v1';
  }

  /** Advance wind; `night` 0..1 lifts every emissive prop. */
  update(dt: number, night: number, wind = 0.22): void {
    this.uniforms.uKitTime.value += dt;
    this.uniforms.uKitNight.value = night;
    this.uniforms.uKitGust.value = wind;
  }

  release(): void {
    this.refs--;
    if (this.refs > 0) return;
    KIT_CACHE.delete(this.quality);
    for (const m of [this.paint, this.wood, this.zinc, this.cloth, this.sign, this.foliage, this.glow]) {
      m.dispose();
    }
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}

/** 0 by day, 1 deep in the night — the emissive ramp every layer shares. */
export function nightFactor(hours: number): number {
  if (hours >= 19.4 || hours <= 5.4) return 1;
  if (hours > 17.6 && hours < 19.4) return (hours - 17.6) / 1.8;
  if (hours > 5.4 && hours < 6.9) return 1 - (hours - 5.4) / 1.5;
  return 0;
}

/** Darken an sRGB hex without leaving the palette's hue. */
export function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/* ========================================================================== *
 *  builder helpers
 * ========================================================================== */

const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _col = new THREE.Color();

/** The six builders a dressed scene merges into, one mesh per material. */
export interface KitBuilders {
  /** solid painted props — `PropKit.paint` */
  paint: GeoBuilder;
  /** timber — `PropKit.wood` */
  wood: GeoBuilder;
  /** corrugated metal — `PropKit.zinc` */
  zinc: GeoBuilder;
  /** cloth and flags, aux `aWave` enabled — `PropKit.cloth` */
  cloth: GeoBuilder;
  /** atlas-mapped boards — `PropKit.sign` */
  sign: GeoBuilder;
  /** emissive props and interior glow — `PropKit.glow` */
  glow: GeoBuilder;
}

export function makeBuilders(): KitBuilders {
  return {
    paint: new GeoBuilder(),
    wood: new GeoBuilder(),
    zinc: new GeoBuilder(),
    cloth: new GeoBuilder().enableAux(),
    sign: new GeoBuilder(),
    glow: new GeoBuilder(),
  };
}

/** Quad with explicit UVs — the only way to hit a rect in the sign atlas. */
export function quadUV(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  rect: UVRect,
  color = 0xffffff,
  wave?: THREE.Vector3,
): void {
  _e1.subVectors(b, a);
  _e2.subVectors(d, a);
  _nrm.crossVectors(_e1, _e2);
  if (_nrm.lengthSq() < 1e-12) return;
  _nrm.normalize();
  _col.setHex(color, THREE.SRGBColorSpace);
  const wx = wave?.x ?? 0;
  const wy = wave?.y ?? 0;
  const wz = wave?.z ?? 0;
  const n = _nrm;
  const r = _col.r;
  const gr = _col.g;
  const bl = _col.b;
  const i0 = g.vertex(a.x, a.y, a.z, n.x, n.y, n.z, rect.u0, rect.v0, r, gr, bl, wx, wy, wz);
  const i1 = g.vertex(b.x, b.y, b.z, n.x, n.y, n.z, rect.u1, rect.v0, r, gr, bl, wx, wy, wz);
  const i2 = g.vertex(c.x, c.y, c.z, n.x, n.y, n.z, rect.u1, rect.v1, r, gr, bl, wx, wy, wz);
  const i3 = g.vertex(d.x, d.y, d.z, n.x, n.y, n.z, rect.u0, rect.v1, r, gr, bl, wx, wy, wz);
  g.quadIdx(i0, i1, i2, i3);
}

const FULL_UV: UVRect = { u0: 0, v0: 0, u1: 1, v1: 1 };

/** Two-sided card, so cloth, leaves and boards read from either side. */
export function card(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  color: number,
  wave?: THREE.Vector3,
  rect: UVRect = FULL_UV,
): void {
  quadUV(g, a, b, c, d, rect, color, wave);
  quadUV(g, d, c, b, a, { u0: rect.u1, v0: rect.v1, u1: rect.u0, v1: rect.v0 }, shade(color, 0.74), wave);
}

/** A local frame: yaw about Y, then translate. Keeps every prop's code flat. */
export class Placer {
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private cs = 1;
  private sn = 0;

  set(x: number, y: number, z: number, yaw: number): this {
    this.cx = x;
    this.cy = y;
    this.cz = z;
    this.cs = Math.cos(yaw);
    this.sn = Math.sin(yaw);
    return this;
  }

  /** local (right, up, forward) → world */
  to(lx: number, ly: number, lz: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(
      this.cx + lx * this.cs + lz * this.sn,
      this.cy + ly,
      this.cz - lx * this.sn + lz * this.cs,
    );
  }

  /** local → world, as a fresh vector (for the quad helpers, which retain) */
  at(lx: number, ly: number, lz: number): THREE.Vector3 {
    return this.to(lx, ly, lz, new THREE.Vector3());
  }
}

/** A square-section strut between two world points — braces, limbs, guys. */
export function strut(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  color: number,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const f = new THREE.Vector3(sy * cp, sp, cy * cp);
  const rt = new THREE.Vector3(cy, 0, -sy);
  const up = new THREE.Vector3(-sy * sp, cp, -cy * sp);
  const at = (t: number, s: number, u: number): THREE.Vector3 =>
    new THREE.Vector3(
      a.x + f.x * t * len + rt.x * s + up.x * u,
      a.y + f.y * t * len + rt.y * s + up.y * u,
      a.z + f.z * t * len + rt.z * s + up.z * u,
    );
  const corners: Array<[number, number]> = [
    [-r, -r],
    [r, -r],
    [r, r],
    [-r, r],
  ];
  for (let i = 0; i < 4; i++) {
    const [s0, u0] = corners[i];
    const [s1, u1] = corners[(i + 1) % 4];
    g.quad(at(0, s0, u0), at(1, s0, u0), at(1, s1, u1), at(0, s1, u1), color, 0.8);
  }
}

/** Prism around the X axis — wheels, drums lying down, rolled canvas. */
export function prismX(
  g: GeoBuilder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  halfLen: number,
  sides: number,
  color: number,
): void {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const y0 = cy + Math.cos(a0) * radius;
    const z0 = cz + Math.sin(a0) * radius;
    const y1 = cy + Math.cos(a1) * radius;
    const z1 = cz + Math.sin(a1) * radius;
    g.quad(
      new THREE.Vector3(cx - halfLen, y0, z0),
      new THREE.Vector3(cx + halfLen, y0, z0),
      new THREE.Vector3(cx + halfLen, y1, z1),
      new THREE.Vector3(cx - halfLen, y1, z1),
      color,
      0.6,
    );
    // end caps as fans from the axis
    g.quad(
      new THREE.Vector3(cx + halfLen, cy, cz),
      new THREE.Vector3(cx + halfLen, y0, z0),
      new THREE.Vector3(cx + halfLen, y1, z1),
      new THREE.Vector3(cx + halfLen, y1, z1),
      shade(color, 0.85),
      0.6,
    );
    g.quad(
      new THREE.Vector3(cx - halfLen, cy, cz),
      new THREE.Vector3(cx - halfLen, y1, z1),
      new THREE.Vector3(cx - halfLen, y0, z0),
      new THREE.Vector3(cx - halfLen, y0, z0),
      shade(color, 0.85),
      0.6,
    );
  }
}

/** Placement record for {@link instanced}. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale?: number;
  scaleY?: number;
  tint?: number;
}

/** Build one `InstancedMesh` from a geometry and a placement list. */
export function instanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  list: readonly Placement[],
  name: string,
  tinted = false,
): THREE.InstancedMesh | null {
  if (list.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  mesh.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    p.set(it.x, it.y, it.z);
    q.setFromAxisAngle(up, it.yaw);
    const sc = it.scale ?? 1;
    s.set(sc, it.scaleY ?? sc, sc);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (tinted) {
      _col.setHex(it.tint ?? 0xffffff, THREE.SRGBColorSpace);
      mesh.setColorAt(i, _col);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  // the wind shader can push a tip past the instance bounds; pad, never disable
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 2;
  return mesh;
}

function finish(g: GeoBuilder, aux = false): THREE.BufferGeometry {
  return g.build(aux ? 'aWave' : 'aKit') ?? new THREE.BufferGeometry();
}

export function triangleCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (idx) return idx.count / 3;
  const pos = geo.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/* ========================================================================== *
 *  the chinchorro
 * ========================================================================== */

export interface ShackSpec {
  x: number;
  y: number;
  z: number;
  /** yaw: the serving counter faces local +Z */
  yaw: number;
  width: number;
  depth: number;
  height: number;
  wall: number;
  trim: number;
  /** the painted board over the counter */
  sign: SignKey;
  /** the brand / menu board on the flank */
  board: SignKey;
  flag: boolean;
  speaker: boolean;
  seed: number;
}

/**
 * One roadside food shack: timber frame on stilts, board walls, a corrugated
 * zinc roof with a deep front overhang, an open serving counter with its
 * shutter propped up under the eave, a hand-painted fascia sign, a brand board
 * on the flank, a flue over the fryer, and the crates, coolers and gas bottles
 * that live under the counter.
 *
 * Authored into the shared {@link KitBuilders}, so a whole cluster of shacks
 * merges into one mesh per material.
 */
export function buildChinchorro(kb: KitBuilders, spec: ShackSpec): void {
  const rng = new RNG(spec.seed >>> 0);
  const { wood, zinc, sign, glow, cloth } = kb;
  const w = spec.width;
  const d = spec.depth;
  const h = spec.height;
  const hw = w * 0.5;
  const hd = d * 0.5;
  const post = 0.075;
  const p = new Placer().set(spec.x, spec.y, spec.z, spec.yaw);

  const floorY = 0.2;
  const sill = floorY + 0.94;
  const head = floorY + 2.06;
  const wallTop = floorY + h;

  /* --- stilts and deck: these sit on sand, so they are propped up on blocks - */
  for (const sx of [-hw + post, hw - post]) {
    for (const sz of [-hd + post, hd - post]) {
      const c = p.to(sx, 0, sz);
      wood.box(c.x, c.y + floorY * 0.5, c.z, post * 1.4, floorY * 0.5 + 0.02, post * 1.4, KIT.woodDark, spec.yaw);
    }
  }
  {
    const c = p.to(0, floorY, 0);
    wood.box(c.x, c.y - 0.035, c.z, hw, 0.035, hd, KIT.woodPale, spec.yaw);
  }

  /* --- corner posts --- */
  for (const sx of [-hw + post, hw - post]) {
    for (const sz of [-hd + post, hd - post]) {
      const c = p.to(sx, floorY, sz);
      wood.box(c.x, c.y + h * 0.5, c.z, post, h * 0.5, post, KIT.post, spec.yaw);
    }
  }

  /* --- board walls --- */
  const wall = spec.wall;
  // back
  wood.quad(p.at(-hw, floorY, -hd), p.at(-hw, wallTop, -hd), p.at(hw, wallTop, -hd), p.at(hw, floorY, -hd), wall, 0.9);
  wood.quad(p.at(hw, floorY, -hd), p.at(hw, wallTop, -hd), p.at(-hw, wallTop, -hd), p.at(-hw, floorY, -hd), shade(wall, 0.7), 0.9);
  // flanks
  for (const sx of [-hw, hw]) {
    const a = p.at(sx, floorY, -hd);
    const b = p.at(sx, floorY, hd);
    const c = p.at(sx, wallTop, hd);
    const e = p.at(sx, wallTop, -hd);
    wood.quad(a.clone(), b.clone(), c.clone(), e.clone(), sx > 0 ? wall : shade(wall, 0.78), 0.9);
    wood.quad(e, c, b, a, sx > 0 ? shade(wall, 0.7) : wall, 0.9);
  }
  // front apron below the counter, and the fascia above the opening
  wood.quad(p.at(-hw, floorY, hd), p.at(hw, floorY, hd), p.at(hw, sill, hd), p.at(-hw, sill, hd), wall, 0.9);
  wood.quad(p.at(-hw, sill, hd), p.at(hw, sill, hd), p.at(hw, floorY, hd), p.at(-hw, floorY, hd), shade(wall, 0.7), 0.9);
  wood.quad(p.at(-hw, head, hd), p.at(hw, head, hd), p.at(hw, wallTop, hd), p.at(-hw, wallTop, hd), spec.trim, 0.9);
  wood.quad(p.at(-hw, wallTop, hd), p.at(hw, wallTop, hd), p.at(hw, head, hd), p.at(-hw, head, hd), shade(spec.trim, 0.7), 0.9);

  /* --- the interior: a warm card deep in the opening reads as a lit kitchen - */
  glow.quad(
    p.at(-hw + 0.08, sill - 0.55, -hd + 0.1),
    p.at(hw - 0.08, sill - 0.55, -hd + 0.1),
    p.at(hw - 0.08, head - 0.08, -hd + 0.1),
    p.at(-hw + 0.08, head - 0.08, -hd + 0.1),
    0xffb765,
    0.6,
  );
  // a steel fryer on the counter line, half seen through the opening
  {
    const c = p.to(rng.range(-hw * 0.4, hw * 0.4), sill, -hd * 0.2);
    wood.box(c.x, c.y + 0.14, c.z, 0.28, 0.14, 0.2, KIT.steel, spec.yaw);
  }

  /* --- counter shelf --- */
  {
    const c = p.to(0, sill, hd + 0.16);
    wood.box(c.x, c.y + 0.03, c.z, hw + 0.07, 0.045, 0.27, KIT.woodPale, spec.yaw);
    // strip light under the eave, throwing onto the counter and the customers
    glow.quad(
      p.at(-hw * 0.9, head + 0.02, hd + 0.5),
      p.at(hw * 0.9, head + 0.02, hd + 0.5),
      p.at(hw * 0.9, head + 0.02, hd + 0.02),
      p.at(-hw * 0.9, head + 0.02, hd + 0.02),
      0xffcf8a,
      0.55,
    );
    for (const sx of [-hw * 0.62, hw * 0.62]) {
      const br = p.to(sx, sill - 0.22, hd + 0.06);
      wood.box(br.x, br.y, br.z, 0.04, 0.2, 0.05, KIT.woodDark, spec.yaw);
    }
  }

  /* --- shutter, propped up under the eave on two struts --- */
  {
    const lift = 0.3;
    const reach = 1.15;
    const y0 = wallTop;
    wood.quad(
      p.at(-hw, y0, hd),
      p.at(hw, y0, hd),
      p.at(hw, y0 + lift, hd + reach),
      p.at(-hw, y0 + lift, hd + reach),
      spec.trim,
      0.8,
    );
    wood.quad(
      p.at(-hw, y0 + lift, hd + reach),
      p.at(hw, y0 + lift, hd + reach),
      p.at(hw, y0, hd),
      p.at(-hw, y0, hd),
      shade(spec.trim, 0.62),
      0.8,
    );
    for (const sx of [-hw + 0.22, hw - 0.22]) {
      strut(wood, p.at(sx, y0 + lift * 0.95, hd + reach * 0.92), p.at(sx, head + 0.06, hd + 0.06), 0.03, KIT.woodDark);
    }
  }

  /* --- corrugated zinc roof, low pitch, deep overhang to the front --- */
  const eaveF = 0.9;
  const eaveS = 0.3;
  const ridgeY = wallTop + 0.5;
  const frontY = wallTop + 0.1;
  {
    const zincCol = rng.bool(0.45) ? KIT.zincOld : KIT.zinc;
    const a = p.at(-hw - eaveS, ridgeY, -hd - eaveS);
    const b = p.at(hw + eaveS, ridgeY, -hd - eaveS);
    const c = p.at(hw + eaveS, frontY, hd + eaveF);
    const e = p.at(-hw - eaveS, frontY, hd + eaveF);
    zinc.quad(a.clone(), b.clone(), c.clone(), e.clone(), zincCol, 0.55);
    zinc.quad(e.clone(), c.clone(), b.clone(), a.clone(), shade(zincCol, 0.5), 0.55);
    // rusted, slightly buckled leading edge
    zinc.quad(
      e.clone(),
      c.clone(),
      p.at(hw + eaveS, frontY - 0.07, hd + eaveF),
      p.at(-hw - eaveS, frontY - 0.07, hd + eaveF),
      KIT.rust,
      0.6,
    );
    // rafter tails under the overhang
    for (const sx of [-hw * 0.6, 0, hw * 0.6]) {
      strut(wood, p.at(sx, wallTop - 0.02, hd - 0.05), p.at(sx, frontY - 0.09, hd + eaveF - 0.05), 0.035, KIT.woodDark);
    }
  }

  /* --- flue over the fryer, with a rain cap --- */
  {
    const c = p.to(rng.range(-hw * 0.5, hw * 0.5), wallTop + 0.15, -hd * 0.35);
    zinc.cylinder(c.x, c.y, c.z, 0.09, 0.08, 0.9, 7, KIT.zincOld);
    zinc.cylinder(c.x, c.y + 0.95, c.z, 0.17, 0.05, 0.12, 7, KIT.zincOld);
  }

  /* --- the fascia sign over the counter --- */
  {
    const r = signRect(spec.sign);
    const y0 = head + 0.1;
    const y1 = Math.min(wallTop - 0.06, y0 + 0.68);
    quadUV(
      sign,
      p.at(-hw * 0.94, y0, hd + 0.035),
      p.at(hw * 0.94, y0, hd + 0.035),
      p.at(hw * 0.94, y1, hd + 0.035),
      p.at(-hw * 0.94, y1, hd + 0.035),
      r,
    );
  }

  /* --- brand board on the flank --- */
  {
    const r = signRect(spec.board);
    const sx = hw + 0.035;
    quadUV(
      sign,
      p.at(sx, floorY + 0.6, hd * 0.66),
      p.at(sx, floorY + 0.6, -hd * 0.55),
      p.at(sx, floorY + 1.78, -hd * 0.55),
      p.at(sx, floorY + 1.78, hd * 0.66),
      r,
    );
  }

  /* --- clutter: crates, a gas bottle, a stacked cooler --- */
  {
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const c = p.to(rng.range(-hw + 0.3, hw - 0.3), 0, hd + rng.range(0.55, 1.35));
      const ch = rng.range(0.22, 0.34);
      wood.box(c.x, c.y + ch, c.z, 0.26, ch, 0.2, rng.bool(0.5) ? KIT.woodRaw : KIT.woodPale, spec.yaw + rng.range(-0.6, 0.6));
    }
    const g = p.to(hw - 0.4, 0, hd + 0.66);
    wood.cylinder(g.x, g.y, g.z, 0.16, 0.15, 0.58, 8, KIT.propane);
    wood.cylinder(g.x, g.y + 0.58, g.z, 0.06, 0.05, 0.09, 6, KIT.steel);
  }

  /* --- the flag on the ridge (§7.4) --- */
  if (spec.flag) {
    const c = p.to(hw - 0.32, ridgeY, -hd + 0.32);
    wood.cylinder(c.x, c.y, c.z, 0.035, 0.026, 2.5, 6, KIT.woodPale);
    puertoRicanFlag(cloth, c.x, c.y + 2.42, c.z, 0.9, spec.yaw + 0.35, rng.next());
  }

  /* --- speaker bolted to the front post --- */
  if (spec.speaker) {
    const c = p.to(-hw + 0.14, floorY + 2.0, hd + 0.16);
    wood.box(c.x, c.y, c.z, 0.15, 0.22, 0.13, KIT.black, spec.yaw);
    const f = p.to(-hw + 0.14, floorY + 1.94, hd + 0.29);
    wood.cylinder(f.x, f.y, f.z, 0.085, 0.085, 0.012, 8, 0x2a2d31);
  }
}

/**
 * The standard Puerto Rican flag (§7.4): five stripes, a blue triangle at the
 * hoist, one white star. A rippling card that catches the shared wind shader —
 * always authored into a builder with the `aWave` aux channel enabled.
 */
export function puertoRicanFlag(
  g: GeoBuilder,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  phase: number,
): void {
  const w = 1.5 * scale;
  const h = 1.0 * scale;
  const cols = 6;
  const rows = 5;
  const p = new Placer().set(x, y, z, yaw);
  const wave = new THREE.Vector3();
  const stripe = [KIT.flagRed, KIT.flagWhite, KIT.flagRed, KIT.flagWhite, KIT.flagRed];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u0 = c / cols;
      const u1 = (c + 1) / cols;
      const t0 = r / rows;
      const t1 = (r + 1) / rows;
      const um = (u0 + u1) * 0.5;
      const tm = (t0 + t1) * 0.5;
      let col: number = stripe[r];
      // the hoist triangle: the flag's leading third, tapering to the fly
      if (um < 0.35 * (1 - Math.abs(tm - 0.5) * 2) + 0.001) col = KIT.flagBlue;
      if (um < 0.12 && Math.abs(tm - 0.5) < 0.11) col = KIT.flagWhite; // the star
      wave.set(um * um * 1.15, phase, um * 0.5);
      card(
        g,
        p.at(u0 * w, -t1 * h, 0),
        p.at(u1 * w, -t1 * h, 0),
        p.at(u1 * w, -t0 * h, 0),
        p.at(u0 * w, -t0 * h, 0),
        col,
        wave,
      );
    }
  }
}

/* ========================================================================== *
 *  instanced prop geometries
 * ========================================================================== */

/** Red-and-white beach umbrella: eight panels, a hem valance, a timber mast. */
export function buildUmbrella(radius = 1.6, height = 2.4): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const seg = 8;
  const wave = new THREE.Vector3();
  g.cylinder(0, 0, 0, 0.045, 0.032, height, 6, KIT.woodPale, true, new THREE.Vector3(0, 0.3, 0));
  const rim = height * 0.76;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const col = i % 2 === 0 ? KIT.umbrellaRed : KIT.umbrellaWhite;
    const apex = new THREE.Vector3(0, height, 0);
    const p0 = new THREE.Vector3(Math.cos(a0) * radius, rim, Math.sin(a0) * radius);
    const p1 = new THREE.Vector3(Math.cos(a1) * radius, rim, Math.sin(a1) * radius);
    const mid = new THREE.Vector3(
      Math.cos((a0 + a1) * 0.5) * radius * 1.05,
      rim - 0.1,
      Math.sin((a0 + a1) * 0.5) * radius * 1.05,
    );
    wave.set(0, 0.3, 0.5);
    g.quad(apex.clone(), p0.clone(), mid.clone(), p1.clone(), col, 0.6, wave);
    g.quad(p1.clone(), mid.clone(), p0.clone(), apex.clone(), shade(col, 0.68), 0.6, wave);
    wave.set(0.05, 0.3, 0.8);
    g.quad(p0.clone(), p0.clone().setY(rim - 0.27), p1.clone().setY(rim - 0.27), p1.clone(), shade(col, 0.94), 0.6, wave);
    g.quad(p1.clone(), p1.clone().setY(rim - 0.27), p0.clone().setY(rim - 0.27), p0.clone(), shade(col, 0.66), 0.6, wave);
  }
  return finish(g, true);
}

/** Stacking plastic chair — the white monobloc that furnishes the whole island. */
export function buildPlasticChair(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const c = KIT.plasticWhite;
  g.box(0, 0.44, 0, 0.24, 0.02, 0.24, c);
  for (const sx of [-0.2, 0.2]) {
    for (const sz of [-0.2, 0.2]) g.box(sx, 0.22, sz, 0.022, 0.22, 0.022, shade(c, 0.9));
  }
  g.box(0, 0.72, -0.22, 0.22, 0.26, 0.025, c);
  g.box(0, 0.59, -0.22, 0.22, 0.02, 0.03, shade(c, 0.86));
  return finish(g);
}

/** Round plastic table with a centre boss for the umbrella mast. */
export function buildPlasticTable(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.cylinder(0, 0.7, 0, 0.42, 0.42, 0.045, 12, KIT.plasticWhite);
  g.cylinder(0, 0, 0, 0.05, 0.04, 0.7, 8, shade(KIT.plasticWhite, 0.9));
  g.cylinder(0, 0.01, 0, 0.22, 0.2, 0.02, 8, shade(KIT.plasticWhite, 0.82));
  return finish(g);
}

/** Oil-drum standing table — the bar of every chinchorro on the island. */
export function buildBarrelTable(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.cylinder(0, 0, 0, 0.29, 0.29, 0.88, 12, KIT.plasticRed);
  g.cylinder(0, 0.3, 0, 0.3, 0.3, 0.06, 12, shade(KIT.plasticRed, 0.78));
  g.cylinder(0, 0.6, 0, 0.3, 0.3, 0.06, 12, shade(KIT.plasticRed, 0.78));
  g.cylinder(0, 0.88, 0, 0.34, 0.34, 0.035, 12, KIT.woodPale);
  return finish(g);
}

/** Timber picnic bench, sun-bleached. */
export function buildPicnicBench(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0.74, 0, 0.85, 0.03, 0.36, KIT.woodPale);
  for (const sz of [-0.62, 0.62]) g.box(0, 0.44, sz, 0.85, 0.025, 0.14, KIT.woodRaw);
  for (const sx of [-0.72, 0.72]) {
    g.box(sx, 0.36, 0, 0.05, 0.36, 0.05, KIT.woodDark);
    g.box(sx, 0.44, 0, 0.04, 0.02, 0.66, KIT.woodDark);
  }
  return finish(g);
}

/** Picnic cooler, lid in a contrasting colour, stacked two high by the shacks. */
export function buildCooler(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0.22, 0, 0.34, 0.22, 0.24, KIT.coolerBody);
  g.box(0, 0.47, 0, 0.35, 0.04, 0.25, KIT.coolerLid);
  g.box(0, 0.3, 0.245, 0.1, 0.02, 0.013, KIT.steelDark);
  return finish(g);
}

/** Yellow-painted concrete bollard, the road edge of every beach on the island. */
export function buildBollard(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.cylinder(0, 0, 0, 0.16, 0.13, 0.62, 8, KIT.bollard);
  g.cylinder(0, 0.62, 0, 0.13, 0.11, 0.1, 8, KIT.bollardTop);
  return finish(g);
}

/** Dark volcanic surf rock — a deformed icosphere, three make a headland. */
export function buildRock(rng: RNG): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // quantised jitter so shared vertices of a face move together
    const k = 0.72 + valueNoise(x * 2.4 + 8, z * 2.4 + 3, 17) * 0.55;
    pos.setXYZ(i, x * k, Math.max(-0.1, y * k * 0.72), z * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const up = Math.max(0, nrm.getY(i));
    c.setHex(shade(0x4e535a, 0.72 + up * 0.55 + rng.range(-0.05, 0.05)), THREE.SRGBColorSpace);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A parked car: a sun-faded modern Caribbean hatchback (§7.2 — emphatically
 * *not* a 1950s American classic). Body colour rides on `instanceColor`.
 */
export function buildParkedCar(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const hl = 2.15;
  const hw = 0.9;
  g.box(0, 0.72, 0, hw, 0.28, hl, 0xffffff);
  g.box(0, 0.99, -hl * 0.5, hw * 0.95, 0.05, hl * 0.45, 0xf4f4f4);
  g.box(0, 0.99, hl * 0.58, hw * 0.95, 0.05, hl * 0.38, 0xf4f4f4);
  g.box(0, 1.22, 0.04, hw * 0.86, 0.26, hl * 0.5, 0xeaeaea);
  g.box(0, 1.24, 0.04, hw * 0.87, 0.17, hl * 0.5 + 0.006, KIT.carGlass);
  for (const sx of [-hw + 0.02, hw - 0.02]) {
    for (const sz of [-hl * 0.6, hl * 0.6]) prismX(g, sx, 0.31, sz, 0.31, 0.09, 8, KIT.tyre);
  }
  g.box(-hw * 0.62, 0.92, hl - 0.02, 0.18, 0.06, 0.02, 0xf6f2e2);
  g.box(hw * 0.62, 0.92, hl - 0.02, 0.18, 0.06, 0.02, 0xf6f2e2);
  g.box(-hw * 0.62, 0.94, -hl + 0.02, 0.16, 0.07, 0.02, 0xc0392b);
  g.box(hw * 0.62, 0.94, -hl + 0.02, 0.16, 0.07, 0.02, 0xc0392b);
  return finish(g);
}

/** Vertical banner on a bamboo pole — the flapping ad flag outside every kiosk. */
export function buildBannerFlag(key: SignKey, height = 3.3): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const r = signRect(key);
  g.cylinder(0, 0, 0, 0.05, 0.035, height, 6, KIT.woodPale, true, new THREE.Vector3(0, 0.11, 0));
  const w = 0.66;
  const h = 2.2;
  const rows = 5;
  const wave = new THREE.Vector3();
  const dv = r.v1 - r.v0;
  for (let i = 0; i < rows; i++) {
    const t0 = i / rows;
    const t1 = (i + 1) / rows;
    const y0 = height - 0.18 - t0 * h;
    const y1 = height - 0.18 - t1 * h;
    wave.set(0.14 + t1 * 0.16, 0.37, 0.35 + t1 * 0.45);
    card(
      g,
      new THREE.Vector3(0.05, y1, 0),
      new THREE.Vector3(0.05 + w, y1, 0),
      new THREE.Vector3(0.05 + w, y0, 0),
      new THREE.Vector3(0.05, y0, 0),
      0xffffff,
      wave,
      { u0: r.u0, v0: r.v1 - dv * t1, u1: r.u1, v1: r.v1 - dv * t0 },
    );
  }
  return finish(g, true);
}

/** Potted plant for pavements and doorways: terracotta pot + a fan of leaves. */
export function buildPottedPlant(rng: RNG, big = false): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const s = big ? 1.5 : 1;
  const soilAux = new THREE.Vector3(0, 0.5, 0);
  g.cylinder(0, 0, 0, 0.2 * s, 0.26 * s, 0.34 * s, 9, KIT.terracotta, false, soilAux);
  g.cylinder(0, 0.32 * s, 0, 0.27 * s, 0.27 * s, 0.05 * s, 9, shade(KIT.terracotta, 0.85), true, soilAux);
  g.cylinder(0, 0.3 * s, 0, 0.22 * s, 0.22 * s, 0.03 * s, 8, KIT.soil, true, soilAux);
  const blades = big ? 9 : 6;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < blades; i++) {
    const ang = (i / blades) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const lean = rng.range(0.18, 0.5);
    const len = rng.range(0.55, 0.95) * s;
    const wdt = rng.range(0.16, 0.26) * s;
    const y0 = 0.34 * s;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    wave.set(0.22, phase, 0.28);
    card(
      g,
      new THREE.Vector3(-dz * wdt * 0.5, y0, dx * wdt * 0.5),
      new THREE.Vector3(dz * wdt * 0.5, y0, -dx * wdt * 0.5),
      new THREE.Vector3(dx * len * lean + dz * wdt * 0.5, y0 + len, dz * len * lean - dx * wdt * 0.5),
      new THREE.Vector3(dx * len * lean - dz * wdt * 0.5, y0 + len, dz * len * lean + dx * wdt * 0.5),
      [KIT.leafDark, KIT.leafMid, KIT.leafLit][i % 3],
      wave,
    );
  }
  return finish(g, true);
}

/**
 * Flowering shrub cluster — bougainvillea and hibiscus, the magenta and coral
 * §3.2 wants doing the work no building can do.
 */
export function buildBloomBush(rng: RNG, bloom: number): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const cards = 7;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < cards; i++) {
    const ang = (i / cards) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rad = rng.range(0.15, 0.55);
    const h = rng.range(0.7, 1.35);
    const w = rng.range(0.55, 0.95);
    const cx = Math.cos(ang) * rad;
    const cz = Math.sin(ang) * rad;
    const dx = Math.cos(ang + 1.57);
    const dz = Math.sin(ang + 1.57);
    wave.set(0.15, phase, 0.2);
    card(
      g,
      new THREE.Vector3(cx - dx * w * 0.5, 0.05, cz - dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, 0.05, cz + dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, 0.05 + h, cz + dz * w * 0.5),
      new THREE.Vector3(cx - dx * w * 0.5, 0.05 + h, cz - dz * w * 0.5),
      i % 3 === 0 ? bloom : i % 3 === 1 ? KIT.leafMid : KIT.leafDark,
      wave,
    );
  }
  return finish(g, true);
}

/** Dense coastal thicket clump — sea grape and beach shrub, behind the shacks. */
export function buildThicket(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const cards = 6;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < cards; i++) {
    const ang = (i / cards) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const rad = rng.range(0.2, 1.1);
    const h = rng.range(1.3, 2.6);
    const w = rng.range(1.5, 2.6);
    const cx = Math.cos(ang) * rad;
    const cz = Math.sin(ang) * rad;
    const dx = Math.cos(ang + 1.57);
    const dz = Math.sin(ang + 1.57);
    wave.set(0.1, phase, 0.14);
    card(
      g,
      new THREE.Vector3(cx - dx * w * 0.5, 0, cz - dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, 0, cz + dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, h, cz + dz * w * 0.5),
      new THREE.Vector3(cx - dx * w * 0.5, h, cz - dz * w * 0.5),
      [0x2f5e29, 0x3d6b2c, 0x4c7a34][i % 3],
      wave,
    );
  }
  return finish(g, true);
}

/* ========================================================================== *
 *  coastal understorey
 * ========================================================================== */

/**
 * **Sea grape** (*Coccoloba uvifera*) — the plant that actually holds a Puerto
 * Rican beach together and the one that makes PR-187 look like PR-187 rather
 * than a road across a lawn.
 *
 * Shape language matters more than leaf count here: sea grape is *wide and
 * low*, a flattened dome that spreads further than it rises, so it reads as a
 * horizontal green mass under the vertical palm trunks. Two horizontal leaf
 * planes through the crown stop it going hollow when the camera lifts over a
 * crest, and the oldest leaves take the rust-red the species is known for.
 */
export function buildSeaGrape(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const cards = 8;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  const spread = rng.range(1.5, 2.4);
  const top = rng.range(1.1, 1.9);
  const leaf = [0x4c7a34, 0x3d6b2c, 0x6b8f36, 0x8a5f30] as const;
  for (let i = 0; i < cards; i++) {
    const ang = (i / cards) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rad = rng.range(0.25, 1.0) * spread;
    // the crown thins and drops as it spreads — a dome, not a cylinder
    const h = top * rng.range(0.62, 1.0) * (1 - rad / (spread * 2.6));
    const w = rng.range(1.3, 2.1);
    const y0 = rng.range(0.02, 0.3);
    const cx = Math.cos(ang) * rad;
    const cz = Math.sin(ang) * rad;
    const dx = Math.cos(ang + 1.57);
    const dz = Math.sin(ang + 1.57);
    wave.set(0.09, phase, 0.12);
    card(
      g,
      new THREE.Vector3(cx - dx * w * 0.5, y0, cz - dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, y0, cz + dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, y0 + h, cz + dz * w * 0.5),
      new THREE.Vector3(cx - dx * w * 0.5, y0 + h, cz - dz * w * 0.5),
      // one leaf in eight goes rusty; any more and it reads as a dying plant
      i === 3 ? leaf[3] : leaf[i % 3],
      wave,
    );
  }
  for (let k = 0; k < 2; k++) {
    const r = spread * (k === 0 ? 0.95 : 0.55);
    const y = top * (k === 0 ? 0.52 : 0.86);
    wave.set(0.07, phase, 0.1);
    quadUV(
      g,
      new THREE.Vector3(-r, y, -r),
      new THREE.Vector3(r, y, -r),
      new THREE.Vector3(r, y, r),
      new THREE.Vector3(-r, y, r),
      FULL_UV,
      shade(leaf[k], 0.9),
      wave,
    );
  }
  return finish(g, true);
}

/**
 * Fern / low palmetto clump for the shaded back of the bench, where the bluff
 * cuts the light. Fronds arch *outward and down*, which is the read that
 * separates a fern from a grass tuft at 45 m/s.
 */
export function buildFernClump(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const fronds = 7;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < fronds; i++) {
    const ang = (i / fronds) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const len = rng.range(0.7, 1.25);
    const wdt = rng.range(0.3, 0.52);
    const rise = rng.range(0.42, 0.78);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    // the tip falls back toward the ground: arch, not spike
    const tipY = rise * rng.range(0.55, 0.85);
    wave.set(0.2, phase, 0.26);
    card(
      g,
      new THREE.Vector3(-dz * wdt * 0.35, 0.04, dx * wdt * 0.35),
      new THREE.Vector3(dz * wdt * 0.35, 0.04, -dx * wdt * 0.35),
      new THREE.Vector3(dx * len + dz * wdt * 0.5, tipY, dz * len - dx * wdt * 0.5),
      new THREE.Vector3(dx * len - dz * wdt * 0.5, tipY, dz * len + dx * wdt * 0.5),
      [KIT.leafDark, KIT.leafMid, 0x2c6b3a][i % 3],
      wave,
    );
  }
  return finish(g, true);
}

/**
 * Sea oats / beach grass — the tall thin stuff on the dune crest that catches
 * the light and moves most in the wind. Deliberately the cheapest plant in the
 * set (five blades) because it is scattered in the largest numbers.
 */
export function buildBeachGrass(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const blades = 5;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < blades; i++) {
    const ang = (i / blades) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const h = rng.range(0.55, 1.15);
    const w = rng.range(0.3, 0.55);
    const lean = rng.range(0.12, 0.42);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const px = -dz;
    const pz = dx;
    // grass is the most wind-active thing on the dune; give it the top weight
    wave.set(0.42, phase, 0.5);
    card(
      g,
      new THREE.Vector3(-px * w * 0.5, 0, -pz * w * 0.5),
      new THREE.Vector3(px * w * 0.5, 0, pz * w * 0.5),
      new THREE.Vector3(dx * h * lean + px * w * 0.22, h, dz * h * lean + pz * w * 0.22),
      new THREE.Vector3(dx * h * lean - px * w * 0.22, h, dz * h * lean - pz * w * 0.22),
      [0x8a9a3c, 0x6f8f34, 0xa8ac52][i % 3],
      wave,
    );
  }
  return finish(g, true);
}

/* ========================================================================== *
 *  chinchorro strip furniture
 * ========================================================================== */

/**
 * Free-standing painted drink board — the yellow-and-red enamel advertising
 * panel propped against every kiosk on the island. Every brand on it is
 * invented (§7): CERVEZA CANGREJA, MALTA SOLIMAR, REFRESCOS FLAMBOYÁN.
 */
export function buildDrinkBoard(key: SignKey): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const w = 0.72;
  const h = 1.02;
  const y0 = 0.16;
  const rect = signRect(key);
  // panel leans back a little, as a propped board does
  const tilt = 0.13;
  quadUV(
    g,
    new THREE.Vector3(-w, y0, 0),
    new THREE.Vector3(w, y0, 0),
    new THREE.Vector3(w, y0 + h, -tilt * h),
    new THREE.Vector3(-w, y0 + h, -tilt * h),
    rect,
  );
  g.quad(
    new THREE.Vector3(-w, y0 + h, -tilt * h),
    new THREE.Vector3(w, y0 + h, -tilt * h),
    new THREE.Vector3(w, y0, 0),
    new THREE.Vector3(-w, y0, 0),
    KIT.zincOld,
    0.6,
  );
  for (const sx of [-w * 0.72, w * 0.72]) {
    g.box(sx, y0 * 0.5, 0.01, 0.035, y0 * 0.5, 0.035, KIT.steelDark);
  }
  // a back prop so it is not a floating panel
  g.box(0, y0 + h * 0.3, -tilt * h - 0.16, 0.03, y0 + h * 0.3, 0.03, KIT.woodDark);
  return finish(g);
}

/**
 * PA speaker on a tripod stand. Piñones is loud — the music is half the reason
 * anybody drives out here — and a speaker box on a pole is the visual shorthand
 * for it. Paired with the `musica` boards and the dancers in `PinonesLife`.
 */
export function buildSpeakerStack(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const standH = 1.15;
  g.cylinder(0, 0, 0, 0.035, 0.03, standH, 6, KIT.steelDark);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    strut(
      g,
      new THREE.Vector3(0, standH * 0.5, 0),
      new THREE.Vector3(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32),
      0.022,
      KIT.steelDark,
    );
  }
  const cy = standH + 0.34;
  g.box(0, cy, 0, 0.22, 0.34, 0.2, KIT.black);
  // grille face: the woofer and the horn, as proud panels on the front
  g.box(0, cy - 0.11, 0.21, 0.15, 0.15, 0.012, 0x2a2e32);
  g.box(0, cy + 0.17, 0.21, 0.09, 0.06, 0.012, 0x3a3f44);
  // a lighter cap so the box does not read as one black blob against the sea
  g.box(0, cy + 0.35, 0, 0.23, 0.02, 0.21, shade(KIT.black, 1.9));
  return finish(g);
}

/**
 * Festoon bulb — a warm emissive teardrop hung along a catenary. Deliberately
 * over-scale: a true 4 cm bulb is sub-pixel at 30 m, and these have to read as
 * a strung light at speed, at night, through bloom.
 */
export function buildFestoonBulb(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.cylinder(0, -0.05, 0, 0.02, 0.026, 0.05, 5, KIT.steelDark);
  g.cylinder(0, -0.14, 0, 0.055, 0.045, 0.1, 6, 0xffd9a0);
  g.cylinder(0, -0.2, 0, 0.045, 0.008, 0.06, 6, 0xffd9a0);
  return finish(g);
}

/* ========================================================================== *
 *  wires, catenaries, smoke
 * ========================================================================== */

/**
 * Hang a sagging line between two points as a thin cross-section ribbon, and
 * optionally report the sampled points so bunting or bulbs can ride it.
 */
export function catenary(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  sag: number,
  color: number,
  thickness = 0.022,
  segments = 8,
  out?: THREE.Vector3[],
): void {
  const prev = new THREE.Vector3();
  const cur = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    cur.set(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * sag,
      a.z + (b.z - a.z) * t,
    );
    if (out) out.push(cur.clone());
    if (i > 0) {
      const dx = cur.x - prev.x;
      const dz = cur.z - prev.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = (-dz / l) * thickness;
      const nz = (dx / l) * thickness;
      g.quad(
        new THREE.Vector3(prev.x + nx, prev.y, prev.z + nz),
        new THREE.Vector3(cur.x + nx, cur.y, cur.z + nz),
        new THREE.Vector3(cur.x - nx, cur.y, cur.z - nz),
        new THREE.Vector3(prev.x - nx, prev.y, prev.z - nz),
        color,
        0.5,
      );
      g.quad(
        new THREE.Vector3(prev.x, prev.y + thickness, prev.z),
        new THREE.Vector3(cur.x, cur.y + thickness, cur.z),
        new THREE.Vector3(cur.x, cur.y - thickness, cur.z),
        new THREE.Vector3(prev.x, prev.y - thickness, prev.z),
        shade(color, 0.8),
        0.5,
      );
    }
    prev.copy(cur);
  }
}

/**
 * Triangular bunting (*banderines*) hung from a sampled catenary — the
 * cheapest, most effective "this street is alive" prop there is.
 */
export function bunting(
  g: GeoBuilder,
  points: readonly THREE.Vector3[],
  size: number,
  palette: readonly number[],
  phase: number,
): void {
  const wave = new THREE.Vector3();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    const w = size * 0.5;
    const p0 = new THREE.Vector3(mx - (dx / l) * w, my, mz - (dz / l) * w);
    const p1 = new THREE.Vector3(mx + (dx / l) * w, my, mz + (dz / l) * w);
    const tip0 = new THREE.Vector3(mx - (dx / l) * w * 0.12, my - size, mz - (dz / l) * w * 0.12);
    const tip1 = new THREE.Vector3(mx + (dx / l) * w * 0.12, my - size, mz + (dz / l) * w * 0.12);
    wave.set(0.05, (phase + i * 0.13) % 1, 0.3);
    card(g, p0, p1, tip1, tip0, palette[i % palette.length], wave);
  }
}

/**
 * Fryer smoke: a stack of drifting cards. Deliberately *not* billboarded — a
 * vertical column reads correctly from the road and costs nothing per frame.
 */
export function buildSmokePlume(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const cards = 5;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < cards; i++) {
    const t = i / (cards - 1);
    const y = 0.2 + t * 2.7;
    const w = 0.35 + t * 1.2;
    const ang = rng.range(0, Math.PI);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    wave.set(0.2 + t * 0.6, phase, 0.28);
    card(
      g,
      new THREE.Vector3(-dx * w * 0.5, y, -dz * w * 0.5),
      new THREE.Vector3(dx * w * 0.5, y, dz * w * 0.5),
      new THREE.Vector3(dx * w * 0.5, y + w * 0.9, dz * w * 0.5),
      new THREE.Vector3(-dx * w * 0.5, y + w * 0.9, -dz * w * 0.5),
      shade(0xdcd6ca, 0.6 + (1 - t) * 0.4),
      wave,
    );
  }
  return finish(g, true);
}

/* ========================================================================== *
 *  plaza and street furniture
 * ========================================================================== */

/** Cast-iron bench, §1.8: 1.80 × 0.62, seat 0.45, back top 0.85, timber slats. */
export function buildBench(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  for (let i = 0; i < 3; i++) g.box(0, 0.45, -0.22 + i * 0.16, 0.9, 0.018, 0.045, KIT.woodRaw);
  for (let i = 0; i < 2; i++) g.box(0, 0.62 + i * 0.19, -0.27, 0.9, 0.045, 0.02, KIT.woodRaw);
  for (const sx of [-0.86, 0.86]) {
    g.box(sx, 0.22, -0.05, 0.03, 0.22, 0.24, KIT.iron);
    g.box(sx, 0.66, -0.26, 0.028, 0.22, 0.03, KIT.iron);
    g.box(sx, 0.44, 0, 0.035, 0.03, 0.3, KIT.iron);
  }
  return finish(g);
}

/**
 * Fluted cast-iron street lamp, §1.8: plinth 0.45 high, shaft 0.14 → 0.09,
 * lamp base 4.20. The globes are a separate geometry on the emissive material.
 */
export function buildLampPost(twin = false): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.cylinder(0, 0, 0, 0.19, 0.17, 0.45, 8, KIT.ironWorn);
  g.cylinder(0, 0.45, 0, 0.13, 0.07, 3.75, 8, KIT.iron);
  g.cylinder(0, 4.2, 0, 0.1, 0.14, 0.16, 8, KIT.iron);
  if (twin) {
    for (const sx of [-0.55, 0.55]) {
      g.box(sx * 0.5, 4.34, 0, 0.28, 0.028, 0.028, KIT.iron);
      g.cylinder(sx, 4.3, 0, 0.045, 0.045, 0.14, 6, KIT.iron);
    }
  }
  return finish(g);
}

/** The lamp's glass globe(s), on the emissive material. */
export function buildLampGlobe(twin = false): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const globe = (x: number, y: number): void => {
    g.cylinder(x, y, 0, 0.11, 0.17, 0.15, 8, 0xffd9a0);
    g.cylinder(x, y + 0.15, 0, 0.17, 0.09, 0.19, 8, 0xffd9a0);
  };
  if (twin) {
    globe(-0.55, 4.44);
    globe(0.55, 4.44);
  }
  globe(0, 4.36);
  return finish(g);
}

/** Iron tree grate, §1.8: 1.20 × 1.20, flush with the pavement. */
export function buildTreeGrate(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0.02, 0, 0.6, 0.02, 0.6, KIT.ironWorn);
  g.box(0, 0.05, 0, 0.62, 0.03, 0.05, KIT.iron);
  g.box(0, 0.05, 0, 0.05, 0.03, 0.62, KIT.iron);
  return finish(g);
}

/**
 * Flamboyán / laurel shade tree (§1.9): a flat umbrella crown on a short
 * trunk. Trunk and canopy are separate geometries so the canopy can take the
 * alpha-cut leaf texture and the wind, and the trunk can stay solid.
 */
export function buildShadeTrunk(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const h = 2.9;
  g.cylinder(0, 0, 0, 0.34, 0.22, h, 8, 0x6b5b48);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const len = rng.range(1.6, 2.4);
    strut(
      g,
      new THREE.Vector3(0, h * 0.9, 0),
      new THREE.Vector3(Math.cos(a) * len, h + rng.range(0.6, 1.2), Math.sin(a) * len),
      0.085,
      0x6b5b48,
    );
  }
  return finish(g);
}

export function buildShadeCanopy(rng: RNG, bloom = false): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const clumps = 11;
  const wave = new THREE.Vector3();
  const phase = rng.next();
  for (let i = 0; i < clumps; i++) {
    const ang = (i / clumps) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const rad = rng.range(1.3, 4.3);
    const y = 4.2 + rng.range(-0.5, 0.7) - rad * 0.14;
    const w = rng.range(2.2, 3.4);
    const hgt = rng.range(0.9, 1.5);
    const cx = Math.cos(ang) * rad;
    const cz = Math.sin(ang) * rad;
    const dx = Math.cos(ang + 1.57);
    const dz = Math.sin(ang + 1.57);
    const col = bloom && i % 4 === 0 ? 0xe8563f : [KIT.leafDark, KIT.leafMid, KIT.leafLit][i % 3];
    wave.set(0.1, phase, 0.13);
    card(
      g,
      new THREE.Vector3(cx - dx * w * 0.5, y, cz - dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, y, cz + dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, y + hgt, cz + dz * w * 0.5),
      new THREE.Vector3(cx - dx * w * 0.5, y + hgt, cz - dz * w * 0.5),
      col,
      wave,
    );
    // a horizontal leaf plane through the clump so the crown reads from above
    quadUV(
      g,
      new THREE.Vector3(cx - dx * w * 0.5, y + hgt * 0.55, cz - dz * w * 0.5 - w * 0.3),
      new THREE.Vector3(cx + dx * w * 0.5, y + hgt * 0.55, cz + dz * w * 0.5 - w * 0.3),
      new THREE.Vector3(cx + dx * w * 0.5, y + hgt * 0.55, cz + dz * w * 0.5 + w * 0.3),
      new THREE.Vector3(cx - dx * w * 0.5, y + hgt * 0.55, cz - dz * w * 0.5 + w * 0.3),
      FULL_UV,
      shade(col, 0.92),
      wave,
    );
  }
  return finish(g, true);
}

/** Market stall: a folding table of goods under a striped awning on four poles. */
export function buildMarketStall(rng: RNG, key: SignKey): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const w = 1.5;
  const d = 0.9;
  const h = 2.15;
  for (const sx of [-w, w]) {
    for (const sz of [-d, d]) g.cylinder(sx, 0, sz, 0.035, 0.03, h, 5, KIT.steel);
  }
  const stripeA = rng.pick([KIT.umbrellaRed, KIT.awningBlue, KIT.awningGreen]);
  const bays = 6;
  const wave = new THREE.Vector3();
  for (let i = 0; i < bays; i++) {
    const x0 = -w + (2 * w * i) / bays;
    const x1 = -w + (2 * w * (i + 1)) / bays;
    const col = i % 2 === 0 ? stripeA : KIT.umbrellaWhite;
    wave.set(0.02, 0.3, 0.25);
    g.quad(
      new THREE.Vector3(x0, h, -d),
      new THREE.Vector3(x1, h, -d),
      new THREE.Vector3(x1, h + 0.3, 0),
      new THREE.Vector3(x0, h + 0.3, 0),
      col,
      0.6,
      wave,
    );
    g.quad(
      new THREE.Vector3(x0, h + 0.3, 0),
      new THREE.Vector3(x1, h + 0.3, 0),
      new THREE.Vector3(x1, h, d),
      new THREE.Vector3(x0, h, d),
      col,
      0.6,
      wave,
    );
    wave.set(0.07, 0.3, 0.6);
    g.quad(
      new THREE.Vector3(x0, h, d),
      new THREE.Vector3(x1, h, d),
      new THREE.Vector3(x1, h - 0.22, d),
      new THREE.Vector3(x0, h - 0.22, d),
      col,
      0.6,
      wave,
    );
  }
  g.box(0, 0.9, 0, w * 0.92, 0.03, d * 0.72, KIT.woodPale);
  for (const sx of [-w * 0.8, 0, w * 0.8]) g.box(sx, 0.72, 0, 0.03, 0.36, 0.03, KIT.steel);
  const goods = rng.int(4, 7);
  for (let i = 0; i < goods; i++) {
    g.box(
      rng.range(-w * 0.8, w * 0.8),
      0.93 + 0.1,
      rng.range(-d * 0.5, d * 0.5),
      rng.range(0.1, 0.2),
      0.1,
      rng.range(0.08, 0.16),
      rng.pick([0xe0563f, 0xf2c230, 0x6fa84a, 0xb43fa8, 0xf7f4ec]),
    );
  }
  const r = signRect(key);
  quadUV(
    g,
    new THREE.Vector3(-w * 0.75, h + 0.32, d),
    new THREE.Vector3(w * 0.75, h + 0.32, d),
    new THREE.Vector3(w * 0.75, h + 0.8, d),
    new THREE.Vector3(-w * 0.75, h + 0.8, d),
    r,
  );
  return finish(g, true);
}
