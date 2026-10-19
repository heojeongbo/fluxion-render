import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayPlayer } from "../../../features/player/model/replay-player";
import {
  ReplaySession,
  type ReplaySessionMode,
  type ReplaySessionOptions,
} from "../../../features/session/model/replay-session";
import type { ReplayStore } from "../../../features/store/model/replay-store";
import type { ReplayStorage } from "../../../shared/model/storage";

export interface UseReplaySessionOptions<S extends ReplayStorage = ReplayStore>
  extends ReplaySessionOptions<S> {
  autoOpen?: boolean;
}

export interface UseReplaySessionResult<S extends ReplayStorage = ReplayStore> {
  session: ReplaySession<S> | null;
  isReady: boolean;
  /**
   * Surfaces any error thrown by `session.open()` (IDB quota, OPFS blocked,
   * `SecurityError`, …). `null` while opening is in flight or succeeded.
   * Without this, mount-time failures were swallowed into `console.error`
   * and `isReady` silently stayed `false` — UIs had no signal to render an
   * error state. Read it as the canonical "did initialisation fail?" flag.
   */
  error: Error | null;
  mode: ReplaySessionMode;
  timeRange: { earliest: number; latest: number } | null;
  record: <T>(channelId: string, data: T, t?: number) => void;
  enterReplay: (
    t?: number,
    opts?: { timeRange?: { earliest: number; latest: number } },
  ) => Promise<ReplayPlayer | null>;
  exitReplay: () => void;
}

export function useReplaySession<S extends ReplayStorage = ReplayStore>(
  opts: UseReplaySessionOptions<S>,
): UseReplaySessionResult<S> {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [session, setSession] = useState<ReplaySession<S> | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [mode, setMode] = useState<ReplaySessionMode>("live");
  const [timeRange, setTimeRange] = useState<{ earliest: number; latest: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const { autoOpen = true, ...sessionOpts } = optsRef.current;
    const s = new ReplaySession(sessionOpts);
    setSession(s);
    setError(null);

    if (autoOpen) {
      s.open()
        .then(() => {
          // A StrictMode (or fast unmount) cleanup already disposed this
          // session; its open() resolves to a no-op — don't flip state on the
          // torn-down lifecycle.
          if (!cancelled) setIsReady(true);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
        });
    }

    return () => {
      cancelled = true;
      s.dispose();
      setSession(null);
      setIsReady(false);
      setError(null);
    };
  }, []);

  const record = useCallback(
    <T>(channelId: string, data: T, t?: number) => {
      session?.record(channelId, data, t);
    },
    [session],
  );

  // Bumped by every enterReplay() and exitReplay(). An enterReplay whose
  // captured gen no longer matches after its awaits was superseded — it must
  // not flip `mode` back to "replay" after a newer exit already set "live"
  // (the intermittent "mode says replay while the UI is live" residue).
  const opGenRef = useRef(0);

  const enterReplay = useCallback(
    async (
      t?: number,
      opts?: { timeRange?: { earliest: number; latest: number } },
    ): Promise<ReplayPlayer | null> => {
      if (!session) return null;
      const gen = ++opGenRef.current;
      const player = await session.enterReplay(t, opts);
      // Superseded by a newer enter/exit — yield to it (the session-level
      // gen guard already kept the stale player uninstalled and disposed).
      if (gen !== opGenRef.current) return null;
      setMode("replay");

      const range = await session.getTimeRange();
      if (gen !== opGenRef.current) return player;
      setTimeRange(range);

      return player;
    },
    [session],
  );

  const exitReplay = useCallback(() => {
    opGenRef.current++; // invalidate in-flight enterReplay calls
    session?.exitReplay();
    setMode("live");
  }, [session]);

  return { session, isReady, error, mode, timeRange, record, enterReplay, exitReplay };
}
