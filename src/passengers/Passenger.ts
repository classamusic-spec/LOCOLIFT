/**
 * Loco Lift — a fare, as a thing that exists in the world.
 *
 * A `Passenger` is born standing on a sidewalk with a beacon over their head and
 * a patience clock ticking. If you reach them in time they climb into the open
 * rear bed, and from then on they have **opinions** about your driving: a
 * thrill-seeker's mood climbs on drifts, jumps and near misses, while Doña
 * Carmen's collapses on exactly the same inputs. That mood is what the fare
 * model turns into a tip, so the passenger is not decoration — they are the
 * scoring surface.
 *
 * This class owns: position, patience, mood, the figure, the beacon, and the
 * pickup trigger. It owns nothing about destinations, money or missions; that
 * is `MissionSystem`'s job.
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils';
import type { PassengerArchetype, PassengerMood } from '../core/types';
import {
  BeaconPool,
  PassengerModelPool,
  type HailBeacon,
  type PassengerFigure,
} from './PassengerModel';

/* ------------------------------------------------------------------ types */

export type PassengerState = 'waiting' | 'riding' | 'delivered' | 'bailed' | 'gone';

/** Everything that can move a passenger's mood. */
export type DriveStimulus =
  | 'drift'
  | 'jump'
  | 'airTrick'
  | 'twoWheels'
  | 'nearMiss'
  | 'boost'
  | 'shortcut'
  | 'crash'
  | 'heavyCrash'
  | 'crawling'
  | 'wrongWay'
  | 'arriving';

export interface PassengerOptions {
  id: number;
  archetype: PassengerArchetype;
  /** 0..VARIANTS_PER_ARCHETYPE-1, chooses the procedural look */
  variant: number;
  /** where they stand, already on the ground */
  position: THREE.Vector3;
  /** world point they should face while waiting (the street) */
  faceX: number;
  faceZ: number;
  models: PassengerModelPool;
  beacons: BeaconPool;
  /** scales the archetype's patience — the director shortens it late in a shift */
  patienceScale?: number;
}

/* ---------------------------------------------------------------- tuning */

export const PASSENGER_TUNING = {
  /** metres — the pickup trigger radius */
  pickupRadius: 5.2,
  /** m/s — roll through slower than this and they can jump in */
  pickupSpeed: 9.5,
  /** metres — a hard stop this close always works, whatever the speed */
  pickupSnapRadius: 2.6,
  /** metres — the player is "close enough to have noticed the hail" */
  noticeRadius: 95,
  /** metres — beyond this a waiting fare is culled and respawned elsewhere */
  cullRadius: 460,

  /** how fast mood drifts back to neutral, per second */
  comfortRelax: 0.11,
  /** comfort below this starts filling the terror meter */
  terrorThreshold: -0.55,
  /** seconds of sustained terror before a nervous passenger bails */
  terrorToBail: 3.4,
  /** terror bleeds off this fast when they calm down */
  terrorRelief: 0.55,

  /** m/s below which a hurried passenger starts grumbling */
  crawlSpeed: 4.5,
  /** seconds of crawling before it costs comfort */
  crawlGrace: 2.5,
} as const;

/** How much each stimulus moves comfort, before the thrill-seeking multiplier. */
const STIMULUS: Readonly<Record<DriveStimulus, number>> = {
  drift: 0.1,
  jump: 0.2,
  airTrick: 0.26,
  twoWheels: 0.14,
  nearMiss: 0.12,
  boost: 0.07,
  shortcut: 0.09,
  crash: -0.22,
  heavyCrash: -0.42,
  crawling: -0.05,
  wrongWay: -0.06,
  arriving: 0.1,
};

/* ------------------------------------------------------------------ class */

export class Passenger {
  readonly id: number;
  readonly archetype: PassengerArchetype;
  readonly variant: number;
  readonly position = new THREE.Vector3();

  state: PassengerState = 'waiting';
  /** true once the player has been close enough for the hail to fire */
  noticed = false;

