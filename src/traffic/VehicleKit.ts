/**
 * Loco Lift — procedural traffic vehicles.
 *
 * Everything that drives itself around Old San Juan is built here from
 * Three.js primitives and rendered through **one InstancedMesh per type**, so
 * forty cars cost seven draw calls, not forty.
 *
 * ART_REFERENCE §7.2 is binding on what exists: ordinary modern Caribbean-US
 * traffic — hatchbacks, sedans, pickups, a small box van, the white 15-seat
 * *público*, the free white/green Old San Juan **trolley** and a Policía de
 * Puerto Rico cruiser. Explicitly **no 1950s Havana cars**.
 *
 * ## How one instanced mesh gets forty different cars
 *
 * Each vertex carries two extra attributes:
 *
 *  - `aRole`  — what this vertex *is*: baked colour, body paint, trim, brake
 *               lamp, left/right indicator, headlamp.
 *  - `aWheel` — `xyz` = wheel pivot, `w` = 0 none / 1 rear / 2 steering front.
 *
 * and each instance carries:
 *
 *  - `iPaint` / `iTrim` — the two tintable colours,
 *  - `iLights`          — brake, indicator-L, indicator-R, headlamp levels,
 *  - `iWheel`           — wheel roll angle and front-wheel steer angle.
 *
 * A small `onBeforeCompile` patch resolves the role in the vertex shader,
 * rotates the wheels about their pivots and pushes a per-vertex emissive into
 * the fragment stage. A matching patch on a `MeshDepthMaterial` keeps the
 * shadow pass in sync (otherwise the shadows show unrotated wheels).
 *
 * Beyond `SPAWN.imposterDistance` an agent is drawn from a single shared
 * **imposter** mesh — one unit-box silhouette scaled to the type's bounding
 * box — so distant traffic costs one draw call for all types combined.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RNG } from '../core/RNG';
import {
  CAR_PAINT,
  CAR_PAINT_WEIGHTS,
  LIGHTS,
  POLICE_PAINT,
  POLICE_TRIM,
  PUBLICO_PAINT,
  PUBLICO_STRIPE,
  TROLLEY_PAINT,
  TROLLEY_TRIM,
  VAN_STRIPE,
} from './TrafficTuning';

/* ================================================================== roles */

/** Vertex colour roles. Must match the switch in the injected vertex shader. */
export const ROLE = {
  /** baked vertex colour, untouched */
  STATIC: 0,
  /** multiplied by the instance's body paint */
  PAINT: 1,
  /** multiplied by the instance's trim/livery colour */
  TRIM: 2,
  /** red lamp driven by `iLights.x` */
  BRAKE: 3,
  /** lamp driven by `iLights.y` (also the police bar's blue half) */
  INDL: 4,
  /** lamp driven by `iLights.z` (also the police bar's red half) */
  INDR: 5,
  /** lamp driven by `iLights.w` */
  HEAD: 6,
} as const;

/** `aWheel.w` modes. */
export const WHEEL = { NONE: 0, REAR: 1, FRONT: 2 } as const;

/* =========================================================== part builder */

const _color = new THREE.Color();
const _mat4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

/**
 * Collects tinted, positioned primitives and fuses them into one geometry
 * carrying the traffic vertex attributes.
 */
export class VehicleParts {
  private readonly list: THREE.BufferGeometry[] = [];

  /**
   * @param geo   primitive, already positioned in vehicle space
   *              (origin on the road, forward = −Z, up = +Y)
   * @param hex   baked vertex colour; for `ROLE.PAINT`/`ROLE.TRIM` this acts as
   *              a shade multiplier on the instance colour (use 0xffffff for
   *              the pure colour, 0xb0b0b0 for a shadowed panel)
   * @param role  see {@link ROLE}
   * @param wheelMode see {@link WHEEL}
   * @param pivot wheel pivot in vehicle space (required when `wheelMode` ≠ 0)
   */
  add(
    geo: THREE.BufferGeometry,
    hex: number,
    role: number = ROLE.STATIC,
    wheelMode: number = WHEEL.NONE,
    pivot?: THREE.Vector3,
  ): void {
    const count = geo.attributes.position.count;
    _color.setHex(hex, THREE.SRGBColorSpace);

    const col = new Float32Array(count * 3);
    const rol = new Float32Array(count);
    const whl = new Float32Array(count * 4);
    const px = pivot ? pivot.x : 0;
    const py = pivot ? pivot.y : 0;
    const pz = pivot ? pivot.z : 0;
    for (let i = 0; i < count; i++) {
      col[i * 3] = _color.r;
      col[i * 3 + 1] = _color.g;
      col[i * 3 + 2] = _color.b;
      rol[i] = role;
      whl[i * 4] = px;
      whl[i * 4 + 1] = py;
      whl[i * 4 + 2] = pz;
      whl[i * 4 + 3] = wheelMode;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aRole', new THREE.BufferAttribute(rol, 1));
    geo.setAttribute('aWheel', new THREE.BufferAttribute(whl, 4));
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    this.list.push(geo);
  }

  build(name: string): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list, false);
    if (!merged) throw new Error(`VehicleKit: failed to merge "${name}"`);
    for (const g of this.list) if (g !== merged) g.dispose();
    this.list.length = 0;
    merged.name = name;
    return merged;
  }
}

/* ------------------------------------------------------ primitive helpers */

function place(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    _euler.set(rx, ry, rz);
    _quat.setFromEuler(_euler);
    _mat4.makeRotationFromQuaternion(_quat);
    _mat4.setPosition(x, y, z);
  } else {
    _mat4.makeTranslation(x, y, z);
  }
  geo.applyMatrix4(_mat4);
  return geo;
}

const box = (w: number, h: number, d: number): THREE.BoxGeometry =>
  new THREE.BoxGeometry(w, h, d);

