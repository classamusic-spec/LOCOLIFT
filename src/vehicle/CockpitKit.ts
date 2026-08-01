/**
 * Loco Lift — the shared parts bin for driver's-seat interiors.
 *
 * Every drivable vehicle builds its own cockpit, because a Jeep's exposed
 * scuttle, a school bus's flat steel dash and a carriage's splash board have
 * nothing in common structurally. What they *do* share is the small set of
 * things that are fiddly to get right and identical everywhere: a round
 * instrument face that reads at 0.5 m, a lit taxi meter, a needle that pivots,
 * and a pair of hands on the wheel.
 *
 * Everything here is procedural — Canvas2D for the faces, merged BufferGeometry
 * for the rest. No files, no downloads.
 *
 * **Lifetime contract**: every builder returns the materials, geometries and
 * textures it allocated. The caller owns them and must push them into its own
 * dispose lists; nothing here keeps a reference, so a cockpit that is built and
 * thrown away leaks nothing.
 *
 * **Visibility contract**: cockpit geometry is only ever parented under a group
 * that starts `visible = false`. Three skips an invisible subtree entirely —
 * no draw call, no triangle, no shadow-map cost — so a chase-cam frame pays
 * exactly nothing for any of this.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** What a builder hands back for the caller to own and eventually dispose. */
export interface CockpitParts {
  readonly materials: THREE.Material[];
  readonly geometries: THREE.BufferGeometry[];
  readonly textures: THREE.Texture[];
}

export function createParts(): CockpitParts {
  return { materials: [], geometries: [], textures: [] };
}

/** Absorb `src` into `dst` — for a cockpit assembled from several builders. */
export function absorb(dst: CockpitParts, src: CockpitParts): void {
  for (const m of src.materials) dst.materials.push(m);
  for (const g of src.geometries) dst.geometries.push(g);
  for (const t of src.textures) dst.textures.push(t);
}

/* --------------------------------------------------------------- textures */

/** Canvas2D is unavailable in some headless builds; every caller tolerates null. */
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

export interface GaugeFaceOptions {
  /** the big word under the spindle, e.g. `VELOCIDAD` */
  label: string;
  /** small unit caption, e.g. `MPH` */
  unit: string;
  /** numerals printed around the arc, low → high */
  numerals: readonly (string | number)[];
  /** 0..1 along the sweep where the red zone starts; >= 1 disables it */
  redlineAt?: number;
  /** face colour */
  face?: string;
  /** tick / numeral colour */
  ink?: string;
  /** accent used for the bezel ring and the label */
  accent?: string;
}

/**
 * A round instrument face.
 *
 * Drawn *without* a needle — the needle is a separate mesh so it can actually
 * move, which is the difference between an instrument and a sticker. The sweep
 * is the automotive standard 270° running from lower-left to lower-right, and
 * `needleAngle` below is its exact inverse so the two can never disagree.
 */
