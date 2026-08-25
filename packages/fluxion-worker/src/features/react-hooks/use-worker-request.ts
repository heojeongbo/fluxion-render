import { useEffect, useRef, useState } from "react";
import type { RequestOptions, WorkerHandle } from "../worker-pool/model/worker-pool";

export interface UseWorkerRequestResult<TResult> {
  /** Last successful response, or `null` before the first response. */
  data: TResult | null;
  /** `true` while a request is in-flight. */
  loading: boolean;
  /** Last error, or `null` if the last request succeeded. */
  error: Error | null;
}

/**
 * Fires `handle.request()` whenever `handle` or `msg` changes, and cancels
 * the in-flight request on cleanup (via `AbortSignal`).
 *
 * **Stability warning**: React compares `msg` by reference (`Object.is`).
 * Passing an inline object literal (`useWorkerRequest(handle, { op: "sum" })`)
 * will re-fire on every render. Stabilize with `useMemo`:
 *
 * ```ts
 * const msg = useMemo(() => ({ op: "sum", values }), [values]);
 * const { data, loading, error } = useWorkerRequest<CalcMsg, CalcResult>(handle, msg);
 * ```
 *
 * `opts` (e.g. `timeoutMs`) is captured by ref — changing it after mount does
 * not re-fire the request.
 *
 * @example
 * ```tsx
 * function Calc({ values }: { values: number[] }) {
 *   const handle = useWorkerHandle<CalcMsg>(
 *     () => new WorkerHandle(() => new Worker(new URL("./calc.ts", import.meta.url), { type: "module" }))
 *   );
 *   const msg = useMemo(() => ({ op: "sum" as const, values }), [values]);
 *   const { data, loading, error } = useWorkerRequest<CalcMsg, CalcResult>(handle, msg);
 *
 *   if (loading) return <span>calculating…</span>;
 *   if (error) return <span>error: {error.message}</span>;
 *   return <span>result: {data?.result}</span>;
 * }
 * ```
 */
export function useWorkerRequest<TMsg extends object, TResult extends object>(
  handle: WorkerHandle<TMsg> | null,
  msg: TMsg,
  opts?: RequestOptions,
): UseWorkerRequestResult<Omit<TResult, "hostId">> {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [data, setData] = useState<Omit<TResult, "hostId"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!handle || handle.isTerminated) return;

    setLoading(true);
    setError(null);

    const ctrl = new AbortController();

    handle
      .request<TResult>(msg, { ...optsRef.current, signal: ctrl.signal })
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((e: unknown) => {
        // Ignore rejections triggered by our own cleanup abort.
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      ctrl.abort();
    };
  }, [handle, msg]); // opts captured by ref — does not trigger re-fire

  return { data, loading, error };
}
