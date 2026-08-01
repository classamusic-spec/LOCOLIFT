/**
 * Loco Lift — Drift Mode.
 *
 * A mode about one verb. No fares, no traffic errands, no destination arrow:
 * just San Viejo's open ground and the tail of whatever you are driving.
 *
 * ## The score
 *
 * While the chassis is sideways, points accrue at a rate set by three things at
 * once — how far the tail is out, how fast you are carrying it, and where you
 * are doing it:
 *
 *     rate = base · angle(slip) · speed(v) · zone · chain
 *
 * Nothing is paid while the slide is live. It sits in a *pending* pot that only
 * lands when the chain breaks — straighten out for too long, stop, or hit
 * something hard enough, and the whole pot banks at once. That is the tension:
 * every extra second sideways is worth more and risks more.
 *
 * ## The chain
 *
 * Each drift that scores links to the previous one if you start the next inside
 * the link window. Links raise the chain multiplier along `CHAIN_STEPS`, so a
 * plaza lap strung out of six linked slides is worth several times the same six
 * slides driven separately. Releasing a charged drift pays a release bonus on
 * top — the mini-turbo moment, scored.
 *
 * ## The ground
 *
 * Zones are derived from the world, not authored against coordinates: the
 * plaza, the market floor, the fort glacis and the lookouts become scored
 * arenas, and the coastal road becomes a long sweeping corridor. Bank enough
 * inside one and you *claim* it — that pays, buys clock, and raises the zone's
 * own multiplier for the rest of the run. Claim them all and the city opens up
 * a second, harder lap.
 *
 * ## The vehicles
 *
 * The Jeep drifts, the bus is a heavy slide that takes a block to set up and a
 * block to recover, and the carriage skids its locked rear wheels across wet
 * adoquín at jogging pace. Each gets its own reference slip angle, speed floor
 * and link window, taken from the same numbers its tyre model uses, so all
 * three can reach the same score ceiling by driving completely differently.
 */
import { clamp, clamp01 } from '../core/MathUtils';
import type { EventBus } from '../core/EventBus';
import type { FareResult, GameMode, POI, RoadGraph } from '../core/types';
import type { SaveSystem } from '../save/SaveSystem';
import type { ShiftController } from './ArcadeShift';

/* ------------------------------------------------------ structural inputs */

/** The slice of the vehicle drift mode reads. Duck-typed, never imported. */
export interface DriftVehicle {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly speed: number;
  readonly isDrifting: boolean;
  readonly isAirborne: boolean;
  /** signed chassis slip angle, radians */
  readonly driftAngle?: number;
  /** roster id — `'jeep'`, `'bus'`, `'carriage'`. Absent means the Jeep. */
  readonly vehicleId?: string;
}

