/** Fixed cadence, one request at a time. Cancellation suppresses stale results. */
export function poll<T>(
  read: () => Promise<T>,
  commit: (value: T) => void,
  intervalMs: number,
): () => void {
  let active = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const value = await read();
      if (active) commit(value);
    } catch {
      // A store can be unavailable during initialization; retry at the next tick.
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return () => {
    active = false;
    clearInterval(timer);
  };
}
