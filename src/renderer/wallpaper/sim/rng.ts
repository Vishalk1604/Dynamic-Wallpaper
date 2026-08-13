/**
 * mulberry32 — small, fast, seedable PRNG.
 *
 * `Math.random` cannot be used anywhere in the simulation: every pane runs the same simulation
 * independently and they must agree bit for bit, so all randomness has to come from a shared seed.
 */
export type Random = {
  /** Uniform in [0, 1). */
  next: () => number;
  /** Uniform in [min, max). */
  range: (min: number, max: number) => number;
  /** Uniformly distributed point on the unit sphere. */
  onSphere: (out: [number, number, number]) => void;
};

export function createRandom(seed: number): Random {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + next() * (max - min);

  /**
   * Sampling z uniformly and taking the matching latitude gives an even distribution over the
   * sphere; picking two independent angles instead would bunch points at the poles and make the
   * blob look denser top and bottom.
   */
  const onSphere = (out: [number, number, number]): void => {
    const z = next() * 2 - 1;
    const theta = next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out[0] = r * Math.cos(theta);
    out[1] = r * Math.sin(theta);
    out[2] = z;
  };

  return { next, range, onSphere };
}
