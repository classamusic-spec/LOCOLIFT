/**
 * Loco Lift — the world system.
 *
 * Owns the district: generates the layout, builds the ground and the collider,
 * holds the shared texture and material libraries, and runs the sun / sky /
 * ambient rig. Everything else in the game reads the world through `WorldAPI`.
 *
 * Later visual modules (buildings, props, vegetation, weather) attach with
 * {@link World.registerLayer} and are built, updated and disposed by the world.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils';
import type {
  GameContext,
  POI,
  QualityTier,
  RoadGraph,
  SettingsState,
  System,
  WorldAPI,
} from '../core/types';
import type { RNG } from '../core/RNG';
import { generateCityLayout, DISTRICT_BOUNDS, SEA_LEVEL } from './CityLayout';
import { Ground } from './Ground';
import { MaterialLibrary } from './Materials';
import { TextureFactory } from './TextureFactory';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

export type WeatherKind = 'clear' | 'rain' | 'storm' | 'sunset' | 'night';

/* ---------------------------------------------------------------- sky dome */

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uHaze;
varying vec3 vDir;

// NOTE: three injects tonemapping_pars_fragment and colorspace_pars_fragment
// into the fragment prefix for every ShaderMaterial, so including them here
// too redefines toneMappingExposure and every tone-mapping function. Only the
// apply-chunks below are ours to include.
#include <common>

