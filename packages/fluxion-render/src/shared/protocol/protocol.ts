/**
 * Binary message protocol between main-thread `FluxionHost` and worker `Engine`.
 * Uses a plain const object (not const enum) so consumers with
 * `isolatedModules` can import types safely from the published package.
 */
export const Op = {
  INIT: 1,
  RESIZE: 2,
  ADD_LAYER: 3,
  REMOVE_LAYER: 4,
  CONFIG: 5,
  DATA: 6,
  DISPOSE: 7,
  SET_BG_COLOR: 8,
  POOL_INIT: 9,
  POOL_DISPOSE: 10,
  SET_AXIS_CANVAS: 11,
  SET_AXIS_STYLE: 12,
  CLEAR_DATA: 13,
  SET_VISIBLE: 14,
  CONFIG_BATCH: 15,
  RESET: 16,
  RELEASE_BACKING: 17,
  SET_ON_SCREEN: 18,
} as const;
export type Op = (typeof Op)[keyof typeof Op];

export type LayerKind =
  | "line"
  | "line-static"
  | "lidar"
  | "axis-grid"
  | "scatter"
  | "area"
  | "step"
  | "bar"
  | "candlestick"
  | "heatmap"
  | "event-marker"
  | "scatter-colored"
  | "heatmap-stream"
  | "reference-line"
  | "pose-arrow"
  | "trajectory"
  | "occupancy-grid"
  | "histogram"
  | "stacked-area"
  | "box-plot"
  | "polar";

export type DType = "f32" | "u8" | "i16" | "u16" | "i32";

/** Rendering backend for a chart's worker engine. Construction-fixed. */
export type RendererKind = "2d" | "webgl";

export interface InitMsg {
  op: typeof Op.INIT;
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  dpr: number;
  /**
   * Optional canvas background color. Applied every frame before layers draw.
   * Default (when omitted): `"#0b0d12"` — matches the engine's dark default.
   */
  bgColor?: string;
  /** Cap the engine's render rate to this many fps. Omitted = uncapped. */
  maxFps?: number;
  /** Post BOUNDS_UPDATE to the main thread on y-bounds change. Omitted = true. */
  emitBounds?: boolean;
  /** Post TICK_UPDATE to the main thread (React-side axis fallback). Omitted = true. */
  emitTicks?: boolean;
  /** Keep the canvas alpha channel. Omitted/false = opaque context (faster compositing). */
  transparent?: boolean;
  /** Periodically post RENDER_STATS (render count + CPU time) for perf HUDs. Omitted = off. */
  emitRenderStats?: boolean;
  /**
   * Inline-axes mode: the engine reserves margins INSIDE the main canvas
   * (`yAxisWidth` on the left, `xAxisHeight` at the bottom) and draws axis
   * ticks/labels there itself — one canvas surface per chart instead of up to
   * three. Omitted/false = plot spans the full canvas (unchanged).
   */
  inlineAxes?: boolean;
  /** Inline-axes bottom margin in CSS px. Only read with `inlineAxes`. Default 30. */
  xAxisHeight?: number;
  /** Inline-axes left margin in CSS px. Only read with `inlineAxes`. Default 60. */
  yAxisWidth?: number;
  /** Rendering backend. "webgl" bypasses the 2d remote-canvas pipeline. Default "2d". */
  renderer?: RendererKind;
  hostId?: string;
}

export interface ResizeMsg {
  op: typeof Op.RESIZE;
  width: number;
  height: number;
  dpr: number;
  hostId?: string;
}

export interface AddLayerMsg {
  op: typeof Op.ADD_LAYER;
  id: string;
  kind: LayerKind;
  config?: unknown;
  hostId?: string;
}

export interface RemoveLayerMsg {
  op: typeof Op.REMOVE_LAYER;
  id: string;
  hostId?: string;
}

export interface ConfigMsg {
  op: typeof Op.CONFIG;
  id: string;
  config: unknown;
  hostId?: string;
}

