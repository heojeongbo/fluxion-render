/** Distinguishes RPC (request/response) from Stream (fire-and-forget) messages. */
export type FluxionMode = "rpc" | "stream";

/**
 * Inbound message shape: any object that may carry a `hostId` routed by WorkerHandle.
 * The worker script receives this after the main thread stamps hostId onto it.
 * `mode` is set to `"stream"` by `WorkerHandle.emit()` — absent or `"rpc"` means RPC.
 */
export type WorkerMsg<T extends object = object> = T & {
  hostId?: string;
  /** Internal RPC correlation token. Echoed by reply and errors. */
  __fluxionRequestId?: number;
  mode?: FluxionMode;
};

/** Sent automatically by defineWorker when the handler throws or rejects. */
export interface WorkerErrorMsg {
  readonly __fluxionError: true;
  readonly hostId?: string;
  readonly __fluxionRequestId?: number;
  readonly message: string;
  readonly stack?: string;
}

/**
 * `reply` function passed to the handler.
 * Call it once or many times — each call posts a message back to the main thread
 * with `hostId` automatically echoed so WorkerHandle routing works.
 *
 * Optionally pass `transfer` to transfer ownership of Transferable objects
 * (e.g. ArrayBuffer, OffscreenCanvas) without copying.
 */
export type ReplyFn<TResult extends object> = (
  result: TResult,
  transfer?: Transferable[],
) => void;

/**
 * `push` function passed to the stream handler.
 * Fire-and-forget: stamps `__fluxionStream: true` so `WorkerHandle.onStream()`
 * can filter it on the main thread. Call 0 or N times per inbound stream message.
 */
export type PushFn<TResult extends object> = (
  result: TResult,
  transfer?: Transferable[],
) => void;

/**
 * Register a handler for incoming worker messages.
 *
 * - `hostId` is automatically echoed back on every reply so pool/handle routing works.
 * - Call `reply` once for request/response, or multiple times for streaming results.
 * - Return a Promise (or use async) for async handlers — errors are returned to
 *   the caller with the request correlation token.
 *
 * @example — simple request/response
 * ```ts
 * import { defineWorker } from "@heojeongbo/fluxion-worker";
 *
 * defineWorker<{ op: string; values: number[] }, { result: number }>(
 *   ({ op, values }, reply) => {
 *     const result = op === "sum" ? values.reduce((a, b) => a + b, 0) : 0;
 *     reply({ result });
 *   },
 * );
 * ```
 *
 * @example — streaming (multiple replies per message)
 * ```ts
 * defineWorker<{ items: number[] }, { chunk: number[] }>(
 *   ({ items }, reply) => {
 *     for (let i = 0; i < items.length; i += 100) {
 *       reply({ chunk: items.slice(i, i + 100) });
 *     }
 *   },
 * );
 * ```
 *
 * @example — with Transferable
 * ```ts
 * defineWorker<{ size: number }, { buffer: ArrayBuffer }>(
 *   ({ size }, reply) => {
 *     const buffer = new ArrayBuffer(size);
 *     reply({ buffer }, [buffer]);
 *   },
 * );
 * ```
 */
/** Per-host context passed to the defineWorkerWithState handler. */
export interface HostContext<TState> {
  /** The hostId for this message (or "__solo__" in standalone mode). */
  readonly hostId: string;
  /** Current state for this host. Undefined on the first message. */
  readonly state: TState | undefined;
  /** Whether this message arrived via the RPC or Stream path. */
  readonly mode: FluxionMode;
}

const _SOLO_KEY = "__solo__";

function _postError(hostId: string | undefined, e: unknown, requestId?: number): void {
  const err: WorkerErrorMsg = {
    __fluxionError: true,
    ...(requestId === undefined ? {} : { __fluxionRequestId: requestId }),
    hostId,
    message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  };
  (self as unknown as Worker).postMessage(err);
}

/**
 * Like `defineWorker`, but manages per-host state automatically.
 *
 * - Return a new state value to update it for this host.
 * - Return `null` to delete the state for this host.
 * - Return `undefined` (or void) to leave state unchanged.
 * - Works in standalone mode: messages without a `hostId` share a single `"__solo__"` slot.
 *
 * @example
 * ```ts
 * defineWorkerWithState<Msg, Result, MyState>(
 *   (msg, reply, { state }) => {
 *     const s = state ?? { count: 0 };
 *     reply({ count: s.count + 1 });
 *     return { count: s.count + 1 };
 *   },
 * );
 * ```
 */
export function defineWorkerWithState<
  TMsg extends object,
  TResult extends object = object,
  TState = unknown,
  TStreamMsg extends object = TMsg,
  TStreamResult extends object = object,
