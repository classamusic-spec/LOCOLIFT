/**
 * Loco Lift — shared material library.
 *
 * One instance owns every world material. Materials are keyed, built lazily and
 * disposed together, so the whole district renders from a couple of dozen
 * programs no matter how many meshes exist.
 *
 * **UV convention**: geometry hands us UVs already expressed in *tiles*, i.e.
 * `uv = worldMetres / tileMeters(id)`. Textures therefore keep `repeat = (1,1)`
 * and can be shared between materials that want different physical stone sizes.
 * Call {@link MaterialLibrary.tileMeters} when generating geometry.
 *
 * **Surface finish** (`ART_REFERENCE.md` §5 / §5.1). Every opaque surface is
 * patched through `onBeforeCompile` with one shared block that does four things
 * at a single injection point:
 *
 *  1. **Spatial roughness.** A tiling roughness map repeats every 1.9 m; a city
 *     paved in one repeated gloss level is the classic "plastic" tell. Two
 *     low-frequency layers (23.7 m and ~71 m, deliberately non-harmonic with the
 *     4.08 m texture footprint, §2.3) push roughness and value around so no two
 *     stretches of the same street have the same sheen.
 *  2. **Wetness.** Water fills micro-detail, so roughness collapses and albedo
 *     darkens in proportion to porosity — the §5.1 model, verbatim, including
 *     the up-facing mask that stops vertical walls wetting like pavement.
 *  3. **Puddles.** Low-frequency pools that flatten roughness to a mirror and
 *     lift the clearcoat lobe. Only surfaces that can actually hold water opt in.
 *  4. **Clearcoat.** Where it earns its cost, a second specular lobe over the
 *     base layer, keyed off the same wetness value. A wet street *is* a rough
 *     stone surface under a smooth film of water — which is precisely what a
 *     clearcoat lobe models, and why stretched lamp reflections show up on the
 *     adoquín the moment it rains.
 *
 * Clearcoat costs a whole second BRDF per light plus an extra IBL sample, so it
 * is gated: `low` quality never builds a `MeshPhysicalMaterial`, and on every
 * other tier only surfaces flagged in {@link SPECS} get one.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/Config';
import type { QualityTier } from '../core/types';
import { clamp01 } from '../core/MathUtils';
import { TextureFactory } from './TextureFactory';
import type { SurfaceId } from './TextureFactory';

export type MaterialId =
  | 'road'
  | 'roadCoastal'
  | 'roadPlaza'
  | 'alley'
  | 'stairs'
  | 'ramp'
  | 'kerb'
  | 'sidewalk'
  | 'gutter'
  | 'plazaFlagstone'
  | 'plazaCobble'
  | 'marketFloor'
  | 'promenade'
  | 'apron'
  | 'terrain'
  | 'sand'
  | 'grass'
  | 'sea'
  | 'seaDeep'
  | 'fortStone'
  | 'stucco'
  | 'roofTile';

/**
 * How a surface behaves under the shared finish block. Everything is optional
 * so a plain matte surface stays a one-line spec.
 */
export interface SurfaceFinish {
  /**
   * §5.1 porosity — 0 = sealed (glass, paint, metal), 1 = fully porous
   * (stucco, sandstone). Drives how much wet darkens the albedo.
   */
  porosity?: number;
  /** apply the up-facing mask; 0 for surfaces that are always horizontal */
  upMask?: number;
  /** clearcoat strength when dry. > 0 (or `wetCoat` > 0) promotes to physical */
  coat?: number;
  /** clearcoat strength at `wetness = 1` */
  wetCoat?: number;
  /** clearcoat roughness dry / wet */
  coatRough?: number;
  wetCoatRough?: number;
  /** how readily this surface pools water, 0..1 */
  puddle?: number;
  /** low-frequency roughness swing, as a fraction of the mapped roughness */
  macroRough?: number;
  /** low-frequency albedo swing, as a fraction of the mapped albedo */
  macroValue?: number;
  /**
   * Albedo multiplier at `wetness = 1`, straight off the §5 "Wet Δ" column.
   *
   * §5.1's generic `mix(1, 0.35, w * porosity)` and §5's per-surface table
   * disagree, and for the hero surfaces the table wins: the function puts wet
   * adoquín at ×0.45 where the table says ×0.62. That is not a rounding
   * difference — at night, on a stretch of street with no lamp in frame, ×0.45
   * takes the driving line under the §6.4 night luminance floor, which §4.3
   * explicitly forbids solving with an ambient lift. Porosity still drives the
   * roughness collapse, where the generic model is right.
   */
  wetAlbedo?: number;
  /**
   * Metres of world one UV tile covers. Only needed by adopted materials: the
   * macro layers convert `vMapUv` back into metres with it, so a wrong value
   * just changes the scale of the mottling, never its correctness.
   */
  tileMeters?: number;
}

