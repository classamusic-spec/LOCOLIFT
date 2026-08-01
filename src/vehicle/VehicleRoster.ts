/**
 * Loco Lift — the garage.
 *
 * The single list of drivable vehicles. Everything that needs to know what the
 * player can drive — the vehicle-select UI, the save file, the boot wiring in
 * main.ts — reads this file and nothing else, so adding a third vehicle means
 * writing its tuning record and its mesh and appending one entry here.
 *
 * A definition is deliberately small: an id that is safe to persist, some
 * strings for the UI, a `VehicleTuningSet` that fully determines how it drives,
 * and a factory that builds its mesh. `Vehicle` needs no other knowledge of
 * which vehicle it is simulating.
 */
import type { QualityTier } from '../core/types';
import { BusModel } from './BusModel';
import { BUS_TUNING } from './BusTuning';
import { CarriageModel } from './CarriageModel';
import { CARRIAGE_TUNING } from './CarriageTuning';
import { JeepModel } from './JeepModel';
import { JEEP_TUNING, type VehicleModel, type VehicleTuningSet } from './VehicleTuning';

/** Stable, persistable identifiers. Never renumber or rename these. */
export type VehicleId = 'jeep' | 'bus' | 'carriage';

/**
 * Coarse 0..1 bars for the vehicle-select screen. These are hand-authored
 * impressions rather than derived numbers — they describe how a vehicle feels,
 * which is not the same thing as what it measures.
 */
export interface VehicleStats {
  readonly topSpeed: number;
  readonly acceleration: number;
  readonly grip: number;
  readonly weight: number;
}

export interface VehicleDefinition {
  readonly id: VehicleId;
  /** display name, Spanish-first the way the rest of the game speaks */
  readonly name: string;
  /** one-line character summary for the select screen */
  readonly tagline: string;
  /** the longer blurb */
  readonly description: string;
  readonly stats: VehicleStats;
  /** everything that determines how it drives */
  readonly tuning: VehicleTuningSet;
  /** builds the mesh; called once per Vehicle instance */
  readonly createModel: (quality: QualityTier) => VehicleModel;
  /** how many fares it can advertise carrying, for flavour and future modes */
  readonly seats: number;

  /**
   * How much bigger than the Jeep the chase rig needs to be. `ChaseCamera`
   * already takes this through `setRigScale`; the boot code should read it from
   * here rather than branching on the id, so a fourth vehicle needs no wiring.
   * Jeep 1 (the rig was authored against it), bus 1.95, carriage 1.25.
   */
  readonly cameraRigScale: number;

  /**
   * Fare multiplier for a ride in this vehicle. A carriage ride across the old
   * city is a *scenic* ride and is priced like one; the Jeep and the bus are
   * transport. Data only — the mission and score systems own whether and how
   * they read it.
   */
  readonly farePremium: number;
}

export const VEHICLE_ROSTER: readonly VehicleDefinition[] = [
  {
    id: 'jeep',
    name: 'El Jeepeta',
    tagline: 'Rápida, ligera y siempre de lado.',
    description:
      'The taxi that started it all: an open-top off-roader with a roll cage, ' +
      'a lit TAXI sign and absolutely no interest in going in a straight line. ' +
      'Light, quick to turn, quick to stop, and happiest sideways through a ' +
      'plaza at forty metres a second.',
    stats: { topSpeed: 0.88, acceleration: 0.85, grip: 0.9, weight: 0.25 },
    tuning: JEEP_TUNING,
    createModel: (quality) => new JeepModel(quality),
    seats: 2,
    cameraRigScale: 1,
    farePremium: 1,
  },
  {
    id: 'bus',
    name: 'Chinchorreo 365',
    tagline: 'Ocho toneladas de fiesta. Frena con antelación.',
    description:
      'A retired American school bus reborn as a rolling chinchorreo: yellow ' +
      'and lime, chrome everywhere, red vinyl seats, a roof light bar, festoon ' +
      'strings along the windows and a sound system on the roof. It takes a ' +
      'block to get going and two to stop, it leans onto its door handles in ' +
      'every corner, and it removes street furniture without noticing.',
    stats: { topSpeed: 0.55, acceleration: 0.3, grip: 0.45, weight: 1.0 },
    tuning: BUS_TUNING,
    createModel: (quality) => new BusModel(quality),
    seats: 24,
    cameraRigScale: 1.95,
    farePremium: 1,
  },
  {
    id: 'carriage',
    name: 'El Coche de Caballos',
    tagline: 'Despacio, pero pasa por donde nadie más pasa.',
    description:
      'A working tourist carriage off the plaza: black lacquer, chrome-yellow ' +
      'spoked wheels, a blue-and-white awning and one dapple-grey Paso Fino in ' +
      'harness. It will never win a drag race. It will turn inside its own ' +
      'length, thread a callejón the Jeep scrapes down, and take the plaza ' +
      'steps while the others go the long way round. Spur the horse and it ' +
      'gallops — but the meter that pays for that fills up by threading ' +
      'crowds, not by going fast.',
    stats: { topSpeed: 0.24, acceleration: 0.35, grip: 0.6, weight: 0.2 },
    tuning: CARRIAGE_TUNING,
    createModel: (quality) => new CarriageModel(quality),
    seats: 4,
    /* longer than the Jeep and the interesting half of it is out in front, so
     * the rig wants a little more arm — but nothing like the bus's */
    cameraRigScale: 1.25,
    /** a scenic ride, priced like one */
    farePremium: 1.35,
  },
];

/** The vehicle a fresh save starts in. */
export const DEFAULT_VEHICLE_ID: VehicleId = 'jeep';

/** Every id, in roster order. */
export const VEHICLE_IDS: readonly VehicleId[] = VEHICLE_ROSTER.map((v) => v.id);

/** Narrow an unknown (a save file field, a URL parameter) to a real id. */
export function isVehicleId(v: unknown): v is VehicleId {
  return typeof v === 'string' && VEHICLE_IDS.includes(v as VehicleId);
}

/**
 * Look a vehicle up. Unknown ids fall back to the default rather than throwing:
 * a save file written by a newer build must never brick the game.
 */
export function getVehicleDefinition(id: string | undefined | null): VehicleDefinition {
  if (isVehicleId(id)) {
    for (let i = 0; i < VEHICLE_ROSTER.length; i++) {
      if (VEHICLE_ROSTER[i].id === id) return VEHICLE_ROSTER[i];
    }
  }
  return VEHICLE_ROSTER[0];
}

/** The next vehicle in the roster — for a one-key "swap ride" control. */
export function nextVehicleId(id: VehicleId): VehicleId {
  const i = VEHICLE_IDS.indexOf(id);
  return VEHICLE_IDS[(i + 1) % VEHICLE_IDS.length];
}
