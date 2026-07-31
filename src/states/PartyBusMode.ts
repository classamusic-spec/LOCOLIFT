/**
 * Loco Lift — el Chinchorreo.
 *
 * The second vehicle plays a completely different game. The Jeep's loop is
 * *one fare at a time*: pick up, deliver, bank, repeat. The bus's loop is
 * **collect, then deliver** — ten people, scattered from the casco viejo out
 * along the coast to Piñones, all of whom have to be on board before the club
 * will let you in.
 *
 * That single change flips every incentive:
 *
 *  - **Load is the risk/reward curve.** Every person aboard makes the bus
 *    heavier and vaguer to drive (`massMultiplier` / `handlingScale`, which the
 *    vehicle reads) *and* multiplies everything the crowd is worth. A full bus
 *    is the biggest scoring object in the game and the worst-handling one.
 *  - **The crowd is a meter.** Drifts, jumps, air and near misses raise *hype*;
 *    crashes and crawling drop it. Let hype bottom out and people start getting
 *    off — at a bus stop if you are lucky, in the middle of the road if you are
 *    not. That is the soft-fail, and it costs you the multiplier you built.
 *  - **The last leg is a climax.** The tenth person aboard closes the collection
 *    phase, resets the clock to the club's closing time and pins the music at
 *    full. You now have the heaviest, loosest, loudest vehicle in the game and
 *    one long run to make the door.
 *
 * Everything the HUD needs is expressed through the existing event surface: the
 * passenger card is re-pointed at a `_busN` pseudo-archetype whose name *is* the
 * "aboard / collected" readout, the patience bar is driven with crowd hype, the
 * minimap gets the remaining stops as waiting-fare markers, and the destination
 * arrow follows the same `passenger:pickup` path every other fare uses.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type {
  EventKey,
  EventMap,
  FareResult,
  GameMode,
  PassengerArchetype,
  POI,
  QualityTier,
  RoadGraph,
} from '../core/types';
import { pickPartyArchetype, VARIANTS_PER_ARCHETYPE } from '../passengers/Archetypes';
import { DialogueDirector } from '../passengers/Dialogue';
import { bucketByRegion, type MapRegion } from '../passengers/MissionCatalog';
import { Passenger } from '../passengers/Passenger';
import { BeaconPool, PassengerModelPool } from '../passengers/PassengerModel';
import type { ShiftController } from './ArcadeShift';

/* ------------------------------------------------------ structural inputs */

/** The slice of the city the chinchorreo reads. Structurally a `WorldAPI`. */
export interface PartyWorld {
  root: THREE.Object3D;
  pois: ReadonlyArray<POI>;
  groundHeight(x: number, z: number): number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  isBlocked?(x: number, z: number): boolean;
  poiById?(id: string): POI | undefined;
  /** used to nudge each stop toward the kerb so the bus can actually reach it */
  roads?: RoadGraph;
}

/**
 * The slice of the party bus this mode drives. Duck-typed — nothing under
 * `src/vehicle` is imported. `setPassengerLoad` is optional: implement it on
 * the bus and the mass/handling curve becomes real, omit it and the mode still
 * runs (the curve then only affects scoring).
 */
export interface PartyVehicle {
  readonly object3d: THREE.Object3D;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly speed: number;
  readonly forwardSpeed: number;
  readonly isAirborne: boolean;
  /** roster id; the mode warns when it is handed something that is not `'bus'` */
  readonly vehicleId?: string;
  addBoost(amount: number): void;
  setSeatVisual(occupied: boolean, archetypeId?: string): void;
  /** how many people are aboard, and what that does to the physics */
  setPassengerLoad?(count: number, massMultiplier: number, handlingScale: number): void;
}

/** What the mode needs from the combo chain. */
export interface PartyComboFeed {
  readonly pointsBanked: number;
  readonly multiplier: number;
  readonly peakMultiplier: number;
  add(label: string, basePoints: number, at?: THREE.Vector3): void;
}

/** Where a rider sits, in the bus's local space. */
export interface SeatAnchor {
  x: number;
  y: number;
  z: number;
}

export interface PartyBusModeOptions {
  bus: EventBus;
  world: PartyWorld;
  vehicle: PartyVehicle;
  scene?: THREE.Object3D | null;
  combo?: PartyComboFeed | null;
  rng?: RNG;
  quality?: QualityTier;
  /** share the mission system's pools so figure geometry is cached once */
  models?: PassengerModelPool | null;
  beacons?: BeaconPool | null;
  /** how many people the crawl collects; 10 unless the world is tiny */
  capacity?: number;
  /** seconds to collect everybody */
  collectSeconds?: number;
  /** seconds on the clock the moment the last person boards */
  clubSeconds?: number;
  /** seat anchors in bus-local space; a default 5×2 school-bus layout is used */
  seats?: readonly SeatAnchor[];
  /** what `GameMode` the run reports; see the note on `mode` below */
  mode?: GameMode;
}

/* ---------------------------------------------------------------- tuning */

