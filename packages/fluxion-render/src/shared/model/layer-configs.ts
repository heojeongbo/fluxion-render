import type { XTickFormat, YTickFormat } from "../lib/axis-ticks";
import type { ColormapName } from "../lib/colormap";

export interface OccupancyGridConfig {
  /**
   * Color for occupied cells (probability 100), CSS hex. Free cells (0) fade to
   * `freeColor`. Default "#1a1a1a" (dark = occupied, matching ROS rviz).
   */
  occupiedColor?: string;
  /** Color for free cells (probability 0), CSS hex. Default "#e0e0e0". */
  freeColor?: string;
  /** Color for unknown cells (value < 0). Default "#808080" (grey). */
  unknownColor?: string;
  /** Draw a 1px outline around each cell (grid lines). Default false. */
  showGridLines?: boolean;
  /** Grid line color when `showGridLines` is on. Default "rgba(0,0,0,0.15)". */
  gridLineColor?: string;
  visible?: boolean;
}

export interface LidarScatterConfig {
  /** Floats per point. Default 4 (x,y,z,intensity). Minimum 2 (x,y). */
  stride?: number;
  /** Point size in pixels. */
  pointSize?: number;
  /** Max intensity value for normalization (0..1). Default 1.0. */
  intensityMax?: number;
  /** Solid color override. When set, intensity LUT is ignored. */
  color?: string;
}

export interface AreaChartConfig {
  color?: string;
  /** Fill opacity [0,1]. Default 0.2. */
  fillOpacity?: number;
  lineWidth?: number;
  capacity?: number;
  retentionMs?: number;
  maxHz?: number;
  visible?: boolean;
  /**
   * Min/max-decimate both the fill and the outline stroke to ~2–4 points per
   * x-pixel column when oversampled (visible samples > 2×width), cutting draw
   * cost from O(samples) to O(width). The fill still closes to the baseline per
   * gap-segment and the envelope is preserved at display resolution. The ring
   * keeps every sample (hover/scan/export unaffected). Tri-state: omitted =
   * AUTO (decimate iff oversampled), `true` = same as auto, `false` = always
   * draw every sample. Default auto.
   */
  decimate?: boolean;
  /**
   * Maximum allowed time gap (ms) between consecutive samples before the
   * area is broken: the current fill polygon closes to the baseline and a
   * new one starts after the gap (the stroke breaks too). Undefined
   * (default) keeps the current behavior: one continuous area.
   */
  maxGapMs?: number;
  /**
   * Canvas `setLineDash` pattern for the outline STROKE, in CSS px. Default
   * `[]` (solid). The fill is never dashed. Use it to tell apart series whose
   * values overlap. Visual only: data, hover, and auto-scaling are unaffected.
   */
  dashArray?: number[];
  /**
   * Vertical offset added to every y at DRAW time, in DATA units. Default 0.
   * Lifts the whole area (fill + outline) up/down to separate overlapping
   * series. `scan()` widens the observed y-range so `yMode: "auto"` fits it.
   * Visual only: hover, export, and the underlying samples are unaffected.
   * Ignored in lane mode (see `laneCount`).
   */
  yOffset?: number;
  /**
   * Lane (small-multiples) mode. When `laneCount >= 1`, the area is drawn into
   * band `laneIndex` of `laneCount`, auto-normalized to its OWN visible y-range
   * (fill runs to the band's bottom). The shared y-axis no longer applies.
   * `yOffset` is ignored while active. Default off. See `LineChartConfig`.
   */
  laneIndex?: number;
  /** Total number of lanes. See {@link laneIndex}. Default 0 (off). */
  laneCount?: number;
  /** Gap between adjacent lanes, in CSS px. Default 6. */
  laneGapPx?: number;
}

