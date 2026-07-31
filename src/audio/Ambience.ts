/**
 * Ambience.ts — the living soundscape of Old San Juan.
 *
 * A set of continuous synthesised beds (sea, crowd, market, traffic, wind,
 * night insects, driving air-rush) whose levels cross-fade as the player moves
 * between districts, plus a scheduler for discrete events that make the place
 * feel inhabited: gulls over the Atlantic, breakers on the sea wall, the
 * cathedral bell on the hour, coquí at night, thunder in a storm.
 *
 * Cultural notes that drive the content (ART_REFERENCE §7.2, §7.4):
 *  - The **coquí** is the island's emblematic night sound — a two-note
 *    "co-QUÍ" call, not generic crickets. It is the night bed here.
 *  - Gulls and breakers belong to the **Atlantic side (−Z)** and the sea wall;
 *    the **bay (+Z)** is calmer, with ship and dock activity instead.
 *  - Old San Juan has no beach inside the walls, so there is no surf-on-sand
 *    layer anywhere — it is water against stone.
 *
 * Everything is level-controlled by `setTargetAtTime`, so movement between
 * zones is a genuine cross-fade rather than a switch.
 */

import { clamp, clamp01, lerp } from '../core/MathUtils';
import { RNG } from '../core/RNG';
import {
  biquad,
  createOsc,
  envPerc,
  finiteOr,
  gainNode,
  noiseSource,
  safeDisconnect,
  setAt,
  startSource,
} from './Synth';
import type { SfxLibrary } from './SfxLibrary';

export type WeatherKind = 'clear' | 'rain' | 'storm' | 'sunset' | 'night';

/** Matches the world module's DistrictZone names; unknown values fall back. */
export type AmbienceZone =
  | 'oldTown'
  | 'plazaMayor'
  | 'waterfront'
  | 'marketRow'
  | 'fortress'
  | 'hillside'
  | 'artQuarter';

export interface AmbienceContext {
  /** listener world position */
  x: number;
  z: number;
  /** 0..24 */
  timeOfDay: number;
  /** district name from the world's zoneAt(); unrecognised is treated as oldTown */
  zone: string;
  /** m/s — drives the air-rush layer */
  speed: number;
  /** true while the simulation is paused; ambience ducks */
  paused?: boolean;
}

type BedId = 'sea' | 'crowd' | 'market' | 'traffic' | 'wind' | 'insects' | 'rush';

interface Bed {
  gain: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  target: number;
  /** mix trim applied on top of the computed weight */
  level: number;
}

interface ZoneMix {
  sea: number;
  crowd: number;
  market: number;
  traffic: number;
  wind: number;
}

const ZONE_MIX: Record<AmbienceZone, ZoneMix> = {
  oldTown: { sea: 0.1, crowd: 0.38, market: 0.06, traffic: 0.5, wind: 0.14 },
  plazaMayor: { sea: 0.06, crowd: 0.85, market: 0.16, traffic: 0.22, wind: 0.2 },
  waterfront: { sea: 0.9, crowd: 0.34, market: 0.1, traffic: 0.36, wind: 0.55 },
  marketRow: { sea: 0.05, crowd: 0.6, market: 0.9, traffic: 0.24, wind: 0.1 },
  fortress: { sea: 0.78, crowd: 0.07, market: 0.0, traffic: 0.05, wind: 0.85 },
  hillside: { sea: 0.3, crowd: 0.2, market: 0.04, traffic: 0.34, wind: 0.36 },
  artQuarter: { sea: 0.12, crowd: 0.45, market: 0.2, traffic: 0.3, wind: 0.2 },
};

const DEFAULT_ZONE: AmbienceZone = 'oldTown';

function asZone(name: string): AmbienceZone {
  return (name in ZONE_MIX ? name : DEFAULT_ZONE) as AmbienceZone;
}

/* --------------------------------------------------------- time of day */

