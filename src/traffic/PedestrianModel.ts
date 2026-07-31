/**
 * Loco Lift — procedural pedestrians.
 *
 * A hundred people on the pavement for **two draw calls**.
 *
 * ## How
 *
 * One low-poly figure geometry, rigged to an eleven-bone skeleton, drawn from
 * an `InstancedMesh`. Animation is baked on the CPU at boot into a
 * **bone texture** — a `DataTexture` of `clip × frame × bone` 3×4 matrices —
 * and the vertex shader fetches the two nearest frames and blends them. That
 * gives us hand-authored walk / idle / dance / panic cycles with no skinning
 * cost beyond four texel fetches per vertex, and *no* per-frame CPU work
 * except writing one `vec4` per person.
 *
 * Per-instance variation comes from four colour attributes — **skin, shirt,
 * trousers, hair** — plus a `vec3` of *slot selectors* that switch which held
 * prop, which headwear and which hair shape is visible (the others collapse to
 * a degenerate point). So one geometry yields shopping bags, panderos, cuatros,
 * plaza stools, caps, straw hats, crops, afros, tied-back hair and locs.
 *
 * ART_REFERENCE §7.2 is binding: the melanin ramp is **continuous and sampled
 * uniformly**, hair texture genuinely varies, and clothing is light Caribbean
 * cotton — never a costume, never a caricature.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RNG } from '../core/RNG';
import { clamp01 } from '../core/MathUtils';
import {
  CART_PAINT,
  GUAYABERA,
  HAIR_COLORS,
  PANTS_COLORS,
  PED_ANIM,
  SHIRT_COLORS,
  SKIN_RAMP,
  UNIFORM_PANTS,
  UNIFORM_SHIRT,
} from './TrafficTuning';

/* ================================================================= rig */

export const BONE = {
  HIPS: 0,
  CHEST: 1,
  HEAD: 2,
  ARM_L_UPPER: 3,
  ARM_L_FORE: 4,
  ARM_R_UPPER: 5,
  ARM_R_FORE: 6,
  LEG_L_UPPER: 7,
  LEG_L_SHIN: 8,
  LEG_R_UPPER: 9,
  LEG_R_SHIN: 10,
} as const;

export const BONE_COUNT = 11;

/** Parent index per bone, −1 for the root. */
const PARENT = new Int8Array([-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9]);

/** Rig dimensions for a nominal 1.72 m adult, in metres. */
const RIG = {
  ankleY: 0.1,
  kneeY: 0.46,
  hipY: 0.92,
  waistY: 1.0,
  shoulderY: 1.4,
  elbowY: 1.13,
  neckY: 1.46,
  headY: 1.58,
  /** half distance between the shoulders */
  shoulderX: 0.185,
  /** half distance between the hip joints */
  hipX: 0.098,
} as const;

/** Bone pivots in bind-pose model space. */
const PIVOT = new Float32Array([
  0, RIG.hipY, 0, // hips (root)
  0, RIG.waistY, 0, // chest
  0, RIG.neckY, 0, // head
  RIG.shoulderX, RIG.shoulderY, 0, // L upper arm
  RIG.shoulderX, RIG.elbowY, 0, // L forearm
  -RIG.shoulderX, RIG.shoulderY, 0, // R upper arm
  -RIG.shoulderX, RIG.elbowY, 0, // R forearm
  RIG.hipX, RIG.hipY, 0, // L thigh
  RIG.hipX, RIG.kneeY, 0, // L shin
  -RIG.hipX, RIG.hipY, 0, // R thigh
  -RIG.hipX, RIG.kneeY, 0, // R shin
]);

/* ============================================================材 material ids */

/** Per-vertex material role. Drives both tinting and slot visibility. */
export const MAT = {
  /** baked vertex colour, always drawn */
  BAKED: 0,
  SKIN: 1,
  SHIRT: 2,
  PANTS: 3,
  /** hair-coloured but always drawn (eyebrows / stubble) */
  HAIR: 4,
  /** held props — visible when `iProp.x` selects them */
  PROP_BAG: 5,
  PROP_DRUM: 6,
  PROP_CUATRO: 7,
  PROP_STOOL: 8,
  /** headwear — visible when `iProp.y` selects them */
  HEAD_CAP: 9,
  HEAD_STRAW: 10,
  /** hair shapes — hair-coloured, visible when `iProp.z` selects them */
  HAIR_CROP: 11,
  HAIR_AFRO: 12,
  HAIR_TIED: 13,
  HAIR_LOCS: 14,
} as const;

/* ================================================================ clips */

export const CLIP = {
  IDLE: 0,
  WALK: 1,
  JOG: 2,
  PANIC: 3,
  DANCE: 4,
  CLAP: 5,
  SIT: 6,
  PLAY: 7,
  VEND: 8,
  TALK: 9,
} as const;

export const CLIP_COUNT = 10;

/** Nominal playback rate (cycles/second) per clip index. */
export const CLIP_RATE = new Float32Array([
  PED_ANIM.idleRate,
  PED_ANIM.walkRate,
  PED_ANIM.jogRate,
  PED_ANIM.panicRate,
  PED_ANIM.danceRate,
  PED_ANIM.clapRate,
  PED_ANIM.sitRate,
  PED_ANIM.playRate,
  PED_ANIM.vendRate,
  PED_ANIM.talkRate,
]);

const TAU = Math.PI * 2;

/**
 * Pose buffer layout: `BONE_COUNT * 3` euler angles (XYZ, radians) followed by
 * three root-translation floats.
 */
const POSE_LEN = BONE_COUNT * 3 + 3;

type PoseFn = (p: number, out: Float32Array) => void;

const setBone = (out: Float32Array, bone: number, x: number, y: number, z: number): void => {
  out[bone * 3] = x;
  out[bone * 3 + 1] = y;
  out[bone * 3 + 2] = z;
};

