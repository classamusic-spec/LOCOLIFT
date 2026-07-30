/**
 * Loco Lift — shared type contracts.
 *
 * Every subsystem codes against this file. Nothing here imports a subsystem,
 * so it stays dependency-free and safe for all modules to pull from.
 */
import type * as THREE from 'three';
import type { EventBus } from './EventBus';
import type { RNG } from './RNG';

/* ------------------------------------------------------------------ input */

/** Normalised, device-agnostic control state. Produced by the input layer. */
export interface InputState {
  /** 0..1 accelerator */
  throttle: number;
  /** 0..1 brake / reverse */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0..1 handbrake — the drift initiator */
  handbrake: number;
  /** boost held */
  boost: boolean;
  horn: boolean;
  lookBack: boolean;
  /** midair pitch, -1 (nose down) .. 1 (nose up) */
  airPitch: number;
  /** midair roll/yaw, -1 .. 1 */
  airRoll: number;
  /** edge-triggered: true only on the frame the key went down */
  pausePressed: boolean;
  cameraPressed: boolean;
  resetPressed: boolean;
  /** true when the last input came from a gamepad (drives prompt glyphs) */
  usingGamepad: boolean;
}

/* --------------------------------------------------------------- settings */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface SettingsState {
  quality: QualityTier;
  /** render scale multiplier, 0.5..1 */
  renderScale: number;
  shadows: boolean;
  postProcessing: boolean;
  bloom: boolean;
  motionBlur: boolean;
  ssao: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /* accessibility */
  screenShake: number; // 0..1 scale
  cameraSway: number; // 0..1 scale
  photosensitiveSafe: boolean; // damps strobing / heavy flashes
  colorBlindMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  subtitles: boolean;
  largeText: boolean;
  highContrastHud: boolean;
  holdToBoost: boolean; // false = toggle
  assistSteering: number; // 0..1 auto-counter-steer help
  autoAccelerate: boolean;
  invertLook: boolean;
  uiScale: number; // 0.75..1.5
  minimapRotates: boolean;
  showSpeedUnits: 'mph' | 'kmh';
}

/* ---------------------------------------------------------------- context */

/** Handed to every system on every tick. Systems must not mutate it. */
export interface GameContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  bus: EventBus;
  input: InputState;
  settings: SettingsState;
  rng: RNG;
  /** seconds since the engine booted (unpaused) */
  elapsed: number;
  /** clamped frame delta in seconds */
  dt: number;
  /** unclamped wall-clock delta, for UI animation while paused */
  rawDt: number;
  /** fixed physics step in seconds */
  fixedDt: number;
  /** current simulation pause state */
  paused: boolean;
  /** 0..24 in-game hours */
  timeOfDay: number;
}

/**
 * All gameplay systems implement this. The engine calls the hooks in order:
 * `fixedUpdate` (0..n times per frame) -> `update` -> `lateUpdate`.
 */
export interface System {
  readonly name: string;
  init?(ctx: GameContext): void | Promise<void>;
  /** deterministic step — physics, vehicle, anything integrating forces */
  fixedUpdate?(ctx: GameContext, dt: number): void;
  /** per-frame — AI, animation, gameplay logic */
  update?(ctx: GameContext, dt: number): void;
  /** after everything — camera, HUD, anything that reads final transforms */
  lateUpdate?(ctx: GameContext, dt: number): void;
  /** quality tier changed at runtime */
  onQualityChange?(tier: QualityTier, settings: SettingsState): void;
  dispose?(): void;
}

/* ------------------------------------------------------------- road graph */

export type RoadKind =
  | 'street' // normal cobblestone street
  | 'alley' // narrow, no traffic
  | 'coastal' // wide seaside road
  | 'plaza' // open drivable square
  | 'stairs' // steep, drivable but rough — shortcut
  | 'ramp' // jump geometry
  | 'rooftop'; // rooftop shortcut path