interface MaterialSpec extends SurfaceFinish {
  surface: SurfaceId;
  /** metres of world covered by one UV tile */
  tile: number;
  color: number;
  roughness: number;
  metalness: number;
  /** multiplier on the surface's suggested normal strength */
  normal: number;
  /** 0 = never wets (sea), 1 = fully wets */
  wetness: number;
  envMapIntensity?: number;
  side?: THREE.Side;
}

/**
 * Finish presets. §5's roughness/porosity numbers for Old San Juan surfaces win
 * over any reference sheet built for a kart track; what is borrowed from the
 * reference is the *method* — a real clearcoat lobe and non-flat roughness.
 */
const PAVED: SurfaceFinish = {
  porosity: 0.85,
  wetAlbedo: 0.62,
  // a wet street is the whole reason this file knows what clearcoat is
  coat: 0.1,
  wetCoat: 1.0,
  coatRough: 0.34,
  wetCoatRough: 0.06,
  puddle: 1.0,
  macroRough: 0.2,
  macroValue: 0.07,
};

const SLAB: SurfaceFinish = {
  porosity: 0.7,
  wetAlbedo: 0.6,
  coat: 0.07,
  wetCoat: 0.85,
  coatRough: 0.3,
  wetCoatRough: 0.08,
  puddle: 0.45,
  macroRough: 0.17,
  macroValue: 0.06,
};

const SEALED: SurfaceFinish = {
  porosity: 0.7,
  wetAlbedo: 0.6,
  coat: 0.05,
  wetCoat: 0.9,
  coatRough: 0.28,
  wetCoatRough: 0.05,
  puddle: 0.85,
  macroRough: 0.22,
  macroValue: 0.05,
};

/** No clearcoat: matte masonry and landscape. Still gets spatial roughness. */
const MASONRY: SurfaceFinish = { porosity: 0.95, wetAlbedo: 0.7, macroRough: 0.2, macroValue: 0.07 };
const SOFT: SurfaceFinish = { porosity: 0.7, wetAlbedo: 0.85, macroRough: 0.24, macroValue: 0.08 };

