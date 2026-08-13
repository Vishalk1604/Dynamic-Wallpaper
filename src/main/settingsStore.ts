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
    const changed = (Object.keys(next) as (keyof Settings)[]).some((k) => next[k] !== this.current[k]);
    if (!changed) return this.current;

    this.current = next;
    this.write();
    for (const listener of this.listeners) listener(next);
    return next;
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
    if (app.getLoginItemSettings().openAtLogin !== enabled) {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ["--autostart"] });
    }
  }
}
