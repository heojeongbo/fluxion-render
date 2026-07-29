import type { AxisGridConfig } from "../../../entities/axis-grid-layer";
import type { LidarScatterConfig } from "../../../entities/lidar-scatter-layer";
import type { LineChartConfig } from "../../../entities/line-chart-layer";
import type { LineChartStaticConfig } from "../../../entities/line-chart-static-layer";
import type { FluxionWorkerPool } from "../../../features/worker-pool";
import { getDefaultPool } from "../../../features/worker-pool";
import { warnArityMismatch } from "../../../shared/lib/arity-guard";
import { Emitter } from "../../../shared/lib/emitter";
import { cancelHostFlush, requestHostFlush } from "../../../shared/lib/flush-scheduler";
import {
  type AxisStyle,
  type BoundsUpdateMsg,
  type DType,
  type FluxionPoolStreamMsg,
  type HostMsg,
  type LayerKind,
  Op,
  type RenderStatsMsg,
  type SerializedTick,
  type TickUpdateMsg,
  type WorkerMsg,
  WorkerOp,
} from "../../../shared/protocol";
import {
  AreaLayerHandle,
  BarLayerHandle,
  BoxPlotHandle,
  CandlestickLayerHandle,
  EventMarkerHandle,
  HeatmapLayerHandle,
  HeatmapStreamHandle,
  HistogramHandle,
  LidarLayerHandle,
  type LidarStride,
  LineLayerHandle,
  LineStaticLayerHandle,
  OccupancyGridHandle,
  PolarHandle,
  PoseArrowHandle,
  ReferenceLineHandle,
  ScatterColoredHandle,
  ScatterLayerHandle,
  StackedAreaHandle,
  StepLayerHandle,
  TrajectoryHandle,
} from "./layer-handles";
import { MetricsTracker } from "./metrics-tracker";

/**
 * TypedArray flavors that FluxionRender accepts. `ArrayBufferView` is too
 * permissive (includes DataView), so we narrow to the specific types whose
 * layout matches the worker-side `wrapTypedArray` contract.
 */
export type FluxionTypedArray =
  | Float32Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array;

export interface FluxionHostOptions {
  /**
   * Override the worker URL. Useful when bundlers don't support
   * `new Worker(new URL('./fluxion-worker.js', import.meta.url))`.
   * Pass a factory that returns a constructed Worker.
   * When provided, bypasses the default worker pool and runs in solo mode.
   */
  workerFactory?: () => Worker;
  /**
   * Canvas background color, applied every frame before layers draw.
   * Defaults to `"#0b0d12"` (dark) when omitted. Use `setBgColor` to change
   * it at runtime (e.g. for a theme toggle).
   */
  bgColor?: string;
  /**
   * Worker pool to use. When omitted, the module-level default pool is used
   * automatically (4 workers shared across all hosts).
   * Use `configureDefaultPool` to change the default pool size.
   */
  pool?: FluxionWorkerPool;
  /**
   * x-axis HTML canvas element. When provided, the Worker renders tick marks
   * and labels directly onto it in the same rAF cycle as the main canvas —
   * eliminating the Main-thread React tick-update lag.
   */
  xAxisElement?: HTMLCanvasElement;
  /**
   * y-axis HTML canvas element. Rendered by the Worker in the same rAF cycle.
   */
  yAxisElement?: HTMLCanvasElement;
  /** Height of the x-axis canvas in CSS px. Default 30. */
  xAxisHeight?: number;
  /** Width of the y-axis canvas in CSS px. Default 60. */
  yAxisWidth?: number;
  /** Axis tick/label style. Defaults: color "#666", font "11px sans-serif", tickSize 6, tickMargin 4. */
  axisStyle?: AxisStyle;
  /**
   * Coalesce high-frequency per-sample pushes (the typed handles' `push()`)
   * into ONE `Op.DATA` message per layer per animation frame, instead of one
   * postMessage per sample. Cuts postMessage volume from O(samples/sec) to
   * O(layers × fps) and removes the per-sample `Float32Array(2)` allocation —
   * essential for many high-rate (e.g. 500 Hz) streams. Adds up to one frame
   * (~16 ms) of latency to streamed data.
   *
   * Only the streaming handles' `push()` fast-path is coalesced; raw
   * `pushData`, `pushBatch`, and the replace-style `set*` calls always post
   * immediately (and flush any pending staged data for that layer first, so
   * ordering is preserved). Default `true`; set `false` to restore immediate
   * per-sample posting.
   */
  coalesce?: boolean;
  /**
   * Backpressure cap on staged Float32 elements per layer between flushes.
   * On overflow the layer's staging is flushed immediately (synchronous post)
   * rather than dropping samples. Default 1_000_000 (≈4 MB per layer).
   */
  coalesceMaxFloats?: number;
  /**
   * Cap the worker engine's render rate to this many fps. Omitted = uncapped
   * (redraw on every dirty/continuous animation frame). For a large grid of
   * streaming charts on a shared worker, capping to e.g. 30 roughly halves
   * worker scan+draw CPU and is visually indistinguishable for a scrolling
   * time window. Skipped frames keep pending data — nothing is dropped.
   */
  maxFps?: number;
  /**
   * Whether the worker posts `BOUNDS_UPDATE` to the main thread when the
   * auto-scaled y-bounds change. Default `true`. Set `false` when nothing
   * consumes {@link onBoundsChange} / `getMetrics().bounds` (e.g. a thumbnail
   * grid) to skip the per-frame postMessage.
   */
  emitBounds?: boolean;
  /**
   * Whether the worker posts `TICK_UPDATE` to the main thread for React-side
   * axis rendering. Default `true`. Only relevant with `externalAxes={false}`
   * and no {@link onTickUpdate} consumer — set `false` to skip the per-frame
   * tick computation + postMessage. No effect when axis canvases render in the
   * worker (`externalAxes` / `xAxisElement` / `yAxisElement`).
   */
  emitTicks?: boolean;
  /**
   * Keep the canvas's alpha channel so the page shows through where the chart
   * doesn't paint. Default `false` (opaque): the engine fills `bgColor` every
   * frame, so an opaque 2D context (`alpha: false`) composites faster — a real
   * win for a wall of many charts. Set `true` only if you use a translucent
   * `bgColor` and want the page visible behind the plot.
   */
  transparent?: boolean;
  /**
   * Periodically report worker-side render load (frames + CPU ms) via
   * {@link FluxionHost.onRenderStats}. Opt-in for perf HUDs — off by default so
   * there's zero per-frame timing overhead. Aggregating `busyMs/windowMs` across
   * all hosts on a worker estimates that worker thread's render utilization,
   * which distinguishes a main-thread mount spike from worker-thread saturation.
   */
  emitRenderStats?: boolean;
}