/** 0 at dead of night, 1 through the working day. Drives crowd and market. */
function dayActivity(h: number): number {
  const t = ((h % 24) + 24) % 24;
  if (t < 5) return 0.04;
  if (t < 8) return lerp(0.04, 0.85, (t - 5) / 3);
  if (t < 11) return lerp(0.85, 1, (t - 8) / 3);
  if (t < 19) return 1;
  if (t < 21.5) return lerp(1, 0.6, (t - 19) / 2.5);
  if (t < 24) return lerp(0.6, 0.08, (t - 21.5) / 2.5);
  return 0.08;
}

/** 1 at night, 0 by day, with a soft dusk/dawn ramp. Drives coquí. */
function nightFactor(h: number): number {
  const t = ((h % 24) + 24) % 24;
  if (t >= 19.5 || t < 5) {
    if (t >= 19.5 && t < 20.5) return (t - 19.5) / 1;
    if (t >= 4 && t < 5) return 1 - (t - 4) / 1;
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ class */

export class Ambience {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private readonly sfx: SfxLibrary;
  private readonly rng: RNG;
  private readonly beds = new Map<BedId, Bed>();
  /** one-shot voices we scheduled and must reclaim */
  private pending: { nodes: AudioNode[]; sources: AudioScheduledSourceNode[]; end: number }[] = [];

  private started = false;
  private disposed = false;
  private volume = 1;
  private weather: WeatherKind = 'clear';

  /* schedulers, seconds until next event */
  private gullTimer = 6;
  private waveTimer = 2;
  private thunderTimer = 12;
  private cheerTimer = 30;
  private coquiTimer = 1.5;
  private hornTimer = 14;
  private lastBellHour = -1;

  /** how far out from the city centre the water starts, metres */
  private seaHalfExtent = 330;

  constructor(ctx: BaseAudioContext, destination: AudioNode, sfx: SfxLibrary, seed = 0xa53a) {
    this.ctx = ctx;
    this.sfx = sfx;
    this.rng = new RNG(seed >>> 0);
    this.out = gainNode(ctx, 0);
    this.out.connect(destination);

    this.buildSea();
    this.buildCrowd();
    this.buildMarket();
    this.buildTraffic();
    this.buildWind();
    this.buildInsects();
    this.buildRush();
  }

  /* ------------------------------------------------------------ lifecycle */

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const t = this.ctx.currentTime + 0.02;
    for (const bed of this.beds.values()) {
      for (const s of bed.sources) startSource(s, t);
    }
    setAt(this.out.gain, 0, t);
    this.out.gain.linearRampToValueAtTime(this.volume, t + 1.2);
  }

  stop(fade = 0.8): void {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    setAt(this.out.gain, Math.max(0.0001, this.out.gain.value), t);
    this.out.gain.linearRampToValueAtTime(0, t + Math.max(0.05, fade));
    this.sfx.stopLoop('rainLoop', 0.5);
  }

  setVolume(v: number): void {
    this.volume = clamp(finiteOr(v, 1), 0, 2);
    if (this.started) this.out.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.15);
  }

  setWeather(kind: WeatherKind): void {
    this.weather = kind;
    if (kind === 'rain') {
      this.sfx.startLoop('rainLoop', { volume: 0.42, pitch: 1 });
      this.thunderTimer = 25 + this.rng.next() * 30;
    } else if (kind === 'storm') {
      this.sfx.startLoop('rainLoop', { volume: 0.68, pitch: 0.92 });
      this.thunderTimer = 3 + this.rng.next() * 6;
    } else {
      this.sfx.stopLoop('rainLoop', 2.5);
    }
  }

  /** How far out (metres) the water bed reaches; set from the world bounds. */
  setSeaExtent(halfExtentZ: number): void {
    this.seaHalfExtent = Math.max(40, finiteOr(halfExtentZ, 330));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    setAt(this.out.gain, 0, t);
    for (const bed of this.beds.values()) {
      for (const s of bed.sources) {
        try {
          s.stop(t);
        } catch {
          /* not started */
        }
      }
      for (const n of bed.nodes) safeDisconnect(n);
      safeDisconnect(bed.gain);
    }
    this.beds.clear();
    for (const p of this.pending) {
      for (const s of p.sources) {
        try {
          s.stop(t);
        } catch {
          /* ignore */
        }
      }
      for (const n of p.nodes) safeDisconnect(n);
    }
    this.pending = [];
    safeDisconnect(this.out);
  }

  /* --------------------------------------------------------------- update */

  update(dt: number, actx: AmbienceContext): void {
    if (!this.started || this.disposed) return;
    const now = this.ctx.currentTime;
    const step = clamp(finiteOr(dt, 1 / 60), 0, 0.25);

    const zone = asZone(actx.zone);
    const mix = ZONE_MIX[zone];
    const hour = ((finiteOr(actx.timeOfDay, 12) % 24) + 24) % 24;
    const activity = dayActivity(hour);
    const night = nightFactor(hour);
    const wet = this.weather === 'rain' ? 1 : this.weather === 'storm' ? 1.6 : 0;
    const pausedDuck = actx.paused ? 0.45 : 1;

    // Water gets louder as you approach either shore. The Atlantic (−Z) is
    // rougher than the bay (+Z), so the north side is weighted harder.
    const z = finiteOr(actx.z, 0);
    const shore = clamp01((Math.abs(z) - this.seaHalfExtent * 0.35) / (this.seaHalfExtent * 0.6));
    const atlantic = z < 0 ? 1 : 0.62;
    const seaWeight = clamp01(mix.sea * 0.55 + shore * 0.75) * atlantic;

    // Rain suppresses street life and lifts the wind.
    const crowdW = mix.crowd * activity * lerp(1, 0.3, clamp01(wet)) * pausedDuck;
    const marketW = mix.market * activity * lerp(1, 0.4, clamp01(wet)) * pausedDuck;
    const trafficW = mix.traffic * lerp(0.18, 1, activity) * pausedDuck;
    const windW = clamp01(mix.wind * (1 + wet * 0.55)) * pausedDuck;
    const insectW = night * (1 - clamp01(wet)) * (zone === 'fortress' || zone === 'hillside' ? 1 : 0.55);

    this.setBed('sea', seaWeight * pausedDuck, now);
    this.setBed('crowd', crowdW, now);
    this.setBed('market', marketW, now);
    this.setBed('traffic', trafficW, now);
    this.setBed('wind', windW, now);
    this.setBed('insects', insectW * 0.7 * pausedDuck, now);

    // Air rush from the open-top Jeep. Ramps in from 12 m/s.
    const speed = Math.max(0, finiteOr(actx.speed, 0));
    this.setBed('rush', clamp01((speed - 11) / 34) * 0.85 * (actx.paused ? 0 : 1), now);

    /* ------------------------------------------------------- event timers */
    this.gullTimer -= step;
    this.waveTimer -= step;
    this.thunderTimer -= step;
    this.cheerTimer -= step;
    this.coquiTimer -= step;
    this.hornTimer -= step;

    const nearWater = seaWeight > 0.25;

    if (this.gullTimer <= 0) {
      this.gullTimer = 5 + this.rng.next() * 14;
      if (nearWater && hour > 6 && hour < 19.5 && wet < 0.5) {
        this.sfx.play('seagull', {
          volume: 0.35 + this.rng.next() * 0.35,
          pitch: 0.85 + this.rng.next() * 0.35,
          pan: this.rng.range(-0.9, 0.9),
          cutoff: 9000,
        });
      }
    }

    if (this.waveTimer <= 0) {
      this.waveTimer = 2.6 + this.rng.next() * 3.4;
      if (seaWeight > 0.12) {
        this.sfx.play('wave', {
          volume: 0.3 + seaWeight * 0.6 * (z < 0 ? 1 : 0.6),
          pitch: 0.9 + this.rng.next() * 0.25,
          pan: this.rng.range(-0.7, 0.7),
        });
      }
    }

    if (this.thunderTimer <= 0) {
      if (this.weather === 'storm') {
        this.thunderTimer = 9 + this.rng.next() * 13;
        this.sfx.play('thunder', {
          volume: 0.5 + this.rng.next() * 0.5,
          pitch: 0.6 + this.rng.next() * 0.4,
          pan: this.rng.range(-0.5, 0.5),
        });
      } else if (this.weather === 'rain') {
        this.thunderTimer = 30 + this.rng.next() * 45;
        this.sfx.play('thunder', { volume: 0.3, pitch: 0.58, pan: this.rng.range(-0.4, 0.4) });
      } else {
        this.thunderTimer = 20;
      }
    }

    if (this.cheerTimer <= 0) {
      this.cheerTimer = 26 + this.rng.next() * 40;
      if ((zone === 'plazaMayor' || zone === 'marketRow') && activity > 0.5 && wet < 0.6) {
        this.sfx.play('crowdCheer', {
          volume: 0.18 + this.rng.next() * 0.12,
          pitch: 0.95 + this.rng.next() * 0.15,
          pan: this.rng.range(-0.6, 0.6),
          cutoff: 6000,
        });
      }
    }

    // Coquí: two-note call, staggered from several directions.
    if (this.coquiTimer <= 0) {
      this.coquiTimer = lerp(4.5, 0.7, insectW) + this.rng.next() * 1.5;
      if (insectW > 0.12) this.emitCoqui(now + 0.01, insectW);
    }

    // A distant público horn somewhere in the city — never near, never often.
    if (this.hornTimer <= 0) {
      this.hornTimer = 18 + this.rng.next() * 40;
      if (trafficW > 0.15 && activity > 0.3) {
        this.sfx.play('horn', {
          volume: 0.06 + this.rng.next() * 0.05,
          pitch: 0.82 + this.rng.next() * 0.4,
          pan: this.rng.range(-0.85, 0.85),
          cutoff: 1500,
        });
      }
    }

    // Cathedral bell on the hour, 07:00–21:00.
    const hourInt = Math.floor(hour);
    if (hourInt !== this.lastBellHour) {
      const first = this.lastBellHour < 0;
      this.lastBellHour = hourInt;
      if (!first && hourInt >= 7 && hourInt <= 21) {
        const strikes = hourInt % 12 === 0 ? 12 : hourInt % 12;
        this.emitChurchBells(now + 0.3, strikes, zone === 'plazaMayor' ? 0.5 : 0.32);
      }
    }

    this.sweep(now);
  }

  /* -------------------------------------------------------------- helpers */

  private setBed(id: BedId, weight: number, now: number): void {
    const bed = this.beds.get(id);
    if (!bed) return;
    const target = clamp01(weight) * bed.level;
    if (Math.abs(target - bed.target) < 1e-3) return;
    bed.target = target;
    // 0.7 s time constant — slow enough to be a cross-fade, fast enough that
    // driving out of a plaza actually changes the sound.
    bed.gain.gain.setTargetAtTime(target, now, 0.7);
  }

  private sweep(now: number): void {
    if (this.pending.length === 0) return;
    let w = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.end <= now) {
        for (const s of p.sources) {
          try {
            s.stop(now);
          } catch {
            /* ignore */
          }
        }
        for (const n of p.nodes) safeDisconnect(n);
      } else {
        this.pending[w++] = p;
      }
    }
    this.pending.length = w;
  }

  private makeBed(id: BedId, level: number): Bed {
    const g = gainNode(this.ctx, 0);
    g.connect(this.out);
    const bed: Bed = { gain: g, nodes: [], sources: [], target: 0, level };
    this.beds.set(id, bed);
    return bed;
  }

  /* --------------------------------------------------------- bed builders */

  /** Water against stone: a low surge with a foam band riding on top. */
  private buildSea(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('sea', 0.55);

    const swell = noiseSource(ctx, 'brown', 1, true);
    const swellLp = biquad(ctx, 'lowpass', 340, 1.3);
    const swellG = gainNode(ctx, 0.85);
    swell.connect(swellLp);
    swellLp.connect(swellG);
    swellG.connect(bed.gain);

    const foam = noiseSource(ctx, 'pink', 1, true);
    const foamBp = biquad(ctx, 'bandpass', 1450, 0.65);
    const foamG = gainNode(ctx, 0.22);
    foam.connect(foamBp);
    foamBp.connect(foamG);
    foamG.connect(bed.gain);

    // Two incommensurate LFOs so the swell never obviously repeats.
    const lfoA = createOsc(ctx, 'sine', 0.078);
    const lfoAG = gainNode(ctx, 150);
    lfoA.connect(lfoAG);
    lfoAG.connect(swellLp.frequency);
    const lfoB = createOsc(ctx, 'triangle', 0.041);
    const lfoBG = gainNode(ctx, 0.12);
    lfoB.connect(lfoBG);
    lfoBG.connect(foamG.gain);

    bed.nodes.push(swell, swellLp, swellG, foam, foamBp, foamG, lfoA, lfoAG, lfoB, lfoBG);
    bed.sources.push(swell, foam, lfoA, lfoB);
  }

  /**
   * Crowd murmur. Three vocal formant bands over pink noise with slow,
   * uncorrelated amplitude drift — the sound of many conversations at once.
   */
  private buildCrowd(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('crowd', 0.4);
    const src = noiseSource(ctx, 'pink', 1, true);
    const formants: [number, number, number][] = [
      [480, 1.4, 1],
      [1080, 1.7, 0.55],
      [2350, 2.1, 0.22],
    ];
    for (let i = 0; i < formants.length; i++) {
      const [f, q, g] = formants[i];
      const bp = biquad(ctx, 'bandpass', f, q);
      const bg = gainNode(ctx, g * 0.6);
      src.connect(bp);
      bp.connect(bg);
      bg.connect(bed.gain);
      const lfo = createOsc(ctx, 'sine', 0.09 + i * 0.061);
      const lg = gainNode(ctx, g * 0.24);
      lfo.connect(lg);
      lg.connect(bg.gain);
      bed.nodes.push(bp, bg, lfo, lg);
      bed.sources.push(lfo);
    }
    bed.nodes.push(src);
    bed.sources.push(src);
  }

  /** Market: brighter voices plus a constant low clatter of crates and trays. */
  private buildMarket(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('market', 0.34);
    const src = noiseSource(ctx, 'pink', 1, true);
    const voice = biquad(ctx, 'bandpass', 900, 1.1);
    const voiceG = gainNode(ctx, 0.5);
    src.connect(voice);
    voice.connect(voiceG);
    voiceG.connect(bed.gain);

    // Clatter: a high band chopped by a fast, irregular tremolo.
    const clat = noiseSource(ctx, 'white', 1, true);
    const clatBp = biquad(ctx, 'bandpass', 3100, 3.2);
    const clatG = gainNode(ctx, 0.05);
    clat.connect(clatBp);
    clatBp.connect(clatG);
    clatG.connect(bed.gain);
    const chop = createOsc(ctx, 'square', 5.7);
    const chopG = gainNode(ctx, 0.05);
    chop.connect(chopG);
    chopG.connect(clatG.gain);
    const chop2 = createOsc(ctx, 'triangle', 1.31);
    const chop2G = gainNode(ctx, 0.035);
    chop2.connect(chop2G);
    chop2G.connect(clatG.gain);

    const drift = createOsc(ctx, 'sine', 0.11);
    const driftG = gainNode(ctx, 0.2);
    drift.connect(driftG);
    driftG.connect(voiceG.gain);

    bed.nodes.push(src, voice, voiceG, clat, clatBp, clatG, chop, chopG, chop2, chop2G, drift, driftG);
    bed.sources.push(src, clat, chop, chop2, drift);
  }

  /** Distant traffic: a low hum with slow passes, never a specific vehicle. */
  private buildTraffic(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('traffic', 0.3);
    const src = noiseSource(ctx, 'brown', 1, true);
    const lp = biquad(ctx, 'lowpass', 340, 1.1);
    const g = gainNode(ctx, 0.9);
    src.connect(lp);
    lp.connect(g);
    g.connect(bed.gain);

    // Passes: a slow sweep of the cutoff plus an amplitude bump.
    const pass = createOsc(ctx, 'sine', 0.061);
    const passG = gainNode(ctx, 160);
    pass.connect(passG);
    passG.connect(lp.frequency);
    const pass2 = createOsc(ctx, 'triangle', 0.023);
    const pass2G = gainNode(ctx, 0.28);
    pass2.connect(pass2G);
    pass2G.connect(g.gain);

    // A whisper of tyre noise on cobbles.
    const tyre = noiseSource(ctx, 'pink', 1, true);
    const tyreBp = biquad(ctx, 'bandpass', 780, 0.9);
    const tyreG = gainNode(ctx, 0.09);
    tyre.connect(tyreBp);
    tyreBp.connect(tyreG);
    tyreG.connect(bed.gain);

    bed.nodes.push(src, lp, g, pass, passG, pass2, pass2G, tyre, tyreBp, tyreG);
    bed.sources.push(src, pass, pass2, tyre);
  }

  /** Trade wind over the fort walls. */
  private buildWind(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('wind', 0.22);
    const src = noiseSource(ctx, 'pink', 1, true);
    const bp = biquad(ctx, 'bandpass', 520, 0.75);
    const g = gainNode(ctx, 0.9);
    src.connect(bp);
    bp.connect(g);
    g.connect(bed.gain);
    const gust = createOsc(ctx, 'sine', 0.053);
    const gustG = gainNode(ctx, 260);
    gust.connect(gustG);
    gustG.connect(bp.frequency);
    const gust2 = createOsc(ctx, 'triangle', 0.019);
    const gust2G = gainNode(ctx, 0.35);
    gust2.connect(gust2G);
    gust2G.connect(g.gain);
    bed.nodes.push(src, bp, g, gust, gustG, gust2, gust2G);
    bed.sources.push(src, gust, gust2);
  }

  /** Night insects — a fine high shimmer under the coquí. */
  private buildInsects(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('insects', 0.1);
    const src = noiseSource(ctx, 'white', 1, true);
    const bp = biquad(ctx, 'bandpass', 6400, 5.5);
    const g = gainNode(ctx, 0.5);
    src.connect(bp);
    bp.connect(g);
    g.connect(bed.gain);
    const trem = createOsc(ctx, 'sine', 28);
    const tremG = gainNode(ctx, 0.35);
    trem.connect(tremG);
    tremG.connect(g.gain);
    bed.nodes.push(src, bp, g, trem, tremG);
    bed.sources.push(src, trem);
  }

  /** Air rushing past an open-top Jeep. Purely speed-driven. */
  private buildRush(): void {
    const ctx = this.ctx;
    const bed = this.makeBed('rush', 0.3);
    const src = noiseSource(ctx, 'pink', 1, true);
    const bp = biquad(ctx, 'bandpass', 620, 0.8);
    const hp = biquad(ctx, 'highpass', 180, 0.7);
    const g = gainNode(ctx, 0.9);
    src.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(bed.gain);
    const flap = createOsc(ctx, 'sine', 0.9);
    const flapG = gainNode(ctx, 120);
    flap.connect(flapG);
    flapG.connect(bp.frequency);
    bed.nodes.push(src, bp, hp, g, flap, flapG);
    bed.sources.push(src, flap);
  }

  /* ------------------------------------------------------- discrete events */

  /**
   * Coquí. The call is two notes: a short "co" and a longer, higher "quí"
   * about a quarter of a second later. Several frogs answer each other, so we
   * fire two or three from different directions.
   */
  private emitCoqui(t: number, strength: number): void {
    const ctx = this.ctx;
    const voices = 1 + (this.rng.next() < 0.45 * strength ? 1 : 0);
    for (let v = 0; v < voices; v++) {
      const at = t + v * (0.18 + this.rng.next() * 0.5);
      const pan = ctx.createStereoPanner();
      pan.pan.value = this.rng.range(-0.9, 0.9);
      pan.connect(this.out);
      const nodes: AudioNode[] = [pan];
      const srcs: AudioScheduledSourceNode[] = [];
      const amp = (0.05 + this.rng.next() * 0.05) * strength;
      const tune = 0.92 + this.rng.next() * 0.18;

      // "co" — short, lower.
      const co = createOsc(ctx, 'sine', 1180 * tune);
      const coG = gainNode(ctx, 0);
      co.connect(coG);
      coG.connect(pan);
      co.frequency.setValueAtTime(1080 * tune, at);
      co.frequency.exponentialRampToValueAtTime(1230 * tune, at + 0.05);
      const coEnd = envPerc(coG.gain, at, amp * 0.7, 0.008, 0.07);
      startSource(co, at, coEnd + 0.02);
      nodes.push(co, coG);
      srcs.push(co);

      // "quí" — higher, longer, with a slight upward bend.
      const qStart = at + 0.19 + this.rng.next() * 0.05;
      const qui = createOsc(ctx, 'sine', 2050 * tune);
      const quiG = gainNode(ctx, 0);
      const quiBp = biquad(ctx, 'bandpass', 2100 * tune, 3.5);
      qui.connect(quiBp);
      quiBp.connect(quiG);
      quiG.connect(pan);
      qui.frequency.setValueAtTime(1880 * tune, qStart);
      qui.frequency.exponentialRampToValueAtTime(2180 * tune, qStart + 0.11);
      const quiEnd = envPerc(quiG.gain, qStart, amp, 0.02, 0.16);
      startSource(qui, qStart, quiEnd + 0.02);
      nodes.push(qui, quiBp, quiG);
      srcs.push(qui);

      this.pending.push({ nodes, sources: srcs, end: Math.max(coEnd, quiEnd) + 0.1 });
    }
  }

  /**
   * The cathedral bell. Struck-bell partials (hum, prime, tierce, quint,
   * nominal) with a long, slightly detuned tail, one strike per hour.
   */
  private emitChurchBells(t: number, strikes: number, amp: number): void {
    const ctx = this.ctx;
    const count = clamp(Math.round(strikes), 1, 12);
    const spacing = 2.1;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng.range(-0.35, 0.35);
    pan.connect(this.out);
    const nodes: AudioNode[] = [pan];
    const srcs: AudioScheduledSourceNode[] = [];
    let end = t;

    const ratios = [0.5, 1, 1.183, 1.506, 2, 2.55, 3.01];
    const gains = [0.42, 1, 0.5, 0.34, 0.4, 0.16, 0.09];
    const decays = [4.2, 3.2, 2.1, 1.6, 1.2, 0.7, 0.45];

    for (let s = 0; s < count; s++) {
      const at = t + s * spacing;
      const base = 262 * (1 + (this.rng.next() - 0.5) * 0.006);
      for (let i = 0; i < ratios.length; i++) {
        const f = base * ratios[i];
        if (f > 12000) continue;
        const o = createOsc(ctx, 'sine', f);
        const g = gainNode(ctx, 0);
        o.connect(g);
        g.connect(pan);
        const e = envPerc(g.gain, at, amp * gains[i] * 0.2, 0.006, decays[i]);
        startSource(o, at, e + 0.02);
        nodes.push(o, g);
        srcs.push(o);
        if (e > end) end = e;
      }
      // Clapper strike.
      const n = noiseSource(ctx, 'white', 1, true);
      const bp = biquad(ctx, 'bandpass', 3200, 2.4);
      const ng = gainNode(ctx, 0);
      n.connect(bp);
      bp.connect(ng);
      ng.connect(pan);
      envPerc(ng.gain, at, amp * 0.06, 0.001, 0.03);
      startSource(n, at, at + 0.08);
      nodes.push(n, bp, ng);
      srcs.push(n);
    }
    this.pending.push({ nodes, sources: srcs, end: end + 0.2 });
  }
}
