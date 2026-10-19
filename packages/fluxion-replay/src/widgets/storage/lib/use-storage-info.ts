import { useEffect, useState } from "react";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import type { StorageInfo } from "../../../features/store/model/replay-store";
import { poll } from "../../../shared/lib/poll";
import type { ReplayStorage } from "../../../shared/model/storage";

export interface UseStorageInfoOptions {
  /** How often to poll in milliseconds. Default: 5000. */
  intervalMs?: number;
  /**
   * When true, logs storage usage to `console.log` after each successful
   * fetch. Default: false.
   */
  logToConsole?: boolean;
}

/**
 * Periodically fetches storage quota and usage from the session.
 * Returns `null` until the first successful fetch.
 *
 * @example
 * const info = useStorageInfo(session);
 * // info?.percentUsed → 12.4
 * // info?.idbFrameCount → 8320
 */
export function useStorageInfo(
  session: ReplaySession<ReplayStorage> | null,
  options?: UseStorageInfoOptions,
): StorageInfo | null {
  const intervalMs = options?.intervalMs ?? 5_000;
  const logToConsole = options?.logToConsole ?? false;
  const [info, setInfo] = useState<StorageInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!session) return;
    return poll(
      () => session.getStorageInfo(),
      (result) => {
        setInfo(result);
        if (logToConsole) {
          console.log(
            `[useStorageInfo] ${result.percentUsed.toFixed(1)}% used` +
              ` (${(result.usedBytes / 1024 / 1024).toFixed(1)} MB /` +
              ` ${(result.quotaBytes / 1024 / 1024).toFixed(1)} MB),` +
              ` ${result.idbFrameCount} frames`,
          );
        }
      },
      intervalMs,
    );
  }, [session, intervalMs, logToConsole]);

  return info;
}
