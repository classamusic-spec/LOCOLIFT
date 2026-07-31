/**
 * Loco Lift — in-shift heads-up display.
 *
 * Layout obeys ART_REFERENCE §6.2: every widget hugs a corner or an edge, the
 * central 45–60 % of the frame (the driving line and the horizon band) stays
 * clear, and the only element allowed near the middle is the destination arrow
 * at 68–76 % height, which lives in `arrowSlot` and is owned by
 * `DestinationArrow`.
 *
 * Performance contract — this runs every frame:
 *  - no layout-triggering reads or writes (no width/height/top/left, no
 *    `offsetWidth`, no `getBoundingClientRect`);
 *  - bars are `transform: scaleX()` written straight onto the fill element
 *    (`ScaleSlot`) and only when the value moves past an epsilon. They are
 *    deliberately *not* driven by a CSS custom property: an unregistered custom
 *    property is opaque to the style engine, and Chromium schedules a layout
 *    pass on every write to one — measured at one layout per frame before this
 *    was changed, and effectively zero after;
 *  - text is written only when the *rendered string* changes;
 *  - score popups come from a fixed pool, so a busy combo allocates nothing.
 */
import * as THREE from 'three';
import { clamp01, lerp, MPS_TO_KMH, MPS_TO_MPH } from '../core/MathUtils';
import type { PassengerMood, SettingsState } from '../core/types';
import {
  el,
  FlagSlot,
  ScaleSlot,
  formatClock,
  formatInt,
  formatTenths,
  svg,
  TextSlot,
  UITheme,
} from './UITheme';

/* ------------------------------------------------------------------- types */

/** Everything the HUD needs from a frame. Built once by `UISystem`, reused. */
export interface HudFrame {
  /** clamped gameplay delta, seconds */
  dt: number;
  /** unclamped wall-clock delta, seconds — drives UI animation while paused */
  rawDt: number;
  camera: THREE.PerspectiveCamera;
  /** viewport size in CSS pixels (cached by UISystem, never measured here) */
  width: number;
  height: number;
  /** true while the shift clock is running */
  running: boolean;
}

/** Passenger identity as the HUD card needs it. */
export interface HudPassenger {
  archetypeId: string;
  name: string;
  blurb: string;
  /** 0xRRGGBB archetype tint */
  color: number;
  fareEstimate: number;
}

export type PopupRole = 'combo' | 'pickup' | 'dest' | 'player' | 'danger';

const MOOD_LABEL: Record<PassengerMood, string> = {
  calm: 'Tranquilo',
  happy: 'Contento',
  thrilled: 'Eufórico',
  nervous: 'Nervioso',
  furious: 'Furioso',
  terrified: 'Aterrado',
};

const MOOD_TONE: Record<PassengerMood, string> = {
  calm: 'var(--ll-text-muted)',
  happy: 'var(--ll-combo)',
  thrilled: 'var(--ll-pickup)',
  nervous: 'var(--ll-player)',
  furious: 'var(--ll-danger)',
  terrified: 'var(--ll-danger)',
};

/** Mouth path per mood, drawn in the 0..64 portrait viewBox. */
const MOOD_MOUTH: Record<PassengerMood, string> = {
  calm: 'M25 43 Q32 46 39 43',
  happy: 'M23 41 Q32 51 41 41',
  thrilled: 'M22 40 Q32 54 42 40 Q32 47 22 40',
  nervous: 'M25 45 Q32 41 39 45',
  furious: 'M24 46 Q32 39 40 46',
  terrified: 'M27 42 Q32 52 37 42 Q32 38 27 42',
};

/** Brow tilt in degrees per mood — the cheapest possible expression control. */
const MOOD_BROW: Record<PassengerMood, number> = {
  calm: 0,
  happy: -6,
  thrilled: -12,
  nervous: 10,
  furious: 22,
  terrified: -18,
};

/**
 * A continuous melanin ramp — ART_REFERENCE §7.2 asks for the real Puerto Rican
 * range, not three presets. Portraits sample it by hash.
 */
const SKIN_RAMP = [
  '#F5D3B8',
  '#E8BC96',
  '#D9A276',
  '#C08457',
  '#9E6440',
  '#7C4A2E',
  '#5E3620',
  '#452718',
];

const HAIR_COLORS = ['#1C1512', '#2E211A', '#4A3124', '#6B4A2E', '#8A6B45', '#C9C3BC'];

/** Length of the speedometer arc path, px in its own viewBox (π × r 42). */
const SPEED_ARC_LENGTH = 131.95;

const POPUP_POOL = 26;
const CALLOUT_POOL = 6;
const CALLOUT_LIFE = 1.5;
const POPUP_LIFE = 1.15;

/* --------------------------------------------------------------- internals */

interface PopupSlot {
  node: HTMLElement;
  text: TextSlot;
  life: number;
  active: boolean;
}

interface CalloutSlot {
  node: HTMLElement;
  label: TextSlot;
  points: TextSlot;
  life: number;
  active: boolean;
}

/** djb2 — deterministic per-archetype portrait variation. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/* ----------------------------------------------------------------- the HUD */

export class HUD {
  readonly el: HTMLElement;
  /** `Minimap` mounts itself in here. */
  readonly minimapSlot: HTMLElement;
  /** `DestinationArrow` mounts itself in here. */
  readonly arrowSlot: HTMLElement;

