import type { GlRenderer } from "../../../shared/gl/gl-renderer";
import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export class LayerStack {
  private layers: Layer[] = [];
  private byId = new Map<string, Layer>();

  add(layer: Layer): void {
    this.layers.push(layer);
    this.byId.set(layer.id, layer);
  }

  remove(id: string): void {
    const layer = this.byId.get(id);
    if (!layer) return;
    this.byId.delete(id);
    const i = this.layers.indexOf(layer);
    if (i >= 0) this.layers.splice(i, 1);
    layer.dispose();
  }

  get(id: string): Layer | undefined {
    return this.byId.get(id);
  }

  findFirst<T extends Layer>(predicate: (l: Layer) => l is T): T | undefined {
    for (const l of this.layers) {
      if (predicate(l)) return l;
    }
    return undefined;
  }

  resizeAll(viewport: Viewport): void {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].resize(viewport);
    }
  }

  /**
   * Pre-draw pass. Layers that implement `scan` update shared viewport state
   * (bounds, observed extents) here so downstream layers' `draw` sees the
   * correct values. Iterates in insertion order so axis-grid (added first)
   * writes bounds before data layers read them.
   */
  scanAll(viewport: Viewport): void {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].scan?.(viewport);
    }
  }

  drawAll(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].draw(ctx, viewport);
    }
  }

  /**
   * WebGL fan-out: draw every layer that implements `drawGl`; report layers
   * that don't to `onUnsupported` (the engine warns once per id and skips).
   */
  drawGlAll(
    glr: GlRenderer,
    viewport: Viewport,
    onUnsupported: (l: Layer) => void,
  ): void {
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      if (layer.drawGl) layer.drawGl(glr, viewport);
      else onUnsupported(layer);
    }
  }

  disposeAll(): void {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].dispose();
    }
    this.layers.length = 0;
    this.byId.clear();
  }
}