export interface RoadNode {
  id: number;
  pos: THREE.Vector3;
  /** ids of connected edges */
  edges: number[];
  kind: 'intersection' | 'plaza' | 'deadend' | 'ramp';
  /** traffic signal phase offset, seconds; -1 = uncontrolled */
  signalOffset: number;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** drivable width in metres */
  width: number;
  lanes: number;
  oneWay: boolean;
  kind: RoadKind;
  length: number;
  /** intermediate spline points (excluding endpoints), world space */
  via: THREE.Vector3[];
  /** true when traffic AI must not spawn here (alleys, stairs, rooftops) */
  noTraffic: boolean;
}

export interface EdgeSample {
  edgeId: number;
  /** 0..1 along the edge from a -> b */
  t: number;
  dist: number;
  point: THREE.Vector3;
  /** unit tangent pointing a -> b */
  tangent: THREE.Vector3;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** position along an edge; laneOffset is metres right of centreline */
  sample(edgeId: number, t: number, laneOffset: number, out?: THREE.Vector3): THREE.Vector3;
  /** unit tangent at t, a -> b */
  tangent(edgeId: number, t: number, out?: THREE.Vector3): THREE.Vector3;
  /** closest point on the network to p, or null if nothing within maxDist */
  nearest(p: THREE.Vector3, maxDist?: number): EdgeSample | null;
  /** A* over nodes; returns node ids inclusive of both ends, [] if unreachable */
  path(fromNode: number, toNode: number): number[];
  /** node id nearest to a world position */
  nearestNode(p: THREE.Vector3): number;
}

/* ------------------------------------------------------------------ world */

export type POIKind =
  | 'plaza'
  | 'cafe'
  | 'dock'
  | 'rooftop'
  | 'market'
  | 'fort'
  | 'chapel'
  | 'lookout'
  | 'venue'
  | 'beach'
  | 'gallery'
  | 'bakery';

export interface POI {
  id: string;
  /** display name shown in the HUD, in-world Spanish naming is expected */
  name: string;
  kind: POIKind;
  pos: THREE.Vector3;
  /** arrival radius in metres */
  radius: number;
  /** where the Jeep should end up facing on arrival, radians; NaN = any */
  facing: number;
}

/** What the world module exposes to traffic, missions, minimap and audio. */
export interface WorldAPI {
  root: THREE.Object3D;
  roads: RoadGraph;
  /** pedestrian network — sidewalks, plaza edges, stairs */
  sidewalks: RoadGraph;
  pois: POI[];
  /** terrain/street height at a world xz, metres */
  groundHeight(x: number, z: number): number;
  /** world-space bounds of the playable district */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** true if the point is inside a building footprint (for spawn rejection) */
  isBlocked(x: number, z: number): boolean;
  poiById(id: string): POI | undefined;
}

/* -------------------------------------------------------------- passenger */

export type PassengerMood = 'calm' | 'happy' | 'thrilled' | 'nervous' | 'furious' | 'terrified';

export interface PassengerArchetype {
  id: string;
  name: string;
  /** one-line character description used by the HUD card */
  blurb: string;
  /** seconds of patience at 1x; lower = more demanding */
  patience: number;
  /** multiplies the base fare */
  fareMultiplier: number;
  /** how much they enjoy dangerous driving; 1 = loves it, -1 = hates it */
  thrillSeeking: number;
  /** tint used for their marker + card */
  color: number;
  voicePitch: number;
}

export type DialogueTrigger =
  | 'hail'
  | 'pickup'
  | 'idle'
  | 'drift'
  | 'jump'
  | 'nearMiss'
  | 'crash'
  | 'boost'
  | 'wrongWay'
  | 'almostThere'
  | 'dropoff'
  | 'perfect'
  | 'timeout'
  | 'shortcut';

export interface DialogueLine {
  trigger: DialogueTrigger;
  /** what the passenger says; may mix Spanish and English naturally */
  text: string;
  /** required mood, or undefined for any */
  mood?: PassengerMood;
  /** minimum seconds between repeats of this line */
  cooldown?: number;
}

/* ---------------------------------------------------------------- scoring */

