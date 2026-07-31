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

/**
 * What the run actually asks of you. Purely descriptive — the engine reads the
 * individual constraint fields — but the HUD banner, the chapter card and the
 * codex all want a one-word verb, and having it in data keeps the campaign
 * honest about how much variety it really has.
 */
export type MissionKind =
  | 'deadline'
  | 'noContact'
  | 'collect'
  | 'chase'
  | 'escort'
  | 'sightseeing';

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

  /* ------------------------------------------------- objective variety */

  /** the verb, for the banner and the codex */
  kind?: MissionKind;
  /** 1-based chapter of the campaign this beat belongs to */
  chapter?: number;
  /** what a leg is called on this job — PARADA, GARITA, CASA, RECOGIDO… */
  legNoun?: string;
  /**
   * Ordered POI ids the run must visit, one per leg. Resolved at pickup: any id
   * the world does not have is replaced by the best available stand-in, so a
   * build without the garitas registered still runs the wall.
   */
  waypoints?: readonly string[];
  /**
   * Bind the run to a named signature route. `'el-torro'` is the sea-wall road;
   * the mission system then scores adherence and can fail you for leaving it.
   */
  route?: 'el-torro';
  /** seconds off the bound route before the run fails */
  offRouteLimit?: number;
  /** metres from the route centreline that still counts as "on it" */
  offRouteRadius?: number;
  failOffRoute?: string;
  /** m/s the vehicle must stay *under* — the escort problem, inverted */
  maxSpeedBelow?: number;
  /** seconds over `maxSpeedBelow` before the run fails */
  maxSpeedGrace?: number;
  failFast?: string;
  /** passenger terror (0..1) that ends the run — the comfort clause */
  terrorFail?: number;
  failTerror?: string;
  /** how many heavy hits the cargo survives before the run fails */
  heavyHitLimit?: number;
  failHits?: string;
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
 * The seven garitas of **El Torro**, west to east, as POI ids.
 *
 * This is the canonical list: `ElTorroRoute` builds the driving line from the
 * road graph and binds these ids to it, and any mission with
 * `waypoints: EL_TORRO_WAYPOINTS` walks them in order. A world that has not
 * registered them yet still runs the wall — the route binds the nearest real
 * POI to each garita instead, so the destination arrow never goes blank.
 */
export const EL_TORRO_WAYPOINTS: readonly string[] = [
  'garita-vientos',
  'garita-sal',
  'garita-farol',
  'garita-animas',
  'garita-vigia',
  'garita-espuma',
  'garita-aguacero',
];

/**
 * **The campaign.** Twenty-seven encargos in six chapters, in play order.
 *
 * A driver comes home to San Viejo with half a taxi licence, an uncle's Jeep
 * and no idea how the city works. Chapter by chapter it teaches them: the old
 * town first, then the coast and the sea wall, then the barrio that never gets
 * driven to, then Piñones, then a storm that closes every street but one, and
 * finally the ride that puts Tío Wiso's name back on the plaza.
 *
 * The ordering here IS the campaign — `Chapters.ts` slices this list, and
 * `StoryCampaign` decides which slice is open. Ids of the original twelve are
 * preserved exactly, so a save from an earlier build keeps its progress.
 */
