import type { VideoFrameInfo } from "../../../entities/video-channel/video-channel";
import type { VideoChunkWriter } from "../../../shared/model/storage";
import type { ReplayRecorder } from "../../recorder/model/replay-recorder";
import type { ThumbnailStore } from "../../timeline/model/thumbnail-store";

export interface VideoRecorderOptions {
  channelId: string;
  store: VideoChunkWriter;
  recorder: ReplayRecorder;
  thumbnailStore?: ThumbnailStore;
  keyframeIntervalSec?: number;
  codec?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: number;
  /**
   * Invoked when a single encoded chunk fails to persist — e.g. OPFS storage
   * quota is exhausted even after the store's reclaim + retry. The frame is
   * dropped and no metadata is recorded (so the timeline never points at a
   * chunk that was never written); recording continues. Fires once per dropped
   * chunk. Use it to surface a "storage full" indicator in the UI.
   */
  onWriteError?: (error: unknown) => void;
  /** Maximum pending encoded chunks / bytes. Overflow drops until a new keyframe. */
  maxPendingChunks?: number;
  maxPendingBytes?: number;
  /** Maximum frames awaiting encoding. Default 4. */
  maxEncodeQueueSize?: number;
}

const DEFAULT_KEYFRAME_INTERVAL_SEC = 2;
const DEFAULT_CODEC = "vp8";
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;
const DEFAULT_BITRATE = 1_000_000;
const DEFAULT_FRAMERATE = 30;
// Log at most one console.warn per this many consecutive chunk-write failures,
// so a full disk during a 30 fps recording doesn't spam the console. The
// onWriteError callback still fires on every drop; only the warn is throttled.
const WARN_EVERY_N_FAILURES = 30;

export class VideoRecorder {
  /**
   * `true` when the current browser supports both `VideoEncoder` and
   * `MediaStreamTrackProcessor` (required for screen/camera recording).
   * Check this before rendering a record button — Safari returns `false`.
   */
  static readonly isSupported: boolean =
    typeof VideoEncoder !== "undefined" &&
    typeof MediaStreamTrackProcessor !== "undefined";

  private readonly _channelId: string;
  private readonly _store: VideoChunkWriter;
  private readonly _recorder: ReplayRecorder;
  private readonly _thumbnailStore: ThumbnailStore | undefined;
  private readonly _keyframeIntervalSec: number;
  private readonly _config: VideoEncoderConfig & { framerate: number };
  private readonly _onWriteError: ((error: unknown) => void) | undefined;
  private _writeFailureCount = 0;
  private _generation = 0;
  private readonly _pending = new Set<Promise<void>>();
  private _pendingBytes = 0;
  private _droppedFrames = 0;
  private _needsKeyframe = false;
  private readonly _maxPendingChunks: number;
  private readonly _maxPendingBytes: number;
  private readonly _maxEncodeQueueSize: number;
  private _finalizing: Promise<void> | null = null;
  private _encoder: VideoEncoder | null = null;
  private _processor: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private _frameCount = 0;
  private _running = false;
  private _startWallMs = 0;
  private _startVideoUs = 0;
  private _encodedWidth = 0;
  private _encodedHeight = 0;

  constructor(opts: VideoRecorderOptions) {
    this._maxPendingChunks = opts.maxPendingChunks ?? 60;
    this._maxPendingBytes = opts.maxPendingBytes ?? 16 * 1024 * 1024;
    this._maxEncodeQueueSize = opts.maxEncodeQueueSize ?? 4;
    for (const limit of [
      this._maxPendingChunks,
      this._maxPendingBytes,
      this._maxEncodeQueueSize,
    ]) {
      if (!Number.isFinite(limit) || limit < 1)
        throw new RangeError("Video queue limits must be finite and positive");
    }
    this._channelId = opts.channelId;
    this._store = opts.store;
    this._recorder = opts.recorder;
    this._thumbnailStore = opts.thumbnailStore;
    this._keyframeIntervalSec = opts.keyframeIntervalSec ?? DEFAULT_KEYFRAME_INTERVAL_SEC;
    this._onWriteError = opts.onWriteError;
    this._config = {
      codec: opts.codec ?? DEFAULT_CODEC,
      width: opts.width ?? DEFAULT_WIDTH,
      height: opts.height ?? DEFAULT_HEIGHT,
      bitrate: opts.bitrate ?? DEFAULT_BITRATE,
      framerate: opts.framerate ?? DEFAULT_FRAMERATE,
    };
  }

