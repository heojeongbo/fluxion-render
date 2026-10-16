import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// ─── Auto-unmount React trees after every test ────────────────────────────────
// `globals: false` in vitest.config means @testing-library's auto-cleanup is NOT
// registered, so any test that render()s without an explicit unmount() leaves a
// live React tree (and its player/store subscriptions) alive. Those can flush a
// state update during happy-dom teardown — React then commits against a
// torn-down `window`, surfacing as an "Unhandled Error: window is not defined"
// that makes vitest exit non-zero even though every test passed. A global
// afterEach(cleanup) unmounts every rendered tree before teardown.
afterEach(() => {
  cleanup();
});

// ─── IndexedDB in-memory stub ─────────────────────────────────────────────────

type IDBRecord = { _key: number; [key: string]: unknown };

/**
 * Lexicographic compare matching IDB's array-key ordering. Returns -1, 0, or 1.
 * Falls back to numeric/string compare for scalars.
 */
function cmpKey(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmpKey(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (a === b) return 0;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

class FakeIDBKeyRange {
  lower: unknown;
  upper: unknown;
  lowerOpen: boolean;
  upperOpen: boolean;

  constructor(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  static bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false) {
    return new FakeIDBKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  static lowerBound(lower: unknown, open = false) {
    return new FakeIDBKeyRange(lower, undefined, open, false);
  }

  static upperBound(upper: unknown, open = false) {
    return new FakeIDBKeyRange(undefined, upper, false, open);
  }

  static only(value: unknown) {
    return new FakeIDBKeyRange(value, value, false, false);
  }

  includes(value: unknown): boolean {
    if (this.lower !== undefined) {
      const c = cmpKey(value, this.lower);
      if (this.lowerOpen && c <= 0) return false;
      if (!this.lowerOpen && c < 0) return false;
    }
    if (this.upper !== undefined) {
      const c = cmpKey(value, this.upper);
      if (this.upperOpen && c >= 0) return false;
      if (!this.upperOpen && c > 0) return false;
    }
    return true;
  }
}

class FakeIDBIndex {
  constructor(
    private readonly _store: FakeIDBObjectStore,
    private readonly _field: string | string[],
  ) {}

  /** Extract this index's key from a record. Composite indexes return a tuple. */
  private _keyOf(r: IDBRecord): unknown {
    const f = this._field;
    return Array.isArray(f) ? f.map((name) => r[name]) : r[f];
  }

  openCursor(
    range?: FakeIDBKeyRange | null,
    direction?: IDBCursorDirection,
  ): FakeIDBRequest<FakeIDBCursorWithValue | null> {
    let records = this._store._records.filter((r) => {
      if (!range) return true;
      return range.includes(this._keyOf(r));
    });
    records = [...records].sort((a, b) => cmpKey(this._keyOf(a), this._keyOf(b)));
    if (direction === "prev" || direction === "prevunique") {
      records = records.reverse();
    }
    let idx = 0;
    const req = new FakeIDBRequest<FakeIDBCursorWithValue | null>(null, false);
    const advance = () => {
      if (idx >= records.length) {
        req._result = null;
        req.onsuccess?.({ target: req } as unknown as Event);
        return;
      }
      const record = records[idx++];
      const cursor: FakeIDBCursorWithValue = {
        value: record,
        key: record._key,
        delete: () => {
          const i = this._store._records.indexOf(record);
          if (i !== -1) this._store._records.splice(i, 1);
          return new FakeIDBRequest(undefined);
        },
        continue: () => advance(),
      };
      req._result = cursor;
      req.onsuccess?.({ target: req } as unknown as Event);
    };
    queueMicrotask(advance);
    return req;
  }

  getAll(range?: FakeIDBKeyRange): FakeIDBRequest<IDBRecord[]> {
    const results = this._store._records
      .filter((r) => !range || range.includes(this._keyOf(r)))
      .sort((a, b) => cmpKey(this._keyOf(a), this._keyOf(b)));
    return new FakeIDBRequest([...results]);
  }
}

interface FakeIDBCursorWithValue {
  value: IDBRecord;
  key: number;
  delete(): FakeIDBRequest<undefined>;
  continue(): void;
}

class FakeIDBRequest<T> {
  _result: T;
  onsuccess: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(result: T, autoFire = true) {
    this._result = result;
    if (autoFire && !(result instanceof Promise)) {
      queueMicrotask(() => {
        this.onsuccess?.({ target: this } as unknown as Event);
      });
    }
  }

  get result(): T {
    return this._result;
  }
}

class FakeIDBObjectStore {
  _records: IDBRecord[] = [];
  private _autoKey = 1;
  private _indexes = new Map<string, FakeIDBIndex>();

  createIndex(name: string, keyPath: string | string[]): FakeIDBIndex {
    const idx = new FakeIDBIndex(this, keyPath);
    this._indexes.set(name, idx);
    return idx;
  }

  index(name: string): FakeIDBIndex {
    const idx = this._indexes.get(name);
    if (!idx) throw new Error(`Index '${name}' not found`);
    return idx;
  }

  add(value: unknown): FakeIDBRequest<number> {
    const key = this._autoKey++;
    this._records.push({ ...(value as object), _key: key } as IDBRecord);
    return new FakeIDBRequest(key);
  }

  put(value: unknown): FakeIDBRequest<number> {
    return this.add(value);
  }

  getAll(range?: FakeIDBKeyRange): FakeIDBRequest<IDBRecord[]> {
    const results = range
      ? this._records.filter((r) => range.includes(r._key))
      : [...this._records];
    return new FakeIDBRequest(results);
  }

  delete(key: number): FakeIDBRequest<undefined> {
    const i = this._records.findIndex((r) => r._key === key);
    if (i !== -1) this._records.splice(i, 1);
    return new FakeIDBRequest(undefined);
  }

  clear(): FakeIDBRequest<undefined> {
    this._records = [];
    return new FakeIDBRequest(undefined);
  }

  openCursor(range?: FakeIDBKeyRange): FakeIDBRequest<FakeIDBCursorWithValue | null> {
    return this.index("by_t").openCursor(range);
  }

  count(): FakeIDBRequest<number> {
    return new FakeIDBRequest(this._records.length);
  }
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(private readonly _stores: Map<string, FakeIDBObjectStore>) {
    // Auto-complete after all synchronous requests have been queued.
    // Uses two microtask hops: first lets add() requests enqueue their
    // queueMicrotask callbacks, second fires after those resolve.
    queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()));
  }

  objectStore(name: string): FakeIDBObjectStore {
    const store = this._stores.get(name);
    if (!store) throw new Error(`Object store '${name}' not found`);
    return store;
  }
}

class FakeIDBDatabase {
  private readonly _stores = new Map<string, FakeIDBObjectStore>();

  get objectStoreNames(): DOMStringList {
    const names = [...this._stores.keys()];
    return {
      length: names.length,
      contains: (name: string) => names.includes(name),
      item: (index: number) => names[index] ?? null,
      [Symbol.iterator]: function* () {
        yield* names;
      },
    } as unknown as DOMStringList;
  }

  createObjectStore(name: string): FakeIDBObjectStore {
    const store = new FakeIDBObjectStore();
    this._stores.set(name, store);
    return store;
  }

  transaction(_storeNames: string | string[], _mode?: string): FakeIDBTransaction {
    return new FakeIDBTransaction(this._stores);
  }

  // Count close() calls so tests can assert a connection was (not) leaked.
  closeCount = 0;
  close(): void {
    this.closeCount++;
  }
}

// Test-only toggles for the IDB open path — set via globalThis.__fakeIDBControls.
let __forceBlocked = false;
let __deferOpen = false;
let __pendingOpens: FakeIDBOpenRequest[] = [];

class FakeIDBOpenRequest {
  result: FakeIDBDatabase | null = null;
  onsuccess: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onblocked: ((e: Event) => void) | null = null;
  onupgradeneeded: ((e: IDBVersionChangeEvent) => void) | null = null;

  constructor() {
    if (__forceBlocked) {
      queueMicrotask(() => this.onblocked?.({ target: this } as unknown as Event));
      return;
    }
    if (__deferOpen) {
      // Park until the test calls resolvePendingOpens() — models "dispose ran
      // before open resolved".
      __pendingOpens.push(this);
      return;
    }
    queueMicrotask(() => this._fire());
  }

  _fire(): void {
    const db = new FakeIDBDatabase();
    this.result = db;
    const upgradeEvent = {
      target: { result: db },
      oldVersion: 0,
      newVersion: 1,
    } as unknown as IDBVersionChangeEvent;
    this.onupgradeneeded?.(upgradeEvent);
    this.onsuccess?.({ target: this } as unknown as Event);
  }
}

// Exposed on globalThis (setup.ts is a side-effect-only setupFiles entry with no
// exports). Tests do `(globalThis as any).__fakeIDBControls`.
(globalThis as unknown as { __fakeIDBControls: unknown }).__fakeIDBControls = {
  setForceBlocked: (v: boolean) => {
    __forceBlocked = v;
  },
  setDeferOpen: (v: boolean) => {
    __deferOpen = v;
  },
  /** Resolve all parked deferred opens, returning their produced databases. */
  resolvePendingOpens: (): FakeIDBDatabase[] => {
    const pending = __pendingOpens;
    __pendingOpens = [];
    for (const req of pending) req._fire();
    return pending.map((r) => r.result!).filter(Boolean);
  },
  reset: () => {
    __forceBlocked = false;
    __deferOpen = false;
    __pendingOpens = [];
  },
};

const fakeIndexedDB = {
  open: (_name: string, _version?: number) => new FakeIDBOpenRequest(),
  deleteDatabase: (_name: string) => new FakeIDBRequest(undefined),
  databases: async () => [],
  cmp: (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1),
};

Object.defineProperty(globalThis, "indexedDB", {
  value: fakeIndexedDB,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "IDBKeyRange", {
  value: FakeIDBKeyRange,
  writable: true,
  configurable: true,
});

// ─── OPFS stub ────────────────────────────────────────────────────────────────

const opfsFiles = new Map<string, Uint8Array>();

class FakeFileSystemWritableFileStream {
  private readonly _path: string;
  private _chunks: Uint8Array[] = [];

  constructor(path: string) {
    this._path = path;
  }

  async write(data: Uint8Array | ArrayBuffer): Promise<void> {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._chunks.push(chunk);
  }

  async close(): Promise<void> {
    const total = this._chunks.reduce((a, b) => a + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this._chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    opfsFiles.set(this._path, merged);
  }
}

class FakeFileSystemFileHandle {
  constructor(private readonly _path: string) {}

  async createWritable(): Promise<FakeFileSystemWritableFileStream> {
    return new FakeFileSystemWritableFileStream(this._path);
  }

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const data = opfsFiles.get(this._path);
    return {
      arrayBuffer: async () =>
        data
          ? (data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ) as ArrayBuffer)
          : new ArrayBuffer(0),
    };
  }
}

class FakeFileSystemDirectoryHandle {
  constructor(private readonly _prefix: string) {}

  async getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FakeFileSystemDirectoryHandle> {
    return new FakeFileSystemDirectoryHandle(`${this._prefix}/${name}`);
  }

  async getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FakeFileSystemFileHandle> {
    const path = `${this._prefix}/${name}`;
    if (!opts?.create && !opfsFiles.has(path)) {
      throw new DOMException("File not found", "NotFoundError");
    }
    return new FakeFileSystemFileHandle(path);
  }

  async *entries(): AsyncIterable<[string, unknown]> {
    const names = new Set<string>();
    for (const path of opfsFiles.keys()) {
      if (path.startsWith(`${this._prefix}/`))
        names.add(path.slice(this._prefix.length + 1).split("/")[0]);
    }
    for (const name of names) yield [name, {}];
  }
  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const path = `${this._prefix}/${name}`;
    opfsFiles.delete(path);
    if (options?.recursive)
      for (const key of opfsFiles.keys())
        if (key.startsWith(`${path}/`)) opfsFiles.delete(key);
  }
}

