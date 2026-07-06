/**
 * "@heojeongbo/fluxion-render/worker" sub-entry.
 *
 * Import this inside your custom worker script to get access to `Engine`
 * (for dispatching HostMsg and calling `pushRaw`) plus all the
 * `defineWorker*` helpers from fluxion-worker.
 *
 * @example
 * ```ts
 * // my-sensor-worker.ts
 * import { Engine, defineWorkerWithState } from "@heojeongbo/fluxion-render/worker";
 * import type { HostMsg, StreamDataMsg } from "@heojeongbo/fluxion-render/worker";
 *
 * defineWorkerWithState<HostMsg, object, Engine, StreamDataMsg>(
 *   (msg, _reply, ctx) => {
 *     const engine = ctx.state ?? new Engine();
 *     engine.dispatch(msg as HostMsg);
 *     return engine;
 *   },
 *   (msg, _push, ctx) => {
 *     const engine = ctx.state;
 *     if (!engine) return;
 *     const arr = new Float32Array(msg.buffer, 0, msg.length);
 *     engine.pushRaw(msg.id, arr);
 *   },
 * );
 * ```
 */

export type {
  FluxionMode,
  HostContext,
  PushFn,
  ReplyFn,
  WorkerMsg,
} from "@heojeongbo/fluxion-worker";
export {
  defineWorker,
  defineWorkerWithState,
} from "@heojeongbo/fluxion-worker";
export { Engine } from "./features/engine";
export type {
  BoundsUpdateMsg,
  DType,
  FluxionPoolStreamMsg,
  HostMsg,
  LayerKind,
  PoolDisposeMsg,
  PoolInitMsg,
  RenderStatsMsg,
  SerializedTick,
  StreamDataMsg,
  TickUpdateMsg,
  // The engine's worker→main output messages (bounds / tick / render-stats).
  // Named `EngineOutMsg` to avoid colliding with fluxion-worker's generic
  // `WorkerMsg` re-exported above; a custom worker forwards these to the host.
  WorkerMsg as EngineOutMsg,
} from "./shared/protocol";
export { Op, WorkerOp } from "./shared/protocol";
