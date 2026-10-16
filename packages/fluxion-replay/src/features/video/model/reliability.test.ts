import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayPlayerFrame } from "../../player/model/replay-player";
import { TimelineIndex } from "../../timeline/model/timeline-index";
import { VideoReplayer } from "./video-replayer";

const decoders: Decoder[] = [];
class Decoder {
  state = "unconfigured";
  decoded: { type: string; timestamp: number }[] = [];
  constructor(readonly options: VideoDecoderInit) {
    decoders.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { type: string; timestamp: number }) {
    this.decoded.push(chunk);
  }
  close() {
    this.state = "closed";
  }
}
function frame(t: number, key = true): ReplayPlayerFrame {
  return {
    channelId: "cam",
    t,
    data: { opfsPath: `${t}.chunk`, isKeyframe: key, codedWidth: 10, codedHeight: 10 },
  };
}
function setup(
  readVideoChunk: (channel: string, name: string) => Promise<Uint8Array | null>,
) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
  } as unknown as HTMLCanvasElement;
  return new VideoReplayer({
    channelId: "cam",
    outputCanvas: canvas,
    store: { readVideoChunk },
  });
}
beforeEach(() => {
  decoders.length = 0;
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(options: object) {
        Object.assign(this, options);
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("video read ordering", () => {
  it("submits keyframe before delta even when the first read is delayed", async () => {
    let release!: (value: Uint8Array) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(new Uint8Array([2]));
    const video = setup(read);
    video.feedFrame(frame(1));
    video.feedFrame(frame(2, false));
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    release(new Uint8Array([1]));
    await video.flush();
    expect(decoders[0].decoded.map((c) => c.type)).toEqual(["key", "delta"]);
    expect(decoders[0].decoded.map((c) => c.timestamp)).toEqual([1000, 2000]);
    video.dispose();
  });
  it("discards old reads and output callbacks across seek and dispose", async () => {
    let release!: (value: Uint8Array) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(new Uint8Array([2]));
    const video = setup(read);
    video.feedFrame(frame(1));
    video.feedFrame(frame(2, false));
    await Promise.resolve();
    const old = video.flush();
    const index = new TimelineIndex();
    index.insert(10);
    await video.seekTo(10, index, [frame(10)]);
    release(new Uint8Array([1]));
    await old;
    expect(decoders[0].decoded).toEqual([]);
    expect(decoders[1].decoded).toHaveLength(1);
    const close = vi.fn();
    decoders[0].options.output({ close } as unknown as VideoFrame);
    expect(close).toHaveBeenCalledOnce();
    video.dispose();
    video.feedFrame(frame(3));
    await video.seekTo(10, index, [frame(10)]);
    await video.flush();
    expect(decoders).toHaveLength(2);
  });
  it("cancels the rest of a seek batch when a newer seek wins", async () => {
    let release!: (value: Uint8Array) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(new Uint8Array([2]));
    const video = setup(read);
    const index = new TimelineIndex();
    index.insert(1);
    index.insert(10);
    const old = video.seekTo(2, index, [frame(1), frame(2, false)]);
    await Promise.resolve();
    await video.seekTo(10, index, [frame(10)]);
    release(new Uint8Array([1]));
    await old;
    expect(read).toHaveBeenCalledTimes(2);
    video.dispose();
  });
  it("reports current read failures, ignores stale failures, and resumes at a fresh keyframe", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(new Uint8Array([1]));
    const video = setup(read);
    video.feedFrame(frame(1));
    await video.flush();
    expect(error).toHaveBeenCalledOnce();
    video.feedFrame(frame(2));
    await video.flush();
    expect(decoders.at(-1)?.decoded).toHaveLength(1);
    let reject!: (error: Error) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((_resolve, r) => {
          reject = r;
        }),
    );
    video.feedFrame(frame(3));
    await Promise.resolve();
    const pending = video.flush();
    video.dispose();
    reject(new Error("stale"));
    await pending;
    expect(error).toHaveBeenCalledOnce();
  });
  it("handles missing codecs at enqueue and execution time", async () => {
    const video = setup(async () => new Uint8Array([1]));
    video.feedFrame(frame(1));
    vi.stubGlobal("VideoDecoder", undefined);
    await video.flush();
    video.feedFrame(frame(2));
    const index = new TimelineIndex();
    index.insert(1);
    await video.seekTo(1, index, [frame(1)]);
    expect(decoders).toEqual([]);
    video.dispose();
  });
});
