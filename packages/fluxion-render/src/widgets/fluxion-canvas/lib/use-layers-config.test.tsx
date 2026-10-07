import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FluxionHost } from "../../../features/host";
import { lineLayer } from "./layer-specs";
import type { FluxionLayerSpec } from "./use-fluxion-canvas";
import { useLayersConfig } from "./use-layers-config";

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

function Probe({ host, specs }: { host: FluxionHost | null; specs: FluxionLayerSpec[] }) {
  useLayersConfig(host, specs);
  return null;
}

const visibleSpecs = (a: boolean, b: boolean): FluxionLayerSpec[] => [
  lineLayer("a", { visible: a }),
  lineLayer("b", { visible: b }),
];

describe("useLayersConfig", () => {
  it("sends a single configLayers with all entries on first render", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayers");
    render(<Probe host={host} specs={visibleSpecs(true, false)} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([
      { id: "a", config: { visible: true } },
      { id: "b", config: { visible: false } },
    ]);
    host.dispose();
  });

  it("does not re-send when content is identical across renders", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayers");
    const { rerender } = render(<Probe host={host} specs={visibleSpecs(true, false)} />);
    spy.mockClear();
    rerender(<Probe host={host} specs={visibleSpecs(true, false)} />);
    expect(spy).not.toHaveBeenCalled();
    host.dispose();
  });

  it("sends only the changed subset when one spec changes", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayers");
    const { rerender } = render(<Probe host={host} specs={visibleSpecs(true, false)} />);
    spy.mockClear();
    rerender(<Probe host={host} specs={visibleSpecs(true, true)} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([{ id: "b", config: { visible: true } }]);
    host.dispose();
  });

  it("skips specs with undefined config", () => {
    const { host } = makeHost();
    const spy = vi.spyOn(host, "configLayers");
    render(
      <Probe host={host} specs={[lineLayer("a"), lineLayer("b", { visible: false })]} />,
    );
    expect(spy).toHaveBeenCalledWith([{ id: "b", config: { visible: false } }]);
    host.dispose();
  });

  it("is a no-op when host is null", () => {
    expect(() =>
      render(<Probe host={null} specs={visibleSpecs(true, false)} />),
    ).not.toThrow();
  });
});

it("resends identical batch to a replacement non-null host", () => {
  const { host: a } = makeHost();
  const { host: b } = makeHost();
  const spy = vi.spyOn(b, "configLayers");
  const specs = visibleSpecs(true, false);
  const { rerender, unmount } = render(<Probe host={a} specs={specs} />);
  rerender(<Probe host={b} specs={specs} />);
  expect(spy).toHaveBeenCalledWith(specs.map(({ id, config }) => ({ id, config })));
  unmount();
  a.dispose();
  b.dispose();
});
