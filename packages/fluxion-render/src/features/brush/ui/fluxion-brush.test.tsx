import { act, render } from "@testing-library/react";
import type React from "react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluxionBrush } from "./fluxion-brush";

function makeBrushRef() {
  return createRef<SVGSVGElement>();
}

function renderBrush(props: Partial<React.ComponentProps<typeof FluxionBrush>> = {}) {
  const brushRef = makeBrushRef();
  const defaults = {
    brushRef,
    selection: null,
    width: 400,
    height: 200,
  };
  const { container, rerender, unmount } = render(
    <FluxionBrush {...defaults} {...props} brushRef={props.brushRef ?? brushRef} />,
  );
  const svg = container.querySelector("svg") as SVGSVGElement;
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 400,
    bottom: 200,
    width: 400,
    height: 200,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect);
  return { container, svg, brushRef, unmount, rerender };
}

function fireMouseDown(el: Element, clientX: number) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX }),
    );
  });
}

function fireMouseMove(clientX: number) {
  act(() => {
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX }),
    );
  });
}

function fireMouseUp() {
  act(() => {
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FluxionBrush — rendering", () => {
  it("renders an svg element with correct width and height", () => {
    const { container } = renderBrush({ width: 500, height: 300 });
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("500");
    expect(svg.getAttribute("height")).toBe("300");
  });

  it("applies crosshair cursor and userSelect none", () => {
    const { svg } = renderBrush();
    expect(svg.style.cursor).toBe("crosshair");
    expect(svg.style.userSelect).toBe("none");
  });

  it("applies custom className to the svg", () => {
    const { svg } = renderBrush({ className: "my-brush" });
    expect(svg.classList.contains("my-brush")).toBe(true);
  });

  it("merges custom style with default styles", () => {
    const { svg } = renderBrush({ style: { position: "absolute" } });
    expect(svg.style.position).toBe("absolute");
    expect(svg.style.cursor).toBe("crosshair");
  });

  it("renders no selection rect when selection is null and no drag", () => {
    const { container } = renderBrush({ selection: null });
    expect(container.querySelectorAll("rect").length).toBe(0);
  });
});

describe("FluxionBrush — drag interaction", () => {
  it("shows selection rect while dragging", () => {
    const { svg, container } = renderBrush();

    fireMouseDown(svg, 50);
    fireMouseMove(200);

    expect(container.querySelectorAll("rect").length).toBe(1);
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBe(2);
  });

  it("does not show rect when drag width is <= 2px", () => {
    const { svg, container } = renderBrush();

    fireMouseDown(svg, 100);
    fireMouseMove(101);

    expect(container.querySelectorAll("rect").length).toBe(0);
  });

  it("clears drag rect after mouseup", () => {
    const { svg, container } = renderBrush();

    fireMouseDown(svg, 50);
    fireMouseMove(200);
    expect(container.querySelectorAll("rect").length).toBe(1);

    fireMouseUp();
    expect(container.querySelectorAll("rect").length).toBe(0);
  });

  it("rect x is the leftmost drag position regardless of direction", () => {
    const { svg, container } = renderBrush();

    fireMouseDown(svg, 300);
    fireMouseMove(100);

    const rect = container.querySelector("rect")!;
    expect(Number(rect.getAttribute("x"))).toBe(100);
    expect(Number(rect.getAttribute("width"))).toBe(200);
  });

  it("mousemove without prior mousedown does not show rect", () => {
    const { container } = renderBrush();

    fireMouseMove(200);

    expect(container.querySelectorAll("rect").length).toBe(0);
  });
});

describe("FluxionBrush — colors", () => {
  it("applies default selectionColor to fill", () => {
    const { svg, container } = renderBrush();

    fireMouseDown(svg, 50);
    fireMouseMove(200);

    const rect = container.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("rgba(100, 149, 237, 0.2)");
  });

  it("applies custom selectionColor", () => {
    const { svg, container } = renderBrush({ selectionColor: "rgba(255,0,0,0.3)" });

    fireMouseDown(svg, 50);
    fireMouseMove(200);

    const rect = container.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("rgba(255,0,0,0.3)");
  });

  it("applies default borderColor to lines", () => {
    const { svg, container } = renderBrush();

    fireMouseDown(svg, 50);
    fireMouseMove(200);

    const lines = container.querySelectorAll("line");
    Array.from(lines).forEach((line) => {
      expect(line.getAttribute("stroke")).toBe("#6495ed");
    });
  });

  it("applies custom borderColor to lines", () => {
    const { svg, container } = renderBrush({ borderColor: "#ff0000" });

    fireMouseDown(svg, 50);
    fireMouseMove(200);

    const lines = container.querySelectorAll("line");
    Array.from(lines).forEach((line) => {
      expect(line.getAttribute("stroke")).toBe("#ff0000");
    });
  });
});

describe("FluxionBrush — selection prop", () => {
  it("shows committed rect (via prevDragRect) when selection is set after drag", () => {
    const { svg, container, rerender } = renderBrush({ selection: null });

    fireMouseDown(svg, 50);
    fireMouseMove(250);
    fireMouseUp();

    act(() => {
      rerender(
        <FluxionBrush
          brushRef={svg as unknown as React.RefObject<SVGSVGElement>}
          selection={{ tStart: 0, tEnd: 1000 }}
          width={400}
          height={200}
        />,
      );
    });

    expect(container.querySelectorAll("rect").length).toBe(1);
  });

  it("clears display rect when selection is set to null", () => {
    const { svg, container, rerender } = renderBrush({ selection: null });

    fireMouseDown(svg, 50);
    fireMouseMove(250);
    fireMouseUp();

    act(() => {
      rerender(
        <FluxionBrush
          brushRef={svg as unknown as React.RefObject<SVGSVGElement>}
          selection={{ tStart: 0, tEnd: 1000 }}
          width={400}
          height={200}
        />,
      );
    });

    act(() => {
      rerender(
        <FluxionBrush
          brushRef={svg as unknown as React.RefObject<SVGSVGElement>}
          selection={null}
          width={400}
          height={200}
        />,
      );
    });

    expect(container.querySelectorAll("rect").length).toBe(0);
  });
});

describe("FluxionBrush — cleanup", () => {
  it("removes event listeners on unmount without throwing", () => {
    const { unmount } = renderBrush();
    expect(() => unmount()).not.toThrow();
  });
});
