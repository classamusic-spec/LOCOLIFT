/**
 * Loco Lift — the plaza & street dressing kit.
 *
 * The shared parts library behind {@link ../world/PlazaLife} and
 * {@link ../world/StreetDressing}: the six materials both layers draw with, the
 * geometry the roadside kit (`ShackKit.ts`) does not already own — the
 * four-figure stone fountain, its animated water, the bandstand *glorieta*,
 * stone benches, flagpoles, A-boards, hanging planters, potted palms, produce
 * crates, market stalls, pigeons and the plaza's inlaid paving — and the
 * placement guard that keeps every prop out of a carriageway and out of a
 * building footprint.
 *
 * Three things hold this file together:
 *
 *  1. **Import, don't duplicate.** Everything `ShackKit.ts` already builds
 *     (benches, cast-iron lamps, tree grates, shade trees, potted plants,
 *     umbrellas, chairs, catenaries, bunting, festoon bulbs) is imported
 *     read-only. Only the parts that do not exist there are authored here.
 *  2. **Six materials, ~27 draw calls for the whole city's dressing.** Colour
 *     rides on vertex attributes and, for tinted instances, on `instanceColor`.
 *     Anything repeated is an `InstancedMesh`; anything unique is merged into a
 *     per-material builder.
 *  3. **Distance culling lives in the vertex shader.** Every dressing vertex
 *     carries an *anchor* — the origin of the cluster it belongs to — and every
 *     instance carries a cull multiplier. Past `propDetailDistance` a cluster
 *     collapses to its anchor and stops rasterising, with a 25 m fade band so
 *     nothing pops. Draw calls stay constant; fill cost does not.
 *
 * Cultural note (§7.1): every Spanish string baked into the sign atlas is
 * grammatical and correctly accented, and every business name is invented.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import { clamp, clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GeoBuilder } from './Coast';
import { KIT, Placer, shade, strut } from './ShackKit';
import { createCanvas, type Canvas2D } from './TextureFactory';
import type { CityLayout, Lot } from './WorldTypes';

/* ========================================================================== *
 *  palette — extends ShackKit's KIT with the stone the plaza is built from
 * ========================================================================== */

/** Plaza and street-dressing colours, sRGB. */
export const DRESS = {
  /* limestone / cantera — the fountain, the coping, the bandstand plinth */
  stoneLight: 0xe4dccb,
  stoneMid: 0xcfc5b0,
  stoneShade: 0xb0a692,
  stoneDeep: 0x8f8674,
  stoneWet: 0x9c9584,

  /* the inlaid paving of a formal plaza */
  paveField: 0xd9d2c2,
  paveBand: 0xa9b0b8,
  paveDark: 0x6f7c8a,
  paveWarm: 0xc9b79a,
  kerbStone: 0xbfb7a5,

  /* cast iron and bronze */
  iron: 0x1e2a26,
  ironWorn: 0x39413e,
  bronze: 0x6b6a4a,

  /* the glorieta */
  kioskPost: 0xf6f1e4,
  kioskTrim: 0x14523c,
  kioskRoof: 0xb0553a,
  kioskCeil: 0xf2e4c4,

  /* water */
  water: 0x8fd3d8,
  waterDeep: 0x3f8f9c,
  foam: 0xf4fbfb,

  /* planting */
  soil: 0x3a2e23,
  terracotta: 0xb4643c,
  terracottaPale: 0xd08a63,
  planterStone: 0xcac1ad,
  leafDark: 0x2b5527,
  leafMid: 0x43772d,
  leafLit: 0x76a53a,
  palmFrond: 0x3d7a34,
  bloom: [0xd6217a, 0xe8563f, 0xf6a01f, 0xb43fa8, 0xf4f0e6] as const,

  /* market produce */
  produce: [0xe0563f, 0xf2c230, 0x6fa84a, 0xf0a868, 0xb43fa8, 0xd8b26a] as const,
  crate: 0xa8845a,
  crateDark: 0x7d603e,

  /* pigeons — Parque de las Palomas (§7.2) */
  pigeon: [0x8d8f95, 0x6f7278, 0xb9b7ae, 0x5a5f66] as const,

  /* awnings and cloth */
  awning: [0xd52b1e, 0x2e5e86, 0x14523c, 0xe8a93b, 0xf7f4ec] as const,
} as const;

/* ========================================================================== *
 *  sign atlas — hand-painted Spanish shop lettering (§7.1)
 * ========================================================================== */

export type DressSign =
  | 'blank'
  | 'frutas'
  | 'artesanias'
  | 'panaderia'
  | 'cafe'
  | 'piraguas'
  | 'flores'
  | 'heladeria'
  | 'abierto'
  | 'menu'
  | 'colmado'
  | 'alcapurrias'
  | 'floristeria'
  | 'jugos'
  | 'mercado'
  | 'pan';

interface SignSpec {
  bg: number;
  ink: number;
  lines: string[];
  /** 0 = painted slab serif, 1 = brushed sans, 2 = chalked */
  face: number;
}

const SIGN_SPECS: Record<DressSign, SignSpec> = {
  blank: { bg: 0xffffff, ink: 0xffffff, lines: [], face: 0 },
  frutas: { bg: 0xf2e4c4, ink: 0x14523c, lines: ['FRUTAS', 'DEL PAÍS'], face: 0 },
  artesanias: { bg: 0x2e5e86, ink: 0xfbf7ee, lines: ['ARTESANÍAS'], face: 1 },
  panaderia: { bg: 0xe8a93b, ink: 0x5a2e1b, lines: ['PANADERÍA'], face: 0 },
  cafe: { bg: 0x14523c, ink: 0xffd166, lines: ['CAFÉ', 'RECIÉN COLAO'], face: 0 },
  piraguas: { bg: 0xd52b1e, ink: 0xf7f4ec, lines: ['PIRAGUAS'], face: 1 },
  flores: { bg: 0xf4f0e6, ink: 0xb43fa8, lines: ['FLORES'], face: 1 },
  heladeria: { bg: 0x4fbfb1, ink: 0x14523c, lines: ['HELADERÍA'], face: 1 },
  abierto: { bg: 0xf7f4ec, ink: 0x9e2b25, lines: ['ABIERTO'], face: 2 },
  menu: { bg: 0x2b2b2b, ink: 0xf2e4c4, lines: ['MENÚ', 'DEL DÍA'], face: 2 },
  colmado: { bg: 0xd08a2e, ink: 0x1b3a5c, lines: ['COLMADO'], face: 0 },
  alcapurrias: { bg: 0x9e2b25, ink: 0xffd166, lines: ['ALCAPURRIAS'], face: 1 },
  floristeria: { bg: 0xa8d5c0, ink: 0x14523c, lines: ['FLORISTERÍA'], face: 1 },
  jugos: { bg: 0xf0a868, ink: 0x6e2230, lines: ['JUGOS', 'NATURALES'], face: 2 },
  mercado: { bg: 0xf2e4c4, ink: 0x1b3a5c, lines: ['MERCADO', 'DE LA MARINA'], face: 0 },
  pan: { bg: 0xefa48b, ink: 0x5a2e1b, lines: ['PAN CALIENTE'], face: 2 },
};

const SIGN_ORDER: DressSign[] = [
  'blank', 'frutas', 'artesanias', 'panaderia',
  'cafe', 'piraguas', 'flores', 'heladeria',
  'abierto', 'menu', 'colmado', 'alcapurrias',
  'floristeria', 'jugos', 'mercado', 'pan',
];

const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;

/** A rect in the shared sign atlas, in UV space. */
export interface SignRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** UV rect of one baked sign. Inset a texel so neighbours never bleed. */
export function signRect(key: DressSign): SignRect {
  const i = Math.max(0, SIGN_ORDER.indexOf(key));
  const c = i % ATLAS_COLS;
  const r = Math.floor(i / ATLAS_COLS);
  const pad = 0.0035;
  return {
    u0: c / ATLAS_COLS + pad,
    v0: 1 - (r + 1) / ATLAS_ROWS + pad,
    u1: (c + 1) / ATLAS_COLS - pad,
    v1: 1 - r / ATLAS_ROWS - pad,
  };
}

/** The white cell every non-signed quad on the sign material points at. */
const BLANK_UV = (() => {
  const r = signRect('blank');
  return { u: (r.u0 + r.u1) * 0.5, v: (r.v0 + r.v1) * 0.5 };
})();

