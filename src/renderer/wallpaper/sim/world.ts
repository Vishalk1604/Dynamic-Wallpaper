/**
 * The blob field: a kinematic model, deliberately not a gravity simulation.
 *
 * An earlier version integrated real gravity with damping and an orbital thermostat. It looked right
 * for about a minute and then collapsed: damping bleeds energy, particles spiral inward, and after ten
 * minutes each blob is a blown-out core surrounded by a thin diffuse halo. That is not a tuning
 * problem, it is what integrating an attractive force with any energy loss does, and a wallpaper has
 * to look the same after ten hours as it did at startup.
 *
 * So the shape is imposed instead of emergent, and each element is chosen to be exactly stable:
 *
 *   - Blob particles drift in straight lines and reflect off a sphere of fixed radius. Reflection is
 *     energy-conserving by construction, so the cloud can neither collapse nor spread. It churns
 *     forever at constant density.
 *   - Bridge particles are a pure function of time: position comes from a phase that wraps, never
 *     from accumulated state, so a stream cannot drift or decay.
 *   - Each blob also carries a small cluster in its neighbour's colour at its centre, which is what
 *     makes the stream read as arriving somewhere rather than just stopping.
 *
 * World space is virtual-desktop physical pixels with Y negated so Y increases upward. Blobs sit in
 * the z = 0 plane and particles occupy full 3D, which gives them volume rather than flatness.
 *
 * Nothing here may use `Math.random`, `Date.now` or a frame delta: every pane runs this same model
 * and they must agree, so randomness comes from the shared seed and time advances in fixed steps.
 */
import { createRandom, type Random } from "./rng";
import type { Rgb } from "@shared/palette";

export type Well = {
  displayId: number;
  x: number;
  y: number;
  /** Unused by the kinematic model; kept so callers can weight blob size by screen area. */
  mass: number;
  colour: Rgb;
};

export type SimConfig = {
  /** Particles in each blob's main cloud. */
  blobParticles: number;
  /** Particles in the neighbour-coloured cluster at each blob's centre. */
  coreParticles: number;
  /** Particles in each directed stream between two blobs. */
  bridgeParticles: number;
  /** Blob radius in px. */
  blobRadius: number;
  /** Central cluster radius, as a fraction of blobRadius. */
  coreRadiusFactor: number;
  /**
   * Inner edge of the blob's shell, as a fraction of its radius.
   *
   * Particles occupy a hollow shell rather than a filled sphere, which matters for two reasons. A
   * filled sphere has far more depth through the middle, so additive blending saturates the centre to
   * white and the blob loses its colour entirely. It also hides the neighbour-coloured cluster inside
   * it. A shell keeps the blob evenly coloured and lets the core show through.
   */
  shellInner: number;
  /** Inner edge of the central cluster's shell, as a fraction of its own radius. */
  coreShellInner: number;
  /** Drift speed of blob particles, in px/s. */
  driftSpeed: number;
  /** How long a bridge particle takes to travel end to end, in seconds. */
  bridgeTravelSeconds: number;
  /** Half-width of a stream at its source, in px. */
  bridgeWidth: number;
  timeStep: number;
};

export const DEFAULT_SIM_CONFIG: SimConfig = {
  blobParticles: 3400,
  coreParticles: 700,
  bridgeParticles: 820,
  blobRadius: 215,
  coreRadiusFactor: 0.34,
  shellInner: 0.78,
  coreShellInner: 0.6,
  driftSpeed: 26,
  bridgeTravelSeconds: 9,
  bridgeWidth: 150,
  timeStep: 1 / 120,
};

/** Particle roles, laid out contiguously so each update loop stays tight. */
const KIND_BLOB = 0;
const KIND_CORE = 1;
const KIND_BRIDGE = 2;

export class BlobWorld {
  readonly positions: Float32Array;
  readonly colours: Float32Array;
  readonly sizes: Float32Array;
  readonly alphas: Float32Array;

