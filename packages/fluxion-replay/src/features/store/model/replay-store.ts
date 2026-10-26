import type {
  DecodedFrame,
  RecordingSegment,
  StorageInfo,
} from "../../../shared/model/storage";

export type {
  DecodedFrame,
  RecordingSegment,
  StorageInfo,
} from "../../../shared/model/storage";

import { isQuotaExceededError } from "../../../shared/lib/is-quota-exceeded-error";
import type { BaseChannel } from "../../../shared/model/base-channel";
import type { SerializedFrame } from "../../../shared/model/frame";
import {
  chunkRemover,
  collectVideoGarbage,
  deleteFrameBatch,
  GARBAGE_STORE,
  type Garbage,
} from "./frame-eviction";

export interface ReplayStoreOptions {
  dbName?: string;
  dbVersion?: number;
  /** Persisted history window relative to the latest frame. Default Infinity
   * preserves existing recordings; set explicitly to enable time retention. */
  retentionMs?: number;
  /** Queue bound. appendFrame throws before accepting a frame when full. Default Infinity (opt-in backpressure). */
  maxPendingFrames?: number;
  /** Background write failures are retried on the next interval, never discarded. */
  onError?: (error: unknown) => void;
  batchIntervalMs?: number;
  /**
   * Storage usage percentage (0–100) at which old frames are automatically
   * evicted. Usage is checked every 10th flush; once it reaches this value,
   * every flush trims the oldest 1% of the recorded time span (frames and
   * their video chunks) until usage falls 5 points below it.
   * Set to 100 (or above) to disable automatic eviction. Default: 70.
   */
  evictThresholdPct?: number;
  /**
   * Interval in milliseconds at which current storage usage is logged to
   * `console.log`. Set to 0 to disable. Default: 0.
   */
  storageLogIntervalMs?: number;
}

const DEFAULT_DB_NAME = "fluxion-replay";
const DEFAULT_DB_VERSION = 1;
const DEFAULT_RETENTION_MS = Infinity;
const DEFAULT_BATCH_INTERVAL_MS = 500;
// Maximum records written per IDB transaction. Capping this prevents a single
// flush from queuing hundreds of store.add() calls synchronously, which blocks
// the main thread for several frames. Excess records stay in _pending and are
// drained in successive asynchronous transactions (one writer per store).
const MAX_BATCH_SIZE = 200;
// Run eviction only every N flushes to avoid calling navigator.storage.estimate()
// and the deleteFramesBefore cursor loop on every 500 ms tick.
const EVICT_EVERY_N_FLUSHES = 10;
// Maximum number of IDB records deleted in a single eviction pass. Limits the
// duration of the cursor-delete loop so it doesn't freeze the main thread when
// there are tens of thousands of stale records to remove.
const MAX_DELETE_PER_EVICTION = 500;
// Maximum number of OPFS video chunk files deleted per eviction pass. Chunk
// files are the bulk of storage and removeEntry is async I/O (not a main-thread
// cursor loop like IDB deletion), so a higher cap than MAX_DELETE_PER_EVICTION
// is safe and reclaims the heavy data faster.
const MAX_OPFS_DELETE_PER_EVICTION = 2000;
// Number of OPFS removeEntry calls issued concurrently per batch, so a
// long-recording channel doesn't queue thousands of file ops at once.
const OPFS_DELETE_BATCH = 64;
// A batch whose transaction keeps failing is retried on this many consecutive
// drains, then dropped, so a persistent failure cannot grow the queue forever.
const MAX_WRITE_ATTEMPTS = 3;
// Share of the recorded span trimmed per drain while storage stays over the
// threshold. Draining every 500 ms keeps up with high-rate ingestion, while 1%
// per drain shrinks history no faster than 0.13.2's 10% per 5 s when the usage
// is not this store's to reclaim (other databases, other origins' data).
const PRESSURE_TRIM_FRACTION = 0.01;

/** IDB rejected one record synchronously (e.g. a detached payload): never storable. */
class UnstorableFrameError extends Error {
  constructor(
    readonly index: number,
    cause: unknown,
  ) {
    super("ReplayStore dropped a frame IndexedDB cannot store", { cause });
  }
}

interface FrameRecord {
  t: number;
  channelId: string;
  payload: ArrayBuffer;
  /** Legacy rows omit this marker; new metric rows need no file cleanup intent. */
  video?: boolean;
}

