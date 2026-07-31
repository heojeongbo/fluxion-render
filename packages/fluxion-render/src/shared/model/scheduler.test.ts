import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameDriver, resetFrameDriver } from "./frame-driver";
import { Scheduler } from "./scheduler";

describe("Scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Reset the shared driver BEFORE restoring real timers so its pending
    // frame is cancelled with the fake-timer API that scheduled it.
    resetFrameDriver();
    vi.useRealTimers();
  });

  it("only ticks when marked dirty", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    // advance several frames — no ticks yet
    vi.advanceTimersByTime(100);
    expect(tick).not.toHaveBeenCalled();

    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);

    // dirty is consumed after tick
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1);

    s.stop();
  });

  it("coalesces multiple markDirty into a single tick per frame", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.markDirty();
    s.markDirty();
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("stop prevents further ticks", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.stop();
    s.markDirty();
    vi.advanceTimersByTime(100);
    expect(tick).not.toHaveBeenCalled();
  });

  it("start is idempotent", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("passes dirty=true to tick for a markDirty-triggered frame", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenLastCalledWith(true);
    s.stop();
  });

  it("passes dirty=false to tick for a pure continuous frame", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.setContinuous(true);
    // First frame: setContinuous flips dirty=true, so it reports dirty.
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenLastCalledWith(true);
    // Subsequent frames run purely off continuous — dirty=false.
    vi.advanceTimersByTime(40);
    expect(tick).toHaveBeenLastCalledWith(false);
    s.stop();
  });

  it("continuous mode ticks every frame without markDirty", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.setContinuous(true);
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    // Keeps firing on subsequent frames with no markDirty.
    vi.advanceTimersByTime(40);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    s.stop();
  });

  it("setContinuous(false) returns to dirty-gated behavior", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.setContinuous(true);
    vi.advanceTimersByTime(40);
    const afterContinuous = tick.mock.calls.length;
    expect(afterContinuous).toBeGreaterThanOrEqual(1);

    s.setContinuous(false);
    // Drain the pending dirty frame, if any.
    vi.advanceTimersByTime(20);
    const baseline = tick.mock.calls.length;
    // No further ticks without markDirty.
    vi.advanceTimersByTime(100);
    expect(tick.mock.calls.length).toBe(baseline);
    s.stop();
  });

  it("continuous mode respects stop()", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.setContinuous(true);
    s.stop();
    vi.advanceTimersByTime(100);
    expect(tick).not.toHaveBeenCalled();
  });

  it("uses setTimeout fallback when requestAnimationFrame is undefined", () => {
    const raf = (globalThis as any).requestAnimationFrame;
    const caf = (globalThis as any).cancelAnimationFrame;
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;

    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();

    (globalThis as any).requestAnimationFrame = raf;
    (globalThis as any).cancelAnimationFrame = caf;
  });

  it("stop() before start() is a no-op (no raf to cancel)", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    // raf is null — the `this.raf != null` guard takes its false arm.
    expect(() => s.stop()).not.toThrow();
    expect(tick).not.toHaveBeenCalled();
  });

  it("a frame re-scheduled during a tick bails out once running is false", () => {
    const tick = vi.fn(() => {
      // Stopping mid-tick clears the in-flight handle, but loop() still
      // re-schedules a fresh frame afterward; that frame must early-return.
      s.stop();
    });
    const s = new Scheduler(tick);
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    // The re-scheduled frame fires with running=false → loop early-returns,
    // so no further ticks.
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("uses clearTimeout when cancelAnimationFrame is undefined on stop", () => {
    const raf = (globalThis as any).requestAnimationFrame;
    const caf = (globalThis as any).cancelAnimationFrame;
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).cancelAnimationFrame;

    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(10);
    expect(() => s.stop()).not.toThrow();

    (globalThis as any).requestAnimationFrame = raf;
    (globalThis as any).cancelAnimationFrame = caf;
  });

  it("setMaxFps caps the render rate: skips frames under the interval, latches dirty", () => {
    // Control the render clock directly so the throttle is deterministic
    // regardless of the fake-timer/rAF cadence.
    const nowSpy = vi.spyOn(performance, "now");
    let clock = 1000;
    nowSpy.mockImplementation(() => clock);

    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.setMaxFps(30); // ~33.3 ms minimum between renders
    s.start();

    s.markDirty();
    clock = 1000; // first eligible frame (lastRender = -Inf) → renders
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);

    s.markDirty();
    clock = 1010; // +10 ms since last render → under interval → skip, dirty latched
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);

    clock = 1050; // +50 ms since last render → past interval → latched dirty renders
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(2);

    s.stop();
    nowSpy.mockRestore();
  });

  it("survives a throwing tick: keeps rescheduling so the next frame renders", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let throwOnce = true;
    const tick = vi.fn(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("render boom");
      }
    });
    const s = new Scheduler(tick);
    s.start();

    s.markDirty();
    vi.advanceTimersByTime(20); // first frame throws — must NOT kill the loop
    expect(tick).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();

    s.markDirty();
    vi.advanceTimersByTime(20); // loop still alive → next frame renders cleanly
    expect(tick).toHaveBeenCalledTimes(2);

    s.stop();
    errSpy.mockRestore();
  });

  it("idle-stop: after a dirty frame renders, no further frames are scheduled", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(40); // render + the trailing frame that observes idle
    expect(tick).toHaveBeenCalledTimes(1);

    const settled = rafSpy.mock.calls.length;
    vi.advanceTimersByTime(200); // idle: the shared loop must be stopped
    expect(rafSpy.mock.calls.length).toBe(settled);

    s.markDirty(); // wakes the loop again
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(2);
    s.stop();
    rafSpy.mockRestore();
  });

  it("accepts an explicitly injected driver", () => {
    const driver = new FrameDriver();
    const tick = vi.fn();
    const s = new Scheduler(tick, driver);
    s.start();
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
    driver.dispose();
  });

  it("two schedulers share one driver: continuous ticks every frame, dirty-gated only when marked, and a throwing tick never starves the sibling", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const continuousTick = vi.fn(() => {
      throw new Error("render boom");
    });
    const cont = new Scheduler(continuousTick);
    const gatedTick = vi.fn();
    const gated = new Scheduler(gatedTick);
    cont.start();
    gated.start();
    cont.setContinuous(true);

    vi.advanceTimersByTime(40);
    expect(continuousTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(gatedTick).not.toHaveBeenCalled(); // never marked dirty
    expect(errSpy).toHaveBeenCalled();

    gated.markDirty();
    vi.advanceTimersByTime(20);
    expect(gatedTick).toHaveBeenCalledTimes(1); // sibling unaffected by throws

    cont.stop();
    gated.stop();
    errSpy.mockRestore();
  });

  it("setContinuous(true) before start() does not schedule; start() then renders", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.setContinuous(true); // not running → must not wake the driver
    vi.advanceTimersByTime(100);
    expect(tick).not.toHaveBeenCalled();

    s.start();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalled();
    s.stop();
  });

  it("stop() from inside a continuous tick idles the driver", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const tick = vi.fn(() => s.stop());
    const s = new Scheduler(tick);
    s.start();
    s.setContinuous(true);
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);

    const settled = rafSpy.mock.calls.length;
    vi.advanceTimersByTime(200);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(rafSpy.mock.calls.length).toBe(settled); // no extra keep-alive frame
    rafSpy.mockRestore();
  });

  it("setPaused suspends rendering, latches dirty, and resumes on unpause", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.setPaused(true);

    // Dirty while paused: latched, but NO frame fires.
    s.markDirty();
    vi.advanceTimersByTime(100);
    expect(tick).not.toHaveBeenCalled();

    // Resume: the latched dirty renders in one frame (full-history catch-up).
    s.setPaused(false);
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("does not wake the driver on markDirty while paused (no wasted frames)", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    // Drain the start() wake so the loop is idle before we pause.
    vi.advanceTimersByTime(40);
    s.setPaused(true);
    const settled = rafSpy.mock.calls.length;

    s.markDirty();
    s.markDirty();
    vi.advanceTimersByTime(200);
    // Paused markDirty must schedule NOTHING — an off-screen chart can't burn a
    // frame per incoming data message.
    expect(rafSpy.mock.calls.length).toBe(settled);
    expect(tick).not.toHaveBeenCalled();
    s.stop();
    rafSpy.mockRestore();
  });

  it("setPaused(false) with nothing pending schedules no frame", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    vi.advanceTimersByTime(40); // idle
    s.setPaused(true);
    const settled = rafSpy.mock.calls.length;
    s.setPaused(false); // no dirty, not continuous → no wake
    vi.advanceTimersByTime(100);
    expect(rafSpy.mock.calls.length).toBe(settled);
    expect(tick).not.toHaveBeenCalled();
    s.stop();
    rafSpy.mockRestore();
  });

  it("pause suspends a continuous loop; resume restores it", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    s.setContinuous(true);
    vi.advanceTimersByTime(40);
    const before = tick.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    s.setPaused(true);
    vi.advanceTimersByTime(200);
    expect(tick.mock.calls.length).toBe(before); // continuous frozen while paused

    s.setPaused(false);
    vi.advanceTimersByTime(40);
    expect(tick.mock.calls.length).toBeGreaterThan(before); // resumes scrolling
    s.stop();
  });

  it("setContinuous(true) while paused does not wake the driver", () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.start();
    vi.advanceTimersByTime(40);
    s.setPaused(true);
    const settled = rafSpy.mock.calls.length;
    s.setContinuous(true); // paused → must not schedule
    vi.advanceTimersByTime(100);
    expect(rafSpy.mock.calls.length).toBe(settled);
    expect(tick).not.toHaveBeenCalled();
    s.stop();
    rafSpy.mockRestore();
  });

  it("setMaxFps(undefined) / non-positive restores uncapped rendering", () => {
    const tick = vi.fn();
    const s = new Scheduler(tick);
    s.setMaxFps(30);
    s.setMaxFps(-1); // non-positive → uncapped
    s.start();

    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(1);

    s.markDirty();
    vi.advanceTimersByTime(20); // uncapped → renders again next frame
    expect(tick).toHaveBeenCalledTimes(2);

    s.setMaxFps(undefined); // also uncapped
    s.markDirty();
    vi.advanceTimersByTime(20);
    expect(tick).toHaveBeenCalledTimes(3);

    s.stop();
  });
});
