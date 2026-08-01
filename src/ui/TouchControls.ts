/**
 * Loco Lift — on-screen driving controls.
 *
 * A phone has no keyboard, so this module is the whole control surface: a
 * floating analogue steering thumbstick (or a wheel, or ramped arrows), pedals,
 * drift, boost, horn, flip, pause, and a live setup panel for handedness, size,
 * position, opacity and haptics.
 *
 * Three things drove the design.
 *
 * 1. **It writes to a shared channel, not to a reference.** The controls are
 *    built by the UI layer, which never sees the `Input` instance `main`
 *    constructed. Both sides talk through `touchChannel` in `core/Input`.
 *
 * 2. **It costs no layout per frame.** Every rectangle the pointer code needs
 *    is measured once per layout change (mount, resize, orientation, settings)
 *    and cached; hit-testing is pure arithmetic. The only per-frame DOM writes
 *    are `transform` on the knob and `transform: scaleY()` on the boost fill,
 *    both on elements that already declare `will-change`, both epsilon-gated.
 *    No custom property is written per frame — an *unregistered* custom
 *    property is opaque to the style engine and forces a layout pass on every
 *    write, which is exactly the bug this codebase has eaten before.
 *
 * 3. **Steering is smoothed, not sampled.** A raw finger position mapped
 *    straight onto the front wheels is jittery and twitchy. The finger goes
 *    through a low-pass, then a deadzone, then an expo curve, and the result
 *    is slew-rate limited — the same treatment the keyboard ramp gets, tuned
 *    for a thumb.
 */
import {
  resetTouchChannel,
  touchChannel,
  type TouchInputChannel,
} from '../core/Input';
import { clamp, clamp01, deadzone, expoCurve, moveTowards, wrapAngle } from '../core/MathUtils';
import type { SettingsState } from '../core/types';
import { el, FlagSlot, svg, type UITheme } from './UITheme';

/**
 * A bottom-anchored bar fill, written as `transform: scaleY()`.
 *
 * `ScaleSlot` in UITheme writes `scaleX` — correct for the horizontal HUD bars
 * it was built for, wrong for the ring that climbs the inside of the TURBO
 * button. Rather than widen that class (and change every HUD bar's meaning),
 * the vertical case lives here. Same contract: epsilon-gated, compositor-only,
 * never a layout.
 */
class VFillSlot {
  private last = Number.NaN;

  constructor(
    private readonly target: HTMLElement,
    private readonly epsilon = 0.006,
  ) {}

  set(value: number): boolean {
    if (Math.abs(value - this.last) < this.epsilon) return false;
    this.last = value;
    this.target.style.transform = `scaleY(${clamp01(value).toFixed(4)})`;
    return true;
  }
}

/* -------------------------------------------------------------- preferences */

export type TouchMode = 'auto' | 'on' | 'off';
export type TouchHand = 'right' | 'left';

/**
 * How the player steers. All three are implemented; `stick` is the default,
 * and here is the reasoning behind that, because it is not obvious:
 *
 * - **`stick`** — a *floating* thumbstick. The base spawns wherever the thumb
 *   lands and slides to follow it, so it can never run out of throw and the
 *   player never has to look down to find it. Continuous, symmetrical, and it
 *   holds a constant steering angle through a long corner, which is what a
 *   drift-heavy game needs. This is what shipped as the default.
 * - **`wheel`** — rotating a visible wheel. Lovely to look at, and the most
 *   "driving-like", but a thumb pivoting from the corner of a phone traces an
 *   arc of maybe 60°, so full lock needs an awkward wrist roll and precise
 *   small corrections fight the arc. Kept as an option; it suits tablets, where
 *   the hand is bigger relative to the control.
 * - **`zones`** — two big arrows with the keyboard's ramp curve. Least
 *   expressive, but the largest targets and zero learning cost, so it is the
 *   accessible fallback and the one that survives gloves, small hands and
 *   playing one-handed on a bus.
 */
export type SteerScheme = 'stick' | 'wheel' | 'zones';

export interface TouchPrefs {
  mode: TouchMode;
  /** `right` = steering under the left thumb, pedals under the right. */
  hand: TouchHand;
  scheme: SteerScheme;
  /** control size multiplier, 0.8–1.4 */
  scale: number;
  /** resting opacity, 0.3–1 */
  opacity: number;
  haptics: boolean;
  /** user drag offsets in px, from each cluster's anchored corner */
  steerDx: number;
  steerDy: number;
  padDx: number;
  padDy: number;
}

export const DEFAULT_TOUCH_PREFS: TouchPrefs = {
  mode: 'auto',
  hand: 'right',
  scheme: 'stick',
  scale: 1,
  opacity: 0.82,
  haptics: true,
  steerDx: 0,
  steerDy: 0,
  padDx: 0,
  padDy: 0,
};

const PREFS_KEY = 'locolift.touch.v1';

const SCHEME_LABELS: Record<SteerScheme, { es: string; en: string }> = {
  stick: { es: 'PALANCA', en: 'Stick' },
  wheel: { es: 'VOLANTE', en: 'Wheel' },
  zones: { es: 'FLECHAS', en: 'Arrows' },
};

/* ------------------------------------------------------------------ tuning */

/**
 * Feel constants. These are the numbers that decide whether the game is
 * pleasant on glass, so they are named and grouped rather than inlined.
 */
const FEEL = {
  /** ignore the first 9 % of stick travel — a thumb never rests dead centre */
  deadzone: 0.09,
  /** >0 softens the centre; 0.34 keeps small corrections fine and full lock reachable */
  expo: 0.34,
  /** low-pass on the raw finger position (per second, exponential) */
  fingerSmoothing: 26,
  /** max steer units per second while a finger is down */
  slewTo: 11,
  /** …and after it lifts. Faster: the car should straighten the moment you let go. */
  slewReturn: 14,
  /** stick travel, px at scale 1, before the base starts sliding with the thumb */
  travel: 52,
  /** wheel scheme: radians of hand rotation for full lock */
  wheelSweep: 0.92,
  /** arrows scheme: steer units per second, held and released */
  arrowsTo: 3.4,
  arrowsReturn: 6.4,
  /** throttle/brake attack, units per second (instant feels notchy at 60 Hz) */
  pedalAttack: 14,
  pedalRelease: 22,
} as const;

/** Layout sizes in px at scale 1. The whole cluster derives from these. */
const SIZE = {
  gas: 104,
  brake: 80,
  boost: 84,
  drift: 78,
  small: 54,
  gap: 10,
  util: 48,
  stick: 136,
  knob: 66,
  wheel: 232,
  arrow: 92,
  arrowH: 84,
} as const;

/** Haptic patterns, ms. Short — a phone motor at 30 ms already feels cheap. */
const HAPTIC: Record<HapticKind, number | number[]> = {
  tap: 9,
  heavy: 16,
  drift: [0, 12, 24, 10],
  impact: 22,
  reward: [0, 8, 40, 8],
};

export type HapticKind = 'tap' | 'heavy' | 'drift' | 'impact' | 'reward';

/* --------------------------------------------------------------- internals */

type Role =
  | 'steer'
  | 'arrowLeft'
  | 'arrowRight'
  | 'gas'
  | 'brake'
  | 'drift'
  | 'boost'
  | 'horn'
  | 'flip';

/** A cached, pointer-testable rectangle. Refreshed only on layout changes. */
interface HitRect {
  role: Role;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** circular controls hit-test by radius, which matches how they look */
  round: boolean;
  cx: number;
  cy: number;
  r: number;
}

interface Held {
  role: Role;
  /** live pointer position */
  x: number;
  y: number;
  /** stick: floating origin. wheel: grab angle + steer at grab. */
  ox: number;
  oy: number;
  a0: number;
  s0: number;
}

/** Touch slop: fingers land a few px off what the eye aimed at. */
const SLOP = 6;

/**
 * Smallest edge any control may have, in CSS px. Apple's HIG says 44, WCAG
 * 2.5.5 says 44 — the two rarely agree, so when they do it is worth honouring
 * even on the smallest phone the fit factor can produce.
 */
const TARGET_MIN = 46;

/* ------------------------------------------------------------- test surface */

