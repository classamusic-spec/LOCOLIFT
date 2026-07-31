/**
 * EngineAudio.ts — the Jeep's engine.
 *
 * This is the one sound the player hears for the entire session, so it is
 * built like a real engine model rather than "a sawtooth whose pitch follows
 * the throttle":
 *
 *  - The pitch reference is the **firing frequency** of a four-stroke four:
 *    `f0 = rpm/60 × cylinders/2`. Idle ≈ 27 Hz, redline ≈ 148 Hz. Everything
 *    audible is a harmonic of that, exactly as it is in a real exhaust.
 *  - Three detuned oscillators on a custom "engine" spectrum (strong low
 *    orders, even-harmonic bias, a pipe formant near the 9th) beat against
 *    each other, which is what stops a synthetic engine sounding like a
 *    dentist's drill.
 *  - A half-order sub and a 1.5x "growl" partial give the lumpy, torquey
 *    character at low rpm; both fade as revs rise.
 *  - Filtered noise supplies intake roar and exhaust turbulence, tracking f0
 *    so it stays glued to the tone.
 *  - **Load** (throttle vs. revs) opens the tone filter and pushes the
 *    saturation stage: accelerating is bright and hard, coasting is dark and
 *    soft, and lifting off at high rpm produces overrun crackle.
 *  - Boost adds a spooling turbo whine and a blow-off hiss on lift.
 *  - Gear changes duck the output, blip the pitch and fire a driveline clunk.
 *
 * Every voice is created once in the constructor. The per-frame path only ever
 * schedules `setTargetAtTime` ramps, so there is no zipper noise, no clicking
 * and no allocation in `update`.
 */

import { clamp, clamp01, lerp } from '../core/MathUtils';
import {
  SmoothParam,
  biquad,
  createOsc,
  distortionCurve,
  envPerc,
  gainNode,
  noiseSource,
  safeDisconnect,
  setAt,
  startSource,
} from './Synth';

export interface EngineState {
  /** 0..1 from Vehicle.engineRpmNorm */
  rpmNorm: number;
  /** current gear index from Vehicle.gear */
  gear: number;
  /** 0..1 accelerator */
  throttle: number;
  /** 0..1 brake */
  brake: number;
  /** m/s */
  speed: number;
  boosting: boolean;
  airborne: boolean;
  /** 0..4 */
  wheelsOnGround: number;
}

export interface EngineAudioOptions {
  cylinders?: number;
  idleHz?: number;
  redlineHz?: number;
  /** master trim for the whole engine, 0..1 */
  volume?: number;
}

const DEFAULTS = {
  cylinders: 4,
  idleHz: 27,
  redlineHz: 148,
  volume: 1,
};

export class EngineAudio {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;

  /* ---- tone stack ---- */
  private readonly toneMix: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly toneLp: BiquadFilterNode;
  private readonly bodyPeak: BiquadFilterNode;
  private readonly rumbleShelf: BiquadFilterNode;
  private readonly hpf: BiquadFilterNode;

  /* ---- oscillator bank ---- */
  private readonly oscs: OscillatorNode[] = [];
  private readonly oscGains: GainNode[] = [];
  private readonly subOsc: OscillatorNode;
  private readonly subGain: GainNode;
  private readonly growlOsc: OscillatorNode;
  private readonly growlGain: GainNode;
  private readonly screamOsc: OscillatorNode;
  private readonly screamGain: GainNode;
  private readonly screamBp: BiquadFilterNode;

  /* ---- idle wobble LFO ---- */
  private readonly wobbleLfo: OscillatorNode;
  private readonly wobbleDepth: GainNode;

  /* ---- noise beds ---- */
  private readonly intakeSrc: AudioBufferSourceNode;
  private readonly intakeBp: BiquadFilterNode;
  private readonly intakeGain: GainNode;
  private readonly exhaustSrc: AudioBufferSourceNode;
  private readonly exhaustBp: BiquadFilterNode;
  private readonly exhaustGain: GainNode;

  /* ---- transient generators (always running, gated by envelopes) ---- */
  private readonly crackleSrc: AudioBufferSourceNode;
  private readonly crackleBp: BiquadFilterNode;
  private readonly crackleGain: GainNode;
  private readonly clunkSrc: AudioBufferSourceNode;
  private readonly clunkBp: BiquadFilterNode;
  private readonly clunkNoiseGain: GainNode;
  private readonly clunkOsc: OscillatorNode;
  private readonly clunkOscGain: GainNode;

