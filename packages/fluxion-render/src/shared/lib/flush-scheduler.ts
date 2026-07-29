/**
 * Shared main-thread flush frame. Every FluxionHost with staged (coalesced)
 * pushes used to schedule its OWN requestAnimationFrame to flush them — with a
 * 60-chart streaming dashboard that is 60 rAF callbacks per display frame,
 * each posting its own messages. This module replaces those with ONE rAF per
 * frame that drains every pending host back-to-back.
 *
 * It also hosts the MAIN-THREAD pressure governor. Dirty-driven charts render
 * when their `Op.DATA` arrives, and DATA ships on this flush frame — so the
 * flush cadence directly controls those charts' render (and canvas-present)
 * rate. When the sheer volume of presents floods the compositor, it is the
 * MAIN thread's rAF delivery that collapses (measured: 200 charts × 60 Hz on
 * Chromium → 31 fps main, worker JS at ~4%), which the worker-side governors
 * cannot see. A lightweight monitor loop — alive only while flushes are
 * actually happening — watches the main rAF cadence directly (so producer
 * data rate cannot fake the signal), and under degradation the drain sheds to
 * every 2nd/3rd/4th frame. Staged samples simply coalesce longer; the
 * per-layer `coalesceMaxFloats` backpressure still bypasses the shed path.
 *
 * Not part of the public API — internal plumbing between FluxionHost and the
 * frame loop. Unlike `lifecycle-scheduler`, there is deliberately NO per-frame
 * budget: staged samples are latency-sensitive (they are this frame's chart
 * data), so every pending host drains every (non-shed) frame.
 */
import {
  CADENCE_ATTACK_RATIO,
  CADENCE_RELEASE_FRAMES,
  CADENCE_RELEASE_RATIO,
  MAX_BASE_INTERVAL_MS,
  MAX_CADENCE_SAMPLE_MS,
  MAX_SHED_STRIDE,
  MIN_BASE_INTERVAL_MS,
} from "../model/frame-driver";

// Latest-wins per host: re-requesting before the frame replaces the callback.
const pending = new Map<object, () => void>();
let scheduled = false;
// Which timer API scheduled `handle` — cancellation must match it even if the
// globals change in between (tests delete/restore rAF).
let usesRaf = false;
let handle: ReturnType<typeof setTimeout> | number | null = null;
let drainIndex = 0;

// ── Pressure monitor ────────────────────────────────────────────────────────
// Runs its own rAF loop while flush activity is recent (and only when rAF
// exists — never in SSR/fallback environments, so the shed path stays
// unreachable there). Consecutive-by-construction frames make the interval a
// direct read of main-thread rAF delivery health.
/** Keep monitoring this long after the last flush request, then park. */
const MONITOR_LINGER_MS = 1000;
let monitorHandle: number | null = null;
let lastActivityAt = 0;
let lastMonitorTs = 0;
let prevInterval = -1;
let intervalEwma = 0;
let baseInterval = 0;
let pressureStride = 1;
let healthyFrames = 0;

function noteFlushActivity(): void {
  lastActivityAt = performance.now();
  if (monitorHandle === null && typeof requestAnimationFrame !== "undefined") {
    lastMonitorTs = 0;
    monitorHandle = requestAnimationFrame(monitorLoop);
  }
}

function monitorLoop(): void {
  monitorHandle = null;
  const now = performance.now();
  if (lastMonitorTs > 0) samplePressure(now - lastMonitorTs);
  lastMonitorTs = now;
  if (now - lastActivityAt > MONITOR_LINGER_MS) {
    // Streaming stopped — park, and start the next session unloaded (if the
    // overload persists it re-attacks within ~2 frames; the learned base is
    // kept, the display did not change).
    prevInterval = -1;
    intervalEwma = 0;
    healthyFrames = 0;
    pressureStride = 1;
    return;
  }
  monitorHandle = requestAnimationFrame(monitorLoop);
}

/**
 * Same attack/release policy as the worker-side cadence governor (constants
 * shared from frame-driver): pairwise-max min base learning, fast attack at
 * 1.5×, slow stepped release after sustained health.
 */
