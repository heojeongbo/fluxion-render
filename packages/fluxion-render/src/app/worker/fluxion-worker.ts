import { Engine } from "../../features/engine";
import type { FluxionPoolStreamMsg, HostMsg } from "../../shared/protocol";
import { Op } from "../../shared/protocol";

const SOLO_HOST_ID = "__solo__";
const engines = new Map<string, Engine>();

self.onmessage = (e: MessageEvent<HostMsg>) => {
  try {
    const msg = e.data;

    if (msg.op === Op.POOL_INIT) {
      const engine = new Engine();
      engines.set(msg.hostId, engine);
      engine.dispatch({
        op: Op.INIT,
        canvas: msg.canvas,
        width: msg.width,
        height: msg.height,
        dpr: msg.dpr,
        bgColor: msg.bgColor,
        maxFps: msg.maxFps,
        emitBounds: msg.emitBounds,
        emitTicks: msg.emitTicks,
        transparent: msg.transparent,
        emitRenderStats: msg.emitRenderStats,
        inlineAxes: msg.inlineAxes,
        xAxisHeight: msg.xAxisHeight,
        yAxisWidth: msg.yAxisWidth,
        renderer: msg.renderer,
        hostId: msg.hostId,
      });
      return;
    }

    if (msg.op === Op.POOL_DISPOSE) {
      const engine = engines.get(msg.hostId);
      if (engine) {
        engine.dispatch({ op: Op.DISPOSE });
        engines.delete(msg.hostId);
      }
      return;
    }

    if ((msg as unknown as { mode?: string }).mode === "pool-stream") {
      const s = msg as unknown as FluxionPoolStreamMsg;
      // Defensive: a malformed length (negative, non-integer, or larger than
      // the transferred buffer) would throw on the view construction. Clamp to
      // the buffer's real capacity so one bad packet never disrupts the worker.
      const maxLen = s.buffer.byteLength >>> 2; // bytes → f32 count
      const len = Math.max(0, Math.min(s.length | 0, maxLen));
      const decoded = new Float32Array(s.buffer, 0, len);
      for (const { hostId, layerId } of s.targets) {
        engines.get(hostId)?.pushRaw(layerId, decoded);
      }
      return;
    }

    const hostId = msg.hostId ?? SOLO_HOST_ID;

    if (msg.op === Op.INIT) {
      const engine = new Engine();
      engines.set(hostId, engine);
      engine.dispatch(msg);
      return;
    }

    if (msg.op === Op.DISPOSE) {
      const engine = engines.get(hostId);
      if (engine) {
        engine.dispatch(msg);
        engines.delete(hostId);
      }
      return;
    }

    const engine = engines.get(hostId);
    if (!engine) {
      console.warn(
        `[fluxion-worker] no engine for hostId="${hostId}" (op=${msg.op}). ` +
          "The host was likely disposed, or this message arrived after teardown " +
          "(e.g. a late pushData on an unmounted chart). It is dropped.",
      );
      return;
    }
    engine.dispatch(msg);
  } catch (err) {
    const op = (e.data as { op?: number } | null)?.op;
    console.error(`[fluxion-worker] dispatch error (op=${op}):`, err);
  }
};

self.addEventListener("error", (e) => {
  console.error("[fluxion-worker] uncaught error:", e.message ?? e);
});

self.addEventListener("messageerror", (e) => {
  console.error("[fluxion-worker] message deserialization failed:", e);
});
