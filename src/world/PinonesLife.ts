/**
 * Loco Lift — the people of Piñones.
 *
 * A chinchorro strip with no one on it is a film set. This layer is what turns
 * six clusters of painted timber into a place somebody drove out to on a
 * Sunday: queues at the serving counters, families round the plastic tables,
 * a knot of dancers by the speakers, kids running the sand, couples walking
 * the shoulder with a beer, a piragüero working the parking apron.
 *
 * ## Reuse, not reimplementation
 *
 * Every figure here is `src/traffic/PedestrianModel`'s — the same eleven-bone
 * rig, the same GPU-skinned instanced fleets, the same **continuous melanin
 * ramp** ART_REFERENCE §7.2 requires. This file imports {@link PedestrianKit},
 * {@link PedLook} and {@link CLIP} read-only and contributes nothing but
 * *placement and behaviour*. There is one crowd implementation in this project
 * and it is not this one.
 *
 * The kit turns out to be reusable from a world layer with no changes at all:
 * it is a plain class over a geometry, a bone texture and two `PedFleet`
 * instanced meshes, with no dependency on the traffic system, the road graph
 * or the city layout. The whole contract is `beginFrame()` / `push()` /
 * `endFrame()` once a frame.
 *
 * ## Where people stand
 *
 * Nothing here invents a position. {@link Pinones} already knows where it put
 * every chair, bench, barrel table, serving counter and speaker, and hands
 * those over as {@link CrowdAnchor}s while it builds the props. So a sitter is
 * always on a real chair, a queue always faces a real counter, and a dancer is
 * always within earshot of a real speaker — the crowd cannot drift out of
 * register with the set dressing because it is derived from it.
 *
 * ## Cost
 *
 * Three draw calls: the near fleet, the far fleet and the piragua carts.
 * Everyone beyond {@link PinonesLifeOptions.cullDistance} is skipped before it
 * reaches a buffer, and everyone past the LOD split writes into the low fleet,
 * whose figure is a fraction of the triangles.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/types';
import { clamp01 } from '../core/MathUtils';
import type { RNG } from '../core/RNG';
import {
  CLIP,
  CLIP_RATE,
  PedLook,
  PedestrianKit,
  type PedRole,
} from '../traffic/PedestrianModel';

/* ========================================================================== *
 *  what the strip tells us about itself
 * ========================================================================== */

/** The bit of Piñones' geometry the crowd needs in order to stand on it. */
export interface PinonesSite {
  /** Ground height of the ribbon at a world point. */
  height(x: number, z: number): number;
  /**
   * World position at (arc length along the road, lateral offset). Writes
   * `out` and returns the **heading of the road** there, so a stroller can be
   * turned to face the way they are walking.
   */
  at(s: number, v: number, out: THREE.Vector3): number;
  /** Total arc length of the ribbon, metres. */
  length: number;
}

/** Where one person can plausibly be, and what they would be doing there. */
export type AnchorKind =
  /** on a plastic chair at a table */
  | 'seat'
  /** at a picnic bench */
  | 'bench'
  /** in the queue at a serving counter, facing it */
  | 'counter'
  /** standing at a barrel table with a drink */
  | 'stand'
  /** within earshot of a speaker */
  | 'dance'
  /** out on the sand, facing the water */
  | 'shore';

export interface CrowdAnchor {
  x: number;
  y: number;
  z: number;
  /** the way the person should face */
  yaw: number;
  kind: AnchorKind;
}

export interface PinonesLifeOptions {
  /** multiplier on the crowd size */
  density?: number;
  /** metres past which nobody is drawn at all */
  cullDistance?: number;
  /** metres past which a person drops to the low-detail figure */
  lodDistance?: number;
  /** cap, so a dense anchor list can never blow the budget */
  maxPeople?: number;
}

/* ========================================================================== *
 *  one person
 * ========================================================================== */

