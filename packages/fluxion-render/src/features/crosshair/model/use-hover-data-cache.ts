import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FluxionLayerSpec } from "../../../widgets/fluxion-canvas/lib/use-fluxion-canvas";
import { type CachedLayerOptions, HoverDataCache } from "./hover-data-cache";

export interface UseHoverDataCacheOptions {
  /**
   * Auto-register hover layers from these specs. Reads each spec's `id` and
   * `config.color` (and `config.label` if present). Re-registers when the
   * id/color signature changes. `registerLayer` is idempotent, so this is safe
   * to call repeatedly.
   */
  layers?: FluxionLayerSpec[];
  /** Per-id overrides (capacity, label, color) applied on registration. */
  overrides?: Record<string, CachedLayerOptions>;
}

export interface UseHoverDataCacheResult {
  /** Stable cache instance — pass to `useFluxionCrosshair`/`useFluxionExport`. */
  cache: HoverDataCache;
  /** Push a single sample (no-op for unregistered ids). */
  push: (id: string, t: number, y: number) => void;
  /** Push an interleaved `[t,y,…]` batch. */
  pushBatch: (id: string, arr: Float32Array) => void;
}

/** Layer kinds that carry a `color` and are worth hovering. */
function isHoverableLayer(
  spec: FluxionLayerSpec,
): spec is FluxionLayerSpec & { config?: { color?: string; label?: string } } {
  return spec.kind !== "axis-grid";
}

/**
 * Factory hook for a {@link HoverDataCache}: returns a stable instance and,
 * when given `layers`, auto-registers each non-axis layer (reading its id +
 * color) so you don't hand-write `new HoverDataCache()` + `registerLayer` in
 * every chart. Pair with `useFluxionCrosshair` / `useFluxionExport`, and pass
 * the cache to `useSimpleChart`/`useMultiSeriesChart` so samples auto-populate
 * it without manual `cache.push` in the stream tick.
 */
export function useHoverDataCache(
  opts: UseHoverDataCacheOptions = {},
): UseHoverDataCacheResult {
  const { layers, overrides } = opts;
  const cache = useMemo(() => new HoverDataCache(), []);

  // Signature of registered layers so re-registration only runs on real change.
  const sig = (layers ?? [])
    .filter(isHoverableLayer)
    .map((l) => `${l.id}|${l.config?.color ?? ""}`)
    .join(",");

  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  useEffect(() => {
    if (!layers) return;
    for (const spec of layers) {
      if (!isHoverableLayer(spec)) continue;
      cache.registerLayer(spec.id, {
        color: spec.config?.color,
        label: spec.config?.label,
        ...overridesRef.current?.[spec.id],
      });
    }
    // sig captures the id/color set; cache is stable.
  }, [sig, cache]);

  const push = useCallback(
    (id: string, t: number, y: number) => cache.push(id, t, y),
    [cache],
  );
  const pushBatch = useCallback(
    (id: string, arr: Float32Array) => cache.pushBatch(id, arr),
    [cache],
  );

  return { cache, push, pushBatch };
}