function dtypeOf(arr: FluxionTypedArray): DType {
  if (arr instanceof Float32Array) return "f32";
  if (arr instanceof Uint8Array) return "u8";
  if (arr instanceof Int16Array) return "i16";
  if (arr instanceof Uint16Array) return "u16";
  if (arr instanceof Int32Array) return "i32";
  throw new Error(
    `fluxion-render: unsupported TypedArray "${
      /* v8 ignore next -- TypedArrays always have a constructor.name; typeof fallback is defensive */
      (arr as { constructor?: { name?: string } })?.constructor?.name ?? typeof arr
    }". Supported: Float32Array, Uint8Array, Int16Array, Uint16Array, Int32Array.`,
  );
}

/**
 * Main-thread handle to a worker-hosted rendering engine.
 *
 * Lifecycle:
 *   const host = new FluxionHost(canvas);
 *   host.addLayer('chart', 'line', { color: '#0ff' });
 *   host.pushData('chart', float32);   // transfers ownership
 *   host.resize(w, h, dpr);
 *   host.dispose();
 */
/** Callback shape for `onBoundsChange`. */
export type BoundsChangeListener = (yMin: number, yMax: number, latestT: number) => void;

/** Snapshot of main-thread-observable host activity, returned by `getMetrics`. */
export interface FluxionMetrics {
  /** Total `pushData` calls across all layers since mount. */
  pushCount: number;
  /** Total samples pushed (sum of `length` across pushes). */
  sampleCount: number;
  /** Total bytes transferred to the worker (sum of pushed buffer byteLengths). */
  bytesTransferred: number;
  /** Per-layer push counts, keyed by layer id. */
  pushesByLayer: Record<string, number>;
  /** `performance.now()` of the most recent push, or null if none yet. */
  lastPushAt: number | null;
  /** Latest y-bounds + latestT seen from the worker's BOUNDS_UPDATE, or null. */
  bounds: { yMin: number; yMax: number; latestT: number } | null;
}

/** Callback shape for `onTickUpdate`. Receives serialized tick arrays from the worker. */
export type TickUpdateListener = (
  xTicks: SerializedTick[],
  yTicks: SerializedTick[],
) => void;

/** Worker-side render-load snapshot delivered to `onRenderStats`. */
export interface RenderStats {
  /** Frames rendered during the window. */
  renders: number;
  /** Wall-clock ms the worker spent inside render() during the window. */
  busyMs: number;
  /** Window length in ms. `busyMs / windowMs` ≈ this engine's render duty cycle. */
  windowMs: number;
}

/** Callback shape for `onRenderStats`. Receives a periodic render-load snapshot. */
export type RenderStatsListener = (stats: RenderStats) => void;

/** Callback shape for `onMetricsUpdate`. Receives a fresh metrics snapshot. */
export type MetricsListener = (metrics: FluxionMetrics) => void;

