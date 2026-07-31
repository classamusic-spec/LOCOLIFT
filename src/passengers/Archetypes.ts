/**
 * Loco Lift — passenger archetypes.
 *
 * Ten people who actually live, work and visit in Old San Juan. Each one is a
 * specific human with a specific errand, not a "type". They drive four things:
 *
 *  1. `PassengerArchetype` — the contract the HUD, audio and fare model read.
 *  2. `ArchetypeVisual`    — how `PassengerModel` builds their silhouette.
 *  3. `ArchetypeRouting`   — where they want to go and how far.
 *  4. `Dialogue`           — keyed by `id`, in `Dialogue.ts`.
 *
 * Cultural rules (ART_REFERENCE §7) are binding here:
 *  - Spanish is correct and accented; code-switching is how people really talk.
 *  - Nobody is a caricature; the joke is always the situation, never the person.
 *  - Skin tone is a **continuous** range sampled per passenger and is never
 *    correlated with the archetype's job, wealth or temperament.
 */
import type { RNG } from '../core/RNG';
import type { PassengerArchetype, POIKind } from '../core/types';

/* ------------------------------------------------------------- appearance */

export type HairStyle =
  | 'afro'
  | 'coils'
  | 'locs'
  | 'braids'
  | 'bun'
  | 'crop'
  | 'wavy'
  | 'ponytail'
  | 'bald'
  | 'bob';

export type CarriedProp =
  | 'none'
  | 'barril'
  | 'cakeBox'
  | 'rollerCase'
  | 'sprayBag'
  | 'surfboard'
  | 'tote'
  | 'backpack'
  | 'clipboard'
  | 'cooler';

export type HeadWear = 'none' | 'cap' | 'sunHat' | 'bucket' | 'bandana' | 'visor' | 'headwrap';

export type Legwear = 'shorts' | 'jeans' | 'skirt' | 'slacks' | 'boardshorts';

/** Everything `PassengerModel` needs to build a recognisable silhouette. */
export interface ArchetypeVisual {
  /** candidate torso colours — light cotton, as people actually dress here */
  shirt: readonly number[];
  /** secondary colour: apron, collar, print, trim */
  accent: readonly number[];
  legwear: Legwear;
  legColor: readonly number[];
  hair: readonly HairStyle[];
  head: readonly HeadWear[];
  prop: CarriedProp;
  /** nominal standing height in metres, before per-variant jitter */
  height: number;
  /** torso width scale, 0.9 .. 1.15 */
  build: number;
  /** how big the idle animation reads, 0..1 */
  energy: number;
  /** true when the silhouette should read with an apron/skirt wedge */
  apron: boolean;
}

/** Where this passenger wants to go, and how much road they expect to cover. */
export interface ArchetypeRouting {
  /** POI kinds they would plausibly ask for, best-first */
  destKinds: readonly POIKind[];
  /** preferred straight-line route band, metres */
  minRoute: number;
  maxRoute: number;
  /** relative spawn frequency */
  spawnWeight: number;
}

/* -------------------------------------------------------------- the cast */

