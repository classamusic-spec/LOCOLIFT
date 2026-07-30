import * as THREE from 'three';

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : clamp01((v - a) / (b - a));

export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  lerp(b0, b1, invLerp(a0, a1, v));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * Framerate-independent exponential smoothing.
 * `rate` is roughly "how much of the gap is closed per second" (higher = snappier).
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

export const dampVec3 = (
  current: THREE.Vector3,
  target: THREE.Vector3,
  rate: number,
  dt: number,
): THREE.Vector3 => current.lerp(target, 1 - Math.exp(-rate * dt));

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/** Wrap an angle into (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
};

/** Shortest signed angular difference from a to b. */
export const angleDelta = (a: number, b: number): number => wrapAngle(b - a);

/** Deadzone with smooth re-normalisation, for sticks. */
export const deadzone = (v: number, dz = 0.12): number => {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
};

/** Signed exponential response curve — keeps fine control near centre. */
export const expoCurve = (v: number, expo = 0.35): number => {
  const a = Math.abs(v);
  return Math.sign(v) * (a * (1 - expo) + a * a * a * expo);
};

export const MPS_TO_MPH = 2.2369363;
export const MPS_TO_KMH = 3.6;

/** Reusable scratch vectors — grab, use, never retain across a yield. */
export const scratch = {
  v1: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  v3: new THREE.Vector3(),
  v4: new THREE.Vector3(),
  q1: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  m1: new THREE.Matrix4(),
};