function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function drawSignCell(ctx: Canvas2D, spec: SignSpec, x: number, y: number, s: number, rng: RNG): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();

  ctx.fillStyle = hexCss(spec.bg);
  ctx.fillRect(x, y, s, s);

  if (spec.lines.length === 0) {
    ctx.restore();
    return;
  }

  // sun-bleached blotching so no two boards read as printed vinyl
  for (let i = 0; i < 90; i++) {
    const rx = x + rng.range(0, s);
    const ry = y + rng.range(0, s);
    const rr = rng.range(s * 0.02, s * 0.16);
    ctx.globalAlpha = rng.range(0.015, 0.06);
    ctx.fillStyle = rng.bool(0.55) ? '#ffffff' : '#000000';
    ctx.beginPath();
    ctx.arc(rx, ry, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // painted border — a plain double rule, the way a real board is lined out
  ctx.strokeStyle = hexCss(spec.ink);
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(2, s * 0.018);
  ctx.strokeRect(x + s * 0.055, y + s * 0.055, s * 0.89, s * 0.89);
  ctx.lineWidth = Math.max(1, s * 0.008);
  ctx.strokeRect(x + s * 0.085, y + s * 0.085, s * 0.83, s * 0.83);
  ctx.globalAlpha = 1;

  const families = [
    '700 1px "Times New Roman", Georgia, serif',
    '700 1px Helvetica, Arial, sans-serif',
    'italic 700 1px Georgia, "Times New Roman", serif',
  ];
  const family = families[clamp(spec.face, 0, 2)];
  ctx.fillStyle = hexCss(spec.ink);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const n = spec.lines.length;
  for (let i = 0; i < n; i++) {
    const text = spec.lines[i];
    // fit each line to 78 % of the cell
    let size = s * (n === 1 ? 0.3 : 0.21);
    ctx.font = family.replace('1px', `${size}px`);
    let w = ctx.measureText(text).width;
    const target = s * 0.78;
    if (w > target) {
      size *= target / w;
      ctx.font = family.replace('1px', `${size}px`);
      w = ctx.measureText(text).width;
    }
    const cy = y + s * (n === 1 ? 0.5 : 0.36 + i * 0.28);
    ctx.fillText(text, x + s * 0.5, cy);
    void w;
  }
  ctx.restore();
}

function signAtlasTexture(size: number): THREE.Texture {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d') as Canvas2D | null;
  if (!ctx) throw new Error('PropKit: 2D canvas context unavailable');
  const cell = size / ATLAS_COLS;
  const rng = new RNG(0x5164_3a71);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < SIGN_ORDER.length; i++) {
    const c = i % ATLAS_COLS;
    const r = Math.floor(i / ATLAS_COLS);
    drawSignCell(ctx, SIGN_SPECS[SIGN_ORDER[i]], c * cell, r * cell, cell, rng);
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

/* ========================================================================== *
 *  procedural textures
 * ========================================================================== */

/**
 * Alpha-cut leaf mass, so foliage cards are never solid rectangles (§8.25).
 *
 * A *tiling* mask of overlapping leaflets rather than one drawn leaf: the
 * cards this is stretched over come from four different builders with four
 * different UV conventions, and a single-leaf cut-out only survives one of
 * them. Coverage lands around 70 %, which is what keeps a canopy reading as
 * foliage rather than as a hedge.
 */
function leafTexture(size: number): THREE.Texture {
  const data = new Uint8Array(size * size * 4);
  const rng = new RNG(0x1eaf_0b17);
  interface Leaflet {
    x: number;
    y: number;
    rx: number;
    ry: number;
    rot: number;
    tone: number;
  }
  const leaves: Leaflet[] = [];
  for (let i = 0; i < 78; i++) {
    leaves.push({
      x: rng.next(),
      y: rng.next(),
      rx: rng.range(0.052, 0.115),
      ry: rng.range(0.026, 0.058),
      rot: rng.range(0, Math.PI),
      tone: rng.range(0.66, 1.0),
    });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let alpha = 0;
      let tone = 0.8;
      let best = 1e9;
      for (const l of leaves) {
        // wrap into the nearest period so the mask tiles in both axes
        let dx = u - l.x;
        let dy = v - l.y;
        if (dx > 0.5) dx -= 1;
        if (dx < -0.5) dx += 1;
        if (dy > 0.5) dy -= 1;
        if (dy < -0.5) dy += 1;
        const c = Math.cos(l.rot);
        const s = Math.sin(l.rot);
        const lx = (dx * c + dy * s) / l.rx;
        const ly = (-dx * s + dy * c) / l.ry;
        // a pointed oval: |x|^1.6 + |y|^2 <= 1
        const d = Math.pow(Math.abs(lx), 1.7) + ly * ly;
        if (d <= 1) {
          alpha = 1;
          if (d < best) {
            best = d;
            tone = l.tone * (0.78 + 0.28 * (1 - d));
          }
        }
      }
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp(238 * tone, 0, 255));
      data[i + 1] = Math.round(clamp(248 * tone, 0, 255));
      data[i + 2] = Math.round(clamp(230 * tone, 0, 255));
      data[i + 3] = alpha ? 255 : 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Tiling normal for cut stone — joints plus a fine chisel grain. */
function stoneNormalTexture(size: number): THREE.Texture {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const hash = (x: number, y: number): number => {
    let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = hash(x, y) * 0.35 + hash(x >> 1, y >> 1) * 0.4 + hash(x >> 3, y >> 3) * 0.25;
      // shallow horizontal course lines every 1/4 of the tile
      const course = Math.abs(((y / size) * 4) % 1 - 0.5) < 0.03 ? -0.7 : 0;
      h[y * size + x] = g * 0.5 + course;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const d = h[((y - 1 + size) % size) * size + x];
      const u = h[((y + 1) % size) * size + x];
      let nx = (l - r) * 2.4;
      let ny = (d - u) * 2.4;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The plaza's inlaid paving: a losa field with a joint lattice and a rubbed
 * wear sheen. Vertex colour picks the band; this carries the stone.
 */
function paveTexture(size: number): THREE.Texture {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d') as Canvas2D | null;
  if (!ctx) throw new Error('PropKit: 2D canvas context unavailable');
  const rng = new RNG(0x9d31_a70b);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const cells = 4;
  const c = size / cells;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const off = j % 2 === 0 ? 0 : c * 0.5;
      const x = (i * c + off) % size;
      const y = j * c;
      const k = rng.range(0.86, 1.0);
      ctx.fillStyle = `rgb(${Math.round(255 * k)},${Math.round(253 * k)},${Math.round(248 * k)})`;
      ctx.fillRect(x + 1.5, y + 1.5, c - 3, c - 3);
      if (x + c > size) ctx.fillRect(x - size + 1.5, y + 1.5, c - 3, c - 3);
    }
  }
  // joints
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#5f5c54';
  ctx.lineWidth = Math.max(1.5, size / 190);
  for (let j = 0; j <= cells; j++) {
    ctx.beginPath();
    ctx.moveTo(0, j * c);
    ctx.lineTo(size, j * c);
    ctx.stroke();
    const off = j % 2 === 0 ? 0 : c * 0.5;
    for (let i = 0; i <= cells; i++) {
      const x = (i * c + off) % size;
      ctx.beginPath();
      ctx.moveTo(x, j * c);
      ctx.lineTo(x, (j + 1) * c);
      ctx.stroke();
    }
  }
  // grain
  ctx.globalAlpha = 1;
  for (let i = 0; i < size * 3; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    ctx.globalAlpha = rng.range(0.02, 0.09);
    ctx.fillStyle = rng.bool(0.5) ? '#ffffff' : '#3a3730';
    ctx.fillRect(x, y, rng.range(1, 3.2), rng.range(1, 3.2));
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/* ========================================================================== *
 *  shaders
 * ========================================================================== */

/**
 * Distance cull, shared by every dressing material.
 *
 * A *cluster* is one prop: a merged prop carries its anchor per-vertex in
 * `aAnchor` (xyz = anchor, w = cull multiplier); an instanced prop takes its
 * anchor from `instanceMatrix` and its multiplier from `aCullMul`. Past
 * `uDressCull.x * multiplier` the whole cluster collapses to the anchor and
 * every triangle degenerates, so nothing rasterises and no seam appears at the
 * boundary. `uDressCull.y` is the fade band.
 */
const CULL_PARS = /* glsl */ `
uniform vec3 uDressCam;
uniform vec2 uDressCull;
#ifdef USE_INSTANCING
  attribute float aCullMul;
#else
  attribute vec4 aAnchor;
#endif
`;

const CULL_APPLY = /* glsl */ `
{
  #ifdef USE_INSTANCING
    vec3 dLocal = instanceMatrix[3].xyz;
    float dMul = aCullMul;
    vec3 dCollapse = vec3( 0.0 );
  #else
    vec3 dLocal = aAnchor.xyz;
    float dMul = aAnchor.w;
    vec3 dCollapse = aAnchor.xyz;
  #endif
  vec3 dWorld = ( modelMatrix * vec4( dLocal, 1.0 ) ).xyz;
  float dFar = uDressCull.x * dMul;
  float dDist = distance( uDressCam.xz, dWorld.xz );
  float dK = 1.0 - smoothstep( dFar - uDressCull.y, dFar, dDist );
  transformed = mix( dCollapse, transformed, dK );
}
`;

/**
 * Wind, on the same `aWave` contract `ShackKit` authors: x = sway weight
 * (0 anchored, 1 free tip), y = per-object phase 0..1, z = flutter weight.
 * Only the cloth and foliage materials carry it, and every geometry drawn with
 * them enables the aux channel.
 */
const WAVE_PARS = /* glsl */ `
uniform float uDressTime;
uniform vec3 uDressWind;
attribute vec3 aWave;
`;

const WAVE_APPLY = /* glsl */ `
{
  float wPhase = aWave.y * 6.2831853;
  #ifdef USE_INSTANCING
    wPhase += instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
  #endif
  float wT = uDressTime;
  float gust = 0.66 + 0.34 * sin( wT * 0.21 + wPhase * 0.31 );
  float sway = sin( wT * 2.2 + wPhase ) * aWave.x * uDressWind.z * gust;
  float flut = sin( wT * 7.4 + wPhase * 2.3 ) * aWave.z * uDressWind.z * 0.34 * gust;
  transformed.x += ( uDressWind.x * sway + flut * uDressWind.y ) * 0.55;
  transformed.z += ( uDressWind.y * sway - flut * uDressWind.x ) * 0.55;
  transformed.y -= abs( sway ) * aWave.x * 0.16;
}
`;

/** Emissive ramp: 0 by day, 1 at night. Lamps, festoons, kiosk soffits. */
const GLOW_FRAG = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uDressNight * 2.35;
`;

/** The fountain. `aWater.x` 0 = pool surface, 1 = falling sheet, 2 = jet. */
const WATER_PARS = /* glsl */ `
uniform float uDressTime;
attribute vec3 aWater;
varying vec3 vWaterAux;
varying vec3 vWaterPos;
`;

const WATER_VERT = /* glsl */ `
#include <begin_vertex>
vWaterAux = aWater;
{
  float t = uDressTime;
  if ( aWater.x < 0.5 ) {
    // pool: two crossed ripple trains, plus a ring travelling out from the jets
    float r = length( transformed.xz );
    transformed.y += sin( transformed.x * 3.1 + t * 2.6 ) * 0.012
      + sin( transformed.z * 2.7 - t * 2.1 ) * 0.011
      + sin( r * 5.5 - t * 3.4 ) * 0.009;
  } else if ( aWater.x < 1.5 ) {
    // falling sheet: a slow horizontal wobble so the veil is never a cylinder
    transformed.x += sin( t * 3.1 + transformed.y * 5.0 + aWater.y * 6.0 ) * 0.018;
    transformed.z += cos( t * 2.7 + transformed.y * 4.4 + aWater.y * 6.0 ) * 0.018;
  } else {
    // jet: breathe the arc so the spouts read as pressure, not as tubes
    float k = aWater.y;
    transformed.y += sin( t * 2.3 + aWater.z * 6.28 ) * 0.05 * k;
  }
}
vWaterPos = transformed;
`;

const WATER_FRAG_PARS = /* glsl */ `
uniform float uDressTime;
varying vec3 vWaterAux;
varying vec3 vWaterPos;
float dressHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float dressNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = dressHash( i );
  float b = dressHash( i + vec2( 1.0, 0.0 ) );
  float c = dressHash( i + vec2( 0.0, 1.0 ) );
  float d = dressHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
`;

const WATER_FRAG = /* glsl */ `
#include <map_fragment>
{
  float t = uDressTime;
  if ( vWaterAux.x < 0.5 ) {
    float n = dressNoise( vWaterPos.xz * 2.6 + vec2( t * 0.35, -t * 0.28 ) )
      + dressNoise( vWaterPos.xz * 6.1 - vec2( t * 0.6, t * 0.42 ) ) * 0.5;
    float sparkle = smoothstep( 0.86, 1.18, n );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), sparkle * 0.55 );
    diffuseColor.a *= 0.74 + sparkle * 0.26;
  } else if ( vWaterAux.x < 1.5 ) {
    float streak = dressNoise( vec2( vWaterAux.y * 26.0, vWaterPos.y * 5.5 - t * 5.2 ) );
    float veil = smoothstep( 0.18, 0.9, streak );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), veil * 0.8 );
    diffuseColor.a *= 0.34 + veil * 0.5;
  } else {
    float pulse = dressNoise( vec2( vWaterAux.z * 40.0, vWaterAux.y * 7.0 - t * 8.0 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), 0.42 + pulse * 0.4 );
    diffuseColor.a *= 0.5 + pulse * 0.35;
  }
}
`;

/* ========================================================================== *
 *  the shared material kit
 * ========================================================================== */

export interface DressUniforms {
  uDressTime: { value: number };
  uDressWind: { value: THREE.Vector3 };
  uDressNight: { value: number };
  uDressCam: { value: THREE.Vector3 };
  uDressCull: { value: THREE.Vector2 };
}

/**
 * Anything that wants the shared rain response. `MaterialLibrary` exposes
 * `wetnessUniform` publicly; the dressing layers borrow it rather than
 * registering with the library, because registering would overwrite each
 * material's program cache key.
 */
export interface WetnessSource {
  readonly wetnessUniform: { value: number };
}

const KIT_CACHE = new Map<QualityTier, DressKit>();

/**
 * Six materials and four textures, shared by `PlazaLife` and `StreetDressing`.
 * Refcounted: `acquire` on build, `release` on dispose.
 */
export class DressKit {
  readonly quality: QualityTier;

  /** stone, iron, timber, terracotta, plastics — everything hard */
  readonly solid: THREE.MeshStandardMaterial;
  /** awnings, bunting, flags — double sided, wind driven */
  readonly cloth: THREE.MeshStandardMaterial;
  /** alpha-cut leaf cards — double sided, wind driven */
  readonly foliage: THREE.MeshStandardMaterial;
  /** festoon bulbs, lamp globes, kiosk soffits */
  readonly glow: THREE.MeshStandardMaterial;
  /** atlas-mapped painted boards */
  readonly sign: THREE.MeshStandardMaterial;
  /** the plaza's inlaid paving, laid 25 mm over the ground mesh */
  readonly paving: THREE.MeshStandardMaterial;
  /** the fountain */
  readonly water: THREE.MeshStandardMaterial;

  readonly uniforms: DressUniforms = {
    uDressTime: { value: 0 },
    uDressWind: { value: new THREE.Vector3(0.86, -0.51, 0.24) },
    uDressNight: { value: 0 },
    uDressCam: { value: new THREE.Vector3(0, 0, 0) },
    uDressCull: { value: new THREE.Vector2(190, 25) },
  };

  private textures: THREE.Texture[] = [];
  private refs = 0;
  private wet: { value: number } = { value: 0 };
  private driver: object | null = null;

  private constructor(quality: QualityTier) {
    this.quality = quality;
    const detail = quality === 'low' ? 128 : 256;

    const leaf = leafTexture(detail);
    const stoneN = stoneNormalTexture(detail);
    const atlas = signAtlasTexture(quality === 'low' ? 512 : 1024);
    const pave = paveTexture(quality === 'low' ? 256 : 512);
    this.textures.push(leaf, stoneN, atlas, pave);

    this.solid = new THREE.MeshStandardMaterial({
      name: 'loco/dressSolid',
      vertexColors: true,
      normalMap: stoneN,
      normalScale: new THREE.Vector2(0.42, 0.42),
      roughness: 0.79,
      metalness: 0.06,
      envMapIntensity: 0.85,
    });
    this.patch(this.solid, 'loco/dress-solid-v1', { wet: 0.8 });

    this.cloth = new THREE.MeshStandardMaterial({
      name: 'loco/dressCloth',
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.68,
    });
    this.patch(this.cloth, 'loco/dress-cloth-v1', { wave: true, wet: 0.35 });

    this.foliage = new THREE.MeshStandardMaterial({
      name: 'loco/dressFoliage',
      map: leaf,
      vertexColors: true,
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.42,
      envMapIntensity: 0.6,
    });
    this.patch(this.foliage, 'loco/dress-foliage-v1', { wave: true, wet: 0.45 });

    this.glow = new THREE.MeshStandardMaterial({
      name: 'loco/dressGlow',
      vertexColors: true,
      roughness: 0.42,
      metalness: 0.05,
      emissive: 0x000000,
      envMapIntensity: 0.55,
    });
    this.patch(this.glow, 'loco/dress-glow-v1', { glow: true });

    this.sign = new THREE.MeshStandardMaterial({
      name: 'loco/dressSign',
      map: atlas,
      vertexColors: true,
      roughness: 0.74,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.7,
    });
    this.patch(this.sign, 'loco/dress-sign-v1', { wet: 0.6 });

    this.paving = new THREE.MeshStandardMaterial({
      name: 'loco/dressPaving',
      map: pave,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
      envMapIntensity: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -3,
    });
    this.patch(this.paving, 'loco/dress-paving-v1', { wet: 1 });

    this.water = new THREE.MeshStandardMaterial({
      name: 'loco/dressWater',
      color: DRESS.water,
      vertexColors: true,
      roughness: 0.07,
      metalness: 0.02,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.5,
    });
    this.patchWater(this.water);
  }

  /** Shared per-quality instance. Every holder must `release()` on dispose. */
  static acquire(quality: QualityTier): DressKit {
    let kit = KIT_CACHE.get(quality);
    if (!kit) {
      kit = new DressKit(quality);
      KIT_CACHE.set(quality, kit);
    }
    kit.refs++;
    return kit;
  }

  /**
   * Borrow the world's shared rain drive. Safe to call more than once (both
   * layers do); the first non-null source wins.
   */
  useWetness(src: WetnessSource | null | undefined): void {
    if (!src) return;
    if (this.wet !== src.wetnessUniform) {
      this.wet = src.wetnessUniform;
      for (const m of [this.solid, this.cloth, this.foliage, this.sign, this.paving]) {
        m.needsUpdate = true;
      }
    }
  }

  private patch(
    mat: THREE.MeshStandardMaterial,
    key: string,
    opt: { wave?: boolean; glow?: boolean; wet?: number },
  ): void {
    const u = this.uniforms;
    const wetAmount = { value: clamp01(opt.wet ?? 0) };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDressCam = u.uDressCam;
      shader.uniforms.uDressCull = u.uDressCull;
      let pars = CULL_PARS;
      let apply = CULL_APPLY;
      if (opt.wave) {
        shader.uniforms.uDressTime = u.uDressTime;
        shader.uniforms.uDressWind = u.uDressWind;
        pars = `${WAVE_PARS}\n${pars}`;
        apply = `${WAVE_APPLY}\n${apply}`;
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${pars}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${apply}`);

      if (opt.glow) {
        shader.uniforms.uDressNight = u.uDressNight;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uDressNight;')
          .replace('#include <emissivemap_fragment>', GLOW_FRAG);
      }
      if ((opt.wet ?? 0) > 0) {
        shader.uniforms.uDressWet = this.wet;
        shader.uniforms.uDressWetAmount = wetAmount;
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uDressWet;\nuniform float uDressWetAmount;',
          )
          .replace(
            '#include <map_fragment>',
            '#include <map_fragment>\n\tdiffuseColor.rgb *= mix( 1.0, 0.5, uDressWet * uDressWetAmount );',
          )
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, roughnessFactor * 0.16 + 0.03, uDressWet * uDressWetAmount );',
          );
      }
    };
    mat.customProgramCacheKey = () => key;
  }

  private patchWater(mat: THREE.MeshStandardMaterial): void {
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDressTime = u.uDressTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WATER_PARS}`)
        .replace('#include <begin_vertex>', WATER_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${WATER_FRAG_PARS}`)
        .replace('#include <map_fragment>', WATER_FRAG);
    };
    mat.customProgramCacheKey = () => 'loco/dress-water-v1';
  }

  /**
   * Advance the shared clocks. `night` 0..1 lifts the emissive props; `cull`
   * is the current `propDetailDistance`.
   *
   * Both dressing layers call this every frame, so the *first* holder to call
   * becomes the driver and the others are no-ops — otherwise the wind clock
   * would run at N× speed with N layers attached.
   */
  update(
    dt: number,
    night: number,
    camera: THREE.Vector3,
    cull: number,
    holder: object,
  ): void {
    if (this.driver === null) this.driver = holder;
    if (this.driver !== holder) return;
    this.uniforms.uDressTime.value += dt;
    this.uniforms.uDressNight.value = night;
    this.uniforms.uDressCam.value.copy(camera);
    this.uniforms.uDressCull.value.set(cull, Math.min(28, cull * 0.32));
  }

  get materials(): readonly THREE.MeshStandardMaterial[] {
    return [this.solid, this.cloth, this.foliage, this.glow, this.sign, this.paving, this.water];
  }

  release(holder?: object): void {
    if (holder && this.driver === holder) this.driver = null;
    this.refs--;
    if (this.refs > 0) return;
    KIT_CACHE.delete(this.quality);
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}

