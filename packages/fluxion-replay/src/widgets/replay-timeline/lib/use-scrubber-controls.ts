import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayPlayer } from "../../../features/player/model/replay-player";
import type { UseReplayDvrResult } from "../../dvr/lib/use-replay-dvr";

export interface UseScrubberControlsOptions {
  /** DVR controller from `useReplayDvr`. */
  dvr: UseReplayDvrResult;
  /**
   * Playback rate passed to `player.play()` when the user commits a scrub in
   * DVR mode or after entering DVR from the live edge. Default `1`.
   */
  rate?: number;
  /**
   * Distance from the live edge (in milliseconds) within which a scrub target
   * is treated as "back to live" rather than a DVR seek. Measured from the
   * SNAPPED edge (see `snapMs`), since the slider only emits snapped values.
   * Prevents accidental DVR entry from micro-drags near the right edge.
   * Default `250`.
   */
  liveEdgeEpsMs?: number;
  /**
   * Snap quantum (ms) the paired slider quantizes its emitted values to —
   * keep equal to `useReplayScrubber`'s `snapMs` (both default `1000`).
   * Live-edge checks compare the drag value against the SNAPPED edge
   * (`floor(edge / snapMs) * snapMs`): the slider's max is the snapped
   * (floored) latest, so a thumb released at the far right reads up to
   * `snapMs - 1` ms below the raw edge — an unsnapped comparison would miss
   * the `liveEdgeEpsMs` window ~`(snapMs - eps) / snapMs` of the time and
   * turn a "return to live" release into a near-edge DVR seek. Set `<= 0`
   * to disable snapping (raw-edge comparison) when the slider input is not
   * quantized.
   */
  snapMs?: number;
}

export interface UseScrubberControlsResult {
  /**
   * The current drag-preview position in milliseconds, or `null` when the
   * user is not actively dragging. Wire this to `useReplayScrubber`'s
   * `scrubT` option so the scrubber cursor tracks the drag position.
   */
  scrubT: number | null;
  /**
   * Pointer-down handler for `<input type="range">`. Wire to `onPointerDown`
   * (and/or `onMouseDown`/`onTouchStart`). Resets the per-gesture entry guard at
   * the start of each drag so a previous gesture whose release was lost can't
   * permanently block live→DVR entry. Recommended for robustness; without it the
   * guard only resets on `commitScrub`.
   */
  beginScrub: () => void;
  /**
   * `onChange` handler for `<input type="range">`. Call on every drag event.
   * In live mode it enters DVR exactly ONCE per drag — the first time the user
   * drags past the live edge — entering paused so the chart previews the past
   * frame at the drag position. Every subsequent drag tick seeks synchronously,
   * updating the preview without re-entering. Resumes playback on commit.
   */
  onScrubChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /**
   * Commit handler for `<input type="range">`. Call on `onMouseUp`,
   * `onTouchEnd`, and `onKeyUp` to finalise the scrub target:
   *
   * - Live → near live edge (no drag-enter started): no-op (micro-drag
   *   tolerance).
   * - Live → past live edge: enter DVR at `scrubT` then start playing.
   * - Live with this gesture's drag-enter still in flight → near live edge:
   *   CANCEL it via `dvr.exit()` (generation bump) so the late-resolving
   *   enter can't flip the UI back into DVR at a stale drag position.
   * - Live with the drag-enter still in flight → mid-timeline: chain onto
   *   the pending enter so playback starts at the RELEASE point.
   * - DVR → near frozen edge: exit DVR, return to live.
   * - DVR → mid-timeline: seek to `scrubT` and resume playing.
   *
   * All edge comparisons use the snapped edge (see `snapMs`).
   */
  commitScrub: () => void;
}

/**
 * Encapsulates the "drag preview → release commit" state machine that the
 * replay scrubber uses to coordinate live↔DVR mode transitions.
 *
 * Pair with `useReplayScrubber` (for the scrubber bounds) and
 * `useReplayDvr` (for the underlying mode state).
 *
 * @example
 * const dvr = useReplayDvr({ session, enterReplay, exitReplay, liveTimeRange, rate });
 * const { scrubT, onScrubChange, commitScrub } = useScrubberControls({ dvr, rate });
 * const { min, max, value } = useReplayScrubber({ ..., scrubT });
 *
 * <input
 *   type="range" min={min} max={max} value={value} step={1000}
 *   onChange={onScrubChange}
 *   onMouseUp={commitScrub} onTouchEnd={commitScrub} onKeyUp={commitScrub}
 * />
 */
