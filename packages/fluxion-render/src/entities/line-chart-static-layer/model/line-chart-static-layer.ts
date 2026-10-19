import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { LineChartStaticConfig } from "../../../shared/model/layer-configs";

import type { LineChartStaticConfig } from "../../../shared/model/layer-configs";

/**
 * One-shot xy line chart. Replaces the entire series on every `setData`.
 * Use this for pre-computed plots, snapshot visualizations, or any dataset
 * whose x-axis is not a time stream. For streaming time-series data, use
 * `LineChartLayer` (kind "line") instead.
 */
export class LineChartStaticLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private lineWidth = 1;
  private layout: "xy" | "y" = "xy";
  private data: Float32Array | null = null;
  private length = 0;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as LineChartStaticConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.lineWidth !== undefined) this.lineWidth = c.lineWidth;
    if (c.layout !== undefined) this.layout = c.layout;
  }

  setData(buffer: ArrayBuffer, length: number, _viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.length = length;
  }

  resize(_viewport: Viewport): void {}

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    const data = this.data;
    if (!data || this.length < 2) return;

    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.beginPath();

    if (this.layout === "xy") {
      const n = this.length >> 1;
      if (n < 2) return;
      ctx.moveTo(viewport.xToPx(data[0]), viewport.yToPx(data[1]));
      for (let i = 1; i < n; i++) {
        const j = i * 2;
        ctx.lineTo(viewport.xToPx(data[j]), viewport.yToPx(data[j + 1]));
      }
    } else {
      const n = this.length;
      const xMin = viewport.bounds.xMin;
      const xMax = viewport.bounds.xMax;
      const step = (xMax - xMin) / Math.max(1, n - 1);
      ctx.moveTo(viewport.xToPx(xMin), viewport.yToPx(data[0]));
      for (let i = 1; i < n; i++) {
        ctx.lineTo(viewport.xToPx(xMin + i * step), viewport.yToPx(data[i]));
      }
    }
    ctx.stroke();
  }

  dispose(): void {
    this.data = null;
  }
}
