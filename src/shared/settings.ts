/**
 * User settings, shared between the main process, the settings window and the wallpaper panes.
 *
 * Numeric values are multipliers rather than raw constants, so each theme's tuned defaults stay the
 * single source of truth for how it looks and these only scale it.
 */
import { DEFAULT_THEME_ID, defaultColourForIndex } from "./themes";

export type Settings = {
  /** Visual style. Colours are separate — see `colours`. */
  themeId: string;
  /** One `#rrggbb` per screen, indexed by display order. */
  colours: string[];
  /** Scales particle counts, or mist detail. */
  density: number;
  /** Scales blob radius. */
  size: number;
  /** Scales particle sprite size. Filament only. */
  particleScale: number;
  brightness: number;
  /** Scales flow speed between screens. */
  streamSpeed: number;
  /** Scales internal movement within each blob. */
  motion: number;
  paused: boolean;
  autoStart: boolean;
};

/** Enough entries that adding a monitor never leaves a blob without a colour. */
const DEFAULT_COLOUR_SLOTS = 6;

export const DEFAULT_SETTINGS: Settings = {
  themeId: DEFAULT_THEME_ID,
  colours: Array.from({ length: DEFAULT_COLOUR_SLOTS }, (_, i) => defaultColourForIndex(i)),
  density: 1,
  size: 1,
  particleScale: 1,
  brightness: 1,
  streamSpeed: 1,
  motion: 1,
  paused: false,
  autoStart: false,
};

export const SETTING_RANGES = {
  density: { min: 0.2, max: 2.5, step: 0.05, label: "Density" },
  size: { min: 0.4, max: 2.2, step: 0.05, label: "Blob size" },
  particleScale: { min: 0.4, max: 2.5, step: 0.05, label: "Particle size" },
  brightness: { min: 0.3, max: 2.5, step: 0.05, label: "Brightness" },
  streamSpeed: { min: 0.2, max: 3, step: 0.05, label: "Flow speed" },
  motion: { min: 0, max: 3, step: 0.05, label: "Motion" },
} as const;

export type NumericSetting = keyof typeof SETTING_RANGES;

function clampNumber(value: unknown, key: NumericSetting): number {
  const range = SETTING_RANGES[key];
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SETTINGS[key];
  return Math.min(range.max, Math.max(range.min, n));
}

const HEX = /^#[0-9a-f]{6}$/i;

function normaliseColours(value: unknown): string[] {
  const input = Array.isArray(value) ? value : [];
  return Array.from({ length: DEFAULT_COLOUR_SLOTS }, (_, i) => {
    const entry = input[i];
    return typeof entry === "string" && HEX.test(entry.trim())
      ? entry.trim().toLowerCase()
      : defaultColourForIndex(i);
  });
}

/**
 * Coerce anything into valid settings.
 *
 * Applied to whatever is read from disk, which may be from an older version, hand-edited or corrupt.
 * A wallpaper that refuses to start because of a bad settings file would be a poor trade.
 */
export function normaliseSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    themeId: typeof raw.themeId === "string" ? raw.themeId : DEFAULT_SETTINGS.themeId,
    colours: normaliseColours(raw.colours),
    density: clampNumber(raw.density, "density"),
    size: clampNumber(raw.size, "size"),
    particleScale: clampNumber(raw.particleScale, "particleScale"),
    brightness: clampNumber(raw.brightness, "brightness"),
    streamSpeed: clampNumber(raw.streamSpeed, "streamSpeed"),
    motion: clampNumber(raw.motion, "motion"),
    paused: raw.paused === true,
    autoStart: raw.autoStart === true,
  };
}