  private readonly velocities: Float32Array;
  /** For blob and core particles: which well they orbit. For bridge particles: the source well. */
  private readonly anchor: Int32Array;
  /** Bridge particles only: destination well. */
  private readonly target: Int32Array;
  /** Outer bounce radius for blob and core particles; phase offset for bridge particles. */
  private readonly extent: Float32Array;
  /** Inner bounce radius, keeping shell particles out of the middle. */
  private readonly innerExtent: Float32Array;
  /** Bridge particles only: lateral offsets within the stream, and a jitter phase. */
  private readonly lateral: Float32Array;
  private readonly kind: Uint8Array;
  /** Base alpha before any along-stream fade is applied. */
  private readonly baseAlpha: Float32Array;

  private config: SimConfig;
  private readonly random: Random;
  private wells: Well[];
  private tick = 0;
  /** Boundary between the sphere-bounded particles and the stream particles. */
  private coreEnd = 0;

  readonly count: number;

  constructor(wells: Well[], config: SimConfig, seed: number) {
    this.config = config;
    this.wells = wells;
    this.random = createRandom(seed);

    const wellCount = Math.max(1, wells.length);
    const pairs = Math.max(0, wellCount * (wellCount - 1));
    this.count =
      wellCount * config.blobParticles + pairs * config.coreParticles + pairs * config.bridgeParticles;

    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.colours = new Float32Array(this.count * 3);
    this.lateral = new Float32Array(this.count * 3);
    this.sizes = new Float32Array(this.count);
    this.alphas = new Float32Array(this.count);
    this.baseAlpha = new Float32Array(this.count);
    this.extent = new Float32Array(this.count);
    this.innerExtent = new Float32Array(this.count);
    this.anchor = new Int32Array(this.count);
    this.target = new Int32Array(this.count);
    this.kind = new Uint8Array(this.count);

    this.build();
  }

  get wellCount(): number {
    return this.wells.length;
  }

  private setColour(index: number, colour: Rgb): void {
    const i3 = index * 3;
    this.colours[i3] = colour[0];
    this.colours[i3 + 1] = colour[1];
    this.colours[i3 + 2] = colour[2];
  }

  private build(): void {
    const {
      blobParticles,
      coreParticles,
      bridgeParticles,
      blobRadius,
      coreRadiusFactor,
      shellInner,
      coreShellInner,
    } = this.config;
    const wells = this.wells;
    let index = 0;

    // Main clouds.
    for (let w = 0; w < Math.max(1, wells.length); w++) {
      const colour = wells[w]?.colour ?? ([1, 1, 1] as Rgb);
      for (let n = 0; n < blobParticles; n++, index++) {
        this.kind[index] = KIND_BLOB;
        this.anchor[index] = w;
        this.extent[index] = blobRadius;
        this.innerExtent[index] = blobRadius * shellInner;
        this.sizes[index] = this.random.range(2.4, 8.5);
        this.baseAlpha[index] = this.random.range(0.65, 1);
        this.alphas[index] = this.baseAlpha[index];
        this.setColour(index, colour);
        this.placeInSphere(index, w, blobRadius, shellInner);
      }
    }

    // Neighbour-coloured cluster at the centre of each blob, one per incoming stream.
    for (let from = 0; from < wells.length; from++) {
      for (let to = 0; to < wells.length; to++) {
        if (from === to) continue;
        const colour = wells[from].colour;
        const radius = blobRadius * coreRadiusFactor;
        for (let n = 0; n < coreParticles; n++, index++) {
          this.kind[index] = KIND_CORE;
          this.anchor[index] = to;
          // The cluster sits inside `to` but wears the colour of `from`, so it reads as material
          // that arrived from the other screen. Recorded so colours can be re-applied later.
          this.target[index] = from;
          this.extent[index] = radius;
          this.innerExtent[index] = radius * coreShellInner;
          this.sizes[index] = this.random.range(2.2, 7);
          this.baseAlpha[index] = this.random.range(0.55, 0.9);
          this.alphas[index] = this.baseAlpha[index];
          this.setColour(index, colour);
          this.placeInSphere(index, to, radius, coreShellInner);
        }
      }
    }
    this.coreEnd = index;

    // Directed streams.
    for (let from = 0; from < wells.length; from++) {
      for (let to = 0; to < wells.length; to++) {
        if (from === to) continue;
        const colour = wells[from].colour;
        for (let n = 0; n < bridgeParticles; n++, index++) {
          this.kind[index] = KIND_BRIDGE;
          this.anchor[index] = from;
          this.target[index] = to;
          // Phase offsets spread evenly so the stream is continuous rather than pulsing.
          this.extent[index] = this.random.next();
          this.sizes[index] = this.random.range(2, 6.5);
          this.baseAlpha[index] = this.random.range(0.6, 1);
          this.alphas[index] = 0;
          this.setColour(index, colour);
          const l3 = index * 3;
          this.lateral[l3] = this.random.range(-1, 1);
          this.lateral[l3 + 1] = this.random.range(-1, 1);
          this.lateral[l3 + 2] = this.random.range(0, Math.PI * 2);
        }
      }
    }
  }

