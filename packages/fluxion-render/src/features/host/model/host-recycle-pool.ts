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
   * worker-side Engine + OffscreenCanvas alive. Default `8`.
   *
   * Sizing guide: for a virtualized list whose visible working set is small,
   * a small `max` is right. For a grid that remounts EVERYTHING at once (a
   * route/key change over 64+ charts), size `max` toward the grid size —
   * otherwise each remount cycle recycles only `max` hosts and cold-creates +
   * overflow-disposes the rest, re-paying the full GPU allocation burst the
   * pool exists to avoid. `stats.highWater` reports the concurrent working
   * set actually observed; the pool warns (see {@link warnAfterOverflow})
   * when overflow churn suggests `max` is undersized.
   */
  max?: number;
  /**
   * Overflow-churn warning threshold. When a single recycle bucket has
   * overflow-disposed this many bundles (releases that found the bucket full
   * and tore the host down instead of parking it), a one-time `console.warn`
   * for that bucket reports the observed `stats.highWater` and recommends
   * raising `max`. Default `16`; pass `0` (or negative) to disable.
   */
  warnAfterOverflow?: number;
  /**
   * Idle shrink: after a bundle has been PARKED this many milliseconds, free
   * its worker-side GPU backings (`FluxionHost.releaseBackings` — main + axis
   * canvases shrink to 0×0) while keeping the host warm. The next acquire's
   * mount-sequence `resize` re-allocates the backing, and that realloc runs
   * inside the frame-budgeted mount task, so re-warm waves stay bounded.
   *
   * This is what makes a LARGE `max` safe: without it, a pool sized for a
   * 64-chart grid parks 64 × (1–3) full-size GPU surfaces indefinitely —
   * trading the allocation burst for idle GPU memory pressure. Default off
   * (`0`): with the default `max` of 8, parked memory is modest.
   */
  idleShrinkMs?: number;
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
   * `flushLifecycleScheduler()` to make the deferred disposes observable.
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
  /**
   * Lifetime counters. `created` cold hosts vs `recycled` warm reuses tell you
   * the hit rate; `overflowDisposed` counts releases that found their bucket
   * full and tore the host down (churn the pool failed to absorb — if this
   * grows every remount cycle, `max` is undersized); `highWater` is the
   * largest number of concurrently outstanding (acquired or cold-created,
   * not yet released) hosts — the working set `max` should be sized against;
   * `shrunk` counts idle-release actions (see `idleShrinkMs`) — a re-parked
   * bundle re-earns its idle period, so one bundle can be counted repeatedly.
   */
  readonly stats: {
    created: number;
    recycled: number;
    overflowDisposed: number;
    highWater: number;
    shrunk: number;
  };
}

const DEFAULT_MAX = 8;
const DEFAULT_WARN_AFTER_OVERFLOW = 16;

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
 * emitBounds, emitTicks, emitRenderStats); {@link keyFor} encodes that, and an explicit
 * `recycleKey` force-separates incompatible chart families. A request with no
 * matching warm bundle returns `null`, so correctness never depends on a hit.
 */
