import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { BoxPlotConfig } from "../../../shared/model/layer-configs";

import type { BoxPlotConfig } from "../../../shared/model/layer-configs";

/**
 * Box-plot layer for comparing distributions side by side (e.g. per-joint or
 * per-sensor min/quartile/median/max).
 *
 * Data layout: Float32Array `[x, min, q1, median, q3, max, …]` stride=6 — `x` is
 * the category position in world space (use `axisGridLayer({ xMode: "fixed" })`),
 * the rest are y-values. Each entry draws a box (q1→q3) with a median line and
 * whiskers to min/max. Replaces the full dataset on each `setData`.
 */
export class BoxPlotLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private fillOpacity = 0.35;
  private lineColor = "#e2e8f0";
  private boxWidth = 24;
  private lineWidth = 1.5;
  private capRatio = 0.5;
  private visible = true;
  private data: Float32Array = new Float32Array(0);
  private dataLength = 0;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as BoxPlotConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.fillOpacity !== undefined) this.fillOpacity = c.fillOpacity;
    if (c.lineColor !== undefined) this.lineColor = c.lineColor;
    if (c.boxWidth !== undefined) this.boxWidth = Math.max(1, c.boxWidth);
    if (c.lineWidth !== undefined) this.lineWidth = Math.max(0.5, c.lineWidth);
    if (c.capRatio !== undefined) this.capRatio = Math.max(0, Math.min(1, c.capRatio));
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    this.data = new Float32Array(buffer, 0, length);
    this.dataLength = length;
    this._scan(viewport);
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    this._scan(viewport);
  }

  private _scan(viewport: Viewport): void {
    if (!this.visible || this.dataLength < 6) return;
    let localMin = viewport.observedYMin;
    let localMax = viewport.observedYMax;
    // min is field 1, max is field 5 of each 6-tuple.
    for (let i = 0; i + 5 < this.dataLength; i += 6) {
      const lo = this.data[i + 1]!;
      const hi = this.data[i + 5]!;
      if (lo < localMin) localMin = lo;
      if (hi > localMax) localMax = hi;
    }
    viewport.observedYMin = localMin;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.dataLength < 6) return;

    const half = this.boxWidth / 2;
    const cap = (this.boxWidth * this.capRatio) / 2;
    ctx.lineWidth = this.lineWidth;

    for (let i = 0; i + 5 < this.dataLength; i += 6) {
      const px = viewport.xToPx(this.data[i]!);
      const pyMin = viewport.yToPx(this.data[i + 1]!);
      const pyQ1 = viewport.yToPx(this.data[i + 2]!);
      const pyMed = viewport.yToPx(this.data[i + 3]!);
      const pyQ3 = viewport.yToPx(this.data[i + 4]!);
      const pyMax = viewport.yToPx(this.data[i + 5]!);

      // Box (q1..q3).
      ctx.globalAlpha = this.fillOpacity;
      ctx.fillStyle = this.color;
      ctx.fillRect(px - half, Math.min(pyQ1, pyQ3), this.boxWidth, Math.abs(pyQ3 - pyQ1));
      ctx.globalAlpha = 1;

      ctx.strokeStyle = this.lineColor;
      ctx.strokeRect(
        px - half,
        Math.min(pyQ1, pyQ3),
        this.boxWidth,
        Math.abs(pyQ3 - pyQ1),
      );

      // Median line.
      ctx.beginPath();
      ctx.moveTo(px - half, pyMed);
      ctx.lineTo(px + half, pyMed);
      ctx.stroke();

      // Whiskers: q3→max (top) and q1→min (bottom), with caps.
      ctx.beginPath();
      ctx.moveTo(px, pyQ3);
      ctx.lineTo(px, pyMax);
      ctx.moveTo(px - cap, pyMax);
      ctx.lineTo(px + cap, pyMax);
      ctx.moveTo(px, pyQ1);
      ctx.lineTo(px, pyMin);
      ctx.moveTo(px - cap, pyMin);
      ctx.lineTo(px + cap, pyMin);
      ctx.stroke();
    }
  }

  clearData(): void {
    this.data = new Float32Array(0);
    this.dataLength = 0;
  }

  dispose(): void {
    this.data = new Float32Array(0);
    this.dataLength = 0;
  }
}
