import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VideoChannel,
  type VideoFrameInfo,
} from "../../../entities/video-channel/video-channel";
import { ReplayPlayer } from "../../../features/player/model/replay-player";
import { ReplayStore } from "../../../features/store/model/replay-store";
import type { TimelineIndex } from "../../../features/timeline/model/timeline-index";
import { VideoReplayer } from "../../../features/video/model/video-replayer";
import { useVideoReplayer } from "./use-video-replayer";

const CHANNEL = "screen";
const videoChannel = new VideoChannel(CHANNEL);

function makeStore() {
  return new ReplayStore({ batchIntervalMs: 9999 });
}

function makePlayer(store: ReplayStore) {
  return new ReplayPlayer({
    store,
    channels: new Map(),
    timeRange: { earliest: 0, latest: 10_000 },
  });
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  return canvas;
}

function frameInfo(isKeyframe: boolean): VideoFrameInfo {
  return {
    opfsPath: `video/${CHANNEL}/0.chunk`,
    isKeyframe,
    durationUs: 33_333,
    byteLength: 3,
    codedWidth: 1280,
    codedHeight: 720,
  };
}

/** Record a video frame into the store so getFramesByChannel can return it. */
function recordFrame(store: ReplayStore, t: number, isKeyframe: boolean): void {
  store.appendFrame({
    t,
    channelId: CHANNEL,
    payload: videoChannel.encode(frameInfo(isKeyframe)),
  });
}

