import { afterEach, describe, expect, it, vi } from "vitest";
import type { SerializedFrame } from "../../../shared/model/frame";
import { ReplayStore } from "./replay-store";

const stores: ReplayStore[] = [];
async function open(opts: ConstructorParameters<typeof ReplayStore>[0] = {}) {
  const store = new ReplayStore({
    dbName: `reliability-${stores.length}`,
    evictThresholdPct: 100,
    ...opts,
  });
  stores.push(store);
  await store.open();
  return store;
}
const frame = (t: number): SerializedFrame => ({
  t,
  channelId: "cam",
  payload: new ArrayBuffer(4),
});
afterEach(() => {
  for (const store of stores) store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("recording safety", () => {
  it("isolates databases and preserves unrelated origin files on clear", async () => {
    const a = await open({ dbName: "safe-a" });
    const b = await open({ dbName: "safe-b" });
    const root = await navigator.storage.getDirectory();
    const unrelated = await root.getFileHandle("unrelated-app", { create: true });
    const out = await unrelated.createWritable();
    await out.write(new Uint8Array([9]));
    await out.close();
    await a.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
    await b.writeVideoChunk("cam", "1.chunk", new Uint8Array([2]));
    a.appendFrame(frame(1));
    await a.clearAll();
    await a.flush();
    expect(a.pendingFrameCount).toBe(0);
    expect(await a.getFrames(0, 2)).toEqual([]);
    expect(await a.readVideoChunk("cam", "1.chunk")).toBeNull();
    expect(await b.readVideoChunk("cam", "1.chunk")).toEqual(new Uint8Array([2]));
    expect(new Uint8Array(await (await unrelated.getFile()).arrayBuffer())).toEqual(
      new Uint8Array([9]),
    );
  });
  it("reads legacy videos referenced by this database without deleting shared legacy files", async () => {
    const store = await open();
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("cam", { create: true });
    const file = await dir.getFileHandle("42.chunk", { create: true });
    const out = await file.createWritable();
    await out.write(new Uint8Array([42]));
    await out.close();
    store.appendFrame(frame(42));
    await store.flush();
    expect(await store.readVideoChunk("cam", "42.chunk")).toEqual(new Uint8Array([42]));
    await store.clearAll();
    expect(await store.readVideoChunk("cam", "42.chunk")).toBeNull();
    expect(await dir.getFileHandle("42.chunk")).toBeDefined();
    expect(await store.readVideoChunk("cam", "not-a-timestamp")).toBeNull();
  });
  it("drains sustained ingestion in successive transactions instead of 200 per tick", async () => {
    vi.useFakeTimers();
    const store = await open();
    for (let tick = 0; tick < 20; tick++) {
      for (let i = 0; i < 500; i++) store.appendFrame(frame(tick * 500 + i));
      await vi.advanceTimersByTimeAsync(500);
      expect(store.pendingFrameCount).toBe(0);
    }
    expect((await store.getFrames(0, 9999)).length).toBe(10000);
  });
  it("retains a failed batch, reports background errors, then retries without duplication", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const store = await open({ onError });
    const target = store as unknown as {
      _writeBatch(rows: SerializedFrame[]): Promise<void>;
    };
    const write = vi
      .spyOn(target, "_writeBatch")
      .mockRejectedValueOnce(new Error("disk"));
    store.appendFrame(frame(1));
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledOnce();
    expect(store.lastWriteError).toBeInstanceOf(Error);
    expect(store.pendingFrameCount).toBe(1);
    await store.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.pendingFrameCount).toBe(0);
    expect(store.lastWriteError).toBeNull();
    expect((await store.getFrames(0, 2)).length).toBe(1);
  });
  it("clear waits for an in-flight commit; new frames survive without resurrecting old frames", async () => {
    const store = await open();
    const target = store as unknown as {
      _writeBatch(rows: SerializedFrame[]): Promise<void>;
    };
    const original = target._writeBatch.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(target, "_writeBatch").mockImplementationOnce(async (rows) => {
      await gate;
      await original(rows);
    });
    store.appendFrame(frame(1));
    const flushing = store.flush();
    const clearing = store.clearAll();
    const clearingAgain = store.clearAll();
    store.appendFrame(frame(2));
    const nextFlush = store.flush();
    release();
    await Promise.all([flushing, clearing, clearingAgain, nextFlush]);
    expect((await store.getFrames(0, 3)).map((f) => f.t)).toEqual([2]);
  });
  it("bounds the queue explicitly and rejects flush before open", async () => {
    const store = new ReplayStore({ maxPendingFrames: 1 });
    stores.push(store);
    store.appendFrame(frame(1));
    expect(() => store.appendFrame(frame(2))).toThrow("queue is full");
    await expect(store.flush()).rejects.toThrow("not open");
    await store.open();
    await store.flush();
    store.dispose();
    expect(() => store.appendFrame(frame(3))).toThrow("disposed");
    for (const opts of [
      { maxPendingFrames: 0 },
      { retentionMs: -1 },
      { batchIntervalMs: 0 },
      { batchIntervalMs: Infinity },
    ])
      expect(() => new ReplayStore(opts)).toThrow(RangeError);
  });
  it("preserves disk history by default and honors explicit time retention", async () => {
    const unlimited = await open();
    const bounded = await open({ retentionMs: 100 });
    for (const store of [unlimited, bounded]) {
      store.appendFrame(frame(0));
      store.appendFrame(frame(900));
      store.appendFrame(frame(1000));
      await store.flush();
    }
    expect((await unlimited.getFrames(0, 1000)).map((f) => f.t)).toEqual([0, 900, 1000]);
    expect((await bounded.getFrames(0, 1000)).map((f) => f.t)).toEqual([900, 1000]);
    bounded.setEvictionPaused(true);
    bounded.appendFrame(frame(2000));
    await bounded.flush();
    expect((await bounded.getFrames(0, 2000)).length).toBe(3);
  });
});

