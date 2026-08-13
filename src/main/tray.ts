/**
 * System tray icon and menu — the only visible UI the wallpaper has.
 *
 * The menu is rebuilt whenever settings change rather than mutated in place, because Electron's Menu
 * items are immutable once built and a stale checkmark next to the active theme is exactly the kind
 * of thing that makes an app feel broken.
 */
import { Menu, Tray, app, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "@shared/themes";
import type { SettingsStore } from "./settingsStore";

export type TrayActions = {
  openSettings: () => void;
  quit: () => void;
};

/**
 * Resolve a resource path in both the unpackaged and packaged layouts.
 * Unpackaged runs from `out/main`, packaged from inside the asar next to `resources`.
 */
function resourcePath(name: string): string {
  const candidates = [
    join(__dirname, "../../resources", name),
    join(process.resourcesPath ?? "", name),
    join(app.getAppPath(), "resources", name),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export class WallpaperTray {
  private tray: Tray | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly actions: TrayActions,
  ) {}

  start(): void {
    const image = nativeImage.createFromPath(resourcePath("tray.png"));
    // An empty image yields an invisible tray entry, which looks like the app failed to launch.
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip("Dynamic Wallpaper");
    this.tray.on("double-click", () => this.actions.openSettings());
    this.rebuild();
    this.unsubscribe = this.settings.onChange(() => this.rebuild());
  }

  private rebuild(): void {
    if (!this.tray) return;
    const current = this.settings.value;

    const menu = Menu.buildFromTemplate([
      { label: "Dynamic Wallpaper", enabled: false },
      { type: "separator" },
      {
        label: current.paused ? "Resume" : "Pause",
        click: () => this.settings.update({ paused: !current.paused }),
      },
      {
        label: "Theme",
        submenu: THEMES.map((theme) => ({
          label: theme.name,
          sublabel: theme.description,
          type: "radio" as const,
          checked: theme.id === current.themeId,
          click: () => this.settings.update({ themeId: theme.id }),
        })),
      },
      { type: "separator" },
      { label: "Settings…", click: () => this.actions.openSettings() },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: current.autoStart,
        // Meaningless while unpackaged, where the executable is Electron itself.
        enabled: app.isPackaged,
        click: () => this.settings.update({ autoStart: !current.autoStart }),
      },
      { type: "separator" },
      { label: "Quit", click: () => this.actions.quit() },
    ]);

    this.tray.setContextMenu(menu);
    this.tray.setToolTip(current.paused ? "Dynamic Wallpaper — paused" : "Dynamic Wallpaper");
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tray?.destroy();
    this.tray = null;
  }
}
