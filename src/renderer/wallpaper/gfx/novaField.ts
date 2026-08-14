/**
 * "Nova" — a dense granular form turning slowly in the dark, over a faint halftone field.
 *
 * The form is generated rather than loaded from a model. Points are scattered on a sphere, pushed out
 * to a shell, then deformed by low-frequency noise and stretched along a tilted axis. That gives an
 * organic body with no asset dependency, which matters for a wallpaper: nothing to ship, nothing to
 * break if a file goes missing, and it rescales freely to any screen.
 *
 * Two decisions carry the look:
 *
 *   - **Points sit in a shell, not a solid volume.** Concentrating them near the surface is what makes
 *     a cloud of dots read as a form with a silhouette. Fill the interior evenly and it collapses into
 *     a fog with no shape.
 *   - **The colour ramp passes through white.** Going from one screen's colour to the other's directly
 *     would cross grey in the middle, exactly the muddiness that had to be fixed in Lumen. Routing the
 *     ramp through a white highlight keeps every step bright and gives the form its lit look.
 *
 * Rotation happens in the vertex shader from a shared clock, so nothing accumulates and every pane
 * agrees without exchanging state.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  Mesh,
  OneFactor,
  PlaneGeometry,
  Points,
  ShaderMaterial,
} from "three";
import type { Bounds } from "@shared/types";
import type { Rgb } from "@shared/themes";
import { createRandom } from "../sim/rng";

const VERTEX_SHADER = /* glsl */ `
attribute vec3 centre;
attribute vec3 offset;
attribute float spin;
attribute float size;
attribute float alpha;
attribute float phase;
attribute vec3 colour;

uniform float time;
uniform float pixelScale;
uniform float drift;

varying vec3 vColour;
varying float vAlpha;

void main() {
  // Two axes of rotation at different rates, so the form never settles into an obvious loop.
  float a = time * 0.18;
  float b = time * 0.11;
  float ca = cos(a), sa = sin(a);
  float cb = cos(b), sb = sin(b);

  vec3 p = offset;
  p = vec3(p.x * ca + p.z * sa, p.y, -p.x * sa + p.z * ca);
  p = vec3(p.x, p.y * cb - p.z * sb, p.y * sb + p.z * cb);

  // Ambient motes carry spin = 0, so they hang still while the body turns.
  vec3 local = mix(offset, p, spin);

  // Gentle independent wander, keyed off each point's own phase.
  local.x += sin(time * 0.6 + phase) * drift;
  local.y += cos(time * 0.5 + phase * 1.3) * drift;

  vec4 world = modelMatrix * vec4(centre + local, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;

  vColour = colour;
  vAlpha = alpha;
  gl_PointSize = size * pixelScale;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec3 vColour;
varying float vAlpha;

uniform float brightness;

void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (d > 1.0) discard;
  // Solid centre with a short rim, matching the crisp dots of the reference rather than soft blobs.
  float intensity = smoothstep(1.0, 0.5, d) * vAlpha;
  if (intensity < 0.004) discard;
  gl_FragColor = vec4(vColour * intensity * brightness, intensity);
}
`;

/** Faint dot grid behind the form, the texture that keeps the empty areas from reading as dead flat. */
const GRID_VERTEX = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const GRID_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vLocal;
uniform float spacing;
uniform float strength;
uniform vec3 tint;

