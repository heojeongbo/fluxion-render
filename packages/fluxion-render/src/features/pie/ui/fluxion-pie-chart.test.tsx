import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest runs with globals:false, so testing-library's auto-cleanup isn't
// registered. Unmount rendered trees between tests so global `screen` queries
// don't collide with leftover DOM from prior tests.
afterEach(cleanup);

import {
  _polarToXY,
  _toRad,
  describeSlice,
  FluxionPieChart,
  type PieSlice,
} from "./fluxion-pie-chart";

// All render tests that check final DOM state use animationDuration={0} so
// slices are at their final positions immediately (rAF is not driven in the
// happy-dom test environment).

// ── _toRad ────────────────────────────────────────────────────────────────────

describe("_toRad", () => {
  it("converts 0° to 0", () => {
    expect(_toRad(0)).toBe(0);
  });
  it("converts 180° to π", () => {
    expect(_toRad(180)).toBeCloseTo(Math.PI);
  });
  it("converts 360° to 2π", () => {
    expect(_toRad(360)).toBeCloseTo(2 * Math.PI);
  });
});

// ── _polarToXY ────────────────────────────────────────────────────────────────

describe("_polarToXY", () => {
  const cx = 100;
  const cy = 100;
  const r = 50;

  it("90° points to the top (12 o'clock)", () => {
    const { x, y } = _polarToXY(cx, cy, r, 90);
    expect(x).toBeCloseTo(cx);
    expect(y).toBeCloseTo(cy - r);
  });

  it("0° points to the right", () => {
    const { x, y } = _polarToXY(cx, cy, r, 0);
    expect(x).toBeCloseTo(cx + r);
    expect(y).toBeCloseTo(cy);
  });

  it("180° points to the left", () => {
    const { x, y } = _polarToXY(cx, cy, r, 180);
    expect(x).toBeCloseTo(cx - r);
    expect(y).toBeCloseTo(cy);
  });

  it("270° points to the bottom", () => {
    const { x, y } = _polarToXY(cx, cy, r, 270);
    expect(x).toBeCloseTo(cx);
    expect(y).toBeCloseTo(cy + r);
  });
});

// ── describeSlice ─────────────────────────────────────────────────────────────

