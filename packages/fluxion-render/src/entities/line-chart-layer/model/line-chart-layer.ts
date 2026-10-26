import type { GlRenderer } from "../../../shared/gl/gl-renderer";
import {
  type ClipTransform,
  dataToClip,
  laneToClip,
} from "../../../shared/gl/gl-transform";
import { buildLineVertices } from "../../../shared/gl/line-geometry";
import { type ColumnSink, forEachColumn } from "../../../shared/lib/column-reduce";
import { parseColor } from "../../../shared/lib/parse-color";
import { pushSamples } from "../../../shared/lib/push-samples";
import { computeRingCapacity } from "../../../shared/lib/ring-capacity";
import type { Layer } from "../../../shared/model/layer";
import { createStreamingRing, type RingBuffer } from "../../../shared/model/ring-buffer";
import type { Viewport } from "../../../shared/model/viewport";

export type { LineChartConfig } from "../../../shared/model/layer-configs";

import type { LineChartConfig } from "../../../shared/model/layer-configs";

/**
 * Streaming time-series line chart. Expects `Float32Array [t, y, t, y, ...]`
 * where `t` is host-relative milliseconds (monotonic). Each `setData` call
 * appends to an internal ring buffer, so draw cost is O(capacity), not O(total
 * samples pushed).
 *
 * On every append the layer advances `viewport.latestT` so the axis-grid in
 * `xMode: "time"` can compute a trailing sliding window.
 *
 * **Float32 timestamp range**: `t` is stored as Float32 in the wire format,
 * so absolute ms-since-epoch (~1.78e12) quantises to ~131,072 ms buckets and
 * collapses sub-second samples onto a single x coordinate. Always push
 * host-relative `t` (e.g. `Date.now() - timeOrigin`, where `timeOrigin` is the
 * session start) and let `axisGridLayer({ timeOrigin })` reconstruct wall-clock
 * labels at draw time.
 */
export class LineChartLayer implements Layer {
  readonly id: string;
  private color = "#4fc3f7";
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
  private opacity = 1;
  // Per-layer visible y-extent from the last scan() — used to normalize this
  // layer's lane band independently of the shared viewport. NaN until scanned.
  private _glGeometryKey = "";
  private _glVertexCount = 0;
  private _glRevision = 0;
  private scannedYMin = Number.NaN;
  private scannedYMax = Number.NaN;
  private ring: RingBuffer;
  // One-shot guard for the undersized-capacity warning (see scan()).
  private warnedUndersized = false;

  constructor(id: string) {
    this.id = id;
    this.ring = createStreamingRing(2048);
  }

  setConfig(config: unknown): void {
    this._glGeometryKey = "";
    const c = config as LineChartConfig;
    if (c.color !== undefined) this.color = c.color;
    if (c.lineWidth !== undefined) this.lineWidth = c.lineWidth;
    if (c.visible !== undefined) this.visible = c.visible;
    if (c.decimate !== undefined) this.decimate = c.decimate;
    if (c.maxGapMs !== undefined) this.maxGapMs = c.maxGapMs;
    if (c.dashArray !== undefined) this.dashArray = c.dashArray;
    if (c.yOffset !== undefined) this.yOffset = c.yOffset;
    if (c.laneIndex !== undefined) this.laneIndex = c.laneIndex;
    if (c.laneCount !== undefined) this.laneCount = c.laneCount;
    if (c.laneGapPx !== undefined) this.laneGapPx = c.laneGapPx;
    if (c.opacity !== undefined) this.opacity = c.opacity;
    const newCapacity = computeRingCapacity(c);
    if (newCapacity !== undefined && newCapacity !== this.ring.capacity) {
      this.ring = createStreamingRing(newCapacity);
      // New ring — re-arm the undersized warning so a still-too-small capacity
      // can warn again (and a now-adequate one simply won't).
      this.warnedUndersized = false;
    }
  }

  setData(buffer: ArrayBuffer, length: number, viewport: Viewport): void {
    pushSamples(this.ring, buffer, length, viewport, 2);
  }

  resize(_viewport: Viewport): void {}

