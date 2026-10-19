import type { BaseChannel } from "./base-channel";
import type { SerializedFrame } from "./frame";

/** Frames must be returned in ascending timestamp order; lowerOpen excludes fromMs. */
export interface FrameReader {
  getFrames(
    fromMs: number,
    toMs: number,
    lowerOpen?: boolean,
  ): Promise<SerializedFrame[]>;
}
export interface FrameWriter {
  appendFrame(frame: SerializedFrame): void;
}
export interface VideoChunkReader {
  readVideoChunk(channelId: string, filename: string): Promise<Uint8Array | null>;
}
export interface VideoChunkWriter {
  writeVideoChunk(channelId: string, filename: string, data: Uint8Array): Promise<void>;
}
export interface ReplayClock {
  readonly currentT: number;
  start(t: number, rate?: number): void;
  seek(t: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  onTick(listener: (t: number) => void): () => void;
  dispose(): void;
}

/** A typed channel query with decoded payloads and absolute timestamps. */
export interface DecodedFrame<T> {
  t: number;
  channelId: string;
  data: T;
}

export interface StorageInfo {
  /** Total bytes used by this origin (IDB + OPFS + all storage). */
  usedBytes: number;
  /** Storage quota for this origin in bytes. */
  quotaBytes: number;
  /** Percentage of quota used (0–100). */
  percentUsed: number;
  /** Number of frame records currently in IndexedDB. */
  idbFrameCount: number;
}

export interface RecordingSegment {
  /** Segment start timestamp (ms since epoch). */
  start: number;
  /** Segment end timestamp (ms since epoch). null = currently recording. */
  end: number | null;
}

/** Application-facing storage contract, implemented by ReplayStore or a custom adapter. */
export interface ReplayStorage
  extends FrameReader,
    FrameWriter,
    VideoChunkReader,
    VideoChunkWriter {
  open(): Promise<void>;
  flush(): Promise<void>;
  clearAll(): Promise<void>;
  dispose(): void;
  startSegment(t?: number): void;
  endSegment(t?: number): void;
  getSegments(): RecordingSegment[];
  getTimeRange(): Promise<{ earliest: number; latest: number } | null>;
  getStorageInfo(opts?: { withCount?: boolean }): Promise<StorageInfo>;
  setEvictionPaused(paused: boolean): void;
  getFramesByChannel<T>(
    channel: BaseChannel<T>,
    from: number,
    to: number,
  ): Promise<DecodedFrame<T>[]>;
  getFramesByChannel(
    channel: string,
    from: number,
    to: number,
  ): Promise<SerializedFrame[]>;
  deleteFramesBefore(cutoff: number, limit?: number): Promise<void>;
  deleteVideoChunksBefore(cutoff: number, limit?: number): Promise<void>;
  deleteVideoChunk(channelId: string, filename: string): Promise<void>;
  /** Changes when clearAll replaces the recording; optional for immutable adapters. */
  readonly recordingGeneration?: number;
  readonly pendingFrameCount: number;
  readonly lastWriteError: unknown;
}
