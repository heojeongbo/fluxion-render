import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
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
import {
  FluxionHost,
  type FluxionHostOptions,
  type HostBundle,
  type HostRecyclePool,
} from "../../../features/host";
import { enqueueDispose, enqueueMount } from "../../../shared/lib/lifecycle-scheduler";
import { type ResizeInfo, useResizeObserver } from "./use-resize-observer";

/**
 * Declarative layer spec used by `useFluxionCanvas` and `<FluxionCanvas/>`.
 *
 * Discriminated union: `kind` narrows `config` to the matching layer-specific
 * type, so wrong fields are caught at compile time. Prefer the layer factory
 * helpers (`lineLayer`, `axisGridLayer`, etc.) for ergonomic construction —
 * they encode the kind so callers don't repeat themselves.
 */
export type FluxionLayerSpec =
  | { id: string; kind: "line"; config?: LineChartConfig }
  | { id: string; kind: "line-static"; config?: LineChartStaticConfig }
  | { id: string; kind: "lidar"; config?: LidarScatterConfig }
  | { id: string; kind: "axis-grid"; config?: AxisGridConfig }
  | { id: string; kind: "scatter"; config?: ScatterChartConfig }
  | { id: string; kind: "area"; config?: AreaChartConfig }
  | { id: string; kind: "step"; config?: StepChartConfig }
  | { id: string; kind: "bar"; config?: BarChartConfig }
  | { id: string; kind: "candlestick"; config?: CandlestickConfig }
  | { id: string; kind: "heatmap"; config?: HeatmapConfig }
  | { id: string; kind: "event-marker"; config?: EventMarkerConfig }
  | { id: string; kind: "scatter-colored"; config?: ScatterColoredConfig }
  | { id: string; kind: "heatmap-stream"; config?: HeatmapStreamConfig }
  | { id: string; kind: "reference-line"; config?: ReferenceLineConfig }
  | { id: string; kind: "pose-arrow"; config?: PoseArrowConfig }
  | { id: string; kind: "trajectory"; config?: TrajectoryConfig }
  | { id: string; kind: "occupancy-grid"; config?: OccupancyGridConfig }
  | { id: string; kind: "histogram"; config?: HistogramConfig }
  | { id: string; kind: "stacked-area"; config?: StackedAreaConfig }
  | { id: string; kind: "box-plot"; config?: BoxPlotConfig }
  | { id: string; kind: "polar"; config?: PolarConfig };

export interface UseFluxionCanvasOptions {
  layers: FluxionLayerSpec[];
  hostOptions?: FluxionHostOptions;
  onReady?: (host: FluxionHost) => void;
  /**
   * Container div for the x-axis canvas. The effect creates a fresh `<canvas>`
   * inside this div on every mount — StrictMode-safe (no reuse of a transferred element).
   */
  xAxisContainerRef?: RefObject<HTMLDivElement | null>;
  /**
   * Container div for the y-axis canvas. Same lifetime contract as xAxisContainerRef.
   */
  yAxisContainerRef?: RefObject<HTMLDivElement | null>;
  /**
   * Defer the expensive host creation (OffscreenCanvas transfer + worker
   * `POOL_INIT` + first render) through a shared frame-throttled queue so a
   * burst of simultaneous mounts (an accordion expanding, a grid appearing)
   * spreads across frames instead of spiking one. The placeholder `<canvas>`
   * is still attached immediately; only the host spins up on a later frame, so
   * `host` / `onReady` arrive deferred (by one frame even for a lone chart).
   * Tune the rate with {@link configureMountScheduler}.
   *
   * **Default `true`.** Pass `false` for synchronous host creation — e.g. when
   * you read the host imperatively right after mount instead of via `onReady`.
   */
  staggerMount?: boolean;
  /**
   * Opt into host RECYCLING: instead of creating a `FluxionHost` on mount and
   * disposing it on unmount, borrow a warm one from this pool and return it on
   * unmount. The expensive create→destroy cycle (OffscreenCanvas transfer +
   * worker init + first render) collapses into a cheap re-parent + reset — the
   * big CPU win for virtualized lists, accordions, and grids that remount.
   * Create one with {@link useHostRecyclePool} and share it across compatible
   * charts (same worker pool, axis-canvas presence, etc.). When omitted, the
   * normal create/dispose lifecycle is used.
   */
  recyclePool?: HostRecyclePool;
  /**
   * Optional explicit recycle bucket. Charts sharing a {@link recyclePool} but
   * with structurally different layers/options should pass distinct keys so an
   * incompatible warm host is never reused. When omitted, a key is derived from
   * the worker pool identity + axis-canvas presence + render options.
   */
  recycleKey?: string;
}

