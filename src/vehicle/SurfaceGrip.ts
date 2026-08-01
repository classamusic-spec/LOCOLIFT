/**
 * Loco Lift — what the tyres are actually on.
 *
 * The world knows perfectly well which square metre of San Viejo is sand and
 * which is *adoquín*: `Coast` rasterises a surface field over the whole
 * district, and Piñones tags every one of its collision meshes with a typed
 * grip class. Until now nothing read either, so the beach drove exactly like
 * the plaza.
 *
 * This module is the bridge. It answers, per wheel per step:
 *
 *  1. **Ask the collider.** Piñones (and anything else that wants to) puts a
 *     `grip` field on its body's `userData`. That is authoritative, free, and
 *     already correct for a boardwalk plank sitting on top of dune sand.
 *  2. **Ask the field.** Everything else in the district shares one ground
 *     trimesh, so there is nothing per-collider to read. `Coast` registers its
 *     O(1) raster during world build and the wheel queries it by position.
 *  3. **Fall back to cobble**, the surface the whole vehicle is tuned on.
 *
 * The registry lives in `world/Surfaces`, a leaf module both sides import, so
 * the vehicle never has to depend on `world/Coast` and no cycle exists.
 */
import {
  SURFACE_GRIP,
  SURFACE_PLUME,
  surfaceProbe,
  type SurfaceGrip,
  type SurfaceKind,
} from '../world/Surfaces';

export type { SurfaceGrip, SurfaceKind };
export { SURFACE_GRIP, SURFACE_PLUME };

/** The reference surface. Every tuning number in the game is authored on it. */
export const DEFAULT_SURFACE: SurfaceKind = 'cobble';

const KINDS: Record<string, SurfaceKind> = {
  cobble: 'cobble',
  sand: 'sand',
  asphalt: 'asphalt',
  grass: 'grass',
  // authoring classes that map onto one of the four tyre surfaces
  gravel: 'sand',
  dirt: 'sand',
  ramp: 'asphalt',
  boardwalk: 'asphalt',
};

/** Read a surface out of whatever a collider tagged itself with, if anything. */
export function surfaceFromUserData(ud: unknown): SurfaceKind | null {
  if (ud === null || typeof ud !== 'object') return null;
  const rec = ud as Record<string, unknown>;
  const grip = rec.grip;
  if (typeof grip === 'string' && grip in SURFACE_GRIP) return grip as SurfaceKind;
  const surface = rec.surface;
  if (typeof surface === 'string') {
    const mapped = KINDS[surface];
    if (mapped) return mapped;
  }
  return null;
}

/**
 * The surface under one wheel. `ud` is whatever the suspension ray hit;
 * `x`/`z` are the contact point.
 */
export function surfaceAt(ud: unknown, x: number, z: number): SurfaceKind {
  const tagged = surfaceFromUserData(ud);
  if (tagged) return tagged;
  const probe = surfaceProbe();
  if (probe) return probe(x, z);
  return DEFAULT_SURFACE;
}

/**
 * Blend a surface's multipliers toward neutral by `sensitivity`. 0 leaves the
 * vehicle completely indifferent to what it is driving on, 1 takes the table
 * at face value, and above 1 exaggerates it.
 */
export function scaleGrip(
  grip: SurfaceGrip,
  sensitivity: number,
  out: SurfaceGrip,
): SurfaceGrip {
  out.lateral = 1 + (grip.lateral - 1) * sensitivity;
  out.longitudinal = 1 + (grip.longitudinal - 1) * sensitivity;
  out.drag = grip.drag * sensitivity;
  out.spray = grip.spray;
  return out;
}