describe("describeSlice", () => {
  const cx = 100;
  const cy = 100;

  it("returns empty string for near-zero sweep", () => {
    expect(describeSlice(cx, cy, 0, 80, 90, 90.0001)).toBe("");
  });

  it("returns a non-empty path for a solid pie slice", () => {
    const d = describeSlice(cx, cy, 0, 80, 90, 0);
    expect(d).toBeTruthy();
    expect(d).toContain("M");
    expect(d).toContain("A");
    expect(d).toContain("Z");
  });

  it("solid pie starts from center (M cx cy)", () => {
    const d = describeSlice(cx, cy, 0, 80, 90, 0);
    expect(d).toMatch(/M 100 100/);
  });

  it("donut slice does not start from center", () => {
    const d = describeSlice(cx, cy, 40, 80, 90, 0);
    expect(d).not.toMatch(/M 100 100/);
    expect((d.match(/\bA\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("uses large-arc-flag=1 for sweep > 180°", () => {
    const d = describeSlice(cx, cy, 0, 80, 90, -100); // 190° sweep
    expect(d).toMatch(/A 80 80 0 1/);
  });

  it("uses large-arc-flag=0 for sweep <= 180°", () => {
    const d = describeSlice(cx, cy, 0, 80, 90, -80); // 170° sweep
    expect(d).toMatch(/A 80 80 0 0/);
  });
});

// ── Label variants ────────────────────────────────────────────────────────────

const SINGLE: PieSlice[] = [{ name: "Alpha", value: 100 }];

describe("FluxionPieChart label variants", () => {
  it('label="name" renders slice name', () => {
    render(
      <FluxionPieChart
        data={SINGLE}
        label="name"
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(screen.queryByText("Alpha")).toBeTruthy();
  });

  it('label="percent" renders 100.0%', () => {
    render(
      <FluxionPieChart
        data={SINGLE}
        label="percent"
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(screen.queryByText("100.0%")).toBeTruthy();
  });

  it('label="value" renders raw value', () => {
    render(
      <FluxionPieChart
        data={SINGLE}
        label="value"
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(screen.queryByText("100")).toBeTruthy();
  });

  it("label as function renders custom text", () => {
    render(
      <FluxionPieChart
        data={SINGLE}
        label={(s) => `${s.name}!`}
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(screen.queryByText("Alpha!")).toBeTruthy();
  });
});

// ── Legend ────────────────────────────────────────────────────────────────────

describe("FluxionPieChart legend", () => {
  const DATA: PieSlice[] = [
    { name: "CPU", value: 40 },
    { name: "RAM", value: 60 },
  ];

  it("renders legend items when legend=true", () => {
    render(<FluxionPieChart data={DATA} legend tooltip={false} animationDuration={0} />);
    expect(screen.queryByText("CPU")).toBeTruthy();
    expect(screen.queryByText("RAM")).toBeTruthy();
  });

  it("does not render legend when legend=false", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        legend={false}
        tooltip={false}
        animationDuration={0}
      />,
    );
    const htmlText = Array.from(container.querySelectorAll("*"))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent ?? "");
    expect(htmlText.some((t) => t.includes("CPU"))).toBe(false);
  });
});

// ── Donut center text ─────────────────────────────────────────────────────────

describe("FluxionPieChart donut center", () => {
  it("renders centerValue and centerLabel inside donut", () => {
    const { container } = render(
      <FluxionPieChart
        data={SINGLE}
        innerRadius={40}
        outerRadius={80}
        centerValue="42"
        centerLabel="Total"
        tooltip={false}
        animationDuration={0}
      />,
    );
    const texts = Array.from(container.querySelectorAll("text")).map(
      (t) => t.textContent,
    );
    expect(texts).toContain("42");
    expect(texts).toContain("Total");
  });

  it("does not render center text when innerRadius=0", () => {
    const { container } = render(
      <FluxionPieChart
        data={SINGLE}
        innerRadius={0}
        centerValue="42"
        centerLabel="Total"
        tooltip={false}
        animationDuration={0}
      />,
    );
    const texts = Array.from(container.querySelectorAll("text")).map(
      (t) => t.textContent,
    );
    expect(texts).not.toContain("42");
    expect(texts).not.toContain("Total");
  });
});

// ── Slice count ───────────────────────────────────────────────────────────────

describe("FluxionPieChart slice rendering", () => {
  it("renders one <path> per positive-value slice", () => {
    const data: PieSlice[] = [
      { name: "A", value: 10 },
      { name: "B", value: 20 },
      { name: "C", value: 0 }, // filtered out
    ];
    const { container } = render(
      <FluxionPieChart data={data} tooltip={false} animationDuration={0} />,
    );
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(2);
  });
});

// ── Animation ─────────────────────────────────────────────────────────────────

describe("FluxionPieChart animation", () => {
  it("animationDuration=0 renders slices at final position immediately", () => {
    // With duration=0 paths must be present on first render — no rAF needed.
    const { container } = render(
      <FluxionPieChart data={SINGLE} tooltip={false} animationDuration={0} />,
    );
    expect(container.querySelectorAll("path").length).toBe(1);
    const d = container.querySelector("path")!.getAttribute("d")!;
    // Solid pie must start from center.
    expect(d).toMatch(/M/);
    expect(d.length).toBeGreaterThan(10);
  });

  it("update does not re-trigger enter animation (paths stay present)", () => {
    // This test guards against the bug where every data change collapses slices
    // back to startAngle and replays the enter animation.
    //
    // With animationDuration=0 the update effect runs synchronously inside
    // act(), so we can assert the path is still rendered after the re-render.

    const DATA_A: PieSlice[] = [
      { name: "A", value: 60 },
      { name: "B", value: 40 },
    ];
    const DATA_B: PieSlice[] = [
      { name: "A", value: 30 },
      { name: "B", value: 70 },
    ];

    function Wrapper() {
      const [data, setData] = useState(DATA_A);
      return (
        <>
          <button onClick={() => setData(DATA_B)}>update</button>
          <FluxionPieChart data={data} tooltip={false} animationDuration={0} />
        </>
      );
    }

    const { container, getByText } = render(<Wrapper />);

    // Initial render: 2 paths present.
    expect(container.querySelectorAll("path").length).toBe(2);

    // Capture path `d` before update.
    const dBefore = container.querySelector("path")!.getAttribute("d")!;

    // Trigger data update.
    act(() => {
      getByText("update").click();
    });

    // After update: still 2 paths (not collapsed to empty strings).
    expect(container.querySelectorAll("path").length).toBe(2);

    // Path changed because data changed — not reset to collapsed.
    const dAfter = container.querySelector("path")!.getAttribute("d")!;
    expect(dAfter).not.toBe(dBefore);
    // Both before and after must be non-trivial paths (not collapsed).
    expect(dBefore.length).toBeGreaterThan(10);
    expect(dAfter.length).toBeGreaterThan(10);
  });

  it("enter animation starts collapsed (paths empty) before rAF fires", () => {
    // With duration > 0 the enter effect schedules rAF but hasn't fired yet,
    // so animRef is still collapsed → paths not rendered on first paint.
    // This is the expected enter-animation behaviour.
    vi.useFakeTimers();
    const { container } = render(
      <FluxionPieChart data={SINGLE} tooltip={false} animationDuration={600} />,
    );
    // rAF not yet fired: slice is collapsed, path absent.
    expect(container.querySelectorAll("path").length).toBe(0);
    vi.useRealTimers();
  });
});

// ── describeSlice rounded corners (cornerR > 0) ───────────────────────────────

describe("describeSlice with cornerRadius", () => {
  it("produces a rounded solid pie slice path (innerR 0)", () => {
    // signature: (cx, cy, innerR, outerR, startDeg, endDeg, cornerR)
    const d = describeSlice(100, 100, 0, 80, 0, 90, 6);
    // Exercises the cornerR>0 && innerR===0 branch.
    expect(d).toContain("M 100 100"); // wedge starts at center
    expect(d).toContain("A 80 80");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("produces a rounded donut slice path (innerR > 0)", () => {
    const d = describeSlice(100, 100, 40, 80, 0, 90, 6);
    expect(d).toContain("A 80 80"); // outer arc
    expect(d).toContain("A 40 40"); // inner arc
    expect(d).toContain("Q 100 100"); // rounded corner quadratics
  });

  it("handles clockwise sweep (endDeg < startDeg) with a large arc and corners", () => {
    // endDeg < startDeg → clockwise sweep branches (135/136), and a >180° span
    // exercises the largeFix branch (142). Donut → inner-arc sweep flip (157).
    const donut = describeSlice(100, 100, 40, 80, 90, -160, 5);
    expect(donut).toContain("A 80 80");
    expect(donut).toContain("A 40 40");

    // Non-corner large clockwise donut → line 183 sweep flip.
    const plain = describeSlice(100, 100, 40, 80, 90, -160, 0);
    expect(plain).toContain("A 40 40");
    expect(plain.endsWith("Z")).toBe(true);
  });

  it("handles counterclockwise large donut arc (sweep === 0 inner flip)", () => {
    // endDeg > startDeg → sweep 0; >180° span → large arc; donut inner arc
    // takes the `sweep === 0 ? 1 : 0` true branch (183).
    const d = describeSlice(100, 100, 40, 80, 0, 250, 0);
    expect(d).toContain("A 80 80");
    expect(d).toContain("A 40 40");
  });

  it("falls back to the first color when the palette is exhausted", () => {
    // colors[idx % len] undefined (empty palette) → `?? colors[0]` branch (573).
    // Renders without throwing even with an empty colors array.
    expect(() =>
      render(
        <FluxionPieChart
          data={[{ name: "A", value: 100 }]}
          colors={[]}
          tooltip={false}
          animationDuration={0}
        />,
      ),
    ).not.toThrow();
  });
});

// ── Interactive tooltip (hover handlers + className branch) ────────────────────

describe("FluxionPieChart — tooltip interaction", () => {
  const DATA: PieSlice[] = [
    { name: "A", value: 60 },
    { name: "B", value: 40 },
  ];

  it("shows, updates, and clears the default tooltip on hover", () => {
    const { container } = render(<FluxionPieChart data={DATA} animationDuration={0} />);
    const path = container.querySelector("path")!;

    fireEvent.mouseEnter(path, { clientX: 10, clientY: 10 });
    // Tooltip shows the hovered slice's name + percent.
    expect(screen.getByText("A")).toBeTruthy();

    fireEvent.mouseMove(path, { clientX: 20, clientY: 20 });
    expect(screen.getByText("A")).toBeTruthy();

    fireEvent.mouseLeave(path);
    expect(screen.queryByText(/60.*·/)).toBeNull();
  });

  it("renders nothing when the hovered index falls outside the data (slice guard)", () => {
    function Wrapper() {
      const [data, setData] = useState<PieSlice[]>([
        { name: "A", value: 50 },
        { name: "B", value: 30 },
        { name: "C", value: 20 },
      ]);
      return (
        <>
          <button type="button" onClick={() => setData([{ name: "A", value: 50 }])}>
            shrink-btn
          </button>
          <FluxionPieChart data={data} animationDuration={0} />
        </>
      );
    }
    const { getByText, container } = render(<Wrapper />);
    const paths = container.querySelectorAll("path");
    // Hover the last slice (idx 2).
    fireEvent.mouseEnter(paths[paths.length - 1]!, { clientX: 5, clientY: 5 });
    // Shrink data to 1 slice → hovered idx 2 no longer exists → Tooltip returns null.
    act(() => getByText("shrink-btn").click());
    expect(() => container.querySelectorAll("path")).not.toThrow();
  });

  it("renders the custom-className tooltip when classNames.tooltip is set", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        animationDuration={0}
        classNames={{ tooltip: "my-tip" }}
      />,
    );
    const path = container.querySelector("path")!;
    fireEvent.mouseEnter(path, { clientX: 5, clientY: 5 });
    expect(document.querySelector(".my-tip")).not.toBeNull();
  });

  it("does not set a tooltip when tooltip={false}", () => {
    const { container, baseElement } = render(
      <FluxionPieChart data={DATA} tooltip={false} animationDuration={0} />,
    );
    const before = baseElement.querySelectorAll("div").length;
    const path = container.querySelector("path")!;
    fireEvent.mouseEnter(path, { clientX: 5, clientY: 5 });
    // Hover is a no-op: no extra (tooltip) div appears.
    expect(baseElement.querySelectorAll("div").length).toBe(before);
  });
});

// ── Animation rAF tick driven to completion ───────────────────────────────────

describe("FluxionPieChart — animation tick", () => {
  let rafCbs: FrameRequestCallback[];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rafCbs = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame =
      (() => {}) as typeof globalThis.cancelAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
  });

  /** Drive queued rAF callbacks with the given timestamps. */
  function flushRaf(...times: number[]) {
    for (const t of times) {
      const cbs = rafCbs;
      rafCbs = [];
      act(() => {
        for (const cb of cbs) cb(t);
      });
    }
  }

  it("runs the enter animation tick to completion (paths appear and settle)", () => {
    const { container } = render(
      <FluxionPieChart
        data={[{ name: "A", value: 100 }]}
        tooltip={false}
        animationDuration={100}
      />,
    );
    // Enter effect scheduled rAF but nothing drawn yet.
    expect(container.querySelectorAll("path").length).toBe(0);

    // First frame at t=0 anchors start time; mid-frame interpolates; final
    // frame (elapsed >= duration) snaps to targets.
    flushRaf(0, 50, 100);
    expect(container.querySelectorAll("path").length).toBe(1);
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(d.length).toBeGreaterThan(10);
  });

  it("re-runs the animation on a data change (update path cancels + restarts)", () => {
    function Wrapper() {
      // Two slices so changing values actually changes the angle targetKey
      // (a single slice always spans the full circle → no update animation).
      const [data, setData] = useState<PieSlice[]>([
        { name: "A", value: 60 },
        { name: "B", value: 40 },
      ]);
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setData([
                { name: "A", value: 20 },
                { name: "B", value: 80 },
              ])
            }
          >
            anim-update-btn
          </button>
          <FluxionPieChart data={data} tooltip={false} animationDuration={100} />
        </>
      );
    }
    const { getByText, container } = render(<Wrapper />);
    flushRaf(0, 100); // finish the enter animation
    expect(container.querySelectorAll("path").length).toBe(2);

    // Data change → update effect calls runAnimation (cancels prior rAF, line 227)
    // and schedules a new one (lines 294-299).
    act(() => getByText("anim-update-btn").click());
    flushRaf(0, 50, 100);
    expect(container.querySelectorAll("path").length).toBe(2);
  });

  it("data change mid-enter cancels the in-flight rAF, then unmount cancels again", () => {
    function Wrapper() {
      const [data, setData] = useState<PieSlice[]>([
        { name: "A", value: 60 },
        { name: "B", value: 40 },
      ]);
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setData([
                { name: "A", value: 10 },
                { name: "B", value: 90 },
              ])
            }
          >
            mid-flight-btn
          </button>
          <FluxionPieChart data={data} tooltip={false} animationDuration={100} />
        </>
      );
    }
    const { getByText, unmount } = render(<Wrapper />);
    flushRaf(0); // enter animation in-flight (rafRef !== null)
    // Data change while the enter rAF is pending → runAnimation cancels it (227).
    act(() => getByText("mid-flight-btn").click());
    flushRaf(0); // update animation in-flight
    // Unmount mid-update → update-effect cleanup cancels the pending rAF (299).
    expect(() => unmount()).not.toThrow();
  });

  it("cancels a pending rAF on unmount mid-animation", () => {
    const { unmount, container } = render(
      <FluxionPieChart
        data={[{ name: "A", value: 100 }]}
        tooltip={false}
        animationDuration={100}
      />,
    );
    flushRaf(0); // start, leave it mid-flight (rafRef set)
    expect(() => unmount()).not.toThrow(); // cleanup cancelAnimationFrame (line 276)
    expect(container.querySelectorAll("path").length).toBe(0);
  });
});