export interface UseFluxionCanvasResult {
  /**
   * Attach to a `<div>`. The hook appends a `<canvas>` child imperatively —
   * do NOT render a canvas yourself inside this container.
   */
  containerRef: RefObject<HTMLDivElement>;
  /**
   * Live host handle. `null` until the effect completes on the first mount.
   * Updates to a new instance if the component remounts.
   */
  host: FluxionHost | null;
}

function styleCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.minWidth = "0";
  canvas.style.minHeight = "0";
  return canvas;
}

function makeMainCanvas(container: HTMLDivElement): HTMLCanvasElement {
  const canvas = styleCanvas(document.createElement("canvas"));
  container.appendChild(canvas);
  return canvas;
}

function makeAxisCanvas(container: HTMLDivElement): HTMLCanvasElement {
  return makeMainCanvas(container);
}

/** Current pixel size + DPR of a container, for an immediate post-reparent resize. */
function measure(el: HTMLElement): { width: number; height: number; dpr: number } {
  const rect = el.getBoundingClientRect();
  /* v8 ignore start -- devicePixelRatio is always defined in the DOM test env; SSR fallback */
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  /* v8 ignore stop */
  return { width: rect.width, height: rect.height, dpr };
}

/** Remove a canvas from its container if still attached (re-parent / unmount safe). */
function detachCanvas(
  canvas: HTMLCanvasElement | undefined,
  container: HTMLElement | null,
): void {
  if (canvas && container && canvas.parentNode === container) {
    container.removeChild(canvas);
  }
}

/**
 * Low-level React hook that owns a FluxionRender worker + OffscreenCanvas.
 *
 * Consumers attach `containerRef` to any `<div>` and the hook:
 *  1. Creates a fresh `<canvas>` inside the div on mount (one-shot
 *     `transferControlToOffscreen` is safe because each effect invocation
 *     allocates its own element — StrictMode double-invoke compatible)
 *  2. Spins up a `FluxionHost` + worker and registers the supplied layers
 *  3. Observes container size / DPR and forwards resize messages
 *  4. Terminates the worker + removes the canvas on unmount
 *
 * The `layers` array is reconciled when its reference changes (memoize it and
 * list your config inputs as deps): added layers are created, removed layers
 * are dropped, a changed `kind` swaps the layer, and changed configs are
 * re-sent via `configLayer` — no `key` remount needed for structural changes.
 * Re-ORDERING existing layers is not reconciled (draw order follows insertion);
 * `hostOptions` and `onReady` remain mount-only. Swap the `key` for a full
 * re-initialization (e.g. to reorder or change the worker pool).
 */
