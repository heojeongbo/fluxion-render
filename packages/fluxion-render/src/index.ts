// Framework-agnostic core entry. Zero React — the engine, worker pool, layer
// factories, host, and protocol types. React hooks and components live in
// `@heojeongbo/fluxion-render/react`, which re-exports everything here.
export { createFluxionWorkerFactory } from "./app/worker/create-worker-factory";
export type { AreaChartConfig } from "./entities/area-chart-layer";
export type { AxisGridConfig } from "./entities/axis-grid-layer";
export type { BarChartConfig } from "./entities/bar-chart-layer";
export type { BoxPlotConfig } from "./entities/box-plot-layer";
export type { CandlestickConfig } from "./entities/candlestick-layer";
export type { EventMarkerConfig } from "./entities/event-marker-layer";
export type { HeatmapConfig } from "./entities/heatmap-layer";
export type { HeatmapStreamConfig } from "./entities/heatmap-stream-layer";
export type { HistogramConfig } from "./entities/histogram-layer";
export type { LidarScatterConfig } from "./entities/lidar-scatter-layer";
export type { LineChartConfig } from "./entities/line-chart-layer";
export type { LineChartStaticConfig } from "./entities/line-chart-static-layer";
export type { OccupancyGridConfig } from "./entities/occupancy-grid-layer";
export type { PolarConfig } from "./entities/polar-layer";
export type { PoseArrowConfig } from "./entities/pose-arrow-layer";
export type { ReferenceLineConfig } from "./entities/reference-line-layer";
export type { ScatterChartConfig } from "./entities/scatter-chart-layer";
export type { ScatterColoredConfig } from "./entities/scatter-colored-layer";
export type { StackedAreaConfig } from "./entities/stacked-area-layer";
export type { StepChartConfig } from "./entities/step-chart-layer";
export type { TrajectoryConfig } from "./entities/trajectory-layer";
export type { CachedLayerOptions } from "./features/crosshair";
export { HoverDataCache, pushPacketToCache } from "./features/crosshair";
export type {
  BoundsChangeListener,
  BoxPlotStat,
  CandlestickSample,
  EventSeverity,
  FluxionDataSink,
  FluxionHostOptions,
  FluxionMetrics,
  FluxionTypedArray,
  FluxionWorkerPoolOptions,
  HeatmapPoint,
  HostBundle,
  HostRecyclePool,
  HostRecyclePoolOptions,
  LidarPoint,
  LidarStride,
  LineSample,
  MarkerEvent,
  MetricsListener,
  OccupancyGrid,
  PolarPoint,
  PoseArrowSample,
  RecycleKeyParams,
  RenderStats,
  RenderStatsListener,
  ScatterColoredSample,
  ScatterSample,
  StackedAreaSample,
  TrajectorySample,
  XyPoint,
} from "./features/host";
export {
  AreaLayerHandle,
  BarLayerHandle,
  BoxPlotHandle,
  CandlestickLayerHandle,
  configureDefaultPool,
  createHostRecyclePool,
  EventMarkerHandle,
  FluxionHost,
  FluxionWorkerPool,
  getDefaultPool,
  HeatmapLayerHandle,
  HeatmapStreamHandle,
  HistogramHandle,
  LidarLayerHandle,
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
} from "./features/host";
export { FluxionWorkerHandle } from "./features/worker-pool";
export type {
  AxisTick,
  AxisTickSet,
  ComputeAxisTicksOptions,
  XTickFormat,
  XTickFormatOptions,
  YTickFormat,
  YTickFormatOptions,
} from "./shared/lib/axis-ticks";
export { computeAxisTicks, formatTick, formatYTick } from "./shared/lib/axis-ticks";
export { DASH_PATTERNS, dashPatternFor } from "./shared/lib/dash-patterns";
export type { TickFormatter } from "./shared/lib/time-format";
export { formatClock, makeClockFormatter } from "./shared/lib/time-format";
export type {
  AxisStyle,
  DType,
  FluxionPoolStreamMsg,
  HostMsg,
  LayerKind,
} from "./shared/protocol";
export {
  areaLayer,
  axisGridLayer,
  barLayer,
  boxPlotLayer,
  candlestickLayer,
  eventMarkerLayer,
  heatmapLayer,
  heatmapStreamLayer,
  histogramLayer,
  lidarLayer,
  lineLayer,
  lineStaticLayer,
  occupancyGridLayer,
  polarLayer,
  poseArrowLayer,
  referenceLineLayer,
  type SpectrogramConfig,
  scatterColoredLayer,
  scatterLayer,
  spectrogramLayer,
  stackedAreaLayer,
  stepLayer,
  trajectoryLayer,
} from "./widgets/fluxion-canvas/lib/layer-specs";
export type { FluxionLayerSpec } from "./widgets/fluxion-canvas/lib/use-fluxion-canvas";
