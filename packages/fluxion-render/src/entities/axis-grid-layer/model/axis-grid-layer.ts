import {
  formatTick,
  formatYTick,
  type XTickFormat,
  type YTickFormat,
} from "../../../shared/lib/axis-ticks";
import { drawLabel } from "../../../shared/lib/label-cache";
import { intervalTicks, niceStep, niceTicks } from "../../../shared/lib/math";
import type { Layer } from "../../../shared/model/layer";
import type { Bounds, Viewport } from "../../../shared/model/viewport";
import type { AxisStyle } from "../../../shared/protocol";

export interface AxisGridConfig {
  /** Fixed x-range. Used when `xMode` is "fixed" (default). */
  xRange?: [number, number];
  yRange?: [number, number];
  gridColor?: string;
  /** Grid line width in CSS px. Default 1. */
  gridLineWidth?: number;
  axisColor?: string;
  labelColor?: string;
  font?: string;
  targetTicks?: number;
  /** If true (default), writes this layer's bounds into `viewport` so data layers share them. */
  applyToViewport?: boolean;
  /**
   * "fixed": xRange is literal world units (default).
   * "time": bounds follow the streaming `viewport.latestT` as a trailing
   * sliding window `[latestT - timeWindowMs, latestT]`. yRange is still fixed.
   */
  xMode?: "fixed" | "time";
  /** Width of the sliding window in ms when xMode="time". Default 5000. */
  timeWindowMs?: number;
  /**
   * Absolute wall-clock epoch (ms) corresponding to data timestamp `0`. When
   * set together with `xMode: "time"`, tick labels render as wall clock
   * instead of elapsed seconds. Typically set once at host creation:
   * `timeOrigin: Date.now()` on the main thread.
   */
  timeOrigin?: number;
  /**
   * When true AND `xMode: "time"`, the trailing window's right edge tracks
   * wall-clock time (`Date.now() - timeOrigin`) every frame instead of the
   * data-driven `viewport.latestT`. The axis scrolls continuously even when no
   * stream data arrives; incoming samples (host-relative ms = `Date.now() -
   * timeOrigin` on the producer) land at the correct x. Requires `timeOrigin`
   * to be set — without it the window falls back to `latestT` (no follow).
   * Default false (data-driven, unchanged behavior). The engine starts a
   * continuous render loop while any axis layer has this enabled.
   */
  followClock?: boolean;
  /**
   * Formatter for x tick labels.
   *
   * - **String** clock-pattern (e.g. `"HH:mm:ss"`): used when `xMode: "time"`
   *   AND `timeOrigin` is set. Tokens: `HH / H / mm / m / ss / s / SSS / S`.
   *   Default `"HH:mm:ss"`. Ignored without `timeOrigin` — elapsed-seconds
   *   fallback (`"X.Xs"`) is used instead.
   * - **Object** `{ pattern?, precision?, suffix?, si? }`: serializable, so it
   *   works in EVERY render path — the worker's in-canvas labels, the
   *   external-axis canvas (`externalAxes`), and the React-side tick set. In
   *   time mode with `timeOrigin` and `pattern` it renders wall-clock;
   *   otherwise it formats the raw value numerically (precision/suffix/si).
   *   Use this for non-time axes or worker-drawn numeric labels.
   * - **Function** `(value: number) => string`: called for every tick value
   *   regardless of `xMode`, but CANNOT cross the worker boundary (it is
   *   stripped before postMessage), so it applies on the React side only
   *   (`useAxisTicks`); worker-drawn labels fall back to the raw value. Prefer
   *   the string or object form with `externalAxes`.
   */
  xTickFormat?: XTickFormat;

