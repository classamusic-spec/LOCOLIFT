/**
 * Synth.ts — Loco Lift's DSP toolkit.
 *
 * Every sound in the game is manufactured at runtime from these primitives:
 * band-limited oscillators, noise buffers, envelopes, filters, wave-shapers,
 * procedurally generated convolution impulse responses and a feedback delay.
 * Nothing is loaded from disk or network — the game is fully offline.
 *
 * Conventions used throughout the audio module:
 *  - Every scheduled value change goes through a ramp helper so we never get
 *    "zipper" noise from assigning `param.value` in a frame loop.
 *  - Envelopes always finish on an explicit zero so voices are genuinely
 *    silent when they end (an exponential ramp alone never reaches 0).
 *  - Nothing here throws on a bad number; non-finite input is clamped so a
 *    single NaN from gameplay can never kill the audio graph.
 */

import { clamp, clamp01 } from '../core/MathUtils';
import { RNG } from '../core/RNG';

/** Smallest gain we will ever hand to an exponential ramp. */
export const MIN_GAIN = 1e-4;

/* ------------------------------------------------------------------ misc */

/** Replace NaN/Infinity with a sane fallback. */
export function finiteOr(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(MIN_GAIN, g));

/** Frequency ratio for `n` equal-tempered semitones. */
export const semitoneRatio = (n: number): number => Math.pow(2, n / 12);

/** MIDI note number -> Hz (69 = A4 = 440). */
export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Never schedule in the past — Web Audio silently drops those events. */
export function atLeastNow(ctx: BaseAudioContext, t?: number): number {
  const now = ctx.currentTime;
  const v = finiteOr(t ?? now, now);
  return v < now ? now : v;
}

/* ------------------------------------------------------- param scheduling */

export function setAt(p: AudioParam, value: number, t: number): void {
  p.setValueAtTime(finiteOr(value), finiteOr(t));
}

export function linTo(p: AudioParam, value: number, t: number): void {
  p.linearRampToValueAtTime(finiteOr(value), finiteOr(t));
}

/**
 * Exponential ramp with the two footguns handled: the target is clamped away
 * from zero, and the ramp is anchored by a `setValueAtTime` so it starts from
 * a known non-zero value.
 */
export function expTo(p: AudioParam, value: number, t: number, from?: number): void {
  const end = finiteOr(t);
  if (from !== undefined) p.setValueAtTime(Math.max(MIN_GAIN, finiteOr(from, MIN_GAIN)), end - 0.0001);
  p.exponentialRampToValueAtTime(Math.max(MIN_GAIN, finiteOr(value, MIN_GAIN)), end);
}

/**
 * Smooth glide toward a value — the workhorse for per-frame parameter updates.
 * `tau` is the exponential time constant in seconds (≈ 63 % of the way there).
 */
export function glideTo(p: AudioParam, value: number, t: number, tau = 0.05): void {
  p.setTargetAtTime(finiteOr(value), finiteOr(t), Math.max(0.001, finiteOr(tau, 0.05)));
}

export function cancelFrom(p: AudioParam, t: number): void {
  const time = finiteOr(t);
  // cancelAndHoldAtTime is nicer but is still not universal; fall back safely.
  const anyParam = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof anyParam.cancelAndHoldAtTime === 'function') anyParam.cancelAndHoldAtTime(time);
  else p.cancelScheduledValues(time);
}

/* --------------------------------------------------------------- envelopes */

export interface ADSR {
  /** seconds to peak */
  attack: number;
  /** seconds from peak to sustain */
  decay: number;
  /** 0..1 fraction of peak held while the note is gated */
  sustain: number;
  /** seconds from sustain to silence */
  release: number;
}

/**
 * Percussive / plucked envelope: fast linear attack, exponential decay, then a
 * short linear tail to a true zero so the voice is provably silent.
 * Returns the time at which the envelope reaches zero.
 */