/** Wedge/taper: a box whose top face is narrowed in X and shifted in Z. */
function taperBox(
  w: number,
  h: number,
  d: number,
  topScaleX: number,
  topScaleZ: number,
  topShiftZ: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * topScaleX);
      pos.setZ(i, pos.getZ(i) * topScaleZ + topShiftZ);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** A disc/cylinder whose axis runs along X — i.e. a road wheel. */
const wheelCylinder = (radius: number, width: number, seg: number): THREE.BufferGeometry => {
  const g = new THREE.CylinderGeometry(radius, radius, width, seg, 1, false);
  g.rotateZ(Math.PI / 2);
  return g;
};

/* ================================================== shared shader plumbing */

const PARS_VERTEX = /* glsl */ `
attribute float aRole;
attribute vec4 aWheel;
attribute vec3 iPaint;
attribute vec3 iTrim;
attribute vec4 iLights;
attribute vec2 iWheel;
varying vec3 vLocoEmissive;
`;

const PARS_VERTEX_DEPTH = /* glsl */ `
attribute vec4 aWheel;
attribute vec2 iWheel;
`;

/** Roll about the wheel's own X axis, then steer the fronts about Y. */
const WHEEL_POSITION = /* glsl */ `
if ( aWheel.w > 0.5 ) {
  vec3 locoRel = transformed - aWheel.xyz;
  float locoCa = cos( iWheel.x );
  float locoSa = sin( iWheel.x );
  locoRel = vec3( locoRel.x, locoRel.y * locoCa - locoRel.z * locoSa, locoRel.y * locoSa + locoRel.z * locoCa );
  if ( aWheel.w > 1.5 ) {
    float locoCs = cos( iWheel.y );
    float locoSs = sin( iWheel.y );
    locoRel = vec3( locoRel.x * locoCs + locoRel.z * locoSs, locoRel.y, -locoRel.x * locoSs + locoRel.z * locoCs );
  }
  transformed = aWheel.xyz + locoRel;
}
`;

const WHEEL_NORMAL = /* glsl */ `
if ( aWheel.w > 0.5 ) {
  float locoNa = iWheel.x;
  float locoNc = cos( locoNa );
  float locoNs = sin( locoNa );
  objectNormal = vec3( objectNormal.x, objectNormal.y * locoNc - objectNormal.z * locoNs, objectNormal.y * locoNs + objectNormal.z * locoNc );
  if ( aWheel.w > 1.5 ) {
    float locoMc = cos( iWheel.y );
    float locoMs = sin( iWheel.y );
    objectNormal = vec3( objectNormal.x * locoMc + objectNormal.z * locoMs, objectNormal.y, -objectNormal.x * locoMs + objectNormal.z * locoMc );
  }
}
`;

// NOTE: vColor is vec4 under USE_COLOR_ALPHA and vec3 otherwise; always
// swizzle .rgb so this compiles either way.
const ROLE_RESOLVE = /* glsl */ `
vec3 locoBase = vColor.rgb;
vLocoEmissive = vec3( 0.0 );
if ( aRole > 0.5 ) {
  if ( aRole < 1.5 ) {
    locoBase *= iPaint;
  } else if ( aRole < 2.5 ) {
    locoBase *= iTrim;
  } else {
    float locoLevel;
    float locoGain;
    if ( aRole < 3.5 ) { locoLevel = iLights.x; locoGain = ${LIGHTS.brakeGain.toFixed(2)}; }
    else if ( aRole < 4.5 ) { locoLevel = iLights.y; locoGain = ${LIGHTS.indicatorGain.toFixed(2)}; }
    else if ( aRole < 5.5 ) { locoLevel = iLights.z; locoGain = ${LIGHTS.indicatorGain.toFixed(2)}; }
    else { locoLevel = iLights.w; locoGain = ${LIGHTS.headGain.toFixed(2)}; }
    locoLevel = max( locoLevel, ${LIGHTS.dayResidual.toFixed(3)} );
    vLocoEmissive = vColor.rgb * locoGain * locoLevel;
    locoBase = vColor.rgb * mix( 0.42, 1.0, min( 1.0, locoLevel * 1.6 ) );
  }
}
vColor.rgb = locoBase;
`;

