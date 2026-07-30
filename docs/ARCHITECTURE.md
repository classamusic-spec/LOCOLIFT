# Loco Lift — architecture & module contracts

Arcade taxi game. Stylized **Old San Juan, Puerto Rico**. Player drives a vibrant
customized **open-top, open-back off-road Jeep** taxi, picking up passengers and
racing them across the old city before the clock runs out.

Stack: **Three.js 0.185 + TypeScript 5.9 + Vite 7 + Rapier3D (compat/WASM)**.

## Hard rules for every module

1. **Own only your files.** Never edit a file another module owns. If you need a
   change in someone else's file, code around it or note it in your report.
2. **No external asset downloads.** No CDN fetches, no binary model/texture
   files. Every texture is generated procedurally (canvas / data textures /
   shaders); every mesh is built from Three.js geometry in code. The build must
   run fully offline.
3. **Import only** from `three`, `three/addons/*`, `@dimforge/rapier3d-compat`,
   `src/core/*`, `src/physics/PhysicsTypes.ts`, and your own files.
4. **Talk through contracts.** Cross-system communication goes over `EventBus`
   (`src/core/types.ts` → `EventMap`) or the published interfaces
   (`WorldAPI`, `RoadGraph`, `PhysicsWorldAPI`). No reaching into internals.
5. **`strict` TypeScript, zero errors.** `npm run typecheck` must pass. No `any`
   unless genuinely unavoidable, no `@ts-ignore`.
6. **Performance is a feature.** Instance everything repeated. Share materials
   and geometries. Pool particles. Zero per-frame allocation in `update`/
   `fixedUpdate` hot paths — use `scratch` vectors from `core/MathUtils.ts`.
   Respect `QUALITY_BUDGET[tier]` from `core/Config.ts`.
7. **Dispose properly.** Every system's `dispose()` frees geometries, materials,
   textures and render targets it created.

## Frame order

```
input.poll()
  → for each fixed step: physics.step() → system.fixedUpdate()
  → system.update()          (AI, gameplay, animation)
  → system.lateUpdate()      (camera, HUD — reads final transforms)
  → renderer / composer render
```

`fixedUpdate` runs at `CONFIG.fixedHz` (120Hz) with up to `maxSubSteps` catch-up
steps. Anything integrating forces belongs there; anything framerate-tolerant
belongs in `update`.

## Module ownership & required exports

Every system implements `System` from `src/core/types.ts`.

| Owner | Files | Must export |
|---|---|---|
| **physics** | `src/physics/PhysicsWorld.ts`, `src/physics/Debug.ts` | `class PhysicsWorld implements PhysicsWorldAPI` + `static create(gravity: number): Promise<PhysicsWorld>` |
| **world** | `src/world/**` | `class World implements System, WorldAPI` + `static create(opts: WorldOpts): Promise<World>` |
| **vehicle** | `src/vehicle/**` | `class Vehicle implements System` with the public surface below |
| **camera** | `src/camera/**` | `class ChaseCamera implements System` |
| **traffic** | `src/traffic/**` | `class TrafficSystem implements System`, `class PedestrianSystem implements System` |
| **passengers** | `src/passengers/**` | `class MissionSystem implements System` |
| **ui** | `src/ui/**` | `class UISystem implements System` |
| **audio** | `src/audio/**` | `class AudioSystem implements System` |
| **fx** | `src/fx/**` | `class EffectsSystem implements System`, `class RenderPipeline` |
| **scoring** | `src/scoring/**` | `class ScoreSystem implements System` |
| **save/settings** | `src/save/**`, `src/settings/**` | `class SaveSystem`, `class SettingsStore` |
| **director** | `src/states/**` | `class GameDirector implements System` |
| **core (owned by the integrator)** | `src/core/**`, `src/main.ts`, `index.html`, `tools/**` | — do not edit |

### Vehicle public surface (camera, missions, fx, audio, UI all read this)

