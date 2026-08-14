/**
 * "Nova" — a dense granular form that turns with the cursor, deforms under it, and trails a current
 * of motes to the form on the next screen.
 *
 * The form is generated rather than loaded from a model. Points are scattered on a sphere, pushed out
 * to a shell, then deformed by low-frequency noise and stretched along a tilted axis. That gives an
 * organic body with no asset dependency, which matters for a wallpaper: nothing to ship, nothing to
 * break if a file goes missing, and it rescales freely to any screen.
 *
 * Three decisions carry the look:
 *
 *   - **Points sit in a shell, not a solid volume.** Concentrating them near the surface is what makes
 *     a cloud of dots read as a form with a silhouette. Fill the interior evenly and it collapses into
 *     a fog with no shape.
 *   - **The colour ramp lifts to white across a narrow band at the midpoint.** A straight interpolation
 *     between two hues far apart on the wheel crosses grey. Rather than avoid that, the white highlight
 *     is placed exactly where the grey would fall, hiding it under the brightest part of the form while
 *     both ends stay saturated.
 *   - **Everything is a pure function of the shared clock and the cursor.** No integrated state, so all
 *     panes agree without exchanging anything, and the wallpaper cannot drift however long it runs.
 *
 * All three particle roles live in one buffer and one draw call, told apart by a `kind` attribute:
 * the form, the ambient motes around it, and the current flowing between screens.
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
  Vector2,
  Vector3,
} from "three";
import type { Bounds } from "@shared/types";
import type { Rgb } from "@shared/themes";
import { createRandom } from "../sim/rng";

/** Fixed-size arrays are a GLSL requirement; this bounds how many screens can be driven. */
const MAX_BODIES = 6;

const KIND_FORM = 0;
const KIND_AMBIENT = 1;
const KIND_LINK = 2;

const VERTEX_SHADER = /* glsl */ `
attribute vec3 centre;
attribute vec3 target;
attribute vec3 offset;
attribute float kind;
attribute float bodyIndex;
attribute float spin;
attribute float size;
attribute float alpha;
attribute float phase;
attribute vec3 colour;

uniform float time;
uniform float pixelScale;
uniform float drift;
uniform float flowSpeed;

uniform float bodyYaw[${MAX_BODIES}];
uniform float bodyPitch[${MAX_BODIES}];

uniform vec2 cursor;
uniform float cursorActive;
uniform float hoverRadius;
uniform float hoverStrength;
uniform vec3 linkBend;

varying vec3 vColour;
varying float vAlpha;

vec3 turn(vec3 p, float yaw, float pitch) {
  float cy = cos(yaw), sy = sin(yaw);
  float cp = cos(pitch), sp = sin(pitch);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  return p;
}

void main() {
  int bi = int(bodyIndex + 0.5);
  float yaw = 0.0;
  float pitch = 0.0;
  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (i == bi) { yaw = bodyYaw[i]; pitch = bodyPitch[i]; }
  }

  vec3 base;
  vec3 local;
  float fade = 1.0;

  if (kind < 1.5) {
    // Form and ambient motes. Ambient carries spin = 0 so it hangs still while the body turns.
    base = centre;
    local = mix(offset, turn(offset, yaw, pitch), spin);
  } else {
    // The current between screens: a quadratic bezier whose control point is pulled toward the
    // cursor, so the stream bends as you move across it.
    float t = fract(time * flowSpeed + phase);
    vec3 mid = (centre + target) * 0.5 + linkBend;
    vec3 a = mix(centre, mid, t);
    vec3 b = mix(mid, target, t);
    base = mix(a, b, t);
    // Widest across the middle of the trip, pinched at both ends where it meets a body.
    local = offset * sin(t * 3.14159);
    // Fade in and out so motes never pop into or out of existence at the endpoints.
    fade = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.88, t);
  }

  local.x += sin(time * 0.6 + phase) * drift;
  local.y += cos(time * 0.5 + phase * 1.3) * drift;

  vec4 world = modelMatrix * vec4(base + local, 1.0);

  // Hover distortion. A gaussian falloff keeps the push smooth right to its edge, where a linear
  // one would leave a visible ring at the cut-off radius.
  vec2 away = world.xy - cursor;
  float dist = length(away);
  float bulge = exp(-(dist * dist) / (hoverRadius * hoverRadius)) * hoverStrength * cursorActive;
  if (dist > 0.001) {
    world.xy += (away / dist) * bulge;
  }

  gl_Position = projectionMatrix * viewMatrix * world;

  vColour = colour;
  // Points lifted by the cursor brighten slightly, which reads as the form responding rather than
  // simply being shoved.
  vAlpha = alpha * fade * (1.0 + bulge / max(hoverRadius, 1.0) * 1.5);
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
  // Solid centre with a short rim: crisp dots rather than soft blobs.
  float intensity = smoothstep(1.0, 0.5, d) * vAlpha;
  if (intensity < 0.004) discard;
  gl_FragColor = vec4(vColour * intensity * brightness, intensity);
}
`;