  get isRunning(): boolean {
    return this._running;
  }

  async start(track: MediaStreamTrack): Promise<void> {
    if (this._finalizing) await this._finalizing;
    if (this._running) return;
    this._generation++;
    this._needsKeyframe = false;

    // Progressive enhancement: WebCodecs may not be available
    if (typeof VideoEncoder === "undefined") {
      console.warn(
        "[VideoRecorder] WebCodecs (VideoEncoder) is not supported in this browser.",
      );
      this._startFallback(track);
      return;
    }

    if (typeof MediaStreamTrackProcessor === "undefined") {
      console.warn(
        "[VideoRecorder] MediaStreamTrackProcessor is not supported. Falling back.",
      );
      this._startFallback(track);
      return;
    }

    this._running = true;
    this._startWallMs = Date.now();
    this._startVideoUs = -1; // set on first frame
    this._setupEncoder();

    const processor = new MediaStreamTrackProcessor({
      track,
    } as MediaStreamTrackProcessorInit);
    const reader = (processor.readable as ReadableStream<VideoFrame>).getReader();
    this._processor = reader;

    void this._readLoop(reader);
  }

  get pressure(): Readonly<{
    pendingChunks: number;
    pendingBytes: number;
    droppedFrames: number;
  }> {
    return {
      pendingChunks: this._pending.size,
      pendingBytes: this._pendingBytes,
      droppedFrames: this._droppedFrames,
    };
  }

  /** Drain the encoder and persist every accepted output before stopping the recorder/session. */
  stopAndFlush(): Promise<void> {
    if (this._finalizing) return this._finalizing;
    this._running = false;
    this._processor?.cancel().catch(() => {});
    this._processor = null;
    const encoder = this._encoder;
    const finish = async () => {
      try {
        if (encoder?.state === "configured") await encoder.flush();
      } finally {
        await Promise.all([...this._pending]);
        this.stop();
      }
    };
    this._finalizing = finish().finally(() => {
      this._finalizing = null;
    });
    return this._finalizing;
  }

  /** Immediate stop. Already accepted writes finish; use stopAndFlush for a lossless encoder drain. */
  stop(): void {
    this._running = false;
    this._processor?.cancel().catch(() => {});
    this._processor = null;
    this._encoder?.close();
    this._encoder = null;
    this._frameCount = 0;
    this._startWallMs = 0;
    this._startVideoUs = 0;
    this._encodedWidth = 0;
    this._encodedHeight = 0;
  }

  private _setupEncoder(): void {
    const generation = this._generation;
    this._encoder = new VideoEncoder({
      output: (chunk, _meta) => {
        if (generation !== this._generation) return;
        if (
          this._pending.size >= this._maxPendingChunks ||
          this._pendingBytes + chunk.byteLength > this._maxPendingBytes ||
          (this._needsKeyframe && chunk.type !== "key")
        ) {
          this._droppedFrames++;
          this._needsKeyframe = true;
          return;
        }
        this._needsKeyframe = false;
        this._pendingBytes += chunk.byteLength;
        const pending = this._onEncodedChunk(chunk)
          .catch((error) => {
            console.error("[VideoRecorder] output failed:", error);
          })
          .finally(() => {
            this._pending.delete(pending);
            this._pendingBytes -= chunk.byteLength;
          });
        this._pending.add(pending);
      },
      error: (e) => {
        console.error("[VideoRecorder] VideoEncoder error:", e);
      },
    });
  }

