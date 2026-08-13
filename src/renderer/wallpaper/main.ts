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
import { colourForIndex } from "@shared/palette";
import type { DisplayInfo, SurfacePayload } from "@shared/types";
import { BlobPoints } from "./gfx/blobPoints";
import { Stage } from "./gfx/stage";
import { BlobWorld, DEFAULT_SIM_CONFIG, type Well } from "./sim/world";

type WallpaperBridge = {
  onLayout: (callback: (payload: SurfacePayload) => void) => void;
};

const bridge = (globalThis as unknown as { wallpaper: WallpaperBridge }).wallpaper;
const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;

/** Screen coordinates are Y-down, world coordinates are Y-up. */
function wellFor(display: DisplayInfo, index: number): Well {
  const b = display.bounds;
  return {
    displayId: display.id,
    x: b.x + b.width / 2,
    y: -(b.y + b.height / 2),
    // Larger screens carry more mass, so a big monitor pulls harder on a small one. Normalised
    // against 1080p so the tuned gravity constant stays meaningful.
    mass: (b.width * b.height) / (1920 * 1080),
    colour: colourForIndex(index),
  };
}


class Pane {
  private world: BlobWorld | null = null;
  private points: BlobPoints | null = null;
  private stage: Stage | null = null;
  private payload: SurfacePayload | null = null;

  private frames = 0;
  private lastHudAt = 0;
  private fps = 0;

  apply(payload: SurfacePayload): void {
    const first = this.payload === null;
    this.payload = payload;

    if (payload.hud) hud.dataset["enabled"] = "1";
    else delete hud.dataset["enabled"];

    // Blobs sit dead centre on their screen, as in the reference. The interaction is carried by the
    // stream between them rather than by displacing the clouds.
    const wells = payload.layout.displays.map(wellFor);

    if (!this.stage) {
      this.stage = new Stage(canvas, payload.region);
    } else {
      this.stage.resize(payload.region);
    }

    if (!this.world) {
      this.world = new BlobWorld(wells, DEFAULT_SIM_CONFIG, payload.seed);
    } else if (this.world.wellCount !== wells.length) {
      // Particle count is tied to the number of wells, so a display being added or removed needs a
      // fresh world; anything else can be reconfigured in place.
      this.points?.dispose();
      this.points = null;
      this.world = new BlobWorld(wells, DEFAULT_SIM_CONFIG, payload.seed);
    } else {
      this.world.reconfigure(wells);
    }

    if (!this.points) {
      this.points = new BlobPoints(this.world, window.devicePixelRatio || 1);
      this.stage.scene.add(this.points.points);
    }

    if (first) requestAnimationFrame(this.frame);
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