const fakeStorageManager = {
  getDirectory: async () => new FakeFileSystemDirectoryHandle("opfs"),
  estimate: async () => ({ usage: 0, quota: 1_000_000_000 }),
  persist: async () => true,
  persisted: async () => true,
};

Object.defineProperty(globalThis.navigator, "storage", {
  value: fakeStorageManager,
  writable: true,
  configurable: true,
});

// ─── mediaDevices stub ────────────────────────────────────────────────────────

const fakeMediaDevices = {
  getDisplayMedia: async () => {
    throw new Error("getDisplayMedia not mocked");
  },
  getUserMedia: async () => {
    throw new Error("getUserMedia not mocked");
  },
};

Object.defineProperty(globalThis.navigator, "mediaDevices", {
  value: fakeMediaDevices,
  writable: true,
  configurable: true,
});

// ─── WebCodecs stubs ──────────────────────────────────────────────────────────

class FakeVideoEncoder {
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  private _output: (chunk: FakeEncodedVideoChunk, meta: unknown) => void;
  private _error: (e: Error) => void;

  constructor(init: {
    output: (chunk: FakeEncodedVideoChunk, meta: unknown) => void;
    error: (e: Error) => void;
  }) {
    this._output = init.output;
    this._error = init.error;
  }

  configure(_config: unknown): void {
    this.state = "configured";
  }

