import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Table } from "@/components/motion/table";
import type {
  HeaderCellRefs,
  SortState,
  TableColumn,
} from "@/components/motion/table/types";
import { useColumnReorder } from "@/components/motion/table/use-column-reorder";
import { useColumnResize } from "@/components/motion/table/use-column-resize";
import { useColumnSort } from "@/components/motion/table/use-column-sort";
import { useRowSelection } from "@/components/motion/table/use-row-selection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const rows = [
  { id: "b", row: { name: "Beta", score: 20 } },
  { id: "a", row: { name: "Alpha", score: 3 } },
  { id: "c", row: { name: "Gamma", score: 9 } },
];
type Row = (typeof rows)[number]["row"];
const columns: TableColumn<Row>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "score", header: "Score", sortable: true, align: "right" },
];
function event(x: number): ReactPointerEvent {
  return {
    clientX: x,
    pointerId: 1,
    currentTarget: document.createElement("button"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactPointerEvent;
}
function refs(): HeaderCellRefs {
  return {
    current: Object.fromEntries(
      ["name", "score"].map((key, index) => {
        const cell = document.createElement("th");
        vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
          left: index * 100,
          width: 100,
        } as DOMRect);
        return [key, cell];
      }),
    ),
  };
}

describe("table state transitions", () => {
  it("sorts numerically and lexically, cycles back to input order, and leaves original data untouched", () => {
    const { result } = renderHook(() => useColumnSort({ rows, columns }));
    act(() => result.current.toggleSort("score"));
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(["a", "c", "b"]);
    act(() => result.current.toggleSort("score"));
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    act(() => result.current.toggleSort("score"));
    expect(result.current.sortedRows).toBe(rows);
    act(() => result.current.toggleSort("name"));
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("uses a custom sort accessor, tolerates removed columns and leaves controlled sort changes to its owner", () => {
    const changed = vi.fn();
    const { result, rerender } = renderHook(
      ({ sort }: { sort: SortState | null }) =>
        useColumnSort({
          rows,
          columns: [
            {
              key: "length",
              header: "Length",
              sortValue: (row: Row) => row.name.length,
            },
          ],
          sort,
          onSortChange: changed,
        }),
      {
        initialProps: {
          sort: { key: "length", direction: "asc" } as SortState | null,
        },
      },
    );
    expect(result.current.sortedRows[0].id).toBe("b");
    act(() => result.current.toggleSort("length"));
    expect(changed).toHaveBeenCalledWith({ key: "length", direction: "desc" });
    expect(result.current.sort?.direction).toBe("asc");
    rerender({ sort: { key: "removed", direction: "asc" } });
    expect(result.current.sortedRows).toBe(rows);
    rerender({ sort: null });
    expect(result.current.sortedRows).toBe(rows);
  });

  it("selects visible rows without dropping off-page selections and clears all deliberately", () => {
    const { result } = renderHook(() =>
      useRowSelection({
        sortedRows: rows,
        defaultSelectedRowIds: ["off-page"],
      }),
    );
    expect(result.current.someSelected).toBe(false);
    act(() => result.current.toggleRow("a"));
    expect(result.current.someSelected).toBe(true);
    expect(result.current.allSelected).toBe(false);
    act(() => result.current.toggleRow("a"));
    expect(result.current.someSelected).toBe(false);
    act(() => result.current.toggleAll());
    expect(result.current.allSelected).toBe(true);
    expect([...result.current.selected]).toEqual(["off-page", "b", "a", "c"]);
    act(() => result.current.toggleAll());
    expect([...result.current.selected]).toEqual(["off-page"]);
    act(() => result.current.clearSelection());
    expect(result.current.selected.size).toBe(0);
  });

  it("does not mutate controlled selection and reports empty tables as unselected", () => {
    const changed = vi.fn();
    const { result, rerender } = renderHook(
      ({ data }) =>
        useRowSelection({
          sortedRows: data,
          selectedRowIds: ["a"],
          onSelectionChange: changed,
        }),
      { initialProps: { data: rows } },
    );
    act(() => result.current.toggleRow("b"));
    expect(changed).toHaveBeenCalledWith(["a", "b"]);
    expect([...result.current.selected]).toEqual(["a"]);
    rerender({ data: [] });
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(false);
  });

  it("freezes adjacent column widths during resize, clamps the minimum, and commits only a completed resize", () => {
    const changed = vi.fn();
    const headers = refs();
    const { result } = renderHook(() =>
      useColumnResize({
        orderedColumns: columns,
        thRefs: headers,
        minColumnWidth: 64,
        onColumnResize: changed,
      }),
    );
    act(() => result.current.moveResize(event(999)));
    expect(result.current.widths).toEqual({});
    act(() => result.current.endResize(event(999)));
    expect(changed).not.toHaveBeenCalled();
    act(() => result.current.startResize("name", event(100)));
    expect(result.current.widths).toEqual({ name: 100, score: 100 });
    act(() => result.current.moveResize(event(-100)));
    expect(result.current.widths).toEqual({ name: 64, score: 100 });
    act(() => result.current.endResize(event(-100)));
    expect(changed).toHaveBeenCalledWith("name", 64);
    act(() => result.current.startResize("name", event(0)));
    act(() => result.current.moveResize(event(50)));
    act(() => result.current.endResize(event(50)));
    expect(changed).toHaveBeenLastCalledWith("name", 114);
  });

  it("reorders in both directions and reconciles newly inserted and removed columns", () => {
    const changed = vi.fn();
    const headers = refs();
    const { result, rerender } = renderHook(
      ({ cols }) =>
        useColumnReorder({
          columns: cols,
          thRefs: headers,
          onColumnOrderChange: changed,
        }),
      { initialProps: { cols: columns } },
    );
    act(() => result.current.moveReorder(event(200)));
    expect(result.current.dropIndex).toBeNull();
    act(() => result.current.startReorder("name", event(0)));
    act(() => result.current.moveReorder(event(300)));
    act(() => result.current.endReorder(event(300)));
    expect(result.current.orderedColumns.map((c) => c.key)).toEqual([
      "score",
      "name",
    ]);
    expect(changed).toHaveBeenCalledWith(["score", "name"]);
    act(() => result.current.startReorder("name", event(100)));
    act(() => result.current.moveReorder(event(-1)));
    act(() => result.current.endReorder(event(-1)));
    expect(result.current.orderedColumns.map((c) => c.key)).toEqual([
      "name",
      "score",
    ]);
    rerender({
      cols: [
        { key: "first", header: "First" },
        columns[0],
        { key: "middle", header: "Middle" },
      ],
    });
    expect(result.current.orderedColumns.map((c) => c.key)).toEqual([
      "first",
      "name",
      "middle",
    ]);
    expect(result.current.dragKey).toBeNull();
    expect(result.current.dropIndex).toBeNull();
  });
});

describe("table loading and layout", () => {
  it("keeps column geometry during selection and restores keyboard focus after clearing", () => {
    render(
      <Table
        data={rows.map(({ row }) => row)}
        columns={columns}
        selectable
        resizable
        selectionActions={({ clearSelection }) => (
          <button type="button" onClick={clearSelection}>
            Clear selected
          </button>
        )}
      />,
    );
    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getByRole("columnheader", { name: "Name" })).toBe(nameHeader);
    expect(
      screen.queryByRole("button", { name: /Resize/ }),
    ).not.toBeInTheDocument();
    const clear = screen.getByRole("button", { name: "Clear selected" });
    act(() => clear.focus());
    fireEvent.click(clear);
    expect(
      screen.getByRole("checkbox", { name: "Select all rows" }),
    ).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Clear selected" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toBe(nameHeader);
  });
  it("switches from loading skeletons to its custom empty state and budgets absolute/input widths", () => {
    const layoutColumns: TableColumn<Row>[] = [
      { key: "name", header: "Name", width: "10rem" },
      { key: "score", header: "Score", editable: true },
    ];
    const { rerender } = render(
      <Table
        data={[]}
        columns={layoutColumns}
        loading
        selectable
        height={96}
        rowHeight={48}
        emptyState="Nothing matched"
      />,
    );
    expect(screen.queryByText("Nothing matched")).not.toBeInTheDocument();
    expect(screen.getByRole("table").style.minWidth).toBe("max(100%, 328px)");
    rerender(
      <Table
        data={[]}
        columns={layoutColumns}
        selectable
        emptyState="Nothing matched"
      />,
    );
    expect(screen.getByText("Nothing matched")).toHaveAttribute("colspan", "4");
  });

  it("requests more data only once per dwell and pauses while a load is outstanding", () => {
    const end = vi.fn();
    const { rerender } = render(
      <Table data={[]} columns={columns} onEndReached={end} />,
    );
    const viewport = screen.getByRole("table").parentElement as HTMLElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(viewport);
    expect(end).not.toHaveBeenCalled();
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);
    expect(end).toHaveBeenCalledOnce();
    rerender(<Table data={[]} columns={columns} onEndReached={end} loading />);
    fireEvent.scroll(viewport);
    expect(end).toHaveBeenCalledOnce();
    rerender(<Table data={[]} columns={columns} onEndReached={end} />);
    fireEvent.scroll(viewport);
    expect(end).toHaveBeenCalledTimes(2);
  });
});
