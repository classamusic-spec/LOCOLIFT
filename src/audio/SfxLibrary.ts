/**
 * SfxLibrary.ts — every one-shot and loop in Loco Lift, synthesised.
 *
 * There are no samples. Each sound is assembled from oscillators, noise
 * buffers, filters and envelopes at the moment it is triggered, which means:
 *  - it works offline, forever, with zero download;
 *  - every repeat can be varied (pitch, level, filter, grain timing) so the
 *    fiftieth kerb clip does not sound like the first.
 *
 * Voice management: each `play()` builds a small node graph under a per-voice
 * gain, registers it, and is swept up once its envelope has provably reached
 * zero. Concurrency is capped per sound id — the oldest voice is stolen when a
 * cap is hit, so a 12-car pile-up cannot spawn 200 oscillators.
 */

import type { SfxId } from '../core/types';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import {
  MIN_GAIN,
  SmoothParam,
  atLeastNow,
  biquad,
  createOsc,
  createShaper,
  envPerc,
  envSwell,
  finiteOr,
  gainNode,
  noiseSource,
  safeDisconnect,
  setAt,
  startSource,
  type NoiseKind,
  type WaveKind,
} from './Synth';

/* ------------------------------------------------------------------ types */

export interface SfxPlayOptions {
  /** linear gain multiplier, 0..2 (default 1) */
  volume?: number;
  /** frequency multiplier applied to the whole sound (default 1) */
  pitch?: number;
  /** -1 left .. 1 right (default 0) */
  pan?: number;
  /** distance low-pass in Hz; omit or >= 18000 for none */
  cutoff?: number;
  /** absolute AudioContext time to fire at; defaults to "now" */
  when?: number;
  /** extra randomisation scale, 0 = deterministic, 1 = normal (default 1) */
  variation?: number;
}

export interface SfxLoopParams {
  /** 0..1 loop level */
  volume?: number;
  /** frequency / filter multiplier, ~0.5..2 */
  pitch?: number;
  pan?: number;
  /** 0..1 extra brightness/aggression, meaning depends on the loop */
  intensity?: number;
}

/** Sounds that also exist as a sustained loop. */
export const LOOPABLE_SFX: readonly SfxId[] = ['tireScreech', 'boostLoop', 'rainLoop'];

/** Maximum simultaneous voices per sound. Tuned for a busy pile-up. */
const VOICE_CAP: Partial<Record<SfxId, number>> = {
  tireScreech: 3,
  impactHeavy: 4,
  impactLight: 7,
  propBreak: 6,
  boostStart: 2,
  boostLoop: 1,
  landing: 4,
  jumpTakeoff: 3,
  horn: 3,
  pickup: 2,
  dropoff: 2,
  cashRegister: 2,
  comboUp: 5,
  comboBreak: 2,
  countdownTick: 3,
  countdownGo: 1,
  timeExtend: 2,
  uiMove: 4,
  uiConfirm: 3,
  uiBack: 3,
  nearMiss: 4,
  crowdCheer: 3,
  seagull: 3,
  wave: 4,
  thunder: 2,
  rainLoop: 1,
};

const DEFAULT_CAP = 4;

/* ------------------------------------------------------------ voice scope */

interface ActiveVoice {
  id: SfxId;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  start: number;
  end: number;
}

/**
 * Small builder handed to each sound recipe. It owns registration so recipes
 * can stay declarative — every node they make is torn down automatically.
 */
class VoiceScope {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  end: number;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: GainNode,
    readonly t0: number,
    readonly rng: RNG,
    readonly pitch: number,
    readonly vol: number,
    readonly variation: number,
  ) {
    this.end = t0;
  }

  /** Random in [-a, a], scaled by the caller's variation amount. */
  jitter(a: number): number {
    return (this.rng.next() * 2 - 1) * a * this.variation;
  }

  /** Random in [lo, hi], scaled toward the midpoint by variation. */
  vary(lo: number, hi: number): number {
    const mid = (lo + hi) * 0.5;
    return lerp(mid, lo + this.rng.next() * (hi - lo), this.variation);
  }

  reg<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  gain(v = 1): GainNode {
    return this.reg(gainNode(this.ctx, v));
  }

  osc(kind: OscillatorType | WaveKind, freq: number, detune = 0, partials = 24): OscillatorNode {
    return this.reg(createOsc(this.ctx, kind, freq, detune, partials));
  }

  noise(kind: NoiseKind = 'white', rate = 1, loop = true): AudioBufferSourceNode {
    const n = noiseSource(this.ctx, kind, rate, loop);
    this.nodes.push(n);
    return n;
  }

  filt(type: BiquadFilterType, freq: number, q = 0.7071, gainDb = 0): BiquadFilterNode {
    return this.reg(biquad(this.ctx, type, freq, q, gainDb));
  }

  shaper(amount: number): WaveShaperNode {
    return this.reg(createShaper(this.ctx, amount, 'none'));
  }

  /** Start a source and remember to stop it. Extends the voice lifetime. */
  fire(src: AudioScheduledSourceNode, start: number, stop: number): void {
    this.sources.push(src);
    startSource(src, start, stop);
    if (stop > this.end) this.end = stop;
  }

  mark(t: number): void {
    if (t > this.end) this.end = t;
  }
}

type Recipe = (v: VoiceScope) => void;

/* -------------------------------------------------------------- the loops */

interface LoopVoice {
  id: SfxId;
  out: GainNode;
  panner: StereoPannerNode | null;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  level: SmoothParam;
  tone: SmoothParam | null;
  tone2: SmoothParam | null;
  rate: SmoothParam | null;
  baseTone: number;
  baseTone2: number;
  baseRate: number;
  baseLevel: number;
  stopping: boolean;
}

/* ------------------------------------------------------------------ class */

export class SfxLibrary {
  private readonly ctx: BaseAudioContext;
  private readonly dest: AudioNode;
  private readonly rng: RNG;
  private readonly voices: ActiveVoice[] = [];
  private readonly loops = new Map<SfxId, LoopVoice>();
  private readonly recipes: Record<SfxId, Recipe>;
  private disposed = false;
  /** global trim so the mix can be pulled down without touching the bus */
  private trim = 1;

  constructor(ctx: BaseAudioContext, destination: AudioNode, seed = 0x10c0_11f7) {
    this.ctx = ctx;
    this.dest = destination;
    this.rng = new RNG(seed >>> 0);
    this.recipes = {
      tireScreech: (v) => this.rTireScreech(v),
      impactHeavy: (v) => this.rImpact(v, true),
      impactLight: (v) => this.rImpact(v, false),
      propBreak: (v) => this.rPropBreak(v),
      boostStart: (v) => this.rBoostStart(v),
      boostLoop: (v) => this.rBoostBurst(v),
      landing: (v) => this.rLanding(v),
      jumpTakeoff: (v) => this.rJumpTakeoff(v),
      horn: (v) => this.rHorn(v),
      pickup: (v) => this.rPickup(v),
      dropoff: (v) => this.rDropoff(v),
      cashRegister: (v) => this.rCashRegister(v),
      comboUp: (v) => this.rComboUp(v),
      comboBreak: (v) => this.rComboBreak(v),
      countdownTick: (v) => this.rCountdownTick(v),
      countdownGo: (v) => this.rCountdownGo(v),
      timeExtend: (v) => this.rTimeExtend(v),
      uiMove: (v) => this.rUiMove(v),
      uiConfirm: (v) => this.rUiConfirm(v),
      uiBack: (v) => this.rUiBack(v),
      nearMiss: (v) => this.rNearMiss(v),
      crowdCheer: (v) => this.rCrowdCheer(v),
      seagull: (v) => this.rSeagull(v),
      wave: (v) => this.rWave(v),
      thunder: (v) => this.rThunder(v),
      rainLoop: (v) => this.rRainBurst(v),
    };
  }