/** Standing idle: breathing, a slow weight shift, arms hanging with a sway. */
const poseIdle: PoseFn = (p, out) => {
  const a = p * TAU;
  const breath = Math.sin(a) * 0.5 + 0.5;
  setBone(out, BONE.HIPS, 0, Math.sin(a) * 0.05, Math.sin(a * 0.5) * 0.035);
  setBone(out, BONE.CHEST, breath * 0.03, Math.sin(a) * -0.04, 0);
  setBone(out, BONE.HEAD, Math.sin(a * 0.7) * 0.05, Math.sin(a * 0.45) * 0.16, 0);
  setBone(out, BONE.ARM_L_UPPER, Math.sin(a) * 0.06, 0, -0.09);
  setBone(out, BONE.ARM_R_UPPER, Math.sin(a + 1.1) * 0.06, 0, 0.09);
  setBone(out, BONE.ARM_L_FORE, 0.18 + Math.sin(a) * 0.04, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 0.18 + Math.sin(a + 1.1) * 0.04, 0, 0);
  setBone(out, BONE.LEG_L_UPPER, 0.02, 0, -0.02);
  setBone(out, BONE.LEG_R_UPPER, -0.02, 0, 0.02);
  out[BONE_COUNT * 3 + 1] = breath * 0.006;
};

/** Shared biped gait. `amp` scales the stride, `lean` tips the torso forward. */
function gait(p: number, out: Float32Array, amp: number, lean: number, armBend: number): void {
  const a = p * TAU;
  const swingL = Math.sin(a) * amp;
  const swingR = Math.sin(a + Math.PI) * amp;
  // knees only bend on the way through
  const bendL = Math.max(0, Math.sin(a + 1.15)) * amp * 1.55;
  const bendR = Math.max(0, Math.sin(a + Math.PI + 1.15)) * amp * 1.55;

  setBone(out, BONE.LEG_L_UPPER, swingL, 0, -0.03);
  setBone(out, BONE.LEG_R_UPPER, swingR, 0, 0.03);
  setBone(out, BONE.LEG_L_SHIN, -bendL, 0, 0);
  setBone(out, BONE.LEG_R_SHIN, -bendR, 0, 0);

  setBone(out, BONE.HIPS, 0, Math.sin(a) * 0.11, Math.sin(a) * 0.04);
  setBone(out, BONE.CHEST, lean, Math.sin(a) * -0.16, 0);
  setBone(out, BONE.HEAD, -lean * 0.6, Math.sin(a) * 0.07, 0);

  setBone(out, BONE.ARM_L_UPPER, swingR * 0.72 - lean * 0.4, 0, -0.1);
  setBone(out, BONE.ARM_R_UPPER, swingL * 0.72 - lean * 0.4, 0, 0.1);
  setBone(out, BONE.ARM_L_FORE, armBend + Math.max(0, swingR) * 0.35, 0, 0);
  setBone(out, BONE.ARM_R_FORE, armBend + Math.max(0, swingL) * 0.35, 0, 0);

  // two vertical bobs per cycle, dipping on each foot-strike
  out[BONE_COUNT * 3 + 1] = -0.018 * (0.5 - 0.5 * Math.cos(a * 2));
}

const poseWalk: PoseFn = (p, out) => gait(p, out, 0.52, 0.05, 0.24);
const poseJog: PoseFn = (p, out) => gait(p, out, 0.86, 0.2, 0.95);

/** Arms up, torso back, legs scrambling — the "¡oye!" reaction. */
const posePanic: PoseFn = (p, out) => {
  const a = p * TAU;
  gait(p, out, 0.95, -0.14, 0.4);
  const flail = Math.sin(a * 2) * 0.28;
  setBone(out, BONE.ARM_L_UPPER, 2.55 + flail, 0, -0.55);
  setBone(out, BONE.ARM_R_UPPER, 2.55 - flail, 0, 0.55);
  setBone(out, BONE.ARM_L_FORE, 0.5 - flail * 0.6, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 0.5 + flail * 0.6, 0, 0);
  setBone(out, BONE.HEAD, -0.22, Math.sin(a * 2) * 0.3, 0);
};

/** Bomba / plena step: hip sway, counter-rotating shoulders, arms open. */
const poseDance: PoseFn = (p, out) => {
  const a = p * TAU;
  const s = Math.sin(a);
  const s2 = Math.sin(a * 2);
  setBone(out, BONE.HIPS, 0, s * 0.3, s * 0.15);
  setBone(out, BONE.CHEST, 0.05 + s2 * 0.05, s * -0.38, s * -0.1);
  setBone(out, BONE.HEAD, s2 * 0.08, s * 0.22, 0);
  setBone(out, BONE.ARM_L_UPPER, 0.55 + s * 0.45, 0, -1.0 - s * 0.25);
  setBone(out, BONE.ARM_R_UPPER, 0.55 - s * 0.45, 0, 1.0 - s * 0.25);
  setBone(out, BONE.ARM_L_FORE, 0.9 + s * 0.35, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 0.9 - s * 0.35, 0, 0);
  setBone(out, BONE.LEG_L_UPPER, Math.max(0, s) * 0.42, 0, -0.06);
  setBone(out, BONE.LEG_R_UPPER, Math.max(0, -s) * 0.42, 0, 0.06);
  setBone(out, BONE.LEG_L_SHIN, -Math.max(0, s) * 0.75, 0, 0);
  setBone(out, BONE.LEG_R_SHIN, -Math.max(0, -s) * 0.75, 0, 0);
  out[BONE_COUNT * 3 + 1] = 0.035 * Math.abs(s2);
};

/** Clapping to the beat with a bounce — the crowd around a plena group. */
const poseClap: PoseFn = (p, out) => {
  const a = p * TAU;
  const beat = Math.sin(a * 2);
  setBone(out, BONE.HIPS, 0, 0, beat * 0.05);
  setBone(out, BONE.CHEST, 0.06, beat * 0.09, 0);
  setBone(out, BONE.HEAD, beat * 0.1, 0, 0);
  const reach = 1.35 + beat * 0.22;
  setBone(out, BONE.ARM_L_UPPER, reach, 0, -0.34 - beat * 0.2);
  setBone(out, BONE.ARM_R_UPPER, reach, 0, 0.34 + beat * 0.2);
  setBone(out, BONE.ARM_L_FORE, 1.0, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 1.0, 0, 0);
  setBone(out, BONE.LEG_L_UPPER, 0.05, 0, -0.04);
  setBone(out, BONE.LEG_R_UPPER, 0.05, 0, 0.04);
  setBone(out, BONE.LEG_L_SHIN, -0.1, 0, 0);
  setBone(out, BONE.LEG_R_SHIN, -0.1, 0, 0);
  out[BONE_COUNT * 3 + 1] = 0.05 * clamp01(beat);
};

