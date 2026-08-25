import { act, render } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxionHost } from "../../../features/host";
import { useFluxionStream } from "./use-fluxion-stream";

interface RecordedPost {
  msg: unknown;
  transfer?: Transferable[];
}

function makeFakeWorkerFactory() {
  const posts: RecordedPost[] = [];
  const terminate = vi.fn();
  const factory = () =>
    ({
      postMessage: (msg: unknown, transfer?: Transferable[]) => {
        posts.push({ msg, transfer });
      },
      terminate,
      onmessage: null,
      onerror: null,
    }) as unknown as Worker;
  return { factory, posts, terminate };
}

function makeHost() {
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = 100;
  const { factory } = makeFakeWorkerFactory();
  return new FluxionHost(canvas, { workerFactory: factory });
}

function Probe<T>({
  host,
  intervalMs,
  setup,
  tick,
  onRate,
  shared,
  trackRate,
}: {
  host: FluxionHost | null;
  intervalMs: number;
  setup: (h: FluxionHost) => T;
  tick: (t: number, s: T) => number;
  onRate?: (r: number) => void;
  shared?: boolean;
  trackRate?: boolean;
}) {
  const { rate } = useFluxionStream({
    host,
    intervalMs,
    setup,
    tick,
    shared,
    trackRate,
  });
  onRate?.(rate);
  return <div data-testid="rate">{rate}</div>;
}

describe("useFluxionStream", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "Date", "performance"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not install an interval when host is null", () => {
    const setup = vi.fn();
    const tick = vi.fn(() => 1);
    render(<Probe host={null} intervalMs={10} setup={setup} tick={tick} />);
    vi.advanceTimersByTime(1000);
    expect(setup).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it("runs setup once and tick on every interval fire once host is ready", () => {
    const host = makeHost();
    const setup = vi.fn(() => ({ n: 0 }));
    const tick = vi.fn((_t: number, s: { n: number }) => {
      s.n++;
      return 1;
    });
    render(<Probe host={host} intervalMs={10} setup={setup} tick={tick} />);
    vi.advanceTimersByTime(55);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(5);
    host.dispose();
  });

  it("pumps via the shared ticker and reports rate when shared=true", () => {
    const host = makeHost();
    const setup = vi.fn(() => ({ n: 0 }));
    const tick = vi.fn((_t: number, s: { n: number }) => {
      s.n++;
      return 2;
    });
    let latestRate = 0;
    const { unmount } = render(
      // Unique interval so the shared registry bucket is isolated to this test.
      <Probe
        host={host}
        intervalMs={7}
        setup={setup}
        tick={tick}
        shared
        onRate={(r) => {
          latestRate = r;
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(525);
    });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls.length).toBeGreaterThan(0);
    expect(latestRate).toBeGreaterThan(0);
    // Unmount must tear down the shared subscription (no further ticks).
    unmount();
    const before = tick.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(tick.mock.calls.length).toBe(before);
    host.dispose();
  });

  it("reports rate in samples/sec after the 500ms window", () => {
    const host = makeHost();
    let latestRate = 0;
    render(
      <Probe
        host={host}
        intervalMs={10}
        setup={() => null}
        tick={() => 3}
        onRate={(r) => {
          latestRate = r;
        }}
      />,
    );
    // 51 ticks × 3 samples/tick in 510ms -> ~300 samples/s. React state
    // updates from inside a setInterval callback are scheduled async, so
    // wrap advance in act() to flush the commit.
    act(() => {
      vi.advanceTimersByTime(510);
    });
    expect(latestRate).toBeGreaterThan(200);
    expect(latestRate).toBeLessThan(400);
    host.dispose();
  });

  it("trackRate=false keeps pumping but never updates the rate", () => {
    const host = makeHost();
    const tick = vi.fn(() => 5);
    let latestRate = -1;
    render(
      <Probe
        host={host}
        intervalMs={10}
        setup={() => null}
        tick={tick}
        trackRate={false}
        onRate={(r) => {
          latestRate = r;
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(600); // well past the 500ms rate window
    });
    expect(tick.mock.calls.length).toBeGreaterThan(0); // pump still runs
    expect(latestRate).toBe(0); // rate state never set → stays 0
    host.dispose();
  });

  it("tick errors are caught; interval keeps running", () => {
    const host = makeHost();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    render(
      <Probe
        host={host}
        intervalMs={10}
        setup={() => null}
        tick={() => {
          calls++;
          throw new Error("boom");
        }}
      />,
    );
    vi.advanceTimersByTime(55);
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    host.dispose();
  });

  it("cleans up interval on unmount", () => {
    const host = makeHost();
    const tick = vi.fn(() => 1);
    const { unmount } = render(
      <Probe host={host} intervalMs={10} setup={() => null} tick={tick} />,
    );
    vi.advanceTimersByTime(55);
    const callCountBefore = tick.mock.calls.length;
    unmount();
    vi.advanceTimersByTime(100);
    expect(tick.mock.calls.length).toBe(callCountBefore);
    host.dispose();
  });

  it("survives StrictMode double-invoke without doubling the interval", () => {
    const host = makeHost();
    const tick = vi.fn(() => 1);
    render(
      <StrictMode>
        <Probe host={host} intervalMs={10} setup={() => null} tick={tick} />
      </StrictMode>,
    );
    // 5 ticks worth of advance; should be at most ~5 tick calls, never 10+
    vi.advanceTimersByTime(55);
    expect(tick.mock.calls.length).toBeLessThanOrEqual(6);
    host.dispose();
  });

  it("logs a console.warn when host stays null beyond 2s", () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<Probe host={null} intervalMs={10} setup={() => null} tick={() => 0} />);
    vi.advanceTimersByTime(2001);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("host is still null"));
    warnSpy.mockRestore();
  });

  it("cancels the null-host warning when host becomes ready before 2s", () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = makeHost();
    render(<Probe host={host} intervalMs={10} setup={() => null} tick={() => 0} />);
    vi.advanceTimersByTime(3000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    host.dispose();
  });

  it("stale setup/tick closures are replaced without tearing down the interval", () => {
    const host = makeHost();
    let latestDivisor = 1;
    function ControlledHarness() {
      const [, setN] = useState(0);
      const { rate } = useFluxionStream({
        host,
        intervalMs: 10,
        setup: () => null,
        tick: () => latestDivisor, // intentionally unstable via outer closure
      });
      // One re-render after mount so the hook re-latches the unstable closures.
      // Scheduled from an effect and cleared on unmount: the previous version
      // called setTimeout in the RENDER BODY, leaking one uncleared timer per
      // render. A straggler firing after the DOM was torn down took React's
      // `getCurrentEventPriority` through a missing `window` and failed the
      // whole run with an unhandled ReferenceError — intermittently, which is
      // the worst kind of CI red.
      useEffect(() => {
        const t = setTimeout(() => setN((n) => n + 1), 0);
        return () => clearTimeout(t);
      }, []);
      return <div>{rate}</div>;
    }
    const { unmount } = render(<ControlledHarness />);
    vi.advanceTimersByTime(30);
    latestDivisor = 5;
    vi.advanceTimersByTime(30);
    // No assertion on exact rate — just that it didn't crash and refs flowed.
    unmount(); // testing-library auto-cleanup is off (globals:false)
    host.dispose();
  });
});
