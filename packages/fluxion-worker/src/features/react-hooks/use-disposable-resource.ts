import { type DependencyList, useEffect, useMemo } from "react";

/**
 * Own a synchronously available resource with a PURE constructor. The factory
 * must not start workers/timers: activate in an effect or lazily on first use.
 * Disposal is deferred one microtask so StrictMode's effect replay can retain
 * the same instance. A real unmount (or dependency change) disposes it exactly once.
 */
export function useDisposableResource<T extends { dispose(): void }>(
  factory: () => T,
  deps: DependencyList = [],
): T {
  const owner = useMemo(
    () => ({ resource: factory(), retained: false, generation: 0 }),
    deps,
  );
  useEffect(() => {
    owner.retained = true;
    owner.generation++;
    return () => {
      owner.retained = false;
      const generation = ++owner.generation;
      queueMicrotask(() => {
        if (!owner.retained && owner.generation === generation) owner.resource.dispose();
      });
    };
  }, [owner]);
  return owner.resource;
}
