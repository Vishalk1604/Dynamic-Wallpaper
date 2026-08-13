/**
 * User settings, shared between the main process, the settings window and the wallpaper panes.
 *
 * Everything here is a multiplier or a plain value rather than a raw simulation constant, so the
 * tuned defaults in the simulation stay the single source of truth for what the wallpaper looks like
 * and these only scale it.
 */
import { DEFAULT_THEME_ID } from "./themes";

export type Settings = {
  themeId: string;
  /** Scales particle counts. 1 is the tuned default. */
  density: number;
  /** Scales blob radius. */
  size: number;
  /** Scales particle sprite size. */
  particleScale: number;
  /** Scales overall brightness. */
  brightness: number;
  /** Scales how fast particles travel along the stream between screens. */
  streamSpeed: number;
  /** Scales the drift speed within each blob. */
  motion: number;
  /** Suspend rendering entirely. */
  paused: boolean;
  /** Launch at sign-in. */
  autoStart: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  themeId: DEFAULT_THEME_ID,
  density: 1,
  size: 1,
  particleScale: 1,
  brightness: 1,
  streamSpeed: 1,
  motion: 1,
  paused: false,
  autoStart: false,
};

/** Allowed range for each numeric setting, also used to build the sliders. */
export const SETTING_RANGES = {
  density: { min: 0.2, max: 2.5, step: 0.05, label: "Density" },
  size: { min: 0.4, max: 2.2, step: 0.05, label: "Blob size" },
  particleScale: { min: 0.4, max: 2.5, step: 0.05, label: "Particle size" },
  brightness: { min: 0.3, max: 2.5, step: 0.05, label: "Brightness" },
  streamSpeed: { min: 0.2, max: 3, step: 0.05, label: "Stream speed" },
  motion: { min: 0, max: 3, step: 0.05, label: "Motion" },
} as const;

export type NumericSetting = keyof typeof SETTING_RANGES;

function clampNumber(value: unknown, key: NumericSetting): number {
  const range = SETTING_RANGES[key];
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SETTINGS[key];
  return Math.min(range.max, Math.max(range.min, n));
}

/**
 * Coerce anything into valid settings.
 *
 * Applied to whatever is read from disk, which may be from an older version, hand-edited, or
 * corrupt — a wallpaper that refuses to start because of a bad settings file would be a poor trade.
 */
export function normaliseSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    themeId: typeof raw.themeId === "string" ? raw.themeId : DEFAULT_SETTINGS.themeId,
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
