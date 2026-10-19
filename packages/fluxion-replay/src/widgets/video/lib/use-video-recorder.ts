import { useEffect, useRef } from "react";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import { VideoRecorder } from "../../../features/video/model/video-recorder";
import type { ReplayStorage } from "../../../shared/model/storage";

export interface UseVideoRecorderOptions {
  /**
   * Channel ID registered as a `VideoChannel` in the session. The encoded
   * video chunks are stored under this ID.
   */
  channelId: string;
  /** Session that owns the store and recorder. `null` while opening. */
  session: ReplaySession<ReplayStorage> | null;
  /**
   * Whether the session is actively recording. The hook starts the
   * `VideoRecorder` on every `false → true` transition and stops it on
   * `true → false`. Typically wired to `useRecordingSession`'s `isRecording`.
   */
  isRecording: boolean;
  /**
   * The video track to encode. Typically obtained from
   * `navigator.mediaDevices.getDisplayMedia()` or `getUserMedia()`.
   * `null` means no track is available yet — the recorder won't start.
   */
  track: MediaStreamTrack | null;
  /** Encoded video width in pixels. Default `1280`. */
  width?: number;
  /** Encoded video height in pixels. Default `720`. */
  height?: number;
  /** Target bitrate in bits/s. Default `2_000_000` (2 Mbps). */
  bitrate?: number;
  /** Frames per second. Default `30`. */
  framerate?: number;
  /**
   * Called when an encoded chunk fails to persist and the frame is dropped
   * (e.g. OPFS storage quota exhausted). Wrap it in `useCallback` — a new
   * identity re-creates the underlying `VideoRecorder`.
   */
  onWriteError?: (error: unknown) => void;
}

/**
 * Manages a `VideoRecorder` lifecycle alongside a recording session. Starts
 * encoding when `isRecording && track != null` and stops on cleanup.
 *
 * @example
 * const { isRecording } = useRecordingSession({ session, enabled: isReady });
 * const track = stream?.getVideoTracks()[0] ?? null;
 *
 * useVideoRecorder({
 *   channelId: "screen",
 *   session,
 *   isRecording,
 *   track,
 * });
 */
export function useVideoRecorder(opts: UseVideoRecorderOptions): void {
  const {
    channelId,
    session,
    isRecording,
    track,
    width = 1280,
    height = 720,
    bitrate = 2_000_000,
    framerate = 30,
    onWriteError,
  } = opts;

  const recorderRef = useRef<VideoRecorder | null>(null);

  useEffect(() => {
    if (!isRecording || !session || !track) return;

    const vr = new VideoRecorder({
      channelId,
      store: session.store,
      recorder: session.recorder,
      width,
      height,
      bitrate,
      framerate,
      onWriteError,
    });
    recorderRef.current = vr;
    void vr.start(track).catch((e) => {
      console.warn(`[useVideoRecorder] VideoRecorder failed to start:`, e);
    });

    return () => {
      vr.stop();
      recorderRef.current = null;
    };
  }, [
    isRecording,
    session,
    track,
    channelId,
    width,
    height,
    bitrate,
    framerate,
    onWriteError,
  ]);
}