  /** Somewhere in a hollow shell around the well, with a small random drift velocity. */
  private placeInSphere(index: number, wellIndex: number, radius: number, shellInner: number): void {
    const well = this.wells[wellIndex];
    const i3 = index * 3;
    const dir: [number, number, number] = [0, 0, 0];
    this.random.onSphere(dir);
    const r = radius * (shellInner + (1 - shellInner) * this.random.next());

    this.positions[i3] = (well?.x ?? 0) + dir[0] * r;
    this.positions[i3 + 1] = (well?.y ?? 0) + dir[1] * r;
    this.positions[i3 + 2] = dir[2] * r;

    const vel: [number, number, number] = [0, 0, 0];
    this.random.onSphere(vel);
    const speed = this.config.driftSpeed * this.random.range(0.35, 1);
    this.velocities[i3] = vel[0] * speed;
    this.velocities[i3 + 1] = vel[1] * speed;
    this.velocities[i3 + 2] = vel[2] * speed;
  }

  /**
   * Apply changed settings without rebuilding.
   *
   * Only geometry and speeds are adjusted, so particles keep their identity and the change reads as
   * the blobs growing or slowing rather than as a reset. Anything that alters particle counts needs a
   * new world instead, since the counts size the typed arrays.
   */
  retune(config: SimConfig, wells: Well[]): void {
    const scale = config.blobRadius / this.config.blobRadius;
    this.config = { ...this.config, ...config };
    this.wells = wells;

    if (scale !== 1) {
      // Rescale the shells and move every particle with them, so nothing is left stranded outside
      // its new bounds and forced to teleport on the next step.
      for (let i = 0; i < this.count; i++) {
        if (this.kind[i] === KIND_BRIDGE) continue;
        const well = this.wells[this.anchor[i]];
        this.extent[i] *= scale;
        this.innerExtent[i] *= scale;
        if (!well) continue;
        const i3 = i * 3;
        this.positions[i3] = well.x + (this.positions[i3] - well.x) * scale;
        this.positions[i3 + 1] = well.y + (this.positions[i3 + 1] - well.y) * scale;
        this.positions[i3 + 2] *= scale;
      }
    }
  }

  /** Rebuild positions for a new display arrangement, and re-apply colours. */
  reconfigure(wells: Well[]): void {
    this.wells = wells;
    for (let i = 0; i < this.count; i++) {
      if (this.kind[i] === KIND_BRIDGE) continue;
      const anchor = Math.min(this.anchor[i], Math.max(0, wells.length - 1));
      this.anchor[i] = anchor;
      const outer = this.extent[i];
      this.placeInSphere(i, anchor, outer, outer > 0 ? this.innerExtent[i] / outer : 0);
    }
    this.recolour();
  }

  /**
   * Re-apply each particle's colour from its wells.
   *
   * Colours are assigned once at construction, so changing a colour without this leaves the buffers
   * holding the old values and nothing visibly changes — which is exactly what happened when the
   * theme switcher appeared to do nothing at all.
   *
   * A particle's colour depends on its role: blob particles take their own well's colour, while the
   * central cluster and the stream take the colour of the screen they came *from*, which is what
   * makes an arriving stream read as belonging to its source.
   */
  recolour(): void {
    const wells = this.wells;
    if (wells.length === 0) return;
    for (let i = 0; i < this.count; i++) {
      // Blob particles belong to their own well; the central cluster and the streams carry the
      // colour of the screen they originated from, which is held in `target` and `anchor`.
      const source = this.kind[i] === KIND_CORE ? this.target[i] : this.anchor[i];
      const colour = wells[Math.min(source, wells.length - 1)]?.colour;
      if (colour) this.setColour(i, colour);
    }
  }

