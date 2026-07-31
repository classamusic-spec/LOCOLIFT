/**
 * Loco Lift — coastal life.
 *
 * The beach in `Coast.ts` is a place; this is what makes it look *used*. Every
 * family here is authored once as a vertex-coloured triangle soup and then
 * instanced, so an entire population — every umbrella on the coast, every
 * kiosk, every moored yola — costs one draw call.
 *
 * What lives out here:
 *
 *  - **Kiosks** (*quioscos*): the fried-food shacks that line a Puerto Rican
 *    playa, with striped awnings, a serving counter and a menu board.
 *  - **Umbrellas and chairs**, in loose family groups rather than a grid,
 *    because a real beach clusters.
 *  - **Boats**: yolas drawn up on the sand with their bows to the water, and
 *    moored pangas out in the shallows that ride the swell (a vertex-shader
 *    bob keyed to the same Gerstner constants the ocean uses).
 *  - **Buoys** marking the swim line, on the same bob.
 *  - **Fishing gear**: pot stacks, net rolls, crates, oars leaning on the wall.
 *  - **A lifeguard stand**, the tallest thing on the sand and a useful
 *    landmark at speed (§6.2 R6 — silhouette events).
 *  - **The pier** (*muelle*): a real driveable timber structure on pilings,
 *    with a kicker at the seaward end. This is the hero jump on the coast —
 *    you launch off it into open water. It carries its own trimesh collider.
 *  - **Seagulls**, an instanced flock on looping flight paths with a vertex
 *    shader wing flap, because a static coast is a dead coast (§6.2 R9).
 */
