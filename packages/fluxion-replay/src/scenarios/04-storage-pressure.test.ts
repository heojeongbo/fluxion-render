/**
 * Scenario 04: Storage Pressure & Auto-Eviction
 *
 * Verifies the library's self-management behaviour when storage fills up:
 * - Automatic deletion of the oldest frames once a configurable usage
 *   threshold is exceeded after each IDB flush.
 * - No-op when the threshold is set to 100 (disabled).
 * - Periodic console.log output from the store-level timer.
 * - console.log from the useStorageInfo hook when logToConsole is true.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricChannel } from "../entities/metric-channel/metric-channel";
import { ReplaySession } from "../features/session/model/replay-session";
import { ReplayStore } from "../features/store/model/replay-store";
import { useStorageInfo } from "../widgets/storage/lib/use-storage-info";

describe("Scenario 04: storage pressure and auto-eviction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("frames are evicted when percentUsed exceeds evictThresholdPct", async () => {
    const store = new ReplayStore({ batchIntervalMs: 9_999, evictThresholdPct: 0 });
    await store.open();

    const deleteSpy = vi.spyOn(store, "deleteFramesBefore");
    vi.spyOn(store, "getStorageInfo").mockResolvedValue({
      usedBytes: 900,
      quotaBytes: 1_000,
      percentUsed: 90,
      idbFrameCount: 50,
    });

    for (let i = 0; i < 50; i++) {
      store.appendFrame({
        t: 1_000 + i * 100,
        channelId: "cpu",
        payload: new ArrayBuffer(4),
      });
    }
    await store.flush();

    // cutoff = earliest(1000) + floor(span(4900) * 0.01) = 1000 + 49 = 1049
    expect(deleteSpy).toHaveBeenCalledWith(1049);
    store.dispose();
  });

  it("no frames are deleted when percentUsed is below evictThresholdPct", async () => {
    const store = new ReplayStore({ batchIntervalMs: 9_999, evictThresholdPct: 80 });
    await store.open();

    const deleteSpy = vi.spyOn(store, "deleteFramesBefore");
    vi.spyOn(store, "getStorageInfo").mockResolvedValue({
      usedBytes: 100,
      quotaBytes: 1_000,
      percentUsed: 10,
      idbFrameCount: 5,
    });

    store.appendFrame({ t: 1_000, channelId: "cpu", payload: new ArrayBuffer(4) });
    await store.flush();

    expect(deleteSpy).not.toHaveBeenCalled();
    store.dispose();
  });

  it("evictThresholdPct: 100 disables eviction entirely", async () => {
    const store = new ReplayStore({ batchIntervalMs: 9_999, evictThresholdPct: 100 });
    await store.open();

    const deleteSpy = vi.spyOn(store, "deleteFramesBefore");
    // Force high usage — but threshold is 100, so nothing should be deleted
    vi.spyOn(store, "getStorageInfo").mockResolvedValue({
      usedBytes: 999,
      quotaBytes: 1_000,
      percentUsed: 99.9,
      idbFrameCount: 100,
    });

    for (let i = 0; i < 10; i++) {
      store.appendFrame({ t: i * 1_000, channelId: "cpu", payload: new ArrayBuffer(4) });
    }
    await store.flush();

    expect(deleteSpy).not.toHaveBeenCalled();
    store.dispose();
  });

  it("storageLogIntervalMs causes console.log output on each tick", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new ReplayStore({
      batchIntervalMs: 9_999,
      storageLogIntervalMs: 2_000,
    });
    await store.open();

    // Tick the timer twice
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[ReplayStore"));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(logSpy).toHaveBeenCalledTimes(2);

    store.dispose();
  });

  it("storageLogIntervalMs: 0 means no periodic logging", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new ReplayStore({ batchIntervalMs: 9_999, storageLogIntervalMs: 0 });
    await store.open();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(logSpy).not.toHaveBeenCalled();
    store.dispose();
  });

  it("ReplaySession propagates evictThresholdPct to the underlying store", async () => {
    const session = new ReplaySession({
      channels: [new MetricChannel("cpu")],
      evictThresholdPct: 75,
    });
    await session.open();

    const deleteSpy = vi.spyOn(session.store, "deleteFramesBefore");
    vi.spyOn(session.store, "getStorageInfo").mockResolvedValue({
      usedBytes: 800,
      quotaBytes: 1_000,
      percentUsed: 80,
      idbFrameCount: 20,
    });

    for (let i = 0; i < 10; i++) {
      session.store.appendFrame({
        t: i * 1_000,
        channelId: "cpu",
        payload: new ArrayBuffer(4),
      });
    }
    await session.store.flush();

    expect(deleteSpy).toHaveBeenCalled();
    session.dispose();
  });

  it("useStorageInfo with logToConsole: true calls console.log on each poll", async () => {
    const session = new ReplaySession({ channels: [] });
    await session.open();

    vi.spyOn(session, "getStorageInfo").mockResolvedValue({
      usedBytes: 1_048_576,
      quotaBytes: 10_485_760,
      percentUsed: 10,
      idbFrameCount: 99,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { unmount } = renderHook(() =>
      useStorageInfo(session, { intervalMs: 1_000, logToConsole: true }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[useStorageInfo]"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("10.0% used"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("99 frames"));

    unmount();
    session.dispose();
  });

  it("useStorageInfo without logToConsole does not print anything", async () => {
    const session = new ReplaySession({ channels: [] });
    await session.open();

    vi.spyOn(session, "getStorageInfo").mockResolvedValue({
      usedBytes: 500,
      quotaBytes: 10_000,
      percentUsed: 5,
      idbFrameCount: 1,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { unmount } = renderHook(() => useStorageInfo(session, { intervalMs: 1_000 }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(logSpy).not.toHaveBeenCalled();

    unmount();
    session.dispose();
  });
});
