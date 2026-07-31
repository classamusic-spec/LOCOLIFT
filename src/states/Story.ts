/**
 * Loco Lift — the campaign runtime.
 *
 * `Chapters.ts` is the text, `MissionCatalog.ts` is the work, and this is the
 * thing that decides what the player is allowed to do next and says the words
 * out loud. It owns exactly three jobs:
 *
 *  1. **Gating.** A chapter opens when the previous one is finished *and* the
 *     player has either banked `requireBank` or reached `requireRank` —
 *     whichever they got to first, so grinding cash and driving beautifully are
 *     both valid ways forward.
 *  2. **Beats.** Chapter intros and outros are queued as timed lines and
 *     drained by `update`, one every few seconds, through `ui:notice` and
 *     `ui:toast`. Nothing else in the game narrates.
 *  3. **Bookkeeping.** Which chapter cards have already been seen persists in
 *     the free-form save map, so re-entering chapter 3 does not replay its
 *     opening every single time.
 *
 * It takes progression and the save as narrow structural interfaces and never
 * imports either, so the harness can drive it with two object literals.
 */
import type { EventBus } from '../core/EventBus';
import { STORY_ORDER, type SpecialMissionDef } from '../passengers/MissionCatalog';
import { CHAPTERS, chapterMissions, CHAPTER_COUNT, type ChapterDef } from './Chapters';

/* ------------------------------------------------------ structural inputs */

/** What the campaign reads from progression. `Progression` satisfies this. */
export interface CampaignProgress {
  readonly rank: number;
  readonly bank: number;
  readonly completedStory: readonly string[];
  /** hand over a garage unlock; absent is fine, the grant is then skipped */
  grant?(id: string): boolean;
}

/** Where the "already seen this card" flags live. `SaveSystem` adapts to it. */
export interface CampaignStore {
  getNumber(key: string): number;
  setNumber(key: string, value: number): void;
}

/** Adapter for the real save. Keeps `SaveSystem` out of this file's imports. */
export function campaignStore(save: {
  readonly current: { readonly challengeBest: Record<string, number> };
  update(fn: (d: { challengeBest: Record<string, number> }) => void): void;
}): CampaignStore {
  return {
    getNumber(key) {
      const v = save.current.challengeBest[key];
      return Number.isFinite(v) ? v : 0;
    },
    setNumber(key, value) {
      save.update((d) => {
        d.challengeBest[key] = value;
      });
    },
  };
}

/** Save keys this file owns, namespaced so nothing collides. */
export const STORY_KEYS = {
  /** bitmask of chapters whose opening card has played */
  seenIntro: 'story.introSeen',
  /** bitmask of chapters whose closing card has played */
  seenOutro: 'story.outroSeen',
} as const;

/* ------------------------------------------------------------------ beats */

interface Beat {
  text: string;
  big: boolean;
  /** seconds to hold before the next beat */
  hold: number;
}

export interface StoryCampaignOptions {
  bus: EventBus;
  progress?: CampaignProgress | null;
  store?: CampaignStore | null;
  /** seconds a normal narration beat holds before the next one */
  beatHold?: number;
  /** speak chapter cards at all; off in the harness */
  announce?: boolean;
}

/* ------------------------------------------------------------------ class */

export class StoryCampaign {
  /** Fired when a chapter's last encargo clears, after the grants land. */
  onChapterComplete: ((chapter: ChapterDef) => void) | null = null;

  private readonly bus: EventBus;
  private progress: CampaignProgress | null;
  private store: CampaignStore | null;
  private readonly beatHold: number;
  private readonly announce: boolean;

  /** pending narration, drained by `update` */
  private readonly queue: Beat[] = [];
  private beatTimer = 0;

  constructor(opts: StoryCampaignOptions) {
    this.bus = opts.bus;
    this.progress = opts.progress ?? null;
    this.store = opts.store ?? null;
    this.beatHold = opts.beatHold ?? 3.6;
    this.announce = opts.announce ?? true;
  }

  setProgress(p: CampaignProgress | null): void {
    this.progress = p;
  }

  setStore(s: CampaignStore | null): void {
    this.store = s;
  }

  /* ----------------------------------------------------------- inspection */

  private done(id: string): boolean {
    const list = this.progress?.completedStory;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (list[i] === id) return true;
    return false;
  }

  /** Every encargo in the chapter is finished. */
  isChapterComplete(index: number): boolean {
    const list = chapterMissions(index);
    if (list.length === 0) return false;
    for (const def of list) if (!this.done(def.id)) return false;
    return true;
  }

  /** Encargos cleared in this chapter. */
  chapterProgress(index: number): number {
    let n = 0;
    for (const def of chapterMissions(index)) if (this.done(def.id)) n++;
    return n;
  }

  /** Chapter 1 is always open; the rest need the previous one plus earnings. */
  isChapterUnlocked(index: number): boolean {
    const def = CHAPTERS[index - 1];
    if (!def) return false;
    if (index <= 1) return true;
    if (!this.isChapterComplete(index - 1)) return false;
    const p = this.progress;
    if (!p) return false;
    const bank = Number.isFinite(p.bank) ? p.bank : 0;
    const rank = Number.isFinite(p.rank) ? p.rank : 0;
    return bank >= def.requireBank || rank >= def.requireRank;
  }

  /** The chapter the player is working on — the first with anything left. */
  get currentChapter(): number {
    for (const c of CHAPTERS) {
      if (!this.isChapterComplete(c.index)) return c.index;
    }
    return CHAPTER_COUNT;
  }

