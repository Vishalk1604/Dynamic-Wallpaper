/**
 * Phase 1 probe renderer.
 *
 * The surface spans the whole virtual desktop, so this draws one labelled panel per monitor at its
 * true position within that space, making placement, negative virtual coordinates and portrait
 * orientation verifiable at a glance.
 *
 * It also runs a continuously animating WebGL layer, which is load-bearing for the spike rather
 * than decoration:
 *   - Offscreen rendering only emits a `paint` event when the compositor produces a new frame, so a
 *     static page paints once and stops. The blit path can only be measured under constant motion.
 *   - The whole plan depends on WebGL working in an offscreen surface. If it does not, the particle
 *     simulation cannot be built this way, so it is worth proving before anything is built on it.
 *
 * Replaced by the particle simulation in Phase 3.
 */
import type { Bounds, DisplayInfo, Layout } from "@shared/types";

/**
 * The surface may cover the whole virtual desktop or a single monitor, so the renderer is told
 * which region of virtual-desktop space its canvas represents and lays everything out relative to
 * that rather than assuming the full bounding box.
 */
type SurfacePayload = { layout: Layout; region: Bounds };

type WallpaperBridge = {
  onLayout: (callback: (payload: SurfacePayload) => void) => void;
};

const bridge = (globalThis as unknown as { wallpaper: WallpaperBridge }).wallpaper;

const stage = document.getElementById("stage")!;
const banner = document.getElementById("banner")!;
const canvas = document.getElementById("gl") as HTMLCanvasElement;

/** Stable, well-separated hues so each monitor is instantly distinguishable. */
function hueFor(id: number): number {
  return (Math.abs(id) * 47) % 360;
}

// --- WebGL animation -------------------------------------------------------

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

/**
 * Deliberately cheap: a couple of moving radial falloffs. Enough to force a new frame every tick
 * without the shader cost confounding the throughput measurement.
 */
const FRAGMENT_SHADER = `
precision mediump float;
uniform vec2 resolution;
uniform float time;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 a = vec2(0.5 + 0.35 * cos(time * 0.7), 0.5 + 0.35 * sin(time * 0.5));
  vec2 b = vec2(0.5 + 0.30 * sin(time * 0.4), 0.5 + 0.30 * cos(time * 0.9));
  float ga = 0.10 / (distance(uv, a) + 0.06);
  float gb = 0.10 / (distance(uv, b) + 0.06);
  vec3 colour = vec3(0.15, 0.55, 1.0) * ga + vec3(1.0, 0.35, 0.15) * gb;
  gl_FragColor = vec4(colour, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("shader compile failed:", gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

let glStatus = "not started";

function startWebGL(): void {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) {
    glStatus = "FAILED: no webgl context";
    console.error(glStatus);
    return;
  }

  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!program || !vs || !fs) {
    glStatus = "FAILED: shader compilation";
    return;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    glStatus = "FAILED: link";
    console.error(glStatus, gl.getProgramInfoLog(program));
    return;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLocation = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const resolutionLocation = gl.getUniformLocation(program, "resolution");
  const timeLocation = gl.getUniformLocation(program, "time");

  const renderer = gl.getParameter(gl.RENDERER) as string;
  const vendor = gl.getParameter(gl.VENDOR) as string;
  glStatus = `OK — ${renderer} / ${vendor}`;
  console.log(`webgl ${glStatus}`);

  let frames = 0;
  const started = performance.now();

  const frame = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(timeLocation, (performance.now() - started) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    frames += 1;
    if (frames % 60 === 0) {
      const fps = frames / ((performance.now() - started) / 1000);
      document.getElementById("glfps")!.textContent = `renderer ${fps.toFixed(1)} fps`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// --- Per-monitor panels ----------------------------------------------------

function panelFor(display: DisplayInfo, region: Bounds): HTMLElement {
  const b = display.bounds;

  const el = document.createElement("div");
  el.className = "screen";
  el.style.left = `${((b.x - region.x) / region.width) * 100}%`;
  el.style.top = `${((b.y - region.y) / region.height) * 100}%`;
  el.style.width = `${(b.width / region.width) * 100}%`;
  el.style.height = `${(b.height / region.height) * 100}%`;
  el.style.borderColor = `hsl(${hueFor(display.id)} 90% 60%)`;

  const orientation = b.height > b.width ? "portrait" : "landscape";
  el.innerHTML = `
    <div class="bracket tl"></div><div class="bracket tr"></div>
    <div class="bracket bl"></div><div class="bracket br"></div>
    <div class="label">${display.label}${display.primary ? " (primary)" : ""}</div>
    <div class="detail">${[
      `${b.width} x ${b.height}  ${orientation}`,
      `virtual position  ${b.x}, ${b.y}`,
      `rotation ${display.rotation}°   scale ${display.scaleFactor}`,
      display.internal ? "internal panel" : "external panel",
    ].join("\n")}</div>
  `;
  return el;
}

function render({ layout, region }: SurfacePayload): void {
  stage.replaceChildren(...layout.displays.map((d) => panelFor(d, region)));

  banner.textContent =
    `region ${region.width}x${region.height} @${region.x},${region.y}  |  ` +
    `surface ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}  |  ` +
    `${layout.displays.length} display(s)  |  webgl ${glStatus}`;
}

startWebGL();
bridge.onLayout(render);