  // ─── y scaling ────────────────────────────────────────────
  /**
   * "fixed" (default): use configured `yRange`.
   * "auto": data-driven. Reads `viewport.observedYMin/Max` during draw,
   * applies padding and clamps, updates `bounds.yMin/yMax`. Requires at
   * least one data layer (e.g. `LineChartLayer`) in the stack to publish
   * observations via its `scan()` pass.
   */
  yMode?: "fixed" | "auto";
  /** Padding ratio applied above/below the observed range. Default 0.1 (10%). */
  yAutoPadding?: number;
  /** Absolute lower clamp after padding. */
  yAutoMin?: number;
  /** Absolute upper clamp after padding. */
  yAutoMax?: number;
  /**
   * Minimum y span for auto mode. When the padded range is narrower than this
   * value, the range is symmetrically expanded around its midpoint.
   * Applied after `yAutoMin`/`yAutoMax` clamps.
   * Example: `yAutoMinSpan: 0.1` ensures the axis always spans at least 0.1.
   */
  yAutoMinSpan?: number;
  /**
   * Formatter for y tick labels.
   *
   * - **Object** `{ precision?, suffix?, si? }`: serializable, so it works in
   *   EVERY render path — the worker's in-canvas labels, the external-axis
   *   canvas (`externalAxes`), and the React-side tick set. Use this for the
   *   common cases (fixed precision, unit suffix, k/M/G scaling).
   * - **Function** `(value: number) => string`: cannot cross the worker
   *   boundary (it is stripped before postMessage), so it applies on the
   *   React side only (`useAxisTicks`); worker-drawn labels fall back to
   *   `String(value)`. Prefer the object form with `externalAxes`.
   */
  yTickFormat?: YTickFormat;

  // ─── Visual toggles (all default true) ────────────────────
  /** Show vertical grid lines at x ticks. */
  showXGrid?: boolean;
  /** Show horizontal grid lines at y ticks. */
  showYGrid?: boolean;
  /** Show the x=0 / y=0 axis lines when 0 is inside the range. */
  showAxes?: boolean;
  /** Show tick labels along the x axis. */
  showXLabels?: boolean;
  /** Show tick labels along the y axis. */
  showYLabels?: boolean;
  /**
   * Canvas setLineDash pattern for grid lines. Default [] (solid).
   * Example: [3, 3] produces the dashed style used by recharts.
   */
  gridDashArray?: number[];
  /**
   * Fixed x tick interval in ms. When set, overrides `targetTicks` and
   * snaps tick positions to multiples of this value.
   * Example: `xTickIntervalMs: 1000` produces ticks at exactly 1-second boundaries.
   */
  xTickIntervalMs?: number;
  /**
   * Vertical inset in CSS pixels applied to both the chart canvas (via
   * `viewport.yPadPx`) and the external axis canvas (matched constant).
   * Keeps grid lines and data strokes away from the top/bottom edge so
   * external axis tick labels at fraction 0/1 have room to render without
   * clipping. Default 0 (no padding). Set to 8 when using `externalAxes`.
   */
  yPadPx?: number;
}

/**
 * Owns the viewport bounds orchestration for a chart: x window (fixed or
 * time-sliding), y range (fixed or data-driven auto), and renders the
 * visible grid/axes/labels on top.
 *
 * Orchestration (scan + bounds computation) runs independently of the
 * visual toggles — you can turn every `show*` off and still use this layer
 * purely as a controller. LayerStack insertion order matters: add this
 * before any data layer so the bounds are written before they're read.
 *
 * v0.3 limitation: single-axis only. `observedYMin/Max` live on `Viewport`,
 * so a second `AxisGridLayer` in the same stack would bleed observations.
 */
