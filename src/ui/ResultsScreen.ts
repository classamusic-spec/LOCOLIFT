/**
 * Loco Lift — end-of-shift results.
 *
 * The payoff screen. Rows land one at a time, each number counting up rather
 * than appearing, then the total slams in, then the stars pop, then the records
 * and the bank. Confirm at any point fast-forwards the whole timeline — an
 * arcade results screen that cannot be skipped is a bad arcade results screen.
 *
 * The stage timeline collapses to a fraction of its length when motion is
 * suppressed (`photosensitiveSafe` or `prefers-reduced-motion`), so the screen
 * still *stages* — it just does it in a quarter of a second, without scale pops.
 */
import { clamp01 } from '../core/MathUtils';
import type { GameMode } from '../core/types';
import {
  el,
  formatInt,
  MenuNavigator,
  svg,
  TextSlot,
  UITheme,
  type NavAction,
  type NavigableScreen,
} from './UITheme';

export interface ResultsBreakdown {
  base: number;
  distanceBonus: number;
  timeBonus: number;
  comboBonus: number;
  tip: number;
}

export interface ResultsData {
  mode: GameMode;
  /** number of completed fares */
  fares: number;
  /** 0..5 */
  rating: number;
  /** flavour text, e.g. "¡Brutal!" */
  grade: string;
  breakdown: ResultsBreakdown;
  total: number;
  bestCombo: number;
  cashBanked: number;
  bankTotal: number;
  records: Array<{ label: string; value: string }>;
}

const MODE_ES: Record<GameMode, string> = {
  arcade: 'TURNO ARCADE',
  freeRide: 'PASEO LIBRE',
  story: 'HISTORIA',
  challenge: 'RETOS',
};

interface TallyRow {
  node: HTMLElement;
  slot: TextSlot;
  target: number;
  shown: number;
  at: number;
  prefix: string;
}

const STAGE_ROW = 0.3;
const STAGE_TOTAL = 1.85;
const STAGE_STARS = 2.25;
const STAGE_RECORDS = 3.35;
const STAGE_ACTIONS = 3.7;

export class ResultsScreen implements NavigableScreen {
  readonly el: HTMLElement;

  onAgain: (() => void) | null = null;
  onGarage: (() => void) | null = null;
  onTitle: (() => void) | null = null;

  private readonly theme: UITheme;
  private readonly nav: MenuNavigator;
  private readonly rows: TallyRow[] = [];
  private readonly stars: SVGSVGElement[] = [];
  private readonly totalSlot: TextSlot;
  private readonly totalNode: HTMLElement;
  private readonly gradeSlot: TextSlot;
  private readonly modeSlot: TextSlot;
  private readonly faresSlot: TextSlot;
  private readonly comboSlot: TextSlot;
  private readonly bankSlot: TextSlot;
  private readonly bankedSlot: TextSlot;
  private readonly starsNode: HTMLElement;
  private readonly recordsNode: HTMLElement;
  private readonly actionsNode: HTMLElement;
  private readonly dialog: HTMLElement;

  private t = 0;
  private data: ResultsData | null = null;
  private totalTarget = 0;
  private totalShown = 0;
  private finished = false;
  private focusedActions = false;

