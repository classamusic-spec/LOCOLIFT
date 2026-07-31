/**
 * Loco Lift — weather.
 *
 * Rain, storm, lightning, splashes, distant veils, and the wet-surface drive.
 * Registered with the world as a `WorldLayer`, but it also takes the game
 * context so it can read `settings.photosensitiveSafe` and emit on the bus.
 *
 * Design notes:
 *
 * - **Rain is one draw call.** An `InstancedBufferGeometry` of quads, wrapped
 *   modulo a camera-relative volume in the vertex shader, so density is
 *   constant no matter how fast the Jeep moves and no CPU work happens per
 *   drop. Streaks are oriented along the fall vector (gravity + trade wind) and
 *   rolled to face the camera, which is what makes rain read as *falling*
 *   rather than as static noise.
 *
 * - **Wetness follows §5.1.** `MaterialLibrary` exposes a single `wetness`
 *   uniform, so the reference's two-rate model (sheen dries over 75 s, puddles
 *   over 150 s) is folded into one drive: `max(sheen, puddle × 0.42)`. The road
 *   therefore keeps a damp floor for about 150 s after the rain stops, which is
 *   the visible half of "puddles outlive the sheen".
 *
 * - **Lightning actually lights the scene.** The flash is a real directional
 *   light plus an ambient punch inside `Lighting`, not a screen overlay, so
 *   walls and the road catch it and cast shadows for the 80 ms it lasts. It is
 *   suppressed completely when `settings.photosensitiveSafe` is on.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { GameContext, QualityTier } from '../core/types';
import type { MaterialLibrary } from '../world/Materials';
import type { CityLayout, WorldLayer, WorldOpts } from '../world/WorldTypes';
import type { Lighting } from './Lighting';
import { POST_STATE, type SkyWeather } from './LightingPresets';

/* ------------------------------------------------------------------ glsl */