export const ARCHETYPES: readonly PassengerArchetype[] = [
  {
    id: 'bomba-drummer',
    name: 'Kique el Barrilero',
    blurb: 'Barril bajo el brazo, bombazo en diez minutos. No cuenta los segundos, cuenta los golpes.',
    patience: 55,
    fareMultiplier: 1.35,
    thrillSeeking: 0.75,
    color: 0xe4572e,
    voicePitch: 0.88,
  },
  {
    id: 'bakery-owner',
    name: 'Doña Yolanda',
    blurb: 'Bizcocho de bodas de tres pisos en el asiento de atrás. Un golpe y se acabó la boda.',
    patience: 88,
    fareMultiplier: 1.8,
    thrillSeeking: -0.9,
    color: 0xf7e3af,
    voicePitch: 1.06,
  },
  {
    id: 'cruise-guest',
    name: 'Marla',
    blurb: 'El crucero zarpa en nueve minutos y su pasaporte está a bordo. Compró diecisiete imanes.',
    patience: 42,
    fareMultiplier: 1.55,
    thrillSeeking: 0.15,
    color: 0x4c8bf5,
    voicePitch: 1.14,
  },
  {
    id: 'abuela',
    name: 'Doña Carmen',
    blurb: 'Setenta y ocho años y ni una multa. No piensa empezar hoy, y menos contigo.',
    patience: 105,
    fareMultiplier: 0.9,
    thrillSeeking: -1,
    color: 0xa663cc,
    voicePitch: 1.0,
  },
  {
    id: 'muralist',
    name: 'Yaniel',
    blurb: 'Latas en la mochila, pared en la mente. La luz buena se le va a las seis.',
    patience: 72,
    fareMultiplier: 1.1,
    thrillSeeking: 0.45,
    color: 0x06a77d,
    voicePitch: 0.95,
  },
  {
    id: 'surfer',
    name: 'Tato',
    blurb: 'El swell entra a las cinco y él quiere estar en el agua a las cuatro y media.',
    patience: 66,
    fareMultiplier: 1.0,
    thrillSeeking: 1,
    color: 0x2fa8a0,
    voicePitch: 0.93,
  },
  {
    id: 'tour-guide',
    name: 'Profesora Iris',
    blurb: 'Historiadora con grupo esperando. Va a narrar cada esquina, quieras o no.',
    patience: 80,
    fareMultiplier: 1.2,
    thrillSeeking: -0.35,
    color: 0xffd166,
    voicePitch: 1.02,
  },
  {
    id: 'first-timer',
    name: 'Bryan',
    blurb: 'Primera semana en la isla, primera vez en un carro sin puertas. Aprendió "chévere" ayer.',
    patience: 92,
    fareMultiplier: 0.95,
    thrillSeeking: -0.7,
    color: 0x8bc34a,
    voicePitch: 1.09,
  },
  {
    id: 'salsa-dancer',
    name: 'Millie',
    blurb: 'Ensayo en veinte minutos y todavía no ha calentado. Te va a contar el tiempo.',
    patience: 58,
    fareMultiplier: 1.25,
    thrillSeeking: 0.6,
    color: 0xf05d8f,
    voicePitch: 1.11,
  },
  {
    id: 'trap-artist',
    name: 'K-Bo',
    blurb: 'Sesión de estudio reservada. Va grabando notas de voz desde el asiento de atrás.',
    patience: 50,
    fareMultiplier: 1.45,
    thrillSeeking: 0.85,
    color: 0x577590,
    voicePitch: 0.85,
  },
];

export const ARCHETYPE_IDS: readonly string[] = ARCHETYPES.map((a) => a.id);

const BY_ID = new Map<string, PassengerArchetype>(ARCHETYPES.map((a) => [a.id, a]));

export function archetypeById(id: string): PassengerArchetype | undefined {
  return BY_ID.get(id);
}

/** Never returns undefined — falls back to the first archetype. */
export function archetypeOrDefault(id: string): PassengerArchetype {
  return BY_ID.get(id) ?? ARCHETYPES[0];
}

/* ------------------------------------------------------------- silhouettes */

/** Light cotton, the way people actually dress in the old city. */
const COTTON = [0xfaf6ee, 0xf3e7d3, 0xdfe9f2, 0xf7d9c4, 0xcfe3d8, 0xe8d9ef, 0xfdf0c9] as const;
const BRIGHT = [0xef476f, 0x2fa8a0, 0xf2b134, 0x4c8bf5, 0x8bc34a, 0xf05d8f, 0x06a77d] as const;
const DENIM = [0x3d5a80, 0x2f4560, 0x5a6f8c, 0x46618a] as const;
const KHAKI = [0xd6c7a6, 0xc2b189, 0xe3d8bd, 0xb6a781] as const;