export function envPerc(
  p: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  const start = finiteOr(t0);
  const a = Math.max(0.0005, finiteOr(attack, 0.002));
  const d = Math.max(0.005, finiteOr(decay, 0.1));
  const pk = Math.max(MIN_GAIN, finiteOr(peak, 0.1));
  p.cancelScheduledValues(start);
  p.setValueAtTime(0, start);
  p.linearRampToValueAtTime(pk, start + a);
  p.exponentialRampToValueAtTime(Math.max(MIN_GAIN, pk * 0.0015), start + a + d);
  const end = start + a + d + 0.008;
  p.linearRampToValueAtTime(0, end);
  return end;
}

/**
 * Gated ADSR. `gate` is how long the note is held *after* the attack+decay.
 * Returns the time at which the envelope reaches zero.
 */
export function envADSR(p: AudioParam, t0: number, peak: number, env: ADSR, gate: number): number {
  const start = finiteOr(t0);
  const pk = Math.max(MIN_GAIN, finiteOr(peak, 0.1));
  const a = Math.max(0.0005, finiteOr(env.attack, 0.01));
  const d = Math.max(0.002, finiteOr(env.decay, 0.05));
  const s = clamp01(finiteOr(env.sustain, 0.6));
  const r = Math.max(0.005, finiteOr(env.release, 0.15));
  const hold = Math.max(0, finiteOr(gate, 0.1));
  p.cancelScheduledValues(start);
  p.setValueAtTime(0, start);
  p.linearRampToValueAtTime(pk, start + a);
  p.exponentialRampToValueAtTime(Math.max(MIN_GAIN, pk * s), start + a + d);
  const relStart = start + a + d + hold;
  p.setValueAtTime(Math.max(MIN_GAIN, pk * s), relStart);
  p.exponentialRampToValueAtTime(MIN_GAIN, relStart + r);
  const end = relStart + r + 0.008;
  p.linearRampToValueAtTime(0, end);
  return end;
}

/** Slow swell used by ambience beds: silence -> peak -> silence. */
export function envSwell(
  p: AudioParam,
  t0: number,
  peak: number,
  rise: number,
  hold: number,
  fall: number,
): number {
  const start = finiteOr(t0);
  const pk = Math.max(MIN_GAIN, finiteOr(peak, 0.1));
  p.cancelScheduledValues(start);
  p.setValueAtTime(0, start);
  p.linearRampToValueAtTime(pk, start + Math.max(0.01, rise));
  const holdEnd = start + rise + Math.max(0, hold);
  p.setValueAtTime(pk, holdEnd);
  p.exponentialRampToValueAtTime(MIN_GAIN, holdEnd + Math.max(0.02, fall));
  const end = holdEnd + fall + 0.01;
  p.linearRampToValueAtTime(0, end);
  return end;
}

/* ------------------------------------------------------------------ noise */

export type NoiseKind = 'white' | 'pink' | 'brown';

/**
 * Generate a stereo noise buffer. The two channels are generated from
 * independent streams so the result is genuinely wide rather than a mono
 * signal duplicated (which collapses to the centre and sounds thin).
 */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  kind: NoiseKind = 'white',
  seed = 0x5eed,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(Math.max(0.05, seconds) * sr));
  const buf = ctx.createBuffer(2, len, sr);

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const rng = new RNG((seed ^ (ch * 0x9e3779b1)) >>> 0);

    if (kind === 'white') {
      for (let i = 0; i < len; i++) data[i] = rng.next() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellett's economy pink filter — flat-ish -3 dB/octave.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = rng.next() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    } else {
      // Brown / red noise: leaky integrator, -6 dB/octave.
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = rng.next() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last;
      }
    }

    // Normalise to a known peak so downstream gains mean something, and
    // remove any DC the filters introduced.
    let sum = 0;
    for (let i = 0; i < len; i++) sum += data[i];
    const dc = sum / len;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      data[i] -= dc;
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    const norm = peak > 1e-6 ? 0.92 / peak : 0;
    for (let i = 0; i < len; i++) data[i] *= norm;

    // A short cross-fade at the seam so looped playback has no click.
    const fade = Math.min(512, Math.floor(len / 8));
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i] * t + data[len - fade + i] * (1 - t);
    }
  }
  return buf;
}

