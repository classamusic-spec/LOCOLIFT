/**
 * Loco Lift — who knows you.
 *
 * The campaign is a story about a city; this is the ledger that makes it feel
 * like one. Every completed delivery increments a per-person ride counter, and
 * when a counter crosses a threshold in `StoryArcs` that person's life moves on:
 * the drummer gets the Friday slot, the baker buys a second oven, the abuela
 * mentions your uncle. The only thing the player sees is one toast; everything
 * else is heard from the back seat.
 *
 * Persistence rides on the free-form `SaveData.challengeBest` map (numbers
 * only), namespaced `rel.<archetypeId>`, so nothing in the save schema had to
 * change. Reputation lives in `Progression`; this is the *other* currency —
 * the one you cannot spend.
 *
 * No per-frame work at all: it is a system purely so it can subscribe once and
 * be torn down with everything else.
 */
import type { EventBus } from '../core/EventBus';
import type { EventKey, EventMap, System } from '../core/types';
import { archetypeById } from '../passengers/Archetypes';
import {
  ARC_IDS,
  ARC_THRESHOLDS,
  arcStageAt,
  arcStageCount,
  arcStageIndex,
} from '../passengers/StoryArcs';
import type { SaveSystem } from '../save/SaveSystem';

/** Prefix for the per-person ride counters inside `challengeBest`. */
export const REL_PREFIX = 'rel.';

/** Pseudo-archetypes (the cart, checkpoints, the club crowd) never count. */
function isRealPerson(id: string): boolean {
  return id.length > 0 && id.charCodeAt(0) !== 95 /* '_' */;
}

export interface RelationshipRow {
  archetypeId: string;
  name: string;
  rides: number;
  stage: number;
  stageCount: number;
  /** the stage title they are living right now, or their base premise */
  headline: string;
  /** rides still owed before the next beat, or 0 when the arc is finished */
  toNext: number;
}

export interface RelationshipsOptions {
  bus: EventBus;
  save?: SaveSystem | null;
  /** announce stage changes through the HUD; off in the harness */
  announce?: boolean;
}

export class Relationships implements System {
  readonly name = 'relationships';

  /** Fired when somebody's arc moves on. `main` may pop a bigger flourish. */
  onStageUp: ((archetypeId: string, stage: number, note: string) => void) | null = null;

  private readonly bus: EventBus;
  private readonly save: SaveSystem | null;
  private readonly announce: boolean;

  private readonly rides = new Map<string, number>();
  private readonly unsubs: Array<() => void> = [];
  /** true while a run is live; rides outside a run are not counted */
  private running = false;

  constructor(opts: RelationshipsOptions) {
    this.bus = opts.bus;
    this.save = opts.save ?? null;
    this.announce = opts.announce ?? true;
    this.load();
  }

  private load(): void {
    this.rides.clear();
    const save = this.save;
    if (!save) return;
    const best = save.current.challengeBest;
    for (const key of Object.keys(best)) {
      if (!key.startsWith(REL_PREFIX)) continue;
      const id = key.slice(REL_PREFIX.length);
      const n = best[key];
      if (Number.isFinite(n) && n > 0) this.rides.set(id, Math.floor(n));
    }
  }

  /* ----------------------------------------------------------- inspection */

  ridesWith(archetypeId: string): number {
    return this.rides.get(archetypeId) ?? 0;
  }

  stageOf(archetypeId: string): number {
    return arcStageIndex(archetypeId, this.ridesWith(archetypeId));
  }

  /** How many of the cast the player has driven at least once. */
  get metCount(): number {
    let n = 0;
    for (const v of this.rides.values()) if (v > 0) n++;
    return n;
  }

  get totalRides(): number {
    let n = 0;
    for (const v of this.rides.values()) n += v;
    return n;
  }

  /** How many arc beats across the whole cast have been unlocked. */
  get beatsSeen(): number {
    let n = 0;
    for (const id of ARC_IDS) n += this.stageOf(id);
    return n;
  }

  get beatsTotal(): number {
    let n = 0;
    for (const id of ARC_IDS) n += arcStageCount(id);
    return n;
  }

  /** `[archetypeId, stage]` pairs for `DialogueDirector.setStages`. */
  stageEntries(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const id of ARC_IDS) {
      const stage = this.stageOf(id);
      if (stage > 0) out.push([id, stage]);
    }
    return out;
  }

  /** Everything a codex screen would need, most-driven first. */
  roster(): RelationshipRow[] {
    const out: RelationshipRow[] = [];
    for (const id of ARC_IDS) {
      const rides = this.ridesWith(id);
      const stage = arcStageIndex(id, rides);
      const def = arcStageAt(id, stage);
      const next = arcStageAt(id, stage + 1);
      out.push({
        archetypeId: id,
        name: archetypeById(id)?.name ?? id,
        rides,
        stage,
        stageCount: arcStageCount(id),
        headline: def ? def.title : (archetypeById(id)?.blurb ?? ''),
        toNext: next ? Math.max(0, ridesForStage(stage + 1) - rides) : 0,
      });
    }
    out.sort((a, b) => b.rides - a.rides);
    return out;
  }

  /* ------------------------------------------------------------- counting */

  beginShift(): void {
    this.running = true;
  }

  endShift(): void {
    this.running = false;
  }

  /**
   * Credit one completed ride. Returns the arc stage if it moved, else 0.
   * Public so the party bus and the story runner can credit rides that do not
   * come through `passenger:dropoff`.
   */
  noteRide(archetypeId: string, count = 1): number {
    if (!isRealPerson(archetypeId)) return 0;
    const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
    const before = this.ridesWith(archetypeId);
    const after = before + n;
    this.rides.set(archetypeId, after);
    this.persist(archetypeId, after);

    const wasStage = arcStageIndex(archetypeId, before);
    const nowStage = arcStageIndex(archetypeId, after);
    if (nowStage <= wasStage) return 0;

    const def = arcStageAt(archetypeId, nowStage);
    if (!def) return 0;
    this.onStageUp?.(archetypeId, nowStage, def.note);
    if (this.announce) {
      this.bus.emit('ui:toast', { text: def.note, icon: 'star', ms: 4200 });
      this.bus.emit('audio:sfx', { id: 'comboUp', volume: 0.6 });
    }
    return nowStage;
  }

  private persist(archetypeId: string, value: number): void {
    const save = this.save;
    if (!save) return;
    const key = REL_PREFIX + archetypeId;
    save.update((d) => {
      d.challengeBest[key] = value;
      if (!d.metPassengers.includes(archetypeId)) d.metPassengers.push(archetypeId);
    });
  }

  /** Wipe the ledger — used by the harness and by a save reset. */
  clear(): void {
    const ids = Array.from(this.rides.keys());
    this.rides.clear();
    const save = this.save;
    if (!save) return;
    save.update((d) => {
      for (const id of ids) delete d.challengeBest[REL_PREFIX + id];
    });
  }

  /* ---------------------------------------------------------------- wiring */

  init(): void {
    const on = <K extends EventKey>(key: K, fn: (p: EventMap[K]) => void): void => {
      this.unsubs.push(this.bus.on(key, fn));
    };
    on('passenger:dropoff', (p) => {
      if (!this.running) return;
      this.noteRide(p.archetypeId);
    });
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }
}

/** Rides needed to reach a 1-based stage. */
function ridesForStage(stage: number): number {
  const i = Math.max(1, Math.floor(stage)) - 1;
  return ARC_THRESHOLDS[i] ?? ARC_THRESHOLDS[ARC_THRESHOLDS.length - 1];
}