/**
 * What `tools/mobile-test.mjs` drives. Mirrors `window.__loco`: a small, stable
 * surface so QA presses the control the player would press, at the coordinates
 * it actually occupies, instead of guessing pixels.
 */
export interface TouchTestHook {
  /** true when the overlay is live on this device */
  enabled: boolean;
  /** would auto-detection have enabled it, ignoring `?touch=` and the setting? */
  autoDetected: boolean;
  /** the shared channel — read to assert what a press produced */
  channel: TouchInputChannel;
  prefs(): TouchPrefs;
  setPrefs(patch: Partial<TouchPrefs>): void;
  /** live viewport rectangles for every control, keyed by role */
  rects(): Array<{ role: string; x: number; y: number; w: number; h: number }>;
  /** portrait gate visibility */
  rotatePromptVisible(): boolean;
  /** frames integrated and layout passes taken — proves the loop is live */
  counters(): { frames: number; layouts: number; pointers: number };
}

declare global {
  interface Window {
    __locoTouch?: TouchTestHook;
  }
}

/* -------------------------------------------------------------------- class */

export interface TouchControlsOptions {
  theme: UITheme;
  /** defaults to the shared channel every `Input` reads */
  channel?: TouchInputChannel;
  /** called when the player asks for the game to pause */
  onPause?: () => void;
}

export class TouchControls {
  readonly el: HTMLElement;

  private readonly theme: UITheme;
  private readonly channel: TouchInputChannel;
  private prefs: TouchPrefs;

  /* layers */
  private readonly steerZone: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly wheel: HTMLElement;
  private readonly arrows: HTMLElement;
  private readonly pad: HTMLElement;
  private readonly util: HTMLElement;
  private readonly gate: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly buttons = new Map<Role, HTMLElement>();
  private readonly pressFlags = new Map<Role, FlagSlot>();
  private boostFill: VFillSlot | null = null;
  private boostReady: FlagSlot | null = null;
  private boostLive: FlagSlot | null = null;
  private stickLive: FlagSlot;

  /* state */
  private mounted = false;
  private playing = false;
  private enabled = false;
  private portrait = false;
  private gateDismissed = false;
  private panelOpen = false;
  private editing = false;
  private editDrag: { which: 'steer' | 'pad'; id: number; x: number; y: number } | null = null;

  private readonly held = new Map<number, Held>();
  private rects: HitRect[] = [];
  private layoutDirty = true;
  /** QA counters — cheap, and the fastest way to see a dead control loop */
  private frameCount = 0;
  private layoutCount = 0;
  private pointerCount = 0;

  /* driving values */
  private steer = 0;
  private steerRaw = 0;
  private throttle = 0;
  private brake = 0;
  /** `-1e9` = never written, so the first paint always lands */
  private lastKnobX = -1e9;
  private lastKnobY = -1e9;
  private lastBaseX = -1e9;
  private lastBaseY = -1e9;
  private lastWheelDeg = -1e9;
  private lastDriftOn = false;

  private viewW = 0;
  private viewH = 0;
  private scale = 1;

  private readonly disposers: Array<() => void> = [];
  private refreshPanel: (() => void) | null = null;
  private readonly onPause: (() => void) | null;

