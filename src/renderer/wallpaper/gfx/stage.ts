/**
 * Renderer, camera and bloom for one pane.
 *
 * The camera is orthographic with its frustum set straight from the pane's region in world units, so
 * one world unit is exactly one physical pixel and particle sizes can be reasoned about in pixels.
 * Every pane shares one world, and each simply looks at a different rectangle of it — which is what
 * makes a particle crossing a bezel line up on both screens.
 */
import { Color, OrthographicCamera, Scene, Vector2, WebGLRenderer } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Bounds } from "@shared/types";

export type BloomSettings = {
  strength: number;
  radius: number;
  threshold: number;
};

export const DEFAULT_BLOOM: BloomSettings = {
  // Restrained on purpose. The reference keeps its particles as crisp, individually visible dots with
  // only a slight halo; a strong low-threshold bloom smears them into a single luminous smudge and
  // loses the granularity that makes the cloud read as particles at all.
  strength: 0.7,
  radius: 0.6,
  threshold: 0.22,
};

export class Stage {
  readonly scene = new Scene();
  readonly camera: OrthographicCamera;
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  /**
   * Bloom is mutually exclusive with a transparent pane, so it is off while the wallpaper needs the
   * desktop to show through. The particle sprites carry a soft rim of their own, so the loss is
   * modest.
   */
  private bloomEnabled = false;

  constructor(canvas: HTMLCanvasElement, region: Bounds, bloom: BloomSettings = DEFAULT_BLOOM) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      // Transparent framebuffer: the pane is a transparent window, so anywhere no particle is drawn
      // must stay clear for the desktop and its icons to show through.
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(new Color(0x000000), 0);

    this.camera = new OrthographicCamera();
    this.camera.position.set(0, 0, 4000);
    this.camera.near = 0.1;
    this.camera.far = 12000;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), bloom.strength, bloom.radius, bloom.threshold);
    this.composer.addPass(this.bloom);

    this.resize(region);
  }

  /**
   * Point the camera at `region` of world space and size the buffers to match.
   *
   * World Y is negated relative to screen Y, so the region's top edge becomes the larger world Y.
   */
  resize(region: Bounds): void {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.round(region.width / dpr));
    const cssHeight = Math.max(1, Math.round(region.height / dpr));

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.composer.setSize(cssWidth, cssHeight);
    this.bloom.resolution.set(cssWidth, cssHeight);

    this.camera.left = region.x;
    this.camera.right = region.x + region.width;
    this.camera.top = -region.y;
    this.camera.bottom = -(region.y + region.height);
    this.camera.updateProjectionMatrix();
  }

  setBloom(settings: BloomSettings): void {
    this.bloom.strength = settings.strength;
    this.bloom.radius = settings.radius;
    this.bloom.threshold = settings.threshold;
  }

  render(): void {
    if (this.bloomEnabled) {
      this.composer.render();
      return;
    }
    // Direct render preserves the framebuffer's alpha channel. The composer's final full-screen pass
    // writes opaque alpha, which makes the whole pane solid and hides the desktop beneath it.
    this.renderer.render(this.scene, this.camera);
  }

  setBloomEnabled(enabled: boolean): void {
    this.bloomEnabled = enabled;
  }

  get info(): string {
    const gl = this.renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    if (!debug) return this.renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL1";
    return String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