function samplePressure(interval: number): void {
  if (interval > MAX_CADENCE_SAMPLE_MS) {
    // Hidden tab / system sleep — not overload. Break the pair chain too.
    prevInterval = -1;
    return;
  }
  if (prevInterval >= 0) {
    const cand = Math.min(Math.max(interval, prevInterval), MAX_BASE_INTERVAL_MS);
    if (cand >= MIN_BASE_INTERVAL_MS) {
      baseInterval = baseInterval === 0 ? cand : Math.min(baseInterval, cand);
    }
  }
  prevInterval = interval;
  intervalEwma = intervalEwma === 0 ? interval : intervalEwma * 0.8 + interval * 0.2;
  if (baseInterval === 0) return;
  const ratio = intervalEwma / baseInterval;
  if (ratio >= CADENCE_ATTACK_RATIO) {
    healthyFrames = 0;
    // ratio >= 1.5 ⇒ round(ratio) >= 2, so no lower clamp is needed.
    const want = Math.min(MAX_SHED_STRIDE, Math.round(ratio));
    if (want > pressureStride) pressureStride = want;
  } else if (ratio < CADENCE_RELEASE_RATIO) {
    if (pressureStride > 1 && ++healthyFrames >= CADENCE_RELEASE_FRAMES) {
      healthyFrames = 0;
      pressureStride--;
    }
  } else {
    // Mid-band: not degraded enough to raise, not healthy enough to count.
    healthyFrames = 0;
  }
}

/**
 * Run `flush` for `key` on the next shared flush frame. Idempotent per key —
 * callers keep their own cheap "already scheduled" flag so a 500 Hz stage()
 * loop doesn't hit this Map per sample, but double-requesting is harmless.
 */
export function requestHostFlush(key: object, flush: () => void): void {
  noteFlushActivity();
  pending.set(key, flush);
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame !== "undefined") {
    usesRaf = true;
    handle = requestAnimationFrame(drain);
  } else {
    // Parity with the old per-host fallback: a 0 ms macrotask.
    usesRaf = false;
    handle = setTimeout(drain, 0);
  }
}

/**
 * Unregister `key` (host dispose/reset). Cancels the shared frame once nothing
 * is left, so an all-idle page schedules no flush callbacks at all.
 */
export function cancelHostFlush(key: object): void {
  if (!pending.delete(key)) return;
  if (pending.size === 0) cancelFrame();
}

function cancelFrame(): void {
  if (handle !== null) {
    if (usesRaf) {
      cancelAnimationFrame(handle as number);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
    handle = null;
  }
  scheduled = false;
}

function drain(): void {
  drainIndex++;
  if (drainIndex % pressureStride !== 0) {
    // Pressure shed: hold everyone's staged data one more frame. Stride > 1
    // requires the monitor, which requires rAF — safe to re-arm with rAF
    // directly. (An armed frame implies pending is non-empty: emptying it via
    // cancelHostFlush cancels the frame.)
    handle = requestAnimationFrame(drain);
    return;
  }
  // Clear scheduling state BEFORE running: a flush that stages new data (or
  // any re-entrant requestHostFlush) must arm a NEW frame, not be lost.
  scheduled = false;
  handle = null;
  const flushes = [...pending.values()];
  pending.clear();
  for (const flush of flushes) {
    try {
      flush();
    } catch (err) {
      // One host's throwing flush must not starve the others in this frame.
      console.error("[fluxion] flush error:", err);
    }
  }
}

/** Test-only: drop all registrations, cancel frames, reset the governor. */
export function resetFlushScheduler(): void {
  pending.clear();
  cancelFrame();
  if (monitorHandle !== null) {
    cancelAnimationFrame(monitorHandle);
    monitorHandle = null;
  }
  lastActivityAt = 0;
  lastMonitorTs = 0;
  prevInterval = -1;
  intervalEwma = 0;
  baseInterval = 0;
  pressureStride = 1;
  healthyFrames = 0;
  drainIndex = 0;
}
