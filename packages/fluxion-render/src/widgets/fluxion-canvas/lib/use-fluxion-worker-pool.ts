import { useDisposableResource } from "@heojeongbo/fluxion-worker/react";
import { useEffect, useRef } from "react";
import {
  FluxionWorkerPool,
  type FluxionWorkerPoolOptions,
} from "../../../features/worker-pool";

/** Stable non-null pool; worker creation is deferred until commit/first use.
 * Unmount disposes in a microtask, safely preserving StrictMode effect replay.
 * Options are captured on first render, as before.
 */
export function useFluxionWorkerPool(opts: FluxionWorkerPoolOptions): FluxionWorkerPool {
  const optsRef = useRef(opts);
  const pool = useDisposableResource(
    () => new FluxionWorkerPool({ ...optsRef.current, lazy: true }),
  );
  useEffect(() => {
    // A reveal after <Activity> hid us replays effects with the disposed pool
    // before the re-render that hands out its replacement — skip, don't throw.
    if (!pool.isDisposed) pool.start();
  }, [pool]);
  return pool;
}
