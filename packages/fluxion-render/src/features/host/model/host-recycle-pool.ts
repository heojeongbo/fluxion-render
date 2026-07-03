import { enqueueDispose } from "../../../shared/lib/lifecycle-scheduler";
import type { FluxionHost, FluxionHostOptions } from "./fluxion-host";

/**
 * A recyclable chart-host bundle. Because a `FluxionHost` is permanently bound
 * to its DOM `<canvas>` via `transferControlToOffscreen()`, the canvas travels
 * WITH the host: on reuse the canvas DOM node is re-parented into the new
 * mount's container rather than re-created. The axis canvases (when present)
 * are part of the same indivisible unit.
 */
export interface HostBundle {
  host: FluxionHost;
  canvas: HTMLCanvasElement;
  xAxisCanvas?: HTMLCanvasElement;
  yAxisCanvas?: HTMLCanvasElement;
  /** Recycle bucket this bundle belongs to — stamped once at cold create. */
  key: string;
  /** Last bg color applied, so an acquire can skip a redundant `setBgColor`. */
  bgColor?: string;
}

export interface HostRecyclePoolOptions {
  /**
   * Max warm (parked) bundles kept PER recycle key. When a release would exceed
   * this, the host is truly disposed instead of parked. Higher = fewer cold
   * creates under churn, but more idle memory held — each warm host keeps its
   * worker-side Engine + OffscreenCanvas alive. Default `8` (a good fit for a
   * virtualized list whose visible working set is small; raise it toward the
   * concurrent count for a grid that remounts everything at once).
   */
  max?: number;
}

/** Inputs that determine which warm bundles are interchangeable with a mount. */
export interface RecycleKeyParams {
  hostOptions?: FluxionHostOptions;
  hasXAxis: boolean;
  hasYAxis: boolean;
  /** Explicit override — when set, fully replaces the derived key. */
  recycleKey?: string;
}

export interface HostRecyclePool {
  /** Pure: the bucket a mount with these params belongs to. */
  keyFor(params: RecycleKeyParams): string;
  /** Pop a compatible warm bundle, or `null` when none is parked (→ cold create). */
  acquire(params: RecycleKeyParams): HostBundle | null;
  /** Count a cold (fresh) host creation, for `stats.created`. */
  markCreated(): void;
  /**
   * Park a bundle for reuse, or tear it down when its bucket is already full
   * (or the pool is disposed). Teardown is DEFERRED through the shared
   * frame-budgeted lifecycle queue — a bulk unmount that overflows the bucket
   * spreads its `host.dispose()` burst across frames instead of running every
   * teardown synchronously in the unmount commit. In tests, run
   * `flushMountScheduler()` to make the deferred disposes observable.
   */
  release(bundle: HostBundle): void;
  /**
   * Stop accepting new bundles and tear down every parked host — deferred
   * through the shared frame-budgeted lifecycle queue (see {@link release}),
   * so a route change doesn't free every warm backing in one synchronous
   * pass. Parked bundles become unreachable immediately. Idempotent.
   */
  dispose(): void;
  /** Total parked bundles across all buckets. */
  readonly size: number;
  readonly isDisposed: boolean;
  /** Lifetime counters — `created` cold hosts vs `recycled` warm reuses. */
  readonly stats: { created: number; recycled: number };
}

const DEFAULT_MAX = 8;

/**
 * A pool of warm, reusable chart hosts. In churny UIs (virtualized lists,
 * accordions, a grid that remounts) the dominant CPU cost is creating then
 * destroying `FluxionHost`s — each create does an OffscreenCanvas transfer +
 * worker `POOL_INIT` (new Engine + GPU alloc) + first render. This pool keeps a
 * host WARM on unmount (paused via `setVisible(false)`, detached from the DOM)
 * and hands it back on the next compatible mount, where `FluxionHost.reset()`
 * makes it indistinguishable from a fresh one — turning the expensive
 * create→destroy cycle into a cheap re-parent + reset.
 *
 * Bundles are only interchangeable when their construction-fixed options match
 * (worker pool / factory identity, axis-canvas presence, transparent, maxFps,
 * emitBounds, emitTicks); {@link keyFor} encodes that, and an explicit
 * `recycleKey` force-separates incompatible chart families. A request with no
 * matching warm bundle returns `null`, so correctness never depends on a hit.
 */
export function createHostRecyclePool(
  options: HostRecyclePoolOptions = {},
): HostRecyclePool {
  const max = Math.max(0, options.max ?? DEFAULT_MAX);
  // bucket key → LIFO stack of warm bundles (LIFO favors temporal locality).
  const warm = new Map<string, HostBundle[]>();
  // Stable per-object ids so the key separates distinct worker pools / factories
  // without mutating them. A disposed-then-recreated pool gets a new id, so its
  // dead-engine bundles can never be reused for a fresh pool.
  const ids = new WeakMap<object, string>();
  let nextId = 0;
  let disposed = false;
  let created = 0;
  let recycled = 0;

  const idFor = (obj: object | undefined): string => {
    if (!obj) return "default";
    let id = ids.get(obj);
    if (id === undefined) {
      id = `o${++nextId}`;
      ids.set(obj, id);
    }
    return id;
  };

  const keyFor = (p: RecycleKeyParams): string => {
    if (p.recycleKey !== undefined) return p.recycleKey;
    const o = p.hostOptions ?? {};
    // Solo hosts own their worker (workerFactory); pooled hosts share `pool`.
    const backing = (o.workerFactory ?? o.pool) as object | undefined;
    return [
      idFor(backing),
      p.hasXAxis ? "x" : "-",
      p.hasYAxis ? "y" : "-",
      o.transparent ? "T" : "-",
      `f${o.maxFps ?? 0}`,
      o.emitBounds === false ? "b0" : "b1",
      o.emitTicks === false ? "t0" : "t1",
    ].join("|");
  };

  return {
    keyFor,
    get size() {
      let n = 0;
      for (const list of warm.values()) n += list.length;
      return n;
    },
    get isDisposed() {
      return disposed;
    },
    get stats() {
      return { created, recycled };
    },
    markCreated() {
      created++;
    },
    acquire(params) {
      if (disposed) return null;
      const bundle = warm.get(keyFor(params))?.pop();
      if (bundle) {
        recycled++;
        return bundle;
      }
      return null;
    },
    release(bundle) {
      // A disposed pool (or a full bucket) tears the released host down for
      // real — deferred so a bulk unmount's overflow can't burst-free dozens
      // of GPU backings inside one React commit. The bundle never (re-)enters
      // `warm`, so it can't be acquired between enqueue and drain.
      if (disposed) {
        enqueueDispose(() => bundle.host.dispose());
        return;
      }
      let list = warm.get(bundle.key);
      if (!list) {
        list = [];
        warm.set(bundle.key, list);
      }
      if (list.length >= max) {
        enqueueDispose(() => bundle.host.dispose());
        return;
      }
      list.push(bundle);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // `disposed` is set and `warm` cleared BEFORE any queued teardown runs,
      // so a deferred dispose can never resurrect or double-hand-out a bundle.
      for (const list of warm.values()) {
        for (const b of list) enqueueDispose(() => b.host.dispose());
      }
      warm.clear();
    },
  };
}
