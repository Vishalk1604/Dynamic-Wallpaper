import { app, globalShortcut } from "electron";
import { BottomSurface } from "./bottomSurface";
import { describeLayout, getLayout, onLayoutChange } from "./displays";
import { SettingsStore } from "./settingsStore";
import { SettingsWindow } from "./settingsWindow";
import { WallpaperTray } from "./tray";

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

let surface: BottomSurface | null = null;
let tray: WallpaperTray | null = null;
let settingsWindow: SettingsWindow | null = null;
let store: SettingsStore | null = null;

/**
 * Only one instance may run: a second would stack another set of panes on the desktop and double the
 * GPU cost for no visible benefit. A relaunch instead surfaces the existing instance's settings.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => settingsWindow?.open());

  app.whenReady().then(() => {
    store = new SettingsStore();
    store.syncAutoStart();

    surface = new BottomSurface(store);
    settingsWindow = new SettingsWindow(store, () => app.quit());
    tray = new WallpaperTray(store, {
      openSettings: () => settingsWindow?.open(),
      quit: () => app.quit(),
    });

    const layout = getLayout();
    console.log(describeLayout(layout));
    void surface.apply(layout);

    tray.start();
    store.onChange(() => {
      store?.syncAutoStart();
      surface?.applySettings();
    });

    onLayoutChange((next) => {
      console.log(`display layout changed: ${describeLayout(next)}`);
      void surface?.apply(next);
    });

    // A deliberate escape hatch: the panes are click-through and absent from Alt+Tab, so if the tray
    // icon is ever hidden in the overflow this is the way out.
    globalShortcut.register(QUIT_ACCELERATOR, () => app.quit());

    // Opened on first run so the app is discoverable rather than being an invisible process.
    if (!app.getLoginItemSettings().wasOpenedAtLogin && !process.argv.includes("--autostart")) {
      settingsWindow.open();
    }

    // Render each pane offscreen to a PNG. Chromium renders these regardless of what covers the
    // desktop, so the wallpaper can be inspected without minimising the user's windows.
    if (process.env["DW_CAPTURE"] === "1") {
      // Styles that build up over time need a later shot than one that is settled immediately.
      const delay = Number(process.env["DW_CAPTURE_DELAY"] ?? 4000) || 4000;
      setTimeout(() => {
        void surface
          ?.capture(app.getPath("userData"))
          .then((files) => files.forEach((f) => console.log(`captured ${f}`)))
          .catch((error) => console.error("capture failed", error));
      }, delay);
    }
  });
}

app.on("before-quit", () => {
  surface?.dispose();
  tray?.dispose();
  settingsWindow?.dispose();
  globalShortcut.unregisterAll();
});

/**
 * The panes may own Explorer's icon host when the opt-in adoption mode is enabled, and Windows
 * destroys child windows with their parent — so every exit path hands it back before the panes go.
 */
process.on("exit", () => surface?.releaseIcons());
process.on("SIGINT", () => {
  surface?.releaseIcons();
  app.quit();
});
process.on("SIGTERM", () => {
  surface?.releaseIcons();
  app.quit();
});
process.on("uncaughtException", (error) => {
  console.error("uncaught exception, releasing icon host first", error);
  surface?.releaseIcons();
  app.quit();
});

// Registering a listener at all overrides Electron's default "quit when no windows remain", which
// matters because the wallpaper has no ordinary window to keep it alive.
app.on("window-all-closed", () => {});
