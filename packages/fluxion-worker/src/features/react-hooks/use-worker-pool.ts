import { type DependencyList, useEffect, useRef } from "react";
import { WorkerPool, type WorkerPoolOptions } from "../worker-pool/model/worker-pool";
import { useDisposableResource } from "./use-disposable-resource";

/**
 * A non-null pool with stable identity. Workers start at commit/first use, never
 * during render. Options take effect when deps change. Real unmount disposes
 * the pool in a microtask; StrictMode effect replay keeps the live instance.
 */
export function useWorkerPool<TMsg extends object>(
  opts: WorkerPoolOptions,
  deps: DependencyList = [],
): WorkerPool<TMsg> {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const pool = useDisposableResource(
    () => new WorkerPool<TMsg>({ ...optsRef.current, lazy: true }),
    deps,
  );
  useEffect(() => {
    // A reveal after <Activity> hid us replays effects with the disposed pool
    // before the re-render that hands out its replacement — skip, don't throw.
    if (!pool.isDisposed) pool.start();
  }, [pool]);
  return pool;
}
