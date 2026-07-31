/**
 * Loco Lift — the UI system.
 *
 * Owns the DOM root, mounts and unmounts screens by `GameStateId`, subscribes
 * to the typed event bus and routes every payload to the widget that cares, and
 * drives the per-frame HUD in `lateUpdate` (frame order: input → physics →
 * update → **lateUpdate** → render, so by the time we run, transforms are final).
 *
 * Dependencies are structural, never imported:
 *  - the Jeep arrives as `VehicleLike`, duck-typed on the documented getters;
 *  - the city arrives as `UIWorldSource`, whose `roads` is the narrow minimap
 *    graph interface.
 *
 * Menu intent leaves through `onAction`. If nothing is listening, the system
 * falls back to emitting the equivalent bus events so it still works standalone
 * (in the harness, or before the director is wired).
 */
import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import type { EventBus } from '../core/EventBus';
import { clamp01 } from '../core/MathUtils';
import type {
  EventKey,
  EventMap,
  FareResult,
  GameContext,
  GameMode,
  GameStateId,
  PassengerArchetype,
  POI,
  SettingsState,
  System,
} from '../core/types';
import type { SaveSystem } from '../save/SaveSystem';
import type { SettingsStore } from '../settings/SettingsStore';
import { DestinationArrow } from './DestinationArrow';
import { HUD, type HudFrame } from './HUD';
import { Minimap, type MinimapBounds, type MinimapGraph, type MinimapPoint } from './Minimap';
import { PauseMenu } from './PauseMenu';
import { ResultsScreen, type ResultsData } from './ResultsScreen';
import { SettingsMenu } from './SettingsMenu';
import { TitleScreen } from './TitleScreen';
import { Toasts } from './Toasts';
import { TouchControls } from './TouchControls';
import { formatInt, UITheme, type NavAction, type NavigableScreen } from './UITheme';

/* ------------------------------------------------------ structural inputs */

/** The slice of the Jeep the UI reads. Duck-typed — no vehicle import. */
export interface VehicleLike {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** m/s, always >= 0 */
  readonly speed: number;
  /** m/s along local -Z, signed */
  readonly forwardSpeed: number;
  /** 0..1 meter fill */
  readonly boostFraction: number;
  readonly isBoosting: boolean;
  readonly isDrifting: boolean;
  readonly isAirborne: boolean;
}

/** The slice of the world the UI reads. `roads` is the minimap's own interface. */
export interface UIWorldSource {
  roads: MinimapGraph;
  bounds: MinimapBounds;
  poiById?(id: string): POI | undefined;
  pois?: ReadonlyArray<POI>;
}

export type UIAction =
  | { kind: 'startMode'; mode: GameMode }
  | { kind: 'resume' }
  | { kind: 'restart' }
  | { kind: 'quitToTitle' }
  | { kind: 'openSettings' }
  | { kind: 'closeSettings' }
  | { kind: 'openGarage' }
  | { kind: 'openCredits' };

export interface UISystemOptions {
  /** defaults to `#ui-root`, then `document.body` */
  root?: HTMLElement;
  settings: SettingsStore;
  save?: SaveSystem | null;
  vehicle?: VehicleLike | null;
  world?: UIWorldSource | null;
}

/* ---------------------------------------------------------------- helpers */

const WEATHER_ES: Record<string, string> = {
  clear: 'Despejado',
  rain: 'Lluvia',
  storm: 'Tormenta',
  sunset: 'Atardecer',
  night: 'Noche',
};

/** Repeat pacing for held gamepad directions. */
const PAD_FIRST = 0.42;
const PAD_REPEAT = 0.14;

const COMBO_WINDOW = 4.0;
const HAIL_TTL = 45;

interface HailMarker {
  x: number;
  z: number;
  life: number;
}

interface ShiftTally {
  mode: GameMode;
  fares: number;
  base: number;
  distanceBonus: number;
  timeBonus: number;
  comboBonus: number;
  tip: number;
  total: number;
  ratingSum: number;
  bestCombo: number;
  lastGrade: string;
  bankAtStart: number;
  bestScoreAtStart: number;
  bestFaresAtStart: number;
  bestComboAtStart: number;
}

/* ------------------------------------------------------------------ class */

export class UISystem implements System {
  readonly name = 'ui';

  /** Menu intent. When null, intent falls back to bus events. */
  onAction: ((action: UIAction) => void) | null = null;

