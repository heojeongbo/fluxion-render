import type { VideoFrameInfo } from "../../../entities/video-channel/video-channel";
import type { VideoChunkReader } from "../../../shared/model/storage";
import type { ReplayPlayerFrame } from "../../player/model/replay-player";
import type { TimelineIndex } from "../../timeline/model/timeline-index";

export interface VideoDecoderConfig {
  codec: string;
}

export interface VideoReplayerOptions {
  store: VideoChunkReader;
  channelId: string;
  outputCanvas: HTMLCanvasElement | OffscreenCanvas;
  decoderConfig?: VideoDecoderConfig;
}

const DEFAULT_CODEC = "vp8";

export class VideoReplayer {
  private _generation = 0;
  private _disposed = false;
  private _queue: Promise<void> = Promise.resolve();

  /** Wait for queued reads/decode submissions (does not wait for video presentation). */
  flush(): Promise<void> {
    return this._queue;
  }

  private readonly _store: VideoChunkReader;
  private readonly _channelId: string;
  private readonly _canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly _codec: string;
  private _decoder: VideoDecoder | null = null;
  private _lastFrame: VideoFrame | null = null;

  constructor(opts: VideoReplayerOptions) {
    this._store = opts.store;
    this._channelId = opts.channelId;
    this._canvas = opts.outputCanvas;
    this._codec = opts.decoderConfig?.codec ?? DEFAULT_CODEC;
  }

  /** Feed a single frame from the ReplayPlayer onFrame event. */
  feedFrame(frame: ReplayPlayerFrame): void {
    if (this._disposed || typeof VideoDecoder === "undefined") return;
    if (frame.channelId !== this._channelId) return;

    const info = frame.data as VideoFrameInfo;
    const generation = this._generation;
    this._queue = this._queue
      .then(async () => {
        if (generation === this._generation)
          await this._decodeChunk(info, info.isKeyframe, frame.t);
      })
      .catch((error) => {
        if (generation === this._generation) {
          this._resetDecoder();
          console.error("[VideoReplayer] decode failed", error);
        }
      });
  }

  /** Seek to a specific time, re-decoding from the last keyframe. */
  async seekTo(
    t: number,
    keyframeIndex: TimelineIndex,
    allFrames: ReplayPlayerFrame[],
  ): Promise<void> {
    if (this._disposed || typeof VideoDecoder === "undefined") return;

    const keyframeT = keyframeIndex.floor(t);
    if (keyframeT === null) return;

    this._resetDecoder();

    const framesToDecode = allFrames.filter(
      (f) => f.channelId === this._channelId && f.t >= keyframeT && f.t <= t,
    );

    const generation = this._generation;
    this._queue = this._queue.then(async () => {
      for (const f of framesToDecode) {
        if (generation !== this._generation) return;
        const info = f.data as VideoFrameInfo;
        await this._decodeChunk(info, info.isKeyframe, f.t);
      }
    });
    await this._queue;
  }

  dispose(): void {
    this._disposed = true;
    this._generation++;
    this._queue = Promise.resolve();
    this._lastFrame?.close();
    this._lastFrame = null;
    this._decoder?.close();
    this._decoder = null;
  }

  private _resetDecoder(): void {
    this._generation++;
    this._queue = Promise.resolve();
    if (this._decoder) {
      try {
        this._decoder.close();
      } catch {
        /* already closed */
      }
      this._decoder = null;
    }
    this._lastFrame?.close();
    this._lastFrame = null;
  }

  private _setupDecoder(): void {
    if (this._disposed || typeof VideoDecoder === "undefined") return;

    const generation = this._generation;
    this._decoder = new VideoDecoder({
      output: (frame) => {
        if (generation !== this._generation) {
          frame.close();
          return;
        }
        this._lastFrame?.close();
        this._lastFrame = frame;
        this._renderFrame(frame);
      },
      error: (e) => {
        console.error("[VideoReplayer] VideoDecoder error:", e);
      },
    });
    // configure is deferred to first keyframe — dimensions come from VideoFrameInfo
  }

  private async _decodeChunk(
    info: VideoFrameInfo,
    isKeyframe: boolean,
    t = 0,
  ): Promise<void> {
    if (!this._decoder) this._setupDecoder();
    if (!this._decoder) return;

    // Decoder must be configured before any chunk. Configure on first keyframe using
    // the actual encoded dimensions stored in VideoFrameInfo — this avoids the
    // hardcoded-resolution mismatch that corrupts VP8 decode on Retina displays.
    if (this._decoder.state === "unconfigured") {
      if (!isKeyframe) return;
      this._canvas.width = info.codedWidth;
      this._canvas.height = info.codedHeight;
      this._decoder.configure({
        codec: this._codec,
        codedWidth: info.codedWidth,
        codedHeight: info.codedHeight,
      });
    }

    const channelId = this._channelId;
    const filename = info.opfsPath.slice(info.opfsPath.lastIndexOf("/") + 1);
    const generation = this._generation;
    const decoder = this._decoder;
    const data = await this._store.readVideoChunk(channelId, filename);
    if (!data) return;

    // Re-check after async gap — decoder may have been closed/disposed
    if (
      generation !== this._generation ||
      this._decoder !== decoder ||
      decoder.state !== "configured"
    )
      return;

    const chunk = new EncodedVideoChunk({
      type: isKeyframe ? "key" : "delta",
      timestamp: Math.round(t * 1000),
      data: data as Uint8Array<ArrayBuffer>,
    });

    decoder.decode(chunk);
  }

  private _renderFrame(frame: VideoFrame): void {
    const ctx = this._canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return;
    // Don't close here — ownership stays with `_lastFrame`, which the `output`
    // callback closes when the next frame arrives (and `_resetDecoder`/`dispose`
    // close on teardown). Closing here too would double-close every frame.
    ctx.drawImage(
      frame as unknown as CanvasImageSource,
      0,
      0,
      this._canvas.width,
      this._canvas.height,
    );
  }
}
