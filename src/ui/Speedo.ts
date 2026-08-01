/**
 * Loco Lift — the speed gauge.
 *
 * A real arcade tachometer, not a progress bar with a number on it: a round
 * dial with a bezel, a 270° swept scale with numerals in the player's chosen
 * unit, a rev ring that runs ahead of the needle and slams back on every gear
 * change, a redline zone that flares when the engine is up against it, a needle
 * on a spring that overshoots and settles, and a gear (or gait) badge.
 *
 * ## Vehicles
 *
 * Three drivable things share this gauge and it adapts to all three off
 * `vehicleId`:
 *
 *  - **jeep / bus** — full scale from the roster, `gear` 1..5 (`R` reversing),
 *    `engineRpmNorm` is engine revs, redline at 0.86 of the ring.
 *  - **carriage** — a Paso Fino in harness. `gear` 1..3 is *walk · trot ·
 *    canter*, so the badge reads `PASO · TROTE · GALOPE` under an `AIRE`
 *    (gait) label rather than `CAMBIO` (gear), and `engineRpmNorm` is stride
 *    rate, so the "redline" is the horse flat out. The animal is not a machine
 *    and the gauge should not claim it is.
 *
 * ## Performance contract
 *
 * Runs every frame and must never cause layout. Per-frame writes are:
 *  - `transform` on the needle `<g>` and on the dial wrapper (both declare
 *    `will-change: transform`);
 *  - `stroke-dashoffset` on two arcs — paint only;
 *  - `opacity` on the redline and boost overlays;
 *  - one **registered** `<number>` custom property (`--heat`), declared with
 *    `@property` in `styles.css` and consumed only by colour and box-shadow.
 *
 * Text is written through `TextSlot`, so an unchanged readout costs nothing.
 * Nothing here reads a layout property; the gauge never measures itself.
 */
import { clamp, clamp01, lerp, MPS_TO_KMH, MPS_TO_MPH } from '../core/MathUtils';
import type { SettingsState } from '../core/types';
import { i18n, type StringKey } from './i18n';
import {
  el,
  FlagSlot,
  NumSlot,
  OpacitySlot,
  svg,
  TextSlot,
  TransformSlot,
  UITheme,
} from './UITheme';

/* ------------------------------------------------------------------ shape */

/** Dial geometry, in the SVG's own 200×200 user space. */
const CX = 100;
const CY = 100;
/** Needle sweep: 7:30 round to 4:30, the classic 270°. */
const START_DEG = -135;
const SWEEP_DEG = 270;
const R_SCALE = 82;
const R_REV = 70;
/** Path length of the scale arc at `R_SCALE` — 270° of a circle. */
const SCALE_LEN = (2 * Math.PI * R_SCALE * SWEEP_DEG) / 360;
const REV_LEN = (2 * Math.PI * R_REV * SWEEP_DEG) / 360;
/** Fraction of the rev ring that counts as redline. */
const REDLINE_AT = 0.86;

/** Full-scale road speed in m/s per vehicle. Sets what the numerals say. */
const FULL_SCALE_MPS: Record<string, number> = {
  jeep: 62,
  bus: 42,
  carriage: 20,
};
const DEFAULT_FULL_SCALE = 62;

/** Gait names for the carriage, indexed by `gear - 1`. */
const GAIT_KEYS: StringKey[] = ['gait.walk', 'gait.trot', 'gait.canter'];

/* ---------------------------------------------------------------- helpers */

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Point on the dial at scale fraction `t`, radius `r`. */
function polar(t: number, r: number): { x: number; y: number } {
  const a = rad(START_DEG + t * SWEEP_DEG - 90);
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
}

/** The 270° arc path at radius `r`, swept clockwise from the start angle. */
function arcPath(r: number): string {
  const a = polar(0, r);
  const b = polar(1, r);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${r} ${r} 0 1 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
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
  /** 0..1 idle→redline, or stride rate for the carriage */
  rpm: number;
  /** 1..5 forward, -1 reverse; 1..3 = walk/trot/canter on the carriage */
  gear: number;
  boosting: boolean;
  drifting: boolean;
  airborne: boolean;
}

export class Speedo {
  readonly el: HTMLElement;

  private readonly theme: UITheme;

