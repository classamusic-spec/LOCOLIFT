import type { GameMode } from '../core/types';

const KEY = 'locolift.save.v1';

export interface JeepCustomization {
  bodyColor: number;
  accentColor: number;
  /** livery pattern id */
  livery: string;
  /** rim style id */
  rims: string;
  /** roof-rack / light-bar / snorkel etc. */
  accessories: string[];
  hornId: string;
  /** underglow colour, or -1 for off */
  underglow: number;
}

export interface SaveData {
  version: 1;
  /** total cash banked across every shift */
  bank: number;
  bestScore: Partial<Record<GameMode, number>>;
  bestFares: number;
  totalFares: number;
  totalDistance: number;
  longestDrift: number;
  longestAirtime: number;
  biggestCombo: number;
  /** ids of unlocked customization parts */
  unlocked: string[];
  jeep: JeepCustomization;
  /** completed story mission ids */
  storyComplete: string[];
  /** best times / scores per challenge id */
  challengeBest: Record<string, number>;
  /** passenger archetype ids the player has driven at least once */
  metPassengers: string[];
  playtimeSeconds: number;
  seenIntro: boolean;
}

export const DEFAULT_JEEP: JeepCustomization = {
  bodyColor: 0xf2b134,
  accentColor: 0x2fa8a0,
  livery: 'classic',
  rims: 'steel',
  accessories: ['lightbar', 'snorkel', 'spare'],
  hornId: 'clave',
  underglow: -1,
};

const DEFAULT_SAVE: SaveData = {
  version: 1,
  bank: 0,
  bestScore: {},
  bestFares: 0,
  totalFares: 0,
  totalDistance: 0,
  longestDrift: 0,
  longestAirtime: 0,
  biggestCombo: 0,
  unlocked: ['classic', 'steel', 'lightbar', 'snorkel', 'spare', 'clave'],
  jeep: { ...DEFAULT_JEEP },
  storyComplete: [],
  challengeBest: {},
  metPassengers: [],
  playtimeSeconds: 0,
  seenIntro: false,
};

/**
 * localStorage-backed progression. Writes are debounced — a shift ending fires
 * several record updates at once and we only want one serialize.
 */
export class SaveSystem {
  private data: SaveData;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.data = this.load();
    // Persist on the way out so a mid-shift tab close doesn't lose progress.
    window.addEventListener('pagehide', this.flushNow);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.flushNow();
    });
  }

  get current(): Readonly<SaveData> {
    return this.data;
  }

  /** Mutate through here so persistence stays automatic. */
  update(fn: (d: SaveData) => void): void {
    fn(this.data);
    this.markDirty();
  }

  /** Record a value only if it beats what's stored. Returns true on a new record. */
  record(key: 'longestDrift' | 'longestAirtime' | 'biggestCombo' | 'bestFares', value: number): boolean {
    if (value <= this.data[key]) return false;
    this.data[key] = value;
    this.markDirty();
    return true;
  }

  recordScore(mode: GameMode, score: number): boolean {
    const best = this.data.bestScore[mode] ?? 0;
    if (score <= best) return false;
    this.data.bestScore[mode] = score;
    this.markDirty();
    return true;
  }

  isUnlocked(id: string): boolean {
    return this.data.unlocked.includes(id);
  }

  unlock(id: string): boolean {
    if (this.data.unlocked.includes(id)) return false;
    this.data.unlocked.push(id);
    this.markDirty();
    return true;
  }

  addBank(amount: number): void {
    this.data.bank = Math.max(0, this.data.bank + amount);
    this.markDirty();
  }

  spend(amount: number): boolean {
    if (this.data.bank < amount) return false;
    this.data.bank -= amount;
    this.markDirty();
    return true;
  }

  setJeep(partial: Partial<JeepCustomization>): void {
    this.data.jeep = { ...this.data.jeep, ...partial };
    this.markDirty();
  }

  reset(): void {
    this.data = structuredClone(DEFAULT_SAVE);
    this.flushNow();
  }

  export(): string {
    return btoa(JSON.stringify(this.data));
  }

  import(encoded: string): boolean {
    try {
      const parsed: unknown = JSON.parse(atob(encoded));
      if (!isSaveData(parsed)) return false;
      this.data = migrate(parsed);
      this.flushNow();
      return true;
    } catch {
      return false;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, 1200);
  }

  private flushNow = (): void => {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* quota or private mode — progression just won't survive the session */
    }
  };

  private load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT_SAVE);
      const parsed: unknown = JSON.parse(raw);
      if (!isSaveData(parsed)) return structuredClone(DEFAULT_SAVE);
      return migrate(parsed);
    } catch {
      return structuredClone(DEFAULT_SAVE);
    }
  }
}

function isSaveData(v: unknown): v is SaveData {
  return typeof v === 'object' && v !== null && 'version' in v;
}

/** Fill in anything a newer build added, so old saves keep working. */
function migrate(raw: SaveData): SaveData {
  const merged: SaveData = { ...structuredClone(DEFAULT_SAVE), ...raw, version: 1 };
  merged.jeep = { ...DEFAULT_JEEP, ...(raw.jeep ?? {}) };
  merged.unlocked = Array.from(new Set([...DEFAULT_SAVE.unlocked, ...(raw.unlocked ?? [])]));
  merged.bestScore = { ...(raw.bestScore ?? {}) };
  merged.challengeBest = { ...(raw.challengeBest ?? {}) };
  return merged;
}
