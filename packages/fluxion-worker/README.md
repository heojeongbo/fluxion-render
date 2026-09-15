# @heojeongbo/fluxion-worker

[![npm](https://img.shields.io/npm/v/@heojeongbo/fluxion-worker)](https://www.npmjs.com/package/@heojeongbo/fluxion-worker)
[![coverage](https://img.shields.io/badge/coverage-100%25%20lines-brightgreen)](#testing)

Generic Web Worker pool and utilities. Zero dependencies, framework-agnostic.

Used internally by [`@heojeongbo/fluxion-render`](https://www.npmjs.com/package/@heojeongbo/fluxion-render) but designed to work standalone with any worker script.

```bash
npm install @heojeongbo/fluxion-worker
```

---

## Features

- **`WorkerPool`** — manages N workers, routes messages via `hostId`, least-busy scheduling
- **`WorkerHandle`** — thin wrapper over a single Worker with `hostId` filtering and optional pool integration
- **`defineWorker`** — worker-side helper that eliminates `self.onmessage` / `self.postMessage` boilerplate and auto-echoes `hostId`
- **`defineWorkerWithState` stream mode** — optional second `streamHandler` argument for fire-and-forget high-frequency paths (no Promise, no GC pressure)
- **`/react` subpath** — `useWorkerHandle`, `useWorkerPool`, `useWorkerRequest`, `useWorkerStream` hooks (React 18+, optional)

---

## Quick Start

### Worker script

```ts
// calc-worker.ts
import { defineWorker } from "@heojeongbo/fluxion-worker";

defineWorker<{ op: string; values: number[] }, { result: number }>(
  ({ op, values }, reply) => {
    const result = op === "sum" ? values.reduce((a, b) => a + b, 0) : 0;
    reply({ result });
  },
);
```

### Pool mode (multiple workers)

```ts
import { WorkerPool } from "@heojeongbo/fluxion-worker";

const pool = new WorkerPool({
  size: 4,
  workerFactory: () =>
    new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" }),
});

// One-liner: acquire → request → release
const result = await pool.dispatch<{ result: number }>(
  { op: "sum", values: [1, 2, 3] },
  { timeoutMs: 5000 },
);
console.log(result.result); // 6
```

### Standalone mode (single worker, no pool)

```ts
import { WorkerHandle } from "@heojeongbo/fluxion-worker";

const handle = new WorkerHandle(
  () => new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" }),
);

const result = await handle.request<{ result: number }>(
  { op: "sum", values: [1, 2, 3] },
  { timeoutMs: 5000 },
);
console.log(result.result); // 6

handle.dispose(); // stops the worker
```

---

## React

Import from the `/react` subpath. React 18+ is a peer dependency (optional).

### `useWorkerHandle` — single worker, lifecycle managed

```tsx
import { useWorkerHandle } from "@heojeongbo/fluxion-worker/react";
import { WorkerHandle } from "@heojeongbo/fluxion-worker";
import { useMemo, useState } from "react";

function Calc() {
  const handle = useWorkerHandle<{ op: string; values: number[] }>(
    () => new WorkerHandle(
      () => new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" })
    )
  );

  const [result, setResult] = useState<number | null>(null);

  const onClick = async () => {
    if (!handle) return; // null on first render
    const res = await handle.request<{ result: number }>(
      { op: "sum", values: [1, 2, 3] },
      { timeoutMs: 5000 },
    );
    setResult(res.result);
  };

  return <button onClick={onClick}>{result ?? "Calculate"}</button>;
}
```

The handle is created inside `useEffect` (null on first render) and disposed on unmount.
React StrictMode safe — double-invoke creates a fresh handle each time.

### `useWorkerPool` — pool, lifecycle managed

```tsx
import { useWorkerPool } from "@heojeongbo/fluxion-worker/react";

function Dashboard() {
  const pool = useWorkerPool<{ op: string; values: number[] }>({
    size: 4,
    workerFactory: () =>
      new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" }),
  });

  // pool is always non-null (synchronous initialization)
  const onClick = async () => {
    const result = await pool.dispatch<{ result: number }>(
      { op: "sum", values: [1, 2, 3] },
      { timeoutMs: 5000 },
    );
    console.log(result.result);
  };

  return <button onClick={onClick}>Calculate</button>;
}
```

### `useWorkerRequest` — declarative request/response

```tsx
import { useWorkerHandle, useWorkerRequest } from "@heojeongbo/fluxion-worker/react";
import { WorkerHandle } from "@heojeongbo/fluxion-worker";
import { useMemo } from "react";

type CalcMsg = { op: "sum"; values: number[] };
type CalcResult = { result: number };

function Calc({ values }: { values: number[] }) {
  const handle = useWorkerHandle<CalcMsg>(
    () => new WorkerHandle(
      () => new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" })
    )
  );

  // Stabilize msg with useMemo — inline objects re-trigger on every render.
  const msg = useMemo(() => ({ op: "sum" as const, values }), [values]);

  const { data, loading, error } = useWorkerRequest<CalcMsg, CalcResult>(handle, msg);

  if (loading) return <span>calculating…</span>;
  if (error) return <span>error: {error.message}</span>;
  return <span>result: {data?.result}</span>;
}
```

The in-flight request is automatically cancelled (via `AbortSignal`) when `handle` or `msg` changes, or when the component unmounts.

### `useWorkerStream` — fire-and-forget emit, callback per push

Emits a stream message on mount and subscribes to worker pushes via `handle.onStream()`. Unsubscribes on unmount. No Promise, no loading state.

```tsx
import { useWorkerStream } from "@heojeongbo/fluxion-worker/react";
import { WorkerHandle } from "@heojeongbo/fluxion-worker";

type StreamMsg = { start: true };
type StreamResult = { value: number };

function Live({ handle }: { handle: WorkerHandle<StreamMsg> | null }) {
  useWorkerStream<StreamMsg, StreamResult>(
    handle,
    { start: true },           // emitted on mount (mode: "stream")
    (data) => {
      console.log(data.value); // called for every push from the worker
    },
  );

  return null;
}
```

```ts
useWorkerStream<TMsg, TResult>(
  handle: WorkerHandle<TMsg> | null,
  msg: TMsg,                               // emitted on mount
  onData: (result: TResult) => void,       // called per push; captured by ref — stable across renders
  transfer?: Transferable[],               // optional transfer list for msg
  deps?: DependencyList,                   // re-emit when deps change (default [])
): void
```

- `onData` is always called with the latest closure — no stale ref issues
- Subscription is registered **before** emit so no push is missed
- Does nothing when `handle` is `null`

---

## API

### `defineWorker(handler)`

Registers a message handler in a worker script. Automatically echoes `hostId` back on every reply so pool/handle routing works.

```ts
defineWorker<TMsg, TResult>(
  handler: (msg: TMsg, reply: ReplyFn<TResult>) => void | Promise<void>
): void
```

- Call `reply` once for request/response, or multiple times for streaming
- Pass a second argument to `reply` to transfer `Transferable` objects (e.g. `ArrayBuffer`)
- Works with async handlers

```ts
// Streaming (multiple replies per message)
defineWorker<{ items: number[] }, { chunk: number[] }>(({ items }, reply) => {
  for (let i = 0; i < items.length; i += 100) {
    reply({ chunk: items.slice(i, i + 100) });
  }
});

// With Transferable (zero-copy ArrayBuffer transfer)
defineWorker<{ size: number }, { buffer: ArrayBuffer }>(({ size }, reply) => {
  const buffer = new ArrayBuffer(size);
  reply({ buffer }, [buffer]); // ownership transferred, no copy
});

// Async
defineWorker<{ url: string }, { data: string }>(async ({ url }, reply) => {
  const res = await fetch(url);
  reply({ data: await res.text() });
});
```

### `defineWorkerWithState(rpcHandler, streamHandler?)`

Like `defineWorker`, but manages per-host state automatically. An optional second `streamHandler` argument handles fire-and-forget messages sent via `WorkerHandle.emit()` — no Promise, no reply, no GC pressure.

```ts
defineWorkerWithState<TMsg, TResult, TState, TStreamMsg, TStreamResult>(
  rpcHandler: (
    msg: TMsg,
    reply: ReplyFn<TResult>,
    ctx: HostContext<TState>  // { hostId, state, mode }
  ) => TState | null | void | Promise<TState | null | void>,
  streamHandler?: (
    msg: TStreamMsg,
    push: PushFn<TStreamResult>,
    ctx: HostContext<TState>
  ) => void | Promise<void>
): void
```

Messages with `mode: "stream"` are routed to `streamHandler`; all others go to `rpcHandler`. State is shared between both handlers via `ctx.state` — `rpcHandler` updates it, `streamHandler` reads it.

- Return a new state value from `rpcHandler` to update it for this host
- Return `null` to delete the state for this host (useful for session cleanup)
- Return `undefined` (or void) to leave state unchanged
- Works in standalone mode — messages without `hostId` share a `"__solo__"` slot

```ts
// RPC only
defineWorkerWithState<{ count: 1 }, { total: number }, { total: number }>(
  ({ }, reply, { state }) => {
    const s = state ?? { total: 0 };
    const next = { total: s.total + 1 };
    reply(next);
    return next;
  }
);

// RPC + stream (high-frequency path, no Promise)
type Msg = { init: true };
type StreamMsg = { buffer: ArrayBuffer; length: number; id: string };
type State = { count: number };

defineWorkerWithState<Msg, object, State, StreamMsg>(
  (_msg, _reply, ctx) => {
    return ctx.state ?? { count: 0 };
  },
  (msg, _push, ctx) => {
    const s = ctx.state;
    if (!s) return;
    const raw = new Float32Array(msg.buffer, 0, msg.length);
    // process raw — no reply needed, runs entirely off main thread
  },
);
```

---

### `WorkerPool<TMsg>`

Manages a set of workers and distributes load via least-busy scheduling. Fixed-size by default; optionally grows on demand up to `maxSize`.

```ts
const pool = new WorkerPool<TMsg>({
  size?: number,               // INITIAL worker count — default 4, clamped to [1, 16]
  maxSize?: number,            // default = size (growth disabled). Upper bound for runtime growth, clamped to [size, 16]
  targetPerWorker?: number,    // default 12, min 1. Active hosts/worker that triggers growth toward maxSize
  workerFactory: () => Worker, // required
});
```

| Option | Description |
|--------|-------------|
| `size` | **Initial** worker count (default `4`, clamped `[1, 16]`). When `maxSize` is larger, the pool starts here and grows on demand |
| `maxSize` | Upper bound for runtime growth (default `= size`, i.e. growth disabled / fixed-size pool). Clamped to `[size, 16]` |
| `targetPerWorker` | Active hosts per worker that triggers growth (default `12`, min `1`). Lower it for heavier per-host workloads (e.g. high-Hz streaming) so hosts spread across more workers sooner. Only has an effect when `maxSize > size` |

**Fixed vs. growing** — existing fixed-size usage is unchanged: omit `maxSize` (it defaults to `size`) and the pool stays at exactly `size` workers. When `maxSize > size`, the pool starts at `size` workers and spawns more on demand (up to `maxSize`) as the average active hosts per worker reaches `targetPerWorker`:

```ts
// Fixed-size pool (unchanged behavior) — always exactly 4 workers
const fixed = new WorkerPool<TMsg>({ size: 4, workerFactory });

// Growing pool — starts at 2, grows toward 12 as load climbs
const growing = new WorkerPool<TMsg>({
  size: 2,
  maxSize: 12,
  targetPerWorker: 8, // grow once avg active hosts/worker reaches 8
  workerFactory,
});
```

| Method / Property | Description |
|-------------------|-------------|
| `pool.acquire()` | Returns a `WorkerHandle` bound to the least-busy worker |
| `pool.dispatch(msg, opts?, transfer?)` | One-liner: acquire → request → release |
| `pool.onError(callback)` | Global error handler for fire-and-forget errors. Returns an `off` fn |
| `pool.stats()` | `{ size, hostCounts, leastBusyIndex, totalActive }` |
| `pool.isDisposed` | `true` if `dispose()` has been called on this pool |
| `pool.dispose()` | Terminates all workers and cleans up listeners |

**Global error handler** — catches errors from fire-and-forget `postMessage` calls that would otherwise be silently dropped:

```ts
const off = pool.onError((err, workerIndex) => {
  console.error(`Worker ${workerIndex} error:`, err.message);
});
// Later: off();
```

**Subclassing** — override `_createHandle` to return a custom handle type:

```ts
class MyPool extends WorkerPool<MyMsg> {
  protected override _createHandle(worker, index, hostId, onRelease) {
    return new MyHandle(worker, hostId, onRelease);
  }
  override acquire(): MyHandle {
    return super.acquire() as MyHandle;
  }
}
```

---

### `WorkerHandle<TMsg>`

Wraps a Worker and provides `hostId`-filtered messaging.

**Factory constructor** (handle owns the worker):
```ts
const handle = new WorkerHandle<TMsg>(
  () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
);
// dispose() stops the worker
```

**Injection constructor** (pool owns the worker):
```ts
const handle = new WorkerHandle<TMsg>(worker, hostId, onRelease?);
// dispose() releases back to pool
```

| Method | Description |
|--------|-------------|
| `handle.postMessage(msg, transfer?)` | Stamps `hostId` onto the message and sends it |
| `handle.request<TResult>(msg, opts?, transfer?)` | Send and await a single response |
| `handle.dispatch<TResult>(msg, opts?, transfer?)` | Alias for `request()` — consistent naming with pool |
| `handle.onMessage<TResult>(callback)` | Typed subscription; returns `off` fn |
| `handle.onError(callback)` | Error subscription; returns `off` fn |
| `handle.addEventListener(type, listener)` | Low-level; filters by `hostId` automatically |
| `handle.removeEventListener(type, listener)` | Unsubscribes |
| `handle.release()` | Returns to pool (no-op in standalone mode) |
| `handle.terminate()` | Stops the worker if the handle owns it; no-op if pool-backed |
| `handle.dispose()` | Smart cleanup — terminate in standalone, release in pool-backed |
| `handle.isTerminated` | `true` after `dispose()` / `terminate()` |
| `handle.hostId` | Unique identifier for this handle |

**`request()` with AbortSignal** — clean React `useEffect` integration:

```ts
useEffect(() => {
  const ctrl = new AbortController();
  handle.request<CalcResult>(msg, { timeoutMs: 5000, signal: ctrl.signal })
    .then(setResult)
    .catch((err) => {
      if (ctrl.signal.aborted) return; // ignore cleanup cancellations
      setError(err);
    });
  return () => ctrl.abort(); // cancel on unmount or dep change
}, [handle, msg]);
```

---

## Testing

Tested with [Vitest](https://vitest.dev). Run coverage from this package:

```bash
cd packages/fluxion-worker && pnpm vitest run --coverage
```

Enforced thresholds (`vitest.config.ts`): **100% lines · 100% statements ·
100% functions · 95% branches**.

---

## License

MIT
