/**
 * Loco Lift — the state machine over the whole game.
 *
 *      boot ──► title ──► playing ⇄ paused
 *                 ▲          │
 *                 └── results ┘        (settings / garage overlay either side)
 *
 * The director owns *when* things run, never *how*. It starts and stops the
 * mission loop, the combo chain and the score system, hands the active mode
 * controller its ticks, gates everything behind the 3·2·1 countdown, and pumps
 * the three UI setters that are not event-driven. Screens follow the
 * `game:state` event, so the UI needs no direct call from here.
 */
import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { RNG } from '../core/RNG';
import type {
  GameContext,
  GameMode,
  GameStateId,
  PassengerArchetype,
  POI,
  QualityTier,
  RoadGraph,
  System,
} from '../core/types';
import { ARCHETYPES } from '../passengers/Archetypes';
import { CART_ARCHETYPE, type MissionSystem } from '../passengers/MissionSystem';
import type { ComboSystem } from '../scoring/ComboSystem';
import type { Progression } from '../scoring/Progression';
import type { ScoreSystem } from '../scoring/ScoreSystem';
import { ArcadeShift, type ShiftController } from './ArcadeShift';
import { Challenges, CHECKPOINT_ARCHETYPE, type ChallengeId } from './Challenges';
import { DriftMode } from './DriftMode';
import { buildElTorroRoute, type ElTorroRoute } from './ElTorroRoute';
import { FreeRide } from './FreeRide';
import { PARTY_ARCHETYPES, type PartyBusMode } from './PartyBusMode';
import { campaignStore, StoryCampaign, type CampaignStore } from './Story';
import { StoryRun } from './StoryRun';

/* ------------------------------------------------------ structural inputs */

/** The three UI setters that cannot be driven by events. */
export interface DirectorUI {
  setArchetypes(list: ReadonlyArray<PassengerArchetype>): void;
  setWaitingFares(points: ReadonlyArray<{ readonly x: number; readonly z: number }>): void;
  setPassengerPatience(fraction: number): void;
}

export interface DirectorVehicle {
  readonly position: THREE.Vector3;
  readonly speed: number;
  readonly isDrifting: boolean;
  readonly isAirborne: boolean;
  /** signed chassis slip angle, radians — drift mode scores off this */
  readonly driftAngle?: number;
  /** roster id, so drift mode can score a bus like a bus */
  readonly vehicleId?: string;
  respawn(pos: THREE.Vector3, heading: number): void;
}

export interface DirectorWorld {
  pois: ReadonlyArray<POI>;
  spawnPoint: { pos: THREE.Vector3; heading: number };
  /** lets the coastal challenge and the chinchorreo route pick their region */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** El Torro is derived from the road graph, when the world exposes one */
  roads?: RoadGraph;
  groundHeight?(x: number, z: number): number;
  poiById?(id: string): POI | undefined;
}

/**
 * The relationship ledger, as the director needs it. `Relationships` satisfies
 * this; without one the arcs simply stay at their base stage.
 */
export interface DirectorRelationships {
  beginShift(): void;
  endShift(): void;
  stageEntries(): Array<[string, number]>;
}

/** The shape `UISystem.onAction` delivers. Kept loose so it stays assignable. */
export interface DirectorAction {
  readonly kind: string;
  readonly mode?: GameMode;
}

/**
 * Which controller a `'freeRide'` start resolves to. Free roam *is* the free
 * ride mode now — the entry point of the whole game — so there is only one.
 */
export type EntryMode = 'freeRoam' | 'arcade' | 'title';

