/**
 * Loco Lift — challenges.
 *
 * Four short, focused runs that isolate one verb each:
 *
 *   drift-marathon     hold the slide — metres drifted in 90 s
 *   air-time           get off the ground — seconds airborne in 90 s
 *   delivery-streak    don't drop anyone — consecutive fares in 150 s
 *   checkpoint-sprint  learn the map — hit six landmarks, each one buys time
 *
 * Each records a personal best through `SaveSystem.challengeBest`, and each
 * pays out through `mission:complete` so the same score and cash plumbing works
 * without a special case.
 */
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { FareResult, GameMode, PassengerArchetype, POI, RoadGraph } from '../core/types';
import { regionOfPOI } from '../passengers/MissionCatalog';
import type { SaveSystem } from '../save/SaveSystem';
import type { ShiftController } from './ArcadeShift';
import { buildElTorroRoute, type ElTorroRoute } from './ElTorroRoute';

/* ------------------------------------------------------ structural inputs */

export interface ChallengeVehicle {
  readonly position: { x: number; y: number; z: number };
  readonly speed: number;
  readonly isDrifting: boolean;
  readonly isAirborne: boolean;
}

export interface ChallengeWorld {
  pois: ReadonlyArray<POI>;
  /** used by the coastal sprint to keep its route out of the old town */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** the El Torro time trial derives its checkpoints from the road graph */
  roads?: RoadGraph;
  groundHeight?(x: number, z: number): number;
  poiById?(id: string): POI | undefined;
}

/**
 * The authoritative fare counters. `passenger:bail` cannot tell "the fare in my
 * back seat gave up" from "a stranger three blocks away stopped waiting", and
 * only the second kind should be free — so the streak challenge reads the
 * mission system's counters instead of inferring from events.
 */
export interface ChallengeFareSource {
  readonly faresCompleted: number;
  readonly faresFailed: number;
}

/* ------------------------------------------------------------ definitions */

export type ChallengeId =
  | 'drift-marathon'
  | 'air-time'
  | 'delivery-streak'
  | 'checkpoint-sprint'
  | 'near-miss-run'
  | 'combo-chain'
  | 'prop-smash'
  | 'clean-streak'
  | 'coast-sprint'
  | 'el-torro-trial';

export interface ChallengeDef {
  id: ChallengeId;
  title: string;
  objective: string;
  /** seconds on the clock */
  duration: number;
  /** the number that has to be reached */
  goal: number;
  /** what the goal is measured in, for toasts */
  unit: string;
  /** cash paid for hitting the goal exactly; overshoot scales up */
  reward: number;
}

export const CHALLENGES: readonly ChallengeDef[] = [
  {
    id: 'drift-marathon',
    title: 'MARATÓN DE DERRAPE',
    objective: 'Derrapa 900 metros antes de que se acabe el tiempo.',
    duration: 90,
    goal: 900,
    unit: 'm',
    reward: 1400,
  },
  {
    id: 'air-time',
    title: 'TIEMPO EN EL AIRE',
    objective: 'Acumula 22 segundos de vuelo. Las rampas están por toda la ciudad.',
    duration: 90,
    goal: 22,
    unit: 's',
    reward: 1500,
  },
  {
    id: 'delivery-streak',
    title: 'RACHA DE CARRERAS',
    objective: 'Entrega 6 pasajeros seguidos. Si uno se baja, la racha vuelve a cero.',
    duration: 150,
    goal: 6,
    unit: 'carreras',
    reward: 2200,
  },
  {
    id: 'checkpoint-sprint',
    title: 'RUTA RELÁMPAGO',
    objective: 'Toca los seis puntos de la ruta. Cada uno te devuelve tiempo.',
    duration: 55,
    goal: 6,
    unit: 'puntos',
    reward: 2000,
  },
  {
    id: 'near-miss-run',
    title: 'ROZANDO EL TRÁFICO',
    objective: 'Pasa rozando 16 carros sin tocarlos. Un golpe fuerte y pierdes cuatro.',
    duration: 75,
    goal: 16,
    unit: 'casi',
    reward: 1800,
  },
  {
    id: 'combo-chain',
    title: 'LA CADENA',
    objective: 'Llega a multiplicador ×9 sin romper la cadena. Derrapa, salta, roza.',
    duration: 80,
    goal: 9,
    unit: '×',
    reward: 2100,
  },
  {
    id: 'prop-smash',
    title: 'REVOLÚ EN LA CALLE',
    objective: 'Destroza 24 cosas. Conos, cajones, sillas — todo cuenta.',
    duration: 70,
    goal: 24,
    unit: 'cosas',
    reward: 1600,
  },
  {
    id: 'clean-streak',
    title: 'SIN UN RASGUÑO',
    objective: 'Entrega 4 pasajeros sin un solo golpe fuerte. Uno solo y vuelves a cero.',
    duration: 165,
    goal: 4,
    unit: 'carreras',
    reward: 2600,
  },
  {
    id: 'coast-sprint',
    title: 'LA COSTA COMPLETA',
    objective: 'Siete puntos por la costa y Piñones. Aquí sí se puede correr.',
    duration: 70,
    goal: 7,
    unit: 'puntos',
    reward: 2400,
  },
  {
    id: 'el-torro-trial',
    title: 'EL TORRO · CONTRARRELOJ',
    objective: 'Las siete garitas de la muralla, de oeste a este, sin levantar el pie.',
    duration: 62,
    goal: 7,
    unit: 'garitas',
    reward: 3400,
  },
];

