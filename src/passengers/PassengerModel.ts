/**
 * Loco Lift — procedural passenger figures.
 *
 * No external models, no textures: every passenger is built from Three.js
 * primitives, merged down to three meshes (body, left arm, right arm) plus an
 * optional prop, all sharing **one** vertex-coloured material. That keeps a
 * street full of people at ~4 draw calls each and one program for the lot.
 *
 * What the design has to deliver:
 *  - a readable silhouette per archetype (the drum, the cake box, the board,
 *    the apron, the roller case) — you should know who is hailing from 60 m;
 *  - a **continuous** skin-tone range (ART_REFERENCE §7.2) — eight variants per
 *    archetype sample the whole ramp, and tone is never tied to the role;
 *  - varied hair texture: afros, coils, locs, braids, buns, bobs, crops;
 *  - cheap animation — idle breathing, a big readable wave, bracing on impacts,
 *    arms up on jumps — driven by two arm pivots, no skinning, no morph targets.
 *
 * Geometry is cached per (archetype, variant, pose); figures are pooled, so a
 * long shift builds each variant once and then recycles forever.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01, damp } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import {
  GREY_HAIR_COLORS,
  HAIR_COLORS,
  skinToneAt,
  VARIANTS_PER_ARCHETYPE,
  visualFor,
  type ArchetypeVisual,
  type CarriedProp,
  type HairStyle,
  type HeadWear,
} from './Archetypes';

/* ------------------------------------------------------------------ types */

export type FigureAnim = 'idle' | 'hail' | 'ride' | 'brace' | 'cheer' | 'annoyed';
export type FigurePose = 'stand' | 'seat';

interface VariantSpec {
  skin: number;
  hair: HairStyle;
  hairColor: number;
  head: HeadWear;
  shirt: number;
  accent: number;
  legColor: number;
  height: number;
  build: number;
  energy: number;
  /** phase offset so a crowd never breathes in unison */
  phase: number;
}

interface Rig {
  seated: boolean;
  shoeY: number;
  hipY: number;
  torsoY: number;
  torsoH: number;
  shoulderY: number;
  neckY: number;
  headY: number;
  armX: number;
  /** where a carried prop sits, local */
  propX: number;
  propY: number;
  propZ: number;
}

interface FigureGeo {
  body: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  prop: THREE.BufferGeometry | null;
  rig: Rig;
}

/* ------------------------------------------------------- geometry helpers */

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Stamp a flat vertex colour onto a geometry so everything can share a material. */
function tint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _c.setHex(hex);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = _c.r;
    arr[i * 3 + 1] = _c.g;
    arr[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geo;
}

function place(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.makeRotationFromQuaternion(_q);
    _m.setPosition(x, y, z);
  } else {
    _m.makeTranslation(x, y, z);
  }
  geo.applyMatrix4(_m);
  return geo;
}

/** A merge bucket. Collects tinted, positioned primitives and fuses them once. */
class Parts {
  private readonly list: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, hex: number): void {
    this.list.push(tint(geo, hex));
  }

  get length(): number {
    return this.list.length;
  }

  build(): THREE.BufferGeometry | null {
    if (this.list.length === 0) return null;
    if (this.list.length === 1) return this.list[0];
    const merged = mergeGeometries(this.list, false);
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    if (!merged) return null;
    merged.computeBoundingSphere();
    return merged;
  }
}

/* ------------------------------------------------------------------ rigs */

function standRig(h: number, build: number): Rig {
  return {
    seated: false,
    shoeY: 0.03 * h,
    hipY: 0.9 * h,
    torsoY: 1.16 * h,
    torsoH: 0.44 * h,
    shoulderY: 1.34 * h,
    neckY: 1.43 * h,
    headY: 1.55 * h,
    armX: 0.205 * h * build,
    propX: 0,
    propY: 0.98 * h,
    propZ: -0.3 * h,
  };
}

function seatRig(h: number, build: number): Rig {
  return {
    seated: true,
    shoeY: -0.42 * h,
    hipY: 0.06 * h,
    torsoY: 0.34 * h,
    torsoH: 0.42 * h,
    shoulderY: 0.52 * h,
    neckY: 0.61 * h,
    headY: 0.73 * h,
    armX: 0.205 * h * build,
    propX: 0,
    propY: 0.14 * h,
    propZ: -0.24 * h,
  };
}

/* ----------------------------------------------------------- body pieces */

interface Detail {
  sphereW: number;
  sphereH: number;
  cylSeg: number;
}

const DETAIL: Readonly<Record<QualityTier, Detail>> = {
  low: { sphereW: 8, sphereH: 5, cylSeg: 6 },
  medium: { sphereW: 10, sphereH: 6, cylSeg: 8 },
  high: { sphereW: 12, sphereH: 8, cylSeg: 10 },
  ultra: { sphereW: 14, sphereH: 9, cylSeg: 12 },
};