  /* ---- boost / turbo ---- */
  private readonly turboA: OscillatorNode;
  private readonly turboB: OscillatorNode;
  private readonly turboPeak: BiquadFilterNode;
  private readonly turboGain: GainNode;
  private readonly bovSrc: AudioBufferSourceNode;
  private readonly bovHp: BiquadFilterNode;
  private readonly bovGain: GainNode;

  /* ---- smoothed params ---- */
  private readonly sOscFreq: SmoothParam[] = [];
  private readonly sSubFreq: SmoothParam;
  private readonly sGrowlFreq: SmoothParam;
  private readonly sScreamFreq: SmoothParam;
  private readonly sScreamBp: SmoothParam;
  private readonly sIntakeBp: SmoothParam;
  private readonly sExhaustBp: SmoothParam;
  private readonly sIntakeGain: SmoothParam;
  private readonly sExhaustGain: SmoothParam;
  private readonly sToneLp: SmoothParam;
  private readonly sSubGain: SmoothParam;
  private readonly sGrowlGain: SmoothParam;
  private readonly sScreamGain: SmoothParam;
  private readonly sOscGains: SmoothParam[] = [];
  private readonly sTurboFreqA: SmoothParam;
  private readonly sTurboFreqB: SmoothParam;
  private readonly sTurboGain: SmoothParam;
  private readonly sWobbleDepth: SmoothParam;
  private readonly sBodyGain: SmoothParam;
  private readonly sMaster: SmoothParam;

  private readonly cylinders: number;
  private readonly idleHz: number;
  private readonly redlineHz: number;

  private started = false;
  private disposed = false;
  private volume: number;

  /* running state */
  private rpm = 0;
  private load = 0;
  private spool = 0;
  private lastGear = 1;
  private gearShiftTimer = 0;
  private crackleTimer = 0;
  /** true while the throttle has been open long enough to charge the BOV */
  private bovLatch = true;
  private curveSoft: ReturnType<typeof distortionCurve>;
  private curveHard: ReturnType<typeof distortionCurve>;
  private hardCurveActive = false;

  constructor(ctx: BaseAudioContext, destination: AudioNode, opts: EngineAudioOptions = {}) {
    this.ctx = ctx;
    this.cylinders = opts.cylinders ?? DEFAULTS.cylinders;
    this.idleHz = opts.idleHz ?? DEFAULTS.idleHz;
    this.redlineHz = opts.redlineHz ?? DEFAULTS.redlineHz;
    this.volume = opts.volume ?? DEFAULTS.volume;

    const t0 = ctx.currentTime;

    /* ------------------------------------------------------- output chain */
    this.out = gainNode(ctx, 0);
    this.out.connect(destination);

    this.hpf = biquad(ctx, 'highpass', 38, 0.6);
    this.rumbleShelf = biquad(ctx, 'lowshelf', 110, 0.7, 4.5);
    this.bodyPeak = biquad(ctx, 'peaking', 168, 1.15, 5.5);
    this.toneLp = biquad(ctx, 'lowpass', 900, 1.35);
    this.curveSoft = distortionCurve(0.22);
    this.curveHard = distortionCurve(0.52);
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this.curveSoft;
    this.shaper.oversample = '2x';
    this.toneMix = gainNode(ctx, 0.5);

    this.toneMix.connect(this.shaper);
    this.shaper.connect(this.toneLp);
    this.toneLp.connect(this.bodyPeak);
    this.bodyPeak.connect(this.rumbleShelf);
    this.rumbleShelf.connect(this.hpf);
    this.hpf.connect(this.out);

    /* -------------------------------------------------- oscillator bank */
    // Three detuned copies of the engine spectrum. The detune spread is small
    // (a few cents) so they beat slowly rather than sounding like a chord.
    const detunes = [-7, 0, 9];
    const bankGains = [0.34, 0.42, 0.3];
    for (let i = 0; i < detunes.length; i++) {
      const o = createOsc(ctx, 'engine', this.idleHz, detunes[i], 44);
      const g = gainNode(ctx, bankGains[i]);
      o.connect(g);
      g.connect(this.toneMix);
      this.oscs.push(o);
      this.oscGains.push(g);
      this.sOscFreq.push(new SmoothParam(o.frequency, 0.045));
      this.sOscGains.push(new SmoothParam(g.gain, 0.09));
    }

    // Half-order sub: the chest thump. Loud at idle, ducked at the top end so
    // the mix does not turn to mud when the fundamental climbs into it.
    this.subOsc = createOsc(ctx, 'triangle', this.idleHz * 0.5);
    this.subGain = gainNode(ctx, 0.2);
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.toneMix);
    this.sSubFreq = new SmoothParam(this.subOsc.frequency, 0.06);
    this.sSubGain = new SmoothParam(this.subGain.gain, 0.12);

