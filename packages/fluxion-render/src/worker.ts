/**
 * "@heojeongbo/fluxion-render/worker" sub-entry.
 *
 * Import this inside your custom worker script to get access to `Engine`
 * (for dispatching HostMsg and calling `pushRaw`) plus all the
 * `defineWorker*` helpers from fluxion-worker.
 *
 * @example
 * ```ts
 * // my-sensor-worker.ts
 * import { Engine, defineWorkerWithState } from "@heojeongbo/fluxion-render/worker";
 * import type { HostMsg, StreamDataMsg } from "@heojeongbo/fluxion-render/worker";
 *
 * defineWorkerWithState<HostMsg, object, Engine, StreamDataMsg>(
 *   (msg, _reply, ctx) => {
 *     const engine = ctx.state ?? new Engine();
 *     engine.dispatch(msg as HostMsg);
 *     return engine;
 *   },
 *   (msg, _push, ctx) => {
 *     const engine = ctx.state;
 *     if (!engine) return;
 *     const arr = new Float32Array(msg.buffer, 0, msg.length);
 *     engine.pushRaw(msg.id, arr);
 *   },
 * );
 * ```
 */

export type {
  FluxionMode,
  HostContext,
  PushFn,
  ReplyFn,
  WorkerMsg,
} from "@heojeongbo/fluxion-worker";
export {
  defineWorker,
  defineWorkerWithState,
} from "@heojeongbo/fluxion-worker";
// Built-in layer classes, for a custom slim worker that registers only the
// kinds it uses (bundler tree-shakes the rest). Pair each with `registerLayer`:
//   registerLayer("line", (id) => new LineChartLayer(id))
// Or call `registerDefaultLayers()` to register all of them (the default worker).
export { AreaChartLayer } from "./entities/area-chart-layer";
export { AxisGridLayer } from "./entities/axis-grid-layer";
export { BarChartLayer } from "./entities/bar-chart-layer";
export { BoxPlotLayer } from "./entities/box-plot-layer";
export { CandlestickLayer } from "./entities/candlestick-layer";
export { EventMarkerLayer } from "./entities/event-marker-layer";
export { HeatmapLayer } from "./entities/heatmap-layer";
export { HeatmapStreamLayer } from "./entities/heatmap-stream-layer";
export { HistogramLayer } from "./entities/histogram-layer";
export { LidarScatterLayer } from "./entities/lidar-scatter-layer";
export { LineChartLayer } from "./entities/line-chart-layer";
export { LineChartStaticLayer } from "./entities/line-chart-static-layer";
export { OccupancyGridLayer } from "./entities/occupancy-grid-layer";
export { PolarLayer } from "./entities/polar-layer";
export { PoseArrowLayer } from "./entities/pose-arrow-layer";
export { ReferenceLineLayer } from "./entities/reference-line-layer";
export { ScatterChartLayer } from "./entities/scatter-chart-layer";
export { ScatterColoredLayer } from "./entities/scatter-colored-layer";
export { StackedAreaLayer } from "./entities/stacked-area-layer";
export { StepChartLayer } from "./entities/step-chart-layer";
export { TrajectoryLayer } from "./entities/trajectory-layer";
export {
  createLayer,
  Engine,
  hasLayer,
  type LayerFactory,
  registerDefaultLayers,
  registerLayer,
} from "./features/engine";
export type {
  BoundsUpdateMsg,
  DType,
  FluxionPoolStreamMsg,
  HostMsg,
  LayerKind,
  PoolDisposeMsg,
  PoolInitMsg,
  RenderStatsMsg,
  SerializedTick,
  StreamDataMsg,
  TickUpdateMsg,
  // The engine's worker→main output messages (bounds / tick / render-stats).
  // Named `EngineOutMsg` to avoid colliding with fluxion-worker's generic
  // `WorkerMsg` re-exported above; a custom worker forwards these to the host.
  WorkerMsg as EngineOutMsg,
} from "./shared/protocol";
export { Op, WorkerOp } from "./shared/protocol";