void main() {
  vec2 cell = fract(vLocal / spacing) - 0.5;
  float dot = 1.0 - smoothstep(0.06, 0.16, length(cell));
  if (dot < 0.01) discard;
  float a = dot * strength;
  gl_FragColor = vec4(tint * a, a);
}
`;

export type NovaBody = {
  /** Body centre in world units. */
  x: number;
  y: number;
  colour: Rgb;
  /** Second colour the ramp runs toward, normally the neighbouring screen's. */
  accent: Rgb;
};

export type NovaConfig = {
  /** Points making up the form itself. */
  formPoints: number;
  /** Sparse motes scattered around it. */
  ambientPoints: number;
  /** Overall form radius in px before the stretch is applied. */
  radius: number;
  /** How far ambient motes spread beyond the form. */
  ambientSpread: number;
};

export const DEFAULT_NOVA_CONFIG: NovaConfig = {
  // Dense on purpose. The form is read entirely from the accumulation of dots, so below roughly ten
  // thousand it stops looking like a body and starts looking like scattered debris.
  formPoints: 15000,
  ambientPoints: 1100,
  radius: 300,
  ambientSpread: 2.6,
};

/** Cheap value noise, enough to give the shell its lumps. */
function wobble(x: number, y: number, z: number): number {
  const s = Math.sin(x * 1.7 + y * 2.3 + z * 1.1) + Math.sin(x * 3.1 - y * 1.3 + z * 2.7) * 0.5;
  return s / 1.5;
}

/**
 * Ramp from one colour to the other, lifted to white across a narrow band at the midpoint.
 *
 * A straight interpolation between two colours far apart on the wheel passes through grey. Rather
 * than avoid that, this leans into it: the white highlight is placed exactly where the grey would
 * be, so it is hidden under the brightest part of the form while both ends stay fully saturated.
 * Ramping linearly to white instead washes out most of the body and leaves almost no colour.
 */
function ramp(from: Rgb, accent: Rgb, t: number, out: [number, number, number]): void {
  const mid = 1 - Math.abs(t * 2 - 1);
  const white = mid * mid * mid;
  for (let i = 0; i < 3; i++) {
    const base = from[i] + (accent[i] - from[i]) * t;
    out[i] = base + (1 - base) * white;
  }
}

export class NovaField {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly grid: Mesh<PlaneGeometry, ShaderMaterial>;

  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly gridMaterial: ShaderMaterial;
  private gridGeometry: PlaneGeometry;

  constructor(
    region: Bounds,
    bodies: NovaBody[],
    config: NovaConfig,
    seed: number,
    pixelScale: number,
  ) {
    const random = createRandom(seed);
    const count = Math.max(1, bodies.length) * (config.formPoints + config.ambientPoints);

    const centres = new Float32Array(count * 3);
    const offsets = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const spins = new Float32Array(count);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const phases = new Float32Array(count);

    const dir: [number, number, number] = [0, 0, 0];
    const rgb: [number, number, number] = [0, 0, 0];
    // Fixed tilt so the form sits on a diagonal rather than square to the screen.
    const tilt = -0.58;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    let i = 0;
    for (const body of bodies) {
      for (let n = 0; n < config.formPoints; n++, i++) {
        random.onSphere(dir);

        // Most points land in a tight shell; a few stray outward so the silhouette has some fray.
        const stray = random.next();
        const shell = stray > 0.97 ? 1 + random.next() * 0.5 : 0.93 + Math.pow(random.next(), 0.5) * 0.07;
        const lumps = 1 + wobble(dir[0] * 1.6, dir[1] * 1.6, dir[2] * 1.6) * 0.22;
        const r = config.radius * shell * lumps;

        // Stretched along Y and slimmed across, then tilted, to make an elongated pod. The ratio has
        // to be well past what looks right in the numbers: rotation foreshortens the long axis for
        // most of the cycle, so a mild stretch reads as a round lump on screen.
        let px = dir[0] * r * 0.46;
        let py = dir[1] * r * 1.5;
        const pz = dir[2] * r * 0.46;
        const rx = px * cosT - py * sinT;
        const ry = px * sinT + py * cosT;
        px = rx;
        py = ry;

        const i3 = i * 3;
        centres[i3] = body.x;
        centres[i3 + 1] = body.y;
        centres[i3 + 2] = 0;
        offsets[i3] = px;
        offsets[i3 + 1] = py;
        offsets[i3 + 2] = pz;

        // Ramp position follows the tilted long axis, so the gradient runs through the form.
        ramp(body.colour, body.accent, Math.min(1, Math.max(0, py / (config.radius * 1.5) * 0.5 + 0.5)), rgb);
        colours[i3] = rgb[0];
        colours[i3 + 1] = rgb[1];
        colours[i3 + 2] = rgb[2];

        spins[i] = 1;
        sizes[i] = random.range(1.1, 4.2);
        alphas[i] = random.range(0.45, 1);
        phases[i] = random.range(0, Math.PI * 2);
      }

      for (let n = 0; n < config.ambientPoints; n++, i++) {
        const i3 = i * 3;
        const spread = config.radius * config.ambientSpread;
        centres[i3] = body.x;
        centres[i3 + 1] = body.y;
        centres[i3 + 2] = 0;
        offsets[i3] = random.range(-spread, spread);
        offsets[i3 + 1] = random.range(-spread, spread);
        offsets[i3 + 2] = random.range(-spread * 0.3, spread * 0.3);

        ramp(body.colour, body.accent, random.next(), rgb);
        colours[i3] = rgb[0];
        colours[i3 + 1] = rgb[1];
        colours[i3 + 2] = rgb[2];

        spins[i] = 0;
        sizes[i] = random.range(0.9, 2.4);
        alphas[i] = random.range(0.15, 0.55);
        phases[i] = random.range(0, Math.PI * 2);
      }
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(centres, 3));
    this.geometry.setAttribute("centre", new BufferAttribute(centres, 3));
    this.geometry.setAttribute("offset", new BufferAttribute(offsets, 3));
    this.geometry.setAttribute("colour", new BufferAttribute(colours, 3));
    this.geometry.setAttribute("spin", new BufferAttribute(spins, 1));
    this.geometry.setAttribute("size", new BufferAttribute(sizes, 1));
    this.geometry.setAttribute("alpha", new BufferAttribute(alphas, 1));
    this.geometry.setAttribute("phase", new BufferAttribute(phases, 1));

    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        time: { value: 0 },
        pixelScale: { value: pixelScale },
        brightness: { value: 1 },
        drift: { value: 6 },
      },
      // Premultiplied additive, matching the transparent panes.
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });

    this.points = new Points(this.geometry, this.material);
    // The cloud spans the whole virtual desktop while each pane shows one slice, so a single bounds
    // test would cull all or nothing.
    this.points.frustumCulled = false;

    this.gridGeometry = new PlaneGeometry(1, 1);
    this.gridMaterial = new ShaderMaterial({
      vertexShader: GRID_VERTEX,
      fragmentShader: GRID_FRAGMENT,
      uniforms: {
        spacing: { value: 26 },
        // Deliberately near-invisible. The panes are transparent, so this sits over the real desktop
        // and anything stronger would haze the icons behind it.
        strength: { value: 0.05 },
        tint: { value: [0.55, 0.6, 0.72] },
      },
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this.grid = new Mesh(this.gridGeometry, this.gridMaterial);
    this.grid.frustumCulled = false;
    this.setRegion(region);
  }

  setRegion(region: Bounds): void {
    this.gridGeometry.dispose();
    this.gridGeometry = new PlaneGeometry(region.width, region.height);
    this.grid.geometry = this.gridGeometry;
    this.grid.position.set(region.x + region.width / 2, -(region.y + region.height / 2), 0);
  }

  setBrightness(brightness: number): void {
    this.material.uniforms["brightness"].value = brightness;
  }

  setPixelScale(scale: number): void {
    this.material.uniforms["pixelScale"].value = scale;
  }

  setDrift(drift: number): void {
    this.material.uniforms["drift"].value = 6 * drift;
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  update(seconds: number): void {
    this.material.uniforms["time"].value = seconds;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.gridGeometry.dispose();
    this.gridMaterial.dispose();
  }
}