export class AxisGridLayer implements Layer {
  readonly id: string;
  private gridColor = "rgba(255,255,255,0.08)";
  private gridLineWidth = 1;
  private axisColor = "rgba(255,255,255,0.4)";
  private labelColor = "rgba(255,255,255,0.7)";
  private font = "10px sans-serif";
  private targetTicks = 6;
  private bounds: Bounds = { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
  private applyToViewport = true;
  private xMode: "fixed" | "time" = "fixed";
  private timeWindowMs = 5000;
  private timeOrigin: number | null = null;
  private followClock = false;
  private xTickFormat: XTickFormat = "HH:mm:ss";
  private yTickFormat: YTickFormat | undefined;
  private yMode: "fixed" | "auto" = "fixed";
  private yAutoPadding = 0.1;
  private yAutoMin: number | undefined;
  private yAutoMax: number | undefined;
  private yAutoMinSpan: number | undefined;
  private showXGrid = true;
  private showYGrid = true;
  private showAxes = true;
  private showXLabels = true;
  private showYLabels = true;
  private gridDashArray: number[] = [];
  private yPadPx = 0;
  private xTickIntervalMs: number | undefined;
  // Monotonic-clock anchor for follow-clock. Captured on the first `now()`
  // call; thereafter the wall clock is derived from `performance.now()` deltas
  // (see `now()`).
  private epochAtAnchor: number | null = null;
  private perfAtAnchor = 0;
  // One-shot guard so a misconfigured follow-clock (no timeOrigin) warns once.
  private warnedFollowNoOrigin = false;

  // Cache of y-tick values + formatted labels, keyed on the y-bounds they were
  // computed for. y-ticks only change when y-bounds move (or config changes —
  // which nulls this), so a follow-clock x-axis scrolling every frame no longer
  // re-runs niceTicks + formatYTick for an unchanged y-axis. `setConfig` clears
  // it so a new targetTicks / yTickFormat takes effect.
  private yTickCache: {
    yMin: number;
    yMax: number;
    ticks: number[];
    labels: string[];
  } | null = null;

  // Cache of x-tick values + formatted labels. A scrolling time axis moves
  // xMin/xMax every frame but the tick VALUE SET only changes when a step
  // boundary is crossed (tick leaves left / enters right) — so the key is the
  // derived (step, start, count) triple, not the raw bounds. While it matches,
  // draw()/drawXAxis()/computeTicksForExport() all reuse one tick array and
  // one formatted-label array instead of re-running niceTicks/intervalTicks
  // (with its per-tick toFixed) and formatTick (Date + regex) every frame.
  // `setConfig` clears it (xMode/timeOrigin/format/targetTicks/interval…).
  private xTickCache: {
    step: number;
    start: number;
    count: number;
    ticks: number[];
    labels: string[];
  } | null = null;

  private static readonly EMPTY_TICKS: { ticks: number[]; labels: string[] } = {
    ticks: [],
    labels: [],
  };

  constructor(id: string) {
    this.id = id;
  }

  /**
   * x-tick values and their formatted labels for the current x-bounds, reusing
   * the cached result while the tick set is unchanged (steady scroll). The
   * (step, start, count) key is exact at step crossings: both generators
   * accumulate the identical float `start` by the identical float `step`, so
   * an equal key implies a bit-identical tick sequence. (The arithmetic
   * `count` can disagree with the generator's accumulated loop within ~1 ulp
   * of the right edge — worst case a right-edge tick appears one frame
   * early/late; transient and visually invisible.)
   */
  private xTicksFor(): { ticks: number[]; labels: string[] } {
    const { xMin, xMax } = this.bounds;
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin) {
      return AxisGridLayer.EMPTY_TICKS;
    }
    const step = this.xTickIntervalMs ?? niceStep(xMax - xMin, this.targetTicks);
    if (step <= 0) return AxisGridLayer.EMPTY_TICKS;
    const start = Math.ceil(xMin / step) * step;
    const limit = xMax + step * 1e-6;
    const count = start > limit ? 0 : Math.floor((limit - start) / step) + 1;
    const c = this.xTickCache;
    if (c && c.step === step && c.start === start && c.count === count) return c;
    const ticks =
      this.xTickIntervalMs != null
        ? intervalTicks(xMin, xMax, this.xTickIntervalMs)
        : niceTicks(xMin, xMax, this.targetTicks);
    const labels = new Array<string>(ticks.length);
    for (let i = 0; i < ticks.length; i++) {
      labels[i] = formatTick(ticks[i]!, this.xMode, this.timeOrigin, this.xTickFormat);
    }
    this.xTickCache = { step, start, count, ticks, labels };
    return this.xTickCache;
  }

