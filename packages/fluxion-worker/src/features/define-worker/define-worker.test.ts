import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerErrorMsg } from "./define-worker";
import { defineWorker, defineWorkerWithState } from "./define-worker";

// ─── Self mock ───────────────────────────────────────────────────────────────

interface SelfMock {
  onmessage: ((evt: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  emit: (data: unknown) => void;
}

function makeSelfMock(): SelfMock {
  const mock: SelfMock = {
    onmessage: null,
    postMessage: vi.fn(),
    emit(data: unknown) {
      mock.onmessage?.({ data } as MessageEvent);
    },
  };
  return mock;
}

let selfMock: SelfMock;

beforeEach(() => {
  selfMock = makeSelfMock();
  // defineWorker uses `self as unknown as Worker`
  (globalThis as unknown as { self: unknown }).self = selfMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("defineWorker", () => {
  it("registers onmessage on self", () => {
    defineWorker(() => {});
    expect(selfMock.onmessage).toBeTypeOf("function");
  });

  it("passes the full message to the handler", () => {
    const handler = vi.fn();
    defineWorker(handler);
    selfMock.emit({ op: "sum", hostId: "host-1", values: [1, 2, 3] });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatchObject({ op: "sum", hostId: "host-1" });
  });

  it("echoes hostId onto every reply", () => {
    defineWorker((_msg, reply) => {
      reply({ result: 42 });
    });
    selfMock.emit({ op: "sum", hostId: "host-1" });
    expect(selfMock.postMessage).toHaveBeenCalledOnce();
    expect(selfMock.postMessage.mock.calls[0]![0]).toMatchObject({
      result: 42,
      hostId: "host-1",
    });
  });

  it("omits hostId from reply when message has no hostId", () => {
    defineWorker((_msg, reply) => {
      reply({ result: 7 });
    });
    selfMock.emit({ op: "sum" });
    const [call] = selfMock.postMessage.mock.calls;
    expect(call![0]).toEqual({ result: 7 });
    expect((call![0] as Record<string, unknown>).hostId).toBeUndefined();
  });

  it("supports multiple replies per message (streaming)", () => {
    defineWorker((_msg, reply) => {
      reply({ chunk: 1 });
      reply({ chunk: 2 });
      reply({ chunk: 3 });
    });
    selfMock.emit({ hostId: "host-1" });
    expect(selfMock.postMessage).toHaveBeenCalledTimes(3);
    for (const call of selfMock.postMessage.mock.calls) {
      expect((call[0] as Record<string, unknown>).hostId).toBe("host-1");
    }
  });

  it("forwards transfer array when provided", () => {
    const buf = new ArrayBuffer(8);
    defineWorker((_msg, reply) => {
      reply({ buffer: buf }, [buf]);
    });
    selfMock.emit({ hostId: "host-1" });
    const [call] = selfMock.postMessage.mock.calls;
    expect(call![1]).toEqual([buf]);
  });

  it("does not pass transfer arg when transfer array is empty", () => {
    defineWorker((_msg, reply) => {
      reply({ result: 1 }, []);
    });
    selfMock.emit({ hostId: "host-1" });
    const [call] = selfMock.postMessage.mock.calls;
    expect(call![1]).toBeUndefined();
  });

  it("does not pass transfer arg when transfer is omitted", () => {
    defineWorker((_msg, reply) => {
      reply({ result: 1 });
    });
    selfMock.emit({ hostId: "host-1" });
    const [call] = selfMock.postMessage.mock.calls;
    expect(call![1]).toBeUndefined();
  });

  it("handles async handlers", async () => {
    defineWorker(async (_msg, reply) => {
      await Promise.resolve();
      reply({ result: 99 });
    });
    selfMock.emit({ hostId: "host-async" });
    // flush microtasks
    await Promise.resolve();
    expect(selfMock.postMessage).toHaveBeenCalledOnce();
    expect(selfMock.postMessage.mock.calls[0]![0]).toMatchObject({
      result: 99,
      hostId: "host-async",
    });
  });

  it("overwrites onmessage on repeated defineWorker calls", () => {
    const first = vi.fn();
    const second = vi.fn();
    defineWorker(first);
    defineWorker(second);
    selfMock.emit({ hostId: "h" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("posts WorkerErrorMsg when synchronous handler throws", () => {
    defineWorker(() => {
      throw new Error("sync boom");
    });
    selfMock.emit({ hostId: "host-1" });
    expect(selfMock.postMessage).toHaveBeenCalledOnce();
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.__fluxionError).toBe(true);
    expect(err.message).toBe("sync boom");
    expect(err.hostId).toBe("host-1");
    expect(typeof err.stack).toBe("string");
  });

  it("posts WorkerErrorMsg when async handler rejects", async () => {
    defineWorker(async () => {
      throw new Error("async boom");
    });
    selfMock.emit({ hostId: "host-2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(selfMock.postMessage).toHaveBeenCalledOnce();
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.__fluxionError).toBe(true);
    expect(err.message).toBe("async boom");
    expect(err.hostId).toBe("host-2");
  });

  it("includes hostId in error when message has hostId", () => {
    defineWorker(() => {
      throw new Error("err");
    });
    selfMock.emit({ hostId: "h-x" });
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.hostId).toBe("h-x");
  });

  it("omits hostId in error when message has no hostId", () => {
    defineWorker(() => {
      throw new Error("err");
    });
    selfMock.emit({});
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.hostId).toBeUndefined();
  });

  it("stringifies non-Error throws", () => {
    defineWorker(() => {
      throw "string error";
    });
    selfMock.emit({ hostId: "h" });
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.message).toBe("string error");
    expect(err.stack).toBeUndefined();
  });
});

// ─── defineWorkerWithState ───────────────────────────────────────────────────

describe("defineWorkerWithState", () => {
  it("state is undefined on first call", () => {
    const handler = vi.fn().mockReturnValue(undefined);
    defineWorkerWithState(handler);
    selfMock.emit({ hostId: "h1" });
    expect(handler.mock.calls[0]![2]).toMatchObject({ hostId: "h1", state: undefined });
  });

  it("updated state is passed to next call for same hostId", () => {
    defineWorkerWithState((_msg, _reply, { state }) => {
      return { count: (state as { count: number } | undefined)?.count ?? 0 + 1 };
    });
    selfMock.emit({ hostId: "h1" });
    selfMock.emit({ hostId: "h1" });
    // second call should see state from first call
    const secondCtx = (selfMock as unknown as { onmessage: null }).onmessage;
    expect(secondCtx).toBeDefined(); // handler is registered

    // Re-verify by tracking calls directly
    const calls: Array<{ count: number } | undefined> = [];
    defineWorkerWithState<object, object, { count: number }>(
      (_msg, _reply, { state }) => {
        calls.push(state);
        return { count: (state?.count ?? 0) + 1 };
      },
    );
    selfMock.emit({ hostId: "h2" });
    selfMock.emit({ hostId: "h2" });
    selfMock.emit({ hostId: "h2" });
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toEqual({ count: 1 });
    expect(calls[2]).toEqual({ count: 2 });
  });

  it("state is independent per hostId", () => {
    const states: Array<unknown> = [];
    defineWorkerWithState<object, object, number>((_msg, _reply, { hostId, state }) => {
      states.push({ hostId, state });
      return (state ?? 0) + 1;
    });
    selfMock.emit({ hostId: "h1" });
    selfMock.emit({ hostId: "h2" });
    selfMock.emit({ hostId: "h1" });
    expect(states[0]).toEqual({ hostId: "h1", state: undefined });
    expect(states[1]).toEqual({ hostId: "h2", state: undefined });
    expect(states[2]).toEqual({ hostId: "h1", state: 1 });
  });

  it("null return deletes the state for this host", () => {
    const states: Array<unknown> = [];
    defineWorkerWithState<object, object, number>((_msg, _reply, { state }) => {
      states.push(state);
      return state === undefined ? 99 : null;
    });
    selfMock.emit({ hostId: "h1" });
    selfMock.emit({ hostId: "h1" });
    selfMock.emit({ hostId: "h1" });
    expect(states[0]).toBeUndefined();
    expect(states[1]).toBe(99);
    expect(states[2]).toBeUndefined(); // deleted by null, reset
  });

  it("void return leaves state unchanged", () => {
    const states: Array<unknown> = [];
    defineWorkerWithState<object, object, number>((_msg, _reply, { state }) => {
      states.push(state);
      if (state === undefined) return 10;
      // return void — state stays
    });
    selfMock.emit({ hostId: "h1" });
    selfMock.emit({ hostId: "h1" });
    selfMock.emit({ hostId: "h1" });
    expect(states[0]).toBeUndefined();
    expect(states[1]).toBe(10);
    expect(states[2]).toBe(10); // unchanged
  });

  it("solo mode: no hostId uses __solo__ key", () => {
    const states: Array<unknown> = [];
    defineWorkerWithState<object, object, number>((_msg, _reply, { hostId, state }) => {
      states.push({ hostId, state });
      return (state ?? 0) + 1;
    });
    selfMock.emit({});
    selfMock.emit({});
    expect(states[0]).toEqual({ hostId: "__solo__", state: undefined });
    expect(states[1]).toEqual({ hostId: "__solo__", state: 1 });
  });

  it("async handler: state is updated after promise resolves", async () => {
    const states: Array<unknown> = [];
    defineWorkerWithState<object, object, number>(async (_msg, _reply, { state }) => {
      states.push(state);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      return (state ?? 0) + 1;
    });
    selfMock.emit({ hostId: "h1" });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    selfMock.emit({ hostId: "h1" });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(states[0]).toBeUndefined();
    expect(states[1]).toBe(1);
  });

  it("posts WorkerErrorMsg when handler throws synchronously", () => {
    defineWorkerWithState(() => {
      throw new Error("state boom");
    });
    selfMock.emit({ hostId: "h1" });
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.__fluxionError).toBe(true);
    expect(err.message).toBe("state boom");
  });

  it("posts WorkerErrorMsg when async handler rejects", async () => {
    defineWorkerWithState(async () => {
      throw new Error("async state boom");
    });
    selfMock.emit({ hostId: "h1" });
    await Promise.resolve();
    await Promise.resolve();
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.__fluxionError).toBe(true);
    expect(err.message).toBe("async state boom");
  });

  it("forwards transfer array in reply when provided", () => {
    const buf = new ArrayBuffer(8);
    defineWorkerWithState((_msg, reply) => {
      reply({ buffer: buf }, [buf]);
    });
    selfMock.emit({ hostId: "host-1" });
    const [call] = selfMock.postMessage.mock.calls;
    expect(call![1]).toEqual([buf]);
  });

  it("posts reply without transfer when none provided (covers else branch)", () => {
    defineWorkerWithState((_msg, reply) => {
      reply({ result: 42 });
    });
    selfMock.emit({ hostId: "host-1" });
    const [call] = selfMock.postMessage.mock.calls;
    expect((call![0] as Record<string, unknown>).result).toBe(42);
    expect(call![1]).toBeUndefined();
  });
});

// ─── Stream mode ─────────────────────────────────────────────────────────────

describe("defineWorker — stream mode", () => {
  it("routes mode=stream message to streamHandler, not rpcHandler", () => {
    const rpc = vi.fn();
    const stream = vi.fn();
    defineWorker(rpc, stream);
    selfMock.emit({ hostId: "host-1", mode: "stream", value: 42 });
    expect(stream).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("routes mode=rpc message to rpcHandler", () => {
    const rpc = vi.fn();
    const stream = vi.fn();
    defineWorker(rpc, stream);
    selfMock.emit({ hostId: "host-1", mode: "rpc", value: 1 });
    expect(rpc).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
  });

  it("routes message with no mode to rpcHandler (backward compat)", () => {
    const rpc = vi.fn();
    const stream = vi.fn();
    defineWorker(rpc, stream);
    selfMock.emit({ hostId: "host-1", value: 99 });
    expect(rpc).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
  });

  it("push() stamps __fluxionStream: true and echoes hostId", () => {
    defineWorker(vi.fn(), (_msg, push) => {
      push({ parsed: 7 });
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    expect(selfMock.postMessage).toHaveBeenCalledOnce();
    const out = selfMock.postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(out.__fluxionStream).toBe(true);
    expect(out.hostId).toBe("host-1");
    expect(out.parsed).toBe(7);
  });

  it("push() forwards transferables", () => {
    const buf = new ArrayBuffer(4);
    defineWorker(vi.fn(), (_msg, push) => {
      push({ buf }, [buf]);
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    const call = selfMock.postMessage.mock.calls[0]!;
    expect(call[1]).toEqual([buf]);
  });

  it("push() omits hostId when the stream message has none", () => {
    defineWorker(vi.fn(), (_msg, push) => {
      push({ parsed: 3 });
    });
    selfMock.emit({ mode: "stream" }); // no hostId
    const out = selfMock.postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(out.__fluxionStream).toBe(true);
    expect(out.parsed).toBe(3);
    expect("hostId" in out).toBe(false);
  });

  it("falls back to rpcHandler when no streamHandler and mode=stream", () => {
    const rpc = vi.fn();
    defineWorker(rpc);
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("catches stream handler errors and posts error message", async () => {
    defineWorker(vi.fn(), () => {
      throw new Error("stream boom");
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    const call = selfMock.postMessage.mock.calls[0]!;
    const out = call[0] as Record<string, unknown>;
    expect(out.__fluxionError).toBe(true);
    expect(out.message).toBe("stream boom");
  });

  it("push() forwards transferables in defineWorker stream handler", () => {
    const buf = new ArrayBuffer(4);
    defineWorker(vi.fn(), (_msg, push) => {
      push({ buf }, [buf]);
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    const call = selfMock.postMessage.mock.calls[0]!;
    expect(call[1]).toEqual([buf]);
  });

  it("catches async stream handler rejection in defineWorker", async () => {
    defineWorker(vi.fn(), async () => {
      throw new Error("async stream boom");
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    await Promise.resolve();
    await Promise.resolve();
    const call = selfMock.postMessage.mock.calls[0]!;
    expect((call[0] as Record<string, unknown>).__fluxionError).toBe(true);
  });
});

describe("defineWorkerWithState — stream mode", () => {
  it("push() forwards transferables", () => {
    const buf = new ArrayBuffer(4);
    defineWorkerWithState(vi.fn(), (_msg, push) => {
      push({ buf }, [buf]);
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    const call = selfMock.postMessage.mock.calls[0]!;
    expect(call[1]).toEqual([buf]);
  });

  it("catches async stream handler rejection", async () => {
    defineWorkerWithState(vi.fn(), async () => {
      throw new Error("async wstate boom");
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    await Promise.resolve();
    await Promise.resolve();
    const call = selfMock.postMessage.mock.calls[0]!;
    expect((call[0] as Record<string, unknown>).__fluxionError).toBe(true);
  });

  it("routes mode=stream to streamHandler and does not update state", () => {
    const rpc = vi.fn().mockReturnValue({ count: 1 });
    const stream = vi.fn();
    defineWorkerWithState(rpc, stream);
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    expect(stream).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("exposes mode in HostContext", () => {
    const ctxCaptures: string[] = [];
    defineWorkerWithState(
      (_msg, _reply, ctx) => {
        ctxCaptures.push(ctx.mode);
      },
      (_msg, _push, ctx) => {
        ctxCaptures.push(ctx.mode);
      },
    );
    selfMock.emit({ hostId: "h1", mode: "rpc" });
    selfMock.emit({ hostId: "h1", mode: "stream" });
    expect(ctxCaptures).toEqual(["rpc", "stream"]);
  });

  it("push() stamps __fluxionStream: true", () => {
    defineWorkerWithState(vi.fn(), (_msg, push) => {
      push({ value: 55 });
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    const out = selfMock.postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(out.__fluxionStream).toBe(true);
    expect(out.value).toBe(55);
    expect(out.hostId).toBe("host-1");
  });

  it("posts WorkerErrorMsg when a synchronous streamHandler throws", () => {
    defineWorkerWithState(vi.fn(), () => {
      throw new Error("stream boom");
    });
    selfMock.emit({ hostId: "host-9", mode: "stream" });
    expect(selfMock.postMessage).toHaveBeenCalledOnce();
    const err = selfMock.postMessage.mock.calls[0]![0] as WorkerErrorMsg;
    expect(err.__fluxionError).toBe(true);
    expect(err.message).toBe("stream boom");
    expect(err.hostId).toBe("host-9");
  });

  it("push() forwards a transfer list when provided", () => {
    const buf = new ArrayBuffer(8);
    defineWorkerWithState(vi.fn(), (_msg, push) => {
      push({ value: 1 }, [buf]);
    });
    selfMock.emit({ hostId: "host-1", mode: "stream" });
    expect(selfMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __fluxionStream: true, value: 1 }),
      [buf],
    );
  });

  it("push() omits hostId on the stream output when the message has none", () => {
    defineWorkerWithState(vi.fn(), (_msg, push) => {
      push({ value: 7 });
    });
    selfMock.emit({ mode: "stream" }); // no hostId
    const out = selfMock.postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(out.__fluxionStream).toBe(true);
    expect(out.value).toBe(7);
    expect("hostId" in out).toBe(false);
  });
});

describe("RPC correlation compatibility", () => {
  it("echoes request tokens for ordinary and stateful workers, including errors", async () => {
    for (const define of [defineWorker, defineWorkerWithState]) {
      define((message, reply) => {
        reply({ ok: true });
        if ((message as { fail?: boolean }).fail) throw new Error("failed");
      });
      selfMock.emit({ hostId: "h", __fluxionRequestId: 12, fail: true });
      expect(selfMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "h", __fluxionRequestId: 12, ok: true }),
      );
      expect(selfMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ __fluxionError: true, __fluxionRequestId: 12 }),
      );
      selfMock.emit({ __fluxionRequestId: 13 });
      expect(selfMock.postMessage).toHaveBeenCalledWith({
        ok: true,
        __fluxionRequestId: 13,
      });
    }
  });
});
