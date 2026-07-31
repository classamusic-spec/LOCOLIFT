/**
 * Loco Lift — façade composition.
 *
 * Turns one `Lot` into one Old San Juan townhouse elevation: the frontage is
 * divided into 2.90 m bays, the ground storey takes the door (and a shopfront
 * where the district calls for one), every upper bay takes a full-height
 * balcony door, and the whole thing is painted under the three colour laws of
 * `docs/ART_REFERENCE.md` §3.1:
 *
 *   L1  trim is always lighter than the wall, ΔL* ≥ 22
 *   L2  joinery is always darker than the wall, ΔL* ≥ 30
 *   L3  no two adjacent buildings share a hue (≥ 35° apart), and no more than
 *       2 of any 5 consecutive buildings come from the same warm/cool family
 *
 * Both L1 and L2 are enforced *constructively* — if the drawn pair fails, the
 * wall or the joinery is pushed until it passes — so the value sandwich (mid
 * wall, light frame, dark hole) can never break, whatever the dice say.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { DistrictZone, Lot } from './WorldTypes';
import type { AtlasRect, FacadeAtlas } from './FacadeTextures';
import { MURAL_KEYS, SIGN_KEYS, STUCCO_KEYS } from './FacadeTextures';
import {
  BALCON,
  CASA,
  FACE_PZ,
  FACE_PX,
  FACE_NX,
  FACE_PY,
  GeomBuilder,
  WHITE,
  azulejoPlaque,
  box,
  contactAO,
  cornice,
  cuartoEsquinero,
  dripStreak,
  encadrement,
  floatingLintel,
  hangingSign,
  linearRGB,
  makeFrame,
  numberTile,
  opening,
  panel,
  parapet,
  plinth,
  quoins,
  shadeRGB,
  shopfront,
  sidePanel,
  stringCourse,
  undersideShadow,
} from './BuildingKit';
import type { Frame, KitCtx, ParapetProfile, RGB } from './BuildingKit';

/* ------------------------------------------------------------- palettes */

interface WallColour {
  name: string;
  hex: number;
  family: 'warm' | 'cool' | 'neutral';
  weight: number;
}

/** §3.2 — façade walls. */
const WALLS: WallColour[] = [
  { name: 'Amarillo Fortaleza', hex: 0xe8a93b, family: 'warm', weight: 9 },
  { name: 'Ocre Colonial', hex: 0xd08a2e, family: 'warm', weight: 7 },
  { name: 'Mostaza Vieja', hex: 0xc99a46, family: 'warm', weight: 5 },
  { name: 'Melon', hex: 0xf0a868, family: 'warm', weight: 6 },
  { name: 'Salmon', hex: 0xefa48b, family: 'warm', weight: 7 },
  { name: 'Rosa Sanjuanera', hex: 0xe8836f, family: 'warm', weight: 8 },
  { name: 'Rosa Palo', hex: 0xd9a0a0, family: 'warm', weight: 5 },
  { name: 'Terracota', hex: 0xc25a3c, family: 'warm', weight: 6 },
  { name: 'Rojo Teja', hex: 0xa63e2c, family: 'warm', weight: 3 },
  { name: 'Crema Cal', hex: 0xf2e4c4, family: 'neutral', weight: 9 },
  { name: 'Blanco Hueso', hex: 0xf5efe2, family: 'neutral', weight: 6 },
  { name: 'Gris Perla', hex: 0xc9c6bc, family: 'neutral', weight: 3 },
  { name: 'Verde Menta', hex: 0xa8d5c0, family: 'cool', weight: 7 },
  { name: 'Turquesa Caribe', hex: 0x4fbfb1, family: 'cool', weight: 8 },
  { name: 'Verde Loro', hex: 0x6fa84a, family: 'cool', weight: 4 },
  { name: 'Verde Oliva Claro', hex: 0xb7c182, family: 'cool', weight: 4 },
  { name: 'Azul Cielo', hex: 0x8fbedb, family: 'cool', weight: 8 },
  { name: 'Azul Anil', hex: 0x3e6e9e, family: 'cool', weight: 5 },
  { name: 'Lila Bougainvillea', hex: 0xc08bc0, family: 'cool', weight: 4 },
  { name: 'Violeta Suave', hex: 0x9f86c0, family: 'cool', weight: 3 },
];

/** §3.3 — trim / encadrement. */
const TRIMS: number[] = [0xfbf7ee, 0xf1ebdd, 0xede2cb, 0xdcd8ce, 0xbbd4e4];

/** §3.4 — joinery, iron and doors. */
const JOINERY: Array<{ hex: number; weight: number }> = [
  { hex: 0x14523c, weight: 12 },
  { hex: 0x2e6b4f, weight: 8 },
  { hex: 0x1b3a5c, weight: 7 },
  { hex: 0x2e5e86, weight: 6 },
  { hex: 0x9e2b25, weight: 6 },
  { hex: 0x6e2230, weight: 4 },
  { hex: 0x5a2e1b, weight: 4 },
  { hex: 0x10736e, weight: 5 },
  { hex: 0xb07b1e, weight: 2 },
];

