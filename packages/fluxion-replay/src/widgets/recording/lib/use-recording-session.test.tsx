import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import { useRecordingSession } from "./use-recording-session";

/** Minimal ReplaySession stub — only the methods the hook touches. */
function makeSessionStub() {
  const recorder = { isRecording: false };
  return {
    recorder,
    clearRecording: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {
      recorder.isRecording = true;
    }),
    stopRecording: vi.fn(() => {
      recorder.isRecording = false;
    }),
    record: vi.fn(),
  };
}

function stubAsSession(stub: ReturnType<typeof makeSessionStub>): ReplaySession {
  return stub as unknown as ReplaySession;
}

describe("useRecordingSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("no-op while session is null or disabled", async () => {
    const { result, rerender } = renderHook(
      ({ session, enabled }: { session: ReplaySession | null; enabled: boolean }) =>
        useRecordingSession({ session, enabled }),
      { initialProps: { session: null as ReplaySession | null, enabled: true } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isRecording).toBe(false);
    expect(result.current.error).toBeNull();

    // enabled=false with a real session — still idle.
    const stub = makeSessionStub();
    rerender({ session: stubAsSession(stub), enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.startRecording).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it("starts the session and reaches isRecording=true", async () => {
    const stub = makeSessionStub();
    const { result } = renderHook(() =>
      useRecordingSession({ session: stubAsSession(stub), enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stub.clearRecording).toHaveBeenCalledTimes(1);
    expect(stub.startRecording).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("StrictMode double-mount does not double-start (same-session guard)", async () => {
    const stub = makeSessionStub();
    const session = stubAsSession(stub);
    // StrictMode runs effect → cleanup → effect again with the SAME session.
    // Initialization is shared; the surviving effect must actually start recording.
    const { result } = renderHook(() => useRecordingSession({ session, enabled: true }), {
      wrapper: StrictMode,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stub.startRecording).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("clearOnStart: false skips clearRecording", async () => {
    const stub = makeSessionStub();
    renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        clearOnStart: false,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stub.clearRecording).not.toHaveBeenCalled();
    expect(stub.startRecording).toHaveBeenCalledTimes(1);
  });

  it("seedTimeRange fires once after startRecording succeeds", async () => {
    const stub = makeSessionStub();
    const seed = vi.fn();
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        seedTimeRange: seed,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(seed).toHaveBeenCalledWith({ earliest: fixedNow, latest: fixedNow });
    vi.restoreAllMocks();
  });

  it("channels: spins up one ticker per spec and records on each interval", async () => {
    const stub = makeSessionStub();
    const cpuProduce = vi.fn(() => ({ name: "cpu", value: 0.5 }));
    const memProduce = vi.fn(() => ({ name: "mem", value: 0.7 }));
    renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        channels: [
          { channelId: "cpu", intervalMs: 100, produce: cpuProduce },
          { channelId: "mem", intervalMs: 200, produce: memProduce },
        ],
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance ~250ms — cpu should fire ~2 times, mem ~1.
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(cpuProduce).toHaveBeenCalled();
    expect(memProduce).toHaveBeenCalled();
    // First record args: (channelId, value, wallT).
    expect(stub.record).toHaveBeenCalledWith(
      "cpu",
      { name: "cpu", value: 0.5 },
      expect.any(Number),
    );
    expect(stub.record).toHaveBeenCalledWith(
      "mem",
      { name: "mem", value: 0.7 },
      expect.any(Number),
    );
  });

  it("cleanup stops every ticker — no further records after unmount", async () => {
    const stub = makeSessionStub();
    const produce = vi.fn(() => 1);
    const { unmount } = renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        channels: [{ channelId: "x", intervalMs: 100, produce }],
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });
    const recordsBefore = stub.record.mock.calls.length;
    expect(recordsBefore).toBeGreaterThan(0);

    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // No new ticks fired after unmount.
    expect(stub.record.mock.calls.length).toBe(recordsBefore);
  });

  it("surfaces an Error when startRecording rejects", async () => {
    const stub = makeSessionStub();
    const failure = new Error("idb quota exceeded");
    stub.startRecording.mockRejectedValueOnce(failure);
    const { result } = renderHook(() =>
      useRecordingSession({ session: stubAsSession(stub), enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBe(failure);
    expect(result.current.isRecording).toBe(false);
  });

  it("StrictMode-style double-mount on same session doesn't restart recording", async () => {
    const stub = makeSessionStub();
    const { rerender } = renderHook(
      ({ session }: { session: ReplaySession }) =>
        useRecordingSession({ session, enabled: true }),
      { initialProps: { session: stubAsSession(stub) } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender({ session: stubAsSession(stub) }); // same instance
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.clearRecording).toHaveBeenCalledTimes(1);
    expect(stub.startRecording).toHaveBeenCalledTimes(1);
  });

  it("unmount before clearRecording completes sets cancelled=true, skips startRecording", async () => {
    const stub = makeSessionStub();
    let resolveClear!: () => void;
    stub.clearRecording.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveClear = res;
        }),
    );

    const { unmount } = renderHook(() =>
      useRecordingSession({ session: stubAsSession(stub), enabled: true }),
    );

    // clearRecording is hanging — unmount immediately
    unmount();
    resolveClear();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // cancelled=true after unmount, so startRecording should NOT be called
    expect(stub.startRecording).not.toHaveBeenCalled();
  });

  it("unmount before startRecording completes sets cancelled=true, skips setIsRecording", async () => {
    const stub = makeSessionStub();
    let resolveStart!: () => void;
    stub.startRecording.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveStart = res;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useRecordingSession({ session: stubAsSession(stub), enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // clearRecording done, startRecording is hanging — unmount
    unmount();
    resolveStart();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // cancelled=true, so setIsRecording(true) should NOT have been called
    expect(result.current.isRecording).toBe(false);
  });

  it("surfaces a non-Error thrown value wrapped in Error", async () => {
    const stub = makeSessionStub();
    stub.startRecording.mockRejectedValueOnce("string error");
    const { result } = renderHook(() =>
      useRecordingSession({ session: stubAsSession(stub), enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("string error");
  });

  it("error after cancel is silently swallowed (cancelled=true guard)", async () => {
    const stub = makeSessionStub();
    let rejectStart!: (e: Error) => void;
    stub.startRecording.mockImplementation(
      () =>
        new Promise<void>((_res, rej) => {
          rejectStart = rej;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useRecordingSession({ session: stubAsSession(stub), enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    unmount(); // sets cancelled=true
    rejectStart(new Error("post-cancel error"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Error should NOT surface because cancelled=true
    expect(result.current.error).toBeNull();
  });

  const settle = () =>
    act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });

  it("keeps a shared session recording until the last hook lets go", async () => {
    const stub = makeSessionStub();
    const session = stubAsSession(stub);
    const a = renderHook(
      ({ enabled }) => useRecordingSession({ session, enabled, clearOnStart: false }),
      { initialProps: { enabled: true } },
    );
    const b = renderHook(
      ({ enabled }) => useRecordingSession({ session, enabled, clearOnStart: false }),
      { initialProps: { enabled: true } },
    );
    await settle();
    b.rerender({ enabled: false }); // panel B goes away first
    await settle();
    expect(stub.stopRecording).not.toHaveBeenCalled();
    expect(stub.recorder.isRecording).toBe(true);
    a.rerender({ enabled: false });
    await settle();
    expect(stub.stopRecording).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it("never stops a recording the app started itself", async () => {
    const stub = makeSessionStub();
    stub.recorder.isRecording = true;
    const hook = renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        clearOnStart: false,
      }),
    );
    await settle();
    hook.unmount();
    await settle();
    expect(stub.stopRecording).not.toHaveBeenCalled();
  });

  it("surfaces a failing ticker record() once instead of throwing every tick", async () => {
    const stub = makeSessionStub();
    stub.record.mockImplementation(() => {
      throw new RangeError("ReplayStore write queue is full");
    });
    const hook = renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        clearOnStart: false,
        channels: [{ channelId: "m", intervalMs: 10, produce: () => 1 }],
      }),
    );
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(35);
    });
    expect(stub.record).toHaveBeenCalledTimes(3);
    expect(hook.result.current.error).toBeInstanceOf(RangeError);
    hook.unmount();
  });

  it("wraps a non-Error value thrown by a ticker's record()", async () => {
    const stub = makeSessionStub();
    stub.record.mockImplementation(() => {
      throw "queue full";
    });
    const hook = renderHook(() =>
      useRecordingSession({
        session: stubAsSession(stub),
        enabled: true,
        clearOnStart: false,
        channels: [{ channelId: "m", intervalMs: 10, produce: () => 1 }],
      }),
    );
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(15);
    });
    expect(hook.result.current.error?.message).toBe("queue full");
    hook.unmount();
  });
});