  constructor(opts: TouchControlsOptions) {
    this.theme = opts.theme;
    this.channel = opts.channel ?? touchChannel;
    this.onPause = opts.onPause ?? null;
    this.prefs = loadPrefs();

    const root = el('div', 'll-touch');
    root.dataset.hand = this.prefs.hand;
    root.dataset.scheme = this.prefs.scheme;
    root.hidden = true;
    this.el = root;

    /* ---------------------------------------------------------- steering */
    this.steerZone = el('div', 'll-touch__steer');
    this.steerZone.setAttribute('role', 'img');
    this.steerZone.setAttribute(
      'aria-label',
      'Zona de dirección — arrastra el pulgar para girar. Steering area.',
    );

    this.stick = el('div', 'll-tstick');
    const ring = el('div', 'll-tstick__ring');
    ring.append(buildStickRing());
    this.knob = el('div', 'll-tstick__knob');
    this.knob.append(buildKnobGlyph());
    this.stick.append(ring, this.knob);
    this.stickLive = new FlagSlot(this.stick, 'is-live');

    this.wheel = el('div', 'll-twheel');
    this.wheel.append(buildWheel());

    this.arrows = el('div', 'll-tarrows');
    const arrowL = this.makeButton('arrowLeft', 'll-tbtn ll-tbtn--arrow', 'Girar a la izquierda', {
      glyph: buildChevron(-1),
    });
    const arrowR = this.makeButton('arrowRight', 'll-tbtn ll-tbtn--arrow', 'Girar a la derecha', {
      glyph: buildChevron(1),
    });
    this.arrows.append(arrowL, arrowR);

    this.steerZone.append(this.stick, this.wheel, this.arrows);

    /* ------------------------------------------------------------ pedals */
    this.pad = el('div', 'll-touch__pad');
    const gas = this.makeButton('gas', 'll-tbtn ll-tbtn--gas', 'Acelerar', {
      es: 'GAS',
      glyph: buildPedalGlyph('gas'),
    });
    const brake = this.makeButton('brake', 'll-tbtn ll-tbtn--brake', 'Frenar y retroceder', {
      es: 'FRENO',
      glyph: buildPedalGlyph('brake'),
    });
    const drift = this.makeButton('drift', 'll-tbtn ll-tbtn--drift', 'Derrape — freno de mano', {
      es: 'DERRAPE',
      glyph: buildDriftGlyph(),
    });
    const boost = this.makeButton('boost', 'll-tbtn ll-tbtn--boost', 'Turbo', {
      es: 'TURBO',
      glyph: buildBoostGlyph(),
      fill: true,
    });
    const horn = this.makeButton('horn', 'll-tbtn ll-tbtn--small', 'Bocina', {
      glyph: buildHornGlyph(),
    });
    const flip = this.makeButton('flip', 'll-tbtn ll-tbtn--small', 'Voltear el carro', {
      glyph: buildFlipGlyph(),
    });
    this.pad.append(flip, horn, drift, brake, boost, gas);

    /* -------------------------------------------------------- utilities */
    this.util = el('div', 'll-touch__util');
    const pauseBtn = this.makeDiscrete('Pausa', buildPauseGlyph(), () => {
      this.haptic('tap');
      if (this.onPause) this.onPause();
      else this.channel.pausePressed = true;
    });
    /* Camera. The desktop cycle is a keyboard key (`V`) and a gamepad button,
     * neither of which a phone has, so without this the cockpit view — and the
     * cinematic and bumper views with it — are simply unreachable on the
     * device most people will play on. It writes the same `cameraPressed` edge
     * the key does, so the rig needs no idea where the press came from. */
    const cameraBtn = this.makeDiscrete('Cámara', buildCameraGlyph(), () => {
      this.haptic('tap');
      this.channel.cameraPressed = true;
    });
    const setupBtn = this.makeDiscrete('Ajustar controles', buildGearGlyph(), () => {
      this.haptic('tap');
      this.setPanelOpen(!this.panelOpen);
    });
    this.util.append(pauseBtn, cameraBtn, setupBtn);

    /* ------------------------------------------------------------ panel */
    this.panel = this.buildPanel();

    /* ------------------------------------------------- orientation gate */
    this.gate = this.buildGate();

    root.append(this.steerZone, this.pad, this.util, this.panel);
    this.applyPrefs(false);
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Mount both layers: the controls, and the rotate-your-phone gate. */
  mount(parent: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    parent.append(this.el, this.gate);
    this.bindGlobals();
    this.measureViewport();
    this.refreshEnabled();
    this.markLayoutDirty();
    this.installTestHook();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.releaseAll();
    this.el.remove();
    this.gate.remove();
  }

  /** True when the overlay is actually driving the game. */
  get active(): boolean {
    return this.enabled;
  }

  /** Current, sanitised preferences (a copy — mutate through `setPrefs`). */
  get preferences(): TouchPrefs {
    return { ...this.prefs };
  }

  setPrefs(patch: Partial<TouchPrefs>): void {
    this.prefs = sanitizePrefs({ ...this.prefs, ...patch });
    savePrefs(this.prefs);
    this.applyPrefs(true);
    this.refreshEnabled();
    this.refreshPanel?.();
    // Rebuild the hit map *now* rather than at the top of the next frame.
    // Switching scheme swaps which elements exist, so between the write and the
    // next `update()` the cached rectangles describe controls that are no
    // longer on screen — a tap on the new arrows would resolve to the old
    // stick's zone. At 60 Hz that window is 16 ms and invisible; on a phone
    // that has dropped to 5 fps while the setting is being changed it is a
    // fifth of a second of dead controls. One forced layout per settings
    // change is the same price `syncVisibility` already pays.
    if (this.mounted && !this.el.hidden) this.measure();
  }

  /** Show the driving controls (playing) or stow them (menus, results). */
  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) {
      this.releaseAll();
      this.setPanelOpen(false);
      this.setEditing(false);
    }
    this.syncVisibility();
    if (playing) this.markLayoutDirty();
  }

  /** Theme/accessibility settings the overlay honours. */
  applySettings(_s: SettingsState): void {
    // Motion and contrast come from the theme's root data attributes; the
    // only thing to re-derive is the layout, since uiScale may have moved.
    this.markLayoutDirty();
  }

  /** Boost meter, mirrored into the ring around the TURBO button. */
  setBoost(fraction: number, active: boolean): void {
    this.boostFill?.set(clamp01(fraction));
    // the "full" glow pulses, so it is gated on photosensitiveSafe / reduced motion
    this.boostReady?.set(fraction > 0.995 && !this.theme.flashSafe);
    this.boostLive?.set(active);
  }

  /** Drift state, for a one-shot buzz when the back end lets go. */
  setDrifting(on: boolean): void {
    if (on && !this.lastDriftOn) this.haptic('drift');
    this.lastDriftOn = on;
  }

  /**
   * Per-frame integration. Call from `lateUpdate` with the *raw* delta so the
   * stick keeps centring smoothly while the sim is paused.
   */
  update(dt: number): void {
    if (!this.enabled) return;
    this.frameCount++;
    if (this.layoutDirty) this.measure();

    const step = clamp(dt, 0, 0.05);
    // Portrait blocks driving only while the rotate prompt is actually up: a
    // player who chose "play anyway" on a tablet gets working controls.
    const blocked =
      (this.portrait && !this.gateDismissed) || this.panelOpen || this.editing || !this.playing;

    /* ---- steering ---- */
    let target = 0;
    let touching = false;
    if (!blocked) {
      switch (this.prefs.scheme) {
        case 'stick':
          [target, touching] = this.stickTarget(step);
          break;
        case 'wheel':
          [target, touching] = this.wheelTarget();
          break;
        case 'zones':
        default:
          [target, touching] = this.arrowTarget();
          break;
      }
    }

    if (this.prefs.scheme === 'zones') {
      const rate = touching ? FEEL.arrowsTo : FEEL.arrowsReturn;
      this.steer = moveTowards(this.steer, target, rate * step);
    } else {
      const rate = touching ? FEEL.slewTo : FEEL.slewReturn;
      this.steer = moveTowards(this.steer, target, rate * step);
    }
    if (Math.abs(this.steer) < 0.002) this.steer = 0;

    /* ---- pedals ---- */
    const gasDown = !blocked && this.isHeld('gas');
    const brakeDown = !blocked && this.isHeld('brake');
    this.throttle = moveTowards(
      this.throttle,
      gasDown ? 1 : 0,
      (gasDown ? FEEL.pedalAttack : FEEL.pedalRelease) * step,
    );
    this.brake = moveTowards(
      this.brake,
      brakeDown ? 1 : 0,
      (brakeDown ? FEEL.pedalAttack : FEEL.pedalRelease) * step,
    );

    /* ---- publish ---- */
    const c = this.channel;
    c.active = true;
    c.steer = clamp(this.steer, -1, 1);
    c.throttle = clamp01(this.throttle);
    c.brake = clamp01(this.brake);
    c.handbrake = !blocked && this.isHeld('drift') ? 1 : 0;
    c.boost = !blocked && this.isHeld('boost');
    c.horn = !blocked && this.isHeld('horn');

    this.paint();
  }

  dispose(): void {
    this.releaseAll();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.channel.active = false;
    resetTouchChannel();
    if (typeof window !== 'undefined') delete window.__locoTouch;
    this.unmount();
  }

  /* -------------------------------------------------------------- steering */

  /**
   * Floating thumbstick. The base spawns under the finger and then *follows*
   * it once travel is exhausted, so the stick can never run out of throw —
   * the single biggest reason on-screen sticks feel like they stick.
   */
  private stickTarget(dt: number): [number, boolean] {
    const h = this.firstHeld('steer');
    if (!h) return [0, false];

    const travel = FEEL.travel * this.scale;
    let dx = h.x - h.ox;
    if (dx > travel) {
      h.ox = h.x - travel;
      dx = travel;
    } else if (dx < -travel) {
      h.ox = h.x + travel;
      dx = -travel;
    }
    // vertical drift of the thumb drags the base along, so the axis stays
    // under the finger through a long corner
    const dy = h.y - h.oy;
    if (Math.abs(dy) > travel) h.oy = h.y - Math.sign(dy) * travel;

    const raw = clamp(dx / travel, -1, 1);
    const k = 1 - Math.exp(-FEEL.fingerSmoothing * dt);
    this.steerRaw += (raw - this.steerRaw) * k;
    return [expoCurve(deadzone(this.steerRaw, FEEL.deadzone), FEEL.expo), true];
  }

  /** Wheel: relative rotation from wherever the hand grabbed it. */
  private wheelTarget(): [number, boolean] {
    const h = this.firstHeld('steer');
    if (!h) return [0, false];
    const a = Math.atan2(h.y - h.oy, h.x - h.ox);
    const delta = wrapAngle(a - h.a0);
    return [clamp(h.s0 + delta / FEEL.wheelSweep, -1, 1), true];
  }

  /** Arrows: digital in, analogue out — the keyboard ramp with fat targets. */
  private arrowTarget(): [number, boolean] {
    const left = this.isHeld('arrowLeft');
    const right = this.isHeld('arrowRight');
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    return [dir, dir !== 0];
  }

  /* ---------------------------------------------------------------- paint */

  /** The only per-frame DOM writes in the module. All compositor-safe. */
  private paint(): void {
    const scheme = this.prefs.scheme;

    if (scheme === 'stick') {
      const h = this.firstHeld('steer');
      const travel = FEEL.travel * this.scale;
      const baseX = h ? h.ox - this.zoneX : this.homeX;
      const baseY = h ? h.oy - this.zoneY : this.homeY;
      if (Math.abs(baseX - this.lastBaseX) > 0.4 || Math.abs(baseY - this.lastBaseY) > 0.4) {
        this.lastBaseX = baseX;
        this.lastBaseY = baseY;
        this.stick.style.transform = this.stickTransform(baseX, baseY);
      }
      const kx = this.steer * travel;
      const ky = h ? clamp(h.y - h.oy, -travel, travel) : 0;
      if (Math.abs(kx - this.lastKnobX) > 0.4 || Math.abs(ky - this.lastKnobY) > 0.4) {
        this.lastKnobX = kx;
        this.lastKnobY = ky;
        this.knob.style.transform = `translate3d(${kx.toFixed(1)}px, ${ky.toFixed(1)}px, 0)`;
      }
      this.stickLive.set(!!h);
    } else if (scheme === 'wheel') {
      const deg = this.steer * 46;
      if (Math.abs(deg - this.lastWheelDeg) > 0.25) {
        this.lastWheelDeg = deg;
        this.wheel.style.transform = `rotate(${deg.toFixed(2)}deg)`;
      }
      this.stickLive.set(this.held.size > 0);
    }
  }

  /** Zone-space centre → a transform, given the stick is CSS-centred. */
  private stickTransform(x: number, y: number): string {
    const dx = x - this.zoneW / 2;
    const dy = y - this.zoneH / 2;
    return `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
  }

  /* --------------------------------------------------------------- layout */

  private zoneX = 0;
  private zoneY = 0;
  private zoneW = 1;
  private zoneH = 1;
  private homeX = 0;
  private homeY = 0;

  private markLayoutDirty(): void {
    this.layoutDirty = true;
  }

  private measureViewport(): void {
    this.viewW = window.innerWidth || 1;
    this.viewH = window.innerHeight || 1;
    this.portrait = this.viewH > this.viewW * 1.04;
  }

  /**
   * Recompute the scale, write the size custom properties, then cache every
   * hit rectangle. Custom properties are written *here only* — never per frame.
   */
  private measure(): void {
    this.layoutDirty = false;
    if (!this.mounted || this.el.hidden) return;
    this.layoutCount++;

    this.measureViewport();
    // Shrink with the viewport so a 320-tall phone in landscape still has room
    // for the HUD above the controls.
    const fit = clamp(Math.min(this.viewW / 760, this.viewH / 400), 0.68, 1.12);
    this.scale = clamp(this.prefs.scale * fit, 0.55, 1.7);

    const s = this.el.style;
    s.setProperty('--tc-scale', this.scale.toFixed(3));
    s.setProperty('--tc-gas', px(SIZE.gas * this.scale));
    s.setProperty('--tc-brake', px(SIZE.brake * this.scale));
    s.setProperty('--tc-boost', px(SIZE.boost * this.scale));
    s.setProperty('--tc-drift', px(SIZE.drift * this.scale));
    // The two small clusters are the only ones that fall through the 44 px
    // floor when the fit factor bottoms out: on a 568×320 phone `small` came
    // out at 40 px and `util` at 36 px. Everything else is comfortably above
    // it, so the floor is applied here rather than to every size.
    const smallPx = Math.max(TARGET_MIN, SIZE.small * this.scale);
    const utilPx = Math.max(TARGET_MIN, SIZE.util * this.scale);
    s.setProperty('--tc-small', px(smallPx));
    s.setProperty('--tc-gap', px(SIZE.gap * this.scale));
    s.setProperty('--tc-util', px(utilPx));
    s.setProperty('--tc-stick', px(SIZE.stick * this.scale));
    s.setProperty('--tc-knob', px(SIZE.knob * this.scale));
    s.setProperty('--tc-arrow-w', px(SIZE.arrow * this.scale));
    s.setProperty('--tc-arrow-h', px(SIZE.arrowH * this.scale));
    s.setProperty('--tc-alpha', this.prefs.opacity.toFixed(2));
    s.setProperty('--tc-steer-dx', px(this.prefs.steerDx));
    s.setProperty('--tc-steer-dy', px(this.prefs.steerDy));
    s.setProperty('--tc-pad-dx', px(this.prefs.padDx));
    s.setProperty('--tc-pad-dy', px(this.prefs.padDy));

    // The wheel is the one control whose *nominal* size can exceed the space it
    // is given: 232 px at scale 1 against a 430 px-tall landscape phone, minus
    // safe areas, minus the HUD above it. Left alone it hung 89 px off the
    // bottom of a 15 Pro Max. Derive it from the steering zone's real height
    // instead, so it is always a whole, fully-tappable circle.
    const zoneH = Math.min(this.viewH * 0.56, SIZE.stick * this.scale * 1.75);
    s.setProperty('--tc-wheel', px(clamp(SIZE.wheel * this.scale, 120, zoneH)));

    /* ------------------------------------------------------ HUD clearance */
    // The HUD lays out in the same four corners the controls occupy. Publish
    // exactly how much of each corner is taken so the stylesheet can move HUD
    // chips out of the way rather than guessing at a media query. Written once
    // per layout change, on the host — never per frame.
    const host = this.el.parentElement;
    if (host) {
      const hs = host.style;
      // Mirrors the pad's grid exactly — three columns, two rows, one gap
      // between each. `smallPx` rather than `SIZE.small * scale`, so the 44 px
      // floor is reflected in what the HUD is told to clear.
      const padW = smallPx + (SIZE.brake + SIZE.gas) * this.scale + SIZE.gap * this.scale * 2;
      const padH = (SIZE.boost + SIZE.gas) * this.scale + SIZE.gap * this.scale;
      const steerW = Math.min(this.viewW * 0.42, SIZE.stick * this.scale * 2.5);
      // A player who drags a cluster *outwards* shrinks its footprint; clamped
      // at zero so a negative offset can never make the HUD think it has more
      // room than the screen has.
      hs.setProperty('--ll-touch-pad-w', px(Math.max(0, padW + this.prefs.padDx)));
      hs.setProperty('--ll-touch-pad-h', px(Math.max(0, padH + this.prefs.padDy)));
      hs.setProperty('--ll-touch-steer-w', px(steerW + Math.max(0, this.prefs.steerDx)));
      hs.setProperty('--ll-touch-steer-h', px(zoneH + Math.max(0, this.prefs.steerDy)));
      hs.setProperty('--ll-touch-util-w', px(utilPx + 12));
      // three stacked buttons (pause, camera, setup); the HUD needs the height
      // in portrait, where there is no room beside the column and the fare has
      // to sit under it
      hs.setProperty('--ll-touch-util-h', px(utilPx * 3 + SIZE.gap * this.scale * 1.6));
    }

    /* ---- hit rectangles ---- */
    const rects: HitRect[] = [];
    const zone = this.steerZone.getBoundingClientRect();
    this.zoneX = zone.left;
    this.zoneY = zone.top;
    this.zoneW = Math.max(1, zone.width);
    this.zoneH = Math.max(1, zone.height);
    // Resting position: horizontally centred, a little low — where a thumb
    // pivoting from the bottom corner of the screen naturally lands.
    this.homeX = this.zoneW * 0.5;
    this.homeY = this.zoneH * 0.62;

    if (this.prefs.scheme === 'zones') {
      pushRect(rects, 'arrowLeft', this.buttons.get('arrowLeft'), false);
      pushRect(rects, 'arrowRight', this.buttons.get('arrowRight'), false);
    } else {
      rects.push({
        role: 'steer',
        x0: zone.left,
        y0: zone.top,
        x1: zone.right,
        y1: zone.bottom,
        round: false,
        cx: zone.left + zone.width / 2,
        cy: zone.top + zone.height / 2,
        r: 0,
      });
    }
    for (const role of ['gas', 'brake', 'drift', 'boost', 'horn', 'flip'] as Role[]) {
      pushRect(rects, role, this.buttons.get(role), true);
    }
    // Buttons first: a pedal that overlaps the steering zone must win.
    rects.sort((a, b) => (a.role === 'steer' ? 1 : 0) - (b.role === 'steer' ? 1 : 0));
    this.rects = rects;

    if (this.prefs.scheme === 'stick' && this.held.size === 0) {
      this.lastBaseX = this.homeX;
      this.lastBaseY = this.homeY;
      this.stick.style.transform = this.stickTransform(this.homeX, this.homeY);
    }
    this.lastKnobX = -1e9;
    this.lastKnobY = -1e9;
    this.lastWheelDeg = -1e9;
  }

  /* ------------------------------------------------------------- pointers */

  private bindGlobals(): void {
    const layer = this.el;

    const onDown = (e: PointerEvent): void => this.handleDown(e);
    const onMove = (e: PointerEvent): void => this.handleMove(e);
    const onUp = (e: PointerEvent): void => this.handleUp(e);
    const onCancel = (e: PointerEvent): void => this.handleUp(e);
    const onContext = (e: Event): void => {
      if (this.enabled) e.preventDefault();
    };
    // iOS Safari ignores user-scalable=no; these are the only way to stop a
    // two-finger pinch turning the game into a zoomed-in mess.
    const onGesture = (e: Event): void => {
      if (this.enabled) e.preventDefault();
    };
    const onResize = (): void => {
      this.measureViewport();
      // A rotation moves every control; re-measure immediately rather than
      // leaving a frame's worth of stale rectangles for a thumb to miss.
      if (!this.el.hidden) this.measure();
      else this.markLayoutDirty();
      this.syncGate();
    };
    const onBlur = (): void => this.releaseAll();
    const onVisibility = (): void => {
      if (document.hidden) this.releaseAll();
    };
    const onFirstTouch = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return;
      window.removeEventListener('pointerdown', onFirstTouch, true);
      if (this.prefs.mode === 'auto' && !this.enabled) {
        this.refreshEnabled(true);
      }
    };

    layer.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    layer.addEventListener('contextmenu', onContext);
    document.addEventListener('gesturestart', onGesture, { passive: false });
    document.addEventListener('gesturechange', onGesture, { passive: false });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointerdown', onFirstTouch, true);

    const mq =
      typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait)') : null;
    const onOrient = (): void => {
      this.gateDismissed = false;
      this.measureViewport();
      this.markLayoutDirty();
      this.syncGate();
    };
    mq?.addEventListener('change', onOrient);

    this.disposers.push(
      () => layer.removeEventListener('pointerdown', onDown),
      () => window.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onCancel),
      () => layer.removeEventListener('contextmenu', onContext),
      () => document.removeEventListener('gesturestart', onGesture),
      () => document.removeEventListener('gesturechange', onGesture),
      () => window.removeEventListener('resize', onResize),
      () => window.removeEventListener('orientationchange', onResize),
      () => window.removeEventListener('blur', onBlur),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => window.removeEventListener('pointerdown', onFirstTouch, true),
      () => mq?.removeEventListener('change', onOrient),
    );
  }

  private handleDown(e: PointerEvent): void {
    if (!this.enabled) return;
    if (this.editing) {
      this.startEditDrag(e);
      return;
    }
    if (this.panelOpen || (this.portrait && !this.gateDismissed)) return;
    // Anything inside a real widget (panel, utility buttons) handles itself.
    if ((e.target as HTMLElement | null)?.closest('[data-tc-widget]')) return;

    const role = this.hitTest(e.clientX, e.clientY);
    if (!role) return;
    e.preventDefault();

    if (role === 'flip') {
      this.channel.resetPressed = true;
      this.flash('flip');
      this.haptic('heavy');
      return;
    }

    const held: Held = { role, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, a0: 0, s0: 0 };
    if (role === 'steer' && this.prefs.scheme === 'wheel') {
      const c = this.wheelCentre();
      held.ox = c.x;
      held.oy = c.y;
      held.a0 = Math.atan2(e.clientY - c.y, e.clientX - c.x);
      held.s0 = this.steer;
    }
    if (role === 'steer' && this.prefs.scheme === 'stick') {
      this.steerRaw = 0;
    }
    this.held.set(e.pointerId, held);
    this.pointerCount++;
    this.setPressed(role, true);
    this.haptic(role === 'boost' || role === 'drift' ? 'heavy' : 'tap');
  }

  private handleMove(e: PointerEvent): void {
    if (this.editDrag && e.pointerId === this.editDrag.id) {
      this.moveEditDrag(e);
      return;
    }
    const h = this.held.get(e.pointerId);
    if (!h) return;
    e.preventDefault();
    h.x = e.clientX;
    h.y = e.clientY;

    // Sliding off a pedal onto its neighbour re-targets, the way a real thumb
    // expects. Steering never re-targets: the stick owns the finger.
    if (h.role !== 'steer') {
      const next = this.hitTest(e.clientX, e.clientY);
      if (next && next !== h.role && next !== 'steer') {
        this.setPressed(h.role, false);
        h.role = next;
        this.setPressed(next, true);
        this.haptic('tap');
      }
    }
  }

  private handleUp(e: PointerEvent): void {
    if (this.editDrag && e.pointerId === this.editDrag.id) {
      this.endEditDrag();
      return;
    }
    const h = this.held.get(e.pointerId);
    if (!h) return;
    this.held.delete(e.pointerId);
    this.setPressed(h.role, false);
  }

  private hitTest(x: number, y: number): Role | null {
    for (const r of this.rects) {
      if (r.round) {
        const dx = x - r.cx;
        const dy = y - r.cy;
        if (dx * dx + dy * dy <= r.r * r.r) return r.role;
      } else if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
        return r.role;
      }
    }
    return null;
  }

  private wheelCentre(): { x: number; y: number } {
    const b = this.wheel.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }

  private isHeld(role: Role): boolean {
    for (const h of this.held.values()) if (h.role === role) return true;
    return false;
  }

  private firstHeld(role: Role): Held | null {
    for (const h of this.held.values()) if (h.role === role) return h;
    return null;
  }

  private setPressed(role: Role, on: boolean): void {
    this.pressFlags.get(role)?.set(on);
  }

  private releaseAll(): void {
    for (const h of this.held.values()) this.setPressed(h.role, false);
    this.held.clear();
    this.editDrag = null;
    this.steer = 0;
    this.steerRaw = 0;
    this.throttle = 0;
    this.brake = 0;
    resetTouchChannel();
    this.channel.active = this.enabled;
  }

  /** A one-shot visual acknowledgement for buttons with no held state. */
  private flash(role: Role): void {
    const node = this.buttons.get(role);
    if (!node) return;
    node.classList.add('is-down');
    window.setTimeout(() => node.classList.remove('is-down'), 130);
  }

  /* ------------------------------------------------------------- haptics */

  /**
   * Whether this browser can buzz at all.
   *
   * `navigator.vibrate` is Android-only — iOS Safari has never shipped it and
   * has no equivalent from a web page. The settings row says so rather than
   * offering a switch that silently does nothing.
   */
  static canVibrate(): boolean {
    if (typeof navigator === 'undefined') return false;
    return typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === 'function';
  }

  /** Buzz, if the device can and the player wants it. */
  haptic(kind: HapticKind): void {
    if (!this.prefs.haptics || !this.enabled) return;
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (typeof nav.vibrate !== 'function') return;
    try {
      nav.vibrate(HAPTIC[kind]);
    } catch {
      /* iOS has no vibrate; locked-down contexts throw */
    }
  }

  /* ----------------------------------------------------------- visibility */

  /** Decide whether the overlay should exist on this device at all. */
  private refreshEnabled(force = false): void {
    const next = force || shouldEnable(this.prefs.mode);
    if (next === this.enabled && !force) {
      this.syncVisibility();
      return;
    }
    this.enabled = next;
    this.channel.active = next;
    if (!next) resetTouchChannel();
    this.syncVisibility();
  }

  private syncVisibility(): void {
    const show = this.enabled && this.playing;
    if (this.el.hidden !== !show) {
      this.el.hidden = !show;
      // Measure *now*, not on the next frame. A hidden element has no
      // rectangles, so the geometry the pointer code needs cannot exist until
      // this moment — and waiting a frame for it means the first tap after the
      // countdown lands on nothing. One forced layout per state change is a
      // fair price; this is not the per-frame path.
      if (show) this.measure();
    }
    const host = this.el.parentElement;
    if (host) {
      // `data-touch` is what the stylesheet keys the phone HUD off, and
      // `data-touch-hand` tells it which bottom corner the pedals took.
      if (this.enabled) {
        host.dataset.touch = '1';
        host.dataset.touchHand = this.prefs.hand;
      } else {
        delete host.dataset.touch;
        delete host.dataset.touchHand;
      }
    }
    if (!show) {
      this.releaseAll();
      this.channel.active = this.enabled;
    }
    this.syncGate();
  }

  /* ------------------------------------------------- rotate-device gate */

  private buildGate(): HTMLElement {
    const gate = el('div', 'll-rotate');
    gate.hidden = true;
    gate.setAttribute('role', 'alertdialog');
    gate.setAttribute('aria-label', 'Gira el teléfono');

    const card = el('div', 'll-panel ll-rotate__card');
    const art = el('div', 'll-rotate__art');
    art.append(buildRotateGlyph());
    const es = el('div', 'll-rotate__es', 'GIRA EL TELÉFONO');
    const en = el('div', 'll-rotate__en', 'Turn your device sideways to drive');
    const row = el('div', 'll-rotate__row');

    const anyway = el('button', 'll-btn ll-btn--primary', '');
    anyway.type = 'button';
    anyway.dataset.tcWidget = '1';
    anyway.append(el('span', 'll-btn__es', 'JUGAR ASÍ'), el('span', 'll-btn__en', 'Play anyway'));
    anyway.addEventListener('click', () => {
      this.gateDismissed = true;
      this.syncGate();
    });

    const full = el('button', 'll-btn', '');
    full.type = 'button';
    full.dataset.tcWidget = '1';
    full.append(
      el('span', 'll-btn__es', 'PANTALLA COMPLETA'),
      el('span', 'll-btn__en', 'Fullscreen'),
    );
    full.addEventListener('click', () => {
      void requestLandscapeFullscreen();
    });

    row.append(anyway, full);
    card.append(art, es, en, row);
    gate.append(card);
    return gate;
  }

  private syncGate(): void {
    const show = this.enabled && this.portrait && !this.gateDismissed;
    if (this.gate.hidden === !show) return;
    this.gate.hidden = !show;
    if (show) this.releaseAll();
  }

  /* ---------------------------------------------------------- setup panel */

  private setPanelOpen(open: boolean): void {
    if (open === this.panelOpen) return;
    this.panelOpen = open;
    this.panel.hidden = !open;
    this.el.classList.toggle('is-configuring', open);
    if (open) {
      this.releaseAll();
      this.refreshPanel?.();
      const first = this.panel.querySelector<HTMLElement>('button, input');
      first?.focus();
    } else {
      this.setEditing(false);
    }
  }

  private setEditing(on: boolean): void {
    if (on === this.editing) return;
    this.editing = on;
    this.el.classList.toggle('is-editing', on);
    this.panel.classList.toggle('is-editing', on);
    if (on) this.releaseAll();
    this.refreshPanel?.();
  }

  private startEditDrag(e: PointerEvent): void {
    const inPad = withinRect(e.clientX, e.clientY, this.pad.getBoundingClientRect(), 24);
    const inSteer = withinRect(e.clientX, e.clientY, this.steerZone.getBoundingClientRect(), 0);
    if (!inPad && !inSteer) return;
    if ((e.target as HTMLElement | null)?.closest('[data-tc-widget]')) return;
    e.preventDefault();
    this.editDrag = {
      which: inPad ? 'pad' : 'steer',
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
    };
  }

  private moveEditDrag(e: PointerEvent): void {
    const d = this.editDrag;
    if (!d) return;
    e.preventDefault();
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    const lim = Math.min(this.viewW, this.viewH) * 0.42;
    if (d.which === 'pad') {
      this.prefs.padDx = clamp(this.prefs.padDx - dx, -lim, lim);
      this.prefs.padDy = clamp(this.prefs.padDy - dy, -lim, lim);
    } else {
      this.prefs.steerDx = clamp(this.prefs.steerDx + dx, -lim, lim);
      this.prefs.steerDy = clamp(this.prefs.steerDy - dy, -lim, lim);
    }
    const s = this.el.style;
    s.setProperty('--tc-steer-dx', px(this.prefs.steerDx));
    s.setProperty('--tc-steer-dy', px(this.prefs.steerDy));
    s.setProperty('--tc-pad-dx', px(this.prefs.padDx));
    s.setProperty('--tc-pad-dy', px(this.prefs.padDy));
    this.markLayoutDirty();
  }

  private endEditDrag(): void {
    this.editDrag = null;
    savePrefs(this.prefs);
    this.markLayoutDirty();
  }

  private buildPanel(): HTMLElement {
    const panel = el('div', 'll-tcfg');
    panel.hidden = true;
    panel.dataset.tcWidget = '1';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ajustes de controles táctiles');

    const card = el('div', 'll-panel ll-tcfg__card');
    const head = el('div', 'll-tcfg__head');
    const titles = el('div', 'll-tcfg__titles');
    titles.append(
      el('h2', 'll-tcfg__title', 'CONTROLES'),
      el('div', 'll-tcfg__sub', 'Touch controls'),
    );
    const close = el('button', 'll-btn', '');
    close.type = 'button';
    close.dataset.tcWidget = '1';
    close.setAttribute('aria-label', 'Cerrar');
    close.append(el('span', 'll-btn__es', 'LISTO'), el('span', 'll-btn__en', 'Done'));
    close.addEventListener('click', () => this.setPanelOpen(false));
    head.append(titles, close);

    const body = el('div', 'll-tcfg__body');
    const refreshers: Array<() => void> = [];

    body.append(
      this.segRow(
        refreshers,
        'MANO',
        'Handedness',
        'Dónde va la dirección.',
        [
          { value: 'right', label: 'DIESTRO' },
          { value: 'left', label: 'ZURDO' },
        ],
        () => this.prefs.hand,
        (v) => this.setPrefs({ hand: v as TouchHand }),
      ),
      this.segRow(
        refreshers,
        'DIRECCIÓN',
        'Steering',
        'Palanca flotante, volante o flechas.',
        (['stick', 'wheel', 'zones'] as SteerScheme[]).map((v) => ({
          value: v,
          label: SCHEME_LABELS[v].es,
        })),
        () => this.prefs.scheme,
        (v) => this.setPrefs({ scheme: v as SteerScheme }),
      ),
      this.sliderRow(
        refreshers,
        'TAMAÑO',
        'Size',
        'Escala de los botones.',
        0.8,
        1.4,
        0.05,
        () => this.prefs.scale,
        (v) => this.setPrefs({ scale: v }),
        (v) => `${Math.round(v * 100)}%`,
      ),
      this.sliderRow(
        refreshers,
        'OPACIDAD',
        'Opacity',
        'Cuánto tapan la ciudad.',
        0.3,
        1,
        0.05,
        () => this.prefs.opacity,
        (v) => this.setPrefs({ opacity: v }),
        (v) => `${Math.round(v * 100)}%`,
      ),
      this.switchRow(
        refreshers,
        'VIBRACIÓN',
        'Haptics',
        'Un toque corto al pulsar y al derrapar.',
        () => this.prefs.haptics,
        (v) => this.setPrefs({ haptics: v }),
      ),
    );

    /* --- move / reset ------------------------------------------------- */
    const actions = el('div', 'll-tcfg__actions');
    const moveBtn = el('button', 'll-btn', '');
    moveBtn.type = 'button';
    moveBtn.dataset.tcWidget = '1';
    const moveEs = el('span', 'll-btn__es', 'MOVER');
    moveBtn.append(moveEs, el('span', 'll-btn__en', 'Reposition'));
    moveBtn.addEventListener('click', () => this.setEditing(!this.editing));

    const resetBtn = el('button', 'll-btn ll-btn--danger', '');
    resetBtn.type = 'button';
    resetBtn.dataset.tcWidget = '1';
    resetBtn.append(el('span', 'll-btn__es', 'REINICIAR'), el('span', 'll-btn__en', 'Reset'));
    resetBtn.addEventListener('click', () => {
      this.setPrefs({ ...DEFAULT_TOUCH_PREFS, mode: this.prefs.mode });
      this.setEditing(false);
    });

    const fullBtn = el('button', 'll-btn', '');
    fullBtn.type = 'button';
    fullBtn.dataset.tcWidget = '1';
    fullBtn.append(
      el('span', 'll-btn__es', 'PANTALLA COMPLETA'),
      el('span', 'll-btn__en', 'Fullscreen'),
    );
    fullBtn.addEventListener('click', () => void requestLandscapeFullscreen());

    actions.append(moveBtn, fullBtn, resetBtn);

    const hint = el(
      'div',
      'll-tcfg__hint',
      'Con MOVER activo, arrastra cualquier grupo de botones a donde te quede cómodo.',
    );

    body.append(actions, hint);
    card.append(head, body);
    panel.append(card);

    this.refreshPanel = (): void => {
      moveEs.textContent = this.editing ? 'LISTO' : 'MOVER';
      moveBtn.setAttribute('aria-pressed', this.editing ? 'true' : 'false');
      for (const fn of refreshers) fn();
    };
    this.refreshPanel();
    return panel;
  }

  /* -------------------------------------------------------- panel widgets */

  private segRow(
    refreshers: Array<() => void>,
    es: string,
    en: string,
    hint: string,
    options: Array<{ value: string; label: string }>,
    read: () => string,
    write: (v: string) => void,
  ): HTMLElement {
    const row = configRow(es, en, hint);
    const group = el('div', 'll-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', en);
    group.dataset.segmented = '1';
    group.dataset.tcWidget = '1';
    const nodes: Array<{ node: HTMLElement; value: string }> = [];
    for (const opt of options) {
      const b = el('button', 'll-seg__opt', opt.label);
      (b as HTMLButtonElement).type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.tcWidget = '1';
      b.addEventListener('click', () => write(opt.value));
      group.append(b);
      nodes.push({ node: b, value: opt.value });
    }
    const control = el('div', 'll-control');
    control.append(group);
    row.append(control);
    refreshers.push(() => {
      const v = read();
      for (const n of nodes) n.node.setAttribute('aria-checked', n.value === v ? 'true' : 'false');
    });
    return row;
  }

  private sliderRow(
    refreshers: Array<() => void>,
    es: string,
    en: string,
    hint: string,
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (v: number) => void,
    format: (v: number) => string,
  ): HTMLElement {
    const row = configRow(es, en, hint);
    const control = el('div', 'll-control ll-control--slider');
    const input = el('input', 'll-slider') as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', en);
    input.dataset.tcWidget = '1';
    const out = el('output', 'll-readout', '');
    control.append(input, out);
    row.append(control);
    input.addEventListener('input', () => write(clamp(Number(input.value), min, max)));
    refreshers.push(() => {
      const v = clamp(read(), min, max);
      if (Number(input.value) !== v) input.value = String(v);
      control.style.setProperty('--t', ((v - min) / (max - min || 1)).toFixed(4));
      out.textContent = format(v);
    });
    return row;
  }

  private switchRow(
    refreshers: Array<() => void>,
    es: string,
    en: string,
    hint: string,
    read: () => boolean,
    write: (v: boolean) => void,
  ): HTMLElement {
    const row = configRow(es, en, hint);
    const control = el('div', 'll-control');
    const b = el('button', 'll-switch');
    (b as HTMLButtonElement).type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', en);
    b.dataset.tcWidget = '1';
    const track = el('span', 'll-switch__track');
    track.append(el('span', 'll-switch__knob'));
    const label = el('span', 'll-switch__label', 'OFF');
    b.append(track, label);
    control.append(b);
    row.append(control);
    b.addEventListener('click', () => write(b.getAttribute('aria-checked') !== 'true'));
    refreshers.push(() => {
      const on = read();
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      label.textContent = on ? 'ON' : 'OFF';
    });
    return row;
  }

  /* -------------------------------------------------------- DOM factories */

  private makeButton(
    role: Role,
    className: string,
    label: string,
    opts: { es?: string; glyph?: SVGElement; fill?: boolean } = {},
  ): HTMLElement {
    const b = el('button', className);
    (b as HTMLButtonElement).type = 'button';
    b.dataset.role = role;
    b.setAttribute('aria-label', label);
    // The control is driven by pointer events; the button element exists for
    // semantics, hit area and the focus ring.
    b.tabIndex = -1;

    if (opts.fill) {
      const fill = el('span', 'll-tbtn__fill');
      b.append(fill);
      this.boostFill = new VFillSlot(fill, 0.006);
      this.boostReady = new FlagSlot(b, 'is-ready');
      this.boostLive = new FlagSlot(b, 'is-live');
      fill.style.transform = 'scaleY(0)';
    }
    if (opts.glyph) {
      const g = el('span', 'll-tbtn__glyph');
      g.append(opts.glyph);
      b.append(g);
    }
    if (opts.es) b.append(el('span', 'll-tbtn__es', opts.es));

    this.buttons.set(role, b);
    this.pressFlags.set(role, new FlagSlot(b, 'is-down'));
    return b;
  }

  /** Utility buttons are ordinary clickable widgets, not held controls. */
  private makeDiscrete(label: string, glyph: SVGElement, run: () => void): HTMLElement {
    const b = el('button', 'll-tbtn ll-tbtn--util');
    (b as HTMLButtonElement).type = 'button';
    b.dataset.tcWidget = '1';
    b.setAttribute('aria-label', label);
    const g = el('span', 'll-tbtn__glyph');
    g.append(glyph);
    b.append(g);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.add('is-down');
      run();
    });
    const clear = (): void => b.classList.remove('is-down');
    b.addEventListener('pointerup', clear);
    b.addEventListener('pointercancel', clear);
    b.addEventListener('pointerleave', clear);
    // Keyboard parity: pointerdown never fires for Enter/Space.
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        run();
      }
    });
    return b;
  }

  /** Expose the QA surface. Cheap, and it makes the layout auditable. */
  private installTestHook(): void {
    if (typeof window === 'undefined') return;
    const self = this;
    window.__locoTouch = {
      get enabled(): boolean {
        return self.enabled;
      },
      get autoDetected(): boolean {
        return shouldEnable('auto');
      },
      channel: this.channel,
      prefs: () => self.preferences,
      setPrefs: (patch) => self.setPrefs(patch),
      rects: () => {
        const out: Array<{ role: string; x: number; y: number; w: number; h: number }> = [];
        const add = (role: string, node: HTMLElement | undefined): void => {
          if (!node) return;
          const b = node.getBoundingClientRect();
          if (b.width < 1 || b.height < 1) return;
          out.push({ role, x: b.left, y: b.top, w: b.width, h: b.height });
        };
        for (const [role, node] of self.buttons) add(role, node);
        add('steer', self.steerZone);
        // the visible stick/wheel, wherever the thumb has dragged it
        add(self.prefs.scheme === 'wheel' ? 'wheel' : 'stick', self.stick.offsetParent ? self.stick : self.wheel);
        add('util', self.util);
        for (const node of Array.from(
          self.util.querySelectorAll<HTMLElement>('.ll-tbtn--util'),
        )) {
          add(node.getAttribute('aria-label') ?? 'util-item', node);
        }
        return out;
      },
      rotatePromptVisible: () => !self.gate.hidden,
      counters: () => ({
        frames: self.frameCount,
        layouts: self.layoutCount,
        pointers: self.pointerCount,
      }),
    };
  }

  private applyPrefs(remeasure: boolean): void {
    this.el.dataset.hand = this.prefs.hand;
    this.el.dataset.scheme = this.prefs.scheme;
    this.el.style.setProperty('--tc-alpha', this.prefs.opacity.toFixed(2));
    const host = this.el.parentElement;
    if (host && this.enabled) host.dataset.touchHand = this.prefs.hand;
    if (remeasure) this.markLayoutDirty();
  }
}

/* ------------------------------------------------------------------ utils */

const px = (v: number): string => `${v.toFixed(2)}px`;

function withinRect(x: number, y: number, r: DOMRect, pad: number): boolean {
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function pushRect(out: HitRect[], role: Role, node: HTMLElement | undefined, round: boolean): void {
  if (!node) return;
  const b = node.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return;
  out.push({
    role,
    x0: b.left - SLOP,
    y0: b.top - SLOP,
    x1: b.right + SLOP,
    y1: b.bottom + SLOP,
    round,
    cx: b.left + b.width / 2,
    cy: b.top + b.height / 2,
    r: Math.max(b.width, b.height) / 2 + SLOP,
  });
}

/** `?touch=1` forces the overlay on for desktop testing; `?touch=0` kills it. */
function urlOverride(): boolean | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('touch');
  if (v === '1' || v === 'on' || v === 'true') return true;
  if (v === '0' || v === 'off' || v === 'false') return false;
  return null;
}

function shouldEnable(mode: TouchMode): boolean {
  const forced = urlOverride();
  if (forced !== null) return forced;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const points = navigator.maxTouchPoints ?? 0;
  return coarse && points > 0;
}

async function requestLandscapeFullscreen(): Promise<void> {
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  try {
    if (!document.fullscreenElement) {
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
    }
  } catch {
    /* denied — nothing to do, the game still plays windowed */
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    await orientation?.lock?.('landscape');
  } catch {
    /* iOS and desktop refuse; the rotate prompt covers that case */
  }
}

function configRow(es: string, en: string, hint: string): HTMLElement {
  const row = el('div', 'll-row');
  const text = el('div', 'll-row__text');
  const label = el('div', 'll-row__label');
  label.append(el('span', 'll-lbl-es', es), el('span', 'll-lbl-en', en));
  text.append(label, el('div', 'll-row__hint', hint));
  row.append(text);
  return row;
}

function loadPrefs(): TouchPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_TOUCH_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_TOUCH_PREFS };
    return sanitizePrefs({ ...DEFAULT_TOUCH_PREFS, ...(parsed as Partial<TouchPrefs>) });
  } catch {
    return { ...DEFAULT_TOUCH_PREFS };
  }
}

function savePrefs(p: TouchPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode / quota — preferences just won't persist */
  }
}

function sanitizePrefs(p: TouchPrefs): TouchPrefs {
  const modes: TouchMode[] = ['auto', 'on', 'off'];
  const schemes: SteerScheme[] = ['stick', 'wheel', 'zones'];
  const n = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    mode: modes.includes(p.mode) ? p.mode : 'auto',
    hand: p.hand === 'left' ? 'left' : 'right',
    scheme: schemes.includes(p.scheme) ? p.scheme : 'stick',
    scale: clamp(n(p.scale, 1), 0.8, 1.4),
    opacity: clamp(n(p.opacity, 0.82), 0.3, 1),
    haptics: p.haptics !== false,
    steerDx: clamp(n(p.steerDx, 0), -900, 900),
    steerDy: clamp(n(p.steerDy, 0), -900, 900),
    padDx: clamp(n(p.padDx, 0), -900, 900),
    padDy: clamp(n(p.padDy, 0), -900, 900),
  };
}

/* ------------------------------------------------------------------ icons */

const NS_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2.4',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

function iconRoot(size = 24): SVGSVGElement {
  const s = svg('svg', {
    viewBox: `0 0 ${size} ${size}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  return s;
}

