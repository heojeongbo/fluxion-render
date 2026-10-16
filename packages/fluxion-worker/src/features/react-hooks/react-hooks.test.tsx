import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerHandle, WorkerPool } from "../worker-pool/model/worker-pool";
import { useWorkerHandle } from "./use-worker-handle";
import { useWorkerPool } from "./use-worker-pool";
import { useWorkerRequest } from "./use-worker-request";
import { useWorkerStream } from "./use-worker-stream";

// ─── Fake Worker ─────────────────────────────────────────────────────────────

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _emit: (type: string, data: unknown) => void;
}

function makeFakeWorker(): FakeWorker {
  const _listeners = new Map<string, Set<EventListener>>();
  const addEventListener = vi.fn((type: string, fn: EventListener) => {
    if (!_listeners.has(type)) _listeners.set(type, new Set());
    _listeners.get(type)!.add(fn);
  });
  const removeEventListener = vi.fn((type: string, fn: EventListener) => {
    _listeners.get(type)?.delete(fn);
  });
  const _emit = (type: string, data: unknown) => {
    const evt = { data } as MessageEvent;
    for (const fn of _listeners.get(type) ?? []) fn(evt);
  };
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener,
    removeEventListener,
    _emit,
  };
}

interface TestMsg {
  op: string;
  hostId?: string;
}
interface TestResult {
  result: number;
}

// ─── useWorkerHandle ──────────────────────────────────────────────────────────