  /**
   * y-tick values and their formatted labels for the current y-bounds, reusing
   * the cached result while the bounds are unchanged.
   */
  private yTicksFor(): { ticks: number[]; labels: string[] } {
    const cache = this.yTickCache;
    if (cache && cache.yMin === this.bounds.yMin && cache.yMax === this.bounds.yMax) {
      return cache;
    }
    const ticks = niceTicks(this.bounds.yMin, this.bounds.yMax, this.targetTicks);
    const labels = ticks.map((v) => formatYTick(v, this.yTickFormat));
    this.yTickCache = { yMin: this.bounds.yMin, yMax: this.bounds.yMax, ticks, labels };
    return this.yTickCache;
  }

  setConfig(config: unknown): void {
    const c = config as AxisGridConfig;
    if (c.xRange) {
      this.bounds.xMin = c.xRange[0];
      this.bounds.xMax = c.xRange[1];
    }
    if (c.yRange) {
      this.bounds.yMin = c.yRange[0];
      this.bounds.yMax = c.yRange[1];
    }
    if (c.gridColor) this.gridColor = c.gridColor;
    if (c.gridLineWidth !== undefined) this.gridLineWidth = c.gridLineWidth;
    if (c.axisColor) this.axisColor = c.axisColor;
    if (c.labelColor) this.labelColor = c.labelColor;
    if (c.font) this.font = c.font;
    if (c.targetTicks) this.targetTicks = c.targetTicks;
    if (c.applyToViewport !== undefined) this.applyToViewport = c.applyToViewport;
    if (c.xMode !== undefined) this.xMode = c.xMode;
    if (c.timeWindowMs !== undefined) this.timeWindowMs = c.timeWindowMs;
    if (c.timeOrigin !== undefined) this.timeOrigin = c.timeOrigin;
    if (c.followClock !== undefined) this.followClock = c.followClock;
    if (c.xTickFormat !== undefined) this.xTickFormat = c.xTickFormat;
    if (c.yTickFormat !== undefined) this.yTickFormat = c.yTickFormat;
    if (c.yMode !== undefined) this.yMode = c.yMode;
    if (c.yAutoPadding !== undefined) this.yAutoPadding = c.yAutoPadding;
    if (c.yAutoMin !== undefined) this.yAutoMin = c.yAutoMin;
    if (c.yAutoMax !== undefined) this.yAutoMax = c.yAutoMax;
    if (c.yAutoMinSpan !== undefined) this.yAutoMinSpan = c.yAutoMinSpan;
    if (c.showXGrid !== undefined) this.showXGrid = c.showXGrid;
    if (c.showYGrid !== undefined) this.showYGrid = c.showYGrid;
    if (c.showAxes !== undefined) this.showAxes = c.showAxes;
    if (c.showXLabels !== undefined) this.showXLabels = c.showXLabels;
    if (c.showYLabels !== undefined) this.showYLabels = c.showYLabels;
    if (c.gridDashArray !== undefined) this.gridDashArray = c.gridDashArray;
    if (c.yPadPx !== undefined) this.yPadPx = c.yPadPx;
    if (c.xTickIntervalMs !== undefined) this.xTickIntervalMs = c.xTickIntervalMs;

    // followClock without timeOrigin silently falls back to data-driven
    // `latestT` (no clock follow) — warn once so the misconfig is visible.
    if (
      !this.warnedFollowNoOrigin &&
      this.followClock &&
      this.xMode === "time" &&
      this.timeOrigin == null
    ) {
      this.warnedFollowNoOrigin = true;
      console.warn(
        `[fluxion] axisGridLayer "${this.id}": followClock requires timeOrigin; ` +
          "window falls back to latestT (no clock follow).",
      );
    }

    // Any config change can affect tick values/labels (targetTicks, formats,
    // ranges, xMode/timeOrigin/interval); drop both caches so the next draw
    // recomputes.
    this.yTickCache = null;
    this.xTickCache = null;
  }

