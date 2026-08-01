/**
 * Loco Lift — boot and wiring.
 *
 * Owns system construction and registration order, which is load-bearing:
 *
 *   input (pre-frame)
 *     -> World.fixedUpdate      (nothing yet, but keeps world first)
 *     -> Vehicle.fixedUpdate    reads body state, applies impulses
 *     -> PhysicsStepper         steps the solver AFTER impulses are applied
 *     -> *.update               gameplay
 *     -> ChaseCamera.lateUpdate reads final transforms
 */
import * as THREE from 'three';
import { Engine } from './core/Engine';
import { Input } from './core/Input';
import { CONFIG, QUALITY_PRESETS } from './core/Config';
import { RNG } from './core/RNG';
import type { GameContext, InputState, System } from './core/types';
import { SettingsStore } from './settings/SettingsStore';
import { SaveSystem } from './save/SaveSystem';
import { PhysicsWorld } from './physics/PhysicsWorld';
import type { PhysicsWorldAPI } from './physics/PhysicsTypes';
import { World, type WeatherKind } from './world/World';
import { Vehicle } from './vehicle/Vehicle';
import { ChaseCamera } from './camera/ChaseCamera';
import { AudioSystem } from './audio/AudioSystem';
import { TrafficSystem } from './traffic/TrafficSystem';
import { PedestrianSystem } from './traffic/PedestrianSystem';
import { isVehicleId, DEFAULT_VEHICLE_ID, getVehicleDefinition } from './vehicle/VehicleRoster';
import type { VehicleId } from './vehicle/VehicleRoster';
import { UISystem } from './ui/UISystem';
import { MissionSystem } from './passengers/MissionSystem';
import { ComboSystem } from './scoring/ComboSystem';
import { ScoreSystem } from './scoring/ScoreSystem';
import { Progression } from './scoring/Progression';
import { Relationships } from './scoring/Relationships';
import { GameDirector, type EntryMode } from './states/GameDirector';
import { QualityGovernor } from './core/QualityGovernor';
import { PartyBusMode } from './states/PartyBusMode';
import { RenderPipeline } from './fx/RenderPipeline'; // LOCOFX-TEMP-WIRING
import { installShaderGuard } from './fx/ShaderGuard';

/** How long boot may take before we tell the player something is wrong. */
const BOOT_WATCHDOG_MS = 45_000;

/**
 * Steps the solver. Registered last so every system has already applied its
 * impulses for this tick — stepping first would delay all vehicle forces by a
 * frame and make the Jeep feel mushy.
 */
class PhysicsStepper implements System {
  readonly name = 'physics';
  constructor(private physics: PhysicsWorldAPI) {}
  fixedUpdate(_ctx: GameContext, dt: number): void {
    this.physics.step(dt);
  }
  dispose(): void {
    this.physics.dispose();
  }
}

