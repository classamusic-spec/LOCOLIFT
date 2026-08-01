/**
 * Loco Lift — title screen.
 *
 * Sits over the live 3D showcase camera, so the background treatment is
 * deliberately thin: a corner scrim that guarantees text contrast, a slow
 * diagonal light sweep, and a grain veil. Everything else is the city.
 *
 * The logotype is authored here — SVG text with `textLength` locked, so the
 * wordmark occupies exactly the same box on every platform regardless of which
 * system font the browser resolves. No web fonts, no images, fully offline.
 *
 * The badge is a **garita** — the sentry box that is Puerto Rico's de-facto
 * national emblem (ART_REFERENCE §7.4), drawn to its documented silhouette:
 * flaring corbel, octagonal drum, three splayed slit windows, ribbed dome,
 * finial ball.
 */
import type { GameMode } from '../core/types';
import type { SaveSystem } from '../save/SaveSystem';
import { DEFAULT_JEEP } from '../save/SaveSystem';
import {
  el,
  formatInt,
  hexFromNumber,
  MenuNavigator,
  svg,
  TextSlot,
  UITheme,
  type NavAction,
  type NavigableScreen,
} from './UITheme';

export type TitlePanel = 'none' | 'garage' | 'credits';

export interface TitleCallbacks {
  onStartMode: (mode: GameMode) => void;
  onOpenSettings: () => void;
}

interface ModeDef {
  mode: GameMode;
  es: string;
  en: string;
  hint: string;
  icon: () => SVGSVGElement;
}

const MODES: ModeDef[] = [
  {
    mode: 'arcade',
    es: 'TURNO ARCADE',
    en: 'Arcade Shift',
    hint: '90 s · cada carrera suma tiempo',
    icon: iconStopwatch,
  },
  {
    mode: 'freeRide',
    es: 'PASEO LIBRE',
    en: 'Free Ride',
    hint: 'Sin reloj · aprende los atajos',
    icon: iconCompass,
  },
  {
    mode: 'story',
    es: 'HISTORIA',
    en: 'Story',
    hint: 'Doce encargos por el casco viejo',
    icon: iconBook,
  },
  {
    mode: 'challenge',
    es: 'RETOS',
    en: 'Challenge',
    hint: 'Derrapes, saltos y contrarreloj',
    icon: iconFlag,
  },
];

const LIVERIES = ['classic', 'coquí', 'bandera', 'flamboyán', 'garita'];
const RIMS = ['steel', 'chrome', 'beadlock', 'gold'];

/** Body/accent swatches drawn from the reserved gameplay + taxi palette. */
const BODY_SWATCHES = [0xffc21a, 0xff2fa8, 0x00e5ff, 0xb6ff3b, 0xff6b3d, 0xf2e4c4, 0x14523c, 0x1b3a5c];

export class TitleScreen implements NavigableScreen {
  readonly el: HTMLElement;

  onStartMode: ((mode: GameMode) => void) | null = null;
  /**
   * The chinchorreo. It has no `GameMode` of its own — the union in
   * `core/types.ts` has no `'party'` member — so it gets its own callback
   * rather than being smuggled in as one of the four.
   */
  onStartParty: (() => void) | null = null;
  onOpenSettings: (() => void) | null = null;
  onOpenGarage: (() => void) | null = null;
  onOpenCredits: (() => void) | null = null;

  private readonly theme: UITheme;
  private readonly save: SaveSystem | null;
  private readonly nav: MenuNavigator;
  private readonly panelNav: MenuNavigator;
  private readonly menu: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly panelTitle: TextSlot;
  private readonly bankSlot: TextSlot;
  private panelState: TitlePanel = 'none';

