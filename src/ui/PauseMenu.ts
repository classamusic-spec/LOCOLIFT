/**
 * Loco Lift — pause menu.
 *
 * A modal dialog with a real focus trap: while it is mounted, Tab cannot escape
 * it, Escape resumes, and the shift readout behind it stays visible but dimmed
 * so the player keeps their bearings.
 */
import { el, formatClock, formatInt, MenuNavigator, svg, TextSlot, UITheme } from './UITheme';
import type { NavAction, NavigableScreen } from './UITheme';

export interface PauseStats {
  score: number;
  fares: number;
  timeRemaining: number;
  bestCombo: number;
}

export class PauseMenu implements NavigableScreen {
  readonly el: HTMLElement;

  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onQuit: (() => void) | null = null;

  private readonly theme: UITheme;
  private readonly nav: MenuNavigator;
  private readonly dialog: HTMLElement;
  private readonly scoreSlot: TextSlot;
  private readonly fareSlot: TextSlot;
  private readonly timeSlot: TextSlot;
  private readonly comboSlot: TextSlot;
  private lastFocus: HTMLElement | null = null;

  constructor(theme: UITheme) {
    this.theme = theme;

    const root = el('div', 'll-screen ll-pause');
    this.el = root;

    const scrim = el('div', 'll-pause__scrim');

    const dialog = el('div', 'll-panel ll-pause__dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Paused');
    this.dialog = dialog;

    const head = el('div', 'll-pause__head');
    const title = el('h2', 'll-pause__title', 'PAUSA');
    const sub = el('div', 'll-pause__sub', 'Paused');
    head.append(title, sub);

    const stats = el('div', 'll-pause__stats');
    const score = statBlock('TARIFA', 'Fare', '$0');
    const fares = statBlock('CARRERAS', 'Fares', '0');
    const time = statBlock('TIEMPO', 'Time', '0 s');
    const combo = statBlock('COMBO MÁX', 'Best', '×1');
    stats.append(score.node, fares.node, time.node, combo.node);
    this.scoreSlot = score.slot;
    this.fareSlot = fares.slot;
    this.timeSlot = time.slot;
    this.comboSlot = combo.slot;

    const actions = el('div', 'll-pause__actions');
    actions.append(
      this.button('CONTINUAR', 'Resume', 'primary', true, () => this.onResume?.()),
      this.button('REINICIAR TURNO', 'Restart shift', 'ghost', false, () => this.onRestart?.()),
      this.button('AJUSTES', 'Settings', 'ghost', false, () => this.onSettings?.()),
      this.button('SALIR AL TÍTULO', 'Quit to title', 'danger', false, () => this.onQuit?.()),
    );

    const hint = el('div', 'll-pause__hint');
    hint.append(el('kbd', 'll-kbd', 'Esc'), el('span', '', 'para seguir manejando'));

    dialog.append(head, stats, actions, hint);
    root.append(scrim, dialog);

    scrim.addEventListener('click', () => this.onResume?.());
    this.nav = new MenuNavigator(dialog);
  }

  mount(parent: HTMLElement): void {
    this.lastFocus = document.activeElement as HTMLElement | null;
    parent.append(this.el);
    if (!this.theme.flashSafe) {
      this.dialog.animate(
        [
          { transform: 'translate3d(0, 26px, 0) scale(0.96)', opacity: 0 },
          { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
        ],
        { duration: this.theme.duration(240), easing: this.theme.ease('back') },
      );
    }
    this.focusFirst();
  }

  unmount(): void {
    this.el.remove();
    if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
    this.lastFocus = null;
  }

  setStats(s: PauseStats): void {
    this.scoreSlot.set(`$${formatInt(s.score)}`);
    this.fareSlot.set(formatInt(s.fares));
    this.timeSlot.set(s.timeRemaining < 60 ? `${formatClock(s.timeRemaining)} s` : formatClock(s.timeRemaining));
    this.comboSlot.set(`×${Math.max(1, Math.round(s.bestCombo))}`);
  }

  focusFirst(): void {
    this.nav.focusFirst();
  }

  handleNav(action: NavAction): boolean {
    switch (action) {
      case 'up':
        return this.nav.move(-1);
      case 'down':
        return this.nav.move(1);
      case 'left':
        return this.nav.adjustFocused(-1);
      case 'right':
        return this.nav.adjustFocused(1);
      case 'confirm': {
        const active = document.activeElement as HTMLElement | null;
        if (active && this.dialog.contains(active)) {
          active.click();
          return true;
        }
        return false;
      }
      case 'back':
        this.onResume?.();
        return true;
      default:
        return false;
    }
  }

  trapTab(e: KeyboardEvent): void {
    this.nav.trapTab(e);
  }

  private button(
    es: string,
    en: string,
    tone: 'primary' | 'ghost' | 'danger',
    autofocus: boolean,
    onClick: () => void,
  ): HTMLButtonElement {
    const b = el('button', `ll-btn ll-btn--${tone} ll-btn--row`);
    b.type = 'button';
    if (autofocus) b.dataset.autofocus = '1';
    b.append(el('span', 'll-btn__es', es), el('span', 'll-btn__en', en));
    const chev = svg('svg', {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '3',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: 'll-btn__chev',
      'aria-hidden': 'true',
    });
    chev.append(svg('path', { d: 'M9 5 L16 12 L9 19' }));
    b.append(chev);
    b.setAttribute('aria-label', en);
    b.addEventListener('click', onClick);
    return b;
  }

  dispose(): void {
    this.unmount();
    this.onResume = null;
    this.onRestart = null;
    this.onSettings = null;
    this.onQuit = null;
  }
}

function statBlock(es: string, en: string, initial: string): { node: HTMLElement; slot: TextSlot } {
  const node = el('div', 'll-statblock');
  const value = el('div', 'll-statblock__v', initial);
  const label = el('div', 'll-statblock__l');
  label.append(el('span', 'll-lbl-es', es), el('span', 'll-lbl-en', en));
  node.append(value, label);
  return { node, slot: new TextSlot(value) };
}