/** Applies the traffic vertex patch to a lit material and its depth twin. */
export function patchVehicleMaterial(mat: THREE.Material, depth = false): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${depth ? PARS_VERTEX_DEPTH : PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WHEEL_POSITION}`);
    if (!depth) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${WHEEL_NORMAL}`)
        .replace('#include <color_vertex>', `#include <color_vertex>\n${ROLE_RESOLVE}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocoEmissive;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vLocoEmissive;',
        );
    }
  };
  mat.customProgramCacheKey = () => (depth ? 'loco/traffic-depth-v1' : 'loco/traffic-lit-v1');
}

/** The one lit material every traffic vehicle and scooter shares. */
export function createVehicleMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'loco/traffic',
    vertexColors: true,
    roughness: 0.48,
    metalness: 0.18,
    envMapIntensity: 0.9,
  });
  patchVehicleMaterial(mat, false);
  return mat;
}

/** Depth twin so shadows show rotated wheels rather than a frozen pose. */
export function createVehicleDepthMaterial(): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchVehicleMaterial(mat, true);
  return mat;
}

/* ============================================================== the fleet */

/**
 * One InstancedMesh plus its per-instance attribute buffers. Written
 * compactly from index 0 every frame; `count` is the live population.
 */
export class InstancedFleet {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  readonly triangles: number;

  private readonly paint: THREE.InstancedBufferAttribute;
  private readonly trim: THREE.InstancedBufferAttribute;
  private readonly lights: THREE.InstancedBufferAttribute;
  private readonly wheel: THREE.InstancedBufferAttribute;
  private cursor = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    depthMaterial: THREE.Material | null,
    capacity: number,
    name: string,
    castShadow: boolean,
  ) {
    this.capacity = capacity;
    const idx = geometry.getIndex();
    const verts = idx ? idx.count : geometry.attributes.position.count;
    this.triangles = Math.floor(verts / 3);

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = `loco/fleet/${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (depthMaterial) this.mesh.customDepthMaterial = depthMaterial;

    this.paint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.trim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.lights = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.wheel = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.paint.setUsage(THREE.DynamicDrawUsage);
    this.trim.setUsage(THREE.DynamicDrawUsage);
    this.lights.setUsage(THREE.DynamicDrawUsage);
    this.wheel.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iPaint', this.paint);
    geometry.setAttribute('iTrim', this.trim);
    geometry.setAttribute('iLights', this.lights);
    geometry.setAttribute('iWheel', this.wheel);
  }

  begin(): void {
    this.cursor = 0;
  }

  /** Returns false when the fleet is full (never happens in practice). */
  push(
    matrix: THREE.Matrix4,
    paintR: number,
    paintG: number,
    paintB: number,
    trimR: number,
    trimG: number,
    trimB: number,
    brake: number,
    indL: number,
    indR: number,
    head: number,
    roll: number,
    steer: number,
  ): boolean {
    const i = this.cursor;
    if (i >= this.capacity) return false;
    this.mesh.setMatrixAt(i, matrix);
    const p = this.paint.array as Float32Array;
    p[i * 3] = paintR;
    p[i * 3 + 1] = paintG;
    p[i * 3 + 2] = paintB;
    const t = this.trim.array as Float32Array;
    t[i * 3] = trimR;
    t[i * 3 + 1] = trimG;
    t[i * 3 + 2] = trimB;
    const l = this.lights.array as Float32Array;
    l[i * 4] = brake;
    l[i * 4 + 1] = indL;
    l[i * 4 + 2] = indR;
    l[i * 4 + 3] = head;
    const w = this.wheel.array as Float32Array;
    w[i * 2] = roll;
    w[i * 2 + 1] = steer;
    this.cursor++;
    return true;
  }

  end(): void {
    this.mesh.count = this.cursor;
    if (this.cursor > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.paint.needsUpdate = true;
      this.trim.needsUpdate = true;
      this.lights.needsUpdate = true;
      this.wheel.needsUpdate = true;
    }
  }

  get count(): number {
    return this.cursor;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
  }
}

/* ============================================================ type catalogue */

export interface VehicleTypeDef {
  id: string;
  /** the label used in stats and debug overlays */
  label: string;
  /** metres, along −Z */
  length: number;
  /** metres, along X */
  width: number;
  /** metres, along Y */
  height: number;
  wheelRadius: number;
  /** relative spawn weight */
  weight: number;
  /** multiplies the profile's desired speed — vans and trolleys are slower */
  speedScale: number;
  /** paint choices, with matching weights */
  paint: readonly number[];
  paintWeights: readonly number[] | null;
  /** livery/trim choices */
  trim: readonly number[];
  /** police bars alternate their "indicators" permanently */
  emergency: boolean;
  build(): THREE.BufferGeometry;
}

/* ------------------------------------------------------------ shared bits */

const GLASS = 0x1b2430;
const TYRE = 0x14161a;
const HUB = 0x8f979e;
const HUB_DARK = 0x3a4046;
const BUMPER = 0x2f353b;
const LAMP_RED = 0xd21f1f;
const LAMP_AMBER = 0xe08a1c;
const LAMP_WHITE = 0xfff1d8;
const LAMP_BLUE = 0x2050d8;
const CHROME = 0xb8bfc4;

/** Four road wheels with hub faces, front pair flagged as steering. */
function addWheels(
  parts: VehicleParts,
  halfTrack: number,
  frontZ: number,
  rearZ: number,
  radius: number,
  width: number,
  seg = 10,
): void {
  const pivot = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    const sx = i % 2 === 0 ? -halfTrack : halfTrack;
    const front = i < 2;
    const z = front ? frontZ : rearZ;
    const mode = front ? WHEEL.FRONT : WHEEL.REAR;
    pivot.set(sx, radius, z);
    parts.add(place(wheelCylinder(radius, width, seg), sx, radius, z), TYRE, ROLE.STATIC, mode, pivot);
    // hub face, pushed just outboard of the tyre so it never z-fights
    const hub = new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, width * 0.34, 8, 1, false);
    hub.rotateZ(Math.PI / 2);
    parts.add(
      place(hub, sx + Math.sign(sx) * width * 0.34, radius, z),
      i % 3 === 0 ? HUB : HUB_DARK,
      ROLE.STATIC,
      mode,
      pivot,
    );
  }
}

/** Front + rear lamp clusters, indicators outboard of the main lenses. */
function addLamps(
  parts: VehicleParts,
  halfWidth: number,
  frontZ: number,
  rearZ: number,
  lampY: number,
  lampW = 0.3,
  lampH = 0.14,
): void {
  const d = 0.06;
  // headlamps
  parts.add(place(box(lampW, lampH, d), -halfWidth * 0.66, lampY, frontZ), LAMP_WHITE, ROLE.HEAD);
  parts.add(place(box(lampW, lampH, d), halfWidth * 0.66, lampY, frontZ), LAMP_WHITE, ROLE.HEAD);
  // front indicators (outboard)
  parts.add(
    place(box(lampW * 0.42, lampH * 0.8, d), -halfWidth * 0.93, lampY, frontZ),
    LAMP_AMBER,
    ROLE.INDL,
  );
  parts.add(
    place(box(lampW * 0.42, lampH * 0.8, d), halfWidth * 0.93, lampY, frontZ),
    LAMP_AMBER,
    ROLE.INDR,
  );
  // tail lamps
  parts.add(
    place(box(lampW, lampH * 1.15, d), -halfWidth * 0.68, lampY + 0.06, rearZ),
    LAMP_RED,
    ROLE.BRAKE,
  );
  parts.add(
    place(box(lampW, lampH * 1.15, d), halfWidth * 0.68, lampY + 0.06, rearZ),
    LAMP_RED,
    ROLE.BRAKE,
  );
  // rear indicators
  parts.add(
    place(box(lampW * 0.4, lampH * 0.8, d), -halfWidth * 0.94, lampY + 0.06, rearZ),
    LAMP_AMBER,
    ROLE.INDL,
  );
  parts.add(
    place(box(lampW * 0.4, lampH * 0.8, d), halfWidth * 0.94, lampY + 0.06, rearZ),
    LAMP_AMBER,
    ROLE.INDR,
  );
}

