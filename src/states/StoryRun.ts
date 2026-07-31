/**
 * Loco Lift — playing the campaign.
 *
 * A story run is a normal shift with one difference: the encargo the campaign
 * says is next gets queued the moment the countdown clears, and the run ends
 * when that encargo resolves. Everything else — street fares, the combo chain,
 * the runaway cart — keeps happening around it, so the player is always earning
 * while they wait for the job to show up. That matters, because chapters open
 * on money: a locked chapter is not a wall, it is a shift you play for cash
 * with the door in sight.
 *
 * Division of labour:
 *   `Chapters.ts`      the text and the thresholds
 *   `Story.ts`         which chapter is open, and the narration queue
 *   `MissionCatalog`   the encargos
 *   here               the clock, the hand-off, and the grace after a delivery
 */
import { CONFIG } from '../core/Config';
import type { EventBus } from '../core/EventBus';
import { clamp } from '../core/MathUtils';
import type { GameMode } from '../core/types';
import { missionById, STORY_ORDER } from '../passengers/MissionCatalog';
import type { ShiftController } from './ArcadeShift';
import { chapterDef } from './Chapters';
import type { StoryCampaign } from './Story';

/* ------------------------------------------------------ structural inputs */

/** The slice of `MissionSystem` the spine drives. Duck-typed, never imported. */
export interface StoryMissionSource {
  readonly storyMissionId: string | null;
  setStoryMode(on: boolean): void;
  setCompletedMissions(ids: Iterable<string>): void;
  setRank(rank: number): void;
  setStoryOverride?(id: string | null): void;
  queueStoryMission(explicitId?: string | null): string | null;
  consumeStoryResult(): 'complete' | 'fail' | null;
}

/** What the spine reads from progression. */
export interface StoryProgressSource {
  readonly rank: number;
  readonly completedStory: readonly string[];
}

export interface StoryRunOptions {
  bus: EventBus;
  missions: StoryMissionSource;
  progress?: StoryProgressSource | null;
  /** the campaign; without one the run falls back to flat catalog order */
  campaign?: StoryCampaign | null;
  /** seconds on the clock before the encargo even appears */
  startSeconds?: number;
  maxSeconds?: number;
  /** seconds of grace after the encargo resolves, so the payout can land */
  settleSeconds?: number;
  /** most extra seconds a chapter card may hold the results screen back */
  maxNarrationHold?: number;
}

/** Seconds at which the player gets a shouted warning, high to low. */
const WARN_STEPS: readonly number[] = [15, 10, 5, 3];

export class StoryRun implements ShiftController {
  readonly mode: GameMode = 'story';
  readonly timed = true;

  private readonly bus: EventBus;
  private readonly missions: StoryMissionSource;
  private progress: StoryProgressSource | null;
  private campaign: StoryCampaign | null;
  private readonly startSeconds: number;
  private readonly maxSeconds: number;
  private readonly settleSeconds: number;
  private readonly maxNarrationHold: number;

  private left = 0;
  private running = false;
  private ended = false;
  private succeeded = false;
  private settle = -1;
  private narrationHold = 0;
  private warnIndex = 0;
  private queued: string | null = null;
  private queueTimer = 0;
  /** the chapter this run opened in, so the outro can be attributed */
  private chapterAtStart = 0;
  private lockedThisRun = false;

  private unsubTime: (() => void) | null = null;

  constructor(opts: StoryRunOptions) {
    this.bus = opts.bus;
    this.missions = opts.missions;
    this.progress = opts.progress ?? null;
    this.campaign = opts.campaign ?? null;
    this.startSeconds = opts.startSeconds ?? 165;
    this.maxSeconds = opts.maxSeconds ?? Math.max(240, CONFIG.shift.maxSeconds * 2);
    this.settleSeconds = opts.settleSeconds ?? 3.5;
    this.maxNarrationHold = opts.maxNarrationHold ?? 24;
  }

  setProgress(p: StoryProgressSource | null): void {
    this.progress = p;
  }

  setCampaign(c: StoryCampaign | null): void {
    this.campaign = c;
  }

  get timeRemaining(): number {
    return this.left;
  }

  get finished(): boolean {
    return this.ended;
  }

  get succeededFlag(): boolean {
    return this.succeeded;
  }

  /** Which encargo this run is about, or null when there is nothing to play. */
  get missionId(): string | null {
    return this.queued;
  }

  /** True when the run opened on a chapter the player has not earned yet. */
  get chapterLocked(): boolean {
    return this.lockedThisRun;
  }

  /** 1-based position in the whole campaign, or 0. */
  get chapter(): number {
    if (!this.queued) return 0;
    const def = missionById(this.queued);
    return def?.order ?? 0;
  }

  get chapterCount(): number {
    return STORY_ORDER.length;
  }

  /** 1-based chapter of the campaign this run belongs to. */
  get chapterIndex(): number {
    return this.chapterAtStart;
  }

  /** True when every encargo is already done. */
  get storyComplete(): boolean {
    if (this.campaign) return this.campaign.isComplete;
    const done = this.progress ? this.progress.completedStory : [];
    for (const def of STORY_ORDER) {
      if (!done.includes(def.id)) return false;
    }
    return true;
  }

  /* --------------------------------------------------------------- start */

