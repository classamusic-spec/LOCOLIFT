/**
 * Loco Lift — the loop.
 *
 *   spawn fares on the sidewalks  →  hail  →  pickup  →  route  →  dropoff
 *      ↑                                                            │
 *      └──────────────── time added, cash banked ───────────────────┘
 *
 * `MissionSystem` owns every waiting fare in the district, the one passenger in
 * the Jeep's rear bed, the destination they asked for, and the special missions
 * that break the rhythm: a drummer with a gig to make, a cruise ship about to
 * sail, a wedding cake that a single hard hit destroys, a runaway piragua cart
 * to chase down, and a rooftop party that is only on the map for 70 seconds.
 *
 * It talks to the rest of the game entirely over the bus (`passenger:*`,
 * `mission:*`, `shift:timeAdded`) and takes the world and the Jeep as narrow
 * structural interfaces, so nothing here imports another subsystem.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type {
  EventKey,
  EventMap,
  FareResult,
  GameContext,
  PassengerArchetype,
  POI,
  POIKind,
  QualityTier,
  RoadGraph,
  System,
} from '../core/types';
import { pickArchetype, routingFor, VARIANTS_PER_ARCHETYPE, archetypeOrDefault } from './Archetypes';
import { DialogueDirector } from './Dialogue';
import {
  blankRide,
  computeFare,
  estimateFare,
  parTimeFor,
  rideAllowanceFor,
  timeAwardFor,
  type RideRecord,
} from './FareModel';
import { Passenger } from './Passenger';
import { BeaconPool, buildPiraguaCart, PassengerModelPool, type PiraguaCart } from './PassengerModel';

/* ------------------------------------------------------ structural inputs */

/** The slice of the city the missions read. Structurally a `WorldAPI`. */
export interface MissionWorld {
  root: THREE.Object3D;
  roads: RoadGraph;
  sidewalks: RoadGraph;
  pois: ReadonlyArray<POI>;
  groundHeight(x: number, z: number): number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  isBlocked(x: number, z: number): boolean;
  poiById(id: string): POI | undefined;
}

/** The slice of the Jeep the missions read. Duck-typed, never imported. */
export interface MissionVehicle {
  readonly object3d: THREE.Object3D;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly speed: number;
  readonly forwardSpeed: number;
  readonly isAirborne: boolean;
  addBoost(amount: number): void;
  setSeatVisual(occupied: boolean, archetypeId?: string): void;
}

/** What the missions need from the combo chain. */
export interface MissionComboFeed {
  readonly pointsBanked: number;
  readonly multiplier: number;
  readonly peakMultiplier: number;
  add(label: string, basePoints: number, at?: THREE.Vector3): void;
}

export interface MissionSystemOptions {
  scene: THREE.Object3D;
  bus: EventBus;
  world: MissionWorld;
  vehicle: MissionVehicle;
  combo?: MissionComboFeed | null;
  rng?: RNG;
  quality?: QualityTier;
  /** how many fares wait on the street at once */
  maxWaiting?: number;
  /** rear-bed seat anchor in the Jeep's local space */
  seatOffset?: { x: number; y: number; z: number };
  /** use the Jeep's own placeholder rider instead of a full procedural figure */
  useVehicleSeatVisual?: boolean;
  /** contact impulse a passenger experiences as a real crash */
  heavyImpulse?: number;
}

/* ---------------------------------------------------------------- tuning */

export const MISSION_TUNING = {
  maxWaiting: 5,
  /** seconds between spawn attempts when short of `maxWaiting` */
  spawnInterval: 1.4,
  /** ring around the player a new fare may appear in, metres */
  spawnMin: 55,
  spawnMax: 235,
  /** no two waiting fares closer than this */
  spawnSeparation: 42,
  /** sidewalk sampling stride when the candidate table is built, metres */
  candidateStride: 13,
  /** how far off the sidewalk centreline they stand, metres */
  kerbInset: 0.75,

  /** dropoff trigger — POI radius is clamped into this band */
  dropMinRadius: 7,
  dropMaxRadius: 22,
  dropSpeed: 13,

  /** how close to the destination before "ya casi llegamos" */
  almostThere: 65,
  /** seconds facing away from the destination before the wrong-way line */
  wrongWayHold: 1.7,

  /** deliveries between special missions */
  specialEvery: 3,
  /** deliveries between runaway-cart events */
  cartEvery: 5,

  /** style money awarded for taking an alley/stairs/rooftop shortcut */
  shortcutPoints: 26,
  /** style money for running down the piragua cart */
  cartCatchPoints: 120,

  heavyImpulse: 2600,
  /** a hit under this is a scrape and does not register as a crash at all */
  scrapeImpulse: 420,
} as const;

/* ------------------------------------------------------ special missions */

export interface SpecialMissionDef {
  id: string;
  title: string;
  objective: string;
  archetypeId: string;
  destKinds: readonly POIKind[];
  /** hard deadline from pickup, seconds */
  timeLimit: number;
  /** contact impulse that fails the run outright, or Infinity */
  crashFail: number;
  bonusCash: number;
  bonusTime: number;
  minRoute: number;
  maxRoute: number;
  failTimeout: string;
  failCrash?: string;
}

/**
 * A stand-in "passenger" so the runaway cart can reuse the HUD's destination
 * card, banner and arrow. Register it alongside the real cast; ids starting
 * with `_` are filtered out of progression by `ScoreSystem`.
 */