export class ReplayStore {
  private _db: IDBDatabase | null = null;
  // Latched in dispose(). If dispose() runs while open() is suspended on an
  // await (StrictMode mount→cleanup→mount), open() closes the connection it
  // just produced and bails — otherwise that connection leaks as a zombie that
  // can block (and hang) every subsequent open.
  private _disposed = false;
  private _opfsRoot: FileSystemDirectoryHandle | null = null;
  private _pending: FrameRecord[] = [];
  // Frames handed to appendFrame, and frames committed / dropped / cleared.
  // flush() waits for every frame appended before it to settle.
  private _appended = 0;
  private _settled = 0;
  private _failedWrites = 0;
  private _opening: Promise<void> | null = null;
  private _writeTask: Promise<void> | null = null;
  private _clearTask: Promise<void> | null = null;
  private _writeGeneration = 0;
  private _legacyRoot: FileSystemDirectoryHandle | null = null;
  private readonly _maxPendingFrames: number;
  private readonly _onError?: (error: unknown) => void;
  private _lastWriteError: unknown = null;
  private readonly _videoWrites = new Set<Promise<void>>();
  private readonly _videoPaths = new Map<string, number>();

  get recordingGeneration(): number {
    return this._writeGeneration;
  }
  get pendingFrameCount(): number {
    return this._pending.length;
  }
  get lastWriteError(): unknown {
    return this._lastWriteError;
  }
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _retentionMs: number;
  private _batchIntervalMs: number;
  private _dbName: string;
  private _dbVersion: number;
  private _segments: RecordingSegment[] = [];
  private _evictThresholdPct: number;
  private _storageLogIntervalMs: number;
  private _storageLogTimer: ReturnType<typeof setInterval> | null = null;
  private _flushCount = 0;
  private _storagePressure = false;
  private _garbageTask: Promise<void> | null = null;
  private readonly _legacyGarbage: Garbage[] = [];
  // channelIds that have had at least one video chunk written this session.
  // Scopes OPFS chunk eviction to real video channels (metric/log channels
  // never write chunks) without having to decode opaque frame payloads.
  private _videoChannelIds = new Set<string>();
  // When true, the periodic/threshold eviction pass (`_maybeEvict`) is
  // suppressed — used while a ReplaySession is in replay (DVR) mode so
  // time-travel doesn't delete the history the user is reviewing. The write
  // path's emergency reclaim on QuotaExceededError stays active regardless, so
  // a genuinely-full disk is still handled.
  private _evictionPaused = false;

  constructor(opts?: ReplayStoreOptions) {
    this._maxPendingFrames = opts?.maxPendingFrames ?? Infinity;
    if (!(this._maxPendingFrames > 0))
      throw new RangeError("maxPendingFrames must be positive");
    this._onError = opts?.onError;
    this._dbName = opts?.dbName ?? DEFAULT_DB_NAME;
    this._dbVersion = opts?.dbVersion ?? DEFAULT_DB_VERSION;
    this._retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS;
    this._batchIntervalMs = opts?.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    if (!(this._retentionMs >= 0))
      throw new RangeError("retentionMs must be non-negative");
    if (!Number.isFinite(this._batchIntervalMs) || this._batchIntervalMs <= 0)
      throw new RangeError("batchIntervalMs must be finite and positive");
    this._evictThresholdPct = opts?.evictThresholdPct ?? 70;
    this._storageLogIntervalMs = opts?.storageLogIntervalMs ?? 0;
  }

  /** Idempotent: a second call (e.g. a remounted session) joins the first. */
  open(): Promise<void> {
    if (!this._opening)
      this._opening = this._open().catch((error) => {
        this._opening = null;
        throw error;
      });
    return this._opening;
  }

  private async _open(): Promise<void> {
    const db = await this._openIDB();
    // dispose() may have run while _openIDB() was in flight. Close the
    // just-opened connection (don't leak a zombie) and bail before touching
    // _db or starting any timers.
    if (this._disposed) {
      db.close();
      return;
    }
    this._db = db;
    try {
      const root = await navigator.storage.getDirectory();
      if (this._disposed) return;
      this._legacyRoot = root;
      const namespace = await root.getDirectoryHandle("fluxion-replay", { create: true });
      this._opfsRoot = await namespace.getDirectoryHandle(
        encodeURIComponent(this._dbName),
        { create: true },
      );
    } catch {
      // OPFS not available (e.g. non-secure context) — video recording disabled
      this._opfsRoot = null;
    }
    // The OPFS await is another suspension point dispose() could have run past.
    // dispose() already closed _db (it was set above) and stopped everything,
    // so just bail before starting timers on the dead store.
    if (this._disposed) {
      this._opfsRoot = null;
      this._legacyRoot = null;
      return;
    }
    await this._collectGarbage().catch(() => {});
    if (this._disposed) return;
    this._startFlushTimer();
    if (this._storageLogIntervalMs > 0) {
      this._startStorageLogTimer();
    }
  }