export const ARCHETYPE_VISUALS: Readonly<Record<string, ArchetypeVisual>> = {
  'bomba-drummer': {
    shirt: [0xfaf6ee, 0xf3e7d3, 0xe4572e, 0xfdf0c9],
    accent: [0xe4572e, 0xed0000, 0x1f2430],
    legwear: 'slacks',
    legColor: [0xf5f0e6, 0xe8dcc8, 0x2a2a33],
    hair: ['coils', 'locs', 'crop', 'bald'],
    head: ['none', 'none', 'cap', 'bandana'],
    prop: 'barril',
    height: 1.76,
    build: 1.08,
    energy: 0.8,
    apron: false,
  },
  'bakery-owner': {
    shirt: [0xfaf6ee, 0xdfe9f2, 0xf7d9c4],
    accent: [0xf05d8f, 0x2fa8a0, 0xf2b134],
    legwear: 'slacks',
    legColor: [0x2a2a33, 0x3d5a80, 0x46403a],
    hair: ['bun', 'bob', 'coils', 'ponytail'],
    head: ['none', 'headwrap', 'none'],
    prop: 'cakeBox',
    height: 1.6,
    build: 1.12,
    energy: 0.35,
    apron: true,
  },
  'cruise-guest': {
    shirt: [0xfdf0c9, 0xcfe3d8, 0xe8d9ef, 0xf7d9c4],
    accent: [0x4c8bf5, 0xef476f, 0xffd166],
    legwear: 'shorts',
    legColor: [0xd6c7a6, 0xdfe9f2, 0xe3d8bd],
    hair: ['bob', 'ponytail', 'wavy', 'crop'],
    head: ['sunHat', 'visor', 'none', 'bucket'],
    prop: 'rollerCase',
    height: 1.67,
    build: 1.0,
    energy: 0.7,
    apron: false,
  },
  abuela: {
    shirt: [0xe8d9ef, 0xdfe9f2, 0xf7d9c4, 0xcfe3d8],
    accent: [0xa663cc, 0xf2b134, 0x577590],
    legwear: 'skirt',
    legColor: [0x577590, 0x46403a, 0x3a3340],
    hair: ['bun', 'bob', 'coils'],
    head: ['none', 'sunHat', 'none'],
    prop: 'tote',
    height: 1.52,
    build: 1.06,
    energy: 0.2,
    apron: false,
  },
  muralist: {
    shirt: [0x2a2a33, 0x06a77d, 0xf3e7d3, 0x1f2430],
    accent: [0xf2b134, 0xef476f, 0x2fa8a0],
    legwear: 'jeans',
    legColor: [...DENIM],
    hair: ['locs', 'afro', 'crop', 'braids'],
    head: ['cap', 'bandana', 'none', 'bucket'],
    prop: 'sprayBag',
    height: 1.74,
    build: 1.02,
    energy: 0.55,
    apron: false,
  },
  surfer: {
    shirt: [0x2fa8a0, 0xfaf6ee, 0xffd166, 0x8bc34a],
    accent: [0x06a77d, 0x4c8bf5, 0xf2b134],
    legwear: 'boardshorts',
    legColor: [0x4c8bf5, 0x06a77d, 0xef476f, 0xffd166],
    hair: ['wavy', 'bun', 'coils', 'crop'],
    head: ['none', 'cap', 'none', 'bandana'],
    prop: 'surfboard',
    height: 1.79,
    build: 1.0,
    energy: 0.9,
    apron: false,
  },
  'tour-guide': {
    shirt: [0xfaf6ee, 0xdfe9f2, 0xffd166],
    accent: [0x1d3557, 0x577590, 0xe4572e],
    legwear: 'slacks',
    legColor: [0x46403a, 0x2f4560, 0xd6c7a6],
    hair: ['bun', 'braids', 'bob', 'coils'],
    head: ['sunHat', 'none', 'none'],
    prop: 'clipboard',
    height: 1.65,
    build: 1.0,
    energy: 0.4,
    apron: false,
  },
  'first-timer': {
    shirt: [0x8bc34a, 0xdfe9f2, 0xfaf6ee, 0xf3e7d3],
    accent: [0x4c8bf5, 0x2a2a33, 0x8bc34a],
    legwear: 'shorts',
    legColor: [...KHAKI],
    hair: ['crop', 'wavy', 'coils', 'afro'],
    head: ['none', 'cap', 'none'],
    prop: 'backpack',
    height: 1.78,
    build: 0.96,
    energy: 0.5,
    apron: false,
  },
  'salsa-dancer': {
    shirt: [0xf05d8f, 0xef476f, 0xfaf6ee, 0xffd166],
    accent: [0xf2b134, 0xa663cc, 0xfaf6ee],
    legwear: 'skirt',
    legColor: [0x2a2a33, 0xf05d8f, 0x1f2430],
    hair: ['bun', 'ponytail', 'afro', 'braids'],
    head: ['none', 'none', 'headwrap'],
    prop: 'tote',
    height: 1.68,
    build: 0.98,
    energy: 1,
    apron: false,
  },
  'trap-artist': {
    shirt: [0x1f2430, 0x2a2a33, 0x577590, 0xef476f],
    accent: [0xffd166, 0xf05d8f, 0x06a77d],
    legwear: 'jeans',
    legColor: [0x1f2430, 0x2f4560, 0x2a2a33],
    hair: ['braids', 'locs', 'coils', 'crop'],
    head: ['bucket', 'cap', 'none', 'bandana'],
    prop: 'backpack',
    height: 1.75,
    build: 1.04,
    energy: 0.75,
    apron: false,
  },
};

