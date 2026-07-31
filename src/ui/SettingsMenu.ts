/**
 * Loco Lift — settings.
 *
 * Every field in `SettingsState` is exposed, grouped Accessibility → Graphics →
 * Audio → Controls. Accessibility is first because it is first-class: it is the
 * default tab, it is the largest group, and each of its rows explains what it
 * actually does rather than naming a variable.
 *
 * Every change writes straight through `SettingsStore`, so it applies live and
 * persists; the menu also subscribes back so a change made elsewhere (a quality
 * preset stamping `shadows`, for instance) is reflected without a rebuild.
 */
import { clamp } from '../core/MathUtils';
import type { QualityTier, SettingsState } from '../core/types';
import type { SettingsStore } from '../settings/SettingsStore';
import { el, MenuNavigator, svg, UITheme } from './UITheme';
import type { NavAction, NavigableScreen } from './UITheme';

type GroupId = 'access' | 'graphics' | 'audio' | 'controls';

interface GroupDef {
  id: GroupId;
  es: string;
  en: string;
}

const GROUPS: GroupDef[] = [
  { id: 'access', es: 'ACCESIBILIDAD', en: 'Accessibility' },
  { id: 'graphics', es: 'GRÁFICOS', en: 'Graphics' },
  { id: 'audio', es: 'AUDIO', en: 'Audio' },
  { id: 'controls', es: 'CONTROLES', en: 'Controls' },
];

type Refresher = (s: SettingsState) => void;

export class SettingsMenu implements NavigableScreen {
  readonly el: HTMLElement;

  onBack: (() => void) | null = null;

  private readonly theme: UITheme;
  private readonly store: SettingsStore;
  private readonly nav: MenuNavigator;
  private readonly panels = new Map<GroupId, HTMLElement>();
  private readonly tabs = new Map<GroupId, HTMLButtonElement>();
  private readonly refreshers: Refresher[] = [];
  private unsubscribe: (() => void) | null = null;
  private active: GroupId = 'access';

