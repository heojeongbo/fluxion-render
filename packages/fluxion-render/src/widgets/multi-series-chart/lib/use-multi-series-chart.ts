import { useCallback, useMemo, useRef, useState } from "react";
import type { HoverDataCache } from "../../../features/crosshair";
import type { FluxionHost } from "../../../features/host";
import { useTimeOrigin } from "../../../features/synced-time";
import { dashPatternFor } from "../../../shared/lib/dash-patterns";
import { axisGridLayer, lineLayer } from "../../fluxion-canvas/lib/layer-specs";
import type { FluxionLayerSpec } from "../../fluxion-canvas/lib/use-fluxion-canvas";
import { useFluxionStream } from "../../fluxion-canvas/lib/use-fluxion-stream";

export interface MultiSeries {
  /** Line layer id — must be unique within the chart. */
  id: string;
  /** Line colour. */
  color: string;
  /** Per-tick sampler for THIS series (host-relative `tMs`). */
  sample: (tMs: number) => number | { t: number; y: number };
  /** Stroke width. Default `1.5`. */
  lineWidth?: number;
  /** Human label (legend / crosshair). */
  label?: string;
  /**
   * Explicit `setLineDash` pattern for this series (CSS px). Takes precedence
   * over `distinguishBy: "dash"`. Omit to let it assign one.
   */
  dashArray?: number[];
  /**
   * Explicit vertical offset for this series (DATA units). Takes precedence
   * over `distinguishBy: "offset"`. Omit to let it assign one.
   */
  yOffset?: number;
}

export interface UseMultiSeriesChartOptions {
  /** The series array is the single source of truth for layers + the pump. */
  series: MultiSeries[];
  /** Sample rate (Hz) shared by all series. */
  hz: number;
  /** Visible time window in ms → `axisGridLayer.timeWindowMs`. */
  windowMs: number;
  /** Wall-clock anchor. Defaults to a stable `useTimeOrigin()`. */
  timeOrigin?: number;
  /** Axis layer id. Default `"axis"`. */
  axisLayerId?: string;
  /**
   * How to keep overlapping series distinguishable. Deterministic, color-
   * independent, and skipped for any series that sets the matching field
   * itself. Combine with an array, e.g. `["dash", "offset"]`.
   *
   * - `"dash"`   — each series gets a distinct dash pattern (cycling
   *   {@link dashPatternFor}). Honest about position. Skipped per series that
   *   sets `dashArray`.
   * - `"offset"` — spread series vertically (waterfall), evenly spaced by
   *   `offsetStep` (DATA units). Requires `offsetStep`; without it nothing is
   *   offset and a one-time warning fires. Skipped per series that sets
   *   `yOffset`.
   */
  distinguishBy?: "dash" | "offset" | ("dash" | "offset")[];
  /**
   * Spacing (DATA units) between series when `distinguishBy` includes
   * `"offset"`. Series i is lifted by `i * offsetStep`. Required for the
   * offset mode to do anything (the hook can't know your data scale).
   */
  offsetStep?: number;
  /**
   * `"overlay"` (default): all series share one y-axis. `"lanes"`: each series
   * gets its own horizontal band, auto-normalized to its own range (small
   * multiples / ECG style) — the honest fix when overlapping values make the
   * shared axis useless. In lane mode the shared y-axis is suppressed
   * (`yMode:"fixed"`, no y grid/labels) and `distinguishBy:"offset"` /
   * per-series `yOffset` are ignored (lanes supersede them); `"dash"` still
   * works within each lane.
   */
  layout?: "overlay" | "lanes";
  /** Gap between lanes in CSS px when `layout: "lanes"`. Default 6. */
  laneGapPx?: number;
  /** Override/extend the axis-grid config (merged after the managed fields). */
  axis?: Parameters<typeof axisGridLayer>[1];
  /**
   * Optional hover cache. When provided, each pushed sample is written to the
   * cache under its series id — no manual `cache.push` in the samplers.
   */
  cache?: HoverDataCache;
}

export interface UseMultiSeriesChartResult {
  /** 1 axis-grid + N line layers. Pass to `<FluxionCanvas layers={...} />`. */
  layers: FluxionLayerSpec[];
  host: FluxionHost | null;
  /** Wire to `<FluxionCanvas onReady={setHost} />`. */
  setHost: (host: FluxionHost) => void;
  /** Total samples/s across all series (from the stream pump). */
  rate: number;
}