/** Long noise loops are expensive to build; one per context per colour. */
const noiseCache = new WeakMap<BaseAudioContext, Map<NoiseKind, AudioBuffer>>();

export function sharedNoise(ctx: BaseAudioContext, kind: NoiseKind = 'white'): AudioBuffer {
  let m = noiseCache.get(ctx);
  if (!m) {
    m = new Map();
    noiseCache.set(ctx, m);
  }
  let b = m.get(kind);
  if (!b) {
    // 3 s is long enough that the loop period is not perceptible under a
    // moving filter, short enough to build in a couple of milliseconds.
    b = createNoiseBuffer(ctx, 3, kind, 0x10c0 ^ kind.length * 7919);
    m.set(kind, b);
  }
  return b;
}

/** A looping (or one-shot) noise voice off the shared buffer. */
export function noiseSource(
  ctx: BaseAudioContext,
  kind: NoiseKind = 'white',
  playbackRate = 1,
  loop = true,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = sharedNoise(ctx, kind);
  src.loop = loop;
  src.playbackRate.value = clamp(finiteOr(playbackRate, 1), 0.05, 8);
  return src;
}

/* -------------------------------------------------------- periodic waves */

export type WaveKind =
  | 'saw'
  | 'square'
  | 'pulse25'
  | 'triangle'
  | 'organ'
  | 'pluck'
  | 'engine'
  | 'reed'
  | 'string';

interface WaveKey {
  kind: WaveKind;
  partials: number;
}

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/** Harmonic amplitude for a given wave shape. Sign matters for triangle. */
function partialAmplitude(kind: WaveKind, n: number): number {
  switch (kind) {
    case 'saw':
      return 1 / n;
    case 'square':
      return n % 2 === 1 ? 1 / n : 0;
    case 'pulse25':
      // 25 % duty pulse — hollow, reedy; good for horns and brass.
      return (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);
    case 'triangle':
      return n % 2 === 1 ? (((n - 1) / 2) % 2 === 0 ? 1 : -1) / (n * n) : 0;
    case 'organ': {
      // Drawbar-ish: fundamental plus octaves and a fifth.
      const w: Record<number, number> = { 1: 1, 2: 0.55, 3: 0.28, 4: 0.34, 6: 0.14, 8: 0.11 };
      return w[n] ?? 0;
    }
    case 'pluck': {
      // Plucked string: 1/n^1.25 spectrum combed by the picking position.
      // This is what gives a cuatro its bright, hollow attack.
      const pick = 0.19;
      return (Math.sin(n * Math.PI * pick) / Math.pow(n, 1.25)) * 1.4;
    }
    case 'engine': {
      // Four-stroke exhaust: strong low orders, an even-harmonic bias from the
      // firing interval, and a broad "pipe" formant around the 9th harmonic.
      const base = 1 / Math.pow(n, 1.15);
      const even = n % 2 === 0 ? 1.35 : 0.82;
      const formant = 1 + 0.9 * Math.exp(-Math.pow((n - 9) / 4.5, 2));
      return base * even * formant;
    }
    case 'reed': {
      // Brass/reed: near-sawtooth up to the 8th, then a steep roll-off.
      return n <= 8 ? 1 / n : 1 / (n * Math.pow(n - 7, 1.35));
    }
    case 'string': {
      // Bowed/section string — softer than saw, gentle odd bias.
      return (1 / Math.pow(n, 1.4)) * (n % 2 === 1 ? 1 : 0.7);
    }
    default:
      return 1 / n;
  }
}

/**
 * Build (and cache) a band-limited PeriodicWave. Because a PeriodicWave has a
 * fixed harmonic count, choose `partials` for the register the voice plays in:
 * a 40 Hz engine can carry 48 partials, a 3 kHz bell should carry 6.
 */
