/**
 * One pane of the wallpaper: a full simulation of every blob, rendered through a camera that only
 * looks at this monitor's slice of the world.
 *
 * Every pane runs the identical simulation rather than only its own blob. That is deliberate — a
 * particle drifting from one screen toward another has to be drawn by whichever pane it enters, and
 * simulating the whole system in each pane means no particle state ever has to cross a process
 * boundary. Determinism is what keeps them agreeing: a shared seed, a fixed timestep, and a tick
 * count derived from a shared epoch instead of from frame deltas.
 */
import type { Settings } from "@shared/settings";
import { colourForIndex, themeById, type Theme } from "@shared/themes";
import type { DisplayInfo, SurfacePayload } from "@shared/types";
import { BlobPoints } from "./gfx/blobPoints";
import { Stage } from "./gfx/stage";
import { BlobWorld, DEFAULT_SIM_CONFIG, type SimConfig, type Well } from "./sim/world";

type WallpaperBridge = {
  onLayout: (callback: (payload: SurfacePayload) => void) => void;
  onSettings: (callback: (settings: Settings) => void) => void;
};

/**
 * Fold user settings into the tuned simulation defaults.
 *
 * Settings are multipliers rather than raw constants, so the defaults stay the single source of
 * truth for the look and these only scale it. Particle counts are rounded because they size typed
 * arrays.
 */
function configFor(settings: Settings): SimConfig {
  const base = DEFAULT_SIM_CONFIG;
  return {
    ...base,
    blobParticles: Math.max(200, Math.round(base.blobParticles * settings.density)),
    coreParticles: Math.max(50, Math.round(base.coreParticles * settings.density)),
    bridgeParticles: Math.max(50, Math.round(base.bridgeParticles * settings.density)),
    blobRadius: base.blobRadius * settings.size,
    driftSpeed: base.driftSpeed * settings.motion,
    // Speed is the inverse of travel time, so a higher multiplier has to shorten it.
    bridgeTravelSeconds: base.bridgeTravelSeconds / Math.max(0.05, settings.streamSpeed),
  };
}

/** Whether a change needs the whole world rebuilt, or can be applied to the running one. */
function needsRebuild(a: Settings, b: Settings): boolean {
  return a.density !== b.density || a.themeId !== b.themeId;
}

const bridge = (globalThis as unknown as { wallpaper: WallpaperBridge }).wallpaper;
const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;

/** Screen coordinates are Y-down, world coordinates are Y-up. */
function wellFor(display: DisplayInfo, index: number, theme: Theme): Well {
  const b = display.bounds;
  return {
    displayId: display.id,
    x: b.x + b.width / 2,
    y: -(b.y + b.height / 2),
    // Screen area relative to 1080p. Unused by the kinematic model, kept so blob scale could follow
    // monitor size later.
    mass: (b.width * b.height) / (1920 * 1080),
    colour: colourForIndex(theme, index),
  };
}


class Pane {
  private world: BlobWorld | null = null;
  private points: BlobPoints | null = null;
  private stage: Stage | null = null;
  private payload: SurfacePayload | null = null;
  private settings: Settings | null = null;

  private frames = 0;
  private lastHudAt = 0;
  private fps = 0;

  apply(payload: SurfacePayload): void {
    const first = this.payload === null;
    this.payload = payload;
    this.settings = payload.settings;

    if (payload.hud) hud.dataset["enabled"] = "1";
    else delete hud.dataset["enabled"];

    // Blobs sit dead centre on their screen, as in the reference. The interaction is carried by the
    // stream between them rather than by displacing the clouds.
    const theme = themeById(payload.settings.themeId);
    const wells = payload.layout.displays.map((d, i) => wellFor(d, i, theme));
    const config = configFor(payload.settings);

    if (!this.stage) {
      this.stage = new Stage(canvas, payload.region);
    } else {
      this.stage.resize(payload.region);
    }

    if (!this.world) {
      this.world = new BlobWorld(wells, config, payload.seed);
    } else if (this.world.wellCount !== wells.length) {
      // Particle count is tied to the number of wells, so a display being added or removed needs a
      // fresh world; anything else can be reconfigured in place.
      //
      // The old points must leave the scene graph before being disposed. Disposing only frees the
      // geometry and material — the object itself stays in the scene, so skipping the removal leaves
      // a disposed object being drawn alongside its replacement.
      if (this.points) {
        this.stage.scene.remove(this.points.points);
        this.points.dispose();
        this.points = null;
      }
      this.world = new BlobWorld(wells, config, payload.seed);
    } else {
      this.world.reconfigure(wells);
    }

    if (!this.points) {
      this.points = new BlobPoints(this.world, window.devicePixelRatio || 1);
      this.stage.scene.add(this.points.points);
    }
    this.points.setPixelScale((window.devicePixelRatio || 1) * payload.settings.particleScale);
    this.points.setBrightness(payload.settings.brightness);

    if (first) requestAnimationFrame(this.frame);
  }

  /**
   * Apply a settings change to the running pane.
   *
   * Only density and theme change the particle arrays, so only those rebuild the world; everything
   * else is a uniform or a simulation constant and can be swapped without a visible reset.
   */
  applySettings(next: Settings): void {
    const previous = this.settings;
    if (!this.payload) return;
    this.settings = next;

    if (!previous || needsRebuild(previous, next)) {
      this.apply({ ...this.payload, settings: next });
      return;
    }

    const theme = themeById(next.themeId);
    this.world?.retune(
      configFor(next),
      this.payload.layout.displays.map((d, i) => wellFor(d, i, theme)),
    );
    this.points?.setPixelScale((window.devicePixelRatio || 1) * next.particleScale);
    this.points?.setBrightness(next.brightness);
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const { world, points, stage, payload } = this;
    if (!world || !points || !stage || !payload) return;

    // Absolute tick from the shared epoch, so panes converge on the same simulation time no matter
    // how their individual frame timing drifts.
    const elapsed = Math.max(0, Date.now() - payload.epochMs) / 1000;
    world.advanceTo(Math.floor(elapsed / DEFAULT_SIM_CONFIG.timeStep));

    points.sync();
    stage.render();

    this.frames += 1;
    if (now - this.lastHudAt > 1000) {
      this.fps = (this.frames * 1000) / (now - this.lastHudAt);
      this.frames = 0;
      this.lastHudAt = now;
      this.updateHud();
    }
  };

  private updateHud(): void {
    if (!this.payload || !this.world) return;
    if (!hud.dataset["enabled"]) return;
    const r = this.payload.region;
    hud.textContent =
      `${r.width}x${r.height} @${r.x},${r.y}  |  ` +
      `${this.world.count} particles / ${this.world.wellCount} wells  |  ` +
      `${this.fps.toFixed(0)} fps  |  ${this.stage?.info ?? ""}`;
  }
}

const pane = new Pane();
bridge.onLayout((payload) => pane.apply(payload));
bridge.onSettings((settings) => pane.applySettings(settings));
