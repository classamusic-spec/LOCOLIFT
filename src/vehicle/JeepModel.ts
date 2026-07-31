/**
 * Loco Lift — the Jeep, built entirely out of code.
 *
 * An open-top, open-back customised off-road Jeep running as a taxi in Old San
 * Juan. Flat vertical grille, round headlights, fat fender flares, exposed
 * chrome roll cage over an open cockpit, an open rear bed with a passenger
 * bench and grab rails, snorkel, spare on the tailgate, bull bar, rock rails
 * and a lit TAXI sign on the cage.
 *
 * Everything is procedural Three.js geometry and Canvas2D textures — no files,
 * no downloads, works fully offline. Parts that never move are merged per
 * material so the whole Jeep draws in roughly a dozen calls; anything the
 * Vehicle animates (wheels, steering wheel, lights, the leaning body) stays a
 * separate node.
 *
 * Hierarchy:
 *   object3d ─┬─ chassis        ← leans/heaves cosmetically over the rigid body
 *             │    ├─ merged shells, cage, lights, seats, steering wheel
 *             │    └─ passenger  ← toggled by setSeatOccupied
 *             └─ wheelRoot[i]   ← suspension travel
 *                  └─ steer[i]  ← front wheels only
 *                       └─ spin[i]
 *
 * Local axes match the physics body: forward = -Z, right = +X, up = +Y, and
 * y = MODEL.groundLocalY is where the tyres touch at static ride height.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from '../core/Config';
import { clamp, clamp01 } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { MODEL, SUSPENSION, WHEEL_LAYOUT } from './VehicleTuning';

/* ------------------------------------------------------------------ palette */

/** The Jeep's own colour scheme, drawn from the city palette. */
const PAINT = {
  /** mustard — the taxi's signature body colour */
  main: PALETTE.facade[0],
  /** caribbean teal — flares, rock rails, lower body */
  accent: PALETTE.facade[2],
  /** bougainvillea rose — the racing stripe */
  stripe: PALETTE.facade[8],
  /** cream — the livery panel */
  cream: PALETTE.facade[6],
  chrome: 0xdfe6ee,
  matte: 0x1c1c22,
  rubber: 0x101014,
  seat: 0x2c1f18,
  seatTrim: PALETTE.facade[3],
  glass: 0xbfe6f2,
  headlight: 0xfff3d0,
  taillight: 0xff2b3c,
  sign: 0xfff0b8,
  boost: 0x59d8ff,
} as const;

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------- geometry utilities */

/** Accumulates geometry for one material, then merges it into a single mesh. */
class Shell {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
  }

  /** Add `geo` and its mirror across the YZ plane — the whole car is symmetric. */
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

/** A capped tube running from a to b — the roll cage's building block. */
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

/* --------------------------------------------------------------- textures */

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

/** Roof sign face: chunky TAXI lettering over a checker band. */
function makeSignTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256, 96);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#fff0b8';
  g.fillRect(0, 0, 256, 96);

  /* checker band top and bottom — the universal taxi cue */
  const sq = 12;
  for (let x = 0; x < 256 / sq; x++) {
    g.fillStyle = x % 2 === 0 ? '#1c1c22' : '#f2b134';
    g.fillRect(x * sq, 0, sq, sq);
    g.fillStyle = x % 2 === 0 ? '#f2b134' : '#1c1c22';
    g.fillRect(x * sq, 96 - sq, sq, sq);
  }

  g.fillStyle = '#1c1c22';
  g.font = 'bold 52px Impact, "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('TAXI', 128, 50);

  return canvasTexture(c);
}

/** Door livery: LOCO LIFT wordmark on a transparent background. */
function makeLiveryTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(512, 128);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.clearRect(0, 0, 512, 128);

  g.fillStyle = '#f7e3af';
  g.strokeStyle = '#1c1c22';
  g.lineWidth = 6;
  g.font = 'italic bold 62px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.strokeText('LOCO LIFT', 256, 52);
  g.fillText('LOCO LIFT', 256, 52);

  g.fillStyle = '#2fa8a0';
  g.font = 'bold 22px "Trebuchet MS", sans-serif';
  g.fillText('VIEJO SAN JUAN  ·  24 HORAS', 256, 100);

  /* a little rose flourish under the wordmark */
  g.strokeStyle = '#ef476f';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(96, 78);
  g.lineTo(416, 78);
  g.stroke();

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
  g.font = 'bold 54px "Arial Black", sans-serif';
  g.fillText('LOCO·1', 128, 90);

  return canvasTexture(c);
}

/* ============================================================== the model */

export class JeepModel {
  /** root; Vehicle copies the rigid body transform onto this every frame */
  readonly object3d = new THREE.Group();
  /** everything that leans cosmetically over the chassis */
  readonly chassis = new THREE.Group();