/** Seated on a plaza bench or a café stool. */
const poseSit: PoseFn = (p, out) => {
  const a = p * TAU;
  setBone(out, BONE.LEG_L_UPPER, 1.5, 0, -0.11);
  setBone(out, BONE.LEG_R_UPPER, 1.5, 0, 0.11);
  setBone(out, BONE.LEG_L_SHIN, -1.42, 0, 0);
  setBone(out, BONE.LEG_R_SHIN, -1.42, 0, 0);
  setBone(out, BONE.HIPS, -0.1, 0, 0);
  setBone(out, BONE.CHEST, 0.1 + Math.sin(a) * 0.025, Math.sin(a * 0.5) * 0.12, 0);
  setBone(out, BONE.HEAD, Math.sin(a * 0.6) * 0.07, Math.sin(a * 0.4) * 0.25, 0);
  setBone(out, BONE.ARM_L_UPPER, 0.42, 0, -0.2);
  setBone(out, BONE.ARM_R_UPPER, 0.42 + Math.sin(a) * 0.1, 0, 0.2);
  setBone(out, BONE.ARM_L_FORE, 0.85, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 0.85 + Math.sin(a) * 0.2, 0, 0);
  out[BONE_COUNT * 3 + 1] = -0.4;
};

/** Playing a pandero: alternating strikes, weight rocking. */
const posePlay: PoseFn = (p, out) => {
  const a = p * TAU;
  const s = Math.sin(a);
  setBone(out, BONE.HIPS, 0, s * 0.08, s * 0.05);
  setBone(out, BONE.CHEST, 0.1, s * -0.1, 0);
  setBone(out, BONE.HEAD, 0.08 + s * 0.06, 0, 0);
  setBone(out, BONE.ARM_L_UPPER, 0.72 + s * 0.3, 0, -0.42);
  setBone(out, BONE.ARM_R_UPPER, 0.72 - s * 0.3, 0, 0.42);
  setBone(out, BONE.ARM_L_FORE, 1.15 - s * 0.45, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 1.15 + s * 0.45, 0, 0);
  setBone(out, BONE.LEG_L_UPPER, 0.06, 0, -0.05);
  setBone(out, BONE.LEG_R_UPPER, 0.02, 0, 0.05);
  setBone(out, BONE.LEG_L_SHIN, -0.12, 0, 0);
  setBone(out, BONE.LEG_R_SHIN, -0.06, 0, 0);
  out[BONE_COUNT * 3 + 1] = 0.012 * Math.abs(s);
};

/** Vendor: one arm out offering, the other resting on the cart. */
const poseVend: PoseFn = (p, out) => {
  const a = p * TAU;
  const s = Math.sin(a);
  setBone(out, BONE.HIPS, 0, 0.08, 0.03);
  setBone(out, BONE.CHEST, 0.04, 0.16 + s * 0.08, 0);
  setBone(out, BONE.HEAD, 0.02, -0.2 + s * 0.14, 0);
  setBone(out, BONE.ARM_L_UPPER, 0.55 + s * 0.2, 0, -0.55);
  setBone(out, BONE.ARM_R_UPPER, 0.28, 0, 0.22);
  setBone(out, BONE.ARM_L_FORE, 0.75 + s * 0.25, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 0.5, 0, 0);
  setBone(out, BONE.LEG_L_UPPER, 0.03, 0, -0.05);
  setBone(out, BONE.LEG_R_UPPER, -0.03, 0, 0.05);
};

/** Two people talking: open gestures, weight on one hip. */
const poseTalk: PoseFn = (p, out) => {
  const a = p * TAU;
  const s = Math.sin(a * 1.6);
  const s2 = Math.sin(a * 2.4 + 1.0);
  setBone(out, BONE.HIPS, 0, 0.05, 0.08);
  setBone(out, BONE.CHEST, 0.03, s * 0.1, -0.03);
  setBone(out, BONE.HEAD, s2 * 0.09, s * 0.12, 0);
  setBone(out, BONE.ARM_L_UPPER, 0.5 + s * 0.22, 0, -0.42);
  setBone(out, BONE.ARM_R_UPPER, 0.42 + s2 * 0.2, 0, 0.38);
  setBone(out, BONE.ARM_L_FORE, 1.05 + s2 * 0.3, 0, 0);
  setBone(out, BONE.ARM_R_FORE, 1.0 + s * 0.3, 0, 0);
  setBone(out, BONE.LEG_L_UPPER, 0.04, 0, -0.09);
  setBone(out, BONE.LEG_R_UPPER, -0.04, 0, 0.03);
  setBone(out, BONE.LEG_L_SHIN, -0.08, 0, 0);
};

const POSES: readonly PoseFn[] = [
  poseIdle,
  poseWalk,
  poseJog,
  posePanic,
  poseDance,
  poseClap,
  poseSit,
  posePlay,
  poseVend,
  poseTalk,
];

/* ====================================================== bone texture bake */

const _bakeM = new THREE.Matrix4();
const _bakeR = new THREE.Matrix4();
const _bakeT = new THREE.Matrix4();
const _bakeE = new THREE.Euler();
const _bakeQ = new THREE.Quaternion();
const _bakeWorld: THREE.Matrix4[] = [];
for (let i = 0; i < BONE_COUNT; i++) _bakeWorld.push(new THREE.Matrix4());

/**
 * Bake every clip into a `DataTexture` of 3×4 bone matrices.
 * Row index = `clip * frames + frame`; column = `bone * 3 + row`.
 */
