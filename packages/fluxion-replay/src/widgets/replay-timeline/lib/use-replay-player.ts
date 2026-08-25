import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReplayPlayer,
  ReplayPlayerState,
} from "../../../features/player/model/replay-player";

export interface UseReplayPlayerOptions {
  /**
   * Quantum applied to `currentT` before it lands in React state. Default
   * `1000` so a 40-chart page's scrubber thumb advances in discrete 1-Hz
   * ticks (heavy chart traffic was starving rAF-driven updates). Pass `0`
   * to disable snapping — `currentT` then mirrors `player.currentT` at
   * `pollMs` resolution.
   */
  snapMs?: number;
  /**
   * How often the hook polls `player.currentT` to detect a snap-boundary
   * cross. Default `250` ms (~125 ms average detection lag for a 1 Hz
   * snap). Lower values give snappier updates at the cost of more React
   * state writes; higher values lighten React work but lag.
   */
  pollMs?: number;
}

export interface UseReplayPlayerResult {
  player: ReplayPlayer | null;
  state: ReplayPlayerState;
  currentT: number;
  play: (rate?: number) => void;
  pause: () => void;
  stop: () => void;
  seek: (t: number) => void;
}

const DEFAULT_SNAP_MS = 1000;
const DEFAULT_POLL_MS = 250;

function makeSnap(snapMs: number) {
  if (snapMs <= 0) return (t: number) => t;
  return (t: number) => Math.floor(t / snapMs) * snapMs;
}

/**
 * Mirrors a `ReplayPlayer` into React state. The `currentT` returned here
 * is **snapped** to whole-second boundaries by default (see Phase 14/15
 * rationale on cursor snap + interval polling). Both behaviours are
 * customisable via the options object.
 */
export function useReplayPlayer(
  player: ReplayPlayer | null,
  opts?: UseReplayPlayerOptions,
): UseReplayPlayerResult {
  const snapMs = opts?.snapMs ?? DEFAULT_SNAP_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

  const [state, setState] = useState<ReplayPlayerState>("idle");
  const [currentT, setCurrentT] = useState(0);
  // Tracks the most recent SNAPPED currentT so we only fire setCurrentT when
  // the snap boundary actually changes.
  const lastSnappedRef = useRef(0);
  // Read options through a ref so changing snapMs / pollMs at runtime
  // doesn't tear down the player subscription effect.
  const snapRef = useRef(makeSnap(snapMs));
  snapRef.current = makeSnap(snapMs);
  const pollMsRef = useRef(pollMs);
  pollMsRef.current = pollMs;

  useEffect(() => {
    if (!player) {
      setState("idle");
      setCurrentT(0);
      lastSnappedRef.current = 0;
      return;
    }

    setState(player.state);
    const initialSnapped = snapRef.current(player.currentT);
    setCurrentT(initialSnapped);
    lastSnappedRef.current = initialSnapped;

    // Poll the player's clock instead of subscribing to `player.onTick`.
    // The subscription approach worked in isolation but in the chart-replay
    // demo (40 charts × 20 Hz of onFrame work per rAF) the React render
    // queue could starve the scrubber's setCurrentT for seconds, producing
    // a "data flows but cursor is stuck" symptom. Polling decouples cursor
    // updates from rAF scheduling.
    const tickInterval = setInterval(() => {
      const snapped = snapRef.current(player.currentT);
      if (snapped === lastSnappedRef.current) return;
      lastSnappedRef.current = snapped;
      setCurrentT(snapped);
    }, pollMsRef.current);

    const offState = player.onStateChange((s) => setState(s));

    return () => {
      clearInterval(tickInterval);
      offState();
    };
  }, [player]);

  const play = useCallback((rate?: number) => player?.play(rate), [player]);
  const pause = useCallback(() => player?.pause(), [player]);
  const stop = useCallback(() => player?.stop(), [player]);
  const seek = useCallback(
    (t: number) => {
      if (!player) return;
      player.seek(t);
      // Mirror the seek in React state right away so the timeline scrubber
      // moves even while paused. Snap to the same boundary used by tick
      // updates so a subsequent tick doesn't undo it.
      const snapped = snapRef.current(t);
      lastSnappedRef.current = snapped;
      setCurrentT(snapped);
    },
    [player],
  );

  return { player, state, currentT, play, pause, stop, seek };
}
