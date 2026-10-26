/**
 * Scenario 14: Video storage pressure → OPFS + IDB eviction (regression)
 *
 * The bug: quota-based eviction deleted only IndexedDB frame *metadata*, never
 * the encoded video `.chunk` files in OPFS — which are the bulk of storage. So
 * `navigator.storage.estimate().usage` (IDB + OPFS) kept climbing to the quota
 * no matter how many IDB rows evicted, and `writeVideoChunk` eventually threw
 * `QuotaExceededError`.
 *
 * This drives the user's exact scenario end-to-end through `ReplaySession`:
 * record Metric + Video, cross the storage threshold, flush, and assert the
 * oldest OPFS chunk AND its IDB frame are reclaimed together while the retained
 * window survives in both backends and still replays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../entities/metric-channel/metric-channel";
import {
  VideoChannel,
  type VideoFrameInfo,
} from "../entities/video-channel/video-channel";
import { ReplaySession } from "../features/session/model/replay-session";
import { TimelineIndex } from "../features/timeline/model/timeline-index";
import { VideoReplayer } from "../features/video/model/video-replayer";

const CAM = "cam";
const CPU = "cpu";

const STEP_MS = 50; // metric cadence
const VIDEO_STEP_MS = 100; // ~10 fps video
const KEYFRAME_EVERY = 10; // keyframe every 1 s
const COUNT = 60; // 3 s of metric (last t = 2950)
const VIDEO_COUNT = 30; // 3 s of video (last t = 2900)
const LAST_VIDEO_T = (VIDEO_COUNT - 1) * VIDEO_STEP_MS; // 2900

function makeCanvas(): HTMLCanvasElement {
  return {
    getContext: () => ({ drawImage: vi.fn() }),
    width: 640,
    height: 480,
  } as unknown as HTMLCanvasElement;
}

describe("Scenario 14: video storage pressure evicts OPFS chunks + IDB frames", () => {
  let session: ReplaySession;
  let keyframeIndex: TimelineIndex;

  beforeEach(async () => {
    vi.useFakeTimers();
    keyframeIndex = new TimelineIndex();
    session = new ReplaySession({
      channels: [new MetricChannel(CPU), new VideoChannel(CAM)],
      retentionMs: 10 * 60_000,
    });
    await session.open();
    await session.startRecording();
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedAll(): Promise<void> {
    for (let i = 0; i < COUNT; i++) {
      session.record(CPU, { name: "cpu", value: i }, i * STEP_MS);
    }
    for (let i = 0; i < VIDEO_COUNT; i++) {
      const t = i * VIDEO_STEP_MS;
      const isKeyframe = i % KEYFRAME_EVERY === 0;
      const filename = `${t}.chunk`;
      await session.store.writeVideoChunk(CAM, filename, new Uint8Array([1, 2, 3]));
      const info: VideoFrameInfo = {
        opfsPath: `video/${CAM}/${filename}`,
        isKeyframe,
        durationUs: VIDEO_STEP_MS * 1000,
        byteLength: 3,
        codedWidth: 640,
        codedHeight: 480,
      };
      session.record(CAM, info, t);
      if (isKeyframe) keyframeIndex.insert(t);
    }
    await session.store.flush();
  }

  /** Force `getStorageInfo` over the 70 % default threshold. */
  function pressurize(): void {
    vi.spyOn(session.store, "getStorageInfo").mockResolvedValue({
      usedBytes: 900,
      quotaBytes: 1000,
      percentUsed: 90,
      idbFrameCount: COUNT + VIDEO_COUNT,
    });
  }

  it("reclaims the oldest OPFS chunk AND its IDB frame together once over threshold", async () => {
    await seedAll();
    pressurize();
    await session.store.flush(); // eviction pass: cutoff = 0 + floor(2950 * 0.01) = 29

    // Oldest video chunk (t=0 < 29) reclaimed from OPFS…
    expect(await session.store.readVideoChunk(CAM, "0.chunk")).toBeNull();
    // …and its IDB metadata frame is gone too.
    const cam = await session.store.getFramesByChannel(CAM, 0, 10_000);
    expect(cam.some((f) => f.t === 0)).toBe(false);

    // The retained window survives in BOTH backends.
    expect(
      await session.store.readVideoChunk(CAM, `${LAST_VIDEO_T}.chunk`),
    ).not.toBeNull();
    expect(cam.some((f) => f.t === LAST_VIDEO_T)).toBe(true);
  });

  it("leaves the retained video window replayable via VideoReplayer.seekTo", async () => {
    await seedAll();
    pressurize();
    await session.store.flush();

    const camFrames = await session.store.getFramesByChannel(CAM, 0, 10_000);
    const channel = new VideoChannel(CAM);
    const playerFrames = camFrames.map((f) => ({
      channelId: CAM,
      data: channel.decode(f.payload),
      t: f.t,
    }));

    const replayer = new VideoReplayer({
      store: session.store,
      channelId: CAM,
      outputCanvas: makeCanvas(),
    });
    // Keyframe floor(2900) = 2000, well inside the retained window → decodes fine.
    await expect(
      replayer.seekTo(LAST_VIDEO_T, keyframeIndex, playerFrames),
    ).resolves.toBeUndefined();
    replayer.dispose();
  });

  it("entering replay does NOT evict the oldest data, even over threshold", async () => {
    await seedAll();
    pressurize(); // getStorageInfo → 90 %, so a normal flush WOULD evict

    // enterReplay pauses eviction for the duration of replay → the oldest chunk
    // and its IDB frame survive, so time-travel can reach the true start.
    await session.enterReplay(0);

    expect(await session.store.readVideoChunk(CAM, "0.chunk")).not.toBeNull();
    const cam = await session.store.getFramesByChannel(CAM, 0, 10_000);
    expect(cam.some((f) => f.t === 0)).toBe(true);

    session.exitReplay();
  });
});