  private readonly root: HTMLElement;
  private readonly ownsRoot: boolean;
  private readonly settingsStore: SettingsStore;
  private readonly save: SaveSystem | null;

  readonly theme: UITheme;
  readonly hud: HUD;
  readonly minimap: Minimap;
  readonly arrow: DestinationArrow;
  readonly toasts: Toasts;
  readonly title: TitleScreen;
  readonly pause: PauseMenu;
  readonly settingsMenu: SettingsMenu;
  readonly results: ResultsScreen;
  /** on-screen driving controls; inert until a touch device is detected */
  readonly touch: TouchControls;

  private bus: EventBus | null = null;
  private vehicle: VehicleLike | null;
  private world: UIWorldSource | null = null;

  private state: GameStateId = 'boot';
  private stateBeforeSettings: GameStateId = 'title';
  private mode: GameMode = 'arcade';

  private readonly unsubs: Array<() => void> = [];
  private unsubSettings: (() => void) | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onResize: (() => void) | null = null;

  private viewW = 1280;
  private viewH = 720;
  /** viewport-derived UI shrink, so a 390 px-tall phone is not all chrome */
  private compact = 1;
  private lastSettings: SettingsState;

  private score = 0;

  private readonly frame: HudFrame;
  private readonly forward = new THREE.Vector3();
  private readonly toDest = new THREE.Vector3();
  private readonly destPos = new THREE.Vector3();
  private hasDest = false;
  private wrongWayTimer = 0;

  private archetypes = new Map<string, PassengerArchetype>();
  private activeArchetype: string | null = null;
  private patienceLeft = 0;
  private patienceMax = 1;
  private patienceExternal = false;

  private hails: HailMarker[] = [];
  private readonly hailPoints: MinimapPoint[] = [];
  private trafficPoints: ReadonlyArray<MinimapPoint> = [];

  private tally: ShiftTally = blankTally('arcade');
  private pendingResults: ResultsData | null = null;

  private padPrev = new Map<string, number>();
  private padTimer = 0;
  private padHeld: NavAction | null = null;

  constructor(opts: UISystemOptions) {
    const found = opts.root ?? document.getElementById('ui-root');
    if (found) {
      this.root = found;
      this.ownsRoot = false;
    } else {
      this.root = document.createElement('div');
      this.root.id = 'ui-root';
      document.body.append(this.root);
      this.ownsRoot = true;
    }

    this.settingsStore = opts.settings;
    this.save = opts.save ?? null;
    this.vehicle = opts.vehicle ?? null;

    this.theme = new UITheme(this.root);
    this.hud = new HUD(this.theme);
    this.minimap = new Minimap(this.theme);
    this.arrow = new DestinationArrow(this.theme);
    this.toasts = new Toasts(this.theme);
    this.title = new TitleScreen(this.theme, this.save);
    this.pause = new PauseMenu(this.theme);
    this.settingsMenu = new SettingsMenu(this.theme, this.settingsStore);
    this.results = new ResultsScreen(this.theme);
    this.touch = new TouchControls({ theme: this.theme });

    this.minimap.mount(this.hud.minimapSlot);
    this.arrow.mount(this.hud.arrowSlot);

    this.frame = {
      dt: 0,
      rawDt: 0,
      camera: new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, CONFIG.camera.near, CONFIG.camera.far),
      width: this.viewW,
      height: this.viewH,
      running: false,
    };

