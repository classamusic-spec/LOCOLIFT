/**
 * Loco Lift — scooters and small motorcycles.
 *
 * Old San Juan runs on two wheels as much as four: the reference photograph
 * has a scooter riding straight down the middle of a narrow calle. They are
 * the most characterful traffic in the city, so they get their own behaviour:
 *
 *  - **faster** than cars and much quicker off the line,
 *  - they **filter** — when the queue in front slows down they pull toward the
 *    centreline and slip past instead of waiting,
 *  - they **take the callejones**, the one road class cars never touch,
 *  - they **lean** into corners, hard, which is what sells them at speed.
 *
 * Each is one merged geometry (bike + rider) drawn from a shared InstancedMesh,
 * using the same role/wheel vertex protocol as `VehicleKit` — bodywork on
 * `ROLE.PAINT`, the rider's shirt and helmet on `ROLE.TRIM`.
 */
import * as THREE from 'three';
import type { RNG } from '../core/RNG';
import type { RoadEdge } from '../core/types';
import { clamp, damp } from '../core/MathUtils';
import {
  InstancedFleet,
  ROLE,
  VehicleParts,
  WHEEL,
  type VehicleTypeDef,
} from './VehicleKit';
import { SCOOTER, SCOOTER_PAINT, SKIN_RAMP } from './TrafficTuning';
import type { RoadAgent } from './TrafficVehicle';

/* ------------------------------------------------------------- primitives */

const _mat4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

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

const wheelCylinder = (radius: number, width: number, seg: number): THREE.BufferGeometry => {
  const g = new THREE.CylinderGeometry(radius, radius, width, seg, 1, false);
  g.rotateZ(Math.PI / 2);
  return g;
};

const TYRE = 0x14161a;
const RIM = 0xa8b0b6;
const CHROME = 0xc0c7cc;
const DARK = 0x24282c;
const GLASS = 0x1b2430;
const LAMP_WHITE = 0xfff2dc;
const LAMP_RED = 0xd21f1f;
const LAMP_AMBER = 0xe08a1c;
/** riders are a mid-range tone in the baked mesh; the shirt varies per instance */
const RIDER_SKIN = SKIN_RAMP[7];

/** One in-line wheel with a spoked-looking rim, flagged for roll (+ steer). */
function addBikeWheel(
  parts: VehicleParts,
  z: number,
  radius: number,
  width: number,
  front: boolean,
): void {
  const pivot = new THREE.Vector3(0, radius, z);
  const mode = front ? WHEEL.FRONT : WHEEL.REAR;
  parts.add(place(wheelCylinder(radius, width, 10), 0, radius, z), TYRE, ROLE.STATIC, mode, pivot);
  const rim = new THREE.CylinderGeometry(radius * 0.56, radius * 0.56, width * 1.05, 8, 1, false);
  rim.rotateZ(Math.PI / 2);
  parts.add(place(rim, 0, radius, z), RIM, ROLE.STATIC, mode, pivot);
  // two crossed spokes so the roll actually reads
  parts.add(
    place(box(width * 1.1, radius * 1.5, 0.03), 0, radius, z),
    RIM,
    ROLE.STATIC,
    mode,
    pivot,
  );
  parts.add(
    place(box(width * 1.1, 0.03, radius * 1.5), 0, radius, z),
    RIM,
    ROLE.STATIC,
    mode,
    pivot,
  );
}

/**
 * A seated rider. `lean` tilts the torso forward (0 = upright scooter posture,
 * 0.45 ≈ sportbike tuck).
 */
