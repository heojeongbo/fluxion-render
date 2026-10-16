import type { LayerKind } from "../protocol";
import type { LayerConfigByKind } from "./layer-config-map";

/**
 * Declarative layer spec used by `useFluxionCanvas` and `<FluxionCanvas/>`: an
 * `id` + `kind` + the config typed to that kind, so wrong fields are caught at
 * compile time. Derived from {@link LayerConfigByKind} (the single kind→config
 * source of truth), so it stays in lockstep with the imperative
 * `host.addLayer<K>` — add a layer kind once, in the map, and both APIs pick it
 * up.
 */
export type FluxionLayerSpec = {
  [K in LayerKind]: { id: string; kind: K; config?: LayerConfigByKind[K] };
}[LayerKind];
