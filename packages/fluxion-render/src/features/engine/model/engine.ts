import { AreaChartLayer } from "../../../entities/area-chart-layer";
import { AxisGridLayer } from "../../../entities/axis-grid-layer";
import { BarChartLayer } from "../../../entities/bar-chart-layer";
import { BoxPlotLayer } from "../../../entities/box-plot-layer";
import { CandlestickLayer } from "../../../entities/candlestick-layer";
import { EventMarkerLayer } from "../../../entities/event-marker-layer";
import { HeatmapLayer } from "../../../entities/heatmap-layer";
import { HeatmapStreamLayer } from "../../../entities/heatmap-stream-layer";
import { HistogramLayer } from "../../../entities/histogram-layer";
import { LayerStack } from "../../../entities/layer-stack";
import { LidarScatterLayer } from "../../../entities/lidar-scatter-layer";
import { LineChartLayer } from "../../../entities/line-chart-layer";
import { LineChartStaticLayer } from "../../../entities/line-chart-static-layer";
import { OccupancyGridLayer } from "../../../entities/occupancy-grid-layer";
import { PolarLayer } from "../../../entities/polar-layer";
import { PoseArrowLayer } from "../../../entities/pose-arrow-layer";
import { ReferenceLineLayer } from "../../../entities/reference-line-layer";
import { ScatterChartLayer } from "../../../entities/scatter-chart-layer";
import { ScatterColoredLayer } from "../../../entities/scatter-colored-layer";
import { StackedAreaLayer } from "../../../entities/stacked-area-layer";
import { StepChartLayer } from "../../../entities/step-chart-layer";
import { TrajectoryLayer } from "../../../entities/trajectory-layer";
import type { Layer } from "../../../shared/model/layer";
import { Scheduler } from "../../../shared/model/scheduler";
import { Viewport } from "../../../shared/model/viewport";
import type {
  AxisStyle,
  HostMsg,
  LayerKind,
  RenderStatsMsg,
  SetAxisCanvasMsg,
  TickUpdateMsg,
} from "../../../shared/protocol";
import { Op, WorkerOp } from "../../../shared/protocol";

function createLayer(id: string, kind: LayerKind): Layer {
  switch (kind) {
    case "line":
      return new LineChartLayer(id);
    case "line-static":
      return new LineChartStaticLayer(id);
    case "lidar":
      return new LidarScatterLayer(id);
    case "axis-grid":
      return new AxisGridLayer(id);
    case "scatter":
      return new ScatterChartLayer(id);
    case "area":
      return new AreaChartLayer(id);
    case "step":
      return new StepChartLayer(id);
    case "bar":
      return new BarChartLayer(id);
    case "candlestick":
      return new CandlestickLayer(id);
    case "heatmap":
      return new HeatmapLayer(id);
    case "event-marker":
      return new EventMarkerLayer(id);
    case "scatter-colored":
      return new ScatterColoredLayer(id);
    case "heatmap-stream":
      return new HeatmapStreamLayer(id);
    case "reference-line":
      return new ReferenceLineLayer(id);
    case "pose-arrow":
      return new PoseArrowLayer(id);
    case "trajectory":
      return new TrajectoryLayer(id);
    case "occupancy-grid":
      return new OccupancyGridLayer(id);
    case "histogram":
      return new HistogramLayer(id);
    case "stacked-area":
      return new StackedAreaLayer(id);
    case "box-plot":
      return new BoxPlotLayer(id);
    case "polar":
      return new PolarLayer(id);
  }
}

/** Type guard hoisted to module scope so render() doesn't allocate it per frame. */
function isAxisGrid(l: Layer): l is AxisGridLayer {
  return l instanceof AxisGridLayer;
}

/**
 * Worker-side engine. Owns the OffscreenCanvas, layer stack, viewport,
 * and render scheduler. All state lives here; main thread just pushes messages.
 */