function addRider(
  parts: VehicleParts,
  seatY: number,
  seatZ: number,
  lean: number,
  helmet: number,
): void {
  const hipY = seatY + 0.12;
  const torsoLen = 0.44;
  const chestZ = seatZ - Math.sin(lean) * torsoLen * 0.5;
  const chestY = hipY + Math.cos(lean) * torsoLen * 0.55;

  // hips + torso (torso tinted with the instance trim colour = the shirt)
  parts.add(place(box(0.3, 0.2, 0.26), 0, hipY, seatZ), 0x3a4250, ROLE.STATIC);
  parts.add(
    place(box(0.34, torsoLen, 0.26), 0, chestY, chestZ, -lean),
    0xffffff,
    ROLE.TRIM,
  );
  // head + helmet
  const headY = chestY + Math.cos(lean) * 0.34;
  const headZ = chestZ - Math.sin(lean) * 0.34;
  parts.add(place(box(0.17, 0.16, 0.18), 0, headY - 0.02, headZ), RIDER_SKIN, ROLE.STATIC);
  const dome = new THREE.SphereGeometry(0.135, 8, 6);
  parts.add(place(dome, 0, headY + 0.03, headZ), helmet, ROLE.TRIM);
  parts.add(place(box(0.15, 0.07, 0.03), 0, headY + 0.01, headZ - 0.12), GLASS, ROLE.STATIC);

  // arms reaching for the bars
  for (const sx of [-1, 1]) {
    parts.add(
      place(box(0.09, 0.09, 0.46), sx * 0.17, chestY + 0.06, chestZ - 0.28, 0.34 - lean * 0.5),
      0xffffff,
      ROLE.TRIM,
    );
    parts.add(place(box(0.08, 0.08, 0.08), sx * 0.2, chestY - 0.06, chestZ - 0.5), RIDER_SKIN, ROLE.STATIC);
  }
  // thighs + shins down to the pegs
  for (const sx of [-1, 1]) {
    parts.add(place(box(0.12, 0.13, 0.42), sx * 0.13, hipY - 0.02, seatZ - 0.2), 0x2f3a4a, ROLE.STATIC);
    parts.add(place(box(0.11, 0.34, 0.12), sx * 0.15, hipY - 0.28, seatZ - 0.38), 0x2f3a4a, ROLE.STATIC);
    parts.add(place(box(0.1, 0.07, 0.2), sx * 0.15, hipY - 0.46, seatZ - 0.42), 0x1a1c20, ROLE.STATIC);
  }
}

/* ------------------------------------------------------------ the scooter */