export interface GameDirectorOptions {
  bus: EventBus;
  missions: MissionSystem;
  combo: ComboSystem;
  score: ScoreSystem;
  ui?: DirectorUI | null;
  save?: import('../save/SaveSystem').SaveSystem | null;
  vehicle?: DirectorVehicle | null;
  world?: DirectorWorld | null;
  rng?: RNG;
  /** seconds the HUD's 3·2·1 holds gameplay before the shift is live */
  countdownSeconds?: number;
  /** move the Jeep back to the world spawn when a run begins */
  respawnOnStart?: boolean;
  /** rank, unlocks and the daily rotation */
  progression?: Progression | null;
  /** the Chinchorreo controller; built by `main` once the bus exists */
  partyBus?: PartyBusMode | null;
  /** the per-person arc ledger */
  relationships?: DirectorRelationships | null;
  /** where chapter cards record that they have been seen */
  campaignStore?: CampaignStore | null;
  /**
   * What `init` opens on. `'freeRoam'` drops the player straight into the city
   * with no clock — the game's front door — and `'title'` keeps the menu first.
   */
  entry?: EntryMode;
  /** seconds a drift-mode run lasts */
  driftSeconds?: number;
}

/* ------------------------------------------------------------------ class */

export class GameDirector implements System {
  readonly name = 'director';

  /** Set by `main` so the engine can be paused/unpaused with the state. */
  onPauseChanged: ((paused: boolean) => void) | null = null;
  /** Fired on every state transition, after `game:state` has gone out. */
  onStateChanged: ((state: GameStateId) => void) | null = null;

  private readonly bus: EventBus;
  private readonly missions: MissionSystem;
  private readonly combo: ComboSystem;
  private readonly score: ScoreSystem;
  private ui: DirectorUI | null;
  private readonly vehicle: DirectorVehicle | null;
  private readonly world: DirectorWorld | null;
  private readonly respawnOnStart: boolean;
  private readonly countdownSeconds: number;

  readonly arcade: ArcadeShift;
  /** free roam — the untimed entry mode, where a pickup arms the clock */
  readonly freeRide: FreeRide;
  readonly challenges: Challenges;
  readonly drift: DriftMode;
  readonly story: StoryRun;
  readonly campaign: StoryCampaign;

  private progression: Progression | null;
  private party: PartyBusMode | null;
  private relationships: DirectorRelationships | null;
  /** built once from the road graph, then handed to the mission system */
  private wallRoute: ElTorroRoute | null = null;
  private wallRouteTried = false;

  private controller: ShiftController | null = null;
  private state: GameStateId = 'boot';
  private previousState: GameStateId = 'title';
  private mode: GameMode = 'arcade';
  private pendingChallenge: ChallengeId = 'drift-marathon';
  /** true while the active controller is the Chinchorreo */
  private inParty = false;
  /** true while the active controller is Drift Mode */
  private inDrift = false;
  private readonly entry: EntryMode;

  private countdown = 0;
  private live = false;

  constructor(opts: GameDirectorOptions) {
    this.bus = opts.bus;
    this.missions = opts.missions;
    this.combo = opts.combo;
    this.score = opts.score;
    this.ui = opts.ui ?? null;
    this.vehicle = opts.vehicle ?? null;
    this.world = opts.world ?? null;
    this.respawnOnStart = opts.respawnOnStart ?? true;
    this.countdownSeconds = opts.countdownSeconds ?? 3.05;
    this.progression = opts.progression ?? null;
    this.party = opts.partyBus ?? null;
    this.relationships = opts.relationships ?? null;
    this.entry = opts.entry ?? 'freeRoam';

    const rng = opts.rng ?? new RNG(0x10c0_d17e);
    this.arcade = new ArcadeShift({ bus: this.bus });
    this.freeRide = new FreeRide({ bus: this.bus, fares: opts.missions });
    this.drift = new DriftMode({
      bus: this.bus,
      vehicle: opts.vehicle ?? FALLBACK_VEHICLE,
      world: opts.world ?? null,
      save: opts.save ?? null,
      duration: opts.driftSeconds,
    });
    this.challenges = new Challenges({
      bus: this.bus,
      vehicle: opts.vehicle ?? FALLBACK_VEHICLE,
      world: opts.world ?? null,
      save: opts.save ?? null,
      fares: opts.missions,
      rng: rng.fork(0xc4a1),
    });
    this.campaign = new StoryCampaign({
      bus: this.bus,
      progress: opts.progression ?? null,
      store: opts.campaignStore ?? (opts.save ? campaignStore(opts.save) : null),
    });
    this.story = new StoryRun({
      bus: this.bus,
      missions: opts.missions,
      progress: opts.progression ?? null,
      campaign: this.campaign,
    });
  }