export const CART_ARCHETYPE: PassengerArchetype = {
  id: '_cart',
  name: 'Carrito de piraguas',
  blurb: 'Devuélvelo al piragüero antes de que se destroce.',
  patience: 60,
  fareMultiplier: 1,
  thrillSeeking: 0.2,
  color: 0xef476f,
  voicePitch: 1,
};

export const SPECIAL_MISSIONS: readonly SpecialMissionDef[] = [
  {
    id: 'gig-bomba',
    title: 'EL BOMBAZO NO ESPERA',
    objective: 'Lleva a Kique al Salón de Bomba y Plena antes de que empiece el toque.',
    archetypeId: 'bomba-drummer',
    destKinds: ['venue', 'plaza'],
    timeLimit: 64,
    crashFail: Infinity,
    bonusCash: 340,
    bonusTime: 12,
    minRoute: 140,
    maxRoute: 520,
    failTimeout: 'El bombazo empezó sin Kique.',
  },
  {
    id: 'cruise-catch',
    title: 'EL CRUCERO ZARPA',
    objective: 'Marla tiene que estar en el muelle antes de que suelten amarras.',
    archetypeId: 'cruise-guest',
    destKinds: ['dock'],
    timeLimit: 56,
    crashFail: Infinity,
    bonusCash: 400,
    bonusTime: 14,
    minRoute: 150,
    maxRoute: 620,
    failTimeout: 'El crucero zarpó sin Marla. Y sin su pasaporte.',
  },
  {
    id: 'wedding-cake',
    title: 'BIZCOCHO DE BODAS',
    objective: 'Entrega el bizcocho de Doña Yolanda SIN un solo golpe.',
    archetypeId: 'bakery-owner',
    destKinds: ['chapel', 'venue', 'plaza'],
    timeLimit: 96,
    crashFail: 1500,
    bonusCash: 480,
    bonusTime: 15,
    minRoute: 130,
    maxRoute: 460,
    failTimeout: 'La boda empezó y el bizcocho sigue en el carro.',
    failCrash: '¡El bizcocho! Tres pisos en el piso.',
  },
  {
    id: 'rooftop-party',
    title: 'AZOTEA SECRETA',
    objective: 'Sube a K-Bo a la azotea antes de que cierren la puerta.',
    archetypeId: 'trap-artist',
    destKinds: ['rooftop'],
    timeLimit: 72,
    crashFail: Infinity,
    bonusCash: 420,
    bonusTime: 13,
    minRoute: 150,
    maxRoute: 560,
    failTimeout: 'Cerraron la azotea. La fiesta siguió sin ustedes.',
  },
];

/* --------------------------------------------------------- internal types */

interface SpawnCandidate {
  x: number;
  y: number;
  z: number;
  /** point on the street this person faces */
  fx: number;
  fz: number;
}

interface ActiveFare {
  passenger: Passenger;
  destination: POI;
  ride: RideRecord;
  parTime: number;
  allowance: number;
  left: number;
  comboPeak: number;
  special: SpecialMissionDef | null;
  saidAlmostThere: boolean;
  wrongWayTimer: number;
  lastX: number;
  lastZ: number;
}

type CartPhase = 'chase' | 'return';

interface CartRun {
  cart: PiraguaCart;
  phase: CartPhase;
  edgeId: number;
  t: number;
  dir: 1 | -1;
  left: number;
  destination: POI;
  heading: number;
}

export interface WaitingMarker {
  x: number;
  z: number;
}

/* ------------------------------------------------------------------ class */

export class MissionSystem implements System {
  readonly name = 'missions';

  private readonly bus: EventBus;
  private readonly world: MissionWorld;
  private readonly vehicle: MissionVehicle;
  private readonly scene: THREE.Object3D;
  private readonly rng: RNG;
  private combo: MissionComboFeed | null;

  private readonly models: PassengerModelPool;
  private readonly beacons: BeaconPool;
  private readonly dialogue: DialogueDirector;

  private readonly maxWaiting: number;
  private readonly heavyImpulse: number;
  private readonly useVehicleSeat: boolean;

  private readonly mount = new THREE.Object3D();
  private readonly group = new THREE.Group();

  private candidates: SpawnCandidate[] = [];
  private candidateCursor = 0;

  private readonly waiting: Passenger[] = [];
  private active: ActiveFare | null = null;
  private cart: CartRun | null = null;

  private nextId = 1;
  private spawnTimer = 0;
  private sampleTimer = 0;
  private elapsed = 0;
  private running = false;

  private deliveries = 0;
  private failures = 0;
  private sinceSpecial = 0;
  private sinceCart = 0;
  private pendingSpecial: SpecialMissionDef | null = null;
  private lastDestinationId = '';
  private lastShortcutEdge = -1;
  private comboAtLastDelivery = 0;

  /** Reused marker objects — `rebuildMarkers` runs every frame. */
  private readonly markerPool: WaitingMarker[] = [];
  private readonly markers: WaitingMarker[] = [];
  private readonly onScreenArchetypes = new Set<string>();

  /* scratch — never allocate in update */
  private readonly vForward = new THREE.Vector3();
  private readonly vTmp = new THREE.Vector3();
  private readonly vTmp2 = new THREE.Vector3();
  private readonly moodPayload = { archetypeId: '', mood: 'calm' as EventMap['passenger:mood']['mood'] };

  private readonly unsubs: Array<() => void> = [];

