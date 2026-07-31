/**
 * Loco Lift — the job board.
 *
 * Every special mission in the game lives here as data. `MissionSystem` is the
 * engine; this file is the content, so adding a job to the island never means
 * touching the loop.
 *
 * A job is described by:
 *
 *   who        `archetypeId` — the person the fare spawns as
 *   where from `spawnKinds` / `spawnIds` / `region` — which corner of the map
 *   where to   `destKinds` / `destIds` — and how many legs
 *   when       `hours` (in-game clock) and `weather`
 *   how hard   `timeLimit`, `crashFail`, `minSpeedAbove`
 *   what for   `bonusCash`, `bonusTime`, `rankXp`
 *   gated by   `minRank` / `requires` (the progression spine)
 *
 * Three regions matter, because the first map is three very different driving
 * problems: the **casco viejo** (tight, cobbled, blind corners), the **costa**
 * (fast, open, the road you actually get to use fifth gear on) and **Piñones**
 * (the beach chinchorro strip east along the coast — sand, kioskos, palms).
 * Region is resolved from the live POI table so a world that has not built
 * Piñones yet simply degrades to the two regions it does have.
 */
import type { POI, POIKind } from '../core/types';

/* ------------------------------------------------------------------ types */

/** Weather kinds, matching `EventMap['weather:changed']['kind']`. */
export type WeatherKind = 'clear' | 'rain' | 'storm' | 'sunset' | 'night';

/** The three driving problems the first map poses. */
export type MapRegion = 'oldTown' | 'coast' | 'pinones';

export interface SpecialMissionDef {
  id: string;
  title: string;
  objective: string;
  archetypeId: string;
  /** POI kinds the destination may be, best-first */
  destKinds: readonly POIKind[];
  /** hard deadline from pickup, seconds (per leg on a multi-leg run) */
  timeLimit: number;
  /** contact impulse that fails the run outright, or Infinity */
  crashFail: number;
  bonusCash: number;
  bonusTime: number;
  minRoute: number;
  maxRoute: number;
  failTimeout: string;
  failCrash?: string;

  /* ------------------------------------------------------------ optional */

  /** exact POI ids to prefer for the destination, when the world has them */
  destIds?: readonly string[];
  /** spawn the fare near a POI of one of these kinds */
  spawnKinds?: readonly POIKind[];
  /** spawn the fare near one of these exact POI ids */
  spawnIds?: readonly string[];
  /** which part of the map the job belongs to */
  region?: MapRegion;
  /** stops in the run; 1 (default) is a normal A→B fare */
  legs?: number;
  /** extra cash for each leg *after* the first */
  legBonus?: number;
  /** seconds added to the ride clock when a mid-run leg lands */
  legTime?: number;
  /** in-game hour window [from, to); wraps midnight when from > to */
  hours?: readonly [number, number];
  /** weather this job only appears in */
  weather?: readonly WeatherKind[];
  /** reputation rank required before this appears */
  minRank?: number;
  /** story ids that must already be complete */
  requires?: readonly string[];
  /** part of the progression spine */
  story?: boolean;
  /** spine ordering; also the number shown in "encargo 4 / 12" */
  order?: number;
  /** relative weight in the arcade random pick; 0 removes it from the pool */
  weight?: number;
  /** m/s the vehicle must stay above once the run is live */
  minSpeedAbove?: number;
  /** seconds below `minSpeedAbove` before the run fails */
  minSpeedGrace?: number;
  failSlow?: string;
  /** reputation points paid on completion */
  rankXp?: number;
  /** unlock ids granted when this job is completed for the first time */
  grants?: readonly string[];
}

/* --------------------------------------------------------------- regions */

const PINONES_HINT = /pin[oó]n|chinchorro|kiosko|kiosco|vacia|loiza|lo[ií]za/i;
const COAST_HINT = /muelle|playa|playita|malec[oó]n|costa|paseo|caleta|marina|dock|boquilla/i;

/**
 * Which region a POI belongs to. Id and name hints win — the world names things
 * honestly — and geometry is the fallback: Piñones is east along the coast, so
 * the eastern quarter of the playable bounds is Piñones whatever it is called.
 */