export function createHostRecyclePool(
  options: HostRecyclePoolOptions = {},
): HostRecyclePool {
  const max = Math.max(0, options.max ?? DEFAULT_MAX);
  const warnAfterOverflow = options.warnAfterOverflow ?? DEFAULT_WARN_AFTER_OVERFLOW;
  const rawIdleShrink = options.idleShrinkMs ?? 0;
  // Non-finite (Infinity = "never shrink", NaN) means OFF, and huge finite
  // values are clamped to the max 32-bit timer delay — both would otherwise
  // overflow setInterval's int32 delay and spin the sweep at ~1ms forever.
  const idleShrinkMs = Number.isFinite(rawIdleShrink)
    ? Math.min(Math.max(0, rawIdleShrink), 2_147_483_647)
    : 0;
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
  let overflowDisposed = 0;
  let shrunk = 0;
  // Working-set tracking: outstanding = hosts handed out (warm hit or cold
  // create) and not yet released. Its high-water mark is what `max` should be
  // sized against. Clamped at 0 so a stray release can't skew it negative.
  let outstanding = 0;
  let highWater = 0;
  // Per-bucket overflow counts + once-per-bucket warn guard (arity-guard pattern).
  const overflowByKey = new Map<string, number>();
  const warnedKeys = new Set<string>();
  // Idle shrink bookkeeping. `parkedAt` stamps park time; `shrunkSet` marks
  // bundles whose backings are already released so the sweep never re-posts.
  // Both are weak: a bundle that leaves the pool carries no residue.
  const parkedAt = new WeakMap<HostBundle, number>();
  const shrunkSet = new WeakSet<HostBundle>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const totalParked = (): number => {
    let n = 0;
    for (const list of warm.values()) n += list.length;
    return n;
  };

  const stopSweep = (): void => {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };

  const sweep = (): void => {
    const now = Date.now();
    // Count bundles that still HOLD a backing; when none remain, the timer has
    // nothing left to do — stop it (the next park re-arms).
    let holding = 0;
    for (const list of warm.values()) {
      for (const b of list) {
        if (shrunkSet.has(b)) continue;
        if (now - (parkedAt.get(b) as number) >= idleShrinkMs) {
          shrunkSet.add(b);
          shrunk++;
          b.host.releaseBackings();
        } else {
          holding++;
        }
      }
    }
    if (holding === 0) stopSweep();
  };

  const startSweep = (): void => {
    if (idleShrinkMs <= 0 || sweepTimer !== null) return;
    // Sweep at half the idle threshold (floor 1s) — worst-case a bundle holds
    // its backing one sweep period past the threshold (≈1.5× idleShrinkMs for
    // thresholds ≥2s; the 1s floor dominates below), for a coarse cheap timer.
    sweepTimer = setInterval(sweep, Math.max(1000, Math.floor(idleShrinkMs / 2)));
  };

  const trackAcquired = (): void => {
    outstanding++;
    if (outstanding > highWater) highWater = outstanding;
  };

  const trackOverflow = (key: string): void => {
    overflowDisposed++;
    const n = (overflowByKey.get(key) ?? 0) + 1;
    overflowByKey.set(key, n);
    if (warnAfterOverflow > 0 && n >= warnAfterOverflow && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(
        `[fluxion] host recycle pool: bucket "${key}" has overflow-disposed ` +
          `${n} hosts (max=${max}, observed high-water ${highWater} concurrent). ` +
          "Each overflow re-pays the full host create/destroy cost the pool " +
          "exists to avoid. Raise `max` toward the high-water mark, and set " +
          "`idleShrinkMs` so the larger warm pool doesn't hold idle GPU memory.",
      );
    }
  };

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
      // Construction-fixed like the flags above: INIT-only, preserved by
      // Engine.reset(), never re-sent on warm reuse — so a stats-on chart must
      // never inherit a stats-off engine (or vice versa).
      o.emitRenderStats ? "r1" : "r0",
      // Inline-axes margins are baked into the engine's viewport at INIT —
      // a warm inline host (or one with different margins) must never be
      // handed to a mount expecting a different plot rect.
      o.inlineAxes ? `i${o.xAxisHeight ?? 30}x${o.yAxisWidth ?? 60}` : "-",
    ].join("|");
  };

  return {
    keyFor,
    get size() {
      return totalParked();
    },
    get isDisposed() {
      return disposed;
    },
    get stats() {
      return { created, recycled, overflowDisposed, highWater, shrunk };
    },
    markCreated() {
      created++;
      trackAcquired();
    },
    acquire(params) {
      if (disposed) return null;
      const bundle = warm.get(keyFor(params))?.pop();
      if (bundle) {
        recycled++;
        trackAcquired();
        // Nothing left parked → the idle-shrink sweep has nothing to watch.
        if (sweepTimer !== null && totalParked() === 0) stopSweep();
        return bundle;
      }
      return null;
    },
    release(bundle) {
      outstanding = Math.max(0, outstanding - 1);
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
        trackOverflow(bundle.key);
        enqueueDispose(() => bundle.host.dispose());
        return;
      }
      // Stamp the park time and clear any previous shrink mark (a re-parked
      // bundle re-earns its idle period), then make sure the sweep is running.
      parkedAt.set(bundle, Date.now());
      shrunkSet.delete(bundle);
      startSweep();
      list.push(bundle);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSweep();
      // `disposed` is set and `warm` cleared BEFORE any queued teardown runs,
      // so a deferred dispose can never resurrect or double-hand-out a bundle.
      for (const list of warm.values()) {
        for (const b of list) enqueueDispose(() => b.host.dispose());
      }
      warm.clear();
    },
  };
}
