/**
 * Loco Lift — the destination arrow.
 *
 * ART_REFERENCE R11 treats this as a load-bearing mechanic, not decoration:
 * screen position 68–76 % height, minimum 6 px stroke at 1280×720, `#FF2FA8`
 * with a 2 px `#0A0C10` keyline so it survives against a cream façade *and* a
 * dark alley.
 *
 * Three parts:
 *  1. the big bevelled compass arrow, rotating to the relative bearing;
 *  2. a world-anchored pin that tracks the drop-off when it is on screen and
 *     pins to the screen edge with a distance when it is not;
 *  3. a wrong-way state that takes over both.
 *
 * Rotation is damped so a twitchy heading never makes the arrow buzz, and every
 * per-frame write is a `transform` or a CSS custom property.
 */
import * as THREE from 'three';
import { clamp, wrapAngle } from '../core/MathUtils';
import { el, FlagSlot, svg, TextSlot, UITheme } from './UITheme';

export interface ArrowFrame {
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  /** the Jeep, world space */
  playerX: number;
  playerZ: number;
  /** compass heading in radians, 0 = facing −Z (the Atlantic) */
  heading: number;
  dt: number;
  rawDt: number;
}

const EDGE_MARGIN = 54;

export class DestinationArrow {
  readonly el: HTMLElement;

  private readonly theme: UITheme;
  private readonly arrow: HTMLElement;
  private readonly pin: HTMLElement;
  private readonly pinDist: TextSlot;
  private readonly wrongNode: HTMLElement;
  private readonly wrongFlag: FlagSlot;
  private readonly arrowWrong: FlagSlot;

  private readonly target = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private hasTarget = false;

  private shownAngle = 0;
  private lastDistText = -1;
  private distance = 0;
  private wrongWay = false;
  private visible = false;

  /* per-frame write caches — nothing is written unless it actually moved */
  private lastTurn = Number.NaN;
  private lastPinX = Number.NaN;
  private lastPinY = Number.NaN;
  private lastEdge: boolean | null = null;
  private lastDim: boolean | null = null;
  private pinShown = false;

  constructor(theme: UITheme) {
    this.theme = theme;
    this.el = el('div', 'll-nav');
    this.el.setAttribute('aria-hidden', 'true');

    /* the compass arrow ------------------------------------------------- */
    this.arrow = el('div', 'll-nav__arrow');
    this.arrow.append(buildArrow());
    this.arrowWrong = new FlagSlot(this.arrow, 'is-wrong');

    /* wrong-way banner -------------------------------------------------- */
    this.wrongNode = el('div', 'll-wrongway');
    const wrongEs = el('div', 'll-wrongway__es', '¡DIRECCIÓN EQUIVOCADA!');
    const wrongEn = el('div', 'll-wrongway__en', 'WRONG WAY');
    this.wrongNode.append(wrongEs, wrongEn);
    this.wrongFlag = new FlagSlot(this.wrongNode, 'is-live');

    /* world-anchored pin ------------------------------------------------ */
    this.pin = el('div', 'll-pin');
    const pinGlyph = el('div', 'll-pin__glyph');
    pinGlyph.append(buildPinDiamond());
    const pinDistEl = el('div', 'll-pin__dist', '');
    this.pin.append(pinGlyph, pinDistEl);
    this.pinDist = new TextSlot(pinDistEl);
    this.pin.style.display = 'none';

    this.el.append(this.pin, this.arrow, this.wrongNode);
    this.setVisible(false);
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  unmount(): void {
    this.el.remove();
  }

  /** Metres to the drop-off, as of the last `update`. */
  get distanceToTarget(): number {
    return this.distance;
  }

  get hasDestination(): boolean {
    return this.hasTarget;
  }

  setTarget(pos: THREE.Vector3 | null): void {
    if (!pos) {
      this.hasTarget = false;
      this.pinShown = false;
      this.pin.style.display = 'none';
      this.setVisible(false);
      return;
    }
    this.target.copy(pos);
    this.hasTarget = true;
    this.setVisible(true);
  }

  setWrongWay(on: boolean): void {
    if (on === this.wrongWay) return;
    this.wrongWay = on;
    this.wrongFlag.set(on);
    this.arrowWrong.set(on);
    if (on && !this.theme.flashSafe) {
      this.wrongNode.animate(
        [
          { transform: 'translate3d(-50%, 0, 0) scale(0.86)', opacity: 0 },
          { transform: 'translate3d(-50%, 0, 0) scale(1.04)', opacity: 1, offset: 0.55 },
          { transform: 'translate3d(-50%, 0, 0) scale(1)', opacity: 1 },
        ],
        { duration: this.theme.duration(280), easing: this.theme.ease('back') },
      );
    }
  }

  private setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('is-live', v);
  }

  /* ----------------------------------------------------------------- frame */