export function regionOfPOI(
  poi: POI,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): MapRegion {
  const tag = `${poi.id} ${poi.name}`;
  if (PINONES_HINT.test(tag)) return 'pinones';

  const spanX = bounds.maxX - bounds.minX;
  if (Number.isFinite(spanX) && spanX > 1) {
    const tx = (poi.pos.x - bounds.minX) / spanX;
    if (tx > 0.74) return 'pinones';
  }

  if (COAST_HINT.test(tag)) return 'coast';
  if (poi.kind === 'dock' || poi.kind === 'beach') return 'coast';
  if (poi.kind === 'lookout') return 'coast';
  return 'oldTown';
}

/** Bucket the whole POI table once, at shift start. Never called per frame. */
export function bucketByRegion(
  pois: ReadonlyArray<POI>,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): Record<MapRegion, POI[]> {
  const out: Record<MapRegion, POI[]> = { oldTown: [], coast: [], pinones: [] };
  for (const poi of pois) out[regionOfPOI(poi, bounds)].push(poi);
  return out;
}

/* ------------------------------------------------------------- the board */

const NEVER = Number.POSITIVE_INFINITY;

/**
 * The twelve encargos — the progression spine the title screen promises. Each
 * one unlocks the next, gets harder, and pays more. Twelve is deliberate: it is
 * an evening of play, it walks the player through all three regions, and the
 * last one hands over the keys to the Chinchorreo bus.
 */
