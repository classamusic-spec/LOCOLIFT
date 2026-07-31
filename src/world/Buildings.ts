/**
 * Loco Lift — the building layer.
 *
 * Composes the façade kit into the actual city: plans every lot, builds the
 * geometry, and merges it **per block** rather than per lot. There are 1102
 * lots; one mesh each would cost the entire draw-call budget before a single
 * prop existed, so the 51 blocks each collapse to one shell mesh, and every
 * repeated part (balconies, rails, planters, laundry) goes through one shared
 * instance registry.
 *
 * Night lighting is a per-vertex `aGlow` attribute rather than real lights —
 * a district of lit windows is thousands of emitters, which no forward
 * renderer will take. A single `uNight` uniform cross-fades them in at dusk.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import { clamp01, smoothstep } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { GeomBuilder, InstanceRegistry, type InstanceMaterial } from './BuildingKit';
import { BalconyFactory, foliageTexture, ironTexture, type BalconyStats } from './Balconies';
import {
  ColourBook,
  composeFacade,
  composeLightWell,
  composeShell,
  planLot,
  type BuildingPlan,
} from './Facades';
import { getFacadeAtlas, type FacadeAtlas } from './FacadeTextures';
import { Roofs, type RoofStats } from './Roofs';
import type { TextureFactory } from './TextureFactory';
import type { CityLayout, Lot, WorldLayer, WorldOpts } from './WorldTypes';

export interface BuildingStats {
  lots: number;
  blocks: number;
  shellMeshes: number;
  instancedMeshes: number;
  instances: number;
  triangles: number;
  /** triangles in the merged per-block shells */
  shellTriangles: number;
  /** triangles across every instance of every repeated part */
  instancedTriangles: number;
  /** shell split: street elevations / mass + courtyards / roofs */
  facadeTriangles: number;
  massTriangles: number;
  roofTriangles: number;
  drawCalls: number;
  buildMs: number;
  balconies: BalconyStats;
  roofs: RoofStats;
}

/** Hours over which lit windows fade in and out. */
const DUSK_START = 17.6;
const DUSK_END = 19.4;
const DAWN_START = 5.4;
const DAWN_END = 6.9;

export class Buildings implements WorldLayer {
  readonly name = 'buildings';
  readonly group = new THREE.Group();

  private atlas!: FacadeAtlas;
  private shellMat!: THREE.MeshStandardMaterial;
  private ironMat!: THREE.MeshStandardMaterial;
  private foliageMat!: THREE.MeshStandardMaterial;
  private nightUniform = { value: 0 };

  private meshes: THREE.Mesh[] = [];
  private instanced: THREE.InstancedMesh[] = [];
  private ownedGeometries: THREE.BufferGeometry[] = [];
  private quality: QualityTier;

  private _stats: BuildingStats = {
    lots: 0,
    blocks: 0,
    shellMeshes: 0,
    instancedMeshes: 0,
    instances: 0,
    triangles: 0,
    shellTriangles: 0,
    instancedTriangles: 0,
    facadeTriangles: 0,
    massTriangles: 0,
    roofTriangles: 0,
    drawCalls: 0,
    buildMs: 0,
    balconies: {
      balconies: 0,
      balconettes: 0,
      wooden: 0,
      plants: 0,
      laundry: 0,
      plantedFraction: 0,
    },
    roofs: { azoteas: 0, tiled: 0, tanks: 0, aerials: 0, bulkheads: 0, scuppers: 0, clotheslines: 0 },
  };

  constructor(quality: QualityTier, private textures: TextureFactory) {
    this.quality = quality;
    this.group.name = 'buildings';
  }

  get stats(): BuildingStats {
    return this._stats;
  }

