import { useCallback, useEffect, useRef, useState } from "react";

export interface UseDisplayMediaResult {
  /** The active MediaStream, or null when not capturing. */
  stream: MediaStream | null;
  /** Request screen capture. Resolves with the stream or throws on denial. */
  start: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
  /** Stop all tracks and clear the stream. */
  stop: () => void;
}

/**
 * Manages a `getDisplayMedia` screen-capture stream.
 * Automatically stops when the component unmounts.
 *
 * @example
 * const { stream, start, stop } = useDisplayMedia();
 * // Attach to a <video> element:
 * useEffect(() => {
 *   if (videoRef.current && stream) videoRef.current.srcObject = stream;
 * }, [stream]);
 */
export function useDisplayMedia(): UseDisplayMediaResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const removeEnded = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    generation.current++;
    removeEnded.current?.();
    removeEnded.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const start = useCallback(
    async (constraints?: DisplayMediaStreamOptions): Promise<MediaStream> => {
      stop(); // clear any existing stream first
      const gen = generation.current;
      const s = await navigator.mediaDevices.getDisplayMedia(
        constraints ?? {
          video: { frameRate: 30 } as MediaTrackConstraints,
          audio: false,
        },
      );
      if (gen !== generation.current) {
        for (const track of s.getTracks()) track.stop();
        return s; // Preserve the resolved stream contract; stale streams are ended.
      }
      streamRef.current = s;
      setStream(s);
      // Auto-stop when the user ends sharing via browser UI
      const track = s.getVideoTracks()[0];
      track?.addEventListener("ended", stop, { once: true });
      removeEnded.current = () => track?.removeEventListener("ended", stop);
      return s;
    },
    [stop],
  );

  // Cleanup on unmount
  useEffect(
    () => () => {
      stop();
    },
    [stop],
  );

  return { stream, start, stop };
}
