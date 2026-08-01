/**
 * Loco Lift — free roam, and the fare that arms the clock.
 *
 * This is the mode the game opens on. There is no shift, no countdown and no
 * failure state: San Viejo is just open. People stand on the kerb under tall
 * hail beacons, they wait a long time, they show up on the minimap, and nothing
 * at all happens until you decide to stop for one.
 *
 * The moment somebody gets in, the game becomes Crazy Taxi:
 *
 *     roaming ──(pickup)──► ¡CARRERA ACEPTADA! ──(dropoff)──► banked ──┐
 *        ▲                        clock armed                          │
 *        └──────────────────────────────────────────────────────────────┘
 *                              (or the fare gives up — no penalty)
 *
 * The pressure is gated behind player intent, which is the whole point: you opt
 * into the clock by opening the door, and you opt out of it by delivering.
 *
 * ## Where the clock lives
 *
 * Free roam has no clock of its own, so the HUD's dial has to be borrowed. It
 * opens on zero — honest: there is no time running — and a pickup pushes the
 * fare's whole deadline onto it in one `shift:timeAdded`, which is the HUD's
 * existing "+85s" slam. Time you *did not spend* on the last fare is carried
 * into the next one's allowance (`setRideCarrySeconds`), so the number on the
 * dial is always the real deadline rather than a second, competing clock.
 */
import type { EventBus } from '../core/EventBus';
import type { GameMode } from '../core/types';
import type { ShiftController } from './ArcadeShift';

/* ------------------------------------------------------ structural inputs */

/**
 * The slice of `MissionSystem` free roam drives. Duck-typed and optional, so a
 * `FreeRide` built without one still behaves exactly as it always did.
 */
export interface FreeRoamFares {
  readonly hasPassenger: boolean;
  readonly rideSecondsLeft: number;
  readonly rideAllowance: number;
  readonly faresCompleted: number;
  readonly faresFailed: number;
  setRideCarrySeconds(seconds: number): void;
  setDiscoveryMode(on: boolean): void;
}

export interface FreeRideOptions {
  bus: EventBus;
  /** the fare loop; without one free roam is simply an untimed drive */
  fares?: FreeRoamFares | null;
  /** what the HUD dial opens on. Zero — you have not earned any time yet. */
  displaySeconds?: number;
  /** music intensity while roaming, and while a fare is aboard */
  calmIntensity?: number;
  hotIntensity?: number;
}

/** Below this the clock is already where it should be; do not shout about it. */
const SYNC_EPS = 0.75;

/* ------------------------------------------------------------------ class */

export class FreeRide implements ShiftController {
  readonly mode: GameMode = 'freeRide';
  /** free roam itself is never on a clock — the *fare* is */
  readonly timed = false;

  private readonly bus: EventBus;
  private fares: FreeRoamFares | null;
  private readonly displaySeconds: number;
  private readonly calmIntensity: number;
  private readonly hotIntensity: number;

  private running = false;
  private ended = false;
  private elapsed = 0;

  /** mirrors what the HUD dial reads, in seconds */
  private clock = 0;
  /** true while a fare is aboard and the clock means something */
  private armed = false;
  /** the allowance the armed fare was given, so a leg change is detectable */
  private syncedAllowance = 0;
  /** set by `passenger:dropoff` so the disarm edge knows it was paid */
  private paidThisFare = false;

  private accepted = 0;
  private banked = 0;
  private lost = 0;

  private readonly unsubs: Array<() => void> = [];

  constructor(opts: FreeRideOptions) {
    this.bus = opts.bus;
    this.fares = opts.fares ?? null;
    this.displaySeconds = Math.max(0, opts.displaySeconds ?? 0);
    this.calmIntensity = opts.calmIntensity ?? 0.34;
    this.hotIntensity = opts.hotIntensity ?? 0.88;
  }

  /** Hand over the fare loop once `main` has built it. */
  setFares(f: FreeRoamFares | null): void {
    this.fares = f;
  }

  /* ---------------------------------------------------------- inspection */

  /** Free roam never runs out. The fare aboard might. */
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

  /** True while a fare is aboard and the clock is live. */
  get fareActive(): boolean {
    return this.armed;
  }

  /** What the HUD dial should be reading. */
  get clockSeconds(): number {
    return this.clock;
  }

  /** Seconds left on the fare in progress, or Infinity while roaming. */
  get fareSecondsLeft(): number {
    return this.armed ? this.clock : Number.POSITIVE_INFINITY;
  }

  get faresAccepted(): number {
    return this.accepted;
  }

  get faresBanked(): number {
    return this.banked;
  }

  get faresLost(): number {
    return this.lost;
  }

  /* --------------------------------------------------------------- start */