export function useFluxionCanvas(
  options: UseFluxionCanvasOptions,
): UseFluxionCanvasResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<FluxionHost | null>(null);
  const [host, setHost] = useState<FluxionHost | null>(null);
  // Incremented when a disposed-pool early-return fires, so the effect re-runs
  // once the parent re-renders with a fresh pool.
  const [mountKey, setMountKey] = useState(0);

  // Stash the latest options in a ref so the mount effect can stay with
  // an empty dep array without going stale between StrictMode invocations.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Serialized configs already applied to the worker, keyed by layer id.
  // Seeded at mount (addLayer carries the initial config) so the reconcile
  // effect below doesn't re-send what the worker already has.
  const lastAppliedRef = useRef<Map<string, string>>(new Map());
  // Layer kind currently present in the worker, keyed by id. Drives the
  // structural reconcile (add / remove / kind-change) below.
  const lastKindsRef = useRef<Map<string, FluxionLayerSpec["kind"]>>(new Map());
  // The live recycle bundle this mount owns (host + its canvas(es)). Known
  // synchronously on the warm path; set inside the deferred work on the cold
  // path. Carried so cleanup can recycle (park) or dispose it.
  const bundleRef = useRef<HostBundle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    /* v8 ignore start -- containerRef is always attached once mounted; null-ref guard */
    if (!container) return;
    /* v8 ignore stop */

    // StrictMode: a parent's cleanup disposes the worker pool and schedules a new
    // one via setState, but children effects re-run synchronously before that
    // re-render propagates. Bump mountKey so this effect re-runs against the live
    // pool instead of a disposed one. (A disposed RECYCLE pool needs no such guard:
    // its `acquire` safely returns null → the cold path, and `release` disposes.)
    const current = optionsRef.current;
    if (current.hostOptions?.pool?.isDisposed) {
      setMountKey((k) => k + 1);
      return;
    }

    const recyclePool = current.recyclePool ?? null;
    const xAxisContainer = current.xAxisContainerRef?.current ?? null;
    const yAxisContainer = current.yAxisContainerRef?.current ?? null;
    const keyParams = {
      hostOptions: current.hostOptions,
      hasXAxis: xAxisContainer !== null,
      hasYAxis: yAxisContainer !== null,
      recycleKey: current.recycleKey,
    };

    // Baseline the reconcile maps to the layers we just (re-)applied so the
    // reconcile effect doesn't re-send what the worker already holds.
    const seedReconcile = () => {
      lastAppliedRef.current = new Map(
        current.layers.map((l) => [l.id, JSON.stringify(l.config)]),
      );
      lastKindsRef.current = new Map(current.layers.map((l) => [l.id, l.kind]));
    };

    // Borrow a warm host for this config, or null → cold create. Parked bundles
    // are pristine (reset on release), so the warm path can re-add layers onto an
    // empty stack exactly like a cold one — no duplicate layers.
    const warm = recyclePool ? recyclePool.acquire(keyParams) : null;

    // The placeholder canvas(es): a warm bundle's already-transferred canvases
    // re-parented into THIS mount's containers (visible immediately), or fresh
    // ones for a cold mount. Either way the expensive/deferred work runs later so
    // `staggerMount` can spread a burst across frames.
    let canvas: HTMLCanvasElement;
    let xAxisCanvas: HTMLCanvasElement | undefined;
    let yAxisCanvas: HTMLCanvasElement | undefined;
    let cancelled = false;
    let work: () => void;

    if (warm) {
      canvas = warm.canvas;
      xAxisCanvas = warm.xAxisCanvas;
      yAxisCanvas = warm.yAxisCanvas;
      container.appendChild(canvas);
      if (xAxisCanvas && xAxisContainer) xAxisContainer.appendChild(xAxisCanvas);
      if (yAxisCanvas && yAxisContainer) yAxisContainer.appendChild(yAxisCanvas);
      // Known synchronously so an unmount before activation can return it.
      bundleRef.current = warm;
      // Cheap reactivation (re-add layers + resize + resume) — none of cold's
      // OffscreenCanvas transfer / worker init / first render.
      work = () => {
        /* v8 ignore start -- defensive: cancelMount drops the queued task on unmount, so this never runs once cancelled on the normal path */
        if (cancelled) return;
        /* v8 ignore stop */
        const { host } = warm;
        for (const l of current.layers) host.addLayer(l.id, l.kind, l.config);
        if (current.hostOptions?.bgColor !== undefined) {
          host.setBgColor(current.hostOptions.bgColor);
        }
        // Re-parent may have landed in a differently-sized slot — resize now
        // instead of waiting for the debounced ResizeObserver.
        const size = measure(container);
        host.resize(size.width, size.height, size.dpr);
        host.setVisible(true);
        seedReconcile();
        hostRef.current = host;
        setHost(host);
        current.onReady?.(host);
      };
    } else {
      canvas = makeMainCanvas(container);
      // Axis canvases created fresh so transferControlToOffscreen is always called
      // on a brand-new element (StrictMode double-invoke safe).
      xAxisCanvas = xAxisContainer ? makeAxisCanvas(xAxisContainer) : undefined;
      yAxisCanvas = yAxisContainer ? makeAxisCanvas(yAxisContainer) : undefined;
      work = () => {
        /* v8 ignore start -- defensive: cancelMount drops the queued task on unmount, so this never runs once cancelled on the normal path */
        if (cancelled) return;
        /* v8 ignore stop */
        recyclePool?.markCreated();
        const host = new FluxionHost(canvas, {
          ...current.hostOptions,
          xAxisElement: xAxisCanvas,
          yAxisElement: yAxisCanvas,
        });
        for (const l of current.layers) host.addLayer(l.id, l.kind, l.config);
        seedReconcile();
        bundleRef.current = {
          host,
          canvas,
          xAxisCanvas,
          yAxisCanvas,
          key: recyclePool ? recyclePool.keyFor(keyParams) : "",
        };
        hostRef.current = host;
        setHost(host);
        current.onReady?.(host);
      };
    }

    // Staggered work is the DEFAULT (spreads a burst of mounts across frames);
    // opt out with `staggerMount: false` for synchronous creation.
    const stagger = current.staggerMount !== false;
    const cancelMount = stagger ? enqueueMount(work) : null;
    if (!cancelMount) work();

    return () => {
      // Cancel a not-yet-run deferred work item first, then recycle/dispose the
      // live bundle if one exists.
      cancelled = true;
      cancelMount?.();
      const bundle = bundleRef.current;
      // Detach the placeholder canvas(es) from the live DOM. A warm bundle KEEPS
      // its canvas references (re-parented on next acquire); a disposed host's
      // are GC'd with it.
      detachCanvas(canvas, container);
      detachCanvas(xAxisCanvas, xAxisContainer);
      detachCanvas(yAxisCanvas, yAxisContainer);
      if (bundle) {
        if (recyclePool && !recyclePool.isDisposed) {
          // Recycle: reset to pristine + pause (synchronous so the same-commit
          // remount can borrow it back), then park for the next mount.
          bundle.host.reset();
          bundle.host.setVisible(false);
          recyclePool.release(bundle);
        } else {
          // No recycle pool: dispose — deferred through the frame queue when
          // staggered so a bulk unmount spreads the teardown across frames.
          const host = bundle.host;
          if (stagger) enqueueDispose(() => host.dispose());
          else host.dispose();
        }
      }
      hostRef.current = null;
      bundleRef.current = null;
      setHost(null);
    };
  }, [mountKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile the `layers` array against what the worker holds whenever the
  // reference changes. Memoize `layers` in the consumer and list config inputs
  // as deps. Handles three structural cases plus config diffing:
  //   • added layer (new id)            → addLayer
  //   • removed layer (id gone)         → removeLayer
  //   • changed kind (same id, new kind)→ removeLayer + addLayer
  //   • changed config (same id+kind)   → configLayer
  // Re-ORDERING existing layers is not reconciled (draw order is insertion
  // order); remount via `key` if you must reorder.
  const layers = options.layers;
  useEffect(() => {
    if (!host) return;
    const applied = lastAppliedRef.current;
    const kinds = lastKindsRef.current;
    const nextIds = new Set(layers.map((l) => l.id));

    // 1. Remove layers that are no longer present.
    for (const id of [...kinds.keys()]) {
      if (!nextIds.has(id)) {
        host.removeLayer(id);
        kinds.delete(id);
        applied.delete(id);
      }
    }

    // 2. Add / replace / reconfigure.
    for (const spec of layers) {
      const prevKind = kinds.get(spec.id);
      const serialized = JSON.stringify(spec.config);
      if (prevKind === undefined) {
        // New layer.
        host.addLayer(spec.id, spec.kind, spec.config);
        kinds.set(spec.id, spec.kind);
        applied.set(spec.id, serialized);
      } else if (prevKind !== spec.kind) {
        // Kind changed → drop and re-add so the worker swaps the layer class.
        host.removeLayer(spec.id);
        host.addLayer(spec.id, spec.kind, spec.config);
        kinds.set(spec.id, spec.kind);
        applied.set(spec.id, serialized);
      } else if (spec.config !== undefined && applied.get(spec.id) !== serialized) {
        // Same kind, changed config.
        applied.set(spec.id, serialized);
        host.configLayer(spec.id, spec.config);
      }
    }
  }, [host, layers]);

  const handleResize = useCallback((info: ResizeInfo) => {
    // Forward to the host only once it exists (under staggerMount a resize can
    // arrive before the deferred host is created) and the size is real (a
    // detached / pre-layout element reports 0×0).
    const instance = hostRef.current;
    if (instance && info.width > 0 && info.height > 0) {
      instance.resize(info.width, info.height, info.dpr);
    }
  }, []);

  useResizeObserver(containerRef, handleResize);

  return { containerRef, host };
}
