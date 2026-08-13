import { app, globalShortcut } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BottomSurface } from "./bottomSurface";
import { describeLayout, getLayout, onLayoutChange } from "./displays";

// A wallpaper has to keep animating while it is permanently unfocused, which is precisely what
// Chromium's background throttling exists to prevent.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// The surface sits under every other window, which Chromium's occlusion heuristic would otherwise
// score as fully hidden and stop painting.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// Without this, userData lands in a generic "Electron" folder while running unpackaged.
app.setName("dynamic-wallpaper");

const QUIT_ACCELERATOR = "Control+Alt+Shift+W";

const surface = new BottomSurface();
const log: string[] = [];

function record(line: string): void {
  log.push(line);
  console.log(line);
}

function writeReport(): void {
  try {
    writeFileSync(join(app.getPath("userData"), "spike-report.txt"), log.join("\n"), "utf8");
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
        `rot=${d.rotation} scale=${d.scaleFactor} internal=${d.internal} primary=${d.primary}`,
    );
  }

  await surface.apply(layout);

  record("\n=== surface ===");
  record(`panes: ${surface.paneCount}`);
  record(`quit with ${QUIT_ACCELERATOR}`);

  setTimeout(async () => {
    try {
      const shots = await surface.capture(app.getPath("userData"));
      record("\n=== renderer captures ===");
      for (const s of shots) record(s);
    } catch (error) {
      record(`capture failed: ${String(error)}`);
    }
    writeReport();
  }, 2500);

  writeReport();

  onLayoutChange(async (next) => {
    record("\n=== display layout changed ===");
    record(describeLayout(next));
    await surface.apply(next);
    record(`panes: ${surface.paneCount}`);
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
app.on("window-all-closed", () => {});