/* --------------------------------------------------------------- the cars */

/**
 * Shared three-box / two-box saloon builder. `bootLength` of 0 makes it a
 * hatchback; a positive value gives a proper sedan tail.
 */
function buildCar(opts: {
  length: number;
  width: number;
  roofHeight: number;
  wheelRadius: number;
  bootLength: number;
  cabinZ: number;
  cabinLength: number;
  sillShade: number;
}): THREE.BufferGeometry {
  const p = new VehicleParts();
  const L = opts.length;
  const W = opts.width;
  const hw = W * 0.5;
  const r = opts.wheelRadius;
  const sillY = r * 0.62;
  const beltY = sillY + 0.56;
  const roofY = opts.roofHeight;

  // main volume, slightly tapered at the shoulder line
  p.add(
    place(taperBox(W, beltY - sillY, L, 0.965, 0.995, 0), 0, (sillY + beltY) * 0.5, 0),
    0xffffff,
    ROLE.PAINT,
  );
  // darker sill / lower door band
  p.add(place(box(W * 1.005, 0.16, L * 0.86), 0, sillY + 0.06, 0), opts.sillShade, ROLE.PAINT);
  // bonnet
  p.add(
    place(box(W * 0.9, 0.1, L * 0.29), 0, beltY + 0.03, -L * 0.32),
    0xf0f0f0,
    ROLE.PAINT,
  );
  // boot lid (sedans only)
  if (opts.bootLength > 0.01) {
    p.add(
      place(box(W * 0.9, 0.1, opts.bootLength), 0, beltY + 0.03, L * 0.5 - opts.bootLength * 0.55),
      0xf0f0f0,
      ROLE.PAINT,
    );
  }
  // cabin — tapered greenhouse
  p.add(
    place(
      taperBox(W * 0.94, roofY - beltY, opts.cabinLength, 0.9, 0.82, 0.06),
      0,
      (beltY + roofY) * 0.5,
      opts.cabinZ,
    ),
    0xfafafa,
    ROLE.PAINT,
  );
  // glazing: a slightly smaller dark shell inset into the greenhouse
  p.add(
    place(
      taperBox(W * 0.9, (roofY - beltY) * 0.72, opts.cabinLength * 0.96, 0.9, 0.83, 0.06),
      0,
      beltY + (roofY - beltY) * 0.42,
      opts.cabinZ,
    ),
    GLASS,
    ROLE.STATIC,
  );
  // roof panel back in body colour on top of the glass shell
  p.add(
    place(box(W * 0.8, 0.07, opts.cabinLength * 0.72), 0, roofY - 0.02, opts.cabinZ + 0.05),
    0xffffff,
    ROLE.PAINT,
  );

  // bumpers
  p.add(place(box(W * 1.01, 0.26, 0.2), 0, sillY + 0.2, -L * 0.5 + 0.08), BUMPER, ROLE.STATIC);
  p.add(place(box(W * 1.01, 0.26, 0.2), 0, sillY + 0.2, L * 0.5 - 0.08), BUMPER, ROLE.STATIC);
  // grille
  p.add(place(box(W * 0.6, 0.13, 0.06), 0, beltY - 0.16, -L * 0.5 + 0.02), 0x1c2024, ROLE.STATIC);
  // door mirrors
  p.add(place(box(0.11, 0.08, 0.16), -hw - 0.05, beltY - 0.02, opts.cabinZ - opts.cabinLength * 0.42), 0xd8d8d8, ROLE.PAINT);
  p.add(place(box(0.11, 0.08, 0.16), hw + 0.05, beltY - 0.02, opts.cabinZ - opts.cabinLength * 0.42), 0xd8d8d8, ROLE.PAINT);
  // registration plate
  p.add(place(box(0.34, 0.13, 0.03), 0, sillY + 0.22, L * 0.5 + 0.02), 0xe8e4d2, ROLE.STATIC);

  addLamps(p, hw, -L * 0.5 - 0.005, L * 0.5 + 0.005, beltY - 0.2, W * 0.19, 0.13);
  addWheels(p, hw - 0.09, -L * 0.32, L * 0.31, r, 0.2);
  return p.build('car');
}

function buildHatchback(): THREE.BufferGeometry {
  return buildCar({
    length: 3.95,
    width: 1.72,
    roofHeight: 1.5,
    wheelRadius: 0.31,
    bootLength: 0,
    cabinZ: 0.42,
    cabinLength: 2.0,
    sillShade: 0x9a9a9a,
  });
}

function buildSedan(): THREE.BufferGeometry {
  return buildCar({
    length: 4.62,
    width: 1.8,
    roofHeight: 1.46,
    wheelRadius: 0.33,
    bootLength: 1.05,
    cabinZ: 0.22,
    cabinLength: 2.05,
    sillShade: 0xa4a4a4,
  });
}

