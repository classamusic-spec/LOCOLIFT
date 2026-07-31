/**
 * Loco Lift — the cordillera on the horizon.
 *
 * Puerto Rico's central mountains and the El Yunque rainforest massif, seen
 * across the water from the islet. Four layered ridgelines with honest aerial
 * perspective: each further ridge is lighter, hazier and bluer, cloud caps
 * cling to the summits, and the whole range sits behind the sea and the city at
 * every time of day.
 *
 * **It is nearly free.** The entire range is *one* draw call and ~1.6 k
 * triangles: a single merged strip mesh carrying four concentric ridge shells,
 * each shell tagged with its layer index. The vertex shader slides each shell
 * with the camera at its own rate, which produces real inter-ridge parallax
 * from a static geometry and guarantees the range can never be driven into,
 * never intersects the playfield, and never leaves the far plane.
 *
 * **Depth contract.** `renderOrder = -3`, so the range draws after the sky dome
 * (`-1000`, which neither tests nor writes depth) and before the ocean (`-2`,
 * which does). It writes depth normally, so the sea occludes the ridge feet and
 * the mountains appear to rise out of the water — which is exactly what you see
 * from San Juan looking south toward the mainland. The dome is scaled to
 * `far * 0.42` (≈ 920 m at `camera.far` 2200) but is depth-test-free, so no
 * z-fighting is possible in either direction.
 *
 * **Colour.** The range never uses `THREE.Fog` — it computes its own haze from
 * the live fog colour the lighting rig publishes on `scene.fog`, so dawn,
 * midday, golden hour, dusk and storm all read correctly with no per-time-of-day
 * table duplicated here. Sun direction comes off the shared `world/sun` light.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import { clamp01, lerp, smoothstep } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------------ tuning */

interface RidgeLayer {
  /** metres from the (camera-tracked) centre */
  radius: number;
  /** metres above sea level at the highest summit */
  peak: number;
  /** metres above sea level along the saddles */
  base: number;
  /** how strongly this shell follows the camera; 1 = rigid, <1 = parallax */
  follow: number;
  /** forested base colour before haze */
  colour: number;
  /** how much of the ridge is dissolved into the horizon haze */
  haze: number;
  /** noise frequency along the azimuth */
  freq: number;
  seed: number;
}

/**
 * Four shells. The nearest is a dark rainforest foothill wall, the furthest a
 * pale blue ghost of the cordillera. Peak heights are chosen for *angular*
 * size, not geographic truth: El Yunque is 1065 m at 35 km, which subtends 1.7°.
 * At 1 km the same angle is 30 m, which reads as nothing — so the range is
 * compressed to 4–9° of sky, the size a mountain range occupies in memory.
 */
const LAYERS: readonly RidgeLayer[] = [
  { radius: 1020, peak: 96, base: 34, follow: 0.9, colour: 0x2f4a2c, haze: 0.34, freq: 5.5, seed: 0x51e },
  { radius: 1340, peak: 148, base: 52, follow: 0.94, colour: 0x36543f, haze: 0.5, freq: 3.9, seed: 0x9c2 },
  { radius: 1650, peak: 205, base: 74, follow: 0.97, colour: 0x466170, haze: 0.66, freq: 2.7, seed: 0x1f7 },
  { radius: 1950, peak: 268, base: 96, follow: 1.0, colour: 0x5c7590, haze: 0.8, freq: 1.9, seed: 0x7ad },
];

/** Azimuth samples per shell. 168 gives ~2° of arc — under a pixel at 1 km. */
const SAMPLES = 168;
/** The ridge feet sit well under the sea so the water always cuts them off. */
const FOOT_Y = -60;

/**
 * The sea window. `t` is |azimuth| measured from +Z (the open Atlantic in this
 * district's orientation, §4.1). Inside `open` the horizon is bare water;
 * outside `land` the full cordillera stands up. Between the two the range
 * fades away into distant headlands, which is what a coastline actually does.
 */
const SEA_OPEN = 0.30 * Math.PI;
const SEA_LAND = 0.62 * Math.PI;

/* ------------------------------------------------------------------ shader */