  /** suspension nodes, one per wheel — Vehicle sets their local Y */
  readonly wheelRoots: THREE.Group[] = [];
  /** steering nodes (front wheels turn, rear wheels do not) */
  readonly wheelSteer: THREE.Group[] = [];
  /** spin nodes — the actual rolling rotation */
  readonly wheelSpin: THREE.Group[] = [];

  private readonly steeringWheel = new THREE.Group();
  private readonly passenger = new THREE.Group();
  private readonly beams = new THREE.Group();

  /* live materials */
  private readonly matHeadlight: THREE.MeshStandardMaterial;
  private readonly matTaillight: THREE.MeshStandardMaterial;
  private readonly matSign: THREE.MeshStandardMaterial;
  private readonly matBoost: THREE.MeshStandardMaterial;
  private readonly matBeam: THREE.MeshBasicMaterial;
  private readonly matPassenger: THREE.MeshStandardMaterial;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];

  private readonly spinAccum = [0, 0, 0, 0];
  private signPhase = 0;
  private idlePhase = 0;
  private boostGlow = 0;
  private headlightsOn = false;

  constructor(quality: QualityTier = 'high') {
    this.object3d.name = 'Jeep';
    this.object3d.add(this.chassis);

    /* ---------------------------------------------------------- materials */
    const matPaint = this.mat(PAINT.main, 0.45, 0.34);
    const matAccent = this.mat(PAINT.accent, 0.35, 0.42);
    const matStripe = this.mat(PAINT.stripe, 0.3, 0.4);
    const matChrome = this.mat(PAINT.chrome, 1.0, 0.16);
    const matMatte = this.mat(PAINT.matte, 0.15, 0.85);
    const matRubber = this.mat(PAINT.rubber, 0.05, 0.95);
    const matSeat = this.mat(PAINT.seat, 0.1, 0.8);
    const matSeatTrim = this.mat(PAINT.seatTrim, 0.15, 0.6);

    const matGlass = new THREE.MeshStandardMaterial({
      color: PAINT.glass,
      metalness: 0.1,
      roughness: 0.06,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide,
    });
    this.materials.push(matGlass);

    this.matHeadlight = new THREE.MeshStandardMaterial({
      color: PAINT.headlight,
      emissive: new THREE.Color(PAINT.headlight),
      emissiveIntensity: MODEL.headlightIntensityOff,
      metalness: 0.2,
      roughness: 0.25,
    });
    this.materials.push(this.matHeadlight);

    this.matTaillight = new THREE.MeshStandardMaterial({
      color: PAINT.taillight,
      emissive: new THREE.Color(PAINT.taillight),
      emissiveIntensity: MODEL.taillightIntensityOff,
      metalness: 0.1,
      roughness: 0.35,
    });
    this.materials.push(this.matTaillight);

    const signTex = makeSignTexture();
    if (signTex) this.textures.push(signTex);
    this.matSign = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: signTex ?? null,
      emissive: new THREE.Color(PAINT.sign),
      emissiveMap: signTex ?? null,
      emissiveIntensity: MODEL.signIntensity,
      metalness: 0.05,
      roughness: 0.5,
    });
    this.materials.push(this.matSign);

    this.matBoost = new THREE.MeshStandardMaterial({
      color: PAINT.boost,
      emissive: new THREE.Color(PAINT.boost),
      emissiveIntensity: 0,
      metalness: 0.1,
      roughness: 0.4,
      transparent: true,
      opacity: 0.9,
    });
    this.materials.push(this.matBoost);

    this.matBeam = new THREE.MeshBasicMaterial({
      color: PAINT.headlight,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.materials.push(this.matBeam);

    this.matPassenger = this.mat(PALETTE.facade[4], 0.1, 0.75);

    /* ------------------------------------------------------------ shells */
    const paint = new Shell();
    const accent = new Shell();
    const stripe = new Shell();
    const chrome = new Shell();
    const matte = new Shell();
    const seatShell = new Shell();

    this.buildFrame(matte);
    this.buildTub(paint, accent, stripe, matte);
    this.buildNose(paint, accent, chrome, matte);
    this.buildRear(paint, accent, chrome, matte);
    this.buildCage(chrome);
    this.buildInterior(matte, seatShell, matSeatTrim, seatShell);
    this.buildDetails(chrome, matte, accent);

    this.emit(paint.build(), matPaint, 'body');
    this.emit(accent.build(), matAccent, 'accent');
    this.emit(stripe.build(), matStripe, 'stripe');
    this.emit(chrome.build(), matChrome, 'chrome');
    this.emit(matte.build(), matMatte, 'trim');
    this.emit(seatShell.build(), matSeat, 'seats');

    this.buildGlass(matGlass);
    this.buildLights();
    this.buildSign();
    this.buildDecals();
    this.buildSteeringWheel(matMatte, matChrome);
    this.buildPassenger();
    this.buildWheels(matRubber, matChrome, matMatte);

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
  }

  /* ================================================== Vehicle-facing methods */

  /** Front wheel angle in radians; positive = steering right. */
  setSteer(rad: number): void {
    const a = clamp(rad, -1.2, 1.2);
    /* positive steer is a right turn, which is a negative rotation about +Y */
    this.wheelSteer[0].rotation.y = -a;
    this.wheelSteer[1].rotation.y = -a;
    this.steeringWheel.rotation.z = -a * MODEL.steeringWheelRatio;
  }

  /** Advance every wheel by `dr` radians (positive = rolling forward). */
  spinWheels(dr: number): void {
    if (!Number.isFinite(dr)) return;
    for (let i = 0; i < 4; i++) {
      this.spinAccum[i] += dr;
      this.wheelSpin[i].rotation.x = -this.spinAccum[i];
    }
  }

  /** Absolute per-wheel roll angle in radians (positive = rolling forward). */
  setWheelSpin(i: number, radians: number): void {
    if (i < 0 || i > 3 || !Number.isFinite(radians)) return;
    this.spinAccum[i] = radians;
    this.wheelSpin[i].rotation.x = -radians;
  }

  /** Suspension travel for one wheel; 0 = fully drooped, 1 = bottomed out. */
  setSuspension(i: number, compression: number): void {
    if (i < 0 || i > 3) return;
    const c = clamp01(compression);
    this.wheelRoots[i].position.y =
      SUSPENSION.anchorY - SUSPENSION.restLength * (1 - c);
  }

  setBrakeLights(on: boolean): void {
    this.matTaillight.emissiveIntensity = on
      ? MODEL.taillightIntensityOn
      : MODEL.taillightIntensityOff;
  }

  /** 0..1 — exhaust flare, underglow and a hot tailpipe. */
  setBoostGlow(v: number): void {
    this.boostGlow = clamp01(v);
    this.matBoost.emissiveIntensity = this.boostGlow * MODEL.boostGlowIntensity;
    this.matBoost.opacity = 0.25 + this.boostGlow * 0.7;
  }

  setHeadlights(on: boolean): void {
    this.headlightsOn = on;
    this.matHeadlight.emissiveIntensity = on
      ? MODEL.headlightIntensityOn
      : MODEL.headlightIntensityOff;
    this.matSign.emissiveIntensity = on ? MODEL.signIntensity * 1.6 : MODEL.signIntensity;
    this.beams.visible = on && this.beamsAllowed;
  }

  /** Show the fare in the back. `archetypeId` tints their shirt. */
  setSeatOccupied(occupied: boolean, archetypeId?: string): void {
    this.passenger.visible = occupied;
    if (occupied) {
      this.matPassenger.color.setHex(archetypeColor(archetypeId));
    }
  }

  /** Cosmetic body attitude layered over the rigid body's real motion. */
  setChassisLean(pitch: number, roll: number, heave: number): void {
    this.chassis.rotation.x = pitch;
    this.chassis.rotation.z = -roll;
    this.chassis.position.y = heave;
  }

  /** Idle shake and sign shimmer. Cheap, and it stops the Jeep looking dead. */
  tick(dt: number, speed: number): void {
    this.idlePhase += dt * 34;
    this.signPhase += dt * 2.2;

    const idle = clamp01(1 - speed / 6);
    const shake = Math.sin(this.idlePhase) * 0.0016 * idle;
    this.chassis.position.x = shake;
    this.chassis.rotation.y = Math.sin(this.idlePhase * 0.63) * 0.0022 * idle;

    if (this.headlightsOn) {
      this.matSign.emissiveIntensity =
        MODEL.signIntensity * (1.6 + Math.sin(this.signPhase) * 0.12);
    }
  }

  setQuality(tier: QualityTier): void {
    this.beamsAllowed = tier === 'high' || tier === 'ultra';
    this.beams.visible = this.headlightsOn && this.beamsAllowed;
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

  private beamsAllowed = true;

  /* ================================================================ builders */

  private mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
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
    mesh.name = `jeep_${name}`;
    this.chassis.add(mesh);
  }

  /** Ladder frame and skid plates — visible under a jacked-up off-roader. */
  private buildFrame(matte: Shell): void {
    matte.addMirrored(box(0.13, 0.14, 3.95, 0.54, -0.06, 0.06));
    matte.add(box(1.1, 0.11, 0.13, 0, -0.06, -1.6));
    matte.add(box(1.1, 0.11, 0.13, 0, -0.06, 1.62));
    matte.add(box(1.05, 0.09, 0.12, 0, -0.06, 0.2));
    /* front and rear diffs */
    matte.add(cyl(0.16, 0.16, 0.26, 10, 0, -0.09, -1.45, 'x'));
    matte.add(cyl(0.17, 0.17, 0.28, 10, 0, -0.09, 1.45, 'x'));
    matte.add(cyl(0.055, 0.055, 2.7, 8, 0, -0.09, 0.0, 'z'));
    /* axle tubes out to the hubs */
    matte.addMirrored(cyl(0.065, 0.065, 0.66, 8, 0.48, -0.095, -1.45, 'x'));
    matte.addMirrored(cyl(0.065, 0.065, 0.66, 8, 0.48, -0.095, 1.45, 'x'));
  }

  /** The tub: floor, body sides, flares, rock rails, stripes. */
  private buildTub(paint: Shell, accent: Shell, stripe: Shell, matte: Shell): void {
    const H = MODEL.halfWidth;

    /* floor pan */
    matte.add(box(1.54, 0.07, 2.9, 0, 0.03, 0.55));

    /* body sides, cowl to tailgate */
    paint.addMirrored(box(0.09, 0.6, 2.8, H, 0.32, 0.64));
    /* upper sill cap so the open top reads as a finished edge */
    accent.addMirrored(box(0.13, 0.06, 2.8, H, 0.63, 0.64));

    /* the lower body band in accent teal */
    accent.addMirrored(box(0.1, 0.16, 2.8, H + 0.005, 0.09, 0.64));

    /* rose stripe down the flank */
    stripe.addMirrored(box(0.1, 0.075, 2.7, H + 0.008, 0.45, 0.6));

    /* cowl / firewall in front of the driver */
    paint.add(box(1.56, 0.32, 0.3, 0, 0.46, -0.62));
    accent.add(box(1.58, 0.05, 0.32, 0, 0.63, -0.62));

    /* fender flares — big, proud, unmistakably off-road */
    for (const front of [true, false]) {
      const z = front ? -SUSPENSION.halfWheelbase : SUSPENSION.halfWheelbase;
      const g = new THREE.TorusGeometry(0.585, 0.085, 5, 14, Math.PI);
      g.rotateY(Math.PI / 2);
      g.translate(0.85, -0.02, z);
      accent.addMirrored(g);
      /* inner arch liner so you never see through the flare */
      const liner = new THREE.TorusGeometry(0.55, 0.05, 4, 12, Math.PI);
      liner.rotateY(Math.PI / 2);
      liner.translate(0.74, -0.02, z);
      matte.addMirrored(liner);
    }

    /* front fender tops — the flat Jeep shelf either side of the bonnet */
    paint.addMirrored(box(0.34, 0.11, 1.1, 0.71, 0.5, -1.4));
    accent.addMirrored(box(0.36, 0.045, 1.1, 0.71, 0.57, -1.4));

    /* rock rails / side steps */
    accent.addMirrored(box(0.15, 0.11, 1.85, 0.87, -0.28, 0.15));
    matte.addMirrored(tube(0.87, -0.28, -0.75, 0.87, 0.0, -0.72, 0.035, 6));
    matte.addMirrored(tube(0.87, -0.28, 1.05, 0.87, 0.0, 1.02, 0.035, 6));
  }

  /** Bonnet, grille, headlight surround, bull bar, snorkel. */
  private buildNose(paint: Shell, accent: Shell, chrome: Shell, matte: Shell): void {
    /* bonnet, very slightly wedged */
    paint.add(box(1.42, 0.1, 1.38, 0, 0.5, -1.3));
    paint.add(box(1.3, 0.06, 1.16, 0, 0.555, -1.3));
    /* bonnet stripe */
    accent.add(box(0.22, 0.02, 1.36, 0, 0.59, -1.3));
    accent.add(box(0.44, 0.015, 1.36, 0, 0.585, -1.3));
    /* hood latches */
    chrome.addMirrored(box(0.06, 0.05, 0.14, 0.5, 0.53, -1.94));
    /* bonnet vent */
    matte.add(box(0.5, 0.035, 0.2, 0, 0.585, -0.9));

    /* the flat vertical grille */
    matte.add(box(1.4, 0.52, 0.08, 0, 0.31, -1.99));
    for (let i = 0; i < 7; i++) {
      const x = -0.48 + i * 0.16;
      chrome.add(box(0.075, 0.4, 0.05, x, 0.31, -2.03));
    }
    accent.add(box(1.46, 0.06, 0.1, 0, 0.58, -1.99));
    accent.add(box(1.46, 0.06, 0.1, 0, 0.045, -1.99));

    /* headlight buckets — chrome bezels, lenses added separately */
    chrome.addMirrored(
      cyl(0.19, 0.19, 0.08, 14, 0.5, 0.31, -2.0, 'z'),
    );

    /* front bumper + bull bar */
    matte.add(box(1.72, 0.14, 0.16, 0, 0.02, -2.12));
    chrome.add(tube(-0.8, 0.12, -2.2, 0.8, 0.12, -2.2, 0.05, 8));
    chrome.addMirrored(tube(0.58, 0.05, -2.2, 0.58, 0.62, -2.14, 0.045, 8));
    chrome.add(tube(-0.6, 0.62, -2.14, 0.6, 0.62, -2.14, 0.045, 8));
    chrome.add(tube(0, 0.12, -2.2, 0, 0.62, -2.14, 0.04, 6));
    chrome.addMirrored(tube(0.3, 0.12, -2.2, 0.3, 0.62, -2.14, 0.035, 6));
    /* tow hooks */
    accent.addMirrored(box(0.09, 0.13, 0.2, 0.42, 0.0, -2.16));

    /* snorkel up the right A-pillar */
    matte.add(cyl(0.055, 0.055, 0.2, 8, 0.7, 0.45, -1.62, 'z'));
    matte.add(tube(0.7, 0.45, -1.72, 0.7, 0.52, -1.02, 0.055, 8));
    matte.add(tube(0.7, 0.52, -1.02, 0.7, 1.12, -0.86, 0.055, 8));
    matte.add(cyl(0.075, 0.075, 0.2, 8, 0.7, 1.16, -0.94, 'z'));
    chrome.add(box(0.17, 0.03, 0.22, 0.7, 1.26, -0.94));
  }

  /** Rear bed, tailgate, spare carrier, bumper, exhaust. */
  private buildRear(paint: Shell, accent: Shell, chrome: Shell, matte: Shell): void {
    /* bed floor with ribs */
    matte.add(box(1.5, 0.05, 1.5, 0, 0.09, 1.28));
    for (let i = 0; i < 4; i++) {
      matte.add(box(0.06, 0.03, 1.46, -0.51 + i * 0.34, 0.125, 1.28));
    }

    /* tailgate */
    paint.add(box(1.56, 0.56, 0.09, 0, 0.34, 2.03));
    accent.add(box(1.58, 0.06, 0.11, 0, 0.63, 2.03));
    chrome.addMirrored(box(0.07, 0.11, 0.05, 0.6, 0.16, 2.09));

    /* spare wheel carrier arm */
    matte.add(tube(-0.6, 0.2, 2.08, -0.6, 0.28, 2.24, 0.05, 6));
    matte.add(tube(-0.6, 0.28, 2.24, 0.12, 0.28, 2.24, 0.05, 6));

    /* rear bumper */
    matte.add(box(1.74, 0.16, 0.15, 0, -0.06, 2.14));
    chrome.addMirrored(box(0.34, 0.05, 0.17, 0.62, 0.03, 2.15));

    /* exhaust */
    matte.add(tube(0.42, -0.14, 1.2, 0.56, -0.16, 2.06, 0.045, 8));
    chrome.add(cyl(0.062, 0.052, 0.2, 10, 0.56, -0.16, 2.16, 'z'));

    /* bed grab rails for the passengers */
    chrome.addMirrored(tube(0.7, 0.66, 0.72, 0.7, 0.66, 1.92, 0.028, 6));
    chrome.addMirrored(tube(0.7, 0.64, 0.74, 0.7, 0.5, 0.74, 0.026, 6));
    chrome.addMirrored(tube(0.7, 0.64, 1.9, 0.7, 0.5, 1.9, 0.026, 6));
  }

  /** The exposed chrome roll cage over the open cockpit and bed. */
  private buildCage(chrome: Shell): void {
    const R = 0.042;
    const W = 0.72;
    const wsTopZ = -0.16;
    const wsTopY = MODEL.yWindscreenTop;

    /* windscreen frame uprights */
    chrome.addMirrored(tube(W, 0.5, -0.5, W, wsTopY, wsTopZ, R));
    chrome.add(tube(-W, wsTopY, wsTopZ, W, wsTopY, wsTopZ, R));
    chrome.add(tube(-W, 0.5, -0.5, W, 0.5, -0.5, R * 0.9));

    /* main hoop behind the front seats */
    chrome.addMirrored(tube(W, 0.5, 0.55, W, MODEL.yCage, 0.55, R));
    chrome.add(tube(-W, MODEL.yCage, 0.55, W, MODEL.yCage, 0.55, R));
    /* hoop diagonal brace */
    chrome.add(tube(-W, 0.62, 0.55, W, MODEL.yCage - 0.04, 0.55, R * 0.7));

    /* rear hoop over the bed */
    chrome.addMirrored(tube(W, 0.5, 1.9, W, 1.06, 1.9, R));
    chrome.add(tube(-W, 1.06, 1.9, W, 1.06, 1.9, R));

    /* longitudinal rails tying it all together */
    chrome.addMirrored(tube(W, wsTopY, wsTopZ, W, MODEL.yCage, 0.55, R));
    chrome.addMirrored(tube(W, MODEL.yCage, 0.55, W, 1.06, 1.9, R));

    /* rear stays down to the tub */
    chrome.addMirrored(tube(W, 1.06, 1.9, W, 0.62, 2.0, R * 0.8));

    /* cage feet */
    chrome.addMirrored(box(0.11, 0.05, 0.12, W, 0.49, 0.55));
    chrome.addMirrored(box(0.11, 0.05, 0.12, W, 0.49, 1.9));
  }

  /** Dash, seats, bench and the passenger grab handle. */
  private buildInterior(
    matte: Shell,
    seats: Shell,
    _trim: THREE.Material,
    _unused: Shell,
  ): void {
    /* dashboard + instrument binnacle */
    matte.add(box(1.44, 0.2, 0.28, 0, 0.55, -0.56));
    matte.add(box(0.42, 0.16, 0.16, -0.38, 0.68, -0.5, -0.25));
    /* transmission tunnel */
    matte.add(box(0.3, 0.2, 1.0, 0, 0.12, -0.1));
    /* gear lever */
    matte.add(tube(0.06, 0.22, -0.02, 0.09, 0.44, 0.06, 0.022, 6));

    /* front buckets */
    for (const side of [-1, 1]) {
      const x = side * 0.37;
      seats.add(box(0.46, 0.13, 0.48, x, 0.29, 0.02));
      seats.add(box(0.46, 0.55, 0.12, x, 0.57, 0.26, -0.16));
      seats.add(box(0.2, 0.14, 0.1, x, 0.86, 0.32, -0.16));
    }

    /* rear bench across the bed */
    seats.add(box(1.4, 0.14, 0.44, 0, 0.31, 1.42));
    seats.add(box(1.4, 0.46, 0.12, 0, 0.56, 1.68, -0.14));
    matte.add(box(1.42, 0.06, 0.46, 0, 0.23, 1.42));
  }

  /** Mirrors, aerial, jerry can, light bar, plate housing, underglow. */
  private buildDetails(chrome: Shell, matte: Shell, accent: Shell): void {
    /* wing mirrors on the windscreen frame */
    chrome.addMirrored(tube(0.73, 0.88, -0.36, 0.92, 0.9, -0.42, 0.022, 6));
    matte.addMirrored(box(0.05, 0.16, 0.2, 0.95, 0.9, -0.44, 0, 0.2, 0));

    /* aerial */
    matte.add(tube(-0.78, 0.6, -0.62, -0.84, 1.5, -0.5, 0.012, 5));

    /* jerry can strapped to the bed side */
    accent.add(box(0.16, 0.36, 0.28, -0.62, 0.3, 1.02));
    chrome.add(box(0.18, 0.03, 0.07, -0.62, 0.44, 1.02));

    /* light bar on the bull bar */
    matte.add(box(0.72, 0.09, 0.09, 0, 0.72, -2.13));
    chrome.addMirrored(tube(0.3, 0.62, -2.14, 0.3, 0.7, -2.13, 0.018, 5));

    /* plate housing */
    matte.add(box(0.42, 0.22, 0.03, -0.42, 0.12, 2.09));
  }

  private buildGlass(matGlass: THREE.Material): void {
    /* raked windscreen: base (0,0.5,-0.5) to top (0,1.04,-0.16) */
    const dy = MODEL.yWindscreenTop - 0.5;
    const dz = -0.16 - -0.5;
    const len = Math.hypot(dy, dz);
    const g = new THREE.PlaneGeometry(1.4, len - 0.05);
    g.rotateX(Math.atan2(dz, dy) - Math.PI / 2);
    g.translate(0, 0.5 + dy * 0.5, -0.5 + dz * 0.5);
    this.geometries.push(g);
    const mesh = new THREE.Mesh(g, matGlass);
    mesh.name = 'jeep_glass';
    mesh.castShadow = false;
    this.chassis.add(mesh);
  }

  private buildLights(): void {
    /* headlamp lenses */
    const head = new Shell();
    head.addMirrored(cyl(0.155, 0.155, 0.05, 14, 0.5, 0.31, -2.045, 'z'));
    const headGeo = head.build();
    if (headGeo) {
      this.geometries.push(headGeo);
      const m = new THREE.Mesh(headGeo, this.matHeadlight);
      m.name = 'jeep_headlights';
      this.chassis.add(m);
    }

    /* tail lamps + a high-level brake bar on the rear hoop */
    const tail = new Shell();
    tail.addMirrored(box(0.15, 0.26, 0.05, 0.63, 0.4, 2.08));
    tail.add(box(0.5, 0.06, 0.05, 0, 1.02, 1.96));
    const tailGeo = tail.build();
    if (tailGeo) {
      this.geometries.push(tailGeo);
      const m = new THREE.Mesh(tailGeo, this.matTaillight);
      m.name = 'jeep_taillights';
      this.chassis.add(m);
    }

    /* boost glow: exhaust tip disc + a thin underglow strip */
    const glow = new Shell();
    glow.add(cyl(0.05, 0.05, 0.02, 10, 0.56, -0.16, 2.26, 'z'));
    glow.addMirrored(box(0.05, 0.02, 1.8, 0.8, -0.34, 0.2));
    const glowGeo = glow.build();
    if (glowGeo) {
      this.geometries.push(glowGeo);
      const m = new THREE.Mesh(glowGeo, this.matBoost);
      m.name = 'jeep_boostGlow';
      m.castShadow = false;
      this.chassis.add(m);
    }

    /* cheap fake headlight beams, high/ultra only */
    const beamGeo = new THREE.ConeGeometry(0.55, 5.5, 10, 1, true);
    beamGeo.rotateX(-Math.PI / 2);
    beamGeo.translate(0, 0, -2.8);
    this.geometries.push(beamGeo);
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(beamGeo, this.matBeam);
      beam.position.set(side * 0.5, 0.31, -2.05);
      beam.castShadow = false;
      beam.receiveShadow = false;
      this.beams.add(beam);
    }
    this.beams.visible = false;
  }

  private buildSign(): void {
    const shell = new Shell();
    /* mounting posts up from the main hoop */
    shell.addMirrored(box(0.04, 0.14, 0.04, 0.2, 1.24, 0.55));
    const post = shell.build();
    if (post) {
      this.geometries.push(post);
      const m = new THREE.Mesh(post, this.materials[0]);
      m.name = 'jeep_signPost';
      this.chassis.add(m);
    }

    const geo = new THREE.BoxGeometry(0.68, 0.2, 0.16);
    this.geometries.push(geo);
    const sign = new THREE.Mesh(geo, this.matSign);
    sign.name = 'jeep_taxiSign';
    sign.position.set(0, MODEL.ySign, 0.55);
    this.chassis.add(sign);
  }

  private buildDecals(): void {
    const livery = makeLiveryTexture();
    if (livery) {
      this.textures.push(livery);
      const mat = new THREE.MeshStandardMaterial({
        map: livery,
        transparent: true,
        metalness: 0.1,
        roughness: 0.5,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      this.materials.push(mat);
      const geo = new THREE.PlaneGeometry(1.5, 0.375);
      this.geometries.push(geo);
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(side * (MODEL.halfWidth + 0.055), 0.34, 0.55);
        m.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        m.castShadow = false;
        this.chassis.add(m);
      }
    }

    const plate = makePlateTexture();
    if (plate) {
      this.textures.push(plate);
      const mat = new THREE.MeshStandardMaterial({
        map: plate,
        metalness: 0.2,
        roughness: 0.6,
      });
      this.materials.push(mat);
      const geo = new THREE.PlaneGeometry(0.38, 0.19);
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(-0.42, 0.12, 2.11);
      m.castShadow = false;
      this.chassis.add(m);
    }
  }

  private buildSteeringWheel(matMatte: THREE.Material, matChrome: THREE.Material): void {
    /* left-hand drive: Puerto Rico drives on the right */
    this.steeringWheel.position.set(-0.37, 0.74, -0.42);
    this.steeringWheel.rotation.x = -1.15;

    const rim = new THREE.TorusGeometry(0.15, 0.022, 6, 18);
    this.geometries.push(rim);
    this.steeringWheel.add(new THREE.Mesh(rim, matMatte));

    const spokes = new Shell();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      spokes.add(
        box(0.024, 0.15, 0.02, Math.cos(a + Math.PI / 2) * 0.075, Math.sin(a + Math.PI / 2) * 0.075, 0, 0, 0, a),
      );
    }
    spokes.add(cyl(0.045, 0.045, 0.05, 10, 0, 0, 0, 'z'));
    const spokeGeo = spokes.build();
    if (spokeGeo) {
      this.geometries.push(spokeGeo);
      this.steeringWheel.add(new THREE.Mesh(spokeGeo, matChrome));
    }

    const column = cyl(0.03, 0.03, 0.3, 8, -0.37, 0.63, -0.28, 'z');
    column.rotateX(0.4);
    this.geometries.push(column);
    this.chassis.add(new THREE.Mesh(column, matMatte));

    this.chassis.add(this.steeringWheel);
  }

  /** A stylised fare riding in the back — hands on the grab rail, hat on. */
  private buildPassenger(): void {
    const skin = new THREE.MeshStandardMaterial({
      color: 0xc98a5e,
      metalness: 0,
      roughness: 0.8,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x2a2a33,
      metalness: 0.05,
      roughness: 0.8,
    });
    this.materials.push(skin, dark);

    const torso = new THREE.CapsuleGeometry(0.17, 0.3, 4, 10);
    torso.translate(0, 0.78, 1.5);
    this.geometries.push(torso);
    this.passenger.add(new THREE.Mesh(torso, this.matPassenger));

    const head = new THREE.SphereGeometry(0.125, 12, 10);
    head.translate(0, 1.09, 1.48);
    this.geometries.push(head);
    this.passenger.add(new THREE.Mesh(head, skin));

    const hat = new Shell();
    hat.add(cyl(0.185, 0.195, 0.025, 12, 0, 1.17, 1.48, 'y'));
    hat.add(cyl(0.115, 0.125, 0.09, 12, 0, 1.22, 1.48, 'y'));
    const hatGeo = hat.build();
    if (hatGeo) {
      this.geometries.push(hatGeo);
      this.passenger.add(new THREE.Mesh(hatGeo, dark));
    }

    const limbs = new Shell();
    /* arms reaching for the grab rails */
    limbs.addMirrored(tube(0.16, 0.9, 1.5, 0.42, 0.72, 1.36, 0.05, 6));
    /* legs into the footwell */
    limbs.addMirrored(tube(0.09, 0.56, 1.44, 0.11, 0.34, 1.12, 0.06, 6));
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
   * Big knobbly off-road tyres with real tread blocks and a six-spoke beadlock
   * rim. Two merged geometries shared by all four corners plus the spare.
   */
  private buildWheels(
    matRubber: THREE.Material,
    matChrome: THREE.Material,
    matMatte: THREE.Material,
  ): void {
    const R = SUSPENSION.wheelRadius;
    const W = SUSPENSION.wheelWidth;

    /* --- tyre carcass + tread --- */
    const tyre = new Shell();
    tyre.add(cyl(R - 0.035, R - 0.035, W, 20, 0, 0, 0, 'x'));
    /* shoulders */
    tyre.add(cyl(R - 0.09, R - 0.09, W + 0.03, 16, 0, 0, 0, 'x'));

    const blocks = 16;
    for (let i = 0; i < blocks; i++) {
      const a = (i / blocks) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      /* two staggered rows of chunky lugs */
      for (let row = 0; row < 2; row++) {
        const off = (row === 0 ? -1 : 1) * W * 0.22;
        const stagger = row === 0 ? 0 : Math.PI / blocks;
        const aa = a + stagger;
        const r = R - 0.012;
        const g = new THREE.BoxGeometry(W * 0.42, 0.075, 0.115);
        g.rotateX(-aa);
        g.translate(off, Math.sin(aa) * r, Math.cos(aa) * r);
        tyre.add(g);
        void ca;
        void sa;
      }
      /* sidewall knobs for silhouette */
      const s = new THREE.BoxGeometry(0.035, 0.05, 0.09);
      s.rotateX(-a);
      s.translate(W * 0.5, Math.sin(a) * (R - 0.09), Math.cos(a) * (R - 0.09));
      tyre.addMirrored(s);
    }

    const tyreGeo = tyre.build();

    /* --- rim: outer barrel, six spokes, beadlock ring, centre cap --- */
    const rim = new Shell();
    rim.add(cyl(0.3, 0.3, W * 0.62, 18, 0, 0, 0, 'x'));
    rim.add(cyl(0.315, 0.315, 0.035, 18, W * 0.34, 0, 0, 'x'));
    rim.add(cyl(0.1, 0.1, W * 0.7, 12, 0, 0, 0, 'x'));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const g = new THREE.BoxGeometry(W * 0.34, 0.23, 0.075);
      g.rotateX(-a);
      g.translate(0, Math.sin(a) * 0.19, Math.cos(a) * 0.19);
      rim.add(g);
      /* lug nuts on the beadlock ring */
      const lug = new THREE.CylinderGeometry(0.018, 0.018, 0.03, 6);
      lug.rotateZ(Math.PI / 2);
      lug.translate(W * 0.36, Math.sin(a + 0.5) * 0.27, Math.cos(a + 0.5) * 0.27);
      rim.add(lug);
    }
    const rimGeo = rim.build();

    /* --- hub cap --- */
    const capGeo = cyl(0.075, 0.06, 0.05, 10, W * 0.36, 0, 0, 'x');

    if (tyreGeo) this.geometries.push(tyreGeo);
    if (rimGeo) this.geometries.push(rimGeo);
    this.geometries.push(capGeo);

    for (let i = 0; i < 4; i++) {
      const l = WHEEL_LAYOUT[i];
      const root = new THREE.Group();
      root.position.set(l.x, SUSPENSION.anchorY - SUSPENSION.restLength * 0.6, l.z);

      const steer = new THREE.Group();
      const spin = new THREE.Group();

      if (tyreGeo) {
        const m = new THREE.Mesh(tyreGeo, matRubber);
        m.castShadow = true;
        spin.add(m);
      }
      if (rimGeo) {
        const m = new THREE.Mesh(rimGeo, matChrome);
        m.castShadow = true;
        spin.add(m);
      }
      const cap = new THREE.Mesh(capGeo, matMatte);
      cap.castShadow = false;
      /* mirror the cap to the outboard face on the left-hand wheels */
      cap.scale.x = l.left ? -1 : 1;
      spin.add(cap);

      steer.add(spin);
      root.add(steer);
      this.object3d.add(root);

      this.wheelRoots.push(root);
      this.wheelSteer.push(steer);
      this.wheelSpin.push(spin);
    }

    /* the spare, bolted flat to the tailgate */
    const spare = new THREE.Group();
    spare.position.set(-0.24, 0.34, MODEL.zSpare);
    spare.rotation.y = Math.PI / 2;
    spare.scale.setScalar(0.94);
    if (tyreGeo) spare.add(new THREE.Mesh(tyreGeo, matRubber));
    if (rimGeo) spare.add(new THREE.Mesh(rimGeo, matChrome));
    spare.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    this.chassis.add(spare);
  }
}

/* --------------------------------------------------------------- helpers */

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
