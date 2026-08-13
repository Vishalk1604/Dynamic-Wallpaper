/**
 * "Aether" — volumetric liquid mist flowing between the screens.
 *
 * This is a raymarcher rather than particles. Each pixel steps through a 3D density field and
 * accumulates colour front to back, which is what produces genuine depth: where the ray passes
 * through more of the field the result is thicker and more opaque, and where it clips an edge it
 * stays wispy and translucent. A flat 2D blur cannot do that — it would be uniformly semi-transparent
 * and read as a sticker rather than as a volume.
 *
 * The field is a capsule joining the screens, so the mist genuinely spans the gap instead of being
 * two separate clouds, and it is eroded by animated fractal noise to break up any hint of a solid
 * shape. Colour is a distance-weighted blend of the per-screen colours, so the two hues meet and
 * marble into each other in the middle.
 *
 * Output is premultiplied alpha, matching the transparent panes, so the desktop shows through wherever
 * the mist is thin.
 */
import { DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from "three";
import type { Bounds } from "@shared/types";
import type { Rgb } from "@shared/themes";

/** Upper bound on wells the shader can take; arrays must be fixed-size in GLSL. */
const MAX_WELLS = 6;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vWorld;
void main() {
  // The mesh is placed in world units, so its own vertex positions are the world coordinates the
  // fragment shader needs to march from.
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xy;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vWorld;

uniform vec2 wellPos[${MAX_WELLS}];
uniform vec3 wellColour[${MAX_WELLS}];
uniform int wellCount;
uniform float radius;
uniform float time;
uniform float brightness;
uniform float detail;
uniform int steps;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// Trilinear value noise. Cheaper than gradient noise and, once fractal-summed and used only as an
// erosion mask, visually indistinguishable here.
float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
        mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
        mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/** Distance to a capsule, used to join the screens into one continuous body of mist. */
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  // Waist: thinner across the middle so it reads as drawn out between the screens rather than as a
  // uniform pipe.
  float taper = mix(1.0, 0.34, sin(h * 3.14159));
  return length(pa - ba * h) - r * taper;
}

float shapeAt(vec3 p) {
  float d = 1e9;
  if (wellCount == 1) {
    d = length(p - vec3(wellPos[0], 0.0)) - radius;
  } else {
    for (int i = 0; i < ${MAX_WELLS}; i++) {
      if (i >= wellCount - 1) break;
      d = min(d, sdCapsule(p, vec3(wellPos[i], 0.0), vec3(wellPos[i + 1], 0.0), radius));
    }
  }
  return d;
}

float densityAt(vec3 p) {
  float d = shapeAt(p);
  // Wide soft boundary; a hard edge would look like a solid object rather than vapour.
  float body = smoothstep(radius * 0.7, -radius * 0.35, d);
  if (body <= 0.001) return 0.0;

  // Two noise fields drifting in opposite directions give a churning, liquid motion instead of a
  // texture sliding across the screen.
  vec3 q = p * detail;
  float n1 = fbm(q + vec3(time * 0.06, time * 0.021, time * 0.037));
  float n2 = fbm(q * 2.1 - vec3(time * 0.043, -time * 0.031, time * 0.05));
  float clouds = n1 * 0.7 + n2 * 0.45;

  // Subtracting a high threshold before scaling is what carves holes clean through the volume. A
  // low threshold leaves noise everywhere, every ray hits something, and the result reads as one
  // solid slab of colour rather than as vapour with gaps to see through.
  return clamp(body * (clouds - 0.46) * 3.4, 0.0, 1.0);
}

vec3 colourAt(vec3 p) {
  vec3 acc = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < ${MAX_WELLS}; i++) {
    if (i >= wellCount) break;
    float dist = length(p.xy - wellPos[i]) + radius * 0.35;
    // Inverse-square weighting keeps each screen's colour dominant near it while blending smoothly
    // across the middle.
    float w = 1.0 / (dist * dist);
    acc += wellColour[i] * w;
    total += w;
  }
  return total > 0.0 ? acc / total : vec3(1.0);
}