const SPECS: Record<MaterialId, MaterialSpec> = {
  /* — carriageways — */
  road: { surface: 'cobblestone', tile: 1.9, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 1, ...PAVED },
  roadCoastal: { surface: 'asphalt', tile: 5.5, color: 0xdedede, roughness: 1, metalness: 0, normal: 1, wetness: 1, ...SEALED },
  roadPlaza: { surface: 'cobblestone', tile: 2.2, color: 0xf3f2ee, roughness: 1, metalness: 0, normal: 0.9, wetness: 1, ...PAVED },
  alley: { surface: 'cobblestone', tile: 1.45, color: 0xe6e6ea, roughness: 1, metalness: 0, normal: 1.1, wetness: 1, ...PAVED },
  stairs: { surface: 'cobblestone', tile: 1.35, color: 0xdedee4, roughness: 1, metalness: 0, normal: 1.1, wetness: 1, ...PAVED, puddle: 0.25 },
  ramp: { surface: 'sandstone', tile: 2.0, color: 0x9d7a52, roughness: 1, metalness: 0, normal: 1, wetness: 1, ...MASONRY },

  /* — kerb line and pavement — */
  kerb: { surface: 'kerbstone', tile: 2.6, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 1, ...SLAB, puddle: 0.15 },
  sidewalk: { surface: 'flagstone', tile: 2.4, color: 0xf2eee4, roughness: 1, metalness: 0, normal: 0.85, wetness: 1, ...SLAB },
  gutter: { surface: 'cobblestone', tile: 1.2, color: 0xa8adb8, roughness: 1, metalness: 0, normal: 1.2, wetness: 1, ...PAVED, puddle: 1.0 },

  /* — open areas — */
  plazaFlagstone: { surface: 'flagstone', tile: 4.2, color: 0xfffaf0, roughness: 1, metalness: 0, normal: 0.8, wetness: 1, ...SLAB },
  plazaCobble: { surface: 'cobblestone', tile: 1.9, color: 0xf6f6f8, roughness: 1, metalness: 0, normal: 1, wetness: 1, ...PAVED },
  marketFloor: { surface: 'flagstone', tile: 3.0, color: 0xe9cfae, roughness: 1, metalness: 0, normal: 0.7, wetness: 1, ...SLAB },
  promenade: { surface: 'flagstone', tile: 3.4, color: 0xf4ecdc, roughness: 1, metalness: 0, normal: 0.8, wetness: 1, ...SLAB },
  apron: { surface: 'asphalt', tile: 5.5, color: 0xcfcfcf, roughness: 1, metalness: 0, normal: 0.9, wetness: 1, ...SEALED },

  /* — landscape — */
  terrain: { surface: 'grass', tile: 5.5, color: 0xa9b98d, roughness: 1, metalness: 0, normal: 0.6, wetness: 0.6, ...SOFT, porosity: 0.6 },
  sand: { surface: 'sand', tile: 5.0, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.9, porosity: 0.8, wetAlbedo: 0.7, macroRough: 0.18, macroValue: 0.06, coat: 0, wetCoat: 0.7, coatRough: 0.3, wetCoatRough: 0.1, puddle: 0.3 },
  grass: { surface: 'grass', tile: 4.0, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.5, ...SOFT, porosity: 0.6 },

  /* — water — */
  sea: { surface: 'seaFoam', tile: 26, color: PALETTE.sea, roughness: 0.08, metalness: 0, normal: 1, wetness: 0, envMapIntensity: 1.6 },
  seaDeep: { surface: 'seaFoam', tile: 52, color: PALETTE.seaDeep, roughness: 0.12, metalness: 0, normal: 0.7, wetness: 0, envMapIntensity: 1.5 },

  /* — vertical surfaces later modules will want — */
  fortStone: { surface: 'sandstone', tile: 4.5, color: PALETTE.fortStone, roughness: 1, metalness: 0, normal: 1, wetness: 0.8, ...MASONRY },
  stucco: { surface: 'stucco', tile: 3.2, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.7, porosity: 0.9, wetAlbedo: 0.8, macroRough: 0.26, macroValue: 0.09 },
  // §5 azotea/tile: glazed clay goes properly glossy in rain and is read from
  // the ramparts and every balcony, so it earns a wet-only coat.
  roofTile: { surface: 'roofTile', tile: 2.2, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.9, porosity: 0.6, wetAlbedo: 0.66, macroRough: 0.2, macroValue: 0.08, coat: 0, wetCoat: 0.6, coatRough: 0.3, wetCoatRough: 0.09, puddle: 0.2 },
};

/**
 * Shared 0..1 wetness, deliberately module-scoped.
 *
 * Layers that do not hold a {@link MaterialLibrary} reference — the façade
 * district is the important one — still need rain to reach them, and threading
 * a uniform through five constructors owned by other agents is not worth the
 * merge risk. The library mirrors this object, so `setWetness` still drives
 * everything and nothing outside this file changes.
 */
export const sharedWetness: { value: number } = { value: 0 };

/* --------------------------------------------------------------- shader bits */

/** Cheap tiling-free value noise. ~4 hashes; used at most three times. */
export const LOCO_NOISE_GLSL = /* glsl */ `
float locoHash21( vec2 p ) {
	vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	q += dot( q, q.yzx + 33.33 );
	return fract( ( q.x + q.y ) * q.z );
}
float locoValueNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = locoHash21( i );
	float b = locoHash21( i + vec2( 1.0, 0.0 ) );
	float c = locoHash21( i + vec2( 0.0, 1.0 ) );
	float d = locoHash21( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
`;

/**
 * The finish block. Injected after `<lights_physical_fragment>`, which is the
 * one place where the shading normal, the resolved roughness and the whole
 * `PhysicalMaterial` struct are all in scope at once — so wet albedo, wet
 * roughness, puddles and the clearcoat lobe are all decided together instead of
 * being smeared over four separate chunk patches that cannot see each other.
 *
 * `MeshStandardMaterial` and `MeshPhysicalMaterial` share this shader, so the
 * same block serves both; the clearcoat half compiles out when the material has
 * no coat.
 */
