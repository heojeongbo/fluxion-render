import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  defineWorker,
  defineWorkerWithState,
} from "./features/define-worker/define-worker";
import { useWorkerRequest } from "./features/react-hooks/use-worker-request";
import { WorkerHandle } from "./features/worker-pool/model/worker-pool";

function bridge() {
  const listeners = new Set<EventListener>();
  const side = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(data: unknown) {
      for (const l of [...listeners]) l({ data } as unknown as Event);
    },
  };
  vi.stubGlobal("self", side);
  const worker = {
    postMessage(data: unknown) {
      side.onmessage!({ data } as MessageEvent);
    },
    addEventListener(_t: string, l: EventListener) {
      listeners.add(l);
    },
    removeEventListener(_t: string, l: EventListener) {
      listeners.delete(l);
    },
    terminate() {},
  };
  return { side, worker: worker as unknown as Worker };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("AUDIT-W1: an unrelated stream failure must not reject the active RPC", async () => {
  const b = bridge();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  defineWorker<{ op: string }, { ok: boolean }>(
    async (_msg, reply) => {
      await gate;
      reply({ ok: true });
    },
    () => {
      throw new Error("stream-only error");
    },
  );
  const h = new WorkerHandle<{ op: string }>(() => b.worker);
  const pending = h.request<{ ok: boolean }>({ op: "rpc" }).then(
    (v) => ({ value: v }),
    (e) => ({ error: e.message }),
  );
  h.emit({ op: "stream" });
  release();
  const result = await pending;
  h.dispose();
  expect(result).toEqual({ value: { ok: true } });
});
it("AUDIT-W2: a caller AbortSignal must cancel a hook request", async () => {
  const b = bridge();
  defineWorker(() => {});
  const h = new WorkerHandle<{ op: string }>(() => b.worker);
  const ctrl = new AbortController();
  let passed: AbortSignal | undefined;
  const request = vi.spyOn(h, "request");
  request.mockImplementation((_m, opts) => {
    passed = opts?.signal;
    return new Promise(() => {});
  });
  const msg = { op: "rpc" };
  const view = renderHook(() => useWorkerRequest(h, msg, { signal: ctrl.signal }));
  act(() => ctrl.abort());
  const aborted = passed!.aborted;
  view.unmount();
  h.dispose();
  expect(aborted).toBe(true);
});
it("AUDIT-W3: a later message for a host reaches the handler while an async one is pending", async () => {
  const b = bridge();
  let release!: () => void;
  const order: string[] = [];
  defineWorkerWithState<{ op: string }, { value: number }, number>(
    async (msg, reply, ctx) => {
      order.push(`${msg.op}@${ctx.state ?? 0}`);
      if (msg.op === "run") {
        await new Promise<void>((r) => {
          release = r;
        });
        order.push("run settled");
        return (ctx.state ?? 0) + 1;
      }
      reply({ value: ctx.state ?? 0 });
    },
  );
  b.side.onmessage!({ data: { hostId: "same", op: "run" } } as MessageEvent);
  // A cancel/steer message must not wait for the job it is meant to stop.
  b.side.onmessage!({ data: { hostId: "same", op: "cancel" } } as MessageEvent);
  expect(order).toEqual(["run@0", "cancel@0"]);
  release();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  b.side.onmessage!({ data: { hostId: "same", op: "read" } } as MessageEvent);
  expect(order).toEqual(["run@0", "cancel@0", "run settled", "read@1"]);
});

it("reports an already-aborted request without posting work", async () => {
  const b = bridge();
  const h = new WorkerHandle<{ op: string }>(() => b.worker);
  const post = vi.spyOn(b.worker, "postMessage");
  const ctrl = new AbortController();
  ctrl.abort(new Error("cancelled by caller"));
  const msg = { op: "rpc" };
  const view = renderHook(() => useWorkerRequest(h, msg, { signal: ctrl.signal }));
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  expect(view.result.current.error?.message).toBe("cancelled by caller");
  expect(view.result.current.loading).toBe(false);
  expect(post).not.toHaveBeenCalled();
  h.dispose();
});
it("ignores a late success from a non-cooperative request after cleanup", async () => {
  const b = bridge();
  const h = new WorkerHandle<{ op: string }>(() => b.worker);
  // Non-cooperative: ignores the abort signal and settles whenever it likes.
  const replies: ((v: object) => void)[] = [];
  vi.spyOn(h, "request").mockImplementation(
    () =>
      new Promise((r) => {
        replies.push(r);
      }),
  );
  const view = renderHook(({ msg }) => useWorkerRequest(h, msg), {
    initialProps: { msg: { op: "old" } },
  });
  view.rerender({ msg: { op: "new" } });
  await act(async () => {
    replies[1]!({ v: "new" });
  });
  // The superseded request resolving last must not overwrite the newer data.
  await act(async () => {
    replies[0]!({ v: "stale" });
  });
  expect(view.result.current.data).toEqual({ v: "new" });
  expect(view.result.current.loading).toBe(false);
  view.unmount();
  h.dispose();
});
it("routes stream errors only to error subscribers", () => {
  const b = bridge();
  defineWorker(
    () => {},
    () => {
      throw new Error("stream");
    },
  );
  const h = new WorkerHandle<{ op: string }>(() => b.worker);
  const stream = vi.fn(),
    error = vi.fn();
  h.onStream(stream);
  h.onError(error);
  h.emit({ op: "stream" });
  expect(stream).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
  h.dispose();
});
it.each([
  false,
  true,
])("preserves stream routing through the RPC fallback (stateful=%s)", (stateful) => {
  const b = bridge();
  if (stateful)
    defineWorkerWithState<object, { ok: boolean }, number>((_msg, reply) => {
      reply({ ok: true });
      return 1;
    });
  else defineWorker<object, { ok: boolean }>((_msg, reply) => reply({ ok: true }));
  const h = new WorkerHandle<object>(() => b.worker);
  const stream = vi.fn();
  h.onStream(stream);
  h.emit({});
  expect(stream).toHaveBeenCalledWith({ ok: true });
  h.dispose();
});
it("serves a non-echoing worker under StrictMode's abort-and-resend", async () => {
  const b = bridge();
  // A hand-written worker that never echoes __fluxionRequestId, replying async.
  b.side.onmessage = (e: MessageEvent) =>
    queueMicrotask(() => b.side.postMessage({ hostId: e.data.hostId, sum: 6 }));
  const h = new WorkerHandle<{ op: string }>(() => b.worker);
  const msg = { op: "sum" };
  const view = renderHook(
    () => useWorkerRequest<{ op: string }, { sum: number }>(h, msg),
    {
      wrapper: StrictMode,
    },
  );
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.data).toEqual({ sum: 6 });
  view.unmount();
  h.dispose();
});
