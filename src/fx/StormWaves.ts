/**
 * Loco Lift — waves that break over the coastal road.
 *
 * This is the storm's teeth. A wave is not decoration here: it is a timed
 * obstacle that shoves the Jeep inland, kills its speed and breaks the combo,
 * and the whole system is built around making that hit feel *earned*.
 *
 * ## Sets, not a metronome
 *
 * Waves arrive in **sets of two to four**, roughly 5 s apart, with a **20–34 s
 * lull between sets**. That is the entire gameplay loop of the malecón: you
 * watch a set come through, you count it out, and you run the seafront in the
 * gap. A uniform interval would train nothing; a random interval would feel
 * unfair. Sets give the player something to read.
 *
 * ## The telegraph (non-negotiable)
 *
 * Every wave is visible and audible for **~3.2 s before it lands**:
 *
 *  1. a swell rises out of the shallows and runs shoreward — you can see it
 *     from the road, and it grows as it shoals;
 *  2. a low `wave` cue fires as it starts in, panned to the wave;
 *  3. spray starts coming over the parapet a beat before the crest does;
 *  4. the break itself is loud and throws white water well above the wall.
 *
 * Only *then* does the wash sheet cross the carriageway. If a player is hit,
 * they had three seconds and four separate cues.
 *
 * ## Geometry
 *
 * One `InstancedBufferGeometry`, one draw call for every wave on screen. Each
 * instance is a (u, v) grid mapped in the vertex shader into a shore-local
 * frame taken from the coast model's promenade: `u` runs along the crest, `v`
 * runs from the wash tip on the road out to deep water. The height field is
 * analytic — a shoaling shoulder, a steepening face, and a run-up sheet — and
 * the normal is a finite difference of the same function, so the lighting is
 * consistent with the shape rather than approximated.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/MathUtils';
import type { RNG } from '../core/RNG';
import type { QualityTier, SfxId } from '../core/types';
import { SEA_LEVEL } from '../world/CityLayout';
import { coastModel } from '../world/Coast';
import type { PromenadeStation } from '../world/Coast';
import type { CityLayout } from '../world/WorldTypes';
import type { SprayPool } from './Debris';
import type { WeatherDrive } from './Weather';

/* ------------------------------------------------------------------ tuning */

/** Seconds a wave takes from first swell to fully drained. */
const WAVE_LIFETIME = 7.0;
/** Fraction of the lifetime at which the crest reaches the wall. */
const P_BREAK = 0.46;
/** Fraction at which the run-up reaches its furthest point inland. */
const P_WASH_END = 0.72;

/** Seconds between the end of one set and the start of the next. */
const SET_GAP_MIN = 20;
const SET_GAP_SPAN = 14;
/** Seconds between waves inside a set. */
const WAVE_GAP_MIN = 4.6;
const WAVE_GAP_SPAN = 1.8;

/** Player must be within this of the promenade for a set to be scheduled. */
const ACTIVE_RANGE = 340;

/** Impulse is authored against this mass; scale by `mass / 1400` if it differs. */
export const WAVE_REFERENCE_MASS = 1400;
/**
 * Sideways velocity change a full-power strike is worth, m/s.
 *
 * Calibrated against a wall: a solid hit in this game stops the Jeep dead, so a
 * wave has to cost meaningfully *less* than that or the seafront is simply a
 * no-go zone. 4–6.6 m/s of shove plus the brake term below takes a 24 m/s run
 * down to about 15 m/s and pushes it a full lane wide — you keep driving, you
 * lose the line and the combo.
 */
const STRIKE_DV_MIN = 4.0;
const STRIKE_DV_MAX = 6.6;
/** Fraction of forward speed a strike scrubs off, plus a flat term in m/s. */
const STRIKE_BRAKE_FRACTION = 0.3;
const STRIKE_BRAKE_FLAT = 2.2;
/** Vertical component, as a fraction of the lateral shove. Enough to unload
 *  the wheels and make the slide loose; not enough to launch the car. */
const STRIKE_LIFT = 0.12;
/** Wash depth below which a wave cannot land a hit, metres. */
const STRIKE_MIN_DEPTH = 0.22;

interface TierSpec {
  /** grid divisions along the crest */
  us: number;
  /** grid divisions across the shore */
  vs: number;
  /** concurrent waves */
  max: number;
  /** spray puffs per second at the break, at full power */
  sprayRate: number;
}

const TIERS: Record<QualityTier, TierSpec> = {
  low: { us: 22, vs: 14, max: 2, sprayRate: 34 },
  medium: { us: 38, vs: 22, max: 4, sprayRate: 70 },
  high: { us: 54, vs: 32, max: 6, sprayRate: 120 },
  ultra: { us: 64, vs: 38, max: 8, sprayRate: 160 },
};

/* ------------------------------------------------------------------ shader */

