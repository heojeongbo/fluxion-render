import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluxionWorkerPool } from "../../../features/worker-pool";
import { useFluxionWorkerPool } from "./use-fluxion-worker-pool";

afterEach(cleanup);
describe("useFluxionWorkerPool", () => {
  for (const strict of [false, true]) {
    it(`keeps a live stable pool and releases all workers (StrictMode=${strict})`, async () => {
      const workers: { terminate: ReturnType<typeof vi.fn> }[] = [];
      const workerFactory = () => {
        const w = { terminate: vi.fn(), addEventListener() {}, removeEventListener() {} };
        workers.push(w);
        return w as unknown as Worker;
      };
      const hook = renderHook(() => useFluxionWorkerPool({ size: 2, workerFactory }), {
        wrapper: strict ? StrictMode : undefined,
      });
      const pool = hook.result.current;
      expect(pool).toBeInstanceOf(FluxionWorkerPool);
      expect(pool.isDisposed).toBe(false);
      expect(workers).toHaveLength(2);
      hook.rerender();
      expect(hook.result.current).toBe(pool);
      const handle = pool.acquire();
      handle.dispose();
      await act(async () => {
        hook.unmount();
      });
      expect(pool.isDisposed).toBe(true);
      expect(workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
    });
  }
});