    this.lastSettings = this.settingsStore.current;
    this.wireScreens();
    this.measure();
    this.applySettings(this.settingsStore.current);
    if (opts.world) this.setWorld(opts.world);
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: GameContext): void {
    this.bus = ctx.bus;
    this.frame.camera = ctx.camera;
    this.applySettings(ctx.settings);
    this.subscribe(ctx.bus);

    this.unsubSettings = this.settingsStore.subscribe((s) => this.applySettings(s));

    this.onResize = (): void => this.measure();
    window.addEventListener('resize', this.onResize, { passive: true });
    this.measure();

    this.onKeyDown = (e: KeyboardEvent): void => this.handleKey(e);
    window.addEventListener('keydown', this.onKeyDown);

    this.toasts.mount(this.root);
    // The touch layer lives for the whole session; it shows itself only while
    // driving, and only on a device that actually has a finger.
    this.touch.mount(this.root);
    this.setState('title');

    // The page's boot splash has done its job the moment a screen is up.
    const splash = document.getElementById('boot');
    if (splash) splash.hidden = true;
  }

  /** Re-point the UI at a Jeep (e.g. after a respawn rebuild). */
  setVehicle(v: VehicleLike | null): void {
    this.vehicle = v;
  }

  /** Hand over the road graph + bounds; bakes the minimap once. */
  setWorld(world: UIWorldSource | null): void {
    this.world = world;
    if (world) this.minimap.setGraph(world.roads, world.bounds);
  }

  /** Register passenger archetypes so the HUD card can name and colour them. */
  setArchetypes(list: ReadonlyArray<PassengerArchetype>): void {
    this.archetypes.clear();
    for (const a of list) this.archetypes.set(a.id, a);
  }

  /** Authoritative patience from the mission system, if it wants to drive it. */
  setPassengerPatience(fraction: number): void {
    this.patienceExternal = true;
    this.hud.setPatience(clamp01(fraction));
  }

  /** Waiting-fare markers for the minimap. Overrides the hail-derived set. */
  setWaitingFares(points: ReadonlyArray<MinimapPoint>): void {
    this.hails.length = 0;
    this.minimap.setPassengerMarkers(points);
  }

  /** Traffic blips for the minimap; call once per frame or not at all. */
  setTrafficBlips(points: ReadonlyArray<MinimapPoint>): void {
    this.trafficPoints = points;
  }

  /* --------------------------------------------------------------- states */

  setState(id: GameStateId): void {
    if (id === this.state) return;
    const from = this.state;
    this.state = id;

    if (id === 'settings' && from !== 'settings') this.stateBeforeSettings = from;

    this.unmountAll();

    switch (id) {
      case 'title':
      case 'modeSelect':
        this.title.openPanel('none');
        this.title.mount(this.root);
        this.title.refresh();
        this.title.focusFirst();
        break;
      case 'garage':
        this.title.mount(this.root);
        this.title.refresh();
        this.title.openPanel('garage');
        break;
      case 'playing':
        this.hud.mount(this.root);
        this.hud.setDimmed(false);
        this.minimap.setVisible(true);
        break;
      case 'paused':
        this.hud.mount(this.root);
        this.hud.setDimmed(true);
        this.pause.setStats({
          score: this.score,
          fares: this.tally.fares,
          timeRemaining: this.hud.timeRemaining,
          bestCombo: this.tally.bestCombo,
        });
        this.pause.mount(this.root);
        break;
      case 'results':
        if (this.pendingResults) this.results.show(this.pendingResults);
        this.results.mount(this.root);
        break;
      case 'settings':
        // keep whatever was underneath visible but inert
        if (this.stateBeforeSettings === 'paused' || this.stateBeforeSettings === 'playing') {
          this.hud.mount(this.root);
          this.hud.setDimmed(true);
        } else {
          this.title.mount(this.root);
        }
        this.settingsMenu.mount(this.root);
        break;
      case 'boot':
      default:
        break;
    }
    this.root.dataset.state = id;
    this.touch.setPlaying(id === 'playing');
  }

  get currentState(): GameStateId {
    return this.state;
  }

  /** Start the 3 · 2 · 1 · ¡DALE! sequence. */
  showCountdown(): void {
    this.hud.startCountdown();
  }

  private unmountAll(): void {
    this.title.unmount();
    this.pause.unmount();
    this.settingsMenu.unmount();
    this.results.unmount();
    this.hud.unmount();
  }

  private activeScreen(): (NavigableScreen & { trapTab(e: KeyboardEvent): void }) | null {
    switch (this.state) {
      case 'settings':
        return this.settingsMenu;
      case 'paused':
        return this.pause;
      case 'results':
        return this.results;
      case 'title':
      case 'modeSelect':
      case 'garage':
        return this.title;
      default:
        return null;
    }
  }

  /* ---------------------------------------------------------------- frame */

  update(ctx: GameContext, _dt: number): void {
    if (this.activeScreen()) this.pollGamepad(ctx.rawDt);
  }

  lateUpdate(ctx: GameContext, dt: number): void {
    const raw = ctx.rawDt > 0 ? Math.min(ctx.rawDt, 0.1) : dt;
    this.frame.dt = dt;
    this.frame.rawDt = raw;
    this.frame.camera = ctx.camera;
    this.frame.width = this.viewW;
    this.frame.height = this.viewH;

    const playing = this.state === 'playing';
    this.frame.running = playing && !ctx.paused && !this.hud.countdownActive;

    this.toasts.update(raw);
    // Runs every frame, not just while playing: the stick has to keep centring
    // smoothly when a menu opens under the player's thumb.
    this.touch.update(raw);
    if (this.state === 'results') this.results.update(raw);

    if (playing || this.state === 'paused' || this.state === 'settings') {
      this.updateDriving(raw, this.frame.running);
      this.hud.update(this.frame);
    }
  }

  private updateDriving(raw: number, running: boolean): void {
    const v = this.vehicle;

    if (v) {
      this.hud.setSpeed(v.speed);
      this.hud.setBoost(v.boostFraction, v.isBoosting);
      this.hud.setDriveState(v.isDrifting, v.isAirborne);
      // the TURBO button doubles as the boost meter when the HUD one is stowed
      this.touch.setBoost(v.boostFraction, v.isBoosting);
      this.touch.setDrifting(v.isDrifting);

      this.forward.set(0, 0, -1).applyQuaternion(v.quaternion);
      const heading = Math.atan2(this.forward.x, -this.forward.z);
      this.minimap.setPlayer(v.position.x, v.position.z, heading);

      if (this.hasDest) {
        this.arrow.update({
          camera: this.frame.camera,
          width: this.frame.width,
          height: this.frame.height,
          playerX: v.position.x,
          playerZ: v.position.z,
          heading,
          dt: raw,
          rawDt: raw,
        });
        this.hud.setDestinationDistance(this.arrow.distanceToTarget);
        this.updateWrongWay(v, raw, running);
      } else {
        this.hud.setDestinationDistance(-1);
      }
    }

    /* waiting fares ------------------------------------------------------ */
    if (this.hails.length > 0) {
      this.hailPoints.length = 0;
      for (let i = this.hails.length - 1; i >= 0; i--) {
        const h = this.hails[i];
        h.life -= raw;
        if (h.life <= 0) {
          this.hails.splice(i, 1);
          continue;
        }
        this.hailPoints.push(h);
      }
      this.minimap.setPassengerMarkers(this.hailPoints);
    }
    if (this.trafficPoints.length > 0) this.minimap.setTrafficMarkers(this.trafficPoints);
    this.minimap.update(raw);

    /* patience ----------------------------------------------------------- */
    if (running && this.activeArchetype && !this.patienceExternal && this.patienceMax > 0) {
      this.patienceLeft = Math.max(0, this.patienceLeft - raw);
      this.hud.setPatience(this.patienceLeft / this.patienceMax);
    }
  }

  private updateWrongWay(v: VehicleLike, raw: number, running: boolean): void {
    if (!running || v.speed < 7) {
      if (this.wrongWayTimer > 0) {
        this.wrongWayTimer = 0;
        this.arrow.setWrongWay(false);
      }
      return;
    }
    this.toDest.set(this.destPos.x - v.position.x, 0, this.destPos.z - v.position.z);
    const len = this.toDest.length();
    if (len < 25) {
      this.wrongWayTimer = 0;
      this.arrow.setWrongWay(false);
      return;
    }
    this.toDest.multiplyScalar(1 / len);
    const dir = v.forwardSpeed < 0 ? -1 : 1;
    const dot = (this.forward.x * this.toDest.x + this.forward.z * this.toDest.z) * dir;
    if (dot < -0.4) {
      this.wrongWayTimer += raw;
      if (this.wrongWayTimer > 1.4) this.arrow.setWrongWay(true);
    } else if (dot > 0.05) {
      this.wrongWayTimer = 0;
      this.arrow.setWrongWay(false);
    }
  }

  private measure(): void {
    this.viewW = window.innerWidth || 1280;
    this.viewH = window.innerHeight || 720;
    const next = compactFactor(this.viewW, this.viewH);
    if (next !== this.compact) {
      this.compact = next;
      this.applySettings(this.lastSettings);
    }
  }

  /* ------------------------------------------------------------- settings */

  /**
   * The player's `uiScale` is a preference, not a layout budget. On a phone the
   * same chrome eats half the screen, so the theme is handed a *derived* scale:
   * the user's choice multiplied by a viewport factor. The store is never
   * written to, so the settings menu still shows what the player actually chose.
   */
  private applySettings(s: SettingsState): void {
    this.lastSettings = s;
    const scaled: SettingsState =
      this.compact === 1 ? s : { ...s, uiScale: s.uiScale * this.compact };

    this.theme.apply(scaled);
    this.hud.applySettings(scaled);
    // The minimap is the single biggest HUD element; on a short screen it gets
    // capped harder than everything else.
    this.minimap.applySettings(
      this.viewH <= 560 ? { ...scaled, uiScale: Math.min(scaled.uiScale, 0.75) } : scaled,
    );
    this.touch.applySettings(scaled);
  }

  onQualityChange(): void {
    this.applySettings(this.settingsStore.current);
  }

  /* --------------------------------------------------------------- events */

  private subscribe(bus: EventBus): void {
    const on = <K extends EventKey>(key: K, fn: (payload: EventMap[K]) => void): void => {
      this.unsubs.push(bus.on(key, fn));
    };

    on('game:state', (p) => this.setState(p.to));
    on('game:mode', (p) => {
      this.mode = p.mode;
    });
    on('game:settingsChanged', (p) => this.applySettings(p.settings));
    on('game:quality', (p) => this.toasts.push(`Calidad: ${p.tier.toUpperCase()}`, 'star', 1600));

    /* --- shift --------------------------------------------------------- */
    on('shift:start', (p) => {
      this.mode = p.mode;
      this.tally = blankTally(p.mode);
      if (this.save) {
        const d = this.save.current;
        this.tally.bankAtStart = d.bank;
        this.tally.bestScoreAtStart = d.bestScore[p.mode] ?? 0;
        this.tally.bestFaresAtStart = d.bestFares;
        this.tally.bestComboAtStart = d.biggestCombo;
      }
      this.score = 0;
      this.hud.setScore(0, true);
      this.hud.breakCombo();
      this.hud.setTime(p.duration, p.duration);
      this.hud.setPassenger(null);
      this.hud.setDestination(null);
      this.arrow.setTarget(null);
      this.hasDest = false;
      this.minimap.clearDestination();
      this.toasts.clear();
      this.hud.startCountdown();
    });

    on('shift:timeAdded', (p) => {
      this.hud.addTime(p.seconds);
      this.hud.flashTimeExtension(p.seconds, p.reason || 'Tiempo extra');
    });

    on('shift:timeWarning', (p) => {
      this.hud.setTime(p.remaining);
      this.toasts.notice(`¡${Math.round(p.remaining)} SEGUNDOS!`, true);
    });

    on('shift:end', (p) => {
      this.pendingResults = this.buildResults(p.score, p.rating);
      this.hud.setPassenger(null);
      this.hud.setDestination(null);
      this.arrow.setTarget(null);
      this.hasDest = false;
      this.minimap.clearDestination();
    });

    /* --- score / combo -------------------------------------------------- */
    on('score:changed', (p) => {
      this.score = p.score;
      this.hud.setScore(p.score);
    });

    on('combo:multiplier', (p) => {
      this.tally.bestCombo = Math.max(this.tally.bestCombo, p.multiplier);
      this.hud.setCombo(p.multiplier, COMBO_WINDOW);
    });

    on('combo:add', (p) => {
      this.hud.refreshCombo(COMBO_WINDOW);
      this.hud.pushCallout(p.label, p.points);
      if (p.at) this.hud.scorePopup(p.at, `+${Math.round(p.points)}`, 'combo');
    });

    on('combo:break', () => this.hud.breakCombo());

    /* --- vehicle -------------------------------------------------------- */
    on('vehicle:nearMiss', (p) => {
      this.hud.flash('pickup');
      this.hud.scorePopup(p.at, '¡CASI!', 'pickup');
    });
    on('vehicle:collision', (p) => {
      if (p.impulse > 12) {
        this.hud.flash('danger');
        this.touch.haptic('impact');
      }
    });
    on('vehicle:airTrick', (p) => this.hud.pushCallout(p.name, p.points));
    on('vehicle:jumpLand', (p) => {
      if (p.clean && p.airtime > 0.9) this.hud.pushCallout('¡BIG AIR!', p.points);
    });
    on('prop:destroyed', (p) => this.hud.scorePopup(p.at, `+${Math.round(p.points)}`, 'combo'));

    /* --- passengers ------------------------------------------------------ */
    on('passenger:hail', (p) => {
      this.hails.push({ x: p.at.x, z: p.at.z, life: HAIL_TTL });
      if (this.hails.length > 12) this.hails.shift();
      const a = this.archetypes.get(p.archetypeId);
      this.toasts.push(`${a ? a.name : prettify(p.archetypeId)} te hace señas`, 'pin', 2000);
    });

    on('passenger:pickup', (p) => {
      const a = this.archetypes.get(p.archetypeId);
      this.activeArchetype = p.archetypeId;
      this.patienceMax = a?.patience && a.patience > 0 ? a.patience : 60;
      this.patienceLeft = this.patienceMax;
      this.patienceExternal = false;
      this.hud.setPassenger({
        archetypeId: p.archetypeId,
        name: a?.name ?? prettify(p.archetypeId),
        blurb: a?.blurb ?? 'Sube y agárrate.',
        color: a?.color ?? 0x00e5ff,
        fareEstimate: p.fareEstimate,
      });
      this.hud.setPatience(1);
      this.dropNearestHail();
      this.setDestinationById(p.destinationId);
      this.hud.flash('pickup');
      this.touch.haptic('reward');
      this.toasts.push('¡Pasajero a bordo!', 'money', 1800);
    });

    on('passenger:mood', (p) => {
      if (p.archetypeId === this.activeArchetype) this.hud.setMood(p.mood);
    });

    on('passenger:say', (p) => {
      const a = this.archetypes.get(p.archetypeId);
      this.hud.say(a?.name ?? prettify(p.archetypeId), p.text);
    });

    on('passenger:dropoff', (p) => {
      this.accumulate(p.result);
      const v = this.vehicle;
      if (v) this.hud.scorePopup(v.position, `+$${Math.round(p.result.total)}`, 'player');
      this.hud.setPassenger(null);
      this.hud.setDestination(null);
      this.arrow.setTarget(null);
      this.arrow.setWrongWay(false);
      this.hasDest = false;
      this.minimap.clearDestination();
      this.activeArchetype = null;
      this.toasts.push(`${p.result.grade} · $${Math.round(p.result.total)}`, 'money', 2400);
    });

    on('passenger:bail', (p) => {
      const a = this.archetypes.get(p.archetypeId);
      this.hud.setPassenger(null);
      this.hud.setDestination(null);
      this.arrow.setTarget(null);
      this.hasDest = false;
      this.minimap.clearDestination();
      this.activeArchetype = null;
      this.toasts.push(
        p.reason === 'timeout'
          ? `${a?.name ?? 'El pasajero'} se cansó de esperar`
          : `${a?.name ?? 'El pasajero'} se bajó del susto`,
        'warn',
        2600,
      );
    });

    /* --- missions ------------------------------------------------------- */
    on('mission:start', (p) => {
      this.toasts.notice(p.title, true);
      this.toasts.push(p.objective, 'star', 3200);
    });
    on('mission:complete', (p) => {
      this.toasts.notice(p.result.grade || '¡Completado!', true);
    });
    on('mission:fail', (p) => this.toasts.push(p.reason, 'warn', 3000));

    /* --- ambient -------------------------------------------------------- */
    on('weather:changed', (p) =>
      this.toasts.push(WEATHER_ES[p.kind] ?? p.kind, p.kind === 'storm' ? 'warn' : 'star', 2000),
    );
    on('ui:toast', (p) => this.toasts.push(p.text, p.icon, p.ms));
    on('ui:notice', (p) => this.toasts.notice(p.text, p.big ?? false));
  }

  private dropNearestHail(): void {
    const v = this.vehicle;
    if (!v || this.hails.length === 0) return;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.hails.length; i++) {
      const d = (this.hails[i].x - v.position.x) ** 2 + (this.hails[i].z - v.position.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) this.hails.splice(best, 1);
  }

  private setDestinationById(id: string): void {
    const poi = this.world?.poiById?.(id) ?? this.world?.pois?.find((p) => p.id === id);
    if (!poi) {
      this.hud.setDestination(prettify(id));
      this.hasDest = false;
      this.arrow.setTarget(null);
      this.minimap.clearDestination();
      return;
    }
    this.hud.setDestination(poi.name);
    this.destPos.copy(poi.pos);
    this.hasDest = true;
    this.arrow.setTarget(poi.pos);
    this.minimap.setDestination(poi.pos.x, poi.pos.z);
  }

  private accumulate(r: FareResult): void {
    const t = this.tally;
    t.fares += 1;
    t.base += r.base;
    t.distanceBonus += r.distanceBonus;
    t.timeBonus += r.timeBonus;
    t.comboBonus += r.comboBonus;
    t.tip += r.tip;
    t.total += r.total;
    t.ratingSum += r.rating;
    t.lastGrade = r.grade || t.lastGrade;
  }

  private buildResults(score: number, rating: number): ResultsData {
    const t = this.tally;
    const total = t.total > 0 ? t.total : score;
    const records: Array<{ label: string; value: string }> = [];
    if (this.save) {
      if (score > t.bestScoreAtStart)
        records.push({ label: 'Mejor puntuación', value: `$${formatInt(score)}` });
      if (t.fares > t.bestFaresAtStart)
        records.push({ label: 'Más carreras', value: formatInt(t.fares) });
      if (t.bestCombo > t.bestComboAtStart)
        records.push({ label: 'Combo más alto', value: `×${Math.round(t.bestCombo)}` });
    }
    const bank = this.save ? Math.max(this.save.current.bank, t.bankAtStart + total) : total;
    const avgRating = t.fares > 0 ? t.ratingSum / t.fares : rating;
    return {
      mode: t.mode,
      fares: t.fares,
      rating: rating > 0 ? rating : avgRating,
      grade: t.lastGrade || gradeFor(rating > 0 ? rating : avgRating),
      breakdown: {
        base: t.base,
        distanceBonus: t.distanceBonus,
        timeBonus: t.timeBonus,
        comboBonus: t.comboBonus,
        tip: t.tip,
      },
      total,
      bestCombo: t.bestCombo,
      cashBanked: total,
      bankTotal: bank,
      records,
    };
  }

  /* ----------------------------------------------------------- menu intent */

  private wireScreens(): void {
    this.title.onStartMode = (mode): void => {
      this.mode = mode;
      this.dispatch({ kind: 'startMode', mode });
    };
    this.title.onOpenSettings = (): void => this.dispatch({ kind: 'openSettings' });
    this.title.onOpenGarage = (): void => this.dispatch({ kind: 'openGarage' });
    this.title.onOpenCredits = (): void => this.dispatch({ kind: 'openCredits' });

    this.pause.onResume = (): void => this.dispatch({ kind: 'resume' });
    this.pause.onRestart = (): void => this.dispatch({ kind: 'restart' });
    this.pause.onSettings = (): void => this.dispatch({ kind: 'openSettings' });
    this.pause.onQuit = (): void => this.dispatch({ kind: 'quitToTitle' });

    this.settingsMenu.onBack = (): void => this.dispatch({ kind: 'closeSettings' });

    this.results.onAgain = (): void => this.dispatch({ kind: 'startMode', mode: this.mode });
    this.results.onGarage = (): void => this.dispatch({ kind: 'openGarage' });
    this.results.onTitle = (): void => this.dispatch({ kind: 'quitToTitle' });
  }

  private dispatch(action: UIAction): void {
    if (this.onAction) {
      this.onAction(action);
      return;
    }
    // Standalone fallback so the UI is coherent without a director wired.
    const bus = this.bus;
    switch (action.kind) {
      case 'startMode':
        bus?.emit('game:mode', { mode: action.mode });
        this.go('playing');
        break;
      case 'resume':
      case 'restart':
        this.go('playing');
        break;
      case 'quitToTitle':
        this.go('title');
        break;
      case 'openSettings':
        this.go('settings');
        break;
      case 'closeSettings':
        this.go(this.stateBeforeSettings === 'settings' ? 'title' : this.stateBeforeSettings);
        break;
      case 'openGarage':
        this.go('garage');
        break;
      case 'openCredits':
        this.title.openPanel('credits');
        break;
      default:
        break;
    }
  }

  private go(to: GameStateId): void {
    const from = this.state;
    this.setState(to);
    this.bus?.emit('game:state', { from, to });
  }

  /* ------------------------------------------------------------ key input */

  private handleKey(e: KeyboardEvent): void {
    const screen = this.activeScreen();
    if (!screen) return;

    if (e.key === 'Tab') {
      screen.trapTab(e);
      return;
    }
    let action: NavAction | null = null;
    switch (e.key) {
      case 'ArrowUp':
        action = 'up';
        break;
      case 'ArrowDown':
        action = 'down';
        break;
      case 'Escape':
        action = 'back';
        break;
      case 'Enter':
        // let the browser activate the focused control; only handle the
        // results fast-forward, which has no focused control yet
        if (this.state === 'results' && !this.results.isComplete) action = 'confirm';
        break;
      default:
        break;
    }
    if (!action) return;
    if (screen.handleNav(action)) e.preventDefault();
  }

  /* --------------------------------------------------------------- gamepad */

  private pollGamepad(dt: number): void {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return;
    const pads = nav.getGamepads();
    if (!pads) return;

    let up = false;
    let down = false;
    let left = false;
    let right = false;
    let confirm = false;
    let back = false;

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected) continue;
      const b = pad.buttons;
      const ax = pad.axes;
      up = up || pressed(b, 12) || (ax.length > 1 && ax[1] < -0.55);
      down = down || pressed(b, 13) || (ax.length > 1 && ax[1] > 0.55);
      left = left || pressed(b, 14) || (ax.length > 0 && ax[0] < -0.55);
      right = right || pressed(b, 15) || (ax.length > 0 && ax[0] > 0.55);
      confirm = confirm || pressed(b, 0);
      back = back || pressed(b, 1);
    }

    const dir: NavAction | null = up ? 'up' : down ? 'down' : left ? 'left' : right ? 'right' : null;
    if (dir !== this.padHeld) {
      this.padHeld = dir;
      this.padTimer = PAD_FIRST;
      if (dir) this.fireNav(dir);
    } else if (dir) {
      this.padTimer -= dt;
      if (this.padTimer <= 0) {
        this.padTimer = PAD_REPEAT;
        this.fireNav(dir);
      }
    }

    this.edge('confirm', confirm, 'confirm');
    this.edge('back', back, 'back');
  }

  private edge(key: string, now: boolean, action: NavAction): void {
    const was = (this.padPrev.get(key) ?? 0) > 0.5;
    this.padPrev.set(key, now ? 1 : 0);
    if (now && !was) this.fireNav(action);
  }

  private fireNav(action: NavAction): void {
    this.activeScreen()?.handleNav(action);
  }

  /* -------------------------------------------------------------- disposal */

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.unsubSettings?.();
    this.unsubSettings = null;
    if (this.onKeyDown) window.removeEventListener('keydown', this.onKeyDown);
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    this.onKeyDown = null;
    this.onResize = null;

    this.touch.dispose();
    this.arrow.dispose();
    this.minimap.dispose();
    this.hud.dispose();
    this.toasts.dispose();
    this.title.dispose();
    this.pause.dispose();
    this.settingsMenu.dispose();
    this.results.dispose();
    this.theme.dispose();

    this.root.replaceChildren();
    delete this.root.dataset.state;
    if (this.ownsRoot) this.root.remove();
    this.bus = null;
    this.vehicle = null;
    this.world = null;
  }
}

