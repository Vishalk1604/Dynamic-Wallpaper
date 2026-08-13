/**
 * One colour per screen, assigned by position in the display ordering (which `getLayout` keeps
 * stable), so a given monitor keeps its colour across restarts.
 *
 * Chosen for additive blending and bloom: mid-to-high saturation with plenty of headroom, since
 * additive overlap drives the dense core of each blob toward white on its own. Fully saturated
 * primaries clip to flat colour instead of glowing.
 */
export type Rgb = readonly [number, number, number];

export const BLOB_COLOURS: readonly Rgb[] = [
  [0.13, 0.83, 0.93], // cyan
  [1.0, 0.54, 0.24], // amber
  [0.96, 0.45, 0.71], // magenta
  [0.64, 0.9, 0.21], // lime
  [0.65, 0.55, 0.98], // violet
  [0.99, 0.86, 0.28], // gold
];

export function colourForIndex(index: number): Rgb {
  return BLOB_COLOURS[((index % BLOB_COLOURS.length) + BLOB_COLOURS.length) % BLOB_COLOURS.length];
}