  constructor(theme: UITheme, save: SaveSystem | null) {
    this.theme = theme;
    this.save = save;

    const root = el('div', 'll-screen ll-title');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Loco Lift main menu');
    this.el = root;

    /* background treatment ---------------------------------------------- */
    const bg = el('div', 'll-title__bg');
    bg.append(
      el('div', 'll-title__sweep'),
      el('div', 'll-title__scrim'),
      el('div', 'll-title__grain'),
    );

    /* brand -------------------------------------------------------------- */
    const brand = el('div', 'll-title__brand');
    const badge = el('div', 'll-logo__badge');
    badge.append(buildGarita());
    const logo = el('div', 'll-logo');
    logo.append(buildLogotype());
    const ribbon = el('div', 'll-logo__ribbon');
    ribbon.append(
      el('span', 'll-logo__ribbon-text', 'SAN VIEJO'),
      el('span', 'll-logo__dot', '·'),
      el('span', 'll-logo__ribbon-text', 'PUERTO RICO'),
    );
    const tagline = el('div', 'll-logo__tag', 'Taxi de aventura — 90 segundos, toda la isla vieja');
    brand.append(badge, logo, ribbon, tagline);

    /* menu ---------------------------------------------------------------*/
    const menu = el('nav', 'll-title__menu');
    menu.setAttribute('aria-label', 'Game modes');
    this.menu = menu;

    for (let i = 0; i < MODES.length; i++) {
      const def = MODES[i];
      menu.append(
        this.buildItem(def.es, def.en, def.hint, def.icon(), i === 0, () => {
          this.onStartMode?.(def.mode);
        }),
      );
    }

    menu.append(
      this.buildItem(
        'CHINCHORREO',
        'Party Bus',
        'La guagua de la fiesta · diez al club',
        iconStar(),
        false,
        () => {
          this.onStartParty?.();
        },
      ),
    );

    const sep = el('div', 'll-title__sep');
    menu.append(sep);

    menu.append(
      this.buildItem('GARAJE', 'Garage', 'Pinta y equipa tu Jeep', iconWrench(), false, () => {
        this.openPanel('garage');
        this.onOpenGarage?.();
      }),
      this.buildItem('AJUSTES', 'Settings', 'Gráficos, audio y accesibilidad', iconGear(), false, () => {
        this.onOpenSettings?.();
      }),
      this.buildItem('CRÉDITOS', 'Credits', 'Quién construyó esto', iconStar(), false, () => {
        this.openPanel('credits');
        this.onOpenCredits?.();
      }),
    );

    /* footer -------------------------------------------------------------*/
    const footer = el('div', 'll-title__footer');
    const bank = el('div', 'll-title__bank');
    bank.append(el('span', 'll-title__bank-label', 'BANCO'));
    const bankValue = el('span', 'll-title__bank-value', '$0');
    bank.append(bankValue);
    this.bankSlot = new TextSlot(bankValue);

    const hints = el('div', 'll-hints');
    hints.append(
      hintChip(['↑', '↓'], 'Navegar'),
      hintChip(['↵'], 'Seleccionar'),
      hintChip(['Esc'], 'Volver'),
      hintChip(['⌾'], 'Gamepad'),
    );
    footer.append(bank, hints);

    /* sub-panel -----------------------------------------------------------*/
    const panel = el('div', 'll-panel ll-title__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    const panelHead = el('div', 'll-panel__head');
    const panelTitleEl = el('h2', 'll-panel__title', '');
    const closeBtn = el('button', 'll-btn ll-btn--ghost ll-panel__close');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Volver';
    closeBtn.setAttribute('aria-label', 'Close panel');
    closeBtn.addEventListener('click', () => this.openPanel('none'));
    panelHead.append(panelTitleEl, closeBtn);
    const panelBody = el('div', 'll-panel__body');
    panel.append(panelHead, panelBody);
    this.panel = panel;
    this.panelBody = panelBody;
    this.panelTitle = new TextSlot(panelTitleEl);

    const column = el('div', 'll-title__col');
    column.append(brand, menu, footer);

    root.append(bg, column, panel);

    this.nav = new MenuNavigator(menu);
    this.panelNav = new MenuNavigator(panel);
    this.openPanel('none');
    this.refresh();
  }

  /* ------------------------------------------------------------ lifecycle */

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    this.refresh();
  }

  unmount(): void {
    this.el.remove();
  }

  refresh(): void {
    const bankValue = this.save?.current.bank ?? 0;
    this.bankSlot.set(`$${formatInt(bankValue)}`);
    if (this.panelState === 'garage') this.renderGarage();
  }

  focusFirst(): void {
    if (this.panelState !== 'none') this.panelNav.focusFirst();
    else this.nav.focusFirst();
  }