export function bakeBoneTexture(frames: number): THREE.DataTexture {
  const width = BONE_COUNT * 3;
  const height = CLIP_COUNT * frames;
  const data = new Float32Array(width * height * 4);
  const pose = new Float32Array(POSE_LEN);

  for (let c = 0; c < CLIP_COUNT; c++) {
    for (let f = 0; f < frames; f++) {
      pose.fill(0);
      POSES[c](f / frames, pose);

      for (let b = 0; b < BONE_COUNT; b++) {
        _bakeE.set(pose[b * 3], pose[b * 3 + 1], pose[b * 3 + 2], 'XYZ');
        _bakeQ.setFromEuler(_bakeE);
        _bakeR.makeRotationFromQuaternion(_bakeQ);
        const px = PIVOT[b * 3];
        const py = PIVOT[b * 3 + 1];
        const pz = PIVOT[b * 3 + 2];
        // M_local = T(pivot) · R · T(−pivot)
        _bakeT.makeTranslation(px, py, pz);
        _bakeM.copy(_bakeT).multiply(_bakeR);
        _bakeT.makeTranslation(-px, -py, -pz);
        _bakeM.multiply(_bakeT);
        const parent = PARENT[b];
        if (parent < 0) {
          _bakeT.makeTranslation(
            pose[BONE_COUNT * 3],
            pose[BONE_COUNT * 3 + 1],
            pose[BONE_COUNT * 3 + 2],
          );
          _bakeWorld[b].copy(_bakeT).multiply(_bakeM);
        } else {
          _bakeWorld[b].copy(_bakeWorld[parent]).multiply(_bakeM);
        }

        const e = _bakeWorld[b].elements;
        const row = c * frames + f;
        const base = (row * width + b * 3) * 4;
        // row 0 of the 3×4 matrix
        data[base] = e[0];
        data[base + 1] = e[4];
        data[base + 2] = e[8];
        data[base + 3] = e[12];
        // row 1
        data[base + 4] = e[1];
        data[base + 5] = e[5];
        data[base + 6] = e[9];
        data[base + 7] = e[13];
        // row 2
        data[base + 8] = e[2];
        data[base + 9] = e[6];
        data[base + 10] = e[10];
        data[base + 11] = e[14];
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.name = 'loco/ped-bones';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* =========================================================== geometry */

const _c = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _eu = new THREE.Euler();
const _qt = new THREE.Quaternion();

class FigureParts {
  private readonly list: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, hex: number, bone: number, mat: number): void {
    const count = geo.attributes.position.count;
    _c.setHex(hex, THREE.SRGBColorSpace);
    const col = new Float32Array(count * 3);
    const bn = new Float32Array(count);
    const mt = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
      bn[i] = bone;
      mt[i] = mat;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aBone', new THREE.BufferAttribute(bn, 1));
    geo.setAttribute('aMat', new THREE.BufferAttribute(mt, 1));
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    this.list.push(geo);
  }

  build(name: string): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list, false);
    if (!merged) throw new Error(`PedestrianModel: failed to merge "${name}"`);
    for (const g of this.list) if (g !== merged) g.dispose();
    this.list.length = 0;
    merged.name = name;
    return merged;
  }
}

function put(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    _eu.set(rx, ry, rz);
    _qt.setFromEuler(_eu);
    _m4.makeRotationFromQuaternion(_qt);
    _m4.setPosition(x, y, z);
  } else {
    _m4.makeTranslation(x, y, z);
  }
  geo.applyMatrix4(_m4);
  return geo;
}

const bx = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);

/** Limb segment: a slightly tapered capsule-ish cylinder along Y. */
function limb(rTop: number, rBot: number, len: number, seg = 5): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
}

const SHOE = 0x2a2622;
const SKIN_SHADE = 0xffffff;

/**
 * The full-detail figure. Faces −Z, feet on y = 0, ~1.72 m tall in bind pose.
 */