  appendFrame(frame: SerializedFrame): void {
    if (this._disposed) throw new Error("ReplayStore has been disposed");
    if (this._pending.length >= this._maxPendingFrames)
      throw new RangeError(
        "ReplayStore write queue is full; await flush() before appending more frames",
      );
    this._pending.push({
      t: frame.t,
      channelId: frame.channelId,
      payload: frame.payload,
      video: this._videoChannelIds.has(frame.channelId),
    });
    this._appended++;
  }

  async flush(): Promise<void> {
    this._assertOpen();
    // Every frame appended before this call must be committed (or dropped as
    // unstorable) when it resolves. Joining an in-flight timer drain is not
    // enough: frames appended during its cleanup tail are not in its batch,
    // and it may skip the eviction pass a public flush runs.
    const target = this._appended;
    for (;;) {
      if (this._clearTask) await this._clearTask;
      const joined = this._writeTask !== null;
      await this._flushPending(true);
      if (!this._db || (!joined && this._settled >= target)) return;
    }
  }

  async getFrames(
    fromMs: number,
    toMs: number,
    lowerOpen = false,
  ): Promise<SerializedFrame[]> {
    const db = this._assertOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("frames", "readonly");
      const index = tx.objectStore("frames").index("by_t");
      const range = IDBKeyRange.bound(fromMs, toMs, lowerOpen, false);
      const req = index.getAll(range);
      req.onsuccess = (e) => {
        const records = (e.target as IDBRequest<FrameRecord[]>).result;
        resolve(
          records.map((r) => ({
            t: r.t,
            channelId: r.channelId,
            payload: r.payload,
          })),
        );
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Range query scoped to a single channel. Uses the composite `by_channel_t`
   * index so IDB streams only the matching channel's frames — much cheaper
   * than `getFrames(...).filter(...)` once the store has many channels.
   *
   * Returned frames are sorted ascending by `t`.
   *
   * Two call forms:
   *
   * - `getFramesByChannel(channelId, from, to)` — returns raw
   *   `SerializedFrame[]`. Callers decode payloads themselves.
   * - `getFramesByChannel(channel, from, to)` — passes the `BaseChannel`
   *   instance; the store decodes every payload up-front and returns
   *   typed `DecodedFrame<T>[]`. Removes the `channel.decode(payload) as T`
   *   cast from consumer code.
   */
  getFramesByChannel(
    channelId: string,
    fromMs: number,
    toMs: number,
  ): Promise<SerializedFrame[]>;
  getFramesByChannel<T>(
    channel: BaseChannel<T>,
    fromMs: number,
    toMs: number,
  ): Promise<DecodedFrame<T>[]>;
  async getFramesByChannel<T>(
    channelOrId: string | BaseChannel<T>,
    fromMs: number,
    toMs: number,
  ): Promise<SerializedFrame[] | DecodedFrame<T>[]> {
    const channelId =
      typeof channelOrId === "string" ? channelOrId : channelOrId.channelId;
    const db = this._assertOpen();
    const raw = await new Promise<SerializedFrame[]>((resolve, reject) => {
      const tx = db.transaction("frames", "readonly");
      const index = tx.objectStore("frames").index("by_channel_t");
      const range = IDBKeyRange.bound([channelId, fromMs], [channelId, toMs]);
      const req = index.getAll(range);
      req.onsuccess = (e) => {
        const records = (e.target as IDBRequest<FrameRecord[]>).result;
        resolve(
          records.map((r) => ({
            t: r.t,
            channelId: r.channelId,
            payload: r.payload,
          })),
        );
      };
      req.onerror = () => reject(req.error);
    });
    if (typeof channelOrId === "string") return raw;
    return raw.map((f) => ({
      t: f.t,
      channelId: f.channelId,
      data: channelOrId.decode(f.payload),
    }));
  }

  async deleteFramesBefore(
    cutoffMs: number,
    limit = MAX_DELETE_PER_EVICTION,
  ): Promise<void> {
    const removed = await deleteFrameBatch(
      this._assertOpen(),
      cutoffMs,
      limit,
      (entries) => this._removeChunkFiles(entries),
    );
    // A loop, not push(...removed): a large legacy batch exceeds the argument limit.
    for (const entry of removed) this._legacyGarbage.push(entry);
    // The rows are gone; a failed file cleanup stays queued for a later pass.
    await this._collectGarbage().catch(() => {});
  }

  /** Delete chunk files directly (quota fallback): namespaced and pre-namespace roots. */
  private async _removeChunkFiles(entries: Garbage[]): Promise<void> {
    const removers = [this._opfsRoot, this._legacyRoot]
      .filter((root): root is FileSystemDirectoryHandle => root !== null)
      .map((root) => chunkRemover(root));
    for (let i = 0; i < entries.length; i += OPFS_DELETE_BATCH) {
      await Promise.all(
        entries.slice(i, i + OPFS_DELETE_BATCH).map(async ({ channelId, t }) => {
          for (const remove of removers) await remove(channelId, t).catch(() => {});
        }),
      );
    }
  }

  private async _collectGarbage(): Promise<void> {
    if (this._garbageTask) return this._garbageTask;
    if (!this._db || !this._opfsRoot) return;
    this._garbageTask = collectVideoGarbage(
      this._db,
      this._opfsRoot,
      MAX_DELETE_PER_EVICTION,
      (channelId, t) =>
        this._videoPaths.has(JSON.stringify([channelId, `${t}.chunk`])) ||
        this._pending.some((frame) => frame.channelId === channelId && frame.t === t),
      this._legacyGarbage,
      this._legacyRoot,
    );
    try {
      await this._garbageTask;
    } finally {
      this._garbageTask = null;
    }
  }

  /**
   * Delete OPFS video chunks whose frame timestamp is `< cutoffMs`, for every
   * channel that has written a chunk this session. Complements
   * `deleteFramesBefore` (which removes only IDB metadata): the encoded video
   * files in OPFS are the bulk of storage, so eviction must reclaim them too —
   * otherwise `navigator.storage.estimate()` keeps climbing to the quota no
   * matter how many IDB rows are dropped, and `writeVideoChunk` eventually
   * throws `QuotaExceededError`.
   *
   * The chunk filename is reconstructed as `` `${frame.t}.chunk` `` — the exact
   * name `VideoRecorder` wrote (its `tMs` is recorded as the frame's `t`). Must
   * run BEFORE `deleteFramesBefore` in an eviction pass so the metadata rows
   * used to locate the chunks are still present.
   */
  async deleteVideoChunksBefore(
    cutoffMs: number,
    limit = MAX_OPFS_DELETE_PER_EVICTION,
  ): Promise<void> {
    if (!this._opfsRoot || this._videoChannelIds.size === 0) return;
    try {
      let remaining = limit;
      for (const channelId of this._videoChannelIds) {
        if (remaining <= 0) break;
        // Capped cursor read: only the oldest `remaining` timestamps below the
        // cutoff — NOT a getAll over the whole [0, cutoff) span (which grows
        // unbounded as the recording lengthens and would be re-scanned every
        // eviction pass).
        const ts = await this._oldestChannelTimestampsBefore(
          channelId,
          cutoffMs,
          remaining,
        );
        remaining -= ts.length;
        const filenames = ts.map((t) => `${t}.chunk`);
        for (let i = 0; i < filenames.length; i += OPFS_DELETE_BATCH) {
          await Promise.all(
            filenames
              .slice(i, i + OPFS_DELETE_BATCH)
              .map((name) => this.deleteVideoChunk(channelId, name)),
          );
        }
      }
    } catch {
      // OPFS reclaim must never crash the flush pipeline (mirrors _maybeEvict).
    }
  }

  /**
   * The oldest (up to `limit`) frame timestamps for `channelId` with `t <
   * beforeMs`, via a capped ascending cursor on the `by_channel_t` index.
   * Bounded regardless of how many frames sit below the cutoff — unlike a
   * `getFramesByChannel(0, before)` getAll — and reads no payloads it discards.
   */
  private _oldestChannelTimestampsBefore(
    channelId: string,
    beforeMs: number,
    limit: number,
  ): Promise<number[]> {
    const db = this._assertOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("frames", "readonly");
      const index = tx.objectStore("frames").index("by_channel_t");
      // Exclusive upper on t (upperOpen) so t === beforeMs is excluded, matching
      // deleteFramesBefore's upperBound(beforeMs, true).
      const range = IDBKeyRange.bound([channelId, 0], [channelId, beforeMs], false, true);
      const req = index.openCursor(range);
      const out: number[] = [];
      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push((cursor.value as FrameRecord).t);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Origin storage usage. `withCount` (default true) includes `idbFrameCount`,
   * which costs a full IDB `count()` — the eviction gate passes `false` since
   * it only needs `percentUsed`, avoiding that count on every ~5 s pass.
   */
  async getStorageInfo(opts?: { withCount?: boolean }): Promise<StorageInfo> {
    const est = await navigator.storage.estimate();
    const used = est.usage ?? 0;
    const quota = est.quota ?? 0;
    const count = opts?.withCount !== false && this._db ? await this._countFrames() : 0;
    return {
      usedBytes: used,
      quotaBytes: quota,
      percentUsed: quota > 0 ? (used / quota) * 100 : 0,
      idbFrameCount: count,
    };
  }

  startSegment(t = Date.now()): void {
    // Close any open segment first
    if (
      this._segments.length > 0 &&
      this._segments[this._segments.length - 1].end === null
    ) {
      this._segments[this._segments.length - 1].end = t;
    }
    this._segments.push({ start: t, end: null });
  }

  endSegment(t = Date.now()): void {
    if (
      this._segments.length > 0 &&
      this._segments[this._segments.length - 1].end === null
    ) {
      this._segments[this._segments.length - 1].end = t;
    }
  }

  getSegments(): RecordingSegment[] {
    return this._segments;
  }

  async getTimeRange(): Promise<{ earliest: number; latest: number } | null> {
    if (!this._db) return null;
    const db = this._db;
    // Read both ends of the `by_t` index in a SINGLE readonly transaction —
    // an ascending cursor for earliest and a descending one for latest on the
    // same tx, instead of two separate transactions. Halves the IDB
    // round-trips for a call made every poll (~500ms) by every mounted chart.
    return new Promise((resolve, reject) => {
      const tx = db.transaction("frames", "readonly");
      const index = tx.objectStore("frames").index("by_t");
      let earliest: number | null = null;
      let latest: number | null = null;
      const fwd = index.openCursor(null, "next");
      fwd.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) earliest = (cursor.value as FrameRecord).t;
      };
      const rev = index.openCursor(null, "prev");
      rev.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) latest = (cursor.value as FrameRecord).t;
      };
      tx.oncomplete = () =>
        resolve(earliest === null ? null : { earliest, latest: latest ?? earliest });
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  private _countFrames(): Promise<number> {
    const db = this._assertOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("frames", "readonly");
      const req = tx.objectStore("frames").count();
      req.onsuccess = (e) => resolve((e.target as IDBRequest<number>).result);
      req.onerror = () => reject(req.error);
    });
  }

