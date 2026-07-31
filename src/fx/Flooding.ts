/**
 * Loco Lift — street flooding.
 *
 * A hurricane does not just make the road shiny: it *fills* it. This layer owns
 * the standing water — where it pools, how deep it gets, how fast it drains,
 * what it looks like, and the query the vehicle reads so deep water actually
 * costs the player speed.
 *
 * ## The field
 *
 * At build time the district's height field is rasterised at 4 m and turned
 * into a **pond capacity** map:
 *
 *  - a separable box blur gives the local mean height over ~24 m;
 *  - `blurred − height` is the depression depth, which is where water goes;
 *  - the local gradient kills capacity on anything steep (the hillside streets
 *    run, they do not pool);
 *  - carriageways are stamped in from the road graph, because the gutter is
 *    where the water actually stands and the player needs to *see* the hazard
 *    on the driving line rather than on the verge;
 *  - a world-locked fbm breaks the pond edges up so they are puddles, not
 *    contour bands.
 *
 * The result is packed into one RGBA `DataTexture` (R = capacity, G = ground
 * height, B = breakup noise) that both the water surface and the debris field
 * sample, and into plain `Float32Array`s the CPU queries bilinearly. Nothing
 * searches anything at runtime.
 *
 * ## The curve
 *
 * `level` is a plain 0..1 fill fraction: **up over 45 s** of rain, **down over
 * 150 s** once it stops. The drain rate is deliberately the §5.1 puddle rate —
 * the standing water and the puddle term of the wetness model are the same
 * physical thing and must not disagree.
 *
 * Depth at a point is `capacity × level`, plus a storm **surge** term near sea
 * level so the beach and the lowest waterfront streets go under first.
 *
 * ## The surface
 *
 * One camera-relative grid, one draw call. It is a *lit* `MeshStandardMaterial`
 * — patched, not replaced — precisely so it picks up the street lamps, the sky
 * IBL and the storm's key light for free. A hand-written unlit water shader
 * would have to fake all three and would lose the single best thing about a wet
 * night in this city, which is fifty lamp reflections lying in the road.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import { fbm2D } from '../core/RNG';
import type { QualityTier } from '../core/types';
import { DISTRICT_BOUNDS, SEA_LEVEL } from '../world/CityLayout';
import type { CityLayout } from '../world/WorldTypes';
import type { WeatherDrive } from './Weather';

/* ------------------------------------------------------------------ tuning */

/** Raster pitch of the flood field, metres. */
const FIELD_CELL = 4;
/** Radius of the local-mean blur, metres. */
const BLUR_RADIUS = 24;
/** Deepest a street pool can get at `level = 1`, metres. */
export const POND_MAX = 0.5;
/** How far the storm surge lifts the water line at `level = 1`, metres. */
export const SURGE_MAX = 1.15;
/** Seconds of rain to fill from dry to full. */
export const FILL_SECONDS = 45;
/** Seconds to drain from full to dry — the §5.1 puddle rate. */
export const DRAIN_SECONDS = 150;
/** Depth below which water is a film, not a hazard, metres. */
export const FILM_DEPTH = 0.02;

/** Encoding headroom for the capacity channel. */
const CAP_RANGE = 0.5;

interface GridSpec {
  /** half-extent of the camera-relative water grid, metres */
  half: number;
  /** cell pitch, metres */
  cell: number;
}

const GRID: Record<QualityTier, GridSpec> = {
  low: { half: 70, cell: 3.4 },
  medium: { half: 105, cell: 3.0 },
  high: { half: 132, cell: 2.6 },
  ultra: { half: 150, cell: 2.4 },
};

/* -------------------------------------------------------------- shader bits */

/** Injected into the patched standard material's vertex shader. */
const FLOOD_VERT_PARS = /* glsl */ `
uniform sampler2D uFloodField;
uniform vec4  uFieldXf;
uniform vec2  uCenter;
uniform float uLevel;
uniform float uSurgeY;
uniform float uSurgeOn;
uniform float uMinY;
uniform float uYRange;
uniform float uCapRange;
uniform float uHalf;

varying float vFloodDepth;
varying float vFloodNoise;
varying vec3  vFloodWorld;
varying float vFloodEdge;
`;