export const PARTY = {
  capacity: 10,
  collectSeconds: 260,
  clubSeconds: 78,

  /** metres — the bus is enormous, so the pickup box is too */
  boardRadius: 9,
  /** m/s — roll past slower than this and they can jump aboard */
  boardSpeed: 12.5,
  /** metres — a full stop this close always works */
  boardSnapRadius: 4.5,
  /** metres — figures exist only this close to the bus */
  figureRadius: 300,
  /** how many stop figures may be built at once */
  maxLiveFigures: 4,

  /** the club door */
  clubRadius: 22,
  clubSpeed: 14,

  /* --- crowd -------------------------------------------------------------- */
  /** hype the crowd boards at */
  hypeStart: 0.55,
  /** hype relaxes toward this when nothing is happening */
  hypeRest: 0.42,
  hypeRelax: 0.07,
  /** hype gained per stylish beat, scaled by how full the bus is */
  hypeDrift: 0.11,
  hypeJump: 0.17,
  hypeTrick: 0.2,
  hypeNearMiss: 0.09,
  hypeBoost: 0.06,
  hypeTwoWheels: 0.13,
  hypeBoard: 0.22,
  /** hype lost per crash, scaled by impulse */
  hypeCrash: 0.19,
  hypeHeavyCrash: 0.34,
  /** m/s under which the party notices the bus is not going anywhere */
  crawlSpeed: 4.5,
  crawlGrace: 4,
  hypeCrawl: 0.045,

  /** below this the crowd starts wanting off */
  panicThreshold: 0.2,
  /** seconds at rock bottom before somebody actually gets off (at 1 aboard) */
  panicSeconds: 5.5,
  /** a big crowd is harder to hold: panic builds this much faster when full */
  panicCrowdScale: 0.6,
  /** an impulse this hard with the crowd already sour throws somebody off */
  bailImpulse: 3400,
  /** lose this many and the crawl is over */
  maxLost: 5,

  /* --- physics coupling --------------------------------------------------- */
  /** mass multiplier added per person aboard */
  massPerPassenger: 0.055,
  /** grip/steer authority lost per person aboard */
  handlingPerPassenger: 0.032,

  /* --- payout ------------------------------------------------------------- */
  boardPoints: 110,
  /** style money for a stylish beat, per person aboard */
  crowdPointsPerHead: 7,
  /** minimum aboard count for the crowd to amplify anything at all */
  crowdMinAboard: 3,
  /** seconds of clock each stop buys back */
  boardTime: 16,
  /** cash per person delivered to the club */
  cashPerHead: 300,
  /** cash the crowd's mood is worth at the door */
  cashHype: 1100,
  /** cash per second left on the club clock */
  cashPerSecond: 22,
  /** cash lost per person who got off early */
  cashPerLost: 240,
  /** boost handed back on each board — the bus needs help getting moving */
  boostPerBoard: 0.34,
} as const;

/* --------------------------------------------------------- HUD stand-ins */

/**
 * One pseudo-archetype per aboard count. The HUD's passenger card renders
 * `name` and `blurb`, so `A BORDO 4 / 10` *is* the readout — no new UI surface
 * is needed. Register these with `ui.setArchetypes` alongside the real cast.
 */
function buildHudArchetypes(capacity: number): PassengerArchetype[] {
  const out: PassengerArchetype[] = [];
  for (let n = 0; n <= capacity; n++) {
    const t = capacity > 0 ? n / capacity : 0;
    /* lime green at empty → hot pink at full: the bus's own colours */
    const r = Math.round(0x8b + (0xff - 0x8b) * t);
    const g = Math.round(0xc3 + (0x2f - 0xc3) * t);
    const b = Math.round(0x4a + (0xa8 - 0x4a) * t);
    out.push({
      id: `_bus${n}`,
      name: `A BORDO ${n} / ${capacity}`,
      blurb:
        n === 0
          ? 'La guagua está vacía. Primera parada: busca al corillo.'
          : n >= capacity
            ? '¡Guagua llena! A la discoteca, y que no se caiga nadie.'
            : `${n} arriba, ${capacity - n} esperando. Métele.`,
      patience: 60,
      fareMultiplier: 1,
      thrillSeeking: 0.8,
      color: (r << 16) | (g << 8) | b,
      voicePitch: 1,
    });
  }
  return out;
}

export const PARTY_HUD_ARCHETYPES: readonly PassengerArchetype[] = buildHudArchetypes(PARTY.capacity);

/** The club itself, so the destination card reads properly on the final leg. */
export const CLUB_ARCHETYPE: PassengerArchetype = {
  id: '_club',
  name: '¡A LA DISCOTECA!',
  blurb: 'Cierran la puerta pronto. Guagua llena, pie a fondo, no pares.',
  patience: 60,
  fareMultiplier: 1,
  thrillSeeking: 1,
  color: 0xff2fa8,
  voicePitch: 1,
};

/** Everything the director should hand to `ui.setArchetypes` for this mode. */
export const PARTY_ARCHETYPES: readonly PassengerArchetype[] = [
  ...PARTY_HUD_ARCHETYPES,
  CLUB_ARCHETYPE,
];

/* --------------------------------------------------------- internal types */

export type PartyPhase = 'idle' | 'collect' | 'club' | 'over';

type StopState = 'pending' | 'aboard' | 'lost';

interface PartyStop {
  poi: POI;
  region: MapRegion;
  archetype: PassengerArchetype;
  variant: number;
  /** where the person actually stands — nudged off the POI toward the kerb */
  x: number;
  y: number;
  z: number;
  faceX: number;
  faceZ: number;
  state: StopState;
  /** live figure while the bus is near, else null */
  figure: Passenger | null;
}

interface Rider {
  passenger: Passenger;
  seat: number;
}

export interface PartyMarker {
  x: number;
  z: number;
}

/** Default 5-row, 2-column school-bus seating in the vehicle's local space. */
const DEFAULT_SEATS: readonly SeatAnchor[] = [
  { x: -0.74, y: 0.58, z: -1.9 },
  { x: 0.74, y: 0.58, z: -1.9 },
  { x: -0.74, y: 0.58, z: -0.6 },
  { x: 0.74, y: 0.58, z: -0.6 },
  { x: -0.74, y: 0.58, z: 0.7 },
  { x: 0.74, y: 0.58, z: 0.7 },
  { x: -0.74, y: 0.58, z: 2.0 },
  { x: 0.74, y: 0.58, z: 2.0 },
  { x: -0.74, y: 0.58, z: 3.3 },
  { x: 0.74, y: 0.58, z: 3.3 },
];

