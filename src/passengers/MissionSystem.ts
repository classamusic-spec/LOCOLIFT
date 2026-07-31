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
  ALL_MISSIONS,
  bucketByRegion,
  eligibleSideMissions,
  nextStoryMission,
  regionOfPOI,
  SIDE_MISSIONS,
  type MapRegion,
  type MissionContext,
  type SpecialMissionDef,
  type WeatherKind,
} from './MissionCatalog';
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
  /** roster id — `'jeep'`, `'bus'`, … Absent means the Jeep. */
  readonly vehicleId?: string;
  addBoost(amount: number): void;
  setSeatVisual(occupied: boolean, archetypeId?: string): void;
}

/**
 * A named signature route the missions can bind a run to — in practice
 * `ElTorroRoute`, handed over by `main` so nothing here imports the states
 * layer. Only these three members are used.
 */
export interface MissionRoute {
  readonly length: number;
  /** metres from `(x, z)` to the route centreline */
  distanceTo(x: number, z: number): number;
  /** the POI ids the route wants visited, in order */
  waypointIds(): string[];
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

  /** a mission fare anchored to a POI may spawn this far from the player */
  anchoredSpawnMax: 780,
  /** …and no closer than this, so it is never already on top of you */
  anchoredSpawnMin: 45,
  /** a side job must stay inside the cull radius or it is recycled at once */
  sideSpawnMax: 400,
  /** metres from the anchor POI a mission fare may stand */
  anchorRadius: 120,
  /** style money for landing a mid-run leg of a multi-stop job */
  legPoints: 60,

  /** style money awarded for taking an alley/stairs/rooftop shortcut */
  shortcutPoints: 26,
  /** metres of clean running on a signature route between style payouts */
  routeStride: 150,
  /** style money for each of those */
  routePoints: 34,
  /** default metres from a bound route that still counts as "on it" */
  offRouteRadius: 45,
  /** most stops a single job may chain */
  maxLegs: 8,
  /** style money for running down the piragua cart */
  cartCatchPoints: 120,

  heavyImpulse: 2600,
  /** a hit under this is a scrape and does not register as a crash at all */
  scrapeImpulse: 420,
} as const;

/* ------------------------------------------------------ special missions */

export type { SpecialMissionDef, MapRegion, WeatherKind } from './MissionCatalog';
export { ALL_MISSIONS, SIDE_MISSIONS, STORY_MISSIONS, missionById } from './MissionCatalog';

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

