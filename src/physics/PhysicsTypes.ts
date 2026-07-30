import type * as THREE from 'three';

/**
 * Engine-agnostic physics surface. Everything in the game talks to physics
 * through this interface, never to Rapier directly — that keeps the vehicle,
 * traffic and prop code testable and swappable.
 */

export type BodyKind = 'dynamic' | 'kinematic' | 'static';

export type ColliderShape =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'cylinder'; radius: number; halfHeight: number }
  | { type: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
  | { type: 'convex'; points: Float32Array }
  | { type: 'heightfield'; rows: number; cols: number; heights: Float32Array; scale: THREE.Vector3 };

/** Broad-phase filter groups. Combine with bitwise OR. */
export const GROUP = {
  WORLD: 1 << 0,
  VEHICLE: 1 << 1,
  TRAFFIC: 1 << 2,
  PROP: 1 << 3,
  PED: 1 << 4,
  TRIGGER: 1 << 5,
  DEBRIS: 1 << 6,
} as const;

export interface BodyDesc {
  kind: BodyKind;
  shape: ColliderShape;
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** which group this body belongs to */
  group: number;
  /** bitmask of groups this body collides with */
  mask: number;
  /** sensor bodies report overlaps but generate no contact response */
  sensor?: boolean;
  /** enable continuous collision detection — for fast bodies like the Jeep */
  ccd?: boolean;
  /** centre-of-mass offset from the body origin, metres */
  centerOfMass?: THREE.Vector3;
  /** opaque tag surfaced in collision callbacks */
  userData?: unknown;
}

export interface BodyHandle {
  readonly id: number;
  readonly kind: BodyKind;
  userData: unknown;

  getPosition(out?: THREE.Vector3): THREE.Vector3;
  getQuaternion(out?: THREE.Quaternion): THREE.Quaternion;
  getLinearVelocity(out?: THREE.Vector3): THREE.Vector3;
  getAngularVelocity(out?: THREE.Vector3): THREE.Vector3;

  setPosition(p: THREE.Vector3): void;
  setQuaternion(q: THREE.Quaternion): void;
  setLinearVelocity(v: THREE.Vector3): void;
  setAngularVelocity(v: THREE.Vector3): void;

  /** instantaneous impulse at the centre of mass (or at `at`, world space) */
  applyImpulse(impulse: THREE.Vector3, at?: THREE.Vector3): void;
  /** continuous force for this step */
  applyForce(force: THREE.Vector3, at?: THREE.Vector3): void;
  applyTorqueImpulse(torque: THREE.Vector3): void;

  setEnabled(on: boolean): void;
  wake(): void;
}

export interface RayHit {
  /** distance along the ray */
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  body: BodyHandle | null;
  userData: unknown;
}

export interface ContactEvent {
  a: BodyHandle;
  b: BodyHandle;
  /** total normal impulse magnitude of the contact */
  impulse: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface PhysicsWorldAPI {
  /** advance the simulation one fixed step */
  step(dt: number): void;

  createBody(desc: BodyDesc): BodyHandle;
  removeBody(body: BodyHandle): void;

  /**
   * Cast a ray. `mask` filters which groups can be hit.
   * `exclude` skips a specific body (the vehicle casting its own suspension).
   */
  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDistance: number,
    mask: number,
    exclude?: BodyHandle | null,
  ): RayHit | null;

  /** sphere sweep, used for camera collision and chunky proximity checks */
  spherecast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    maxDistance: number,
    mask: number,
    exclude?: BodyHandle | null,
  ): RayHit | null;

  /** overlap query — returns bodies whose colliders intersect the sphere */
  overlapSphere(center: THREE.Vector3, radius: number, mask: number): BodyHandle[];

  /** subscribe to contacts above `minImpulse`; returns an unsubscribe fn */
  onContact(fn: (e: ContactEvent) => void, minImpulse?: number): () => void;

  /** sensor overlap start/end */
  onSensor(fn: (sensor: BodyHandle, other: BodyHandle, entered: boolean) => void): () => void;

  readonly bodyCount: number;
  dispose(): void;
}
