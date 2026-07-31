/**
 * Loco Lift — the money.
 *
 * A fare is scored on four axes and paid on five lines:
 *
 *   base           the flag drop, scaled by who you picked up
 *   distanceBonus  how far they actually needed to go
 *   timeBonus      how much of par you gave back
 *   comboBonus     how much style you carried while they were aboard
 *   tip            how they *felt* about it — the only line the player
 *                  controls with their hands rather than the map
 *
 * The tip is deliberately the biggest single swing available on a short ride:
 * a clean fast run for a thrill-seeker who you drifted the whole way is worth
 * roughly double the same run driven like a driving-test examiner. That is the
 * lever that makes "drive like a maniac, but the *right* maniac" the game.
 *
 * Everything here is pure: same input, same `FareResult`, no allocation beyond
 * the result object itself, and every division is guarded so a zero-length
 * route can never produce NaN.
 */
import { clamp, clamp01 } from '../core/MathUtils';
import type { FareResult, PassengerArchetype } from '../core/types';

/* ---------------------------------------------------------------- tuning */

export const FARE = {
  /** flag drop before the archetype multiplier */
  flag: 42,
  /** dollars per metre of route, before the multiplier */
  perMetre: 0.45,
  /** most a perfectly-fast delivery can add */
  timeMax: 210,
  /**
   * Combo points are already dollars (`ComboSystem` converts the Jeep's trick
   * scale into the game's currency), so this line simply *reports* the style
   * money earned since the last delivery. `ScoreSystem` has already banked it
   * live, which is why it deducts this line when paying the fare — the results
   * screen and the HUD then agree.
   */
  perComboPoint: 1,
  /**
   * Effectively uncapped: this line only *reports* money the player has already
   * been paid, so clipping it would make the fare over-pay by the clipped
   * amount. The guard is here purely to stop a corrupt input running away.
   */
  comboCap: 250_000,
  /** dollars per multiplier step held at the peak */
  perComboStep: 20,
  /** most a delighted passenger will tip, before the multiplier */
  tipMax: 150,

  /** m/s the fare model considers "getting on with it" */
  parSpeed: 12.5,
  /** seconds of grace on top of the pure travel time */
  parGrace: 7,
  /** ride deadline = par * this + parGrace */
  allowanceScale: 1.85,

  /** seconds added to the shift clock, floor and ceiling */
  timeAwardMin: 5,
  timeAwardMax: 19,
} as const;

/* ----------------------------------------------------------------- input */

export interface RideRecord {
  archetype: PassengerArchetype;
  /** straight-line pickup → destination at the moment of pickup, metres */
  routeDistance: number;
  /** metres actually driven with them aboard */
  driven: number;
  /** seconds from pickup to dropoff */
  elapsed: number;
  /** the ride's par time, from `parTimeFor` */
  parTime: number;
  /** final comfort, -1..1 */
  comfort: number;
  drifts: number;
  jumps: number;
  tricks: number;
  nearMisses: number;
  crashes: number;
  heavyCrashes: number;
  shortcuts: number;
  /** highest multiplier reached while they were aboard */
  comboPeak: number;
  /** combo points banked while they were aboard */
  comboPoints: number;
  /** how close they came to bailing, 0..1 */
  terror: number;
  /** extra cash from a special mission */
  missionBonus: number;
}

export function blankRide(archetype: PassengerArchetype): RideRecord {
  return {
    archetype,
    routeDistance: 0,
    driven: 0,
    elapsed: 0,
    parTime: 1,
    comfort: 0,
    drifts: 0,
    jumps: 0,
    tricks: 0,
    nearMisses: 0,
    crashes: 0,
    heavyCrashes: 0,
    shortcuts: 0,
    comboPeak: 1,
    comboPoints: 0,
    terror: 0,
    missionBonus: 0,
  };
}

/* -------------------------------------------------------------- schedule */

/** How long a competent driver should need for this route. */
export function parTimeFor(routeDistance: number): number {
  const d = Number.isFinite(routeDistance) ? Math.max(0, routeDistance) : 0;
  return d / FARE.parSpeed + FARE.parGrace;
}

/** How long before the passenger gives up mid-ride. */
export function rideAllowanceFor(parTime: number): number {
  const p = Number.isFinite(parTime) ? Math.max(1, parTime) : 1;
  return p * FARE.allowanceScale + FARE.parGrace;
}

/* --------------------------------------------------------------- scoring */

interface Axes {
  speed: number;
  mood: number;
  safety: number;
  style: number;
}