export class Engine {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private xAxisCanvas: OffscreenCanvas | null = null;
  private xAxisCtx: OffscreenCanvasRenderingContext2D | null = null;
  private xAxisHeight = 30;
  private yAxisCanvas: OffscreenCanvas | null = null;
  private yAxisCtx: OffscreenCanvasRenderingContext2D | null = null;
  private yAxisWidth = 60;
  private axisStyle: AxisStyle = {};
  private readonly viewport = new Viewport();
  private readonly stack = new LayerStack();
  private readonly scheduler: Scheduler;
  // Cached first AxisGridLayer of the stack (insertion order), refreshed on
  // layer add/remove/reset — render() and friends read it every frame and must
  // not re-scan the stack (or allocate a type-guard closure) per frame.
  private axisLayer: AxisGridLayer | null = null;
  private bgColor = "#0b0d12";
  // Page visibility, driven by the host's `visibilitychange`. While false, the
  // follow-clock continuous render loop is suspended (CPU/battery), regardless
  // of whether an axis layer is following the clock.
  private visible = true;
  // Worker→main notifications. Default on; a host with no bounds/tick consumer
  // (e.g. a large thumbnail grid with externalAxes=false) can disable them to
  // skip per-frame postMessage + tick computation.
  private emitBounds = true;
  private emitTicks = true;
  // Opt-in render-load reporting (RENDER_STATS) for perf HUDs. Off → zero cost.
  private emitRenderStats = false;
  private rsRenders = 0;
  private rsBusyMs = 0;
  private rsWindowStart = -1;
  private hostId: string | undefined;
  private lastSentYMin = Number.NaN;
  private lastSentYMax = Number.NaN;
  private lastSentXTickMs = 0;
  // Skip BOUNDS_UPDATE when change is smaller than this fraction of the range.
  // Prevents flooding the main thread for sub-pixel y-range drift.
  private static readonly BOUNDS_EPS = 1e-4;

  constructor() {
    this.scheduler = new Scheduler((dirty) => this.render(dirty));
  }

  dispatch(msg: HostMsg): void {
    switch (msg.op) {
      case Op.INIT:
        this.hostId = msg.hostId;
        this.init(msg.canvas, msg.width, msg.height, msg.dpr, {
          bgColor: msg.bgColor,
          maxFps: msg.maxFps,
          emitBounds: msg.emitBounds,
          emitTicks: msg.emitTicks,
          transparent: msg.transparent,
          emitRenderStats: msg.emitRenderStats,
        });
        break;
      case Op.SET_BG_COLOR:
        this.bgColor = msg.color;
        this.scheduler.markDirty();
        break;
      case Op.RESIZE:
        this.resize(msg.width, msg.height, msg.dpr);
        break;
      case Op.ADD_LAYER: {
        const layer = createLayer(msg.id, msg.kind);
        if (msg.config !== undefined) layer.setConfig(msg.config);
        layer.resize(this.viewport);
        this.stack.add(layer);
        this.refreshAxisLayerRef();
        this.syncContinuousMode();
        this.scheduler.markDirty();
        break;
      }
      case Op.REMOVE_LAYER:
        this.stack.remove(msg.id);
        this.refreshAxisLayerRef();
        this.syncContinuousMode();
        this.scheduler.markDirty();
        break;
      case Op.CONFIG: {
        const layer = this.stack.get(msg.id);
        if (layer) {
          layer.setConfig(msg.config);
          this.syncContinuousMode();
          this.scheduler.markDirty();
        }
        break;
      }
      case Op.CONFIG_BATCH: {
        let applied = false;
        for (const { id, config } of msg.entries) {
          const layer = this.stack.get(id);
          if (layer) {
            layer.setConfig(config);
            applied = true;
          }
        }
        if (applied) {
          this.syncContinuousMode();
          this.scheduler.markDirty();
        }
        break;
      }
      case Op.DATA: {
        const layer = this.stack.get(msg.id);
        if (layer) {
          layer.setData(msg.buffer, msg.length, this.viewport);
          this.scheduler.markDirty();
        }
        break;
      }
      case Op.CLEAR_DATA: {
        const layer = this.stack.get(msg.id);
        layer?.clearData?.();
        // `latestT` is normally monotonic-up (advanced by layer setData).
        // An explicit rewind here is the only path a backward replay seek
        // can use to drag the time-mode axis window with it.
        if (msg.latestT !== undefined) {
          this.viewport.latestT = msg.latestT;
        }
        this.scheduler.markDirty();
        break;
      }
      case Op.DISPOSE:
        this.dispose();
        break;
      case Op.SET_AXIS_CANVAS:
        this.setAxisCanvas(msg as SetAxisCanvasMsg);
        break;
      case Op.SET_AXIS_STYLE: {
        const { color, font, tickSize, tickMargin, bgColor } = msg as {
          color?: string;
          font?: string;
          tickSize?: number;
          tickMargin?: number;
          bgColor?: string;
        };
        if (color !== undefined) this.axisStyle.color = color;
        if (font !== undefined) this.axisStyle.font = font;
        if (tickSize !== undefined) this.axisStyle.tickSize = tickSize;
        if (tickMargin !== undefined) this.axisStyle.tickMargin = tickMargin;
        if (bgColor !== undefined) this.axisStyle.bgColor = bgColor;
        this.scheduler.markDirty();
        break;
      }
      case Op.SET_VISIBLE: {
        this.visible = msg.visible;
        if (msg.visible) {
          // Re-anchor the follow-clock window to the current wall clock so it
          // jumps once to true "now" (elapsed hidden time is real) instead of
          // resuming from a stale anchor.
          this.axisLayer?.resetClockAnchor();
          this.scheduler.markDirty();
        }
        this.syncContinuousMode();
        break;
      }
      case Op.RESET:
        this.reset();
        break;
      case Op.RELEASE_BACKING:
        this.releaseBackings();
        break;
    }
  }