/** The slice of the world the arenas are derived from. */
export interface DriftWorld {
  pois: ReadonlyArray<POI>;
  roads?: RoadGraph;
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface DriftModeOptions {
  bus: EventBus;
  vehicle: DriftVehicle;
  world?: DriftWorld | null;
  save?: SaveSystem | null;
  /** seconds on the clock */
  duration?: number;
  /** contact impulse that snaps a chain */
  breakImpulse?: number;
}

/* ---------------------------------------------------------------- tuning */

/** How a given chassis is scored. Keyed off the roster id. */
export interface DriftCharacter {
  /** slip angle, radians, that counts as a full-value slide */
  refSlip: number;
  /** m/s that counts as full-value speed */
  refSpeed: number;
  /** below this the slide is not worth points */
  minSpeed: number;
  /** seconds between drifts before the chain lets go */
  linkWindow: number;
  /** points per second at full angle and full speed */
  rate: number;
  /** points per second of a released drift, paid once on release */
  releaseBonus: number;
  /** short label for the callout */
  verb: string;
}

/**
 * Reference slip angles are the same ones each tyre model charges its mini-turbo
 * against (`chargeSlipReference`), and the speed floors are its `minSpeed`. The
 * rate is inverted against how easy the slide is to hold: the carriage pays
 * most per second because it cannot hold one for very long.
 */
export const DRIFT_CHARACTER: Readonly<Record<string, DriftCharacter>> = {
  jeep: {
    refSlip: 0.7,
    refSpeed: 19,
    minSpeed: 8,
    linkWindow: 3.2,
    rate: 118,
    releaseBonus: 48,
    verb: 'DERRAPE',
  },
  bus: {
    /* it cannot get as sideways, so less counts as fully committed */
    refSlip: 0.6,
    refSpeed: 16,
    minSpeed: 9,
    /* a bus takes a whole block to set the next one up — be generous */
    linkWindow: 4.2,
    rate: 120,
    releaseBonus: 54,
    verb: 'PLANCHÓN',
  },
  carriage: {
    refSlip: 0.55,
    refSpeed: 12,
    /* a skid at jogging pace is the carriage's whole trick */
    minSpeed: 4.2,
    linkWindow: 3.6,
    rate: 124,
    releaseBonus: 50,
    verb: 'PATINAZO',
  },
};

const DEFAULT_CHARACTER: DriftCharacter = DRIFT_CHARACTER.jeep;

export const DRIFT_MODE = {
  /** seconds a run lasts before the results screen */
  duration: 180,
  /** most seconds the clock may hold, however many zones get claimed */
  maxSeconds: 300,
  /** seconds a claimed zone returns */
  claimTime: 18,

  /** a drift worth less than this does not extend the chain */
  minLinkScore: 55,
  /** seconds under `minSpeed` before the chain is considered dead */
  stopHold: 1.1,
  /** contact impulse that snaps a chain outright */
  breakImpulse: 2400,
  /** the pot has to be worth this much to be worth announcing */
  minBankAnnounce: 120,
  /**
   * A chain that never breaks never pays, and a score that has not moved in two
   * minutes is not a score. Topping the multiplier out cashes the pot for you,
   * with a bonus — the run's best moment, made reachable instead of theoretical.
   */
  maxChainBonus: 1.3,

  /** how often the chain badge is refreshed while a chain is alive, seconds */
  badgeInterval: 0.9,

  /** cash paid per point banked */
  cashPerPoint: 0.22,
  /** cash for claiming a zone */
  claimCash: 900,
} as const;

/** Links held → chain multiplier. Front-loaded, then it really opens up. */
const CHAIN_STEPS: readonly number[] = [1, 1.25, 1.6, 2, 2.5, 3, 3.6, 4.3, 5.2, 6.4, 8];

/** The shout when the chain multiplier crosses a step. */
const CHAIN_SHOUT: readonly string[] = [
  '',
  '¡ENGANCHA!',
  '¡SIGUE!',
  '¡SE FORMÓ!',
  '¡FUEGO!',
  '¡TREMENDO!',
  '¡BRUTAL!',
  '¡ESTO ES UN REVOLÚ!',
  '¡LOCO LIFT!',
  '¡LA PLAZA ES TUYA!',
  '¡SAN VIEJO COMPLETO!',
];

/* ------------------------------------------------------------------ zones */

export interface DriftZone {
  id: string;
  name: string;
  x: number;
  z: number;
  /** metres — a circle for an arena, a corridor half-width for the coast road */
  radius: number;
  /** score multiplier inside */
  multiplier: number;
  /** points that have to be banked inside to claim it */
  target: number;
  /** points banked inside so far */
  scored: number;
  claimed: boolean;
  /** corridor zones carry a polyline; arenas leave it empty */
  path: number[];
}

/** What each POI kind is worth as an arena, and how big it plays. */
const ZONE_KINDS: Readonly<
  Partial<Record<POI['kind'], { multiplier: number; scale: number; floor: number; target: number }>>
> = {
  plaza: { multiplier: 1.35, scale: 2.0, floor: 34, target: 4200 },
  market: { multiplier: 1.45, scale: 2.0, floor: 32, target: 4200 },
  fort: { multiplier: 1.55, scale: 1.7, floor: 46, target: 5200 },
  lookout: { multiplier: 1.25, scale: 1.8, floor: 28, target: 3200 },
  beach: { multiplier: 1.3, scale: 1.8, floor: 28, target: 3400 },
  dock: { multiplier: 1.2, scale: 1.7, floor: 30, target: 3400 },
};

/* ------------------------------------------------------------------ class */

export class DriftMode implements ShiftController {
  /**
   * Drift mode banks through the same challenge plumbing as the timed
   * challenges — one payout event, one record key, one best-score slot — so
   * nothing downstream needs to learn a new mode name.
   */
  readonly mode: GameMode = 'challenge';
  readonly timed = true;
  /** this mode drives the chain badge itself; the generic combo chain stands down */
  readonly ownsCombo = true;
  /** and there are no street fares in it */
  readonly suppressFares = true;

