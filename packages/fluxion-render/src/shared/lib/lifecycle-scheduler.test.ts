import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelResize,
  configureMountScheduler,
  enqueueDispose,
  enqueueMount,
  flushMountScheduler,
  getLifecycleStats,
  resetMountScheduler,
  scheduleResize,
} from "./lifecycle-scheduler";

/** Advance one animation frame (fires the faked rAF / setTimeout drain). */
function frame() {
  vi.advanceTimersByTime(20);
}

describe("lifecycle-scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    // reset module defaults + stats counters for the next test
    configureMountScheduler({ perFrame: 4, resizePerFrame: 8 });
    resetMountScheduler();
  });

  it("runs at most perFrame tasks per frame, rescheduling until drained", () => {
    configureMountScheduler({ perFrame: 2 });
    const order: number[] = [];
    for (let i = 0; i < 5; i++) enqueueMount(() => order.push(i));
    // Nothing runs synchronously — the burst is deferred.
    expect(order).toEqual([]);
    frame();
    expect(order).toEqual([0, 1]);
    frame();
    expect(order).toEqual([0, 1, 2, 3]);
    frame();
    expect(order).toEqual([0, 1, 2, 3, 4]);
    frame(); // queue drained → nothing scheduled, no-op
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("dedupes the scheduled frame while one is already pending", () => {
    configureMountScheduler({ perFrame: 1 });
    const order: number[] = [];
    enqueueMount(() => order.push(0));
    enqueueMount(() => order.push(1)); // second enqueue: a frame is already scheduled
    frame();
    expect(order).toEqual([0]); // only perFrame=1 ran on the single frame
    frame();
    expect(order).toEqual([0, 1]);
  });

  it("enqueueDispose defers teardown and shares the perFrame budget with mounts", () => {
    configureMountScheduler({ perFrame: 2 });
    const order: string[] = [];
    enqueueMount(() => order.push("mount"));
    enqueueDispose(() => order.push("dispose1"));
    enqueueDispose(() => order.push("dispose2"));
    expect(order).toEqual([]); // nothing synchronous — teardown burst deferred
    frame();
    expect(order).toEqual(["mount", "dispose1"]); // perFrame=2 across both kinds
    frame();
    expect(order).toEqual(["mount", "dispose1", "dispose2"]);
  });

  it("cancelled tasks are skipped for free (don't consume the perFrame budget)", () => {
    configureMountScheduler({ perFrame: 2 });
    const ran: number[] = [];
    const cancels = Array.from({ length: 6 }, (_, i) => enqueueMount(() => ran.push(i)));
    cancels[0]!(); // cancel tasks 0..3 → only 4 and 5 are live
    cancels[1]!();
    cancels[2]!();
    cancels[3]!();
    frame(); // the 4 tombstones are dropped for free; both live tasks still run
    expect(ran).toEqual([4, 5]);
  });

  it("cancel removes a not-yet-run task; cancelling after it ran is a no-op", () => {
    const ran: string[] = [];
    const cancelA = enqueueMount(() => ran.push("a"));
    enqueueMount(() => ran.push("b"));
    cancelA(); // remove A before its frame
    frame();
    expect(ran).toEqual(["b"]);
    cancelA(); // already gone → no-op, must not throw
    expect(ran).toEqual(["b"]);
  });

  it("flushMountScheduler runs every queued task now, ignoring perFrame", () => {
    configureMountScheduler({ perFrame: 2 });
    const order: number[] = [];
    for (let i = 0; i < 5; i++) enqueueMount(() => order.push(i));
    flushMountScheduler(); // no fake-timer advance — all 5 run synchronously
    expect(order).toEqual([0, 1, 2, 3, 4]);
    // Reusable afterwards: a fresh enqueue schedules a real frame again.
    enqueueDispose(() => order.push(99));
    frame();
    expect(order).toEqual([0, 1, 2, 3, 4, 99]);
  });

  it("flushMountScheduler skips cancelled tasks and isolates a throwing one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    enqueueMount(() => ran.push("a"));
    const cancelB = enqueueMount(() => ran.push("b"));
    enqueueMount(() => {
      throw new Error("boom");
    });
    enqueueMount(() => ran.push("c"));
    cancelB(); // tombstone — skipped by flush
    flushMountScheduler();
    expect(ran).toEqual(["a", "c"]); // b cancelled, the throw didn't strand c
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resetMountScheduler drops queued tasks and clears the pending frame", () => {
    const ran: string[] = [];
    enqueueMount(() => ran.push("a"));
    enqueueMount(() => ran.push("b"));
    resetMountScheduler(); // queue cleared, scheduled flag reset
    frame();
    expect(ran).toEqual([]); // nothing drains
    // Scheduler is reusable afterwards (a fresh frame is scheduled).
    enqueueMount(() => ran.push("c"));
    frame();
    expect(ran).toEqual(["c"]);
  });

  it("isolates a throwing task so later ones in the batch still run", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    enqueueMount(() => {
      throw new Error("boom");
    });
    enqueueMount(() => ran.push("ok"));
    frame();
    expect(ran).toEqual(["ok"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores non-positive / missing perFrame", () => {
    configureMountScheduler({ perFrame: 3 });
    configureMountScheduler({ perFrame: 0 }); // ignored
    configureMountScheduler({ perFrame: -1 }); // ignored
    configureMountScheduler({}); // ignored (undefined)
    const order: number[] = [];
    for (let i = 0; i < 4; i++) enqueueMount(() => order.push(i));
    frame();
    expect(order).toEqual([0, 1, 2]); // perFrame stayed 3
    frame(); // drain the leftover so module state resets cleanly
    expect(order).toEqual([0, 1, 2, 3]);
  });

  describe("resize lane", () => {
    /** A Resizable that records every applied size. */
    function makeTarget() {
      const calls: Array<[number, number, number]> = [];
      return {
        calls,
        resize(width: number, height: number, dpr: number) {
          calls.push([width, height, dpr]);
        },
      };
    }

    it("coalesces repeated schedules for the same target — latest size wins", () => {
      const t = makeTarget();
      scheduleResize(t, { width: 100, height: 50, dpr: 1 });
      scheduleResize(t, { width: 300, height: 150, dpr: 2 });
      expect(t.calls).toEqual([]); // nothing synchronous
      frame();
      expect(t.calls).toEqual([[300, 150, 2]]); // one apply, last size
      frame(); // drained → no further applies
      expect(t.calls).toHaveLength(1);
    });

    it("applies at most resizePerFrame targets per frame, FIFO", () => {
      configureMountScheduler({ resizePerFrame: 2 });
      const targets = Array.from({ length: 5 }, makeTarget);
      for (const t of targets) scheduleResize(t, { width: 10, height: 10, dpr: 1 });
      frame();
      expect(targets.map((t) => t.calls.length)).toEqual([1, 1, 0, 0, 0]);
      frame();
      expect(targets.map((t) => t.calls.length)).toEqual([1, 1, 1, 1, 0]);
      frame();
      expect(targets.map((t) => t.calls.length)).toEqual([1, 1, 1, 1, 1]);
    });

    it("a re-scheduled target keeps its original queue position", () => {
      configureMountScheduler({ resizePerFrame: 1 });
      const a = makeTarget();
      const b = makeTarget();
      scheduleResize(a, { width: 1, height: 1, dpr: 1 });
      scheduleResize(b, { width: 2, height: 2, dpr: 1 });
      scheduleResize(a, { width: 9, height: 9, dpr: 1 }); // update, not re-append
      frame();
      expect(a.calls).toEqual([[9, 9, 1]]); // a still first, with the new size
      expect(b.calls).toEqual([]);
      frame();
      expect(b.calls).toEqual([[2, 2, 1]]);
    });

    it("cancelResize drops a pending resize; a later schedule works again", () => {
      const t = makeTarget();
      scheduleResize(t, { width: 100, height: 100, dpr: 1 });
      cancelResize(t);
      frame();
      expect(t.calls).toEqual([]); // cancelled before its frame
      cancelResize(t); // nothing pending → no-op, must not throw
      scheduleResize(t, { width: 200, height: 200, dpr: 1 });
      frame();
      expect(t.calls).toEqual([[200, 200, 1]]);
    });

    it("task and resize lanes drain in the same frame with independent budgets", () => {
      configureMountScheduler({ perFrame: 1, resizePerFrame: 1 });
      const order: string[] = [];
      enqueueMount(() => order.push("m1"));
      enqueueMount(() => order.push("m2"));
      const a = makeTarget();
      const b = makeTarget();
      scheduleResize(a, { width: 1, height: 1, dpr: 1 });
      scheduleResize(b, { width: 2, height: 2, dpr: 1 });
      frame(); // 1 task + 1 resize in the same frame
      expect(order).toEqual(["m1"]);
      expect(a.calls).toHaveLength(1);
      expect(b.calls).toHaveLength(0);
      frame();
      expect(order).toEqual(["m1", "m2"]);
      expect(b.calls).toHaveLength(1);
    });

    it("isolates a throwing resize so later targets in the batch still apply", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const bad = {
        resize() {
          throw new Error("boom");
        },
      };
      const ok = makeTarget();
      scheduleResize(bad, { width: 1, height: 1, dpr: 1 });
      scheduleResize(ok, { width: 2, height: 2, dpr: 1 });
      frame();
      expect(ok.calls).toHaveLength(1);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("flushMountScheduler applies every pending resize, ignoring the budget", () => {
      configureMountScheduler({ resizePerFrame: 1 });
      const targets = Array.from({ length: 3 }, makeTarget);
      for (const t of targets) scheduleResize(t, { width: 7, height: 7, dpr: 1 });
      flushMountScheduler();
      expect(targets.map((t) => t.calls.length)).toEqual([1, 1, 1]);
    });

    it("resetMountScheduler drops pending resizes without applying them", () => {
      const t = makeTarget();
      scheduleResize(t, { width: 1, height: 1, dpr: 1 });
      resetMountScheduler();
      frame();
      expect(t.calls).toEqual([]);
      // Reusable afterwards.
      scheduleResize(t, { width: 2, height: 2, dpr: 1 });
      frame();
      expect(t.calls).toEqual([[2, 2, 1]]);
    });

    it("ignores non-positive / missing resizePerFrame", () => {
      configureMountScheduler({ resizePerFrame: 2 });
      configureMountScheduler({ resizePerFrame: 0 }); // ignored
      configureMountScheduler({ resizePerFrame: -3 }); // ignored
      configureMountScheduler({}); // ignored (undefined)
      const targets = Array.from({ length: 3 }, makeTarget);
      for (const t of targets) scheduleResize(t, { width: 1, height: 1, dpr: 1 });
      frame();
      expect(targets.map((t) => t.calls.length)).toEqual([1, 1, 0]); // stayed 2
      frame(); // drain the leftover so module state resets cleanly
      expect(targets.map((t) => t.calls.length)).toEqual([1, 1, 1]);
    });
  });

  describe("getLifecycleStats", () => {
    it("counts drained mounts, disposes, and applied resizes separately", () => {
      enqueueMount(() => {});
      enqueueMount(() => {});
      enqueueDispose(() => {});
      scheduleResize({ resize() {} }, { width: 1, height: 1, dpr: 1 });
      frame();
      expect(getLifecycleStats()).toMatchObject({
        mountsRun: 2,
        disposesRun: 1,
        resizesApplied: 1,
        pendingTasks: 0,
        pendingResizes: 0,
      });
    });

    it("gauges pending work, excluding cancelled tasks", () => {
      const cancel = enqueueMount(() => {});
      enqueueMount(() => {});
      enqueueDispose(() => {});
      scheduleResize({ resize() {} }, { width: 1, height: 1, dpr: 1 });
      cancel(); // tombstoned — must not count as pending
      expect(getLifecycleStats()).toMatchObject({
        pendingTasks: 2,
        pendingResizes: 1,
        mountsRun: 0,
      });
    });

    it("counts a flushed queue and is zeroed by resetMountScheduler", () => {
      enqueueMount(() => {});
      enqueueDispose(() => {});
      scheduleResize({ resize() {} }, { width: 1, height: 1, dpr: 1 });
      flushMountScheduler();
      expect(getLifecycleStats()).toMatchObject({
        mountsRun: 1,
        disposesRun: 1,
        resizesApplied: 1,
      });
      resetMountScheduler();
      expect(getLifecycleStats()).toEqual({
        mountsRun: 0,
        disposesRun: 0,
        resizesApplied: 0,
        pendingTasks: 0,
        pendingResizes: 0,
      });
    });
  });

  it("falls back to setTimeout when requestAnimationFrame is unavailable", () => {
    const raf = globalThis.requestAnimationFrame;
    // @ts-expect-error force the no-rAF (worker/SSR) fallback path
    globalThis.requestAnimationFrame = undefined;
    try {
      const ran: string[] = [];
      enqueueMount(() => ran.push("via-timeout"));
      expect(ran).toEqual([]);
      vi.advanceTimersByTime(20); // fires the setTimeout(…, 16)
      expect(ran).toEqual(["via-timeout"]);
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });
});
