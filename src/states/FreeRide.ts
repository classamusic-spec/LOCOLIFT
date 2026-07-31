/**
 * Loco Lift — free ride.
 *
 * No clock, no failure state. Fares still spawn, still have patience, and still
 * pay — this is where you learn the city, chase a combo with nothing at stake,
 * and find out that Doña Carmen really will get out of a moving vehicle.
 *
 * The HUD's clock is driven by `shift:start`'s duration, so free ride hands it a
 * one-hour dial that simply never becomes urgent, and time earned on delivery
 * tops it back up like any other shift.
 */
import type { EventBus } from '../core/EventBus';
import type { GameMode } from '../core/types';
import type { ShiftController } from './ArcadeShift';

export interface FreeRideOptions {
  bus: EventBus;
  /** what the HUD dial reads at the start; purely cosmetic here */
  displaySeconds?: number;
}

export class FreeRide implements ShiftController {
  readonly mode: GameMode = 'freeRide';
  readonly timed = false;

  private readonly bus: EventBus;
  private readonly displaySeconds: number;
  private running = false;
  private ended = false;
  private elapsed = 0;

  constructor(opts: FreeRideOptions) {
    this.bus = opts.bus;
    this.displaySeconds = opts.displaySeconds ?? 3600;
  }

  get timeRemaining(): number {
    return Number.POSITIVE_INFINITY;
  }

  get finished(): boolean {
    return this.ended;
  }

  /** Seconds spent driving this session. */
  get sessionSeconds(): number {
    return this.elapsed;
  }

  start(): void {
    this.ended = false;
    this.running = false;
    this.elapsed = 0;
    this.bus.emit('shift:start', { mode: this.mode, duration: this.displaySeconds });
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.elapsed += dt;
  }

  /** Free ride only ends when the player says so. */
  stop(): void {
    this.running = false;
    this.ended = true;
  }

  dispose(): void {
    this.running = false;
  }
}