  private readonly bus: EventBus;
  private readonly vehicle: DriftVehicle;
  private world: DriftWorld | null;
  private readonly save: SaveSystem | null;
  private readonly duration: number;
  private readonly breakImpulse: number;

  private character: DriftCharacter = DEFAULT_CHARACTER;
  private characterId = 'jeep';

  private left = 0;
  private running = false;
  private ended = false;

  /** banked points — the number the run is judged on */
  private total = 0;
  /** points riding on the chain in progress */
  private pending = 0;
  private bestChain = 0;

  private links = 0;
  private multiplier = 1;
  private linkTimer = 0;
  private badgeTimer = 0;
  private slowTimer = 0;

  private wasDrifting = false;
  private driftSeconds = 0;
  private driftScore = 0;
  private peakSlip = 0;
  private bestSlip = 0;
  private drifts = 0;

  /** the zone the pot is being earned in, or -1 */
  private zoneIndex = -1;
  private lap = 1;

  private readonly zones: DriftZone[] = [];
  /** minimap pins for the arenas — reused, never rebuilt per frame */
  private readonly markers: Array<{ x: number; z: number }> = [];
  private readonly unsubs: Array<() => void> = [];

  constructor(opts: DriftModeOptions) {
    this.bus = opts.bus;
    this.vehicle = opts.vehicle;
    this.world = opts.world ?? null;
    this.save = opts.save ?? null;
    this.duration = Math.max(30, opts.duration ?? DRIFT_MODE.duration);
    this.breakImpulse = opts.breakImpulse ?? DRIFT_MODE.breakImpulse;
  }

  setWorld(w: DriftWorld | null): void {
    this.world = w;
  }

  /* ---------------------------------------------------------- inspection */

  get timeRemaining(): number {
    return this.left;
  }

  get finished(): boolean {
    return this.ended;
  }

  /** Points banked so far. The pot in progress is not included. */
  get score(): number {
    return this.total;
  }

  /** Points riding on the chain in progress. */
  get pendingScore(): number {
    return this.pending;
  }

  get chainLinks(): number {
    return this.links;
  }

  get chainMultiplier(): number {
    return this.multiplier;
  }

  /** Seconds left before the chain lets go; full while a slide is live. */
  get chainSeconds(): number {
    return this.wasDrifting ? this.character.linkWindow : Math.max(0, this.linkTimer);
  }

  /** Seconds a link may sit idle before the chain banks itself. */
  get chainWindow(): number {
    return this.character.linkWindow;
  }

  /**
   * 0..1 of the link window still standing — what the HUD's patience bar shows
   * in this mode. It *is* the chain timer.
   */
  get chainFraction(): number {
    const w = this.character.linkWindow;
    return w > 0 ? clamp01(this.chainSeconds / w) : 0;
  }

  get longestChain(): number {
    return this.bestChain;
  }

  /** Widest slip angle held this run, radians. */
  get peakSlipAngle(): number {
    return this.bestSlip;
  }

  get driftCount(): number {
    return this.drifts;
  }

  get zoneList(): ReadonlyArray<DriftZone> {
    return this.zones;
  }

  get zonesClaimed(): number {
    let n = 0;
    for (let i = 0; i < this.zones.length; i++) {
      if (this.zones[i].claimed) n++;
    }
    return n;
  }

  /** Which chassis this run is being scored as. */
  get vehicleCharacter(): string {
    return this.characterId;
  }

  /** The best previously recorded run for this chassis. */
  get personalBest(): number {
    if (!this.save) return 0;
    return this.save.current.challengeBest[recordKey(this.characterId)] ?? 0;
  }

