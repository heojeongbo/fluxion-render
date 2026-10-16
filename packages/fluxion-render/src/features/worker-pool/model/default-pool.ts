import type { FluxionWorkerPoolOptions } from "./fluxion-worker-pool";
import { FluxionWorkerPool } from "./fluxion-worker-pool";

let _defaultPool: FluxionWorkerPool | null = null;

function makeDefaultFactory(): () => Worker {
  return () =>
    new Worker(new URL("./fluxion-worker.js", import.meta.url), {
      type: "module",
    });
}

/**
 * Growth ceiling for the default pool: scale with CPU cores but leave one for
 * the main thread, and never exceed the pool's hard cap of 16. Falls back to 4
 * when `navigator.hardwareConcurrency` is unavailable (SSR / older runtimes).
 */
function defaultMaxSize(): number {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.min(16, Math.max(2, cores - 1));
}

export function getDefaultPool(): FluxionWorkerPool {
  if (!_defaultPool) {
    // Start small and grow on demand toward the core-based ceiling — a few
    // charts use a couple of workers; a 100+ chart dashboard fans out wider.
    // targetPerWorker is tuned low because streaming charts are render-heavy.
    const maxSize = defaultMaxSize();
    _defaultPool = new FluxionWorkerPool({
      size: Math.min(2, maxSize),
      maxSize,
      targetPerWorker: 8,
      workerFactory: makeDefaultFactory(),
    });
  }
  return _defaultPool;
}

export function configureDefaultPool(
  opts: Omit<FluxionWorkerPoolOptions, "workerFactory"> &
    Partial<Pick<FluxionWorkerPoolOptions, "workerFactory">>,
): void {
  _defaultPool?.dispose();
  _defaultPool = new FluxionWorkerPool({
    workerFactory: makeDefaultFactory(),
    ...opts,
  });
}
