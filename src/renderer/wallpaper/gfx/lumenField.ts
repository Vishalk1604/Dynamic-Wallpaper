/**
 * "Lumen" — one smooth organic body per screen, hard-edged, reaching toward its neighbour.
 *
 * Built as a metaball field: a handful of moving charges each contribute a smooth falloff, the
 * contributions are summed, and the surface is wherever that sum crosses a threshold. Two properties
 * of that construction are the whole reason for choosing it here:
 *
 *   - **The edge is genuinely hard.** Thresholding a smooth field gives a crisp boundary with a
 *     smooth interior for free. Drawing a soft shape and sharpening it afterwards cannot — the edge
 *     ends up either aliased or feathered.
 *   - **Interaction is real, not staged.** Every screen's charges feed one shared field, so when two
 *     bodies come close their fields sum above the threshold in the space between and a neck forms on
 *     its own. Nothing draws a connector; the merge is what the maths does.
 *
 * Charge positions are evaluated analytically from elapsed time rather than integrated, so every pane
 * agrees exactly and the motion can never drift.
 *
 * Shading fakes a surface normal from the field's own gradient, which is what makes a flat filled
 * region read as a rounded three-dimensional form.
 */
import { DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3, Vector4 } from "three";
import type { Bounds } from "@shared/types";
import type { Rgb } from "@shared/themes";

/** Fixed-size arrays are a GLSL requirement; this bounds screens x charges plus the travellers. */
const MAX_CHARGES = 40;

/** Charges forming each screen's body. More gives a more irregular, less circular outline. */
const CHARGES_PER_BODY = 7;

/** Charges that migrate between a pair of screens, drawing the bodies toward each other. */
const TRAVELLERS_PER_PAIR = 3;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xy;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vWorld;

// xy = centre, z = radius, w = strength
uniform vec4 charges[${MAX_CHARGES}];
uniform vec3 chargeColour[${MAX_CHARGES}];
uniform int chargeCount;
uniform float threshold;
uniform float brightness;

/**
 * Wyvill's soft-object kernel. Finite support, so a charge costs nothing beyond its radius, and it
 * meets zero with zero slope — an inverse-square falloff would leave a faint halo everywhere and the
 * threshold would then cut a visible circle out of it.
 */
float kernel(float d2, float r) {
  float x = 1.0 - d2 / (r * r);
  if (x <= 0.0) return 0.0;
  return x * x * x;
}

