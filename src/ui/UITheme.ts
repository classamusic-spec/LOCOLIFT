/**
 * Loco Lift — UI design system.
 *
 * Everything visual in `src/ui/**` consumes this file: colour tokens, the type
 * scale, spacing, easing curves, shadow/glow recipes, and the accessibility
 * transforms (`uiScale`, `largeText`, `highContrastHud`, `colorBlindMode`,
 * `photosensitiveSafe`).
 *
 * The theme owns exactly one piece of runtime state: a block of CSS custom
 * properties written onto the UI root element. Components never compute a
 * colour at runtime — they reference `var(--ll-…)` — so re-applying settings is
 * a single style write and never touches the DOM structure.
 *
 * Colour policy (ART_REFERENCE §3.6 "reserved gameplay colours"): the city may
 * never use these four hues, so the UI can lean on them without ever colliding
 * with a façade behind it.
 *
 *   Loco Magenta #FF2FA8 — destination, route, the navigation arrow
 *   Loco Cyan    #00E5FF — pickups, boost, near-miss
 *   Loco Lime    #B6FF3B — combo, score, "good thing happened"
 *   Taxi Yellow  #FFC21A — *the player*: the Jeep blip, the fare, the logotype
 *
 * Taxi Yellow is reserved for the Jeep body in world space; in UI space it is
 * used only for things that *are* the player (their car on the minimap, their
 * money, their game's name), which keeps the association intact rather than
 * diluting it.
 */
import './styles.css';
import { clamp, clamp01 } from '../core/MathUtils';
import type { SettingsState } from '../core/types';

/* ------------------------------------------------------------------ tokens */

/** Semantic colour roles. Every component references one of these. */
export const UI_COLORS = {
  /** destination markers, route ribbon, the arrow (ART_REFERENCE R11) */
  dest: '#FF2FA8',
  /** passenger pickups, boost, near-miss flash */
  pickup: '#00E5FF',
  /** combo, score pops, positive confirmation */
  combo: '#B6FF3B',
  /** the player — Jeep blip, fare, brand */
  player: '#FFC21A',
  /** urgency: last seconds, wrong way, patience critical */
  danger: '#FF2D3C',
  /** the 2 px keyline that keeps UI legible over a bright cream façade */
  ink: '#0A0C10',
  /** warm off-white body text — echoes Blanco Cal, never clinical white */
  paper: '#FFF6E8',
  /** muted label text */
  muted: '#9FB0BF',
} as const;

export type ColorRole = keyof typeof UI_COLORS;

/** Panel/surface tones. Cool and dark so the warm city reads through/behind. */
export const UI_SURFACES = {
  /** in-play HUD chrome — cheap flat alpha, never backdrop-filter */
  hud: 'rgba(8, 16, 24, 0.62)',
  hudSolid: '#0B1620',
  /** full-screen menu backdrop */
  scrim: 'rgba(6, 11, 17, 0.78)',
  panel: 'rgba(12, 26, 38, 0.94)',
  panelRaise: 'rgba(19, 38, 53, 0.96)',
  line: 'rgba(255, 246, 232, 0.14)',
} as const;

/** Type scale in px at `uiScale = 1`, `largeText = off`. */
export const UI_TYPE = {
  '2xs': 11,
  xs: 12.5,
  sm: 14,
  md: 16,
  lg: 19,
  xl: 24,
  '2xl': 32,
  '3xl': 44,
  '4xl': 62,
  '5xl': 92,
} as const;

/** Spacing ramp in px at `uiScale = 1`. */
export const UI_SPACE = {
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 24,
  '6': 32,
  '7': 48,
  '8': 64,
} as const;

export const UI_RADIUS = { sm: 5, md: 10, lg: 16, pill: 999 } as const;

/** Easing curves. `punch` and `back` are the arcade ones — use them. */
export const UI_EASE = {
  standard: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  outExpo: 'cubic-bezier(0.16, 1, 0.30, 1)',
  back: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  inBack: 'cubic-bezier(0.36, 0, 0.66, -0.56)',
  punch: 'cubic-bezier(0.12, 0.86, 0.22, 1.12)',
  linear: 'linear',
} as const;

/** Shadow + glow recipes. */
export const UI_SHADOW = {
  panel: '0 24px 60px rgba(2, 6, 11, 0.62), 0 2px 0 rgba(255, 246, 232, 0.07) inset',
  chip: '0 6px 18px rgba(2, 6, 11, 0.5)',
  lift: '0 10px 0 rgba(4, 9, 14, 0.55)',
} as const;