  constructor(opts: MissionSystemOptions) {
    this.bus = opts.bus;
    this.world = opts.world;
    this.vehicle = opts.vehicle;
    this.scene = opts.scene;
    this.combo = opts.combo ?? null;
    this.rng = opts.rng ?? new RNG(0x10c0_fa2e);
    this.maxWaiting = opts.maxWaiting ?? MISSION_TUNING.maxWaiting;
    this.heavyImpulse = opts.heavyImpulse ?? MISSION_TUNING.heavyImpulse;
    this.useVehicleSeat = opts.useVehicleSeatVisual ?? false;

    this.models = new PassengerModelPool({ quality: opts.quality ?? 'high' });
    this.beacons = new BeaconPool();
    this.dialogue = new DialogueDirector({ bus: this.bus, rng: this.rng.fork(0x51ee) });

    const seat = opts.seatOffset ?? { x: 0, y: 0.4, z: 1.42 };
    this.mount.position.set(seat.x, seat.y, seat.z);
    this.vehicle.object3d.add(this.mount);

    this.group.name = 'passengers';
    this.scene.add(this.group);
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: GameContext): void {
    this.buildCandidates();
    this.subscribe(ctx.bus);
  }

  setCombo(c: MissionComboFeed | null): void {
    this.combo = c;
  }

  onQualityChange(tier: QualityTier): void {
    this.models.onQualityChange(tier);
  }

  /** Start or stop the whole loop. Stopping clears the street. */
  setActive(on: boolean): void {
    if (this.running === on) return;
    this.running = on;
    if (!on) this.clearWorld();
    else this.spawnTimer = 0;
  }

  get isActive(): boolean {
    return this.running;
  }

  /** Fresh shift: wipe fares, counters and dialogue cooldowns. */
  reset(): void {
    this.clearWorld();
    this.deliveries = 0;
    this.failures = 0;
    this.sinceSpecial = 0;
    this.sinceCart = 0;
    this.pendingSpecial = null;
    this.lastDestinationId = '';
    this.lastShortcutEdge = -1;
    this.comboAtLastDelivery = this.combo ? this.combo.pointsBanked : 0;
    this.elapsed = 0;
    this.spawnTimer = 0;
    this.dialogue.reset(0);
  }

  private clearWorld(): void {
    for (const p of this.waiting) p.despawn();
    this.waiting.length = 0;
    if (this.active) {
      this.active.passenger.despawn();
      this.active = null;
      this.vehicle.setSeatVisual(false);
    }
    if (this.cart) {
      this.cart.cart.dispose();
      this.cart = null;
    }
    this.onScreenArchetypes.clear();
    this.markers.length = 0;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.clearWorld();
    this.mount.removeFromParent();
    this.group.removeFromParent();
    this.models.dispose();
    this.beacons.dispose();
  }

  /* ----------------------------------------------------------- inspection */

  get faresCompleted(): number {
    return this.deliveries;
  }

  get faresFailed(): number {
    return this.failures;
  }

  get hasPassenger(): boolean {
    return this.active !== null;
  }

  get activeArchetypeId(): string | null {
    return this.active ? this.active.passenger.archetype.id : null;
  }

  get activeDestination(): POI | null {
    return this.active ? this.active.destination : null;
  }

  get activeMissionId(): string | null {
    if (this.active?.special) return this.active.special.id;
    if (this.cart) return 'runaway-cart';
    return null;
  }

  /** What the HUD patience bar shows: ride clock while aboard, else 1. */
  get patienceFraction(): number {
    const a = this.active;
    if (!a) return 1;
    return a.allowance > 0 ? clamp01(a.left / a.allowance) : 0;
  }

  /**
   * Minimap markers: every waiting fare, plus the runaway cart while it is
   * still loose. The array is reused — read it, do not retain it.
   */
  get waitingMarkers(): ReadonlyArray<WaitingMarker> {
    return this.markers;
  }

  /** Where the runaway cart is, or null when no chase is running. */
  get cartPosition(): THREE.Vector3 | null {
    if (!this.cart || this.cart.phase !== 'chase') return null;
    return this.cart.cart.root.position;
  }

  get cartPhase(): 'chase' | 'return' | null {
    return this.cart ? this.cart.phase : null;
  }

  /** Where a secured cart has to be dropped off, or null. */
  get cartDestination(): POI | null {
    return this.cart && this.cart.phase === 'return' ? this.cart.destination : null;
  }

  /** Seconds left on the cart chase, or 0. */
  get cartSecondsLeft(): number {
    return this.cart ? Math.max(0, this.cart.left) : 0;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  get spawnCandidateCount(): number {
    return this.candidates.length;
  }

  get drawCallEstimate(): number {
    return this.models.liveCount * 3 + this.beacons.liveCount;
  }

  /* -------------------------------------------------------------- spawning */

  /**
   * Precompute every legal spot a person could stand: sampled along the
   * pedestrian graph, nudged toward the buildings, rejected inside footprints,
   * and pre-faced at the nearest street so nobody hails a wall.
   */
  private buildCandidates(): void {
    const out: SpawnCandidate[] = [];
    const walk = this.world.sidewalks;
    const roads = this.world.roads;
    const p = new THREE.Vector3();
    const tangent = new THREE.Vector3();

    for (const edge of walk.edges) {
      if (!Number.isFinite(edge.length) || edge.length < 6) continue;
      const steps = Math.max(1, Math.floor(edge.length / MISSION_TUNING.candidateStride));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0.5 : i / steps;
        if (t < 0.08 || t > 0.92) continue;
        walk.sample(edge.id, t, 0, p);
        walk.tangent(edge.id, t, tangent);

        /* step off the walking line toward the façades, away from the street */
        const nx = -tangent.z;
        const nz = tangent.x;
        const street = roads.nearest(p, 60);
        let sign = 1;
        let fx = p.x + nx * 10;
        let fz = p.z + nz * 10;
        if (street) {
          const toStreetX = street.point.x - p.x;
          const toStreetZ = street.point.z - p.z;
          sign = toStreetX * nx + toStreetZ * nz > 0 ? -1 : 1;
          fx = street.point.x;
          fz = street.point.z;
        }
        const x = p.x + nx * MISSION_TUNING.kerbInset * sign;
        const z = p.z + nz * MISSION_TUNING.kerbInset * sign;

        if (this.world.isBlocked(x, z)) continue;
        const y = this.world.groundHeight(x, z);
        if (!Number.isFinite(y)) continue;
        out.push({ x, y, z, fx, fz });
      }
    }

    this.rng.fork(0x5aa1).shuffle(out);
    this.candidates = out;
    this.candidateCursor = 0;
  }

