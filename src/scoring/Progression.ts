/**
 * Loco Lift — reputation, unlocks and the reason to come back tomorrow.
 *
 * Three loops sit on top of the shift:
 *
 *  1. **Reputation.** Every clean delivery, every mission, every challenge pays
 *     *rep*, which is a separate currency from cash: cash is spent, rep is
 *     earned and never lost, and rank is what actually gates the harder jobs.
 *     Driving well raises rank faster than driving far — a five-star fare pays
 *     roughly three times what a one-star fare does.
 *
 *  2. **The garage.** Cash buys liveries, rims, accessories, horns, mechanical
 *     upgrades and — the big one — the Chinchorreo bus. Everything is priced so
 *     the first purchase lands inside the second or third shift and the bus is
 *     an evening's work (or reaching chapter 6 of the campaign, which hands it
 *     over free).
 *
 *  3. **La ruta del día.** Three jobs rotate on a real calendar day, seeded off
 *     the date so every player on a given day gets the same three, each paying
 *     a fat multiplier the first time it is cleared that day.
 *
 * Everything persists through `SaveSystem` and nothing else: `bank` for cash,
 * `unlocked` for parts, `storyComplete` for the spine, and the free-form
 * `challengeBest` map for rep, personal bests and daily bookkeeping.
 */
