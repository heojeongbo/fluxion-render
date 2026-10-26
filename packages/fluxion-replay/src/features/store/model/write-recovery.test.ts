import { afterEach, expect, it, vi } from "vitest";
import type { SerializedFrame } from "../../../shared/model/frame";
import { collectVideoGarbage, deleteFrameBatch, GARBAGE_STORE } from "./frame-eviction";
import { ReplayStore } from "./replay-store";

const stores: ReplayStore[] = [];
async function open(opts: ConstructorParameters<typeof ReplayStore>[0] = {}) {
  const store = new ReplayStore({
    dbName: `write-recovery-${stores.length}-${Date.now()}`,
    evictThresholdPct: 100,
    ...opts,
  });
  stores.push(store);
  await store.open();
  return store;
}
const frame = (t: number, channelId = "cam"): SerializedFrame => ({
  t,
  channelId,
  payload: new ArrayBuffer(4),
});
type Internals = {
  _db: IDBDatabase;
  _writeBatch(records: unknown[]): Promise<void>;
  _collectGarbage(): Promise<void>;
  _evictOldest(fraction: number): Promise<number | null>;
};
const internals = (store: ReplayStore) => store as unknown as Internals;
/** Insert a row the way <= 0.13.2 did: no `video` marker. */
async function legacyRow(store: ReplayStore, t: number, channelId: string) {
  await new Promise<void>((resolve) => {
    const tx = internals(store)._db.transaction("frames", "readwrite");
    tx.objectStore("frames").add({ t, channelId, payload: new ArrayBuffer(1) });
    tx.oncomplete = () => resolve();
  });
}
async function rootFile(path: string[], data = new Uint8Array([7])) {
  let dir = await navigator.storage.getDirectory();
  for (const name of path.slice(0, -1))
    dir = await dir.getDirectoryHandle(name, { create: true });
  const file = await dir.getFileHandle(path.at(-1)!, { create: true });
  const out = await file.createWritable();
  await out.write(data);
  await out.close();
}
async function rootFileExists(path: string[]): Promise<boolean> {
  try {
    let dir = await navigator.storage.getDirectory();
    for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    await dir.getFileHandle(path.at(-1)!);
    return true;
  } catch {
    return false;
  }
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  const root = await navigator.storage.getDirectory();
  for (const name of ["cam", "other", "/robot/odom"])
    await root.removeEntry(name, { recursive: true }).catch(() => {});
});

it("flush() waits for frames appended while a timer drain finishes its cleanup", async () => {
  vi.useFakeTimers();
  const store = await open({ batchIntervalMs: 50 });
  store.appendFrame(frame(1));
  let release!: () => void;
  const cleanup = vi
    .spyOn(internals(store), "_collectGarbage")
    .mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
  await vi.advanceTimersByTimeAsync(50); // the timer drain writes t=1, then cleans up
  expect(cleanup).toHaveBeenCalledTimes(1);
  store.appendFrame(frame(2)); // e.g. VideoRecorder.stopAndFlush's last frames
  const flushed = store.flush();
  release();
  await flushed;
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([1, 2]);
  expect(store.pendingFrameCount).toBe(0);
});

it("drops a frame IndexedDB cannot store without committing or duplicating the rest", async () => {
  const onError = vi.fn();
  const store = await open({ onError });
  const db = internals(store)._db;
  const original = db.transaction.bind(db);
  const abort = vi.fn();
  vi.spyOn(db, "transaction").mockImplementationOnce((...args) => {
    const tx = original(...args) as IDBTransaction & { abort(): void };
    const store = tx.objectStore("frames");
    const add = store.add.bind(store);
    vi.spyOn(store, "add").mockImplementation((value: unknown) => {
      if ((value as { t: number }).t === 3)
        throw new DOMException("payload was detached", "DataCloneError");
      return add(value);
    });
    tx.abort = abort;
    return tx;
  });
  for (const t of [1, 2, 3, 4]) store.appendFrame(frame(t));
  await store.flush();
  // The failed transaction was aborted (so its first adds cannot commit),
  // the unstorable frame was dropped once and reported, and the rest landed once.
  expect(abort).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({
    cause: expect.objectContaining({ name: "DataCloneError" }),
  });
  expect(store.pendingFrameCount).toBe(0);
});