  /* ---------------------------------------------------------------- panel */

  openPanel(which: TitlePanel): void {
    this.panelState = which;
    const open = which !== 'none';
    this.panel.classList.toggle('is-open', open);
    this.panel.classList.toggle('is-gone', !open);
    this.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    this.menu.classList.toggle('is-behind', open);
    if (!open) {
      this.nav.focusFirst();
      return;
    }
    if (which === 'garage') {
      this.panelTitle.set('GARAJE · Garage');
      this.renderGarage();
    } else {
      this.panelTitle.set('CRÉDITOS · Credits');
      this.renderCredits();
    }
    if (!this.theme.flashSafe) {
      this.panel.animate(
        [
          { transform: 'translateY(-50%) translate3d(24px, 0, 0)', opacity: 0 },
          { transform: 'translateY(-50%) translate3d(0, 0, 0)', opacity: 1 },
        ],
        { duration: this.theme.duration(260), easing: this.theme.ease('outExpo') },
      );
    }
    this.panelNav.focusFirst();
  }

  get openedPanel(): TitlePanel {
    return this.panelState;
  }

  private renderGarage(): void {
    const body = this.panelBody;
    body.replaceChildren();
    const jeep = this.save?.current.jeep ?? DEFAULT_JEEP;

    body.append(
      this.swatchRow('Color de carrocería', 'Body colour', jeep.bodyColor, (c) =>
        this.save?.setJeep({ bodyColor: c }),
      ),
      this.swatchRow('Color de acento', 'Accent colour', jeep.accentColor, (c) =>
        this.save?.setJeep({ accentColor: c }),
      ),
      this.pickRow('Librea', 'Livery', LIVERIES, jeep.livery, (v) => this.save?.setJeep({ livery: v })),
      this.pickRow('Llantas', 'Rims', RIMS, jeep.rims, (v) => this.save?.setJeep({ rims: v })),
    );

    const stats = el('div', 'll-garage__stats');
    const s = this.save?.current;
    stats.append(
      statChip('Carreras', String(s?.totalFares ?? 0)),
      statChip('Mejor combo', `×${s?.biggestCombo ?? 0}`),
      statChip('Derrape más largo', `${(s?.longestDrift ?? 0).toFixed(1)} s`),
      statChip('Vuelo más largo', `${(s?.longestAirtime ?? 0).toFixed(1)} s`),
    );
    body.append(stats);
  }

  private renderCredits(): void {
    const body = this.panelBody;
    body.replaceChildren();
    const block = (heading: string, lines: string[]): HTMLElement => {
      const wrap = el('div', 'll-credits__block');
      wrap.append(el('h3', 'll-credits__h', heading));
      for (const line of lines) wrap.append(el('p', 'll-credits__p', line));
      return wrap;
    };
    body.append(
      block('LOCO LIFT', [
        'Un taxi arcade en San Viejo, Puerto Rico.',
        'Motor: Three.js · Rapier3D · TypeScript · Vite.',
      ]),
      block('Construido por', [
        'Mundo, vehículo, cámara, tráfico, pasajeros, audio, efectos e interfaz — sistemas independientes sobre un bus de eventos tipado.',
        'Toda la geometría y todas las texturas son procedurales. Cero descargas.',
      ]),
      block('Sobre la ciudad', [
        'El Viejo San Juan es Patrimonio de la Humanidad y una ciudad viva de más de 400 edificios históricos.',
        'La arquitectura, el adoquín, las garitas y los rótulos siguen referencias reales. Cualquier error es nuestro.',
      ]),
      block('Gracias', ['A quien conduce despacio por Calle del Cristo. Aquí no.']),
    );
  }

  private swatchRow(
    es: string,
    en: string,
    selected: number,
    apply: (color: number) => void,
  ): HTMLElement {
    const row = el('div', 'll-field');
    row.append(fieldLabel(es, en));
    const group = el('div', 'll-swatches');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', en);
    group.dataset.segmented = '1';
    for (const color of BODY_SWATCHES) {
      const b = el('button', 'll-swatch');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', color === selected ? 'true' : 'false');
      b.setAttribute('aria-label', hexFromNumber(color));
      b.style.setProperty('--swatch', hexFromNumber(color));
      b.addEventListener('click', () => {
        apply(color);
        for (const other of Array.from(group.children)) {
          other.setAttribute('aria-checked', other === b ? 'true' : 'false');
        }
      });
      group.append(b);
    }
    row.append(group);
    return row;
  }