const FLOOD_VERT_BODY = /* glsl */ `
  vec3 locoW = vec3( position.x + uCenter.x, 0.0, position.z + uCenter.y );
  vec2 locoUv = ( locoW.xz - uFieldXf.xy ) * uFieldXf.zw;
  vec4 locoF = texture2D( uFloodField, clamp( locoUv, vec2( 0.0015 ), vec2( 0.9985 ) ) );
  float locoCap = locoF.r * uCapRange;
  float locoGround = locoF.g * uYRange + uMinY;
  float locoPond = locoCap * uLevel;
  // surge only exists on land that is genuinely near sea level; above that the
  // sheet would float over the hillside with nothing holding it up. The
  // waterline is broken up by the same noise the CPU query uses, so the edge of
  // the flooded beach is a ragged run-up rather than a contour line.
  float locoSurgeY = uSurgeY + ( locoF.b - 0.5 ) * 0.4;
  float locoSurge = max( 0.0, locoSurgeY - locoGround ) * step( 0.10, locoGround ) * uSurgeOn;
  float locoDepth = max( locoPond, min( locoSurge, 1.6 ) );

  vFloodDepth = locoDepth;
  vFloodNoise = locoF.b;
  // the surface sits a hair under the true water line so the kerb still reads
  locoW.y = locoGround + locoDepth * 0.88 + 0.018;
  vFloodWorld = locoW;
  vFloodEdge = 1.0 - smoothstep( uHalf * 0.72, uHalf * 0.97, max( abs( position.x ), abs( position.z ) ) );
  transformed = locoW;
`;

const FLOOD_FRAG_PARS = /* glsl */ `
uniform float uFloodTime;
uniform vec2  uFloodWind;
uniform float uRainImpact;
uniform float uFloodOpacity;
uniform vec3  uFoamTint;

varying float vFloodDepth;
varying float vFloodNoise;
varying vec3  vFloodWorld;
varying float vFloodEdge;

float locoFloodHash( vec2 p ) {
  p = fract( p * vec2( 341.17, 617.53 ) );
  p += dot( p, p + 31.71 );
  return fract( p.x * p.y );
}

/**
 * Rain hitting standing water. One hash per fragment: the cell owns a ring
 * whose radius grows and fades, which is enough to make the surface read as
 * *being rained on* rather than as a mirror someone left in the street.
 */
vec2 locoImpactRipple( vec2 world, float t ) {
  vec2 cell = floor( world * 1.35 );
  vec2 local = fract( world * 1.35 ) - 0.5;
  float h = locoFloodHash( cell );
  float phase = fract( t * 1.7 + h );
  float r = phase * 0.46;
  float d = length( local );
  float ring = exp( -pow( ( d - r ) * 15.0, 2.0 ) ) * ( 1.0 - phase );
  vec2 dir = d > 1e-4 ? local / d : vec2( 0.0, 1.0 );
  return dir * ring * 0.55;
}

/** Wind-driven chop: two non-parallel travelling ripple fields. */
vec2 locoWindRipple( vec2 world, vec2 wind, float t ) {
  vec2 d1 = normalize( wind + vec2( 0.31, 0.0 ) );
  vec2 d2 = normalize( vec2( -d1.y, d1.x ) + d1 * 0.42 );
  float a = sin( dot( world, d1 ) * 2.05 - t * 3.1 );
  float b = sin( dot( world, d2 ) * 3.35 - t * 2.15 );
  float c = sin( dot( world, d1 ) * 6.7 - t * 5.4 );
  return d1 * ( a * 0.5 + c * 0.16 ) + d2 * ( b * 0.34 );
}
`;

/* ------------------------------------------------------------------- layer */

export interface FloodingOptions {
  /** scale on the pond capacity map, for tuning */
  capacityScale?: number;
}

export class Flooding {
  readonly group = new THREE.Group();

  /** 0..1 fill fraction. Public so the HUD or QA can read it. */
  private _level = 0;
  private _surgeY = SEA_LEVEL;