/* ========================================================================== *
 *  cluster builder — merged geometry that still culls by distance
 * ========================================================================== */

/**
 * A `GeoBuilder` that remembers which vertices belong to which prop, so the
 * finished merged mesh can still be culled prop-by-prop in the vertex shader.
 *
 * Usage: `cb.open(x, y, z, mul)`, author into `cb.g`, `cb.close()`.
 */
export class ClusterBuilder {
  readonly g: GeoBuilder;
  private anchors: number[] = [];
  private start = 0;
  private ax = 0;
  private ay = 0;
  private az = 0;
  private mul = 1;
  private open_ = false;

  constructor(aux = false) {
    this.g = aux ? new GeoBuilder().enableAux() : new GeoBuilder();
  }

  open(x: number, y: number, z: number, mul = 1): this {
    if (this.open_) this.close();
    this.start = this.g.vertexCount;
    this.ax = x;
    this.ay = y;
    this.az = z;
    this.mul = mul;
    this.open_ = true;
    return this;
  }

  close(): void {
    if (!this.open_) return;
    const end = this.g.vertexCount;
    for (let i = this.start; i < end; i++) this.anchors.push(this.ax, this.ay, this.az, this.mul);
    this.open_ = false;
  }

  get triangles(): number {
    return this.g.triangleCount;
  }

  /** Build, attaching the per-vertex anchor. Returns null when empty. */
  build(auxName = 'aWave'): THREE.BufferGeometry | null {
    this.close();
    const geo = this.g.build(auxName);
    if (!geo) return null;
    const count = geo.getAttribute('position').count;
    const data = new Float32Array(count * 4);
    const n = Math.min(count * 4, this.anchors.length);
    for (let i = 0; i < n; i++) data[i] = this.anchors[i];
    // any vertex authored outside a cluster never culls
    for (let i = n; i < count * 4; i += 4) data[i + 3] = 1e4;
    geo.setAttribute('aAnchor', new THREE.BufferAttribute(data, 4));
    return geo;
  }
}

/* ========================================================================== *
 *  instancing
 * ========================================================================== */

export interface DressPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale?: number;
  scaleY?: number;
  tint?: number;
  /** cull-distance multiplier; > 1 for landmarks that must stay visible */
  cull?: number;
}

