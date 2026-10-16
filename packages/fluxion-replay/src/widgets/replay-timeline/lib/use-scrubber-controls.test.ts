/**
 * useScrubberControls — unit tests
 *
 * Verifies the "drag preview → release commit" state machine for the replay
 * scrubber. Tests use makeFakeSession + useReplayDvr (not the real session) so
 * they stay fast and deterministic.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakePlayer,
  makeFakePlayer,
  makeFakeSession,
} from "../../chart-replay/lib/chart-replay-fixtures";
import { useReplayDvr } from "../../dvr/lib/use-replay-dvr";
import { useScrubberControls } from "./use-scrubber-controls";

const LIVE = { earliest: 1_000_000, latest: 1_060_000 };
const EPS = 250; // default liveEdgeEpsMs

/** Build a fake ChangeEvent<HTMLInputElement> carrying a numeric value. */
function fakeChange(value: number): React.ChangeEvent<HTMLInputElement> {
  return { target: { value: String(value) } } as React.ChangeEvent<HTMLInputElement>;
}

/** Wire useScrubberControls through a real useReplayDvr driven by fake session. */
function setup(rate = 1, liveEdgeEpsMs?: number) {
  const ses = makeFakeSession({ timeRange: LIVE });

  const { result } = renderHook(() => {
    const dvr = useReplayDvr({
      session: ses.session,
      enterReplay: ses.enterReplay,
      exitReplay: ses.exitReplay,
      liveTimeRange: LIVE,
      rate,
      autoPlay: false,
    });
    const controls = useScrubberControls({ dvr, rate, liveEdgeEpsMs });
    return { dvr, controls };
  });

  return { ses, result };
}