export const STORY_MISSIONS: readonly SpecialMissionDef[] = [
  {
    id: 'story-01-primer-dia',
    title: 'ENCARGO 1 · EL PRIMER DÍA',
    objective: 'Lleva a Bryan al café. Sin prisa, sin drama. Bienvenido al turno.',
    archetypeId: 'first-timer',
    destKinds: ['cafe', 'plaza'],
    region: 'oldTown',
    timeLimit: 95,
    crashFail: NEVER,
    bonusCash: 180,
    bonusTime: 10,
    minRoute: 90,
    maxRoute: 300,
    failTimeout: 'Bryan se fue caminando. Preguntó por Google Maps.',
    story: true,
    order: 1,
    rankXp: 60,
  },
  {
    id: 'story-02-pan-caliente',
    title: 'ENCARGO 2 · PAN CALIENTE',
    objective: 'El pan de Doña Yolanda va al mercado antes de que abra la fila.',
    archetypeId: 'bakery-owner',
    destKinds: ['market', 'cafe', 'plaza'],
    spawnKinds: ['bakery', 'cafe'],
    region: 'oldTown',
    hours: [5, 11],
    timeLimit: 82,
    crashFail: NEVER,
    bonusCash: 240,
    bonusTime: 11,
    minRoute: 110,
    maxRoute: 380,
    failTimeout: 'El pan llegó frío. En esta isla eso es un delito.',
    story: true,
    order: 2,
    requires: ['story-01-primer-dia'],
    rankXp: 80,
  },
  {
    id: 'story-03-la-guia',
    title: 'ENCARGO 3 · EL GRUPO ESPERA',
    objective: 'La Profesora Iris tiene treinta turistas parados frente al castillo.',
    archetypeId: 'tour-guide',
    destKinds: ['fort', 'lookout'],
    region: 'oldTown',
    timeLimit: 74,
    crashFail: NEVER,
    bonusCash: 300,
    bonusTime: 12,
    minRoute: 150,
    maxRoute: 480,
    failTimeout: 'El grupo se fue a comprar imanes. Iris no lo va a olvidar.',
    story: true,
    order: 3,
    requires: ['story-02-pan-caliente'],
    rankXp: 100,
  },
  {
    id: 'story-04-el-mural',
    title: 'ENCARGO 4 · LA LUZ SE VA',
    objective: 'Yaniel pierde la pared si no está en la azotea antes de que caiga el sol.',
    archetypeId: 'muralist',
    destKinds: ['rooftop', 'gallery'],
    region: 'oldTown',
    hours: [15, 20],
    timeLimit: 68,
    crashFail: NEVER,
    bonusCash: 340,
    bonusTime: 12,
    minRoute: 150,
    maxRoute: 520,
    failTimeout: 'Se fue la luz buena. Mañana la pared es de otro.',
    story: true,
    order: 4,
    requires: ['story-03-la-guia'],
    rankXp: 120,
  },
  {
    id: 'story-05-el-crucero',
    title: 'ENCARGO 5 · SUELTAN AMARRAS',
    objective: 'Marla, el muelle, nueve minutos y su pasaporte a bordo. Corre.',
    archetypeId: 'cruise-guest',
    destKinds: ['dock'],
    region: 'coast',
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 420,
    bonusTime: 14,
    minRoute: 170,
    maxRoute: 640,
    failTimeout: 'El crucero zarpó. Marla ahora vive aquí, técnicamente.',
    story: true,
    order: 5,
    requires: ['story-04-el-mural'],
    rankXp: 150,
  },
  {
    id: 'story-06-la-ola',
    title: 'ENCARGO 6 · ENTRA EL SWELL',
    objective: 'Tato quiere estar en el agua antes que nadie. Coge la costa y no levantes el pie.',
    archetypeId: 'surfer',
    destKinds: ['beach', 'lookout'],
    region: 'coast',
    timeLimit: 76,
    crashFail: NEVER,
    bonusCash: 460,
    bonusTime: 14,
    minRoute: 240,
    maxRoute: 780,
    failTimeout: 'El swell se acabó. Tato ya no te habla.',
    minSpeedAbove: 9,
    minSpeedGrace: 6,
    failSlow: 'Te quedaste parado. Tato se bajó y se fue en bici.',
    story: true,
    order: 6,
    requires: ['story-05-el-crucero'],
    rankXp: 180,
  },
  {
    id: 'story-07-el-bombazo',
    title: 'ENCARGO 7 · EL BOMBAZO',
    objective: 'Kique, el barril y el salón. El toque no espera a nadie.',
    archetypeId: 'bomba-drummer',
    destKinds: ['venue', 'plaza'],
    region: 'oldTown',
    hours: [18, 3],
    timeLimit: 64,
    crashFail: NEVER,
    bonusCash: 500,
    bonusTime: 14,
    minRoute: 160,
    maxRoute: 560,
    failTimeout: 'El bombazo empezó sin Kique. Alguien más cogió su barril.',
    story: true,
    order: 7,
    requires: ['story-06-la-ola'],
    rankXp: 200,
  },
  {
    id: 'story-08-alcapurrias',
    title: 'ENCARGO 8 · LA RUTA DE DOÑA FELA',
    objective: 'Tres chinchorros de Piñones, una bandeja caliente. Que no se enfríe ninguna.',
    archetypeId: 'chinchorro-cook',
    destKinds: ['beach', 'cafe', 'market', 'venue'],
    spawnKinds: ['beach', 'cafe'],
    region: 'pinones',
    legs: 3,
    legBonus: 180,
    legTime: 22,
    timeLimit: 62,
    crashFail: NEVER,
    bonusCash: 380,
    bonusTime: 12,
    minRoute: 120,
    maxRoute: 520,
    failTimeout: 'Se enfriaron. Doña Fela las regaló y te lo va a recordar.',
    story: true,
    order: 8,
    requires: ['story-07-el-bombazo'],
    rankXp: 240,
  },
  {
    id: 'story-09-el-pescador',
    title: 'ENCARGO 9 · SALE LA LANCHA',
    objective: 'Don Nino, la nevera y el muelle pesquero. La marea no negocia.',
    archetypeId: 'fisherman',
    destKinds: ['dock', 'market'],
    destIds: ['muelle-pesquero'],
    region: 'coast',
    hours: [4, 9],
    timeLimit: 70,
    crashFail: 2600,
    bonusCash: 520,
    bonusTime: 14,
    minRoute: 200,
    maxRoute: 720,
    failTimeout: 'La lancha salió sin él. Cuarenta y un años sin faltar, hasta hoy.',
    failCrash: 'Se viró la nevera. Todo el chillo en la carretera.',
    story: true,
    order: 9,
    requires: ['story-08-alcapurrias'],
    rankXp: 280,
  },
  {
    id: 'story-10-bajo-la-lluvia',
    title: 'ENCARGO 10 · BAJO EL AGUACERO',
    objective: 'Bizcocho de tres pisos, adoquín mojado, cero golpes. Suerte.',
    archetypeId: 'bakery-owner',
    destKinds: ['chapel', 'venue', 'plaza'],
    region: 'oldTown',
    weather: ['rain', 'storm'],
    timeLimit: 104,
    crashFail: 1300,
    bonusCash: 640,
    bonusTime: 16,
    minRoute: 140,
    maxRoute: 480,
    failTimeout: 'La boda empezó. El bizcocho sigue en el carro, mojándose.',
    failCrash: '¡El bizcocho! Tres pisos en un charco.',
    story: true,
    order: 10,
    requires: ['story-09-el-pescador'],
    rankXp: 320,
  },
  {
    id: 'story-11-la-fiesta',
    title: 'ENCARGO 11 · FIESTAS PATRONALES',
    objective: 'La plaza está cerrada, el mercado desbordado y todo el mundo quiere moverse.',
    archetypeId: 'salsa-dancer',
    destKinds: ['plaza', 'venue', 'market', 'chapel'],
    spawnKinds: ['plaza', 'market'],
    region: 'oldTown',
    hours: [17, 2],
    legs: 3,
    legBonus: 220,
    legTime: 20,
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 520,
    bonusTime: 13,
    minRoute: 110,
    maxRoute: 460,
    failTimeout: 'La comparsa pasó y te quedaste atrás del gentío.',
    story: true,
    order: 11,
    requires: ['story-10-bajo-la-lluvia'],
    rankXp: 380,
  },
  {
    id: 'story-12-la-guagua',
    title: 'ENCARGO 12 · LA GUAGUA DE LA CUQUI',
    objective: 'La Cuqui tiene una guagua escolar pintada de amarillo y una idea. Llévala a Piñones.',
    archetypeId: 'party-host',
    destKinds: ['beach', 'venue', 'cafe'],
    region: 'pinones',
    hours: [16, 4],
    legs: 2,
    legBonus: 300,
    legTime: 26,
    timeLimit: 78,
    crashFail: NEVER,
    bonusCash: 900,
    bonusTime: 18,
    minRoute: 220,
    maxRoute: 900,
    failTimeout: 'La Cuqui consiguió a otro. Te vas a enterar por el grupo.',
    story: true,
    order: 12,
    requires: ['story-11-la-fiesta'],
    rankXp: 500,
    grants: ['bus'],
  },
];

