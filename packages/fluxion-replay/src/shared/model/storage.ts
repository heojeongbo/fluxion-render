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
