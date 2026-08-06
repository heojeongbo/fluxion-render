import { AreaChartLayer } from "../../../entities/area-chart-layer";
import { AxisGridLayer } from "../../../entities/axis-grid-layer";
import { BarChartLayer } from "../../../entities/bar-chart-layer";
import { BoxPlotLayer } from "../../../entities/box-plot-layer";
import { CandlestickLayer } from "../../../entities/candlestick-layer";
import { EventMarkerLayer } from "../../../entities/event-marker-layer";
import { HeatmapLayer } from "../../../entities/heatmap-layer";
import { HeatmapStreamLayer } from "../../../entities/heatmap-stream-layer";
import { HistogramLayer } from "../../../entities/histogram-layer";
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
import { registerLayer } from "./layer-registry";

let done = false;

/**
 * Register factories for ALL built-in layer kinds. The default worker
 * (`app/worker/fluxion-worker`) calls this, so out of the box every kind works
 * exactly as before. Importing this module is what pulls all 21 layer classes
 * into a bundle — a custom worker that wants a smaller bundle skips it and calls
 * {@link registerLayer} for only the kinds it uses instead. Idempotent.
 */
export function registerDefaultLayers(): void {
  if (done) return;
  done = true;
  registerLayer("line", (id) => new LineChartLayer(id));
  registerLayer("line-static", (id) => new LineChartStaticLayer(id));
  registerLayer("lidar", (id) => new LidarScatterLayer(id));
  registerLayer("axis-grid", (id) => new AxisGridLayer(id));
  registerLayer("scatter", (id) => new ScatterChartLayer(id));
  registerLayer("area", (id) => new AreaChartLayer(id));
  registerLayer("step", (id) => new StepChartLayer(id));
  registerLayer("bar", (id) => new BarChartLayer(id));
  registerLayer("candlestick", (id) => new CandlestickLayer(id));
  registerLayer("heatmap", (id) => new HeatmapLayer(id));
  registerLayer("event-marker", (id) => new EventMarkerLayer(id));
  registerLayer("scatter-colored", (id) => new ScatterColoredLayer(id));
  registerLayer("heatmap-stream", (id) => new HeatmapStreamLayer(id));
  registerLayer("reference-line", (id) => new ReferenceLineLayer(id));
  registerLayer("pose-arrow", (id) => new PoseArrowLayer(id));
  registerLayer("trajectory", (id) => new TrajectoryLayer(id));
  registerLayer("occupancy-grid", (id) => new OccupancyGridLayer(id));
  registerLayer("histogram", (id) => new HistogramLayer(id));
  registerLayer("stacked-area", (id) => new StackedAreaLayer(id));
  registerLayer("box-plot", (id) => new BoxPlotLayer(id));
  registerLayer("polar", (id) => new PolarLayer(id));
}