/**
 * A pseudo-archetype so the checkpoint sprint can reuse the HUD's destination
 * card, banner and arrow without the UI knowing challenges exist. Register it
 * alongside the real cast in `ui.setArchetypes`.
 */
export const CHECKPOINT_ARCHETYPE: PassengerArchetype = {
  id: '_checkpoint',
  name: 'Punto de control',
  blurb: 'Llega antes de que se acabe el tiempo.',
  patience: 30,
  fareMultiplier: 1,
  thrillSeeking: 0.5,
  color: 0x00e5ff,
  voicePitch: 1,
};

export interface ChallengesOptions {
  bus: EventBus;
  vehicle: ChallengeVehicle;
  world?: ChallengeWorld | null;
  save?: SaveSystem | null;
  /** the mission system, for the delivery-streak challenge */
  fares?: ChallengeFareSource | null;
  rng?: RNG;
  /** seconds each checkpoint returns to the clock */
  checkpointTime?: number;
  /** metres of arrival radius for a checkpoint */
  checkpointRadius?: number;
  /** contact impulse that counts as a real hit, not a scrape */
  heavyImpulse?: number;
}

/** Challenges whose metric is "touch these places in this order". */
const ROUTE_CHALLENGES: ReadonlySet<ChallengeId> = new Set<ChallengeId>([
  'checkpoint-sprint',
  'coast-sprint',
  'el-torro-trial',
]);

/* ------------------------------------------------------------------ class */

export class Challenges implements ShiftController {
  readonly mode: GameMode = 'challenge';
  readonly timed = true;

  private readonly bus: EventBus;
  private readonly vehicle: ChallengeVehicle;
  private world: ChallengeWorld | null;
  private fares: ChallengeFareSource | null;
  private readonly save: SaveSystem | null;
  private readonly rng: RNG;
  private readonly checkpointTime: number;
  private readonly checkpointRadius: number;

  private def: ChallengeDef = CHALLENGES[0];
  private left = 0;
  private running = false;
  private ended = false;
  private succeeded = false;

  private metric = 0;
  private best = 0;
  private streak = 0;
  private announced = 0;

  private route: POI[] = [];
  private routeIndex = 0;
  /** the derived wall road, when the El Torro trial is the live challenge */
  private torro: ElTorroRoute | null = null;
  /** last-seen mission counters, for the delivery-streak challenge */
  private seenDone = 0;
  private seenLost = 0;
  /** impulse a `clean-streak` / `near-miss-run` run counts as a real hit */
  private readonly heavyImpulse: number;

  private readonly unsubs: Array<() => void> = [];

  constructor(opts: ChallengesOptions) {
    this.bus = opts.bus;
    this.vehicle = opts.vehicle;
    this.world = opts.world ?? null;
    this.fares = opts.fares ?? null;
    this.save = opts.save ?? null;
    this.rng = opts.rng ?? new RNG(0x10c0_c4a1);
    this.checkpointTime = opts.checkpointTime ?? 9;
    this.checkpointRadius = opts.checkpointRadius ?? 16;
    this.heavyImpulse = opts.heavyImpulse ?? 2600;
  }