  /** Hand over the arc ledger once `main` has built it. */
  setRelationships(r: DirectorRelationships | null): void {
    this.relationships = r;
  }

  /**
   * Derive El Torro from the road graph and register it with the mission
   * system. Built once, on the first run, because the world may still have
   * been streaming districts in when the director was constructed.
   */
  private ensureWallRoute(): void {
    if (this.wallRouteTried) return;
    this.wallRouteTried = true;
    const world = this.world;
    if (!world || !world.roads || !world.bounds) return;
    this.wallRoute = buildElTorroRoute({
      roads: world.roads,
      pois: world.pois,
      bounds: world.bounds,
      groundHeight: world.groundHeight?.bind(world),
      poiById: world.poiById?.bind(world),
    });
    this.missions.setRoute('el-torro', this.wallRoute);
  }

  /** The derived wall road, or null when this world has no rim to run. */
  get elTorro(): ElTorroRoute | null {
    this.ensureWallRoute();
    return this.wallRoute;
  }

  /** Hand over the Chinchorreo controller once the bus model exists. */
  setPartyBus(mode: PartyBusMode | null): void {
    this.party = mode;
  }

  setProgression(p: Progression | null): void {
    this.progression = p;
    this.story.setProgress(p);
    this.campaign.setProgress(p);
  }

  get partyBus(): PartyBusMode | null {
    return this.party;
  }

  get progress(): Progression | null {
    return this.progression;
  }

  /* ------------------------------------------------------------ lifecycle */

  init(_ctx: GameContext): void {
    this.publishArchetypes();
    this.go('title');
  }

  /**
   * Open the game the way `entry` says to. Call this once, *after*
   * `engine.initSystems()`, so the UI has already subscribed to `game:state`
   * and follows the transition instead of overwriting it in its own `init`.
   *
   * Returns the state the game ended up in.
   */
  openingMove(): GameStateId {
    switch (this.entry) {
      case 'freeRoam':
        this.startFreeRoam();
        break;
      case 'arcade':
        this.startMode('arcade');
        break;
      case 'title':
      default:
        this.showTitle();
        break;
    }
    return this.state;
  }

  setUI(ui: DirectorUI | null): void {
    this.ui = ui;
    this.publishArchetypes();
  }

  private publishArchetypes(): void {
    if (!this.ui) return;
    const list: PassengerArchetype[] = ARCHETYPES.slice();
    list.push(CHECKPOINT_ARCHETYPE, CART_ARCHETYPE, ...PARTY_ARCHETYPES);
    this.ui.setArchetypes(list);
  }

  onQualityChange(tier: QualityTier): void {
    this.missions.onQualityChange(tier);
    this.party?.onQualityChange(tier);
  }

  dispose(): void {
    this.arcade.dispose();
    this.freeRide.dispose();
    this.challenges.dispose();
    this.drift.dispose();
    this.story.dispose();
    this.controller = null;
  }

  /* ---------------------------------------------------------- inspection */

  get currentState(): GameStateId {
    return this.state;
  }

  get currentMode(): GameMode {
    return this.mode;
  }

  get isPlaying(): boolean {
    return this.state === 'playing';
  }

  get isLive(): boolean {
    return this.live;
  }

  /** Seconds left in the active mode, or Infinity in free ride. */
  get timeRemaining(): number {
    return this.controller ? this.controller.timeRemaining : 0;
  }

  get countdownRemaining(): number {
    return Math.max(0, this.countdown);
  }

  /* --------------------------------------------------------- transitions */

  private go(to: GameStateId): void {
    if (to === this.state) return;
    const from = this.state;
    if (to === 'settings' || to === 'garage') this.previousState = from;
    this.state = to;
    this.bus.emit('game:state', { from, to });
    this.onStateChanged?.(to);
  }

  showTitle(): void {
    this.abandonRun(true);
    this.go('title');
    this.onPauseChanged?.(false);
  }

  /** Choose which challenge `startMode('challenge')` will run. */
  selectChallenge(id: ChallengeId): boolean {
    if (!this.challenges.select(id)) return false;
    this.pendingChallenge = id;
    return true;
  }