void main() {
  vec3 d = normalize( vDir );
  float up = d.y;

  // vertical gradient: horizon haze -> zenith
  float t = pow( clamp( up, 0.0, 1.0 ), 0.62 );
  vec3 col = mix( uHorizon, uZenith, t );
  // below the horizon fades into a dull sea haze
  col = mix( uGround, col, smoothstep( -0.22, 0.02, up ) );

  float sd = max( dot( d, uSunDir ), 0.0 );
  // broad atmospheric scatter around the sun, strongest near the horizon
  col += uSunColor * pow( sd, 3.0 ) * 0.22 * uHaze;
  col += uSunColor * pow( sd, 32.0 ) * 0.45;
  // the disc itself
  col += uSunColor * smoothstep( 0.9975, 0.99925, sd ) * 5.0;

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------- lighting profile */

interface SkyState {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  ambient: number;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  haze: number;
}

const LATITUDE = (18.46 * Math.PI) / 180;
const DECLINATION = (14 * Math.PI) / 180;

const SHADOW_EXTENT: Record<QualityTier, number> = {
  low: 70,
  medium: 95,
  high: 125,
  ultra: 155,
};

/* ------------------------------------------------------------------ world */

export class World implements System, WorldAPI {
  readonly name = 'world';
  readonly root = new THREE.Group();

  readonly layout: CityLayout;
  readonly roads: RoadGraph;
  readonly sidewalks: RoadGraph;
  readonly pois: POI[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly textures: TextureFactory;
  readonly materials: MaterialLibrary;
  readonly ground: Ground;

  private quality: QualityTier;
  private opts: WorldOpts;
  /** private stream, so world queries never shift another system's draws */
  private rng: RNG;

  /* lighting rig */
  private _sun = new THREE.DirectionalLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0x9fc7ef, 0xb59a72, 0.9);
  private ambient = new THREE.AmbientLight(0xffffff, 0.12);
  private skyMesh: THREE.Mesh;
  private skyUniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
    uSunColor: { value: THREE.Color };
    uSunDir: { value: THREE.Vector3 };
    uHaze: { value: number };
  };
  private fog = new THREE.Fog(0x8fb8d8, 60, 900);

  private _timeOfDay = 12;
  private _weather: WeatherKind = 'clear';
  private sunDir = new THREE.Vector3(0.3, 0.85, 0.4);
  private shadowFocus = new THREE.Vector3();
  private focusTarget = new THREE.Vector3();

  /* lot lookup for isBlocked */
  private lotCell = 18;
  private lotGrid = new Map<number, number[]>();

  private poiMap = new Map<string, POI>();
  private layers: WorldLayer[] = [];
  private pending: Array<Promise<void>> = [];
  private unsubs: Array<() => void> = [];
  private disposed = false;

  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();

  private constructor(opts: WorldOpts, layout: CityLayout) {
    this.opts = opts;
    this.quality = opts.quality;
    this.rng = opts.rng.fork(0xf0);
    this.layout = layout;
    this.roads = layout.roads;
    this.sidewalks = layout.sidewalks;
    this.pois = layout.pois;
    this.bounds = layout.bounds;
    this.root.name = 'world';

    for (const p of this.pois) this.poiMap.set(p.id, p);
    this.buildLotIndex();

    this.textures = new TextureFactory(opts.quality);
    this.materials = new MaterialLibrary(this.textures, opts.quality);
    this.ground = new Ground(this.materials, opts.physics, opts.quality);

    /* --- lighting rig --- */
    this._sun.name = 'world/sun';
    this._sun.castShadow = true;
    const shadowMap = QUALITY_BUDGET[opts.quality].shadowMapSize;
    this._sun.shadow.mapSize.set(shadowMap, shadowMap);
    const ext = SHADOW_EXTENT[opts.quality];
    const cam = this._sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = 780;
    cam.updateProjectionMatrix();
    this._sun.shadow.bias = -0.0007;
    this._sun.shadow.normalBias = 0.55;
    this._sun.target.position.set(0, 0, 0);
    this.root.add(this._sun);
    this.root.add(this._sun.target);
    this.root.add(this.hemi);
    this.root.add(this.ambient);

    this.skyUniforms = {
      uZenith: { value: new THREE.Color(0x2f79c9) },
      uHorizon: { value: new THREE.Color(0xbcd8ea) },
      uGround: { value: new THREE.Color(0x2a3844) },
      uSunColor: { value: new THREE.Color(0xfff0d8) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uHaze: { value: 1 },
    };
    const skyGeo = new THREE.SphereGeometry(1, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      name: 'loco/sky',
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.name = 'world/sky';
    this.skyMesh.renderOrder = -1000;
    this.skyMesh.frustumCulled = false;
    this.skyMesh.scale.setScalar(400);
    this.root.add(this.skyMesh);

    opts.scene.add(this.root);
    opts.scene.fog = this.fog;

    this.ground.build(layout, opts);
    this.root.add(this.ground.group);

    this.setTimeOfDay(12);
  }

  /** Generate the district, build the ground and light it. */
  static async create(opts: WorldOpts): Promise<World> {
    const layout = generateCityLayout(opts.rng);
    // yield once so the caller's loading screen can paint before the heavy build
    await Promise.resolve();
    return new World(opts, layout);
  }

  /* ------------------------------------------------------------ WorldAPI */

  groundHeight(x: number, z: number): number {
    return this.layout.groundHeight(x, z);
  }

  isBlocked(x: number, z: number): boolean {
    const key = this.cellKey(x, z);
    const list = this.lotGrid.get(key);
    if (!list) return false;
    for (const li of list) {
      const poly = this.layout.lots[li].polygon;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const pi = poly[i];
        const pj = poly[j];
        if (pi.y > z !== pj.y > z) {
          const t = (z - pi.y) / (pj.y - pi.y);
          if (x < pi.x + t * (pj.x - pi.x)) inside = !inside;
        }
      }
      if (inside) return true;
    }
    return false;
  }

  poiById(id: string): POI | undefined {
    return this.poiMap.get(id);
  }

  get spawnPoint(): { pos: THREE.Vector3; heading: number } {
    return this.layout.spawn;
  }

  get sun(): THREE.DirectionalLight {
    return this._sun;
  }

  get timeOfDay(): number {
    return this._timeOfDay;
  }

  get weather(): WeatherKind {
    return this._weather;
  }

  /** Random drivable point on a street — traffic and mission spawn helper. */
  randomRoadPoint(out = new THREE.Vector3()): THREE.Vector3 {
    const edges = this.roads.edges;
    let e = this.rng.int(0, edges.length - 1);
    for (let tries = 0; tries < 12 && edges[e].noTraffic; tries++) {
      e = this.rng.int(0, edges.length - 1);
    }
    return this.roads.sample(e, this.rng.next(), 0, out);
  }

  /* --------------------------------------------------------------- layers */

  /**
   * Attach a later world layer (buildings, props, vegetation, weather). The
   * layer is built immediately, updated every frame and disposed with the world.
   */
  registerLayer(layer: WorldLayer): void {
    this.layers.push(layer);
    this.root.add(layer.group);
    const result = layer.build(this.layout, this.opts);
    if (result && typeof (result as Promise<void>).then === 'function') {
      this.pending.push(
        (result as Promise<void>).catch((err: unknown) => {
          console.error(`[world] layer "${layer.name}" failed to build:`, err);
        }),
      );
    }
  }

  /** Resolves once every registered layer has finished building. */
  async whenReady(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      await Promise.all(batch);
    }
  }

  /* ------------------------------------------------------------- lighting */

  /**
   * `hours` in 0..24. Drives the sun elevation and azimuth from a real solar
   * model at San Juan's latitude, then the sky, fog and fill lights from that.
   */
  setTimeOfDay(hours: number): void {
    this._timeOfDay = ((hours % 24) + 24) % 24;
    const hourAngle = (this._timeOfDay - 12) * (Math.PI / 12);
    const sinEl =
      Math.sin(DECLINATION) * Math.sin(LATITUDE) +
      Math.cos(DECLINATION) * Math.cos(LATITUDE) * Math.cos(hourAngle);
    const elevation = Math.asin(clamp(sinEl, -1, 1));
    const cosEl = Math.cos(elevation);

    // east at dawn (+X), west at dusk (-X), leaning a touch south at midday
    this.sunDir.set(-Math.sin(hourAngle) * cosEl, Math.sin(elevation), 0.32 * cosEl * Math.cos(hourAngle));
    if (this.sunDir.lengthSq() < 1e-6) this.sunDir.set(0, 1, 0);
    this.sunDir.normalize();

    const state = this.skyState(elevation);
    this.applySkyState(state);
  }

  setWeather(kind: WeatherKind): void {
    this._weather = kind;
    if (kind === 'sunset') this.setTimeOfDay(18.15);
    else if (kind === 'night') this.setTimeOfDay(0.6);
    else this.setTimeOfDay(this._timeOfDay);
  }

  /** Full lighting/sky description for a sun elevation, modulated by weather. */
  private skyState(elevation: number): SkyState {
    const day = clamp01(smoothstep((elevation + 0.10) / 0.24));
    const noon = clamp01(smoothstep((elevation - 0.12) / 0.8));
    const golden = clamp01(1 - Math.abs(elevation - 0.10) / 0.28);
    const night = 1 - day;

    const zenith = new THREE.Color(0x060c22).lerp(new THREE.Color(0x2668b8), day);
    zenith.lerp(new THREE.Color(0x1f6ecb), noon);
    const horizon = new THREE.Color(0x101a30).lerp(new THREE.Color(0xf2a765), day);
    horizon.lerp(new THREE.Color(0xc7e0f2), noon);
    horizon.lerp(new THREE.Color(0xff8f52), golden * 0.7);
    const ground = new THREE.Color(0x090f18).lerp(new THREE.Color(0x4c5a5e), day);

    const sunColor = new THREE.Color(0xff5a1f)
      .lerp(new THREE.Color(0xffb46a), clamp01(elevation / 0.25))
      .lerp(new THREE.Color(0xfff3e0), noon);

    let sunIntensity = lerp(0.0, 3.5, day) * lerp(0.72, 1, noon);
    if (night > 0.85) sunIntensity = 0.34; // moonlight takes over

    const hemiSky = new THREE.Color(0x0a1430).lerp(new THREE.Color(0x9ec9f2), day);
    const hemiGround = new THREE.Color(0x100e14).lerp(new THREE.Color(0xb2916a), day);
    let hemiIntensity = lerp(0.28, 1.15, day);
    let ambient = lerp(0.09, 0.16, day);

    const budget = QUALITY_BUDGET[this.quality];
    let fogNear = budget.drawDistance * 0.30;
    let fogFar = budget.drawDistance * 1.45;
    const fogColor = horizon.clone().lerp(zenith, 0.25);
    let haze = lerp(0.35, 1.3, golden) + noon * 0.2;

    switch (this._weather) {
      case 'rain':
        sunIntensity *= 0.32;
        hemiIntensity *= 1.05;
        ambient *= 1.5;
        fogNear *= 0.35;
        fogFar *= 0.5;
        fogColor.lerp(new THREE.Color(0x6d7986), 0.62);
        zenith.lerp(new THREE.Color(0x53606d), 0.7);
        horizon.lerp(new THREE.Color(0x7b8794), 0.72);
        haze *= 0.4;
        break;
      case 'storm':
        sunIntensity *= 0.16;
        hemiIntensity *= 0.85;
        ambient *= 1.4;
        fogNear *= 0.2;
        fogFar *= 0.32;
        fogColor.lerp(new THREE.Color(0x40474f), 0.8);
        zenith.lerp(new THREE.Color(0x2f363e), 0.85);
        horizon.lerp(new THREE.Color(0x4d545c), 0.85);
        haze *= 0.25;
        break;
      case 'night':
        fogFar *= 0.8;
        break;
      case 'sunset':
        haze *= 1.4;
        break;
      default:
        break;
    }

    return {
      zenith,
      horizon,
      ground,
      sunColor,
      sunIntensity,
      hemiSky,
      hemiGround,
      hemiIntensity,
      ambient,
      fogColor,
      fogNear,
      fogFar,
      haze,
    };
  }

  private applySkyState(s: SkyState): void {
    this.skyUniforms.uZenith.value.copy(s.zenith);
    this.skyUniforms.uHorizon.value.copy(s.horizon);
    this.skyUniforms.uGround.value.copy(s.ground);
    this.skyUniforms.uSunColor.value.copy(s.sunColor);
    this.skyUniforms.uSunDir.value.copy(this.sunDir);
    this.skyUniforms.uHaze.value = s.haze;

    const night = this.sunDir.y < -0.02;
    this._sun.color.copy(night ? new THREE.Color(0xa8c2ea) : s.sunColor);
    this._sun.intensity = s.sunIntensity;
    // the moon stands opposite the sun so nights are still readable
    this.tmpV.copy(this.sunDir);
    if (night) this.tmpV.multiplyScalar(-1).setY(Math.max(0.32, -this.sunDir.y));
    this.tmpV.normalize();
    this.tmpV2.copy(this.tmpV);

    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    this.ambient.intensity = s.ambient;

    this.fog.color.copy(s.fogColor);
    this.fog.near = s.fogNear;
    this.fog.far = s.fogFar;

    const wet = this._weather === 'rain' ? 1 : this._weather === 'storm' ? 1 : 0;
    this.materials.setWetness(wet);

    this.positionSun();
  }

  /** Places the shadow camera around the current focus point. */
  private positionSun(): void {
    const dir = this.tmpV2.lengthSq() > 0.1 ? this.tmpV2 : this.sunDir;
    const ext = SHADOW_EXTENT[this.quality];
    // snap the focus to the shadow texel grid to keep edges from crawling
    const texel = (ext * 2) / QUALITY_BUDGET[this.quality].shadowMapSize;
    const fx = Math.round(this.shadowFocus.x / texel) * texel;
    const fz = Math.round(this.shadowFocus.z / texel) * texel;
    const fy = this.shadowFocus.y;
    this._sun.target.position.set(fx, fy, fz);
    this._sun.target.updateMatrixWorld();
    this._sun.position.set(fx + dir.x * 300, fy + dir.y * 300, fz + dir.z * 300);
    this._sun.updateMatrixWorld();
  }

  /* --------------------------------------------------------------- system */

  init(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('weather:changed', (e) => this.setWeather(e.kind as WeatherKind)),
    );
    this.shadowFocus.copy(this.layout.spawn.pos);
    this.setTimeOfDay(ctx.timeOfDay);
  }

  update(ctx: GameContext, dt: number): void {
    if (Math.abs(ctx.timeOfDay - this._timeOfDay) > 0.004) this.setTimeOfDay(ctx.timeOfDay);

    this.materials.update(dt);

    // keep the sky dome wrapped around the viewer, inside the far plane
    const cam = ctx.camera;
    this.skyMesh.position.copy(cam.position);
    const radius = clamp(cam.far * 0.4, 60, 1400);
    if (Math.abs(this.skyMesh.scale.x - radius) > 1) this.skyMesh.scale.setScalar(radius);

    // aim the shadow volume a little ahead of the camera
    cam.getWorldDirection(this.tmpV);
    const ext = SHADOW_EXTENT[this.quality];
    this.focusTarget.set(
      cam.position.x + this.tmpV.x * ext * 0.45,
      0,
      cam.position.z + this.tmpV.z * ext * 0.45,
    );
    this.focusTarget.y = this.groundHeight(this.focusTarget.x, this.focusTarget.z);
    const rate = dt > 0 ? 9 : 0;
    this.shadowFocus.set(
      damp(this.shadowFocus.x, this.focusTarget.x, rate, dt),
      damp(this.shadowFocus.y, this.focusTarget.y, rate, dt),
      damp(this.shadowFocus.z, this.focusTarget.z, rate, dt),
    );
    this.positionSun();

    for (const layer of this.layers) layer.update?.(cam.position, dt, this._timeOfDay);
  }

  onQualityChange(tier: QualityTier, settings: SettingsState): void {
    this.quality = tier;
    const map = QUALITY_BUDGET[tier].shadowMapSize;
    this._sun.castShadow = settings.shadows;
    this._sun.shadow.mapSize.set(map, map);
    this._sun.shadow.map?.dispose();
    this._sun.shadow.map = null;
    const ext = SHADOW_EXTENT[tier];
    const cam = this._sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.updateProjectionMatrix();
    this.ground.onQualityChange?.(tier);
    for (const layer of this.layers) layer.onQualityChange?.(tier);
    this.setTimeOfDay(this._timeOfDay);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const layer of this.layers) layer.dispose();
    this.layers.length = 0;
    this.ground.dispose();
    this.materials.dispose();
    this.textures.dispose();
    this.skyMesh.geometry.dispose();
    (this.skyMesh.material as THREE.Material).dispose();
    this._sun.shadow.map?.dispose();
    this.root.removeFromParent();
    this.root.clear();
    if (this.opts.scene.fog === this.fog) this.opts.scene.fog = null;
  }

  /* --------------------------------------------------------------- lookup */

  private cellKey(x: number, z: number): number {
    const i = Math.floor(x / this.lotCell);
    const j = Math.floor(z / this.lotCell);
    return i * 100003 + j;
  }

  private buildLotIndex(): void {
    for (let li = 0; li < this.layout.lots.length; li++) {
      const poly = this.layout.lots[li].polygon;
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
      const i0 = Math.floor(minX / this.lotCell);
      const i1 = Math.floor(maxX / this.lotCell);
      const j0 = Math.floor(minZ / this.lotCell);
      const j1 = Math.floor(maxZ / this.lotCell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * 100003 + j;
          let list = this.lotGrid.get(key);
          if (!list) this.lotGrid.set(key, (list = []));
          list.push(li);
        }
      }
    }
  }

  /** Numbers the QA harness and the debug overlay want. */
  stats(): Record<string, number> {
    const g = this.ground.stats;
    return {
      lots: this.layout.lots.length,
      blocks: this.layout.blocks.length,
      areas: this.layout.areas.length,
      pois: this.pois.length,
      roadNodes: this.roads.nodes.length,
      roadEdges: this.roads.edges.length,
      sidewalkNodes: this.sidewalks.nodes.length,
      groundMeshes: g.meshes,
      groundTriangles: g.triangles,
      colliderTriangles: g.colliderTriangles,
      groundBuildMs: g.buildMs,
      textures: this.textures.textureCount,
      layers: this.layers.length,
      timeOfDay: this._timeOfDay,
      seaLevel: SEA_LEVEL,
    };
  }
}

export { DISTRICT_BOUNDS, SEA_LEVEL };
