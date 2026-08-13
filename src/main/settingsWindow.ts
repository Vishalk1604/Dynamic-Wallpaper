/**
 * The settings window: a frameless dark panel, created on demand and hidden rather than destroyed so
 * reopening it from the tray is instant.
 */
import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import type { Settings } from "@shared/settings";
import type { SettingsStore } from "./settingsStore";

export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly onQuit: () => void,
  ) {
    this.registerIpc();
  }

  private registerIpc(): void {
    ipcMain.handle("settings:read", () => ({
      settings: this.settings.value,
      displays: screen.getAllDisplays().length,
      packaged: require("electron").app.isPackaged as boolean,
    }));
    ipcMain.on("settings:update", (_event, patch: Partial<Settings>) => this.settings.update(patch));
    ipcMain.on("settings:reset", () => this.settings.reset());
    ipcMain.on("settings:close", () => this.window?.hide());
    ipcMain.on("app:quit", () => this.onQuit());
  }

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 520,
      height: 660,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: "#0b0d12",
      title: "Dynamic Wallpaper — Settings",
      webPreferences: {
        preload: join(__dirname, "../preload/settings.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Hidden rather than closed, so state and position survive until quit.
    this.window.on("close", (event) => {
      event.preventDefault();
      this.window?.hide();
    });

    this.unsubscribe?.();
    this.unsubscribe = this.settings.onChange((next) => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("settings:changed", next);
      }
    });

    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    const load = devUrl
      ? this.window.loadURL(`${devUrl}/settings/index.html`)
      : this.window.loadFile(join(__dirname, "../renderer/settings/index.html"));

    void load.then(() => {
      this.window?.show();
      this.window?.focus();
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeAllListeners("close");
      this.window.destroy();
    }
    this.window = null;
  }
}