  /** Fired when the 3·2·1 countdown reaches "¡DALE!". */
  onCountdownDone: (() => void) | null = null;

  private readonly theme: UITheme;

  /* timer */
  private readonly timerDigits: TextSlot;
  private readonly timerTenths: TextSlot;
  private readonly timerBar: ScaleSlot;
  private readonly timerNode: HTMLElement;
  private readonly timerWarn: FlagSlot;
  private readonly timerCrit: FlagSlot;
  private remaining = 0;
  private totalTime = 1;

  /* fare */
  private readonly fareValue: TextSlot;
  private readonly fareTicking: FlagSlot;
  private scoreTarget = 0;
  private scoreShown = 0;

  /* combo */
  private readonly comboValue: TextSlot;
  private readonly comboBar: ScaleSlot;
  private readonly comboOn: FlagSlot;
  private comboMultiplier = 1;
  private comboWindow = 0;
  private comboWindowMax = 4;

  /* callouts */
  private readonly calloutLayer: HTMLElement;
  private readonly callouts: CalloutSlot[] = [];

  /* boost */
  private readonly boostFill: ScaleSlot;
  private readonly boostFull: FlagSlot;
  private readonly boostActive: FlagSlot;

  /* speed */
  private readonly speedValue: TextSlot;
  private readonly speedUnit: TextSlot;
  private readonly speedArc: SVGPathElement;
  private lastNeedle = Number.NaN;
  private units: SettingsState['showSpeedUnits'] = 'mph';

  /* passenger */
  private readonly cardNode: HTMLElement;
  private readonly cardName: TextSlot;
  private readonly cardBlurb: TextSlot;
  private readonly cardMood: TextSlot;
  private readonly cardFare: TextSlot;
  private readonly patienceBar: ScaleSlot;
  private readonly patienceLow: FlagSlot;
  private readonly patienceMid: FlagSlot;
  private readonly portrait: SVGSVGElement;
  private readonly portraitBg: SVGCircleElement;
  private readonly portraitSkin: SVGGElement;
  private readonly portraitHair: SVGPathElement;
  private readonly portraitMouth: SVGPathElement;
  private readonly portraitBrows: SVGGElement;
  private readonly portraitExtra: SVGGElement;
  private patience = 1;

  /* dialogue */
  private readonly subNode: HTMLElement;
  private readonly subWho: TextSlot;
  private readonly subText: TextSlot;
  private subLife = 0;
  private subtitlesOn = true;

  /* destination banner */
  private readonly destNode: HTMLElement;
  private readonly destName: TextSlot;
  private readonly destDist: TextSlot;

  /* popups */
  private readonly popupLayer: HTMLElement;
  private readonly popups: PopupSlot[] = [];
  private readonly popupWorld: THREE.Vector3[] = [];
  private popupCursor = 0;
  private readonly projected = new THREE.Vector3();

  /* countdown + time extension */
  private readonly countNode: HTMLElement;
  private readonly countText: TextSlot;
  /** seconds left; `-1` means idle. Negative-but-above-−1 is the "¡DALE!" hold. */
  private countdownT = -1;
  private countdownStep = -1;
  private readonly extNode: HTMLElement;
  private readonly extText: TextSlot;
  private readonly extWhy: TextSlot;
  private extLife = 0;

  /* state flags */
  private readonly flashLayer: HTMLElement;
  private readonly driftFlag: FlagSlot;
  private readonly airFlag: FlagSlot;

