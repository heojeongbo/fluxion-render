import type {
  FluxionHost,
  LineLayerHandle,
  LineSample,
} from "@heojeongbo/fluxion-render";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BaseChannel } from "../../../shared/model/base-channel";
import type { ReplayStorage as ReplayStore } from "../../../shared/model/storage";

export interface UseChartLiveBackfillOptions<T> {
  /** Host returned by `<FluxionCanvas onReady={setHost}>`. `null` while mounting. */
  host: FluxionHost | null;
  /** Store backing the recorder. The hook flushes it before querying. */
  store: ReplayStore | null;
  /** Channel to read from. */
  channel: BaseChannel<T>;
  /** Target line layer id. Defaults to `channel.channelId`. */
  layerId?: string;
  /**
   * Visible window in ms. Backfill queries `[now - windowMs, now]` from
   * the store and pushes that batch into the chart.
   */
  windowMs: number;
  /** Extract the chart y-value from a decoded frame. */
  pickValue: (data: T) => number;
  /**
   * Subtracted from every `t` before pushing to the chart layer — same
   * meaning as `useChartReplay.timeOrigin`. Required to keep the Float32
   * wire format precise. Pass the same value the chart's `axisGridLayer`
   * uses for `timeOrigin`.
   */
  timeOrigin?: number;
  /**
   * When `true`, run one backfill on mount and again every time `active`
   * transitions from `false` → `true`. When `false`, no-op.
   *
   * In chart-replay this is wired to `isLive`: it fires on initial mount
   * (fills with whatever the store already has) and on every DVR→Live
   * transition so the chart picks up the data that accumulated during
   * time-travel without waiting for live `push()` to catch up.
   */
  active: boolean;
}

/**
 * Live-mode mirror of `useChartReplay`'s hydrate: on every transition
 * into live mode, flush the recorder's pending batch, query the most
 * recent `windowMs` of frames for `channel`, and reset+push the chart
 * layer so the user sees the just-recorded data immediately instead of
 * an empty axis until streaming `push()` catches up.
 *
 * Pair with `useFluxionStream` (which handles the ongoing live push)
 * and `useChartReplay` (which owns the chart during DVR). The three
 * hooks cover the full lifecycle: live → DVR enter (replay hydrate) →
 * DVR exit (this hook re-hydrates from recent live frames) → live.
 *
 * @example
 * useChartLiveBackfill({
 *   host, store: session?.store ?? null, channel,
 *   layerId: "line", windowMs: 5_000, timeOrigin,
 *   pickValue: (d) => d.value,
 *   active: !dvr.isDvr,
 * });
 */
export interface UseChartLiveBackfillResult {
  /**
   * True while the async IDB backfill (flush → query → pushBatch) is in
   * flight. The bridge uses this to suppress live `handle.push()` calls
   * during the window — they would be wiped by the upcoming `reset()` +
   * `pushBatch()` anyway, so holding them prevents a visible "jump" when
   * the backfill lands and the chart momentarily shows only a single
   * latest sample before the full window arrives.
   */
  isBackfilling: boolean;
}

export function useChartLiveBackfill<T>(
  opts: UseChartLiveBackfillOptions<T>,
): UseChartLiveBackfillResult {
  const { host, store, channel, windowMs, pickValue, active } = opts;
  const layerId = opts.layerId ?? channel.channelId;
  const timeOrigin = opts.timeOrigin ?? 0;

  const [isBackfilling, setIsBackfilling] = useState(false);

  // Capture pickValue in a ref so an inline-arrow callback doesn't churn
  // the effect on every render.
  const pickRef = useRef(pickValue);
  pickRef.current = pickValue;

  const handle = useMemo<LineLayerHandle | null>(
    () => (host ? host.line(layerId) : null),
    [host, layerId],
  );

  useEffect(() => {
    if (!active || !handle || !store) return;

    // Deliberately NO clear here. Clearing the chart before the async backfill
    // batch is ready opened a visible empty-render window (~tens of ms across
    // `flush()` + `getFramesByChannel()`) — the worker drew an empty chart, then
    // the full window popped in: the DVR→Live "flicker". We now keep whatever
    // live-pushed data is on screen until the post-query reset + pushBatch below
    // swap it in one FIFO worker turn (no `await` between them → atomic).
    //
    // The stale `reset(dvrT)` this sync reset used to race against is now
    // suppressed at its source: useChartReplay re-checks `cancelled` immediately
    // before its chart write, so a just-disposed DVR hydrate can no longer emit
    // it. The backfill's reset+pushBatch are therefore the last writes and win.
    setIsBackfilling(true);

    let cancelled = false;
    void (async () => {
      try {
        // Commit any in-memory frames so the query reflects everything the
        // recorder has accepted — including frames pushed during the DVR
        // session we're transitioning out of.
        await store.flush();
        if (cancelled) return;

        const now = Date.now();
        const frames = await store.getFramesByChannel(
          channel.channelId,
          now - windowMs,
          now,
        );
        if (cancelled) return;

        const batch: LineSample[] = frames.map((f) => ({
          t: f.t - timeOrigin,
          y: pickRef.current(channel.decode(f.payload) as T),
        }));
        // Clear the stale DVR-era ring, but DO NOT rewind the axis here.
        // `viewport.latestT` is GLOBAL to the host — shared by every layer.
        // Passing `now` would yank ALL layers' time windows forward to
        // `[now - windowMs, now]` immediately, blanking any sibling layer whose
        // own backfill hasn't landed yet (its ring still holds old DVR-era
        // samples that now fall outside the window). So we clear ring-only
        // (reset() → CLEAR_DATA with latestT undefined → ring cleared, latestT
        // untouched) and let the pushBatch below advance latestT to ~now via
        // setData — monotonically, and only once real data backing the new
        // window is present. The window never jumps into an empty region.
        handle.reset();
        if (batch.length > 0) handle.pushBatch(batch);
      } catch {
        // Store may have been disposed mid-flight; ignore.
      } finally {
        if (!cancelled) setIsBackfilling(false);
      }
    })();

    return () => {
      cancelled = true;
      setIsBackfilling(false);
    };
  }, [active, handle, store, channel, windowMs, timeOrigin]);

  return { isBackfilling };
}