  startMode(mode: GameMode, challenge?: ChallengeId): void {
    this.beginRun(mode, this.controllerFor(mode, challenge), false);
  }

  /**
   * The front door: San Viejo with no clock on it. Fares stand on the street
   * under tall beacons and wait; picking one up is what starts the timer.
   */
  startFreeRoam(): void {
    this.beginRun('freeRide', this.freeRide, false);
  }

  /** The dedicated drift playground — scored zones, chains, per-chassis feel. */
  startDriftMode(): void {
    this.drift.setWorld(this.world);
    this.beginRun(this.drift.mode, this.drift, false);
  }

  /**
   * Start the Chinchorreo. Returns false when there is no bus wired up yet, so
   * `main` can fall back to the arcade shift rather than dropping the input.
   */
  startPartyBus(): boolean {
    const party = this.party;
    if (!party) return false;
    this.beginRun(party.mode, party, true);
    return true;
  }

  /** Start the next encargo of the twelve. */
  startStory(): void {
    this.beginRun('story', this.story, false);
  }

  private beginRun(mode: GameMode, controller: ShiftController, party: boolean): void {
    this.abandonRun(false);

    this.mode = mode;
    this.inParty = party;
    this.inDrift = controller === this.drift;
    this.ensureWallRoute();

    if (this.respawnOnStart && this.vehicle && this.world) {
      const spawn = this.world.spawnPoint;
      this.vehicle.respawn(spawn.pos, spawn.heading);
    }

    /* the catalog needs to know who the player is before anything is rolled */
    const prog = this.progression;
    if (prog) {
      this.missions.setRank(prog.rank);
      this.missions.setCompletedMissions(prog.completedStory);
      prog.beginShift();
    }

    /* everyone aboard picks up where their own story left off */
    const rel = this.relationships;
    if (rel) {
      rel.beginShift();
      this.missions.setArcStages(rel.stageEntries());
    }

    this.controller = controller;
    this.score.beginShift(this.mode);
    this.missions.reset();
    this.combo.reset();

    this.bus.emit('game:mode', { mode: this.mode });
    this.controller.start();

    /* held down until the HUD's 3·2·1 lands on ¡DALE! */
    this.countdown = this.countdownSeconds;
    this.live = false;
    this.controller.setRunning(false);
    this.combo.setActive(false);
    this.missions.setActive(false);

    this.go('playing');
    this.onPauseChanged?.(false);
  }

