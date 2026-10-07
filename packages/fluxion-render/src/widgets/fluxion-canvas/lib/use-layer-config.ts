import { useEffect, useRef } from "react";
import type { FluxionHost } from "../../../features/host";
import type { FluxionLayerSpec } from "./use-fluxion-canvas";

/**
 * Declaratively sync a layer's config to the host whenever the config
 * actually changes. Compares via `JSON.stringify` so unstable object
 * references with identical content don't trigger duplicate messages
 * to the worker.
 *
 * Takes a full `FluxionLayerSpec` (kind + id + config) so the config type
 * is checked against the layer kind at the call site. Pair with the layer
 * factory helpers for ergonomic usage:
 *
 * ```ts
 * useLayerConfig(host, axisGridLayer("axis", { timeWindowMs: windowMs }));
 * ```
 *
 * Only the `config` payload is forwarded to the worker; `kind` is purely
 * a compile-time discriminator. The layer must already exist in the worker
 * (added at mount via `useFluxionCanvas`) — this hook does not create it.
 *
 * Keep configs small (shallow object of primitives). For large configs
 * call `host.configLayer` directly in a memoized effect.
 */
export function useLayerConfig(host: FluxionHost | null, spec: FluxionLayerSpec): void {
  const lastSentRef = useRef<{
    host: FluxionHost;
    id: string;
    config: string | undefined;
  } | null>(null);
  const serialized = JSON.stringify(spec.config);

  useEffect(() => {
    if (!host) {
      lastSentRef.current = null;
      return;
    }
    const last = lastSentRef.current;
    if (last?.host === host && last.id === spec.id && last.config === serialized) return;
    lastSentRef.current = { host, id: spec.id, config: serialized };
    if (spec.config !== undefined) {
      host.configLayer(spec.id, spec.config);
    }
    // `spec` is referenced through `serialized` + `spec.id`; the raw object
    // would defeat the diff (new identity every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, spec.id, serialized]);
}
