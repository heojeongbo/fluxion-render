import { forEachColumn } from "../../../shared/lib/column-reduce";
import { pushSamples } from "../../../shared/lib/push-samples";
import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { createStreamingRing, type RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export interface ScatterChartConfig {
  /** Point color. Default "#4fc3f7". */
  color?: string;
  /** Point size in pixels. Default 3. */
  pointSize?: number;
  /** Point shape. Default "square". */
  shape?: "square" | "circle";
  /** Ring buffer capacity (number of [t,y] samples retained). Default 2048. */
  capacity?: number;
  /** Data retention window in ms. Combined with maxHz to auto-calculate capacity. */
  retentionMs?: number;
  /** Expected max sample rate in Hz. Combined with retentionMs to auto-calculate capacity. */
  maxHz?: number;
  /** When false, skip draw and scan. Default true. */
  visible?: boolean;
  /**
   * Thin the drawn points to ~2 per x-pixel column (the column's min-y and
   * max-y sample) when oversampled (visible samples > 2×width), cutting draw
   * cost from O(samples) to O(width). The visible distribution envelope is
   * preserved at display resolution; the ring keeps every sample
   * (hover/scan/export unaffected). Tri-state: omitted = AUTO (thin iff
   * oversampled), `true` = same as auto, `false` = always draw every point.
   * Default auto.
   */
  decimate?: boolean;
  /**
   * Global point opacity in `[0, 1]`. Default 1 (opaque). Multiplies the canvas
   * alpha for this layer's points only; saved/restored so it never leaks into
   * other layers. Visual only — data/hover/scaling are unaffected.
   */
  opacity?: number;
}

/**
 * Streaming time-series scatter plot. Same data layout as `LineChartLayer`
 * — Float32Array `[t, y, t, y, ...]` where `t` is host-relative ms — but
 * renders each sample as an individual point instead of a connected line.
 *
 * Use this when the relationship between consecutive samples is not meaningful
 * (noisy sensors, discrete events, outlier detection) and you want to see the
 * raw distribution rather than an interpolated trend.
 */
export class ScatterChartLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private pointSize = 3;
  private shape: "square" | "circle" = "square";
  private visible = true;
  // undefined = auto (thin iff oversampled); true/false = explicit override.
  private decimate: boolean | undefined = undefined;
  private opacity = 1;
  private ring: RingBuffer;

  constructor(id: string) {
    this.id = id;
    this.ring = createStreamingRing(2048);
  }

  setConfig(config: unknown): void {
    const c = config as ScatterChartConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.pointSize !== undefined) this.pointSize = Math.max(1, c.pointSize);
    if (c.shape !== undefined) this.shape = c.shape;
    if (c.visible !== undefined) this.visible = c.visible;
    if (c.decimate !== undefined) this.decimate = c.decimate;
    if (c.opacity !== undefined) this.opacity = c.opacity;
    const newCapacity = computeRingCapacity(c);
    if (newCapacity !== undefined && newCapacity !== this.ring.capacity) {
      this.ring = createStreamingRing(newCapacity);
    }
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    pushSamples(this.ring, buffer, length, viewport, 2);
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;
    const xMin = viewport.bounds.xMin;
    // Sliding-window y-extent in O(log n) (monotonic deques in the ring),
    // replacing the per-frame full-ring scan. +Infinity when no sample is in the
    // window — leave the observed range untouched, matching the old loop.
    const rawMin = this.ring.extentMin(xMin);
    if (rawMin !== Number.POSITIVE_INFINITY) {
      const rawMax = this.ring.extentMax(xMin);
      if (rawMin < viewport.observedYMin) viewport.observedYMin = rawMin;
      if (rawMax > viewport.observedYMax) viewport.observedYMax = rawMax;
    }
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.ring.length < 2) return;

    const size = this.pointSize;
    const half = size / 2;
    const xMin = viewport.bounds.xMin;

    const faded = this.opacity !== 1;
    const prevAlpha = ctx.globalAlpha;
    if (faded) ctx.globalAlpha = this.opacity;
    ctx.fillStyle = this.color;
    ctx.beginPath();

    // Hoist the shape branch out of the hot loop (one decision per draw).
    const plot =
      this.shape === "circle"
        ? (px: number, py: number): void => {
            ctx.moveTo(px + half, py);
            ctx.arc(px, py, half, 0, Math.PI * 2);
          }
        : (px: number, py: number): void => {
            ctx.rect(px - half, py - half, size, size);
          };

    // Thin to the column's min-y / max-y point when oversampled — bounds the
    // plotted points to O(width) while keeping the distribution envelope.
    // AUTO unless `decimate` is explicitly set; `false` opts out.
    if (this.decimate !== false && this.ring.length > viewport.plotWidth * 2) {
      forEachColumn(this.ring, viewport, xMin, undefined, {
        onColumn: (colPx, _firstY, minY, maxY) => {
          plot(colPx, viewport.yToPx(minY));
          if (maxY !== minY) plot(colPx, viewport.yToPx(maxY));
        },
      });
    } else {
      this.ring.forEach((data, off) => {
        const t = data[off];
        if (t < xMin) return;
        plot(viewport.xToPx(t), viewport.yToPx(data[off + 1]));
      });
    }

    ctx.fill();
    if (faded) ctx.globalAlpha = prevAlpha;
  }

  clearData(): void {
    this.ring.clear();
  }

  dispose(): void {
    this.ring.clear();
  }
}