  build(layout: CityLayout, opts: WorldOpts): void {
    const t0 = performance.now();
    void opts;

    this.atlas = getFacadeAtlas(this.textures, this.quality);
    this.makeMaterials();

    /* ---------------- pass 1: plan every lot ---------------- */
    const plans = new Map<number, BuildingPlan>();
    const colours = new ColourBook();
    const muralBudget = { left: 8 };

    for (const block of layout.blocks) {
      colours.reset();
      let prevParapet = 0;
      const lots = block.lots;
      for (let i = 0; i < lots.length; i++) {
        const lot = layout.lots[lots[i]];
        if (!lot) continue;
        const plan = planLot({
          lot,
          atlas: this.atlas,
          colours,
          groundHeight: (x, z) => layout.groundHeight(x, z),
          prevParapet,
          muralBudget,
          cornerStart: i === 0,
          cornerEnd: i === lots.length - 1,
        });
        plans.set(lot.id, plan);
        prevParapet = plan.topY + plan.parapetH;
      }
    }

    /* ---------------- pass 2: geometry, merged per block ---------------- */
    const registry = new InstanceRegistry(layout.bounds, 4, 3);
    const balconies = new BalconyFactory(registry, this.atlas);
    const roofs = new Roofs(registry, this.atlas, balconies);

    let shellTris = 0;
    let facadeTris = 0;
    let massTris = 0;
    let roofTris = 0;
    for (const block of layout.blocks) {
      const b = new GeomBuilder();
      let built = 0;

      for (const lotId of block.lots) {
        const lot = layout.lots[lotId];
        const plan = plans.get(lotId);
        if (!lot || !plan) continue;

        const t1 = b.triangleCount;
        composeFacade(plan, b, this.atlas, 0);
        const t2 = b.triangleCount;
        composeShell(plan, b, this.atlas, 0, this.neighbourTops(lot, layout, plans));
        composeLightWell(plan, b, this.atlas);
        const t3 = b.triangleCount;
        roofs.place(plan, b);
        roofTris += b.triangleCount - t3;
        facadeTris += t2 - t1;
        massTris += t3 - t2;
        balconies.place(plan);
        built++;
      }

      if (built === 0) continue;
      const geo = b.build();
      if (!geo) continue;

      const mesh = new THREE.Mesh(geo, this.shellMat);
      mesh.name = `buildings/block${block.id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.ownedGeometries.push(geo);
      shellTris += geo.index ? geo.index.count / 3 : 0;
      this._stats.lots += built;
    }

    /* ---------------- instanced detail ---------------- */
    const instMats: Record<InstanceMaterial, THREE.Material> = {
      atlas: this.shellMat,
      iron: this.ironMat,
      foliage: this.foliageMat,
    };
    this.instanced = registry.build(instMats);
    let instTris = 0;
    for (const m of this.instanced) {
      this.group.add(m);
      const g = m.geometry;
      instTris += (g.index ? g.index.count / 3 : 0) * m.count;
    }

    this._stats.blocks = this.meshes.length;
    this._stats.shellMeshes = this.meshes.length;
    this._stats.instancedMeshes = this.instanced.length;
    this._stats.instances = registry.instanceCount;
    this._stats.shellTriangles = Math.round(shellTris);
    this._stats.facadeTriangles = facadeTris;
    this._stats.massTriangles = massTris;
    this._stats.roofTriangles = roofTris;
    this._stats.instancedTriangles = Math.round(instTris);
    this._stats.triangles = Math.round(shellTris + instTris);
    this._stats.drawCalls = this.meshes.length + this.instanced.length;
    this._stats.balconies = balconies.results;
    this._stats.roofs = roofs.stats;
    this._stats.buildMs = Math.round(performance.now() - t0);
  }

  /**
   * `composeShell` skips party walls below a neighbour's roofline, so it needs
   * the neighbour's top height for each polygon edge. Edges without a
   * neighbour get 0 and are drawn in full.
   */
  private neighbourTops(
    lot: Lot,
    layout: CityLayout,
    plans: Map<number, BuildingPlan>,
  ): number[] {
    const n = lot.polygon.length;
    const tops = new Array<number>(n).fill(0);
    if (lot.neighbours.length === 0) return tops;

    for (let e = 0; e < n; e++) {
      const a = lot.polygon[e];
      const c = lot.polygon[(e + 1) % n];
      const mx = (a.x + c.x) * 0.5;
      const mz = (a.y + c.y) * 0.5;

      let best = 0;
      for (const nb of lot.neighbours) {
        const other = layout.lots[nb];
        const otherPlan = plans.get(nb);
        if (!other || !otherPlan) continue;
        // A shared party wall means the neighbour has an edge whose midpoint
        // coincides with ours; 12cm covers float drift in the layout.
        const m = other.polygon.length;
        for (let f = 0; f < m; f++) {
          const p = other.polygon[f];
          const q = other.polygon[(f + 1) % m];
          const ox = (p.x + q.x) * 0.5;
          const oz = (p.y + q.y) * 0.5;
          if (Math.abs(ox - mx) < 0.12 && Math.abs(oz - mz) < 0.12) {
            best = Math.max(best, otherPlan.topY + otherPlan.parapetH);
            break;
          }
        }
      }
      tops[e] = best;
    }
    return tops;
  }

  private makeMaterials(): void {
    const aniso = QUALITY_BUDGET[this.quality].anisotropy;
    for (const t of [this.atlas.map, this.atlas.normalMap, this.atlas.roughnessMap]) {
      t.anisotropy = aniso;
    }

    this.shellMat = new THREE.MeshStandardMaterial({
      name: 'buildings/shell',
      map: this.atlas.map,
      normalMap: this.atlas.normalMap,
      roughnessMap: this.atlas.roughnessMap,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    // §5 — painted lime stucco wants nScale 0.35, not the implicit 1.0 that
    // §8.22 calls out as the reason procedural stucco reads as plastic.
    this.shellMat.normalScale.set(0.42, 0.42);
    this.injectGlow(this.shellMat);

    const tf = this.textures;
    /**
     * §5 wrought iron: rough 0.45, metal 0.35. `alphaTest` is not optional —
     * the balustrade band of the iron atlas is a cut-out, and an opaque
     * material renders its cleared pixels as solid black, which is what put a
     * continuous black band along every balcony line. Cutting instead of
     * blending also keeps the rails in the depth pre-pass and in the shadow
     * map, so a railing throws a railing's shadow.
     */
    this.ironMat = new THREE.MeshStandardMaterial({
      name: 'buildings/iron',
      map: ironTexture(tf),
      vertexColors: true,
      roughness: 0.45,
      metalness: 0.35,
      alphaTest: 0.42,
      transparent: false,
      side: THREE.DoubleSide,
    });
    this.injectGlow(this.ironMat);

    this.foliageMat = new THREE.MeshStandardMaterial({
      name: 'buildings/foliage',
      map: foliageTexture(tf),
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
    });
    this.injectGlow(this.foliageMat);
  }

  /**
   * Adds the per-vertex `aGlow` emissive channel, scaled by `uNight`. Doing it
   * in the shader keeps one material for the whole district while still
   * letting individual windows light up.
   *
   * `aGlow` is **not** a colour. It packs `(intensity, warmth, phase)`, and it
   * has to be resolved into one: adding the triple to `gl_FragColor.rgb`
   * directly turns a window with warmth 0.1 into a saturated red rectangle and
   * a window with phase 0.9 into magenta — a street of neon that breaks §4.3's
   * warm/cool lamp spec outright and crowds the reserved gameplay hues (§3.6).
   * Here `warmth` picks between a 2700 K bulb and a cool fluorescent, and
   * `phase` gives each building its own brightness so the district does not
   * switch on as one flat sheet (§8.45).
   */
  private injectGlow(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.nightUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform float uNight;',
            'varying vec3 vGlow;',
            'const vec3 LAMP_WARM = vec3(1.0, 0.66, 0.33);',
            'const vec3 LAMP_COOL = vec3(0.78, 0.87, 1.0);',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'vec3 lampCol = mix(LAMP_WARM, LAMP_COOL, clamp(vGlow.y, 0.0, 1.0));',
            'float lampAmp = vGlow.x * (0.72 + 0.5 * vGlow.z);',
            'gl_FragColor.rgb += lampCol * lampAmp * uNight;',
            '#include <dithering_fragment>',
          ].join('\n\t'),
        );
    };
    mat.customProgramCacheKey = () => 'loco-glow';
  }

  update(_cameraPos: THREE.Vector3, _dt: number, timeOfDay: number): void {
    // Windows come on across dusk and go off across dawn.
    const dusk = smoothstep((timeOfDay - DUSK_START) / (DUSK_END - DUSK_START));
    const dawn = 1 - smoothstep((timeOfDay - DAWN_START) / (DAWN_END - DAWN_START));
    this.nightUniform.value = clamp01(Math.max(dusk, dawn));
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const aniso = QUALITY_BUDGET[tier].anisotropy;
    if (!this.atlas) return;
    for (const t of [this.atlas.map, this.atlas.normalMap, this.atlas.roughnessMap]) {
      t.anisotropy = aniso;
      t.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.removeFromParent();
    for (const m of this.instanced) {
      m.removeFromParent();
      m.dispose();
    }
    for (const g of this.ownedGeometries) g.dispose();
    this.meshes = [];
    this.instanced = [];
    this.ownedGeometries = [];
    this.shellMat?.dispose();
    this.ironMat?.dispose();
    this.foliageMat?.dispose();
    this.group.removeFromParent();
  }
}