  private quality: QualityTier;
  private options: FloodingOptions;

  /* field */
  private fieldW = 0;
  private fieldH = 0;
  private fieldMinX = 0;
  private fieldMinZ = 0;
  private fieldInvX = 1;
  private fieldInvZ = 1;
  private capacity: Float32Array = new Float32Array(0);
  private ground: Float32Array = new Float32Array(0);
  /** 0..1 world-locked noise; keeps the CPU surge edge identical to the shader's */
  private breakup: Float32Array = new Float32Array(0);
  private minY = 0;
  private yRange = 1;
  private _tex: THREE.DataTexture | null = null;
  private xf = new THREE.Vector4(0, 0, 1, 1);

  /* surface */
  private mesh: THREE.Mesh | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.MeshStandardMaterial | null = null;
  private uniforms = {
    uFloodField: { value: null as THREE.Texture | null },
    uFieldXf: { value: new THREE.Vector4(0, 0, 1, 1) },
    uCenter: { value: new THREE.Vector2() },
    uLevel: { value: 0 },
    uSurgeY: { value: 0 },
    uSurgeOn: { value: 0 },
    uMinY: { value: 0 },
    uYRange: { value: 1 },
    uCapRange: { value: CAP_RANGE },
    uHalf: { value: 1 },
    uFloodTime: { value: 0 },
    uFloodWind: { value: new THREE.Vector2(1, 0) },
    uRainImpact: { value: 0 },
    uFloodOpacity: { value: 0 },
    uFoamTint: { value: new THREE.Color(0.7, 0.78, 0.8) },
  };

  private buildMs = 0;
  private _tris = 0;
  private disposed = false;

  constructor(quality: QualityTier, options: FloodingOptions = {}) {
    this.quality = quality;
    this.options = { capacityScale: 1, ...options };
    this.group.name = 'fx/flooding';
    this.group.renderOrder = 6;
  }

  /* ------------------------------------------------------------- lifecycle */