describe("useVideoReplayer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not crash when player is null", () => {
    const canvasRef = createRef<HTMLCanvasElement>();
    const store = makeStore();
    expect(() => {
      renderHook(() => useVideoReplayer(null, canvasRef, store, CHANNEL));
    }).not.toThrow();
  });

  it("creates a VideoReplayer when player and canvas are provided", () => {
    vi.spyOn(VideoReplayer.prototype, "feedFrame").mockImplementation(() => {});
    vi.spyOn(VideoReplayer.prototype, "seekTo").mockResolvedValue(undefined);
    const disposeSpy = vi
      .spyOn(VideoReplayer.prototype, "dispose")
      .mockImplementation(() => {});

    const store = makeStore();
    const player = makePlayer(store);
    const canvas = makeCanvas();
    const canvasRef = { current: canvas };

    const { unmount } = renderHook(() =>
      useVideoReplayer(player, canvasRef, store, CHANNEL),
    );

    unmount();
    expect(disposeSpy).toHaveBeenCalled();

    player.dispose();
  });

  it("disposes previous VideoReplayer when player changes", () => {
    vi.spyOn(VideoReplayer.prototype, "feedFrame").mockImplementation(() => {});
    vi.spyOn(VideoReplayer.prototype, "seekTo").mockResolvedValue(undefined);
    const disposeSpy = vi
      .spyOn(VideoReplayer.prototype, "dispose")
      .mockImplementation(() => {});

    const store = makeStore();
    const player1 = makePlayer(store);
    const player2 = makePlayer(store);
    const canvas = makeCanvas();
    const canvasRef = { current: canvas };

    let currentPlayer = player1;
    const { rerender } = renderHook(() =>
      useVideoReplayer(currentPlayer, canvasRef, store, CHANNEL),
    );

    currentPlayer = player2;
    rerender();

    // Disposed once for player1's replayer
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    currentPlayer = player2;
    renderHook(() => useVideoReplayer(null, canvasRef, store, CHANNEL));

    player1.dispose();
    player2.dispose();
  });

  it("does not create VideoReplayer when canvas ref is null", () => {
    const store = makeStore();
    const player = makePlayer(store);
    const canvasRef = { current: null };

    expect(() => {
      renderHook(() => useVideoReplayer(player, canvasRef, store, CHANNEL));
    }).not.toThrow();

    player.dispose();
  });

  it("feedFrame is called for live frames with matching channelId, ignored otherwise", async () => {
    vi.useRealTimers();
    const feedSpy = vi
      .spyOn(VideoReplayer.prototype, "feedFrame")
      .mockImplementation(() => {});
    vi.spyOn(VideoReplayer.prototype, "seekTo").mockResolvedValue(undefined);

    const store = makeStore();
    await store.open(); // empty store → mount hydrate finds no keyframe, no-op
    const canvasRef = { current: makeCanvas() };

    const frameListeners: ((f: unknown) => void)[] = [];
    const fakePlayer = {
      currentT: 0,
      onFrame: (l: (f: unknown) => void) => {
        frameListeners.push(l);
        return () => {
          const i = frameListeners.indexOf(l);
          if (i !== -1) frameListeners.splice(i, 1);
        };
      },
      onSeek: () => () => {},
    } as unknown as ReplayPlayer;

    renderHook(() => useVideoReplayer(fakePlayer, canvasRef, store, CHANNEL));
    // Let the mount hydrate complete so `seekingTo` returns to null and live
    // frames feed straight through instead of being parked.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    act(() => {
      for (const l of frameListeners) l({ channelId: CHANNEL, t: 100 });
    });
    expect(feedSpy).toHaveBeenCalledTimes(1);

    act(() => {
      for (const l of frameListeners) l({ channelId: "camera", t: 200 });
    });
    expect(feedSpy).toHaveBeenCalledTimes(1); // unchanged — wrong channel ignored

    store.dispose();
  });

  it("forwards non-video frames to onOtherFrame, never to feedFrame", async () => {
    vi.useRealTimers();
    const feedSpy = vi
      .spyOn(VideoReplayer.prototype, "feedFrame")
      .mockImplementation(() => {});
    vi.spyOn(VideoReplayer.prototype, "seekTo").mockResolvedValue(undefined);

    const store = makeStore();
    await store.open();
    const canvasRef = { current: makeCanvas() };

    const frameListeners: ((f: unknown) => void)[] = [];
    const fakePlayer = {
      currentT: 0,
      onFrame: (l: (f: unknown) => void) => {
        frameListeners.push(l);
        return () => {};
      },
      onSeek: () => () => {},
    } as unknown as ReplayPlayer;

    const others: unknown[] = [];
    renderHook(() =>
      useVideoReplayer(fakePlayer, canvasRef, store, CHANNEL, {
        onOtherFrame: (f) => others.push(f),
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    act(() => {
      for (const l of frameListeners) {
        l({ channelId: "logs", t: 50 });
        l({ channelId: CHANNEL, t: 60 });
        l({ channelId: "metrics", t: 70 });
      }
    });

    // Video frame fed to the replayer; the two off-channel frames forwarded.
    expect(feedSpy).toHaveBeenCalledTimes(1);
    expect(others).toEqual([
      { channelId: "logs", t: 50 },
      { channelId: "metrics", t: 70 },
    ]);

    store.dispose();
  });

  // ── Seek → keyframe-aligned re-decode ───────────────────────────────────────

  it("calls seekTo with a keyframe-aligned index on seek (real store)", async () => {
    vi.useRealTimers();
    const seekSpy = vi
      .spyOn(VideoReplayer.prototype, "seekTo")
      .mockResolvedValue(undefined);

    const store = makeStore();
    await store.open();
    // keyframe at 1000, delta at 1033, both within the 3s lookback of a seek to 1033.
    recordFrame(store, 1000, true);
    recordFrame(store, 1033, false);
    await store.flush();

    const player = makePlayer(store);
    const canvas = makeCanvas();
    const canvasRef = { current: canvas };

    renderHook(() => useVideoReplayer(player, canvasRef, store, CHANNEL));
    // Let the mount hydrate (currentT=0, no frames → no seekTo) settle.
    await Promise.resolve();
    seekSpy.mockClear();

    player.seek(1033);
    // Drain microtasks for the async runSeek.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(seekSpy).toHaveBeenCalledTimes(1);
    const [t, idx] = seekSpy.mock.calls[0]!;
    expect(t).toBe(1033);
    expect((idx as TimelineIndex).floor(1033)).toBe(1000); // nearest keyframe ≤ target

    player.dispose();
    store.dispose();
  });

  it("works while paused: seek triggers seekTo without play()", async () => {
    vi.useRealTimers();
    const seekSpy = vi
      .spyOn(VideoReplayer.prototype, "seekTo")
      .mockResolvedValue(undefined);

    const store = makeStore();
    await store.open();
    recordFrame(store, 500, true);
    await store.flush();

    const player = makePlayer(store);
    const canvasRef = { current: makeCanvas() };

    renderHook(() => useVideoReplayer(player, canvasRef, store, CHANNEL));
    await Promise.resolve();
    seekSpy.mockClear();

    // No play() — purely paused scrub.
    player.seek(500);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(seekSpy).toHaveBeenCalledTimes(1);
    expect(seekSpy.mock.calls[0]![0]).toBe(500);

    player.dispose();
    store.dispose();
  });

  it("collapses rapid seeks: only one seekTo in flight, last target wins", async () => {
    vi.useRealTimers();

    // Gate the store query so we can fire a second seek while the first is in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = makeStore();
    await store.open();
    recordFrame(store, 1000, true);
    recordFrame(store, 2000, true);
    await store.flush();

    const realQuery = store.getFramesByChannel.bind(store) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let firstCall = true;
    const gatedQuery = async (...args: unknown[]): Promise<unknown> => {
      if (firstCall) {
        firstCall = false;
        await gate; // hold the first query open
      }
      return realQuery(...args);
    };
    vi.spyOn(store, "getFramesByChannel").mockImplementation(
      gatedQuery as typeof store.getFramesByChannel,
    );

    const seekSpy = vi
      .spyOn(VideoReplayer.prototype, "seekTo")
      .mockResolvedValue(undefined);

    const player = makePlayer(store);
    const canvasRef = { current: makeCanvas() };
    renderHook(() => useVideoReplayer(player, canvasRef, store, CHANNEL));
    await Promise.resolve();
    seekSpy.mockClear();

    player.seek(1000); // starts runSeek, blocks on gate
    await Promise.resolve();
    player.seek(2000); // collapses into queuedT while first is in flight
    await Promise.resolve();

    // First seek hasn't completed: no seekTo yet (query still gated).
    expect(seekSpy).not.toHaveBeenCalled();

    release();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Both seeks processed sequentially; final target is 2000.
    const targets = seekSpy.mock.calls.map((c) => c[0]);
    expect(targets[targets.length - 1]).toBe(2000);
    // Never more than the two distinct requested targets.
    expect(seekSpy.mock.calls.length).toBeLessThanOrEqual(2);

    player.dispose();
    store.dispose();
  });

  it("unmount during a seek query cancels before seekTo (cancelled guard)", async () => {
    vi.useRealTimers();
    // Gate the store query so we can unmount while runSeek is suspended.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = makeStore();
    await store.open();
    recordFrame(store, 1000, true);
    await store.flush();
    const realQuery = store.getFramesByChannel.bind(store) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    vi.spyOn(store, "getFramesByChannel").mockImplementation((async (...a: unknown[]) => {
      await gate;
      return realQuery(...a);
    }) as typeof store.getFramesByChannel);
    const seekSpy = vi
      .spyOn(VideoReplayer.prototype, "seekTo")
      .mockResolvedValue(undefined);

    const player = makePlayer(store);
    const canvasRef = { current: makeCanvas() };
    const { unmount } = renderHook(() =>
      useVideoReplayer(player, canvasRef, store, CHANNEL),
    );
    await Promise.resolve();
    seekSpy.mockClear();

    player.seek(1000); // runSeek suspends on the gated query
    await Promise.resolve();
    unmount(); // sets cancelled = true
    release(); // query resolves → `if (cancelled) return` skips seekTo
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(seekSpy).not.toHaveBeenCalled();
    player.dispose();
    store.dispose();
  });

  it("unmount during seekTo cancels the post-seekTo continuation (cancelled guard)", async () => {
    vi.useRealTimers();
    let releaseSeek!: () => void;
    const seekGate = new Promise<void>((r) => {
      releaseSeek = r;
    });
    const store = makeStore();
    await store.open();
    recordFrame(store, 1000, true);
    await store.flush();
    const seekSpy = vi
      .spyOn(VideoReplayer.prototype, "seekTo")
      .mockImplementation(async () => {
        await seekGate; // hold seekTo open so unmount lands during it
      });

    const player = makePlayer(store);
    const canvasRef = { current: makeCanvas() };
    const { unmount } = renderHook(() =>
      useVideoReplayer(player, canvasRef, store, CHANNEL),
    );
    await Promise.resolve();
    seekSpy.mockClear();

    player.seek(1000);
    for (let i = 0; i < 5; i++) await Promise.resolve(); // query resolves, seekTo starts
    expect(seekSpy).toHaveBeenCalledTimes(1);
    unmount(); // cancelled = true while seekTo is suspended
    releaseSeek(); // seekTo resolves → post-seekTo `if (cancelled) return`
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // No throw; the cancelled guard short-circuits the post-seekTo work.
    player.dispose();
    store.dispose();
  });

  it("skips seekTo when no keyframe is in the lookback window", async () => {
    vi.useRealTimers();
    const seekSpy = vi
      .spyOn(VideoReplayer.prototype, "seekTo")
      .mockResolvedValue(undefined);

    const store = makeStore();
    await store.open();
    recordFrame(store, 4000, false); // delta only, no keyframe
    await store.flush();

    const player = makePlayer(store);
    const canvasRef = { current: makeCanvas() };
    renderHook(() => useVideoReplayer(player, canvasRef, store, CHANNEL));
    await Promise.resolve();
    seekSpy.mockClear();

    player.seek(4000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(seekSpy).not.toHaveBeenCalled();

    player.dispose();
    store.dispose();
  });

  it("parks live frames while a seek is in flight, then flushes only post-target frames", async () => {
    vi.useRealTimers();
    const feedSpy = vi
      .spyOn(VideoReplayer.prototype, "feedFrame")
      .mockImplementation(() => {});

    // Gate seekTo so the seek stays in-flight (seekingTo !== null) while we
    // fire onFrame events. Resolve it on release().
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(VideoReplayer.prototype, "seekTo").mockImplementation(async () => {
      await gate;
    });

    const store = makeStore();
    await store.open();
    recordFrame(store, 1000, true); // keyframe so seekTo is actually invoked
    await store.flush();

    // Fake player that lets us capture the onSeek + onFrame listeners and the
    // current position used by the mount hydrate.
    let seekListener: ((t: number) => void) | null = null;
    const frameListeners: ((f: unknown) => void)[] = [];
    const fakePlayer = {
      currentT: 1000,
      onSeek: (l: (t: number) => void) => {
        seekListener = l;
        return () => {
          seekListener = null;
        };
      },
      onFrame: (l: (f: unknown) => void) => {
        frameListeners.push(l);
        return () => {
          const i = frameListeners.indexOf(l);
          if (i !== -1) frameListeners.splice(i, 1);
        };
      },
    } as unknown as ReplayPlayer;

    const canvasRef = { current: makeCanvas() };
    renderHook(() => useVideoReplayer(fakePlayer, canvasRef, store, CHANNEL));
    // The mount hydrate(currentT=1000) starts a seek that blocks on the gate,
    // so seekingTo is now set. Drain microtasks up to the gate await.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Fire two live frames while the seek is in-flight → both parked, none fed.
    act(() => {
      for (const l of frameListeners) l({ channelId: CHANNEL, t: 900 }); // <= target (1000) → dropped
      for (const l of frameListeners) l({ channelId: CHANNEL, t: 1500 }); // > target → flushed
    });
    expect(feedSpy).not.toHaveBeenCalled(); // parked, not fed

    // Release the seek → flushPending(1000) runs: drops t<=1000, feeds t>1000.
    release();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(feedSpy).toHaveBeenCalledTimes(1);
    expect(feedSpy.mock.calls[0]![0]).toMatchObject({ t: 1500 });
    expect(seekListener).not.toBeNull(); // onSeek was wired

    store.dispose();
  });
});
