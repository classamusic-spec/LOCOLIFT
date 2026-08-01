/**
 * Loco Lift — coastal planting.
 *
 * Palms first, because a Caribbean seafront is a palm silhouette and nothing
 * else will substitute for it. The palms here are real geometry, not billboards:
 *
 *  - **Trunks** are swept along a curved spine with a leaning base, a taper and
 *    per-ring radius jitter that reads as the stacked leaf-scar rings of a
 *    coconut palm. Six baked variants, each instanced, so a hundred palms lean
 *    six different ways for six draw calls.
 *  - **Fronds** are V-folded ribbons — a rachis with the two pinnae banks
 *    hinged down off it, which is what gives a palm frond its section and stops
 *    it reading as a flat cut-out when you drive under one. The leaflet comb is
 *    an alpha-tested canvas texture; `side: DoubleSide`, `alphaTest 0.4` per §5.
 *  - **Wind** is entirely in the vertex shader (§5, 0.35 Hz): trunks bend from
 *    the base, fronds add a secondary flutter that scales with distance out
 *    along the rachis, and every instance carries its own phase so a stand of
 *    palms never breathes in unison.
 *
 * Around them: sea grape (*uva de playa*) hugging the dune line, sea almond
 * (*almendro*) with its horizontally tiered branching, and flowering
 * bougainvillea and hibiscus against the seawall — the magenta and coral that
 * §3.2 wants doing the work the buildings cannot do out here.
 *
 * Everything is instanced. Placement is driven by the shared {@link CoastModel}
 * so the planting follows the real waterline, and by the road network so the
 * malecón gets its avenue of royals.
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { QualityTier } from '../core/types';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RNG, valueNoise2D } from '../core/RNG';
import { SEA_LEVEL } from './CityLayout';
import { coastModel, sampleSpan, GeoBuilder, COAST_DENSITY } from './Coast';
import type { CoastModel } from './Coast';
import { LodField, bucketByCell, bucketFootprint } from './LodGrid';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------------ tuning */

/** §1.9 — coconut palm: 0.35 trunk, 9.0 clear, 13.0 total, leaning 8–18°. */
const COCONUT = {
  height: [9.5, 14.5] as const,
  baseR: 0.26,
  topR: 0.15,
  lean: [8, 18] as const,
  fronds: [9, 13] as const,
  frondLen: [3.4, 4.4] as const,
};

/** §1.9 — palma real: 0.45 trunk, 13.0 clear, 18.0 total, straight, crownshaft. */
const ROYAL = {
  height: [13, 18.5] as const,
  baseR: 0.34,
  topR: 0.21,
  lean: [0, 4] as const,
  fronds: [11, 15] as const,
  frondLen: [3.8, 5.0] as const,
};

/**
 * Per-tier geometry budget.
 *
 * Fronds dominate — a palm is ~11 of them and there are hundreds of palms —
 * so the frond's segment count is the single most effective knob on the whole
 * layer. Trunk variety is cheap in triangles but costs a draw call each, so it
 * comes down on `low` too.
 */
const TIER_DETAIL: Record<
  QualityTier,
  { trunkVariants: number; frondSegments: number; trunkRings: number }
> = {
  low: { trunkVariants: 3, frondSegments: 5, trunkRings: 7 },
  medium: { trunkVariants: 4, frondSegments: 7, trunkRings: 9 },
  high: { trunkVariants: 6, frondSegments: 9, trunkRings: 11 },
  ultra: { trunkVariants: 6, frondSegments: 11, trunkRings: 13 },
};

/**
 * Segments in the **far** frond. A frond is a V of two pinnae banks either side
 * of a rachis; the segment count controls how finely the arch and the taper are
 * sampled along it, and past {@link PALM_LOD_DISTANCE} the whole frond is a few
 * pixels across, so three segments carry the same silhouette for a third of the
 * triangles. The leaflet comb is in the alpha texture either way.
 */
const FROND_FAR_SEGMENTS = 3;

/**
 * Cell size for the planting grid, metres.
 *
 * Palms live on lines — the malecón, the dune, the dock apron — so a grid over
 * them yields roughly one cell per cell-length of shoreline. Coarse on purpose:
 * every extra cell is up to `trunkVariants` more draw calls, and the win here
 * is frustum culling a whole stand, which a 240 m cell already delivers.
 */
const PALM_CELL = 240;

/** Cell size for the understorey, which is denser and much cheaper per mesh. */
const SHRUB_CELL = 180;

/**
 * Distance at which a stand of palms swaps to its far fronds, metres. Well past
 * the far kerb of any street, and past the cell radius, so the swap happens to
 * a stand that is already small in frame rather than to one the player is
 * driving through.
 */
const PALM_LOD_DISTANCE = 170;

/** Slack on a cell footprint: crown radius plus the wind shader's reach. */
const PALM_SPREAD = 8;
const SHRUB_SPREAD = 4;

/* colours, all sRGB */
const C = {
  trunkCoconut: 0x9a8a72,
  trunkRoyal: 0xc9c6b6,
  crownshaft: 0x5f7a3a,
  frondDark: 0x2f5e29,
  frondMid: 0x487f30,
  frondLit: 0x7aa93c,
  coconut: 0x7c6a44,
  seagrapeLeaf: 0x6f9a4a,
  seagrapeWood: 0x6e5c46,
  almondLeaf: 0x5f9741,
  almondWood: 0x6a5a48,
  bougainvillea: [0xd6217a, 0xe8563f, 0xf4f0e6, 0xb43fa8] as const,
  hibiscus: [0xe02b26, 0xf2557e, 0xf6a01f] as const,
  shrub: 0x4c7a34,
} as const;

/* ------------------------------------------------------------------ shader */

/**
 * Wind, shared by every plant material.
 *
 * Per **vertex**, `aWind`: x = sway weight (0 at the anchor, 1 at the free
 * tip), y = flutter weight, z = phase offset within the plant.
 *
 * Per **instance**, `aInst`: x = phase, y = stiffness. This is a dedicated
 * `InstancedBufferAttribute` rather than `instanceColor`, because three folds
 * `instanceColor` straight into `vColor` and it would tint the foliage — every
 * geometry here is owned by exactly one `InstancedMesh`, so attaching the
 * attribute to the geometry is safe.
 */
const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
attribute vec3 aWind;
#ifdef USE_INSTANCING
  attribute vec2 aInst;
#endif