export interface ComboEvent {
  label: string;
  points: number;
  /** world position to spawn the floating score popup */
  at?: THREE.Vector3;
}

export interface FareResult {
  base: number;
  distanceBonus: number;
  timeBonus: number;
  comboBonus: number;
  tip: number;
  total: number;
  /** 0..5 stars */
  rating: number;
  /** short flavour text, e.g. "¡Brutal!" */
  grade: string;
}

/* ----------------------------------------------------------- game / state */

export type GameStateId =
  | 'boot'
  | 'title'
  | 'modeSelect'
  | 'garage'
  | 'playing'
  | 'paused'
  | 'results'
  | 'settings';

export type GameMode = 'arcade' | 'freeRide' | 'story' | 'challenge';

/* ------------------------------------------------------------------ audio */

export type SfxId =
  | 'tireScreech'
  | 'impactHeavy'
  | 'impactLight'
  | 'propBreak'
  | 'boostStart'
  | 'boostLoop'
  | 'landing'
  | 'jumpTakeoff'
  | 'horn'
  | 'pickup'
  | 'dropoff'
  | 'cashRegister'
  | 'comboUp'
  | 'comboBreak'
  | 'countdownTick'
  | 'countdownGo'
  | 'timeExtend'
  | 'uiMove'
  | 'uiConfirm'
  | 'uiBack'
  | 'nearMiss'
  | 'crowdCheer'
  | 'seagull'
  | 'wave'
  | 'thunder'
  | 'rainLoop';

/* ----------------------------------------------------------------- events */

/** Typed event map — the bus is strongly typed off these keys. */
export interface EventMap {
  'game:state': { from: GameStateId; to: GameStateId };
  'game:mode': { mode: GameMode };
  'game:quality': { tier: QualityTier };
  'game:settingsChanged': { settings: SettingsState };

  'vehicle:driftStart': { speed: number };
  'vehicle:driftEnd': { duration: number; angleIntegral: number; points: number };
  'vehicle:jumpStart': { speed: number };
  'vehicle:jumpLand': { airtime: number; height: number; clean: boolean; points: number };
  'vehicle:collision': { impulse: number; kind: 'traffic' | 'prop' | 'wall' | 'ped' };
  'vehicle:nearMiss': { speed: number; at: THREE.Vector3 };
  'vehicle:boostStart': Record<string, never>;
  'vehicle:boostEnd': Record<string, never>;
  'vehicle:airTrick': { name: string; points: number };
  'vehicle:reset': Record<string, never>;
  'vehicle:twoWheels': { duration: number };

  'prop:destroyed': { at: THREE.Vector3; kind: string; points: number };

  'combo:add': ComboEvent;
  'combo:break': { total: number };
  'combo:multiplier': { multiplier: number };

  'score:changed': { score: number; delta: number };

  'passenger:hail': { archetypeId: string; at: THREE.Vector3 };
  'passenger:pickup': { archetypeId: string; destinationId: string; fareEstimate: number };
  'passenger:dropoff': { archetypeId: string; result: FareResult };
  'passenger:bail': { archetypeId: string; reason: 'timeout' | 'terrified' };
  'passenger:mood': { archetypeId: string; mood: PassengerMood };
  'passenger:say': { archetypeId: string; text: string; trigger: DialogueTrigger };

  'mission:start': { id: string; title: string; objective: string };
  'mission:complete': { id: string; result: FareResult };
  'mission:fail': { id: string; reason: string };

  'shift:start': { mode: GameMode; duration: number };
  'shift:end': { score: number; fares: number; rating: number };
  'shift:timeAdded': { seconds: number; reason: string };
  'shift:timeWarning': { remaining: number };

  'audio:sfx': { id: SfxId; at?: THREE.Vector3; volume?: number; pitch?: number };
  'audio:music': { intensity: number };

  'weather:changed': { kind: 'clear' | 'rain' | 'storm' | 'sunset' | 'night' };

  'ui:toast': { text: string; icon?: string; ms?: number };
  'ui:notice': { text: string; big?: boolean };
}

export type EventKey = keyof EventMap;
