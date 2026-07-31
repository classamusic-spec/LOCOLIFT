/**
 * Loco Lift — weather.
 *
 * Rain, hurricane, lightning, wind, flooding, debris and the waves that break
 * over the malecón. This module is the *gameplay* weather layer: it renders the
 * storm, and it publishes the forces the storm applies, so the vehicle can be
 * pushed, slowed and hit by it without either side knowing about the other.
 *
 * ## What the vehicle asks for
 *
 * ```ts
 * weather.windForceAt(pos, out);                  // N, horizontal
 * weather.waterDepthAt(x, z);                     // m, 0 = dry
 * weather.waterDragAt(pos, velocity, out);        // N, opposes motion
 * weather.isWaveStrike(pos);                      // peek
 * weather.waveImpulseAt(pos, out, velocity);      // N·s, consumes the strike
 * weather.setVehicleState(pos, velocity);         // for wake spray
 * ```
 *
 * All of them are allocation-free, defined everywhere in the world, and return
 * finite numbers for any input including garbage.
 *
 * ## How the storm is built
 *
 * - **Rain is one draw call.** An `InstancedBufferGeometry` of quads wrapped
 *   modulo a camera-relative volume in the vertex shader, so density is
 *   constant no matter how fast the Jeep moves. In a hurricane the fall vector
 *   goes nearly horizontal and a travelling density wave along the wind breaks
 *   the curtain into **sheets** — that is what stops heavy rain reading as
 *   static noise.
 * - **Wind is a field, not a constant.** A build-time exposure raster (building
 *   shelter minus distance-to-water) means the seafront gets a real crosswind
 *   and the tight streets of the old town are calm, and a travelling gust
 *   envelope sweeps squalls through the district. The same field drives the
 *   vegetation rigs, so every palm in the district leans when the gust arrives.
 * - **Visibility collapses in gusts.** The fog density is multiplied up to
 *   ~1.7× at the peak of a squall, on top of the storm preset's own 0.0062.
 * - **Lightning actually lights the scene** — a real directional flash plus a
 *   drawn bolt — and is suppressed *completely*, light and bolt and post punch
 *   alike, when `settings.photosensitiveSafe` is on.
 *
 * ## Budget
 *
 * Rain, veils, splashes, debris, spray, waves, flood water and the bolt are
 * eight draw calls between them, all instanced or merged, all camera-relative.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { GameContext, QualityTier, SfxId } from '../core/types';
import { DISTRICT_BOUNDS, SEA_LEVEL } from '../world/CityLayout';
import type { MaterialLibrary } from '../world/Materials';
import type { CityLayout, WorldLayer, WorldOpts } from '../world/WorldTypes';
import { DebrisField, SprayPool } from './Debris';
import { Flooding, FILM_DEPTH } from './Flooding';
import type { Lighting } from './Lighting';
import { POST_STATE, type LightingState, type SkyWeather } from './LightingPresets';
import { StormWaves } from './StormWaves';

/* ------------------------------------------------------------------- drive */

/**
 * The per-frame weather state every sub-system reads. One object, mutated in
 * place, so nothing downstream allocates.
 */
export interface WeatherDrive {
  /** 0..1 how far the current weather has faded in */
  amount: number;
  /** 0..1 how much of that weather is *storm* rather than plain rain */
  storm: number;
  /** seconds since the layer was built */
  time: number;
  /** unit horizontal wind direction */
  windDir: THREE.Vector2;
  /** m/s at the camera, gust included */
  windSpeed: number;
  /** 0..1 gust envelope at the camera */
  gust: number;
  /** 0..1 standing-water fill fraction */
  flood: number;
  /** the lighting rig's current state — read only */
  light: LightingState;
  /** camera position */
  camera: THREE.Vector3;
  /** current tier */
  quality: QualityTier;
}

/* ------------------------------------------------------------------ tuning */

/**
 * Aerodynamic constant: `F = AERO · v² · exposure` newtons on the vehicle's
 * side. 0.5 · ρ(1.225) · Cd(1.05) · A(2.4 m²) — a Jeep broadside in a gale,
 * with the area taken low because the wind is only ever partly across it.
 *
 * Tuned, not derived: at the exposed seafront this lands a **~1.2 m/s²
 * sustained** lateral push with **~2.4 m/s² gusts** on a 1400 kg vehicle. That
 * is enough that the player is correcting constantly on the malecón and can
 * feel the difference the moment they turn into a side street — and not so much
 * that holding a line becomes a chore.
 */
const AERO = 1.55;

/** Sustained wind, m/s, per weather kind. */
const WIND_BASE: Record<'clear' | 'rain' | 'storm', number> = { clear: 3.4, rain: 8.5, storm: 22 };
/** Peak gust, m/s. */
const WIND_GUST: Record<'clear' | 'rain' | 'storm', number> = { clear: 5.5, rain: 13.5, storm: 40 };

/** Water drag: `F = WATER_DRAG_K · v² · depthFactor` newtons. */
const WATER_DRAG_K = 14;
/** Depth at which the drag term is fully in, metres. */
const WATER_DRAG_FULL = 0.36;
/** Reference mass the drag cap is expressed against, kg. */
const REFERENCE_MASS = 1400;

/** Exposure raster pitch, metres. */
const EXPOSURE_CELL = 10;

