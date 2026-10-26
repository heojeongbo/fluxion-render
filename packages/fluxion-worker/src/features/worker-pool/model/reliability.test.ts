import { describe, expect, it, vi } from "vitest";
import { WorkerHandle, WorkerPool } from "./worker-pool";

class FakeWorker extends EventTarget {
  sent: Record<string, unknown>[] = [];
  terminate = vi.fn();
  postMessage(message: Record<string, unknown>) {
    this.sent.push(message);
  }
  reply(data: object) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
function setup() {
  const worker = new FakeWorker();
  const handle = new WorkerHandle<{ job: string }>(() => worker as unknown as Worker);
  const reply = (index: number, result: object) =>
    worker.reply({ ...worker.sent[index], ...result });
  return { worker, handle, reply };
}
describe("RPC identity and ownership", () => {
  it("routes reversed replies and errors to the matching request", async () => {
    const { handle, reply } = setup();
    const a = handle.request({ job: "a" });
    const b = handle.request({ job: "b" });
    reply(1, { value: 2 });
    reply(0, { value: 1 });
    await expect(a).resolves.toEqual({ job: "a", value: 1 });
    await expect(b).resolves.toEqual({ job: "b", value: 2 });
    const c = handle.request({ job: "c" });
    const d = handle.request({ job: "d" });
    const rejected = expect(c).rejects.toThrow("only c");
    reply(2, { __fluxionError: true, message: "only c" });
    reply(3, { value: 4 });
    await rejected;
    await expect(d).resolves.toMatchObject({ value: 4 });
    handle.dispose();
  });
  it("ignores a cancelled request's late tagged reply", async () => {
    const { handle, reply } = setup();
    const abort = new AbortController();
    const old = handle.request({ job: "old" }, { signal: abort.signal });
    const rejected = expect(old).rejects.toThrow();
    abort.abort();
    await rejected;
    const next = handle.request({ job: "next" });
    reply(0, { value: 1 });
    reply(1, { value: 2 });
    await expect(next).resolves.toMatchObject({ value: 2 });
    handle.dispose();
  });
  it("routes untagged replies in order to the oldest pending request", async () => {
    const { handle, worker } = setup();
    const first = handle.request({ job: "first" });
    worker.reply({ hostId: handle.hostId, value: 1 });
    await expect(first).resolves.toEqual({ value: 1 });
    const a = handle.request({ job: "a" });
    const b = handle.request({ job: "b" });
    worker.reply({ hostId: handle.hostId, value: 2 });
    worker.reply({ hostId: handle.hostId, value: 3 });
    await expect(a).resolves.toEqual({ value: 2 });
    await expect(b).resolves.toEqual({ value: 3 });
    handle.dispose();
  });
  it("keeps serving a non-echoing worker after a timeout or abort", async () => {
    vi.useFakeTimers();
    try {
      const { handle, worker } = setup();
      const timedOut = handle.request({ job: "slow" }, { timeoutMs: 10 });
      const rejected = expect(timedOut).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      // The slow reply lands while nothing is pending, then work resumes.
      worker.reply({ hostId: handle.hostId, value: "late" });
      const abort = new AbortController();
      const aborted = handle.request({ job: "aborted" }, { signal: abort.signal });
      const abortRejected = expect(aborted).rejects.toThrow();
      abort.abort();
      await abortRejected;
      worker.reply({ hostId: handle.hostId, value: "late" });
      for (const value of [1, 2]) {
        const next = handle.request({ job: "next" });
        worker.reply({ hostId: handle.hostId, value });
        await expect(next).resolves.toEqual({ value });
      }
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not treat untagged messages as replies once the worker echoes ids", async () => {
    const { handle, worker, reply } = setup();
    const tagged = handle.request({ job: "tagged" });
    reply(0, { value: 1 });
    await expect(tagged).resolves.toMatchObject({ value: 1 });
    const pending = handle.request({ job: "pending" });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // e.g. defineWorker answering a fire-and-forget postMessage
    worker.reply({ hostId: handle.hostId, value: "unrelated" });
    worker.reply({ hostId: handle.hostId, __fluxionError: true, message: "unrelated" });
    await Promise.resolve();
    expect(settled).toBe(false);
    reply(1, { value: 2 });
    await expect(pending).resolves.toMatchObject({ job: "pending", value: 2 });
    handle.dispose();
  });
  it("cleans up synchronous postMessage failures and rejects requests after disposal", async () => {
    const { handle, worker } = setup();
    const remove = vi.spyOn(worker, "removeEventListener");
    vi.spyOn(worker, "postMessage").mockImplementation(() => {
      throw new Error("clone failed");
    });
    await expect(handle.request({ job: "a" })).rejects.toThrow("clone failed");
    expect(remove).toHaveBeenCalled();
    handle.dispose();
    handle.dispose();
    handle.terminate();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(handle.request({ job: "b" })).rejects.toThrow("terminated");
  });
  it("releases each pool slot once and keeps another host active", () => {
    const pool = new WorkerPool({
      size: 1,
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    const a = pool.acquire();
    const b = pool.acquire();
    a.release();
    a.dispose();
    a.release();
    expect(pool.stats().totalActive).toBe(1);
    b.dispose();
    expect(pool.stats().totalActive).toBe(0);
    pool.dispose();
  });
  it("deduplicates event subscriptions", () => {
    const { handle, worker } = setup();
    const listener = vi.fn();
    handle.addEventListener("message", listener);
    handle.addEventListener("message", listener);
    worker.reply({ hostId: handle.hostId });
    expect(listener).toHaveBeenCalledTimes(1);
    handle.removeEventListener("message", listener);
    worker.reply({ hostId: handle.hostId });
    expect(listener).toHaveBeenCalledTimes(1);
    handle.dispose();
    handle.addEventListener("message", listener);
  });
  it("lazy construction has no workers, starts once, and rolls back a failing factory", () => {
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker);
    const pool = new WorkerPool({ size: 1, lazy: true, workerFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    pool.stream({});
    pool.start();
    expect(factory).toHaveBeenCalledTimes(1);
    pool.dispose();
    expect(() => pool.start()).toThrow("disposed");
    const worker = new FakeWorker();
    let n = 0;
    expect(
      () =>
        new WorkerPool({
          size: 2,
          workerFactory: () => {
            if (n++) throw new Error("factory");
            return worker as unknown as Worker;
          },
        }),
    ).toThrow("factory");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

it("filters unrelated events, handles non-Error abort reasons, and releases disposed pools safely", async () => {
  const { handle, worker } = setup();
  const ctrl = new AbortController();
  const request = handle.request({ job: "a" }, { signal: ctrl.signal });
  worker.reply({ hostId: "different" });
  worker.reply({ hostId: handle.hostId, __fluxionStream: true });
  worker.dispatchEvent(new MessageEvent("message", { data: null }));
  const rejected = expect(request).rejects.toThrow("Aborted");
  ctrl.abort("cancelled");
  await rejected;
  const pool = new WorkerPool({
    size: 1,
    workerFactory: () => new FakeWorker() as unknown as Worker,
  });
  pool._release(0);
  pool._release(10);
  pool.dispose();
  pool._release(0);
  handle.dispose();
});
it("maintains mixed stream/error subscriptions and idempotent unsubscribe after dispose", () => {
  const { handle, worker } = setup();
  const receive = vi.fn();
  const offError1 = handle.onError(receive),
    offError2 = handle.onError(receive);
  const offStream1 = handle.onStream(receive),
    offStream2 = handle.onStream(receive);
  offError1();
  offStream1();
  worker.reply({ hostId: handle.hostId, __fluxionError: true, message: "error" });
  worker.reply({ hostId: handle.hostId, __fluxionStream: true, value: 1 });
  expect(receive).toHaveBeenCalledTimes(2);
  offError2();
  offStream2();
  const off = handle.onStream(receive);
  handle.dispose();
  off();
  offError1();
});
