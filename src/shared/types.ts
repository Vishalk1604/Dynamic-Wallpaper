export type Bounds = { x: number; y: number; width: number; height: number };

export type DisplayInfo = {
  id: number;
  label: string;
  /** Physical-pixel bounds in virtual-desktop coordinates. Negative when left of / above primary. */
  bounds: Bounds;
  /** DIP bounds, needed when talking back to Electron's window APIs. */
  dipBounds: Bounds;
  rotation: number;
  scaleFactor: number;
  internal: boolean;
  primary: boolean;
};

import type { Settings } from "./settings";

export type Layout = {
  displays: DisplayInfo[];
  /** Bounding box of all displays, in physical pixels. */
  virtualBounds: Bounds;
};

/**
 * What each pane is told about itself and the simulation.
 *
 * `seed` and `epochMs` are shared by every pane so they can run the same deterministic simulation
 * independently: each derives the same tick count from wall-clock time, with no per-frame IPC, which
 * is what lets a particle cross a bezel without jumping.
 */
export type SurfacePayload = {
  layout: Layout;
  /** Region of virtual-desktop space this pane covers, in physical pixels. */
  region: Bounds;
  seed: number;
  epochMs: number;
  /** Show the diagnostics overlay. Off for the shipped wallpaper. */
  hud: boolean;
  settings: Settings;
};
