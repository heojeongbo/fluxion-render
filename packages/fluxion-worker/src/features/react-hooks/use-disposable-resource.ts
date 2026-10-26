import { type DependencyList, useEffect, useMemo, useRef, useState } from "react";

/**
 * Own a synchronously available resource with a PURE constructor. The factory
 * must not start workers/timers: activate in an effect or lazily on first use.
 * Disposal is deferred one microtask so StrictMode's effect replay can retain
 * the same instance. A real unmount (or dependency change) disposes it exactly once.
 *
 * React 19 `<Activity>` keeps the component's memoized state while running
 * its effect cleanup, so a hidden subtree's resource IS disposed. Revealing it
 * (or any later render) builds a fresh one from the same factory instead of
 * handing back the disposed instance; consumers re-render with it.
 */
export function useDisposableResource<T extends { dispose(): void }>(
  factory: () => T,
  deps: DependencyList = [],
): T {
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const [, setRevision] = useState(0);
  const owner = useMemo(
    () => ({ resource: factory(), retained: false, disposed: false, generation: 0 }),
    deps,
  );
  /* v8 ignore start -- only reachable after <Activity> hid this subtree (React 19); covered by the React 19 consumer smoke in scripts/package-smoke.mjs */
  if (owner.disposed) {
    owner.resource = factoryRef.current();
    owner.disposed = false;
  }
  /* v8 ignore stop */
  useEffect(() => {
    owner.retained = true;
    owner.generation++;
    /* v8 ignore start -- <Activity> reveal without a re-render (React 19); see above */
    if (owner.disposed) {
      owner.resource = factoryRef.current();
      owner.disposed = false;
      setRevision((n) => n + 1);
    }
    /* v8 ignore stop */
    return () => {
      owner.retained = false;
      const generation = ++owner.generation;
      queueMicrotask(() => {
        if (!owner.retained && owner.generation === generation) {
          owner.disposed = true;
          owner.resource.dispose();
        }
      });
    };
  }, [owner]);
  return owner.resource;
}
