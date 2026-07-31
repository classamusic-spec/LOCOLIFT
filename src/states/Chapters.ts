/**
 * Loco Lift — the six chapters.
 *
 * The campaign is a shape, not a list: a driver arrives, learns the old town,
 * gets given the coast, is finally let into the barrio, gets sent out to
 * Piñones, drives through a storm that closes every street but the sea wall,
 * and ends up with their uncle's name back on the plaza. Each chapter opens on
 * *earning* — either cash banked or reputation earned, whichever the player got
 * to first — so a careful driver and a fast one both get there.
 *
 * The two numbers are measured, not guessed. A clean campaign run banks roughly
 * $15k / $40k / $60k / $78k / $100k by the end of chapters 1–5 and reaches rank
 * index 1 / 3 / 4 / 4 / 5. The bars below sit just under those for the early
 * chapters and just over them for the late ones, so the back half of the game
 * asks for one honest shift of work before it opens the next door.
 *
 * This file is only the text and the thresholds. `Story.ts` decides which
 * chapter is open, `MissionCatalog.ts` owns the encargos themselves, and
 * `StoryRun.ts` plays them.
 */
import {
  missionsForChapter,
  STORY_CHAPTER_COUNT,
  type SpecialMissionDef,
} from '../passengers/MissionCatalog';

export interface ChapterDef {
  /** 1-based */
  index: number;
  id: string;
  title: string;
  subtitle: string;
  /** where it happens, for the chapter card */
  where: string;
  /** beats played when the chapter opens, in order */
  intro: readonly string[];
  /** beats played when its last encargo clears */
  outro: readonly string[];
  /** cash banked that opens it */
  requireBank: number;
  /** reputation rank that also opens it — whichever lands first */
  requireRank: number;
  /** unlock ids handed over when the chapter completes */
  grants: readonly string[];
  /** what the player is told while it is still shut */
  locked: string;
}

