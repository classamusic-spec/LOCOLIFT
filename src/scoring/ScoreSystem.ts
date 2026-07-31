/**
 * Loco Lift — score, cash and records.
 *
 * One number goes up. Everything that can raise it funnels through here:
 *
 *   combo:add          → style points, already multiplied by `ComboSystem`
 *   passenger:dropoff  → the fare's `total`, straight into the bank
 *   mission:complete   → passenger-less missions (the runaway cart) pay here
 *
 * `mission:complete` and `passenger:dropoff` carry the *same* `FareResult`
 * object for a normal delivery, so the system dedupes by identity rather than
 * double-paying.
 *
 * At the end of a shift it writes progression through `SaveSystem`: best score
 * per mode, most fares, biggest combo, longest drift and airtime, distance
 * driven, and every archetype the player has now met.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp } from '../core/MathUtils';
import type {
  EventKey,
  EventMap,
  FareResult,
  GameContext,
  GameMode,
  System,
} from '../core/types';
import type { SaveSystem } from '../save/SaveSystem';

/* ------------------------------------------------------ structural inputs */

/** Only the position is needed, to accumulate distance driven. */
export interface ScoreVehicle {
  readonly position: THREE.Vector3;
}

export interface ScoreSystemOptions {
  bus: EventBus;
  save?: SaveSystem | null;
  vehicle?: ScoreVehicle | null;
}

export interface ShiftSummary {
  mode: GameMode;
  score: number;
  /** cash portion only — fares and mission bonuses, no style points */
  cash: number;
  fares: number;
  faresFailed: number;
  /** average star rating across delivered fares */
  rating: number;
  bestCombo: number;
  comboPoints: number;
  distance: number;
  /** true when this shift set a new best score for the mode */
  newRecord: boolean;
}

/* ------------------------------------------------------------------ class */

export class ScoreSystem implements System {
  readonly name = 'score';

  private readonly bus: EventBus;
  private readonly save: SaveSystem | null;
  private vehicle: ScoreVehicle | null;

  private _score = 0;
  private cash = 0;
  private stylePoints = 0;
  private fares = 0;
  private failed = 0;
  private ratingSum = 0;
  private bestCombo = 1;
  private mode: GameMode = 'arcade';
  private running = false;

  private longestDrift = 0;
  private longestAir = 0;
  private distance = 0;
  private readonly lastPos = new THREE.Vector3();
  private hasLastPos = false;

  private lastCounted: FareResult | null = null;
  private readonly met = new Set<string>();

  private readonly changePayload = { score: 0, delta: 0 };
  private readonly unsubs: Array<() => void> = [];

  constructor(opts: ScoreSystemOptions) {
    this.bus = opts.bus;
    this.save = opts.save ?? null;
    this.vehicle = opts.vehicle ?? null;
  }

  setVehicle(v: ScoreVehicle | null): void {
    this.vehicle = v;
    this.hasLastPos = false;
  }

  init(ctx: GameContext): void {
    this.subscribe(ctx.bus);
  }

  private subscribe(bus: EventBus): void {
    const on = <K extends EventKey>(key: K, fn: (p: EventMap[K]) => void): void => {
      this.unsubs.push(bus.on(key, fn));
    };

    on('combo:add', (p) => {
      if (!this.running) return;
      this.stylePoints += p.points;
      this.cash += p.points;
      this.add(p.points);
    });

    on('combo:multiplier', (p) => {
      if (p.multiplier > this.bestCombo) this.bestCombo = p.multiplier;
    });

    on('passenger:dropoff', (p) => {
      if (!this.running) return;
      this.fares++;
      this.ratingSum += p.result.rating;
      this.bank(p.result);
    });

    on('passenger:pickup', (p) => {
      /* ids beginning with "_" are UI stand-ins (checkpoints, the cart), not people */
      if (!p.archetypeId.startsWith('_')) this.met.add(p.archetypeId);
    });

    on('passenger:bail', () => {
      if (this.running) this.failed++;
    });

    on('mission:complete', (p) => {
      if (!this.running) return;
      this.bank(p.result);
    });

    on('vehicle:driftEnd', (p) => {
      if (p.duration > this.longestDrift) this.longestDrift = p.duration;
    });

    on('vehicle:jumpLand', (p) => {
      if (p.airtime > this.longestAir) this.longestAir = p.airtime;
    });
  }