const FINISH_GLSL = /* glsl */ `
#include <lights_physical_fragment>
{
	// §5.1 up-facing mask: a façade sheds water, a street does not
	vec3 locoUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	float locoUp = clamp( dot( nonPerturbedNormal, locoUpV ) * 1.6 - 0.2, 0.0, 1.0 );
	float locoWet = clamp( uWetness * uWetAmount, 0.0, 1.0 ) * mix( 1.0, locoUp, uFinishB.x );
	float locoPuddle = 0.0;

	#ifdef LOCO_UV
		// vMapUv is worldMetres / tileMeters and is *not* wrapped in the varying,
		// so it doubles as a free world-space coordinate for the macro layers.
		vec2 locoWm = vMapUv * uFinishB.y;
		float locoMacro = locoValueNoise( locoWm * 0.0422 );   // 23.7 m
		float locoMega = locoValueNoise( locoWm * 0.0140 + 37.0 ); // 71.3 m
		float locoVar = ( locoMacro - 0.5 ) * 0.7 + ( locoMega - 0.5 ) * 0.3;
		material.roughness = clamp( material.roughness * ( 1.0 + locoVar * uFinishB.z * 2.0 ), 0.04, 1.0 );
		float locoTint = 1.0 + locoVar * uFinishB.w * 2.0;
		material.diffuseColor *= locoTint;
		material.diffuseContribution *= locoTint;
		locoPuddle = smoothstep( 0.50, 0.86, locoValueNoise( locoWm * 0.118 + 91.0 ) * 0.6 + locoMega * 0.4 )
			* locoWet * uFinishA.w;
	#endif

	// §5's per-surface "Wet Δ" albedo, not §5.1's generic curve — see SurfaceFinish
	float locoDarken = mix( 1.0, uCoatRough.z, locoWet );
	material.diffuseColor *= locoDarken;
	material.diffuseContribution *= locoDarken;
	material.roughness = max( 0.055, mix( material.roughness, material.roughness * 0.22, locoWet * ( 0.35 + 0.65 * uFinishA.x ) ) );
	material.roughness = mix( material.roughness, 0.04, locoPuddle );

	#ifdef USE_CLEARCOAT
		material.clearcoat = clamp( mix( uFinishA.y, uFinishA.z, locoWet ) + locoPuddle * 0.55, 0.0, 1.0 );
		material.clearcoatRoughness = max( 0.0525,
			mix( uCoatRough.x, uCoatRough.y, locoWet ) * ( 1.0 - locoPuddle * 0.75 ) );
		// dry: the sheen rides the stone crowns. wet: a flat film of water sits
		// on top of them, which is what stretches a lamp 10 m down the street.
		clearcoatNormal = normalize( mix( normal, nonPerturbedNormal, max( locoWet, locoPuddle ) ) );
	#endif
}
`;

/* -------------------------------------------------------------------- library */

interface FinishUniforms {
  uWetAmount: { value: number };
  /** x porosity, y dry coat, z wet coat, w puddle */
  uFinishA: { value: THREE.Vector4 };
  /** x upMask, y tileMeters, z macroRough, w macroValue */
  uFinishB: { value: THREE.Vector4 };
  /** x dry coat roughness, y wet coat roughness, z §5 wet albedo multiplier */
  uCoatRough: { value: THREE.Vector3 };
}

const WET_CACHE_KEY = 'loco/finish-v2';

export class MaterialLibrary {
  readonly textures: TextureFactory;
  readonly quality: QualityTier;

  /** bound into every wettable material's program */
  readonly wetnessUniform = sharedWetness;
  /** advanced by `update`, drives the sea */
  readonly timeUniform = { value: 0 };

  /** false on phones: no material in the library gets a clearcoat lobe */
  readonly clearcoatEnabled: boolean;

  private cache = new Map<string, THREE.Material>();
  private owned: THREE.Material[] = [];
  private _wetness = 0;
  private disposed = false;

  constructor(textures: TextureFactory, quality: QualityTier) {
    this.textures = textures;
    this.quality = quality;
    this.clearcoatEnabled = quality !== 'low';
  }

