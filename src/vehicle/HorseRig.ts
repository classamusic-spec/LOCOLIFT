/**
 * Loco Lift — the horse.
 *
 * One dapple-grey Paso Fino in full driving harness, built out of code and
 * animated procedurally: a walk, a trot, a canter and a gallop that blend by
 * speed, with the real footfall sequences, a head that nods with the stride,
 * a tail that sways, a mane that travels, and a body that rises and falls.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * A hoof that is on the ground does not move. Every other cheat in an arcade
 * game is forgivable; a skating horse is not, and it is the single thing that
 * separates an animal from a toy.
 *
 * So the stride phase is **not driven by a clock**. `update()` is handed the
 * signed ground distance the rig actually travelled since the last frame, and
 * advances the cycle by `distance / strideLength`. During stance a hoof's
 * longitudinal offset is then, exactly,
 *
 *     z(p) = stride · duty · (p/duty − ½)          p ∈ [0, duty)
 *
 * whose derivative with respect to phase is `stride`, and since phase advances
 * at `v / stride` the hoof travels backwards through the body at exactly `v`
 * while the body travels forwards at exactly `v`. The two cancel identically,
 * at every speed, in every gait, forwards or backwards, and — because the
 * distance is *measured* rather than integrated from a velocity — through gait
 * blends, turns, skids and boost surges as well. There is no tuning constant
 * that can break it.
 *
 * The same discipline is applied sideways: the body's lateral sway and roll
 * would otherwise drag the planted hooves with them, so each supporting leg
 * abducts by exactly the angle that cancels its pivot's lateral travel.
 *
 * COST
 * ----
 * Nothing here rebuilds geometry. Every frame writes a couple of dozen
 * rotation scalars onto a skeleton of `THREE.Group`s that was built once: four
 * two-bone analytic IK solves, a handful of sines, zero allocation.
 *
 * DEPICTION
 * ---------
 * The animal is never shown being hurt, struck or driven down. `shy()` is a
 * startle — head up, ears back, a flinch and a check — and it recovers within
 * the second. There is no whip anywhere in this file or the next one.
 * See `docs/ART_REFERENCE.md` §7.
 *
 * Rig space: origin on the road under the middle of the barrel, +Y up,
 * −Z forward, +X right. Leg indices match the gait tables:
 *   0 = fore-left, 1 = fore-right, 2 = hind-left, 3 = hind-right.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { GAITS, GAIT_BANDS, HORSE_GEO as H, type Gait } from './CarriageTuning';

/* ========================================================== small geometry */