import type { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import type { EventKey, EventMap, FareResult, System } from '../core/types';
import type { SaveSystem } from '../save/SaveSystem';
import { ALL_MISSIONS, STORY_ORDER, type SpecialMissionDef } from '../passengers/MissionCatalog';

/* --------------------------------------------------------------- storage */

/** Free-form keys inside `SaveData.challengeBest`. Namespaced so nothing clashes. */
export const SAVE_KEYS = {
  rep: 'rep.xp',
  partyBest: 'pb.chinchorreo',
  partyRuns: 'pb.chinchorreo.runs',
  bestFareValue: 'pb.bestFare',
  bestShiftCash: 'pb.shiftCash',
  longestChain: 'pb.longestChain',
  dailyDay: 'daily.day',
  dailyDone: 'daily.done',
} as const;

/* ----------------------------------------------------------------- ranks */

export interface RankDef {
  /** 0-based index; `rank` everywhere else in the codebase means this number */
  index: number;
  name: string;
  /** rep required to reach it */
  rep: number;
  /** one line the toast uses when the player arrives */
  blurb: string;
}

export const RANKS: readonly RankDef[] = [
  { index: 0, name: 'Novato', rep: 0, blurb: 'Primer día. Todo el mundo empieza aquí.' },
  { index: 1, name: 'Chofer de Confianza', rep: 450, blurb: 'Ya te repiten. Eso vale más que la propina.' },
  { index: 2, name: 'Conocedor del Casco', rep: 1300, blurb: 'Te sabes los callejones. Todos.' },
  { index: 3, name: 'Piloto de la Costa', rep: 2900, blurb: 'La carretera del mar es tuya.' },
  { index: 4, name: 'Veterano de Piñones', rep: 5400, blurb: 'Te saludan en todos los chinchorros.' },
  { index: 5, name: 'Dueño de la Noche', rep: 9200, blurb: 'Nadie mueve gente a las tres como tú.' },
  { index: 6, name: 'Leyenda del Adoquín', rep: 14500, blurb: 'Ya te cuentan como cuento.' },
  { index: 7, name: 'El Que Nunca Falla', rep: 22000, blurb: 'Si tú dices que llegas, llegas.' },
  { index: 8, name: 'Loco Lift', rep: 34000, blurb: 'La ciudad entera se monta contigo.' },
];

export function rankForRep(rep: number): RankDef {
  const r = Number.isFinite(rep) ? Math.max(0, rep) : 0;
  let out = RANKS[0];
  for (const rank of RANKS) {
    if (r >= rank.rep) out = rank;
    else break;
  }
  return out;
}

/** 0..1 toward the next rank; 1 at the cap. */
export function rankProgress(rep: number): number {
  const cur = rankForRep(rep);
  const next = RANKS[cur.index + 1];
  if (!next) return 1;
  const span = next.rep - cur.rep;
  return span > 0 ? clamp01((rep - cur.rep) / span) : 1;
}

/* --------------------------------------------------------------- unlocks */

export type UnlockKind = 'vehicle' | 'livery' | 'rims' | 'accessory' | 'horn' | 'upgrade';

export interface UnlockDef {
  id: string;
  kind: UnlockKind;
  name: string;
  blurb: string;
  /** cash price; 0 means it is rank- or story-granted only */
  cost: number;
  /** reputation rank required before it can even be bought */
  minRank: number;
  /** granted free the moment this rank is reached */
  freeAtRank?: number;
}

/**
 * The garage. Ids match what `TitleScreen` renders (`LIVERIES`, `RIMS`) and what
 * `SaveData.jeep` stores, so unlocking one immediately shows up in the garage.
 */
export const UNLOCKS: readonly UnlockDef[] = [
  /* --- vehicles ------------------------------------------------------- */
  {
    id: 'bus',
    kind: 'vehicle',
    name: 'La Guagua del Chinchorreo',
    blurb: 'Guagua escolar retirada, amarilla, con luces. Pesa una tonelada y no le importa.',
    cost: 90000,
    minRank: 3,
  },

  /* --- liveries ------------------------------------------------------- */
  { id: 'coquí', kind: 'livery', name: 'Coquí', blurb: 'Verde de monte con el coquí en la puerta.', cost: 6000, minRank: 0 },
  { id: 'bandera', kind: 'livery', name: 'Bandera', blurb: 'La de siempre. Nunca falla.', cost: 18000, minRank: 1, freeAtRank: 2 },
  { id: 'flamboyán', kind: 'livery', name: 'Flamboyán', blurb: 'Rojo de junio, el que se ve desde la carretera.', cost: 42000, minRank: 3 },
  { id: 'garita', kind: 'livery', name: 'Garita', blurb: 'Piedra y sal, como la muralla.', cost: 95000, minRank: 5 },

  /* --- rims ----------------------------------------------------------- */
  { id: 'chrome', kind: 'rims', name: 'Cromadas', blurb: 'Se ven desde la otra acera.', cost: 9000, minRank: 0 },
  { id: 'beadlock', kind: 'rims', name: 'Beadlock', blurb: 'Para cuando la calle no es calle.', cost: 28000, minRank: 2 },
  { id: 'gold', kind: 'rims', name: 'Doradas', blurb: 'Sin comentarios.', cost: 120000, minRank: 6 },

  /* --- accessories ---------------------------------------------------- */
  { id: 'surfrack', kind: 'accessory', name: 'Parrilla de tablas', blurb: 'Tato va a querer que la uses.', cost: 4500, minRank: 0 },
  { id: 'cooler', kind: 'accessory', name: 'Nevera trasera', blurb: 'Hielo, agua de coco y paz.', cost: 8500, minRank: 1 },
  { id: 'palmtree', kind: 'accessory', name: 'Palmita de guía', blurb: 'Decorativa. Absolutamente decorativa.', cost: 14000, minRank: 2 },
  { id: 'stringlights', kind: 'accessory', name: 'Bombillitas', blurb: 'Luces de chinchorro por todo el techo.', cost: 26000, minRank: 3 },

  /* --- horns ---------------------------------------------------------- */
  { id: 'bocina-plena', kind: 'horn', name: 'Bocina de plena', blurb: 'Pita en clave. Nadie se molesta.', cost: 4000, minRank: 0 },
  { id: 'bocina-coqui', kind: 'horn', name: 'Bocina coquí', blurb: 'Co-quí. Co-quí. Toda la noche.', cost: 11000, minRank: 1 },
  { id: 'bocina-barco', kind: 'horn', name: 'Sirena de barco', blurb: 'Innecesaria. Imprescindible.', cost: 55000, minRank: 4 },

  /* --- upgrades ------------------------------------------------------- */
  {
    id: 'upgrade-turbo',
    kind: 'upgrade',
    name: 'Turbo del panita',
    blurb: 'El boost carga más rápido. Lo instaló un pana, no preguntes.',
    cost: 24000,
    minRank: 1,
  },
  {
    id: 'upgrade-suspension',
    kind: 'upgrade',
    name: 'Suspensión de adoquín',
    blurb: 'Aguanta escaleras sin que el pasajero se muerda la lengua.',
    cost: 45000,
    minRank: 2,
  },
  {
    id: 'upgrade-tires',
    kind: 'upgrade',
    name: 'Gomas de lluvia',
    blurb: 'Agarre en mojado. Los encargos de aguacero dejan de dar miedo.',
    cost: 60000,
    minRank: 3,
  },
  {
    id: 'upgrade-brakes',
    kind: 'upgrade',
    name: 'Frenos de verdad',
    blurb: 'Paras donde querías parar, no dos metros más allá.',
    cost: 30000,
    minRank: 2,
  },
  {
    id: 'upgrade-soundsystem',
    kind: 'upgrade',
    name: 'Planta de sonido',
    blurb: 'El corillo de la guagua se prende más rápido y se calma más despacio.',
    cost: 88000,
    minRank: 4,
  },
];

const UNLOCK_BY_ID = new Map<string, UnlockDef>(UNLOCKS.map((u) => [u.id, u]));

export function unlockById(id: string): UnlockDef | undefined {
  return UNLOCK_BY_ID.get(id);
}

/* ------------------------------------------------------------ daily jobs */

export interface DailyJob {
  def: SpecialMissionDef;
  /** payout multiplier the first time it is cleared today */
  multiplier: number;
  done: boolean;
}

/** Days since the epoch, in local time — the rotation key. */
export function dayIndex(now = Date.now()): number {
  const d = new Date(now);
  return Math.floor(
    (now - d.getTimezoneOffset() * 60_000) / 86_400_000,
  );
}

const DAILY_COUNT = 3;
const DAILY_MULTIPLIERS: readonly number[] = [2.5, 2, 1.75];

/**
 * The three jobs of the day. Seeded off the calendar day so it is the same
 * three for everyone, and picked from the whole board, story jobs included, so
 * the daily can send you somewhere you have not been.
 */
export function dailyJobsFor(day: number): SpecialMissionDef[] {
  const pool = ALL_MISSIONS.filter((m) => (m.weight ?? 1) > 0 || m.story === true);
  if (pool.length === 0) return [];
  const rng = new RNG((day * 0x9e3779b1) >>> 0);
  const bag = pool.slice();
  rng.shuffle(bag);
  return bag.slice(0, Math.min(DAILY_COUNT, bag.length));
}

/* ------------------------------------------------------------------ rep */

export const REP = {
  /** rep per delivered fare, before the star multiplier */
  perFare: 22,
  /** a 5-star fare is worth this much more than a 0-star one */
  perStar: 14,
  /** rep for a special mission, on top of the fare */
  missionFallback: 90,
  /** rep per $1000 of shift cash — rewards long good shifts, gently */
  perThousandCash: 12,
  /** rep for a completed challenge */
  challenge: 160,
  /** a failed fare costs this much; rank never actually drops, it just stalls */
  perFailure: 12,
} as const;

/* ----------------------------------------------------------------- class */

export interface ProgressionOptions {
  bus: EventBus;
  save?: SaveSystem | null;
  /** announce rank-ups and unlocks through the HUD; off in the harness */
  announce?: boolean;
  /** override the calendar day, for tests */
  today?: number;
}

export interface RankChange {
  from: RankDef;
  to: RankDef;
}

/**
 * Owns rep, rank, unlocks and the daily rotation. Registered as a system so it
 * can subscribe once and be disposed with everything else, but it does no
 * per-frame work at all.
 */
export class Progression implements System {
  readonly name = 'progression';

  /** Fired whenever rank goes up. `main` may use it to pop a bigger flourish. */
  onRankUp: ((change: RankChange) => void) | null = null;
  /** Fired when a part is granted or bought. */
  onUnlock: ((def: UnlockDef, paid: boolean) => void) | null = null;

  private readonly bus: EventBus;
  private readonly save: SaveSystem | null;
  private readonly announce: boolean;
  private readonly today: number;

  private rep = 0;
  private rankIndex = 0;
  /** rep earned since `beginShift`, for the results screen */
  private shiftRep = 0;
  private running = false;

  private readonly daily: DailyJob[] = [];
  private readonly dailyDone = new Set<string>();

  private readonly unsubs: Array<() => void> = [];
  private readonly bankedResults = new WeakSet<object>();

  constructor(opts: ProgressionOptions) {
    this.bus = opts.bus;
    this.save = opts.save ?? null;
    this.announce = opts.announce ?? true;
    this.today = opts.today ?? dayIndex();
    this.load();
  }

  /* -------------------------------------------------------------- loading */

  private load(): void {
    const save = this.save;
    if (save) {
      const best = save.current.challengeBest;
      this.rep = Number.isFinite(best[SAVE_KEYS.rep]) ? Math.max(0, best[SAVE_KEYS.rep]) : 0;
    }
    this.rankIndex = rankForRep(this.rep).index;
    this.refreshDaily();
    this.grantRankUnlocks(false);
  }

  /** Rebuild the day's rotation, clearing yesterday's completions. */
  refreshDaily(): void {
    const save = this.save;
    this.daily.length = 0;
    this.dailyDone.clear();

    const defs = dailyJobsFor(this.today);
    if (save) {
      const stored = save.current.challengeBest[SAVE_KEYS.dailyDay];
      if (stored !== this.today) {
        save.update((d) => {
          d.challengeBest[SAVE_KEYS.dailyDay] = this.today;
          d.challengeBest[SAVE_KEYS.dailyDone] = 0;
        });
      }
    }
    /*
     * Which of today's three are already cleared is stored as a bitmask so it
     * survives a reload without needing an array in the save schema.
     */
    const mask = save ? (save.current.challengeBest[SAVE_KEYS.dailyDone] ?? 0) : 0;
    for (let i = 0; i < defs.length; i++) {
      const done = ((mask >> i) & 1) === 1;
      if (done) this.dailyDone.add(defs[i].id);
      this.daily.push({ def: defs[i], multiplier: DAILY_MULTIPLIERS[i] ?? 1.5, done });
    }
  }

  /* ----------------------------------------------------------- inspection */

  get reputation(): number {
    return Math.round(this.rep);
  }

  get rank(): number {
    return this.rankIndex;
  }

  get rankDef(): RankDef {
    return RANKS[this.rankIndex] ?? RANKS[0];
  }

  get nextRankDef(): RankDef | null {
    return RANKS[this.rankIndex + 1] ?? null;
  }

  /** 0..1 toward the next rank. */
  get rankFraction(): number {
    return rankProgress(this.rep);
  }

  get repThisShift(): number {
    return Math.round(this.shiftRep);
  }

  get dailyJobs(): ReadonlyArray<DailyJob> {
    return this.daily;
  }

  get dailyRemaining(): number {
    let n = 0;
    for (const j of this.daily) if (!j.done) n++;
    return n;
  }

  /** Story ids the player has finished, for `MissionSystem.setCompletedMissions`. */
  get completedStory(): readonly string[] {
    return this.save ? this.save.current.storyComplete : [];
  }

  get bank(): number {
    return this.save ? Math.round(this.save.current.bank) : 0;
  }

  isUnlocked(id: string): boolean {
    return this.save ? this.save.isUnlocked(id) : false;
  }

  /** Everything the player could buy right now, cheapest first. */
  purchasable(): UnlockDef[] {
    const out: UnlockDef[] = [];
    for (const u of UNLOCKS) {
      if (u.cost <= 0) continue;
      if (this.isUnlocked(u.id)) continue;
      if (this.rankIndex < u.minRank) continue;
      out.push(u);
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
  }

  /** The single next thing to save up for — drives the "keep playing" nudge. */
  nextGoal(): UnlockDef | null {
    const options = this.purchasable();
    if (options.length === 0) return null;
    const bank = this.bank;
    for (const u of options) if (u.cost > bank) return u;
    return options[options.length - 1];
  }

  /* -------------------------------------------------------------- buying */

  /** Spend cash on a part. Returns false when it is locked, owned or unaffordable. */
  buy(id: string): boolean {
    const def = UNLOCK_BY_ID.get(id);
    const save = this.save;
    if (!def || !save) return false;
    if (def.cost <= 0) return false;
    if (save.isUnlocked(id)) return false;
    if (this.rankIndex < def.minRank) return false;
    if (!save.spend(def.cost)) return false;
    save.unlock(id);
    this.fireUnlock(def, true);
    return true;
  }

  /** Grant a part outright — story rewards and rank perks come through here. */
  grant(id: string): boolean {
    const def = UNLOCK_BY_ID.get(id);
    const save = this.save;
    if (!save) return false;
    if (save.isUnlocked(id)) return false;
    if (!save.unlock(id)) return false;
    if (def) this.fireUnlock(def, false);
    return true;
  }

  private fireUnlock(def: UnlockDef, paid: boolean): void {
    this.onUnlock?.(def, paid);
    if (!this.announce) return;
    this.bus.emit('ui:notice', { text: `¡DESBLOQUEADO! ${def.name.toUpperCase()}`, big: true });
    this.bus.emit('ui:toast', { text: def.blurb, icon: 'star', ms: 3600 });
    this.bus.emit('audio:sfx', { id: 'cashRegister', volume: paid ? 0.9 : 0.7 });
  }

  private grantRankUnlocks(announce: boolean): void {
    for (const u of UNLOCKS) {
      if (u.freeAtRank === undefined) continue;
      if (this.rankIndex < u.freeAtRank) continue;
      if (this.isUnlocked(u.id)) continue;
      const save = this.save;
      if (!save || !save.unlock(u.id)) continue;
      this.onUnlock?.(u, false);
      if (announce && this.announce) {
        this.bus.emit('ui:toast', { text: `Rango nuevo: ${u.name} desbloqueado`, icon: 'star', ms: 3200 });
      }
    }
  }

  /* ----------------------------------------------------------------- rep */

  /** Add reputation and roll rank up if it crossed a threshold. */
  addRep(amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    const before = this.rankIndex;
    this.rep = Math.max(0, this.rep + amount);
    if (amount > 0) this.shiftRep += amount;

    const next = rankForRep(this.rep);
    if (next.index !== before) {
      this.rankIndex = next.index;
      if (next.index > before) {
        this.grantRankUnlocks(true);
        this.onRankUp?.({ from: RANKS[before], to: next });
        if (this.announce) {
          this.bus.emit('ui:notice', { text: `RANGO ${next.index + 1} · ${next.name.toUpperCase()}`, big: true });
          this.bus.emit('ui:toast', { text: next.blurb, icon: 'star', ms: 3600 });
          this.bus.emit('audio:sfx', { id: 'comboUp', volume: 0.9 });
        }
      }
    }
    this.persistRep();
  }

  private persistRep(): void {
    const save = this.save;
    if (!save) return;
    const value = Math.round(this.rep);
    save.update((d) => {
      d.challengeBest[SAVE_KEYS.rep] = value;
    });
  }

  /* ---------------------------------------------------------- shift hooks */

  /** Call when a run starts, so `repThisShift` is meaningful on the results. */
  beginShift(): void {
    this.shiftRep = 0;
    this.running = true;
  }

  /** Call when a run ends; banks the cash-derived rep and the personal bests. */
  endShift(cash: number, opts: { longestChain?: number; bestFare?: number } = {}): number {
    if (!this.running) return 0;
    this.running = false;
    const clean = Number.isFinite(cash) ? Math.max(0, cash) : 0;
    this.addRep((clean / 1000) * REP.perThousandCash);

    const save = this.save;
    if (save) {
      const best = save.current.challengeBest;
      const shiftBest = Math.max(best[SAVE_KEYS.bestShiftCash] ?? 0, Math.round(clean));
      const chain = Math.max(best[SAVE_KEYS.longestChain] ?? 0, Math.round(opts.longestChain ?? 0));
      const fare = Math.max(best[SAVE_KEYS.bestFareValue] ?? 0, Math.round(opts.bestFare ?? 0));
      save.update((d) => {
        d.challengeBest[SAVE_KEYS.bestShiftCash] = shiftBest;
        d.challengeBest[SAVE_KEYS.longestChain] = chain;
        d.challengeBest[SAVE_KEYS.bestFareValue] = fare;
      });
    }
    return this.repThisShift;
  }

  /** Record a Chinchorreo score; returns true when it is a new personal best. */
  recordPartyRun(score: number): boolean {
    const save = this.save;
    const value = Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0;
    if (!save) return false;
    const best = save.current.challengeBest[SAVE_KEYS.partyBest] ?? 0;
    const runs = (save.current.challengeBest[SAVE_KEYS.partyRuns] ?? 0) + 1;
    const isBest = value > best;
    save.update((d) => {
      d.challengeBest[SAVE_KEYS.partyRuns] = runs;
      if (isBest) d.challengeBest[SAVE_KEYS.partyBest] = value;
    });
    return isBest;
  }

  get partyBest(): number {
    return this.save ? (this.save.current.challengeBest[SAVE_KEYS.partyBest] ?? 0) : 0;
  }

  /* ------------------------------------------------------------- missions */

  /** Mark a mission complete: story flag, daily credit, and the rep it pays. */
  completeMission(id: string, ratingBonus = 0): void {
    const def = ALL_MISSIONS.find((m) => m.id === id);
    const save = this.save;

    if (def?.story && save && !save.current.storyComplete.includes(id)) {
      save.update((d) => {
        d.storyComplete.push(id);
      });
      if (def.grants) for (const g of def.grants) this.grant(g);
      if (this.announce) {
        this.bus.emit('ui:toast', {
          text: `Encargo ${def.order ?? '?'} / ${STORY_ORDER.length} completado`,
          icon: 'star',
          ms: 3200,
        });
      }
    }

    this.addRep((def?.rankXp ?? REP.missionFallback) + ratingBonus);
    this.creditDaily(id);
  }

  /** True when `id` is one of today's three and has not been cleared yet. */
  isDailyLive(id: string): boolean {
    for (const j of this.daily) if (j.def.id === id) return !j.done;
    return false;
  }

  /** Today's multiplier for `id`, or 1 when it is not a live daily. */
  dailyMultiplier(id: string): number {
    for (const j of this.daily) if (j.def.id === id && !j.done) return j.multiplier;
    return 1;
  }

  private creditDaily(id: string): void {
    let index = -1;
    for (let i = 0; i < this.daily.length; i++) {
      if (this.daily[i].def.id === id) {
        index = i;
        break;
      }
    }
    if (index < 0 || this.daily[index].done) return;
    this.daily[index].done = true;
    this.dailyDone.add(id);

    const save = this.save;
    if (save) {
      const mask = (save.current.challengeBest[SAVE_KEYS.dailyDone] ?? 0) | (1 << index);
      save.update((d) => {
        d.challengeBest[SAVE_KEYS.dailyDone] = mask;
        d.challengeBest[SAVE_KEYS.dailyDay] = this.today;
      });
    }
    this.addRep(Math.round(120 * this.daily[index].multiplier));
    if (this.announce) {
      this.bus.emit('ui:notice', { text: '¡RUTA DEL DÍA!', big: true });
      this.bus.emit('ui:toast', {
        text: `${this.daily[index].def.title} · quedan ${this.dailyRemaining} de hoy`,
        icon: 'star',
        ms: 3600,
      });
    }
  }

  /* ---------------------------------------------------------------- wiring */

  init(): void {
    this.subscribe();
  }

  private subscribe(): void {
    const on = <K extends EventKey>(key: K, fn: (p: EventMap[K]) => void): void => {
      this.unsubs.push(this.bus.on(key, fn));
    };

    on('passenger:dropoff', (p) => {
      if (!this.running) return;
      this.bankResult(p.result);
      const stars = Number.isFinite(p.result.rating) ? clamp(p.result.rating, 0, 5) : 0;
      this.addRep(REP.perFare + stars * REP.perStar);
    });

    on('passenger:bail', () => {
      if (!this.running) return;
      this.addRep(-REP.perFailure);
    });

    on('mission:complete', (p) => {
      if (!this.running) return;
      /*
       * A fare-backed mission emits `passenger:dropoff` with the *same* result
       * object first, so that handler has already paid the per-fare rep. Only
       * passenger-less missions (the cart, challenges) arrive here unseen, and
       * those get a flat top-up instead.
       */
      const firstSeen = this.bankResult(p.result);
      this.completeMission(p.id, firstSeen ? 40 : 0);
    });
  }

  /** Returns true the first time a given `FareResult` object is seen. */
  private bankResult(result: FareResult): boolean {
    if (this.bankedResults.has(result)) return false;
    this.bankedResults.add(result);
    return true;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }
}
