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

  it("N requests share ONE scheduled flush frame; drain runs them all once", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    requestHostFlush({}, a);
    requestHostFlush({}, b);
    requestHostFlush({}, c);
    // Two rAFs total: the pressure monitor's loop + the ONE shared drain —
    // additional requests must not schedule more.
    expect(rafSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(20);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);

    // Drained: nothing re-runs without a new request (the monitor keeps
    // looping for its linger window, but never re-runs flushes).
    vi.advanceTimersByTime(100);
    expect(a).toHaveBeenCalledTimes(1);
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
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
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

  // ── Pressure governor ─────────────────────────────────────────────────────
  // Recipe: mocked performance.now is the module's sole time source. While
  // streaming (a flush that re-stages itself), TWO rAF timers are live each
  // frame — the monitor loop and the drain, due at the same tick. One
  // advanceTimersToNextTimer() fires BOTH in registration order (monitor
  // first, so a stride change applies to the same frame's drain); the clock
  // is advanced BEFORE to simulate that frame's arrival gap.
  describe("pressure governor", () => {
    let clock = 0;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      clock = 0;
      nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    const frameAt = (gapMs: number) => {
      clock += gapMs;
      vi.advanceTimersToNextTimer();
    };

    /** A flush that re-stages itself — steady streaming. */
    function startStream() {
      const key = {};
      const flush = vi.fn(() => {
        requestHostFlush(key, flush);
      });
      requestHostFlush(key, flush);
      return { key, flush };
    }

    it("degraded main rAF cadence sheds the flush cadence (attack)", () => {
      const { flush } = startStream();
      frameAt(16); // f1: monitor's first frame (no sample); drain #1
      frameAt(16); // f2: seeds intervalEwma; drain #2
      frameAt(16); // f3: pair admits base 16; drain #3
      expect(flush).toHaveBeenCalledTimes(3);

      frameAt(100); // f4: ewma 32.8, ratio 2.05 → stride 2; drainIndex 4 → drains
      expect(flush).toHaveBeenCalledTimes(4);
      frameAt(100); // f5: ratio 2.9 → stride 3; index 5 → shed
      frameAt(100); // f6: ratio 3.6 → stride 4; index 6 → shed
      frameAt(100); // f7: shed
      expect(flush).toHaveBeenCalledTimes(4);
      frameAt(100); // f8 (index 8 % 4 = 0): drains
      expect(flush).toHaveBeenCalledTimes(5);
      frameAt(100); // f9-f11: sheds
      frameAt(100);
      frameAt(100);
      expect(flush).toHaveBeenCalledTimes(5);
      frameAt(100); // f12: drains
      expect(flush).toHaveBeenCalledTimes(6);
    });

    it("releases one step after sustained healthy cadence", () => {
      const { flush } = startStream();
      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16
      frameAt(60); // ewma 24.8, ratio 1.55 → stride 2; index 4 drains

      // Heal at 16 ms: ewma = 16 + 8.8·0.8^n → ratio < 1.25 from heal frame 4,
      // so the healthy counter reaches 60 at heal frame 63.
      for (let i = 0; i < 9; i++) frameAt(16); // n1-9: counter 6

      let before = flush.mock.calls.length;
      for (let i = 0; i < 12; i++) frameAt(16); // n10-21: still stride 2
      expect(flush.mock.calls.length - before).toBe(6); // every 2nd — no early release

      for (let i = 0; i < 45; i++) frameAt(16); // n22-66: counter hits 60 → stride 1

      before = flush.mock.calls.length;
      for (let i = 0; i < 12; i++) frameAt(16);
      expect(flush.mock.calls.length - before).toBe(12); // back to every frame
    });

    it("parks the monitor after the linger window and starts the next session unloaded", () => {
      const { key, flush } = startStream();
      frameAt(16);
      frameAt(16);
      frameAt(16);
      frameAt(100); // stride 2
      frameAt(100); // stride 3 (shed)
      frameAt(100); // stride 4 (shed)
      const streamed = flush.mock.calls.length;

      cancelHostFlush(key); // stop streaming: drain frame cancelled
      // Idle: only the monitor's rAF remains; it parks once the linger window
      // (1 s) passes without flush activity.
      for (let i = 0; i < 70; i++) {
        clock += 16;
        vi.advanceTimersToNextTimer();
      }
      expect(vi.getTimerCount()).toBe(0); // parked — no timers at all

      // Resume: fresh session starts at stride 1 (pressure was reset).
      const s2 = startStream();
      frameAt(16);
      frameAt(16);
      frameAt(16);
      expect(s2.flush).toHaveBeenCalledTimes(3); // every frame drains again
      expect(flush.mock.calls.length).toBe(streamed); // old stream untouched
    });

    it("discards hidden-tab / sleep gaps instead of attacking", () => {
      const { flush } = startStream();
      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16
      // 5 s gap: the monitor discards the sample (and parks for inactivity),
      // but the drain still runs and its re-stage restarts the monitor.
      frameAt(5000);
      expect(flush).toHaveBeenCalledTimes(4);
      frameAt(16);
      frameAt(16);
      frameAt(16);
      frameAt(16);
      expect(flush).toHaveBeenCalledTimes(8); // no false attack

      // The restarted monitor is live again — still healthy afterwards.
      frameAt(16);
      expect(flush).toHaveBeenCalledTimes(9);
    });

    it("never learns a base from implausibly fast intervals", () => {
      const { flush } = startStream();
      for (let i = 0; i < 6; i++) frameAt(2); // candidates 2 < 4 — inert governor
      expect(flush).toHaveBeenCalledTimes(6); // every frame drains
    });

    it("mid-band cadence neither raises the stride nor releases it", () => {
      const { flush } = startStream();
      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16
      frameAt(60); // ratio 1.55 → stride 2; index 4 drains
      expect(flush).toHaveBeenCalledTimes(4);

      // 22 ms cadence → ratio converges to ≈1.38: dead zone. 80 frames ≫ the
      // release threshold, yet the stride must persist.
      const before = flush.mock.calls.length;
      for (let i = 0; i < 80; i++) frameAt(22);
      expect(flush.mock.calls.length - before).toBe(40); // every 2nd throughout
    });
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