function buildFigure(): THREE.BufferGeometry {
  const p = new FigureParts();
  const R = RIG;

  /* --- legs --- */
  for (const side of [1, -1]) {
    const x = side * R.hipX;
    const thighBone = side > 0 ? BONE.LEG_L_UPPER : BONE.LEG_R_UPPER;
    const shinBone = side > 0 ? BONE.LEG_L_SHIN : BONE.LEG_R_SHIN;
    p.add(
      put(limb(0.088, 0.072, R.hipY - R.kneeY), x, (R.hipY + R.kneeY) * 0.5, 0),
      0xffffff,
      thighBone,
      MAT.PANTS,
    );
    p.add(
      put(limb(0.07, 0.052, R.kneeY - R.ankleY), x, (R.kneeY + R.ankleY) * 0.5, 0),
      0xffffff,
      shinBone,
      MAT.PANTS,
    );
    p.add(put(bx(0.095, 0.075, 0.235), x, 0.038, -0.045), SHOE, shinBone, MAT.BAKED);
  }

  /* --- pelvis + torso --- */
  p.add(put(bx(0.28, 0.2, 0.17), 0, R.hipY + 0.02, 0), 0xffffff, BONE.HIPS, MAT.PANTS);
  p.add(
    put(taper(0.33, R.shoulderY - R.waistY + 0.08, 0.19, 1.12), 0, (R.waistY + R.shoulderY) * 0.5 + 0.02, 0),
    0xffffff,
    BONE.CHEST,
    MAT.SHIRT,
  );
  // shoulder caps soften the box
  p.add(put(bx(0.44, 0.1, 0.19), 0, R.shoulderY - 0.01, 0), 0xf2f2f2, BONE.CHEST, MAT.SHIRT);

  /* --- arms --- */
  for (const side of [1, -1]) {
    const x = side * R.shoulderX;
    const upper = side > 0 ? BONE.ARM_L_UPPER : BONE.ARM_R_UPPER;
    const fore = side > 0 ? BONE.ARM_L_FORE : BONE.ARM_R_FORE;
    p.add(
      put(limb(0.056, 0.048, R.shoulderY - R.elbowY), x, (R.shoulderY + R.elbowY) * 0.5, 0),
      0xffffff,
      upper,
      MAT.SHIRT,
    );
    p.add(
      put(limb(0.046, 0.04, R.elbowY - 0.86), x, (R.elbowY + 0.86) * 0.5, 0),
      SKIN_SHADE,
      fore,
      MAT.SKIN,
    );
    p.add(put(bx(0.062, 0.1, 0.05), x, 0.83, 0), SKIN_SHADE, fore, MAT.SKIN);
  }

  /* --- neck + head --- */
  p.add(put(limb(0.048, 0.055, R.neckY - R.shoulderY + 0.1), 0, R.neckY - 0.05, 0), SKIN_SHADE, BONE.HEAD, MAT.SKIN);
  const head = new THREE.SphereGeometry(0.105, 7, 5);
  head.scale(0.95, 1.12, 1.02);
  p.add(put(head, 0, R.headY, 0), SKIN_SHADE, BONE.HEAD, MAT.SKIN);
  // nose so the facing direction reads at distance
  p.add(put(bx(0.03, 0.035, 0.045), 0, R.headY - 0.01, -0.1), SKIN_SHADE, BONE.HEAD, MAT.SKIN);
  // brows
  p.add(put(bx(0.085, 0.014, 0.02), 0, R.headY + 0.035, -0.095), 0xffffff, BONE.HEAD, MAT.HAIR);

  /* --- hair variants (mutually exclusive, tinted by iHair) --- */
  const crop = new THREE.SphereGeometry(0.113, 6, 4, 0, TAU, 0, 1.5);
  crop.scale(1.0, 0.92, 1.04);
  p.add(put(crop, 0, R.headY + 0.012, 0.004), 0xffffff, BONE.HEAD, MAT.HAIR_CROP);

  const afro = new THREE.SphereGeometry(0.158, 7, 5);
  afro.scale(1.0, 0.94, 1.0);
  p.add(put(afro, 0, R.headY + 0.035, 0.006), 0xffffff, BONE.HEAD, MAT.HAIR_AFRO);

  const tiedCap = new THREE.SphereGeometry(0.112, 6, 4, 0, TAU, 0, 1.4);
  p.add(put(tiedCap, 0, R.headY + 0.014, 0.004), 0xffffff, BONE.HEAD, MAT.HAIR_TIED);
  p.add(put(bx(0.1, 0.11, 0.1), 0, R.headY + 0.03, 0.115), 0xffffff, BONE.HEAD, MAT.HAIR_TIED);

  const locsCap = new THREE.SphereGeometry(0.115, 6, 4, 0, TAU, 0, 1.45);
  p.add(put(locsCap, 0, R.headY + 0.012, 0.004), 0xffffff, BONE.HEAD, MAT.HAIR_LOCS);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * TAU + 0.4;
    p.add(
      put(bx(0.03, 0.2, 0.03), Math.cos(ang) * 0.085, R.headY - 0.07, Math.sin(ang) * 0.085),
      0xffffff,
      BONE.HEAD,
      MAT.HAIR_LOCS,
    );
  }

  /* --- headwear --- */
  p.add(put(bx(0.21, 0.07, 0.21), 0, R.headY + 0.085, 0), 0xf2f2f2, BONE.HEAD, MAT.HEAD_CAP);
  p.add(put(bx(0.19, 0.02, 0.13), 0, R.headY + 0.06, -0.15), 0xe6e6e6, BONE.HEAD, MAT.HEAD_CAP);
  const brim = new THREE.CylinderGeometry(0.24, 0.26, 0.02, 10);
  p.add(put(brim, 0, R.headY + 0.065, 0), 0xe4cf9e, BONE.HEAD, MAT.HEAD_STRAW);
  p.add(put(bx(0.2, 0.1, 0.2), 0, R.headY + 0.115, 0), 0xdcc48d, BONE.HEAD, MAT.HEAD_STRAW);

  /* --- held props --- */
  // shopping bag, hanging from the right hand
  p.add(put(bx(0.15, 0.2, 0.09), -R.shoulderX, 0.7, 0.01), 0xe8e3d6, BONE.ARM_R_FORE, MAT.PROP_BAG);
  p.add(put(bx(0.15, 0.02, 0.09), -R.shoulderX, 0.81, 0.01), 0xc4302b, BONE.ARM_R_FORE, MAT.PROP_BAG);
  // pandero (hand drum) held at the waist
  const drum = new THREE.CylinderGeometry(0.145, 0.145, 0.06, 10);
  p.add(put(drum, 0.02, 1.06, -0.19, Math.PI * 0.5, 0, 0.25), 0xd8ab6a, BONE.CHEST, MAT.PROP_DRUM);
  p.add(put(bx(0.02, 0.28, 0.02), 0.02, 1.06, -0.22, 0, 0, 0.25), 0x8a5c31, BONE.CHEST, MAT.PROP_DRUM);
  // cuatro across the chest
  const bodyG = new THREE.SphereGeometry(0.15, 6, 5);
  bodyG.scale(1.0, 1.25, 0.34);
  p.add(put(bodyG, -0.06, 1.02, -0.2, 0, 0, 0.5), 0x8a5a2e, BONE.CHEST, MAT.PROP_CUATRO);
  p.add(put(bx(0.055, 0.5, 0.035), 0.16, 1.24, -0.2, 0, 0, 0.5), 0x6b4423, BONE.CHEST, MAT.PROP_CUATRO);
  // plaza stool (for the seated poses; sits under the hips)
  p.add(put(bx(0.34, 0.06, 0.32), 0, 0.44, 0.03), 0x7a5636, BONE.HIPS, MAT.PROP_STOOL);
  for (let i = 0; i < 4; i++) {
    const sx = i % 2 === 0 ? -0.14 : 0.14;
    const sz = i < 2 ? -0.11 : 0.17;
    p.add(put(bx(0.035, 0.44, 0.035), sx, 0.21, sz), 0x5f4229, BONE.HIPS, MAT.PROP_STOOL);
  }

  return p.build('pedestrian');
}

/** Chest-style tapered box: wider at the top by `topScale`. */
function taper(w: number, h: number, d: number, topScale: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * topScale);
      pos.setZ(i, pos.getZ(i) * topScale);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Distance imposter: the same rig, five boxes. Reads correctly as a walking
 * person past ~45 m and costs about a fifth of the vertex work.
 */