    // 1.5x growl: an inharmonic partial that gives the lumpy off-beat idle of
    // a big torquey four. Fades out above half revs.
    this.growlOsc = createOsc(ctx, 'square', this.idleHz * 1.5, 4, 18);
    this.growlGain = gainNode(ctx, 0.08);
    this.growlOsc.connect(this.growlGain);
    this.growlGain.connect(this.toneMix);
    this.sGrowlFreq = new SmoothParam(this.growlOsc.frequency, 0.05);
    this.sGrowlGain = new SmoothParam(this.growlGain.gain, 0.15);

    // High-rpm scream: a bandpassed saw an octave up, only audible when the
    // engine is actually working hard.
    this.screamOsc = createOsc(ctx, 'saw', this.idleHz * 2, -4, 24);
    this.screamBp = biquad(ctx, 'bandpass', 1400, 1.6);
    this.screamGain = gainNode(ctx, 0);
    this.screamOsc.connect(this.screamBp);
    this.screamBp.connect(this.screamGain);
    this.screamGain.connect(this.toneMix);
    this.sScreamFreq = new SmoothParam(this.screamOsc.frequency, 0.05);
    this.sScreamBp = new SmoothParam(this.screamBp.frequency, 0.08);
    this.sScreamGain = new SmoothParam(this.screamGain.gain, 0.1);

    /* --------------------------------------------------------- idle wobble */
    // A slow LFO on every oscillator's detune: real engines are never
    // perfectly steady, and this is most of what sells "idling" over "droning".
    this.wobbleLfo = createOsc(ctx, 'sine', 6.4);
    this.wobbleDepth = gainNode(ctx, 0);
    this.wobbleLfo.connect(this.wobbleDepth);
    for (const o of this.oscs) this.wobbleDepth.connect(o.detune);
    this.wobbleDepth.connect(this.growlOsc.detune);
    this.wobbleDepth.connect(this.subOsc.detune);
    this.sWobbleDepth = new SmoothParam(this.wobbleDepth.gain, 0.2);

    /* ------------------------------------------------------------- noise */
    this.intakeSrc = noiseSource(ctx, 'brown', 1, true);
    this.intakeBp = biquad(ctx, 'bandpass', 320, 1.1);
    this.intakeGain = gainNode(ctx, 0);
    this.intakeSrc.connect(this.intakeBp);
    this.intakeBp.connect(this.intakeGain);
    this.intakeGain.connect(this.toneMix);
    this.sIntakeBp = new SmoothParam(this.intakeBp.frequency, 0.07);
    this.sIntakeGain = new SmoothParam(this.intakeGain.gain, 0.09);

    this.exhaustSrc = noiseSource(ctx, 'white', 1, true);
    this.exhaustBp = biquad(ctx, 'bandpass', 900, 2.4);
    this.exhaustGain = gainNode(ctx, 0);
    this.exhaustSrc.connect(this.exhaustBp);
    this.exhaustBp.connect(this.exhaustGain);
    this.exhaustGain.connect(this.toneMix);
    this.sExhaustBp = new SmoothParam(this.exhaustBp.frequency, 0.07);
    this.sExhaustGain = new SmoothParam(this.exhaustGain.gain, 0.09);

    this.sToneLp = new SmoothParam(this.toneLp.frequency, 0.055);
    this.sBodyGain = new SmoothParam(this.bodyPeak.gain, 0.12);
    this.sMaster = new SmoothParam(this.out.gain, 0.08);

    /* ---------------------------------------------- gated transient beds */
    // Overrun crackle. A continuously running noise voice whose gain is
    // spiked by short envelopes — no node allocation per pop.
    this.crackleSrc = noiseSource(ctx, 'white', 1, true);
    this.crackleBp = biquad(ctx, 'bandpass', 1650, 5.5);
    this.crackleGain = gainNode(ctx, 0);
    this.crackleSrc.connect(this.crackleBp);
    this.crackleBp.connect(this.crackleGain);
    this.crackleGain.connect(this.toneMix);

