import { type DependencyList, useEffect, useRef } from "react";
import type { WorkerHandle } from "../worker-pool/model/worker-pool";

/**
 * Subscribe to stream messages from a worker and emit a new message
 * whenever `handle` or `msg` changes.
 *
 * - Subscribes via `handle.onStream()` **before** calling `handle.emit()` to
 *   avoid missing the first push if the worker replies synchronously.
 * - `onData` is captured by ref — no need to include it in deps.
 * - Unsubscribes on unmount or when deps change.
 *
 * @example
 * ```tsx
 * const handle = useWorkerHandle<RtcPacket>(...);
 * const msg = useMemo(() => ({ channel: "sensors" }), []);
 *
 * useWorkerStream<RtcPacket, ParsedFrame>(handle, msg, (frame) => {
 *   drawToCanvas(frame);
 * });
 * ```
 */
export function useWorkerStream<TMsg extends object, TResult extends object>(
  handle: WorkerHandle<TMsg> | null,
  msg: TMsg,
  onData: (result: Omit<TResult, "hostId" | "__fluxionStream">) => void,
  transfer?: Transferable[],
  deps: DependencyList = [],
): void {
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (!handle || handle.isTerminated) return;

    const off = handle.onStream<TResult>((data) => {
      onDataRef.current(data);
    });

    handle.emit(msg, transfer);

    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, msg, ...deps]);
}