/**
 * Batched layer-config update: applies several `CONFIG`-equivalent updates in a
 * single message. The engine resolves each entry's layer and calls `setConfig`,
 * then recomputes continuous-mode / marks dirty once for the whole batch.
 * Used by `FluxionHost.configLayers` / `setLayerVisibility` so toggling many
 * series (e.g. a grid of charts) costs one postMessage instead of N.
 */
export interface ConfigBatchMsg {
  op: typeof Op.CONFIG_BATCH;
  entries: Array<{ id: string; config: unknown }>;
  hostId?: string;
}

export interface DataMsg {
  op: typeof Op.DATA;
  id: string;
  buffer: ArrayBuffer;
  dtype: DType;
  length: number;
  hostId?: string;
}

export interface DisposeMsg {
  op: typeof Op.DISPOSE;
  hostId?: string;
}

/**
 * Canvas-scope (engine-level) background color update. Takes effect on the
 * next rendered frame. Separate from `CONFIG` because `CONFIG` is layer-scope.
 */
export interface SetBgColorMsg {
  op: typeof Op.SET_BG_COLOR;
  color: string;
  hostId?: string;
}

/** Pool-only: register a new engine for `hostId` in the worker. */
export interface PoolInitMsg {
  op: typeof Op.POOL_INIT;
  hostId: string;
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  dpr: number;
  bgColor?: string;
  maxFps?: number;
  emitBounds?: boolean;
  emitTicks?: boolean;
  transparent?: boolean;
  emitRenderStats?: boolean;
  inlineAxes?: boolean;
  xAxisHeight?: number;
  yAxisWidth?: number;
  renderer?: RendererKind;
}

/** Pool-only: tear down the engine for `hostId` without terminating the worker. */
export interface PoolDisposeMsg {
  op: typeof Op.POOL_DISPOSE;
  hostId: string;
}

/** Axis canvas style configuration. */
export interface AxisStyle {
  color?: string;
  font?: string;
  tickSize?: number;
  tickMargin?: number;
  bgColor?: string;
}

/**
 * Transfer axis OffscreenCanvas(es) to the worker engine.
 * Sent after INIT/POOL_INIT so the canvases can be in separate Transferable arrays.
 */
export interface SetAxisCanvasMsg {
  op: typeof Op.SET_AXIS_CANVAS;
  hostId?: string;
  xAxisCanvas?: OffscreenCanvas;
  yAxisCanvas?: OffscreenCanvas;
  xAxisHeight: number;
  yAxisWidth: number;
}

/**
 * Clear a layer's data buffer (ring buffer for streaming layers, last-set
 * dataset for static layers) without removing the layer. Useful for replay
 * seek-back where the chart must drop stale data and re-hydrate from a store.
 *
 * Optionally rewinds `viewport.latestT` so the axis-grid time window can
 * follow a backward seek — normally `latestT` is monotonic-up (it only
 * advances when a layer pushes data with a newer `t`), which would freeze
 * the visible window after a backward seek.
 */
export interface ClearDataMsg {
  op: typeof Op.CLEAR_DATA;
  id: string;
  /** If set, force `viewport.latestT` to this value (allows backward rewind). */
  latestT?: number;
  hostId?: string;
}

/**
 * Page-visibility signal from the host. The worker has no `document`, so the
 * main thread forwards `visibilitychange` here. While hidden, the engine drops
 * out of continuous (follow-clock) rendering to save CPU/battery; on becoming
 * visible it re-anchors the follow-clock window to the current wall clock.
 */
export interface SetVisibleMsg {
  op: typeof Op.SET_VISIBLE;
  visible: boolean;
  hostId?: string;
}

/**
 * Per-chart on-screen signal, driven by a main-thread IntersectionObserver
 * (the `pauseWhenOffscreen` opt-in). Orthogonal to `SET_VISIBLE` (page
 * visibility): the engine renders only while BOTH are true, so a scrolled-off
 * chart and a hidden tab both fully suspend the render loop. Data ingestion is
 * NOT gated — samples keep flowing into the ring while off-screen, so a chart
 * scrolled back into view repaints its full buffered history in one frame
 * (no gap), then re-anchors the follow-clock window to now.
 */
export interface SetOnScreenMsg {
  op: typeof Op.SET_ON_SCREEN;
  onScreen: boolean;
  hostId?: string;
}

