import { useCallback, useRef, useState } from "react";
import type { ReplayPlayer } from "../../../features/player/model/replay-player";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import type { ReplayStorage } from "../../../shared/model/storage";
import type { UseReplayPlayerResult } from "../../replay-timeline/lib/use-replay-player";
import { useReplayPlayer } from "../../replay-timeline/lib/use-replay-player";
import { useReplayScrubber } from "../../replay-timeline/lib/use-replay-scrubber";
import { useScrubberControls } from "../../replay-timeline/lib/use-scrubber-controls";
import { type UseReplayDvrResult, useReplayDvr } from "./use-replay-dvr";

export interface UseDvrControllerOptions {
  /** Session from `useReplaySession`. Stays idle while `null`. */
  session: ReplaySession<ReplayStorage> | null;
  /** `enterReplay` callback from `useReplaySession`. */
  enterReplay: (
    t?: number,
    opts?: { timeRange?: { earliest: number; latest: number } },
  ) => Promise<
    import("../../../features/player/model/replay-player").ReplayPlayer | null
  >;
  /** `exitReplay` callback from `useReplaySession`. */
  exitReplay: () => void;
  /** Live time range — typically `useLiveTimeRange(session).timeRange`. */
  liveTimeRange: { earliest: number; latest: number } | null;
  /** Forwarded to `useReplayDvr`. Default `true`. */
  autoPlay?: boolean;
  /** Forwarded to `useReplayDvr`. Default `true`. */
  autoExitToLive?: boolean;
  /** Initial playback rate. Default `1`. */
  initialRate?: number;
  /** Forwarded to `useScrubberControls`. Default `250`. */
  liveEdgeEpsMs?: number;
  /** Forwarded to `useReplayScrubber` — recording epoch for the bar's left edge. */
  recordingStartMs?: number;
  /** Forwarded to `useReplayScrubber`. */
  minSpanMs?: number;
  /**
   * Forwarded to BOTH `useReplayScrubber` and `useScrubberControls` so the
   * slider's value quantum and the controls' live-edge checks stay in
   * lock-step (default 1000 in both).
   */
  snapMs?: number;
}

/** Scrubber props bundle — spread straight onto `<DvrScrubber {...scrubber} />`. */
export interface DvrScrubberBundle {
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  /** `snapMs ?? 1000` — drives the `<input step>` so increments match snapping. */
  step: number;
  onPointerDown: () => void;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCommit: () => void;
  isLive: boolean;
}

export interface UseDvrControllerResult {
  /** Raw DVR controller — pass `dvr.player` to chart/video hooks, call `dvr.exit()`. */
  dvr: UseReplayDvrResult;
  /** React-mirrored player state (snapped `currentT`, `state`, transport methods). */
  replayPlayer: UseReplayPlayerResult;
  /** `!dvr.isDvr`. */
  isLive: boolean;
  /** `dvr.isDvr`. */
  isDvr: boolean;
  /** `replayPlayer.state === "playing"`. */
  isPlaying: boolean;
  /** Current playback rate. */
  rate: number;
  /** Update the rate (applies immediately while playing). */
  setRate: (r: number) => void;
  /** Props bundle for `<DvrScrubber>`. */
  scrubber: DvrScrubberBundle;
  /** `dvr.effectiveTimeRange` — the visible range (live echo / DVR frozen edge). */
  effectiveTimeRange: { earliest: number; latest: number } | null;
}

/**
 * Bundles the full DVR playback lifecycle — session→DVR→rate→player→scrubber —
 * into one call, replacing the ~30-line hook chain every replay demo wires by
 * hand. Composes the existing hooks (it does not re-implement them) and returns
 * a flat object plus a ready-to-spread `scrubber` bundle for `<DvrScrubber>`.
 *
 * Capture concerns (recording, video, screen share) are intentionally left out —
 * keep using `useRecordingSession`/`useVideoRecorder`/`useDisplayMedia` alongside.
 *
 * @example
 * const ctl = useDvrController({ session, enterReplay, exitReplay, liveTimeRange, autoPlay: false });
 * // ...
 * <DvrScrubber {...ctl.scrubber} />
 * <PlaybackControls
 *   isPlaying={ctl.isPlaying}
 *   rate={ctl.rate}
 *   onRateChange={ctl.setRate}
 *   onPlayPause={() => ctl.isPlaying ? ctl.dvr.player?.pause() : ctl.dvr.player?.play(ctl.rate)}
 *   onExit={ctl.dvr.exit}
 * />
 */
export function useDvrController(opts: UseDvrControllerOptions): UseDvrControllerResult {
  const {
    session,
    enterReplay,
    exitReplay,
    liveTimeRange,
    autoPlay = true,
    autoExitToLive = true,
    initialRate = 1,
    liveEdgeEpsMs,
    recordingStartMs,
    minSpanMs,
    snapMs,
  } = opts;

  const [rate, setRateState] = useState(initialRate);
  const playerRef = useRef<ReplayPlayer | null>(null);
  const dvr = useReplayDvr({
    session,
    enterReplay,
    exitReplay,
    liveTimeRange,
    autoPlay,
    autoExitToLive,
    rate,
  });

  playerRef.current = dvr.player;
  const setRate = useCallback((value: number) => {
    setRateState(value);
    if (playerRef.current?.state === "playing") playerRef.current.play(value);
  }, []);

  const replayPlayer = useReplayPlayer(dvr.player);

  const { scrubT, beginScrub, onScrubChange, commitScrub } = useScrubberControls({
    dvr,
    rate,
    liveEdgeEpsMs,
    snapMs,
  });

  const scrubber = useReplayScrubber({
    effectiveTimeRange: dvr.effectiveTimeRange,
    liveTimeRange,
    isDvr: dvr.isDvr,
    replayPlayerT: replayPlayer.currentT,
    scrubT,
    recordingStartMs,
    minSpanMs,
    snapMs,
  });

  const isLive = !dvr.isDvr;

  return {
    dvr,
    replayPlayer,
    isLive,
    isDvr: dvr.isDvr,
    isPlaying: replayPlayer.state === "playing",
    rate,
    setRate,
    scrubber: {
      min: scrubber.min,
      max: scrubber.max,
      value: scrubber.value,
      disabled: scrubber.disabled,
      // 1000 mirrors DEFAULT_SNAP_MS in useReplayScrubber/useScrubberControls.
      step: snapMs ?? 1000,
      onPointerDown: beginScrub,
      onChange: onScrubChange,
      onCommit: commitScrub,
      isLive,
    },
    effectiveTimeRange: dvr.effectiveTimeRange,
  };
}
