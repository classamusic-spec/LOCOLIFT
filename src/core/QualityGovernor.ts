/**
 * Loco Lift — the adaptive quality governor.
 *
 * `SettingsStore.autoDetectQuality()` guesses a tier once, at first run, from
 * `hardwareConcurrency` and `deviceMemory`. Its doc has always claimed the
 * guess is "refined at runtime by the adaptive quality governor". Until this
 * file, that governor did not exist: a laptop reporting 8 cores was handed
 * `high` — SSAO, motion blur, bloom, SMAA, god rays, contact shadows, 850 m of
 * draw distance, 40 traffic cars, 95 pedestrians — and **never stepped down,
 * however badly it was coping**. Core count is not frame rate. An integrated
 * GPU behind a fast CPU fails that guess badly, and the player has no way to
 * know that a menu three screens deep is the difference between a slideshow
 * and a game.
 *
 * This watches what actually happens and moves.
 *
 * ## Why a ladder rather than four tiers
 *
 * Dropping `high` → `medium` changes eight things at once and is visible.
 * Resolution is the single biggest GPU lever and the least noticeable, so the
 * ladder interleaves render scale with tier: a struggling machine loses pixels
 * first and effects only if that was not enough. Each rung is roughly a 20-30 %
 * GPU saving on the one before it.
 *
 * ## Why it is hard to make it oscillate
 *
 * Three separate defences, because a governor that hunts is worse than none —
 * the picture visibly pulses and the player blames the game:
 *
 * 1. **Median, not mean.** One 400 ms GC pause or shader compile must not
 *    trigger a downgrade. The median of a 2 s window ignores it by
 *    construction.
 * 2. **Asymmetric evidence.** Stepping down needs 2 s of sustained slowness;
 *    stepping up needs 10 s of sustained comfort *and* a 20 s quiet period
 *    since the last downgrade. Recovery is deliberately reluctant.
 * 3. **A dead band.** The step-up threshold (74 fps) is far above the
 *    step-down threshold (48 fps). A machine sitting at 60 fps is left alone
 *    forever, because there is no rung that would improve matters.
 *
 * Plus a settle window after every change: the frame right after a tier switch
 * includes shader recompiles and texture reallocation, and judging the new rung
 * by that frame would cause an immediate second downgrade.
 *
 * ## It never overrules the player
 *
 * Any manual quality change raises a permanent ceiling: the governor may still
 * step *down* from it to keep the game playable, but it will never climb above
 * what the player asked for, and `pin()` disables it outright.
 */
import type { GameContext, QualityTier, SettingsState, System } from './types';
import { clamp } from './MathUtils';

/** One rung of the degradation ladder, worst-looking last. */
interface Rung {
  tier: QualityTier;
  scale: number;
}

/**
 * Ordered best → worst. Render scale is interleaved with tier because pixels
 * are the biggest GPU cost and the least visible loss: at 0.85 the player sees
 * a slightly softer image, where `high` → `medium` visibly removes SSAO,
 * motion blur and SMAA at once.
 */
const LADDER: readonly Rung[] = [
  { tier: 'ultra', scale: 1.0 },
  { tier: 'high', scale: 1.0 },
  { tier: 'high', scale: 0.85 },
  { tier: 'medium', scale: 0.9 },
  { tier: 'medium', scale: 0.75 },
  { tier: 'low', scale: 0.85 },
  { tier: 'low', scale: 0.7 },
  { tier: 'low', scale: 0.55 },
];

const TUNING = {
  /** median frame time above this for `downWindow` seconds ⇒ step down (≈48 fps) */
  downMs: 20.8,
  /** median frame time below this for `upWindow` seconds ⇒ step up (≈74 fps) */
  upMs: 13.5,
  /** seconds of sustained slowness before acting */
  downWindow: 2.0,
  /** seconds of sustained comfort before acting — deliberately much longer */
  upWindow: 10.0,
  /** seconds after any change before its own frames are trusted */
  settle: 1.2,
  /** seconds after a downgrade during which no upgrade may be considered */
  quietAfterDown: 20.0,
  /** frames kept for the median */
  window: 240,
  /**
   * Above this a frame is a suspend/resume or a tab restore, not a slow frame,
   * and is discarded. Deliberately generous: 2 fps is a dying machine that
   * still deserves a downgrade, not an outlier to be filtered away.
   */
  discardMs: 5000,
  /** Long frames are clamped to this before entering the window. */
  clampMs: 1000,
} as const;

export interface QualityGovernorOptions {
  /** Reads the live settings — the governor must see manual changes. */
  getSettings(): SettingsState;
  /** Applies a whole rung. Implemented in `main.ts` against `SettingsStore`. */
  apply(tier: QualityTier, renderScale: number): void;
  /** Optional: told about every automatic move, for a toast or telemetry. */
  onChange?(rung: Rung, reason: 'down' | 'up'): void;
  /** Start disabled (QA, benchmarks). */
  enabled?: boolean;
}

export class QualityGovernor implements System {
  readonly name = 'qualityGovernor';

  private opts: QualityGovernorOptions;
  private ring = new Float32Array(TUNING.window);
  private cursor = 0;
  private filled = 0;

  private index = 1;
  /** Highest rung the governor may ever select: the player's own choice. */
  private ceiling = 0;
  private pinned = false;

  private settleFor = 0;
  private slowFor = 0;
  private fastFor = 0;
  private quietFor = 0;

  private downgrades = 0;
  private upgrades = 0;
  /** Diagnostics: distinguishes "never ticked" from "every frame discarded". */
  private ticks = 0;
  private discarded = 0;
  private lastMs = 0;
  /** Guards against reacting to a change we made ourselves. */
  private lastApplied: Rung | null = null;

