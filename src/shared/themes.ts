/**
 * Themes are visual *styles* — how the wallpaper is drawn — not colour palettes.
 *
 * Colour is a separate, per-blob setting, because wanting the mist look and wanting a particular
 * pair of colours are independent choices and tying them together made both harder to express.
 */
export type Rgb = readonly [number, number, number];

export type ThemeId = "filament" | "aether";

export type Theme = {
  id: ThemeId;
  name: string;
  description: string;
  /** Numeric settings that have no meaning for this style, hidden in the settings window. */
  ignores: readonly string[];
};

export const THEMES: readonly Theme[] = [
  {
    id: "filament",
    name: "Filament",
    description: "Hollow shells of discrete particles, joined by a drifting stream",
    ignores: [],
  },
  {
    id: "aether",
    name: "Aether",
    description: "Volumetric liquid mist, thick and thin, flowing between screens",
    ignores: ["particleScale"],
  },
];

export const DEFAULT_THEME_ID: ThemeId = "filament";

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/**
 * Default colour per screen, by display order — which `getLayout` keeps stable, so a monitor keeps
 * its colour across restarts. Chosen for additive blending: saturated enough to read as a hue, with
 * headroom so overlap brightens toward white instead of clipping to flat colour.
 */
export const DEFAULT_COLOURS: readonly string[] = [
  "#22d3ee",
  "#ff8a3d",
  "#f472b6",
  "#a3e635",
  "#a78bfa",
  "#fbbf24",
];

export function defaultColourForIndex(index: number): string {
  const list = DEFAULT_COLOURS;
  return list[((index % list.length) + list.length) % list.length];
}

/** Parse `#rrggbb` into linear-ish 0..1 components. Falls back to white on anything unparseable. */
export function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [1, 1, 1];
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function rgbToHex(rgb: Rgb): string {
  const to255 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${((to255(rgb[0]) << 16) | (to255(rgb[1]) << 8) | to255(rgb[2])).toString(16).padStart(6, "0")}`;
}
