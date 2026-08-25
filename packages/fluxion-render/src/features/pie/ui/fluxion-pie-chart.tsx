import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";

export interface PieSlice {
  /** Display name for this slice. */
  name: string;
  /** Numeric value. */
  value: number;
  /** Override the default palette color for this slice. */
  fill?: string;
}

export interface FluxionPieChartClassNames {
  /** Outermost wrapper div. */
  root?: string;
  /** Each slice <path> element. */
  slice?: string;
  /** Label <text> element per slice. */
  labelText?: string;
  /** Connector <line> element per slice. */
  labelLine?: string;
  /** Center value <text> (donut only). */
  centerValue?: string;
  /** Center label <text> (donut only). */
  centerLabel?: string;
  /** Tooltip wrapper div. */
  tooltip?: string;
  /** Legend wrapper div. */
  legend?: string;
  /** Individual legend item div. */
  legendItem?: string;
}

export interface FluxionPieChartProps {
  /** Data slices. */
  data: PieSlice[];
  /** Inner radius in px. 0 = solid pie, >0 = donut. Default 0. */
  innerRadius?: number;
  /** Outer radius in px. Default 80. */
  outerRadius?: number;
  /** Gap between slices in degrees. Default 0. */
  paddingAngle?: number;
  /** Start angle in degrees. 90 = 12 o'clock (top). Default 90. */
  startAngle?: number;
  /** End angle in degrees. Default -270 (full circle, clockwise). */
  endAngle?: number;
  /** Rounded corner radius on slice edges in px. Default 0. */
  cornerRadius?: number;
  /** SVG container size in px. Default 200. */
  size?: number;
  /** Color palette used when slice.fill is absent. */
  colors?: string[];
  /**
   * Label rendered on each slice.
   * - `true` or `"name"`: slice name
   * - `"percent"`: "42.3%"
   * - `"value"`: raw numeric value
   * - function: custom string
   */
  label?:
    | boolean
    | "name"
    | "percent"
    | "value"
    | ((slice: PieSlice, percent: number) => string);
  /** Draw a connector line from slice edge to label. Default true when label is set. */
  labelLine?: boolean;
  /** Text shown in the center of a donut chart. */
  centerLabel?: string;
  /** Value/number shown in the center of a donut chart (above centerLabel). */
  centerValue?: string | number;
  /** Show tooltip on hover. Default true. */
  tooltip?: boolean;
  /** Show color+name legend. Default false. */
  legend?: boolean;
  /** Legend placement. Default "bottom". */
  legendPosition?: "bottom" | "right";
  /**
   * Animation duration in ms for enter and update transitions. Default 600.
   * Set to 0 to disable animation.
   */
  animationDuration?: number;
  style?: CSSProperties;
  className?: string;
  classNames?: FluxionPieChartClassNames;
}

const DEFAULT_COLORS = [
  "#4fc3f7",
  "#80ffa0",
  "#ffb060",
  "#ce93d8",
  "#ff7043",
  "#4db6ac",
  "#f48fb1",
  "#aed581",
];

// ── Geometry helpers ─────────────────────────────────────────────────────────
// Exported for unit testing only — not part of the public API.

export function _toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

/** Polar → SVG Cartesian. SVG y-axis points down so we negate sin. */
export function _polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = _toRad(angleDeg);
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

/**
 * Build an SVG path string for a single pie/donut slice.
 * Angles are in degrees: clockwise = decreasing value (12 o'clock = 90°).
 */
