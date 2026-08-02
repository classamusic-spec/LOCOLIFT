/**
 * Loco Lift — the in-shift speed gauge.
 *
 * A real arcade speedometer, not a progress bar with a number on it: a round
 * bezelled dial with a 270° swept scale numbered in the player's unit, a
 * green→amber→red zone ring so the top end reads as "redline", a bright value
 * arc that fills as the car accelerates, a tapered needle on a torsion spring
 * that overshoots and settles, and the digital MPH read inset under the hub —
 * the way a real cluster carries its odometer.
 *
 * It is deliberately speed-only. The HUD hands it road speed through the same
 * `setSpeed` path it always used (`UISystem` → `HUD.setSpeed` → this), plus the
 * boost/drift/air drive-state it already tracks, and nothing else. There is no
 * gear or rev plumbing to fake.
 *
 * ## Performance contract
 *
 * Runs every frame and must never cause layout. Per-frame writes are:
 *  - `transform` on the needle `<g>` (declares `will-change: transform`);
 *  - `stroke-dashoffset` on the value arc — paint only;
 *  - one cached `textContent` write on the digital readout, via `TextSlot`, so
 *    an unchanged number costs nothing;
 *  - a class toggle on the value arc when it crosses a colour zone (a handful of
 *    times per acceleration, never per frame).
 *
 * Nothing here reads a layout property; the gauge never measures itself.
 */
import { clamp01, MPS_TO_KMH, MPS_TO_MPH } from '../core/MathUtils';
import type { SettingsState } from '../core/types';
import { el, OpacitySlot, svg, TextSlot, TransformSlot, UITheme } from './UITheme';

/* ------------------------------------------------------------------ shape */

/** Dial geometry, in the SVG's own 200×200 user space. */
const CX = 100;
const CY = 100;
/** Needle sweep: 7:30 round to 4:30, the classic 270°. */
const START_DEG = -135;
const SWEEP_DEG = 270;

const R_ZONE = 87; // thin coloured reference ring, just inside the bezel
const R_VALUE = 78; // the fat value arc that fills with speed
const R_TICK = 71; // outer tick radius
const R_NUM = 55; // numeral centre radius

/** Path length of the value arc — 270° of a circle at `R_VALUE`. */
const VALUE_LEN = (2 * Math.PI * R_VALUE * SWEEP_DEG) / 360;

/** Full-scale road speed in m/s. The Jeep tops the scale; slower vehicles
 *  simply never pin the needle, exactly like a real fixed-face speedo. */
const FULL_SCALE_MPS = 62;

/** Zone boundaries as a fraction of full scale. */
const AMBER_AT = 0.62;
const RED_AT = 0.84;

/* ---------------------------------------------------------------- helpers */

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Point on the dial at scale fraction `t`, radius `r`. */
function polar(t: number, r: number): { x: number; y: number } {
  const a = rad(START_DEG + t * SWEEP_DEG - 90);
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
}