/** Accumulates geometry for one material, then merges it into one mesh. */
class Shell {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
  }

  /** Add `geo` and its mirror across the YZ plane — the animal is symmetric. */
  addMirrored(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
    this.parts.push(mirrorX(geo.clone()));
  }

  build(): THREE.BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) return null;
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Mirror a geometry across X in place, fixing winding and normals. */
function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.scale(-1, 1, 1);
  const idx = g.getIndex();
  if (idx) {
    const arr = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i];
      arr[i] = arr[i + 2];
      arr[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
  const nrm = g.getAttribute('normal');
  if (nrm) {
    for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
    nrm.needsUpdate = true;
  }
  return g;
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** Cylinder with its axis along `axis`, centred at (x,y,z). */
function cyl(
  rTop: number,
  rBot: number,
  len: number,
  seg: number,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z',
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * One cross-section of a lofted mass: a superelliptical ring at `z`, centred on
 * `cy`, `hw` half-wide, running from `cy − hd` to `cy + hu`. `power` bends the
 * profile from a diamond (1) through an ellipse (2) to a rounded box.
 */
interface Section {
  z: number;
  cy: number;
  hw: number;
  hu: number;
  hd: number;
  power?: number;
}

/**
 * Loft a tube through a list of cross-sections. This is what makes a horse read
 * as an animal instead of a stack of capsules: every mass — barrel, neck, head,
 * quarters, every limb segment — is a swept surface with a controlled profile.
 * UVs run u = around, v = along, so the dapple texture wraps naturally.
 */
function loft(
  sections: readonly Section[],
  ring: number,
  capFront = true,
  capBack = true,
): THREE.BufferGeometry {
  const n = sections.length;
  const verts = new Float32Array(n * ring * 3);
  const uvs = new Float32Array(n * ring * 2);
  let p = 0;
  let q = 0;
  for (let s = 0; s < n; s++) {
    const sec = sections[s];
    const e = 2 / (sec.power ?? 2.2);
    for (let i = 0; i < ring; i++) {
      const t = (i / ring) * Math.PI * 2;
      const c = Math.cos(t);
      const si = Math.sin(t);
      const x = sec.hw * Math.sign(si) * Math.pow(Math.abs(si), e);
      const yr = Math.sign(c) * Math.pow(Math.abs(c), e);
      verts[p++] = x;
      verts[p++] = sec.cy + (yr >= 0 ? sec.hu * yr : sec.hd * yr);
      verts[p++] = sec.z;
      uvs[q++] = i / ring;
      uvs[q++] = s / (n - 1);
    }
  }

  const quads = (n - 1) * ring;
  const capTris = (capFront ? ring - 2 : 0) + (capBack ? ring - 2 : 0);
  const index = new Uint16Array(quads * 6 + capTris * 3);
  let k = 0;
  for (let s = 0; s < n - 1; s++) {
    for (let i = 0; i < ring; i++) {
      const a = s * ring + i;
      const b = s * ring + ((i + 1) % ring);
      const c = (s + 1) * ring + i;
      const d = (s + 1) * ring + ((i + 1) % ring);
      index[k++] = a;
      index[k++] = c;
      index[k++] = b;
      index[k++] = b;
      index[k++] = c;
      index[k++] = d;
    }
  }
  if (capFront) {
    for (let i = 1; i < ring - 1; i++) {
      index[k++] = 0;
      index[k++] = i + 1;
      index[k++] = i;
    }
  }
  if (capBack) {
    const o = (n - 1) * ring;
    for (let i = 1; i < ring - 1; i++) {
      index[k++] = o;
      index[k++] = o + i;
      index[k++] = o + i + 1;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * A limb segment: a tapered, front-to-back-deep tube running DOWN from the
 * origin along −Y, which is the convention every bone node in this rig uses.
 * `bulge` adds a muscle swell to the upper third.
 */
function limb(
  len: number,
  wTop: number,
  dTop: number,
  wBot: number,
  dBot: number,
  seg = 8,
  bulge = 0,
): THREE.BufferGeometry {
  const rows = bulge > 0 ? 4 : 2;
  const secs: Section[] = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const b = bulge * Math.sin(Math.PI * Math.min(1, t * 1.5)) * (1 - t * 0.8);
    secs.push({
      z: -len * t,
      cy: 0,
      hw: lerp(wTop, wBot, t) + b * 0.5,
      hu: lerp(dTop, dBot, t) + b,
      hd: lerp(dTop, dBot, t) + b * 0.6,
      power: 2.1,
    });
  }
  const g = loft(secs, seg);
  /* the loft runs along −Z; rotateX(−90°) maps −Z → −Y */
  g.rotateX(-Math.PI / 2);
  return g;
}

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const tubeA = /* @__PURE__ */ new THREE.Vector3();
const tubeB = /* @__PURE__ */ new THREE.Vector3();
const tubeDir = /* @__PURE__ */ new THREE.Vector3();
const tubeQ = /* @__PURE__ */ new THREE.Quaternion();
const tubeM = /* @__PURE__ */ new THREE.Matrix4();
const tubeS = /* @__PURE__ */ new THREE.Vector3(1, 1, 1);

/** A capped tube from a to b — every strap of the harness is one of these. */
function strap(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  seg = 6,
): THREE.BufferGeometry {
  tubeA.set(ax, ay, az);
  tubeB.set(bx, by, bz);
  tubeDir.subVectors(tubeB, tubeA);
  const len = tubeDir.length();
  const g = new THREE.CylinderGeometry(radius, radius, Math.max(1e-3, len), seg, 1, false);
  if (len > 1e-5) {
    tubeDir.multiplyScalar(1 / len);
    tubeQ.setFromUnitVectors(UP, tubeDir);
    tubeA.add(tubeB).multiplyScalar(0.5);
    tubeM.compose(tubeA, tubeQ, tubeS);
    g.applyMatrix4(tubeM);
  }
  return g;
}

/* ---------------------------------------------------------------- textures */

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * A dapple-grey coat: soft light rings on a pale ground, with a darker topline
 * and a fine flea-bitten speckle. Between them those are the two things that
 * make a grey horse read as a grey horse rather than as a white one.
 */
function makeCoatTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#dedcd8';
  g.fillRect(0, 0, 256, 256);

  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(146,146,152,0.34)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(255,255,255,0.2)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);

  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      const x = gx * 28 + rnd() * 18 + 4;
      const y = gy * 28 + rnd() * 18 + 4;
      const r = 8 + rnd() * 5;
      const ring = g.createRadialGradient(x, y, r * 0.15, x, y, r);
      ring.addColorStop(0, 'rgba(255,255,255,0.30)');
      ring.addColorStop(0.62, 'rgba(255,255,255,0.10)');
      ring.addColorStop(0.86, 'rgba(122,122,130,0.32)');
      ring.addColorStop(1, 'rgba(122,122,130,0)');
      g.fillStyle = ring;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  for (let i = 0; i < 900; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    g.fillStyle = rnd() > 0.5 ? 'rgba(118,116,122,0.17)' : 'rgba(255,255,255,0.17)';
    g.fillRect(x, y, 1.4, 1.4);
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/* ================================================================= the rig */

/** One leg's skeleton and its solved state. */
interface Leg {
  readonly x: number;
  readonly pivotY: number;
  readonly pivotZ: number;
  readonly neutralZ: number;
  readonly upper: number;
  readonly lower: number;
  readonly cannon: number;
  /** +1 = middle joint leads forward (hind stifle), −1 = trails back (fore elbow) */
  readonly bend: number;
  /** how much the cannon follows the pivot→hoof line, 0..1 */
  readonly follow: number;
  /** fixed rake added to the cannon angle — the hind leg's zigzag */
  readonly rake: number;
  readonly isFore: boolean;

  readonly root: THREE.Group;
  readonly mid: THREE.Group;
  readonly foot: THREE.Group;

  /** solved hoof position in rig space; the contact test reads this */
  readonly hoof: THREE.Vector3;
  /** 0..1 position in the stride cycle */
  phase: number;
  grounded: boolean;
}

const AXIS_X = /* @__PURE__ */ new THREE.Vector3(1, 0, 0);
const AXIS_Y = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const AXIS_Z = /* @__PURE__ */ new THREE.Vector3(0, 0, 1);

export class HorseRig {
  /** rig root; y = 0 is the road under the horse */
  readonly object3d = new THREE.Group();

  /** everything that bobs, pitches and sways with the stride */
  private readonly body = new THREE.Group();

  private readonly legs: Leg[] = [];

  private readonly neckLow = new THREE.Group();
  private readonly neckUp = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly earL = new THREE.Group();
  private readonly earR = new THREE.Group();
  private readonly nostrils = new THREE.Group();
  private readonly tail: THREE.Group[] = [];
  private readonly mane: THREE.Group[] = [];

  /* --- materials, held by name because the builders all want them --- */
  private readonly matCoat: THREE.MeshStandardMaterial;
  private readonly matPoints: THREE.MeshStandardMaterial;
  private readonly matHair: THREE.MeshStandardMaterial;
  private readonly matHarness: THREE.MeshStandardMaterial;
  private readonly matBrass: THREE.MeshStandardMaterial;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];

  /* ------------------------------------------------------------ animation */

  /** stride cycle position, 0..1, advanced by measured ground distance */
  private cycle = 0;
  /** 0..3 gait axis: 0 walk, 1 trot, 2 canter, 3 gallop */
  private gaitAxis = 0;

  /** the blended gait actually being played this frame */
  private readonly g = {
    stride: GAITS[0].stride,
    duty: GAITS[0].duty,
    offsets: [0, 0, 0, 0] as [number, number, number, number],
    lift: GAITS[0].lift,
    fold: GAITS[0].fold,
    bobAmp1: 0,
    bobAmp2: GAITS[0].bobAmp,
    bobPhase: GAITS[0].bobPhase,
    pitchAmp: GAITS[0].pitchAmp,
    swayAmp: GAITS[0].swayAmp,
    nodAmp: GAITS[0].nodAmp,
    headReach: 0,
    tailAmp: GAITS[0].tailAmp,
    tailLift: 0,
  };

  private bob = 0;
  private bodyPitch = 0;
  private bodyRoll = 0;
  private bodySway = 0;

  /* --- personality: one-shot reactions, all decaying --- */
  private toss = 0;
  private snortT = 0;
  private shyT = 0;
  private shySide = 1;
  private earFlick = 0;
  private earTimer = 2.5;
  private idle = 0;
  private effort = 0;
  private braced = 0;
  private headYawSmoothed = 0;
  private airborne = 0;

  /* --- scratch; update() allocates nothing --- */
  private readonly footZ = [0, 0, 0, 0];
  private readonly footY = [0, 0, 0, 0];
  private readonly tmpV = new THREE.Vector3();
  private readonly bodyPos = new THREE.Vector3();
  private readonly bodyQuat = new THREE.Quaternion();
  private readonly bodyQuatInv = new THREE.Quaternion();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();
  private readonly pivot = new THREE.Vector3(0, H.pitchPivotY, H.pitchPivotZ);

  private detailLevel: QualityTier = 'high';

  constructor(quality: QualityTier = 'high') {
    this.object3d.name = 'horse';
    this.object3d.add(this.body);

    const low = quality === 'low';
    const ring = low ? 10 : 14;

    /* ---------------------------------------------------------- materials */
    const coatTex = makeCoatTexture();
    if (coatTex) {
      coatTex.repeat.set(2, 1);
      this.textures.push(coatTex);
    }
    this.matCoat = new THREE.MeshStandardMaterial({
      color: H.coat,
      map: coatTex ?? null,
      metalness: 0,
      roughness: 0.72,
    });
    this.materials.push(this.matCoat);

    this.matPoints = this.mat(H.points, 0.05, 0.58);
    this.matHair = this.mat(H.hair, 0.02, 0.5);
    this.matHarness = this.mat(H.harness, 0.16, 0.42);
    this.matBrass = this.mat(H.harnessBrass, 0.92, 0.28);
    const matMuzzle = this.mat(H.muzzle, 0.02, 0.66);
    const matEye = this.mat(H.eye, 0.35, 0.18);
    const matCollar = this.mat(H.collar, 0.08, 0.6);
    const matHoof = this.mat(H.hoofColor, 0.12, 0.44);

    /* ------------------------------------------------------------- shells */
    const coat = new Shell();
    const hair = new Shell();
    const harness = new Shell();
    const brass = new Shell();

    this.buildBarrel(coat, ring);
    this.buildNeck(coat, ring, low);
    this.buildHead(matEye, matMuzzle, low);
    this.buildLegs(matHoof, low);
    this.buildTail(low);
    this.buildHarness(harness, brass, matCollar);

    this.emit(coat.build(), this.matCoat, 'coat', this.body);
    this.emit(hair.build(), this.matHair, 'hair', this.body);
    this.emit(harness.build(), this.matHarness, 'harness', this.body);
    this.emit(brass.build(), this.matBrass, 'brass', this.body);

    this.setQuality(quality);

    this.object3d.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
    });

    /* settle into a standing pose before the first frame is ever drawn */
    this.blendGait(0);
    this.solve(1 / 60);
  }

  /* ============================================================ public API */

  /**
   * Advance the animal.
   *
   * @param dt           seconds
   * @param groundDist   signed metres the rig travelled along its own forward
   *                     axis since the last call. THIS, not `speed`, drives the
   *                     stride — see the note at the top of the file.
   * @param speed        |ground speed|, m/s, for choosing the gait
   * @param effort       0..1 gallop demand (the boost)
   * @param braking      0..1
   * @param groundedFrac 0..1 of the carriage's wheels that found road
   */
  update(
    dt: number,
    groundDist: number,
    speed: number,
    effort: number,
    braking: number,
    groundedFrac: number,
  ): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const v = Number.isFinite(speed) ? Math.min(Math.abs(speed), 40) : 0;
    const e = clamp01(effort);
    this.effort = damp(this.effort, e, 6, dt);
    this.braced = damp(this.braced, clamp01(braking), 7, dt);
    this.airborne = damp(this.airborne, 1 - clamp01(groundedFrac), 8, dt);
    this.idle += dt;

    /* --- which gait, and blend the two either side of it ---------------- */
    /* gaits are sticky: the axis chases rather than snapping, which is what
     * keeps the stride continuous through a transition */
    this.gaitAxis = damp(this.gaitAxis, gaitAxisFor(v, e), 3.4, dt);
    this.blendGait(this.gaitAxis);

    /* --- advance the cycle by MEASURED ground distance ------------------ */
    let d = Number.isFinite(groundDist) ? groundDist : 0;
    /* a teleport or a respawn is not a stride */
    if (Math.abs(d) > 2.5) d = 0;
    this.cycle += d / this.g.stride;
    /* a standing horse still shifts its weight, very slowly */
    if (Math.abs(d) < 1e-4) this.cycle += dt * 0.05;
    this.cycle -= Math.floor(this.cycle);

    /* --- reactions decay ------------------------------------------------ */
    this.toss = Math.max(0, this.toss - dt * 1.7);
    this.snortT = Math.max(0, this.snortT - dt * 2.2);
    this.shyT = Math.max(0, this.shyT - dt * 1.15);
    this.earFlick = Math.max(0, this.earFlick - dt * 3.2);
    this.earTimer -= dt;
    if (this.earTimer <= 0) {
      this.earTimer = 2.2 + ((this.idle * 7919) % 3.4);
      this.earFlick = 1;
    }

    this.solve(dt);
  }

  /** Hoof `i` in rig-local space. The contact test reads this. */
  hoof(i: number, out: THREE.Vector3): THREE.Vector3 {
    const leg = this.legs[i];
    return leg ? out.copy(leg.hoof) : out.set(0, 0, 0);
  }

  /** True while hoof `i` is bearing weight. */
  hoofGrounded(i: number): boolean {
    return this.legs[i]?.grounded ?? false;
  }

  /**
   * Where the rein ring on the bit is, in rig-local space. `side` is +1 for
   * the horse's right, −1 for its left.
   *
   * Every frame this is somewhere different: the head nods with the gait, the
   * neck rises with the reach, the whole body pitches and bobs. Anything that
   * has to *stay attached* to the bridle — the reins, most obviously — has to
   * ask rather than assume, so the anchor is derived by walking the same node
   * chain the mesh hangs off (body → neckLow → neckUp → head) rather than
   * being re-derived from the gait parameters, which could disagree.
   *
   * The offsets match the brass rein rings in `buildHead`. `updateMatrix` is
   * explicit because Three only composes a node's local matrix during a render
   * traversal, and callers legitimately want this before one has happened.
   */
  bitAnchor(side: number, out: THREE.Vector3): THREE.Vector3 {
    this.head.updateMatrix();
    this.neckUp.updateMatrix();
    this.neckLow.updateMatrix();
    this.body.updateMatrix();
    return out
      .set(side >= 0 ? 0.088 : -0.088, -0.114, -0.362)
      .applyMatrix4(this.head.matrix)
      .applyMatrix4(this.neckUp.matrix)
      .applyMatrix4(this.neckLow.matrix)
      .applyMatrix4(this.body.matrix);
  }

  /** How far the body sits above its rest height right now, metres. */
  get bodyLift(): number {
    return this.bob;
  }

  /** 0..1 how hard the animal is working — dust, audio, and the driver's pose. */
  get exertion(): number {
    return clamp01(this.gaitAxis / 3);
  }

  /** The gait being played, for a HUD or for audio. */
  get gaitName(): string {
    return GAITS[Math.round(clamp(this.gaitAxis, 0, GAITS.length - 1))].name;
  }

  /** Strides per second at `speed` — a hoofbeat clock for anyone who wants it. */
  strideRate(speed: number): number {
    return Math.abs(speed) / Math.max(0.2, this.g.stride);
  }

  /** Head up, ears forward — the driver has called out or rung the bell. */
  headToss(strength = 1): void {
    this.toss = Math.max(this.toss, clamp01(strength));
    this.earFlick = 1;
  }

  /** A hard blow out through the nose as the horse is pulled up. */
  snort(strength = 1): void {
    this.snortT = Math.max(this.snortT, clamp01(strength));
  }

  /**
   * A startle: head up, ears back, a flinch away and a check in the stride.
   * Never an injury — this is a horse noticing something and getting over it.
   */
  shy(strength = 1, side = 0): void {
    const s = clamp01(strength);
    if (s <= this.shyT) return;
    this.shyT = s;
    this.shySide = side >= 0 ? 1 : -1;
    this.earFlick = 1;
  }

  setQuality(tier: QualityTier): void {
    this.detailLevel = tier;
    const showMane = tier !== 'low';
    for (const m of this.mane) m.visible = showMane;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.object3d.clear();
  }

  /* ========================================================= the animation */

  /** Interpolate the two gaits either side of `axis` into `this.g`. */
  private blendGait(axis: number): void {
    const a = clamp(axis, 0, GAITS.length - 1);
    const i0 = Math.min(GAITS.length - 2, Math.floor(a));
    const t = clamp01(a - i0);
    const A: Gait = GAITS[i0];
    const B: Gait = GAITS[i0 + 1];
    const g = this.g;

    g.stride = lerp(A.stride, B.stride, t);
    g.duty = lerp(A.duty, B.duty, t);
    for (let i = 0; i < 4; i++) g.offsets[i] = lerpPhase(A.offsets[i], B.offsets[i], t);
    g.lift = lerp(A.lift, B.lift, t);
    g.fold = lerp(A.fold, B.fold, t);

    /* the two bob harmonics blend as separate amplitudes rather than as a
     * frequency: crossfading a frequency is what makes procedural gait
     * transitions look like a tape being scrubbed */
    g.bobAmp1 =
      (A.bobHarmonic === 1 ? A.bobAmp * (1 - t) : 0) + (B.bobHarmonic === 1 ? B.bobAmp * t : 0);
    g.bobAmp2 =
      (A.bobHarmonic === 2 ? A.bobAmp * (1 - t) : 0) + (B.bobHarmonic === 2 ? B.bobAmp * t : 0);
    g.bobPhase = lerpPhase(A.bobPhase, B.bobPhase, t);
    g.pitchAmp = lerp(A.pitchAmp, B.pitchAmp, t);
    g.swayAmp = lerp(A.swayAmp, B.swayAmp, t);
    g.nodAmp = lerp(A.nodAmp, B.nodAmp, t);
    g.headReach = lerp(A.headReach, B.headReach, t);
    g.tailAmp = lerp(A.tailAmp, B.tailAmp, t);
    g.tailLift = lerp(A.tailLift, B.tailLift, t);
  }

  /**
   * Place the feet, move the body, solve every joint. This is the whole
   * animation; it runs once a frame and touches nothing but scalars.
   */
  private solve(dt: number): void {
    const g = this.g;
    const TAU = Math.PI * 2;
    const half = g.stride * g.duty * 0.5;

    /* --------------------------------------------- 1. the feet, rig space */
    for (let i = 0; i < 4; i++) {
      const leg = this.legs[i];
      let p = this.cycle + g.offsets[i];
      p -= Math.floor(p);
      leg.phase = p;

      if (p < g.duty) {
        /* STANCE. The identity that makes the hoof stand still: the offset is
         * linear in phase with slope `stride`, and phase advances at v/stride. */
        this.footZ[i] = half * ((2 * p) / g.duty - 1);
        this.footY[i] = 0;
        leg.grounded = true;
      } else {
        /* SWING. Ease the recovery, lift on a flattened arc with the peak
         * biased early — a horse snaps the leg up and floats it forward. */
        const u = (p - g.duty) / (1 - g.duty);
        this.footZ[i] = half * (1 - 2 * smoothstep(u));
        const arc = Math.sin(Math.PI * Math.pow(u, 0.82));
        this.footY[i] = g.lift * arc * arc * (leg.isFore ? 1 : 0.92);
        leg.grounded = false;
      }
    }

    /* off the ground the animal tucks up rather than pawing at nothing */
    if (this.airborne > 0.01) {
      for (let i = 0; i < 4; i++) {
        const fore = this.legs[i].isFore;
        this.footY[i] = lerp(this.footY[i], fore ? 0.24 : 0.18, this.airborne);
        this.footZ[i] = lerp(this.footZ[i], fore ? -0.1 : 0.12, this.airborne * 0.8);
        this.legs[i].grounded = false;
      }
    }

    /* ------------------------------------------------- 2. the body's mass */
    const c = this.cycle * TAU;
    const shy = this.shyT * this.shyT;
    this.bob =
      g.bobAmp1 * Math.sin(c + g.bobPhase * TAU) +
      g.bobAmp2 * Math.sin(2 * c + g.bobPhase * TAU) +
      shy * 0.035 -
      this.braced * 0.012;
    this.bodyPitch = g.pitchAmp * Math.sin(c + 0.25 * TAU) - this.braced * 0.07 + shy * 0.1;
    this.bodySway = g.swayAmp * Math.sin(c) + shy * 0.055 * this.shySide;
    this.bodyRoll = -g.swayAmp * 0.85 * Math.sin(c) - shy * 0.085 * this.shySide;

    /* Rotate the body about a pivot inside the barrel rather than about the
     * road, or a degree of pitch swings the whole animal 2 cm fore and aft. */
    this.qA.setFromAxisAngle(AXIS_X, this.bodyPitch);
    this.qB.setFromAxisAngle(AXIS_Z, this.bodyRoll);
    this.bodyQuat.copy(this.qB).multiply(this.qA);
    this.qA.setFromAxisAngle(AXIS_Y, shy * 0.11 * this.shySide);
    this.bodyQuat.multiply(this.qA);
    this.bodyQuatInv.copy(this.bodyQuat).invert();

    this.tmpV.copy(this.pivot).applyQuaternion(this.bodyQuat);
    this.bodyPos
      .set(this.bodySway, this.bob, 0)
      .add(this.pivot)
      .sub(this.tmpV);
    this.body.position.copy(this.bodyPos);
    this.body.quaternion.copy(this.bodyQuat);

    /* ------------------------------------------------------ 3. leg solves */
    for (let i = 0; i < 4; i++) {
      const leg = this.legs[i];
      /* the hoof target lives in RIG space and must not move with the body */
      leg.hoof.set(leg.x, this.footY[i], leg.neutralZ + this.footZ[i]);
      /* pull it into body space, which is where the pivots are */
      this.tmpV.copy(leg.hoof).sub(this.bodyPos).applyQuaternion(this.bodyQuatInv);
      this.solveLeg(leg, this.tmpV.x, this.tmpV.y, this.tmpV.z, g.fold);
    }

    /* --------------------------------------------------- 4. neck and head */
    const nod = g.nodAmp * Math.sin(c + 0.15 * TAU);
    const reach = g.headReach;
    const tossE = this.toss * this.toss;
    const shake = this.snortT * this.snortT * Math.sin(this.idle * 46) * 0.1;

    /* the faster it goes the lower and longer the neck reaches; a head toss or
     * a shy throws it straight back up again */
    this.neckLow.rotation.x =
      H.neckPitchLow - reach * 0.34 + nod * 0.55 + tossE * 0.5 + shy * 0.42;
    this.neckUp.rotation.x =
      H.neckPitchHigh - reach * 0.2 + nod * 0.35 + tossE * 0.34 + shy * 0.3;
    this.headYawSmoothed = damp(
      this.headYawSmoothed,
      shy * 0.24 * this.shySide + Math.sin(this.idle * 0.7) * 0.02,
      9,
      dt,
    );
    this.head.rotation.x =
      H.headPitch + reach * 0.16 - nod * 0.8 - tossE * 0.55 - shy * 0.4 + this.braced * 0.12;
    this.head.rotation.y = this.headYawSmoothed;
    this.head.rotation.z = shake;

    /* nostrils flare on the snort and stay open at a gallop */
    const flare = 1 + this.snortT * 0.55 + this.effort * 0.3;
    this.nostrils.scale.set(flare, flare, 1 + this.snortT * 0.3);

    /* ears: pricked at rest, laid back under effort, pinned on a shy, and
     * flicking on their own — the cheapest bit of life in the whole rig */
    const flick = this.earFlick * this.earFlick;
    const back = clamp01(this.effort * 0.8 + shy);
    const earBase = 0.3 - back * 1.45;
    this.earL.rotation.x = earBase - flick * 0.4;
    this.earR.rotation.x = earBase + flick * 0.25;
    this.earL.rotation.z = 0.24 + back * 0.28 + flick * 0.18;
    this.earR.rotation.z = -0.24 - back * 0.28;

    /* -------------------------------------------------------- 5. the tail */
    const sway = g.tailAmp * Math.sin(c * 0.5 + 0.3) + Math.sin(this.idle * 1.3) * 0.05;
    for (let s = 0; s < this.tail.length; s++) {
      const w = (s + 1) / this.tail.length;
      const seg = this.tail[s];
      seg.rotation.z = sway * w * 0.8;
      seg.rotation.x =
        (s === 0 ? H.tailDroop * 0.6 - g.tailLift : H.tailDroop * (1 - g.tailLift * 0.8)) +
        Math.sin(c + s * 0.7) * 0.05 * w;
    }

    /* -------------------------------------------------------- 6. the mane */
    if (this.detailLevel !== 'low') {
      const amp = 0.09 + this.gaitAxis * 0.13;
      for (let s = 0; s < this.mane.length; s++) {
        const w = s / Math.max(1, this.mane.length - 1);
        const m = this.mane[s];
        /* a travelling wave down the crest, amplitude rising with the gait */
        m.rotation.z = Math.sin(c - w * 3.1) * amp * 0.5;
        m.rotation.x = 0.08 + Math.sin(c - w * 3.1 + 0.9) * amp;
      }
    }
  }

  /**
   * Two-bone analytic IK plus a rigid third segment, solved in the sagittal
   * plane, with a lateral abduction that cancels the body's sway. A horse's
   * legs bend in one plane and one plane only, so a full 3D solve would be both
   * more expensive and less correct.
   *
   * Convention: a node with `rotation.x = a` points its child down the vector
   * (0, −cos a, −sin a), so positive `a` swings the limb FORWARD (−Z).
   */
  private solveLeg(leg: Leg, footX: number, footY: number, footZ: number, fold: number): void {
    /* --- 0. abduction: swing the whole leg plane sideways just enough that
     * the hoof stays where the rig put it while the body sways over it ---- */
    const drop = Math.max(0.25, leg.pivotY - footY);
    const abduct = Math.asin(clamp((footX - leg.x) / drop, -0.45, 0.45));

    /* --- 1. where the knee/hock sits, given where the hoof is ------------ */
    const dy = footY - leg.pivotY;
    const dz = footZ - leg.pivotZ;
    const lineAngle = Math.atan2(-dz, -dy);
    /* a swinging leg folds its cannon up under itself */
    const foldNow = leg.grounded ? 0 : fold * clamp01((footY - 0.012) / 0.16);
    const cannonAngle = lineAngle * leg.follow + leg.rake + foldNow * (leg.isFore ? 1 : -0.5);
    const jy = footY + leg.cannon * Math.cos(cannonAngle);
    const jz = footZ + leg.cannon * Math.sin(cannonAngle);

    /* --- 2. two-bone solve from the pivot to that joint ------------------ */
    const vy = jy - leg.pivotY;
    const vz = jz - leg.pivotZ;
    const A = leg.upper;
    const B = leg.lower;
    const d = clamp(Math.hypot(vy, vz), Math.abs(A - B) + 1e-3, A + B - 1e-3);
    const phi = Math.atan2(-vz, -vy);
    const cosA = clamp((A * A + d * d - B * B) / (2 * A * d), -1, 1);
    const cosB = clamp((A * A + B * B - d * d) / (2 * A * B), -1, 1);
    const a1 = phi + leg.bend * Math.acos(cosA);
    const a2 = -leg.bend * (Math.PI - Math.acos(cosB));

    /* abduct first, then swing: q = Qz(abduct) · Qx(a1) */
    this.qA.setFromAxisAngle(AXIS_X, a1);
    this.qB.setFromAxisAngle(AXIS_Z, abduct);
    leg.root.quaternion.copy(this.qB).multiply(this.qA);
    leg.mid.rotation.x = a2;
    leg.foot.rotation.x = cannonAngle - a1 - a2;
  }

  /* ================================================================ build */

  private mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(m);
    return m;
  }

  private emit(
    geo: THREE.BufferGeometry | null,
    material: THREE.Material,
    name: string,
    parent: THREE.Object3D,
  ): void {
    if (!geo) return;
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `horse_${name}`;
    parent.add(mesh);
  }

  /**
   * The barrel: chest, girth, flank and quarters as one lofted mass, plus the
   * withers, the shoulder and the gaskin. Deep through the heart, tucked at the
   * flank, round over the croup — the three proportions that make a horse look
   * like a horse in silhouette.
   */
  private buildBarrel(coat: Shell, ring: number): void {
    coat.add(
      loft(
        [
          { z: H.zChest - 0.06, cy: 1.03, hw: 0.09, hu: 0.18, hd: 0.14, power: 2.6 },
          { z: H.zChest, cy: 1.02, hw: 0.17, hu: 0.24, hd: 0.19, power: 2.5 },
          { z: -0.62, cy: 1.06, hw: 0.235, hu: 0.36, hd: 0.27, power: 2.4 },
          { z: -0.4, cy: 1.05, hw: 0.262, hu: 0.35, hd: 0.31, power: 2.3 },
          { z: -0.1, cy: 1.03, hw: 0.272, hu: 0.33, hd: 0.32, power: 2.25 },
          { z: 0.18, cy: 1.07, hw: 0.243, hu: 0.28, hd: 0.28, power: 2.3 },
          { z: 0.45, cy: 1.11, hw: 0.272, hu: 0.3, hd: 0.27, power: 2.35 },
          { z: 0.62, cy: 1.14, hw: 0.245, hu: 0.24, hd: 0.22, power: 2.5 },
          { z: H.zRump + 0.06, cy: 1.16, hw: 0.15, hu: 0.16, hd: 0.16, power: 2.6 },
        ],
        ring,
      ),
    );

    /* the withers — the ridge the neck rises out of, and the highest point */
    coat.add(
      loft(
        [
          { z: -0.74, cy: 1.26, hw: 0.06, hu: 0.04, hd: 0.14, power: 2.4 },
          { z: -0.6, cy: 1.29, hw: 0.088, hu: 0.15, hd: 0.16, power: 2.3 },
          { z: -0.44, cy: 1.27, hw: 0.1, hu: 0.12, hd: 0.16, power: 2.3 },
          { z: -0.3, cy: 1.23, hw: 0.098, hu: 0.05, hd: 0.14, power: 2.4 },
        ],
        Math.max(8, ring - 4),
      ),
    );

    /* the shoulder blade the foreleg swings out of */
    coat.addMirrored(
      loft(
        [
          { z: -0.8, cy: 1.04, hw: 0.05, hu: 0.1, hd: 0.13, power: 2.4 },
          { z: -0.68, cy: 1.06, hw: 0.105, hu: 0.19, hd: 0.21, power: 2.3 },
          { z: -0.52, cy: 1.07, hw: 0.098, hu: 0.21, hd: 0.24, power: 2.3 },
          { z: -0.42, cy: 1.03, hw: 0.05, hu: 0.16, hd: 0.18, power: 2.4 },
        ],
        Math.max(8, ring - 4),
      ).translate(0.155, 0, 0),
    );

    /* the gaskin — the big muscle over the hind leg */
    coat.addMirrored(
      loft(
        [
          { z: 0.28, cy: 1.05, hw: 0.05, hu: 0.14, hd: 0.2, power: 2.4 },
          { z: 0.45, cy: 1.04, hw: 0.115, hu: 0.19, hd: 0.28, power: 2.3 },
          { z: 0.62, cy: 1.06, hw: 0.1, hu: 0.17, hd: 0.26, power: 2.3 },
          { z: 0.72, cy: 1.08, hw: 0.05, hu: 0.12, hd: 0.18, power: 2.5 },
        ],
        Math.max(8, ring - 4),
      ).translate(0.165, 0, 0),
    );
  }

  /** Neck in two hinged segments, with the mane hung off both of them. */
  private buildNeck(coat: Shell, ring: number, low: boolean): void {
    const nring = low ? 8 : Math.max(8, ring - 4);

    this.neckLow.position.set(0, H.neckBaseY, H.neckBaseZ);
    this.body.add(this.neckLow);

    const lowGeo = loft(
      [
        { z: 0, cy: 0, hw: 0.155, hu: 0.15, hd: 0.2, power: 2.4 },
        { z: -0.12, cy: 0, hw: 0.14, hu: 0.135, hd: 0.175, power: 2.3 },
        { z: -0.24, cy: 0, hw: 0.12, hu: 0.118, hd: 0.148, power: 2.3 },
        { z: -H.neckLower, cy: 0, hw: 0.105, hu: 0.1, hd: 0.128, power: 2.3 },
      ],
      nring,
    );
    /* the loft runs along −Z; rotate it so the bone runs up +Y */
    lowGeo.rotateX(Math.PI / 2);
    this.geometries.push(lowGeo);
    this.neckLow.add(new THREE.Mesh(lowGeo, this.matCoat));

    this.neckUp.position.set(0, H.neckLower, 0);
    this.neckLow.add(this.neckUp);

    const upGeo = loft(
      [
        { z: 0, cy: 0, hw: 0.105, hu: 0.1, hd: 0.128, power: 2.3 },
        { z: -0.15, cy: 0, hw: 0.093, hu: 0.092, hd: 0.11, power: 2.3 },
        { z: -H.neckUpper, cy: 0.01, hw: 0.078, hu: 0.076, hd: 0.086, power: 2.4 },
      ],
      nring,
    );
    upGeo.rotateX(Math.PI / 2);
    this.geometries.push(upGeo);
    this.neckUp.add(new THREE.Mesh(upGeo, this.matCoat));

    void coat;

    /* ---- the mane, in strips down the crest ---- */
    const strips = low ? 0 : 7;
    for (let i = 0; i < strips; i++) {
      const t = strips > 1 ? i / (strips - 1) : 0;
      const node = new THREE.Group();
      if (t < 0.42) {
        node.position.set(0, (t / 0.42) * H.neckLower * 0.95, 0);
        this.neckLow.add(node);
      } else {
        node.position.set(0, ((t - 0.42) / 0.58) * H.neckUpper * 0.92, 0);
        this.neckUp.add(node);
      }
      const len = lerp(0.21, 0.14, t);
      const w = lerp(0.058, 0.04, t);
      const zOff = -lerp(0.13, 0.085, t);
      const a = box(0.02, len, w, 0, -len * 0.42, zOff, 0.34, 0, 0);
      const b = box(0.015, len * 0.82, w * 0.8, 0.022, -len * 0.36, zOff + 0.014, 0.52, 0, 0);
      const merged = mergeGeometries([a, b, mirrorX(b.clone())], false);
      a.dispose();
      b.dispose();
      if (merged) {
        this.geometries.push(merged);
        const mesh = new THREE.Mesh(merged, this.matHair);
        mesh.name = 'horse_mane';
        node.add(mesh);
      }
      this.mane.push(node);
    }
  }

  /**
   * The head — the hardest thing in the rig to get right, and the thing the
   * player looks at. Wide flat forehead, eyes on the CORNERS of the skull, a
   * hollow under each, a long straight nasal bone, a fine flaring muzzle, and a
   * driving bridle with blinkers.
   */
  private buildHead(matEye: THREE.Material, matMuzzle: THREE.Material, low: boolean): void {
    const nring = low ? 8 : 10;
    this.head.position.set(0, H.neckUpper, 0);
    this.neckUp.add(this.head);

    const headGeo = loft(
      [
        { z: 0.02, cy: 0, hw: 0.072, hu: 0.045, hd: 0.075, power: 2.6 },
        { z: -0.06, cy: -0.01, hw: 0.098, hu: 0.055, hd: 0.1, power: 2.4 },
        { z: -0.14, cy: -0.035, hw: 0.1, hu: 0.05, hd: 0.105, power: 2.35 },
        { z: -0.24, cy: -0.06, hw: 0.077, hu: 0.043, hd: 0.082, power: 2.3 },
        { z: -0.34, cy: -0.082, hw: 0.062, hu: 0.037, hd: 0.062, power: 2.3 },
        { z: -0.41, cy: -0.1, hw: 0.062, hu: 0.038, hd: 0.05, power: 2.5 },
        { z: -H.headLength, cy: -0.112, hw: 0.05, hu: 0.032, hd: 0.036, power: 2.6 },
      ],
      nring,
    );
    this.geometries.push(headGeo);
    this.head.add(new THREE.Mesh(headGeo, this.matCoat));

    /* the jowl: the round cheek mass at the back of the jaw */
    const jowl = new THREE.SphereGeometry(0.072, low ? 8 : 10, low ? 6 : 8);
    jowl.scale(0.78, 1, 1.15);
    jowl.translate(0.048, -0.08, -0.075);
    const jowlPair = mergeGeometries([jowl, mirrorX(jowl.clone())], false);
    jowl.dispose();
    if (jowlPair) {
      this.geometries.push(jowlPair);
      this.head.add(new THREE.Mesh(jowlPair, this.matCoat));
    }

    /* eyes, set on the corners of the forehead — this single placement is most
     * of what makes a head read as a prey animal rather than as a dog */
    const eye = new THREE.SphereGeometry(0.024, 8, 6);
    eye.scale(0.8, 1, 1.15);
    eye.translate(0.088, -0.022, -0.115);
    const eyes = mergeGeometries([eye, mirrorX(eye.clone())], false);
    eye.dispose();
    if (eyes) {
      this.geometries.push(eyes);
      this.head.add(new THREE.Mesh(eyes, matEye));
    }

    /* brow ridges over them, and the forelock between the ears */
    const detail = new Shell();
    const brow = new THREE.TorusGeometry(0.032, 0.008, 4, 8, Math.PI * 1.25);
    brow.rotateY(Math.PI / 2);
    brow.rotateZ(0.45);
    brow.translate(0.088, -0.012, -0.113);
    detail.addMirrored(brow);
    const detailGeo = detail.build();
    if (detailGeo) {
      this.geometries.push(detailGeo);
      this.head.add(new THREE.Mesh(detailGeo, this.matCoat));
    }

    const forelock = new Shell();
    forelock.add(box(0.055, 0.13, 0.03, 0, -0.03, -0.05, 0.5, 0, 0));
    forelock.addMirrored(box(0.03, 0.1, 0.025, 0.03, -0.035, -0.055, 0.6, 0, 0.2));
    const forelockGeo = forelock.build();
    if (forelockGeo) {
      this.geometries.push(forelockGeo);
      this.head.add(new THREE.Mesh(forelockGeo, this.matHair));
    }

    /* muzzle and nostrils */
    this.nostrils.position.set(0, -0.108, -H.headLength + 0.03);
    this.head.add(this.nostrils);
    const nose = new THREE.SphereGeometry(0.026, 8, 6);
    nose.scale(0.85, 1.1, 0.7);
    nose.translate(0.03, 0.022, -0.012);
    const noses = mergeGeometries([nose, mirrorX(nose.clone())], false);
    nose.dispose();
    if (noses) {
      this.geometries.push(noses);
      this.nostrils.add(new THREE.Mesh(noses, matMuzzle));
    }
    const lip = new THREE.SphereGeometry(0.043, 8, 6);
    lip.scale(1, 0.72, 0.62);
    lip.translate(0, -0.128, -H.headLength + 0.012);
    this.geometries.push(lip);
    this.head.add(new THREE.Mesh(lip, matMuzzle));

    /* ears: pricked, mobile, dark at the tips like every grey */
    for (const side of [-1, 1]) {
      const ear = side < 0 ? this.earL : this.earR;
      ear.position.set(side * 0.046, 0.028, 0);
      this.head.add(ear);
      const shell = new THREE.ConeGeometry(0.028, H.earLength, 7, 1, false);
      shell.scale(1, 1, 0.62);
      shell.translate(0, H.earLength * 0.5, 0);
      this.geometries.push(shell);
      ear.add(new THREE.Mesh(shell, this.matPoints));
    }

    /* ---- the driving bridle, all of it parented to the head ---- */
    const leather = new Shell();
    /* browband, across the forehead under the ears */
    leather.add(box(0.2, 0.024, 0.018, 0, -0.006, -0.058));
    /* headpiece over the poll */
    leather.add(box(0.11, 0.02, 0.05, 0, 0.03, -0.04));
    /* cheekpieces down each side to the bit */
    leather.addMirrored(strap(0.092, -0.014, -0.058, 0.074, -0.104, -0.3, 0.0095));
    /* noseband */
    leather.add(
      new THREE.TorusGeometry(0.073, 0.0095, 4, 12).rotateY(Math.PI / 2).translate(0, -0.072, -0.285),
    );
    /* throatlatch */
    leather.addMirrored(strap(0.09, -0.022, -0.052, 0.052, -0.142, -0.032, 0.008));
    /* the bit across the mouth */
    leather.add(cyl(0.008, 0.008, 0.175, 6, 0, -0.114, -0.362, 'x'));
    /* BLINKERS — the square leather eye shields that say "harness horse" and
     * nothing else does. Angled out and forward, as they are actually set. */
    leather.addMirrored(box(0.014, 0.088, 0.078, 0.1, -0.022, -0.118, 0, -0.2, 0.12));
    const leatherGeo = leather.build();
    if (leatherGeo) {
      this.geometries.push(leatherGeo);
      this.head.add(new THREE.Mesh(leatherGeo, this.matHarness));
    }

    const brassParts = new Shell();
    /* rein rings either side of the mouth */
    brassParts.addMirrored(
      new THREE.TorusGeometry(0.027, 0.006, 4, 10).rotateY(Math.PI / 2).translate(0.088, -0.114, -0.362),
    );
    /* a rosette on the browband either side, and the brow crest plate */
    brassParts.addMirrored(cyl(0.018, 0.018, 0.011, 8, 0.09, -0.008, -0.055, 'x'));
    brassParts.add(box(0.03, 0.012, 0.03, 0, 0.006, -0.058));
    const brassGeo = brassParts.build();
    if (brassGeo) {
      this.geometries.push(brassGeo);
      this.head.add(new THREE.Mesh(brassGeo, this.matBrass));
    }
  }

  /**
   * Four legs. Each is a three-node chain hung off the body; the geometry is
   * authored once per (fore | hind) and shared by left and right.
   */
  private buildLegs(matHoof: THREE.Material, low: boolean): void {
    const seg = low ? 6 : 8;

    const foreUpperGeo = limb(H.foreUpper, 0.09, 0.135, 0.06, 0.088, seg, 0.028);
    const foreLowerGeo = limb(H.foreLower, 0.058, 0.086, 0.031, 0.04, seg, 0.024);
    const hindUpperGeo = limb(H.hindUpper, 0.105, 0.15, 0.078, 0.115, seg, 0.04);
    const hindLowerGeo = limb(H.hindLower, 0.075, 0.11, 0.033, 0.045, seg, 0.034);
    const foreCannonGeo = this.cannonGeo(H.foreCannon, 0.026, seg);
    const hindCannonGeo = this.cannonGeo(H.hindCannon, 0.028, seg);
    const foreHoofGeo = this.hoofGeo(H.foreCannon, low);
    const hindHoofGeo = this.hoofGeo(H.hindCannon, low);

    for (const g of [
      foreUpperGeo,
      foreLowerGeo,
      hindUpperGeo,
      hindLowerGeo,
      foreCannonGeo,
      hindCannonGeo,
      foreHoofGeo,
      hindHoofGeo,
    ]) {
      this.geometries.push(g);
    }

    const defs: Array<{ fore: boolean; side: number }> = [
      { fore: true, side: -1 },
      { fore: true, side: 1 },
      { fore: false, side: -1 },
      { fore: false, side: 1 },
    ];

    for (const def of defs) {
      const fore = def.fore;
      const x = def.side * (fore ? H.forePivotX : H.hipX);
      const pivotY = fore ? H.forePivotY : H.hipY;
      const pivotZ = fore ? H.forePivotZ : H.hipZ;

      const root = new THREE.Group();
      root.position.set(x, pivotY, pivotZ);
      this.body.add(root);
      root.add(new THREE.Mesh(fore ? foreUpperGeo : hindUpperGeo, this.matCoat));

      const mid = new THREE.Group();
      mid.position.set(0, -(fore ? H.foreUpper : H.hindUpper), 0);
      root.add(mid);
      mid.add(new THREE.Mesh(fore ? foreLowerGeo : hindLowerGeo, this.matCoat));

      const foot = new THREE.Group();
      foot.position.set(0, -(fore ? H.foreLower : H.hindLower), 0);
      mid.add(foot);
      foot.add(new THREE.Mesh(fore ? foreCannonGeo : hindCannonGeo, this.matPoints));
      foot.add(new THREE.Mesh(fore ? foreHoofGeo : hindHoofGeo, matHoof));

      this.legs.push({
        x,
        pivotY,
        pivotZ,
        neutralZ: fore ? H.foreNeutralZ : H.hindNeutralZ,
        upper: fore ? H.foreUpper : H.hindUpper,
        lower: fore ? H.foreLower : H.hindLower,
        cannon: fore ? H.foreCannon : H.hindCannon,
        bend: fore ? -1 : 1,
        follow: fore ? H.foreCannonFollow : H.hindCannonFollow,
        rake: fore ? H.foreKneeLead : H.hindHockRake,
        isFore: fore,
        root,
        mid,
        foot,
        hoof: new THREE.Vector3(x, 0, fore ? H.foreNeutralZ : H.hindNeutralZ),
        phase: 0,
        grounded: true,
      });
    }
  }

  /** Cannon, fetlock and pastern as one rigid tapered piece running down −Y. */
  private cannonGeo(len: number, r: number, seg: number): THREE.BufferGeometry {
    const shaft = limb(len - H.hoofHeight * 0.55, r * 1.2, r * 1.5, r * 0.8, r * 0.9, seg, 0);
    /* the fetlock joint — the knuckle every horse silhouette has */
    const fet = new THREE.SphereGeometry(r * 1.3, seg, Math.max(5, seg - 2));
    fet.scale(0.85, 1, 1.15);
    fet.translate(0, -(len - H.hoofHeight * 0.55) + 0.014, 0);
    const merged = mergeGeometries([shaft, fet], false);
    shaft.dispose();
    fet.dispose();
    return merged ?? new THREE.BufferGeometry();
  }

  /** A dark horn hoof, slightly flared where it meets the road. */
  private hoofGeo(cannonLen: number, low: boolean): THREE.BufferGeometry {
    const g = new THREE.CylinderGeometry(
      H.hoofRadius * 0.8,
      H.hoofRadius,
      H.hoofHeight,
      low ? 7 : 9,
      1,
      false,
    );
    g.scale(1, 1, 1.1);
    g.translate(0, -cannonLen + H.hoofHeight * 0.5, 0);
    return g;
  }

  /** Dock and tail hair, in four hinged segments so it can sway and lift. */
  private buildTail(low: boolean): void {
    let parent: THREE.Object3D = this.body;
    for (let s = 0; s < H.tailSegments; s++) {
      const node = new THREE.Group();
      node.position.set(0, s === 0 ? H.tailRootY : 0, s === 0 ? H.tailRootZ : H.tailSegLength);
      parent.add(node);

      const t = s / (H.tailSegments - 1);
      const dock = cyl(
        lerp(0.046, 0.02, t),
        lerp(0.052, 0.03, t),
        H.tailSegLength,
        low ? 5 : 7,
        0,
        0,
        H.tailSegLength * 0.5,
        'z',
      );
      this.geometries.push(dock);
      node.add(new THREE.Mesh(dock, this.matHair));

      if (s > 0) {
        /* the hair itself: flat blades either side of the dock */
        const blade = box(
          0.014,
          0.11 - t * 0.03,
          H.tailSegLength * 1.05,
          0.03,
          -0.022,
          H.tailSegLength * 0.5,
          0,
          0,
          0.22,
        );
        const pair = mergeGeometries([blade, mirrorX(blade.clone())], false);
        blade.dispose();
        if (pair) {
          this.geometries.push(pair);
          node.add(new THREE.Mesh(pair, this.matHair));
        }
      }
      this.tail.push(node);
      parent = node;
    }
  }

  /**
   * The working harness: a full collar with brass hames, the pad and girth, the
   * breeching round the quarters, the crupper, and the traces running back
   * along the horse's sides. This is the tack a carriage horse actually wears,
   * and it is what makes the animal read as *in work* rather than as a horse
   * standing near a cart.
   */
  private buildHarness(harness: Shell, brass: Shell, matCollar: THREE.Material): void {
    /* --- the collar, sitting in the groove in front of the shoulders --- */
    const collar = new THREE.TorusGeometry(0.2, 0.055, 6, 16);
    collar.scale(1, 1.16, 0.6);
    collar.rotateX(0.42);
    collar.translate(0, 1.16, -0.62);
    this.geometries.push(collar);
    const collarMesh = new THREE.Mesh(collar, matCollar);
    collarMesh.name = 'horse_collar';
    this.body.add(collarMesh);

    /* hames: the two brass-topped arms clamped round the collar */
    const hame = new THREE.TorusGeometry(0.216, 0.016, 4, 14, Math.PI * 0.9);
    hame.scale(1, 1.16, 0.6);
    hame.rotateX(0.42);
    hame.rotateZ(-0.12);
    hame.translate(0, 1.16, -0.6);
    brass.add(hame);
    /* the terrets the reins run through, on the hames and on the pad */
    brass.addMirrored(
      new THREE.TorusGeometry(0.023, 0.006, 4, 9).rotateX(Math.PI / 2).translate(0.105, 1.36, -0.63),
    );
    brass.addMirrored(cyl(0.019, 0.019, 0.014, 8, 0.1, 1.4, -0.28, 'y'));

    /* --- the pad (a small saddle) and its girth --- */
    harness.add(box(0.21, 0.055, 0.21, 0, 1.365, -0.28));
    harness.add(box(0.115, 0.042, 0.14, 0, 1.405, -0.28));
    const girth = new THREE.TorusGeometry(0.3, 0.023, 4, 16);
    girth.scale(0.92, 1.06, 1);
    girth.rotateY(Math.PI / 2);
    girth.rotateZ(0.06);
    girth.translate(0, 1.03, -0.3);
    harness.add(girth);

    /* the backband down to the tugs the shafts sit in */
    harness.addMirrored(strap(0.09, 1.37, -0.28, 0.238, 0.87, -0.3, 0.014));
    harness.addMirrored(
      new THREE.TorusGeometry(0.052, 0.014, 4, 10).rotateY(Math.PI / 2).translate(0.258, 0.84, -0.3),
    );

    /* --- breeching: the broad strap round the quarters that does the
     * braking. Its presence is the difference between a harness that works and
     * a costume. --- */
    harness.add(
      new THREE.TorusGeometry(0.29, 0.028, 4, 16)
        .scale(0.95, 0.62, 1)
        .rotateY(Math.PI / 2)
        .rotateZ(-0.1)
        .translate(0, 0.95, 0.5),
    );
    harness.addMirrored(strap(0.2, 1.35, 0.12, 0.265, 0.95, 0.36, 0.012));
    harness.addMirrored(strap(0.2, 1.35, 0.12, 0.155, 1.35, 0.56, 0.012));

    /* --- crupper, over the dock, so the pad cannot slide forward --- */
    harness.add(strap(0, 1.375, -0.24, 0, 1.35, 0.6, 0.011));
    harness.add(
      new THREE.TorusGeometry(0.05, 0.012, 4, 9)
        .rotateY(Math.PI / 2)
        .rotateZ(1.3)
        .translate(0, 1.34, 0.66),
    );

    /* --- the traces: two heavy draught straps from the hames back along the
     * horse's sides, which is where the pull actually happens --- */
    harness.addMirrored(strap(0.19, 1.12, -0.68, 0.292, 0.9, -0.2, 0.017, 5));
    harness.addMirrored(strap(0.292, 0.9, -0.2, 0.3, 0.85, 0.66, 0.017, 5));
  }
}

/* ========================================================= free functions */

/**
 * Where on the 0..3 gait axis this speed sits. Boost drags the axis straight to
 * a gallop — but only once the horse is already moving, because a horse cannot
 * gallop out of a standstill and it looks ridiculous when one tries.
 */
function gaitAxisFor(speed: number, effort: number): number {
  const b = GAIT_BANDS;
  const g =
    smoothstep(clamp01((speed - b.trotFrom) / (b.trotTo - b.trotFrom))) +
    smoothstep(clamp01((speed - b.canterFrom) / (b.canterTo - b.canterFrom))) +
    smoothstep(clamp01((speed - b.gallopFrom) / (b.gallopTo - b.gallopFrom)));
  const rolling = clamp01(
    (speed - b.boostGallopMinSpeed) / (b.boostGallopFullSpeed - b.boostGallopMinSpeed),
  );
  return Math.max(g, effort * 3 * rolling);
}

/** Lerp two 0..1 phases the short way round the circle. */
function lerpPhase(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  let r = a + d * t;
  r -= Math.floor(r);
  return r;
}
