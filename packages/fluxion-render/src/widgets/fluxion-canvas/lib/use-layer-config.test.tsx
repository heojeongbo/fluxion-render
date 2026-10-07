import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FluxionHost } from "../../../features/host";
import { axisGridLayer } from "./layer-specs";
import type { FluxionLayerSpec } from "./use-fluxion-canvas";
import { useLayerConfig } from "./use-layer-config";

function makeHost() {
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = 100;
  const posts: unknown[] = [];
  const factory = () =>
    ({
      postMessage: (msg: unknown) => posts.push(msg),
      terminate: () => {},
      onmessage: null,
      onerror: null,
    }) as unknown as Worker;
  const host = new FluxionHost(canvas, { workerFactory: factory });
  return { host, posts };
}

function Probe({ host, spec }: { host: FluxionHost | null; spec: FluxionLayerSpec }) {
  useLayerConfig(host, spec);
  return null;
}

describe("useLayerConfig", () => {
  it("sends configLayer on first render", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayer");
    render(<Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("axis", { timeWindowMs: 5000 });
    host.dispose();
  });

  it("does not re-send when content is identical across renders", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayer");
    const { rerender } = render(
      <Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />,
    );
    rerender(<Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />);
    rerender(<Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />);
    expect(spy).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("re-sends when content actually changes", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayer");
    const { rerender } = render(
      <Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />,
    );
    rerender(<Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 10000 })} />);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]).toEqual(["axis", { timeWindowMs: 10000 }]);
    host.dispose();
  });

  it("is a no-op when host is null", () => {
    render(<Probe host={null} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />);
    expect(true).toBe(true);
  });

  it("is a no-op when config is undefined (only id/kind provided)", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayer");
    render(<Probe host={host} spec={axisGridLayer("axis")} />);
    expect(spy).not.toHaveBeenCalled();
    host.dispose();
  });

  it("skips the duplicate send when the effect re-runs with identical config (StrictMode)", () => {
    // StrictMode double-invokes the effect on mount: the second run sees an
    // unchanged `serialized` and hits the `lastSentRef.current === serialized`
    // early-return, so configLayer is still sent exactly once.
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayer");
    render(
      <StrictMode>
        <Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />
      </StrictMode>,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("re-sends after host null reset then reconnects with same config", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayer");
    const { rerender } = render(
      <Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />,
    );
    rerender(<Probe host={null} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />);
    rerender(<Probe host={host} spec={axisGridLayer("axis", { timeWindowMs: 5000 })} />);
    expect(spy).toHaveBeenCalledTimes(2);
    host.dispose();
  });
});

it("resends identical config when the layer id or non-null host changes", () => {
  const { host: a } = makeHost();
  const { host: b } = makeHost();
  const aSpy = vi.spyOn(a, "configLayer");
  const bSpy = vi.spyOn(b, "configLayer");
  const config = { timeWindowMs: 1234 };
  const { rerender, unmount } = render(
    <Probe host={a} spec={axisGridLayer("a", config)} />,
  );
  rerender(<Probe host={a} spec={axisGridLayer("b", config)} />);
  expect(aSpy).toHaveBeenLastCalledWith("b", config);
  rerender(<Probe host={b} spec={axisGridLayer("b", config)} />);
  expect(bSpy).toHaveBeenCalledWith("b", config);
  unmount();
  a.dispose();
  b.dispose();
});