  async writeVideoChunk(
    channelId: string,
    filename: string,
    data: Uint8Array,
  ): Promise<void> {
    if (this._clearTask) await this._clearTask;
    const key = JSON.stringify([channelId, filename]);
    this._videoPaths.set(key, (this._videoPaths.get(key) ?? 0) + 1);
    const write = this._writeVideoChunk(channelId, filename, data);
    this._videoWrites.add(write);
    try {
      await write;
    } finally {
      this._videoWrites.delete(write);
      const remaining = this._videoPaths.get(key)! - 1;
      if (remaining) this._videoPaths.set(key, remaining);
      else this._videoPaths.delete(key);
    }
  }

  private async _writeVideoChunk(
    channelId: string,
    filename: string,
    data: Uint8Array,
  ): Promise<void> {
    this._videoChannelIds.add(channelId);
    try {
      await this._writeChunkOnce(channelId, filename, data);
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error;
      await this._evictOldest(0.25).catch(() => {});
      await this._writeChunkOnce(channelId, filename, data);
    }
  }

  private async _writeChunkOnce(
    channelId: string,
    filename: string,
    data: Uint8Array,
  ): Promise<void> {
    const root = this._assertOpfs();
    const dir = await root.getDirectoryHandle(channelId, { create: true });
    const file = await dir.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(data as unknown as FileSystemWriteChunkType);
    await writable.close();
  }