function buildLegs(p: Parts, v: ArchetypeVisual, s: VariantSpec, rig: Rig, d: Detail): void {
  const h = s.height / 1.72;
  const shoe = 0x2b2b33;
  const skirt = v.legwear === 'skirt';
  const bare = v.legwear === 'shorts' || v.legwear === 'boardshorts';

  for (let i = 0; i < 2; i++) {
    const x = (i === 0 ? -1 : 1) * 0.098 * h;

    if (rig.seated) {
      /* thigh forward, shin down — a proper seated silhouette */
      const thigh = new THREE.CylinderGeometry(0.072 * h, 0.068 * h, 0.42 * h, d.cylSeg, 1);
      place(thigh, x, rig.hipY + 0.01 * h, -0.19 * h, Math.PI / 2, 0, 0);
      p.add(thigh, bare || skirt ? s.skin : s.legColor);

      const knee = new THREE.SphereGeometry(0.068 * h, d.sphereW, d.sphereH);
      place(knee, x, rig.hipY, -0.4 * h);
      p.add(knee, bare || skirt ? s.skin : s.legColor);

      const shin = new THREE.CylinderGeometry(0.06 * h, 0.05 * h, 0.44 * h, d.cylSeg, 1);
      place(shin, x, rig.hipY - 0.22 * h, -0.42 * h);
      p.add(shin, bare || skirt ? s.skin : s.legColor);

      const foot = new THREE.BoxGeometry(0.1 * h, 0.06 * h, 0.24 * h);
      place(foot, x, rig.shoeY, -0.5 * h);
      p.add(foot, shoe);
      continue;
    }

    const foot = new THREE.BoxGeometry(0.1 * h, 0.06 * h, 0.25 * h);
    place(foot, x, rig.shoeY, -0.03 * h);
    p.add(foot, shoe);

    const shin = new THREE.CylinderGeometry(0.055 * h, 0.048 * h, 0.42 * h, d.cylSeg, 1);
    place(shin, x, 0.27 * h, 0);
    p.add(shin, bare || skirt ? s.skin : s.legColor);

    const knee = new THREE.SphereGeometry(0.058 * h, d.sphereW, d.sphereH);
    place(knee, x, 0.49 * h, 0);
    p.add(knee, bare || skirt ? s.skin : s.legColor);

    const thigh = new THREE.CylinderGeometry(0.072 * h, 0.06 * h, 0.4 * h, d.cylSeg, 1);
    place(thigh, x, 0.69 * h, 0);
    p.add(thigh, skirt ? s.skin : s.legColor);
  }

  if (skirt) {
    const sk = new THREE.CylinderGeometry(0.16 * h, 0.3 * h, 0.36 * h, d.cylSeg + 2, 1, false);
    place(sk, 0, (rig.seated ? rig.hipY + 0.02 * h : 0.78 * h), rig.seated ? -0.08 * h : 0);
    p.add(sk, s.legColor);
  } else if (bare) {
    const shorts = new THREE.BoxGeometry(0.33 * h * s.build, 0.28 * h, 0.24 * h);
    place(shorts, 0, rig.seated ? rig.hipY + 0.03 * h : 0.8 * h, rig.seated ? -0.04 * h : 0);
    p.add(shorts, s.legColor);
  }

  const hips = new THREE.BoxGeometry(0.3 * h * s.build, 0.17 * h, 0.21 * h);
  place(hips, 0, rig.hipY, 0);
  p.add(hips, s.legColor);
}

function buildTorso(p: Parts, v: ArchetypeVisual, s: VariantSpec, rig: Rig, d: Detail): void {
  const h = s.height / 1.72;
  const w = 0.36 * h * s.build;

  const chest = new THREE.BoxGeometry(w, rig.torsoH, 0.23 * h * s.build);
  place(chest, 0, rig.torsoY, 0);
  p.add(chest, s.shirt);

  const shoulders = new THREE.BoxGeometry(w * 1.14, 0.11 * h, 0.23 * h * s.build);
  place(shoulders, 0, rig.shoulderY, 0);
  p.add(shoulders, s.shirt);

  /* a placket / collar strip so the front reads at a glance */
  const collar = new THREE.BoxGeometry(w * 0.28, 0.1 * h, 0.03 * h);
  place(collar, 0, rig.shoulderY - 0.03 * h, -0.12 * h * s.build);
  p.add(collar, s.accent);

  if (v.apron) {
    const apron = new THREE.BoxGeometry(w * 0.82, rig.torsoH * 1.15, 0.03 * h);
    place(apron, 0, rig.torsoY - 0.05 * h, -0.13 * h * s.build);
    p.add(apron, s.accent);
    const strap = new THREE.BoxGeometry(w * 0.16, 0.16 * h, 0.02 * h);
    place(strap, -w * 0.22, rig.shoulderY - 0.04 * h, -0.13 * h * s.build);
    p.add(strap, s.accent);
    const strap2 = new THREE.BoxGeometry(w * 0.16, 0.16 * h, 0.02 * h);
    place(strap2, w * 0.22, rig.shoulderY - 0.04 * h, -0.13 * h * s.build);
    p.add(strap2, s.accent);
  }

  const neck = new THREE.CylinderGeometry(0.048 * h, 0.052 * h, 0.09 * h, d.cylSeg, 1);
  place(neck, 0, rig.neckY, 0);
  p.add(neck, s.skin);
}

function buildHead(p: Parts, s: VariantSpec, rig: Rig, d: Detail): void {
  const h = s.height / 1.72;
  const y = rig.headY;

  const skull = new THREE.SphereGeometry(0.105 * h, d.sphereW, d.sphereH);
  skull.scale(1, 1.1, 0.98);
  place(skull, 0, y, 0);
  p.add(skull, s.skin);

  /* a nose so the facing direction is legible from behind the Jeep */
  const nose = new THREE.SphereGeometry(0.024 * h, 6, 4);
  place(nose, 0, y - 0.005 * h, -0.1 * h);
  p.add(nose, s.skin);

  const ear = 0.03 * h;
  for (let i = 0; i < 2; i++) {
    const e = new THREE.SphereGeometry(ear, 6, 4);
    e.scale(0.5, 1, 0.8);
    place(e, (i === 0 ? -1 : 1) * 0.103 * h, y + 0.005 * h, 0.005 * h);
    p.add(e, s.skin);
  }
}