/** A step-through Vespa-style scooter: leg shield, floorboard, small wheels. */
function buildScooter(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const r = 0.22;
  const frontZ = -0.63;
  const rearZ = 0.6;

  // floorboard and spine
  p.add(place(box(0.4, 0.07, 0.72), 0, 0.28, -0.02), DARK, ROLE.STATIC);
  p.add(place(box(0.22, 0.16, 0.9), 0, 0.36, 0.02), 0xffffff, ROLE.PAINT);
  // leg shield, raked back
  p.add(place(box(0.46, 0.62, 0.09), 0, 0.66, -0.5, -0.16), 0xffffff, ROLE.PAINT);
  p.add(place(box(0.3, 0.16, 0.05), 0, 0.92, -0.52, -0.16), 0xf0f0f0, ROLE.PAINT);
  // rear body / engine cowl
  p.add(place(box(0.46, 0.34, 0.72), 0, 0.55, 0.42), 0xffffff, ROLE.PAINT);
  p.add(place(box(0.5, 0.2, 0.42), 0, 0.44, 0.5), 0xe4e4e4, ROLE.PAINT);
  // seat
  p.add(place(box(0.28, 0.11, 0.6), 0, 0.78, 0.28), 0x1c1e22, ROLE.STATIC);
  // handlebars + column
  p.add(place(box(0.09, 0.5, 0.09), 0, 0.86, -0.6, -0.16), 0xbfc4c8, ROLE.STATIC);
  p.add(place(box(0.58, 0.05, 0.05), 0, 1.06, -0.64), DARK, ROLE.STATIC);
  p.add(place(box(0.1, 0.05, 0.05), -0.3, 1.06, -0.64), 0x2b2b2b, ROLE.STATIC);
  p.add(place(box(0.1, 0.05, 0.05), 0.3, 1.06, -0.64), 0x2b2b2b, ROLE.STATIC);
  // mirrors
  p.add(place(box(0.03, 0.16, 0.03), -0.26, 1.18, -0.64), CHROME, ROLE.STATIC);
  p.add(place(box(0.03, 0.16, 0.03), 0.26, 1.18, -0.64), CHROME, ROLE.STATIC);
  // forks + swingarm
  p.add(place(box(0.06, 0.44, 0.06), -0.08, 0.42, -0.63, -0.16), CHROME, ROLE.STATIC);
  p.add(place(box(0.06, 0.44, 0.06), 0.08, 0.42, -0.63, -0.16), CHROME, ROLE.STATIC);
  p.add(place(box(0.07, 0.07, 0.4), 0.16, 0.3, 0.44), DARK, ROLE.STATIC);
  // exhaust
  p.add(place(box(0.08, 0.08, 0.44), 0.19, 0.24, 0.6), CHROME, ROLE.STATIC);
  // luggage rack + top box (very Old San Juan — everyone carries something)
  p.add(place(box(0.3, 0.05, 0.26), 0, 0.86, 0.72), 0x2c3035, ROLE.STATIC);
  p.add(place(box(0.28, 0.22, 0.24), 0, 0.98, 0.72), 0xffffff, ROLE.TRIM);
  // lamps
  p.add(place(box(0.2, 0.15, 0.05), 0, 0.9, -0.58, -0.16), LAMP_WHITE, ROLE.HEAD);
  p.add(place(box(0.12, 0.1, 0.04), 0, 0.72, 0.79), LAMP_RED, ROLE.BRAKE);
  p.add(place(box(0.05, 0.05, 0.04), -0.24, 0.98, -0.6), LAMP_AMBER, ROLE.INDL);
  p.add(place(box(0.05, 0.05, 0.04), 0.24, 0.98, -0.6), LAMP_AMBER, ROLE.INDR);
  p.add(place(box(0.05, 0.05, 0.04), -0.17, 0.8, 0.78), LAMP_AMBER, ROLE.INDL);
  p.add(place(box(0.05, 0.05, 0.04), 0.17, 0.8, 0.78), LAMP_AMBER, ROLE.INDR);
  // plate
  p.add(place(box(0.16, 0.1, 0.02), 0, 0.58, 0.82), 0xe8e4d2, ROLE.STATIC);

  addBikeWheel(p, frontZ, r, 0.11, true);
  addBikeWheel(p, rearZ, r, 0.13, false);
  addRider(p, 0.84, 0.26, 0.14, 0xf2f2f2);
  return p.build('scooter');
}

