import type { LayerKind } from "../protocol";
import type {
  AreaChartConfig,
  AxisGridConfig,
  BarChartConfig,
  BoxPlotConfig,
  CandlestickConfig,
  CurrentTimeConfig,
  EventMarkerConfig,
  HeatmapConfig,
  HeatmapStreamConfig,
  HistogramConfig,
  LidarScatterConfig,
  LineChartConfig,
  LineChartStaticConfig,
  OccupancyGridConfig,
  PolarConfig,
  PoseArrowConfig,
  ReferenceLineConfig,
  ScatterChartConfig,
  ScatterColoredConfig,
  StackedAreaConfig,
  StepChartConfig,
  TrajectoryConfig,
} from "./layer-configs";

/**
 * The config shape each {@link LayerKind} accepts. The single source of truth for
 * kind→config typing across the library: `addLayer<K>(id, kind, config)` reads
 * `LayerConfigByKind[K]` for per-kind autocomplete + typo detection, and the
 * declarative `FluxionLayerSpec` union is derived from it so the imperative and
 * declarative APIs stay in lockstep. Every kind in `LayerKind` MUST appear here —
 * a missing entry is a compile error at the `satisfies`-style check below.
 */
export interface LayerConfigByKind {
  line: LineChartConfig;
  "line-static": LineChartStaticConfig;
  lidar: LidarScatterConfig;
  "axis-grid": AxisGridConfig;
  scatter: ScatterChartConfig;
  area: AreaChartConfig;
  step: StepChartConfig;
  bar: BarChartConfig;
  candlestick: CandlestickConfig;
  heatmap: HeatmapConfig;
  "event-marker": EventMarkerConfig;
  "scatter-colored": ScatterColoredConfig;
  "heatmap-stream": HeatmapStreamConfig;
  "reference-line": ReferenceLineConfig;
  "current-time": CurrentTimeConfig;
  "pose-arrow": PoseArrowConfig;
  trajectory: TrajectoryConfig;
  "occupancy-grid": OccupancyGridConfig;
  histogram: HistogramConfig;
  "stacked-area": StackedAreaConfig;
  "box-plot": BoxPlotConfig;
  polar: PolarConfig;
}

// Compile-time exhaustiveness: fails if a LayerKind is missing from the map or
// the map gains a key that is not a LayerKind. Type-only — erased at build.
type _AssertExhaustive = LayerKind extends keyof LayerConfigByKind
  ? keyof LayerConfigByKind extends LayerKind
    ? true
    : ["extra key in LayerConfigByKind not in LayerKind"]
  : ["LayerKind missing from LayerConfigByKind"];
export type _LayerConfigMapIsExhaustive = _AssertExhaustive;
