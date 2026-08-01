/**
 * Loco Lift — what the tyres are on.
 *
 * The surface classification and its tyre multipliers used to live in
 * `Coast.ts`, which was fine while only the coast cared. They are now read by
 * the vehicle as well, and `Coast` in turn has to publish its raster to the
 * vehicle, so keeping both in one file would make `src/world/Coast` and
 * `src/vehicle` import each other in a cycle. This module is the leaf both
 * sides depend on; `Coast` re-exports everything here, so every existing
 * `import { SURFACE_GRIP } from './Coast'` keeps working unchanged.
 */

/** What the tyres are on. Consumed by the vehicle's grip model. */
export type SurfaceKind = 'cobble' | 'sand' | 'asphalt' | 'grass';

/** Multipliers on the tyre model, one set per surface. */
export interface SurfaceGrip {
  /** scales `TYRE.latGripFront` / `latGripRear` */
  lateral: number;
  /** scales `TYRE.longGrip` */
  longitudinal: number;
  /**
   * Extra rolling resistance, as a fraction of the vehicle's drive force lost
   * per wheel on this surface. Sand is what makes the beach a *different place
   * to drive* rather than a differently coloured road.
   */
  drag: number;
  /** how readily this surface throws a particle plume under a spinning wheel */
  spray: number;
}

/**
 * Suggested tuning. Cobble is the reference — the whole vehicle is tuned on
 * adoquín, so it sits at 1.0 and everything else is expressed relative to it.
 *
 * Sand is deliberately loose: grip drops about a third laterally, the Jeep
 * pushes wide on entry and steps out on power, and the drag term caps beach
 * top speed below road top speed. That combination is the fun — you arrive on
 * the sand fast and immediately have to drive it differently.
 */
export const SURFACE_GRIP: Record<SurfaceKind, SurfaceGrip> = {
  cobble: { lateral: 1.0, longitudinal: 1.0, drag: 0.0, spray: 0.15 },
  asphalt: { lateral: 1.06, longitudinal: 1.05, drag: 0.0, spray: 0.1 },
  sand: { lateral: 0.64, longitudinal: 0.74, drag: 0.22, spray: 1.0 },
  grass: { lateral: 0.8, longitudinal: 0.85, drag: 0.09, spray: 0.5 },
};

/** Plume colour per surface, sRGB — dust off dirt, sand off the beach. */
export const SURFACE_PLUME: Record<SurfaceKind, number> = {
  cobble: 0xb9b2a4,
  asphalt: 0xa9a6a2,
  sand: 0xe0cfa4,
  grass: 0x94a26a,
};

/** A positional surface lookup. Must be O(1) — it is called four times a step. */
export type SurfaceProbe = (x: number, z: number) => SurfaceKind;

let probe: SurfaceProbe | null = null;

/**
 * Publish a district-wide surface field. `Coast` calls this once it has
 * rasterised the shoreline; passing `null` clears it on world teardown.
 */
export function setSurfaceProbe(fn: SurfaceProbe | null): void {
  probe = fn;
}

/** The registered field, or null before the world has finished building. */
export function surfaceProbe(): SurfaceProbe | null {
  return probe;
}
