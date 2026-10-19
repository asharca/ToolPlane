import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Table } from "@/components/motion/table";
import { RowHandle } from "@/components/motion/table/row-handle";
import { TableMenu } from "@/components/motion/table/table-menu";
import { EditableCell } from "@/components/motion/table/editable-cell";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("table column controls", () => {
  it("cycles header sort accessibility and lets editable headers rename without triggering sorting", () => {
    const sort = vi.fn(),
      rename = vi.fn();
    render(
      <Table
        data={[]}
        columns={[
          { key: "name", header: "Name", sortable: true },
          { key: "notes", header: "Notes", align: "center" },
        ]}
        onSortChange={sort}
        onColumnRename={rename}
      />,
    );
    const name = screen.getByRole("button", { name: "Name" });
    fireEvent.click(name);
    expect(name.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(name);
    expect(name.closest("th")).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(name);
    expect(name.closest("th")).not.toHaveAttribute("aria-sort");
    expect(sort).toHaveBeenLastCalledWith(null);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Rename notes column" }),
      { target: { value: "Observations" } },
    );
    expect(rename).toHaveBeenCalledWith("notes", "Observations");
    expect(sort).toHaveBeenCalledTimes(3);
  });

  it("exposes insert/delete actions from the hovered column and targets its current column index", () => {
    const insert = vi.fn(),
      remove = vi.fn();
    render(
      <Table
        data={[]}
        columns={[
          { key: "name", header: "Name" },
          { key: "notes", header: "Notes" },
        ]}
        onInsertColumn={insert}
        onDeleteColumn={remove}
      />,
    );
    fireEvent.pointerOver(screen.getByRole("columnheader", { name: "Notes" }));
    const options = screen.getByRole("button", {
      name: "notes column options",
    });
    fireEvent.click(options);
    fireEvent.click(screen.getByRole("menuitem", { name: "Insert before" }));
    expect(insert).toHaveBeenCalledWith(1, "before");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(options);
    fireEvent.click(screen.getByRole("menuitem", { name: "Insert after" }));
    expect(insert).toHaveBeenLastCalledWith(1, "after");
    fireEvent.click(options);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete column" }));
    expect(remove).toHaveBeenCalledWith("notes", 1);
  });

  it("reports edits through a controlled cell rather than overwriting its owned value", () => {
    const change = vi.fn();
    const { rerender } = render(
      <EditableCell value="before" label="Task title" onChange={change} />,
    );
    const input = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.change(input, { target: { value: "after" } });
    expect(change).toHaveBeenCalledWith("after");
    expect(input).toHaveValue("before");
    rerender(
      <EditableCell value="after" label="Task title" onChange={change} />,
    );
    expect(input).toHaveValue("after");
  });
});

describe("table row actions", () => {
  it("inserts before/after the selected row and deletes by stable ID", () => {
    const insert = vi.fn(),
      remove = vi.fn();
    const row = document.createElement("tr");
    render(
      <RowHandle
        rowEl={row}
        id="stable-row"
        index={4}
        onInsertRow={insert}
        onDeleteRow={remove}
        onEnter={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Row 5 options" });
    for (const position of ["before", "after"] as const) {
      fireEvent.click(trigger);
      fireEvent.click(
        screen.getByRole("menuitem", { name: `Insert ${position}` }),
      );
      expect(insert).toHaveBeenLastCalledWith(4, position);
    }
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete row" }));
    expect(remove).toHaveBeenCalledWith("stable-row", 4);
  });

  it("omits unavailable actions and renders no handle for an absent row", () => {
    const props = { id: "row", index: 0, onEnter: vi.fn(), onLeave: vi.fn() };
    const { rerender } = render(<RowHandle {...props} rowEl={null} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(
      <RowHandle
        {...props}
        rowEl={document.createElement("tr")}
        onDeleteRow={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(
      screen.getByRole("menuitem", { name: "Delete row" }),
    ).toBeInTheDocument();
  });
});

describe("table action menu dismissal", () => {
  it.each(["Escape", "resize", "scroll", "toggle"])(
    "dismisses on %s and permits reopening",
    (event) => {
      render(
        <TableMenu
          ariaLabel="Options"
          trigger="More"
          items={[{ label: "Delete", onSelect: vi.fn(), destructive: true }]}
        />,
      );
      const trigger = screen.getByRole("button", { name: "Options" });
      fireEvent.click(trigger);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      if (event === "Escape") fireEvent.keyDown(window, { key: event });
      else if (event === "toggle") fireEvent.click(trigger);
      else fireEvent(window, new Event(event));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      expect(screen.getByRole("menu")).toBeInTheDocument();
    },
  );
});
