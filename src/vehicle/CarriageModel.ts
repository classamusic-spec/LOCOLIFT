/**
 * Loco Lift — el coche de caballos, built entirely out of code.
 *
 * A working tourist carriage off the plaza: a black-lacquered open victoria on
 * chrome-yellow spoked wheels, cream buttoned cushions, a blue-and-white
 * striped awning on slim brass posts, a folded black leather hood behind the
 * bench, brass carriage lamps either side of the coachman's box — and one
 * dapple-grey Paso Fino in full harness between the shafts (`HorseRig`).
 *
 * Everything is procedural Three.js geometry and Canvas2D textures — no files,
 * no downloads, works fully offline.
 *
 * HIERARCHY, and why it is shaped like this
 * -----------------------------------------
 *   object3d ─┬─ chassis          ← rocks and heaves cosmetically on its springs
 *             │    ├─ merged shells, canopy, hood, cushions, lamps, driver
 *             │    └─ passenger    ← toggled by setSeatOccupied
 *             ├─ wheelRoot[i] → wheelSteer[i] → wheelSpin[i]
 *             └─ harness         ← yaws about the front-axle kingpin with steer
 *                  ├─ shaftGroup  ← re-aimed every frame to stay attached at
 *                  │                BOTH ends: rear to the rocking carriage,
 *                  │                front to the bobbing horse
 *                  └─ horseRoot → HorseRig
 *
 * The horse hangs off `object3d` and **not** off `chassis`, which is the single
 * most important line in the file: the carriage has to be free to pitch and
 * wallow on its leaf springs while the hooves stay nailed to the road. The
 * shafts are then the visible linkage between the two, and they see-saw — which
 * is exactly what a real pole does, and it is free.
 *
 * The whole front assembly — shafts, traces and horse — yaws about the kingpin
 * with the steering, because a carriage front axle is a turntable. That is why
 * the horse swings wide ahead of you through a plaza turn.
 *
 * Local axes match the physics body: forward = −Z, right = +X, up = +Y. Heights
 * are authored as metres above the road and converted with `Y(h)`, so every
 * number below can be read against a photograph instead of a spring datum.
 *
 * The animal is never depicted being hurt or struck. There is no whip on the
 * box — the driver holds the reins and nothing else. See `ART_REFERENCE.md` §7.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from '../core/Config';
import { clamp, clamp01 } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import {
  CARRIAGE_GEO as G,
  CARRIAGE_PAINT as P,
  CARRIAGE_SUSPENSION as S,
} from './CarriageTuning';
import { MeterDisplay, ReinRibbon, createParts, taperTube } from './CockpitKit';
import { HorseRig } from './HorseRig';
import type { VehicleModel } from './VehicleTuning';

/** metres above the road → local Y */
const Y = (h: number): number => G.groundLocalY + h;

/**
 * The coachman's box, in one block.
 *
 * `eye` is the coachman's own head, taken straight from `buildFigures`: the
 * box cushion is at `hBox = 1.28`, the figure's torso hangs off `hBox + 0.1`
 * and its head sits 0.56 above that, i.e. 1.94 m over the road. The eye goes a
 * hair below at 1.91 and a hair forward of the head's centre. It is a *high*
 * seat — higher than the Jeep driver's by nearly a metre — and that is the
 * whole character of the view: you look down on the traffic and along the
 * horse's back.
 *
 * The hands are the coachman's, at the end of his own arms in the same file:
 * `(±0.17, hBox + 0.32, zBox − 0.28)`. Keeping the two in sync matters,
 * because the reins are anchored to these numbers and the figure has to be
 * holding them when the camera is anywhere else.
 */
const COCKPIT = {
  /**
   * The eye. Lower and further back than the coachman figure's own head, and
   * both deliberately.
   *
   * At his head height (1.94) and seat position (1.09) *everything the driver
   * owns* — hands, reins, splash board, meter — sat 42–48° below the sightline,
   * i.e. entirely outside a 68° frame. All you could see was a horse and a
   * road. That is anatomically honest and useless: a real coachman's hands are
   * outside their central vision too, and they still know where they are.
   * Dropping 8 cm and sitting 6 cm further back brings the hands to 20° down
   * and the splash board to 33°, which puts the whole working end of the
   * carriage along the bottom of the frame where a game wants it.
   */
  eyeHeight: 1.83,
  eyeZ: 1.12,
  /**
   * The fists. These numbers are shared with the coachman figure's arms in
   * `buildFigures` and must stay in sync: the reins anchor here in *every*
   * camera, so if the figure's hands and these disagree, the chase view shows
   * a pair of reins starting in mid-air next to a man holding nothing.
   */
  handX: 0.17,
  handH: 1.66,
  handZ: 0.66,
  /** metres of droop at the midpoint of a rein — leather, not wire */
  reinSag: 0.16,
  /** the meter's flag drop, dollars — a scenic ride, priced like one */
  fareFlag: 5.0,
  farePerMetre: 0.0034,
} as const;

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const AXIS_Y = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------- geometry utilities */

/** Accumulates geometry for one material, then merges it into a single mesh. */
class Shell {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
  }

  /** Add `geo` and its mirror across the YZ plane — the carriage is symmetric. */
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

const tA = /* @__PURE__ */ new THREE.Vector3();
const tB = /* @__PURE__ */ new THREE.Vector3();
const tDir = /* @__PURE__ */ new THREE.Vector3();
const tQ = /* @__PURE__ */ new THREE.Quaternion();
const tM = /* @__PURE__ */ new THREE.Matrix4();
const tS = /* @__PURE__ */ new THREE.Vector3(1, 1, 1);

/** A tapered tube from a to b. `rA` is the radius at a, `rB` at b. */
function taper(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  rA: number,
  rB = rA,
  seg = 6,
): THREE.BufferGeometry {
  tA.set(ax, ay, az);
  tB.set(bx, by, bz);
  tDir.subVectors(tB, tA);
  const len = tDir.length();
  /* CylinderGeometry's "top" is +Y, and setFromUnitVectors maps +Y onto the
   * a→b direction, so radiusTop is the radius at b */
  const g = new THREE.CylinderGeometry(rB, rA, Math.max(1e-3, len), seg, 1, false);
  if (len > 1e-5) {
    tDir.multiplyScalar(1 / len);
    tQ.setFromUnitVectors(UP, tDir);
    tA.add(tB).multiplyScalar(0.5);
    tM.compose(tA, tQ, tS);
    g.applyMatrix4(tM);
  }
  return g;
}

/**
 * A rectangular-section annulus in the YZ plane, centred at x — the felloe and
 * the iron tyre of every wheel. Four quad strips: outer, inner, and both faces.
 */
