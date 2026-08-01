/**
 * Loco Lift — the Chinchorreo party bus, built entirely out of code.
 *
 * Eleven metres of retired American school bus, repainted for the chinchorreo:
 * bright school-bus yellow with lime green on the door, flares, skirt, mirror
 * arms and rear bumper, a red hood, cowl and grille surround with a little red
 * shield badge, and heavy chrome everywhere it can possibly be justified.
 * Hand-painted "Chinchorreo" script across the front header, "CHINCHORREO 365"
 * down the flanks, red vinyl seats visible through a long row of open windows,
 * a black rubber rub-rail the length of the body and a red/white dashed
 * reflective strip along the skirt.
 *
 * And lights. A roof light bar, red marker lamps along both headers, festoon
 * strings running the roof edge and the window line, colour-cycling interior
 * lighting, underglow, and a lit destination sign — all of which pulse in time
 * with the music via `setBeatSource`, a one-property structural interface so
 * this file never learns that an audio module exists.
 *
 * Everything is procedural Three.js geometry and Canvas2D textures — no files,
 * no downloads, works fully offline. Static parts are merged per material so
 * the whole bus draws in roughly two dozen calls; anything animated (wheels,
 * steering, every light group) stays separate.
 *
 * Hierarchy:
 *   object3d ─┬─ chassis          ← leans/heaves cosmetically over the body
 *             │    ├─ merged shells, interior, lights, decals
 *             │    └─ passenger    ← toggled by setSeatOccupied
 *             └─ wheelRoot[i]     ← suspension travel
 *                  └─ steer[i]    ← front wheels only
 *                       └─ spin[i] ← the rears carry two tyres each
 *
 * Local axes match the physics body: forward = -Z, right = +X, up = +Y, and
 * y = BUS_GEO.groundLocalY is where the tyres touch at static ride height.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from '../core/Config';
import { clamp, clamp01, damp } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { BUS_FESTOON_COLORS, BUS_GEO, BUS_PAINT, BUS_SUSPENSION, BUS_WHEEL_LAYOUT } from './BusTuning';
import {
  MeterDisplay,
  addLit,
  buildGauge,
  buildHands,
  createParts,
  makeGaugeFace,
  makeSwitchStrip,
  needleAngle,
  setPanelLights,
} from './CockpitKit';
import { safeClearcoatRoughness, setPaintForInterior } from './VehicleTuning';
import type { BeatSource, VehicleModel } from './VehicleTuning';

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------- geometry utilities */

/** Accumulates geometry for one material, then merges it into a single mesh. */
class Shell {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
  }

  /** Add `geo` and its mirror across the YZ plane — the bus is symmetric. */
  addMirrored(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
    const mirror = geo.clone();
    mirror.scale(-1, 1, 1);
    /* scaling by -1 inverts winding; flip it back so faces stay outward */
    const idx = mirror.getIndex();
    if (idx) {
      const arr = idx.array as Uint16Array | Uint32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const t = arr[i];
        arr[i] = arr[i + 2];
        arr[i + 2] = t;
      }
      idx.needsUpdate = true;
    }
    const nrm = mirror.getAttribute('normal');
    if (nrm) {
      for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
      nrm.needsUpdate = true;
    }
    this.parts.push(mirror);
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

/** Axis-aligned box at (x,y,z), optionally rotated (radians, applied X→Y→Z). */
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
  open = false,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

const tubeA = /* @__PURE__ */ new THREE.Vector3();
const tubeB = /* @__PURE__ */ new THREE.Vector3();
const tubeDir = /* @__PURE__ */ new THREE.Vector3();
const tubeQ = /* @__PURE__ */ new THREE.Quaternion();
const tubeM = /* @__PURE__ */ new THREE.Matrix4();
const tubeScale = /* @__PURE__ */ new THREE.Vector3(1, 1, 1);

/** A capped tube running from a to b — poles, rails, mirror stalks, limbs. */
function tube(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  seg = 8,
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
    tubeM.compose(tubeA, tubeQ, tubeScale);
    g.applyMatrix4(tubeM);
  }
  return g;
}

/* ----------------------------------------------------------------- textures */

/** Canvas2D is unavailable in headless builds; every caller tolerates null. */
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

/** Flank livery: bold black CHINCHORREO 365 on a transparent background. */
function makeFlankTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(1024, 160);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.clearRect(0, 0, 1024, 160);

  g.fillStyle = '#141418';
  g.font = 'bold 104px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('CHINCHORREO', 420, 84);

  /* the route number, boxed like a school-district fleet number */
  g.fillStyle = '#141418';
  g.fillRect(770, 22, 216, 120);
  g.fillStyle = '#f5b81c';
  g.font = 'bold 96px "Arial Black", Impact, sans-serif';
  g.fillText('365', 878, 86);

  return canvasTexture(c);
}

/** Front header: hand-painted "Chinchorreo" script over the windscreen. */
function makeScriptTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(1024, 192);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.clearRect(0, 0, 1024, 192);

  /* painted by hand, so it gets a soft shadow and a highlight, not flat ink */
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic bold 118px "Brush Script MT", "Segoe Script", "Comic Sans MS", cursive';

  g.fillStyle = 'rgba(20,12,4,0.45)';
  g.fillText('Chinchorreo', 518, 106);

  g.strokeStyle = '#2a1206';
  g.lineWidth = 9;
  g.strokeText('Chinchorreo', 512, 98);
  g.fillStyle = '#fff3d0';
  g.fillText('Chinchorreo', 512, 98);

  /* a little flourish underline, the way a rótulo painter would finish it */
  g.strokeStyle = '#fff3d0';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(210, 160);
  g.bezierCurveTo(400, 182, 640, 182, 830, 156);
  g.stroke();

  return canvasTexture(c);
}

/** The lit destination roll sign. */
function makeSignTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(512, 96);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#120d06';
  g.fillRect(0, 0, 512, 96);

  g.fillStyle = '#ffd166';
  g.font = 'bold 46px "Trebuchet MS", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('365  SAN VIEJO', 256, 34);

  g.fillStyle = '#ff7bc0';
  g.font = 'bold 30px "Trebuchet MS", sans-serif';
  g.fillText('· CHINCHORREO ·', 256, 72);

  return canvasTexture(c);
}

/** Rear plate. */
function makePlateTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256, 128);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#f5f0e6';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#1d3557';
  g.lineWidth = 8;
  g.strokeRect(6, 6, 244, 116);

  g.fillStyle = '#1d3557';
  g.font = 'bold 22px "Trebuchet MS", sans-serif';
  g.textAlign = 'center';
  g.fillText('PUERTO RICO', 128, 34);
  g.font = 'bold 52px "Arial Black", sans-serif';
  g.fillText('CHIN·365', 128, 90);

  return canvasTexture(c);
}

/* ================================================================ the model */

const G = BUS_GEO;

/** z of the rearmost body panel, and the length of the passenger box. */
const SIDE_Z0 = G.zCowl;
const SIDE_Z1 = G.zBodyRear;
const SIDE_MID = (SIDE_Z0 + SIDE_Z1) * 0.5;
const SIDE_LEN = SIDE_Z1 - SIDE_Z0;

/** wheel arch openings, as z ranges the lower bodywork has to skip */
const ARCH_F0 = G.zFrontAxle - G.archRadius;
const ARCH_F1 = G.zFrontAxle + G.archRadius;
const ARCH_R0 = G.zRearAxle - G.archRadius;
const ARCH_R1 = G.zRearAxle + G.archRadius;

/**
 * How far the hue-cycling ceiling glow drops while the cockpit camera is live.
 * 0.4 puts its beat peak just under the bloom threshold.
 */
const COCKPIT_GLOW_SCALE = 0.4;

/**
 * The driver's station, in one block.
 *
 * `eye` is derived, then corrected against what the cab can actually show.
 *
 * The driver's cushion top is at `yFloor + 0.60 = 0.92` and a seated adult's
 * eye is 0.64–0.80 m above the cushion, so anything from 1.56 to 1.72 is
 * defensible. It ended up at the low end, 1.62, and the reason is worth
 * recording: this cab's usable glass is a *band*, bounded below by the dash's
 * top edge and above by the destination board let into the windscreen, and at
 * 1.70 the eye sat so high in that band that the instrument pod — which has to
 * live below the dash line — fell almost entirely out of the bottom of a 68°
 * frame. Dropping 8 cm buys 14° of cluster and costs nothing: the eye is still
 * 0.30 m above the wheel's hub and 0.19 m above the dash, i.e. looking over it
 * rather than through it.
 *
 * z = −3.45 puts the eye a head's depth in front of the (relocated) seat back
 * at −3.32 and 0.85 m back from the windscreen. Both halves of that mattered.
 * Sitting *behind* the backrest — which the first pass did — cut the top edge
 * of the seat across the bottom of the frame 14 cm from the lens, inside the
 * near plane, so it clipped into a hole. Sitting too close to the glass made
 * the route board 100° wide. From here the nearest point of that enormous
 * 0.5 m wheel is 0.44 m away, outside `CONFIG.camera.near` (0.30) with room
 * for shake. x matches the steering
 * column at −0.66: a school bus is left-hand drive with the door on the
 * opposite side, which is why the aisle opens to your right.
 */
const BUS_COCKPIT = {
  eye: /* @__PURE__ */ new THREE.Vector3(-0.66, 1.62, -3.45),
  /** the cluster sits on the column centreline */
  podX: -0.66,
  /** how far the cluster leans back, radians (≈22°) */
  podTilt: 0.38,
  /** how far the hands travel round the rim before they stop, radians */
  handLock: 0.6,
  needleRate: 6.5,
  /** the meter's flag drop, dollars — a bus fare, so lower than the Jeep's */
  fareFlag: 2.0,
  farePerMetre: 0.0011,
} as const;

export class BusModel implements VehicleModel {
  /** root; Vehicle copies the rigid body transform onto this every frame */
  readonly object3d = new THREE.Group();
  /** everything that leans cosmetically over the chassis */
  readonly chassis = new THREE.Group();

  /** suspension nodes, one per strut — Vehicle sets their local Y */
  readonly wheelRoots: THREE.Group[] = [];
  /** steering nodes (front wheels turn, rear wheels do not) */
  readonly wheelSteer: THREE.Group[] = [];
  /** spin nodes — the rears hold two tyres each */
  readonly wheelSpin: THREE.Group[] = [];

  private readonly steeringWheel = new THREE.Group();
  private readonly passenger = new THREE.Group();
  private readonly beams = new THREE.Group();
  /** door glazing, accumulated by buildDoor and merged by buildGlass */
  private readonly doorGlass = new Shell();

  /* ------------------------------------------------------- driver's seat */
  /** built once, parked hidden — Three skips an invisible subtree wholesale */
  private readonly cockpit = new THREE.Group();
  /** hands, on their own node so they can lag the rim at full lock */
  private readonly handRig = new THREE.Group();
  private needleSpeed: THREE.Group | null = null;
  private needleRpm: THREE.Group | null = null;
  private needleAir: THREE.Group | null = null;
  private meter: MeterDisplay | null = null;
  /** backlit interior surfaces, at their daylight intensity */
  private readonly cockpitLit: Array<{ material: THREE.MeshStandardMaterial; day: number }> = [];
  private cockpitOn = false;
  private targetSpeedNeedle = 0;
  private targetRpmNeedle = 0;
  private fareDistance = 0;
  private fareClock = 0;

  /* live materials — every one of these is animated */
  private readonly matHeadlight: THREE.MeshStandardMaterial;
  private readonly matTaillight: THREE.MeshStandardMaterial;
  private readonly matMarker: THREE.MeshStandardMaterial;
  private readonly matLightBar: THREE.MeshStandardMaterial;
  private readonly matTurn: THREE.MeshStandardMaterial;
  private readonly matInterior: THREE.MeshStandardMaterial;
  private readonly matUnderglow: THREE.MeshStandardMaterial;
  private readonly matSign: THREE.MeshStandardMaterial;
  private readonly matBeam: THREE.MeshBasicMaterial;
  private readonly matPassenger: THREE.MeshStandardMaterial;
  private readonly festoon: THREE.MeshStandardMaterial[] = [];