const RAIN_VERT = /* glsl */ `
attribute vec3 aSeed;
attribute vec2 aVar;

uniform float uTime;
uniform vec3  uVolume;
uniform float uFall;
uniform vec2  uWind;
uniform float uLength;
uniform float uWidth;

varying vec2  vUv;
varying float vFade;

void main() {
  vec3 vel = vec3( uWind.x, -uFall, uWind.y );
  vec3 anchor = cameraPosition - vec3( uVolume.x * 0.5, uVolume.y * 0.34, uVolume.z * 0.5 );

  // per-drop speed variance keeps the curtain from looking like a solid sheet
  float speed = 0.82 + aVar.x * 0.36;
  vec3 base = aSeed * uVolume;
  vec3 wp = base + vel * ( uTime * speed );
  wp = mod( wp - anchor, uVolume ) + anchor;

  vec3 dir = normalize( vel );
  vec3 toCam = cameraPosition - wp;
  float dist = length( toCam );
  vec3 side = cross( dir, toCam / max( dist, 1e-3 ) );
  float sl = length( side );
  side = sl > 1e-4 ? side / sl : vec3( 1.0, 0.0, 0.0 );

  float len = uLength * ( 0.6 + aVar.x * 0.8 );
  vec3 world = wp + side * ( position.x * uWidth ) + dir * ( position.y * len );

  vUv = uv;
  // fade in from the camera (a drop 30 cm from the lens is a smear) and out at
  // the far wall of the volume so drops never pop
  vFade = smoothstep( 0.35, 2.6, dist ) * ( 1.0 - smoothstep( uVolume.x * 0.34, uVolume.x * 0.52, dist ) );
  vFade *= 0.55 + aVar.y * 0.65;

  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const RAIN_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uOpacity;

varying vec2  vUv;
varying float vFade;

void main() {
  float across = 1.0 - abs( vUv.x - 0.5 ) * 2.0;
  float along = smoothstep( 0.0, 0.22, vUv.y ) * smoothstep( 1.0, 0.72, vUv.y );
  float a = across * across * along * vFade * uOpacity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* --------------------------------------------------------------- helpers */

/** 64x64 vertical-streak noise for the distant rain veils. */
function makeVeilTexture(): THREE.DataTexture {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  const rng = new RNG(0x5a1f);
  const cols = new Float32Array(S);
  for (let x = 0; x < S; x++) cols[x] = rng.next();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const c0 = cols[x];
      const c1 = cols[(x + 1) % S];
      const streak = c0 * 0.75 + c1 * 0.25;
      const wobble = 0.5 + 0.5 * Math.sin((y / S) * Math.PI * 4 + c0 * 12.0);
      const v = clamp01(streak * 0.7 + wobble * 0.3);
      const a = Math.pow(v, 3.1) * 255;
      const i = (y * S + x) * 4;
      data[i] = 235;
      data[i + 1] = 242;
      data[i + 2] = 248;
      data[i + 3] = a;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface Splash {
  x: number;
  y: number;
  z: number;
  t: number;
  life: number;
}

const RAIN_COUNT: Record<QualityTier, number> = { low: 380, medium: 900, high: 1700, ultra: 2600 };
const SPLASH_COUNT: Record<QualityTier, number> = { low: 0, medium: 40, high: 80, ultra: 120 };
const VEIL_COUNT: Record<QualityTier, number> = { low: 0, medium: 2, high: 3, ultra: 4 };

export interface WeatherOpts {
  materials: MaterialLibrary;
  lighting: Lighting;
  quality: QualityTier;
  rng: RNG;
}

/* ---------------------------------------------------------------- system */

export class Weather implements WorldLayer {
  readonly name = 'weather';
  readonly group = new THREE.Group();

  /** fires the `thunder` SFX event; turn off if the ambience bed owns thunder */
  emitThunderSfx = true;

  private materials: MaterialLibrary;
  private lighting: Lighting;
  private quality: QualityTier;
  private rng: RNG;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  private groundHeight: (x: number, z: number) => number = () => 0;

  private _kind: SkyWeather = 'clear';
  /** 0..1 crossfade so a shower rolls in instead of snapping */
  private amount = 0;
  private targetAmount = 0;

  /* wet model (§5.1) */
  private sheen = 0;
  private puddle = 0;

  /* rain */
  private rainMesh: THREE.Mesh | null = null;
  private rainGeo: THREE.InstancedBufferGeometry | null = null;
  private rainMat: THREE.ShaderMaterial | null = null;
  private rainCount = 0;
  private time = 0;

  /* splashes */
  private splashMesh: THREE.InstancedMesh | null = null;
  private splashes: Splash[] = [];
  private splashMat: THREE.MeshBasicMaterial | null = null;

  /* veils */
  private veils: THREE.Mesh[] = [];
  private veilTex: THREE.DataTexture | null = null;
  private veilMat: THREE.MeshBasicMaterial | null = null;

  /* storm */
  private strikeTimer = 14;
  private secondStrike = -1;
  private thunderQueue: Array<{ t: number; volume: number; pitch: number }> = [];

  /* scratch */
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private tmpC = new THREE.Color();
  private wind = new THREE.Vector2(4.2, 1.4);

  private disposed = false;

  constructor(opts: WeatherOpts) {
    this.materials = opts.materials;
    this.lighting = opts.lighting;
    this.quality = opts.quality;
    this.rng = opts.rng.fork(0x5a1f);
    this.group.name = 'fx/weather';
    this.group.renderOrder = 10;
  }

  /* ---------------------------------------------------------- WorldLayer */

  build(layout: CityLayout, _opts: WorldOpts): void {
    this.groundHeight = (x, z) => layout.groundHeight(x, z);
    this.buildRain();
    this.buildSplashes();
    this.buildVeils();
    this.applyVisibility();
  }

  /**
   * Hand the layer the game context. `World.init` calls this; the context
   * object is stable across the session (the engine mutates it in place), so
   * holding the reference is safe and keeps `update` allocation-free.
   */
  attach(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('weather:changed', (e) => {
        if (e.kind !== this._kind) this.setKind(e.kind as SkyWeather, false);
      }),
    );
  }

  /** WorldLayer entry point — `World` forwards it every frame. */
  update(cameraPos: THREE.Vector3, dt: number, _timeOfDay: number): void {
    if (this.disposed) return;
    const step = Math.min(dt, 0.1);
    this.time = (this.time + step) % 3600;

    /* --- crossfade the weather in and out --- */
    const rate = this.targetAmount > this.amount ? 0.42 : 0.28;
    if (this.amount !== this.targetAmount) {
      const d = this.targetAmount - this.amount;
      const move = Math.min(Math.abs(d), rate * step);
      this.amount += Math.sign(d) * move;
      this.lighting.setWeather(this._kind, this.amount);
      this.applyVisibility();
    }

    this.updateWetness(step);
    this.updateRain(cameraPos, step);
    this.updateSplashes(cameraPos, step);
    this.updateVeils(cameraPos);
    this.updateStorm(step);
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.destroyVisuals();
    this.buildRain();
    this.buildSplashes();
    this.buildVeils();
    this.applyVisibility();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.destroyVisuals();
    this.group.removeFromParent();
    this.group.clear();
  }

  /* --------------------------------------------------------------- state */

  get kind(): SkyWeather {
    return this._kind;
  }

  /** 0..1 sheen actually applied to the material library. */
  get wetness(): number {
    return this.materials.wetness;
  }

  /** 0..1 standing-water coverage; outlives the sheen (§5.1). */
  get puddleAmount(): number {
    return this.puddle;
  }

  /** 0..1 how far the current weather has faded in. */
  get intensity(): number {
    return this.amount;
  }

  /**
   * Set the weather. `announce` publishes `weather:changed` so audio, ambience
   * and UI pick it up; `World.setWeather` passes `false` because it is already
   * reacting to that event.
   */
  setKind(kind: SkyWeather, announce = true): void {
    if (kind === this._kind) return;
    this._kind = kind;
    this.targetAmount = kind === 'rain' ? 1 : kind === 'storm' ? 1 : 0;
    if (this.targetAmount > 0 && this.amount <= 0) {
      // start the strike clock so a storm does not open with a flash
      this.strikeTimer = kind === 'storm' ? 4 + this.rng.next() * 8 : 20 + this.rng.next() * 30;
    }
    this.wind.set(
      kind === 'storm' ? 9.5 : 4.2,
      kind === 'storm' ? 3.2 : 1.4,
    );
    this.lighting.setWeather(kind, this.amount);
    this.applyVisibility();
    if (announce && this.ctx) {
      this.ctx.bus.emit('weather:changed', {
        kind: kind as 'clear' | 'rain' | 'storm' | 'sunset' | 'night',
      });
    }
  }

  /* ------------------------------------------------------------- wetness */

  /**
   * §5.1: wet up fast, dry down slowly. Sheen 1 → 0 over 75 s, puddles over
   * 150 s. Folded into the library's single `wetness` uniform.
   */
  private updateWetness(dt: number): void {
    const wet = this.amount * (this._kind === 'storm' ? 1 : this._kind === 'rain' ? 0.92 : 0);

    if (wet > this.sheen) this.sheen = Math.min(wet, this.sheen + dt / 6.5);
    else this.sheen = Math.max(wet, this.sheen - dt / 75);

    if (wet > this.puddle) this.puddle = Math.min(wet, this.puddle + dt / 22);
    else this.puddle = Math.max(0, this.puddle - dt / 150);

    const drive = clamp01(Math.max(this.sheen, this.puddle * 0.42));
    this.materials.setWetness(drive);
    POST_STATE.wet = drive;
  }

  /* ----------------------------------------------------------------- rain */

  private buildRain(): void {
    const budget = QUALITY_BUDGET[this.quality].maxParticles;
    const count = Math.min(RAIN_COUNT[this.quality], Math.max(200, Math.round(budget * 0.7)));
    this.rainCount = count;

    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    quad.dispose();

    const seed = new Float32Array(count * 3);
    const varr = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seed[i * 3] = this.rng.next();
      seed[i * 3 + 1] = this.rng.next();
      seed[i * 3 + 2] = this.rng.next();
      varr[i * 2] = this.rng.next();
      varr[i * 2 + 1] = this.rng.next();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(varr, 2));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      name: 'loco/rain',
      uniforms: {
        uTime: { value: 0 },
        uVolume: { value: new THREE.Vector3(52, 34, 52) },
        uFall: { value: 15.5 },
        uWind: { value: new THREE.Vector2(4.2, 1.4) },
        uLength: { value: 0.9 },
        uWidth: { value: 0.022 },
        uColor: { value: new THREE.Color(0xcfe0ea).convertSRGBToLinear() },
        uOpacity: { value: 0 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/rain';
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    this.group.add(mesh);

    this.rainGeo = geo;
    this.rainMat = mat;
    this.rainMesh = mesh;
  }

  private updateRain(camPos: THREE.Vector3, dt: number): void {
    const mat = this.rainMat;
    const geo = this.rainGeo;
    if (!mat || !geo || !this.rainMesh) return;
    if (this.amount <= 0.002) {
      this.rainMesh.visible = false;
      return;
    }
    this.rainMesh.visible = true;

    const storm = this._kind === 'storm' ? 1 : 0;
    const u = mat.uniforms;
    u.uTime.value = this.time;
    (u.uWind.value as THREE.Vector2).set(this.wind.x, this.wind.y);
    u.uFall.value = lerp(15.5, 21.0, storm);
    u.uLength.value = lerp(0.85, 1.5, storm);
    u.uWidth.value = lerp(0.020, 0.030, storm);
    u.uOpacity.value = this.amount * lerp(0.5, 0.82, storm);

    // rain scatters skylight — tint it from the fog so it sits in the frame
    const s = this.lighting.state;
    this.tmpC.copy(s.fogColor).lerp(new THREE.Color(1, 1, 1), 0.42);
    (u.uColor.value as THREE.Color).copy(this.tmpC);

    // a storm is denser as well as faster
    const active = Math.round(this.rainCount * this.amount * lerp(0.62, 1, storm));
    geo.instanceCount = Math.max(1, active);

    // keep the volume centred; camPos is read straight from the shader built-in
    void camPos;
    void dt;
  }

  /* ------------------------------------------------------------- splashes */

  private buildSplashes(): void {
    const count = SPLASH_COUNT[this.quality];
    if (count === 0) return;
    const geo = new THREE.RingGeometry(0.55, 1.0, 12, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      name: 'loco/splash',
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'fx/splashes';
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.group.add(mesh);

    this.splashes.length = 0;
    for (let i = 0; i < count; i++) {
      this.splashes.push({ x: 0, y: -1000, z: 0, t: 1, life: 0.42 });
    }
    this.splashMesh = mesh;
    this.splashMat = mat;
  }

  private updateSplashes(camPos: THREE.Vector3, dt: number): void {
    const mesh = this.splashMesh;
    if (!mesh) return;
    if (this.amount <= 0.02) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    const colors = mesh.instanceColor;
    const storm = this._kind === 'storm' ? 1 : 0;
    const radius = 16;

    for (let i = 0; i < this.splashes.length; i++) {
      const s = this.splashes[i];
      s.t += dt;
      if (s.t >= s.life) {
        // respawn somewhere on the ground near the player
        const a = this.rng.next() * Math.PI * 2;
        const r = Math.sqrt(this.rng.next()) * radius;
        s.x = camPos.x + Math.cos(a) * r;
        s.z = camPos.z + Math.sin(a) * r;
        s.y = this.groundHeight(s.x, s.z) + 0.015;
        s.life = 0.32 + this.rng.next() * 0.22;
        s.t = this.rng.next() * 0.12;
      }
      const k = clamp01(s.t / s.life);
      const scale = lerp(0.06, lerp(0.5, 0.72, storm), Math.sqrt(k));
      this.tmpV.set(s.x, s.y, s.z);
      this.tmpS.set(scale, 1, scale);
      this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
      mesh.setMatrixAt(i, this.tmpM);
      if (colors) {
        const a = (1 - k) * (1 - k) * 0.42 * this.amount;
        colors.setXYZ(i, a, a * 1.02, a * 1.08);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- veils */

  private buildVeils(): void {
    const count = VEIL_COUNT[this.quality];
    if (count === 0) return;
    this.veilTex = makeVeilTexture();
    this.veilMat = new THREE.MeshBasicMaterial({
      name: 'loco/rainVeil',
      map: this.veilTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      color: 0xffffff,
      side: THREE.DoubleSide,
      fog: true,
    });
    for (let i = 0; i < count; i++) {
      const dist = 52 + i * 42;
      const geo = new THREE.PlaneGeometry(dist * 1.9, dist * 0.95);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      const rep = 3 + i * 2;
      for (let k = 0; k < uv.count; k++) {
        uv.setXY(k, uv.getX(k) * rep, uv.getY(k) * rep * 0.6);
      }
      uv.needsUpdate = true;
      const mesh = new THREE.Mesh(geo, this.veilMat);
      mesh.name = `fx/rainVeil${i}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 9;
      mesh.userData.dist = dist;
      this.group.add(mesh);
      this.veils.push(mesh);
    }
  }

  private updateVeils(camPos: THREE.Vector3): void {
    if (this.veils.length === 0 || !this.veilMat || !this.veilTex) return;
    const visible = this.amount > 0.02;
    for (const v of this.veils) v.visible = visible;
    if (!visible) return;

    const storm = this._kind === 'storm' ? 1 : 0;
    this.veilMat.opacity = this.amount * lerp(0.10, 0.20, storm);
    const s = this.lighting.state;
    this.veilMat.color.copy(s.fogColor).lerp(new THREE.Color(1, 1, 1), 0.3);
    this.veilTex.offset.y = (-this.time * 1.35) % 1;
    this.veilTex.offset.x = (this.time * 0.06) % 1;

    const cam = this.ctx?.camera;
    if (!cam) return;
    cam.getWorldDirection(this.tmpV);
    this.tmpV.y = 0;
    if (this.tmpV.lengthSq() < 1e-6) this.tmpV.set(0, 0, -1);
    this.tmpV.normalize();
    const yaw = Math.atan2(this.tmpV.x, this.tmpV.z);
    for (const v of this.veils) {
      const d = v.userData.dist as number;
      v.position.set(camPos.x + this.tmpV.x * d, camPos.y + d * 0.22, camPos.z + this.tmpV.z * d);
      v.rotation.set(0, yaw, 0);
    }
  }

  /* ---------------------------------------------------------------- storm */

  private updateStorm(dt: number): void {
    /* queued thunder always drains, even if the weather has just cleared */
    for (let i = this.thunderQueue.length - 1; i >= 0; i--) {
      const q = this.thunderQueue[i];
      q.t -= dt;
      if (q.t <= 0) {
        this.thunderQueue.splice(i, 1);
        if (this.emitThunderSfx && this.ctx) {
          this.ctx.bus.emit('audio:sfx', { id: 'thunder', volume: q.volume, pitch: q.pitch });
        }
      }
    }

    if (this.amount <= 0.15) return;
    const stormy = this._kind === 'storm';
    if (!stormy && this._kind !== 'rain') return;

    if (this.secondStrike > 0) {
      this.secondStrike -= dt;
      if (this.secondStrike <= 0) {
        this.secondStrike = -1;
        this.strike(0.6 * 9.0, 0.06, false);
      }
    }

    this.strikeTimer -= dt;
    if (this.strikeTimer > 0) return;

    // §4.2: 9-22 s in a storm. Rain gets the odd distant rumble.
    this.strikeTimer = stormy ? 9 + this.rng.next() * 13 : 30 + this.rng.next() * 45;
    this.strike(stormy ? 9.0 : 3.2, 0.08, stormy);
  }

  private strike(intensity: number, duration: number, allowDouble: boolean): void {
    const safe = this.ctx?.settings.photosensitiveSafe ?? false;
    if (!safe) this.lighting.flash(intensity, duration);

    // 40 % double strike, second at +0.11 s and 0.6 intensity (§4.2)
    if (allowDouble && !safe && this.rng.bool(0.4)) this.secondStrike = 0.11;

    // thunder travels at ~343 m/s; 300-3200 m away is 0.9-9.3 s of delay
    const distance = 300 + this.rng.next() * 2900;
    const delay = distance / 343;
    const near = clamp01(1 - distance / 3200);
    this.thunderQueue.push({
      t: delay,
      volume: 0.35 + near * 0.6,
      pitch: 0.55 + near * 0.42,
    });
  }

  /* ---------------------------------------------------------------- misc */

  private applyVisibility(): void {
    const on = this.amount > 0.002;
    if (this.rainMesh) this.rainMesh.visible = on;
    if (this.splashMesh) this.splashMesh.visible = on;
    for (const v of this.veils) v.visible = on;
  }

  private destroyVisuals(): void {
    if (this.rainMesh) {
      this.group.remove(this.rainMesh);
      this.rainGeo?.dispose();
      this.rainMat?.dispose();
      this.rainMesh = null;
      this.rainGeo = null;
      this.rainMat = null;
    }
    if (this.splashMesh) {
      this.group.remove(this.splashMesh);
      this.splashMesh.geometry.dispose();
      this.splashMesh.dispose();
      this.splashMat?.dispose();
      this.splashMesh = null;
      this.splashMat = null;
    }
    for (const v of this.veils) {
      this.group.remove(v);
      v.geometry.dispose();
    }
    this.veils.length = 0;
    this.veilMat?.dispose();
    this.veilMat = null;
    this.veilTex?.dispose();
    this.veilTex = null;
    this.splashes.length = 0;
  }

  /** Numbers the QA harness wants. */
  stats(): Record<string, number> {
    return {
      weatherAmount: Number(this.amount.toFixed(3)),
      wetness: Number(this.materials.wetness.toFixed(3)),
      puddle: Number(this.puddle.toFixed(3)),
      rainDrops: this.rainGeo ? this.rainGeo.instanceCount : 0,
      splashes: this.splashes.length,
      veils: this.veils.length,
      nextStrike: Number(Math.max(0, this.strikeTimer).toFixed(2)),
    };
  }
}