const FALLBACK_VISUAL: ArchetypeVisual = {
  shirt: [...COTTON],
  accent: [...BRIGHT],
  legwear: 'jeans',
  legColor: [...DENIM],
  hair: ['crop', 'coils', 'wavy', 'afro'],
  head: ['none', 'cap'],
  prop: 'none',
  height: 1.72,
  build: 1,
  energy: 0.5,
  apron: false,
};

export function visualFor(id: string): ArchetypeVisual {
  return ARCHETYPE_VISUALS[id] ?? FALLBACK_VISUAL;
}

/* ---------------------------------------------------------------- routing */

export const ARCHETYPE_ROUTING: Readonly<Record<string, ArchetypeRouting>> = {
  'bomba-drummer': {
    destKinds: ['venue', 'plaza', 'market'],
    minRoute: 120,
    maxRoute: 460,
    spawnWeight: 1.15,
  },
  'bakery-owner': {
    destKinds: ['chapel', 'venue', 'plaza', 'cafe'],
    minRoute: 130,
    maxRoute: 420,
    spawnWeight: 0.8,
  },
  'cruise-guest': {
    destKinds: ['dock', 'market', 'plaza'],
    minRoute: 150,
    maxRoute: 560,
    spawnWeight: 1.1,
  },
  abuela: {
    destKinds: ['chapel', 'market', 'plaza', 'cafe'],
    minRoute: 90,
    maxRoute: 300,
    spawnWeight: 1,
  },
  muralist: {
    destKinds: ['gallery', 'rooftop', 'plaza', 'lookout'],
    minRoute: 120,
    maxRoute: 480,
    spawnWeight: 1,
  },
  surfer: {
    destKinds: ['beach', 'lookout', 'dock'],
    minRoute: 160,
    maxRoute: 620,
    spawnWeight: 0.95,
  },
  'tour-guide': {
    destKinds: ['fort', 'lookout', 'plaza', 'chapel'],
    minRoute: 140,
    maxRoute: 520,
    spawnWeight: 1,
  },
  'first-timer': {
    destKinds: ['cafe', 'plaza', 'market', 'bakery'],
    minRoute: 90,
    maxRoute: 320,
    spawnWeight: 1.05,
  },
  'salsa-dancer': {
    destKinds: ['venue', 'plaza', 'rooftop'],
    minRoute: 120,
    maxRoute: 440,
    spawnWeight: 1,
  },
  'trap-artist': {
    destKinds: ['rooftop', 'venue', 'gallery', 'lookout'],
    minRoute: 150,
    maxRoute: 520,
    spawnWeight: 1.05,
  },
};

