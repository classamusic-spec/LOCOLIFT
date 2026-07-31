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
import type { FareResult, GameMode, PassengerArchetype, POI } from '../core/types';
import type { SaveSystem } from '../save/SaveSystem';
import type { ShiftController } from './ArcadeShift';

/* ------------------------------------------------------ structural inputs */

export interface ChallengeVehicle {
  readonly position: { x: number; y: number; z: number };
  readonly speed: number;
  readonly isDrifting: boolean;
  readonly isAirborne: boolean;
}

export interface ChallengeWorld {
  pois: ReadonlyArray<POI>;
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

export type ChallengeId = 'drift-marathon' | 'air-time' | 'delivery-streak' | 'checkpoint-sprint';

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
}

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
  /** last-seen mission counters, for the delivery-streak challenge */
  private seenDone = 0;
  private seenLost = 0;

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

  /** 0..1 toward the goal. */
  get progress(): number {
    return this.def.goal > 0 ? clamp01(this.metric / this.def.goal) : 0;
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

    if (this.def.id === 'checkpoint-sprint') this.buildRoute();

    this.bus.emit('shift:start', { mode: this.mode, duration: this.def.duration });
    this.bus.emit('mission:start', {
      id: this.def.id,
      title: this.def.title,
      objective: this.def.objective,
    });
    if (this.def.id === 'checkpoint-sprint') this.pointAtCheckpoint();
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
        this.tickCheckpoints();
        break;
      case 'delivery-streak':
        this.tickStreak();
        break;
      default:
        break;
    }

    if (this.metric >= this.def.goal) {
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
      text: `${shown} / ${this.def.goal} ${this.def.unit}`,
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

  private buildRoute(): void {
    const pois = this.world ? this.world.pois.slice() : [];
    if (pois.length === 0) return;
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
    this.bus.emit('ui:notice', { text: `PUNTO ${this.routeIndex} / ${this.def.goal}`, big: false });
    this.bus.emit('audio:sfx', { id: 'timeExtend', volume: 0.7 });
    if (this.routeIndex < this.route.length) this.pointAtCheckpoint();
  }

  /* -------------------------------------------------------------- finish */

  private finish(success: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.succeeded = success;

    const overshoot = this.def.goal > 0 ? clamp(this.metric / this.def.goal, 0, 3) : 0;
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
        reason: `${Math.round(this.metric)} / ${this.def.goal} ${this.def.unit}`,
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
    if (!this.ended) this.finish(this.metric >= this.def.goal);
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