function buildStickRing(): SVGSVGElement {
  const s = iconRoot(100);
  s.append(
    svg('circle', {
      cx: '50',
      cy: '50',
      r: '46',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      opacity: '0.55',
    }),
    svg('circle', {
      cx: '50',
      cy: '50',
      r: '46',
      fill: 'rgba(6,12,18,0.34)',
      stroke: 'none',
    }),
    svg('path', {
      d: 'M14 50h10M76 50h10',
      ...NS_STROKE,
      'stroke-width': '3',
      opacity: '0.7',
    }),
  );
  return s;
}

function buildKnobGlyph(): SVGSVGElement {
  const s = iconRoot(48);
  s.append(
    svg('circle', { cx: '24', cy: '24', r: '21', fill: 'rgba(255,246,232,0.14)' }),
    svg('path', {
      d: 'M15 24h18M15 24l4-4M15 24l4 4M33 24l-4-4M33 24l-4 4',
      ...NS_STROKE,
      'stroke-width': '2.6',
    }),
  );
  return s;
}

function buildWheel(): SVGSVGElement {
  const s = iconRoot(120);
  s.append(
    svg('circle', {
      cx: '60',
      cy: '60',
      r: '52',
      fill: 'rgba(6,12,18,0.4)',
      stroke: 'currentColor',
      'stroke-width': '7',
    }),
    svg('circle', { cx: '60', cy: '60', r: '16', fill: 'currentColor', opacity: '0.85' }),
    svg('path', {
      d: 'M60 44V16M45 66 20 84M75 66l25 18',
      stroke: 'currentColor',
      'stroke-width': '9',
      'stroke-linecap': 'round',
      fill: 'none',
    }),
  );
  return s;
}

