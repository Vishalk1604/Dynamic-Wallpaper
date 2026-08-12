/**
 * One borderless window per display, planted on the desktop wallpaper layer.
 *
 * Positioning is done with SetWindowPos in physical pixels rather than Electron's setBounds,
 * because once a window is reparented into WorkerW its coordinates are relative to that host's
 * client area and Electron's own bounds handling no longer describes where it will land.
 */
import { BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DisplayInfo, Layout } from "./displays";
import {
  attachToHost,
  detachChild,
  findWallpaperHost,
  isAttached,
  repositionChild,
  restoreDesktop,
  takeDiagnostics,
  type WallpaperHost,
} from "./native/desktopLayer";
import { toHandle } from "./native/win32";

export type WallpaperWindow = {
  displayId: number;
  window: BrowserWindow;
  hwnd: number;
};

const WATCHDOG_INTERVAL_MS = 2000;

/**
 * Diagnostic control: leave windows as ordinary top-level windows instead of planting them on the
 * desktop. Used to prove the screen-capture verification path works before trusting a negative
 * result from the attached case.
 */
const SKIP_ATTACH = process.env["DW_NO_ATTACH"] === "1";

export class WallpaperSurface {
  private host: WallpaperHost | null = null;
  private windows = new Map<number, WallpaperWindow>();
  private watchdog: NodeJS.Timeout | null = null;
  private layout: Layout | null = null;
  private disposed = false;

  /** Diagnostics from the most recent host probe, for the spike report and settings UI. */
  public lastProbe: string[] = [];

  get strategy(): string {
    return this.host?.strategy ?? "none";
  }

  get iconsPreserved(): boolean {
    return this.host?.iconsPreserved ?? false;
  }

  async apply(layout: Layout): Promise<void> {
    if (this.disposed) return;
    this.layout = layout;

    this.host = findWallpaperHost();
    this.lastProbe = takeDiagnostics();

    const wanted = new Set(layout.displays.map((d) => d.id));

    // Drop windows for displays that went away.
    for (const [id, entry] of this.windows) {
      if (!wanted.has(id)) {
        detachChild(entry.hwnd);
        entry.window.destroy();
        this.windows.delete(id);
      }
    }

    for (const display of layout.displays) {
      const existing = this.windows.get(display.id);
      if (existing) {
        repositionChild(existing.hwnd, this.host, display.bounds);
        existing.window.webContents.send("wallpaper:display", display);
      } else {
        await this.create(display);
      }
    }

    this.lastProbe.push(...takeDiagnostics());
    this.startWatchdog();
  }

  private async create(display: DisplayInfo): Promise<void> {
    const window = new BrowserWindow({
      // DIP placement decides which monitor Chromium associates the window with, and therefore
      // its devicePixelRatio. Physical placement is corrected by SetWindowPos after attaching.
      x: display.dipBounds.x,
      y: display.dipBounds.y,
      width: display.dipBounds.width,
      height: display.dipBounds.height,
      frame: false,
      transparent: false,
      backgroundColor: "#000000",
      show: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: join(__dirname, "../preload/wallpaper.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // A wallpaper must keep animating while unfocused, which is exactly what Chromium
        // throttles by default.
        backgroundThrottling: false,
      },
    });

    window.setIgnoreMouseEvents(true);
    window.setMenuBarVisibility(false);

    // Renderer failures are otherwise silent: the window just shows its opaque background colour,
    // which is indistinguishable from a black wallpaper.
    window.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      const tag = ["verbose", "info", "warning", "error"][level] ?? String(level);
      console.log(`[renderer ${display.id}] ${tag}: ${message} (${sourceId}:${line})`);
    });
    window.webContents.on("did-fail-load", (_e, code, description, url) => {
      console.error(`[renderer ${display.id}] did-fail-load ${code} ${description} ${url}`);
    });
    window.webContents.on("render-process-gone", (_e, details) => {
      console.error(`[renderer ${display.id}] render-process-gone`, details);
    });
    window.webContents.on("preload-error", (_e, path, error) => {
      console.error(`[renderer ${display.id}] preload-error ${path}`, error);
    });

    const hwnd = toHandle(window.getNativeWindowHandle());
    this.windows.set(display.id, { displayId: display.id, window, hwnd });

    const ready = new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve());
    });

    await this.load(window, display);
    await ready;

    window.webContents.send("wallpaper:display", display);

    if (this.host && !SKIP_ATTACH) attachToHost(hwnd, this.host, display.bounds);
    window.showInactive();
    // Re-assert placement: showing the window can nudge it back to its pre-attach position.
    if (this.host && !SKIP_ATTACH) repositionChild(hwnd, this.host, display.bounds);
  }

  private async load(window: BrowserWindow, display: DisplayInfo): Promise<void> {
    const query = `?displayId=${display.id}`;
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) {
      await window.loadURL(`${devUrl}/wallpaper/index.html${query}`);
    } else {
      await window.loadFile(join(__dirname, "../renderer/wallpaper/index.html"), {
        search: query.slice(1),
      });
    }
  }

  /**
   * Explorer restarts destroy WorkerW and orphan our windows, so re-probe and re-attach
   * whenever a window is no longer parented where we left it.
   */
  private startWatchdog(): void {
    if (this.watchdog) return;
    if (SKIP_ATTACH) return;
    this.watchdog = setInterval(() => {
      if (this.disposed || !this.host || !this.layout) return;

      const lost = [...this.windows.values()].some((entry) => !isAttached(entry.hwnd, this.host!));
      if (!lost) return;

      this.host = findWallpaperHost();
      takeDiagnostics();
      for (const display of this.layout.displays) {
        const entry = this.windows.get(display.id);
        if (entry) attachToHost(entry.hwnd, this.host, display.bounds);
      }
      takeDiagnostics();
    }, WATCHDOG_INTERVAL_MS);
  }

  /**
   * Render each wallpaper window offscreen through Chromium and write it to disk.
   * Desktop-layer content cannot be captured with GDI, so this is how we check what the renderer
   * is actually producing, independent of whether the shell is compositing it.
   */
  async captureAll(directory: string): Promise<string[]> {
    const written: string[] = [];
    for (const entry of this.windows.values()) {
      if (entry.window.isDestroyed()) continue;
      const image = await entry.window.webContents.capturePage();
      const path = join(directory, `capture-${entry.displayId}.png`);
      writeFileSync(path, image.toPNG());
      written.push(`${path} (${image.getSize().width}x${image.getSize().height})`);
    }
    return written;
  }

  broadcast(channel: string, payload: unknown): void {
    for (const entry of this.windows.values()) {
      if (!entry.window.isDestroyed()) entry.window.webContents.send(channel, payload);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;

    for (const entry of this.windows.values()) {
      detachChild(entry.hwnd);
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    this.windows.clear();
    restoreDesktop(this.host);
    this.host = null;
  }
}