interface Person {
  x: number;
  y: number;
  z: number;
  yaw: number;
  clip: number;
  /** normalised animation phase */
  phase: number;
  /** cycles per second */
  rate: number;
  look: PedLook;
  /** metres/second along the road; 0 for everybody who is standing still */
  speed: number;
  /** arc length, strollers only */
  s: number;
  /** lateral offset, strollers only */
  v: number;
  /** +1 east, −1 west */
  dir: number;
  /** slow yaw drift, so a standing crowd is never a rank of statues */
  sway: number;
}

/** Roles that belong on a beach, weighted for a Sunday afternoon. */
const SEATED_ROLES: readonly PedRole[] = ['sitter', 'sitter', 'elder', 'tourist'];
const STANDING_ROLES: readonly PedRole[] = ['talker', 'talker', 'shopper', 'tourist', 'elder'];

/* ========================================================================== *
 *  the layer
 * ========================================================================== */

export class PinonesLife {
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private options: Required<PinonesLifeOptions>;
  private kit: PedestrianKit | null = null;
  private people: Person[] = [];
  private site: PinonesSite | null = null;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly rows = new Float32Array(3);
  private readonly probe = new THREE.Vector3();

  private _stats = { people: 0, carts: 0, drawn: 0 };

  constructor(quality: QualityTier, options: PinonesLifeOptions = {}) {
    this.quality = quality;
    this.options = {
      density: options.density ?? 1,
      cullDistance: options.cullDistance ?? 260,
      lodDistance: options.lodDistance ?? 62,
      maxPeople: options.maxPeople ?? 132,
    };
    this.group.name = 'pinones/life';
  }

  /* --------------------------------------------------------------- build */

  build(site: PinonesSite, anchors: readonly CrowdAnchor[], rng: RNG): void {
    this.site = site;
    const tier = this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.74 : 1;
    const want = Math.min(
      this.options.maxPeople,
      Math.round(anchors.length * 0.82 * this.options.density * tier),
    );
    if (want <= 0) return;

    /* --- pick anchors without clumping: shuffle, then take the first N --- */
    const pool = anchors.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }

    const strollers = Math.round(Math.min(18, want * 0.16));
    const seated = Math.max(0, want - strollers);

    for (let i = 0; i < seated && i < pool.length; i++) {
      this.people.push(this.personAt(pool[i], rng));
    }
    for (let i = 0; i < strollers; i++) this.people.push(this.stroller(site, rng));

    this._stats.people = this.people.length;

    /* --- the fleets ---------------------------------------------------- */
    const carts = this.quality === 'low' ? 2 : 4;
    const kit = new PedestrianKit(
      Math.max(1, this.people.length),
      carts,
      this.quality !== 'low',
    );
    this.kit = kit;
    this.group.add(kit.group);