it("gives up on a batch whose transaction keeps failing instead of queueing forever", async () => {
  const store = await open();
  const write = vi
    .spyOn(internals(store), "_writeBatch")
    .mockRejectedValue(new DOMException("disk", "UnknownError"));
  store.appendFrame(frame(1));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(store.flush()).rejects.toThrow("disk");
    expect(store.pendingFrameCount).toBe(attempt < 3 ? 1 : 0);
  }
  write.mockRestore();
  store.appendFrame(frame(2));
  await store.flush();
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([2]);
});

it("frees room with the emergency reclaim when a frame batch hits the quota", async () => {
  const store = await open();
  const reclaim = vi.spyOn(internals(store), "_evictOldest");
  const write = vi.spyOn(internals(store), "_writeBatch");
  write.mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
  store.appendFrame(frame(1));
  await store.flush();
  expect(reclaim).toHaveBeenCalledWith(0.25);
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([1]);
});

it("keeps flushing when file cleanup fails", async () => {
  const store = await open();
  vi.spyOn(internals(store), "_collectGarbage").mockRejectedValue(new Error("opfs gone"));
  store.appendFrame(frame(1));
  await store.flush();
  await store.deleteFramesBefore(2);
  expect(await store.getFrames(0, 10)).toEqual([]);
});

it("handles legacy cleanup batches larger than the engine's argument limit", async () => {
  const store = await open();
  const db = internals(store)._db;
  const names = db.objectStoreNames;
  // A v1 database (no durable outbox) keeps cleanup intents in memory.
  vi.spyOn(db, "objectStoreNames", "get").mockReturnValue({
    ...names,
    contains: (name: string) => name !== GARBAGE_STORE && names.contains(name),
  } as DOMStringList);
  // What two public deleteFramesBefore(cutoff, 100_000) calls leave queued.
  const queued = Array.from({ length: 130_000 }, (_, t) => ({ channelId: "cam", t }));
  const root = (store as unknown as { _opfsRoot: FileSystemDirectoryHandle })._opfsRoot;
  await collectVideoGarbage(db, root, 500, () => false, queued);
  expect(queued).toHaveLength(129_500);
  // deleteFramesBefore appends a removed batch the same way (no argument spread).
  store.appendFrame(frame(1));
  await store.flush();
  await store.deleteFramesBefore(2);
  expect(await store.getFrames(0, 10)).toEqual([]);
});

it("reclaims chunks that releases up to 0.13.2 wrote at the origin root, with their rows", async () => {
  const store = await open();
  await legacyRow(store, 1, "cam");
  await legacyRow(store, 5, "cam");
  await rootFile(["cam", "1.chunk"]);
  await rootFile(["cam", "5.chunk"]);
  expect(await store.readVideoChunk("cam", "1.chunk")).not.toBeNull();
  await store.deleteFramesBefore(2);
  expect(await rootFileExists(["cam", "1.chunk"])).toBe(false);
  // Still referenced by a retained row.
  expect(await rootFileExists(["cam", "5.chunk"])).toBe(true);
  expect(await store.readVideoChunk("cam", "5.chunk")).not.toBeNull();
});

it("tolerates legacy channel ids that are not valid OPFS names", async () => {
  const store = await open();
  await legacyRow(store, 1, "/robot/odom"); // a ROS topic used as a metric channel id
  // Like browsers: no directory handle accepts a name containing "/".
  const proto = Object.getPrototypeOf(
    await navigator.storage.getDirectory(),
  ) as FileSystemDirectoryHandle;
  const lookup = proto.getDirectoryHandle;
  vi.spyOn(proto, "getDirectoryHandle").mockImplementation(function (
    this: FileSystemDirectoryHandle,
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ) {
    return name.includes("/")
      ? Promise.reject(new TypeError("Name is not allowed."))
      : lookup.call(this, name, options);
  });
  await store.deleteFramesBefore(2);
  store.appendFrame(frame(3));
  await store.flush();
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([3]);
});

it("clears the legacy root directories of channels this database recorded", async () => {
  const store = await open();
  await legacyRow(store, 1, "cam");
  await rootFile(["cam", "1.chunk"]);
  await rootFile(["other", "1.chunk"]); // never recorded by this database
  await store.clearAll();
  expect(await rootFileExists(["cam", "1.chunk"])).toBe(false);
  expect(await rootFileExists(["other", "1.chunk"])).toBe(true);
});