function buildHair(p: Parts, s: VariantSpec, rig: Rig, d: Detail): void {
  const h = s.height / 1.72;
  const y = rig.headY;
  const col = s.hairColor;

  const cap = (r: number, sy: number, dy: number): void => {
    const g = new THREE.SphereGeometry(r * h, d.sphereW, d.sphereH);
    g.scale(1, sy, 1.02);
    place(g, 0, y + dy * h, 0.004 * h);
    p.add(g, col);
  };

  switch (s.hair) {
    case 'bald':
      break;
    case 'crop':
      cap(0.113, 0.82, 0.018);
      break;
    case 'wavy': {
      cap(0.122, 0.92, 0.016);
      for (let i = 0; i < 3; i++) {
        const lock = new THREE.SphereGeometry(0.045 * h, 6, 5);
        lock.scale(1, 0.8, 1.1);
        place(lock, (i - 1) * 0.06 * h, y + 0.03 * h, 0.1 * h);
        p.add(lock, col);
      }
      break;
    }
    case 'afro': {
      const g = new THREE.SphereGeometry(0.172 * h, d.sphereW + 2, d.sphereH + 1);
      g.scale(1, 0.94, 1);
      place(g, 0, y + 0.042 * h, 0.008 * h);
      p.add(g, col);
      break;
    }
    case 'coils': {
      cap(0.126, 0.9, 0.024);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const b = new THREE.SphereGeometry(0.045 * h, 6, 5);
        place(b, Math.cos(a) * 0.085 * h, y + 0.085 * h, Math.sin(a) * 0.085 * h);
        p.add(b, col);
      }
      break;
    }
    case 'locs': {
      cap(0.116, 0.85, 0.02);
      for (let i = 0; i < 8; i++) {
        const a = -0.9 + (i / 7) * 1.8;
        const g = new THREE.CylinderGeometry(0.018 * h, 0.016 * h, 0.3 * h, 5, 1);
        place(g, Math.sin(a) * 0.088 * h, y - 0.1 * h, 0.055 * h + Math.cos(a) * 0.045 * h);
        p.add(g, col);
      }
      break;
    }
    case 'braids': {
      cap(0.114, 0.84, 0.02);
      for (let i = 0; i < 5; i++) {
        const x = (i - 2) * 0.042 * h;
        const g = new THREE.CylinderGeometry(0.024 * h, 0.02 * h, 0.34 * h, 5, 1);
        place(g, x, y - 0.13 * h, 0.075 * h);
        p.add(g, col);
        const bead = new THREE.SphereGeometry(0.024 * h, 6, 4);
        place(bead, x, y - 0.3 * h, 0.075 * h);
        p.add(bead, s.accent);
      }
      break;
    }
    case 'bun': {
      cap(0.115, 0.86, 0.018);
      const bun = new THREE.SphereGeometry(0.072 * h, d.sphereW, d.sphereH);
      place(bun, 0, y + 0.055 * h, 0.115 * h);
      p.add(bun, col);
      break;
    }
    case 'ponytail': {
      cap(0.115, 0.86, 0.018);
      const tail = new THREE.CylinderGeometry(0.038 * h, 0.024 * h, 0.28 * h, 6, 1);
      place(tail, 0, y - 0.09 * h, 0.13 * h, -0.35, 0, 0);
      p.add(tail, col);
      break;
    }
    case 'bob':
    default: {
      cap(0.126, 0.94, 0.012);
      const back = new THREE.BoxGeometry(0.24 * h, 0.18 * h, 0.24 * h);
      place(back, 0, y - 0.095 * h, 0.03 * h);
      p.add(back, col);
      break;
    }
  }
}

function buildHeadwear(p: Parts, s: VariantSpec, rig: Rig, d: Detail): void {
  const h = s.height / 1.72;
  const y = rig.headY;
  const col = s.accent;

  switch (s.head) {
    case 'none':
      break;
    case 'cap': {
      const crown = new THREE.SphereGeometry(0.118 * h, d.sphereW, d.sphereH, 0, Math.PI * 2, 0, Math.PI * 0.55);
      place(crown, 0, y + 0.03 * h, 0.006 * h);
      p.add(crown, col);
      const brim = new THREE.BoxGeometry(0.19 * h, 0.018 * h, 0.14 * h);
      place(brim, 0, y + 0.04 * h, -0.16 * h);
      p.add(brim, col);
      break;
    }
    case 'sunHat': {
      const crown = new THREE.CylinderGeometry(0.108 * h, 0.118 * h, 0.11 * h, d.cylSeg, 1);
      place(crown, 0, y + 0.1 * h, 0.005 * h);
      p.add(crown, col);
      const brim = new THREE.CylinderGeometry(0.27 * h, 0.27 * h, 0.014 * h, d.cylSeg + 4, 1);
      place(brim, 0, y + 0.05 * h, 0.005 * h);
      p.add(brim, col);
      break;
    }
    case 'bucket': {
      const crown = new THREE.CylinderGeometry(0.122 * h, 0.132 * h, 0.13 * h, d.cylSeg, 1);
      place(crown, 0, y + 0.09 * h, 0.005 * h);
      p.add(crown, col);
      const brim = new THREE.CylinderGeometry(0.205 * h, 0.185 * h, 0.026 * h, d.cylSeg + 2, 1);
      place(brim, 0, y + 0.028 * h, 0.005 * h);
      p.add(brim, col);
      break;
    }
    case 'bandana': {
      const band = new THREE.CylinderGeometry(0.12 * h, 0.122 * h, 0.062 * h, d.cylSeg, 1);
      place(band, 0, y + 0.062 * h, 0.005 * h);
      p.add(band, col);
      const knot = new THREE.SphereGeometry(0.032 * h, 6, 5);
      place(knot, 0, y + 0.052 * h, 0.115 * h);
      p.add(knot, col);
      break;
    }
    case 'visor': {
      const band = new THREE.CylinderGeometry(0.12 * h, 0.122 * h, 0.045 * h, d.cylSeg, 1);
      place(band, 0, y + 0.058 * h, 0.005 * h);
      p.add(band, col);
      const brim = new THREE.BoxGeometry(0.21 * h, 0.016 * h, 0.13 * h);
      place(brim, 0, y + 0.05 * h, -0.155 * h);
      p.add(brim, col);
      break;
    }
    case 'headwrap':
    default: {
      const wrap = new THREE.CylinderGeometry(0.126 * h, 0.13 * h, 0.14 * h, d.cylSeg, 1);
      place(wrap, 0, y + 0.09 * h, 0.005 * h);
      p.add(wrap, col);
      const fold = new THREE.SphereGeometry(0.05 * h, 6, 5);
      place(fold, -0.06 * h, y + 0.155 * h, 0.02 * h);
      p.add(fold, col);
      break;
    }
  }
}