function buildFigureLod(): THREE.BufferGeometry {
  const p = new FigureParts();
  const R = RIG;
  for (const side of [1, -1]) {
    const x = side * R.hipX;
    const thigh = side > 0 ? BONE.LEG_L_UPPER : BONE.LEG_R_UPPER;
    p.add(put(bx(0.14, R.hipY, 0.14), x, R.hipY * 0.5, 0), 0xffffff, thigh, MAT.PANTS);
  }
  p.add(put(bx(0.3, 0.18, 0.18), 0, R.hipY + 0.03, 0), 0xffffff, BONE.HIPS, MAT.PANTS);
  p.add(put(bx(0.34, 0.46, 0.2), 0, (R.waistY + R.shoulderY) * 0.5, 0), 0xffffff, BONE.CHEST, MAT.SHIRT);
  for (const side of [1, -1]) {
    const x = side * (R.shoulderX + 0.02);
    const upper = side > 0 ? BONE.ARM_L_UPPER : BONE.ARM_R_UPPER;
    p.add(put(bx(0.08, 0.52, 0.09), x, R.shoulderY - 0.26, 0), 0xffffff, upper, MAT.SHIRT);
  }
  p.add(put(bx(0.09, 0.12, 0.1), 0, R.neckY - 0.03, 0), SKIN_SHADE, BONE.HEAD, MAT.SKIN);
  p.add(put(bx(0.19, 0.2, 0.2), 0, R.headY + 0.01, 0), SKIN_SHADE, BONE.HEAD, MAT.SKIN);
  p.add(put(bx(0.2, 0.09, 0.21), 0, R.headY + 0.09, 0.005), 0xffffff, BONE.HEAD, MAT.HAIR);
  return p.build('pedestrian-lod');
}

/* ============================================================== shaders */

const PED_PARS = /* glsl */ `
uniform sampler2D uBones;
uniform vec2 uBoneTexel;
attribute float aBone;
attribute float aMat;
attribute vec4 iAnim;
attribute vec3 iSkin;
attribute vec3 iShirt;
attribute vec3 iPants;
attribute vec3 iHair;
attribute vec3 iProp;

mat4 locoBoneAt( float row, float bone ) {
  float bxc = bone * 3.0;
  float y = ( row + 0.5 ) * uBoneTexel.y;
  vec4 r0 = texture2D( uBones, vec2( ( bxc + 0.5 ) * uBoneTexel.x, y ) );
  vec4 r1 = texture2D( uBones, vec2( ( bxc + 1.5 ) * uBoneTexel.x, y ) );
  vec4 r2 = texture2D( uBones, vec2( ( bxc + 2.5 ) * uBoneTexel.x, y ) );
  return mat4(
    r0.x, r1.x, r2.x, 0.0,
    r0.y, r1.y, r2.y, 0.0,
    r0.z, r1.z, r2.z, 0.0,
    r0.w, r1.w, r2.w, 1.0
  );
}

mat4 locoSkinMatrix() {
  mat4 a = locoBoneAt( iAnim.x, aBone );
  mat4 b = locoBoneAt( iAnim.y, aBone );
  return a * ( 1.0 - iAnim.z ) + b * iAnim.z;
}

float locoSlotVisible() {
  if ( aMat > 4.5 && aMat < 8.5 ) return step( abs( iProp.x - ( aMat - 4.0 ) ), 0.5 );
  if ( aMat > 8.5 && aMat < 10.5 ) return step( abs( iProp.y - ( aMat - 8.0 ) ), 0.5 );
  if ( aMat > 10.5 ) return step( abs( iProp.z - ( aMat - 10.0 ) ), 0.5 );
  return 1.0;
}
`;

// NOTE: vColor is vec4 under USE_COLOR_ALPHA and vec3 otherwise; always
// swizzle .rgb so this compiles either way.
const PED_COLOR = /* glsl */ `
mat4 locoSkin = locoSkinMatrix();
float locoVis = locoSlotVisible();
if ( aMat > 0.5 ) {
  if ( aMat < 1.5 ) vColor.rgb *= iSkin;
  else if ( aMat < 2.5 ) vColor.rgb *= iShirt;
  else if ( aMat < 3.5 ) vColor.rgb *= iPants;
  else if ( aMat < 4.5 ) vColor.rgb *= iHair;
  else if ( aMat > 10.5 ) vColor.rgb *= iHair;
}
`;

const PED_NORMAL = /* glsl */ `
objectNormal = mat3( locoSkin ) * objectNormal;
`;

const PED_POSITION = /* glsl */ `
transformed = ( locoSkin * vec4( transformed, 1.0 ) ).xyz * locoVis;
`;

const PED_POSITION_DEPTH = /* glsl */ `
mat4 locoSkin = locoSkinMatrix();
float locoVis = locoSlotVisible();
transformed = ( locoSkin * vec4( transformed, 1.0 ) ).xyz * locoVis;
`;

