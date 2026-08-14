/**
 * "Nova" — a dense granular form that turns with the cursor and deforms under it.
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
 * # Nothing a setting touches is baked into a buffer
 *
 * Shape offsets are stored in units of the body radius, colour is stored as a position along a ramp
 * rather than as a colour, and the buffers are allocated for the highest density the settings allow.
 * Size, colour and density are therefore uniforms, and changing one is a handful of float writes
 * instead of regenerating forty thousand points. That matters more than it sounds: a rebuild both
 * stalls the frame and resets the rotation to zero, so dragging a slider used to make the form flicker
 * and snap upright on every step.
 *
 * # Reaching between screens (Nova II)
 *
 * The connection is not a separate object placed in the gap. It is the bodies themselves: points on
 * the face turned toward the neighbouring screen are drawn out along the line between the two, while
 * their lateral offset is squeezed toward that line. The facing test is raised to a high power, so
 * only the cap actually pointing at the neighbour moves and the rest of the form is untouched.
 *
 * The result tapers by construction — the points pulled hardest are also squeezed hardest — so the
 * strand is thick where it leaves the body and thin where the two meet in the middle, and the join
 * back into the body is a smooth flare rather than a seam, because the pull falls off continuously
 * across the cap. Growth is a single scalar: at zero the bodies are ordinary and separate, and as it
 * rises the two strands extend until they overlap.
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
import { SETTING_RANGES } from "@shared/settings";
import type { Bounds } from "@shared/types";
import type { Rgb } from "@shared/themes";
import { createRandom } from "../sim/rng";

/** Fixed-size arrays are a GLSL requirement; this bounds how many screens can be driven. */
const MAX_BODIES = 6;

/**
 * Buffers are allocated for the densest setting and culled down to the current one in the vertex
 * shader, which is what turns a density change from a rebuild into a single float write. The cost is
 * vertex invocations for points that are never drawn — cheap, because a culled point produces no
 * fragments at all, and fragments are what additive point clouds are actually limited by.
 */
const DENSITY_HEADROOM = SETTING_RANGES.density.max;

const KIND_FORM = 0;
const KIND_AMBIENT = 1;

/** Seconds for the Nova II strands to grow from separate bodies to a complete connection. */
const GROW_SECONDS = 13;