/* ------------------------------------------------------------------ class */

/**
 * Deliberately *not* an engine `System`: its `update` takes `(dt)` like every
 * other `ShiftController`, and the director is what ticks it. Registering it on
 * the engine would hand `GameContext` in as `dt`.
 */
export class PartyBusMode implements ShiftController {
  readonly name = 'chinchorreo';

  /**
   * `GameMode` lives in `src/core/types.ts` and has no `'party'` member, so the
   * run reports as `'story'` by default purely so the HUD and results screen
   * have a label. Pass `mode` to override. See the report: adding `'party'` to
   * the union is a one-line change that makes this honest.
   */
  readonly mode: GameMode;
  readonly timed = true;

  /** Called whenever the load changes, for anything that is not the vehicle. */
  onLoadChanged: ((count: number, massMultiplier: number, handlingScale: number) => void) | null =
    null;

  private readonly bus: EventBus;
  private readonly world: PartyWorld;
  private readonly vehicle: PartyVehicle;
  private readonly scene: THREE.Object3D;
  private readonly rng: RNG;
  private combo: PartyComboFeed | null;

  private readonly models: PassengerModelPool;
  private readonly ownsModels: boolean;
  private readonly beacons: BeaconPool;
  private readonly ownsBeacons: boolean;
  private readonly dialogue: DialogueDirector;

  private readonly capacity: number;
  private readonly collectSeconds: number;
  private readonly clubSeconds: number;

  private readonly group = new THREE.Group();
  private readonly mounts: THREE.Object3D[] = [];
  private readonly seats: readonly SeatAnchor[];

  private readonly stops: PartyStop[] = [];
  private readonly riders: Rider[] = [];
  private club: POI | null = null;

  private phase: PartyPhase = 'idle';
  private left = 0;
  private phaseSpan = 1;
  private running = false;
  private ended = false;
  private succeeded = false;

  private aboard = 0;
  private lost = 0;
  private hype: number = PARTY.hypeStart;
  private panic = 0;
  private crawlTimer = 0;
  private elapsed = 0;
  private comboAtStart = 0;
  private comboPeak = 1;
  private lastMusic = -1;
  private musicTimer = 0;
  private targetStop: PartyStop | null = null;
  private nextId = 1;
  private figureTimer = 0;
  private lastHudCount = -1;
  private result: FareResult | null = null;

  /** reused marker objects — rebuilt every frame, never reallocated */
  private readonly markerPool: PartyMarker[] = [];
  private readonly markers: PartyMarker[] = [];

  /* scratch — the update path allocates nothing */
  private readonly vTmp = new THREE.Vector3();
  private readonly moodPayload = { archetypeId: '', mood: 'happy' as EventMap['passenger:mood']['mood'] };
  private readonly musicPayload = { intensity: 0 };

  private readonly unsubs: Array<() => void> = [];