export function makeGaugeFace(opts: GaugeFaceOptions): THREE.CanvasTexture | null {
  const S = 256;
  const c = makeCanvas(S, S);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  const face = opts.face ?? '#12131a';
  const ink = opts.ink ?? '#f4efe2';
  const accent = opts.accent ?? '#f2b134';
  const cx = S / 2;
  const cy = S / 2;
  const rOuter = S * 0.47;

  /* bezel: a bright ring with a dark inner lip, so the dial reads as recessed */
  g.fillStyle = '#0a0b10';
  g.fillRect(0, 0, S, S);
  g.beginPath();
  g.arc(cx, cy, rOuter, 0, Math.PI * 2);
  g.fillStyle = '#8e97a6';
  g.fill();
  g.beginPath();
  g.arc(cx, cy, rOuter * 0.93, 0, Math.PI * 2);
  g.fillStyle = '#2a2d38';
  g.fill();

  const grad = g.createRadialGradient(cx, cy * 0.75, S * 0.05, cx, cy, rOuter);
  grad.addColorStop(0, lighten(face, 26));
  grad.addColorStop(1, face);
  g.beginPath();
  g.arc(cx, cy, rOuter * 0.88, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();

  const rTick = rOuter * 0.8;
  const sweep = SWEEP;

  /* red zone */
  const red = opts.redlineAt ?? 2;
  if (red < 1) {
    g.beginPath();
    g.lineWidth = S * 0.05;
    g.strokeStyle = '#e03a2f';
    /* canvas angles run clockwise from +X; the dial runs clockwise from up */
    g.arc(cx, cy, rTick, canvasAngle(red), canvasAngle(1));
    g.stroke();
  }

  /* ticks: a major every numeral, four minors between */
  const majors = Math.max(2, opts.numerals.length);
  const minors = (majors - 1) * 4;
  g.lineCap = 'butt';
  for (let i = 0; i <= minors; i++) {
    const t = i / minors;
    const a = -sweep / 2 + t * sweep;
    const sn = Math.sin(a);
    const cs = Math.cos(a);
    const major = i % 4 === 0;
    const r0 = major ? rTick - S * 0.085 : rTick - S * 0.045;
    g.beginPath();
    g.lineWidth = major ? S * 0.026 : S * 0.012;
    g.strokeStyle = major ? ink : 'rgba(244,239,226,0.6)';
    g.moveTo(cx + sn * r0, cy - cs * r0);
    g.lineTo(cx + sn * rTick, cy - cs * rTick);
    g.stroke();
  }

  /* numerals, inside the ticks */
  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(S * 0.115)}px "Trebuchet MS", system-ui, sans-serif`;
  const rNum = rTick - S * 0.155;
  for (let i = 0; i < majors; i++) {
    const t = majors === 1 ? 0 : i / (majors - 1);
    const a = -sweep / 2 + t * sweep;
    g.fillText(String(opts.numerals[i]), cx + Math.sin(a) * rNum, cy - Math.cos(a) * rNum);
  }

  /* label + unit */
  g.fillStyle = accent;
  g.font = `bold ${Math.round(S * 0.078)}px "Trebuchet MS", system-ui, sans-serif`;
  g.fillText(opts.label, cx, cy + S * 0.19);
  g.fillStyle = 'rgba(244,239,226,0.78)';
  g.font = `bold ${Math.round(S * 0.062)}px "Trebuchet MS", system-ui, sans-serif`;
  g.fillText(opts.unit, cx, cy + S * 0.3);

  /* the spindle boss the needle pivots on */
  g.beginPath();
  g.arc(cx, cy, S * 0.055, 0, Math.PI * 2);
  g.fillStyle = '#1a1c24';
  g.fill();

  return canvasTexture(c);
}

/** The dial sweep, radians. 270°, lower-left to lower-right. */
const SWEEP = (270 * Math.PI) / 180;

/** Canvas arc angle (clockwise from +X) for a 0..1 dial position. */
function canvasAngle(t: number): number {
  return -Math.PI / 2 + (-SWEEP / 2 + t * SWEEP);
}

/**
 * Needle rotation for a 0..1 dial position, radians about the face's +Z.
 *
 * The needle geometry points along +Y at rest, so 0 has to swing it back to
 * the lower-left: a *positive* rotation about +Z is counter-clockwise on a
 * face we are looking at down its own +Z, which is the left half of the dial.
 */
export function needleAngle(t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return SWEEP / 2 - k * SWEEP;
}

/**
 * A live taxi meter.
 *
 * Owns its own canvas and repaints only when the displayed string changes,
 * which at a plausible tariff is about once a second — cheap enough to be
 * worth it, and a fare that ticks up as you drive is the single detail that
 * makes the interior feel like a working taxi rather than a car.
 */
export class MeterDisplay {
  readonly texture: THREE.CanvasTexture | null;

  private readonly canvas: HTMLCanvasElement | null;
  private lastFare = '';
  private lastOccupied: boolean | null = null;

  constructor() {
    this.canvas = makeCanvas(256, 160);
    this.texture = this.canvas ? canvasTexture(this.canvas) : null;
    this.set(0, false);
  }

  /** `fare` in dollars. No-op when nothing visible would change. */
  set(fare: number, occupied: boolean): void {
    const text = (Number.isFinite(fare) ? Math.max(0, Math.min(999, fare)) : 0).toFixed(2);
    if (text === this.lastFare && occupied === this.lastOccupied) return;
    this.lastFare = text;
    this.lastOccupied = occupied;
    const g = this.canvas?.getContext('2d');
    if (!g || !this.canvas) return;
    paintMeter(g, this.canvas.width, this.canvas.height, text, occupied);
    if (this.texture) this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
  }
}

/**
 * A taxi meter face: bilingual header, an amber dot-matrix fare, and the
 * little "OCUPADO / LIBRE" flag every San Juan meter has.
 */
export function makeMeterFace(fare: string, occupied: boolean): THREE.CanvasTexture | null {
  const W = 256;
  const H = 160;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;
  paintMeter(g, W, H, fare, occupied);
  return canvasTexture(c);
}

function paintMeter(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  fare: string,
  occupied: boolean,
): void {
  g.fillStyle = '#0b0d12';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#4a4f5e';
  g.lineWidth = 5;
  g.strokeRect(3, 3, W - 6, H - 6);

  g.fillStyle = '#07120c';
  g.fillRect(14, 44, W - 28, 66);

  /* the fare, in the amber every LED meter in the world uses */
  g.fillStyle = '#ffb020';
  g.font = 'bold 46px "Courier New", monospace';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillText(fare, W - 24, 78);
  g.font = 'bold 24px "Courier New", monospace';
  g.textAlign = 'left';
  g.fillText('$', 24, 80);

  g.fillStyle = '#cbd3e0';
  g.font = 'bold 17px "Trebuchet MS", system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('TAXÍMETRO', W / 2, 26);

  g.fillStyle = occupied ? '#ff3b46' : '#38d67a';
  g.fillRect(16, 122, 78, 24);
  g.fillStyle = '#08090d';
  g.font = 'bold 15px "Trebuchet MS", system-ui, sans-serif';
  g.fillText(occupied ? 'OCUPADO' : 'LIBRE', 55, 135);

  g.fillStyle = '#7f8798';
  g.textAlign = 'right';
  g.fillText('VIEJO SAN JUAN', W - 18, 135);
}

/** A labelled rocker-switch strip — the filler that sells a real dashboard. */
export function makeSwitchStrip(labels: readonly string[], tint: string): THREE.CanvasTexture | null {
  const W = 512;
  const H = 96;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;

  g.fillStyle = '#191b22';
  g.fillRect(0, 0, W, H);

  const n = Math.max(1, labels.length);
  const cw = W / n;
  for (let i = 0; i < n; i++) {
    const x = i * cw;
    g.fillStyle = i % 2 === 0 ? '#23262f' : '#1d2028';
    g.fillRect(x + 4, 8, cw - 8, H - 16);
    /* the lit half of the rocker */
    g.fillStyle = i % 3 === 0 ? tint : '#3a3f4c';
    g.fillRect(x + 10, 14, cw - 20, 26);
    g.fillStyle = '#0d0f14';
    g.fillRect(x + 10, 44, cw - 20, 22);
    g.fillStyle = '#cfd6e2';
    g.font = 'bold 15px "Trebuchet MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(labels[i], x + cw / 2, H - 14);
  }

  return canvasTexture(c);
}

/* --------------------------------------------------------------- geometry */

/**
 * A gauge: bezel cup, printed face, and a needle node the caller rotates.
 *
 * The returned `needle` group is already positioned and oriented — set its
 * `rotation.z` to `needleAngle(value)` and nothing else.
 */
export function buildGauge(
  radius: number,
  faceTex: THREE.CanvasTexture | null,
  needleColor: number,
  parts: CockpitParts,
): { group: THREE.Group; needle: THREE.Group } {
  const group = new THREE.Group();

  const faceMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: faceTex ?? null,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: faceTex ?? null,
    /* instruments are backlit; without this they are unreadable at night and
     * muddy in daylight, because a dashboard is always in its own shadow */
    emissiveIntensity: 0.42,
    metalness: 0.15,
    roughness: 0.55,
  });
  if (!faceTex) faceMat.color.setHex(0x1a1c24);
  parts.materials.push(faceMat);

  const disc = new THREE.CircleGeometry(radius, 24);
  parts.geometries.push(disc);
  const faceMesh = new THREE.Mesh(disc, faceMat);
  faceMesh.castShadow = false;
  group.add(faceMesh);

  /* the cup behind it, so the gauge is not a floating coin */
  const cupMat = new THREE.MeshStandardMaterial({
    color: 0x14161d,
    metalness: 0.4,
    roughness: 0.55,
  });
  parts.materials.push(cupMat);
  const cup = new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, radius * 0.5, 20, 1, true);
  cup.rotateX(Math.PI / 2);
  cup.translate(0, 0, -radius * 0.26);
  parts.geometries.push(cup);
  const cupMesh = new THREE.Mesh(cup, cupMat);
  cupMesh.castShadow = false;
  group.add(cupMesh);

  /* needle: a tapered blade with a counterweight, pivoting on the boss */
  const needle = new THREE.Group();
  needle.position.z = radius * 0.055;
  const needleMat = new THREE.MeshStandardMaterial({
    color: needleColor,
    emissive: new THREE.Color(needleColor),
    emissiveIntensity: 0.7,
    metalness: 0.1,
    roughness: 0.4,
  });
  parts.materials.push(needleMat);

  const blade = new THREE.CylinderGeometry(radius * 0.018, radius * 0.055, radius * 0.78, 4);
  blade.translate(0, radius * 0.36, 0);
  const tail = new THREE.CylinderGeometry(radius * 0.05, radius * 0.05, radius * 0.2, 6);
  tail.translate(0, -radius * 0.12, 0);
  const hub = new THREE.CylinderGeometry(radius * 0.1, radius * 0.1, radius * 0.06, 10);
  hub.rotateX(Math.PI / 2);
  const merged = mergeGeometries([blade, tail, hub], false);
  blade.dispose();
  tail.dispose();
  hub.dispose();
  if (merged) {
    parts.geometries.push(merged);
    const m = new THREE.Mesh(merged, needleMat);
    m.castShadow = false;
    needle.add(m);
  }
  group.add(needle);

  return { group, needle };
}

/**
 * A pair of hands on a steering wheel rim, as one merged geometry.
 *
 * Built at the rim's twelve o'clock and mirrored, then rotated to nine and
 * three by the caller's group — the classic driving position, and the only one
 * that stays readable when the wheel is at full lock.
 *
 * The forearms run back and down toward where the player's shoulders would be.
 * They matter more than the hands do: a pair of disembodied fists on a rim
 * reads as a bug, and the two tapers are what turn them into a person.
 */
export function buildHands(
  rimRadius: number,
  tubeRadius: number,
  parts: CockpitParts,
  skin = 0xb27a52,
  sleeve = 0xf1ece0,
  forearm = 0.34,
): THREE.Group {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, metalness: 0, roughness: 0.82 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: sleeve, metalness: 0, roughness: 0.75 });
  parts.materials.push(skinMat, sleeveMat);

  const hands: THREE.BufferGeometry[] = [];
  const sleeves: THREE.BufferGeometry[] = [];

  /* one hand, authored at three o'clock (+X), then mirrored to nine */
  const build = (sign: number): void => {
    const hx = sign * rimRadius;
    const grip: THREE.BufferGeometry[] = [];

    /* the palm wraps the rim: a short arc of tube, fat side outward */
    const palm = new THREE.TorusGeometry(rimRadius, tubeRadius * 2.05, 6, 8, 0.62);
    palm.rotateZ(sign > 0 ? -0.31 : Math.PI - 0.31);
    grip.push(palm);

    /* Four fingers curling over the FAR face of the rim (−Z), because that is
     * how a hand grips one: the back of the hand faces the driver, the
     * fingertips are hidden behind the rim, and the thumb comes back over the
     * near side. Reversing the two is the single most common way procedural
     * hands end up looking like they are pushing the wheel away. */
    for (let i = 0; i < 4; i++) {
      const a = (sign > 0 ? -0.22 : Math.PI + 0.22) + (i - 1.5) * 0.115 * (sign > 0 ? 1 : -1);
      const f = new THREE.CapsuleGeometry(tubeRadius * 0.78, tubeRadius * 2.3, 3, 6);
      f.rotateX(Math.PI / 2);
      f.translate(Math.cos(a) * rimRadius, Math.sin(a) * rimRadius, -tubeRadius * 1.05);
      grip.push(f);
    }
    /* the thumb, hooked back over the near side of the rim */
    const thumb = new THREE.CapsuleGeometry(tubeRadius * 0.85, tubeRadius * 2.6, 3, 6);
    thumb.rotateZ(sign > 0 ? 0.5 : -0.5);
    thumb.translate(hx - sign * tubeRadius * 1.4, tubeRadius * 1.5, tubeRadius * 0.8);
    grip.push(thumb);

    const handGeo = mergeGeometries(grip, false);
    for (const p of grip) p.dispose();
    if (handGeo) hands.push(handGeo);

    /* Wrist + forearm.
     *
     * The direction is the fiddly part and it is worth spelling out. The arm
     * has to head for the driver's shoulders, which are *below and behind* the
     * eye — but this geometry lives in the steering wheel's frame, and the
     * wheel is raked back by 60–75° in all three vehicles. Under that rake the
     * wheel's own −Y maps to world "down and back", and its +Z maps to "up and
     * back", i.e. straight into the camera. An arm extended along +Z therefore
     * ends up floating in front of the driver's face with a visible cut end.
     * Sending it along −Y instead puts it where an arm goes and lets it leave
     * the frame through the bottom edge, which is what makes it read as
     * belonging to a body rather than to nothing.
     *
     * `forearm` is an absolute length in metres for the same reason: a real
     * forearm is ~0.34 m whether it is holding a Jeep's 0.30 m wheel or a
     * bus's 0.50 m one, and scaling it with the rim gave the bus driver arms
     * like a gibbon. */
    const wristX = hx + sign * tubeRadius * 0.4;
    const arm = taperTube(
      wristX,
      -tubeRadius * 0.4,
      tubeRadius * 1.2,
      hx * 0.95,
      -forearm,
      rimRadius * 0.55,
      tubeRadius * 1.55,
      tubeRadius * 2.15,
      7,
    );
    sleeves.push(arm);
  };

  build(1);
  build(-1);

  const handGeo = mergeGeometries(hands, false);
  for (const h of hands) h.dispose();
  if (handGeo) {
    parts.geometries.push(handGeo);
    const m = new THREE.Mesh(handGeo, skinMat);
    m.castShadow = false;
    group.add(m);
  }
  const sleeveGeo = mergeGeometries(sleeves, false);
  for (const s of sleeves) s.dispose();
  if (sleeveGeo) {
    parts.geometries.push(sleeveGeo);
    const m = new THREE.Mesh(sleeveGeo, sleeveMat);
    m.castShadow = false;
    group.add(m);
  }

  return group;
}

const TUBE_UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const tubeA = /* @__PURE__ */ new THREE.Vector3();
const tubeB = /* @__PURE__ */ new THREE.Vector3();
const tubeDir = /* @__PURE__ */ new THREE.Vector3();
const tubeQ = /* @__PURE__ */ new THREE.Quaternion();
const tubeM = /* @__PURE__ */ new THREE.Matrix4();
const tubeScale = /* @__PURE__ */ new THREE.Vector3(1, 1, 1);

/** A tapered tube from a to b — limbs, grab rails, rein rails. */
export function taperTube(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  rA: number,
  rB: number,
  seg = 6,
): THREE.BufferGeometry {
  tubeA.set(ax, ay, az);
  tubeB.set(bx, by, bz);
  tubeDir.subVectors(tubeB, tubeA);
  const len = tubeDir.length();
  const g = new THREE.CylinderGeometry(rB, rA, Math.max(1e-3, len), seg, 1, false);
  if (len > 1e-5) {
    tubeDir.multiplyScalar(1 / len);
    tubeQ.setFromUnitVectors(TUBE_UP, tubeDir);
    tubeA.add(tubeB).multiplyScalar(0.5);
    tubeM.compose(tubeA, tubeQ, tubeScale);
    g.applyMatrix4(tubeM);
  }
  return g;
}

/* ------------------------------------------------------------------ reins */

/**
 * Leather reins: flat ribbons whose spines are re-solved every frame.
 *
 * Each span has two fixed ends — the driver's hand and the horse's bit ring —
 * with a sag between them, rewritten in place into a preallocated position
 * attribute. All the spans share one geometry, so the whole harness is one
 * draw call and zero allocations per frame.
 *
 * This is not decoration. The carriage's entire front assembly yaws on its
 * turntable with the steering, which swings the horse's head more than a metre
 * out to the side of the body; a rein baked into a static mesh visibly tears
 * away from either the hand or the bit the moment you turn. Solving it every
 * frame is the only way the connection stays honest, and from the driver's
 * seat the reins are the single most important thing in frame.
 */
export class ReinRibbon {
  readonly mesh: THREE.Mesh;

  private readonly geo: THREE.BufferGeometry;
  private readonly pos: THREE.BufferAttribute;
  private readonly segments: number;
  private readonly halfWidth: number;
  private readonly spans: number;

  /** scratch, so `update` never allocates */
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  constructor(material: THREE.Material, spans = 1, segments = 10, halfWidth = 0.012) {
    this.spans = Math.max(1, spans);
    this.segments = Math.max(2, segments);
    this.halfWidth = halfWidth;

    const perSpan = this.segments + 1;
    const verts = new Float32Array(this.spans * perSpan * 2 * 3);
    const index: number[] = [];
    for (let s = 0; s < this.spans; s++) {
      const base = s * perSpan * 2;
      for (let i = 0; i < this.segments; i++) {
        const a = base + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(verts, 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.pos);
    this.geo.setIndex(index);
    /* Normals are computed once, from the degenerate rest pose, and never
     * again: a strap is a flat unlit-ish ribbon and recomputing a normal
     * buffer 60 times a second to shade 0.02 m of leather would cost more than
     * every other thing in this file put together. The material is
     * double-sided so the ribbon reads from either end. */
    this.geo.computeVertexNormals();
    /* Hand-set, because the spans move every frame and Three would otherwise
     * have to recompute the bounds from the attribute on every change. */
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -1), 8);

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = 'reins';
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
  }

  /**
   * Re-solve span `span` between two points.
   *
   * `sag` is metres of droop at the midpoint — a rein is never taut, and the
   * curve is what makes it read as leather rather than as wire.
   */
  update(
    span: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    sag: number,
  ): void {
    if (span < 0 || span >= this.spans) return;
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz);
    /* the ribbon's width axis: horizontal and perpendicular to the run, so the
     * flat of the strap always faces roughly upward */
    this.side.set(bz - az, 0, ax - bx);
    const l = this.side.length();
    if (l > 1e-5) this.side.multiplyScalar(this.halfWidth / l);
    else this.side.set(this.halfWidth, 0, 0);

    const arr = this.pos.array as Float32Array;
    const base = span * (this.segments + 1) * 6;
    for (let i = 0; i <= this.segments; i++) {
      const t = i / this.segments;
      this.p.lerpVectors(this.a, this.b, t);
      this.p.y -= sag * 4 * t * (1 - t);
      const o = base + i * 6;
      arr[o] = this.p.x - this.side.x;
      arr[o + 1] = this.p.y - this.side.y;
      arr[o + 2] = this.p.z - this.side.z;
      arr[o + 3] = this.p.x + this.side.x;
      arr[o + 4] = this.p.y + this.side.y;
      arr[o + 5] = this.p.z + this.side.z;
    }
    this.pos.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

/* ------------------------------------------------------------------ utils */

/** Lighten a `#rrggbb` string by `amount` per channel. Canvas gradients only. */
function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((v >> 16) & 255) + amount);
  const g = Math.min(255, ((v >> 8) & 255) + amount);
  const b = Math.min(255, (v & 255) + amount);
  return `rgb(${r},${g},${b})`;
}