  setWorld(w: ChallengeWorld | null): void {
    this.world = w;
  }

  setFareSource(s: ChallengeFareSource | null): void {
    this.fares = s;
  }

  /** Choose which challenge `start()` will run. */
  select(id: ChallengeId): boolean {
    const def = CHALLENGES.find((c) => c.id === id);
    if (!def) return false;
    this.def = def;
    return true;
  }

  get definition(): ChallengeDef {
    return this.def;
  }

  get timeRemaining(): number {
    return this.left;
  }

  get finished(): boolean {
    return this.ended;
  }

  get succeededFlag(): boolean {
    return this.succeeded;
  }

  /**
   * The number that actually has to be reached. A route challenge is bounded by
   * the stops the world could give it, so a build with six garitas asks for six
   * rather than becoming impossible.
   */
  get goal(): number {
    if (ROUTE_CHALLENGES.has(this.def.id) && this.route.length > 0) return this.route.length;
    return this.def.goal;
  }

  /** 0..1 toward the goal. */
  get progress(): number {
    const g = this.goal;
    return g > 0 ? clamp01(this.metric / g) : 0;
  }

  /** The derived wall road, when the El Torro trial is live. */
  get wallRoute(): ElTorroRoute | null {
    return this.torro;
  }

  get value(): number {
    return this.metric;
  }

  get personalBest(): number {
    return this.best;
  }

  /** The checkpoint the player is currently heading for, or null. */
  get currentCheckpoint(): POI | null {
    return this.route[this.routeIndex] ?? null;
  }

  get routeLength(): number {
    return this.route.length;
  }

  /* --------------------------------------------------------------- start */

  start(): void {
    this.left = this.def.duration;
    this.running = false;
    this.ended = false;
    this.succeeded = false;
    this.metric = 0;
    this.streak = 0;
    this.announced = 0;
    this.routeIndex = 0;
    this.route.length = 0;
    this.torro = null;
    this.best = this.save ? (this.save.current.challengeBest[this.def.id] ?? 0) : 0;

    this.unsubscribe();
    this.unsubs.push(this.bus.on('shift:timeAdded', (p) => this.addTime(p.seconds)));

    if (this.fares) {
      this.seenDone = this.fares.faresCompleted;
      this.seenLost = this.fares.faresFailed;
    } else {
      /* fallback for a standalone Challenges instance with no mission system */
      this.seenDone = 0;
      this.seenLost = 0;
      this.unsubs.push(
        this.bus.on('passenger:dropoff', () => {
          if (this.def.id !== 'delivery-streak' || !this.running) return;
          this.streak++;
          this.metric = this.streak;
          this.announceProgress();
        }),
      );
    }

    this.subscribeMetric();
    if (ROUTE_CHALLENGES.has(this.def.id)) this.buildRoute();

    this.bus.emit('shift:start', { mode: this.mode, duration: this.def.duration });
    this.bus.emit('mission:start', {
      id: this.def.id,
      title: this.def.title,
      objective: this.def.objective,
    });
    if (ROUTE_CHALLENGES.has(this.def.id)) this.pointAtCheckpoint();
  }