vec3 locoWind( vec3 transformed, vec3 worldAnchor, float phase, float stiff ) {
  float t = uTime;
  // §5: 0.35 Hz primary sway, with a slow gust envelope on top
  float gust = 0.62 + 0.38 * sin( t * 0.19 + worldAnchor.x * 0.021 + worldAnchor.z * 0.017 );
  float sway = sin( t * 2.199 + phase ) * 0.62 + sin( t * 1.31 + phase * 1.7 ) * 0.38;
  float flut = sin( t * 6.7 + phase * 3.1 + aWind.z * 6.283 ) * 0.5
             + sin( t * 4.3 + phase * 2.2 + aWind.z * 11.0 ) * 0.5;

  float amp = uWindStrength * gust * stiff;
  vec3 out_ = transformed;
  out_.xz += uWindDir * ( sway * aWind.x * amp );
  // the tip also drops as it is pushed, which is what sells a bending stem
  out_.y -= aWind.x * aWind.x * abs( sway ) * amp * 0.35;
  out_.xz += uWindDir.yx * vec2( 1.0, -1.0 ) * ( flut * aWind.y * amp * 0.55 );
  out_.y += flut * aWind.y * amp * 0.42;
  return out_;
}
`;

interface WindUniforms {
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uWindStrength: { value: number };
}

/** The `begin_vertex` patch that applies the wind. Shared by every plant. */
const WIND_BEGIN = [
  '#include <begin_vertex>',
  '#ifdef USE_INSTANCING',
  '  vec3 locoAnchor = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
  '  transformed = locoWind( transformed, locoAnchor, aInst.x * 62.83, aInst.y );',
  '#else',
  '  vec3 locoAnchor = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
  '  transformed = locoWind( transformed, locoAnchor, locoAnchor.x * 0.7 + locoAnchor.z * 0.4, 1.0 );',
  '#endif',
].join('\n');

/** Patches a standard material with the wind rig. */
function patchWind(
  mat: THREE.MeshStandardMaterial,
  uniforms: WindUniforms,
  key: string,
): THREE.MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
      .replace('#include <begin_vertex>', WIND_BEGIN);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * Attaches the per-instance wind data. Call once per `InstancedMesh`; the
 * geometry must not be shared with another mesh.
 */
function setInstanceWind(
  mesh: THREE.InstancedMesh,
  phase: Float32Array,
  stiffness: Float32Array,
): void {
  const data = new Float32Array(mesh.count * 2);
  for (let i = 0; i < mesh.count; i++) {
    data[i * 2] = phase[i];
    data[i * 2 + 1] = stiffness[i];
  }
  mesh.geometry.setAttribute('aInst', new THREE.InstancedBufferAttribute(data, 2));
}

/* ------------------------------------------------------------------ layer */

export interface VegetationOptions {
  /** multiplier on every scatter count */
  density?: number;
  /** metres per second, drives the wind amplitude */
  wind?: number;
}

export class Vegetation implements WorldLayer {
  readonly name = 'vegetation';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: VegetationOptions;

  private uniforms: WindUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.82, -0.57) },
    uWindStrength: { value: 0.5 },
  };

  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  /** palms and shade trees — silhouette, so they hold out to `drawDistance` */
  private lodTall = new LodField();
  /** dune tufts and flowering shrubs — sub-pixel long before the palms are */
  private lodSmall = new LodField();
  /** per-cell frond LOD pairs, swapped at {@link PALM_LOD_DISTANCE} */
  private palmLod: Array<{
    near: THREE.InstancedMesh;
    far: THREE.InstancedMesh;
    cx: number;
    cz: number;
    radius: number;
  }> = [];
  private _stats = { palms: 0, shrubs: 0, triangles: 0, instances: 0 };

  constructor(quality: QualityTier, options: VegetationOptions = {}) {
    this.quality = quality;
    this.options = { density: 1, wind: 1, ...options };
    this.group.name = 'world/vegetation';
    this.uniforms.uWindStrength.value = 0.68 * (this.options.wind ?? 1);
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    const model = coastModel(layout);
    const rng = opts.rng.fork(0x7e6e);
    const density = COAST_DENSITY[this.quality] * (this.options.density ?? 1);

    const sites = this.plantPalms(model, layout, rng, density);
    this.buildPalmMeshes(sites, rng);
    this.buildUnderstorey(model, layout, rng, density);
  }

  /* --------------------------------------------------- palm distribution */

  private plantPalms(
    model: CoastModel,
    layout: CityLayout,
    rng: RNG,
    density: number,
  ): PalmSite[] {
    const sites: PalmSite[] = [];
    const occupied: Array<{ x: number; z: number; r: number }> = [];

    const free = (x: number, z: number, r: number): boolean => {
      for (const o of occupied) {
        const dr = o.r + r;
        if ((o.x - x) ** 2 + (o.z - z) ** 2 < dr * dr) return false;
      }
      return true;
    };
    const claim = (x: number, z: number, r: number): void => {
      occupied.push({ x, z, r });
    };

    /* --- 1. the malecón avenue: royals down the sea side of the corniche --- */
    const prom = model.promenade;
    if (prom.length > 4) {
      const total = prom[prom.length - 1].s;
      const spacing = 17;
      for (let s = 6; s < total - 6; s += spacing) {
        const p = model.promenadeAtS(s);
        if (!p) continue;
        // stand them behind the parapet, on the landward pavement
        const off = 2.1 + rng.range(-0.35, 0.35);
        const x = p.x - p.nx * off + rng.range(-0.6, 0.6);
        const z = p.z - p.nz * off + rng.range(-0.6, 0.6);
        if (model.distToRamp(x, z) < 10) continue;
        if (!free(x, z, 4)) continue;
        claim(x, z, 4);
        sites.push(makeSite('royal', x, layout.groundHeight(x, z), z, rng));
      }
      // and a looser second rank of coconuts, staggered, on the sea side
      for (let s = 14; s < total - 6; s += spacing * 1.6) {
        const p = model.promenadeAtS(s);
        if (!p) continue;
        const off = rng.range(6, 15);
        const x = p.x + p.nx * off + rng.range(-2.5, 2.5);
        const z = p.z + p.nz * off + rng.range(-2.5, 2.5);
        const y = model.beachHeight(x, z);
        if (y < SEA_LEVEL + 1.6) continue;
        if (model.distToRamp(x, z) < 12) continue;
        if (!free(x, z, 5)) continue;
        claim(x, z, 5);
        sites.push(makeSite('coconut', x, y, z, rng));
      }
    }

    /* --- 2. the beach itself: leaning coconuts, clustered, never in a row --- */
    for (const span of model.spans) {
      const clusters = Math.max(2, Math.round((span.length / 26) * density));
      for (let c = 0; c < clusters; c++) {
        const s = rng.range(6, span.length - 6);
        const stn = sampleSpan(span.stations, s);
        if (stn.dock) continue;
        const n = rng.int(2, 5);
        const cx = stn.x - stn.nx * rng.range(10, Math.max(14, stn.width * 0.62));
        const cz = stn.z - stn.nz * rng.range(10, Math.max(14, stn.width * 0.62));
        for (let i = 0; i < n; i++) {
          const x = cx + rng.gaussian() * 4.2;
          const z = cz + rng.gaussian() * 4.2;
          const y = model.beachHeight(x, z);
          // above the wet line, below the promenade wall
          if (y < SEA_LEVEL + 1.2 || y > stn.inlandY + 0.9) continue;
          if (model.distToRamp(x, z) < 11) continue;
          if (!free(x, z, 3.4)) continue;
          claim(x, z, 3.4);
          sites.push(makeSite('coconut', x, y, z, rng));
        }
      }
    }

    /* --- 3. plazas and open areas: §1.9 wants green islands, not streets --- */
    for (const area of layout.areas) {
      if (area.surface === 'asphalt') continue;
      const poly = area.polygon;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of poly) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.y);
        maxZ = Math.max(maxZ, p.y);
      }
      const area2 = Math.abs((maxX - minX) * (maxZ - minZ));
      const want = Math.round(clamp(area2 / 620, 2, 16) * density);
      const species = area.zone === 'waterfront' ? 'coconut' : 'royal';
      let tries = 0;
      let placed = 0;
      while (placed < want && tries < want * 22) {
        tries++;
        const x = rng.range(minX, maxX);
        const z = rng.range(minZ, maxZ);
        if (!pointInPoly(poly, x, z)) continue;
        // keep the middle of a plaza clear — trees ring the edge (§1.9)
        const edge = edgeDistance(poly, x, z);
        if (edge < 3 || edge > 13) continue;
        if (!free(x, z, 6.5)) continue;
        claim(x, z, 6.5);
        placed++;
        sites.push(makeSite(species, x, layout.groundHeight(x, z), z, rng));
      }
    }

    /* --- 4. the dock apron edge: a formal double row of royals --- */
    const apron = model.apron;
    if (apron) {
      let minX = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const p of apron.polygon) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        maxZ = Math.max(maxZ, p.y);
      }
      for (let x = minX + 10; x < maxX - 10; x += 21) {
        for (const dz of [3.5, -1.5]) {
          const px = x + rng.range(-1, 1);
          const pz = maxZ + dz;
          if (!free(px, pz, 5)) continue;
          claim(px, pz, 5);
          sites.push(makeSite('royal', px, layout.groundHeight(px, pz), pz, rng));
        }
      }
    }

    return sites;
  }

  /* ----------------------------------------------------------- palm build */

  private buildPalmMeshes(sites: PalmSite[], rng: RNG): void {
    if (sites.length === 0) return;

    const detail = TIER_DETAIL[this.quality];

    /* --- trunks: one baked sweep per variant per species --- */
    const trunkMat = patchWind(
      new THREE.MeshStandardMaterial({
        name: 'loco/palmTrunk',
        vertexColors: true,
        roughness: 0.88,
        metalness: 0,
        envMapIntensity: 0.72,
      }),
      this.uniforms,
      'loco/veg-solid-v1',
    );
    this.materials.push(trunkMat);

    const frondTex = frondTexture();
    this.textures.push(frondTex);
    const frondMat = patchWind(
      new THREE.MeshStandardMaterial({
        name: 'loco/palmFrond',
        map: frondTex,
        vertexColors: true,
        roughness: 0.62,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0.4,
        envMapIntensity: 0.6,
      }),
      this.uniforms,
      'loco/veg-alpha-v1',
    );
    this.materials.push(frondMat);

    for (const species of ['coconut', 'royal'] as PalmSpecies[]) {
      const list = sites.filter((s) => s.species === species);
      if (list.length === 0) continue;
      const spec = species === 'coconut' ? COCONUT : ROYAL;

      // one trunk geometry per variant; frond geometry is shared across the
      // species and simply instanced once per frond per palm
      const trunkGeos: THREE.BufferGeometry[] = [];
      const crowns: THREE.Vector3[] = [];
      const crownTilt: THREE.Quaternion[] = [];
      for (let v = 0; v < detail.trunkVariants; v++) {
        const vr = rng.fork(v * 7919 + (species === 'coconut' ? 11 : 29));
        const built = buildTrunk(species, spec, vr, detail.trunkRings);
        trunkGeos.push(built.geo);
        crowns.push(built.crown);
        crownTilt.push(built.tilt);
      }

      /* One `InstancedMesh` per (variant, cell) rather than per variant.
       *
       * A single mesh holding every royal palm in the district has a bounding
       * sphere the size of the district, so three can never frustum-cull it —
       * in the main pass or in the sun's shadow pass — and it is drawn in full
       * from the fort, from Piñones, and from inside a courtyard with no palm
       * in sight. Cells give each stand its own sphere. */
      const cells = bucketByCell(list, PALM_CELL, (s) => s);
      const nearFronds = buildFrond(detail.frondSegments);
      const farFronds = buildFrond(FROND_FAR_SEGMENTS);
      this.geometries.push(nearFronds, farFronds);

      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const foot = bucketFootprint(cell, PALM_SPREAD);

        const byVariant: PalmSite[][] = trunkGeos.map(() => []);
        for (const s of cell.items) byVariant[s.variant % detail.trunkVariants].push(s);

        for (let v = 0; v < detail.trunkVariants; v++) {
          const b = byVariant[v];
          if (b.length === 0) continue;
          // `applyPalmInstances` attaches per-instance wind to the geometry, so
          // each cell's mesh needs its own copy of it.
          const geo = trunkGeos[v].clone();
          const mesh = new THREE.InstancedMesh(geo, trunkMat, b.length);
          mesh.name = `veg/${species}Trunk${v}/${c}`;
          applyPalmInstances(mesh, b, 0.55);
          this.addInstanced(mesh, geo);
          this.lodTall.add(mesh, foot.cx, foot.cz, foot.radius);
        }

        /* --- fronds, near and far --- */
        const near = this.buildFrondMesh(
          cell.items,
          crowns,
          crownTilt,
          detail.trunkVariants,
          nearFronds.clone(),
          frondMat,
          `veg/${species}Fronds/${c}`,
        );
        const far = this.buildFrondMesh(
          cell.items,
          crowns,
          crownTilt,
          detail.trunkVariants,
          farFronds.clone(),
          frondMat,
          `veg/${species}Fronds/${c}/far`,
        );
        if (near && far) {
          far.visible = false;
          this.palmLod.push({ near, far, cx: foot.cx, cz: foot.cz, radius: foot.radius });
          this.lodTall.add(near, foot.cx, foot.cz, foot.radius);
          this.lodTall.add(far, foot.cx, foot.cz, foot.radius);
        }
      }
      for (const g of trunkGeos) g.dispose();
      this._stats.palms += list.length;
    }
  }

  /**
   * The crown of fronds for one stand of palms, at whichever frond geometry is
   * handed in. Near and far LODs differ only in that geometry — same crown
   * positions, same droop, same per-frond wind phase — so a swap moves nothing
   * on screen except the number of segments the arch is sampled at.
   */
  private buildFrondMesh(
    list: readonly PalmSite[],
    crowns: readonly THREE.Vector3[],
    crownTilt: readonly THREE.Quaternion[],
    variants: number,
    frondGeo: THREE.BufferGeometry,
    frondMat: THREE.Material,
    name: string,
  ): THREE.InstancedMesh | null {
    const frondCount = list.reduce((n, s) => n + s.fronds, 0);
    if (frondCount === 0) {
      frondGeo.dispose();
      return null;
    }
    const fronds = new THREE.InstancedMesh(frondGeo, frondMat, frondCount);
    fronds.name = name;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yawQ = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const base = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const euler = new THREE.Euler();
    const fPhase = new Float32Array(frondCount);
    const fStiff = new Float32Array(frondCount);
    let k = 0;
    for (const s of list) {
      const crown = crowns[s.variant % variants];
      const tilt = crownTilt[s.variant % variants];
      yawQ.setFromAxisAngle(UP, s.yaw);
      pos.copy(crown).multiplyScalar(s.scale);
      pos.applyAxisAngle(UP, s.yaw);
      pos.add(base.set(s.x, s.y, s.z));
      for (let f = 0; f < s.fronds; f++) {
        const a = (f / s.fronds) * Math.PI * 2 + s.frondPhase;
        // droop: the outer fronds hang, the newest ones stand up
        const age = (f * 0.618033) % 1;
        const droop = lerp(-0.16, 0.86, age) + s.droopBias;
        // world = instance yaw * crown tilt * frond. The tilt is authored in
        // the trunk's own space, so it has to be applied *inside* the yaw or
        // every palm leans the same way regardless of which way it faces.
        euler.set(droop, a, 0, 'YXZ');
        q.setFromEuler(euler);
        q.premultiply(tilt);
        q.premultiply(yawQ);
        const len = lerp(s.frondLen[0], s.frondLen[1], (f * 0.37) % 1) * s.scale;
        // §1.9: a coconut frond is 4–5 m long and a little over a metre wide
        scl.set(len * 0.2, len, len);
        m.compose(pos, q, scl);
        fronds.setMatrixAt(k, m);
        // fronds are floppier than trunks, and every one gets its own phase
        fPhase[k] = (s.phase + f * 0.11) % 1;
        fStiff[k] = 0.75 + ((f * 0.29) % 1) * 0.55;
        k++;
      }
    }
    fronds.instanceMatrix.needsUpdate = true;
    setInstanceWind(fronds, fPhase, fStiff);
    this.addInstanced(fronds, frondGeo);
    return fronds;
  }

  /* -------------------------------------------------------- understorey */

  private buildUnderstorey(
    model: CoastModel,
    layout: CityLayout,
    rng: RNG,
    density: number,
  ): void {
    const leafTex = leafTexture();
    this.textures.push(leafTex);
    const leafMat = patchWind(
      new THREE.MeshStandardMaterial({
        name: 'loco/coastFoliage',
        map: leafTex,
        vertexColors: true,
        roughness: 0.62,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0.4,
        envMapIntensity: 0.6,
      }),
      this.uniforms,
      'loco/veg-alpha-v1',
    );
    this.materials.push(leafMat);

    const woodMat = patchWind(
      new THREE.MeshStandardMaterial({
        name: 'loco/coastWood',
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.7,
      }),
      this.uniforms,
      'loco/veg-solid-v1',
    );
    this.materials.push(woodMat);

    type Placement = { x: number; y: number; z: number; yaw: number; scale: number; tint: number };
    const seagrape: Placement[] = [];
    const almondCanopy: Placement[] = [];
    const almondTrunk: Placement[] = [];
    const flowers: Placement[] = [];
    const dune: Placement[] = [];

    /* --- sea grape hugs the dune line; it is the plant that actually holds
     *     a Caribbean beach together, and it reads as a low dark mass --- */
    for (const span of model.spans) {
      const n = Math.round(span.length * 0.16 * density);
      for (let i = 0; i < n; i++) {
        const stn = sampleSpan(span.stations, rng.next() * span.length);
        if (stn.dock) continue;
        const off = rng.range(stn.width * 0.62, stn.width * 0.97);
        const x = stn.x - stn.nx * off + rng.range(-3, 3);
        const z = stn.z - stn.nz * off + rng.range(-3, 3);
        const y = model.beachHeight(x, z);
        if (y < SEA_LEVEL + 1.8) continue;
        if (model.distToRamp(x, z) < 9) continue;
        seagrape.push({ x, y: y - 0.1, z, yaw: rng.range(0, 6.283), scale: rng.range(0.8, 1.5), tint: 0 });
      }
      // marram-ish dune tufts scattered up the back of the berm
      const t = Math.round(span.length * 0.7 * density);
      for (let i = 0; i < t; i++) {
        const stn = sampleSpan(span.stations, rng.next() * span.length);
        if (stn.dock) continue;
        const off = rng.range(stn.width * 0.42, stn.width * 1.0);
        const x = stn.x - stn.nx * off + rng.range(-4, 4);
        const z = stn.z - stn.nz * off + rng.range(-4, 4);
        const y = model.beachHeight(x, z);
        if (y < SEA_LEVEL + 1.5) continue;
        if (model.distToRamp(x, z) < 7) continue;
        dune.push({ x, y: y - 0.05, z, yaw: rng.range(0, 6.283), scale: rng.range(0.55, 1.2), tint: 0 });
      }
    }

    /* --- sea almond: waterfront shade tree, horizontally tiered (§1.9) --- */
    const prom = model.promenade;
    if (prom.length > 4) {
      const total = prom[prom.length - 1].s;
      for (let s = 30; s < total - 20; s += rng.range(46, 82)) {
        const p = model.promenadeAtS(s);
        if (!p) continue;
        // §1.9 puts the almendro on the waterfront proper — and the promenade
        // station is already outboard of the kerb, so anything set landward of
        // it would be standing in the road
        const off = rng.range(5, 12);
        const x = p.x + p.nx * off;
        const z = p.z + p.nz * off;
        if (model.distToRamp(x, z) < 12) continue;
        const y = model.beachHeight(x, z);
        if (y < SEA_LEVEL + 2.4) continue;
        const scale = rng.range(0.85, 1.25);
        almondTrunk.push({ x, y, z, yaw: rng.range(0, 6.283), scale, tint: 0 });
        almondCanopy.push({ x, y, z, yaw: rng.range(0, 6.283), scale, tint: 0 });
      }
    }

    /* --- bougainvillea and hibiscus against the seawall and in the plazas --- */
    if (prom.length > 4) {
      const total = prom[prom.length - 1].s;
      for (let s = 5; s < total - 5; s += rng.range(7, 17)) {
        const p = model.promenadeAtS(s);
        if (!p) continue;
        const x = p.x - p.nx * rng.range(0.9, 1.8);
        const z = p.z - p.nz * rng.range(0.9, 1.8);
        if (model.distToRamp(x, z) < 9) continue;
        flowers.push({
          x,
          y: p.y,
          z,
          yaw: Math.atan2(p.nx, p.nz),
          scale: rng.range(0.8, 1.35),
          tint: rng.int(0, C.bougainvillea.length + C.hibiscus.length - 1),
        });
      }
    }
    for (const area of layout.areas) {
      if (area.surface === 'asphalt' || area.surface === 'sand') continue;
      const poly = area.polygon;
      for (let i = 0; i < Math.round(9 * density); i++) {
        const p = poly[rng.int(0, poly.length - 1)];
        const q = poly[rng.int(0, poly.length - 1)];
        const f = rng.next();
        const x = lerp(p.x, q.x, f) + rng.range(-3, 3);
        const z = lerp(p.y, q.y, f) + rng.range(-3, 3);
        if (!pointInPoly(poly, x, z)) continue;
        if (edgeDistance(poly, x, z) > 6) continue;
        flowers.push({
          x,
          y: layout.groundHeight(x, z),
          z,
          yaw: rng.range(0, 6.283),
          scale: rng.range(0.75, 1.2),
          tint: rng.int(0, C.bougainvillea.length + C.hibiscus.length - 1),
        });
      }
    }

    /* --- realise --- */
    const palette = [...C.bougainvillea, ...C.hibiscus];
    /**
     * One mesh per cell, so a stand of sea grape on the far beach can be
     * frustum-culled instead of riding along in every frame and every shadow
     * map. `tall` picks which cull distance the cell answers to: a sea almond
     * is a landmark tree and holds to `drawDistance`, a dune tuft is 60 cm of
     * grass and is gone long before that.
     */
    const put = (
      list: Placement[],
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      name: string,
      stiff: number,
      tall: boolean,
      bloom = false,
    ): void => {
      if (list.length === 0) {
        geo.dispose();
        return;
      }
      const cells = bucketByCell(list, SHRUB_CELL, (p) => p);
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const items = cell.items;
        // per-instance wind (and the bloom tint) live on the geometry, so a
        // cell cannot share one with its neighbour
        const g = cells.length === 1 ? geo : geo.clone();
        const mesh = new THREE.InstancedMesh(g, mat, items.length);
        mesh.name = `${name}/${c}`;
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const p = new THREE.Vector3();
        const sc = new THREE.Vector3();
        const col = new THREE.Color();
        const phase = new Float32Array(items.length);
        const stiffness = new Float32Array(items.length);
        const bloomCol = bloom ? new Float32Array(items.length * 3) : null;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          p.set(it.x, it.y, it.z);
          q.setFromAxisAngle(UP, it.yaw);
          sc.setScalar(it.scale);
          m.compose(p, q, sc);
          mesh.setMatrixAt(i, m);
          // seeded off the world position, not the array index, so splitting
          // the list into cells does not reshuffle which plant sways when
          phase[i] = (it.x * 0.031 + it.z * 0.017) % 1;
          stiffness[i] = stiff * (0.82 + ((it.x * 0.577 + it.z * 0.331) % 1) * 0.36);
          if (bloomCol) {
            col.setHex(palette[it.tint % palette.length], THREE.SRGBColorSpace);
            bloomCol[i * 3] = col.r;
            bloomCol[i * 3 + 1] = col.g;
            bloomCol[i * 3 + 2] = col.b;
          }
        }
        mesh.instanceMatrix.needsUpdate = true;
        setInstanceWind(mesh, phase, stiffness);
        if (bloomCol) {
          g.setAttribute('aBloom', new THREE.InstancedBufferAttribute(bloomCol, 3));
        }
        this.addInstanced(mesh, g);
        const foot = bucketFootprint(cell, SHRUB_SPREAD);
        (tall ? this.lodTall : this.lodSmall).add(mesh, foot.cx, foot.cz, foot.radius);
        this._stats.shrubs += items.length;
      }
      if (cells.length !== 1) geo.dispose();
    };

    put(seagrape, buildSeaGrape(rng.fork(7)), leafMat, 'veg/seagrape', 0.55, true);
    put(dune, buildDuneTuft(rng.fork(19)), leafMat, 'veg/duneGrass', 1.1, false);
    put(almondTrunk, buildAlmondTrunk(), woodMat, 'veg/almondTrunk', 0.18, true);
    put(almondCanopy, buildAlmondCanopy(rng.fork(23)), leafMat, 'veg/almondCanopy', 0.5, true);

    /* flowering shrubs get their own material so the bloom colour can ride on
     * instanceColor without fighting the wind rig's phase channel */
    if (flowers.length > 0) {
      const flowerMat = new THREE.MeshStandardMaterial({
        name: 'loco/coastFlowers',
        map: leafTex,
        vertexColors: true,
        roughness: 0.66,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0.4,
        envMapIntensity: 0.65,
      });
      // Wind as usual, plus a bloom tint that lands *only* on the vertices
      // flagged as flowers (aWind.z > 0.5), so one shrub carries green leaves
      // and magenta bracts out of a single instanced draw.
      flowerMat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            [
              '#include <common>',
              WIND_PARS,
              '#ifdef USE_INSTANCING',
              '  attribute vec3 aBloom;',
              '#endif',
              'varying vec3 vBloomCol;',
            ].join('\n'),
          )
          .replace(
            '#include <begin_vertex>',
            [
              WIND_BEGIN,
              '#ifdef USE_INSTANCING',
              '  vBloomCol = mix( vec3( 1.0 ), aBloom * 1.35, step( 0.5, aWind.z ) );',
              '#else',
              '  vBloomCol = vec3( 1.0 );',
              '#endif',
            ].join('\n'),
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vBloomCol;')
          .replace(
            '#include <color_fragment>',
            '#include <color_fragment>\n\tdiffuseColor.rgb *= vBloomCol;',
          );
      };
      flowerMat.customProgramCacheKey = () => 'loco/veg-flower-v1';
      this.materials.push(flowerMat);
      put(flowers, buildFloweringShrub(rng.fork(31)), flowerMat, 'veg/flowers', 0.9, false, true);
    }
  }

  private addInstanced(mesh: THREE.InstancedMesh, geo: THREE.BufferGeometry): void {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere();
    // instanced bounds are computed from the instance matrices, but the wind
    // shader can push a tip a metre or so past them; pad rather than disable
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 3;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geo);
    this._stats.instances += mesh.count;
    this._stats.triangles += triCount(geo) * mesh.count;
  }

  /* ------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number): void {
    this.uniforms.uTime.value += dt;

    const budget = QUALITY_BUDGET[this.quality];
    /* Palms are the skyline of a Caribbean seafront, so they answer to
     * `drawDistance` and not to the prop cut — thinning them out is exactly the
     * kind of "cheaper but worse" the budget must not buy. What the grid does
     * buy is that a stand behind the camera, or across the bay, is no longer
     * transformed and no longer re-submitted into the shadow map. */
    this.lodTall.update(cameraPos, budget.drawDistance);
    // Dune tufts and bougainvillea are 0.6–1.4 m; past a couple of hundred
    // metres they are below a pixel and read as noise on the sand either way.
    this.lodSmall.update(cameraPos, Math.max(240, budget.propDetailDistance * 1.6));

    /* Frond LOD. Same crowns, same droop, same wind — a third of the segments.
     * Swapped per stand rather than per palm so the change is one event at the
     * far end of the street instead of a shimmer of individual palms. */
    const cx = cameraPos.x;
    const cz = cameraPos.z;
    for (const p of this.palmLod) {
      const dx = p.cx - cx;
      const dz = p.cz - cz;
      const d = Math.sqrt(dx * dx + dz * dz) - p.radius;
      const useNear = d < PALM_LOD_DISTANCE;
      // `lodTall` has already decided whether the stand is drawn at all; this
      // only picks which of the pair answers for it.
      if (p.near.visible || p.far.visible) {
        p.near.visible = useNear;
        p.far.visible = !useNear;
      }
    }
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const d = QUALITY_BUDGET[tier].propDetailDistance;
    // the understorey is the first thing to go on a weak machine; the palm
    // silhouette is the whole point and always stays
    this.lodSmall.setEnabled(
      (m) => m.name.startsWith('veg/dune') || m.name.startsWith('veg/flowers'),
      d >= 100,
    );
    this.lodTall.setEnabled((m) => m.name.startsWith('veg/seagrape'), d >= 80);
  }

  stats(): Record<string, number> {
    return {
      vegPalms: this._stats.palms,
      vegShrubs: this._stats.shrubs,
      vegInstances: this._stats.instances,
      vegTriangles: Math.round(this._stats.triangles),
      vegDrawCalls: this.group.children.length,
    };
  }

  dispose(): void {
    this.lodTall.clear();
    this.lodSmall.clear();
    this.palmLod.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    for (const m of this.meshes) m.dispose();
    this.meshes.length = 0;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ========================================================================== *
 *  palm construction
 * ========================================================================== */

type PalmSpecies = 'coconut' | 'royal';

interface PalmSite {
  species: PalmSpecies;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  variant: number;
  fronds: number;
  frondLen: readonly [number, number];
  frondPhase: number;
  droopBias: number;
  phase: number;
  stiffness: number;
}

const UP = new THREE.Vector3(0, 1, 0);

function makeSite(species: PalmSpecies, x: number, y: number, z: number, rng: RNG): PalmSite {
  const spec = species === 'coconut' ? COCONUT : ROYAL;
  return {
    species,
    x,
    y,
    z,
    yaw: rng.range(0, Math.PI * 2),
    scale: rng.range(0.86, 1.14),
    variant: rng.int(0, 5),
    fronds: rng.int(spec.fronds[0], spec.fronds[1]),
    frondLen: spec.frondLen,
    frondPhase: rng.range(0, Math.PI * 2),
    droopBias: rng.range(-0.1, 0.14),
    phase: rng.next(),
    stiffness: species === 'coconut' ? rng.range(0.85, 1.15) : rng.range(0.5, 0.75),
  };
}

function applyPalmInstances(mesh: THREE.InstancedMesh, list: PalmSite[], stiff: number): void {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const phase = new Float32Array(list.length);
  const stiffness = new Float32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const site = list[i];
    p.set(site.x, site.y, site.z);
    q.setFromAxisAngle(UP, site.yaw);
    s.setScalar(site.scale);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    phase[i] = site.phase;
    stiffness[i] = stiff * site.stiffness;
  }
  mesh.instanceMatrix.needsUpdate = true;
  setInstanceWind(mesh, phase, stiffness);
}

/**
 * A swept palm trunk.
 *
 * The spine is a quadratic-ish curve: a hard kick out of the ground (palms
 * grow toward the light off a seawall, so the base leans and the top comes
 * back), a taper, and a per-ring radius wobble that reads as leaf scars. The
 * crownshaft on a royal is a separate green sleeve at the top.
 */
function buildTrunk(
  species: PalmSpecies,
  spec: typeof COCONUT | typeof ROYAL,
  rng: RNG,
  ringCount = 11,
): { geo: THREE.BufferGeometry; crown: THREE.Vector3; tilt: THREE.Quaternion } {
  const gb = new GeoBuilder().enableAux();
  const height = rng.range(spec.height[0], spec.height[1]);
  const lean = (rng.range(spec.lean[0], spec.lean[1]) * Math.PI) / 180 * (rng.bool() ? 1 : -1);
  const sides = 8;
  /* Rings only sample the *lean*, which is a single smooth quarter-sine over
   * 14 m — the leaf-scar wobble below is `sin( t * rings * 2π )` evaluated at
   * `t = r / rings`, i.e. `sin( r * 2π )`, which is exactly zero at every ring
   * the sweep actually places. It has never contributed a vertex of relief, so
   * the ring count is free to follow the tier. */
  const rings = ringCount;
  const sway = rng.range(0.35, 0.9);
  const trunkCol = species === 'coconut' ? C.trunkCoconut : C.trunkRoyal;

  const spineAt = (t: number, out: THREE.Vector3): THREE.Vector3 => {
    // lean hard low down, straighten toward the crown
    const bend = Math.sin(t * Math.PI * 0.5) * lean + Math.sin(t * Math.PI) * lean * sway * 0.55;
    const x = Math.sin(bend) * height * t * 0.62;
    return out.set(x, height * t, 0);
  };

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const ringIdx: number[][] = [];
  const col = new THREE.Color();

  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    spineAt(t, p0);
    spineAt(Math.min(1, t + 0.02), p1);
    tangent.subVectors(p1, p0).normalize();
    // taper plus the scar-ring wobble
    const taper = lerp(spec.baseR, spec.topR, Math.pow(t, 0.62));
    const flare = 1 + Math.exp(-t * 14) * 0.75;
    const ring = 1 + Math.sin(t * rings * Math.PI * 2) * 0.05;
    const rad = taper * flare * ring;
    // AO down the trunk: the base sits in its own shadow
    const shade = 0.72 + 0.28 * smoothstep(t / 0.25);
    col.setHex(trunkCol, THREE.SRGBColorSpace);

    const row: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // a real frame would need the full Frenet basis; the lean is small
      // enough that a Y-major approximation is invisible and much cheaper
      const nx = ca;
      const nz = sa;
      const facing = 0.78 + 0.22 * ca; // fake wrap lighting so 8 sides read round
      row.push(
        gb.vertex(
          p0.x + ca * rad,
          p0.y,
          p0.z + sa * rad,
          nx,
          tangent.x * -0.25,
          nz,
          i / sides,
          t * height * 0.4,
          col.r * shade * facing,
          col.g * shade * facing,
          col.b * shade * facing,
          t * t * 0.9, // sway weight: base is anchored, crown swings
          0,
          0,
        ),
      );
    }
    ringIdx.push(row);
  }
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < sides; i++) {
      gb.quadIdx(ringIdx[r][i], ringIdx[r][i + 1], ringIdx[r + 1][i + 1], ringIdx[r + 1][i]);
    }
  }

  spineAt(1, p0);
  const tip = p0.clone();

  // crownshaft: the smooth green sleeve a royal palm carries under the crown
  if (species === 'royal') {
    spineAt(0.87, p1);
    const shaftH = tip.y - p1.y;
    gb.cylinder(p1.x, p1.y, p1.z, spec.topR * 1.32, spec.topR * 0.9, shaftH, sides, C.crownshaft, false, new THREE.Vector3(0.85, 0, 0));
  } else {
    // coconuts: a cluster of nuts under the crown
    const nuts = rng.int(3, 6);
    for (let i = 0; i < nuts; i++) {
      const a = (i / nuts) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const rr = spec.topR * rng.range(1.4, 2.3);
      gb.cylinder(
        tip.x + Math.cos(a) * rr,
        tip.y - 0.55 - rng.range(0, 0.35),
        tip.z + Math.sin(a) * rr,
        0.135,
        0.11,
        0.28,
        6,
        C.coconut,
        true,
        new THREE.Vector3(0.95, 0, 0),
      );
    }
  }

  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty trunk geometry');

  // the crown sits at the tip; the fronds inherit the trunk's local tilt so
  // a leaning palm's crown leans with it
  spineAt(0.94, p1);
  const dir = tip.clone().sub(p1).normalize();
  const tilt = new THREE.Quaternion().setFromUnitVectors(UP, dir);

  return { geo, crown: tip, tilt };
}

/**
 * One palm frond: a rachis with two banks of pinnae folded down off it.
 *
 * Authored in a unit box — length 1 along +Z, folding in X — so the instancer
 * can scale it to any frond length. ~72 triangles.
 */
function buildFrond(segments: number): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const col = new THREE.Color();

  const spineAt = (t: number): THREE.Vector3 => {
    // the rachis arches over and then the tip falls away
    const y = Math.sin(t * 2.05) * 0.3 - t * t * t * 0.72;
    return new THREE.Vector3(0, y, t);
  };

  const put = (
    p: THREE.Vector3,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    shade: number,
    swayW: number,
    flutW: number,
    phase: number,
  ): number => {
    col.setHex(C.frondMid, THREE.SRGBColorSpace);
    return gb.vertex(p.x, p.y, p.z, nx, ny, nz, u, v, col.r * shade, col.g * shade, col.b * shade, swayW, flutW, phase);
  };

  // central rachis: a thin solid strip so the frond has a spine you can see
  const rachis: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = spineAt(t);
    const w = lerp(0.035, 0.008, t);
    const shade = lerp(0.72, 1.05, t);
    rachis.push([
      put(new THREE.Vector3(p.x - w, p.y, p.z), 0, 1, 0, 0.5, t, shade, t * t, 0, 0),
      put(new THREE.Vector3(p.x + w, p.y, p.z), 0, 1, 0, 0.52, t, shade, t * t, 0, 0),
    ]);
  }
  for (let i = 0; i < segments; i++) {
    gb.quadIdx(rachis[i][0], rachis[i][1], rachis[i + 1][1], rachis[i + 1][0]);
  }

  // the two pinnae banks, hinged down off the rachis. This V section is what
  // makes a frond read as a frond and not as a leaf-shaped sticker.
  for (const side of [-1, 1]) {
    const bank: number[][] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const p = spineAt(t);
      // width swells to a third of the way out then tapers to the tip
      const span = Math.sin(Math.pow(t, 0.7) * Math.PI) * 1.02 + 0.06;
      const fold = 0.34 + t * 0.30; // radians below horizontal
      const ex = side * span * Math.cos(fold);
      const ey = -span * Math.sin(fold);
      const outer = new THREE.Vector3(p.x + ex, p.y + ey, p.z - span * 0.16);
      const shade = lerp(0.78, 1.12, t) * (side < 0 ? 0.9 : 1.0);
      const nx = side * Math.sin(fold) * 0.5;
      const ny = Math.cos(fold);
      bank.push([
        put(spineAt(t), nx, ny, 0, 0.5, t, shade * 0.92, t * t, t * 0.35, side * 0.13),
        put(outer, nx, ny, 0, side < 0 ? 0.0 : 1.0, t, shade, t * t, t, side * 0.13 + 0.27),
      ]);
    }
    for (let i = 0; i < segments; i++) {
      if (side < 0) gb.quadIdx(bank[i][0], bank[i + 1][0], bank[i + 1][1], bank[i][1]);
      else gb.quadIdx(bank[i][0], bank[i][1], bank[i + 1][1], bank[i + 1][0]);
    }
  }

  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty frond geometry');
  return geo;
}

/* ========================================================================== *
 *  understorey construction
 * ========================================================================== */

/** Crossed alpha quads with a bit of vertical structure; cheap leaf mass. */
function leafClump(
  gb: GeoBuilder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  height: number,
  colour: number,
  shade: number,
  planes: number,
  swayW: number,
  flutW: number,
  bloom = 0,
): void {
  const col = new THREE.Color().setHex(colour, THREE.SRGBColorSpace);
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const ca = Math.cos(a) * radius;
    const sa = Math.sin(a) * radius;
    const lo = cy - height * 0.5;
    const hi = cy + height * 0.5;
    const s = shade * (0.86 + 0.14 * (p / Math.max(1, planes - 1)));
    const nx = Math.cos(a + Math.PI * 0.5);
    const nz = Math.sin(a + Math.PI * 0.5);
    const i0 = gb.vertex(cx - ca, lo, cz - sa, nx, 0.5, nz, 0, 0, col.r * s * 0.82, col.g * s * 0.82, col.b * s * 0.82, swayW * 0.3, flutW * 0.4, p * 0.17);
    const i1 = gb.vertex(cx + ca, lo, cz + sa, nx, 0.5, nz, 1, 0, col.r * s * 0.82, col.g * s * 0.82, col.b * s * 0.82, swayW * 0.3, flutW * 0.4, p * 0.17);
    const i2 = gb.vertex(cx + ca, hi, cz + sa, nx, 0.5, nz, 1, 1, col.r * s, col.g * s, col.b * s, swayW, flutW, p * 0.17);
    const i3 = gb.vertex(cx - ca, hi, cz - sa, nx, 0.5, nz, 0, 1, col.r * s, col.g * s, col.b * s, swayW, flutW, p * 0.17);
    gb.quadIdx(i0, i1, i2, i3);
    if (bloom > 0) {
      // a smaller, offset plane flagged as bloom so the flower colour lands
      const br = radius * 0.62;
      const bc = Math.cos(a + 0.7) * br;
      const bs = Math.sin(a + 0.7) * br;
      const by = cy + height * 0.18;
      const j0 = gb.vertex(cx - bc, by - height * 0.3, cz - bs, nx, 0.5, nz, 0, 0, 1, 1, 1, swayW, flutW, 0.8);
      const j1 = gb.vertex(cx + bc, by - height * 0.3, cz + bs, nx, 0.5, nz, 1, 0, 1, 1, 1, swayW, flutW, 0.8);
      const j2 = gb.vertex(cx + bc, by + height * 0.42, cz + bs, nx, 0.5, nz, 1, 1, 1, 1, 1, swayW, flutW, 0.85);
      const j3 = gb.vertex(cx - bc, by + height * 0.42, cz - bs, nx, 0.5, nz, 0, 1, 1, 1, 1, swayW, flutW, 0.85);
      gb.quadIdx(j0, j1, j2, j3);
    }
  }
}

/** Sea grape: low, wide, dark, multi-stemmed. ~48 triangles. */
function buildSeaGrape(rng: RNG): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const lobes = rng.int(3, 4);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const d = rng.range(0.4, 1.15);
    leafClump(
      gb,
      Math.cos(a) * d,
      rng.range(0.55, 1.05),
      Math.sin(a) * d,
      rng.range(0.85, 1.5),
      rng.range(1.0, 1.6),
      C.seagrapeLeaf,
      rng.range(0.82, 1.08),
      2,
      0.35,
      0.5,
    );
  }
  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty sea grape');
  return geo;
}

/** Dune grass tuft: a few crossed blades. ~12 triangles. */
function buildDuneTuft(rng: RNG): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const col = new THREE.Color().setHex(0x9aa86a, THREE.SRGBColorSpace);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI + rng.range(-0.3, 0.3);
    const w = rng.range(0.32, 0.55);
    const h = rng.range(0.5, 0.95);
    const ca = Math.cos(a) * w;
    const sa = Math.sin(a) * w;
    const s = rng.range(0.85, 1.15);
    const i0 = gb.vertex(-ca, 0, -sa, 0, 1, 0, 0, 0, col.r * 0.6 * s, col.g * 0.6 * s, col.b * 0.6 * s, 0, 0, 0);
    const i1 = gb.vertex(ca, 0, sa, 0, 1, 0, 1, 0, col.r * 0.6 * s, col.g * 0.6 * s, col.b * 0.6 * s, 0, 0, 0);
    const i2 = gb.vertex(ca * 0.6, h, sa * 0.6, 0, 1, 0, 1, 1, col.r * s, col.g * s, col.b * s, 1, 0.7, i * 0.31);
    const i3 = gb.vertex(-ca * 0.6, h, -sa * 0.6, 0, 1, 0, 0, 1, col.r * s, col.g * s, col.b * s, 1, 0.7, i * 0.31);
    gb.quadIdx(i0, i1, i2, i3);
  }
  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty dune tuft');
  return geo;
}

/** Sea almond trunk plus its horizontal branch tiers. */
function buildAlmondTrunk(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  gb.cylinder(0, 0, 0, 0.32, 0.2, 2.6, 7, C.almondWood, false, new THREE.Vector3(0.1, 0, 0));
  // three tiers of near-horizontal limbs — the almendro's signature
  const tiers = [
    { y: 2.5, n: 5, len: 2.6, r: 0.1 },
    { y: 4.0, n: 5, len: 2.2, r: 0.08 },
    { y: 5.2, n: 4, len: 1.6, r: 0.06 },
  ];
  gb.cylinder(0, 2.6, 0, 0.2, 0.1, 3.1, 6, C.almondWood, false, new THREE.Vector3(0.3, 0, 0));
  for (const tier of tiers) {
    for (let i = 0; i < tier.n; i++) {
      const a = (i / tier.n) * Math.PI * 2 + tier.y;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // a squat cylinder laid nearly flat, approximated by a thin box
      gb.box(
        (ca * tier.len) / 2,
        tier.y + 0.15,
        (sa * tier.len) / 2,
        tier.len / 2,
        tier.r,
        tier.r,
        C.almondWood,
        -Math.atan2(sa, ca),
        new THREE.Vector3(0.3, 0, 0),
      );
    }
  }
  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty almond trunk');
  return geo;
}

/** Sea almond canopy: flat discs of leaf mass sitting on the branch tiers. */
function buildAlmondCanopy(rng: RNG): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const tiers = [
    { y: 2.9, r: 3.1 },
    { y: 4.4, r: 2.7 },
    { y: 5.7, r: 1.9 },
  ];
  for (const tier of tiers) {
    // sparse enough that sky reads through the tiers — a solid ball of leaves
    // is what makes a procedural broadleaf look like a dark green wall
    const n = rng.int(3, 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const d = tier.r * rng.range(0.35, 0.8);
      leafClump(
        gb,
        Math.cos(a) * d,
        tier.y + rng.range(-0.2, 0.25),
        Math.sin(a) * d,
        tier.r * rng.range(0.42, 0.62),
        rng.range(0.7, 1.05),
        C.almondLeaf,
        rng.range(0.8, 1.1),
        2,
        0.55,
        0.7,
      );
    }
  }
  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty almond canopy');
  return geo;
}

/** Bougainvillea / hibiscus: a leafy mass with bloom planes on top. */
function buildFloweringShrub(rng: RNG): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const lobes = rng.int(3, 5);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const d = rng.range(0.2, 0.75);
    leafClump(
      gb,
      Math.cos(a) * d,
      rng.range(0.6, 1.15),
      Math.sin(a) * d,
      rng.range(0.55, 0.95),
      rng.range(1.0, 1.7),
      C.shrub,
      rng.range(0.85, 1.1),
      2,
      0.6,
      0.8,
      1,
    );
  }
  const geo = gb.build('aWind');
  if (!geo) throw new Error('Vegetation: empty flowering shrub');
  return geo;
}

/* ========================================================================== *
 *  textures
 * ========================================================================== */

/**
 * The pinnae comb: a vertical alpha ramp cut into leaflets so a solid ribbon
 * reads as ~30 separate blades. u runs across the frond (0 = rachis edge,
 * 1 = the outer tip of the leaflets), v runs out along the rachis.
 */
function frondTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  /**
   * Leaflets are long, narrow and swept sharply back toward the tip of the
   * frond. The comb has to be coarse enough that each blade survives the mip
   * chain — a fine comb averages to a uniform grey haze at 30 m, which is what
   * makes a procedural palm read as a dotted screen instead of a leaf.
   */
  const COMB = 15; // leaflets per side along the rachis
  const SWEEP = 5.4; // how far back a blade rakes, in comb periods across the width
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // distance from the rachis, 0 at the middle column of the texture
      const across = Math.abs(u - 0.5) * 2;
      // one leaflet per comb period, raked back by `across`
      const phase = (v * COMB - across * SWEEP) % 1;
      const gap = Math.abs((phase < 0 ? phase + 1 : phase) - 0.5) * 2;
      // a blade is widest at its base and tapers to a point
      const width = 0.74 * (1 - Math.pow(across, 2.1) * 0.72);
      let a = gap < width ? 1 : 0;
      // the whole frond narrows toward its own tip, and the base is bare stem
      const outer = 0.98 - Math.pow(Math.max(v - 0.55, 0) / 0.45, 1.6) * 0.55;
      if (across > outer) a = 0;
      if (v < 0.07 && across > 0.3) a = 0;
      // torn tips — a clean palm looks plastic
      if (gap > width * 0.72 && valueNoise2D(v * 44, across * 9, 5507) > 0.42) a = 0;
      if (across < 0.055) a = 1; // the rachis strip stays solid
      // shade each blade from its base out, so the comb has volume
      const shade =
        1 - across * 0.3 - gap * 0.14 + valueNoise2D(v * 30, across * 6, 991) * 0.14;
      const o = (y * size + x) * 4;
      const c = Math.round(clamp01(shade) * 255);
      data[o] = c;
      data[o + 1] = c;
      data[o + 2] = c;
      data[o + 3] = a * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/palmFrond';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generic leaf mass: a soft blob of overlapping ovate leaves with alpha, used
 * by every broadleaf here. Cheap, tiles nothing, and reads correctly at speed.
 */
function leafTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  // a handful of ellipse "leaves" rasterised into an alpha + shade field
  const leaves: Array<{ x: number; y: number; a: number; b: number; rot: number; s: number }> = [];
  const r = new RNG(0x1eaf);
  for (let i = 0; i < 26; i++) {
    leaves.push({
      x: r.range(0.08, 0.92),
      y: r.range(0.08, 0.92),
      a: r.range(0.09, 0.19),
      b: r.range(0.05, 0.11),
      rot: r.range(0, Math.PI),
      s: r.range(0.66, 1.1),
    });
  }
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let alpha = 0;
      let shade = 0;
      for (const L of leaves) {
        const dx = u - L.x;
        const dy = v - L.y;
        const c = Math.cos(L.rot);
        const s = Math.sin(L.rot);
        const px = (dx * c + dy * s) / L.a;
        const py = (-dx * s + dy * c) / L.b;
        const d = px * px + py * py;
        if (d < 1) {
          alpha = 1;
          // centre vein + a rim highlight
          const vein = 1 - Math.min(1, Math.abs(py) * 5);
          shade = Math.max(shade, L.s * (0.82 + 0.3 * (1 - d)) - vein * 0.14);
        }
      }
      // fade the very edge of the tile so clumps do not show square corners
      const edge = Math.min(u, 1 - u, v, 1 - v);
      if (edge < 0.035) alpha = 0;
      const o = (y * size + x) * 4;
      const sh = clamp01(shade || 0.8);
      data[o] = Math.round(sh * 255);
      data[o + 1] = Math.round(sh * 255);
      data[o + 2] = Math.round(sh * 255);
      data[o + 3] = alpha * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'loco/coastLeaf';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ========================================================================== *
 *  small helpers
 * ========================================================================== */

function triCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (idx) return idx.count / 3;
  const pos = geo.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

function pointInPoly(poly: readonly THREE.Vector2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi.y > y !== pj.y > y) {
      const t = (y - pi.y) / (pj.y - pi.y);
      if (x < pi.x + t * (pj.x - pi.x)) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from (x,y) to any edge of the polygon. */
function edgeDistance(poly: readonly THREE.Vector2[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey || 1;
    const t = clamp01(((x - a.x) * ex + (y - a.y) * ey) / len2);
    const dx = x - (a.x + ex * t);
    const dy = y - (a.y + ey * t);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}