const VERT = /* glsl */ `
attribute vec3 aRidge;   // x = layer 0..1, y = 0 foot .. 1 crest, z = sun-facing term
varying vec3 vRidge;
varying vec3 vWorld;
varying float vDist;
uniform vec3 uCam;
uniform vec4 uFollow;

void main() {
  vRidge = aRidge;
  int layer = int( aRidge.x * 3.0 + 0.5 );
  float follow = layer == 0 ? uFollow.x : layer == 1 ? uFollow.y : layer == 2 ? uFollow.z : uFollow.w;
  vec3 p = position;
  p.x += uCam.x * follow;
  p.z += uCam.z * follow;
  vWorld = p;
  vDist = length( p.xz - uCam.xz );
  gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vRidge;
varying vec3 vWorld;
varying float vDist;

uniform vec3 uHaze;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uSunUp;
uniform float uTime;
uniform vec4 uHazeAmt;
uniform vec3 uColour0;
uniform vec3 uColour1;
uniform vec3 uColour2;
uniform vec3 uColour3;

float mtHash( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}
float mtNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = mtHash( i );
  float b = mtHash( i + vec2( 1.0, 0.0 ) );
  float c = mtHash( i + vec2( 0.0, 1.0 ) );
  float d = mtHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float mtFbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 4; i ++ ) {
    s += mtNoise( p ) * a;
    p *= 2.07;
    a *= 0.5;
  }
  return s;
}

void main() {
  int layer = int( vRidge.x * 3.0 + 0.5 );
  vec3 base = layer == 0 ? uColour0 : layer == 1 ? uColour1 : layer == 2 ? uColour2 : uColour3;
  float hazeAmt = layer == 0 ? uHazeAmt.x : layer == 1 ? uHazeAmt.y : layer == 2 ? uHazeAmt.z : uHazeAmt.w;

  float up = clamp( vRidge.y, 0.0, 1.0 );

  // forested texture: a coarse mottle plus a fine grain, both in world space so
  // the range never shows a repeating band along the horizon
  float grain = mtFbm( vec2( vWorld.x * 0.010, vWorld.y * 0.055 ) );
  float mottle = mtFbm( vec2( vWorld.x * 0.0032, vWorld.z * 0.0032 ) );
  vec3 col = base * ( 0.84 + grain * 0.30 + mottle * 0.12 );

  // ridge-facing sun term: warm on the lit flank, cold blue on the shadowed one
  float lit = clamp( vRidge.z * 0.5 + 0.5, 0.0, 1.0 );
  col = mix( col * 0.78, col * 1.1 + uSunCol * 0.12, lit * clamp( uSunUp * 1.6, 0.0, 1.0 ) );

  // valley haze: mist pools in the folds, so the feet of every ridge dissolve
  float valley = 1.0 - smoothstep( 0.0, 0.72, up );
  float haze = clamp( hazeAmt + valley * 0.42 * ( 1.0 - hazeAmt ), 0.0, 0.97 );

  // cloud caps clinging to the summits, drifting slowly along the range
  float capBand = smoothstep( 0.42, 0.96, up );
  float capNoise = mtFbm( vec2( vWorld.x * 0.0022 + uTime * 0.0035, vWorld.z * 0.0022 ) );
  float cap = capBand * smoothstep( 0.46, 0.78, capNoise );
  vec3 cloud = mix( uHaze, uSky, 0.35 ) * 1.06 + uSunCol * 0.05;

  col = mix( col, uHaze, haze );
  col = mix( col, cloud, cap * 0.75 );

  // distance haze on top, so a ridge that parallaxes closer also clears a little
  float d = clamp( ( vDist - 700.0 ) / 1600.0, 0.0, 1.0 );
  col = mix( col, uHaze, d * 0.30 );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------ ridges */

/** 1-D value noise over the azimuth, wrapped so the range closes seamlessly. */
function ridgeNoise(t: number, period: number, seed: number): number {
  const x = t * period;
  const i0 = Math.floor(x);
  const f = x - i0;
  const u = f * f * (3 - 2 * f);
  const h = (n: number): number => {
    const k = ((n % period) + period) % period;
    let v = Math.imul(k | 0, 0x27d4eb2d) ^ Math.imul(seed, 0x9e3779b1);
    v = Math.imul(v ^ (v >>> 15), 0x85ebca6b);
    v ^= v >>> 13;
    return ((v >>> 0) % 65536) / 65536;
  };
  return lerp(h(i0), h(i0 + 1), u);
}

/** Summit envelope: three named massifs so the skyline has real landmarks. */
function massif(t: number, seed: number): number {
  const rng = new RNG(seed);
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const centre = rng.range(0.18, 0.86);
    const width = rng.range(0.05, 0.16);
    const gain = rng.range(0.55, 1);
    const d = Math.abs(t - centre);
    sum = Math.max(sum, Math.exp(-((d / width) ** 2)) * gain);
  }
  return sum;
}

/* ------------------------------------------------------------------- layer */

export interface MountainOptions {
  /** override the number of azimuth samples per shell */
  samples?: number;
}

export class Mountains implements WorldLayer {
  readonly name = 'mountains';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: MountainOptions;
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private scene: THREE.Scene | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private _tris = 0;

  private uniforms = {
    uCam: { value: new THREE.Vector3() },
    uFollow: { value: new THREE.Vector4(0.9, 0.94, 0.97, 1.0) },
    uHaze: { value: new THREE.Color(0.78, 0.86, 0.92) },
    uSky: { value: new THREE.Color(0.42, 0.62, 0.86) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSunUp: { value: 1 },
    uTime: { value: 0 },
    uHazeAmt: { value: new THREE.Vector4(0.34, 0.5, 0.66, 0.8) },
    uColour0: { value: new THREE.Color() },
    uColour1: { value: new THREE.Color() },
    uColour2: { value: new THREE.Color() },
    uColour3: { value: new THREE.Color() },
  };

  constructor(quality: QualityTier, options: MountainOptions = {}) {
    this.quality = quality;
    this.options = options;
    this.group.name = 'world/mountains';
  }

  build(layout: CityLayout, opts: WorldOpts): void {
    void layout;
    this.scene = opts.scene;

    const samples = Math.max(
      48,
      Math.round((this.options.samples ?? SAMPLES) * (this.quality === 'low' ? 0.55 : 1)),
    );

    const pos: number[] = [];
    const ridge: number[] = [];
    const idx: number[] = [];

    for (let li = 0; li < LAYERS.length; li++) {
      const L = LAYERS[li];
      const layerT = li / (LAYERS.length - 1);
      const heights: number[] = [];
      const angles: number[] = [];

      for (let i = 0; i <= samples; i++) {
        const a = (i / samples) * Math.PI * 2 - Math.PI;
        angles.push(a);
        // |azimuth| from +Z: 0 straight out to sea, PI straight inland
        const t = Math.abs(a);
        const land = smoothstep((t - SEA_OPEN) / (SEA_LAND - SEA_OPEN));
        // 0 over open water, 0.35 along the coast, 1 inland
        const envelope = land * 0.65 + smoothstep((t - SEA_OPEN) / (Math.PI - SEA_OPEN)) * 0.35;
        const u = (a + Math.PI) / (Math.PI * 2);
        const rough =
          ridgeNoise(u, Math.round(L.freq * 6), L.seed) * 0.55 +
          ridgeNoise(u, Math.round(L.freq * 17), L.seed ^ 0x33) * 0.3 +
          ridgeNoise(u, Math.round(L.freq * 41), L.seed ^ 0x77) * 0.15;
        const h =
          (L.base + (L.peak - L.base) * (massif(u, L.seed) * 0.72 + rough * 0.5)) * envelope;
        heights.push(Math.max(h, 2));
      }
      // close the loop cleanly
      heights[samples] = heights[0];

      const sunFacing: number[] = [];
      for (let i = 0; i <= samples; i++) {
        const prev = heights[(i - 1 + samples) % samples];
        const next = heights[(i + 1) % samples];
        // slope along the range stands in for a facet normal; it is what makes
        // the far ridges read as folded land rather than as a cut-out
        sunFacing.push(clamp01((next - prev) / 60 + 0.5) * 2 - 1);
      }

      const base = pos.length / 3;
      for (let i = 0; i <= samples; i++) {
        const a = angles[i];
        const x = Math.sin(a) * L.radius;
        const z = Math.cos(a) * L.radius;
        pos.push(x, FOOT_Y, z);
        ridge.push(layerT, 0, sunFacing[i]);
        pos.push(x, heights[i], z);
        ridge.push(layerT, 1, sunFacing[i]);
      }
      for (let i = 0; i < samples; i++) {
        const a0 = base + i * 2;
        const b0 = a0 + 1;
        const a1 = base + (i + 1) * 2;
        const b1 = a1 + 1;
        idx.push(a0, a1, b1, a0, b1, b0);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aRidge', new THREE.Float32BufferAttribute(ridge, 3));
    geo.setIndex(
      pos.length / 3 > 65535
        ? new THREE.Uint32BufferAttribute(idx, 1)
        : new THREE.Uint16BufferAttribute(idx, 1),
    );
    geo.computeBoundingSphere();
    // the shell slides with the camera, so its static bounds mean nothing
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    this.geo = geo;
    this._tris = idx.length / 3;

    for (let i = 0; i < LAYERS.length; i++) {
      const c = [
        this.uniforms.uColour0,
        this.uniforms.uColour1,
        this.uniforms.uColour2,
        this.uniforms.uColour3,
      ][i];
      c.value.setHex(LAYERS[i].colour, THREE.SRGBColorSpace);
    }
    this.uniforms.uFollow.value.set(
      LAYERS[0].follow,
      LAYERS[1].follow,
      LAYERS[2].follow,
      LAYERS[3].follow,
    );
    this.uniforms.uHazeAmt.value.set(LAYERS[0].haze, LAYERS[1].haze, LAYERS[2].haze, LAYERS[3].haze);

    this.mat = new THREE.ShaderMaterial({
      name: 'loco/mountains',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.FrontSide,
      fog: false,
      depthWrite: true,
      depthTest: true,
      transparent: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'mountains/range';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // after the sky dome (-1000, depth-test-free), before the ocean (-2)
    this.mesh.renderOrder = -3;
    this.group.add(this.mesh);

    this.sun = (opts.scene.getObjectByName('world/sun') as THREE.DirectionalLight) ?? null;
  }

  update(cameraPos: THREE.Vector3, dt: number, timeOfDay: number): void {
    void timeOfDay;
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(cameraPos);

    // haze follows the lighting rig's fog exactly, so the range always meets the
    // horizon in the same colour the sea and the city fade to (§8.43)
    const fog = this.scene?.fog;
    if (fog && fog instanceof THREE.FogExp2) u.uHaze.value.copy(fog.color);
    else if (fog && fog instanceof THREE.Fog) u.uHaze.value.copy(fog.color);

    const sun = this.sun;
    if (sun) {
      u.uSunDir.value.copy(sun.position).sub(sun.target.position);
      const l = u.uSunDir.value.length();
      if (l > 1e-4) u.uSunDir.value.multiplyScalar(1 / l);
      else u.uSunDir.value.set(0, 1, 0);
      u.uSunCol.value.copy(sun.color);
      u.uSunUp.value = clamp01(u.uSunDir.value.y * 1.8) * clamp01(sun.intensity * 0.5);
    }
    // sky colour for the cloud caps: a touch above the haze, never below it
    u.uSky.value.copy(u.uHaze.value).lerp(new THREE.Color(0.32, 0.55, 0.86), 0.35);
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
  }

  stats(): Record<string, number> {
    return {
      mountainLayers: LAYERS.length,
      mountainTriangles: this._tris,
      mountainDrawCalls: this.mesh ? 1 : 0,
    };
  }

  dispose(): void {
    this.geo?.dispose();
    this.geo = null;
    this.mat?.dispose();
    this.mat = null;
    this.mesh = null;
    this.scene = null;
    this.sun = null;
    this.group.removeFromParent();
    this.group.clear();
  }
}