  /* dial parts */
  private readonly gaugeWrap: HTMLElement;
  private readonly needle: TransformSlot;
  private readonly needleGroup: SVGGElement;
  private readonly scaleArc: SVGPathElement;
  private readonly revArc: SVGPathElement;
  private readonly redzone: SVGGElement;
  private readonly redzoneAlpha: OpacitySlot;
  private readonly boostRing: SVGGElement;
  private readonly boostAlpha: OpacitySlot;
  private readonly ticksGroup: SVGGElement;
  private readonly numeralsGroup: SVGGElement;
  private readonly dialShake: TransformSlot;
  private readonly heat: NumSlot;

  /* readouts */
  private readonly valueSlot: TextSlot;
  private readonly unitSlot: TextSlot;
  private readonly gearSlot: TextSlot;
  private readonly gearLabelEs: HTMLElement;
  private readonly gearLabelEn: HTMLElement;
  private readonly gearChip: HTMLElement;
  private readonly redFlag: FlagSlot;
  private readonly boostFlag: FlagSlot;
  private readonly driftFlag: FlagSlot;
  private readonly airFlag: FlagSlot;

  /* state */
  private units: SettingsState['showSpeedUnits'] = 'mph';
  private vehicleId = 'jeep';
  private fullScale = DEFAULT_FULL_SCALE;
  private scaleMax = 140;
  private scaleStep = 20;

  private needlePos = 0;
  private needleVel = 0;
  private revShown = 0;
  private lastGear = Number.NaN;
  private lastArcT = Number.NaN;
  private lastRevT = Number.NaN;
  /** > 0 while the power-on self-test sweep is running */
  private sweepT = -1;
  private shakePhase = 0;
  private unbind: Array<() => void> = [];