const _col = new THREE.Color();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * One `InstancedMesh` from a geometry and a placement list, carrying the
 * per-instance cull multiplier the shared shader reads.
 */
export function dressInstanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  list: readonly DressPlacement[],
  name: string,
  tinted = false,
): THREE.InstancedMesh | null {
  if (list.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  mesh.name = name;
  const cull = new Float32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    _pos.set(it.x, it.y, it.z);
    _quat.setFromAxisAngle(_up, it.yaw);
    const s = it.scale ?? 1;
    _scl.set(s, it.scaleY ?? s, s);
    _mat4.compose(_pos, _quat, _scl);
    mesh.setMatrixAt(i, _mat4);
    cull[i] = it.cull ?? 1;
    if (tinted) {
      _col.setHex(it.tint ?? 0xffffff, THREE.SRGBColorSpace);
      mesh.setColorAt(i, _col);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // every geometry here belongs to exactly one InstancedMesh, so the per-
  // instance cull attribute can live on it directly
  geo.setAttribute('aCullMul', new THREE.InstancedBufferAttribute(cull, 1));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 2.5;
  return mesh;
}

export function triCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (idx) return idx.count / 3;
  const pos = geo.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/* ========================================================================== *
 *  merging built geometry into a cluster builder
 * ========================================================================== */

const _qA = new THREE.Quaternion();
const _pA = new THREE.Vector3();
const _nA = new THREE.Vector3();

/**
 * Append a built geometry into a cluster builder at a world transform. Used
 * for the handful of unique landmarks, which are authored around the origin
 * but merged into the shared per-material mesh.
 */
export function appendGeometry(
  cb: ClusterBuilder,
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  yaw = 0,
  scale = 1,
  scaleY = 1,
): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const col = geo.getAttribute('color');
  const aux = (geo.getAttribute('aWave') ?? geo.getAttribute('aWater')) as
    | THREE.BufferAttribute
    | undefined;
  const idx = geo.getIndex();
  if (!pos || !idx) return;
  _qA.setFromAxisAngle(_up, yaw);
  const base = cb.g.vertexCount;
  for (let i = 0; i < pos.count; i++) {
    _pA.set(pos.getX(i) * scale, pos.getY(i) * scaleY, pos.getZ(i) * scale).applyQuaternion(_qA);
    const nx = nrm ? nrm.getX(i) : 0;
    const ny = nrm ? nrm.getY(i) : 1;
    const nz = nrm ? nrm.getZ(i) : 0;
    _nA.set(nx, ny, nz).applyQuaternion(_qA);
    cb.g.vertex(
      _pA.x + x,
      _pA.y + y,
      _pA.z + z,
      _nA.x,
      _nA.y,
      _nA.z,
      uv ? uv.getX(i) : 0,
      uv ? uv.getY(i) : 0,
      col ? col.getX(i) : 1,
      col ? col.getY(i) : 1,
      col ? col.getZ(i) : 1,
      aux ? aux.getX(i) : 0,
      aux ? aux.getY(i) : 0,
      aux ? aux.getZ(i) : 0,
    );
  }
  for (let i = 0; i < idx.count; i += 3) {
    cb.g.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
  }
}

/**
 * Merge a placement list into a cluster builder instead of instancing it.
 * Worth doing below roughly thirty copies, where a whole draw call costs more
 * than the duplicated vertices. `dispose` frees the source geometry.
 */
export function mergeInstances(
  cb: ClusterBuilder,
  geo: THREE.BufferGeometry,
  list: readonly DressPlacement[],
  dispose = false,
): void {
  for (const it of list) {
    cb.open(it.x, it.y, it.z, it.cull ?? 1);
    appendGeometry(cb, geo, it.x, it.y, it.z, it.yaw, it.scale ?? 1, it.scaleY ?? it.scale ?? 1);
    cb.close();
  }
  if (dispose) geo.dispose();
}

/* ========================================================================== *
 *  placement guard
 * ========================================================================== */

/**
 * The single rule every dressing prop obeys: never in a carriageway, never
 * inside a building footprint. Backed by a uniform grid over the lot polygons
 * and by the road graph's own nearest-edge query.
 */
export class PlacementGuard {
  private layout: CityLayout;
  private cell = 16;
  private grid = new Map<number, number[]>();
  private probe = new THREE.Vector3();

  constructor(layout: CityLayout) {
    this.layout = layout;
    for (let li = 0; li < layout.lots.length; li++) {
      const poly = layout.lots[li].polygon;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minZ) minZ = p.y;
        if (p.y > maxZ) maxZ = p.y;
      }
      const i0 = Math.floor(minX / this.cell);
      const i1 = Math.floor(maxX / this.cell);
      const j0 = Math.floor(minZ / this.cell);
      const j1 = Math.floor(maxZ / this.cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * 100003 + j;
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(li);
        }
      }
    }
  }

  /** True when (x,z) is inside any lot footprint, grown by `pad` metres. */
  inFootprint(x: number, z: number, pad = 0): boolean {
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const key = (Math.floor(x / this.cell) + di) * 100003 + (Math.floor(z / this.cell) + dj);
        const list = this.grid.get(key);
        if (!list) continue;
        for (const li of list) {
          if (pointInPolygon(x, z, this.layout.lots[li].polygon, pad)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Metres between (x,z) and the nearest carriageway edge. Negative means the
   * point is *in* the carriageway. `Infinity` when no road is within 40 m.
   */
  roadClearance(x: number, z: number): number {
    this.probe.set(x, 0, z);
    const s = this.layout.roads.nearest(this.probe, 40);
    if (!s) return Infinity;
    const ed = this.layout.roads.edges[s.edgeId];
    return s.dist - ed.width * 0.5;
  }

  /** The standard test: outside every footprint and clear of every kerb. */
  ok(x: number, z: number, margin = 0.35, footprintPad = 0.15): boolean {
    if (this.inFootprint(x, z, footprintPad)) return false;
    return this.roadClearance(x, z) >= margin;
  }

  /**
   * Surface height for a prop at (x,z). Props on an open area sit on the area
   * mesh (ground + 12 mm); props on a street sit on the pavement, which the
   * ground module lays a kerb height above the *centreline* elevation — so the
   * road sample, not the height grid, is the authority there.
   */
  surfaceY(x: number, z: number, onArea: boolean): number {
    if (onArea) return this.layout.groundHeight(x, z) + 0.014;
    this.probe.set(x, 0, z);
    const s = this.layout.roads.nearest(this.probe, 26);
    const g = this.layout.groundHeight(x, z);
    if (!s) return g + 0.014;
    const ed = this.layout.roads.edges[s.edgeId];
    if (ed.kind !== 'street' && ed.kind !== 'coastal') return g + 0.02;
    // pavement: kerb 0.14 at the kerb line rising 0.04 to the building line
    const over = clamp01((s.dist - ed.width * 0.5) / 2.4);
    return s.point.y + 0.14 + 0.01 + 0.04 * over;
  }
}

/** Even-odd point-in-polygon with an outward pad. */
export function pointInPolygon(
  x: number,
  z: number,
  poly: readonly THREE.Vector2[],
  pad = 0,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi.y > z !== pj.y > z) {
      const t = (z - pi.y) / (pj.y - pi.y);
      if (x < pi.x + t * (pj.x - pi.x)) inside = !inside;
    }
  }
  if (inside || pad <= 0) return inside;
  // outside: still reject when within `pad` of an edge
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distToSegment(x, z, poly[j].x, poly[j].y, poly[i].x, poly[i].y) < pad) return true;
  }
  return false;
}

export function distToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-9 ? clamp01(((px - ax) * dx + (pz - az) * dz) / len2) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** The front edge of a lot, in world XZ, with its outward normal. */
export interface FrontEdge {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** midpoint */
  mx: number;
  mz: number;
  /** unit vector along the frontage */
  ux: number;
  uz: number;
  /** outward unit normal */
  nx: number;
  nz: number;
  len: number;
  yaw: number;
}

export function frontEdgeOf(lot: Lot): FrontEdge {
  const poly = lot.polygon;
  const i0 = lot.frontEdge % poly.length;
  const i1 = (i0 + 1) % poly.length;
  const p0 = poly[i0];
  const p1 = poly[i1];
  const dx = p1.x - p0.x;
  const dz = p1.y - p0.y;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  let nx = lot.facing.x;
  let nz = lot.facing.y;
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl;
  nz /= nl;
  return {
    x0: p0.x,
    z0: p0.y,
    x1: p1.x,
    z1: p1.y,
    mx: (p0.x + p1.x) * 0.5,
    mz: (p0.y + p1.y) * 0.5,
    ux,
    uz,
    nx,
    nz,
    len,
    yaw: Math.atan2(nx, nz),
  };
}

/* ========================================================================== *
 *  small geometry helpers
 * ========================================================================== */

const _v = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
];
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c2 = new THREE.Color();

/** Quad with explicit atlas UVs — the only way onto the sign material. */
export function quadUV(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  rect: SignRect,
  color = 0xffffff,
  wave?: THREE.Vector3,
): void {
  _e1.subVectors(b, a);
  _e2.subVectors(d, a);
  _n.crossVectors(_e1, _e2);
  if (_n.lengthSq() < 1e-12) return;
  _n.normalize();
  _c2.setHex(color, THREE.SRGBColorSpace);
  const wx = wave?.x ?? 0;
  const wy = wave?.y ?? 0;
  const wz = wave?.z ?? 0;
  const i0 = g.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, rect.u0, rect.v0, _c2.r, _c2.g, _c2.b, wx, wy, wz);
  const i1 = g.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, rect.u1, rect.v0, _c2.r, _c2.g, _c2.b, wx, wy, wz);
  const i2 = g.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, rect.u1, rect.v1, _c2.r, _c2.g, _c2.b, wx, wy, wz);
  const i3 = g.vertex(d.x, d.y, d.z, _n.x, _n.y, _n.z, rect.u0, rect.v1, _c2.r, _c2.g, _c2.b, wx, wy, wz);
  g.quadIdx(i0, i1, i2, i3);
}

/** Two-sided card on the sign atlas. */
export function signCard(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  rect: SignRect,
  color = 0xffffff,
): void {
  quadUV(g, a, b, c, d, rect, color);
  quadUV(g, d, c, b, a, { u0: rect.u1, v0: rect.v1, u1: rect.u0, v1: rect.v0 }, shade(color, 0.7));
}

/** Blank-cell quad on the sign material — colour comes from the vertex. */
export function blankQuad(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  color: number,
): void {
  const u = BLANK_UV.u;
  const v = BLANK_UV.v;
  quadUV(g, a, b, c, d, { u0: u, v0: v, u1: u, v1: v }, color);
}

/**
 * Colour card with 0..1 UVs and the wind channel. Single-sided on purpose —
 * the cloth and foliage materials are `DoubleSide`, so a second copy would be
 * pure waste, and three flips the normal for the back face anyway.
 */