  private pickRow(
    es: string,
    en: string,
    options: string[],
    selected: string,
    apply: (value: string) => void,
  ): HTMLElement {
    const row = el('div', 'll-field');
    row.append(fieldLabel(es, en));
    const group = el('div', 'll-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', en);
    group.dataset.segmented = '1';
    const unlocked = this.save?.current.unlocked ?? [];
    for (const option of options) {
      const b = el('button', 'll-seg__opt', option);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      const locked = unlocked.length > 0 && !unlocked.includes(option) && option !== selected;
      b.setAttribute('aria-checked', option === selected ? 'true' : 'false');
      if (locked) {
        b.classList.add('is-locked');
        b.setAttribute('aria-disabled', 'true');
      }
      b.addEventListener('click', () => {
        if (locked) return;
        apply(option);
        for (const other of Array.from(group.children)) {
          other.setAttribute('aria-checked', other === b ? 'true' : 'false');
        }
      });
      group.append(b);
    }
    row.append(group);
    return row;
  }

  /* ------------------------------------------------------------------ nav */

  handleNav(action: NavAction): boolean {
    const nav = this.panelState === 'none' ? this.nav : this.panelNav;
    switch (action) {
      case 'up':
        return nav.move(-1);
      case 'down':
        return nav.move(1);
      case 'left':
        return nav.adjustFocused(-1);
      case 'right':
        return nav.adjustFocused(1);
      case 'confirm': {
        const active = document.activeElement as HTMLElement | null;
        if (active && this.el.contains(active)) {
          active.click();
          return true;
        }
        return false;
      }
      case 'back':
        if (this.panelState !== 'none') {
          this.openPanel('none');
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  trapTab(e: KeyboardEvent): void {
    (this.panelState === 'none' ? this.nav : this.panelNav).trapTab(e);
  }

  private buildItem(
    es: string,
    en: string,
    hint: string,
    icon: SVGSVGElement,
    autofocus: boolean,
    onClick: () => void,
  ): HTMLButtonElement {
    const b = el('button', 'll-mi');
    b.type = 'button';
    if (autofocus) b.dataset.autofocus = '1';
    const glyph = el('span', 'll-mi__glyph');
    glyph.append(icon);
    const text = el('span', 'll-mi__text');
    text.append(el('span', 'll-mi__es', es), el('span', 'll-mi__en', en));
    const hintEl = el('span', 'll-mi__hint', hint);
    const chev = el('span', 'll-mi__chev');
    chev.append(iconChevron());
    b.append(glyph, text, hintEl, chev);
    b.setAttribute('aria-label', `${en} — ${hint}`);
    b.addEventListener('click', onClick);
    return b;
  }

  dispose(): void {
    this.unmount();
    this.onStartMode = null;
    this.onStartParty = null;
    this.onOpenSettings = null;
    this.onOpenGarage = null;
    this.onOpenCredits = null;
  }
}

/* --------------------------------------------------------------- fragments */

function fieldLabel(es: string, en: string): HTMLElement {
  const l = el('div', 'll-field__label');
  l.append(el('span', 'll-lbl-es', es), el('span', 'll-lbl-en', en));
  return l;
}

function statChip(label: string, value: string): HTMLElement {
  const c = el('div', 'll-statchip');
  c.append(el('span', 'll-statchip__v', value), el('span', 'll-statchip__l', label));
  return c;
}

function hintChip(keys: string[], label: string): HTMLElement {
  const wrap = el('div', 'll-hint');
  for (const k of keys) wrap.append(el('kbd', 'll-kbd', k));
  wrap.append(el('span', 'll-hint__label', label));
  return wrap;
}

/* ----------------------------------------------------------------- artwork */

/**
 * The LOCO LIFT wordmark. Two stacked words, each drawn four times: soft drop,
 * ink extrude, ink outline (via `paint-order: stroke`), gradient face.
 * `textLength` pins the width so the mark never reflows with the system font.
 */
export function buildLogotype(): SVGSVGElement {
  const s = svg('svg', {
    viewBox: '0 0 560 268',
    class: 'll-logo__svg',
    role: 'img',
    'aria-label': 'Loco Lift',
  });

  const defs = svg('defs');
  const gradA = svg('linearGradient', { id: 'llGradA', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradA.append(
    svg('stop', { offset: '0', 'stop-color': '#FFE9A8' }),
    svg('stop', { offset: '0.52', 'stop-color': '#FFC21A' }),
    svg('stop', { offset: '1', 'stop-color': '#FF8A1E' }),
  );
  const gradB = svg('linearGradient', { id: 'llGradB', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradB.append(
    svg('stop', { offset: '0', 'stop-color': '#FFFFFF' }),
    svg('stop', { offset: '0.55', 'stop-color': '#8CF0FF' }),
    svg('stop', { offset: '1', 'stop-color': '#00E5FF' }),
  );
  defs.append(gradA, gradB);
  s.append(defs);

  const word = (
    text: string,
    y: number,
    x: number,
    length: number,
    size: number,
    fill: string,
    extrude: string,
  ): SVGGElement => {
    const g = svg('g', { class: 'll-logo__word' });
    const attrs = {
      x: String(x),
      y: String(y),
      'font-size': String(size),
      'font-weight': '900',
      'font-family': 'var(--ll-display)',
      textLength: String(length),
      lengthAdjust: 'spacingAndGlyphs',
      'letter-spacing': '-2',
    };
    for (let i = 7; i >= 1; i--) {
      const shadow = svg('text', { ...attrs, transform: `translate(${i * 1.1}, ${i * 1.7})` });
      shadow.setAttribute('fill', extrude);
      shadow.textContent = text;
      g.append(shadow);
    }
    const outline = svg('text', attrs);
    outline.setAttribute('fill', 'var(--ll-ink)');
    outline.setAttribute('stroke', 'var(--ll-ink)');
    outline.setAttribute('stroke-width', '16');
    outline.setAttribute('stroke-linejoin', 'round');
    outline.setAttribute('paint-order', 'stroke');
    outline.textContent = text;
    const face = svg('text', attrs);
    face.setAttribute('fill', fill);
    face.textContent = text;
    g.append(outline, face);
    return g;
  };

  const skew = svg('g', { transform: 'skewX(-7)' });
  skew.append(
    word('LOCO', 122, 40, 306, 136, 'url(#llGradA)', '#A10F5E'),
    word('LIFT', 228, 40, 252, 122, 'url(#llGradB)', '#06394A'),
  );

  // Taxi checker — a livery stripe ruling the whole mark, not a floating dash.
  const band = svg('g', { class: 'll-logo__checker' });
  band.append(
    svg('rect', { x: '38', y: '240', width: '486', height: '24', fill: 'var(--ll-ink)', rx: '3' }),
  );
  const sq = 12;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 40; i++) {
      if ((i + row) % 2 !== 0) continue;
      band.append(
        svg('rect', {
          x: String(40 + i * sq),
          y: String(242 + row * (sq - 1)),
          width: String(sq),
          height: String(sq - 1),
          fill: '#FFF6E8',
        }),
      );
    }
  }
  skew.append(band);
  s.append(skew);
  return s;
}

/**
 * A garita — octagonal sentry-box drum on a flaring corbel, ribbed dome, finial
 * ball, three splayed slit windows. Limewash white on a magenta disc.
 */
export function buildGarita(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 96 96', class: 'll-garita', 'aria-hidden': 'true' });
  s.append(
    svg('circle', { cx: '48', cy: '48', r: '46', fill: 'var(--ll-dest)' }),
    svg('circle', {
      cx: '48',
      cy: '48',
      r: '46',
      fill: 'none',
      stroke: 'var(--ll-ink)',
      'stroke-width': '4',
    }),
  );
  const g = svg('g', { fill: '#EFE9D8', stroke: '#0A0C10', 'stroke-width': '2.6' });
  // corbel
  g.append(svg('path', { d: 'M38 84 L58 84 L64 72 L32 72 Z' }));
  // drum
  g.append(svg('path', { d: 'M33 72 L33 40 L63 40 L63 72 Z' }));
  // cornice
  g.append(svg('rect', { x: '30', y: '35', width: '36', height: '6', rx: '1' }));
  // dome
  g.append(svg('path', { d: 'M30 35 Q48 8 66 35 Z' }));
  // finial
  g.append(svg('circle', { cx: '48', cy: '9', r: '4' }));
  s.append(g);
  // dome ribs + slit windows read even at 28 px
  const detail = svg('g', { stroke: '#0A0C10', 'stroke-width': '1.6', fill: 'none' });
  detail.append(
    svg('path', { d: 'M48 11 L48 35' }),
    svg('path', { d: 'M37 33 Q44 14 48 11' }),
    svg('path', { d: 'M59 33 Q52 14 48 11' }),
  );
  s.append(detail);
  const slits = svg('g', { fill: '#0A0C10' });
  slits.append(
    svg('rect', { x: '46.4', y: '47', width: '3.2', height: '11', rx: '1.6' }),
    svg('rect', { x: '36.4', y: '49', width: '2.8', height: '9', rx: '1.4' }),
    svg('rect', { x: '56.8', y: '49', width: '2.8', height: '9', rx: '1.4' }),
  );
  s.append(slits);
  return s;
}

/* -------------------------------------------------------------- icon set */

function iconBase(): SVGSVGElement {
  return svg('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
}

function iconStopwatch(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('circle', { cx: '12', cy: '13.5', r: '7.5' }),
    svg('path', { d: 'M12 9.5 V13.5 L14.8 15.4' }),
    svg('path', { d: 'M9.5 2 H14.5' }),
    svg('path', { d: 'M12 2 V6' }),
    svg('path', { d: 'M18.6 7.4 L20.2 5.8' }),
  );
  return s;
}

function iconCompass(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('circle', { cx: '12', cy: '12', r: '9' }),
    svg('path', { d: 'M15.6 8.4 L13.6 13.6 L8.4 15.6 L10.4 10.4 Z' }),
  );
  return s;
}

function iconBook(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('path', { d: 'M4 4.5 A2.5 2.5 0 0 1 6.5 2 H20 V17 H6.5 A2.5 2.5 0 0 0 4 19.5 Z' }),
    svg('path', { d: 'M4 19.5 A2.5 2.5 0 0 0 6.5 22 H20 V17' }),
  );
  return s;
}

function iconFlag(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('path', { d: 'M5 21 V3' }),
    svg('path', { d: 'M5 4 H19 V13 H5' }),
    svg('path', { d: 'M5 4 H12 V8.5 H19 M12 8.5 V13 H5', fill: 'currentColor', stroke: 'none' }),
  );
  return s;
}

function iconWrench(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('path', {
      d: 'M15.5 3.5 A5.5 5.5 0 0 0 8.6 10.6 L3.5 15.7 A2 2 0 0 0 6.3 18.5 L11.4 13.4 A5.5 5.5 0 0 0 18.5 6.5 L15.4 9.6 L12.4 6.6 Z',
    }),
  );
  return s;
}

function iconGear(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('circle', { cx: '12', cy: '12', r: '3.2' }),
    svg('path', {
      d: 'M12 2.6 L13.4 5.2 L16.2 4.6 L16.6 7.4 L19.4 8.2 L18 10.6 L19.4 13 L16.6 13.8 L16.2 16.6 L13.4 16 L12 18.6 L10.6 16 L7.8 16.6 L7.4 13.8 L4.6 13 L6 10.6 L4.6 8.2 L7.4 7.4 L7.8 4.6 L10.6 5.2 Z',
    }),
  );
  return s;
}

function iconStar(): SVGSVGElement {
  const s = iconBase();
  s.append(
    svg('path', {
      d: 'M12 3.2 L14.6 9 L21 9.7 L16.3 14 L17.6 20.3 L12 17.1 L6.4 20.3 L7.7 14 L3 9.7 L9.4 9 Z',
    }),
  );
  return s;
}

function iconChevron(): SVGSVGElement {
  const s = iconBase();
  s.setAttribute('stroke-width', '3');
  s.append(svg('path', { d: 'M9 5 L16 12 L9 19' }));
  return s;
}
