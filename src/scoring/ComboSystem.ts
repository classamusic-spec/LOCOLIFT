/**
 * Loco Lift — the combo chain.
 *
 * This is the fun. Every stylish thing the Jeep does — a drift, a near miss, a
 * jump, an air trick, a smashed crate, two wheels down an alley — feeds one
 * chain. The chain has a multiplier that climbs the longer you keep it alive
 * and a decay window that gets *shorter* as the multiplier climbs, so a big
 * combo is a tightrope rather than a plateau.
 *
 * Two feedback loops make it self-sustaining:
 *
 *  1. **Boost.** Every link pushes boost back into the Jeep, and a multiplier
 *     step-up dumps a fat chunk in. Going fast earns the boost that lets you go
 *     faster, which is the whole arcade contract.
 *  2. **Money.** `ScoreSystem` banks every `combo:add`, and `FareModel` pays a
 *     combo line and a fatter tip on the fare you happened to be carrying.
 *
 * A heavy collision snaps the chain instantly. Light taps do not — bouncing off
 * a fruit stand at 70 mph should feel like part of the run, not a punishment.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import type { ComboEvent, EventKey, EventMap, GameContext, System } from '../core/types';

/* ------------------------------------------------------ structural inputs */

/** The slice of the Jeep the combo system touches. Duck-typed, never imported. */
export interface ComboVehicle {
  readonly position: THREE.Vector3;
  readonly speed: number;
  /** 0..1 meter refill from combos and near misses */
  addBoost(amount: number): void;
}

export interface ComboSystemOptions {
  bus: EventBus;
  vehicle?: ComboVehicle | null;
  /** contact impulse (N·s) that snaps the chain */
  breakImpulse?: number;
  /** contact impulse (N·s) that a passenger experiences as a real crash */
  heavyImpulse?: number;
}

/* ---------------------------------------------------------------- tuning */

export const COMBO = {
  /** seconds the chain survives with no new link, at ×1 */
  baseWindow: 4.4,
  /** the window shrinks by this per multiplier step … */
  windowPerStep: 0.25,
  /** … but never below this */
  minWindow: 1.7,

  maxMultiplier: 20,

  /** boost meter refill per link */
  boostPerLink: 0.028,
  /** extra refill per multiplier step held */
  boostPerStep: 0.011,
  /** the big payoff when the multiplier ticks up */
  boostOnStepUp: 0.11,
  /** boost fed back per link, hard ceiling */
  boostPerLinkMax: 0.16,

  /**
   * The Jeep scores drifts and jumps on its own internal scale (hundreds to
   * thousands of points). The HUD's headline number is labelled **TARIFA** and
   * is read as money, so everything is converted into the same currency before
   * it reaches the player. Without this a single drift would out-earn a fare by
   * three orders of magnitude and the whole readout would stop meaning anything.
   */
  vehiclePointScale: 0.035,
  /** never let a link round away to nothing */
  minLinkPoints: 2,

  /** two near misses inside this window is a clean overtake */
  overtakeWindow: 1.25,
  overtakePoints: 18,

  /** dollar values for the things the vehicle does not score itself */
  nearMissBase: 9,
  nearMissPerSpeed: 0.5,
  twoWheelsBase: 7,
  twoWheelsPerSecond: 8,

  /** collisions */
  breakImpulse: 2200,
  heavyImpulse: 2600,
} as const;

/** Chain length → multiplier. Front-loaded so the first steps feel immediate. */
const MULT_STEPS: readonly number[] = [0, 2, 4, 6, 9, 12, 16, 20, 25, 30, 36, 43, 51, 60, 70, 81, 93, 106, 120, 135];

function multiplierFor(chain: number): number {
  let m = 1;
  for (let i = 1; i < MULT_STEPS.length; i++) {
    if (chain >= MULT_STEPS[i]) m = i + 1;
    else break;
  }
  return Math.min(COMBO.maxMultiplier, m);
}

/** The shout that lands when the multiplier crosses a milestone. */
const TIER_SHOUT: ReadonlyArray<{ at: number; text: string }> = [
  { at: 2, text: '¡DALE!' },
  { at: 3, text: '¡ENCENDÍO!' },
  { at: 4, text: '¡SE FORMÓ!' },
  { at: 5, text: '¡FUEGO!' },
  { at: 6, text: '¡TREMENDO!' },
  { at: 8, text: '¡BRUTAL!' },
  { at: 10, text: '¡ESTO ES UN REVOLÚ!' },
  { at: 14, text: '¡LOCO LIFT!' },
  { at: 20, text: '¡LA CIUDAD ES TUYA!' },
];

/* -------------------------------------------------------------- payloads */