/** An arc path from fraction `t0` to `t1` at radius `r`, swept clockwise. */
function arcPath(r: number, t0 = 0, t1 = 1): string {
  const a = polar(t0, r);
  const b = polar(t1, r);
  const large = t1 - t0 > 0.5 ? 1 : 0;
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/**
 * A round number for the top of the scale, and a step that yields 5–8 labelled
 * divisions. Picked from a human ladder so the dial never reads `137`.
 */
function niceScale(maxValue: number): { max: number; step: number } {
  const ladder = [5, 10, 15, 20, 25, 30, 40, 50, 60];
  for (const step of ladder) {
    const divisions = Math.ceil(maxValue / step);
    if (divisions >= 5 && divisions <= 8) return { max: divisions * step, step };
  }
  const step = ladder[ladder.length - 1];
  return { max: Math.ceil(maxValue / step) * step, step };
}

/* ------------------------------------------------------------------ class */

export interface SpeedoInput {
  /** road speed, m/s, always >= 0 */
  speed: number;
  boosting: boolean;
  drifting: boolean;
  airborne: boolean;
}

export class Speedo {
  readonly el: HTMLElement;

  private readonly theme: UITheme;

  /* dial parts */
  private readonly needle: TransformSlot;
  private readonly valueArc: SVGPathElement;
  private readonly ticksGroup: SVGGElement;
  private readonly numeralsGroup: SVGGElement;
  private readonly boostAlpha: OpacitySlot;

  /* readouts */
  private readonly valueSlot: TextSlot;
  private readonly unitSlot: TextSlot;

  /* state */
  private units: SettingsState['showSpeedUnits'] = 'mph';
  private scaleMax = 140;

  private needlePos = 0;
  private needleVel = 0;
  private lastArcT = Number.NaN;
  private lastZone = -1;
  /** > 0 while the power-on self-test sweep is running; NaN once it is done. */
  private sweepT = 1.0;
  private started = false;

  constructor(theme: UITheme) {
    this.theme = theme;

    const root = el('div', 'll-speedo');
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', 'Speed');
    this.el = root;

    const wrap = el('div', 'll-speedo__gauge');

    const dial = svg('svg', { viewBox: '0 0 200 200', class: 'll-dial', 'aria-hidden': 'true' });

    /* --------------------------------------------------------------- defs */
    const defs = svg('defs');
    const faceGrad = svg('radialGradient', { id: 'llFace', cx: '50%', cy: '36%', r: '78%' });
    faceGrad.append(
      svg('stop', { offset: '0', 'stop-color': '#173442' }),
      svg('stop', { offset: '0.55', 'stop-color': '#0C1D28' }),
      svg('stop', { offset: '1', 'stop-color': '#04090F' }),
    );
    const bezelGrad = svg('linearGradient', { id: 'llBezel', x1: '0', y1: '0', x2: '0', y2: '1' });
    bezelGrad.append(
      svg('stop', { offset: '0', 'stop-color': '#3A4B58' }),
      svg('stop', { offset: '0.5', 'stop-color': '#141E27' }),
      svg('stop', { offset: '1', 'stop-color': '#2A3742' }),
    );
    const valGrad = svg('linearGradient', { id: 'llVal', x1: '0', y1: '1', x2: '0', y2: '0' });
    valGrad.append(
      svg('stop', { offset: '0', 'stop-color': '#7BE9FF' }),
      svg('stop', { offset: '1', 'stop-color': '#E8FBFF' }),
    );
    defs.append(faceGrad, bezelGrad, valGrad);
    dial.append(defs);

    /* face + bezel */
    dial.append(
      svg('circle', { cx: '100', cy: '100', r: '99', fill: '#04070B' }),
      svg('circle', { cx: '100', cy: '100', r: '96', fill: 'url(#llBezel)' }),
      svg('circle', { cx: '100', cy: '100', r: '90', fill: 'url(#llFace)' }),
      svg('circle', {
        cx: '100',
        cy: '100',
        r: '90',
        fill: 'none',
        stroke: 'rgba(255,246,232,0.12)',
        'stroke-width': '1.4',
      }),
    );

    /* coloured zone reference ring (green → amber → red redline) */
    const zones = svg('g', { class: 'll-dial__zones' });
    zones.append(
      svg('path', {
        d: arcPath(R_ZONE, 0, AMBER_AT),
        fill: 'none',
        stroke: '#28D17C',
        'stroke-width': '4',
      }),
      svg('path', {
        d: arcPath(R_ZONE, AMBER_AT, RED_AT),
        fill: 'none',
        stroke: '#FFB020',
        'stroke-width': '4',
      }),
      svg('path', {
        d: arcPath(R_ZONE, RED_AT, 1),
        fill: 'none',
        stroke: 'var(--ll-danger)',
        'stroke-width': '4',
      }),
    );
    dial.append(zones);

    /* value arc: dark track + a bright fill driven by stroke-dashoffset */
    dial.append(
      svg('path', {
        d: arcPath(R_VALUE),
        fill: 'none',
        stroke: 'rgba(3,8,13,0.7)',
        'stroke-width': '9',
        'stroke-linecap': 'round',
      }),
    );
    const arc = svg('path', {
      d: arcPath(R_VALUE),
      fill: 'none',
      stroke: 'url(#llVal)',
      'stroke-width': '8',
      'stroke-linecap': 'round',
      class: 'll-dial__fill',
    });
    arc.setAttribute('stroke-dasharray', `${VALUE_LEN.toFixed(2)}`);
    arc.style.strokeDashoffset = `${VALUE_LEN.toFixed(2)}px`;
    this.valueArc = arc;
    dial.append(arc);

    /* ticks + numerals, rebuilt on any unit change */
    this.ticksGroup = svg('g', { class: 'll-dial__ticks' });
    this.numeralsGroup = svg('g', { class: 'll-dial__nums' });
    dial.append(this.ticksGroup, this.numeralsGroup);

    /* boost halo */
    const boost = svg('g', { class: 'll-dial__boost' });
    boost.append(
      svg('circle', {
        cx: '100',
        cy: '100',
        r: '92',
        fill: 'none',
        stroke: 'var(--ll-pickup)',
        'stroke-width': '4',
      }),
    );
    boost.style.opacity = '0';
    this.boostAlpha = new OpacitySlot(boost, 0.02);
    dial.append(boost);

    /* needle: a tapered blade with a counterweight, pivoting on the hub */
    const needleGroup = svg('g', { class: 'll-dial__needle' });
    needleGroup.append(
      svg('path', {
        d: 'M100 22 L104.2 100 L100 113 L95.8 100 Z',
        fill: 'var(--ll-danger)',
        stroke: '#FFF6E8',
        'stroke-width': '1.3',
        'stroke-linejoin': 'round',
      }),
      svg('circle', { cx: '100', cy: '110', r: '6.5', fill: 'var(--ll-danger)' }),
    );
    this.needle = new TransformSlot(needleGroup);
    dial.append(needleGroup);

    /* hub cap */
    dial.append(
      svg('circle', {
        cx: '100',
        cy: '100',
        r: '10',
        fill: '#0E1D28',
        stroke: '#FFF6E8',
        'stroke-width': '2.4',
      }),
      svg('circle', { cx: '100', cy: '100', r: '3', fill: 'rgba(255,246,232,0.55)' }),
    );

    wrap.append(dial);

    /* -------------------------------------------------- digital readout */
    // Inset under the hub, in the open bottom of the 270° face — where a real
    // cluster carries its odometer.
    const readout = el('div', 'll-speedo__readout');
    const value = el('span', 'll-speedo__value', '0');
    const unit = el('span', 'll-speedo__unit', 'MPH');
    readout.append(value, unit);
    this.valueSlot = new TextSlot(value);
    this.unitSlot = new TextSlot(unit);
    wrap.append(readout);

    root.append(wrap);

    this.rebuildScale();
  }

  /* ------------------------------------------------------------- settings */

  applySettings(s: SettingsState): void {
    if (s.showSpeedUnits === this.units) return;
    this.units = s.showSpeedUnits;
    this.rebuildScale();
  }

  /* ---------------------------------------------------------------- frame */

  update(input: SpeedoInput, dt: number): void {
    const speed = Math.max(0, input.speed);
    const factor = this.units === 'kmh' ? MPS_TO_KMH : MPS_TO_MPH;
    const shown = speed * factor;

    /* needle -------------------------------------------------------------- */
    let target = clamp01(shown / this.scaleMax);

    // A one-shot power-on sweep the first time the gauge is driven, the way an
    // arcade cabinet flicks the needle to full and back when you drop a coin.
    if (!this.started) {
      this.started = true;
      this.sweepT = this.theme.flashSafe ? Number.NaN : 1.0;
    }
    if (this.sweepT > 0) {
      this.sweepT -= dt;
      const p = clamp01(1 - this.sweepT);
      target = p < 0.5 ? p * 2 : (1 - p) * 2;
      if (this.sweepT <= 0) this.sweepT = Number.NaN;
    }

    // A torsion spring. Underdamped on purpose: a needle that slides to its
    // value reads as a progress bar, one that overshoots and settles reads as a
    // machine with a moving part in it. Motion suppression damps it flat.
    const stiff = this.theme.flashSafe ? 140 : 250;
    const damp = this.theme.flashSafe ? 24 : 14;
    const steps = Math.min(6, Math.max(1, Math.ceil(dt / 0.012)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.needleVel += (target - this.needlePos) * stiff * h;
      this.needleVel -= this.needleVel * damp * h;
      this.needlePos += this.needleVel * h;
    }
    if (this.needlePos < -0.04) {
      this.needlePos = -0.04;
      this.needleVel = 0;
    } else if (this.needlePos > 1.06) {
      this.needlePos = 1.06;
      this.needleVel = 0;
    }
    this.needle.rotate(START_DEG + this.needlePos * SWEEP_DEG, 2);

    /* value arc ----------------------------------------------------------- */
    const arcT = clamp01(this.needlePos);
    if (!(Math.abs(arcT - this.lastArcT) < 0.003)) {
      this.lastArcT = arcT;
      this.valueArc.style.strokeDashoffset = `${(VALUE_LEN * (1 - arcT)).toFixed(2)}px`;
      // Recolour the fill only when it crosses a zone boundary — a couple of
      // times per acceleration, never per frame.
      const zone = arcT >= RED_AT ? 2 : arcT >= AMBER_AT ? 1 : 0;
      if (zone !== this.lastZone) {
        this.lastZone = zone;
        this.valueArc.classList.toggle('is-mid', zone === 1);
        this.valueArc.classList.toggle('is-hi', zone === 2);
      }
    }

    /* drive state --------------------------------------------------------- */
    this.el.classList.toggle('is-drifting', input.drifting);
    this.el.classList.toggle('is-airborne', input.airborne);
    this.el.classList.toggle('is-boosting', input.boosting);
    this.boostAlpha.set(input.boosting ? 1 : 0);

    /* readout ------------------------------------------------------------- */
    this.valueSlot.set(String(Math.round(shown)));
  }

  /* --------------------------------------------------------------- visual */

  /**
   * Rebuild ticks and numerals for the current unit. Called only on a settings
   * change — never per frame — so the DOM churn here is irrelevant, and it buys
   * a dial whose numbers are real.
   */
  private rebuildScale(): void {
    const factor = this.units === 'kmh' ? MPS_TO_KMH : MPS_TO_MPH;
    const { max, step } = niceScale(FULL_SCALE_MPS * factor);
    this.scaleMax = max;
    this.unitSlot.set(this.units === 'kmh' ? 'KM/H' : 'MPH');

    const ticks = this.ticksGroup;
    const nums = this.numeralsGroup;
    ticks.replaceChildren();
    nums.replaceChildren();

    const majors = Math.round(max / step);
    const minorsPer = majors <= 6 ? 4 : 2;
    const total = majors * minorsPer;

    for (let i = 0; i <= total; i++) {
      const t = i / total;
      const major = i % minorsPer === 0;
      const rOuter = R_TICK;
      const rInner = rOuter - (major ? 11 : 5.5);
      const a = polar(t, rOuter);
      const b = polar(t, rInner);
      const redline = t >= RED_AT;
      ticks.append(
        svg('path', {
          d: `M${a.x.toFixed(2)} ${a.y.toFixed(2)} L${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
          stroke: redline ? 'var(--ll-danger)' : 'rgba(255,246,232,0.66)',
          'stroke-width': major ? '2.8' : '1.4',
          'stroke-linecap': 'round',
        }),
      );
      if (!major) continue;
      const p = polar(t, R_NUM);
      const label = svg('text', {
        x: p.x.toFixed(2),
        y: p.y.toFixed(2),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': '13',
        'font-weight': '800',
        fill: redline ? 'var(--ll-danger)' : 'rgba(255,246,232,0.82)',
      });
      label.textContent = String(Math.round(t * max));
      nums.append(label);
    }
    this.lastArcT = Number.NaN;
  }

  dispose(): void {
    this.el.remove();
  }
}