  /**
   * Pre-draw pass: compute the visible-window min/max of y values in this
   * layer's ring buffer and merge them into `viewport.observedYMin/Max`.
   * AxisGridLayer with `yMode: "auto"` reads the aggregate in draw.
   *
   * `viewport.bounds.xMin` was already written by AxisGridLayer.scan (which
   * runs earlier in insertion order), so we can filter stale samples here.
   */
  scan(viewport: Viewport): void {
    if (!this.visible || this.ring.length === 0) return;
    const xMin = viewport.bounds.xMin;
    const lane = this.laneActive();
    // Lane mode normalizes per-layer (own band), so it neither applies yOffset
    // nor contributes to the shared observed range; it tracks its OWN extent.
    const off0 = lane ? 0 : this.yOffset;
    // Sliding-window y-extent in O(log n) (two monotonic deques in the ring),
    // replacing the per-frame full-ring scan. `rawMin`/`rawMax` are over samples
    // in [xMin, xMax]; +/-Infinity when the window is empty. Adding the constant
    // `off0` after the min/max is bit-identical to adding it per sample.
    // A lane band also covers the first sample past xMax: every draw path
    // strokes to it to reach the right edge, and the band is not clipped, so
    // leaving it out would throw that edge segment out of the lane.
    const xMax = viewport.bounds.xMax;
    const rawMin = this.ring.extentMin(xMin, xMax, lane);
    if (lane) {
      this.scannedYMin = rawMin;
      this.scannedYMax = this.ring.extentMax(xMin, xMax, true);
    } else if (rawMin !== Number.POSITIVE_INFINITY) {
      // Non-empty window: widen the shared observed range (an empty window left
      // the old loop's min/max at the incoming observed values — a no-op).
      const lo = rawMin + off0;
      const hi = this.ring.extentMax(xMin, xMax) + off0;
      if (lo < viewport.observedYMin) viewport.observedYMin = lo;
      if (hi > viewport.observedYMax) viewport.observedYMax = hi;
    }

    // Undersized-capacity guard (once). When the ring is full AND its oldest
    // retained sample is still inside the visible window, older in-window
    // samples have already been evicted — i.e. the window wants to show more
    // than the ring can hold, so data is being dropped silently.
    if (
      !this.warnedUndersized &&
      this.ring.length === this.ring.capacity &&
      this.ring.oldestValue(0) >= xMin
    ) {
      this.warnedUndersized = true;
      console.warn(
        `[fluxion] Layer "${this.id}": ring capacity (${this.ring.capacity}) is ` +
          "smaller than the visible window holds — oldest samples are dropped before " +
          "they scroll off. Increase capacity, or set retentionMs+maxHz.",
      );
    }
  }

  private laneActive(): boolean {
    return this.laneCount > 0;
  }

