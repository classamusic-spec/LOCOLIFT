import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type {
  BodyDesc,
  BodyHandle,
  BodyKind,
  ColliderShape,
  ContactEvent,
  PhysicsWorldAPI,
  RayHit,
} from './PhysicsTypes';

/**
 * Rapier is loaded exactly once per page. `RAPIER.init()` compiles the WASM
 * module; calling it twice is wasteful and, on some builds, throws.
 */
let initPromise: Promise<void> | null = null;
function ensureRapier(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

/**
 * Rapier packs interaction groups into one u32: the high 16 bits are the
 * body's *membership* (what it is) and the low 16 bits are its *filter*
 * (what it is willing to touch). A pair interacts only if each side's
 * membership intersects the other's filter — getting this backwards is the
 * classic Rapier bug, so it lives in one place.
 */
const packGroups = (membership: number, filter: number): number =>
  ((membership & 0xffff) << 16) | (filter & 0xffff);

/** A query wants to hit anything in `mask`, and belongs to nothing in particular. */
const queryGroups = (mask: number): number => packGroups(0xffff, mask);

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

class RapierBody implements BodyHandle {
  readonly id: number;
  readonly kind: BodyKind;
  userData: unknown;

  constructor(
    id: number,
    kind: BodyKind,
    readonly rb: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
    userData: unknown,
  ) {
    this.id = id;
    this.kind = kind;
    this.userData = userData;
  }

  getPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.rb.translation();
    return out.set(t.x, t.y, t.z);
  }

  getQuaternion(out = new THREE.Quaternion()): THREE.Quaternion {
    const r = this.rb.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  getLinearVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    const v = this.rb.linvel();
    return out.set(v.x, v.y, v.z);
  }

  getAngularVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    const v = this.rb.angvel();
    return out.set(v.x, v.y, v.z);
  }

  setPosition(p: THREE.Vector3): void {
    this.rb.setTranslation(p, true);
  }

  setQuaternion(q: THREE.Quaternion): void {
    this.rb.setRotation(q, true);
  }

  setLinearVelocity(v: THREE.Vector3): void {
    this.rb.setLinvel(v, true);
  }

  setAngularVelocity(v: THREE.Vector3): void {
    this.rb.setAngvel(v, true);
  }

  applyImpulse(impulse: THREE.Vector3, at?: THREE.Vector3): void {
    if (at) this.rb.applyImpulseAtPoint(impulse, at, true);
    else this.rb.applyImpulse(impulse, true);
  }

  applyForce(force: THREE.Vector3, at?: THREE.Vector3): void {
    if (at) this.rb.addForceAtPoint(force, at, true);
    else this.rb.addForce(force, true);
  }

  applyTorqueImpulse(torque: THREE.Vector3): void {
    this.rb.applyTorqueImpulse(torque, true);
  }

  setEnabled(on: boolean): void {
    this.rb.setEnabled(on);
  }

  wake(): void {
    this.rb.wakeUp();
  }
}

export class PhysicsWorld implements PhysicsWorldAPI {
  private world: RAPIER.World;
  private events: RAPIER.EventQueue;

  /** collider handle -> our wrapper, so callbacks can resolve back to gameplay objects */
  private byCollider = new Map<number, RapierBody>();
  private bodies = new Set<RapierBody>();
  private nextId = 1;
  private disposed = false;

  private contactListeners: Array<{ fn: (e: ContactEvent) => void; min: number }> = [];
  private sensorListeners: Array<
    (sensor: BodyHandle, other: BodyHandle, entered: boolean) => void
  > = [];

  /** reused so contact dispatch allocates nothing per event */
  private contactScratch: ContactEvent = {
    a: null as unknown as BodyHandle,
    b: null as unknown as BodyHandle,
    impulse: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
  };

  private lastDt = 1 / 120;

  private constructor(gravity: number) {
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.events = new RAPIER.EventQueue(true);
  }