/**
 * `combo:add` payloads are handed to listeners that may hold them for a frame
 * (the HUD copies, but audio positions are read late). A tiny ring of
 * preallocated payloads keeps the hot path allocation-free and safe.
 */
const RING = 8;

/* ------------------------------------------------------------------ class */

export class ComboSystem implements System {
  readonly name = 'combo';

  private readonly bus: EventBus;
  private vehicle: ComboVehicle | null;
  private readonly breakImpulse: number;
  private readonly heavyImpulse: number;

  private active = false;
  private chain = 0;
  private mult = 1;
  private chainPoints = 0;
  private timer = 0;
  private window: number = COMBO.baseWindow;

  private peak = 1;
  private banked = 0;
  private links = 0;
  private biggestChain = 0;

  private lastNearMissAt = -100;
  private elapsed = 0;

  private readonly payloads: ComboEvent[] = [];
  private readonly points: THREE.Vector3[] = [];
  private cursor = 0;

  private readonly multPayload = { multiplier: 1 };
  private readonly breakPayload = { total: 0 };

  private readonly unsubs: Array<() => void> = [];

  constructor(opts: ComboSystemOptions) {
    this.bus = opts.bus;
    this.vehicle = opts.vehicle ?? null;
    this.breakImpulse = opts.breakImpulse ?? COMBO.breakImpulse;
    this.heavyImpulse = opts.heavyImpulse ?? COMBO.heavyImpulse;

    for (let i = 0; i < RING; i++) {
      this.points.push(new THREE.Vector3());
      this.payloads.push({ label: '', points: 0, at: this.points[i] });
    }
  }

  /* ---------------------------------------------------------------- wiring */

  setVehicle(v: ComboVehicle | null): void {
    this.vehicle = v;
  }

  init(ctx: GameContext): void {
    this.subscribe(ctx.bus);
  }

  private subscribe(bus: EventBus): void {
    const on = <K extends EventKey>(key: K, fn: (p: EventMap[K]) => void): void => {
      this.unsubs.push(bus.on(key, fn));
    };

    on('vehicle:driftEnd', (p) => {
      if (p.points <= 0) return;
      this.add(driftLabel(p.duration), fromVehicle(p.points));
    });

    on('vehicle:jumpLand', (p) => {
      if (p.points <= 0) return;
      this.add(jumpLabel(p.airtime, p.height, p.clean), fromVehicle(p.points));
    });

    on('vehicle:airTrick', (p) => {
      if (p.points <= 0) return;
      this.add(p.name.toUpperCase(), fromVehicle(p.points));
    });

    on('vehicle:twoWheels', (p) => {
      const pts = COMBO.twoWheelsBase + p.duration * COMBO.twoWheelsPerSecond;
      this.add('DOS RUEDAS', pts);
    });

    on('vehicle:nearMiss', (p) => {
      const pts = COMBO.nearMissBase + Math.max(0, p.speed) * COMBO.nearMissPerSpeed;
      this.add('¡CASI!', pts, p.at);
      /* two in quick succession reads as threading traffic, not luck */
      if (this.elapsed - this.lastNearMissAt < COMBO.overtakeWindow) {
        this.add('¡LIMPIO!', COMBO.overtakePoints, p.at);
        this.lastNearMissAt = -100;
      } else {
        this.lastNearMissAt = this.elapsed;
      }
    });

    on('prop:destroyed', (p) => {
      if (p.points <= 0) return;
      this.add(propLabel(p.kind), fromVehicle(p.points), p.at);
    });

    on('vehicle:collision', (p) => {
      if (p.impulse >= this.breakImpulse) this.break();
    });

    on('vehicle:reset', () => this.break());
  }

  /* --------------------------------------------------------------- control */