  constructor(theme: UITheme) {
    this.theme = theme;

    const root = el('div', 'll-screen ll-results');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Shift results');
    this.el = root;
    root.append(el('div', 'll-results__scrim'));

    const dialog = el('div', 'll-panel ll-results__panel');
    this.dialog = dialog;

    /* head --------------------------------------------------------------- */
    const head = el('div', 'll-results__head');
    const kicker = el('div', 'll-results__kicker', '');
    const title = el('h2', 'll-results__title', 'FIN DEL TURNO');
    const sub = el('div', 'll-results__sub', 'Shift complete');
    head.append(kicker, title, sub);
    this.modeSlot = new TextSlot(kicker);

    /* tally -------------------------------------------------------------- */
    const tally = el('div', 'll-tally');
    const push = (es: string, en: string, at: number, prefix = '$'): void => {
      const row = el('div', 'll-tally__row');
      const label = el('div', 'll-tally__label');
      label.append(el('span', 'll-lbl-es', es), el('span', 'll-lbl-en', en));
      const value = el('div', 'll-tally__value', `${prefix}0`);
      row.append(label, value);
      tally.append(row);
      this.rows.push({ node: row, slot: new TextSlot(value), target: 0, shown: 0, at, prefix });
    };
    push('TARIFA BASE', 'Base fares', 0);
    push('DISTANCIA', 'Distance', STAGE_ROW);
    push('TIEMPO', 'Time bonus', STAGE_ROW * 2);
    push('COMBO', 'Combo bonus', STAGE_ROW * 3);
    push('PROPINAS', 'Tips', STAGE_ROW * 4);

    const totalRow = el('div', 'll-total');
    const totalLabel = el('div', 'll-total__label');
    totalLabel.append(el('span', 'll-lbl-es', 'TOTAL'), el('span', 'll-lbl-en', 'Total'));
    const totalValue = el('div', 'll-total__value', '$0');
    totalRow.append(totalLabel, totalValue);
    this.totalNode = totalRow;
    this.totalSlot = new TextSlot(totalValue);

    /* stars + grade ------------------------------------------------------ */
    const starsWrap = el('div', 'll-stars');
    starsWrap.setAttribute('role', 'img');
    for (let i = 0; i < 5; i++) {
      const star = buildStar();
      star.classList.add('ll-star');
      starsWrap.append(star);
      this.stars.push(star);
    }
    this.starsNode = starsWrap;
    const grade = el('div', 'll-results__grade', '');
    this.gradeSlot = new TextSlot(grade);

    /* meta --------------------------------------------------------------- */
    const meta = el('div', 'll-results__meta');
    const fares = metaChip('CARRERAS', 'Fares');
    const combo = metaChip('MEJOR COMBO', 'Best');
    const banked = metaChip('AL BANCO', 'Banked');
    const bank = metaChip('BANCO TOTAL', 'Total');
    meta.append(fares.node, combo.node, banked.node, bank.node);
    this.faresSlot = fares.slot;
    this.comboSlot = combo.slot;
    this.bankedSlot = banked.slot;
    this.bankSlot = bank.slot;

    /* records ------------------------------------------------------------ */
    const records = el('div', 'll-records');
    this.recordsNode = records;

    /* actions ------------------------------------------------------------ */
    const actions = el('div', 'll-results__actions');
    const actionHint = el('div', 'll-results__hint');
    actionHint.append(
      el('kbd', 'll-kbd', '↵'),
      el('span', '', 'para volver a la calle'),
      el('kbd', 'll-kbd', 'Esc'),
      el('span', '', 'al título'),
    );
    actions.append(actionHint);
    actions.append(
      this.button('OTRO TURNO', 'Drive again', 'primary', true, () => this.onAgain?.()),
      this.button('GARAJE', 'Garage', 'ghost', false, () => this.onGarage?.()),
      this.button('TÍTULO', 'Title', 'ghost', false, () => this.onTitle?.()),
    );
    this.actionsNode = actions;

    const left = el('div', 'll-results__left');
    left.append(head, tally, totalRow);
    const right = el('div', 'll-results__right');
    right.append(starsWrap, grade, meta, records);

    const grid = el('div', 'll-results__grid');
    grid.append(left, right);
    dialog.append(grid, actions);
    root.append(dialog);

    this.nav = new MenuNavigator(actions);
  }

  /* ------------------------------------------------------------ lifecycle */

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    if (!this.theme.flashSafe) {
      this.dialog.animate(
        [
          { transform: 'translate3d(0, 34px, 0) scale(0.97)', opacity: 0 },
          { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
        ],
        { duration: this.theme.duration(320), easing: this.theme.ease('back') },
      );
    }
  }

