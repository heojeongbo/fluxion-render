import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerOp } from "../protocol/protocol";
import { type BatchTarget, resetBatchInbox, subscribeBatch } from "./batch-inbox";

// A fake worker target: captures the single shared `message` listener and lets
// tests fire arbitrary payloads through it, plus counts add/remove for the
// share/cleanup assertions.
function fakeTarget() {
  let handler: EventListener | null = null;
  let added = 0;
  let removed = 0;
  const target: BatchTarget = {
    addEventListener(_type, listener) {
      added++;
      handler = listener;
    },
    removeEventListener() {
      removed++;
      handler = null;
    },
  };
  return {
    target,
    fire: (data: unknown) => handler?.({ data } as unknown as Event),
    hasHandler: () => handler !== null,
    added: () => added,
    removed: () => removed,
  };
}

const batch = (...updates: unknown[]) => ({ op: WorkerOp.BATCH_UPDATE, updates });

afterEach(() => {
  resetBatchInbox();
});

describe("batch-inbox", () => {
  it("installs ONE shared listener and demuxes entries by hostId", () => {
    const t = fakeTarget();
    const a: unknown[] = [];
    const b: unknown[] = [];
    subscribeBatch(t.target, "a", (e) => a.push(e));
    subscribeBatch(t.target, "b", (e) => b.push(e));
    // Two hosts, one target → still a single native listener.
    expect(t.added()).toBe(1);

    t.fire(
      batch(
        { hostId: "a", bounds: { yMin: 0, yMax: 1, latestT: 0 } },
        { hostId: "b", ticks: { xTicks: [], yTicks: [], xRawValues: [] } },
        { hostId: "ghost", stats: { renders: 1, busyMs: 1, windowMs: 1 } }, // no sub
      ),
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect((a[0] as { bounds: unknown }).bounds).toEqual({
      yMin: 0,
      yMax: 1,
      latestT: 0,
    });
  });

  it("ignores non-batch and malformed messages", () => {
    const t = fakeTarget();
    const seen = vi.fn();
    subscribeBatch(t.target, "a", seen);
    expect(() => {
      t.fire(null);
      t.fire("string");
      t.fire({ op: 999 }); // some other worker→main op
      t.fire({ op: WorkerOp.BATCH_UPDATE, updates: [{ hostId: "other" }] });
    }).not.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });

  it("removes the shared listener only when the last host leaves", () => {
    const t = fakeTarget();
    const offA = subscribeBatch(t.target, "a", vi.fn());
    const offB = subscribeBatch(t.target, "b", vi.fn());

    offA();
    expect(t.removed()).toBe(0); // b still subscribed
    expect(t.hasHandler()).toBe(true);

    expect(() => offA()).not.toThrow(); // idempotent double-unsubscribe
    expect(t.removed()).toBe(0);

    offB();
    expect(t.removed()).toBe(1); // last one out detaches
    expect(t.hasHandler()).toBe(false);

    // Unsubscribing after the registry is gone hits the idempotent guard.
    expect(() => offB()).not.toThrow();
    expect(t.removed()).toBe(1); // no double-detach
  });

  it("re-subscribing the same hostId replaces the callback", () => {
    const t = fakeTarget();
    const first = vi.fn();
    const second = vi.fn();
    subscribeBatch(t.target, "a", first);
    subscribeBatch(t.target, "a", second);
    expect(t.added()).toBe(1); // still one shared listener
    t.fire(batch({ hostId: "a", bounds: { yMin: 0, yMax: 1, latestT: 0 } }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("resetBatchInbox detaches every shared listener", () => {
    const t = fakeTarget();
    subscribeBatch(t.target, "a", vi.fn());
    resetBatchInbox();
    expect(t.removed()).toBe(1);
    expect(t.hasHandler()).toBe(false);
  });
});