  /** Minimap markers for the arenas — same shape the waiting-fare pins use. */
  get zoneMarkers(): ReadonlyArray<{ readonly x: number; readonly z: number }> {
    return this.markers;
  }

  /* --------------------------------------------------------------- start */

  start(): void {
    this.left = this.duration;
    this.running = false;
    this.ended = false;
    this.total = 0;
    this.pending = 0;
    this.bestChain = 0;
    this.links = 0;
    this.multiplier = 1;
    this.linkTimer = 0;
    this.badgeTimer = 0;
    this.slowTimer = 0;
    this.wasDrifting = false;
    this.driftSeconds = 0;
    this.driftScore = 0;
    this.peakSlip = 0;
    this.bestSlip = 0;
    this.drifts = 0;
    this.zoneIndex = -1;
    this.lap = 1;

    this.characterId = this.vehicle.vehicleId ?? 'jeep';
    this.character = DRIFT_CHARACTER[this.characterId] ?? DEFAULT_CHARACTER;

    this.buildZones();

    this.unsubscribe();
    this.unsubs.push(
      this.bus.on('vehicle:collision', (p) => {
        if (!this.running || p.impulse < this.breakImpulse) return;
        this.breakChain('golpe');
      }),
    );
    this.unsubs.push(this.bus.on('shift:timeAdded', (p) => this.addTime(p.seconds)));

    this.bus.emit('shift:start', { mode: this.mode, duration: this.duration });
    this.bus.emit('mission:start', {
      id: 'drift-mode',
      title: 'MODO DERRAPE',
      objective:
        this.zones.length > 0
          ? `Domina las ${this.zones.length} zonas. Encadena derrapes: la cadena solo paga cuando se rompe.`
          : 'Encadena derrapes. La cadena solo paga cuando se rompe.',
    });
    this.bus.emit('audio:music', { intensity: 0.82 });
    const best = this.personalBest;
    if (best > 0) {
      this.bus.emit('ui:toast', {
        text: `Récord ${labelFor(this.characterId)}: ${Math.round(best)}`,
        icon: 'star',
        ms: 3200,
      });
    }
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  private addTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.left = clamp(this.left + seconds, 0, DRIFT_MODE.maxSeconds);
  }

  /* --------------------------------------------------------------- zones */

  /**
   * Turn the world into arenas. Anything the city registered as open ground
   * becomes one; the coastal road becomes a corridor built from its own edges.
   * A world with neither still plays — the whole map scores at ×1.
   */
  private buildZones(): void {
    this.zones.length = 0;
    this.markers.length = 0;
    const world = this.world;
    if (!world) return;

    for (const poi of world.pois) {
      const def = ZONE_KINDS[poi.kind];
      if (!def) continue;
      this.zones.push({
        id: poi.id,
        name: poi.name,
        x: poi.pos.x,
        z: poi.pos.z,
        radius: Math.max(def.floor, poi.radius * def.scale),
        multiplier: def.multiplier,
        target: def.target,
        scored: 0,
        claimed: false,
        path: [],
      });
    }

    const corridor = this.buildCoastCorridor(world.roads);
    if (corridor) this.zones.push(corridor);

    /* keep it a set of destinations, not a checklist — the eight best ones */
    if (this.zones.length > 8) {
      this.zones.sort((a, b) => b.multiplier * b.radius - a.multiplier * a.radius);
      this.zones.length = 8;
    }
    for (const z of this.zones) this.markers.push({ x: z.x, z: z.z });
  }