export function windCard(
  g: GeoBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  color: number,
  wave: THREE.Vector3,
): void {
  _e1.subVectors(b, a);
  _e2.subVectors(d, a);
  _n.crossVectors(_e1, _e2);
  if (_n.lengthSq() < 1e-12) return;
  _n.normalize();
  _c2.setHex(color, THREE.SRGBColorSpace);
  const r = _c2.r;
  const gr = _c2.g;
  const bl = _c2.b;
  const i0 = g.vertex(a.x, a.y, a.z, _n.x, _n.y, _n.z, 0, 0, r, gr, bl, wave.x, wave.y, wave.z);
  const i1 = g.vertex(b.x, b.y, b.z, _n.x, _n.y, _n.z, 1, 0, r, gr, bl, wave.x, wave.y, wave.z);
  const i2 = g.vertex(c.x, c.y, c.z, _n.x, _n.y, _n.z, 1, 1, r, gr, bl, wave.x, wave.y, wave.z);
  const i3 = g.vertex(d.x, d.y, d.z, _n.x, _n.y, _n.z, 0, 1, r, gr, bl, wave.x, wave.y, wave.z);
  g.quadIdx(i0, i1, i2, i3);
}

/** Regular n-gon prism ring, tapered, optionally capped. Cheap stone drums. */
export function polyDrum(
  g: GeoBuilder,
  cx: number,
  cy: number,
  cz: number,
  rBottom: number,
  rTop: number,
  height: number,
  sides: number,
  color: number,
  cap = true,
  phase = 0,
): void {
  const slope = (rBottom - rTop) / Math.max(height, 1e-4);
  const inv = 1 / Math.hypot(1, slope);
  const ring0: number[] = [];
  const ring1: number[] = [];
  _c2.setHex(color, THREE.SRGBColorSpace);
  const top = shade(color, 1.04);
  const ct = new THREE.Color().setHex(top, THREE.SRGBColorSpace);
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2 + phase;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    ring0.push(
      g.vertex(cx + ca * rBottom, cy, cz + sa * rBottom, ca * inv, slope * inv, sa * inv,
        i / sides, 0, _c2.r, _c2.g, _c2.b),
    );
    ring1.push(
      g.vertex(cx + ca * rTop, cy + height, cz + sa * rTop, ca * inv, slope * inv, sa * inv,
        i / sides, height * 0.4, ct.r, ct.g, ct.b),
    );
  }
  for (let i = 0; i < sides; i++) g.quadIdx(ring0[i], ring0[i + 1], ring1[i + 1], ring1[i]);
  if (cap && rTop > 1e-4) {
    const centre = g.vertex(cx, cy + height, cz, 0, 1, 0, 0.5, 0.5, ct.r, ct.g, ct.b);
    const cr: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2 + phase;
      cr.push(
        g.vertex(cx + Math.cos(a) * rTop, cy + height, cz + Math.sin(a) * rTop, 0, 1, 0,
          0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, ct.r, ct.g, ct.b),
      );
    }
    for (let i = 0; i < sides; i++) g.tri(centre, cr[i], cr[i + 1]);
  }
}

/** Flat n-gon disc facing +Y, with an aux channel for the water shader. */
function polyDisc(
  g: GeoBuilder,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  sides: number,
  color: number,
  aux: THREE.Vector3,
): void {
  _c2.setHex(color, THREE.SRGBColorSpace);
  const centre = g.vertex(cx, cy, cz, 0, 1, 0, 0.5, 0.5, _c2.r, _c2.g, _c2.b, aux.x, aux.y, aux.z);
  const ring: number[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push(
      g.vertex(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r, 0, 1, 0,
        0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5,
        _c2.r, _c2.g, _c2.b, aux.x, aux.y, aux.z),
    );
  }
  for (let i = 0; i < sides; i++) g.tri(centre, ring[i], ring[i + 1]);
}

/* ========================================================================== *
 *  the fountain
 * ========================================================================== */

/** Overall radii of the plaza fountain, metres. */
export const FOUNTAIN = {
  /** outer step */
  stepR: 4.35,
  /** basin outside face */
  basinR: 3.45,
  /** basin inside face */
  poolR: 3.02,
  /** coping top — sittable, §1.8 bench height */
  copingY: 0.94,
  /** water level in the basin */
  poolY: 0.7,
  /** lower bowl */
  bowlR: 1.46,
  bowlY: 2.18,
  /** upper bowl */
  topBowlR: 0.74,
  topBowlY: 3.16,
  height: 3.95,
} as const;

/**
 * A stylised draped female figure — the *Cuatro Estaciones* group of a
 * Spanish colonial plaza fountain. Silhouette first: a flaring skirt, a
 * cinched waist, a shawl over the shoulders, arms lifted to an urn.
 */
function carvedFigure(g: GeoBuilder, p: Placer, height: number, stone: number): void {
  const s = height / 1.62;
  const dark = shade(stone, 0.88);
  const lit = shade(stone, 1.06);
  const at = (x: number, y: number, z: number): THREE.Vector3 => p.at(x, y * s, z);
  const base = at(0, 0, 0);

  // plinth block under the figure
  polyDrum(g, base.x, base.y, base.z, 0.3 * s, 0.27 * s, 0.14 * s, 6, dark);
  // skirt: two flaring drums, then the taper to the waist
  polyDrum(g, base.x, base.y + 0.14 * s, base.z, 0.27 * s, 0.33 * s, 0.34 * s, 8, stone, false);
  polyDrum(g, base.x, base.y + 0.48 * s, base.z, 0.33 * s, 0.19 * s, 0.4 * s, 8, stone, false);
  // torso and shawl
  polyDrum(g, base.x, base.y + 0.88 * s, base.z, 0.19 * s, 0.21 * s, 0.26 * s, 8, lit, false);
  polyDrum(g, base.x, base.y + 1.14 * s, base.z, 0.24 * s, 0.13 * s, 0.14 * s, 8, stone, false);
  // neck + head
  polyDrum(g, base.x, base.y + 1.28 * s, base.z, 0.07 * s, 0.09 * s, 0.08 * s, 6, lit, false);
  polyDrum(g, base.x, base.y + 1.36 * s, base.z, 0.11 * s, 0.12 * s, 0.13 * s, 7, lit, false);
  polyDrum(g, base.x, base.y + 1.49 * s, base.z, 0.12 * s, 0.02 * s, 0.08 * s, 7, stone);
  // arms, raised forward-and-up to the urn
  const shoulderL = at(-0.19, 1.1, 0.02);
  const shoulderR = at(0.19, 1.1, 0.02);
  const handL = at(-0.13, 1.5, 0.26);
  const handR = at(0.13, 1.5, 0.26);
  strut(g, shoulderL, at(-0.24, 1.28, 0.16), 0.05 * s, stone);
  strut(g, at(-0.24, 1.28, 0.16), handL, 0.045 * s, lit);
  strut(g, shoulderR, at(0.24, 1.28, 0.16), 0.05 * s, stone);
  strut(g, at(0.24, 1.28, 0.16), handR, 0.045 * s, lit);
  // the urn the pair of hands lift
  const urn = at(0, 1.5, 0.3);
  polyDrum(g, urn.x, urn.y, urn.z, 0.09 * s, 0.15 * s, 0.16 * s, 8, dark, false);
  polyDrum(g, urn.x, urn.y + 0.16 * s, urn.z, 0.15 * s, 0.12 * s, 0.1 * s, 8, stone);
}

/**
 * The whole fountain: stepped base, octagonal basin, central column, two
 * bowls, four figures. Authored around the origin; `y = 0` is the paving.
 */
export function buildFountainStone(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const F = FOUNTAIN;
  const stone = DRESS.stoneLight;
  const mid = DRESS.stoneMid;
  const deep = DRESS.stoneShade;

  // two steps up out of the paving
  polyDrum(g, 0, 0, 0, F.stepR + 0.35, F.stepR + 0.3, 0.17, 8, mid, false);
  polyDrum(g, 0, 0.17, 0, F.stepR + 0.02, F.stepR, 0.18, 8, DRESS.stoneLight, false);
  polyDrum(g, 0, 0.35, 0, F.stepR, F.stepR, 0.02, 8, DRESS.stoneMid);

  // basin: outer face, pool floor, inner face, coping
  polyDrum(g, 0, 0.37, 0, F.basinR, F.basinR - 0.06, F.copingY - 0.37, 8, stone, false);
  polyDrum(g, 0, 0.4, 0, F.poolR, F.poolR, 0.02, 8, DRESS.stoneWet, true);
  polyDrum(g, 0, 0.42, 0, F.poolR, F.poolR, F.copingY - 0.48, 8, shade(deep, 0.92), false);
  polyDrum(g, 0, F.copingY - 0.08, 0, F.basinR + 0.14, F.basinR + 0.12, 0.08, 8, DRESS.stoneLight, false);
  polyDrum(g, 0, F.copingY, 0, F.basinR + 0.12, F.poolR - 0.02, 0.02, 8, DRESS.stoneLight, false);

  // pedestal and column
  polyDrum(g, 0, 0.42, 0, 0.95, 0.86, 0.3, 8, mid, false);
  polyDrum(g, 0, 0.72, 0, 0.86, 0.8, 0.1, 8, DRESS.stoneLight, true);
  polyDrum(g, 0, 0.82, 0, 0.5, 0.42, 1.16, 10, stone, false);
  // a shallow torus of mouldings under the lower bowl
  polyDrum(g, 0, 1.98, 0, 0.46, 0.62, 0.1, 10, DRESS.stoneLight, false);
  polyDrum(g, 0, 2.08, 0, 0.62, F.bowlR, 0.1, 12, mid, false);
  polyDrum(g, 0, F.bowlY - 0.02, 0, F.bowlR, F.bowlR, 0.02, 12, DRESS.stoneWet, true);
  polyDrum(g, 0, F.bowlY, 0, F.bowlR, F.bowlR - 0.09, 0.14, 12, DRESS.stoneLight, false);

  // upper stem, upper bowl, finial
  polyDrum(g, 0, F.bowlY + 0.02, 0, 0.28, 0.22, 0.84, 8, stone, false);
  polyDrum(g, 0, F.bowlY + 0.86, 0, 0.3, F.topBowlR, 0.14, 10, mid, false);
  polyDrum(g, 0, F.topBowlY - 0.02, 0, F.topBowlR, F.topBowlR, 0.02, 10, DRESS.stoneWet, true);
  polyDrum(g, 0, F.topBowlY, 0, F.topBowlR, F.topBowlR - 0.06, 0.1, 10, DRESS.stoneLight, false);
  polyDrum(g, 0, F.topBowlY + 0.06, 0, 0.16, 0.11, 0.46, 6, stone, false);
  polyDrum(g, 0, F.topBowlY + 0.52, 0, 0.15, 0.02, 0.24, 6, DRESS.stoneLight, true);

  // four figures on the pedestal, facing outward
  const p = new Placer();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const r = 0.74;
    p.set(Math.cos(a) * r, 0.82, Math.sin(a) * r, -a + Math.PI * 0.5);
    carvedFigure(g, p, rng.range(1.52, 1.66), i % 2 === 0 ? DRESS.stoneLight : DRESS.stoneMid);
  }

  const geo = g.build('aDress');
  return geo ?? new THREE.BufferGeometry();
}

