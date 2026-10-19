import type { FluxionHost } from "@heojeongbo/fluxion-render";
import { useFluxionStream } from "@heojeongbo/fluxion-render/react";
import { useRef } from "react";
import type { ReplaySession } from "../../../features/session/model/replay-session";
import type { BaseChannel } from "../../../shared/model/base-channel";
import type { ReplayStorage } from "../../../shared/model/storage";
import type { UseReplayDvrResult } from "../../dvr/lib/use-replay-dvr";
import { useChartLiveBackfill } from "./use-chart-live-backfill";
import { type UseChartReplayResult, useChartReplay } from "./use-chart-replay";

export interface UseChartReplayBridgeOptions<T> {
  /** Host from `<FluxionCanvas onReady={setHost}>`. `null` while mounting. */
  host: FluxionHost | null;
  /** Session — needed for live recording (`session.record`) and for the
   *  replay-mode chart hydrate (`session.store`). `null` while opening. */
  session: ReplaySession<ReplayStorage> | null;
  /** DVR controller from `useReplayDvr`. */
  dvr: UseReplayDvrResult;
  /**
   * Whether the chart is currently in live mode. Conventionally
   * `!dvr.isDvr`. Lifted to a prop so the bridge can short-circuit live
   * pushes during DVR without subscribing to dvr internals.
   */
  isLive: boolean;
  /** Channel to bridge. The bridge subscribes to this channel only. */
  channel: BaseChannel<T>;
  /** Layer id on the chart. Defaults to `channel.channelId`. */
  layerId?: string;
  /** Visible window in ms — must match `axisGridLayer({ timeWindowMs })`. */
  windowMs: number;
  /** Forwarded to `useChartReplay`: ±ms fetched + cached around the window so a
   *  re-seek within the margin is an instant cache hit. Default 3000. */
  prefetchMarginMs?: number;
  /** Sample rate (Hz) for the live pump. Default `20`. */
  liveHz?: number;
  /** Live data producer. Called every tick of the live pump (regardless of
   *  mode); the returned value is recorded into the session and, when in
   *  live mode, pushed onto the chart layer. */
  produce: (wallT: number) => T;
  /** Extract the chart's y-value from a decoded datum. */
  pickValue: (data: T) => number;
  /** Float32 wire-format origin — match `axisGridLayer({ timeOrigin })`. */
  timeOrigin: number;
}

/**
 * Bundles the four-hook setup chart-replay demos write by hand into one
 * call:
 *
 *   1. `useFluxionStream` — live pump that pushes to the chart layer while
 *      live, always records into the session.
 *   2. `useChartReplay` — backfills + streams the chart from a DVR
 *      player. Trailing window `[t - windowMs, t]`.
 *   3. `useChartLiveBackfill` — on every DVR→live transition, wipes the
 *      chart and rewrites it with the most recent `windowMs` of recorded
 *      data so the live chart picks up seamlessly.
 *   4. `isLiveRef` — defeats the stale-closure window during an in-flight
 *      `dvr.enter()`, so live pushes don't leak past the mode switch.
 *
 * @example
 * useChartReplayBridge({
 *   host, session, dvr, isLive: !dvr.isDvr,
 *   channel: signalChannel,
 *   windowMs: 5_000, timeOrigin,
 *   produce: (wallT) => ({ name: "signal", value: sampleAt(wallT) }),
 *   pickValue: (d) => d.value,
 * });
 */
export function useChartReplayBridge<T>(
  opts: UseChartReplayBridgeOptions<T>,
): UseChartReplayResult {
  const {
    host,
    session,
    dvr,
    isLive,
    channel,
    layerId = channel.channelId,
    windowMs,
    prefetchMarginMs,
    liveHz = 20,
    timeOrigin,
    produce,
    pickValue,
  } = opts;

  // The live-pump tick runs at `liveHz`; reading `isLive` via ref defeats the
  // stale-closure window during an in-flight `dvr.enter()` (the tick
  // callback is captured by useFluxionStream's ref pattern, but the value
  // it closes over still goes stale between renders).
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const produceRef = useRef(produce);
  produceRef.current = produce;
  const pickRef = useRef(pickValue);
  pickRef.current = pickValue;

  // Tracks whether useChartLiveBackfill's async IDB query is in-flight
  // specifically during a DVR→Live transition (not on initial live mount).
  // While true, live handle.push() calls are suppressed: the upcoming
  // reset()+pushBatch() would wipe them anyway, and suppressing eliminates
  // the visual "jump" from a single sample appearing before the full
  // backfill window lands.
  const isBackfillingRef = useRef(false);
  // Track previous isLive to distinguish DVR→Live transition from initial mount.
  const prevIsLiveRef = useRef(isLive);

  useFluxionStream({
    host,
    intervalMs: 1000 / liveHz,
    setup: (h) => h.line(layerId),
    tick: (_t, handle) => {
      const wallT = Date.now();
      const data = produceRef.current(wallT);
      if (isLiveRef.current && !isBackfillingRef.current) {
        handle.push({ t: wallT - timeOrigin, y: pickRef.current(data) });
      }
      session?.record(channel.channelId, data, wallT);
      return 1;
    },
  });

  // DVR path: hydrate the trailing window + stream onFrame.
  const replay = useChartReplay<T>({
    host: isLive ? null : host,
    player: isLive ? null : dvr.player,
    store: isLive ? null : (session?.store ?? null),
    channel,
    layerId,
    windowMs,
    prefetchMarginMs,
    timeOrigin,
    pickValue,
  });

  // DVR→Live re-entry: wipe the chart and refill with the most recent
  // `windowMs` of recorded data so live takes over without a blank gap.
  // isBackfilling is true while the async IDB query runs — the live pump
  // reads this via isBackfillingRef to suppress pushes during that window.
  const { isBackfilling } = useChartLiveBackfill<T>({
    host,
    store: session?.store ?? null,
    channel,
    layerId,
    windowMs,
    timeOrigin,
    pickValue,
    active: isLive,
  });
  // Only suppress live pushes when transitioning FROM DVR (prevIsLive=false)
  // TO live. On initial live mount there is no DVR data to race against, so
  // suppression would block the very first live samples unnecessarily.
  const isDvrToLiveTransition = !prevIsLiveRef.current && isLive;
  prevIsLiveRef.current = isLive;
  isBackfillingRef.current = isDvrToLiveTransition && isBackfilling;

  return replay;
}