>(
  rpcHandler: (
    msg: WorkerMsg<TMsg>,
    reply: ReplyFn<TResult>,
    ctx: HostContext<TState>,
  ) => TState | null | void | Promise<TState | null | void>,
  streamHandler?: (
    msg: WorkerMsg<TStreamMsg>,
    push: PushFn<TStreamResult>,
    ctx: HostContext<TState>,
  ) => void | Promise<void>,
): void {
  const stateMap = new Map<string, TState>();

  (self as unknown as Worker).onmessage = (evt: MessageEvent<WorkerMsg<TMsg>>) => {
    const msg = evt.data;
    const hostId = msg.hostId;
    const requestId = msg.__fluxionRequestId;
    const key = hostId ?? _SOLO_KEY;
    const mode: FluxionMode = (msg as { mode?: FluxionMode }).mode ?? "rpc";

    const ctx: HostContext<TState> = { hostId: key, state: stateMap.get(key), mode };

    if (mode === "stream" && streamHandler) {
      const push: PushFn<TStreamResult> = (result, transfer) => {
        const out =
          hostId !== undefined
            ? { ...result, hostId, __fluxionStream: true as const }
            : { ...result, __fluxionStream: true as const };
        if (transfer && transfer.length > 0) {
          (self as unknown as Worker).postMessage(out, transfer);
        } else {
          (self as unknown as Worker).postMessage(out);
        }
      };
      try {
        const result = streamHandler(msg as unknown as WorkerMsg<TStreamMsg>, push, ctx);
        if (result instanceof Promise) {
          result.catch((e) => _postError(hostId, e, requestId));
        }
      } catch (e) {
        _postError(hostId, e, requestId);
      }
      return;
    }

    const reply: ReplyFn<TResult> = (result, transfer) => {
      const out = {
        ...result,
        ...(hostId === undefined ? {} : { hostId }),
        ...(requestId === undefined ? {} : { __fluxionRequestId: requestId }),
      };
      if (transfer && transfer.length > 0) {
        (self as unknown as Worker).postMessage(out, transfer);
      } else {
        /* v8 ignore next */
        (self as unknown as Worker).postMessage(out);
      }
    };

    const applyState = (newState: TState | null | void): void => {
      if (newState === null) {
        stateMap.delete(key);
      } else if (newState !== undefined) {
        stateMap.set(key, newState);
      }
    };

    try {
      const result = rpcHandler(msg, reply, ctx);
      if (result instanceof Promise) {
        result.then(applyState).catch((e) => _postError(hostId, e, requestId));
      } else {
        applyState(result);
      }
    } catch (e) {
      _postError(hostId, e, requestId);
    }
  };
}

export function defineWorker<
  TMsg extends object,
  TResult extends object = object,
  TStreamMsg extends object = TMsg,
  TStreamResult extends object = object,
>(
  rpcHandler: (msg: WorkerMsg<TMsg>, reply: ReplyFn<TResult>) => void | Promise<void>,
  streamHandler?: (
    msg: WorkerMsg<TStreamMsg>,
    push: PushFn<TStreamResult>,
  ) => void | Promise<void>,
): void {
  (self as unknown as Worker).onmessage = (evt: MessageEvent<WorkerMsg<TMsg>>) => {
    const msg = evt.data;
    const hostId = msg.hostId;
    const requestId = msg.__fluxionRequestId;
    const mode: FluxionMode = (msg as { mode?: FluxionMode }).mode ?? "rpc";

    if (mode === "stream" && streamHandler) {
      const push: PushFn<TStreamResult> = (result, transfer) => {
        const out =
          hostId !== undefined
            ? { ...result, hostId, __fluxionStream: true as const }
            : { ...result, __fluxionStream: true as const };
        if (transfer && transfer.length > 0) {
          (self as unknown as Worker).postMessage(out, transfer);
        } else {
          (self as unknown as Worker).postMessage(out);
        }
      };
      try {
        const result = streamHandler(msg as unknown as WorkerMsg<TStreamMsg>, push);
        if (result instanceof Promise) {
          result.catch((e) => _postError(hostId, e, requestId));
        }
      } catch (e) {
        _postError(hostId, e, requestId);
      }
      return;
    }

    const reply: ReplyFn<TResult> = (result, transfer) => {
      const out = {
        ...result,
        ...(hostId === undefined ? {} : { hostId }),
        ...(requestId === undefined ? {} : { __fluxionRequestId: requestId }),
      };
      if (transfer && transfer.length > 0) {
        (self as unknown as Worker).postMessage(out, transfer);
      } else {
        (self as unknown as Worker).postMessage(out);
      }
    };

    try {
      const result = rpcHandler(msg, reply);
      if (result instanceof Promise) {
        result.catch((e) => _postError(hostId, e, requestId));
      }
    } catch (e) {
      _postError(hostId, e, requestId);
    }
  };
}
