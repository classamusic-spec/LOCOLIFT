/**
 * Loco Lift — storm debris and spray.
 *
 * Two particle systems, one draw call each.
 *
 * **`DebrisField`** is the stuff the hurricane rips loose: palm fronds, sea
 * grape leaves, bin lids and torn signage, tumbling across the road. It is
 * entirely GPU-advected — the vertex shader wraps every card modulo a
 * camera-relative volume and integrates the wind analytically, so density is
 * constant no matter how fast the Jeep moves and the CPU does nothing per
 * frame but push six uniforms. Cards ride the *terrain*, not a flat plane: the
 * shader reads ground height out of the flood field's G channel, which is why
 * debris sweeping down a hillside street stays on the street.
 *
 * **`SprayPool`** is the shared white-water pool. Wave impacts, the run-up over
 * the seawall, the Jeep's own wake through standing water and the wind-torn
 * spray off the road all spawn into the same instanced billboard buffer, so the
 * whole storm's water-in-the-air costs exactly one draw call.
 */
import * as THREE from 'three';
import { clamp01, lerp } from '../core/MathUtils';
import type { RNG } from '../core/RNG';
import type { QualityTier } from '../core/types';
import type { WeatherDrive } from './Weather';

/* ------------------------------------------------------------------ tuning */

const DEBRIS_COUNT: Record<QualityTier, number> = {
  low: 0,
  medium: 120,
  high: 240,
  ultra: 340,
};

const SPRAY_COUNT: Record<QualityTier, number> = {
  low: 60,
  medium: 160,
  high: 300,
  ultra: 420,
};

/** Camera-relative volume the debris wraps inside, metres. */
const DEBRIS_VOLUME = new THREE.Vector3(96, 13, 96);

/* --------------------------------------------------------------- debris fx */

