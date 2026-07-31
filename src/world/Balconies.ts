/**
 * Loco Lift — balconies, balconettes and the greenery on them.
 *
 * `docs/ART_REFERENCE.md` §1.4, verbatim in spirit: *balconettes at ground
 * level, balconies from the second floor up, **never** a balcony at ground
 * level.* Wooden-balustrade balconies are usually roofed; metal ones usually
 * are not. At least 60 % of them carry 2–5 pots, and up to 15 % carry laundry
 * — one in three of those a Puerto Rican flag.
 *
 * Every assembly is an `InstancedMesh` shared across the whole district and
 * bucketed by spatial region, so ~6 000 balconies and ~9 000 pots cost a few
 * dozen draw calls. Width variation is handled by four nominal widths plus a
 * ±20 % X scale on the instance, which lands the baluster pitch inside the
 * documented 0.10–0.13 range instead of stretching it out of period.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { Canvas2D, TextureFactory } from './TextureFactory';
import { createCanvas } from './TextureFactory';
import type { FacadeAtlas } from './FacadeTextures';
import {
  BALCON,
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_PX,
  FACE_PY,
  FACE_PZ,
  InstanceRegistry,
  PartBuilder,
  frameYaw,
  instanceMatrix,
  linearRGB,
  shadeRGB,
  worldX,
  worldZ,
} from './BuildingKit';
import type { Frame, RGB } from './BuildingKit';
import type { BalconySlot, BuildingPlan } from './Facades';
import { IRON_HEX, IRON_RUST_HEX } from './Facades';

/* ------------------------------------------------------------- textures */

/**
 * The ironwork texture. `wrapS` repeats one **baluster pitch** per U unit, so a
 * railing card that spans N balusters just runs u from 0 to N.
 *
 *   v 0.00 – 0.50  solid painted iron (slabs, rails, brackets)
 *   v 0.50 – 1.00  balustrade: bar in the middle of every pitch, opaque top
 *                  and bottom rails baked into the band
 *
 * The balustrade band is **alpha cut-out**: everything between the bars is
 * cleared, and the material that draws it runs `alphaTest`. Both halves of
 * that contract matter — an opaque material sampling this texture renders the
 * cleared pixels as solid black, which is exactly the black band that ran
 * along every balcony line in the pre-fix capture. `wrapS` must likewise be
 * `RepeatWrapping`, or a card spanning 24 balusters clamps every bar into the
 * last texel column and the whole rail collapses to one flat slab.
 */
