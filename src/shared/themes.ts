/**
 * Colour themes. A theme is an ordered list of colours assigned to screens by display order, which
 * `getLayout` keeps stable, so a given monitor keeps its colour across restarts.
 *
 * Colours are chosen for additive blending: mid-to-high saturation with headroom, since overlap
 * drives the dense parts of a blob toward white on its own. Fully saturated primaries clip to flat
 * colour instead of glowing.
 */
export type Rgb = readonly [number, number, number];

export type Theme = {
  id: string;
  name: string;
  description: string;
  colours: readonly Rgb[];
};

export const THEMES: readonly Theme[] = [
  {
    id: "aurora",
    name: "Aurora",
    description: "Cyan and amber, complementary and high contrast",
    colours: [
      [0.13, 0.83, 0.93],
      [1.0, 0.54, 0.24],
      [0.96, 0.45, 0.71],
      [0.64, 0.9, 0.21],
      [0.65, 0.55, 0.98],
      [0.99, 0.86, 0.28],
    ],
  },
  {
    id: "ember",
    name: "Ember",
    description: "Warm oranges and reds, matches warm desk lighting",
    colours: [
      [1.0, 0.45, 0.15],
      [0.98, 0.78, 0.24],
      [0.92, 0.24, 0.2],
      [1.0, 0.62, 0.4],
      [0.85, 0.35, 0.1],
      [1.0, 0.85, 0.55],
    ],
  },
  {
    id: "ion",
    name: "Ion",
    description: "Cool blues and teals, calm and low key",
    colours: [
      [0.25, 0.6, 1.0],
      [0.16, 0.88, 0.82],
      [0.45, 0.4, 0.95],
      [0.3, 0.78, 0.95],
      [0.6, 0.7, 1.0],
      [0.2, 0.95, 0.7],
    ],
  },
  {
    id: "bloom",
    name: "Bloom",
    description: "Pinks and violets",
    colours: [
      [0.98, 0.35, 0.66],
      [0.68, 0.45, 0.99],
      [0.99, 0.55, 0.85],
      [0.52, 0.35, 0.95],
      [1.0, 0.68, 0.78],
      [0.85, 0.3, 0.9],
    ],
  },
  {
    id: "signal",
    name: "Signal",
    description: "Red and green, as in the original demo",
    colours: [
      [1.0, 0.18, 0.16],
      [0.24, 0.95, 0.25],
      [1.0, 0.6, 0.15],
      [0.15, 0.85, 0.6],
      [0.95, 0.25, 0.5],
      [0.6, 0.95, 0.2],
    ],
  },
  {
    id: "mono",
    name: "Mono",
    description: "Cool white, understated",
    colours: [
      [0.85, 0.9, 1.0],
      [0.7, 0.78, 0.92],
      [0.95, 0.97, 1.0],
      [0.6, 0.68, 0.85],
      [0.8, 0.85, 0.95],
      [0.72, 0.8, 0.98],
    ],
  },
];

export const DEFAULT_THEME_ID = "aurora";

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function colourForIndex(theme: Theme, index: number): Rgb {
  const list = theme.colours;
  return list[((index % list.length) + list.length) % list.length];
}