  constructor(theme: UITheme) {
    this.theme = theme;

    const root = el('div', 'll-speedo');
    root.setAttribute('role', 'status');
    this.el = root;
    this.unbind.push(i18n.attr(root, 'aria-label', 'hud.aria.speed'));

    /* ------------------------------------------------------------ the dial */
    const wrap = el('div', 'll-speedo__gauge');
    this.gaugeWrap = wrap;
    this.dialShake = new TransformSlot(wrap);

    const dial = svg('svg', { viewBox: '0 0 200 200', class: 'll-dial', 'aria-hidden': 'true' });

    /* face + bezel */
    const defs = svg('defs');
    const faceGrad = svg('radialGradient', { id: 'llDialFace', cx: '50%', cy: '38%', r: '72%' });
    faceGrad.append(
      svg('stop', { offset: '0', 'stop-color': '#16303F' }),
      svg('stop', { offset: '0.62', 'stop-color': '#0B1B26' }),
      svg('stop', { offset: '1', 'stop-color': '#050C12' }),
    );
    defs.append(faceGrad);
    dial.append(defs);

    dial.append(
      svg('circle', { cx: '100', cy: '100', r: '97', fill: 'var(--ll-ink)' }),
      svg('circle', { cx: '100', cy: '100', r: '92', fill: 'url(#llDialFace)' }),
      svg('circle', {
        cx: '100',
        cy: '100',
        r: '92',
        fill: 'none',
        stroke: 'rgba(255,246,232,0.10)',
        'stroke-width': '1.5',
      }),
    );

    /* the redline wedge, behind the arcs so the value arc paints over it */
    const redzone = svg('g', { class: 'll-dial__red' });
    const redStart = polar(REDLINE_AT, R_REV);
    const redEnd = polar(1, R_REV);
    redzone.append(
      svg('path', {
        d: `M${redStart.x.toFixed(2)} ${redStart.y.toFixed(2)} A${R_REV} ${R_REV} 0 0 1 ${redEnd.x.toFixed(2)} ${redEnd.y.toFixed(2)}`,
        fill: 'none',
        stroke: 'var(--ll-danger)',
        'stroke-width': '9',
        'stroke-linecap': 'butt',
      }),
    );
    this.redzone = redzone;
    this.redzoneAlpha = new OpacitySlot(redzone, 0.02);
    dial.append(redzone);

    /* scale track + value arc */
    const track = svg('path', {
      d: arcPath(R_SCALE),
      fill: 'none',
      stroke: 'rgba(255,246,232,0.12)',
      'stroke-width': '10',
      'stroke-linecap': 'round',
    });
    const arc = svg('path', {
      d: arcPath(R_SCALE),
      fill: 'none',
      stroke: 'var(--gauge-tone, var(--ll-pickup))',
      'stroke-width': '10',
      'stroke-linecap': 'round',
      class: 'll-dial__arc',
    });
    arc.setAttribute('stroke-dasharray', `${SCALE_LEN.toFixed(2)}`);
    arc.style.strokeDashoffset = `${SCALE_LEN.toFixed(2)}px`;
    this.scaleArc = arc;

    /* rev ring — runs ahead of the needle and drops on every shift */
    const revTrack = svg('path', {
      d: arcPath(R_REV),
      fill: 'none',
      stroke: 'rgba(4,8,12,0.55)',
      'stroke-width': '9',
    });
    const rev = svg('path', {
      d: arcPath(R_REV),
      fill: 'none',
      stroke: 'var(--ll-player)',
      'stroke-width': '9',
      class: 'll-dial__rev',
    });
    rev.setAttribute('stroke-dasharray', `${REV_LEN.toFixed(2)}`);
    rev.style.strokeDashoffset = `${REV_LEN.toFixed(2)}px`;
    this.revArc = rev;

    dial.append(revTrack, rev, track, arc);

    /* ticks + numerals, rebuilt whenever the unit or vehicle changes */
    this.ticksGroup = svg('g', { class: 'll-dial__ticks' });
    this.numeralsGroup = svg('g', { class: 'll-dial__nums' });
    dial.append(this.ticksGroup, this.numeralsGroup);

    /* boost halo */
    const boost = svg('g', { class: 'll-dial__boost' });
    boost.append(
      svg('circle', {
        cx: '100',
        cy: '100',
        r: '93',
        fill: 'none',
        stroke: 'var(--ll-pickup)',
        'stroke-width': '4',
      }),
    );
    boost.style.opacity = '0';
    this.boostRing = boost;
    this.boostAlpha = new OpacitySlot(boost, 0.02);
    dial.append(boost);

    /* needle: a tapered blade with a counterweight, pivoting on the hub */
    const needleGroup = svg('g', { class: 'll-dial__needle' });
    needleGroup.append(
      svg('path', {
        d: 'M100 26 L104.6 100 L100 112 L95.4 100 Z',
        fill: 'var(--ll-danger)',
        stroke: 'var(--ll-ink)',
        'stroke-width': '1.6',
        'stroke-linejoin': 'round',
      }),
      svg('circle', { cx: '100', cy: '118', r: '7', fill: 'var(--ll-danger)' }),
    );
    this.needleGroup = needleGroup;
    this.needle = new TransformSlot(needleGroup);
    dial.append(needleGroup);

    dial.append(
      svg('circle', {
        cx: '100',
        cy: '100',
        r: '11',
        fill: '#0E1D28',
        stroke: 'var(--ll-ink)',
        'stroke-width': '3',
      }),
      svg('circle', { cx: '100', cy: '100', r: '3.4', fill: 'rgba(255,246,232,0.5)' }),
    );

    wrap.append(dial);

    /* --------------------------------------------------------- the readout */
    const readout = el('div', 'll-speedo__readout');
    const row = el('div', 'll-speedo__row');
    const value = el('span', 'll-speedo__value', '0');
    const unit = el('span', 'll-speedo__unit', 'MPH');
    row.append(value, unit);
    readout.append(row);
    this.valueSlot = new TextSlot(value);
    this.unitSlot = new TextSlot(unit);

    /* gear / gait badge */
    const chip = el('div', 'll-gear');
    const chipLabel = el('div', 'll-gear__label');
    const labelEs = el('span', 'll-lbl-es', i18n.es('hud.gear'));
    labelEs.lang = 'es';
    const labelEn = el('span', 'll-lbl-en', i18n.en('hud.gear'));
    labelEn.lang = 'en';
    chipLabel.append(labelEs, labelEn);
    const chipValue = el('div', 'll-gear__value', '1');
    chip.append(chipValue, chipLabel);
    this.gearChip = chip;
    this.gearSlot = new TextSlot(chipValue);
    this.gearLabelEs = labelEs;
    this.gearLabelEn = labelEn;

    wrap.append(readout, chip);
    root.append(wrap);

    this.redFlag = new FlagSlot(root, 'is-redline');
    this.boostFlag = new FlagSlot(root, 'is-boosting');
    this.driftFlag = new FlagSlot(root, 'is-drifting');
    this.airFlag = new FlagSlot(root, 'is-airborne');
    this.heat = new NumSlot(root, '--heat', 0.02, 3);

    // The gear badge label flips language wholesale (CAMBIO ↔ AIRE), so it is
    // a bound render rather than a static pair.
    this.unbind.push(i18n.onChange(() => this.paintGearLabel()));

    this.rebuildScale();
    this.paintGearLabel();
  }