export function periodicWave(
  ctx: BaseAudioContext,
  kind: WaveKind,
  partials = 24,
): PeriodicWave {
  const key: WaveKey = { kind, partials: Math.max(2, Math.min(96, Math.round(partials))) };
  const id = `${key.kind}:${key.partials}`;
  let m = waveCache.get(ctx);
  if (!m) {
    m = new Map();
    waveCache.set(ctx, m);
  }
  const hit = m.get(id);
  if (hit) return hit;

  const n = key.partials + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  let peak = 0;
  for (let i = 1; i < n; i++) {
    const a = partialAmplitude(kind, i);
    imag[i] = a;
    peak += Math.abs(a);
  }
  if (peak > 1e-6) {
    // Normalise the summed amplitude so every wave shape has a comparable
    // loudness — otherwise 'engine' is 6x hotter than 'triangle'.
    const s = 1 / peak;
    for (let i = 1; i < n; i++) imag[i] *= s;
  }
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  m.set(id, wave);
  return wave;
}

/** Convenience: an oscillator on a built-in or custom wave, ready to start. */
export function createOsc(
  ctx: BaseAudioContext,
  kind: OscillatorType | WaveKind,
  freq: number,
  detuneCents = 0,
  partials = 24,
): OscillatorNode {
  const o = ctx.createOscillator();
  if (kind === 'sine' || kind === 'sawtooth' || kind === 'triangle' || kind === 'square') {
    o.type = kind;
  } else if (kind === 'custom') {
    o.type = 'sine';
  } else {
    o.setPeriodicWave(periodicWave(ctx, kind, partials));
  }
  o.frequency.value = clamp(finiteOr(freq, 440), 0.01, ctx.sampleRate * 0.48);
  o.detune.value = clamp(finiteOr(detuneCents, 0), -4800, 4800);
  return o;
}

/* ---------------------------------------------------------------- filters */

export function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.7071,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(finiteOr(freq, 1000), 10, ctx.sampleRate * 0.49);
  f.Q.value = clamp(finiteOr(q, 0.7071), 0.0001, 40);
  f.gain.value = clamp(finiteOr(gainDb, 0), -40, 40);
  return f;
}

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = finiteOr(value, 1);
  return g;
}

/** Connect a list of nodes head-to-tail and return the last one. */
export function chain<T extends AudioNode>(first: AudioNode, ...rest: AudioNode[]): T {
  let prev = first;
  for (const n of rest) {
    prev.connect(n);
    prev = n;
  }
  return prev as T;
}

/** Start a source and schedule its stop in one call. Never throws. */
export function startSource(
  src: AudioScheduledSourceNode,
  when: number,
  stopAt?: number,
): void {
  try {
    src.start(finiteOr(when));
    if (stopAt !== undefined) src.stop(Math.max(finiteOr(stopAt), finiteOr(when) + 0.001));
  } catch {
    /* already started / context gone — ignore */
  }
}

export function safeDisconnect(node: AudioNode | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* ignore */
  }
}

/* ----------------------------------------------------------- wave-shaping */

/**
 * Classic soft-saturation transfer curve. `amount` 0..1 maps from a gentle
 * tube-ish warmth to a hard, fuzzy overdrive. Used on the engine, on impacts
 * and on the brass stabs.
 */
export function distortionCurve(amount: number, samples = 2048) {
  const a = clamp01(finiteOr(amount, 0.3));
  const k = a * 120 + 0.6;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    // Blend the classic arctan-ish shaper with a tanh so that low `amount`
    // stays close to linear (no colouration when we do not ask for any).
    const hard = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    const soft = Math.tanh(x * (1 + a * 3));
    curve[i] = clamp(hard * a + soft * (1 - a), -1, 1);
  }
  return curve;
}