  encode(_frame: unknown, opts?: { keyFrame?: boolean }): void {}

  async flush(): Promise<void> {}

  close(): void {
    this.state = "closed";
  }
}

class FakeVideoDecoder {
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  private _output: (frame: FakeVideoFrame) => void;
  private _error: (e: Error) => void;

  constructor(init: {
    output: (frame: FakeVideoFrame) => void;
    error: (e: Error) => void;
  }) {
    this._output = init.output;
    this._error = init.error;
  }

  configure(_config: unknown): void {
    this.state = "configured";
  }

  decode(_chunk: unknown): void {}

  async flush(): Promise<void> {}

  close(): void {
    this.state = "closed";
  }
}

class FakeEncodedVideoChunk {
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  byteLength: number;
  private _data: Uint8Array;

  constructor(init: {
    type: "key" | "delta";
    timestamp: number;
    duration?: number;
    data: ArrayBuffer | Uint8Array;
  }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this._data = init.data instanceof Uint8Array ? init.data : new Uint8Array(init.data);
    this.byteLength = this._data.byteLength;
  }

  copyTo(dest: Uint8Array): void {
    dest.set(this._data);
  }
}

class FakeVideoFrame {
  timestamp: number;
  duration: number | null;
  displayWidth: number;
  displayHeight: number;
  constructor(init: {
    timestamp: number;
    duration?: number;
    displayWidth?: number;
    displayHeight?: number;
  }) {
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.displayWidth = init.displayWidth ?? 640;
    this.displayHeight = init.displayHeight ?? 480;
  }
  close(): void {}
}