/** Arm geometry lives in shoulder-local space, hanging straight down. */
function buildArm(s: VariantSpec, d: Detail): THREE.BufferGeometry | null {
  const h = s.height / 1.72;
  const p = new Parts();

  const sleeve = new THREE.CylinderGeometry(0.058 * h, 0.052 * h, 0.13 * h, d.cylSeg, 1);
  place(sleeve, 0, -0.055 * h, 0);
  p.add(sleeve, s.shirt);

  const upper = new THREE.CylinderGeometry(0.045 * h, 0.04 * h, 0.24 * h, d.cylSeg, 1);
  place(upper, 0, -0.2 * h, 0);
  p.add(upper, s.skin);

  const elbow = new THREE.SphereGeometry(0.042 * h, 6, 5);
  place(elbow, 0, -0.32 * h, 0);
  p.add(elbow, s.skin);

  const fore = new THREE.CylinderGeometry(0.04 * h, 0.036 * h, 0.24 * h, d.cylSeg, 1);
  place(fore, 0, -0.44 * h, 0);
  p.add(fore, s.skin);

  const hand = new THREE.SphereGeometry(0.05 * h, d.sphereW, d.sphereH);
  hand.scale(0.8, 1.1, 0.7);
  place(hand, 0, -0.59 * h, 0);
  p.add(hand, s.skin);

  return p.build();
}

/* ------------------------------------------------------------------ props */

function buildProp(kind: CarriedProp, s: VariantSpec, rig: Rig, d: Detail): THREE.BufferGeometry | null {
  const h = s.height / 1.72;
  const p = new Parts();

  switch (kind) {
    case 'none':
      return null;

    case 'barril': {
      /* a bomba barril: cedar staves, goat-skin head, two iron hoops */
      const body = new THREE.CylinderGeometry(0.16 * h, 0.135 * h, 0.46 * h, d.cylSeg + 4, 1);
      p.add(body, 0x8a5a32);
      const headSkin = new THREE.CylinderGeometry(0.163 * h, 0.163 * h, 0.02 * h, d.cylSeg + 4, 1);
      place(headSkin, 0, 0.235 * h, 0);
      p.add(headSkin, 0xe8d9be);
      for (let i = 0; i < 2; i++) {
        const hoop = new THREE.CylinderGeometry(0.166 * h, 0.166 * h, 0.022 * h, d.cylSeg + 4, 1);
        place(hoop, 0, (i === 0 ? 0.2 : -0.16) * h, 0);
        p.add(hoop, 0x6b6f76);
      }
      break;
    }

    case 'cakeBox': {
      const box = new THREE.BoxGeometry(0.36 * h, 0.32 * h, 0.36 * h);
      p.add(box, 0xfbf7ef);
      const lid = new THREE.BoxGeometry(0.375 * h, 0.035 * h, 0.375 * h);
      place(lid, 0, 0.17 * h, 0);
      p.add(lid, 0xf0e6d6);
      const ribA = new THREE.BoxGeometry(0.04 * h, 0.33 * h, 0.375 * h);
      p.add(ribA, s.accent);
      const ribB = new THREE.BoxGeometry(0.375 * h, 0.33 * h, 0.04 * h);
      p.add(ribB, s.accent);
      break;
    }

    case 'rollerCase': {
      const shell = new THREE.BoxGeometry(0.3 * h, 0.44 * h, 0.16 * h);
      p.add(shell, s.accent);
      const trim = new THREE.BoxGeometry(0.32 * h, 0.05 * h, 0.175 * h);
      place(trim, 0, 0.1 * h, 0);
      p.add(trim, 0x2a2a33);
      const handle = new THREE.BoxGeometry(0.16 * h, 0.02 * h, 0.02 * h);
      place(handle, 0, 0.33 * h, 0);
      p.add(handle, 0x4a4a55);
      for (let i = 0; i < 2; i++) {
        const bar = new THREE.BoxGeometry(0.02 * h, 0.13 * h, 0.02 * h);
        place(bar, (i === 0 ? -1 : 1) * 0.07 * h, 0.27 * h, 0);
        p.add(bar, 0x4a4a55);
      }
      for (let i = 0; i < 2; i++) {
        const w = new THREE.CylinderGeometry(0.035 * h, 0.035 * h, 0.03 * h, 8, 1);
        place(w, (i === 0 ? -1 : 1) * 0.11 * h, -0.24 * h, 0, 0, 0, Math.PI / 2);
        p.add(w, 0x1f2024);
      }
      break;
    }

    case 'sprayBag': {
      const bag = new THREE.BoxGeometry(0.3 * h, 0.36 * h, 0.18 * h);
      p.add(bag, 0x2f3238);
      const flap = new THREE.BoxGeometry(0.31 * h, 0.12 * h, 0.19 * h);
      place(flap, 0, 0.14 * h, 0);
      p.add(flap, s.accent);
      for (let i = 0; i < 3; i++) {
        const can = new THREE.CylinderGeometry(0.032 * h, 0.032 * h, 0.17 * h, 8, 1);
        place(can, (i - 1) * 0.075 * h, 0.24 * h, 0.02 * h);
        p.add(can, i === 0 ? 0xef476f : i === 1 ? 0xffd166 : 0x2fa8a0);
        const cap = new THREE.CylinderGeometry(0.02 * h, 0.02 * h, 0.03 * h, 6, 1);
        place(cap, (i - 1) * 0.075 * h, 0.34 * h, 0.02 * h);
        p.add(cap, 0xf5f0e6);
      }
      break;
    }

    case 'surfboard': {
      const board = new THREE.SphereGeometry(1, d.sphereW + 2, d.sphereH + 2);
      board.scale(0.22 * h, 0.028 * h, 0.95 * h);
      p.add(board, s.accent);
      const stripe = new THREE.SphereGeometry(1, d.sphereW, d.sphereH);
      stripe.scale(0.05 * h, 0.031 * h, 0.9 * h);
      p.add(stripe, 0xfaf6ee);
      const fin = new THREE.BoxGeometry(0.016 * h, 0.1 * h, 0.11 * h);
      place(fin, 0, -0.06 * h, 0.72 * h);
      p.add(fin, 0xfaf6ee);
      break;
    }

    case 'tote': {
      const bag = new THREE.BoxGeometry(0.26 * h, 0.3 * h, 0.13 * h);
      p.add(bag, s.accent);
      const handle = new THREE.TorusGeometry(0.09 * h, 0.012 * h, 4, 10, Math.PI);
      place(handle, 0, 0.15 * h, 0);
      p.add(handle, 0x6b5b45);
      const bread = new THREE.CylinderGeometry(0.035 * h, 0.035 * h, 0.22 * h, 7, 1);
      place(bread, 0.05 * h, 0.2 * h, 0, 0.25, 0, 0.2);
      p.add(bread, 0xd8a962);
      break;
    }

    case 'backpack': {
      const bag = new THREE.BoxGeometry(0.3 * h, 0.36 * h, 0.19 * h);
      p.add(bag, s.accent);
      const pocket = new THREE.BoxGeometry(0.2 * h, 0.14 * h, 0.06 * h);
      place(pocket, 0, -0.07 * h, -0.11 * h);
      p.add(pocket, 0x2f3238);
      break;
    }

    case 'clipboard': {
      const board = new THREE.BoxGeometry(0.23 * h, 0.31 * h, 0.014 * h);
      p.add(board, 0x8a6b45);
      const paper = new THREE.BoxGeometry(0.2 * h, 0.26 * h, 0.016 * h);
      place(paper, 0, -0.015 * h, -0.006 * h);
      p.add(paper, 0xfbf9f2);
      const clip = new THREE.BoxGeometry(0.1 * h, 0.03 * h, 0.026 * h);
      place(clip, 0, 0.14 * h, -0.006 * h);
      p.add(clip, 0x9aa0a8);
      break;
    }

    case 'cooler':
    default: {
      const body = new THREE.BoxGeometry(0.36 * h, 0.24 * h, 0.24 * h);
      p.add(body, 0xfaf6ee);
      const lid = new THREE.BoxGeometry(0.375 * h, 0.05 * h, 0.25 * h);
      place(lid, 0, 0.13 * h, 0);
      p.add(lid, s.accent);
      break;
    }
  }

  const geo = p.build();
  if (!geo) return null;

  /* park it where this pose wants it */
  switch (kind) {
    case 'barril':
      place(geo, rig.propX, rig.seated ? rig.propY + 0.22 * h : 0.72 * h, rig.propZ - 0.04 * h, rig.seated ? -0.25 : 0, 0, 0.1);
      break;
    case 'cakeBox':
      place(geo, rig.propX, rig.seated ? rig.propY + 0.2 * h : rig.propY, rig.propZ);
      break;
    case 'rollerCase':
      place(geo, rig.seated ? 0.3 * h : 0.32 * h, rig.seated ? rig.propY + 0.14 * h : 0.3 * h, rig.seated ? -0.16 * h : 0.06 * h);
      break;
    case 'sprayBag':
    case 'backpack':
      place(geo, 0, rig.seated ? rig.propY + 0.28 * h : 1.14 * h, rig.seated ? 0.2 * h : 0.2 * h);
      break;
    case 'surfboard':
      if (rig.seated) place(geo, 0.02 * h, rig.propY + 0.05 * h, 0.15 * h, 0.14, 0, 0.05);
      else place(geo, 0.34 * h, 0.95 * h, 0.06 * h, Math.PI / 2, 0, 0.06);
      break;
    case 'tote':
      place(geo, rig.seated ? 0.24 * h : 0.27 * h, rig.seated ? rig.propY + 0.18 * h : 0.86 * h, rig.seated ? -0.1 * h : 0);
      break;
    case 'clipboard':
      place(geo, 0.15 * h, rig.seated ? rig.propY + 0.24 * h : 1.02 * h, rig.propZ + 0.06 * h, 0.3, 0.25, 0);
      break;
    case 'cooler':
      place(geo, 0.28 * h, rig.seated ? rig.propY + 0.1 * h : 0.5 * h, rig.seated ? -0.14 * h : 0);
      break;
    default:
      break;
  }
  return geo;
}

