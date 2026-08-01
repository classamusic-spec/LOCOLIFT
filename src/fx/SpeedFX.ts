/**
 * Loco Lift — the speed and boost pass.
 *
 * Everything that says *fast*: radial streak blur, chromatic streaking at the
 * tail of those streaks, speed lines, and the lens distortion punch when boost
 * engages. It sits after bloom and before the grade, so the streaks smear
 * light that has already bloomed — which is what makes a lamp turn into a
 * comet at 45 m/s instead of a grey dash.
 *
 * Two constraints shape every number in here.
 *
 * **§6.2 R10 is a law, not a preference.** Radial blur is 0.18 at the screen
 * edge and *exactly* zero inside the central 42 % of the frame radius. Same for
 * the chromatic tail, the speed lines and the distortion. All four multiply by
 * the one shared `locoEdge` mask from `PostEffects`, so the protected disc is
 * provably identical across effects. A racer you cannot read is a failed racer
 * however good the boost feels.
 *
 * **Boost has to feel violent without strobing.** The violence is delivered as
 * *motion* — a distortion punch that decays over ~0.25 s, streaks that lengthen,
 * a warm rim that pushes in from the corners — and never as a flashing overlay.
 * Speed lines animate by sliding outward, not by blinking on and off. The whole
 * boost layer is additionally scaled by `uSafety`, which the pipeline drives
 * from `settings.photosensitiveSafe`.
 */
import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import type { QualityTier } from '../core/types';
import { GLSL_COLOR, GLSL_NOISE, GLSL_RADIAL, QUAD_VERT } from './PostEffects';

/** Taps along each streak. More taps = smoother streak, not a longer one. */
export const SPEED_SAMPLES: Record<QualityTier, number> = {
  low: 0,
  medium: 6,
  high: 9,
  ultra: 13,
};

/** §6.2 R10 — the hard ceiling on radial blur strength at the screen edge. */
const MAX_BLUR = 0.18;

export const SPEED_SHADER = {
  name: 'LocoSpeedFX',
  defines: { LOCO_SPEED_SAMPLES: '9' } as Record<string, string>,
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0..1 combined speed drive (`ChaseCamera.speedBlurAmount` + `fovKick`) */
    uAmount: { value: 0 },
    /** 0..1 smoothed boost engagement */
    uBoost: { value: 0 },
    /** 0..1 transient at the instant boost engages */
    uPunch: { value: 0 },
    /** 0..1 accessibility scale for everything that pulses */
    uSafety: { value: 1 },
    uTime: { value: 0 },
    uAspect: { value: 16 / 9 },
    /** tint the boost rim picks up — the taxi's own turbo colour */
    uBoostTint: { value: new THREE.Color(0xffb347) },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uAmount;
  uniform float uBoost;
  uniform float uPunch;
  uniform float uSafety;
  uniform float uTime;
  uniform float uAspect;
  uniform vec3 uBoostTint;
  varying vec2 vUv;

  ${GLSL_COLOR}
  ${GLSL_NOISE}
  ${GLSL_RADIAL}

  void main() {
    vec2 d = vUv - 0.5;
    float r = locoRadius( vUv, uAspect );
    float edge = locoEdge( r );

    if ( edge < 0.0006 || ( uAmount < 0.004 && uBoost < 0.004 ) ) {
      gl_FragColor = texture2D( tDiffuse, vUv );
      return;
    }

    /* --- boost lens punch: the frame stretches outward for a quarter second,
     * strictly outside the protected centre --- */
    vec2 uv = vUv;
    float punch = uPunch * uSafety;
    if ( punch > 0.002 ) {
      uv = 0.5 + d * ( 1.0 + edge * punch * 0.055 );
    }

    /* --- radial streak blur ---
     * NOTE: this vector is deliberately NOT named \`step\`. A variable with a
     * builtin's name hides that builtin for the rest of the scope, and the
     * speed-lines block below calls \`step()\`. SwiftShader (headless capture)
     * accepts the shadowing; desktop and mobile drivers reject the whole
     * program with "'step' : function name expected", which black-screens the
     * game because this pass sits mid-pipeline. Never name a local after a
     * GLSL builtin. */
    float k = edge * clamp( uAmount + uBoost * 0.35, 0.0, 1.0 ) * ${MAX_BLUR.toFixed(3)};
    vec2 streakStep = ( uv - vec2( 0.5 ) ) * k;

    vec3 acc = vec3( 0.0 );
    float wsum = 0.0;
    for ( int i = 0; i < LOCO_SPEED_SAMPLES; i ++ ) {
      float f = float( i ) / float( LOCO_SPEED_SAMPLES - 1 );
      float w = 1.0 - f * 0.45;
      acc += texture2D( tDiffuse, uv - streakStep * f ).rgb * w;
      wsum += w;
    }
    vec3 col = acc / wsum;

    /* --- chromatic streaking: red runs long, blue runs short, so the tail of
     * every streak splits. Two extra fetches, not two extra loops. --- */
    float chroma = edge * clamp( uAmount * 0.55 + uBoost * 0.85, 0.0, 1.0 );
    if ( chroma > 0.004 ) {
      float rt = texture2D( tDiffuse, uv - streakStep * 1.35 ).r;
      float bt = texture2D( tDiffuse, uv - streakStep * 0.55 ).b;
      col.r = mix( col.r, rt, chroma * 0.55 );
      col.b = mix( col.b, bt, chroma * 0.55 );
    }

    /* --- speed lines --- */
    float lines = uBoost * uSafety;
    if ( lines > 0.01 ) {
      float ang = atan( d.y, d.x * uAspect );
      /* 96 angular cells, each with its own random length and phase; they
       * slide outward continuously, so this reads as motion, never as flicker */
      float cell = floor( ( ang + 3.14159265 ) * 15.2789 );
      float seed = locoHash12( vec2( cell, 3.7 ) );
      float speed = 0.55 + seed * 1.35;
      float phase = fract( seed * 7.31 + uTime * speed );
      float band = smoothstep( 0.0, 0.22, phase ) * ( 1.0 - smoothstep( 0.30, 1.0, phase ) );
      float radial = smoothstep( 0.44, 1.02, r + phase * 0.42 );
      float thin = step( 0.55, seed );
      float streak = band * radial * thin * edge;
      col += uBoostTint * streak * lines * 0.30;
    }

    /* --- boost rim: warm light pushes in from the corners --- */
    if ( uBoost > 0.01 ) {
      float rim = smoothstep( 0.58, 1.05, r ) * uBoost * uSafety;
      col = mix( col, col * uBoostTint * 1.35, rim * 0.30 );
    }

    gl_FragColor = vec4( col, 1.0 );
  }
  `,
};

/**
 * Eases the raw camera drive into something a shader can use.
 *
 * The chase camera's `speedBlurAmount` already eases on the FOV clock, but it
 * is a *gameplay* signal: it moves the instant the throttle does. Blur that
 * snaps on reads as a glitch, so it is damped again here, asymmetrically —
 * quick to build, slow to release, which is how optical flow actually feels.
 */
export class SpeedDrive {
  private value = 0;

  get amount(): number {
    return this.value;
  }

  update(target: number, dt: number): number {
    const t = clamp01(target);
    const step = Math.min(Math.max(dt, 0), 0.1);
    const rate = t > this.value ? 11 : 5.5;
    const k = 1 - Math.exp(-rate * step);
    this.value += (t - this.value) * k;
    if (this.value < 0.0008) this.value = 0;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}
