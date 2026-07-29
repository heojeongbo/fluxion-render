/**
 * Shared per-global frame loop. Every {@link Scheduler} in a worker (or on the
 * main thread, in tests) registers here instead of owning its own rAF loop, so
 * N engines multiplexed onto one worker cost ONE rAF callback per display
 * frame — all engine renders run back-to-back in a single task, letting the
 * browser batch their canvas presents into one compositor transaction. This is
 * what keeps a 60-chart grid smooth: per-chart loops schedule ~8-9 independent
 * callbacks per worker per frame, which Firefox in particular pays for dearly
 * (each OffscreenCanvas present is a separate surface handoff).
 *
 * The loop is demand-driven: it stops entirely when no subscriber reports
 * further need (idle-stop) and is re-armed by {@link FrameDriver.wake}.
 */

/** Participant in the shared frame loop. */
export interface FrameSubscriber {
  /**
   * Called once per driver frame. Returns whether this subscriber still needs
   * future frames (it is in continuous mode, or a dirty frame is still latched
   * — e.g. a render skipped under an fps cap). When every subscriber returns
   * false the driver goes idle until the next {@link FrameDriver.wake}.
   */
  onFrame(): boolean;
}

/**
 * Load governor: target per-frame JS busy budget. When the EWMA of a frame's
 * total subscriber tick time exceeds this, the driver starts skipping frames
 * (render every 2nd/3rd/4th) so a saturated worker sheds render rate instead
 * of pinning its core — under overload the charts weren't hitting full rate
 * anyway, they were just burning CPU and janking the whole browser (the
 * Firefox 60-chart-grid failure mode: ~1.25 ms/render vs Chromium's ~0.1 ms).
 * Skipped frames keep every scheduler's dirty flag latched — no data is lost,
 * exactly like an explicit `maxFps` cap. ~10 ms of a 16.7 ms frame ≈ 60%
 * utilization; light loads never reach it and are completely unaffected.
 */
const FRAME_BUDGET_MS = 10;
/** Never degrade below every-4th-frame (≥15 fps on a 60 Hz display). */
const MAX_STRIDE = 4;

export class FrameDriver {
  private readonly subs = new Set<FrameSubscriber>();
  private handle: number | null = null;
  // Which timer API scheduled `handle` — cancellation must match it even if the
  // globals change between schedule and cancel (tests delete/restore rAF).
  private usesRaf = false;
  // Load-governor state: EWMA of run-frame busy time, the resulting skip
  // stride, and a frame counter to place the skips.
  private busyEwma = 0;
  private stride = 1;
  private frameIndex = 0;

  /** Register a subscriber. Does not schedule — pair with {@link wake}. */
  add(sub: FrameSubscriber): void {
    this.subs.add(sub);
  }

  /** Unregister a subscriber; cancels the pending frame when none remain. */
  remove(sub: FrameSubscriber): void {
    this.subs.delete(sub);
    if (this.subs.size === 0) this.cancel();
  }

  /** Arm the loop if no frame is pending. O(1) no-op otherwise. */
  wake(): void {
    if (this.handle !== null) return;
    this.schedule();
  }

  /** Cancel any pending frame and drop all subscribers (teardown/test reset). */
  dispose(): void {
    this.cancel();
    this.subs.clear();
  }

  private schedule(): void {
    if (typeof requestAnimationFrame !== "undefined") {
      this.usesRaf = true;
      this.handle = requestAnimationFrame(this.frame);
    } else {
      this.usesRaf = false;
      this.handle = setTimeout(this.frame, 16) as unknown as number;
    }
  }

  private cancel(): void {
    if (this.handle === null) return;
    if (this.usesRaf) {
      cancelAnimationFrame(this.handle);
    } else {
      clearTimeout(this.handle);
    }
    this.handle = null;
  }

  private readonly frame = () => {
    // Clear the handle BEFORE ticking so a wake() issued from inside a
    // subscriber's frame (e.g. an op handler marking a sibling dirty) can
    // schedule the next frame.
    this.handle = null;
    this.frameIndex++;
    if (this.frameIndex % this.stride !== 0) {
      // Load-shed skip: don't tick anyone this frame. Dirty flags stay
      // latched, so nothing is lost. Stride > 1 implies recent over-budget
      // run frames, hence live subscribers — keep the loop armed; the next
      // run frame's keep-alive answer (or remove()) still idles it.
      this.wake();
      return;
    }
    const frameStart = performance.now();
    let keepAlive = false;
    // Snapshot: a subscriber's frame can remove another subscriber (an engine
    // disposing a sibling mid-frame). The has() recheck skips those.
    for (const sub of [...this.subs]) {
      if (!this.subs.has(sub)) continue;
      try {
        if (sub.onFrame()) keepAlive = true;
      } catch (err) {
        // A throwing subscriber must not kill the shared loop for its
        // siblings. It reports no further need (it re-arms via its own next
        // wake) — treating a throw as keep-alive would let a permanently
        // broken subscriber spin the loop forever.
        console.error("[fluxion] frame subscriber error (frame skipped):", err);
      }
    }
    const busy = performance.now() - frameStart;
    // Seed the EWMA with the first observation so a burst is met immediately
    // instead of ramping from zero.
    this.busyEwma = this.busyEwma === 0 ? busy : this.busyEwma * 0.8 + busy * 0.2;
    this.stride = Math.min(
      MAX_STRIDE,
      Math.max(1, Math.ceil(this.busyEwma / FRAME_BUDGET_MS)),
    );
    // wake() (not schedule()) — a mid-frame wake may already have re-armed.
    if (keepAlive) this.wake();
  };
}

let defaultDriver: FrameDriver | null = null;

/** The shared driver for this JS global (one per worker; one on main). */
export function getFrameDriver(): FrameDriver {
  defaultDriver ??= new FrameDriver();
  return defaultDriver;
}

/**
 * Test-only: dispose the shared driver so the next test gets a fresh one.
 * Call while the test's (fake) timer implementation is still installed, so the
 * pending-frame cancel uses the API that scheduled it.
 */
export function resetFrameDriver(): void {
  defaultDriver?.dispose();
  defaultDriver = null;
}
