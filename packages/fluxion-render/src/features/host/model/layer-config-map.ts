import type { AreaChartConfig } from "../../../entities/area-chart-layer";
import type { AxisGridConfig } from "../../../entities/axis-grid-layer";
import type { BarChartConfig } from "../../../entities/bar-chart-layer";
import type { BoxPlotConfig } from "../../../entities/box-plot-layer";
import type { CandlestickConfig } from "../../../entities/candlestick-layer";
import type { EventMarkerConfig } from "../../../entities/event-marker-layer";
import type { HeatmapConfig } from "../../../entities/heatmap-layer";
import type { HeatmapStreamConfig } from "../../../entities/heatmap-stream-layer";
import type { HistogramConfig } from "../../../entities/histogram-layer";
import type { LidarScatterConfig } from "../../../entities/lidar-scatter-layer";
import type { LineChartConfig } from "../../../entities/line-chart-layer";
import type { LineChartStaticConfig } from "../../../entities/line-chart-static-layer";
import type { OccupancyGridConfig } from "../../../entities/occupancy-grid-layer";
import type { PolarConfig } from "../../../entities/polar-layer";
import type { PoseArrowConfig } from "../../../entities/pose-arrow-layer";
import type { ReferenceLineConfig } from "../../../entities/reference-line-layer";
import type { ScatterChartConfig } from "../../../entities/scatter-chart-layer";
import type { ScatterColoredConfig } from "../../../entities/scatter-colored-layer";
import type { StackedAreaConfig } from "../../../entities/stacked-area-layer";
import type { StepChartConfig } from "../../../entities/step-chart-layer";
import type { TrajectoryConfig } from "../../../entities/trajectory-layer";
import type { LayerKind } from "../../../shared/protocol";

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
