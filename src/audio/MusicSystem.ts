/**
 * MusicSystem.ts — Loco Lift's original score, generated live.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * An original, procedurally performed instrumental score written as an homage
 * to Puerto Rican popular music, following `docs/ART_REFERENCE.md` §7.3 and
 * §7.5. Nothing here is sampled, quoted or arranged from an existing work —
 * the harmony, the melodic material and the arrangement are written for this
 * game; only the *rhythmic vocabulary* is traditional, and that vocabulary is
 * used as an idiom, the way any salsa arranger uses clave.
 *
 * Specificity, per the art direction:
 *  - **Clave** (son clave, 3-2) is the organising cell. Every other pattern is
 *    written against it, which is what makes the groove cohere rather than
 *    sound like a drum machine.
 *  - **Congas** play the marcha/tumbao — muted heel-and-tip through the bar,
 *    a slap on beat 2, and the two open tones on beat 4 and the "and" of 4.
 *  - **Bongó** plays martillo; **timbales** play cáscara on the shell with the
 *    cencerro (bell) over the montuno sections.
 *  - **Güiro** plays the long-short-short scrape; **maracas** run the eighths.
 *  - **Pandero** (plena) and **barril** (bomba, from Loíza) supply alternate
 *    phrase feels — panderos de plena have *no jingles*, so this is a hand
 *    drum, not a tambourine.
 *  - **Bass** plays the anticipated tumbao: nothing on the downbeat, the root
 *    on the "and" of 2, and beat 4 anticipating the *next* bar's chord. That
 *    displaced downbeat is the single most characteristic thing about the
 *    music and the reason the groove pulls forward.
 *  - **Piano** plays a montuno guajeo — chord tones in the 3+3+2 tresillo grid.
 *  - **Cuatro**, the national instrument, carries the melody: double-course
 *    strings, so every note is two slightly detuned voices.
 *  - Brass stabs on the clave 3-side are the hype layer.
 *
 * Explicitly avoided (§7.5): steel drums, pan flute, mariachi anything, and
 * any "generic Latin" sting on pickup.
 *
 * ---------------------------------------------------------------------------
 * FORM
 * ---------------------------------------------------------------------------
 * Key centre **A minor**, with the raised seventh over the dominant (A
 * harmonic minor) — the standard montuno cadence.
 *
 *   shift (16 bars):  Am7 Am7 Dm7 Dm7 | E7  E7  Am7 Am7
 *                     Fmaj7 Fmaj7 G6/9 G6/9 | Am7 Am7 E7sus E7
 *   title  (8 bars):  Am9 Am9 Fmaj7 Fmaj7 | Cmaj7 Cmaj7 E7sus E7
 *   garage (8 bars):  Am7 Dm7 Am7 E7 | Am7 Dm7 E7sus E7
 *   urgent (4 bars):  Am7 Am7 E7♭9 E7♭9
 *   results(8 bars):  Fmaj7 G6/9 Cmaj7 Cmaj7 | Fmaj7 G6/9 Am7 E7
 *
 * A seeded RNG varies the melody, the percussion feel and the fills inside
 * that fixed harmonic frame, so ten minutes never repeat literally while the
 * harmony never wanders.
 *
 * Layers fade in and out with **intensity** (from `audio:music` plus gameplay
 * heat) and every structural change lands on a bar line.
 */

import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import {
  MIN_GAIN,
  biquad,
  createOsc,
  createReverb,
  createEcho,
  createShaper,
  envADSR,
  envPerc,
  finiteOr,
  gainNode,
  midiToFreq,
  noiseSource,
  safeDisconnect,
  setAt,
  softClipCurve,
  startSource,
  type EchoUnit,
} from './Synth';

/* ------------------------------------------------------------------ types */

export type MusicState = 'silent' | 'title' | 'garage' | 'shift' | 'urgent' | 'results';

interface Chord {
  /** semitones above the key centre (A) */
  root: number;
  /** chord intervals in semitones from the chord root */
  intervals: number[];
  /** dominant chords borrow the raised 7th (harmonic minor) for melody */
  dominant: boolean;
  label: string;
}

interface Section {
  chords: Chord[];
  bpm: number;
  /** hard ceiling on intensity while this section is active */
  maxIntensity: number;
  /** floor, so the title screen is never dead silent */
  minIntensity: number;
  /** percussion dialect for this section */
  feel: 'light' | 'salsa' | 'plena' | 'bomba';
  swing: number;
}

type LayerId =
  | 'shaker' // maracas + güiro + clave
  | 'congas'
  | 'bongo'
  | 'timbales'
  | 'bass'
  | 'montuno'
  | 'melody'
  | 'brass';

interface Layer {
  gain: GainNode;
  /** intensity at which this layer starts to appear */
  from: number;
  /** intensity at which it is fully in */
  to: number;
  /** mix trim */
  level: number;
  /** current scheduled target, so we can skip scheduling silent layers */
  target: number;
}

interface MusicVoice {
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  end: number;
}

/* ------------------------------------------------------------ chord table */

const MIN7 = [0, 3, 7, 10];
const MIN9 = [0, 3, 7, 10, 14];
const MAJ7 = [0, 4, 7, 11];
const MAJ69 = [0, 4, 7, 9, 14];
const DOM7 = [0, 4, 7, 10];
const DOM7B9 = [0, 4, 7, 10, 13];
const SUS4 = [0, 5, 7, 10];

const ch = (root: number, intervals: number[], label: string, dominant = false): Chord => ({
  root,
  intervals,
  label,
  dominant,
});

const Am7 = ch(0, MIN7, 'Am7');
const Am9 = ch(0, MIN9, 'Am9');
const Dm7 = ch(5, MIN7, 'Dm7');
const E7 = ch(7, DOM7, 'E7', true);
const E7b9 = ch(7, DOM7B9, 'E7b9', true);
const E7sus = ch(7, SUS4, 'E7sus', true);
const Fmaj7 = ch(8, MAJ7, 'Fmaj7');
const G69 = ch(10, MAJ69, 'G6/9');
const Cmaj7 = ch(3, MAJ7, 'Cmaj7');