/** The arcade random pool, straight from the catalog. */
export { SPECIAL_MISSIONS } from './MissionCatalog';

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
  /** 1-based leg of a multi-stop job */
  leg: number;
  legs: number;
  /** POI ids already delivered to on this run */
  visited: string[];
  /** seconds spent under a job's speed floor */
  slowTimer: number;
  /** seconds spent over a job's speed ceiling (the escort problem) */
  fastTimer: number;
  /** heavy contacts this run, for `heavyHitLimit` */
  heavyHits: number;
  /** ordered stops for a `waypoints` job; empty for a normal fare */
  waypoints: POI[];
  /** the signature route this run is bound to, or null */
  route: MissionRoute | null;
  /** seconds spent away from that route */
  offRouteTimer: number;
  /** metres driven on the route since the last adherence payout */
  routeMetres: number;
  /** `ride.driven` at the last road sample, so adherence can use the delta */
  lastSampleDriven: number;
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
  /** the waiting fare carrying the pending special job, for the HUD pin */
  private specialFare: Passenger | null = null;
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

  /* --- world/eligibility state the catalog filters on --------------------- */
  private hour = 12;
  private weather: WeatherKind = 'clear';
  private rank = 0;
  private readonly completed = new Set<string>();
  private readonly regions = new Set<MapRegion>();
  private regionOf = new Map<string, MapRegion>();
  private buckets: Record<MapRegion, POI[]> = { oldTown: [], coast: [], pinones: [] };
  /** signature routes a job may bind to, keyed by `SpecialMissionDef.route` */
  private readonly routes = new Map<string, MissionRoute>();
  /** when true, the next special is the next unplayed encargo, not a random job */
  private storyMode = false;
  /** the campaign's pick, when a story controller is driving the spine */
  private storyOverrideId: string | null = null;
  /** the spine job currently queued or running, for the story controller */
  private storyActiveId: string | null = null;
  private storyResolved: 'complete' | 'fail' | null = null;
  private readonly missionCtx: MissionContext = {
    hour: 12,
    weather: 'clear',
    rank: 0,
    completed: this.completed,
    regions: this.regions,
  };
  /** scratch for weighted mission rolls — never reallocated per frame */
  private readonly rollPool: SpecialMissionDef[] = [];
  private readonly rollWeights: number[] = [];

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
    this.buildRegions();
    this.subscribe(ctx.bus);
  }

  setCombo(c: MissionComboFeed | null): void {
    this.combo = c;
  }

  /* ------------------------------------------------- catalog eligibility */

  /** Bucket the POI table by region once. Cheap, and only the world changes it. */
  private buildRegions(): void {
    this.buckets = bucketByRegion(this.world.pois, this.world.bounds);
    this.regions.clear();
    this.regionOf.clear();
    for (const key of ['oldTown', 'coast', 'pinones'] as const) {
      if (this.buckets[key].length > 0) this.regions.add(key);
      for (const poi of this.buckets[key]) this.regionOf.set(poi.id, key);
    }
    if (this.regions.size === 0) this.regions.add('oldTown');
  }

  /** Re-bucket after the world has grown (a district streamed in). */
  refreshRegions(): void {
    this.buildRegions();
  }

  get availableRegions(): ReadonlySet<MapRegion> {
    return this.regions;
  }

  regionForPOI(poi: POI): MapRegion {
    return this.regionOf.get(poi.id) ?? regionOfPOI(poi, this.world.bounds);
  }

  /** Player reputation rank — gates the harder jobs. */
  setRank(rank: number): void {
    this.rank = Number.isFinite(rank) ? Math.max(0, rank) : 0;
    this.missionCtx.rank = this.rank;
  }

  /** Story ids already finished, so the spine and `requires` gates resolve. */
  setCompletedMissions(ids: Iterable<string>): void {
    this.completed.clear();
    for (const id of ids) this.completed.add(id);
  }

  /** Run the progression spine instead of rolling random side jobs. */
  setStoryMode(on: boolean): void {
    this.storyMode = on;
  }

  /**
   * Register a signature route (`'el-torro'`). Jobs with a matching `route`
   * field then follow its waypoints and can be failed for leaving it. Passing
   * null removes it, and every such job silently degrades to normal routing.
   */
  setRoute(name: string, route: MissionRoute | null): void {
    if (route) this.routes.set(name, route);
    else this.routes.delete(name);
  }

  routeFor(name: string | undefined): MissionRoute | null {
    if (!name) return null;
    return this.routes.get(name) ?? null;
  }

  /**
   * Where each regular is in their own arc, so the dialogue director layers the
   * right lines. Call once at shift start from the relationship ledger.
   */
  setArcStages(entries: Iterable<readonly [string, number]>): void {
    this.dialogue.setStages(entries);
  }

  /** The arc stage the director is currently using for `archetypeId`. */
  arcStageOf(archetypeId: string): number {
    return this.dialogue.stageOf(archetypeId);
  }

  get storyMissionId(): string | null {
    return this.storyActiveId;
  }

  /** `'complete'` / `'fail'` once the queued spine job resolves; self-clearing. */
  consumeStoryResult(): 'complete' | 'fail' | null {
    const r = this.storyResolved;
    this.storyResolved = null;
    return r;
  }

  private syncMissionCtx(): MissionContext {
    this.missionCtx.hour = this.hour;
    this.missionCtx.weather = this.weather;
    this.missionCtx.rank = this.rank;
    return this.missionCtx;
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
    this.storyActiveId = null;
    this.storyResolved = null;
    this.dialogue.reset(0);
  }

  private clearWorld(): void {
    for (const p of this.waiting) p.despawn();
    this.waiting.length = 0;
    this.specialFare = null;
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

  /**
   * Where the special/story fare is standing, or null when none is out. The
   * minimap should pin this differently from an ordinary hail — it is the one
   * marker the player is actually being told to drive to.
   */
  get specialFarePosition(): THREE.Vector3 | null {
    const p = this.specialFare;
    if (!p || !this.waiting.includes(p)) return null;
    return p.position;
  }

  /** The job that fare is carrying, or null. */
  get pendingMissionId(): string | null {
    return this.pendingSpecial ? this.pendingSpecial.id : null;
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

  /**
   * Where a job's fare should be standing. `spawnIds` beats `spawnKinds` beats
   * the job's region; anything the live world does not have simply falls
   * through, so a build without Piñones still offers Doña Fela's ruta — it just
   * runs it out of whatever kioskos exist.
   */
  private spawnAnchorFor(def: SpecialMissionDef): POI | null {
    const pois = this.world.pois;
    if (pois.length === 0) return null;

    if (def.spawnIds) {
      let best: POI | null = null;
      for (const id of def.spawnIds) {
        const poi = this.world.poiById(id);
        if (poi && (!best || this.rng.bool(0.5))) best = poi;
      }
      if (best) return best;
    }

    const regionPool = def.region ? this.buckets[def.region] : null;
    const pool = regionPool && regionPool.length > 0 ? regionPool : pois;

    if (def.spawnKinds && def.spawnKinds.length > 0) {
      let chosen: POI | null = null;
      let seen = 0;
      for (const poi of pool) {
        if (!def.spawnKinds.includes(poi.kind)) continue;
        seen++;
        /* reservoir sample so a long POI table does not always pick the first */
        if (this.rng.next() < 1 / seen) chosen = poi;
      }
      if (chosen) return chosen;
    }

    if (regionPool && regionPool.length > 0) {
      return regionPool[this.rng.int(0, regionPool.length - 1)];
    }
    return null;
  }

  /**
   * Spawn the pending special near its anchor. Falls back to the normal ring
   * spawn when nothing legal is near enough — never soft-locks the loop.
   */
  private trySpawnAnchored(def: SpecialMissionDef): boolean {
    const anchor = this.spawnAnchorFor(def);
    if (!anchor || this.candidates.length === 0) return false;

    const vx = this.vehicle.position.x;
    const vz = this.vehicle.position.z;
    const minR2 = MISSION_TUNING.anchoredSpawnMin * MISSION_TUNING.anchoredSpawnMin;
    /*
     * Only a story beat is allowed to stand beyond the cull radius — it is
     * exempt from culling. A side job placed out there would be recycled the
     * moment it appeared, so it stays inside the ring the player is working.
     */
    const maxR = def.story
      ? MISSION_TUNING.anchoredSpawnMax
      : Math.min(MISSION_TUNING.anchoredSpawnMax, MISSION_TUNING.sideSpawnMax);
    const maxR2 = maxR * maxR;
    const anchorR2 = MISSION_TUNING.anchorRadius * MISSION_TUNING.anchorRadius;
    const sep2 = MISSION_TUNING.spawnSeparation * MISSION_TUNING.spawnSeparation;

    let best: SpawnCandidate | null = null;
    let bestD = Infinity;
    /** nearest legal spot to the anchor regardless of the radius, as a backstop */
    let fallback: SpawnCandidate | null = null;
    let fallbackD = Infinity;

    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i];
      const ax = c.x - anchor.pos.x;
      const az = c.z - anchor.pos.z;
      const ad2 = ax * ax + az * az;
      if (ad2 >= fallbackD && ad2 >= bestD) continue;

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

      if (ad2 < fallbackD) {
        fallback = c;
        fallbackD = ad2;
      }
      if (ad2 <= anchorR2 && ad2 < bestD) {
        best = c;
        bestD = ad2;
      }
    }

    /*
     * A district the world has POIs for but no pedestrian graph in — Piñones
     * before its sidewalks land, say — would otherwise never place its jobs.
     * Standing the fare at the nearest legal spot *toward* the anchor is a much
     * better failure than the job silently never appearing.
     */
    const chosen = best ?? fallback;
    if (!chosen) return false;
    this.spawnAt(chosen, true);
    return true;
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

  private spawnAt(c: SpawnCandidate, forceSpecial = false): void {
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
      /* a story beat waits for you; an ordinary special is merely patient */
      patienceScale: special ? (special.story ? 4 : 1.8) : 1,
    });
    p.spawn(this.group);
    this.waiting.push(p);
    this.onScreenArchetypes.add(archetype.id);
    if (special) {
      SPECIAL_BY_PASSENGER.set(p, special);
      this.specialFare = p;
      /*
       * The toast plus the minimap marker *are* the discovery mechanic. This
       * used to fire only for anchored spawns, which meant a job whose district
       * had no pedestrian graph appeared with no announcement at all and could
       * never be found. Every special announces itself now.
       */
      p.noticed = true;
      this.bus.emit('passenger:hail', { archetypeId: archetype.id, at: p.position });
      this.bus.emit('ui:toast', { text: special.title, icon: 'star', ms: 3200 });
      void forceSpecial;
    }
  }

  /* ------------------------------------------------------------- the frame */

  update(ctx: GameContext, dt: number): void {
    if (!this.running || dt <= 0) return;
    this.elapsed += dt;
    if (Number.isFinite(ctx.timeOfDay)) this.hour = ctx.timeOfDay;

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
        if (this.waiting.length < this.maxWaiting) {
          const pending = this.pendingSpecial;
          const anchored =
            pending !== null &&
            (pending.region !== undefined ||
              pending.spawnKinds !== undefined ||
              pending.spawnIds !== undefined);
          if (!anchored || !this.trySpawnAnchored(pending as SpecialMissionDef)) {
            this.trySpawnWaiting();
          }
        }
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

      /*
       * Ordinary fares — and ordinary side jobs — are recycled once you have
       * driven away from them; that is how the board keeps offering new work.
       * A *story* beat never is. An encargo is deliberately anchored across the
       * map (`anchoredSpawnMax` is 780 m, the cull radius is 460), so culling it
       * meant a Piñones encargo could be announced, silently recycled on the
       * next frame, and never be pickable at all.
       */
      if (!SPECIAL_BY_PASSENGER.get(p)?.story && p.shouldCull(vx, vz)) {
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
    if (this.specialFare === p) this.specialFare = null;
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
    if (this.specialFare === p) this.specialFare = null;
    if (special && this.pendingSpecial === special) this.pendingSpecial = null;

    /*
     * A routed job (El Torro) knows exactly where it goes: resolve the ordered
     * waypoint list up front, then every leg is just the next entry. When the
     * world has none of the named POIs the list comes back empty and the run
     * falls through to ordinary destination scoring, so it always plays.
     */
    const waypoints = this.resolveWaypoints(special);
    /* you cannot "arrive" at a stop you are already standing on — skip it */
    while (waypoints.length > 2) {
      const first = waypoints[0];
      const d = Math.hypot(first.pos.x - p.position.x, first.pos.z - p.position.z);
      if (d >= 38) break;
      waypoints.shift();
    }
    const boundRoute = this.routeFor(special?.route);

    const destination = waypoints.length > 0
      ? waypoints[0]
      : this.chooseDestination(p.position, special, EMPTY_VISITED);
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
      leg: 1,
      legs: legCountFor(special, waypoints.length),
      visited: [],
      slowTimer: 0,
      fastTimer: 0,
      heavyHits: 0,
      waypoints,
      route: boundRoute,
      offRouteTimer: 0,
      routeMetres: 0,
      lastSampleDriven: 0,
    };
    this.lastDestinationId = destination.id;
    this.lastShortcutEdge = -1;
    if (special?.story) this.storyActiveId = special.id;

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
      if (this.active.legs > 1) {
        this.bus.emit('ui:toast', {
          text: `${legNounFor(special)} 1 / ${this.active.legs}`,
          icon: 'pin',
          ms: 2200,
        });
      }
    }
  }

  /**
   * Turn a job's ordered `waypoints` into real POIs. A bound signature route
   * gets first refusal — it has already matched each garita to whatever the
   * world actually registered — and anything still unresolved is simply
   * dropped, shortening the run rather than breaking it.
   */
  private resolveWaypoints(def: SpecialMissionDef | null): POI[] {
    const out: POI[] = [];
    if (!def) return out;

    const route = this.routeFor(def.route);
    const ids = route ? route.waypointIds() : def.waypoints;
    if (!ids || ids.length === 0) return out;

    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      const poi = this.world.poiById(id);
      if (!poi) continue;
      seen.add(id);
      out.push(poi);
    }
    /* a routed job with nothing resolvable is better off using normal routing */
    if (out.length < 2) out.length = 0;
    return out;
  }

  /**
   * Pick where this run goes next. Shared by the first leg and every leg after
   * it, so a multi-stop job never revisits a kiosko it has already served and
   * never picks a stop it cannot reach in the leg's time limit.
   */
  private chooseDestination(
    from: THREE.Vector3,
    special: SpecialMissionDef | null,
    visited: readonly string[],
    archetypeId?: string,
  ): POI | null {
    const routing = routingFor(archetypeId ?? special?.archetypeId ?? '');
    const kinds = special ? special.destKinds : routing.destKinds;
    const minR = special ? special.minRoute : routing.minRoute;
    const maxR = special ? special.maxRoute : routing.maxRoute;
    const region = special?.region;

    let best: POI | null = null;
    let bestScore = -Infinity;

    for (const poi of this.world.pois) {
      if (poi.id === this.lastDestinationId) continue;
      if (visited.length > 0 && visited.includes(poi.id)) continue;
      const d = Math.hypot(poi.pos.x - from.x, poi.pos.z - from.z);
      if (d < 45) continue;

      const kindIndex = kinds.indexOf(poi.kind);
      let score = kindIndex >= 0 ? 100 - kindIndex * 12 : 0;
      if (special && kindIndex < 0) continue;

      /* an explicitly-named venue is what the writer meant — take it */
      if (special?.destIds && special.destIds.includes(poi.id)) score += 220;
      /* keep a regional job inside its region when the world has one */
      if (region && this.regionOf.get(poi.id) === region) score += 55;

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

    /* relaxed fallback: anything far enough away and not already served */
    for (const poi of this.world.pois) {
      if (visited.length > 0 && visited.includes(poi.id)) continue;
      const d = Math.hypot(poi.pos.x - from.x, poi.pos.z - from.z);
      if (d >= 60) return poi;
    }
    for (const poi of this.world.pois) {
      if (visited.length === 0 || !visited.includes(poi.id)) return poi;
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
      if (a.leg < a.legs) this.advanceLeg();
      else this.completeFare();
      return;
    }

    if (terrified) {
      this.failFare('terrified');
      return;
    }

    const def = a.special;

    /*
     * The comfort clause. A sightseeing run, a nurse who needs both hands
     * tomorrow, and your seventy-something uncle in the back all fail long
     * before the passenger would actually bail — this is a *softer* threshold
     * than `terrified`, and it is the whole difficulty of those missions.
     */
    if (def?.terrorFail !== undefined && p.terrorFraction >= def.terrorFail) {
      this.failFare('terrified', def.failTerror);
      return;
    }

    /* a chase job dies if you stop chasing */
    const floor = def?.minSpeedAbove;
    if (floor !== undefined && floor > 0) {
      if (speed < floor) {
        a.slowTimer += dt;
        const grace = def?.minSpeedGrace ?? 5;
        if (a.slowTimer >= grace) {
          this.failFare('timeout', def?.failSlow);
          return;
        }
      } else if (a.slowTimer > 0) {
        a.slowTimer = Math.max(0, a.slowTimer - dt * 2);
      }
    }

    /* …and an escort dies if you leave everybody behind */
    const ceiling = def?.maxSpeedBelow;
    if (ceiling !== undefined && ceiling > 0) {
      if (speed > ceiling) {
        a.fastTimer += dt;
        const grace = def?.maxSpeedGrace ?? 4;
        if (a.fastTimer >= grace) {
          this.failFare('timeout', def?.failFast);
          return;
        }
      } else if (a.fastTimer > 0) {
        a.fastTimer = Math.max(0, a.fastTimer - dt * 1.5);
      }
    }

    if (a.left <= 0) {
      this.failFare('timeout');
    }
  }

  /**
   * A mid-run stop landed. The passenger stays aboard, the clock is reset to
   * the leg's limit, and the HUD is re-pointed at the next kiosko. This is the
   * whole multi-stop verb — one delivery, several destinations.
   */
  private advanceLeg(): void {
    const a = this.active;
    if (!a || !a.special) return;
    const def = a.special;

    a.visited.push(a.destination.id);
    a.leg++;

    /* a routed job walks its own list; everything else scores a fresh stop */
    const next = a.waypoints.length >= a.leg
      ? a.waypoints[a.leg - 1]
      : this.chooseDestination(a.destination.pos, def, a.visited, a.passenger.archetype.id);
    if (!next) {
      /* nowhere left to go — pay out what has been earned rather than stall */
      this.completeFare();
      return;
    }

    const legCash = def.legBonus ?? 0;
    const legSeconds = def.legTime ?? Math.max(8, def.timeLimit * 0.3);

    const legDistance = Math.hypot(
      next.pos.x - a.destination.pos.x,
      next.pos.z - a.destination.pos.z,
    );
    a.destination = next;
    a.left = def.timeLimit;
    a.allowance = def.timeLimit;
    a.saidAlmostThere = false;
    a.wrongWayTimer = 0;
    a.slowTimer = 0;
    a.fastTimer = 0;
    a.offRouteTimer = 0;
    a.ride.missionBonus += legCash;
    a.ride.routeDistance += legDistance;
    a.parTime = parTimeFor(a.ride.routeDistance);
    a.ride.parTime = a.parTime;
    this.lastDestinationId = next.id;

    const noun = legNounFor(def);
    this.combo?.add(`${noun} ${a.leg - 1} / ${a.legs}`, MISSION_TUNING.legPoints);
    this.bus.emit('shift:timeAdded', { seconds: legSeconds, reason: `${noun} ${a.leg - 1}` });
    this.bus.emit('ui:notice', { text: `${noun} ${a.leg - 1} / ${a.legs}`, big: false });
    this.bus.emit('audio:sfx', { id: 'dropoff', volume: 0.8 });
    /* re-points the HUD card, the destination arrow and the minimap */
    this.bus.emit('passenger:pickup', {
      archetypeId: a.passenger.archetype.id,
      destinationId: next.id,
      fareEstimate:
        estimateFare(a.passenger.archetype, a.ride.routeDistance) + def.bonusCash + a.ride.missionBonus,
    });
    this.dialogue.say(a.passenger.archetype.id, 'dropoff', a.passenger.mood, this.elapsed, true);
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
    if (a.special) {
      this.completed.add(a.special.id);
      if (a.special.story) {
        this.storyResolved = 'complete';
        this.storyActiveId = null;
      }
      this.bus.emit('mission:complete', { id: a.special.id, result });
    }
    this.bus.emit('shift:timeAdded', {
      seconds,
      reason: a.special ? a.special.title : `${result.grade}`,
    });

    this.queueNextEvent();
  }

  private failFare(reason: 'timeout' | 'terrified', override?: string): void {
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
      if (a.special.story) {
        this.storyResolved = 'fail';
        this.storyActiveId = null;
      }
      this.bus.emit('mission:fail', {
        id: a.special.id,
        reason: override ?? a.special.failTimeout,
      });
    }
  }

  /** A crash-fail mission (the wedding cake) ends the run immediately. */
  private failMissionByCrash(override?: string): void {
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
    if (special.story) {
      this.storyResolved = 'fail';
      this.storyActiveId = null;
    }
    this.bus.emit('mission:fail', {
      id: special.id,
      reason: override ?? special.failCrash ?? special.failTimeout,
    });
  }

  /** Decide whether the next fare on the street is special, or a cart chase. */
  private queueNextEvent(): void {
    if (!this.pendingSpecial && this.sinceSpecial >= MISSION_TUNING.specialEvery) {
      this.sinceSpecial = 0;
      const def = this.storyMode ? this.pickStoryMission() : this.rollSideMission();
      if (def) {
        this.pendingSpecial = def;
        if (def.story) this.storyActiveId = def.id;
      }
    }
    if (!this.cart && this.sinceCart >= MISSION_TUNING.cartEvery) {
      this.sinceCart = 0;
      this.startCartChase();
    }
  }

  /** The campaign's choice if it has one, else the flat catalog order. */
  private pickStoryMission(): SpecialMissionDef | null {
    const wanted = this.storyOverrideId;
    if (wanted) {
      const def = ALL_MISSIONS.find((m) => m.id === wanted);
      if (def) return def;
    }
    return nextStoryMission(this.completed);
  }

  /**
   * Roll one eligible side job. Filtering by clock, weather, rank and the
   * regions the world actually built means a 2 a.m. shift in a downpour offers
   * genuinely different work than a Tuesday morning — and never offers a job
   * whose destination does not exist.
   */
  private rollSideMission(): SpecialMissionDef | null {
    const pool = this.rollPool;
    const weights = this.rollWeights;
    pool.length = 0;
    weights.length = 0;

    const ctx = this.syncMissionCtx();
    const eligible = eligibleSideMissions(ctx);
    for (const def of eligible) {
      /* stop re-offering the same job inside one shift while others are unseen */
      const seen = this.completed.has(def.id) ? 0.35 : 1;
      pool.push(def);
      weights.push((def.weight ?? 1) * seen);
    }
    if (pool.length === 0) {
      /* nothing gated in right now — fall back to the always-on core four */
      return SIDE_MISSIONS.length > 0 ? this.rng.pick(SIDE_MISSIONS) : null;
    }
    return this.rng.weighted(pool, weights);
  }

  /** Force a specific mission to be the next fare. Returns false if busy. */
  forceSpecialMission(id?: string): boolean {
    if (this.pendingSpecial) return false;
    const def = id ? ALL_MISSIONS.find((m) => m.id === id) : this.rollSideMission();
    if (!def) return false;
    this.pendingSpecial = def;
    if (def.story) this.storyActiveId = def.id;
    /* make room so the special fare appears promptly */
    if (this.waiting.length >= this.maxWaiting) {
      const victim = this.waiting[0];
      this.retire(0, victim);
    }
    this.spawnTimer = 0;
    return true;
  }

  /**
   * Which encargo the campaign wants next. Set by `StoryRun` from
   * `StoryCampaign`; null falls back to the flat catalog order, which is what
   * an old save or a bare `MissionSystem` gets.
   */
  setStoryOverride(id: string | null): void {
    this.storyOverrideId = id;
  }

  /** Queue the next unplayed encargo. Returns its id, or null when done. */
  queueStoryMission(explicitId?: string | null): string | null {
    const wanted = explicitId ?? this.storyOverrideId;
    const def = wanted
      ? (ALL_MISSIONS.find((m) => m.id === wanted) ?? nextStoryMission(this.completed))
      : nextStoryMission(this.completed);
    if (!def) return null;
    if (this.pendingSpecial === def || this.storyActiveId === def.id) return def.id;
    this.pendingSpecial = def;
    this.storyActiveId = def.id;
    this.storyResolved = null;
    if (this.waiting.length >= this.maxWaiting) this.retire(0, this.waiting[0]);
    this.spawnTimer = 0;
    return def.id;
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

    /*
     * Signature-route adherence. On El Torro the wall road *is* the mission:
     * running it clean pays style money every 150 m, and a job with an
     * `offRouteLimit` (the storm run, where the low streets are flooded) fails
     * outright if you drop off it for too long.
     */
    const route = a.route;
    if (route) {
      const def = a.special;
      const radius = def?.offRouteRadius ?? MISSION_TUNING.offRouteRadius;
      const d = route.distanceTo(pos.x, pos.z);
      const step = Math.max(0, a.ride.driven - a.lastSampleDriven);
      a.lastSampleDriven = a.ride.driven;

      if (d <= radius) {
        a.offRouteTimer = Math.max(0, a.offRouteTimer - 0.4);
        a.routeMetres += step;
        while (a.routeMetres >= MISSION_TUNING.routeStride) {
          a.routeMetres -= MISSION_TUNING.routeStride;
          this.combo?.add('¡POR LA MURALLA!', MISSION_TUNING.routePoints);
        }
      } else {
        a.routeMetres = 0;
        a.offRouteTimer += 0.2;
        const limit = def?.offRouteLimit;
        if (limit !== undefined && limit > 0 && a.offRouteTimer >= limit) {
          this.failFare('timeout', def?.failOffRoute);
          return;
        }
        /* one nudge at the halfway mark, so the fail is never a surprise */
        if (limit !== undefined && limit > 0 && Math.abs(a.offRouteTimer - limit * 0.5) < 0.11) {
          this.bus.emit('ui:toast', { text: '¡Vuelve a la muralla!', icon: 'warn', ms: 2000 });
        }
      }
    }

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
      /*
       * A hit budget is the middle setting between "one bump ends it" and
       * "nothing matters": the generator survives two, the storm run four.
       */
      if (heavy && a.special) {
        a.heavyHits++;
        const limit = a.special.heavyHitLimit;
        if (limit !== undefined && limit > 0) {
          if (a.heavyHits > limit) {
            this.failMissionByCrash(a.special.failHits);
            return;
          }
          this.bus.emit('ui:toast', {
            text: `Golpe ${a.heavyHits} / ${limit}`,
            icon: 'warn',
            ms: 2000,
          });
        }
      }
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

    on('weather:changed', (p) => {
      this.weather = p.kind;
    });
  }
}

/** Shared empty visited-list so the first leg allocates nothing. */
const EMPTY_VISITED: readonly string[] = [];

/** What a stop is called on this job — "PARADA" unless the writer said otherwise. */
function legNounFor(def: SpecialMissionDef | null): string {
  return def?.legNoun ?? 'PARADA';
}

/**
 * How many stops the run actually has. A routed job is capped by the waypoints
 * the world could resolve, so a build missing half the garitas runs a shorter
 * wall instead of stalling on a stop that does not exist.
 */
function legCountFor(def: SpecialMissionDef | null, waypoints: number): number {
  const authored = def && def.legs && def.legs > 1 ? Math.floor(def.legs) : 1;
  const capped = Math.min(MISSION_TUNING.maxLegs, authored);
  if (waypoints > 0) return Math.max(1, Math.min(capped, waypoints));
  return Math.max(1, capped);
}

/**
 * Which waiting fare, if any, is carrying a special mission. Kept out of
 * `Passenger` so that class stays about people, not scheduling.
 */
const SPECIAL_BY_PASSENGER = new WeakMap<Passenger, SpecialMissionDef>();