  advanceTo(targetTick: number, maxSteps = 8): void {
    let steps = 0;
    while (this.tick < targetTick && steps < maxSteps) {
      this.step();
      this.tick += 1;
      steps += 1;
    }
    if (this.tick < targetTick) this.tick = targetTick;
  }

  private step(): void {
    const dt = this.config.timeStep;
    const wells = this.wells;
    if (wells.length === 0) return;

    this.stepBounded(0, this.coreEnd, dt);
    this.stepBridges(this.coreEnd, this.count, this.tick * dt);
  }

  /**
   * Straight-line drift with elastic reflection off the anchor sphere.
   *
   * The reflection is what makes this stable forever: the velocity is mirrored about the surface
   * normal, so speed is preserved exactly and no energy enters or leaves the system.
   */
  private stepBounded(start: number, end: number, dt: number): void {
    for (let i = start; i < end; i++) {
      const i3 = i * 3;
      const well = this.wells[this.anchor[i]];
      if (!well) continue;
      const radius = this.extent[i];

      let x = this.positions[i3] + this.velocities[i3] * dt;
      let y = this.positions[i3 + 1] + this.velocities[i3 + 1] * dt;
      let z = this.positions[i3 + 2] + this.velocities[i3 + 2] * dt;

      const dx = x - well.x;
      const dy = y - well.y;
      const dz = z;
      const dist = Math.hypot(dx, dy, dz);

      // Both bounds are reflective. Without the inner one, particles would gradually wander through
      // the middle and refill the sphere, undoing the shell within a few minutes.
      const inner = this.innerExtent[i];
      const outside = dist > radius;
      const inside = dist < inner;

      if ((outside || inside) && dist > 1e-6) {
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        const vn =
          this.velocities[i3] * nx + this.velocities[i3 + 1] * ny + this.velocities[i3 + 2] * nz;
        this.velocities[i3] -= 2 * vn * nx;
        this.velocities[i3 + 1] -= 2 * vn * ny;
        this.velocities[i3 + 2] -= 2 * vn * nz;
        // Seat it just inside the boundary it crossed so it cannot reflect every frame in place.
        const seated = outside ? radius * 0.999 : inner * 1.001;
        x = well.x + nx * seated;
        y = well.y + ny * seated;
        z = nz * seated;
      }

      this.positions[i3] = x;
      this.positions[i3 + 1] = y;
      this.positions[i3 + 2] = z;
    }
  }

  /**
   * Streams, evaluated straight from elapsed time rather than integrated.
   *
   * Being a pure function of time means there is no state to drift, so the stream looks the same
   * after ten hours as at startup — the same reason the blobs use reflection.
   */
  private stepBridges(start: number, end: number, time: number): void {
    const { bridgeTravelSeconds, bridgeWidth } = this.config;
    const rate = 1 / bridgeTravelSeconds;

    for (let i = start; i < end; i++) {
      const i3 = i * 3;
      const from = this.wells[this.anchor[i]];
      const to = this.wells[this.target[i]];
      if (!from || !to) {
        this.alphas[i] = 0;
        continue;
      }

      const t = (time * rate + this.extent[i]) % 1;

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-3) {
        this.alphas[i] = 0;
        continue;
      }

      // Pinched waist: wide where it leaves the source, narrow where it arrives, so it reads as a
      // stream being drawn in rather than a straight tube.
      const taper = t < 0.5 ? 1.4 - 1.0 * (t / 0.5) : 0.4 - 0.16 * ((t - 0.5) / 0.5);
      const spread = bridgeWidth * taper;

      // Perpendicular in the xy plane; z is offset directly for thickness.
      const px = -dy / length;
      const py = dx / length;

      const wobble = Math.sin(time * 1.7 + this.lateral[i3 + 2]) * 7;

      this.positions[i3] = from.x + dx * t + px * this.lateral[i3] * spread + wobble * px;
      this.positions[i3 + 1] = from.y + dy * t + py * this.lateral[i3] * spread + wobble * py;
      this.positions[i3 + 2] = this.lateral[i3 + 1] * spread;

      // Fade in and out at the ends so particles do not pop into existence.
      let fade = 1;
      if (t < 0.12) fade = t / 0.12;
      else if (t > 0.86) fade = (1 - t) / 0.14;
      this.alphas[i] = this.baseAlpha[i] * fade;
    }
  }
}