  setData(_buffer: ArrayBuffer, _length: number, _viewport: Viewport): void {}

  resize(_viewport: Viewport): void {}

  /**
   * Orchestration pass: establish x bounds so data layers' `scan` can filter
   * visible samples correctly. yMode:"auto" is finalized in `draw` after all
   * line layers have published their observations.
   */
  scan(viewport: Viewport): void {
    viewport.yPadPx = this.yPadPx;
    if (this.xMode === "time") {
      // follow-clock wins when enabled and timeOrigin is known: the right edge
      // tracks wall-clock now so the window scrolls even with no new data.
      // Otherwise the existing data-driven latestT path is preserved unchanged.
      const rightEdge =
        this.followClock && this.timeOrigin != null
          ? this.now() - this.timeOrigin
          : viewport.latestT;
      this.bounds.xMin = rightEdge - this.timeWindowMs;
      this.bounds.xMax = rightEdge;
    }
    if (this.applyToViewport) {
      viewport.setBounds(this.bounds);
    }
  }

  /**
   * Monotonic wall clock for the follow-clock window. Anchors the relationship
   * between epoch (`Date.now()`) and the monotonic `performance.now()` on first
   * use, then derives "now" from `performance.now()` deltas. This keeps the
   * window from jumping backward if `Date.now()` steps back (NTP/manual change)
   * and survives the worker-vs-main `performance.now()` origin difference
   * because only deltas are used.
   *
   * Trade-off: the epoch↔perf relationship is frozen for the session, so this
   * does not self-correct slow real-clock drift (a few ms over a multi-hour
   * session). "No jumps" is the right call for a scrolling axis.
   *
   * Stays a private method so tests can replace the whole seam via spyOn.
   */
  private now(): number {
    if (this.epochAtAnchor === null) {
      this.epochAtAnchor = Date.now();
      this.perfAtAnchor = performance.now();
    }
    return this.epochAtAnchor + (performance.now() - this.perfAtAnchor);
  }

  /**
   * Drop the monotonic-clock anchor so the next `now()` re-anchors to the
   * current `Date.now()`. Used when a hidden tab becomes visible again: the
   * window jumps once to true "now" (intended — elapsed time is real) instead
   * of resuming from a stale anchor.
   */
  resetClockAnchor(): void {
    this.epochAtAnchor = null;
  }

  /**
   * True when this layer drives a wall-clock-following time window — i.e.
   * `followClock` is set, `xMode` is "time", and `timeOrigin` is known. The
   * engine uses this to enable continuous rendering. Requiring `timeOrigin`
   * keeps a misconfigured chart (followClock without origin) at zero idle cost.
   */
  isFollowingClock(): boolean {
    return this.followClock && this.xMode === "time" && this.timeOrigin != null;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, viewport: Viewport): void {
    // Finalize y-auto bounds. Runs after all line-layer scans have
    // published their observed extents into the viewport.
    if (this.yMode === "auto") {
      let yMin = viewport.observedYMin;
      let yMax = viewport.observedYMax;
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        // No data yet — fall back to configured yRange. If that is also
        // degenerate (defaults [-1, 1] from construction), use [-1, 1].
        yMin = this.bounds.yMin;
        yMax = this.bounds.yMax;
        if (yMin === yMax) {
          yMin = -1;
          yMax = 1;
        }
      } else if (yMin === yMax) {
        // Flat line — expand so stroke has vertical room.
        yMin -= 0.5;
        yMax += 0.5;
      } else {
        const pad = (yMax - yMin) * this.yAutoPadding;
        yMin -= pad;
        yMax += pad;
      }
      if (this.yAutoMin !== undefined && yMin < this.yAutoMin) yMin = this.yAutoMin;
      if (this.yAutoMax !== undefined && yMax > this.yAutoMax) yMax = this.yAutoMax;
      if (this.yAutoMinSpan !== undefined && yMax - yMin < this.yAutoMinSpan) {
        const mid = (yMin + yMax) / 2;
        yMin = mid - this.yAutoMinSpan / 2;
        yMax = mid + this.yAutoMinSpan / 2;
      }
      this.bounds.yMin = yMin;
      this.bounds.yMax = yMax;
      if (this.applyToViewport) viewport.setBounds(this.bounds);
    }

