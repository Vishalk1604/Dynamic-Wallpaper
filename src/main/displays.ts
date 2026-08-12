/**
 * Display topology in *physical* pixels.
 *
 * Electron's screen API reports DIP coordinates, which only match physical pixels while every
 * monitor is at 100% scaling. Converting through `dipToScreenRect` keeps the simulation's world
 * space correct if a monitor is later set to 125% or 150%.
 *
 * Windows already reports rotated bounds — a portrait monitor comes back as 1080x1920 — so
 * orientation needs no special handling beyond reading the bounds.
 */
import { screen, type Display } from "electron";
import type { Bounds, DisplayInfo, Layout } from "@shared/types";

export type { Bounds, DisplayInfo, Layout };

function toPhysical(dip: Bounds): Bounds {
  const r = screen.dipToScreenRect(null, dip);
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function describe(display: Display, primaryId: number): DisplayInfo {
  const dipBounds: Bounds = { ...display.bounds };
  return {
    id: display.id,
    label: display.label || `Display ${display.id}`,
    bounds: toPhysical(dipBounds),
    dipBounds,
    rotation: display.rotation,
    scaleFactor: display.scaleFactor,
    internal: display.internal,
    primary: display.id === primaryId,
  };
}

function boundingBox(list: Bounds[]): Bounds {
  if (list.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...list.map((b) => b.x));
  const top = Math.min(...list.map((b) => b.y));
  const right = Math.max(...list.map((b) => b.x + b.width));
  const bottom = Math.max(...list.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function getLayout(): Layout {
  const primaryId = screen.getPrimaryDisplay().id;
  const displays = screen
    .getAllDisplays()
    .map((d) => describe(d, primaryId))
    // Stable order so particle seeding and well indices don't shuffle between runs.
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id);

  return { displays, virtualBounds: boundingBox(displays.map((d) => d.bounds)) };
}

export function describeLayout(layout: Layout): string {
  const parts = layout.displays.map(
    (d) =>
      `${d.label}${d.primary ? "*" : ""} ${d.bounds.width}x${d.bounds.height} ` +
      `@${d.bounds.x},${d.bounds.y} rot=${d.rotation} scale=${d.scaleFactor}`,
  );
  const v = layout.virtualBounds;
  return `[${v.width}x${v.height} @${v.x},${v.y}] ${parts.join(" | ")}`;
}

export function layoutsEqual(a: Layout, b: Layout): boolean {
  if (a.displays.length !== b.displays.length) return false;
  return a.displays.every((d, i) => {
    const o = b.displays[i];
    return (
      d.id === o.id &&
      d.bounds.x === o.bounds.x &&
      d.bounds.y === o.bounds.y &&
      d.bounds.width === o.bounds.width &&
      d.bounds.height === o.bounds.height &&
      d.rotation === o.rotation &&
      d.scaleFactor === o.scaleFactor &&
      d.primary === o.primary
    );
  });
}

/**
 * Subscribe to display changes. Windows fires several events for a single change in the
 * Settings app, so changes are debounced and then diffed before the callback runs.
 */
export function onLayoutChange(callback: (layout: Layout) => void, debounceMs = 250): () => void {
  let timer: NodeJS.Timeout | null = null;
  let lastLayout = getLayout();

  const handler = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const next = getLayout();
      if (layoutsEqual(lastLayout, next)) return;
      lastLayout = next;
      callback(next);
    }, debounceMs);
  };

  screen.on("display-added", handler);
  screen.on("display-removed", handler);
  screen.on("display-metrics-changed", handler);

  return () => {
    if (timer) clearTimeout(timer);
    screen.off("display-added", handler);
    screen.off("display-removed", handler);
    screen.off("display-metrics-changed", handler);
  };
}
