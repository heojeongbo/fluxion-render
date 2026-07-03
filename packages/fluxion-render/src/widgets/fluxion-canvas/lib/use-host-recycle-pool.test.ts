import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FluxionHost } from "../../../features/host";
import {
  flushMountScheduler,
  resetMountScheduler,
} from "../../../shared/lib/lifecycle-scheduler";
import { useHostRecyclePool } from "./use-host-recycle-pool";

describe("useHostRecyclePool", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetMountScheduler(); // pool teardown defers through the lifecycle queue
  });

  it("returns a stable pool across re-renders and disposes it on unmount", () => {
    const { result, rerender, unmount } = renderHook(() =>
      useHostRecyclePool({ max: 4 }),
    );
    const pool = result.current;
    expect(pool.isDisposed).toBe(false);
    rerender();
    expect(result.current).toBe(pool); // stable across renders
    unmount();
    expect(pool.isDisposed).toBe(true); // disposed on unmount
  });

  it("defaults its options when none are passed", () => {
    const { result } = renderHook(() => useHostRecyclePool());
    expect(result.current.size).toBe(0);
    expect(result.current.stats).toEqual({
      created: 0,
      recycled: 0,
      overflowDisposed: 0,
      highWater: 0,
      shrunk: 0,
    });
  });

  it("unmount defers parked-host teardown through the lifecycle queue", () => {
    const { result, unmount } = renderHook(() => useHostRecyclePool());
    const pool = result.current;
    const dispose = vi.fn();
    pool.release({
      host: { dispose } as unknown as FluxionHost,
      canvas: {} as HTMLCanvasElement,
      key: pool.keyFor({ hasXAxis: false, hasYAxis: false }),
    });
    unmount(); // disposes the pool in the cleanup…
    expect(pool.isDisposed).toBe(true);
    expect(dispose).not.toHaveBeenCalled(); // …but teardown drains on a later frame
    flushMountScheduler(); // module-global queue survives the unmount
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