  start(): void {
    this.left = this.startSeconds;
    this.running = false;
    this.ended = false;
    this.succeeded = false;
    this.settle = -1;
    this.narrationHold = 0;
    this.warnIndex = 0;
    this.queued = null;
    this.queueTimer = 0;
    this.lockedThisRun = false;

    this.missions.setStoryMode(true);
    if (this.progress) {
      this.missions.setCompletedMissions(this.progress.completedStory);
      this.missions.setRank(this.progress.rank);
    }

    this.unsubTime?.();
    this.unsubTime = this.bus.on('shift:timeAdded', (p) => this.addTime(p.seconds));

    this.bus.emit('shift:start', { mode: this.mode, duration: this.startSeconds });

    const campaign = this.campaign;
    campaign?.clearBeats();
    this.chapterAtStart = campaign ? campaign.currentChapter : 0;

    if (this.storyComplete) {
      /* nothing left in the spine — say so, and let it play as a free shift */
      this.bus.emit('ui:notice', { text: 'HISTORIA COMPLETA', big: true });
      this.bus.emit('ui:toast', {
        text: campaign
          ? campaign.lockNotice()
          : 'Los encargos están hechos. Vuelve por la ruta del día.',
        icon: 'star',
        ms: 4200,
      });
      this.missions.setStoryOverride?.(null);
      return;
    }

    const wanted = campaign ? campaign.nextMissionId() : null;
    if (campaign && !wanted) {
      /*
       * The next chapter is shut. This is not a dead end: the run still plays
       * as an ordinary shift, and every dollar earned in it is progress toward
       * the door. Say exactly what is missing and get out of the way.
       */
      this.lockedThisRun = true;
      const def = chapterDef(campaign.currentChapter);
      this.missions.setStoryMode(false);
      this.missions.setStoryOverride?.(null);
      this.bus.emit('ui:notice', { text: def ? def.title : 'CAPÍTULO CERRADO', big: true });
      this.bus.emit('ui:toast', { text: campaign.lockNotice(), icon: 'warn', ms: 5200 });
      return;
    }

    this.missions.setStoryOverride?.(wanted);
    if (campaign) campaign.playChapterIntro(campaign.currentChapter);

    this.queued = this.missions.queueStoryMission(wanted);
    const def = this.queued ? missionById(this.queued) : null;
    if (def) {
      this.bus.emit('ui:toast', {
        text: `Encargo ${def.order ?? '?'} de ${STORY_ORDER.length}`,
        icon: 'star',
        ms: 3000,
      });
    }
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  private addTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.left = clamp(this.left + seconds, 0, this.maxSeconds);
    while (this.warnIndex > 0 && this.left > WARN_STEPS[this.warnIndex - 1]) this.warnIndex--;
  }

  /* --------------------------------------------------------------- frame */

  update(dt: number): void {
    if (!this.running || this.ended || dt <= 0) return;
    this.left -= dt;

    /* chapter cards are drained here, so they keep talking while you drive */
    this.campaign?.update(dt);

    while (this.warnIndex < WARN_STEPS.length && this.left <= WARN_STEPS[this.warnIndex]) {
      const step = WARN_STEPS[this.warnIndex];
      this.warnIndex++;
      if (this.left > 0 && this.settle < 0) this.bus.emit('shift:timeWarning', { remaining: step });
    }

    /*
     * The encargo may not have been placeable when the run started (the pending
     * slot was busy, or the anchor POI was on top of the player). Retry until
     * it takes, so a story run can never end up with no story in it.
     */
    if (!this.queued && !this.lockedThisRun && !this.storyComplete) {
      this.queueTimer -= dt;
      if (this.queueTimer <= 0) {
        this.queueTimer = 2;
        this.queued = this.missions.queueStoryMission(this.campaign?.nextMissionId() ?? null);
      }
    }

    const outcome = this.missions.consumeStoryResult();
    if (outcome === 'complete') {
      this.succeeded = true;
      this.settle = this.settleSeconds;
      this.bus.emit('ui:notice', { text: '¡ENCARGO COMPLETADO!', big: true });
      /* the chapter card, when that beat was the last one in its chapter */
      if (this.queued && this.campaign) {
        const closed = this.campaign.noteMissionComplete(this.queued);
        if (closed > 0) this.narrationHold = this.maxNarrationHold;
      }
    } else if (outcome === 'fail') {
      this.succeeded = false;
      this.settle = this.settleSeconds;
    }

    if (this.settle >= 0) {
      this.settle -= dt;
      /* hold the results screen back while a chapter is still being told */
      if (this.settle <= 0 && this.narrationHold > 0 && this.campaign?.hasPendingBeats) {
        this.narrationHold -= dt;
        return;
      }
      if (this.settle <= 0) {
        this.finish();
        return;
      }
    }

    if (this.left <= 0) {
      this.left = 0;
      this.finish();
    }
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.missions.setStoryMode(false);
    this.missions.setStoryOverride?.(null);
  }

  stop(): void {
    this.running = false;
    this.ended = true;
    this.missions.setStoryMode(false);
    this.missions.setStoryOverride?.(null);
    this.campaign?.clearBeats();
    this.unsubTime?.();
    this.unsubTime = null;
  }

  dispose(): void {
    this.unsubTime?.();
    this.unsubTime = null;
  }
}