/** Sedan silhouette + roof bar + door shields. Policía de Puerto Rico blue. */
function buildPolice(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const L = 4.75;
  const W = 1.85;
  const hw = W * 0.5;
  const r = 0.34;
  const sillY = r * 0.62;
  const beltY = sillY + 0.58;
  const roofY = 1.48;

  p.add(place(taperBox(W, beltY - sillY, L, 0.965, 0.995, 0), 0, (sillY + beltY) * 0.5, 0), 0xffffff, ROLE.PAINT);
  // white door panels — the trim colour
  p.add(place(box(W * 1.008, 0.5, 1.9), 0, sillY + 0.3, 0.1), 0xffffff, ROLE.TRIM);
  p.add(place(box(W * 0.9, 0.1, L * 0.28), 0, beltY + 0.03, -L * 0.32), 0xf0f0f0, ROLE.PAINT);
  p.add(place(box(W * 0.9, 0.1, 1.05), 0, beltY + 0.03, L * 0.5 - 0.58), 0xf0f0f0, ROLE.PAINT);
  p.add(place(taperBox(W * 0.94, roofY - beltY, 2.1, 0.9, 0.82, 0.06), 0, (beltY + roofY) * 0.5, 0.2), 0xfafafa, ROLE.PAINT);
  p.add(place(taperBox(W * 0.9, (roofY - beltY) * 0.72, 2.02, 0.9, 0.83, 0.06), 0, beltY + (roofY - beltY) * 0.42, 0.2), GLASS, ROLE.STATIC);
  p.add(place(box(W * 0.8, 0.07, 1.5), 0, roofY - 0.02, 0.25), 0xffffff, ROLE.PAINT);

  // light bar: blue half left, red half right
  p.add(place(box(0.5, 0.11, 0.2), -0.3, roofY + 0.09, 0.15), LAMP_BLUE, ROLE.INDL);
  p.add(place(box(0.5, 0.11, 0.2), 0.3, roofY + 0.09, 0.15), LAMP_RED, ROLE.INDR);
  p.add(place(box(1.16, 0.05, 0.23), 0, roofY + 0.02, 0.15), 0x1a1d21, ROLE.STATIC);

  // push bar
  p.add(place(box(W * 0.86, 0.5, 0.07), 0, beltY - 0.26, -L * 0.5 - 0.12), 0x2a2e33, ROLE.STATIC);
  p.add(place(box(W * 1.01, 0.26, 0.2), 0, sillY + 0.2, L * 0.5 - 0.08), BUMPER, ROLE.STATIC);
  p.add(place(box(0.11, 0.08, 0.16), -hw - 0.05, beltY - 0.02, -0.75), 0xd8d8d8, ROLE.PAINT);
  p.add(place(box(0.11, 0.08, 0.16), hw + 0.05, beltY - 0.02, -0.75), 0xd8d8d8, ROLE.PAINT);

  addLamps(p, hw, -L * 0.5 - 0.005, L * 0.5 + 0.005, beltY - 0.2, 0.34, 0.13);
  addWheels(p, hw - 0.09, -L * 0.33, L * 0.31, r, 0.21);
  return p.build('police');
}

/** White 15-passenger público van — the signature shared-taxi minibus. */
function buildPublico(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const L = 5.9;
  const W = 2.02;
  const hw = W * 0.5;
  const r = 0.37;
  const sillY = 0.34;
  const roofY = 2.42;

  // body: one tall box with a slightly rounded shoulder
  p.add(place(taperBox(W, roofY - sillY, L, 0.94, 0.985, -0.02), 0, (sillY + roofY) * 0.5, 0), 0xffffff, ROLE.PAINT);
  // stepped nose
  p.add(place(box(W * 0.96, 0.62, 0.9), 0, sillY + 0.34, -L * 0.5 + 0.42), 0xf4f4f4, ROLE.PAINT);
  // windscreen
  p.add(place(box(W * 0.86, 0.72, 0.08), 0, 1.72, -L * 0.5 + 0.1, -0.22), GLASS, ROLE.STATIC);
  // flank glazing — two long strips
  for (const sx of [-1, 1]) {
    p.add(place(box(0.05, 0.6, L * 0.52), sx * (hw - 0.01), 1.72, 0.55), GLASS, ROLE.STATIC);
  }
  // rear window + doors
  p.add(place(box(W * 0.82, 0.6, 0.05), 0, 1.74, L * 0.5 + 0.005), GLASS, ROLE.STATIC);
  // livery stripe down the flank (trim colour)
  for (const sx of [-1, 1]) {
    p.add(place(box(0.03, 0.16, L * 0.86), sx * (hw + 0.005), 1.02, 0.05), 0xffffff, ROLE.TRIM);
  }
  p.add(place(box(W * 0.9, 0.16, 0.03), 0, 1.02, L * 0.5 + 0.02), 0xffffff, ROLE.TRIM);
  // roof rack rails
  p.add(place(box(0.07, 0.09, L * 0.7), -hw * 0.72, roofY + 0.05, 0.1), 0x9aa0a6, ROLE.STATIC);
  p.add(place(box(0.07, 0.09, L * 0.7), hw * 0.72, roofY + 0.05, 0.1), 0x9aa0a6, ROLE.STATIC);
  // sill skirt + bumpers
  p.add(place(box(W * 1.005, 0.2, L * 0.9), 0, sillY + 0.06, 0), 0x8e8e8e, ROLE.PAINT);
  p.add(place(box(W * 1.01, 0.3, 0.2), 0, sillY + 0.14, -L * 0.5 + 0.08), BUMPER, ROLE.STATIC);
  p.add(place(box(W * 1.01, 0.3, 0.2), 0, sillY + 0.14, L * 0.5 - 0.08), BUMPER, ROLE.STATIC);
  p.add(place(box(W * 0.55, 0.14, 0.05), 0, sillY + 0.62, -L * 0.5 - 0.01), 0x22262a, ROLE.STATIC);
  // mirrors on stalks — vans always have big ones
  p.add(place(box(0.14, 0.24, 0.06), -hw - 0.12, 1.6, -L * 0.5 + 0.35), 0x2c3035, ROLE.STATIC);
  p.add(place(box(0.14, 0.24, 0.06), hw + 0.12, 1.6, -L * 0.5 + 0.35), 0x2c3035, ROLE.STATIC);

  addLamps(p, hw, -L * 0.5 - 0.005, L * 0.5 + 0.005, sillY + 0.5, 0.32, 0.16);
  addWheels(p, hw - 0.1, -L * 0.34, L * 0.3, r, 0.23);
  return p.build('publico');
}

