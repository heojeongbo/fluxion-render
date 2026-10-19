import type { WorkerErrorMsg } from "../../define-worker/define-worker";
import type {
  RequestOptions,
  WorkerPoolOptions,
  WorkerPoolStats,
} from "./worker-contracts";
import { WorkerHandle } from "./worker-handle";

export * from "./worker-contracts";
export { WorkerHandle } from "./worker-handle";

export type WorkerPoolErrorCallback = (err: WorkerErrorMsg, workerIndex: number) => void;

export class WorkerPool<TMsg extends object> {
  // Mutable arrays (push to grow); `readonly` pins the reference, not contents.
  private readonly workers: Worker[] = [];
  // Per-worker active-host counts. Plain number[] (not Int32Array) so it can
  // grow alongside `workers`; ≤16 entries, so the cache benefit is moot.
  private readonly hostCounts: number[] = [];
  private readonly handles: Set<WorkerHandle<TMsg>> = new Set();
  private readonly _workerErrorListeners: EventListener[] = [];
  private readonly _workerFactory: () => Worker;
  private readonly _maxSize: number;
  private readonly _initialSize: number;
  private readonly _targetPerWorker: number;
  private _errorCallback: WorkerPoolErrorCallback | undefined;
  private _seq = 0;
  private _disposed = false;

  /** Returns true if `dispose()` has been called on this pool. */
  get isDisposed(): boolean {
    return this._disposed;
  }

  constructor(opts: WorkerPoolOptions) {
    const size = Math.max(
      1,
      Math.min(Math.floor(Number.isFinite(opts.size) ? opts.size! : 4), 16),
    );
    this._initialSize = size;
    this._workerFactory = opts.workerFactory;
    // maxSize defaults to size (growth disabled) so existing fixed-size callers
    // are unchanged; opt into growth by passing a larger maxSize.
    this._maxSize = Math.max(size, Math.min(opts.maxSize ?? size, 16));
    this._targetPerWorker = Math.max(1, opts.targetPerWorker ?? 12);
    if (!opts.lazy) this.start();
  }

  /** Start a lazy pool. Idempotent; acquire/stream also start it automatically. */
  start(): void {
    if (this._disposed) throw new Error("WorkerPool has been disposed");
    try {
      while (this.workers.length < this._initialSize) this._spawnWorker();
    } catch (error) {
      // A factory may fail partway through construction: release workers
      // already created without calling a subclass override before its init.
      WorkerPool.prototype.dispose.call(this);
      throw error;
    }
  }

  /**
   * Create one worker, append it to the pool, and wire its pool-level error
   * listener so fire-and-forget postMessage errors surface via `onError()`
   * (not silently dropped). Used for both the initial workers and growth.
   */
  private _spawnWorker(): void {
    const index = this.workers.length;
    const worker = this._workerFactory();
    this.workers.push(worker);
    this.hostCounts.push(0);
    const listener: EventListener = (evt: Event) => {
      const d = (evt as MessageEvent).data;
      if (
        d !== null &&
        typeof d === "object" &&
        (d as WorkerErrorMsg).__fluxionError === true &&
        this._errorCallback
      ) {
        this._errorCallback(d as WorkerErrorMsg, index);
      }
    };
    this._workerErrorListeners.push(listener);
    worker.addEventListener("message", listener);
  }

  /**
   * Grow the pool by one worker when the average active hosts per worker has
   * reached `targetPerWorker`, up to `maxSize`. A freshly spawned worker is the
   * least-busy one, so the host being acquired lands on it. No-op at `maxSize`.
   */
  private _maybeGrow(): void {
    if (this.workers.length >= this._maxSize) return;
    let total = 0;
    for (let i = 0; i < this.hostCounts.length; i++) total += this.hostCounts[i]!;
    if (total >= this.workers.length * this._targetPerWorker) this._spawnWorker();
  }

  /**
   * Register a global error handler for this pool. Called whenever any worker
   * reports an error, regardless of which handle sent the triggering message.
   * Returns an `off` function to unregister.
   *
   * @example
   * ```ts
   * const off = pool.onError((err, workerIndex) => {
   *   console.error(`Worker ${workerIndex} error:`, err.message);
   * });
   * // Later: off();
   * ```
   */
  onError(callback: WorkerPoolErrorCallback): () => void {
    this._errorCallback = callback;
    return () => {
      if (this._errorCallback === callback) this._errorCallback = undefined;
    };
  }

