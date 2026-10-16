import { Engine, Op, registerLayer } from "@heojeongbo/fluxion-render/worker";
import { defineWorker } from "@heojeongbo/fluxion-worker";

defineWorker<{ job: string; delay?: number }, { job: string; values?: number[] }>(
  async (message, reply) => {
    if (message.delay) await new Promise((resolve) => setTimeout(resolve, message.delay));
    if (message.job === "raw") {
      let values: number[] = [];
      registerLayer("line", (id) => ({
        id,
        setConfig() {},
        resize() {},
        draw() {},
        dispose() {},
        setData(buffer, length) {
          values = [...new Float32Array(buffer, 0, length)];
        },
      }));
      const engine = new Engine();
      engine.dispatch({ op: Op.ADD_LAYER, id: "line", kind: "line" });
      engine.pushRaw("line", new Float32Array([99, 88, 1, 2]).subarray(2));
      engine.dispatch({ op: Op.DISPOSE });
      reply({ job: message.job, values });
      return;
    }
    if (message.job === "error") throw new Error("intentional worker error");
    reply({ job: message.job });
  },
);