function buildChevron(dir: -1 | 1): SVGSVGElement {
  const s = iconRoot(32);
  const d = dir < 0 ? 'M20 6 10 16l10 10' : 'M12 6l10 10-10 10';
  s.append(svg('path', { d, ...NS_STROKE, 'stroke-width': '3.4' }));
  return s;
}

function buildPedalGlyph(kind: 'gas' | 'brake'): SVGSVGElement {
  const s = iconRoot(32);
  if (kind === 'gas') {
    // a bolt, pointing forward-and-up: go
    s.append(svg('path', { d: 'M9 22 20 6v9h5L14 30v-8z', fill: 'currentColor' }));
  } else {
    // an octagon: the one road sign every human on earth reads instantly
    s.append(
      svg('path', {
        d: 'M11.2 4h9.6L28 11.2v9.6L20.8 28h-9.6L4 20.8v-9.6z',
        fill: 'currentColor',
      }),
      svg('path', {
        d: 'M10.5 16h11',
        stroke: 'var(--ll-hud-bg, #0b1620)',
        'stroke-width': '3.2',
        'stroke-linecap': 'round',
      }),
    );
  }
  return s;
}

function buildDriftGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('path', {
      d: 'M4 24c8 0 8-9 16-9s6 6 8 6',
      ...NS_STROKE,
      'stroke-width': '3',
    }),
    svg('path', {
      d: 'M4 29c9 0 9-8 17-8',
      ...NS_STROKE,
      'stroke-width': '2.2',
      opacity: '0.6',
    }),
  );
  return s;
}

function buildBoostGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('path', {
      d: 'M16 3c5 6 7 9 7 13a7 7 0 0 1-14 0c0-4 2-7 7-13z',
      fill: 'currentColor',
    }),
    svg('path', {
      d: 'M12 27h8',
      ...NS_STROKE,
      'stroke-width': '3',
      opacity: '0.7',
    }),
  );
  return s;
}

function buildHornGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('path', { d: 'M6 13v6h5l8 6V7l-8 6z', fill: 'currentColor' }),
    svg('path', { d: 'M23 11a7 7 0 0 1 0 10', ...NS_STROKE, 'stroke-width': '2.6' }),
  );
  return s;
}

function buildFlipGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('path', {
      d: 'M26 16a10 10 0 1 1-3-7',
      ...NS_STROKE,
      'stroke-width': '3',
    }),
    svg('path', { d: 'M26 4v6h-6', ...NS_STROKE, 'stroke-width': '3' }),
  );
  return s;
}

function buildPauseGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('rect', { x: '9', y: '7', width: '5', height: '18', rx: '1.6', fill: 'currentColor' }),
    svg('rect', { x: '18', y: '7', width: '5', height: '18', rx: '1.6', fill: 'currentColor' }),
  );
  return s;
}

function buildGearGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('circle', { cx: '16', cy: '16', r: '4.6', ...NS_STROKE, 'stroke-width': '2.6' }),
    svg('path', {
      d: 'M16 3.5v3.6M16 24.9v3.6M28.5 16h-3.6M7.1 16H3.5M24.8 7.2l-2.5 2.5M9.7 22.3l-2.5 2.5M24.8 24.8l-2.5-2.5M9.7 9.7 7.2 7.2',
      ...NS_STROKE,
      'stroke-width': '2.6',
    }),
  );
  return s;
}