  constructor(opts: QualityGovernorOptions) {
    this.opts = opts;
    this.pinned = opts.enabled === false;
    const s = opts.getSettings();
    this.index = nearestRung(s.quality, s.renderScale);
    this.ceiling = this.index;
  }

  /** Disable adaptation entirely (benchmark runs, QA determinism). */
  pin(on = true): void {
    this.pinned = on;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  /**
   * The player changed quality by hand. That becomes the new ceiling — we may
   * still descend to keep the game playable, never climb past it — and the
   * evidence windows reset so the new setting is judged on its own frames.
   */
  notifyManualChange(settings: SettingsState): void {
    const at = nearestRung(settings.quality, settings.renderScale);
    if (this.lastApplied && LADDER[at] === this.lastApplied) return; // our own move
    this.index = at;
    this.ceiling = at;
    this.reset();
  }

  update(ctx: GameContext, _dt: number): void {
    if (this.pinned) return;

    // rawDt, not dt: dt is clamped to CONFIG.maxFrameDelta, which would hide
    // exactly the catastrophic frames this governor exists to notice.
    const ms = ctx.rawDt * 1000;
    this.ticks++;
    this.lastMs = ms;
    if (!Number.isFinite(ms) || ms <= 0) return;

    // A backgrounded tab reports enormous deltas. Judging quality on those
    // would drop a player to the bottom rung while they read their email.
    if (typeof document !== 'undefined' && document.hidden) {
      this.settleFor = TUNING.settle;
      return;
    }

    // Only a suspend/resume is discarded. An earlier version threw away
    // anything over 400 ms as an outlier, which was exactly backwards: a
    // machine rendering at 2 fps has 500 ms frames, so the guard went blind
    // precisely when the player most needed a downgrade. Verified against
    // headless SwiftShader — a genuinely slow renderer — where it produced
    // zero samples and the governor never moved.
    if (ms > TUNING.discardMs) {
      this.discarded++;
      this.settleFor = TUNING.settle;
      return;
    }

    // Clamp rather than discard: a 3 s hitch is real evidence of slowness, it
    // just must not be allowed to dominate the window.
    this.ring[this.cursor] = Math.min(ms, TUNING.clampMs);
    this.cursor = (this.cursor + 1) % TUNING.window;
    if (this.filled < TUNING.window) this.filled++;

    const sec = Math.min(ms / 1000, 0.5);
    this.quietFor += sec;
    if (this.settleFor > 0) {
      this.settleFor -= sec;
      return;
    }

    // Need a real sample before acting. 30 frames is ~0.5s at 60fps and about
    // 2s on the machines this matters for.
    if (this.filled < 30) return;
    const med = this.median();

    if (med > TUNING.downMs) {
      this.slowFor += sec;
      this.fastFor = 0;
    } else if (med < TUNING.upMs) {
      this.fastFor += sec;
      this.slowFor = 0;
    } else {
      // The dead band: fast enough to be fine, slow enough that the next rung
      // up would not hold. Leave it alone.
      this.slowFor = 0;
      this.fastFor = 0;
    }

    if (this.slowFor >= TUNING.downWindow && this.index < LADDER.length - 1) {
      this.step(this.index + 1, 'down');
      this.quietFor = 0;
      this.downgrades++;
      return;
    }

    if (
      this.fastFor >= TUNING.upWindow &&
      this.quietFor >= TUNING.quietAfterDown &&
      this.index > this.ceiling
    ) {
      this.step(this.index - 1, 'up');
      this.upgrades++;
    }
  }

  private step(to: number, reason: 'down' | 'up'): void {
    const rung = LADDER[clamp(to, 0, LADDER.length - 1)];
    this.index = clamp(to, 0, LADDER.length - 1);
    this.lastApplied = rung;
    this.reset();
    this.opts.apply(rung.tier, rung.scale);
    this.opts.onChange?.(rung, reason);
  }

  private reset(): void {
    this.settleFor = TUNING.settle;
    this.slowFor = 0;
    this.fastFor = 0;
    this.filled = 0;
    this.cursor = 0;
  }

  /**
   * Median of the window. Deliberately not the mean: a single 400 ms GC pause
   * or first-encounter shader compile would drag a mean over the threshold and
   * cost the player a tier for one bad frame.
   */
  private median(): number {
    const n = this.filled;
    const copy = Array.from(this.ring.subarray(0, n));
    copy.sort((a, b) => a - b);
    return copy[n >> 1];
  }

  /** QA/telemetry. */
  stats(): Record<string, number | string | boolean> {
    return {
      rung: this.index,
      tier: LADDER[this.index].tier,
      scale: LADDER[this.index].scale,
      ceiling: this.ceiling,
      medianMs: this.filled >= 8 ? Number(this.median().toFixed(2)) : 0,
      slowFor: Number(this.slowFor.toFixed(2)),
      fastFor: Number(this.fastFor.toFixed(2)),
      downgrades: this.downgrades,
      upgrades: this.upgrades,
      ticks: this.ticks,
      discarded: this.discarded,
      lastMs: Number(this.lastMs.toFixed(1)),
      filled: this.filled,
      pinned: this.pinned,
    };
  }
}

/** Closest rung to an arbitrary (tier, scale), so any saved state maps in. */
function nearestRung(tier: QualityTier, scale: number): number {
  let best = 1;
  let bestCost = Infinity;
  for (let i = 0; i < LADDER.length; i++) {
    const r = LADDER[i];
    // Tier dominates: a rung with the right tier always beats a closer scale.
    const cost = (r.tier === tier ? 0 : 10) + Math.abs(r.scale - scale);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}