/**
 * Reset an engine to a pristine, just-constructed state WITHOUT tearing down
 * its OffscreenCanvas binding or worker engine — the basis of host recycling.
 * Disposes every layer (empty stack), rewinds the viewport (`latestT`, bounds,
 * observed-y, last-emitted-bounds latches) and engine-level bg/axis style back
 * to defaults, and drops any pending tick/bounds emitter listeners. After a
 * RESET the engine is indistinguishable from a fresh one, so the normal mount
 * sequence (ADD_LAYER per spec, SET_BG_COLOR, RESIZE, SET_VISIBLE) re-hydrates
 * a recycled host exactly as a cold one.
 */
export interface ResetMsg {
  op: typeof Op.RESET;
  hostId?: string;
}

/** Update axis rendering style (color, font, tick size, etc.). */
export interface SetAxisStyleMsg {
  op: typeof Op.SET_AXIS_STYLE;
  hostId?: string;
  color?: string;
  font?: string;
  tickSize?: number;
  tickMargin?: number;
  bgColor?: string;
}

/**
 * Free the engine's OffscreenCanvas GPU backing stores (main + axis) by
 * shrinking them to 0×0, WITHOUT tearing down the engine, its layers, or the
 * canvas bindings — the worker side of parked-host idle shrink (see the
 * recycle pool's `idleShrinkMs`). The engine stays fully functional; the next
 * RESIZE re-allocates the backings at the requested size. Rendering onto a
 * 0×0 canvas in the interim is a silent no-op (parked hosts are also
 * `SET_VISIBLE false`).
 */
export interface ReleaseBackingMsg {
  op: typeof Op.RELEASE_BACKING;
  hostId?: string;
}

export type HostMsg =
  | InitMsg
  | ResizeMsg
  | AddLayerMsg
  | RemoveLayerMsg
  | ConfigMsg
  | ConfigBatchMsg
  | DataMsg
  | DisposeMsg
  | SetBgColorMsg
  | PoolInitMsg
  | PoolDisposeMsg
  | SetAxisCanvasMsg
  | SetAxisStyleMsg
  | ClearDataMsg
  | SetVisibleMsg
  | SetOnScreenMsg
  | ResetMsg
  | ReleaseBackingMsg;

/**
 * Stream-channel message for custom worker scripts.
 * Sent via `FluxionHost.emitStream()` / `FluxionWorkerHandle.emitStream()`.
 * Not part of the `HostMsg` union — consumed by the user-defined streamHandler.
 *
 * The `buffer` is transferred (zero-copy). After `emitStream()` returns,
 * the caller's ArrayBuffer is detached and must not be read.
 */
export interface StreamDataMsg {
  /** Target layer id inside the Engine. */
  id: string;
  /** Transferred Float32 payload — detached on main thread after send. */
  buffer: ArrayBuffer;
  /** Number of valid Float32 elements (not bytes) in `buffer`. */
  length: number;
  /** Optional layout hint for the custom decoder (engine ignores this). */
  stride?: number;
}

/**
 * Pool-level fan-out stream message.
 * Sent via `FluxionHost.emitPoolStream()` to deliver one decoded buffer to
 * multiple Engine instances on the same worker in a single transfer.
 *
 * All target hostIds must reside on the same worker as the sending host.
 * Use a size-1 pool (`useFluxionWorkerPool({ size: 1 })`) to guarantee
 * co-location of all hosts before calling `emitPoolStream`.
 */
export interface FluxionPoolStreamMsg {
  mode: "pool-stream";
  /** Each entry maps one engine (by hostId) to one layer (by layerId). */
  targets: Array<{ hostId: string; layerId: string }>;
  /** Transferred Float32 payload — decoded once, pushed to all targets. */
  buffer: ArrayBuffer;
  /** Number of valid Float32 elements (not bytes) in `buffer`. */
  length: number;
}

// ────────────────────────────────────────────────────────────────────────
// Worker → Main messages (posted via self.postMessage inside the worker)
// ────────────────────────────────────────────────────────────────────────