export function describeSlice(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startDeg: number,
  endDeg: number,
  cornerR = 0,
): string {
  // Prevent zero-area degenerate paths
  if (Math.abs(endDeg - startDeg) < 0.001) return "";

  const sweep = endDeg < startDeg ? 1 : 0; // clockwise in SVG = sweep-flag 1 when angle decreases
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;

  if (cornerR > 0) {
    // Approximate rounded corners by shortening arc extents slightly
    const cr = Math.min(cornerR, Math.abs((outerR - innerR) / 2) - 1);
    const angleOffset = (cr / outerR) * (180 / Math.PI);
    const s = startDeg - angleOffset * (endDeg < startDeg ? 1 : -1);
    const e = endDeg + angleOffset * (endDeg < startDeg ? 1 : -1);

    const o1 = _polarToXY(cx, cy, outerR, s);
    const o2 = _polarToXY(cx, cy, outerR, e);
    const i1 = _polarToXY(cx, cy, innerR || 0.1, e);
    const i2 = _polarToXY(cx, cy, innerR || 0.1, s);
    const largeFix = Math.abs(e - s) > 180 ? 1 : 0;

    if (innerR === 0) {
      return [
        `M ${cx} ${cy}`,
        `L ${o1.x} ${o1.y}`,
        `A ${outerR} ${outerR} 0 ${largeFix} ${sweep} ${o2.x} ${o2.y}`,
        `a ${cr} ${cr} 0 0 ${sweep} ${cx - o2.x} ${cy - o2.y}`,
        "Z",
      ].join(" ");
    }
    return [
      `M ${o1.x} ${o1.y}`,
      `A ${outerR} ${outerR} 0 ${largeFix} ${sweep} ${o2.x} ${o2.y}`,
      `Q ${cx} ${cy} ${i1.x} ${i1.y}`,
      `A ${innerR} ${innerR} 0 ${largeFix} ${sweep === 0 ? 1 : 0} ${i2.x} ${i2.y}`,
      `Q ${cx} ${cy} ${o1.x} ${o1.y}`,
      "Z",
    ].join(" ");
  }

  const o1 = _polarToXY(cx, cy, outerR, startDeg);
  const o2 = _polarToXY(cx, cy, outerR, endDeg);

  if (innerR === 0) {
    // Solid pie slice
    return [
      `M ${cx} ${cy}`,
      `L ${o1.x} ${o1.y}`,
      `A ${outerR} ${outerR} 0 ${large} ${sweep} ${o2.x} ${o2.y}`,
      "Z",
    ].join(" ");
  }

  // Donut slice
  const i1 = _polarToXY(cx, cy, innerR, endDeg);
  const i2 = _polarToXY(cx, cy, innerR, startDeg);
  return [
    `M ${o1.x} ${o1.y}`,
    `A ${outerR} ${outerR} 0 ${large} ${sweep} ${o2.x} ${o2.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${innerR} ${innerR} 0 ${large} ${sweep === 0 ? 1 : 0} ${i2.x} ${i2.y}`,
    "Z",
  ].join(" ");
}

// ── Easing ───────────────────────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

// ── Animation hook ────────────────────────────────────────────────────────────
//
// Handles both enter (mount) and update (data change) transitions.
// Returns interpolated angle ranges that components use directly for rendering.

interface AngleRange {
  sliceStart: number;
  sliceEnd: number;
}

