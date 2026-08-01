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
import { Buildings } from './Buildings';
import { Coast } from './Coast';
import { ElPerlo } from './ElPerlo';
import { PlazaLife } from './PlazaLife';
import { StreetDressing } from './StreetDressing';
import { Mountains } from './Mountains';
import { Pinones } from './Pinones';
import { CoastProps } from './CoastProps';
import { Ocean } from './Ocean';
import { Vegetation } from './Vegetation';
import { Ground } from './Ground';
import { MaterialLibrary } from './Materials';
import { TextureFactory } from './TextureFactory';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

export type WeatherKind = SkyWeather;

/** One row of the dev triangle census — see {@link World.installCensusHook}. */
interface CensusRow {
  group: string;
  /** meshes the main pass will submit */
  drawn: number;
  /** triangles those meshes carry (instance count folded in) */
  triangles: number;
  /** triangles the same group re-submits into the sun's shadow map */
  shadow: number;
  /** triangles skipped because a `visible` flag is false — i.e. LOD works */
  hidden: number;
  /** triangles skipped by frustum culling */
  culled: number;
  /** world-space centre and half-extent of the group, for picking viewpoints */
  box: [number, number, number, number, number, number];
}

/** Triangles a mesh submits, instance count folded in. */
function meshTris(m: THREE.Mesh & { count?: number; isInstancedMesh?: boolean }): number {
  const g = m.geometry;
  const t = g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
  return m.isInstancedMesh ? t * (m.count ?? 0) : t;
}

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
  readonly buildings: Buildings;
  readonly ocean: Ocean;
  readonly coast: Coast;

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
  /** last camera the world was updated against — the dev census reads it */
  private lastCamera: THREE.Camera | null = null;
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

    // Façades come before weather so the wetness pass sees the full district.
    this.buildings = new Buildings(opts.quality, this.textures);
    this.registerLayer(this.buildings);

    // Coastline. Ocean hides the flat placeholder sea mesh and restores it on
    // dispose; the four layers share a memoised model, so order is free.
    this.ocean = new Ocean(opts.quality);
    this.coast = new Coast(opts.quality);
    this.registerLayer(this.ocean);
    this.registerLayer(this.coast);
    this.registerLayer(new Vegetation(opts.quality));
    this.registerLayer(new CoastProps(opts.quality));

    // Distant cordillera first so it is behind everything, then the Pinones
    // chinchorro strip east along the coast.
    this.registerLayer(new Mountains(opts.quality));
    this.registerLayer(new Pinones(opts.quality));

    // El Perlo hangs on the seaward slope under the fort wall.
    this.registerLayer(new ElPerlo(opts.quality));

    // Street furniture and greenery last: both read the finished layout and
    // share the material library's wetness uniform so rain reaches them too.
    this.registerLayer(new PlazaLife(opts.quality, { materials: this.materials }));
    this.registerLayer(new StreetDressing(opts.quality, { materials: this.materials }));

    this.weatherFx = new Weather({
      materials: this.materials,
      lighting: this.lighting,
      quality: opts.quality,
      rng: this.rng,
    });
    this.registerLayer(this.weatherFx);

    this.lighting.focusOn(layout.spawn.pos);
    this.setTimeOfDay(12);

    if (import.meta.env.DEV) this.installCensusHook();
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

  /**
   * Per-group triangle census for the *current* camera, dev builds only.
   *
   * `window.__loco.sceneBreakdown()` counts everything that exists; this counts
   * what the main pass will actually submit — visibility flags and frustum
   * culling applied exactly the way `WebGLRenderer.projectObject` applies them.
   * That difference is the whole LOD story: a layer can hold 300k triangles and
   * cost nothing, or hold 300k and pay all of it from a rooftop.
   *
   * Guarded by `import.meta.env.DEV`, so it is statically dropped from the
   * shipped bundle along with the traversal below.
   */
  private installCensusHook(): void {
    const w = window as unknown as {
      __locoCensus?: () => CensusRow[];
      __locoWorldStats?: () => Record<string, number>;
      __locoMeshCensus?: (prefix: string) => Array<Record<string, number | string>>;
    };
    w.__locoWorldStats = (): Record<string, number> => this.stats();
    /* Mesh-level detail for one group. The aggregate census says *which* layer
     * costs; this says which mesh inside it, which is what a LOD pass needs. */
    w.__locoMeshCensus = (prefix: string): Array<Record<string, number | string>> => {
      const out: Array<Record<string, number | string>> = [];
      const collect = (o: THREE.Object3D): void => {
        const m = o as THREE.Mesh & { count?: number; isInstancedMesh?: boolean };
        if (m.isMesh && m.geometry && (m.name || '').startsWith(prefix)) {
          out.push({
            name: m.name,
            tris: Math.round(meshTris(m)),
            instances: m.count ?? 0,
            visible: m.visible ? 1 : 0,
            culled: m.frustumCulled ? 1 : 0,
            shadow: m.castShadow ? 1 : 0,
          });
        }
        for (const c of o.children) collect(c);
      };
      collect(this.opts.scene);
      out.sort((a, b) => (b.tris as number) - (a.tris as number));
      return out;
    };
    w.__locoCensus = (): CensusRow[] => {
      const cam = this.lastCamera;
      const rows: CensusRow[] = [];
      if (!cam) return rows;
      cam.updateMatrixWorld();
      const proj = new THREE.Matrix4().multiplyMatrices(
        cam.projectionMatrix,
        cam.matrixWorldInverse,
      );
      const frustum = new THREE.Frustum().setFromProjectionMatrix(proj);
      const sphere = new THREE.Sphere();

      /* The shadow map is a second full render of every caster inside the sun's
       * ortho box, and `renderer.info` folds it into the same triangle total the
       * budget is written against — at street level it is as expensive as the
       * main pass. Counting it separately is the only way to tell a layer that
       * is merely visible from one that is paid for twice. */
      const shadowCams: THREE.Camera[] = [];
      for (const l of [this.lighting.sun, this.lighting.sunFar]) {
        if (l.castShadow) shadowCams.push(l.shadow.camera);
      }
      const shadowFrusta = shadowCams.map((c) => {
        c.updateMatrixWorld();
        return new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse),
        );
      });

      const box = new THREE.Box3();
      const tally = (root: THREE.Object3D, label: string): void => {
        let drawn = 0;
        let tris = 0;
        let hiddenTris = 0;
        let culledTris = 0;
        let shadowTris = 0;
        box.makeEmpty();
        const walk = (o: THREE.Object3D): void => {
          if (!o.visible) {
            o.traverse((c) => {
              const cm = c as THREE.Mesh & { count?: number; isInstancedMesh?: boolean };
              if (cm.isMesh && cm.geometry) hiddenTris += meshTris(cm);
            });
            return;
          }
          const m = o as THREE.Mesh & {
            count?: number;
            isInstancedMesh?: boolean;
            boundingSphere?: THREE.Sphere | null;
          };
          if (m.isMesh && m.geometry) {
            const t = meshTris(m);
            let inFrustum = true;
            if (m.frustumCulled) {
              const src = m.isInstancedMesh
                ? (m.boundingSphere ?? null)
                : (m.geometry.boundingSphere ??
                  (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere));
              if (src) {
                sphere.copy(src).applyMatrix4(m.matrixWorld);
                inFrustum = frustum.intersectsSphere(sphere);
              }
            }
            const bs = m.isInstancedMesh ? m.boundingSphere : m.geometry.boundingSphere;
            if (bs) {
              sphere.copy(bs).applyMatrix4(m.matrixWorld);
              box.expandByPoint(sphere.center);
            }
            if (inFrustum) {
              drawn++;
              tris += t;
            } else {
              culledTris += t;
            }
            if (m.castShadow) {
              for (const f of shadowFrusta) {
                let hit = true;
                if (m.frustumCulled) {
                  const src = m.isInstancedMesh ? m.boundingSphere : m.geometry.boundingSphere;
                  if (src) {
                    sphere.copy(src).applyMatrix4(m.matrixWorld);
                    hit = f.intersectsSphere(sphere);
                  }
                }
                if (hit) shadowTris += t;
              }
            }
          }
          for (const c of o.children) walk(c);
        };
        walk(root);
        if (drawn > 0 || hiddenTris > 0 || culledTris > 0) {
          const r = (v: number): number => (Number.isFinite(v) ? Math.round(v) : 0);
          rows.push({
            group: label,
            drawn,
            triangles: Math.round(tris),
            shadow: Math.round(shadowTris),
            hidden: Math.round(hiddenTris),
            culled: Math.round(culledTris),
            box: [r(box.min.x), r(box.min.y), r(box.min.z), r(box.max.x), r(box.max.y), r(box.max.z)],
          });
        }
      };

      for (const child of this.opts.scene.children) {
        if (child === this.root) {
          for (const layer of child.children) tally(layer, layer.name || 'world/unnamed');
        } else {
          tally(child, child.name || child.type);
        }
      }
      rows.sort((a, b) => b.triangles - a.triangles);
      return rows;
    };
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
    this.lastCamera = cam;
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
    const b = this.buildings.stats;
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
      // Façades are ~65% of the district's triangles; the split between the
      // near shell, its flat twin and the instanced detail is the first thing
      // any budget triage needs.
      bldShellTris: b.shellTriangles,
      bldFacadeTris: b.facadeTriangles,
      bldMassTris: b.massTriangles,
      bldRoofTris: b.roofTriangles,
      bldFarTris: b.farTriangles,
      bldInstTris: b.instancedTriangles,
      bldInstances: b.instances,
      bldInstMeshes: b.instancedMeshes,
      ...this.lighting.stats(),
      ...this.weatherFx.stats(),
    };
  }
}

export { DISTRICT_BOUNDS, SEA_LEVEL };
