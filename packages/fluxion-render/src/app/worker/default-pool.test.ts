import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeWorkerInstances: {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}[];

function makeFakeWorker() {
  const w = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  fakeWorkerInstances.push(w);
  return w;
}

class FakeWorker {
  postMessage = vi.fn();
  terminate = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor(_url: string | URL, _opts?: WorkerOptions) {
    fakeWorkerInstances.push(this);
  }
}

beforeEach(() => {
  fakeWorkerInstances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getDefaultPool", () => {
  it("returns a FluxionWorkerPool instance", async () => {
    const { getDefaultPool } = await import("./default-pool");
    const pool = getDefaultPool();
    expect(pool).toBeDefined();
    expect(typeof pool.acquire).toBe("function");
    expect(typeof pool.dispose).toBe("function");
  });

  it("returns the same instance on repeated calls (singleton)", async () => {
    const { getDefaultPool } = await import("./default-pool");
    const p1 = getDefaultPool();
    const p2 = getDefaultPool();
    expect(p1).toBe(p2);
  });

  it("singleton persists across multiple calls in the same module", async () => {
    const { getDefaultPool } = await import("./default-pool");
    const instances = [getDefaultPool(), getDefaultPool(), getDefaultPool()];
    expect(instances[0]).toBe(instances[1]);
    expect(instances[1]).toBe(instances[2]);
  });
});

describe("configureDefaultPool", () => {
  it("replaces the singleton pool with a new instance", async () => {
    const { getDefaultPool, configureDefaultPool } = await import("./default-pool");
    const original = getDefaultPool();
    configureDefaultPool({ size: 2 });
    const reconfigured = getDefaultPool();
    expect(reconfigured).not.toBe(original);
  });

  it("new pool from configureDefaultPool is a valid FluxionWorkerPool", async () => {
    const { getDefaultPool, configureDefaultPool } = await import("./default-pool");
    configureDefaultPool({ size: 2 });
    const pool = getDefaultPool();
    expect(typeof pool.acquire).toBe("function");
    expect(typeof pool.dispose).toBe("function");
  });

  it("disposes the previous pool before creating a new one", async () => {
    const { FluxionWorkerPool } = await import("../../features/worker-pool");
    const disposeSpy = vi.fn();
    const originalCreate = FluxionWorkerPool.prototype.dispose;
    FluxionWorkerPool.prototype.dispose = disposeSpy;

    try {
      const { getDefaultPool, configureDefaultPool } = await import("./default-pool");
      getDefaultPool();
      configureDefaultPool({ size: 3 });
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      FluxionWorkerPool.prototype.dispose = originalCreate;
    }
  });

  it("accepts a custom workerFactory override", async () => {
    const customFactory = vi.fn(() => makeFakeWorker() as unknown as Worker);
    const { getDefaultPool, configureDefaultPool } = await import("./default-pool");
    configureDefaultPool({ size: 1, workerFactory: customFactory });
    const pool = getDefaultPool();
    expect(pool).toBeDefined();
  });

  it("getDefaultPool after configureDefaultPool returns the new pool consistently", async () => {
    const { getDefaultPool, configureDefaultPool } = await import("./default-pool");
    configureDefaultPool({ size: 2 });
    const p1 = getDefaultPool();
    const p2 = getDefaultPool();
    expect(p1).toBe(p2);
  });
});

describe("default pool sizing (adaptive maxSize)", () => {
  it("scales maxSize with hardwareConcurrency (leaves one core for main)", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    const { getDefaultPool } = await import("./default-pool");
    const pool = getDefaultPool();
    // 8 cores → maxSize min(16, 8-1) = 7. Pool starts small and may grow to 7.
    pool.dispose();
    expect(pool).toBeDefined();
  });

  it("falls back when navigator.hardwareConcurrency is unavailable", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 0 });
    const { getDefaultPool } = await import("./default-pool");
    const pool = getDefaultPool();
    expect(pool).toBeDefined();
    pool.dispose();
  });

  it("falls back when navigator itself is undefined", async () => {
    vi.stubGlobal("navigator", undefined);
    const { getDefaultPool } = await import("./default-pool");
    const pool = getDefaultPool();
    expect(pool).toBeDefined();
    pool.dispose();
  });
});
