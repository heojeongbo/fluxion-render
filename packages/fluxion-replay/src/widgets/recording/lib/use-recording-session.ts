import { useEffect, useRef, useState } from "react";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import type { ReplayStorage } from "../../../shared/model/storage";

export interface RecordingTickerSpec {
  /** Channel id to record into. Must be registered on the session. */
  channelId: string;
  /** Tick period in ms. */
  intervalMs: number;
  /** Called every tick; the returned value is passed straight to
   *  `session.record(channelId, value, wallT)`. */
  produce: (wallT: number) => unknown;
}

export interface UseRecordingSessionOptions {
  /** Session from `useReplaySession`. Recording stays idle while `null`. */
  session: ReplaySession<ReplayStorage> | null;
  /** Set to `false` to suspend recording (e.g. a "pause" toggle in the UI). */
  enabled: boolean;
  /**
   * Wipe the store once per session in this hook (`session.clearRecording()`). Default
   * `true` for "the demo IS the recording" pages; set `false` to keep
   * historical data across remounts.
   */
  clearOnStart?: boolean;
  /**
   * Optional convenience: a list of per-channel tickers. The hook spins
   * up a `setInterval` per spec and stops them on cleanup. Use this for
   * the common "synthesise a sample at N Hz" pattern; for anything more
   * elaborate (random jitter, conditional emission, …) call
   * `session.record()` yourself.
   */
  channels?: readonly RecordingTickerSpec[];
  /**
   * Optional seed for the live time range so a scrubber bar can render
   * immediately without waiting for the first poll. Pass
   * `useLiveTimeRange(session).seed`.
   */
  seedTimeRange?: (range: { earliest: number; latest: number }) => void;
}

export interface UseRecordingSessionResult {
  /** Surfaces `startRecording()` / `clearRecording()` failures. */
  error: Error | null;
  /** `true` from the moment `startRecording()` resolved until cleanup. */
  isRecording: boolean;
}

/**
 * Bundles the recording start/stop dance + optional per-channel tickers
 * the demos write by hand. Shares initialization across StrictMode effects;
 * each active effect owns its recording cycle and cancels obsolete starts.
 *
 * @example
 * useRecordingSession({
 *   session,
 *   enabled: isReady,
 *   seedTimeRange,
 *   channels: [
 *     { channelId: "cpu", intervalMs: 200, produce: () => ({ name: "cpu", value: Math.random() }) },
 *     { channelId: "events", intervalMs: 2000, produce: () => ({ level: "info", message: "tick" }) },
 *   ],
 * });
 */
// Hooks sharing one session keep it recording until the last of them is
// disabled or unmounted. A recording that was already running when the first
// hook joined (the app started it) is never stopped by a hook.
const recordingHolds = new WeakMap<
  object,
  { holders: number; startedByHooks: boolean }
>();

export function useRecordingSession(
  opts: UseRecordingSessionOptions,
): UseRecordingSessionResult {
  const { session, enabled, clearOnStart = true, channels, seedTimeRange } = opts;
  const [error, setError] = useState<Error | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  // Refs let us read the latest tick produce / seed without re-running
  // the effect, and gate against StrictMode's "mount, cleanup, mount"
  // double-fire.
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const seedRef = useRef(seedTimeRange);
  seedRef.current = seedTimeRange;
  const initialization = useRef<{
    session: ReplaySession<ReplayStorage>;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (!session || !enabled) return;
    if (initialization.current?.session !== session) {
      initialization.current = {
        session,
        promise: clearOnStart ? session.clearRecording() : Promise.resolve(),
      };
    }
    const ready = initialization.current.promise;

    let cancelled = false;
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    let held = false;
    const hold = () => {
      const claim = recordingHolds.get(session) ?? { holders: 0, startedByHooks: false };
      if (claim.holders === 0) claim.startedByHooks = !session.recorder.isRecording;
      claim.holders++;
      recordingHolds.set(session, claim);
      held = true;
    };
    const release = () => {
      if (!held) return;
      held = false;
      const claim = recordingHolds.get(session)!;
      if (--claim.holders === 0 && claim.startedByHooks) session.stopRecording();
    };

    setError(null);

    void (async () => {
      try {
        await ready;
        if (cancelled) return;
        hold();
        await session.startRecording();
        if (cancelled) {
          // Released while the start was pending: a late start may have turned
          // recording back on. Stop it unless another hook now holds the session.
          const claim = recordingHolds.get(session)!;
          if (claim.holders === 0 && claim.startedByHooks) session.stopRecording();
          return;
        }

        if (seedRef.current) {
          const now = Date.now();
          seedRef.current({ earliest: now, latest: now });
        }

        const specs = channelsRef.current ?? [];
        for (const spec of specs) {
          intervalIds.push(
            setInterval(() => {
              const wallT = Date.now();
              const current = channelsRef.current?.find(
                (item) => item.channelId === spec.channelId,
              );
              if (!current) return;
              try {
                session.record(current.channelId, current.produce(wallT), wallT);
              } catch (e) {
                // e.g. a full write queue (maxPendingFrames): drop the sample,
                // surface the first failure instead of throwing every tick.
                setError(
                  (prev) => prev ?? (e instanceof Error ? e : new Error(String(e))),
                );
              }
            }, spec.intervalMs),
          );
        }
        setIsRecording(true);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
          // Allow a retry on next render after a failure.
          initialization.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const id of intervalIds) clearInterval(id);
      setIsRecording(false);
      release();
    };
  }, [session, enabled, clearOnStart]);

  return { error, isRecording };
}