const SECTIONS: Record<Exclude<MusicState, 'silent'>, Section> = {
  title: {
    chords: [Am9, Am9, Fmaj7, Fmaj7, Cmaj7, Cmaj7, E7sus, E7],
    bpm: 92,
    maxIntensity: 0.46,
    minIntensity: 0.14,
    feel: 'light',
    swing: 0.1,
  },
  garage: {
    chords: [Am7, Dm7, Am7, E7, Am7, Dm7, E7sus, E7],
    bpm: 98,
    maxIntensity: 0.62,
    minIntensity: 0.2,
    feel: 'plena',
    swing: 0.08,
  },
  shift: {
    chords: [
      Am7, Am7, Dm7, Dm7, E7, E7, Am7, Am7,
      Fmaj7, Fmaj7, G69, G69, Am7, Am7, E7sus, E7,
    ],
    bpm: 106,
    maxIntensity: 1,
    minIntensity: 0.3,
    feel: 'salsa',
    swing: 0.06,
  },
  urgent: {
    chords: [Am7, Am7, E7b9, E7b9],
    bpm: 119,
    maxIntensity: 1,
    minIntensity: 0.72,
    feel: 'bomba',
    swing: 0.03,
  },
  results: {
    chords: [Fmaj7, G69, Cmaj7, Cmaj7, Fmaj7, G69, Am7, E7],
    bpm: 102,
    maxIntensity: 0.9,
    minIntensity: 0.55,
    feel: 'salsa',
    swing: 0.07,
  },
};

/* ------------------------------------------------------- rhythm patterns */

/** Son clave, 3-2, over two bars of 4/4 on a 16th grid (32 steps). */
const CLAVE_32 = [0, 6, 12, 20, 24];

/** Timbales cáscara on the shell, two bars. */
const CASCARA_32 = [0, 4, 6, 10, 12, 14, 16, 18, 22, 24, 28, 30];

/** Cencerro (mambo bell): downbeats plus the "and" of 2 and 4. */
const BELL_16 = [0, 4, 6, 8, 12, 14];
const BELL_OPEN = new Set([0, 8]);

/** Conga marcha. Muted taps through the bar, slap on 2, open tones on 4 / 4-and. */
const CONGA_MUTED = [0, 2, 8, 10];
const CONGA_SLAP = [4];
const CONGA_OPEN = [12, 14];

/** Bongó martillo: eighths, low drum on 1, the accent on the "and" of 2. */
const MARTILLO = [0, 2, 4, 6, 8, 10, 12, 14];

/** Güiro: long stroke on the beat, two short up-strokes after it. */
const GUIRO_LONG = [0, 8];
const GUIRO_SHORT = [4, 6, 12, 14];

/** Maracas run the eighths. */
const MARACA = [0, 2, 4, 6, 8, 10, 12, 14];

/** Plena: seguidor holds the bottom, punteador answers. */
const PLENA_LOW = [0, 8];
const PLENA_HIGH = [4, 6, 12, 14, 15];

/** Bomba sicá: buleador pulse with the requinto slap. */
const BOMBA_LOW = [0, 6, 8, 14];
const BOMBA_SLAP = [4, 12];

/** Piano montuno / guajeo — the 3+3+2 tresillo grid, twice per bar. */
const TRESILLO_16 = [0, 3, 6, 8, 11, 14];

/** Melodic rhythm cells for the cuatro, one bar each. The rest matters. */
const MELODY_CELLS: number[][] = [
  [0, 3, 6, 10, 12],
  [2, 6, 8, 14],
  [0, 6, 12],
  [6, 8, 10, 12, 14],
  [0, 2, 3, 6, 8, 11],
  [],
  [12, 14],
  [0, 4, 6, 12],
];

/* ------------------------------------------------------------- constants */

const LOOKAHEAD = 0.28; // seconds of scheduling runway
const BASS_BASE = 33; // A1
const MONTUNO_BASE = 57; // A3
const CUATRO_BASE = 69; // A4
const BRASS_BASE = 60; // C4

const NAT_MINOR = [0, 2, 3, 5, 7, 8, 10];
const HARM_MINOR = [0, 2, 3, 5, 7, 8, 11];

/* ------------------------------------------------------------------ class */

export class MusicSystem {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private readonly busPre: GainNode;
  private readonly glue: WaveShaperNode;
  private readonly reverb: ConvolverNode | null;
  private readonly reverbSend: GainNode;
  private readonly echo: EchoUnit | null;
  private readonly echoSend: GainNode;
  private readonly layers = new Map<LayerId, Layer>();
  private readonly rng: RNG;
  private readonly seed: number;

  private voices: MusicVoice[] = [];

  private running = false;
  private disposed = false;
  private volume = 1;

  private state: MusicState = 'silent';
  private pendingState: MusicState | null = null;
  private section: Section = SECTIONS.shift;

  private bpm = 106;
  private bpmTarget = 106;
  private stepDur = 60 / 106 / 4;

  private step = 0; // absolute 16th counter since start
  private bar = 0; // absolute bar counter
  private nextStepTime = 0;

  private intensity = 0.3;
  private intensityTarget = 0.3;

  private celebrateBars = 0;
  private celebrateQueued = false;
  private fillQueued = false;