  /* ---------------------------------------------------------- public API */

  setTrim(v: number): void {
    this.trim = clamp(finiteOr(v, 1), 0, 2);
  }

  /**
   * Fire a one-shot. Returns its duration in seconds, or 0 if it was dropped
   * (audio unavailable / voice cap reached and nothing older to steal).
   */
  play(id: SfxId, opts: SfxPlayOptions = {}): number {
    if (this.disposed) return 0;
    const recipe = this.recipes[id];
    if (!recipe) return 0;

    const now = this.ctx.currentTime;
    this.sweep(now);

    const cap = VOICE_CAP[id] ?? DEFAULT_CAP;
    let count = 0;
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i].id === id) count++;
    if (count >= cap) {
      // Steal the oldest voice of this id rather than dropping the new one:
      // the most recent impact is the one the player cares about.
      let oldestIdx = -1;
      let oldestT = Infinity;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.id === id && v.start < oldestT) {
          oldestT = v.start;
          oldestIdx = i;
        }
      }
      if (oldestIdx < 0) return 0;
      this.killVoice(oldestIdx, now);
    }

    const when = atLeastNow(this.ctx, opts.when);
    const vol = clamp(finiteOr(opts.volume ?? 1, 1), 0, 4) * this.trim;
    const pitch = clamp(finiteOr(opts.pitch ?? 1, 1), 0.25, 4);
    const pan = clamp(finiteOr(opts.pan ?? 0, 0), -1, 1);
    const cutoff = finiteOr(opts.cutoff ?? 20000, 20000);
    const variation = clamp01(finiteOr(opts.variation ?? 1, 1));
    if (vol <= 0.0005) return 0;

    const out = gainNode(this.ctx, 1);
    let tail: AudioNode = out;
    const extra: AudioNode[] = [];

    if (cutoff < 17500) {
      const lp = biquad(this.ctx, 'lowpass', clamp(cutoff, 200, 20000), 0.7);
      tail.connect(lp);
      tail = lp;
      extra.push(lp);
    }
    if (Math.abs(pan) > 0.02) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      tail.connect(p);
      tail = p;
      extra.push(p);
    }
    tail.connect(this.dest);

    const scope = new VoiceScope(this.ctx, out, when, this.rng, pitch, vol, variation);
    try {
      recipe(scope);
    } catch {
      // A recipe must never take the game down.
      safeDisconnect(out);
      for (const n of extra) safeDisconnect(n);
      return 0;
    }

    const nodes = scope.nodes.concat(extra, [out]);
    this.voices.push({
      id,
      nodes,
      sources: scope.sources,
      start: when,
      end: scope.end + 0.05,
    });
    return Math.max(0, scope.end - when);
  }

  /** Sweep finished voices. Cheap; call once per frame. */
  update(): void {
    if (this.disposed) return;
    this.sweep(this.ctx.currentTime);
  }

  /* ------------------------------------------------------------ the loops */

  /** Start (or retarget) a sustained loop. Safe to call repeatedly. */
  startLoop(id: SfxId, params: SfxLoopParams = {}): void {
    if (this.disposed) return;
    let loop = this.loops.get(id);
    if (loop && loop.stopping) {
      this.destroyLoop(loop);
      this.loops.delete(id);
      loop = undefined;
    }
    if (!loop) {
      const built = this.buildLoop(id);
      if (!built) return;
      this.loops.set(id, built);
      loop = built;
    }
    this.setLoopParams(id, params);
  }

  setLoopParams(id: SfxId, params: SfxLoopParams): void {
    const loop = this.loops.get(id);
    if (!loop || loop.stopping) return;
    const t = this.ctx.currentTime;
    if (params.volume !== undefined) {
      loop.level.set(clamp01(finiteOr(params.volume, 0)) * loop.baseLevel * this.trim, t);
    }
    const pitch = clamp(finiteOr(params.pitch ?? 1, 1), 0.35, 3);
    if (loop.tone) loop.tone.set(clamp(loop.baseTone * pitch, 40, 18000), t);
    if (loop.tone2) loop.tone2.set(clamp(loop.baseTone2 * pitch, 40, 19000), t);
    if (loop.rate) loop.rate.set(clamp(loop.baseRate * pitch, 0.1, 6), t);
    if (params.pan !== undefined && loop.panner) {
      loop.panner.pan.setTargetAtTime(clamp(finiteOr(params.pan, 0), -1, 1), t, 0.08);
    }
  }

  /** Fade a loop out and free it. */
  stopLoop(id: SfxId, fade = 0.25): void {
    const loop = this.loops.get(id);
    if (!loop || loop.stopping) return;
    loop.stopping = true;
    const t = this.ctx.currentTime;
    const f = Math.max(0.02, finiteOr(fade, 0.25));
    loop.out.gain.cancelScheduledValues(t);
    setAt(loop.out.gain, Math.max(MIN_GAIN, loop.out.gain.value), t);
    loop.out.gain.exponentialRampToValueAtTime(MIN_GAIN, t + f);
    loop.out.gain.linearRampToValueAtTime(0, t + f + 0.01);
    for (const s of loop.sources) {
      try {
        s.stop(t + f + 0.05);
      } catch {
        /* ignore */
      }
    }
    const finish = (): void => {
      if (this.loops.get(id) === loop) this.loops.delete(id);
      this.destroyLoop(loop);
    };
    if (typeof setTimeout === 'function') setTimeout(finish, (f + 0.12) * 1000);
    else finish();
  }

  isLooping(id: SfxId): boolean {
    const l = this.loops.get(id);
    return !!l && !l.stopping;
  }

  stopAll(): void {
    const now = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) this.killVoice(i, now);
    for (const [id] of this.loops) this.stopLoop(id, 0.05);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) this.killVoice(i, now);
    for (const loop of this.loops.values()) this.destroyLoop(loop);
    this.loops.clear();
  }

  /* -------------------------------------------------------- voice plumbing */

  private sweep(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].end <= now) this.killVoice(i, now);
    }
  }

  private killVoice(index: number, now: number): void {
    const v = this.voices[index];
    this.voices.splice(index, 1);
    for (const s of v.sources) {
      try {
        s.stop(now);
      } catch {
        /* already stopped */
      }
    }
    for (const n of v.nodes) safeDisconnect(n);
  }

  private destroyLoop(loop: LoopVoice): void {
    const t = this.ctx.currentTime;
    for (const s of loop.sources) {
      try {
        s.stop(t);
      } catch {
        /* ignore */
      }
    }
    for (const n of loop.nodes) safeDisconnect(n);
    safeDisconnect(loop.out);
    if (loop.panner) safeDisconnect(loop.panner);
  }

  /* ==================================================================== */
  /*  Loop builders                                                        */
  /* ==================================================================== */

  private buildLoop(id: SfxId): LoopVoice | null {
    switch (id) {
      case 'tireScreech':
        return this.buildScreechLoop();
      case 'boostLoop':
        return this.buildBoostLoop();
      case 'rainLoop':
        return this.buildRainLoop();
      default:
        return null;
    }
  }

  private loopShell(id: SfxId, baseLevel: number): {
    out: GainNode;
    panner: StereoPannerNode;
    nodes: AudioNode[];
    sources: AudioScheduledSourceNode[];
    voice: (tone: SmoothParam | null, tone2: SmoothParam | null, rate: SmoothParam | null, bt: number, bt2: number, br: number) => LoopVoice;
  } {
    const ctx = this.ctx;
    const out = gainNode(ctx, 0);
    const panner = ctx.createStereoPanner();
    out.connect(panner);
    panner.connect(this.dest);
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    return {
      out,
      panner,
      nodes,
      sources,
      voice: (tone, tone2, rate, bt, bt2, br) => ({
        id,
        out,
        panner,
        nodes,
        sources,
        level: new SmoothParam(out.gain, 0.12),
        tone,
        tone2,
        rate,
        baseTone: bt,
        baseTone2: bt2,
        baseRate: br,
        baseLevel,
        stopping: false,
      }),
    };
  }

  /**
   * Sustained tyre squeal. Two resonant bands over a rubber-roll bed, with a
   * slow random wobble on the main band so a 4-second drift never sits on one
   * pitch. `pitch` (driven from slip) sweeps both bands.
   */
  private buildScreechLoop(): LoopVoice {
    const ctx = this.ctx;
    const shell = this.loopShell('tireScreech', 0.5);
    const t = ctx.currentTime;

    const src = noiseSource(ctx, 'white', 1, true);
    const band1 = biquad(ctx, 'bandpass', 1250, 8.5);
    const band2 = biquad(ctx, 'bandpass', 2680, 14);
    const g1 = gainNode(ctx, 0.9);
    const g2 = gainNode(ctx, 0.45);
    const roll = noiseSource(ctx, 'brown', 1, true);
    const rollLp = biquad(ctx, 'lowpass', 520, 1.1);
    const rollG = gainNode(ctx, 0.22);
    const sat = createShaper(ctx, 0.25, 'none');

    src.connect(band1);
    band1.connect(g1);
    g1.connect(sat);
    src.connect(band2);
    band2.connect(g2);
    g2.connect(sat);
    roll.connect(rollLp);
    rollLp.connect(rollG);
    rollG.connect(sat);
    sat.connect(shell.out);

    // Slow squeal wander — a real tyre's contact patch stick-slip is chaotic.
    const lfo = createOsc(ctx, 'sine', 5.3);
    const lfoDepth = gainNode(ctx, 120);
    lfo.connect(lfoDepth);
    lfoDepth.connect(band1.frequency);
    const lfo2 = createOsc(ctx, 'triangle', 0.73);
    const lfo2Depth = gainNode(ctx, 210);
    lfo2.connect(lfo2Depth);
    lfo2Depth.connect(band2.frequency);

    shell.nodes.push(band1, band2, g1, g2, rollLp, rollG, sat, lfoDepth, lfo2Depth, src, roll, lfo, lfo2);
    shell.sources.push(src, roll, lfo, lfo2);
    for (const s of shell.sources) startSource(s, t + 0.005);

    return shell.voice(
      new SmoothParam(band1.frequency, 0.07),
      new SmoothParam(band2.frequency, 0.07),
      null,
      1250,
      2680,
      1,
    );
  }

  /** Turbine roar while the boost is held. */
  private buildBoostLoop(): LoopVoice {
    const ctx = this.ctx;
    const shell = this.loopShell('boostLoop', 0.42);
    const t = ctx.currentTime;

    const air = noiseSource(ctx, 'white', 1, true);
    const airBp = biquad(ctx, 'bandpass', 2300, 2.2);
    const airHp = biquad(ctx, 'highpass', 700, 0.7);
    const airG = gainNode(ctx, 0.5);
    const rumble = noiseSource(ctx, 'brown', 1, true);
    const rumbleLp = biquad(ctx, 'lowpass', 190, 1.4);
    const rumbleG = gainNode(ctx, 0.6);
    const whineA = createOsc(ctx, 'sine', 2640);
    const whineB = createOsc(ctx, 'triangle', 3960, 7);
    const whineG = gainNode(ctx, 0.05);
    const am = createOsc(ctx, 'sine', 6.8);
    const amG = gainNode(ctx, 0.018);

    air.connect(airBp);
    airBp.connect(airHp);
    airHp.connect(airG);
    airG.connect(shell.out);
    rumble.connect(rumbleLp);
    rumbleLp.connect(rumbleG);
    rumbleG.connect(shell.out);
    whineA.connect(whineG);
    whineB.connect(whineG);
    whineG.connect(shell.out);
    am.connect(amG);
    amG.connect(whineG.gain);

    shell.nodes.push(airBp, airHp, airG, rumbleLp, rumbleG, whineG, amG, air, rumble, whineA, whineB, am);
    shell.sources.push(air, rumble, whineA, whineB, am);
    for (const s of shell.sources) startSource(s, t + 0.005);

    return shell.voice(new SmoothParam(airBp.frequency, 0.1), new SmoothParam(whineA.frequency, 0.1), null, 2300, 2640, 1);
  }

  /** Rain on adoquín: broadband hiss plus a resonant sparkle for the stones. */
  private buildRainLoop(): LoopVoice {
    const ctx = this.ctx;
    const shell = this.loopShell('rainLoop', 0.55);
    const t = ctx.currentTime;

    const src = noiseSource(ctx, 'white', 1, true);
    const hp = biquad(ctx, 'highpass', 780, 0.6);
    const lp = biquad(ctx, 'lowpass', 6200, 0.8);
    const spark = biquad(ctx, 'peaking', 3400, 1.4, 7);
    const body = noiseSource(ctx, 'pink', 1, true);
    const bodyBp = biquad(ctx, 'bandpass', 1900, 0.55);
    const bodyG = gainNode(ctx, 0.55);

    src.connect(hp);
    hp.connect(lp);
    lp.connect(spark);
    spark.connect(shell.out);
    body.connect(bodyBp);
    bodyBp.connect(bodyG);
    bodyG.connect(shell.out);

    // Gusts: a slow, irregular sweep of the low-pass.
    const gust = createOsc(ctx, 'sine', 0.11);
    const gust2 = createOsc(ctx, 'triangle', 0.047);
    const gustG = gainNode(ctx, 1500);
    const gust2G = gainNode(ctx, 900);
    gust.connect(gustG);
    gust2.connect(gust2G);
    gustG.connect(lp.frequency);
    gust2G.connect(lp.frequency);

    shell.nodes.push(hp, lp, spark, bodyBp, bodyG, gustG, gust2G, src, body, gust, gust2);
    shell.sources.push(src, body, gust, gust2);
    for (const s of shell.sources) startSource(s, t + 0.005);

    return shell.voice(new SmoothParam(lp.frequency, 0.25), new SmoothParam(bodyBp.frequency, 0.25), null, 6200, 1900, 1);
  }

  /* ==================================================================== */
  /*  One-shot recipes                                                     */
  /* ==================================================================== */

  /** A short burst of squeal — chirps, kerb scuffs, a stab of oversteer. */
  private rTireScreech(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch * v.vary(0.92, 1.12);
    const dur = v.vary(0.35, 0.85);

    const src = v.noise('white');
    const b1 = v.filt('bandpass', 1280 * p, 8);
    const b2 = v.filt('bandpass', 2700 * p, 13);
    const g1 = v.gain(0);
    const g2 = v.gain(0);
    const sat = v.shaper(0.22);
    src.connect(b1);
    b1.connect(g1);
    g1.connect(sat);
    src.connect(b2);
    b2.connect(g2);
    g2.connect(sat);
    sat.connect(v.out);

    // Slip sweep: the squeal rises as the tyre lets go, then falls as it grips.
    b1.frequency.setValueAtTime(950 * p, t);
    b1.frequency.linearRampToValueAtTime(1500 * p, t + dur * 0.4);
    b1.frequency.linearRampToValueAtTime(1050 * p, t + dur);

    const e1 = envPerc(g1.gain, t, 0.45 * v.vol, 0.035, dur);
    envPerc(g2.gain, t, 0.2 * v.vol, 0.05, dur * 0.85);

    // Rubber roll underneath so it is not pure hiss.
    const roll = v.noise('brown');
    const rlp = v.filt('lowpass', 460, 1.2);
    const rg = v.gain(0);
    roll.connect(rlp);
    rlp.connect(rg);
    rg.connect(v.out);
    envPerc(rg.gain, t, 0.1 * v.vol, 0.04, dur);

    v.fire(src, t, e1 + 0.05);
    v.fire(roll, t, e1 + 0.05);
    v.mark(e1 + 0.05);
  }

  /**
   * Collision. Three layers, which is what separates a real impact from a
   * click: the transient (contact), the body (what got hit resonating), and
   * the debris (what fell off afterwards).
   */
  private rImpact(v: VoiceScope, heavy: boolean): void {
    const t = v.t0;
    const p = v.pitch * v.vary(0.9, 1.14);
    // Peak-tuned: at volume 1 the summed layers land around 0.78 full-scale,
    // so even a coherent transient stack cannot clip on its own.
    const amp = v.vol * (heavy ? 0.72 : 0.4);

    const sat = v.shaper(heavy ? 0.55 : 0.32);
    sat.connect(v.out);

    /* -- transient: the initial contact crack -- */
    const tr = v.noise('white');
    const trHp = v.filt('highpass', heavy ? 900 : 1500, 0.7);
    const trG = v.gain(0);
    tr.connect(trHp);
    trHp.connect(trG);
    trG.connect(sat);
    const trEnd = envPerc(trG.gain, t, 0.42 * amp, 0.0008, heavy ? 0.045 : 0.028);
    v.fire(tr, t, trEnd + 0.02);

    /* -- sub thump: the chassis taking the hit -- */
    if (heavy) {
      const sub = v.osc('sine', 140 * p);
      const subG = v.gain(0);
      sub.connect(subG);
      subG.connect(v.out);
      sub.frequency.setValueAtTime(148 * p, t);
      sub.frequency.exponentialRampToValueAtTime(41 * p, t + 0.24);
      const subEnd = envPerc(subG.gain, t, 0.5 * amp, 0.004, 0.3);
      v.fire(sub, t, subEnd + 0.02);
    }

    /* -- body resonances: modes of the panel/pole/wall that was struck -- */
    const modes = heavy
      ? [
          { f: 94, g: 0.3, d: 0.34 },
          { f: 151, g: 0.2, d: 0.26 },
          { f: 238, g: 0.13, d: 0.2 },
          { f: 402, g: 0.07, d: 0.14 },
        ]
      : [
          { f: 218, g: 0.2, d: 0.14 },
          { f: 361, g: 0.13, d: 0.1 },
          { f: 590, g: 0.08, d: 0.07 },
        ];
    for (const m of modes) {
      const f = m.f * p * (1 + v.jitter(0.05));
      const o = v.osc('triangle', f);
      const g = v.gain(0);
      o.connect(g);
      g.connect(sat);
      const e = envPerc(g.gain, t, m.g * amp, 0.002, m.d * v.vary(0.85, 1.2));
      v.fire(o, t, e + 0.02);
    }

    /* -- metallic shimmer -- */
    const met = v.noise('white');
    const metBp = v.filt('bandpass', (heavy ? 2700 : 3600) * p, 3.2);
    const metG = v.gain(0);
    met.connect(metBp);
    metBp.connect(metG);
    metG.connect(v.out);
    const metEnd = envPerc(metG.gain, t, 0.13 * amp, 0.004, heavy ? 0.34 : 0.16);
    v.fire(met, t, metEnd + 0.02);

    /* -- debris: parts arriving late and at random -- */
    const debrisCount = heavy ? 6 : 3;
    const deb = v.noise('white');
    const debBp = v.filt('bandpass', 2000, 6);
    const debG = v.gain(0);
    deb.connect(debBp);
    debBp.connect(debG);
    debG.connect(v.out);
    let last = t;
    debG.gain.setValueAtTime(0, t);
    for (let i = 0; i < debrisCount; i++) {
      const at = t + 0.05 + v.rng.next() * (heavy ? 0.5 : 0.22) * v.variation + i * 0.012;
      const a = 0.11 * amp * (1 - i / (debrisCount + 1)) * v.vary(0.5, 1.2);
      debG.gain.setValueAtTime(0, at);
      debG.gain.linearRampToValueAtTime(a, at + 0.002);
      debG.gain.exponentialRampToValueAtTime(MIN_GAIN, at + 0.045);
      debG.gain.linearRampToValueAtTime(0, at + 0.05);
      debBp.frequency.setValueAtTime(clamp(700 + v.rng.next() * 3600, 200, 9000) * p, at);
      if (at + 0.06 > last) last = at + 0.06;
    }
    v.fire(deb, t, last + 0.02);
    v.mark(last + 0.05);
  }

  /** Crate / stall / sign coming apart: a crack, splinters, then clatter. */
  private rPropBreak(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch * v.vary(0.88, 1.18);
    const amp = v.vol * 0.75;
    const sat = v.shaper(0.4);
    sat.connect(v.out);

    // Initial crack.
    const cr = v.noise('white');
    const crBp = v.filt('bandpass', 1750 * p, 1.8);
    const crG = v.gain(0);
    cr.connect(crBp);
    crBp.connect(crG);
    crG.connect(sat);
    const crEnd = envPerc(crG.gain, t, 0.4 * amp, 0.001, 0.075);
    v.fire(cr, t, crEnd + 0.02);

    // Woody thud — the mass hitting the adoquín.
    const th = v.osc('triangle', 168 * p);
    const thG = v.gain(0);
    th.connect(thG);
    thG.connect(sat);
    th.frequency.setValueAtTime(175 * p, t);
    th.frequency.exponentialRampToValueAtTime(96 * p, t + 0.14);
    const thEnd = envPerc(thG.gain, t, 0.24 * amp, 0.003, 0.17);
    v.fire(th, t, thEnd + 0.02);

    // Splinter grains + clatter tail on one shared, retuned band-pass.
    const gr = v.noise('white');
    const grBp = v.filt('bandpass', 2200, 9);
    const grG = v.gain(0);
    gr.connect(grBp);
    grBp.connect(grG);
    grG.connect(v.out);
    grG.gain.setValueAtTime(0, t);
    let last = t;
    const grains = 7 + Math.floor(v.rng.next() * 5 * v.variation);
    for (let i = 0; i < grains; i++) {
      const frac = i / grains;
      const at = t + 0.01 + Math.pow(frac, 1.4) * 0.55 + v.rng.next() * 0.03;
      const a = 0.16 * amp * (1 - frac * 0.8) * v.vary(0.55, 1.25);
      const d = 0.02 + v.rng.next() * 0.05;
      grG.gain.setValueAtTime(0, at);
      grG.gain.linearRampToValueAtTime(a, at + 0.0015);
      grG.gain.exponentialRampToValueAtTime(MIN_GAIN, at + d);
      grG.gain.linearRampToValueAtTime(0, at + d + 0.004);
      grBp.frequency.setValueAtTime(clamp(650 + v.rng.next() * 3900, 200, 9500) * p, at);
      if (at + d + 0.01 > last) last = at + d + 0.01;
    }
    v.fire(gr, t, last + 0.02);
    v.mark(last + 0.05);
  }

  /** Boost engaged: whoosh + a rising tone + a bright confirmation ping. */
  private rBoostStart(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const amp = v.vol;

    const whoosh = v.noise('white');
    const wbp = v.filt('bandpass', 320 * p, 1.9);
    const wg = v.gain(0);
    whoosh.connect(wbp);
    wbp.connect(wg);
    wg.connect(v.out);
    wbp.frequency.setValueAtTime(300 * p, t);
    wbp.frequency.exponentialRampToValueAtTime(5200 * p, t + 0.46);
    const we = envSwell(wg.gain, t, 0.3 * amp, 0.07, 0.18, 0.26);
    v.fire(whoosh, t, we + 0.02);

    const swp = v.osc('reed', 170 * p, 0, 20);
    const sg = v.gain(0);
    const slp = v.filt('lowpass', 2600, 1.4);
    swp.connect(slp);
    slp.connect(sg);
    sg.connect(v.out);
    swp.frequency.setValueAtTime(165 * p, t);
    swp.frequency.exponentialRampToValueAtTime(880 * p, t + 0.4);
    slp.frequency.setValueAtTime(900, t);
    slp.frequency.exponentialRampToValueAtTime(6500, t + 0.4);
    const se = envSwell(sg.gain, t, 0.2 * amp, 0.03, 0.24, 0.2);
    v.fire(swp, t, se + 0.02);

    // Cyan spark — the arcade "you got it" ping.
    const ping = v.osc('sine', 1760 * p);
    const pingG = v.gain(0);
    ping.connect(pingG);
    pingG.connect(v.out);
    ping.frequency.setValueAtTime(1320 * p, t + 0.02);
    ping.frequency.exponentialRampToValueAtTime(2640 * p, t + 0.14);
    const pe = envPerc(pingG.gain, t + 0.02, 0.11 * amp, 0.004, 0.28);
    v.fire(ping, t + 0.02, pe + 0.02);
    v.mark(Math.max(we, se, pe) + 0.05);
  }

  /** A one-shot slice of the boost loop, for when a loop is overkill. */
  private rBoostBurst(v: VoiceScope): void {
    const t = v.t0;
    const dur = 0.6;
    const src = v.noise('white');
    const bp = v.filt('bandpass', 2400 * v.pitch, 2.2);
    const hp = v.filt('highpass', 700, 0.7);
    const g = v.gain(0);
    src.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(v.out);
    const e = envSwell(g.gain, t, 0.22 * v.vol, 0.05, dur, 0.2);
    const rum = v.noise('brown');
    const rlp = v.filt('lowpass', 190, 1.4);
    const rg = v.gain(0);
    rum.connect(rlp);
    rlp.connect(rg);
    rg.connect(v.out);
    envSwell(rg.gain, t, 0.16 * v.vol, 0.05, dur, 0.2);
    v.fire(src, t, e + 0.02);
    v.fire(rum, t, e + 0.02);
    v.mark(e + 0.05);
  }

  /** Wheels back on the adoquín: suspension, tyres, body rattle. */
  private rLanding(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch * v.vary(0.92, 1.1);
    const amp = v.vol;
    const sat = v.shaper(0.3);
    sat.connect(v.out);

    // Suspension bottoming out.
    const sub = v.osc('sine', 86 * p);
    const subG = v.gain(0);
    sub.connect(subG);
    subG.connect(v.out);
    sub.frequency.setValueAtTime(92 * p, t);
    sub.frequency.exponentialRampToValueAtTime(36 * p, t + 0.19);
    const subEnd = envPerc(subG.gain, t, 0.42 * amp, 0.003, 0.22);
    v.fire(sub, t, subEnd + 0.02);

    // Tyre slap.
    const slap = v.noise('white');
    const slapLp = v.filt('lowpass', 1100 * p, 1.5);
    const slapG = v.gain(0);
    slap.connect(slapLp);
    slapLp.connect(slapG);
    slapG.connect(sat);
    const slapEnd = envPerc(slapG.gain, t, 0.3 * amp, 0.001, 0.11);
    v.fire(slap, t, slapEnd + 0.02);

    // Chirp of rubber as the tyres regain grip.
    const chirp = v.noise('white');
    const chirpBp = v.filt('bandpass', 1450 * p, 9);
    const chirpG = v.gain(0);
    chirp.connect(chirpBp);
    chirpBp.connect(chirpG);
    chirpG.connect(v.out);
    chirpBp.frequency.setValueAtTime(1250 * p, t + 0.01);
    chirpBp.frequency.linearRampToValueAtTime(1750 * p, t + 0.13);
    const chirpEnd = envPerc(chirpG.gain, t + 0.01, 0.16 * amp, 0.012, 0.2);
    v.fire(chirp, t + 0.01, chirpEnd + 0.02);

    // Cage / cargo rattle.
    const rat = v.noise('white');
    const ratBp = v.filt('bandpass', 3000, 7);
    const ratG = v.gain(0);
    rat.connect(ratBp);
    ratBp.connect(ratG);
    ratG.connect(v.out);
    ratG.gain.setValueAtTime(0, t);
    let last = t;
    for (let i = 0; i < 5; i++) {
      const at = t + 0.02 + v.rng.next() * 0.3 * v.variation;
      const a = 0.07 * amp * v.vary(0.4, 1.1);
      ratG.gain.setValueAtTime(0, at);
      ratG.gain.linearRampToValueAtTime(a, at + 0.0015);
      ratG.gain.exponentialRampToValueAtTime(MIN_GAIN, at + 0.035);
      ratG.gain.linearRampToValueAtTime(0, at + 0.04);
      ratBp.frequency.setValueAtTime(clamp(1800 + v.rng.next() * 3200, 400, 9000), at);
      if (at + 0.05 > last) last = at + 0.05;
    }
    v.fire(rat, t, last + 0.02);
    v.mark(Math.max(last, subEnd, chirpEnd) + 0.05);
  }

  /** Leaving the ramp: suspension unloading and a rush of air. */
  private rJumpTakeoff(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const amp = v.vol;

    const sw = v.noise('white');
    const swBp = v.filt('bandpass', 600 * p, 1.6);
    const swG = v.gain(0);
    sw.connect(swBp);
    swBp.connect(swG);
    swG.connect(v.out);
    swBp.frequency.setValueAtTime(520 * p, t);
    swBp.frequency.exponentialRampToValueAtTime(3100 * p, t + 0.26);
    const swEnd = envSwell(swG.gain, t, 0.2 * amp, 0.05, 0.06, 0.18);
    v.fire(sw, t, swEnd + 0.02);

    // Spring release — a rising body with a fast wobble on it.
    const spr = v.osc('triangle', 230 * p);
    const sprG = v.gain(0);
    spr.connect(sprG);
    sprG.connect(v.out);
    spr.frequency.setValueAtTime(215 * p, t);
    spr.frequency.exponentialRampToValueAtTime(520 * p, t + 0.2);
    const vib = v.osc('sine', 15);
    const vibG = v.gain(28);
    vib.connect(vibG);
    vibG.connect(spr.detune);
    const sprEnd = envPerc(sprG.gain, t, 0.17 * amp, 0.006, 0.24);
    v.fire(spr, t, sprEnd + 0.02);
    v.fire(vib, t, sprEnd + 0.02);
    v.mark(Math.max(swEnd, sprEnd) + 0.05);
  }

  /**
   * The horn. A real dual-tone air horn is two reeds a major third apart; the
   * character here comes from the pitch scoop on the attack, a little vibrato,
   * and a formant band that makes it sound like it is coming out of a chromed
   * trumpet bell bolted to a roll cage.
   */
  private rHorn(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch * v.vary(0.985, 1.02);
    const amp = v.vol;
    const hold = v.vary(0.24, 0.42);

    const body = v.filt('bandpass', 920 * p, 1.1);
    const sat = v.shaper(0.42);
    const peak = v.filt('peaking', 1850 * p, 2.2, 6);
    body.connect(sat);
    sat.connect(peak);
    peak.connect(v.out);

    const vib = v.osc('sine', 5.6);
    const vibG = v.gain(7);
    vib.connect(vibG);

    const tones = [
      { f: 421 * p, g: 0.28 },
      { f: 527 * p, g: 0.24 },
      { f: 842 * p, g: 0.07 },
    ];
    let end = t;
    for (const tone of tones) {
      const o = v.osc('reed', tone.f, 0, 18);
      const g = v.gain(0);
      o.connect(g);
      g.connect(body);
      vibG.connect(o.detune);
      // Attack scoop: air horns take a few tens of ms to reach pitch.
      o.frequency.setValueAtTime(tone.f * 0.87, t);
      o.frequency.exponentialRampToValueAtTime(tone.f, t + 0.045);
      // Release sag as the pressure drops.
      o.frequency.setValueAtTime(tone.f, t + 0.02 + hold);
      o.frequency.exponentialRampToValueAtTime(tone.f * 0.93, t + 0.02 + hold + 0.09);
      const e = envPerc(g.gain, t, tone.g * amp, 0.018, hold + 0.12);
      v.fire(o, t, e + 0.02);
      if (e > end) end = e;
    }
    v.fire(vib, t, end + 0.02);
    v.mark(end + 0.05);
  }

  /* -------------------------------------------------- musical UI recipes */

  /**
   * Shared plucked-string voice: a cuatro-ish tone used for all the musical
   * stingers so the UI and the score sound like one instrument family.
   */
  private pluckNote(
    v: VoiceScope,
    freq: number,
    at: number,
    amp: number,
    decay: number,
    bright = 1,
  ): number {
    const f = clamp(freq, 30, 8000);
    const lp = v.filt('lowpass', clamp(f * 6.5 * bright, 400, 14000), 0.9);
    const g = v.gain(0);
    lp.connect(g);
    g.connect(v.out);

    // Two slightly detuned strings — a cuatro is strung in double courses.
    for (const d of [-6, 6]) {
      const o = v.osc('pluck', f, d, 20);
      const og = v.gain(0.5);
      o.connect(og);
      og.connect(lp);
      v.fire(o, at, at + decay + 0.08);
    }
    // Pick noise.
    const pk = v.noise('white');
    const pkBp = v.filt('bandpass', clamp(f * 5, 800, 9000), 2.5);
    const pkG = v.gain(0);
    pk.connect(pkBp);
    pkBp.connect(pkG);
    pkG.connect(v.out);
    envPerc(pkG.gain, at, 0.05 * amp, 0.0008, 0.02);
    v.fire(pk, at, at + 0.06);

    const end = envPerc(g.gain, at, amp, 0.004, decay);
    v.mark(end);
    return end;
  }

  /** Inharmonic struck bell, used for cash, time bonus and church chimes. */
  private bellNote(v: VoiceScope, freq: number, at: number, amp: number, decay: number): number {
    // Partial ratios of a struck bell: hum, prime, minor third, fifth, nominal.
    const ratios = [0.5, 1, 1.19, 1.51, 2.0, 2.66];
    const gains = [0.3, 1, 0.55, 0.38, 0.42, 0.16];
    const decays = [1.5, 1, 0.72, 0.6, 0.45, 0.28];
    let end = at;
    for (let i = 0; i < ratios.length; i++) {
      const o = v.osc('sine', clamp(freq * ratios[i], 20, 14000));
      const g = v.gain(0);
      o.connect(g);
      g.connect(v.out);
      const e = envPerc(g.gain, at, amp * gains[i] * 0.34, 0.003, decay * decays[i]);
      v.fire(o, at, e + 0.02);
      if (e > end) end = e;
    }
    v.mark(end);
    return end;
  }

  /** Bright, ascending: a fare gets in. Minor pentatonic, so it stays in key. */
  private rPickup(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const notes = [440, 523.25, 659.25];
    let end = t;
    for (let i = 0; i < notes.length; i++) {
      const at = t + i * 0.075;
      end = this.pluckNote(v, notes[i] * p, at, 0.2 * v.vol, 0.55, 1.15);
    }
    // Maraca tick so it lands in the same world as the music.
    const sh = v.noise('white');
    const shHp = v.filt('highpass', 4200, 0.8);
    const shG = v.gain(0);
    sh.connect(shHp);
    shHp.connect(shG);
    shG.connect(v.out);
    envPerc(shG.gain, t, 0.09 * v.vol, 0.001, 0.045);
    v.fire(sh, t, t + 0.09);
    v.mark(end + 0.05);
  }

  /** The fare is delivered: a resolving flourish plus a güiro flick. */
  private rDropoff(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const notes = [659.25, 783.99, 880, 1046.5];
    let end = t;
    for (let i = 0; i < notes.length; i++) {
      end = this.pluckNote(v, notes[i] * p, t + i * 0.062, 0.19 * v.vol, 0.5, 1.2);
    }
    const bellEnd = this.bellNote(v, 1046.5 * p, t + 0.19, 0.3 * v.vol, 0.9);

    // Güiro up-scrape — a ratcheted band of noise.
    const gu = v.noise('white');
    const guBp = v.filt('bandpass', 2500, 3.4);
    const guG = v.gain(0);
    gu.connect(guBp);
    guBp.connect(guG);
    guG.connect(v.out);
    guG.gain.setValueAtTime(0, t);
    for (let i = 0; i < 9; i++) {
      const at = t + i * 0.013;
      guG.gain.setValueAtTime(0, at);
      guG.gain.linearRampToValueAtTime(0.08 * v.vol * (1 - i / 12), at + 0.002);
      guG.gain.linearRampToValueAtTime(0, at + 0.011);
    }
    guBp.frequency.setValueAtTime(1900, t);
    guBp.frequency.linearRampToValueAtTime(3400, t + 0.12);
    v.fire(gu, t, t + 0.2);
    v.mark(Math.max(end, bellEnd) + 0.05);
  }

  /** Ka-ching: two bells and a drawer. */
  private rCashRegister(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const a = this.bellNote(v, 2093 * p, t, 0.34 * v.vol, 0.55);
    const b = this.bellNote(v, 1567.98 * p, t + 0.085, 0.3 * v.vol, 0.8);

    const dr = v.noise('white');
    const drLp = v.filt('lowpass', 700, 1.2);
    const drG = v.gain(0);
    dr.connect(drLp);
    drLp.connect(drG);
    drG.connect(v.out);
    const drEnd = envPerc(drG.gain, t + 0.14, 0.2 * v.vol, 0.002, 0.13);

    const thud = v.osc('triangle', 128 * p);
    const thudG = v.gain(0);
    thud.connect(thudG);
    thudG.connect(v.out);
    thud.frequency.setValueAtTime(132 * p, t + 0.14);
    thud.frequency.exponentialRampToValueAtTime(78 * p, t + 0.26);
    envPerc(thudG.gain, t + 0.14, 0.18 * v.vol, 0.003, 0.16);

    v.fire(dr, t + 0.14, drEnd + 0.02);
    v.fire(thud, t + 0.14, drEnd + 0.05);
    v.mark(Math.max(a, b, drEnd) + 0.05);
  }

  /** Combo tick. Caller passes rising `pitch` as the chain grows. */
  private rComboUp(v: VoiceScope): void {
    const t = v.t0;
    const f = clamp(659.25 * v.pitch, 180, 4200);
    const end = this.pluckNote(v, f, t, 0.16 * v.vol, 0.3, 1.4);
    const o = v.osc('sine', f * 2);
    const g = v.gain(0);
    o.connect(g);
    g.connect(v.out);
    o.frequency.setValueAtTime(f * 1.88, t);
    o.frequency.exponentialRampToValueAtTime(f * 2.04, t + 0.06);
    const e2 = envPerc(g.gain, t, 0.08 * v.vol, 0.003, 0.22);
    v.fire(o, t, e2 + 0.02);
    v.mark(Math.max(end, e2) + 0.05);
  }

  /** Combo lost: a detuned fall through a closing filter. */
  private rComboBreak(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const lp = v.filt('lowpass', 2400, 3.2);
    lp.connect(v.out);
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.42);
    let end = t;
    for (const [f, det] of [
      [330, -14],
      [311.13, 12],
    ] as const) {
      const o = v.osc('reed', f * p, det, 14);
      const g = v.gain(0);
      o.connect(g);
      g.connect(lp);
      o.frequency.setValueAtTime(f * p, t);
      o.frequency.exponentialRampToValueAtTime(f * p * 0.55, t + 0.4);
      const e = envPerc(g.gain, t, 0.15 * v.vol, 0.008, 0.42);
      v.fire(o, t, e + 0.02);
      if (e > end) end = e;
    }
    const n = v.noise('pink');
    const nbp = v.filt('bandpass', 900, 1.2);
    const ng = v.gain(0);
    n.connect(nbp);
    nbp.connect(ng);
    ng.connect(v.out);
    nbp.frequency.setValueAtTime(1200, t);
    nbp.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    envPerc(ng.gain, t, 0.07 * v.vol, 0.01, 0.4);
    v.fire(n, t, end + 0.02);
    v.mark(end + 0.05);
  }

  /** Clave tick — two hardwood sticks. The countdown's heartbeat. */
  private rCountdownTick(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    let end = t;
    for (const [f, g] of [
      [2500, 0.2],
      [3230, 0.1],
      [1210, 0.06],
    ] as const) {
      const o = v.osc('sine', f * p);
      const gn = v.gain(0);
      o.connect(gn);
      gn.connect(v.out);
      const e = envPerc(gn.gain, t, g * v.vol, 0.0008, 0.055);
      v.fire(o, t, e + 0.02);
      if (e > end) end = e;
    }
    const cl = v.noise('white');
    const clBp = v.filt('bandpass', 2900 * p, 2.4);
    const clG = v.gain(0);
    cl.connect(clBp);
    clBp.connect(clG);
    clG.connect(v.out);
    envPerc(clG.gain, t, 0.11 * v.vol, 0.0005, 0.012);
    v.fire(cl, t, t + 0.05);
    v.mark(end + 0.05);
  }

  /** GO! A bright A-major stab with a crash — the Picardy lift out of A minor. */
  private rCountdownGo(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const sat = v.shaper(0.35);
    const bp = v.filt('peaking', 1400, 1.6, 5);
    sat.connect(bp);
    bp.connect(v.out);
    let end = t;
    for (const f of [220, 277.18, 329.63, 440, 554.37]) {
      const o = v.osc('reed', f * p, v.jitter(6), 20);
      const g = v.gain(0);
      o.connect(g);
      g.connect(sat);
      o.frequency.setValueAtTime(f * p * 0.94, t);
      o.frequency.exponentialRampToValueAtTime(f * p, t + 0.05);
      const e = envPerc(g.gain, t, 0.085 * v.vol, 0.012, 0.62);
      v.fire(o, t, e + 0.02);
      if (e > end) end = e;
    }
    const crash = v.noise('white');
    const crHp = v.filt('highpass', 3200, 0.6);
    const crG = v.gain(0);
    crash.connect(crHp);
    crHp.connect(crG);
    crG.connect(v.out);
    const ce = envPerc(crG.gain, t, 0.14 * v.vol, 0.002, 0.75);
    v.fire(crash, t, ce + 0.02);

    const thump = v.osc('sine', 110 * p);
    const tg = v.gain(0);
    thump.connect(tg);
    tg.connect(v.out);
    thump.frequency.setValueAtTime(120 * p, t);
    thump.frequency.exponentialRampToValueAtTime(52 * p, t + 0.2);
    envPerc(tg.gain, t, 0.26 * v.vol, 0.004, 0.24);
    v.fire(thump, t, t + 0.3);
    v.mark(Math.max(end, ce) + 0.05);
  }

  /** More time on the clock: a rising figure plus a shimmering bell. */
  private rTimeExtend(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const notes = [440, 523.25, 659.25, 783.99, 880];
    let end = t;
    for (let i = 0; i < notes.length; i++) {
      end = this.pluckNote(v, notes[i] * p, t + i * 0.055, 0.14 * v.vol, 0.45, 1.3);
    }
    const b = this.bellNote(v, 1760 * p, t + 0.22, 0.24 * v.vol, 1.1);
    v.mark(Math.max(end, b) + 0.05);
  }

  private rUiMove(v: VoiceScope): void {
    const t = v.t0;
    const end = this.pluckNote(v, 880 * v.pitch, t, 0.16 * v.vol, 0.13, 1.6);
    v.mark(end + 0.02);
  }

  private rUiConfirm(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    this.pluckNote(v, 659.25 * p, t, 0.2 * v.vol, 0.22, 1.5);
    const end = this.pluckNote(v, 987.77 * p, t + 0.062, 0.22 * v.vol, 0.34, 1.5);
    v.mark(end + 0.02);
  }

  private rUiBack(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    this.pluckNote(v, 587.33 * p, t, 0.17 * v.vol, 0.18, 0.9);
    const end = this.pluckNote(v, 415.3 * p, t + 0.055, 0.19 * v.vol, 0.3, 0.8);
    v.mark(end + 0.02);
  }

  /**
   * Near miss. A Doppler whoosh: the band sweeps up as the object closes and
   * down as it passes, the level peaks at the pass, and the image swings
   * across the stereo field.
   */
  private rNearMiss(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch;
    const amp = v.vol;
    const dur = 0.42;

    const pan = this.ctx.createStereoPanner();
    v.reg(pan);
    pan.connect(v.out);
    const side = v.rng.bool() ? 1 : -1;
    pan.pan.setValueAtTime(-0.85 * side, t);
    pan.pan.linearRampToValueAtTime(0.85 * side, t + dur);

    const air = v.noise('white');
    const bp = v.filt('bandpass', 500 * p, 3.6);
    const g = v.gain(0);
    air.connect(bp);
    bp.connect(g);
    g.connect(pan);
    bp.frequency.setValueAtTime(420 * p, t);
    bp.frequency.exponentialRampToValueAtTime(2700 * p, t + dur * 0.45);
    bp.frequency.exponentialRampToValueAtTime(430 * p, t + dur);
    const e = envSwell(g.gain, t, 0.26 * amp, dur * 0.42, 0.02, dur * 0.5);
    v.fire(air, t, e + 0.02);

    // The tonal part of the Doppler — a real pitch drop as it goes past.
    const tone = v.osc('triangle', 700 * p);
    const tg = v.gain(0);
    const tlp = v.filt('lowpass', 2200, 1.1);
    tone.connect(tlp);
    tlp.connect(tg);
    tg.connect(pan);
    tone.frequency.setValueAtTime(760 * p, t);
    tone.frequency.exponentialRampToValueAtTime(380 * p, t + dur);
    const te = envSwell(tg.gain, t, 0.1 * amp, dur * 0.4, 0.02, dur * 0.5);
    v.fire(tone, t, te + 0.02);
    v.mark(Math.max(e, te) + 0.05);
  }

  /**
   * Crowd cheer. Three vocal formant bands over pink noise, swelling, with a
   * handful of individual whoops on top so it reads as people rather than
   * as a hiss.
   */
  private rCrowdCheer(v: VoiceScope): void {
    const t = v.t0;
    const amp = v.vol;
    const dur = v.vary(1.1, 1.8);

    const src = v.noise('pink');
    const bus = v.gain(0);
    bus.connect(v.out);
    for (const [f, q, g] of [
      [560, 1.5, 1],
      [1150, 1.8, 0.6],
      [2450, 2.2, 0.32],
    ] as const) {
      const bp = v.filt('bandpass', f, q);
      const bg = v.gain(g * 0.6);
      src.connect(bp);
      bp.connect(bg);
      bg.connect(bus);
    }
    const e = envSwell(bus.gain, t, 0.5 * amp, dur * 0.3, dur * 0.25, dur * 0.55);
    v.fire(src, t, e + 0.02);

    // Individual voices.
    for (let i = 0; i < 5; i++) {
      const at = t + v.rng.next() * dur * 0.7;
      const f = 260 + v.rng.next() * 320;
      const o = v.osc('saw', f, 0, 12);
      const bp = v.filt('bandpass', f * 3.2, 3);
      const g = v.gain(0);
      o.connect(bp);
      bp.connect(g);
      g.connect(v.out);
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(f * 1.35, at + 0.12);
      o.frequency.exponentialRampToValueAtTime(f * 0.9, at + 0.3);
      const ge = envPerc(g.gain, at, 0.08 * amp * v.vary(0.5, 1.2), 0.05, 0.28);
      v.fire(o, at, ge + 0.02);
    }
    v.mark(e + 0.1);
  }

  /** Gull cry over the Atlantic: a descending series of vibrato'd yelps. */
  private rSeagull(v: VoiceScope): void {
    const t = v.t0;
    const p = v.pitch * v.vary(0.88, 1.15);
    const amp = v.vol * 2.6;
    const cries = 2 + Math.floor(v.rng.next() * 3 * v.variation);
    let at = t;
    let end = t;
    for (let i = 0; i < cries; i++) {
      const top = (1850 - i * 130) * p;
      const o = v.osc('reed', top, 0, 12);
      const bp = v.filt('bandpass', 2100 * p, 2.6);
      const g = v.gain(0);
      o.connect(bp);
      bp.connect(g);
      g.connect(v.out);
      o.frequency.setValueAtTime(top * 0.8, at);
      o.frequency.exponentialRampToValueAtTime(top, at + 0.035);
      o.frequency.exponentialRampToValueAtTime(top * 0.52, at + 0.19);
      const vib = v.osc('sine', 24);
      const vibG = v.gain(55);
      vib.connect(vibG);
      vibG.connect(o.detune);
      const e = envPerc(g.gain, at, 0.16 * amp * v.vary(0.7, 1.15), 0.012, 0.2);
      v.fire(o, at, e + 0.02);
      v.fire(vib, at, e + 0.02);
      end = e;
      at += 0.19 + v.rng.next() * 0.13;
    }
    v.mark(end + 0.05);
  }

  /** A breaker on the sea wall: swell, then foam draining back. */
  private rWave(v: VoiceScope): void {
    const t = v.t0;
    const amp = v.vol;
    const dur = v.vary(2.2, 3.4);

    const body = v.noise('brown');
    const lp = v.filt('lowpass', 320, 1.6);
    const g = v.gain(0);
    body.connect(lp);
    lp.connect(g);
    g.connect(v.out);
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.4);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    const e = envSwell(g.gain, t, 0.3 * amp, dur * 0.38, dur * 0.1, dur * 0.5);
    v.fire(body, t, e + 0.02);

    // Foam hiss arrives after the body of the wave.
    const foam = v.noise('white');
    const hp = v.filt('highpass', 1800, 0.7);
    const fg = v.gain(0);
    foam.connect(hp);
    hp.connect(fg);
    fg.connect(v.out);
    const fe = envSwell(fg.gain, t + dur * 0.3, 0.1 * amp, dur * 0.2, dur * 0.1, dur * 0.45);
    v.fire(foam, t + dur * 0.3, fe + 0.02);
    v.mark(Math.max(e, fe) + 0.05);
  }

  /** Thunder: the crack, then the roll, then the far echo. */
  private rThunder(v: VoiceScope): void {
    const t = v.t0;
    const amp = v.vol;
    // `pitch` here doubles as distance: 1 = right overhead, 0.6 = far off.
    const near = clamp01((v.pitch - 0.55) / 0.45);

    const sat = v.shaper(0.5);
    sat.connect(v.out);

    if (near > 0.15) {
      const crack = v.noise('white');
      const bp = v.filt('bandpass', 780, 1.3);
      const g = v.gain(0);
      crack.connect(bp);
      bp.connect(g);
      g.connect(sat);
      const ce = envPerc(g.gain, t, 0.3 * amp * near, 0.004, 0.28);
      v.fire(crack, t, ce + 0.02);
    }

    const roll = v.noise('brown');
    const lp = v.filt('lowpass', 150, 1.5);
    const g = v.gain(0);
    roll.connect(lp);
    lp.connect(g);
    g.connect(v.out);
    lp.frequency.setValueAtTime(90 + near * 180, t);
    lp.frequency.linearRampToValueAtTime(70, t + 3.4);
    // Hand-drawn roll: several overlapping swells rather than one hump.
    g.gain.setValueAtTime(0, t);
    let peak = 0;
    const rolls = 4;
    let last = t;
    for (let i = 0; i < rolls; i++) {
      const at = t + 0.05 + i * v.vary(0.5, 0.95);
      const a = 0.34 * amp * (1 - i / (rolls + 1)) * v.vary(0.55, 1.15);
      peak = Math.max(peak, a);
      g.gain.linearRampToValueAtTime(a, at + 0.28);
      g.gain.linearRampToValueAtTime(a * 0.28, at + 0.75);
      last = at + 0.75;
    }
    g.gain.linearRampToValueAtTime(0, last + 1.1);
    v.fire(roll, t, last + 1.2);
    v.mark(last + 1.25);
  }

  /** A short burst of rain, for when the loop is not warranted. */
  private rRainBurst(v: VoiceScope): void {
    const t = v.t0;
    const dur = 1.4;
    const src = v.noise('white');
    const hp = v.filt('highpass', 780, 0.6);
    const lp = v.filt('lowpass', 6000, 0.8);
    const g = v.gain(0);
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(v.out);
    const e = envSwell(g.gain, t, 0.2 * v.vol, 0.35, dur, 0.6);
    v.fire(src, t, e + 0.02);
    v.mark(e + 0.05);
  }
}
