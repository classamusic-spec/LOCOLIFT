import type * as THREE from 'three';
import type { QualityTier, POI, RoadGraph } from '../core/types';
import type { PhysicsWorldAPI } from '../physics/PhysicsTypes';
import type { RNG } from '../core/RNG';

/** Options for `World.create`. */
export interface WorldOpts {
  scene: THREE.Scene;
  physics: PhysicsWorldAPI;
  rng: RNG;
  quality: QualityTier;
}

export type DistrictZone =
  | 'oldTown' // dense colonial core, narrow streets
  | 'plazaMayor' // the big open square
  | 'waterfront' // cruise docks, wide coastal road
  | 'marketRow' // covered market + stalls
  | 'fortress' // fort walls, glacis, garitas
  | 'hillside' // steep stepped streets
  | 'artQuarter'; // murals, galleries, cafés

/**
 * One buildable parcel fronting a street. Produced by the city layout,
 * consumed by the building generator.
 */
export interface Lot {
  id: number;
  zone: DistrictZone;
  /** footprint polygon in world XZ, counter-clockwise, metres */
  polygon: THREE.Vector2[];
  /** centroid, y = ground height */
  center: THREE.Vector3;
  /** outward normal of the primary street-facing edge */
  facing: THREE.Vector2;
  /** index into `polygon` of the first vertex of the street-facing edge */
  frontEdge: number;
  /** metres of street frontage */
  frontage: number;
  /** metres front-to-back */
  depth: number;
  /** target storeys, 1..4 */
  storeys: number;
  /** ground height at the front door */
  groundY: number;
  /** shared party walls: lots that abut this one (no gap between façades) */
  neighbours: number[];
  /** true when this lot backs onto the sea or a plaza and needs a finished rear */
  exposedRear: boolean;
  /** stable per-lot random seed */
  seed: number;
}

/** A block is a ring of lots around a shared interior courtyard. */
export interface Block {
  id: number;
  zone: DistrictZone;
  lots: number[];
  /** interior courtyard polygon, may be empty */
  courtyard: THREE.Vector2[];
  center: THREE.Vector3;
}

/** Open drivable/walkable areas: plazas, market floors, the fort glacis. */
export interface OpenArea {
  id: number;
  zone: DistrictZone;
  polygon: THREE.Vector2[];
  center: THREE.Vector3;
  /** surface treatment for the ground shader */
  surface: 'cobble' | 'flagstone' | 'sand' | 'grass' | 'tile' | 'asphalt';
  drivable: boolean;
}

/** The layout result — everything downstream generators build from. */
export interface CityLayout {
  lots: Lot[];
  blocks: Block[];
  areas: OpenArea[];
  roads: RoadGraph;
  sidewalks: RoadGraph;
  pois: POI[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** where the Jeep starts a shift */
  spawn: { pos: THREE.Vector3; heading: number };
  /** height of the street/terrain surface at a world xz */
  groundHeight(x: number, z: number): number;
  /** zone at a world xz, for ambience and music */
  zoneAt(x: number, z: number): DistrictZone;
}

/** Shared shape for anything that adds meshes to the world. */
export interface WorldLayer {
  readonly name: string;
  readonly group: THREE.Group;
  build(layout: CityLayout, opts: WorldOpts): void | Promise<void>;
  /** called each frame with the camera position for LOD / streaming */
  update?(cameraPos: THREE.Vector3, dt: number, timeOfDay: number): void;
  onQualityChange?(tier: QualityTier): void;
  dispose(): void;
}
