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
import { CONFIG } from './core/Config';
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
import { UISystem } from './ui/UISystem';
import { MissionSystem } from './passengers/MissionSystem';
import { ComboSystem } from './scoring/ComboSystem';
import { ScoreSystem } from './scoring/ScoreSystem';
import { GameDirector } from './states/GameDirector';

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
  pause(): void;
  setInput(partial: Partial<InputState>): void;
  clearInput(): void;
  setTimeOfDay(h: number): void;
  setWeather(k: string): void;
  teleport(x: number, y: number, z: number, heading?: number): void;
  perfSample(ms: number): Promise<Record<string, number>>;
  stats(): Record<string, number>;
}

declare global {
  interface Window {
    __loco?: LocoTestHook;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #gl canvas');

  const settingsStore = new SettingsStore();
  const save = new SaveSystem();
  const engine = new Engine(canvas, settingsStore.current);

  // First run on an unknown device: guess a tier rather than opening on high.
  if (!localStorage.getItem('locolift.settings.v1')) {
    settingsStore.setQuality(settingsStore.autoDetectQuality(engine.renderer));
  }
  settingsStore.subscribe((s) => engine.applySettings(s));

  const input = new Input();
  engine.setInput(input.state);

  const physics = await PhysicsWorld.create(CONFIG.gravity);

  const world = await World.create({
    scene: engine.scene,
    physics,
    rng: new RNG(CONFIG.worldSeed),
    quality: settingsStore.current.quality,
  });
  await world.whenReady();

  const spawn = world.spawnPoint;
  const vehicle = Vehicle.create({
    scene: engine.scene,
    physics,
    position: spawn.pos,
    heading: spawn.heading,
    quality: settingsStore.current.quality,
  });

  const camera = new ChaseCamera(engine.camera, vehicle, physics, engine.bus);

  const audio = new AudioSystem({ seed: CONFIG.worldSeed });
  audio.setVehicle(vehicle);
  audio.setWorld(world);

  const ui = new UISystem({
    settings: settingsStore,
    save,
    vehicle,
    world,
  });

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
  const director = new GameDirector({
    bus: engine.bus,
    missions,
    combo,
    score,
    ui,
    save,
    vehicle,
    world,
  });
  director.onPauseChanged = (paused) => {
    engine.paused = paused;
  };
  ui.onAction = (a) => director.handleUIAction(a);

  engine.add(world);
  engine.add(vehicle);
  engine.add(new PhysicsStepper(physics));
  engine.add(combo);
  engine.add(missions);
  engine.add(score);
  // Before the UI: the director's marker/patience pump must land the same frame.
  engine.add(director);
  engine.add(camera);
  // After the camera: the listener is refreshed in lateUpdate from final transforms.
  engine.add(audio);
  engine.add(ui);

  // Input is sampled once per frame; `airborne` remaps steering to air control.
  engine.setPreFrameHook((dt) => {
    input.poll(dt, settingsStore.current, vehicle.isAirborne);
  });

  await engine.initSystems();
  camera.snapToTarget();
  engine.timeOfDay = 15.5;
  engine.start();

  installTestHook(engine, input, world, vehicle, camera, save, audio, director);
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
): void {
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
    pause() {
      if (director.currentState === 'paused') director.resume();
      else director.pause();
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
    stats() {
      return {
        ...engine.stats(),
        speed: Number(vehicle.speed.toFixed(2)),
        boost: Number(vehicle.boostFraction.toFixed(3)),
        wheelsOnGround: vehicle.wheelsOnGround,
        camDistance: Number(camera.distance.toFixed(2)),
        camFov: Number(camera.fov.toFixed(1)),
        bank: save.current.bank,
      };
    },
  };
  window.__loco = hook;
}

boot().catch((err) => {
  console.error('[LocoLift] boot failed:', err);
  const el = document.getElementById('ui-root');
  if (el) {
    el.innerHTML =
      `<div style="position:fixed;inset:0;display:grid;place-items:center;` +
      `font:16px/1.5 system-ui;color:#fff;background:#0b1d2a;padding:2rem;text-align:center">` +
      `<div><h1 style="margin:0 0 .5rem">Loco Lift failed to start</h1>` +
      `<pre style="white-space:pre-wrap;opacity:.8">${String(err)}</pre></div></div>`;
  }
});