  constructor(theme: UITheme) {
    this.theme = theme;
    const root = el('div', 'll-hud');
    root.setAttribute('aria-live', 'off');
    this.el = root;

    /* ---------------------------------------------------------- top-left */
    const tl = el('div', 'll-hud__tl');

    const fare = el('div', 'll-fare');
    const fareLabel = el('div', 'll-fare__label');
    fareLabel.append(el('span', 'll-lbl-es', 'TARIFA'), el('span', 'll-lbl-en', 'Fare'));
    const fareRow = el('div', 'll-fare__row');
    const fareSign = el('span', 'll-fare__sign', '$');
    const fareVal = el('span', 'll-fare__value', '0');
    fareRow.append(fareSign, fareVal);
    fare.append(fareLabel, fareRow);
    fare.setAttribute('role', 'status');
    fare.setAttribute('aria-label', 'Fare total');
    this.fareValue = new TextSlot(fareVal);
    this.fareTicking = new FlagSlot(fare, 'is-ticking');

    const combo = el('div', 'll-combo');
    const comboChip = el('div', 'll-combo__chip');
    const comboX = el('span', 'll-combo__x', '×');
    const comboV = el('span', 'll-combo__value', '1');
    comboChip.append(comboX, comboV);
    const comboStack = el('div', 'll-combo__stack');
    const comboLabel = el('div', 'll-combo__label', 'COMBO');
    const comboTrack = el('div', 'll-combo__track');
    const comboFill = el('div', 'll-combo__fill');
    comboTrack.append(comboFill);
    comboStack.append(comboLabel, comboTrack);
    combo.append(comboChip, comboStack);
    this.comboValue = new TextSlot(comboV);
    this.comboBar = new ScaleSlot(comboFill, 0.004);
    this.comboOn = new FlagSlot(combo, 'is-on');

    tl.append(fare, combo);

    /* -------------------------------------------------------- top-centre */
    const tc = el('div', 'll-hud__tc');

    const timer = el('div', 'll-timer');
    timer.setAttribute('role', 'timer');
    timer.setAttribute('aria-label', 'Time remaining');
    const timerLabel = el('div', 'll-timer__label');
    timerLabel.append(el('span', 'll-lbl-es', 'TIEMPO'), el('span', 'll-lbl-en', 'Time'));
    const timerRow = el('div', 'll-timer__row');
    const digits = el('span', 'll-timer__digits', '0');
    const tenths = el('span', 'll-timer__tenths', '.0');
    timerRow.append(digits, tenths);
    const timerTrack = el('div', 'll-timer__track');
    const timerFill = el('div', 'll-timer__fill');
    timerTrack.append(timerFill);
    timer.append(timerLabel, timerRow, timerTrack);
    this.timerNode = timer;
    this.timerDigits = new TextSlot(digits);
    this.timerTenths = new TextSlot(tenths);
    this.timerBar = new ScaleSlot(timerFill, 0.003);
    this.timerWarn = new FlagSlot(timer, 'is-warn');
    this.timerCrit = new FlagSlot(timer, 'is-crit');

    const dest = el('div', 'll-dest');
    dest.setAttribute('role', 'status');
    const destIcon = el('span', 'll-dest__pin');
    destIcon.append(buildPinIcon());
    const destCol = el('div', 'll-dest__col');
    const destKicker = el('div', 'll-dest__kicker');
    destKicker.append(el('span', 'll-lbl-es', 'DESTINO'), el('span', 'll-lbl-en', 'Drop-off'));
    const destNameEl = el('div', 'll-dest__name', '—');
    destCol.append(destKicker, destNameEl);
    const destDistEl = el('div', 'll-dest__dist', '');
    dest.append(destIcon, destCol, destDistEl);
    this.destNode = dest;
    this.destName = new TextSlot(destNameEl);
    this.destDist = new TextSlot(destDistEl);

    tc.append(timer, dest);

    /* --------------------------------------------------------- top-right */
    const tr = el('div', 'll-hud__tr');
    this.minimapSlot = el('div', 'll-hud__minimap');
    this.calloutLayer = el('div', 'll-callouts');
    this.calloutLayer.setAttribute('aria-live', 'polite');
    tr.append(this.minimapSlot, this.calloutLayer);

    for (let i = 0; i < CALLOUT_POOL; i++) {
      const node = el('div', 'll-callout');
      const label = el('span', 'll-callout__label', '');
      const pts = el('span', 'll-callout__pts', '');
      node.append(label, pts);
      node.style.display = 'none';
      this.calloutLayer.append(node);
      this.callouts.push({
        node,
        label: new TextSlot(label),
        points: new TextSlot(pts),
        life: 0,
        active: false,
      });
    }

    /* ------------------------------------------------------- bottom-left */
    const bl = el('div', 'll-hud__bl');
    const card = el('div', 'll-card');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-label', 'Current passenger');

    const portraitWrap = el('div', 'll-card__portrait');
    const p = buildPortrait();
    this.portrait = p.root;
    this.portraitBg = p.bg;
    this.portraitSkin = p.skin;
    this.portraitHair = p.hair;
    this.portraitMouth = p.mouth;
    this.portraitBrows = p.brows;
    this.portraitExtra = p.extra;
    portraitWrap.append(this.portrait);

    const cardBody = el('div', 'll-card__body');
    const cardTop = el('div', 'll-card__top');
    const nameEl = el('div', 'll-card__name', '');
    const moodEl = el('div', 'll-card__mood', '');
    cardTop.append(nameEl, moodEl);
    const blurbEl = el('div', 'll-card__blurb', '');
    const patTrack = el('div', 'll-card__patience');
    patTrack.setAttribute('role', 'progressbar');
    patTrack.setAttribute('aria-label', 'Passenger patience');
    const patFill = el('div', 'll-card__patience-fill');
    patTrack.append(patFill);
    const patLabel = el('div', 'll-card__patience-label');
    patLabel.append(el('span', 'll-lbl-es', 'PACIENCIA'), el('span', 'll-lbl-en', 'Patience'));
    const fareEl = el('div', 'll-card__fare', '');
    const patRow = el('div', 'll-card__patrow');
    patRow.append(patLabel, fareEl);
    cardBody.append(cardTop, blurbEl, patRow, patTrack);

    card.append(portraitWrap, cardBody);
    this.cardNode = card;
    this.cardName = new TextSlot(nameEl);
    this.cardBlurb = new TextSlot(blurbEl);
    this.cardMood = new TextSlot(moodEl);
    this.cardFare = new TextSlot(fareEl);
    this.patienceBar = new ScaleSlot(patFill, 0.004);
    this.patienceLow = new FlagSlot(card, 'is-impatient');
    this.patienceMid = new FlagSlot(card, 'is-restless');
    bl.append(card);

    /* ------------------------------------------------------ bottom-right */
    const br = el('div', 'll-hud__br');

    const speedo = el('div', 'll-speedo');
    speedo.setAttribute('role', 'status');
    speedo.setAttribute('aria-label', 'Speed');
    const gauge = el('div', 'll-speedo__gauge');
    const arcSvg = buildSpeedArc();
    gauge.append(arcSvg);
    const arc = arcSvg.querySelector('.ll-speedo__arc') as SVGPathElement;
    const speedRow = el('div', 'll-speedo__row');
    const speedV = el('span', 'll-speedo__value', '0');
    const speedU = el('span', 'll-speedo__unit', 'MPH');
    speedRow.append(speedV, speedU);
    speedo.append(gauge, speedRow);
    this.speedValue = new TextSlot(speedV);
    this.speedUnit = new TextSlot(speedU);
    this.speedArc = arc;

    const boost = el('div', 'll-boost');
    const boostLabel = el('div', 'll-boost__label');
    boostLabel.append(el('span', 'll-lbl-es', 'TURBO'), el('span', 'll-lbl-en', 'Boost'));
    const boostTrack = el('div', 'll-boost__track');
    boostTrack.setAttribute('role', 'progressbar');
    boostTrack.setAttribute('aria-label', 'Boost charge');
    const boostFill = el('div', 'll-boost__fill');
    boostTrack.append(boostFill, el('div', 'll-boost__ticks'));
    boost.append(boostLabel, boostTrack);
    this.boostFill = new ScaleSlot(boostFill, 0.004);
    this.boostFull = new FlagSlot(boost, 'is-full');
    this.boostActive = new FlagSlot(boost, 'is-active');

    br.append(boost, speedo);

    /* ---------------------------------------------------------- subtitle */
    const sub = el('div', 'll-sub');
    sub.setAttribute('role', 'status');
    sub.setAttribute('aria-live', 'polite');
    const subWhoEl = el('span', 'll-sub__who', '');
    const subTextEl = el('span', 'll-sub__text', '');
    sub.append(subWhoEl, subTextEl);
    this.subNode = sub;
    this.subWho = new TextSlot(subWhoEl);
    this.subText = new TextSlot(subTextEl);

    /* ------------------------------------------------------------ layers */
    this.popupLayer = el('div', 'll-pops');
    for (let i = 0; i < POPUP_POOL; i++) {
      const node = el('div', 'll-pop');
      node.style.display = 'none';
      this.popupLayer.append(node);
      this.popups.push({ node, text: new TextSlot(node), life: 0, active: false });
      this.popupWorld.push(new THREE.Vector3());
    }

    this.arrowSlot = el('div', 'll-hud__arrow');

    const count = el('div', 'll-count');
    count.setAttribute('aria-live', 'assertive');
    const countTextEl = el('div', 'll-count__text', '');
    count.append(countTextEl);
    this.countNode = count;
    this.countText = new TextSlot(countTextEl);

    const ext = el('div', 'll-timeext');
    const extV = el('div', 'll-timeext__value', '');
    const extW = el('div', 'll-timeext__why', '');
    ext.append(extV, extW);
    this.extNode = ext;
    this.extText = new TextSlot(extV);
    this.extWhy = new TextSlot(extW);

    this.flashLayer = el('div', 'll-flash');
    this.driftFlag = new FlagSlot(root, 'is-drifting');
    this.airFlag = new FlagSlot(root, 'is-airborne');

    root.append(
      this.flashLayer,
      tl,
      tc,
      tr,
      bl,
      br,
      sub,
      this.arrowSlot,
      this.popupLayer,
      count,
      ext,
    );

    this.setPassenger(null);
    this.setDestination(null);
    this.clearSay();
  }