  /** the 4-bar cuatro motif for the current phrase, regenerated each cycle */
  private motif: { bar: number; step: number; degree: number; dur: number }[] = [];
  private phrase = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode, seed = 0x10c0_11f7, useReverb = true) {
    this.ctx = ctx;
    this.seed = seed >>> 0;
    this.rng = new RNG(this.seed);

    this.out = gainNode(ctx, 0);
    this.out.connect(destination);

    // A gentle glue saturator keeps the ensemble cohesive and, more usefully,
    // stops a stack of simultaneous transients from clipping the bus.
    this.glue = ctx.createWaveShaper();
    this.glue.curve = softClipCurve(1.15);
    this.glue.oversample = '2x';
    this.busPre = gainNode(ctx, 0.62);
    this.busPre.connect(this.glue);
    this.glue.connect(this.out);

    // Plaza reverb: stone on four sides, open sky. The city's own room.
    this.reverbSend = gainNode(ctx, 0.16);
    if (useReverb) {
      this.reverb = createReverb(ctx, 'plaza', this.seed ^ 0x5151);
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.out);
    } else {
      this.reverb = null;
    }

    // Tempo-synced 3/16 delay on the melodic voices — an idiom in tropical
    // arrangements and the cheapest way to make a single cuatro sound like a
    // player in a real street.
    this.echoSend = gainNode(ctx, 0.2);
    this.echo = createEcho(ctx, { time: (60 / 106 / 4) * 3, feedback: 0.3, tone: 2400, wet: 0.5 });
    this.echoSend.connect(this.echo.input);
    this.echo.output.connect(this.out);

    const mk = (id: LayerId, from: number, to: number, level: number): void => {
      const g = gainNode(ctx, 0);
      g.connect(this.busPre);
      this.layers.set(id, { gain: g, from, to, level, target: 0 });
    };
    // Layer thresholds: the groove builds from the top of the kit downwards,
    // which is how a live band actually enters.
    mk('shaker', 0.0, 0.14, 0.5);
    mk('bass', 0.1, 0.26, 0.86);
    mk('congas', 0.22, 0.42, 0.62);
    mk('montuno', 0.38, 0.58, 0.5);
    mk('bongo', 0.44, 0.62, 0.36);
    mk('timbales', 0.58, 0.76, 0.42);
    mk('melody', 0.5, 0.72, 0.44);
    mk('brass', 0.8, 0.95, 0.34);

    // Melody and montuno feed the delay and the reverb; percussion only the
    // reverb, and less of it, so the groove stays tight and up front.
    const melody = this.layers.get('melody');
    const montuno = this.layers.get('montuno');
    const brass = this.layers.get('brass');
    if (melody) {
      melody.gain.connect(this.echoSend);
      melody.gain.connect(this.reverbSend);
    }
    if (montuno) montuno.gain.connect(this.reverbSend);
    if (brass) brass.gain.connect(this.reverbSend);
    const congas = this.layers.get('congas');
    if (congas) {
      const send = gainNode(ctx, 0.45);
      congas.gain.connect(send);
      send.connect(this.reverbSend);
    }

    this.regenerateMotif();
  }

  /* ------------------------------------------------------------- controls */

  get isRunning(): boolean {
    return this.running;
  }

  get currentBpm(): number {
    return this.bpm;
  }

  get currentState(): MusicState {
    return this.state;
  }

  /** 0..1 position inside the current beat — handy for beat-synced HUD pops. */
  get beatPhase(): number {
    const beatDur = this.stepDur * 4;
    if (beatDur <= 0) return 0;
    const since = this.ctx.currentTime - (this.nextStepTime - this.stepDur);
    const stepInBeat = this.step % 4;
    return clamp01((stepInBeat * this.stepDur + since) / beatDur);
  }

  start(state: MusicState = 'title'): void {
    if (this.disposed) return;
    if (!this.running) {
      this.running = true;
      this.step = 0;
      this.bar = 0;
      this.nextStepTime = this.ctx.currentTime + 0.09;
    }
    this.setState(state, true);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    setAt(this.out.gain, Math.max(MIN_GAIN, this.out.gain.value), t);
    this.out.gain.linearRampToValueAtTime(this.volume, t + 0.8);
  }

  stop(fade = 0.9): void {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    setAt(this.out.gain, Math.max(MIN_GAIN, this.out.gain.value), t);
    this.out.gain.exponentialRampToValueAtTime(MIN_GAIN, t + Math.max(0.05, fade));
    this.out.gain.linearRampToValueAtTime(0, t + Math.max(0.05, fade) + 0.02);
    this.running = false;
    this.state = 'silent';
    this.pendingState = null;
  }

  setVolume(v: number): void {
    this.volume = clamp(finiteOr(v, 1), 0, 2);
    if (!this.running) return;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(this.volume, t, 0.12);
  }

  /** Plaza reverb send, 0..1. Dropped to 0 on the low quality tier. */
  setReverbAmount(v: number): void {
    if (this.disposed) return;
    this.reverbSend.gain.setTargetAtTime(clamp(finiteOr(v, 0.16), 0, 1), this.ctx.currentTime, 0.2);
  }

  /** Tempo-synced delay send, 0..1. */
  setEchoAmount(v: number): void {
    if (this.disposed) return;
    this.echoSend.gain.setTargetAtTime(clamp(finiteOr(v, 0.2), 0, 1), this.ctx.currentTime, 0.2);
  }

  /**
   * Change section. By default the change lands on the next bar line so the
   * groove never gets cut off mid-phrase; `immediate` is for hard cuts such as
   * entering the pause menu or booting the title screen.
   */
  setState(next: MusicState, immediate = false): void {
    if (this.disposed) return;
    if (next === 'silent') {
      this.stop(0.6);
      return;
    }
    if (!this.running) {
      this.running = true;
      this.step = 0;
      this.bar = 0;
      this.nextStepTime = this.ctx.currentTime + 0.09;
      const t = this.ctx.currentTime;
      setAt(this.out.gain, 0, t);
      this.out.gain.linearRampToValueAtTime(this.volume, t + 0.8);
    }
    if (next === this.state && !this.pendingState) return;
    if (immediate) {
      this.applyState(next);
      this.pendingState = null;
    } else {
      this.pendingState = next;
    }
  }

  /** 0..1 — drives which layers are playing and how hard they play. */
  setIntensity(v: number): void {
    this.intensityTarget = clamp01(finiteOr(v, 0));
  }

  /**
   * A good dropoff. Queues a two-bar celebratory turnaround (bVI-bVII, both
   * diatonic here so it never sounds wrong) with brass and a bell.
   */
  celebrate(): void {
    if (!this.running) return;
    this.celebrateQueued = true;
    this.fillQueued = true;
  }

  /** Queue a one-bar percussion fill at the next bar line. */
  fill(): void {
    this.fillQueued = true;
  }

  /* ----------------------------------------------------------------- tick */

  /**
   * Lookahead scheduler. Safe to call from both the frame loop and a timer —
   * it only ever schedules the runway it has not scheduled yet.
   */
  tick(dt = 0): void {
    if (this.disposed || !this.running) return;
    const now = this.ctx.currentTime;

    // Smooth the intensity toward its target and push the layer gains.
    const step = clamp(finiteOr(dt, 1 / 60), 0, 0.25);
    this.intensity = lerp(this.intensity, this.intensityTarget, 1 - Math.exp(-1.6 * (step || 1 / 60)));
    this.updateLayerGains(now);

    let guard = 0;
    while (this.nextStepTime < now + LOOKAHEAD && guard++ < 512) {
      if (this.step % 16 === 0) this.onBar();
      this.scheduleStep(this.step, this.nextStepTime);
      this.step++;
      this.nextStepTime += this.stepDur;
    }
    if (guard >= 512) {
      // The context jumped (tab was backgrounded); resync rather than grind.
      this.nextStepTime = now + 0.05;
    }
    this.sweep(now);
  }

  /** Alias so the system can be driven from a generic update loop. */
  update(dt: number): void {
    this.tick(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    const t = this.ctx.currentTime;
    setAt(this.out.gain, 0, t);
    for (const v of this.voices) {
      for (const s of v.sources) {
        try {
          s.stop(t);
        } catch {
          /* ignore */
        }
      }
      for (const n of v.nodes) safeDisconnect(n);
    }
    this.voices = [];
    for (const [, l] of this.layers) safeDisconnect(l.gain);
    this.layers.clear();
    if (this.echo) this.echo.dispose();
    safeDisconnect(this.echoSend);
    safeDisconnect(this.reverb);
    safeDisconnect(this.reverbSend);
    safeDisconnect(this.busPre);
    safeDisconnect(this.glue);
    safeDisconnect(this.out);
  }

  /* --------------------------------------------------------- bar handling */

  private applyState(next: MusicState): void {
    if (next === 'silent') return;
    this.state = next;
    this.section = SECTIONS[next];
    this.bpmTarget = this.section.bpm;
    // Reset the phrase so a new section starts at the top of its form.
    this.bar = 0;
    this.phrase = 0;
    this.regenerateMotif();
  }

  private onBar(): void {
    if (this.pendingState) {
      this.applyState(this.pendingState);
      this.pendingState = null;
    } else {
      this.bar++;
    }

    // Tempo moves toward the section tempo a little each bar, so a state
    // change accelerates rather than jumping.
    if (Math.abs(this.bpm - this.bpmTarget) > 0.05) {
      this.bpm = lerp(this.bpm, this.bpmTarget, 0.45);
      if (Math.abs(this.bpm - this.bpmTarget) < 0.2) this.bpm = this.bpmTarget;
      this.stepDur = 60 / this.bpm / 4;
      if (this.echo) {
        this.echo.delay.delayTime.setTargetAtTime(this.stepDur * 3, this.ctx.currentTime, 0.2);
      }
    }

    if (this.celebrateQueued) {
      this.celebrateQueued = false;
      this.celebrateBars = 2;
    } else if (this.celebrateBars > 0) {
      this.celebrateBars--;
    }

    // A fresh cuatro motif every four bars of the form keeps the melody alive
    // without letting it wander off the phrase structure.
    const p = Math.floor(this.bar / 4);
    if (p !== this.phrase) {
      this.phrase = p;
      this.regenerateMotif();
    }
  }

  private chordAt(barIndex: number): Chord {
    if (this.celebrateBars > 0) {
      // The celebratory turnaround: bVI then bVII, resolving back into the form.
      return this.celebrateBars === 2 ? Fmaj7 : G69;
    }
    const list = this.section.chords;
    return list[((barIndex % list.length) + list.length) % list.length];
  }

  private regenerateMotif(): void {
    const r = this.rng.fork(this.phrase * 7919 + this.state.length * 131);
    this.motif = [];
    // A 4-bar antecedent/consequent: bars 0-1 state an idea, bar 2 answers it,
    // bar 3 leaves air (or a pickup into the next phrase).
    let degree = r.int(0, 4);
    for (let b = 0; b < 4; b++) {
      const cell =
        b === 3
          ? MELODY_CELLS[r.bool(0.55) ? 5 : 6]
          : MELODY_CELLS[r.int(0, MELODY_CELLS.length - 3)];
      for (let i = 0; i < cell.length; i++) {
        // Small, mostly stepwise motion with the occasional leap — this is
        // what stops procedural melody sounding like an arpeggiator.
        const move = r.bool(0.72) ? r.int(-1, 1) : r.int(-3, 3);
        degree = clamp(degree + move, -2, 9);
        const dur = i === cell.length - 1 ? 0.45 : 0.2;
        this.motif.push({ bar: b, step: cell[i], degree, dur });
      }
    }
  }

  /* ------------------------------------------------------------ scheduling */

  private updateLayerGains(now: number): void {
    const sec = this.section;
    const inten = clamp(this.intensity, sec.minIntensity, sec.maxIntensity);
    for (const [id, l] of this.layers) {
      let amt = clamp01((inten - l.from) / Math.max(0.001, l.to - l.from));
      // Section instrumentation rules.
      if (sec.feel === 'light' && (id === 'timbales' || id === 'brass')) amt = 0;
      if (sec.feel === 'plena' && id === 'brass') amt *= 0.35;
      if (id === 'brass' && this.celebrateBars > 0) amt = Math.max(amt, 0.85);
      const target = amt * l.level;
      if (Math.abs(target - l.target) > 1e-3) {
        l.target = target;
        l.gain.gain.setTargetAtTime(target, now, 0.35);
      }
    }
  }

  private layerOn(id: LayerId): GainNode | null {
    const l = this.layers.get(id);
    if (!l || l.target < 0.004) return null;
    return l.gain;
  }

  private scheduleStep(absStep: number, time: number): void {
    const s16 = absStep % 16;
    const s32 = absStep % 32;
    const barIndex = Math.floor(absStep / 16);
    const chord = this.chordAt(this.bar);
    const nextChord = this.chordAt(this.bar + 1);
    const sec = this.section;
    const inten = clamp(this.intensity, sec.minIntensity, sec.maxIntensity);
    const lastBarOfPhrase = this.bar % 4 === 3;

    // Light swing on the off-16ths — Caribbean music is close to straight, so
    // this is a nudge, not a shuffle.
    const swung = s16 % 2 === 1 ? time + this.stepDur * sec.swing : time;

    /* ------------------------------------------------------------ shaker */
    const shaker = this.layerOn('shaker');
    if (shaker) {
      if (MARACA.includes(s16)) {
        const accent = s16 % 4 === 0 ? 1 : 0.55;
        this.hitMaraca(shaker, swung, 0.5 * accent);
      }
      if (GUIRO_LONG.includes(s16)) this.hitGuiro(shaker, time, true, 0.55);
      else if (GUIRO_SHORT.includes(s16)) this.hitGuiro(shaker, swung, false, 0.4);
      if (CLAVE_32.includes(s32)) this.hitClave(shaker, time, 0.6);
    }

    /* ------------------------------------------------------------- congas */
    const congas = this.layerOn('congas');
    if (congas) {
      if (sec.feel === 'bomba') {
        if (BOMBA_LOW.includes(s16)) this.hitBarril(congas, time, 'open', 0.85);
        if (BOMBA_SLAP.includes(s16)) this.hitBarril(congas, time, 'slap', 0.7);
      } else if (sec.feel === 'plena') {
        if (PLENA_LOW.includes(s16)) this.hitPandero(congas, time, 'low', 0.8);
        if (PLENA_HIGH.includes(s16)) this.hitPandero(congas, swung, 'high', 0.55);
      } else {
        if (CONGA_OPEN.includes(s16)) {
          this.hitConga(congas, time, 'open', s16 === 12 ? 'conga' : 'quinto', 0.85);
        }
        if (CONGA_SLAP.includes(s16)) this.hitConga(congas, time, 'slap', 'conga', 0.75);
        if (CONGA_MUTED.includes(s16) && inten > 0.32) {
          this.hitConga(congas, swung, 'mute', 'tumba', 0.3);
        }
        // Tumba on the "and" of 2 with the clave's bombo note.
        if (s32 === 6 || s32 === 22) this.hitConga(congas, time, 'open', 'tumba', 0.6);
      }
      // One-bar fill at the end of a phrase.
      if ((this.fillQueued || lastBarOfPhrase) && s16 >= 12 && inten > 0.5) {
        const v = 0.5 + (s16 - 12) * 0.12;
        this.hitConga(congas, swung, s16 === 15 ? 'open' : 'slap', 'quinto', v);
      }
    }

    /* -------------------------------------------------------------- bongó */
    const bongo = this.layerOn('bongo');
    if (bongo && MARTILLO.includes(s16)) {
      const low = s16 === 0 || s16 === 8;
      const accent = s16 === 6 || s16 === 14 ? 0.8 : low ? 0.6 : 0.32;
      this.hitBongo(bongo, swung, low ? 'hembra' : 'macho', accent);
    }

    /* ----------------------------------------------------------- timbales */
    const timbales = this.layerOn('timbales');
    if (timbales) {
      if (CASCARA_32.includes(s32)) {
        this.hitShell(timbales, swung, s32 % 8 === 0 ? 0.7 : 0.42);
      }
      if (inten > 0.72 && BELL_16.includes(s16)) {
        this.hitBell(timbales, time, BELL_OPEN.has(s16), BELL_OPEN.has(s16) ? 0.62 : 0.4);
      }
    }

    /* --------------------------------------------------------------- bass */
    const bass = this.layerOn('bass');
    if (bass) {
      // Anticipated tumbao. Nothing on the downbeat; the "and" of 2 carries
      // the root, beat 4 anticipates the next bar.
      if (s16 === 6) {
        this.playBass(bass, time, this.bassMidi(chord.root), this.stepDur * 5, 0.85);
      } else if (s16 === 12) {
        const anticipate = nextChord.root !== chord.root;
        const target = anticipate ? nextChord.root : chord.root + 7;
        this.playBass(bass, time, this.bassMidi(target), this.stepDur * 3.5, 0.75);
      } else if (s16 === 14 && inten > 0.62 && (this.bar % 2 === 1)) {
        this.playBass(bass, swung, this.bassMidi(chord.root + 7) - 12, this.stepDur * 1.6, 0.4);
      } else if (s16 === 0 && inten < 0.28) {
        // At the very lowest intensity there is no tumbao yet — just a root.
        this.playBass(bass, time, this.bassMidi(chord.root), this.stepDur * 6, 0.6);
      }
    }

    /* ------------------------------------------------------------ montuno */
    const montuno = this.layerOn('montuno');
    if (montuno && TRESILLO_16.includes(s16)) {
      const tones = this.guajeoTones(chord);
      const idx = TRESILLO_16.indexOf(s16) + barIndex * 2;
      const note = tones[((idx % tones.length) + tones.length) % tones.length];
      const accent = s16 === 0 || s16 === 6 ? 0.8 : 0.55;
      this.playMontuno(montuno, swung, note, accent);
      // Octave doubling on the strong hits is what makes a montuno ring.
      if (s16 === 0 || s16 === 8) this.playMontuno(montuno, swung, note - 12, accent * 0.6);
    }

    /* ------------------------------------------------------------- melody */
    const melody = this.layerOn('melody');
    if (melody) {
      const mb = this.bar % 4;
      for (const n of this.motif) {
        if (n.bar !== mb || n.step !== s16) continue;
        const midi = this.melodyMidi(chord, n.degree);
        this.playCuatro(melody, swung, midi, n.dur, 0.7);
      }
    }

    /* -------------------------------------------------------------- brass */
    const brass = this.layerOn('brass');
    if (brass) {
      const stabAt = this.celebrateBars > 0 ? [0, 6, 12] : [6, 12];
      if (stabAt.includes(s16) && (this.bar % 2 === 0 || this.celebrateBars > 0)) {
        this.playBrass(brass, time, chord, this.stepDur * 2.2, 0.8);
      }
      if (s16 === 0 && this.bar % 4 === 0) {
        this.playBrass(brass, time, chord, this.stepDur * 6, 0.55);
      }
    }

    if (s16 === 15) this.fillQueued = false;
  }

  /* ------------------------------------------------------------ note maths */

  private bassMidi(rootOffset: number): number {
    let m = BASS_BASE + (((rootOffset % 12) + 12) % 12);
    // Keep the bass inside a playable, punchy octave and a bit.
    if (m > BASS_BASE + 11) m -= 12;
    if (m < BASS_BASE - 2) m += 12;
    return m;
  }

  /** Ascending chord tones spanning ~1.5 octaves: the raw material of a guajeo. */
  private guajeoTones(chord: Chord): number[] {
    const base = MONTUNO_BASE + chord.root;
    const out: number[] = [];
    for (const iv of chord.intervals) out.push(base + iv);
    for (const iv of chord.intervals) out.push(base + iv + 12);
    // Start the cell on the third — the classic guajeo entry point.
    const rotated = out.slice(1).concat(out.slice(0, 1));
    return rotated.map((m) => (m > 79 ? m - 12 : m < 55 ? m + 12 : m));
  }

  private melodyMidi(chord: Chord, degree: number): number {
    const scale = chord.dominant ? HARM_MINOR : NAT_MINOR;
    const d = Math.round(degree);
    const oct = Math.floor(d / scale.length);
    const idx = ((d % scale.length) + scale.length) % scale.length;
    const midi = CUATRO_BASE + scale[idx] + oct * 12;
    return clamp(midi, 62, 93);
  }

  /* =================================================================== */
  /*  Instrument voices                                                   */
  /* =================================================================== */

  private track(nodes: AudioNode[], sources: AudioScheduledSourceNode[], end: number): void {
    this.voices.push({ nodes, sources, end: end + 0.06 });
  }

  private sweep(now: number): void {
    if (this.voices.length === 0) return;
    let w = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.end <= now) {
        for (const s of v.sources) {
          try {
            s.stop(now);
          } catch {
            /* ignore */
          }
        }
        for (const n of v.nodes) safeDisconnect(n);
      } else {
        this.voices[w++] = v;
      }
    }
    this.voices.length = w;
  }

  /* ------------------------------------------------------------ percussion */

  /** Conga / tumbadora. Pitch drop on the attack is what makes a drum a drum. */
  private hitConga(
    dest: AudioNode,
    t: number,
    tone: 'open' | 'slap' | 'mute',
    drum: 'tumba' | 'conga' | 'quinto',
    vel: number,
  ): void {
    const ctx = this.ctx;
    const f = drum === 'tumba' ? 118 : drum === 'conga' ? 172 : 246;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];
    let end = t;

    if (tone === 'open' || tone === 'mute') {
      const decay = tone === 'open' ? 0.3 : 0.05;
      const body = createOsc(ctx, 'sine', f);
      const bg = gainNode(ctx, 0);
      body.connect(bg);
      bg.connect(dest);
      body.frequency.setValueAtTime(f * 1.28, t);
      body.frequency.exponentialRampToValueAtTime(f, t + 0.028);
      const e = envPerc(bg.gain, t, 0.46 * vel, 0.002, decay);
      startSource(body, t, e + 0.02);
      nodes.push(body, bg);
      srcs.push(body);
      end = Math.max(end, e);

      const harm = createOsc(ctx, 'triangle', f * 2.14);
      const hg = gainNode(ctx, 0);
      harm.connect(hg);
      hg.connect(dest);
      const he = envPerc(hg.gain, t, 0.09 * vel, 0.002, decay * 0.45);
      startSource(harm, t, he + 0.02);
      nodes.push(harm, hg);
      srcs.push(harm);
    }

    // Skin transient.
    const sk = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', tone === 'slap' ? 1750 : f * 6.5, tone === 'slap' ? 2.6 : 2.2);
    const sg = gainNode(ctx, 0);
    sk.connect(bp);
    bp.connect(sg);
    sg.connect(dest);
    const skinAmp = tone === 'slap' ? 0.36 : tone === 'open' ? 0.14 : 0.09;
    const skinDecay = tone === 'slap' ? 0.075 : 0.022;
    const se = envPerc(sg.gain, t, skinAmp * vel, 0.0008, skinDecay);
    startSource(sk, t, se + 0.02);
    nodes.push(sk, bp, sg);
    srcs.push(sk);
    end = Math.max(end, se);

    if (tone === 'slap') {
      const ring = createOsc(ctx, 'sine', f * 1.55);
      const rg = gainNode(ctx, 0);
      ring.connect(rg);
      rg.connect(dest);
      const re = envPerc(rg.gain, t, 0.14 * vel, 0.001, 0.06);
      startSource(ring, t, re + 0.02);
      nodes.push(ring, rg);
      srcs.push(ring);
      end = Math.max(end, re);
    }

    this.track(nodes, srcs, end);
  }

  /** Bongó: small, dry, high. Martillo lives here. */
  private hitBongo(dest: AudioNode, t: number, which: 'macho' | 'hembra', vel: number): void {
    const ctx = this.ctx;
    const f = which === 'macho' ? 432 : 306;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];

    const o = createOsc(ctx, 'sine', f);
    const g = gainNode(ctx, 0);
    o.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(f * 1.35, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.014);
    const e = envPerc(g.gain, t, 0.28 * vel, 0.001, 0.085);
    startSource(o, t, e + 0.02);
    nodes.push(o, g);
    srcs.push(o);

    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', 2600, 2.4);
    const ng = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(dest);
    const ne = envPerc(ng.gain, t, 0.13 * vel, 0.0006, 0.026);
    startSource(n, t, ne + 0.02);
    nodes.push(n, bp, ng);
    srcs.push(n);

    this.track(nodes, srcs, Math.max(e, ne));
  }

  /** Barril de bomba — the deep Loíza hand drum. Big, woody, close-miked. */
  private hitBarril(dest: AudioNode, t: number, tone: 'open' | 'slap', vel: number): void {
    const ctx = this.ctx;
    const f = tone === 'open' ? 94 : 132;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];

    const o = createOsc(ctx, 'sine', f);
    const g = gainNode(ctx, 0);
    o.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(f * 1.42, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    const e = envPerc(g.gain, t, (tone === 'open' ? 0.55 : 0.36) * vel, 0.003, tone === 'open' ? 0.42 : 0.14);
    startSource(o, t, e + 0.02);
    nodes.push(o, g);
    srcs.push(o);

    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', tone === 'slap' ? 1500 : 620, tone === 'slap' ? 2.2 : 1.6);
    const ng = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(dest);
    const ne = envPerc(ng.gain, t, (tone === 'slap' ? 0.3 : 0.16) * vel, 0.0008, tone === 'slap' ? 0.07 : 0.04);
    startSource(n, t, ne + 0.02);
    nodes.push(n, bp, ng);
    srcs.push(n);

    this.track(nodes, srcs, Math.max(e, ne));
  }

  /** Pandero de plena — a hand frame drum. No jingles: this is not a tambourine. */
  private hitPandero(dest: AudioNode, t: number, tone: 'low' | 'high', vel: number): void {
    const ctx = this.ctx;
    const f = tone === 'low' ? 196 : 340;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];

    const o = createOsc(ctx, 'sine', f);
    const g = gainNode(ctx, 0);
    o.connect(g);
    g.connect(dest);
    o.frequency.setValueAtTime(f * 1.22, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.02);
    const e = envPerc(g.gain, t, (tone === 'low' ? 0.4 : 0.22) * vel, 0.002, tone === 'low' ? 0.19 : 0.075);
    startSource(o, t, e + 0.02);
    nodes.push(o, g);
    srcs.push(o);

    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', tone === 'low' ? 900 : 2100, 1.9);
    const ng = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(dest);
    const ne = envPerc(ng.gain, t, 0.16 * vel, 0.0008, tone === 'low' ? 0.055 : 0.03);
    startSource(n, t, ne + 0.02);
    nodes.push(n, bp, ng);
    srcs.push(n);

    this.track(nodes, srcs, Math.max(e, ne));
  }

  /** Timbal shell — the cáscara stick. Dry, wooden, no pitch. */
  private hitShell(dest: AudioNode, t: number, vel: number): void {
    const ctx = this.ctx;
    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', 2450, 3.4);
    const hp = biquad(ctx, 'highpass', 1200, 0.7);
    const g = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(dest);
    const e = envPerc(g.gain, t, 0.19 * vel, 0.0006, 0.028);
    startSource(n, t, e + 0.02);
    this.track([n, bp, hp, g], [n], e);
  }

  /** Cencerro — the hand bell. Two inharmonic tones, hard mallet. */
  private hitBell(dest: AudioNode, t: number, open: boolean, vel: number): void {
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];
    const bp = biquad(ctx, 'bandpass', 1750, 1.1);
    const shp = createShaper(ctx, 0.2, 'none');
    bp.connect(shp);
    shp.connect(dest);
    nodes.push(bp, shp);
    const decay = open ? 0.24 : 0.09;
    let end = t;
    for (const [f, a] of [
      [636, 1],
      [951, 0.7],
      [1420, 0.32],
    ] as const) {
      const o = createOsc(ctx, 'square', f, 0, 8);
      const g = gainNode(ctx, 0);
      o.connect(g);
      g.connect(bp);
      const e = envPerc(g.gain, t, 0.12 * a * vel, 0.0008, decay);
      startSource(o, t, e + 0.02);
      nodes.push(o, g);
      srcs.push(o);
      end = Math.max(end, e);
    }
    this.track(nodes, srcs, end);
  }

  /** Güiro: the long "laaargo" scrape and the short up-strokes. */
  private hitGuiro(dest: AudioNode, t: number, long: boolean, vel: number): void {
    const ctx = this.ctx;
    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', 2500, 3.2);
    const g = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(g);
    g.connect(dest);
    let end: number;
    if (long) {
      // A scrape is a burst of individual tooth strikes, not a swell.
      const teeth = 9;
      const span = Math.min(0.14, this.stepDur * 1.4);
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < teeth; i++) {
        const at = t + (i / teeth) * span;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.1 * vel * (1 - i / (teeth * 1.6)), at + 0.0018);
        g.gain.linearRampToValueAtTime(0, at + span / teeth - 0.001);
      }
      bp.frequency.setValueAtTime(2100, t);
      bp.frequency.linearRampToValueAtTime(3200, t + span);
      end = t + span + 0.02;
      g.gain.setValueAtTime(0, end);
    } else {
      end = envPerc(g.gain, t, 0.11 * vel, 0.0008, 0.028);
    }
    startSource(n, t, end + 0.02);
    this.track([n, bp, g], [n], end);
  }

  private hitMaraca(dest: AudioNode, t: number, vel: number): void {
    const ctx = this.ctx;
    const n = noiseSource(ctx, 'white', 1, true);
    const hp = biquad(ctx, 'highpass', 4600, 0.8);
    const pk = biquad(ctx, 'peaking', 7200, 1.4, 5);
    const g = gainNode(ctx, 0);
    n.connect(hp);
    hp.connect(pk);
    pk.connect(g);
    g.connect(dest);
    const e = envPerc(g.gain, t, 0.1 * vel, 0.0008, 0.03 + vel * 0.02);
    startSource(n, t, e + 0.02);
    this.track([n, hp, pk, g], [n], e);
  }

  /** Clave: two hardwood sticks. The reference everything else is written to. */
  private hitClave(dest: AudioNode, t: number, vel: number): void {
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];
    let end = t;
    for (const [f, a] of [
      [2490, 1],
      [3260, 0.42],
      [1230, 0.22],
    ] as const) {
      const o = createOsc(ctx, 'sine', f);
      const g = gainNode(ctx, 0);
      o.connect(g);
      g.connect(dest);
      const e = envPerc(g.gain, t, 0.14 * a * vel, 0.0006, 0.05);
      startSource(o, t, e + 0.02);
      nodes.push(o, g);
      srcs.push(o);
      end = Math.max(end, e);
    }
    this.track(nodes, srcs, end);
  }

  /* --------------------------------------------------------------- pitched */

  /** Round, woody electric bass. Fundamental-heavy, filtered, slightly driven. */
  private playBass(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];

    const lp = biquad(ctx, 'lowpass', clamp(f * 5.5 + 120, 150, 1400), 2.6);
    const shp = createShaper(ctx, 0.18, 'none');
    const g = gainNode(ctx, 0);
    lp.connect(shp);
    shp.connect(g);
    g.connect(dest);
    nodes.push(lp, shp, g);

    const fund = createOsc(ctx, 'sine', f);
    const fg = gainNode(ctx, 0.8);
    fund.connect(fg);
    fg.connect(lp);
    nodes.push(fund, fg);
    srcs.push(fund);

    const bite = createOsc(ctx, 'triangle', f, 5);
    const bg = gainNode(ctx, 0.3);
    bite.connect(bg);
    bg.connect(lp);
    nodes.push(bite, bg);
    srcs.push(bite);

    const grit = createOsc(ctx, 'saw', f * 2, -6, 10);
    const gg = gainNode(ctx, 0.08);
    grit.connect(gg);
    gg.connect(lp);
    nodes.push(grit, gg);
    srcs.push(grit);

    // Filter closes over the note — a plucked string losing its brightness.
    lp.frequency.setValueAtTime(clamp(f * 9 + 220, 200, 2600), t);
    lp.frequency.exponentialRampToValueAtTime(clamp(f * 3.2 + 90, 120, 1200), t + Math.min(0.35, dur));

    const end = envADSR(
      g.gain,
      t,
      0.44 * vel,
      { attack: 0.006, decay: 0.09, sustain: 0.55, release: 0.1 },
      Math.max(0.02, dur - 0.14),
    );
    for (const s of srcs) startSource(s, t, end + 0.02);
    this.track(nodes, srcs, end);
  }

  /** Montuno piano: additive, hammer-struck, bright but short. */
  private playMontuno(dest: AudioNode, t: number, midi: number, vel: number): void {
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];
    const bus = gainNode(ctx, 1);
    bus.connect(dest);
    nodes.push(bus);

    const partials = [
      { r: 1, a: 1, d: 1 },
      { r: 2, a: 0.42, d: 0.72 },
      { r: 3, a: 0.2, d: 0.5 },
      { r: 4.02, a: 0.11, d: 0.34 },
      { r: 5.4, a: 0.05, d: 0.22 },
    ];
    const decay = 0.62;
    let end = t;
    for (const p of partials) {
      const pf = f * p.r;
      if (pf > 15000) continue;
      const o = createOsc(ctx, 'sine', pf);
      const g = gainNode(ctx, 0);
      o.connect(g);
      g.connect(bus);
      const e = envPerc(g.gain, t, 0.13 * p.a * vel, 0.003, decay * p.d);
      startSource(o, t, e + 0.02);
      nodes.push(o, g);
      srcs.push(o);
      end = Math.max(end, e);
    }
    // Hammer noise.
    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', clamp(f * 4, 600, 9000), 2.2);
    const ng = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(bus);
    envPerc(ng.gain, t, 0.035 * vel, 0.0006, 0.014);
    startSource(n, t, t + 0.06);
    nodes.push(n, bp, ng);
    srcs.push(n);

    this.track(nodes, srcs, end);
  }

  /**
   * Cuatro: Puerto Rico's national instrument, five double courses. Every note
   * is two strings a few cents apart, which is where the shimmer comes from.
   */
  private playCuatro(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];

    const lp = biquad(ctx, 'lowpass', clamp(f * 7, 900, 12000), 0.9);
    const body = biquad(ctx, 'peaking', 420, 1.2, 4);
    const g = gainNode(ctx, 0);
    lp.connect(body);
    body.connect(g);
    g.connect(dest);
    nodes.push(lp, body, g);

    for (const d of [-7, 7]) {
      const o = createOsc(ctx, 'pluck', f, d, 20);
      const og = gainNode(ctx, 0.5);
      o.connect(og);
      og.connect(lp);
      nodes.push(o, og);
      srcs.push(o);
    }
    // Pick attack.
    const n = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', clamp(f * 5.5, 900, 10000), 2.6);
    const ng = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(dest);
    envPerc(ng.gain, t, 0.05 * vel, 0.0006, 0.016);
    startSource(n, t, t + 0.06);
    nodes.push(n, bp, ng);
    srcs.push(n);

    lp.frequency.setValueAtTime(clamp(f * 9, 1200, 14000), t);
    lp.frequency.exponentialRampToValueAtTime(clamp(f * 3.4, 500, 9000), t + 0.35);

    const decay = clamp(dur * 1.6 + 0.35, 0.25, 1.6);
    const end = envPerc(g.gain, t, 0.2 * vel, 0.004, decay);
    for (const s of srcs) startSource(s, t, end + 0.02);
    this.track(nodes, srcs, end);
  }

  /** Brass stab: three reeds, a fast scoop, a bandpass "bell" and some drive. */
  private playBrass(dest: AudioNode, t: number, chord: Chord, dur: number, vel: number): void {
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const srcs: AudioScheduledSourceNode[] = [];

    const bp = biquad(ctx, 'bandpass', 1250, 1.05);
    const shp = createShaper(ctx, 0.3, 'none');
    const g = gainNode(ctx, 0);
    bp.connect(shp);
    shp.connect(g);
    g.connect(dest);
    nodes.push(bp, shp, g);

    // Voice the top three chord tones — a section plays the colour, not the root.
    const iv = chord.intervals;
    const picks = [iv[1] ?? 4, iv[2] ?? 7, iv[3] ?? 10];
    for (let i = 0; i < picks.length; i++) {
      let midi = BRASS_BASE + chord.root + picks[i];
      while (midi < 64) midi += 12;
      while (midi > 84) midi -= 12;
      const f = midiToFreq(midi);
      const o = createOsc(ctx, 'reed', f, (i - 1) * 5, 16);
      const og = gainNode(ctx, 0.34);
      o.connect(og);
      og.connect(bp);
      o.frequency.setValueAtTime(f * 0.955, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.038);
      nodes.push(o, og);
      srcs.push(o);
    }

    bp.frequency.setValueAtTime(800, t);
    bp.frequency.exponentialRampToValueAtTime(1600, t + 0.05);
    bp.frequency.exponentialRampToValueAtTime(950, t + Math.max(0.12, dur));

    const end = envADSR(
      g.gain,
      t,
      0.24 * vel,
      { attack: 0.016, decay: 0.07, sustain: 0.62, release: 0.13 },
      Math.max(0.03, dur - 0.16),
    );
    for (const s of srcs) startSource(s, t, end + 0.02);
    this.track(nodes, srcs, end);
  }
}