  /* ------------------------------------------------------------- settings */

  applySettings(s: SettingsState): void {
    if (s.showSpeedUnits === this.units) return;
    this.units = s.showSpeedUnits;
    this.rebuildScale();
  }

  /** Point the gauge at a vehicle. Rescales the dial and relabels the badge. */
  setVehicle(id: string): void {
    if (id === this.vehicleId) return;
    this.vehicleId = id;
    this.fullScale = FULL_SCALE_MPS[id] ?? DEFAULT_FULL_SCALE;
    this.rebuildScale();
    this.paintGearLabel();
    this.lastGear = Number.NaN;
  }

  private get isCarriage(): boolean {
    return this.vehicleId === 'carriage';
  }

  /** The power-on sweep an arcade cabinet does when you drop a coin in. */
  startSweep(): void {
    this.sweepT = this.theme.flashSafe ? -1 : 1.05;
    if (this.sweepT < 0) return;
    this.needleVel = 0;
  }

  /* ---------------------------------------------------------------- frame */

  update(input: SpeedoInput, dt: number): void {
    const speed = Math.max(0, input.speed);
    const factor = this.units === 'kmh' ? MPS_TO_KMH : MPS_TO_MPH;
    const shown = speed * factor;

    /* needle -------------------------------------------------------------- */
    let target = clamp01(shown / this.scaleMax);
    if (this.sweepT > 0) {
      // 0 → full → 0, so the needle demonstrates its own travel before play.
      this.sweepT -= dt;
      const p = clamp01(1 - this.sweepT / 1.05);
      target = p < 0.5 ? p * 2 : (1 - p) * 2;
      if (this.sweepT <= 0) this.sweepT = -1;
    }

    // A torsion spring. Underdamped on purpose: a needle that slides to its
    // value reads as a progress bar, one that overshoots and settles reads as
    // a machine with a moving part in it. Motion suppression damps it flat.
    const stiff = this.theme.flashSafe ? 130 : 260;
    const damp = this.theme.flashSafe ? 24 : 13.5;
    // Fixed sub-steps keep the spring stable if a frame is long.
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
      this.scaleArc.style.strokeDashoffset = `${(SCALE_LEN * (1 - arcT)).toFixed(2)}px`;
    }

    /* rev ring ------------------------------------------------------------ */
    // Revs are already smoothed by the vehicle; this only takes the edge off a
    // shift so the drop reads as a snap rather than a teleport.
    const revTarget = clamp01(input.rpm);
    this.revShown = lerp(this.revShown, revTarget, clamp01(dt * 18));
    if (!(Math.abs(this.revShown - this.lastRevT) < 0.004)) {
      this.lastRevT = this.revShown;
      this.revArc.style.strokeDashoffset = `${(REV_LEN * (1 - this.revShown)).toFixed(2)}px`;
    }

    /* redline ------------------------------------------------------------- */
    const over = clamp01((this.revShown - REDLINE_AT) / (1 - REDLINE_AT));
    const hot = over > 0.02;
    this.redFlag.set(hot);
    if (this.theme.canPulse && hot) {
      // A fast flare that rides the redline depth. Gated: a continuous strobe
      // is exactly what photosensitiveSafe removes, so under it the wedge just
      // sits at a steady, readable alpha.
      this.shakePhase += dt * 26;
      this.redzoneAlpha.set(0.35 + over * (0.4 + 0.25 * Math.sin(this.shakePhase)));
    } else {
      this.redzoneAlpha.set(hot ? 0.75 : 0.22);
    }

    /* boost + drive state -------------------------------------------------- */
    this.boostFlag.set(input.boosting);
    this.driftFlag.set(input.drifting);
    this.airFlag.set(input.airborne);
    this.boostAlpha.set(input.boosting ? 1 : 0);

    /**
     * `--heat` is a *registered* `<number>` (see `@property --heat` in
     * styles.css) read only by colour-mix and box-shadow, so writing it every
     * frame stays off the layout path. It drives the whole dial's temperature:
     * cyan when cruising, taxi-yellow as it fills, danger at the top.
     */
    this.heat.set(Math.max(arcT, over * 0.9));

