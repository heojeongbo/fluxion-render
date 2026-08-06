import type { Layer } from "../../../shared/model/layer";
import type { LayerKind } from "../../../shared/protocol";

/** Builds a layer instance for a given id. One per {@link LayerKind}. */
export type LayerFactory = (id: string) => Layer;

const factories = new Map<LayerKind, LayerFactory>();

/**
 * Register the factory for a layer kind. The default worker registers all 21
 * kinds (via `registerDefaultLayers`); a custom worker built for a small app can
 * instead register ONLY the kinds it uses, so a `sideEffects: false` bundler
 * tree-shakes the other layer classes out of the worker bundle. Re-registering a
 * kind replaces its factory.
 */
export function registerLayer(kind: LayerKind, factory: LayerFactory): void {
  factories.set(kind, factory);
}

/**
 * Instantiate a layer for `kind`. Throws with an actionable message if that
 * kind's factory was never registered — the tell that a custom slim worker
 * omitted a kind the app then tried to add.
 */
export function createLayer(id: string, kind: LayerKind): Layer {
  const factory = factories.get(kind);
  if (!factory) {
    throw new Error(
      `[fluxion] no layer factory registered for kind "${kind}". The default ` +
        `worker registers every kind; a custom worker must registerLayer("${kind}", …) ` +
        "— or call registerDefaultLayers() to register all of them.",
    );
  }
  return factory(id);
}

/** Whether a factory is registered for `kind` (without instantiating). */
export function hasLayer(kind: LayerKind): boolean {
  return factories.has(kind);
}

/** Test-only: clear the registry so a test can assert the unregistered path. */
export function resetLayerRegistry(): void {
  factories.clear();
}