void main() {
  // Orthographic camera, so every ray is parallel and marches straight along z.
  float extent = radius * 1.6;
  float stepSize = (extent * 2.0) / float(steps);

  // Per-pixel jitter of the start point. Without it, evenly spaced samples produce visible banding
  // where the slabs line up; the noise turns that into grain the eye ignores.
  float jitter = hash(vec3(vWorld * 0.37, 1.0)) * stepSize;

  vec3 p = vec3(vWorld, -extent + jitter);
  vec4 acc = vec4(0.0);

  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    float d = densityAt(p);
    if (d > 0.002) {
      // Deliberately small. Each step must contribute only a little, so that opacity is genuinely
      // the sum of how much volume the ray crossed. Too large and alpha saturates within a handful
      // of steps, flattening every depth difference into the same solid colour.
      float a = clamp(d * stepSize * 0.0042, 0.0, 1.0);
      vec3 c = colourAt(p);
      // Front-to-back compositing: nearer samples occlude those behind them.
      acc.rgb += (1.0 - acc.a) * c * a;
      acc.a += (1.0 - acc.a) * a;
      if (acc.a > 0.985) break;
    }
    p.z += stepSize;
  }

  if (acc.a < 0.002) discard;
  gl_FragColor = vec4(acc.rgb * brightness, acc.a);
}
`;

export type MistWell = {
  x: number;
  y: number;
  colour: Rgb;
};

export class MistField {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly material: ShaderMaterial;
  private geometry: PlaneGeometry;

  constructor(region: Bounds, wells: MistWell[], radius: number) {
    this.geometry = new PlaneGeometry(1, 1);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        wellPos: { value: Array.from({ length: MAX_WELLS }, () => new Vector2()) },
        wellColour: { value: Array.from({ length: MAX_WELLS }, () => new Vector3(1, 1, 1)) },
        wellCount: { value: 0 },
        radius: { value: radius },
        time: { value: 0 },
        brightness: { value: 1 },
        detail: { value: 0.0085 },
        steps: { value: 48 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.setRegion(region);
    this.setWells(wells, radius);
  }

  /**
   * Cover the pane's slice of world space, extended a little past its edges.
   *
   * The margin matters: mist drifting just outside the monitor still contributes to what is visible
   * at the very edge, and a plane cut exactly to the region would clip it into a straight line.
   */
  setRegion(region: Bounds): void {
    const margin = 1.15;
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(region.width * margin, region.height * margin);
    this.mesh.geometry = this.geometry;
    this.mesh.position.set(region.x + region.width / 2, -(region.y + region.height / 2), 0);
  }

  setWells(wells: MistWell[], radius: number): void {
    const positions = this.material.uniforms["wellPos"].value as Vector2[];
    const colours = this.material.uniforms["wellColour"].value as Vector3[];
    const count = Math.min(wells.length, MAX_WELLS);
    for (let i = 0; i < count; i++) {
      positions[i].set(wells[i].x, wells[i].y);
      colours[i].set(wells[i].colour[0], wells[i].colour[1], wells[i].colour[2]);
    }
    this.material.uniforms["wellCount"].value = count;
    this.material.uniforms["radius"].value = radius;
  }

  setBrightness(brightness: number): void {
    this.material.uniforms["brightness"].value = brightness;
  }

  /** Higher detail means finer wisps; it scales the noise frequency, not the step count. */
  setDetail(detail: number): void {
    this.material.uniforms["detail"].value = 0.0085 * detail;
  }

  setSteps(steps: number): void {
    this.material.uniforms["steps"].value = Math.max(8, Math.min(96, Math.round(steps)));
  }

  setTime(seconds: number): void {
    this.material.uniforms["time"].value = seconds;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