/* --------------------------------------------------------------- variants */

/** People the game always reads as elders — grey/white hair, every variant. */
const ELDERS: ReadonlySet<string> = new Set(['abuela', 'abuelo-parrandero', 'tio-wiso']);

/** Deterministic per-(archetype, variant) appearance. No RNG object needed. */
function specFor(archetypeId: string, variant: number): VariantSpec {
  const v = visualFor(archetypeId);
  const idx = ((variant % VARIANTS_PER_ARCHETYPE) + VARIANTS_PER_ARCHETYPE) % VARIANTS_PER_ARCHETYPE;

  /* hash the id so two archetypes with the same variant index differ */
  let hash = 2166136261;
  for (let i = 0; i < archetypeId.length; i++) {
    hash ^= archetypeId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash = (hash ^ Math.imul(idx + 1, 0x9e3779b1)) >>> 0;
  const r = (n: number): number => {
    let t = (hash + Math.imul(n + 1, 0x6d2b79f5)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* the whole melanin ramp, evenly walked, jittered so it is not a staircase */
  const skinT = clamp01((idx + 0.5) / VARIANTS_PER_ARCHETYPE + (r(1) - 0.5) * (0.9 / VARIANTS_PER_ARCHETYPE));

  const elder =
    ELDERS.has(archetypeId) ||
    ((archetypeId === 'tour-guide' || archetypeId === 'fisherman') && r(9) > 0.7);
  const hairPool = elder ? GREY_HAIR_COLORS : HAIR_COLORS;

  return {
    skin: skinToneAt(skinT),
    hair: v.hair[Math.floor(r(2) * v.hair.length) % v.hair.length],
    hairColor: hairPool[Math.floor(r(3) * hairPool.length) % hairPool.length],
    head: v.head[Math.floor(r(4) * v.head.length) % v.head.length],
    shirt: v.shirt[Math.floor(r(5) * v.shirt.length) % v.shirt.length],
    accent: v.accent[Math.floor(r(6) * v.accent.length) % v.accent.length],
    legColor: v.legColor[Math.floor(r(7) * v.legColor.length) % v.legColor.length],
    height: v.height * (0.955 + r(8) * 0.09),
    build: v.build * (0.95 + r(10) * 0.11),
    energy: v.energy,
    phase: r(11) * Math.PI * 2,
  };
}

/* ------------------------------------------------------------ the figure */

const ARM_REST_X = 0.06;

interface ArmTarget {
  x: number;
  z: number;
}

/**
 * One passenger in the world. Three meshes and two arm pivots — the whole
 * animation budget is a handful of `damp` calls per frame.
 */
export class PassengerFigure {
  readonly root = new THREE.Group();
  readonly pose: FigurePose;
  readonly archetypeId: string;
  readonly variant: number;
  /** which build of the geometry cache this figure came from */
  readonly generation: number;

  private readonly bodyMesh: THREE.Mesh;
  private readonly armLPivot = new THREE.Object3D();
  private readonly armRPivot = new THREE.Object3D();
  private readonly propMesh: THREE.Mesh | null;

  private readonly spec: VariantSpec;
  private anim: FigureAnim = 'idle';
  private t = 0;
  private reactionLeft = 0;
  private reactionAnim: FigureAnim | null = null;

  private readonly targetL: ArmTarget = { x: ARM_REST_X, z: 0.06 };
  private readonly targetR: ArmTarget = { x: ARM_REST_X, z: -0.06 };
  private curLX = ARM_REST_X;
  private curLZ = 0.06;
  private curRX = ARM_REST_X;
  private curRZ = -0.06;
  private lean = 0;
  private leanTarget = 0;
  private baseY = 0;

  constructor(
    geo: FigureGeo,
    spec: VariantSpec,
    material: THREE.Material,
    archetypeId: string,
    variant: number,
    pose: FigurePose,
    generation: number,
  ) {
    this.spec = spec;
    this.pose = pose;
    this.archetypeId = archetypeId;
    this.variant = variant % VARIANTS_PER_ARCHETYPE;
    this.generation = generation;

    this.bodyMesh = new THREE.Mesh(geo.body, material);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = false;
    this.root.add(this.bodyMesh);

    this.armLPivot.position.set(-geo.rig.armX, geo.rig.shoulderY, 0);
    this.armRPivot.position.set(geo.rig.armX, geo.rig.shoulderY, 0);
    const armL = new THREE.Mesh(geo.arm, material);
    const armR = new THREE.Mesh(geo.arm, material);
    armL.castShadow = true;
    armR.castShadow = true;
    this.armLPivot.add(armL);
    this.armRPivot.add(armR);
    this.root.add(this.armLPivot, this.armRPivot);

    if (geo.prop) {
      this.propMesh = new THREE.Mesh(geo.prop, material);
      this.propMesh.castShadow = true;
      this.root.add(this.propMesh);
    } else {
      this.propMesh = null;
    }

    this.root.matrixAutoUpdate = true;
    this.t = spec.phase;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /** Standing figures sit on the ground; seated ones on their mount point. */
  setBase(x: number, y: number, z: number): void {
    this.baseY = y;
    this.root.position.set(x, y, z);
  }

  /** Face a world-space point (figures are authored facing -Z). */
  faceTowards(x: number, z: number): void {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz < 1e-6) return;
    this.root.rotation.y = Math.atan2(-dx, -dz);
  }

  setHeading(rad: number): void {
    this.root.rotation.y = rad;
  }

  setAnim(a: FigureAnim): void {
    this.anim = a;
  }

  /** Play a short reaction, then fall back to the standing animation. */
  react(a: FigureAnim, seconds: number): void {
    this.reactionAnim = a;
    this.reactionLeft = Math.max(this.reactionLeft, seconds);
  }

  update(dt: number): void {
    this.t += dt;
    if (this.reactionLeft > 0) {
      this.reactionLeft -= dt;
      if (this.reactionLeft <= 0) this.reactionAnim = null;
    }
    const anim = this.reactionAnim ?? this.anim;
    const e = this.spec.energy;
    const t = this.t;

    let bob = 0;
    switch (anim) {
      case 'hail': {
        const w = Math.sin(t * 8.5);
        this.targetR.z = 2.45 + w * 0.32;
        this.targetR.x = -0.2;
        this.targetL.z = -0.25 - Math.sin(t * 2.2) * 0.08;
        this.targetL.x = 0.12;
        this.leanTarget = -0.03;
        bob = Math.abs(Math.sin(t * 4.2)) * 0.035 * (0.5 + e);
        break;
      }
      case 'brace': {
        this.targetR.x = 2.05;
        this.targetR.z = 0.55;
        this.targetL.x = 2.05;
        this.targetL.z = -0.55;
        this.leanTarget = 0.22;
        bob = 0;
        break;
      }
      case 'cheer': {
        const w = Math.sin(t * 9) * 0.16;
        this.targetR.z = 2.95 + w;
        this.targetR.x = -0.1;
        this.targetL.z = -2.95 - w;
        this.targetL.x = -0.1;
        this.leanTarget = -0.16;
        bob = 0.03;
        break;
      }
      case 'annoyed': {
        this.targetR.x = 1.45;
        this.targetR.z = -0.95;
        this.targetL.x = 1.45;
        this.targetL.z = 0.95;
        this.leanTarget = 0.05;
        bob = Math.sin(t * 1.4) * 0.006;
        break;
      }
      case 'ride': {
        const sway = Math.sin(t * 2.6) * 0.09 * (0.4 + e);
        this.targetR.x = 0.85 + sway;
        this.targetR.z = -0.22;
        this.targetL.x = 0.85 - sway;
        this.targetL.z = 0.22;
        this.leanTarget = 0.04;
        bob = Math.sin(t * 5.1) * 0.006;
        break;
      }
      case 'idle':
      default: {
        const s = Math.sin(t * 1.5 + this.spec.phase);
        this.targetR.x = ARM_REST_X + s * 0.13 * (0.4 + e);
        this.targetR.z = -0.07;
        this.targetL.x = ARM_REST_X - s * 0.13 * (0.4 + e);
        this.targetL.z = 0.07;
        this.leanTarget = 0;
        bob = Math.sin(t * 2.1 + this.spec.phase) * 0.011 * (0.4 + e);
        break;
      }
    }

    const rate = 11;
    this.curLX = damp(this.curLX, this.targetL.x, rate, dt);
    this.curLZ = damp(this.curLZ, this.targetL.z, rate, dt);
    this.curRX = damp(this.curRX, this.targetR.x, rate, dt);
    this.curRZ = damp(this.curRZ, this.targetR.z, rate, dt);
    this.lean = damp(this.lean, this.leanTarget, 9, dt);

    this.armLPivot.rotation.x = this.curLX;
    this.armLPivot.rotation.z = this.curLZ;
    this.armRPivot.rotation.x = this.curRX;
    this.armRPivot.rotation.z = this.curRZ;
    this.bodyMesh.rotation.x = this.lean * 0.55;
    this.root.position.y = this.baseY + (this.pose === 'stand' ? bob : bob * 0.4);
    this.root.rotation.x = this.pose === 'stand' ? this.lean * 0.35 : this.lean * 0.2;
  }

  /** Snap the pose so a recycled figure never lerps in from the last owner. */
  resetPose(): void {
    this.reactionAnim = null;
    this.reactionLeft = 0;
    this.anim = 'idle';
    this.curLX = this.targetL.x = ARM_REST_X;
    this.curLZ = this.targetL.z = 0.07;
    this.curRX = this.targetR.x = ARM_REST_X;
    this.curRZ = this.targetR.z = -0.07;
    this.lean = this.leanTarget = 0;
    this.root.rotation.set(0, 0, 0);
    this.bodyMesh.rotation.set(0, 0, 0);
    this.update(0);
  }
}

/* -------------------------------------------------------------- the pool */

export interface PassengerModelPoolOptions {
  quality?: QualityTier;
  /** figures kept alive per pose once released; beyond this they are dropped */
  softCap?: number;
}

/**
 * Builds and recycles figures. Geometry is cached per
 * `archetype|variant|pose`, so the eighth Doña Carmen of a shift is free.
 */
export class PassengerModelPool {
  readonly material: THREE.MeshStandardMaterial;

  private detail: Detail;
  private readonly geoCache = new Map<string, FigureGeo>();
  private readonly free = new Map<string, PassengerFigure[]>();
  private readonly softCap: number;
  private live = 0;
  /** bumped on a quality change; figures from an older build are not recycled */
  private generation = 0;
  /** geometry from a previous build, still referenced by figures in the world */
  private readonly retired: FigureGeo[] = [];

  constructor(opts: PassengerModelPoolOptions = {}) {
    this.detail = DETAIL[opts.quality ?? 'high'];
    this.softCap = opts.softCap ?? 4;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
    });
    this.material.name = 'passenger';
  }

  get liveCount(): number {
    return this.live;
  }

  get cachedVariants(): number {
    return this.geoCache.size;
  }

  onQualityChange(tier: QualityTier): void {
    const next = DETAIL[tier];
    if (next === this.detail) return;
    this.detail = next;
    this.generation++;
    /*
     * Figures already standing in the street still reference the old geometry,
     * so it cannot be disposed here — retire it and free it once the last
     * figure holding it has been released.
     */
    for (const geo of this.geoCache.values()) this.retired.push(geo);
    this.geoCache.clear();
    this.free.clear();
    this.sweepRetired();
  }

  private sweepRetired(): void {
    if (this.live > 0 || this.retired.length === 0) return;
    for (const geo of this.retired) {
      geo.body.dispose();
      geo.arm.dispose();
      geo.prop?.dispose();
    }
    this.retired.length = 0;
  }

  acquire(archetypeId: string, variant: number, pose: FigurePose): PassengerFigure {
    const key = `${archetypeId}|${variant % VARIANTS_PER_ARCHETYPE}|${pose}`;
    const bucket = this.free.get(key);
    if (bucket && bucket.length > 0) {
      const fig = bucket.pop() as PassengerFigure;
      fig.resetPose();
      fig.visible = true;
      this.live++;
      return fig;
    }
    const geo = this.geometryFor(archetypeId, variant, pose, key);
    const fig = new PassengerFigure(
      geo,
      specFor(archetypeId, variant),
      this.material,
      archetypeId,
      variant,
      pose,
      this.generation,
    );
    fig.resetPose();
    this.live++;
    return fig;
  }

  release(fig: PassengerFigure): void {
    fig.visible = false;
    fig.root.removeFromParent();
    this.live = Math.max(0, this.live - 1);

    /* a figure built before a quality change points at retired geometry */
    if (fig.generation !== this.generation) {
      this.sweepRetired();
      return;
    }

    const key = `${fig.archetypeId}|${fig.variant}|${fig.pose}`;
    let bucket = this.free.get(key);
    if (!bucket) {
      bucket = [];
      this.free.set(key, bucket);
    }
    if (bucket.length < this.softCap) bucket.push(fig);
  }

  private geometryFor(archetypeId: string, variant: number, pose: FigurePose, key: string): FigureGeo {
    const cached = this.geoCache.get(key);
    if (cached) return cached;

    const v = visualFor(archetypeId);
    const spec = specFor(archetypeId, variant);
    const h = spec.height / 1.72;
    const rig = pose === 'seat' ? seatRig(h, spec.build) : standRig(h, spec.build);
    const d = this.detail;

    const p = new Parts();
    buildLegs(p, v, spec, rig, d);
    buildTorso(p, v, spec, rig, d);
    buildHead(p, spec, rig, d);
    buildHair(p, spec, rig, d);
    buildHeadwear(p, spec, rig, d);

    const body = p.build() ?? new THREE.BoxGeometry(0.3, 1.6, 0.2);
    const arm = buildArm(spec, d) ?? new THREE.BoxGeometry(0.08, 0.6, 0.08);
    const prop = buildProp(v.prop, spec, rig, d);

    const geo: FigureGeo = { body, arm, prop, rig };
    this.geoCache.set(key, geo);
    return geo;
  }

  dispose(): void {
    for (const geo of this.geoCache.values()) this.retired.push(geo);
    this.geoCache.clear();
    this.free.clear();
    this.live = 0;
    this.sweepRetired();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------- the beacon */

const BEACON_HEIGHT = 5.4;

function buildBeaconGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  /* the shaft: bright at the base, black (= invisible under additive) at the top */
  const shaft = new THREE.CylinderGeometry(0.09, 0.34, BEACON_HEIGHT, 10, 6, true);
  shaft.translate(0, BEACON_HEIGHT * 0.5, 0);
  const pos = shaft.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / BEACON_HEIGHT;
    const f = Math.pow(clamp01(1 - y), 1.7) * 0.95 + 0.05;
    col[i * 3] = f;
    col[i * 3 + 1] = f;
    col[i * 3 + 2] = f;
  }
  shaft.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!shaft.attributes.uv) {
    shaft.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  }
  parts.push(shaft);

  /* a ground ring so the pickup zone reads on the cobblestone */
  const ring = new THREE.RingGeometry(1.5, 2.1, 26, 1);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, 0.06, 0);
  parts.push(tint(ring, 0xffffff));

  /* a chevron pointing down at the person */
  const chev = new THREE.ConeGeometry(0.32, 0.5, 4, 1);
  chev.rotateY(Math.PI / 4);
  chev.rotateX(Math.PI);
  chev.translate(0, 2.55, 0);
  parts.push(tint(chev, 0xffffff));

  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged ?? new THREE.CylinderGeometry(0.1, 0.3, BEACON_HEIGHT, 6, 1, true);
}

