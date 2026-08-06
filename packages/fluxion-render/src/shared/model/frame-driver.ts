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

/**
 * Cadence governor — the second shedding signal. The busy governor above is
 * blind to compositor overload: with many charts the per-frame JS can be tiny
 * while the sheer volume of OffscreenCanvas presents floods the compositor
 * (measured: Chromium at 200 charts × 60 Hz collapses the MAIN thread to
 * ~31 fps while worker JS busy is ~4%). The tell, verified by measurement, is
 * that the browser then slows rAF DELIVERY to this worker (~23 Hz observed).
 * So we watch the scheduling gap between our frames: `arrival − lastEnd`,
 * which excludes our own work by construction, against a learned base
 * interval, and shed render rate when delivery degrades.
 */
/**
 * The cadence constants are exported: the main-thread flush scheduler
 * (`shared/lib/flush-scheduler`) runs the same attack/release policy against
 * the MAIN thread's rAF cadence — that side covers dirty-driven charts (whose
 * render rate follows the flush cadence), this side covers continuous ones.
 */
/** Attack when rAF delivery has degraded ~1.5× vs the learned base. */
export const CADENCE_ATTACK_RATIO = 1.5;
/**
 * Release counts only genuinely-near-base samples; the 1.25–1.5 band is a
 * hysteresis dead zone (neither raises the stride nor counts as healthy).
 */
export const CADENCE_RELEASE_RATIO = 1.25;
/**
 * Consecutive healthy samples required to step the cadence stride down by ONE
 * (~1 s at a recovered 60 Hz). Shedding hides the overload it fixed, so a
 * signal-driven release would drop straight back to stride 1 and sawtooth;
 * the counter probes downward one step at a time instead.
 */
export const CADENCE_RELEASE_FRAMES = 60;
/**
 * Intervals below this are not a plausible display interval (240 Hz ≈ 4.2 ms)
 * — never admitted into the base. Applied as an admission filter, not a
 * post-min clamp, so a spurious sub-4 ms sample can never pin the base.
 */
export const MIN_BASE_INTERVAL_MS = 4;
/**
 * Base cap: a page born overloaded must not learn its degraded cadence as
 * "healthy" (43 ms delivery would read ratio 1 forever). Real 30 Hz displays
 * stay inert: 33.3 / 25 = 1.33 < the attack ratio.
 */
export const MAX_BASE_INTERVAL_MS = 25;
/** Gaps above this are a hidden tab / system sleep, not overload — discard. */
export const MAX_CADENCE_SAMPLE_MS = 250;
/** Shared ceiling for every shedding mechanism (≥15 fps on a 60 Hz display). */
export const MAX_SHED_STRIDE = MAX_STRIDE;

export class FrameDriver {
  private readonly subs = new Set<FrameSubscriber>();
  // Protocol-agnostic "end of a run frame" callbacks — fired after every
  // subscriber has ticked, on run frames only (a skip frame does no work, so
  // there is nothing to flush). The worker uses this to drain its outbound
  // message batch once per frame regardless of which engines rendered.
  private readonly afterFrameCbs = new Set<() => void>();
  private handle: number | null = null;
  // Which timer API scheduled `handle` — cancellation must match it even if the
  // globals change between schedule and cancel (tests delete/restore rAF).
  private usesRaf = false;
  // Busy-governor state: EWMA of run-frame busy time, the resulting skip
  // stride, and a frame counter to place the skips. `stride` is the EFFECTIVE
  // stride: max(busyStride, cadenceStride).
  private busyEwma = 0;
  private busyStride = 1;
  private stride = 1;
  private frameIndex = 0;
  // Cadence-governor state. `cadenceValid` marks that the previous callback
  // left the loop armed, i.e. this arrival is a consecutive frame whose gap
  // measures browser scheduling — an idle-wake or cancel→rewake gap is not
  // overload and must be discarded. `prevInterval` chains consecutive
  // start-to-start intervals for the pairwise-max base admission (-1 = broken).
  private lastArrival = 0;
  private lastEnd = 0;
  private cadenceValid = false;
  private prevInterval = -1;
  private gapEwma = 0;
  private baseInterval = 0;
  private cadenceStride = 1;
  private healthyFrames = 0;

  /** Register a subscriber. Does not schedule — pair with {@link wake}. */
  add(sub: FrameSubscriber): void {
    this.subs.add(sub);
  }

  /**
   * Register a callback fired once at the end of every RUN frame (after all
   * subscribers tick, skipped on load-shed frames). Returns an unsubscribe.
   * A throwing callback is isolated — it cannot kill the shared loop.
   */
  onAfterFrame(cb: () => void): () => void {
    this.afterFrameCbs.add(cb);
    return () => {
      this.afterFrameCbs.delete(cb);
    };
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
    this.afterFrameCbs.clear();
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
    // A cancelled-then-rewoken loop has a stale arrival timestamp; the first
    // gap after the re-wake is idle time, not overload — discard it.
    this.cadenceValid = false;
  }