function usePieAnimation(
  targets: AngleRange[],
  startAngle: number,
  duration: number,
): AngleRange[] {
  // Start collapsed (all slices at startAngle) so enter animation can play.
  const animRef = useRef<AngleRange[]>(
    targets.map(() => ({ sliceStart: startAngle, sliceEnd: startAngle })),
  );
  const [, forceRender] = useState(0);
  const fromRef = useRef<AngleRange[]>(animRef.current);
  const rafRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  // Tracks the last target key that was handed to a running/completed animation.
  const prevKeyRef = useRef<string>("");

  const targetKey = targets
    .map((r) => `${r.sliceStart.toFixed(3)},${r.sliceEnd.toFixed(3)}`)
    .join("|");

  function runAnimation(from: AngleRange[], to: AngleRange[]) {
    fromRef.current = from;
    startTimeRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    function tick(now: number) {
      if (startTimeRef.current === null) startTimeRef.current = now;
      const elapsed = now - startTimeRef.current;
      const t = easeOutCubic(Math.min(elapsed / duration, 1));

      animRef.current = to.map((target, i) => {
        /* v8 ignore start -- from/to always have equal length; defensive fallback */
        const f = from[i] ?? {
          sliceStart: target.sliceStart,
          sliceEnd: target.sliceStart,
        };
        /* v8 ignore stop */
        return {
          sliceStart: f.sliceStart + (target.sliceStart - f.sliceStart) * t,
          sliceEnd: f.sliceEnd + (target.sliceEnd - f.sliceEnd) * t,
        };
      });

      forceRender((n) => n + 1);

      if (elapsed < duration) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        animRef.current = to;
        rafRef.current = null;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }

  // ── Enter animation (mount only) ────────────────────────────────────────
  // Runs once on mount. StrictMode fires cleanup+remount in dev, which means
  // the enter animation replays on the remount — acceptable: prod is unaffected.
  useEffect(() => {
    if (duration <= 0) {
      animRef.current = targets;
      prevKeyRef.current = targetKey;
      forceRender((n) => n + 1);
      return;
    }
    const collapsed = targets.map(() => ({
      sliceStart: startAngle,
      sliceEnd: startAngle,
    }));
    animRef.current = collapsed;
    prevKeyRef.current = targetKey;
    runAnimation(collapsed, targets);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // Intentionally empty deps: this effect must run on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Update animation (data change) ─────────────────────────────────────
  useEffect(() => {
    // Skip on first run (enter effect handles it) and when nothing changed.
    if (prevKeyRef.current === "" || targetKey === prevKeyRef.current) return;
    prevKeyRef.current = targetKey;

    if (duration <= 0) {
      animRef.current = targets;
      forceRender((n) => n + 1);
      return;
    }

    runAnimation(
      animRef.current.map((r) => ({ ...r })),
      targets,
    );
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  return animRef.current;
}

// ── Label text helper ────────────────────────────────────────────────────────

function resolveLabel(
  prop: FluxionPieChartProps["label"],
  slice: PieSlice,
  percent: number,
): string | null {
  if (!prop) return null;
  if (prop === true || prop === "name") return slice.name;
  if (prop === "percent") return `${percent.toFixed(1)}%`;
  if (prop === "value") return String(slice.value);
  if (typeof prop === "function") return prop(slice, percent);
  return null;
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipState {
  idx: number;
  x: number;
  y: number;
}

function Tooltip({
  state,
  data,
  total,
  colors,
  className,
}: {
  state: TooltipState;
  data: PieSlice[];
  total: number;
  colors: string[];
  className?: string;
}) {
  const slice = data[state.idx];
  if (!slice) return null;
  /* v8 ignore start -- a hovered slice implies total > 0 */
  const pct = total > 0 ? (slice.value / total) * 100 : 0;
  /* v8 ignore stop */
  const fill = slice.fill ?? colors[state.idx % colors.length];

  if (className) {
    return (
      <div
        className={className}
        style={{
          position: "fixed",
          left: state.x + 12,
          top: state.y - 10,
          pointerEvents: "none",
          zIndex: 9999,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: fill,
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600 }}>{slice.name}</span>
        </div>
        <div style={{ paddingLeft: 14 }}>
          {slice.value} &nbsp;·&nbsp; {pct.toFixed(1)}%
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: state.x + 12,
        top: state.y - 10,
        pointerEvents: "none",
        background: "rgba(20,24,36,0.92)",
        color: "#fff",
        fontSize: 12,
        padding: "6px 10px",
        borderRadius: 5,
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        zIndex: 9999,
        whiteSpace: "nowrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: fill,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600 }}>{slice.name}</span>
      </div>
      <div style={{ color: "rgba(255,255,255,0.75)", paddingLeft: 14 }}>
        {slice.value} &nbsp;·&nbsp; {pct.toFixed(1)}%
      </div>
    </div>
  );
}

// ── Legend ───────────────────────────────────────────────────────────────────

function Legend({
  data,
  colors,
  position,
  className,
  itemClassName,
}: {
  data: PieSlice[];
  colors: string[];
  position: "bottom" | "right";
  className?: string;
  itemClassName?: string;
}) {
  const isBottom = position === "bottom";
  const defaultStyle: CSSProperties = {
    display: "flex",
    flexDirection: isBottom ? "row" : "column",
    flexWrap: isBottom ? "wrap" : "nowrap",
    gap: isBottom ? "6px 14px" : 6,
    justifyContent: isBottom ? "center" : "flex-start",
    alignItems: isBottom ? "center" : "flex-start",
    padding: isBottom ? "8px 0 0" : "0 0 0 12px",
    fontSize: 11,
  };

  return (
    <div className={className} style={className ? undefined : defaultStyle}>
      {data.map((slice, i) => {
        const fill = slice.fill ?? colors[i % colors.length];
        return (
          <div
            key={slice.name}
            className={itemClassName}
            style={
              itemClassName
                ? undefined
                : { display: "flex", alignItems: "center", gap: 5 }
            }
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: fill,
                flexShrink: 0,
              }}
            />
            <span
              style={itemClassName ? undefined : { color: "#444", whiteSpace: "nowrap" }}
            >
              {slice.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function FluxionPieChart({
  data,
  innerRadius = 0,
  outerRadius = 80,
  paddingAngle = 0,
  startAngle = 90,
  endAngle = -270,
  cornerRadius = 0,
  size = 200,
  colors = DEFAULT_COLORS,
  label,
  labelLine,
  centerLabel,
  centerValue,
  tooltip = true,
  legend = false,
  legendPosition = "bottom",
  animationDuration = 600,
  style,
  className,
  classNames = {},
}: FluxionPieChartProps) {
  const [hovered, setHovered] = useState<TooltipState | null>(null);

  const validData = data.filter((s) => s.value > 0);
  const total = validData.reduce((sum, s) => sum + s.value, 0);

  // Compute per-slice angles
  const totalSweep = endAngle - startAngle; // negative for clockwise
  const n = validData.length;
  const totalPad = paddingAngle * n;
  const usableSweep = totalSweep - (totalSweep < 0 ? -totalPad : totalPad);

  const slices = validData.map((slice) => {
    const idx = data.indexOf(slice); // preserve original color index
    /* v8 ignore start -- slices only exist when validData is non-empty ⟹ total > 0 */
    const fraction = total > 0 ? slice.value / total : 0;
    /* v8 ignore stop */
    return { slice, idx, fraction };
  });

  // Build target angle ranges (final positions)
  let cursor = startAngle;
  const targetRanges = slices.map(({ slice, idx, fraction }) => {
    const sweep = fraction * usableSweep;
    const pad = paddingAngle * (totalSweep < 0 ? -1 : 1);
    const sliceStart = cursor;
    const sliceEnd = cursor + sweep;
    cursor = sliceEnd + pad;
    return { slice, idx, fraction, sliceStart, sliceEnd };
  });

  // Animated angle ranges (interpolated between previous and target)
  const animatedRanges = usePieAnimation(
    targetRanges.map(({ sliceStart, sliceEnd }) => ({ sliceStart, sliceEnd })),
    startAngle,
    animationDuration,
  );

  const showLabel = !!label;
  const showLabelLine = labelLine ?? showLabel;
  const labelR = outerRadius * 1.2;
  const labelLineInnerR = outerRadius * 1.03;
  const labelLineOuterR = outerRadius * 1.12;

  // SVG needs extra room for labels
  const svgPad = showLabel ? outerRadius * 0.35 : 8;
  const svgSize = size + svgPad * 2;
  const svgCx = svgSize / 2;
  const svgCy = svgSize / 2;

  const containerStyle: CSSProperties =
    legendPosition === "right"
      ? { display: "inline-flex", alignItems: "center", ...style }
      : {
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          ...style,
        };

  return (
    <div className={classNames.root ?? className} style={containerStyle}>
      <div style={{ position: "relative" }}>
        <svg
          width={svgSize}
          height={svgSize}
          viewBox={`0 0 ${svgSize} ${svgSize}`}
          style={{ display: "block", overflow: "visible" }}
        >
          {/* Slices */}
          {targetRanges.map(({ slice, idx, fraction }, i) => {
            /* v8 ignore start -- animatedRanges length always matches targetRanges */
            const animated = animatedRanges[i] ?? {
              sliceStart: startAngle,
              sliceEnd: startAngle,
            };
            /* v8 ignore stop */
            const fill = slice.fill ?? colors[idx % colors.length] ?? colors[0];
            const isHovered = hovered?.idx === idx;
            const d = describeSlice(
              svgCx,
              svgCy,
              innerRadius,
              outerRadius,
              animated.sliceStart,
              animated.sliceEnd,
              cornerRadius,
            );
            if (!d) return null;

            const midAngle = (animated.sliceStart + animated.sliceEnd) / 2;
            const percent = fraction * 100;
            const labelText = resolveLabel(label, slice, percent);

            const lp = _polarToXY(svgCx, svgCy, labelR, midAngle);
            const llInner = _polarToXY(svgCx, svgCy, labelLineInnerR, midAngle);
            const llOuter = _polarToXY(svgCx, svgCy, labelLineOuterR, midAngle);

            return (
              <g key={slice.name}>
                <path
                  d={d}
                  fill={fill}
                  opacity={isHovered ? 0.82 : 1}
                  stroke="#fff"
                  strokeWidth={1}
                  className={classNames.slice}
                  style={{
                    cursor: tooltip ? "pointer" : "default",
                    transition: "opacity 0.15s",
                  }}
                  onMouseEnter={(e: MouseEvent) => {
                    if (tooltip) setHovered({ idx, x: e.clientX, y: e.clientY });
                  }}
                  onMouseMove={(e: MouseEvent) => {
                    if (tooltip && hovered)
                      setHovered({ idx, x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => setHovered(null)}
                />
                {showLabelLine && labelText && (
                  <line
                    x1={llInner.x}
                    y1={llInner.y}
                    x2={llOuter.x}
                    y2={llOuter.y}
                    stroke={fill}
                    strokeWidth={1.2}
                    opacity={0.7}
                    className={classNames.labelLine}
                  />
                )}
                {labelText && (
                  <text
                    x={lp.x}
                    y={lp.y}
                    textAnchor={
                      lp.x < svgCx - 2 ? "end" : lp.x > svgCx + 2 ? "start" : "middle"
                    }
                    dominantBaseline="middle"
                    fontSize={11}
                    fill={classNames.labelText ? undefined : "#333"}
                    className={classNames.labelText}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {labelText}
                  </text>
                )}
              </g>
            );
          })}

          {/* Donut center text */}
          {innerRadius > 0 && (centerValue !== undefined || centerLabel) && (
            <g>
              {centerValue !== undefined && (
                <text
                  x={svgCx}
                  y={svgCy - (centerLabel ? 9 : 0)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={innerRadius * 0.38}
                  fontWeight="700"
                  fontFamily="monospace"
                  fill={classNames.centerValue ? undefined : "#222"}
                  className={classNames.centerValue}
                >
                  {centerValue}
                </text>
              )}
              {centerLabel && (
                <text
                  x={svgCx}
                  y={svgCy + (centerValue !== undefined ? 12 : 0)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11}
                  fill={classNames.centerLabel ? undefined : "#888"}
                  fontFamily="sans-serif"
                  className={classNames.centerLabel}
                >
                  {centerLabel}
                </text>
              )}
            </g>
          )}
        </svg>

        {/* Tooltip overlay */}
        {tooltip && hovered && (
          <Tooltip
            state={hovered}
            data={data}
            total={total}
            colors={colors}
            className={classNames.tooltip}
          />
        )}
      </div>

      {/* Legend */}
      {legend && (
        <Legend
          data={validData}
          colors={colors}
          position={legendPosition}
          className={classNames.legend}
          itemClassName={classNames.legendItem}
        />
      )}
    </div>
  );
}
