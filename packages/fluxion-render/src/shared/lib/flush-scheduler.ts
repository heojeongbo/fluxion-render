/**
 * Shared main-thread flush frame. Every FluxionHost with staged (coalesced)
 * pushes used to schedule its OWN requestAnimationFrame to flush them — with a
 * 60-chart streaming dashboard that is 60 rAF callbacks per display frame,
 * each posting its own messages. This module replaces those with ONE rAF per
 * frame that drains every pending host back-to-back.
 *
 * Not part of the public API — internal plumbing between FluxionHost and the
 * frame loop. Unlike `lifecycle-scheduler`, there is deliberately NO per-frame
 * budget: staged samples are latency-sensitive (they are this frame's chart
 * data), so every pending host drains every frame.
 */

// Latest-wins per host: re-requesting before the frame replaces the callback.
const pending = new Map<object, () => void>();
let scheduled = false;
// Which timer API scheduled `handle` — cancellation must match it even if the
// globals change in between (tests delete/restore rAF).
let usesRaf = false;
let handle: ReturnType<typeof setTimeout> | number | null = null;

/**
 * Run `flush` for `key` on the next shared flush frame. Idempotent per key —
 * callers keep their own cheap "already scheduled" flag so a 500 Hz stage()
 * loop doesn't hit this Map per sample, but double-requesting is harmless.
 */
export function requestHostFlush(key: object, flush: () => void): void {
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

/** Test-only: drop all registrations and cancel any scheduled frame. */
export function resetFlushScheduler(): void {
  pending.clear();
  cancelFrame();
}
