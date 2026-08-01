/**
 * Loco Lift — the arcade shift.
 *
 * The Crazy Taxi contract: you start with 90 seconds, every delivery buys more,
 * and the clock is the only thing that ends the run. Time is capped at
 * `CONFIG.shift.maxSeconds` so a good streak cannot bank an infinite buffer —
 * the pressure never fully goes away, it just moves further out.
 *
 * The shift owns the authoritative clock. The HUD runs its own copy for smooth
 * per-frame digits; `shift:timeWarning` re-syncs it at the moments that matter.
 */
import { CONFIG } from '../core/Config';
import type { EventBus } from '../core/EventBus';
import { clamp } from '../core/MathUtils';
import type { GameMode } from '../core/types';

/** What `GameDirector` needs from any mode. */
export interface ShiftController {
  readonly mode: GameMode;
  readonly timed: boolean;
  /** seconds left, or Infinity for an untimed mode */
  readonly timeRemaining: number;
  /** true once the mode has ended itself */
  readonly finished: boolean;
  /**
   * True when the mode drives the HUD's chain badge itself, so the generic
   * combo chain stands down rather than fighting it for the same readout.
   * Absent means the ordinary behaviour: the combo chain owns it.
   */
  readonly ownsCombo?: boolean;
  /** True when the mode wants the streets empty of waiting fares. */
  readonly suppressFares?: boolean;
  /** emits `shift:start` and arms the mode */
  start(): void;
  /** the countdown gate — the clock only moves while running */
  setRunning(on: boolean): void;
  update(dt: number): void;
  stop(): void;
  dispose(): void;
}

export interface ArcadeShiftOptions {
  bus: EventBus;
  startSeconds?: number;
  maxSeconds?: number;
  warnAt?: number;
}

/** Seconds at which the player gets a shouted warning, high to low. */
const WARN_STEPS: readonly number[] = [15, 10, 5, 3];

export class ArcadeShift implements ShiftController {
  readonly mode: GameMode = 'arcade';
  readonly timed = true;

  private readonly bus: EventBus;
  private readonly startSeconds: number;
  private readonly maxSeconds: number;
  private readonly warnAt: number;

  private left = 0;
  private running = false;
  private ended = false;
  private warnIndex = 0;
  private added = 0;

  private unsubTime: (() => void) | null = null;

  constructor(opts: ArcadeShiftOptions) {
    this.bus = opts.bus;
    this.startSeconds = opts.startSeconds ?? CONFIG.shift.startSeconds;
    this.maxSeconds = opts.maxSeconds ?? CONFIG.shift.maxSeconds;
    this.warnAt = opts.warnAt ?? CONFIG.shift.warnAt;
  }

  get timeRemaining(): number {
    return this.left;
  }

  get finished(): boolean {
    return this.ended;
  }

  /** Total seconds granted by deliveries this shift. */
  get timeEarned(): number {
    return this.added;
  }

  start(): void {
    this.left = this.startSeconds;
    this.ended = false;
    this.running = false;
    this.added = 0;
    this.warnIndex = 0;
    while (this.warnIndex < WARN_STEPS.length && WARN_STEPS[this.warnIndex] > this.warnAt) {
      this.warnIndex++;
    }

    this.unsubTime?.();
    this.unsubTime = this.bus.on('shift:timeAdded', (p) => this.addTime(p.seconds));

    this.bus.emit('shift:start', { mode: this.mode, duration: this.startSeconds });
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  addTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const before = this.left;
    this.left = clamp(this.left + seconds, 0, this.maxSeconds);
    this.added += this.left - before;
    /* earning time back re-arms the warnings you already passed */
    while (this.warnIndex > 0 && this.left > WARN_STEPS[this.warnIndex - 1]) this.warnIndex--;
  }

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.left -= dt;

    while (this.warnIndex < WARN_STEPS.length && this.left <= WARN_STEPS[this.warnIndex]) {
      const step = WARN_STEPS[this.warnIndex];
      this.warnIndex++;
      if (this.left > 0) this.bus.emit('shift:timeWarning', { remaining: step });
    }

    if (this.left <= 0) {
      this.left = 0;
      this.ended = true;
      this.running = false;
    }
  }

  stop(): void {
    this.running = false;
    this.ended = true;
    this.unsubTime?.();
    this.unsubTime = null;
  }

  dispose(): void {
    this.unsubTime?.();
    this.unsubTime = null;
  }
}