  private trySpawnWaiting(): void {
    if (this.candidates.length === 0) return;
    const vx = this.vehicle.position.x;
    const vz = this.vehicle.position.z;
    const minR2 = MISSION_TUNING.spawnMin * MISSION_TUNING.spawnMin;
    const maxR2 = MISSION_TUNING.spawnMax * MISSION_TUNING.spawnMax;
    const sep2 = MISSION_TUNING.spawnSeparation * MISSION_TUNING.spawnSeparation;

    for (let attempt = 0; attempt < 48; attempt++) {
      const c = this.candidates[this.candidateCursor];
      this.candidateCursor = (this.candidateCursor + 1) % this.candidates.length;

      const dx = c.x - vx;
      const dz = c.z - vz;
      const d2 = dx * dx + dz * dz;
      if (d2 < minR2 || d2 > maxR2) continue;

      let clear = true;
      for (const other of this.waiting) {
        const ox = other.position.x - c.x;
        const oz = other.position.z - c.z;
        if (ox * ox + oz * oz < sep2) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      this.spawnAt(c);
      return;
    }
  }

  private spawnAt(c: SpawnCandidate): void {
    const special = this.pendingSpecial;
    const archetype = special
      ? archetypeOrDefault(special.archetypeId)
      : pickArchetype(this.rng, this.onScreenArchetypes);

    this.vTmp.set(c.x, c.y, c.z);
    const p = new Passenger({
      id: this.nextId++,
      archetype,
      variant: this.rng.int(0, VARIANTS_PER_ARCHETYPE - 1),
      position: this.vTmp,
      faceX: c.fx,
      faceZ: c.fz,
      models: this.models,
      beacons: this.beacons,
      patienceScale: special ? 1.25 : 1,
    });
    p.spawn(this.group);
    this.waiting.push(p);
    this.onScreenArchetypes.add(archetype.id);
    if (special) SPECIAL_BY_PASSENGER.set(p, special);
  }

  /* ------------------------------------------------------------- the frame */

  update(ctx: GameContext, dt: number): void {
    if (!this.running || dt <= 0) return;
    this.elapsed += dt;

    const vx = this.vehicle.position.x;
    const vz = this.vehicle.position.z;
    const speed = this.vehicle.speed;

    this.updateWaiting(dt, vx, vz, speed);
    if (this.active) this.updateActive(dt, vx, vz, speed);
    if (this.cart) this.updateCart(dt, vx, vz);

    /* keep the street populated */
    if (!this.active || this.waiting.length < this.maxWaiting) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = MISSION_TUNING.spawnInterval;
        if (this.waiting.length < this.maxWaiting) this.trySpawnWaiting();
      }
    }

