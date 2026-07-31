/**
 * Loco Lift — transient notices.
 *
 * Two channels, both queued so nothing ever lands on top of anything else:
 *
 *  - **toasts** (`ui:toast`) — a stack of at most three small cards above the
 *    subtitle line. Overflow waits its turn.
 *  - **notices** (`ui:notice`) — one at a time, centre screen, `big` making it
 *    the full slab treatment. A second notice queues behind the first.
 *
 * Elements are pooled; a burst of twenty toasts allocates nothing but strings.
 */
import { el, svg, TextSlot, UITheme } from './UITheme';

interface ToastRequest {
  text: string;
  icon?: string;
  ms: number;
}

interface ToastSlot {
  node: HTMLElement;
  text: TextSlot;
  iconWrap: HTMLElement;
  life: number;
  fade: number;
  active: boolean;
}

const MAX_VISIBLE = 3;
const POOL = 4;
const DEFAULT_MS = 2400;

export class Toasts {
  readonly el: HTMLElement;

  private readonly theme: UITheme;
  private readonly stack: HTMLElement;
  private readonly slots: ToastSlot[] = [];
  private readonly queue: ToastRequest[] = [];

  private readonly noticeNode: HTMLElement;
  private readonly noticeText: TextSlot;
  private readonly noticeQueue: Array<{ text: string; big: boolean }> = [];
  private noticeLife = 0;

  constructor(theme: UITheme) {
    this.theme = theme;
    this.el = el('div', 'll-toastlayer');
    this.el.setAttribute('aria-live', 'polite');

    this.stack = el('div', 'll-toasts');
    for (let i = 0; i < POOL; i++) {
      const node = el('div', 'll-toast');
      const iconWrap = el('span', 'll-toast__icon');
      const textEl = el('span', 'll-toast__text', '');
      node.append(iconWrap, textEl);
      node.style.display = 'none';
      this.stack.append(node);
      this.slots.push({
        node,
        text: new TextSlot(textEl),
        iconWrap,
        life: 0,
        fade: 0,
        active: false,
      });
    }

    this.noticeNode = el('div', 'll-notice');
    const noticeInner = el('div', 'll-notice__text', '');
    this.noticeNode.append(noticeInner);
    this.noticeText = new TextSlot(noticeInner);

    this.el.append(this.noticeNode, this.stack);
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  unmount(): void {
    this.el.remove();
  }

  /* ---------------------------------------------------------------- input */

  push(text: string, icon?: string, ms = DEFAULT_MS): void {
    if (!text) return;
    this.queue.push({ text, icon, ms: Math.max(600, ms) });
    this.drain();
  }

  notice(text: string, big = false): void {
    if (!text) return;
    this.noticeQueue.push({ text, big });
    if (this.noticeLife <= 0) this.nextNotice();
  }

  clear(): void {
    this.queue.length = 0;
    this.noticeQueue.length = 0;
    this.noticeLife = 0;
    this.noticeNode.classList.remove('is-live');
    for (const s of this.slots) {
      s.active = false;
      s.life = 0;
      s.node.style.display = 'none';
    }
  }

  /* ---------------------------------------------------------------- frame */

  update(dt: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        s.node.style.display = 'none';
        s.node.remove();
      } else if (s.life < 0.3) {
        s.node.style.opacity = (s.life / 0.3).toFixed(2);
      }
    }
    if (this.noticeLife > 0) {
      this.noticeLife -= dt;
      if (this.noticeLife <= 0) {
        this.noticeNode.classList.remove('is-live');
        if (this.noticeQueue.length > 0) this.nextNotice();
      }
    }
    this.drain();
  }

  /* -------------------------------------------------------------- private */

  private visibleCount(): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].active) n++;
    return n;
  }

  private drain(): void {
    while (this.queue.length > 0 && this.visibleCount() < MAX_VISIBLE) {
      const req = this.queue.shift();
      if (!req) break;
      const slot = this.slots.find((s) => !s.active);
      if (!slot) break;
      slot.active = true;
      slot.life = req.ms / 1000;
      slot.text.set(req.text);
      slot.node.style.display = '';
      slot.node.style.opacity = '1';
      slot.iconWrap.replaceChildren(buildIcon(req.icon));
      this.stack.append(slot.node);
      if (!this.theme.flashSafe) {
        slot.node.animate(
          [
            { transform: 'translate3d(0, 18px, 0) scale(0.94)', opacity: 0 },
            { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
          ],
          { duration: this.theme.duration(240), easing: this.theme.ease('back') },
        );
      }
    }
  }

  private nextNotice(): void {
    const next = this.noticeQueue.shift();
    if (!next) return;
    this.noticeText.set(next.text);
    this.noticeNode.classList.toggle('is-big', next.big);
    this.noticeNode.classList.add('is-live');
    this.noticeLife = next.big ? 2.1 : 1.5;
    if (!this.theme.flashSafe) {
      this.noticeNode.animate(
        [
          { transform: 'translate3d(-50%, -50%, 0) scale(0.7)', opacity: 0 },
          { transform: 'translate3d(-50%, -50%, 0) scale(1.06)', opacity: 1, offset: 0.45 },
          { transform: 'translate3d(-50%, -50%, 0) scale(1)', opacity: 1 },
        ],
        { duration: this.theme.duration(420), easing: this.theme.ease('back') },
      );
    }
  }

  dispose(): void {
    this.clear();
    this.unmount();
  }
}

/* ------------------------------------------------------------------ icons */

/**
 * Known icon ids get an authored glyph; anything else is rendered as text, so a
 * caller passing a character still gets something sensible. No image assets.
 */
function buildIcon(id?: string): Node {
  switch (id) {
    case 'money':
    case 'fare':
      // a banknote reads at 20 px; a lone "$" stroke does not
      return glyph(
        'M2.6 5.6 H21.4 A1 1 0 0 1 22.4 6.6 V17.4 A1 1 0 0 1 21.4 18.4 H2.6 A1 1 0 0 1 1.6 17.4 V6.6 A1 1 0 0 1 2.6 5.6 Z M12 8.6 A3.4 3.4 0 1 1 12 15.4 A3.4 3.4 0 0 1 12 8.6 Z M4.8 9.2 V14.8 M19.2 9.2 V14.8',
      );
    case 'time':
      return glyph('M12 6.5 V12 L15.6 14.2 M12 3.4 A8.6 8.6 0 1 0 12 20.6 A8.6 8.6 0 0 0 12 3.4 Z');
    case 'star':
      return glyph('M12 3.6 L14.5 9.2 L20.6 9.9 L16.1 14 L17.3 20 L12 17 L6.7 20 L7.9 14 L3.4 9.9 L9.5 9.2 Z');
    case 'warn':
      return glyph('M12 3.6 L21.4 20 H2.6 Z M12 9.6 V14.2 M12 16.8 V17.4');
    case 'boost':
      return glyph('M13.4 2.6 L5 13.4 H11 L9.6 21.4 L18.6 10 H12.4 Z');
    case 'pin':
      return glyph('M12 2.6 C8.2 2.6 5.4 5.6 5.4 9.2 C5.4 14 12 21.4 12 21.4 S18.6 14 18.6 9.2 C18.6 5.6 15.8 2.6 12 2.6 Z M12 7 A2.4 2.4 0 1 1 12 11.8 A2.4 2.4 0 0 1 12 7 Z');
    default: {
      const span = document.createElement('span');
      span.className = 'll-toast__glyphtext';
      span.textContent = id ?? '•';
      return span;
    }
  }
}

function glyph(d: string): SVGSVGElement {
  const s = svg('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  s.append(svg('path', { d }));
  return s;
}
