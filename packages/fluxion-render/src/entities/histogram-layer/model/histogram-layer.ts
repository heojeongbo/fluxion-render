import type { Layer } from "../../../shared/model/layer";
import type { Viewport } from "../../../shared/model/viewport";

export type { HistogramConfig } from "../../../shared/model/layer-configs";

import type { HistogramConfig } from "../../../shared/model/layer-configs";

/**
 * Histogram layer. Takes a flat array of raw sample values and bins them
 * internally into frequency bars.
 *
 * Data layout: Float32Array `[v0, v1, v2, ...]` — raw values, one per element.
 * The x-axis is the value axis (bin edges); the y-axis is count (or density).
 * Pair with `axisGridLayer({ xMode: "fixed", xRange: range, yMode: "auto" })`.
 */
export class HistogramLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private binCount = 20;
  private range: [number, number] | undefined;
  private density = false;
  private gapPx = 1;
  private visible = true;
  private bins: Float32Array = new Float32Array(0);
  private binStart = 0;
  private binWidth = 1;

  constructor(id: string) {
    this.id = id;
  }

  setConfig(config: unknown): void {
    const c = config as HistogramConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.binCount !== undefined) this.binCount = Math.max(1, Math.floor(c.binCount));
    if (c.range !== undefined) this.range = c.range;
    if (c.density !== undefined) this.density = c.density;
    if (c.gapPx !== undefined) this.gapPx = Math.max(0, c.gapPx);
    if (c.visible !== undefined) this.visible = c.visible;
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    const values = new Float32Array(buffer, 0, length);
    this.recompute(values, length);
    this._scan(viewport);
  }

  /** Bin the raw values into counts. */
  private recompute(values: Float32Array, length: number): void {
    const n = this.binCount;
    if (length === 0) {
      this.bins = new Float32Array(0);
      return;
    }
    const bins = new Float32Array(n);

    let lo: number;
    let hi: number;
    if (this.range) {
      lo = this.range[0];
      hi = this.range[1];
    } else {
      lo = Number.POSITIVE_INFINITY;
      hi = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < length; i++) {
        const v = values[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!(hi > lo)) hi = lo + 1; // flat data guard

    const width = (hi - lo) / n;
    for (let i = 0; i < length; i++) {
      const v = values[i]!;
      if (v < lo || v > hi) continue;
      let b = Math.floor((v - lo) / width);
      if (b >= n) b = n - 1; // include the right edge in the last bin
      bins[b]! += 1;
    }

    if (this.density) {
      for (let i = 0; i < n; i++) bins[i]! /= length;
    }

    this.bins = bins;
    this.binStart = lo;
    this.binWidth = width;
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    this._scan(viewport);
  }

  private _scan(viewport: Viewport): void {
    if (!this.visible || this.bins.length === 0) return;
    let localMax = viewport.observedYMax;
    for (let i = 0; i < this.bins.length; i++) {
      const c = this.bins[i]!;
      if (c > localMax) localMax = c;
    }
    if (0 < viewport.observedYMin) viewport.observedYMin = 0;
    viewport.observedYMax = localMax;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.bins.length === 0) return;

    const baselinePy = viewport.yToPx(0);
    const gap = this.gapPx;
    ctx.fillStyle = this.color;

    for (let i = 0; i < this.bins.length; i++) {
      const count = this.bins[i]!;
      if (count === 0) continue; // empty bin → nothing to draw
      const x0 = this.binStart + i * this.binWidth;
      const px0 = viewport.xToPx(x0);
      const px1 = viewport.xToPx(x0 + this.binWidth);
      const py = viewport.yToPx(count);
      const w = px1 - px0 - gap;
      if (w <= 0) continue;
      ctx.fillRect(px0 + gap / 2, Math.min(py, baselinePy), w, Math.abs(py - baselinePy));
    }
  }

  clearData(): void {
    this.bins = new Float32Array(0);
  }

  dispose(): void {
    this.bins = new Float32Array(0);
  }
}
