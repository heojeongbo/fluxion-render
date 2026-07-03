import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMountScheduler,
  enqueueDispose,
  enqueueMount,
  flushMountScheduler,
  resetMountScheduler,
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
    configureMountScheduler({ perFrame: 4 }); // reset module default for the next test
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