/**
 * Routing id for a solo (non-pooled) host — one host owns its worker, so no
 * pool-assigned id exists. Used on BOTH sides (engine outbox keys, main-thread
 * batch demux) so a solo host's updates route to it exactly like a pooled one.
 */
export const SOLO_HOST_ID = "__solo__";

export const WorkerOp = {
  BOUNDS_UPDATE: 100,
  TICK_UPDATE: 101,
  RENDER_STATS: 102,
  /**
   * One coalesced worker→main frame carrying every host's pending
   * bounds/tick/stats updates (see {@link BatchUpdateMsg}). Replaces the three
   * per-host messages above on the wire so N hosts multiplexed onto one worker
   * cost ONE post + ONE main-thread listener invocation per frame instead of
   * up to 3N posts × N hostId-filtered listeners (O(N²) → O(N)).
   */
  BATCH_UPDATE: 103,
} as const;
export type WorkerOp = (typeof WorkerOp)[keyof typeof WorkerOp];

/**
 * Sent by the engine after each draw frame when the effective y-bounds
 * have changed. Enables the React-side `useAxisTicks` hook to show live
 * y-axis labels for `yMode: "auto"`.
 * `latestT` is the worker-side `viewport.latestT` so the external x-axis
 * uses the same time origin as the canvas grid lines.
 */
export interface BoundsUpdateMsg {
  op: typeof WorkerOp.BOUNDS_UPDATE;
  hostId?: string;
  yMin: number;
  yMax: number;
  latestT: number;
}

/** Serialized form of a single axis tick. structuredClone-safe. */
export interface SerializedTick {
  value: number;
  label: string;
  fraction: number;
}

/**
 * Sent by the engine after each draw frame when ticks need updating.
 * Replaces the main-thread setInterval-based tick computation in
 * `useAxisTicks`. `xRawValues` is populated only when `xTickFormat` is a
 * function — the main thread applies the function and fills in the labels.
 */
export interface TickUpdateMsg {
  op: typeof WorkerOp.TICK_UPDATE;
  hostId?: string;
  xTicks: SerializedTick[];
  yTicks: SerializedTick[];
  /** Raw x tick values when xTickFormat is a function (main-thread post-processing). */
  xRawValues: number[];
}

/**
 * Periodic render-load report from the engine, opt-in via `emitRenderStats`.
 * Lets a perf HUD distinguish a main-thread mount spike from worker-thread
 * saturation: `busyMs` is the wall-clock time the engine spent rendering during
 * the `windowMs` window, and `renders` the frame count. Summing `busyMs/windowMs`
 * across all hosts on a worker estimates that worker's render utilization.
 */
export interface RenderStatsMsg {
  op: typeof WorkerOp.RENDER_STATS;
  hostId?: string;
  /** Frames rendered during the window. */
  renders: number;
  /** Wall-clock ms spent inside render() during the window. */
  busyMs: number;
  /** Window length in ms (wall-clock between emits). */
  windowMs: number;
}

/**
 * One host's coalesced updates for a single frame. Each field is latest-wins
 * (the last value the engine produced this frame) and present only when that
 * kind fired — a follow-clock chart with stable y-bounds emits `{ ticks }` with
 * no `bounds`, a fixed-bounds chart emits nothing and is absent from the batch.
 */
export interface BatchEntry {
  hostId: string;
  bounds?: { yMin: number; yMax: number; latestT: number };
  ticks?: { xTicks: SerializedTick[]; yTicks: SerializedTick[]; xRawValues: number[] };
  stats?: { renders: number; busyMs: number; windowMs: number };
}

/**
 * The single worker→main message posted once per rendered frame (see
 * {@link WorkerOp.BATCH_UPDATE}). `updates` holds one {@link BatchEntry} per
 * host that produced any update this frame; the main-thread receiver demuxes
 * by `hostId`. Bytes are identical to the sum of the per-host messages it
 * replaces — batching changes framing and delivery cost, not payload.
 */
export interface BatchUpdateMsg {
  op: typeof WorkerOp.BATCH_UPDATE;
  updates: BatchEntry[];
}

export type WorkerMsg = BoundsUpdateMsg | TickUpdateMsg | RenderStatsMsg | BatchUpdateMsg;