it("surfaces request and transaction failures without discarding staged frames", async () => {
  const store = await open();
  const db = (store as unknown as { _db: IDBDatabase })._db;
  function failTransaction() {
    const request: Record<string, unknown> = { error: new Error("IDB request failed") };
    const tx: Record<string, unknown> = { error: new Error("IDB transaction failed") };
    const operation = () => {
      queueMicrotask(() => {
        (request.onerror as (() => void) | undefined)?.();
      });
      return request;
    };
    const table = {
      index: () => table,
      getAll: operation,
      openCursor: operation,
      count: operation,
      add: () => {},
      clear: () => {},
    };
    tx.objectStore = () => table;
    queueMicrotask(() => {
      (tx.onabort as (() => void) | undefined)?.();
    });
    return tx as unknown as IDBTransaction;
  }
  const transaction = vi.spyOn(db, "transaction");
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.getFrames(0, 10)).rejects.toThrow("request failed");
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.getFramesByChannel("cam", 0, 10)).rejects.toThrow("request failed");
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.deleteFramesBefore(10)).rejects.toThrow("transaction failed");
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.getTimeRange()).rejects.toThrow("transaction failed");
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.getStorageInfo()).rejects.toThrow("request failed");
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.clearAll()).rejects.toThrow("transaction failed");
  store.appendFrame(frame(1));
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.flush()).rejects.toThrow("transaction failed");
  expect(store.pendingFrameCount).toBe(1);
  await store.flush();
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  transaction.mockImplementationOnce(failTransaction);
  await expect(store.deleteVideoChunksBefore(10)).resolves.toBeUndefined();
});

it("clears IDB when OPFS is unavailable and reports failed writes without an error callback", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const getDirectory = vi
    .spyOn(navigator.storage, "getDirectory")
    .mockRejectedValue(new Error("unavailable"));
  const store = await open();
  await store.clearAll();
  await expect(
    store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1])),
  ).rejects.toThrow("not available");
  store.appendFrame(frame(1));
  vi.spyOn(
    store as unknown as { _writeBatch(): Promise<void> },
    "_writeBatch",
  ).mockRejectedValue(new Error("disk"));
  await vi.advanceTimersByTimeAsync(500);
  expect(error).toHaveBeenCalled();
  getDirectory.mockRestore();
});

it("isolates an error callback failure and pauses timer writes during deletion", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const store = await open({
    onError: () => {
      throw new Error("observer");
    },
  });
  store.appendFrame(frame(1));
  const target = store as unknown as {
    _writeBatch(rows: SerializedFrame[]): Promise<void>;
    _flushPending(force: boolean): Promise<void>;
  };
  const write = vi.spyOn(target, "_writeBatch").mockRejectedValueOnce(new Error("disk"));
  await vi.advanceTimersByTimeAsync(500);
  expect(error).toHaveBeenCalledWith(
    "[ReplayStore] error listener failed",
    expect.any(Error),
  );
  let release!: () => void;
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const flushing = store.flush();
  const clearing = store.clearAll();
  await vi.advanceTimersByTimeAsync(500);
  release();
  await Promise.all([flushing, clearing]);
  expect(store.pendingFrameCount).toBe(0);
  store.dispose();
  await target._flushPending(false);
});

