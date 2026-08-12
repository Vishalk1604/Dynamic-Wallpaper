/**
 * Phase 1 probe renderer.
 *
 * Deliberately not the real visual yet — this exists to answer one question: is the window
 * actually covering the whole monitor, on the wallpaper layer, at the right coordinates?
 * The edge rules and corner brackets make clipping or misplacement obvious at a glance.
 *
 * Replaced by the particle simulation in Phase 3.
 */
import type { DisplayInfo } from "@shared/types";

type WallpaperBridge = {
  onDisplay: (callback: (display: DisplayInfo) => void) => void;
};

const bridge = (globalThis as unknown as { wallpaper: WallpaperBridge }).wallpaper;

/** Stable, well-separated hues so each monitor is instantly distinguishable. */
function hueFor(id: number): number {
  return (Math.abs(id) * 47) % 360;
}

const labelEl = document.getElementById("label")!;
const detailEl = document.getElementById("detail")!;
const pulseEl = document.getElementById("pulse")!;
const probeEl = document.getElementById("probe")!;

let current: DisplayInfo | null = null;

function render(): void {
  if (!current) return;

  const hue = hueFor(current.id);

  // Solid saturated fill, not a dark gradient: this machine's desktop is a black wallpaper with
  // icons hidden, so anything dark is indistinguishable from "not drawing at all".
  probeEl.style.color = "#000";
  document.body.style.background = `hsl(${hue} 85% 45%)`;
  pulseEl.style.background = "#000";

  const b = current.bounds;
  const expected = `${b.width}x${b.height}`;
  const actual = `${Math.round(window.innerWidth * window.devicePixelRatio)}x${Math.round(
    window.innerHeight * window.devicePixelRatio,
  )}`;
  const covers = expected === actual;

  labelEl.textContent = `${current.label}${current.primary ? "  (primary)" : ""}`;
  detailEl.textContent = [
    `virtual position   ${b.x}, ${b.y}`,
    `expected physical  ${expected}`,
    `actual physical    ${actual}   ${covers ? "MATCH" : "MISMATCH"}`,
    `rotation           ${current.rotation}°`,
    `scale factor       ${current.scaleFactor}   dpr ${window.devicePixelRatio}`,
    `panel              ${current.internal ? "internal" : "external"}`,
  ].join("\n");

  detailEl.style.color = covers ? "#000" : "#ff3b30";
}

bridge.onDisplay((display) => {
  current = display;
  render();
});

// Keep the readout honest if Windows resizes us after a display change.
window.addEventListener("resize", render);