/* --------------------------------------------------------------- helpers */

/**
 * How much to shrink the whole UI for the viewport it landed in. Landscape
 * phones are ~390 px tall: at scale 1 the HUD chrome alone would be most of it.
 */
function compactFactor(w: number, h: number): number {
  if (h <= 430 || w <= 620) return 0.78;
  if (h <= 560 || w <= 840) return 0.88;
  return 1;
}

function pressed(buttons: ReadonlyArray<GamepadButton>, index: number): boolean {
  const b = buttons[index];
  return !!b && (b.pressed || b.value > 0.5);
}

/** `cruise_tourist` → `Cruise Tourist`, for archetypes we were never told about. */
function prettify(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function gradeFor(rating: number): string {
  if (rating >= 4.5) return '¡Brutal!';
  if (rating >= 3.5) return '¡Tremendo!';
  if (rating >= 2.5) return 'Bien hecho';
  if (rating >= 1.5) return 'Se puede mejorar';
  return 'Ay, bendito';
}

function blankTally(mode: GameMode): ShiftTally {
  return {
    mode,
    fares: 0,
    base: 0,
    distanceBonus: 0,
    timeBonus: 0,
    comboBonus: 0,
    tip: 0,
    total: 0,
    ratingSum: 0,
    bestCombo: 1,
    lastGrade: '',
    bankAtStart: 0,
    bestScoreAtStart: 0,
    bestFaresAtStart: 0,
    bestComboAtStart: 0,
  };
}