    /* top-end shake -------------------------------------------------------- */
    const shakeAmt = this.theme.shake;
    const nearMax = clamp01((arcT - 0.9) / 0.1);
    if (shakeAmt > 0 && (nearMax > 0 || input.boosting)) {
      this.shakePhase += dt * 47;
      const amp = (nearMax * 2.4 + (input.boosting ? 0.9 : 0)) * shakeAmt;
      const x = Math.sin(this.shakePhase * 1.7) * amp;
      const y = Math.cos(this.shakePhase * 2.3) * amp * 0.7;
      const s = 1 + nearMax * 0.035 * shakeAmt;
      this.dialShake.set(
        `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${s.toFixed(3)})`,
      );
    } else {
      this.dialShake.set('translate3d(0, 0, 0)');
    }

    /* readouts ------------------------------------------------------------- */
    this.valueSlot.set(String(Math.round(shown)));
    this.gearSlot.set(this.gearText(input.gear));
    if (input.gear !== this.lastGear) {
      const first = Number.isNaN(this.lastGear);
      this.lastGear = input.gear;
      if (!first) this.punchGear(input.gear > 0 && this.needlePos > 0.05);
    }
  }

  /* --------------------------------------------------------------- visual */

  private gearText(gear: number): string {
    if (this.isCarriage) {
      const key = GAIT_KEYS[clamp(Math.round(gear), 1, GAIT_KEYS.length) - 1];
      return i18n.t(key);
    }
    if (gear < 0) return i18n.t('gear.reverse');
    if (gear === 0) return i18n.t('gear.neutral');
    return String(Math.round(gear));
  }

  private paintGearLabel(): void {
    const key: StringKey = this.isCarriage ? 'hud.gait' : 'hud.gear';
    this.gearLabelEs.textContent = i18n.es(key);
    this.gearLabelEn.textContent = i18n.en(key);
    this.gearSlot.set(this.gearText(Number.isNaN(this.lastGear) ? 1 : this.lastGear));
    this.gearChip.dataset.kind = this.isCarriage ? 'gait' : 'gear';
  }

  /** A short slam on the badge whenever the box (or the horse) changes. */
  private punchGear(up: boolean): void {
    if (this.theme.flashSafe) return;
    const k = 0.4 + 0.6 * this.theme.shake;
    this.gearChip.animate(
      [
        {
          transform: `translate3d(0, ${(up ? -5 : 5) * k}px, 0) scale(${1 + 0.28 * k})`,
          offset: 0,
        },
        { transform: `translate3d(0, 0, 0) scale(${1 - 0.06 * k})`, offset: 0.55 },
        { transform: 'translate3d(0, 0, 0) scale(1)', offset: 1 },
      ],
      { duration: this.theme.duration(300), easing: this.theme.ease('back') },
    );
  }

  /**
   * Rebuild ticks and numerals for the current unit and vehicle.
   *
   * Called only on a settings or vehicle change — never per frame — so the DOM
   * churn here is irrelevant, and it buys a dial whose numbers are real.
   */
  private rebuildScale(): void {
    const factor = this.units === 'kmh' ? MPS_TO_KMH : MPS_TO_MPH;
    const { max, step } = niceScale(this.fullScale * factor);
    this.scaleMax = max;
    this.scaleStep = step;
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
      const rOuter = R_SCALE - 8;
      const rInner = rOuter - (major ? 12 : 6);
      const a = polar(t, rOuter);
      const b = polar(t, rInner);
      const redline = t >= REDLINE_AT;
      ticks.append(
        svg('path', {
          d: `M${a.x.toFixed(2)} ${a.y.toFixed(2)} L${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
          stroke: redline ? 'var(--ll-danger)' : 'rgba(255,246,232,0.62)',
          'stroke-width': major ? '3.2' : '1.6',
          'stroke-linecap': 'round',
        }),
      );
      if (!major) continue;
      const p = polar(t, rInner - 13);
      const label = svg('text', {
        x: p.x.toFixed(2),
        y: p.y.toFixed(2),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': '15',
        'font-weight': '800',
        fill: redline ? 'var(--ll-danger)' : 'rgba(255,246,232,0.82)',
      });
      label.textContent = String(Math.round(t * max));
      nums.append(label);
    }
    this.lastArcT = Number.NaN;
  }

  dispose(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
    this.el.remove();
  }
}