  update(frame: ArrowFrame): void {
    if (!this.hasTarget) return;

    const dx = this.target.x - frame.playerX;
    const dz = this.target.z - frame.playerZ;
    this.distance = Math.hypot(dx, dz);

    /* relative bearing --------------------------------------------------- */
    const bearing = Math.atan2(dx, -dz);
    const rel = wrapAngle(bearing - frame.heading);
    // damp through the shortest arc so the arrow never spins the long way round
    const delta = wrapAngle(rel - this.shownAngle);
    this.shownAngle = wrapAngle(
      this.shownAngle + delta * (1 - Math.exp(-14 * Math.max(frame.rawDt, 0.0001))),
    );
    const turnDeg = (this.shownAngle * 180) / Math.PI;
    if (!(Math.abs(turnDeg - this.lastTurn) < 0.12)) {
      this.lastTurn = turnDeg;
      // Written as `transform`, not as a `--turn` custom property. An
      // *unregistered* custom property is opaque to the style engine, so
      // Chromium cannot prove it does not feed geometry and schedules a layout
      // on every write — and this one is written on every frame the car is
      // moving. Same reasoning as `ScaleSlot` in UITheme.
      this.arrow.style.transform = `translate(-50%, -50%) rotate(${turnDeg.toFixed(2)}deg)`;
    }

    /* distance text ------------------------------------------------------ */
    const rounded = this.distance >= 1000 ? Math.round(this.distance / 100) : Math.round(this.distance / 5) * 5;
    if (rounded !== this.lastDistText) {
      this.lastDistText = rounded;
      this.pinDist.set(
        this.distance >= 1000 ? `${(this.distance / 1000).toFixed(1)} km` : `${rounded} m`,
      );
    }

    /* world pin ---------------------------------------------------------- */
    this.projected.copy(this.target);
    this.projected.y += 4.2; // float it above the drop-off, not in the road
    this.projected.project(frame.camera);

    const behind = this.projected.z > 1;
    let sx = (this.projected.x * 0.5 + 0.5) * frame.width;
    let sy = (-this.projected.y * 0.5 + 0.5) * frame.height;
    if (behind) {
      sx = frame.width - sx;
      sy = frame.height + Math.abs(frame.height - sy);
    }

    const minX = EDGE_MARGIN;
    const maxX = frame.width - EDGE_MARGIN;
    const minY = EDGE_MARGIN;
    const maxY = frame.height - EDGE_MARGIN * 1.4;
    const offscreen = behind || sx < minX || sx > maxX || sy < minY || sy > maxY;

    // Off screen, the pin orbits an ellipse around frame centre instead of
    // sticking to the viewport rectangle. Corners are where the fare panel, the
    // minimap and the passenger card live — a marker must never land there.
    let cx: number;
    let cy: number;
    if (offscreen) {
      const rx = frame.width * 0.34;
      const ry = frame.height * 0.33;
      cx = frame.width * 0.5 + Math.sin(this.shownAngle) * rx;
      cy = frame.height * 0.5 - Math.cos(this.shownAngle) * ry;
    } else {
      cx = clamp(sx, minX, maxX);
      cy = clamp(sy, minY, maxY);
    }

    if (!this.pinShown) {
      this.pinShown = true;
      this.pin.style.display = '';
    }
    // negated form on purpose: the first frame has NaN caches, and `NaN > x` is
    // false — a positive test would never write at all
    if (!(Math.abs(cx - this.lastPinX) < 0.4 && Math.abs(cy - this.lastPinY) < 0.4)) {
      this.lastPinX = cx;
      this.lastPinY = cy;
      this.pin.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
    if (offscreen !== this.lastEdge) {
      this.lastEdge = offscreen;
      this.pin.classList.toggle('is-edge', offscreen);
    }

    // The big arrow only matters when the target is not comfortably on screen.
    const dim = !offscreen && this.distance < 70;
    if (dim !== this.lastDim) {
      this.lastDim = dim;
      this.arrow.classList.toggle('is-dim', dim);
    }
  }

  dispose(): void {
    this.unmount();
  }
}

/* ------------------------------------------------------------ SVG builders */

/**
 * The arrow, built as four stacked paths so it reads as a bevelled solid rather
 * than a flat triangle: ink keyline, dark under-face, mid body, bright top.
 */
function buildArrow(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 120 132', class: 'll-nav__svg', 'aria-hidden': 'true' });
  const body = 'M60 4 L116 62 L88 62 L88 122 L32 122 L32 62 L4 62 Z';

  s.append(
    svg('path', {
      d: body,
      transform: 'translate(0, 7)',
      fill: 'rgba(6,9,13,0.55)',
      class: 'll-nav__drop',
    }),
    svg('path', { d: body, fill: 'var(--ll-ink)', transform: 'translate(0, 4)' }),
    svg('path', { d: body, fill: 'var(--nav-tone, var(--ll-dest))' }),
    svg('path', {
      d: 'M60 4 L116 62 L88 62 L88 74 L32 74 L32 62 L4 62 Z',
      fill: 'rgba(255,255,255,0.26)',
    }),
    svg('path', {
      d: body,
      fill: 'none',
      stroke: 'var(--ll-ink)',
      'stroke-width': '5',
      'stroke-linejoin': 'round',
    }),
  );
  return s;
}

/** The on-screen drop-off pin — a diamond with a hard keyline. */
function buildPinDiamond(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true' });
  s.append(
    svg('path', {
      d: 'M22 2 L42 22 L22 42 L2 22 Z',
      fill: 'var(--nav-tone, var(--ll-dest))',
      stroke: 'var(--ll-ink)',
      'stroke-width': '4',
      'stroke-linejoin': 'round',
    }),
    svg('path', { d: 'M22 8 L36 22 L22 22 Z', fill: 'rgba(255,255,255,0.3)' }),
    svg('circle', { cx: '22', cy: '22', r: '5', fill: 'var(--ll-ink)' }),
  );
  return s;
}