  async readVideoChunk(channelId: string, filename: string): Promise<Uint8Array | null> {
    const read = async (root: FileSystemDirectoryHandle): Promise<Uint8Array | null> => {
      try {
        const dir = await root.getDirectoryHandle(channelId);
        const file = await dir.getFileHandle(filename);
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      } catch {
        return null;
      }
    };
    if (!this._opfsRoot) return null;
    const data = await read(this._opfsRoot);
    if (data) return data;
    // Old releases wrote directly under the origin root. Read those files only
    // when this database still references the timestamp; never delete shared
    // legacy directories whose owner cannot be determined safely.
    const t = Number(filename.replace(/\.chunk$/, ""));
    if (!this._legacyRoot || !Number.isFinite(t)) return null;
    const frames = await this.getFramesByChannel(channelId, t, t);
    return frames.length ? read(this._legacyRoot) : null;
  }

  async clearAll(): Promise<void> {
    if (this._clearTask) return this._clearTask;
    const db = this._assertOpen();
    this._writeGeneration++;
    this._pending = [];
    this._settled = this._appended;
    this._segments = [];
    const clear = async () => {
      // A committing batch/file must finish BEFORE deletion, so it cannot
      // resurrect an earlier recording after this promise resolves.
      if (this._writeTask) await this._writeTask.catch(() => {});
      await Promise.allSettled([...this._videoWrites]);
      if (this._garbageTask) await this._garbageTask.catch(() => {});
      const legacyChannels = await this._legacyChannels(db).catch(() => []);
      await new Promise<void>((resolve, reject) => {
        const persistent = db.objectStoreNames.contains(GARBAGE_STORE);
        const tx = db.transaction(
          persistent ? ["frames", GARBAGE_STORE] : "frames",
          "readwrite",
        );
        tx.objectStore("frames").clear();
        if (persistent) tx.objectStore(GARBAGE_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      this._legacyGarbage.length = 0;
      this._videoChannelIds.clear();
      // File removal is best-effort, as before 0.13.3: an entry another tab
      // still writes, or a racing clear already removed, must not reject the
      // clear after the recording is gone (clearRecording would skip the restart).
      const legacyRoot = this._legacyRoot;
      // Releases up to 0.13.2 wrote this database's chunks at the origin root
      // and clearing removed them; reclaim the channels it recorded there.
      if (legacyRoot)
        await Promise.all(
          legacyChannels.map((name) =>
            legacyRoot.removeEntry(name, { recursive: true }).catch(() => {}),
          ),
        );
      const root = this._opfsRoot;
      if (!root) return;
      if (typeof (root as unknown as { entries?: unknown }).entries !== "function")
        return;
      try {
        const names: string[] = [];
        for await (const [name] of (
          root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
        ).entries())
          names.push(name);
        await Promise.all(
          names.map((name) =>
            root.removeEntry(name, { recursive: true }).catch(() => {}),
          ),
        );
      } catch {
        // The namespace vanished mid-iteration (a concurrent clear).
      }
    };
    this._clearTask = clear();
    try {
      await this._clearTask;
    } finally {
      this._clearTask = null;
    }
  }

  /**
   * Channels whose oldest row predates the `video` marker (written by <= 0.13.2,
   * which stored their chunks at the origin root). One cursor step per channel.
   */
  private async _legacyChannels(db: IDBDatabase): Promise<string[]> {
    const root = this._legacyRoot;
    if (!root || typeof (root as unknown as { entries?: unknown }).entries !== "function")
      return [];
    // Skip the scan unless the origin root holds anything besides our namespace.
    let legacyEntries = false;
    for await (const [name] of (
      root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries())
      if (name !== "fluxion-replay") {
        legacyEntries = true;
        break;
      }
    if (!legacyEntries) return [];
    return new Promise((resolve, reject) => {
      const out: string[] = [];
      const req = db
        .transaction("frames")
        .objectStore("frames")
        .index("by_channel_t")
        .openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        const row = cursor.value as FrameRecord;
        if (row.video === undefined && row.channelId !== "fluxion-replay")
          out.push(row.channelId);
        cursor.continue([row.channelId, Number.POSITIVE_INFINITY]);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteVideoChunk(channelId: string, filename: string): Promise<void> {
    const root = this._opfsRoot;
    if (!root) return;
    try {
      const dir = await root.getDirectoryHandle(channelId);
      await dir.removeEntry(filename);
    } catch {
      // Already deleted or never existed
    }
  }

  dispose(): void {
    this._disposed = true;
    this._writeGeneration++;
    this._legacyRoot = null;
    this._stopFlushTimer();
    this._stopStorageLogTimer();
    this._db?.close();
    this._db = null;
    this._opfsRoot = null;
    this._pending = [];
    this._videoChannelIds.clear();
  }

  private _assertOpen(): IDBDatabase {
    if (!this._db)
      throw new Error(`ReplayStore("${this._dbName}") is not open. Call open() first.`);
    return this._db;
  }

  private _assertOpfs(): FileSystemDirectoryHandle {
    if (!this._opfsRoot) throw new Error("OPFS is not available in this context.");
    return this._opfsRoot;
  }

  private _startFlushTimer(): void {
    this._flushTimer = setInterval(() => {
      if (this._clearTask) return;
      void this._flushPending(false).catch((error) => this._reportWriteError(error));
    }, this._batchIntervalMs);
  }

  private _reportWriteError(error: unknown): void {
    this._lastWriteError = error;
    if (this._onError) {
      try {
        this._onError(error);
      } catch (reportError) {
        console.error("[ReplayStore] error listener failed", reportError);
      }
    } else console.error("[ReplayStore] write failed", error);
  }

  private _stopFlushTimer(): void {
    if (this._flushTimer != null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  private async _flushPending(forceEvict: boolean): Promise<void> {
    if (this._writeTask) return this._writeTask;
    if (!this._db || this._clearTask) return;
    const generation = this._writeGeneration;
    const drain = async () => {
      let reclaimed = false;
      while (this._pending.length && generation === this._writeGeneration) {
        // Retain until transaction COMMIT. Retry sees the same batch on failure.
        const batch = this._pending.slice(0, MAX_BATCH_SIZE);
        try {
          await this._writeBatch(batch);
        } catch (error) {
          if (generation === this._writeGeneration) {
            if (error instanceof UnstorableFrameError) {
              // Retrying can never store it; keep the rest of the batch queued.
              this._pending.splice(error.index, 1);
              this._settled++;
              this._reportWriteError(error);
              continue;
            }
            if (isQuotaExceededError(error) && !reclaimed) {
              // Eviction only follows a successful write; free room first.
              reclaimed = true;
              await this._evictOldest(0.25).catch(() => {});
              continue;
            }
            if (++this._failedWrites >= MAX_WRITE_ATTEMPTS) {
              this._failedWrites = 0;
              this._pending.splice(0, batch.length);
              this._settled += batch.length;
            }
          }
          throw error;
        }
        this._failedWrites = 0;
        if (generation !== this._writeGeneration) return;
        this._pending.splice(0, batch.length);
        this._settled += batch.length;
        this._lastWriteError = null;
      }
      // Committed rows stay committed; a failed file cleanup is retried later.
      await this._collectGarbage().catch(() => {});
      // storage.estimate runs every Nth drain, on a public flush, and on every
      // drain while over the threshold; opt-in time retention runs every drain.
      const quotaCheck =
        ++this._flushCount % EVICT_EVERY_N_FLUSHES === 0 ||
        forceEvict ||
        this._storagePressure;
      if (
        generation === this._writeGeneration &&
        (quotaCheck || Number.isFinite(this._retentionMs))
      )
        await this._maybeEvict(quotaCheck);
    };
    this._writeTask = drain();
    try {
      await this._writeTask;
    } finally {
      this._writeTask = null;
    }
  }

  /**
   * Pause or resume the periodic/threshold eviction pass. ReplaySession pauses
   * it on `enterReplay` and resumes on `exitReplay` so time-travel over recorded
   * history doesn't delete the frames being reviewed. Does NOT affect the
   * emergency reclaim `writeVideoChunk` runs on `QuotaExceededError`.
   */
  setEvictionPaused(paused: boolean): void {
    this._evictionPaused = paused;
  }

  private async _maybeEvict(checkQuota: boolean): Promise<void> {
    if (this._evictionPaused) return;
    try {
      if (Number.isFinite(this._retentionMs)) {
        const range = await this.getTimeRange();
        if (range) {
          const cutoff = range.latest - this._retentionMs;
          await this._evictBefore(cutoff);
        }
      }
      if (!checkQuota || this._evictThresholdPct >= 100) return;
      // withCount:false — the eviction gate only needs percentUsed, so skip the
      // full IDB _countFrames() the UI-facing getStorageInfo() does.
      const info = await this.getStorageInfo({ withCount: false });
      // On at the threshold, off below the low watermark (which must stay above
      // 0%, or a small threshold could never release).
      const threshold = this._evictThresholdPct;
      this._storagePressure =
        info.percentUsed >= threshold ||
        (this._storagePressure &&
          info.percentUsed >= threshold - Math.min(5, threshold / 2));
      if (!this._storagePressure) return;
      await this._evictOldest(PRESSURE_TRIM_FRACTION);
    } catch {
      // eviction failure must not crash the flush pipeline
    }
  }

  /**
   * Delete the oldest `fraction` (0–1) of the recorded time span from BOTH
   * backends: commit IDB deletions and file cleanup intents, collect files,
   * then clip in-memory segments to the actual retained range. Returns the
   * cutoff timestamp used, or null when there is nothing to evict.
   *
   * Used by the threshold eviction (`_maybeEvict`, 1% per flush under pressure) and by
   * `writeVideoChunk`'s emergency reclaim on `QuotaExceededError` (25 %).
   */
  private async _evictOldest(fraction: number): Promise<number | null> {
    const timeRange = await this.getTimeRange();
    if (!timeRange) return null;

    const spanMs = timeRange.latest - timeRange.earliest;
    if (spanMs <= 0) return null;

    const cutoffMs = timeRange.earliest + Math.floor(spanMs * fraction);
    await this._evictBefore(cutoffMs);
    return cutoffMs;
  }

  private async _evictBefore(cutoff: number): Promise<void> {
    const generation = this._writeGeneration;
    const started = performance.now();
    let previous = -Infinity;
    do {
      await this.deleteFramesBefore(cutoff);
      const remaining = await this.getTimeRange();
      if (generation !== this._writeGeneration || !remaining) return;
      this._trimSegmentsBefore(remaining.earliest);
      if (remaining.earliest >= cutoff || remaining.earliest <= previous) return;
      previous = remaining.earliest;
      // Each IDB transaction yields to the browser. Continue on the next flush
      // once the time budget is spent, without scanning the full recording.
    } while (performance.now() - started < 50 && !this._evictionPaused);
  }

  private _trimSegmentsBefore(cutoffMs: number): void {
    this._segments = this._segments
      .map((seg) => ({ start: Math.max(seg.start, cutoffMs), end: seg.end }))
      .filter((seg) => seg.end === null || seg.end > seg.start);
  }

  private _startStorageLogTimer(): void {
    this._storageLogTimer = setInterval(async () => {
      try {
        const info = await this.getStorageInfo();
        console.log(
          `[ReplayStore "${this._dbName}"] storage: ${info.percentUsed.toFixed(1)}% used` +
            ` (${(info.usedBytes / 1024 / 1024).toFixed(1)} MB / ${(info.quotaBytes / 1024 / 1024).toFixed(1)} MB),` +
            ` ${info.idbFrameCount} frames`,
        );
      } catch {
        // ignore
      }
    }, this._storageLogIntervalMs);
  }

  private _stopStorageLogTimer(): void {
    if (this._storageLogTimer != null) {
      clearInterval(this._storageLogTimer);
      this._storageLogTimer = null;
    }
  }

  private async _writeBatch(records: FrameRecord[]): Promise<void> {
    const db = this._assertOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("frames", "readwrite");
      const store = tx.objectStore("frames");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
      for (let i = 0; i < records.length; i++) {
        try {
          store.add(records[i]);
        } catch (error) {
          // A synchronous throw does not end the transaction: without the abort
          // the records before this one commit and the retry stores them again.
          tx.onerror = tx.onabort = null;
          tx.abort();
          reject(new UnstorableFrameError(i, error));
          return;
        }
      }
    });
  }

  private _openIDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, this._dbVersion);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(GARBAGE_STORE))
          db.createObjectStore(GARBAGE_STORE);
        if (!db.objectStoreNames.contains("frames")) {
          const store = db.createObjectStore("frames", { autoIncrement: true });
          store.createIndex("by_t", "t");
          store.createIndex("by_channel_t", ["channelId", "t"]);
        }
      };
      req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
      req.onerror = () => reject(req.error);
      // A blocked open fires neither onsuccess nor onerror on its own — without
      // this handler open() would hang forever (the "Opening IDB…" spinner that
      // never clears). Reject so the failure surfaces as `error` in
      // useReplaySession instead of an indefinite hang.
      req.onblocked = () =>
        reject(
          new Error(
            `ReplayStore("${this._dbName}") open blocked: another connection is holding the database open.`,
          ),
        );
    });
  }
}