  /**
   * Free the GPU backing stores (main + axis canvases) by shrinking them to
   * 0×0 while KEEPING the canvas/context bindings and all engine state — the
   * worker half of parked-host idle shrink. Unlike `dispose`, the engine stays
   * fully usable: the next RESIZE re-allocates because the width-diff check
   * compares against 0. No `markDirty` — a parked host is invisible, and a
   * render onto a 0×0 canvas would be a wasted no-op anyway.
   */
  private releaseBackings(): void {
    Engine.releaseBacking(this.canvas);
    Engine.releaseBacking(this.xAxisCanvas);
    Engine.releaseBacking(this.yAxisCanvas);
  }

  /**
   * Reset to a pristine, just-constructed state while KEEPING the OffscreenCanvas
   * binding + worker engine alive — the worker side of host recycling. Disposes
   * every layer (empty stack) and rewinds the viewport/bounds/observed-y, the
   * emitted-bounds latches, and engine-level bg/axis style back to defaults.
   * After this, re-running the normal mount sequence (ADD_LAYER…, SET_BG_COLOR,
   * RESIZE, SET_VISIBLE) re-hydrates a recycled host indistinguishably from a
   * cold one. Construction-fixed settings (maxFps/emitBounds/emitTicks, the
   * canvas context, page-visibility) are intentionally preserved — they form
   * the recycle key, so a reused engine already matches the requesting mount.
   */
  /** Re-resolve the cached first AxisGridLayer after any stack mutation. */
  private refreshAxisLayerRef(): void {
    this.axisLayer = this.stack.findFirst(isAxisGrid) ?? null;
  }

  private reset(): void {
    this.stack.disposeAll();
    this.axisLayer = null;
    this.viewport.latestT = 0;
    this.viewport.setBounds({ xMin: -1, xMax: 1, yMin: -1, yMax: 1 });
    this.viewport.yPadPx = 0;
    this.viewport.observedYMin = Number.POSITIVE_INFINITY;
    this.viewport.observedYMax = Number.NEGATIVE_INFINITY;
    this.bgColor = "#0b0d12";
    this.axisStyle = {};
    this.lastSentYMin = Number.NaN;
    this.lastSentYMax = Number.NaN;
    this.lastSentXTickMs = 0;
    this.rsRenders = 0;
    this.rsBusyMs = 0;
    this.rsWindowStart = -1;
    this.syncContinuousMode();
    this.scheduler.markDirty();
  }

  private setAxisCanvas(msg: SetAxisCanvasMsg): void {
    this.xAxisHeight = msg.xAxisHeight;
    this.yAxisWidth = msg.yAxisWidth;
    if (msg.xAxisCanvas) {
      this.xAxisCanvas = msg.xAxisCanvas;
      this.xAxisCtx = msg.xAxisCanvas.getContext("2d");
      // Labels now render on the axis canvas — the grid layer must not also
      // format + draw them in-plot (the double-label footgun).
      this.viewport.externalXAxis = true;
    }
    if (msg.yAxisCanvas) {
      this.yAxisCanvas = msg.yAxisCanvas;
      this.yAxisCtx = msg.yAxisCanvas.getContext("2d");
      this.viewport.externalYAxis = true;
    }
    // Size the axis canvases to match the current viewport.
    this.resizeAxisCanvases(
      this.viewport.widthPx,
      this.viewport.heightPx,
      this.viewport.dpr,
    );
    this.scheduler.markDirty();
  }

  private init(
    canvas: OffscreenCanvas,
    width: number,
    height: number,
    dpr: number,
    opts: {
      bgColor?: string;
      maxFps?: number;
      emitBounds?: boolean;
      emitTicks?: boolean;
      transparent?: boolean;
      emitRenderStats?: boolean;
    },
  ) {
    this.canvas = canvas;
    // Opaque context (alpha:false) composites faster — the engine fills `bgColor`
    // over the whole canvas every frame, so it's opaque regardless. `transparent`
    // opts back into an alpha channel for translucent backgrounds.
    this.ctx = canvas.getContext("2d", { alpha: opts.transparent === true });
    if (opts.bgColor !== undefined) this.bgColor = opts.bgColor;
    if (opts.maxFps !== undefined) this.scheduler.setMaxFps(opts.maxFps);
    if (opts.emitBounds !== undefined) this.emitBounds = opts.emitBounds;
    if (opts.emitTicks !== undefined) this.emitTicks = opts.emitTicks;
    if (opts.emitRenderStats !== undefined) this.emitRenderStats = opts.emitRenderStats;
    this.resize(width, height, dpr);
    this.scheduler.start();
    this.scheduler.markDirty();
  }

