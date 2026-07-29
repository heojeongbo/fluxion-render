import type { ComponentType } from "react";
import { AllDemoPage } from "../pages/all-demo";
import { AreaDemoPage } from "../pages/area-demo";
import { AxisFormatDemoPage } from "../pages/axis-format-demo";
import { BarDemoPage } from "../pages/bar-demo";
import { BenchDemoPage } from "../pages/bench-demo";
import { BoxPlotDemoPage } from "../pages/box-plot-demo";
import { BroadcastStressDemoPage } from "../pages/broadcast-stress-demo";
import { BrushDemoPage } from "../pages/brush-demo";
import { CandlestickDemoPage } from "../pages/candlestick-demo";
import { ChurnStressDemoPage } from "../pages/churn-stress-demo";
import { CrosshairDemoPage } from "../pages/crosshair-demo";
import { EventMarkerDemoPage } from "../pages/event-marker-demo";
import { ExternalAxesDemoPage } from "../pages/external-axes-demo";
import { FluxionWorkerDemoPage } from "../pages/fluxion-worker-demo";
import { FollowClockDemoPage } from "../pages/follow-clock-demo";
import { GaugeDemoPage } from "../pages/gauge-demo";
import { HeatmapDemoPage } from "../pages/heatmap-demo";
import { HelpersDemoPage } from "../pages/helpers-demo";
import { HighRateDemoPage } from "../pages/high-rate-demo";
import { HistogramDemoPage } from "../pages/histogram-demo";
import { HistoricalDemoPage } from "../pages/historical-demo";
import { LidarDemoPage } from "../pages/lidar-demo";
import { LineDemoPage } from "../pages/line-demo";
import { OccupancyGridDemoPage } from "../pages/occupancy-grid-demo";
import { PieDemoPage } from "../pages/pie-demo";
import { PolarDemoPage } from "../pages/polar-demo";
import { PoolDemoPage } from "../pages/pool-demo";
import { PoseArrowDemoPage } from "../pages/pose-arrow-demo";
import { ReferenceLineDemoPage } from "../pages/reference-line-demo";
import { RobotDashboardPage } from "../pages/robot-dashboard";
import { ScatterColoredDemoPage } from "../pages/scatter-colored-demo";
import { ScatterDemoPage } from "../pages/scatter-demo";
import { StackedAreaDemoPage } from "../pages/stacked-area-demo";
import { StaticXyDemoPage } from "../pages/static-xy-demo";
import { StepDemoPage } from "../pages/step-demo";
import { StreamDemoPage } from "../pages/stream-demo";
import { StreamWorkerDemoPage } from "../pages/stream-worker-demo";
import { StressTestDemoPage } from "../pages/stress-test-demo";
import { TableDemoPage } from "../pages/table-demo";
import { ThemeDemoPage } from "../pages/theme-demo";
import { TrajectoryDemoPage } from "../pages/trajectory-demo";

/** One demo: its URL slug, sidebar label, and page component. */
export interface DemoEntry {
  /** URL path segment (route is `/${slug}`). */
  slug: string;
  /** Sidebar label. */
  label: string;
  component: ComponentType;
}

export interface DemoGroup {
  label: string;
  demos: DemoEntry[];
}

/**
 * Single source of truth for the demo app: both the TanStack Router routes and
 * the sidebar navigation are generated from this. Add a demo here and it gets a
 * route at `/${slug}` plus a sidebar link automatically.
 */
