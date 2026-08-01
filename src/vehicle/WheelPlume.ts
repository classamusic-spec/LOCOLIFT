/**
 * Loco Lift — the stuff the tyres throw up.
 *
 * Off-road used to be invisible. `Coast` had always classified the district
 * into cobble, asphalt, grass and sand, but nothing read it, so the beach and
 * the plaza looked identical from the driver's seat and *felt* identical too.
 * With the grip model wired in, the beach finally drives differently; this is
 * what makes it *look* different.
 *
 * One `InstancedMesh` of camera-facing billboards, one draw call, one soft
 * blob texture generated from an array — no assets, no atlas, no network. Puffs
 * are spawned by the vehicle at the contact patch whenever a wheel is on a
 * loose surface and either sliding or simply moving fast, tinted by the surface
 * it came off: pale ochre for sand, a dusty green for grass, grey grit for
 * stone. They drift, sink, spread and fade.
 *
 * Cost at `high`: 160 quads, 320 triangles, one transparent draw call — about
 * 0.02 % of the triangle budget.
 */
import * as THREE from 'three';
import { clamp01, lerp } from '../core/MathUtils';
import type { QualityTier } from '../core/types';

/**
 * Puffs alive at once, per tier. Even `low` keeps some: this is the only thing
 * that tells the player the beach is not the plaza, and it is one draw call.
 */
const PLUME_COUNT: Record<QualityTier, number> = {
  low: 48,
  medium: 90,
  high: 160,
  ultra: 240,
};

interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  t: number;
  life: number;
  size: number;
  grow: number;
  r: number;
  g: number;
  b: number;
  bright: number;
}

const GRAVITY = -3.2;
/** how fast a puff sheds the velocity it was thrown with, 1/s */
const DRAG = 2.6;

export class WheelPlume {
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private mesh: THREE.InstancedMesh | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  private tex: THREE.DataTexture | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private puffs: Puff[] = [];
  private next = 0;
  private live = 0;
  private disposed = false;

  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly col = new THREE.Color();

  constructor(quality: QualityTier) {
    this.quality = quality;
    this.group.name = 'vehicle/plume';
    this.build();
  }

  private build(): void {
    const count = PLUME_COUNT[this.quality];
    if (count === 0) return;

    this.tex = blobTexture(40);
    this.mat = new THREE.MeshBasicMaterial({
      name: 'loco/wheelPlume',
      map: this.tex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.geo = new THREE.PlaneGeometry(1, 1, 1, 1);

    const mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    mesh.name = 'vehicle/plumePuffs';
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.count = count;
    this.group.add(mesh);
    this.mesh = mesh;

    for (let i = 0; i < count; i++) {
      this.puffs.push({
        x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0,
        t: 1, life: 1, size: 0.3, grow: 1, r: 1, g: 1, b: 1, bright: 0,
      });
      this.m.compose(HIDDEN, IDENTITY, ZERO);
      mesh.setMatrixAt(i, this.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  get liveCount(): number {
    return this.live;
  }

  get capacity(): number {
    return this.puffs.length;
  }

  /**
   * Throw one puff off a contact patch. `tint` is the surface colour, `power`
   * 0..1 how hard the wheel is working it.
   */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vz: number,
    tint: number,
    power: number,
  ): void {
    const n = this.puffs.length;
    if (n === 0) return;
    const p = this.puffs[this.next];
    this.next = (this.next + 1) % n;
    this.col.setHex(tint, THREE.SRGBColorSpace);
    const spread = 0.9 + power * 1.6;
    p.x = x + (Math.random() - 0.5) * 0.34;
    p.y = y + 0.06 + Math.random() * 0.12;
    p.z = z + (Math.random() - 0.5) * 0.34;
    p.vx = vx + (Math.random() - 0.5) * spread;
    p.vy = 0.6 + Math.random() * (0.8 + power * 2.2);
    p.vz = vz + (Math.random() - 0.5) * spread;
    p.t = 0;
    p.life = 0.42 + Math.random() * (0.45 + power * 0.6);
    p.size = 0.22 + Math.random() * 0.3 + power * 0.35;
    p.grow = p.size * (2.4 + power * 1.6);
    const shade = 0.82 + Math.random() * 0.36;
    p.r = this.col.r * shade;
    p.g = this.col.g * shade;
    p.b = this.col.b * shade;
    p.bright = 0.32 + power * 0.5;
  }

  update(dt: number, camera: THREE.Camera | null): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const colors = mesh.instanceColor;
    if (camera) camera.getWorldQuaternion(this.q);
    else this.q.identity();

    let live = 0;
    for (let i = 0; i < this.puffs.length; i++) {
      const p = this.puffs[i];
      if (p.t >= p.life) {
        this.m.compose(HIDDEN, this.q, ZERO);
        mesh.setMatrixAt(i, this.m);
        continue;
      }
      p.t += dt;
      const decay = Math.exp(-DRAG * dt);
      p.vx *= decay;
      p.vz *= decay;
      p.vy = p.vy * decay + GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      const k = clamp01(p.t / p.life);
      const scale = lerp(p.size, p.grow, Math.sqrt(k));
      this.p.set(p.x, p.y, p.z);
      this.s.set(scale, scale, scale);
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(i, this.m);
      if (colors) {
        // in fast, out slow — a kicked-up cloud that hangs behind the car
        const a = p.bright * Math.min(1, k * 6) * (1 - k) * (1 - k);
        colors.setXYZ(i, p.r * a, p.g * a, p.b * a);
      }
      live++;
    }

    this.live = live;
    mesh.visible = live > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality || this.disposed) return;
    this.quality = tier;
    this.destroy();
    this.build();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroy();
    this.group.removeFromParent();
    this.group.clear();
  }

  private destroy(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
    }
    this.geo?.dispose();
    this.mat?.dispose();
    this.tex?.dispose();
    this.mesh = null;
    this.geo = null;
    this.mat = null;
    this.tex = null;
    this.puffs.length = 0;
    this.next = 0;
    this.live = 0;
  }
}

const HIDDEN = /* @__PURE__ */ new THREE.Vector3(0, -9999, 0);
const IDENTITY = /* @__PURE__ */ new THREE.Quaternion();
const ZERO = /* @__PURE__ */ new THREE.Vector3(0, 0, 0);

/** Soft round puff with a wispy edge. Alpha only; the tint is per-instance. */
function blobTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = clamp01(1 - d);
      // a soft core with a torn edge, so it never reads as a sticker
      const wobble = 0.86 + 0.14 * Math.sin(Math.atan2(dy, dx) * 5.0);
      const v = Math.pow(clamp01(a * wobble), 1.7);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(v * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/plumeBlob';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