  /** Metres of world one UV tile of this material covers. */
  tileMeters(id: MaterialId): number {
    return SPECS[id].tile;
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  /**
   * Adopt a material built elsewhere (buildings, props). It is patched with the
   * finish block and disposed with the library.
   */
  register(key: string, mat: THREE.Material, wetness = 1, finish?: SurfaceFinish): THREE.Material {
    if (wetness > 0 && mat instanceof THREE.MeshStandardMaterial) {
      this.patchFinish(mat, wetness, finish ?? {}, finish?.tileMeters ?? 1);
    }
    this.cache.set(key, mat);
    this.owned.push(mat);
    return mat;
  }

  /** Memoised custom material slot for later world layers. */
  custom(
    key: string,
    build: () => THREE.Material,
    wetness = 1,
    finish?: SurfaceFinish,
  ): THREE.Material {
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.register(key, build(), wetness, finish);
  }

  get(id: MaterialId): THREE.MeshStandardMaterial {
    const hit = this.cache.get(id);
    if (hit) return hit as THREE.MeshStandardMaterial;

    const spec = SPECS[id];
    const maps = this.textures.surface(spec.surface);
    const wantsCoat = this.clearcoatEnabled && Math.max(spec.coat ?? 0, spec.wetCoat ?? 0) > 0;

    const params: THREE.MeshPhysicalMaterialParameters = {
      name: `loco/${id}`,
      color: spec.color,
      map: maps.map,
      roughness: spec.roughness,
      metalness: spec.metalness,
      side: spec.side ?? THREE.FrontSide,
      envMapIntensity: spec.envMapIntensity ?? 0.85,
    };
    if (maps.normalMap) params.normalMap = maps.normalMap;
    if (maps.roughnessMap) params.roughnessMap = maps.roughnessMap;
    if (wantsCoat) {
      // the constructor value only has to be non-zero for USE_CLEARCOAT to be
      // defined; the finish block sets the real value per fragment
      params.clearcoat = Math.max(spec.coat ?? 0, 0.02);
      params.clearcoatRoughness = spec.coatRough ?? 0.3;
    }

    const mat = wantsCoat
      ? new THREE.MeshPhysicalMaterial(params)
      : new THREE.MeshStandardMaterial(params);

    if (maps.normalMap) {
      const s = maps.normalStrength * spec.normal;
      mat.normalScale = new THREE.Vector2(s, s);
    }
    // geometry carries the tiling, so the shared textures stay at repeat 1
    if (mat.map) {
      mat.map.repeat.set(1, 1);
      mat.map.offset.set(0, 0);
    }

    if (id === 'sea' || id === 'seaDeep') this.patchSea(mat, id === 'sea' ? 1 : 0.55);
    else if (spec.wetness > 0) this.patchFinish(mat, spec.wetness, spec, spec.tile);

    this.cache.set(id, mat);
    this.owned.push(mat);
    return mat;
  }

  /**
   * Injects the shared finish block: spatial roughness, the §5.1 wet model,
   * puddles and the clearcoat lobe.
   *
   * `customProgramCacheKey` is *composed*, never replaced. A material that
   * arrives here with its own key (El Perlo's shells, the coast props) keeps it
   * — overwriting it is what previously let two structurally identical
   * materials with different `onBeforeCompile` injections share one program.
   */
  private patchFinish(
    mat: THREE.MeshStandardMaterial,
    amount: number,
    finish: SurfaceFinish,
    tileMeters: number,
  ): void {
    const wet = this.wetnessUniform;
    // Phones get the wet model (a dot product and two mixes) but not the macro
    // layers: two value-noise lookups per fragment across every road surface is
    // real fill-rate cost on a tile GPU, and it buys the least on a small
    // screen. `low` therefore stays within a few ALU of where it started.
    const hasUv = this.clearcoatEnabled && mat.map !== null && mat.map !== undefined;
    const coated =
      this.clearcoatEnabled && mat instanceof THREE.MeshPhysicalMaterial && mat.clearcoat > 0;

    const u: FinishUniforms = {
      uWetAmount: { value: clamp01(amount) },
      uFinishA: {
        value: new THREE.Vector4(
          clamp01(finish.porosity ?? 0.85),
          clamp01(finish.coat ?? 0),
          clamp01(finish.wetCoat ?? 0),
          clamp01(finish.puddle ?? 0),
        ),
      },
      uFinishB: {
        value: new THREE.Vector4(
          finish.upMask ?? 1,
          tileMeters,
          Math.max(0, finish.macroRough ?? 0),
          Math.max(0, finish.macroValue ?? 0),
        ),
      },
      uCoatRough: {
        value: new THREE.Vector3(
          finish.coatRough ?? 0.3,
          finish.wetCoatRough ?? 0.06,
          // fall back to §5.1's generic curve when a surface has no table row
          finish.wetAlbedo ?? 1 - 0.65 * clamp01(finish.porosity ?? 0.85),
        ),
      },
    };

    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      if (prev) prev.call(mat, shader, renderer);
      shader.uniforms.uWetness = wet;
      Object.assign(shader.uniforms, u);
      const decls = [
        '#include <common>',
        'uniform float uWetness;',
        'uniform float uWetAmount;',
        'uniform vec4 uFinishA;',
        'uniform vec4 uFinishB;',
        // vec3, not vec2: .xy are the dry/wet clearcoat roughnesses and .z is
        // the per-surface wet albedo multiplier, which FINISH_GLSL reads
        // *outside* the USE_CLEARCOAT guard. Declaring it vec2 made every
        // material using this block fail to compile with "vector field
        // selection out of range", not just the physical ones.
        'uniform vec3 uCoatRough;',
        LOCO_NOISE_GLSL,
      ].join('\n');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', hasUv ? `#define LOCO_UV\n${decls}` : decls)
        .replace('#include <lights_physical_fragment>', FINISH_GLSL);
    };

    const prevKey = mat.customProgramCacheKey;
    const suffix = `${WET_CACHE_KEY}|${hasUv ? 'u' : '-'}${coated ? 'c' : '-'}`;
    mat.customProgramCacheKey = prevKey
      ? function (this: THREE.Material): string {
          return `${prevKey.call(this)}|${suffix}`;
        }
      : (): string => suffix;
  }