  /** Chains only build while a shift is live. */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) this.break();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Wipe everything, including shift-scoped records. */
  reset(): void {
    this.chain = 0;
    this.mult = 1;
    this.chainPoints = 0;
    this.timer = 0;
    this.window = COMBO.baseWindow;
    this.peak = 1;
    this.banked = 0;
    this.links = 0;
    this.biggestChain = 0;
    this.lastNearMissAt = -100;
  }

  /* ----------------------------------------------------------- inspection */

  get multiplier(): number {
    return this.mult;
  }

  get peakMultiplier(): number {
    return this.peak;
  }

  /** Points banked across the whole shift — diff it to get a per-ride tally. */
  get pointsBanked(): number {
    return this.banked;
  }

  get chainLength(): number {
    return this.chain;
  }

  get longestChain(): number {
    return this.biggestChain;
  }

  get linkCount(): number {
    return this.links;
  }

  /** 0..1 — how much of the decay window is left. */
  get chainFraction(): number {
    return this.window > 0 ? clamp01(this.timer / this.window) : 0;
  }

  /** True when an impulse is hard enough that a passenger felt it as a crash. */
  isHeavy(impulse: number): boolean {
    return impulse >= this.heavyImpulse;
  }

  /* -------------------------------------------------------------- the link */

  /**
   * Add one link. `basePoints` is pre-multiplier; the emitted `combo:add`
   * carries the multiplied value, which is what the score and HUD use.
   */
  add(label: string, basePoints: number, at?: THREE.Vector3): void {
    if (!this.active) return;
    if (!Number.isFinite(basePoints) || basePoints <= 0) return;

    const before = this.mult;
    this.chain++;
    this.links++;
    this.mult = multiplierFor(this.chain);
    if (this.mult > this.peak) this.peak = this.mult;
    if (this.chain > this.biggestChain) this.biggestChain = this.chain;

    this.window = clamp(
      COMBO.baseWindow - (this.mult - 1) * COMBO.windowPerStep,
      COMBO.minWindow,
      COMBO.baseWindow,
    );
    this.timer = this.window;

    const points = Math.round(basePoints * this.mult);
    this.chainPoints += points;
    this.banked += points;

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % RING;
    const payload = this.payloads[i];
    payload.label = label;
    payload.points = points;
    if (at) {
      this.points[i].copy(at);
      payload.at = this.points[i];
    } else if (this.vehicle) {
      this.points[i].copy(this.vehicle.position);
      payload.at = this.points[i];
    } else {
      payload.at = undefined;
    }
    this.bus.emit('combo:add', payload);

    /* boost feedback — this is what makes a chain accelerate itself */
    const v = this.vehicle;
    if (v) {
      let boost = COMBO.boostPerLink + (this.mult - 1) * COMBO.boostPerStep;
      if (this.mult > before) boost += COMBO.boostOnStepUp;
      v.addBoost(Math.min(COMBO.boostPerLinkMax, boost));
    }

    if (this.mult > before) {
      this.multPayload.multiplier = this.mult;
      this.bus.emit('combo:multiplier', this.multPayload);
      const shout = shoutFor(before, this.mult);
      if (shout) this.bus.emit('ui:notice', { text: shout, big: this.mult >= 8 });
    }
  }

  /** End the chain now. Safe to call when nothing is running. */
  break(): void {
    if (this.chain === 0) {
      this.timer = 0;
      return;
    }
    this.breakPayload.total = this.chainPoints;
    this.chain = 0;
    this.mult = 1;
    this.chainPoints = 0;
    this.timer = 0;
    this.window = COMBO.baseWindow;
    this.lastNearMissAt = -100;
    this.bus.emit('combo:break', this.breakPayload);
  }

  /* ---------------------------------------------------------------- frame */

  update(_ctx: GameContext, dt: number): void {
    this.elapsed += dt;
    if (!this.active || this.chain === 0) return;
    this.timer -= dt;
    if (this.timer <= 0) this.break();
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.vehicle = null;
  }
}

/* --------------------------------------------------------------- helpers */

/** Convert the vehicle's internal trick score into the game's currency. */
function fromVehicle(points: number): number {
  return Math.max(COMBO.minLinkPoints, points * COMBO.vehiclePointScale);
}

/* --------------------------------------------------------------- labels */

function driftLabel(duration: number): string {
  if (duration >= 5) return '¡DERRAPE ETERNO!';
  if (duration >= 3) return '¡DERRAPAZO!';
  if (duration >= 1.6) return 'DERRAPE LARGO';
  return 'DERRAPE';
}

function jumpLabel(airtime: number, height: number, clean: boolean): string {
  if (airtime >= 2.2) return '¡VUELO SIN MOTOR!';
  if (height >= 6) return '¡POR ENCIMA DEL TEJADO!';
  if (airtime >= 1.2) return clean ? '¡SALTO LIMPIO!' : '¡SALTAZO!';
  return 'SALTO';
}

function propLabel(kind: string): string {
  switch (kind) {
    case 'cone':
      return 'CONO VOLADOR';
    case 'crate':
      return 'CAJÓN AL AIRE';
    case 'sign':
      return 'RÓTULO FUERA';
    case 'chair':
      return 'SILLA AL AIRE';
    case 'table':
      return 'MESA FUERA';
    case 'planter':
      return 'MACETA FUERA';
    case 'barrel':
      return 'BARRIL RODANDO';
    case 'trash':
      return 'ZAFACÓN VOLANDO';
    default:
      return '¡DESTROZO!';
  }
}

function shoutFor(from: number, to: number): string | null {
  let best: string | null = null;
  for (const tier of TIER_SHOUT) {
    if (tier.at > from && tier.at <= to) best = tier.text;
  }
  return best;
}