export interface ScatterChartConfig {
  /** Point color. Default "#4fc3f7". */
  color?: string;
  /** Point size in pixels. Default 3. */
  pointSize?: number;
  /** Point shape. Default "square". */
  shape?: "square" | "circle";
  /** Ring buffer capacity (number of [t,y] samples retained). Default 2048. */
  capacity?: number;
  /** Data retention window in ms. Combined with maxHz to auto-calculate capacity. */
  retentionMs?: number;
  /** Expected max sample rate in Hz. Combined with retentionMs to auto-calculate capacity. */
  maxHz?: number;
  /** When false, skip draw and scan. Default true. */
  visible?: boolean;
  /**
   * Thin the drawn points to ~2 per x-pixel column (the column's min-y and
   * max-y sample) when oversampled (visible samples > 2×width), cutting draw
   * cost from O(samples) to O(width). The visible distribution envelope is
   * preserved at display resolution; the ring keeps every sample
   * (hover/scan/export unaffected). Tri-state: omitted = AUTO (thin iff
   * oversampled), `true` = same as auto, `false` = always draw every point.
   * Default auto.
   */
  decimate?: boolean;
  /**
   * Global point opacity in `[0, 1]`. Default 1 (opaque). Multiplies the canvas
   * alpha for this layer's points only; saved/restored so it never leaks into
   * other layers. Visual only — data/hover/scaling are unaffected.
   */
  opacity?: number;
}

export interface PolarConfig {
  /** Line/marker color (CSS). Default "#4fc3f7". */
  color?: string;
  /** Line width in CSS px. Default 1.5. */
  lineWidth?: number;
  /** Fill the polygon under the trace with `color` at this opacity. 0 = no fill. Default 0. */
  fillOpacity?: number;
  /**
   * Radius value mapped to the outer edge. When omitted, auto-scales to the
   * largest `r` in the data each frame.
   */
  rMax?: number;
  /** Connect the last point back to the first (closed radar/rose). Default true. */
  closed?: boolean;
  /** Draw a filled dot at each vertex. Default false. */
  showPoints?: boolean;
  /** Point radius in CSS px when `showPoints`. Default 3. */
  pointSize?: number;
  /** Draw concentric radial grid rings. Default true. */
  showRings?: boolean;
  /** Number of grid rings when `showRings`. Default 4. */
  ringCount?: number;
  /** Grid color for rings/spokes. Default "rgba(255,255,255,0.12)". */
  gridColor?: string;
  /** Inset from the canvas edge in CSS px, reserving room for labels. Default 8. */
  insetPx?: number;
  visible?: boolean;
}

export interface ReferenceLineConfig {
  /** Y data value at which to draw the reference line. */
  y: number;
  /** Lower bound of the tolerance band (drawn as a shaded rect). */
  bandMin?: number;
  /** Upper bound of the tolerance band. */
  bandMax?: number;
  /** Line color. Default "#4fc3f7". */
  color?: string;
  /** Line width in pixels. Default 1.5. */
  lineWidth?: number;
  /** Label shown at the right edge. */
  label?: string;
  /** Band fill opacity (0–1). Default 0.12. */
  bandOpacity?: number;
  /** When false, skip draw. Default true. */
  visible?: boolean;
}

export interface BarChartConfig {
  color?: string;
  /** Bar width in CSS pixels. Default 8. */
  barWidth?: number;
  /** "xy" = [x,y,x,y,...] interleaved; "y" = [y0,y1,...] with x inferred from xRange. */
  layout?: "xy" | "y";
  /** X range for "y" layout: [xMin, xMax]. Bars are evenly spaced. */
  xRange?: [number, number];
  visible?: boolean;
}

export interface PoseArrowConfig {
  /** Arrow body length in pixels. Default 14. */
  arrowLength?: number;
  /** Arrowhead half-width in pixels. Default 5. */
  arrowWidth?: number;
  /** Arrow color. Default "#80ffa0". */
  color?: string;
  /** Ring buffer capacity. */
  capacity?: number;
  /** Retention window in ms. Combined with maxHz to auto-calculate capacity. */
  retentionMs?: number;
  /** Expected max sample rate in Hz. */
  maxHz?: number;
  /** When false, skip draw and scan. Default true. */
  visible?: boolean;
}

