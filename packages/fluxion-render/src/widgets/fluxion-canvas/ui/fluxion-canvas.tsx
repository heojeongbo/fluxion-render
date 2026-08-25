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
   * Pause a chart's rendering while it's scrolled off-screen (shared
   * IntersectionObserver) — the big win for tall scroll grids. Data keeps
   * streaming into the ring while off-screen, so scrolling back into view shows
   * the full buffered history, not an empty chart. Composes with page
   * visibility. **Default `false`.** Tune with `configureOnScreenObserver`.
   */
  pauseWhenOffscreen?: boolean;
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
   * Inline-axes mode: ONE canvas fills the whole container and the Worker
   * draws axis ticks/labels into reserved margins inside it (`yAxisWidth`
   * left, `xAxisHeight` bottom). Halves-to-thirds the per-frame canvas
   * surface presents of a chart vs `externalAxes` — the preferred mode for
   * large grids. Takes precedence over `externalAxes` when set. In-plot
   * labels are automatically suppressed. Note: pointer→data overlays
   * (crosshair) must account for the left margin — pass the same value as
   * `insetLeft` to `useFluxionCrosshair`.
   */
  inlineAxes?: boolean;
  /**
   * @deprecated No effect. It only ever fed the React-side axis path, which
   * was already dead code (its canvas refs were never attached). With
   * `externalAxes` the WORKER draws the axis canvases from the axis-grid layer
   * it already holds, so no id is needed. Accepted so existing call sites keep
   * compiling.
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
      pauseWhenOffscreen,
      externalAxes = true,
      inlineAxes = false,
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

    // Inline mode wins over externalAxes: one full-container canvas with
    // in-canvas margins, no separate axis canvases/containers.
    const useExternal = externalAxes && !inlineAxes;
    const { containerRef, host } = useFluxionCanvas({
      layers,
      hostOptions: inlineAxes
        ? { ...hostOptions, inlineAxes: true, xAxisHeight, yAxisWidth, axisStyle }
        : useExternal
          ? { ...hostOptions, xAxisHeight, yAxisWidth, axisStyle }
          : hostOptions,
      onReady,
      staggerMount,
      recyclePool,
      recycleKey,
      pauseWhenOffscreen,
      xAxisContainerRef: useExternal ? xAxisContainerRef : undefined,
      yAxisContainerRef: useExternal ? yAxisContainerRef : undefined,
    });

    useImperativeHandle(ref, () => ({ getHost: () => host }), [host]);

    // NOTE: there is deliberately no React-side axis rendering here any more.
    // `useAxisTicks` + `useXAxisCanvas`/`useYAxisCanvas` used to be called on
    // every render, but their returned refs were `void`-ed on BOTH branches
    // below and never attached to an element — so the work was thrown away.
    // Under `externalAxes={false}` that was not free: `useAxisTicks` received
    // the host, which made the worker post TICK_UPDATE every frame (`emitTicks`
    // defaults to true) and re-render this component on every tick change, all
    // to feed a canvas that did not exist.
    //
    // The three hooks remain exported from `/react` for consumers who want to
    // draw their own axes — only this dead internal wiring is gone.

    // Inline mode (and externalAxes=false): a single full-container div —
    // the worker draws everything, including inline margins, on ONE canvas.
    if (inlineAxes || !externalAxes) {
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