/**
 * Functions can't structuredClone (postMessage throws DataCloneError). Layer
 * configs may carry main-thread-only formatter functions (`xTickFormat` /
 * `yTickFormat`) — drop them here; React-side hooks (`useAxisTicks`) apply
 * them after TICK_UPDATE. Shallow by design: every layer config is flat.
 * Object-form formatters (`{ pattern, precision, ... }`) are NOT functions, so
 * they pass through untouched and reach the worker's draw path intact.
 */
function stripFunctionFields(config: unknown): unknown {
  if (config == null || typeof config !== "object" || Array.isArray(config))
    return config;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (typeof v === "function") {
      changed = true;
      continue;
    }
    out[k] = v;
  }
  return changed ? out : config;
}

export class FluxionHost {
  private worker: {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    addEventListener?(type: string, listener: EventListener): void;
    removeEventListener?(type: string, listener: EventListener): void;
    readonly hostId?: string;
  };
  private disposed = false;
  private readonly boundsEmitter = new Emitter<
    [yMin: number, yMax: number, latestT: number]
  >();
  private readonly tickEmitter = new Emitter<
    [xTicks: SerializedTick[], yTicks: SerializedTick[]]
  >();
  private readonly renderStatsEmitter = new Emitter<[stats: RenderStats]>();
  // Diagnostics — see getMetrics().
  private readonly metrics = new MetricsTracker();
  private workerMsgHandler: EventListener | null = null;
  private visibilityHandler: (() => void) | null = null;

  // ── Push coalescing (see FluxionHostOptions.coalesce) ───────────────────
  private readonly coalesce: boolean;
  private readonly coalesceMaxFloats: number;
  // Per-layer staging: flat number[] of interleaved samples awaiting flush.
  // Stride-agnostic — the worker's RingBuffer re-segments by its own stride,
  // so concatenating same-layer chunks is byte-equivalent to N separate pushes.
  private readonly pending = new Map<string, { chunks: number[]; floats: number }>();
  // Per-layer declared arity (stacked-area seriesCount / heatmap-stream yBins /
  // lidar stride), recorded from add/config so handles can warn on a mismatched
  // push. See `expectedArity` + `arity-guard`.
  private readonly layerArity = new Map<string, number>();
  // Cheap per-host guard so a high-rate stage() loop doesn't touch the shared
  // flush scheduler's Map on every sample. The actual frame scheduling is
  // shared across all hosts — see `shared/lib/flush-scheduler`.
  private flushScheduled = false;