  static async create(gravity: number): Promise<PhysicsWorld> {
    await ensureRapier();
    return new PhysicsWorld(gravity);
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  /** Exposed for the debug renderer only. */
  get raw(): RAPIER.World {
    return this.world;
  }

  step(dt: number): void {
    if (this.disposed) return;
    this.lastDt = dt;
    this.world.timestep = dt;
    this.world.step(this.events);
    this.drainEvents();
  }

  createBody(desc: BodyDesc): BodyHandle {
    let rbDesc: RAPIER.RigidBodyDesc;
    switch (desc.kind) {
      case 'dynamic':
        rbDesc = RAPIER.RigidBodyDesc.dynamic();
        break;
      case 'kinematic':
        rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
        break;
      case 'static':
        rbDesc = RAPIER.RigidBodyDesc.fixed();
        break;
    }

    rbDesc.setTranslation(desc.position.x, desc.position.y, desc.position.z);
    if (desc.quaternion) rbDesc.setRotation(desc.quaternion);
    if (desc.linearDamping !== undefined) rbDesc.setLinearDamping(desc.linearDamping);
    if (desc.angularDamping !== undefined) rbDesc.setAngularDamping(desc.angularDamping);
    if (desc.ccd) rbDesc.setCcdEnabled(true);

    const rb = this.world.createRigidBody(rbDesc);

    const colDesc = makeColliderDesc(desc.shape);
    if (desc.friction !== undefined) colDesc.setFriction(desc.friction);
    if (desc.restitution !== undefined) colDesc.setRestitution(desc.restitution);
    if (desc.sensor) colDesc.setSensor(true);
    colDesc.setCollisionGroups(packGroups(desc.group, desc.mask));

    // Sensors need collision events; solid bodies need force events so we can
    // scale crash feedback by how hard the hit actually was.
    colDesc.setActiveEvents(
      desc.sensor
        ? RAPIER.ActiveEvents.COLLISION_EVENTS
        : RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS,
    );
    // Below this the event is noise (resting contacts, kerb scrapes).
    colDesc.setContactForceEventThreshold(CONTACT_FORCE_THRESHOLD);

    if (desc.mass !== undefined && desc.kind === 'dynamic') {
      colDesc.setMass(desc.mass);
    }

    const collider = this.world.createCollider(colDesc, rb);

    // A lowered centre of mass is what stops an arcade car rolling over; apply
    // it after the collider so it overrides the shape-derived properties.
    if (desc.centerOfMass && desc.kind === 'dynamic') {
      const m = desc.mass ?? rb.mass();
      // Derive a sane principal inertia from the shape's bounding solid rather
      // than inventing one, then re-anchor the whole tensor at the offset COM.
      const pai = principalInertiaFromShape(desc.shape, m);
      rb.setAdditionalMassProperties(m, desc.centerOfMass, pai, IDENTITY_ROT, true);
    }

    const body = new RapierBody(this.nextId++, desc.kind, rb, collider, desc.userData);
    this.bodies.add(body);
    this.byCollider.set(collider.handle, body);
    return body;
  }

  removeBody(body: BodyHandle): void {
    const b = body as RapierBody;
    if (!this.bodies.has(b)) return;
    this.byCollider.delete(b.collider.handle);
    this.bodies.delete(b);
    // Removing the rigid body removes its colliders too.
    this.world.removeRigidBody(b.rb);
  }

  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDistance: number,
    mask: number,
    exclude?: BodyHandle | null,
  ): RayHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const ex = exclude ? (exclude as RapierBody).rb : undefined;
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      queryGroups(mask),
      undefined,
      ex,
    );
    if (!hit) return null;

    const body = this.byCollider.get(hit.collider.handle) ?? null;
    const distance = hit.timeOfImpact;
    return {
      distance,
      point: new THREE.Vector3(
        origin.x + dir.x * distance,
        origin.y + dir.y * distance,
        origin.z + dir.z * distance,
      ),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      body,
      userData: body?.userData ?? null,
    };
  }

  spherecast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    maxDistance: number,
    mask: number,
    exclude?: BodyHandle | null,
  ): RayHit | null {
    const shape = new RAPIER.Ball(radius);
    const ex = exclude ? (exclude as RapierBody).rb : undefined;
    // `dir` is unit length, so time-of-impact reads directly as metres.
    const hit = this.world.castShape(
      origin,
      IDENTITY_ROT,
      dir,
      shape,
      0,
      maxDistance,
      true,
      undefined,
      queryGroups(mask),
      undefined,
      ex,
    );
    if (!hit) return null;

    const body = this.byCollider.get(hit.collider.handle) ?? null;
    const distance = hit.time_of_impact;
    const n = _v.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
    // A degenerate normal means we started already touching; push straight back.
    if (n.lengthSq() < 1e-8) n.copy(dir).negate();
    else n.normalize();

    return {
      distance,
      point: new THREE.Vector3(
        origin.x + dir.x * distance,
        origin.y + dir.y * distance,
        origin.z + dir.z * distance,
      ),
      normal: n.clone(),
      body,
      userData: body?.userData ?? null,
    };
  }

  overlapSphere(center: THREE.Vector3, radius: number, mask: number): BodyHandle[] {
    const out: BodyHandle[] = [];
    const shape = new RAPIER.Ball(radius);
    this.world.intersectionsWithShape(
      center,
      IDENTITY_ROT,
      shape,
      (collider) => {
        const b = this.byCollider.get(collider.handle);
        if (b) out.push(b);
        return true; // keep collecting
      },
      undefined,
      queryGroups(mask),
    );
    return out;
  }

  onContact(fn: (e: ContactEvent) => void, minImpulse = 0): () => void {
    const entry = { fn, min: minImpulse };
    this.contactListeners.push(entry);
    return () => {
      const i = this.contactListeners.indexOf(entry);
      if (i >= 0) this.contactListeners.splice(i, 1);
    };
  }

  onSensor(fn: (sensor: BodyHandle, other: BodyHandle, entered: boolean) => void): () => void {
    this.sensorListeners.push(fn);
    return () => {
      const i = this.sensorListeners.indexOf(fn);
      if (i >= 0) this.sensorListeners.splice(i, 1);
    };
  }

  private drainEvents(): void {
    if (this.sensorListeners.length > 0) {
      this.events.drainCollisionEvents((h1, h2, started) => {
        const a = this.byCollider.get(h1);
        const b = this.byCollider.get(h2);
        if (!a || !b) return;
        // Report with the sensor first, whichever side it is.
        const aIsSensor = a.collider.isSensor();
        const bIsSensor = b.collider.isSensor();
        if (!aIsSensor && !bIsSensor) return;
        const sensor = aIsSensor ? a : b;
        const other = aIsSensor ? b : a;
        for (const fn of this.sensorListeners) {
          try {
            fn(sensor, other, started);
          } catch (err) {
            console.error('[Physics] sensor listener threw:', err);
          }
        }
      });
    } else {
      this.events.drainCollisionEvents(() => {
        /* still must drain, or the queue grows unbounded */
      });
    }

    if (this.contactListeners.length === 0) {
      this.events.drainContactForceEvents(() => {});
      return;
    }

    this.events.drainContactForceEvents((e) => {
      const a = this.byCollider.get(e.collider1());
      const b = this.byCollider.get(e.collider2());
      if (!a || !b) return;

      // Rapier reports accumulated *force* over the step; converting to an
      // impulse (N·s) gives a value that stays comparable across timesteps.
      const impulse = e.totalForceMagnitude() * this.lastDt;

      const dir = e.maxForceDirection();
      const ev = this.contactScratch;
      ev.a = a;
      ev.b = b;
      ev.impulse = impulse;
      ev.normal.set(dir.x, dir.y, dir.z);
      if (ev.normal.lengthSq() > 1e-8) ev.normal.normalize();

      // Prefer a real solver contact point so sparks land on the actual
      // impact; fall back to the midpoint between the two bodies.
      let gotPoint = false;
      this.world.contactPair(a.collider, b.collider, (manifold) => {
        if (gotPoint) return;
        if (manifold.numSolverContacts() > 0) {
          const p = manifold.solverContactPoint(0);
          ev.point.set(p.x, p.y, p.z);
          gotPoint = true;
        }
      });
      if (!gotPoint) {
        a.getPosition(_v);
        b.getPosition(ev.point);
        ev.point.add(_v).multiplyScalar(0.5);
      }

      for (const l of this.contactListeners) {
        if (impulse < l.min) continue;
        try {
          l.fn(ev);
        } catch (err) {
          console.error('[Physics] contact listener threw:', err);
        }
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contactListeners = [];
    this.sensorListeners = [];
    this.byCollider.clear();
    this.bodies.clear();
    this.events.free();
    this.world.free();
  }
}

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };

/** Contacts weaker than this never reach gameplay — resting noise, not crashes. */
const CONTACT_FORCE_THRESHOLD = 40;

function makeColliderDesc(shape: ColliderShape): RAPIER.ColliderDesc {
  switch (shape.type) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
    case 'sphere':
      return RAPIER.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'cylinder':
      return RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    case 'trimesh':
      return RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices);
    case 'convex': {
      const d = RAPIER.ColliderDesc.convexHull(shape.points);
      if (!d) throw new Error('[Physics] convex hull generation failed — degenerate point set');
      return d;
    }
    case 'heightfield':
      return RAPIER.ColliderDesc.heightfield(shape.rows, shape.cols, shape.heights, shape.scale);
  }
}

/**
 * Principal moments of inertia for the shape's bounding solid. Used only when
 * a caller overrides the centre of mass, where Rapier needs the full tensor.
 */
function principalInertiaFromShape(
  shape: ColliderShape,
  mass: number,
): { x: number; y: number; z: number } {
  let hx = 1;
  let hy = 1;
  let hz = 1;
  switch (shape.type) {
    case 'box':
      hx = shape.hx;
      hy = shape.hy;
      hz = shape.hz;
      break;
    case 'sphere':
      hx = hy = hz = shape.radius;
      break;
    case 'capsule':
    case 'cylinder':
      hx = hz = shape.radius;
      hy = shape.halfHeight + (shape.type === 'capsule' ? shape.radius : 0);
      break;
    default:
      // Trimesh/convex/heightfield never get a COM override in this game.
      hx = hy = hz = 1;
      break;
  }
  const k = mass / 3;
  return {
    x: k * (hy * hy + hz * hz),
    y: k * (hx * hx + hz * hz),
    z: k * (hx * hx + hy * hy),
  };
}