  /**
   * The seaside run, as one long corridor rather than a circle. Every coastal
   * edge in the graph contributes its two endpoints; scoring tests the distance
   * to the nearest segment, so a sweeping slide down the whole thing counts
   * from end to end.
   */
  private buildCoastCorridor(roads: RoadGraph | undefined): DriftZone | null {
    if (!roads) return null;
    const path: number[] = [];
    let cx = 0;
    let cz = 0;
    let n = 0;
    let width = 0;
    for (const edge of roads.edges) {
      if (edge.kind !== 'coastal') continue;
      const a = roads.nodes[edge.a];
      const b = roads.nodes[edge.b];
      if (!a || !b) continue;
      path.push(a.pos.x, a.pos.z, b.pos.x, b.pos.z);
      cx += a.pos.x + b.pos.x;
      cz += a.pos.z + b.pos.z;
      n += 2;
      if (edge.width > width) width = edge.width;
    }
    if (n < 4) return null;
    return {
      id: '_coast-run',
      name: 'La Costanera',
      x: cx / n,
      z: cz / n,
      /* the road plus a car's width of apron either side */
      radius: Math.max(11, width * 0.5 + 5),
      multiplier: 1.4,
      target: 5600,
      scored: 0,
      claimed: false,
      path,
    };
  }

  /** Index of the zone containing `(x, z)`, or -1. Allocation-free. */
  private zoneAt(x: number, z: number): number {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < this.zones.length; i++) {
      const zone = this.zones[i];
      let inside = false;
      if (zone.path.length >= 4) {
        const r2 = zone.radius * zone.radius;
        for (let p = 0; p + 3 < zone.path.length; p += 4) {
          if (distToSegment2(x, z, zone.path[p], zone.path[p + 1], zone.path[p + 2], zone.path[p + 3]) <= r2) {
            inside = true;
            break;
          }
        }
      } else {
        const dx = x - zone.x;
        const dz = z - zone.z;
        inside = dx * dx + dz * dz <= zone.radius * zone.radius;
      }
      if (!inside) continue;
      /* overlapping arenas: the richer one wins */
      if (zone.multiplier > bestScore) {
        bestScore = zone.multiplier;
        best = i;
      }
    }
    return best;
  }

  /* --------------------------------------------------------------- frame */

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.left -= dt;

    const v = this.vehicle;
    const speed = Number.isFinite(v.speed) ? v.speed : 0;
    const rawSlip = v.driftAngle ?? 0;
    const slip = Number.isFinite(rawSlip) ? Math.abs(rawSlip) : 0;
    const C = this.character;

    const sliding = v.isDrifting && !v.isAirborne && speed >= C.minSpeed;

    if (sliding) {
      if (!this.wasDrifting) this.beginSlide();
      const angleF = clamp(slip / C.refSlip, 0, 1.7);
      const speedF = clamp(speed / C.refSpeed, 0.25, 1.6);
      /* the zone is fixed for the whole chain by whichever ground it started on
       * — a slide that leaves the plaza still gets paid for leaving it well */
      if (this.zoneIndex < 0) this.zoneIndex = this.zoneAt(v.position.x, v.position.z);
      const zoneMul = this.zoneIndex >= 0 ? this.zones[this.zoneIndex].multiplier : 1;

      const gain = C.rate * angleF * speedF * zoneMul * this.multiplier * dt;
      if (Number.isFinite(gain) && gain > 0) {
        this.pending += gain;
        this.driftScore += gain;
      }
      this.driftSeconds += dt;
      if (slip > this.peakSlip) this.peakSlip = slip;
      if (slip > this.bestSlip) this.bestSlip = slip;
      this.linkTimer = C.linkWindow;
      this.slowTimer = 0;
    } else {
      if (this.wasDrifting) this.endSlide();
      if (this.linkTimer > 0) {
        this.linkTimer -= dt;
        if (this.linkTimer <= 0) this.breakChain('cadena');
      }
      /* sitting still is a break even if the window has not run out */
      if (speed < C.minSpeed * 0.4) {
        this.slowTimer += dt;
        if (this.slowTimer >= DRIFT_MODE.stopHold && this.pending > 0) this.breakChain('parado');
      } else {
        this.slowTimer = 0;
      }
    }
    this.wasDrifting = sliding;

    /* zone claims are checked against the pot as it grows, not only on bank,
     * so the arena lights up the moment you have actually earned it */
    this.checkClaim();

    /* keep the chain badge lit for as long as the chain is actually alive */
    if (this.pending > 0 || this.links > 0) {
      this.badgeTimer -= dt;
      if (this.badgeTimer <= 0) {
        this.badgeTimer = DRIFT_MODE.badgeInterval;
        this.bus.emit('combo:multiplier', { multiplier: this.multiplier });
      }
    }

