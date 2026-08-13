/**
 * The wallpaper engine: renders one offscreen surface covering the entire virtual desktop and
 * blits each frame into the shell's wallpaper host, so the result sits behind the desktop icons.
 *
 * A single surface rather than one window per monitor is a deliberate simplification. The blit
 * target is the wallpaper host's DC, which is already a single physical-pixel space spanning every
 * monitor, so one canvas maps 1:1 onto all of them. That removes the need to keep separate
 * per-monitor simulations in lockstep, which would otherwise be required for a particle to cross a
 * bezel without visibly jumping.
 */
import { BrowserWindow } from "electron";
import { join } from "node:path";
import type { Layout } from "./displays";
import { blitToHost } from "./native/gdiBlit";
import { findWallpaperHost, restoreDesktop, takeDiagnostics, type WallpaperHost } from "./native/desktopLayer";

export type EngineOptions = {
  /** Frames per second requested from the offscreen renderer. */
  frameRate: number;
  /**
   * Render scale. Frames are rendered at this fraction of native resolution and stretched on blit,
   * which trades sharpness for a much cheaper GPU readback.
   */
  renderScale: number;
};

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  frameRate: 60,
  renderScale: 1,
};

type Stats = {
  frames: number;
  blitFailures: number;
  firstFrameAt: number | null;
  lastFrameAt: number | null;
  /** Rolling average of the time spent inside the blit call, in milliseconds. */
  avgBlitMs: number;
};

export class WallpaperEngine {
  private surface: BrowserWindow | null = null;
  private host: WallpaperHost | null = null;
  private options: EngineOptions;
  private disposed = false;
  private paused = false;

  public probe: string[] = [];
  public stats: Stats = {
    frames: 0,
    blitFailures: 0,
    firstFrameAt: null,
    lastFrameAt: null,
    avgBlitMs: 0,
  };

  constructor(options: Partial<EngineOptions> = {}) {
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  }

  get strategy(): string {
    return this.host?.strategy ?? "none";
  }

  /** Measured throughput since the first frame arrived. */
  get fps(): number {
    const { frames, firstFrameAt, lastFrameAt } = this.stats;
    if (!firstFrameAt || !lastFrameAt || frames < 2) return 0;
    const seconds = (lastFrameAt - firstFrameAt) / 1000;
    return seconds > 0 ? (frames - 1) / seconds : 0;
  }

  async start(layout: Layout): Promise<void> {
    if (this.disposed) return;
    this.host = findWallpaperHost();
    this.probe = takeDiagnostics();
    await this.createSurface(layout);
  }

  /**
   * Rebuild for a new display arrangement. The surface is recreated because its size is tied to the
   * virtual desktop, and the host is re-probed because the shell recreates WorkerW on some changes.
   */
  async applyLayout(layout: Layout): Promise<void> {
    if (this.disposed) return;
    this.host = findWallpaperHost();
    this.probe = takeDiagnostics();
    this.destroySurface();
    await this.createSurface(layout);
  }

  private async createSurface(layout: Layout): Promise<void> {
    const v = layout.virtualBounds;
    const scale = Math.max(0.1, Math.min(1, this.options.renderScale));
    const width = Math.max(1, Math.round(v.width * scale));
    const height = Math.max(1, Math.round(v.height * scale));

    const surface = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: "#000000",
      // Keep it off every surface a user could stumble into; it exists only to produce frames.
      skipTaskbar: true,
      focusable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: join(__dirname, "../preload/wallpaper.js"),
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    });

    this.surface = surface;

    surface.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      const tag = ["verbose", "info", "warning", "error"][level] ?? String(level);
      console.log(`[renderer] ${tag}: ${message} (${sourceId}:${line})`);
    });
    surface.webContents.on("did-fail-load", (_e, code, description, url) => {
      console.error(`[renderer] did-fail-load ${code} ${description} ${url}`);
    });
    surface.webContents.on("render-process-gone", (_e, details) => {
      console.error("[renderer] render-process-gone", details);
    });

    surface.webContents.on("paint", (_event, _dirty, image) => {
      if (this.disposed || this.paused || !this.host) return;
      const size = image.getSize();
      if (size.width === 0 || size.height === 0) return;

      const started = performance.now();
      const ok = blitToHost(
        this.host.hwnd,
        image.getBitmap(),
        size.width,
        size.height,
        { x: v.x, y: v.y, width: v.width, height: v.height },
        this.host.origin,
      );
      const elapsed = performance.now() - started;

      const s = this.stats;
      s.frames += 1;
      if (!ok) s.blitFailures += 1;
      if (s.firstFrameAt === null) s.firstFrameAt = started;
      s.lastFrameAt = started;
      s.avgBlitMs = s.avgBlitMs === 0 ? elapsed : s.avgBlitMs * 0.9 + elapsed * 0.1;
    });

    const ready = new Promise<void>((resolve) => {
      surface.webContents.once("did-finish-load", () => resolve());
    });
    await this.load(surface);
    await ready;

    surface.webContents.setFrameRate(this.options.frameRate);
    surface.webContents.send("wallpaper:layout", layout);
  }

  private async load(surface: BrowserWindow): Promise<void> {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) {
      await surface.loadURL(`${devUrl}/wallpaper/index.html`);
    } else {
      await surface.loadFile(join(__dirname, "../renderer/wallpaper/index.html"));
    }
  }

  setFrameRate(fps: number): void {
    this.options.frameRate = fps;
    this.surface?.webContents.setFrameRate(fps);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  resetStats(): void {
    this.stats = { frames: 0, blitFailures: 0, firstFrameAt: null, lastFrameAt: null, avgBlitMs: 0 };
  }

  private destroySurface(): void {
    if (this.surface && !this.surface.isDestroyed()) this.surface.destroy();
    this.surface = null;
  }

  dispose(): void {
    this.disposed = true;
    this.destroySurface();
    restoreDesktop(this.host);
    this.host = null;
  }
}