export const IRON_HEX = 0x1e2a26;
export const IRON_RUST_HEX = 0x6b4a33;

/** §3.5 — roof tiles. */
const ROOF_TILES = [0xb0553a, 0xa04a2f, 0xc4663f, 0x8c3d26];
const AZOTEA_HEX = [0xc8bfa8, 0xa8a093];

/** §3.6 — the Jeep's hue. Nothing on the street may crowd it. */
const TAXI_HUE = 43;
const TAXI_GUARD = 20;
const TAXI_SAT_CAP = 0.34;

/* ---------------------------------------------------------- colour maths */

const tmpC = new THREE.Color();

/** CIE L* of an sRGB hex, 0..100 */
export function lstar(hex: number): number {
  tmpC.setHex(hex);
  const Y = 0.2126 * tmpC.r + 0.7152 * tmpC.g + 0.0722 * tmpC.b;
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

function srgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function toHex(r: number, g: number, b: number): number {
  const c = (v: number): number => clamp(Math.round(v * 255), 0, 255);
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/** HSL hue in degrees */
export function hueOf(hex: number): number {
  const [r, g, b] = srgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** HSV saturation, 0..1 */
function satOf(hex: number): number {
  const [r, g, b] = srgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max < 1e-6 ? 0 : (max - min) / max;
}

export function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** scale an sRGB colour toward/away from black until it hits a target L* */
function toLstar(hex: number, target: number): number {
  const [r, g, b] = srgb(hex);
  let lo = 0.05;
  let hi = 2.4;
  let k = 1;
  for (let i = 0; i < 22; i++) {
    k = (lo + hi) * 0.5;
    const l = lstar(toHex(r * k, g * k, b * k));
    if (l < target) lo = k;
    else hi = k;
  }
  return toHex(r * k, g * k, b * k);
}

/** cap HSV saturation, keeping hue and value */
function capSaturation(hex: number, cap: number): number {
  const s = satOf(hex);
  if (s <= cap) return hex;
  const [r, g, b] = srgb(hex);
  const max = Math.max(r, g, b);
  const t = cap / s;
  return toHex(lerp(max, r, t), lerp(max, g, t), lerp(max, b, t));
}

/** §3.2 per-instance jitter: hsl(±0.012 h, ±0.06 s, ±0.05 l) */
function jitter(hex: number, rng: RNG): number {
  tmpC.setHex(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  tmpC.getHSL(hsl, THREE.SRGBColorSpace);
  tmpC.setHSL(
    (hsl.h + rng.range(-0.012, 0.012) + 1) % 1,
    clamp01(hsl.s + rng.range(-0.06, 0.06)),
    clamp01(hsl.l + rng.range(-0.05, 0.05)),
    THREE.SRGBColorSpace,
  );
  return tmpC.getHex(THREE.SRGBColorSpace);
}

/**
 * §3.6 corollary — nothing near the driving line may crowd the taxi's yellow.
 * The warm family survives; it just goes chalky where it would compete.
 */
function guardTaxiHue(hex: number): number {
  if (hueDelta(hueOf(hex), TAXI_HUE) >= TAXI_GUARD) return hex;
  return capSaturation(hex, TAXI_SAT_CAP);
}

export interface Livery {
  wallHex: number;
  trimHex: number;
  joineryHex: number;
  wall: RGB;
  trim: RGB;
  joinery: RGB;
  family: 'warm' | 'cool' | 'neutral';
  hue: number;
}

/**
 * Picks a wall/trim/joinery set for one building, honouring L1, L2 and L3
 * against the buildings already placed on this block face.
 */
export class ColourBook {
  private recentHues: number[] = [];
  private recentFamilies: Array<'warm' | 'cool' | 'neutral'> = [];

  /** start a new block face — hue memory does not wrap around a corner */
  reset(): void {
    this.recentHues.length = 0;
    this.recentFamilies.length = 0;
  }

  pick(rng: RNG, zone: DistrictZone): Livery {
    // zone weighting: the art quarter runs cooler and louder, the fortress and
    // waterfront run paler and saltier, the plaza runs grand and warm
    const candidates: WallColour[] = [];
    const weights: number[] = [];
    for (const c of WALLS) {
      let w = c.weight;
      if (zone === 'artQuarter') w *= c.family === 'cool' ? 1.7 : 0.85;
      else if (zone === 'waterfront') w *= c.family === 'neutral' ? 1.6 : 0.9;
      else if (zone === 'fortress') w *= c.family === 'neutral' ? 2.2 : 0.6;
      else if (zone === 'plazaMayor') w *= c.family === 'warm' ? 1.5 : 0.9;
      else if (zone === 'hillside') w *= c.family === 'warm' ? 1.25 : 1;
      // L3 family run limit: no more than 2 of the last 5 from one family
      const runs = this.recentFamilies.slice(-4).filter((f) => f === c.family).length;
      if (runs >= 2) w *= 0.06;
      // L3 hue separation against the two immediate neighbours
      let ok = true;
      for (let i = Math.max(0, this.recentHues.length - 2); i < this.recentHues.length; i++) {
        if (hueDelta(this.recentHues[i], hueOf(c.hex)) < 35) ok = false;
      }
      if (!ok) w *= 0.004;
      candidates.push(c);
      weights.push(Math.max(1e-4, w));
    }
    const chosen = rng.weighted(candidates, weights);

    let wallHex = guardTaxiHue(jitter(chosen.hex, rng));
    // L1 — the trim must be at least 22 L* lighter than the wall. Pale walls
    // get pushed down rather than letting the encadrement go dark.
    const trimHex = rng.bool(0.08) ? TRIMS[4] : rng.weighted(TRIMS, [10, 7, 6, 4, 0]);
    const trimL = lstar(trimHex);
    if (trimL - lstar(wallHex) < 22) wallHex = toLstar(wallHex, trimL - 23.5);
    // L2 — joinery must be at least 30 L* darker than the wall.
    let joineryHex = rng.weighted(
      JOINERY.map((j) => j.hex),
      JOINERY.map((j) => j.weight),
    );
    const wallL = lstar(wallHex);
    if (wallL - lstar(joineryHex) < 30) joineryHex = toLstar(joineryHex, Math.max(6, wallL - 31));

    this.recentHues.push(hueOf(wallHex));
    this.recentFamilies.push(chosen.family);
    if (this.recentHues.length > 6) this.recentHues.shift();
    if (this.recentFamilies.length > 6) this.recentFamilies.shift();

    return {
      wallHex,
      trimHex,
      joineryHex,
      wall: linearRGB(wallHex),
      trim: linearRGB(trimHex),
      joinery: linearRGB(joineryHex),
      family: chosen.family,
      hue: hueOf(wallHex),
    };
  }
}

/* --------------------------------------------------------------- planning */

export interface LightWell {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface BalconySlot {
  kind: 'iron' | 'wood' | 'balconette';
  /** local x range on the frontage */
  x0: number;
  x1: number;
  /** local y of the balcony floor (top of slab) */
  y: number;
  bays: number;
  seed: number;
}

export interface BuildingPlan {
  lot: Lot;
  frame: Frame;
  /** world Y of the ground-floor level */
  floorY: number;
  bays: number;
  bayW: number;
  storeys: number;
  /** local y of each storey floor */
  storeyY: number[];
  /** local y of the cornice underside */
  topY: number;
  parapetH: number;
  roof: 'azotea' | 'tiled';
  livery: Livery;
  stucco: AtlasRect;
  /** local y of the pavement, relative to floorY */
  groundAt(x: number): number;
  /** lowest pavement level anywhere under the lot, local */
  lowY: number;
  depth: number;
  hasShop: boolean;
  shopSign: AtlasRect;
  shuttered: boolean;
  awning: boolean;
  balconyRun: boolean;
  woodBalcony: boolean;
  cuarto: 0 | 1 | -1;
  quoins: boolean;
  zaguan: boolean;
  floatingLintel: boolean;
  mural: AtlasRect | null;
  muralSide: 1 | -1;
  repaintBay: number;
  repaint: RGB;
  spalled: boolean;
  plaque: 0 | 1 | -1;
  doorBay: number;
  lightWell: LightWell | null;
  balconies: BalconySlot[];
  /** §6.2 R6 — the skyline event this building contributes */
  parapetProfile: ParapetProfile;
  /** §3.2 salt haze: extra top-of-wall bleaching on seaward elevations */
  haze: number;
  /** a projecting bracket sign over the shopfront */
  hangSign: boolean;
  seed: number;
  rng: RNG;
}

export interface PlanInput {
  lot: Lot;
  atlas: FacadeAtlas;
  colours: ColourBook;
  groundHeight(x: number, z: number): number;
  /** parapet height already used by the previous lot on this face */
  prevParapet: number;
  /** running mural budget for the whole map (§7.4: 6–10) */
  muralBudget: { left: number };
  /** true when this lot starts or ends a block face */
  cornerStart: boolean;
  cornerEnd: boolean;
}

const FRONT_BLOCK_DEPTH = 9.5;

/** Everything about a building that has to be decided before geometry runs. */
export function planLot(input: PlanInput): BuildingPlan {
  const { lot, atlas } = input;
  const rng = new RNG(lot.seed ^ 0x51a3c7);
  const poly = lot.polygon;
  const i0 = lot.frontEdge % poly.length;
  const i1 = (i0 + 1) % poly.length;
  const p0 = poly[i0];
  const p1 = poly[i1];

  // §1.2 — the pavement under a townhouse slopes, so sample it and set the
  // ground floor a single step above the highest point of the doorway line.
  const SAMPLES = 7;
  let frontMax = -Infinity;
  let lowest = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const g = input.groundHeight(lerp(p0.x, p1.x, t), lerp(p0.y, p1.y, t));
    if (g > frontMax) frontMax = g;
    if (g < lowest) lowest = g;
  }
  for (const p of poly) {
    const g = input.groundHeight(p.x, p.y);
    if (g < lowest) lowest = g;
  }
  const floorY = frontMax + 0.09;
  /* Each building gets its own tiling phase, so the stucco lattice is
     continuous *within* a house and deliberately out of step with its
     neighbours — §8.17 is "every stucco wall has the same trowel texture at
     the same scale and phase". */
  const phaseU = (lot.seed % 311) / 311 * CASA.stuccoTile;
  const phaseV = ((lot.seed >> 7) % 271) / 271 * CASA.stuccoTile;
  const frame = makeFrame(p0.x, p0.y, p1.x, p1.y, floorY, phaseU, phaseV);

  const groundAt = (x: number): number => {
    const t = clamp01(x / Math.max(0.001, frame.len));
    return input.groundHeight(lerp(p0.x, p1.x, t), lerp(p0.y, p1.y, t)) - floorY;
  };

  // §1.2 — bay module 2.90; 1 bay on the narrowest houses, up to 7 on a palacete
  const bays = clamp(Math.round(lot.frontage / CASA.bay), 1, 7);
  const bayW = lot.frontage / bays;

  const storeys = clamp(lot.storeys, 1, 4);
  const storeyY: number[] = [0];
  for (let s = 1; s < storeys; s++) storeyY.push(CASA.groundH + (s - 1) * CASA.upperH);
  const topY = CASA.groundH + (storeys - 1) * CASA.upperH;

  // §1.7 — adjacent parapets must never match; minimum step 0.55, target 1.4
  const options = [CASA.parapetH, CASA.parapetH + 0.62, CASA.parapetH + 1.28, CASA.parapetH + 1.95];
  let parapetH = rng.pick(options);
  const prevTop = input.prevParapet;
  for (let tries = 0; tries < 6 && Math.abs(topY + parapetH - prevTop) < 0.55; tries++) {
    parapetH = options[(options.indexOf(parapetH) + 1) % options.length];
  }

  // §1.6 — 70 % azoteas, 30 % tiled; tiles favour corners, churches, rear wings
  const tiledChance = lot.zone === 'hillside' ? 0.42 : input.cornerStart || input.cornerEnd ? 0.4 : 0.24;
  const roof: 'azotea' | 'tiled' = rng.bool(tiledChance) ? 'tiled' : 'azotea';

  const livery = input.colours.pick(rng, lot.zone);
  const stucco = atlas.rect(rng.pick(STUCCO_KEYS));

  const shopZone =
    lot.zone === 'marketRow' || lot.zone === 'plazaMayor' || lot.zone === 'artQuarter' || lot.zone === 'waterfront';
  const hasShop = shopZone ? rng.bool(lot.zone === 'marketRow' ? 0.85 : 0.42) : rng.bool(0.12);

  // §1.4 — a balcony unites all bays of the upper floor on ~55 % of houses
  const balconyRun = rng.bool(0.55) && bays > 1;
  // wooden-balustrade balconies are usually roofed; metal ones usually are not
  const woodBalcony = rng.bool(lot.zone === 'plazaMayor' ? 0.3 : lot.zone === 'hillside' ? 0.24 : 0.18);

  const cuarto: 0 | 1 | -1 =
    (input.cornerStart || input.cornerEnd) && rng.bool(1 / 6) ? (input.cornerEnd ? 1 : -1) : 0;
  const plaque: 0 | 1 | -1 = input.cornerStart ? -1 : input.cornerEnd ? 1 : 0;

  let mural: AtlasRect | null = null;
  let muralSide: 1 | -1 = 1;
  if (input.muralBudget.left > 0 && lot.zone === 'artQuarter' && rng.bool(0.3)) {
    mural = atlas.rect(rng.pick(MURAL_KEYS));
    muralSide = rng.bool() ? 1 : -1;
    input.muralBudget.left--;
  }

  const depth = Math.max(4, lot.depth);
  const wellDepth = Math.min(6.5, depth - FRONT_BLOCK_DEPTH - 2.2);
  const lightWell: LightWell | null =
    depth >= 15 && lot.frontage >= 7 && wellDepth >= 3.4
      ? {
          x0: rng.bool() ? 1.3 : lot.frontage - 5.6,
          x1: 0,
          z0: -(FRONT_BLOCK_DEPTH + 1.1),
          z1: -(FRONT_BLOCK_DEPTH + 1.1 + Math.min(5.4, wellDepth)),
        }
      : null;
  if (lightWell) lightWell.x1 = Math.min(lot.frontage - 1.3, lightWell.x0 + 4.3);

  const plan: BuildingPlan = {
    lot,
    frame,
    floorY,
    bays,
    bayW,
    storeys,
    storeyY,
    topY,
    parapetH,
    roof,
    livery,
    stucco,
    groundAt,
    lowY: lowest - floorY,
    depth,
    hasShop,
    shopSign: atlas.rect(rng.pick(SIGN_KEYS)),
    shuttered: rng.bool(0.22),
    awning: rng.bool(0.55),
    balconyRun,
    woodBalcony,
    cuarto,
    quoins: lot.zone === 'plazaMayor' ? rng.bool(0.6) : rng.bool(0.1),
    zaguan: rng.bool(0.4),
    floatingLintel: rng.bool(0.2),
    mural,
    muralSide,
    repaintBay: rng.bool(0.12) ? rng.int(0, bays - 1) : -1,
    repaint: linearRGB(guardTaxiHue(jitter(rng.pick(WALLS).hex, rng))),
    spalled: rng.bool(lot.zone === 'hillside' || lot.zone === 'fortress' ? 0.16 : 0.08),
    plaque,
    doorBay: bays === 1 ? 0 : bays % 2 === 1 ? (bays - 1) / 2 : rng.bool() ? bays / 2 - 1 : bays / 2,
    lightWell,
    balconies: [],
    // §6.2 R6 — a third of the parapets break the skyline; corners more often
    parapetProfile: rng.weighted<ParapetProfile>(
      ['plain', 'piers', 'centre', 'stepped'],
      input.cornerStart || input.cornerEnd ? [42, 20, 20, 18] : [68, 13, 11, 8],
    ),
    haze: lot.zone === 'waterfront' || lot.zone === 'fortress' ? rng.range(0.05, 0.12) : rng.range(0, 0.04),
    hangSign: rng.bool(0.45),
    seed: lot.seed,
    rng,
  };
  return plan;
}

/** Roof colour for a plan — tiles get per-building hue jitter, §5. */
export function roofColour(plan: BuildingPlan): RGB {
  const hex =
    plan.roof === 'tiled'
      ? ROOF_TILES[plan.seed % ROOF_TILES.length]
      : AZOTEA_HEX[(plan.seed >> 3) % AZOTEA_HEX.length];
  return linearRGB(jitter(hex, new RNG(plan.seed ^ 0x77)));
}

/* ------------------------------------------------------------- composition */

function kit(plan: BuildingPlan, b: GeomBuilder, atlas: FacadeAtlas, lod: 0 | 1, frame = plan.frame): KitCtx {
  return {
    b,
    f: frame,
    atlas,
    wall: plan.livery.wall,
    trim: plan.livery.trim,
    joinery: plan.livery.joinery,
    stucco: plan.stucco,
    lod,
  };
}

/** window glow packed for the shader: (intensity, warmth, per-building phase) */
function glowFor(plan: BuildingPlan, rng: RNG, ground: boolean): [number, number, number] {
  // §4.3 — 55 % of windows lit, per-window random warm/cool ±200 K
  const lit = rng.bool(ground ? 0.42 : 0.58);
  if (!lit) return [0, 0, 0];
  return [rng.range(0.45, 1.0), rng.range(0, 1), (plan.seed % 97) / 97];
}

/**
 * Emit one lot's street elevation. `lod` 0 models the reveals, cornice profile
 * and applied trim; `lod` 1 flattens all of it and paints the openings on the
 * wall plane instead.
 */
export function composeFacade(plan: BuildingPlan, b: GeomBuilder, atlas: FacadeAtlas, lod: 0 | 1): void {
  const k = kit(plan, b, atlas, lod);
  const f = plan.frame;
  const W = f.len;
  const rng = new RNG(plan.seed ^ 0x9111);
  const eW = CASA.encadrementW;
  const wall = plan.livery.wall;
  /* §3.2 weathering: the wall bleaches upward on seaward elevations (salt
     haze) and grimes downward at the pavement (splash). Both are constants of
     the whole elevation, so every panel below shares them. */
  const wallTop = 1.02 + plan.haze;
  const wallBottom = 0.88;

  /* --- plinth: the podium that solves the street slope --- */
  const plinthTop = CASA.plinthH - 0.09;
  plinth(k, 0, W, plinthTop, plan.groundAt, 0.55, plan.spalled);

  /* --- storeys --- */
  for (let s = 0; s < plan.storeys; s++) {
    const ys = plan.storeyY[s];
    const ye = s === plan.storeys - 1 ? plan.topY : plan.storeyY[s + 1];
    const ground = s === 0;
    const yBandBottom = ground ? plinthTop : ys;

    for (let i = 0; i < plan.bays; i++) {
      const bx0 = (i * W) / plan.bays;
      const bx1 = ((i + 1) * W) / plan.bays;
      const cx = (bx0 + bx1) * 0.5;

      const bayWall = i === plan.repaintBay ? plan.repaint : wall;
      const bayRect = plan.spalled && i === (plan.seed >> 5) % plan.bays ? atlas.rect('rubble') : plan.stucco;

      let ox0 = cx - CASA.windowW * 0.5;
      let ox1 = cx + CASA.windowW * 0.5;
      let oy0 = ys + CASA.windowSill;
      let oy1 = ys + CASA.windowSill + CASA.windowH;
      let blind = false;

      if (ground) {
        if (plan.hasShop && i !== plan.doorBay) {
          // shopfront: wider and taller than a window, sill on the pavement
          ox0 = bx0 + 0.42;
          ox1 = bx1 - 0.42;
          oy0 = plinthTop + 0.05;
          oy1 = ys + 3.0;
        } else if (i === plan.doorBay) {
          ox0 = cx - CASA.doorW * 0.5;
          ox1 = cx + CASA.doorW * 0.5;
          oy0 = 0;
          oy1 = CASA.doorH + CASA.fanlightH;
        }
      } else {
        // §1.3 — never a "window" upstairs on the street face
        ox0 = cx - CASA.balconyDoorW * 0.5;
        ox1 = cx + CASA.balconyDoorW * 0.5;
        oy0 = ys + 0.05;
        oy1 = ys + CASA.balconyDoorH + CASA.transomH;
        if (plan.bays > 4 && i === plan.bays - 1 && rng.bool(0.25)) blind = true;
      }

      /* wall around the opening — the picture-frame partition keeps the
         solid-to-void ratio at the documented 59 : 41 */
      if (blind) {
        panel(b, f, atlas, bayRect, bx0, yBandBottom, bx1, ye, 0, bayWall, {
          tile: CASA.stuccoTile,
          shadeBottom: wallBottom,
          shadeTop: wallTop,
        });
      } else {
        const lx = Math.max(bx0, ox0 - eW);
        const rx = Math.min(bx1, ox1 + eW);
        const by = Math.max(yBandBottom, oy0 - eW);
        const ty = Math.min(ye, oy1 + eW);
        const wOpts = { tile: CASA.stuccoTile, shadeBottom: wallBottom, shadeTop: wallTop };
        panel(b, f, atlas, bayRect, bx0, yBandBottom, lx, ye, 0, bayWall, wOpts);
        panel(b, f, atlas, bayRect, rx, yBandBottom, bx1, ye, 0, bayWall, wOpts);
        if (by > yBandBottom) panel(b, f, atlas, bayRect, lx, yBandBottom, rx, by, 0, bayWall, { tile: CASA.stuccoTile, shadeBottom: wallBottom, shadeTop: 1.0 });
        if (ty < ye) panel(b, f, atlas, bayRect, lx, ty, rx, ye, 0, bayWall, { tile: CASA.stuccoTile, shadeBottom: 1.0, shadeTop: wallTop });

        /* the opening itself */
        if (ground && plan.hasShop && i !== plan.doorBay) {
          shopfront(k, ox0, oy0, ox1, oy1, plan.shopSign, plan.shuttered, plan.awning && lod === 0);
          // §7.1 — a projecting bracket sign on the bay next to the door
          if (lod === 0 && plan.hangSign && i === (plan.doorBay + 1) % plan.bays) {
            hangingSign(k, cx, oy1 + 1.15, plan.shopSign, i < plan.bays * 0.5 ? -1 : 1);
          }
        } else if (ground && i === plan.doorBay) {
          const grand = plan.lot.zone === 'plazaMayor' || rng.bool(0.18);
          opening(k, ox0, oy0, ox1, oy1, {
            leaf: plan.zaguan && lod === 0 ? atlas.rect('zaguan') : atlas.rect(grand ? 'doorGrand' : 'doorPanel'),
            leafColor: plan.zaguan && lod === 0 ? WHITE : plan.livery.joinery,
            head: atlas.rect('fanlight'),
            headH: CASA.fanlightH,
            depth: plan.zaguan ? 0.62 : CASA.revealD,
          });
          if (lod === 0) {
            encadrement(k, ox0, oy0, ox1, oy1);
            numberTile(k, ox1 + eW + 0.24, oy1 * 0.52);
          }
        } else if (ground) {
          // §1.4 — balconettes at ground level, behind an iron reja
          opening(k, ox0, oy0, ox1, oy1, {
            leaf: atlas.rect('reja'),
            leafColor: plan.livery.joinery,
            glow: glowFor(plan, rng, true),
            sill: lod === 0,
          });
          if (lod === 0) {
            encadrement(k, ox0, oy0, ox1, oy1);
            plan.balconies.push({ kind: 'balconette', x0: ox0 - 0.18, x1: ox1 + 0.18, y: oy0 - 0.06, bays: 1, seed: plan.seed ^ (i * 131) });
            // the guard's own contact shadow, then the sill's drip stain
            undersideShadow(k, ox0 - 0.18, ox1 + 0.18, oy0 - 0.1, 0.34, 0.66);
            if (rng.bool(0.45)) dripStreak(k, ox0 + 0.1, ox1 - 0.1, oy0 - 0.14, rng.range(0.35, 0.95));
          }
        } else {
          const shut = rng.bool(0.35);
          opening(k, ox0, oy0, ox1, oy1, {
            leaf: shut ? atlas.rect('persianaUpper') : atlas.rect('glass'),
            leafColor: shut ? plan.livery.joinery : WHITE,
            glow: shut ? [0, 0, 0] : glowFor(plan, rng, false),
            head: atlas.rect('transom'),
            headH: CASA.transomH,
          });
          if (lod === 0) {
            encadrement(k, ox0, oy0, ox1, oy1);
            if (plan.floatingLintel && i === plan.doorBay) floatingLintel(k, ox0, ox1, oy1);
            if (!plan.balconyRun) {
              plan.balconies.push({
                kind: plan.woodBalcony ? 'wood' : 'iron',
                x0: bx0 + 0.18,
                x1: bx1 - 0.18,
                y: ys,
                bays: 1,
                seed: plan.seed ^ (s * 977) ^ (i * 313),
              });
              // §8.2 — the balcony slab's contact shadow on the wall below it
              undersideShadow(k, bx0 + 0.18, bx1 - 0.18, ys - 0.02, 0.85, 0.5);
            }
            if (rng.bool(0.35)) dripStreak(k, ox0, ox1, oy0 - 0.05, rng.range(0.2, 0.6));
          }
        }
      }
    }

    /* one balcony uniting all the bays of this floor */
    if (!ground && plan.balconyRun && lod === 0) {
      plan.balconies.push({
        kind: plan.woodBalcony ? 'wood' : 'iron',
        x0: 0.16,
        x1: W - 0.16,
        y: ys,
        bays: plan.bays,
        seed: plan.seed ^ (s * 6151),
      });
      undersideShadow(k, 0.16, W - 0.16, ys - 0.02, 0.95, 0.46);
      // rust and rain run off the slab ends onto the wall
      if (rng.bool(0.5)) dripStreak(k, 0.3, 0.3 + rng.range(0.25, 0.5), ys - 0.2, rng.range(0.6, 1.6));
      if (rng.bool(0.5)) dripStreak(k, W - 0.8, W - 0.8 + rng.range(0.25, 0.5), ys - 0.2, rng.range(0.6, 1.6));
    }

    /* a string course marking the floor line on the grander houses */
    if (lod === 0 && s > 0 && (plan.quoins || plan.lot.zone === 'plazaMayor')) stringCourse(k, 0, W, ys - 0.12);
  }

  /* --- crowning: cornice, then parapet or eaves --- */
  cornice(k, 0, W, plan.topY);
  if (plan.roof === 'azotea') {
    parapet(
      k, 0, W, plan.topY + CASA.corniceH, plan.parapetH, CASA.cornicePr * 0.55,
      CASA.parapetT, lod === 0 ? plan.parapetProfile : 'plain',
    );
  }

  if (lod === 0) {
    if (plan.quoins) {
      quoins(k, 0, plinthTop, plan.topY, -1);
      quoins(k, W, plinthTop, plan.topY, 1);
    }
    if (plan.cuarto !== 0) {
      cuartoEsquinero(k, plan.cuarto > 0 ? W : 0, CASA.groundH * 0.5, plan.topY, plan.cuarto > 0 ? 1 : -1);
    }
    // §1.1 — one azulejo plaque per corner per street, centre 2.55 above the walk
    if (plan.plaque !== 0) {
      azulejoPlaque(k, plan.plaque > 0 ? W - 0.7 : 0.7, 2.55 - 0.09);
    }
  }
}

/**
 * The building mass behind the elevation: party walls, the rear wall, the
 * courtyard light well and the visible flank where a neighbour is shorter.
 * Party walls are only drawn above the neighbour's roofline, so two adjacent
 * townhouses never z-fight and never show daylight between them.
 */
export function composeShell(
  plan: BuildingPlan,
  b: GeomBuilder,
  atlas: FacadeAtlas,
  lod: 0 | 1,
  neighbourTop: number[],
): void {
  const lot = plan.lot;
  const poly = lot.polygon;
  const n = poly.length;
  const front = lot.frontEdge % n;
  const wall = plan.livery.wall;
  const top = plan.topY + CASA.corniceH + (plan.roof === 'azotea' ? plan.parapetH : 0.1);
  const bottom = plan.lowY - 0.6;

  for (let e = 0; e < n; e++) {
    if (e === front) continue;
    const a = poly[e];
    const c = poly[(e + 1) % n];
    const ef = makeFrame(a.x, a.y, c.x, c.y, plan.floorY, plan.frame.tu, plan.frame.tv);
    const rear = e === (front + 2) % n;
    const nb = neighbourTop[e];
    const base = rear ? bottom : Math.max(bottom, nb - plan.floorY - 0.05);
    if (base >= top - 0.02) continue;

    const rect = plan.spalled && !rear ? atlas.rect('rubble') : plan.stucco;
    const col = rear ? shadeRGB(wall, 0.94) : shadeRGB(wall, 0.9);
    // party walls and rears are only ever seen across a block or from the air,
    // so they tile at half density — a quarter of the quads for no visible loss
    panel(b, ef, atlas, rect, 0, base, ef.len, top, 0, col, {
      tile: CASA.bulkTile,
      shadeBottom: 0.82,
      shadeTop: 1.02,
    });

    // §7.4 — murals belong on party-wall end elevations, not historic façades
    if (plan.mural && !rear && lod === 0 && top - base > 4) {
      const mw = Math.min(ef.len * 0.8, 7.5);
      const mh = Math.min(top - base - 1.2, 5.4);
      const mx = (ef.len - mw) * 0.5;
      panel(b, ef, atlas, plan.mural, mx, top - mh - 0.9, mx + mw, top - 0.9, 0.02, WHITE);
      plan.mural = null;
    }

    // a finished rear gets real windows; §1.7 says the block must read inhabited
    if (rear && lot.exposedRear && lod === 0) {
      const k = kit(plan, b, atlas, lod, ef);
      const rbays = Math.max(1, Math.round(ef.len / 3.2));
      const rrng = new RNG(plan.seed ^ 0x4d2);
      for (let s = 0; s < plan.storeys; s++) {
        for (let i = 0; i < rbays; i++) {
          if (rrng.bool(0.3)) continue;
          const cx = ((i + 0.5) * ef.len) / rbays;
          const y = plan.storeyY[s] + 1.05;
          opening(k, cx - 0.5, y, cx + 0.5, y + 1.7, {
            leaf: atlas.rect(rrng.bool(0.4) ? 'persianaLower' : 'glass'),
            leafColor: rrng.bool(0.4) ? plan.livery.joinery : WHITE,
            glow: glowFor(plan, rrng, false),
            depth: 0.2,
            sill: true,
          });
        }
      }
    }
  }
}

/**
 * The interior courtyard (§1.7) as a light well punched through the rear roof
 * deck. Cheap in triangles, and it is what makes the block read as inhabited
 * rather than as an extruded shell when you look down from a rooftop.
 */
export function composeLightWell(plan: BuildingPlan, b: GeomBuilder, atlas: FacadeAtlas): void {
  const w = plan.lightWell;
  if (!w) return;
  const k = kit(plan, b, atlas, 0);
  const f = plan.frame;
  const depth = 3.9;
  const yTop = plan.topY - CASA.upperH * 0.35;
  const yFloor = yTop - depth;
  const wallCol = shadeRGB(plan.livery.trim, 0.94);
  // four walls, facing inward
  panel(b, f, atlas, plan.stucco, w.x0, yFloor, w.x1, yTop, w.z0, wallCol, { tile: CASA.bulkTile, face: -1 });
  panel(b, f, atlas, plan.stucco, w.x0, yFloor, w.x1, yTop, w.z1, wallCol, { tile: CASA.bulkTile });
  sidePanel(b, f, atlas, plan.stucco, w.z1, yFloor, w.z0, yTop, w.x0, wallCol, 1);
  sidePanel(b, f, atlas, plan.stucco, w.z1, yFloor, w.z0, yTop, w.x1, wallCol, -1);
  // the patio floor — warm tile catching the light shaft
  box(
    b, f, atlas, atlas.rect('plinth'),
    w.x0, yFloor - 0.1, w.z1, w.x1, yFloor, w.z0,
    linearRGB(0xc98a5a), FACE_PY,
  );
  // a plant and a well head, in silhouette from above
  box(b, f, atlas, atlas.rect('plinth'), w.x0 + 0.5, yFloor, w.z1 + 0.5, w.x0 + 1.1, yFloor + 0.55, w.z1 + 1.1, linearRGB(0xa5613a), FACE_PZ | FACE_PX | FACE_NX | FACE_PY);
  void k;
}
