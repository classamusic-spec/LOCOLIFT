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
 * **Wetness**: every opaque surface is patched through `onBeforeCompile` with a
 * shared `uWetness` uniform. The weather system calls `setWetness(0..1)`;
 * albedo darkens and roughness collapses, which is what actually sells rain.
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

interface MaterialSpec {
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
  side?: THREE.Side;
}

const SPECS: Record<MaterialId, MaterialSpec> = {
  /* — carriageways — */
  road: { surface: 'cobblestone', tile: 1.9, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 1 },
  roadCoastal: { surface: 'asphalt', tile: 5.5, color: 0xdedede, roughness: 1, metalness: 0, normal: 1, wetness: 1 },
  roadPlaza: { surface: 'cobblestone', tile: 2.2, color: 0xf3f2ee, roughness: 1, metalness: 0, normal: 0.9, wetness: 1 },
  alley: { surface: 'cobblestone', tile: 1.45, color: 0xe6e6ea, roughness: 1, metalness: 0, normal: 1.1, wetness: 1 },
  stairs: { surface: 'cobblestone', tile: 1.35, color: 0xdedee4, roughness: 1, metalness: 0, normal: 1.1, wetness: 1 },
  ramp: { surface: 'sandstone', tile: 2.0, color: 0x9d7a52, roughness: 1, metalness: 0, normal: 1, wetness: 1 },

  /* — kerb line and pavement — */
  kerb: { surface: 'kerbstone', tile: 2.6, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 1 },
  sidewalk: { surface: 'flagstone', tile: 2.4, color: 0xf2eee4, roughness: 1, metalness: 0, normal: 0.85, wetness: 1 },
  gutter: { surface: 'cobblestone', tile: 1.2, color: 0xa8adb8, roughness: 1, metalness: 0, normal: 1.2, wetness: 1 },

  /* — open areas — */
  plazaFlagstone: { surface: 'flagstone', tile: 4.2, color: 0xfffaf0, roughness: 1, metalness: 0, normal: 0.8, wetness: 1 },
  plazaCobble: { surface: 'cobblestone', tile: 1.9, color: 0xf6f6f8, roughness: 1, metalness: 0, normal: 1, wetness: 1 },
  marketFloor: { surface: 'flagstone', tile: 3.0, color: 0xe9cfae, roughness: 1, metalness: 0, normal: 0.7, wetness: 1 },
  promenade: { surface: 'flagstone', tile: 3.4, color: 0xf4ecdc, roughness: 1, metalness: 0, normal: 0.8, wetness: 1 },
  apron: { surface: 'asphalt', tile: 5.5, color: 0xcfcfcf, roughness: 1, metalness: 0, normal: 0.9, wetness: 1 },

  /* — landscape — */
  terrain: { surface: 'grass', tile: 5.5, color: 0xa9b98d, roughness: 1, metalness: 0, normal: 0.6, wetness: 0.6 },
  sand: { surface: 'sand', tile: 5.0, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.9 },
  grass: { surface: 'grass', tile: 4.0, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.5 },

  /* — water — */
  sea: { surface: 'seaFoam', tile: 26, color: 0x9fd3e4, roughness: 0.08, metalness: 0.08, normal: 1, wetness: 0 },
  seaDeep: { surface: 'seaFoam', tile: 52, color: 0x5f97b8, roughness: 0.12, metalness: 0.05, normal: 0.7, wetness: 0 },

  /* — vertical surfaces later modules will want — */
  fortStone: { surface: 'sandstone', tile: 4.5, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.8 },
  stucco: { surface: 'stucco', tile: 3.2, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.7 },
  roofTile: { surface: 'roofTile', tile: 2.2, color: 0xffffff, roughness: 1, metalness: 0, normal: 1, wetness: 0.9 },
};

const WET_CACHE_KEY = 'loco/wet-v1';

export class MaterialLibrary {
  readonly textures: TextureFactory;
  readonly quality: QualityTier;

  /** bound into every wettable material's program */
  readonly wetnessUniform = { value: 0 };
  /** advanced by `update`, drives the sea */
  readonly timeUniform = { value: 0 };

  private cache = new Map<string, THREE.Material>();
  private owned: THREE.Material[] = [];
  private _wetness = 0;
  private disposed = false;

  constructor(textures: TextureFactory, quality: QualityTier) {
    this.textures = textures;
    this.quality = quality;
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
   * wetness hook and disposed with the library.
   */
  register(key: string, mat: THREE.Material, wetness = 1): THREE.Material {
    if (wetness > 0 && mat instanceof THREE.MeshStandardMaterial) this.patchWetness(mat, wetness);
    this.cache.set(key, mat);
    this.owned.push(mat);
    return mat;
  }

  /** Memoised custom material slot for later world layers. */
  custom(key: string, build: () => THREE.Material, wetness = 1): THREE.Material {
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.register(key, build(), wetness);
  }

  get(id: MaterialId): THREE.MeshStandardMaterial {
    const hit = this.cache.get(id);
    if (hit) return hit as THREE.MeshStandardMaterial;

    const spec = SPECS[id];
    const maps = this.textures.surface(spec.surface);
    const mat = new THREE.MeshStandardMaterial({
      name: `loco/${id}`,
      color: spec.color,
      map: maps.map,
      normalMap: maps.normalMap ?? undefined,
      roughnessMap: maps.roughnessMap ?? undefined,
      roughness: spec.roughness,
      metalness: spec.metalness,
      side: spec.side ?? THREE.FrontSide,
      envMapIntensity: id === 'sea' || id === 'seaDeep' ? 1.5 : 0.85,
    });
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
    else if (spec.wetness > 0) this.patchWetness(mat, spec.wetness);

    this.cache.set(id, mat);
    this.owned.push(mat);
    return mat;
  }

  /**
   * Injects the shared wetness uniform. Wet stone is darker and far smoother;
   * the rain system just drives `setWetness`.
   */
  private patchWetness(mat: THREE.MeshStandardMaterial, amount: number): void {
    const wet = this.wetnessUniform;
    const amountUniform = { value: clamp01(amount) };
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      if (prev) prev.call(mat, shader, renderer);
      shader.uniforms.uWetness = wet;
      shader.uniforms.uWetAmount = amountUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uWetness;\nuniform float uWetAmount;',
        )
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n\tdiffuseColor.rgb *= mix( 1.0, 0.44, uWetness * uWetAmount );',
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, roughnessFactor * 0.13 + 0.025, uWetness * uWetAmount );',
        );
    };
    mat.customProgramCacheKey = () => WET_CACHE_KEY;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.cache.clear();
  }
}

/** Convenience for later layers that need a flat unlit-ish accent colour. */
export function accentMaterial(hex: number, roughness = 0.7): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: hex, roughness, metalness: 0.05 });
}

export { PALETTE };