/** F-150 / Tacoma style pickup: cab, open bed, tailgate. */
function buildPickup(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const L = 5.5;
  const W = 2.0;
  const hw = W * 0.5;
  const r = 0.4;
  const sillY = 0.42;
  const beltY = 1.16;
  const roofY = 1.94;

  // chassis / lower body
  p.add(place(box(W, beltY - sillY, L), 0, (sillY + beltY) * 0.5, 0), 0xffffff, ROLE.PAINT);
  // bonnet
  p.add(place(box(W * 0.94, 0.14, 1.5), 0, beltY + 0.05, -L * 0.5 + 0.8), 0xf2f2f2, ROLE.PAINT);
  // cab
  p.add(place(taperBox(W * 0.95, roofY - beltY, 1.72, 0.94, 0.86, 0.04), 0, (beltY + roofY) * 0.5, -0.42), 0xfafafa, ROLE.PAINT);
  p.add(place(taperBox(W * 0.91, (roofY - beltY) * 0.66, 1.64, 0.94, 0.87, 0.04), 0, beltY + (roofY - beltY) * 0.4, -0.42), GLASS, ROLE.STATIC);
  p.add(place(box(W * 0.8, 0.07, 1.3), 0, roofY - 0.02, -0.4), 0xffffff, ROLE.PAINT);
  // bed walls
  p.add(place(box(0.11, 0.44, 2.3), -hw + 0.05, beltY + 0.2, 1.16), 0xf0f0f0, ROLE.PAINT);
  p.add(place(box(0.11, 0.44, 2.3), hw - 0.05, beltY + 0.2, 1.16), 0xf0f0f0, ROLE.PAINT);
  p.add(place(box(W * 0.98, 0.44, 0.1), 0, beltY + 0.2, L * 0.5 - 0.05), 0xeaeaea, ROLE.PAINT);
  // bed floor (a shade darker, dusty)
  p.add(place(box(W * 0.86, 0.06, 2.3), 0, beltY + 0.02, 1.16), 0x6e6a63, ROLE.STATIC);
  // bumpers + step
  p.add(place(box(W * 1.02, 0.3, 0.22), 0, sillY + 0.16, -L * 0.5 + 0.09), CHROME, ROLE.STATIC);
  p.add(place(box(W * 1.02, 0.26, 0.2), 0, sillY + 0.1, L * 0.5 - 0.06), CHROME, ROLE.STATIC);
  p.add(place(box(0.09, 0.08, 1.5), -hw - 0.06, sillY - 0.08, -0.35), 0x33383d, ROLE.STATIC);
  p.add(place(box(0.09, 0.08, 1.5), hw + 0.06, sillY - 0.08, -0.35), 0x33383d, ROLE.STATIC);
  p.add(place(box(W * 0.62, 0.2, 0.06), 0, beltY - 0.24, -L * 0.5 - 0.01), 0x24282c, ROLE.STATIC);
  p.add(place(box(0.13, 0.1, 0.18), -hw - 0.07, beltY + 0.36, -1.2), 0x2c3035, ROLE.STATIC);
  p.add(place(box(0.13, 0.1, 0.18), hw + 0.07, beltY + 0.36, -1.2), 0x2c3035, ROLE.STATIC);

  addLamps(p, hw, -L * 0.5 - 0.005, L * 0.5 + 0.005, beltY - 0.34, 0.34, 0.17);
  addWheels(p, hw - 0.08, -L * 0.33, L * 0.29, r, 0.26);
  return p.build('pickup');
}

/** Small box delivery truck — bakery, colmado supply, hardware. */
function buildBoxVan(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const L = 6.3;
  const W = 2.16;
  const hw = W * 0.5;
  const r = 0.42;
  const sillY = 0.52;
  const cabRoof = 2.16;
  const boxTop = 2.86;

  // cab
  p.add(place(box(W * 0.98, cabRoof - sillY, 1.75), 0, (sillY + cabRoof) * 0.5, -L * 0.5 + 0.9), 0xffffff, ROLE.PAINT);
  p.add(place(box(W * 0.9, 0.68, 0.07), 0, 1.66, -L * 0.5 + 0.06, -0.16), GLASS, ROLE.STATIC);
  for (const sx of [-1, 1]) {
    p.add(place(box(0.05, 0.5, 0.7), sx * (hw * 0.97), 1.6, -L * 0.5 + 0.85), GLASS, ROLE.STATIC);
  }
  // box body
  p.add(place(box(W, boxTop - sillY - 0.1, L - 1.9), 0, (sillY + 0.1 + boxTop) * 0.5, 0.98), 0xffffff, ROLE.PAINT);
  // livery band around the box
  p.add(place(box(W * 1.006, 0.4, L - 1.94), 0, 1.5, 0.98), 0xffffff, ROLE.TRIM);
  // roll-shutter lines on the rear
  p.add(place(box(W * 0.9, boxTop - sillY - 0.34, 0.04), 0, (sillY + 0.24 + boxTop) * 0.5, L * 0.5 + 0.005), 0xc4c8cc, ROLE.STATIC);
  // chassis rails + bumpers
  p.add(place(box(W * 0.92, 0.16, L * 0.9), 0, sillY - 0.08, 0.2), 0x33383d, ROLE.STATIC);
  p.add(place(box(W * 1.01, 0.3, 0.2), 0, sillY + 0.06, -L * 0.5 + 0.08), BUMPER, ROLE.STATIC);
  p.add(place(box(W * 0.96, 0.14, 0.28), 0, sillY - 0.1, L * 0.5 + 0.06), 0x44494e, ROLE.STATIC);
  p.add(place(box(0.15, 0.26, 0.06), -hw - 0.12, 1.56, -L * 0.5 + 0.3), 0x2c3035, ROLE.STATIC);
  p.add(place(box(0.15, 0.26, 0.06), hw + 0.12, 1.56, -L * 0.5 + 0.3), 0x2c3035, ROLE.STATIC);

  addLamps(p, hw, -L * 0.5 - 0.005, L * 0.5 + 0.005, sillY + 0.36, 0.32, 0.16);
  addWheels(p, hw - 0.1, -L * 0.34, L * 0.3, r, 0.26);
  return p.build('boxvan');
}

