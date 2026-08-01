/**
 * Loco Lift — spatial bucketing and distance LOD for the scattered layers.
 *
 * ## Why this exists
 *
 * `Buildings` already solves this problem for the façades: the district is
 * merged **per block**, so every shell mesh has a small bounding sphere, three
 * frustum-culls it for free, and `Buildings.update` drops the rest by distance.
 * The scattered layers — street dressing, planting, coastal props, the lamp
 * field — never got the same treatment. Each one builds *one* `InstancedMesh`
 * per prop type spanning the whole 900 × 700 m district, so:
 *
 *  - its bounding sphere covers the map and per-object frustum culling can
 *    never reject it, and
 *  - the sun's shadow camera re-submits every one of those triangles a second
 *    time, every frame, from anywhere on the map.
 *
 * Measured on `high` before this module existed: 190 k triangles of street
 * dressing, 177 k of planting and 51 k of lamp posts were drawn at **every**
 * viewpoint in the game, plus most of that again into the shadow map — while
 * the dressing's own vertex-shader cull had already collapsed all of it to
 * nothing past `propDetailDistance`. Those triangles were being transformed to
 * produce literally no pixels.
 *
 * ## The fix
 *
 * Same shape as `InstanceRegistry`'s regions, one level finer and reusable:
 * split a placement list into square cells at build time, emit one mesh per
 * (prop, cell), and give each mesh a tight XZ footprint. Then `LodField` does
 * per-frame what `Buildings.update` does — sphere-edge distance test, set
 * `visible`, and separately set `castShadow`, because a prop can be well worth
 * drawing at 200 m and worthless as a shadow caster at 150 m.
 *
 * ## Distances are measured in XZ, on purpose
 *
 * `PropKit`'s vertex cull collapses a prop past `distance( uDressCam.xz,
 * dWorld.xz )`. A 3-D distance test is *larger* than that whenever the camera
 * is above the street — from a rooftop or the fort a 3-D test would hide props
 * the shader is still drawing, and they would pop back the moment the Jeep came
 * down. Matching the shader's XZ metric makes the cull provably invisible.
 */
import type * as THREE from 'three';
import type { QualityTier } from '../core/types';

/* ----------------------------------------------------------- shadow reach */

/**
 * Metres past which a **small** prop stops being worth submitting to the sun's
 * shadow map.
 *
 * `Lighting` fits a single ortho cascade of half-width `SHADOW_EXTENT` (62 /
 * 82 / 112 / 145 m by tier) centred 40 % of that extent ahead of the camera.
 * A pot, a plastic chair, a festoon bulb or a balcony rail is under a metre;
 * from beyond about 1.6 × the extent its shadow cannot reach the box, and what
 * it would draw there is a texel or two landing on the far side of intervening
 * façades. Turning `castShadow` off out there costs nothing visible and saves
 * the triangles **and** the draw call, which matters twice over because
 * `renderer.info.render.calls` counts the shadow submission separately.
 */
export const SHADOW_CASTER_CUT: Record<QualityTier, number> = {
  low: 100,
  medium: 130,
  high: 180,
  ultra: 235,
};

/** The same, for things with a real vertical: palms, shade trees, boats. */
export const TALL_SHADOW_CUT: Record<QualityTier, number> = {
  low: 170,
  medium: 210,
  high: 285,
  ultra: 360,
};

/* ------------------------------------------------------------- bucketing */