/** A small commuter motorcycle: bigger wheels, exposed engine, tucked rider. */
function buildMotorcycle(): THREE.BufferGeometry {
  const p = new VehicleParts();
  const r = 0.3;
  const frontZ = -0.72;
  const rearZ = 0.68;

  // engine block + frame spine
  p.add(place(box(0.34, 0.32, 0.44), 0, 0.44, 0.06), 0x53595f, ROLE.STATIC);
  p.add(place(box(0.16, 0.14, 1.0), 0, 0.72, -0.06), 0xffffff, ROLE.PAINT);
  // tank
  p.add(place(box(0.34, 0.26, 0.56), 0, 0.83, -0.24), 0xffffff, ROLE.PAINT);
  // tail unit
  p.add(place(box(0.26, 0.2, 0.5), 0, 0.86, 0.46), 0xffffff, ROLE.PAINT);
  p.add(place(box(0.3, 0.1, 0.52), 0, 0.8, 0.26), 0x1c1e22, ROLE.STATIC);
  // front cowl + screen
  p.add(place(box(0.34, 0.3, 0.14), 0, 0.98, -0.68, -0.2), 0xffffff, ROLE.PAINT);
  p.add(place(box(0.26, 0.2, 0.04), 0, 1.2, -0.7, -0.5), GLASS, ROLE.STATIC);
  // forks and bars
  p.add(place(box(0.07, 0.62, 0.07), -0.1, 0.62, -0.71, -0.2), CHROME, ROLE.STATIC);
  p.add(place(box(0.07, 0.62, 0.07), 0.1, 0.62, -0.71, -0.2), CHROME, ROLE.STATIC);
  p.add(place(box(0.6, 0.05, 0.05), 0, 1.04, -0.6), DARK, ROLE.STATIC);
  p.add(place(box(0.03, 0.15, 0.03), -0.27, 1.15, -0.62), CHROME, ROLE.STATIC);
  p.add(place(box(0.03, 0.15, 0.03), 0.27, 1.15, -0.62), CHROME, ROLE.STATIC);
  // swingarm, exhaust, pegs
  p.add(place(box(0.07, 0.07, 0.5), -0.15, 0.36, 0.44), 0x50565c, ROLE.STATIC);
  p.add(place(box(0.07, 0.07, 0.5), 0.15, 0.36, 0.44), 0x50565c, ROLE.STATIC);
  p.add(place(box(0.1, 0.1, 0.66), 0.19, 0.32, 0.5), CHROME, ROLE.STATIC);
  // lamps
  p.add(place(box(0.22, 0.14, 0.05), 0, 0.98, -0.74, -0.2), LAMP_WHITE, ROLE.HEAD);
  p.add(place(box(0.12, 0.09, 0.04), 0, 0.88, 0.71), LAMP_RED, ROLE.BRAKE);
  p.add(place(box(0.05, 0.05, 0.04), -0.24, 1.0, -0.64), LAMP_AMBER, ROLE.INDL);
  p.add(place(box(0.05, 0.05, 0.04), 0.24, 1.0, -0.64), LAMP_AMBER, ROLE.INDR);
  p.add(place(box(0.05, 0.05, 0.04), -0.16, 0.9, 0.7), LAMP_AMBER, ROLE.INDL);
  p.add(place(box(0.05, 0.05, 0.04), 0.16, 0.9, 0.7), LAMP_AMBER, ROLE.INDR);
  p.add(place(box(0.16, 0.1, 0.02), 0, 0.66, 0.76), 0xe8e4d2, ROLE.STATIC);

  addBikeWheel(p, frontZ, r, 0.12, true);
  addBikeWheel(p, rearZ, r, 0.15, false);
  addRider(p, 0.92, 0.16, 0.4, 0x1c1e22);
  return p.build('motorcycle');
}

/* ------------------------------------------------------------ type table */

export const SCOOTER_TYPES: readonly VehicleTypeDef[] = [
  {
    id: 'scooter',
    label: 'scooter',
    length: 1.9,
    width: 0.72,
    height: 1.72,
    wheelRadius: 0.22,
    weight: SCOOTER.vespaShare * 100,
    speedScale: 1.0,
    paint: SCOOTER_PAINT,
    paintWeights: null,
    trim: SCOOTER_PAINT,
    emergency: false,
    build: buildScooter,
  },
  {
    id: 'motorcycle',
    label: 'motorcycle',
    length: 2.1,
    width: 0.7,
    height: 1.62,
    wheelRadius: 0.3,
    weight: (1 - SCOOTER.vespaShare) * 100,
    speedScale: 1.14,
    paint: SCOOTER_PAINT,
    paintWeights: null,
    trim: SCOOTER_PAINT,
    emergency: false,
    build: buildMotorcycle,
  },
];

/* ==================================================================== kit */

/** Instanced meshes for the two-wheeler fleet. Shares the traffic material. */
export class ScooterKit {
  readonly group = new THREE.Group();
  readonly types = SCOOTER_TYPES;
  readonly fleets: InstancedFleet[] = [];