/**
 * The free Old San Juan trolley: open-sided, white body with bottle-green
 * fascia, bench rows and a canvas-look roof. The signature local vehicle —
 * worth the extra triangles.
 */
function buildTrolley(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const L = 7.9;
  const W = 2.42;
  const hw = W * 0.5;
  const r = 0.42;
  const floorY = 0.88;
  const roofY = 2.92;

  // skirt (trim green) and floor
  p.add(place(box(W, 0.52, L), 0, floorY - 0.26, 0), 0xffffff, ROLE.TRIM);
  p.add(place(box(W, 0.12, L), 0, floorY + 0.06, 0), 0xf4f4f4, ROLE.PAINT);
  // waist rail along both open flanks
  for (const sx of [-1, 1]) {
    p.add(place(box(0.09, 0.34, L * 0.86), sx * (hw - 0.05), floorY + 0.52, 0.15), 0xffffff, ROLE.PAINT);
    p.add(place(box(0.06, 0.06, L * 0.86), sx * (hw - 0.05), floorY + 0.94, 0.15), CHROME, ROLE.STATIC);
  }
  // corner + intermediate posts
  for (let i = 0; i < 5; i++) {
    const z = -L * 0.42 + (i * L * 0.84) / 4;
    for (const sx of [-1, 1]) {
      p.add(place(box(0.09, roofY - floorY - 0.1, 0.09), sx * (hw - 0.05), (floorY + roofY) * 0.5, z), 0xffffff, ROLE.PAINT);
    }
  }
  // roof + green fascia all round
  p.add(place(box(W + 0.2, 0.12, L + 0.2), 0, roofY, 0), 0xf6f6f2, ROLE.PAINT);
  p.add(place(box(W + 0.24, 0.26, L + 0.24), 0, roofY - 0.17, 0), 0xffffff, ROLE.TRIM);
  // decorative roof crown
  p.add(place(box(W * 0.6, 0.1, L * 0.5), 0, roofY + 0.09, 0.1), 0xffffff, ROLE.TRIM);
  // bonnet / driver cab at the front
  p.add(place(box(W * 0.94, 0.9, 1.5), 0, floorY + 0.55, -L * 0.5 + 0.72), 0xffffff, ROLE.PAINT);
  p.add(place(box(W * 0.86, 0.66, 0.07), 0, floorY + 1.32, -L * 0.5 + 0.06), GLASS, ROLE.STATIC);
  p.add(place(box(W * 0.86, 0.5, 0.06), 0, floorY + 1.3, -L * 0.5 + 1.42), 0x3a4046, ROLE.STATIC);
  // destination board
  p.add(place(box(W * 0.7, 0.26, 0.06), 0, roofY - 0.45, -L * 0.5 - 0.02), 0xffffff, ROLE.TRIM);
  p.add(place(box(W * 0.6, 0.16, 0.03), 0, roofY - 0.45, -L * 0.5 - 0.05), 0xf6f2e4, ROLE.STATIC);
  // bench rows, seen straight through the open sides
  for (let i = 0; i < 4; i++) {
    const z = -L * 0.24 + i * 1.28;
    p.add(place(box(W * 0.88, 0.1, 0.52), 0, floorY + 0.52, z), 0x6b4a2f, ROLE.STATIC);
    p.add(place(box(W * 0.88, 0.46, 0.1), 0, floorY + 0.78, z + 0.26), 0x7a5636, ROLE.STATIC);
  }
  // rear step + grab poles
  p.add(place(box(W * 0.7, 0.09, 0.4), 0, floorY - 0.36, L * 0.5 - 0.1), 0x3a4046, ROLE.STATIC);
  p.add(place(box(0.06, roofY - floorY, 0.06), -hw * 0.55, (floorY + roofY) * 0.5, L * 0.5 - 0.16), CHROME, ROLE.STATIC);
  p.add(place(box(0.06, roofY - floorY, 0.06), hw * 0.55, (floorY + roofY) * 0.5, L * 0.5 - 0.16), CHROME, ROLE.STATIC);
  p.add(place(box(W * 1.0, 0.24, 0.18), 0, floorY - 0.42, -L * 0.5 + 0.06), BUMPER, ROLE.STATIC);

  addLamps(p, hw, -L * 0.5 - 0.02, L * 0.5 + 0.02, floorY + 0.22, 0.28, 0.18);
  addWheels(p, hw - 0.14, -L * 0.34, L * 0.31, r, 0.24);
  return p.build('trolley');
}

/* --------------------------------------------------------- the catalogue */