/** One cell's worth of placements plus the XZ box they actually occupy. */
export interface CellBucket<T> {
  items: T[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Group placements into square cells of `cell` metres.
 *
 * Order is preserved *within* a cell, which matters: `Destructibles`
 * registers an instanced prop by `(mesh, index)`, so each bucket has to be
 * registered with its own sub-list in the same order it was instanced.
 *
 * Cells are sized against `propDetailDistance`, not against the district: the
 * point is that the live set is a disc a couple of cells across, so a cell much
 * smaller than the cull radius only buys draw calls.
 */
export function bucketByCell<T>(
  items: readonly T[],
  cell: number,
  at: (t: T) => { x: number; z: number },
): Array<CellBucket<T>> {
  const map = new Map<number, CellBucket<T>>();
  const inv = 1 / Math.max(1, cell);
  for (const item of items) {
    const p = at(item);
    // 4096 columns is far more than any district will ever need, and keeping
    // the key integral avoids a string key per placement during the build.
    const i = Math.floor(p.x * inv);
    const j = Math.floor(p.z * inv);
    const key = (i + 2048) * 4096 + (j + 2048);
    let b = map.get(key);
    if (!b) {
      b = { items: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      map.set(key, b);
    }
    b.items.push(item);
    if (p.x < b.minX) b.minX = p.x;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.z < b.minZ) b.minZ = p.z;
    if (p.z > b.maxZ) b.maxZ = p.z;
  }
  return [...map.values()];
}

/**
 * The whole list as a single bucket, for prop types too cheap to be worth
 * splitting. Still gives the caller a real footprint, so the one mesh it makes
 * is culled by the same rule as everything else.
 */
export function wholeBucket<T extends { x: number; z: number }>(
  items: readonly T[],
): CellBucket<T> {
  const b: CellBucket<T> = {
    items: [...items],
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const p of items) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.z < b.minZ) b.minZ = p.z;
    if (p.z > b.maxZ) b.maxZ = p.z;
  }
  return b;
}

/** Centre and XZ radius of a bucket, padded by the prop's own reach. */
export function bucketFootprint<T>(
  b: CellBucket<T>,
  pad: number,
): { cx: number; cz: number; radius: number } {
  const cx = (b.minX + b.maxX) * 0.5;
  const cz = (b.minZ + b.maxZ) * 0.5;
  const hx = (b.maxX - b.minX) * 0.5;
  const hz = (b.maxZ - b.minZ) * 0.5;
  return { cx, cz, radius: Math.hypot(hx, hz) + pad };
}

/* --------------------------------------------------------------- runtime */

interface LodEntry {
  object: THREE.Object3D;
  cx: number;
  cz: number;
  radius: number;
  /** multiplier on the draw cut — landmarks and silhouettes stay longer */
  mul: number;
  /** whether the object casts at all when it is close enough to matter */
  casts: boolean;
  /** forced off by a quality tier rather than by distance */
  enabled: boolean;
}

/**
 * A set of spatially bounded objects culled together by XZ distance.
 *
 * Deliberately not a `THREE.LOD`: these are `InstancedMesh`es that already
 * exist and are already positioned in world space, so all that is wanted is a
 * `visible` flag driven by the same metric the shaders use.
 */
export class LodField {
  private entries: LodEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  /**
   * @param radius XZ radius of the object's footprint, from
   *   {@link bucketFootprint}.
   * @param mul multiplier on the cut distance passed to {@link update}.
   */
  add(object: THREE.Object3D, cx: number, cz: number, radius: number, mul = 1): void {
    this.entries.push({ object, cx, cz, radius, mul, casts: object.castShadow, enabled: true });
  }

  /** Turn a subset off for the whole session, e.g. on a weak quality tier. */
  setEnabled(predicate: (o: THREE.Object3D) => boolean, on: boolean): void {
    for (const e of this.entries) {
      if (predicate(e.object)) {
        e.enabled = on;
        if (!on) e.object.visible = false;
      }
    }
  }

  /**
   * @param cut metres at which an object stops contributing pixels. For the
   *   dressing layers this is exactly `propDetailDistance`, because that is
   *   where `PropKit`'s vertex cull has already collapsed the prop to a point.
   * @param shadowCut metres past which the object stops casting. 0 leaves
   *   `castShadow` alone. The sun's box is `SHADOW_EXTENT` wide and led 40 % of
   *   its extent ahead of the camera, so nothing beyond about 2.2 × that
   *   extent can land a texel inside it.
   */
  update(cameraPos: THREE.Vector3, cut: number, shadowCut = 0): void {
    const cx = cameraPos.x;
    const cz = cameraPos.z;
    for (const e of this.entries) {
      if (!e.enabled) continue;
      const dx = e.cx - cx;
      const dz = e.cz - cz;
      const d = Math.sqrt(dx * dx + dz * dz) - e.radius;
      e.object.visible = d < cut * e.mul;
      if (shadowCut > 0) e.object.castShadow = e.casts && d < shadowCut;
    }
  }

  clear(): void {
    this.entries.length = 0;
  }
}
