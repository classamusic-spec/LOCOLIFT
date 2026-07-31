/**
 * Loco Lift — procedural façade texture atlas.
 *
 * Everything a townhouse needs to look painted, weathered and inhabited, baked
 * into **one** atlas so the whole city shell draws from a single material:
 *
 *  - four seamless painted-lime-stucco variants (trowel sweeps, hairline
 *    crazing, weathering streaks under sills, spalling, salt haze);
 *  - barrel roof tile, azotea screed, splash-zone plinth render, exposed rubble;
 *  - joinery: persiana louvers (35° slats), panelled doors, fanlights, transoms,
 *    rejas, roll-down shutters, shopfront glass;
 *  - culture: azulejo street plaques, house-number tiles, hand-painted shop
 *    signs in correct Spanish, two murals, a zaguán depth card.
 *
 * Tiles that need to repeat (stucco, tile, screed, zinc, timber, awning) are
 * generated **wrap-seamless inside their own rect**, so geometry can map any
 * number of whole tiles into a rect and the joins are invisible. Normals come
 * from a real height field per tile through {@link heightToNormal}, which wraps
 * per tile rather than across the atlas, so the relief tiles as cleanly as the
 * albedo does.
 *
 * Neutral tiles (stucco, wood, tile, stone) are painted as luminance only and
 * are tinted per-building by the vertex colour; "art" tiles (glass, azulejo,
 * murals, signs) carry their own colour and are drawn with a white tint.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { createCanvas, heightToNormal, TextureFactory } from './TextureFactory';
import type { Canvas2D } from './TextureFactory';

/* ------------------------------------------------------------------ keys */

export type AtlasKey =
  | 'stuccoA'
  | 'stuccoB'
  | 'stuccoC'
  | 'stuccoD'
  | 'roofTile'
  | 'azotea'
  | 'plinth'
  | 'rubble'
  | 'persianaUpper'
  | 'persianaLower'
  | 'doorPanel'
  | 'doorGrand'
  | 'glass'
  | 'reja'
  | 'shopGlass'
  | 'shutterRoll'
  | 'fanlight'
  | 'transom'
  | 'azulejo'
  | 'numberTile'
  | 'zaguan'
  | 'mural0'
  | 'mural1'
  | 'awning'
  | 'sign0'
  | 'sign1'
  | 'sign2'
  | 'sign3'
  | 'sign4'
  | 'sign5'
  | 'zinc'
  | 'timber';

/** A sub-rectangle of the atlas in UV space. */
export interface AtlasRect {
  u0: number;
  v0: number;
  du: number;
  dv: number;
}

/* ---------------------------------------------------------------- helpers */

const GRID = 16;

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), n | 1);
  n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
  return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
}

function wrapi(v: number, period: number): number {
  const m = v % period;
  return m < 0 ? m + period : m;
}

