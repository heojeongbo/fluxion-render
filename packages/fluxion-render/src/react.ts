// React entry. A superset of the framework-agnostic core (`export *` below) plus
// the React hooks and components. Everything importable from
// `@heojeongbo/fluxion-render` is also importable here, so `/react` consumers can
// name core types (layer configs, protocol messages, etc.) without a second import.

export {
  type BrushSelection,
  FluxionBrush,
  type FluxionBrushProps,
  type UseFluxionBrushOptions,
  type UseFluxionBrushResult,
  useFluxionBrush,
} from "./features/brush";
export {
  type CrosshairPoint,
  type CrosshairState,
  FluxionCrosshair,
  FluxionCrosshairOverlay,
  type FluxionCrosshairOverlayProps,
  type FluxionCrosshairProps,
  type UseBroadcastCrosshairCacheOptions,
  type UseBroadcastCrosshairCacheResult,
  type UseFluxionCrosshairFromLayersOptions,
  type UseFluxionCrosshairFromLayersResult,
  type UseFluxionCrosshairOptions,
  type UseFluxionCrosshairResult,
  type UseHoverDataCacheOptions,
  type UseHoverDataCacheResult,
  useBroadcastCrosshairCache,
  useFluxionCrosshair,
  useFluxionCrosshairFromLayers,
  useHoverDataCache,
} from "./features/crosshair";
export {
  type UseFluxionExportOptions,
  type UseFluxionExportResult,
  useFluxionExport,
} from "./features/export";
export {
  FluxionGauge,
  type FluxionGaugeClassNames,
  type FluxionGaugeProps,
  type GaugeThreshold,
  type UseFluxionGaugeOptions,
  type UseFluxionGaugeResult,
  useFluxionGauge,
} from "./features/gauge";
export {
  FluxionPieChart,
  type FluxionPieChartClassNames,
  type FluxionPieChartProps,
  type PieSlice,
} from "./features/pie";
export {
  type UseSyncedTimeWindowResult,
  useSyncedTimeWindow,
  useTimeOrigin,
} from "./features/synced-time";
export * from "./index";
export {
  type BadgeTone,
  type CapacityAdvisory,
  checkCapacity,
  configureLifecycleScheduler,
  configureOnScreenObserver,
  FluxionCanvas,
  type FluxionCanvasHandle,
  type FluxionCanvasProps,
  FluxionLegend,
  type FluxionLegendClassNames,
  type FluxionLegendProps,
  FluxionTable,
  type FluxionTableClassNames,
  type FluxionTableColumn,
  type FluxionTableProps,
  getLifecycleStats,
  type LegendItem,
  type LifecycleSchedulerStats,
  legendFromLayers,
  type OnScreenObserveOptions,
  type ResizeInfo,
  Sparkline,
  type SparklineProps,
  subscribeTicker,
  TableCellBadge,
  type TableCellBadgeProps,
  type UseFluxionCanvasOptions,
  type UseFluxionCanvasResult,
  type UseFluxionHistoricalOptions,
  type UseFluxionStreamOptions,
  type UseFluxionStreamResult,
  type UseFluxionTableOptions,
  type UseFluxionTableResult,
  type UseStaggeredMountOptions,
  useAxisTicks,
  useFluxionCanvas,
  useFluxionHistorical,
  useFluxionStream,
  useFluxionTable,
  useFluxionWorkerPool,
  useHostRecyclePool,
  useLayerConfig,
  useLayersConfig,
  useResizeObserver,
  useSharedTicker,
  useStaggeredMount,
  useXAxisCanvas,
  useYAxisCanvas,
} from "./widgets/fluxion-canvas";
export {
  type UseMiniChartOptions,
  type UseMiniChartResult,
  useMiniChart,
} from "./widgets/mini-chart/lib/use-mini-chart";
export {
  type MultiSeries,
  type UseMultiSeriesChartOptions,
  type UseMultiSeriesChartResult,
  useMultiSeriesChart,
} from "./widgets/multi-series-chart/lib/use-multi-series-chart";
export {
  type UseSimpleChartOptions,
  type UseSimpleChartResult,
  useSimpleChart,
} from "./widgets/simple-chart/lib/use-simple-chart";