const VERTEX_SHADER = /* glsl */ `
attribute vec3 centre;
attribute vec3 target;
attribute vec3 offset;
attribute float kind;
attribute float bodyIndex;
attribute float size;
attribute float alpha;
attribute float phase;
attribute float rank;
attribute float rampT;

uniform float time;
uniform float pixelScale;
uniform float drift;
uniform float radius;
uniform float densityCut;
uniform float reveal;

uniform float bodyYaw[${MAX_BODIES}];
uniform float bodyPitch[${MAX_BODIES}];
uniform vec3 bodyColour[${MAX_BODIES}];
uniform vec3 bodyAccent[${MAX_BODIES}];
uniform vec3 bodyBridge[${MAX_BODIES}];

uniform vec2 cursor;
uniform float cursorActive;

varying vec3 vColour;
varying float vAlpha;

/**
 * How sharply the reach is confined to the facing cap.
 *
 * This has to be high. The weight is a cosine raised to this power, so at 5 a point forty-five
 * degrees off-axis still moves a fifth of the way and the whole body warps into a hook; at 12 the
 * pull is spent by about thirty degrees and the form keeps its shape with a strand off one side.
 */
const float REACH_FOCUS = 12.0;
/** How far the strand is squeezed toward the axis where the pull is strongest. */
const float REACH_TAPER = 0.09;
/** Fraction of the gap each body reaches across. Slightly under half, so the two tips overlap. */
const float REACH_SPAN = 0.46;

vec3 turn(vec3 p, float yaw, float pitch) {
  float cy = cos(yaw), sy = sin(yaw);
  float cp = cos(pitch), sp = sin(pitch);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  return p;
}

/**
 * Ramp between two colours, lifted to white across a narrow band at the midpoint.
 * Matches the reasoning in the file header: the white hides the grey a straight mix would pass through.
 */
vec3 rampColour(vec3 from, vec3 to, float t) {
  float mid = 1.0 - abs(t * 2.0 - 1.0);
  float white = mid * mid * mid;
  vec3 base = mix(from, to, t);
  return base + (1.0 - base) * white;
}

void main() {
  // Density culling first: everything below is wasted work for a point that will not be drawn.
  if (rank > densityCut) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  int bi = int(bodyIndex + 0.5);
  float yaw = 0.0;
  float pitch = 0.0;
  vec3 cFrom = bodyColour[0];
  vec3 cTo = bodyAccent[0];
  vec3 cNear = bodyBridge[0];
  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (i == bi) {
      yaw = bodyYaw[i];
      pitch = bodyPitch[i];
      cFrom = bodyColour[i];
      cTo = bodyAccent[i];
      cNear = bodyBridge[i];
    }
  }

  // Ambient motes hang still in world space while the body turns, so the form reads as rotating
  // inside a cloud rather than the whole scene spinning.
  vec3 shape = kind < 0.5 ? turn(offset, yaw, pitch) : offset;
  float pull = 0.0;

  if (kind < 0.5 && reveal > 0.0) {
    vec3 toward = target - centre;
    float span = length(toward);
    if (span > 0.001) {
      vec3 axis = toward / span;

      // Only the cap facing the neighbour is affected. The high power is what keeps this a strand
      // drawn out of one side rather than the whole body drifting across.
      float facing = clamp(dot(normalize(shape), axis), 0.0, 1.0);
      pull = pow(facing, REACH_FOCUS) * reveal;

      float along = dot(shape, axis);
      vec3 lateral = shape - axis * along;

      // Extend along the axis and squeeze across it. Both scale with the same weight, which is what
      // makes the strand taper on its own instead of needing a separate profile.
      shape = axis * (along + pull * (span * REACH_SPAN) / radius)
            + lateral * mix(1.0, REACH_TAPER, pull);

      // A slow sway perpendicular to the axis, so the strand is a curve that breathes rather than a
      // straight rod. Driven by the shared clock, so every pane places it identically.
      shape += vec3(-axis.y, axis.x, 0.0) * sin(time * 0.13 + float(bi)) * pull * 0.15;
    }
  }

  vec3 local = shape * radius;
  local.x += sin(time * 0.6 + phase) * drift;
  local.y += cos(time * 0.5 + phase * 1.3) * drift;

  vec4 world = modelMatrix * vec4(centre + local, 1.0);

  // Hover distortion. A gaussian falloff keeps the push smooth right to its edge, where a linear one
  // would leave a visible ring at the cut-off radius.
  float hoverRadius = radius * 0.9;
  vec2 away = world.xy - cursor;
  float dist = length(away);
  float bulge = exp(-(dist * dist) / (hoverRadius * hoverRadius)) * radius * 0.28 * cursorActive;
  if (dist > 0.001) {
    world.xy += (away / dist) * bulge;
  }

  gl_Position = projectionMatrix * viewMatrix * world;

  // The drawn-out tip takes on the neighbour's colour, so where the two strands overlap they agree
  // and the join reads as one connection instead of two spikes meeting.
  vColour = mix(rampColour(cFrom, cTo, rampT), cNear, pull * 0.6);

  // Fade out approaching the density cut so points dissolve as the slider moves rather than popping.
  float fade = 1.0 - smoothstep(densityCut - 0.05, densityCut, rank);
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

/** How neighbouring screens are joined: not at all, or by each body reaching toward the other. */
export type NovaLink = "none" | "reach";

export type NovaConfig = {
  formPoints: number;
  ambientPoints: number;
  link: NovaLink;
  radius: number;
  ambientSpread: number;
  /** Starting density multiplier. Set here rather than eased in, so startup shows no growth. */
  density: number;
};

export const DEFAULT_NOVA_CONFIG: NovaConfig = {
  // Dense on purpose. The form is read entirely from the accumulation of dots, so below roughly ten
  // thousand it stops looking like a body and starts looking like scattered debris.
  formPoints: 15000,
  ambientPoints: 1100,
  link: "none",
  radius: 300,
  ambientSpread: 2.6,
  density: 1,
};

/** Cheap value noise, enough to give the shell its lumps. */
function wobble(x: number, y: number, z: number): number {
  const s = Math.sin(x * 1.7 + y * 2.3 + z * 1.1) + Math.sin(x * 3.1 - y * 1.3 + z * 2.7) * 0.5;
  return s / 1.5;
}

/**
 * The body each one reaches toward: the next screen, or the previous for the last.
 * With a single display there is no neighbour and nothing reaches anywhere.
 */
function neighbourOf(bodies: NovaBody[], index: number): NovaBody | null {
  return bodies[index + 1] ?? bodies[index - 1] ?? null;
}

export class NovaField {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly grid: Mesh<PlaneGeometry, ShaderMaterial>;

  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly gridMaterial: ShaderMaterial;
  private gridGeometry: PlaneGeometry;

  private bodies: NovaBody[];
  private readonly link: NovaLink;

  /** Eased so a slider drag glides instead of stepping. */
  private radius: number;
  private radiusTarget: number;
  private densityCut: number;
  private densityTarget: number;
  private growthSpeed = 1;

  /** Smoothed rotation per body, eased toward the cursor-derived target every frame. */
  private readonly yaw: number[] = [];
  private readonly pitch: number[] = [];
  private readonly cursor = new Vector2(0, 0);
  private hasCursor = false;
  /** Clock reading when this field first drew, so the strands grow from the moment it appears. */
  private startedAt: number | null = null;

  constructor(
    region: Bounds,
    bodies: NovaBody[],
    config: NovaConfig,
    seed: number,
    pixelScale: number,
  ) {
    const random = createRandom(seed);
    this.bodies = bodies;
    this.link = config.link;
    this.radius = config.radius;
    this.radiusTarget = config.radius;
    this.densityCut = Math.min(1, Math.max(0, config.density / DENSITY_HEADROOM));
    this.densityTarget = this.densityCut;

    const alloc = (n: number): number => Math.ceil(n * DENSITY_HEADROOM);
    const formAlloc = alloc(config.formPoints);
    const ambientAlloc = alloc(config.ambientPoints);
    const count = Math.max(1, bodies.length) * (formAlloc + ambientAlloc);

    const centres = new Float32Array(count * 3);
    const targets = new Float32Array(count * 3);
    const offsets = new Float32Array(count * 3);
    const kinds = new Float32Array(count);
    const indices = new Float32Array(count);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const phases = new Float32Array(count);
    const ranks = new Float32Array(count);
    const rampTs = new Float32Array(count);

    const dir: [number, number, number] = [0, 0, 0];
    // Fixed tilt so the form sits on a diagonal rather than square to the screen.
    const tilt = -0.58;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    let i = 0;
    for (let b = 0; b < bodies.length; b++) {
      const body = bodies[b];
      const neighbour = neighbourOf(bodies, b);
      this.yaw.push(0);
      this.pitch.push(0);

      for (let n = 0; n < formAlloc; n++, i++) {
        random.onSphere(dir);

        // Most points land in a tight shell; a few stray outward so the silhouette has some fray.
        const stray = random.next();
        const shell = stray > 0.97 ? 1 + random.next() * 0.5 : 0.93 + Math.pow(random.next(), 0.5) * 0.07;
        const lumps = 1 + wobble(dir[0] * 1.6, dir[1] * 1.6, dir[2] * 1.6) * 0.22;
        const r = shell * lumps;

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
        if (neighbour) {
          targets[i3] = neighbour.x;
          targets[i3 + 1] = neighbour.y;
        } else {
          // No neighbour: point the axis at itself so `span` is zero and the reach is skipped.
          targets[i3] = body.x;
          targets[i3 + 1] = body.y;
        }
        // Stored in units of the body radius, so radius stays a uniform.
        offsets[i3] = px;
        offsets[i3 + 1] = py;
        offsets[i3 + 2] = pz;

        rampTs[i] = Math.min(1, Math.max(0, (py / 1.5) * 0.5 + 0.5));
        kinds[i] = KIND_FORM;
        indices[i] = b;
        sizes[i] = random.range(1.1, 4.2);
        alphas[i] = random.range(0.45, 1);
        phases[i] = random.range(0, Math.PI * 2);
        ranks[i] = n / formAlloc;
      }

      for (let n = 0; n < ambientAlloc; n++, i++) {
        const i3 = i * 3;
        const spread = config.ambientSpread;
        centres[i3] = body.x;
        centres[i3 + 1] = body.y;
        offsets[i3] = random.range(-spread, spread);
        offsets[i3 + 1] = random.range(-spread, spread);
        offsets[i3 + 2] = random.range(-spread * 0.3, spread * 0.3);

        rampTs[i] = random.next();
        kinds[i] = KIND_AMBIENT;
        indices[i] = b;
        sizes[i] = random.range(0.9, 2.4);
        alphas[i] = random.range(0.15, 0.55);
        phases[i] = random.range(0, Math.PI * 2);
        ranks[i] = n / ambientAlloc;
      }
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(centres, 3));
    this.geometry.setAttribute("centre", new BufferAttribute(centres, 3));
    this.geometry.setAttribute("target", new BufferAttribute(targets, 3));
    this.geometry.setAttribute("offset", new BufferAttribute(offsets, 3));
    this.geometry.setAttribute("kind", new BufferAttribute(kinds, 1));
    this.geometry.setAttribute("bodyIndex", new BufferAttribute(indices, 1));
    this.geometry.setAttribute("size", new BufferAttribute(sizes, 1));
    this.geometry.setAttribute("alpha", new BufferAttribute(alphas, 1));
    this.geometry.setAttribute("phase", new BufferAttribute(phases, 1));
    this.geometry.setAttribute("rank", new BufferAttribute(ranks, 1));
    this.geometry.setAttribute("rampT", new BufferAttribute(rampTs, 1));

    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        time: { value: 0 },
        pixelScale: { value: pixelScale },
        brightness: { value: 1 },
        drift: { value: 6 },
        radius: { value: this.radius },
        densityCut: { value: this.densityCut },
        reveal: { value: 0 },
        bodyYaw: { value: new Array(MAX_BODIES).fill(0) },
        bodyPitch: { value: new Array(MAX_BODIES).fill(0) },
        bodyColour: { value: Array.from({ length: MAX_BODIES }, () => new Vector3()) },
        bodyAccent: { value: Array.from({ length: MAX_BODIES }, () => new Vector3()) },
        bodyBridge: { value: Array.from({ length: MAX_BODIES }, () => new Vector3()) },
        cursor: { value: new Vector2(0, 0) },
        cursorActive: { value: 0 },
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
    this.setBodies(bodies);

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

  /**
   * Update colours without touching the buffers.
   *
   * Positions are not read from here — those are baked, and a layout change rebuilds the field — but
   * a colour change is only these three uniform arrays.
   */
  setBodies(bodies: NovaBody[]): void {
    this.bodies = bodies;
    const uniforms = this.material.uniforms;
    const colour = uniforms["bodyColour"].value as Vector3[];
    const accent = uniforms["bodyAccent"].value as Vector3[];
    const bridge = uniforms["bodyBridge"].value as Vector3[];

    for (let b = 0; b < MAX_BODIES; b++) {
      const body = bodies[Math.min(b, bodies.length - 1)];
      if (!body) continue;
      colour[b].set(body.colour[0], body.colour[1], body.colour[2]);
      accent[b].set(body.accent[0], body.accent[1], body.accent[2]);
      // The colour the strand leaving body b is heading toward, so the two tips agree where they meet.
      const near = neighbourOf(bodies, Math.min(b, bodies.length - 1)) ?? body;
      bridge[b].set(near.colour[0], near.colour[1], near.colour[2]);
    }
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

  /** Scales how quickly the strands reach across. No effect when there is nothing to connect. */
  setGrowthSpeed(speed: number): void {
    this.growthSpeed = Math.max(0.05, speed);
  }

  /** Body radius in world units. Eased in `update`, so this may be called on every slider step. */
  setRadius(radius: number): void {
    this.radiusTarget = radius;
  }

  /** Density as a multiplier of the tuned default. Eased, and clamped to the allocated headroom. */
  setDensity(density: number): void {
    this.densityTarget = Math.min(1, Math.max(0, density / DENSITY_HEADROOM));
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
    const settle = Math.min(1, delta * 4);

    // Settings are eased rather than applied outright, so dragging a slider glides through the
    // change instead of stepping through it.
    this.radius += (this.radiusTarget - this.radius) * settle;
    this.densityCut += (this.densityTarget - this.densityCut) * settle;
    uniforms["radius"].value = this.radius;
    uniforms["densityCut"].value = this.densityCut;

    if (this.link === "reach") {
      // Measured from the field's first frame, not from the shared epoch, so the bodies are always
      // separate at the moment the style is switched on. Panes rebuild together, so they agree.
      if (this.startedAt === null) this.startedAt = seconds;
      const age = ((seconds - this.startedAt) * this.growthSpeed) / GROW_SECONDS;
      const t = Math.min(1, Math.max(0, age));
      // Smootherstep: arrives and leaves without a visible kick at either end of the growth.
      uniforms["reveal"].value = t * t * t * (t * (t * 6 - 15) + 10);
    }

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
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.gridGeometry.dispose();
    this.gridMaterial.dispose();
  }
}
