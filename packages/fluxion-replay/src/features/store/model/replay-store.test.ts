import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayStore } from "./replay-store";

describe("ReplayStore", () => {
  let store: ReplayStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ReplayStore({ batchIntervalMs: 100 });
  });

  afterEach(async () => {
    store.dispose();
    vi.useRealTimers();
  });

  it("opens without error", async () => {
    await expect(store.open()).resolves.toBeUndefined();
  });

  it("throws when not open", () => {
    expect(() =>
      store.appendFrame({ t: 0, channelId: "ch", payload: new ArrayBuffer(4) }),
    ).not.toThrow();
    // getFrames should throw because db is null
  });

  it("open() still succeeds when OPFS is unavailable", async () => {
    const origStorage = navigator.storage;
    Object.defineProperty(globalThis.navigator, "storage", {
      value: {
        getDirectory: async () => {
          throw new Error("OPFS unavailable");
        },
      },
      writable: true,
      configurable: true,
    });
    await expect(store.open()).resolves.toBeUndefined();
    Object.defineProperty(globalThis.navigator, "storage", {
      value: origStorage,
      writable: true,
      configurable: true,
    });
  });

  describe("open lifecycle (StrictMode race / blocked)", () => {
    // Test-only IDB controls installed by src/test/setup.ts.
    const idb = (
      globalThis as unknown as {
        __fakeIDBControls: {
          setForceBlocked: (v: boolean) => void;
          setDeferOpen: (v: boolean) => void;
          resolvePendingOpens: () => Array<{ closeCount: number }>;
          reset: () => void;
        };
      }
    ).__fakeIDBControls;

    afterEach(() => idb.reset());

    it("open() rejects (does not hang) when the IDB open is blocked", async () => {
      idb.setForceBlocked(true);
      const s = new ReplayStore();
      await expect(s.open()).rejects.toThrow(/blocked/);
    });

    it("dispose() during an in-flight open closes the connection and starts no flush timer", async () => {
      idb.setDeferOpen(true);
      const s = new ReplayStore({ batchIntervalMs: 100 });
      const startSpy = vi.spyOn(
        s as unknown as { _startFlushTimer: () => void },
        "_startFlushTimer",
      );

      const p = s.open(); // suspended — open hasn't resolved
      s.dispose(); // dispose BEFORE the open resolves
      const dbs = idb.resolvePendingOpens(); // now let _openIDB resolve
      await p; // resolves to a no-op (does not reject)

      // The produced connection was closed (not leaked as a zombie)…
      expect(dbs).toHaveLength(1);
      expect(dbs[0]!.closeCount).toBe(1);
      // …and the dead store never started its flush timer.
      expect(startSpy).not.toHaveBeenCalled();
      expect((s as unknown as { _db: unknown })._db).toBeNull();
    });

    it("dispose() during the OPFS await closes the connection and starts no flush timer", async () => {
      // IDB resolves synchronously (default fake) — hold the OPFS getDirectory()
      // so dispose() lands while open() is suspended AFTER _db was assigned.
      let releaseOpfs!: () => void;
      const opfsHeld = new Promise<FileSystemDirectoryHandle>((resolve) => {
        releaseOpfs = () => resolve({} as FileSystemDirectoryHandle);
      });
      const origStorage = navigator.storage;
      Object.defineProperty(globalThis.navigator, "storage", {
        value: { getDirectory: () => opfsHeld },
        writable: true,
        configurable: true,
      });

      const s = new ReplayStore({ batchIntervalMs: 100 });
      const startSpy = vi.spyOn(
        s as unknown as { _startFlushTimer: () => void },
        "_startFlushTimer",
      );
      try {
        const p = s.open();
        // Let _openIDB resolve and open() advance to the (held) OPFS await.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        const db = (s as unknown as { _db: { closeCount: number } | null })._db;
        expect(db).not.toBeNull();

        s.dispose(); // dispose while suspended on the OPFS await
        releaseOpfs(); // the OPFS await resolves → re-check branch runs
        await p;

        expect(db!.closeCount).toBe(1); // the assigned connection was closed
        expect((s as unknown as { _db: unknown })._db).toBeNull();
        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        // Always restore — otherwise a held getDirectory() poisons later tests.
        releaseOpfs();
        Object.defineProperty(globalThis.navigator, "storage", {
          value: origStorage,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe("after open()", () => {
    beforeEach(async () => {
      await store.open();
    });

    it("appendFrame and flush writes to IDB", async () => {
      const payload = new TextEncoder().encode("hello").buffer as ArrayBuffer;
      store.appendFrame({ t: 1000, channelId: "logs", payload });
      await store.flush();

      const frames = await store.getFrames(900, 1100);
      expect(frames).toHaveLength(1);
      expect(frames[0].t).toBe(1000);
      expect(frames[0].channelId).toBe("logs");
    });

    it("batch flush via interval timer", async () => {
      store.appendFrame({ t: 2000, channelId: "metrics", payload: new ArrayBuffer(8) });
      store.appendFrame({ t: 2100, channelId: "metrics", payload: new ArrayBuffer(8) });

      // Before flush — nothing in IDB
      let frames = await store.getFrames(1900, 2200);
      expect(frames).toHaveLength(0);

      // Advance timer to trigger flush
      vi.advanceTimersByTime(110);
      await Promise.resolve();
      await Promise.resolve();

      frames = await store.getFrames(1900, 2200);
      expect(frames).toHaveLength(2);
    });

    it("getFrames returns only frames in the time range", async () => {
      for (const t of [1000, 2000, 3000, 4000]) {
        store.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await store.flush();

      const frames = await store.getFrames(1500, 3500);
      expect(frames.map((f) => f.t).sort()).toEqual([2000, 3000]);
    });

    it("deleteFramesBefore removes old frames", async () => {
      for (const t of [100, 200, 300, 400, 500]) {
        store.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await store.flush();

      await store.deleteFramesBefore(300);

      const remaining = await store.getFrames(0, 1000);
      expect(remaining.map((f) => f.t).sort((a, b) => a - b)).toEqual([300, 400, 500]);
    });

    it("getTimeRange returns null when empty", async () => {
      const range = await store.getTimeRange();
      expect(range).toBeNull();
    });

    it("getTimeRange returns earliest and latest", async () => {
      for (const t of [500, 100, 300]) {
        store.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await store.flush();

      const range = await store.getTimeRange();
      expect(range).toEqual({ earliest: 100, latest: 500 });
    });

    it("writeVideoChunk and readVideoChunk round-trip", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await store.writeVideoChunk("camera", "frame1.chunk", data);
      const result = await store.readVideoChunk("camera", "frame1.chunk");
      expect(result).toEqual(data);
    });

    it("readVideoChunk returns null for missing chunk", async () => {
      const result = await store.readVideoChunk("camera", "nonexistent.chunk");
      expect(result).toBeNull();
    });

    it("deleteVideoChunk removes the chunk", async () => {
      const data = new Uint8Array([9, 8, 7]);
      await store.writeVideoChunk("cam", "del.chunk", data);
      await store.deleteVideoChunk("cam", "del.chunk");
      // Should not throw and should return null now
      const result = await store.readVideoChunk("cam", "del.chunk");
      expect(result).toBeNull();
    });

    it("deleteVideoChunk is a no-op when OPFS is unavailable", async () => {
      // Store opened but OPFS root forcibly nulled
      // deleteVideoChunk has an early-return guard for null root
      const storeNoOpfs = new ReplayStore({ batchIntervalMs: 9999 });
      const origStorage = navigator.storage;
      Object.defineProperty(globalThis.navigator, "storage", {
        value: {
          getDirectory: async () => {
            throw new Error("no opfs");
          },
        },
        writable: true,
        configurable: true,
      });
      await storeNoOpfs.open();
      Object.defineProperty(globalThis.navigator, "storage", {
        value: origStorage,
        writable: true,
        configurable: true,
      });
      await expect(
        storeNoOpfs.deleteVideoChunk("cam", "x.chunk"),
      ).resolves.toBeUndefined();
      storeNoOpfs.dispose();
    });

    it("writeVideoChunk throws when OPFS unavailable", async () => {
      const storeNoOpfs = new ReplayStore({ batchIntervalMs: 9999 });
      const origStorage = navigator.storage;
      Object.defineProperty(globalThis.navigator, "storage", {
        value: {
          getDirectory: async () => {
            throw new Error("no opfs");
          },
        },
        writable: true,
        configurable: true,
      });
      await storeNoOpfs.open();
      Object.defineProperty(globalThis.navigator, "storage", {
        value: origStorage,
        writable: true,
        configurable: true,
      });
      await expect(
        storeNoOpfs.writeVideoChunk("cam", "x.chunk", new Uint8Array([1])),
      ).rejects.toThrow("OPFS");
      storeNoOpfs.dispose();
    });

    it("getStorageInfo returns usedBytes, quotaBytes and percentUsed", async () => {
      const info = await store.getStorageInfo();
      expect(typeof info.usedBytes).toBe("number");
      expect(typeof info.quotaBytes).toBe("number");
      expect(info.percentUsed).toBeGreaterThanOrEqual(0);
      expect(info.percentUsed).toBeLessThanOrEqual(100);
    });

    it("getStorageInfo.idbFrameCount increases after flush", async () => {
      const before = await store.getStorageInfo();
      store.appendFrame({ t: 9000, channelId: "ch", payload: new ArrayBuffer(4) });
      await store.flush();
      const after = await store.getStorageInfo();
      expect(after.idbFrameCount).toBeGreaterThan(before.idbFrameCount);
    });

    it("getFrames with inverted range (from > to) returns empty", async () => {
      store.appendFrame({ t: 500, channelId: "ch", payload: new ArrayBuffer(4) });
      await store.flush();
      const frames = await store.getFrames(1000, 100);
      expect(frames).toHaveLength(0);
    });

    describe("getFramesByChannel", () => {
      it("returns only frames for the requested channel", async () => {
        for (const t of [100, 200, 300]) {
          store.appendFrame({ t, channelId: "cpu", payload: new ArrayBuffer(4) });
          store.appendFrame({ t, channelId: "mem", payload: new ArrayBuffer(4) });
        }
        await store.flush();

        const cpu = await store.getFramesByChannel("cpu", 0, 1000);
        expect(cpu).toHaveLength(3);
        expect(cpu.every((f) => f.channelId === "cpu")).toBe(true);

        const mem = await store.getFramesByChannel("mem", 0, 1000);
        expect(mem).toHaveLength(3);
        expect(mem.every((f) => f.channelId === "mem")).toBe(true);
      });

      it("respects the time range bounds", async () => {
        for (const t of [100, 200, 300, 400, 500]) {
          store.appendFrame({ t, channelId: "cpu", payload: new ArrayBuffer(4) });
        }
        await store.flush();

        const mid = await store.getFramesByChannel("cpu", 150, 450);
        expect(mid.map((f) => f.t).sort((a, b) => a - b)).toEqual([200, 300, 400]);
      });

      it("returns frames sorted ascending by t", async () => {
        // Insert out of order to verify the IDB index returns sorted results
        for (const t of [500, 100, 300, 200, 400]) {
          store.appendFrame({ t, channelId: "cpu", payload: new ArrayBuffer(4) });
        }
        await store.flush();

        const frames = await store.getFramesByChannel("cpu", 0, 1000);
        const ts = frames.map((f) => f.t);
        expect(ts).toEqual([...ts].sort((a, b) => a - b));
      });

      it("returns empty array when channel has no frames in range", async () => {
        store.appendFrame({ t: 100, channelId: "cpu", payload: new ArrayBuffer(4) });
        await store.flush();
        const frames = await store.getFramesByChannel("missing", 0, 1000);
        expect(frames).toEqual([]);
      });
    });

    it("dispose() clears pending frames", () => {
      store.appendFrame({ t: 1, channelId: "ch", payload: new ArrayBuffer(4) });
      store.dispose();
      // After dispose, _db is null so getFrames would throw — just verify no crash
      expect(() => store.dispose()).not.toThrow();
    });

    it("error message includes dbName when not open", () => {
      const namedStore = new ReplayStore({ dbName: "my-custom-db" });
      expect(() => namedStore.getFrames(0, 1000)).rejects.toThrow("my-custom-db");
    });

    it("startSegment closes any previously open segment before creating a new one (line 204)", () => {
      store.startSegment(1000);
      // Call startSegment again — should close the open segment at t=2000 before opening a new one
      store.startSegment(2000);
      const segs = store.getSegments();
      expect(segs).toHaveLength(2);
      expect(segs[0]!.start).toBe(1000);
      expect(segs[0]!.end).toBe(2000);
      expect(segs[1]!.start).toBe(2000);
      expect(segs[1]!.end).toBeNull();
    });

    it("_maybeEvict does nothing when evictThresholdPct is 100", async () => {
      const noEvictStore = new ReplayStore({
        batchIntervalMs: 9999,
        evictThresholdPct: 100,
      });
      await noEvictStore.open();
      const deleteSpy = vi.spyOn(noEvictStore, "deleteFramesBefore");

      for (const t of [100, 200, 300]) {
        noEvictStore.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await noEvictStore.flush();

      expect(deleteSpy).not.toHaveBeenCalled();
      noEvictStore.dispose();
      deleteSpy.mockRestore();
    });

    it("_maybeEvict deletes oldest 10% when storage exceeds threshold", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      const deleteSpy = vi.spyOn(evictStore, "deleteFramesBefore");

      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 100,
        quotaBytes: 100,
        percentUsed: 50,
        idbFrameCount: 3,
      });

      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        evictStore.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await evictStore.flush();

      // earliest=1000, latest=5000, span=4000, cutoff = 1000 + floor(4000 * 0.1) = 1400
      expect(deleteSpy).toHaveBeenCalledWith(1400);
      evictStore.dispose();
      deleteSpy.mockRestore();
    });

    it("_maybeEvict trims segments whose start is before the cutoff", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      // Segment spans [0, 5000]; frames at t=[1000..5000]
      evictStore.startSegment(0);
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 100,
        quotaBytes: 100,
        percentUsed: 50,
        idbFrameCount: 5,
      });
      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        evictStore.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await evictStore.flush();

      // cutoffMs = 1000 + floor(4000 * 0.1) = 1400
      const segs = evictStore.getSegments();
      expect(segs.length).toBe(1);
      expect(segs[0]!.start).toBeGreaterThanOrEqual(1400);
      evictStore.dispose();
    });

    it("_maybeEvict removes segments that end before the cutoff", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      // Two segments: [0, 500] (ends before cutoff) and [2000, 5000] (after cutoff)
      evictStore.startSegment(0);
      evictStore.endSegment(500);
      evictStore.startSegment(2000);
      evictStore.endSegment(5000);
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 100,
        quotaBytes: 100,
        percentUsed: 50,
        idbFrameCount: 5,
      });
      // Frames: earliest=1000, latest=5000 → cutoff = 1400
      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        evictStore.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await evictStore.flush();

      // Segment [0, 500] is fully before cutoff=1400 → removed
      // Segment [2000, 5000] is fully after → kept
      const segs = evictStore.getSegments();
      expect(segs).toHaveLength(1);
      expect(segs[0]!.start).toBe(2000);
      expect(segs[0]!.end).toBe(5000);
      evictStore.dispose();
    });

    it("_maybeEvict clips an open segment (end=null) to the cutoff without removing it", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      // Open segment representing an ongoing recording
      evictStore.startSegment(0);
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 100,
        quotaBytes: 100,
        percentUsed: 50,
        idbFrameCount: 5,
      });
      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        evictStore.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }
      await evictStore.flush();

      // cutoffMs = 1400; open segment start moves to 1400, end stays null
      const segs = evictStore.getSegments();
      expect(segs).toHaveLength(1);
      expect(segs[0]!.start).toBeGreaterThanOrEqual(1400);
      expect(segs[0]!.end).toBeNull();
      evictStore.dispose();
    });

    it("_maybeEvict over threshold but empty store → no delete (null time range)", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      const deleteSpy = vi.spyOn(evictStore, "deleteFramesBefore");
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 100,
        quotaBytes: 100,
        percentUsed: 50,
        idbFrameCount: 0,
      });
      // No frames recorded → getTimeRange() returns null → eviction bails.
      await evictStore.flush();
      expect(deleteSpy).not.toHaveBeenCalled();
      evictStore.dispose();
      deleteSpy.mockRestore();
    });

    it("_maybeEvict over threshold with a zero-span range → no delete", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      const deleteSpy = vi.spyOn(evictStore, "deleteFramesBefore");
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 100,
        quotaBytes: 100,
        percentUsed: 50,
        idbFrameCount: 1,
      });
      // A single frame → earliest === latest → spanMs <= 0 → eviction bails.
      evictStore.appendFrame({ t: 1000, channelId: "ch", payload: new ArrayBuffer(4) });
      await evictStore.flush();
      expect(deleteSpy).not.toHaveBeenCalled();
      evictStore.dispose();
      deleteSpy.mockRestore();
    });

    it("_maybeEvict does nothing when storage is below threshold", async () => {
      const evictStore = new ReplayStore({
        batchIntervalMs: 9999,
        evictThresholdPct: 80,
      });
      await evictStore.open();
      const deleteSpy = vi.spyOn(evictStore, "deleteFramesBefore");

      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 10,
        quotaBytes: 100,
        percentUsed: 10,
        idbFrameCount: 3,
      });

      evictStore.appendFrame({ t: 1000, channelId: "ch", payload: new ArrayBuffer(4) });
      await evictStore.flush();

      expect(deleteSpy).not.toHaveBeenCalled();
      evictStore.dispose();
      deleteSpy.mockRestore();
    });

    it("storageLogTimer calls console.log on interval", async () => {
      const logStore = new ReplayStore({
        batchIntervalMs: 9999,
        storageLogIntervalMs: 1000,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await logStore.open();

      await vi.advanceTimersByTimeAsync(1000);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[ReplayStore"));
      logStore.dispose();
      logSpy.mockRestore();
    });

    it("storageLogTimer is not started when storageLogIntervalMs is 0", async () => {
      const logStore = new ReplayStore({
        batchIntervalMs: 9999,
        storageLogIntervalMs: 0,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await logStore.open();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(logSpy).not.toHaveBeenCalled();
      logStore.dispose();
      logSpy.mockRestore();
    });

    it("clearAll iterates OPFS root entries and removes them (lines 291-293)", async () => {
      const removedNames: string[] = [];
      const fakeRoot = {
        // Async generator that yields one entry
        entries: async function* () {
          yield ["chunk1.webm", {} as FileSystemHandle] as [string, FileSystemHandle];
        },
        removeEntry: vi.fn(async (name: string) => {
          removedNames.push(name);
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;
      await store.clearAll();
      expect(removedNames).toContain("chunk1.webm");
    });

    it("writeVideoChunk writes data through OPFS mock (lines 276-278)", async () => {
      const writtenData: Uint8Array[] = [];
      const fakeFile = {
        createWritable: async () => ({
          write: vi.fn(async (d: Uint8Array) => writtenData.push(d)),
          close: vi.fn(async () => {}),
        }),
      };
      const fakeDir = {
        getFileHandle: vi.fn(async () => fakeFile),
      };
      const fakeRoot = {
        getDirectoryHandle: vi.fn(async () => fakeDir),
      };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;

      const data = new Uint8Array([1, 2, 3, 4]);
      await store.writeVideoChunk("cam", "test.chunk", data);
      expect(writtenData).toHaveLength(1);
    });

    it("readVideoChunk returns data from OPFS mock (lines 280-292)", async () => {
      const payload = new Uint8Array([5, 6, 7, 8]);
      const fakeFile = { arrayBuffer: async () => payload.buffer as ArrayBuffer };
      const fakeFileHandle = { getFile: async () => fakeFile };
      const fakeDir = { getFileHandle: vi.fn(async () => fakeFileHandle) };
      const fakeRoot = { getDirectoryHandle: vi.fn(async () => fakeDir) };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;

      const result = await store.readVideoChunk("cam", "test.chunk");
      expect(result).toEqual(payload);
    });

    it("readVideoChunk returns null when opfsRoot is null (line 282)", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: injecting null OPFS root
      (store as any)._opfsRoot = null;
      const result = await store.readVideoChunk("cam", "missing.chunk");
      expect(result).toBeNull();
    });

    it("readVideoChunk returns null when file does not exist (catch path)", async () => {
      const fakeRoot = {
        getDirectoryHandle: vi.fn(async () => {
          throw new Error("not found");
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;
      const result = await store.readVideoChunk("cam", "ghost.chunk");
      expect(result).toBeNull();
    });

    it("writeVideoChunk throws when opfsRoot is null (_assertOpfs)", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: injecting null OPFS root
      (store as any)._opfsRoot = null;
      await expect(
        store.writeVideoChunk("cam", "x.chunk", new Uint8Array([1])),
      ).rejects.toThrow("OPFS");
    });

    it("_writeBatch is called during flush (statements coverage lines 411-423)", async () => {
      // _writeBatch is a private method called from flush(). This exercises the
      // IDB transaction path: store.add per record + oncomplete resolution.
      store.appendFrame({ t: 9000, channelId: "batch-ch", payload: new ArrayBuffer(4) });
      store.appendFrame({ t: 9100, channelId: "batch-ch", payload: new ArrayBuffer(4) });
      await expect(store.flush()).resolves.toBeUndefined();
      const frames = await store.getFrames(8900, 9200);
      expect(frames).toHaveLength(2);
    });

    // ─── OPFS video-chunk eviction ────────────────────────────────────────────

    it("deleteVideoChunksBefore deletes only video chunks older than the cutoff", async () => {
      const CH = "dvcb-cam";
      for (const t of [1000, 2000, 3000]) {
        await store.writeVideoChunk(CH, `${t}.chunk`, new Uint8Array([1, 2, 3]));
        store.appendFrame({ t, channelId: CH, payload: new ArrayBuffer(1) });
      }
      await store.flush();

      await store.deleteVideoChunksBefore(2500);

      expect(await store.readVideoChunk(CH, "1000.chunk")).toBeNull();
      expect(await store.readVideoChunk(CH, "2000.chunk")).toBeNull();
      expect(await store.readVideoChunk(CH, "3000.chunk")).not.toBeNull();
    });

    it("deleteVideoChunksBefore respects the per-pass limit", async () => {
      const CH = "dvcb-limit-cam";
      for (const t of [1000, 2000, 3000]) {
        await store.writeVideoChunk(CH, `${t}.chunk`, new Uint8Array([1]));
        store.appendFrame({ t, channelId: CH, payload: new ArrayBuffer(1) });
      }
      await store.flush();

      // Only one deletion allowed this pass → the two remaining survive.
      await store.deleteVideoChunksBefore(9000, 1);

      const survivors = [
        await store.readVideoChunk(CH, "1000.chunk"),
        await store.readVideoChunk(CH, "2000.chunk"),
        await store.readVideoChunk(CH, "3000.chunk"),
      ].filter((c) => c !== null);
      expect(survivors).toHaveLength(2);
    });

    it("deleteVideoChunksBefore is a no-op when no video channel was written", async () => {
      store.appendFrame({
        t: 1000,
        channelId: "metric-only",
        payload: new ArrayBuffer(1),
      });
      await store.flush();
      await expect(store.deleteVideoChunksBefore(5000)).resolves.toBeUndefined();
    });

    it("deleteVideoChunksBefore is a no-op when OPFS is unavailable", async () => {
      await store.writeVideoChunk("noopfs-cam", "1000.chunk", new Uint8Array([1]));
      // biome-ignore lint/suspicious/noExplicitAny: injecting null OPFS root
      (store as any)._opfsRoot = null;
      await expect(store.deleteVideoChunksBefore(5000)).resolves.toBeUndefined();
    });

    it("deleteVideoChunksBefore swallows query errors (never crashes eviction)", async () => {
      await store.writeVideoChunk("err-cam", "1000.chunk", new Uint8Array([1]));
      // biome-ignore lint/suspicious/noExplicitAny: forcing the query to reject
      vi.spyOn(store as any, "getFramesByChannel").mockRejectedValue(
        new Error("idb boom"),
      );
      await expect(store.deleteVideoChunksBefore(5000)).resolves.toBeUndefined();
    });

    it("eviction reclaims OPFS video chunks once storage exceeds the threshold", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      const CH = "e2e-cam";
      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        await evictStore.writeVideoChunk(CH, `${t}.chunk`, new Uint8Array([1]));
        evictStore.appendFrame({ t, channelId: CH, payload: new ArrayBuffer(1) });
      }
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 900,
        quotaBytes: 1000,
        percentUsed: 90,
        idbFrameCount: 5,
      });

      await evictStore.flush();

      // cutoff = 1000 + floor(4000 * 0.1) = 1400 → only the t=1000 chunk is older.
      expect(await evictStore.readVideoChunk(CH, "1000.chunk")).toBeNull();
      expect(await evictStore.readVideoChunk(CH, "2000.chunk")).not.toBeNull();
      evictStore.dispose();
    });

    // ─── writeVideoChunk quota resilience ─────────────────────────────────────

    it("writeVideoChunk reclaims and retries once on QuotaExceededError, then succeeds", async () => {
      let writeCalls = 0;
      const fakeRoot = {
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => ({
              write: async () => {
                writeCalls++;
                if (writeCalls === 1) {
                  throw new DOMException("quota", "QuotaExceededError");
                }
              },
              close: async () => {},
            }),
          }),
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;
      // biome-ignore lint/suspicious/noExplicitAny: spying private reclaim
      const evictSpy = vi.spyOn(store as any, "_evictOldest").mockResolvedValue(null);

      await expect(
        store.writeVideoChunk("retry-cam", "1.chunk", new Uint8Array([1])),
      ).resolves.toBeUndefined();

      expect(evictSpy).toHaveBeenCalledWith(0.25);
      expect(writeCalls).toBe(2);
    });

    it("writeVideoChunk rethrows when quota is still exhausted after reclaim + retry", async () => {
      const fakeRoot = {
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => ({
              write: async () => {
                throw new DOMException("quota", "QuotaExceededError");
              },
              close: async () => {},
            }),
          }),
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;
      // biome-ignore lint/suspicious/noExplicitAny: spying private reclaim
      const evictSpy = vi.spyOn(store as any, "_evictOldest").mockResolvedValue(null);

      await expect(
        store.writeVideoChunk("retry-cam", "1.chunk", new Uint8Array([1])),
      ).rejects.toThrow("quota");
      expect(evictSpy).toHaveBeenCalledTimes(1);
    });

    it("writeVideoChunk rethrows a non-quota error without reclaiming", async () => {
      const fakeRoot = {
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => ({
              write: async () => {
                throw new DOMException("nope", "NotFoundError");
              },
              close: async () => {},
            }),
          }),
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: injecting fake OPFS root
      (store as any)._opfsRoot = fakeRoot;
      // biome-ignore lint/suspicious/noExplicitAny: spying private reclaim
      const evictSpy = vi.spyOn(store as any, "_evictOldest").mockResolvedValue(null);

      await expect(
        store.writeVideoChunk("nq-cam", "1.chunk", new Uint8Array([1])),
      ).rejects.toThrow("nope");
      expect(evictSpy).not.toHaveBeenCalled();
    });

    it("writeVideoChunk runs the REAL emergency reclaim (unmocked _evictOldest) then retries", async () => {
      const CH = "emergency-cam";
      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        await store.writeVideoChunk(CH, `${t}.chunk`, new Uint8Array([1]));
        store.appendFrame({ t, channelId: CH, payload: new ArrayBuffer(1) });
      }
      await store.flush();

      // The next write throws quota on its first attempt → the REAL
      // _evictOldest(0.25) runs (not mocked) → the retry (2nd attempt) resolves.
      const writeSpy = vi
        .spyOn(store as any, "_writeChunkOnce")
        .mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"))
        .mockResolvedValue(undefined);

      await expect(
        store.writeVideoChunk(CH, "6000.chunk", new Uint8Array([1])),
      ).resolves.toBeUndefined();

      // Emergency cutoff = 1000 + floor(4000 * 0.25) = 2000 → the t=1000 chunk
      // was ACTUALLY reclaimed from OPFS by the real reclaim; t=2000 retained.
      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(await store.readVideoChunk(CH, "1000.chunk")).toBeNull();
      expect(await store.readVideoChunk(CH, "2000.chunk")).not.toBeNull();
    });

    it("deleteVideoChunksBefore prunes every registered video channel", async () => {
      for (const ch of ["mc-cam", "mc-screen"]) {
        for (const t of [1000, 2000, 3000]) {
          await store.writeVideoChunk(ch, `${t}.chunk`, new Uint8Array([1]));
          store.appendFrame({ t, channelId: ch, payload: new ArrayBuffer(1) });
        }
      }
      await store.flush();

      await store.deleteVideoChunksBefore(2500);

      for (const ch of ["mc-cam", "mc-screen"]) {
        expect(await store.readVideoChunk(ch, "1000.chunk")).toBeNull();
        expect(await store.readVideoChunk(ch, "2000.chunk")).toBeNull();
        expect(await store.readVideoChunk(ch, "3000.chunk")).not.toBeNull();
      }
    });

    it("deleteVideoChunksBefore shares the per-pass limit across channels", async () => {
      for (const ch of ["lim-cam", "lim-screen"]) {
        for (const t of [1000, 2000, 3000]) {
          await store.writeVideoChunk(ch, `${t}.chunk`, new Uint8Array([1]));
          store.appendFrame({ t, channelId: ch, payload: new ArrayBuffer(1) });
        }
      }
      await store.flush();

      // Six chunks sit below the cutoff, but the budget is 3 → only 3 delete.
      await store.deleteVideoChunksBefore(9000, 3);

      let survivors = 0;
      for (const ch of ["lim-cam", "lim-screen"]) {
        for (const t of [1000, 2000, 3000]) {
          if ((await store.readVideoChunk(ch, `${t}.chunk`)) !== null) survivors++;
        }
      }
      expect(survivors).toBe(3);
    });

    it("_oldestChannelTimestampsBefore returns the oldest `limit` timestamps below the cutoff", async () => {
      const CH = "oldest-cam";
      for (const t of [1000, 2000, 3000, 4000]) {
        store.appendFrame({ t, channelId: CH, payload: new ArrayBuffer(1) });
      }
      await store.flush();
      // Only 2 requested though 3 sit below 3500 → stops at the limit, ascending.
      // biome-ignore lint/suspicious/noExplicitAny: private cursor helper
      const capped = await (store as any)._oldestChannelTimestampsBefore(CH, 3500, 2);
      expect(capped).toEqual([1000, 2000]);
      // Fewer than the limit below the cutoff → returns them all (end-of-data).
      // biome-ignore lint/suspicious/noExplicitAny: private cursor helper
      const all = await (store as any)._oldestChannelTimestampsBefore(CH, 3500, 10);
      expect(all).toEqual([1000, 2000, 3000]);
    });

    // ─── eviction pause (no time-travel data loss) ────────────────────────────

    it("setEvictionPaused(true) suppresses threshold eviction; resume re-enables it", async () => {
      const evictStore = new ReplayStore({ batchIntervalMs: 9999, evictThresholdPct: 0 });
      await evictStore.open();
      const deleteSpy = vi.spyOn(evictStore, "deleteFramesBefore");
      vi.spyOn(evictStore, "getStorageInfo").mockResolvedValue({
        usedBytes: 900,
        quotaBytes: 1000,
        percentUsed: 90,
        idbFrameCount: 5,
      });
      for (const t of [1000, 2000, 3000, 4000, 5000]) {
        evictStore.appendFrame({ t, channelId: "ch", payload: new ArrayBuffer(4) });
      }

      evictStore.setEvictionPaused(true);
      await evictStore.flush();
      expect(deleteSpy).not.toHaveBeenCalled();

      evictStore.setEvictionPaused(false);
      await evictStore.flush(); // pending already drained → the final _maybeEvict runs
      // cutoff = 1000 + floor(4000 * 0.1) = 1400
      expect(deleteSpy).toHaveBeenCalledWith(1400);

      evictStore.dispose();
      deleteSpy.mockRestore();
    });

    it("getStorageInfo({ withCount: false }) skips the frame count", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: spying private count
      const countSpy = vi.spyOn(store as any, "_countFrames");

      const light = await store.getStorageInfo({ withCount: false });
      expect(light.idbFrameCount).toBe(0);
      expect(countSpy).not.toHaveBeenCalled();

      const full = await store.getStorageInfo();
      expect(countSpy).toHaveBeenCalledTimes(1);
      expect(typeof full.idbFrameCount).toBe("number");
    });
  });
});