/**
 * The wave height field, shared by the vertex shader and (in TypeScript, in
 * `heightAt`) by the strike test. If you change one, change the other — the
 * whole "that was my fault" contract rests on the water you can see being the
 * water that hits you.
 */
const WAVE_COMMON = /* glsl */ `
uniform float uBreak;
uniform float uWashEnd;

/** Beach profile: road height at the wall falling to sea level at the water. */
float locoBase( float d, float wallY, float water ) {
  if ( d <= 0.0 ) return wallY;
  float k = clamp( d / max( water, 1.0 ), 0.0, 1.0 );
  return wallY * pow( 1.0 - k, 0.35 );
}

/** Distance of the crest from the wall at phase p (metres, + = seaward). */
float locoCrest( float p, float water ) {
  float t = clamp( p / uBreak, 0.0, 1.0 );
  return mix( water * 1.30, 0.0, t * t * ( 3.0 - 2.0 * t ) );
}

/** Leading edge of the water at phase p. Negative once it is on the road. */
float locoFront( float p, float water, float wash ) {
  if ( p < uBreak ) return locoCrest( p, water );
  if ( p < uWashEnd ) {
    float t = ( p - uBreak ) / ( uWashEnd - uBreak );
    // decelerating run-up: it charges the kerb then slows as it spreads
    return mix( 0.0, -wash, 1.0 - ( 1.0 - t ) * ( 1.0 - t ) );
  }
  float t = ( p - uWashEnd ) / max( 1.0 - uWashEnd, 1e-3 );
  return mix( -wash, water * 0.55, t * t );
}

/**
 * Water surface elevation above the beach at distance d, phase p.
 * Returns (height, foam).
 */
vec2 locoWave( float d, float p, float amp, float water, float wash ) {
  float dc = locoCrest( p, water );
  float rel = d - dc;

  // the face steepens as it shoals; the back stays long and smooth
  float shoal = 1.0 - clamp( dc / max( water * 1.3, 1.0 ), 0.0, 1.0 );
  float frontLen = mix( 13.0, 3.4, shoal );
  float backLen = mix( 26.0, 17.0, shoal );

  float back = exp( -pow( max( rel, 0.0 ) / backLen, 1.7 ) );
  float front = exp( -pow( max( -rel, 0.0 ) / frontLen, 2.3 ) );

  // it grows as it stands up, then collapses into the wash
  float gain = mix( 0.42, 1.0, smoothstep( 0.0, 0.34, shoal ) );
  gain *= 1.0 - smoothstep( uBreak, uBreak + 0.20, p ) * 0.86;
  float crestH = amp * max( back, front ) * gain;

  // the run-up sheet: thin, fast, and the thing that actually hits the car
  float fr = locoFront( p, water, wash );
  float sheetT = amp * 0.30 * ( 1.0 - smoothstep( uBreak, 1.0, p ) * 0.55 );
  float sheet = sheetT
    * smoothstep( 0.0, 5.0, d - fr )
    * ( 1.0 - smoothstep( water * 0.25, water * 0.95, max( d, 0.0 ) ) )
    * smoothstep( uBreak - 0.06, uBreak + 0.06, p );

  float h = max( crestH, sheet );
  float exists = smoothstep( -1.2, 2.6, d - fr );
  h *= exists;

  float foam = 0.0;
  foam += front * smoothstep( 0.30, 0.52, shoal );           // the breaking face
  foam += smoothstep( 0.0, 1.4, sheet ) * 0.85;              // the wash
  foam += ( 1.0 - smoothstep( 0.0, 7.0, abs( d - fr ) ) ) * 0.8; // the leading edge
  foam *= exists;

  return vec2( h, clamp( foam, 0.0, 1.0 ) );
}
`;

const WAVE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${WAVE_COMMON}

attribute vec3 aOrigin;
attribute vec4 aAxis;    // tx, tz, nx, nz
attribute vec4 aShape;   // crest length, amplitude, water distance, wash distance
attribute vec4 aPhase;   // phase, seed, power, peel

varying vec3  vWorld;
varying vec3  vNrm;
varying float vFoam;
varying float vHeight;
varying float vPower;
varying float vSeed;
varying float vEdge;

vec3 locoPoint( float u, float v, out float foamOut, out float hOut ) {
  float L = aShape.x;
  float amp = aShape.y;
  float water = aShape.z;
  float wash = aShape.w;

  // the crest peels along the beach instead of landing as one flat slab
  float p = aPhase.x + u * aPhase.w;
  // and its height varies along its length
  float ampU = amp * ( 0.78 + 0.22 * sin( u * L * 0.085 + aPhase.y * 31.4 ) );

  float d = mix( -wash, water * 1.45, v );
  vec2 hf = locoWave( d, p, ampU, water, wash );
  float base = locoBase( d, aOrigin.y, water );

  foamOut = hf.y;
  hOut = hf.x;

  vec2 t2 = aAxis.xy;
  vec2 n2 = aAxis.zw;
  return vec3(
    aOrigin.x + t2.x * ( u * L ) + n2.x * d,
    base + hf.x,
    aOrigin.z + t2.y * ( u * L ) + n2.y * d
  );
}

