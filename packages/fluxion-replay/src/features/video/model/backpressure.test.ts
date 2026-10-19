import { afterEach, expect, it, vi } from "vitest";
import { VideoChannel } from "../../../entities/video-channel/video-channel";
import { ReplayRecorder } from "../../recorder/model/replay-recorder";
import { VideoRecorder, type VideoRecorderOptions } from "./video-recorder";

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function harness(options: Partial<VideoRecorderOptions> = {}) {
  let controller!: ReadableStreamDefaultController<VideoFrame>;
  const encoders: Encoder[] = [];
  class Encoder {
    state = "unconfigured";
    encodeQueueSize = 0;
    encode = vi.fn();
    flush = vi.fn(async () => {});
    constructor(readonly callbacks: VideoEncoderInit) {
      encoders.push(this);
    }
    configure() {
      this.state = "configured";
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("VideoEncoder", Encoder);
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = new ReadableStream<VideoFrame>({
        start(c) {
          controller = c;
        },
      });
    },
  );
  const recorder = new ReplayRecorder({
    channels: [new VideoChannel("cam")],
    store: { appendFrame: vi.fn() },
  });
  recorder.start();
  const record = vi.spyOn(recorder, "record");
  const write = vi.fn(async () => {});
  const video = new VideoRecorder({
    channelId: "cam",
    store: { writeVideoChunk: write },
    recorder,
    ...options,
  });
  const frame = () => {
    const close = vi.fn();
    controller.enqueue({
      timestamp: 0,
      displayWidth: 640,
      displayHeight: 480,
      close,
    } as unknown as VideoFrame);
    return close;
  };
  const output = (
    kind: EncodedVideoChunkType = "key",
    size = 1,
    index = encoders.length - 1,
  ) =>
    encoders[index].callbacks.output(
      new EncodedVideoChunk({ type: kind, timestamp: 0, data: new Uint8Array(size) }),
      {},
    );
  return { video, encoders, record, write, frame, output };
}
it("bounds pending chunks and resumes only at a keyframe", async () => {
  const h = harness({ maxPendingChunks: 1 });
  const gate = deferred<void>();
  h.write.mockImplementationOnce(() => gate.promise);
  await h.video.start({} as MediaStreamTrack);
  h.frame();
  await settle();
  h.output();
  h.output("delta");
  expect(h.video.pressure).toEqual({
    pendingChunks: 1,
    pendingBytes: 1,
    droppedFrames: 1,
  });
  gate.resolve();
  await settle();
  h.output("delta");
  expect(h.video.pressure.droppedFrames).toBe(2);
  h.frame();
  await settle();
  expect(h.encoders[0].encode.mock.calls.at(-1)?.[1]).toEqual({ keyFrame: true });
  h.output("key");
  await settle();
  expect(h.record).toHaveBeenCalledTimes(2);
  h.video.stop();
});
it("bounds output bytes and closes input frames under encoder pressure", async () => {
  const h = harness({ maxPendingBytes: 1, maxEncodeQueueSize: 1 });
  await h.video.start({} as MediaStreamTrack);
  h.output("key", 2);
  expect(h.video.pressure.pendingBytes).toBe(0);
  h.encoders[0].encodeQueueSize = 1;
  const close = h.frame();
  await settle();
  expect(close).toHaveBeenCalledOnce();
  expect(h.video.pressure.droppedFrames).toBe(2);
  h.video.stop();
});
it("drains the encoder and pending files before allowing a new recording", async () => {
  const h = harness();
  const gate = deferred<void>();
  h.write.mockImplementationOnce(() => gate.promise);
  await h.video.start({} as MediaStreamTrack);
  h.frame();
  await settle();
  h.output();
  const finish = h.video.stopAndFlush();
  expect(h.video.stopAndFlush()).toBe(finish);
  const restart = h.video.start({} as MediaStreamTrack);
  await settle();
  expect(h.encoders).toHaveLength(1);
  gate.resolve();
  await finish;
  await restart;
  expect(h.encoders[0].flush).toHaveBeenCalledOnce();
  expect(h.record).toHaveBeenCalledOnce();
  expect(h.video.pressure.pendingChunks).toBe(0);
  h.output("key", 1, 0);
  expect(h.write).toHaveBeenCalledOnce();
  h.video.stop();
});
it("finalizes an idle recorder and observes cancellation errors", async () => {
  const h = harness();
  await h.video.stopAndFlush();
  await h.video.start({} as MediaStreamTrack);
  const reader = (
    h.video as unknown as { _processor: ReadableStreamDefaultReader<VideoFrame> }
  )._processor;
  vi.spyOn(reader, "cancel").mockRejectedValueOnce(new Error("already cancelled"));
  await h.video.stopAndFlush();
  expect(h.video.isRunning).toBe(false);
});
it("drops late input after stop and reports exceptions from write error observers", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness({
    onWriteError: () => {
      throw new Error("observer");
    },
  });
  h.write.mockRejectedValueOnce(new Error("disk"));
  await h.video.start({} as MediaStreamTrack);
  h.output();
  await settle();
  expect(error).toHaveBeenCalledWith("[VideoRecorder] output failed:", expect.any(Error));
  const close = h.frame();
  h.video.stop();
  await settle();
  expect(close).toHaveBeenCalledOnce();
});
it.each([0, -1, NaN, Infinity])("rejects invalid queue capacity %s", (limit) => {
  expect(() => harness({ maxPendingChunks: limit })).toThrow(RangeError);
});
it("does not record an old file completion into a restarted recording", async () => {
  const h = harness();
  const gate = deferred<void>();
  h.write.mockImplementationOnce(() => gate.promise);
  await h.video.start({} as MediaStreamTrack);
  h.output();
  h.video.stop();
  await h.video.start({} as MediaStreamTrack);
  gate.resolve();
  await settle();
  expect(h.record).not.toHaveBeenCalled();
  h.video.stop();
});
it("closes an input frame and stops when encoding throws", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = harness();
  await h.video.start({} as MediaStreamTrack);
  h.encoders[0].encode.mockImplementationOnce(() => {
    throw new Error("invalid config");
  });
  const close = h.frame();
  await settle();
  expect(close).toHaveBeenCalledOnce();
  expect(h.video.isRunning).toBe(false);
  expect(error).toHaveBeenCalled();
});