export function ironTexture(textures: TextureFactory): THREE.Texture {
  return textures.texture('buildings:iron', () => {
    const W = 64;
    const H = 256;
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as Canvas2D | null;
    if (!ctx) throw new Error('Balconies: 2D canvas unavailable');
    ctx.clearRect(0, 0, W, H);

    // --- solid half (canvas bottom) ---
    const g = ctx.createLinearGradient(0, H * 0.5, 0, H);
    g.addColorStop(0, '#d8d8d8');
    g.addColorStop(0.35, '#f2f2f2');
    g.addColorStop(1, '#b4b4b4');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);
    const r = new RNG(0x51ee31);
    for (let i = 0; i < 220; i++) {
      ctx.fillStyle = `rgba(${r.int(90, 200)},${r.int(80, 170)},${r.int(70, 150)},${r.range(0.05, 0.22)})`;
      ctx.fillRect(r.range(0, W), H * 0.5 + r.range(0, H * 0.5), r.range(1, 5), r.range(1, 4));
    }

    // --- balustrade half (canvas top) ---
    const barW = W * 0.3;
    const bx = (W - barW) * 0.5;
    const bg = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    bg.addColorStop(0, '#7a7a7a');
    bg.addColorStop(0.3, '#ffffff');
    bg.addColorStop(0.68, '#c4c4c4');
    bg.addColorStop(1, '#606060');
    ctx.fillStyle = bg;
    ctx.fillRect(bx, 0, barW, H * 0.5);
    // a twist half way up, which is what wrought iron actually looks like
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 5; i++) {
      const y = H * (0.16 + i * 0.045);
      ctx.fillRect(bx - W * 0.06, y, barW + W * 0.12, H * 0.013);
    }
    // opaque top and bottom rails baked into the band
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, W, H * 0.045);
    ctx.fillStyle = '#dcdcdc';
    ctx.fillRect(0, H * 0.43, W, H * 0.07);

    const tex = new THREE.CanvasTexture(c as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // one baluster pitch per u unit — the whole point of the card layout
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** Leaf-cluster cutout for balcony planting and trailing bougainvillea. */
export function foliageTexture(textures: TextureFactory): THREE.Texture {
  return textures.texture('buildings:foliage', () => {
    const S = 128;
    const c = createCanvas(S, S);
    const ctx = c.getContext('2d') as Canvas2D | null;
    if (!ctx) throw new Error('Balconies: 2D canvas unavailable');
    ctx.clearRect(0, 0, S, S);
    const r = new RNG(0x9ca71);
    // leaves radiating from a low centre, so the card reads as a plant
    for (let i = 0; i < 90; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = r.range(0, S * 0.42);
      const x = S * 0.5 + Math.cos(a) * d;
      const y = S * 0.62 + Math.sin(a) * d * 0.85;
      const w = r.range(S * 0.05, S * 0.13);
      const h = w * r.range(0.4, 0.75);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(r.range(0, Math.PI * 2));
      const v = r.range(0.55, 1.0);
      ctx.fillStyle = `rgba(${Math.round(200 * v)},${Math.round(235 * v)},${Math.round(190 * v)},1)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // a few bright blossom clusters, tinted per-instance by the vertex colour
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = `rgba(255,255,255,${r.range(0.5, 0.95)})`;
      ctx.beginPath();
      ctx.arc(r.range(S * 0.18, S * 0.82), r.range(S * 0.15, S * 0.75), r.range(S * 0.02, S * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  });
}

/* ------------------------------------------------------------ geometry */

/** solid-iron UV block, safely inside the opaque half of the texture */
const SOLID = { u0: 0.1, v0: 0.12, u1: 0.9, v1: 0.38 };
/** balustrade band */
const RAIL_V0 = 0.52;
const RAIL_V1 = 0.99;

const IRON: RGB = linearRGB(IRON_HEX);
const IRON_WORN: RGB = linearRGB(IRON_RUST_HEX, 0.9);
const STONE_SLAB: RGB = linearRGB(0xb9b2a2);

/** a right-triangle gusset in the ZY plane, extruded along X — the ménsula */
function bracket(p: PartBuilder, x: number, t: number, pr: number, drop: number, c: RGB): void {
  const prof: Array<[number, number]> = [
    [0, 0],
    [pr, 0],
    [pr * 0.34, -drop * 0.42],
    [0, -drop],
  ];
  const x0 = x - t * 0.5;
  const x1 = x + t * 0.5;
  const u = (SOLID.u0 + SOLID.u1) * 0.5;
  const v = (SOLID.v0 + SOLID.v1) * 0.5;
  // two faces
  for (const [side, nx] of [
    [x1, 1],
    [x0, -1],
  ] as Array<[number, number]>) {
    const idx: number[] = [];
    for (const [z, y] of prof) idx.push(p.vert(side, y, z, nx, 0, 0, u, v, shadeRGB(c, nx > 0 ? 1 : 0.85)));
    if (nx > 0) {
      p.tri(idx[0], idx[1], idx[2]);
      p.tri(idx[0], idx[2], idx[3]);
    } else {
      p.tri(idx[0], idx[2], idx[1]);
      p.tri(idx[0], idx[3], idx[2]);
    }
  }
  // The scrolled outer edge, one strip per profile segment. A second card used
  // to be laid at x = 0 — inside the 0.05 m thickness, where nothing can ever
  // see it: 2 triangles x ~5 brackets x ~4 000 balconies of pure waste.
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1];
    const b = prof[i];
    if (i === 1) continue;
    const q0 = p.vert(x0, a[1], a[0], 0, 0, 1, u, v, shadeRGB(c, 1.05));
    const q1 = p.vert(x1, a[1], a[0], 0, 0, 1, u, v, shadeRGB(c, 1.05));
    const q2 = p.vert(x1, b[1], b[0], 0, 0, 1, u, v, shadeRGB(c, 1.05));
    const q3 = p.vert(x0, b[1], b[0], 0, 0, 1, u, v, shadeRGB(c, 1.05));
    p.quad(q0, q1, q2, q3);
  }
}

/** railing run: two parallel alpha cards, so the bars keep depth at a raking angle */
function railRun(p: PartBuilder, plane: 'x' | 'z', a0: number, a1: number, at: number, h: number, c: RGB, single = false): void {
  const bars = Math.max(2, Math.round(Math.abs(a1 - a0) / BALCON.barPitch));
  const off = 0.011;
  if (plane === 'z') {
    p.cardXY(a0, 0, a1, h, at + off, 0, RAIL_V0, bars, RAIL_V1, c, 1);
    if (!single) p.cardXY(a0, 0, a1, h, at - off, 0, RAIL_V0, bars, RAIL_V1, shadeRGB(c, 0.8), 1);
  } else {
    p.cardZY(a0, 0, a1, h, at + off, 0, RAIL_V0, bars, RAIL_V1, c, 1);
    if (!single) p.cardZY(a0, 0, a1, h, at - off, 0, RAIL_V0, bars, RAIL_V1, shadeRGB(c, 0.8), -1);
  }
}

/**
 * A wrought-iron balcony at nominal width `w`: stone slab, three-plus brackets
 * at 1.45 pitch with 0.85 projection, balustrade at 1.02 with a real top rail.
 */
function ironBalcony(w: number, worn: boolean): THREE.BufferGeometry {
  const p = new PartBuilder();
  const d = BALCON.ironDepth;
  const hw = w * 0.5;
  const c = worn ? IRON_WORN : IRON;
  // slab
  p.boxUV(-hw, -BALCON.ironSlabT, 0, hw, 0, d, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, STONE_SLAB, FACE_PZ | FACE_PX | FACE_NX | FACE_PY | 8);
  // brackets
  const n = Math.max(3, Math.round(w / BALCON.bracketPitch) + 1);
  for (let i = 0; i < n; i++) {
    const x = lerp(-hw + 0.16, hw - 0.16, n === 1 ? 0.5 : i / (n - 1));
    bracket(p, x, BALCON.bracketT, BALCON.bracketPr, 0.62, c);
  }
  // balustrade: front run plus two returns
  railRun(p, 'z', -hw, hw, d - 0.03, BALCON.railH, c);
  railRun(p, 'x', 0.05, d - 0.03, -hw + 0.03, BALCON.railH, c, true);
  railRun(p, 'x', 0.05, d - 0.03, hw - 0.03, BALCON.railH, c, true);
  // top rail, Ø 0.032 — the silhouette that survives at 60 m
  const t = BALCON.topRailD;
  const y = BALCON.railH;
  p.boxUV(-hw - 0.02, y - t, d - 0.03 - t * 0.5, hw + 0.02, y, d - 0.03 + t * 0.5, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, c, FACE_PY | FACE_PZ | FACE_NZ);
  p.boxUV(-hw - 0.02, y - t, 0.03, -hw + 0.02 + t, y, d, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, c, FACE_PY | FACE_NX);
  p.boxUV(hw - 0.02 - t, y - t, 0.03, hw + 0.02, y, d, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, c, FACE_PY | FACE_PX);
  return p.build();
}

/** A balconette (balcón raso): the iron guard bellying 0.16 out of the reveal. */
function balconette(w: number): THREE.BufferGeometry {
  const p = new PartBuilder();
  const d = BALCON.balconetteDepth;
  const hw = w * 0.5;
  const h = BALCON.balconetteH;
  railRun(p, 'z', -hw, hw, d, h, IRON);
  p.cardZY(0.01, 0, d, h, -hw, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, shadeRGB(IRON, 0.9), -1);
  p.cardZY(0.01, 0, d, h, hw, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, shadeRGB(IRON, 0.9), 1);
  const t = BALCON.topRailD;
  p.boxUV(-hw - 0.02, h - t, -0.01, hw + 0.02, h, d + t * 0.5, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, IRON, FACE_PY | FACE_PZ | FACE_PX | FACE_NX);
  p.boxUV(-hw - 0.02, 0, -0.01, hw + 0.02, 0.055, d, SOLID.u0, SOLID.v0, SOLID.u1, SOLID.v1, IRON, FACE_PY | FACE_PZ | FACE_NY);
  return p.build();
}

/**
 * The roofed wooden balcony — projection 1.15, balustrade 1.00, clear height
 * 2.45, roof at 12° with a 0.20 overhang in corrugated zinc.
 */
function woodBalcony(w: number, atlas: FacadeAtlas): THREE.BufferGeometry {
  const p = new PartBuilder();
  const d = BALCON.woodDepth;
  const hw = w * 0.5;
  const timber = atlas.rect('timber');
  const zinc = atlas.rect('zinc');
  const wood: RGB = linearRGB(0x8a6444);
  const rail: RGB = linearRGB(0xd8cdb6);

  // floor slab
  p.box(-hw, -0.16, 0, hw, 0, d, timber, atlas, wood, FACE_PZ | FACE_PX | FACE_NX | FACE_PY | 8);
  // close-boarded balustrade with a capping rail
  p.box(-hw, 0, d - 0.08, hw, BALCON.woodRailH, d - 0.02, timber, atlas, rail, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX | FACE_PY);
  p.box(-hw, 0, 0.02, -hw + 0.06, BALCON.woodRailH, d, timber, atlas, rail, FACE_PX | FACE_NX | FACE_PY | FACE_PZ);
  p.box(hw - 0.06, 0, 0.02, hw, BALCON.woodRailH, d, timber, atlas, rail, FACE_PX | FACE_NX | FACE_PY | FACE_PZ);
  // posts at the ends and one in the middle
  const posts = w > 4.2 ? [-hw + 0.09, 0, hw - 0.09] : [-hw + 0.09, hw - 0.09];
  for (const x of posts) {
    p.box(x - 0.05, BALCON.woodRailH - 0.1, d - 0.14, x + 0.05, BALCON.woodRoofH, d - 0.04, timber, atlas, wood, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX);
  }
  // roof: 12° falling outward, 0.20 overhang
  const rise = Math.tan((BALCON.woodRoofPitchDeg * Math.PI) / 180) * (d + BALCON.woodRoofOver);
  const yIn = BALCON.woodRoofH + rise;
  const yOut = BALCON.woodRoofH;
  const zOut = d + BALCON.woodRoofOver;
  const u0 = atlas.u(zinc, 0);
  const u1 = atlas.u(zinc, 1);
  const v0 = atlas.v(zinc, 0);
  const v1 = atlas.v(zinc, 1);
  const ny = Math.cos((BALCON.woodRoofPitchDeg * Math.PI) / 180);
  const nz = Math.sin((BALCON.woodRoofPitchDeg * Math.PI) / 180);
  const zincCol: RGB = linearRGB(0xb9bcbe);
  const a = p.vert(-hw - 0.12, yIn, -0.02, 0, ny, nz, u0, v0, zincCol);
  const b = p.vert(hw + 0.12, yIn, -0.02, 0, ny, nz, u1, v0, zincCol);
  const c = p.vert(hw + 0.12, yOut, zOut, 0, ny, nz, u1, v1, zincCol);
  const e = p.vert(-hw - 0.12, yOut, zOut, 0, ny, nz, u0, v1, zincCol);
  p.quad(a, b, c, e);
  const a2 = p.vert(-hw - 0.12, yIn, -0.02, 0, -ny, -nz, u0, v0, shadeRGB(zincCol, 0.42));
  const b2 = p.vert(-hw - 0.12, yOut, zOut, 0, -ny, -nz, u0, v1, shadeRGB(zincCol, 0.42));
  const c2 = p.vert(hw + 0.12, yOut, zOut, 0, -ny, -nz, u1, v1, shadeRGB(zincCol, 0.42));
  const e2 = p.vert(hw + 0.12, yIn, -0.02, 0, -ny, -nz, u1, v0, shadeRGB(zincCol, 0.42));
  p.quad(a2, b2, c2, e2);
  // fascia
  p.box(-hw - 0.12, yOut - 0.08, zOut - 0.03, hw + 0.12, yOut, zOut, timber, atlas, wood, FACE_PZ | FACE_NY);
  return p.build();
}

/**
 * Terracotta pot. Deliberately one 5-sided tapered prism with a cap: there are
 * ~11 000 of these on the district's balconies and azoteas, so every triangle
 * here is multiplied by four figures — the flared rim is worth 3 triangles, not
 * a second barrel.
 */
function plantPot(atlas: FacadeAtlas): THREE.BufferGeometry {
  const p = new PartBuilder();
  const rect = atlas.rect('plinth');
  p.prism(0, 0, 0.105, 0.155, 0, 0.29, 5, rect, atlas, linearRGB(0xb5613a), true);
  return p.build();
}

/** crossed alpha cards — one plant, tinted per instance */
function leafCluster(scale: number, cards: number): THREE.BufferGeometry {
  const p = new PartBuilder();
  const c: RGB = { r: 1, g: 1, b: 1 };
  for (let i = 0; i < cards; i++) {
    const a = (i / cards) * Math.PI;
    const dx = Math.cos(a) * scale * 0.5;
    const dz = Math.sin(a) * scale * 0.5;
    const p0 = p.vert(-dx, 0, -dz, 0, 0.35, 0, 0, 0, c);
    const p1 = p.vert(dx, 0, dz, 0, 0.35, 0, 1, 0, c);
    const p2 = p.vert(dx, scale, dz, 0, 0.35, 0, 1, 1, c);
    const p3 = p.vert(-dx, scale, -dz, 0, 0.35, 0, 0, 1, c);
    p.quad(p0, p1, p2, p3);
  }
  return p.build();
}

/** trailing bougainvillea spilling over a rail, 0.4–1.2 m of growth */
function trailingVine(): THREE.BufferGeometry {
  const p = new PartBuilder();
  const c: RGB = { r: 1, g: 1, b: 1 };
  for (let i = 0; i < 2; i++) {
    const dx = i === 0 ? 0.42 : 0.12;
    const dz = i === 0 ? 0.06 : 0.3;
    const p0 = p.vert(-dx, -0.95, -dz, 0, 0, 1, 0, 0, c);
    const p1 = p.vert(dx, -0.95, dz, 0, 0, 1, 1, 0, c);
    const p2 = p.vert(dx, 0.28, dz, 0, 0, 1, 1, 1, c);
    const p3 = p.vert(-dx, 0.28, -dz, 0, 0, 1, 0, 1, c);
    p.quad(p0, p1, p2, p3);
  }
  return p.build();
}

/** laundry or a flag pegged to the rail */
function hangingCloth(atlas: FacadeAtlas, flag: boolean): THREE.BufferGeometry {
  const p = new PartBuilder();
  const rect = atlas.rect(flag ? 'mural0' : 'awning');
  const u0 = atlas.u(rect, 0);
  const u1 = atlas.u(rect, 1);
  const v0 = atlas.v(rect, 0);
  const v1 = atlas.v(rect, 1);
  const c: RGB = { r: 1, g: 1, b: 1 };
  const w = flag ? 0.82 : 0.42;
  const h = flag ? 0.52 : 0.62;
  p.cardXY(-w * 0.5, -h, w * 0.5, 0, 0.02, u0, v0, u1, v1, c, 1);
  p.cardXY(-w * 0.5, -h, w * 0.5, 0, -0.02, u0, v0, u1, v1, shadeRGB(c, 0.7), -1);
  return p.build();
}

/* ------------------------------------------------------------- factory */

const IRON_WIDTHS = [2.9, 5.8, 8.7, 11.6];
/** Balconette size ladder — matches typical window, door and shopfront spans. */
const BALCONETTE_WIDTHS = [1.2, 1.8, 2.6, 3.6, 5.0, 7.0];

export interface BalconyStats {
  balconies: number;
  balconettes: number;
  wooden: number;
  plants: number;
  laundry: number;
  plantedFraction: number;
}

/**
 * Collects every balcony a façade asks for, then emits the whole district's
 * worth as instanced meshes.
 */
export class BalconyFactory {
  private reg: InstanceRegistry;
  private atlas: FacadeAtlas;
  private m = new THREE.Matrix4();
  private stats: BalconyStats = {
    balconies: 0,
    balconettes: 0,
    wooden: 0,
    plants: 0,
    laundry: 0,
    plantedFraction: 0,
  };
  private planted = 0;

  constructor(reg: InstanceRegistry, atlas: FacadeAtlas) {
    this.reg = reg;
    this.atlas = atlas;
    for (let i = 0; i < IRON_WIDTHS.length; i++) {
      reg.define(`balcIron${i}`, ironBalcony(IRON_WIDTHS[i], i === 0), 'iron');
      reg.define(`balcWood${i}`, woodBalcony(IRON_WIDTHS[i], atlas), 'atlas');
    }
    // Balconettes guard openings that range from a narrow window to a wide
    // shopfront. A single 1.6m rail stretched to fit turns into a continuous
    // black band across the façade and smears the baluster pitch, so we author
    // a size ladder and only ever stretch a little — same rule as the balconies.
    for (let i = 0; i < BALCONETTE_WIDTHS.length; i++) {
      reg.define(`balconette${i}`, balconette(BALCONETTE_WIDTHS[i]), 'iron');
    }
    reg.define('pot', plantPot(atlas), 'atlas');
    reg.define('leafS', leafCluster(0.55, 2), 'foliage');
    reg.define('leafL', leafCluster(0.95, 3), 'foliage');
    reg.define('vine', trailingVine(), 'foliage');
    reg.define('laundry', hangingCloth(atlas, false), 'atlas');
    reg.define('flag', hangingCloth(atlas, true), 'atlas');
  }

  get results(): BalconyStats {
    const total = this.stats.balconies + this.stats.wooden;
    this.stats.plantedFraction = total > 0 ? this.planted / total : 0;
    return this.stats;
  }

  /** Emit everything one lot's façade asked for. */
  place(plan: BuildingPlan): void {
    const f = plan.frame;
    const yaw = frameYaw(f);
    for (const slot of plan.balconies) {
      const cx = (slot.x0 + slot.x1) * 0.5;
      const w = Math.max(0.7, slot.x1 - slot.x0);
      const wx = worldX(f, cx, 0);
      const wz = worldZ(f, cx, 0);
      const y = plan.floorY + slot.y;
      const rng = new RNG(slot.seed ^ 0x2b7);

      if (slot.kind === 'balconette') {
        let bi = 0;
        for (let i = 1; i < BALCONETTE_WIDTHS.length; i++) {
          if (Math.abs(BALCONETTE_WIDTHS[i] - w) < Math.abs(BALCONETTE_WIDTHS[bi] - w)) bi = i;
        }
        const bsx = clamp(w / BALCONETTE_WIDTHS[bi], 0.85, 1.18);
        instanceMatrix(this.m, wx, y, wz, yaw, bsx, 1, 1);
        this.reg.add(`balconette${bi}`, this.m, wx, wz);
        this.stats.balconettes++;
        // ground-floor guards get a pot on the sill about a third of the time
        if (rng.bool(0.3)) this.pot(f, cx, slot.y + 0.06, BALCON.balconetteDepth * 0.5, yaw, rng, 0.7);
        continue;
      }

      // closest nominal width, then a bounded stretch so the bar pitch stays
      // inside the documented 0.10–0.13 range
      let vi = 0;
      for (let i = 1; i < IRON_WIDTHS.length; i++) {
        if (Math.abs(IRON_WIDTHS[i] - w) < Math.abs(IRON_WIDTHS[vi] - w)) vi = i;
      }
      const sx = clamp(w / IRON_WIDTHS[vi], 0.8, 1.2);
      const wood = slot.kind === 'wood';
      instanceMatrix(this.m, wx, y, wz, yaw, sx, 1, 1);
      this.reg.add(wood ? `balcWood${vi}` : `balcIron${vi}`, this.m, wx, wz);
      if (wood) this.stats.wooden++;
      else this.stats.balconies++;

      const depth = wood ? BALCON.woodDepth : BALCON.ironDepth;
      // §1.4 — ≥ 60 % of balconies carry 2–5 pots
      if (rng.bool(0.68)) {
        this.planted++;
        const count = rng.int(2, slot.bays > 2 ? 5 : 4);
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0.5 : i / (count - 1);
          const px = lerp(slot.x0 + 0.3, slot.x1 - 0.3, t) + rng.range(-0.12, 0.12);
          this.pot(f, px, slot.y + 0.02, rng.range(0.22, depth - 0.28), yaw, rng, 1);
        }
        // trailing growth over the rail — the bougainvillea silhouette
        if (rng.bool(0.45)) {
          const px = lerp(slot.x0 + 0.4, slot.x1 - 0.4, rng.next());
          const vx = worldX(f, px, depth - 0.02);
          const vz = worldZ(f, px, depth - 0.02);
          instanceMatrix(this.m, vx, plan.floorY + slot.y + (wood ? BALCON.woodRailH : BALCON.railH), vz, yaw, rng.range(0.8, 1.5), rng.range(0.7, 1.4), 1);
          this.reg.add('vine', this.m, vx, vz);
          this.stats.plants++;
        }
      }
      // §1.4 — ≤ 15 % carry laundry, 1 in 3 of those a Puerto Rican flag
      if (rng.bool(0.14)) {
        const px = lerp(slot.x0 + 0.5, slot.x1 - 0.5, rng.next());
        const lz = depth - 0.05;
        const lx = worldX(f, px, lz);
        const lw = worldZ(f, px, lz);
        instanceMatrix(this.m, lx, plan.floorY + slot.y + (wood ? BALCON.woodRailH : BALCON.railH), lw, yaw, 1, 1, 1);
        this.reg.add(rng.bool(1 / 3) ? 'flag' : 'laundry', this.m, lx, lw);
        this.stats.laundry++;
      }
    }
  }

  /** a pot plus its plant, anywhere on the façade frame */
  pot(f: Frame, x: number, y: number, z: number, yaw: number, rng: RNG, scale: number): void {
    const wx = worldX(f, x, z);
    const wz = worldZ(f, x, z);
    const yy = f.y0 + y;
    instanceMatrix(this.m, wx, yy, wz, yaw + rng.range(0, 3), scale, scale, scale);
    this.reg.add('pot', this.m, wx, wz);
    const big = rng.bool(0.35);
    instanceMatrix(this.m, wx, yy + 0.26 * scale, wz, yaw + rng.range(0, 3), scale * rng.range(0.85, 1.25), scale * rng.range(0.85, 1.3), scale);
    this.reg.add(big ? 'leafL' : 'leafS', this.m, wx, wz);
    this.stats.plants++;
  }

  /** Public helper so `Roofs.ts` can plant an azotea from the same instances. */
  potWorld(x: number, y: number, z: number, yaw: number, rng: RNG, scale = 1): void {
    instanceMatrix(this.m, x, y, z, yaw + rng.range(0, 3), scale, scale, scale);
    this.reg.add('pot', this.m, x, z);
    instanceMatrix(this.m, x, y + 0.26 * scale, z, yaw + rng.range(0, 3), scale * rng.range(0.85, 1.25), scale * rng.range(0.9, 1.35), scale);
    this.reg.add(rng.bool(0.4) ? 'leafL' : 'leafS', this.m, x, z);
    this.stats.plants++;
  }
}