    /* --- piragua carts on the apron, one every couple of clusters ------- */
    const cartSpots: CrowdAnchor[] = anchors.filter((a) => a.kind === 'counter');
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    let placed = 0;
    for (let i = 0; i < carts && cartSpots.length > 0; i++) {
      const a = cartSpots[Math.floor(((i + 0.5) / carts) * cartSpots.length)];
      if (!a) continue;
      // pushed a few metres clear of the counter so it does not intersect the
      // queue it is standing beside
      const off = 3.1 + rng.range(0, 1.4);
      const px = a.x + Math.sin(a.yaw + 1.57) * off;
      const pz = a.z + Math.cos(a.yaw + 1.57) * off;
      p.set(px, site.height(px, pz), pz);
      q.setFromAxisAngle(this.up, a.yaw + rng.range(-0.5, 0.5));
      m.compose(p, q, one);
      kit.carts.setMatrixAt(placed++, m);
    }
    kit.carts.count = placed;
    kit.carts.instanceMatrix.needsUpdate = true;
    this._stats.carts = placed;
  }

  /** Turn one anchor into a person with a role, a wardrobe and a clip. */
  private personAt(a: CrowdAnchor, rng: RNG): Person {
    let role: PedRole;
    let clip: number;

    switch (a.kind) {
      case 'seat':
      case 'bench':
        role = rng.next() < 0.17 ? 'kid' : SEATED_ROLES[rng.int(0, SEATED_ROLES.length - 1)];
        clip = CLIP.SIT;
        break;
      case 'counter':
        // a queue is mostly people waiting and one person being served
        role = rng.next() < 0.2 ? 'kid' : rng.next() < 0.35 ? 'shopper' : 'walker';
        clip = rng.next() < 0.3 ? CLIP.TALK : CLIP.IDLE;
        break;
      case 'dance':
        role = rng.next() < 0.24 ? 'clapper' : 'dancer';
        clip = role === 'clapper' ? CLIP.CLAP : CLIP.DANCE;
        break;
      case 'shore':
        role = rng.next() < 0.3 ? 'kid' : 'tourist';
        clip = role === 'kid' ? CLIP.PLAY : CLIP.IDLE;
        break;
      default:
        role = STANDING_ROLES[rng.int(0, STANDING_ROLES.length - 1)];
        clip = rng.next() < 0.55 ? CLIP.TALK : CLIP.IDLE;
        break;
    }

    const look = new PedLook();
    look.randomise(rng, role);
    // a beach crowd carries things: a drink, a plate, a bag of alcapurrias
    if (a.kind !== 'seat' && a.kind !== 'bench' && rng.next() < 0.42) look.heldProp = 1;
    if (a.kind === 'dance' && rng.next() < 0.3) look.heldProp = 2;

    return {
      x: a.x,
      y: a.y,
      z: a.z,
      yaw: a.yaw + rng.range(-0.35, 0.35),
      clip,
      phase: rng.next(),
      // ±12 % on the clip rate, so no two neighbours ever lock step
      rate: CLIP_RATE[clip] * rng.range(0.88, 1.12),
      look,
      speed: 0,
      s: 0,
      v: 0,
      dir: 1,
      sway: rng.range(0.2, 0.7) * (rng.bool() ? 1 : -1),
    };
  }

  /** Somebody walking the shoulder, which is where the motion events come from. */
  private stroller(site: PinonesSite, rng: RNG): Person {
    const role: PedRole = rng.next() < 0.18 ? 'kid' : rng.next() < 0.2 ? 'elder' : 'walker';
    const look = new PedLook();
    look.randomise(rng, role);
    if (rng.next() < 0.5) look.heldProp = 1;
    const dir = rng.bool() ? 1 : -1;
    const s = rng.range(30, Math.max(40, site.length - 30));
    // they keep to the sand and the apron, never the carriageway
    const v = rng.bool() ? rng.range(7.6, 12) : -rng.range(7.6, 11.5);
    const p = new THREE.Vector3();
    const head = site.at(s, v, p);
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: head + (dir > 0 ? 0 : Math.PI),
      clip: CLIP.WALK,
      phase: rng.next(),
      rate: CLIP_RATE[CLIP.WALK] * rng.range(0.9, 1.1),
      look,
      speed: rng.range(0.85, 1.5) * (role === 'kid' ? 1.25 : 1),
      s,
      v,
      dir,
      sway: 0,
    };
  }

  /* ------------------------------------------------------------- runtime */

  update(cameraPos: THREE.Vector3, dt: number, elapsed: number): void {
    const kit = this.kit;
    const site = this.site;
    if (!kit || !site || this.people.length === 0) return;

    const cull = this.options.cullDistance;
    const cull2 = cull * cull;
    const lod2 = this.options.lodDistance * this.options.lodDistance;

    kit.beginFrame();
    let drawn = 0;

    for (const p of this.people) {
      p.phase = (p.phase + dt * p.rate) % 1;

      if (p.speed > 0) {
        p.s += p.speed * p.dir * dt;
        // turn round at the ends rather than teleporting: a person who pops
        // from one end of the strip to the other is worse than no person
        if (p.s > site.length - 22) {
          p.s = site.length - 22;
          p.dir = -1;
        } else if (p.s < 18) {
          p.s = 18;
          p.dir = 1;
        }
        const head = site.at(p.s, p.v, this.probe);
        p.x = this.probe.x;
        p.y = this.probe.y;
        p.z = this.probe.z;
        p.yaw = head + (p.dir > 0 ? 0 : Math.PI);
      }

      const dx = p.x - cameraPos.x;
      const dz = p.z - cameraPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > cull2) continue;

      // a standing crowd shifts its weight; a seated one does not pivot
      const yaw =
        p.sway !== 0 ? p.yaw + Math.sin(elapsed * 0.31 + p.phase * 6.283) * 0.11 * p.sway : p.yaw;

      this.pos.set(p.x, p.y, p.z);
      this.quat.setFromAxisAngle(this.up, yaw);
      this.scl.setScalar(p.look.scale);
      this.matrix.compose(this.pos, this.quat, this.scl);
      kit.rows(p.clip, p.phase, this.rows);

      const fleet = d2 < lod2 ? kit.high : kit.low;
      if (fleet.push(this.matrix, this.rows[0], this.rows[1], this.rows[2], p.look)) drawn++;
    }

    kit.endFrame();
    this._stats.drawn = drawn;
  }

  /**
   * Hide the whole crowd. Driven by `Pinones`, which already culls its props by
   * distance — there is no reason to pay for a hundred instance writes when the
   * shacks they are standing at are not being drawn.
   */
  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  onQualityChange(tier: QualityTier): void {
    this.quality = tier;
    this.kit?.setCastShadow(tier !== 'low');
  }

  get drawCalls(): number {
    return this.kit ? this.kit.drawCalls : 0;
  }

  stats(): Record<string, number> {
    return {
      pinonesPeople: this._stats.people,
      pinonesPeopleDrawn: this._stats.drawn,
      pinonesCarts: this._stats.carts,
      pinonesCrowdTriangles: this.kit ? this.kit.liveTriangles : 0,
    };
  }

  dispose(): void {
    this.kit?.dispose();
    this.kit = null;
    this.people.length = 0;
    this.site = null;
    this.group.removeFromParent();
    this.group.clear();
  }
}

