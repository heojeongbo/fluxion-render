import { forEachColumn } from "../../../shared/lib/column-reduce";
import { pushSamples } from "../../../shared/lib/push-samples";
import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { createStreamingRing, type RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export interface AreaChartConfig {
  color?: string;
  /** Fill opacity [0,1]. Default 0.2. */
  fillOpacity?: number;
  lineWidth?: number;
  capacity?: number;
  retentionMs?: number;
  maxHz?: number;
  visible?: boolean;
  /**
   * Min/max-decimate both the fill and the outline stroke to ~2–4 points per
   * x-pixel column when oversampled (visible samples > 2×width), cutting draw
   * cost from O(samples) to O(width). The fill still closes to the baseline per
   * gap-segment and the envelope is preserved at display resolution. The ring
   * keeps every sample (hover/scan/export unaffected). Tri-state: omitted =
   * AUTO (decimate iff oversampled), `true` = same as auto, `false` = always
   * draw every sample. Default auto.
   */
  decimate?: boolean;
  /**
   * Maximum allowed time gap (ms) between consecutive samples before the
   * area is broken: the current fill polygon closes to the baseline and a
   * new one starts after the gap (the stroke breaks too). Undefined
   * (default) keeps the current behavior: one continuous area.
   */
  maxGapMs?: number;
  /**
   * Canvas `setLineDash` pattern for the outline STROKE, in CSS px. Default
   * `[]` (solid). The fill is never dashed. Use it to tell apart series whose
   * values overlap. Visual only: data, hover, and auto-scaling are unaffected.
   */
  dashArray?: number[];
  /**
   * Vertical offset added to every y at DRAW time, in DATA units. Default 0.
   * Lifts the whole area (fill + outline) up/down to separate overlapping
   * series. `scan()` widens the observed y-range so `yMode: "auto"` fits it.
   * Visual only: hover, export, and the underlying samples are unaffected.
   * Ignored in lane mode (see `laneCount`).
   */
  yOffset?: number;
  /**
   * Lane (small-multiples) mode. When `laneCount >= 1`, the area is drawn into
   * band `laneIndex` of `laneCount`, auto-normalized to its OWN visible y-range
   * (fill runs to the band's bottom). The shared y-axis no longer applies.
   * `yOffset` is ignored while active. Default off. See `LineChartConfig`.
   */
  laneIndex?: number;
  /** Total number of lanes. See {@link laneIndex}. Default 0 (off). */
  laneCount?: number;
  /** Gap between adjacent lanes, in CSS px. Default 6. */
  laneGapPx?: number;
}

export class AreaChartLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
  private fillOpacity = 0.2;
  private lineWidth = 1;
  private visible = true;
  // undefined = auto (decimate iff oversampled); true/false = explicit override.
  private decimate: boolean | undefined = undefined;
  private maxGapMs: number | undefined;
  private dashArray: number[] = [];
  private yOffset = 0;
  private laneIndex = 0;
  private laneCount = 0;
  private laneGapPx = 6;
  private scannedYMin = Number.NaN;
  private scannedYMax = Number.NaN;
  private ring: RingBuffer;

  constructor(id: string) {
    this.id = id;
    this.ring = createStreamingRing(2048);
  }

  setConfig(config: unknown): void {
    const c = config as AreaChartConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.fillOpacity !== undefined)
      this.fillOpacity = Math.max(0, Math.min(1, c.fillOpacity));
    if (c.lineWidth !== undefined) this.lineWidth = c.lineWidth;
    if (c.visible !== undefined) this.visible = c.visible;
    if (c.decimate !== undefined) this.decimate = c.decimate;
    if (c.maxGapMs !== undefined) this.maxGapMs = c.maxGapMs;
    if (c.dashArray !== undefined) this.dashArray = c.dashArray;
    if (c.yOffset !== undefined) this.yOffset = c.yOffset;
    if (c.laneIndex !== undefined) this.laneIndex = c.laneIndex;
    if (c.laneCount !== undefined) this.laneCount = c.laneCount;
    if (c.laneGapPx !== undefined) this.laneGapPx = c.laneGapPx;
    const cap = computeRingCapacity(c);
    if (cap !== undefined && cap !== this.ring.capacity) {
      this.ring = createStreamingRing(cap);
    }
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    pushSamples(this.ring, buffer, length, viewport, 2);
  }

  resize(_viewport: Viewport): void {}

  scan(viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;
    const xMin = viewport.bounds.xMin;
    const lane = this.laneActive();
    const off0 = lane ? 0 : this.yOffset; // lanes normalize per-layer
    // Sliding-window y-extent in O(log n); see LineChartLayer.scan for the
    // bit-exactness rationale (constant off0 added after the min/max).
    const rawMin = this.ring.extentMin(xMin);
    if (lane) {
      this.scannedYMin = rawMin;
      this.scannedYMax = this.ring.extentMax(xMin);
    } else if (rawMin !== Number.POSITIVE_INFINITY) {
      const lo = rawMin + off0;
      const hi = this.ring.extentMax(xMin) + off0;
      if (lo < viewport.observedYMin) viewport.observedYMin = lo;
      if (hi > viewport.observedYMax) viewport.observedYMax = hi;
    }
  }

  private laneActive(): boolean {
    return this.laneCount > 0;
  }

  /** Map a data `y` into this layer's lane band (own scanned range). */
  private yToBandPx(y: number, viewport: Viewport): number {
    const pad = viewport.yPadPx;
    const usable = viewport.plotHeight - pad * 2;
    const bandH = usable / this.laneCount;
    const gap = this.laneGapPx;
    const top = pad + this.laneIndex * bandH + gap / 2;
    const bottom = pad + (this.laneIndex + 1) * bandH - gap / 2;
    let lo = this.scannedYMin;
    let hi = this.scannedYMax;
    if (!(hi > lo)) {
      lo -= 0.5;
      hi += 0.5;
    }
    const frac = (y - lo) / (hi - lo);
    return bottom - frac * (bottom - top);
  }

  /** Pixel y of this lane's bottom (fill baseline in lane mode). */
  private laneBottomPx(viewport: Viewport): number {
    const pad = viewport.yPadPx;
    const usable = viewport.plotHeight - pad * 2;
    const bandH = usable / this.laneCount;
    return pad + (this.laneIndex + 1) * bandH - this.laneGapPx / 2;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.ring.length < 2) return;
    const lane = this.laneActive();
    if (lane && !Number.isFinite(this.scannedYMin)) return;

    const xMin = viewport.bounds.xMin;
    // Decimate when oversampled — min/max-per-column envelope for both fill and
    // stroke. AUTO unless `decimate` is explicitly set; `false` opts out.
    if (this.decimate !== false && this.ring.length > viewport.plotWidth * 2) {
      this._drawDecimated(ctx, viewport, xMin);
      return;
    }
    // In lane mode the fill runs to the band's bottom; otherwise to y=0.
    const baselinePy = lane ? this.laneBottomPx(viewport) : viewport.yToPx(0);
    const yPx = (y: number): number =>
      lane ? this.yToBandPx(y, viewport) : viewport.yToPx(y + this.yOffset);
    const gap = this.maxGapMs;

    // Pass 1 — fill: one closed-to-baseline polygon per gap-separated
    // segment. With maxGapMs unset there is exactly one segment, producing
    // the same call sequence as before.
    ctx.beginPath();
    let segFirstPx = 0;
    let prevPx = 0;
    let prevT = 0;
    let inSeg = false;
    let any = false;
    const closeSeg = (): void => {
      ctx.lineTo(prevPx, baselinePy);
      ctx.lineTo(segFirstPx, baselinePy);
      ctx.closePath();
    };
    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      const px = viewport.xToPx(t);
      const py = yPx(data[off + 1]);
      if (inSeg && gap !== undefined && t - prevT > gap) {
        closeSeg();
        inSeg = false;
      }
      if (!inSeg) {
        ctx.moveTo(px, py);
        segFirstPx = px;
        inSeg = true;
        any = true;
      } else {
        ctx.lineTo(px, py);
      }
      prevPx = px;
      prevT = t;
    });

    if (!any) return; // no visible points

    closeSeg();
    ctx.fillStyle = hexToRgba(this.color, this.fillOpacity);
    ctx.fill();

    // Pass 2 — stroke on top, breaking at gaps (no baseline segments).
    ctx.beginPath();
    let first = true;
    prevT = 0;
    this.ring.forEach((data, off) => {
      const t = data[off];
      if (t < xMin) return;
      const px = viewport.xToPx(t);
      const py = yPx(data[off + 1]);
      if (first || (gap !== undefined && t - prevT > gap)) {
        ctx.moveTo(px, py);
        first = false;
      } else {
        ctx.lineTo(px, py);
      }
      prevT = t;
    });
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    const dashed = this.dashArray.length > 0;
    if (dashed) ctx.setLineDash(this.dashArray);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  /**
   * Min/max-per-pixel-column fill + stroke (see {@link forEachColumn}). Each
   * gap-segment's fill closes to the baseline; the envelope (min/max per column)
   * is preserved at display resolution while bounding draw to O(width).
   */
  private _drawDecimated(
    ctx: OffscreenCanvasRenderingContext2D,
    viewport: Viewport,
    xMin: number,
  ): void {
    const lane = this.laneActive();
    const baselinePy = lane ? this.laneBottomPx(viewport) : viewport.yToPx(0);
    const yPx = (y: number): number =>
      lane ? this.yToBandPx(y, viewport) : viewport.yToPx(y + this.yOffset);
    const gap = this.maxGapMs;
    // Reused per-column scratch (first/min/max/last) — avoids one array alloc
    // per pixel column per pass (× many charts × fps).
    const pts = [0, 0, 0, 0];

    // Pass 1 — fill: one closed-to-baseline polygon per gap-segment.
    ctx.beginPath();
    let segFirstPx = 0;
    let prevPx = 0;
    let inSeg = false;
    let any = false;
    const closeSeg = (): void => {
      ctx.lineTo(prevPx, baselinePy);
      ctx.lineTo(segFirstPx, baselinePy);
      ctx.closePath();
    };
    forEachColumn(this.ring, viewport, xMin, gap, {
      onColumn: (colPx, firstY, minY, maxY, lastY) => {
        pts[0] = firstY;
        pts[1] = minY;
        pts[2] = maxY;
        pts[3] = lastY;
        for (let k = 0; k < pts.length; k++) {
          if (k > 0 && pts[k] === pts[k - 1]) continue;
          const py = yPx(pts[k]!);
          if (!inSeg) {
            ctx.moveTo(colPx, py);
            segFirstPx = colPx;
            inSeg = true;
            any = true;
          } else {
            ctx.lineTo(colPx, py);
          }
        }
        prevPx = colPx;
      },
      onGapBreak: () => {
        if (inSeg) {
          closeSeg();
          inSeg = false;
        }
      },
    });
    if (inSeg) closeSeg();
    if (!any) return; // no visible columns
    ctx.fillStyle = hexToRgba(this.color, this.fillOpacity);
    ctx.fill();

    // Pass 2 — stroke on top, breaking at gaps (no baseline segments).
    ctx.beginPath();
    let first = true;
    forEachColumn(this.ring, viewport, xMin, gap, {
      onColumn: (colPx, firstY, minY, maxY, lastY) => {
        pts[0] = firstY;
        pts[1] = minY;
        pts[2] = maxY;
        pts[3] = lastY;
        for (let k = 0; k < pts.length; k++) {
          if (k > 0 && pts[k] === pts[k - 1]) continue;
          const py = yPx(pts[k]!);
          if (first) {
            ctx.moveTo(colPx, py);
            first = false;
          } else {
            ctx.lineTo(colPx, py);
          }
        }
      },
      onGapBreak: () => {
        first = true;
      },
    });
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    const dashed = this.dashArray.length > 0;
    if (dashed) ctx.setLineDash(this.dashArray);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  clearData(): void {
    this.ring.clear();
  }

  dispose(): void {
    this.ring.clear();
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