/** The animated water: pool surfaces, two falling veils, four arcing jets. */
export function buildFountainWater(): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const F = FOUNTAIN;
  const pool = new THREE.Vector3(0, 0, 0);
  const veil = new THREE.Vector3(1, 0, 0);
  const jet = new THREE.Vector3(2, 0, 0);

  // pool surface, ring only (the column occupies the middle)
  polyDisc(g, 0, F.poolY, 0, F.poolR - 0.05, 20, DRESS.water, pool);
  polyDisc(g, 0, F.bowlY + 0.08, 0, F.bowlR - 0.14, 14, DRESS.water, pool);
  polyDisc(g, 0, F.topBowlY + 0.06, 0, F.topBowlR - 0.1, 10, DRESS.water, pool);

  // falling veils: an open drum from each bowl rim to the water below
  const veilDrum = (r: number, yTop: number, yBot: number, sides: number, key: number): void => {
    _c2.setHex(DRESS.foam, THREE.SRGBColorSpace);
    const ring0: number[] = [];
    const ring1: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const u = i / sides;
      ring0.push(
        g.vertex(ca * r, yTop, sa * r, ca, 0, sa, u, 0, _c2.r, _c2.g, _c2.b, veil.x, u + key, 0),
      );
      ring1.push(
        g.vertex(ca * r * 1.04, yBot, sa * r * 1.04, ca, 0, sa, u, 1, _c2.r, _c2.g, _c2.b, veil.x, u + key, 0),
      );
    }
    for (let i = 0; i < sides; i++) g.quadIdx(ring0[i], ring0[i + 1], ring1[i + 1], ring1[i]);
  };
  veilDrum(F.bowlR - 0.03, F.bowlY + 0.09, F.poolY + 0.02, 16, 0.0);
  veilDrum(F.topBowlR - 0.02, F.topBowlY + 0.07, F.bowlY + 0.1, 12, 0.37);

  // four jets arcing from the figures' urns into the basin
  const arc = (i: number): void => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x0 = ca * 1.06;
    const z0 = sa * 1.06;
    const y0 = 2.42;
    const x1 = ca * 2.42;
    const z1 = sa * 2.42;
    const y1 = F.poolY;
    const steps = 7;
    _c2.setHex(DRESS.foam, THREE.SRGBColorSpace);
    let prev: number[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = y0 + (y1 - y0) * t + Math.sin(Math.PI * t) * 0.42;
      const w = 0.045 * (1 - t * 0.35);
      const px = -sa * w;
      const pz = ca * w;
      const k = Math.sin(Math.PI * t);
      const cur = [
        g.vertex(x + px, y, z + pz, 0, 1, 0, 0, t, _c2.r, _c2.g, _c2.b, jet.x, k, i * 0.25),
        g.vertex(x - px, y, z - pz, 0, 1, 0, 1, t, _c2.r, _c2.g, _c2.b, jet.x, k, i * 0.25),
        g.vertex(x, y + w, z, 0, 1, 0, 0.5, t, _c2.r, _c2.g, _c2.b, jet.x, k, i * 0.25),
      ];
      if (s > 0) {
        g.quadIdx(prev[0], cur[0], cur[1], prev[1]);
        g.quadIdx(prev[1], cur[1], cur[2], prev[2]);
        g.quadIdx(prev[2], cur[2], cur[0], prev[0]);
      }
      prev = cur;
    }
  };
  for (let i = 0; i < 4; i++) arc(i);

  const geo = g.build('aWater');
  return geo ?? new THREE.BufferGeometry();
}

/* ========================================================================== *
 *  plaza furniture
 * ========================================================================== */

/**
 * Curved stone bench — the ring of seats around a fountain. Authored as a
 * 42° arc at radius `r`, so eight of them close a circle with gaps to walk
 * through.
 */
export function buildStoneBench(radius = 5.2, sweep = 0.62): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const steps = 6;
  const w = 0.52;
  const seat = 0.46;
  for (let i = 0; i < steps; i++) {
    const a0 = -sweep * 0.5 + (sweep * i) / steps;
    const a1 = -sweep * 0.5 + (sweep * (i + 1)) / steps;
    const p = (a: number, r: number, y: number): THREE.Vector3 =>
      new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
    const r0 = radius - w * 0.5;
    const r1 = radius + w * 0.5;
    // seat slab
    g.quad(p(a0, r0, seat), p(a1, r0, seat), p(a1, r1, seat), p(a0, r1, seat), DRESS.stoneLight, 0.6);
    // outer and inner faces
    g.quad(p(a0, r1, 0.06), p(a1, r1, 0.06), p(a1, r1, seat), p(a0, r1, seat), DRESS.stoneMid, 0.6);
    g.quad(p(a1, r0, 0.06), p(a0, r0, 0.06), p(a0, r0, seat), p(a1, r0, seat), DRESS.stoneShade, 0.6);
    // ends
    if (i === 0) g.quad(p(a0, r0, 0.06), p(a0, r1, 0.06), p(a0, r1, seat), p(a0, r0, seat), DRESS.stoneMid, 0.6);
    if (i === steps - 1) {
      g.quad(p(a1, r1, 0.06), p(a1, r0, 0.06), p(a1, r0, seat), p(a1, r1, seat), DRESS.stoneMid, 0.6);
    }
  }
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/**
 * The *glorieta*: an octagonal bandstand — stone plinth, eight fluted iron
 * posts, an arched frieze, a shallow ribbed dome and a finial. Built once and
 * placed at plaza scale.
 */
export function buildKiosk(rng: RNG): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const g = new GeoBuilder();
  const lamp = new GeoBuilder();
  const sides = 8;
  const r = 3.5;
  const deckY = 0.62;
  const eaveY = 3.55;

  // plinth: two steps and the deck
  polyDrum(g, 0, 0, 0, r + 0.7, r + 0.62, 0.2, sides, DRESS.stoneMid, false);
  polyDrum(g, 0, 0.2, 0, r + 0.42, r + 0.34, 0.2, sides, DRESS.stoneLight, false);
  polyDrum(g, 0, 0.4, 0, r + 0.14, r + 0.06, 0.22, sides, DRESS.stoneMid, false);
  polyDrum(g, 0, deckY, 0, r + 0.06, r + 0.02, 0.03, sides, DRESS.paveWarm);

  // posts + balustrade
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    polyDrum(g, x, deckY, z, 0.14, 0.11, 0.18, 6, DRESS.iron, false);
    polyDrum(g, x, deckY + 0.18, z, 0.11, 0.085, eaveY - deckY - 0.34, 6, DRESS.kioskPost, false);
    polyDrum(g, x, eaveY - 0.16, z, 0.13, 0.16, 0.16, 6, DRESS.kioskPost, false);

    // the balustrade panel between this post and the next, minus one bay
    // (the stair) — 6 turned balusters and a top rail
    const a2 = ((i + 1) / sides) * Math.PI * 2;
    if (i === 0) continue;
    const x2 = Math.cos(a2) * r;
    const z2 = Math.sin(a2) * r;
    for (let b = 1; b < 6; b++) {
      const t = b / 6;
      const bx = x + (x2 - x) * t;
      const bz = z + (z2 - z) * t;
      polyDrum(g, bx, deckY + 0.04, bz, 0.05, 0.038, 0.78, 5, DRESS.kioskTrim, false);
    }
    const railY = deckY + 0.82;
    const dx = x2 - x;
    const dz = z2 - z;
    const l = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    g.box((x + x2) * 0.5, railY, (z + z2) * 0.5, l * 0.5, 0.045, 0.07, DRESS.kioskTrim, yaw);
    g.box((x + x2) * 0.5, deckY + 0.05, (z + z2) * 0.5, l * 0.5, 0.045, 0.06, DRESS.kioskTrim, yaw);
  }

  // stair down out of bay 0
  const a0 = 0;
  for (let s = 0; s < 3; s++) {
    const y = deckY - 0.02 - s * 0.21;
    const w = 1.1;
    const d = 0.34;
    const cx = Math.cos(a0) * (r + 0.2 + s * d);
    const cz = Math.sin(a0) * (r + 0.2 + s * d);
    g.box(cx, y - 0.1, cz, d * 0.5, 0.1, w * 0.5, s % 2 === 0 ? DRESS.stoneLight : DRESS.stoneMid);
  }

  // frieze: shallow arches between the post heads
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const a2 = ((i + 1) / sides) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const x2 = Math.cos(a2) * r;
    const z2 = Math.sin(a2) * r;
    const segs = 5;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const drop = (t: number): number => 0.36 * Math.sin(Math.PI * t) + 0.06;
      const p = (t: number, y: number): THREE.Vector3 =>
        new THREE.Vector3(x + (x2 - x) * t, y, z + (z2 - z) * t);
      g.quad(
        p(t0, eaveY - drop(t0)),
        p(t1, eaveY - drop(t1)),
        p(t1, eaveY),
        p(t0, eaveY),
        DRESS.kioskPost,
        0.6,
      );
      g.quad(
        p(t1, eaveY - drop(t1)),
        p(t0, eaveY - drop(t0)),
        p(t0, eaveY),
        p(t1, eaveY),
        shade(DRESS.kioskPost, 0.78),
        0.6,
      );
    }
  }

  // entablature and dome
  polyDrum(g, 0, eaveY, 0, r + 0.34, r + 0.3, 0.16, sides, DRESS.kioskPost, false);
  polyDrum(g, 0, eaveY + 0.16, 0, r + 0.3, r * 0.92, 0.12, sides, shade(DRESS.kioskPost, 0.9), false);
  const domeSteps = 5;
  let prevR = r * 0.92;
  let prevY = eaveY + 0.28;
  for (let s = 1; s <= domeSteps; s++) {
    const t = s / domeSteps;
    const rr = r * 0.92 * Math.cos((t * Math.PI) / 2.28);
    const yy = eaveY + 0.28 + Math.sin((t * Math.PI) / 2.28) * 1.35;
    polyDrum(g, 0, prevY, 0, prevR, rr, yy - prevY, sides * 2, s % 2 === 0 ? DRESS.kioskRoof : shade(DRESS.kioskRoof, 1.08), false);
    prevR = rr;
    prevY = yy;
  }
  polyDrum(g, 0, prevY, 0, prevR, 0.16, 0.34, 8, shade(DRESS.kioskRoof, 0.86), false);
  polyDrum(g, 0, prevY + 0.34, 0, 0.1, 0.07, 0.5, 6, DRESS.bronze, false);
  polyDrum(g, 0, prevY + 0.84, 0, 0.11, 0.02, 0.2, 6, DRESS.bronze);

  // ceiling and its lamp — warm at night
  polyDrum(lamp, 0, eaveY - 0.02, 0, r * 0.9, r * 0.9, 0.02, sides, DRESS.kioskCeil);
  polyDrum(lamp, 0, eaveY - 0.42, 0, 0.1, 0.24, 0.36, 8, 0xffd9a0, true);
  void rng;

  return {
    solid: g.build('aDress') ?? new THREE.BufferGeometry(),
    glow: lamp.build('aDress') ?? new THREE.BufferGeometry(),
  };
}