describe("useScrubberControls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // ── onScrubChange ─────────────────────────────────────────────────────────

  describe("onScrubChange", () => {
    it("tracks scrubT on every change", async () => {
      const { result } = setup();
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000));
      });
      expect(result.current.controls.scrubT).toBe(1_030_000);
    });

    it("is a no-op when effectiveTimeRange is null", async () => {
      const player = makeFakePlayer(0);
      const enter = vi.fn(async () => player);
      const fakeDvr = {
        isDvr: false,
        player: null,
        frozenLatest: null,
        effectiveTimeRange: null, // not seeded yet
        enter,
        exit: vi.fn(),
      };
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr
        useScrubberControls({ dvr: fakeDvr as any, rate: 1 }),
      );
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_030_000));
      });
      expect(result.current.scrubT).toBeNull(); // early return before setScrubT
      expect(enter).not.toHaveBeenCalled();
      // commit is also a no-op with no range.
      await act(async () => {
        result.current.commitScrub();
      });
      expect(fakeDvr.exit).not.toHaveBeenCalled();
    });

    it("while live + t far from edge → enters DVR exactly once on the first change", async () => {
      // Drag past the live edge switches into DVR mid-drag (paused) so the chart
      // previews the past frame at the drag position. Exactly one enter per drag
      // — the flag gates a synchronous burst (the anti-flakiness guarantee).
      const { ses, result } = setup();
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(ses.enterReplay).toHaveBeenCalledWith(1_030_000, expect.any(Object));
      expect(result.current.controls.scrubT).toBe(1_030_000);
      expect(result.current.dvr.isDvr).toBe(true);
    });

    it("beginScrub un-wedges the entry guard so a new drag can enter after a lost release", async () => {
      // Regression ("after a while, time-travel won't engage"): the per-gesture
      // entry guard is normally cleared on commit. If a gesture's release is
      // lost (pointer-up off the input / handler swapped mid-gesture), the guard
      // stays `true` and EVERY later live→DVR drag is silently gated out — the
      // thumb just springs back to live. beginScrub() (pointer-down) clears it.
      const player = makeFakePlayer(1_030_000);
      const enter = vi.fn(async () => player);
      const fakeDvr = {
        isDvr: false, // stays live (models the post-auto-exit state)
        player: null,
        frozenLatest: null,
        effectiveTimeRange: LIVE,
        enter,
        exit: vi.fn(),
      };
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr
        useScrubberControls({ dvr: fakeDvr as any, rate: 1 }),
      );

      // First gesture enters DVR (guard set true) but its release is never
      // committed — the guard stays wedged.
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(enter).toHaveBeenCalledTimes(1);

      // A fresh drag WITHOUT beginScrub is blocked by the wedged guard.
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_025_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(enter).toHaveBeenCalledTimes(1); // still blocked

      // pointer-down resets the guard → the next drag enters again.
      act(() => {
        result.current.beginScrub();
      });
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_020_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(enter).toHaveBeenCalledTimes(2);
      expect(enter).toHaveBeenLastCalledWith(1_020_000);
    });

    it("a window pointerup un-wedges the entry guard even without beginScrub wired", async () => {
      // Same regression as above, but the safety net: a release OFF the slider
      // never fires the input's commit/pointer-down handlers, yet a window-level
      // pointerup always fires. The hook listens for it and re-arms the guard so
      // a later drag can enter DVR again — independent of onPointerDown wiring.
      const player = makeFakePlayer(1_030_000);
      const enter = vi.fn(async () => player);
      const fakeDvr = {
        isDvr: false, // stays live (models the post-auto-exit state)
        player: null,
        frozenLatest: null,
        effectiveTimeRange: LIVE,
        enter,
        exit: vi.fn(),
      };
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr
        useScrubberControls({ dvr: fakeDvr as any, rate: 1 }),
      );

      // First gesture enters DVR (guard set true); its release is lost.
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(enter).toHaveBeenCalledTimes(1);

      // A fresh drag is still blocked by the wedged guard.
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_025_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(enter).toHaveBeenCalledTimes(1);

      // A window pointerup fires (release anywhere) → deferred re-arm clears the
      // guard. NO beginScrub() is called.
      act(() => {
        window.dispatchEvent(new Event("pointerup"));
        vi.advanceTimersByTime(0); // run the deferred macrotask re-arm
      });
      await act(async () => {
        result.current.onScrubChange(fakeChange(1_020_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(enter).toHaveBeenCalledTimes(2);
      expect(enter).toHaveBeenLastCalledWith(1_020_000);
    });

    it("while live + t within liveEdgeEpsMs of edge → no-op (no enter)", async () => {
      const { ses, result } = setup();
      const nearEdge = LIVE.latest - EPS + 1; // inside eps window
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(nearEdge));
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();
      expect(result.current.controls.scrubT).toBe(nearEdge);
    });

    it("while live + t exactly at edge boundary → no enter", async () => {
      const { ses, result } = setup();
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(LIVE.latest - EPS));
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();
    });

    it("while DVR → does not call enter again, stays in DVR", async () => {
      const { ses, result } = setup();
      await act(async () => {
        await result.current.dvr.enter(1_030_000);
      });
      expect(result.current.dvr.isDvr).toBe(true);
      vi.clearAllMocks();

      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_025_000));
      });

      // Still in DVR, no new enter call
      expect(result.current.dvr.isDvr).toBe(true);
      expect(ses.enterReplay).not.toHaveBeenCalled();
    });

    it("while DVR → does NOT call dvr.enter again", async () => {
      const { ses, result } = setup();
      await act(async () => {
        await result.current.dvr.enter(1_030_000);
      });
      vi.clearAllMocks();

      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_025_000));
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();
    });

    it("respects custom liveEdgeEpsMs on commit", async () => {
      const { ses, result } = setup(1, 5_000);
      // 4999ms from edge → within 5000ms eps → commit is a no-op (no enter).
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(LIVE.latest - 4_999));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();

      // 5001ms from edge → outside eps → commit enters DVR (exactly once).
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(LIVE.latest - 5_001));
      });
      await act(async () => {
        result.current.controls.commitScrub();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
    });

    it("drag enters DVR once on first change, then previews via seek on subsequent ticks", async () => {
      const ses = makeFakeSession({ fresh: true, timeRange: LIVE });
      const { result } = renderHook(() => {
        const dvr = useReplayDvr({
          session: ses.session,
          enterReplay: ses.enterReplay,
          exitReplay: ses.exitReplay,
          liveTimeRange: LIVE,
          rate: 1,
          autoPlay: false,
        });
        const controls = useScrubberControls({ dvr, rate: 1 });
        return { dvr, controls };
      });

      // First drag tick past the edge → enter DVR once, paused (preview is
      // seek-driven, not playback).
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(ses.enterReplay).toHaveBeenCalledWith(1_030_000, expect.any(Object));
      expect(result.current.dvr.isDvr).toBe(true);
      const player = result.current.dvr.player!;
      expect(player.pause).toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();

      // Subsequent drag ticks → seek the same player (preview), no re-enter.
      // Seeks are coalesced to ONE per animation frame: two onChange in the same
      // frame collapse to a single seek to the LATEST target.
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_025_000));
        result.current.controls.onScrubChange(fakeChange(1_020_000));
        vi.advanceTimersByTime(20); // flush the coalesced requestAnimationFrame
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1); // still once
      // Coalesced: only the latest target is seeked, not the intermediate one.
      expect(player.seek).toHaveBeenCalledTimes(1);
      expect(player.seek).toHaveBeenCalledWith(1_020_000);
    });

    it("a burst of DVR drag ticks coalesces to one seek per frame (latest target)", async () => {
      const player = makeFakePlayer(1_050_000);
      const fakeDvr = {
        isDvr: true,
        player,
        frozenLatest: 1_060_000,
        effectiveTimeRange: LIVE,
        enter: vi.fn(async () => null),
        exit: vi.fn(),
      };
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr
        useScrubberControls({ dvr: fakeDvr as any, rate: 1 }),
      );

      await act(async () => {
        // 5 mousemoves within one frame → 5 onChange, but ZERO synchronous seeks.
        for (const t of [1_050_000, 1_045_000, 1_040_000, 1_035_000, 1_030_000]) {
          result.current.onScrubChange(fakeChange(t));
        }
      });
      expect(player.seek).not.toHaveBeenCalled(); // deferred to rAF

      await act(async () => {
        vi.advanceTimersByTime(20);
      }); // flush the frame
      expect(player.seek).toHaveBeenCalledTimes(1);
      expect(player.seek).toHaveBeenCalledWith(1_030_000); // latest target
    });

    it("commit flushes the pending coalesced seek and lands on the exact release t", async () => {
      const player = makeFakePlayer(1_050_000);
      const fakeDvr = {
        isDvr: true,
        player,
        frozenLatest: 1_060_000,
        effectiveTimeRange: LIVE,
        enter: vi.fn(async () => null),
        exit: vi.fn(),
      };
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr
        useScrubberControls({ dvr: fakeDvr as any, rate: 1 }),
      );

      await act(async () => {
        result.current.onScrubChange(fakeChange(1_040_000)); // schedules a frame seek
      });
      await act(async () => {
        result.current.commitScrub(); // flushes the pending rAF, seeks exact release t
      });
      // Mid-DVR commit seeks to the released position (and the stale frame seek
      // was cancelled — exactly one seek at the release point).
      expect(player.seek).toHaveBeenCalledTimes(1);
      expect(player.seek).toHaveBeenCalledWith(1_040_000);
    });

    it("drag-enter that loses the race re-arms; commit then enters and plays", async () => {
      // enterReplay resolves null on the FIRST (drag) call → the .then re-arms
      // enteredDuringDragRef (line 114). Since the drag never actually entered
      // DVR, commit takes the live-branch and enters once more (line 141).
      const ses = makeFakeSession({ fresh: true, timeRange: LIVE });
      const enterMock = ses.enterReplay as unknown as ReturnType<typeof vi.fn>;
      enterMock
        .mockResolvedValueOnce(null) // drag enter loses the race
        .mockResolvedValue(ses.player as never); // commit enter succeeds
      const { result } = renderHook(() => {
        const dvr = useReplayDvr({
          session: ses.session,
          enterReplay: ses.enterReplay,
          exitReplay: ses.exitReplay,
          liveTimeRange: LIVE,
          rate: 2,
          autoPlay: false,
        });
        const controls = useScrubberControls({ dvr, rate: 2 });
        return { dvr, controls };
      });

      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000)); // far past edge
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // Still live (drag enter returned null), so commit will enter.
      expect(result.current.dvr.isDvr).toBe(false);

      await act(async () => {
        result.current.controls.commitScrub();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // Two enters total: the null drag-enter + the commit-enter.
      expect(ses.enterReplay).toHaveBeenCalledTimes(2);
      expect(ses.player.play).toHaveBeenCalledWith(2);
    });
  });

  // ── commitScrub ───────────────────────────────────────────────────────────

  describe("commitScrub", () => {
    it("with null scrubT → no-op", async () => {
      const { ses, result } = setup();
      // No drag initiated — scrubT is null
      await act(async () => {
        result.current.controls.commitScrub();
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();
      expect(ses.exitReplay).not.toHaveBeenCalled();
    });

    it("live + t far from edge → enters DVR then calls play(rate)", async () => {
      const { ses, result } = setup(2);
      // Drag to a mid-timeline position
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000));
      });
      await act(async () => {
        result.current.controls.commitScrub();
        // Drain the dvr.enter(t).then(...) microtask chain so the play()
        // callback (the live-commit branch) actually runs.
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });

      expect(ses.enterReplay).toHaveBeenCalledWith(1_030_000, expect.any(Object));
      // autoPlay is false in the setup, but commitScrub manually calls play()
      expect(ses.player.play).toHaveBeenCalledWith(2);
    });

    it("live + t within liveEdgeEpsMs → no-op (micro-drag ignored)", async () => {
      const { ses, result } = setup();
      const nearEdge = LIVE.latest - EPS + 1;
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(nearEdge));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });

      expect(ses.enterReplay).not.toHaveBeenCalled();
      expect(result.current.controls.scrubT).toBeNull();
    });

    it("DVR + t near frozenLatest → exits DVR", async () => {
      const { ses, result } = setup();
      await act(async () => {
        await result.current.dvr.enter(1_030_000);
      });

      const frozenLatest = result.current.dvr.frozenLatest!;
      // Drag to within eps of frozen edge
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(frozenLatest - EPS + 1));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });

      expect(ses.exitReplay).toHaveBeenCalled();
      expect(result.current.dvr.isDvr).toBe(false);
    });

    it("DVR + t near the live edge with null frozenLatest → exits (?? range.latest)", async () => {
      // frozenLatest null → the exit threshold falls back to range.latest.
      const exit = vi.fn();
      const fakeDvr = {
        isDvr: true,
        player: makeFakePlayer(LIVE.latest),
        frozenLatest: null,
        effectiveTimeRange: LIVE,
        enter: vi.fn(async () => null),
        exit,
      };
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr
        useScrubberControls({ dvr: fakeDvr as any, rate: 1 }),
      );
      await act(async () => {
        result.current.onScrubChange(fakeChange(LIVE.latest - EPS + 1)); // within eps of edge
      });
      await act(async () => {
        result.current.commitScrub();
      });
      expect(exit).toHaveBeenCalled();
    });

    it("DVR + t in middle → seeks to scrubT and plays at the given rate", async () => {
      const { ses, result } = setup(1.5);
      await act(async () => {
        await result.current.dvr.enter(1_050_000);
      });

      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_025_000));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });

      expect(ses.player.seek).toHaveBeenCalledWith(1_025_000);
      expect(ses.player.play).toHaveBeenCalledWith(1.5);
      expect(ses.exitReplay).not.toHaveBeenCalled();
      expect(result.current.dvr.isDvr).toBe(true);
    });

    it("resets scrubT to null after commit", async () => {
      const { result } = setup();
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000));
      });
      expect(result.current.controls.scrubT).toBe(1_030_000);

      await act(async () => {
        result.current.controls.commitScrub();
      });
      expect(result.current.controls.scrubT).toBeNull();
    });

    it("respects custom liveEdgeEpsMs on commit", async () => {
      const { ses, result } = setup(1, 5_000);
      // Drag to 4999ms from edge → inside eps → commit should no-op
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(LIVE.latest - 4_999));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();
    });

    it("DVR + t uses frozenLatest as fallback when frozenLatest is null", async () => {
      const { ses, result } = setup();
      await act(async () => {
        await result.current.dvr.enter(1_030_000);
      });

      // Drag to within eps of LIVE.latest (which equals frozenLatest after clamping)
      const frozenLatest = result.current.dvr.frozenLatest ?? LIVE.latest;
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(frozenLatest - EPS + 1));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });

      expect(ses.exitReplay).toHaveBeenCalled();
    });

    it("drag-entry fires enter once on change + pauses; commit does NOT double-enter (isolated fake dvr)", async () => {
      // Hand-built dvr whose isDvr stays false (never re-renders to true), with
      // a manually-deferred enter, so we can pin the anti-double-enter guarantee
      // deterministically: the drag enters once on change, and a commit while
      // that enter is STILL IN FLIGHT chains seek+play onto it instead of firing
      // a second enter that would race the first.
      const player = makeFakePlayer(0);
      let resolveEnter!: (p: FakePlayer) => void;
      const enter = vi.fn(
        () =>
          new Promise<FakePlayer>((resolve) => {
            resolveEnter = resolve;
          }),
      );
      const fakeDvr = {
        isDvr: false,
        player: null,
        frozenLatest: null,
        effectiveTimeRange: LIVE,
        enter,
        exit: vi.fn(),
      };

      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake dvr for isolation
        useScrubberControls({ dvr: fakeDvr as any, rate: 3 }),
      );

      await act(async () => {
        result.current.onScrubChange(fakeChange(LIVE.earliest + 5_000)); // far from edge
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // Entered once on the drag; still in flight, so nothing played yet.
      expect(enter).toHaveBeenCalledTimes(1);
      expect(enter).toHaveBeenCalledWith(LIVE.earliest + 5_000);

      await act(async () => {
        result.current.commitScrub();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // No second enter on commit — the in-flight drag-enter is chained instead.
      expect(enter).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveEnter(player);
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // Drag's pause handler ran first, then the commit chain seeks the release
      // point and resumes playback at the given rate.
      expect(player.pause).toHaveBeenCalled();
      expect(player.seek).toHaveBeenCalledWith(LIVE.earliest + 5_000);
      expect(player.play).toHaveBeenCalledWith(3);
    });

    // Regression (Bug 1): with the REAL useReplayDvr + a fresh-player-per-enter
    // session, a live→past commit must autoplay the player that enter() actually
    // created — NOT the stale `dvr.player` captured by commitScrub's closure
    // (which is still null at live-render time). The default stable-player fake
    // masks this; `fresh: true` reproduces the production async-setPlayer split.
    it("live → past commit autoplays the FRESH player (autoPlay:false)", async () => {
      const ses = makeFakeSession({ fresh: true, timeRange: LIVE });
      const { result } = renderHook(() => {
        const dvr = useReplayDvr({
          session: ses.session,
          enterReplay: ses.enterReplay,
          exitReplay: ses.exitReplay,
          liveTimeRange: LIVE,
          rate: 1,
          autoPlay: false, // worker-fan-out's setting — commit owns the play()
        });
        const controls = useScrubberControls({ dvr, rate: 1 });
        return { dvr, controls };
      });

      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_030_000));
      });
      await act(async () => {
        result.current.controls.commitScrub();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });

      expect(result.current.dvr.isDvr).toBe(true);
      const activePlayer = result.current.dvr.player;
      expect(activePlayer).not.toBeNull();
      // The active (fresh) player is the one that got played.
      expect(activePlayer!.play).toHaveBeenCalledWith(1);
    });

    // Regression (Bug 2): a realistic drag (many onScrubChange) then release must
    // reliably end in DVR. Speculative enter-on-every-change used to race the
    // commit enter and intermittently leave isDvr false. Now: zero enters on
    // change, exactly one on commit.
    it("burst of onScrubChange enters DVR exactly once (flag-gated), commit resumes", async () => {
      const ses = makeFakeSession({ fresh: true, timeRange: LIVE });
      const { result } = renderHook(() => {
        const dvr = useReplayDvr({
          session: ses.session,
          enterReplay: ses.enterReplay,
          exitReplay: ses.exitReplay,
          liveTimeRange: LIVE,
          rate: 1,
          autoPlay: false,
        });
        const controls = useScrubberControls({ dvr, rate: 1 });
        return { dvr, controls };
      });

      // A synchronous burst of 5 drag ticks: isDvr stays false the whole batch,
      // so the FLAG (set on tick 1) is what suppresses ticks 2-5 → exactly one
      // enter. This is the precise window the old multi-enter code left open.
      await act(async () => {
        for (const t of [1_050_000, 1_045_000, 1_040_000, 1_035_000, 1_030_000]) {
          result.current.controls.onScrubChange(fakeChange(t));
        }
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(result.current.dvr.isDvr).toBe(true);

      // Commit resumes playback from the release point — no second enter.
      await act(async () => {
        result.current.controls.commitScrub();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });

      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(result.current.dvr.isDvr).toBe(true);
      expect(result.current.dvr.player).not.toBeNull();
    });
  });

  // ── rate forwarding ────────────────────────────────────────────────────────

  describe("rate forwarding", () => {
    it("default rate=1 is used when not specified", async () => {
      const { ses, result } = setup(); // no rate passed
      await act(async () => {
        await result.current.dvr.enter(1_050_000);
      });
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_025_000));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });
      expect(ses.player.play).toHaveBeenCalledWith(1);
    });
  });

  // ── in-flight drag-enter (commit races enterReplay) ───────────────────────
  //
  // Regression for the intermittent "dot jumps left after returning to live"
  // bug: a live→past drag fires an ASYNC dvr.enter() (real enterReplay does an
  // IDB flush + getTimeRange, tens-to-hundreds of ms). If the user dragged
  // back to the live edge and released BEFORE it resolved, commitScrub used to
  // do nothing — the uncancelled enter then landed late and flipped the UI
  // into DVR paused at the stale drag position.

  describe("in-flight drag-enter (commit races enterReplay)", () => {
    function setupHeld(rate = 1, timeRange = LIVE) {
      const ses = makeFakeSession({ fresh: true, timeRange });
      ses.holdEnter();
      const { result } = renderHook(() => {
        const dvr = useReplayDvr({
          session: ses.session,
          enterReplay: ses.enterReplay,
          exitReplay: ses.exitReplay,
          liveTimeRange: timeRange,
          rate,
          autoPlay: false,
        });
        const controls = useScrubberControls({ dvr, rate });
        return { dvr, controls };
      });
      return { ses, result };
    }

    it("release at the live edge before the drag-enter resolves cancels it — never enters DVR", async () => {
      const { ses, result } = setupHeld();

      // Drag past the edge → enter fired but parked (unresolved).
      await act(async () => {
        result.current.controls.beginScrub();
        result.current.controls.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(result.current.dvr.isDvr).toBe(false);

      // Drag back to the live edge and release while the enter is in flight.
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(LIVE.latest));
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });
      // The commit cancelled the pending enter (generation bump via exit()).
      expect(ses.exitReplay).toHaveBeenCalled();

      // The stale enter resolving later must NOT re-enter DVR.
      await act(async () => {
        await ses.releaseEnter();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(result.current.dvr.isDvr).toBe(false);
      expect(result.current.dvr.player).toBeNull();
      expect(result.current.dvr.frozenLatest).toBeNull();
      // The orphaned player was disposed, not leaked.
      expect(ses.player.dispose).toHaveBeenCalled();
    });

    it("release mid-past while the drag-enter is in flight seeks+plays at the release point", async () => {
      const { ses, result } = setupHeld(2);

      await act(async () => {
        result.current.controls.beginScrub();
        result.current.controls.onScrubChange(fakeChange(1_040_000));
        result.current.controls.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      // Exactly one enter (at the first past-edge tick), still in flight.
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(ses.enterReplay).toHaveBeenCalledWith(1_040_000, expect.any(Object));

      await act(async () => {
        result.current.controls.commitScrub();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      // No second enter racing the first.
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);

      await act(async () => {
        await ses.releaseEnter();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(result.current.dvr.isDvr).toBe(true);
      const player = result.current.dvr.player!;
      // Drag handler paused first; commit chain then seeks the RELEASE point
      // (not the 1_040_000 entry point) and resumes at the commit rate.
      expect(player.pause).toHaveBeenCalled();
      expect(player.seek).toHaveBeenCalledWith(1_030_000);
      expect(player.play).toHaveBeenCalledWith(2);
    });

    it("unaligned frozenLatest: releasing at the slider max exits DVR", async () => {
      // frozenLatest % 1000 = 700 > eps 250: the slider max (snap floor) is the
      // closest reachable value, and releasing there must count as "at the
      // live edge" — the unsnapped comparison used to miss it ~75% of the time.
      const UNALIGNED = { earliest: 1_000_000, latest: 1_060_700 };
      const { ses, result } = setupHeld(1, UNALIGNED);
      await ses.releaseEnter(); // don't hold for this one
      await act(async () => {
        await result.current.dvr.enter(1_030_000);
      });
      expect(result.current.dvr.frozenLatest).toBe(1_060_700);

      await act(async () => {
        result.current.controls.beginScrub();
        result.current.controls.onScrubChange(fakeChange(1_060_000)); // slider max
        vi.advanceTimersByTime(20); // flush the coalesced preview seek
      });
      await act(async () => {
        result.current.controls.commitScrub();
      });
      expect(ses.exitReplay).toHaveBeenCalled();
      expect(result.current.dvr.isDvr).toBe(false);
    });

    it("unaligned live latest: a drag tick at the slider max does not enter DVR", async () => {
      const UNALIGNED = { earliest: 1_000_000, latest: 1_060_700 };
      const { ses, result } = setupHeld(1, UNALIGNED);

      // At the slider max (snap floor of 1_060_700) → within the snapped-edge
      // eps window → no spurious enter.
      await act(async () => {
        result.current.controls.beginScrub();
        result.current.controls.onScrubChange(fakeChange(1_060_000));
      });
      expect(ses.enterReplay).not.toHaveBeenCalled();

      // One slider step left of max → genuinely past → enters once.
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_059_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1);
      expect(ses.enterReplay).toHaveBeenCalledWith(1_059_000, expect.any(Object));
    });

    it("mid-drag auto-exit: releasing mid-past after the entered player ended re-enters at the release point", async () => {
      const ses = makeFakeSession({ fresh: true, timeRange: LIVE });
      const { result } = renderHook(() => {
        const dvr = useReplayDvr({
          session: ses.session,
          enterReplay: ses.enterReplay,
          exitReplay: ses.exitReplay,
          liveTimeRange: LIVE,
          rate: 1,
          autoPlay: false, // autoExitToLive stays default true
        });
        const controls = useScrubberControls({ dvr, rate: 1 });
        return { dvr, controls };
      });

      // Drag-enter resolves normally → DVR active.
      await act(async () => {
        result.current.controls.beginScrub();
        result.current.controls.onScrubChange(fakeChange(1_030_000));
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(result.current.dvr.isDvr).toBe(true);

      // The player hits the frozen edge mid-drag → autoExitToLive tears it down.
      await act(async () => {
        ses.player.emitEnd();
      });
      expect(result.current.dvr.isDvr).toBe(false);

      // Still dragging (flag gates a re-enter on change), then release mid-past.
      await act(async () => {
        result.current.controls.onScrubChange(fakeChange(1_020_000));
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
      expect(ses.enterReplay).toHaveBeenCalledTimes(1); // gated — no re-enter yet

      await act(async () => {
        result.current.controls.commitScrub();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // Commit recovers with a fresh enter at the release point and plays.
      expect(ses.enterReplay).toHaveBeenCalledTimes(2);
      expect(ses.enterReplay).toHaveBeenLastCalledWith(1_020_000, expect.any(Object));
      expect(result.current.dvr.isDvr).toBe(true);
      expect(ses.player.play).toHaveBeenCalledWith(1);
    });
  });
});

it("ignores a cancelled animation callback and supports unsnapped edges", () => {
  const player = makeFakePlayer(1_030_000);
  let callback!: FrameRequestCallback;
  const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    callback = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", undefined);
  const dvr = {
    isDvr: true,
    player,
    frozenLatest: LIVE.latest,
    effectiveTimeRange: LIVE,
    enter: vi.fn(),
    exit: vi.fn(),
  } as unknown as ReturnType<typeof useReplayDvr>;
  const view = renderHook(() => useScrubberControls({ dvr, snapMs: 0 }));
  act(() => view.result.current.onScrubChange(fakeChange(1_020_000)));
  act(() => view.result.current.commitScrub());
  const calls = player.seek.mock.calls.length;
  act(() => callback(0));
  expect(player.seek).toHaveBeenCalledTimes(calls);
  view.unmount();
  raf.mockRestore();
  vi.unstubAllGlobals();
});
it("does not play when a pending drag entry returns no player", async () => {
  let release!: (p: null) => void;
  const enter = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        release = resolve;
      }),
  );
  const dvr = {
    isDvr: false,
    player: null,
    frozenLatest: null,
    effectiveTimeRange: LIVE,
    enter,
    exit: vi.fn(),
  } as unknown as ReturnType<typeof useReplayDvr>;
  const view = renderHook(() => useScrubberControls({ dvr }));
  act(() => view.result.current.onScrubChange(fakeChange(1_020_000)));
  act(() => view.result.current.commitScrub());
  await act(async () => {
    release(null);
  });
  expect(enter).toHaveBeenCalledOnce();
  view.unmount();
});