export const CHAPTERS: readonly ChapterDef[] = [
  {
    index: 1,
    id: 'ch1-llegaste',
    title: 'CAPÍTULO 1 · LLEGASTE',
    subtitle: 'El casco viejo, de día. Todavía nadie sabe quién eres.',
    where: 'Casco viejo',
    intro: [
      'Aterrizaste ayer con dos maletas y medio permiso de taxi.',
      'Tío Wiso te dejó el Jeep, la libreta de teléfonos y una silla plástica frente al taller de Nelo, desde donde dirige el tráfico con un bastón.',
      '"Regla número uno, mijo: el que maneja, cobra. Regla número dos: nadie se acuerda de cómo manejaste. Se acuerdan de cómo los trataste."',
    ],
    outro: [
      'Cinco encargos y ya hay gente que te espera en la acera.',
      'Yaniel te pintó el coquí en la puerta sin preguntar. "Ahora sí eres de aquí. Más o menos."',
    ],
    requireBank: 0,
    requireRank: 0,
    grants: ['coquí'],
    locked: '',
  },
  {
    index: 2,
    id: 'ch2-la-costa',
    title: 'CAPÍTULO 2 · LA COSTA',
    subtitle: 'El muelle, la carretera del mar y la muralla. Aquí sí se puede correr.',
    where: 'Costa · El Torro',
    intro: [
      'El casco se te quedó chiquito. Wiso te manda a la costa.',
      '"Súbete por la muralla. El Torro. Esa carretera la hicieron para caminar y alguien la asfaltó por error."',
      'Siete garitas, el Atlántico a la izquierda y nada delante.',
    ],
    outro: [
      'Ya te saludan por el nombre en el muelle pesquero.',
      'Don Nino te dejó una nevera en el asiento de atrás. "Es prestada. Quédatela."',
    ],
    requireBank: 13000,
    requireRank: 1,
    grants: ['cooler'],
    locked: 'La costa abre cuando la ciudad te conozca un poco. Sigue trabajando el casco.',
  },
  {
    index: 3,
    id: 'ch3-el-barrio',
    title: 'CAPÍTULO 3 · EL BARRIO',
    subtitle: 'El Perlo, el mercado y la capilla. La ciudad donde vive la gente.',
    where: 'El Perlo · Mercado',
    intro: [
      'Doña Carmen te dio su dirección. Viniendo de ella, eso es un contrato.',
      'El Perlo baja al mar por una escalinata que alguien decidió llamar calle.',
      '"Ahí abajo no entra nadie con prisa", dice Wiso. "Ni tú."',
    ],
    outro: [
      'La novena ganó, el bizcocho llegó entero y Kique tiene los viernes.',
      'Alguien volvió a colgar el letrero de la parada en la Plaza del Farolito. Nadie confiesa quién.',
    ],
    requireBank: 36000,
    requireRank: 3,
    grants: ['bocina-plena'],
    locked: 'El barrio todavía no te abre la puerta. Hazte de nombre en el casco y en la costa.',
  },
  {
    index: 4,
    id: 'ch4-pinones',
    title: 'CAPÍTULO 4 · PIÑONES',
    subtitle: 'Carretera, arena, freidoras y bocinas. Fuera de la ciudad se maneja distinto.',
    where: 'Piñones',
    intro: [
      'Doña Fela te llamó a ti. A ti, no al sobrino.',
      'Piñones es una carretera larga con chinchorros a los dos lados y una vereda que no se acaba nunca.',
      '"Allá afuera no hay semáforos", dice Wiso. "Hay curvas. No es lo mismo."',
    ],
    outro: [
      'Ya no te cobran en tres chinchorros distintos.',
      'La Cuqui te metió en el grupo. Cuarenta y un mensajes sin leer y subiendo.',
    ],
    requireBank: 58000,
    requireRank: 4,
    grants: ['stringlights'],
    locked: 'Piñones queda lejos y todavía te falta rodaje. Y gasolina.',
  },
  {
    index: 5,
    id: 'ch5-el-aguacero',
    title: 'CAPÍTULO 5 · EL AGUACERO',
    subtitle: 'Se cerró la ciudad entera. Tú no.',
    where: 'Toda la isla',
    intro: [
      'Llevaba tres días avisando, y a las cuatro de la tarde se puso negro sobre el mar.',
      'Se fue la luz en el casco y la calle de abajo se llenó de agua hasta la rodilla.',
      'Wiso te llamó una sola vez: "La muralla va a ser lo único abierto. Súbete."',
    ],
    outro: [
      'Escampó a las seis de la mañana y la ciudad amaneció barriendo.',
      'Nelo te cambió las cuatro gomas sin decírtelo y sin anotarlo en la libreta.',
    ],
    requireBank: 84000,
    requireRank: 5,
    grants: ['upgrade-tires'],
    locked: 'Cuando llegue el agua vas a querer estar listo. Todavía no lo estás.',
  },
  {
    index: 6,
    id: 'ch6-transporte-wiso',
    title: 'CAPÍTULO 6 · TRANSPORTE WISO',
    subtitle: 'La ciudad te devuelve lo que le diste.',
    where: 'San Viejo',
    intro: [
      'K-Bo consiguió una antena, Nelo consiguió cable e Iris consiguió el permiso.',
      'A las seis de la tarde, Transporte Wiso vuelve a tener radio.',
      '"Yo no te dejé un negocio, mijo. Te dejé una lista de gente. Cuídala."',
    ],
    outro: [
      'El letrero volvió a la Plaza del Farolito. Lo colgaste tú y Wiso miró, que era parte del trato.',
      'Estaban todos: Doña Carmen con un envase, Kique con el barril, y Marla, que vino tres días solo para eso.',
      'Wiso se sentó en la silla plástica, miró la muralla y no dijo nada durante un rato largo.',
      '"Bueno. Mañana seguimos."',
    ],
    requireBank: 112000,
    requireRank: 6,
    grants: ['garita'],
    locked: 'Todavía falta. Todo esto se gana manejando.',
  },
];

/* ----------------------------------------------------------------- lookup */

const BY_INDEX = new Map<number, ChapterDef>(CHAPTERS.map((c) => [c.index, c]));

export function chapterDef(index: number): ChapterDef | null {
  return BY_INDEX.get(index) ?? null;
}

export const CHAPTER_COUNT = CHAPTERS.length;

/** Encargos in a chapter, in play order. */
export function chapterMissions(index: number): readonly SpecialMissionDef[] {
  return missionsForChapter(index);
}

/** Which chapter an encargo belongs to, or 0 when it is not a story beat. */
export function chapterOfMission(id: string): number {
  for (const c of CHAPTERS) {
    for (const def of missionsForChapter(c.index)) if (def.id === id) return c.index;
  }
  return 0;
}

/**
 * True when every chapter in `CHAPTERS` has encargos behind it and every
 * encargo belongs to a declared chapter. The harness asserts this so a beat can
 * never quietly become unreachable.
 */
export function chaptersAreWellFormed(): boolean {
  if (CHAPTER_COUNT !== STORY_CHAPTER_COUNT) return false;
  for (const c of CHAPTERS) {
    if (missionsForChapter(c.index).length === 0) return false;
  }
  return true;
}
