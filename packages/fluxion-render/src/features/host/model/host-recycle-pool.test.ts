import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureLifecycleScheduler,
  flushLifecycleScheduler,
  resetLifecycleScheduler,
} from "../../../shared/lib/lifecycle-scheduler";
import { Op } from "../../../shared/protocol";
import { FluxionWorkerHandle, type FluxionWorkerPool } from "../../worker-pool";
import { FluxionHost } from "./fluxion-host";
import { createHostRecyclePool, type HostBundle } from "./host-recycle-pool";

type FakeBundle = HostBundle & {
  host: {
    dispose: ReturnType<typeof vi.fn>;
    releaseBackings: ReturnType<typeof vi.fn>;
  };
};

function makeBundle(key: string): FakeBundle {
  return {
    host: { dispose: vi.fn(), releaseBackings: vi.fn() } as unknown as FluxionHost,
    canvas: {} as HTMLCanvasElement,
    key,
  } as FakeBundle;
}

const fakePool = () => ({}) as unknown as FluxionWorkerPool;

// A bundle around a REAL pool-mode FluxionHost, so `bundle.host.dispose()` runs the
// genuine worker-teardown chain (post → handle → POOL_DISPOSE + slot release). Used
// to prove overflow disposes actually reach the worker — the freeze lived here.
function makePoolHostBundle(key: string) {
  const posts: { msg: unknown }[] = [];
  const onRelease = vi.fn();
  const rawWorker = {
    postMessage: vi.fn((msg: unknown) => {
      posts.push({ msg });
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  } as unknown as Worker;
  const handle = new FluxionWorkerHandle(rawWorker, key, onRelease);
  const pool = { acquire: () => handle } as unknown as FluxionWorkerPool;
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 300;
  const host = new FluxionHost(canvas, { pool });
  posts.length = 0; // drop the POOL_INIT posted on construction
  return { bundle: { host, canvas, key } as HostBundle, posts, onRelease };
}

const hasOp = (posts: { msg: unknown }[], op: number) =>
  posts.some((p) => (p.msg as { op: number }).op === op);

describe("createHostRecyclePool", () => {
  afterEach(() => {
    // Teardowns are deferred through the module-global lifecycle queue — don't
    // leak a pending dispose into the next test.
    resetLifecycleScheduler();
  });

  describe("keyFor", () => {
    it("is stable for identical params and differs for axis presence / render options", () => {
      const pool = createHostRecyclePool();
      const base = { hostOptions: {}, hasXAxis: false, hasYAxis: false };
      expect(pool.keyFor(base)).toBe(pool.keyFor({ ...base }));
      expect(pool.keyFor(base)).not.toBe(pool.keyFor({ ...base, hasXAxis: true }));
      expect(pool.keyFor(base)).not.toBe(pool.keyFor({ ...base, hasYAxis: true }));
      expect(pool.keyFor(base)).not.toBe(
        pool.keyFor({ ...base, hostOptions: { transparent: true } }),
      );
      expect(pool.keyFor(base)).not.toBe(
        pool.keyFor({ ...base, hostOptions: { maxFps: 30 } }),
      );
      expect(pool.keyFor(base)).not.toBe(
        pool.keyFor({ ...base, hostOptions: { emitBounds: false } }),
      );
      expect(pool.keyFor(base)).not.toBe(
        pool.keyFor({ ...base, hostOptions: { emitTicks: false } }),
      );
      // Construction-fixed like the flags above — a stats-on chart must never
      // inherit a stats-off engine (the flag is INIT-only, preserved by reset).
      expect(pool.keyFor(base)).not.toBe(
        pool.keyFor({ ...base, hostOptions: { emitRenderStats: true } }),
      );
    });

    it("separates inline-axes hosts (and distinct margins) from plain ones", () => {
      const pool = createHostRecyclePool();
      const base = { hostOptions: {}, hasXAxis: false, hasYAxis: false };
      const inline = { ...base, hostOptions: { inlineAxes: true } };
      expect(pool.keyFor(base)).not.toBe(pool.keyFor(inline));
      expect(pool.keyFor(inline)).toBe(pool.keyFor({ ...inline }));
      expect(pool.keyFor(inline)).not.toBe(
        pool.keyFor({ ...base, hostOptions: { inlineAxes: true, yAxisWidth: 40 } }),
      );
    });

    it("separates distinct worker pools / factories but is stable per object", () => {
      const pool = createHostRecyclePool();
      const poolA = fakePool();
      const poolB = fakePool();
      const kA = pool.keyFor({
        hostOptions: { pool: poolA },
        hasXAxis: false,
        hasYAxis: false,
      });
      const kB = pool.keyFor({
        hostOptions: { pool: poolB },
        hasXAxis: false,
        hasYAxis: false,
      });
      expect(kA).not.toBe(kB);
      expect(
        pool.keyFor({ hostOptions: { pool: poolA }, hasXAxis: false, hasYAxis: false }),
      ).toBe(kA);

      const fac = (() => undefined) as unknown as () => Worker;
      const kFac = pool.keyFor({
        hostOptions: { workerFactory: fac },
        hasXAxis: false,
        hasYAxis: false,
      });
      expect(kFac).not.toBe(kA);
    });

    it("an explicit recycleKey overrides the derived key", () => {
      const pool = createHostRecyclePool();
      expect(
        pool.keyFor({
          hostOptions: { maxFps: 30 },
          hasXAxis: true,
          hasYAxis: false,
          recycleKey: "mini",
        }),
      ).toBe("mini");
    });

    it("derives a key with no hostOptions (default backing)", () => {
      const pool = createHostRecyclePool();
      expect(pool.keyFor({ hasXAxis: false, hasYAxis: false })).toContain("default");
    });
  });

  it("returns null when empty, then reuses released bundles LIFO", () => {
    const pool = createHostRecyclePool();
    const params = { hostOptions: {}, hasXAxis: false, hasYAxis: false };
    const key = pool.keyFor(params);
    expect(pool.acquire(params)).toBeNull();

    const b1 = makeBundle(key);
    const b2 = makeBundle(key);
    pool.release(b1);
    pool.release(b2);
    expect(pool.size).toBe(2);
    // LIFO: last released returns first.
    expect(pool.acquire(params)).toBe(b2);
    expect(pool.acquire(params)).toBe(b1);
    expect(pool.acquire(params)).toBeNull();
    expect(pool.stats.recycled).toBe(2);
    expect(pool.size).toBe(0);
  });

  it("never reuses across keys — an axis mismatch falls back to a cold create", () => {
    const pool = createHostRecyclePool();
    const noAxis = { hostOptions: {}, hasXAxis: false, hasYAxis: false };
    const withAxis = { hostOptions: {}, hasXAxis: true, hasYAxis: true };
    pool.release(makeBundle(pool.keyFor(noAxis)));
    expect(pool.acquire(withAxis)).toBeNull(); // incompatible → cold
    expect(pool.acquire(noAxis)).not.toBeNull(); // compatible → reuse
  });

  it("defer-disposes a released bundle when its bucket is already at max", () => {
    const pool = createHostRecyclePool({ max: 2 });
    const b1 = makeBundle("k");
    const b2 = makeBundle("k");
    const b3 = makeBundle("k");
    pool.release(b1);
    pool.release(b2);
    pool.release(b3); // bucket full → torn down instead of parked
    // NOT synchronous — the teardown is queued so a bulk-unmount overflow
    // can't burst-free GPU backings inside one commit.
    expect(b3.host.dispose).not.toHaveBeenCalled();
    expect(pool.size).toBe(2);
    flushLifecycleScheduler();
    expect(b3.host.dispose).toHaveBeenCalledTimes(1);
    expect(b1.host.dispose).not.toHaveBeenCalled();
    expect(pool.size).toBe(2);
  });

  it("an overflow bundle is never acquirable between enqueue and drain", () => {
    const pool = createHostRecyclePool({ max: 1 });
    const params = { hostOptions: {}, hasXAxis: false, hasYAxis: false };
    const key = pool.keyFor(params);
    const parked = makeBundle(key);
    const overflow = makeBundle(key);
    pool.release(parked);
    pool.release(overflow); // dispose queued, never parked
    expect(pool.acquire(params)).toBe(parked); // only the parked one is handed out
    expect(pool.acquire(params)).toBeNull();
    flushLifecycleScheduler();
    expect(overflow.host.dispose).toHaveBeenCalledTimes(1);
    expect(parked.host.dispose).not.toHaveBeenCalled();
  });

  it("overflow tears the host's worker engine down for real (posts POOL_DISPOSE)", () => {
    // The user's actual freeze path: a bulk unmount into a recycle pool parks `max`
    // hosts and OVERFLOW-disposes the rest. Before the dispose ordering fix, those
    // overflow disposes silently dropped their worker teardown, leaking a live engine
    // + GPU backing every cycle until the context was lost and the app froze. This
    // asserts the overflow host's dispose actually reaches the worker (POOL_DISPOSE).
    const pool = createHostRecyclePool({ max: 1 });
    const parked = makePoolHostBundle("k");
    const overflow = makePoolHostBundle("k");
    pool.release(parked.bundle); // bucket now holds `max` (1)
    pool.release(overflow.bundle); // full → deferred host.dispose()
    expect(hasOp(overflow.posts, Op.POOL_DISPOSE)).toBe(false); // deferred, not yet
    flushLifecycleScheduler();
    expect(hasOp(overflow.posts, Op.POOL_DISPOSE)).toBe(true);
    expect(overflow.onRelease).toHaveBeenCalledTimes(1);
    // Tidy the parked host so its metrics interval / listeners don't outlive the test.
    pool.dispose();
    flushLifecycleScheduler();
    expect(parked.onRelease).toHaveBeenCalledTimes(1);
  });

  it("spreads overflow disposes across frames on the shared perFrame budget", () => {
    vi.useFakeTimers();
    try {
      configureLifecycleScheduler({ perFrame: 2 });
      const pool = createHostRecyclePool({ max: 0 }); // every release overflows
      const bundles = Array.from({ length: 4 }, () => makeBundle("k"));
      for (const b of bundles) pool.release(b);
      const disposed = () =>
        bundles.filter((b) => b.host.dispose.mock.calls.length > 0).length;
      expect(disposed()).toBe(0); // nothing in the release commit
      vi.advanceTimersByTime(20);
      expect(disposed()).toBe(2); // bounded per frame
      vi.advanceTimersByTime(20);
      expect(disposed()).toBe(4);
    } finally {
      vi.useRealTimers();
      configureLifecycleScheduler({ perFrame: 4 });
    }
  });

  it("isolates a throwing deferred dispose so later ones still run", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createHostRecyclePool({ max: 0 });
    const bad = makeBundle("k");
    bad.host.dispose.mockImplementation(() => {
      throw new Error("boom");
    });
    const ok = makeBundle("k");
    pool.release(bad);
    pool.release(ok);
    flushLifecycleScheduler();
    expect(ok.host.dispose).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("markCreated increments stats.created", () => {
    const pool = createHostRecyclePool();
    expect(pool.stats.created).toBe(0);
    pool.markCreated();
    pool.markCreated();
    expect(pool.stats.created).toBe(2);
  });

  describe("working-set stats", () => {
    const params = { hostOptions: {}, hasXAxis: false, hasYAxis: false };

    it("tracks highWater across interleaved creates, acquires, and releases", () => {
      const pool = createHostRecyclePool();
      const key = pool.keyFor(params);
      pool.markCreated(); // outstanding 1
      pool.markCreated(); // outstanding 2
      pool.markCreated(); // outstanding 3 → high water 3
      expect(pool.stats.highWater).toBe(3);
      pool.release(makeBundle(key)); // outstanding 2
      pool.release(makeBundle(key)); // outstanding 1
      expect(pool.acquire(params)).not.toBeNull(); // warm hit → outstanding 2
      expect(pool.stats.highWater).toBe(3); // high water unchanged
      pool.markCreated(); // outstanding 3
      pool.markCreated(); // outstanding 4 → new high water
      expect(pool.stats.highWater).toBe(4);
    });

    it("clamps outstanding at zero so stray releases can't skew highWater", () => {
      const pool = createHostRecyclePool();
      const key = pool.keyFor(params);
      pool.release(makeBundle(key)); // release without acquire — clamped
      pool.release(makeBundle(key));
      pool.markCreated();
      expect(pool.stats.highWater).toBe(1); // not swallowed by a negative count
    });

    it("counts overflow disposes (bucket-full only, not pool-teardown)", () => {
      const pool = createHostRecyclePool({ max: 1 });
      pool.release(makeBundle("k")); // parked
      pool.release(makeBundle("k")); // overflow
      pool.release(makeBundle("k")); // overflow
      expect(pool.stats.overflowDisposed).toBe(2);
      pool.dispose();
      pool.release(makeBundle("k")); // disposed-pool teardown — NOT an overflow
      expect(pool.stats.overflowDisposed).toBe(2);
    });
  });

  describe("idle shrink (idleShrinkMs)", () => {
    const params = { hostOptions: {}, hasXAxis: false, hasYAxis: false };

    it("releases backings of bundles parked past the threshold, exactly once", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 4000 }); // sweep every 2s
        const key = pool.keyFor(params);
        const b = makeBundle(key);
        pool.release(b);
        vi.advanceTimersByTime(2000); // sweep: parked 2s < 4s → still holding
        expect(b.host.releaseBackings).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2000); // sweep: parked 4s → shrink
        expect(b.host.releaseBackings).toHaveBeenCalledTimes(1);
        expect(pool.stats.shrunk).toBe(1);
        vi.advanceTimersByTime(20_000); // never re-posts for an already-shrunk bundle
        expect(b.host.releaseBackings).toHaveBeenCalledTimes(1);
        expect(pool.size).toBe(1); // still parked and acquirable
        expect(pool.acquire(params)).toBe(b);
      } finally {
        vi.useRealTimers();
      }
    });

    it("an acquire before the threshold never shrinks (and stops the sweep)", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 4000 });
        const b = makeBundle(pool.keyFor(params));
        pool.release(b);
        vi.advanceTimersByTime(2000);
        expect(pool.acquire(params)).toBe(b); // pool now empty → sweep stops
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(20_000);
        expect(b.host.releaseBackings).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-parking re-arms the idle clock and re-shrinks after the full period", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 4000 });
        const b = makeBundle(pool.keyFor(params));
        pool.release(b);
        vi.advanceTimersByTime(4000); // shrunk once; nothing left holding → sweep stops
        expect(b.host.releaseBackings).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        pool.acquire(params);
        pool.release(b); // re-park re-arms the sweep + resets the clock
        vi.advanceTimersByTime(2000);
        expect(b.host.releaseBackings).toHaveBeenCalledTimes(1); // not yet
        vi.advanceTimersByTime(2000);
        expect(b.host.releaseBackings).toHaveBeenCalledTimes(2);
        expect(pool.stats.shrunk).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("staggered parks shrink independently; the sweep runs until all released", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 4000 });
        const key = pool.keyFor(params);
        const b1 = makeBundle(key);
        const b2 = makeBundle(key);
        pool.release(b1);
        vi.advanceTimersByTime(2000);
        pool.release(b2); // parked 2s later
        vi.advanceTimersByTime(2000); // t=4s: b1 shrinks, b2 (2s) still holding
        expect(b1.host.releaseBackings).toHaveBeenCalledTimes(1);
        expect(b2.host.releaseBackings).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2000); // t=6s: b2 shrinks → nothing holding → stop
        expect(b2.host.releaseBackings).toHaveBeenCalledTimes(1);
        // The t=6s sweep revisited b1 — the shrunk-mark must prevent a re-post.
        expect(b1.host.releaseBackings).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("floors the sweep interval at 1s for tiny thresholds", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 100 });
        const b = makeBundle(pool.keyFor(params));
        pool.release(b);
        vi.advanceTimersByTime(999);
        expect(b.host.releaseBackings).not.toHaveBeenCalled(); // sweep hasn't run yet
        vi.advanceTimersByTime(1); // first 1s sweep — 1000ms parked ≥ 100ms
        expect(b.host.releaseBackings).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats non-finite idleShrinkMs (Infinity = never, NaN) as OFF — no ~1ms spin", () => {
      vi.useFakeTimers();
      try {
        for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
          const pool = createHostRecyclePool({ idleShrinkMs: bad });
          const b = makeBundle(pool.keyFor(params));
          pool.release(b);
          // An int32-overflowed setInterval delay would clamp to ~1ms and spin.
          expect(vi.getTimerCount()).toBe(0);
          vi.advanceTimersByTime(60_000);
          expect(b.host.releaseBackings).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("clamps a huge finite idleShrinkMs to a valid timer delay", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 2 ** 40 }); // > int32 ms
        const b = makeBundle(pool.keyFor(params));
        pool.release(b);
        expect(vi.getTimerCount()).toBe(1); // sweep armed with a clamped delay
        vi.advanceTimersByTime(10_000); // far below the clamped threshold
        expect(b.host.releaseBackings).not.toHaveBeenCalled(); // no ~1ms spin-shrink
      } finally {
        vi.useRealTimers();
      }
    });

    it("schedules no timer when idle shrink is off (default)", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool();
        const b = makeBundle(pool.keyFor(params));
        pool.release(b);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(60_000);
        expect(b.host.releaseBackings).not.toHaveBeenCalled();
        expect(pool.stats.shrunk).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("pool dispose stops the sweep before it ever fires", () => {
      vi.useFakeTimers();
      try {
        const pool = createHostRecyclePool({ idleShrinkMs: 4000 });
        const b = makeBundle(pool.keyFor(params));
        pool.release(b);
        pool.dispose(); // stops the sweep; teardown drains via the frame queue
        vi.advanceTimersByTime(60_000);
        expect(b.host.releaseBackings).not.toHaveBeenCalled();
        expect(b.host.dispose).toHaveBeenCalledTimes(1); // deferred teardown ran
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("overflow warning", () => {
    const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => {});

    it("warns once per bucket when overflow disposes cross the threshold", () => {
      const spy = warnSpy();
      const pool = createHostRecyclePool({ max: 0, warnAfterOverflow: 2 });
      pool.release(makeBundle("k")); // 1 — below threshold
      expect(spy).not.toHaveBeenCalled();
      pool.release(makeBundle("k")); // 2 — crosses
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toContain('bucket "k"');
      pool.release(makeBundle("k")); // 3 — already warned for this bucket
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("warns independently per bucket", () => {
      const spy = warnSpy();
      const pool = createHostRecyclePool({ max: 0, warnAfterOverflow: 1 });
      pool.release(makeBundle("a"));
      pool.release(makeBundle("b"));
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it("warnAfterOverflow: 0 disables the warning", () => {
      const spy = warnSpy();
      const pool = createHostRecyclePool({ max: 0, warnAfterOverflow: 0 });
      for (let i = 0; i < 20; i++) pool.release(makeBundle("k"));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("defaults the threshold to 16 overflow disposes", () => {
      const spy = warnSpy();
      const pool = createHostRecyclePool({ max: 0 });
      for (let i = 0; i < 15; i++) pool.release(makeBundle("k"));
      expect(spy).not.toHaveBeenCalled();
      pool.release(makeBundle("k")); // 16th
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  it("dispose defer-tears-down every parked host and refuses further reuse (idempotent)", () => {
    const pool = createHostRecyclePool();
    const key = pool.keyFor({ hostOptions: {}, hasXAxis: false, hasYAxis: false });
    const b1 = makeBundle(key);
    const b2 = makeBundle(key);
    pool.release(b1);
    pool.release(b2);

    pool.dispose();
    // Bundles are unreachable IMMEDIATELY (no resurrection window)…
    expect(pool.isDisposed).toBe(true);
    expect(pool.size).toBe(0);
    expect(
      pool.acquire({ hostOptions: {}, hasXAxis: false, hasYAxis: false }),
    ).toBeNull();
    // …but the actual teardown drains through the frame queue, not in the
    // dispose() call itself (a route change must not burst-free all backings).
    expect(b1.host.dispose).not.toHaveBeenCalled();
    expect(b2.host.dispose).not.toHaveBeenCalled();
    flushLifecycleScheduler();
    expect(b1.host.dispose).toHaveBeenCalledTimes(1);
    expect(b2.host.dispose).toHaveBeenCalledTimes(1);

    // After dispose: release defers a real teardown.
    const b3 = makeBundle(key);
    pool.release(b3);
    expect(b3.host.dispose).not.toHaveBeenCalled();
    flushLifecycleScheduler();
    expect(b3.host.dispose).toHaveBeenCalledTimes(1);

    pool.dispose(); // idempotent — no throw, no double-dispose
    flushLifecycleScheduler();
    expect(b1.host.dispose).toHaveBeenCalledTimes(1);
  });
});
