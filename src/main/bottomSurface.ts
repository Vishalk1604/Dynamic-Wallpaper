/**
 * The render surface, as a top-level window pinned to the bottom of the z-order.
 *
 * Windows 11 build 26200 leaves no working way to draw into the real wallpaper layer from a
 * Chromium process: reparenting into WorkerW stops Chromium compositing, and GDI painting into
 * WorkerW's or Progman's device context is silently discarded even though every call reports
 * success. Both findings are recorded in docs/desktop-layer-findings.md.
 *
 * What does work is an ordinary top-level window, so this keeps the window top-level — never
 * reparented — and makes it behave like wallpaper instead:
 *   - pinned to the bottom of the z-order, so every other window covers it
 *   - non-activatable, so clicking it never pulls focus from your work
 *   - absent from the taskbar and Alt+Tab
 *   - click-through, so the desktop underneath stays usable
 *
 * One window per monitor, not one spanning the virtual desktop. A spanning window was tried first,
 * since a single canvas would mean a single simulation and no cross-window coordination, but
 * Chromium clamps window size to a single monitor's work area: asking for 3000x1920 yielded a
 * 1920x1080 window, both at creation and via SetWindowPos. Per-monitor panes stay inside that limit
 * and are also correct when monitors differ in DPI.
 *
 * The consequence for Phase 3 is that a particle crossing a bezel must be drawn by whichever pane
 * it enters, so every pane will simulate the whole system deterministically and render only what
 * falls inside its own region.
 */
import { BrowserWindow } from "electron";
import { join } from "node:path";
import type { SurfacePayload } from "@shared/types";
import type { Bounds, DisplayInfo, Layout } from "./displays";
import { IconHost } from "./iconHost";
import {
  HWND_BOTTOM,
  IsWindow,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SetWindowPos,
  getWindowRect,
  makeToolWindow,
  toHandle,
} from "./native/win32";

/** How often the bottom-of-z-order position is re-asserted. */
const SINK_INTERVAL_MS = 1000;

/**
 * Whether to reparent Explorer's icon host into our pane so the wallpaper renders behind the icons.
 * Disabled unless explicitly requested: the icons stop being painted once the renderer's next frame
 * lands, so enabling it currently loses the icons rather than layering them.
 */
const ADOPT_ICON_HOST = process.env["DW_ADOPT_ICON_HOST"] === "1";

/** Diagnostics overlay in each pane. */
const SHOW_HUD = process.env["DW_HUD"] === "1";

type Pane = {
  displayId: number;
  window: BrowserWindow;
  hwnd: number;
  /** Region of the virtual desktop this pane renders, in physical pixels. */
  region: Bounds;
  primary: boolean;
};

export class BottomSurface {
  private panes: Pane[] = [];
  private sink: NodeJS.Timeout | null = null;
  private disposed = false;
  private paused = false;
  private readonly iconHost = new IconHost();

  /**
   * Shared across every pane, and deliberately fixed for the process lifetime: the panes each run
   * the whole simulation independently, and identical results require an identical seed and a common
   * time origin. Recreating panes after a display change must not reset these, or the blobs would
   * visibly jump.
   */
  private readonly seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  private readonly epochMs = Date.now();

  get paneCount(): number {
    return this.panes.length;
  }

  get iconsAdopted(): boolean {
    return this.iconHost.isAdopted;
  }

  async apply(layout: Layout): Promise<void> {
    if (this.disposed) return;

    // Panes are tied to geometry, so rebuild rather than trying to reconcile them. Releasing the
    // icon host first is mandatory: destroying a pane that owns it would destroy the desktop icons
    // along with it.
    this.iconHost.release();
    this.destroyPanes();

    for (const display of layout.displays) {
      await this.createPane(display, layout);
    }

    // Off by default. Adopting the icon host does render icons above the wallpaper, but only until
    // the renderer's next frame paints over them — within a second or two the icons are gone. Left
    // in place, opt-in, because the mechanism is sound and only the repaint race is unsolved.
    if (ADOPT_ICON_HOST) {
      const primary = this.panes.find((p) => p.primary);
      if (primary) {
        this.iconHost.adopt(primary.hwnd, primary.region, layout.virtualBounds);
      }
    }

    this.startSink();
  }