/**
 * The "someone wants a taxi here" marker. Additive, depth-tested but not
 * depth-written, so it reads through traffic without z-fighting the street.
 */
export class HailBeacon {
  readonly root = new THREE.Object3D();
  private readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private t = 0;
  private urgency = 0;

  constructor(geometry: THREE.BufferGeometry, color: number) {
    this.mat = new THREE.MeshBasicMaterial({
      color,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.mat);
    this.mesh.renderOrder = 12;
    this.mesh.frustumCulled = true;
    this.root.add(this.mesh);
  }

  setColor(hex: number): void {
    this.mat.color.setHex(hex);
  }

  /** 0 = plenty of patience, 1 = about to walk off. Drives pulse rate + colour. */
  setUrgency(u: number): void {
    this.urgency = clamp01(u);
  }

  update(dt: number): void {
    this.t += dt;
    const rate = 2.2 + this.urgency * 5.5;
    const pulse = 0.72 + Math.sin(this.t * rate) * (0.18 + this.urgency * 0.2);
    this.mat.opacity = clamp(pulse, 0.25, 1);
    this.mesh.rotation.y = this.t * (0.7 + this.urgency * 1.6);
    const s = 1 + Math.sin(this.t * rate * 0.5) * 0.03;
    this.mesh.scale.set(s, 1, s);
  }

  dispose(): void {
    this.mat.dispose();
    this.root.removeFromParent();
  }
}

/** Shares one beacon geometry across every marker in the city. */
export class BeaconPool {
  private readonly geometry = buildBeaconGeometry();
  private readonly free: HailBeacon[] = [];
  private live = 0;

