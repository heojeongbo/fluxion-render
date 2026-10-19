import { useCallback, useEffect, useState } from "react";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import type { RecordingSegment } from "../../../features/store/model/replay-store";
import { poll } from "../../../shared/lib/poll";
import type { ReplayStorage } from "../../../shared/model/storage";

export type { RecordingSegment };

export interface UseLiveTimeRangeOptions {
  /** How often to poll for the latest time range in milliseconds. Default: 500. */
  intervalMs?: number;
}

export interface UseLiveTimeRangeResult {
  timeRange: { earliest: number; latest: number } | null;
  /** Recording segments — each entry is a start/end pair; end=null means currently recording. */
  segments: RecordingSegment[];
  /** Call this to immediately seed the timeRange without waiting for the next poll. */
  seed: (range: { earliest: number; latest: number }) => void;
}

/**
 * Polls `session.getTimeRange()` on a fixed interval and returns the latest
 * known time range. Useful for keeping a live scrubber in sync while recording.
 *
 * @example
 * const { timeRange, segments, seed } = useLiveTimeRange(session);
 * // On recording start, seed immediately so the scrubber is enabled at once:
 * const now = Date.now();
 * seed({ earliest: now, latest: now });
 */
export function useLiveTimeRange(
  session: ReplaySession<ReplayStorage> | null,
  options?: UseLiveTimeRangeOptions,
): UseLiveTimeRangeResult {
  const intervalMs = options?.intervalMs ?? 500;
  const [timeRange, setTimeRange] = useState<{ earliest: number; latest: number } | null>(
    null,
  );
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  useEffect(() => {
    setTimeRange(null);
    setSegments([]);
    if (!session) return;
    return poll(
      () => session.getTimeRange(),
      (range) => {
        if (range) setTimeRange(range);
        setSegments([...session.store.getSegments()]);
      },
      intervalMs,
    );
  }, [session, intervalMs]);

  // MUST be stable across re-renders. Consumers (e.g. chart-replay's
  // auto-record effect) put `seed` in useEffect deps — an unstable identity
  // would re-fire that effect every render, which in production was wiping
  // the store on every paint and pinning the scrubber to seed(now, now).
  const seed = useCallback(
    (range: { earliest: number; latest: number }) => setTimeRange(range),
    [],
  );

  return { timeRange, segments, seed };
}
