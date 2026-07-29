import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelHostFlush,
  requestHostFlush,
  resetFlushScheduler,
} from "./flush-scheduler";

describe("flush-scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Reset while fake timers are installed so the pending-frame cancel uses
    // the same timer implementation that scheduled it.
    resetFlushScheduler();
    vi.useRealTimers();
  });

  it("N requests share ONE scheduled frame; drain runs them all once", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    requestHostFlush({}, a);
    requestHostFlush({}, b);
    requestHostFlush({}, c);
    expect(rafSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);

    // Drained: nothing re-runs without a new request.
    vi.advanceTimersByTime(100);
    expect(a).toHaveBeenCalledTimes(1);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();
  });

  it("re-requesting the same key before the frame replaces the callback (latest wins)", () => {
    const key = {};
    const stale = vi.fn();
    const fresh = vi.fn();
    requestHostFlush(key, stale);
    requestHostFlush(key, fresh);
    vi.advanceTimersByTime(20);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("a request issued during drain runs on the NEXT frame, not the current one", () => {
    const second = vi.fn();
    const first = vi.fn(() => {
      requestHostFlush({}, second);
    });
    requestHostFlush({}, first);
    vi.advanceTimersByTime(20);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled(); // scheduled, not run in-frame

    vi.advanceTimersByTime(20);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a throwing flush is isolated: later hosts still drain, error is logged", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("flush boom");
    });
    const good = vi.fn();
    requestHostFlush({}, bad);
    requestHostFlush({}, good);
    vi.advanceTimersByTime(20);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("cancelHostFlush: last key cancels the frame, one-of-two keeps it, unknown key no-ops", () => {
    const cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const keyA = {};
    const keyB = {};
    const a = vi.fn();
    const b = vi.fn();
    requestHostFlush(keyA, a);
    requestHostFlush(keyB, b);

    cancelHostFlush({}); // unknown key → early return, frame untouched
    cancelHostFlush(keyA); // one left → frame stays armed
    expect(cafSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);

    requestHostFlush(keyA, a);
    cancelHostFlush(keyA); // last one → frame cancelled
    expect(cafSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(a).not.toHaveBeenCalled();
    cafSpy.mockRestore();
  });

  it("falls back to setTimeout(0)/clearTimeout when rAF is undefined", () => {
    const raf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    const caf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    // biome-ignore lint/performance/noDelete: restoring below
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    // biome-ignore lint/performance/noDelete: restoring below
    delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;

    const a = vi.fn();
    requestHostFlush({}, a);
    vi.advanceTimersByTime(1);
    expect(a).toHaveBeenCalledTimes(1);

    // clearTimeout arm via last-key cancellation.
    const key = {};
    requestHostFlush(key, a);
    cancelHostFlush(key);
    vi.advanceTimersByTime(100);
    expect(a).toHaveBeenCalledTimes(1);

    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = caf;
  });

  it("resetFlushScheduler cancels the armed frame and drops registrations", () => {
    const a = vi.fn();
    requestHostFlush({}, a);
    resetFlushScheduler();
    vi.advanceTimersByTime(100);
    expect(a).not.toHaveBeenCalled();
    // Reset when nothing is armed: cancelFrame's null arm.
    expect(() => resetFlushScheduler()).not.toThrow();
  });
});