/** Symmetric soft clipper — transparent limiting for busy busses. */
export function softClipCurve(drive = 1, samples = 2048) {
  const d = Math.max(0.1, finiteOr(drive, 1));
  const curve = new Float32Array(samples);
  const norm = Math.tanh(d);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(x * d) / norm;
  }
  return curve;
}

export function createShaper(ctx: BaseAudioContext, amount: number, oversample: OverSampleType = '2x'): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  ws.curve = distortionCurve(amount);
  ws.oversample = oversample;
  return ws;
}

/* ---------------------------------------------- convolution reverb (IRs) */

export type ReverbKind = 'room' | 'plaza' | 'arcade' | 'outdoor';

export interface IROptions {
  /** total tail length in seconds */
  seconds: number;
  /** decay shaping exponent; higher = tighter tail */
  decay: number;
  /** silence before the tail, seconds — sells room size */
  preDelay: number;
  /** 0..1 how quickly high frequencies die relative to lows */
  damping: number;
  /** number of discrete early reflections */
  earlyCount: number;
  /** amplitude of the early reflections relative to the tail */
  earlyGain: number;
  /** 0..1 channel decorrelation */
  width: number;
  /** 0..1 overall brightness of the tail */
  bright: number;
  /**
   * Regularly spaced reflections — a positive value creates the flutter echo
   * of a hard tunnel or an arcade colonnade. Seconds between slaps, 0 = off.
   */
  flutter: number;
}

export const IR_PRESETS: Record<ReverbKind, IROptions> = {
  /** A small tiled interior — bar doorway, garage, shop. */
  room: {
    seconds: 0.85,
    decay: 3.4,
    preDelay: 0.006,
    damping: 0.62,
    earlyCount: 9,
    earlyGain: 0.55,
    width: 0.55,
    bright: 0.5,
    flutter: 0,
  },
  /** Plaza de Armas: stone on four sides, open sky above. The default. */
  plaza: {
    seconds: 2.1,
    decay: 2.4,
    preDelay: 0.018,
    damping: 0.44,
    earlyCount: 14,
    earlyGain: 0.42,
    width: 0.8,
    bright: 0.62,
    flutter: 0,
  },
  /** Deep shadowed arcade / the city gate tunnel — hard, ringing, narrow. */
  arcade: {
    seconds: 1.5,
    decay: 2.0,
    preDelay: 0.009,
    damping: 0.3,
    earlyCount: 8,
    earlyGain: 0.75,
    width: 0.35,
    bright: 0.72,
    flutter: 0.031,
  },
  /** Open seafront under the fort walls — long, dark, no early detail. */
  outdoor: {
    seconds: 3.2,
    decay: 1.7,
    preDelay: 0.035,
    damping: 0.68,
    earlyCount: 5,
    earlyGain: 0.2,
    width: 0.95,
    bright: 0.38,
    flutter: 0,
  },
};

/**
 * Build an impulse response from scratch: decaying noise, shaped by a
 * time-varying one-pole low-pass (so the tail gets darker as it dies, which is
 * what real air absorption does), plus discrete early reflections.
 */