  private resize(width: number, height: number, dpr: number) {
    if (!this.canvas) return;
    // Assigning width/height reallocates the GPU backing AND clears the canvas
    // even when the value is unchanged — skip no-op resizes (a ResizeObserver can
    // re-fire with the same size during layout churn).
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.viewport.setSize(width, height, dpr);
    this.stack.resizeAll(this.viewport);
    this.resizeAxisCanvases(width, height, dpr);
    this.scheduler.markDirty();
  }

  private resizeAxisCanvases(width: number, height: number, dpr: number): void {
    if (this.xAxisCanvas) {
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(this.xAxisHeight * dpr));
      if (this.xAxisCanvas.width !== w) this.xAxisCanvas.width = w;
      if (this.xAxisCanvas.height !== h) this.xAxisCanvas.height = h;
    }
    if (this.yAxisCanvas) {
      const w = Math.max(1, Math.round(this.yAxisWidth * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (this.yAxisCanvas.width !== w) this.yAxisCanvas.width = w;
      if (this.yAxisCanvas.height !== h) this.yAxisCanvas.height = h;
    }
  }

  private render(dirty = true) {
    const ctx = this.ctx;
    /* v8 ignore start -- render only runs via the scheduler after init; ctx/canvas are always set */
    if (!ctx || !this.canvas) return;
    /* v8 ignore stop */
    const rsStart = this.emitRenderStats ? performance.now() : 0;
    // 2-pass: scan (orchestration: time window, observed y, bounds) then
    // draw. AxisGridLayer.scan writes bounds; LineChartLayer.scan reads
    // bounds and publishes observed y extents; AxisGridLayer.draw finishes
    // the y-auto computation using those extents.
    this.viewport.beginScan();
    this.stack.scanAll(this.viewport);
    const { dpr } = this.viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, this.viewport.widthPx, this.viewport.heightPx);
    this.stack.drawAll(ctx, this.viewport);

    // Notify main thread when effective y bounds change (yMode:"auto").
    // Uses an epsilon gate so sub-pixel drift doesn't flood the main thread.
    const { yMin, yMax } = this.viewport.bounds;
    const range = yMax - yMin || 1;
    const eps = range * Engine.BOUNDS_EPS;
    // `lastSentYMin/Max` start as NaN; `Math.abs(y - NaN) > eps` is always false,
    // which would suppress the very first BOUNDS_UPDATE forever. Treat an unset
    // (NaN) baseline as "changed" so the initial bounds are reported.
    const boundsChanged =
      Number.isNaN(this.lastSentYMin) ||
      Math.abs(yMin - this.lastSentYMin) > eps ||
      Math.abs(yMax - this.lastSentYMax) > eps;
    if (boundsChanged) {
      // Latch the baseline even when emission is off, so `boundsChanged` (used
      // below to gate the y-axis redraw) stays correct frame to frame.
      this.lastSentYMin = yMin;
      this.lastSentYMax = yMax;
      if (this.emitBounds) {
        try {
          self.postMessage({
            op: WorkerOp.BOUNDS_UPDATE,
            hostId: this.hostId,
            yMin,
            yMax,
            latestT: this.viewport.latestT,
          });
        } catch {
          // Worker context may not support postMessage in tests
        }
      }
    }

    // Draw axis canvases synchronously in the same rAF cycle (zero lag).
    const axisLayer = this.axisLayer;
    if (axisLayer) {
      if (this.xAxisCtx && this.xAxisCanvas) {
        this.xAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        axisLayer.drawXAxis(
          this.xAxisCtx,
          this.xAxisCanvas.width / dpr,
          this.xAxisHeight,
          this.axisStyle,
        );
      }
      // The y-axis only changes when y bounds shift or a one-shot redraw was
      // requested (resize/config/style). On a pure follow-clock continuous
      // frame, only the x-axis scrolls — skip the y-axis fill+text entirely.
      if (this.yAxisCtx && this.yAxisCanvas && (dirty || boundsChanged)) {
        this.yAxisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        axisLayer.drawYAxis(
          this.yAxisCtx,
          this.yAxisWidth,
          this.yAxisCanvas.height / dpr,
          this.axisStyle,
          this.viewport.yPadPx,
        );
      }
    }

    // Only send TICK_UPDATE when axis canvases are not present (React-side
    // fallback) and a consumer wants them.
    if (this.emitTicks && !this.xAxisCanvas && !this.yAxisCanvas) {
      this.maybeSendTickUpdate(boundsChanged);
    }

    if (this.emitRenderStats) this.recordRenderStats(rsStart);
  }

