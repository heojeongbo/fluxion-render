import { WorkerHandle } from "@heojeongbo/fluxion-worker";

import type {
  FluxionPoolStreamMsg,
  HostMsg,
  InitMsg,
  PoolDisposeMsg,
  PoolInitMsg,
} from "../../../shared/protocol";
import { Op } from "../../../shared/protocol";

export class FluxionWorkerHandle extends WorkerHandle<HostMsg> {
  constructor(worker: Worker, hostId: string, onRelease?: () => void) {
    super(worker, hostId, onRelease);
  }

  override postMessage(msg: HostMsg, transfer?: Transferable[]): void {
    if (msg.op === Op.INIT) {
      const m = msg as InitMsg;
      const poolMsg: PoolInitMsg = {
        op: Op.POOL_INIT,
        hostId: this.hostId,
        canvas: m.canvas,
        width: m.width,
        height: m.height,
        dpr: m.dpr,
        bgColor: m.bgColor,
        maxFps: m.maxFps,
        emitBounds: m.emitBounds,
        emitTicks: m.emitTicks,
        emitRenderStats: m.emitRenderStats,
        transparent: m.transparent,
        inlineAxes: m.inlineAxes,
        xAxisHeight: m.xAxisHeight,
        yAxisWidth: m.yAxisWidth,
      };
      this._worker.postMessage(poolMsg, transfer ?? []);
      return;
    }

    if (msg.op === Op.DISPOSE) {
      const poolMsg: PoolDisposeMsg = { op: Op.POOL_DISPOSE, hostId: this.hostId };
      this._worker.postMessage(poolMsg);
      this.release();
      return;
    }

    super.postMessage(msg, transfer);
  }

  /**
   * Transfer a raw Float32Array to the custom worker's `streamHandler` (zero-copy).
   * Stamps `hostId` so the worker routes to the correct Engine instance in pool mode.
   * After this call, `buffer` is detached — do not read it again.
   */
  emitStream(id: string, buffer: ArrayBuffer, length: number): void {
    if (this.isTerminated) return; // worker may already be gone (pool disposed)
    const msg = { id, buffer, length, hostId: this.hostId, mode: "stream" as const };
    this._worker.postMessage(msg, [buffer]);
  }

  /**
   * Fan-out one buffer to multiple Engine instances on this worker (zero-copy).
   * All targets must reside on this worker. After this call, `buffer` is detached.
   */
  emitPoolStream(
    targets: FluxionPoolStreamMsg["targets"],
    buffer: ArrayBuffer,
    length: number,
  ): void {
    if (this.isTerminated) return; // worker may already be gone (pool disposed)
    const msg: FluxionPoolStreamMsg = { mode: "pool-stream", targets, buffer, length };
    this._worker.postMessage(msg, [buffer]);
  }
}
