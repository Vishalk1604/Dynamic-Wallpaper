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

export type Layout = {
  displays: DisplayInfo[];
  /** Bounding box of all displays, in physical pixels. */
  virtualBounds: Bounds;
};