void main() {
  float field = 0.0;
  vec2 grad = vec2(0.0);
  vec3 colourAcc = vec3(0.0);

  for (int i = 0; i < ${MAX_CHARGES}; i++) {
    if (i >= chargeCount) break;
    vec4 c = charges[i];
    vec2 delta = vWorld - c.xy;
    float d2 = dot(delta, delta);
    float x = 1.0 - d2 / (c.z * c.z);
    if (x <= 0.0) continue;

    float k = x * x * x * c.w;
    field += k;
    colourAcc += chargeColour[i] * k;

    // Analytic derivative of the kernel, used for the surface normal. Finite differences would need
    // several extra evaluations of the whole field per pixel.
    grad += delta * (-6.0 * x * x * c.w / (c.z * c.z));
  }

  if (field <= 0.0001) discard;

  // Screen-space derivative gives an edge exactly one pixel wide: crisp, but not stair-stepped.
  float aa = max(fwidth(field), 1e-5);
  float alpha = smoothstep(threshold - aa, threshold + aa, field);
  if (alpha <= 0.002) discard;

  vec3 base = colourAcc / max(field, 1e-4);

  // Treat the field as a height map. The gradient is steep near the rim and flat over the middle, so
  // reading it as a normal turns the flat fill into a rounded body.
  //
  // The tilt is deliberately gentle. Scaled up, the interior saddles between charges become steep
  // enough to swing past the light and etch dark creases across what should be a smooth surface.
  vec3 normal = normalize(vec3(-grad * 70.0, 1.0));

  vec3 lightDir = normalize(vec3(-0.32, 0.5, 0.8));
  float diffuse = max(dot(normal, lightDir), 0.0);
  // Rim term brightens where the surface turns away, which reads as the edge catching light.
  float rim = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.4);

  // High ambient, modest diffuse: the colour gradient should carry the form, with light shaping it
  // rather than dominating and washing the hues out.
  vec3 colour = base * (0.72 + 0.34 * diffuse) + base * rim * 0.5;

  gl_FragColor = vec4(colour * brightness * alpha, alpha);
}
`;

export type LumenBody = {
  /** Body centre in world units. */
  x: number;
  y: number;
  colour: Rgb;
};

type Charge = {
  bodyIndex: number;
  /** Base offset from its body's centre, as a fraction of the body radius. */
  offsetX: number;
  offsetY: number;
  /** Wobble amplitudes and rates, giving each charge its own slow drift. */
  ampX: number;
  ampY: number;
  rateX: number;
  rateY: number;
  phaseX: number;
  phaseY: number;
  radiusScale: number;
  strength: number;
  /** Travellers only: the body this charge migrates toward. */
  travelTo: number;
  travelPhase: number;
  /**
   * How far along the ramp from this body's colour toward its neighbour's this charge sits.
   *
   * This is what gives each body a gradient running through it instead of one flat colour, and the
   * ramp is aligned with the direction of the neighbouring screen — so the gradient itself points at
   * whatever it is reaching for.
   */
  colourMix: number;
};

/** Deterministic pseudo-random from an integer, so every pane builds the identical arrangement. */
function noise(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

type Hsl = { h: number; s: number; l: number };

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / delta + 2) / 6;
  else h = ((r - g) / delta + 4) / 6;
  return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s < 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

/**
 * Blend two colours through hue rather than through RGB.
 *
 * Interpolating RGB between hues that sit far apart on the wheel — cyan and amber, say — passes
 * straight through grey, and the middle of the gradient comes out muddy. Rotating the hue the short
 * way around instead keeps every intermediate colour fully saturated, which is what makes a gradient
 * read as rich rather than washed out.
 */
function mixThroughHue(from: Rgb, to: Rgb, t: number): Rgb {
  const a = rgbToHsl(from);
  const b = rgbToHsl(to);
  let delta = b.h - a.h;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  return hslToRgb({
    h: (a.h + delta * t + 1) % 1,
    s: a.s + (b.s - a.s) * t,
    l: a.l + (b.l - a.l) * t,
  });
}

export class LumenField {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly material: ShaderMaterial;
  private geometry: PlaneGeometry;
  private charges: Charge[] = [];
  private bodies: LumenBody[] = [];
  private radius = 300;
  private travelSpeed = 1;

  constructor(region: Bounds, bodies: LumenBody[], radius: number) {
    this.geometry = new PlaneGeometry(1, 1);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        charges: { value: Array.from({ length: MAX_CHARGES }, () => new Vector4()) },
        chargeColour: { value: Array.from({ length: MAX_CHARGES }, () => new Vector3(1, 1, 1)) },
        chargeCount: { value: 0 },
        // Chosen against the summed strengths so a lone body sits comfortably above it while the
        // space between two bodies only crosses it when they are genuinely close.
        threshold: { value: 0.62 },
        brightness: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.setRegion(region);
    this.setBodies(bodies, radius);
  }

  /** Cover this pane's slice of the world, with margin so a body just off-screen still bleeds in. */
  setRegion(region: Bounds): void {
    const margin = 1.2;
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(region.width * margin, region.height * margin);
    this.mesh.geometry = this.geometry;
    this.mesh.position.set(region.x + region.width / 2, -(region.y + region.height / 2), 0);
  }

  setBodies(bodies: LumenBody[], radius: number): void {
    this.bodies = bodies;
    this.radius = radius;
    this.charges = [];

    for (let b = 0; b < bodies.length; b++) {
      // Direction to the nearest other screen, used to orient this body's colour gradient.
      let toNeighbour = { x: 1, y: 0 };
      let best = Infinity;
      for (let o = 0; o < bodies.length; o++) {
        if (o === b) continue;
        const dx = bodies[o].x - bodies[b].x;
        const dy = bodies[o].y - bodies[b].y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0 && dist < best) {
          best = dist;
          toNeighbour = { x: dx / dist, y: dy / dist };
        }
      }

      for (let i = 0; i < CHARGES_PER_BODY; i++) {
        const seed = b * 97 + i * 13;
        const angle = (i / CHARGES_PER_BODY) * Math.PI * 2 + noise(seed) * 0.9;
        // Kept well inside the radius: charges near the rim make the outline lumpy rather than
        // organic, because each one starts to read as its own bulge. The spread is uneven so the
        // silhouette comes out asymmetric rather than as a ring of equal bumps.
        const spread = 0.14 + noise(seed + 1) * 0.42;
        const offsetX = Math.cos(angle) * spread;
        const offsetY = Math.sin(angle) * spread;
        // Project the charge onto the direction of the neighbour and map to 0..1, so the far side of
        // the body carries the neighbour's hue and the near side its own.
        const along = (offsetX * toNeighbour.x + offsetY * toNeighbour.y) / Math.max(spread, 1e-4);
        this.charges.push({
          bodyIndex: b,
          offsetX,
          offsetY,
          ampX: 0.1 + noise(seed + 2) * 0.24,
          ampY: 0.1 + noise(seed + 3) * 0.24,
          rateX: 0.06 + noise(seed + 4) * 0.16,
          rateY: 0.06 + noise(seed + 5) * 0.16,
          phaseX: noise(seed + 6) * Math.PI * 2,
          phaseY: noise(seed + 7) * Math.PI * 2,
          radiusScale: 0.55 + noise(seed + 8) * 0.5,
          strength: 0.75 + noise(seed + 9) * 0.5,
          travelTo: -1,
          travelPhase: 0,
          // Capped below 1 so a body never fully becomes its neighbour's colour and the two screens
          // stay distinguishable.
          colourMix: Math.min(0.72, Math.max(0, (along * 0.5 + 0.5) * 0.8)),
        });
      }
    }

    // Travellers between each neighbouring pair, which is what makes the bodies reach for each other.
    for (let b = 0; b + 1 < bodies.length; b++) {
      for (let i = 0; i < TRAVELLERS_PER_PAIR; i++) {
        const seed = 5000 + b * 31 + i * 7;
        this.charges.push({
          bodyIndex: b,
          offsetX: 0,
          offsetY: 0,
          ampX: 0.16,
          ampY: 0.3 + noise(seed) * 0.35,
          rateX: 0.1,
          rateY: 0.07 + noise(seed + 1) * 0.12,
          phaseX: noise(seed + 2) * Math.PI * 2,
          phaseY: noise(seed + 3) * Math.PI * 2,
          radiusScale: 0.5 + noise(seed + 4) * 0.3,
          strength: 0.85,
          travelTo: b + 1,
          travelPhase: i / TRAVELLERS_PER_PAIR + noise(seed + 5) * 0.12,
          colourMix: 0,
        });
      }
    }

    if (this.charges.length > MAX_CHARGES) this.charges.length = MAX_CHARGES;
    this.material.uniforms["chargeCount"].value = this.charges.length;
    this.uploadColours();
  }

  /** Nearest other body, whose colour the gradient ramps toward. */
  private neighbourOf(index: number): LumenBody | undefined {
    let nearest: LumenBody | undefined;
    let best = Infinity;
    for (let i = 0; i < this.bodies.length; i++) {
      if (i === index) continue;
      const dist = Math.hypot(this.bodies[i].x - this.bodies[index].x, this.bodies[i].y - this.bodies[index].y);
      if (dist < best) {
        best = dist;
        nearest = this.bodies[i];
      }
    }
    return nearest;
  }

  private uploadColours(): void {
    const colours = this.material.uniforms["chargeColour"].value as Vector3[];
    for (let i = 0; i < this.charges.length; i++) {
      const charge = this.charges[i];
      const body = this.bodies[charge.bodyIndex];
      if (!body) continue;
      const neighbour = this.neighbourOf(charge.bodyIndex) ?? body;
      const mixed = mixThroughHue(body.colour, neighbour.colour, charge.colourMix);
      colours[i].set(mixed[0], mixed[1], mixed[2]);
    }
  }

  setBrightness(brightness: number): void {
    this.material.uniforms["brightness"].value = brightness;
  }

  setTravelSpeed(speed: number): void {
    this.travelSpeed = Math.max(0.05, speed);
  }

  /**
   * Reposition every charge for the given time.
   *
   * Positions are a pure function of the shared clock, so panes agree without exchanging anything and
   * the animation cannot accumulate error however long it runs.
   */
  update(seconds: number): void {
    const values = this.material.uniforms["charges"].value as Vector4[];
    const colours = this.material.uniforms["chargeColour"].value as Vector3[];

    for (let i = 0; i < this.charges.length; i++) {
      const c = this.charges[i];
      const body = this.bodies[c.bodyIndex];
      if (!body) continue;

      const wobbleX = Math.cos(seconds * c.rateX + c.phaseX) * c.ampX;
      const wobbleY = Math.sin(seconds * c.rateY + c.phaseY) * c.ampY;

      let x = body.x + (c.offsetX + wobbleX) * this.radius;
      let y = body.y + (c.offsetY + wobbleY) * this.radius;
      let strength = c.strength;

      const target = c.travelTo >= 0 ? this.bodies[c.travelTo] : undefined;
      if (target) {
        // A smooth there-and-back trip. Cosine rather than a sawtooth so a traveller never snaps back
        // to the start, which would show as the neck flicking out of existence.
        const cycle = (seconds * 0.045 * this.travelSpeed + c.travelPhase) % 1;
        const t = 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2);
        x = body.x + (target.x - body.x) * t + wobbleX * this.radius * 0.5;
        y = body.y + (target.y - body.y) * t + wobbleY * this.radius * 0.5;

        // Weakest at the midpoint. A traveller at full strength out in the gap would hold up an
        // isolated island of colour with nothing attached to it.
        strength = c.strength * (0.32 + 0.68 * Math.abs(Math.cos(cycle * Math.PI * 2)));

        // Colour crossfades along the trip, so material arriving from the other screen carries its
        // origin's hue and marbles into the destination. Through hue, for the same reason as the
        // body gradient: an RGB fade would grey out exactly where the neck is most visible.
        const mixed = mixThroughHue(body.colour, target.colour, t);
        colours[i].set(mixed[0], mixed[1], mixed[2]);
      }

      values[i].set(x, y, this.radius * c.radiusScale, strength);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
