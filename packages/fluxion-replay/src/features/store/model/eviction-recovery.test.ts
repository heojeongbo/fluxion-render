import { afterEach, expect, it, vi } from "vitest";
import { collectVideoGarbage, deleteFrameBatch } from "./frame-eviction";
import { ReplayStore } from "./replay-store";

const stores: ReplayStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.restoreAllMocks();
});
async function fixture() {
  const store = new ReplayStore({
    dbName: `outbox-${stores.length}`,
    evictThresholdPct: 100,
  });
  stores.push(store);
  await store.open();
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  store.appendFrame({ channelId: "cam", t: 1, payload: new ArrayBuffer(0) });
  await store.flush();
  const { _db: db, _opfsRoot: root } = store as unknown as {
    _db: IDBDatabase;
    _opfsRoot: FileSystemDirectoryHandle;
  };
  const dir = await root.getDirectoryHandle("cam");
  vi.spyOn(root, "getDirectoryHandle").mockResolvedValue(dir);
  return { store, db, root, dir };
}
it("keeps cleanup intent after file failure, then retries without dangling metadata", async () => {
  const { store, db, root, dir } = await fixture();
  vi.spyOn(dir, "removeEntry").mockRejectedValueOnce(
    new DOMException("denied", "NotAllowedError"),
  );
  await expect(store.deleteFramesBefore(2)).rejects.toThrow("denied");
  expect(await store.getFrames(0, 2)).toEqual([]);
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
  await collectVideoGarbage(db, root, 500);
  expect(await store.readVideoChunk("cam", "1.chunk")).toBeNull();
});
it("never deletes files before the metadata transaction commits", async () => {
  const { store, db, dir } = await fixture();
  const remove = vi.spyOn(dir, "removeEntry");
  const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(() => {
    throw new Error("database unavailable");
  });
  await expect(store.deleteFramesBefore(2)).rejects.toThrow("database unavailable");
  expect(remove).not.toHaveBeenCalled();
  transaction.mockRestore();
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
});
it("keeps a file whose timestamp has been recorded again", async () => {
  const { store, db, root } = await fixture();
  await deleteFrameBatch(db, 2, 500);
  store.appendFrame({ t: 1, channelId: "cam", payload: new ArrayBuffer(0) });
  await store.flush();
  await collectVideoGarbage(db, root, 500);
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
});
it.each([
  new DOMException("missing", "NotFoundError"),
  new Error("offline"),
  new DOMException("denied", "NotAllowedError"),
])("handles directory lookup failure %s without losing retry intent", async (error) => {
  const { db, root } = await fixture();
  await deleteFrameBatch(db, 2, 500);
  vi.spyOn(root, "getDirectoryHandle").mockRejectedValueOnce(error);
  const task = collectVideoGarbage(db, root, 500);
  if (error.name === "NotFoundError") await task;
  else await expect(task).rejects.toBe(error);
});
it.each([
  new DOMException("missing", "NotFoundError"),
  new Error("offline"),
])("handles already deleted files or transient file failures %s", async (error) => {
  const { db, root, dir } = await fixture();
  await deleteFrameBatch(db, 2, 500);
  vi.spyOn(dir, "removeEntry").mockRejectedValueOnce(error);
  const task = collectVideoGarbage(db, root, 500);
  if (error.name === "NotFoundError") await task;
  else await expect(task).rejects.toBe(error);
});
it.each([
  "outbox-read",
  "reference-read",
  "outbox-commit",
])("propagates %s failure so the durable outbox can be retried", async (phase) => {
  const { db, root } = await fixture();
  await deleteFrameBatch(db, 2, 500);
  const original = db.transaction.bind(db);
  let count = 0;
  vi.spyOn(db, "transaction").mockImplementation((...args) => {
    count++;
    const selected = phase === "outbox-read" ? 1 : phase === "reference-read" ? 2 : 3;
    if (count !== selected) return original(...args);
    const failure = new Error(phase);
    const request = {
      error: failure,
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
    };
    const tx = {
      error: failure,
      onabort: null as (() => void) | null,
      objectStore: () => ({
        getAll: () => request,
        index: () => ({ count: () => request }),
        delete: () => {},
      }),
    };
    queueMicrotask(() => {
      if (phase === "outbox-read") request.onerror?.();
      else tx.onabort?.();
    });
    return tx as unknown as IDBTransaction;
  });
  await expect(collectVideoGarbage(db, root, 500)).rejects.toThrow(phase);
});
it("shares an in-flight cleanup and waits before clear, including cleanup failure", async () => {
  const { store, dir } = await fixture();
  let reject!: (e: Error) => void;
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  vi.spyOn(dir, "removeEntry").mockImplementationOnce(() => {
    began();
    return new Promise((_, r) => {
      reject = r;
    });
  });
  const removing = store.deleteFramesBefore(2).catch(() => {});
  await started;
  const second = store.deleteFramesBefore(2).catch(() => {});
  await Promise.resolve();
  const clearing = store.clearAll();
  reject(new Error("disk disappeared"));
  await Promise.all([removing, second, clearing]);
  expect(await store.getFrames(0, 2)).toEqual([]);
});
it("rechecks storage at the low watermark while pressure remains high", async () => {
  const { store } = await fixture();
  const internal = store as unknown as {
    _evictThresholdPct: number;
    _maybeEvict(): Promise<void>;
  };
  internal._evictThresholdPct = 70;
  const estimate = vi.spyOn(navigator.storage, "estimate");
  for (const usage of [80, 68, 60]) {
    estimate.mockResolvedValue({ usage, quota: 100 });
    await internal._maybeEvict();
  }
  expect(estimate).toHaveBeenCalledTimes(3);
});
it("does not install timers when disposed during recovery", async () => {
  const s = new ReplayStore();
  stores.push(s);
  const internals = s as unknown as { _collectGarbage(): Promise<void> };
  let release!: () => void;
  vi.spyOn(internals, "_collectGarbage").mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const opening = s.open();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  s.dispose();
  release();
  await opening;
});
it("opens even when stale file recovery fails and retries on later cleanup", async () => {
  const s = new ReplayStore();
  stores.push(s);
  vi.spyOn(
    s as unknown as { _collectGarbage(): Promise<void> },
    "_collectGarbage",
  ).mockRejectedValueOnce(new Error("offline"));
  await expect(s.open()).resolves.toBeUndefined();
});
it("stops an eviction when its recording is cleared", async () => {
  const { store } = await fixture();
  vi.spyOn(store, "deleteFramesBefore").mockImplementationOnce(() => store.clearAll());
  await (store as unknown as { _evictBefore(t: number): Promise<void> })._evictBefore(2);
  expect(await store.getTimeRange()).toBeNull();
});
it("protects an in-flight rewrite and its pending metadata from file cleanup", async () => {
  const { store, db } = await fixture();
  await deleteFrameBatch(db, 2, 500);
  let release!: () => void;
  const target = store as unknown as {
    _writeChunkOnce(): Promise<void>;
    _collectGarbage(): Promise<void>;
  };
  vi.spyOn(target, "_writeChunkOnce").mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const write = store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  await target._collectGarbage();
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
  release();
  await write;
  store.appendFrame({ t: 2, channelId: "metric", payload: new ArrayBuffer(0) });
  store.appendFrame({ t: 1, channelId: "cam", payload: new ArrayBuffer(0) });
  await target._collectGarbage();
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
  await store.flush();
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
});
it("retains protection until both writes to the same video path finish", async () => {
  const { store } = await fixture();
  const releases: (() => void)[] = [];
  vi.spyOn(
    store as unknown as { _writeChunkOnce(): Promise<void> },
    "_writeChunkOnce",
  ).mockImplementation(
    () =>
      new Promise((r) => {
        releases.push(r);
      }),
  );
  const a = store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  const b = store.writeVideoChunk("cam", "1.chunk", new Uint8Array([2]));
  releases[0]();
  await a;
  releases[1]();
  await b;
  expect(
    (store as unknown as { _videoPaths: Map<string, number> })._videoPaths.size,
  ).toBe(0);
});
function legacySchema(db: IDBDatabase) {
  const names = db.objectStoreNames;
  vi.spyOn(db, "objectStoreNames", "get").mockReturnValue({
    ...names,
    contains: (name: string) => name !== "video-garbage" && names.contains(name),
  } as DOMStringList);
}
it("supports an existing v1 schema without an outbox and retries file failures", async () => {
  const { store, db, dir } = await fixture();
  legacySchema(db);
  const tx = vi.spyOn(db, "transaction");
  vi.spyOn(dir, "removeEntry").mockRejectedValueOnce(new Error("disk busy"));
  await expect(store.deleteFramesBefore(2)).rejects.toThrow("disk busy");
  expect(await store.getFrames(0, 2)).toEqual([]);
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
  await store.flush();
  expect(await store.readVideoChunk("cam", "1.chunk")).toBeNull();
  await store.clearAll();
  expect(
    tx.mock.calls.every(([names]) => ![names].flat().includes("video-garbage")),
  ).toBe(true);
});
it("retains protected legacy cleanup entries and releases completed entries", async () => {
  const { store, db, root } = await fixture();
  legacySchema(db);
  await store.writeVideoChunk("cam", "2.chunk", new Uint8Array([2]));
  store.appendFrame({ t: 2, channelId: "cam", payload: new ArrayBuffer(0) });
  await store.flush();
  const pending = await deleteFrameBatch(db, 3, 500);
  await collectVideoGarbage(db, root, 500, (_channel, t) => t === 2, pending);
  expect(pending.map((frame) => frame.t)).toEqual([2]);
  expect(await store.readVideoChunk("cam", "1.chunk")).toBeNull();
  expect(await store.readVideoChunk("cam", "2.chunk")).not.toBeNull();
  await collectVideoGarbage(db, root, 500, () => false, pending);
  expect(pending).toEqual([]);
});