  /** Gentle swell on the sea plane; the sky/weather pass upgrades this later. */
  private patchSea(mat: THREE.MeshStandardMaterial, amplitude: number): void {
    const time = this.timeUniform;
    const amp = { value: amplitude };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.uniforms.uSwell = amp;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSwell;')
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vec3 locoWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
            'float locoWave = sin( locoWorld.x * 0.055 + uTime * 1.05 ) * 0.26',
            '  + sin( locoWorld.z * 0.081 - uTime * 0.86 ) * 0.19',
            '  + sin( ( locoWorld.x + locoWorld.z ) * 0.028 + uTime * 0.61 ) * 0.34;',
            'transformed.y += locoWave * uSwell;',
          ].join('\n'),
        );
    };
    mat.customProgramCacheKey = () => 'loco/sea-v1';
  }

  /** 0 = bone dry, 1 = streaming. Drives every registered surface at once. */
  setWetness(v: number): void {
    this._wetness = clamp01(v);
    this.wetnessUniform.value = this._wetness;
  }

  get wetness(): number {
    return this._wetness;
  }

  /** Advance animated materials. Cheap; safe to call every frame. */
  update(dt: number): void {
    this.timeUniform.value += dt;
    const seaMaps = this.cache.get('sea') as THREE.MeshStandardMaterial | undefined;
    if (seaMaps?.normalMap) {
      seaMaps.normalMap.offset.x = (this.timeUniform.value * 0.012) % 1;
      seaMaps.normalMap.offset.y = (this.timeUniform.value * 0.019) % 1;
      seaMaps.normalMap.needsUpdate = false;
    }
  }

  /** Every material the library currently owns — for debug overlays. */
  get all(): readonly THREE.Material[] {
    return this.owned;
  }

  /** How many of them carry a clearcoat lobe — for the perf overlay. */
  get physicalCount(): number {
    let n = 0;
    for (const m of this.owned) {
      if (m instanceof THREE.MeshPhysicalMaterial && m.clearcoat > 0) n++;
    }
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.cache.clear();
    sharedWetness.value = 0;
  }
}

/** Convenience for later layers that need a flat unlit-ish accent colour. */
export function accentMaterial(hex: number, roughness = 0.7): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: hex, roughness, metalness: 0.05 });
}