export const DEMO_GROUPS: readonly DemoGroup[] = [
  {
    label: "Robot",
    demos: [
      { slug: "robot-dashboard", label: "Dashboard", component: RobotDashboardPage },
    ],
  },
  {
    label: "Basic Charts",
    demos: [
      { slug: "all", label: "All", component: AllDemoPage },
      { slug: "line", label: "Stream", component: LineDemoPage },
      { slug: "high-rate", label: "500 Hz Stream", component: HighRateDemoPage },
      { slug: "stream", label: "Multi-stream", component: StreamDemoPage },
      {
        slug: "follow-clock",
        label: "Follow Clock (bursty)",
        component: FollowClockDemoPage,
      },
      { slug: "crosshair", label: "Crosshair", component: CrosshairDemoPage },
      { slug: "static", label: "Static XY", component: StaticXyDemoPage },
      { slug: "scatter", label: "Scatter", component: ScatterDemoPage },
      { slug: "area", label: "Area", component: AreaDemoPage },
      { slug: "step", label: "Step", component: StepDemoPage },
      { slug: "bar", label: "Bar", component: BarDemoPage },
      { slug: "candlestick", label: "Candlestick", component: CandlestickDemoPage },
      { slug: "heatmap", label: "Heatmap", component: HeatmapDemoPage },
      { slug: "histogram", label: "Histogram", component: HistogramDemoPage },
      { slug: "stacked-area", label: "Stacked Area", component: StackedAreaDemoPage },
      { slug: "box-plot", label: "Box Plot", component: BoxPlotDemoPage },
      { slug: "pie", label: "Pie Chart", component: PieDemoPage },
      { slug: "table", label: "Table", component: TableDemoPage },
    ],
  },
  {
    label: "DX Helpers",
    demos: [
      { slug: "helpers", label: "Helper Hooks + Dash", component: HelpersDemoPage },
      { slug: "axis-format", label: "Axis Formatters", component: AxisFormatDemoPage },
    ],
  },
  {
    label: "Robot Specific",
    demos: [
      { slug: "event-marker", label: "Event Markers", component: EventMarkerDemoPage },
      {
        slug: "scatter-colored",
        label: "Scatter Colored",
        component: ScatterColoredDemoPage,
      },
      { slug: "gauge", label: "Gauge", component: GaugeDemoPage },
      {
        slug: "reference-line",
        label: "Reference Line",
        component: ReferenceLineDemoPage,
      },
      { slug: "pose-arrow", label: "Pose Arrow", component: PoseArrowDemoPage },
      { slug: "trajectory", label: "Trajectory", component: TrajectoryDemoPage },
      {
        slug: "occupancy-grid",
        label: "Occupancy Grid",
        component: OccupancyGridDemoPage,
      },
      { slug: "polar", label: "Polar / LiDAR", component: PolarDemoPage },
      { slug: "brush", label: "Brush + Export", component: BrushDemoPage },
    ],
  },
  {
    label: "Infrastructure",
    demos: [
      { slug: "historical", label: "Historical", component: HistoricalDemoPage },
      { slug: "lidar", label: "LiDAR 30k", component: LidarDemoPage },
      { slug: "pool", label: "Pool (40 charts)", component: PoolDemoPage },
      {
        slug: "churn",
        label: "Mount/Unmount Churn (300)",
        component: ChurnStressDemoPage,
      },
      { slug: "stress", label: "Stress (300@500Hz)", component: StressTestDemoPage },
      { slug: "bench", label: "Bench (auto-measure)", component: BenchDemoPage },
      {
        slug: "broadcast-stress",
        label: "Broadcast (500Hz)",
        component: BroadcastStressDemoPage,
      },
      {
        slug: "stream-worker",
        label: "Custom Worker Stream",
        component: StreamWorkerDemoPage,
      },
      {
        slug: "fluxion-worker",
        label: "fluxion-worker",
        component: FluxionWorkerDemoPage,
      },
      { slug: "external-axes", label: "External axes", component: ExternalAxesDemoPage },
      { slug: "theme", label: "Theme Switch (light/dark)", component: ThemeDemoPage },
    ],
  },
];

/** Flat list of every demo (route generation). */
export const ALL_DEMOS: readonly DemoEntry[] = DEMO_GROUPS.flatMap((g) => g.demos);

/** Default landing demo slug. */
export const DEFAULT_DEMO_SLUG = "robot-dashboard";
