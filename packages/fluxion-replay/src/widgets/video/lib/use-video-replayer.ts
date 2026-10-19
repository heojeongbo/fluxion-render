import { type RefObject, useEffect, useRef } from "react";
import { VideoChannel } from "../../../entities/video-channel/video-channel";
import type {
  ReplayPlayer,
  ReplayPlayerFrame,
} from "../../../features/player/model/replay-player";
import { TimelineIndex } from "../../../features/timeline/model/timeline-index";
import {
  type VideoDecoderConfig,
  VideoReplayer,
} from "../../../features/video/model/video-replayer";
import type { ReplayStorage as ReplayStore } from "../../../shared/model/storage";

/**
 * Minimum lookback (ms) for the keyframe re-decode window on seek. Must comfortably
 * exceed the recorder's keyframe interval (default 2s) so a keyframe is always
 * present before the seek point — mirrors `ReplayPlayer.seek`'s own 3s rewind.
 */
const DEFAULT_SEEK_LOOKBACK_MS = 3_000;

export interface UseVideoReplayerOptions {
  decoderConfig?: VideoDecoderConfig;
  /**
   * How far back (ms) to scan for a keyframe when seeking. Increase this if your
   * recorder uses a keyframe interval larger than ~2s. Default 3000.
   */
  seekLookbackMs?: number;
  /**
   * Called for every replay frame whose `channelId` is NOT this video channel —
   * so a single `player.onFrame` subscription can fan out to both the video
   * canvas (handled internally) and your own log/metric collectors, without
   * hand-wiring a second listener. Receives frames in arrival order.
   */
  onOtherFrame?: (frame: ReplayPlayerFrame) => void;
}

/**
 * Wires a `VideoReplayer` to a `ReplayPlayer` for the given canvas and channel.
 * Creates a new replayer whenever `player` changes and disposes the old one.
 *
 * On every `seek` (and once on mount), re-decodes from the nearest keyframe via
 * `VideoReplayer.seekTo` so a backward jump never shows garbled VP8 deltas — this
 * works while paused too, where the player's streaming `onFrame` never fires.
 * Live `onFrame` frames keep streaming for forward playback.
 *
 * @example
 * useVideoReplayer(player, canvasRef, store, "screen");
 */
export function useVideoReplayer(
  player: ReplayPlayer | null,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  store: ReplayStore | null,
  channelId: string,
  options?: UseVideoReplayerOptions,
): void {
  const replayerRef = useRef<VideoReplayer | null>(null);
  const lookback = options?.seekLookbackMs ?? DEFAULT_SEEK_LOOKBACK_MS;
  // Ref so a changing callback identity doesn't tear down and rebuild the
  // decoder; the effect reads the latest via the ref.
  const onOtherFrameRef = useRef(options?.onOtherFrame);
  onOtherFrameRef.current = options?.onOtherFrame;

  useEffect(() => {
    replayerRef.current?.dispose();
    replayerRef.current = null;

    if (!player || !canvasRef.current || !store) return;

    const vr = new VideoReplayer({
      channelId,
      store,
      outputCanvas: canvasRef.current,
      decoderConfig: options?.decoderConfig,
    });
    replayerRef.current = vr;

    // Typed channel so the store decodes payloads to VideoFrameInfo up-front.
    const channel = new VideoChannel(channelId);

    let cancelled = false;
    // Sequential seek queue — at most one seekTo (decoder reset + re-decode) runs
    // at a time. Bursts of scrub seeks collapse into `queuedT` (last wins), so a
    // fast drag jumps straight to its final position instead of decoding every
    // intermediate point. Mirrors the proven pattern in useChartReplay.
    let inFlight = false;
    let queuedT: number | null = null;
    // The seek currently being re-decoded. While set, live `onFrame` events are
    // parked in `pending` so a rewound lookback delta can't decode on top of the
    // freshly keyframe-seeded decoder and corrupt it.
    let seekingTo: number | null = null;
    const pending: ReplayPlayerFrame[] = [];

    const flushPending = (cutoff: number) => {
      if (pending.length === 0) return;
      const drained = pending.splice(0, pending.length);
      for (const f of drained) {
        if (f.t <= cutoff) continue; // re-decode already covered this t
        vr.feedFrame(f);
      }
    };

    const runSeek = async (firstT: number): Promise<void> => {
      inFlight = true;
      let t = firstT;
      try {
        while (!cancelled) {
          seekingTo = t;
          pending.length = 0;

          const from = t - lookback;
          try {
            const decoded = await store.getFramesByChannel(channel, from, t);
            if (cancelled) return;

            const keyframeIndex = new TimelineIndex();
            keyframeIndex.insertMany(
              decoded.filter((f) => f.data.isKeyframe).map((f) => f.t),
            );

            // No keyframe in the window — leave the canvas as-is rather than feeding
            // deltas with no reference frame (which is exactly what corrupts).
            if (keyframeIndex.earliest !== null) {
              await vr.seekTo(t, keyframeIndex, decoded);
              if (cancelled) return;
            }
          } catch {
            // Store closed/unavailable or decode failed — skip this seek and leave
            // the canvas as-is rather than crashing the effect. The next seek retries.
          }

          // Replay onFrame events that landed during the await — only those past
          // the seek point, in arrival order.
          flushPending(t);
          seekingTo = null;

          // Jump to the latest queued seek if the user kept scrubbing.
          if (queuedT === null) break;
          t = queuedT;
          queuedT = null;
        }
      } finally {
        inFlight = false;
        seekingTo = null;
      }
    };

    const hydrate = (t: number): void => {
      if (inFlight) {
        queuedT = t; // collapse intermediate seeks; last wins
        return;
      }
      void runSeek(t);
    };

    // Paint a correct, keyframe-aligned frame for the current position on mount —
    // e.g. when replay is entered already paused at a mid-point.
    hydrate(player.currentT);

    const offSeek = player.onSeek((t) => {
      hydrate(t);
    });

    const offFrame = player.onFrame((frame) => {
      if (frame.channelId !== channelId) {
        onOtherFrameRef.current?.(frame);
        return;
      }
      if (seekingTo !== null) {
        // Park until the in-flight seek settles; it decides flush vs. drop.
        pending.push(frame);
        return;
      }
      vr.feedFrame(frame);
    });

    return () => {
      cancelled = true;
      queuedT = null;
      pending.length = 0;
      offSeek();
      offFrame();
      vr.dispose();
      replayerRef.current = null;
    };
    // canvasRef: ref 객체 자체가 아닌 .current 값을 사용하므로 의도적으로 제외 — player 교체 시 effect가 재실행되어 최신 canvas를 반영함
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, channelId, store, lookback]);
}
