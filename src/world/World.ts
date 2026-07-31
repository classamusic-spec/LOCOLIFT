/**
 * Loco Lift — the world system.
 *
 * Owns the district: generates the layout, builds the ground and the collider,
 * and holds the shared texture and material libraries. Everything else in the
 * game reads the world through `WorldAPI`.
 *
 * The sun / sky / fog / weather rig lives in `src/fx` and is *delegated*, not
 * duplicated: `Lighting` owns the key light, fill, shadow camera, fog and the
 * street-lamp field; `Sky` owns the dome and the environment capture; `Weather`
 * owns rain, storms and the wet-surface drive. `World` keeps the public
 * surface (`setTimeOfDay`, `setWeather`, `sun`, `spawnPoint`, `registerLayer`)
 * exactly as it was so `main.ts` and every other system are unaffected.
 *
 * Later visual modules (buildings, props, vegetation) attach with
 * {@link World.registerLayer} and are built, updated and disposed by the world.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
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
import { Lighting } from '../fx/Lighting';
import { Sky } from '../fx/Sky';
import { Weather } from '../fx/Weather';
import type { SkyWeather } from '../fx/LightingPresets';
import { generateCityLayout, DISTRICT_BOUNDS, SEA_LEVEL } from './CityLayout';
import { Ground } from './Ground';
import { MaterialLibrary } from './Materials';
import { TextureFactory } from './TextureFactory';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

export type WeatherKind = SkyWeather;

/** Canonical hours the two "weather" shorthands jump the clock to (§4.2). */
const SUNSET_HOUR = 18.25;
const NIGHT_HOUR = 22.0;

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

  /* lighting / sky / weather rig — owned by src/fx, driven from here */
  readonly lighting: Lighting;
  readonly sky: Sky;
  readonly weatherFx: Weather;

  private _timeOfDay = 12;
  private _weather: WeatherKind = 'clear';

  /* lot lookup for isBlocked */
  private lotCell = 18;
  private lotGrid = new Map<number, number[]>();

  private poiMap = new Map<string, POI>();
  private layers: WorldLayer[] = [];
  private pending: Array<Promise<void>> = [];
  private unsubs: Array<() => void> = [];
  private disposed = false;

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

    /* --- lighting / sky / weather rig (src/fx) --- */
    this.lighting = new Lighting({
      scene: opts.scene,
      quality: opts.quality,
      roads: this.roads,
      materials: this.materials,
      groundHeight: (x, z) => layout.groundHeight(x, z),
    });
    this.root.add(this.lighting.group);

    this.sky = new Sky(opts.quality);
    this.root.add(this.sky.mesh);

    opts.scene.add(this.root);
    opts.scene.fog = this.lighting.fog;

    this.ground.build(layout, opts);
    this.root.add(this.ground.group);

    this.weatherFx = new Weather({
      materials: this.materials,
      lighting: this.lighting,
      quality: opts.quality,
      rng: this.rng,
    });
    this.registerLayer(this.weatherFx);

    this.lighting.focusOn(layout.spawn.pos);
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
    return this.lighting.sun;
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
   * `hours` in 0..24. Interpolates the §4.2 time-of-day presets and pushes the
   * result into the lighting rig, the sky dome and the post-processing state.
   */
  setTimeOfDay(hours: number): void {
    this._timeOfDay = ((hours % 24) + 24) % 24;
    this.lighting.setTimeOfDay(this._timeOfDay);
    this.sky.apply(this.lighting.state);
  }

  setWeather(kind: WeatherKind): void {
    this._weather = kind;
    if (kind === 'sunset') this.setTimeOfDay(SUNSET_HOUR);
    else if (kind === 'night') this.setTimeOfDay(NIGHT_HOUR);
    else this.setTimeOfDay(this._timeOfDay);
    // `false`: World is normally reacting to `weather:changed` already, and the
    // weather layer re-announces only when it changes state on its own.
    this.weatherFx.setKind(kind, false);
    this.sky.apply(this.lighting.state);
  }

  /* --------------------------------------------------------------- system */

  init(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('weather:changed', (e) => this.setWeather(e.kind as WeatherKind)),
    );
    this.weatherFx.attach(ctx);
    this.lighting.focusOn(this.layout.spawn.pos);
    this.setTimeOfDay(ctx.timeOfDay);
  }

  update(ctx: GameContext, dt: number): void {
    if (Math.abs(ctx.timeOfDay - this._timeOfDay) > 0.004) this.setTimeOfDay(ctx.timeOfDay);

    this.materials.update(dt);

    // Key light, fill, shadow-camera fit and the lamp pool.
    this.lighting.update(ctx, dt);

    // Layers (weather included) run next so a weather crossfade is already
    // folded into the lighting state before the sky reads it.
    const cam = ctx.camera;
    for (const layer of this.layers) layer.update?.(cam.position, dt, this._timeOfDay);

    this.sky.apply(this.lighting.state);
    this.sky.update(dt, cam, ctx.renderer, ctx.scene);
  }

  onQualityChange(tier: QualityTier, settings: SettingsState): void {
    this.quality = tier;
    this.lighting.onQualityChange(tier, settings);
    this.sky.onQualityChange(tier);
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
    this.sky.dispose();
    this.lighting.dispose();
    this.materials.dispose();
    this.textures.dispose();
    this.root.removeFromParent();
    this.root.clear();
    if (this.opts.scene.fog === this.lighting.fog) this.opts.scene.fog = null;
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
      ...this.lighting.stats(),
      ...this.weatherFx.stats(),
    };
  }
}

export { DISTRICT_BOUNDS, SEA_LEVEL };