    // Driveline clunk on gear change: noise thwack + a low body knock.
    this.clunkSrc = noiseSource(ctx, 'white', 1, true);
    this.clunkBp = biquad(ctx, 'bandpass', 420, 2.2);
    this.clunkNoiseGain = gainNode(ctx, 0);
    this.clunkSrc.connect(this.clunkBp);
    this.clunkBp.connect(this.clunkNoiseGain);
    this.clunkNoiseGain.connect(this.toneMix);

    this.clunkOsc = createOsc(ctx, 'sine', 96);
    this.clunkOscGain = gainNode(ctx, 0);
    this.clunkOsc.connect(this.clunkOscGain);
    this.clunkOscGain.connect(this.toneMix);

    /* ------------------------------------------------------ turbo / boost */
    // Two close sines through a peak filter: a spinning turbine, not a whistle.
    this.turboPeak = biquad(ctx, 'peaking', 3200, 4.5, 9);
    this.turboGain = gainNode(ctx, 0);
    this.turboA = createOsc(ctx, 'sine', 2400);
    this.turboB = createOsc(ctx, 'triangle', 3610, 6);
    const turboMix = gainNode(ctx, 0.5);
    this.turboA.connect(turboMix);
    this.turboB.connect(turboMix);
    turboMix.connect(this.turboPeak);
    this.turboPeak.connect(this.turboGain);
    this.turboGain.connect(this.out);
    this.sTurboFreqA = new SmoothParam(this.turboA.frequency, 0.12);
    this.sTurboFreqB = new SmoothParam(this.turboB.frequency, 0.12);
    this.sTurboGain = new SmoothParam(this.turboGain.gain, 0.1);

    // Blow-off valve hiss, gated on throttle lift while boosting.
    this.bovSrc = noiseSource(ctx, 'white', 1, true);
    this.bovHp = biquad(ctx, 'highpass', 2600, 0.8);
    this.bovGain = gainNode(ctx, 0);
    this.bovSrc.connect(this.bovHp);
    this.bovHp.connect(this.bovGain);
    this.bovGain.connect(this.out);