/** value noise on a lattice that repeats every `period` cells */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(wrapi(xi, period), wrapi(yi, period), seed);
  const b = hash2(wrapi(xi + 1, period), wrapi(yi, period), seed);
  const c = hash2(wrapi(xi, period), wrapi(yi + 1, period), seed);
  const d = hash2(wrapi(xi + 1, period), wrapi(yi + 1, period), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

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

function gray(v: number): string {
  const b = clamp(Math.round(v * 255), 0, 255);
  return `rgb(${b},${b},${b})`;
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

/** Painter facade: draws to either the albedo pass or the height pass. */
class P {
  readonly ctx: Canvas2D;
  readonly w: number;
  readonly h: number;
  readonly mode: 'a' | 'h';
  readonly rng: RNG;

  constructor(ctx: Canvas2D, w: number, h: number, mode: 'a' | 'h', rng: RNG) {
    this.ctx = ctx;
    this.w = w;
    this.h = h;
    this.mode = mode;
    this.rng = rng;
  }

  /** pick the albedo css colour or the height grey, whichever pass we are in */
  style(css: string, height: number): string {
    return this.mode === 'a' ? css : gray(height);
  }

  fill(css: string, height: number, x: number, y: number, w: number, h: number, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = this.style(css, height);
    this.ctx.fillRect(x, y, w, h);
    this.ctx.globalAlpha = 1;
  }

  clear(css: string, height: number): void {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = this.style(css, height);
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  /** run `fn` nine times, tiled, so anything it draws wraps seamlessly */
  wrap(fn: () => void): void {
    const { ctx, w, h } = this;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        ctx.save();
        ctx.translate(dx * w, dy * h);
        fn();
        ctx.restore();
      }
    }
  }
}

/* ---------------------------------------------------------------- noise map */

const noiseCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

/** seamless grayscale fbm tile, cached */
function noiseTile(size: number, period: number, oct: number, seed: number, lo: number, hi: number) {
  const key = `${size}|${period}|${oct}|${seed}|${lo}|${hi}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d') as Canvas2D | null;
  if (!ctx) throw new Error('FacadeTextures: 2D canvas unavailable');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = tileFbm((x / size) * period, (y / size) * period, period, oct, seed);
      const v = clamp(Math.round(lerp(lo, hi, n) * 255), 0, 255);
      const o = (y * size + x) * 4;
      img.data[o] = v;
      img.data[o + 1] = v;
      img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  noiseCache.set(key, c);
  return c;
}

/** stretch a cached seamless noise tile across the whole painter surface */
function noiseWash(p: P, period: number, oct: number, seed: number, lo: number, hi: number, alpha: number, comp: GlobalCompositeOperation = 'source-over'): void {
  const src = noiseTile(96, period, oct, seed, lo, hi);
  const prev = p.ctx.globalCompositeOperation;
  p.ctx.globalCompositeOperation = comp;
  p.ctx.globalAlpha = alpha;
  p.ctx.drawImage(src as CanvasImageSource, 0, 0, p.w, p.h);
  p.ctx.globalAlpha = 1;
  p.ctx.globalCompositeOperation = prev;
}

/* -------------------------------------------------------------- tile specs */

interface TileSpec {
  /** cell coordinates in a 16x16 grid */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  /** base roughness (§5) */
  rough: number;
  /** how much the height field modulates roughness */
  roughVar: number;
  /** normal-map relief strength */
  relief: number;
  paint(p: P): void;
}

/* ------------------------------------------------------------- painters */

/** painted lime stucco: trowel sweeps, crazing, drip streaks, spalling, salt */
function paintStucco(variant: number) {
  return (p: P): void => {
    const { ctx, w, h, rng } = p;
    p.clear('#efe9dd', 0.62);

    // low-frequency trowel body
    noiseWash(p, 3 + variant, 4, 1301 + variant * 977, p.mode === 'a' ? 0.82 : 0.42, p.mode === 'a' ? 1.06 : 0.82, 1, 'multiply');
    // fine plaster grain
    noiseWash(p, 26 + variant * 3, 3, 5501 + variant * 331, p.mode === 'a' ? 0.9 : 0.44, p.mode === 'a' ? 1.08 : 0.62, 0.55, 'multiply');

    // trowel arcs — long shallow sweeps left by the plasterer's float
    p.wrap(() => {
      const r = new RNG(0x5100 + variant * 13);
      ctx.lineCap = 'round';
      for (let i = 0; i < 22; i++) {
        const cx = r.range(0, w);
        const cy = r.range(0, h);
        const rad = r.range(w * 0.18, w * 0.55);
        const a0 = r.range(0, Math.PI * 2);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, a0, a0 + r.range(0.5, 1.4));
        ctx.lineWidth = r.range(w * 0.008, w * 0.028);
        ctx.globalAlpha = 0.1;
        ctx.strokeStyle = p.style(r.bool() ? '#ffffff' : '#c9bfae', r.bool() ? 0.74 : 0.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    // hairline crazing
    p.wrap(() => {
      const r = new RNG(0x9a10 + variant * 71);
      ctx.lineWidth = Math.max(1, w * 0.002);
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = p.style('#a89c88', 0.34);
      for (let i = 0; i < 26; i++) {
        let x = r.range(0, w);
        let y = r.range(0, h);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 4; s++) {
          x += r.range(-w * 0.09, w * 0.09);
          y += r.range(-h * 0.09, h * 0.09);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    // gravity-aligned weathering streaks
    p.wrap(() => {
      const r = new RNG(0x2f30 + variant * 199);
      for (let i = 0; i < 10; i++) {
        const x = r.range(0, w);
        const bw = r.range(w * 0.012, w * 0.05);
        const y0 = r.range(-h * 0.2, h * 0.4);
        const y1 = y0 + r.range(h * 0.35, h * 1.1);
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, p.mode === 'a' ? 'rgba(120,108,92,0.30)' : 'rgba(70,70,70,0.24)');
        g.addColorStop(1, 'rgba(120,108,92,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y0, bw, y1 - y0);
      }
    });

    // spalling — stucco gone, rubble showing (8% of façades use this heavily,
    // but a hint on every tile keeps the material honest)
    if (variant >= 2) {
      p.wrap(() => {
        const r = new RNG(0x77c0 + variant * 421);
        for (let i = 0; i < 3; i++) {
          const cx = r.range(0, w);
          const cy = r.range(0, h);
          ctx.beginPath();
          const n = 9;
          for (let k = 0; k <= n; k++) {
            const a = (k / n) * Math.PI * 2;
            const rad = w * r.range(0.03, 0.075);
            const px = cx + Math.cos(a) * rad;
            const py = cy + Math.sin(a) * rad * 0.8;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = p.style('#b7a284', 0.36);
          ctx.globalAlpha = 0.55;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      });
    }

    // salt haze off the Atlantic — a pale bloom that never quite washes out
    const haze = ctx.createLinearGradient(0, 0, 0, h);
    haze.addColorStop(0, p.mode === 'a' ? 'rgba(255,255,255,0.16)' : 'rgba(150,150,150,0.10)');
    haze.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, w, h);
    void rng;
  };
}

/** barrel/Spanish tile: pan and cover courses, 0.185 across, 0.40 long */
function paintRoofTile(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#c9c1b4', 0.3);
  const cols = 6;
  const rows = 4;
  const cw = w / cols;
  const rh = h / rows;
  for (let j = -1; j <= rows; j++) {
    for (let i = -1; i <= cols; i++) {
      const x = i * cw;
      const y = j * rh;
      // each course laps over the one below
      const g = ctx.createLinearGradient(x, 0, x + cw, 0);
      const r = hash2(wrapi(i, cols), wrapi(j, rows), 8123);
      const bright = lerp(0.86, 1.12, r);
      if (p.mode === 'a') {
        g.addColorStop(0, rgba(96 * bright, 88 * bright, 80 * bright, 1));
        g.addColorStop(0.42, rgba(224 * bright, 214 * bright, 200 * bright, 1));
        g.addColorStop(0.72, rgba(196 * bright, 186 * bright, 172 * bright, 1));
        g.addColorStop(1, rgba(104 * bright, 96 * bright, 86 * bright, 1));
      } else {
        g.addColorStop(0, gray(0.2));
        g.addColorStop(0.45, gray(0.92));
        g.addColorStop(0.78, gray(0.66));
        g.addColorStop(1, gray(0.18));
      }
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cw + 0.7, rh + 0.7);
      // shadow of the lap
      ctx.fillStyle = p.style('rgba(50,40,34,0.42)', 0.1);
      ctx.fillRect(x, y, cw + 0.7, rh * 0.13);
    }
  }
  noiseWash(p, 22, 3, 3121, 0.86, 1.1, 0.5, 'multiply');
  // moss and salt bloom in the pans
  p.wrap(() => {
    const r = new RNG(0x4411);
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      ctx.ellipse(r.range(0, w), r.range(0, h), r.range(w * 0.02, w * 0.07), r.range(h * 0.02, h * 0.05), 0, 0, Math.PI * 2);
      ctx.fillStyle = p.style(r.bool(0.5) ? 'rgba(120,132,84,0.35)' : 'rgba(214,208,190,0.30)', 0.5);
      ctx.fill();
    }
  });
}

/** azotea screed: cement float finish, tar patches, standing-water stains */
function paintAzotea(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#d9d3c4', 0.6);
  noiseWash(p, 5, 4, 913, 0.84, 1.06, 1, 'multiply');
  noiseWash(p, 34, 3, 4703, 0.9, 1.06, 0.5, 'multiply');
  // tar patches, ~20% coverage
  p.wrap(() => {
    const r = new RNG(0x1f77);
    for (let i = 0; i < 5; i++) {
      const cx = r.range(0, w);
      const cy = r.range(0, h);
      ctx.beginPath();
      const n = 11;
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rad = w * r.range(0.05, 0.15);
        const px = cx + Math.cos(a) * rad;
        const py = cy + Math.sin(a) * rad;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = p.style('rgba(66,62,58,0.85)', 0.55);
      ctx.fill();
    }
  });
  // screed control joints
  p.wrap(() => {
    ctx.strokeStyle = p.style('rgba(120,112,100,0.45)', 0.4);
    ctx.lineWidth = Math.max(1, w * 0.004);
    for (let i = 0; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo((i * w) / 3, 0);
      ctx.lineTo((i * w) / 3, h);
      ctx.moveTo(0, (i * h) / 3);
      ctx.lineTo(w, (i * h) / 3);
      ctx.stroke();
    }
  });
}

/** splash-zone plinth render: darker, dirtier, rising damp, kicked-up grit */
function paintPlinth(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#b7ae9e', 0.55);
  noiseWash(p, 6, 4, 2207, 0.72, 1.02, 1, 'multiply');
  noiseWash(p, 40, 3, 6607, 0.86, 1.08, 0.6, 'multiply');
  // rising damp from the pavement
  const g = ctx.createLinearGradient(0, h, 0, 0);
  g.addColorStop(0, p.mode === 'a' ? 'rgba(70,64,56,0.55)' : 'rgba(80,80,80,0.30)');
  g.addColorStop(0.55, 'rgba(70,64,56,0.12)');
  g.addColorStop(1, 'rgba(70,64,56,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // splash flecks
  p.wrap(() => {
    const r = new RNG(0x88ce);
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = p.style('rgba(58,54,48,0.5)', 0.42);
      ctx.fillRect(r.range(0, w), h - r.range(0, h * 0.4), r.range(1, w * 0.012), r.range(1, h * 0.01));
    }
  });
}

/** exposed rubble masonry showing where the stucco has spalled off */
function paintRubble(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#a89478', 0.5);
  const rows = 7;
  const r = new RNG(0x3311);
  for (let j = -1; j <= rows; j++) {
    const y = (j * h) / rows;
    const rh = h / rows;
    let x = (j & 1 ? -0.5 : 0) * (w / 5);
    while (x < w + 4) {
      const bw = (w / 5) * r.range(0.6, 1.5);
      const t = r.next();
      ctx.fillStyle = p.style(
        `rgb(${Math.round(lerp(150, 196, t))},${Math.round(lerp(132, 176, t))},${Math.round(lerp(106, 142, t))})`,
        lerp(0.5, 0.86, t),
      );
      ctx.fillRect(x + 1.5, y + 1.5, bw - 3, rh - 3);
      x += bw;
    }
  }
  noiseWash(p, 30, 4, 991, 0.84, 1.08, 0.7, 'multiply');
  // mortar shadow
  p.wrap(() => {
    ctx.strokeStyle = p.style('rgba(84,74,60,0.6)', 0.24);
    ctx.lineWidth = Math.max(1.5, w * 0.008);
    for (let j = 0; j <= rows; j++) {
      ctx.beginPath();
      ctx.moveTo(0, (j * h) / rows);
      ctx.lineTo(w, (j * h) / rows);
      ctx.stroke();
    }
  });
}

/**
 * Persiana leaf — louvered shutter. Slats at 0.048 pitch, 35° from horizontal
 * sloping down-and-out, stiles 0.075 / rails 0.090, mid rail at 0.42 of height.
 * Painted as pure luminance so the joinery colour tints it.
 */
function paintPersiana(slats: number) {
  return (p: P): void => {
    const { ctx, w, h } = p;
    p.clear('#8e8e8e', 0.72);
    const stile = w * 0.12;
    const railH = h * 0.032;
    const midY = h * (1 - 0.42);
    const panels: Array<[number, number]> = [
      [railH, midY - railH * 0.5],
      [midY + railH * 0.5, h - railH],
    ];
    for (const [y0, y1] of panels) {
      const span = y1 - y0;
      const n = Math.max(3, Math.round((slats * span) / h));
      const pitch = span / n;
      for (let i = 0; i < n; i++) {
        const y = y0 + i * pitch;
        const g = ctx.createLinearGradient(0, y, 0, y + pitch);
        if (p.mode === 'a') {
          g.addColorStop(0, '#3d3d3d');
          g.addColorStop(0.28, '#787878');
          g.addColorStop(0.86, '#d2d2d2');
          g.addColorStop(1, '#5a5a5a');
        } else {
          g.addColorStop(0, gray(0.24));
          g.addColorStop(0.3, gray(0.5));
          g.addColorStop(0.88, gray(0.95));
          g.addColorStop(1, gray(0.3));
        }
        ctx.fillStyle = g;
        ctx.fillRect(stile, y, w - stile * 2, pitch + 0.6);
      }
    }
    // stiles and rails sit proud of the louvers
    ctx.fillStyle = p.style('#9d9d9d', 0.9);
    ctx.fillRect(0, 0, stile, h);
    ctx.fillRect(w - stile, 0, stile, h);
    ctx.fillRect(0, 0, w, railH);
    ctx.fillRect(0, h - railH, w, railH);
    ctx.fillRect(0, midY - railH * 0.5, w, railH);
    // frame shadow
    ctx.strokeStyle = p.style('rgba(20,20,20,0.55)', 0.4);
    ctx.lineWidth = Math.max(1, w * 0.015);
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    noiseWash(p, 40, 3, 2777, 0.92, 1.05, 0.35, 'multiply');
  };
}

/** panelled double door: 2 wide x 4 tall per leaf, panels recessed 0.022 */
function paintDoor(grand: boolean) {
  return (p: P): void => {
    const { ctx, w, h } = p;
    p.clear('#8a8a8a', 0.78);
    const gap = w * 0.012;
    const leafW = (w - gap) * 0.5;
    const stile = leafW * 0.14;
    const rail = h * 0.036;
    for (let leaf = 0; leaf < 2; leaf++) {
      const lx = leaf * (leafW + gap);
      const cols = 2;
      const rows = 4;
      const iw = (leafW - stile * (cols + 1)) / cols;
      const ih = (h - rail * (rows + 1)) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = lx + stile + c * (iw + stile);
          const y = rail + r * (ih + rail);
          // recessed panel: dark top-left bevel, light bottom-right
          ctx.fillStyle = p.style('#6e6e6e', 0.58);
          ctx.fillRect(x, y, iw, ih);
          ctx.fillStyle = p.style('rgba(30,30,30,0.5)', 0.44);
          ctx.fillRect(x, y, iw, Math.max(1, h * 0.006));
          ctx.fillRect(x, y, Math.max(1, w * 0.006), ih);
          ctx.fillStyle = p.style('rgba(255,255,255,0.28)', 0.9);
          ctx.fillRect(x, y + ih - Math.max(1, h * 0.006), iw, Math.max(1, h * 0.006));
          ctx.fillRect(x + iw - Math.max(1, w * 0.006), y, Math.max(1, w * 0.006), ih);
        }
      }
      if (grand) {
        // iron studs on a 0.34 grid, the Puerta de San Juan family
        ctx.fillStyle = p.style('#4a4a4a', 0.98);
        for (let r = 0; r < 6; r++) {
          for (let c = 0; c < 3; c++) {
            const x = lx + leafW * (0.18 + c * 0.32);
            const y = h * (0.08 + r * 0.17);
            ctx.beginPath();
            ctx.arc(x, y, Math.max(1.2, w * 0.014), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    // meeting stile shadow and the knocker
    ctx.fillStyle = p.style('rgba(16,16,16,0.75)', 0.32);
    ctx.fillRect(leafW, 0, gap, h);
    ctx.fillStyle = p.style('#c8c8c8', 1.0);
    ctx.beginPath();
    ctx.arc(leafW * 0.5, h * 0.45, Math.max(1.5, w * 0.022), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.style('rgba(12,12,12,0.6)', 0.35);
    ctx.lineWidth = Math.max(1, w * 0.018);
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    noiseWash(p, 30, 3, 6113, 0.94, 1.04, 0.3, 'multiply');
  };
}

/** window glass: dark, with interior depth, a curtain and a raking reflection */
function paintGlass(shop: boolean) {
  return (p: P): void => {
    const { ctx, w, h } = p;
    if (p.mode === 'h') {
      p.clear(gray(0.5), 0.5);
      // muntins stand slightly proud
      ctx.fillStyle = gray(0.78);
      ctx.fillRect(w * 0.48, 0, w * 0.04, h);
      if (!shop) ctx.fillRect(0, h * 0.46, w, h * 0.04);
      return;
    }
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0a1016');
    g.addColorStop(0.6, '#131c24');
    g.addColorStop(1, '#0c1218');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // a lit room behind: warm rectangle, deep
    ctx.fillStyle = shop ? 'rgba(255,206,142,0.42)' : 'rgba(255,215,154,0.20)';
    ctx.fillRect(w * 0.12, h * (shop ? 0.18 : 0.34), w * 0.76, h * 0.46);
    if (shop) {
      // goods on shelves — silhouettes, not detail
      const r = new RNG(0x2a51);
      for (let s = 0; s < 3; s++) {
        const y = h * (0.32 + s * 0.2);
        ctx.fillStyle = 'rgba(40,30,22,0.75)';
        ctx.fillRect(w * 0.1, y, w * 0.8, h * 0.02);
        for (let i = 0; i < 7; i++) {
          const bw = w * r.range(0.04, 0.09);
          ctx.fillStyle = `rgba(${r.int(120, 230)},${r.int(90, 200)},${r.int(60, 170)},0.85)`;
          ctx.fillRect(w * 0.12 + i * w * 0.11, y - h * r.range(0.05, 0.11), bw, h * 0.1);
        }
      }
    } else {
      // half-drawn curtain
      ctx.fillStyle = 'rgba(226,214,190,0.30)';
      ctx.fillRect(w * 0.1, h * 0.08, w * 0.34, h * 0.7);
    }
    // reflection of the sky raking across the pane
    const rf = ctx.createLinearGradient(0, h, w, 0);
    rf.addColorStop(0, 'rgba(150,190,220,0)');
    rf.addColorStop(0.45, 'rgba(160,200,230,0.30)');
    rf.addColorStop(0.55, 'rgba(160,200,230,0.30)');
    rf.addColorStop(1, 'rgba(150,190,220,0)');
    ctx.fillStyle = rf;
    ctx.fillRect(0, 0, w, h);
    // muntins
    ctx.fillStyle = '#171a1c';
    ctx.fillRect(w * 0.48, 0, w * 0.04, h);
    if (!shop) ctx.fillRect(0, h * 0.46, w, h * 0.04);
    ctx.strokeStyle = 'rgba(10,12,14,0.9)';
    ctx.lineWidth = Math.max(1, w * 0.03);
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  };
}

/** reja — the iron grille over a ground-floor window */
function paintReja(p: P): void {
  const { ctx, w, h } = p;
  paintGlass(false)(p);
  const bars = 7;
  ctx.fillStyle = p.style('#2a2a2a', 0.95);
  for (let i = 0; i < bars; i++) {
    const x = ((i + 0.5) / bars) * w - w * 0.012;
    ctx.fillRect(x, 0, w * 0.024, h);
  }
  ctx.fillRect(0, h * 0.1, w, h * 0.026);
  ctx.fillRect(0, h * 0.62, w, h * 0.026);
  // highlight along the left of each bar so the iron reads round
  ctx.fillStyle = p.style('rgba(180,180,180,0.35)', 1);
  for (let i = 0; i < bars; i++) {
    const x = ((i + 0.5) / bars) * w - w * 0.012;
    ctx.fillRect(x, 0, w * 0.006, h);
  }
}

/** roll-down shop shutter, corrugated, occasionally tagged */
function paintShutter(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#8d8d8d', 0.6);
  const n = 26;
  for (let i = 0; i < n; i++) {
    const y = (i / n) * h;
    const g = ctx.createLinearGradient(0, y, 0, y + h / n);
    if (p.mode === 'a') {
      g.addColorStop(0, '#5c5c5c');
      g.addColorStop(0.5, '#b4b4b4');
      g.addColorStop(1, '#6a6a6a');
    } else {
      g.addColorStop(0, gray(0.34));
      g.addColorStop(0.5, gray(0.86));
      g.addColorStop(1, gray(0.38));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, y, w, h / n + 0.6);
  }
  noiseWash(p, 24, 3, 1451, 0.9, 1.06, 0.4, 'multiply');
}

/** semicircular fanlight with radiating glazing bars (7 bars) */
function paintFanlight(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#0d1319', 0.5);
  if (p.mode === 'a') {
    const g = ctx.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, h);
    g.addColorStop(0, '#3a3126');
    g.addColorStop(1, '#0c1218');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(w * 0.5, h, h * 0.98, Math.PI, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = p.style('#141b22', 0.5);
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = p.style('#c9c2b2', 0.9);
  ctx.lineWidth = Math.max(1.4, w * 0.018);
  for (let i = 1; i <= 7; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(w * 0.5, h);
    ctx.lineTo(w * 0.5 + Math.cos(a) * h, h + Math.sin(a) * h);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(w * 0.5, h, h * 0.5, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = p.style('#d5cebd', 0.95);
  ctx.lineWidth = Math.max(2, w * 0.03);
  ctx.beginPath();
  ctx.arc(w * 0.5, h, h * 0.98, Math.PI, Math.PI * 2);
  ctx.stroke();
}

/** rectangular upper transom with 3 vertical bars */
function paintTransom(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#101820', 0.5);
  if (p.mode === 'a') {
    ctx.fillStyle = 'rgba(255,215,154,0.18)';
    ctx.fillRect(w * 0.06, h * 0.12, w * 0.88, h * 0.76);
  }
  ctx.fillStyle = p.style('#cdc6b6', 0.9);
  for (let i = 1; i <= 3; i++) ctx.fillRect((i / 4) * w - w * 0.012, 0, w * 0.024, h);
  ctx.strokeStyle = p.style('#d5cebd', 0.95);
  ctx.lineWidth = Math.max(2, h * 0.09);
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

const STREET_NAMES: Array<[string, string]> = [
  ['CALLE DE LA', 'FORTALEZA'],
  ['CALLE DEL', 'CRISTO'],
  ['CALLE', 'SAN JOSÉ'],
  ['CALLE DE LA', 'LUNA'],
  ['CALLE DEL', 'SOL'],
  ['CALLE', 'SAN SEBASTIÁN'],
];

/** the blue-on-white ceramic azulejo street plaque — mandatory local detail */
function paintAzulejo(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#f4f1e8', 0.72);
  if (p.mode === 'h') {
    ctx.fillStyle = gray(0.55);
    ctx.fillRect(0, 0, w, h * 0.1);
    ctx.fillRect(0, h * 0.9, w, h * 0.1);
    ctx.fillRect(0, 0, w * 0.06, h);
    ctx.fillRect(w * 0.94, 0, w * 0.06, h);
    return;
  }
  const blue = '#1f4e8c';
  ctx.strokeStyle = blue;
  ctx.lineWidth = Math.max(2, h * 0.055);
  ctx.strokeRect(h * 0.09, h * 0.09, w - h * 0.18, h - h * 0.18);
  ctx.lineWidth = Math.max(1, h * 0.022);
  ctx.strokeRect(h * 0.17, h * 0.17, w - h * 0.34, h - h * 0.34);
  // corner rosettes
  ctx.fillStyle = blue;
  for (const [cx, cy] of [
    [h * 0.13, h * 0.13],
    [w - h * 0.13, h * 0.13],
    [h * 0.13, h - h * 0.13],
    [w - h * 0.13, h - h * 0.13],
  ]) {
    ctx.beginPath();
    ctx.arc(cx, cy, h * 0.055, 0, Math.PI * 2);
    ctx.fill();
  }
  const name = STREET_NAMES[Math.floor(hash2(3, 7, 991) * STREET_NAMES.length) % STREET_NAMES.length];
  ctx.fillStyle = blue;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  try {
    ctx.font = `${Math.round(h * 0.17)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(name[0], w * 0.5, h * 0.36);
    ctx.font = `bold ${Math.round(h * 0.28)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(name[1], w * 0.5, h * 0.63);
  } catch {
    /* headless canvas shim without text support — border still reads */
  }
  noiseWash(p, 18, 3, 5171, 0.94, 1.04, 0.3, 'multiply');
}

/** small matching number tile beside the door */
function paintNumberTile(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#f4f1e8', 0.72);
  if (p.mode === 'h') return;
  ctx.strokeStyle = '#1f4e8c';
  ctx.lineWidth = Math.max(2, h * 0.07);
  ctx.strokeRect(h * 0.1, h * 0.1, w - h * 0.2, h - h * 0.2);
  ctx.fillStyle = '#1f4e8c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  try {
    ctx.font = `bold ${Math.round(h * 0.44)}px Georgia, serif`;
    ctx.fillText('152', w * 0.5, h * 0.54);
  } catch {
    /* ignore */
  }
}

/**
 * Zaguán card — the through-passage from the street door to the patio. A dark
 * rectangle with a bright warm sunlit patio at the far end: the cheapest,
 * best depth cue in the whole city.
 */
function paintZaguan(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#0a0a0c', 0.5);
  if (p.mode === 'h') {
    const g = ctx.createRadialGradient(w * 0.5, h * 0.55, 0, w * 0.5, h * 0.55, w * 0.7);
    g.addColorStop(0, gray(0.05));
    g.addColorStop(1, gray(0.6));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  // side walls catching a little warm bounce
  const gl = ctx.createLinearGradient(0, 0, w * 0.5, 0);
  gl.addColorStop(0, '#3a2c20');
  gl.addColorStop(1, '#0b0a0a');
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, w * 0.5, h);
  const gr = ctx.createLinearGradient(w, 0, w * 0.5, 0);
  gr.addColorStop(0, '#241a12');
  gr.addColorStop(1, '#0b0a0a');
  ctx.fillStyle = gr;
  ctx.fillRect(w * 0.5, 0, w * 0.5, h);
  // the patio at the far end
  ctx.fillStyle = '#f3d79a';
  ctx.fillRect(w * 0.33, h * 0.3, w * 0.34, h * 0.55);
  const glow = ctx.createRadialGradient(w * 0.5, h * 0.55, 0, w * 0.5, h * 0.55, w * 0.45);
  glow.addColorStop(0, 'rgba(255,224,168,0.85)');
  glow.addColorStop(1, 'rgba(255,224,168,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  // a plant silhouette in the patio
  ctx.fillStyle = 'rgba(24,40,20,0.75)';
  ctx.beginPath();
  ctx.ellipse(w * 0.42, h * 0.72, w * 0.07, h * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  // floor tiles catching the light
  ctx.fillStyle = 'rgba(160,120,80,0.4)';
  ctx.fillRect(0, h * 0.86, w, h * 0.14);
}

/** mural 0 — the Puerto Rican flag, hand-painted on a party wall */
function paintMuralFlag(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#d8d0c0', 0.6);
  if (p.mode === 'h') {
    noiseWash(p, 8, 3, 771, 0.4, 0.7, 1, 'source-over');
    return;
  }
  const stripes = 5;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ed0000' : '#f4f1ea';
    ctx.fillRect(0, (i / stripes) * h, w, h / stripes + 1);
  }
  ctx.fillStyle = '#0050f0';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w * 0.52, h * 0.5);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  // the star
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  const cx = w * 0.17;
  const cy = h * 0.5;
  const R = h * 0.17;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? R : R * 0.42;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // brushed onto rough stucco: let the wall show through
  noiseWash(p, 9, 4, 4441, 0.78, 1.05, 0.55, 'multiply');
}

/** mural 1 — coquí and flamboyán flowers, folk-art palette */
function paintMuralCoqui(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#1d7f74', 0.6);
  if (p.mode === 'h') {
    noiseWash(p, 8, 3, 331, 0.4, 0.7, 1, 'source-over');
    return;
  }
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#126f8c');
  bg.addColorStop(1, '#1d8f72');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  // flamboyán canopy — scarlet-orange
  const r = new RNG(0x77aa);
  for (let i = 0; i < 46; i++) {
    ctx.fillStyle = `rgba(${r.int(214, 255)},${r.int(60, 120)},${r.int(30, 60)},0.9)`;
    ctx.beginPath();
    ctx.ellipse(r.range(0, w), r.range(0, h * 0.55), w * r.range(0.02, 0.06), h * r.range(0.02, 0.05), r.range(0, 3), 0, Math.PI * 2);
    ctx.fill();
  }
  // the coquí, in silhouette
  ctx.fillStyle = '#f2c94c';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.68, w * 0.19, h * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.53, w * 0.13, h * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b2b1b';
  ctx.beginPath();
  ctx.arc(w * 0.44, h * 0.51, w * 0.026, 0, Math.PI * 2);
  ctx.arc(w * 0.56, h * 0.51, w * 0.026, 0, Math.PI * 2);
  ctx.fill();
  // legs
  ctx.strokeStyle = '#f2c94c';
  ctx.lineWidth = Math.max(2, w * 0.022);
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(w * (0.5 + s * 0.15), h * 0.74);
    ctx.lineTo(w * (0.5 + s * 0.26), h * 0.84);
    ctx.stroke();
  }
  noiseWash(p, 9, 4, 8171, 0.8, 1.06, 0.5, 'multiply');
}

const SIGN_TEXT: Array<[string, string]> = [
  ['PANADERÍA', '#7d1f22'],
  ['FARMACIA', '#14523c'],
  ['COLMADO', '#1b3a5c'],
  ['BARBERÍA', '#6e2230'],
  ['CAFETERÍA', '#5a2e1b'],
  ['ARTESANÍAS', '#10736e'],
];

/** a hand-painted shop fascia board */
function paintSign(i: number) {
  return (p: P): void => {
    const { ctx, w, h } = p;
    const [text, base] = SIGN_TEXT[i % SIGN_TEXT.length];
    p.clear(base, 0.7);
    if (p.mode === 'h') {
      ctx.fillStyle = gray(0.9);
      ctx.fillRect(w * 0.04, h * 0.1, w * 0.92, h * 0.8);
      return;
    }
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    // painted border
    ctx.strokeStyle = 'rgba(240,230,200,0.85)';
    ctx.lineWidth = Math.max(2, h * 0.05);
    ctx.strokeRect(h * 0.08, h * 0.08, w - h * 0.16, h - h * 0.16);
    ctx.fillStyle = '#f4ead2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try {
      const size = Math.round((h * 0.34 * 9) / Math.max(9, text.length));
      ctx.font = `bold ${Math.max(9, size)}px Georgia, "Times New Roman", serif`;
      ctx.fillText(text, w * 0.5, h * 0.53);
    } catch {
      /* ignore */
    }
    // sun-faded, dusty
    noiseWash(p, 12, 3, 991 + i * 71, 0.82, 1.06, 0.6, 'multiply');
    const fade = ctx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(255,240,210,0.22)');
    fade.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
  };
}

/** striped awning canvas, seamless across u */
function paintAwning(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#e8e2d4', 0.7);
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = p.style(i % 2 === 0 ? '#e8e2d4' : '#8f8f8f', i % 2 === 0 ? 0.72 : 0.6);
    ctx.fillRect((i / bands) * w, 0, w / bands + 0.6, h);
  }
  // sag between the ribs
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0.18)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  noiseWash(p, 26, 3, 1237, 0.9, 1.06, 0.4, 'multiply');
}

/** corrugated zinc — balcony roofs, rear wings, shanty additions */
function paintZinc(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#9a9a9a', 0.6);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    const g = ctx.createLinearGradient(x, 0, x + w / n, 0);
    if (p.mode === 'a') {
      g.addColorStop(0, '#5f6265');
      g.addColorStop(0.5, '#c2c4c6');
      g.addColorStop(1, '#6a6d70');
    } else {
      g.addColorStop(0, gray(0.25));
      g.addColorStop(0.5, gray(0.9));
      g.addColorStop(1, gray(0.28));
    }
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w / n + 0.6, h);
  }
  // rust bloom
  p.wrap(() => {
    const r = new RNG(0x51ee);
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      ctx.ellipse(r.range(0, w), r.range(0, h), w * r.range(0.03, 0.1), h * r.range(0.03, 0.12), 0, 0, Math.PI * 2);
      ctx.fillStyle = p.style('rgba(122,74,44,0.5)', 0.5);
      ctx.fill();
    }
  });
}

/** painted timber boarding — balcony floors, gates, hoardings */
function paintTimber(p: P): void {
  const { ctx, w, h } = p;
  p.clear('#a09a90', 0.7);
  const n = 7;
  const r = new RNG(0x3ab1);
  for (let i = 0; i < n; i++) {
    const y = (i / n) * h;
    const t = r.next();
    ctx.fillStyle = p.style(gray(lerp(0.55, 0.82, t)), lerp(0.6, 0.86, t));
    ctx.fillRect(0, y, w, h / n + 0.6);
    ctx.fillStyle = p.style('rgba(30,26,22,0.5)', 0.34);
    ctx.fillRect(0, y, w, Math.max(1, h * 0.006));
  }
  noiseWash(p, 3, 4, 2081, 0.86, 1.08, 0.8, 'multiply');
  // grain
  p.wrap(() => {
    ctx.strokeStyle = p.style('rgba(60,50,40,0.28)', 0.5);
    ctx.lineWidth = 1;
    const rr = new RNG(0x8ff1);
    for (let i = 0; i < 40; i++) {
      const y = rr.range(0, h);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + rr.range(-3, 3), w * 0.6, y + rr.range(-3, 3), w, y + rr.range(-2, 2));
      ctx.stroke();
    }
  });
}

/* ---------------------------------------------------------------- registry */

const TILES: Record<AtlasKey, TileSpec> = {
  stuccoA: { cx: 0, cy: 0, cw: 4, ch: 4, rough: 0.78, roughVar: 0.1, relief: 1.1, paint: paintStucco(0) },
  stuccoB: { cx: 4, cy: 0, cw: 4, ch: 4, rough: 0.78, roughVar: 0.1, relief: 1.2, paint: paintStucco(1) },
  stuccoC: { cx: 8, cy: 0, cw: 4, ch: 4, rough: 0.8, roughVar: 0.12, relief: 1.35, paint: paintStucco(2) },
  stuccoD: { cx: 12, cy: 0, cw: 4, ch: 4, rough: 0.8, roughVar: 0.12, relief: 1.5, paint: paintStucco(3) },
  roofTile: { cx: 0, cy: 4, cw: 4, ch: 4, rough: 0.82, roughVar: 0.12, relief: 3.0, paint: paintRoofTile },
  azotea: { cx: 4, cy: 4, cw: 4, ch: 4, rough: 0.88, roughVar: 0.1, relief: 1.3, paint: paintAzotea },
  plinth: { cx: 8, cy: 4, cw: 4, ch: 4, rough: 0.9, roughVar: 0.12, relief: 1.7, paint: paintPlinth },
  rubble: { cx: 12, cy: 4, cw: 4, ch: 4, rough: 0.92, roughVar: 0.14, relief: 3.0, paint: paintRubble },
  persianaUpper: { cx: 0, cy: 8, cw: 2, ch: 4, rough: 0.42, roughVar: 0.1, relief: 3.4, paint: paintPersiana(52) },
  persianaLower: { cx: 2, cy: 8, cw: 2, ch: 4, rough: 0.42, roughVar: 0.1, relief: 3.4, paint: paintPersiana(62) },
  doorPanel: { cx: 4, cy: 8, cw: 2, ch: 4, rough: 0.42, roughVar: 0.08, relief: 2.2, paint: paintDoor(false) },
  doorGrand: { cx: 6, cy: 8, cw: 2, ch: 4, rough: 0.3, roughVar: 0.08, relief: 2.4, paint: paintDoor(true) },
  glass: { cx: 8, cy: 8, cw: 2, ch: 4, rough: 0.07, roughVar: 0.05, relief: 1.0, paint: paintGlass(false) },
  reja: { cx: 10, cy: 8, cw: 2, ch: 4, rough: 0.3, roughVar: 0.1, relief: 1.6, paint: paintReja },
  shopGlass: { cx: 12, cy: 8, cw: 2, ch: 4, rough: 0.07, roughVar: 0.05, relief: 1.0, paint: paintGlass(true) },
  shutterRoll: { cx: 14, cy: 8, cw: 2, ch: 4, rough: 0.5, roughVar: 0.1, relief: 2.4, paint: paintShutter },
  fanlight: { cx: 0, cy: 12, cw: 2, ch: 2, rough: 0.16, roughVar: 0.06, relief: 1.6, paint: paintFanlight },
  transom: { cx: 2, cy: 12, cw: 2, ch: 2, rough: 0.16, roughVar: 0.06, relief: 1.6, paint: paintTransom },
  azulejo: { cx: 4, cy: 12, cw: 2, ch: 2, rough: 0.22, roughVar: 0.05, relief: 1.2, paint: paintAzulejo },
  numberTile: { cx: 6, cy: 12, cw: 2, ch: 2, rough: 0.22, roughVar: 0.05, relief: 1.0, paint: paintNumberTile },
  zaguan: { cx: 8, cy: 12, cw: 2, ch: 2, rough: 0.85, roughVar: 0.05, relief: 0.6, paint: paintZaguan },
  mural0: { cx: 10, cy: 12, cw: 2, ch: 2, rough: 0.72, roughVar: 0.1, relief: 0.9, paint: paintMuralFlag },
  mural1: { cx: 12, cy: 12, cw: 2, ch: 2, rough: 0.72, roughVar: 0.1, relief: 0.9, paint: paintMuralCoqui },
  awning: { cx: 14, cy: 12, cw: 2, ch: 2, rough: 0.8, roughVar: 0.08, relief: 1.0, paint: paintAwning },
  sign0: { cx: 0, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.08, relief: 1.0, paint: paintSign(0) },
  sign1: { cx: 2, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.08, relief: 1.0, paint: paintSign(1) },
  sign2: { cx: 4, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.08, relief: 1.0, paint: paintSign(2) },
  sign3: { cx: 6, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.08, relief: 1.0, paint: paintSign(3) },
  sign4: { cx: 8, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.08, relief: 1.0, paint: paintSign(4) },
  sign5: { cx: 10, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.08, relief: 1.0, paint: paintSign(5) },
  zinc: { cx: 12, cy: 14, cw: 2, ch: 2, rough: 0.55, roughVar: 0.12, relief: 2.4, paint: paintZinc },
  timber: { cx: 14, cy: 14, cw: 2, ch: 2, rough: 0.45, roughVar: 0.1, relief: 1.8, paint: paintTimber },
};

export const ATLAS_KEYS = Object.keys(TILES) as AtlasKey[];
export const STUCCO_KEYS: AtlasKey[] = ['stuccoA', 'stuccoB', 'stuccoC', 'stuccoD'];
export const SIGN_KEYS: AtlasKey[] = ['sign0', 'sign1', 'sign2', 'sign3', 'sign4', 'sign5'];
export const MURAL_KEYS: AtlasKey[] = ['mural0', 'mural1'];

/* ------------------------------------------------------------------ atlas */

export class FacadeAtlas {
  readonly map: THREE.Texture;
  readonly normalMap: THREE.Texture;
  readonly roughnessMap: THREE.Texture;
  readonly size: number;
  readonly buildMs: number;

  private rects = new Map<AtlasKey, AtlasRect>();

  constructor(
    map: THREE.Texture,
    normalMap: THREE.Texture,
    roughnessMap: THREE.Texture,
    size: number,
    rects: Map<AtlasKey, AtlasRect>,
    buildMs: number,
  ) {
    this.map = map;
    this.normalMap = normalMap;
    this.roughnessMap = roughnessMap;
    this.size = size;
    this.rects = rects;
    this.buildMs = buildMs;
  }

  rect(key: AtlasKey): AtlasRect {
    const r = this.rects.get(key);
    if (!r) throw new Error(`FacadeAtlas: unknown tile "${key}"`);
    return r;
  }

  /** map a tile-local (s,t) in 0..1 into atlas UV space */
  u(rect: AtlasRect, s: number): number {
    return rect.u0 + clamp01(s) * rect.du;
  }

  v(rect: AtlasRect, t: number): number {
    return rect.v0 + clamp01(t) * rect.dv;
  }
}

const cache = new WeakMap<TextureFactory, FacadeAtlas>();

const TIER_SIZE: Record<QualityTier, number> = { low: 1024, medium: 1024, high: 2048, ultra: 2048 };

/**
 * Build (or return the cached) façade atlas. The three textures are registered
 * with the shared {@link TextureFactory}, so they are disposed with the world.
 */
export function getFacadeAtlas(textures: TextureFactory, quality: QualityTier): FacadeAtlas {
  const hit = cache.get(textures);
  if (hit) return hit;

  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const S = TIER_SIZE[quality];
  const N = S >> 1; // normal / roughness resolution
  const cellA = S / GRID;
  const cellN = N / GRID;

  const albedo = createCanvas(S, S);
  const actx = albedo.getContext('2d') as Canvas2D | null;
  if (!actx) throw new Error('FacadeTextures: 2D canvas unavailable');
  actx.fillStyle = '#808080';
  actx.fillRect(0, 0, S, S);

  const normalBytes = new Uint8Array(N * N * 4);
  const roughBytes = new Uint8Array(N * N * 4);
  const rects = new Map<AtlasKey, AtlasRect>();

  for (const key of ATLAS_KEYS) {
    const spec = TILES[key];
    const aw = Math.round(spec.cw * cellA);
    const ah = Math.round(spec.ch * cellA);
    const nw = Math.round(spec.cw * cellN);
    const nh = Math.round(spec.ch * cellN);
    const ax = Math.round(spec.cx * cellA);
    const ay = Math.round(spec.cy * cellA);
    const nx = Math.round(spec.cx * cellN);
    const ny = Math.round(spec.cy * cellN);

    /* --- albedo --- */
    const tile = createCanvas(aw, ah);
    const tctx = tile.getContext('2d') as Canvas2D | null;
    if (!tctx) throw new Error('FacadeTextures: 2D canvas unavailable');
    spec.paint(new P(tctx, aw, ah, 'a', new RNG(0x1000 + spec.cx * 31 + spec.cy * 7)));
    actx.drawImage(tile as CanvasImageSource, ax, ay, aw, ah);

    /* --- height -> normal + roughness --- */
    const hc = createCanvas(nw, nh);
    const hctx = hc.getContext('2d') as Canvas2D | null;
    if (!hctx) throw new Error('FacadeTextures: 2D canvas unavailable');
    spec.paint(new P(hctx, nw, nh, 'h', new RNG(0x1000 + spec.cx * 31 + spec.cy * 7)));

    const height = new Float32Array(nw * nh);
    const img = hctx.getImageData(0, 0, nw, nh);
    for (let i = 0; i < nw * nh; i++) height[i] = img.data[i * 4] / 255;

    // wraps inside the tile, not across the atlas — seamless tiles stay seamless
    const ntex = heightToNormal(height, nw, nh, spec.relief);
    const ndata = (ntex.image as unknown as { data: Uint8Array }).data;
    for (let y = 0; y < nh; y++) {
      const dst = ((ny + y) * N + nx) * 4;
      const src = y * nw * 4;
      normalBytes.set(ndata.subarray(src, src + nw * 4), dst);
    }
    ntex.dispose();

    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const hv = height[y * nw + x];
        const rough = clamp01(spec.rough + (hv - 0.5) * spec.roughVar * 2);
        const o = ((ny + y) * N + nx + x) * 4;
        roughBytes[o] = 255; // AO channel left open
        roughBytes[o + 1] = Math.round(rough * 255);
        roughBytes[o + 2] = 0; // non-metal
        roughBytes[o + 3] = 255;
      }
    }

    // half-texel inset so mip filtering never bleeds a neighbouring tile in
    const inset = 1.5 / S;
    rects.set(key, {
      u0: ax / S + inset,
      v0: 1 - (ay + ah) / S + inset,
      du: aw / S - inset * 2,
      dv: ah / S - inset * 2,
    });
  }

  const map = textures.texture('facade:atlas:albedo', () => {
    const t = new THREE.CanvasTexture(albedo as HTMLCanvasElement);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  });
  const normalMap = textures.texture('facade:atlas:normal', () => {
    const t = new THREE.DataTexture(normalBytes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  });
  const roughnessMap = textures.texture('facade:atlas:rough', () => {
    const t = new THREE.DataTexture(roughBytes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  });
  for (const t of [map, normalMap, roughnessMap]) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.flipY = true;
  }

  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  const atlas = new FacadeAtlas(map, normalMap, roughnessMap, S, rects, ms);
  cache.set(textures, atlas);
  noiseCache.clear();
  return atlas;
}
