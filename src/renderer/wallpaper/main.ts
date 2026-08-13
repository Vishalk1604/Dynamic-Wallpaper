/**
 * One pane of the wallpaper: the whole scene simulated, rendered through a camera that only looks at
 * this monitor's slice of the world.
 *
 * Every pane runs the identical scene rather than only its own blob. That is deliberate — anything
 * drifting from one screen toward another has to be drawn by whichever pane it enters, and computing
 * the whole thing in each pane means no state ever crosses a process boundary. Determinism keeps them
 * agreeing: a shared seed, a fixed timestep, and a tick count derived from a shared epoch rather than
 * from frame deltas.
 */
import type { Settings } from "@shared/settings";
import { hexToRgb, themeById, type Rgb } from "@shared/themes";
import type { DisplayInfo, SurfacePayload } from "@shared/types";
import { BlobPoints } from "./gfx/blobPoints";
import { MistField, type MistWell } from "./gfx/mistField";
import { Stage } from "./gfx/stage";
import { BlobWorld, DEFAULT_SIM_CONFIG, type SimConfig, type Well } from "./sim/world";

type WallpaperBridge = {
  onLayout: (callback: (payload: SurfacePayload) => void) => void;
  onSettings: (callback: (settings: Settings) => void) => void;
};

const bridge = (globalThis as unknown as { wallpaper: WallpaperBridge }).wallpaper;
const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;

/**
 * Base mist radius before the size multiplier.
 *
 * The visible cloud reaches well beyond this, since the density boundary is soft on both sides, so
 * this is noticeably smaller than it looks like it should be.
 */
const MIST_RADIUS = 195;

function colourFor(settings: Settings, index: number): Rgb {
  return hexToRgb(settings.colours[index % settings.colours.length] ?? "#ffffff");
}

/** Screen coordinates are Y-down, world coordinates are Y-up. */
function wellFor(display: DisplayInfo, index: number, settings: Settings): Well {
  const b = display.bounds;
  return {
    displayId: display.id,
    x: b.x + b.width / 2,
    y: -(b.y + b.height / 2),
    mass: (b.width * b.height) / (1920 * 1080),
    colour: colourFor(settings, index),
  };
}

/**
 * Fold user settings into the tuned simulation defaults.
 *
 * Settings are multipliers, so the defaults stay the single source of truth for the look. Particle
 * counts are rounded because they size typed arrays.
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
    // Speed is the inverse of travel time, so a higher multiplier shortens it.
    bridgeTravelSeconds: base.bridgeTravelSeconds / Math.max(0.05, settings.streamSpeed),
  };
}

/** Only these change the size of the particle arrays, so only these need a new world. */
function needsRebuild(a: Settings, b: Settings): boolean {
  return a.density !== b.density || a.themeId !== b.themeId;
}

class Pane {
  private world: BlobWorld | null = null;
  private points: BlobPoints | null = null;
  private mist: MistField | null = null;
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

    if (!this.stage) this.stage = new Stage(canvas, payload.region);
    else this.stage.resize(payload.region);

    // Mist is raymarched per pixel, so it renders at reduced resolution and is upscaled. The result
    // is soft by nature, which hides the loss, and it is the difference between comfortably hitting
    // frame rate and not.
    const theme = themeById(payload.settings.themeId);
    this.stage.setResolutionScale(theme.id === "aether" ? 0.62 : 1);
    this.stage.resize(payload.region);

    this.teardownVisuals();
    if (theme.id === "aether") this.buildMist(payload);
    else this.buildFilament(payload);

    if (first) requestAnimationFrame(this.frame);
  }

  private teardownVisuals(): void {
    if (!this.stage) return;
    if (this.points) {
      this.stage.scene.remove(this.points.points);
      this.points.dispose();
      this.points = null;
      this.world = null;
    }
    if (this.mist) {
      this.stage.scene.remove(this.mist.mesh);
      this.mist.dispose();
      this.mist = null;
    }
  }

  private buildFilament(payload: SurfacePayload): void {
    const wells = payload.layout.displays.map((d, i) => wellFor(d, i, payload.settings));
    this.world = new BlobWorld(wells, configFor(payload.settings), payload.seed);
    this.points = new BlobPoints(this.world, window.devicePixelRatio || 1);
    this.stage!.scene.add(this.points.points);
    this.points.setPixelScale((window.devicePixelRatio || 1) * payload.settings.particleScale);
    this.points.setBrightness(payload.settings.brightness);
  }

  private mistWells(settings: Settings): MistWell[] {
    return (this.payload?.layout.displays ?? []).map((d, i) => {
      const b = d.bounds;
      return {
        x: b.x + b.width / 2,
        y: -(b.y + b.height / 2),
        colour: colourFor(settings, i),
      };
    });
  }

  private buildMist(payload: SurfacePayload): void {
    const radius = MIST_RADIUS * payload.settings.size;
    this.mist = new MistField(payload.region, this.mistWells(payload.settings), radius);
    this.mist.setBrightness(payload.settings.brightness);
    this.mist.setDetail(payload.settings.density);
    this.stage!.scene.add(this.mist.mesh);
  }

  /**
   * Apply a settings change to the running pane.
   *
   * Rebuilding is avoided wherever possible: recreating the scene on every slider movement would
   * make the wallpaper flicker while it is being tuned.
   */
  applySettings(next: Settings): void {
    const previous = this.settings;
    if (!this.payload) return;
    this.settings = next;

    if (!previous || needsRebuild(previous, next)) {
      this.apply({ ...this.payload, settings: next });
      return;
    }

    if (this.mist) {
      this.mist.setWells(this.mistWells(next), MIST_RADIUS * next.size);
      this.mist.setBrightness(next.brightness);
      this.mist.setDetail(next.density);
      return;
    }

    const wells = this.payload.layout.displays.map((d, i) => wellFor(d, i, next));
    this.world?.retune(configFor(next), wells);
    // Colours live in the particle buffers, so they have to be re-applied explicitly — without this
    // a colour change updates nothing visible.
    this.world?.recolour();
    this.points?.setPixelScale((window.devicePixelRatio || 1) * next.particleScale);
    this.points?.setBrightness(next.brightness);
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const { stage, payload, settings } = this;
    if (!stage || !payload || !settings) return;

    // Absolute time from the shared epoch, so panes converge on the same state no matter how their
    // individual frame timing drifts.
    const elapsed = Math.max(0, Date.now() - payload.epochMs) / 1000;

    if (this.mist) {
      this.mist.setTime(elapsed * settings.motion);
    } else if (this.world && this.points) {
      this.world.advanceTo(Math.floor(elapsed / DEFAULT_SIM_CONFIG.timeStep));
      this.points.sync();
    }

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
    if (!this.payload || !hud.dataset["enabled"]) return;
    const r = this.payload.region;
    const theme = themeById(this.payload.settings.themeId);
    const detail = this.world ? `${this.world.count} particles` : "volumetric mist";
    hud.textContent =
      `${theme.name}  |  ${r.width}x${r.height} @${r.x},${r.y}  |  ` +
      `${detail}  |  ${this.fps.toFixed(0)} fps  |  ${this.stage?.info ?? ""}`;
  }
}

const pane = new Pane();
bridge.onLayout((payload) => pane.apply(payload));
bridge.onSettings((settings) => pane.applySettings(settings));