  private async createPane(display: DisplayInfo, layout: Layout): Promise<void> {
    const region = display.bounds;
    // Electron positions windows in DIP, and the display's own DIP bounds are exact.
    const dip = display.dipBounds;

    const window = new BrowserWindow({
      x: dip.x,
      y: dip.y,
      width: dip.width,
      height: dip.height,
      frame: false,
      transparent: false,
      backgroundColor: "#000000",
      show: false,
      skipTaskbar: true,
      focusable: false,
      // Deliberately resizable and movable. Chromium clamps a new window to the work area it
      // believes it belongs to, and `resizable: false` then pins min and max size to that clamped
      // value, so SetWindowPos can never grow the pane back to its monitor. The portrait ARZOPA came
      // out 1080x1080 instead of 1080x1920 because of exactly this. Nothing can actually drag it: it
      // is click-through and non-activatable.
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      // Required to place a window at negative virtual-desktop coordinates and to span monitors.
      enableLargerThanScreen: true,
      webPreferences: {
        preload: join(__dirname, "../preload/wallpaper.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    // The primary pane must accept mouse input, because the adopted icon host covers it entirely and
    // needs to receive clicks, selection drags and the desktop context menu. Other panes stay
    // click-through so they never intercept anything.
    window.setIgnoreMouseEvents(!display.primary);
    window.setMenuBarVisibility(false);
    // Keeps it out of Alt+Tab as well as the taskbar.
    window.setSkipTaskbar(true);

    window.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      const tag = ["verbose", "info", "warning", "error"][level] ?? String(level);
      console.log(`[renderer] ${tag}: ${message} (${sourceId}:${line})`);
    });
    window.webContents.on("did-fail-load", (_e, code, description, url) => {
      console.error(`[renderer] did-fail-load ${code} ${description} ${url}`);
    });
    window.webContents.on("render-process-gone", (_e, details) => {
      console.error("[renderer] render-process-gone", details);
    });

    const hwnd = toHandle(window.getNativeWindowHandle());
    // Must happen before the first show, or Windows keeps it in Alt+Tab.
    makeToolWindow(hwnd);
    // Clear any size constraints Chromium inferred from the work area. 0,0 means "no maximum".
    window.setMinimumSize(1, 1);
    window.setMaximumSize(0, 0);
    this.panes.push({ displayId: display.id, window, hwnd, region, primary: display.primary });

    const ready = new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve());
    });
    await this.load(window);
    await ready;

    window.showInactive();

    // Assert the exact physical rect and sink to the bottom. Applied after showing, because showing
    // can re-clamp the geometry, and verified rather than assumed: Chromium has several code paths
    // that quietly resize a new window to fit a work area.
    this.placePane(hwnd, region);
    const payload: SurfacePayload = {
      layout,
      region,
      seed: this.seed,
      epochMs: this.epochMs,
      hud: SHOW_HUD,
    };
    window.webContents.send("wallpaper:layout", payload);
  }

  /**
   * Force a pane to its exact monitor rect at the bottom of the z-order, retrying if the geometry
   * comes back wrong.
   */
  private placePane(hwnd: number, region: Bounds): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      SetWindowPos(hwnd, HWND_BOTTOM, region.x, region.y, region.width, region.height, SWP_NOACTIVATE);
      const rect = getWindowRect(hwnd);
      if (!rect) return;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      if (rect.left === region.x && rect.top === region.y && width === region.width && height === region.height) {
        return;
      }
      console.warn(
        `pane geometry rejected (attempt ${attempt + 1}): wanted ` +
          `${region.width}x${region.height}@${region.x},${region.y}, got ${width}x${height}@${rect.left},${rect.top}`,
      );
    }
  }

  private async load(window: BrowserWindow): Promise<void> {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) {
      await window.loadURL(`${devUrl}/wallpaper/index.html`);
    } else {
      await window.loadFile(join(__dirname, "../renderer/wallpaper/index.html"));
    }
  }

  /**
   * Re-assert bottom placement. Other applications changing z-order, and Windows itself after a
   * session unlock or a full-screen app exiting, can otherwise leave the surface floating above
   * real windows.
   */
  private startSink(): void {
    if (this.sink) return;
    this.sink = setInterval(() => {
      if (this.disposed || this.paused) return;
      for (const pane of this.panes) {
        if (IsWindow(pane.hwnd)) {
          SetWindowPos(pane.hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        }
      }
    }, SINK_INTERVAL_MS);
  }

  sinkNow(): void {
    for (const pane of this.panes) {
      if (IsWindow(pane.hwnd)) {
        SetWindowPos(pane.hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
      }
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const pane of this.panes) {
      if (pane.window.isDestroyed()) continue;
      if (paused) pane.window.hide();
      else {
        pane.window.showInactive();
        this.sinkNow();
      }
    }
  }

  /** Render each pane offscreen through Chromium, for verification independent of the desktop. */
  async capture(directory: string): Promise<string[]> {
    const { writeFileSync } = await import("node:fs");
    const written: string[] = [];
    for (const pane of this.panes) {
      if (pane.window.isDestroyed()) continue;
      const image = await pane.window.webContents.capturePage();
      const path = join(directory, `capture-${pane.displayId}.png`);
      writeFileSync(path, image.toPNG());
      const size = image.getSize();
      written.push(`${path} (${size.width}x${size.height})`);
    }
    return written;
  }

  private destroyPanes(): void {
    for (const pane of this.panes) {
      if (!pane.window.isDestroyed()) pane.window.destroy();
    }
    this.panes = [];
  }

  dispose(): void {
    this.disposed = true;
    if (this.sink) clearInterval(this.sink);
    this.sink = null;
    // Order matters: hand the icons back before the pane that owns them is destroyed.
    this.iconHost.release();
    this.destroyPanes();
  }

  /** Emergency teardown for exit paths where async work is not possible. */
  releaseIcons(): void {
    this.iconHost.release();
  }
}