/** Every field is player-supplied through a long simulation; none of it is trusted. */
function num(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function axesFor(r: RideRecord): Axes {
  const par = r.parTime > 0 && Number.isFinite(r.parTime) ? r.parTime : 1;
  const elapsed = Math.max(0, num(r.elapsed, par));

  /* 0.6× par is a full mark, par itself is roughly half, 1.35× par is a zero */
  const speed = clamp01((1.35 - elapsed / par) / 0.75);
  const mood = clamp01((clamp(num(r.comfort, 0), -1, 1) + 1) * 0.5);
  const safety = clamp01(
    1 -
      Math.max(0, num(r.crashes, 0)) * 0.11 -
      Math.max(0, num(r.heavyCrashes, 0)) * 0.2 -
      clamp01(num(r.terror, 0)) * 0.25,
  );

  const peak = Math.max(1, num(r.comboPeak, 1));
  const pts = Math.max(0, num(r.comboPoints, 0));
  const style = clamp01(clamp01((peak - 1) / 6) * 0.65 + clamp01(pts / 1400) * 0.35);

  return { speed, mood, safety, style };
}

/** 0..5 stars, in half-star steps so the results screen can draw them. */
export function ratingFor(r: RideRecord): number {
  const a = axesFor(r);
  const raw = a.speed * 0.34 + a.mood * 0.28 + a.safety * 0.22 + a.style * 0.16;
  if (!Number.isFinite(raw)) return 0;
  return clamp(Math.round(raw * 10) / 2, 0, 5);
}

/** Punchy, in the register a San Juan passenger would actually use. */
export function gradeForRating(rating: number): string {
  if (!Number.isFinite(rating)) return 'Ay bendito…';
  if (rating >= 4.75) return '¡Brutal!';
  if (rating >= 4) return '¡Tremendo!';
  if (rating >= 3.25) return '¡Chévere!';
  if (rating >= 2.5) return 'Bien ahí';
  if (rating >= 1.5) return 'Se puede mejorar';
  if (rating >= 0.5) return 'Ay bendito…';
  return 'Un revolú';
}

/* ------------------------------------------------------------- the payout */

export function computeFare(r: RideRecord): FareResult {
  const mult = Number.isFinite(r.archetype.fareMultiplier) ? Math.max(0.1, r.archetype.fareMultiplier) : 1;
  const dist = Number.isFinite(r.routeDistance) ? Math.max(0, r.routeDistance) : 0;
  const a = axesFor(r);

  const base = round2(FARE.flag * mult);
  const distanceBonus = round2(dist * FARE.perMetre * mult);
  const timeBonus = round2(a.speed * FARE.timeMax * mult);

  const comboRaw =
    Math.min(FARE.comboCap, Math.max(0, num(r.comboPoints, 0)) * FARE.perComboPoint) +
    Math.max(0, num(r.comboPeak, 1) - 1) * FARE.perComboStep;
  const comboBonus = round2(comboRaw);

  /* the tip is mostly how they felt, seasoned with speed and survival */
  const tipFactor = clamp01(a.mood * 0.55 + a.speed * 0.28 + a.safety * 0.17);
  const shaped = Math.pow(tipFactor, 1.35);
  const tip = round2(FARE.tipMax * mult * shaped);

  const bonus = Math.max(0, num(r.missionBonus, 0));
  const rating = ratingFor(r);

  const total = round2(base + distanceBonus + timeBonus + comboBonus + tip + bonus);

  return {
    base,
    distanceBonus,
    timeBonus,
    comboBonus,
    tip: round2(tip + bonus),
    total,
    rating,
    grade: gradeForRating(rating),
  };
}

/**
 * What the HUD shows on the passenger card at pickup: base + distance plus a
 * middling time bonus, so the number the player sees is honest but beatable.
 */
export function estimateFare(archetype: PassengerArchetype, routeDistance: number): number {
  const mult = Number.isFinite(archetype.fareMultiplier) ? Math.max(0.1, archetype.fareMultiplier) : 1;
  const d = Number.isFinite(routeDistance) ? Math.max(0, routeDistance) : 0;
  return Math.round((FARE.flag + d * FARE.perMetre + FARE.timeMax * 0.45) * mult);
}

/** A failed fare still produces a result so the results screen stays coherent. */
export function failedFare(archetype: PassengerArchetype, reason: 'timeout' | 'terrified'): FareResult {
  return {
    base: 0,
    distanceBonus: 0,
    timeBonus: 0,
    comboBonus: 0,
    tip: 0,
    total: 0,
    rating: 0,
    grade: reason === 'terrified' ? 'Se tiró en marcha' : `${archetype.name} se cansó`,
  };
}

/** Seconds of shift clock a delivery buys back. */
export function timeAwardFor(result: FareResult, routeDistance: number): number {
  const d = Number.isFinite(routeDistance) ? Math.max(0, routeDistance) : 0;
  const stars = Number.isFinite(result.rating) ? clamp(result.rating, 0, 5) : 0;
  const raw = 5.5 + stars * 1.7 + d / 105;
  return clamp(Math.round(raw * 10) / 10, FARE.timeAwardMin, FARE.timeAwardMax);
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