  constructor(theme: UITheme, store: SettingsStore) {
    this.theme = theme;
    this.store = store;

    const root = el('div', 'll-screen ll-settings');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Settings');
    this.el = root;

    root.append(el('div', 'll-settings__scrim'));

    const shell = el('div', 'll-panel ll-settings__shell');

    const head = el('div', 'll-settings__head');
    const titles = el('div', 'll-settings__titles');
    titles.append(el('h2', 'll-settings__title', 'AJUSTES'), el('div', 'll-settings__sub', 'Settings'));
    const back = el('button', 'll-btn ll-btn--ghost');
    back.type = 'button';
    back.textContent = 'Volver · Back';
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', () => this.onBack?.());
    head.append(titles, back);

    const tablist = el('div', 'll-tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Settings groups');

    const body = el('div', 'll-settings__body');

    for (const g of GROUPS) {
      const tab = el('button', 'll-tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.id = `ll-tab-${g.id}`;
      tab.setAttribute('aria-controls', `ll-panel-${g.id}`);
      tab.append(el('span', 'll-tab__es', g.es), el('span', 'll-tab__en', g.en));
      tab.addEventListener('click', () => this.show(g.id));
      tablist.append(tab);
      this.tabs.set(g.id, tab);

      const panel = el('div', 'll-settings__group');
      panel.id = `ll-panel-${g.id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `ll-tab-${g.id}`);
      body.append(panel);
      this.panels.set(g.id, panel);
    }

    this.buildAccessibility(this.panels.get('access')!);
    this.buildGraphics(this.panels.get('graphics')!);
    this.buildAudio(this.panels.get('audio')!);
    this.buildControls(this.panels.get('controls')!);

    const foot = el('div', 'll-settings__foot');
    const reset = el('button', 'll-btn ll-btn--danger');
    reset.type = 'button';
    reset.textContent = 'Restaurar valores · Reset all';
    reset.addEventListener('click', () => this.store.reset());
    const note = el('div', 'll-settings__note', 'Los cambios se aplican y se guardan al instante.');
    foot.append(note, reset);

    shell.append(head, tablist, body, foot);
    root.append(shell);

    this.nav = new MenuNavigator(shell);
    this.show('access');
    this.refresh(this.store.current);
  }

  /* ------------------------------------------------------------ lifecycle */

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    this.unsubscribe = this.store.subscribe((s) => this.refresh(s));
    this.refresh(this.store.current);
    if (!this.theme.flashSafe) {
      this.el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: this.theme.duration(180),
        easing: this.theme.ease('standard'),
      });
    }
    this.focusFirst();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.el.remove();
  }

  focusFirst(): void {
    this.tabs.get(this.active)?.focus();
  }

  show(id: GroupId): void {
    this.active = id;
    for (const [key, panel] of this.panels) {
      const on = key === id;
      panel.classList.toggle('is-active', on);
      if (on) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    }
    for (const [key, tab] of this.tabs) {
      const on = key === id;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = 0;
    }
  }

  private refresh(s: SettingsState): void {
    for (const fn of this.refreshers) fn(s);
  }

  /* ------------------------------------------------------------------ nav */

  handleNav(action: NavAction): boolean {
    switch (action) {
      case 'up':
        return this.nav.move(-1);
      case 'down':
        return this.nav.move(1);
      case 'left':
      case 'right': {
        const active = document.activeElement as HTMLElement | null;
        const dir = action === 'left' ? -1 : 1;
        if (active?.getAttribute('role') === 'tab') {
          const ids = GROUPS.map((g) => g.id);
          const i = ids.indexOf(this.active);
          const next = ids[(i + dir + ids.length) % ids.length];
          this.show(next);
          this.tabs.get(next)?.focus();
          return true;
        }
        return this.nav.adjustFocused(dir === -1 ? -1 : 1);
      }
      case 'confirm': {
        const active = document.activeElement as HTMLElement | null;
        if (active && this.el.contains(active)) {
          active.click();
          return true;
        }
        return false;
      }
      case 'back':
        this.onBack?.();
        return true;
      default:
        return false;
    }
  }

  trapTab(e: KeyboardEvent): void {
    this.nav.trapTab(e);
  }

  /* --------------------------------------------------------------- groups */

  private buildAccessibility(panel: HTMLElement): void {
    panel.append(
      groupIntro(
        'Estos ajustes cambian cómo se siente el juego, no cuánto vale. Nada aquí te penaliza.',
        'These change how the game feels, never what it scores. Nothing here penalises you.',
      ),
      this.slider(
        'Vibración de pantalla',
        'Screen shake',
        'Cuánto sacude la cámara en choques y a alta velocidad.',
        0,
        1,
        0.05,
        (s) => s.screenShake,
        (v) => this.store.set('screenShake', v),
        percent,
      ),
      this.slider(
        'Balanceo de cámara',
        'Camera sway',
        'El cabeceo y balanceo de la cámara al derrapar.',
        0,
        1,
        0.05,
        (s) => s.cameraSway,
        (v) => this.store.set('cameraSway', v),
        percent,
      ),
      this.toggle(
        'Modo fotosensible',
        'Photosensitive safe',
        'Suprime relámpagos, destellos y parpadeos de la interfaz.',
        (s) => s.photosensitiveSafe,
        (v) => this.store.set('photosensitiveSafe', v),
      ),
      this.segmented<SettingsState['colorBlindMode']>(
        'Daltonismo',
        'Colour-blind mode',
        'Reajusta los colores de juego (destino, pasajero, combo) para que no se confundan.',
        [
          { value: 'none', label: 'Ninguno' },
          { value: 'protanopia', label: 'Protanopia' },
          { value: 'deuteranopia', label: 'Deuteranopia' },
          { value: 'tritanopia', label: 'Tritanopia' },
        ],
        (s) => s.colorBlindMode,
        (v) => this.store.set('colorBlindMode', v),
      ),
      this.toggle(
        'Subtítulos',
        'Subtitles',
        'Muestra lo que dicen los pasajeros al pie de la pantalla.',
        (s) => s.subtitles,
        (v) => this.store.set('subtitles', v),
      ),
      this.toggle(
        'Texto grande',
        'Large text',
        'Aumenta el tamaño de toda la tipografía de la interfaz.',
        (s) => s.largeText,
        (v) => this.store.set('largeText', v),
      ),
      this.toggle(
        'Alto contraste',
        'High-contrast HUD',
        'Fondos opacos y bordes más gruesos en el HUD.',
        (s) => s.highContrastHud,
        (v) => this.store.set('highContrastHud', v),
      ),
      this.segmented<boolean>(
        'Turbo',
        'Boost input',
        'Mantener pulsado, o pulsar una vez para activar y otra para apagar.',
        [
          { value: true, label: 'Mantener · Hold' },
          { value: false, label: 'Alternar · Toggle' },
        ],
        (s) => s.holdToBoost,
        (v) => this.store.set('holdToBoost', v),
      ),
      this.slider(
        'Asistencia de dirección',
        'Steering assist',
        'Contra-dirección automática al derrapar. Más alto = más perdona.',
        0,
        1,
        0.05,
        (s) => s.assistSteering,
        (v) => this.store.set('assistSteering', v),
        percent,
      ),
      this.toggle(
        'Acelerador automático',
        'Auto-accelerate',
        'El Jeep acelera solo; tú frenas y giras.',
        (s) => s.autoAccelerate,
        (v) => this.store.set('autoAccelerate', v),
      ),
      this.slider(
        'Tamaño de la interfaz',
        'UI scale',
        'Escala todo el HUD y los menús.',
        0.75,
        1.5,
        0.05,
        (s) => s.uiScale,
        (v) => this.store.set('uiScale', v),
        percent,
      ),
    );
  }

  private buildGraphics(panel: HTMLElement): void {
    panel.append(
      this.segmented<QualityTier>(
        'Calidad',
        'Quality preset',
        'Cambiar el preajuste reescribe las opciones de abajo.',
        [
          { value: 'low', label: 'Baja' },
          { value: 'medium', label: 'Media' },
          { value: 'high', label: 'Alta' },
          { value: 'ultra', label: 'Ultra' },
        ],
        (s) => s.quality,
        (v) => this.store.setQuality(v),
      ),
      this.slider(
        'Escala de render',
        'Render scale',
        'Renderiza por debajo de la resolución de pantalla y reescala.',
        0.5,
        1,
        0.05,
        (s) => s.renderScale,
        (v) => this.store.set('renderScale', v),
        percent,
      ),
      this.toggle(
        'Sombras',
        'Shadows',
        'Sombras del sol en cascada. Lo más caro del cuadro.',
        (s) => s.shadows,
        (v) => this.store.set('shadows', v),
      ),
      this.toggle(
        'Post-procesado',
        'Post-processing',
        'Cadena completa: tono, grano, viñeta, aberración.',
        (s) => s.postProcessing,
        (v) => this.store.set('postProcessing', v),
      ),
      this.toggle(
        'Bloom',
        'Bloom',
        'Halo en las luces y en el brillo del turbo.',
        (s) => s.bloom,
        (v) => this.store.set('bloom', v),
      ),
      this.toggle(
        'Desenfoque de movimiento',
        'Motion blur',
        'Nunca se aplica al centro del cuadro.',
        (s) => s.motionBlur,
        (v) => this.store.set('motionBlur', v),
      ),
      this.toggle(
        'Oclusión ambiental',
        'Ambient occlusion',
        'Sombra de contacto donde la pared toca la calle.',
        (s) => s.ssao,
        (v) => this.store.set('ssao', v),
      ),
    );
  }

  private buildAudio(panel: HTMLElement): void {
    panel.append(
      this.slider(
        'Volumen general',
        'Master volume',
        '',
        0,
        1,
        0.05,
        (s) => s.masterVolume,
        (v) => this.store.set('masterVolume', v),
        percent,
      ),
      this.slider(
        'Música',
        'Music',
        'Bomba, plena y salsa desde las ventanas abiertas.',
        0,
        1,
        0.05,
        (s) => s.musicVolume,
        (v) => this.store.set('musicVolume', v),
        percent,
      ),
      this.slider(
        'Efectos',
        'Sound effects',
        'Motor, gomas, choques, bocina y pasajeros.',
        0,
        1,
        0.05,
        (s) => s.sfxVolume,
        (v) => this.store.set('sfxVolume', v),
        percent,
      ),
    );
  }

  private buildControls(panel: HTMLElement): void {
    panel.append(
      this.toggle(
        'Invertir cámara',
        'Invert look',
        'Invierte el eje vertical de la cámara libre.',
        (s) => s.invertLook,
        (v) => this.store.set('invertLook', v),
      ),
      this.segmented<boolean>(
        'Minimapa',
        'Minimap',
        'Girar con el Jeep, o dejar el norte siempre arriba.',
        [
          { value: true, label: 'Gira · Rotates' },
          { value: false, label: 'Norte arriba · North-up' },
        ],
        (s) => s.minimapRotates,
        (v) => this.store.set('minimapRotates', v),
      ),
      this.segmented<SettingsState['showSpeedUnits']>(
        'Unidades de velocidad',
        'Speed units',
        'En Puerto Rico las distancias van en kilómetros y los límites en millas por hora.',
        [
          { value: 'mph', label: 'MPH' },
          { value: 'kmh', label: 'KM/H' },
        ],
        (s) => s.showSpeedUnits,
        (v) => this.store.set('showSpeedUnits', v),
      ),
      controlsReference(),
    );
  }

  /* -------------------------------------------------------------- widgets */

  private slider(
    es: string,
    en: string,
    hint: string,
    min: number,
    max: number,
    step: number,
    read: (s: SettingsState) => number,
    write: (v: number) => void,
    format: (v: number) => string,
  ): HTMLElement {
    const row = fieldRow(es, en, hint);
    const control = el('div', 'll-control ll-control--slider');
    const input = el('input', 'll-slider') as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', en);
    const readout = el('output', 'll-readout', '');
    control.append(input, readout);
    row.append(control);

    const paint = (v: number): void => {
      const t = (v - min) / (max - min || 1);
      control.style.setProperty('--t', t.toFixed(4));
      readout.textContent = format(v);
    };
    input.addEventListener('input', () => {
      const v = clamp(Number(input.value), min, max);
      paint(v);
      write(v);
    });

    this.refreshers.push((s) => {
      const v = clamp(read(s), min, max);
      if (Number(input.value) !== v) input.value = String(v);
      paint(v);
    });
    return row;
  }

  private toggle(
    es: string,
    en: string,
    hint: string,
    read: (s: SettingsState) => boolean,
    write: (v: boolean) => void,
  ): HTMLElement {
    const row = fieldRow(es, en, hint);
    const control = el('div', 'll-control');
    const b = el('button', 'll-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', en);
    const track = el('span', 'll-switch__track');
    track.append(el('span', 'll-switch__knob'));
    const label = el('span', 'll-switch__label', 'OFF');
    b.append(track, label);
    control.append(b);
    row.append(control);

    b.addEventListener('click', () => write(b.getAttribute('aria-checked') !== 'true'));

    this.refreshers.push((s) => {
      const on = read(s);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      label.textContent = on ? 'ON' : 'OFF';
    });
    return row;
  }

  private segmented<T extends string | boolean>(
    es: string,
    en: string,
    hint: string,
    options: Array<{ value: T; label: string }>,
    read: (s: SettingsState) => T,
    write: (v: T) => void,
  ): HTMLElement {
    const row = fieldRow(es, en, hint);
    const group = el('div', 'll-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', en);
    group.dataset.segmented = '1';
    const buttons: Array<{ node: HTMLButtonElement; value: T }> = [];

    for (const opt of options) {
      const b = el('button', 'll-seg__opt', opt.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', () => write(opt.value));
      group.append(b);
      buttons.push({ node: b, value: opt.value });
    }
    const control = el('div', 'll-control');
    control.append(group);
    row.append(control);

    this.refreshers.push((s) => {
      const current = read(s);
      for (const { node, value } of buttons) {
        const on = value === current;
        node.setAttribute('aria-checked', on ? 'true' : 'false');
        node.classList.toggle('is-on', on);
      }
    });
    return row;
  }

  dispose(): void {
    this.unmount();
    this.refreshers.length = 0;
    this.onBack = null;
  }
}

/* ------------------------------------------------------------- fragments */

const percent = (v: number): string => `${Math.round(v * 100)}%`;

function fieldRow(es: string, en: string, hint: string): HTMLElement {
  const row = el('div', 'll-row');
  const text = el('div', 'll-row__text');
  const label = el('div', 'll-row__label');
  label.append(el('span', 'll-lbl-es', es), el('span', 'll-lbl-en', en));
  text.append(label);
  if (hint) text.append(el('div', 'll-row__hint', hint));
  row.append(text);
  return row;
}

function groupIntro(es: string, en: string): HTMLElement {
  const node = el('div', 'll-intro');
  node.append(el('p', 'll-intro__es', es), el('p', 'll-intro__en', en));
  return node;
}

/** A static reference card — no rebinding, but the player can see the layout. */
function controlsReference(): HTMLElement {
  const wrap = el('div', 'll-keys');
  wrap.append(el('div', 'll-keys__title', 'MANDOS · Controls'));
  const grid = el('div', 'll-keys__grid');
  const rows: Array<[string[], string]> = [
    [['W', '↑'], 'Acelerar · Throttle'],
    [['S', '↓'], 'Frenar / atrás · Brake'],
    [['A', 'D'], 'Girar · Steer'],
    [['Space'], 'Freno de mano · Handbrake'],
    [['Shift'], 'Turbo · Boost'],
    [['H'], 'Bocina · Horn'],
    [['C'], 'Cámara · Camera'],
    [['R'], 'Reaparecer · Respawn'],
    [['Esc'], 'Pausa · Pause'],
  ];
  for (const [keys, label] of rows) {
    const r = el('div', 'll-keys__row');
    const k = el('div', 'll-keys__k');
    for (const key of keys) k.append(el('kbd', 'll-kbd', key));
    r.append(k, el('div', 'll-keys__l', label));
    grid.append(r);
  }
  wrap.append(grid);
  const pad = el('div', 'll-keys__pad');
  pad.append(padGlyph(), el('span', '', 'Gamepad: gatillos para acelerar y frenar, A confirma, B vuelve.'));
  wrap.append(pad);
  return wrap;
}

function padGlyph(): SVGSVGElement {
  const s = svg('svg', {
    viewBox: '0 0 32 20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'aria-hidden': 'true',
    class: 'll-padglyph',
  });
  s.append(
    svg('path', {
      d: 'M9 4 H23 A7 7 0 0 1 30 11 A5 5 0 0 1 21.4 14.6 L19 12 H13 L10.6 14.6 A5 5 0 0 1 2 11 A7 7 0 0 1 9 4 Z',
    }),
    svg('path', { d: 'M7.5 8.6 V11.4 M6.1 10 H8.9' }),
    svg('circle', { cx: '23.4', cy: '9', r: '1.2', fill: 'currentColor' }),
    svg('circle', { cx: '20.6', cy: '11.4', r: '1.2', fill: 'currentColor' }),
  );
  return s;
}