  constructor(
    capacity: number,
    material: THREE.Material,
    depthMaterial: THREE.Material | null,
    castShadow: boolean,
  ) {
    this.group.name = 'loco/traffic/scooters';
    for (const def of this.types) {
      const fleet = new InstancedFleet(
        def.build(),
        material,
        castShadow ? depthMaterial : null,
        capacity,
        def.id,
        castShadow,
      );
      this.fleets.push(fleet);
      this.group.add(fleet.mesh);
    }
  }

  pickType(rng: RNG): number {
    return rng.next() < SCOOTER.vespaShare ? 0 : 1;
  }

  pickPaint(rng: RNG): number {
    return rng.pick(SCOOTER_PAINT);
  }

  /** Rider shirt / helmet colour — deliberately not the same as the bodywork. */
  pickTrim(rng: RNG): number {
    return rng.pick(SCOOTER_PAINT);
  }

  beginFrame(): void {
    for (let i = 0; i < this.fleets.length; i++) this.fleets[i].begin();
  }

  endFrame(): void {
    for (let i = 0; i < this.fleets.length; i++) this.fleets[i].end();
  }

  get liveTriangles(): number {
    let t = 0;
    for (const f of this.fleets) t += f.triangles * f.count;
    return t;
  }

  get drawCalls(): number {
    let n = 0;
    for (const f of this.fleets) if (f.count > 0) n++;
    return n;
  }

  dispose(): void {
    for (const f of this.fleets) f.dispose();
    this.fleets.length = 0;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ============================================================== behaviour */

/**
 * Which road classes a two-wheeler may use. Cars are confined to
 * `!edge.noTraffic`; scooters additionally take the **callejones**, which is
 * exactly what they do in the real city. Stairs, ramps and rooftops stay
 * off-limits to everything.
 */
export function scooterEdgeAllowed(edge: RoadEdge): boolean {
  if (!edge.noTraffic) return true;
  return SCOOTER.useAlleys && edge.kind === 'alley';
}

/**
 * Lane filtering. When the queue ahead is slow and close, the rider drifts
 * toward the centreline and slips past; otherwise the offset bleeds away.
 *
 * Returns the extra gap credit the rider may claim once it has committed to
 * filtering — a filtering scooter effectively ignores the leader it is passing.
 */
export function updateScooterSplit(
  agent: RoadAgent,
  leaderGap: number,
  leaderSpeed: number,
  dt: number,
): boolean {
  const wants =
    leaderGap < SCOOTER.splitGap &&
    leaderSpeed < SCOOTER.splitLeaderSpeed &&
    agent.speed < SCOOTER.splitLeaderSpeed + 4;
  const target = wants ? SCOOTER.splitOffset : 0;
  const rate = SCOOTER.splitRate * dt;
  if (agent.split < target) agent.split = Math.min(target, agent.split + rate);
  else agent.split = Math.max(target, agent.split - rate);
  return agent.split > SCOOTER.splitOffset * 0.62;
}

/** Bank into the corner. This is the single thing that sells a two-wheeler. */
export function updateScooterLean(agent: RoadAgent, dt: number): void {
  const target = clamp(
    -agent.yawRate * agent.speed * SCOOTER.leanGain,
    -SCOOTER.maxLean,
    SCOOTER.maxLean,
  );
  agent.roll = damp(agent.roll, target, SCOOTER.leanRate, dt);
  agent.pitch = damp(agent.pitch, clamp(-agent.accel * 0.02, -0.1, 0.1), 7, dt);
}

/** Small vertical jiggle over the adoquín — bikes are unsprung and it shows. */
export function scooterBob(agent: RoadAgent, elapsed: number): number {
  return Math.sin(elapsed * 13.5 + agent.index * 1.7) * SCOOTER.bob * clamp(agent.speed / 8, 0, 1);
}
