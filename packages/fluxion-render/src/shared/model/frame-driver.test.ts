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
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
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

  // ── Cadence governor ──────────────────────────────────────────────────────
  // Recipe: the mocked performance.now clock is the driver's SOLE time source
  // (fake-timer time is never read by the driver). One stepFrame() fires
  // exactly one driver frame; `frameAt(gap)` advances the clock BEFORE the
  // frame fires to simulate the browser delivering it `gap` ms after the
  // previous callback ended, and clock advances INSIDE onFrame simulate busy.
  describe("cadence governor", () => {
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

    it("attacks on degraded delivery with ZERO busy: stride engages from cadence alone", () => {
      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();

      frameAt(16); // f1: no sample (first frame)
      frameAt(16); // f2: seeds gapEwma 16
      frameAt(16); // f3: pair (16,16) admits base 16; ratio 1 → healthy
      expect(a.calls()).toBe(3);

      frameAt(200); // f4: gapEwma 52.8, ratio 3.3 → cadenceStride 3; f4 itself skips
      expect(a.calls()).toBe(3);
      frameAt(200); // f5: gapEwma 82.24, ratio 5.1 → want clamped to 4; skip
      frameAt(200); // f6: want 4 not > 4 (no-raise arm); skip
      frameAt(200); // f7: skip
      expect(a.calls()).toBe(3);
      frameAt(200); // f8 (index 8 % 4 = 0): runs
      expect(a.calls()).toBe(4);
      frameAt(200); // f9-f11: skips
      frameAt(200);
      frameAt(200);
      expect(a.calls()).toBe(4);
      frameAt(200); // f12: runs
      expect(a.calls()).toBe(5);

      d.remove(a);
    });

    it("discards the gap after an idle-stop wake (idle time is not overload)", () => {
      let alive = false;
      const d = new FrameDriver();
      const a = sub(() => alive);
      d.add(a);
      d.wake();

      frameAt(16); // f1 runs, reports no need → loop idles
      expect(a.calls()).toBe(1);

      clock += 500; // long idle — would read as a catastrophic gap if sampled
      alive = true;
      d.wake();
      frameAt(16); // f2: cadenceValid=false → sample discarded
      expect(a.calls()).toBe(2);

      frameAt(16);
      frameAt(16);
      frameAt(16);
      frameAt(16);
      expect(a.calls()).toBe(6); // every frame ran — no false attack

      d.remove(a);
    });

    it("discards huge gaps while armed (hidden tab / system sleep)", () => {
      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();

      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16, gapEwma 16
      expect(a.calls()).toBe(3);

      frameAt(5000); // > MAX_CADENCE_SAMPLE_MS → discarded, frame still runs
      expect(a.calls()).toBe(4);

      frameAt(16);
      frameAt(16);
      frameAt(16);
      frameAt(16);
      expect(a.calls()).toBe(8); // no attack from the sleep gap

      d.remove(a);
    });

    it("releases ONE step only after sustained health (no early or full release)", () => {
      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();

      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16
      frameAt(200); // cadenceStride 3
      frameAt(200); // cadenceStride 4

      // Heal at 16 ms. gapEwma = 16 + 66.24·0.8^n: ratio < 1.25 (healthy)
      // first at n = 13, so the healthy counter reaches 60 at heal frame 72.
      for (let i = 0; i < 12; i++) frameAt(16); // n1-12: attack/mid-band tail
      for (let i = 0; i < 40; i++) frameAt(16); // n13-52: counter 40

      let before = a.calls();
      for (let i = 0; i < 12; i++) frameAt(16); // n53-64: counter ≤ 52, stride 4
      expect(a.calls() - before).toBe(3); // still every 4th — no early release

      for (let i = 0; i < 8; i++) frameAt(16); // n65-72: counter hits 60 → 4→3

      before = a.calls();
      for (let i = 0; i < 12; i++) frameAt(16); // counter restarted: no 2nd release here
      expect(a.calls() - before).toBe(4); // every 3rd — single step, not full release

      d.remove(a);
    });

    it("effective stride is max(busy, cadence): cadence release stops at the busy floor", () => {
      const d = new FrameDriver();
      const a = sub(() => {
        clock += 30; // busy 30 ms per run frame → busyStride 3
        return true;
      });
      d.add(a);
      d.wake();

      frameAt(16); // f1 runs: busyStride 3 (stride 3)
      frameAt(16); // f2: skip; gap = 16 (busy excluded from the gap by design)
      frameAt(16); // f3: interval pair (46, 16) → capped to 25 → base 25; runs
      expect(a.calls()).toBe(2);

      frameAt(200); // gapEwma jumps → cadence attacks
      frameAt(200);
      frameAt(200); // cadenceStride reaches 4 → stride 4 > busy's 3

      let before = a.calls();
      for (let i = 0; i < 12; i++) frameAt(200);
      expect(a.calls() - before).toBe(3); // every 4th while cadence dominates

      // Heal long enough for EVERY possible cadence release (4→3→2→1 needs
      // 180 healthy samples) — the busy floor must keep the stride at 3.
      for (let i = 0; i < 220; i++) frameAt(16);
      before = a.calls();
      for (let i = 0; i < 12; i++) frameAt(16);
      expect(a.calls() - before).toBe(4); // every 3rd: busy floor holds

      d.remove(a);
    });

    it("stays inert on the setTimeout fallback at steady cadence", () => {
      const raf = (globalThis as { requestAnimationFrame?: unknown })
        .requestAnimationFrame;
      const caf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;

      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();
      for (let i = 0; i < 10; i++) frameAt(16);
      expect(a.calls()).toBe(10); // ratio ≈ 1 → every frame runs

      d.remove(a);
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
      (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = caf;
    });

    it("pairwise-max admission: a lone fast outlier cannot drop the base; a consecutive pair can", () => {
      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();

      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16
      frameAt(8); // lone 8 ms double-fire: pair max(8,16)=16 → base stays 16
      for (let i = 0; i < 10; i++) frameAt(16);
      expect(a.calls()).toBe(14); // every frame ran — no false attack vs base 8

      frameAt(8); // consecutive pair of 8s...
      frameAt(8); // ...admits base 8 — 16 ms delivery now reads degraded
      for (let i = 0; i < 4; i++) frameAt(16);
      // gapEwma (≈13-15) vs base 8 crosses the attack ratio → stride 2 engages:
      // of these last 6 frames only some ran.
      expect(a.calls()).toBe(18);

      d.remove(a);
    });

    it("never learns a base from implausibly fast intervals (< 4 ms)", () => {
      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();
      for (let i = 0; i < 10; i++) frameAt(2); // candidates 2 < MIN → never admitted
      expect(a.calls()).toBe(10); // baseInterval 0 → cadence fully inert

      d.remove(a);
    });

    it("mid-band cadence (1.25–1.5×) neither raises nor releases the stride", () => {
      const d = new FrameDriver();
      const a = sub(() => true);
      d.add(a);
      d.wake();

      frameAt(16);
      frameAt(16);
      frameAt(16); // base 16
      frameAt(60); // gapEwma 24.8, ratio 1.55 → cadenceStride 2; f4 (4%2=0) runs
      expect(a.calls()).toBe(4);

      // 22 ms delivery: ratio converges to ≈1.38 — inside the dead zone. 80
      // frames ≫ CADENCE_RELEASE_FRAMES, yet the stride must persist because
      // mid-band samples reset the healthy counter.
      const before = a.calls();
      for (let i = 0; i < 80; i++) frameAt(22);
      expect(a.calls() - before).toBe(40); // exactly every 2nd for the whole run

      d.remove(a);
    });
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

  describe("onAfterFrame", () => {
    it("fires after every run frame, is isolated from throws, and unsubscribes", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const d = new FrameDriver();
      let alive = true;
      d.add(sub(() => alive));

      const after = vi.fn();
      const boom = vi.fn(() => {
        throw new Error("after-frame boom");
      });
      const off = d.onAfterFrame(after);
      d.onAfterFrame(boom);

      d.wake();
      vi.advanceTimersToNextTimer(); // one run frame
      expect(after).toHaveBeenCalledTimes(1);
      expect(boom).toHaveBeenCalledTimes(1);
      // A throwing after-frame callback must not kill the shared loop.
      expect(errSpy).toHaveBeenCalledWith(
        "[fluxion] after-frame callback error:",
        expect.any(Error),
      );

      off(); // unsubscribe `after`; `boom` stays registered
      after.mockClear();
      vi.advanceTimersToNextTimer(); // next run frame
      expect(after).not.toHaveBeenCalled();
      expect(boom.mock.calls.length).toBeGreaterThanOrEqual(2);

      alive = false;
      vi.advanceTimersByTime(100);
      errSpy.mockRestore();
    });
  });
});