/**
 * Type-safe N-series live chart. The `series` array drives everything: it
 * builds the `axis-grid + N line` layers and a single stream pump that fans
 * each tick out to every series' handle — eliminating the manual
 * layers/setup/tick triple-edit you'd otherwise repeat per series.
 *
 * Capacity is auto-derived per line via `retentionMs` + `maxHz`
 * (see `LineChartLayer`).
 *
 * **Caveat:** `useFluxionCanvas` reconciles layer CONFIG changes only, NOT
 * structural add/remove. Changing the NUMBER of series at runtime requires a
 * full remount — set a `key` on `<FluxionCanvas key={series.length}>` (or a key
 * derived from the series ids).
 *
 * @example
 * const { layers, setHost } = useMultiSeriesChart({
 *   hz: 60, windowMs: 5000,
 *   series: [
 *     { id: "a", color: "#4fc3f7", sample: (t) => Math.sin(t / 500) },
 *     { id: "b", color: "#ffb060", sample: (t) => Math.cos(t / 400) },
 *   ],
 * });
 * return <FluxionCanvas key={2} layers={layers} onReady={setHost} />;
 */
export function useMultiSeriesChart(
  opts: UseMultiSeriesChartOptions,
): UseMultiSeriesChartResult {
  const { series, hz, windowMs, axisLayerId = "axis", axis, cache } = opts;
  const fallbackOrigin = useTimeOrigin();
  const timeOrigin = opts.timeOrigin ?? fallbackOrigin;

  const modes = Array.isArray(opts.distinguishBy)
    ? opts.distinguishBy
    : opts.distinguishBy
      ? [opts.distinguishBy]
      : [];
  const byDash = modes.includes("dash");
  const lanes = opts.layout === "lanes";
  // Lanes supersede the waterfall offset; ignore offset mode when laned.
  const byOffset = !lanes && modes.includes("offset");
  const offsetStep = opts.offsetStep;
  const laneGapPx = opts.laneGapPx;
  // offset mode is inert without a step (we can't guess the data scale).
  const warnedRef = useRef(false);
  if (byOffset && offsetStep === undefined && !warnedRef.current) {
    warnedRef.current = true;
    console.warn(
      '[fluxion] useMultiSeriesChart: distinguishBy "offset" needs `offsetStep` ' +
        "(data units) — no vertical spread applied.",
    );
  }

  // Stable signature so the layers/pump only rebuild on a real structural or
  // visual change (not on every render of an inline series array).
  const sig = series
    .map(
      (s) =>
        `${s.id}|${s.color}|${s.lineWidth ?? ""}|${(s.dashArray ?? []).join(" ")}|${s.yOffset ?? ""}`,
    )
    .join(",");

  const layers = useMemo<FluxionLayerSpec[]>(
    () => [
      axisGridLayer(axisLayerId, {
        xMode: "time",
        timeWindowMs: windowMs,
        // Lane mode: each series owns its band, so the shared y-axis is
        // meaningless — fix it and hide y grid/labels/zero-axis.
        ...(lanes
          ? ({
              yMode: "fixed",
              showYGrid: false,
              showYLabels: false,
              showAxes: false,
            } as const)
          : { yMode: "auto" as const }),
        timeOrigin,
        ...axis,
      }),
      ...series.map((s, i) =>
        lineLayer(s.id, {
          color: s.color,
          lineWidth: s.lineWidth ?? 1.5,
          retentionMs: windowMs,
          maxHz: hz,
          // Explicit per-series field wins; otherwise distinguishBy assigns one.
          dashArray: s.dashArray ?? (byDash ? dashPatternFor(i) : undefined),
          yOffset:
            s.yOffset ??
            (byOffset && offsetStep !== undefined ? i * offsetStep : undefined),
          ...(lanes ? { laneIndex: i, laneCount: series.length, laneGapPx } : undefined),
        }),
      ),
    ],
    // sig captures id/color/lineWidth/dash/offset; the rest are listed.
    [
      sig,
      axisLayerId,
      windowMs,
      timeOrigin,
      hz,
      axis,
      byDash,
      byOffset,
      offsetStep,
      lanes,
      laneGapPx,
    ],
  );

  const [host, setHost] = useState<FluxionHost | null>(null);

  // Refs so the pump's setup/tick identities stay stable across renders.
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const setup = useCallback(
    (h: FluxionHost) =>
      seriesRef.current.map((s) => ({ id: s.id, handle: h.line(s.id) })),
    [],
  );
  const tick = useCallback(
    (tMs: number, handles: { id: string; handle: ReturnType<FluxionHost["line"]> }[]) => {
      const defs = seriesRef.current;
      const c = cacheRef.current;
      let pushed = 0;
      for (let i = 0; i < handles.length; i++) {
        const def = defs[i];
        /* v8 ignore start -- handles is built from the same series array, so def is always defined */
        if (!def) continue;
        /* v8 ignore stop */
        const s = def.sample(tMs);
        const t = typeof s === "number" ? tMs : s.t;
        const y = typeof s === "number" ? s : s.y;
        handles[i]!.handle.push({ t, y });
        c?.push(handles[i]!.id, t, y);
        pushed++;
      }
      return pushed;
    },
    [],
  );

  const { rate } = useFluxionStream({ host, intervalMs: 1000 / hz, setup, tick });

  return { layers, host, setHost, rate };
}