  /* ------------------------------------------------------------- lifecycle */

  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  unmount(): void {
    this.el.remove();
  }

  applySettings(s: SettingsState): void {
    this.units = s.showSpeedUnits;
    this.subtitlesOn = s.subtitles;
    if (!this.subtitlesOn) this.clearSay();
    this.speedUnit.set(this.units === 'kmh' ? 'KM/H' : 'MPH');
  }

  /* ------------------------------------------------------------- setters */

  /** Set the shift clock. `total` seeds the depletion bar. */
  setTime(remaining: number, total?: number): void {
    this.remaining = Math.max(0, remaining);
    if (total !== undefined && total > 0) this.totalTime = total;
    if (this.remaining > this.totalTime) this.totalTime = this.remaining;
  }

  addTime(seconds: number): void {
    this.remaining = Math.max(0, this.remaining + seconds);
    if (this.remaining > this.totalTime) this.totalTime = this.remaining;
  }

  get timeRemaining(): number {
    return this.remaining;
  }

  /** Score/fare target — the readout eases toward it rather than snapping. */
  setScore(value: number, snap = false): void {
    this.scoreTarget = value;
    if (snap) this.scoreShown = value;
  }

  setCombo(multiplier: number, windowSeconds?: number): void {
    this.comboMultiplier = Math.max(1, multiplier);
    if (windowSeconds !== undefined && windowSeconds > 0) {
      this.comboWindowMax = windowSeconds;
      this.comboWindow = windowSeconds;
    }
  }

  /** Refresh the decay window without changing the multiplier. */
  refreshCombo(windowSeconds = this.comboWindowMax): void {
    this.comboWindowMax = windowSeconds;
    this.comboWindow = windowSeconds;
  }

  breakCombo(): void {
    this.comboMultiplier = 1;
    this.comboWindow = 0;
  }