export function createImpulseResponse(
  ctx: BaseAudioContext,
  opts: IROptions,
  seed = 0xa11e,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = clamp(finiteOr(opts.seconds, 1.5), 0.05, 8);
  const len = Math.max(64, Math.floor(seconds * sr));
  const pre = Math.floor(clamp(finiteOr(opts.preDelay, 0.01), 0, 0.2) * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const damping = clamp01(finiteOr(opts.damping, 0.5));
  const bright = clamp01(finiteOr(opts.bright, 0.5));
  const decay = clamp(finiteOr(opts.decay, 2.5), 0.4, 12);
  const width = clamp01(finiteOr(opts.width, 0.7));

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // Decorrelate the channels by seeding them differently; `width` blends
    // between "identical" (mono, narrow) and "independent" (wide).
    const rng = new RNG((seed ^ Math.imul(ch + 1, 0x2545f491)) >>> 0);
    const rngShared = new RNG(seed >>> 0);

    // One-pole low-pass state; the coefficient sweeps from bright to dark.
    let lp = 0;
    const startCoef = 0.35 + bright * 0.55;
    const endCoef = startCoef * (1 - damping * 0.92);

    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const wIndep = rng.next() * 2 - 1;
      const wShared = rngShared.next() * 2 - 1;
      const w = wShared * (1 - width) + wIndep * width;
      const coef = startCoef + (endCoef - startCoef) * t;
      lp = lp * (1 - coef) + w * coef;
      // (1-t)^decay gives a natural finite ending — no abrupt truncation click.
      const envelope = Math.pow(1 - t, decay);
      data[i] = lp * envelope;
    }

    // Discrete early reflections — these are what make a space read as *that*
    // size before the diffuse tail arrives.
    const erng = new RNG((seed ^ Math.imul(ch + 7, 0x27d4eb2d)) >>> 0);
    const earlyCount = Math.max(0, Math.round(finiteOr(opts.earlyCount, 8)));
    const earlyGain = clamp01(finiteOr(opts.earlyGain, 0.4));
    for (let e = 0; e < earlyCount; e++) {
      const frac = Math.pow((e + 1) / (earlyCount + 1), 1.35);
      const jitter = 1 + (erng.next() - 0.5) * 0.5;
      const idx = pre + Math.floor(frac * seconds * 0.22 * sr * jitter);
      if (idx >= len - 2) continue;
      const sign = erng.bool() ? 1 : -1;
      const amp = earlyGain * Math.pow(1 - frac, 1.6) * sign;
      data[idx] += amp;
      data[idx + 1] += amp * 0.5;
    }

    // Flutter: hard parallel walls slap at a fixed interval.
    const flutter = Math.max(0, finiteOr(opts.flutter, 0));
    if (flutter > 0.0005) {
      const step = Math.floor(flutter * sr);
      let amp = 0.6;
      for (let idx = pre + step; idx < len - 2 && amp > 0.01; idx += step) {
        data[idx] += amp * (erng.bool() ? 1 : -1);
        amp *= 0.62;
      }
    }

    // Remove DC, then normalise so wet level is predictable across presets.
    let sum = 0;
    for (let i = 0; i < len; i++) sum += data[i];
    const dc = sum / len;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      data[i] -= dc;
      energy += data[i] * data[i];
    }
    const rms = Math.sqrt(energy / len);
    const target = 0.055; // tuned so a 0.3 wet send sits politely under the dry
    const norm = rms > 1e-9 ? target / rms : 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      data[i] *= norm;
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    // Guard against a stray early-reflection spike blowing the convolver up.
    if (peak > 0.98) {
      const s = 0.98 / peak;
      for (let i = 0; i < len; i++) data[i] *= s;
    }
  }
  return buf;
}

/**
 * A ready-to-use convolver. `normalize` is off because we normalised the IR
 * ourselves — that keeps the wet level identical across browsers.
 */
export function createReverb(ctx: BaseAudioContext, kind: ReverbKind, seed = 0xa11e): ConvolverNode {
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = createImpulseResponse(ctx, IR_PRESETS[kind], seed);
  return conv;
}

/* ------------------------------------------------------------------ delay */

export interface EchoOptions {
  /** delay time in seconds */
  time: number;
  /** 0..0.95 feedback amount */
  feedback: number;
  /** low-pass cutoff inside the feedback loop, Hz — darkens each repeat */
  tone: number;
  /** high-pass inside the loop, Hz — stops the low end building up */
  lowCut?: number;
  /** wet output gain */
  wet?: number;
}

export interface EchoUnit {
  input: GainNode;
  output: GainNode;
  delay: DelayNode;
  feedback: GainNode;
  tone: BiquadFilterNode;
  wet: GainNode;
  dispose(): void;
}

/**
 * Filtered feedback delay. Used as a send: feed it, take `output`, mix that
 * back into the bus. Repeats get darker, which is what a real space does and
 * what stops a tempo-synced delay from turning into mush.
 */
