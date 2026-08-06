import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "../../shared/protocol";

// Drive the worker's message router without a real OffscreenCanvas — we assert
// engine routing/teardown, not rendering, so a no-op Engine is enough.
vi.mock("../../features/engine", () => ({
  Engine: class {
    dispatch(): void {}
  },
  // The worker registers all layer kinds at module load; a no-op is enough here
  // (we assert message routing, not layer creation).
  registerDefaultLayers: () => {},
}));

// Importing installs `self.onmessage` (the router under test).
import "./fluxion-worker";

const send = (msg: unknown) =>
  (self.onmessage as ((e: MessageEvent) => void) | null)?.({
    data: msg,
  } as MessageEvent);

describe("fluxion-worker pool message router", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("POOL_DISPOSE tears down only the targeted engine; later messages to it are dropped", () => {
    const init = (hostId: string) => ({
      op: Op.POOL_INIT,
      hostId,
      canvas: {},
      width: 400,
      height: 300,
      dpr: 1,
    });
    send(init("a"));
    send(init("b"));

    // Tear down "a" only. This is the message the dispose ordering bug used to
    // swallow before it ever left the main thread, leaking the worker engine.
    send({ op: Op.POOL_DISPOSE, hostId: "a" });

    // A late message to the disposed host finds no engine and is dropped (warned)...
    send({ op: Op.DATA, hostId: "a" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('hostId="a"');

    // ...while the co-located engine "b" is untouched (no new warning).
    send({ op: Op.DATA, hostId: "b" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
