/**
 * Loco Lift — roofs.
 *
 * Until this module existed every townhouse was an open box: a cornice, a
 * parapet and nothing between them. That is invisible from a windscreen and
 * ruinous from anywhere else — a balcony, the fort ramparts, a jump — and
 * §8.9 names it directly ("roof planes are empty").
 *
 * `docs/ART_REFERENCE.md` §1.6 sets the shape of the fix:
 *
 *   - **70 % azoteas.** Flat cement screed falling 1.5 % to a scupper that
 *     spits through the parapet, one per 8 m of frontage.
 *   - **30 % tiled.** Barrel tile at 22°, 0.45 m eaves, exposed rafter tails.
 *   - **Clutter is mandatory**: a 1.1 Ø x 1.4 cistern, an aerial, 2–5 potted
 *     plants, a clothesline, a stair bulkhead. An azotea in Old San Juan is a
 *     working room, not a lid.
 *
 * Everything repeated (tanks, aerials, pots) goes through the shared
 * {@link InstanceRegistry}, so the whole district's roofscape costs a handful
 * of draw calls on top of the block shells it merges into.
 */
import * as THREE from 'three';
import { lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import {
  CASA,
  FACE_ALL,
  FACE_NX,
  FACE_NZ,
  FACE_PX,
  FACE_PY,
  FACE_PZ,
  GeomBuilder,
  InstanceRegistry,
  PartBuilder,
  box,
  deck,
  frameYaw,
  instanceMatrix,
  linearRGB,
  makeFrame,
  panel,
  shadeRGB,
  sidePanel,
  worldQuad,
  worldX,
  worldZ,
} from './BuildingKit';
import type { Frame, RGB } from './BuildingKit';
import type { FacadeAtlas } from './FacadeTextures';
import type { BuildingPlan } from './Facades';
import { roofColour } from './Facades';
import type { BalconyFactory } from './Balconies';

export interface RoofStats {
  azoteas: number;
  tiled: number;
  tanks: number;
  aerials: number;
  bulkheads: number;
  scuppers: number;
  clotheslines: number;
}

/** §1.6 — cistern 1.1 Ø x 1.4 h, the most recognisable thing on a PR roof. */
function waterTank(atlas: FacadeAtlas): THREE.BufferGeometry {
  const p = new PartBuilder();
  const rect = atlas.rect('zinc');
  const body: RGB = linearRGB(0xc8ccce);
  p.prism(0, 0, 0.55, 0.55, 0.16, 1.42, 8, rect, atlas, body, true);
  // the block stand it sits on, and a lid rim
  p.box(-0.5, 0, -0.5, 0.5, 0.16, 0.5, atlas.rect('azotea'), atlas, linearRGB(0x9a958a), FACE_PZ | FACE_NZ | FACE_PX | FACE_NX | FACE_PY);
  p.prism(0, 0, 0.58, 0.5, 1.42, 1.52, 6, rect, atlas, shadeRGB(body, 0.92), true);
  return p.build();
}

/** A TV aerial: a mast and four cross elements. Pure silhouette, 24 tris. */
function aerial(atlas: FacadeAtlas): THREE.BufferGeometry {
  const p = new PartBuilder();
  const rect = atlas.rect('zinc');
  const iron: RGB = linearRGB(0x2b2f31);
  p.box(-0.025, 0, -0.025, 0.025, 1.85, 0.025, rect, atlas, iron, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX);
  for (let i = 0; i < 4; i++) {
    const y = 1.05 + i * 0.22;
    const w = 0.42 - i * 0.06;
    p.box(-w, y, -0.018, w, y + 0.02, 0.018, rect, atlas, iron, FACE_PY | FACE_PZ | FACE_NZ);
  }
  return p.build();
}

/** A slack clothesline between two posts — §8.57 wants wires and laundry. */
function clothesline(atlas: FacadeAtlas): THREE.BufferGeometry {
  const p = new PartBuilder();
  const rect = atlas.rect('timber');
  const post: RGB = linearRGB(0x8d8578);
  p.box(-1.6, 0, -0.04, -1.52, 1.5, 0.04, rect, atlas, post, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX);
  p.box(1.52, 0, -0.04, 1.6, 1.5, 0.04, rect, atlas, post, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX);
  // the line itself, drooping in three segments
  const line: RGB = linearRGB(0xd8d2c4);
  const ys = [1.46, 1.36, 1.36, 1.46];
  for (let i = 0; i < 3; i++) {
    const x0 = lerp(-1.56, 1.56, i / 3);
    const x1 = lerp(-1.56, 1.56, (i + 1) / 3);
    p.box(x0, ys[i] - 0.02, -0.015, x1, ys[i + 1], 0.015, rect, atlas, line, FACE_PZ | FACE_NZ | FACE_PY);
  }
  return p.build();
}

/**
 * The roof factory. Emits deck geometry into the block's merged builder and
 * registers the clutter as instances.
 */
export class Roofs {
  private reg: InstanceRegistry;
  private atlas: FacadeAtlas;
  private balconies: BalconyFactory;
  private m = new THREE.Matrix4();
  private _stats: RoofStats = {
    azoteas: 0, tiled: 0, tanks: 0, aerials: 0, bulkheads: 0, scuppers: 0, clotheslines: 0,
  };

  constructor(reg: InstanceRegistry, atlas: FacadeAtlas, balconies: BalconyFactory) {
    this.reg = reg;
    this.atlas = atlas;
    this.balconies = balconies;
    reg.define('roofTank', waterTank(atlas), 'atlas');
    reg.define('roofAerial', aerial(atlas), 'atlas');
    reg.define('roofLine', clothesline(atlas), 'atlas');
  }

  get stats(): RoofStats {
    return this._stats;
  }

  /** Cap one building and dress the result. */
  place(plan: BuildingPlan, b: GeomBuilder): void {
    if (plan.roof === 'tiled') this.tiled(plan, b);
    else this.azotea(plan, b);
  }

  /**
   * Flat roof: a screed deck at the cornice line, falling 1.5 % front-to-back,
   * with scupper spouts through the parapet and the working clutter on top.
   */
  private azotea(plan: BuildingPlan, b: GeomBuilder): void {
    const f = plan.frame;
    const atlas = this.atlas;
    const W = f.len;
    const D = Math.min(plan.depth, 19);
    const rng = new RNG(plan.seed ^ 0x20fa);
    const deckY = plan.topY + CASA.corniceH - 0.06;
    const screed = roofColour(plan);
    const zBack = -D;
    const zFront = CASA.cornicePr * 0.55 - CASA.parapetT;

    // the deck. 1.5 % fall is modelled by dropping the back edge 0.015 * D.
    const fall = D * 0.015;
    const rect = atlas.rect('azotea');
    const u0 = atlas.u(rect, 0);
    const u1 = atlas.u(rect, 1);
    const v0 = atlas.v(rect, 0);
    const v1 = atlas.v(rect, 1);
    const yAt = (z: number): number => deckY - fall * ((zFront - z) / Math.max(0.01, zFront - zBack));
    const slab = (xa: number, za: number, xb: number, zb: number): void => {
      if (xb - xa < 0.05 || za - zb < 0.05) return;
      const nu = Math.max(1, Math.round((xb - xa) / 5.2));
      const nv = Math.max(1, Math.round((za - zb) / 5.2));
      for (let j = 0; j < nv; j++) {
        const z0 = lerp(za, zb, j / nv);
        const z1 = lerp(za, zb, (j + 1) / nv);
        for (let i = 0; i < nu; i++) {
          const x0 = lerp(xa, xb, i / nu);
          const x1 = lerp(xa, xb, (i + 1) / nu);
          const p0 = b.vertex(worldX(f, x0, z0), f.y0 + yAt(z0), worldZ(f, x0, z0), 0, 1, 0, u0, v0, screed);
          const p1 = b.vertex(worldX(f, x1, z0), f.y0 + yAt(z0), worldZ(f, x1, z0), 0, 1, 0, u1, v0, screed);
          const p2 = b.vertex(worldX(f, x1, z1), f.y0 + yAt(z1), worldZ(f, x1, z1), 0, 1, 0, u1, v1, screed);
          const p3 = b.vertex(worldX(f, x0, z1), f.y0 + yAt(z1), worldZ(f, x0, z1), 0, 1, 0, u0, v1, screed);
          b.quad(p0, p3, p2, p1);
        }
      }
    };

    /* §1.7 — the courtyard is open to the sky. Paving over the light well
       would delete the one thing that makes a block read as inhabited rather
       than extruded, so the deck is laid as four bands around it. */
    const w = plan.lightWell;
    if (w && w.z0 < zFront && w.z1 > zBack) {
      slab(0, zFront, W, w.z0);
      slab(0, w.z0, w.x0, w.z1);
      slab(w.x1, w.z0, W, w.z1);
      slab(0, w.z1, W, zBack);
    } else {
      slab(0, zFront, W, zBack);
    }
    this._stats.azoteas++;

    // §1.6 — scupper spouts through the parapet, one per 8 m
    const spouts = Math.max(1, Math.round(W / 8));
    for (let i = 0; i < spouts; i++) {
      const x = ((i + 0.5) * W) / spouts;
      box(
        b, f, atlas, atlas.rect('zinc'),
        x - 0.09, deckY + 0.04, zFront, x + 0.09, deckY + 0.2, zFront + 0.42,
        linearRGB(0x8e8b82), FACE_ALL, 0,
      );
      this._stats.scuppers++;
    }

    /* --- clutter. The stair bulkhead first: it is the silhouette event. --- */
    const yaw = frameYaw(f);
    if (W > 5 && rng.bool(0.55)) {
      const bx = rng.range(1.2, Math.max(1.3, W - 3.4));
      const bz = -rng.range(3.5, Math.max(4, D - 3));
      const bw = rng.range(2.1, 2.9);
      const bd = rng.range(1.9, 2.6);
      const bh = rng.range(2.1, 2.7);
      const col = shadeRGB(plan.livery.wall, 0.95);
      box(
        b, f, atlas, plan.stucco,
        bx, deckY, bz - bd, bx + bw, deckY + bh, bz,
        col, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX, CASA.stuccoTile,
      );
      // a lid with a small overhang, in the trim colour
      box(
        b, f, atlas, plan.stucco,
        bx - 0.09, deckY + bh, bz - bd - 0.09, bx + bw + 0.09, deckY + bh + 0.12, bz + 0.09,
        plan.livery.trim, FACE_PZ | FACE_NZ | FACE_PX | FACE_NX | FACE_PY, CASA.stuccoTile,
      );
      this._stats.bulkheads++;
    }

    if (rng.bool(0.72)) {
      const x = rng.range(0.9, Math.max(1, W - 0.9));
      const z = -rng.range(2.2, Math.max(2.4, D - 2));
      this.put('roofTank', f, x, deckY, z, yaw + rng.range(-0.5, 0.5));
      this._stats.tanks++;
    }
    if (rng.bool(0.5)) {
      const x = rng.range(0.6, Math.max(0.8, W - 0.6));
      const z = -rng.range(1.6, Math.max(1.8, D - 1.5));
      this.put('roofAerial', f, x, deckY, z, yaw + rng.range(0, 3));
      this._stats.aerials++;
    }
    if (W > 4.5 && rng.bool(0.42)) {
      const x = rng.range(2, Math.max(2.2, W - 2));
      const z = -rng.range(2.5, Math.max(2.7, D - 2.5));
      this.put('roofLine', f, x, deckY, z, yaw + rng.range(-0.4, 0.4));
      this._stats.clotheslines++;
    }
    // §1.6 — 2–5 potted plants, sharing the balcony planter instances
    const pots = rng.int(0, 2);
    for (let i = 0; i < pots; i++) {
      const x = rng.range(0.5, Math.max(0.7, W - 0.5));
      const z = -rng.range(0.9, Math.max(1.1, D - 1));
      this.balconies.potWorld(worldX(f, x, z), f.y0 + deckY, worldZ(f, x, z), yaw, rng, rng.range(0.8, 1.2));
    }
  }

  /**
   * Barrel-tiled roof: 22° pitch, 0.45 m eaves, ridge along the frontage.
   * Used on corners, churches and the hillside, where a pitched roof against
   * the sky is the cheapest silhouette event a block can buy (§6.2 R6).
   */
  private tiled(plan: BuildingPlan, b: GeomBuilder): void {
    const f = plan.frame;
    const atlas = this.atlas;
    const W = f.len;
    const D = Math.min(plan.depth, 15);
    const eaveY = plan.topY + CASA.corniceH;
    const over = 0.45;
    const halfD = D * 0.5;
    const rise = Math.tan((22 * Math.PI) / 180) * halfD;
    const ridgeY = eaveY + rise;
    const tile = atlas.rect('roofTile');
    const col = roofColour(plan);

    const zEave = over;
    const zBack = -D - over * 0.4;
    const zRidge = -halfD;
    const p = (x: number, y: number, z: number): THREE.Vector3 =>
      new THREE.Vector3(worldX(f, x, z), f.y0 + y, worldZ(f, x, z));

    // two slopes, split along the frontage so the tile courses stay square
    const nu = Math.max(1, Math.round(W / 4.4));
    for (let i = 0; i < nu; i++) {
      const xa = (W * i) / nu;
      const xb = (W * (i + 1)) / nu;
      worldQuad(b, atlas, tile, p(xa, eaveY, zEave), p(xb, eaveY, zEave), p(xb, ridgeY, zRidge), p(xa, ridgeY, zRidge), col);
      worldQuad(b, atlas, tile, p(xb, eaveY, zBack), p(xa, eaveY, zBack), p(xa, ridgeY, zRidge), p(xb, ridgeY, zRidge), shadeRGB(col, 0.86));
    }
    // ridge tile and the gable ends
    box(b, f, atlas, tile, -0.06, ridgeY - 0.07, zRidge - 0.09, W + 0.06, ridgeY + 0.07, zRidge + 0.09, shadeRGB(col, 1.06), FACE_ALL, 1.2);
    for (const [x, face] of [[0, -1], [W, 1]] as Array<[number, number]>) {
      const g = new PartBuilder();
      void g;
      sidePanel(b, f, atlas, plan.stucco, zBack, eaveY - 0.4, zEave, eaveY, x, shadeRGB(plan.livery.wall, 0.9), face, 1, 1, CASA.stuccoTile);
    }
    // exposed rafter tails under the front eaves
    const tails = Math.max(2, Math.round(W / 1.1));
    for (let i = 0; i < tails; i++) {
      const x = ((i + 0.5) * W) / tails;
      box(
        b, f, atlas, atlas.rect('timber'),
        x - 0.04, eaveY - 0.14, zEave - 0.34, x + 0.04, eaveY - 0.06, zEave - 0.02,
        linearRGB(0x7a5a3e), FACE_PX | FACE_NX, 0,
      );
    }
    this._stats.tiled++;

    // one tank tucked behind the ridge on half of them
    const rng = new RNG(plan.seed ^ 0x71c3);
    if (rng.bool(0.4) && D > 8) {
      const x = rng.range(1, Math.max(1.2, W - 1));
      const z = -D + 1.4;
      this.put('roofTank', f, x, eaveY - 0.2, z, frameYaw(f) + rng.range(-0.4, 0.4));
      this._stats.tanks++;
    }
  }

  /** register one instance in façade-frame coordinates */
  private put(key: string, f: Frame, x: number, y: number, z: number, yaw: number): void {
    const wx = worldX(f, x, z);
    const wz = worldZ(f, x, z);
    instanceMatrix(this.m, wx, f.y0 + y, wz, yaw, 1, 1, 1);
    this.reg.add(key, this.m, wx, wz);
  }
}

/* re-exported so `Buildings.ts` need not import the kit for the roof pass */
export { makeFrame, panel, deck };