export interface LocoTestHook {
  ready: boolean;
  showTitle(): void;
  startArcade(): void;
  /** Open the untimed city — the same call `openingMove()` makes at boot. */
  startFreeRoam(): void;
  /** The chinchorreo. False when no bus mode is wired. */
  startParty(): boolean;
  pause(): void;
  resume(): void;
  /** `'boot' | 'title' | 'playing' | 'paused' | …` */
  state(): string;
  /** The active `GameMode`. */
  mode(): string;
  /**
   * Everything the free-roam loop is doing right now: whether a fare is
   * aboard, what the HUD dial reads, and what the ride's own deadline is.
   */
  roam(): {
    state: string;
    mode: string;
    live: boolean;
    /** seconds on the HUD dial, read from the HUD itself */
    hudClock: number;
    /** free roam's mirror of the same number */
    clock: number;
    /** true only while somebody is in the car */
    fareActive: boolean;
    hasPassenger: boolean;
    rideSecondsLeft: number;
    rideAllowance: number;
    accepted: number;
    banked: number;
    completed: number;
    failed: number;
    /** discovery mode: how many people the street is allowed to hold */
    waitingBudget: number;
    /** discovery mode: how much longer than authored they wait */
    waitPatience: number;
    /** what the timer chip is actually rendering */
    hudDigits: string;
    hudLabel: string;
    /** what the TARIFA chip is actually rendering */
    hudFare: string;
    /** the roam prompt banner, '' when hidden */
    hudPrompt: string;
  };
  /** Where the waiting fares are standing, nearest first. */
  waitingFares(): Array<{ x: number; z: number; d: number }>;
  /** Where the fare aboard is being taken, or null. */
  destination(): { id: string; name: string; x: number; z: number } | null;
  /** Chinchorreo state, so the party bus can be proven to actually run. */
  party(): {
    wired: boolean;
    /** true only when the chinchorreo itself is the active controller */
    isPartyRun: boolean;
    running: boolean;
    phase: string;
    stops: number;
    aboard: number;
    collected: number;
    hype: number;
    timeLeft: number;
    /** the stop the arrow is pointing at, or null */
    stop: { id: string; name: string; x: number; z: number } | null;
  };
  setInput(partial: Partial<InputState>): void;
  clearInput(): void;
  setTimeOfDay(h: number): void;
  setWeather(k: string): void;
  teleport(x: number, y: number, z: number, heading?: number): void;
  perfSample(ms: number): Promise<Record<string, number>>;
  /**
   * Per-system CPU breakdown over `ms`. Answers *which* system spent the frame,
   * which frame time alone cannot. `subStepsPerFrame` distinguishes a system
   * that is expensive from one that is merely running eight times per frame.
   */
  profile(ms: number): Promise<{
    frames: number;
    subStepsPerFrame: number;
    renderMs: number;
    fixed: Array<{ name: string; ms: number }>;
    update: Array<{ name: string; ms: number }>;
    late: Array<{ name: string; ms: number }>;
    totalMs: number;
  }>;
  stats(): Record<string, number>;
  /** Ground height under a point, so a scripted teleport lands on the street. */
  groundY(x: number, z: number): number;
  /** Named places, so QA can navigate by name instead of guessing coordinates. */
  places(): Array<{ id: string; kind: string; x: number; y: number; z: number }>;
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Which vehicle is being driven. */
  vehicleId(): string;
  /** Adaptive-quality state, or null when pinned off via `?governor=off`. */
  governor(): Record<string, number | string | boolean> | null;
  /** Per-group mesh/triangle/instance breakdown, for budget triage. */
  sceneBreakdown(): Array<{ group: string; meshes: number; instanced: number; instances: number; triangles: number }>;
}

declare global {
  interface Window {
    __loco?: LocoTestHook;
  }
}

/** Hide the page's boot splash. Safe to call more than once. */
function hideBootSplash(): void {
  const el = document.getElementById('boot');
  if (el) el.hidden = true;
}

/**
 * Report a fatal boot problem *on top of* the splash.
 *
 * The splash is `z-index: 1` and opaque, so an overlay without a higher stack
 * position is invisible underneath it — a crash and a hang both present as a
 * black screen otherwise.
 */
function showBootError(title: string, detail: string): void {
  hideBootSplash();
  const el = document.getElementById('ui-root');
  if (!el) return;
  el.innerHTML =
    `<div role="alert" style="position:fixed;inset:0;z-index:9999;display:grid;` +
    `place-items:center;font:14px/1.6 system-ui,sans-serif;color:#fff6e8;` +
    `background:#0b1d2a;padding:2rem;text-align:center">` +
    `<div style="max-width:46rem"><h1 style="margin:0 0 .75rem;font-size:1.4rem">${title}</h1>` +
    `<pre style="white-space:pre-wrap;opacity:.85;text-align:left">${detail}</pre></div></div>`;
}

/** Boot-stage timing, so a hang or a slow build is attributable at a glance. */
function stage(name: string, t0: number): number {
  const now = performance.now();
  console.info(`[boot] ${name}: ${Math.round(now - t0)}ms`);
  return now;
}