  unmount(): void {
    this.el.remove();
  }

  /** Feed the screen and restart its timeline. */
  show(data: ResultsData): void {
    this.data = data;
    this.t = 0;
    this.finished = false;
    this.focusedActions = false;

    this.modeSlot.set(`${MODE_ES[data.mode]} · ${data.fares} ${data.fares === 1 ? 'carrera' : 'carreras'}`);
    this.gradeSlot.set(data.grade || '');
    this.faresSlot.set(formatInt(data.fares));
    this.comboSlot.set(`×${Math.max(1, Math.round(data.bestCombo))}`);
    this.bankedSlot.set(`$${formatInt(data.cashBanked)}`);
    this.bankSlot.set(`$${formatInt(data.bankTotal)}`);

    const b = data.breakdown;
    const targets = [b.base, b.distanceBonus, b.timeBonus, b.comboBonus, b.tip];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      row.target = targets[i] ?? 0;
      row.shown = 0;
      row.node.classList.remove('is-in');
      row.slot.set(`${row.prefix}0`);
    }
    this.totalTarget = data.total;
    this.totalShown = 0;
    this.totalSlot.set('$0');
    this.totalNode.classList.remove('is-in');
    this.starsNode.classList.remove('is-in');
    for (let i = 0; i < this.stars.length; i++) {
      this.stars[i].classList.remove('is-lit');
      this.stars[i].style.opacity = '0';
    }
    this.recordsNode.replaceChildren();
    this.recordsNode.classList.remove('is-in');
    for (const rec of data.records) {
      const node = el('div', 'll-record');
      node.append(
        el('span', 'll-record__flag', '¡RÉCORD!'),
        el('span', 'll-record__label', rec.label),
        el('span', 'll-record__value', rec.value),
      );
      this.recordsNode.append(node);
    }
    this.actionsNode.classList.remove('is-in');
  }

  /* ---------------------------------------------------------------- frame */

  update(dt: number): void {
    if (!this.data) return;
    const speed = this.theme.flashSafe ? 4 : 1;
    this.t += dt * speed;

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (this.t < row.at) continue;
      if (!row.node.classList.contains('is-in')) {
        row.node.classList.add('is-in');
        row.node.style.setProperty('--delay', '0ms');
      }
      if (row.shown !== row.target) {
        row.shown = approach(row.shown, row.target, dt * speed);
        row.slot.set(`${row.prefix}${formatInt(row.shown)}`);
      }
    }

    if (this.t >= STAGE_TOTAL) {
      if (!this.totalNode.classList.contains('is-in')) {
        this.totalNode.classList.add('is-in');
        this.punch(this.totalNode);
      }
      if (this.totalShown !== this.totalTarget) {
        this.totalShown = approach(this.totalShown, this.totalTarget, dt * speed * 1.4);
        this.totalSlot.set(`$${formatInt(this.totalShown)}`);
      }
    }

    if (this.t >= STAGE_STARS) {
      const rating = clamp01(this.data.rating / 5) * 5;
      for (let i = 0; i < this.stars.length; i++) {
        const at = STAGE_STARS + i * 0.17;
        const star = this.stars[i];
        if (this.t < at || star.style.opacity === '1') continue;
        star.style.opacity = '1';
        if (i < Math.round(rating)) {
          star.classList.add('is-lit');
          this.punch(star, 1.5);
        }
      }
      this.starsNode.classList.add('is-in');
    }

    if (this.t >= STAGE_RECORDS) this.recordsNode.classList.add('is-in');

    if (this.t >= STAGE_ACTIONS) {
      this.actionsNode.classList.add('is-in');
      if (!this.focusedActions) {
        this.focusedActions = true;
        this.finished = true;
        this.nav.focusFirst();
      }
    }
  }

  /** Jump to the end of the reveal. */
  finish(): void {
    if (!this.data) return;
    this.t = STAGE_ACTIONS + 1;
    for (const row of this.rows) {
      row.shown = row.target;
      row.slot.set(`${row.prefix}${formatInt(row.target)}`);
      row.node.classList.add('is-in');
    }
    this.totalShown = this.totalTarget;
    this.totalSlot.set(`$${formatInt(this.totalTarget)}`);
    this.totalNode.classList.add('is-in');
    for (let i = 0; i < this.stars.length; i++) {
      this.stars[i].style.opacity = '1';
      this.stars[i].classList.toggle('is-lit', i < Math.round(clamp01(this.data.rating / 5) * 5));
    }
    this.starsNode.classList.add('is-in');
    this.recordsNode.classList.add('is-in');
    this.actionsNode.classList.add('is-in');
    if (!this.focusedActions) {
      this.focusedActions = true;
      this.finished = true;
      this.nav.focusFirst();
    }
  }

  get isComplete(): boolean {
    return this.finished;
  }

  focusFirst(): void {
    this.nav.focusFirst();
  }

  handleNav(action: NavAction): boolean {
    if (!this.finished && (action === 'confirm' || action === 'back')) {
      this.finish();
      return true;
    }
    switch (action) {
      case 'up':
      case 'left':
        return this.nav.move(-1);
      case 'down':
      case 'right':
        return this.nav.move(1);
      case 'confirm': {
        const active = document.activeElement as HTMLElement | null;
        if (active && this.el.contains(active)) {
          active.click();
          return true;
        }
        return false;
      }
      case 'back':
        this.onTitle?.();
        return true;
      default:
        return false;
    }
  }

  trapTab(e: KeyboardEvent): void {
    this.nav.trapTab(e);
  }

  private punch(node: Element, strength = 1): void {
    if (this.theme.flashSafe) return;
    node.animate(
      [
        { transform: `scale(${1 + 0.22 * strength})`, offset: 0 },
        { transform: 'scale(0.97)', offset: 0.55 },
        { transform: 'scale(1)', offset: 1 },
      ],
      { duration: this.theme.duration(360), easing: this.theme.ease('back') },
    );
  }

  private button(
    es: string,
    en: string,
    tone: 'primary' | 'ghost',
    autofocus: boolean,
    onClick: () => void,
  ): HTMLButtonElement {
    const b = el('button', `ll-btn ll-btn--${tone}`);
    b.type = 'button';
    if (autofocus) b.dataset.autofocus = '1';
    b.append(el('span', 'll-btn__es', es), el('span', 'll-btn__en', en));
    b.setAttribute('aria-label', en);
    b.addEventListener('click', onClick);
    return b;
  }

  dispose(): void {
    this.unmount();
    this.onAgain = null;
    this.onGarage = null;
    this.onTitle = null;
  }
}

/* -------------------------------------------------------------- fragments */

/** Ease a counter toward its target; always lands exactly. */
function approach(shown: number, target: number, dt: number): number {
  const diff = target - shown;
  if (Math.abs(diff) < 1) return target;
  const step = Math.max(Math.abs(diff) * 6 * dt, 60 * dt);
  return Math.abs(diff) <= step ? target : shown + Math.sign(diff) * step;
}

function metaChip(es: string, en: string): { node: HTMLElement; slot: TextSlot } {
  const node = el('div', 'll-metachip');
  const value = el('div', 'll-metachip__v', '—');
  const label = el('div', 'll-metachip__l');
  label.append(el('span', 'll-lbl-es', es), el('span', 'll-lbl-en', en));
  node.append(value, label);
  return { node, slot: new TextSlot(value) };
}

function buildStar(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' });
  s.append(
    svg('path', {
      d: 'M24 3 L30.4 17.6 L46 19.2 L34.2 29.8 L37.6 45 L24 37.2 L10.4 45 L13.8 29.8 L2 19.2 L17.6 17.6 Z',
      stroke: 'var(--ll-ink)',
      'stroke-width': '3.4',
      'stroke-linejoin': 'round',
      class: 'll-star__path',
    }),
  );
  return s;
}
