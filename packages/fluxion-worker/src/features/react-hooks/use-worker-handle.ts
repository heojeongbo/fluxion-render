import { type DependencyList, useEffect, useRef, useState } from "react";
import type { WorkerHandle } from "../worker-pool/model/worker-pool";

/**
 * Creates a `WorkerHandle` that lives for the component lifetime.
 * The handle is created inside a `useEffect`, so the returned value is `null`
 * on the first render — guard with `if (!handle) return`.
 *
 * The `factory` function is captured by ref, so it's safe to pass an inline
 * arrow function without causing the handle to be re-created on every render.
 * Pass `deps` to recreate the handle when specific values change (e.g. worker URL).
 *
 * React StrictMode safe — double-invoke disposes the first handle and creates
 * a fresh one on remount (same lifecycle as `useFluxionCanvas`).
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const handle = useWorkerHandle<CalcMsg>(
 *     () => new WorkerHandle(() => new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" }))
 *   );
 *
 *   const onClick = async () => {
 *     if (!handle) return;
 *     const result = await handle.request<CalcResult>({ op: "sum", values: [1, 2, 3] });
 *     console.log(result.value);
 *   };
 *
 *   return <button onClick={onClick}>Calculate</button>;
 * }
 * ```
 */
export function useWorkerHandle<TMsg extends object>(
  factory: () => WorkerHandle<TMsg>,
  deps: DependencyList = [],
): WorkerHandle<TMsg> | null {
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  const [handle, setHandle] = useState<WorkerHandle<TMsg> | null>(null);

  useEffect(() => {
    const h = factoryRef.current();
    setHandle(h);
    return () => {
      h.dispose();
      setHandle(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return handle;
}