/** A stills camera — the view-cycle button. */
function buildCameraGlyph(): SVGSVGElement {
  const s = iconRoot(32);
  s.append(
    svg('path', {
      d: 'M4.5 10.5h5l2-3h9l2 3h5a1.6 1.6 0 0 1 1.6 1.6v11a1.6 1.6 0 0 1-1.6 1.6H4.5A1.6 1.6 0 0 1 2.9 23.1v-11a1.6 1.6 0 0 1 1.6-1.6z',
      ...NS_STROKE,
      'stroke-width': '2.2',
      'stroke-linejoin': 'round',
    }),
    svg('circle', { cx: '16', cy: '17.4', r: '4.4', ...NS_STROKE, 'stroke-width': '2.2' }),
  );
  return s;
}

function buildRotateGlyph(): SVGSVGElement {
  const s = iconRoot(120);
  s.append(
    svg('rect', {
      x: '38',
      y: '18',
      width: '44',
      height: '76',
      rx: '8',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '4',
    }),
    svg('rect', { x: '52', y: '86', width: '16', height: '3.5', rx: '1.75', fill: 'currentColor' }),
    svg('path', {
      d: 'M24 96a44 44 0 0 1 6-52',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '4',
      'stroke-linecap': 'round',
      opacity: '0.75',
    }),
    svg('path', { d: 'M24 96h11M24 96v-11', ...NS_STROKE, 'stroke-width': '4', opacity: '0.75' }),
  );
  return s;
}
