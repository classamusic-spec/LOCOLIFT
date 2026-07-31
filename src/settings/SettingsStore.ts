import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../core/Config';
import type { QualityTier, SettingsState } from '../core/types';
import { clamp } from '../core/MathUtils';

const KEY = 'locolift.settings.v1';

type Listener = (s: SettingsState) => void;

/**
 * Persisted, validated settings. Everything reads the frozen snapshot from
 * `current`; writes go through `set`/`setQuality`, which notify listeners so
 * the engine can re-apply renderer state.
 */
export class SettingsStore {
  private state: SettingsState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = { ...DEFAULT_SETTINGS, ...this.load() };
    this.state = sanitize(this.state);
  }

  get current(): SettingsState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
    if (this.state[key] === value) return;
    this.state = sanitize({ ...this.state, [key]: value });
    this.persist();
    this.notify();
  }

  patch(partial: Partial<SettingsState>): void {
    this.state = sanitize({ ...this.state, ...partial });
    this.persist();
    this.notify();
  }

  /** Applying a tier also stamps its preset over the derived render flags. */
  setQuality(tier: QualityTier): void {
    this.state = sanitize({ ...this.state, quality: tier, ...QUALITY_PRESETS[tier] });
    this.persist();
    this.notify();
  }

  reset(): void {
    this.state = { ...DEFAULT_SETTINGS };
    this.persist();
    this.notify();
  }

  /**
   * First-run guess so a weak device doesn't open on `high` and stutter.
   * Refined at runtime by the adaptive quality governor.
   */
  autoDetectQuality(renderer: { capabilities: { maxTextureSize: number } }): QualityTier {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const cores = navigator.hardwareConcurrency ?? 4;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    const maxTex = renderer.capabilities.maxTextureSize;

    if (mobile || cores <= 2 || mem <= 2 || maxTex < 4096) return 'low';
    if (cores <= 4 || mem <= 4) return 'medium';
    if (cores >= 12 && mem >= 8) return 'ultra';
    return 'high';
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (err) {
        console.error('[SettingsStore] listener threw:', err);
      }
    }
  }

  private load(): Partial<SettingsState> {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<SettingsState>) : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* private browsing / quota — settings just won't persist */
    }
  }
}

/** Clamp every numeric field and reject unknown enum values. */
function sanitize(s: SettingsState): SettingsState {
  const tiers: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
  return {
    ...s,
    quality: tiers.includes(s.quality) ? s.quality : 'high',
    renderScale: clamp(num(s.renderScale, 1), 0.5, 1),
    masterVolume: clamp(num(s.masterVolume, 0.9), 0, 1),
    musicVolume: clamp(num(s.musicVolume, 0.55), 0, 1),
    sfxVolume: clamp(num(s.sfxVolume, 0.85), 0, 1),
    screenShake: clamp(num(s.screenShake, 1), 0, 1),
    cameraSway: clamp(num(s.cameraSway, 1), 0, 1),
    assistSteering: clamp(num(s.assistSteering, 0.35), 0, 1),
    uiScale: clamp(num(s.uiScale, 1), 0.75, 1.5),
    colorBlindMode: (['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const).includes(
      s.colorBlindMode,
    )
      ? s.colorBlindMode
      : 'none',
    showSpeedUnits: s.showSpeedUnits === 'kmh' ? 'kmh' : 'mph',
  };
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