/** Flagpole with a cast base — the plaza's three-pole group. */
export function buildFlagpole(height = 8.4): THREE.BufferGeometry {
  const g = new GeoBuilder();
  polyDrum(g, 0, 0, 0, 0.42, 0.36, 0.26, 8, DRESS.stoneMid, false);
  polyDrum(g, 0, 0.26, 0, 0.36, 0.3, 0.14, 8, DRESS.stoneLight);
  polyDrum(g, 0, 0.4, 0, 0.16, 0.12, 0.4, 8, DRESS.ironWorn, false);
  polyDrum(g, 0, 0.8, 0, 0.1, 0.055, height - 0.8, 8, 0xe8e6de, false);
  polyDrum(g, 0, height, 0, 0.075, 0.02, 0.18, 6, DRESS.bronze);
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/**
 * Pigeon — Parque de las Palomas is a real, named part of this city (§7.2).
 * A body, a tail wedge and a head, ~30 triangles.
 */
export function buildPigeon(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  polyDrum(g, 0, 0.05, 0, 0.055, 0.075, 0.1, 6, 0xffffff, false);
  polyDrum(g, 0, 0.15, 0, 0.075, 0.05, 0.05, 6, 0xffffff);
  g.box(0, 0.15, -0.13, 0.045, 0.012, 0.08, 0xf0eeea);
  polyDrum(g, 0, 0.19, 0.06, 0.038, 0.032, 0.07, 5, 0xffffff);
  g.box(0, 0.235, 0.11, 0.012, 0.012, 0.03, 0xd9a24a);
  for (const sx of [-0.03, 0.03]) g.box(sx, 0.02, 0, 0.006, 0.02, 0.006, 0xc4634a);
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/* ========================================================================== *
 *  street dressing parts
 * ========================================================================== */

/** Square stone planter — the big kerbside box with a shrub in it. */
export function buildPlanterBox(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const w = rng.range(0.52, 0.62);
  const h = rng.range(0.44, 0.56);
  g.box(0, h * 0.5, 0, w, h * 0.5, w, DRESS.planterStone);
  g.box(0, h + 0.03, 0, w + 0.05, 0.035, w + 0.05, DRESS.stoneLight);
  g.box(0, h - 0.02, 0, w - 0.07, 0.03, w - 0.07, DRESS.soil);
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/**
 * A pot with a small fan palm in it — the *palmita* outside every doorway in
 * the reference photographs. Foliage material; carries the wind channel.
 */
export function buildPottedPalm(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const still = new THREE.Vector3(0, 0.5, 0);
  const potR = rng.range(0.26, 0.32);
  polyDrum(g, 0, 0, 0, potR * 0.8, potR, 0.42, 9, DRESS.terracotta, false);
  polyDrum(g, 0, 0.42, 0, potR + 0.03, potR + 0.02, 0.06, 9, DRESS.terracottaPale, false);
  polyDrum(g, 0, 0.44, 0, potR - 0.02, potR - 0.02, 0.02, 8, DRESS.soil);
  void still;
  const h = rng.range(0.9, 1.5);
  polyDrum(g, 0, 0.46, 0, 0.07, 0.045, h * 0.42, 6, 0x7b6a4e, false);
  const fronds = rng.int(7, 10);
  const phase = rng.next();
  const wave = new THREE.Vector3();
  for (let i = 0; i < fronds; i++) {
    const ang = (i / fronds) * Math.PI * 2 + rng.range(-0.24, 0.24);
    const len = h * rng.range(0.55, 0.9);
    const droop = rng.range(0.42, 0.78);
    const wdt = rng.range(0.2, 0.32);
    const y0 = 0.46 + h * 0.4;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const tipY = y0 + len * (1 - droop) * 0.95;
    wave.set(0.3, phase, 0.42);
    windCard(
      g,
      new THREE.Vector3(-dz * wdt * 0.28, y0, dx * wdt * 0.28),
      new THREE.Vector3(dz * wdt * 0.28, y0, -dx * wdt * 0.28),
      new THREE.Vector3(dx * len * droop + dz * wdt * 0.5, tipY, dz * len * droop - dx * wdt * 0.5),
      new THREE.Vector3(dx * len * droop - dz * wdt * 0.5, tipY, dz * len * droop + dx * wdt * 0.5),
      [DRESS.palmFrond, DRESS.leafMid, DRESS.leafLit][i % 3],
      wave,
    );
  }
  return g.build('aWave') ?? new THREE.BufferGeometry();
}

/**
 * Hanging planter on an iron bracket — bolted under a balcony, trailing
 * bougainvillea. Authored so `y = 0` is the bracket's fixing point on the wall
 * and the plant hangs on local +Z (outward from the façade).
 */
export function buildHangingPlanter(rng: RNG, bloom: number): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const still = new THREE.Vector3(0, 0, 0);
  const reach = rng.range(0.42, 0.6);
  // bracket
  g.box(0, 0, 0.04, 0.03, 0.11, 0.04, DRESS.iron, 0, still);
  g.box(0, 0.09, reach * 0.5, 0.022, 0.022, reach * 0.5, DRESS.iron, 0, still);
  strut(g, new THREE.Vector3(0, -0.09, 0.05), new THREE.Vector3(0, 0.07, reach * 0.82), 0.016, DRESS.iron);
  // pot
  const potR = rng.range(0.15, 0.2);
  const potY = -0.28;
  polyDrum(g, 0, potY, reach, potR * 0.72, potR, 0.24, 8, DRESS.terracotta, false);
  polyDrum(g, 0, potY + 0.24, reach, potR + 0.02, potR, 0.03, 8, DRESS.terracottaPale);
  // three chains
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    strut(
      g,
      new THREE.Vector3(0, 0.07, reach * 0.9),
      new THREE.Vector3(Math.cos(a) * potR * 0.85, potY + 0.24, reach + Math.sin(a) * potR * 0.85),
      0.008,
      DRESS.ironWorn,
    );
  }
  // trailing growth
  const wave = new THREE.Vector3();
  const phase = rng.next();
  const cards = 6;
  for (let i = 0; i < cards; i++) {
    const a = (i / cards) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rad = rng.range(0.05, potR * 0.9);
    const drop = rng.range(0.4, 0.95);
    const w = rng.range(0.24, 0.4);
    const cx = Math.cos(a) * rad;
    const cz = reach + Math.sin(a) * rad;
    const dx = Math.cos(a + 1.57);
    const dz = Math.sin(a + 1.57);
    const yTop = potY + 0.3;
    wave.set(0.34, phase, 0.3);
    windCard(
      g,
      new THREE.Vector3(cx - dx * w * 0.5, yTop - drop, cz - dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, yTop - drop, cz + dz * w * 0.5),
      new THREE.Vector3(cx + dx * w * 0.5, yTop, cz + dz * w * 0.5),
      new THREE.Vector3(cx - dx * w * 0.5, yTop, cz - dz * w * 0.5),
      i % 3 === 0 ? bloom : i % 3 === 1 ? DRESS.leafMid : DRESS.leafDark,
      wave,
    );
  }
  return g.build('aWave') ?? new THREE.BufferGeometry();
}

/** Produce crate, stacked outside a colmado or on a market table. */
export function buildProduceCrate(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const w = rng.range(0.24, 0.3);
  const d = rng.range(0.17, 0.22);
  const h = rng.range(0.13, 0.18);
  g.box(0, h, 0, w, h, d, DRESS.crate);
  g.box(0, h * 2 - 0.02, 0, w - 0.02, 0.03, d - 0.02, DRESS.crateDark);
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    polyDrum(
      g,
      rng.range(-w * 0.6, w * 0.6),
      h * 2 - 0.01,
      rng.range(-d * 0.5, d * 0.5),
      0.055,
      0.045,
      0.075,
      5,
      rng.pick(DRESS.produce),
    );
  }
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/**
 * A-board frame (solid material). Two leaves hinged at 0.92 m, splayed 0.30 m
 * each way at the foot. The painted faces are a separate mesh on the sign
 * material, laid just inside each leaf.
 */
export const ABOARD = { top: 0.92, splay: 0.3, halfWidth: 0.32 } as const;

export function buildAboardFrame(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const wood = 0x6a5238;
  const dark = 0x453522;
  for (const sz of [-1, 1]) {
    for (const sx of [-ABOARD.halfWidth, ABOARD.halfWidth]) {
      strut(
        g,
        new THREE.Vector3(sx, 0, sz * ABOARD.splay),
        new THREE.Vector3(sx, ABOARD.top, sz * 0.02),
        0.024,
        wood,
      );
    }
    // top and bottom rails of each leaf
    g.box(0, ABOARD.top - 0.05, sz * 0.03, ABOARD.halfWidth, 0.03, 0.022, wood);
    g.box(0, 0.14, sz * ABOARD.splay * 0.82, ABOARD.halfWidth, 0.028, 0.022, wood);
  }
  // the hinge cap and a stay chain between the feet
  g.box(0, ABOARD.top + 0.02, 0, ABOARD.halfWidth + 0.03, 0.025, 0.05, dark);
  strut(
    g,
    new THREE.Vector3(0, 0.16, -ABOARD.splay * 0.8),
    new THREE.Vector3(0, 0.16, ABOARD.splay * 0.8),
    0.008,
    dark,
  );
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/** The two painted faces of an A-board, on the sign material. */
export function buildAboardFaces(key: DressSign): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const r = signRect(key);
  const w = ABOARD.halfWidth - 0.02;
  for (const sz of [-1, 1]) {
    const zTop = sz * 0.035;
    const zBot = sz * (ABOARD.splay * 0.86);
    const a = new THREE.Vector3(-w * sz, 0.16, zBot);
    const b = new THREE.Vector3(w * sz, 0.16, zBot);
    const c = new THREE.Vector3(w * sz, ABOARD.top - 0.06, zTop);
    const d = new THREE.Vector3(-w * sz, ABOARD.top - 0.06, zTop);
    quadUV(g, a, b, c, d, r, 0xffffff);
  }
  return g.build('aDress') ?? new THREE.BufferGeometry();
}

/**
 * Market stall: four poles, a striped canvas roof with a valance, a table of
 * goods. Cloth material (wind), so the awning breathes.
 */
export function buildStall(rng: RNG): THREE.BufferGeometry {
  const g = new GeoBuilder().enableAux();
  const w = 1.55;
  const d = 0.95;
  const h = 2.2;
  const still = new THREE.Vector3(0, 0, 0);
  const stripe = rng.pick(DRESS.awning);
  for (const sx of [-w, w]) {
    for (const sz of [-d, d]) {
      g.box(sx, h * 0.5, sz, 0.035, h * 0.5, 0.035, KIT.steel, 0, still);
    }
  }
  const bays = 6;
  const wave = new THREE.Vector3();
  for (let i = 0; i < bays; i++) {
    const x0 = -w + (2 * w * i) / bays;
    const x1 = -w + (2 * w * (i + 1)) / bays;
    const col = i % 2 === 0 ? stripe : 0xf7f4ec;
    wave.set(0.03, 0.3, 0.22);
    g.quad(
      new THREE.Vector3(x0, h, -d - 0.12),
      new THREE.Vector3(x1, h, -d - 0.12),
      new THREE.Vector3(x1, h + 0.34, 0),
      new THREE.Vector3(x0, h + 0.34, 0),
      col, 0.6, wave,
    );
    g.quad(
      new THREE.Vector3(x0, h + 0.34, 0),
      new THREE.Vector3(x1, h + 0.34, 0),
      new THREE.Vector3(x1, h, d + 0.12),
      new THREE.Vector3(x0, h, d + 0.12),
      col, 0.6, wave,
    );
    // underside, so the roof is not a one-sided sheet from below
    g.quad(
      new THREE.Vector3(x1, h + 0.33, 0),
      new THREE.Vector3(x0, h + 0.33, 0),
      new THREE.Vector3(x0, h - 0.01, -d - 0.12),
      new THREE.Vector3(x1, h - 0.01, -d - 0.12),
      shade(col, 0.6), 0.6, wave,
    );
    g.quad(
      new THREE.Vector3(x0, h + 0.33, 0),
      new THREE.Vector3(x1, h + 0.33, 0),
      new THREE.Vector3(x1, h - 0.01, d + 0.12),
      new THREE.Vector3(x0, h - 0.01, d + 0.12),
      shade(col, 0.6), 0.6, wave,
    );
    // scalloped valance on the customer side
    wave.set(0.09, 0.3, 0.62);
    windCard(
      g,
      new THREE.Vector3(x0, h - 0.26, d + 0.12),
      new THREE.Vector3(x1, h - 0.26, d + 0.12),
      new THREE.Vector3(x1, h, d + 0.12),
      new THREE.Vector3(x0, h, d + 0.12),
      col,
      wave,
    );
  }
  // table and goods
  g.box(0, 0.92, 0, w * 0.94, 0.03, d * 0.7, KIT.woodPale, 0, still);
  g.box(0, 0.68, 0, w * 0.9, 0.24, d * 0.62, shade(KIT.woodDark, 0.9), 0, still);
  const goods = rng.int(6, 10);
  for (let i = 0; i < goods; i++) {
    polyDrum(
      g,
      rng.range(-w * 0.82, w * 0.82),
      0.95,
      rng.range(-d * 0.42, d * 0.42),
      rng.range(0.07, 0.13),
      rng.range(0.05, 0.1),
      rng.range(0.09, 0.16),
      5,
      rng.pick(DRESS.produce),
    );
  }
  return g.build('aWave') ?? new THREE.BufferGeometry();
}

/* ========================================================================== *
 *  decorative paving
 * ========================================================================== */

/**
 * Lay a decorative pattern over an open area: a border band inside the kerb,
 * a field of losa, and a rosette of radiating bands around a focus point.
 * `poly` is the island polygon in world XZ; `heightAt` samples the ground.
 */
export function pavePattern(
  cb: ClusterBuilder,
  poly: readonly THREE.Vector2[],
  focus: { x: number; z: number },
  heightAt: (x: number, z: number) => number,
  rng: RNG,
  cullMul: number,
): void {
  if (poly.length < 3) return;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x;
    cz += p.y;
  }
  cx /= poly.length;
  cz /= poly.length;

  const g = cb.g;
  cb.open(cx, heightAt(cx, cz), cz, cullMul);

  const LIFT = 0.026;
  const at = (x: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(x, heightAt(x, z) + LIFT, z);

  // border bands, inset from the polygon edge by an absolute distance
  const inset = (d: number): { x: number; z: number }[] =>
    poly.map((p) => {
      const dx = cx - p.x;
      const dz = cz - p.y;
      const l = Math.hypot(dx, dz) || 1;
      return { x: p.x + (dx / l) * d, z: p.y + (dz / l) * d };
    });
  const outer = inset(0.34);
  const b1 = inset(0.94);
  const b2 = inset(1.24);
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    g.quad(at(outer[i].x, outer[i].z), at(outer[j].x, outer[j].z), at(b1[j].x, b1[j].z), at(b1[i].x, b1[i].z), DRESS.paveField, 0.34);
    g.quad(at(b1[i].x, b1[i].z), at(b1[j].x, b1[j].z), at(b2[j].x, b2[j].z), at(b2[i].x, b2[i].z), DRESS.paveDark, 0.34);
  }

  // the rosette: alternating radiating wedges around the focus
  const spokes = 24;
  const rOuter = 8.6;
  const rInner = 1.6;
  for (let i = 0; i < spokes; i++) {
    const a0 = (i / spokes) * Math.PI * 2;
    const a1 = ((i + 1) / spokes) * Math.PI * 2;
    const col = i % 2 === 0 ? DRESS.paveField : DRESS.paveBand;
    const p = (a: number, r: number): THREE.Vector3 =>
      at(focus.x + Math.cos(a) * r, focus.z + Math.sin(a) * r);
    if (!pointInPolygon(focus.x + Math.cos(a0) * rOuter, focus.z + Math.sin(a0) * rOuter, poly)) continue;
    g.quad(p(a0, rInner), p(a1, rInner), p(a1, rOuter), p(a0, rOuter), col, 0.34);
  }
  // two concentric rings closing the rosette
  for (const [r0, r1, col] of [
    [rOuter, rOuter + 0.55, DRESS.paveDark],
    [rInner - 0.5, rInner, DRESS.paveDark],
  ] as Array<[number, number, number]>) {
    for (let i = 0; i < spokes; i++) {
      const a0 = (i / spokes) * Math.PI * 2;
      const a1 = ((i + 1) / spokes) * Math.PI * 2;
      const p = (a: number, r: number): THREE.Vector3 =>
        at(focus.x + Math.cos(a) * r, focus.z + Math.sin(a) * r);
      if (!pointInPolygon(focus.x + Math.cos(a0) * r1, focus.z + Math.sin(a0) * r1, poly)) continue;
      g.quad(p(a0, r0), p(a1, r0), p(a1, r1), p(a0, r1), col, 0.34);
    }
  }
  void rng;
  cb.close();
}

