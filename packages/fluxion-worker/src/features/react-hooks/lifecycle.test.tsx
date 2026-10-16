import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkerPool } from "./use-worker-pool";

afterEach(cleanup);
describe("React resource ownership", () => {
  it("survives StrictMode and leaves no workers after unmount", async () => {
    const workers: { terminate: ReturnType<typeof vi.fn> }[] = [];
    const factory = () => {
      const worker = {
        terminate: vi.fn(),
        addEventListener() {},
        removeEventListener() {},
      };
      workers.push(worker);
      return worker as unknown as Worker;
    };
    const hook = renderHook(() => useWorkerPool({ size: 1, workerFactory: factory }), {
      wrapper: StrictMode,
    });
    expect(hook.result.current.isDisposed).toBe(false);
    expect(workers).toHaveLength(1);
    await act(async () => {
      hook.unmount();
    });
    expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
  });
  it("applies new options when dependencies change without disposing the new pool", async () => {
    const factory = vi.fn(
      () =>
        ({
          terminate: vi.fn(),
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as Worker,
    );
    const hook = renderHook(
      ({ size }) => useWorkerPool({ size, workerFactory: factory }, [size]),
      { initialProps: { size: 1 } },
    );
    const old = hook.result.current;
    await act(async () => {
      hook.rerender({ size: 2 });
    });
    expect(old.isDisposed).toBe(true);
    expect(hook.result.current.isDisposed).toBe(false);
    expect(hook.result.current.stats().size).toBe(2);
    await act(async () => {
      hook.unmount();
    });
  });
});
