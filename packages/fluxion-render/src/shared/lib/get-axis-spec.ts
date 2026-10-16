import type { FluxionLayerSpec } from "../model/layer-spec";

/**
 * Find the axis-grid layer spec with the given id. Shared by `useAxisTicks` and
 * `useFluxionCrosshairFromLayers` so both read the axis config (xMode,
 * timeWindowMs, timeOrigin, xRange) from a single source instead of re-passing
 * those values by hand.
 */
export function getAxisSpec(
  layers: FluxionLayerSpec[],
  axisLayerId: string,
): (FluxionLayerSpec & { kind: "axis-grid" }) | undefined {
  return layers.find(
    (l): l is FluxionLayerSpec & { kind: "axis-grid" } =>
      l.id === axisLayerId && l.kind === "axis-grid",
  );
}
