import {
  type CSSProperties,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type {
  FluxionHost,
  FluxionHostOptions,
  HostRecyclePool,
} from "../../../features/host";
import { useXAxisCanvas, useYAxisCanvas } from "../lib/use-axis-canvas";
import { useAxisTicks } from "../lib/use-axis-ticks";
import { type FluxionLayerSpec, useFluxionCanvas } from "../lib/use-fluxion-canvas";

export interface FluxionCanvasProps {
  layers: FluxionLayerSpec[];
  style?: CSSProperties;
  className?: string;
  hostOptions?: FluxionHostOptions;
  onReady?: (host: FluxionHost) => void;
  /**
   * Defer host creation through a shared frame-throttled queue so a burst of
   * simultaneous mounts (an accordion expanding, a grid appearing) spreads
   * across frames instead of spiking one. Tune with `configureLifecycleScheduler`.
   * **Default `true`** — `host` / `onReady` arrive one frame deferred. Pass
   * `false` for synchronous host creation.
   */
  staggerMount?: boolean;
  /**
   * Recycle hosts instead of creating/destroying them per mount. Pass a pool
   * from {@link useHostRecyclePool} to reuse warm hosts across mounts — the big
   * CPU win for virtualized lists, accordions, and grids that remount. Omit for
   * the normal create/dispose lifecycle.
   */
  recyclePool?: HostRecyclePool;
  /**
   * Optional explicit recycle bucket for charts that share a {@link recyclePool}
   * but are structurally different. Omit to derive one automatically.
   */
  recycleKey?: string;
  /**
   * Renders axis labels in separate canvases drawn by the Worker —
   * y-axis canvas to the LEFT, x-axis canvas BELOW the chart.
   * Default `true`. Set to `false` only to embed the chart without
   * axis label space (e.g. inside thumbnail grids).
   *
   * Pair with `showXLabels: false, showYLabels: false` on the axis-grid
   * layer to avoid double-drawing labels inside the chart area.
   */
  externalAxes?: boolean;
  /**
   * ID of the axis-grid layer used for external axis rendering.
   * Required when `externalAxes` is `true` (default).
   */
  axisLayerId?: string;
  /** Width of the y-axis canvas in px. Default: 60. */
  yAxisWidth?: number;
  /** Height of the x-axis canvas in px. Default: 30. */
  xAxisHeight?: number;
  /** Tick label + tick mark color. Default: "#666". */
  axisColor?: string;
  /** Tick label font. Default: "11px sans-serif". */
  axisFont?: string;
  /** Length of tick marks in px. Default: 6. */
  axisTickSize?: number;
  /** Gap between tick mark and label in px. Default: 4. */
  axisTickMargin?: number;
}

export interface FluxionCanvasHandle {
  getHost(): FluxionHost | null;
}

/**
 * Thin wrapper around {@link useFluxionCanvas}. Use this when you just want
 * a filled-container canvas; reach for the hook directly when you need to
 * control the wrapping DOM yourself.
 *
 * By default (`externalAxes={true}`) the Worker renders axis labels in
 * dedicated canvases flanking the chart — no main-thread tick lag.
 * Pass `externalAxes={false}` to render the chart alone with no axis space.
 */
export const FluxionCanvas = forwardRef<FluxionCanvasHandle, FluxionCanvasProps>(
  function FluxionCanvas(
    {
      layers,
      style,
      className,
      hostOptions,
      onReady,
      staggerMount,
      recyclePool,
      recycleKey,
      externalAxes = true,
      axisLayerId = "",
      yAxisWidth = 60,
      xAxisHeight = 30,
      axisColor,
      axisFont,
      axisTickSize,
      axisTickMargin,
    },
    ref,
  ) {
    const xAxisContainerRef = useRef<HTMLDivElement>(null);
    const yAxisContainerRef = useRef<HTMLDivElement>(null);

    const axisStyle = useMemo(
      () => ({
        color: axisColor,
        font: axisFont,
        tickSize: axisTickSize,
        tickMargin: axisTickMargin,
      }),
      [axisColor, axisFont, axisTickSize, axisTickMargin],
    );

    const { containerRef, host } = useFluxionCanvas({
      layers,
      hostOptions: externalAxes
        ? { ...hostOptions, xAxisHeight, yAxisWidth, axisStyle }
        : hostOptions,
      onReady,
      staggerMount,
      recyclePool,
      recycleKey,
      xAxisContainerRef: externalAxes ? xAxisContainerRef : undefined,
      yAxisContainerRef: externalAxes ? yAxisContainerRef : undefined,
    });

    useImperativeHandle(ref, () => ({ getHost: () => host }), [host]);

    // Legacy React-side axis rendering path (externalAxes=false).
    // Hooks must be called unconditionally — they no-op when host/ticks are absent.
    const tickSet = useAxisTicks(layers, axisLayerId, externalAxes ? null : host);
    const legacyYCanvasRef = useYAxisCanvas(tickSet?.yTicks ?? [], axisStyle);
    const legacyXCanvasRef = useXAxisCanvas(
      xAxisHeight > 0 ? (tickSet?.xTicks ?? []) : [],
      axisStyle,
    );

    if (!externalAxes) {
      void legacyYCanvasRef;
      void legacyXCanvasRef;
      return (
        <div
          ref={containerRef}
          className={className}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            ...style,
          }}
        />
      );
    }

    // externalAxes=true — Worker renders both axis canvases.
    void legacyYCanvasRef;
    void legacyXCanvasRef;

    return (
      <div
        className={className}
        style={{
          display: "grid",
          gridTemplateColumns: `${yAxisWidth}px 1fr`,
          gridTemplateRows: xAxisHeight > 0 ? `1fr ${xAxisHeight}px` : "1fr",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          ...style,
        }}
      >
        <div
          ref={yAxisContainerRef}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
          }}
        />
        <div
          ref={containerRef}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
          }}
        />
        {xAxisHeight > 0 && (
          <>
            <div />
            <div
              ref={xAxisContainerRef}
              style={{
                position: "relative",
                width: "100%",
                height: "100%",
                minWidth: 0,
                minHeight: 0,
              }}
            />
          </>
        )}
      </div>
    );
  },
);