/** Faint dot grid behind the form, the texture that keeps empty areas from reading as dead flat. */
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
  formPoints: number;
  ambientPoints: number;
  /** Motes in each current flowing between a pair of screens. */
  linkPoints: number;
  radius: number;
  ambientSpread: number;
};

export const DEFAULT_NOVA_CONFIG: NovaConfig = {
  // Dense on purpose. The form is read entirely from the accumulation of dots, so below roughly ten
  // thousand it stops looking like a body and starts looking like scattered debris.
  formPoints: 15000,
  ambientPoints: 1100,
  linkPoints: 1400,
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

  private bodies: NovaBody[];
  private readonly radius: number;

  /** Smoothed rotation per body, eased toward the cursor-derived target every frame. */
  private readonly yaw: number[] = [];
  private readonly pitch: number[] = [];
  private readonly cursor = new Vector2(0, 0);
  private hasCursor = false;
  private readonly bend = new Vector3();

  constructor(
    region: Bounds,
    bodies: NovaBody[],
    config: NovaConfig,
    seed: number,
    pixelScale: number,
  ) {
    const random = createRandom(seed);
    this.bodies = bodies;
    this.radius = config.radius;

    const bodyCount = Math.max(1, bodies.length);
    const pairs = Math.max(0, bodies.length - 1);
    const count = bodyCount * (config.formPoints + config.ambientPoints) + pairs * config.linkPoints;

    const centres = new Float32Array(count * 3);
    const targets = new Float32Array(count * 3);
    const offsets = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const kinds = new Float32Array(count);
    const indices = new Float32Array(count);
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
    for (let b = 0; b < bodies.length; b++) {
      const body = bodies[b];
      this.yaw.push(0);
      this.pitch.push(0);

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
        offsets[i3] = px;
        offsets[i3 + 1] = py;
        offsets[i3 + 2] = pz;

        ramp(body.colour, body.accent, Math.min(1, Math.max(0, (py / (config.radius * 1.5)) * 0.5 + 0.5)), rgb);
        colours[i3] = rgb[0];
        colours[i3 + 1] = rgb[1];
        colours[i3 + 2] = rgb[2];

        kinds[i] = KIND_FORM;
        indices[i] = b;
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
        offsets[i3] = random.range(-spread, spread);
        offsets[i3 + 1] = random.range(-spread, spread);
        offsets[i3 + 2] = random.range(-spread * 0.3, spread * 0.3);

        ramp(body.colour, body.accent, random.next(), rgb);
        colours[i3] = rgb[0];
        colours[i3 + 1] = rgb[1];
        colours[i3 + 2] = rgb[2];

        kinds[i] = KIND_AMBIENT;
        indices[i] = b;
        spins[i] = 0;
        sizes[i] = random.range(0.9, 2.4);
        alphas[i] = random.range(0.15, 0.55);
        phases[i] = random.range(0, Math.PI * 2);
      }
    }

    // The current between neighbouring screens.
    for (let b = 0; b + 1 < bodies.length; b++) {
      const from = bodies[b];
      const to = bodies[b + 1];
      for (let n = 0; n < config.linkPoints; n++, i++) {
        const i3 = i * 3;
        centres[i3] = from.x;
        centres[i3 + 1] = from.y;
        targets[i3] = to.x;
        targets[i3 + 1] = to.y;

        const spread = config.radius * 0.5;
        offsets[i3] = random.range(-spread, spread) * 0.35;
        offsets[i3 + 1] = random.range(-spread, spread);
        offsets[i3 + 2] = random.range(-spread, spread) * 0.5;

        // Coloured along the trip, so the stream reads as one body's material arriving at the other.
        ramp(from.colour, to.colour, random.next(), rgb);
        colours[i3] = rgb[0];
        colours[i3 + 1] = rgb[1];
        colours[i3 + 2] = rgb[2];

        kinds[i] = KIND_LINK;
        indices[i] = b;
        spins[i] = 0;
        sizes[i] = random.range(0.9, 2.8);
        alphas[i] = random.range(0.3, 0.85);
        // Phases spread evenly so the current is continuous rather than arriving in pulses.
        phases[i] = random.next();
      }
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(centres, 3));
    this.geometry.setAttribute("centre", new BufferAttribute(centres, 3));
    this.geometry.setAttribute("target", new BufferAttribute(targets, 3));
    this.geometry.setAttribute("offset", new BufferAttribute(offsets, 3));
    this.geometry.setAttribute("colour", new BufferAttribute(colours, 3));
    this.geometry.setAttribute("kind", new BufferAttribute(kinds, 1));
    this.geometry.setAttribute("bodyIndex", new BufferAttribute(indices, 1));
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
        flowSpeed: { value: 0.06 },
        bodyYaw: { value: new Array(MAX_BODIES).fill(0) },
        bodyPitch: { value: new Array(MAX_BODIES).fill(0) },
        cursor: { value: new Vector2(0, 0) },
        cursorActive: { value: 0 },
        hoverRadius: { value: config.radius * 0.9 },
        hoverStrength: { value: config.radius * 0.28 },
        linkBend: { value: new Vector3() },
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

  /** Cursor in world units. Pass null when its position is unknown. */
  setCursor(position: { x: number; y: number } | null): void {
    if (!position) {
      this.hasCursor = false;
      return;
    }
    this.hasCursor = true;
    this.cursor.set(position.x, position.y);
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

  setFlowSpeed(speed: number): void {
    this.material.uniforms["flowSpeed"].value = 0.06 * speed;
  }

  /**
   * Advance the animation.
   *
   * `seconds` comes from the shared epoch so panes stay in step. Cursor-driven values are eased here
   * rather than applied directly: the pointer arrives as discrete samples, and following it exactly
   * makes the form snap between positions instead of turning.
   */
  update(seconds: number, delta: number): void {
    const uniforms = this.material.uniforms;
    uniforms["time"].value = seconds;

    const ease = Math.min(1, delta * 3.5);
    const yawArray = uniforms["bodyYaw"].value as number[];
    const pitchArray = uniforms["bodyPitch"].value as number[];

    for (let b = 0; b < this.bodies.length && b < MAX_BODIES; b++) {
      const body = this.bodies[b];
      let targetYaw: number;
      let targetPitch: number;

      if (this.hasCursor) {
        // Rotation follows the cursor's offset from this body, clamped so a pointer far across the
        // desktop does not wind the form up indefinitely.
        const dx = (this.cursor.x - body.x) / (this.radius * 4);
        const dy = (this.cursor.y - body.y) / (this.radius * 4);
        targetYaw = Math.max(-1.6, Math.min(1.6, dx)) * 1.5;
        targetPitch = Math.max(-1.2, Math.min(1.2, dy)) * -1.1;
      } else {
        targetYaw = this.yaw[b];
        targetPitch = this.pitch[b];
      }

      // A slow idle turn underneath, so the form is never completely static when the cursor is idle.
      const idle = seconds * 0.06;
      this.yaw[b] += (targetYaw + idle - this.yaw[b]) * ease;
      this.pitch[b] += (targetPitch - this.pitch[b]) * ease;
      yawArray[b] = this.yaw[b];
      pitchArray[b] = this.pitch[b];
    }

    (uniforms["cursor"].value as Vector2).copy(this.cursor);
    const active = uniforms["cursorActive"] as { value: number };
    active.value += ((this.hasCursor ? 1 : 0) - active.value) * ease;

    // The current bows toward the cursor. Eased for the same reason as the rotation, and scaled down
    // so it bends rather than snapping onto the pointer.
    if (this.bodies.length > 1) {
      const a = this.bodies[0];
      const b = this.bodies[1];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const targetX = this.hasCursor ? (this.cursor.x - midX) * 0.35 : 0;
      const targetY = this.hasCursor ? (this.cursor.y - midY) * 0.35 : 0;
      this.bend.x += (targetX - this.bend.x) * Math.min(1, delta * 1.6);
      this.bend.y += (targetY - this.bend.y) * Math.min(1, delta * 1.6);
      (uniforms["linkBend"].value as Vector3).copy(this.bend);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.gridGeometry.dispose();
    this.gridMaterial.dispose();
  }
}