import * as THREE from 'three';
import { QUALITY_BUDGET } from '../core/Config';
import type { QualityTier } from '../core/types';
import { clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import { GROUP } from '../physics/PhysicsTypes';
import type { BodyHandle } from '../physics/PhysicsTypes';
import { SEA_LEVEL } from './CityLayout';
import { coastModel, sampleSpan, GeoBuilder, COAST_DENSITY } from './Coast';
import type { CoastModel } from './Coast';
import type { CityLayout, WorldLayer, WorldOpts } from './WorldTypes';

/* ------------------------------------------------------------------ palette */

const P = {
  /* kiosk / awning stripes — saturated but under the taxi (§3.6 R8) */
  awning: [0xd94f3d, 0x2e8b8b, 0xe8b23a, 0x3f6fb5, 0xd9536f] as const,
  awningPale: 0xf5efe2,
  kioskWall: [0xf2d38a, 0x9fd0c8, 0xefb0a0, 0xbcd6f0] as const,
  kioskTrim: 0xfffaf0,
  counter: 0x8d6f4e,
  board: 0x2b2b2b,
  timber: 0x8a6f52,
  timberDark: 0x6a5238,
  rope: 0xbfae8c,
  hullWhite: 0xf0efe6,
  hullBlue: 0x2e6fa8,
  hullGreen: 0x2f8f6a,
  hullRed: 0xc4453a,
  hullYellow: 0xe8b23a,
  bootTop: 0x1e3a52,
  buoyOrange: 0xf27128,
  buoyWhite: 0xf2f0e8,
  crate: 0x9a7f5c,
  crateBlue: 0x3a6ea8,
  net: 0x5f7a5a,
  guard: 0xe8543c,
  guardTrim: 0xf7f2e6,
  metal: 0xb9bcc0,
  gull: 0xf6f4ee,
  gullTip: 0x3a3f46,
  gullBeak: 0xe8a020,
} as const;

/* ------------------------------------------------------------------ shaders */

/**
 * Per-instance tint, applied only where the geometry asks for it.
 *
 * `aFlag.x` per vertex is the tint weight and `aTint` per instance is the
 * colour, so one umbrella geometry serves the whole beach in five colours out
 * of a single draw while its mast stays aluminium. Without this, colour
 * variety would cost one instanced mesh per colour per family — which is how
 * a coast full of small props quietly turns into forty draw calls.
 */
const TINT_PARS = /* glsl */ `
attribute vec3 aFlag;
#ifdef USE_INSTANCING
  attribute vec3 aTint;
#endif
varying vec3 vTint;
`;

const TINT_BEGIN = [
  '#ifdef USE_INSTANCING',
  '  vTint = mix( vec3( 1.0 ), aTint, clamp( aFlag.x, 0.0, 1.0 ) );',
  '#else',
  '  vTint = vec3( 1.0 );',
  '#endif',
].join('\n');

/** Wires the tint pair into a standard material's shader. */
function patchTint(shader: THREE.WebGLProgramParametersWithUniforms, extraVert = ''): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${TINT_PARS}${extraVert}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${TINT_BEGIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
    .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb *= vTint;');
}

/**
 * Water bob. Anything floating shares this so a boat, a buoy and the ocean
 * surface all ride the same swell instead of arguing about where the water is.
 *
 * `aFloat` per instance: x = phase, y = response (1 = a light dinghy, 0.3 = a
 * heavy moored panga).
 */
const FLOAT_PARS = /* glsl */ `
uniform float uTime;
#ifdef USE_INSTANCING
  attribute vec2 aFloat;
#endif

vec3 locoBob( vec3 transformed, vec3 anchor, float phase, float response ) {
  float t = uTime;
  float heave = sin( t * 0.71 + phase ) * 0.24 + sin( t * 1.13 + phase * 1.7 ) * 0.11;
  float roll  = sin( t * 0.83 + phase * 1.3 ) * 0.055;
  float pitch = sin( t * 1.07 + phase * 0.7 ) * 0.038;
  vec3 p = transformed;
  float cr = cos( roll * response );
  float sr = sin( roll * response );
  float cp = cos( pitch * response );
  float sp = sin( pitch * response );
  p = vec3( p.x * cr - p.y * sr, p.x * sr + p.y * cr, p.z );
  p = vec3( p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp );
  p.y += heave * response;
  return p;
}
`;

const FLOAT_BEGIN = [
  '#include <begin_vertex>',
  '#ifdef USE_INSTANCING',
  '  vec3 locoAnchor = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
  '  transformed = locoBob( transformed, locoAnchor, aFloat.x * 62.83, aFloat.y );',
  '#endif',
].join('\n');

/**
 * Seagull flight. The whole flock is one instanced draw; each bird orbits its
 * own centre on its own radius at its own rate, and the wings beat in the
 * vertex shader off `aWing` (0 at the body, 1 at the wingtip).
 *
 * `aBird` per instance: x = phase, y = orbit radius, z = orbit rate,
 * w = flap rate.
 */
const GULL_PARS = /* glsl */ `
uniform float uTime;
attribute float aWing;
#ifdef USE_INSTANCING
  attribute vec4 aBird;
#endif
`;

const GULL_BEGIN = [
  '#include <begin_vertex>',
  '#ifdef USE_INSTANCING',
  '  float locoT = uTime * aBird.z + aBird.x * 62.83;',
  '  float locoFlap = sin( uTime * aBird.w + aBird.x * 41.0 );',
  '  // wing beat: sharp on the downstroke, lazy on the recovery',
  '  float locoBeat = locoFlap > 0.0 ? pow( locoFlap, 0.6 ) : -pow( -locoFlap, 1.6 );',
  '  transformed.y += aWing * locoBeat * 0.42;',
  '  transformed.x *= 1.0 - abs( locoBeat ) * aWing * 0.16;',
  '  // fly the orbit, banked into the turn',
  '  float bank = 0.32;',
  '  float cb = cos( bank ); float sb = sin( bank );',
  '  transformed = vec3( transformed.x * cb - transformed.y * sb, transformed.x * sb + transformed.y * cb, transformed.z );',
  '  float ca = cos( locoT ); float sa = sin( locoT );',
  '  transformed = vec3( transformed.x * ca - transformed.z * sa, transformed.y, transformed.x * sa + transformed.z * ca );',
  '  transformed.x += ca * aBird.y;',
  '  transformed.z += sa * aBird.y;',
  '  transformed.y += sin( locoT * 1.7 ) * 1.6;',
  '#endif',
].join('\n');

interface TimeUniforms {
  uTime: { value: number };
}

/* ------------------------------------------------------------------- layer */

export interface CoastPropsOptions {
  /** multiplier on every scatter count */
  density?: number;
  /** build the pier and its collider */
  pier?: boolean;
  /** build the seagull flock */
  birds?: boolean;
}

export class CoastProps implements WorldLayer {
  readonly name = 'coastProps';
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: CoastPropsOptions;
  private uniforms: TimeUniforms = { uTime: { value: 0 } };

  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private meshes: THREE.Object3D[] = [];
  private bodies: BodyHandle[] = [];
  private physics: WorldOpts['physics'] | null = null;
  private _stats = { instances: 0, triangles: 0, birds: 0 };

  constructor(quality: QualityTier, options: CoastPropsOptions = {}) {
    this.quality = quality;
    this.options = { density: 1, pier: true, birds: true, ...options };
    this.group.name = 'world/coastProps';
  }

  /* --------------------------------------------------------------- build */

  build(layout: CityLayout, opts: WorldOpts): void {
    this.physics = opts.physics;
    const model = coastModel(layout);
    const rng = opts.rng.fork(0xc0a5_9709);
    const density = COAST_DENSITY[this.quality] * (this.options.density ?? 1);

    const solid = this.solidMaterial();
    const cloth = this.clothMaterial();
    const floating = this.floatMaterial();

    this.buildKiosks(model, rng, density, solid, cloth);
    this.buildBeachFurniture(model, rng, density, solid, cloth);
    this.buildBoatsAndGear(model, rng, density, solid, floating);
    this.buildLifeguard(model, rng, solid);
    if (this.options.pier) this.buildPier(model, rng, opts, solid);
    if (this.options.birds) this.buildGulls(model, rng, density);
  }

  /* ------------------------------------------------------------ materials */

  private solidMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      name: 'loco/coastProp',
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.03,
      envMapIntensity: 0.8,
    });
    m.onBeforeCompile = (shader) => patchTint(shader);
    m.customProgramCacheKey = () => 'loco/coast-prop-v1';
    this.materials.push(m);
    return m;
  }

  /** Awnings, sails and umbrella canopies: double sided, softer. */
  private clothMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      name: 'loco/coastCloth',
      vertexColors: true,
      roughness: 0.8,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.75,
    });
    m.onBeforeCompile = (shader) => patchTint(shader);
    m.customProgramCacheKey = () => 'loco/coast-cloth-v1';
    this.materials.push(m);
    return m;
  }

  /** Anything actually in the water, so it rides the swell. */
  private floatMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      name: 'loco/coastFloating',
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.04,
      envMapIntensity: 0.85,
    });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      patchTint(shader, `\n${FLOAT_PARS}`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', FLOAT_BEGIN);
    };
    m.customProgramCacheKey = () => 'loco/coast-float-v1';
    this.materials.push(m);
    return m;
  }

  /* --------------------------------------------------------------- kiosks */

  private buildKiosks(
    model: CoastModel,
    rng: RNG,
    density: number,
    solid: THREE.Material,
    cloth: THREE.Material,
  ): void {
    const bodies: Place[] = [];
    const awnings: Place[] = [];

    // kiosks sit on the promenade side, facing the water, in loose pairs
    const prom = model.promenade;
    if (prom.length < 4) return;
    const total = prom[prom.length - 1].s;
    const want = Math.max(3, Math.round((total / 90) * density));
    for (let i = 0; i < want; i++) {
      const s = ((i + 0.5) / want) * total + rng.range(-14, 14);
      const p = model.promenadeAtS(Math.max(6, Math.min(total - 6, s)));
      if (!p) continue;
      // Seaward of the parapet, on the dry upper beach. The promenade station
      // already sits outboard of the kerb and the pavement, so anything placed
      // *landward* of it lands in the carriageway (§6.2 R1).
      const off = rng.range(7, 17);
      const x = p.x + p.nx * off;
      const z = p.z + p.nz * off;
      if (model.distToRamp(x, z) < 13) continue;
      const yaw = Math.atan2(p.nx, p.nz) + Math.PI + rng.range(-0.16, 0.16);
      const y = model.beachHeight(x, z);
      // the counter has to be above the surf line
      if (y < SEA_LEVEL + 2.2) continue;
      const shape = rng.int(0, 2);
      bodies.push({
        x,
        y,
        z,
        yaw,
        scale: rng.range(0.92, 1.12),
        variant: shape,
        tint: rng.int(0, P.kioskWall.length - 1),
      });
      awnings.push({ x, y, z, yaw, scale: 1, variant: 0, tint: rng.int(0, P.awning.length - 1) });
    }

    if (bodies.length === 0) return;

    // three shell shapes; the wall colour rides on the per-instance tint
    const geos: THREE.BufferGeometry[] = [];
    for (let v = 0; v < 3; v++) geos.push(buildKiosk(rng.fork(v * 613 + 5), v));
    this.putVariants(geos, bodies, solid, 'props/kiosk', P.kioskWall);
    this.putTinted(buildAwning(), awnings, cloth, 'props/kioskAwning', P.awning);
  }

  /* ----------------------------------------------------- beach furniture */

  private buildBeachFurniture(
    model: CoastModel,
    rng: RNG,
    density: number,
    solid: THREE.Material,
    cloth: THREE.Material,
  ): void {
    const umbrellas: Place[] = [];
    const chairs: Place[] = [];
    const towels: Place[] = [];

    for (const span of model.spans) {
      const groups = Math.max(2, Math.round((span.length / 22) * density));
      for (let g = 0; g < groups; g++) {
        const stn = sampleSpan(span.stations, rng.range(5, span.length - 5));
        // nobody sunbathes on the cruise apron
        if (stn.dock) continue;
        const back = rng.range(0.32, 0.72);
        const cx = stn.x - stn.nx * stn.width * back;
        const cz = stn.z - stn.nz * stn.width * back;
        if (model.distToRamp(cx, cz) < 12) continue;

        const n = rng.int(1, 3);
        for (let i = 0; i < n; i++) {
          const x = cx + rng.gaussian() * 2.6;
          const z = cz + rng.gaussian() * 2.6;
          const y = model.beachHeight(x, z);
          if (y < SEA_LEVEL + 1.1) continue;
          const yaw = rng.range(0, Math.PI * 2);
          umbrellas.push({
            x,
            y,
            z,
            yaw,
            scale: rng.range(0.9, 1.15),
            variant: 0,
            tint: rng.int(0, P.awning.length - 1),
          });
          // chairs and towels fan out under each umbrella
          const seats = rng.int(1, 3);
          for (let c = 0; c < seats; c++) {
            const a = yaw + (c / seats) * Math.PI * 2 + rng.range(-0.4, 0.4);
            const d = rng.range(1.1, 2.1);
            const sx = x + Math.cos(a) * d;
            const sz = z + Math.sin(a) * d;
            chairs.push({
              x: sx,
              y: model.beachHeight(sx, sz),
              z: sz,
              // chairs face the water
              yaw: Math.atan2(stn.nx, stn.nz) + rng.range(-0.7, 0.7),
              scale: rng.range(0.92, 1.08),
              variant: rng.int(0, 2),
              tint: rng.int(0, P.awning.length - 1),
            });
          }
          if (rng.bool(0.55)) {
            const a = yaw + rng.range(0, 6.283);
            const d = rng.range(1.6, 3.2);
            const tx = x + Math.cos(a) * d;
            const tz = z + Math.sin(a) * d;
            towels.push({
              x: tx,
              y: model.beachHeight(tx, tz),
              z: tz,
              yaw: rng.range(0, 6.283),
              scale: rng.range(0.9, 1.2),
              variant: 0,
              tint: rng.int(0, P.awning.length - 1),
            });
          }
        }
      }
    }

    this.putTinted(buildUmbrella(), umbrellas, cloth, 'props/umbrella', P.awning);
    this.putVariants([0, 1, 2].map((v) => buildChair(v)), chairs, solid, 'props/chair', P.awning);
    this.putTinted(buildTowel(), towels, cloth, 'props/towel', P.awning);
  }

  /* ---------------------------------------------------- boats, gear, buoys */

  private buildBoatsAndGear(
    model: CoastModel,
    rng: RNG,
    density: number,
    solid: THREE.Material,
    floating: THREE.Material,
  ): void {
    const beached: Place[] = [];
    const moored: Place[] = [];
    const buoys: Place[] = [];
    const gear: Place[] = [];

    const hulls = [P.hullWhite, P.hullBlue, P.hullGreen, P.hullRed, P.hullYellow];

    for (const span of model.spans) {
      const st = span.stations;

      /* --- yolas drawn up on the sand, bows to the water --- */
      {
        const n = Math.max(1, Math.round((span.length / 55) * density));
        for (let i = 0; i < n; i++) {
          const stn = sampleSpan(st, rng.range(8, span.length - 8));
          if (stn.dock) continue;
          const off = rng.range(6, 15);
          const x = stn.x - stn.nx * off + rng.range(-4, 4);
          const z = stn.z - stn.nz * off + rng.range(-4, 4);
          const y = model.beachHeight(x, z);
          if (y < SEA_LEVEL + 0.6) continue;
          if (model.distToRamp(x, z) < 13) continue;
          beached.push({
            x,
            y: y + 0.18,
            z,
            yaw: Math.atan2(stn.nx, stn.nz) + rng.range(-0.5, 0.5),
            scale: rng.range(0.92, 1.2),
            variant: 0,
            tint: rng.int(0, hulls.length - 1),
          });
          // gear scattered around each boat
          for (let g = 0; g < rng.int(1, 3); g++) {
            const gx = x + rng.gaussian() * 2.4;
            const gz = z + rng.gaussian() * 2.4;
            const gy = model.beachHeight(gx, gz);
            if (gy < SEA_LEVEL + 0.8) continue;
            gear.push({
              x: gx,
              y: gy,
              z: gz,
              yaw: rng.range(0, 6.283),
              scale: rng.range(0.85, 1.2),
              variant: rng.int(0, 3),
              tint: 0,
            });
          }
        }
      }

      /* --- moored pangas and the swim-line buoys, out in the shallows --- */
      const mooring = Math.max(1, Math.round((span.length / 70) * density));
      for (let i = 0; i < mooring; i++) {
        const stn = sampleSpan(st, rng.range(6, span.length - 6));
        const off = rng.range(14, 34);
        const x = stn.x + stn.nx * off + rng.range(-6, 6);
        const z = stn.z + stn.nz * off + rng.range(-6, 6);
        moored.push({
          x,
          y: SEA_LEVEL + 0.12,
          z,
          yaw: Math.atan2(stn.nx, stn.nz) + rng.range(-0.9, 0.9),
          scale: rng.range(1.0, 1.35),
          variant: 0,
          tint: rng.int(0, hulls.length - 1),
        });
      }
      const buoyN = Math.round((span.length / 16) * density);
      for (let i = 0; i < buoyN; i++) {
        const stn = sampleSpan(st, ((i + 0.5) / Math.max(1, buoyN)) * span.length);
        const off = 20 + Math.sin(i * 1.7) * 4;
        buoys.push({
          x: stn.x + stn.nx * off,
          y: SEA_LEVEL,
          z: stn.z + stn.nz * off,
          yaw: rng.range(0, 6.283),
          scale: rng.range(0.85, 1.15),
          variant: 0,
          tint: i % 2,
        });
      }
    }

    this.putTinted(buildBoat(false), beached, solid, 'props/yola', hulls);
    this.putTinted(buildBoat(true), moored, floating, 'props/panga', hulls, {
      rng,
      response: 0.42,
    });
    this.putTinted(buildBuoy(), buoys, floating, 'props/buoy', [P.buoyOrange, P.buoyWhite], {
      rng,
      response: 1.0,
    });
    this.putVariants(
      [0, 1, 2, 3].map((v) => buildGear(v, rng.fork(v * 401 + 3))),
      gear,
      solid,
      'props/gear',
    );
  }

  /* ------------------------------------------------------------ lifeguard */

  private buildLifeguard(model: CoastModel, rng: RNG, solid: THREE.Material): void {
    const places: Place[] = [];
    for (const span of model.spans) {
      if (span.length < 90) continue;
      for (const f of [0.3, 0.62, 0.86]) {
        const stn = sampleSpan(span.stations, span.length * f);
        if (stn.dock) continue;
        const off = stn.width * 0.42;
        const x = stn.x - stn.nx * off;
        const z = stn.z - stn.nz * off;
        const y = model.beachHeight(x, z);
        if (y < SEA_LEVEL + 1.2) continue;
        if (model.distToRamp(x, z) < 14) continue;
        places.push({
          x,
          y,
          z,
          yaw: Math.atan2(stn.nx, stn.nz),
          scale: rng.range(0.95, 1.1),
          variant: 0,
          tint: 0,
        });
      }
    }
    this.putVariants([buildLifeguardStand()], places, solid, 'props/lifeguard');
  }

  /* ----------------------------------------------------------------- pier */

  /**
   * The muelle: a timber deck on pilings running out over the water, with a
   * kicker at the end. Rendered as one merged mesh and collided as one trimesh
   * — so you can drive the length of it and launch off the lip.
   */
  private buildPier(
    model: CoastModel,
    rng: RNG,
    opts: WorldOpts,
    solid: THREE.Material,
  ): void {
    const span = model.spans.find((s) => s.length > 120);
    if (!span) return;
    // put the muelle on open beach, clear of the cruise apron
    let stn = sampleSpan(span.stations, span.length * 0.5);
    for (let i = 0; i < 12 && stn.dock; i++) {
      stn = sampleSpan(span.stations, span.length * (0.5 + (i + 1) * 0.035));
    }
    if (stn.dock) return;

    const gb = new GeoBuilder().enableAux();
    const colPos: number[] = [];
    const colIdx: number[] = [];
    const addCol = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
      const base = colPos.length / 3;
      colPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      colIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    // start well up the dry beach so the approach is drivable, run out to sea
    const startOff = -26;
    const length = 74;
    const width = 7.2;
    const deckY = SEA_LEVEL + 3.4;
    const nx = stn.nx;
    const nz = stn.nz;
    const px = -nz;
    const pz = nx;
    const x0 = stn.x + nx * startOff;
    const z0 = stn.z + nz * startOff;
    const groundAtStart = model.beachHeight(x0, z0);

    const at = (t: number, side: number, y: number, out: THREE.Vector3): THREE.Vector3 => {
      const d = t * length;
      return out.set(x0 + nx * d + px * side * width * 0.5, y, z0 + nz * d + pz * side * width * 0.5);
    };

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    const outward = new THREE.Vector3();
    const UP_ = new THREE.Vector3(0, 1, 0);

    // deck: ramps up off the sand over the first stretch, then runs level and
    // kicks up at the very end
    const SEG = 30;
    const deckAt = (t: number): number => {
      const rampIn = clamp01(t / 0.28);
      const y = lerp(groundAtStart + 0.25, deckY, rampIn * rampIn * (3 - 2 * rampIn));
      // the kicker: the last 12 % of the deck lifts 2.1 m
      const kick = clamp01((t - 0.88) / 0.12);
      return y + kick * kick * 2.1;
    };

    for (let i = 0; i < SEG; i++) {
      const t0 = i / SEG;
      const t1 = (i + 1) / SEG;
      const y0 = deckAt(t0);
      const y1 = deckAt(t1);
      at(t0, -1, y0, a);
      at(t0, 1, y0, b);
      at(t1, 1, y1, c);
      at(t1, -1, y1, d);
      // planking runs across the pier; alternate the shade so it reads as boards
      const plank = (i & 1) === 0 ? P.timber : P.timberDark;
      gb.quadTowards(a.clone(), b.clone(), c.clone(), d.clone(), plank, 0.7, UP_);
      addCol(a.clone(), b.clone(), c.clone(), d.clone());

      // fascia boards down both sides
      for (const side of [-1, 1]) {
        at(t0, side, y0, a);
        at(t1, side, y1, b);
        outward.set(px * side, 0, pz * side);
        gb.quadTowards(
          a.clone(),
          b.clone(),
          b.clone().setY(y1 - 0.45),
          a.clone().setY(y0 - 0.45),
          P.timberDark,
          0.7,
          outward,
        );
        // low kerb rail so you cannot dribble off the side by accident (R3)
        const rail = a.clone().setY(y0 + 0.34);
        const rail2 = b.clone().setY(y1 + 0.34);
        gb.quadTowards(a.clone().setY(y0), b.clone().setY(y1), rail2, rail, P.timber, 0.7, outward);
        gb.quadTowards(
          rail,
          rail2,
          rail2.clone().addScaledVector(outward, 0.18),
          rail.clone().addScaledVector(outward, 0.18),
          P.timber,
          0.7,
          UP_,
        );
      }
    }

    // pilings in braced pairs, every 8 m, driven into the sea floor
    for (let t = 0.06; t < 1.0; t += 8 / length) {
      const y = deckAt(t) - 0.45;
      for (const side of [-1, 1]) {
        at(t, side * 0.86, y, a);
        const floor = Math.min(model.layout.groundHeight(a.x, a.z), SEA_LEVEL) - 1.4;
        gb.cylinder(a.x, floor, a.z, 0.28, 0.23, y - floor, 7, P.timberDark);
      }
      // cross brace under the deck
      at(t, -0.86, y, a);
      at(t, 0.86, y, b);
      gb.box(
        (a.x + b.x) * 0.5,
        y - 0.55,
        (a.z + b.z) * 0.5,
        width * 0.46,
        0.11,
        0.11,
        P.timberDark,
        -Math.atan2(pz, px),
      );
    }

    // hazard stripes on the kicker lip so it reads as a jump from distance (R4)
    at(1, -1, deckAt(1), a);
    at(1, 1, deckAt(1), b);
    for (let i = 0; i < 6; i++) {
      const f0 = i / 6;
      const f1 = (i + 1) / 6;
      const s0 = a.clone().lerp(b, f0);
      const s1 = a.clone().lerp(b, f1);
      gb.quadTowards(
        s0.clone(),
        s1.clone(),
        s1.clone().add(new THREE.Vector3(nx, 0, nz).multiplyScalar(1.1)),
        s0.clone().add(new THREE.Vector3(nx, 0, nz).multiplyScalar(1.1)),
        (i & 1) === 0 ? 0xd94f3d : 0xf4efe2,
        0.7,
        UP_,
      );
    }
    // lip apron collider so the launch angle is honest
    addCol(
      a.clone(),
      b.clone(),
      b.clone().add(new THREE.Vector3(nx, 0, nz).multiplyScalar(1.1)),
      a.clone().add(new THREE.Vector3(nx, 0, nz).multiplyScalar(1.1)),
    );

    // a little shelter at the head of the pier — a silhouette event (R6)
    const hx = x0 + nx * length * 0.62 + px * width * 0.72;
    const hz = z0 + nz * length * 0.62 + pz * width * 0.72;
    const hy = deckAt(0.62);
    const yaw = -Math.atan2(pz, px);
    gb.cylinder(hx, hy, hz, 0.1, 0.1, 2.4, 6, P.timberDark);
    gb.box(hx, hy + 2.55, hz, 1.5, 0.09, 1.5, P.awning[1], yaw);

    const geo = gb.build('aFlag');
    if (geo) {
      const mesh = new THREE.Mesh(geo, solid);
      mesh.name = 'props/pier';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.geometries.push(geo);
      this.meshes.push(mesh);
      this._stats.triangles += gb.triangleCount;
    }

    if (colIdx.length > 0) {
      this.bodies.push(
        opts.physics.createBody({
          kind: 'static',
          shape: {
            type: 'trimesh',
            vertices: new Float32Array(colPos),
            indices: new Uint32Array(colIdx),
          },
          position: new THREE.Vector3(0, 0, 0),
          friction: 0.92,
          restitution: 0.02,
          group: GROUP.WORLD,
          mask: GROUP.VEHICLE | GROUP.TRAFFIC | GROUP.PROP | GROUP.PED | GROUP.DEBRIS,
          userData: { kind: 'world', surface: 'pier' },
        }),
      );
    }

    // a couple of boats tied up alongside
    const tied: Place[] = [];
    for (let i = 0; i < 3; i++) {
      const t = rng.range(0.42, 0.9);
      const side = rng.bool() ? 1 : -1;
      const dd = t * length;
      tied.push({
        x: x0 + nx * dd + px * side * (width * 0.5 + rng.range(2.2, 3.4)),
        y: SEA_LEVEL + 0.12,
        z: z0 + nz * dd + pz * side * (width * 0.5 + rng.range(2.2, 3.4)),
        yaw: -Math.atan2(pz, px) + rng.range(-0.15, 0.15),
        scale: rng.range(1.0, 1.25),
        variant: 0,
        tint: rng.int(0, 4),
      });
    }
    const hulls = [P.hullWhite, P.hullBlue, P.hullGreen, P.hullRed, P.hullYellow];
    const floating = this.materials.find((m) => m.name === 'loco/coastFloating');
    if (floating) {
      this.putTinted(buildBoat(true), tied, floating, 'props/pierBoat', hulls, {
        rng,
        response: 0.5,
      });
    }
  }

  /* ---------------------------------------------------------------- gulls */

  private buildGulls(model: CoastModel, rng: RNG, density: number): void {
    const count = Math.round(34 * density);
    if (count < 1) return;

    const geo = buildGull();
    const mat = new THREE.MeshStandardMaterial({
      name: 'loco/coastGull',
      vertexColors: true,
      roughness: 0.72,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.9,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GULL_PARS}`)
        .replace('#include <begin_vertex>', GULL_BEGIN);
    };
    mat.customProgramCacheKey = () => 'loco/coast-gull-v1';
    this.materials.push(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = 'props/gulls';
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const data = new Float32Array(count * 4);
    const spans = model.spans.length > 0 ? model.spans : [];

    for (let i = 0; i < count; i++) {
      let x = rng.range(-320, 340);
      let z = rng.range(255, 320);
      if (spans.length > 0) {
        const span = spans[rng.int(0, spans.length - 1)];
        const stn = sampleSpan(span.stations, rng.next() * span.length);
        const off = rng.range(-24, 46);
        x = stn.x + stn.nx * off + rng.range(-18, 18);
        z = stn.z + stn.nz * off + rng.range(-18, 18);
      }
      const y = SEA_LEVEL + rng.range(9, 34);
      p.set(x, y, z);
      q.setFromAxisAngle(WORLD_UP, rng.range(0, Math.PI * 2));
      s.setScalar(rng.range(0.8, 1.35));
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      data[i * 4] = rng.next(); // phase
      data[i * 4 + 1] = rng.range(7, 26); // orbit radius
      data[i * 4 + 2] = rng.range(0.08, 0.22) * (rng.bool() ? 1 : -1); // orbit rate
      data[i * 4 + 3] = rng.range(3.4, 6.2); // flap rate
    }
    mesh.instanceMatrix.needsUpdate = true;
    geo.setAttribute('aBird', new THREE.InstancedBufferAttribute(data, 4));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // orbit + flap push well outside the instance bounds; the flock is tiny
    mesh.frustumCulled = false;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geo);
    this._stats.birds = count;
    this._stats.instances += count;
    this._stats.triangles += triCount(geo) * count;
  }

  /* -------------------------------------------------------------- helpers */

  /**
   * One instanced mesh per geometry variant, bucketed by `place.variant`.
   * Use this only where the variants are genuinely different *shapes*; colour
   * variation belongs in `palette`, which rides on the per-instance tint.
   */
  private putVariants(
    geos: THREE.BufferGeometry[],
    places: Place[],
    mat: THREE.Material,
    name: string,
    palette?: readonly number[],
    opts?: { rng: RNG; response: number },
  ): void {
    if (places.length === 0) {
      for (const g of geos) g.dispose();
      return;
    }
    const buckets: Place[][] = geos.map(() => []);
    for (const p of places) buckets[p.variant % geos.length].push(p);

    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();

    for (let v = 0; v < geos.length; v++) {
      const list = buckets[v];
      if (list.length === 0) {
        geos[v].dispose();
        continue;
      }
      const mesh = new THREE.InstancedMesh(geos[v], mat, list.length);
      mesh.name = `${name}${geos.length > 1 ? v : ''}`;
      const tint = palette ? new Float32Array(list.length * 3) : null;
      const bob = opts ? new Float32Array(list.length * 2) : null;

      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        pos.set(it.x, it.y, it.z);
        q.setFromAxisAngle(WORLD_UP, it.yaw);
        sc.setScalar(it.scale);
        m.compose(pos, q, sc);
        mesh.setMatrixAt(i, m);
        if (tint && palette) {
          col.setHex(palette[it.tint % palette.length], THREE.SRGBColorSpace);
          tint[i * 3] = col.r;
          tint[i * 3 + 1] = col.g;
          tint[i * 3 + 2] = col.b;
        }
        if (bob && opts) {
          bob[i * 2] = opts.rng.next();
          bob[i * 2 + 1] = opts.response * opts.rng.range(0.8, 1.2);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (tint) geos[v].setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      if (bob) geos[v].setAttribute('aFloat', new THREE.InstancedBufferAttribute(bob, 2));
      this.finish(mesh, geos[v], opts ? 1.2 : 0.4);
    }
  }

  /** Single geometry, one draw, colour variety carried per instance. */
  private putTinted(
    geo: THREE.BufferGeometry,
    places: Place[],
    mat: THREE.Material,
    name: string,
    palette: readonly number[],
    opts?: { rng: RNG; response: number },
  ): void {
    this.putVariants([geo], places, mat, name, palette, opts);
  }

  private finish(mesh: THREE.InstancedMesh, geo: THREE.BufferGeometry, pad = 0.4): void {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += pad;
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geo);
    this._stats.instances += mesh.count;
    this._stats.triangles += triCount(geo) * mesh.count;
  }

  /* -------------------------------------------------------------- runtime */

  update(_cameraPos: THREE.Vector3, dt: number): void {
    this.uniforms.uTime.value += dt;
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    const d = QUALITY_BUDGET[tier].propDetailDistance;
    for (const m of this.meshes) {
      if (m.name.startsWith('props/towel') || m.name.startsWith('props/gear')) {
        m.visible = d >= 100;
      } else if (m.name === 'props/gulls') {
        m.visible = d >= 80;
      }
    }
  }

  stats(): Record<string, number> {
    return {
      propInstances: this._stats.instances,
      propTriangles: Math.round(this._stats.triangles),
      propDrawCalls: this.group.children.length,
      propBirds: this._stats.birds,
    };
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const m of this.meshes) {
      if (m instanceof THREE.InstancedMesh) m.dispose();
    }
    this.meshes.length = 0;
    if (this.physics) for (const b of this.bodies) this.physics.removeBody(b);
    this.bodies.length = 0;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ========================================================================== *
 *  prop geometry
 * ========================================================================== */

interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** which geometry variant (a different *shape*) */
  variant: number;
  /** index into the family's palette (a different *colour*) */
  tint: number;
}

/** (1,0,0) in the aux channel marks a vertex as taking the per-instance tint. */
const TINTED = new THREE.Vector3(1, 0, 0);

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function triCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  if (idx) return idx.count / 3;
  const pos = geo.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/**
 * A beach kiosk. Local frame: origin on the ground, +Z is the serving side.
 * Roughly 3.2 × 2.6 m — small enough not to eat the drivable corridor (R1).
 */
function buildKiosk(rng: RNG, variant: number): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  // the wall is authored white and takes its colour from the instance tint
  const wall = 0xffffff;
  const w = 1.5 + variant * 0.14;
  const d = 1.25;
  const h = 2.4 + variant * 0.1;

  // body, with a darker splash zone at the base per §5
  gb.box(0, h * 0.5, 0, w, h * 0.5, d, wall, 0, TINTED);
  gb.box(0, 0.28, 0, w * 1.01, 0.28, d * 1.01, 0xbdb49c);
  // roof slab with an overhang
  gb.box(0, h + 0.12, 0.1, w * 1.24, 0.12, d * 1.3, P.kioskTrim);
  // serving counter jutting out on +Z
  gb.box(0, 1.06, d + 0.32, w * 0.92, 0.09, 0.34, P.counter);
  gb.box(0, 0.52, d + 0.18, w * 0.88, 0.52, 0.1, wall, 0, TINTED);
  // hatch opening — a dark recess so the shack reads as open for business
  gb.box(0, 1.62, d + 0.02, w * 0.82, 0.5, 0.06, 0x1c2226);
  // menu board on the side
  gb.box(w + 0.06, 1.55, 0, 0.05, 0.55, 0.4, P.board, 0);
  // a small chimney / extractor, for silhouette
  if (rng.bool(0.6)) gb.cylinder(w * 0.55, h + 0.2, -d * 0.4, 0.11, 0.09, 0.7, 6, P.metal);
  // bottle crates stacked at the back
  for (let i = 0; i < rng.int(1, 3); i++) {
    gb.box(-w * 0.6 + i * 0.02, 0.16 + i * 0.3, -d - 0.28, 0.28, 0.15, 0.2, P.crateBlue, rng.range(-0.3, 0.3));
  }

  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty kiosk');
  return geo;
}

/** Striped awning cantilevered over the kiosk counter. */
function buildAwning(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const w = 2.05;
  const reach = 1.5;
  const yBack = 2.62;
  const yFront = 2.16;
  const zBack = 1.2;
  const strips = 8;
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < strips; i++) {
    const f0 = i / strips;
    const f1 = (i + 1) / strips;
    const x0 = lerp(-w, w, f0);
    const x1 = lerp(-w, w, f1);
    // odd strips take the instance tint, even strips stay canvas white
    const tinted = (i & 1) === 0;
    const col = tinted ? 0xffffff : P.awningPale;
    const flag = tinted ? TINTED : undefined;
    gb.quadTowards(
      new THREE.Vector3(x0, yBack, zBack),
      new THREE.Vector3(x1, yBack, zBack),
      new THREE.Vector3(x1, yFront, zBack + reach),
      new THREE.Vector3(x0, yFront, zBack + reach),
      col,
      0.8,
      up,
      flag,
    );
    // scalloped valance hanging off the front edge
    gb.quadTowards(
      new THREE.Vector3(x0, yFront, zBack + reach),
      new THREE.Vector3(x1, yFront, zBack + reach),
      new THREE.Vector3(x1, yFront - 0.26, zBack + reach),
      new THREE.Vector3(x0, yFront - 0.26, zBack + reach),
      col,
      0.8,
      new THREE.Vector3(0, 0, 1),
      flag,
    );
  }
  // the two poles holding the front edge up
  for (const s of [-1, 1]) {
    gb.cylinder(s * w * 0.9, 0, zBack + reach, 0.045, 0.04, yFront, 5, P.metal);
  }
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty awning');
  return geo;
}

/** Beach umbrella: a segmented canopy on a mast, tilted a little. */
function buildUmbrella(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const h = 2.25;
  const r = 1.55;
  const segs = 10;
  const up = new THREE.Vector3(0, 1, 0);
  gb.cylinder(0, 0, 0, 0.045, 0.035, h, 6, 0xd8d2c2);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const tinted = (i & 1) === 0;
    const col = tinted ? 0xffffff : P.awningPale;
    const apex = new THREE.Vector3(0, h + 0.22, 0);
    const p0 = new THREE.Vector3(Math.cos(a0) * r, h - 0.34, Math.sin(a0) * r);
    const p1 = new THREE.Vector3(Math.cos(a1) * r, h - 0.34, Math.sin(a1) * r);
    // scallop the rim outward so it is not a clean cone
    const mid = new THREE.Vector3(
      Math.cos((a0 + a1) * 0.5) * r * 1.1,
      h - 0.42,
      Math.sin((a0 + a1) * 0.5) * r * 1.1,
    );
    gb.quadTowards(apex, p0, mid, p1, col, 0.7, up, tinted ? TINTED : undefined);
  }
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty umbrella');
  return geo;
}

/** Folding beach chair, three slightly different postures. */
function buildChair(variant: number): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const recline = [0.55, 0.95, 1.25][variant % 3];
  const fabric = 0xffffff;
  // frame
  for (const s of [-1, 1]) {
    gb.box(s * 0.29, 0.22, 0, 0.028, 0.22, 0.028, P.metal, 0);
    gb.box(s * 0.29, 0.22, 0.5, 0.028, 0.22, 0.028, P.metal, 0);
  }
  gb.box(0, 0.45, 0.25, 0.31, 0.03, 0.29, fabric, 0, TINTED);
  // back rest, laid back by `recline`
  const bh = 0.62;
  const bx = Math.sin(recline) * bh * 0.5;
  const by = Math.cos(recline) * bh * 0.5;
  gb.box(0, 0.45 + by, -0.02 - bx, 0.3, bh * 0.5, 0.03, fabric, 0, TINTED);
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty chair');
  return geo;
}

/** A towel laid out flat on the sand — a splash of colour, six triangles. */
function buildTowel(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const up = new THREE.Vector3(0, 1, 0);
  gb.quadTowards(
    new THREE.Vector3(-0.5, 0.03, -0.85),
    new THREE.Vector3(0.5, 0.035, -0.85),
    new THREE.Vector3(0.5, 0.03, 0.85),
    new THREE.Vector3(-0.5, 0.035, 0.85),
    0xffffff,
    1.2,
    up,
    TINTED,
  );
  gb.quadTowards(
    new THREE.Vector3(-0.5, 0.028, -0.3),
    new THREE.Vector3(0.5, 0.028, -0.3),
    new THREE.Vector3(0.5, 0.028, 0.3),
    new THREE.Vector3(-0.5, 0.028, 0.3),
    P.awningPale,
    1.2,
    up,
  );
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty towel');
  return geo;
}

/**
 * A yola: the small open fishing boat you see pulled up on any Puerto Rican
 * beach. Local +Z is the bow. `afloat` sinks it to its waterline.
 */
function buildBoat(afloat: boolean): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const L = 2.4;
  const B = 0.78;
  const D = 0.62;
  const sink = afloat ? -0.24 : 0;
  const stations = 7;
  const up = new THREE.Vector3(0, 1, 0);

  const beamAt = (t: number): number => Math.sin(Math.pow(t, 0.78) * Math.PI) * 0.94 + 0.1;
  const sheerAt = (t: number): number => D + Math.pow(Math.abs(t - 0.46) * 2, 2.2) * 0.2;

  // hull: keel line up to the sheer on both sides
  const rows: number[][] = [];
  const cRow: number[][] = [];
  // the hull is authored white; the instance tint paints it
  const cHull = new THREE.Color(1, 1, 1);
  const cBoot = new THREE.Color().setHex(P.bootTop, THREE.SRGBColorSpace);
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const z = lerp(-L, L, t);
    const beam = beamAt(t) * B;
    const sheer = sheerAt(t) + sink;
    const keelY = sink - 0.16 + Math.pow(Math.abs(t - 0.5) * 2, 2.4) * 0.2;
    const row: number[] = [];
    const crow: number[] = [];
    for (const s of [-1, 1]) {
      // keel, turn of the bilge, sheer
      row.push(
        gb.vertex(0, keelY, z, 0, -1, 0, 0, t, cBoot.r, cBoot.g, cBoot.b),
        gb.vertex(s * beam * 0.82, keelY + (sheer - keelY) * 0.42, z, s, 0.2, 0, 0.4, t, cBoot.r * 1.1, cBoot.g * 1.1, cBoot.b * 1.1),
        gb.vertex(s * beam, sheer, z, s, 0.35, 0, 1, t, cHull.r, cHull.g, cHull.b),
      );
      crow.push(0);
    }
    rows.push(row);
    cRow.push(crow);
  }
  for (let i = 0; i < stations; i++) {
    const A = rows[i];
    const Bv = rows[i + 1];
    // A = [keelL, bilgeL, sheerL, keelR, bilgeR, sheerR]
    gb.quadIdx(A[0], Bv[0], Bv[1], A[1]);
    gb.quadIdx(A[1], Bv[1], Bv[2], A[2]);
    gb.quadIdx(A[4], Bv[4], Bv[3], A[3]);
    gb.quadIdx(A[5], Bv[5], Bv[4], A[4]);
  }
  // interior: a dark sole and two thwarts
  gb.quadTowards(
    new THREE.Vector3(-B * 0.72, sink + 0.28, -L * 0.75),
    new THREE.Vector3(B * 0.72, sink + 0.28, -L * 0.75),
    new THREE.Vector3(B * 0.72, sink + 0.28, L * 0.75),
    new THREE.Vector3(-B * 0.72, sink + 0.28, L * 0.75),
    0x4a4238,
    0.6,
    up,
  );
  for (const zt of [-0.42, 0.16]) {
    gb.box(0, sink + 0.5, L * zt, B * 0.8, 0.045, 0.12, P.timber);
  }
  // outboard on the transom
  gb.box(0, sink + 0.62, -L - 0.1, 0.16, 0.24, 0.14, 0x2c3238);
  gb.cylinder(0, sink + 0.1, -L - 0.12, 0.06, 0.05, 0.45, 6, 0x2c3238, false);
  // a rope coil at the bow
  gb.cylinder(0, sink + 0.56, L * 0.72, 0.15, 0.15, 0.07, 8, P.rope);

  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty boat');
  geo.computeVertexNormals();
  return geo;
}

/** A marker buoy on a short tether. */
function buildBuoy(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  gb.cylinder(0, -0.28, 0, 0.05, 0.3, 0.34, 8, 0xffffff, false, TINTED);
  gb.cylinder(0, 0.06, 0, 0.3, 0.24, 0.24, 8, 0xffffff, true, TINTED);
  gb.cylinder(0, 0.3, 0, 0.06, 0.05, 0.42, 5, P.metal);
  gb.box(0, 0.76, 0, 0.13, 0.1, 0.02, P.buoyWhite);
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty buoy');
  return geo;
}

/** Fishing gear: pot stacks, net rolls, crates, an oar leaning on nothing. */
function buildGear(variant: number, rng: RNG): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  switch (variant % 4) {
    case 0: {
      // stack of fish crates
      const n = rng.int(2, 4);
      for (let i = 0; i < n; i++) {
        gb.box(
          rng.range(-0.08, 0.08),
          0.13 + i * 0.26,
          rng.range(-0.08, 0.08),
          0.32,
          0.13,
          0.22,
          i % 2 === 0 ? P.crateBlue : P.crate,
          rng.range(-0.25, 0.25),
        );
      }
      break;
    }
    case 1: {
      // rolled net, lashed
      gb.cylinder(0, 0.22, 0, 0.24, 0.24, 0.9, 8, P.net, true);
      gb.box(0, 0.22, 0, 0.26, 0.03, 0.95, P.rope, 0.4);
      break;
    }
    case 2: {
      // a stack of wire fish pots
      for (let i = 0; i < rng.int(2, 3); i++) {
        gb.box(rng.range(-0.1, 0.1), 0.2 + i * 0.4, 0, 0.36, 0.2, 0.28, 0x8b8574, rng.range(-0.4, 0.4));
      }
      break;
    }
    default: {
      // oars and a bucket
      for (let i = 0; i < 2; i++) {
        const a = 0.35 + i * 0.14;
        gb.box(Math.sin(a) * 0.7, 0.7, i * 0.12, 0.035, 0.72, 0.035, P.timber, 0);
        gb.box(Math.sin(a) * 1.35, 0.06, i * 0.12, 0.09, 0.05, 0.2, P.timber, 0);
      }
      gb.cylinder(-0.35, 0, 0.2, 0.14, 0.17, 0.3, 8, 0xd94f3d, false);
      break;
    }
  }
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty gear');
  return geo;
}

/** Lifeguard stand: the tallest thing on the sand, a real landmark (R6). */
function buildLifeguardStand(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const legs = 1.05;
  const deckY = 2.35;
  const up = new THREE.Vector3(0, 1, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // splayed legs
      gb.cylinder(sx * legs, 0, sz * legs, 0.075, 0.06, deckY, 5, P.timber);
      gb.box(sx * legs, deckY * 0.42, sz * legs * 0.5, 0.05, 0.05, legs * 0.55, P.timberDark, 0);
    }
  }
  // deck and rails
  gb.box(0, deckY + 0.06, 0, legs + 0.22, 0.06, legs + 0.22, P.timber);
  for (const sx of [-1, 1]) {
    gb.box(sx * (legs + 0.18), deckY + 0.5, 0, 0.05, 0.45, legs + 0.22, P.guardTrim);
  }
  gb.box(0, deckY + 0.5, -(legs + 0.18), legs + 0.22, 0.45, 0.05, P.guardTrim);
  // roof on four posts
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      gb.cylinder(sx * legs, deckY + 0.12, sz * legs, 0.05, 0.045, 1.5, 5, P.timber);
    }
  }
  // pitched roof, two slopes
  const rh = deckY + 1.62;
  const r = legs + 0.42;
  for (const s of [-1, 1]) {
    gb.quadTowards(
      new THREE.Vector3(-r, rh, s * r),
      new THREE.Vector3(r, rh, s * r),
      new THREE.Vector3(r, rh + 0.52, 0),
      new THREE.Vector3(-r, rh + 0.52, 0),
      P.guard,
      0.7,
      up,
    );
  }
  // a life ring hung on the rail — the readable red-and-white detail
  gb.cylinder(0, deckY + 0.34, legs + 0.2, 0.3, 0.3, 0.07, 10, P.guard);
  gb.cylinder(0, deckY + 0.345, legs + 0.2, 0.19, 0.19, 0.08, 10, P.guardTrim);
  const geo = gb.build('aFlag');
  if (!geo) throw new Error('CoastProps: empty lifeguard stand');
  return geo;
}

/**
 * A seagull. Two wings and a body, ~14 triangles. `aWing` runs 0 at the spine
 * to 1 at the wingtip, which is all the flap shader needs.
 */
function buildGull(): THREE.BufferGeometry {
  const gb = new GeoBuilder().enableAux();
  const body = new THREE.Color().setHex(P.gull, THREE.SRGBColorSpace);
  const tip = new THREE.Color().setHex(P.gullTip, THREE.SRGBColorSpace);
  const beak = new THREE.Color().setHex(P.gullBeak, THREE.SRGBColorSpace);

  const v = (
    x: number,
    y: number,
    z: number,
    c: THREE.Color,
    wing: number,
  ): number => gb.vertex(x, y, z, 0, 1, 0, 0.5, 0.5, c.r, c.g, c.b, wing, 0, 0);

  // body: a slim wedge along Z
  const nose = v(0, 0, 0.42, body, 0);
  const tail = v(0, 0.04, -0.4, body, 0);
  const l = v(-0.075, -0.02, 0, body, 0);
  const r = v(0.075, -0.02, 0, body, 0);
  const top = v(0, 0.09, 0.02, body, 0);
  gb.tri(nose, r, top);
  gb.tri(nose, top, l);
  gb.tri(tail, top, r);
  gb.tri(tail, l, top);
  gb.tri(nose, l, r);
  gb.tri(tail, r, l);
  // beak
  const bk = v(0, -0.01, 0.6, beak, 0);
  gb.tri(nose, r, bk);
  gb.tri(nose, bk, l);

  // wings: root, mid, tip — swept back, with dark primaries
  for (const s of [-1, 1]) {
    const root0 = v(s * 0.07, 0.03, 0.14, body, 0);
    const root1 = v(s * 0.07, 0.03, -0.16, body, 0);
    const mid0 = v(s * 0.52, 0.05, 0.06, body, 0.5);
    const mid1 = v(s * 0.52, 0.05, -0.3, body, 0.5);
    const tip0 = v(s * 0.98, 0.02, -0.16, tip, 1);
    const tip1 = v(s * 0.9, 0.02, -0.42, tip, 1);
    if (s < 0) {
      gb.quadIdx(root0, mid0, mid1, root1);
      gb.quadIdx(mid0, tip0, tip1, mid1);
    } else {
      gb.quadIdx(root0, root1, mid1, mid0);
      gb.quadIdx(mid0, mid1, tip1, tip0);
    }
  }
  // tail fan
  const t0 = v(-0.14, 0.03, -0.58, body, 0.25);
  const t1 = v(0.14, 0.03, -0.58, body, 0.25);
  gb.tri(tail, t0, t1);
  gb.tri(tail, t1, t0);

  const geo = gb.build('aWing3');
  if (!geo) throw new Error('CoastProps: empty gull');
  // the flap shader wants a single float; take the x channel of the aux vec3
  const aux = geo.getAttribute('aWing3') as THREE.BufferAttribute;
  const flat = new Float32Array(aux.count);
  for (let i = 0; i < aux.count; i++) flat[i] = aux.getX(i);
  geo.deleteAttribute('aWing3');
  geo.setAttribute('aWing', new THREE.Float32BufferAttribute(flat, 1));
  geo.computeVertexNormals();
  return geo;
}
