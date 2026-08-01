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
import { sharedWetness } from './Materials';
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
  /** triangles in the simplified far-LOD twins */
  farTriangles: number;
  drawCalls: number;
  buildMs: number;
  balconies: BalconyStats;
  roofs: RoofStats;
}

/**
 * Distance at which a block swaps to its flat twin. 130m is past the far kerb
 * of the widest street, so the detailed shell always covers anything the player
 * can read, and the swap happens behind intervening façades.
 */
const SHELL_LOD_DISTANCE = 130;

/**
 * The district finish block — see {@link Buildings.injectGlow}.
 *
 * `vColor` is `vec3` here and `vec4` under `USE_COLOR_ALPHA`; `.rgb` is a legal
 * swizzle on both, so the block does not care which the geometry supplied.
 */
const FACADE_FINISH_GLSL = /* glsl */ `
#include <lights_physical_fragment>
{
	// §5.1 up mask: a wall sheds, a cornice or an azotea deck holds water
	vec3 locoUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	float locoUp = clamp( dot( nonPerturbedNormal, locoUpV ) * 1.6 - 0.2, 0.0, 1.0 );
	float locoWet = clamp( uWetness, 0.0, 1.0 ) * mix( 0.30, 1.0, locoUp );

	// grime, damp and the §3.2 splash band are all darker *and* rougher
	float locoLum = clamp( dot( vColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 );
	material.roughness = clamp( material.roughness * ( 1.12 - 0.24 * locoLum ), 0.05, 1.0 );

	#ifdef USE_CLEARCOAT
		// atlas roughness *is* the material mask: paint, varnish, glaze and
		// glazed tile all live below 0.5, every masonry tile above 0.72
		float locoLacquer = 1.0 - smoothstep( 0.40, 0.72, material.roughness );
		material.clearcoat = clamp( locoLacquer * 0.5 + locoWet * 0.45, 0.0, 1.0 );
		material.clearcoatRoughness = max( 0.0525, mix( 0.20, 0.09, locoWet ) );
		clearcoatNormal = normalize( mix( normal, nonPerturbedNormal, locoWet * 0.7 ) );
	#endif

	// §5.1, verbatim: how far wet darkens is porosity, not taste. Lime render
	// drinks water and goes almost black; enamelled iron and a waxy leaf barely
	// change value at all, they just get glossier.
	float locoDarken = mix( 1.0, mix( 1.0, 0.35, uPorosity ), locoWet );
	material.diffuseColor *= locoDarken;
	material.diffuseContribution *= locoDarken;
	material.roughness = max( 0.06,
		mix( material.roughness, material.roughness * 0.22, locoWet * ( 0.35 + 0.65 * uPorosity ) ) );
}
`;

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
  /** simplified twin of each block, swapped in beyond `SHELL_LOD_DISTANCE` */
  private farMeshes: THREE.Mesh[] = [];
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
    farTriangles: 0,
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
      // LOD 1 flattens reveals, cornice profiles and applied trim and paints
      // the openings onto the wall instead. From the fort or the waterfront
      // the whole district is in frustum at once, and that detail is far below
      // a pixel — this is where the triangle count is actually won.
      const bFar = new GeomBuilder();
      let built = 0;

      for (const lotId of block.lots) {
        const lot = layout.lots[lotId];
        const plan = plans.get(lotId);
        if (!lot || !plan) continue;

        const tops = this.neighbourTops(lot, layout, plans);

        const t1 = b.triangleCount;
        composeFacade(plan, b, this.atlas, 0);
        const t2 = b.triangleCount;
        composeShell(plan, b, this.atlas, 0, tops);
        composeLightWell(plan, b, this.atlas);
        const t3 = b.triangleCount;
        roofs.place(plan, b);
        roofTris += b.triangleCount - t3;
        facadeTris += t2 - t1;
        massTris += t3 - t2;

        // Far shell: flat façade + mass only. No light wells (invisible from
        // outside at range) and no roof clutter.
        composeFacade(plan, bFar, this.atlas, 1);
        composeShell(plan, bFar, this.atlas, 1, tops);

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

      const geoFar = bFar.build();
      if (geoFar) {
        const far = new THREE.Mesh(geoFar, this.shellMat);
        far.name = `buildings/block${block.id}/far`;
        far.castShadow = false; // the near twin casts; far shadows are mush anyway
        far.receiveShadow = true;
        far.matrixAutoUpdate = false;
        far.updateMatrix();
        far.visible = false;
        this.group.add(far);
        this.farMeshes.push(far);
        this.ownedGeometries.push(geoFar);
        this._stats.farTriangles += geoFar.index ? geoFar.index.count / 3 : 0;
      }
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
      // computeBoundingSphere on an InstancedMesh spans every instance, which
      // is what the distance test needs; the geometry's own sphere is one part.
      m.computeBoundingSphere();
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

    /**
     * The single most valuable material in the game: one atlas draws every
     * façade in the district, so it is also the only place a clearcoat lobe
     * buys glass, azulejo, varnished doors and painted persianas all at once
     * (§5 asks for a coat on all four) for the price of one program.
     *
     * The mask is free. Every lacquered or glazed tile in the atlas sits below
     * 0.5 roughness and every masonry tile sits above 0.72, so the coat can be
     * keyed off the roughness the shader has already sampled — no extra map, no
     * extra texture fetch, no extra draw call.
     */
    const coat = this.quality !== 'low';
    this.shellMat = coat
      ? new THREE.MeshPhysicalMaterial({
          name: 'buildings/shell',
          map: this.atlas.map,
          normalMap: this.atlas.normalMap,
          roughnessMap: this.atlas.roughnessMap,
          vertexColors: true,
          roughness: 1,
          metalness: 0,
          envMapIntensity: 0.9,
          clearcoat: 0.5,
          clearcoatRoughness: 0.2,
        })
      : new THREE.MeshStandardMaterial({
          name: 'buildings/shell',
          map: this.atlas.map,
          normalMap: this.atlas.normalMap,
          roughnessMap: this.atlas.roughnessMap,
          vertexColors: true,
          roughness: 1,
          metalness: 0,
          envMapIntensity: 0.9,
        });
    // §5 — painted lime stucco wants nScale 0.35, not the implicit 1.0 that
    // §8.22 calls out as the reason procedural stucco reads as plastic.
    this.shellMat.normalScale.set(0.42, 0.42);
    this.injectGlow(this.shellMat, 'shell', 0.9);

    const tf = this.textures;
    /**
     * §5 wrought iron: rough 0.45, metal 0.35. `alphaTest` is not optional —
     * the balustrade band of the iron atlas is a cut-out, and an opaque
     * material renders its cleared pixels as solid black, which is what put a
     * continuous black band along every balcony line. Cutting instead of
     * blending also keeps the rails in the depth pre-pass and in the shadow
     * map, so a railing throws a railing's shadow.
     */
    const ironParams = {
      name: 'buildings/iron',
      map: ironTexture(tf),
      vertexColors: true,
      roughness: 0.45,
      metalness: 0.35,
      // painted iron is a metal under a coat of enamel: without a real
      // environment response a balcony is a black silhouette at every hour
      envMapIntensity: 1.0,
      alphaTest: 0.42,
      transparent: false,
      side: THREE.DoubleSide,
    };
    this.ironMat = coat
      ? new THREE.MeshPhysicalMaterial({ ...ironParams, clearcoat: 0.4, clearcoatRoughness: 0.22 })
      : new THREE.MeshStandardMaterial(ironParams);
    this.injectGlow(this.ironMat, 'iron', 0.1);

    // §5 foliage: 0.62. Balcony leaves are waxy, not chalk — they were the one
    // thing on the façade already reading as matte plastic.
    this.foliageMat = new THREE.MeshStandardMaterial({
      name: 'buildings/foliage',
      map: foliageTexture(tf),
      vertexColors: true,
      roughness: 0.66,
      metalness: 0,
      envMapIntensity: 0.7,
      transparent: true,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
    });
    this.injectGlow(this.foliageMat, 'foliage', 0.25);
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
   *
   * The same patch carries the district's **finish** pass, because it is the
   * only shader hook these materials have. Two things happen at
   * `<lights_physical_fragment>`, where the shading normal, the sampled
   * roughness and the whole `PhysicalMaterial` struct are simultaneously in
   * scope:
   *
   *  - **Spatial roughness.** `vColor` already carries every bit of §3.2
   *    weathering — the splash band, the drip streaks under sills, the
   *    per-building grime — and all of it is *rougher* than clean paint. Keying
   *    roughness off it makes the variation follow the dirt instead of being a
   *    second, unrelated wash of noise. Free: `vColor` is already a varying.
   *  - **Rain.** Buildings hold no `MaterialLibrary` reference, so they were the
   *    one district-scale surface rain never reached: the street went black and
   *    glossy while the walls above it stayed bone dry. Binding the shared
   *    wetness uniform fixes that, with the §5.1 up-facing mask so a vertical
   *    render only sheds and darkens (§5: albedo × 0.80) while cornices, sills,
   *    balcony slabs and azotea decks wet properly.
   */
  private injectGlow(mat: THREE.MeshStandardMaterial, tag: string, porosity: number): void {
    const coated = mat instanceof THREE.MeshPhysicalMaterial && mat.clearcoat > 0;
    const porosityUniform = { value: clamp01(porosity) };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.nightUniform;
      shader.uniforms.uWetness = sharedWetness;
      shader.uniforms.uPorosity = porosityUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_physical_fragment>', FACADE_FINISH_GLSL)
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform float uNight;',
            'uniform float uWetness;',
            'uniform float uPorosity;',
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
    // per-material, not a shared constant: the three façade programs differ only
    // in their injections, so one key for all of them would let three link
    // against whichever compiled first
    mat.customProgramCacheKey = () => `loco-glow|${tag}|${coated ? 'cc' : 'std'}`;
  }

  update(cameraPos: THREE.Vector3, _dt: number, timeOfDay: number): void {
    // Windows come on across dusk and go off across dawn.
    const dusk = smoothstep((timeOfDay - DUSK_START) / (DUSK_END - DUSK_START));
    const dawn = 1 - smoothstep((timeOfDay - DAWN_START) / (DAWN_END - DAWN_START));
    this.nightUniform.value = clamp01(Math.max(dusk, dawn));

    /* ---- distance culling ----
     * Three frustum-culls per mesh, but nothing drops a block that is merely
     * far away. From the waterfront or the fort the whole district is in
     * frustum at once, which is where the triangle count doubles. Blocks are
     * merged per city block, so their bounding spheres are large — we test
     * against the sphere edge, not its centre, or façades pop at the far kerb.
     */
    const budget = QUALITY_BUDGET[this.quality];
    const shellLimit = budget.drawDistance;
    const lodSwap = SHELL_LOD_DISTANCE;
    for (let i = 0; i < this.meshes.length; i++) {
      const near = this.meshes[i];
      const far = this.farMeshes[i];
      const s = near.geometry.boundingSphere;
      const d = s ? cameraPos.distanceTo(s.center) - s.radius : 0;
      const inRange = d < shellLimit;
      const useNear = d < lodSwap;
      near.visible = inRange && useNear;
      if (far) far.visible = inRange && !useNear;
    }
    // Instanced detail (balconies, pots, laundry) reads at much shorter range.
    const detailLimit = budget.propDetailDistance * 2.2;
    for (const m of this.instanced) {
      const s = m.boundingSphere ?? m.geometry.boundingSphere;
      m.visible = s ? cameraPos.distanceTo(s.center) - s.radius < detailLimit : true;
    }
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
    for (const m of this.farMeshes) m.removeFromParent();
    for (const m of this.instanced) {
      m.removeFromParent();
      m.dispose();
    }
    for (const g of this.ownedGeometries) g.dispose();
    this.meshes = [];
    this.farMeshes = [];
    this.instanced = [];
    this.ownedGeometries = [];
    this.shellMat?.dispose();
    this.ironMat?.dispose();
    this.foliageMat?.dispose();
    this.group.removeFromParent();
  }
}