export function createEcho(ctx: BaseAudioContext, opts: EchoOptions): EchoUnit {
  const input = gainNode(ctx, 1);
  const delay = ctx.createDelay(Math.max(0.05, Math.min(4, finiteOr(opts.time, 0.25) * 4 + 0.5)));
  delay.delayTime.value = clamp(finiteOr(opts.time, 0.25), 0.001, 3.9);
  const tone = biquad(ctx, 'lowpass', finiteOr(opts.tone, 2600), 0.7);
  const lowCut = biquad(ctx, 'highpass', finiteOr(opts.lowCut ?? 180, 180), 0.7);
  const feedback = gainNode(ctx, clamp(finiteOr(opts.feedback, 0.35), 0, 0.95));
  const wet = gainNode(ctx, clamp01(finiteOr(opts.wet ?? 1, 1)));
  const output = gainNode(ctx, 1);

  input.connect(delay);
  delay.connect(tone);
  tone.connect(lowCut);
  lowCut.connect(feedback);
  feedback.connect(delay); // the loop
  lowCut.connect(wet);
  wet.connect(output);

  return {
    input,
    output,
    delay,
    feedback,
    tone,
    wet,
    dispose(): void {
      feedback.gain.value = 0;
      for (const n of [input, delay, tone, lowCut, feedback, wet, output]) safeDisconnect(n);
    },
  };
}

/* ------------------------------------------------------- panning / spatial */

/**
 * Equal-power stereo pan gains for a pan position in [-1, 1].
 * Written out rather than using StereoPannerNode where we only need a static
 * pan on a one-shot — two gain multiplications beat allocating a node.
 */
export function equalPowerPan(pan: number): { left: number; right: number } {
  const p = clamp(finiteOr(pan, 0), -1, 1);
  const a = ((p + 1) * Math.PI) / 4;
  return { left: Math.cos(a), right: Math.sin(a) };
}

/**
 * Arcade distance attenuation. Not physically inverse-square — that makes
 * everything inaudible at 40 m, which is useless in a game where the camera is
 * 8 m behind the car and the action is 60 m away. This rolls off gently to
 * `ref`, then faster, and hits exactly zero at `max` so voices can be culled.
 */
export function distanceGain(distance: number, ref = 12, max = 190): number {
  const d = Math.max(0, finiteOr(distance, 0));
  if (d >= max) return 0;
  const g = ref / (ref + Math.pow(d, 1.22));
  // Fade the last 25 % of the range to zero so nothing pops out of existence.
  const cull = clamp01((max - d) / (max * 0.25));
  return g * cull * cull;
}

/**
 * Air absorption: distant sounds lose their top end. Returns a low-pass
 * cutoff in Hz for a given distance.
 */
export function distanceCutoff(distance: number): number {
  const d = Math.max(0, finiteOr(distance, 0));
  return clamp(19000 - d * 78, 1400, 19000);
}

/* --------------------------------------------------------------- smoothing */

/**
 * Wraps an AudioParam with a target value we only re-schedule when it actually
 * moves. Frame loops call `set()` unconditionally; this keeps the automation
 * timeline short and guarantees ramps instead of value jumps.
 */
export class SmoothParam {
  private last = Number.NaN;

  constructor(
    private readonly param: AudioParam,
    private readonly tau = 0.06,
    private readonly epsilon = 1e-4,
  ) {}

  set(value: number, time: number): void {
    const v = finiteOr(value, this.last || 0);
    if (Number.isFinite(this.last) && Math.abs(v - this.last) < this.epsilon) return;
    this.last = v;
    glideTo(this.param, v, time, this.tau);
  }

  /** Jump immediately (voice start, respawn) — no glide. */
  snap(value: number, time: number): void {
    const v = finiteOr(value, 0);
    this.last = v;
    this.param.cancelScheduledValues(time);
    setAt(this.param, v, time);
  }

  get value(): number {
    return this.last;
  }
}