export interface CurrentTimeConfig {
  /** Host-relative milliseconds for a replay playhead. null (default) follows the clock. */
  currentTime?: number | null;
  /** Epoch milliseconds corresponding to x=0. Required for live clock mode. */
  timeOrigin?: number;
  /** Bar color. Default "#ff5252". */
  color?: string;
  /** Bar width in CSS pixels. Default 2; minimum 0.5. */
  lineWidth?: number;
  /** Hide the bar and stop its continuous rendering. Default true. */
  visible?: boolean;
}

export interface TrajectoryConfig {
  /** Polyline / point color when `colorByTime` is off (CSS). Default "#4fc3f7". */
  color?: string;
  /** Line width in CSS px. Default 1.5. */
  lineWidth?: number;
  /**
   * Color the path by sample age using a colormap LUT instead of a solid
   * `color`. Oldest → 0, newest → 1. Default false.
   */
  colorByTime?: boolean;
  /** Colormap for `colorByTime`. Default "viridis". */
  colormap?: ColormapName;
  /** Draw a filled marker at the most recent point (current pose). Default true. */
  headMarker?: boolean;
  /** Head marker radius in CSS px. Default 4. */
  headMarkerSize?: number;
  /**
   * Fade samples older than this many ms before the latest sample (linear alpha
   * ramp to 0). 0 disables fading. Default 0.
   */
  fadeOlderMs?: number;
  /** Ring buffer capacity in points. Default 4096. */
  capacity?: number;
  /** Data retention window in ms. Combined with maxHz to auto-size capacity. */
  retentionMs?: number;
  /** Expected max sample rate in Hz (auto-sizes capacity with retentionMs). */
  maxHz?: number;
  /** When false, skip scan and draw. Default true. */
  visible?: boolean;
}

export interface HistogramConfig {
  /** Bar fill color (CSS). Default "#4fc3f7". */
  color?: string;
  /** Number of bins. Default 20. */
  binCount?: number;
  /**
   * Fixed value range `[min, max]` to bin over. When omitted, the range is
   * auto-computed from the data on each `setData`.
   */
  range?: [number, number];
  /**
   * Normalize counts to a 0–1 density (each bar = count / total) instead of raw
   * counts. Default false.
   */
  density?: boolean;
  /** Gap between bars in CSS px. Default 1. */
  gapPx?: number;
  visible?: boolean;
}

export interface CandlestickConfig {
  /** Candle color when close >= open. Default "#26a69a". */
  upColor?: string;
  /** Candle color when close < open. Default "#ef5350". */
  downColor?: string;
  /** Body width in CSS pixels. Default 6. */
  bodyWidth?: number;
  capacity?: number;
  retentionMs?: number;
  maxHz?: number;
  visible?: boolean;
}

export interface StackedAreaConfig {
  /**
   * Number of stacked series per sample. Required — sets the data stride to
   * `seriesCount + 1` (`[t, y0, y1, …]`). Changing it resets the ring buffer.
   */
  seriesCount?: number;
  /** Per-series fill colors (CSS). Cycles if shorter than `seriesCount`. */
  colors?: string[];
  /** Fill opacity [0,1]. Default 0.85. */
  fillOpacity?: number;
  /** Outline width in CSS px between bands. Default 0 (no outline). */
  lineWidth?: number;
  /**
   * Normalize each sample's stack to 100% (percent-stacked). Bands then show
   * composition rather than absolute totals. Default false.
   */
  normalize?: boolean;
  /** Ring buffer capacity in samples. Default 2048. */
  capacity?: number;
  /** Data retention window in ms (auto-sizes capacity with maxHz). */
  retentionMs?: number;
  /** Expected max sample rate in Hz (auto-sizes capacity with retentionMs). */
  maxHz?: number;
  visible?: boolean;
}

