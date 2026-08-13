/**
 * The simulation: one gravity well per screen, and a cloud of particles orbiting in the combined
 * field of all of them.
 *
 * World space is virtual-desktop physical pixels with Y negated so that Y increases upward, matching
 * the orthographic cameras. Wells sit in the z = 0 plane while particles orbit in full 3D, which is
 * what gives each blob volume rather than looking like a flat disc.
 *
 * Nothing here may use `Math.random`, `Date.now` or the frame delta: every pane runs this same
 * simulation independently and they must stay identical, so all randomness comes from the shared
 * seed and time advances only in fixed steps.
 */
import { createRandom, type Random } from "./rng";
import type { Rgb } from "@shared/palette";

export type Well = {
  displayId: number;
  /** World position; wells always lie in the z = 0 plane. */
  x: number;
  y: number;
  mass: number;
  colour: Rgb;
};

export type SimConfig = {
  /** Gravitational constant, in px^3 / (mass * s^2). Tuned against pixel-scale distances. */
  gravity: number;
  /** Plummer softening length, in px. Removes the singularity at a well's centre. */
  softening: number;
  particlesPerWell: number;
  /** Target cloud radius, in px. */
  blobRadius: number;
  /** Velocity retained per second. Slightly below 1 so the cloud cannot slowly heat up. */
  drag: number;
  /** How strongly speeds are nudged toward the local circular-orbit speed, per second. */
  orbitCorrection: number;
  /** Beyond this multiple of blobRadius a particle is treated as unbound and left to fall freely. */
  captureFactor: number;
  /** Beyond this multiple of blobRadius from every well, a particle is recycled. */
  escapeFactor: number;
  /** How fast a transferred particle takes on its new well's colour, per second. */
  colourBlend: number;
  timeStep: number;
};

export const DEFAULT_SIM_CONFIG: SimConfig = {
  gravity: 5200,
  softening: 26,
  particlesPerWell: 8000,
  // Large relative to the gap between screens on purpose. This is what makes the interaction real
  // rather than faked: the balance point between two equal wells sits midway between them, so the
  // clouds have to be big enough to actually reach it before any particle can cross.
  blobRadius: 380,
  drag: 0.994,
  // Kept low on purpose. This is the knob that holds the cloud together, and it directly opposes the
  // neighbouring well's pull — at 1.5 it flattened the lean between blobs to about 20px, which barely
  // read as interaction at all. Low enough to let the field distort the cloud, with drag and the
  // escape-and-respawn rule providing the remaining stability.
  orbitCorrection: 0.6,
  // Generous, so the outer fringe of each cloud is left unbound and free to drift toward the
  // neighbouring screen. This is what produces the stream across the bezel.
  captureFactor: 2.4,
  escapeFactor: 9,
  colourBlend: 0.5,
  timeStep: 1 / 120,
};

export class BlobWorld {
  readonly count: number;
  readonly positions: Float32Array;
  readonly colours: Float32Array;
  readonly sizes: Float32Array;
  readonly alphas: Float32Array;

  private readonly velocities: Float32Array;
  private readonly home: Int32Array;
  private readonly random: Random;
  private readonly config: SimConfig;
  private wells: Well[];
  private tick = 0;

  constructor(wells: Well[], config: SimConfig, seed: number) {
    this.config = config;
    this.wells = wells;
    this.random = createRandom(seed);
    this.count = Math.max(1, wells.length) * config.particlesPerWell;

    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.colours = new Float32Array(this.count * 3);
    this.sizes = new Float32Array(this.count);
    this.alphas = new Float32Array(this.count);
    this.home = new Int32Array(this.count);

    this.seedParticles();
  }

  get wellCount(): number {
    return this.wells.length;
  }

  private seedParticles(): void {
    const { particlesPerWell } = this.config;
    for (let i = 0; i < this.count; i++) {
      const wellIndex = this.wells.length > 0 ? Math.floor(i / particlesPerWell) % this.wells.length : 0;
      this.home[i] = wellIndex;
      // Wide size spread with a large maximum. Density alone cannot build brightness at this
      // particle count — roughly 0.06 particles per pixel — so the glow has to come from many large
      // sprites overlapping additively.
      this.sizes[i] = this.random.range(2, 11);
      this.alphas[i] = this.random.range(0.35, 0.95);
      const colour = this.wells[wellIndex]?.colour ?? [1, 1, 1];
      this.colours[i * 3 + 0] = colour[0];
      this.colours[i * 3 + 1] = colour[1];
      this.colours[i * 3 + 2] = colour[2];
      this.spawn(i, wellIndex);
    }
  }

  /**
   * Place a particle on a near-circular orbit around its well.
   *
   * Randomising the orbital plane per particle is what makes the cloud a sphere: the orbits are
   * individually circular but collectively cover every orientation. It also means the blob holds its
   * shape from angular momentum rather than from any artificial containment.
   */
  private spawn(index: number, wellIndex: number): void {
    const well = this.wells[wellIndex];
    if (!well) return;
    const { gravity, blobRadius, softening } = this.config;
    const i3 = index * 3;

    const dir: [number, number, number] = [0, 0, 0];
    this.random.onSphere(dir);
    // Cube-root keeps the interior from being sparser than the shell.
    const radius = blobRadius * Math.cbrt(this.random.range(0.06, 1));

    this.positions[i3 + 0] = well.x + dir[0] * radius;
    this.positions[i3 + 1] = well.y + dir[1] * radius;
    this.positions[i3 + 2] = dir[2] * radius;

    // Circular-orbit speed for the softened potential at this radius.
    const denom = Math.sqrt(radius * radius + softening * softening);
    const speed = Math.sqrt((gravity * well.mass * radius * radius) / (denom * denom * denom)) || 0;

    // Any axis not parallel to the radius gives a valid orbital plane.
    const axis: [number, number, number] = [0, 0, 0];
    this.random.onSphere(axis);
    let tx = dir[1] * axis[2] - dir[2] * axis[1];
    let ty = dir[2] * axis[0] - dir[0] * axis[2];
    let tz = dir[0] * axis[1] - dir[1] * axis[0];
    const len = Math.hypot(tx, ty, tz);
    if (len < 1e-6) {
      tx = -dir[1];
      ty = dir[0];
      tz = 0;
    } else {
      tx /= len;
      ty /= len;
      tz /= len;
    }

    const jitter = this.random.range(0.86, 1.1);
    this.velocities[i3 + 0] = tx * speed * jitter;
    this.velocities[i3 + 1] = ty * speed * jitter;
    this.velocities[i3 + 2] = tz * speed * jitter;
  }