  /**
   * Accumulate this frame's render time and, once a ~1s wall-clock window has
   * elapsed, post a RENDER_STATS snapshot. Opt-in (emitRenderStats); lets a perf
   * HUD tell main-thread mount spikes from worker-thread render saturation.
   */
  private recordRenderStats(startMs: number): void {
    const now = performance.now();
    this.rsBusyMs += now - startMs;
    this.rsRenders++;
    if (this.rsWindowStart < 0) this.rsWindowStart = startMs;
    const windowMs = now - this.rsWindowStart;
    if (windowMs >= 1000) {
      try {
        self.postMessage({
          op: WorkerOp.RENDER_STATS,
          hostId: this.hostId,
          renders: this.rsRenders,
          busyMs: this.rsBusyMs,
          windowMs,
        } satisfies RenderStatsMsg);
      } catch {
        // Worker context may not support postMessage in tests
      }
      this.rsRenders = 0;
      this.rsBusyMs = 0;
      this.rsWindowStart = now;
    }
  }

  private maybeSendTickUpdate(boundsChanged: boolean): void {
    const axisLayer = this.axisLayer;
    if (!axisLayer) return;

    const now = Date.now();
    const xInterval = axisLayer.getXTickIntervalMs() ?? 1000;
    const xChanged = now - this.lastSentXTickMs >= xInterval;

    if (!xChanged && !boundsChanged) return;

    if (xChanged) this.lastSentXTickMs = now;

    const ticks = axisLayer.computeTicksForExport();
    try {
      self.postMessage({
        op: WorkerOp.TICK_UPDATE,
        hostId: this.hostId,
        xTicks: ticks.xTicks,
        yTicks: ticks.yTicks,
        xRawValues: ticks.xRawValues,
      } satisfies TickUpdateMsg);
    } catch {
      // Worker context may not support postMessage in tests
    }
  }

  /**
   * Push a pre-parsed Float32Array directly into a layer's ring buffer.
   * Called from a custom worker streamHandler — bypasses HostMsg serialization.
   * Data layout must match what the layer expects (e.g. [t, y, t, y, …] for line).
   */
  /**
   * Enable continuous rendering when the stack's axis layer is following the
   * wall clock (time-mode + followClock + timeOrigin); disable it otherwise so
   * static/data-driven charts keep their zero-idle-cost dirty-gated loop.
   * Called after any op that can change layer presence or config.
   */
  private syncContinuousMode(): void {
    const follow = this.axisLayer?.isFollowingClock() ?? false;
    // Suspend the continuous loop while the page is hidden — no point scrolling
    // an axis nobody can see, and it saves CPU/battery.
    this.scheduler.setContinuous(this.visible && follow);
  }

  pushRaw(layerId: string, data: Float32Array): void {
    const layer = this.stack.get(layerId);
    if (!layer) return;
    layer.setData(data.buffer as ArrayBuffer, data.length, this.viewport);
    this.scheduler.markDirty();
  }

  private dispose() {
    this.scheduler.stop();
    this.stack.disposeAll();
    this.axisLayer = null;
    // Release each OffscreenCanvas's GPU backing store NOW instead of waiting for
    // GC. A `transferControlToOffscreen()` canvas keeps its GPU surface alive
    // until the OffscreenCanvas is garbage-collected; under rapid mount/unmount
    // churn (e.g. a pool host per chart in a large accordion) those surfaces pile
    // up and exhaust GPU memory, eventually losing the context and freezing every
    // chart. Resizing to 0×0 frees the backing synchronously — and the linked
    // main-thread placeholder <canvas> shrinks with it — so churn can't accumulate.
    Engine.releaseBacking(this.canvas);
    Engine.releaseBacking(this.xAxisCanvas);
    Engine.releaseBacking(this.yAxisCanvas);
    this.canvas = null;
    this.ctx = null;
    this.xAxisCanvas = null;
    this.xAxisCtx = null;
    this.yAxisCanvas = null;
    this.yAxisCtx = null;
  }

  /** Free an OffscreenCanvas's GPU backing immediately by shrinking it to 0×0. */
  private static releaseBacking(canvas: OffscreenCanvas | null): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }
}