  /**
   * Pay a fare exactly once, even though two events may carry it.
   *
   * The fare's `comboBonus` line is the style money earned since the previous
   * delivery, which already went through `combo:add` above — so it is reported
   * on the results breakdown but deducted here. Without this the HUD's running
   * total and the itemised results screen would disagree by the combo line.
   */
  private bank(result: FareResult): void {
    if (result === this.lastCounted) return;
    this.lastCounted = result;
    if (!Number.isFinite(result.total)) return;
    const payable = result.total - (Number.isFinite(result.comboBonus) ? result.comboBonus : 0);
    if (payable <= 0) return;
    this.cash += payable;
    this.add(payable);
  }

  /* --------------------------------------------------------------- control */

  beginShift(mode: GameMode): void {
    this.mode = mode;
    this._score = 0;
    this.cash = 0;
    this.stylePoints = 0;
    this.fares = 0;
    this.failed = 0;
    this.ratingSum = 0;
    this.bestCombo = 1;
    this.longestDrift = 0;
    this.longestAir = 0;
    this.distance = 0;
    this.hasLastPos = false;
    this.lastCounted = null;
    this.met.clear();
    this.running = true;
    this.changePayload.score = 0;
    this.changePayload.delta = 0;
    this.bus.emit('score:changed', this.changePayload);
  }

  /** Freeze scoring and commit progression. Safe to call twice. */
  endShift(): ShiftSummary {
    const wasRunning = this.running;
    this.running = false;

    const summary: ShiftSummary = {
      mode: this.mode,
      score: Math.round(this._score),
      cash: Math.round(this.cash),
      fares: this.fares,
      faresFailed: this.failed,
      rating: this.fares > 0 ? clamp(this.ratingSum / this.fares, 0, 5) : 0,
      bestCombo: this.bestCombo,
      comboPoints: Math.round(this.stylePoints),
      distance: Math.round(this.distance),
      newRecord: false,
    };

    const save = this.save;
    if (save && wasRunning) {
      summary.newRecord = save.recordScore(this.mode, summary.score);
      save.record('bestFares', this.fares);
      save.record('biggestCombo', this.bestCombo);
      save.record('longestDrift', this.longestDrift);
      save.record('longestAirtime', this.longestAir);
      save.addBank(summary.cash);
      const met = this.met;
      save.update((d) => {
        d.totalFares += this.fares;
        d.totalDistance += summary.distance;
        for (const id of met) {
          if (!d.metPassengers.includes(id)) d.metPassengers.push(id);
        }
      });
    }

    return summary;
  }

  /** Raw points, already multiplied. Emits `score:changed`. */
  add(points: number): void {
    if (!this.running) return;
    if (!Number.isFinite(points) || points === 0) return;
    this._score = Math.max(0, this._score + points);
    this.changePayload.score = Math.round(this._score);
    this.changePayload.delta = points;
    this.bus.emit('score:changed', this.changePayload);
  }

  /** Cash that did not come through a fare (mission tips, challenge payouts). */
  addCash(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.cash += amount;
    this.add(amount);
  }

  /* ----------------------------------------------------------- inspection */

  get score(): number {
    return Math.round(this._score);
  }

  get cashEarned(): number {
    return Math.round(this.cash);
  }

  get fareCount(): number {
    return this.fares;
  }

  get failedCount(): number {
    return this.failed;
  }

  get averageRating(): number {
    return this.fares > 0 ? this.ratingSum / this.fares : 0;
  }

  get peakMultiplier(): number {
    return this.bestCombo;
  }

  get distanceDriven(): number {
    return this.distance;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /* ---------------------------------------------------------------- frame */

  update(_ctx: GameContext, dt: number): void {
    const v = this.vehicle;
    if (!v || !this.running || dt <= 0) return;
    if (!this.hasLastPos) {
      this.lastPos.copy(v.position);
      this.hasLastPos = true;
      return;
    }
    const dx = v.position.x - this.lastPos.x;
    const dy = v.position.y - this.lastPos.y;
    const dz = v.position.z - this.lastPos.z;
    const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
    /* a respawn teleports; do not credit that as distance driven */
    if (step < 40) this.distance += step;
    this.lastPos.set(v.position.x, v.position.y, v.position.z);
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.vehicle = null;
  }
}