  private controllerFor(mode: GameMode, challenge?: ChallengeId): ShiftController {
    switch (mode) {
      case 'freeRide':
        return this.freeRide;
      case 'challenge': {
        const id = challenge ?? this.pendingChallenge;
        this.challenges.select(id);
        this.pendingChallenge = id;
        this.challenges.setWorld(this.world);
        return this.challenges;
      }
      case 'story':
        return this.story;
      case 'arcade':
      default:
        return this.arcade;
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.go('paused');
    this.onPauseChanged?.(true);
  }

  resume(): void {
    if (this.state !== 'paused' && this.state !== 'settings') return;
    this.go('playing');
    this.onPauseChanged?.(false);
  }

  restart(): void {
    if (this.inParty && this.party) {
      this.startPartyBus();
      return;
    }
    if (this.inDrift) {
      this.startDriftMode();
      return;
    }
    this.startMode(this.mode, this.pendingChallenge);
  }

  quitToTitle(): void {
    this.abandonRun(true);
    this.go('title');
    this.onPauseChanged?.(false);
  }

  openSettings(): void {
    this.go('settings');
  }

  closeSettings(): void {
    const back = this.previousState === 'settings' ? 'title' : this.previousState;
    this.go(back);
    this.onPauseChanged?.(back === 'paused');
  }

  openGarage(): void {
    this.go('garage');
  }

  /** Route `UISystem.onAction` straight into the director. */
  handleUIAction(action: DirectorAction): void {
    switch (action.kind) {
      case 'startMode':
        this.startMode(action.mode ?? 'arcade');
        break;
      case 'startParty':
        /* no bus yet (not unlocked, not built) — do not drop the input */
        if (!this.startPartyBus()) this.startMode('arcade');
        break;
      case 'startFreeRoam':
        this.startFreeRoam();
        break;
      case 'startDrift':
        this.startDriftMode();
        break;
      case 'startStory':
        this.startStory();
        break;
      case 'resume':
        this.resume();
        break;
      case 'restart':
        this.restart();
        break;
      case 'quitToTitle':
        this.quitToTitle();
        break;
      case 'openSettings':
        this.openSettings();
        break;
      case 'closeSettings':
        this.closeSettings();
        break;
      case 'openGarage':
        this.openGarage();
        break;
      default:
        break;
    }
  }

  /* --------------------------------------------------------------- ending */

  /** Normal end-of-run: bank everything and show the results screen. */
  endRun(): void {
    if (!this.controller) return;
    this.live = false;
    this.missions.setActive(false);
    this.combo.break();
    this.combo.setActive(false);
    this.controller.stop();

    const summary = this.score.endShift();
    const prog = this.progression;
    if (prog) {
      prog.endShift(summary.cash, {
        longestChain: this.combo.longestChain,
        bestFare: summary.cash,
      });
      if (this.inParty && this.party) prog.recordPartyRun(summary.score);
    }
    this.relationships?.endShift();
    this.bus.emit('shift:end', {
      score: summary.score,
      fares: summary.fares,
      rating: summary.rating,
    });
    this.controller = null;
    this.inParty = false;
    this.inDrift = false;
    this.go('results');
    this.onPauseChanged?.(false);
  }

  /** Tear a run down without showing results (quit, or starting a new run). */
  private abandonRun(bank: boolean): void {
    if (!this.controller) {
      this.live = false;
      return;
    }
    this.live = false;
    this.missions.setActive(false);
    this.combo.break();
    this.combo.setActive(false);
    this.controller.stop();
    if (bank) {
      const summary = this.score.endShift();
      this.progression?.endShift(summary.cash, { longestChain: this.combo.longestChain });
    }
    this.relationships?.endShift();
    this.campaign.clearBeats();
    this.controller = null;
    this.inParty = false;
    this.inDrift = false;
  }

  /* ---------------------------------------------------------------- frame */

  update(_ctx: GameContext, dt: number): void {
    if (this.state !== 'playing' || !this.controller) return;

    if (!this.live) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.live = true;
        const c = this.controller;
        c.setRunning(true);
        /* drift mode scores and shows its own chain — stand the generic one down */
        this.combo.setActive(c.ownsCombo !== true);
        /* the chinchorreo and the drift arena both own the whole street */
        this.missions.setActive(!this.inParty && c.suppressFares !== true);
      }
      return;
    }

    this.controller.update(dt);
    if (this.controller.finished) this.endRun();
  }

  lateUpdate(ctx: GameContext, _dt: number): void {
    /* the pause key has to work while the engine itself is paused, and
     * `lateUpdate` is the only hook that still runs in that state */
    const input = ctx.input;
    if (input && input.pausePressed) {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
    }

    const ui = this.ui;
    if (!ui) return;
    if (this.state === 'playing' || this.state === 'paused') {
      const party = this.inParty ? this.party : null;
      if (this.inDrift) {
        /* the arenas replace the fare pins; the patience bar becomes the chain */
        ui.setWaitingFares(this.drift.zoneMarkers);
        ui.setPassengerPatience(this.drift.chainFraction);
      } else if (party) {
        /* chinchorro stops on the minimap; the patience bar becomes crowd hype */
        ui.setWaitingFares(party.stopMarkers);
        ui.setPassengerPatience(party.patienceFraction);
      } else {
        ui.setWaitingFares(this.missions.waitingMarkers);
        ui.setPassengerPatience(this.missions.patienceFraction);
      }
    }
  }
}

/** Keeps `Challenges` constructible when the director is built without a Jeep. */
const FALLBACK_VEHICLE = {
  position: { x: 0, y: 0, z: 0 },
  speed: 0,
  isDrifting: false,
  isAirborne: false,
};