  /** Punchy stacked callout — "¡DRIFT!", "NEAR MISS!", "BIG AIR!". */
  pushCallout(label: string, points?: number): void {
    let slot = this.callouts.find((c) => !c.active);
    if (!slot) {
      // recycle the oldest
      slot = this.callouts.reduce((a, b) => (a.life < b.life ? a : b));
    }
    slot.active = true;
    slot.life = CALLOUT_LIFE;
    slot.label.set(label.toUpperCase());
    slot.points.set(points && points > 0 ? `+${formatInt(points)}` : '');
    slot.node.style.display = '';
    this.calloutLayer.append(slot.node);
    const dur = this.theme.duration(340);
    slot.node.animate(
      this.theme.flashSafe
        ? [
            { opacity: 0 },
            { opacity: 1 },
          ]
        : [
            { transform: 'skewX(-8deg) translate3d(46%, 0, 0) scale(0.72)', opacity: 0 },
            { transform: 'skewX(-8deg) translate3d(-4%, 0, 0) scale(1.06)', opacity: 1, offset: 0.62 },
            { transform: 'skewX(-8deg) translate3d(0, 0, 0) scale(1)', opacity: 1 },
          ],
      { duration: dur, easing: this.theme.ease('back'), fill: 'none' },
    );
  }

  setBoost(fraction: number, active: boolean): void {
    this.pendingBoost = clamp01(fraction);
    this.pendingBoostActive = active;
  }

  setSpeed(metresPerSecond: number): void {
    this.pendingSpeed = Math.max(0, metresPerSecond);
  }

  private pendingBoost = 0;
  private pendingBoostActive = false;
  private pendingSpeed = 0;