export interface EventMarkerConfig {
  /** Colors per severity level: [info, warning, error]. Defaults: ["#4fc3f7","#ffb060","#ff5252"]. */
  colors?: [string, string, string];
  /** Line width in pixels. Default 1. */
  lineWidth?: number;
  /** Triangle marker height in pixels. Default 8. */
  markerSize?: number;
  /** When false, skip draw. Default true. */
  visible?: boolean;
}

export interface ScatterColoredConfig {
  /**
   * Colormap for the `colorValue` channel (0–1 normalised).
   * "gradient" uses `minColor`→`maxColor` linear interpolation.
   * Default "viridis".
   */
  colormap?: "viridis" | "plasma" | "hot" | "gradient";
  /** Start color for "gradient" colormap (CSS hex). Default "#0000ff". */
  minColor?: string;
  /** End color for "gradient" colormap (CSS hex). Default "#ff0000". */
  maxColor?: string;
  /** Minimum point size in pixels mapped to colorValue=0. Default 2. */
  minSize?: number;
  /** Maximum point size in pixels mapped to colorValue=1. Default 8. */
  maxSize?: number;
  /** Point shape. Default "circle". */
  shape?: "square" | "circle";
  /** Ring buffer capacity. Default 4096. */
  capacity?: number;
  /** Data retention window in ms. Combined with maxHz to auto-calculate capacity. */
  retentionMs?: number;
  /** Expected max sample rate in Hz. */
  maxHz?: number;
  /** When false, skip draw and scan. Default true. */
  visible?: boolean;
}

export interface StepChartConfig {
  color?: string;
  lineWidth?: number;
  capacity?: number;
  retentionMs?: number;
  maxHz?: number;
  visible?: boolean;
  /**
   * Min/max-decimate the DRAW path to ~2–4 points per x-pixel column when
   * oversampled (visible samples > 2×width), cutting draw cost from O(samples)
   * to O(width). At sub-pixel density the staircase is indistinguishable from
   * the decimated path. The ring still holds every sample (hover/scan/export
   * unaffected). Tri-state: omitted = AUTO (decimate iff oversampled), `true` =
   * same as auto, `false` = always draw every sample. Default auto.
   */
  decimate?: boolean;
  /**
   * Maximum allowed time gap (ms) between consecutive samples before the
   * staircase is broken: the bridging horizontal+vertical segments are
   * skipped and a new subpath starts after the gap. Undefined (default)
   * keeps the current behavior: each value holds until the next sample.
   */
  maxGapMs?: number;
  /**
   * Canvas `setLineDash` pattern for the stroke, in CSS px. Default `[]`
   * (solid). Use it to tell apart series whose values overlap. Visual only:
   * data, hover, and auto-scaling are unaffected.
   */
  dashArray?: number[];
  /**
   * Vertical offset added to every y at DRAW time, in DATA units. Default 0.
   * Shifts the staircase up/down to separate overlapping series. `scan()`
   * widens the observed y-range so `yMode: "auto"` fits it. Visual only:
   * hover, export, and the underlying samples are unaffected. Ignored in lane
   * mode (see `laneCount`).
   */
  yOffset?: number;
  /**
   * Lane (small-multiples) mode. When `laneCount >= 1`, the staircase is drawn
   * into band `laneIndex` of `laneCount`, auto-normalized to its OWN visible
   * y-range. The shared y-axis no longer applies and `yOffset` is ignored.
   * Default off. See `LineChartConfig`.
   */
  laneIndex?: number;
  /** Total number of lanes. See {@link laneIndex}. Default 0 (off). */
  laneCount?: number;
  /** Gap between adjacent lanes, in CSS px. Default 6. */
  laneGapPx?: number;
}