    const { widthPx: w, heightPx: h } = viewport;
    const { ticks: xTicks, labels: xLabels } = this.xTicksFor();
    const { ticks: yTicks, labels: yLabels } = this.yTicksFor();

    // ── Grid lines ──
    if (this.showXGrid || this.showYGrid) {
      ctx.strokeStyle = this.gridColor;
      ctx.lineWidth = this.gridLineWidth;
      if (this.gridDashArray.length > 0) ctx.setLineDash(this.gridDashArray);
      ctx.beginPath();
      if (this.showXGrid) {
        for (let i = 0; i < xTicks.length; i++) {
          const x = Math.round(viewport.xToPx(xTicks[i])) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, viewport.plotBottom);
        }
      }
      if (this.showYGrid) {
        for (let i = 0; i < yTicks.length; i++) {
          const y = Math.round(viewport.yToPx(yTicks[i])) + 0.5;
          ctx.moveTo(viewport.plotLeft, y);
          ctx.lineTo(w, y);
        }
      }
      ctx.stroke();
      if (this.gridDashArray.length > 0) ctx.setLineDash([]);
    }

    // ── Zero axes ──
    if (this.showAxes) {
      ctx.strokeStyle = this.axisColor;
      ctx.beginPath();
      if (this.bounds.xMin < 0 && this.bounds.xMax > 0) {
        const x0 = Math.round(viewport.xToPx(0)) + 0.5;
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0, viewport.plotBottom);
      }
      if (this.bounds.yMin < 0 && this.bounds.yMax > 0) {
        const y0 = Math.round(viewport.yToPx(0)) + 0.5;
        ctx.moveTo(viewport.plotLeft, y0);
        ctx.lineTo(w, y0);
      }
      ctx.stroke();
    }

    // ── Labels ──
    // When the engine renders an external axis canvas for a side, skip that
    // side's in-plot labels: they'd be formatted and drawn twice per frame
    // (and visually duplicated). Grid lines above are unaffected.
    const drawXLabels = this.showXLabels && !viewport.externalXAxis;
    const drawYLabels = this.showYLabels && !viewport.externalYAxis;
    if (drawXLabels || drawYLabels) {
      ctx.fillStyle = this.labelColor;
      ctx.font = this.font;
      if (drawXLabels) {
        ctx.textBaseline = "top";
        const xOpts = {
          font: this.font,
          color: this.labelColor,
          align: "left",
          baseline: "top",
          dpr: viewport.dpr,
        } as const;
        for (let i = 0; i < xTicks.length; i++) {
          const x = viewport.xToPx(xTicks[i]);
          drawLabel(ctx, xLabels[i]!, x + 2, viewport.plotBottom - 12, xOpts);
        }
      }
      if (drawYLabels) {
        ctx.textBaseline = "middle";
        const yOpts = {
          font: this.font,
          color: this.labelColor,
          align: "left",
          baseline: "middle",
          dpr: viewport.dpr,
        } as const;
        for (let i = 0; i < yTicks.length; i++) {
          const y = viewport.yToPx(yTicks[i]);
          drawLabel(ctx, yLabels[i]!, viewport.plotLeft + 2, y - 6, yOpts);
        }
      }
    }
  }

  /**
   * Computes tick data for export via TICK_UPDATE postMessage.
   * Called by Engine after draw() so yMode:"auto" bounds are finalized.
   * When xTickFormat is a function, xTicks labels are left empty and
   * xRawValues is populated — the main thread applies the function.
   */
  computeTicksForExport(): {
    xTicks: { value: number; label: string; fraction: number }[];
    yTicks: { value: number; label: string; fraction: number }[];
    xRawValues: number[];
  } {
    const { ticks: xRaw, labels: xLabels } = this.xTicksFor();
    const yRaw = niceTicks(this.bounds.yMin, this.bounds.yMax, this.targetTicks);
    const xSpan = this.bounds.xMax - this.bounds.xMin;
    const ySpan = this.bounds.yMax - this.bounds.yMin;
    const isFnFormat = typeof this.xTickFormat === "function";
    return {
      xTicks: xRaw.map((v, i) => ({
        value: v,
        label: isFnFormat ? "" : xLabels[i]!,
        /* v8 ignore next -- empty span ⟹ xTicksFor returns [], so this map body never runs */
        fraction: xSpan > 0 ? (v - this.bounds.xMin) / xSpan : 0,
      })),
      yTicks: yRaw.map((v) => ({
        value: v,
        label: formatYTick(v, this.yTickFormat),
        /* v8 ignore next -- empty span ⟹ niceTicks returns [], so this map body never runs */
        fraction: ySpan > 0 ? (v - this.bounds.yMin) / ySpan : 0,
      })),
      xRawValues: isFnFormat ? xRaw : [],
    };
  }

  getXTickIntervalMs(): number | undefined {
    return this.xTickIntervalMs;
  }

  /**
   * Inline-axes mode: draw x/y tick marks and labels into the MAIN canvas
   * margins reserved by `viewport.insetLeft`/`insetBottom`. Called by the
   * engine AFTER the clipped data/grid pass (so labels land in the margins
   * unclipped) — must run after `draw()` so yMode:"auto" bounds are final.
   * Styling comes from the same `AxisStyle` the external axis canvases use.
   */
  drawInlineAxes(
    ctx: OffscreenCanvasRenderingContext2D,
    viewport: Viewport,
    style: AxisStyle,
  ): void {
    const color = style.color ?? "#666";
    const font = style.font ?? "11px sans-serif";
    const tickSize = style.tickSize ?? 6;
    const tickMargin = style.tickMargin ?? 4;
    const dpr = viewport.dpr;
    const plotBottom = viewport.plotBottom;
    const left = viewport.insetLeft;

    // ── Bottom strip: x ticks + labels ──
    if (viewport.insetBottom > 0) {
      const { ticks: xRaw, labels: xLabels } = this.xTicksFor();
      if (tickSize > 0 && xRaw.length > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const v of xRaw) {
          const x = Math.round(viewport.xToPx(v)) + 0.5;
          ctx.moveTo(x, plotBottom);
          ctx.lineTo(x, plotBottom + tickSize);
        }
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelY = plotBottom + tickSize + tickMargin;
      const xOpts = { font, color, align: "center", baseline: "top", dpr } as const;
      for (let i = 0; i < xRaw.length; i++) {
        drawLabel(ctx, xLabels[i]!, viewport.xToPx(xRaw[i]!), labelY, xOpts);
      }
    }

    // ── Left strip: y ticks + labels ──
    if (left > 0) {
      const { ticks: yRaw, labels: yLabels } = this.yTicksFor();
      if (tickSize > 0 && yRaw.length > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const v of yRaw) {
          const y = Math.round(viewport.yToPx(v)) + 0.5;
          ctx.moveTo(left - tickSize, y);
          ctx.lineTo(left, y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const labelX = left - tickSize - tickMargin;
      const yOpts = { font, color, align: "right", baseline: "middle", dpr } as const;
      for (let i = 0; i < yRaw.length; i++) {
        drawLabel(ctx, yLabels[i]!, labelX, viewport.yToPx(yRaw[i]!), yOpts);
      }
    }
  }

  /**
   * Draw x-axis tick marks and labels onto a dedicated OffscreenCanvas.
   * Must be called after `draw()` so yMode:"auto" bounds are finalized.
   * `canvasW` / `canvasH` are CSS-pixel dimensions (before dpr scaling).
   */
  drawXAxis(
    ctx: OffscreenCanvasRenderingContext2D,
    canvasW: number,
    canvasH: number,
    style: AxisStyle,
    dpr = 1,
  ): void {
    const color = style.color ?? "#666";
    const font = style.font ?? "11px sans-serif";
    const tickSize = style.tickSize ?? 6;
    const tickMargin = style.tickMargin ?? 4;

    ctx.clearRect(0, 0, canvasW, canvasH);

    const { ticks: xRaw, labels: xLabels } = this.xTicksFor();
    const xSpan = this.bounds.xMax - this.bounds.xMin;

    // Ticks and labels come from the shared x-tick cache — no per-frame
    // regeneration or re-formatting. The loops only run when `xRaw` is
    // non-empty, which implies `xSpan > 0`, so the division is always safe.
    if (tickSize > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const v of xRaw) {
        const x = Math.round(((v - this.bounds.xMin) / xSpan) * canvasW) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tickSize);
      }
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelY = tickSize + tickMargin;
    const opts = { font, color, align: "center", baseline: "top", dpr } as const;
    for (let i = 0; i < xRaw.length; i++) {
      const v = xRaw[i]!;
      drawLabel(
        ctx,
        xLabels[i]!,
        ((v - this.bounds.xMin) / xSpan) * canvasW,
        labelY,
        opts,
      );
    }
  }

  /**
   * Draw y-axis tick marks and labels onto a dedicated OffscreenCanvas.
   * Must be called after `draw()` so yMode:"auto" bounds are finalized.
   * `canvasW` / `canvasH` are CSS-pixel dimensions (before dpr scaling).
   */
  drawYAxis(
    ctx: OffscreenCanvasRenderingContext2D,
    canvasW: number,
    canvasH: number,
    style: AxisStyle,
    yPadPx = 0,
    dpr = 1,
  ): void {
    const color = style.color ?? "#666";
    const font = style.font ?? "11px sans-serif";
    const tickSize = style.tickSize ?? 6;
    const tickMargin = style.tickMargin ?? 4;

    ctx.clearRect(0, 0, canvasW, canvasH);

    const yRaw = niceTicks(this.bounds.yMin, this.bounds.yMax, this.targetTicks);
    const ySpan = this.bounds.yMax - this.bounds.yMin;
    const usableH = canvasH - yPadPx * 2;

    /* v8 ignore start -- empty span ⟹ yRaw is [], so this map body never runs */
    const fractions = yRaw.map((v) => (ySpan > 0 ? (v - this.bounds.yMin) / ySpan : 0));
    /* v8 ignore stop */
    const labels = yRaw.map((v) => formatYTick(v, this.yTickFormat));

    if (tickSize > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const frac of fractions) {
        const y = Math.round(yPadPx + (1 - frac) * usableH) + 0.5;
        ctx.moveTo(canvasW - tickSize, y);
        ctx.lineTo(canvasW, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const labelX = canvasW - tickSize - tickMargin;
    const opts = { font, color, align: "right", baseline: "middle", dpr } as const;
    for (let i = 0; i < fractions.length; i++) {
      const y = yPadPx + (1 - fractions[i]!) * usableH;
      drawLabel(ctx, labels[i]!, labelX, y, opts);
    }
  }

  dispose(): void {}
}