/**
 * Everything else on the board. These fire between fares during an arcade
 * shift, weighted, gated by clock and weather, so a night shift in the rain
 * genuinely offers different work than a Tuesday morning.
 */
export const SIDE_MISSIONS: readonly SpecialMissionDef[] = [
  {
    id: 'gig-bomba',
    title: 'EL BOMBAZO NO ESPERA',
    objective: 'Lleva a Kique al Salón de Bomba y Plena antes de que empiece el toque.',
    archetypeId: 'bomba-drummer',
    destKinds: ['venue', 'plaza'],
    region: 'oldTown',
    timeLimit: 64,
    crashFail: NEVER,
    bonusCash: 340,
    bonusTime: 12,
    minRoute: 140,
    maxRoute: 520,
    failTimeout: 'El bombazo empezó sin Kique.',
    weight: 1,
    rankXp: 70,
  },
  {
    id: 'cruise-catch',
    title: 'EL CRUCERO ZARPA',
    objective: 'Marla tiene que estar en el muelle antes de que suelten amarras.',
    archetypeId: 'cruise-guest',
    destKinds: ['dock'],
    region: 'coast',
    timeLimit: 56,
    crashFail: NEVER,
    bonusCash: 400,
    bonusTime: 14,
    minRoute: 150,
    maxRoute: 620,
    failTimeout: 'El crucero zarpó sin Marla. Y sin su pasaporte.',
    weight: 1,
    rankXp: 80,
  },
  {
    id: 'wedding-cake',
    title: 'BIZCOCHO DE BODAS',
    objective: 'Entrega el bizcocho de Doña Yolanda SIN un solo golpe.',
    archetypeId: 'bakery-owner',
    destKinds: ['chapel', 'venue', 'plaza'],
    region: 'oldTown',
    timeLimit: 96,
    crashFail: 1500,
    bonusCash: 480,
    bonusTime: 15,
    minRoute: 130,
    maxRoute: 460,
    failTimeout: 'La boda empezó y el bizcocho sigue en el carro.',
    failCrash: '¡El bizcocho! Tres pisos en el piso.',
    weight: 0.95,
    rankXp: 110,
  },
  {
    id: 'rooftop-party',
    title: 'AZOTEA SECRETA',
    objective: 'Sube a K-Bo a la azotea antes de que cierren la puerta.',
    archetypeId: 'trap-artist',
    destKinds: ['rooftop'],
    region: 'oldTown',
    timeLimit: 72,
    crashFail: NEVER,
    bonusCash: 420,
    bonusTime: 13,
    minRoute: 150,
    maxRoute: 560,
    failTimeout: 'Cerraron la azotea. La fiesta siguió sin ustedes.',
    weight: 1,
    rankXp: 90,
  },

  /* ------------------------------------------------------------- Piñones */
  {
    id: 'pinones-food-run',
    title: 'RUTA DE ALCAPURRIAS',
    objective: 'Bandeja caliente de chinchorro en chinchorro. Frías no se venden.',
    archetypeId: 'chinchorro-cook',
    destKinds: ['beach', 'cafe', 'market', 'venue'],
    spawnKinds: ['beach', 'cafe'],
    region: 'pinones',
    legs: 3,
    legBonus: 160,
    legTime: 20,
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 320,
    bonusTime: 12,
    minRoute: 110,
    maxRoute: 500,
    failTimeout: 'Se enfriaron. Doña Fela las regaló y no está contenta.',
    weight: 1.1,
    rankXp: 130,
  },
  {
    id: 'pinones-fisherman',
    title: 'LA MAREA NO ESPERA',
    objective: 'Don Nino y su nevera al muelle. Sin virarla.',
    archetypeId: 'fisherman',
    destKinds: ['dock', 'market'],
    spawnKinds: ['beach', 'dock'],
    region: 'pinones',
    timeLimit: 76,
    crashFail: 2800,
    bonusCash: 380,
    bonusTime: 13,
    minRoute: 200,
    maxRoute: 780,
    failTimeout: 'La lancha salió sin Don Nino.',
    failCrash: 'Se viró la nevera. Chillo por toda la carretera.',
    weight: 0.9,
    rankXp: 110,
  },
  {
    id: 'pinones-surf-chase',
    title: 'PERSIGUIENDO LA OLA',
    objective: 'El set entra en cinco minutos en la playa de allá. No levantes el pie.',
    archetypeId: 'surfer',
    destKinds: ['beach', 'lookout'],
    spawnKinds: ['beach', 'lookout', 'dock'],
    region: 'pinones',
    timeLimit: 80,
    crashFail: NEVER,
    bonusCash: 400,
    bonusTime: 13,
    minRoute: 260,
    maxRoute: 900,
    failTimeout: 'Se acabó el set. Tato se queda mirando el agua.',
    minSpeedAbove: 10,
    minSpeedGrace: 5.5,
    failSlow: 'Bajaste el ritmo y la ola se fue. Tato se baja.',
    weight: 1,
    rankXp: 130,
  },
  {
    id: 'pinones-dj-load',
    title: 'LA BOCINA NO CABE',
    objective: 'DJ Melaza, dos cajas de vinilo y un kiosko esperando sonido.',
    archetypeId: 'dj',
    destKinds: ['beach', 'venue', 'cafe'],
    region: 'pinones',
    hours: [15, 4],
    timeLimit: 72,
    crashFail: 3200,
    bonusCash: 440,
    bonusTime: 13,
    minRoute: 180,
    maxRoute: 700,
    failTimeout: 'El kiosko puso el radio. Nunca es lo mismo.',
    failCrash: '¡Los vinilos! Melaza no te lo perdona.',
    weight: 0.95,
    rankXp: 140,
  },

  /* --------------------------------------------------------- plaza/market */
  {
    id: 'market-restock',
    title: 'REPONER EL MERCADO',
    objective: 'Dos paradas, una carga y un mercado que abre en nada.',
    archetypeId: 'chinchorro-cook',
    destKinds: ['market', 'plaza', 'cafe', 'bakery'],
    spawnKinds: ['market', 'plaza'],
    region: 'oldTown',
    hours: [5, 12],
    legs: 2,
    legBonus: 150,
    legTime: 18,
    timeLimit: 62,
    crashFail: NEVER,
    bonusCash: 300,
    bonusTime: 11,
    minRoute: 100,
    maxRoute: 400,
    failTimeout: 'Abrió el mercado con los cajones vacíos.',
    weight: 1,
    rankXp: 100,
  },
  {
    id: 'plaza-bride',
    title: 'LA NOVIA VA TARDE',
    objective: 'De la plaza a la capilla. Todo el mundo ya está sentado.',
    archetypeId: 'salsa-dancer',
    destKinds: ['chapel', 'venue'],
    spawnKinds: ['plaza', 'market'],
    region: 'oldTown',
    timeLimit: 60,
    crashFail: NEVER,
    bonusCash: 420,
    bonusTime: 13,
    minRoute: 130,
    maxRoute: 460,
    failTimeout: 'La boda empezó sin la madrina. Eso no se olvida.',
    weight: 0.9,
    rankXp: 120,
  },
  {
    id: 'plaza-abuela-domingo',
    title: 'MISA DE DOMINGO',
    objective: 'Doña Carmen a la capilla. Ni un derrape, ni uno.',
    archetypeId: 'abuela',
    destKinds: ['chapel', 'plaza'],
    spawnKinds: ['plaza', 'market', 'cafe'],
    region: 'oldTown',
    hours: [7, 13],
    timeLimit: 92,
    crashFail: 1100,
    bonusCash: 300,
    bonusTime: 12,
    minRoute: 90,
    maxRoute: 320,
    failTimeout: 'Doña Carmen cogió la guagua. Y se lo va a contar a todo el mundo.',
    failCrash: 'Doña Carmen se bajó en la esquina. Con razón.',
    weight: 0.85,
    rankXp: 100,
  },

  /* ---------------------------------------------------- time-of-day / rain */
  {
    id: 'night-club-run',
    title: 'LA NOCHE ES LARGA',
    objective: 'La Cuqui va al club y lleva a medio corillo por teléfono.',
    archetypeId: 'party-host',
    destKinds: ['venue', 'rooftop', 'beach'],
    hours: [21, 5],
    timeLimit: 66,
    crashFail: NEVER,
    bonusCash: 480,
    bonusTime: 14,
    minRoute: 180,
    maxRoute: 700,
    failTimeout: 'Cerraron la puerta. Se formó la fila y ella odia las filas.',
    weight: 1.15,
    rankXp: 150,
  },
  {
    id: 'night-dj-set',
    title: 'EL SET DE LAS DOS',
    objective: 'Melaza sale a las dos. Son la una y cuarenta y ocho.',
    archetypeId: 'dj',
    destKinds: ['venue', 'rooftop'],
    hours: [0, 4],
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 520,
    bonusTime: 14,
    minRoute: 180,
    maxRoute: 640,
    failTimeout: 'Alguien más cogió el set. Melaza se queda en la barra.',
    weight: 1,
    rankXp: 160,
  },
  {
    id: 'sunset-lookout',
    title: 'LA HORA DORADA',
    objective: 'Iris tiene el grupo en el mirador y el sol se está yendo.',
    archetypeId: 'tour-guide',
    destKinds: ['lookout', 'fort', 'rooftop'],
    hours: [17, 20],
    timeLimit: 64,
    crashFail: NEVER,
    bonusCash: 380,
    bonusTime: 12,
    minRoute: 160,
    maxRoute: 560,
    failTimeout: 'Se metió el sol. La foto quedó gris.',
    weight: 1,
    rankXp: 120,
  },
  {
    id: 'dawn-coffee',
    title: 'EL PRIMER CAFÉ',
    objective: 'Nadie abre el casco viejo sin café. Ni el que lo abre.',
    archetypeId: 'first-timer',
    destKinds: ['cafe', 'bakery', 'plaza'],
    hours: [4, 9],
    timeLimit: 78,
    crashFail: NEVER,
    bonusCash: 260,
    bonusTime: 11,
    minRoute: 100,
    maxRoute: 380,
    failTimeout: 'Abrieron sin café. Nadie está bien hoy.',
    weight: 0.9,
    rankXp: 80,
  },
  {
    id: 'rain-nurse',
    title: 'TURNO BAJO EL AGUA',
    objective: 'La enfermera Solís entra en diez minutos y está cayendo un palo de agua.',
    archetypeId: 'nurse',
    destKinds: ['plaza', 'chapel', 'market', 'cafe'],
    weather: ['rain', 'storm'],
    timeLimit: 68,
    crashFail: NEVER,
    bonusCash: 560,
    bonusTime: 15,
    minRoute: 150,
    maxRoute: 560,
    failTimeout: 'Llegó su relevo antes que ella. Le debe una a otra persona.',
    weight: 1.2,
    rankXp: 170,
  },
  {
    id: 'rain-gallery-rescue',
    title: 'SE MOJA LA GALERÍA',
    objective: 'Yaniel tiene lienzos en la galería y el techo lleva goteando una hora.',
    archetypeId: 'muralist',
    destKinds: ['gallery', 'rooftop', 'plaza'],
    weather: ['rain', 'storm'],
    timeLimit: 74,
    crashFail: 2400,
    bonusCash: 500,
    bonusTime: 14,
    minRoute: 140,
    maxRoute: 520,
    failTimeout: 'Se mojó todo. Dos años de trabajo en un charco.',
    failCrash: 'Los lienzos salieron volando. Ese golpe costó caro.',
    weight: 1.05,
    rankXp: 150,
  },
  {
    id: 'parranda-chelo',
    title: 'LA PARRANDA DE DON CHELO',
    objective: 'Don Chelo, el güiro y tres casas. La parranda no se planifica.',
    archetypeId: 'abuelo-parrandero',
    destKinds: ['plaza', 'venue', 'cafe', 'market'],
    hours: [18, 4],
    legs: 3,
    legBonus: 170,
    legTime: 20,
    timeLimit: 60,
    crashFail: NEVER,
    bonusCash: 340,
    bonusTime: 12,
    minRoute: 100,
    maxRoute: 420,
    failTimeout: 'La parranda siguió sin ustedes. Don Chelo no perdona eso.',
    weight: 1,
    rankXp: 140,
  },
];