  constructor(opts: PartyBusModeOptions) {
    this.bus = opts.bus;
    this.world = opts.world;
    this.vehicle = opts.vehicle;
    this.scene = opts.scene ?? opts.world.root;
    this.combo = opts.combo ?? null;
    this.rng = opts.rng ?? new RNG(0x10c0_b115);
    this.mode = opts.mode ?? 'story';

    this.capacity = Math.max(1, Math.floor(opts.capacity ?? PARTY.capacity));
    this.collectSeconds = Math.max(30, opts.collectSeconds ?? PARTY.collectSeconds);
    this.clubSeconds = Math.max(15, opts.clubSeconds ?? PARTY.clubSeconds);
    this.seats = opts.seats && opts.seats.length > 0 ? opts.seats : DEFAULT_SEATS;

    this.models = opts.models ?? new PassengerModelPool({ quality: opts.quality ?? 'high' });
    this.ownsModels = !opts.models;
    this.beacons = opts.beacons ?? new BeaconPool();
    this.ownsBeacons = !opts.beacons;
    this.dialogue = new DialogueDirector({ bus: this.bus, rng: this.rng.fork(0xb115) });

    this.group.name = 'chinchorreo';
    this.scene.add(this.group);

    for (let i = 0; i < this.capacity; i++) {
      const anchor = this.seats[i % this.seats.length];
      const mount = new THREE.Object3D();
      mount.position.set(anchor.x, anchor.y, anchor.z);
      this.vehicle.object3d.add(mount);
      this.mounts.push(mount);
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  init(): void {
    this.subscribe();
  }

  setCombo(c: PartyComboFeed | null): void {
    this.combo = c;
  }

  /** Hand over the real bus seat anchors once the bus model exists. */
  setSeatLayout(seats: readonly SeatAnchor[]): void {
    if (seats.length === 0) return;
    for (let i = 0; i < this.mounts.length; i++) {
      const a = seats[i % seats.length];
      this.mounts[i].position.set(a.x, a.y, a.z);
    }
  }

  onQualityChange(tier: QualityTier): void {
    if (this.ownsModels) this.models.onQualityChange(tier);
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.clearWorld();
    for (const m of this.mounts) m.removeFromParent();
    this.mounts.length = 0;
    this.group.removeFromParent();
    if (this.ownsModels) this.models.dispose();
    if (this.ownsBeacons) this.beacons.dispose();
  }

  /* ----------------------------------------------------------- inspection */

  get timeRemaining(): number {
    return Math.max(0, this.left);
  }

  get finished(): boolean {
    return this.ended;
  }

  get succeededFlag(): boolean {
    return this.succeeded;
  }

  get currentPhase(): PartyPhase {
    return this.phase;
  }

  /** How many people are on the bus right now. */
  get aboardCount(): number {
    return this.aboard;
  }

  /** How many stops have been resolved one way or the other. */
  get collectedCount(): number {
    return this.aboard + this.lost;
  }

  get lostCount(): number {
    return this.lost;
  }

  get stopCount(): number {
    return this.stops.length;
  }

  /** 0..1 — how full the bus is. The whole risk/reward curve keys off this. */
  get loadFactor(): number {
    return this.capacity > 0 ? clamp01(this.aboard / this.capacity) : 0;
  }

  /** What the bus should multiply its mass by right now. */
  get massMultiplier(): number {
    return 1 + this.aboard * PARTY.massPerPassenger;
  }

  /** 1 = empty-bus handling, falling toward ~0.68 with a full load. */
  get handlingScale(): number {
    return clamp(1 - this.aboard * PARTY.handlingPerPassenger, 0.4, 1);
  }

  /** 0..1 crowd mood. Drives the HUD patience bar and the final tip. */
  get crowdHype(): number {
    return clamp01(this.hype);
  }

  /** Combo multiplier the crowd is worth on top of the chain. */
  get crowdMultiplier(): number {
    return 1 + this.loadFactor * 1.5 + this.crowdHype * 0.5;
  }

  /** The club, once collection is over. Null while still collecting. */
  get clubDestination(): POI | null {
    return this.phase === 'club' ? this.club : null;
  }

  /** The stop the arrow is pointing at, or null. */
  get currentStop(): POI | null {
    return this.targetStop ? this.targetStop.poi : null;
  }

  /** Minimap markers: every stop still waiting, plus the club on the last leg. */
  get stopMarkers(): ReadonlyArray<PartyMarker> {
    return this.markers;
  }

  /** The payout, once the run is over. */
  get lastResult(): FareResult | null {
    return this.result;
  }

  /* ----------------------------------------------------------------- start */

  start(): void {
    this.clearWorld();
    this.phase = 'collect';
    this.left = this.collectSeconds;
    this.phaseSpan = this.collectSeconds;
    this.running = false;
    this.ended = false;
    this.succeeded = false;
    this.aboard = 0;
    this.lost = 0;
    this.hype = PARTY.hypeStart;
    this.panic = 0;
    this.crawlTimer = 0;
    this.elapsed = 0;
    this.comboPeak = 1;
    this.comboAtStart = this.combo ? this.combo.pointsBanked : 0;
    this.lastMusic = -1;
    this.musicTimer = 0;
    this.lastHudCount = -1;
    this.result = null;
    this.dialogue.reset(0);

    this.buildRoute();
    this.vehicle.setSeatVisual(false);
    this.pushLoad();

    this.bus.emit('shift:start', { mode: this.mode, duration: this.collectSeconds });
    this.bus.emit('mission:start', {
      id: 'chinchorreo',
      title: 'CHINCHORREO',
      objective: `Recoge a ${this.stops.length} en el casco, la costa y Piñones. Después, a la discoteca.`,
    });
    this.retarget(true);
    this.emitMusic(true);
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  /* ----------------------------------------------------------------- route */

  /**
   * Build the crawl. A chinchorreo is an itinerary, not a scatter: it starts in
   * the old town, works out along the coast and finishes in Piñones, then turns
   * around and runs the whole thing back to the club. The route degrades
   * cleanly — a world with no Piñones simply gets a longer coastal leg.
   */
  private buildRoute(): void {
    this.stops.length = 0;
    this.club = null;
    this.targetStop = null;

    const pois = this.world.pois;
    if (pois.length === 0) return;

    const buckets = bucketByRegion(pois, this.world.bounds);
    /* the club is a venue as deep in the old town as we can find one */
    this.club = this.pickClub(buckets);

    const order: MapRegion[] = ['oldTown', 'coast', 'pinones'];
    const wanted: Record<MapRegion, number> = { oldTown: 0, coast: 0, pinones: 0 };
    const present = order.filter((r) => buckets[r].some((p) => p !== this.club));
    if (present.length === 0) return;

    /* split the crawl across whatever regions exist, favouring the far ones */
    const share = Math.floor(this.capacity / present.length);
    let leftover = this.capacity - share * present.length;
    for (let i = present.length - 1; i >= 0; i--) {
      wanted[present[i]] = share + (leftover > 0 ? 1 : 0);
      if (leftover > 0) leftover--;
    }

    const used = new Set<string>();
    if (this.club) used.add(this.club.id);
    const taken = new Set<string>();

    for (const region of order) {
      const pool = buckets[region].filter((p) => !used.has(p.id));
      if (pool.length === 0) continue;
      this.rng.shuffle(pool);
      /* order within a region by a greedy walk so the leg is a route, not a zigzag */
      const chosen = this.greedyChain(pool, Math.min(wanted[region], pool.length));
      for (const poi of chosen) {
        if (this.stops.length >= this.capacity) break;
        used.add(poi.id);
        this.pushStop(poi, region, taken);
      }
    }

    /* top up from anywhere if a region came up short */
    if (this.stops.length < this.capacity) {
      for (const poi of pois) {
        if (this.stops.length >= this.capacity) break;
        if (used.has(poi.id)) continue;
        used.add(poi.id);
        this.pushStop(poi, 'oldTown', taken);
      }
    }
  }

  private pickClub(buckets: Record<MapRegion, POI[]>): POI | null {
    const prefer: MapRegion[] = ['oldTown', 'coast', 'pinones'];
    for (const kind of ['venue', 'rooftop', 'plaza'] as const) {
      for (const region of prefer) {
        for (const poi of buckets[region]) {
          if (poi.kind === kind) return poi;
        }
      }
    }
    const all = this.world.pois;
    return all.length > 0 ? all[0] : null;
  }

  /** Nearest-neighbour walk from the bus, so each leg reads as a real route. */
  private greedyChain(pool: POI[], count: number): POI[] {
    const out: POI[] = [];
    if (count <= 0) return out;
    let fromX = this.vehicle.position.x;
    let fromZ = this.vehicle.position.z;
    const remaining = pool.slice();
    while (out.length < count && remaining.length > 0) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d =
          (remaining[i].pos.x - fromX) ** 2 + (remaining[i].pos.z - fromZ) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      const poi = remaining.splice(best, 1)[0];
      out.push(poi);
      fromX = poi.pos.x;
      fromZ = poi.pos.z;
    }
    return out;
  }

  private pushStop(poi: POI, region: MapRegion, taken: Set<string>): void {
    const archetype = pickPartyArchetype(this.rng, taken);
    if (!archetype) return;
    taken.add(archetype.id);

    /* stand them between the venue and the nearest kerb so the bus can reach */
    let x = poi.pos.x;
    let z = poi.pos.z;
    let faceX = poi.pos.x;
    let faceZ = poi.pos.z;
    const roads = this.world.roads;
    if (roads) {
      this.vTmp.set(poi.pos.x, poi.pos.y, poi.pos.z);
      const s = roads.nearest(this.vTmp, 90);
      if (s) {
        const dx = s.point.x - poi.pos.x;
        const dz = s.point.z - poi.pos.z;
        const len = Math.hypot(dx, dz);
        if (len > 1) {
          const t = clamp01((len - 4.5) / len);
          x = poi.pos.x + dx * t;
          z = poi.pos.z + dz * t;
        }
        faceX = s.point.x;
        faceZ = s.point.z;
      }
    }
    const y = this.world.groundHeight(x, z);

    this.stops.push({
      poi,
      region,
      archetype,
      variant: this.rng.int(0, VARIANTS_PER_ARCHETYPE - 1),
      x,
      y: Number.isFinite(y) ? y : poi.pos.y,
      z,
      faceX,
      faceZ,
      state: 'pending',
      figure: null,
    });
  }

  /* ----------------------------------------------------------------- frame */

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.elapsed += dt;
    this.left -= dt;

    const speed = this.vehicle.speed;

    this.tickCrowd(dt, speed);
    this.tickFigures(dt);

    if (this.phase === 'collect') this.tickCollect(speed);
    else if (this.phase === 'club') this.tickClub(speed);

    this.rebuildMarkers();
    this.emitMusic(false);

    if (this.left <= 0 && !this.ended) {
      this.left = 0;
      this.finish(false, this.phase === 'club' ? 'club' : 'collect');
    }
  }

  /** `System.update` so the mode can also be registered on the engine directly. */
  private tickCollect(speed: number): void {
    const bx = this.vehicle.position.x;
    const bz = this.vehicle.position.z;
    const airborne = this.vehicle.isAirborne;

    for (let i = 0; i < this.stops.length; i++) {
      const stop = this.stops[i];
      if (stop.state !== 'pending') continue;
      const d = Math.hypot(stop.x - bx, stop.z - bz);
      if (d > PARTY.boardRadius) continue;
      if (airborne) continue;
      if (d > PARTY.boardSnapRadius && speed > PARTY.boardSpeed) continue;
      this.board(stop);
      /* one boarding per frame keeps the beats readable and the audio clean */
      break;
    }
  }

  private tickClub(speed: number): void {
    const club = this.club;
    if (!club) {
      this.finish(true, 'club');
      return;
    }
    const d = Math.hypot(club.pos.x - this.vehicle.position.x, club.pos.z - this.vehicle.position.z);
    const radius = Math.max(PARTY.clubRadius, club.radius);
    if (d <= radius && speed <= PARTY.clubSpeed && !this.vehicle.isAirborne) {
      this.finish(true, 'club');
    }
  }

  /* ---------------------------------------------------------------- crowd */

  private tickCrowd(dt: number, speed: number): void {
    /* mood always creeps back toward "having an alright time" */
    const rest = PARTY.hypeRest;
    const relax = PARTY.hypeRelax * dt;
    if (this.hype > rest + relax) this.hype -= relax;
    else if (this.hype < rest - relax) this.hype += relax;
    else this.hype = rest;

    /* a party bus that is not moving is just a bus */
    if (this.aboard > 0 && speed < PARTY.crawlSpeed) {
      this.crawlTimer += dt;
      if (this.crawlTimer > PARTY.crawlGrace) {
        this.hype = clamp01(this.hype - PARTY.hypeCrawl * dt);
      }
    } else {
      this.crawlTimer = 0;
    }

    for (let i = 0; i < this.riders.length; i++) {
      this.riders[i].passenger.updateRiding(dt, speed);
    }

    /* people only start leaving once the crowd has actually soured */
    if (this.aboard > 0 && this.hype < PARTY.panicThreshold) {
      const depth = clamp01((PARTY.panicThreshold - this.hype) / PARTY.panicThreshold);
      const crowd = 1 + this.loadFactor * PARTY.panicCrowdScale;
      this.panic += (dt / PARTY.panicSeconds) * depth * crowd;
      if (this.panic >= 1) {
        this.panic = 0.25;
        this.scareOff('mood');
      }
    } else {
      this.panic = Math.max(0, this.panic - dt * 0.6);
    }

    this.pushMood();
  }

  /** Feed the crowd one stylish beat. Returns the style money it was worth. */
  private hypeUp(amount: number, label: string, intensity: number): void {
    if (this.aboard <= 0) return;
    const scaled = amount * (0.55 + this.loadFactor * 0.9) * clamp(intensity, 0.2, 2.2);
    this.hype = clamp01(this.hype + scaled);

    for (let i = 0; i < this.riders.length; i++) {
      this.riders[i].passenger.react('drift', intensity * 0.6);
    }

    if (this.aboard >= PARTY.crowdMinAboard && this.combo) {
      const points = PARTY.crowdPointsPerHead * this.aboard * (0.6 + this.hype * 0.8);
      this.combo.add(label, points);
      if (this.combo.multiplier > this.comboPeak) this.comboPeak = this.combo.multiplier;
    }
  }

  private hypeDown(amount: number, intensity: number): void {
    if (this.aboard <= 0) return;
    this.hype = clamp01(this.hype - amount * clamp(intensity, 0.3, 2.2));
    for (let i = 0; i < this.riders.length; i++) {
      this.riders[i].passenger.react('crash', intensity);
    }
  }

  /* -------------------------------------------------------------- boarding */

  private board(stop: PartyStop): void {
    if (stop.state !== 'pending') return;
    const seat = this.aboard;
    const mount = this.mounts[Math.min(seat, this.mounts.length - 1)];

    let passenger = stop.figure;
    if (!passenger) {
      passenger = this.makeFigure(stop, false);
    }
    passenger.board(mount);
    stop.figure = null;
    stop.state = 'aboard';
    this.riders.push({ passenger, seat });
    this.aboard++;

    this.hype = clamp01(this.hype + PARTY.hypeBoard);
    this.panic = 0;

    this.vehicle.addBoost(PARTY.boostPerBoard);
    this.pushLoad();

    const remaining = this.stops.length - this.collectedCount;
    this.combo?.add(
      remaining === 0 ? '¡GUAGUA LLENA!' : `¡SE MONTÓ ${stop.archetype.name.toUpperCase()}!`,
      PARTY.boardPoints * (1 + this.loadFactor),
    );
    if (this.combo && this.combo.multiplier > this.comboPeak) this.comboPeak = this.combo.multiplier;

    this.bus.emit('audio:sfx', { id: 'pickup', volume: 0.9 });
    this.bus.emit('audio:sfx', { id: 'crowdCheer', volume: 0.4 + this.loadFactor * 0.5 });
    this.bus.emit('shift:timeAdded', {
      seconds: PARTY.boardTime,
      reason: `${stop.archetype.name} se montó`,
    });
    this.dialogue.onBoard(this.elapsed);
    this.dialogue.say(stop.archetype.id, 'pickup', 'thrilled', this.elapsed, true);

    if (remaining <= 0) this.beginClubRun();
    else this.retarget(true);
    this.emitMusic(true);
  }

  /**
   * The climax. Collection is over, the clock is replaced with the club's
   * closing time and the HUD is re-synced to it — `shift:timeWarning` is the
   * one event that sets the dial absolutely, and "the club shuts in 78 seconds"
   * is exactly the moment it exists for.
   */
  private beginClubRun(): void {
    this.phase = 'club';
    this.left = this.clubSeconds;
    this.phaseSpan = this.clubSeconds;

    const club = this.club;
    this.bus.emit('ui:notice', { text: '¡GUAGUA LLENA! ¡A LA DISCOTECA!', big: true });
    this.bus.emit('shift:timeWarning', { remaining: this.clubSeconds });
    this.bus.emit('audio:sfx', { id: 'boostStart', volume: 0.9 });
    this.bus.emit('mission:start', {
      id: 'chinchorreo-club',
      title: 'CIERRAN LA PUERTA',
      objective: club
        ? `${club.name}. Con todo el mundo arriba y sin frenar.`
        : 'A la discoteca, con todo el mundo arriba.',
    });
    if (club) {
      this.bus.emit('passenger:pickup', {
        archetypeId: CLUB_ARCHETYPE.id,
        destinationId: club.id,
        fareEstimate: this.estimatePayout(),
      });
    }
    this.targetStop = null;
    this.vehicle.addBoost(1);
  }

  /** Point the HUD card, the arrow and the minimap at the next stop. */
  private retarget(announce: boolean): void {
    if (this.phase !== 'collect') return;
    let best: PartyStop | null = null;
    let bestD = Infinity;
    const bx = this.vehicle.position.x;
    const bz = this.vehicle.position.z;
    for (let i = 0; i < this.stops.length; i++) {
      const stop = this.stops[i];
      if (stop.state !== 'pending') continue;
      const d = (stop.x - bx) ** 2 + (stop.z - bz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = stop;
      }
    }
    this.targetStop = best;
    if (!announce) return;

    const count = Math.min(this.aboard, PARTY_HUD_ARCHETYPES.length - 1);
    if (count === this.lastHudCount && !best) return;
    this.lastHudCount = count;
    this.bus.emit('passenger:pickup', {
      archetypeId: `_bus${count}`,
      destinationId: best ? best.poi.id : (this.club ? this.club.id : ''),
      fareEstimate: this.estimatePayout(),
    });
  }

  /* ------------------------------------------------------------ scare-off */

  /** Somebody has had enough. Costs money, the multiplier and the music. */
  private scareOff(reason: 'mood' | 'crash'): void {
    if (this.aboard <= 0) return;
    /* whoever is least happy is the one who goes */
    let worst = 0;
    let worstComfort = Infinity;
    for (let i = 0; i < this.riders.length; i++) {
      const c = this.riders[i].passenger.comfortScore;
      if (c < worstComfort) {
        worstComfort = c;
        worst = i;
      }
    }
    const rider = this.riders.splice(worst, 1)[0];
    const archetype = rider.passenger.archetype;
    rider.passenger.markBailed();
    rider.passenger.despawn();

    this.aboard--;
    this.lost++;
    /* the ones left aboard are a bit relieved, which stops a death spiral */
    this.hype = clamp01(this.hype + 0.14);
    this.pushLoad();

    this.bus.emit('audio:sfx', { id: 'comboBreak', volume: 0.7 });
    this.bus.emit('ui:toast', {
      text:
        reason === 'crash'
          ? `${archetype.name} se bajó en marcha. Literalmente.`
          : `${archetype.name} se bajó. "Yo me busco un Uber."`,
      icon: 'warn',
      ms: 3000,
    });
    this.dialogue.say(archetype.id, 'timeout', 'furious', this.elapsed, true);

    if (this.lost >= PARTY.maxLost) {
      this.finish(false, 'empty');
      return;
    }
    /* everybody resolved (aboard + lost) still opens the club, with fewer heads */
    if (this.collectedCount >= this.stops.length && this.phase === 'collect') {
      if (this.aboard > 0) this.beginClubRun();
      else this.finish(false, 'empty');
      return;
    }
    this.retarget(true);
    this.emitMusic(true);
  }

  /* ---------------------------------------------------------------- figures */

  /** Build / release stop figures so only the ones near the bus exist. */
  private tickFigures(dt: number): void {
    this.figureTimer -= dt;
    const near = PARTY.figureRadius * PARTY.figureRadius;
    const bx = this.vehicle.position.x;
    const bz = this.vehicle.position.z;

    if (this.figureTimer <= 0) {
      this.figureTimer = 0.5;
      let live = 0;
      for (let i = 0; i < this.stops.length; i++) {
        const stop = this.stops[i];
        if (stop.state !== 'pending') continue;
        const d2 = (stop.x - bx) ** 2 + (stop.z - bz) ** 2;
        if (d2 <= near && live < PARTY.maxLiveFigures) {
          live++;
          if (!stop.figure) stop.figure = this.makeFigure(stop, true);
        } else if (stop.figure) {
          stop.figure.despawn();
          stop.figure = null;
        }
      }
    }

    for (let i = 0; i < this.stops.length; i++) {
      const fig = this.stops[i].figure;
      if (fig) fig.updateWaiting(dt, bx, bz);
    }
  }

  private makeFigure(stop: PartyStop, spawnVisual: boolean): Passenger {
    this.vTmp.set(stop.x, stop.y, stop.z);
    const p = new Passenger({
      id: this.nextId++,
      archetype: stop.archetype,
      variant: stop.variant,
      position: this.vTmp,
      faceX: stop.faceX,
      faceZ: stop.faceZ,
      models: this.models,
      beacons: this.beacons,
      /* the crawl's clock is the only clock — nobody times out individually */
      patienceScale: 40,
    });
    if (spawnVisual) p.spawn(this.group);
    return p;
  }

  /* --------------------------------------------------------------- output */

  private pushLoad(): void {
    const mass = this.massMultiplier;
    const handling = this.handlingScale;
    this.vehicle.setPassengerLoad?.(this.aboard, mass, handling);
    this.vehicle.setSeatVisual(this.aboard > 0);
    this.onLoadChanged?.(this.aboard, mass, handling);
  }

  /**
   * Music intensity climbs with the load and the crowd. `force` pushes it
   * immediately (a boarding, a loss); otherwise it is rate-limited so the audio
   * system is not asked to re-mix every frame.
   */
  private emitMusic(force: boolean): void {
    if (!force) {
      this.musicTimer -= 1 / 60;
      if (this.musicTimer > 0) return;
    }
    this.musicTimer = 0.4;
    const base = this.phase === 'club' ? 0.92 : 0.22 + this.loadFactor * 0.62;
    const intensity = clamp01(base + this.crowdHype * 0.12);
    if (!force && Math.abs(intensity - this.lastMusic) < 0.03) return;
    this.lastMusic = intensity;
    this.musicPayload.intensity = intensity;
    this.bus.emit('audio:music', this.musicPayload);
  }

  private pushMood(): void {
    const h = this.crowdHype;
    const mood: EventMap['passenger:mood']['mood'] =
      h > 0.78 ? 'thrilled' : h > 0.55 ? 'happy' : h > 0.32 ? 'calm' : h > 0.16 ? 'nervous' : 'furious';
    const id = this.phase === 'club' ? CLUB_ARCHETYPE.id : `_bus${Math.min(this.aboard, this.capacity)}`;
    if (this.moodPayload.mood === mood && this.moodPayload.archetypeId === id) return;
    this.moodPayload.mood = mood;
    this.moodPayload.archetypeId = id;
    this.bus.emit('passenger:mood', this.moodPayload);
  }

  private rebuildMarkers(): void {
    const m = this.markers;
    m.length = 0;
    if (this.phase === 'collect') {
      for (let i = 0; i < this.stops.length; i++) {
        if (this.stops[i].state !== 'pending') continue;
        this.pushMarker(this.stops[i].x, this.stops[i].z);
      }
    } else if (this.club) {
      this.pushMarker(this.club.pos.x, this.club.pos.z);
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

  /** What the HUD card shows as the run's running value. */
  private estimatePayout(): number {
    return Math.round(
      this.aboard * PARTY.cashPerHead +
        this.crowdHype * PARTY.cashHype * this.loadFactor +
        Math.max(0, this.left) * (this.phase === 'club' ? PARTY.cashPerSecond : 4),
    );
  }

  /** The HUD's patience bar shows crowd hype in this mode. */
  get patienceFraction(): number {
    if (this.phase === 'club') return this.phaseSpan > 0 ? clamp01(this.left / this.phaseSpan) : 0;
    return this.crowdHype;
  }

  /* --------------------------------------------------------------- ending */

  private finish(success: boolean, cause: 'collect' | 'club' | 'empty'): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.succeeded = success && this.aboard > 0;

    const comboPoints = this.combo
      ? Math.max(0, this.combo.pointsBanked - this.comboAtStart)
      : 0;

    if (this.succeeded) {
      const heads = this.aboard * PARTY.cashPerHead;
      const mood = this.crowdHype * PARTY.cashHype * this.loadFactor;
      const timeBonus = Math.max(0, this.left) * PARTY.cashPerSecond;
      const penalty = this.lost * PARTY.cashPerLost;
      const total = Math.max(0, Math.round(heads + mood + timeBonus - penalty));
      const rating = clamp(
        Math.round(
          (this.loadFactor * 0.5 + this.crowdHype * 0.28 + clamp01(this.left / this.clubSeconds) * 0.22) * 10,
        ) / 2,
        0,
        5,
      );
      this.result = {
        base: Math.round(heads),
        distanceBonus: 0,
        timeBonus: Math.round(timeBonus),
        comboBonus: Math.round(comboPoints),
        tip: Math.max(0, Math.round(mood - penalty)),
        total: total + Math.round(comboPoints),
        rating,
        grade:
          this.lost === 0
            ? '¡Llegaron todos, y de pie!'
            : `Llegaron ${this.aboard}. Los demás se fueron en Uber.`,
      };
      this.bus.emit('mission:complete', { id: 'chinchorreo', result: this.result });
      this.bus.emit('ui:notice', { text: '¡LLEGARON A LA DISCOTECA!', big: true });
      this.bus.emit('audio:sfx', { id: 'crowdCheer', volume: 1 });
    } else {
      this.result = {
        base: 0,
        distanceBonus: 0,
        timeBonus: 0,
        comboBonus: Math.round(comboPoints),
        tip: 0,
        total: 0,
        rating: 0,
        grade: 'Se acabó el chinchorreo',
      };
      this.bus.emit('mission:fail', {
        id: 'chinchorreo',
        reason:
          cause === 'empty'
            ? 'Se bajaron todos. La guagua llegó vacía.'
            : cause === 'club'
              ? 'Cerraron la discoteca. Los dejaste en la puerta.'
              : `Se acabó la noche con ${this.aboard} arriba y ${this.stops.length - this.collectedCount} esperando.`,
      });
    }

    /* the party is over — everybody off, and the bus goes back to being a bus */
    for (const rider of this.riders) {
      rider.passenger.markDelivered();
      rider.passenger.despawn();
    }
    this.riders.length = 0;
    this.aboard = 0;
    this.pushLoad();
    this.musicPayload.intensity = 0.25;
    this.bus.emit('audio:music', this.musicPayload);
    this.phase = 'over';
  }

  stop(): void {
    if (!this.ended) this.finish(false, this.phase === 'club' ? 'club' : 'collect');
    this.running = false;
    this.clearWorld();
  }

  private clearWorld(): void {
    for (const rider of this.riders) rider.passenger.despawn();
    this.riders.length = 0;
    for (const stop of this.stops) {
      if (stop.figure) {
        stop.figure.despawn();
        stop.figure = null;
      }
    }
    this.markers.length = 0;
    this.aboard = 0;
  }

  /* --------------------------------------------------------------- events */

  private subscribe(): void {
    const on = <K extends EventKey>(key: K, fn: (p: EventMap[K]) => void): void => {
      this.unsubs.push(this.bus.on(key, fn));
    };

    on('vehicle:driftEnd', (p) => {
      if (!this.running || p.duration < 0.4) return;
      this.hypeUp(PARTY.hypeDrift, '¡EL BUS SE VIRÓ!', clamp(p.duration / 2, 0.4, 2));
      this.sayCrowd('drift');
    });

    on('vehicle:jumpLand', (p) => {
      if (!this.running || p.airtime < 0.3) return;
      this.hypeUp(PARTY.hypeJump, '¡GUAGUA VOLADORA!', clamp(p.airtime / 1.1, 0.4, 2.2));
      this.sayCrowd('jump');
    });

    on('vehicle:airTrick', () => {
      if (!this.running) return;
      this.hypeUp(PARTY.hypeTrick, '¡EL CORILLO GRITA!', 1.2);
    });

    on('vehicle:twoWheels', (p) => {
      if (!this.running) return;
      this.hypeUp(PARTY.hypeTwoWheels, '¡DOS RUEDAS CON TODO EL MUNDO!', clamp(p.duration, 0.4, 2));
    });

    on('vehicle:nearMiss', () => {
      if (!this.running) return;
      this.hypeUp(PARTY.hypeNearMiss, '¡UYYY!', 1);
      this.sayCrowd('nearMiss');
    });

    on('vehicle:boostStart', () => {
      if (!this.running) return;
      this.hypeUp(PARTY.hypeBoost, '¡MÉTELE!', 1);
    });

    on('vehicle:collision', (p) => {
      if (!this.running) return;
      const heavy = p.impulse >= PARTY.bailImpulse;
      this.hypeDown(
        heavy ? PARTY.hypeHeavyCrash : PARTY.hypeCrash,
        clamp(p.impulse / PARTY.bailImpulse, 0.3, 2.2),
      );
      this.sayCrowd('crash');
      /* a real smash with an already-sour crowd throws somebody straight off */
      if (heavy && this.hype < PARTY.panicThreshold * 1.6 && this.aboard > 0) {
        this.scareOff('crash');
      }
    });

    on('vehicle:reset', () => {
      if (!this.running) return;
      this.hypeDown(PARTY.hypeCrash * 0.6, 1);
    });
  }

  /** Let one random rider react out loud. Cheap, and the bus is a chorus. */
  private sayCrowd(trigger: 'drift' | 'jump' | 'nearMiss' | 'crash'): void {
    if (this.riders.length === 0) return;
    const rider = this.riders[this.rng.int(0, this.riders.length - 1)];
    this.dialogue.say(rider.passenger.archetype.id, trigger, rider.passenger.mood, this.elapsed);
  }
}
