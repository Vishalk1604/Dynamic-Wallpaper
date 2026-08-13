/**
 * Draws the particle cloud as additively blended soft sprites.
 *
 * Each particle is a single GL point shaded as a radial falloff rather than a textured quad, which
 * keeps it to one draw call for the whole system with no texture upload. Additive blending is what
 * makes density read as brightness: where particles overlap the colour accumulates, so the core of a
 * blob turns near-white and the fringes stay tinted, and the bloom pass then blooms the bright core.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  OneFactor,
  Points,
  ShaderMaterial,
} from "three";
import type { BlobWorld } from "../sim/world";

const VERTEX_SHADER = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 colour;

varying float vAlpha;
varying vec3 vColour;

uniform float pixelScale;

void main() {
  vAlpha = alpha;
  vColour = colour;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  gl_PointSize = size * pixelScale;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying float vAlpha;
varying vec3 vColour;

uniform float brightness;

void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (d > 1.0) discard;

  // A solid core out to roughly half the radius, then a short soft rim. A smooth radial falloff
  // instead of this makes every particle a faint smudge, and the cloud stops reading as individual
  // particles at all — the reference keeps its dots crisp and distinctly visible.
  float core = smoothstep(1.0, 0.45, d);

  // A wide, faint halo carrying the glow. This has to happen per particle: a post-processing bloom
  // pass writes opaque alpha and would make the pane solid, hiding the desktop and its icons.
  float halo = (1.0 - d) * (1.0 - d) * 0.4;

  float intensity = (core + halo) * vAlpha;
  if (intensity < 0.004) discard;

  gl_FragColor = vec4(vColour * intensity * brightness, intensity);
}
`;

export class BlobPoints {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;

  constructor(world: BlobWorld, pixelScale: number) {
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(world.positions, 3));
    this.geometry.setAttribute("colour", new BufferAttribute(world.colours, 3));
    this.geometry.setAttribute("size", new BufferAttribute(world.sizes, 1));
    this.geometry.setAttribute("alpha", new BufferAttribute(world.alphas, 1));

    // The particles span the whole virtual desktop while each pane only shows its own region.
    // Frustum culling would test this single object's bounds and cull all or nothing, so it is
    // disabled and per-point clipping is left to the GPU.
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        pixelScale: { value: pixelScale },
        // Above 1 so colours stay vivid where particles overlap, rather than washing toward grey.
        brightness: { value: 1.35 },
      },
      // Premultiplied additive, rather than three's AdditiveBlending.
      //
      // The shader already outputs colour scaled by intensity, so the source is premultiplied.
      // AdditiveBlending uses SrcAlpha for the source factor, which would multiply by intensity a
      // second time — harmless against an opaque black background, but wrong over a transparent one.
      // Adding alpha as well is what builds up coverage so dense areas occlude the desktop while
      // sparse fringes stay see-through.
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
    this.points.frustumCulled = false;
  }

  /**
   * Push the simulation's latest state to the GPU.
   *
   * Alpha is included because stream particles fade in and out along their travel, so it changes
   * every frame rather than being fixed at build time.
   */
  sync(): void {
    (this.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("colour") as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("alpha") as BufferAttribute).needsUpdate = true;
  }

  setPixelScale(scale: number): void {
    this.material.uniforms["pixelScale"].value = scale;
  }

  setBrightness(brightness: number): void {
    // The base 1.35 keeps colours vivid where particles overlap; the setting scales around it.
    this.material.uniforms["brightness"].value = 1.35 * brightness;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