async function boot(): Promise<void> {
  let t = performance.now();
  // If boot neither finishes nor throws, say so instead of showing black.
  const watchdog = setTimeout(() => {
    if (!window.__loco?.ready) {
      showBootError(
        'Loco Lift is taking longer than expected',
        'The world is still building. If this persists, your browser may not ' +
          'support the WebGL2 features the game needs.\n\nOpen the console for ' +
          'the [boot] stage timings to see which stage is stalling.',
      );
    }
  }, BOOT_WATCHDOG_MS);
  const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #gl canvas');

  const settingsStore = new SettingsStore();
  const save = new SaveSystem();
  const engine = new Engine(canvas, settingsStore.current);

  // Before a single material compiles. A GLSL program that fails to link is
  // otherwise invisible here and fatal on the player's machine — see
  // `fx/ShaderGuard.ts` for the incident that put this in.
  installShaderGuard(engine.renderer);

  // First run on an unknown device: guess a tier rather than opening on high.
  if (!localStorage.getItem('locolift.settings.v1')) {
    settingsStore.setQuality(settingsStore.autoDetectQuality(engine.renderer));
  }
  // `Engine.applySettings` already calls `onQualityChange` on every registered
  // System directly, but the *event* had no publisher at all — so the HUD's
  // "Calidad: MEDIUM" toast could never fire. Emit it on a real tier change
  // only; the audio system's listener re-applies the same idempotent trims.
  let lastTier = settingsStore.current.quality;
  // Declared before the subscriber that closes over it: a `const` down-file
  // would sit in the temporal dead zone for any settings write that happened
  // in between, and that is a ReferenceError at boot rather than a type error.
  let governor: QualityGovernor | null = null;
  settingsStore.subscribe((s) => {
    engine.applySettings(s);
    if (s.quality !== lastTier) {
      lastTier = s.quality;
      engine.bus.emit('game:quality', { tier: s.quality });
    }
    // A change the governor did not make is the player's, and becomes its
    // ceiling. `notifyManualChange` recognises and ignores its own moves.
    governor?.notifyManualChange(s);
  });

  /**
   * Adaptive quality. `autoDetectQuality` guesses once from core count and
   * device memory and, until now, nothing ever revisited that guess — an
   * integrated GPU behind a fast CPU was handed `high` and kept it at 5 fps.
   * `?governor=off` pins it for benchmarks, which must not move under
   * measurement.
   */
  governor =
    new URLSearchParams(location.search).get('governor') === 'off'
      ? null
      : new QualityGovernor({
          getSettings: () => settingsStore.current,
          apply: (tier, renderScale) => {
            // One `patch`, not `setQuality` followed by `set`. Each write
            // notifies, and every notification runs `engine.applySettings` —
            // which recompiles shaders and reallocates render targets. Paying
            // that twice to apply one rung would itself cause the stutter the
            // governor is trying to remove.
            settingsStore.patch({ ...QUALITY_PRESETS[tier], quality: tier, renderScale });
          },
          onChange: (rung, reason) => {
            console.info(`[quality] auto-${reason} → ${rung.tier} @ ${rung.scale.toFixed(2)}x`);
          },
        });

  const input = new Input();
  engine.setInput(input.state);

  t = stage('engine', t);
  const physics = await PhysicsWorld.create(CONFIG.gravity);
  t = stage('physics', t);

  const world = await World.create({
    scene: engine.scene,
    physics,
    rng: new RNG(CONFIG.worldSeed),
    quality: settingsStore.current.quality,
  });
  await world.whenReady();
  t = stage('world', t);

  const spawn = world.spawnPoint;
  // Saved choice wins; ?vehicle=bus overrides it for testing and captures.
  const urlVehicle = new URLSearchParams(location.search).get('vehicle');
  const savedVehicle = (save.current as { vehicleId?: string }).vehicleId;
  const vehicleId: VehicleId = isVehicleId(urlVehicle)
    ? urlVehicle
    : isVehicleId(savedVehicle)
      ? savedVehicle
      : DEFAULT_VEHICLE_ID;

  const vehicle = Vehicle.create({
    scene: engine.scene,
    physics,
    position: spawn.pos,
    heading: spawn.heading,
    quality: settingsStore.current.quality,
    vehicleId,
  });

  t = stage('vehicle', t);

  const camera = new ChaseCamera(engine.camera, vehicle, physics, engine.bus);
  // The camera tuning is authored against the 4.7m Jeep; anything larger needs
  // a proportionally bigger rig or the eye ends up inside the vehicle. Each
  // roster entry carries its own scale rather than main hard-coding a list.
  camera.setRigScale(getVehicleDefinition(vehicleId).cameraRigScale);

  const audio = new AudioSystem({ seed: CONFIG.worldSeed });
  audio.setVehicle(vehicle);
  audio.setWorld(world);

  t = stage('audio', t);

  const ui = new UISystem({
    settings: settingsStore,
    save,
    vehicle,
    world,
  });

  t = stage('ui', t);

  /* ---- gameplay ---- */
  const combo = new ComboSystem({ bus: engine.bus, vehicle });
  const score = new ScoreSystem({ bus: engine.bus, save, vehicle });
  const missions = new MissionSystem({
    scene: engine.scene,
    bus: engine.bus,
    world,
    vehicle,
    combo,
    rng: new RNG(CONFIG.worldSeed ^ 0xfa2e),
    quality: settingsStore.current.quality,
  });
  // Rank, rep, unlocks and the daily rotation; and the per-person arc ledger.
  // Both are Systems: they subscribe in `init()` and are disposed with the
  // engine, so they must be registered below *before* `initSystems()`.
  const progression = new Progression({ bus: engine.bus, save });
  const relationships = new Relationships({ bus: engine.bus, save });

  // The chinchorreo. It is a `ShiftController`, not a System — the director
  // ticks it — so it is handed over rather than registered on the engine. It
  // shares the mission system's figure/beacon pools so the geometry is built
  // once, and therefore must not outlive them (it does not own them).
  const partyBus = new PartyBusMode({
    bus: engine.bus,
    world,
    vehicle,
    scene: engine.scene,
    combo,
    rng: new RNG(CONFIG.worldSeed ^ 0xb115),
    quality: settingsStore.current.quality,
    models: missions.modelPool,
    beacons: missions.beaconPool,
  });

  // `?entry=title` restores the old menu-first boot for captures and QA;
  // `?entry=arcade` drops straight into a timed shift. The game's front door
  // is free roam.
  const entry = parseEntry(new URLSearchParams(location.search).get('entry'));

  const director = new GameDirector({
    bus: engine.bus,
    missions,
    combo,
    score,
    ui,
    save,
    vehicle,
    world,
    progression,
    relationships,
    partyBus,
    entry,
  });
  director.onPauseChanged = (paused) => {
    engine.paused = paused;
  };
  ui.onAction = (a) => director.handleUIAction(a);

  t = stage('gameplay', t);

  const traffic = new TrafficSystem({
    scene: engine.scene,
    physics,
    world,
    player: vehicle,
    rng: new RNG(CONFIG.worldSeed ^ 0x7a4c),
    quality: settingsStore.current.quality,
  });
  const pedestrians = new PedestrianSystem({
    scene: engine.scene,
    physics,
    world,
    player: vehicle,
    rng: new RNG(CONFIG.worldSeed ^ 0x9e11),
    quality: settingsStore.current.quality,
    hazard: traffic.hazard,
  });

  t = stage('traffic+peds', t);

  engine.add(world);
  engine.add(vehicle);
  engine.add(new PhysicsStepper(physics));
  // Traffic before missions so near-miss and blip data is current this frame.
  engine.add(traffic);
  engine.add(pedestrians);
  engine.add(combo);
  engine.add(missions);
  engine.add(score);
  // No per-frame work; registered so they subscribe once and dispose cleanly.
  engine.add(progression);
  engine.add(relationships);
  // Before the UI: the director's marker/patience pump must land the same frame.
  if (governor) engine.add(governor);
  engine.add(director);
  engine.add(camera);
  // After the camera: the listener is refreshed in lateUpdate from final transforms.
  engine.add(audio);
  engine.add(ui);

  // Input is sampled once per frame; `airborne` remaps steering to air control.
  engine.setPreFrameHook((dt) => {
    input.poll(dt, settingsStore.current, vehicle.isAirborne);
  });

  // LOCOFX-TEMP-WIRING-BEGIN
  const pipeline = new RenderPipeline(
    engine.renderer,
    engine.scene,
    engine.camera,
    settingsStore.current,
    engine.bus,
  );
  pipeline.setSpeedSource(() => camera);
  engine.add(pipeline);
  engine.setRenderHook((dt) => pipeline.render(dt));
  // LOCOFX-TEMP-WIRING-END

  await engine.initSystems();
  t = stage('initSystems', t);
  // Defence in depth: UISystem.init() also hides this, but it is registered
  // last, so any earlier system that stalls or throws would otherwise leave the
  // game permanently behind an opaque overlay — indistinguishable from a black
  // screen. Hide it here too, as soon as the loop is genuinely up.
  hideBootSplash();
  engine.timeOfDay = 15.5;

  // The opening move. It has to happen *after* `initSystems()`: the UI
  // subscribes to `game:state` in its own `init`, and `UISystem.init` also
  // forces itself to `'title'`. Transitioning before that point would be
  // overwritten and the player would be left staring at the menu.
  const opened = director.openingMove();
  console.info(`[boot] entry=${entry} -> ${opened}`);

  // After the opening move: a run respawns the Jeep at the world spawn, and
  // the chase camera must not interpolate across that jump.
  camera.snapToTarget();
  engine.start();

  clearTimeout(watchdog);
  installTestHook(engine, input, world, vehicle, camera, save, audio, director, missions, ui, governor);
  hideBootSplash();
}