  /**
   * The event-driven challenges. These metrics cannot be sampled per frame —
   * a near miss, a smashed crate and a multiplier step are all instants — so
   * they are counted off the bus and torn down with the run.
   */
  private subscribeMetric(): void {
    switch (this.def.id) {
      case 'near-miss-run':
        this.unsubs.push(
          this.bus.on('vehicle:nearMiss', () => {
            if (!this.running) return;
            this.metric++;
            this.announceProgress();
          }),
        );
        this.unsubs.push(
          this.bus.on('vehicle:collision', (p) => {
            if (!this.running || p.impulse < this.heavyImpulse) return;
            /* a real hit is not a near miss — it costs you four of them */
            if (this.metric <= 0) return;
            this.metric = Math.max(0, this.metric - 4);
            this.announced = 0;
            this.bus.emit('ui:toast', { text: '¡Eso fue un golpe! −4', icon: 'warn', ms: 1800 });
          }),
        );
        break;
      case 'combo-chain':
        this.unsubs.push(
          this.bus.on('combo:multiplier', (p) => {
            if (!this.running) return;
            if (p.multiplier > this.metric) {
              this.metric = p.multiplier;
              this.announceProgress();
            }
          }),
        );
        break;
      case 'prop-smash':
        this.unsubs.push(
          this.bus.on('prop:destroyed', () => {
            if (!this.running) return;
            this.metric++;
            this.announceProgress();
          }),
        );
        break;
      case 'clean-streak':
        this.unsubs.push(
          this.bus.on('vehicle:collision', (p) => {
            if (!this.running || p.impulse < this.heavyImpulse) return;
            if (this.streak > 0) {
              this.bus.emit('ui:toast', { text: 'Golpe fuerte. Racha a cero.', icon: 'warn', ms: 2200 });
            }
            this.streak = 0;
            this.metric = 0;
            this.announced = 0;
          }),
        );
        break;
      default:
        break;
    }
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  private addTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.left = clamp(this.left + seconds, 0, this.def.duration * 2.5);
  }

  /* --------------------------------------------------------------- frame */

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.left -= dt;

    switch (this.def.id) {
      case 'drift-marathon':
        if (this.vehicle.isDrifting && this.vehicle.speed > 3) {
          this.metric += this.vehicle.speed * dt;
          this.announceProgress();
        }
        break;
      case 'air-time':
        if (this.vehicle.isAirborne) {
          this.metric += dt;
          this.announceProgress();
        }
        break;
      case 'checkpoint-sprint':
      case 'coast-sprint':
      case 'el-torro-trial':
        this.tickCheckpoints();
        break;
      case 'delivery-streak':
      case 'clean-streak':
        this.tickStreak();
        break;
      case 'near-miss-run':
      case 'combo-chain':
      case 'prop-smash':
        /* counted on the bus by `subscribeMetric` */
        break;
      default:
        break;
    }