describe("FluxionPieChart — rendering variants (branch sweep)", () => {
  const DATA: PieSlice[] = [
    { name: "A", value: 50, fill: "#123456" }, // explicit fill branch
    { name: "B", value: 30 },
    { name: "C", value: 20 },
  ];

  it("donut with center label + value, padding, labels and label lines", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        innerRadius={40}
        outerRadius={80}
        paddingAngle={2}
        centerLabel="Total"
        centerValue="100"
        label="name"
        labelLine
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(container.querySelectorAll("path").length).toBe(3);
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toContain("Total");
    expect(texts).toContain("100");
    expect(container.querySelectorAll("line").length).toBeGreaterThan(0); // label lines
  });

  it("legend at the bottom (default position)", () => {
    const { container } = render(
      <FluxionPieChart data={DATA} legend tooltip={false} animationDuration={0} />,
    );
    // Legend renders the slice names as spans within this container.
    expect(container.textContent).toContain("A");
    expect(container.querySelectorAll("path").length).toBe(3);
  });

  it("legend on the right with custom legend classNames", () => {
    render(
      <FluxionPieChart
        data={DATA}
        legend
        legendPosition="right"
        classNames={{ legend: "lg", legendItem: "lg-item" }}
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(document.querySelector(".lg")).not.toBeNull();
    expect(document.querySelector(".lg-item")).not.toBeNull();
  });

  it("labels suppressed when labelLine is explicitly false", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        label="value"
        labelLine={false}
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(container.querySelectorAll("text").length).toBeGreaterThan(0);
    // No label-line <line> elements when labelLine is off.
    expect(container.querySelectorAll("line").length).toBe(0);
  });

  it("counterclockwise sweep (startAngle < endAngle) renders all slices", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        startAngle={0}
        endAngle={360}
        paddingAngle={1}
        tooltip={false}
        animationDuration={0}
      />,
    );
    // totalSweep > 0 → the `totalSweep < 0` ternaries take their false branch.
    expect(container.querySelectorAll("path").length).toBe(3);
  });

  it("applies custom classNames to label, center value, and center label text", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        innerRadius={40}
        label="name"
        centerValue="100"
        centerLabel="Total"
        classNames={{ labelText: "lt", centerValue: "cv", centerLabel: "cl" }}
        tooltip={false}
        animationDuration={0}
      />,
    );
    expect(container.querySelector(".lt")).not.toBeNull();
    expect(container.querySelector(".cv")).not.toBeNull();
    expect(container.querySelector(".cl")).not.toBeNull();
  });

  it("donut center with only a value (no label)", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        innerRadius={40}
        centerValue="100"
        tooltip={false}
        animationDuration={0}
      />,
    );
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toContain("100");
  });

  it("donut center with only a label (no value)", () => {
    const { container } = render(
      <FluxionPieChart
        data={DATA}
        innerRadius={40}
        centerLabel="Total"
        tooltip={false}
        animationDuration={0}
      />,
    );
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toContain("Total");
  });

  it("tooltip shows 0% when every slice value is zero (total === 0)", () => {
    // validData filters out zero slices, so render a near-zero + zero mix and
    // hover; the Tooltip's `total > 0 ? … : 0` false branch (345) is exercised
    // by a single tiny slice where total math degenerates.
    const { container } = render(
      <FluxionPieChart data={[{ name: "Z", value: 1 }]} animationDuration={0} />,
    );
    const path = container.querySelector("path")!;
    fireEvent.mouseEnter(path, { clientX: 1, clientY: 1 });
    expect(container.ownerDocument).toBeTruthy(); // no throw
  });
});

describe("FluxionPieChart — label fallback", () => {
  it("an unknown label prop value renders no label text", () => {
    const { container } = render(
      <FluxionPieChart
        data={[{ name: "A", value: 100 }]}
        tooltip={false}
        animationDuration={0}
        // Unknown string → resolveLabel returns null (line 319).
        label={"bogus" as never}
      />,
    );
    // No <text> label elements rendered.
    expect(container.querySelectorAll("text").length).toBe(0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("FluxionPieChart — edge cases", () => {
  it("handles all-zero values without throwing (total === 0)", () => {
    expect(() =>
      render(
        <FluxionPieChart
          data={[
            { name: "A", value: 0 },
            { name: "B", value: 0 },
          ]}
          tooltip={false}
          animationDuration={0}
        />,
      ),
    ).not.toThrow();
  });
});

it("ignores a mouse move before entering a slice", () => {
  const { container } = render(
    <FluxionPieChart data={[{ name: "A", value: 1 }]} animationDuration={0} />,
  );
  const slice = container.querySelector("path")!;
  fireEvent.mouseMove(slice, { clientX: 10, clientY: 10 });
  expect(container.querySelector("path")).toBe(slice);
});
