import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { BarChartConfig } from "../../../shared/model/layer-configs";

import type { BarChartConfig } from "../../../shared/model/layer-configs";

/**
 * Static bar chart. Replaces the entire dataset on each `setData` call.
 * Bars grow from y=0 upward (or downward for negative values).
 *
 * "xy" layout: Float32Array `[x, y, x, y, ...]`
 * "y"  layout: Float32Array `[y0, y1, y2, ...]` — x positions inferred from xRange.
 */
export class BarChartLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private barWidth = 8;
  private layout: "xy" | "y" = "xy";
  private xRange: [number, number] = [0, 1];
  private visible = true;
  private data: Float32Array = new Float32Array(0);
  private dataLength = 0;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as BarChartConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.barWidth !== undefined) this.barWidth = Math.max(1, c.barWidth);
    if (c.layout !== undefined) this.layout = c.layout;
    if (c.xRange !== undefined) this.xRange = c.xRange;
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.dataLength = length;
    // Scan bounds immediately so axis-grid auto mode works on first frame.
    this._scan(viewport);
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    this._scan(viewport);
  }

  private _scan(viewport: Viewport): void {
    if (!this.visible || this.dataLength === 0) return;
    const stride = this.layout === "xy" ? 2 : 1;
    const yIdx = this.layout === "xy" ? 1 : 0;
    let localMin = viewport.observedYMin;
    let localMax = viewport.observedYMax;
    for (let i = yIdx; i < this.dataLength; i += stride) {
      const y = this.data[i];
      if (y < localMin) localMin = y;
      if (y > localMax) localMax = y;
    }
    // Always include zero so bars have a meaningful baseline.
    if (0 < localMin) localMin = 0;
    if (0 > localMax) localMax = 0;
    viewport.observedYMin = localMin;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.dataLength === 0) return;

    const bw = this.barWidth;
    const half = bw / 2;
    const baselinePy = viewport.yToPx(0);

    ctx.fillStyle = this.color;

    if (this.layout === "xy") {
      for (let i = 0; i + 1 < this.dataLength; i += 2) {
        const px = viewport.xToPx(this.data[i]);
        const py = viewport.yToPx(this.data[i + 1]);
        ctx.fillRect(px - half, Math.min(py, baselinePy), bw, Math.abs(py - baselinePy));
      }
    } else {
      const n = this.dataLength;
      const [xMin, xMax] = this.xRange;
      const step = n > 1 ? (xMax - xMin) / (n - 1) : 0;
      for (let i = 0; i < n; i++) {
        const x = xMin + i * step;
        const px = viewport.xToPx(x);
        const py = viewport.yToPx(this.data[i]);
        ctx.fillRect(px - half, Math.min(py, baselinePy), bw, Math.abs(py - baselinePy));
      }
    }
  }

  dispose(): void {
    this.data = new Float32Array(0);
    this.dataLength = 0;
  }
}