    if (this.metric >= this.goal) {
      this.finish(true);
      return;
    }
    if (this.left <= 0) {
      this.left = 0;
      this.finish(false);
    }
  }

  private announceProgress(): void {
    const p = this.progress;
    const step = Math.floor(p * 4);
    if (step <= this.announced || step >= 4) return;
    this.announced = step;
    const shown = this.def.unit === 'm' || this.def.unit === 's' ? Math.round(this.metric) : this.metric;
    this.bus.emit('ui:toast', {
      text: `${shown} / ${this.goal} ${this.def.unit}`,
      icon: 'star',
      ms: 1600,
    });
  }

  /** Deliveries add to the streak; losing a fare you were carrying zeroes it. */
  private tickStreak(): void {
    const src = this.fares;
    if (!src) return;
    const lost = src.faresFailed - this.seenLost;
    const done = src.faresCompleted - this.seenDone;
    this.seenLost = src.faresFailed;
    this.seenDone = src.faresCompleted;

    if (lost > 0) {
      if (this.streak > 0) {
        this.bus.emit('ui:toast', { text: 'Racha rota. Vuelve a empezar.', icon: 'warn', ms: 2200 });
      }
      this.streak = 0;
      this.metric = 0;
      this.announced = 0;
      return;
    }
    if (done > 0) {
      this.streak += done;
      this.metric = this.streak;
      this.announceProgress();
    }
  }

  /* ---------------------------------------------------------- checkpoints */

  /**
   * El Torro is the one route in the game that is *authored*, not sampled: the
   * seven garitas in order, west to east, no shortcuts, no re-ordering. It is
   * built from the live road graph so it survives the world moving.
   */
  private buildTorroRoute(): boolean {
    const world = this.world;
    if (!world || !world.roads || !world.bounds) return false;
    const route: ElTorroRoute | null = buildElTorroRoute({
      roads: world.roads,
      pois: world.pois,
      bounds: world.bounds,
      groundHeight: world.groundHeight?.bind(world),
      poiById: world.poiById?.bind(world),
    });
    if (!route) return false;
    const stops = route.garitaPOIs();
    if (stops.length < 2) return false;
    this.route = stops;
    this.torro = route;
    return true;
  }

  private buildRoute(): void {
    if (this.def.id === 'el-torro-trial') {
      if (this.buildTorroRoute()) return;
      /* no wall road in this build — fall through to the generic sampler */
    }
    let pois = this.world ? this.world.pois.slice() : [];
    if (pois.length === 0) return;

    /* the coastal sprint is a different road problem — keep it off the cobbles */
    if (this.def.id === 'coast-sprint') {
      const bounds = this.world?.bounds;
      if (bounds) {
        const coastal = pois.filter((p) => {
          const r = regionOfPOI(p, bounds);
          return r === 'coast' || r === 'pinones';
        });
        if (coastal.length >= this.def.goal) pois = coastal;
      }
    }

    this.rng.shuffle(pois);

    const v = this.vehicle.position;
    /* start near the player so the first leg is not a punishment */
    pois.sort((a, b) => {
      const da = (a.pos.x - v.x) ** 2 + (a.pos.z - v.z) ** 2;
      const db = (b.pos.x - v.x) ** 2 + (b.pos.z - v.z) ** 2;
      return da - db;
    });

    const chosen: POI[] = [];
    for (const poi of pois) {
      if (chosen.length >= this.def.goal) break;
      let ok = true;
      for (const c of chosen) {
        if ((c.pos.x - poi.pos.x) ** 2 + (c.pos.z - poi.pos.z) ** 2 < 90 * 90) {
          ok = false;
          break;
        }
      }
      if (ok) chosen.push(poi);
    }
    /* top up if the district is too tight for six well-spaced points */
    for (const poi of pois) {
      if (chosen.length >= this.def.goal) break;
      if (!chosen.includes(poi)) chosen.push(poi);
    }
    this.route = chosen;
  }

  private pointAtCheckpoint(): void {
    const poi = this.route[this.routeIndex];
    if (!poi) return;
    this.bus.emit('passenger:pickup', {
      archetypeId: CHECKPOINT_ARCHETYPE.id,
      destinationId: poi.id,
      fareEstimate: this.def.reward,
    });
  }

  private tickCheckpoints(): void {
    const poi = this.route[this.routeIndex];
    if (!poi) return;
    const v = this.vehicle.position;
    const d2 = (poi.pos.x - v.x) ** 2 + (poi.pos.z - v.z) ** 2;
    const r = Math.max(this.checkpointRadius, poi.radius);
    if (d2 > r * r) return;

    this.routeIndex++;
    this.metric = this.routeIndex;
    this.addTime(this.checkpointTime);
    const noun = this.def.id === 'el-torro-trial' ? 'GARITA' : 'PUNTO';
    this.bus.emit('ui:notice', { text: `${noun} ${this.routeIndex} / ${this.route.length}`, big: false });
    this.bus.emit('audio:sfx', { id: 'timeExtend', volume: 0.7 });
    if (this.routeIndex < this.route.length) this.pointAtCheckpoint();
  }

  /* -------------------------------------------------------------- finish */

  private finish(success: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.succeeded = success;

    const goal = this.goal;
    const overshoot = goal > 0 ? clamp(this.metric / goal, 0, 3) : 0;
    const payout = success
      ? Math.round(this.def.reward * (1 + (overshoot - 1) * 0.5) + this.left * 12)
      : Math.round(this.def.reward * 0.35 * this.progress);

    const rating = clamp(Math.round(this.progress * 10) / 2, 0, 5);
    const result: FareResult = {
      base: Math.round(payout * 0.5),
      distanceBonus: 0,
      timeBonus: success ? Math.round(this.left * 12) : 0,
      comboBonus: 0,
      tip: Math.round(payout * 0.5),
      total: payout,
      rating,
      grade: success ? '¡Reto superado!' : 'No llegó',
    };

    if (success) this.bus.emit('mission:complete', { id: this.def.id, result });
    else {
      this.bus.emit('mission:fail', {
        id: this.def.id,
        reason: `${Math.round(this.metric)} / ${this.goal} ${this.def.unit}`,
      });
    }

    const save = this.save;
    if (save) {
      const key = this.def.id;
      const value = Math.round(this.metric * 100) / 100;
      if (value > this.best) {
        this.best = value;
        save.update((d) => {
          d.challengeBest[key] = value;
        });
      }
    }
  }

  stop(): void {
    if (!this.ended) this.finish(this.metric >= this.goal);
    this.running = false;
    this.unsubscribe();
  }

  private unsubscribe(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