  /** decided before the materials are built; gates the clearcoat lobe */
  private readonly lowDetail: boolean;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];

  private readonly spinAccum = [0, 0, 0, 0];

  /* --- light show state --- */
  private beatSource: BeatSource | null = null;
  private freeBeat = 0;
  private lastBeatPhase = 0;
  /** counts beats so the chase and the strobe can pick different patterns */
  private beatIndex = 0;
  private showScale = 1;
  private boostGlow = 0;
  private headlightsOn = false;
  private nightMix = 0;
  private idlePhase = 0;
  private hornFlash = 0;
  private airBrakeSquat = 0;
  private airBrakeVisual = 0;
  private beamsAllowed = true;

  /* cosmetic lean, kept so the air-brake squat can add to it */
  private leanPitch = 0;
  private leanRoll = 0;
  private leanHeave = 0;

  private readonly tmpColor = new THREE.Color();

  constructor(quality: QualityTier = 'high') {
    this.lowDetail = quality === 'low';
    this.object3d.name = 'ChinchorreoBus';
    this.chassis.name = 'busChassis';
    this.beams.name = 'headlightBeams';
    this.object3d.add(this.chassis);

    /* ------------------------------------------------------------ materials */
    /* Painted panels are dielectrics — see the note in `JeepModel`. A
     * hand-painted chinchorreo bus is *more* saturated than a taxi, not less,
     * and it was losing a third of its diffuse to a metalness value that
     * described nothing physical. Chrome and steel stay metal; 0.75 was the
     * odd one out, describing neither a metal nor a paint. */
    const matBody = this.paint(BUS_PAINT.body, 0.34, 1.0, 0.07);
    const matBodyDark = this.paint(BUS_PAINT.bodyDark, 0.34, 1.0, 0.07);
    const matLime = this.paint(BUS_PAINT.lime, 0.34, 1.0, 0.07);
    const matRed = this.paint(BUS_PAINT.red, 0.34, 1.0, 0.07);
    const matRedDark = this.paint(BUS_PAINT.redDark, 0.34, 1.0, 0.07);
    const matChrome = this.mat(BUS_PAINT.chrome, 1.0, 0.14, 1.3);
    const matSteel = this.mat(BUS_PAINT.steel, 1.0, 0.45);
    const matMatte = this.mat(BUS_PAINT.matte, 0.12, 0.85);
    const matRubber = this.mat(BUS_PAINT.rubber, 0.04, 0.95);
    const matSeat = this.mat(BUS_PAINT.seat, 0.1, 0.62);
    const matSeatDark = this.mat(BUS_PAINT.seatDark, 0.1, 0.7);
    const matWhite = this.mat(0xf2ede0, 0.1, 0.6);

    const matGlass = new THREE.MeshStandardMaterial({
      color: BUS_PAINT.glass,
      metalness: 0.1,
      roughness: 0.06,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
    });
    this.materials.push(matGlass);

    this.matHeadlight = this.emissiveMat(
      BUS_PAINT.headlight,
      G.headlightIntensityOff,
      0.2,
      0.24,
    );
    this.matTaillight = this.emissiveMat(
      BUS_PAINT.taillight,
      G.taillightIntensityOff,
      0.1,
      0.34,
    );
    this.matMarker = this.emissiveMat(BUS_PAINT.taillight, G.markerIntensity, 0.1, 0.4);
    this.matLightBar = this.emissiveMat(BUS_PAINT.amber, G.lightBarIntensity, 0.15, 0.3);
    this.matTurn = this.emissiveMat(BUS_PAINT.amber, 0.6, 0.15, 0.35);
    this.matInterior = this.emissiveMat(BUS_PAINT.ceiling, G.interiorIntensity, 0.05, 0.7);
    this.matSign = this.emissiveMat(BUS_PAINT.sign, G.signIntensity, 0.05, 0.5);

    this.matUnderglow = new THREE.MeshStandardMaterial({
      color: BUS_PAINT.underglow,
      emissive: new THREE.Color(BUS_PAINT.underglow),
      emissiveIntensity: G.underglowIntensity * 0.4,
      metalness: 0.1,
      roughness: 0.4,
      transparent: true,
      opacity: 0.85,
    });
    this.materials.push(this.matUnderglow);

    this.matBeam = new THREE.MeshBasicMaterial({
      color: BUS_PAINT.headlight,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.materials.push(this.matBeam);

    for (let i = 0; i < BUS_FESTOON_COLORS.length; i++) {
      this.festoon.push(
        this.emissiveMat(BUS_FESTOON_COLORS[i], G.festoonIntensity, 0.1, 0.35),
      );
    }

    this.matPassenger = this.mat(PALETTE.facade[4], 0.1, 0.75);

    /* --------------------------------------------------------------- shells */
    const body = new Shell();
    const bodyDark = new Shell();
    const lime = new Shell();
    const red = new Shell();
    const redDark = new Shell();
    const chrome = new Shell();
    const steel = new Shell();
    const matte = new Shell();
    const white = new Shell();
    const seat = new Shell();
    const seatDark = new Shell();

    this.buildUnderframe(steel, matte);
    this.buildSides(body, bodyDark, lime, chrome, matte, white, red);
    this.buildRoof(body, chrome, matte, white);
    this.buildNose(body, lime, red, redDark, chrome, matte);
    this.buildRear(body, lime, red, chrome, matte, white);
    this.buildDoor(lime, chrome);
    this.buildInterior(matte, white, seat, seatDark, chrome);
    this.buildDetails(chrome, matte, lime, steel);

    this.emit(body.build(), matBody, 'body');
    this.emit(bodyDark.build(), matBodyDark, 'panelLines');
    this.emit(lime.build(), matLime, 'lime');
    this.emit(red.build(), matRed, 'red');
    this.emit(redDark.build(), matRedDark, 'redDark');
    this.emit(chrome.build(), matChrome, 'chrome');
    this.emit(steel.build(), matSteel, 'steel');
    this.emit(matte.build(), matMatte, 'trim');
    this.emit(white.build(), matWhite, 'white');
    this.emit(seat.build(), matSeat, 'seats');
    this.emit(seatDark.build(), matSeatDark, 'seatTrim');

    this.buildGlass(matGlass);
    this.buildLights();
    this.buildFestoons();
    this.buildDecals();
    this.buildSteeringWheel(matMatte, matChrome);
    this.buildCrowd();
    this.buildPassenger();
    this.buildWheels(matRubber, matChrome, matSteel);
    this.buildCockpit(matMatte, matChrome);

    this.chassis.add(this.beams);
    this.setQuality(quality);

    this.object3d.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = false;
      }
    });
    this.beams.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = false;
    });
    /* the cabin is only ever seen from inside the cabin; a dashboard in the
     * shadow atlas is pure cost */
    this.cockpit.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = false;
    });
  }

  /* ================================================== Vehicle-facing methods */

  setSteer(rad: number): void {
    const a = clamp(rad, -1.2, 1.2);
    /* positive steer is a right turn, which is a negative rotation about +Y */
    this.wheelSteer[0].rotation.y = -a;
    this.wheelSteer[1].rotation.y = -a;
    const wheelAngle = -a * G.steeringWheelRatio;
    this.steeringWheel.rotation.z = wheelAngle;
    /* The hands stop travelling before the rim does. A bus box is 4.2:1, so
     * full lock is 159° of wheel — far enough to carry a pair of hands right
     * round to the bottom of the rim if they were simply parented to it. */
    this.handRig.rotation.z = clamp(wheelAngle, -BUS_COCKPIT.handLock, BUS_COCKPIT.handLock);
  }

  /* ------------------------------------------------------ driver's seat */

  setCockpitVisible(amount: number): void {
    const on = amount > 0.002;
    if (on === this.cockpitOn) return;
    this.cockpitOn = on;
    this.cockpit.visible = on;
    setPaintForInterior(this.materials, on);
  }

  /**
   * The driver's eye, in body-local metres, through the cosmetic chassis lean.
   *
   * The bus's lean is applied to `chassis` by `tick`, not by `setChassisLean`
   * (the air-brake squat has to be added in first), so this reads the group's
   * live transform rather than recomposing it.
   */
  getCockpitEye(out: THREE.Vector3): THREE.Vector3 {
    this.chassis.updateMatrix();
    return out.copy(BUS_COCKPIT.eye).applyMatrix4(this.chassis.matrix);
  }

  setInstruments(rpmNorm: number, speedNorm: number, _gear: number): void {
    if (!this.cockpitOn) return;
    this.targetSpeedNeedle = clamp01(speedNorm);
    this.targetRpmNeedle = clamp01(rpmNorm);
  }

  setWheelSpin(i: number, radians: number): void {
    if (i < 0 || i > 3 || !Number.isFinite(radians)) return;
    this.spinAccum[i] = radians;
    this.wheelSpin[i].rotation.x = -radians;
  }

  setSuspension(i: number, compression: number): void {
    if (i < 0 || i > 3) return;
    const c = clamp01(compression);
    this.wheelRoots[i].position.y =
      BUS_SUSPENSION.anchorY - BUS_SUSPENSION.restLength * (1 - c);
  }

  setBrakeLights(on: boolean): void {
    this.matTaillight.emissiveIntensity = on
      ? G.taillightIntensityOn
      : G.taillightIntensityOff;
  }

  /** 0..1 — the underglow and the light bar both ride the boost. */
  setBoostGlow(v: number): void {
    this.boostGlow = clamp01(v);
  }

  setHeadlights(on: boolean): void {
    this.headlightsOn = on;
    this.matHeadlight.emissiveIntensity = on
      ? G.headlightIntensityOn
      : G.headlightIntensityOff;
    /* dash lights come on with the headlights, exactly as they do in a bus */
    setPanelLights(this.cockpitLit, on ? 1 : 0);
    this.beams.visible = on && this.beamsAllowed;
  }

  setSeatOccupied(occupied: boolean, archetypeId?: string): void {
    this.passenger.visible = occupied;
    if (occupied) this.matPassenger.color.setHex(archetypeColor(archetypeId));
  }

  setChassisLean(pitch: number, roll: number, heave: number): void {
    this.leanPitch = pitch;
    this.leanRoll = roll;
    this.leanHeave = heave;
  }

  /**
   * Attach a musical clock. Anything with a `beatPhase` getter works —
   * `AudioSystem` satisfies it, and so does a test double.
   */
  setBeatSource(src: BeatSource | null): void {
    this.beatSource = src;
  }

  /**
   * Scale the whole light show, 0..1. Vehicle turns this down when the player
   * has asked for photosensitive-safe output, and on the low quality tier.
   */
  setLightShowIntensity(scale: number): void {
    this.showScale = clamp01(scale);
  }

  /** The air brakes let go: the body drops on its springs and hisses. */
  pulseAirBrake(strength: number): void {
    this.airBrakeSquat = Math.max(this.airBrakeSquat, clamp01(strength));
  }

  /** The horn: everything on the roof flashes at once. */
  pulseHorn(): void {
    this.hornFlash = 1;
  }

  /**
   * The whole light show. Called every frame by Vehicle: the festoon strings
   * chase, the light bar strobes, the interior cycles hue and the underglow
   * pumps — all locked to `beatPhase` when a music clock is attached, and to a
   * free-running 2.1 Hz clock when it is not.
   */
  tick(dt: number, speed: number): void {
    this.idlePhase += dt * 26;

    if (this.cockpitOn) this.tickCockpit(dt, speed);

    /* ---- resolve the beat ---- */
    let phase: number;
    if (this.beatSource) {
      phase = this.beatSource.beatPhase;
      if (!Number.isFinite(phase)) phase = 0;
      phase = phase - Math.floor(phase);
    } else {
      this.freeBeat = (this.freeBeat + dt * G.fallbackBeatHz) % 1;
      phase = this.freeBeat;
    }
    if (phase < this.lastBeatPhase) this.beatIndex = (this.beatIndex + 1) % 24;
    this.lastBeatPhase = phase;

    const depth = G.beatDepth * this.showScale;
    const punch = beatPunch(phase);

    /* ---- festoon chase: each group is a sixth of a beat behind the last ---- */
    const groups = this.festoon.length;
    for (let i = 0; i < groups; i++) {
      const p = (phase + i / groups) % 1;
      const level = 0.32 + beatPunch(p) * 0.68;
      this.festoon[i].emissiveIntensity =
        G.festoonIntensity * (1 - depth + depth * level * 1.55);
    }

    /* ---- roof light bar: double-strobe on every other beat ---- */
    const strobe =
      this.beatIndex % 2 === 0 ? punch : Math.max(punch, beatPunch((phase + 0.5) % 1));
    this.matLightBar.emissiveIntensity =
      G.lightBarIntensity *
      (1 - depth * 0.85 + depth * 0.85 * (0.25 + strobe * 1.9) + this.hornFlash * 2.2);

    /* ---- marker lamps: a slow shimmer, they are running lights not strobes -- */
    this.matMarker.emissiveIntensity =
      G.markerIntensity *
      (0.75 + 0.25 * Math.sin(this.idlePhase * 0.11) + punch * depth * 0.5 + this.hornFlash);

    /* ---- interior: the hue walks a whole turn every eight beats ---- */
    const hue = ((this.beatIndex + phase) / 8) % 1;
    this.tmpColor.setHSL(hue, 0.72, 0.55);
    this.matInterior.emissive.copy(this.tmpColor);
    /* The ceiling glow is authored to read from the street at night, where it
     * is a coloured wash seen through the windows across ten metres of air. The
     * driver sits directly underneath it at arm's length, and at ~2.0 emissive
     * it is comfortably over the 1.23 bloom threshold: measured from the seat at
     * 15:30, hiding this one mesh took the frame from 0.25–0.36 luma down to a
     * flat 0.24, which is the bloom-off reference. So it comes down when the
     * camera is inside — far enough to sit under the threshold, not so far that
     * the party stops being visible from the aisle. */
    this.matInterior.emissiveIntensity =
      G.interiorIntensity *
      (1 - depth * 0.6 + depth * 0.6 * (0.4 + punch * 1.5)) *
      (this.cockpitOn ? COCKPIT_GLOW_SCALE : 1);

    /* ---- underglow: off-beat, and the boost floods it ---- */
    const off = beatPunch((phase + 0.5) % 1);
    this.matUnderglow.emissiveIntensity =
      G.underglowIntensity *
      (0.35 + off * depth * 0.9 + this.boostGlow * 1.6);
    this.matUnderglow.opacity = clamp01(0.5 + off * 0.3 + this.boostGlow * 0.4);

    /* ---- the sign gets brighter as the world gets darker ---- */
    this.nightMix = damp(this.nightMix, this.headlightsOn ? 1 : 0, 3, dt);
    this.matSign.emissiveIntensity =
      G.signIntensity * (0.8 + this.nightMix * 0.7 + Math.sin(this.idlePhase * 0.2) * 0.05);
    this.matTurn.emissiveIntensity = 0.5 + this.nightMix * 0.5 + this.hornFlash * 1.5;

    /* ---- one-shots ---- */
    if (this.hornFlash > 0) this.hornFlash = Math.max(0, this.hornFlash - dt * 3.4);
    if (this.airBrakeSquat > 0) this.airBrakeSquat = Math.max(0, this.airBrakeSquat - dt * 2.2);
    this.airBrakeVisual = damp(this.airBrakeVisual, this.airBrakeSquat, 14, dt);

    /* ---- diesel idle shake, and the body settling on its air bags ---- */
    const idle = clamp01(1 - speed / 5);
    const shake = Math.sin(this.idlePhase) * 0.0032 * idle;
    this.chassis.position.x = shake;
    this.chassis.position.y = this.leanHeave - this.airBrakeVisual * 0.055;
    this.chassis.rotation.x = this.leanPitch + this.airBrakeVisual * 0.012;
    this.chassis.rotation.z = -this.leanRoll;
    this.chassis.rotation.y = Math.sin(this.idlePhase * 0.57) * 0.0026 * idle;
  }

  setQuality(tier: QualityTier): void {
    this.beamsAllowed = tier === 'high' || tier === 'ultra';
    this.beams.visible = this.headlightsOn && this.beamsAllowed;
  }

  dispose(): void {
    this.meter?.dispose();
    this.meter = null;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.festoon.length = 0;
    this.beatSource = null;
    this.object3d.clear();
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
   * A painted panel: dielectric base plus a clear lacquer lobe, with the lobe
   * gated on quality. The fallback keeps identical metalness and roughness, so
   * the livery reads the same colour at every tier.
   */
  private paint(
    color: number,
    roughness: number,
    clearcoat: number,
    clearcoatRoughness: number,
  ): THREE.MeshStandardMaterial {
    const base = { color, metalness: 0.05, roughness, envMapIntensity: 1 };
    const m = this.lowDetail
      ? new THREE.MeshStandardMaterial(base)
      : new THREE.MeshPhysicalMaterial({
          ...base,
          clearcoat,
          clearcoatRoughness: safeClearcoatRoughness(clearcoatRoughness),
        });
    /* tags this as a painted panel for `setPaintForInterior` */
    m.userData.isVehiclePaint = true;
    this.materials.push(m);
    return m;
  }

  private emissiveMat(
    color: number,
    intensity: number,
    metalness: number,
    roughness: number,
  ): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      metalness,
      roughness,
    });
    this.materials.push(m);
    return m;
  }

  private emit(
    geo: THREE.BufferGeometry | null,
    material: THREE.Material,
    name: string,
  ): void {
    if (!geo) return;
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `bus_${name}`;
    this.chassis.add(mesh);
  }

  /** Chassis rails, axles, fuel tank, air reservoirs — all visible under a bus. */
  private buildUnderframe(steel: Shell, matte: Shell): void {
    const y = G.ySkirt + 0.08;

    /* the two big ladder rails */
    steel.addMirrored(box(0.16, 0.2, SIDE_LEN + 1.5, 0.62, y, SIDE_MID - 0.4));
    /* cross members */
    for (let i = 0; i < 7; i++) {
      const z = -4.4 + i * 1.65;
      steel.add(box(1.3, 0.12, 0.14, 0, y, z));
    }

    /* axles + diffs */
    matte.add(cyl(0.13, 0.13, 2.0, 10, 0, G.groundLocalY + 0.55, G.zFrontAxle, 'x'));
    matte.add(cyl(0.15, 0.15, 1.7, 10, 0, G.groundLocalY + 0.55, G.zRearAxle, 'x'));
    matte.add(cyl(0.28, 0.28, 0.5, 12, 0, G.groundLocalY + 0.55, G.zRearAxle, 'z'));
    /* prop shaft */
    matte.add(cyl(0.07, 0.07, 5.6, 8, 0, G.groundLocalY + 0.5, 0.2, 'z'));

    /* fuel tank and the air reservoirs the brakes hiss out of */
    steel.add(cyl(0.28, 0.28, 1.3, 12, -0.95, y - 0.02, -0.6, 'z'));
    steel.addMirrored(cyl(0.16, 0.16, 0.9, 10, 0.95, y - 0.04, 1.4, 'z'));

    /* leaf springs, because the silhouette under a bus is half the character */
    for (const z of [G.zFrontAxle, G.zRearAxle]) {
      steel.addMirrored(box(0.1, 0.06, 1.5, 0.72, G.groundLocalY + 0.42, z));
    }
  }

  /**
   * The flat sides: skirt, lower panel, rub rails, the long row of open windows
   * with their slim chrome dividers, and the header above them.
   */
  private buildSides(
    body: Shell,
    dark: Shell,
    lime: Shell,
    chrome: Shell,
    matte: Shell,
    white: Shell,
    red: Shell,
  ): void {
    const X = G.halfWidth;

    /* --- the lower band has to skip both wheel arches --- */
    const lowSegments: Array<[number, number]> = [
      [SIDE_Z0, ARCH_F0],
      [ARCH_F1, ARCH_R0],
      [ARCH_R1, SIDE_Z1],
    ];
    for (const [z0, z1] of lowSegments) {
      const len = z1 - z0;
      const mid = (z0 + z1) * 0.5;
      /* lime rocker skirt */
      lime.addMirrored(box(0.09, G.yRocker - G.ySkirt, len, X + 0.02, (G.ySkirt + G.yRocker) * 0.5, mid));
      /* yellow flank below the floor line */
      body.addMirrored(box(0.07, G.yFloor - G.yRocker, len, X, (G.yRocker + G.yFloor) * 0.5, mid));
    }

    /* --- the continuous flank from the floor line to the beltline --- */
    const flankH = G.yBeltline - G.yFloor;
    body.addMirrored(box(0.07, flankH, SIDE_LEN, X, (G.yFloor + G.yBeltline) * 0.5, SIDE_MID));

    /* panel seams every 1.4 m — a bus body is bolted together from sheets */
    for (let z = SIDE_Z0 + 1.4; z < SIDE_Z1 - 0.3; z += 1.4) {
      dark.addMirrored(box(0.02, flankH, 0.05, X + 0.04, (G.yFloor + G.yBeltline) * 0.5, z));
    }

    /* --- black rubber rub rails, the length of the body --- */
    for (const y of [0.62, 1.12]) {
      matte.addMirrored(box(0.06, 0.11, SIDE_LEN, X + 0.05, y, SIDE_MID));
    }
    /* and one right down on the skirt */
    matte.addMirrored(box(0.05, 0.09, SIDE_LEN, X + 0.05, G.yRocker + 0.06, SIDE_MID));

    /* --- chrome trim strips --- */
    chrome.addMirrored(box(0.04, 0.05, SIDE_LEN, X + 0.06, G.yBeltline - 0.03, SIDE_MID));
    chrome.addMirrored(box(0.04, 0.04, SIDE_LEN, X + 0.06, G.yFloor + 0.02, SIDE_MID));

    /* --- red/white dashed reflective strip along the skirt --- */
    const dashY = G.ySkirt + 0.16;
    let dashZ = SIDE_Z0 + 0.2;
    let odd = false;
    while (dashZ < SIDE_Z1 - 0.3) {
      const g = box(0.03, 0.11, 0.3, X + 0.08, dashY, dashZ + 0.15);
      if (odd) red.addMirrored(g);
      else white.addMirrored(g);
      odd = !odd;
      dashZ += 0.32;
    }

    /* --- the window band: header, sill and the slim chrome dividers --- */
    const winZ0 = G.zDoorRear + 0.1;
    const winZ1 = SIDE_Z1 - 0.2;
    const winLen = winZ1 - winZ0;
    const winMid = (winZ0 + winZ1) * 0.5;

    /* header above the glass, and the sill under it */
    body.addMirrored(box(0.07, G.yRoof - G.yWindowTop, SIDE_LEN, X, (G.yWindowTop + G.yRoof) * 0.5, SIDE_MID));
    body.addMirrored(box(0.07, 0.08, SIDE_LEN, X, G.yBeltline + 0.04, SIDE_MID));

    const bays = 11;
    for (let i = 0; i <= bays; i++) {
      const z = winZ0 + (winLen * i) / bays;
      chrome.addMirrored(box(0.055, G.yWindowTop - G.yBeltline, 0.07, X, (G.yBeltline + G.yWindowTop) * 0.5, z));
    }

    /* the driver's window bay ahead of them, framed in chrome */
    chrome.addMirrored(box(0.05, G.yWindowTop - G.yBeltline, 0.06, X, (G.yBeltline + G.yWindowTop) * 0.5, G.zDoorFront + 0.03));

    /* --- fender flares over both arches --- */
    for (const z of [G.zFrontAxle, G.zRearAxle]) {
      const g = new THREE.TorusGeometry(G.archRadius + 0.06, 0.09, 5, 16, Math.PI);
      g.rotateY(Math.PI / 2);
      g.translate(X + 0.02, G.groundLocalY + 0.55, z);
      lime.addMirrored(g);
      /* arch liner so you never see daylight through the flare */
      const liner = new THREE.TorusGeometry(G.archRadius - 0.02, 0.06, 4, 12, Math.PI);
      liner.rotateY(Math.PI / 2);
      liner.translate(X - 0.12, G.groundLocalY + 0.55, z);
      matte.addMirrored(liner);
    }

    /* mud flaps behind the rear duals */
    matte.addMirrored(box(0.05, 0.42, 0.5, X - 0.1, G.ySkirt - 0.06, ARCH_R1 + 0.16));
  }

  /** Roof plate, rounded edge rails, hatches, speakers and the sign box. */
  private buildRoof(body: Shell, chrome: Shell, matte: Shell, white: Shell): void {
    const z0 = G.zWindscreen;
    const len = SIDE_Z1 - z0;
    const mid = (z0 + SIDE_Z1) * 0.5;

    /* the crown, and the rounded rails where the roof meets the sides */
    white.add(box(2.06, 0.1, len, 0, G.yRoofCrown - 0.05, mid));
    body.addMirrored(cyl(0.24, 0.24, len, 12, 1.03, 2.0, mid, 'z'));

    /* roof ribs — a school bus roof is corrugated */
    for (let i = 0; i < 9; i++) {
      const z = z0 + 0.6 + i * 1.1;
      if (z > SIDE_Z1 - 0.4) break;
      matte.add(box(1.9, 0.03, 0.09, 0, G.yRoofCrown + 0.01, z));
    }

    /* two emergency roof hatches */
    for (const z of [-1.5, 2.6]) {
      white.add(box(0.72, 0.09, 0.72, 0, G.yRoofCrown + 0.04, z));
      chrome.add(box(0.78, 0.03, 0.78, 0, G.yRoofCrown + 0.005, z));
    }

    /* the sound system: two cabinets bolted to the roof, facing out */
    for (const s of [-1, 1]) {
      matte.add(box(0.62, 0.46, 0.72, s * 0.62, G.yRoofCrown + 0.27, 3.6));
      chrome.add(cyl(0.17, 0.17, 0.05, 12, s * 0.62, G.yRoofCrown + 0.3, 3.98, 'z'));
      chrome.add(cyl(0.08, 0.08, 0.06, 10, s * 0.62, G.yRoofCrown + 0.44, 3.98, 'z'));
    }

    /* light-bar plinth across the front of the roof */
    matte.add(box(2.14, 0.1, 0.22, 0, G.yRoofCrown + 0.06, z0 + 0.34));
    chrome.addMirrored(box(0.06, 0.12, 0.2, 0.98, G.yRoofCrown + 0.14, z0 + 0.34));

    /* front header panel above the windscreen — carries the painted script */
    body.add(box(2.3, G.yRoofCrown - G.yWindscreenTop, 0.1, 0, (G.yWindscreenTop + G.yRoofCrown) * 0.5, z0 + 0.02));
    /* And the destination-sign housing, let into the header rather than into
     * the windscreen. At `yWindscreenTop − 0.2` it hung 35 cm down into the
     * glass; that reads fine from the street and puts an opaque black board
     * across the top third of the *driver's* view, which is the one place a
     * route board must never be. Both positions are things real buses do; only
     * one of them can be driven from. */
    matte.add(box(1.5, 0.26, 0.06, 0, G.yWindscreenTop + 0.09, z0 - 0.02));
  }

  /** Red hood, chrome grille, twin round headlights, heavy bumper, mirrors. */
  private buildNose(
    body: Shell,
    lime: Shell,
    red: Shell,
    redDark: Shell,
    chrome: Shell,
    matte: Shell,
  ): void {
    const zN = G.zGrille;

    /* --- the cowl: the full-width wall the windscreen sits on --- */
    red.add(box(2.5, 0.34, 0.14, 0, G.yHood + 0.14, G.zCowl - 0.04));
    body.add(box(2.52, G.yBeltline - G.yFloor, 0.12, 0, (G.yFloor + G.yBeltline) * 0.5, G.zCowl - 0.02));

    /* --- hood: two stacked slabs so the top face reads as a crown --- */
    red.add(box(1.78, 0.13, 1.02, 0, G.yHood - 0.06, -4.79));
    red.add(box(1.46, 0.07, 0.98, 0, G.yHood + 0.03, -4.79));
    redDark.add(box(0.1, 0.02, 0.98, 0, G.yHood + 0.07, -4.79));
    /* hood sides */
    red.addMirrored(box(0.09, 0.5, 1.02, 0.85, 0.95, -4.79));
    chrome.addMirrored(box(0.07, 0.05, 0.16, 0.8, G.yHood - 0.02, -5.24));

    /* --- front fenders, out to full width, carrying the headlights --- */
    red.addMirrored(box(0.42, 0.62, 1.06, 1.05, 0.86, -4.8));
    red.addMirrored(box(0.42, 0.2, 0.16, 1.05, 1.17, -5.28));
    /* the fender tops taper into the cowl */
    red.addMirrored(box(0.42, 0.16, 0.5, 1.05, 1.2, -4.45));

    /* --- grille: red surround, chrome bars, shield badge --- */
    red.add(box(1.42, 0.84, 0.09, 0, 0.66, zN));
    for (let i = 0; i < 7; i++) {
      chrome.add(box(1.24, 0.055, 0.06, 0, 0.32 + i * 0.115, zN - 0.05));
    }
    chrome.add(box(1.46, 0.07, 0.08, 0, 1.1, zN - 0.02));
    chrome.add(box(1.46, 0.07, 0.08, 0, 0.22, zN - 0.02));

    /* the badge: a chrome shield with a red field and a lime chevron */
    chrome.add(box(0.3, 0.36, 0.05, 0, 0.66, zN - 0.08));
    chrome.add(box(0.24, 0.12, 0.05, 0, 0.45, zN - 0.08, 0, 0, Math.PI * 0.25));
    redDark.add(box(0.22, 0.28, 0.04, 0, 0.68, zN - 0.11));
    lime.add(box(0.2, 0.045, 0.03, 0, 0.62, zN - 0.13));

    /* --- valance under the grille, and the heavy chrome bumper --- */
    red.add(box(2.5, 0.22, 0.12, 0, 0.08, zN + 0.02));
    chrome.add(box(2.62, 0.34, 0.26, 0, -0.2, G.zBumper + 0.06));
    chrome.addMirrored(box(0.24, 0.34, 0.3, 1.24, -0.2, G.zBumper + 0.24, 0, 0.35, 0));
    /* bumper bolt heads */
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        matte.add(cyl(0.035, 0.035, 0.05, 6, s * (0.35 + i * 0.35), -0.2, G.zBumper - 0.06, 'z'));
      }
    }
    /* tow eyes */
    matte.addMirrored(box(0.12, 0.16, 0.24, 0.62, -0.28, G.zBumper + 0.2));

    /* --- crossview mirrors on stalks off the bumper, plus the big flats --- */
    for (const s of [-1, 1]) {
      chrome.add(tube(s * 1.16, -0.05, G.zBumper + 0.1, s * 1.24, 1.05, G.zBumper - 0.12, 0.035, 6));
      lime.add(box(0.14, 0.2, 0.1, s * 1.26, 1.16, G.zBumper - 0.14));
      matte.add(cyl(0.13, 0.13, 0.05, 12, s * 1.26, 1.2, G.zBumper - 0.2, 'z'));

      /* the tall flat/convex pair either side of the windscreen */
      chrome.add(tube(s * 1.18, 1.5, G.zCowl - 0.1, s * 1.5, 1.62, G.zCowl - 0.3, 0.03, 6));
      chrome.add(tube(s * 1.18, 1.05, G.zCowl - 0.06, s * 1.5, 1.3, G.zCowl - 0.28, 0.03, 6));
      lime.add(box(0.08, 0.62, 0.2, s * 1.54, 1.5, G.zCowl - 0.32));
      matte.add(box(0.03, 0.56, 0.16, s * 1.58, 1.5, G.zCowl - 0.32));
      lime.add(box(0.08, 0.2, 0.2, s * 1.54, 1.06, G.zCowl - 0.3));
    }

    /* --- windscreen pillars and the centre divider --- */
    body.addMirrored(box(0.14, G.yWindscreenTop - G.yHood - 0.1, 0.16, 1.16, 1.66, G.zCowl - 0.12));
    chrome.add(box(0.07, G.yWindscreenTop - G.yHood - 0.14, 0.1, 0, 1.68, G.zWindscreen - 0.02));

    /* wiper arms */
    for (const s of [-1, 1]) {
      matte.add(tube(s * 0.15, 1.42, G.zCowl - 0.16, s * 0.95, 1.72, G.zCowl - 0.3, 0.022, 5));
    }
  }

  /** Rear face, emergency door, tail lamps, lime bumper, exhaust. */
  private buildRear(
    body: Shell,
    lime: Shell,
    red: Shell,
    chrome: Shell,
    matte: Shell,
    white: Shell,
  ): void {
    const zR = G.zBodyRear;

    /* the rear wall, in three bands so the emergency door can sit proud */
    body.add(box(2.52, G.yRoof - G.ySkirt, 0.1, 0, (G.ySkirt + G.yRoof) * 0.5, zR - 0.04));

    /* emergency door: lime frame, yellow leaf, chrome hinges and handle */
    lime.add(box(1.06, 1.72, 0.07, 0, 1.02, zR + 0.02));
    body.add(box(0.92, 1.58, 0.06, 0, 1.02, zR + 0.05));
    chrome.addMirrored(box(0.07, 0.16, 0.08, 0.5, 1.6, zR + 0.06));
    chrome.addMirrored(box(0.07, 0.16, 0.08, 0.5, 0.5, zR + 0.06));
    chrome.add(box(0.26, 0.07, 0.09, 0.28, 1.02, zR + 0.08));

    /* the big red EMERGENCY EXIT band above it */
    red.add(box(1.5, 0.16, 0.05, 0, 1.94, zR + 0.04));

    /* lime rear bumper */
    lime.add(box(2.62, 0.36, 0.28, 0, -0.24, G.zRearBumper));
    lime.addMirrored(box(0.24, 0.36, 0.28, 1.24, -0.24, zR + 0.14, 0, -0.35, 0));
    chrome.add(box(2.4, 0.06, 0.06, 0, -0.06, G.zRearBumper + 0.08));

    /* reflective chevron panel under the door */
    for (let i = 0; i < 6; i++) {
      const g = box(0.24, 0.2, 0.03, -0.7 + i * 0.28, -0.02, zR + 0.05, 0, 0, 0.5);
      if (i % 2 === 0) red.add(g);
      else white.add(g);
    }

    /* engine access grille and the exhaust turn-out */
    matte.add(box(1.0, 0.24, 0.05, 0, -0.16, zR + 0.02));
    chrome.add(cyl(0.075, 0.09, 0.24, 10, -0.9, -0.3, zR + 0.16, 'z'));

    /* the chrome stack behind the cab — pure silhouette */
    chrome.add(cyl(0.085, 0.085, 2.5, 10, -1.34, 1.05, -2.4, 'y'));
    chrome.add(cyl(0.11, 0.095, 0.22, 10, -1.34, 2.36, -2.4, 'y'));
    matte.add(box(0.1, 1.2, 0.24, -1.4, 1.1, -2.4));
    chrome.addMirrored(box(0.14, 0.06, 0.12, 1.32, 1.7, -2.4));
  }

  /** The lime entry door, two leaves of glass on a chrome frame. */
  private buildDoor(lime: Shell, chrome: Shell): void {
    const X = G.halfWidth;
    const z0 = G.zDoorFront;
    const z1 = G.zDoorRear;
    const w = z1 - z0;
    const mid = (z0 + z1) * 0.5;

    /* the aperture surround stays with the body shell */
    lime.add(box(0.1, G.yWindowTop - G.ySkirt + 0.1, 0.1, X + 0.02, (G.ySkirt + G.yWindowTop) * 0.5, z0));
    lime.add(box(0.1, G.yWindowTop - G.ySkirt + 0.1, 0.1, X + 0.02, (G.ySkirt + G.yWindowTop) * 0.5, z1));
    lime.add(box(0.1, 0.12, w, X + 0.02, G.yWindowTop + 0.04, mid));

    /* the step well */
    chrome.add(box(0.1, 0.06, w - 0.1, X - 0.02, G.ySkirt + 0.06, mid));

    /* two leaves, each a lime frame around a pair of glass lights */
    for (let i = 0; i < 2; i++) {
      const lz = z0 + 0.08 + i * (w / 2 - 0.02);
      const lw = w / 2 - 0.12;
      const lmid = lz + lw * 0.5;
      lime.add(box(0.06, 1.98, 0.07, X, 0.86, lz));
      lime.add(box(0.06, 1.98, 0.07, X, 0.86, lz + lw));
      lime.add(box(0.06, 0.1, lw, X, 1.8, lmid));
      lime.add(box(0.06, 0.12, lw, X, 0.72, lmid));
      lime.add(box(0.06, 0.1, lw, X, -0.1, lmid));
      /* the glass goes into the shared glass shell — see buildGlass */
      for (const [y, h] of [
        [1.3, 0.92],
        [0.28, 0.72],
      ] as Array<[number, number]>) {
        const g = new THREE.PlaneGeometry(lw - 0.04, h);
        g.rotateY(Math.PI / 2);
        g.translate(X + 0.01, y, lmid);
        this.doorGlass.add(g);
      }
    }

    /* the grab handle by the door */
    chrome.add(tube(X - 0.14, -0.2, z1 - 0.06, X - 0.14, 1.6, z1 - 0.06, 0.03, 6));
  }

  /** Floor, ceiling, red vinyl bench seats, poles, driver's station. */
  private buildInterior(
    matte: Shell,
    white: Shell,
    seat: Shell,
    seatDark: Shell,
    chrome: Shell,
  ): void {
    /* floor and ceiling. The ceiling is a separate emissive mesh — see below. */
    matte.add(box(2.36, 0.08, SIDE_LEN - 0.3, 0, G.yFloor, SIDE_MID));
    white.add(box(2.3, 0.05, SIDE_LEN - 0.4, 0, G.yWindowTop + 0.06, SIDE_MID));

    /* the aisle runner */
    seatDark.add(box(0.52, 0.02, SIDE_LEN - 0.6, 0, G.yFloor + 0.05, SIDE_MID));

    /* --- red vinyl benches, eleven rows a side --- */
    /* The first row starts 1.05 m behind the door aperture, not 0.55 m. The
     * driver's seat moved back 0.30 m (see `buildInterior`'s driver station)
     * and at the old spacing the coachwork put a passenger's knees in the back
     * of the driver's head — invisible through a window from the street,
     * unmissable from the driver's seat looking over their shoulder. */
    const rows = 11;
    const z0 = G.zDoorRear + 1.05;
    for (let i = 0; i < rows; i++) {
      const z = z0 + i * 0.78;
      if (z > SIDE_Z1 - 0.55) break;
      for (const s of [-1, 1]) {
        const x = s * 0.72;
        seat.add(box(0.92, 0.16, 0.5, x, G.yFloor + 0.5, z));
        seat.add(box(0.92, 0.72, 0.14, x, G.yFloor + 0.92, z + 0.28, -0.13));
        seatDark.add(box(0.94, 0.06, 0.52, x, G.yFloor + 0.59, z));
        seatDark.add(box(0.94, 0.07, 0.16, x, G.yFloor + 1.28, z + 0.26, -0.13));
        /* the chrome grab rail across the top of each seat back */
        chrome.add(cyl(0.022, 0.022, 0.9, 6, x, G.yFloor + 1.33, z + 0.25, 'x'));
        /* pedestal legs */
        matte.add(box(0.06, 0.34, 0.06, x + s * 0.36, G.yFloor + 0.25, z));
      }
    }

    /* --- stanchion poles, because everyone is standing up dancing --- */
    for (const z of [G.zDoorRear + 0.2, 0.4, 3.2]) {
      chrome.add(cyl(0.032, 0.032, G.yWindowTop - G.yFloor, 8, 0.26, (G.yFloor + G.yWindowTop) * 0.5 + 0.03, z, 'y'));
    }
    /* a longitudinal ceiling rail */
    chrome.addMirrored(cyl(0.026, 0.026, SIDE_LEN - 1.6, 6, 0.5, G.yWindowTop - 0.06, SIDE_MID, 'z'));

    /* --- driver's station ---
     * The seat sits 0.30 m further back than it first did. At `zCowl + 0.42`
     * the driver's chest was 0.42 m from the windscreen — physically absurd for
     * a conventional hood-forward bus, and from the driver's own seat it put
     * the route board on the glass at arm's length and 100° wide. Moving it
     * back is invisible from outside (it is seen through a window from ten
     * metres) and is the difference between a cab and a cupboard. */
    matte.add(box(1.0, 0.16, 0.5, -0.66, G.yFloor + 0.52, G.zCowl + 0.72));
    matte.add(box(1.0, 0.66, 0.14, -0.66, G.yFloor + 0.9, G.zCowl + 0.98, -0.1));
    /* The dash. Its TOP EDGE is the bottom of everything the driver can see,
     * so it is deliberately low: at 1.51 it sat 19 cm under the eye and ate
     * 14° of windscreen. There is no separate binnacle here any more either —
     * `buildCockpit` puts a proper instrument pod in its place, and two
     * overlapping binnacles is one too many. */
    matte.add(box(1.5, 0.26, 0.34, -0.5, 1.3, G.zCowl + 0.12));
    /* the fare box by the door */
    matte.add(box(0.28, 0.7, 0.28, 0.62, 0.7, G.zDoorRear - 0.1));
    chrome.add(box(0.3, 0.06, 0.3, 0.62, 1.06, G.zDoorRear - 0.1));
    /* the long parking-brake lever a bus driver hauls on */
    chrome.add(tube(-0.18, G.yFloor + 0.12, G.zCowl + 0.5, -0.24, G.yFloor + 0.62, G.zCowl + 0.66, 0.028, 6));
  }

  /** Aerials, jerry can, cooler, cones — the clutter that sells a used bus. */
  private buildDetails(chrome: Shell, matte: Shell, lime: Shell, steel: Shell): void {
    /* whip aerial */
    matte.add(tube(-1.16, 1.4, G.zCowl + 0.2, -1.28, 2.9, G.zCowl + 0.5, 0.014, 5));

    /* a cooler strapped to the rear platform, and a crate of empties */
    lime.add(box(0.6, 0.4, 0.42, 0.72, G.yRoofCrown + 0.24, 1.5));
    chrome.add(box(0.62, 0.05, 0.44, 0.72, G.yRoofCrown + 0.46, 1.5));
    steel.add(box(0.52, 0.34, 0.4, -0.7, G.yRoofCrown + 0.21, 1.5));
    for (let i = 0; i < 6; i++) {
      matte.add(cyl(0.045, 0.045, 0.2, 6, -0.86 + (i % 3) * 0.16, G.yRoofCrown + 0.48, 1.36 + Math.floor(i / 3) * 0.24, 'y'));
    }

    /* roof rack rails around the load */
    chrome.addMirrored(cyl(0.022, 0.022, 3.2, 6, 1.0, G.yRoofCrown + 0.12, 2.2, 'z'));
    chrome.add(cyl(0.022, 0.022, 2.0, 6, 0, G.yRoofCrown + 0.12, 0.62, 'x'));
    chrome.add(cyl(0.022, 0.022, 2.0, 6, 0, G.yRoofCrown + 0.12, 3.8, 'x'));

    /* ladder up the rear corner to reach it all */
    for (let i = 0; i < 5; i++) {
      chrome.add(cyl(0.018, 0.018, 0.34, 5, -1.14, -0.1 + i * 0.52, G.zBodyRear + 0.14, 'x'));
    }
    chrome.addMirrored(cyl(0.02, 0.02, 2.3, 6, 1.3, 1.02, G.zBodyRear + 0.14, 'y'));
  }

  private buildGlass(matGlass: THREE.Material): void {
    /* raked two-piece windscreen, split by the chrome divider */
    const dy = G.yWindscreenTop - (G.yHood + 0.12);
    const dz = G.zWindscreen - (G.zCowl - 0.06);
    const len = Math.hypot(dy, dz);
    const shell = new Shell();
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(1.06, len - 0.04);
      /* `atan2(dz, dy)`, with no −90°: see the same fix in `JeepModel`. The
       * extra quarter turn laid both windscreen panes flat across the cab at
       * the driver's eye height. */
      g.rotateX(Math.atan2(dz, dy));
      g.translate(s * 0.57, G.yHood + 0.12 + dy * 0.5, G.zCowl - 0.06 + dz * 0.5);
      shell.add(g);
    }
    /* the driver's side window, and the rear emergency-door light */
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(0.62, 0.6);
      g.rotateY((s * Math.PI) / 2);
      g.translate(s * (G.halfWidth + 0.01), G.yBeltline + 0.34, G.zDoorFront + 0.38);
      shell.add(g);
    }
    const rear = new THREE.PlaneGeometry(0.72, 0.62);
    rear.translate(0, 1.32, G.zBodyRear + 0.09);
    shell.add(rear);

    /* the door lights, built earlier by buildDoor */
    const doorGeo = this.doorGlass.build();
    if (doorGeo) shell.add(doorGeo);

    const geo = shell.build();
    if (!geo) return;
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, matGlass);
    mesh.name = 'bus_glass';
    mesh.castShadow = false;
    this.chassis.add(mesh);
  }

  /**
   * Headlights, tail lamps, turn lamps, roof marker lamps, the light bar, the
   * interior ceiling glow, the underglow and the destination sign. Each group
   * is one merged mesh so the whole light rig is nine draw calls.
   */
  private buildLights(): void {
    const zN = G.zGrille;

    /* --- twin round headlights per side, in their red housings --- */
    const head = new Shell();
    for (const x of [0.78, 1.14]) {
      head.addMirrored(cyl(G.headlightRadius, G.headlightRadius, 0.06, 14, x, 0.86, zN - 0.08, 'z'));
    }
    this.emitMesh(head.build(), this.matHeadlight, 'headlights');

    /* --- amber turn lamps under them, plus repeaters on the flanks --- */
    const turn = new Shell();
    turn.addMirrored(cyl(0.09, 0.09, 0.05, 10, 0.96, 0.36, zN - 0.06, 'z'));
    turn.addMirrored(box(0.04, 0.12, 0.22, G.halfWidth + 0.07, 1.0, G.zFrontAxle - 1.0));
    turn.addMirrored(box(0.05, 0.16, 0.2, G.halfWidth + 0.02, 0.62, G.zBodyRear - 0.1));
    this.emitMesh(turn.build(), this.matTurn, 'turnLamps');

    /* --- tail lamps: two round reds a side, high and low, school-bus style --- */
    const tail = new Shell();
    for (const y of [0.42, 1.32]) {
      tail.addMirrored(cyl(0.115, 0.115, 0.05, 12, 0.98, y, G.zBodyRear + 0.06, 'z'));
    }
    tail.add(box(1.2, 0.07, 0.05, 0, 1.9, G.zBodyRear + 0.06));
    this.emitMesh(tail.build(), this.matTaillight, 'taillights');

    /* --- red marker lamps in a row along both roof headers --- */
    const marker = new Shell();
    for (let i = 0; i < 5; i++) {
      const x = -0.86 + i * 0.43;
      marker.add(cyl(0.055, 0.055, 0.05, 8, x, G.yRoofCrown - 0.08, G.zWindscreen - 0.02, 'z'));
      marker.add(cyl(0.055, 0.055, 0.05, 8, x, G.yRoofCrown - 0.08, G.zBodyRear + 0.03, 'z'));
    }
    /* and the clearance lamps on the corners */
    marker.addMirrored(cyl(0.05, 0.05, 0.06, 8, 1.14, G.yRoofCrown - 0.06, G.zWindscreen - 0.02, 'z'));
    marker.addMirrored(cyl(0.05, 0.05, 0.06, 8, 1.14, G.yRoofCrown - 0.06, G.zBodyRear + 0.03, 'z'));
    this.emitMesh(marker.build(), this.matMarker, 'markers');

    /* --- the roof light bar, eight amber lenses across the front --- */
    const bar = new Shell();
    for (let i = 0; i < 8; i++) {
      const x = -0.88 + i * 0.2515;
      bar.add(box(0.21, 0.15, 0.24, x, G.yRoofCrown + 0.18, G.zWindscreen + 0.36));
    }
    this.emitMesh(bar.build(), this.matLightBar, 'lightBar');

    /* --- interior: a lit ceiling panel and two cove strips down the sides --- */
    const inner = new Shell();
    inner.add(box(1.5, 0.05, SIDE_LEN - 0.8, 0, G.yWindowTop + 0.02, SIDE_MID));
    inner.addMirrored(box(0.06, 0.09, SIDE_LEN - 0.8, 1.12, G.yWindowTop - 0.04, SIDE_MID));
    this.emitMesh(inner.build(), this.matInterior, 'interiorGlow');

    /* --- underglow: a strip under each skirt, plus the nose and tail --- */
    const glow = new Shell();
    glow.addMirrored(box(0.07, 0.05, SIDE_LEN - 0.6, G.halfWidth - 0.03, G.ySkirt - 0.04, SIDE_MID));
    glow.add(box(2.3, 0.05, 0.07, 0, G.ySkirt - 0.04, G.zGrille + 0.3));
    glow.add(box(2.3, 0.05, 0.07, 0, G.ySkirt - 0.04, G.zBodyRear - 0.3));
    this.emitMesh(glow.build(), this.matUnderglow, 'underglow', false);

    /* --- cheap fake headlight beams, high/ultra only --- */
    const beamShell = new Shell();
    const cone = new THREE.ConeGeometry(0.8, 7.5, 10, 1, true);
    cone.rotateX(-Math.PI / 2);
    cone.translate(0.96, 0.86, zN - 3.9);
    beamShell.addMirrored(cone);
    const beamGeo = beamShell.build();
    if (beamGeo) {
      this.geometries.push(beamGeo);
      const beam = new THREE.Mesh(beamGeo, this.matBeam);
      beam.castShadow = false;
      beam.receiveShadow = false;
      this.beams.add(beam);
    }
    this.beams.visible = false;
  }

  /**
   * Festoon strings: bulbs along both roof edges and around the window line,
   * dealt round-robin into six chase groups.
   */
  private buildFestoons(): void {
    const groups = this.festoon.length;
    const shells: Shell[] = [];
    for (let i = 0; i < groups; i++) shells.push(new Shell());

    const bulb = (x: number, y: number, z: number, i: number): void => {
      const g = new THREE.SphereGeometry(0.058, 6, 4);
      g.translate(x, y, z);
      shells[i % groups].add(g);
    };

    let n = 0;
    /* the roof edge, both sides */
    for (let z = G.zWindscreen + 0.4; z < G.zBodyRear - 0.1; z += 0.5) {
      bulb(G.halfWidth + 0.06, G.yRoofCrown - 0.14, z, n++);
      bulb(-(G.halfWidth + 0.06), G.yRoofCrown - 0.14, z, n++);
    }
    /* and the window line, tucked under the sill */
    for (let z = G.zDoorRear + 0.3; z < G.zBodyRear - 0.2; z += 0.62) {
      bulb(G.halfWidth + 0.09, G.yBeltline - 0.12, z, n++);
      bulb(-(G.halfWidth + 0.09), G.yBeltline - 0.12, z, n++);
    }
    /* a swag across the back of the roof */
    for (let x = -1.0; x <= 1.0; x += 0.4) {
      bulb(x, G.yRoofCrown - 0.12 - Math.cos(x * 1.4) * 0.05, G.zBodyRear - 0.05, n++);
    }

    for (let i = 0; i < groups; i++) {
      const geo = shells[i].build();
      if (!geo) continue;
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.festoon[i]);
      mesh.name = `bus_festoon${i}`;
      mesh.castShadow = false;
      this.chassis.add(mesh);
    }
  }

  private emitMesh(
    geo: THREE.BufferGeometry | null,
    mat: THREE.Material,
    name: string,
    shadow = true,
  ): void {
    if (!geo) return;
    this.geometries.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = `bus_${name}`;
    m.castShadow = shadow;
    this.chassis.add(m);
  }

  /** Flank wordmark, front-header script, destination sign, rear plate. */
  private buildDecals(): void {
    /* --- CHINCHORREO 365 along both flanks --- */
    const flank = makeFlankTexture();
    if (flank) {
      this.textures.push(flank);
      const mat = new THREE.MeshStandardMaterial({
        map: flank,
        transparent: true,
        metalness: 0.1,
        roughness: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
      });
      this.materials.push(mat);
      const shell = new Shell();
      /* built as two explicitly-rotated planes rather than a mirror, so the
       * wordmark reads forwards on both sides */
      for (const side of [-1, 1]) {
        const plane = new THREE.PlaneGeometry(5.4, 0.84);
        plane.rotateY((side * Math.PI) / 2);
        plane.translate(side * (G.halfWidth + 0.09), 0.9, 0.9);
        shell.add(plane);
      }
      const geo = shell.build();
      if (geo) {
        this.geometries.push(geo);
        const m = new THREE.Mesh(geo, mat);
        m.name = 'bus_flankLivery';
        m.castShadow = false;
        this.chassis.add(m);
      }
    }

    /* --- the hand-painted script across the front header --- */
    const script = makeScriptTexture();
    if (script) {
      this.textures.push(script);
      const mat = new THREE.MeshStandardMaterial({
        map: script,
        transparent: true,
        emissive: new THREE.Color(0xffe9b0),
        emissiveMap: script,
        emissiveIntensity: 0.35,
        metalness: 0.1,
        roughness: 0.5,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
      });
      this.materials.push(mat);
      const geo = new THREE.PlaneGeometry(2.2, 0.42);
      geo.translate(0, (G.yWindscreenTop + G.yRoofCrown) * 0.5 + 0.02, G.zWindscreen - 0.04);
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.name = 'bus_headerScript';
      m.castShadow = false;
      this.chassis.add(m);
    }

    /* --- the lit destination roll sign --- */
    const sign = makeSignTexture();
    if (sign) this.textures.push(sign);
    this.matSign.map = sign ?? null;
    this.matSign.emissiveMap = sign ?? null;
    this.matSign.color.setHex(0xffffff);
    this.matSign.needsUpdate = true;
    const signGeo = new THREE.PlaneGeometry(1.42, 0.26);
    signGeo.translate(0, G.yWindscreenTop + 0.09, G.zWindscreen - 0.06);
    this.geometries.push(signGeo);
    const signMesh = new THREE.Mesh(signGeo, this.matSign);
    signMesh.name = 'bus_destinationSign';
    signMesh.castShadow = false;
    this.chassis.add(signMesh);

    /* --- rear plate --- */
    const plate = makePlateTexture();
    if (plate) {
      this.textures.push(plate);
      const mat = new THREE.MeshStandardMaterial({
        map: plate,
        metalness: 0.2,
        roughness: 0.6,
      });
      this.materials.push(mat);
      const geo = new THREE.PlaneGeometry(0.44, 0.22);
      geo.translate(0.62, -0.08, G.zRearBumper + 0.15);
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = false;
      this.chassis.add(m);
    }
  }

  private buildSteeringWheel(matMatte: THREE.Material, matChrome: THREE.Material): void {
    /* left-hand drive, and almost flat — a bus wheel is nearly horizontal */
    /* Raised from 1.32: with the driver's seat where it now is, the old height
     * put the whole wheel 0.30 m below the eye and 0.49 m ahead, so from the
     * seat it was a thin ellipse along the bottom edge of the frame. */
    this.steeringWheel.position.set(-0.66, 1.42, G.zCowl + 0.36);
    this.steeringWheel.rotation.x = -1.32;

    const rim = new THREE.TorusGeometry(0.25, 0.026, 6, 20);
    this.geometries.push(rim);
    this.steeringWheel.add(new THREE.Mesh(rim, matMatte));

    const spokes = new Shell();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      spokes.add(
        box(
          0.03,
          0.25,
          0.02,
          Math.cos(a + Math.PI / 2) * 0.125,
          Math.sin(a + Math.PI / 2) * 0.125,
          0,
          0,
          0,
          a,
        ),
      );
    }
    spokes.add(cyl(0.06, 0.06, 0.05, 10, 0, 0, 0, 'z'));
    const spokeGeo = spokes.build();
    if (spokeGeo) {
      this.geometries.push(spokeGeo);
      this.steeringWheel.add(new THREE.Mesh(spokeGeo, matChrome));
    }

    /* the column down to the floor */
    const col = cyl(0.045, 0.045, 0.6, 8, -0.66, 1.11, G.zCowl + 0.5, 'y');
    col.rotateX(0.3);
    this.geometries.push(col);
    this.chassis.add(new THREE.Mesh(col, matMatte));

    this.chassis.add(this.steeringWheel);
  }

  /* ==================================================== the driver's seat */

  /**
   * The bus's driver's station.
   *
   * A school bus cab is a specific, recognisable place and almost none of it
   * looks like a car: the driver sits above and ahead of the front axle behind
   * a near-vertical two-piece windscreen, with a flat steel fascia, a huge
   * thin-rimmed wheel almost in their lap, the engine doghouse filling the
   * space where a passenger footwell would be, and the whole eleven metres of
   * party running away behind their right shoulder down the aisle. That last
   * part is the point of the view — the chinchorreo is *behind* you, lit, and
   * the mirror is angled at it.
   *
   * Ten merged meshes plus the shared gauge/meter/hand kit, all hidden until
   * the camera is in the seat.
   */
  private buildCockpit(matMatte: THREE.Material, matChrome: THREE.Material): void {
    this.cockpit.name = 'bus_cockpit';
    this.cockpit.visible = false;

    const parts = createParts();
    const fascia = this.mat(0x2c2f38, 0.25, 0.72);
    const pad = this.mat(0x191b21, 0.05, 0.9);
    const doghouse = this.mat(BUS_PAINT.bodyDark, 0.1, 0.62);

    const steelShell = new Shell();
    const padShell = new Shell();
    const chromeShell = new Shell();
    const houseShell = new Shell();

    const zDash = G.zCowl + 0.12; // -4.18, matching the exterior dash box
    const yDash = 1.38;

    /* ---- fascia -----------------------------------------------------------
     *
     * There is deliberately **no crash roll and no second dash panel** here.
     * The first version had both, and from the seat they turned the whole
     * lower half of the windscreen into a black ledge: this cab's usable glass
     * runs from the exterior dash's top edge to the bottom of the destination
     * board let into the screen, and every extra centimetre of trim above the
     * dash comes straight out of the only place the driver can see the road.
     * All that is left is the kick panel below the dash, which is out of the
     * sightline entirely. */
    steelShell.add(box(2.32, 0.72, 0.05, -0.1, 0.92, zDash - 0.1));
    steelShell.add(box(2.3, 0.05, 0.34, -0.1, 1.28, zDash));

    /* ---- the doghouse: the engine cover a school bus driver sits beside -- */
    houseShell.add(box(0.86, 1.0, 1.0, 0.66, G.yFloor + 0.5, G.zCowl + 0.86));
    houseShell.add(box(0.92, 0.06, 1.06, 0.66, G.yFloor + 1.02, G.zCowl + 0.86));
    chromeShell.add(box(0.9, 0.03, 0.05, 0.66, G.yFloor + 1.06, G.zCowl + 0.35));

    /* ---- instrument cluster ---------------------------------------------
     * A rectangular binnacle leaning back at 22°, carrying the big speedo,
     * a tacho and a pair of air-pressure dials — the gauge no other vehicle
     * in the game has, and the one that says "this thing weighs eight tonnes".
     */
    const pod = new THREE.Group();
    pod.position.set(BUS_COCKPIT.podX, 1.44, G.zCowl + 0.2);
    pod.rotation.x = -BUS_COCKPIT.podTilt;
    this.cockpit.add(pod);

    const podShell = new Shell();
    /* Height is the load-bearing number, not width. The pod's top edge is the
     * bottom of the driver's sightline, so every centimetre of it is a
     * centimetre of road they cannot see; it is sized so the brow lands 12 cm
     * under the eye, which puts the horizon a clear 14° above it. */
    podShell.add(box(0.74, 0.2, 0.2, 0, 0, -0.11));
    podShell.add(box(0.8, 0.026, 0.06, 0, 0.115, 0.03, -0.3));
    const podGeo = podShell.build();
    if (podGeo) {
      this.geometries.push(podGeo);
      pod.add(new THREE.Mesh(podGeo, pad));
    }

    const speedFace = makeGaugeFace({
      label: 'VELOCIDAD',
      unit: 'MPH',
      numerals: [0, 10, 20, 30, 40, 50, 60, 70],
      redlineAt: 0.88,
      accent: '#f5b81c',
    });
    const rpmFace = makeGaugeFace({
      label: 'DIESEL',
      unit: 'x1000 RPM',
      numerals: [0, 1, 2, 3, 4],
      redlineAt: 0.8,
      accent: '#d0261f',
    });
    const airFace = makeGaugeFace({
      label: 'AIRE',
      unit: 'PSI',
      numerals: [0, 40, 80, 120],
      accent: '#8bc34a',
      face: '#141a16',
    });
    const speedGauge = buildGauge(0.118, speedFace, 0xff5a4a, parts);
    const rpmGauge = buildGauge(0.082, rpmFace, 0xffd166, parts);
    const airGauge = buildGauge(0.062, airFace, 0x8bc34a, parts);
    speedGauge.group.position.set(-0.13, 0.0, 0.012);
    rpmGauge.group.position.set(0.098, 0.026, 0.012);
    airGauge.group.position.set(0.265, -0.028, 0.012);
    pod.add(speedGauge.group, rpmGauge.group, airGauge.group);
    this.needleSpeed = speedGauge.needle;
    this.needleRpm = rpmGauge.needle;
    this.needleAir = airGauge.needle;
    /* the air gauge sits where a charged reservoir would put it and stays */
    this.needleAir.rotation.z = needleAngle(0.78);

    /* ---- switch bank + the door lever ------------------------------------ */
    const strip = makeSwitchStrip(['LUCES', 'PUERTA', 'AIRE', 'RADIO', 'FIESTA'], '#ff3fa4');
    if (strip) {
      this.textures.push(strip);
      const stripMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: strip,
        emissive: new THREE.Color(0xffffff),
        emissiveMap: strip,
        emissiveIntensity: 0.32,
        metalness: 0.2,
        roughness: 0.6,
      });
      this.materials.push(stripMat);
      addLit(parts, stripMat);
      const g = new THREE.PlaneGeometry(0.62, 0.116);
      g.rotateX(-0.35);
      g.translate(-0.2, 1.3, zDash + 0.04);
      this.geometries.push(g);
      this.cockpit.add(new THREE.Mesh(g, stripMat));
    }
    /* the long chromed door lever, the most bus-specific control there is */
    chromeShell.add(tube(0.26, 1.16, zDash + 0.22, 0.52, 1.6, zDash + 0.56, 0.02, 6));
    chromeShell.add(cyl(0.035, 0.035, 0.07, 8, 0.53, 1.63, zDash + 0.59, 'y'));

    /* ---- the taxi meter, on the fascia by the driver's right hand -------- */
    this.meter = new MeterDisplay();
    if (this.meter.texture) this.textures.push(this.meter.texture);
    const meterMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.meter.texture,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: this.meter.texture,
      emissiveIntensity: 0.6,
      metalness: 0.1,
      roughness: 0.55,
    });
    this.materials.push(meterMat);
    addLit(parts, meterMat);
    const meterPod = new THREE.Group();
    meterPod.position.set(-0.26, 1.46, G.zCowl + 0.14);
    meterPod.rotation.set(-0.34, -0.34, 0);
    this.cockpit.add(meterPod);
    const meterCase = new THREE.BoxGeometry(0.25, 0.17, 0.12);
    meterCase.translate(0, 0, -0.06);
    this.geometries.push(meterCase);
    meterPod.add(new THREE.Mesh(meterCase, pad));
    const meterFace = new THREE.PlaneGeometry(0.212, 0.132);
    meterFace.translate(0, 0, 0.002);
    this.geometries.push(meterFace);
    meterPod.add(new THREE.Mesh(meterFace, meterMat));
    /* the bracket down to the dash, so it is bolted to something */
    chromeShell.add(tube(-0.26, 1.4, G.zCowl + 0.16, -0.26, 1.3, G.zCowl + 0.16, 0.016, 6));

    /* ---- windscreen surround: header, divider post, A-pillars ------------
     *
     * The header trim is deep on purpose. The exterior model lets the
     * destination board down into the top of the windscreen — which is exactly
     * what a guagua does, and reads beautifully from the street — but from the
     * driver's seat the back of that board is a mirrored `CHINCHORREO` written
     * across the sky. This panel is the inside face of it. */
    const zWs = G.zWindscreen - 0.02;
    padShell.add(box(2.5, 0.13, 0.14, 0, G.yWindscreenTop - 0.03, zWs + 0.06));
    padShell.add(box(2.34, 0.16, 0.05, 0, G.yWindscreenTop - 0.05, zWs + 0.04));
    steelShell.add(box(0.09, 0.72, 0.1, 0, 1.7, zWs + 0.04));
    steelShell.addMirrored(box(0.1, 0.74, 0.12, 1.19, 1.7, zWs + 0.08));
    /* Trim over the inboard face of the front corner posts. Left bare, those
     * are school-bus yellow body panels 0.5 m from the driver's left ear,
     * catching full sun — the brightest thing in the frame by a wide margin
     * and the first thing the eye goes to. Every bus lines them. */
    padShell.addMirrored(box(0.05, 0.62, 0.34, 0.95, 1.78, zWs + 0.24));
    padShell.addMirrored(box(0.22, 0.6, 0.05, 1.06, 1.78, zWs + 0.4));
    /* Sun visor, full width, tucked up under the header.
     *
     * Three versions of this were wrong in three different ways, and the third
     * is the one worth recording. Version one was a 0.24 m board hanging 0.14 m
     * below the header — a black bar over most of the upper half of the frame.
     * Version two was 3 cm of trim that looked right and occluded nothing.
     * Version three was sized from the geometry to cut in at 21°, below the
     * afternoon sun's 24°, on the theory that the glare washing the frame out
     * was the sun coming in over the header — and it worked, in the sense that
     * it removed the glare by removing the road with it. The windscreen was
     * simply gone.
     *
     * The glare was never the sun *disc*. It was the sun's specular reflection
     * in the bus's own paint, and `setPaintForInterior` deals with that at the
     * material where it belongs, without spending a single degree of the view.
     * So the visor goes back to being a visor: a strip at the edge of vision,
     * full width now rather than only over the driver, because the bus turns
     * and a visor over one shoulder only helps on one heading. */
    padShell.add(box(2.3, 0.022, 0.16, 0, G.yWindscreenTop - 0.06, zWs + 0.11, -0.3));

    /* ---- the interior mirror, angled back down the aisle -----------------
     * Kept small and high for the same reason: at 0.6 m wide and 0.16 m above
     * the eye it filled a third of the windscreen. */
    chromeShell.add(tube(-0.12, G.yWindscreenTop - 0.06, zWs + 0.1, -0.12, 1.93, zWs + 0.26, 0.016, 6));
    padShell.add(box(0.38, 0.11, 0.04, -0.12, 1.92, zWs + 0.28, 0.24, 0.2, 0));
    const mirrorMat = new THREE.MeshStandardMaterial({
      color: 0x93a9bb,
      metalness: 1,
      roughness: 0.07,
      envMapIntensity: 1.8,
    });
    this.materials.push(mirrorMat);
    const mirrorGlass = new THREE.PlaneGeometry(0.35, 0.095);
    mirrorGlass.rotateY(Math.PI + 0.2);
    mirrorGlass.rotateX(-0.24);
    mirrorGlass.translate(-0.12, 1.92, zWs + 0.31);
    this.geometries.push(mirrorGlass);
    this.cockpit.add(new THREE.Mesh(mirrorGlass, mirrorMat));

    /* ---- pedals and the floor plate -------------------------------------- */
    steelShell.add(box(0.16, 0.28, 0.04, -0.5, G.yFloor + 0.24, zDash + 0.3, -0.42));
    steelShell.add(box(0.2, 0.24, 0.04, -0.84, G.yFloor + 0.26, zDash + 0.28, -0.35));
    padShell.add(box(1.0, 0.03, 0.5, -0.7, G.yFloor + 0.03, zDash + 0.42));

    /* ---- the driver's own seat, in the lower periphery ------------------- */
    padShell.add(box(0.07, 0.4, 0.5, -1.14, 1.22, G.zCowl + 0.62, -0.1));
    padShell.add(box(0.07, 0.4, 0.5, -0.18, 1.22, G.zCowl + 0.62, -0.1));

    /* ---- interior festoons: the party, seen from the driver's seat -------
     * The exterior strings run outside the body where the street can see
     * them; from the cab you would see nothing at all. These run inside, down
     * both sides of the ceiling, and share the exterior strings' materials —
     * so they chase on exactly the same beat with no extra state. */
    const groups = this.festoon.length;
    if (groups > 0) {
      const inner: Shell[] = [];
      for (let i = 0; i < groups; i++) inner.push(new Shell());
      let n = 0;
      /* Starting at `zCowl + 0.5` put a bulb 0.58 m from the driver's eye,
       * where a 0.10 m sphere is the size of a football. They start behind the
       * driver's head instead, which is where the party is anyway. */
      for (let z = G.zCowl + 1.5; z < G.zBodyRear - 0.3; z += 0.62) {
        for (const s of [-1, 1]) {
          const b = new THREE.SphereGeometry(0.05, 6, 4);
          b.translate(s * 1.06, G.yWindowTop - 0.09, z);
          inner[n % groups].add(b);
          n++;
        }
      }
      for (let i = 0; i < groups; i++) {
        const geo = inner[i].build();
        if (!geo) continue;
        this.geometries.push(geo);
        const m = new THREE.Mesh(geo, this.festoon[i]);
        m.name = `bus_cockpitFestoon${i}`;
        this.cockpit.add(m);
      }
    }

    /* ---- hands ----------------------------------------------------------- */
    this.handRig.position.copy(this.steeringWheel.position);
    this.handRig.rotation.x = this.steeringWheel.rotation.x;
    this.handRig.add(buildHands(0.25, 0.026, parts, 0xb27a52, 0xf5f0e6));
    this.cockpit.add(this.handRig);

    /* a rim marker, so the wheel's rotation is unmistakable from the seat */
    const marker = new THREE.BoxGeometry(0.07, 0.038, 0.034);
    marker.translate(0, 0.252, 0);
    this.geometries.push(marker);
    const markerMat = this.mat(BUS_PAINT.red, 0.1, 0.5);
    this.steeringWheel.add(new THREE.Mesh(marker, markerMat));

    /* ---- emit ------------------------------------------------------------ */
    for (const [shell, mat, name] of [
      [steelShell, fascia, 'fascia'],
      [padShell, pad, 'pad'],
      [chromeShell, matChrome, 'chrome'],
      [houseShell, doghouse, 'doghouse'],
    ] as const) {
      const geo = shell.build();
      if (!geo) continue;
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `bus_cockpit_${name}`;
      this.cockpit.add(mesh);
    }

    for (const m of parts.materials) this.materials.push(m);
    for (const g of parts.geometries) this.geometries.push(g);
    for (const t of parts.textures) this.textures.push(t);
    for (const e of parts.lit) this.cockpitLit.push(e);
    for (const t of [speedFace, rpmFace, airFace]) if (t) this.textures.push(t);
    void matMatte;

    this.chassis.add(this.cockpit);
  }

  /** Needle easing and the fare clock. Only runs while the seat is occupied. */
  private tickCockpit(dt: number, speed: number): void {
    if (this.needleSpeed) {
      this.needleSpeed.rotation.z = damp(
        this.needleSpeed.rotation.z,
        needleAngle(this.targetSpeedNeedle),
        BUS_COCKPIT.needleRate,
        dt,
      );
    }
    if (this.needleRpm) {
      this.needleRpm.rotation.z = damp(
        this.needleRpm.rotation.z,
        needleAngle(this.targetRpmNeedle),
        BUS_COCKPIT.needleRate * 1.6,
        dt,
      );
    }
    /* the air gauge bleeds down under braking and recharges — a bus tell */
    if (this.needleAir) {
      const charge = 0.62 + 0.24 * (1 - this.airBrakeVisual);
      this.needleAir.rotation.z = damp(
        this.needleAir.rotation.z,
        needleAngle(charge),
        2.2,
        dt,
      );
    }

    this.fareDistance += Math.abs(speed) * dt;
    this.fareClock += dt;
    if (this.fareClock >= 0.25) {
      this.fareClock = 0;
      this.meter?.set(
        BUS_COCKPIT.fareFlag + this.fareDistance * BUS_COCKPIT.farePerMetre,
        this.passenger.visible,
      );
    }
  }

  /**
   * The party. Five stylised revellers standing in the aisle with their arms
   * up, visible through the open windows. Merged into three meshes total.
   */
  private buildCrowd(): void {
    const skin = this.mat(0xc98a5e, 0, 0.8);
    const shirtA = this.mat(PALETTE.facade[2], 0.1, 0.7);
    const shirtB = this.mat(PALETTE.facade[4], 0.1, 0.7);

    const bodies: Shell[] = [new Shell(), new Shell()];
    const limbs = new Shell();

    /* x, z, how far round they are turned, and which shirt */
    const people: Array<[number, number, number, number]> = [
      [0.24, -2.1, 0.4, 0],
      [-0.26, -0.4, -0.6, 1],
      [0.3, 1.1, 0.2, 0],
      [-0.22, 2.4, 0.9, 1],
      [0.26, 3.9, -0.3, 1],
    ];

    for (const [x, z, turn, which] of people) {
      const yFeet = G.yFloor + 0.05;
      const torso = new THREE.CapsuleGeometry(0.16, 0.38, 3, 8);
      torso.translate(0, 0.62, 0);
      torso.rotateY(turn);
      torso.translate(x, yFeet, z);
      bodies[which].add(torso);

      const head = new THREE.SphereGeometry(0.13, 8, 6);
      head.translate(x, yFeet + 0.98, z);
      limbs.add(head);

      /* arms in the air, because that is what a chinchorreo looks like */
      limbs.add(tube(x - 0.14, yFeet + 0.76, z, x - 0.3, yFeet + 1.22, z + 0.06, 0.045, 5));
      limbs.add(tube(x + 0.14, yFeet + 0.76, z, x + 0.32, yFeet + 1.18, z - 0.04, 0.045, 5));
      /* legs */
      limbs.add(tube(x - 0.08, yFeet + 0.42, z, x - 0.1, yFeet, z + 0.02, 0.055, 5));
      limbs.add(tube(x + 0.08, yFeet + 0.42, z, x + 0.1, yFeet, z - 0.02, 0.055, 5));
    }

    const a = bodies[0].build();
    if (a) {
      this.geometries.push(a);
      this.chassis.add(new THREE.Mesh(a, shirtA));
    }
    const b = bodies[1].build();
    if (b) {
      this.geometries.push(b);
      this.chassis.add(new THREE.Mesh(b, shirtB));
    }
    const l = limbs.build();
    if (l) {
      this.geometries.push(l);
      this.chassis.add(new THREE.Mesh(l, skin));
    }
  }

  /** The fare, riding shotgun in the front bench by the door. */
  private buildPassenger(): void {
    const skin = this.mat(0xc98a5e, 0, 0.8);
    const dark = this.mat(0x2a2a33, 0.05, 0.8);

    const z = G.zDoorRear + 0.6;
    const x = 0.7;
    const yFeet = G.yFloor + 0.05;

    const torso = new THREE.CapsuleGeometry(0.17, 0.32, 4, 10);
    torso.translate(x, yFeet + 0.82, z);
    this.geometries.push(torso);
    this.passenger.add(new THREE.Mesh(torso, this.matPassenger));

    const hat = new Shell();
    hat.add(cyl(0.19, 0.2, 0.025, 12, x, yFeet + 1.2, z, 'y'));
    hat.add(cyl(0.12, 0.13, 0.09, 12, x, yFeet + 1.25, z, 'y'));
    const hatGeo = hat.build();
    if (hatGeo) {
      this.geometries.push(hatGeo);
      this.passenger.add(new THREE.Mesh(hatGeo, dark));
    }

    const limbs = new Shell();
    const head = new THREE.SphereGeometry(0.125, 10, 8);
    head.translate(x, yFeet + 1.11, z);
    limbs.add(head);
    limbs.add(tube(x - 0.15, yFeet + 0.94, z, x - 0.3, yFeet + 0.72, z - 0.16, 0.05, 6));
    limbs.add(tube(x + 0.15, yFeet + 0.94, z, x + 0.28, yFeet + 1.3, z + 0.04, 0.05, 6));
    limbs.add(tube(x - 0.09, yFeet + 0.6, z, x - 0.11, yFeet + 0.02, z - 0.2, 0.06, 6));
    limbs.add(tube(x + 0.09, yFeet + 0.6, z, x + 0.11, yFeet + 0.02, z - 0.24, 0.06, 6));
    const limbGeo = limbs.build();
    if (limbGeo) {
      this.geometries.push(limbGeo);
      this.passenger.add(new THREE.Mesh(limbGeo, skin));
    }

    this.passenger.visible = false;
    this.passenger.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    this.chassis.add(this.passenger);
  }

  /**
   * Commercial truck tyres and polished steel rims. Two merged geometries are
   * shared by all six tyres — the rear struts carry a dual on each side.
   */
  private buildWheels(
    matRubber: THREE.Material,
    matChrome: THREE.Material,
    matSteel: THREE.Material,
  ): void {
    const R = BUS_SUSPENSION.wheelRadius;
    const W = BUS_SUSPENSION.wheelWidth;

    /* --- tyre: carcass plus a rib tread. The lug BOXES define the rolling
     * surface, so their outermost CORNER has to land on the physics radius or
     * the tread visibly saws through the cobblestones. --- */
    const lugRadial = 0.035;
    const lugTangential = 0.055;
    const lugCornerR = Math.hypot(lugRadial, lugTangential);
    const lugCentreR = R - lugCornerR + 0.012;
    const carcassR = lugCentreR - lugRadial * 0.95;

    const tyre = new Shell();
    tyre.add(cyl(carcassR, carcassR, W, 22, 0, 0, 0, 'x'));
    tyre.add(cyl(carcassR - 0.05, carcassR - 0.05, W + 0.02, 16, 0, 0, 0, 'x'));

    const blocks = 18;
    for (let i = 0; i < blocks; i++) {
      const a = (i / blocks) * Math.PI * 2;
      /* three narrow ribs across the tread, as a commercial tyre has */
      for (let row = -1; row <= 1; row++) {
        const g = new THREE.BoxGeometry(W * 0.24, lugRadial * 2, lugTangential * 2);
        g.rotateX(-a);
        g.translate(row * W * 0.3, Math.sin(a) * lugCentreR, Math.cos(a) * lugCentreR);
        tyre.add(g);
      }
    }
    const tyreGeo = tyre.build();

    /* --- rim: polished steel barrel, ten fasteners, a dished centre --- */
    const rim = new Shell();
    rim.add(cyl(0.34, 0.34, W * 0.7, 18, 0, 0, 0, 'x'));
    rim.add(cyl(0.36, 0.36, 0.04, 18, W * 0.36, 0, 0, 'x'));
    rim.add(cyl(0.12, 0.12, W * 0.78, 12, 0, 0, 0, 'x'));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const nut = new THREE.CylinderGeometry(0.024, 0.024, 0.04, 6);
      nut.rotateZ(Math.PI / 2);
      nut.translate(W * 0.4, Math.sin(a) * 0.19, Math.cos(a) * 0.19);
      rim.add(nut);
      /* hand holes in the disc */
      if (i % 2 === 0) {
        const hole = new THREE.BoxGeometry(W * 0.2, 0.11, 0.11);
        hole.rotateX(-a);
        hole.translate(-W * 0.2, Math.sin(a) * 0.26, Math.cos(a) * 0.26);
        rim.add(hole);
      }
    }
    rim.add(cyl(0.09, 0.075, 0.06, 10, W * 0.42, 0, 0, 'x'));
    const rimGeo = rim.build();

    if (tyreGeo) this.geometries.push(tyreGeo);
    if (rimGeo) this.geometries.push(rimGeo);

    const rest = BUS_SUSPENSION.anchorY - BUS_SUSPENSION.restLength * (1 - G.staticCompression);

    for (let i = 0; i < 4; i++) {
      const l = BUS_WHEEL_LAYOUT[i];
      const root = new THREE.Group();
      root.position.set(l.x, rest, l.z);

      const steer = new THREE.Group();
      const spin = new THREE.Group();

      /* the rear axle carries a dual each side; the front runs a single */
      const offsets = l.front ? [0] : [-G.dualOffset, G.dualOffset];
      for (const off of offsets) {
        if (tyreGeo) {
          const m = new THREE.Mesh(tyreGeo, matRubber);
          m.position.x = off;
          m.castShadow = true;
          spin.add(m);
        }
        if (rimGeo) {
          const m = new THREE.Mesh(rimGeo, l.front ? matChrome : matSteel);
          m.position.x = off;
          /* the inner rim of a dual faces the other way */
          if (off < 0) m.scale.x = -1;
          m.castShadow = true;
          spin.add(m);
        }
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

/* ----------------------------------------------------------------- helpers */

/**
 * The shape of a light pulse across one beat: a hard attack on the downbeat
 * falling away over the rest of it. Returns 1 at phase 0 and ~0 by phase 1.
 */
function beatPunch(phase: number): number {
  const p = phase - Math.floor(phase);
  /* a short rise so the very first frame of the beat is not a hard step */
  if (p < 0.06) return p / 0.06;
  const t = (p - 0.06) / 0.94;
  return Math.max(0, (1 - t) * (1 - t) * (1 - t * 0.35));
}

const ARCHETYPE_COLORS = PALETTE.facade;

/** Stable per-archetype shirt colour so the same fare always looks the same. */
function archetypeColor(id?: string): number {
  if (!id) return ARCHETYPE_COLORS[4];
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ARCHETYPE_COLORS[(h >>> 0) % ARCHETYPE_COLORS.length];
}