describe("useWorkerHandle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null on first render, then a WorkerHandle after mount", async () => {
    let fake!: FakeWorker;
    const factory = () => {
      fake = makeFakeWorker();
      return new WorkerHandle<TestMsg>(() => fake as unknown as Worker);
    };

    const { result } = renderHook(() => useWorkerHandle<TestMsg>(factory));

    // After mount (useEffect fires), handle should be non-null.
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBeInstanceOf(WorkerHandle);
  });

  it("disposes the handle on unmount", async () => {
    let handle!: WorkerHandle<TestMsg>;
    let fake!: FakeWorker;
    const factory = () => {
      fake = makeFakeWorker();
      handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);
      return handle;
    };

    const { result, unmount } = renderHook(() => useWorkerHandle<TestMsg>(factory));
    await waitFor(() => expect(result.current).not.toBeNull());

    unmount();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(handle.isTerminated).toBe(true);
  });

  it("re-creates handle when deps change", async () => {
    let callCount = 0;
    const fakes: FakeWorker[] = [];

    const { result, rerender } = renderHook(
      ({ dep }: { dep: number }) =>
        useWorkerHandle<TestMsg>(() => {
          callCount++;
          const f = makeFakeWorker();
          fakes.push(f);
          return new WorkerHandle<TestMsg>(() => f as unknown as Worker);
        }, [dep]),
      { initialProps: { dep: 0 } },
    );

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(callCount).toBe(1);

    rerender({ dep: 1 });
    await waitFor(() => expect(callCount).toBe(2));
    // First handle should be disposed.
    expect(fakes[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("captures factory by ref — unstable factory does not re-create handle", async () => {
    let callCount = 0;
    const fake = makeFakeWorker();

    const { result, rerender } = renderHook(() =>
      useWorkerHandle<TestMsg>(() => {
        callCount++;
        return new WorkerHandle<TestMsg>(() => fake as unknown as Worker);
      }),
    );

    await waitFor(() => expect(result.current).not.toBeNull());
    const firstHandle = result.current;

    // Re-render with no dep change — factory is different closure but handle must not change.
    rerender();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBe(firstHandle);
    expect(callCount).toBe(1);
  });
});

// ─── useWorkerPool ────────────────────────────────────────────────────────────

describe("useWorkerPool", () => {
  it("returns a non-null WorkerPool synchronously", () => {
    const { result } = renderHook(() =>
      useWorkerPool<TestMsg>({
        size: 1,
        workerFactory: () => makeFakeWorker() as unknown as Worker,
      }),
    );
    expect(result.current).toBeInstanceOf(WorkerPool);
  });

  it("disposes the pool on unmount", async () => {
    const fake = makeFakeWorker();
    const { result, unmount } = renderHook(() =>
      useWorkerPool<TestMsg>({
        size: 1,
        workerFactory: () => fake as unknown as Worker,
      }),
    );

    const pool = result.current;
    const disposeSpy = vi.spyOn(pool, "dispose");
    unmount();
    await Promise.resolve();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("disposes old pool when deps change", async () => {
    const fakes: FakeWorker[] = [];

    const { result, rerender } = renderHook(
      ({ dep }: { dep: number }) =>
        useWorkerPool<TestMsg>(
          {
            size: 1,
            workerFactory: () => {
              const f = makeFakeWorker();
              fakes.push(f);
              return f as unknown as Worker;
            },
          },
          [dep],
        ),
      { initialProps: { dep: 0 } },
    );

    const firstPool = result.current;
    const disposeSpy = vi.spyOn(firstPool, "dispose");

    rerender({ dep: 1 });

    // Cleanup from effect with dep=0 runs — old pool gets disposed.
    await waitFor(() => expect(disposeSpy).toHaveBeenCalledTimes(1));
  });
});

// ─── useWorkerRequest ─────────────────────────────────────────────────────────

describe("useWorkerRequest", () => {
  it("starts in loading state when handle is non-null", async () => {
    const fake = makeFakeWorker();
    const handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);

    const msg = { op: "sum" };
    const { result } = renderHook(() =>
      useWorkerRequest<TestMsg, TestResult>(handle, msg),
    );

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();

    handle.dispose();
  });

  it("resolves data when worker replies", async () => {
    const fake = makeFakeWorker();
    const handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);

    const msg = { op: "sum" };
    const { result } = renderHook(() =>
      useWorkerRequest<TestMsg, TestResult>(handle, msg),
    );

    await waitFor(() => expect(result.current.loading).toBe(true));

    // Simulate worker reply.
    const hostId = handle.hostId;
    act(() => {
      fake._emit("message", { result: 42, hostId });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ result: 42 });
    expect(result.current.error).toBeNull();

    handle.dispose();
  });

  it("sets error when worker replies with an error message", async () => {
    const fake = makeFakeWorker();
    const handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);

    const msg = { op: "sum" };
    const { result } = renderHook(() =>
      useWorkerRequest<TestMsg, TestResult>(handle, msg),
    );

    await waitFor(() => expect(result.current.loading).toBe(true));

    act(() => {
      fake._emit("message", {
        __fluxionError: true,
        hostId: handle.hostId,
        message: "boom",
      });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBeNull();

    handle.dispose();
  });

  it("does not update state after unmount (abort cleanup)", async () => {
    const fake = makeFakeWorker();
    const handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);

    const msg = { op: "sum" };
    const { result, unmount } = renderHook(() =>
      useWorkerRequest<TestMsg, TestResult>(handle, msg),
    );

    await waitFor(() => expect(result.current.loading).toBe(true));

    unmount();

    // Emitting after unmount — no state update, no error thrown.
    expect(() => {
      act(() => {
        fake._emit("message", { result: 99, hostId: handle.hostId });
      });
    }).not.toThrow();

    handle.dispose();
  });

  it("does nothing when handle is null", () => {
    const { result } = renderHook(() =>
      useWorkerRequest<TestMsg, TestResult>(null, { op: "sum" }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("re-fires when msg reference changes", async () => {
    const fake = makeFakeWorker();
    const handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);

    let msg = { op: "sum" };
    const { result, rerender } = renderHook(() =>
      useWorkerRequest<TestMsg, TestResult>(handle, msg),
    );

    await waitFor(() => expect(result.current.loading).toBe(true));
    act(() => {
      fake._emit("message", { result: 1, hostId: handle.hostId });
    });
    await waitFor(() => expect(result.current.data).toEqual({ result: 1 }));

    // Change msg reference — new request should fire.
    msg = { op: "product" };
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(true));

    act(() => {
      fake._emit("message", { result: 2, hostId: handle.hostId });
    });
    await waitFor(() => expect(result.current.data).toEqual({ result: 2 }));

    handle.dispose();
  });
});

// ─── useWorkerStream ──────────────────────────────────────────────────────────

describe("useWorkerStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHandleWithFake() {
    const fake = makeFakeWorker();
    const handle = new WorkerHandle<TestMsg>(() => fake as unknown as Worker);
    return { handle, fake };
  }

  it("calls emit on mount with the provided msg", async () => {
    const { handle, fake } = makeHandleWithFake();
    const onData = vi.fn();
    const msg: TestMsg = { op: "start" };

    renderHook(() => useWorkerStream(handle, msg, onData));

    await waitFor(() => {
      const calls = fake.postMessage.mock.calls;
      expect(calls.some((c) => (c[0] as Record<string, unknown>).mode === "stream")).toBe(
        true,
      );
    });

    handle.dispose();
  });

  it("subscribes before emitting (onStream registered first)", async () => {
    const { handle, fake } = makeHandleWithFake();
    const received: number[] = [];
    const msg: TestMsg = { op: "sub" };

    renderHook(() =>
      useWorkerStream<TestMsg, { value: number }>(handle, msg, (d) => {
        received.push(d.value);
      }),
    );

    await waitFor(() =>
      fake.postMessage.mock.calls.some(
        (c) => (c[0] as Record<string, unknown>).mode === "stream",
      ),
    );

    act(() => {
      fake._emit("message", { __fluxionStream: true, hostId: handle.hostId, value: 42 });
    });

    expect(received).toEqual([42]);
    handle.dispose();
  });

  it("calls onData for each push received from the worker", async () => {
    const { handle, fake } = makeHandleWithFake();
    const onData = vi.fn();
    const msg: TestMsg = { op: "stream" };

    renderHook(() => useWorkerStream<TestMsg, TestResult>(handle, msg, onData));

    await waitFor(() =>
      fake.postMessage.mock.calls.some(
        (c) => (c[0] as Record<string, unknown>).mode === "stream",
      ),
    );

    act(() => {
      fake._emit("message", { __fluxionStream: true, hostId: handle.hostId, result: 1 });
      fake._emit("message", { __fluxionStream: true, hostId: handle.hostId, result: 2 });
    });

    expect(onData).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it("unsubscribes on unmount", async () => {
    const { handle, fake } = makeHandleWithFake();
    const onData = vi.fn();
    const msg: TestMsg = { op: "unsub" };

    const { unmount } = renderHook(() =>
      useWorkerStream<TestMsg, TestResult>(handle, msg, onData),
    );

    await waitFor(() =>
      fake.postMessage.mock.calls.some(
        (c) => (c[0] as Record<string, unknown>).mode === "stream",
      ),
    );

    unmount();

    act(() => {
      fake._emit("message", { __fluxionStream: true, hostId: handle.hostId, result: 99 });
    });

    expect(onData).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("does nothing when handle is null", () => {
    const onData = vi.fn();
    expect(() => {
      renderHook(() => useWorkerStream<TestMsg, TestResult>(null, { op: "x" }, onData));
    }).not.toThrow();
    expect(onData).not.toHaveBeenCalled();
  });
});

it("normalizes a non-Error request rejection", async () => {
  const handle = new WorkerHandle<TestMsg>(() => makeFakeWorker() as unknown as Worker);
  vi.spyOn(handle, "request").mockRejectedValueOnce("plain failure");
  const message = { op: "failure" };
  const hook = renderHook(() => useWorkerRequest(handle, message));
  await waitFor(() => expect(hook.result.current.error?.message).toBe("plain failure"));
  hook.unmount();
  handle.dispose();
});
