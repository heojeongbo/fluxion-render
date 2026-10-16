import { useDisposableResource } from "@heojeongbo/fluxion-worker/react";
import { useRef } from "react";

import {
  createHostRecyclePool,
  type HostRecyclePool,
  type HostRecyclePoolOptions,
} from "../../../features/host";

/**
 * Creates a {@link HostRecyclePool} that lives for the lifetime of the
 * component and is disposed (tearing down every warm host) on unmount. Pass it
 * to each `<FluxionCanvas recyclePool={pool} />` whose mounts/unmounts you want
 * recycled instead of re-created — the big CPU win for virtualized lists,
 * accordions, and grids that remount.
 *
 * Disposal is deferred one microtask so StrictMode effect replay keeps a live pool. Charts sharing a recycle pool must use compatible host options
 * (same worker pool, axis-canvas presence, etc.) — see `keyFor`; mismatches
 * simply fall back to a cold create.
 *
 * @example
 * const recyclePool = useHostRecyclePool({ max: 16 });
 * <FluxionCanvas recyclePool={recyclePool} hostOptions={{ pool }} ... />
 */
export function useHostRecyclePool(opts: HostRecyclePoolOptions = {}): HostRecyclePool {
  const optsRef = useRef(opts);
  return useDisposableResource(() => createHostRecyclePool(optsRef.current));
}