it("clearAll resolves when another tab still holds a file open", async () => {
  const store = await open();
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  store.appendFrame(frame(1));
  await store.flush();
  const namespace = (store as unknown as { _opfsRoot: FileSystemDirectoryHandle })
    ._opfsRoot;
  vi.spyOn(namespace, "removeEntry").mockRejectedValue(
    new DOMException("locked", "NoModificationAllowedError"),
  );
  await store.clearAll();
  expect(await store.getFrames(0, 10)).toEqual([]);
  expect(store.pendingFrameCount).toBe(0);
});

it("clearAll resolves when the namespace vanishes mid-iteration", async () => {
  const store = await open();
  const namespace = (store as unknown as { _opfsRoot: FileSystemDirectoryHandle })
    ._opfsRoot;
  vi.spyOn(
    namespace as unknown as { entries(): AsyncIterable<[string, unknown]> },
    "entries",
  ).mockImplementation(async function* () {
    yield* [];
    throw new DOMException("gone", "NotFoundError");
  });
  await store.clearAll();
});

it("frees space at the quota by deleting files before a delete-only transaction", async () => {
  const store = await open();
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  store.appendFrame(frame(1));
  store.appendFrame(frame(9));
  await store.flush();
  const db = internals(store)._db;
  const original = db.transaction.bind(db);
  const scopes: string[] = [];
  vi.spyOn(db, "transaction").mockImplementation((names, mode) => {
    const scope = [names].flat().join("+");
    scopes.push(`${scope}:${mode ?? "readonly"}`);
    if (
      !(mode === "readwrite" && scope.includes(GARBAGE_STORE) && scope.includes("frames"))
    )
      return original(names, mode);
    // Writing cleanup intents needs quota the full disk no longer has.
    const tx = { error: new DOMException("full", "QuotaExceededError") } as Record<
      string,
      unknown
    >;
    const request: Record<string, unknown> = {};
    tx.objectStore = () => ({ index: () => ({ openCursor: () => request }), put() {} });
    queueMicrotask(() => (tx.onabort as () => void)());
    return tx as unknown as IDBTransaction;
  });
  await store.deleteFramesBefore(5);
  expect(await store.readVideoChunk("cam", "1.chunk")).toBeNull();
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([9]);
  expect(scopes).toContain("frames:readwrite");
});

it("open() is idempotent and retried after a failure", async () => {
  const store = new ReplayStore({ dbName: `idempotent-${Date.now()}` });
  stores.push(store);
  const indexed = vi.spyOn(indexedDB, "open");
  indexed.mockImplementationOnce(() => {
    const request = {} as IDBOpenDBRequest;
    queueMicrotask(() => request.onblocked?.call(request, {} as IDBVersionChangeEvent));
    return request;
  });
  await expect(store.open()).rejects.toThrow("blocked");
  const first = store.open();
  expect(store.open()).toBe(first);
  await first;
  expect(indexed).toHaveBeenCalledTimes(2);
});

it("keeps going when the emergency reclaim or a quota-time file removal fails", async () => {
  const store = await open();
  vi.spyOn(internals(store), "_evictOldest").mockRejectedValueOnce(new Error("busy"));
  vi.spyOn(internals(store), "_writeBatch").mockRejectedValueOnce(
    new DOMException("full", "QuotaExceededError"),
  );
  store.appendFrame(frame(1));
  await store.flush();
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([1]);
  // A locked file must not stop the quota fallback from deleting rows.
  const namespace = (store as unknown as { _opfsRoot: FileSystemDirectoryHandle })
    ._opfsRoot;
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  const dir = await namespace.getDirectoryHandle("cam");
  vi.spyOn(namespace, "getDirectoryHandle").mockResolvedValue(dir);
  vi.spyOn(dir, "removeEntry").mockRejectedValue(
    new DOMException("locked", "NoModificationAllowedError"),
  );
  const removeFiles = (
    store as unknown as { _removeChunkFiles(e: unknown[]): Promise<void> }
  )._removeChunkFiles.bind(store);
  await removeFiles([{ channelId: "cam", t: 1 }]);
});