/** Durations in ms. */
export const UI_TIME = {
  micro: 90,
  fast: 160,
  base: 260,
  slow: 420,
  screen: 520,
} as const;

/* ------------------------------------------------- colour-blindness support */

interface RGB {
  r: number;
  g: number;
  b: number;
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** `#rrggbb` (or `#rgb`) → 0..1 linear RGB. Returns null for anything else. */
function parseHex(hex: string): RGB | null {
  let h = hex.trim();
  if (h.charCodeAt(0) === 35) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return {
    r: srgbToLinear(((n >> 16) & 0xff) / 255),
    g: srgbToLinear(((n >> 8) & 0xff) / 255),
    b: srgbToLinear((n & 0xff) / 255),
  };
}

function toHex(lin: RGB): string {
  const to = (v: number): number => Math.round(clamp01(linearToSrgb(clamp01(v))) * 255);
  const n = (to(lin.r) << 16) | (to(lin.g) << 8) | to(lin.b);
  return `#${n.toString(16).padStart(6, '0')}`;
}

export type ColorBlindMode = SettingsState['colorBlindMode'];

/**
 * Daltonisation — LMS dichromacy simulation with the lost signal redistributed
 * into the channels the viewer *can* still separate.
 *
 * The point is not to show a protanope "what the colour really is"; it is to
 * make `#FF2FA8` (destination) and `#B6FF3B` (combo) land far enough apart that
 * the two never read as the same marker at 50 m/s.
 */
export function daltonize(hex: string, mode: ColorBlindMode): string {
  if (mode === 'none') return hex;
  const c = parseHex(hex);
  if (!c) return hex;

  // linear RGB -> LMS (Hunt-Pointer-Estevez, D65)
  const L = 17.8824 * c.r + 43.5161 * c.g + 4.11935 * c.b;
  const M = 3.45565 * c.r + 27.1554 * c.g + 3.86714 * c.b;
  const S = 0.0299566 * c.r + 0.184309 * c.g + 1.46709 * c.b;

  let Ls = L;
  let Ms = M;
  let Ss = S;
  if (mode === 'protanopia') Ls = 2.02344 * M - 2.52581 * S;
  else if (mode === 'deuteranopia') Ms = 0.494207 * L + 1.24827 * S;
  else Ss = -0.395913 * L + 0.801109 * M;

  // LMS -> linear RGB
  const sim: RGB = {
    r: 0.0809444479 * Ls - 0.130504409 * Ms + 0.116721066 * Ss,
    g: -0.0102485335 * Ls + 0.0540193266 * Ms - 0.113614708 * Ss,
    b: -0.000365296938 * Ls - 0.00412161469 * Ms + 0.693511405 * Ss,
  };

  // redistribute the error into the surviving opponent axes
  const er = c.r - sim.r;
  const eg = c.g - sim.g;
  const eb = c.b - sim.b;
  return toHex({
    r: c.r,
    g: c.g + 0.7 * er + 1.0 * eg,
    b: c.b + 0.7 * er + 1.0 * eb,
  });
}

/** `0xRRGGBB` → `#rrggbb`. */
export const hexFromNumber = (n: number): string =>
  `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Push a colour toward a usable HUD tint: nothing so dark it dies against the
 * panel, nothing so pale it stops reading as a colour. Used for passenger
 * archetype tints, which arrive as arbitrary `0xRRGGBB` from another module.
 */
export function toChipColor(n: number, mode: ColorBlindMode): string {
  const c = parseHex(hexFromNumber(n));
  if (!c) return UI_COLORS.pickup;
  // relative luminance in linear space
  const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  let k = 1;
  if (y < 0.09) k = Math.sqrt(0.09 / Math.max(y, 0.002));
  else if (y > 0.72) k = 0.72 / y;
  return daltonize(toHex({ r: c.r * k, g: c.g * k, b: c.b * k }), mode);
}

/** Mix two hex colours in linear space. `t = 0` → a. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = clamp01(t);
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

/** `#rrggbb` + alpha → `rgba(...)`, for canvas work where CSS vars can't reach. */
export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const to = (v: number): number => Math.round(clamp01(linearToSrgb(clamp01(v))) * 255);
  return `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${clamp01(alpha).toFixed(3)})`;
}

/* ------------------------------------------------------------------- theme */

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Applies the design system to a root element and keeps it in sync with
 * settings. One instance per `UISystem`.
 */