    /* low-rate world sampling: shortcuts and wrong-way */
    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0) {
      this.sampleTimer = 0.2;
      this.sampleRoad();
    }

    this.rebuildMarkers();
  }

  private updateWaiting(dt: number, vx: number, vz: number, speed: number): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const p = this.waiting[i];
      const wasNoticed = p.noticed;
      const expired = p.updateWaiting(dt, vx, vz);

      if (!wasNoticed && p.noticed) {
        this.bus.emit('passenger:hail', { archetypeId: p.archetype.id, at: p.position });
        this.dialogue.say(p.archetype.id, 'hail', 'calm', this.elapsed);
      }

      if (expired) {
        this.dialogue.say(p.archetype.id, 'timeout', p.mood, this.elapsed, true);
        this.bus.emit('passenger:bail', { archetypeId: p.archetype.id, reason: 'timeout' });
        this.retire(i, p);
        continue;
      }

      if (p.shouldCull(vx, vz)) {
        this.retire(i, p);
        continue;
      }

      if (!this.active && p.canPickUp(vx, vz, speed)) {
        this.waiting.splice(i, 1);
        this.onScreenArchetypes.delete(p.archetype.id);
        this.beginFare(p);
      }
    }
  }

  private retire(index: number, p: Passenger): void {
    this.waiting.splice(index, 1);
    this.onScreenArchetypes.delete(p.archetype.id);
    const special = SPECIAL_BY_PASSENGER.get(p);
    if (special) {
      SPECIAL_BY_PASSENGER.delete(p);
      if (this.pendingSpecial === special) this.pendingSpecial = null;
    }
    p.markBailed();
    p.despawn();
  }

  /* --------------------------------------------------------------- pickup */

  private beginFare(p: Passenger): void {
    const special = SPECIAL_BY_PASSENGER.get(p) ?? null;
    SPECIAL_BY_PASSENGER.delete(p);
    if (special && this.pendingSpecial === special) this.pendingSpecial = null;

    const destination = this.chooseDestination(p, special);
    if (!destination) {
      /* no legal destination — let them go rather than soft-lock the loop */
      p.markBailed();
      p.despawn();
      return;
    }

    p.board(this.mount);
    if (this.useVehicleSeat) this.vehicle.setSeatVisual(true, p.archetype.id);
    else this.vehicle.setSeatVisual(false);

    const dist = Math.hypot(
      destination.pos.x - p.position.x,
      destination.pos.z - p.position.z,
    );
    const par = parTimeFor(dist);
    const allowance = special ? special.timeLimit : rideAllowanceFor(par);

    const ride = blankRide(p.archetype);
    ride.routeDistance = dist;
    ride.parTime = par;
    ride.missionBonus = special ? special.bonusCash : 0;

    this.active = {
      passenger: p,
      destination,
      ride,
      parTime: par,
      allowance,
      left: allowance,
      comboPeak: 1,
      special,
      saidAlmostThere: false,
      wrongWayTimer: 0,
      lastX: this.vehicle.position.x,
      lastZ: this.vehicle.position.z,
    };
    this.lastDestinationId = destination.id;
    this.lastShortcutEdge = -1;

    this.bus.emit('passenger:pickup', {
      archetypeId: p.archetype.id,
      destinationId: destination.id,
      fareEstimate: estimateFare(p.archetype, dist) + (special ? special.bonusCash : 0),
    });
    this.emitMood(p);
    this.dialogue.onBoard(this.elapsed);
    this.dialogue.say(p.archetype.id, 'pickup', p.mood, this.elapsed, true);

    if (special) {
      this.bus.emit('mission:start', {
        id: special.id,
        title: special.title,
        objective: special.objective,
      });
    }
  }

  private chooseDestination(p: Passenger, special: SpecialMissionDef | null): POI | null {
    const routing = routingFor(p.archetype.id);
    const kinds = special ? special.destKinds : routing.destKinds;
    const minR = special ? special.minRoute : routing.minRoute;
    const maxR = special ? special.maxRoute : routing.maxRoute;

    let best: POI | null = null;
    let bestScore = -Infinity;

    for (const poi of this.world.pois) {
      if (poi.id === this.lastDestinationId) continue;
      const d = Math.hypot(poi.pos.x - p.position.x, poi.pos.z - p.position.z);
      if (d < 45) continue;

      const kindIndex = kinds.indexOf(poi.kind);
      let score = kindIndex >= 0 ? 100 - kindIndex * 12 : 0;
      if (special && kindIndex < 0) continue;

      if (d < minR) score -= (minR - d) * 0.25;
      else if (d > maxR) score -= (d - maxR) * 0.2;
      else score += 30;

      score += this.rng.range(0, 22);
      if (score > bestScore) {
        bestScore = score;
        best = poi;
      }
    }

    if (best) return best;

    /* relaxed fallback: anything far enough away */
    for (const poi of this.world.pois) {
      const d = Math.hypot(poi.pos.x - p.position.x, poi.pos.z - p.position.z);
      if (d >= 60) return poi;
    }
    return this.world.pois.length > 0 ? this.world.pois[0] : null;
  }

  /* ---------------------------------------------------------------- riding */

  private updateActive(dt: number, vx: number, vz: number, speed: number): void {
    const a = this.active;
    if (!a) return;
    const p = a.passenger;

    a.left -= dt;
    a.ride.elapsed += dt;

    const dx = vx - a.lastX;
    const dz = vz - a.lastZ;
    const step = Math.sqrt(dx * dx + dz * dz);
    if (step < 40) a.ride.driven += step;
    a.lastX = vx;
    a.lastZ = vz;

    if (this.combo) {
      const m = this.combo.multiplier;
      if (m > a.comboPeak) a.comboPeak = m;
    }

    const terrified = p.updateRiding(dt, speed);
    if (p.consumeMoodChange()) this.emitMood(p);
    this.dialogue.tickIdle(p.archetype.id, p.mood, this.elapsed);

    /* destination proximity */
    const ddx = a.destination.pos.x - vx;
    const ddz = a.destination.pos.z - vz;
    const dist = Math.sqrt(ddx * ddx + ddz * ddz);

    if (!a.saidAlmostThere && dist < MISSION_TUNING.almostThere) {
      a.saidAlmostThere = true;
      p.react('arriving', 1);
      this.dialogue.say(p.archetype.id, 'almostThere', p.mood, this.elapsed);
    }

    const radius = clamp(a.destination.radius, MISSION_TUNING.dropMinRadius, MISSION_TUNING.dropMaxRadius);
    if (dist <= radius && speed <= MISSION_TUNING.dropSpeed && !this.vehicle.isAirborne) {
      this.completeFare();
      return;
    }

    if (terrified) {
      this.failFare('terrified');
      return;
    }
    if (a.left <= 0) {
      this.failFare('timeout');
    }
  }

  private completeFare(): void {
    const a = this.active;
    if (!a) return;
    const p = a.passenger;

    const t = p.tally;
    a.ride.drifts = t.drifts;
    a.ride.jumps = t.jumps;
    a.ride.tricks = t.tricks;
    a.ride.nearMisses = t.nearMisses;
    a.ride.crashes = t.crashes;
    a.ride.heavyCrashes = t.heavyCrashes;
    a.ride.shortcuts = t.shortcuts;
    a.ride.comfort = p.comfortScore;
    a.ride.terror = p.terrorFraction;
    a.ride.comboPeak = a.comboPeak;
    /* Every dollar of style money lands on some fare's breakdown: this credits
     * everything earned since the *last delivery*, not just since pickup, so
     * the results screen adds up to what the HUD was showing. */
    a.ride.comboPoints = this.combo
      ? Math.max(0, this.combo.pointsBanked - this.comboAtLastDelivery)
      : 0;
    if (this.combo) this.comboAtLastDelivery = this.combo.pointsBanked;

    const result = computeFare(a.ride);
    const seconds = timeAwardFor(result, a.ride.routeDistance) + (a.special ? a.special.bonusTime : 0);

    p.markDelivered();
    p.despawn();
    this.vehicle.setSeatVisual(false);
    this.active = null;
    this.deliveries++;
    this.sinceSpecial++;
    this.sinceCart++;

    this.dialogue.say(p.archetype.id, result.rating >= 4 ? 'perfect' : 'dropoff', p.mood, this.elapsed, true);
    this.bus.emit('passenger:dropoff', { archetypeId: p.archetype.id, result });
    if (a.special) this.bus.emit('mission:complete', { id: a.special.id, result });
    this.bus.emit('shift:timeAdded', {
      seconds,
      reason: a.special ? a.special.title : `${result.grade}`,
    });

    this.queueNextEvent();
  }

  private failFare(reason: 'timeout' | 'terrified'): void {
    const a = this.active;
    if (!a) return;
    const p = a.passenger;

    this.dialogue.say(p.archetype.id, 'timeout', p.mood, this.elapsed, true);
    p.markBailed();
    p.despawn();
    this.vehicle.setSeatVisual(false);
    this.active = null;
    this.failures++;

    this.bus.emit('passenger:bail', { archetypeId: p.archetype.id, reason });
    if (a.special) {
      this.bus.emit('mission:fail', { id: a.special.id, reason: a.special.failTimeout });
    }
  }

  /** A crash-fail mission (the wedding cake) ends the run immediately. */
  private failMissionByCrash(): void {
    const a = this.active;
    if (!a || !a.special) return;
    const p = a.passenger;
    const special = a.special;

    this.dialogue.say(p.archetype.id, 'crash', p.mood, this.elapsed, true);
    p.markBailed();
    p.despawn();
    this.vehicle.setSeatVisual(false);
    this.active = null;
    this.failures++;

    this.bus.emit('passenger:bail', { archetypeId: p.archetype.id, reason: 'terrified' });
    this.bus.emit('mission:fail', {
      id: special.id,
      reason: special.failCrash ?? special.failTimeout,
    });
  }

  /** Decide whether the next fare on the street is special, or a cart chase. */
  private queueNextEvent(): void {
    if (!this.pendingSpecial && this.sinceSpecial >= MISSION_TUNING.specialEvery) {
      this.sinceSpecial = 0;
      this.pendingSpecial = this.rng.pick(SPECIAL_MISSIONS);
    }
    if (!this.cart && this.sinceCart >= MISSION_TUNING.cartEvery) {
      this.sinceCart = 0;
      this.startCartChase();
    }
  }

  /** Force a specific special mission to be the next fare. Returns false if busy. */
  forceSpecialMission(id?: string): boolean {
    if (this.pendingSpecial) return false;
    const def = id ? SPECIAL_MISSIONS.find((m) => m.id === id) : this.rng.pick(SPECIAL_MISSIONS);
    if (!def) return false;
    this.pendingSpecial = def;
    /* make room so the special fare appears promptly */
    if (this.waiting.length >= this.maxWaiting) {
      const victim = this.waiting[0];
      this.retire(0, victim);
    }
    this.spawnTimer = 0;
    return true;
  }

  /* ------------------------------------------------------------ the cart */

  /** "¡El carrito se fue solo!" — chase it down, then take it back. */
  startCartChase(): boolean {
    if (this.cart) return false;
    const roads = this.world.roads;
    if (roads.edges.length === 0) return false;

    const node = roads.nearestNode(this.vehicle.position);
    const start = roads.nodes[node];
    if (!start || start.edges.length === 0) return false;
    const edgeId = start.edges[Math.floor(this.rng.next() * start.edges.length) % start.edges.length];
    const edge = roads.edges[edgeId];
    if (!edge) return false;

    const destination = this.nearestPOIOfKind(['plaza', 'market', 'cafe'], this.vehicle.position);
    if (!destination) return false;

    const cart = buildPiraguaCart(this.models.material);
    roads.sample(edgeId, edge.a === node ? 0.08 : 0.92, 0, this.vTmp);
    cart.root.position.copy(this.vTmp);
    cart.root.position.y = this.world.groundHeight(this.vTmp.x, this.vTmp.z);
    this.group.add(cart.root);

    this.cart = {
      cart,
      phase: 'chase',
      edgeId,
      t: edge.a === node ? 0.08 : 0.92,
      dir: edge.a === node ? 1 : -1,
      left: 78,
      destination,
      heading: 0,
    };

    this.bus.emit('mission:start', {
      id: 'runaway-cart',
      title: 'EL CARRITO FUGITIVO',
      objective: 'Alcanza el carrito de piraguas y devuélvelo antes de que se destroce.',
    });
    return true;
  }

  private updateCart(dt: number, vx: number, vz: number): void {
    const c = this.cart;
    if (!c) return;
    c.left -= dt;

    if (c.phase === 'chase') {
      const roads = this.world.roads;
      const edge = roads.edges[c.edgeId];
      if (!edge) {
        this.endCart(false, 'El carrito se perdió en un callejón.');
        return;
      }
      const speed = 9.6;
      const dt01 = edge.length > 0.5 ? (speed * dt) / edge.length : 1;
      c.t += dt01 * c.dir;

      if (c.t >= 1 || c.t <= 0) {
        const nodeId = c.t >= 1 ? edge.b : edge.a;
        const node = roads.nodes[nodeId];
        if (!node || node.edges.length === 0) {
          this.endCart(false, 'El carrito se estrelló contra la muralla.');
          return;
        }
        /* run away from the taxi */
        let bestEdge = node.edges[0];
        let bestScore = -Infinity;
        for (const eid of node.edges) {
          const e = roads.edges[eid];
          if (!e) continue;
          const otherNode = e.a === nodeId ? e.b : e.a;
          const on = roads.nodes[otherNode];
          if (!on) continue;
          const d = (on.pos.x - vx) ** 2 + (on.pos.z - vz) ** 2;
          const score = d + (eid === c.edgeId ? -90000 : 0) + this.rng.range(0, 4000);
          if (score > bestScore) {
            bestScore = score;
            bestEdge = eid;
          }
        }
        const next = roads.edges[bestEdge];
        c.edgeId = bestEdge;
        c.dir = next.a === nodeId ? 1 : -1;
        c.t = next.a === nodeId ? 0.001 : 0.999;
      }

      roads.sample(c.edgeId, clamp01(c.t), 0, this.vTmp);
      roads.tangent(c.edgeId, clamp01(c.t), this.vTmp2);
      c.cart.root.position.set(this.vTmp.x, this.world.groundHeight(this.vTmp.x, this.vTmp.z), this.vTmp.z);
      c.heading = Math.atan2(this.vTmp2.x * c.dir, this.vTmp2.z * c.dir);
      c.cart.root.rotation.y = c.heading;
      c.cart.spinWheels((9.6 * dt) / 0.3);

      const d = Math.hypot(c.cart.root.position.x - vx, c.cart.root.position.z - vz);
      if (d < 6.5) {
        c.phase = 'return';
        c.left = Math.max(c.left, 70);
        c.cart.root.removeFromParent();
        c.cart.root.position.set(0, 0.05, 3.55);
        c.cart.root.rotation.set(0, 0, 0);
        c.cart.root.scale.setScalar(0.85);
        this.vehicle.object3d.add(c.cart.root);
        this.bus.emit('ui:notice', { text: '¡CARRITO ASEGURADO!', big: true });
        /* re-target the HUD banner, arrow and minimap at the piragüero */
        this.bus.emit('passenger:pickup', {
          archetypeId: CART_ARCHETYPE.id,
          destinationId: c.destination.id,
          fareEstimate: 400,
        });
        this.combo?.add('¡CARRITO ATRAPADO!', MISSION_TUNING.cartCatchPoints);
        this.vehicle.addBoost(0.4);
      }
    } else {
      c.cart.spinWheels(this.vehicle.speed * dt * 3.2);
      const d = Math.hypot(c.destination.pos.x - vx, c.destination.pos.z - vz);
      const radius = clamp(c.destination.radius, MISSION_TUNING.dropMinRadius, MISSION_TUNING.dropMaxRadius);
      if (d <= radius && this.vehicle.speed <= MISSION_TUNING.dropSpeed) {
        this.endCart(true, '');
        return;
      }
    }

    if (c.left <= 0) {
      this.endCart(false, c.phase === 'chase' ? 'El carrito se fue por el muelle.' : 'El piragüero se cansó de esperar.');
    }
  }

  private endCart(success: boolean, reason: string): void {
    const c = this.cart;
    if (!c) return;
    const wasReturning = c.phase === 'return';
    this.cart = null;
    c.cart.dispose();

    if (success) {
      const timeBonus = Math.round(clamp(c.left, 0, 60) * 4);
      const result: FareResult = {
        base: 180,
        distanceBonus: 0,
        timeBonus,
        comboBonus: 0,
        tip: 220,
        total: 400 + timeBonus,
        rating: 5,
        grade: '¡Salvaste el negocio!',
      };
      /* the same object goes to both events; `ScoreSystem` banks it once */
      this.bus.emit('passenger:dropoff', { archetypeId: CART_ARCHETYPE.id, result });
      this.bus.emit('mission:complete', { id: 'runaway-cart', result });
      this.bus.emit('shift:timeAdded', { seconds: 12, reason: 'Carrito devuelto' });
    } else {
      this.failures++;
      /* only clear the HUD card if the return leg had put one up */
      if (wasReturning) {
        this.bus.emit('passenger:bail', { archetypeId: CART_ARCHETYPE.id, reason: 'timeout' });
      }
      this.bus.emit('mission:fail', { id: 'runaway-cart', reason });
    }
  }

  private nearestPOIOfKind(kinds: readonly POIKind[], from: THREE.Vector3): POI | null {
    let best: POI | null = null;
    let bestD = Infinity;
    for (const poi of this.world.pois) {
      if (!kinds.includes(poi.kind)) continue;
      const d = (poi.pos.x - from.x) ** 2 + (poi.pos.z - from.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = poi;
      }
    }
    return best ?? (this.world.pois.length > 0 ? this.world.pois[0] : null);
  }

  /* --------------------------------------------------------- road sampling */

  /** 5 Hz: shortcut detection and the wrong-way nag. Both need the road graph. */
  private sampleRoad(): void {
    const a = this.active;
    const pos = this.vehicle.position;

    const sample = this.world.roads.nearest(pos, 14);
    if (sample) {
      const edge = this.world.roads.edges[sample.edgeId];
      if (
        edge &&
        edge.id !== this.lastShortcutEdge &&
        (edge.kind === 'alley' || edge.kind === 'stairs' || edge.kind === 'rooftop')
      ) {
        this.lastShortcutEdge = edge.id;
        this.combo?.add('¡ATAJO!', MISSION_TUNING.shortcutPoints);
        if (a) {
          a.passenger.react('shortcut', 1);
          this.dialogue.say(a.passenger.archetype.id, 'shortcut', a.passenger.mood, this.elapsed);
        }
      }
    }

    if (!a) return;

    /* wrong way: facing away from the destination, at speed, for a while */
    if (this.vehicle.speed < 7) {
      a.wrongWayTimer = 0;
      return;
    }
    this.vForward.set(0, 0, -1).applyQuaternion(this.vehicle.quaternion);
    const dx = a.destination.pos.x - pos.x;
    const dz = a.destination.pos.z - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 40) {
      a.wrongWayTimer = 0;
      return;
    }
    const sign = this.vehicle.forwardSpeed < 0 ? -1 : 1;
    const dot = ((this.vForward.x * dx + this.vForward.z * dz) / len) * sign;
    if (dot < -0.4) {
      a.wrongWayTimer += 0.2;
      if (a.wrongWayTimer > MISSION_TUNING.wrongWayHold) {
        a.wrongWayTimer = 0;
        a.passenger.react('wrongWay', 1);
        this.dialogue.say(a.passenger.archetype.id, 'wrongWay', a.passenger.mood, this.elapsed);
      }
    } else {
      a.wrongWayTimer = 0;
    }
  }

  private rebuildMarkers(): void {
    const m = this.markers;
    m.length = 0;
    for (let i = 0; i < this.waiting.length; i++) {
      this.pushMarker(this.waiting[i].position.x, this.waiting[i].position.z);
    }
    const c = this.cart;
    if (c && c.phase === 'chase') {
      this.pushMarker(c.cart.root.position.x, c.cart.root.position.z);
    }
  }

  private pushMarker(x: number, z: number): void {
    const i = this.markers.length;
    let slot = this.markerPool[i];
    if (!slot) {
      slot = { x: 0, z: 0 };
      this.markerPool[i] = slot;
    }
    slot.x = x;
    slot.z = z;
    this.markers.push(slot);
  }

  private emitMood(p: Passenger): void {
    this.moodPayload.archetypeId = p.archetype.id;
    this.moodPayload.mood = p.mood;
    this.bus.emit('passenger:mood', this.moodPayload);
  }

  /* --------------------------------------------------------------- events */

  private subscribe(bus: EventBus): void {
    const on = <K extends EventKey>(key: K, fn: (p: EventMap[K]) => void): void => {
      this.unsubs.push(bus.on(key, fn));
    };

    on('vehicle:driftEnd', (p) => {
      const a = this.active;
      if (!a || p.duration < 0.4) return;
      a.passenger.react('drift', clamp(p.duration / 2.2, 0.35, 2));
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
      this.dialogue.say(a.passenger.archetype.id, 'drift', a.passenger.mood, this.elapsed);
    });

    on('vehicle:jumpLand', (p) => {
      const a = this.active;
      if (!a || p.airtime < 0.35) return;
      a.passenger.react('jump', clamp(p.airtime / 1.1, 0.4, 2.2));
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
      this.dialogue.say(a.passenger.archetype.id, 'jump', a.passenger.mood, this.elapsed);
    });

    on('vehicle:airTrick', () => {
      const a = this.active;
      if (!a) return;
      a.passenger.react('airTrick', 1);
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
    });

    on('vehicle:twoWheels', (p) => {
      const a = this.active;
      if (!a) return;
      a.passenger.react('twoWheels', clamp(p.duration / 1.2, 0.4, 1.8));
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
    });

    on('vehicle:nearMiss', () => {
      const a = this.active;
      if (!a) return;
      a.passenger.react('nearMiss', 1);
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
      this.dialogue.say(a.passenger.archetype.id, 'nearMiss', a.passenger.mood, this.elapsed);
    });

    on('vehicle:boostStart', () => {
      const a = this.active;
      if (!a) return;
      a.passenger.react('boost', 1);
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
      this.dialogue.say(a.passenger.archetype.id, 'boost', a.passenger.mood, this.elapsed);
    });

    on('vehicle:collision', (p) => {
      const a = this.active;
      if (!a) return;
      if (p.impulse < MISSION_TUNING.scrapeImpulse) return;

      if (a.special && p.impulse >= a.special.crashFail) {
        this.failMissionByCrash();
        return;
      }
      const heavy = p.impulse >= this.heavyImpulse;
      a.passenger.react(heavy ? 'heavyCrash' : 'crash', clamp(p.impulse / this.heavyImpulse, 0.4, 2));
      if (a.passenger.consumeMoodChange()) this.emitMood(a.passenger);
      this.dialogue.say(a.passenger.archetype.id, 'crash', a.passenger.mood, this.elapsed);
    });

    on('vehicle:reset', () => {
      const a = this.active;
      if (!a) return;
      /* a manual respawn costs a little goodwill but never fails the fare */
      a.passenger.react('crash', 0.5);
    });
  }
}

/**
 * Which waiting fare, if any, is carrying a special mission. Kept out of
 * `Passenger` so that class stays about people, not scheduling.
 */
const SPECIAL_BY_PASSENGER = new WeakMap<Passenger, SpecialMissionDef>();