export interface HeatmapStreamConfig {
  /**
   * Number of y-bins (rows) in the heatmap grid.
   * Must match the length of each column pushed via the handle. Default 32.
   */
  yBins?: number;
  /**
   * Number of time columns to keep (ring buffer width). Default 256.
   * Columns older than `maxCols` are evicted.
   */
  maxCols?: number;
  /** Y range of the grid: [yMin, yMax]. Default [0, 1]. */
  yRange?: [number, number];
  colormap?: "viridis" | "plasma" | "hot";
  /** Value mapped to the cold end of the colormap. Default: auto (data min). */
  minValue?: number;
  /** Value mapped to the hot end of the colormap. Default: auto (data max). */
  maxValue?: number;
  /** When false, skip draw. Default true. */
  visible?: boolean;
}

export interface BoxPlotConfig {
  /** Box fill color (CSS). Default "#4fc3f7". */
  color?: string;
  /** Box fill opacity [0,1]. Default 0.35. */
  fillOpacity?: number;
  /** Box / whisker line color. Default "#e2e8f0". */
  lineColor?: string;
  /** Box width in CSS pixels. Default 24. */
  boxWidth?: number;
  /** Line width in CSS px for the box, median, and whiskers. Default 1.5. */
  lineWidth?: number;
  /** Whisker cap width as a fraction of `boxWidth` [0,1]. Default 0.5. */
  capRatio?: number;
  visible?: boolean;
}

export interface LineChartStaticConfig {
  color?: string;
  lineWidth?: number;
  /**
   * Data layout:
   * - "xy" (default): interleaved [x,y,x,y,...] stride=2
   * - "y": [y0,y1,...] with implicit x = linear sweep across `viewport.bounds.x`
   */
  layout?: "xy" | "y";
}

export interface LineChartConfig {
  color?: string;
  lineWidth?: number;
  /** Ring buffer capacity (number of [t,y] samples retained). Default 2048. */
  capacity?: number;
  /** Data retention window in ms. Combined with maxHz to auto-calculate capacity. */
  retentionMs?: number;
  /** Expected max sample rate in Hz. Combined with retentionMs to auto-calculate capacity. */
  maxHz?: number;
  /** When false, skip draw and scan. Default true. */
  visible?: boolean;
  /**
   * Min/max-decimate the DRAW path to ~2–4 points per x-pixel column when there
   * are more visible samples than pixels — keeping the rendered line visually
   * identical (every peak/trough at display resolution is preserved) while
   * cutting `lineTo` calls from O(samples) to O(width). The ring still holds
   * EVERY sample, so hover/scan/export are unaffected.
   *
   * Tri-state:
   *   - omitted (default) → AUTO: decimate only when oversampled (visible
   *     samples > 2×width). Cheap, lossless, and the right default for
   *     high-rate (e.g. 500 Hz) streams.
   *   - `true`  → decimate whenever oversampled (same effect as auto).
   *   - `false` → never decimate; always draw every sample (debugging).
   */
  decimate?: boolean;
  /**
   * Maximum allowed time gap (ms) between consecutive samples before the
   * stroke is broken (a new subpath starts instead of a bridging line).
   * Lets bursty / intermittent streams show genuine discontinuities rather
   * than a diagonal connecting across the silence. Undefined (default)
   * keeps the current behavior: every visible sample is connected.
   */
  maxGapMs?: number;
  /**
   * Canvas `setLineDash` pattern for the stroke, in CSS px. Default `[]`
   * (solid). Use it to tell apart series whose values overlap — e.g.
   * `[6, 4]` draws a dashed line that stays distinguishable even when it sits
   * exactly on top of another series. Visual only: data, hover, and
   * auto-scaling are unaffected.
   */
  dashArray?: number[];
  /**
   * Vertical offset added to every y at DRAW time, in DATA units. Default 0.
   * Shifts this series' stroke up/down so overlapping series spread out
   * vertically (waterfall). `scan()` widens the observed y-range by the same
   * amount, so `yMode: "auto"` grows to fit and never clips the shifted line.
   * Visual only: hover, export, and the underlying samples are unaffected.
   * Ignored in lane mode (see `laneCount`).
   */
  yOffset?: number;
  /**
   * Lane (small-multiples) mode. When `laneCount >= 1`, this layer draws into
   * a horizontal band `laneIndex` of `laneCount`, auto-normalized to ITS OWN
   * visible y-range — so it no longer shares the chart's y-axis. Use it to
   * stack several streams that would otherwise overlap, each readable in its
   * own strip (ECG / oscilloscope style). The shared y-axis becomes
   * meaningless in this mode (suppress it: `yMode:"fixed"`, `showYLabels:false`).
   * `yOffset` is ignored while lane mode is active. Default off.
   */
  laneIndex?: number;
  /** Total number of lanes. See {@link laneIndex}. Default 0 (lane mode off). */
  laneCount?: number;
  /** Gap between adjacent lanes, in CSS px. Default 6. */
  laneGapPx?: number;
  /**
   * Global stroke opacity in `[0, 1]`. Default 1 (fully opaque). Multiplies the
   * canvas alpha for this layer's stroke only — useful to de-emphasize a series
   * or let overlapping lines show through. Visual only: data, hover, and
   * auto-scaling are unaffected. The alpha is saved and restored around the
   * draw so it never leaks into other layers sharing the frame.
   */
  opacity?: number;
}

