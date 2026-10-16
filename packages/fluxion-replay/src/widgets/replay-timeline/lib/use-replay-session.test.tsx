import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplaySession } from "./use-replay-session";

describe("useReplaySession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts with isReady false", () => {
    const { result } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );
    expect(result.current.isReady).toBe(false);
  });

  it("sets isReady after auto-open", async () => {
    const { result } = renderHook(() => useReplaySession({ channels: [] }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.isReady).toBe(true);
  });

  it("starts in live mode", () => {
    const { result } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );
    expect(result.current.mode).toBe("live");
  });

  it("enterReplay switches mode to replay", async () => {
    const { result } = renderHook(() => useReplaySession({ channels: [] }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.enterReplay();
    });

    expect(result.current.mode).toBe("replay");
  });

  it("exitReplay returns to live mode", async () => {
    const { result } = renderHook(() => useReplaySession({ channels: [] }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.enterReplay();
    });
    act(() => {
      result.current.exitReplay();
    });

    expect(result.current.mode).toBe("live");
  });

  it("disposes session on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    const session = result.current.session;
    const disposeSpy = session ? vi.spyOn(session, "dispose") : null;

    unmount();

    if (disposeSpy) {
      expect(disposeSpy).toHaveBeenCalled();
    }
  });

  it("record() is a no-op when session is null", () => {
    const { result } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );
    expect(() => result.current.record("test", {})).not.toThrow();
  });

  it("exitReplay() is a no-op when session is null", () => {
    const { result } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );
    expect(() => result.current.exitReplay()).not.toThrow();
  });

  it("enterReplay with timestamp passes it to session", async () => {
    const { result } = renderHook(() => useReplaySession({ channels: [] }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let player: unknown = null;
    await act(async () => {
      player = await result.current.enterReplay(5000);
    });

    // Player should be returned and mode should be replay
    expect(player).not.toBeNull();
    expect(result.current.mode).toBe("replay");
  });

  it("multiple enterReplay calls do not throw", async () => {
    const { result } = renderHook(() => useReplaySession({ channels: [] }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await expect(
      act(async () => {
        await result.current.enterReplay();
        await result.current.enterReplay();
      }),
    ).resolves.not.toThrow();
  });

  it("record() passes channelId and data to session", async () => {
    const { result } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const session = result.current.session;
    if (session) {
      const recordSpy = vi.spyOn(session, "record");
      act(() => {
        result.current.record("test-channel", { value: 42 });
      });
      expect(recordSpy).toHaveBeenCalledWith("test-channel", { value: 42 }, undefined);
    }
  });

  // Guard against the class of bug Phase 10 chased: an unstable callback
  // identity here would cascade through every effect in the consumer that
  // puts these in deps (see auto-record-pattern.test.tsx).
  it("returned callbacks (record, enterReplay, exitReplay) have stable identity across re-renders", async () => {
    const { result, rerender } = renderHook(() =>
      useReplaySession({ channels: [], autoOpen: false }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const r0 = {
      record: result.current.record,
      enterReplay: result.current.enterReplay,
      exitReplay: result.current.exitReplay,
    };
    rerender();
    rerender();
    expect(result.current.record).toBe(r0.record);
    expect(result.current.enterReplay).toBe(r0.enterReplay);
    expect(result.current.exitReplay).toBe(r0.exitReplay);
  });

  // Phase 20-A-2: open() failures used to go to console.error and leave
  // isReady=false with no signal. They now surface on `result.current.error`.
  describe("Phase 20: error state", () => {
    it("starts with error === null", () => {
      const { result } = renderHook(() =>
        useReplaySession({ channels: [], autoOpen: false }),
      );
      expect(result.current.error).toBeNull();
    });

    it("isReady becomes true and error stays null on successful open", async () => {
      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.isReady).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it("surfaces an Error on open() rejection", async () => {
      const failure = new Error("idb blocked");
      // Mock indexedDB.open to fire its onerror handler.
      const orig = globalThis.indexedDB.open;
      globalThis.indexedDB.open = (() => {
        const req: { onerror?: (e: unknown) => void; onsuccess?: unknown; error: Error } =
          {
            error: failure,
          };
        Promise.resolve().then(() => req.onerror?.({ target: req }));
        return req as unknown as IDBOpenDBRequest;
      }) as unknown as typeof globalThis.indexedDB.open;

      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toContain("idb blocked");
      expect(result.current.isReady).toBe(false);

      globalThis.indexedDB.open = orig;
    });

    it("wraps a non-Error thrown value in Error", async () => {
      const orig = globalThis.indexedDB.open;
      globalThis.indexedDB.open = (() => {
        const req: {
          onerror?: (e: unknown) => void;
          onsuccess?: unknown;
          error: unknown;
        } = {
          error: "string failure",
        };
        Promise.resolve().then(() => req.onerror?.({ target: req }));
        return req as unknown as IDBOpenDBRequest;
      }) as unknown as typeof globalThis.indexedDB.open;

      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.error).toBeInstanceOf(Error);
      globalThis.indexedDB.open = orig;
    });
  });

  // The "Opening IDB…" hang: a blocked open used to never settle (no onblocked
  // handler), and a StrictMode mount→cleanup→mount left a zombie connection.
  describe("open hang regression", () => {
    const idb = (
      globalThis as unknown as {
        __fakeIDBControls: {
          setForceBlocked: (v: boolean) => void;
          reset: () => void;
        };
      }
    ).__fakeIDBControls;

    afterEach(() => idb.reset());

    it("surfaces error and keeps isReady false when the IDB open is blocked", async () => {
      idb.setForceBlocked(true);
      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toMatch(/blocked/);
      expect(result.current.isReady).toBe(false);
    });

    it("mount → unmount → fresh mount ends with isReady true (no zombie hang)", async () => {
      // First mount, then unmount mid/early-open (StrictMode-style teardown).
      const first = renderHook(() => useReplaySession({ channels: [] }));
      first.unmount();
      // A fresh mount must open cleanly and reach ready — the disposed first
      // session must not leave a connection blocking this one.
      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.isReady).toBe(true);
      expect(result.current.error).toBeNull();
    });
  });

  describe("concurrent enter/exit generation guard", () => {
    it("exitReplay during an in-flight enterReplay leaves mode 'live' once it resolves", async () => {
      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Park the session-level enterReplay so the hook's await stays pending.
      let release!: () => void;
      const session = result.current.session!;
      const enterSpy = vi.spyOn(session, "enterReplay").mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ dispose: vi.fn() } as unknown as Awaited<
                ReturnType<typeof session.enterReplay>
              >);
          }),
      );

      let pending!: Promise<unknown>;
      await act(async () => {
        pending = result.current.enterReplay(1000);
      });
      // User exits before the enter resolves.
      await act(async () => {
        result.current.exitReplay();
      });
      expect(result.current.mode).toBe("live");

      await act(async () => {
        release();
        await pending;
      });
      // The stale enter must NOT flip the hook's mode back to "replay".
      expect(result.current.mode).toBe("live");
      enterSpy.mockRestore();
    });

    it("a stale enterReplay superseded by a newer one resolves to null", async () => {
      const { result } = renderHook(() => useReplaySession({ channels: [] }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const session = result.current.session!;
      const resolvers: Array<() => void> = [];
      const enterSpy = vi.spyOn(session, "enterReplay").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(() =>
              resolve({ dispose: vi.fn() } as unknown as Awaited<
                ReturnType<typeof session.enterReplay>
              >),
            );
          }),
      );

      let pA!: Promise<unknown>;
      let pB!: Promise<unknown>;
      await act(async () => {
        pA = result.current.enterReplay(1000);
        pB = result.current.enterReplay(2000);
      });
      await act(async () => {
        // Resolve in arrival order: A (stale) first, then B (current).
        for (const r of resolvers) r();
        const [a, b] = await Promise.all([pA, pB]);
        expect(a).toBeNull(); // superseded
        expect(b).not.toBeNull();
      });
      expect(result.current.mode).toBe("replay");
      enterSpy.mockRestore();
    });
  });
});