const FALLBACK_ROUTING: ArchetypeRouting = {
  destKinds: ['plaza', 'cafe', 'market'],
  minRoute: 100,
  maxRoute: 400,
  spawnWeight: 1,
};

export function routingFor(id: string): ArchetypeRouting {
  return ARCHETYPE_ROUTING[id] ?? FALLBACK_ROUTING;
}

/* ------------------------------------------------------------- skin tones */

/**
 * A continuous melanin ramp, not three presets (ART_REFERENCE §7.2). Sampled
 * uniformly per passenger variant so no archetype maps to a tone.
 */
export const SKIN_RAMP: readonly number[] = [
  0x38210f, 0x4b2d16, 0x60391c, 0x774924, 0x8c5a2f, 0xa16e3d, 0xb4844e, 0xc59a63,
  0xd3ae7c, 0xdfc094, 0xe9cfab, 0xf1dcc0,
];

/** Undertone shift so the ramp is not a single hue slide. */
const SKIN_UNDERTONE: readonly number[] = [
  0x02010a, 0x000004, 0x030100, 0x000200, 0x040100, 0x000003, 0x030200, 0x000104,
  0x040200, 0x000103, 0x030300, 0x000205,
];

const rgb = (hex: number): [number, number, number] => [
  (hex >> 16) & 0xff,
  (hex >> 8) & 0xff,
  hex & 0xff,
];

/** `t` in 0..1 → a hex colour anywhere along the continuous ramp. */
export function skinToneAt(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const f = x * (SKIN_RAMP.length - 1);
  const i = Math.min(SKIN_RAMP.length - 2, Math.floor(f));
  const k = f - i;
  const a = rgb(SKIN_RAMP[i]);
  const b = rgb(SKIN_RAMP[i + 1]);
  const ua = rgb(SKIN_UNDERTONE[i]);
  const ub = rgb(SKIN_UNDERTONE[i + 1]);
  let out = 0;
  for (let c = 0; c < 3; c++) {
    const v = a[c] + (b[c] - a[c]) * k + (ua[c] + (ub[c] - ua[c]) * k);
    out = (out << 8) | Math.max(0, Math.min(255, Math.round(v)));
  }
  return out >>> 0;
}

/** Natural hair colours plus the two dyed shades you actually see downtown. */
export const HAIR_COLORS: readonly number[] = [
  0x0f0b09, 0x18110d, 0x241811, 0x33231a, 0x4a2f1d, 0x63401f, 0x8a6136, 0xa8874c,
  0x7d7168, 0xb9b2a6, 0xe2ded4, 0x8d2f4f, 0x2c4a7a,
];

/** Elders read as elders — grey/white shades live at the tail of the list. */
export const GREY_HAIR_COLORS: readonly number[] = [0x7d7168, 0xb9b2a6, 0xe2ded4, 0xcfc9bd];

/* ---------------------------------------------------------------- picking */

/** Deterministic variant count per archetype — bounds the geometry cache. */
export const VARIANTS_PER_ARCHETYPE = 8;

const WEIGHTS: readonly number[] = ARCHETYPES.map((a) => routingFor(a.id).spawnWeight);

/**
 * Weighted archetype pick that avoids repeating whatever is already out on the
 * street, so the player meets the whole cast rather than three of Doña Carmen.
 */
export function pickArchetype(rng: RNG, exclude?: ReadonlySet<string>): PassengerArchetype {
  if (!exclude || exclude.size === 0) return rng.weighted(ARCHETYPES, WEIGHTS);
  let total = 0;
  for (let i = 0; i < ARCHETYPES.length; i++) {
    if (!exclude.has(ARCHETYPES[i].id)) total += WEIGHTS[i];
  }
  if (total <= 0) return rng.weighted(ARCHETYPES, WEIGHTS);
  let r = rng.next() * total;
  for (let i = 0; i < ARCHETYPES.length; i++) {
    if (exclude.has(ARCHETYPES[i].id)) continue;
    r -= WEIGHTS[i];
    if (r <= 0) return ARCHETYPES[i];
  }
  return ARCHETYPES[ARCHETYPES.length - 1];
}