  constructor(canvas: HTMLCanvasElement, opts: FluxionHostOptions = {}) {
    this.coalesce = opts.coalesce ?? true;
    this.coalesceMaxFloats = opts.coalesceMaxFloats ?? 1_000_000;
    if (opts.workerFactory) {
      // Solo mode: caller provided a custom factory — bypass the pool entirely.
      this.worker = opts.workerFactory();
    } else {
      // Pool mode: use the explicit pool or fall back to the module-level default.
      /* v8 ignore start -- default-pool fallback needs a real worker URL, unavailable in unit tests */
      this.worker = (opts.pool ?? getDefaultPool()).acquire();
      /* v8 ignore stop */
    }

    const offscreen = canvas.transferControlToOffscreen();
    /* v8 ignore start -- devicePixelRatio is always defined in the DOM test env; SSR fallback */
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    /* v8 ignore stop */
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.width || 300;
    const height = rect.height || canvas.height || 150;

    this.post(
      {
        op: Op.INIT,
        canvas: offscreen,
        width,
        height,
        dpr,
        bgColor: opts.bgColor,
        maxFps: opts.maxFps,
        emitBounds: opts.emitBounds,
        emitTicks: opts.emitTicks,
        transparent: opts.transparent,
        emitRenderStats: opts.emitRenderStats,
      },
      [offscreen],
    );

    // Transfer axis canvases to the Worker so they render in the same rAF cycle.
    if (opts.xAxisElement || opts.yAxisElement) {
      const xAxisCanvas = opts.xAxisElement?.transferControlToOffscreen();
      const yAxisCanvas = opts.yAxisElement?.transferControlToOffscreen();
      const transfer: Transferable[] = [];
      if (xAxisCanvas) transfer.push(xAxisCanvas);
      if (yAxisCanvas) transfer.push(yAxisCanvas);
      this.post(
        {
          op: Op.SET_AXIS_CANVAS,
          xAxisCanvas,
          yAxisCanvas,
          xAxisHeight: opts.xAxisHeight ?? 30,
          yAxisWidth: opts.yAxisWidth ?? 60,
        },
        transfer,
      );
    }
    if (opts.axisStyle) {
      this.post({ op: Op.SET_AXIS_STYLE, ...opts.axisStyle });
    }

    // Listen for worker→main messages (bounds updates, etc.)
    this.workerMsgHandler = (evt: Event) => {
      const e = evt as MessageEvent<WorkerMsg>;
      const msg = e.data;
      if (!msg || typeof msg !== "object" || !("op" in msg)) return;
      if (msg.op === WorkerOp.BOUNDS_UPDATE) {
        const bu = msg as BoundsUpdateMsg;
        this.metrics.recordBounds(bu.yMin, bu.yMax, bu.latestT);
        this.boundsEmitter.emit(bu.yMin, bu.yMax, bu.latestT);
      }
      if (msg.op === WorkerOp.TICK_UPDATE) {
        const tu = msg as TickUpdateMsg;
        this.tickEmitter.emit(tu.xTicks, tu.yTicks);
      }
      if (msg.op === WorkerOp.RENDER_STATS) {
        const rs = msg as RenderStatsMsg;
        this.renderStatsEmitter.emit({
          renders: rs.renders,
          busyMs: rs.busyMs,
          windowMs: rs.windowMs,
        });
      }
    };
    if (this.worker.addEventListener) {
      this.worker.addEventListener("message", this.workerMsgHandler);
    }

    // Forward page visibility to the worker (it has no `document`). While
    // hidden, the worker suspends the follow-clock continuous render loop;
    // on becoming visible it re-anchors the window to the current wall clock.
    /* v8 ignore next -- the no-document (SSR) arm is unreachable in the DOM test env */
    if (typeof document !== "undefined") {
      this.visibilityHandler = () => {
        this.setVisible(document.visibilityState === "visible");
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  /**
   * Tell the worker engine whether this host is currently visible. While hidden,
   * the engine suspends its follow-clock continuous render loop (saving CPU), and
   * a host recycle pool uses this to PAUSE a warm host so it burns nothing while
   * parked. On becoming visible the engine re-anchors the follow-clock window to
   * the current wall clock. Normally driven automatically by `document`'s
   * `visibilitychange`; exposed so a recycle pool can pause/resume explicitly.
   */
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    // While hidden, rAF stops firing on the worker's follow-clock loop, so any
    // staged samples would sit in the pending buffer until the host is visible
    // again. Drain them now (parity with the visibilitychange handler).
    if (!visible) this.flushAll();
    this.post({ op: Op.SET_VISIBLE, visible });
  }

  /**
   * Reset the host to a pristine, just-constructed state WITHOUT tearing down the
   * worker engine or its OffscreenCanvas binding — the basis of host recycling
   * (see `createHostRecyclePool`). Drops every layer worker-side (RESET), discards
   * staged samples and main-thread listener/metric state from the previous tenant,
   * and rewinds the worker viewport/bounds. After `reset()` the host behaves like
   * a fresh one, so the normal mount sequence (`addLayer` per spec, `setBgColor`,
   * `resize`, `setVisible`) re-hydrates it for the next consumer.
   */
  reset(): void {
    if (this.disposed) return;
    // Drop staged samples WITHOUT posting them — the worker is about to dispose
    // every layer on RESET, so flushing would send Op.DATA to layers that
    // immediately vanish. Cancel any scheduled flush too.
    this.cancelScheduledFlush();
    this.pending.clear();
    // Drop previous-tenant main-thread state so a recycled host starts clean;
    // the next consumer re-records arity on addLayer and re-subscribes its
    // bounds/tick/metrics listeners after acquire.
    this.layerArity.clear();
    this.boundsEmitter.clear();
    this.tickEmitter.clear();
    this.renderStatsEmitter.clear();
    this.metrics.reset();
    this.post({ op: Op.RESET });
  }

  /**
   * Free the worker-side OffscreenCanvas GPU backings (main + axis) by
   * shrinking them to 0×0, without tearing anything else down. Used by the
   * recycle pool's `idleShrinkMs` so long-parked hosts stop holding full-size
   * GPU surfaces; the host stays fully usable and the next `resize()`
   * re-allocates the backings. No-op after `dispose()`.
   */
  releaseBackings(): void {
    if (this.disposed) return;
    this.post({ op: Op.RELEASE_BACKING });
  }

  /**
   * Update the canvas background color at runtime. Takes effect on the next
   * rendered frame. Useful for theme toggles without tearing down the host.
   */
  setBgColor(color: string): void {
    this.post({ op: Op.SET_BG_COLOR, color });
  }

  /**
   * Update the external axis-canvas style (color / font / tick sizing) at
   * runtime — the counterpart to {@link setBgColor} for the axis strips. Only
   * the provided fields change; omitted ones keep their current value. Takes
   * effect on the next rendered frame, so a light/dark toggle can re-theme the
   * axes without a `key` remount. No-op after `dispose()`.
   *
   * Only affects the worker-rendered axis canvases (`externalAxes`); the
   * in-canvas grid/axis/label colors live in the `axis-grid` layer's config and
   * re-theme through the normal layer reconcile instead.
   */
  setAxisStyle(style: Partial<AxisStyle>): void {
    this.post({ op: Op.SET_AXIS_STYLE, ...style });
  }

  /**
   * Register a listener that fires whenever the worker reports new effective
   * y bounds (typically once per frame when `yMode: "auto"` causes a change).
   * Returns an unsubscribe function.
   */
  onBoundsChange(listener: BoundsChangeListener): () => void {
    return this.boundsEmitter.subscribe(listener);
  }

  /**
   * Register a listener that fires whenever the worker sends updated tick data.
   * Replaces the main-thread setInterval in `useAxisTicks` — tick computation
   * now runs in the worker and is pushed here after each rendered frame.
   * Returns an unsubscribe function.
   */
  onTickUpdate(listener: TickUpdateListener): () => void {
    return this.tickEmitter.subscribe(listener);
  }

  /**
   * Subscribe to periodic worker render-load snapshots (frames + CPU ms per
   * ~1s window). Requires `emitRenderStats: true` in the host options — without
   * it the worker never reports and this never fires. Returns an unsubscribe.
   * Aggregating `busyMs` across all hosts on a worker estimates that worker
   * thread's render utilization (vs a main-thread mount spike).
   */
  onRenderStats(listener: RenderStatsListener): () => void {
    return this.renderStatsEmitter.subscribe(listener);
  }

  /**
   * Typed `addLayer` overloads.
   *
   * Prefer the kind-specific helpers below (`addLineLayer`, `addAxisLayer`,
   * etc.) — they both type-check the config AND return a typed handle where
   * applicable. This overload is retained for cases where the kind is chosen
   * dynamically.
   */
  addLayer(id: string, kind: "line", config?: LineChartConfig): void;
  addLayer(id: string, kind: "line-static", config?: LineChartStaticConfig): void;
  addLayer(id: string, kind: "lidar", config?: LidarScatterConfig): void;
  addLayer(id: string, kind: "axis-grid", config?: AxisGridConfig): void;
  // Dynamic fallback for code paths that pass a runtime `LayerKind` (e.g.
  // `useFluxionCanvas({ layers: FluxionLayerSpec[] })`).
  addLayer(id: string, kind: LayerKind, config?: unknown): void;
  addLayer(id: string, kind: LayerKind, config?: unknown): void {
    // Defensive: drain any staged data for a recycled id before re-adding.
    this.flushLayer(id);
    this.trackArity(id, config);
    this.post({ op: Op.ADD_LAYER, id, kind, config: stripFunctionFields(config) });
  }

  removeLayer(id: string): void {
    this.flushLayer(id);
    this.layerArity.delete(id);
    this.post({ op: Op.REMOVE_LAYER, id });
  }

  /**
   * Record a layer's declared arity from its config so layer handles can warn
   * on a mismatched push. The three field names (stacked-area `seriesCount`,
   * heatmap-stream `yBins`, lidar `stride`) are unique across layer kinds, so we
   * needn't know the kind here — other configs simply carry none of them.
   */
  private trackArity(id: string, config?: unknown): void {
    const c = config as
      | { seriesCount?: number; yBins?: number; stride?: number }
      | undefined;
    const arity = c?.seriesCount ?? c?.yBins ?? c?.stride;
    if (typeof arity === "number") this.layerArity.set(id, arity);
  }

  /**
   * Declared arity of a layer, for handle-side push validation.
   * @internal — plumbing for the typed layer handles; not a stable public API.
   */
  expectedArity(id: string): number | undefined {
    return this.layerArity.get(id);
  }

  /**
   * Typed `configLayer` overloads — pick the config shape from the kind used
   * when the layer was created. There's no runtime tag check; the caller is
   * trusted to pass the right config for the right id.
   */
  configLayer(id: string, config: LineChartConfig): void;
  configLayer(id: string, config: LineChartStaticConfig): void;
  configLayer(id: string, config: LidarScatterConfig): void;
  configLayer(id: string, config: AxisGridConfig): void;
  // Dynamic fallback for helpers like `useLayerConfig` that carry an opaque
  // config alongside the layer id.
  configLayer(id: string, config: unknown): void;
  configLayer(id: string, config: unknown): void {
    // A config change (e.g. capacity → new ring) must not land before queued
    // samples for this layer.
    this.flushLayer(id);
    this.trackArity(id, config);
    this.post({ op: Op.CONFIG, id, config: stripFunctionFields(config) });
  }

  /**
   * Batch several layer-config updates into a single postMessage. Equivalent to
   * calling `configLayer` once per entry, but the worker applies them all and
   * recomputes/redraws once — much cheaper than N separate messages when
   * toggling many series at once (e.g. a grid of charts). Empty arrays no-op.
   */
  configLayers(entries: Array<{ id: string; config: unknown }>): void {
    if (entries.length === 0) return;
    for (const e of entries) {
      this.flushLayer(e.id);
      this.trackArity(e.id, e.config);
    }
    this.post({
      op: Op.CONFIG_BATCH,
      entries: entries.map((e) => ({
        id: e.id,
        config: stripFunctionFields(e.config),
      })),
    });
  }

  /**
   * Convenience for toggling layer visibility. Pass `(id, visible)` for one
   * layer, or a `{ [id]: visible }` map for many. Map form sends a single
   * batched message via {@link configLayers}.
   */
  setLayerVisibility(id: string, visible: boolean): void;
  setLayerVisibility(visibility: Record<string, boolean>): void;
  setLayerVisibility(idOrMap: string | Record<string, boolean>, visible?: boolean): void {
    const entries =
      typeof idOrMap === "string"
        ? [{ id: idOrMap, config: { visible: !!visible } }]
        : Object.entries(idOrMap).map(([id, v]) => ({
            id,
            config: { visible: v },
          }));
    this.configLayers(entries);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Typed add-layer helpers: construct + return a typed handle in one call.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Add a streaming line layer and return a handle that accepts structured
   * `{ t, y }` samples instead of raw Float32Array interleaved layout.
   */
  addLineLayer(id: string, config?: LineChartConfig): LineLayerHandle {
    this.addLayer(id, "line", config);
    return new LineLayerHandle(this, id);
  }

  /**
   * Add a static xy line layer and return a handle that accepts
   * `{ x, y }[]` or plain y-only arrays.
   */
  addLineStaticLayer(id: string, config?: LineChartStaticConfig): LineStaticLayerHandle {
    this.addLayer(id, "line-static", config);
    return new LineStaticLayerHandle(this, id);
  }

  /**
   * Add a LiDAR scatter layer and return a handle that accepts
   * `{ x, y, z?, intensity? }[]`. The handle's stride must match
   * `config.stride` (default 4).
   */
  addLidarLayer(id: string, config?: LidarScatterConfig): LidarLayerHandle {
    this.addLayer(id, "lidar", config);
    const stride = (config?.stride as LidarStride | undefined) ?? 4;
    return new LidarLayerHandle(this, id, stride);
  }

  /**
   * Add an axis/grid layer. Axis layers don't take data, so this returns
   * void — use `configLayer` to retune bounds / time window later.
   */
  addAxisLayer(id: string, config?: AxisGridConfig): void {
    this.addLayer(id, "axis-grid", config);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Attach a typed handle to a layer that was added via another API path
  // (e.g. declaratively through `<FluxionCanvas layers={...}>` or
  // `useFluxionCanvas({ layers: [...] })`).
  // ──────────────────────────────────────────────────────────────────────

  line(id: string): LineLayerHandle {
    return new LineLayerHandle(this, id);
  }

  lineStatic(id: string): LineStaticLayerHandle {
    return new LineStaticLayerHandle(this, id);
  }

  /**
   * Attach a handle to an existing lidar layer. `stride` is resolved from the
   * layer's `config.stride` automatically — omit it for the common case. Pass it
   * only to override (a mismatch with the recorded config is warned). Falls back
   * to 4 (x,y,z,intensity) when the layer wasn't added through this host.
   */
  lidar(id: string, stride?: LidarStride): LidarLayerHandle {
    const recorded = this.layerArity.get(id) as LidarStride | undefined;
    if (stride !== undefined && recorded !== undefined && stride !== recorded) {
      warnArityMismatch(id, recorded, stride, "lidar handle stride");
    }
    return new LidarLayerHandle(this, id, stride ?? recorded ?? 4);
  }

  scatter(id: string): ScatterLayerHandle {
    return new ScatterLayerHandle(this, id);
  }

  area(id: string): AreaLayerHandle {
    return new AreaLayerHandle(this, id);
  }

  step(id: string): StepLayerHandle {
    return new StepLayerHandle(this, id);
  }

  bar(id: string): BarLayerHandle {
    return new BarLayerHandle(this, id);
  }

  candlestick(id: string): CandlestickLayerHandle {
    return new CandlestickLayerHandle(this, id);
  }

  heatmap(id: string): HeatmapLayerHandle {
    return new HeatmapLayerHandle(this, id);
  }

  eventMarker(id: string): EventMarkerHandle {
    return new EventMarkerHandle(this, id);
  }

  scatterColored(id: string): ScatterColoredHandle {
    return new ScatterColoredHandle(this, id);
  }

  heatmapStream(id: string): HeatmapStreamHandle {
    return new HeatmapStreamHandle(this, id);
  }

  referenceLine(id: string): ReferenceLineHandle {
    return new ReferenceLineHandle(this, id);
  }

  poseArrow(id: string): PoseArrowHandle {
    return new PoseArrowHandle(this, id);
  }

  trajectory(id: string): TrajectoryHandle {
    return new TrajectoryHandle(this, id);
  }

  occupancyGrid(id: string): OccupancyGridHandle {
    return new OccupancyGridHandle(this, id);
  }

  histogram(id: string): HistogramHandle {
    return new HistogramHandle(this, id);
  }

  stackedArea(id: string): StackedAreaHandle {
    return new StackedAreaHandle(this, id);
  }

  boxPlot(id: string): BoxPlotHandle {
    return new BoxPlotHandle(this, id);
  }

  polar(id: string): PolarHandle {
    return new PolarHandle(this, id);
  }

  /**
   * Push TypedArray data to a layer. Transfers the underlying ArrayBuffer —
   * the caller MUST NOT use `data` again afterwards.
   *
   * The TypedArray must start at byteOffset 0 because the worker reconstructs
   * the view at offset 0. Subviews would silently read from the wrong offset,
   * so they're rejected up-front. Use `data.slice()` to get a fresh buffer.
   */
  pushData(id: string, data: FluxionTypedArray): void {
    if (data.byteOffset !== 0) {
      throw new Error(
        `fluxion-render: TypedArray must start at byteOffset 0 (got ${data.byteOffset}). ` +
          `Call .slice() to copy into a fresh buffer before pushing.`,
      );
    }
    // Order: drain any coalesced single-sample pushes staged for this layer
    // (via the handles' stage() fast-path) so this immediate buffer lands
    // after them, not before. No-op when nothing is staged.
    this.flushLayer(id);
    const buffer = data.buffer as ArrayBuffer;
    // Diagnostics: record before the buffer is transferred (detached after post).
    this.metrics.recordPush(id, data.length, buffer.byteLength);
    this.post(
      {
        op: Op.DATA,
        id,
        buffer,
        dtype: dtypeOf(data),
        length: data.length,
      },
      [buffer],
    );
  }

  /**
   * Allocation-free append fast-path used by the typed streaming handles'
   * `push()` ({@link FluxionDataSink.stage}). When `coalesce` is on, samples
   * are staged per layer and flushed as one `Op.DATA` per animation frame;
   * when off, this posts immediately (identical to `pushData` of one sample).
   *
   * `values` is consumed synchronously (copied into the layer's staging
   * buffer) — the caller may reuse or discard it right after.
   */
  stage(id: string, values: readonly number[]): void {
    if (this.disposed) return;
    if (!this.coalesce) {
      this.pushData(id, Float32Array.from(values));
      return;
    }
    this.metrics.recordPush(id, values.length, values.length * 4);
    let p = this.pending.get(id);
    if (!p) {
      p = { chunks: [], floats: 0 };
      this.pending.set(id, p);
    }
    const chunks = p.chunks;
    for (let i = 0; i < values.length; i++) chunks.push(values[i]!);
    p.floats += values.length;
    // Backpressure: if a layer outruns the flush cadence, post now rather than
    // let the staging buffer grow unbounded. Never drops samples.
    if (p.floats > this.coalesceMaxFloats) {
      this.flushLayer(id);
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Schedule a one-shot flush of all pending layers on the next frame — the
   * SHARED flush frame (one rAF drains every pending host), not a per-host rAF.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled || this.disposed) return;
    this.flushScheduled = true;
    requestHostFlush(this, () => this.flushAll());
  }

  /** Flush every layer's staged samples as one `Op.DATA` message each. */
  private flushAll(): void {
    this.flushScheduled = false;
    for (const id of [...this.pending.keys()]) this.flushLayer(id);
  }

  /**
   * Flush one layer's staged samples (if any) into a single transferred
   * `Op.DATA` message. Used both by the frame flush and by the pre-flush
   * ordering guards on control ops / `pushData`.
   */
  private flushLayer(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    // A pending entry only exists because stage() appended ≥1 sample's worth
    // of scalars, so chunks is always non-empty here.
    const buf = new Float32Array(p.chunks);
    this.post({ op: Op.DATA, id, buffer: buf.buffer, dtype: "f32", length: buf.length }, [
      buf.buffer,
    ]);
  }

  /**
   * Snapshot of main-thread-observable activity for debugging dashboards —
   * push/sample/byte counters, per-layer push counts, last-push time, and the
   * latest worker-reported bounds. Cheap; safe to poll. Note these are
   * main-thread metrics (what was sent); ring eviction happens worker-side.
   */
  getMetrics(): FluxionMetrics {
    return this.metrics.getMetrics();
  }

  /**
   * Subscribe to periodic metrics snapshots (for perf dashboards). All
   * subscribers share a single interval; it starts on the first subscription
   * and stops when the last unsubscribes (or on `dispose`). Returns an
   * unsubscribe function. `intervalMs` of the FIRST subscriber sets the rate.
   */
  onMetricsUpdate(cb: MetricsListener, opts?: { intervalMs?: number }): () => void {
    return this.metrics.onMetricsUpdate(cb, opts);
  }

  /**
   * Transfer a raw Float32Array to the custom worker's `streamHandler` (zero-copy).
   * After this call, `buffer` is detached — do not read it again.
   *
   * Only meaningful when the host was created with `workerFactory` pointing at
   * a custom worker script that uses `defineWorkerWithState(rpcHandler, streamHandler)`.
   * The streamHandler receives `{ id, buffer, length, mode: "stream" }`.
   */
  emitStream(id: string, buffer: ArrayBuffer, length: number): void {
    if (this.disposed) return;
    // Bypasses post() → drain staged layer data first so a custom-worker
    // stream can't jump ahead of queued Op.DATA.
    this.flushAll();
    const msg = { id, buffer, length, mode: "stream" as const };
    this.worker.postMessage(msg, [buffer]);
  }

  /**
   * The unique identifier for this host's Engine instance in the worker.
   * In pool mode this is the `hostId` assigned by the pool; in solo mode it is `"__solo__"`.
   * Use this to build the `targets` array for `emitPoolStream`.
   */
  get hostId(): string {
    return this.worker.hostId ?? "__solo__";
  }

  /**
   * Fan-out a single buffer to multiple Engine instances on the same worker (zero-copy).
   * The buffer is decoded once on the worker, then `pushRaw` is called for each target.
   *
   * All target `hostId`s must reside on the same worker as this host.
   * Use a size-1 pool (`useFluxionWorkerPool({ size: 1 })`) to guarantee co-location.
   * After this call, `buffer` is detached — do not read it again.
   *
   * The built-in worker validates `length`, but a **custom worker** decoding the
   * `pool-stream` message MUST clamp it before constructing a view, e.g.
   * `Math.max(0, Math.min(s.length | 0, s.buffer.byteLength >>> 2))`, so a
   * malformed length can't throw and halt the worker.
   */
  emitPoolStream(
    targets: FluxionPoolStreamMsg["targets"],
    buffer: ArrayBuffer,
    length: number,
  ): void {
    if (this.disposed) return;
    this.flushAll();
    const msg: FluxionPoolStreamMsg = { mode: "pool-stream", targets, buffer, length };
    this.worker.postMessage(msg, [buffer]);
  }

  /**
   * Clear a layer's data buffer (ring buffer for streaming layers) without
   * removing the layer or touching its config. Pass `latestT` to force the
   * worker's time-mode axis window to rewind — needed when a replay player
   * seeks backward, since `viewport.latestT` is otherwise monotonic-up.
   *
   * Pair with `LineLayerHandle.reset(latestT)` for a typed call site.
   */
  clearLayer(id: string, opts?: { latestT?: number }): void {
    // CLEAR before staged samples would wipe then re-fill — flush first so the
    // clear lands last.
    this.flushLayer(id);
    this.post({ op: Op.CLEAR_DATA, id, latestT: opts?.latestT });
  }

  resize(width: number, height: number, dpr: number): void {
    this.flushAll();
    this.post({ op: Op.RESIZE, width, height, dpr });
  }

  /**
   * Cancel a pending coalesce flush and clear the scheduled flag. Shared by
   * `dispose` and `reset` — unregisters this host from the shared flush frame
   * so a disposed/parked host is never drained by it.
   */
  private cancelScheduledFlush(): void {
    cancelHostFlush(this);
    this.flushScheduled = false;
  }

  dispose(): void {
    if (this.disposed) return;
    // Cancel the scheduled flush first (flushAll would null the handle), then
    // drain the last frame's staged samples synchronously (flushLayer posts via
    // this.post, still allowed until `disposed` is set).
    this.cancelScheduledFlush();
    // A throwing final flush (e.g. a detached buffer) must NOT abort teardown —
    // the DISPOSE post below still tears the worker layer down. Best-effort flush.
    try {
      this.flushAll();
    } catch {
      // ignore — the DISPOSE below tears the layer down regardless
    }
    this.pending.clear();
    // Post the worker teardown BEFORE flipping `disposed` — `post()` drops any
    // message once `disposed` is set, and in pool mode this DISPOSE is the ONLY
    // thing that tears the worker engine down (→ POOL_DISPOSE → Engine.dispose →
    // scheduler.stop + releaseBacking) and frees the pool slot; `terminate()`
    // below is a no-op for a pooled handle. Sent after the final flush so any
    // staged DATA still ships first. Best-effort — the worker may already be gone.
    try {
      this.post({ op: Op.DISPOSE });
    } catch {
      // worker may already be gone
    }
    this.disposed = true;
    // Remove worker→main message listener
    if (this.workerMsgHandler && this.worker.removeEventListener) {
      this.worker.removeEventListener("message", this.workerMsgHandler);
    }
    this.workerMsgHandler = null;
    /* v8 ignore next -- the no-handler / no-document arms are unreachable in the DOM test env */
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityHandler = null;
    this.metrics.dispose();
    this.boundsEmitter.clear();
    this.tickEmitter.clear();
    this.renderStatsEmitter.clear();
    this.worker.terminate();
  }

  private post(msg: HostMsg, transfer?: Transferable[]): void {
    if (this.disposed) return;
    if (transfer && transfer.length) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }
}
