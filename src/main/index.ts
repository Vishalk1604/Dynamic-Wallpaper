import { app, globalShortcut } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeLayout, getLayout, onLayoutChange } from "./displays";
import { WallpaperSurface } from "./wallpaperWindows";

// A wallpaper has to keep animating while it is permanently unfocused, which is precisely what
// Chromium's background throttling exists to prevent.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Without this, userData lands in a generic "Electron" folder while running unpackaged.
app.setName("dynamic-wallpaper");

// Diagnostic switches for the Phase 1 investigation into why a reparented window may not be
// composited onto the desktop. Set to "1" to force Chromium off its GPU compositing path.
if (process.env["DW_DISABLE_GPU_COMPOSITING"] === "1") {
  app.commandLine.appendSwitch("disable-gpu-compositing");
  console.log("switch: disable-gpu-compositing");
}
if (process.env["DW_DISABLE_GPU"] === "1") {
  app.disableHardwareAcceleration();
  console.log("switch: disableHardwareAcceleration");
}
// DirectComposition render targets are created against a top-level HWND. Once we reparent into
// WorkerW the window is no longer top-level, which can leave the composition target orphaned and
// the window blank. This flag falls back to the older swap-chain path while keeping the GPU.
if (process.env["DW_DISABLE_DIRECT_COMPOSITION"] === "1") {
  app.commandLine.appendSwitch("disable-direct-composition");
  console.log("switch: disable-direct-composition");
}
// Chromium computes on Windows whether a window is natively occluded and stops painting when it
// believes nothing is visible. A window parented into WorkerW sits behind the entire shell, which
// that heuristic is very likely to score as fully occluded.
if (process.env["DW_DISABLE_OCCLUSION"] !== "0") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  console.log("switch: disable-features=CalculateNativeWinOcclusion");
}

const QUIT_ACCELERATOR = "Control+Alt+Shift+W";

const surface = new WallpaperSurface();
const log: string[] = [];

function record(line: string): void {
  log.push(line);
  console.log(line);
}

function writeReport(): void {
  try {
    const path = join(app.getPath("userData"), "spike-report.txt");
    writeFileSync(path, log.join("\n"), "utf8");
    console.log(`\nreport written to ${path}`);
  } catch (error) {
    console.error("could not write report", error);
  }
}

async function start(): Promise<void> {
  const layout = getLayout();
  record("=== display layout ===");
  record(describeLayout(layout));
  for (const d of layout.displays) {
    record(
      `  id=${d.id} "${d.label}" physical=${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y} ` +
        `dip=${d.dipBounds.width}x${d.dipBounds.height}@${d.dipBounds.x},${d.dipBounds.y} ` +
        `rot=${d.rotation} scale=${d.scaleFactor} internal=${d.internal} primary=${d.primary}`,
    );
  }

  record("\n=== wallpaper host probe ===");
  await surface.apply(layout);
  for (const line of surface.lastProbe) record(line);

  record("\n=== result ===");
  record(`strategy: ${surface.strategy}`);
  record(`desktop icons expected to stay visible: ${surface.iconsPreserved}`);
  record(`windows created: ${layout.displays.length}`);
  record(`quit with ${QUIT_ACCELERATOR}`);

  // Give the page a beat to paint, then capture what the renderer actually produced.
  setTimeout(async () => {
    try {
      const shots = await surface.captureAll(app.getPath("userData"));
      record("\n=== renderer captures ===");
      for (const s of shots) record(s);
    } catch (error) {
      record(`capture failed: ${String(error)}`);
    }
    writeReport();
  }, 1500);

  writeReport();

  onLayoutChange(async (next) => {
    record("\n=== display layout changed ===");
    record(describeLayout(next));
    await surface.apply(next);
    for (const line of surface.lastProbe) record(line);
    writeReport();
  });
}

app.whenReady().then(async () => {
  await start();

  globalShortcut.register(QUIT_ACCELERATOR, () => {
    record("\nquit requested via shortcut");
    app.quit();
  });
});

app.on("before-quit", () => {
  surface.dispose();
  globalShortcut.unregisterAll();
});

// Registering a listener at all overrides Electron's default "quit when no windows remain".
// Wallpaper windows come and go as displays are attached and removed, so the process must survive
// having none.
app.on("window-all-closed", () => {});