  /** Rebuild for a new display arrangement, keeping particle identity where the well still exists. */
  reconfigure(wells: Well[]): void {
    this.wells = wells;
    for (let i = 0; i < this.count; i++) {
      if (this.home[i] >= wells.length) this.home[i] = wells.length > 0 ? i % wells.length : 0;
      this.spawn(i, this.home[i]);
    }
  }

  /** Advance to the given absolute tick, capped so a stall cannot spiral into a long catch-up. */
  advanceTo(targetTick: number, maxSteps = 8): void {
    let steps = 0;
    while (this.tick < targetTick && steps < maxSteps) {
      this.step();
      this.tick += 1;
      steps += 1;
    }
    // Too far behind to catch up honestly; resynchronise rather than accumulate lag forever.
    if (this.tick < targetTick) this.tick = targetTick;
  }

  private step(): void {
    const { gravity, softening, timeStep: dt, drag, orbitCorrection, blobRadius } = this.config;
    const wells = this.wells;
    if (wells.length === 0) return;

    const soft2 = softening * softening;
    const captureRadius = blobRadius * this.config.captureFactor;
    const escapeRadius = blobRadius * this.config.escapeFactor;
    const dragFactor = Math.pow(drag, dt);
    const colourStep = Math.min(1, this.config.colourBlend * dt);

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const px = this.positions[i3];
      const py = this.positions[i3 + 1];
      const pz = this.positions[i3 + 2];

      let ax = 0;
      let ay = 0;
      let az = 0;
      let nearest = 0;
      let nearestDist2 = Infinity;

      // Every particle sees the identical field. An earlier version boosted the pull from wells other
      // than the particle's own to make the interaction visible, which produced a bug worth
      // remembering: as soon as a particle drifted close enough to be captured, its home flipped, the
      // boost flipped with it, and it was yanked back. Particles piled up at a spurious equilibrium
      // between the blobs instead of reaching either one. Per-particle asymmetry in a shared field is
      // never safe; the lean now comes from displacing the wells themselves.
      for (let w = 0; w < wells.length; w++) {
        const well = wells[w];
        const dx = well.x - px;
        const dy = well.y - py;
        const dz = -pz;
        const plain = dx * dx + dy * dy + dz * dz;
        if (plain < nearestDist2) {
          nearestDist2 = plain;
          nearest = w;
        }
        const d2 = plain + soft2;
        // G * M / d^3, so multiplying by the displacement gives the acceleration.
        const inv = (gravity * well.mass) / (d2 * Math.sqrt(d2));
        ax += dx * inv;
        ay += dy * inv;
        az += dz * inv;
      }

      let vx = (this.velocities[i3] + ax * dt) * dragFactor;
      let vy = (this.velocities[i3 + 1] + ay * dt) * dragFactor;
      let vz = (this.velocities[i3 + 2] + az * dt) * dragFactor;

      // A particle that drifts closer to another well than to its own has been captured: it belongs
      // to that blob now, and its colour follows. This is what makes the stream between two screens
      // read as material moving from one to the other.
      if (nearest !== this.home[i] && nearestDist2 < captureRadius * captureRadius) {
        this.home[i] = nearest;
      }

      const homeWell = wells[this.home[i]] ?? wells[nearest];
      const hx = px - homeWell.x;
      const hy = py - homeWell.y;
      const r = Math.hypot(hx, hy, pz);

      if (r < captureRadius) {
        // Bound: hold the orbit near circular so the cloud keeps a stable radius over hours.
        // Unbound particles are deliberately left alone so they can stream away freely.
        const denom = Math.sqrt(r * r + soft2);
        const target = Math.sqrt((gravity * homeWell.mass * r * r) / (denom * denom * denom));
        const speed = Math.hypot(vx, vy, vz);
        if (speed > 1e-4 && target > 1e-4) {
          const scale = 1 + Math.min(1, orbitCorrection * dt) * (target / speed - 1);
          vx *= scale;
          vy *= scale;
          vz *= scale;
        }
      }

      this.velocities[i3] = vx;
      this.velocities[i3 + 1] = vy;
      this.velocities[i3 + 2] = vz;

      this.positions[i3] = px + vx * dt;
      this.positions[i3 + 1] = py + vy * dt;
      this.positions[i3 + 2] = pz + vz * dt;

      if (r > escapeRadius) {
        this.spawn(i, this.home[i]);
        continue;
      }

      const target = homeWell.colour;
      const c3 = i3;
      this.colours[c3] += (target[0] - this.colours[c3]) * colourStep;
      this.colours[c3 + 1] += (target[1] - this.colours[c3 + 1]) * colourStep;
      this.colours[c3 + 2] += (target[2] - this.colours[c3 + 2]) * colourStep;
    }
  }
}
