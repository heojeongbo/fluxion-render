import type { GlRenderer } from "../gl/gl-renderer";
import type { Viewport } from "./viewport";

/**
 * Contract every renderable layer must implement. Lives in `shared` because it
 * is a cross-cutting interface used by entities (layer implementations) and
 * features (engine, layer-stack).
 *
 * Frame lifecycle (driven by `Engine.render`):
 *   1. `viewport.beginScan()` — reset per-frame aggregates
 *   2. `scan(viewport)` — OPTIONAL pre-draw phase. Layers use this to update
 *      shared viewport state (bounds, observed y extents) before anyone reads
 *      it in draw. Called in stack insertion order.
 *   3. `draw(ctx, viewport)` — actual rendering. Reads bounds written during
 *      scan. Called in stack insertion order.
 *
 * `setData` receives the live `Viewport` so streaming layers can update
 * shared state (e.g. `viewport.latestT`) at the exact moment new data lands,
 * before the next draw frame fires.
 */
export interface Layer {
  readonly id: string;
  setConfig(config: unknown): void;
  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void;
  resize(viewport: Viewport): void;
  /**
   * Optional pre-draw hook. Runs for every layer (in insertion order) before
   * any layer's `draw`. Use this to write into `viewport` state that other
   * layers will consume in their draw.
   */
  scan?(viewport: Viewport): void;
  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void;
  /**
   * Optional WebGL draw path (renderer: "webgl"). Same frame position and
   * ordering contract as `draw()`. Layers without it are skipped under the
   * webgl backend (the engine warns once per layer id).
   */
  drawGl?(glr: GlRenderer, viewport: Viewport): void;
  /**
   * Optional. Drop the layer's data buffer (ring buffer for streaming layers,
   * last-set dataset for static layers) without touching config or removing
   * the layer. Layers that don't hold data may leave this unimplemented.
   */
  clearData?(): void;
  dispose(): void;
}