  /**
   * Convenience method: acquire a handle, send one request, release, and return the result.
   * Equivalent to `acquire() → request() → release()` in a try/finally block.
   *
   * @example
   * ```ts
   * const result = await pool.dispatch<CalcResultMsg>(
   *   { op: "sum", values },
   *   { timeoutMs: 5000 },
   * );
   * ```
   */
  async dispatch<TResult extends object = object>(
    msg: TMsg,
    opts?: RequestOptions,
    transfer?: Transferable[],
  ): Promise<Omit<TResult, "hostId">> {
    const handle = this.acquire();
    try {
      return await handle.request<TResult>(msg, opts, transfer);
    } finally {
      handle.release();
    }
  }

  /**
   * Route a stream message to the least-busy worker.
   * Fire-and-forget — no acquire/release lifecycle, no Promise, no hostId.
   *
   * Use this for one-way high-frequency fan-out (e.g. feeding raw packets to any
   * available worker for parsing + rendering). For a bi-directional stream channel
   * where the worker needs to push replies back to a specific subscriber, use
   * `acquire()` + `handle.emit()` + `handle.onStream()` instead.
   */
  stream(msg: TMsg, transfer?: Transferable[]): void {
    if (this._disposed) return;
    this.start();
    const index = this._leastBusyIndex();
    const stamped = { ...msg, mode: "stream" as const };
    if (transfer && transfer.length > 0) {
      this.workers[index]!.postMessage(stamped, transfer);
    } else {
      this.workers[index]!.postMessage(stamped);
    }
  }

  acquire(): WorkerHandle<TMsg> {
    if (this._disposed) {
      throw new Error("WorkerPool has been disposed");
    }
    this.start();
    this._maybeGrow();
    const index = this._leastBusyIndex();
    this.hostCounts[index]++;
    const hostId = `host-${++this._seq}`;
    // onRelease wraps _release so that the handles Set is cleaned up regardless
    // of whether the subclass overrides _createHandle.
    const onRelease = () => {
      if (this.handles.delete(handle)) this._release(index);
    };
    const handle = this._createHandle(this.workers[index]!, index, hostId, onRelease);
    this.handles.add(handle);
    return handle;
  }

  /**
   * Override in subclasses to return a custom handle type.
   * Pass `onRelease` to the handle constructor so that `release()` / `dispose()`
   * correctly decrements the pool busy counter and removes the handle from the
   * internal tracking Set.
   */
  protected _createHandle(
    worker: Worker,
    _index: number,
    hostId: string,
    onRelease: () => void,
  ): WorkerHandle<TMsg> {
    return new WorkerHandle<TMsg>(worker, hostId, onRelease);
  }

  _release(workerIndex: number): void {
    if (this._disposed) return;
    const current = this.hostCounts[workerIndex];
    if (current !== undefined && current > 0) this.hostCounts[workerIndex]--;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const handle of this.handles) {
      handle._markTerminated();
    }
    this.handles.clear();
    for (let i = 0; i < this.workers.length; i++) {
      const listener = this._workerErrorListeners[i];
      this.workers[i]!.removeEventListener("message", listener!);
      this.workers[i]!.terminate();
    }
    this._workerErrorListeners.length = 0;
    this._errorCallback = undefined;
  }

  stats(): WorkerPoolStats {
    const size = this.hostCounts.length;
    let leastBusyIndex = 0;
    let minCount = this.hostCounts[0]!;
    let totalActive = 0;
    const hostCounts: number[] = new Array(size);
    for (let i = 0; i < size; i++) {
      const c = this.hostCounts[i]!;
      hostCounts[i] = c;
      totalActive += c;
      if (c < minCount) {
        minCount = c;
        leastBusyIndex = i;
      }
    }
    return { size, hostCounts, leastBusyIndex, totalActive };
  }

  private _leastBusyIndex(): number {
    const counts = this.hostCounts;
    let minIdx = 0;
    let minCount = counts[0]!;
    for (let i = 1; i < counts.length; i++) {
      const c = counts[i]!;
      if (c < minCount) {
        minCount = c;
        minIdx = i;
      }
    }
    return minIdx;
  }
}