```ts
class Vehicle implements System {
  readonly object3d: THREE.Object3D;      // root transform of the Jeep
  readonly body: BodyHandle;
  get position(): THREE.Vector3;          // read-only, do not mutate
  get quaternion(): THREE.Quaternion;
  get velocity(): THREE.Vector3;
  get speed(): number;                    // m/s, always >= 0
  get forwardSpeed(): number;             // m/s along local -Z, signed
  get isDrifting(): boolean;
  get driftAngle(): number;               // radians of slip
  get isAirborne(): boolean;
  get airtime(): number;                  // seconds since leaving the ground
  get wheelsOnGround(): number;           // 0..4
  get boostFraction(): number;            // 0..1 meter fill
  get isBoosting(): boolean;
  get engineRpmNorm(): number;            // 0..1, for engine audio
  get gear(): number;
  get steerAngle(): number;               // radians, visual front-wheel angle
  get suspensionCompression(): Float32Array; // 4 wheels, 0..1
  get wheelWorldPositions(): THREE.Vector3[];  // 4, for smoke/skids
  get wheelSlip(): Float32Array;          // 4, 0..1 lateral+longitudinal slip
  get chassisTilt(): { pitch: number; roll: number };
  addBoost(amount: number): void;         // 0..1, from combos/near misses
  respawn(pos: THREE.Vector3, heading: number): void;
  setSeatVisual(occupied: boolean, archetypeId?: string): void;
}
```

### World options

```ts
interface WorldOpts {
  scene: THREE.Scene;
  physics: PhysicsWorldAPI;
  rng: RNG;
  quality: QualityTier;
}
```

`World` must also implement `WorldAPI` (`roads`, `sidewalks`, `pois`,
`groundHeight`, `bounds`, `isBlocked`, `poiById`) and expose:

```ts
setTimeOfDay(hours: number): void;       // 0..24, drives sun/sky/lights
setWeather(kind: 'clear'|'rain'|'storm'|'sunset'|'night'): void;
get sun(): THREE.DirectionalLight;
get spawnPoint(): { pos: THREE.Vector3; heading: number };
```

## The test hook

`src/main.ts` publishes `window.__loco` for the headless QA harness
(`tools/smoke.mjs`). Systems don't touch it; the integrator wires it.

```ts
interface LocoTestHook {
  ready: boolean;
  showTitle(): void;
  startArcade(): void;
  pause(): void;
  setInput(partial: Partial<InputState>): void;   // overrides real input
  clearInput(): void;
  setTimeOfDay(h: number): void;
  setWeather(k: string): void;
  teleport(x: number, y: number, z: number, heading?: number): void;
  perfSample(ms: number): Promise<{ fps: number; p1: number; frameMs: number;
    drawCalls: number; triangles: number; programs: number }>;
  stats(): Record<string, number>;
}
```

## Art direction (binding on every visual module)

- **Old San Juan, not generic tropical.** Blue-grey *adoquín* cobblestone,
  narrow streets on a grid that tilts toward the sea, 2–3 storey colonial
  façades wall-to-wall with no gaps, wrought-iron balconies with plants,
  louvered wooden shutters, heavy panelled doors, fanlight transoms, tiled
  roofs and flat azoteas, deep shadowed arcades, cast-iron street lamps,
  massive sandstone fort walls and garitas (sentry boxes) on the seaward edge.
- **Colour**: saturated pastel façades from `PALETTE.facade`, adjacent buildings
  never the same hue. Warm bounce light in the streets, cool sky fill.
- **Camera-facing readability**: the driving line must always read clearly.
  Never let detail noise obscure where the street goes.
- **Respectful and authentic.** Real architectural and cultural detail. No
  stereotype shorthand, no caricature, no invented "generic Latin" signage.
  Spanish text should be correct and idiomatic.

## Performance targets

60 fps at 1600×900 on `high` with traffic, pedestrians, weather and particles
live. Budget: < 900 draw calls, < 1.6M triangles, no frame over 33 ms in steady
state after warm-up.