  private readonly frame = () => {
    // Clear the handle BEFORE ticking so a wake() issued from inside a
    // subscriber's frame (e.g. an op handler marking a sibling dirty) can
    // schedule the next frame.
    this.handle = null;
    // One clock read serves both the cadence arrival and the busy frameStart.
    const arrival = performance.now();
    // Sample cadence on EVERY callback, run and skip alike — skip frames do no
    // work, so their gaps are the purest samples, and at stride 4 three of
    // four frames are skips: run-only sampling would starve the release
    // detector exactly when release evidence is needed. Note the sample (and
    // any attack it triggers) applies to THIS frame's own skip decision.
    if (this.cadenceValid) {
      this.sampleCadence(arrival);
    } else {
      this.prevInterval = -1;
    }
    this.frameIndex++;
    if (this.frameIndex % this.stride !== 0) {
      // Load-shed skip: don't tick anyone this frame. Dirty flags stay
      // latched, so nothing is lost. Stride > 1 implies recent over-budget
      // run frames, hence live subscribers — keep the loop armed; the next
      // run frame's keep-alive answer (or remove()) still idles it.
      this.lastArrival = arrival;
      this.lastEnd = arrival; // no work this frame: end == start
      this.wake();
      this.cadenceValid = true; // the wake() above always left the loop armed
      return;
    }
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
    // End-of-frame hooks (e.g. draining the worker's outbound message batch)
    // run after every subscriber and are counted in this frame's busy time —
    // the flush IS per-frame presenting work the busy governor should see.
    for (const cb of this.afterFrameCbs) {
      try {
        cb();
      } catch (err) {
        console.error("[fluxion] after-frame callback error:", err);
      }
    }
    const end = performance.now();
    const busy = end - arrival;
    // Seed the EWMA with the first observation so a burst is met immediately
    // instead of ramping from zero.
    this.busyEwma = this.busyEwma === 0 ? busy : this.busyEwma * 0.8 + busy * 0.2;
    this.busyStride = Math.min(
      MAX_STRIDE,
      Math.max(1, Math.ceil(this.busyEwma / FRAME_BUDGET_MS)),
    );
    this.stride = Math.max(this.busyStride, this.cadenceStride);
    this.lastArrival = arrival;
    this.lastEnd = end;
    // wake() (not schedule()) — a mid-frame wake may already have re-armed.
    if (keepAlive) this.wake();
    // Idle-stop means the NEXT arrival's gap is idle time, not overload.
    this.cadenceValid = this.handle !== null;
  };

  /**
   * Cadence sample: `gap` (arrival − previous frame's end) is pure browser
   * scheduling delay — our own busy time is excluded by construction, so the
   * busy governor owns slow-JS frames and this one owns delivery degradation;
   * `max()` composition never double-counts. The base interval is learned
   * from start-to-start intervals via min-of-pairwise-max: contamination of
   * intervals points strictly UP (busy or delay only lengthen them), so a
   * running min converges to the true display interval, and requiring TWO
   * consecutive fast deliveries kills lone rAF double-fires and ProMotion-style
   * 8/16 ms alternation.
   */
  private sampleCadence(arrival: number): void {
    // Clamp: a real browser can't deliver a frame before the previous callback
    // returned, but synthetic clocks (tests) can produce end > next arrival.
    const gap = Math.max(0, arrival - this.lastEnd);
    if (gap > MAX_CADENCE_SAMPLE_MS) {
      // Hidden tab / system sleep — not overload. Also break the pair chain so
      // the base cannot learn a gap-straddling interval.
      this.prevInterval = -1;
      return;
    }
    const interval = arrival - this.lastArrival;
    if (this.prevInterval >= 0) {
      const cand = Math.min(Math.max(interval, this.prevInterval), MAX_BASE_INTERVAL_MS);
      if (cand >= MIN_BASE_INTERVAL_MS) {
        this.baseInterval =
          this.baseInterval === 0 ? cand : Math.min(this.baseInterval, cand);
      }
    }
    this.prevInterval = interval;
    this.gapEwma = this.gapEwma === 0 ? gap : this.gapEwma * 0.8 + gap * 0.2;
    if (this.baseInterval === 0) return;
    const ratio = this.gapEwma / this.baseInterval;
    if (ratio >= CADENCE_ATTACK_RATIO) {
      this.healthyFrames = 0;
      // ratio >= 1.5 ⇒ round(ratio) >= 2, so no lower clamp is needed.
      const want = Math.min(MAX_STRIDE, Math.round(ratio));
      if (want > this.cadenceStride) {
        this.cadenceStride = want;
        this.stride = Math.max(this.busyStride, this.cadenceStride);
      }
    } else if (ratio < CADENCE_RELEASE_RATIO) {
      if (this.cadenceStride > 1 && ++this.healthyFrames >= CADENCE_RELEASE_FRAMES) {
        this.healthyFrames = 0;
        this.cadenceStride--;
        this.stride = Math.max(this.busyStride, this.cadenceStride);
      }
    } else {
      // Mid-band: not degraded enough to raise, not healthy enough to count.
      this.healthyFrames = 0;
    }
  }
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