/* ------------------------------------------------------------------ shaders */

const RAIN_VERT = /* glsl */ `
attribute vec3 aSeed;
attribute vec2 aVar;

uniform float uTime;
uniform vec3  uVolume;
uniform float uFall;
uniform vec2  uWind;
uniform float uLength;
uniform float uWidth;
uniform float uSheet;
uniform vec2  uSheetDir;

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

  // driving rain arrives in sheets: a density wave travelling along the wind
  float band = sin( dot( wp.xz, uSheetDir ) * 0.052 - uTime * 1.45 + aVar.y * 1.7 );
  vFade *= mix( 1.0, 0.34 + 0.66 * ( band * 0.5 + 0.5 ), uSheet );

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

/** A captured foliage wind rig — see `captureWindRigs`. */
interface WindRig {
  dir: { value: THREE.Vector2 };
  strength: { value: number };
  base: number;
}

const RAIN_COUNT: Record<QualityTier, number> = { low: 380, medium: 900, high: 1700, ultra: 2600 };
const SPLASH_COUNT: Record<QualityTier, number> = { low: 0, medium: 40, high: 80, ultra: 120 };
const VEIL_COUNT: Record<QualityTier, number> = { low: 0, medium: 2, high: 3, ultra: 4 };
/** Wind-torn road spray puffs per second at full hurricane. */
const ROAD_SPRAY_RATE: Record<QualityTier, number> = { low: 0, medium: 10, high: 22, ultra: 32 };

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
  /** 0..1 crossfade between "plain rain" and "hurricane" */
  private stormMix = 0;

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

  /* veils — one merged mesh, one draw call */
  private veilMesh: THREE.Mesh | null = null;
  private veilTex: THREE.DataTexture | null = null;
  private veilMat: THREE.MeshBasicMaterial | null = null;
  private veilCount = 0;

  /* storm */
  private strikeTimer = 14;
  private secondStrike = -1;
  private thunderQueue: Array<{ t: number; volume: number; pitch: number }> = [];

  /* lightning bolt */
  private boltMesh: THREE.Mesh | null = null;
  private boltGeo: THREE.BufferGeometry | null = null;
  private boltMat: THREE.MeshBasicMaterial | null = null;
  private boltTimer = 0;
  private boltDuration = 0.12;

  /* wind */
  private wind = new THREE.Vector2(4.2, 1.4);
  /** unit direction the wind is blowing *towards* */
  private windDir = new THREE.Vector2(0.95, 0.31);
  private windSpeed = 3.4;
  private gust = 0;
  private windTurn = 0;
  private exposure: Float32Array = new Float32Array(0);
  private expW = 0;
  private expH = 0;

  /* sub-systems */
  private flooding: Flooding;
  private waves: StormWaves;
  private debris: DebrisField;
  private spray: SprayPool;
  private drive: WeatherDrive;

  /* foliage rigs we drive without owning */
  private windRigs: WindRig[] = [];
  private hookedMaterials = new WeakSet<THREE.Material>();

  /* vehicle bridge */
  private vehiclePos = new THREE.Vector3();
  private vehicleVel = new THREE.Vector3();
  private vehicleKnown = false;
  private wakeDebt = 0;
  private roadSprayDebt = 0;

  /* scratch */
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();

  private disposed = false;

  constructor(opts: WeatherOpts) {
    this.materials = opts.materials;
    this.lighting = opts.lighting;
    this.quality = opts.quality;
    this.rng = opts.rng.fork(0x5a1f);
    this.group.name = 'fx/weather';
    this.group.renderOrder = 10;

    this.flooding = new Flooding(this.quality);
    this.spray = new SprayPool(this.quality);
    this.debris = new DebrisField(this.quality, this.rng.fork(0xd3b7));
    this.waves = new StormWaves(this.quality, this.rng.fork(0x3a5e), {
      sfx: (id, at, volume, pitch) => this.emitSfx(id, at, volume, pitch),
      onStrike: (power, at) => this.onWaveStrike(power, at),
    });

    this.drive = {
      amount: 0,
      storm: 0,
      time: 0,
      windDir: this.windDir,
      windSpeed: 0,
      gust: 0,
      flood: 0,
      light: this.lighting.state,
      camera: new THREE.Vector3(),
      quality: this.quality,
    };
  }

  /* ---------------------------------------------------------- WorldLayer */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.groundHeight = (x, z) => layout.groundHeight(x, z);
    this.buildExposure(layout);

    this.flooding.build(layout);
    this.group.add(this.flooding.group);

    this.spray.build();
    this.group.add(this.spray.group);

    this.waves.build(layout, this.spray);
    this.group.add(this.waves.group);

    this.debris = new DebrisField(this.quality, this.rng.fork(0xd3b7), {
      field: this.flooding.fieldTexture,
      fieldTransform: this.flooding.fieldTransform,
      fieldMinY: this.flooding.fieldMinY,
      fieldYRange: this.flooding.fieldYRange,
    });
    this.debris.build();
    this.group.add(this.debris.group);

    this.buildRain();
    this.buildSplashes();
    this.buildVeils();
    this.buildBolt();
    this.applyVisibility();

    this.captureWindRigs(opts.scene);
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
    const stormTarget = this._kind === 'storm' ? 1 : 0;
    this.stormMix = clamp01(this.stormMix + Math.sign(stormTarget - this.stormMix) * step * 0.5);
    if (Math.abs(stormTarget - this.stormMix) < 0.01) this.stormMix = stormTarget;

    this.updateWind(cameraPos, step);

    const d = this.drive;
    d.amount = this.amount;
    d.storm = this.stormMix;
    d.time = this.time;
    d.windSpeed = this.windSpeed;
    d.gust = this.gust;
    d.light = this.lighting.state;
    d.camera.copy(cameraPos);
    d.quality = this.quality;

    this.updateWetness(step);
    this.flooding.update(d, step);
    d.flood = this.flooding.level;

    this.updateRain(step);
    this.updateSplashes(cameraPos, step);
    this.updateVeils(cameraPos);
    this.updateAtmosphere();
    this.updateFoliage();

    this.waves.update(d, step, this.vehicleKnown ? this.vehiclePos : cameraPos);
    this.debris.update(d);
    this.updateWake(step);
    this.updateRoadSpray(cameraPos, step);
    this.spray.update(d, step, this.ctx?.camera ?? null);

    this.updateStorm(step);
    this.updateBolt(step);
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.destroyVisuals();
    this.buildRain();
    this.buildSplashes();
    this.buildVeils();
    this.buildBolt();
    this.applyVisibility();
    this.flooding.onQualityChange(tier);
    this.spray.onQualityChange(tier);
    this.waves.onQualityChange(tier);
    this.debris.onQualityChange(tier);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.destroyVisuals();
    this.debris.dispose();
    this.waves.dispose();
    this.spray.dispose();
    this.flooding.dispose();
    // hand the fog back exactly as we found it
    this.lighting.fog.density = this.lighting.state.fogDensity;
    POST_STATE.vignette = 0.22;
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

  /** 0..1 street-flood fill fraction. */
  get floodLevel(): number {
    return this.flooding.level;
  }

  /** Seconds until the next wave set, or 0 while a set is running. */
  get secondsToNextWaveSet(): number {
    return this.waves.secondsToNextSet;
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
    this.lighting.setWeather(kind, this.amount);
    this.applyVisibility();
    if (announce && this.ctx) {
      this.ctx.bus.emit('weather:changed', {
        kind: kind as 'clear' | 'rain' | 'storm' | 'sunset' | 'night',
      });
    }
  }

  /* ============================================================== VEHICLE API */

  /**
   * Horizontal wind force on the vehicle, newtons, written into `out`.
   *
   * Scale by `mass / 1400` if the vehicle is not the Jeep. Wire it in
   * `Vehicle.fixedUpdate`, before the solver step:
   *
   * ```ts
   * weather.windForceAt(this.body.getPosition(this.tmpPoint), this.tmpForce);
   * this.body.applyForce(this.tmpForce);
   * ```
   */
  windForceAt(pos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return out;
    const speed = this.windRawAt(pos.x, pos.z);
    if (speed <= 0.05) return out;
    // exposure scales the *force* linearly; folding it into the speed would
    // square it and turn the seafront into a wall
    const f = AERO * speed * speed * this.exposureAt(pos.x, pos.z);
    out.set(this.windDir.x * f, 0, this.windDir.y * f);
    return out;
  }

  /** Metres of standing water at a world XZ. 0 = dry. Never NaN. */
  waterDepthAt(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    return this.flooding.depthAt(x, z);
  }

  /**
   * Resistive force from wading through standing water, newtons, into `out`.
   * Zero above the water and in a film; it bites hard past ~0.2 m.
   *
   * ```ts
   * weather.waterDragAt(pos, this.velocity, this.tmpForce);
   * this.body.applyForce(this.tmpForce);
   * ```
   */
  waterDragAt(pos: THREE.Vector3, velocity: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    if (!pos || !velocity) return out;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return out;
    const depth = this.flooding.depthAt(pos.x, pos.z);
    if (depth <= FILM_DEPTH) return out;
    const vx = velocity.x;
    const vz = velocity.z;
    const sp = Math.hypot(vx, vz);
    if (!(sp > 0.3)) return out;

    const depthK = clamp01((depth - FILM_DEPTH) / WATER_DRAG_FULL);
    let f = WATER_DRAG_K * sp * sp * depthK;
    // never enough to reverse the vehicle inside one second
    f = Math.min(f, REFERENCE_MASS * sp * 0.6);
    out.set((-vx / sp) * f, 0, (-vz / sp) * f);
    return out;
  }

  /**
   * True while an un-consumed breaking wave has this point under moving water.
   * A peek: it does not consume anything, so it is safe to poll for VFX or a
   * HUD warning.
   */
  isWaveStrike(pos: THREE.Vector3): boolean {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false;
    return this.waves.isStrike(pos.x, pos.z);
  }

  /**
   * Take a wave hit. Writes the one-shot impulse in N·s (authored for a 1400 kg
   * vehicle) into `out` and returns it; writes zero when there is no strike.
   * **Consumes the wave** — one wave can only hit once.
   *
   * Passing the vehicle's linear velocity adds the speed-scrubbing component,
   * which is most of what makes the hit hurt.
   *
   * ```ts
   * if (weather.isWaveStrike(pos)) {
   *   weather.waveImpulseAt(pos, this.tmpForce, this.body.getLinearVelocity(this.tmpVel));
   *   this.body.applyImpulse(this.tmpForce);
   * }
   * ```
   */
  waveImpulseAt(
    pos: THREE.Vector3,
    out: THREE.Vector3,
    velocity?: THREE.Vector3 | null,
  ): THREE.Vector3 {
    out.set(0, 0, 0);
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return out;
    return this.waves.impulseAt(pos.x, pos.z, out, velocity ?? null);
  }

  /**
   * 0..1 "a wave is coming here" value, for a HUD pip or a camera cue. Climbs
   * through the telegraph and peaks as the wave lands. Optional.
   */
  waveThreatAt(pos: THREE.Vector3): number {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return 0;
    return this.waves.threatAt(pos.x, pos.z);
  }

  /**
   * Tell the weather where the vehicle is and how fast it is going. Used for
   * wake spray and to aim wave sets at the player. Call once per frame in
   * `lateUpdate`; entirely optional — without it the camera stands in.
   */
  setVehicleState(pos: THREE.Vector3, velocity: THREE.Vector3): void {
    if (!pos || !Number.isFinite(pos.x)) return;
    this.vehiclePos.copy(pos);
    if (velocity && Number.isFinite(velocity.x)) this.vehicleVel.copy(velocity);
    this.vehicleKnown = true;
  }

  /* ------------------------------------------------------------------ wind */

  /**
   * Meteorological wind speed at a point, m/s: the sustained base for the
   * current weather lerped toward the peak by the travelling gust envelope.
   * Terrain shelter is *not* in here — see `windForceAt`.
   */
  private windRawAt(x: number, z: number): number {
    const g = this.gustAt(x, z);
    const kind = this._kind === 'storm' ? 'storm' : this._kind === 'rain' ? 'rain' : 'clear';
    const blend = kind === 'clear' ? 1 : this.amount;
    const base = lerp(WIND_BASE.clear, WIND_BASE[kind], blend);
    const peak = lerp(WIND_GUST.clear, WIND_GUST[kind], blend);
    const s = lerp(base, peak, g);
    return Number.isFinite(s) ? Math.max(0, s) : 0;
  }

  /**
   * Wind speed as the *visuals* should see it: the raw speed eased partway
   * toward the local shelter, so rain and debris calm down in an alley without
   * the force model double-counting the same term.
   */
  windSpeedAt(x: number, z: number): number {
    return this.windRawAt(x, z) * lerp(1, this.exposureAt(x, z), 0.45);
  }

  /** 0..1 how exposed a point is to the wind. >1 on the open seafront. */
  exposureAt(x: number, z: number): number {
    if (this.exposure.length === 0) return 1;
    const fx = clamp((x - DISTRICT_BOUNDS.minX) / EXPOSURE_CELL, 0, this.expW - 1.001);
    const fz = clamp((z - DISTRICT_BOUNDS.minZ) / EXPOSURE_CELL, 0, this.expH - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const w = this.expW;
    const a = this.exposure[j * w + i];
    const b = this.exposure[j * w + i + 1];
    const c = this.exposure[(j + 1) * w + i];
    const dd = this.exposure[(j + 1) * w + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, dd, tx), tz);
  }

  /**
   * Travelling gust envelope, 0..1. Three squall scales moving downwind, so a
   * gust front sweeps across the district instead of the whole city pulsing.
   */
  private gustAt(x: number, z: number): number {
    const t = this.time;
    // phase advances against the wind so the squall front travels with it
    const along = x * this.windDir.x + z * this.windDir.y;
    const a = Math.sin(t * 0.62 - along * 0.0125);
    const b = Math.sin(t * 0.29 - along * 0.0042 + 1.7);
    const c = Math.sin(t * 1.13 - along * 0.031 + 4.1);
    const raw = a * 0.46 + b * 0.38 + c * 0.16;
    // bias low so calm is the default and gusts are events
    return clamp01(Math.pow(clamp01(raw * 0.5 + 0.5), 1.9));
  }

  private updateWind(cameraPos: THREE.Vector3, dt: number): void {
    // a hurricane's wind veers; ±26° over about ninety seconds
    this.windTurn += dt;
    const baseAngle = 0.32 + Math.sin(this.windTurn * 0.068) * 0.46 * (0.3 + this.stormMix * 0.7);
    this.windDir.set(Math.cos(baseAngle), Math.sin(baseAngle));
    this.gust = this.gustAt(cameraPos.x, cameraPos.z);
    this.windSpeed = this.windSpeedAt(cameraPos.x, cameraPos.z);
    // the rain shader wants a velocity, not a direction
    this.wind.set(this.windDir.x * this.windSpeed * 0.62, this.windDir.y * this.windSpeed * 0.62);
  }

  /**
   * Rasterise how sheltered every part of the district is.
   *
   * Building footprints block wind; open water and the beach amplify it. The
   * result is why the seafront run is a genuinely different drive in a storm
   * from the same run through the old town.
   */
  private buildExposure(layout: CityLayout): void {
    const w = Math.ceil((DISTRICT_BOUNDS.maxX - DISTRICT_BOUNDS.minX) / EXPOSURE_CELL) + 1;
    const h = Math.ceil((DISTRICT_BOUNDS.maxZ - DISTRICT_BOUNDS.minZ) / EXPOSURE_CELL) + 1;
    this.expW = w;
    this.expH = h;
    const n = w * h;

    const cover = new Float32Array(n);
    const water = new Uint8Array(n);
    for (let j = 0; j < h; j++) {
      const z = DISTRICT_BOUNDS.minZ + j * EXPOSURE_CELL;
      for (let i = 0; i < w; i++) {
        const x = DISTRICT_BOUNDS.minX + i * EXPOSURE_CELL;
        if (layout.groundHeight(x, z) <= SEA_LEVEL + 0.4) water[j * w + i] = 1;
      }
    }

    /* --- building footprints --- */
    for (const lot of layout.lots) {
      const poly = lot.polygon;
      if (poly.length < 3) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minZ) minZ = p.y;
        if (p.y > maxZ) maxZ = p.y;
      }
      const i0 = clamp(Math.floor((minX - DISTRICT_BOUNDS.minX) / EXPOSURE_CELL), 0, w - 1);
      const i1 = clamp(Math.ceil((maxX - DISTRICT_BOUNDS.minX) / EXPOSURE_CELL), 0, w - 1);
      const j0 = clamp(Math.floor((minZ - DISTRICT_BOUNDS.minZ) / EXPOSURE_CELL), 0, h - 1);
      const j1 = clamp(Math.ceil((maxZ - DISTRICT_BOUNDS.minZ) / EXPOSURE_CELL), 0, h - 1);
      for (let j = j0; j <= j1; j++) {
        const z = DISTRICT_BOUNDS.minZ + j * EXPOSURE_CELL;
        for (let i = i0; i <= i1; i++) {
          const x = DISTRICT_BOUNDS.minX + i * EXPOSURE_CELL;
          if (pointInPoly(poly, x, z)) cover[j * w + i] = 1;
        }
      }
    }

    /* --- shelter is a neighbourhood property, so blur it --- */
    const shelter = blurF32(cover, w, h, 3);
    /* --- distance to open water, in cells (two-pass chamfer) --- */
    const dist = new Float32Array(n).fill(1e6);
    for (let k = 0; k < n; k++) if (water[k] === 1) dist[k] = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        let v = dist[k];
        if (i > 0) v = Math.min(v, dist[k - 1] + 1);
        if (j > 0) v = Math.min(v, dist[k - w] + 1);
        if (i > 0 && j > 0) v = Math.min(v, dist[k - w - 1] + 1.41);
        dist[k] = v;
      }
    }
    for (let j = h - 1; j >= 0; j--) {
      for (let i = w - 1; i >= 0; i--) {
        const k = j * w + i;
        let v = dist[k];
        if (i < w - 1) v = Math.min(v, dist[k + 1] + 1);
        if (j < h - 1) v = Math.min(v, dist[k + w] + 1);
        if (i < w - 1 && j < h - 1) v = Math.min(v, dist[k + w + 1] + 1.41);
        dist[k] = v;
      }
    }

    const exp = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const sheltered = clamp01(shelter[k]);
      const m = dist[k] * EXPOSURE_CELL;
      const coastal = 1 - sstep(20, 190, m);
      exp[k] = clamp(0.30 + (1 - sheltered * 0.82) * 0.62 + coastal * 0.44, 0.28, 1.35);
    }
    this.exposure = blurF32(exp, w, h, 1);
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
        uSheet: { value: 0 },
        uSheetDir: { value: new THREE.Vector2(1, 0) },
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

  private updateRain(_dt: number): void {
    const mat = this.rainMat;
    const geo = this.rainGeo;
    if (!mat || !geo || !this.rainMesh) return;
    if (this.amount <= 0.002) {
      this.rainMesh.visible = false;
      return;
    }
    this.rainMesh.visible = true;

    const storm = this.stormMix;
    const u = mat.uniforms;
    u.uTime.value = this.time;
    (u.uWind.value as THREE.Vector2).copy(this.wind);
    u.uFall.value = lerp(15.5, 19.0, storm);
    u.uLength.value = lerp(0.85, 1.85, storm);
    u.uWidth.value = lerp(0.02, 0.032, storm);
    // gusts thicken the curtain as well as tilt it
    u.uOpacity.value = this.amount * lerp(0.5, 0.86, storm) * (1 + this.gust * storm * 0.35);
    u.uSheet.value = lerp(0.22, 0.92, storm);
    (u.uSheetDir.value as THREE.Vector2).copy(this.windDir);

    // rain scatters skylight — tint it from the fog so it sits in the frame
    const s = this.lighting.state;
    this.tmpC.copy(s.fogColor).lerp(WHITE, lerp(0.42, 0.52, storm));
    (u.uColor.value as THREE.Color).copy(this.tmpC);

    // a storm is denser as well as faster
    const active = Math.round(this.rainCount * this.amount * lerp(0.62, 1, storm));
    geo.instanceCount = Math.max(1, active);
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
    const storm = this.stormMix;
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
        // a splash on standing water rides the water, not the road
        s.y = this.groundHeight(s.x, s.z) + this.flooding.depthAt(s.x, s.z) + 0.015;
        s.life = 0.32 + this.rng.next() * 0.22;
        s.t = this.rng.next() * 0.12;
      }
      const k = clamp01(s.t / s.life);
      const scale = lerp(0.06, lerp(0.5, 0.78, storm), Math.sqrt(k));
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

  /**
   * The distant rain curtains. Four planes merged into one geometry so the
   * whole depth stack is a single draw call; the mesh is parented to the camera
   * yaw each frame.
   */
  private buildVeils(): void {
    const count = VEIL_COUNT[this.quality];
    this.veilCount = count;
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

    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < count; i++) {
      const dist = 52 + i * 42;
      const halfW = dist * 0.95;
      const halfH = dist * 0.475;
      const y = dist * 0.22;
      const rep = 3 + i * 2;
      const base = pos.length / 3;
      pos.push(-halfW, y - halfH, dist, halfW, y - halfH, dist, halfW, y + halfH, dist, -halfW, y + halfH, dist);
      uv.push(0, 0, rep, 0, rep, rep * 0.6, 0, rep * 0.6);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mesh = new THREE.Mesh(geo, this.veilMat);
    mesh.name = 'fx/rainVeils';
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    this.group.add(mesh);
    this.veilMesh = mesh;
  }

  private updateVeils(camPos: THREE.Vector3): void {
    const mesh = this.veilMesh;
    if (!mesh || !this.veilMat || !this.veilTex) return;
    const visible = this.amount > 0.02;
    mesh.visible = visible;
    if (!visible) return;

    const storm = this.stormMix;
    // a squall front is a wall of water you cannot see through
    this.veilMat.opacity =
      this.amount * lerp(0.1, 0.24, storm) * (1 + this.gust * storm * 1.15);
    const s = this.lighting.state;
    this.veilMat.color.copy(s.fogColor).lerp(WHITE, 0.3);
    this.veilTex.offset.y = (-this.time * lerp(1.35, 2.4, storm)) % 1;
    this.veilTex.offset.x = (this.time * lerp(0.06, 0.4, storm)) % 1;

    const cam = this.ctx?.camera;
    if (!cam) return;
    cam.getWorldDirection(this.tmpV);
    this.tmpV.y = 0;
    if (this.tmpV.lengthSq() < 1e-6) this.tmpV.set(0, 0, -1);
    this.tmpV.normalize();
    mesh.position.copy(camPos);
    mesh.rotation.set(0, Math.atan2(this.tmpV.x, this.tmpV.z), 0);
  }

  /* ----------------------------------------------------------- atmosphere */

  /**
   * The parts of the frame the weather owns but does not draw: fog density in
   * a gust, and the vignette closing down in a squall.
   *
   * `Lighting.refresh` writes the fog from the preset table; this runs after it
   * every frame, so the multiplier never fights the time-of-day curve.
   */
  private updateAtmosphere(): void {
    const s = this.lighting.state;
    const storm = this.stormMix * this.amount;
    // 1.0 → 1.7 at the peak of a squall. At 0.0105 that is 63 % fogged at
    // 120 m: you can drive it, but you cannot see the next junction.
    const mult = 1 + this.gust * storm * 0.7 + storm * 0.12;
    this.lighting.fog.density = s.fogDensity * mult;
    POST_STATE.vignette = 0.22 + storm * (0.05 + this.gust * 0.1);
  }

  /* ------------------------------------------------------------- foliage */

  /**
   * Drive every vegetation wind rig in the scene without owning any of them.
   *
   * The plant layers bind `uWindDir` / `uWindStrength` uniform *objects* into
   * their shaders; wrapping `onBeforeCompile` before first compile lets us hold
   * the same objects and push the storm through them. Nothing in those modules
   * changes, and a layer that has no wind rig is simply never captured.
   */
  private captureWindRigs(scene: THREE.Scene): void {
    const consider = (mat: THREE.Material): void => {
      if (this.hookedMaterials.has(mat)) return;
      this.hookedMaterials.add(mat);
      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader, renderer) => {
        prev.call(mat, shader, renderer);
        const dir = shader.uniforms.uWindDir as { value: THREE.Vector2 } | undefined;
        const strength = shader.uniforms.uWindStrength as { value: number } | undefined;
        if (!dir || !strength || !(dir.value instanceof THREE.Vector2)) return;
        for (const r of this.windRigs) if (r.strength === strength) return;
        this.windRigs.push({ dir, strength, base: strength.value });
      };
    };

    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (Array.isArray(mesh.material)) for (const m of mesh.material) consider(m);
      else consider(mesh.material);
    });
  }

  private updateFoliage(): void {
    if (this.windRigs.length === 0) return;
    const storm = this.stormMix * this.amount;
    const rain = (this.amount - storm) * 0.4;
    // a hurricane lays the palms over: up to 3.4x the calm-day sway, whipping
    // harder still at the peak of a gust
    const bend = 1 + rain * 0.5 + storm * (1.5 + this.gust * 1.9);
    for (const r of this.windRigs) {
      r.strength.value = r.base * bend;
      r.dir.value.set(this.windDir.x, this.windDir.y);
    }
  }

  /* ---------------------------------------------------------------- spray */

  /** Wake thrown up by the vehicle wading through standing water. */
  private updateWake(dt: number): void {
    if (!this.vehicleKnown) return;
    const p = this.vehiclePos;
    const depth = this.flooding.depthAt(p.x, p.z);
    if (depth <= 0.035) return;
    const sp = Math.hypot(this.vehicleVel.x, this.vehicleVel.z);
    if (sp < 3) return;

    const strength = clamp01((depth - 0.03) / 0.28) * clamp01((sp - 3) / 18);
    this.wakeDebt += strength * 55 * dt;
    let emit = Math.floor(this.wakeDebt);
    this.wakeDebt -= emit;
    if (emit > 8) emit = 8;
    if (emit <= 0) return;

    const dirX = this.vehicleVel.x / sp;
    const dirZ = this.vehicleVel.z / sp;
    const sideX = -dirZ;
    const sideZ = dirX;
    const surface = this.flooding.groundAt(p.x, p.z) + depth;
    for (let i = 0; i < emit; i++) {
      const side = this.rng.bool() ? 1 : -1;
      const off = this.rng.range(0.75, 1.05) * side;
      const back = this.rng.range(-1.6, 0.9);
      this.spray.spawn(
        p.x + sideX * off + dirX * back,
        surface + 0.06,
        p.z + sideZ * off + dirZ * back,
        sideX * side * this.rng.range(1.4, 3.6) + dirX * sp * 0.22,
        this.rng.range(1.6, 4.4) * (0.5 + strength),
        sideZ * side * this.rng.range(1.4, 3.6) + dirZ * sp * 0.22,
        this.rng.range(0.25, 0.6),
        this.rng.range(0.42, 0.78),
        this.rng.range(0.24, 0.5) * (0.4 + strength * 0.6),
        0.45,
      );
    }
  }

  /** Sheets of water torn off the road surface by the wind. */
  private updateRoadSpray(camPos: THREE.Vector3, dt: number): void {
    const rate = ROAD_SPRAY_RATE[this.quality] * this.stormMix * this.amount * (0.35 + this.gust);
    if (rate <= 0.01) return;
    this.roadSprayDebt += rate * dt;
    let emit = Math.floor(this.roadSprayDebt);
    this.roadSprayDebt -= emit;
    if (emit > 6) emit = 6;
    for (let i = 0; i < emit; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = 6 + Math.sqrt(this.rng.next()) * 26;
      const x = camPos.x + Math.cos(a) * r;
      const z = camPos.z + Math.sin(a) * r;
      const y = this.groundHeight(x, z) + this.flooding.depthAt(x, z);
      this.spray.spawn(
        x, y + 0.1, z,
        this.windDir.x * this.windSpeed * 0.5,
        this.rng.range(0.4, 2.4),
        this.windDir.y * this.windSpeed * 0.5,
        this.rng.range(0.7, 2.0),
        this.rng.range(0.7, 1.5),
        this.rng.range(0.06, 0.16),
        0.95,
      );
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
    if (!safe) {
      this.lighting.flash(intensity, duration);
      // a close strike also draws the bolt
      if (intensity > 5 && this.rng.bool(0.72)) this.spawnBolt(intensity);
    }

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

  /* -------------------------------------------------------- lightning bolt */

  /**
   * The drawn bolt. Sixteen segments of jagged ribbon plus two branches,
   * rebuilt in place on each strike — one draw call, and only alive for the
   * ~0.12 s the flash lasts. Never built or shown when `photosensitiveSafe`.
   */
  private buildBolt(): void {
    const SEGS = 18;
    const verts = new Float32Array((SEGS + 1) * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < SEGS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.MeshBasicMaterial({
      name: 'loco/bolt',
      color: 0xdde8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/lightningBolt';
    mesh.frustumCulled = false;
    mesh.renderOrder = 14;
    mesh.visible = false;
    this.group.add(mesh);

    this.boltGeo = geo;
    this.boltMat = mat;
    this.boltMesh = mesh;
  }

  private spawnBolt(intensity: number): void {
    const geo = this.boltGeo;
    const mesh = this.boltMesh;
    if (!geo || !mesh) return;
    const cam = this.ctx?.camera;
    const cx = cam ? cam.position.x : 0;
    const cz = cam ? cam.position.z : 0;

    const ang = this.rng.next() * Math.PI * 2;
    const dist = 260 + this.rng.next() * 640;
    const gx = cx + Math.cos(ang) * dist;
    const gz = cz + Math.sin(ang) * dist;
    const gy = clamp(this.groundHeight(gx, gz), SEA_LEVEL, 60);
    const topY = 320 + this.rng.next() * 220;

    // the ribbon faces the camera: width axis perpendicular to camera→bolt
    let wx = -(gz - cz);
    let wz = gx - cx;
    const wl = Math.hypot(wx, wz) || 1;
    wx /= wl;
    wz /= wl;

    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const SEGS = pos.count / 2 - 1;
    let px = gx;
    let pz = gz;
    let drift = 0;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const y = lerp(gy, topY, t);
      // jitter grows with height, so the strike point stays put
      const jitter = 4 + t * 46;
      drift += this.rng.range(-1, 1) * jitter * 0.5;
      const x = px + this.rng.range(-1, 1) * jitter * 0.35 + drift * 0.02;
      const z = pz + this.rng.range(-1, 1) * jitter * 0.35;
      const w = lerp(4.2, 1.1, t) * (0.7 + this.rng.next() * 0.6);
      pos.setXYZ(i * 2, x - wx * w, y, z - wz * w);
      pos.setXYZ(i * 2 + 1, x + wx * w, y, z + wz * w);
      px = x;
      pz = z;
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(gx, topY * 0.5, gz), topY);

    this.boltDuration = 0.1 + this.rng.next() * 0.07;
    this.boltTimer = this.boltDuration;
    if (this.boltMat) this.boltMat.opacity = clamp01(0.55 + intensity * 0.05);
    mesh.visible = true;
  }

  private updateBolt(dt: number): void {
    const mesh = this.boltMesh;
    const mat = this.boltMat;
    if (!mesh || !mat || this.boltTimer <= 0) return;
    this.boltTimer -= dt;
    if (this.boltTimer <= 0) {
      mesh.visible = false;
      mat.opacity = 0;
      return;
    }
    const k = clamp01(this.boltTimer / Math.max(this.boltDuration, 1e-4));
    // a hard flicker on the way out, but only two frames of it
    mat.opacity = k * k * (0.7 + 0.3 * (this.rng.next() > 0.4 ? 1 : 0.35));
  }

  /* ---------------------------------------------------------------- hooks */

  private emitSfx(id: SfxId, at: THREE.Vector3, volume: number, pitch: number): void {
    if (!this.ctx) return;
    this.tmpV2.copy(at);
    this.ctx.bus.emit('audio:sfx', { id, at: this.tmpV2, volume, pitch });
  }

  /**
   * A wave has landed on the player. The impulse is the caller's problem; this
   * is the rest of the consequence.
   *
   * It is published as a `vehicle:collision` rather than a bare `combo:break`
   * on purpose. `ComboSystem` breaks the chain off collisions above 2200 N·s
   * and a wave strike is 6–14 k, so the combo goes *through the system that
   * owns it* instead of being reset behind its back — and the camera shake, the
   * impact mix, the passenger's reaction and any challenge that counts clean
   * runs all react correctly for free.
   */
  private onWaveStrike(power: number, at: THREE.Vector3): void {
    if (this.ctx) {
      this.ctx.bus.emit('vehicle:collision', {
        impulse: 3200 + power * 6000,
        kind: 'wall',
      });
    }
    for (let i = 0; i < 18; i++) {
      this.spray.spawn(
        at.x + this.rng.range(-1.6, 1.6),
        at.y + this.rng.range(0, 1.4),
        at.z + this.rng.range(-1.6, 1.6),
        this.rng.range(-5, 5),
        this.rng.range(3.5, 10) * (0.5 + power),
        this.rng.range(-5, 5),
        this.rng.range(0.35, 0.95),
        this.rng.range(0.6, 1.2),
        this.rng.range(0.35, 0.8),
        0.6,
      );
    }
  }

  /* ---------------------------------------------------------------- misc */

  private applyVisibility(): void {
    const on = this.amount > 0.002;
    if (this.rainMesh) this.rainMesh.visible = on;
    if (this.splashMesh) this.splashMesh.visible = on;
    if (this.veilMesh) this.veilMesh.visible = on;
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
    if (this.veilMesh) {
      this.group.remove(this.veilMesh);
      this.veilMesh.geometry.dispose();
      this.veilMesh = null;
    }
    this.veilMat?.dispose();
    this.veilMat = null;
    this.veilTex?.dispose();
    this.veilTex = null;
    if (this.boltMesh) {
      this.group.remove(this.boltMesh);
      this.boltGeo?.dispose();
      this.boltMat?.dispose();
      this.boltMesh = null;
      this.boltGeo = null;
      this.boltMat = null;
    }
    this.splashes.length = 0;
  }

  /** Numbers the QA harness wants. */
  stats(): Record<string, number> {
    return {
      weatherAmount: Number(this.amount.toFixed(3)),
      weatherStorm: Number(this.stormMix.toFixed(3)),
      wetness: Number(this.materials.wetness.toFixed(3)),
      puddle: Number(this.puddle.toFixed(3)),
      rainDrops: this.rainGeo ? this.rainGeo.instanceCount : 0,
      splashes: this.splashes.length,
      veils: this.veilCount,
      nextStrike: Number(Math.max(0, this.strikeTimer).toFixed(2)),
      windSpeed: Number(this.windSpeed.toFixed(2)),
      windGust: Number(this.gust.toFixed(3)),
      windRigs: this.windRigs.length,
      ...this.flooding.stats(),
      ...this.waves.stats(),
      ...this.debris.stats(),
      ...this.spray.stats(),
    };
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/* --------------------------------------------------------------- helpers */

function sstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

function pointInPoly(poly: readonly THREE.Vector2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi.y > z !== pj.y > z) {
      const t = (z - pi.y) / (pj.y - pi.y);
      if (x < pi.x + t * (pj.x - pi.x)) inside = !inside;
    }
  }
  return inside;
}

/** Separable box blur over a float grid. */
function blurF32(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let j = 0; j < h; j++) {
    const row = j * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1)];
    for (let i = 0; i < w; i++) {
      tmp[row + i] = sum * norm;
      sum -= src[row + clamp(i - r, 0, w - 1)];
      sum += src[row + clamp(i + r + 1, 0, w - 1)];
    }
  }
  for (let i = 0; i < w; i++) {
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += tmp[clamp(j, 0, h - 1) * w + i];
    for (let j = 0; j < h; j++) {
      out[j * w + i] = sum * norm;
      sum -= tmp[clamp(j - r, 0, h - 1) * w + i];
      sum += tmp[clamp(j + r + 1, 0, h - 1) * w + i];
    }
  }
  return out;
}