it("propagates a failed read during the quota fallback, and stops at the batch limit", async () => {
  const store = await open();
  await legacyRow(store, 1, "cam");
  store.appendFrame(frame(2, "metric")); // video:false — no chunk to remove
  await store.flush();
  await legacyRow(store, 3, "cam");
  const db = internals(store)._db;
  const original = db.transaction.bind(db);
  let failRead = true;
  vi.spyOn(db, "transaction").mockImplementation((names, mode) => {
    const scope = [names].flat().join("+");
    if (mode === "readwrite" && scope.includes(GARBAGE_STORE)) {
      const tx = { error: new DOMException("full", "QuotaExceededError") } as Record<
        string,
        unknown
      >;
      tx.objectStore = () => ({ index: () => ({ openCursor: () => ({}) }), put() {} });
      queueMicrotask(() => (tx.onabort as () => void)());
      return tx as unknown as IDBTransaction;
    }
    if (mode === undefined && failRead) {
      failRead = false;
      const request = { error: new Error("read failed") } as Record<string, unknown>;
      queueMicrotask(() => (request.onerror as () => void)());
      return {
        objectStore: () => ({ index: () => ({ openCursor: () => request }) }),
      } as unknown as IDBTransaction;
    }
    return original(names, mode);
  });
  await expect(deleteFrameBatch(db, 10, 500, async () => {})).rejects.toThrow(
    "read failed",
  );
  const removed: unknown[] = [];
  await deleteFrameBatch(db, 10, 2, async (entries) => {
    removed.push(...entries);
  });
  expect(removed).toEqual([{ channelId: "cam", t: 1 }]);
  expect((await store.getFrames(0, 10)).map((f) => f.t)).toEqual([3]);
});

it("clears even when a legacy directory cannot be removed or scanned", async () => {
  const store = await open();
  await legacyRow(store, 1, "cam");
  await rootFile(["cam", "1.chunk"]);
  const root = (store as unknown as { _legacyRoot: FileSystemDirectoryHandle })
    ._legacyRoot;
  vi.spyOn(root, "removeEntry").mockRejectedValueOnce(
    new DOMException("locked", "NoModificationAllowedError"),
  );
  await store.clearAll();
  expect(await store.getTimeRange()).toBeNull();
  // A failed scan only skips the legacy reclaim.
  await legacyRow(store, 2, "cam");
  const db = internals(store)._db;
  const original = db.transaction.bind(db);
  vi.spyOn(db, "transaction")
    .mockImplementationOnce(() => {
      const request = { error: new Error("scan failed") } as Record<string, unknown>;
      queueMicrotask(() => (request.onerror as () => void)());
      return {
        objectStore: () => ({ index: () => ({ openCursor: () => request }) }),
      } as unknown as IDBTransaction;
    })
    .mockImplementation((names, mode) => original(names, mode));
  await store.clearAll();
  expect(await store.getTimeRange()).toBeNull();
});

it("clear waits for an in-flight cleanup even when that cleanup fails", async () => {
  const store = await open();
  await store.writeVideoChunk("cam", "1.chunk", new Uint8Array([1]));
  store.appendFrame(frame(1));
  await store.flush();
  const namespace = (store as unknown as { _opfsRoot: FileSystemDirectoryHandle })
    ._opfsRoot;
  const dir = await namespace.getDirectoryHandle("cam");
  vi.spyOn(namespace, "getDirectoryHandle").mockResolvedValue(dir);
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  vi.spyOn(dir, "removeEntry").mockImplementationOnce(() => {
    began();
    return new Promise<void>((r) => (release = r));
  });
  const removing = store.deleteFramesBefore(2);
  await started;
  const db = internals(store)._db;
  const original = db.transaction.bind(db);
  let failCommit = true;
  vi.spyOn(db, "transaction").mockImplementation((names, mode) => {
    if (failCommit && names === GARBAGE_STORE && mode === "readwrite") {
      failCommit = false; // the cleanup's outbox commit
      const tx = { error: new Error("commit failed") } as Record<string, unknown>;
      tx.objectStore = () => ({ delete() {} });
      queueMicrotask(() => (tx.onabort as () => void)());
      return tx as unknown as IDBTransaction;
    }
    return original(names, mode);
  });
  const clearing = store.clearAll();
  release();
  await Promise.all([removing, clearing]);
  expect(failCommit).toBe(false);
  expect(await store.getFrames(0, 10)).toEqual([]);
});
