import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FrameDriver,
  type FrameSubscriber,
  getFrameDriver,
  resetFrameDriver,
} from "./frame-driver";

function sub(onFrame: () => boolean): FrameSubscriber & { calls: () => number } {
  const fn = vi.fn(onFrame);
  return { onFrame: fn, calls: () => fn.mock.calls.length };
}

describe("FrameDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Reset while fake timers are still installed so the pending-frame cancel
    // uses the same timer implementation that scheduled it.
    resetFrameDriver();
    vi.useRealTimers();
  });

  it("wake() schedules exactly one frame; repeated wakes coalesce", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const d = new FrameDriver();
    const a = sub(() => false);
    d.add(a);
    d.wake();
    d.wake();
    d.wake();
    expect(rafSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(1);
    rafSpy.mockRestore();
  });

  it("keep-alive subscriber reschedules; all-false idles the loop", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const d = new FrameDriver();
    let alive = true;
    const a = sub(() => alive);
    d.add(a);
    d.wake();
    vi.advanceTimersByTime(40);
    const whileAlive = a.calls();
    expect(whileAlive).toBeGreaterThanOrEqual(2);

    alive = false;
    vi.advanceTimersByTime(20); // final frame observes false → no reschedule
    const settled = a.calls();
    const rafCount = rafSpy.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(a.calls()).toBe(settled);
    expect(rafSpy.mock.calls.length).toBe(rafCount); // idle: no further scheduling
    rafSpy.mockRestore();
  });

  it("runs every subscriber within one frame; any true keeps the loop alive", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const d = new FrameDriver();
    const a = sub(() => false);
    const b = sub(() => true);
    d.add(a);
    d.add(b);
    d.wake();
    expect(rafSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    // b returned true → next frame runs both again.
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(2);
    rafSpy.mockRestore();
  });

  it("a throwing subscriber is isolated: siblings still tick, loop continues", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = new FrameDriver();
    const bad = sub(() => {
      throw new Error("frame boom");
    });
    const good = sub(() => true);
    d.add(bad);
    d.add(good);
    d.wake();
    vi.advanceTimersByTime(20);
    expect(errSpy).toHaveBeenCalled();
    expect(good.calls()).toBe(1);
    // good keeps the loop alive despite bad throwing every frame.
    vi.advanceTimersByTime(20);
    expect(good.calls()).toBe(2);
    errSpy.mockRestore();
  });

  it("a subscriber removed during another's frame is skipped that frame", () => {
    const d = new FrameDriver();
    const b = sub(() => true);
    const a = sub(() => {
      d.remove(b);
      return true;
    });
    d.add(a);
    d.add(b); // insertion order: a first, then b
    d.wake();
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0); // removed mid-frame before its turn
    d.remove(a);
  });

  it("self-removal from inside onFrame is safe and idles when last", () => {
    const d = new FrameDriver();
    const a = sub(() => {
      d.remove(a);
      return false;
    });
    d.add(a);
    d.wake();
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(a.calls()).toBe(1);
  });

  it("remove() of the last subscriber cancels the pending frame (rAF arm)", () => {
    const cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const d = new FrameDriver();
    const a = sub(() => true);
    d.add(a);
    d.wake();
    d.remove(a);
    expect(cafSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(a.calls()).toBe(0);
    cafSpy.mockRestore();
  });

  it("remove() leaving other subscribers does NOT cancel; unknown sub no-ops", () => {
    const cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const d = new FrameDriver();
    const a = sub(() => false);
    const b = sub(() => false);
    d.add(a);
    d.add(b);
    d.wake();
    d.remove(a);
    expect(cafSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(b.calls()).toBe(1);
    // Removing a subscriber that was never added: set stays non-empty → no cancel.
    d.remove(sub(() => false));
    d.remove(b); // now empty; no pending frame → cancel's null arm
    cafSpy.mockRestore();
  });

  it("falls back to setTimeout(16)/clearTimeout when rAF is undefined", () => {
    const raf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    const caf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    // biome-ignore lint/performance/noDelete: restoring below
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    // biome-ignore lint/performance/noDelete: restoring below
    delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;

    const d = new FrameDriver();
    const a = sub(() => false);
    d.add(a);
    d.wake();
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(1);

    // clearTimeout arm: pending frame cancelled on last-subscriber removal.
    d.wake();
    d.remove(a);
    vi.advanceTimersByTime(100);
    expect(a.calls()).toBe(1);

    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = caf;
  });

  it("dispose() with no pending frame no-ops; with one, cancels it", () => {
    const d = new FrameDriver();
    const a = sub(() => true);
    d.add(a);
    expect(() => d.dispose()).not.toThrow(); // nothing scheduled yet

    d.add(a);
    d.wake();
    d.dispose();
    vi.advanceTimersByTime(100);
    expect(a.calls()).toBe(0);
  });

  it("add() twice is one call per frame (set semantics)", () => {
    const d = new FrameDriver();
    const a = sub(() => false);
    d.add(a);
    d.add(a);
    d.wake();
    vi.advanceTimersByTime(20);
    expect(a.calls()).toBe(1);
    d.remove(a);
  });

  // Governor tests step ONE driver frame at a time (the only timer alive in
  // these tests is the driver's rAF), so frame indexing is exact regardless of
  // the environment's rAF cadence.
  const stepFrame = () => vi.advanceTimersToNextTimer();

  it("load governor: sustained over-budget frames engage a skip stride", () => {
    // Control the clock the driver uses to measure frame busy time.
    const nowSpy = vi.spyOn(performance, "now");
    let clock = 0;
    nowSpy.mockImplementation(() => clock);

    const d = new FrameDriver();
    const heavy = sub(() => {
      clock += 30; // 30 ms busy per run frame → stride = ceil(30/10) = 3
      return true;
    });
    d.add(heavy);
    d.wake();

    stepFrame(); // frame 1 runs (stride still 1) → EWMA 30 → stride 3
    expect(heavy.calls()).toBe(1);
    stepFrame(); // frame 2: load-shed skip
    expect(heavy.calls()).toBe(1);
    stepFrame(); // frame 3 (index 3 % 3 = 0): runs
    expect(heavy.calls()).toBe(2);
    stepFrame(); // frame 4: skip
    stepFrame(); // frame 5: skip
    expect(heavy.calls()).toBe(2);
    stepFrame(); // frame 6: runs
    expect(heavy.calls()).toBe(3);

    d.remove(heavy);
    nowSpy.mockRestore();
  });

  it("load governor: recovers to every-frame ticking once busy falls under budget", () => {
    const nowSpy = vi.spyOn(performance, "now");
    let clock = 0;
    let costMs = 30;
    nowSpy.mockImplementation(() => clock);

    const d = new FrameDriver();
    const s = sub(() => {
      clock += costMs;
      return true;
    });
    d.add(s);
    d.wake();
    stepFrame();
    stepFrame();
    stepFrame();
    expect(s.calls()).toBe(2); // frame 2 was shed — shedding is active

    costMs = 0; // load disappears; the EWMA decays on each run frame
    for (let i = 0; i < 40; i++) stepFrame();
    const before = s.calls();
    stepFrame();
    stepFrame();
    expect(s.calls()).toBe(before + 2); // back to a run every frame

    d.remove(s);
    nowSpy.mockRestore();
  });

  it("load governor: stride is clamped to the max (never below every-4th-frame)", () => {
    const nowSpy = vi.spyOn(performance, "now");
    let clock = 0;
    nowSpy.mockImplementation(() => clock);

    const d = new FrameDriver();
    const heavy = sub(() => {
      clock += 200; // would want stride 20 → clamped to 4
      return true;
    });
    d.add(heavy);
    d.wake();

    stepFrame(); // frame 1 runs
    expect(heavy.calls()).toBe(1);
    stepFrame(); // frame 2: skip
    stepFrame(); // frame 3: skip
    expect(heavy.calls()).toBe(1);
    stepFrame(); // frame 4 (index 4 % 4 = 0): runs
    expect(heavy.calls()).toBe(2);
    stepFrame(); // frames 5-7: all skips
    stepFrame();
    stepFrame();
    expect(heavy.calls()).toBe(2);
    stepFrame(); // frame 8: runs
    expect(heavy.calls()).toBe(3);

    d.remove(heavy);
    nowSpy.mockRestore();
  });

  it("getFrameDriver() memoizes; resetFrameDriver() yields a fresh driver", () => {
    const d1 = getFrameDriver();
    expect(getFrameDriver()).toBe(d1);

    // A pending frame on the singleton is cancelled by reset.
    const a = sub(() => true);
    d1.add(a);
    d1.wake();
    resetFrameDriver();
    vi.advanceTimersByTime(100);
    expect(a.calls()).toBe(0);

    expect(getFrameDriver()).not.toBe(d1);
    // Reset with no singleton allocated: the optional-chain null arm.
    resetFrameDriver();
    expect(() => resetFrameDriver()).not.toThrow();
  });
});