function ring(rIn: number, rOut: number, width: number, seg: number, x = 0): THREE.BufferGeometry {
  const verts = new Float32Array(seg * 4 * 3);
  const uvs = new Float32Array(seg * 4 * 2);
  const hw = width * 0.5;
  let p = 0;
  let q = 0;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    /* 0: outer-near, 1: outer-far, 2: inner-far, 3: inner-near */
    const pts: Array<[number, number, number]> = [
      [x - hw, s * rOut, c * rOut],
      [x + hw, s * rOut, c * rOut],
      [x + hw, s * rIn, c * rIn],
      [x - hw, s * rIn, c * rIn],
    ];
    for (let k = 0; k < 4; k++) {
      verts[p++] = pts[k][0];
      verts[p++] = pts[k][1];
      verts[p++] = pts[k][2];
      uvs[q++] = i / seg;
      uvs[q++] = k / 3;
    }
  }
  const index = new Uint16Array(seg * 4 * 6);
  let k = 0;
  for (let i = 0; i < seg; i++) {
    const n = (i + 1) % seg;
    for (let e = 0; e < 4; e++) {
      const a = i * 4 + e;
      const b = i * 4 + ((e + 1) % 4);
      const c = n * 4 + e;
      const d = n * 4 + ((e + 1) % 4);
      /* a→b is across the section, a→c is around it; this order puts the
       * outer face outward, the inner face inward and both cheeks sideways */
      index[k++] = a;
      index[k++] = b;
      index[k++] = c;
      index[k++] = b;
      index[k++] = d;
      index[k++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/** One station of a lofted carriage mass. */
interface Sec {
  z: number;
  /** half width */
  hw: number;
  /** top and bottom, as heights above the road */
  top: number;
  bot: number;
  /** profile power: 2 = ellipse, higher = rounded box */
  power?: number;
}

/**
 * Loft a closed tube through a list of stations. This is what gives the body
 * its curved, tapered, swooping shell instead of a stack of boxes.
 */
function loft(secs: readonly Sec[], ring2: number, cap = true): THREE.BufferGeometry {
  const n = secs.length;
  const verts = new Float32Array(n * ring2 * 3);
  const uvs = new Float32Array(n * ring2 * 2);
  let p = 0;
  let q = 0;
  for (let s = 0; s < n; s++) {
    const sec = secs[s];
    const e = 2 / (sec.power ?? 2.4);
    const cy = (sec.top + sec.bot) * 0.5;
    const hh = (sec.top - sec.bot) * 0.5;
    for (let i = 0; i < ring2; i++) {
      const t = (i / ring2) * Math.PI * 2;
      const c = Math.cos(t);
      const si = Math.sin(t);
      verts[p++] = sec.hw * Math.sign(si) * Math.pow(Math.abs(si), e);
      verts[p++] = Y(cy + hh * Math.sign(c) * Math.pow(Math.abs(c), e));
      verts[p++] = sec.z;
      uvs[q++] = i / ring2;
      uvs[q++] = s / (n - 1);
    }
  }
  const quads = (n - 1) * ring2;
  const caps = cap ? (ring2 - 2) * 2 : 0;
  const index = new Uint16Array(quads * 6 + caps * 3);
  let k = 0;
  for (let s = 0; s < n - 1; s++) {
    for (let i = 0; i < ring2; i++) {
      const a = s * ring2 + i;
      const b = s * ring2 + ((i + 1) % ring2);
      const c = (s + 1) * ring2 + i;
      const d = (s + 1) * ring2 + ((i + 1) % ring2);
      index[k++] = a;
      index[k++] = c;
      index[k++] = b;
      index[k++] = b;
      index[k++] = c;
      index[k++] = d;
    }
  }
  if (cap) {
    for (let i = 1; i < ring2 - 1; i++) {
      index[k++] = 0;
      index[k++] = i + 1;
      index[k++] = i;
    }
    const o = (n - 1) * ring2;
    for (let i = 1; i < ring2 - 1; i++) {
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

/** One station of a body-side strip: two edges, A and B, at a given z. */
interface StripSec {
  z: number;
  hwA: number;
  hA: number;
  hwB: number;
  hB: number;
}

/**
 * Sweep a strip around the closed plan outline of the body: down the right
 * side front-to-rear, round the back, up the left side, round the front. Used
 * for the side walls (A = floor, B = top rail), for the capping moulding
 * (A and B at the same height, different widths) and for the coach line.
 *
 * `flip` reverses the winding so the strip faces inward — which is how the
 * cream lining inside the body is built.
 */
function strip(secs: readonly StripSec[], flip = false): THREE.BufferGeometry {
  const n = secs.length;
  /* the closed loop: right side front→rear, then left side rear→front */
  const loop = n * 2;
  const verts = new Float32Array(loop * 2 * 3);
  const uvs = new Float32Array(loop * 2 * 2);
  let p = 0;
  let q = 0;
  for (let i = 0; i < loop; i++) {
    const onRight = i < n;
    const s = secs[onRight ? i : loop - 1 - i];
    const sx = onRight ? 1 : -1;
    verts[p++] = sx * s.hwA;
    verts[p++] = Y(s.hA);
    verts[p++] = s.z;
    verts[p++] = sx * s.hwB;
    verts[p++] = Y(s.hB);
    verts[p++] = s.z;
    const u = i / loop;
    uvs[q++] = u;
    uvs[q++] = 0;
    uvs[q++] = u;
    uvs[q++] = 1;
  }
  const index = new Uint16Array(loop * 6);
  let k = 0;
  for (let i = 0; i < loop; i++) {
    const j = (i + 1) % loop;
    const a = i * 2;
    const b = i * 2 + 1;
    const c = j * 2;
    const d = j * 2 + 1;
    /* The loop runs front→rear on the right and rear→front on the left, so a
     * single consistent traversal (a → b → d → c) faces outward on BOTH sides
     * automatically — the z direction reverses and takes the normal with it. */
    if (flip) {
      index[k++] = a;
      index[k++] = d;
      index[k++] = b;
      index[k++] = a;
      index[k++] = c;
      index[k++] = d;
    } else {
      index[k++] = a;
      index[k++] = b;
      index[k++] = d;
      index[k++] = a;
      index[k++] = d;
      index[k++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/* --------------------------------------------------------------- textures */

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * The awning: broad blue-and-white bands with the weave showing through and a
 * little sun-bleaching, because a canopy that has never been rained on reads
 * as plastic.
 */
function makeCanopyTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  const blue = '#2c5ea8';
  const white = '#f5f2e8';
  g.fillStyle = white;
  g.fillRect(0, 0, 256, 256);

  /* six broad bands across the width */
  const bands = 6;
  const bw = 256 / bands;
  for (let i = 0; i < bands; i++) {
    if (i % 2 === 0) continue;
    g.fillStyle = blue;
    g.fillRect(i * bw, 0, bw, 256);
    /* a narrow pinstripe inside each white band, as real awning duck has */
    g.fillStyle = 'rgba(44,94,168,0.55)';
    g.fillRect(i * bw - 5, 0, 2.5, 256);
    g.fillRect(i * bw + bw + 2.5, 0, 2.5, 256);
  }

  /* canvas weave */
  g.globalAlpha = 0.09;
  for (let x = 0; x < 256; x += 3) {
    g.fillStyle = '#000000';
    g.fillRect(x, 0, 1, 256);
  }
  for (let y = 0; y < 256; y += 3) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, y, 256, 1);
  }
  g.globalAlpha = 1;

  /* sun bleach down the middle of the crown */
  const bleach = g.createLinearGradient(0, 0, 0, 256);
  bleach.addColorStop(0, 'rgba(255,255,255,0.16)');
  bleach.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  bleach.addColorStop(1, 'rgba(0,0,0,0.06)');
  g.fillStyle = bleach;
  g.fillRect(0, 0, 256, 256);

  return canvasTexture(c);
}

/**
 * The licence panel on the back of the body. Every carriage in the old city
 * carries a number — this is the detail that says "working vehicle", not
 * "theme park ride".
 */
function makePanelTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256, 128);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#0d0e14';
  g.fillRect(0, 0, 256, 128);

  g.strokeStyle = '#f0ad12';
  g.lineWidth = 3;
  g.strokeRect(10, 10, 236, 108);

  g.fillStyle = '#f0ad12';
  g.textAlign = 'center';
  g.font = 'bold 25px Georgia, "Times New Roman", serif';
  g.fillText('COCHES DEL VIEJO', 128, 45);
  g.font = 'bold 21px Georgia, "Times New Roman", serif';
  g.fillText('SAN JUAN', 128, 70);
  g.font = 'bold 30px Georgia, serif';
  g.fillText('N.º 12', 128, 103);

  return canvasTexture(c);
}

/* =============================================================== the model */

export class CarriageModel implements VehicleModel {
  /** root; Vehicle copies the rigid body transform onto this every frame */
  readonly object3d = new THREE.Group();
  /** everything that rocks cosmetically on the springs */
  readonly chassis = new THREE.Group();

  /** suspension nodes, one per wheel — Vehicle sets their local Y */
  readonly wheelRoots: THREE.Group[] = [];
  readonly wheelSteer: THREE.Group[] = [];
  readonly wheelSpin: THREE.Group[] = [];

  /** the whole front assembly: shafts, traces and horse, yawing on the kingpin */
  private readonly harness = new THREE.Group();
  /** the shafts alone, re-aimed each frame to stay attached at both ends */
  private readonly shaftGroup = new THREE.Group();
  private readonly horseRoot = new THREE.Group();
  private readonly horse: HorseRig;

  private readonly passenger = new THREE.Group();
  private readonly driver = new THREE.Group();
  private readonly beams = new THREE.Group();

  /* ------------------------------------------------------- driver's seat */
  /** the box, seen from the box: built once, parked hidden */
  private readonly cockpit = new THREE.Group();
  /**
   * The reins. NOT part of the cockpit group — they are correct and visible
   * from every camera, and the static ones they replace were quietly wrong in
   * the chase view too (baked into the shaft group, they swung away from the
   * driver's hands the moment the turntable yawed).
   */
  private reins: ReinRibbon | null = null;
  private meter: MeterDisplay | null = null;
  private cockpitOn = false;
  private fareDistance = 0;
  private fareClock = 0;
  private readonly reinHand = new THREE.Vector3();
  private readonly reinBit = new THREE.Vector3();

  /* live materials */
  private readonly matLamp: THREE.MeshStandardMaterial;
  private readonly matLampRear: THREE.MeshStandardMaterial;
  private readonly matPassenger: THREE.MeshStandardMaterial;
  private readonly matBeam: THREE.MeshBasicMaterial;

  /** decided before the materials are built; gates the clearcoat lobe */
  private readonly lowDetail: boolean;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];

  /* ------------------------------------------------------------- state */
  private readonly spinAccum = [0, 0, 0, 0];
  private readonly compression = [0, 0, 0, 0];
  private boost = 0;
  private braking = false;
  private headlightsOn = false;
  private beamsAllowed = true;

  /** cosmetic lean, kept so the shafts can chase the carriage's front end */
  private leanPitch = 0;
  private leanHeave = 0;
  /** smoothed grounded fraction, for the horse's airborne tuck */
  private grounded = 1;

  /* --- ground-distance measurement: the thing the whole gait runs on --- */
  private readonly horseWorld = new THREE.Vector3();
  private readonly horsePrev = new THREE.Vector3();
  private readonly horseLocal = new THREE.Vector3();
  private readonly horseFwd = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private hasPrev = false;
  private idlePhase = 0;

  constructor(quality: QualityTier = 'high') {
    this.lowDetail = quality === 'low';
    this.object3d.name = 'Carriage';
    this.chassis.name = 'carriageChassis';
    this.object3d.add(this.chassis);

    const low = quality === 'low';
    const seg = low ? 24 : 36;

    /* ------------------------------------------------------------ materials
     *
     * Varnished mahogany is the textbook clearcoat case: a deep, saturated,
     * completely non-metallic pigment under a hard gloss film. It was running
     * at metalness 0.38, which threw away nearly two-fifths of that colour and
     * tinted the gloss brown. Brass stays metal because it *is* metal; wrought
     * iron drops to §5's 0.35/0.45 — hand-forged iron is oxidised, not
     * polished, and 0.55/0.55 was splitting the difference between the two. */
    const matLacquer = this.paint(P.lacquer, 0.28, 1.0, 0.05, 0);
    const matLacquerLit = this.paint(P.lacquerLit, 0.3, 0.9, 0.08, 0);
    const matYellow = this.paint(P.yellow, 0.34, 1.0, 0.07);
    const matYellowDeep = this.paint(P.yellowDeep, 0.34, 1.0, 0.07);
    const matBrass = this.mat(P.brass, 0.92, 0.24, 1.2);
    const matLeather = this.mat(P.leather, 0.0, 0.52);
    const matCushion = this.mat(P.cushion, 0.0, 0.62);
    const matIron = this.mat(P.iron, 0.35, 0.45);

    const canopyTex = makeCanopyTexture();
    if (canopyTex) this.textures.push(canopyTex);
    const matCanopy = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: canopyTex ?? null,
      metalness: 0.02,
      roughness: 0.78,
      side: THREE.DoubleSide,
    });
    if (!canopyTex) matCanopy.color.setHex(P.canopyBlue);
    this.materials.push(matCanopy);

    this.matLamp = new THREE.MeshStandardMaterial({
      color: P.lamp,
      emissive: new THREE.Color(P.lamp),
      emissiveIntensity: G.lampIntensityOff,
      metalness: 0.2,
      roughness: 0.22,
    });
    this.materials.push(this.matLamp);

    this.matLampRear = new THREE.MeshStandardMaterial({
      color: P.lampRear,
      emissive: new THREE.Color(P.lampRear),
      emissiveIntensity: G.rearLampOff,
      metalness: 0.15,
      roughness: 0.3,
    });
    this.materials.push(this.matLampRear);

    this.matBeam = new THREE.MeshBasicMaterial({
      color: P.lamp,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.materials.push(this.matBeam);

    this.matPassenger = this.mat(PALETTE.facade[4], 0.06, 0.72);

    /* --------------------------------------------------------------- shells */
    const lacquer = new Shell();
    const lacquerLit = new Shell();
    const yellow = new Shell();
    const yellowDeep = new Shell();
    const brass = new Shell();
    const leather = new Shell();
    const cushion = new Shell();
    const iron = new Shell();

    this.buildBody(lacquer, lacquerLit, yellow, low);
    this.buildUndercarriage(yellow, yellowDeep, iron, brass);
    this.buildSeats(cushion, leather, lacquer, low);
    this.buildCanopy(matCanopy, brass, low);
    this.buildHood(leather, iron);
    this.buildLamps(brass, iron);
    this.buildDetails(brass, iron, leather, yellow);

    this.emit(lacquer.build(), matLacquer, 'lacquer');
    this.emit(lacquerLit.build(), matLacquerLit, 'moulding');
    this.emit(yellow.build(), matYellow, 'yellow');
    this.emit(yellowDeep.build(), matYellowDeep, 'yellowDeep');
    this.emit(brass.build(), matBrass, 'brass');
    this.emit(leather.build(), matLeather, 'leather');
    this.emit(cushion.build(), matCushion, 'cushions');
    this.emit(iron.build(), matIron, 'ironwork');

    this.buildPanel();
    this.buildFigures();
    this.buildWheels(matYellow, matIron, matBrass, seg, low);

    /* ---------------------------------------------- the front assembly */
    this.harness.name = 'harness';
    this.harness.position.set(0, G.groundLocalY, G.zFrontAxle);
    this.object3d.add(this.harness);

    this.shaftGroup.name = 'shafts';
    /* the shaft group pivots about its FORWARD end, at the horse's shoulder */
    this.shaftGroup.position.set(0, G.hShaftTip, G.zShaftTip - G.zFrontAxle);
    this.harness.add(this.shaftGroup);
    this.buildShafts(matYellow, matLeather, matIron);

    this.horseRoot.position.set(0, 0, G.zHorse - G.zFrontAxle);
    this.harness.add(this.horseRoot);
    this.horse = new HorseRig(quality);
    this.horseRoot.add(this.horse.object3d);

    this.buildCockpit(matBrass, matLeather);

    this.chassis.add(this.beams);
    this.setQuality(quality);

    this.object3d.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
    });
    this.beams.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = false;
    });
    this.cockpit.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = false;
    });

    /* place the horse's local offset once — it only changes with the steer */
    this.updateHorseLocal();
  }

  /* ================================================== Vehicle-facing methods */

  /**
   * Front wheel angle in radians, positive = steering right. The front wheels
   * turn, and so does the entire front assembly: on a carriage the shafts are
   * bolted to the turntable, so the horse swings out ahead of the body. It is
   * the most legible steering in the game — you can see where you are going to
   * end up before you get there.
   */
  setSteer(rad: number): void {
    const a = clamp(rad, -1.2, 1.2);
    this.wheelSteer[0].rotation.y = -a;
    this.wheelSteer[1].rotation.y = -a;
    this.harness.rotation.y = -a;
    this.updateHorseLocal();
  }

  /**
   * Absolute per-wheel roll angle. The front wheels are physically smaller than
   * the radius the simulation runs, so they have to turn proportionally faster
   * or they visibly drag.
   */
  setWheelSpin(i: number, radians: number): void {
    if (i < 0 || i > 3 || !Number.isFinite(radians)) return;
    const scaled = i < 2 ? radians * G.frontSpinRatio : radians;
    this.spinAccum[i] = scaled;
    this.wheelSpin[i].rotation.x = -scaled;
  }

  /**
   * Suspension travel. The front hubs are dropped by the difference between the
   * two wheel radii, so the small front wheel still meets the same road as the
   * big rear one — which is, physically, exactly why a carriage's front wheels
   * are small: they have to pass under the body at full lock.
   */
  setSuspension(i: number, compression: number): void {
    if (i < 0 || i > 3) return;
    const c = clamp01(compression);
    this.compression[i] = c;
    const drop = i < 2 ? G.frontHubDrop : 0;
    this.wheelRoots[i].position.y = S.anchorY - S.restLength * (1 - c) - drop;

    /* infer how much of the carriage is actually on the road, so the horse
     * knows to tuck its legs up rather than paw at nothing */
    let down = 0;
    for (let k = 0; k < 4; k++) if (this.compression[k] > 0.02) down++;
    this.grounded = down * 0.25;
  }

  setBrakeLights(on: boolean): void {
    this.braking = on;
    this.matLampRear.emissiveIntensity = on ? G.rearLampOn : G.rearLampOff;
  }

  /** 0..1 — the gallop. Drives the gait, the ears, the nostrils and the reach. */
  setBoostGlow(v: number): void {
    this.boost = clamp01(v);
  }

  setHeadlights(on: boolean): void {
    this.headlightsOn = on;
    this.matLamp.emissiveIntensity = on ? G.lampIntensityOn : G.lampIntensityOff;
    this.beams.visible = on && this.beamsAllowed;
  }

  setSeatOccupied(occupied: boolean, archetypeId?: string): void {
    this.passenger.visible = occupied;
    if (occupied) this.matPassenger.color.setHex(archetypeColor(archetypeId));
  }

  /* ------------------------------------------------------ driver's seat */

  /**
   * Show the box's own furniture and, crucially, **hide the coachman**.
   *
   * At `interiorWeight` 1 the camera is inside his head; leaving him visible
   * puts the inside of a skull across the whole frame. The swap is a single
   * boolean because the two are mutually exclusive by construction — the
   * cockpit's hands are authored at exactly the coordinates his are.
   */
  setCockpitVisible(amount: number): void {
    const on = amount > 0.002;
    if (on === this.cockpitOn) return;
    this.cockpitOn = on;
    this.cockpit.visible = on;
    this.driver.visible = !on;
  }

  /** The coachman's eye, in body-local metres, through the cosmetic lean. */
  getCockpitEye(out: THREE.Vector3): THREE.Vector3 {
    this.chassis.updateMatrix();
    return out
      .set(0, Y(COCKPIT.eyeHeight), COCKPIT.eyeZ)
      .applyMatrix4(this.chassis.matrix);
  }

  /** Cosmetic body attitude layered over the rigid body's real motion. */
  setChassisLean(pitch: number, roll: number, heave: number): void {
    this.leanPitch = pitch;
    this.leanHeave = heave;
    this.chassis.rotation.x = pitch;
    this.chassis.rotation.z = -roll;
    this.chassis.position.y = heave;
  }

  /**
   * The frame's real work: measure how far the horse actually moved over the
   * ground, hand that to the rig, and re-aim the shafts so they stay bolted to
   * a carriage and a horse that are moving independently.
   */
  tick(dt: number, speed: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.idlePhase += dt;

    /* --- where is the horse, in the world? ---------------------------- */
    this.horseWorld
      .copy(this.horseLocal)
      .applyQuaternion(this.object3d.quaternion)
      .add(this.object3d.position);

    /* its forward axis, likewise */
    this.horseFwd
      .set(0, 0, -1)
      .applyQuaternion(this.tmpQ.setFromAxisAngle(AXIS_Y, this.harness.rotation.y))
      .applyQuaternion(this.object3d.quaternion);
    this.horseFwd.y = 0;
    const len = this.horseFwd.length();
    if (len > 1e-5) this.horseFwd.multiplyScalar(1 / len);

    let dist = 0;
    if (this.hasPrev) {
      this.tmpV.subVectors(this.horseWorld, this.horsePrev);
      this.tmpV.y = 0;
      dist = this.tmpV.dot(this.horseFwd);
    }
    this.horsePrev.copy(this.horseWorld);
    this.hasPrev = true;

    /* --- drive the animal ---------------------------------------------- */
    this.horse.update(
      dt,
      dist,
      speed,
      this.boost,
      this.braking ? 1 : 0,
      this.grounded,
    );

    /* --- the shafts: attached to the carriage at one end and to the horse
     * at the other, and neither of them is holding still ----------------- */
    const lift = this.horse.bodyLift;
    /* where the carriage's shaft mount has got to, from the cosmetic lean */
    const rearDelta = this.leanHeave - this.leanPitch * G.zDash;
    const shaftLen = G.zDash - G.zShaftTip;
    this.shaftGroup.position.y = G.hShaftTip + lift * 0.85;
    this.shaftGroup.rotation.x = -Math.asin(
      clamp((rearDelta - lift * 0.85) / shaftLen, -0.5, 0.5),
    );

    /* --- the reins, re-solved from fists to bit rings ------------------ */
    this.tickReins();

    /* --- the taxímetro ------------------------------------------------- */
    if (this.cockpitOn) {
      this.fareDistance += Math.abs(speed) * dt;
      this.fareClock += dt;
      if (this.fareClock >= 0.25) {
        this.fareClock = 0;
        this.meter?.set(
          COCKPIT.fareFlag + this.fareDistance * COCKPIT.farePerMetre,
          this.passenger.visible,
        );
      }
    }

    /* --- idle life: a standing carriage is never quite still ----------- */
    const idle = clamp01(1 - Math.abs(speed) / 4);
    if (idle > 0.001) {
      const s = Math.sin(this.idlePhase * 3.1) * G.idleShiver * idle;
      this.chassis.position.x = s;
      this.chassis.rotation.y = Math.sin(this.idlePhase * 2.3) * 0.0016 * idle;
    } else if (this.chassis.position.x !== 0) {
      this.chassis.position.x = 0;
      this.chassis.rotation.y = 0;
    }
  }

  setQuality(tier: QualityTier): void {
    this.beamsAllowed = tier === 'high' || tier === 'ultra';
    this.beams.visible = this.headlightsOn && this.beamsAllowed;
    this.horse?.setQuality(tier);
  }

  dispose(): void {
    this.horse.dispose();
    this.reins?.dispose();
    this.reins = null;
    this.meter?.dispose();
    this.meter = null;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.object3d.clear();
  }

  /* ------------------------------------------------- optional model hooks */

  /** The driver rings the harness bell and calls out; the horse's head comes up. */
  pulseHorn(): void {
    this.horse.headToss(1);
  }

  /** Pulled up hard: the horse blows out through its nose. */
  pulseAirBrake(strength: number): void {
    this.horse.snort(clamp01(strength));
  }

  /**
   * Something hit us. The horse startles away from it — head up, ears back, a
   * flinch and a check in the stride — and recovers within the second. It is
   * never shown hurt.
   */
  reactToImpact(impulse: number, fromRight: number): void {
    const s = clamp01(impulse / 9000);
    if (s < 0.05) return;
    this.horse.shy(0.35 + s * 0.65, -Math.sign(fromRight || 1));
  }

  /** A near miss: a smaller startle, and the ears go round to follow it. */
  reactToNearMiss(speed: number, fromRight: number): void {
    this.horse.shy(clamp01(0.18 + speed * 0.018), -Math.sign(fromRight || 1));
  }

  /** Tell the model how much of the carriage is on the road, 0..1. */
  setGroundedFraction(f: number): void {
    this.grounded = clamp01(f);
  }

  /**
   * Hoof `i` in vehicle-body local space — the frame `object3d` itself is in.
   * The contact test reads this, and dust/fx can later.
   */
  hoofLocal(i: number, out: THREE.Vector3): THREE.Vector3 {
    this.horse.hoof(i, out);
    out.add(this.horseRoot.position);
    out.applyAxisAngle(AXIS_Y, this.harness.rotation.y);
    out.add(this.harness.position);
    return out;
  }

  /** True while hoof `i` is bearing weight. */
  hoofGrounded(i: number): boolean {
    return this.horse.hoofGrounded(i);
  }

  /** The gait being played, for a HUD or for audio. */
  get gait(): string {
    return this.horse.gaitName;
  }

  /* ================================================================ builders */

  private mat(
    color: number,
    metalness: number,
    roughness: number,
    envMapIntensity = 1,
  ): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity });
    this.materials.push(m);
    return m;
  }

  /**
   * Varnished or painted timber: a dielectric base plus a clear film. Gated on
   * quality, and the fallback keeps identical metalness and roughness so the
   * coachwork is the same colour at every tier.
   */
  private paint(
    color: number,
    roughness: number,
    clearcoat: number,
    clearcoatRoughness: number,
    metalness = 0.05,
  ): THREE.MeshStandardMaterial {
    const base = { color, metalness, roughness, envMapIntensity: 1 };
    const m = this.lowDetail
      ? new THREE.MeshStandardMaterial(base)
      : new THREE.MeshPhysicalMaterial({ ...base, clearcoat, clearcoatRoughness });
    this.materials.push(m);
    return m;
  }

  private emit(geo: THREE.BufferGeometry | null, material: THREE.Material, name: string): void {
    if (!geo) return;
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `carriage_${name}`;
    this.chassis.add(mesh);
  }

  /** Cache the horse's offset in body-local space; it moves only with steer. */
  private updateHorseLocal(): void {
    this.horseLocal
      .copy(this.horseRoot.position)
      .applyAxisAngle(AXIS_Y, this.harness.rotation.y)
      .add(this.harness.position);
  }

  /**
   * The body: a black-lacquered shell with a swooping lower line, deep through
   * the rear quarter and shallow at the dash, lined in cream and finished with
   * a capping moulding and a fine yellow coach line.
   */
  private buildBody(lacquer: Shell, moulding: Shell, yellow: Shell, low: boolean): void {
    const R = low ? 12 : 18;
    const F = G.hBodyFloor;

    /* --- the lower shell: everything under the floor, i.e. the boot ---- */
    lacquer.add(
      loft(
        [
          { z: G.zDash - 0.02, hw: 0.34, top: F, bot: 0.9, power: 2.8 },
          { z: G.zDash + 0.06, hw: 0.46, top: F, bot: 0.84, power: 2.6 },
          { z: 0.78, hw: 0.53, top: F, bot: 0.76, power: 2.5 },
          { z: 1.12, hw: 0.575, top: F, bot: 0.69, power: 2.5 },
          { z: 1.58, hw: 0.6, top: F, bot: G.hBodyKeel, power: 2.5 },
          { z: 2.02, hw: 0.6, top: F, bot: G.hBodyKeel, power: 2.5 },
          { z: 2.36, hw: 0.575, top: F, bot: 0.67, power: 2.5 },
          { z: 2.58, hw: 0.5, top: F, bot: 0.78, power: 2.6 },
          { z: G.zBodyRear, hw: 0.32, top: F, bot: 0.9, power: 2.8 },
        ],
        R,
      ),
    );

    /* --- the plan outline the side walls, the capping and the coach line
     * all sweep around. Front to rear, right-hand side. ------------------ */
    const plan: Array<{ z: number; hw: number; rail: number }> = [
      { z: G.zDash - 0.02, hw: 0.34, rail: 1.36 },
      { z: G.zDash + 0.06, hw: 0.46, rail: 1.34 },
      { z: 0.78, hw: 0.53, rail: 1.32 },
      { z: 1.12, hw: 0.575, rail: 1.3 },
      { z: 1.58, hw: 0.6, rail: 1.29 },
      { z: 2.02, hw: 0.6, rail: 1.3 },
      { z: 2.36, hw: 0.575, rail: 1.32 },
      { z: 2.58, hw: 0.5, rail: 1.35 },
      { z: G.zBodyRear, hw: 0.32, rail: 1.38 },
    ];

    /* outer wall: floor to top rail */
    lacquer.add(
      strip(plan.map((s) => ({ z: s.z, hwA: s.hw, hA: F, hwB: s.hw, hB: s.rail }))),
    );
    /* cream lining, set in and facing the passengers */
    lacquer.add(
      strip(
        plan.map((s) => ({ z: s.z, hwA: s.hw - 0.05, hA: F, hwB: s.hw - 0.05, hB: s.rail - 0.02 })),
        true,
      ),
    );
    /* the floor itself */
    lacquer.add(
      strip(plan.map((s) => ({ z: s.z, hwA: 0, hA: F, hwB: s.hw - 0.05, hB: F }))),
    );
    /* capping moulding over the top rail, in a lighter lacquer so the edge
     * catches the light — this one highlight is what makes it read as
     * *lacquered* rather than as matte black */
    moulding.add(
      strip(
        plan.map((s) => ({
          z: s.z,
          hwA: s.hw - 0.055,
          hA: s.rail,
          hwB: s.hw + 0.022,
          hB: s.rail - 0.012,
        })),
      ),
    );
    /* the fine yellow coach line round the body, just under the capping */
    yellow.add(
      strip(
        plan.map((s) => ({
          z: s.z,
          hwA: s.hw + 0.004,
          hA: s.rail - 0.075,
          hwB: s.hw + 0.004,
          hB: s.rail - 0.055,
        })),
      ),
    );
    /* and a second, lower line following the swoop of the keel */
    yellow.add(
      strip(
        plan.map((s, i) => {
          const bot = [0.9, 0.84, 0.76, 0.69, G.hBodyKeel, G.hBodyKeel, 0.67, 0.78, 0.9][i];
          return {
            z: s.z,
            hwA: s.hw + 0.004,
            hA: bot + 0.05,
            hwB: s.hw + 0.004,
            hB: bot + 0.066,
          };
        }),
      ),
    );

    /* --- the splash board (dash) in front of the coachman's box -------- */
    lacquer.add(
      loft(
        [
          { z: G.zDash - 0.06, hw: 0.4, top: 1.36, bot: 1.0, power: 2.8 },
          { z: G.zDash, hw: 0.43, top: 1.4, bot: 1.0, power: 2.7 },
          { z: G.zDash + 0.06, hw: 0.42, top: 1.38, bot: 1.02, power: 2.8 },
        ],
        low ? 10 : 14,
      ),
    );
    moulding.add(
      strip([
        { z: G.zDash - 0.07, hwA: 0.36, hA: 1.4, hwB: 0.4, hB: 1.385 },
        { z: G.zDash + 0.02, hwA: 0.39, hA: 1.425, hwB: 0.435, hB: 1.41 },
        { z: G.zDash + 0.07, hwA: 0.38, hA: 1.405, hwB: 0.425, hB: 1.39 },
      ]),
    );
  }

  /**
   * Yellow undercarriage: axles, elliptic leaf springs, the perch that ties
   * the two axles together, the turntable, mudguards and the swingletree.
   */
  private buildUndercarriage(yellow: Shell, deep: Shell, iron: Shell, brass: Shell): void {
    /* --- axle beams --- */
    yellow.add(cyl(0.036, 0.036, 1.26, 8, 0, Y(G.rearRadius), G.zRearAxle, 'x'));
    yellow.add(cyl(0.032, 0.032, 1.14, 8, 0, Y(G.frontRadius), G.zFrontAxle, 'x'));
    /* the square centre blocks the springs sit on */
    yellow.add(box(0.3, 0.09, 0.11, 0, Y(G.rearRadius), G.zRearAxle));
    yellow.add(box(0.28, 0.085, 0.1, 0, Y(G.frontRadius), G.zFrontAxle));

    /* --- Elliptic leaf springs, one at each corner, mounted FORE AND AFT the
     * way a carriage's actually are: two stacks of leaves bowed against each
     * other into a lens, the top half bolted to the body and the bottom half
     * to the axle. Three leaves a side; each half is four straight chords,
     * which at this scale is indistinguishable from a curve. --- */
    for (const [x, z, hLow, hHigh, span] of [
      [0.44, G.zRearAxle, G.rearRadius + 0.04, G.hBodyKeel + 0.01, 0.46],
      [0.4, G.zFrontAxle, G.frontRadius + 0.04, G.hShaftRoot - 0.03, 0.38],
    ] as const) {
      for (let leaf = 0; leaf < 3; leaf++) {
        const t = leaf / 2;
        const s = span * (1 - t * 0.3);
        const mid = (hLow + hHigh) * 0.5;
        const bow = (hHigh - hLow) * 0.5 * (1 - t * 0.2);
        const r = 0.013 - t * 0.002;
        for (const sign of [1, -1] as const) {
          const shell = sign > 0 ? yellow : deep;
          const n = 4;
          for (let i = 0; i < n; i++) {
            const a0 = (i / n) * Math.PI;
            const a1 = ((i + 1) / n) * Math.PI;
            shell.addMirrored(
              taper(
                x,
                Y(mid + sign * Math.sin(a0) * bow),
                z + Math.cos(a0) * s * 0.5,
                x,
                Y(mid + sign * Math.sin(a1) * bow),
                z + Math.cos(a1) * s * 0.5,
                r,
                r,
                4,
              ),
            );
          }
        }
        /* the clips that bind the leaf stack, top and bottom */
        if (leaf === 0) {
          iron.addMirrored(box(0.05, 0.022, 0.055, x, Y(hHigh), z));
          iron.addMirrored(box(0.05, 0.022, 0.055, x, Y(hLow), z));
          /* and the shackle down onto the axle */
          iron.addMirrored(
            taper(x, Y(hLow), z, x, Y(hLow - 0.05), z, 0.014, 0.014, 5),
          );
        }
      }
    }

    /* --- the perch: two long yellow beams tying the axles together --- */
    yellow.addMirrored(
      taper(0.14, Y(G.hShaftRoot), G.zFrontAxle + 0.05, 0.15, Y(G.hBodyKeel - 0.04), G.zRearAxle - 0.06, 0.026, 0.03, 6),
    );

    /* --- the turntable (fifth wheel) the whole front assembly swings on -- */
    brass.add(
      new THREE.TorusGeometry(0.17, 0.018, 5, 18)
        .rotateX(Math.PI / 2)
        .translate(0, Y(G.hShaftRoot - 0.03), G.zFrontAxle),
    );
    iron.add(cyl(0.032, 0.032, 0.1, 8, 0, Y(G.hShaftRoot), G.zFrontAxle, 'y'));

    /* --- mudguards over the big rear wheels --- */
    const guard = new THREE.TorusGeometry(G.rearRadius + 0.07, 0.045, 4, 14, Math.PI * 0.92);
    guard.rotateY(Math.PI / 2);
    guard.rotateX(-Math.PI * 0.04);
    guard.scale(0.55, 1, 1);
    guard.translate(0.7, Y(G.rearRadius), G.zRearAxle);
    yellow.addMirrored(guard);
    /* the stays that hold them off the tyre */
    iron.addMirrored(
      taper(0.7, Y(G.rearRadius + 0.6), G.zRearAxle - 0.02, 0.6, Y(G.hBodyKeel), G.zRearAxle - 0.3, 0.011, 0.011, 4),
    );

    /* --- swingletree: the bar the traces pull on --- */
    yellow.add(cyl(0.026, 0.021, 0.6, 7, 0, Y(0.62), G.zSwingletree, 'x'));
    brass.addMirrored(
      new THREE.TorusGeometry(0.026, 0.007, 4, 9)
        .rotateY(Math.PI / 2)
        .translate(0.29, Y(0.62), G.zSwingletree),
    );
  }

  /**
   * Cream buttoned upholstery: the low passenger bench inside the body, and the
   * coachman's box, which sits high and forward the way a victoria's does.
   * The buttons are real geometry in a diamond lattice — deep-buttoned leather
   * and cloth is the single most recognisable thing about a carriage interior.
   */
  private buildSeats(cushion: Shell, leather: Shell, lacquer: Shell, low: boolean): void {
    const buttons = (
      shell: Shell,
      cx: number,
      cy: number,
      cz: number,
      w: number,
      h: number,
      cols: number,
      rows: number,
      vertical: boolean,
      tilt = 0,
    ): void => {
      if (low) return;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          /* a diamond lattice: alternate rows are offset by half a step */
          const offs = r % 2 === 0 ? 0 : 0.5;
          if (offs > 0 && c === cols - 1) continue;
          const u = cols > 1 ? (c + offs) / (cols - 1) - 0.5 : 0;
          const v = rows > 1 ? r / (rows - 1) - 0.5 : 0;
          const b = new THREE.SphereGeometry(0.019, 6, 4);
          b.scale(1, 0.5, 1);
          if (vertical) {
            b.rotateX(Math.PI / 2 + tilt);
            b.translate(cx + u * w, cy + v * h, cz);
          } else {
            b.translate(cx + u * w, cy, cz + v * h);
          }
          shell.add(b);
        }
      }
    };

    /* --- the passenger bench, low in the body --- */
    cushion.add(
      loft(
        [
          { z: G.zBench - 0.27, hw: 0.5, top: G.hBench + 0.09, bot: G.hBench - 0.05, power: 3.2 },
          { z: G.zBench, hw: 0.52, top: G.hBench + 0.11, bot: G.hBench - 0.06, power: 3.4 },
          { z: G.zBench + 0.27, hw: 0.5, top: G.hBench + 0.09, bot: G.hBench - 0.05, power: 3.2 },
        ],
        low ? 10 : 14,
      ),
    );
    buttons(cushion, 0, Y(G.hBench + 0.108), G.zBench, 0.72, 0.34, 4, 3, false);

    /* backrest, reclined a little */
    cushion.add(
      loft(
        [
          { z: G.zBench + 0.33, hw: 0.5, top: G.hBenchBack, bot: G.hBench + 0.04, power: 3.2 },
          { z: G.zBench + 0.41, hw: 0.51, top: G.hBenchBack + 0.02, bot: G.hBench + 0.04, power: 3.4 },
          { z: G.zBench + 0.47, hw: 0.49, top: G.hBenchBack - 0.01, bot: G.hBench + 0.05, power: 3.2 },
        ],
        low ? 10 : 14,
      ),
    );
    buttons(
      cushion,
      0,
      Y((G.hBenchBack + G.hBench + 0.04) * 0.5),
      G.zBench + 0.315,
      0.72,
      0.38,
      4,
      3,
      true,
      -0.12,
    );

    /* --- the coachman's box: high, narrow, with a low rail behind --- */
    cushion.add(
      loft(
        [
          { z: G.zBox - 0.2, hw: 0.4, top: G.hBox + 0.08, bot: G.hBox - 0.05, power: 3.2 },
          { z: G.zBox, hw: 0.42, top: G.hBox + 0.1, bot: G.hBox - 0.06, power: 3.4 },
          { z: G.zBox + 0.2, hw: 0.4, top: G.hBox + 0.08, bot: G.hBox - 0.05, power: 3.2 },
        ],
        low ? 10 : 12,
      ),
    );
    buttons(cushion, 0, Y(G.hBox + 0.098), G.zBox, 0.56, 0.26, 3, 3, false);

    /* the box's pedestal, in lacquer, standing on the body floor */
    lacquer.add(
      loft(
        [
          { z: G.zBox - 0.24, hw: 0.36, top: G.hBox - 0.04, bot: G.hBodyFloor, power: 3.0 },
          { z: G.zBox + 0.24, hw: 0.36, top: G.hBox - 0.04, bot: G.hBodyFloor, power: 3.0 },
        ],
        low ? 10 : 12,
      ),
    );

    /* the box's back rail, in leather over an iron frame */
    leather.add(cyl(0.022, 0.022, 0.78, 6, 0, Y(G.hBoxBack), G.zBox + 0.26, 'x'));
    leather.addMirrored(
      taper(0.38, Y(G.hBox + 0.04), G.zBox + 0.26, 0.38, Y(G.hBoxBack), G.zBox + 0.26, 0.017, 0.017, 5),
    );

    /* the footboard the coachman braces against */
    leather.add(box(0.62, 0.03, 0.26, 0, Y(G.hBodyFloor + 0.16), G.zDash + 0.14, 0.42));
  }

  /**
   * The awning: a slightly domed panel of blue-and-white striped duck on four
   * slim brass posts, with a scalloped valance hanging off the edge. It is the
   * silhouette people recognise from three streets away.
   */
  private buildCanopy(matCanopy: THREE.Material, brass: Shell, low: boolean): void {
    const zF = G.zCanopyFront;
    const zR = G.zCanopyRear;
    const hw = G.halfCanopy;
    const zc = (zF + zR) * 0.5;
    const hz = (zR - zF) * 0.5 + 0.12;

    /* --- posts --- */
    for (const z of [zF, zR]) {
      brass.addMirrored(
        taper(G.halfPost, Y(G.hBodyRail - 0.02), z, G.halfPost, Y(G.hCanopy), z, 0.019, 0.015, 6),
      );
      /* the little finial and the socket */
      brass.addMirrored(cyl(0.028, 0.022, 0.035, 7, G.halfPost, Y(G.hCanopy + 0.015), z, 'y'));
      brass.addMirrored(cyl(0.03, 0.026, 0.04, 7, G.halfPost, Y(G.hBodyRail - 0.02), z, 'y'));
    }
    /* the rails the canvas is stretched over */
    brass.addMirrored(taper(G.halfPost, Y(G.hCanopy), zF, G.halfPost, Y(G.hCanopy), zR, 0.012, 0.012, 5));

    /* --- the domed panel --- */
    const nx = low ? 7 : 11;
    const nz = low ? 4 : 6;
    const verts = new Float32Array(nx * nz * 3);
    const uvs = new Float32Array(nx * nz * 2);
    let p = 0;
    let q = 0;
    for (let j = 0; j < nz; j++) {
      const tz = j / (nz - 1);
      const z = zc - hz + tz * hz * 2;
      for (let i = 0; i < nx; i++) {
        const tx = i / (nx - 1);
        const x = (tx - 0.5) * 2 * hw;
        const dome =
          (1 - Math.pow(Math.abs(x) / hw, 2.2)) * (1 - Math.pow(Math.abs(z - zc) / hz, 3) * 0.35);
        verts[p++] = x;
        verts[p++] = Y(G.hCanopy + (G.hCanopyCrown - G.hCanopy) * dome);
        verts[p++] = z;
        /* the stripes run front-to-back, so u follows x */
        uvs[q++] = tx * 1.0;
        uvs[q++] = tz;
      }
    }
    const index = new Uint16Array((nx - 1) * (nz - 1) * 6);
    let k = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        index[k++] = a;
        index[k++] = c;
        index[k++] = b;
        index[k++] = b;
        index[k++] = c;
        index[k++] = d;
      }
    }
    const panel = new THREE.BufferGeometry();
    panel.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    panel.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    panel.setIndex(new THREE.BufferAttribute(index, 1));
    panel.computeVertexNormals();

    /* --- the scalloped valance round the edge --- */
    const per: Array<[number, number]> = [];
    const steps = low ? 20 : 32;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * 4;
      if (t < 1) per.push([-hw + (t % 1) * 2 * hw, zc - hz]);
      else if (t < 2) per.push([hw, zc - hz + (t % 1) * 2 * hz]);
      else if (t < 3) per.push([hw - (t % 1) * 2 * hw, zc + hz]);
      else per.push([-hw, zc + hz - (t % 1) * 2 * hz]);
    }
    const vv = new Float32Array(steps * 2 * 3);
    const vu = new Float32Array(steps * 2 * 2);
    p = 0;
    q = 0;
    for (let i = 0; i < steps; i++) {
      const [x, z] = per[i];
      /* the scallop: a half-wave along the perimeter */
      const scallop = 0.09 + 0.045 * Math.abs(Math.sin((i / steps) * Math.PI * steps * 0.5));
      vv[p++] = x;
      vv[p++] = Y(G.hCanopy + 0.005);
      vv[p++] = z;
      vv[p++] = x;
      vv[p++] = Y(G.hCanopy - scallop);
      vv[p++] = z;
      vu[q++] = (i / steps) * 6;
      vu[q++] = 0;
      vu[q++] = (i / steps) * 6;
      vu[q++] = 1;
    }
    const vi = new Uint16Array(steps * 6);
    k = 0;
    for (let i = 0; i < steps; i++) {
      const j = (i + 1) % steps;
      const a = i * 2;
      const b = i * 2 + 1;
      const c = j * 2;
      const d = j * 2 + 1;
      vi[k++] = a;
      vi[k++] = c;
      vi[k++] = b;
      vi[k++] = b;
      vi[k++] = c;
      vi[k++] = d;
    }
    const valance = new THREE.BufferGeometry();
    valance.setAttribute('position', new THREE.BufferAttribute(vv, 3));
    valance.setAttribute('uv', new THREE.BufferAttribute(vu, 2));
    valance.setIndex(new THREE.BufferAttribute(vi, 1));
    valance.computeVertexNormals();

    const merged = mergeGeometries([panel, valance], false);
    panel.dispose();
    valance.dispose();
    if (merged) {
      this.geometries.push(merged);
      const m = new THREE.Mesh(merged, matCanopy);
      m.name = 'carriage_canopy';
      this.chassis.add(m);
    }
  }

  /**
   * The folding hood, struck and stacked behind the bench: three leather-covered
   * bows nested into each other over a leather boot. It is not deployed — the
   * awning is up instead — and a folded hood is the more interesting shape.
   */
  private buildHood(leather: Shell, iron: Shell): void {
    for (let i = 0; i < 3; i++) {
      const r = 0.44 - i * 0.055;
      const z = G.zHood + i * 0.045;
      const h = G.hHood - 0.34 - i * 0.02;
      const bow = new THREE.TorusGeometry(r, 0.026 - i * 0.003, 4, 12, Math.PI * 0.82);
      bow.rotateY(Math.PI / 2);
      bow.rotateX(Math.PI * 0.5);
      bow.scale(0.62, 1, 1);
      bow.translate(0, Y(h), z);
      leather.add(bow);
    }
    /* the leather boot the folded hood sits in */
    leather.add(
      loft(
        [
          { z: G.zHood - 0.14, hw: 0.47, top: G.hHood - 0.28, bot: G.hBenchBack - 0.16, power: 3.0 },
          { z: G.zHood + 0.04, hw: 0.5, top: G.hHood - 0.2, bot: G.hBenchBack - 0.2, power: 3.0 },
          { z: G.zHood + 0.16, hw: 0.45, top: G.hHood - 0.3, bot: G.hBenchBack - 0.16, power: 3.0 },
        ],
        12,
      ),
    );
    /* the hinge irons either side */
    iron.addMirrored(
      taper(0.48, Y(G.hBenchBack - 0.1), G.zHood - 0.1, 0.48, Y(G.hHood - 0.22), G.zHood + 0.06, 0.013, 0.013, 5),
    );
  }

  /**
   * Brass carriage lamps either side of the box: a tapered body, a bevelled
   * clear lens forward and a red one aft, and a little chimney on top. These are
   * the vehicle's headlights and its brake lights.
   */
  private buildLamps(brass: Shell, iron: Shell): void {
    const x = 0.6;
    const z = 0.72;
    const h = G.hLamp;

    /* body: a tapered brass lantern */
    brass.addMirrored(
      loft(
        [
          { z: z - 0.075, hw: 0.055, top: h + 0.075, bot: h - 0.075, power: 3.4 },
          { z: z + 0.005, hw: 0.062, top: h + 0.085, bot: h - 0.085, power: 3.6 },
          { z: z + 0.08, hw: 0.05, top: h + 0.07, bot: h - 0.07, power: 3.4 },
        ],
        8,
      ).translate(x, 0, 0),
    );
    /* chimney and finial */
    brass.addMirrored(cyl(0.02, 0.03, 0.05, 7, x, Y(h + 0.11), z, 'y'));
    brass.addMirrored(cyl(0.014, 0.02, 0.03, 6, x, Y(h + 0.145), z, 'y'));
    /* the bracket onto the body */
    iron.addMirrored(taper(x, Y(h - 0.02), z, x - 0.075, Y(h - 0.08), z + 0.03, 0.012, 0.012, 5));

    /* lenses */
    const front = new Shell();
    front.addMirrored(box(0.02, 0.11, 0.09, x + 0.052, Y(h), z - 0.005, 0, 0.25, 0));
    const frontGeo = front.build();
    if (frontGeo) {
      this.geometries.push(frontGeo);
      const m = new THREE.Mesh(frontGeo, this.matLamp);
      m.name = 'carriage_lampLens';
      this.chassis.add(m);
    }

    const rear = new Shell();
    rear.addMirrored(box(0.055, 0.075, 0.018, x, Y(h), z + 0.085));
    const rearGeo = rear.build();
    if (rearGeo) {
      this.geometries.push(rearGeo);
      const m = new THREE.Mesh(rearGeo, this.matLampRear);
      m.name = 'carriage_lampRear';
      this.chassis.add(m);
    }

    /* a soft pool of lamplight ahead, high/ultra only */
    const beamShell = new Shell();
    const cone = new THREE.ConeGeometry(0.5, 3.6, 9, 1, true);
    cone.rotateX(-Math.PI / 2);
    cone.translate(x, Y(h - 0.1), z - 1.9);
    beamShell.addMirrored(cone);
    const beamGeo = beamShell.build();
    if (beamGeo) {
      this.geometries.push(beamGeo);
      const beam = new THREE.Mesh(beamGeo, this.matBeam);
      beam.castShadow = false;
      this.beams.add(beam);
    }
    this.beams.visible = false;
  }

  /** Steps, grab handles, the whip socket (empty), and the rear panel frame. */
  private buildDetails(brass: Shell, iron: Shell, leather: Shell, yellow: Shell): void {
    /* the folding mounting step, on brackets under the body side */
    iron.addMirrored(box(0.2, 0.018, 0.12, 0.66, Y(G.hStep), 1.85));
    iron.addMirrored(
      taper(0.6, Y(G.hBodyKeel + 0.02), 1.85, 0.66, Y(G.hStep + 0.01), 1.85, 0.011, 0.011, 4),
    );
    /* a second step up onto the box */
    iron.addMirrored(box(0.17, 0.016, 0.1, 0.62, Y(G.hStep + 0.3), 1.2));

    /* brass grab handles either side of the door opening */
    brass.addMirrored(
      new THREE.TorusGeometry(0.05, 0.009, 4, 10)
        .rotateY(Math.PI / 2)
        .translate(0.605, Y(G.hBodyRail - 0.16), 1.72),
    );

    /* the whip socket on the dash — EMPTY. There is no whip on this carriage. */
    brass.add(cyl(0.017, 0.021, 0.09, 7, 0.3, Y(1.42), G.zDash + 0.02, 'y'));

    /* the rein rail across the dash, where the reins are looped when parked */
    brass.add(cyl(0.013, 0.013, 0.5, 6, 0, Y(1.44), G.zDash - 0.02, 'x'));

    /* a rolled lap rug on the bench edge — the detail that says "in service" */
    leather.add(cyl(0.055, 0.055, 0.42, 8, -0.24, Y(G.hBench + 0.16), G.zBench - 0.2, 'x'));

    /* the yellow frame round the rear licence panel */
    yellow.add(box(0.46, 0.016, 0.012, 0, Y(0.965), G.zBodyRear + 0.004));
    yellow.add(box(0.46, 0.016, 0.012, 0, Y(1.195), G.zBodyRear + 0.004));
    yellow.addMirrored(box(0.016, 0.246, 0.012, 0.222, Y(1.08), G.zBodyRear + 0.004));
  }

  /* ==================================================== the driver's seat */

  /**
   * The coachman's box, seen from the coachman's box.
   *
   * There is no dashboard here and no wheel: you are sitting a metre and a
   * half up on a narrow buttoned cushion with a patent-leather splash board in
   * front of your knees, a brass rein rail across it, and one dapple-grey Paso
   * Fino between the shafts two metres ahead — moving, breathing, and swinging
   * bodily out to the side when you steer, because the front axle is a
   * turntable and the horse goes where it points.
   *
   * The reins are the interface. They run from your fists, over the splash
   * board, along the shafts and up to the bit rings, and they are re-solved
   * every frame in `tickReins` so they stay attached at both ends however far
   * apart those ends get. That is the carriage's answer to "the steering wheel
   * must turn": there is no wheel, and the reins do the job better.
   *
   * The coachman figure himself is *hidden* while this is shown — at
   * `interiorWeight` 1 the camera is inside his skull.
   */
  private buildCockpit(matBrass: THREE.Material, matLeather: THREE.Material): void {
    this.cockpit.name = 'carriage_cockpit';
    this.cockpit.visible = false;

    const parts = createParts();
    const skin = this.mat(0xa9744f, 0, 0.82);
    const cuff = this.mat(0xf1ece0, 0.02, 0.72);

    const brass = new Shell();
    const leather = new Shell();

    /* ---- the driver's own hands, closed on the reins -------------------- */
    const fists = new Shell();
    const sleeves = new Shell();
    for (const s of [-1, 1]) {
      const x = s * COCKPIT.handX;
      const fist = new THREE.SphereGeometry(0.056, 8, 6);
      fist.scale(1, 0.86, 1.2);
      fist.translate(x, Y(COCKPIT.handH), COCKPIT.handZ);
      fists.add(fist);
      /* the thumb along the top of the rein */
      const thumb = new THREE.CapsuleGeometry(0.017, 0.05, 3, 5);
      thumb.rotateX(Math.PI / 2);
      thumb.translate(x - s * 0.012, Y(COCKPIT.handH + 0.035), COCKPIT.handZ - 0.038);
      fists.add(thumb);
      /* Forearm, running *down and outward* to the elbow.
       *
       * The first version sent it up and back toward the shoulder, which is
       * anatomically where an arm goes and visually a disaster: the far end
       * landed 14 cm from the lens, inside the near plane, so each arm was a
       * fat cone that grew out of nothing and was sliced off by the near clip.
       * Elbows-down-and-out is how you actually hold a pair of reins, and it
       * takes the arms out through the bottom corners of the frame where they
       * belong. */
      fists.add(
        taperTube(
          x,
          Y(COCKPIT.handH + 0.01),
          COCKPIT.handZ + 0.04,
          x + s * 0.14,
          Y(COCKPIT.handH - 0.26),
          COCKPIT.handZ + 0.48,
          0.036,
          0.044,
          7,
        ),
      );
      /* a guayabera cuff, two-thirds of the way to the elbow */
      sleeves.add(
        taperTube(
          x + s * 0.085,
          Y(COCKPIT.handH - 0.14),
          COCKPIT.handZ + 0.29,
          x + s * 0.115,
          Y(COCKPIT.handH - 0.21),
          COCKPIT.handZ + 0.4,
          0.047,
          0.052,
          7,
        ),
      );
    }
    const fistGeo = fists.build();
    if (fistGeo) {
      this.geometries.push(fistGeo);
      const m = new THREE.Mesh(fistGeo, skin);
      m.name = 'carriage_cockpit_hands';
      this.cockpit.add(m);
    }
    const sleeveGeo = sleeves.build();
    if (sleeveGeo) {
      this.geometries.push(sleeveGeo);
      this.cockpit.add(new THREE.Mesh(sleeveGeo, cuff));
    }

    /* ---- the splash board, from the inside ------------------------------
     * From outside it is a silhouette; from the box it is the thing your
     * knees are against, so it gets a leather face, a rolled top edge and the
     * brass rail the reins are looped over when the carriage is parked. */
    leather.add(box(0.78, 0.46, 0.02, 0, Y(1.28), G.zDash + 0.06, 0.16));
    leather.add(cyl(0.03, 0.03, 0.82, 8, 0, Y(1.52), G.zDash + 0.02, 'x'));
    brass.addMirrored(cyl(0.015, 0.015, 0.05, 6, 0.39, Y(1.54), G.zDash - 0.02, 'x'));
    /* the footboard's forward lip, and a brass tread strip on it */
    leather.add(box(0.66, 0.03, 0.3, 0, Y(G.hBodyFloor + 0.18), G.zDash + 0.2, 0.42));
    brass.add(box(0.6, 0.008, 0.05, 0, Y(G.hBodyFloor + 0.235), G.zDash + 0.26, 0.42));

    /* ---- the brass taxímetro, clamped to the rein rail ------------------- */
    this.meter = new MeterDisplay();
    if (this.meter.texture) this.textures.push(this.meter.texture);
    const meterMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.meter.texture,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: this.meter.texture,
      emissiveIntensity: 0.5,
      metalness: 0.15,
      roughness: 0.5,
    });
    this.materials.push(meterMat);
    const meterPod = new THREE.Group();
    meterPod.position.set(-0.4, Y(1.6), G.zDash + 0.02);
    meterPod.rotation.set(-0.36, 0.34, 0);
    this.cockpit.add(meterPod);
    const meterCase = new THREE.BoxGeometry(0.19, 0.13, 0.09);
    meterCase.translate(0, 0, -0.045);
    this.geometries.push(meterCase);
    meterPod.add(new THREE.Mesh(meterCase, matBrass));
    const meterGlass = new THREE.PlaneGeometry(0.158, 0.099);
    meterGlass.translate(0, 0, 0.002);
    this.geometries.push(meterGlass);
    meterPod.add(new THREE.Mesh(meterGlass, meterMat));
    /* the bracket down to the rail */
    brass.add(taperTube(-0.4, Y(1.54), G.zDash - 0.01, -0.4, Y(1.5), G.zDash + 0.02, 0.011, 0.011, 5));

    /* ---- the box: cushion edge, back rail and the lamps' brass backs ----- */
    leather.addMirrored(box(0.03, 0.09, 0.4, 0.4, Y(G.hBox + 0.06), G.zBox));
    brass.addMirrored(cyl(0.05, 0.05, 0.03, 10, 0.44, Y(G.hLamp + 0.06), G.zBox - 0.36, 'x'));

    const brassGeo = brass.build();
    if (brassGeo) {
      this.geometries.push(brassGeo);
      this.cockpit.add(new THREE.Mesh(brassGeo, matBrass));
    }
    const leatherGeo = leather.build();
    if (leatherGeo) {
      this.geometries.push(leatherGeo);
      this.cockpit.add(new THREE.Mesh(leatherGeo, matLeather));
    }

    for (const m of parts.materials) this.materials.push(m);
    for (const g of parts.geometries) this.geometries.push(g);
    for (const t of parts.textures) this.textures.push(t);

    this.chassis.add(this.cockpit);

    /* ---- the reins ------------------------------------------------------
     * Under `object3d`, not `chassis`: one end is bolted to the leaning body
     * and the other to a horse on a yawing turntable, so the only frame both
     * can be expressed in without a per-frame matrix inverse is the rigid
     * body's own. */
    const reinMat = new THREE.MeshStandardMaterial({
      color: P.leather,
      metalness: 0.05,
      roughness: 0.55,
      side: THREE.DoubleSide,
    });
    this.materials.push(reinMat);
    this.reins = new ReinRibbon(reinMat, 2, 12, 0.013);
    this.object3d.add(this.reins.mesh);
  }

  /**
   * Re-solve both reins from the driver's fists to the bit rings.
   *
   * Both endpoints are pushed into the rigid body's frame — the hands through
   * the cosmetic lean, the bit rings through the turntable — which is what
   * keeps the strap attached at both ends while the body rocks on its springs
   * and the horse's head nods a hand's width every stride.
   */
  private tickReins(): void {
    const reins = this.reins;
    if (!reins) return;
    this.chassis.updateMatrix();
    this.harness.updateMatrix();
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      this.reinHand
        .set(side * COCKPIT.handX, Y(COCKPIT.handH + 0.01), COCKPIT.handZ - 0.03)
        .applyMatrix4(this.chassis.matrix);
      this.horse.bitAnchor(side, this.reinBit);
      this.reinBit.add(this.horseRoot.position).applyMatrix4(this.harness.matrix);
      reins.update(
        i,
        this.reinHand.x,
        this.reinHand.y,
        this.reinHand.z,
        this.reinBit.x,
        this.reinBit.y,
        this.reinBit.z,
        COCKPIT.reinSag,
      );
    }
  }

  /** The licence panel on the back of the body. */
  private buildPanel(): void {
    const tex = makePanelTexture();
    if (!tex) return;
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      metalness: 0.15,
      roughness: 0.45,
    });
    this.materials.push(mat);
    const geo = new THREE.PlaneGeometry(0.42, 0.21);
    geo.rotateY(Math.PI);
    geo.translate(0, Y(1.08), G.zBodyRear + 0.005);
    this.geometries.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = 'carriage_panel';
    m.castShadow = false;
    this.chassis.add(m);
  }

  /**
   * The shafts: two curved yellow poles from the turntable forward to the
   * horse's shoulder, plus the traces that actually do the pulling. Authored in
   * the shaft group's own space, whose origin is the FORWARD end.
   */
  private buildShafts(matYellow: THREE.Material, matLeather: THREE.Material, matIron: THREE.Material): void {
    const wood = new Shell();
    const strapShell = new Shell();
    const ironShell = new Shell();

    /* shaft-group space: origin at (0, hShaftTip, zShaftTip). The rear end of
     * the shaft is at z = zDash − zShaftTip back along +Z, and converges toward
     * the centreline so that yawing the assembly barely moves it. */
    const zRear = G.zDash - G.zShaftTip;
    const dyRear = G.hShaftRoot - G.hShaftTip;

    for (const s of [4, 3, 2, 1, 0]) {
      /* five chords along a quadratic bezier gives a properly swept pole */
      const t0 = s / 5;
      const t1 = (s + 1) / 5;
      const at = (t: number): [number, number, number] => {
        const mt = 1 - t;
        /* control point pulls the shaft up in the middle, as a real one bows */
        const cx = (G.halfShaft + 0.16) * 0.5;
        const cy = dyRear * 0.5 + 0.1;
        const cz = zRear * 0.5;
        return [
          mt * mt * G.halfShaft + 2 * mt * t * cx + t * t * 0.16,
          mt * mt * 0 + 2 * mt * t * cy + t * t * dyRear,
          mt * mt * 0 + 2 * mt * t * cz + t * t * zRear,
        ];
      };
      const a = at(t0);
      const b = at(t1);
      wood.addMirrored(
        taper(a[0], a[1], a[2], b[0], b[1], b[2], 0.026 - t0 * 0.006, 0.026 - t1 * 0.006, 6),
      );
    }
    /* the shaft tips, capped in brass, and the crossbar between them */
    ironShell.addMirrored(cyl(0.021, 0.017, 0.05, 7, G.halfShaft, 0, -0.02, 'z'));
    ironShell.add(cyl(0.014, 0.014, G.halfShaft * 2, 5, 0, 0.02, 0.32, 'x'));

    /* the traces, continuing the horse's from its sides back to the
     * swingletree. Slack leather, so a small mismatch at the horse end as it
     * bobs is exactly right. */
    const zSwing = G.zSwingletree - G.zShaftTip;
    strapShell.addMirrored(
      taper(0.3, 0.03, G.zHorse + 0.66 - G.zShaftTip, 0.29, 0.62 - G.hShaftTip, zSwing, 0.016, 0.016, 5),
    );

    /* The reins used to be baked in here, as a pair of tapers from the pad
     * terrets back to the box. They are not, any more, and they cannot be:
     * this group pivots with the turntable, so a rein authored in it swung
     * away from the driver's hands by more than a metre at full lock. They are
     * solved every frame instead — see `ReinRibbon` and `tickReins`.
     */

    this.emitTo(wood.build(), matYellow, 'shafts', this.shaftGroup);
    this.emitTo(strapShell.build(), matLeather, 'traces', this.shaftGroup);
    this.emitTo(ironShell.build(), matIron, 'shaftIrons', this.shaftGroup);
  }

  private emitTo(
    geo: THREE.BufferGeometry | null,
    material: THREE.Material,
    name: string,
    parent: THREE.Object3D,
  ): void {
    if (!geo) return;
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `carriage_${name}`;
    parent.add(mesh);
  }

  /**
   * The coachman on the box and the fare on the bench.
   *
   * The driver is an older man in a guayabera and a straw hat, sitting square
   * with the reins in both hands. No whip: this carriage does not carry one.
   */
  private buildFigures(): void {
    const skin = this.mat(0xa9744f, 0, 0.82);
    const dark = this.mat(0x2a2a33, 0.05, 0.78);
    const straw = this.mat(0xd9c48a, 0.02, 0.7);
    const guayabera = this.mat(0xf1ece0, 0.02, 0.72);

    /* ---------------------------------------------------- the coachman --- */
    const dz = G.zBox;
    const dy = G.hBox + 0.1;

    const torso = new THREE.CapsuleGeometry(0.16, 0.3, 4, 10);
    torso.scale(1, 1, 0.82);
    torso.translate(0, Y(dy + 0.27), dz + 0.06);
    this.geometries.push(torso);
    this.driver.add(new THREE.Mesh(torso, guayabera));

    const dLimbs = new Shell();
    const head = new THREE.SphereGeometry(0.115, 12, 10);
    head.translate(0, Y(dy + 0.56), dz + 0.04);
    dLimbs.add(head);
    /* arms forward, hands together on the reins — the far end of this taper is
     * `COCKPIT.handX/handH/handZ`, and has to stay there: the reins are
     * anchored to those numbers in every camera */
    dLimbs.addMirrored(
      taper(0.15, Y(dy + 0.36), dz + 0.02, COCKPIT.handX, Y(COCKPIT.handH), COCKPIT.handZ, 0.046, 0.04, 6),
    );
    const dLimbGeo = dLimbs.build();
    if (dLimbGeo) {
      this.geometries.push(dLimbGeo);
      this.driver.add(new THREE.Mesh(dLimbGeo, skin));
    }

    const dLegs = new Shell();
    dLegs.addMirrored(taper(0.11, Y(dy - 0.02), dz - 0.04, 0.13, Y(dy - 0.1), dz - 0.4, 0.062, 0.055, 6));
    dLegs.addMirrored(taper(0.13, Y(dy - 0.1), dz - 0.4, 0.14, Y(G.hBodyFloor + 0.2), dz - 0.46, 0.055, 0.05, 6));
    const dLegGeo = dLegs.build();
    if (dLegGeo) {
      this.geometries.push(dLegGeo);
      this.driver.add(new THREE.Mesh(dLegGeo, dark));
    }

    /* the straw hat — a panama, which is what they actually wear */
    const hat = new Shell();
    hat.add(cyl(0.2, 0.21, 0.022, 14, 0, Y(dy + 0.63), dz + 0.04, 'y'));
    hat.add(cyl(0.115, 0.125, 0.1, 14, 0, Y(dy + 0.69), dz + 0.04, 'y'));
    const hatGeo = hat.build();
    if (hatGeo) {
      this.geometries.push(hatGeo);
      this.driver.add(new THREE.Mesh(hatGeo, straw));
    }
    const band = new THREE.TorusGeometry(0.122, 0.014, 4, 14);
    band.rotateX(Math.PI / 2);
    band.translate(0, Y(dy + 0.66), dz + 0.04);
    this.geometries.push(band);
    this.driver.add(new THREE.Mesh(band, dark));

    this.chassis.add(this.driver);

    /* ------------------------------------------------------- the fare --- */
    const pz = G.zBench;
    const py = G.hBench + 0.11;

    const pTorso = new THREE.CapsuleGeometry(0.155, 0.28, 4, 10);
    pTorso.scale(1, 1, 0.82);
    pTorso.translate(-0.18, Y(py + 0.26), pz + 0.08);
    this.geometries.push(pTorso);
    this.passenger.add(new THREE.Mesh(pTorso, this.matPassenger));

    const pLimbs = new Shell();
    const pHead = new THREE.SphereGeometry(0.115, 12, 10);
    pHead.translate(-0.18, Y(py + 0.54), pz + 0.06);
    pLimbs.add(pHead);
    /* an arm along the body rail, taking in the view */
    pLimbs.add(taper(-0.32, Y(py + 0.34), pz + 0.04, -0.5, Y(py + 0.24), pz - 0.16, 0.045, 0.04, 6));
    pLimbs.add(taper(-0.06, Y(py + 0.32), pz + 0.02, -0.02, Y(py + 0.06), pz - 0.24, 0.045, 0.04, 6));
    /* legs into the footwell */
    pLimbs.add(taper(-0.25, Y(py - 0.02), pz - 0.06, -0.28, Y(G.hBodyFloor + 0.16), pz - 0.42, 0.06, 0.052, 6));
    pLimbs.add(taper(-0.1, Y(py - 0.02), pz - 0.06, -0.12, Y(G.hBodyFloor + 0.16), pz - 0.44, 0.06, 0.052, 6));
    const pLimbGeo = pLimbs.build();
    if (pLimbGeo) {
      this.geometries.push(pLimbGeo);
      this.passenger.add(new THREE.Mesh(pLimbGeo, skin));
    }

    this.passenger.visible = false;
    this.passenger.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    this.chassis.add(this.passenger);
  }

  /**
   * THE WHEELS. Big at the back, small at the front, many slender spokes,
   * yellow-painted felloes and naves, thin black iron tyres — this is the thing
   * that makes the vehicle recognisable at any distance, so it gets the detail.
   *
   * Real carriage wheels are **dished**: the felloe stands proud of the nave on
   * the outboard side so the wheel resists side thrust, and the spokes are
   * **staggered** into two rows of mortises in the nave so the nave doesn't
   * split. Both are here, and both are what stop it looking like a bicycle.
   */
  private buildWheels(
    matYellow: THREE.Material,
    matIron: THREE.Material,
    matBrass: THREE.Material,
    seg: number,
    low: boolean,
  ): void {
    /** Build one wheel; `dish` is +1 for a right-hand wheel, −1 for a left. */
    const makeWheel = (
      radius: number,
      spokes: number,
      dish: number,
    ): { wood: THREE.BufferGeometry | null; iron: THREE.BufferGeometry | null; brass: THREE.BufferGeometry | null } => {
      const wood = new Shell();
      const iron = new Shell();
      const brass = new Shell();

      const tyreOuter = radius;
      const tyreInner = radius - G.tyreThickness;
      const felloeOuter = tyreInner;
      const felloeInner = felloeOuter - (radius > 0.45 ? 0.085 : 0.07);
      const width = radius > 0.45 ? 0.09 : 0.078;
      const dx = dish * G.wheelDish;

      /* iron tyre, and the felloe it is shrunk onto */
      iron.add(ring(tyreInner, tyreOuter, width * 0.82, seg, dx));
      wood.add(ring(felloeInner, felloeOuter, width, seg, dx));

      /* the nave: a turned barrel with two collars */
      const hubR = radius > 0.45 ? G.hubRadius : G.hubRadius * 0.86;
      const hubL = radius > 0.45 ? G.hubLength : G.hubLength * 0.85;
      wood.add(cyl(hubR, hubR, hubL, low ? 8 : 12, 0, 0, 0, 'x'));
      wood.add(cyl(hubR * 1.22, hubR * 1.22, 0.026, low ? 8 : 12, -hubL * 0.36, 0, 0, 'x'));
      wood.add(cyl(hubR * 1.22, hubR * 1.22, 0.026, low ? 8 : 12, hubL * 0.34, 0, 0, 'x'));
      /* the brass axle cap on the outboard face */
      brass.add(cyl(hubR * 0.62, hubR * 0.8, 0.05, low ? 8 : 10, dish * (hubL * 0.5 + 0.02), 0, 0, 'x'));

      /* the spokes, staggered into two rows of mortises */
      const rootR = hubR * 0.92;
      const tipR = felloeInner + 0.02;
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        const s = Math.sin(a);
        const c = Math.cos(a);
        const stagger = (i % 2 === 0 ? 1 : -1) * G.spokeStagger;
        wood.add(
          taper(
            stagger,
            s * rootR,
            c * rootR,
            dx,
            s * tipR,
            c * tipR,
            G.spokeRootR,
            G.spokeTipR,
            low ? 4 : 5,
          ),
        );
      }

      return { wood: wood.build(), iron: iron.build(), brass: brass.build() };
    };

    /* four geometries: two sizes × two hands */
    const built = [
      makeWheel(G.frontRadius, G.frontSpokes, -1),
      makeWheel(G.frontRadius, G.frontSpokes, 1),
      makeWheel(G.rearRadius, G.rearSpokes, -1),
      makeWheel(G.rearRadius, G.rearSpokes, 1),
    ];

    const layout = [
      { x: -S.halfTrackFront, z: G.zFrontAxle, geo: 0 },
      { x: S.halfTrackFront, z: G.zFrontAxle, geo: 1 },
      { x: -S.halfTrackRear, z: G.zRearAxle, geo: 2 },
      { x: S.halfTrackRear, z: G.zRearAxle, geo: 3 },
    ];
    /* rest pose: exactly what setSuspension writes at static compression */
    const restY = S.anchorY - S.restLength * (1 - G.staticCompression);

    for (let i = 0; i < 4; i++) {
      const l = layout[i];
      const b = built[l.geo];

      const root = new THREE.Group();
      root.position.set(l.x, restY - (i < 2 ? G.frontHubDrop : 0), l.z);

      const steer = new THREE.Group();
      const spin = new THREE.Group();

      for (const [geo, material] of [
        [b.wood, matYellow],
        [b.iron, matIron],
        [b.brass, matBrass],
      ] as const) {
        if (!geo) continue;
        this.geometries.push(geo);
        const m = new THREE.Mesh(geo, material);
        m.castShadow = true;
        spin.add(m);
      }

      steer.add(spin);
      root.add(steer);
      this.object3d.add(root);

      this.wheelRoots.push(root);
      this.wheelSteer.push(steer);
      this.wheelSpin.push(spin);
    }
  }
}

/* --------------------------------------------------------------- helpers */

const ARCHETYPE_COLORS = PALETTE.facade;

/** Stable per-archetype colour so the same fare always looks the same. */
function archetypeColor(id?: string): number {
  if (!id) return ARCHETYPE_COLORS[4];
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ARCHETYPE_COLORS[(h >>> 0) % ARCHETYPE_COLORS.length];
}