    if (this.left <= 0) {
      this.left = 0;
      this.finish();
    }
  }

  /* --------------------------------------------------------------- chain */

  private beginSlide(): void {
    this.driftSeconds = 0;
    this.driftScore = 0;
    this.peakSlip = 0;
    this.drifts++;
    this.bus.emit('audio:sfx', { id: 'tireScreech', volume: 0.55 });
  }

  /**
   * The slide ended. A slide worth having extends the chain and pays a release
   * bonus — the mini-turbo beat, in points — and one that fizzled simply leaves
   * the link window running.
   */
  private endSlide(): void {
    const scored = this.driftScore;
    const seconds = this.driftSeconds;
    this.driftSeconds = 0;
    this.driftScore = 0;
    if (scored < DRIFT_MODE.minLinkScore) return;

    const bonus = this.character.releaseBonus * Math.min(seconds, 6) * this.multiplier;
    if (Number.isFinite(bonus) && bonus > 0) this.pending += bonus;

    this.links++;
    const step = CHAIN_STEPS[Math.min(this.links, CHAIN_STEPS.length - 1)];
    if (step > this.multiplier) {
      this.multiplier = step;
      this.bus.emit('combo:multiplier', { multiplier: this.multiplier });
      this.badgeTimer = DRIFT_MODE.badgeInterval;
      const shout = CHAIN_SHOUT[Math.min(this.links, CHAIN_SHOUT.length - 1)];
      if (shout) this.bus.emit('ui:notice', { text: shout, big: false });
      this.bus.emit('audio:sfx', { id: 'comboUp', volume: 0.7 });
    }
    this.bus.emit('ui:toast', {
      text: `${this.character.verb} ×${this.links} · ${Math.round(this.pending)}`,
      icon: 'star',
      ms: 1200,
    });

    /* topped out — cash it in rather than letting the pot ride forever */
    if (this.links >= CHAIN_STEPS.length - 1) {
      this.pending *= DRIFT_MODE.maxChainBonus;
      this.bus.emit('ui:notice', { text: '¡CADENA MÁXIMA!', big: true });
      this.bus.emit('audio:sfx', { id: 'crowdCheer', volume: 0.8 });
      this.breakChain('fin');
    }
  }

  /**
   * Bank the pot. This is the only moment points become real, and the only
   * moment the run's score moves — which is why it gets the whole HUD.
   */
  private breakChain(reason: 'cadena' | 'parado' | 'golpe' | 'fin'): void {
    const pot = this.pending;
    const idx = this.zoneIndex;
    this.pending = 0;
    this.linkTimer = 0;
    this.slowTimer = 0;
    const links = this.links;
    this.links = 0;
    this.multiplier = 1;
    this.zoneIndex = -1;

    if (pot <= 0) {
      this.bus.emit('combo:break', { total: 0 });
      return;
    }

    const points = Math.round(pot);
    this.total += points;
    if (points > this.bestChain) this.bestChain = points;
    /* the arena the chain was earned in gets the credit toward its objective */
    if (idx >= 0 && idx < this.zones.length) this.zones[idx].scored += points;

    /* `ScoreSystem` banks `combo:add` as money, so the headline number on the
     * HUD is the drift score — one number, and it only ever moves on a bank */
    this.bus.emit('combo:add', {
      label: links > 1 ? `CADENA ×${links}` : this.character.verb,
      points,
    });
    this.bus.emit('combo:break', { total: points });
    if (points >= DRIFT_MODE.minBankAnnounce) {
      this.bus.emit('ui:notice', { text: `+${points}`, big: links >= 4 });
      this.bus.emit('audio:sfx', {
        id: reason === 'golpe' ? 'comboBreak' : 'cashRegister',
        volume: 0.75,
      });
    }
  }

  /* --------------------------------------------------------------- zones */

  private checkClaim(): void {
    const idx = this.zoneIndex;
    if (idx < 0) return;
    const zone = this.zones[idx];
    if (zone.claimed) return;
    /* the pot counts toward the arena it is being earned in, live */
    if (zone.scored + this.pending < zone.target) return;

    zone.claimed = true;
    zone.scored = zone.target;
    /* a claimed arena is worth more for the rest of the run */
    zone.multiplier += 0.25;

    /* the clock is topped up through the bus so the HUD's "+18s" lands with it */
    this.bus.emit('shift:timeAdded', { seconds: DRIFT_MODE.claimTime, reason: zone.name });
    this.bus.emit('ui:notice', { text: `ZONA DOMINADA · ${zone.name.toUpperCase()}`, big: true });
    this.bus.emit('audio:sfx', { id: 'timeExtend', volume: 0.8 });

    if (this.zonesClaimed >= this.zones.length && this.zones.length > 0) this.openNextLap();
  }

  /** Every arena claimed. Reset them harder rather than ending the run. */
  private openNextLap(): void {
    this.lap++;
    for (const z of this.zones) {
      z.claimed = false;
      z.scored = 0;
      z.target = Math.round(z.target * 1.6);
    }
    this.bus.emit('ui:notice', { text: `¡SAN VIEJO ES TUYO! VUELTA ${this.lap}`, big: true });
    this.bus.emit('audio:sfx', { id: 'crowdCheer', volume: 0.85 });
    this.bus.emit('shift:timeAdded', {
      seconds: DRIFT_MODE.claimTime * 1.5,
      reason: `Vuelta ${this.lap}`,
    });
  }

  /* -------------------------------------------------------------- finish */

  private finish(): void {
    if (this.ended) return;
    /* whatever was still riding on the chain lands before the results screen */
    if (this.pending > 0) this.breakChain('fin');
    this.ended = true;
    this.running = false;

    const payout = Math.round(
      this.total * DRIFT_MODE.cashPerPoint + this.zonesClaimed * DRIFT_MODE.claimCash,
    );
    const best = this.personalBest;
    const rating = clamp(Math.round((this.total / 26_000) * 10) / 2, 0, 5);
    const result: FareResult = {
      base: Math.round(payout * 0.55),
      distanceBonus: 0,
      timeBonus: 0,
      comboBonus: Math.round(payout * 0.45),
      tip: 0,
      total: payout,
      rating,
      grade: this.total > best ? '¡Récord!' : gradeFor(rating),
    };
    this.bus.emit('mission:complete', { id: 'drift-mode', result });
    this.bus.emit('audio:music', { intensity: 0.4 });

    this.record();
  }

  /** Personal bests: overall, per chassis, and the single best chain. */
  private record(): void {
    const save = this.save;
    if (!save) return;
    const total = Math.round(this.total);
    const chain = Math.round(this.bestChain);
    const key = recordKey(this.characterId);
    save.update((d) => {
      if (total > (d.challengeBest['drift-mode'] ?? 0)) d.challengeBest['drift-mode'] = total;
      if (total > (d.challengeBest[key] ?? 0)) d.challengeBest[key] = total;
      if (chain > (d.challengeBest['drift-chain'] ?? 0)) d.challengeBest['drift-chain'] = chain;
    });
  }

  stop(): void {
    if (!this.ended) this.finish();
    this.running = false;
    this.unsubscribe();
  }

  private unsubscribe(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  dispose(): void {
    this.unsubscribe();
    this.zones.length = 0;
    this.markers.length = 0;
  }
}

/* ----------------------------------------------------------------- helpers */

/** `SaveSystem.challengeBest` key for a chassis. */
export function recordKey(vehicleId: string): string {
  return `drift-mode:${vehicleId}`;
}

function labelFor(vehicleId: string): string {
  if (vehicleId === 'bus') return 'la guagua';
  if (vehicleId === 'carriage') return 'el coche';
  return 'el jeep';
}

function gradeFor(rating: number): string {
  if (rating >= 4.5) return '¡Brutal!';
  if (rating >= 3.5) return '¡Se formó!';
  if (rating >= 2.5) return 'Buen revolú';
  if (rating >= 1.5) return 'Vas cogiendo';
  return 'Otra vuelta';
}

/** Squared distance from a point to a segment. No allocation. */
function distToSegment2(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp01(((px - ax) * dx + (pz - az) * dz) / len2) : 0;
  const cx = ax + dx * t - px;
  const cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}