/** `?entry=` → an `EntryMode`. Anything unrecognised opens on free roam. */
function parseEntry(raw: string | null): EntryMode {
  switch (raw) {
    case 'title':
    case 'arcade':
    case 'freeRoam':
      return raw;
    default:
      return 'freeRoam';
  }
}

function installTestHook(
  engine: Engine,
  input: Input,
  world: World,
  vehicle: Vehicle,
  camera: ChaseCamera,
  save: SaveSystem,
  audio: AudioSystem,
  director: GameDirector,
  missions: MissionSystem,
  ui: UISystem,
  governor: QualityGovernor | null,
): void {
  const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
  const hook: LocoTestHook = {
    ready: true,
    showTitle() {
      camera.setShowcase(true, vehicle.object3d);
      director.showTitle();
    },
    startArcade() {
      camera.setShowcase(false);
      camera.snapToTarget();
      void audio.unlock();
      director.startMode('arcade');
    },
    startFreeRoam() {
      camera.setShowcase(false);
      camera.snapToTarget();
      void audio.unlock();
      director.startFreeRoam();
    },
    startParty() {
      camera.setShowcase(false);
      camera.snapToTarget();
      void audio.unlock();
      return director.startPartyBus();
    },
    pause() {
      if (director.currentState === 'paused') director.resume();
      else director.pause();
    },
    resume() {
      director.resume();
    },
    state() {
      return director.currentState;
    },
    mode() {
      return director.currentMode;
    },
    roam() {
      const free = director.freeRide;
      return {
        state: director.currentState,
        mode: director.currentMode,
        live: director.isLive,
        hudClock: Number(ui.hud.timeRemaining.toFixed(2)),
        clock: Number(free.clockSeconds.toFixed(2)),
        fareActive: free.fareActive,
        hasPassenger: missions.hasPassenger,
        rideSecondsLeft: Number(missions.rideSecondsLeft.toFixed(2)),
        rideAllowance: Number(missions.rideAllowance.toFixed(2)),
        accepted: free.faresAccepted,
        banked: free.faresBanked,
        completed: missions.faresCompleted,
        failed: missions.faresFailed,
        waitingBudget: missions.waitingBudget,
        waitPatience: Number(missions.waitPatience.toFixed(2)),
        hudDigits: text('.ll-timer__digits') + text('.ll-timer__tenths'),
        hudLabel: text('.ll-timer__label .ll-lbl-es'),
        hudFare: text('.ll-fare__value'),
        hudPrompt: text('.ll-roam.is-live .ll-dest__name'),
      };
    },
    waitingFares() {
      const px = vehicle.position.x;
      const pz = vehicle.position.z;
      return missions.waitingMarkers
        .map((m) => ({
          x: Number(m.x.toFixed(2)),
          z: Number(m.z.toFixed(2)),
          d: Number(Math.hypot(m.x - px, m.z - pz).toFixed(2)),
        }))
        .sort((a, b) => a.d - b.d);
    },
    party() {
      const p = director.partyBus;
      const stop = p?.currentStop ?? null;
      return {
        wired: p !== null,
        isPartyRun: director.isPartyRun,
        running: director.currentState === 'playing' && director.isLive && p !== null && !p.finished,
        phase: p ? p.currentPhase : 'none',
        stops: p ? p.stopCount : 0,
        aboard: p ? p.aboardCount : 0,
        collected: p ? p.collectedCount : 0,
        hype: p ? Number(p.crowdHype.toFixed(3)) : 0,
        timeLeft: p ? Number(p.timeRemaining.toFixed(2)) : 0,
        stop: stop
          ? {
              id: stop.id,
              name: stop.name,
              x: Number(stop.pos.x.toFixed(2)),
              z: Number(stop.pos.z.toFixed(2)),
            }
          : null,
      };
    },
    destination() {
      const poi = missions.activeDestination;
      if (!poi) return null;
      return {
        id: poi.id,
        name: poi.name,
        x: Number(poi.pos.x.toFixed(2)),
        z: Number(poi.pos.z.toFixed(2)),
      };
    },
    setInput(partial) {
      input.setOverride({ ...(input.state as InputState), ...partial });
    },
    clearInput() {
      input.setOverride(null);
    },
    setTimeOfDay(h) {
      engine.timeOfDay = h;
      world.setTimeOfDay(h);
    },
    setWeather(k) {
      world.setWeather(k as WeatherKind);
    },
    teleport(x, y, z, heading = 0) {
      vehicle.respawn(new THREE.Vector3(x, y, z), heading);
      camera.snapToTarget();
    },
    async perfSample(ms) {
      const s = await engine.perfSample(ms);
      return { ...s };
    },
    async profile(ms) {
      engine.profileStart();
      await new Promise<void>((r) => setTimeout(r, ms));
      return engine.profileStop();
    },
    groundY(x, z) {
      return Number(world.groundHeight(x, z).toFixed(3));
    },
    places() {
      return world.pois.map((q) => ({
        id: q.id,
        kind: q.kind,
        x: Number(q.pos.x.toFixed(1)),
        y: Number(q.pos.y.toFixed(1)),
        z: Number(q.pos.z.toFixed(1)),
      }));
    },
    bounds() {
      return world.bounds;
    },
    vehicleId() {
      return vehicle.vehicleId;
    },
    governor() {
      return governor ? governor.stats() : null;
    },
    sceneBreakdown() {
      const rows: Array<{ group: string; meshes: number; instanced: number; instances: number; triangles: number }> = [];
      const tally = (root: THREE.Object3D, label: string): void => {
        let meshes = 0;
        let instanced = 0;
        let instances = 0;
        let triangles = 0;
        root.traverse((o) => {
          const m = o as THREE.Mesh & { count?: number; isInstancedMesh?: boolean };
          if (!m.isMesh || !m.geometry) return;
          const g = m.geometry as THREE.BufferGeometry;
          const tris = g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
          if (m.isInstancedMesh) {
            instanced++;
            instances += m.count ?? 0;
            triangles += tris * (m.count ?? 0);
          } else {
            meshes++;
            triangles += tris;
          }
        });
        if (meshes + instanced > 0) {
          rows.push({ group: label, meshes, instanced, instances, triangles: Math.round(triangles) });
        }
      };
      // World layers hang off the world root; everything else is top-level.
      for (const child of engine.scene.children) {
        if (child === world.root) {
          for (const layer of child.children) tally(layer, `world/${layer.name || 'unnamed'}`);
        } else {
          tally(child, child.name || child.type);
        }
      }
      rows.sort((a, b) => b.triangles - a.triangles);
      return rows;
    },
    stats() {
      return {
        ...engine.stats(),
        speed: Number(vehicle.speed.toFixed(2)),
        boost: Number(vehicle.boostFraction.toFixed(3)),
        wheelsOnGround: vehicle.wheelsOnGround,
        camDistance: Number(camera.distance.toFixed(2)),
        camFov: Number(camera.fov.toFixed(1)),
        bank: save.current.bank,
        rep: director.progress?.reputation ?? -1,
        rank: director.progress?.rank ?? -1,
        repThisShift: director.progress?.repThisShift ?? -1,
        metPassengers: save.current.metPassengers.length,
        arcStages: director.arcStages,
      };
    },
  };
  window.__loco = hook;
}

boot().catch((err: unknown) => {
  console.error('[LocoLift] boot failed:', err);
  const detail = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  showBootError('Loco Lift failed to start', detail);
});
