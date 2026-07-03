import { describe, expect, it, vi } from "vitest";

import type { HostMsg } from "../../../shared/protocol";
import { Op } from "../../../shared/protocol";
import { FluxionWorkerPool } from "./fluxion-worker-pool";

// ─── Fake Worker ─────────────────────────────────────────────────────────────

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function makeFakeWorker(): FakeWorker {
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function makePool(size = 1): { pool: FluxionWorkerPool; fakeWorkers: FakeWorker[] } {
  const fakeWorkers: FakeWorker[] = [];
  const pool = new FluxionWorkerPool({
    size,
    workerFactory: () => {
      const w = makeFakeWorker();
      fakeWorkers.push(w);
      return w as unknown as Worker;
    },
  });
  return { pool, fakeWorkers };
}

function makeInitMsg(): HostMsg {
  return {
    op: Op.INIT,
    canvas: {} as OffscreenCanvas,
    width: 400,
    height: 300,
    dpr: 1,
  };
}

// ─── FluxionWorkerHandle — protocol transformations ──────────────────────────

describe("FluxionWorkerHandle", () => {
  describe("INIT → POOL_INIT transformation", () => {
    it("converts INIT to POOL_INIT and stamps hostId", () => {
      const { pool, fakeWorkers } = makePool();
      const handle = pool.acquire();
      handle.postMessage(makeInitMsg(), []);

      const [call] = fakeWorkers[0]!.postMessage.mock.calls;
      const msg = call![0] as { op: number; hostId: string };
      expect(msg.op).toBe(Op.POOL_INIT);
      expect(msg.hostId).toBe(handle.hostId);
      pool.dispose();
    });

    it("forwards EVERY perf/appearance field of INIT into POOL_INIT (none silently dropped)", () => {
      // emitRenderStats was silently dropped by this projection for every
      // pooled host — pin the FULL field set so the next added InitMsg field
      // can't regress the same way unnoticed.
      const { pool, fakeWorkers } = makePool();
      const handle = pool.acquire();
      handle.postMessage(
        {
          ...makeInitMsg(),
          bgColor: "#123456",
          maxFps: 30,
          emitBounds: false,
          emitTicks: false,
          emitRenderStats: true,
          transparent: true,
        } as HostMsg,
        [],
      );
      expect(fakeWorkers[0]!.postMessage.mock.calls[0]![0]).toMatchObject({
        op: Op.POOL_INIT,
        hostId: handle.hostId,
        width: 400,
        height: 300,
        dpr: 1,
        bgColor: "#123456",
        maxFps: 30,
        emitBounds: false,
        emitTicks: false,
        emitRenderStats: true,
        transparent: true,
      });

      const handle2 = pool.acquire();
      handle2.postMessage(makeInitMsg(), []);
      const bare = fakeWorkers[0]!.postMessage.mock.calls.at(-1)![0] as {
        emitRenderStats?: boolean;
      };
      expect(bare.emitRenderStats).toBeUndefined(); // absent stays absent
      pool.dispose();
    });

    it("uses empty transfer when none provided", () => {
      const { pool, fakeWorkers } = makePool();
      const handle = pool.acquire();
      handle.postMessage(makeInitMsg());

      const [call] = fakeWorkers[0]!.postMessage.mock.calls;
      expect(call![1]).toEqual([]);
      pool.dispose();
    });

    it("forwards provided transfer list", () => {
      const { pool, fakeWorkers } = makePool();
      const handle = pool.acquire();
      const transfer = [new ArrayBuffer(4)];
      handle.postMessage(makeInitMsg(), transfer);

      const [call] = fakeWorkers[0]!.postMessage.mock.calls;
      expect(call![1]).toBe(transfer);
      pool.dispose();
    });
  });

  describe("DISPOSE → POOL_DISPOSE transformation", () => {
    it("converts DISPOSE to POOL_DISPOSE with hostId", () => {
      const { pool, fakeWorkers } = makePool();
      const handle = pool.acquire();
      handle.postMessage({ op: Op.DISPOSE });

      const [call] = fakeWorkers[0]!.postMessage.mock.calls;
      const msg = call![0] as { op: number; hostId: string };
      expect(msg.op).toBe(Op.POOL_DISPOSE);
      expect(msg.hostId).toBe(handle.hostId);
      pool.dispose();
    });

    it("calls release() so the worker can be reused", () => {
      const { pool, fakeWorkers: _ } = makePool(1);
      const h1 = pool.acquire();
      h1.postMessage({ op: Op.DISPOSE });

      // After release, pool should have 1 slot free — next acquire stays on same worker
      const h2 = pool.acquire();
      expect(h2.hostId).not.toBe(h1.hostId);
      pool.dispose();
    });
  });

  describe("regular messages", () => {
    it("stamps hostId and forwards via base class", () => {
      const { pool, fakeWorkers } = makePool();
      const handle = pool.acquire();
      const buf = new ArrayBuffer(8);
      const msg: HostMsg = {
        op: Op.DATA,
        id: "layer1",
        buffer: buf,
        dtype: "f32",
        length: 2,
      };
      handle.postMessage(msg, [buf]);

      const [call] = fakeWorkers[0]!.postMessage.mock.calls;
      const sent = call![0] as { op: number; hostId: string };
      expect(sent.op).toBe(Op.DATA);
      expect(sent.hostId).toBe(handle.hostId);
      expect(call![1]).toEqual([buf]);
      pool.dispose();
    });
  });
});

// ─── FluxionWorkerPool — acquire returns FluxionWorkerHandle ─────────────────

describe("FluxionWorkerPool", () => {
  it("acquire() returns a FluxionWorkerHandle that can transform INIT messages", () => {
    const { pool, fakeWorkers } = makePool();
    const handle = pool.acquire();
    handle.postMessage(makeInitMsg(), []);
    const msg = fakeWorkers[0]!.postMessage.mock.calls[0]![0] as { op: number };
    expect(msg.op).toBe(Op.POOL_INIT);
    pool.dispose();
  });
});

// ─── FluxionWorkerPool.hasHost ───────────────────────────────────────────────

describe("FluxionWorkerPool.hasHost", () => {
  it("returns true for an acquired host", () => {
    const { pool } = makePool();
    const handle = pool.acquire();
    expect(pool.hasHost(handle.hostId)).toBe(true);
    pool.dispose();
  });

  it("returns false for an unknown hostId", () => {
    const { pool } = makePool();
    expect(pool.hasHost("nonexistent")).toBe(false);
    pool.dispose();
  });

  it("returns false after the handle is released via DISPOSE", () => {
    const { pool } = makePool();
    const handle = pool.acquire();
    handle.postMessage({ op: Op.DISPOSE });
    expect(pool.hasHost(handle.hostId)).toBe(false);
    pool.dispose();
  });
});

// ─── FluxionWorkerPool.broadcastStream ───────────────────────────────────────

describe("FluxionWorkerPool.broadcastStream", () => {
  it("size=1 pool: sends exactly 1 postMessage for N hosts on the same worker", () => {
    const { pool, fakeWorkers } = makePool(1);
    const handles = Array.from({ length: 5 }, () => pool.acquire());
    const targets = handles.map((h) => ({ hostId: h.hostId, layerId: "line" }));
    const buf = new Float32Array([0, 1, 2, 3, 4, 5]).buffer;

    pool.broadcastStream(targets, buf, 6);

    // All 5 hosts share worker[0] → exactly 1 postMessage
    expect(fakeWorkers[0]!.postMessage).toHaveBeenCalledTimes(1);
    const [call] = fakeWorkers[0]!.postMessage.mock.calls;
    const msg = call![0] as { mode: string; targets: typeof targets; length: number };
    expect(msg.mode).toBe("pool-stream");
    expect(msg.targets).toHaveLength(5);
    expect(msg.length).toBe(6);
    pool.dispose();
  });

  it("size=1 pool: targets array in the message preserves input order", () => {
    const { pool, fakeWorkers } = makePool(1);
    const h0 = pool.acquire();
    const h1 = pool.acquire();
    const h2 = pool.acquire();
    const targets = [
      { hostId: h0.hostId, layerId: "a" },
      { hostId: h1.hostId, layerId: "b" },
      { hostId: h2.hostId, layerId: "c" },
    ];
    const buf = new Float32Array(4).buffer;
    pool.broadcastStream(targets, buf, 4);

    const msg = fakeWorkers[0]!.postMessage.mock.calls[0]![0] as {
      targets: typeof targets;
    };
    expect(msg.targets.map((t) => t.hostId)).toEqual([h0.hostId, h1.hostId, h2.hostId]);
    pool.dispose();
  });

  it("size=2 pool: sends one message per worker, buffer copied to all but last", () => {
    const { pool, fakeWorkers } = makePool(2);
    // Acquire 2 handles — one per worker (least-busy routing)
    const h0 = pool.acquire(); // → worker 0
    const h1 = pool.acquire(); // → worker 1
    const targets = [
      { hostId: h0.hostId, layerId: "x" },
      { hostId: h1.hostId, layerId: "y" },
    ];
    const buf = new Float32Array([10, 20]).buffer;
    pool.broadcastStream(targets, buf, 2);

    expect(fakeWorkers[0]!.postMessage).toHaveBeenCalledTimes(1);
    expect(fakeWorkers[1]!.postMessage).toHaveBeenCalledTimes(1);

    const buf0 = (
      fakeWorkers[0]!.postMessage.mock.calls[0]![0] as { buffer: ArrayBuffer }
    ).buffer;
    const buf1 = (
      fakeWorkers[1]!.postMessage.mock.calls[0]![0] as { buffer: ArrayBuffer }
    ).buffer;
    // The two workers must NOT share the same ArrayBuffer reference
    expect(buf0).not.toBe(buf1);
    pool.dispose();
  });

  it("skips targets whose hostId is not in the registry", () => {
    const { pool, fakeWorkers } = makePool(1);
    const handle = pool.acquire();
    const targets = [
      { hostId: handle.hostId, layerId: "line" },
      { hostId: "ghost-host", layerId: "line" }, // not in registry
    ];
    const buf = new Float32Array(4).buffer;
    pool.broadcastStream(targets, buf, 4);

    const msg = fakeWorkers[0]!.postMessage.mock.calls[0]![0] as {
      targets: typeof targets;
    };
    expect(msg.targets).toHaveLength(1);
    expect(msg.targets[0]!.hostId).toBe(handle.hostId);
    pool.dispose();
  });

  it("sends nothing when all targets are unregistered", () => {
    const { pool, fakeWorkers } = makePool(1);
    pool.acquire(); // pool has 1 known host but we won't include it
    const buf = new Float32Array(2).buffer;
    pool.broadcastStream([{ hostId: "unknown", layerId: "x" }], buf, 2);
    expect(fakeWorkers[0]!.postMessage).not.toHaveBeenCalled();
    pool.dispose();
  });

  it("is a no-op after the pool is disposed (does not post to dead workers)", () => {
    const { pool, fakeWorkers } = makePool(1);
    const handle = pool.acquire();
    const targets = [{ hostId: handle.hostId, layerId: "line" }];
    pool.dispose();
    fakeWorkers[0]!.postMessage.mockClear();
    pool.broadcastStream(targets, new Float32Array(2).buffer, 2);
    expect(fakeWorkers[0]!.postMessage).not.toHaveBeenCalled();
  });
});

// ─── FluxionWorkerPool.dispose ───────────────────────────────────────────────

describe("FluxionWorkerPool.dispose", () => {
  it("clears the host registry so hasHost returns false afterward", () => {
    const { pool } = makePool(1);
    const handle = pool.acquire();
    expect(pool.hasHost(handle.hostId)).toBe(true);
    pool.dispose();
    expect(pool.hasHost(handle.hostId)).toBe(false);
  });
});

// ─── FluxionWorkerHandle.emitStream ──────────────────────────────────────────

describe("FluxionWorkerHandle.emitStream", () => {
  it("posts with mode:stream, hostId, id, length and transfers the buffer", () => {
    const { pool, fakeWorkers } = makePool();
    const handle = pool.acquire();
    const buffer = new Float32Array([1, 2, 3, 4]).buffer;
    handle.emitStream("sensor", buffer, 4);

    const [call] = fakeWorkers[0]!.postMessage.mock.calls;
    const msg = call![0] as {
      id: string;
      length: number;
      mode: string;
      hostId: string;
      buffer: ArrayBuffer;
    };
    expect(msg.id).toBe("sensor");
    expect(msg.length).toBe(4);
    expect(msg.mode).toBe("stream");
    expect(msg.hostId).toBe(handle.hostId);
    expect(msg.buffer).toBe(buffer);
    const transfer = call![1] as Transferable[];
    expect(transfer).toEqual([buffer]);
    pool.dispose();
  });

  it("emitStream / emitPoolStream are no-ops after the handle is terminated", () => {
    const { pool, fakeWorkers } = makePool(1);
    const handle = pool.acquire();
    pool.dispose(); // marks all handles terminated
    fakeWorkers[0]!.postMessage.mockClear();
    handle.emitStream("sensor", new Float32Array(2).buffer, 2);
    handle.emitPoolStream(
      [{ hostId: handle.hostId, layerId: "line" }],
      new Float32Array(2).buffer,
      2,
    );
    expect(fakeWorkers[0]!.postMessage).not.toHaveBeenCalled();
  });
});

// ─── Host teardown is sibling-safe + leak-free ───────────────────────────────

describe("FluxionWorkerPool — host teardown", () => {
  it("disposing one host does NOT terminate the shared worker (sibling-safe)", () => {
    const { pool, fakeWorkers } = makePool(1); // one worker shared by both hosts
    const h1 = pool.acquire();
    const h2 = pool.acquire();
    expect(fakeWorkers).toHaveLength(1);

    // Op.DISPOSE on h1 → handle converts to POOL_DISPOSE + releases the slot.
    h1.postMessage({ op: Op.DISPOSE } as HostMsg);
    expect(fakeWorkers[0]!.terminate).not.toHaveBeenCalled(); // shared worker alive
    expect(pool.hasHost(h1.hostId)).toBe(false); // h1 released
    expect(pool.hasHost(h2.hostId)).toBe(true); // sibling intact

    // h2 still routes to the shared worker.
    fakeWorkers[0]!.postMessage.mockClear();
    h2.postMessage(makeInitMsg(), []);
    expect(fakeWorkers[0]!.postMessage).toHaveBeenCalledTimes(1);

    // Only pool.dispose() terminates the worker.
    pool.dispose();
    expect(fakeWorkers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("repeated acquire/dispose leaves no registry residue (no leak across churn)", () => {
    const { pool, fakeWorkers } = makePool(1);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const h = pool.acquire();
      ids.push(h.hostId);
      h.postMessage({ op: Op.DISPOSE } as HostMsg); // release the slot each cycle
    }
    expect(fakeWorkers).toHaveLength(1); // worker reused, never re-created
    for (const id of ids) expect(pool.hasHost(id)).toBe(false); // nothing lingers
    // The pool still works for a fresh host on the reused worker.
    const fresh = pool.acquire();
    expect(pool.hasHost(fresh.hostId)).toBe(true);
    pool.dispose();
  });
});