  get currentChapterDef(): ChapterDef | null {
    return CHAPTERS[this.currentChapter - 1] ?? null;
  }

  get chapterCount(): number {
    return CHAPTER_COUNT;
  }

  /** Encargos cleared across the whole campaign. */
  get missionsCleared(): number {
    let n = 0;
    for (const def of STORY_ORDER) if (this.done(def.id)) n++;
    return n;
  }

  get missionCount(): number {
    return STORY_ORDER.length;
  }

  get isComplete(): boolean {
    return this.missionsCleared >= this.missionCount;
  }

  /** The next encargo to play, or null when the chapter is shut or it is over. */
  nextMission(): SpecialMissionDef | null {
    if (this.isComplete) return null;
    const chapter = this.currentChapter;
    if (!this.isChapterUnlocked(chapter)) return null;
    for (const def of chapterMissions(chapter)) {
      if (!this.done(def.id)) return def;
    }
    /* the chapter is finished but `currentChapter` said otherwise — be safe */
    for (const def of STORY_ORDER) if (!this.done(def.id)) return def;
    return null;
  }

  nextMissionId(): string | null {
    return this.nextMission()?.id ?? null;
  }

  /**
   * Why there is nothing to play. Empty string means there *is* something —
   * the UI should only show this when `nextMission()` returned null.
   */
  lockNotice(): string {
    if (this.isComplete) {
      return 'Los veintisiete encargos están hechos. La ciudad ya es tuya.';
    }
    const chapter = this.currentChapter;
    const def = CHAPTERS[chapter - 1];
    if (!def) return '';
    if (this.isChapterUnlocked(chapter)) return '';
    const p = this.progress;
    const bank = p && Number.isFinite(p.bank) ? Math.round(p.bank) : 0;
    const short = Math.max(0, def.requireBank - bank);
    if (short > 0) {
      return `${def.locked} Te faltan $${short.toLocaleString('es-PR')} o el rango ${def.requireRank + 1}.`;
    }
    return def.locked;
  }

  /* ---------------------------------------------------------------- beats */

  /** Queue the chapter card. `force` replays a card that has already been seen. */
  playChapterIntro(index: number, force = false): boolean {
    const def = CHAPTERS[index - 1];
    if (!def) return false;
    if (!force && this.hasSeen(STORY_KEYS.seenIntro, index)) return false;
    this.markSeen(STORY_KEYS.seenIntro, index);
    this.queue.push({ text: def.title, big: true, hold: 2.4 });
    this.queue.push({ text: def.subtitle, big: false, hold: this.beatHold });
    for (const line of def.intro) this.queue.push({ text: line, big: false, hold: this.beatHold });
    return true;
  }

  /** Queue the closing card and hand over what the chapter promised. */
  playChapterOutro(index: number, force = false): boolean {
    const def = CHAPTERS[index - 1];
    if (!def) return false;
    if (!force && this.hasSeen(STORY_KEYS.seenOutro, index)) return false;
    this.markSeen(STORY_KEYS.seenOutro, index);

    const grant = this.progress?.grant;
    if (grant) {
      for (const id of def.grants) grant.call(this.progress, id);
    }

    this.queue.push({ text: `${def.title} · COMPLETADO`, big: true, hold: 2.6 });
    for (const line of def.outro) this.queue.push({ text: line, big: false, hold: this.beatHold });
    this.onChapterComplete?.(def);
    return true;
  }

  /**
   * Call after an encargo resolves. Plays the chapter outro when that beat was
   * the last one in its chapter. Returns the chapter that just closed, or 0.
   */
  noteMissionComplete(missionId: string): number {
    for (const c of CHAPTERS) {
      const list = chapterMissions(c.index);
      let mine = false;
      for (const def of list) {
        if (def.id === missionId) {
          mine = true;
          break;
        }
      }
      if (!mine) continue;
      if (!this.isChapterComplete(c.index)) return 0;
      return this.playChapterOutro(c.index) ? c.index : 0;
    }
    return 0;
  }

  get hasPendingBeats(): boolean {
    return this.queue.length > 0;
  }

  /** Drop anything still queued — used when a run is abandoned. */
  clearBeats(): void {
    this.queue.length = 0;
    this.beatTimer = 0;
  }

  /** Drain one narration beat when its predecessor has had its time. */
  update(dt: number): void {
    if (this.queue.length === 0) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.beatTimer -= dt;
    if (this.beatTimer > 0) return;
    const beat = this.queue.shift();
    if (!beat) return;
    this.beatTimer = beat.hold;
    if (!this.announce) return;
    if (beat.big) {
      this.bus.emit('ui:notice', { text: beat.text, big: true });
      this.bus.emit('audio:sfx', { id: 'timeExtend', volume: 0.55 });
    } else {
      this.bus.emit('ui:toast', {
        text: beat.text,
        icon: 'star',
        ms: Math.round(beat.hold * 1000) + 900,
      });
    }
  }

  /* ------------------------------------------------------------ bookkeeping */

  private hasSeen(key: string, index: number): boolean {
    const store = this.store;
    if (!store) return false;
    return ((store.getNumber(key) >> (index - 1)) & 1) === 1;
  }

  private markSeen(key: string, index: number): void {
    const store = this.store;
    if (!store) return;
    store.setNumber(key, store.getNumber(key) | (1 << (index - 1)));
  }

  /** Forget every chapter card — the harness and "replay the story" use it. */
  resetSeen(): void {
    const store = this.store;
    if (!store) return;
    store.setNumber(STORY_KEYS.seenIntro, 0);
    store.setNumber(STORY_KEYS.seenOutro, 0);
  }
}