it("waits for video writes before clear and accepts new writes after clear", async () => {
  const store = await open();
  const target = store as unknown as {
    _writeChunkOnce(channel: string, file: string, data: Uint8Array): Promise<void>;
  };
  const original = target._writeChunkOnce.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(target, "_writeChunkOnce").mockImplementationOnce(async (...args) => {
    await gate;
    await original(...args);
  });
  const old = store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  const clearing = store.clearAll();
  const fresh = store.writeVideoChunk("cam", "2.chunk", new Uint8Array([2]));
  release();
  await Promise.all([old, clearing, fresh]);
  expect(await store.readVideoChunk("cam", "1.chunk")).toBeNull();
  expect(await store.readVideoChunk("cam", "2.chunk")).toEqual(new Uint8Array([2]));
});

it("does not retain late OPFS handles after disposal", async () => {
  const actual = await navigator.storage.getDirectory();
  let release!: (root: FileSystemDirectoryHandle) => void;
  const namespace = {
    getDirectoryHandle: () =>
      new Promise<FileSystemDirectoryHandle>((resolve) => {
        release = resolve;
      }),
  };
  vi.spyOn(navigator.storage, "getDirectory").mockResolvedValue({
    getDirectoryHandle: async () => namespace,
  } as unknown as FileSystemDirectoryHandle);
  const store = new ReplayStore();
  stores.push(store);
  const opening = store.open();
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  store.dispose();
  release(actual);
  await opening;
  expect(await store.readVideoChunk("cam", "1.chunk")).toBeNull();
});

it("handles an empty retained range, missing storage estimates, and repeated segment endings", async () => {
  const store = await open({ retentionMs: 100 });
  await store.flush();
  vi.spyOn(navigator.storage, "estimate").mockResolvedValue({});
  expect(await store.getStorageInfo()).toMatchObject({
    usedBytes: 0,
    quotaBytes: 0,
    percentUsed: 0,
  });
  store.startSegment(1);
  store.endSegment(2);
  store.endSegment(3);
  expect(store.getSegments()).toEqual([{ start: 1, end: 2 }]);
  store.dispose();
  expect((await store.getStorageInfo()).idbFrameCount).toBe(0);
});

it("retries a quota write even if eviction fails", async () => {
  const store = await open();
  const target = store as unknown as {
    _writeChunkOnce(): Promise<void>;
    _evictOldest(): Promise<void>;
  };
  const write = vi
    .spyOn(target, "_writeChunkOnce")
    .mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
  vi.spyOn(target, "_evictOldest").mockRejectedValueOnce(new Error("eviction failed"));
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  expect(write).toHaveBeenCalledTimes(2);
});
it("clears after a failed in-flight transaction and tolerates missing OPFS iteration", async () => {
  const store = await open();
  const target = store as unknown as {
    _writeBatch(): Promise<void>;
    _opfsRoot: FileSystemDirectoryHandle;
  };
  let reject!: (error: Error) => void;
  vi.spyOn(target, "_writeBatch").mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  store.appendFrame(frame(1));
  const flush = store.flush();
  const checked = expect(flush).rejects.toThrow("disk");
  target._opfsRoot = {} as FileSystemDirectoryHandle;
  const clear = store.clearAll();
  reject(new Error("disk"));
  await checked;
  await clear;
  expect(store.pendingFrameCount).toBe(0);
});
it("upgrades a database that already contains the frames store", async () => {
  const existing = await open();
  const db = (existing as unknown as { _db: IDBDatabase })._db;
  const request = {} as IDBOpenDBRequest;
  vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
    queueMicrotask(() => {
      const event = { target: { result: db } };
      request.onupgradeneeded?.call(request, event as unknown as IDBVersionChangeEvent);
      request.onsuccess?.call(request, event as unknown as Event);
    });
    return request;
  });
  const next = await open();
  expect(await next.getFrames(0, 1)).toEqual([]);
});
it("uses the earliest timestamp if a partial index read has no last cursor", async () => {
  const store = await open();
  const db = (store as unknown as { _db: IDBDatabase })._db;
  const tx = {} as IDBTransaction;
  const requests: IDBRequest[] = [];
  const index = {
    openCursor: () => {
      const req = {} as IDBRequest;
      requests.push(req);
      return req;
    },
  };
  vi.spyOn(db, "transaction").mockImplementationOnce(() => {
    Object.assign(tx, { objectStore: () => ({ index: () => index }) });
    queueMicrotask(() => {
      requests[0].onsuccess?.call(requests[0], {
        target: { result: { value: { t: 42 } } },
      } as unknown as Event);
      tx.oncomplete?.call(tx, {} as Event);
    });
    return tx;
  });
  expect(await store.getTimeRange()).toEqual({ earliest: 42, latest: 42 });
});