/* ========================================================================== *
 *  anchor helpers, used by Pinones while it lays out the props
 * ========================================================================== */

/**
 * Yaw that makes a figure look along `(dx, dz)`.
 *
 * The rig faces **−Z** at yaw 0, which is `PedestrianSystem`'s own convention
 * (`heading = atan2(-dx, -dz)`). Every anchor in this file goes through here
 * rather than open-coding the sign flips, because getting it wrong produces a
 * crowd that is subtly, uncannily facing the wrong way and nothing else.
 */
export function faceYaw(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/**
 * A queue at a serving counter: `n` people in a line running back from the
 * hatch, each facing it, with the shuffle of a real queue rather than a rank.
 *
 * `facing` is the shack's yaw — the way the counter looks — so the queue is
 * laid out along `(sin, cos)` of it and everybody turns round to look back at
 * the hatch.
 */
export function queueAnchors(
  out: CrowdAnchor[],
  x: number,
  z: number,
  facing: number,
  n: number,
  height: (x: number, z: number) => number,
  jitter: (a: number, b: number) => number,
): void {
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  for (let i = 0; i < n; i++) {
    const back = 1.15 + i * 0.72 + jitter(-0.16, 0.16);
    const side = jitter(-0.55, 0.55);
    const px = x + fx * back - fz * side;
    const pz = z + fz * back + fx * side;
    out.push({
      x: px,
      y: height(px, pz),
      z: pz,
      // look back down the queue at the hatch: direction −front
      yaw: faceYaw(-fx, -fz),
      kind: 'counter',
    });
  }
}

/** People standing round a barrel table or a speaker, turned inward. */
export function ringAnchors(
  out: CrowdAnchor[],
  x: number,
  z: number,
  radius: number,
  n: number,
  kind: AnchorKind,
  height: (x: number, z: number) => number,
  jitter: (a: number, b: number) => number,
): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + jitter(-0.4, 0.4);
    const r = radius + jitter(-0.14, 0.2);
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    out.push({
      x: px,
      y: height(px, pz),
      z: pz,
      // turned inward, toward whatever they are gathered round
      yaw: faceYaw(-Math.cos(a), -Math.sin(a)),
      kind,
    });
  }
}

/** Clamp a crowd size into a sane band regardless of how many anchors exist. */
export function crowdBudget(anchors: number, density: number, cap: number): number {
  return Math.round(clamp01(density) * Math.min(anchors, cap));
}