  private _configureEncoderForFrame(frame: VideoFrame): void {
    // VP8 requires even dimensions
    const w = frame.displayWidth & ~1;
    const h = frame.displayHeight & ~1;
    this._encodedWidth = w;
    this._encodedHeight = h;
    this._encoder!.configure({
      ...this._config,
      width: w,
      height: h,
    });
  }

  private async _readLoop(
    reader: ReadableStreamDefaultReader<VideoFrame>,
  ): Promise<void> {
    const keyframeEvery = Math.round(this._config.framerate * this._keyframeIntervalSec);

    while (this._running) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;

      const frame = result.value;
      if (!this._running || this._processor !== reader) {
        frame.close();
        break;
      }
      if (
        (this._encoder?.encodeQueueSize ?? 0) >= this._maxEncodeQueueSize ||
        this._pending.size >= this._maxPendingChunks ||
        this._pendingBytes >= this._maxPendingBytes
      ) {
        this._droppedFrames++;
        this._needsKeyframe = true;
        frame.close();
        continue;
      }
      if (this._startVideoUs < 0) this._startVideoUs = frame.timestamp;

      try {
        // Configure encoder on first frame using actual frame dimensions
        if (this._frameCount === 0) {
          this._configureEncoderForFrame(frame);
        }

        const isKeyframe = this._needsKeyframe || this._frameCount % keyframeEvery === 0;
        this._encoder?.encode(frame, { keyFrame: isKeyframe });
        this._frameCount++;
      } catch (error) {
        console.error("[VideoRecorder] encode failed:", error);
        this.stop();
        break;
      } finally {
        frame.close();
      }
    }
  }

  private async _onEncodedChunk(chunk: EncodedVideoChunk): Promise<void> {
    const generation = this._generation;
    const codedWidth = this._encodedWidth;
    const codedHeight = this._encodedHeight;
    const isKeyframe = chunk.type === "key";
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const offsetUs = chunk.timestamp - this._startVideoUs;
    const tMs = this._startWallMs + Math.round(offsetUs / 1000);
    const filename = `${tMs}.chunk`;

    try {
      await this._store.writeVideoChunk(this._channelId, filename, data);
    } catch (e) {
      // Persisting failed (typically OPFS quota exhausted even after the store's
      // reclaim + retry). Drop the frame and DO NOT record metadata — otherwise
      // the timeline would reference a chunk that was never written, breaking
      // decode on replay. This runs in a fire-and-forget encoder callback, so
      // swallowing here is what prevents an unhandled rejection.
      this._writeFailureCount++;
      if ((this._writeFailureCount - 1) % WARN_EVERY_N_FAILURES === 0) {
        console.warn(
          `[VideoRecorder] video-write failed; dropping frame` +
            ` (${this._writeFailureCount} dropped so far):`,
          e,
        );
      }
      this._onWriteError?.(e);
      return;
    }

    // Recovered (or never failed): reset the throttle so a later burst warns
    // immediately again.
    this._writeFailureCount = 0;

    const frameInfo: VideoFrameInfo = {
      opfsPath: `video/${this._channelId}/${filename}`,
      isKeyframe,
      durationUs: chunk.duration ?? 0,
      byteLength: data.byteLength,
      codedWidth,
      codedHeight,
    };

    let failure: unknown = null;
    if (generation === this._generation && this._recorder.isRecording) {
      try {
        this._recorder.record(this._channelId, frameInfo, tMs);
        return;
      } catch (error) {
        failure = error;
      }
    }
    // No metadata row will ever reference this file — a newer recording
    // started, the recorder stopped first, or recording the metadata failed
    // (e.g. a full write queue under maxPendingFrames). Remove it instead of
    // leaking it forever.
    await this._store.deleteVideoChunk?.(this._channelId, filename).catch(() => {});
    if (failure !== null) this._onWriteError?.(failure);
  }

  private _startFallback(_track: MediaStreamTrack): void {
    // Degraded mode: no video recording without WebCodecs
    this._running = true;
    console.warn("[VideoRecorder] Running in no-op fallback mode (no frames captured).");
  }
}