export class UITheme {
  readonly root: HTMLElement;

  private settings: SettingsState | null = null;
  private mq: MediaQueryList | null = null;
  private onMotionChange: (() => void) | null = null;
  private reducedMotion = false;
  private resolved: Record<ColorRole, string>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.resolved = { ...UI_COLORS };
    this.root.classList.add('ll-root');

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mq = window.matchMedia(MOTION_QUERY);
      this.reducedMotion = this.mq.matches;
      this.onMotionChange = (): void => {
        this.reducedMotion = this.mq?.matches ?? false;
        this.writeMotionState();
      };
      // Safari < 14 only has addListener; both are typed, use the modern one.
      this.mq.addEventListener('change', this.onMotionChange);
    }

    this.writeStatic();
    this.writeMotionState();
  }

  /* ------------------------------------------------------------- accessors */

  /** Current settings snapshot, or null before the first `apply`. */
  get current(): SettingsState | null {
    return this.settings;
  }

  /** True when the user asked the OS for reduced motion. */
  get prefersReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /**
   * True when *no* animation should flash, strobe, shake or scale-punch.
   * Every animated component checks this before it moves.
   */
  get flashSafe(): boolean {
    return this.reducedMotion || (this.settings?.photosensitiveSafe ?? false);
  }

  /** 1 normally, 0 when motion is suppressed — multiply amplitudes by it. */
  get motionScale(): number {
    return this.flashSafe ? 0 : 1;
  }

  /** A duration in ms, stretched and de-punched when motion is suppressed. */
  duration(ms: number): number {
    return this.flashSafe ? Math.min(ms, 160) : ms;
  }

  /** Easing that never overshoots when motion is suppressed. */
  ease(name: keyof typeof UI_EASE): string {
    if (!this.flashSafe) return UI_EASE[name];
    return name === 'back' || name === 'punch' || name === 'inBack'
      ? UI_EASE.standard
      : UI_EASE[name];
  }

  /** Colour-blind-corrected value for a semantic role. */
  color(role: ColorRole): string {
    return this.resolved[role];
  }

  /** Colour-blind-corrected passenger archetype tint. */
  chipColor(n: number): string {
    return toChipColor(n, this.settings?.colorBlindMode ?? 'none');
  }

  /** Current UI scale multiplier (0.75–1.5). */
  get scale(): number {
    return clamp(this.settings?.uiScale ?? 1, 0.75, 1.5);
  }

  /* ---------------------------------------------------------------- apply */

  /** Re-derive every CSS custom property from a settings snapshot. */
  apply(settings: SettingsState): void {
    this.settings = settings;
    const s = this.root.style;
    const mode = settings.colorBlindMode;

    for (const key of Object.keys(UI_COLORS) as ColorRole[]) {
      const value = key === 'ink' ? UI_COLORS.ink : daltonize(UI_COLORS[key], mode);
      this.resolved[key] = value;
      s.setProperty(`--ll-${key}`, value);
      s.setProperty(`--ll-${key}-a30`, withAlpha(value, 0.3));
      s.setProperty(`--ll-${key}-a60`, withAlpha(value, 0.6));
    }

    const hc = settings.highContrastHud;
    const uiScale = clamp(settings.uiScale, 0.75, 1.5);
    const textScale = settings.largeText ? 1.16 : 1;

    s.setProperty('--ll-ui-scale', String(uiScale));
    s.setProperty('--ll-text-scale', String(textScale));

    for (const [k, v] of Object.entries(UI_TYPE)) {
      s.setProperty(`--ll-fs-${k}`, `${(v * uiScale * textScale).toFixed(2)}px`);
    }
    for (const [k, v] of Object.entries(UI_SPACE)) {
      s.setProperty(`--ll-sp-${k}`, `${(v * uiScale).toFixed(2)}px`);
    }
    for (const [k, v] of Object.entries(UI_RADIUS)) {
      s.setProperty(`--ll-r-${k}`, k === 'pill' ? `${v}px` : `${(v * uiScale).toFixed(2)}px`);
    }

    // High contrast: opaque chrome, fatter keylines, pure-white body text.
    s.setProperty('--ll-hud-bg', hc ? 'rgba(4, 8, 12, 0.94)' : UI_SURFACES.hud);
    s.setProperty('--ll-panel-bg', hc ? 'rgba(4, 8, 12, 0.985)' : UI_SURFACES.panel);
    s.setProperty('--ll-panel-raise', hc ? 'rgba(14, 22, 30, 1)' : UI_SURFACES.panelRaise);
    s.setProperty('--ll-scrim', hc ? 'rgba(2, 4, 7, 0.92)' : UI_SURFACES.scrim);
    s.setProperty('--ll-line', hc ? 'rgba(255, 255, 255, 0.45)' : UI_SURFACES.line);
    s.setProperty('--ll-text', hc ? '#FFFFFF' : UI_COLORS.paper);
    s.setProperty('--ll-text-muted', hc ? '#DCE6EE' : UI_COLORS.muted);
    s.setProperty('--ll-key', `${(hc ? 3 : 2) * uiScale}px`);
    s.setProperty('--ll-stroke', hc ? '0.7px' : '0px');

    this.root.dataset.contrast = hc ? 'high' : 'normal';
    this.root.dataset.cb = mode;
    this.root.dataset.large = settings.largeText ? '1' : '0';
    this.writeMotionState();
  }

  /* -------------------------------------------------------------- private */

  private writeStatic(): void {
    const s = this.root.style;
    for (const [k, v] of Object.entries(UI_EASE)) s.setProperty(`--ll-ease-${k}`, v);
    for (const [k, v] of Object.entries(UI_TIME)) s.setProperty(`--ll-t-${k}`, `${v}ms`);
    for (const [k, v] of Object.entries(UI_SHADOW)) s.setProperty(`--ll-sh-${k}`, v);
    s.setProperty('--ll-ink', UI_COLORS.ink);
  }

  private writeMotionState(): void {
    const safe = this.flashSafe;
    this.root.dataset.motion = safe ? 'safe' : 'full';
    this.root.style.setProperty('--ll-motion', safe ? '0' : '1');
    this.root.style.setProperty('--ll-anim-play', safe ? 'paused' : 'running');
  }

  dispose(): void {
    if (this.mq && this.onMotionChange) this.mq.removeEventListener('change', this.onMotionChange);
    this.mq = null;
    this.onMotionChange = null;
    this.root.classList.remove('ll-root');
  }
}