  setPassenger(p: HudPassenger | null): void {
    if (!p) {
      this.cardNode.classList.remove('is-live');
      this.cardNode.setAttribute('aria-hidden', 'true');
      this.patience = 1;
      return;
    }
    this.cardNode.classList.add('is-live');
    this.cardNode.removeAttribute('aria-hidden');
    this.cardName.set(p.name);
    this.cardBlurb.set(p.blurb);
    this.cardFare.set(p.fareEstimate > 0 ? `$${formatInt(p.fareEstimate)}` : '');
    this.paintPortrait(p.archetypeId, p.color);
    this.setMood('calm');
    this.patience = 1;
    this.patienceBar.invalidate();
    if (!this.theme.flashSafe) {
      this.cardNode.animate(
        [
          { transform: 'translate3d(-26%, 0, 0)', opacity: 0 },
          { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        ],
        { duration: this.theme.duration(360), easing: this.theme.ease('back') },
      );
    }
  }

  setMood(mood: PassengerMood): void {
    this.cardMood.set(MOOD_LABEL[mood]);
    this.cardNode.style.setProperty('--mood', MOOD_TONE[mood]);
    this.portraitMouth.setAttribute('d', MOOD_MOUTH[mood]);
    this.portraitBrows.setAttribute('style', `--brow:${MOOD_BROW[mood]}deg`);
    this.portrait.dataset.mood = mood;
  }

  /** 1 = fresh, 0 = about to bail. */
  setPatience(fraction: number): void {
    this.patience = clamp01(fraction);
  }

  get patienceFraction(): number {
    return this.patience;
  }

  /** Passenger speech. Ignored when `settings.subtitles` is off. */
  say(speaker: string, text: string, seconds = 3.4): void {
    if (!this.subtitlesOn || !text) return;
    this.subWho.set(speaker ? `${speaker}:` : '');
    this.subText.set(text);
    this.subLife = seconds;
    this.subNode.classList.add('is-live');
  }

  clearSay(): void {
    this.subLife = 0;
    this.subNode.classList.remove('is-live');
  }

  /** POI name in the destination banner. `null` hides it. */
  setDestination(name: string | null): void {
    if (!name) {
      this.destNode.classList.remove('is-live');
      this.destNode.setAttribute('aria-hidden', 'true');
      this.destDist.set('');
      return;
    }
    this.destNode.classList.add('is-live');
    this.destNode.removeAttribute('aria-hidden');
    this.destName.set(name);
    if (!this.theme.flashSafe) {
      this.destNode.animate(
        [
          { transform: 'translate3d(0, -140%, 0)', opacity: 0 },
          { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        ],
        { duration: this.theme.duration(420), easing: this.theme.ease('back') },
      );
    }
  }

  /** Metres to the drop-off; shown in the banner. Cheap, string-cached. */
  setDestinationDistance(metres: number): void {
    this.pendingDistance = metres;
  }

  private pendingDistance = -1;

  /** Floating score popup anchored to a world position. */
  scorePopup(world: THREE.Vector3, text: string, role: PopupRole = 'combo'): void {
    const i = this.popupCursor;
    this.popupCursor = (this.popupCursor + 1) % this.popups.length;
    const slot = this.popups[i];
    slot.active = true;
    slot.life = POPUP_LIFE;
    slot.node.dataset.role = role;
    slot.text.set(text);
    slot.node.style.display = '';
    slot.node.style.opacity = '0';
    this.popupWorld[i].copy(world);
  }

  /**
   * A soft edge pulse — near miss, impact, pickup. Always suppressed under
   * `photosensitiveSafe` / `prefers-reduced-motion`: this is exactly the kind of
   * full-frame luminance jump those settings exist to remove.
   */
  flash(role: PopupRole): void {
    if (this.theme.flashSafe) return;
    this.flashLayer.dataset.role = role;
    this.flashLayer.animate([{ opacity: 0 }, { opacity: 0.85, offset: 0.18 }, { opacity: 0 }], {
      duration: this.theme.duration(300),
      easing: this.theme.ease('outExpo'),
    });
  }

  /** Drift / air state, used for subtle HUD reactions only. */
  setDriveState(drifting: boolean, airborne: boolean): void {
    this.driftFlag.set(drifting);
    this.airFlag.set(airborne);
  }

  /** Dim the HUD while a menu owns the screen. */
  setDimmed(dim: boolean): void {
    this.el.classList.toggle('is-dimmed', dim);
  }

  /** "3 · 2 · 1 · ¡DALE!" — three ticks, then the go card holds for ~0.8 s. */
  startCountdown(): void {
    this.countdownT = 2.999;
    this.countdownStep = -1;
    this.countNode.classList.add('is-live');
  }

  get countdownActive(): boolean {
    return this.countdownT >= 0;
  }

  /** Big green "+15 s" flash next to the clock. */
  flashTimeExtension(seconds: number, reason: string): void {
    this.extText.set(`+${Math.round(seconds)}s`);
    this.extWhy.set(reason.toUpperCase());
    this.extLife = 1.5;
    this.extNode.classList.add('is-live');
    this.timerNode.classList.add('is-extended');
    if (!this.theme.flashSafe) {
      this.extNode.animate(
        [
          { transform: 'translate3d(-50%, 26px, 0) scale(0.6)', opacity: 0 },
          { transform: 'translate3d(-50%, -6px, 0) scale(1.12)', opacity: 1, offset: 0.4 },
          { transform: 'translate3d(-50%, 0, 0) scale(1)', opacity: 1 },
        ],
        { duration: this.theme.duration(520), easing: this.theme.ease('back') },
      );
    }
  }

  /* ---------------------------------------------------------------- frame */

  update(frame: HudFrame): void {
    const dt = frame.dt;
    const raw = frame.rawDt;

    /* clock ------------------------------------------------------------- */
    if (frame.running && this.countdownT < 0) {
      this.remaining = Math.max(0, this.remaining - dt);
    }
    this.timerDigits.set(formatClock(this.remaining));
    this.timerTenths.set(this.remaining < 60 ? formatTenths(this.remaining) : '');
    this.timerBar.set(this.totalTime > 0 ? clamp01(this.remaining / this.totalTime) : 0);
    const warn = this.remaining <= 15 && this.remaining > 0;
    this.timerWarn.set(warn);
    this.timerCrit.set(this.remaining <= 5 && this.remaining > 0);

    /* fare -------------------------------------------------------------- */
    if (this.scoreShown !== this.scoreTarget) {
      const diff = this.scoreTarget - this.scoreShown;
      const mag = Math.abs(diff);
      // Framerate-independent ease with an absolute floor, so a big jackpot
      // lands in ~0.5 s and the last few dollars never crawl.
      const step = Math.max(mag * (1 - Math.exp(-11 * raw)), Math.min(mag, 900 * raw));
      this.scoreShown = mag <= step ? this.scoreTarget : this.scoreShown + Math.sign(diff) * step;
      this.fareValue.set(formatInt(this.scoreShown));
      this.fareTicking.set(true);
    } else {
      this.fareTicking.set(false);
    }

    /* combo ------------------------------------------------------------- */
    if (this.comboWindow > 0) {
      this.comboWindow = Math.max(0, this.comboWindow - dt);
      if (this.comboWindow === 0) this.comboMultiplier = 1;
    }
    this.comboOn.set(this.comboMultiplier > 1);
    this.comboValue.set(String(Math.round(this.comboMultiplier)));
    this.comboBar.set(this.comboWindowMax > 0 ? clamp01(this.comboWindow / this.comboWindowMax) : 0);

    /* callouts ---------------------------------------------------------- */
    for (let i = 0; i < this.callouts.length; i++) {
      const c = this.callouts[i];
      if (!c.active) continue;
      c.life -= raw;
      if (c.life <= 0) {
        c.active = false;
        c.node.style.display = 'none';
      } else if (c.life < 0.32) {
        c.node.style.opacity = (c.life / 0.32).toFixed(2);
      } else {
        c.node.style.opacity = '1';
      }
    }

    /* boost + speed ----------------------------------------------------- */
    this.boostFill.set(this.pendingBoost);
    this.boostFull.set(this.pendingBoost >= 0.999);
    this.boostActive.set(this.pendingBoostActive);

    const shown = this.pendingSpeed * (this.units === 'kmh' ? MPS_TO_KMH : MPS_TO_MPH);
    this.speedValue.set(String(Math.round(shown)));
    const needle = clamp01(this.pendingSpeed / 60);
    if (!(Math.abs(needle - this.lastNeedle) < 0.004)) {
      this.lastNeedle = needle;
      this.speedArc.style.strokeDashoffset = `${(SPEED_ARC_LENGTH * (1 - needle)).toFixed(2)}px`;
    }

    /* patience ---------------------------------------------------------- */
    this.patienceBar.set(this.patience);
    this.patienceLow.set(this.patience < 0.28);
    this.patienceMid.set(this.patience < 0.58 && this.patience >= 0.28);

    /* destination distance ---------------------------------------------- */
    if (this.pendingDistance >= 0) {
      // quantised to 5 m so it agrees with the navigation pin exactly
      this.destDist.set(
        this.pendingDistance >= 1000
          ? `${(this.pendingDistance / 1000).toFixed(1)} km`
          : `${Math.round(this.pendingDistance / 5) * 5} m`,
      );
    } else {
      this.destDist.set('');
    }

    /* subtitle ---------------------------------------------------------- */
    if (this.subLife > 0) {
      this.subLife -= raw;
      if (this.subLife <= 0) this.subNode.classList.remove('is-live');
    }

    /* popups ------------------------------------------------------------ */
    this.updatePopups(frame);

    /* countdown --------------------------------------------------------- */
    if (this.countdownT > -1) {
      this.countdownT -= raw;
      const step = Math.max(0, Math.ceil(this.countdownT));
      if (step !== this.countdownStep) {
        this.countdownStep = step;
        this.countText.set(step > 0 ? String(step) : '¡DALE!');
        this.countNode.dataset.step = step > 0 ? 'n' : 'go';
        const kids = this.countNode.firstElementChild as HTMLElement | null;
        if (kids) {
          kids.animate(
            this.theme.flashSafe
              ? [{ opacity: 0 }, { opacity: 1 }]
              : [
                  { transform: 'scale(2.1)', opacity: 0 },
                  { transform: 'scale(0.94)', opacity: 1, offset: 0.45 },
                  { transform: 'scale(1)', opacity: 1, offset: 0.6 },
                  { transform: 'scale(1)', opacity: 1 },
                ],
            { duration: this.theme.duration(step > 0 ? 620 : 900), easing: this.theme.ease('back') },
          );
        }
      }
      if (this.countdownT < -0.85) {
        this.countdownT = -1;
        this.countNode.classList.remove('is-live');
        this.countdownStep = -1;
        const done = this.onCountdownDone;
        if (done) done();
      }
    }

    /* time extension ---------------------------------------------------- */
    if (this.extLife > 0) {
      this.extLife -= raw;
      if (this.extLife <= 0) {
        this.extNode.classList.remove('is-live');
        this.timerNode.classList.remove('is-extended');
      }
    }
  }

  private updatePopups(frame: HudFrame): void {
    const halfW = frame.width * 0.5;
    const halfH = frame.height * 0.5;
    for (let i = 0; i < this.popups.length; i++) {
      const p = this.popups[i];
      if (!p.active) continue;
      p.life -= frame.rawDt;
      if (p.life <= 0) {
        p.active = false;
        p.node.style.display = 'none';
        continue;
      }
      const world = this.popupWorld[i];
      this.projected.copy(world).project(frame.camera);
      if (this.projected.z > 1) {
        p.node.style.opacity = '0';
        continue;
      }
      const t = 1 - p.life / POPUP_LIFE;
      const rise = this.theme.flashSafe ? 26 * t : 74 * (1 - (1 - t) * (1 - t));
      const x = (this.projected.x * 0.5 + 0.5) * frame.width;
      const y = (-this.projected.y * 0.5 + 0.5) * frame.height;
      const scale = this.theme.flashSafe ? 1 : lerp(1.28, 0.94, clamp01(t * 3));
      p.node.style.transform = `translate3d(${(x - halfW).toFixed(1)}px, ${(
        y - halfH - rise
      ).toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      p.node.style.opacity = t > 0.72 ? ((1 - t) / 0.28).toFixed(2) : '1';
    }
  }

  /* --------------------------------------------------------------- visual */

  private paintPortrait(archetypeId: string, color: number): void {
    const h = hashString(archetypeId);
    const tint = this.theme.chipColor(color);
    this.portraitBg.setAttribute('fill', tint);
    const skin = SKIN_RAMP[h % SKIN_RAMP.length];
    this.portraitSkin.setAttribute('fill', skin);
    const hair = HAIR_COLORS[(h >> 3) % HAIR_COLORS.length];
    this.portraitHair.setAttribute('fill', hair);
    this.portraitHair.setAttribute('d', HAIR_SHAPES[(h >> 7) % HAIR_SHAPES.length]);

    while (this.portraitExtra.firstChild) this.portraitExtra.removeChild(this.portraitExtra.firstChild);
    const accessory = (h >> 11) % 4;
    if (accessory === 0) {
      // glasses
      const g = svg('g');
      for (const cx of [25, 39]) {
        const c = svg('circle', {
          cx: String(cx),
          cy: '33',
          r: '6',
          fill: 'none',
          stroke: '#12181F',
          'stroke-width': '1.8',
        });
        g.append(c);
      }
      g.append(
        svg('path', { d: 'M31 33 H33', stroke: '#12181F', 'stroke-width': '1.8', fill: 'none' }),
      );
      this.portraitExtra.append(g);
    } else if (accessory === 1) {
      // cap
      this.portraitExtra.append(
        svg('path', {
          d: 'M14 24 Q32 6 50 24 L50 26 L14 26 Z',
          fill: tint,
          stroke: '#0A0C10',
          'stroke-width': '1.2',
        }),
        svg('path', { d: 'M50 24 Q58 25 58 28 L50 28 Z', fill: tint }),
      );
    } else if (accessory === 2) {
      // hoop earrings
      this.portraitExtra.append(
        svg('circle', {
          cx: '15.5',
          cy: '40',
          r: '3.4',
          fill: 'none',
          stroke: '#FFD98A',
          'stroke-width': '1.6',
        }),
        svg('circle', {
          cx: '48.5',
          cy: '40',
          r: '3.4',
          fill: 'none',
          stroke: '#FFD98A',
          'stroke-width': '1.6',
        }),
      );
    }
  }

  dispose(): void {
    this.unmount();
    this.onCountdownDone = null;
  }
}

/* ------------------------------------------------------------ SVG builders */

const HAIR_SHAPES = [
  // short crop
  'M14 32 Q14 10 32 10 Q50 10 50 32 Q47 22 32 21 Q17 21 14 32 Z',
  // curly volume
  'M12 30 Q10 8 32 8 Q54 8 52 30 Q49 16 41 15 Q37 21 32 15 Q26 21 23 15 Q15 17 12 30 Z',
  // long, tied back
  'M13 34 Q12 9 32 9 Q52 9 51 34 Q52 44 47 46 Q49 26 32 22 Q15 26 17 46 Q12 44 13 34 Z',
  // bald / receding with beard line
  'M16 28 Q18 13 32 13 Q46 13 48 28 Q44 20 32 19 Q20 19 16 28 Z',
];

interface PortraitParts {
  root: SVGSVGElement;
  bg: SVGCircleElement;
  skin: SVGGElement;
  hair: SVGPathElement;
  mouth: SVGPathElement;
  brows: SVGGElement;
  extra: SVGGElement;
}

/**
 * Procedural passenger portrait. No image assets — a colour-keyed disc, a head
 * from a melanin ramp, a hair silhouette variant, and a mood-driven mouth.
 */
function buildPortrait(): PortraitParts {
  const root = svg('svg', { viewBox: '0 0 64 64', class: 'll-portrait', 'aria-hidden': 'true' });

  const bg = svg('circle', { cx: '32', cy: '32', r: '32', fill: '#00E5FF' });
  const shade = svg('path', {
    d: 'M0 32 A32 32 0 0 0 64 32 A32 32 0 0 1 0 32 Z',
    fill: 'rgba(10,12,16,0.22)',
  });

  const skin = svg('g');
  skin.append(
    svg('path', { d: 'M20 44 Q32 40 44 44 L46 64 L18 64 Z' }), // shoulders/neck
    svg('ellipse', { cx: '32', cy: '33', rx: '15', ry: '17' }), // head
  );
  skin.setAttribute('fill', '#D9A276');

  const hair = svg('path', { d: HAIR_SHAPES[0], fill: '#2E211A' });

  const eyes = svg('g', { fill: '#14181D' });
  eyes.append(
    svg('ellipse', { cx: '25.5', cy: '33', rx: '2.1', ry: '2.6' }),
    svg('ellipse', { cx: '38.5', cy: '33', rx: '2.1', ry: '2.6' }),
  );

  const brows = svg('g', { class: 'll-portrait__brows', stroke: '#14181D', 'stroke-width': '2.2' });
  brows.append(
    svg('path', { d: 'M21 27.5 L30 26.5', class: 'll-brow ll-brow--l', fill: 'none' }),
    svg('path', { d: 'M34 26.5 L43 27.5', class: 'll-brow ll-brow--r', fill: 'none' }),
  );

  const mouth = svg('path', {
    d: MOOD_MOUTH.calm,
    fill: 'none',
    stroke: '#3A2018',
    'stroke-width': '2.4',
    'stroke-linecap': 'round',
  });

  const extra = svg('g');

  root.append(bg, shade, skin, hair, eyes, brows, mouth, extra);
  return { root, bg, skin, hair, mouth, brows, extra };
}

/** The destination pin glyph — a garita-shaped marker, §7.4's national motif. */
function buildPinIcon(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.append(
    svg('path', {
      d: 'M12 1.6 C7.7 1.6 4.6 5 4.6 9.1 C4.6 14.6 12 22.4 12 22.4 S19.4 14.6 19.4 9.1 C19.4 5 16.3 1.6 12 1.6 Z',
      fill: 'currentColor',
      stroke: 'var(--ll-ink)',
      'stroke-width': '1.6',
    }),
    svg('path', {
      d: 'M9 11.4 V8.2 A3 3 0 0 1 15 8.2 V11.4 Z M8.4 11.4 H15.6 V12.6 H8.4 Z',
      fill: 'var(--ll-ink)',
    }),
  );
  return s;
}

/** Speedometer arc: a static track plus a needle rotated by `--needle`. */
function buildSpeedArc(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 100 58', 'aria-hidden': 'true' });
  s.append(
    svg('path', {
      d: 'M8 52 A42 42 0 0 1 92 52',
      fill: 'none',
      stroke: 'rgba(255,246,232,0.16)',
      'stroke-width': '7',
      'stroke-linecap': 'round',
    }),
    svg('path', {
      d: 'M8 52 A42 42 0 0 1 92 52',
      fill: 'none',
      stroke: 'var(--ll-pickup)',
      'stroke-width': '7',
      'stroke-linecap': 'round',
      class: 'll-speedo__arc',
      'stroke-dasharray': '132',
    }),
  );
  const ticks = svg('g', { stroke: 'rgba(255,246,232,0.34)', 'stroke-width': '2' });
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    const x1 = 50 + Math.cos(a) * 34;
    const y1 = 52 + Math.sin(a) * 34;
    const x2 = 50 + Math.cos(a) * 29;
    const y2 = 52 + Math.sin(a) * 29;
    ticks.append(
      svg('path', { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}` }),
    );
  }
  s.append(ticks);
  return s;
}

/** Mood label lookup, shared with the results screen and toasts. */
export { MOOD_LABEL };
