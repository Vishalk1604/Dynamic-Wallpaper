/**
 * Settings persistence and change notification.
 *
 * Writes are atomic — to a temporary file then renamed — because settings are saved on every slider
 * movement, and a crash mid-write would otherwise leave a truncated file. Reads tolerate anything on
 * disk: a corrupt or hand-edited file falls back to defaults rather than stopping the wallpaper from
 * starting.
 */
import { app } from "electron";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, normaliseSettings, type Settings } from "@shared/settings";

type Listener = (settings: Settings) => void;

/**
 * Registry value name under `HKCU\...\CurrentVersion\Run`.
 *
 * Named explicitly rather than left to default, because Electron derives the default from the
 * AppUserModelId and the uninstaller has to delete this exact value — a startup entry pointing at a
 * removed executable is the classic uninstall leftover. Kept in step with `build-resources/installer.nsh`.
 */
const AUTO_START_KEY = "Dynamic Wallpaper";

/** Marks a sign-in launch, so the settings window does not open in the user's face at every boot. */
const AUTO_START_ARGS = ["--autostart"];

export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<Listener>();
  private readonly path: string;

  constructor() {
    this.path = join(app.getPath("userData"), "settings.json");
    this.current = this.read();
  }

  get value(): Settings {
    return this.current;
  }

  private read(): Settings {
    try {
      // Strip a byte-order mark before parsing. JSON.parse throws on a leading BOM, and plenty of
      // Windows editors and PowerShell's own Out-File add one, which would silently discard the
      // user's entire configuration and reset to defaults.
      const text = readFileSync(this.path, "utf8").replace(/^﻿/, "");
      return normaliseSettings(JSON.parse(text));
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private write(): void {
    try {
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, JSON.stringify(this.current, null, 2), "utf8");
      renameSync(temp, this.path);
    } catch (error) {
      console.error("could not save settings", error);
    }
  }

  /** Merge a partial update, persist it, and notify listeners. */
  update(patch: Partial<Settings>): Settings {
    const next = normaliseSettings({ ...this.current, ...patch });
    if (!this.differs(next)) return this.current;

    this.current = next;
    this.write();
    for (const listener of this.listeners) listener(next);
    return next;
  }

  /**
   * Compare against the current settings.
   *
   * `colours` needs an element-wise check: normalisation always returns a fresh array, so comparing
   * it by identity would report a change on every update and defeat the guard entirely — turning
   * each slider movement into a disk write and a rebroadcast to every pane.
   */
  private differs(next: Settings): boolean {
    return (Object.keys(next) as (keyof Settings)[]).some((key) => {
      if (key === "colours") {
        return next.colours.some((colour, i) => colour !== this.current.colours[i]);
      }
      return next[key] !== this.current[key];
    });
  }

  reset(): Settings {
    return this.update(DEFAULT_SETTINGS);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply the launch-at-sign-in preference to the OS.
   *
   * Skipped while unpackaged, where the executable is Electron itself — registering that would add a
   * bare Electron launcher to the user's startup items.
   */
  syncAutoStart(): void {
    if (!app.isPackaged) return;
    const enabled = this.current.autoStart;
    // The query matches on executable path and arguments, not on the value name, so it has to be
    // given the same arguments the entry was registered with or it will never find it.
    if (app.getLoginItemSettings({ args: AUTO_START_ARGS }).openAtLogin !== enabled) {
      app.setLoginItemSettings({ openAtLogin: enabled, name: AUTO_START_KEY, args: AUTO_START_ARGS });
    }
  }
}