export interface HeatmapConfig {
  /** Cell width in CSS pixels. Default 8. */
  cellWidth?: number;
  /** Cell height in CSS pixels. Default 8. */
  cellHeight?: number;
  /** Value mapped to the cold end of the colormap. Default: auto (data min). */
  minValue?: number;
  /** Value mapped to the hot end of the colormap. Default: auto (data max). */
  maxValue?: number;
  colormap?: "viridis" | "plasma" | "hot";
  visible?: boolean;
}

export interface AxisGridConfig {
  /** Fixed x-range. Used when `xMode` is "fixed" (default). */
  xRange?: [number, number];
  yRange?: [number, number];
  gridColor?: string;
  /** Grid line width in CSS px. Default 1. */
  gridLineWidth?: number;
  axisColor?: string;
  labelColor?: string;
  font?: string;
  targetTicks?: number;
  /** If true (default), writes this layer's bounds into `viewport` so data layers share them. */
  applyToViewport?: boolean;
  /**
   * "fixed": xRange is literal world units (default).
   * "time": bounds follow the streaming `viewport.latestT` as a trailing
   * sliding window `[latestT - timeWindowMs, latestT]`. yRange is still fixed.
   */
  xMode?: "fixed" | "time";
  /** Width of the sliding window in ms when xMode="time". Default 5000. */
  timeWindowMs?: number;
  /**
   * Absolute wall-clock epoch (ms) corresponding to data timestamp `0`. When
   * set together with `xMode: "time"`, tick labels render as wall clock
   * instead of elapsed seconds. Typically set once at host creation:
   * `timeOrigin: Date.now()` on the main thread.
   */
  timeOrigin?: number;
  /**
   * When true AND `xMode: "time"`, the trailing window's right edge tracks
   * wall-clock time (`Date.now() - timeOrigin`) every frame instead of the
   * data-driven `viewport.latestT`. The axis scrolls continuously even when no
   * stream data arrives; incoming samples (host-relative ms = `Date.now() -
   * timeOrigin` on the producer) land at the correct x. Requires `timeOrigin`
   * to be set — without it the window falls back to `latestT` (no follow).
   * Default false (data-driven, unchanged behavior). The engine starts a
   * continuous render loop while any axis layer has this enabled.
   */
  followClock?: boolean;
  /**
   * Formatter for x tick labels.
   *
   * - **String** clock-pattern (e.g. `"HH:mm:ss"`): used when `xMode: "time"`
   *   AND `timeOrigin` is set. Tokens: `HH / H / mm / m / ss / s / SSS / S`.
   *   Default `"HH:mm:ss"`. Ignored without `timeOrigin` — elapsed-seconds
   *   fallback (`"X.Xs"`) is used instead.
   * - **Object** `{ pattern?, precision?, suffix?, si? }`: serializable, so it
   *   works in EVERY render path — the worker's in-canvas labels, the
   *   external-axis canvas (`externalAxes`), and the React-side tick set. In
   *   time mode with `timeOrigin` and `pattern` it renders wall-clock;
   *   otherwise it formats the raw value numerically (precision/suffix/si).
   *   Use this for non-time axes or worker-drawn numeric labels.
   * - **Function** `(value: number) => string`: called for every tick value
   *   regardless of `xMode`, but CANNOT cross the worker boundary (it is
   *   stripped before postMessage), so it applies on the React side only
   *   (`useAxisTicks`); worker-drawn labels fall back to the raw value. Prefer
   *   the string or object form with `externalAxes`.
   */
  xTickFormat?: XTickFormat;