  private readonly models: PassengerModelPool;
  private readonly beaconPool: BeaconPool;
  private figure: PassengerFigure | null = null;
  private beacon: HailBeacon | null = null;

  private readonly patienceMax: number;
  private patienceLeft: number;

  /** -1 (hating this) .. +1 (best ride of their life) */
  private comfort = 0;
  private terror = 0;
  private crawlTimer = 0;
  private moodCache: PassengerMood = 'calm';
  private moodDirty = true;

  /** running tallies the fare model reads */
  readonly tally = {
    drifts: 0,
    jumps: 0,
    tricks: 0,
    nearMisses: 0,
    crashes: 0,
    heavyCrashes: 0,
    shortcuts: 0,
    peakComfort: 0,
    lowComfort: 0,
  };

  private rideTime = 0;
  private faceX: number;
  private faceZ: number;

  constructor(opts: PassengerOptions) {
    this.id = opts.id;
    this.archetype = opts.archetype;
    this.variant = opts.variant;
    this.position.copy(opts.position);
    this.models = opts.models;
    this.beaconPool = opts.beacons;
    this.faceX = opts.faceX;
    this.faceZ = opts.faceZ;

    const scale = opts.patienceScale ?? 1;
    this.patienceMax = Math.max(8, opts.archetype.patience * scale);
    this.patienceLeft = this.patienceMax;
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Build the figure + beacon and add them to the scene. */
  spawn(parent: THREE.Object3D): void {
    if (this.figure) return;
    const fig = this.models.acquire(this.archetype.id, this.variant, 'stand');
    fig.setBase(this.position.x, this.position.y, this.position.z);
    fig.faceTowards(this.faceX, this.faceZ);
    fig.setAnim('hail');
    parent.add(fig.root);
    this.figure = fig;

    const beacon = this.beaconPool.acquire(this.archetype.color);
    beacon.root.position.copy(this.position);
    parent.add(beacon.root);
    this.beacon = beacon;
  }

  /**
   * Move into the Jeep. `mount` is an empty parented to the vehicle at the rear
   * bed's seat position; the seated figure is authored facing -Z, which is the
   * Jeep's forward, so no extra rotation is needed.
   */
  board(mount: THREE.Object3D): void {
    if (this.state !== 'waiting') return;
    this.state = 'riding';
    this.releaseBeacon();
    if (this.figure) {
      this.models.release(this.figure);
      this.figure = null;
    }
    const fig = this.models.acquire(this.archetype.id, this.variant, 'seat');
    fig.setBase(0, 0, 0);
    fig.setHeading(0);
    fig.setAnim('ride');
    mount.add(fig.root);
    this.figure = fig;
    this.rideTime = 0;
    this.comfort = 0;
    this.terror = 0;
  }

  /** Take the figure and beacon out of the world. */
  despawn(): void {
    this.releaseBeacon();
    if (this.figure) {
      this.models.release(this.figure);
      this.figure = null;
    }
    if (this.state === 'waiting' || this.state === 'riding') this.state = 'gone';
  }

  private releaseBeacon(): void {
    if (!this.beacon) return;
    this.beaconPool.release(this.beacon);
    this.beacon = null;
  }

  /* --------------------------------------------------------------- state */

  get mood(): PassengerMood {
    if (!this.moodDirty) return this.moodCache;
    this.moodDirty = false;
    const c = this.comfort;
    if (c > 0.6) this.moodCache = 'thrilled';
    else if (c > 0.22) this.moodCache = 'happy';
    else if (c > -0.22) this.moodCache = 'calm';
    else if (c > -0.6) this.moodCache = 'nervous';
    else this.moodCache = this.archetype.thrillSeeking >= 0 ? 'furious' : 'terrified';
    return this.moodCache;
  }

  get comfortScore(): number {
    return this.comfort;
  }

  get patienceFraction(): number {
    return this.patienceMax > 0 ? clamp01(this.patienceLeft / this.patienceMax) : 0;
  }

  get patienceSeconds(): number {
    return this.patienceLeft;
  }

  get rideSeconds(): number {
    return this.rideTime;
  }

  get figureRoot(): THREE.Object3D | null {
    return this.figure ? this.figure.root : null;
  }

  /** Deduct waiting patience directly — used by hard-deadline missions. */
  drainPatience(seconds: number): void {
    this.patienceLeft = Math.max(0, this.patienceLeft - seconds);
  }

  addPatience(seconds: number): void {
    this.patienceLeft = clamp(this.patienceLeft + seconds, 0, this.patienceMax);
  }

  /* ------------------------------------------------------------- waiting */

  /**
   * Tick a waiting fare. Returns `true` when patience just ran out and the
   * mission system should bail them.
   */
  updateWaiting(dt: number, vx: number, vz: number): boolean {
    if (this.state !== 'waiting') return false;
    this.patienceLeft -= dt;

    const f = this.patienceFraction;
    if (this.beacon) {
      this.beacon.setUrgency(1 - f);
      this.beacon.update(dt);
    }

    const dx = vx - this.position.x;
    const dz = vz - this.position.z;
    const d2 = dx * dx + dz * dz;

    if (!this.noticed && d2 < PASSENGER_TUNING.noticeRadius * PASSENGER_TUNING.noticeRadius) {
      this.noticed = true;
    }

    if (this.figure) {
      /* look at the taxi once it is close enough to be worth waving at */
      if (d2 < 60 * 60) this.figure.faceTowards(vx, vz);
      else this.figure.faceTowards(this.faceX, this.faceZ);
      this.figure.setAnim(f < 0.28 ? 'annoyed' : 'hail');
      this.figure.update(dt);
    }

    if (this.patienceLeft <= 0) {
      this.patienceLeft = 0;
      return true;
    }
    return false;
  }

  /** Straight-line ground distance to a point. */
  distanceTo(x: number, z: number): number {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Crazy-Taxi rules: slide in fast and close, or stop dead right on them. */
  canPickUp(x: number, z: number, speed: number): boolean {
    if (this.state !== 'waiting') return false;
    const d = this.distanceTo(x, z);
    if (d <= PASSENGER_TUNING.pickupSnapRadius) return true;
    return d <= PASSENGER_TUNING.pickupRadius && speed <= PASSENGER_TUNING.pickupSpeed;
  }

  /** True when the player has driven far enough away to recycle this fare. */
  shouldCull(x: number, z: number): boolean {
    return this.state === 'waiting' && this.distanceTo(x, z) > PASSENGER_TUNING.cullRadius;
  }

  /* --------------------------------------------------------------- riding */

  /**
   * Tick a rider. Returns `true` when they are too terrified to continue and
   * should bail out of a moving vehicle (which they will absolutely do).
   */
  updateRiding(dt: number, speed: number): boolean {
    if (this.state !== 'riding') return false;
    this.rideTime += dt;

    /* mood relaxes toward neutral so one scare does not doom a whole fare */
    const relax = PASSENGER_TUNING.comfortRelax * dt;
    if (this.comfort > relax) this.setComfort(this.comfort - relax);
    else if (this.comfort < -relax) this.setComfort(this.comfort + relax);
    else if (this.comfort !== 0) this.setComfort(0);

    /* people in a hurry hate crawling */
    if (speed < PASSENGER_TUNING.crawlSpeed) {
      this.crawlTimer += dt;
      if (this.crawlTimer > PASSENGER_TUNING.crawlGrace) {
        this.crawlTimer = PASSENGER_TUNING.crawlGrace;
        /* the less patience the archetype has, the more crawling costs */
        const impatience = clamp01(1 - this.archetype.patience / 120);
        this.setComfort(this.comfort + STIMULUS.crawling * impatience * dt * 0.6);
      }
    } else {
      this.crawlTimer = 0;
    }

    /* terror only builds for people who did not sign up for this */
    const fear = clamp01(-this.archetype.thrillSeeking);
    if (fear > 0.05 && this.comfort < PASSENGER_TUNING.terrorThreshold) {
      const depth = clamp01((PASSENGER_TUNING.terrorThreshold - this.comfort) / 0.45);
      this.terror += (dt / PASSENGER_TUNING.terrorToBail) * depth * fear;
    } else {
      this.terror = Math.max(0, this.terror - dt * PASSENGER_TUNING.terrorRelief);
    }

    if (this.figure) this.figure.update(dt);

    return this.terror >= 1;
  }

  /** 0..1 — how close a nervous passenger is to jumping out. */
  get terrorFraction(): number {
    return clamp01(this.terror);
  }

  /**
   * Feed one driving event. `intensity` is a 0..1+ scale (drift length, jump
   * height, impact severity) that scales the mood swing.
   */
  react(stimulus: DriveStimulus, intensity = 1): void {
    if (this.state !== 'riding') return;
    const base = STIMULUS[stimulus];
    const thrill = this.archetype.thrillSeeking;
    const scale = clamp(intensity, 0, 2.5);

    let delta: number;
    if (base >= 0) {
      /* good-if-you-like-that-sort-of-thing: signed by thrill seeking */
      delta = base * scale * thrill;
      if (stimulus === 'arriving') delta = base * scale * 0.6 + base * scale * 0.4 * thrill;
    } else {
      /* crashes hurt everyone; thrill-seekers just shrug them off faster */
      delta = base * scale * (1 - 0.35 * clamp01(thrill));
    }

    this.setComfort(this.comfort + delta);

    switch (stimulus) {
      case 'drift':
        this.tally.drifts++;
        break;
      case 'jump':
        this.tally.jumps++;
        break;
      case 'airTrick':
        this.tally.tricks++;
        break;
      case 'nearMiss':
        this.tally.nearMisses++;
        break;
      case 'shortcut':
        this.tally.shortcuts++;
        break;
      case 'crash':
        this.tally.crashes++;
        break;
      case 'heavyCrash':
        this.tally.crashes++;
        this.tally.heavyCrashes++;
        break;
      default:
        break;
    }

    this.playReaction(stimulus, delta);
  }

  private playReaction(stimulus: DriveStimulus, delta: number): void {
    const fig = this.figure;
    if (!fig) return;
    switch (stimulus) {
      case 'crash':
      case 'heavyCrash':
        fig.react('brace', stimulus === 'heavyCrash' ? 1.4 : 0.9);
        break;
      case 'jump':
      case 'airTrick':
        fig.react(delta >= 0 ? 'cheer' : 'brace', 1.1);
        break;
      case 'drift':
      case 'twoWheels':
        fig.react(delta >= 0 ? 'cheer' : 'brace', 0.6);
        break;
      case 'nearMiss':
        if (delta < 0) fig.react('brace', 0.5);
        break;
      case 'boost':
        if (delta < 0) fig.react('brace', 0.45);
        break;
      default:
        break;
    }
  }

  private setComfort(v: number): void {
    const next = clamp(v, -1, 1);
    if (next === this.comfort) return;
    const before = this.mood;
    this.comfort = next;
    this.moodDirty = true;
    if (next > this.tally.peakComfort) this.tally.peakComfort = next;
    if (next < this.tally.lowComfort) this.tally.lowComfort = next;
    this.moodChangedFlag = this.mood !== before;
  }

  private moodChangedFlag = false;

  /** True once per mood transition — poll it, it self-clears. */
  consumeMoodChange(): boolean {
    if (!this.moodChangedFlag) return false;
    this.moodChangedFlag = false;
    return true;
  }

  /* ---------------------------------------------------------------- exits */

  markDelivered(): void {
    this.state = 'delivered';
  }

  markBailed(): void {
    this.state = 'bailed';
  }
}