  /**
   * Map a data `y` into this layer's lane band, normalized to its own scanned
   * y-range — independent of the shared `viewport.yToPx`.
   */
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
      // Flat or single-value series — give the band some vertical room.
      lo -= 0.5;
      hi += 0.5;
    }
    const frac = (y - lo) / (hi - lo);
    return bottom - frac * (bottom - top);
  }

  // WebGL scratch: persistent vertex buffer sized to the ring capacity, plus
  // the strip-break index list and the 6-slot uniform transform — one
  // allocation set per layer, reused every frame.
  private _glVerts: Float32Array | null = null;
  private readonly _glBreaks: number[] = [];
  private readonly _glTransform: ClipTransform = new Float32Array(6);
  private _warnedGlDash = false;

  /**
   * WebGL draw path: raw `(t, y)` vertices streamed to the shared VBO, the
   * data→clip affine applied in the vertex shader. Decimation is deliberately
   * skipped under GL — the GPU rasterizes full-resolution strips in the
   * noise, so the drawn shape is the ground truth the 2d decimated path
   * approximates. `dashArray` is unsupported (warned once, drawn solid);
   * `lineWidth` is clamped to the device's aliased range.
   */
  drawGl(glr: GlRenderer, viewport: Viewport): void {
    if (!this.visible || this.ring.length < 2) return;
    if (this.laneActive() && !Number.isFinite(this.scannedYMin)) return;
    if (this.dashArray.length > 0 && !this._warnedGlDash) {
      this._warnedGlDash = true;
      console.warn(
        `[fluxion] line layer "${this.id}": dashArray is not supported under ` +
          "renderer:'webgl' — drawing solid.",
      );
    }
    if (!this._glVerts || this._glVerts.length !== this.ring.capacity * 2) {
      this._glVerts = new Float32Array(this.ring.capacity * 2);
    }
    const geometryKey = `${this.ring.version}:${this.ring.capacity}:${viewport.bounds.xMin}:${viewport.bounds.xMax}:${this.maxGapMs}`;
    if (this._glGeometryKey !== geometryKey) {
      this._glGeometryKey = geometryKey;
      this._glVertexCount = buildLineVertices(
        this.ring,
        viewport.bounds.xMin,
        this.maxGapMs,
        this._glVerts,
        this._glBreaks,
        viewport.bounds.xMax,
      );
      this._glRevision++;
    }
    const n = this._glVertexCount;
    if (n < 2) return;
    if (this.laneActive()) {
      // Same band math as yToBandPx, expressed as an affine for the shader.
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
      laneToClip(viewport, top, bottom, lo, hi, this._glTransform);
    } else {
      dataToClip(viewport, this.yOffset, this._glTransform);
    }
    const rgba = parseColor(this.color) ?? ([1, 1, 1, 1] as const);
    glr.drawLineStrip(
      this._glVerts,
      n,
      this._glBreaks,
      this._glTransform,
      rgba,
      this.opacity,
      this.lineWidth * viewport.dpr,
      this._glRevision,
    );
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.visible || this.ring.length < 2) return;
    // Lane mode needs an in-window y-extent from scan; skip if none this frame.
    if (this.laneActive() && !Number.isFinite(this.scannedYMin)) return;

    const faded = this.opacity !== 1;
    const prevAlpha = ctx.globalAlpha;
    if (faded) ctx.globalAlpha = this.opacity;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    const dashed = this.dashArray.length > 0;
    if (dashed) ctx.setLineDash(this.dashArray);
    ctx.beginPath();

    // Sample filter: skip records older than the current x-window. Combined
    // with axis-grid time mode, this lets consumers "select a window" by
    // changing `timeWindowMs` and have the chart both retarget AND drop
    // old samples from the drawn path in one go.
    const xMin = viewport.bounds.xMin;

    // Decimate the DRAW (not the data) when there are far more visible samples
    // than pixels — emit min/max per x-pixel column so the rendered shape is
    // identical but the path is O(width) instead of O(samples). AUTO (decimate
    // omitted) enables this whenever oversampled; `decimate:false` opts out.
    const oversampled = this.ring.length > viewport.plotWidth * 2;
    if (this.decimate !== false && oversampled) {
      this._drawDecimated(ctx, viewport, xMin);
      ctx.stroke();
      if (dashed) ctx.setLineDash([]);
      if (faded) ctx.globalAlpha = prevAlpha;
      return;
    }

    const gap = this.maxGapMs;
    const lane = this.laneActive();
    let first = true;
    let prevT = 0;
    // Same sample window as the decimated and WebGL paths: up to the first
    // sample past xMax (the stroke into the right edge), which scan() keeps
    // inside a lane band.
    this.ring.forEachRange(
      xMin,
      viewport.bounds.xMax,
      (data, off) => {
        const t = data[off];
        const px = viewport.xToPx(t);
        const py = lane
          ? this.yToBandPx(data[off + 1], viewport)
          : viewport.yToPx(data[off + 1] + this.yOffset);
        // Break the stroke across a time gap larger than maxGapMs — the
        // silence shows as a real hole instead of a bridging diagonal.
        if (first || (gap !== undefined && t - prevT > gap)) {
          ctx.moveTo(px, py);
          first = false;
        } else {
          ctx.lineTo(px, py);
        }
        prevT = t;
      },
      true,
    );
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
    if (faded) ctx.globalAlpha = prevAlpha;
  }

  /**
   * Min/max-per-pixel-column path. For each integer x-pixel that has samples,
   * draw to the column's first, min-y, max-y and last sample (in time order
   * within the column) — preserving every visible peak/trough at display
   * resolution while bounding the path to ~2–4 points per pixel.
   */
  // Decimated-draw scratch, persistent across frames so the hot path allocates
  // nothing per draw or per pixel column (the sink object, its closures, and
  // the 4-point scratch used to be rebuilt every frame — O(width) allocs).
  // `_dCtx`/`_dViewport` use definite assignment: `_drawDecimated` sets them
  // before `forEachColumn` can invoke the sink.
  private readonly _pts = [0, 0, 0, 0];
  private _dCtx!: OffscreenCanvasRenderingContext2D;
  private _dViewport!: Viewport;
  private _dLane = false;
  private _dFirst = true;
  private readonly _sink: ColumnSink = {
    // Emit first → min → max → last (skipping duplicates) so the column's
    // vertical extent is drawn without redundant points.
    onColumn: (colPx, firstY, minY, maxY, lastY) => {
      const pts = this._pts;
      pts[0] = firstY;
      pts[1] = minY;
      pts[2] = maxY;
      pts[3] = lastY;
      for (let k = 0; k < pts.length; k++) {
        if (k > 0 && pts[k] === pts[k - 1]) continue;
        const py = this._dLane
          ? this.yToBandPx(pts[k]!, this._dViewport)
          : this._dViewport.yToPx(pts[k]! + this.yOffset);
        if (this._dFirst) {
          this._dCtx.moveTo(colPx, py);
          this._dFirst = false;
        } else {
          this._dCtx.lineTo(colPx, py);
        }
      }
    },
    // A gap forces the next emitted point to start a new subpath.
    onGapBreak: () => {
      this._dFirst = true;
    },
  };

  private _drawDecimated(
    ctx: OffscreenCanvasRenderingContext2D,
    viewport: Viewport,
    xMin: number,
  ): void {
    this._dCtx = ctx;
    this._dViewport = viewport;
    this._dLane = this.laneActive();
    this._dFirst = true;
    forEachColumn(this.ring, viewport, xMin, this.maxGapMs, this._sink);
  }

  clearData(): void {
    this.ring.clear();
  }

  dispose(): void {
    this.ring.clear();
  }
}