  acquire(color: number): HailBeacon {
    const b = this.free.pop();
    if (b) {
      b.setColor(color);
      this.live++;
      return b;
    }
    this.live++;
    return new HailBeacon(this.geometry, color);
  }

  release(b: HailBeacon): void {
    b.root.removeFromParent();
    this.live = Math.max(0, this.live - 1);
    if (this.free.length < 12) this.free.push(b);
    else b.dispose();
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    for (const b of this.free) b.dispose();
    this.free.length = 0;
    this.geometry.dispose();
    this.live = 0;
  }
}

/* ------------------------------------------------------- the runaway cart */

export interface PiraguaCart {
  root: THREE.Object3D;
  spinWheels(radians: number): void;
  dispose(): void;
}

/**
 * A piragüero's shaved-ice cart — bright paint, striped umbrella, glass syrup
 * bottles (ART_REFERENCE §7.2). Used by the "carrito fugitivo" chase mission.
 */
export function buildPiraguaCart(material: THREE.MeshStandardMaterial): PiraguaCart {
  const root = new THREE.Object3D();
  const body = new Parts();

  const box = new THREE.BoxGeometry(0.9, 0.62, 1.4);
  place(box, 0, 0.62, 0);
  body.add(box, 0xef476f);

  const lid = new THREE.BoxGeometry(0.98, 0.08, 1.48);
  place(lid, 0, 0.96, 0);
  body.add(lid, 0xfaf6ee);

  const trim = new THREE.BoxGeometry(0.94, 0.1, 1.44);
  place(trim, 0, 0.72, 0);
  body.add(trim, 0x2fa8a0);

  const frame = new THREE.BoxGeometry(0.06, 0.34, 0.06);
  place(frame, 0, 0.15, -0.6);
  body.add(frame, 0x4a4a55);

  const handle = new THREE.BoxGeometry(0.06, 0.06, 0.7);
  place(handle, 0, 0.95, -0.98);
  body.add(handle, 0x6b5b45);

  /* syrup bottles: tamarindo, coco, frambuesa */
  const syrups = [0xb5651d, 0xf7f2e6, 0xd12a5a];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.CylinderGeometry(0.055, 0.06, 0.24, 8, 1);
    place(b, -0.26 + i * 0.26, 1.12, 0.42);
    body.add(b, syrups[i]);
    const neck = new THREE.CylinderGeometry(0.022, 0.03, 0.08, 6, 1);
    place(neck, -0.26 + i * 0.26, 1.28, 0.42);
    body.add(neck, 0xdfe9f2);
  }