/** Kerb ring around an island — 0.14 m of stone edging, sittable and legible. */
export function islandKerb(
  cb: ClusterBuilder,
  poly: readonly THREE.Vector2[],
  heightAt: (x: number, z: number) => number,
  cullMul: number,
): void {
  if (poly.length < 3) return;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x;
    cz += p.y;
  }
  cx /= poly.length;
  cz /= poly.length;
  const g = cb.g;
  cb.open(cx, heightAt(cx, cz), cz, cullMul);
  const H = 0.15;
  const W = 0.26;
  const inner = poly.map((p) => {
    const dx = cx - p.x;
    const dz = cz - p.y;
    const l = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / l) * W, z: p.y + (dz / l) * W };
  });
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const a = poly[i];
    const b = poly[j];
    const ia = inner[i];
    const ib = inner[j];
    const ya = heightAt(a.x, a.y);
    const yb = heightAt(b.x, b.y);
    // outer face
    g.quad(
      new THREE.Vector3(a.x, ya, a.y),
      new THREE.Vector3(b.x, yb, b.y),
      new THREE.Vector3(b.x, yb + H, b.y),
      new THREE.Vector3(a.x, ya + H, a.y),
      DRESS.kerbStone,
      0.5,
    );
    // top
    g.quad(
      new THREE.Vector3(a.x, ya + H, a.y),
      new THREE.Vector3(b.x, yb + H, b.y),
      new THREE.Vector3(ib.x, yb + H, ib.z),
      new THREE.Vector3(ia.x, ya + H, ia.z),
      DRESS.stoneLight,
      0.5,
    );
  }
  cb.close();
}

/* ========================================================================== *
 *  spans — bunting and festoon strings
 * ========================================================================== */

/** Points along a catenary between two anchors. */
export function catenaryPoints(
  a: THREE.Vector3,
  b: THREE.Vector3,
  sag: number,
  segments: number,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    out.push(
      new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * sag,
        a.z + (b.z - a.z) * t,
      ),
    );
  }
  return out;
}

/** Thin ribbon along a point list — the wire itself. */
export function wireRibbon(
  g: GeoBuilder,
  pts: readonly THREE.Vector3[],
  color: number,
  thickness = 0.02,
): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * thickness;
    const nz = (dx / l) * thickness;
    g.quad(
      new THREE.Vector3(a.x + nx, a.y, a.z + nz),
      new THREE.Vector3(b.x + nx, b.y, b.z + nz),
      new THREE.Vector3(b.x - nx, b.y, b.z - nz),
      new THREE.Vector3(a.x - nx, a.y, a.z - nz),
      color,
      0.5,
    );
    g.quad(
      new THREE.Vector3(a.x, a.y + thickness, a.z),
      new THREE.Vector3(b.x, b.y + thickness, b.z),
      new THREE.Vector3(b.x, b.y - thickness, b.z),
      new THREE.Vector3(a.x, a.y - thickness, a.z),
      shade(color, 0.8),
      0.5,
    );
  }
}

/** Triangular *banderines* hung off a sampled catenary. Cloth material. */
export function buntingFlags(
  g: GeoBuilder,
  pts: readonly THREE.Vector3[],
  size: number,
  palette: readonly number[],
  phase: number,
): void {
  const wave = new THREE.Vector3();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    const w = size * 0.5;
    wave.set(0.06, (phase + i * 0.17) % 1, 0.34);
    windCard(
      g,
      new THREE.Vector3(mx - (dx / l) * w, my, mz - (dz / l) * w),
      new THREE.Vector3(mx + (dx / l) * w, my, mz + (dz / l) * w),
      new THREE.Vector3(mx + (dx / l) * w * 0.1, my - size * 1.25, mz + (dz / l) * w * 0.1),
      new THREE.Vector3(mx - (dx / l) * w * 0.1, my - size * 1.25, mz - (dz / l) * w * 0.1),
      palette[i % palette.length],
      wave,
    );
  }
}

/** Cheap night sparkle: 0 by day, 1 deep in the night. */
export function nightRamp(hours: number): number {
  if (hours >= 19.2 || hours <= 5.6) return 1;
  if (hours > 17.4 && hours < 19.2) return (hours - 17.4) / 1.8;
  if (hours > 5.6 && hours < 7.1) return 1 - (hours - 5.6) / 1.5;
  return 0;
}