export const STORY_MISSIONS: readonly SpecialMissionDef[] = [
  /* ═══ CAPÍTULO 1 · LLEGASTE ═══════════════════════════════════════════ */
  {
    id: 'story-01-primer-dia',
    title: 'ENCARGO 1 · EL PRIMER DÍA',
    objective: 'Lleva a Bryan al café. Sin prisa, sin drama. Regla número uno de Wiso.',
    archetypeId: 'first-timer',
    destKinds: ['cafe', 'plaza'],
    region: 'oldTown',
    kind: 'deadline',
    chapter: 1,
    timeLimit: 95,
    crashFail: NEVER,
    bonusCash: 180,
    bonusTime: 10,
    minRoute: 90,
    maxRoute: 300,
    failTimeout: 'Bryan se fue caminando. Preguntó si aquí hay aplicación para esto.',
    story: true,
    order: 1,
    rankXp: 60,
  },
  {
    id: 'story-02-pan-caliente',
    title: 'ENCARGO 2 · PAN CALIENTE',
    objective: 'El pan de Doña Yolanda va al mercado antes de que se forme la fila.',
    archetypeId: 'bakery-owner',
    destKinds: ['market', 'cafe', 'plaza'],
    spawnKinds: ['bakery', 'cafe'],
    region: 'oldTown',
    kind: 'deadline',
    chapter: 1,
    hours: [5, 11],
    timeLimit: 82,
    crashFail: NEVER,
    bonusCash: 240,
    bonusTime: 11,
    minRoute: 110,
    maxRoute: 380,
    failTimeout: 'El pan llegó frío. En esta isla eso es un delito menor pero es un delito.',
    story: true,
    order: 2,
    rankXp: 80,
  },
  {
    id: 'story-c1-la-llave',
    title: 'ENCARGO 3 · LA LLAVE DE WISO',
    objective: 'Nelo te lleva a buscar lo de tu tío: la llave de repuesto, el casete y la garita de plástico del bonete.',
    archetypeId: 'mecanico',
    destKinds: ['venue', 'market', 'cafe', 'bakery', 'plaza'],
    destIds: ['taller-hermanos', 'colmado-nuevo-dia', 'panaderia-aurora'],
    spawnKinds: ['venue', 'market'],
    region: 'oldTown',
    kind: 'collect',
    chapter: 1,
    legs: 3,
    legNoun: 'RECOGIDO',
    legBonus: 140,
    legTime: 20,
    timeLimit: 78,
    crashFail: NEVER,
    bonusCash: 300,
    bonusTime: 12,
    minRoute: 90,
    maxRoute: 360,
    failTimeout: 'Se hizo de noche. Wiso dijo que no hacía falta. Mentira, hacía falta.',
    story: true,
    order: 3,
    rankXp: 95,
  },
  {
    id: 'story-03-la-guia',
    title: 'ENCARGO 4 · EL GRUPO ESPERA',
    objective: 'La Profesora Iris tiene treinta turistas parados frente al castillo y una reputación que cuidar.',
    archetypeId: 'tour-guide',
    destKinds: ['fort', 'lookout'],
    region: 'oldTown',
    kind: 'deadline',
    chapter: 1,
    timeLimit: 74,
    crashFail: NEVER,
    bonusCash: 300,
    bonusTime: 12,
    minRoute: 150,
    maxRoute: 480,
    failTimeout: 'El grupo se fue a comprar imanes. Iris no lo va a olvidar.',
    story: true,
    order: 4,
    rankXp: 100,
  },
  {
    id: 'story-04-el-mural',
    title: 'ENCARGO 5 · LA LUZ SE VA',
    objective: 'Yaniel pierde la pared si no está arriba antes de que caiga el sol.',
    archetypeId: 'muralist',
    destKinds: ['rooftop', 'gallery'],
    region: 'oldTown',
    kind: 'deadline',
    chapter: 1,
    hours: [15, 20],
    timeLimit: 68,
    crashFail: NEVER,
    bonusCash: 340,
    bonusTime: 12,
    minRoute: 150,
    maxRoute: 520,
    failTimeout: 'Se fue la luz buena. Mañana la pared es de otro.',
    story: true,
    order: 5,
    rankXp: 120,
  },

  /* ═══ CAPÍTULO 2 · LA COSTA ═══════════════════════════════════════════ */
  {
    id: 'story-05-el-crucero',
    title: 'ENCARGO 6 · SUELTAN AMARRAS',
    objective: 'Marla, el muelle, nueve minutos y su pasaporte a bordo. Corre.',
    archetypeId: 'cruise-guest',
    destKinds: ['dock'],
    destIds: ['muelle-cruceros'],
    region: 'coast',
    kind: 'deadline',
    chapter: 2,
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 420,
    bonusTime: 14,
    minRoute: 170,
    maxRoute: 640,
    failTimeout: 'El crucero zarpó. Marla ahora vive aquí, técnicamente.',
    story: true,
    order: 6,
    rankXp: 150,
  },
  {
    id: 'story-c2-el-torro',
    title: 'ENCARGO 7 · EL TORRO',
    objective: 'Iris quiere la muralla entera, garita por garita, antes de que se vaya la luz. Ve rápido, pero que la vea.',
    archetypeId: 'tour-guide',
    destKinds: ['lookout', 'fort', 'rooftop', 'plaza'],
    route: 'el-torro',
    waypoints: EL_TORRO_WAYPOINTS,
    spawnIds: ['porton-torro', 'castillo-bartolome', 'mirador-garitas'],
    spawnKinds: ['fort', 'lookout'],
    region: 'oldTown',
    kind: 'sightseeing',
    chapter: 2,
    hours: [14, 20],
    legs: 7,
    legNoun: 'GARITA',
    legBonus: 120,
    legTime: 17,
    timeLimit: 48,
    crashFail: NEVER,
    terrorFail: 0.8,
    bonusCash: 520,
    bonusTime: 14,
    minRoute: 60,
    maxRoute: 320,
    failTimeout: 'Se metió el sol en el mar y el recorrido se quedó a medias.',
    failTerror: 'Iris se bajó en la segunda garita. Dijo que prefería caminarla. Y la caminó.',
    story: true,
    order: 7,
    rankXp: 190,
  },
  {
    id: 'story-06-la-ola',
    title: 'ENCARGO 8 · ENTRA EL SWELL',
    objective: 'Tato quiere estar en el agua antes que nadie. Coge la costa y no levantes el pie.',
    archetypeId: 'surfer',
    destKinds: ['beach', 'lookout'],
    region: 'coast',
    kind: 'chase',
    chapter: 2,
    timeLimit: 76,
    crashFail: NEVER,
    bonusCash: 460,
    bonusTime: 14,
    minRoute: 240,
    maxRoute: 780,
    failTimeout: 'El swell se acabó. Tato se queda mirando el agua y no te habla.',
    minSpeedAbove: 9,
    minSpeedGrace: 6,
    failSlow: 'Te quedaste parado. Tato se bajó y se fue en bicicleta.',
    story: true,
    order: 8,
    rankXp: 180,
  },
  {
    id: 'story-c2-el-perlo',
    title: 'ENCARGO 9 · LA ESCALINATA',
    objective: 'Doña Carmen va a su casa en El Perlo. Cuesta abajo, adoquín viejo, y ella lleva setenta y ocho años calificando choferes.',
    archetypeId: 'abuela',
    destKinds: ['plaza', 'venue', 'beach', 'cafe'],
    destIds: ['escalinata-perlo', 'cancha-perlo'],
    region: 'coast',
    kind: 'noContact',
    chapter: 2,
    timeLimit: 96,
    crashFail: 1400,
    terrorFail: 0.62,
    bonusCash: 400,
    bonusTime: 13,
    minRoute: 120,
    maxRoute: 460,
    failTimeout: 'Cogió la guagua en la esquina. Te miró primero, que es lo que duele.',
    failCrash: 'Un golpe así, a su edad, no. Se bajó ahí mismo.',
    failTerror: 'Se bajó en la curva. Se fue caminando y no miró atrás.',
    story: true,
    order: 9,
    rankXp: 200,
  },
  {
    id: 'story-09-el-pescador',
    title: 'ENCARGO 10 · SALE LA LANCHA',
    objective: 'Don Nino, la nevera y el muelle pesquero. La marea no negocia y la nevera va abierta.',
    archetypeId: 'fisherman',
    destKinds: ['dock', 'market'],
    destIds: ['muelle-pesquero'],
    region: 'coast',
    kind: 'noContact',
    chapter: 2,
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
    order: 10,
    rankXp: 240,
  },

  /* ═══ CAPÍTULO 3 · EL BARRIO ══════════════════════════════════════════ */
  {
    id: 'story-07-el-bombazo',
    title: 'ENCARGO 11 · EL BOMBAZO',
    objective: 'Kique, el barril y el salón. El toque no espera a nadie, y menos al que lo lleva.',
    archetypeId: 'bomba-drummer',
    destKinds: ['venue', 'plaza'],
    destIds: ['salon-bomba'],
    region: 'oldTown',
    kind: 'deadline',
    chapter: 3,
    hours: [18, 3],
    timeLimit: 64,
    crashFail: NEVER,
    bonusCash: 500,
    bonusTime: 14,
    minRoute: 160,
    maxRoute: 560,
    failTimeout: 'El bombazo empezó sin Kique. Alguien más cogió su barril.',
    story: true,
    order: 11,
    rankXp: 200,
  },
  {
    id: 'story-c3-la-novena',
    title: 'ENCARGO 12 · LA NOVENA DEL PERLO',
    objective: 'La novena de El Perlo juega en una hora y le falta el torpedero, los guantes y el dirigente. En ese orden de importancia.',
    archetypeId: 'mecanico',
    destKinds: ['venue', 'plaza', 'market', 'beach'],
    destIds: ['cancha-perlo', 'escalinata-perlo', 'colmado-nuevo-dia'],
    region: 'coast',
    kind: 'collect',
    chapter: 3,
    legs: 3,
    legNoun: 'RECOGIDO',
    legBonus: 190,
    legTime: 21,
    timeLimit: 66,
    crashFail: NEVER,
    bonusCash: 480,
    bonusTime: 13,
    minRoute: 110,
    maxRoute: 480,
    failTimeout: 'Perdieron por incomparecencia. En El Perlo eso no se olvida en un año.',
    story: true,
    order: 12,
    rankXp: 240,
  },
  {
    id: 'story-c3-el-turno',
    title: 'ENCARGO 13 · TURNO DE LAS ONCE',
    objective: 'La enfermera Solís entra a las once y no hay relevo. Rápido, sí. Pero llégale entera.',
    archetypeId: 'nurse',
    destKinds: ['venue', 'plaza', 'chapel', 'market'],
    destIds: ['centro-salud'],
    region: 'oldTown',
    kind: 'deadline',
    chapter: 3,
    hours: [20, 3],
    timeLimit: 58,
    crashFail: NEVER,
    terrorFail: 0.72,
    bonusCash: 560,
    bonusTime: 14,
    minRoute: 150,
    maxRoute: 560,
    failTimeout: 'Entró su relevo por ella. Le debe una a otra persona y lo sabe.',
    failTerror: 'Se bajó en el semáforo. "Prefiero llegar tarde que llegar acostada."',
    story: true,
    order: 13,
    rankXp: 260,
  },
  {
    id: 'story-11-la-fiesta',
    title: 'ENCARGO 14 · FIESTAS PATRONALES',
    objective: 'La plaza está cerrada, el mercado desbordado y todo el mundo quiere moverse al mismo tiempo.',
    archetypeId: 'salsa-dancer',
    destKinds: ['plaza', 'venue', 'market', 'chapel'],
    spawnKinds: ['plaza', 'market'],
    region: 'oldTown',
    kind: 'collect',
    chapter: 3,
    hours: [17, 2],
    legs: 3,
    legNoun: 'PARADA',
    legBonus: 220,
    legTime: 20,
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 520,
    bonusTime: 13,
    minRoute: 110,
    maxRoute: 460,
    failTimeout: 'Pasó la comparsa y te quedaste atrás del gentío.',
    story: true,
    order: 14,
    rankXp: 300,
  },
  {
    id: 'story-c3-la-boda',
    title: 'ENCARGO 15 · LA BODA DE LA PRIMA',
    objective: 'Bizcocho de tres pisos, de la panadería a la capilla. Millie es la madrina. Cero golpes. Cero.',
    archetypeId: 'bakery-owner',
    destKinds: ['chapel', 'venue'],
    destIds: ['capilla-san-telmo'],
    spawnIds: ['panaderia-aurora'],
    spawnKinds: ['bakery', 'cafe'],
    region: 'oldTown',
    kind: 'noContact',
    chapter: 3,
    timeLimit: 98,
    crashFail: 1200,
    bonusCash: 620,
    bonusTime: 15,
    minRoute: 130,
    maxRoute: 460,
    failTimeout: 'Entraron sin bizcocho. La novia lo entendió. Doña Yolanda no.',
    failCrash: '¡El bizcocho! Millie era la madrina. Ahora es testigo.',
    story: true,
    order: 15,
    rankXp: 320,
  },

  /* ═══ CAPÍTULO 4 · PIÑONES ════════════════════════════════════════════ */
  {
    id: 'story-08-alcapurrias',
    title: 'ENCARGO 16 · LA RUTA DE DOÑA FELA',
    objective: 'Tres chinchorros de Piñones y una bandeja caliente. Que no se enfríe ninguna.',
    archetypeId: 'chinchorro-cook',
    destKinds: ['beach', 'cafe', 'market', 'venue'],
    destIds: ['chinchorro-fela', 'kiosko-vereda', 'punta-pinones'],
    spawnKinds: ['beach', 'cafe'],
    region: 'pinones',
    kind: 'collect',
    chapter: 4,
    legs: 3,
    legNoun: 'CHINCHORRO',
    legBonus: 180,
    legTime: 22,
    timeLimit: 62,
    crashFail: NEVER,
    bonusCash: 380,
    bonusTime: 12,
    minRoute: 120,
    maxRoute: 520,
    failTimeout: 'Se enfriaron. Doña Fela las regaló y te lo va a recordar hasta diciembre.',
    story: true,
    order: 16,
    rankXp: 280,
  },
  {
    id: 'story-c4-la-bocina',
    title: 'ENCARGO 17 · LA BOCINA NO CABE',
    objective: 'La bocina de Melaza hasta el kiosko. Si suena algo antes de llegar, es que se cayó.',
    archetypeId: 'dj',
    destKinds: ['beach', 'venue', 'cafe'],
    destIds: ['kiosko-vereda', 'chinchorro-fela'],
    region: 'pinones',
    kind: 'noContact',
    chapter: 4,
    hours: [15, 4],
    timeLimit: 74,
    crashFail: 2400,
    bonusCash: 560,
    bonusTime: 14,
    minRoute: 180,
    maxRoute: 720,
    failTimeout: 'El kiosko puso una bocina prestada. Melaza no dijo nada, que es peor.',
    failCrash: 'Se partió el cono. La fiesta va a sonar a radio de carro.',
    story: true,
    order: 17,
    rankXp: 300,
  },
  {
    id: 'story-c4-el-guiro',
    title: 'ENCARGO 18 · LA PARRANDA DE DON CHELO',
    objective: 'Cuatro casas, un güiro y ningún aviso. La parranda no se planifica, se cae encima.',
    archetypeId: 'abuelo-parrandero',
    destKinds: ['plaza', 'venue', 'cafe', 'market'],
    region: 'oldTown',
    kind: 'collect',
    chapter: 4,
    hours: [19, 4],
    legs: 4,
    legNoun: 'CASA',
    legBonus: 170,
    legTime: 22,
    timeLimit: 58,
    crashFail: NEVER,
    bonusCash: 520,
    bonusTime: 13,
    minRoute: 100,
    maxRoute: 420,
    failTimeout: 'Se hizo tarde y la última casa apagó la luz. Don Chelo no habló en todo el camino.',
    story: true,
    order: 18,
    rankXp: 320,
  },
  {
    id: 'story-c4-la-vereda',
    title: 'ENCARGO 19 · LA VEREDA',
    objective: 'Tato y La Cuqui quieren llegar a la punta antes que el sol. Es la tirada más larga que hay.',
    archetypeId: 'surfer',
    destKinds: ['beach', 'lookout', 'dock'],
    destIds: ['punta-pinones', 'vereda-pinones'],
    region: 'pinones',
    kind: 'chase',
    chapter: 4,
    timeLimit: 98,
    crashFail: NEVER,
    bonusCash: 640,
    bonusTime: 16,
    minRoute: 300,
    maxRoute: 1200,
    minSpeedAbove: 11,
    minSpeedGrace: 5,
    failSlow: 'Bajaste el ritmo y se acabó la luz. Tato dice que la punta es preciosa de noche. Miente.',
    failTimeout: 'Llegaron cuando ya no se veía el agua. Nadie bajó de mal humor, pero nadie habló.',
    story: true,
    order: 19,
    rankXp: 360,
  },

  /* ═══ CAPÍTULO 5 · EL AGUACERO ════════════════════════════════════════ */
  {
    id: 'story-10-bajo-la-lluvia',
    title: 'ENCARGO 20 · BAJO EL AGUACERO',
    objective: 'Bizcocho de tres pisos, adoquín mojado, cero golpes. Suerte.',
    archetypeId: 'bakery-owner',
    destKinds: ['chapel', 'venue', 'plaza'],
    region: 'oldTown',
    kind: 'noContact',
    chapter: 5,
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
    order: 20,
    rankXp: 380,
  },
  {
    id: 'story-c5-la-clinica',
    title: 'ENCARGO 21 · TRES VIAJES',
    objective: 'La calle de abajo se inundó y hay tres vecinos que tienen que llegar al centro de salud. Uno por uno.',
    archetypeId: 'nurse',
    destKinds: ['venue', 'plaza', 'chapel', 'market'],
    destIds: ['centro-salud'],
    region: 'oldTown',
    kind: 'collect',
    chapter: 5,
    weather: ['rain', 'storm'],
    legs: 3,
    legNoun: 'VIAJE',
    legBonus: 220,
    legTime: 23,
    timeLimit: 64,
    crashFail: NEVER,
    terrorFail: 0.7,
    bonusCash: 700,
    bonusTime: 15,
    minRoute: 120,
    maxRoute: 520,
    failTimeout: 'El agua siguió subiendo. Los llevó una guagua de la ciudad tres horas después.',
    failTerror: 'Le pediste demasiado a alguien que ya venía asustado. Se bajaron todos.',
    story: true,
    order: 21,
    rankXp: 420,
  },
  {
    id: 'story-c5-las-garitas',
    title: 'ENCARGO 22 · LA ÚNICA CARRETERA',
    objective: 'El casco está inundado. La muralla es lo único abierto y hay que subir agua y baterías al refugio, garita por garita.',
    archetypeId: 'mecanico',
    destKinds: ['lookout', 'fort', 'rooftop', 'plaza'],
    route: 'el-torro',
    waypoints: EL_TORRO_WAYPOINTS,
    spawnIds: ['porton-torro', 'castillo-bartolome', 'mirador-garitas'],
    spawnKinds: ['fort', 'lookout'],
    offRouteLimit: 9,
    offRouteRadius: 55,
    region: 'oldTown',
    kind: 'escort',
    chapter: 5,
    weather: ['rain', 'storm'],
    legs: 7,
    legNoun: 'GARITA',
    legBonus: 150,
    legTime: 16,
    timeLimit: 44,
    crashFail: NEVER,
    heavyHitLimit: 4,
    bonusCash: 900,
    bonusTime: 16,
    minRoute: 60,
    maxRoute: 320,
    failTimeout: 'El refugio pasó la noche a oscuras. Nadie te lo va a echar en cara, y eso es peor.',
    failOffRoute: 'Te bajaste de la muralla y el agua te paró en seco. Nelo te hizo devolverte.',
    failHits: 'Se reventaron los bidones contra el muro. Cuatro golpes son muchos golpes.',
    story: true,
    order: 22,
    rankXp: 480,
  },
  {
    id: 'story-c5-el-generador',
    title: 'ENCARGO 23 · EL GENERADOR',
    objective: 'Un generador prestado hasta el chinchorro de Doña Fela. Si se apagan los congeladores, se pierde el año entero.',
    archetypeId: 'chinchorro-cook',
    destKinds: ['cafe', 'beach', 'venue', 'market'],
    destIds: ['chinchorro-fela', 'kiosko-vereda'],
    region: 'pinones',
    kind: 'noContact',
    chapter: 5,
    weather: ['rain', 'storm'],
    timeLimit: 108,
    crashFail: NEVER,
    heavyHitLimit: 2,
    bonusCash: 820,
    bonusTime: 17,
    minRoute: 260,
    maxRoute: 1000,
    failTimeout: 'Se descongeló todo. Doña Fela lo regaló y no lloró delante de nadie.',
    failHits: 'Se soltó el generador y se partió la base. Ese no arranca más.',
    story: true,
    order: 23,
    rankXp: 500,
  },

  /* ═══ CAPÍTULO 6 · TRANSPORTE WISO ════════════════════════════════════ */
  {
    id: 'story-c6-la-radio',
    title: 'ENCARGO 24 · RADIO MURALLA',
    objective: 'K-Bo consiguió antena, Nelo consiguió cable, y a las seis Transporte Wiso vuelve a tener radio.',
    archetypeId: 'trap-artist',
    destKinds: ['venue', 'rooftop', 'lookout', 'plaza'],
    destIds: ['radio-muralla', 'taller-hermanos', 'mirador-bahia'],
    region: 'oldTown',
    kind: 'collect',
    chapter: 6,
    legs: 3,
    legNoun: 'PARADA',
    legBonus: 200,
    legTime: 21,
    timeLimit: 68,
    crashFail: NEVER,
    bonusCash: 720,
    bonusTime: 15,
    minRoute: 130,
    maxRoute: 560,
    failTimeout: 'Se acabó el turno del transmisor. Mañana otra vez, si el del control se acuerda.',
    story: true,
    order: 24,
    rankXp: 520,
  },
  {
    id: 'story-c6-el-desfile',
    title: 'ENCARGO 25 · LA COMPARSA',
    objective: 'Abre la comparsa por el casco. Delante van los panderos, detrás va media ciudad, y tú vas al paso de todos.',
    archetypeId: 'party-host',
    destKinds: ['plaza', 'chapel', 'venue', 'market'],
    spawnKinds: ['plaza', 'market'],
    region: 'oldTown',
    kind: 'escort',
    chapter: 6,
    hours: [16, 2],
    legs: 2,
    legNoun: 'TRAMO',
    legBonus: 260,
    legTime: 44,
    timeLimit: 122,
    crashFail: 900,
    maxSpeedBelow: 9,
    maxSpeedGrace: 3.5,
    bonusCash: 780,
    bonusTime: 16,
    minRoute: 120,
    maxRoute: 380,
    failTimeout: 'La comparsa se deshizo en la plaza sin llegar a la capilla.',
    failCrash: 'Le diste a la tarima rodante. Se paró el desfile entero.',
    failFast: 'Te fuiste solo. La comparsa se quedó dos cuadras atrás con cara de nada.',
    story: true,
    order: 25,
    rankXp: 560,
  },
  {
    id: 'story-12-la-guagua',
    title: 'ENCARGO 26 · LA GUAGUA DE LA CUQUI',
    objective: 'La Cuqui tiene una guagua escolar amarilla, doce personas y una idea. Llévala a Piñones.',
    archetypeId: 'party-host',
    destKinds: ['beach', 'venue', 'cafe'],
    destIds: ['kiosko-vereda', 'chinchorro-fela', 'punta-pinones'],
    region: 'pinones',
    kind: 'collect',
    chapter: 6,
    hours: [16, 4],
    legs: 2,
    legNoun: 'PARADA',
    legBonus: 300,
    legTime: 26,
    timeLimit: 78,
    crashFail: NEVER,
    bonusCash: 900,
    bonusTime: 18,
    minRoute: 220,
    maxRoute: 900,
    failTimeout: 'La Cuqui consiguió a otro. Te vas a enterar por el grupo, que es lo peor.',
    story: true,
    order: 26,
    rankXp: 620,
    grants: ['bus'],
  },
  {
    id: 'story-c6-la-vuelta',
    title: 'ENCARGO 27 · LA VUELTA DE WISO',
    objective: 'La muralla entera con tu tío atrás. Sin prisa, sin sustos, garita por garita. Que la vea bien.',
    archetypeId: 'tio-wiso',
    destKinds: ['lookout', 'fort', 'rooftop', 'plaza'],
    route: 'el-torro',
    waypoints: EL_TORRO_WAYPOINTS,
    spawnIds: ['porton-torro', 'castillo-bartolome', 'mirador-garitas'],
    spawnKinds: ['fort', 'lookout'],
    region: 'oldTown',
    kind: 'sightseeing',
    chapter: 6,
    hours: [16, 20],
    legs: 7,
    legNoun: 'GARITA',
    legBonus: 200,
    legTime: 21,
    timeLimit: 56,
    crashFail: 1500,
    terrorFail: 0.55,
    bonusCash: 1500,
    bonusTime: 20,
    minRoute: 60,
    maxRoute: 320,
    failTimeout: 'Se metió el sol antes de llegar al final. Wiso dijo "mañana". Lo dijo bajito.',
    failCrash: 'Un golpe con él ahí atrás. Se acabó el paseo y no hizo falta que dijera nada.',
    failTerror: 'Wiso te pidió que pararas. Paraste tarde. Se bajó en la garita a mirar el mar solo.',
    story: true,
    order: 27,
    rankXp: 900,
    grants: ['garita'],
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

  /* ------------------------------------------------------------ El Torro */
  {
    id: 'torro-scenic',
    title: 'RECORRIDO DE LA MURALLA',
    objective: 'Cuatro garitas con Iris y un grupo detrás. Rápido está bien; que se maree, no.',
    archetypeId: 'tour-guide',
    destKinds: ['lookout', 'fort', 'rooftop', 'plaza'],
    route: 'el-torro',
    waypoints: EL_TORRO_WAYPOINTS,
    spawnIds: ['porton-torro', 'castillo-bartolome', 'mirador-garitas'],
    spawnKinds: ['fort', 'lookout'],
    kind: 'sightseeing',
    hours: [8, 20],
    legs: 4,
    legNoun: 'GARITA',
    legBonus: 130,
    legTime: 18,
    timeLimit: 50,
    crashFail: NEVER,
    terrorFail: 0.78,
    bonusCash: 420,
    bonusTime: 13,
    minRoute: 60,
    maxRoute: 320,
    failTimeout: 'Se les fue la tarde. El grupo vio dos garitas y una foto movida.',
    failTerror: 'Iris hizo parar. "Esto es un recorrido, no una prueba de resistencia."',
    weight: 1.05,
    rankXp: 150,
  },
  {
    id: 'torro-sprint',
    title: 'DE PORTÓN A PORTÓN',
    objective: 'K-Bo quiere grabar el sonido del carro por la muralla entera. Sin levantar el pie.',
    archetypeId: 'trap-artist',
    destKinds: ['lookout', 'fort', 'rooftop', 'gallery', 'plaza'],
    route: 'el-torro',
    waypoints: EL_TORRO_WAYPOINTS,
    spawnIds: ['porton-torro', 'castillo-bartolome', 'mirador-garitas'],
    spawnKinds: ['fort', 'lookout'],
    offRouteLimit: 12,
    offRouteRadius: 60,
    kind: 'chase',
    legs: 5,
    legNoun: 'GARITA',
    legBonus: 150,
    legTime: 15,
    timeLimit: 40,
    crashFail: NEVER,
    minSpeedAbove: 12,
    minSpeedGrace: 5,
    bonusCash: 520,
    bonusTime: 14,
    minRoute: 60,
    maxRoute: 320,
    failTimeout: 'Se acabó la batería de la grabadora. La toma buena se quedó sin final.',
    failSlow: 'Bajaste y el sonido se cayó. "Eso ya no sirve, mano."',
    failOffRoute: 'Te saliste de la muralla y se metió el ruido de la ciudad. Toma perdida.',
    weight: 0.95,
    rankXp: 170,
  },

  /* -------------------------------------------------------------- El Perlo */
  {
    id: 'perlo-cancha',
    title: 'JUEGAN A LAS SIETE',
    objective: 'Dos jugadores y el bate bueno, a la cancha de El Perlo. El juego no espera.',
    archetypeId: 'mecanico',
    destKinds: ['venue', 'plaza', 'beach', 'market'],
    destIds: ['cancha-perlo', 'escalinata-perlo'],
    spawnKinds: ['plaza', 'market', 'venue'],
    kind: 'collect',
    hours: [15, 22],
    legs: 2,
    legNoun: 'RECOGIDO',
    legBonus: 160,
    legTime: 20,
    timeLimit: 64,
    crashFail: NEVER,
    bonusCash: 360,
    bonusTime: 12,
    minRoute: 110,
    maxRoute: 460,
    failTimeout: 'Empezaron con ocho. Perdieron por una carrera. Una.',
    weight: 1,
    rankXp: 120,
  },
  {
    id: 'perlo-escalinata',
    title: 'CUESTA ABAJO',
    objective: 'Doña Carmen baja a El Perlo con las bolsas. Suave, que la escalinata no perdona.',
    archetypeId: 'abuela',
    destKinds: ['plaza', 'venue', 'cafe', 'beach'],
    destIds: ['escalinata-perlo'],
    kind: 'noContact',
    timeLimit: 92,
    crashFail: 1300,
    terrorFail: 0.6,
    bonusCash: 340,
    bonusTime: 12,
    minRoute: 100,
    maxRoute: 400,
    failTimeout: 'Cogió la guagua. Y se lo va a contar a todo el mundo, empezando por tu tío.',
    failCrash: 'Se rompió el envase de arroz. Y el envase era lo de menos.',
    failTerror: 'Se bajó antes de la curva. "Yo llego mejor caminando, gracias."',
    weight: 0.9,
    rankXp: 110,
  },

  /* --------------------------------------------------------------- taller */
  {
    id: 'taller-pieza',
    title: 'LA PIEZA',
    objective: 'Nelo consiguió la pieza en el muelle y el dueño cierra en diez minutos.',
    archetypeId: 'mecanico',
    destKinds: ['venue', 'dock', 'market'],
    destIds: ['taller-hermanos', 'muelle-pesquero'],
    kind: 'deadline',
    hours: [7, 19],
    timeLimit: 68,
    crashFail: NEVER,
    bonusCash: 320,
    bonusTime: 12,
    minRoute: 140,
    maxRoute: 520,
    failTimeout: 'Cerraron. La pieza vuelve a la lista, y la lista ya iba por cinco semanas.',
    weight: 0.9,
    rankXp: 110,
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
  (a, b) => (a.order ?? 999) - (b.order ?? 999),
);

/** The spine sliced by chapter, 1-based; index 0 is always empty. */
export const STORY_BY_CHAPTER: ReadonlyArray<readonly SpecialMissionDef[]> = (() => {
  let max = 0;
  for (const def of STORY_ORDER) max = Math.max(max, def.chapter ?? 1);
  const out: SpecialMissionDef[][] = [];
  for (let i = 0; i <= max; i++) out.push([]);
  for (const def of STORY_ORDER) out[def.chapter ?? 1].push(def);
  return out;
})();

/** How many chapters the campaign actually has. */
export const STORY_CHAPTER_COUNT = STORY_BY_CHAPTER.length - 1;

export function missionsForChapter(chapter: number): readonly SpecialMissionDef[] {
  return STORY_BY_CHAPTER[chapter] ?? EMPTY_MISSIONS;
}

const EMPTY_MISSIONS: readonly SpecialMissionDef[] = [];

/** Every distinct objective verb the campaign actually uses. */
export function storyKindTally(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of STORY_ORDER) {
    const k = def.kind ?? 'deadline';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

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