Object.defineProperty(globalThis, "VideoEncoder", {
  value: FakeVideoEncoder,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "VideoDecoder", {
  value: FakeVideoDecoder,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "EncodedVideoChunk", {
  value: FakeEncodedVideoChunk,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, "VideoFrame", {
  value: FakeVideoFrame,
  writable: true,
  configurable: true,
});

// ─── MediaSource stub ─────────────────────────────────────────────────────────

class FakeMediaSource {
  readyState: "closed" | "open" | "ended" = "closed";
  sourceBuffers: unknown[] = [];

  addSourceBuffer(_mimeType: string): unknown {
    const buf = { appendBuffer: vi.fn(), remove: vi.fn() };
    this.sourceBuffers.push(buf);
    return buf;
  }

  endOfStream(): void {
    this.readyState = "ended";
  }

  static isTypeSupported(_type: string): boolean {
    return true;
  }
}

Object.defineProperty(globalThis, "MediaSource", {
  value: FakeMediaSource,
  writable: true,
  configurable: true,
});

// ─── MediaStreamTrackProcessor stub ──────────────────────────────────────────

class FakeMediaStreamTrackProcessor {
  readable: ReadableStream<unknown>;

  constructor(_init: unknown) {
    this.readable = new ReadableStream({
      start(controller) {
        controller.close(); // immediately done
      },
    });
  }
}

Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
  value: FakeMediaStreamTrackProcessor,
  writable: true,
  configurable: true,
});

// ─── requestAnimationFrame stub ───────────────────────────────────────────────

if (typeof globalThis.requestAnimationFrame === "undefined") {
  let rafId = 0;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (cb: FrameRequestCallback) => {
      const id = ++rafId;
      setTimeout(() => cb(performance.now()), 16);
      return id;
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: (id: number) => clearTimeout(id),
    writable: true,
    configurable: true,
  });
}

// React Testing Library requires this flag in test environments
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  writable: true,
  configurable: true,
});

// Suppress React's act() warnings on console.error. These fire during
// environment teardown and cause EnvironmentTeardownError in vitest 4.x
// because the pending onUserConsoleLog RPC races with worker shutdown.
// React's printWarning captures `console.error` at module load time, so
// patching here (in setup.ts, before any test imports React) intercepts it.
const _originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === "string" ? args[0] : "";
  if (msg.includes("not wrapped in act") || msg.includes("Warning:")) return;
  _originalConsoleError(...args);
};