  // ─── y scaling ────────────────────────────────────────────
  /**
   * "fixed" (default): use configured `yRange`.
   * "auto": data-driven. Reads `viewport.observedYMin/Max` during draw,
   * applies padding and clamps, updates `bounds.yMin/yMax`. Requires at
   * least one data layer (e.g. `LineChartLayer`) in the stack to publish
   * observations via its `scan()` pass.
   */
  yMode?: "fixed" | "auto";
  /** Padding ratio applied above/below the observed range. Default 0.1 (10%). */
  yAutoPadding?: number;
  /** Absolute lower clamp after padding. */
  yAutoMin?: number;
  /** Absolute upper clamp after padding. */
  yAutoMax?: number;
  /**
   * Minimum y span for auto mode. When the padded range is narrower than this
   * value, the range is symmetrically expanded around its midpoint.
   * Applied after `yAutoMin`/`yAutoMax` clamps.
   * Example: `yAutoMinSpan: 0.1` ensures the axis always spans at least 0.1.
   */
  yAutoMinSpan?: number;
  /**
   * Formatter for y tick labels.
   *
   * - **Object** `{ precision?, suffix?, si? }`: serializable, so it works in
   *   EVERY render path — the worker's in-canvas labels, the external-axis
   *   canvas (`externalAxes`), and the React-side tick set. Use this for the
   *   common cases (fixed precision, unit suffix, k/M/G scaling).
   * - **Function** `(value: number) => string`: cannot cross the worker
   *   boundary (it is stripped before postMessage), so it applies on the
   *   React side only (`useAxisTicks`); worker-drawn labels fall back to
   *   `String(value)`. Prefer the object form with `externalAxes`.
   */
  yTickFormat?: YTickFormat;

  // ─── Visual toggles (all default true) ────────────────────
  /** Show vertical grid lines at x ticks. */
  showXGrid?: boolean;
  /** Show horizontal grid lines at y ticks. */
  showYGrid?: boolean;
  /** Show the x=0 / y=0 axis lines when 0 is inside the range. */
  showAxes?: boolean;
  /** Show tick labels along the x axis. */
  showXLabels?: boolean;
  /** Show tick labels along the y axis. */
  showYLabels?: boolean;
  /**
   * Canvas setLineDash pattern for grid lines. Default [] (solid).
   * Example: [3, 3] produces the dashed style used by recharts.
   */
  gridDashArray?: number[];
  /**
   * Fixed x tick interval in ms. When set, overrides `targetTicks` and
   * snaps tick positions to multiples of this value.
   * Example: `xTickIntervalMs: 1000` produces ticks at exactly 1-second boundaries.
   */
  xTickIntervalMs?: number;
  /**
   * Vertical inset in CSS pixels applied to both the chart canvas (via
   * `viewport.yPadPx`) and the external axis canvas (matched constant).
   * Keeps grid lines and data strokes away from the top/bottom edge so
   * external axis tick labels at fraction 0/1 have room to render without
   * clipping. Default 0 (no padding). Set to 8 when using `externalAxes`.
   */
  yPadPx?: number;
}
