import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluxionTable, type FluxionTableColumn } from "./fluxion-table";

afterEach(cleanup);

type Row = { id: string; value: number; label: string };

const COLUMNS = [
  { key: "id" as const, header: "ID" },
  { key: "value" as const, header: "Value" },
  { key: "label" as const, header: "Label" },
];

const ROWS: Row[] = [
  { id: "a", value: 1.23, label: "alpha" },
  { id: "b", value: 4.56, label: "beta" },
];

describe("FluxionTable", () => {
  it("renders column headers", () => {
    render(<FluxionTable columns={COLUMNS} rows={[]} />);
    expect(screen.getByText("ID")).toBeTruthy();
    expect(screen.getByText("Value")).toBeTruthy();
    expect(screen.getByText("Label")).toBeTruthy();
  });

  it("renders one row per entry", () => {
    render(<FluxionTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("1.23")).toBeTruthy();
    expect(screen.getByText("4.56")).toBeTruthy();
  });

  it("renders empty tbody when rows is empty", () => {
    const { container } = render(<FluxionTable columns={COLUMNS} rows={[]} />);
    const tbody = container.querySelector("tbody");
    expect(tbody?.children.length).toBe(0);
  });

  it("applies classNames to all elements", () => {
    const { container } = render(
      <FluxionTable
        columns={COLUMNS}
        rows={ROWS}
        classNames={{
          root: "my-root",
          table: "my-table",
          thead: "my-thead",
          tbody: "my-tbody",
          tr: "my-tr",
          th: "my-th",
          td: "my-td",
        }}
      />,
    );
    expect(container.querySelector(".my-root")).toBeTruthy();
    expect(container.querySelector(".my-table")).toBeTruthy();
    expect(container.querySelector(".my-thead")).toBeTruthy();
    expect(container.querySelector(".my-tbody")).toBeTruthy();
    expect(container.querySelectorAll(".my-tr").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".my-th").length).toBe(COLUMNS.length);
    expect(container.querySelectorAll(".my-td").length).toBe(
      ROWS.length * COLUMNS.length,
    );
  });

  it("uses render function when provided", () => {
    const columns: FluxionTableColumn<Row>[] = [
      {
        key: "value",
        header: "Value",
        render: (v) => <span data-testid="custom">{(Number(v) * 2).toFixed(2)}</span>,
      },
    ];
    render(<FluxionTable columns={columns} rows={[{ id: "x", value: 3, label: "x" }]} />);
    expect(screen.getByTestId("custom").textContent).toBe("6.00");
  });

  it("falls back to String() for non-string cell values", () => {
    render(
      <FluxionTable
        columns={[{ key: "value" as const, header: "V" }]}
        rows={[{ id: "x", value: 0, label: "" }]}
      />,
    );
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("renders an empty string for a null/undefined cell value", () => {
    const { container } = render(
      <FluxionTable
        columns={[{ key: "label" as const, header: "L" }]}
        // label is null → `row[col.key] ?? ""` takes the empty-string branch.
        rows={[{ id: "x", value: 0, label: null as never }]}
      />,
    );
    const cell = container.querySelector("tbody td");
    expect(cell?.textContent).toBe("");
  });

  it("applies style prop to root wrapper", () => {
    const { container } = render(
      <FluxionTable columns={COLUMNS} rows={[]} style={{ color: "red" }} />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.style.color).toBe("red");
  });

  it("renders correct number of th and td elements", () => {
    const { container } = render(<FluxionTable columns={COLUMNS} rows={ROWS} />);
    expect(container.querySelectorAll("th").length).toBe(COLUMNS.length);
    expect(container.querySelectorAll("td").length).toBe(ROWS.length * COLUMNS.length);
  });

  describe("sortable columns", () => {
    const sortCols: FluxionTableColumn<Row>[] = [
      { key: "id", header: "ID", sortable: true },
      { key: "value", header: "Value", sortable: true },
      { key: "label", header: "Label" }, // not sortable
    ];
    const unsorted: Row[] = [
      { id: "b", value: 30, label: "z" },
      { id: "a", value: 10, label: "y" },
      { id: "c", value: 20, label: "x" },
    ];

    function firstColumnValues(container: HTMLElement, colIndex: number): string[] {
      return Array.from(container.querySelectorAll("tbody tr")).map(
        (tr) => tr.children[colIndex]!.textContent ?? "",
      );
    }

    it("sorts numbers ascending then descending on header clicks", () => {
      const { container } = render(<FluxionTable columns={sortCols} rows={unsorted} />);
      const valueHeader = screen.getByText(/Value/);
      fireEvent.click(valueHeader);
      expect(firstColumnValues(container, 1)).toEqual(["10", "20", "30"]);
      fireEvent.click(valueHeader);
      expect(firstColumnValues(container, 1)).toEqual(["30", "20", "10"]);
    });

    it("sorts strings with locale compare", () => {
      const { container } = render(<FluxionTable columns={sortCols} rows={unsorted} />);
      fireEvent.click(screen.getByText(/ID/));
      expect(firstColumnValues(container, 0)).toEqual(["a", "b", "c"]);
    });

    it("ignores clicks on non-sortable headers", () => {
      const { container } = render(<FluxionTable columns={sortCols} rows={unsorted} />);
      fireEvent.click(screen.getByText("Label"));
      // order unchanged
      expect(firstColumnValues(container, 0)).toEqual(["b", "a", "c"]);
    });

    it("keeps equal values stable", () => {
      const rows: Row[] = [
        { id: "a", value: 5, label: "p" },
        { id: "b", value: 5, label: "q" },
      ];
      const { container } = render(<FluxionTable columns={sortCols} rows={rows} />);
      fireEvent.click(screen.getByText(/Value/));
      expect(firstColumnValues(container, 0)).toEqual(["a", "b"]);
    });

    it("falls back to unsorted when the active sort column disappears", () => {
      const { container, rerender } = render(
        <FluxionTable columns={sortCols} rows={unsorted} />,
      );
      fireEvent.click(screen.getByText(/Value/)); // sort by value
      expect(firstColumnValues(container, 0)).toEqual(["a", "c", "b"]);
      // Re-render without the "value" column → sort key no longer resolvable.
      const fewerCols: FluxionTableColumn<Row>[] = [
        { key: "id", header: "ID", sortable: true },
        { key: "label", header: "Label" },
      ];
      rerender(<FluxionTable columns={fewerCols} rows={unsorted} />);
      // Back to original row order (sort guard returns rows).
      expect(firstColumnValues(container, 0)).toEqual(["b", "a", "c"]);
    });
  });

  it("marks the header sticky when stickyHeader is set", () => {
    const { container } = render(
      <FluxionTable columns={COLUMNS} rows={ROWS} stickyHeader />,
    );
    const th = container.querySelector("th") as HTMLElement;
    expect(th.style.position).toBe("sticky");
  });

  describe("virtual scrolling", () => {
    const manyRows: Row[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `r${i}`,
      value: i,
      label: `row ${i}`,
    }));

    function bodyRows(container: HTMLElement): HTMLElement[] {
      // Exclude the aria-hidden spacer rows.
      return Array.from(container.querySelectorAll("tbody tr")).filter(
        (tr) => !tr.hasAttribute("aria-hidden"),
      ) as HTMLElement[];
    }

    it("renders only the visible window plus overscan, not all rows", () => {
      const { container } = render(
        <FluxionTable
          columns={COLUMNS}
          rows={manyRows}
          virtual={{ rowHeight: 20, height: 200, overscan: 2 }}
        />,
      );
      // ~10 visible + 2 overscan (top clamped at 0) → far fewer than 1000.
      const rendered = bodyRows(container);
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered.length).toBeLessThan(30);
    });

    it("adds a bottom spacer row to preserve scroll height", () => {
      const { container } = render(
        <FluxionTable
          columns={COLUMNS}
          rows={manyRows}
          virtual={{ rowHeight: 20, height: 200 }}
        />,
      );
      const spacers = container.querySelectorAll("tbody tr[aria-hidden]");
      // At scrollTop 0 there is no top spacer but there is a bottom spacer.
      expect(spacers.length).toBe(1);
      const spacerCell = spacers[0]!.querySelector("td") as HTMLElement;
      expect(spacerCell.getAttribute("colspan")).toBe(String(COLUMNS.length));
    });

    it("shifts the window and adds a top spacer on scroll", () => {
      const { container } = render(
        <FluxionTable
          columns={COLUMNS}
          rows={manyRows}
          virtual={{ rowHeight: 20, height: 200, overscan: 1 }}
        />,
      );
      const root = container.firstChild as HTMLElement;
      fireEvent.scroll(root, { target: { scrollTop: 2000 } }); // 100 rows down
      // first rendered data row should be around index 99 (100 - overscan).
      const firstRow = bodyRows(container)[0]!;
      expect(firstRow.textContent).toContain("row 9"); // r99/row 99 region
      // both top and bottom spacers now present
      expect(container.querySelectorAll("tbody tr[aria-hidden]").length).toBe(2);
    });

    it("renders all rows when virtual is omitted", () => {
      const { container } = render(
        <FluxionTable columns={COLUMNS} rows={manyRows.slice(0, 50)} />,
      );
      expect(bodyRows(container).length).toBe(50);
    });

    describe("scrollThrottleMs", () => {
      function firstRowText(container: HTMLElement): string {
        return bodyRows(container)[0]!.textContent ?? "";
      }

      it("applies the first scroll immediately (leading edge)", () => {
        vi.useFakeTimers();
        try {
          const { container } = render(
            <FluxionTable
              columns={COLUMNS}
              rows={manyRows}
              virtual={{ rowHeight: 20, height: 200, overscan: 1, scrollThrottleMs: 50 }}
            />,
          );
          const root = container.firstChild as HTMLElement;
          act(() => {
            fireEvent.scroll(root, { target: { scrollTop: 2000 } }); // row ~100
          });
          expect(firstRowText(container)).toContain("row 9");
        } finally {
          vi.useRealTimers();
        }
      });

      it("clears a pending trailing-flush timer on unmount", () => {
        vi.useFakeTimers();
        try {
          const { container, unmount } = render(
            <FluxionTable
              columns={COLUMNS}
              rows={manyRows}
              virtual={{ rowHeight: 20, height: 200, overscan: 1, scrollThrottleMs: 50 }}
            />,
          );
          const root = container.firstChild as HTMLElement;
          // Leading scroll, then a within-window scroll that schedules a timer.
          act(() => {
            fireEvent.scroll(root, { target: { scrollTop: 2000 } });
            fireEvent.scroll(root, { target: { scrollTop: 4000 } });
          });
          // Unmount with the timer still pending — cleanup must clear it so the
          // trailing flush never fires into an unmounted component.
          expect(() => {
            unmount();
            vi.advanceTimersByTime(100);
          }).not.toThrow();
        } finally {
          vi.useRealTimers();
        }
      });

      it("coalesces a burst into a single trailing flush at the latest position", () => {
        vi.useFakeTimers();
        try {
          const { container } = render(
            <FluxionTable
              columns={COLUMNS}
              rows={manyRows}
              virtual={{ rowHeight: 20, height: 200, overscan: 1, scrollThrottleMs: 50 }}
            />,
          );
          const root = container.firstChild as HTMLElement;
          // Leading scroll lands immediately.
          act(() => {
            fireEvent.scroll(root, { target: { scrollTop: 2000 } });
          });
          // Burst within the throttle window — none applied yet.
          act(() => {
            fireEvent.scroll(root, { target: { scrollTop: 4000 } });
            fireEvent.scroll(root, { target: { scrollTop: 6000 } });
          });
          expect(firstRowText(container)).toContain("row 9"); // still at ~100
          // Trailing flush applies the LAST position (6000 → row ~300).
          act(() => {
            vi.advanceTimersByTime(50);
          });
          expect(firstRowText(container)).toContain("row 29");
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });
});

it("toggles descending back to ascending and supports a styled virtual root", () => {
  const columns = [{ key: "id" as const, header: "ID", sortable: true }];
  const { container } = render(
    <FluxionTable
      columns={columns}
      rows={ROWS}
      classNames={{ root: "custom-root" }}
      virtual={{ height: 100, rowHeight: 20 }}
    />,
  );
  const header = container.querySelector("th")!;
  fireEvent.click(header);
  fireEvent.click(header);
  fireEvent.click(header);
  expect(container.querySelector("tbody tr")?.textContent).toContain("a");
  expect((container.firstChild as HTMLElement).style.height).toBe("100px");
});