export const VEHICLE_TYPES: readonly VehicleTypeDef[] = [
  {
    id: 'hatchback',
    label: 'hatchback',
    length: 3.95,
    width: 1.72,
    height: 1.5,
    wheelRadius: 0.31,
    weight: 26,
    speedScale: 1.05,
    paint: CAR_PAINT,
    paintWeights: CAR_PAINT_WEIGHTS,
    trim: CAR_PAINT,
    emergency: false,
    build: buildHatchback,
  },
  {
    id: 'sedan',
    label: 'sedan',
    length: 4.62,
    width: 1.8,
    height: 1.46,
    wheelRadius: 0.33,
    weight: 30,
    speedScale: 1.0,
    paint: CAR_PAINT,
    paintWeights: CAR_PAINT_WEIGHTS,
    trim: CAR_PAINT,
    emergency: false,
    build: buildSedan,
  },
  {
    id: 'publico',
    label: 'público van',
    length: 5.9,
    width: 2.02,
    height: 2.52,
    wheelRadius: 0.37,
    weight: 14,
    speedScale: 0.88,
    paint: PUBLICO_PAINT,
    paintWeights: null,
    trim: PUBLICO_STRIPE,
    emergency: false,
    build: buildPublico,
  },
  {
    id: 'pickup',
    label: 'pickup',
    length: 5.5,
    width: 2.0,
    height: 1.94,
    wheelRadius: 0.4,
    weight: 16,
    speedScale: 0.97,
    paint: CAR_PAINT,
    paintWeights: CAR_PAINT_WEIGHTS,
    trim: CAR_PAINT,
    emergency: false,
    build: buildPickup,
  },
  {
    id: 'boxvan',
    label: 'box van',
    length: 6.3,
    width: 2.16,
    height: 2.86,
    wheelRadius: 0.42,
    weight: 7,
    speedScale: 0.8,
    paint: PUBLICO_PAINT,
    paintWeights: null,
    trim: VAN_STRIPE,
    emergency: false,
    build: buildBoxVan,
  },
  {
    id: 'trolley',
    label: 'OSJ trolley',
    length: 7.9,
    width: 2.42,
    height: 3.02,
    wheelRadius: 0.42,
    weight: 4,
    speedScale: 0.72,
    paint: TROLLEY_PAINT,
    paintWeights: null,
    trim: TROLLEY_TRIM,
    emergency: false,
    build: buildTrolley,
  },
  {
    id: 'police',
    label: 'policía',
    length: 4.75,
    width: 1.85,
    height: 1.6,
    wheelRadius: 0.34,
    weight: 3,
    speedScale: 1.06,
    paint: POLICE_PAINT,
    paintWeights: null,
    trim: POLICE_TRIM,
    emergency: true,
    build: buildPolice,
  },
];

/* ------------------------------------------------------------- imposter */

/**
 * One unit-sized silhouette (1 × 1 × 1, origin on the ground at its centre)
 * scaled per instance to whatever type it stands in for. Everything past
 * `SPAWN.imposterDistance` renders from this single mesh.
 */
function buildImposter(): THREE.BufferGeometry {
  const p = new VehicleParts();
  p.add(place(box(1.0, 0.42, 1.0), 0, 0.29, 0), 0xffffff, ROLE.PAINT);
  p.add(place(taperBox(0.94, 0.34, 0.56, 0.86, 0.8, 0.02), 0, 0.66, 0.05), 0x8c8c8c, ROLE.PAINT);
  p.add(place(box(1.02, 0.1, 0.9), 0, 0.2, 0), 0x5a5a5a, ROLE.PAINT);
  for (let i = 0; i < 4; i++) {
    const sx = i % 2 === 0 ? -0.47 : 0.47;
    const z = i < 2 ? -0.31 : 0.31;
    p.add(place(box(0.1, 0.17, 0.17), sx, 0.09, z), 0x101214, ROLE.STATIC);
  }
  return p.build('imposter');
}

/* ================================================================== kit */

/** Everything the traffic system needs to draw cars. */
export class VehicleKit {
  readonly group = new THREE.Group();
  readonly types = VEHICLE_TYPES;
  readonly fleets: InstancedFleet[] = [];
  readonly imposter: InstancedFleet;
  readonly material: THREE.MeshStandardMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  readonly imposterMaterial: THREE.MeshStandardMaterial;

  constructor(capacity: number, castShadow: boolean) {
    this.group.name = 'loco/traffic/vehicles';
    this.material = createVehicleMaterial();
    this.depthMaterial = createVehicleDepthMaterial();
    this.imposterMaterial = new THREE.MeshStandardMaterial({
      name: 'loco/traffic-imposter',
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.08,
    });
    patchVehicleMaterial(this.imposterMaterial, false);

    for (const def of this.types) {
      const fleet = new InstancedFleet(
        def.build(),
        this.material,
        castShadow ? this.depthMaterial : null,
        capacity,
        def.id,
        castShadow,
      );
      this.fleets.push(fleet);
      this.group.add(fleet.mesh);
    }
    this.imposter = new InstancedFleet(
      buildImposter(),
      this.imposterMaterial,
      null,
      capacity,
      'imposter',
      false,
    );
    this.group.add(this.imposter.mesh);
  }

  /** Pick a type index by spawn weight. */
  pickType(rng: RNG): number {
    let total = 0;
    for (let i = 0; i < this.types.length; i++) total += this.types[i].weight;
    let r = rng.next() * total;
    for (let i = 0; i < this.types.length; i++) {
      r -= this.types[i].weight;
      if (r <= 0) return i;
    }
    return 0;
  }

  /** Paint colour for a type, honouring its weights. */
  pickPaint(typeIndex: number, rng: RNG): number {
    const def = this.types[typeIndex];
    if (def.paintWeights) return rng.weighted(def.paint, def.paintWeights);
    return rng.pick(def.paint);
  }

  pickTrim(typeIndex: number, rng: RNG): number {
    return rng.pick(this.types[typeIndex].trim);
  }

  beginFrame(): void {
    for (let i = 0; i < this.fleets.length; i++) this.fleets[i].begin();
    this.imposter.begin();
  }

  endFrame(): void {
    for (let i = 0; i < this.fleets.length; i++) this.fleets[i].end();
    this.imposter.end();
  }

  get triangleBudget(): number {
    let t = 0;
    for (const f of this.fleets) t += f.triangles;
    return t;
  }

  /** Live triangle count for the instances actually drawn this frame. */
  get liveTriangles(): number {
    let t = 0;
    for (const f of this.fleets) t += f.triangles * f.count;
    return t + this.imposter.triangles * this.imposter.count;
  }

  get drawCalls(): number {
    let n = 0;
    for (const f of this.fleets) if (f.count > 0) n++;
    if (this.imposter.count > 0) n++;
    return n;
  }

  dispose(): void {
    for (const f of this.fleets) f.dispose();
    this.fleets.length = 0;
    this.imposter.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.imposterMaterial.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