  build(layout: CityLayout): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.buildField(layout);
    this.buildSurface();
    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.destroySurface();
    this.buildSurface();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroySurface();
    this._tex?.dispose();
    this._tex = null;
    this.group.removeFromParent();
    this.group.clear();
  }

  /* ------------------------------------------------------------------ state */

  /** 0..1 fill fraction. */
  get level(): number {
    return this._level;
  }

  /** World Y the storm surge has lifted the waterline to. */
  get surgeY(): number {
    return this._surgeY;
  }

  /** The shared field texture, for anything else that wants ground height. */
  get fieldTexture(): THREE.DataTexture | null {
    return this._tex;
  }

  get fieldTransform(): THREE.Vector4 {
    return this.xf;
  }

  get fieldMinY(): number {
    return this.minY;
  }

  get fieldYRange(): number {
    return this.yRange;
  }

  /* ------------------------------------------------------------------ query */

  /** Standing water depth in metres at a world XZ. 0 = dry. Never NaN. */
  depthAt(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const pond = this.sample(this.capacity, x, z) * this._level;
    let d = pond;
    if (this._surgeY > SEA_LEVEL + 1e-4) {
      const g = this.sample(this.ground, x, z);
      if (g > 0.1) {
        const surgeY = this._surgeY + (this.sample(this.breakup, x, z) - 0.5) * 0.4;
        const surge = Math.min(surgeY - g, 1.6);
        if (surge > d) d = surge;
      }
    }
    return d > 0 ? d : 0;
  }

  /** Ground height from the baked field — cheaper than the layout query. */
  groundAt(x: number, z: number): number {
    return this.sample(this.ground, x, z);
  }

  /** World Y of the water surface at a point (ground when dry). */
  surfaceYAt(x: number, z: number): number {
    return this.sample(this.ground, x, z) + this.depthAt(x, z);
  }

  /** Pond capacity in metres at `level = 1`, ignoring surge. */
  capacityAt(x: number, z: number): number {
    return this.sample(this.capacity, x, z);
  }

  /* ------------------------------------------------------------------- tick */

  /**
   * Advance the fill/drain curve and drive the surface.
   *
   * The target is the weather's own crossfade amount, so a shower that fades
   * out stops filling before it stops raining, exactly as it should.
   */
  update(drive: WeatherDrive, dt: number): void {
    const target = clamp01(drive.amount * lerp(0.46, 1, drive.storm));
    if (target > this._level) {
      this._level = Math.min(target, this._level + dt / FILL_SECONDS);
    } else {
      this._level = Math.max(target, this._level - dt / DRAIN_SECONDS);
    }
    this._surgeY = SEA_LEVEL + SURGE_MAX * this._level * drive.storm;

    const mesh = this.mesh;
    const mat = this.mat;
    if (!mesh || !mat) return;

    const spec = GRID[this.quality];
    const visible = this._level > 0.004;
    mesh.visible = visible;
    if (!visible) return;

    // snap the grid so the tessellation does not crawl under the reflections
    const snap = spec.cell;
    const cx = Math.round(drive.camera.x / snap) * snap;
    const cz = Math.round(drive.camera.z / snap) * snap;
    const u = this.uniforms;
    u.uCenter.value.set(cx, cz);
    u.uLevel.value = this._level;
    u.uSurgeY.value = this._surgeY;
    u.uSurgeOn.value = drive.storm > 0.02 ? 1 : 0;
    u.uFloodTime.value = drive.time;
    u.uFloodWind.value.copy(drive.windDir);
    u.uRainImpact.value = drive.amount;
    // a film is nearly invisible; a real pool is a mirror
    u.uFloodOpacity.value = clamp01(0.34 + this._level * 0.62);

    // the water body picks up the sky it is reflecting
    mat.color.copy(drive.light.fogColor).multiplyScalar(0.16);
    mat.color.r = Math.min(mat.color.r + 0.012, 1);
    mat.color.g = Math.min(mat.color.g + 0.016, 1);
    mat.color.b = Math.min(mat.color.b + 0.022, 1);
    u.uFoamTint.value.copy(drive.light.fogColor).lerp(WHITE, 0.35);
  }

  /* ------------------------------------------------------------------ field */

  private buildField(layout: CityLayout): void {
    const minX = DISTRICT_BOUNDS.minX;
    const maxX = DISTRICT_BOUNDS.maxX;
    const minZ = DISTRICT_BOUNDS.minZ;
    const maxZ = DISTRICT_BOUNDS.maxZ;
    const w = Math.ceil((maxX - minX) / FIELD_CELL) + 1;
    const h = Math.ceil((maxZ - minZ) / FIELD_CELL) + 1;
    this.fieldW = w;
    this.fieldH = h;
    this.fieldMinX = minX;
    this.fieldMinZ = minZ;
    this.fieldInvX = 1 / FIELD_CELL;
    this.fieldInvZ = 1 / FIELD_CELL;
    this.xf.set(minX, minZ, 1 / ((w - 1) * FIELD_CELL), 1 / ((h - 1) * FIELD_CELL));

    const n = w * h;
    const height = new Float32Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < h; j++) {
      const z = minZ + j * FIELD_CELL;
      for (let i = 0; i < w; i++) {
        const x = minX + i * FIELD_CELL;
        const y = layout.groundHeight(x, z);
        height[j * w + i] = y;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    this.minY = lo - 0.5;
    this.yRange = Math.max(1, hi - lo + 1);

    /* --- local mean, separable box blur --- */
    const r = Math.max(1, Math.round(BLUR_RADIUS / FIELD_CELL));
    const blur = boxBlur2D(height, w, h, r);

    /* --- carriageway mask --- */
    const road = new Float32Array(n);
    stampRoads(layout, road, w, h, minX, minZ, FIELD_CELL);

    /* --- capacity --- */
    const cap = new Float32Array(n);
    const scale = this.options.capacityScale ?? 1;
    for (let j = 0; j < h; j++) {
      const z = minZ + j * FIELD_CELL;
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const y = height[k];
        // depression: how far below the local mean this cell sits
        const dip = blur[k] - y;
        let c = clamp01((dip - 0.03) / 0.42);

        // slope kill — water runs off anything that is not close to level
        const xm = height[j * w + Math.max(0, i - 1)];
        const xp = height[j * w + Math.min(w - 1, i + 1)];
        const zm = height[Math.max(0, j - 1) * w + i];
        const zp = height[Math.min(h - 1, j + 1) * w + i];
        const gx = (xp - xm) / (2 * FIELD_CELL);
        const gz = (zp - zm) / (2 * FIELD_CELL);
        const slope = Math.hypot(gx, gz);
        c *= 1 - sstep(0.07, 0.2, slope);

        // the gutter is where it stands, and where the player will meet it
        const rm = road[k];
        c *= 0.22 + 0.78 * rm;

        // world-locked breakup so pond edges are puddles, not contours
        const x = minX + i * FIELD_CELL;
        const nz = fbm2D(x * 0.055, z * 0.055, 3, 0x51e2);
        c *= clamp01(0.42 + nz * 1.05);

        // nothing pools below sea level; that is the ocean's job
        if (y < SEA_LEVEL + 0.15) c = 0;

        cap[k] = clamp(c * POND_MAX * scale, 0, CAP_RANGE);
      }
    }
    // one light smoothing pass so the surface has no 4 m stair-stepping
    const capSmooth = boxBlur2D(cap, w, h, 1);

    this.capacity = capSmooth;
    this.ground = height;

    /* --- pack --- */
    const noise = new Float32Array(n);
    const data = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) {
      const x = minX + (k % w) * FIELD_CELL;
      const z = minZ + Math.floor(k / w) * FIELD_CELL;
      // quantised to 8 bits here so the CPU query and the shader agree exactly
      const b = Math.round(clamp01(fbm2D(x * 0.13, z * 0.13, 2, 0x9a17) * 0.5 + 0.5) * 255);
      noise[k] = b / 255;
      data[k * 4] = Math.round(clamp01(capSmooth[k] / CAP_RANGE) * 255);
      data[k * 4 + 1] = Math.round(clamp01((height[k] - this.minY) / this.yRange) * 255);
      data[k * 4 + 2] = b;
      data[k * 4 + 3] = 255;
    }
    this.breakup = noise;
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.name = 'loco/floodField';
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._tex = tex;
  }

  /** Bilinear sample of a field array. Clamped, so it is defined everywhere. */
  private sample(field: Float32Array, x: number, z: number): number {
    if (field.length === 0) return 0;
    const fx = clamp((x - this.fieldMinX) * this.fieldInvX, 0, this.fieldW - 1.001);
    const fz = clamp((z - this.fieldMinZ) * this.fieldInvZ, 0, this.fieldH - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const w = this.fieldW;
    const a = field[j * w + i];
    const b = field[j * w + i + 1];
    const c = field[(j + 1) * w + i];
    const d = field[(j + 1) * w + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /* ---------------------------------------------------------------- surface */

  private buildSurface(): void {
    const spec = GRID[this.quality];
    const cells = Math.max(8, Math.round((spec.half * 2) / spec.cell));
    const geo = new THREE.PlaneGeometry(spec.half * 2, spec.half * 2, cells, cells);
    geo.rotateX(-Math.PI / 2);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._tris = cells * cells * 2;

    const u = this.uniforms;
    u.uFloodField.value = this._tex;
    u.uFieldXf.value.copy(this.xf);
    u.uMinY.value = this.minY;
    u.uYRange.value = this.yRange;
    u.uHalf.value = spec.half;

    const mat = new THREE.MeshStandardMaterial({
      name: 'loco/floodWater',
      color: 0x0a1116,
      roughness: 0.045,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      envMapIntensity: 1.6,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${FLOOD_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FLOOD_VERT_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FLOOD_FRAG_PARS}`)
        .replace(
          '#include <normal_fragment_begin>',
          [
            '#include <normal_fragment_begin>',
            'vec2 locoRip = locoWindRipple( vFloodWorld.xz, uFloodWind, uFloodTime );',
            'locoRip += locoImpactRipple( vFloodWorld.xz, uFloodTime ) * uRainImpact;',
            '// shallow water shows the road under it, so it ripples less',
            'float locoRipAmt = 0.02 + smoothstep( 0.01, 0.16, vFloodDepth ) * 0.075;',
            'vec3 locoPert = vec3( locoRip.x, 0.0, locoRip.y ) * locoRipAmt;',
            'normal = normalize( normal + ( viewMatrix * vec4( locoPert, 0.0 ) ).xyz );',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            '#include <dithering_fragment>',
            '// a whisper of wind-driven scum/foam so deep water is not pure mirror',
            'float locoFoam = smoothstep( 0.55, 0.95, vFloodNoise ) * smoothstep( 0.06, 0.3, vFloodDepth ) * 0.16;',
            'gl_FragColor.rgb = mix( gl_FragColor.rgb, uFoamTint, locoFoam );',
          ].join('\n'),
        )
        .replace(
          '#include <alphatest_fragment>',
          [
            '#include <alphatest_fragment>',
            'if ( vFloodDepth < 0.0035 ) discard;',
            'float locoA = smoothstep( 0.004, 0.055, vFloodDepth );',
            'locoA *= 0.5 + 0.5 * smoothstep( 0.04, 0.24, vFloodDepth );',
            'diffuseColor.a *= locoA * vFloodEdge * uFloodOpacity;',
          ].join('\n'),
        );
    };
    mat.customProgramCacheKey = () => 'loco/flood-v1';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/floodWater';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 6;
    mesh.visible = false;
    this.group.add(mesh);

    this.geo = geo;
    this.mat = mat;
    this.mesh = mesh;
  }

  private destroySurface(): void {
    if (this.mesh) this.group.remove(this.mesh);
    this.geo?.dispose();
    this.mat?.dispose();
    this.geo = null;
    this.mat = null;
    this.mesh = null;
  }

  /* ------------------------------------------------------------------ stats */

  stats(): Record<string, number> {
    return {
      floodLevel: Number(this._level.toFixed(3)),
      floodSurgeY: Number(this._surgeY.toFixed(3)),
      floodFieldCells: this.fieldW * this.fieldH,
      floodTriangles: this._tris,
      floodBuildMs: Number(this.buildMs.toFixed(1)),
    };
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/* ---------------------------------------------------------------- helpers */

function sstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Separable box blur with running sums. O(n) regardless of radius. */
function boxBlur2D(src: Float32Array, w: number, h: number, r: number): Float32Array {
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

/**
 * Paint the carriageways into a 0..1 mask. Walked from the road graph rather
 * than raycast, so it costs a few thousand stamps at build and nothing after.
 */
function stampRoads(
  layout: CityLayout,
  mask: Float32Array,
  w: number,
  h: number,
  minX: number,
  minZ: number,
  cell: number,
): void {
  const roads = layout.roads;
  const p = new THREE.Vector3();
  for (let e = 0; e < roads.edges.length; e++) {
    const ed = roads.edges[e];
    // stairs and rooftops drain; they never carry standing water
    if (ed.kind === 'stairs' || ed.kind === 'rooftop' || ed.kind === 'ramp') continue;
    const steps = Math.max(2, Math.round(ed.length / 2.5));
    const rad = ed.width * 0.5 + 0.6;
    const cellsR = Math.ceil(rad / cell);
    for (let s = 0; s <= steps; s++) {
      roads.sample(e, s / steps, 0, p);
      const ci = Math.round((p.x - minX) / cell);
      const cj = Math.round((p.z - minZ) / cell);
      for (let j = cj - cellsR; j <= cj + cellsR; j++) {
        if (j < 0 || j >= h) continue;
        for (let i = ci - cellsR; i <= ci + cellsR; i++) {
          if (i < 0 || i >= w) continue;
          const dx = minX + i * cell - p.x;
          const dz = minZ + j * cell - p.z;
          const d = Math.hypot(dx, dz);
          if (d > rad) continue;
          // the gutter holds more than the crown of the road
          const v = 0.55 + 0.45 * sstep(rad * 0.35, rad, d);
          const k = j * w + i;
          if (v > mask[k]) mask[k] = v;
        }
      }
    }
  }
}
