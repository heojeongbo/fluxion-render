import { type RefObject, useEffect, useRef, useState } from "react";
import type { FluxionHost } from "../../host";
import type { HoverDataCache } from "./hover-data-cache";

export interface CrosshairPoint {
  layerId: string;
  label: string;
  color: string;
  t: number;
  y: number;
  xLabel: string;
  yLabel: string;
}

export interface CrosshairState {
  position: { pxX: number; pxY: number } | null;
  points: CrosshairPoint[];
}

export interface UseFluxionCrosshairOptions {
  host: FluxionHost | null;
  cache: HoverDataCache;
  xMode: "time" | "fixed";
  timeWindowMs?: number;
  timeOrigin?: number;
  xRange?: [number, number];
  yPadPx?: number;
  /**
   * Left plot inset in CSS px. Set this to the chart's `yAxisWidth` when the
   * capture element spans a chart rendered with `inlineAxes` (the plot area
   * starts `insetLeft` px in from the element's left edge). Default 0.
   */
  insetLeft?: number;
  xFormat?: (t: number) => string;
  yFormat?: (y: number) => string;
  /**
   * Minimum ms between crosshair `setState` updates while the pointer moves.
   * Default 0 (update on every `pointermove`). Set e.g. `16` to cap updates
   * to ~60fps when many series make per-event re-renders expensive. The
   * `pointerleave` reset is never throttled.
   */
  throttleMs?: number;
}

export interface UseFluxionCrosshairResult {
  chartRef: RefObject<HTMLDivElement>;
  state: CrosshairState;
}

const EMPTY_STATE: CrosshairState = { position: null, points: [] };

export function useFluxionCrosshair(
  opts: UseFluxionCrosshairOptions,
): UseFluxionCrosshairResult {
  const {
    host,
    cache,
    xMode,
    timeWindowMs,
    timeOrigin = 0,
    xRange,
    yPadPx = 0,
    insetLeft = 0,
    xFormat,
    yFormat,
    throttleMs = 0,
  } = opts;

  const chartRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CrosshairState>(EMPTY_STATE);

  // Keep live bounds and size in refs so the event handler closure stays stable.
  const boundsRef = useRef({ xMin: 0, xMax: 1, yMin: -1, yMax: 1, latestT: 0 });
  const sizeRef = useRef({ width: 1, height: 1 });

  // Stable option refs
  const yPadPxRef = useRef(yPadPx);
  yPadPxRef.current = yPadPx;
  const insetLeftRef = useRef(insetLeft);
  insetLeftRef.current = insetLeft;
  const xFormatRef = useRef(xFormat);
  xFormatRef.current = xFormat;
  const yFormatRef = useRef(yFormat);
  yFormatRef.current = yFormat;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const xModeRef = useRef(xMode);
  xModeRef.current = xMode;
  const timeWindowMsRef = useRef(timeWindowMs);
  timeWindowMsRef.current = timeWindowMs;
  const xRangeRef = useRef(xRange);
  xRangeRef.current = xRange;
  const throttleMsRef = useRef(throttleMs);
  throttleMsRef.current = throttleMs;
  // Timestamp of the last emitted move update (for throttling).
  const lastEmitRef = useRef(0);

  // Subscribe to host bounds updates.
  useEffect(() => {
    if (!host) return;
    return host.onBoundsChange((yMin, yMax, latestT) => {
      const b = boundsRef.current;
      b.yMin = yMin;
      b.yMax = yMax;
      b.latestT = latestT;
      if (xModeRef.current === "time" && timeWindowMsRef.current !== undefined) {
        b.xMin = latestT - timeWindowMsRef.current;
        b.xMax = latestT;
      } else if (xModeRef.current === "fixed" && xRangeRef.current) {
        b.xMin = xRangeRef.current[0];
        b.xMax = xRangeRef.current[1];
      }
    });
  }, [host]);

  // ResizeObserver on the chart overlay div.
  useEffect(() => {
    const el = chartRef.current;
    /* v8 ignore start -- chartRef is always attached once mounted; null-ref guard */
    if (!el) return;
    /* v8 ignore stop */
    // Seed size immediately so first pointermove has correct dimensions.
    sizeRef.current = { width: el.clientWidth, height: el.clientHeight };
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      /* v8 ignore start -- ResizeObserver always delivers at least one entry */
      if (!entry) return;
      /* v8 ignore stop */
      sizeRef.current = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pointer event listeners.
  useEffect(() => {
    const el = chartRef.current;
    /* v8 ignore start -- chartRef is always attached once mounted; null-ref guard */
    if (!el) return;
    /* v8 ignore stop */

    const defaultXFormat = (t: number): string =>
      timeOrigin > 0
        ? new Date(timeOrigin + t).toISOString().slice(11, 23)
        : t.toFixed(3);
    const defaultYFormat = (y: number): string => y.toFixed(4);

    const handleMove = (e: PointerEvent): void => {
      const throttle = throttleMsRef.current;
      if (throttle > 0) {
        const now = Date.now();
        if (now - lastEmitRef.current < throttle) return;
        lastEmitRef.current = now;
      }
      const rect = el.getBoundingClientRect();
      const pxX = e.clientX - rect.left;
      const pxY = e.clientY - rect.top;

      const { width } = sizeRef.current;

      // For time mode: derive xMin/xMax from cache's latest t so the window
      // stays current even when BOUNDS_UPDATE is gated by y-change epsilon.
      let xMin: number;
      let xMax: number;
      if (xModeRef.current === "time" && timeWindowMsRef.current !== undefined) {
        xMax = cacheRef.current.getLatestT();
        xMin = xMax - timeWindowMsRef.current;
      } else {
        xMin = boundsRef.current.xMin;
        xMax = boundsRef.current.xMax;
      }

      // Inline-axes charts inset the plot rect by `insetLeft` inside the same
      // element — map pointer px over the plot span, not the element span.
      const inset = insetLeftRef.current;
      const plotW = width - inset || 1;
      const dataT = xMin + ((pxX - inset) / plotW) * (xMax - xMin);

      const fmtX = xFormatRef.current ?? defaultXFormat;
      const fmtY = yFormatRef.current ?? defaultYFormat;

      const c = cacheRef.current;
      const points: CrosshairPoint[] = [];
      for (const { id, label, color } of c.getLayers()) {
        const nearest = c.findNearest(id, dataT, xMin);
        if (!nearest) continue;
        points.push({
          layerId: id,
          label,
          color,
          t: nearest.t,
          y: nearest.y,
          xLabel: fmtX(nearest.t),
          yLabel: fmtY(nearest.y),
        });
      }

      setState({ position: { pxX, pxY }, points });
    };

    const handleLeave = (): void => {
      setState(EMPTY_STATE);
    };

    el.addEventListener("pointermove", handleMove);
    el.addEventListener("pointerleave", handleLeave);
    return () => {
      el.removeEventListener("pointermove", handleMove);
      el.removeEventListener("pointerleave", handleLeave);
    };
  }, [timeOrigin]);

  return { chartRef, state };
}