/* --------------------------------------------------------------- DOM utils */

/** Terse element factory — every component builds its tree with this. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline-SVG factory. No external assets, ever. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

/**
 * A text node whose `textContent` is only written when the string actually
 * changes. The HUD runs every frame; this is what keeps it off the paint path.
 */
export class TextSlot {
  readonly el: HTMLElement;
  private last = ' ';

  constructor(target: HTMLElement) {
    this.el = target;
  }

  set(value: string): boolean {
    if (value === this.last) return false;
    this.last = value;
    this.el.textContent = value;
    return true;
  }
}

/**
 * A CSS custom property whose value is only written when it moves by more than
 * `epsilon`. Custom properties are compositor-safe: no layout is triggered.
 */
export class VarSlot {
  private last = Number.NaN;

  constructor(
    private readonly target: HTMLElement,
    private readonly name: string,
    private readonly epsilon = 0.002,
    private readonly digits = 4,
  ) {}

  set(value: number): boolean {
    if (Math.abs(value - this.last) < this.epsilon) return false;
    this.last = value;
    this.target.style.setProperty(this.name, value.toFixed(this.digits));
    return true;
  }

  /** Force the next `set` through even if the value looks unchanged. */
  invalidate(): void {
    this.last = Number.NaN;
  }
}

/** Toggle a class only when the flag flips. */
export class FlagSlot {
  private last: boolean | null = null;

  constructor(
    private readonly target: HTMLElement,
    private readonly className: string,
  ) {}

  set(on: boolean): boolean {
    if (on === this.last) return false;
    this.last = on;
    this.target.classList.toggle(this.className, on);
    return true;
  }
}

/** Thousands-separated integer, allocation-free for unchanged values. */
export function formatInt(value: number): string {
  const v = Math.round(value);
  const neg = v < 0;
  let s = String(neg ? -v : v);
  if (s.length > 3) {
    let out = '';
    let c = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      out = s[i] + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    s = out;
  }
  return neg ? `-${s}` : s;
}

/** `M:SS` above a minute, `SS` below it — the arcade convention. */
export function formatClock(seconds: number): string {
  const t = Math.max(0, seconds);
  const whole = Math.floor(t);
  if (whole < 60) return String(whole);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Tenths digit of a countdown, as a bare `.d`. */
export function formatTenths(seconds: number): string {
  const t = Math.max(0, seconds);
  return `.${Math.floor((t - Math.floor(t)) * 10)}`;
}
