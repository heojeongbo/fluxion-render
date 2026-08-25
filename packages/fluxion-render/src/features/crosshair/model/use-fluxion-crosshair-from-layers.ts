import { getAxisSpec } from "../../../shared/lib/get-axis-spec";
import type { FluxionLayerSpec } from "../../../widgets/fluxion-canvas/lib/use-fluxion-canvas";
import type { FluxionHost } from "../../host";
import type { CachedLayerOptions, HoverDataCache } from "./hover-data-cache";
import {
  type UseFluxionCrosshairResult,
  useFluxionCrosshair,
} from "./use-fluxion-crosshair";
import { useHoverDataCache } from "./use-hover-data-cache";

export interface UseFluxionCrosshairFromLayersOptions {
  host: FluxionHost | null;
  /**
   * Optional hover-data cache. Omit it and the hook creates and manages one
   * internally — auto-registering each non-axis layer from `layers` — and
   * returns it (plus `push`/`pushBatch`) on the result so you can feed it from
   * your stream tick. Pass an explicit cache only when you need to share it
   * (e.g. with `useFluxionExport`) or mirror it for managed-pool fan-out.
   */
  cache?: HoverDataCache;
  /** The same `layers` array passed to `<FluxionCanvas>`. */
  layers: FluxionLayerSpec[];
  /**
   * Per-id overrides for the auto-created cache (capacity, label, color),
   * applied on registration. Use a larger `capacity` when the visible window is
   * long and high-rate so hover lookups don't fall off the cache before they
   * leave the screen. Ignored when an explicit `cache` is supplied.
   */
  overrides?: Record<string, CachedLayerOptions>;
  /** Axis layer id to read time-window config from. Default `"axis"`. */
  axisLayerId?: string;
  /** @deprecated No effect — see `UseFluxionCrosshairOptions.yPadPx`. */
  yPadPx?: number;
  xFormat?: (t: number) => string;
  yFormat?: (y: number) => string;
}

export interface UseFluxionCrosshairFromLayersResult extends UseFluxionCrosshairResult {
  /** The hover cache in use — the one you passed, or the auto-created one. */
  cache: HoverDataCache;
  /** Push a single sample into the cache (no-op for unregistered ids). */
  push: (id: string, t: number, y: number) => void;
  /** Push an interleaved `[t,y,…]` batch into the cache. */
  pushBatch: (id: string, arr: Float32Array) => void;
}

/**
 * Convenience wrapper over {@link useFluxionCrosshair} that reads `xMode`,
 * `timeWindowMs`, `timeOrigin`, and `xRange` from the axis-grid layer spec in
 * `layers` — so you configure the time window in exactly one place (the axis
 * layer) instead of re-passing it to the crosshair. Falls back to sensible
 * defaults if no matching axis spec is found.
 *
 * If you don't pass a `cache`, the hook owns one (auto-registered from
 * `layers`) and returns it alongside `push`/`pushBatch`, so the common
 * single-chart case needs no separate `useHoverDataCache` call.
 */
export function useFluxionCrosshairFromLayers(
  opts: UseFluxionCrosshairFromLayersOptions,
): UseFluxionCrosshairFromLayersResult {
  const { host, cache, layers, overrides, axisLayerId = "axis", xFormat, yFormat } = opts;
  const axisConfig = getAxisSpec(layers, axisLayerId)?.config;

  // Always create an internal cache (hooks run unconditionally); use the
  // caller's when provided, otherwise fall back to the managed one.
  const internal = useHoverDataCache({ layers, overrides });
  const activeCache = cache ?? internal.cache;

  const result = useFluxionCrosshair({
    host,
    cache: activeCache,
    xMode: axisConfig?.xMode ?? "fixed",
    timeWindowMs: axisConfig?.timeWindowMs,
    timeOrigin: axisConfig?.timeOrigin,
    xRange: axisConfig?.xRange,
    xFormat,
    yFormat,
  });

  return {
    ...result,
    cache: activeCache,
    // Bind to the active cache so the helpers are correct whether the caller
    // brought their own cache or we created one.
    push: (id, t, y) => activeCache.push(id, t, y),
    pushBatch: (id, arr) => activeCache.pushBatch(id, arr),
  };
}