export function useScrubberControls(
  opts: UseScrubberControlsOptions,
): UseScrubberControlsResult {
  const { dvr, rate = 1, liveEdgeEpsMs = 250, snapMs = 1000 } = opts;

  const [scrubT, setScrubT] = useState<number | null>(null);

  // Floor an edge timestamp to the slider's snap quantum so edge checks
  // compare like-with-like: the slider only emits snapped values, so the
  // raw edge is unreachable whenever it falls mid-quantum.
  const snapEdge = useCallback(
    (edge: number) => (snapMs > 0 ? Math.floor(edge / snapMs) * snapMs : edge),
    [snapMs],
  );

  // Keep rate in a ref so commitScrub's useCallback doesn't need to list it
  // as a dep — prevents a new commitScrub identity on every rate change, which
  // would force consumers to re-bind event handlers.
  const rateRef = useRef(rate);
  rateRef.current = rate;

  // True once THIS drag gesture has initiated a live→DVR enter. Gates entry to
  // exactly ONE enter() per drag — a SYNCHRONOUS gate, unlike `dvr.isDvr` which
  // only flips after the async setPlayer lands. Without it a synchronous burst
  // of onChange events would fire N concurrent enters that race the commit
  // enter (the flaky-entry bug). Reset at commit (gesture end).
  const enteredDuringDragRef = useRef(false);

  // The live→DVR enter started by THIS drag gesture, while still relevant.
  // commitScrub consumes it to either CANCEL it (released back at the live
  // edge) or chain seek+play onto it (released mid-past) — previously an
  // uncancelled in-flight enter resolved AFTER the release and flipped the
  // UI into DVR paused at the stale drag position (the intermittent
  // "dot jumps left after returning to live" bug).
  const pendingEnterRef = useRef<{
    promise: Promise<ReplayPlayer | null>;
    resolved: boolean;
  } | null>(null);

  // Reset the per-gesture entry flag at the START of every drag. The flag is
  // otherwise only cleared in commitScrub, so a gesture whose release was lost
  // (pointer-up off the input/window, or the handler swapped out mid-gesture)
  // leaves it stuck `true` — after which EVERY future live→DVR drag is silently
  // gated out (`!enteredDuringDragRef.current` is false) and the scrubber thumb
  // just springs back to live. pointerdown fires reliably at the start of each
  // drag, so it un-wedges the flag. Wire to the scrubber input's onPointerDown.
  const beginScrub = useCallback(() => {
    enteredDuringDragRef.current = false;
    // Drop a stale pending enter from a gesture whose release was lost, for
    // the same reason — it must not be cancelled/chained by THIS gesture.
    pendingEnterRef.current = null;
  }, []);

  // Coalesce drag-time seeks to ONE per animation frame. A mousemove fires
  // onChange ~60×/s; each seek triggers a full chart hydrate (IDB query +
  // decode), which at 500 Hz is hundreds of ms — so seeking on every tick makes
  // scrubbing janky. We keep only the latest target and seek once per frame.
  // No data is dropped: the chart still lands on every settled position; only
  // redundant intra-frame seeks are skipped.
  const pendingSeekRef = useRef<{ t: number; raf: number } | null>(null);

  const flushPendingSeek = useCallback(() => {
    const pending = pendingSeekRef.current;
    if (!pending) return;
    if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(pending.raf);
    pendingSeekRef.current = null;
  }, []);

  const scheduleSeek = useCallback(
    (t: number) => {
      // requestAnimationFrame may be absent (SSR/tests) — seek immediately then.
      /* v8 ignore start -- SSR/no-rAF fallback; happy-dom always provides rAF */
      if (typeof requestAnimationFrame === "undefined") {
        dvr.player?.seek(t);
        return;
      }
      /* v8 ignore stop */
      if (pendingSeekRef.current) {
        // Same frame already scheduled → just update the target.
        pendingSeekRef.current.t = t;
        return;
      }
      const raf = requestAnimationFrame(() => {
        // A cancelled callback can still arrive in the same animation frame.
        const pending = pendingSeekRef.current;
        if (!pending) return;
        const target = pending.t;
        pendingSeekRef.current = null;
        dvr.player?.seek(target);
      });
      pendingSeekRef.current = { t, raf };
    },
    [dvr],
  );

  const onScrubChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const range = dvr.effectiveTimeRange;
      if (!range) return;
      const t = Number(e.target.value);
      setScrubT(t);

      if (dvr.isDvr) {
        // Already in DVR — preview the past at the drag position, coalesced to
        // one seek per animation frame so a fast drag doesn't fire a hydrate
        // (IDB query + decode) on every mousemove.
        scheduleSeek(t);
        return;
      }

      // Live mode: enter DVR EXACTLY ONCE per drag, the first time the user
      // drags meaningfully past the live edge — so the UI switches to DVR and
      // the chart previews mid-drag. The flag (not dvr.isDvr, which flips only
      // after the async setPlayer) gates the synchronous burst to one enter.
      if (!enteredDuringDragRef.current && t < snapEdge(range.latest) - liveEdgeEpsMs) {
        enteredDuringDragRef.current = true;
        // Keep the raw promise so commitScrub can cancel or chain onto it.
        // This pause/re-arm handler is attached FIRST — .then callbacks on
        // the same promise run FIFO, so a commit-chained seek+play always
        // runs after the pause and wins.
        const entry = { promise: dvr.enter(t), resolved: false };
        pendingEnterRef.current = entry;
        void entry.promise.then((p) => {
          entry.resolved = true;
          if (p) {
            // Preview is driven by seek→onSeek→hydrate; we do NOT want playback
            // while the user is still dragging. Force paused regardless of the
            // DVR hook's autoPlay option (which this hook can't see). pause()
            // is a no-op when already idle.
            p.pause();
          } else {
            // enter() no-oped / lost a race — re-arm so a later tick can retry.
            enteredDuringDragRef.current = false;
          }
        });
      }
      // After isDvr flips, subsequent ticks hit the seek branch above — preview
      // continues with no further enter.
    },
    [dvr, liveEdgeEpsMs, snapEdge, scheduleSeek],
  );

  const commitScrub = useCallback(() => {
    const t = scrubT;
    const range = dvr.effectiveTimeRange;
    setScrubT(null);
    // Cancel any frame-coalesced seek — the release seeks to the exact final t.
    flushPendingSeek();
    // End of gesture → re-arm for the next drag.
    const enteredThisDrag = enteredDuringDragRef.current;
    enteredDuringDragRef.current = false;
    const pendingEnter = pendingEnterRef.current;
    pendingEnterRef.current = null;
    if (t == null || !range) return;

    if (!dvr.isDvr) {
      const liveEdge = snapEdge(range.latest) - liveEdgeEpsMs;
      if (!enteredThisDrag) {
        // Live mode AND this drag never entered DVR (e.g. a quick click without
        // a past-edge drag). Play the RETURNED player, not `dvr.player` (still
        // null in this closure until the async setPlayer lands).
        if (t < liveEdge) {
          void dvr.enter(t).then((p) => p?.play(rateRef.current));
        }
        return;
      }
      // This gesture DID start a drag-enter, yet we're still (or again) live.
      if (t >= liveEdge) {
        // Released back at the live edge → CANCEL the in-flight enter. exit()
        // bumps the DVR generation, so when the enter resolves it disposes its
        // player and never touches state — without this the late enter lands
        // and yanks the UI back into DVR at the stale drag position (the
        // intermittent "dot jumps left after returning to live"). Safe while
        // not yet in DVR: setPlayer(null) bails and exitReplay is idempotent.
        dvr.exit();
      } else if (pendingEnter && !pendingEnter.resolved) {
        // Released mid-past with the enter still in flight → start playback at
        // the RELEASE point once it lands (the drag's pause handler was
        // attached first and runs first). A null player means the enter lost a
        // race to a newer enter()/exit() — yield to that newer action rather
        // than re-entering, which could kill a gesture already in progress.
        void pendingEnter.promise.then((p) => {
          if (!p) return;
          p.seek(t);
          p.play(rateRef.current);
        });
      } else {
        // The drag-enter already resolved yet we're live again — a mid-drag
        // autoExitToLive (player hit the frozen edge) tore it down. Re-enter
        // at the release point; its generation bump supersedes anything stale.
        void dvr.enter(t).then((p) => p?.play(rateRef.current));
      }
    } else if (t >= snapEdge(dvr.frozenLatest ?? range.latest) - liveEdgeEpsMs) {
      // Pulled back to the live edge → exit DVR.
      dvr.exit();
    } else {
      // Mid-DVR seek: snap to the released position and resume playback.
      dvr.player?.seek(t);
      dvr.player?.play(rateRef.current);
    }
  }, [dvr, scrubT, liveEdgeEpsMs, snapEdge, flushPendingSeek]);

  // Cancel any in-flight coalesced seek on unmount.
  useEffect(() => () => flushPendingSeek(), [flushPendingSeek]);

  // Safety net for a lost release. `commitScrub` (onMouseUp/onTouchEnd/onKeyUp)
  // is the normal place the per-gesture entry guard is cleared — but a pointer
  // released OFF the slider (common when dragging a thin timeline bar quickly)
  // never fires those, so without `beginScrub` (onPointerDown) wired the guard
  // would stay stuck `true` and silently gate out EVERY future live→DVR drag
  // (the "after a while, dragging to the past stops working" bug). A window-
  // level pointerup/pointercancel always fires, so re-arm the guard there.
  //
  // The re-arm is DEFERRED to a macrotask: on a normal release over the input,
  // `pointerup` fires BEFORE the input's `mouseup`/`commitScrub`, so an
  // immediate reset would clear the flag commitScrub still needs to read
  // (cancel-vs-chain decision). Deferring lets commitScrub run first; the
  // late reset is then a harmless no-op (commit already set it false). On a
  // lost release no commit runs, so this deferred reset is the only un-wedge.
  useEffect(() => {
    /* v8 ignore start -- SSR guard; happy-dom always provides window */
    if (typeof window === "undefined") return;
    /* v8 ignore stop */
    const rearm = () => {
      setTimeout(() => {
        enteredDuringDragRef.current = false;
      }, 0);
    };
    window.addEventListener("pointerup", rearm);
    window.addEventListener("pointercancel", rearm);
    return () => {
      window.removeEventListener("pointerup", rearm);
      window.removeEventListener("pointercancel", rearm);
    };
  }, []);

  return { scrubT, beginScrub, onScrubChange, commitScrub };
}
