/**
 * Worker→main outbound coalescer. Every {@link Engine} on a worker enqueues its
 * per-frame bounds/tick/stats updates here instead of calling `self.postMessage`
 * directly; the worker entry drains the whole outbox once per rendered frame
 * (via {@link FrameDriver.onAfterFrame}) into ONE {@link BatchUpdateMsg} post.
 *
 * Why: with N hosts multiplexed onto one worker, the old path posted up to 3N
 * messages per frame, each waking every one of the N hostId-filtered main-thread
 * listeners — O(N²) delivery work that measurably collapsed the main thread at
 * ~200 charts. Coalescing to one post per frame + one demuxing listener makes it
 * O(N). Latest-wins per host per kind is byte-equivalent to the old "at most one
 * post per kind per frame" gating (bounds epsilon gate, tick interval, 1 s stats
 * window all still live in the engine — this layer only reframes the wire).
 */

import type { BatchEntry, BatchUpdateMsg, SerializedTick } from "../protocol/protocol";
import { WorkerOp } from "../protocol/protocol";

/** Per-host accumulator; `undefined` fields mean "that kind did not fire". */
type Pending = Omit<BatchEntry, "hostId">;

const outbox = new Map<string, Pending>();

function entryFor(hostId: string): Pending {
  let p = outbox.get(hostId);
  if (!p) {
    p = {};
    outbox.set(hostId, p);
  }
  return p;
}

/** Stage this frame's effective y-bounds for `hostId` (latest-wins). */
export function enqueueBounds(
  hostId: string,
  yMin: number,
  yMax: number,
  latestT: number,
): void {
  entryFor(hostId).bounds = { yMin, yMax, latestT };
}

/** Stage this frame's axis ticks for `hostId` (latest-wins). */
export function enqueueTicks(
  hostId: string,
  xTicks: SerializedTick[],
  yTicks: SerializedTick[],
  xRawValues: number[],
): void {
  entryFor(hostId).ticks = { xTicks, yTicks, xRawValues };
}

/** Stage this frame's render-load snapshot for `hostId` (latest-wins). */
export function enqueueStats(
  hostId: string,
  renders: number,
  busyMs: number,
  windowMs: number,
): void {
  entryFor(hostId).stats = { renders, busyMs, windowMs };
}

/**
 * Drain every pending host into one {@link BatchUpdateMsg} and hand it to `post`
 * (the worker's sole `self.postMessage`). A no-op when nothing was staged, so an
 * idle/skip frame posts nothing. The outbox is cleared before `post` runs, so a
 * `post` that re-enters (it cannot, in a real worker) can't drain a half-cleared
 * map.
 */
export function flushOutbound(post: (msg: BatchUpdateMsg) => void): void {
  if (outbox.size === 0) return;
  const updates: BatchEntry[] = [];
  for (const [hostId, p] of outbox) {
    updates.push({ hostId, bounds: p.bounds, ticks: p.ticks, stats: p.stats });
  }
  outbox.clear();
  post({ op: WorkerOp.BATCH_UPDATE, updates });
}

/** Test-only: drop all staged updates so the next test starts empty. */
export function resetOutbox(): void {
  outbox.clear();
}