/** Everything the mission system knows how to run. */
export const ALL_MISSIONS: readonly SpecialMissionDef[] = [...SIDE_MISSIONS, ...STORY_MISSIONS];

/** Back-compat alias — the arcade random pool. */
export const SPECIAL_MISSIONS: readonly SpecialMissionDef[] = SIDE_MISSIONS;

const BY_ID = new Map<string, SpecialMissionDef>(ALL_MISSIONS.map((m) => [m.id, m]));

export function missionById(id: string): SpecialMissionDef | undefined {
  return BY_ID.get(id);
}

/** The spine, in order. Safe against a def missing its `order`. */
export const STORY_ORDER: readonly SpecialMissionDef[] = STORY_MISSIONS.slice().sort(
  (a, b) => (a.order ?? 99) - (b.order ?? 99),
);

/* ------------------------------------------------------------ eligibility */

/** True when `hour` falls inside a window that may wrap past midnight. */
export function inHourWindow(hour: number, window: readonly [number, number] | undefined): boolean {
  if (!window) return true;
  const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
  const [from, to] = window;
  if (from === to) return true;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

export interface MissionContext {
  hour: number;
  weather: WeatherKind;
  rank: number;
  completed: ReadonlySet<string>;
  /** regions the live world actually has POIs in */
  regions: ReadonlySet<MapRegion>;
}

/** Can this job appear right now? */
export function isMissionEligible(def: SpecialMissionDef, ctx: MissionContext): boolean {
  if (!inHourWindow(ctx.hour, def.hours)) return false;
  if (def.weather && !def.weather.includes(ctx.weather)) return false;
  if (def.minRank !== undefined && ctx.rank < def.minRank) return false;
  if (def.region && !ctx.regions.has(def.region)) return false;
  if (def.requires) {
    for (const need of def.requires) if (!ctx.completed.has(need)) return false;
  }
  return true;
}

/** The next unplayed encargo in the spine, or null when the story is done. */
export function nextStoryMission(completed: ReadonlySet<string>): SpecialMissionDef | null {
  for (const def of STORY_ORDER) {
    if (!completed.has(def.id)) return def;
  }
  return null;
}

/** Everything the arcade director may roll right now, weights included. */
export function eligibleSideMissions(ctx: MissionContext): SpecialMissionDef[] {
  const out: SpecialMissionDef[] = [];
  for (const def of SIDE_MISSIONS) {
    if ((def.weight ?? 1) <= 0) continue;
    if (isMissionEligible(def, ctx)) out.push(def);
  }
  return out;
}