  start(): void {
    this.ended = false;
    this.running = false;
    this.elapsed = 0;
    this.clock = this.displaySeconds;
    this.armed = false;
    this.syncedAllowance = 0;
    this.paidThisFare = false;
    this.accepted = 0;
    this.banked = 0;
    this.lost = 0;

    this.unsubscribe();
    /*
     * Everything that moves the HUD dial moves this mirror too — the delivery
     * bonus, a mission leg's top-up, and the arming push this class emits
     * itself. Mirroring rather than tracking means the two can never disagree.
     */
    this.unsubs.push(
      this.bus.on('shift:timeAdded', (p) => {
        if (Number.isFinite(p.seconds) && p.seconds > 0) this.clock += p.seconds;
      }),
    );
    this.unsubs.push(
      this.bus.on('passenger:dropoff', (p) => {
        if (!p.archetypeId.startsWith('_')) this.paidThisFare = true;
      }),
    );

    this.fares?.setDiscoveryMode(true);
    this.fares?.setRideCarrySeconds(this.clock);

    /*
     * A non-zero duration is what makes the HUD's depletion bar re-scale to the
     * first fare rather than to whatever the last timed run left behind. It is
     * a hair, not a second, so the dial still opens on 0.0.
     */
    this.bus.emit('shift:start', { mode: this.mode, duration: Math.max(0.001, this.displaySeconds) });
    this.bus.emit('audio:music', { intensity: this.calmIntensity });

    /*
     * This is the game's front door, and the verb is not obvious from a HUD
     * with nothing running on it. Say it once, plainly: the street is open, go
     * and find somebody. The HUD's own prompt keeps saying it afterwards.
     */
    this.bus.emit('ui:notice', { text: 'PASEO LIBRE', big: true });
    this.bus.emit('ui:toast', {
      text: 'Busca a alguien en la calle y párate a su lado. El reloj arranca cuando suban.',
      icon: 'pin',
      ms: 6000,
    });
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  /* --------------------------------------------------------------- frame */

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.elapsed += dt;

    const fares = this.fares;
    if (!fares) {
      this.clock = Math.max(0, this.clock - dt);
      return;
    }

    const aboard = fares.hasPassenger;

    if (aboard && !this.armed) {
      this.arm(fares);
    } else if (!aboard && this.armed) {
      this.disarm();
    }

    if (this.armed) {
      /* the ride clock is authoritative while someone is in the car */
      this.clock = fares.rideSecondsLeft;
      const allowance = fares.rideAllowance;
      if (Math.abs(allowance - this.syncedAllowance) > SYNC_EPS) {
        /* a multi-stop job just reset its deadline — re-point the dial at it */
        this.syncedAllowance = allowance;
        this.syncClockTo(fares.rideSecondsLeft, 'Nueva parada');
      }
      /* nothing is carried while a fare is running; it is already in the ride */
      fares.setRideCarrySeconds(0);
    } else {
      this.clock = Math.max(0, this.clock - dt);
      /* whatever is still on the dial rides along with the next person */
      fares.setRideCarrySeconds(this.clock);
    }
  }

  /* --------------------------------------------------------- transitions */

  /** Somebody got in. This is the moment the game grows a clock. */
  private arm(fares: FreeRoamFares): void {
    this.armed = true;
    this.paidThisFare = false;
    this.accepted++;
    this.syncedAllowance = fares.rideAllowance;

    this.bus.emit('ui:notice', { text: '¡CARRERA ACEPTADA!', big: true });
    this.bus.emit('audio:sfx', { id: 'countdownGo', volume: 0.85 });
    this.bus.emit('audio:music', { intensity: this.hotIntensity });

    /* the slam: the dial goes from nothing to the whole deadline in one beat */
    this.syncClockTo(fares.rideSecondsLeft, 'CARRERA ACEPTADA');
  }

  /** The fare ended — delivered, or they gave up. Either way, back to roaming. */
  private disarm(): void {
    this.armed = false;
    this.syncedAllowance = 0;

    if (this.paidThisFare) {
      this.banked++;
      this.bus.emit('ui:toast', {
        text: 'Carrera cobrada. La calle es tuya otra vez.',
        icon: 'money',
        ms: 2400,
      });
    } else {
      this.lost++;
      /* no failure state out here — say what happened and get out of the way */
      this.bus.emit('ui:toast', {
        text: 'Se bajó. Sigue rodando y busca a otro.',
        icon: 'pin',
        ms: 2400,
      });
    }
    this.paidThisFare = false;
    this.bus.emit('audio:music', { intensity: this.calmIntensity });
  }

  /**
   * Move the HUD dial to `target` using the two affordances the HUD actually
   * has: a "+Ns" extension flash going up, and the time-warning shout going
   * down. Anything inside `SYNC_EPS` is left alone so the dial never chatters.
   */
  private syncClockTo(target: number, reason: string): void {
    if (!Number.isFinite(target) || target < 0) return;
    const delta = target - this.clock;
    if (delta > SYNC_EPS) {
      /* the mirror is updated by this class's own `shift:timeAdded` handler */
      this.bus.emit('shift:timeAdded', { seconds: delta, reason });
    } else if (delta < -SYNC_EPS) {
      this.clock = target;
      this.bus.emit('shift:timeWarning', { remaining: Math.max(1, Math.round(target)) });
    }
  }

  /* ---------------------------------------------------------------- stop */

  /** Free roam only ends when the player says so. */
  stop(): void {
    this.running = false;
    this.ended = true;
    this.armed = false;
    this.fares?.setRideCarrySeconds(0);
    this.fares?.setDiscoveryMode(false);
    this.unsubscribe();
  }

  private unsubscribe(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  dispose(): void {
    this.running = false;
    this.unsubscribe();
  }
}

/** Reads better at the call site now that this is the game's front door. */
export { FreeRide as FreeRoam };