    setAt(this.out.gain, 0, t0);
  }

  /* ------------------------------------------------------------ lifecycle */

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const t = this.ctx.currentTime + 0.01;
    const sources: AudioScheduledSourceNode[] = [
      ...this.oscs,
      this.subOsc,
      this.growlOsc,
      this.screamOsc,
      this.wobbleLfo,
      this.intakeSrc,
      this.exhaustSrc,
      this.crackleSrc,
      this.clunkSrc,
      this.clunkOsc,
      this.turboA,
      this.turboB,
      this.bovSrc,
    ];
    for (const s of sources) startSource(s, t);
    // Fade the engine in rather than punching it on.
    setAt(this.out.gain, 0, t);
    this.out.gain.linearRampToValueAtTime(this.volume * 0.42, t + 0.35);
    this.sMaster.snap(this.volume * 0.42, t + 0.35);
  }

  stop(): void {
    if (!this.started || this.disposed) return;
    const t = this.ctx.currentTime;
    this.sMaster.set(0, t);
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    if (this.started) this.sMaster.set(this.volume * 0.42, this.ctx.currentTime);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    setAt(this.out.gain, 0, t);
    const stopAll: AudioScheduledSourceNode[] = [
      ...this.oscs,
      this.subOsc,
      this.growlOsc,
      this.screamOsc,
      this.wobbleLfo,
      this.intakeSrc,
      this.exhaustSrc,
      this.crackleSrc,
      this.clunkSrc,
      this.clunkOsc,
      this.turboA,
      this.turboB,
      this.bovSrc,
    ];
    for (const s of stopAll) {
      try {
        s.stop(t + 0.05);
      } catch {
        /* never started */
      }
      safeDisconnect(s);
    }
    const nodes: (AudioNode | null)[] = [
      ...this.oscGains,
      this.subGain,
      this.growlGain,
      this.screamGain,
      this.screamBp,
      this.wobbleDepth,
      this.intakeBp,
      this.intakeGain,
      this.exhaustBp,
      this.exhaustGain,
      this.crackleBp,
      this.crackleGain,
      this.clunkBp,
      this.clunkNoiseGain,
      this.clunkOscGain,
      this.turboPeak,
      this.turboGain,
      this.bovHp,
      this.bovGain,
      this.toneMix,
      this.shaper,
      this.toneLp,
      this.bodyPeak,
      this.rumbleShelf,
      this.hpf,
      this.out,
    ];
    for (const n of nodes) safeDisconnect(n);
  }

  /* --------------------------------------------------------------- update */

  /**
   * Per-frame. Everything here is a smoothed ramp; nothing is set directly.
   */
  update(dt: number, s: EngineState): void {
    if (!this.started || this.disposed) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const step = clamp(dt, 0.0005, 0.1);

    /* ------------------------------------------------------------- inputs */
    const rpmTarget = clamp01(s.rpmNorm);
    // A little extra smoothing on top of whatever the vehicle does — pitch is
    // the most obvious place a physics hitch would be audible.
    this.rpm = lerp(this.rpm, rpmTarget, 1 - Math.exp(-22 * step));
    const rpm = this.rpm;
    const throttle = clamp01(s.throttle);
    const airborne = s.airborne || s.wheelsOnGround === 0;

    // Load = "how hard is the engine pulling?". Throttle with revs is high
    // load; throttle at redline or off-throttle is not. Airborne means the
    // engine is free-revving, so almost no load.
    const rawLoad = throttle * (0.35 + 0.65 * (1 - Math.pow(rpm, 1.5)));
    const targetLoad = airborne ? rawLoad * 0.35 : rawLoad;
    this.load = lerp(this.load, targetLoad, 1 - Math.exp(-9 * step));
    const load = this.load;

    // Off-throttle at revs = overrun.
    const overrun = clamp01((1 - throttle * 3) * clamp01((rpm - 0.28) / 0.42));

    /* ------------------------------------------------------------- pitch */
    // Firing frequency of the engine. The exponent gives the ear a linear
    // sense of "revs" against a physically linear rpm.
    const f0 = lerp(this.idleHz, this.redlineHz, Math.pow(rpm, 0.92));

    for (let i = 0; i < this.sOscFreq.length; i++) this.sOscFreq[i].set(f0, t);
    this.sSubFreq.set(f0 * 0.5, t);
    this.sGrowlFreq.set(f0 * 1.5, t);
    this.sScreamFreq.set(f0 * 2, t);

    /* -------------------------------------------------------- layer gains */
    // Sub is the idle's body; back it off as the fundamental rises into it.
    this.sSubGain.set(lerp(0.26, 0.08, rpm) * (0.55 + 0.45 * throttle), t);
    // Growl only lives at the bottom of the rev range.
    this.sGrowlGain.set(Math.max(0, 0.11 * (1 - rpm * 1.6)) * (0.4 + 0.6 * throttle), t);
    // Scream is a high-rpm, high-load phenomenon.
    const screamAmt = Math.pow(clamp01((rpm - 0.42) / 0.58), 1.5) * (0.25 + 0.75 * load);
    this.sScreamGain.set(screamAmt * 0.26, t);
    this.sScreamBp.set(clamp(700 + rpm * 2600 + load * 900, 200, 6000), t);

    // The three-oscillator bank swells slightly with load so acceleration has
    // more body than coasting at the same rpm.
    const bankBoost = 0.82 + 0.32 * load;
    this.sOscGains[0].set(0.34 * bankBoost, t);
    this.sOscGains[1].set(0.42 * bankBoost, t);
    this.sOscGains[2].set(0.3 * bankBoost * (0.6 + 0.4 * rpm), t);

    // Idle wobble: strong at idle, gone by half revs.
    this.sWobbleDepth.set(lerp(16, 1.5, clamp01(rpm * 2.2)), t);

    /* --------------------------------------------------------- noise beds */
    // Intake tracks a low multiple of f0; it is the "suck" you hear on
    // throttle. Almost silent when coasting.
    this.sIntakeBp.set(clamp(f0 * 4.5 + 120, 60, 8000), t);
    this.sIntakeGain.set((0.05 + 0.42 * throttle) * (0.35 + 0.65 * rpm) * 0.55, t);

    // Exhaust turbulence: present always, brighter and louder under load.
    this.sExhaustBp.set(clamp(f0 * 7 + 300 + load * 700, 100, 11000), t);
    this.sExhaustGain.set((0.055 + 0.1 * rpm + 0.13 * load + 0.05 * overrun) * 0.7, t);

    /* --------------------------------------------------- tone / colouration */
    // The load filter. This is the single most important "feel" parameter:
    // hard on the throttle opens it right up, coasting closes it down.
    const cutoff = 340 + rpm * 3400 + load * 2600 + (airborne ? 400 : 0) - overrun * 700;
    this.sToneLp.set(clamp(cutoff, 220, 12000), t);
    this.sBodyGain.set(lerp(6.5, 2.5, rpm) + load * 1.5, t);

    // Swap the saturation curve (not a per-frame op — only on a real change)
    // so that hard acceleration genuinely distorts.
    const wantHard = load > 0.55 || s.boosting;
    if (wantHard !== this.hardCurveActive) {
      this.hardCurveActive = wantHard;
      this.shaper.curve = wantHard ? this.curveHard : this.curveSoft;
    }

    /* ----------------------------------------------------- overrun crackle */
    this.crackleTimer -= step;
    if (overrun > 0.25 && this.crackleTimer <= 0) {
      // Irregular spacing — a metronomic crackle sounds like a machine gun.
      this.crackleTimer = 0.028 + Math.random() * 0.085 * (1.2 - overrun);
      const amp = 0.05 + 0.16 * overrun * (0.5 + 0.5 * Math.random());
      envPerc(this.crackleGain.gain, t, amp, 0.001, 0.035 + Math.random() * 0.04);
      this.crackleBp.frequency.setValueAtTime(
        clamp(900 + Math.random() * 2200, 200, 9000),
        t,
      );
    }

    /* ------------------------------------------------------- gear changes */
    if (s.gear !== this.lastGear) {
      const up = s.gear > this.lastGear;
      this.lastGear = s.gear;
      this.gearShiftTimer = 0.22;
      this.triggerShift(t, up, rpm);
    }
    if (this.gearShiftTimer > 0) this.gearShiftTimer = Math.max(0, this.gearShiftTimer - step);

    /* ---------------------------------------------------------- turbo */
    const spoolTarget = s.boosting ? 1 : clamp01(load * 0.55 + rpm * 0.2 - 0.12);
    // Turbos spool fast and bleed down slowly.
    const spoolRate = spoolTarget > this.spool ? 3.4 : 1.1;
    this.spool = lerp(this.spool, spoolTarget, 1 - Math.exp(-spoolRate * step));
    const spool = this.spool;
    this.sTurboFreqA.set(clamp(1500 + spool * 4200 + rpm * 2200, 200, 14000), t);
    this.sTurboFreqB.set(clamp(2260 + spool * 6300 + rpm * 3100, 200, 17000), t);
    this.turboPeak.frequency.setTargetAtTime(
      clamp(2000 + spool * 5200 + rpm * 2400, 300, 15000),
      t,
      0.15,
    );
    this.sTurboGain.set(Math.pow(spool, 1.7) * (s.boosting ? 0.075 : 0.028), t);

    // Blow-off on lift while spooled.
    if (spool > 0.5 && throttle < 0.08 && this.bovLatch) {
      this.bovLatch = false;
      envPerc(this.bovGain.gain, t, 0.09 * spool, 0.006, 0.28);
    }
    if (throttle > 0.35) this.bovLatch = true;

    /* ------------------------------------------------------------ master */
    // The engine gets quieter (and duller) with all four wheels in the air —
    // you are further from the road, and there is no tyre/transmission load.
    const airDuck = airborne ? 0.88 : 1;
    const shiftDuck = this.gearShiftTimer > 0 ? lerp(1, 0.62, this.gearShiftTimer / 0.22) : 1;
    this.sMaster.set(this.volume * 0.42 * airDuck * shiftDuck, t);
  }

  /**
   * Gear change: a driveline clunk, a noise thwack and a short pitch blip on
   * the whole bank. Upshifts drop pitch, downshifts blip it up.
   */
  private triggerShift(t: number, up: boolean, rpm: number): void {
    const amp = clamp(0.06 + rpm * 0.12, 0.05, 0.2);
    envPerc(this.clunkNoiseGain.gain, t, amp * 0.55, 0.001, 0.055);
    this.clunkBp.frequency.setValueAtTime(up ? 380 : 520, t);
    this.clunkOsc.frequency.cancelScheduledValues(t);
    this.clunkOsc.frequency.setValueAtTime(up ? 112 : 132, t);
    this.clunkOsc.frequency.exponentialRampToValueAtTime(up ? 62 : 74, t + 0.09);
    envPerc(this.clunkOscGain.gain, t, amp, 0.002, 0.1);

    // Pitch blip via detune so it rides on top of the frequency smoothing.
    const cents = up ? -95 : 130;
    for (const o of this.oscs) {
      o.detune.cancelScheduledValues(t);
      o.detune.setValueAtTime(cents, t);
      o.detune.linearRampToValueAtTime(0, t + 0.17);
    }
  }
}