void main() {
  float u = position.x;
  float v = position.z;

  float foam;
  float h;
  vec3 wp = locoPoint( u, v, foam, h );

  // analytic-ish normal from the same field, so the shading matches the shape
  float du = 0.006;
  float dv = 0.010;
  float f0;
  float h0;
  vec3 pu = locoPoint( min( u + du, 0.5 ), v, f0, h0 );
  vec3 pv = locoPoint( u, min( v + dv, 1.0 ), f0, h0 );
  vec3 nrm = normalize( cross( pv - wp, pu - wp ) );
  if ( nrm.y < 0.0 ) nrm = -nrm;

  vWorld = wp;
  vNrm = nrm;
  vFoam = foam;
  vHeight = h;
  vPower = aPhase.z;
  vSeed = aPhase.y;
  // soften both ends of the crest so a wave does not stop dead in mid-air
  vEdge = 1.0 - smoothstep( 0.34, 0.5, abs( u ) );

  vec4 mv = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mv;

  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}
`;

const WAVE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform vec3  uBodyShallow;
uniform vec3  uBodyDeep;
uniform vec3  uFoamCol;
uniform vec3  uSunDir;
uniform vec3  uSunCol;
uniform vec3  uSkyLow;
uniform vec3  uSkyHigh;
uniform vec3  uLight;
uniform float uTime;
uniform float uOpacity;

varying vec3  vWorld;
varying vec3  vNrm;
varying float vFoam;
varying float vHeight;
varying float vPower;
varying float vSeed;
varying float vEdge;

float locoHash21( vec2 p ) {
  p = fract( p * vec2( 191.37, 733.19 ) );
  p += dot( p, p + 27.31 );
  return fract( p.x * p.y );
}
float locoNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( locoHash21( i ), locoHash21( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( locoHash21( i + vec2( 0.0, 1.0 ) ), locoHash21( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y
  );
}

void main() {
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 N = normalize( vNrm );

  /* --- body: a storm sea is jade-green and full of sand --- */
  float depth = clamp( vHeight / 3.2, 0.0, 1.0 );
  vec3 body = mix( uBodyShallow, uBodyDeep, depth );

  // light coming through the back of the standing face — the one thing that
  // makes a big wave read as water rather than as a green wall
  float through = pow( clamp( dot( V, -normalize( vec3( uSunDir.x, -0.22, uSunDir.z ) ) ), 0.0, 1.0 ), 2.4 );
  body += uBodyShallow * through * ( 0.35 + depth * 0.9 ) * 0.85;

  body *= uLight;

  /* --- sky reflection --- */
  vec3 R = reflect( -V, N );
  R.y = abs( R.y ) * 0.6 + 0.3;
  vec3 sky = mix( uSkyLow, uSkyHigh, pow( clamp( R.y, 0.0, 1.0 ), 0.45 ) );
  float fres = pow( 1.0 - max( dot( N, V ), 0.0 ), 4.0 );
  vec3 col = mix( body, sky, clamp( 0.06 + fres * 0.5, 0.0, 0.72 ) );

  /* --- specular off the churn --- */
  vec3 H = normalize( uSunDir + V );
  col += uSunCol * pow( max( dot( N, H ), 0.0 ), 120.0 ) * 1.9;

  /* --- foam --- */
  float grain = locoNoise2( vWorld.xz * 1.15 + vec2( uTime * 0.9, vSeed * 40.0 ) );
  float grain2 = locoNoise2( vWorld.xz * 3.6 - vec2( uTime * 1.7, 0.0 ) );
  float foam = clamp( vFoam * ( 0.45 + 0.75 * grain ) + vFoam * vFoam * 0.5, 0.0, 1.0 );
  foam *= 0.55 + 0.45 * grain2;
  foam = clamp( foam * ( 0.7 + 0.6 * vPower ), 0.0, 1.0 );
  col = mix( col, uFoamCol * uLight * 1.05, foam );

  /* --- opacity: the body is water, the wash sheet is a film --- */
  float a = clamp( 0.20 + vHeight * 0.95 + foam * 0.72, 0.0, 1.0 );
  a *= vEdge * uOpacity;
  if ( a < 0.01 ) discard;

  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), a );

  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------- data */

interface Wave {
  active: boolean;
  /** 0..1 lifecycle */
  phase: number;
  /** origin, at the parapet line, y = road height */
  ox: number;
  oy: number;
  oz: number;
  /** along-shore unit */
  tx: number;
  tz: number;
  /** seaward unit */
  nx: number;
  nz: number;
  /** crest length, metres */
  length: number;
  /** peak height above the local base, metres */
  amp: number;
  /** distance from the parapet out to the waterline, metres */
  water: number;
  /** how far inland the run-up reaches past the parapet, metres */
  wash: number;
  /** 0..1 how hard this one hits */
  power: number;
  /** phase offset per unit u, makes the crest peel */
  peel: number;
  seed: number;
  /** false for the small ambience waves a plain shower throws at the wall */
  canStrike: boolean;
  /** true once the impulse has been consumed */
  struck: boolean;
  /** cue bookkeeping */
  saidApproach: boolean;
  saidBreak: boolean;
  sprayDebt: number;
}

function blankWave(): Wave {
  return {
    active: false, phase: 0,
    ox: 0, oy: 0, oz: 0, tx: 1, tz: 0, nx: 0, nz: 1,
    length: 60, amp: 3, water: 45, wash: 18, power: 1, peel: 0, seed: 0,
    canStrike: false, struck: false, saidApproach: false, saidBreak: false, sprayDebt: 0,
  };
}

export interface StormWavesHooks {
  /** fire a positioned sound effect */
  sfx(id: SfxId, at: THREE.Vector3, volume: number, pitch: number): void;
  /** a wave has just landed on the player */
  onStrike(power: number, at: THREE.Vector3): void;
}

/* ------------------------------------------------------------------ system */

export class StormWaves {
  readonly group = new THREE.Group();

  private quality: QualityTier;
  private rng: RNG;
  private hooks: StormWavesHooks;
  private spray: SprayPool | null = null;

  private stations: PromenadeStation[] = [];
  /** distance from each station out to the waterline */
  private waterDist: Float32Array = new Float32Array(0);
  private promLength = 0;

  private waves: Wave[] = [];
  private setTimer = 8;
  private setRemaining = 0;
  private waveTimer = 0;
  private lastSetS = 0;
  /** smoothed along-shore speed of the player, m/s, signed */
  private playerRate = 0;
  private playerS = -1;

  private mesh: THREE.Mesh | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private aOrigin: THREE.InstancedBufferAttribute | null = null;
  private aAxis: THREE.InstancedBufferAttribute | null = null;
  private aShape: THREE.InstancedBufferAttribute | null = null;
  private aPhaseAttr: THREE.InstancedBufferAttribute | null = null;

  private _strikes = 0;
  private _lastStrikeImpulse = 0;
  private tmpAt = new THREE.Vector3();
  private disposed = false;

  constructor(quality: QualityTier, rng: RNG, hooks: StormWavesHooks) {
    this.quality = quality;
    this.rng = rng;
    this.hooks = hooks;
    this.group.name = 'fx/stormWaves';
    this.group.renderOrder = 8;
  }

  /* ------------------------------------------------------------- lifecycle */

  build(layout: CityLayout, spray: SprayPool | null): void {
    this.spray = spray;
    const model = coastModel(layout);
    this.stations = model.promenade;
    this.promLength =
      this.stations.length > 0 ? this.stations[this.stations.length - 1].s : 0;

    /* march out to the waterline once, per station */
    const n = this.stations.length;
    this.waterDist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const st = this.stations[i];
      let d = 62;
      for (let k = 4; k <= 110; k += 2) {
        const x = st.x + st.nx * k;
        const z = st.z + st.nz * k;
        if (layout.groundHeight(x, z) <= SEA_LEVEL) {
          d = k;
          break;
        }
      }
      this.waterDist[i] = clamp(d, 14, 110);
    }

    this.buildMesh();
    this.setTimer = 6 + this.rng.next() * 8;
  }

  onQualityChange(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.destroyMesh();
    this.buildMesh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyMesh();
    this.group.removeFromParent();
    this.group.clear();
  }

  /* ------------------------------------------------------------------ tick */

  update(drive: WeatherDrive, dt: number, playerPos: THREE.Vector3): void {
    const power = clamp01(drive.amount * lerp(0.24, 1, drive.storm));
    this.schedule(drive, dt, playerPos, power);

    const spec = TIERS[this.quality];
    for (const w of this.waves) {
      if (!w.active) continue;
      w.phase += dt / WAVE_LIFETIME;
      if (w.phase >= 1) {
        w.active = false;
        continue;
      }
      this.cues(w, dt, spec);
    }

    this.pushInstances(drive);
  }

  /* -------------------------------------------------------------- schedule */

  private schedule(drive: WeatherDrive, dt: number, playerPos: THREE.Vector3, power: number): void {
    if (this.stations.length === 0) return;
    if (power <= 0.02) {
      this.setTimer = Math.max(this.setTimer, 4);
      return;
    }

    // no sets at all when the player is nowhere near the water: the budget is
    // better spent on the rain, and nobody is there to be threatened
    const near = this.nearestStation(playerPos);
    if (near.dist > ACTIVE_RANGE) return;

    /* track how fast they are running the malecón, and which way */
    if (this.playerS >= 0 && dt > 1e-4) {
      const d = near.s - this.playerS;
      // a jump means the nearest station flipped runs, not a teleport
      if (Math.abs(d) < 60) {
        this.playerRate += (clamp(d / dt, -45, 45) - this.playerRate) * Math.min(1, dt * 1.6);
      }
    }
    this.playerS = near.s;

    if (this.setRemaining > 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        // Aim at where the player will be when this crest actually lands, then
        // scatter it wide. The real sea breaks along the whole coast at once;
        // we only simulate the stretch anyone can see, so placing each wave
        // near the player is honest as well as cheap. The ±230 m scatter is
        // what keeps it a hazard to read rather than a homing missile — about
        // one wave in four lands on a player running the malecón flat out.
        const lead = near.s + this.playerRate * WAVE_LIFETIME * P_BREAK;
        this.lastSetS = lead + this.rng.range(-230, 230);
        this.spawn(this.lastSetS, drive, power);
        this.setRemaining--;
        this.waveTimer = WAVE_GAP_MIN + this.rng.next() * WAVE_GAP_SPAN;
        if (this.setRemaining === 0) {
          this.setTimer = SET_GAP_MIN + this.rng.next() * SET_GAP_SPAN;
        }
      }
      return;
    }

    this.setTimer -= dt;
    if (this.setTimer > 0) return;

    // a storm runs full sets; plain rain gets a single ambience wave that
    // slaps the wall and never reaches the carriageway
    const stormy = drive.storm > 0.45;
    this.setRemaining = stormy ? 2 + this.rng.int(0, 2) : 1;
    this.waveTimer = 0;
  }

  private spawn(s: number, drive: WeatherDrive, power: number): void {
    const spec = TIERS[this.quality];
    let slot: Wave | null = null;
    for (const w of this.waves) {
      if (!w.active) {
        slot = w;
        break;
      }
    }
    if (!slot || this.activeCount() >= spec.max) return;

    const idx = this.stationIndexAtS(s);
    const st = this.stations[idx];
    const stormy = drive.storm;

    slot.active = true;
    slot.phase = 0;
    slot.ox = st.x;
    slot.oy = st.y;
    slot.oz = st.z;
    slot.tx = st.tx;
    slot.tz = st.tz;
    slot.nx = st.nx;
    slot.nz = st.nz;
    // storm crests are long: a wall of water running a whole block of the
    // malecón, peeling as it goes, is both the look and the reason a hit is
    // avoidable — you can see where it has already broken
    slot.length = this.rng.range(82, 152) * lerp(0.5, 1, stormy);
    slot.amp = lerp(1.5, 3.4, stormy) + this.rng.next() * lerp(0.8, 2.3, stormy);
    slot.water = this.waterDist[idx];
    // only a storm run-up crosses the road; rain slaps the wall and stops
    slot.wash = lerp(3.5, 15, stormy) + this.rng.next() * lerp(2, 13, stormy);
    slot.power = clamp01(power * lerp(0.35, 1, stormy));
    slot.peel = this.rng.range(-0.075, 0.075);
    slot.seed = this.rng.next();
    // a shower does not put a metre of moving water across a carriageway; the
    // ambience waves are drawn but they are not obstacles
    slot.canStrike = stormy > 0.45;
    slot.struck = false;
    slot.saidApproach = false;
    slot.saidBreak = false;
    slot.sprayDebt = 0;
  }

  /* ------------------------------------------------------------------ cues */

  private cues(w: Wave, dt: number, spec: TierSpec): void {
    const spray = this.spray;

    /* --- 1. the approach roll, ~3.2 s before it lands --- */
    if (!w.saidApproach && w.phase > 0.03) {
      w.saidApproach = true;
      this.tmpAt.set(w.ox + w.nx * w.water * 0.7, SEA_LEVEL + 1.5, w.oz + w.nz * w.water * 0.7);
      this.hooks.sfx('wave', this.tmpAt, 0.32 + w.power * 0.34, 0.58 + this.rng.next() * 0.12);
    }

    /* --- 2. the break --- */
    if (!w.saidBreak && w.phase >= P_BREAK) {
      w.saidBreak = true;
      this.tmpAt.set(w.ox, w.oy + 2, w.oz);
      this.hooks.sfx('wave', this.tmpAt, 0.55 + w.power * 0.45, 0.82 + this.rng.next() * 0.2);
    }

    if (!spray) return;

    /* --- 3. spray: over the parapet before the crest, then the explosion --- */
    let rate = 0;
    let jet = 0;
    if (w.phase > 0.30 && w.phase < P_BREAK) {
      // the wall is already being hit by the wave's leading water
      const k = (w.phase - 0.3) / (P_BREAK - 0.3);
      rate = spec.sprayRate * 0.28 * k * w.power;
      jet = lerp(5, 11, k);
    } else if (w.phase >= P_BREAK && w.phase < P_BREAK + 0.16) {
      const k = 1 - (w.phase - P_BREAK) / 0.16;
      rate = spec.sprayRate * w.power * k;
      jet = lerp(9, 17, k);
    } else if (w.phase >= P_BREAK && w.phase < P_WASH_END) {
      rate = spec.sprayRate * 0.16 * w.power;
      jet = 3.5;
    }
    if (rate <= 0) return;

    w.sprayDebt += rate * dt;
    let emit = Math.floor(w.sprayDebt);
    w.sprayDebt -= emit;
    if (emit > 24) emit = 24;
    for (let i = 0; i < emit; i++) {
      const u = this.rng.range(-0.44, 0.44) * w.length;
      const along = this.rng.range(-1.5, 5.5);
      const x = w.ox + w.tx * u + w.nx * along;
      const z = w.oz + w.tz * u + w.nz * along;
      const y = w.oy + this.rng.range(0.4, 2.2);
      const up = jet * this.rng.range(0.55, 1.25);
      const inland = this.rng.range(0.25, 1.0) * jet * 0.55;
      this.spray!.spawn(
        x, y, z,
        -w.nx * inland + this.rng.range(-2, 2),
        up,
        -w.nz * inland + this.rng.range(-2, 2),
        this.rng.range(0.5, 1.5),
        this.rng.range(0.75, 1.5),
        this.rng.range(0.35, 0.72) * (0.5 + w.power * 0.5),
        0.75,
      );
    }
  }

  /* ---------------------------------------------------------------- queries */

  /**
   * True while an un-consumed wave has the point under enough moving water to
   * count as a hit. A peek — call `impulseAt` to actually take the hit.
   */
  isStrike(x: number, z: number): boolean {
    return this.findStrike(x, z) !== null;
  }

  /**
   * Take the hit. Writes the impulse (N·s, authored for a 1400 kg vehicle) into
   * `out` and returns it; writes zero and returns it when there is no strike.
   * Consumes the wave, so a single wave can only hit once.
   */
  impulseAt(x: number, z: number, out: THREE.Vector3, vel?: THREE.Vector3 | null): THREE.Vector3 {
    out.set(0, 0, 0);
    const w = this.findStrike(x, z);
    if (!w) return out;
    w.struck = true;

    const d = this.localD(w, x, z);
    const h = heightAt(w, d);
    const depthK = clamp01((h - STRIKE_MIN_DEPTH) / 0.55);
    const strength = clamp01(w.power * (0.45 + 0.55 * depthK));

    // the shove is the direction the water is running: inland, off the sea
    const dv = lerp(STRIKE_DV_MIN, STRIKE_DV_MAX, strength);
    let ix = -w.nx * dv;
    let iz = -w.nz * dv;
    // a peeling wave also drags along the shore, which is what makes the hit
    // feel like a wave and not like a wall
    const drag = w.peel > 0 ? 1 : -1;
    ix += w.tx * dv * 0.24 * drag;
    iz += w.tz * dv * 0.24 * drag;

    let iy = dv * STRIKE_LIFT;

    if (vel) {
      const sp = Math.hypot(vel.x, vel.z);
      if (sp > 0.5) {
        const brake = Math.min(sp, sp * STRIKE_BRAKE_FRACTION + STRIKE_BRAKE_FLAT) * strength;
        ix -= (vel.x / sp) * brake;
        iz -= (vel.z / sp) * brake;
      }
    }

    out.set(ix, iy, iz).multiplyScalar(WAVE_REFERENCE_MASS);
    this._strikes++;
    this._lastStrikeImpulse = out.length();

    this.tmpAt.set(x, w.oy + 0.6, z);
    this.hooks.onStrike(strength, this.tmpAt);
    return out;
  }

  /**
   * 0..1 warning value: how imminent a wave is at this point. 0 means nothing
   * is coming; it climbs through the telegraph and peaks as the wave lands.
   * Optional — wire it to a HUD pip if you want the hint to be explicit.
   */
  threatAt(x: number, z: number): number {
    let best = 0;
    for (const w of this.waves) {
      if (!w.active || !w.canStrike || w.phase > P_WASH_END) continue;
      const u = this.localU(w, x, z);
      if (Math.abs(u) > w.length * 0.45) continue;
      const d = this.localD(w, x, z);
      // only threatens things the run-up can actually reach
      if (d < -w.wash - 4 || d > w.water * 0.9) continue;
      const t = clamp01(w.phase / P_BREAK);
      const v = t * t * w.power;
      if (v > best) best = v;
    }
    return best;
  }

  /** Seconds until the next set starts, for a HUD or for tuning. */
  get secondsToNextSet(): number {
    return this.setRemaining > 0 ? 0 : Math.max(0, this.setTimer);
  }

  get activeWaves(): number {
    return this.activeCount();
  }

  get strikeCount(): number {
    return this._strikes;
  }

  /* ----------------------------------------------------------------- internals */

  private findStrike(x: number, z: number): Wave | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    for (const w of this.waves) {
      if (!w.active || w.struck || !w.canStrike) continue;
      if (w.phase < P_BREAK - 0.02 || w.phase > 0.9) continue;
      // 0.42, not 0.5: the crest fades out over its last 16 %, and nothing may
      // hit the player from a part of the wave they cannot see
      const u = this.localU(w, x, z);
      if (Math.abs(u) > w.length * 0.42) continue;
      const d = this.localD(w, x, z);
      const fr = frontAt(w, w.phase);
      if (d < fr - 0.5 || d > w.water * 0.6) continue;
      if (heightAt(w, d) < STRIKE_MIN_DEPTH) continue;
      return w;
    }
    return null;
  }

  private localU(w: Wave, x: number, z: number): number {
    return (x - w.ox) * w.tx + (z - w.oz) * w.tz;
  }

  private localD(w: Wave, x: number, z: number): number {
    return (x - w.ox) * w.nx + (z - w.oz) * w.nz;
  }

  private activeCount(): number {
    let n = 0;
    for (const w of this.waves) if (w.active) n++;
    return n;
  }

  private nearestStation(p: THREE.Vector3): { s: number; dist: number; index: number } {
    let best = Infinity;
    let bestI = 0;
    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i];
      const dx = st.x - p.x;
      const dz = st.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    const st = this.stations[bestI];
    return { s: st ? st.s : 0, dist: Math.sqrt(best), index: bestI };
  }

  private stationIndexAtS(s: number): number {
    const n = this.stations.length;
    if (n === 0) return 0;
    const target = clamp(s, 0, this.promLength);
    // stations are monotonically increasing in s; a scan is fine at 225 of them
    let bestI = 0;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(this.stations[i].s - target);
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    return bestI;
  }

  /* -------------------------------------------------------------- rendering */

  private buildMesh(): void {
    const spec = TIERS[this.quality];
    this.waves.length = 0;
    for (let i = 0; i < spec.max; i++) this.waves.push(blankWave());

    /* --- the (u, v) sheet --- */
    const us = spec.us;
    const vs = spec.vs;
    const pos = new Float32Array((us + 1) * (vs + 1) * 3);
    const idx: number[] = [];
    let o = 0;
    for (let j = 0; j <= vs; j++) {
      for (let i = 0; i <= us; i++) {
        pos[o++] = i / us - 0.5;
        pos[o++] = 0;
        pos[o++] = j / vs;
      }
    }
    for (let j = 0; j < vs; j++) {
      for (let i = 0; i < us; i++) {
        const a = j * (us + 1) + i;
        const b = a + 1;
        const c = a + us + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);

    const n = spec.max;
    this.aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aAxis = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aShape = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aPhaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aOrigin.setUsage(THREE.DynamicDrawUsage);
    this.aAxis.setUsage(THREE.DynamicDrawUsage);
    this.aShape.setUsage(THREE.DynamicDrawUsage);
    this.aPhaseAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aAxis', this.aAxis);
    geo.setAttribute('aShape', this.aShape);
    geo.setAttribute('aPhase', this.aPhaseAttr);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const srgb = (hex: number): THREE.Color => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    const mat = new THREE.ShaderMaterial({
      name: 'loco/stormWave',
      uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      vertexShader: WAVE_VERT,
      fragmentShader: WAVE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    Object.assign(mat.uniforms, {
      uBreak: { value: P_BREAK },
      uWashEnd: { value: P_WASH_END },
      uBodyShallow: { value: srgb(0x3f8f7a) },
      uBodyDeep: { value: srgb(0x123c40) },
      uFoamCol: { value: srgb(0xeef6f4) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: srgb(0xd8e2ea) },
      uSkyLow: { value: srgb(0x77848d) },
      uSkyHigh: { value: srgb(0x39434c) },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/stormWaves';
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    mesh.visible = false;
    this.group.add(mesh);

    this.geo = geo;
    this.mat = mat;
    this.mesh = mesh;
  }

  private pushInstances(drive: WeatherDrive): void {
    const geo = this.geo;
    const mesh = this.mesh;
    const mat = this.mat;
    if (!geo || !mesh || !mat || !this.aOrigin || !this.aAxis || !this.aShape || !this.aPhaseAttr) {
      return;
    }

    let n = 0;
    for (const w of this.waves) {
      if (!w.active) continue;
      this.aOrigin.setXYZ(n, w.ox, w.oy, w.oz);
      this.aAxis.setXYZW(n, w.tx, w.tz, w.nx, w.nz);
      this.aShape.setXYZW(n, w.length, w.amp, w.water, w.wash);
      this.aPhaseAttr.setXYZW(n, w.phase, w.seed, w.power, w.peel);
      n++;
    }
    geo.instanceCount = n;
    mesh.visible = n > 0;
    if (n === 0) return;

    this.aOrigin.needsUpdate = true;
    this.aAxis.needsUpdate = true;
    this.aShape.needsUpdate = true;
    this.aPhaseAttr.needsUpdate = true;

    const s = drive.light;
    const u = mat.uniforms;
    u.uTime.value = drive.time;
    (u.uSunDir.value as THREE.Vector3).copy(s.sunDir);
    (u.uSunCol.value as THREE.Color).copy(s.sunColor);
    (u.uSkyLow.value as THREE.Color).copy(s.skyHorizon);
    (u.uSkyHigh.value as THREE.Color).copy(s.skyZenith);
    // the wave stands in the same irradiance as everything else
    const direct = s.sunIntensity * 0.24 * Math.max(s.sunDir.y, 0);
    const amb = (0.34 + 0.66 * clamp01(s.dayFactor)) * 0.85;
    const light = u.uLight.value as THREE.Color;
    light.copy(s.sunColor).multiplyScalar(direct);
    light.r += s.skyZenith.r * amb;
    light.g += s.skyZenith.g * amb;
    light.b += s.skyZenith.b * amb;
    const lum = light.r * 0.3 + light.g * 0.6 + light.b * 0.1;
    if (lum < 0.14) light.setScalar(0.14);
    u.uOpacity.value = clamp01(0.55 + drive.amount * 0.45);
  }

  private destroyMesh(): void {
    if (this.mesh) this.group.remove(this.mesh);
    this.geo?.dispose();
    this.mat?.dispose();
    this.geo = null;
    this.mat = null;
    this.mesh = null;
    this.aOrigin = null;
    this.aAxis = null;
    this.aShape = null;
    this.aPhaseAttr = null;
    this.waves.length = 0;
  }

  stats(): Record<string, number> {
    return {
      waveActive: this.activeCount(),
      waveStrikes: this._strikes,
      waveLastImpulse: Number(this._lastStrikeImpulse.toFixed(0)),
      waveNextSet: Number(this.secondsToNextSet.toFixed(1)),
    };
  }
}

/* ------------------------------------------------- CPU mirror of the shader */

/** `locoCrest`, in TypeScript. */
function crestAt(w: Wave, p: number): number {
  const t = clamp01(p / P_BREAK);
  return lerp(w.water * 1.3, 0, t * t * (3 - 2 * t));
}

/** `locoFront`, in TypeScript. */
export function frontAt(w: { water: number; wash: number }, p: number): number {
  if (p < P_BREAK) {
    const t = clamp01(p / P_BREAK);
    return lerp(w.water * 1.3, 0, t * t * (3 - 2 * t));
  }
  if (p < P_WASH_END) {
    const t = (p - P_BREAK) / (P_WASH_END - P_BREAK);
    return lerp(0, -w.wash, 1 - (1 - t) * (1 - t));
  }
  const t = (p - P_WASH_END) / Math.max(1 - P_WASH_END, 1e-3);
  return lerp(-w.wash, w.water * 0.55, t * t);
}

function sstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * `locoWave().x`, in TypeScript — the height of the water above the beach at
 * distance `d` from the parapet. The strike test uses this, so the depth that
 * decides a hit is the depth the player can see.
 */
export function heightAt(w: Wave, d: number): number {
  const p = w.phase;
  const dc = crestAt(w, p);
  const rel = d - dc;
  const shoal = 1 - clamp01(dc / Math.max(w.water * 1.3, 1));
  const frontLen = lerp(13, 3.4, shoal);
  const backLen = lerp(26, 17, shoal);

  const back = Math.exp(-Math.pow(Math.max(rel, 0) / backLen, 1.7));
  const front = Math.exp(-Math.pow(Math.max(-rel, 0) / frontLen, 2.3));
  let gain = lerp(0.42, 1, sstep(0, 0.34, shoal));
  gain *= 1 - sstep(P_BREAK, P_BREAK + 0.2, p) * 0.86;
  const crestH = w.amp * Math.max(back, front) * gain;

  const fr = frontAt(w, p);
  const sheetT = w.amp * 0.3 * (1 - sstep(P_BREAK, 1, p) * 0.55);
  const sheet =
    sheetT *
    sstep(0, 5, d - fr) *
    (1 - sstep(w.water * 0.25, w.water * 0.95, Math.max(d, 0))) *
    sstep(P_BREAK - 0.06, P_BREAK + 0.06, p);

  const h = Math.max(crestH, sheet);
  return h * sstep(-1.2, 2.6, d - fr);
}