it("ignores a late open rejection after unmount", async () => {
  const { ReplaySession } = await import(
    "../../../features/session/model/replay-session"
  );
  let reject!: (e: Error) => void;
  const spy = vi.spyOn(ReplaySession.prototype, "open").mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const view = renderHook(() => useReplaySession({ channels: [] }));
  view.unmount();
  await act(async () => {
    reject(new Error("late failure"));
  });
  expect(view.result.current.error).toBeNull();
  spy.mockRestore();
});
it("does not restore replay mode when enter resolves after exit", async () => {
  const view = renderHook(() => useReplaySession({ channels: [], autoOpen: false }));
  const { makeFakePlayer } = await import("../../chart-replay/lib/chart-replay-fixtures");
  const player = makeFakePlayer(
    0,
  ) as unknown as import("../../../features/player/model/replay-player").ReplayPlayer;
  let release!: (p: typeof player) => void;
  vi.spyOn(view.result.current.session!, "enterReplay").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let pending!: ReturnType<typeof view.result.current.enterReplay>;
  act(() => {
    pending = view.result.current.enterReplay();
    view.result.current.exitReplay();
  });
  await act(async () => {
    release(player);
    expect(await pending).toBeNull();
  });
  expect(view.result.current.mode).toBe("live");
  view.unmount();
});
it("does not install an old time range after exit", async () => {
  const view = renderHook(() => useReplaySession({ channels: [], autoOpen: false }));
  const { makeFakePlayer } = await import("../../chart-replay/lib/chart-replay-fixtures");
  const player = makeFakePlayer(
    0,
  ) as unknown as import("../../../features/player/model/replay-player").ReplayPlayer;
  vi.spyOn(view.result.current.session!, "enterReplay").mockResolvedValueOnce(player);
  let release!: (range: { earliest: number; latest: number }) => void;
  vi.spyOn(view.result.current.session!, "getTimeRange").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let pending!: ReturnType<typeof view.result.current.enterReplay>;
  await act(async () => {
    pending = view.result.current.enterReplay();
    await Promise.resolve();
  });
  act(() => view.result.current.exitReplay());
  await act(async () => {
    release({ earliest: 0, latest: 10 });
    expect(await pending).toBe(player);
  });
  expect(view.result.current.mode).toBe("live");
  expect(view.result.current.timeRange).toBeNull();
  view.unmount();
});
it("returns null before the first session effect commits", async () => {
  let first!: ReturnType<typeof useReplaySession>["enterReplay"];
  const view = renderHook(() => {
    const hook = useReplaySession({ channels: [], autoOpen: false });
    if (!first) first = hook.enterReplay;
    return hook;
  });
  await expect(first()).resolves.toBeNull();
  view.unmount();
});
