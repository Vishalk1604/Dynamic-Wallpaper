/**
 * Broadcasts the cursor position to the wallpaper panes.
 *
 * The panes cannot listen for mouse events themselves. They carry WS_EX_TRANSPARENT so that hit
 * testing skips them and clicks land on the desktop underneath, which is exactly what stops the
 * wallpaper from swallowing desktop interaction — and the same flag means no mouse event ever
 * reaches them. Polling the OS for the cursor observes it without capturing anything.
 *
 * Coordinates come back in virtual-desktop physical pixels, matching the wallpaper's world space.
 */
import type { BrowserWindow } from "electron";
import { getCursorPos } from "./native/win32";

/**
 * Poll interval. Fast enough to feel attached to the cursor, and the renderer smooths between
 * samples anyway, so there is nothing to gain from going faster.
 */
const INTERVAL_MS = 1000 / 60;

export type PointerPayload = { x: number; y: number };

export class PointerTracker {
  private timer: NodeJS.Timeout | null = null;
  private targets: BrowserWindow[] = [];
  private last: PointerPayload | null = null;

  setTargets(windows: BrowserWindow[]): void {
    this.targets = windows;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  private tick(): void {
    const position = getCursorPos();
    if (!position) return;

    // Skip the send when the cursor has not moved. A stationary cursor is the common case, and this
    // keeps an idle machine from doing IPC sixty times a second for no reason.
    if (this.last && this.last.x === position.x && this.last.y === position.y) return;
    this.last = position;

    for (const window of this.targets) {
      if (window.isDestroyed()) continue;
      window.webContents.send("wallpaper:pointer", position);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.targets = [];
  }
}