/** Patch a material (and its depth twin) with the bone-texture skinning. */
export function patchPedMaterial(
  mat: THREE.Material,
  boneTex: THREE.DataTexture,
  depth: boolean,
): void {
  const texel = new THREE.Vector2(1 / boneTex.image.width, 1 / boneTex.image.height);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uBones = { value: boneTex };
    shader.uniforms.uBoneTexel = { value: texel };
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${PED_PARS}`,
    );
    if (depth) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${PED_POSITION_DEPTH}`,
      );
    } else {
      shader.vertexShader = shader.vertexShader
        .replace('#include <color_vertex>', `#include <color_vertex>\n${PED_COLOR}`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${PED_NORMAL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${PED_POSITION}`);
    }
  };
  mat.customProgramCacheKey = () => (depth ? 'loco/ped-depth-v1' : 'loco/ped-lit-v1');
}

/* ================================================================ fleet */

/** InstancedMesh + the per-person attribute buffers. */
export class PedFleet {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  readonly triangles: number;

  private readonly anim: THREE.InstancedBufferAttribute;
  private readonly skin: THREE.InstancedBufferAttribute;
  private readonly shirt: THREE.InstancedBufferAttribute;
  private readonly pants: THREE.InstancedBufferAttribute;
  private readonly hair: THREE.InstancedBufferAttribute;
  private readonly prop: THREE.InstancedBufferAttribute;
  private cursor = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    depthMaterial: THREE.Material | null,
    capacity: number,
    name: string,
    castShadow: boolean,
  ) {
    this.capacity = capacity;
    const idx = geometry.getIndex();
    this.triangles = Math.floor((idx ? idx.count : geometry.attributes.position.count) / 3);

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = `loco/peds/${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (depthMaterial) this.mesh.customDepthMaterial = depthMaterial;

    const mk = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.anim = mk(4);
    this.skin = mk(3);
    this.shirt = mk(3);
    this.pants = mk(3);
    this.hair = mk(3);
    this.prop = mk(3);
    geometry.setAttribute('iAnim', this.anim);
    geometry.setAttribute('iSkin', this.skin);
    geometry.setAttribute('iShirt', this.shirt);
    geometry.setAttribute('iPants', this.pants);
    geometry.setAttribute('iHair', this.hair);
    geometry.setAttribute('iProp', this.prop);
  }

  begin(): void {
    this.cursor = 0;
  }

  push(
    matrix: THREE.Matrix4,
    rowA: number,
    rowB: number,
    blend: number,
    look: PedLook,
  ): boolean {
    const i = this.cursor;
    if (i >= this.capacity) return false;
    this.mesh.setMatrixAt(i, matrix);
    const an = this.anim.array as Float32Array;
    an[i * 4] = rowA;
    an[i * 4 + 1] = rowB;
    an[i * 4 + 2] = blend;
    an[i * 4 + 3] = 0;
    write3(this.skin.array as Float32Array, i, look.skin);
    write3(this.shirt.array as Float32Array, i, look.shirt);
    write3(this.pants.array as Float32Array, i, look.pants);
    write3(this.hair.array as Float32Array, i, look.hair);
    const pr = this.prop.array as Float32Array;
    pr[i * 3] = look.heldProp;
    pr[i * 3 + 1] = look.headProp;
    pr[i * 3 + 2] = look.hairStyle;
    this.cursor++;
    return true;
  }

  end(): void {
    this.mesh.count = this.cursor;
    if (this.cursor > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.anim.needsUpdate = true;
      this.skin.needsUpdate = true;
      this.shirt.needsUpdate = true;
      this.pants.needsUpdate = true;
      this.hair.needsUpdate = true;
      this.prop.needsUpdate = true;
    }
  }

  get count(): number {
    return this.cursor;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
  }
}

function write3(dst: Float32Array, i: number, c: THREE.Color): void {
  dst[i * 3] = c.r;
  dst[i * 3 + 1] = c.g;
  dst[i * 3 + 2] = c.b;
}

/* ================================================================= look */

/** Everything that makes one person visually distinct. */
export class PedLook {
  readonly skin = new THREE.Color();
  readonly shirt = new THREE.Color();
  readonly pants = new THREE.Color();
  readonly hair = new THREE.Color();
  /** 0 = nothing, 1 bag, 2 pandero, 3 cuatro, 4 stool */
  heldProp = 0;
  /** 0 = nothing, 1 cap, 2 straw hat */
  headProp = 0;
  /** 1 crop, 2 afro, 3 tied back, 4 locs */
  hairStyle = 1;
  /** overall scale — children are smaller, adults vary ±7 % */
  scale = 1;

  /**
   * Roll a person. `role` nudges wardrobe (uniforms for kids, guayabera for
   * elders) but **never** skin tone: melanin is sampled uniformly across the
   * whole ramp for everyone, exactly as ART_REFERENCE §7.2 requires.
   */
  randomise(rng: RNG, role: PedRole): void {
    // continuous melanin ramp: pick a position, then lerp between neighbours
    const f = rng.next() * (SKIN_RAMP.length - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(SKIN_RAMP.length - 1, i0 + 1);
    this.skin.setHex(SKIN_RAMP[i0], THREE.SRGBColorSpace);
    _c.setHex(SKIN_RAMP[i1], THREE.SRGBColorSpace);
    this.skin.lerp(_c, f - i0);

    const grey = rng.next() < (role === 'elder' ? 0.62 : 0.08);
    this.hair.setHex(
      grey ? HAIR_COLORS[8 + rng.int(0, 2)] : rng.pick(HAIR_COLORS),
      THREE.SRGBColorSpace,
    );
    this.hairStyle = 1 + rng.int(0, 3);

    switch (role) {
      case 'kid':
        this.shirt.setHex(rng.pick(UNIFORM_SHIRT), THREE.SRGBColorSpace);
        this.pants.setHex(rng.pick(UNIFORM_PANTS), THREE.SRGBColorSpace);
        this.scale = 0.7 + rng.next() * 0.1;
        this.headProp = rng.next() < 0.22 ? 1 : 0;
        break;
      case 'elder':
        this.shirt.setHex(rng.pick(GUAYABERA), THREE.SRGBColorSpace);
        this.pants.setHex(rng.pick(PANTS_COLORS), THREE.SRGBColorSpace);
        this.scale = 0.94 + rng.next() * 0.05;
        this.headProp = rng.next() < 0.45 ? 2 : 0;
        break;
      case 'tourist':
        this.shirt.setHex(rng.pick(SHIRT_COLORS), THREE.SRGBColorSpace);
        this.pants.setHex(rng.pick(PANTS_COLORS), THREE.SRGBColorSpace);
        this.scale = 0.95 + rng.next() * 0.12;
        this.headProp = rng.next() < 0.55 ? (rng.bool() ? 1 : 2) : 0;
        break;
      default:
        this.shirt.setHex(rng.pick(SHIRT_COLORS), THREE.SRGBColorSpace);
        this.pants.setHex(rng.pick(PANTS_COLORS), THREE.SRGBColorSpace);
        this.scale = 0.93 + rng.next() * 0.14;
        this.headProp = rng.next() < 0.18 ? (rng.bool() ? 1 : 2) : 0;
        break;
    }
    this.heldProp = 0;
  }
}

export type PedRole =
  | 'walker'
  | 'shopper'
  | 'tourist'
  | 'kid'
  | 'elder'
  | 'jogger'
  | 'dancer'
  | 'clapper'
  | 'musician'
  | 'vendor'
  | 'sitter'
  | 'talker';

/* ================================================================== kit */

export class PedestrianKit {
  readonly group = new THREE.Group();
  readonly boneTexture: THREE.DataTexture;
  readonly material: THREE.MeshStandardMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  readonly high: PedFleet;
  readonly low: PedFleet;
  readonly frames: number;

  /** Vendor carts — static street furniture, one instanced mesh. */
  readonly carts: THREE.InstancedMesh;
  private readonly cartMaterial: THREE.MeshStandardMaterial;

  constructor(capacity: number, cartCapacity: number, castShadow: boolean) {
    this.group.name = 'loco/peds';
    this.frames = PED_ANIM.frames;
    this.boneTexture = bakeBoneTexture(this.frames);

    this.material = new THREE.MeshStandardMaterial({
      name: 'loco/ped',
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.0,
    });
    patchPedMaterial(this.material, this.boneTexture, false);
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchPedMaterial(this.depthMaterial, this.boneTexture, true);

    this.high = new PedFleet(
      buildFigure(),
      this.material,
      this.depthMaterial,
      capacity,
      'high',
      castShadow,
    );
    this.low = new PedFleet(
      buildFigureLod(),
      this.material,
      this.depthMaterial,
      capacity,
      'low',
      false,
    );
    this.group.add(this.high.mesh);
    this.group.add(this.low.mesh);

    this.cartMaterial = new THREE.MeshStandardMaterial({
      name: 'loco/ped-cart',
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.05,
    });
    this.carts = new THREE.InstancedMesh(buildVendorCart(), this.cartMaterial, cartCapacity);
    this.carts.name = 'loco/peds/carts';
    this.carts.count = 0;
    this.carts.castShadow = castShadow;
    this.carts.receiveShadow = true;
    this.carts.frustumCulled = false;
    this.group.add(this.carts);
  }

  /**
   * Convert a clip + normalised phase into the two texture rows and the blend
   * between them.
   */
  rows(clip: number, phase: number, out: Float32Array): void {
    const f = phase * this.frames;
    const fa = Math.floor(f) % this.frames;
    const fb = (fa + 1) % this.frames;
    out[0] = clip * this.frames + fa;
    out[1] = clip * this.frames + fb;
    out[2] = f - Math.floor(f);
  }

  beginFrame(): void {
    this.high.begin();
    this.low.begin();
  }

  endFrame(): void {
    this.high.end();
    this.low.end();
  }

  get liveTriangles(): number {
    return this.high.triangles * this.high.count + this.low.triangles * this.low.count;
  }

  get drawCalls(): number {
    let n = 0;
    if (this.high.count > 0) n++;
    if (this.low.count > 0) n++;
    if (this.carts.count > 0) n++;
    return n;
  }

  setCastShadow(on: boolean): void {
    this.high.mesh.castShadow = on;
    this.carts.castShadow = on;
  }

  dispose(): void {
    this.high.dispose();
    this.low.dispose();
    this.carts.geometry.dispose();
    this.carts.removeFromParent();
    this.cartMaterial.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.boneTexture.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* --------------------------------------------------------- vendor cart */

/**
 * A piragüero's shaved-ice cart: bright paint, a striped umbrella and a row of
 * syrup bottles (tamarindo, coco, frambuesa). One of the most recognisable
 * things on a San Juan street corner.
 */
function buildVendorCart(): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  const push = (geo: THREE.BufferGeometry, hex: number): void => {
    const n = geo.attributes.position.count;
    _c.setHex(hex, THREE.SRGBColorSpace);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    list.push(geo);
  };

  push(put(bx(1.05, 0.5, 0.62), 0, 0.78, 0), CART_PAINT[0]);
  push(put(bx(1.1, 0.07, 0.68), 0, 1.06, 0), 0xf4f2ea);
  push(put(bx(1.02, 0.12, 0.6), 0, 0.5, 0), CART_PAINT[2]);
  // wheels
  for (const sx of [-1, 1]) {
    const w = new THREE.CylinderGeometry(0.24, 0.24, 0.06, 10);
    w.rotateZ(Math.PI / 2);
    push(put(w, sx * 0.5, 0.24, 0.1), 0x2a2a2a);
  }
  // handle
  push(put(bx(0.05, 0.05, 0.5), -0.44, 1.02, -0.5), 0x6b4a2f);
  push(put(bx(0.05, 0.05, 0.5), 0.44, 1.02, -0.5), 0x6b4a2f);
  push(put(bx(0.94, 0.05, 0.05), 0, 1.02, -0.74), 0x6b4a2f);
  // syrup bottles
  for (let i = 0; i < 5; i++) {
    const b = new THREE.CylinderGeometry(0.045, 0.045, 0.24, 6);
    push(put(b, -0.36 + i * 0.18, 1.21, 0.16), i % 3 === 0 ? 0xc4302b : i % 3 === 1 ? 0xf2b134 : 0x7a3f9e);
  }
  // ice block + scraper
  push(put(bx(0.3, 0.22, 0.3), 0.3, 1.19, -0.14), 0xdfeef5);
  // umbrella
  push(put(bx(0.05, 1.3, 0.05), 0, 1.75, 0.02), 0x8a8f94);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * TAU;
    const seg = new THREE.BoxGeometry(0.72, 0.04, 0.2);
    seg.translate(0.36, 0, 0);
    seg.rotateY(-a0);
    push(put(seg, 0, 2.38, 0.02, 0, 0, 0), i % 2 === 0 ? CART_PAINT[0] : 0xf6f4ee);
  }
  push(put(bx(0.12, 0.1, 0.12), 0, 2.46, 0.02), CART_PAINT[2]);

  const merged = mergeGeometries(list, false);
  if (!merged) throw new Error('PedestrianModel: failed to merge vendor cart');
  for (const g of list) if (g !== merged) g.dispose();
  merged.name = 'vendor-cart';
  return merged;
}