const DEBRIS_VERT = /* glsl */ `
attribute vec3 aSeed;
attribute vec4 aVar;
attribute vec3 aTint;

uniform float uTime;
uniform vec3  uVolume;
uniform vec2  uWind;
uniform float uAmount;
uniform float uGust;
uniform sampler2D uField;
uniform vec4  uFieldXf;
uniform float uFieldOn;
uniform float uMinY;
uniform float uYRange;
uniform float uFade;

varying vec2  vUvA;
varying vec3  vTint;
varying float vFade;

void main() {
  vec3 anchor = cameraPosition - vec3( uVolume.x * 0.5, 0.0, uVolume.z * 0.5 );

  // per-card drag: a frond rides the gust, a bin lid lags behind it
  float drag = 0.42 + aVar.y * 0.95;
  vec2 vel = uWind * drag;
  vec3 base = aSeed * uVolume;
  vec2 xz = base.xz + vel * uTime;
  xz = mod( xz - anchor.xz, uVolume.xz ) + anchor.xz;

  float ground = cameraPosition.y - 1.6;
  if ( uFieldOn > 0.5 ) {
    vec2 uvf = ( xz - uFieldXf.xy ) * uFieldXf.zw;
    ground = texture2D( uField, clamp( uvf, vec2( 0.0015 ), vec2( 0.9985 ) ) ).g * uYRange + uMinY;
  }

  // height above whatever it is skidding over, with a lift that grows with the
  // gust — the storm picks debris up, it does not just slide it along
  float lift = aSeed.y * uVolume.y * ( 0.28 + uGust * 0.85 );
  float bob = sin( uTime * ( 1.05 + aVar.z * 2.4 ) + aVar.w * 6.2831 ) * ( 0.42 + aVar.y * 1.5 );
  float y = ground + 0.22 + lift + bob * ( 0.35 + uGust * 0.8 );

  vec3 wp = vec3( xz.x, y, xz.y );

  /* --- tumble: a flat card spinning end over end --- */
  vec3 right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  vec3 up    = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
  float ang = uTime * ( 1.1 + aVar.z * 7.0 ) * ( 0.5 + uGust ) + aVar.w * 6.2831;
  float ca = cos( ang );
  float sa = sin( ang );
  vec3 r2 = right * ca + up * sa;
  vec3 u2 = -right * sa + up * ca;
  // foreshortening as the card turns edge-on is what sells it as flat
  float squash = 0.18 + 0.82 * abs( cos( ang * 0.61 + aVar.w * 3.1 ) );

  float size = aVar.y;
  vec3 world = wp + r2 * ( position.x * size * squash ) + u2 * ( position.y * size );

  /* --- atlas cell: aVar.x is 0..3 --- */
  float cell = floor( aVar.x + 0.5 );
  vec2 cellOff = vec2( mod( cell, 2.0 ), floor( cell * 0.5 ) );
  vUvA = ( uv + cellOff ) * 0.5;
  vTint = aTint;

  float dist = length( cameraPosition - world );
  vFade = uAmount * smoothstep( 1.2, 4.0, dist ) * ( 1.0 - smoothstep( uFade * 0.62, uFade, dist ) );

  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const DEBRIS_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLight;

varying vec2  vUvA;
varying vec3  vTint;
varying float vFade;

void main() {
  vec4 t = texture2D( uAtlas, vUvA );
  float a = t.a * vFade;
  if ( a < 0.02 ) discard;
  gl_FragColor = vec4( t.rgb * vTint * uLight, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface DebrisOptions {
  /** shared ground-height field (the flood field), or null for a flat fallback */
  field?: THREE.Texture | null;
  fieldTransform?: THREE.Vector4;
  fieldMinY?: number;
  fieldYRange?: number;
}

export class DebrisField {
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private rng: RNG;
  private opts: DebrisOptions;

  private mesh: THREE.Mesh | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private atlas: THREE.DataTexture | null = null;
  private count = 0;
  private disposed = false;

  constructor(quality: QualityTier, rng: RNG, opts: DebrisOptions = {}) {
    this.quality = quality;
    this.rng = rng;
    this.opts = opts;
    this.group.name = 'fx/debris';
  }

  build(): void {
    const count = DEBRIS_COUNT[this.quality];
    this.count = count;
    if (count === 0) return;

    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    quad.dispose();

    const seed = new Float32Array(count * 3);
    const varr = new Float32Array(count * 4);
    const tint = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      seed[i * 3] = this.rng.next();
      seed[i * 3 + 1] = Math.pow(this.rng.next(), 1.6);
      seed[i * 3 + 2] = this.rng.next();

      // 0 frond, 1 leaf, 2 bin lid, 3 signage — fronds and leaves dominate
      const roll = this.rng.next();
      const type = roll < 0.34 ? 0 : roll < 0.74 ? 1 : roll < 0.9 ? 2 : 3;
      const size =
        type === 0
          ? this.rng.range(0.75, 1.65)
          : type === 1
            ? this.rng.range(0.16, 0.34)
            : type === 2
              ? this.rng.range(0.4, 0.62)
              : this.rng.range(0.55, 1.05);
      varr[i * 4] = type;
      varr[i * 4 + 1] = size;
      varr[i * 4 + 2] = this.rng.next();
      varr[i * 4 + 3] = this.rng.next();

      if (type === 0) c.setHSL(0.24 + this.rng.range(-0.03, 0.05), 0.42, this.rng.range(0.3, 0.48));
      else if (type === 1) c.setHSL(0.18 + this.rng.range(-0.06, 0.08), 0.5, this.rng.range(0.26, 0.46));
      else if (type === 2) c.setHSL(this.rng.range(0.0, 0.7), 0.18, this.rng.range(0.34, 0.56));
      else c.setHSL(this.rng.range(0.0, 1.0), 0.55, this.rng.range(0.48, 0.66));
      c.convertSRGBToLinear();
      tint[i * 3] = c.r;
      tint[i * 3 + 1] = c.g;
      tint[i * 3 + 2] = c.b;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(varr, 4));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.atlas = makeDebrisAtlas();

    const mat = new THREE.ShaderMaterial({
      name: 'loco/debris',
      uniforms: {
        uTime: { value: 0 },
        uVolume: { value: DEBRIS_VOLUME.clone() },
        uWind: { value: new THREE.Vector2(9, 3) },
        uAmount: { value: 0 },
        uGust: { value: 0 },
        uAtlas: { value: this.atlas },
        uField: { value: this.opts.field ?? null },
        uFieldXf: { value: (this.opts.fieldTransform ?? new THREE.Vector4(0, 0, 1, 1)).clone() },
        uFieldOn: { value: this.opts.field ? 1 : 0 },
        uMinY: { value: this.opts.fieldMinY ?? 0 },
        uYRange: { value: this.opts.fieldYRange ?? 1 },
        uFade: { value: DEBRIS_VOLUME.x * 0.5 },
        uLight: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/debrisCards';
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    mesh.visible = false;
    this.group.add(mesh);

    this.geo = geo;
    this.mat = mat;
    this.mesh = mesh;
  }

  /**
   * Debris is a *storm* feature: a light shower does not tear the fronds off
   * the palms, and seeing it in plain rain would cheapen the hurricane.
   */
  update(drive: WeatherDrive): void {
    const mesh = this.mesh;
    const mat = this.mat;
    const geo = this.geo;
    if (!mesh || !mat || !geo) return;

    const amount = clamp01(drive.amount * drive.storm * 1.15 - 0.06);
    if (amount <= 0.004) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    const u = mat.uniforms;
    u.uTime.value = drive.time;
    (u.uWind.value as THREE.Vector2).set(
      drive.windDir.x * drive.windSpeed,
      drive.windDir.y * drive.windSpeed,
    );
    u.uAmount.value = amount;
    u.uGust.value = drive.gust;
    // debris is lit by the same overcast the road is; borrow the fog colour so
    // it never glows brighter than the scene it is blowing through
    (u.uLight.value as THREE.Color)
      .copy(drive.light.fogColor)
      .lerp(WHITE, 0.28)
      .multiplyScalar(lerp(0.55, 1.35, clamp01(drive.light.dayFactor)) + 0.35);

    geo.instanceCount = Math.max(1, Math.round(this.count * amount));
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
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

  stats(): Record<string, number> {
    return {
      debrisCards: this.geo ? this.geo.instanceCount : 0,
      debrisCapacity: this.count,
    };
  }

  private destroy(): void {
    if (this.mesh) this.group.remove(this.mesh);
    this.geo?.dispose();
    this.mat?.dispose();
    this.atlas?.dispose();
    this.geo = null;
    this.mat = null;
    this.mesh = null;
    this.atlas = null;
  }
}

/* ---------------------------------------------------------------- spray fx */

interface SprayParticle {
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
  bright: number;
  /** how strongly the wind drags this puff, 0..1 */
  drag: number;
}

/**
 * Shared white-water pool. Everything that throws water in the air spawns here.
 *
 * Particles are integrated on the CPU (a few hundred at most, and they need
 * real spawn positions from the wave and the vehicle, which the GPU has no way
 * to know), then written into one `InstancedMesh` as camera-facing billboards.
 */
export class SprayPool {
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private mesh: THREE.InstancedMesh | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  private tex: THREE.DataTexture | null = null;
  private parts: SprayParticle[] = [];
  private next = 0;
  private live = 0;

  private tmpM = new THREE.Matrix4();
  private tmpP = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private hidden = new THREE.Vector3(0, -9999, 0);
  private disposed = false;

  constructor(quality: QualityTier) {
    this.quality = quality;
    this.group.name = 'fx/spray';
  }

  build(): void {
    const count = SPRAY_COUNT[this.quality];
    this.tex = makeBlobTexture(48);
    this.mat = new THREE.MeshBasicMaterial({
      name: 'loco/spray',
      map: this.tex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, this.mat, count);
    mesh.name = 'fx/sprayPuffs';
    mesh.frustumCulled = false;
    mesh.renderOrder = 13;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.count = count;
    this.group.add(mesh);
    this.mesh = mesh;

    this.parts.length = 0;
    for (let i = 0; i < count; i++) {
      this.parts.push({
        x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0,
        t: 1, life: 1, size: 1, grow: 0, bright: 0, drag: 0.5,
      });
    }
    // start every slot dead
    for (let i = 0; i < count; i++) {
      this.tmpM.compose(this.hidden, this.tmpQ, ZERO_SCALE);
      mesh.setMatrixAt(i, this.tmpM);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  get capacity(): number {
    return this.parts.length;
  }

  get liveCount(): number {
    return this.live;
  }

  /** Throw one puff of water. Silently no-ops if the pool was never built. */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, life: number, bright: number, drag = 0.55,
  ): void {
    const n = this.parts.length;
    if (n === 0) return;
    const p = this.parts[this.next];
    this.next = (this.next + 1) % n;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.t = 0;
    p.life = life;
    p.size = size;
    p.grow = size * 1.9;
    p.bright = bright;
    p.drag = drag;
  }

  update(drive: WeatherDrive, dt: number, camera: THREE.Camera | null): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const colors = mesh.instanceColor;
    const wx = drive.windDir.x * drive.windSpeed;
    const wz = drive.windDir.y * drive.windSpeed;
    let live = 0;

    if (camera) camera.getWorldQuaternion(this.tmpQ);
    else this.tmpQ.identity();

    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (p.t >= p.life) {
        this.tmpM.compose(this.hidden, this.tmpQ, ZERO_SCALE);
        mesh.setMatrixAt(i, this.tmpM);
        continue;
      }
      p.t += dt;
      const k = clamp01(p.t / p.life);

      // gravity plus wind drag: spray does not fall straight down in a gale
      p.vy -= 13.5 * dt;
      p.vx += (wx * p.drag - p.vx) * Math.min(1, dt * 2.4);
      p.vz += (wz * p.drag - p.vz) * Math.min(1, dt * 2.4);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      const scale = lerp(p.size, p.grow, Math.sqrt(k));
      this.tmpP.set(p.x, p.y, p.z);
      this.tmpS.set(scale, scale, scale);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      mesh.setMatrixAt(i, this.tmpM);
      if (colors) {
        // fade in fast, out slow — a burst that lingers as mist
        const a = p.bright * Math.min(1, k * 7) * (1 - k) * (1 - k);
        colors.setXYZ(i, a, a * 1.01, a * 1.04);
      }
      live++;
    }

    this.live = live;
    mesh.visible = live > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
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

  stats(): Record<string, number> {
    return { sprayLive: this.live, sprayCapacity: this.parts.length };
  }

  private destroy(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    this.mat?.dispose();
    this.tex?.dispose();
    this.mesh = null;
    this.mat = null;
    this.tex = null;
    this.parts.length = 0;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);

/* --------------------------------------------------------------- textures */

/** Soft round puff, alpha only. */
function makeBlobTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      // a soft core with a wispy edge; squared falloff keeps it from looking
      // like a sticker
      const a = clamp01(1 - d);
      const v = Math.pow(a, 2.1) * (0.75 + 0.25 * Math.pow(a, 0.4));
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(clamp01(v) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/sprayBlob';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 2x2 debris atlas at 64 px a cell: palm frond, sea-grape leaf, bin lid, torn
 * signage. Pure array maths — no canvas, no assets, works head-less.
 */
function makeDebrisAtlas(): THREE.DataTexture {
  const CELL = 64;
  const S = CELL * 2;
  const data = new Uint8Array(S * S * 4);

  const put = (cx: number, cy: number, x: number, y: number, r: number, g: number, b: number, a: number): void => {
    if (x < 0 || y < 0 || x >= CELL || y >= CELL) return;
    const i = ((cy * CELL + y) * S + (cx * CELL + x)) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.max(data[i + 3], a);
  };

  /* --- cell 0: palm frond (a rachis with leaflets, gently curved) --- */
  for (let x = 0; x < CELL; x++) {
    const t = x / (CELL - 1);
    const spineY = 32 + Math.sin(t * 2.1) * 9 - t * 4;
    const half = Math.sin(Math.PI * Math.pow(t, 0.72)) * 24 * (1 - t * 0.25);
    for (let dy = -Math.ceil(half); dy <= Math.ceil(half); dy++) {
      const y = Math.round(spineY + dy);
      const f = Math.abs(dy) / Math.max(half, 1e-3);
      // leaflet gaps: the frond is a comb, not a paddle
      const comb = 0.5 + 0.5 * Math.sin(x * 1.55 + (dy > 0 ? 0 : 1.3));
      const alpha = f > 0.98 ? 0 : comb > 0.34 ? 255 : 0;
      if (alpha === 0) continue;
      const shade = Math.round(190 + 60 * (1 - f));
      put(0, 0, x, y, shade, 255, shade, 255);
    }
    for (let dy = -1; dy <= 1; dy++) put(0, 0, x, Math.round(spineY + dy), 235, 235, 200, 255);
  }

  /* --- cell 1: broad sea-grape leaf --- */
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u = (x - 32) / 27;
      const v = (y - 32) / 22;
      const r = u * u + v * v;
      if (r > 1) continue;
      // a notch at the stem end and a slight point at the tip
      const notch = u < -0.72 && Math.abs(v) < 0.34;
      if (notch) continue;
      const vein = Math.abs(v - u * 0.12) < 0.045 || Math.abs(Math.abs(v) - Math.abs(u) * 0.45) < 0.03;
      const shade = vein ? 170 : Math.round(215 + 40 * (1 - r));
      put(1, 0, x, y, shade, 255, Math.round(shade * 0.92), 255);
    }
  }

  /* --- cell 2: bin lid (disc with a rim and a handle boss) --- */
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const dx = (x - 32) / 29;
      const dy = (y - 32) / 29;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      const rim = d > 0.86 ? 150 : 255;
      const boss = d < 0.16 ? 190 : 255;
      const ring = Math.abs(d - 0.58) < 0.05 ? 205 : 255;
      const v = Math.min(rim, Math.min(boss, ring));
      put(0, 1, x, y, v, v, v, 255);
    }
  }

  /* --- cell 3: torn signage / cardboard --- */
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (y < 12 || y > 52) continue;
      const tear = 6 + Math.round(6 * Math.abs(Math.sin(y * 0.9)));
      if (x < tear || x > CELL - tear) continue;
      // a painted band and a couple of letter-ish blocks
      const band = y > 20 && y < 27 ? 120 : 255;
      const glyph = y > 32 && y < 44 && (x % 13 < 7) && x > 14 && x < 50 ? 90 : 255;
      const v = Math.min(band, glyph);
      put(1, 1, x, y, v, v, Math.round(v * 0.96), 255);
    }
  }

  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/debrisAtlas';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