  /* the striped umbrella — alternating wedges, not a texture */
  const pole = new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8, 1);
  place(pole, 0, 1.7, 0);
  body.add(pole, 0x9aa0a8);
  const wedges = 8;
  for (let i = 0; i < wedges; i++) {
    const seg = new THREE.ConeGeometry(1.05, 0.42, 6, 1, false, (i / wedges) * Math.PI * 2, (Math.PI * 2) / wedges);
    place(seg, 0, 2.36, 0);
    body.add(seg, i % 2 === 0 ? 0xed0000 : 0xfaf6ee);
  }

  const bodyGeo = body.build();
  if (bodyGeo) {
    const mesh = new THREE.Mesh(bodyGeo, material);
    mesh.castShadow = true;
    root.add(mesh);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.12, 12, 1);
  wheelGeo.rotateZ(Math.PI / 2);
  tint(wheelGeo, 0x1f2024);
  const wheels: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const w = new THREE.Mesh(wheelGeo, material);
    w.position.set((i === 0 ? -1 : 1) * 0.5, 0.3, 0.25);
    w.castShadow = true;
    root.add(w);
    wheels.push(w);
  }

  return {
    root,
    spinWheels(radians: number): void {
      for (const w of wheels) w.rotation.x += radians;
    },
    dispose(): void {
      bodyGeo?.dispose();
      wheelGeo.dispose();
      root.removeFromParent();
    },
  };
}
