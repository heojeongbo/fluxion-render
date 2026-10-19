export interface RequestOptions {
  /** Milliseconds before the Promise rejects with WorkerTimeoutError. */
  timeoutMs?: number;
  /**
   * AbortSignal to cancel the request. When aborted, the Promise rejects
   * with `signal.reason` (or a generic `Error("Aborted")` if reason is not an Error).
   * Useful for React `useEffect` cleanup: create an `AbortController`, pass
   * `signal` to `request()`, and call `controller.abort()` in the cleanup function.
   */
  signal?: AbortSignal;
}

export class WorkerTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Worker request timed out after ${timeoutMs}ms`);
    this.name = "WorkerTimeoutError";
    this.timeoutMs = timeoutMs;
  }

  /** Type-safe alternative to `instanceof WorkerTimeoutError`. */
  static is(e: unknown): e is WorkerTimeoutError {
    return e instanceof WorkerTimeoutError;
  }
}

/**
 * Error thrown by `request()` / `dispatch()` when the worker handler throws.
 * Preserves the worker-side stack trace as `workerStack` so callers can
 * see where the error originated inside the worker.
 */
export class WorkerHandlerError extends Error {
  readonly workerStack?: string;
  constructor(message: string, workerStack?: string) {
    super(message);
    this.name = "WorkerHandlerError";
    this.workerStack = workerStack;
  }

  /** Type-safe alternative to `instanceof WorkerHandlerError`. */
  static is(e: unknown): e is WorkerHandlerError {
    return e instanceof WorkerHandlerError;
  }
}

export interface WorkerPoolStats {
  readonly size: number;
  readonly hostCounts: readonly number[];
  readonly leastBusyIndex: number;
  readonly totalActive: number;
}

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export interface WorkerPoolOptions {
  /** Delay worker creation until start(), acquire(), or stream(). Default false. */
  lazy?: boolean;
  /**
   * Initial number of workers. Default: 4. Clamped to [1, 16]. When `maxSize`
   * is larger, this is the starting count and the pool grows on demand.
   */
  size?: number;
  /**
   * Upper bound for runtime growth. When greater than `size`, the pool starts
   * at `size` workers and spawns more on demand (up to `maxSize`) as the
   * average active hosts per worker reaches `targetPerWorker` — useful for
   * apps whose chart/host count varies widely. Defaults to `size` (growth
   * disabled, fixed-size pool). Clamped to [size, 16].
   */
  maxSize?: number;
  /**
   * Active hosts per worker that triggers growth toward `maxSize`. Lower it for
   * heavier per-host workloads (e.g. high-Hz streaming charts) so the pool
   * spreads hosts across more workers sooner. Default 12. Min 1. Only has an
   * effect when `maxSize > size`.
   */
  targetPerWorker?: number;
  /**
   * Factory function that creates a new Worker instance.
   * Required — the pool has no default because the worker script URL
   * is package-specific and must be provided by the caller.
   *
   * @example
   * // In a bundler environment (Vite, webpack, etc.):
   * workerFactory: () => new Worker(new URL("./my-worker.js", import.meta.url), { type: "module" })
   */
  workerFactory: () => Worker;
}
