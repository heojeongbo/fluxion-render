/**
 * Main-thread receive side of the worker→main batch (see shared/model/outbox.ts
 * and {@link BatchUpdateMsg}). Attaches exactly ONE native `message` listener per
 * underlying Worker and demuxes each frame's {@link BatchUpdateMsg} to the host
 * registered for that `hostId`. This is what keeps receive O(N): one listener
 * invocation + one map lookup per host entry, instead of N hostId-filtered
 * listeners each re-checking every message (the old O(N²) path).
 *
 * Keyed on the SHARED underlying Worker so all pooled hosts on one worker fan out
 * from a single listener; a solo host keys on its own worker object (one entry).
 * Mirrors the shared-singleton + cleanup-on-empty shape of the resize observer
 * (shared/lib/resize-observer.ts) and onscreen observer.
 */

import type { BatchEntry, BatchUpdateMsg } from "../protocol/protocol";
import { WorkerOp } from "../protocol/protocol";

/** Minimal EventTarget surface a worker (or a test fake) exposes. */
export interface BatchTarget {
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
}

interface Registry {
  readonly subs: Map<string, (entry: BatchEntry) => void>;
  readonly handler: EventListener;
}

const registries = new Map<BatchTarget, Registry>();

/**
 * Route this target's BATCH_UPDATE entries for `hostId` to `cb`. The first
 * subscriber for a target installs the shared native listener; the last one to
 * leave (via the returned unsubscribe) removes it. Re-subscribing the same
 * `hostId` replaces the callback.
 */
export function subscribeBatch(
  target: BatchTarget,
  hostId: string,
  cb: (entry: BatchEntry) => void,
): () => void {
  let reg = registries.get(target);
  if (!reg) {
    const subs = new Map<string, (entry: BatchEntry) => void>();
    const handler: EventListener = (evt) => {
      const msg = (evt as MessageEvent<BatchUpdateMsg>).data;
      if (!msg || typeof msg !== "object" || msg.op !== WorkerOp.BATCH_UPDATE) return;
      for (const entry of msg.updates) subs.get(entry.hostId)?.(entry);
    };
    reg = { subs, handler };
    registries.set(target, reg);
    target.addEventListener?.("message", handler);
  }
  reg.subs.set(hostId, cb);
  return () => {
    const r = registries.get(target);
    if (!r) return; // already reset/removed — idempotent
    r.subs.delete(hostId);
    if (r.subs.size === 0) {
      target.removeEventListener?.("message", r.handler);
      registries.delete(target);
    }
  };
}

/** Test-only: detach every shared listener so the next test starts clean. */
export function resetBatchInbox(): void {
  for (const [target, reg] of registries) {
    target.removeEventListener?.("message", reg.handler);
  }
  registries.clear();
}
