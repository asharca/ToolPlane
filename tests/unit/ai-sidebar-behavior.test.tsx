import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AISidebar } from "@/components/agents/ai-sidebar";
import type { SidebarResource } from "@/components/agents/ai-sidebar";

const items: SidebarResource[] = [
  {
    id: "folder",
    label: "Folder",
    kind: "folder",
    children: [
      { id: "child", label: "Child", kind: "file" },
      { id: "locked", label: "Locked", kind: "file", disabled: true },
    ],
  },
  { id: "project", label: "Project", kind: "project" },
  { id: "file", label: "File", kind: "file" },
  { id: "bookmark", label: "Bookmark", kind: "bookmark" },
];
const row = (name: string) =>
  screen.getByRole("treeitem", { name: new RegExp(`^${name}(?:$|Actions)`) });
const labels = () =>
  screen
    .getAllByRole("treeitem")
    .map(
      (element) =>
        within(element).queryByText(
          /^(Folder|Child|Locked|Project|File|Bookmark)$/,
        )?.textContent,
    );
const moveKey = (name: string, key: string) =>
  fireEvent.keyDown(row(name), { key, altKey: true, shiftKey: true });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("resource tree keyboard accessibility", () => {
  it("maintains one tab stop through expansion, parent navigation, Home/End and controlled selection", async () => {
    const active = vi.fn();
    render(
      <AISidebar
        defaultItems={items}
        activeId="file"
        onActiveChange={active}
      />,
    );
    expect(row("File")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row("File"), { key: "Home" });
    await waitFor(() => expect(row("Folder")).toHaveFocus());
    fireEvent.keyDown(row("Folder"), { key: "ArrowRight" });
    expect(row("Folder")).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(row("Folder"), { key: "ArrowRight" });
    await waitFor(() => expect(row("Child")).toHaveFocus());
    fireEvent.keyDown(row("Child"), { key: "ArrowLeft" });
    await waitFor(() => expect(row("Folder")).toHaveFocus());
    fireEvent.keyDown(row("Folder"), { key: "ArrowLeft" });
    expect(row("Folder")).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(row("Folder"), { key: "End" });
    await waitFor(() => expect(row("Bookmark")).toHaveFocus());
    fireEvent.keyDown(row("Bookmark"), { key: "ArrowUp" });
    await waitFor(() => expect(row("File")).toHaveFocus());
    fireEvent.keyDown(row("File"), { key: "ArrowDown" });
    await waitFor(() => expect(row("Bookmark")).toHaveFocus());
    fireEvent.keyDown(row("Bookmark"), { key: " " });
    expect(active).toHaveBeenCalledWith("bookmark");
    expect(row("File")).toHaveAttribute("aria-selected", "true");
    expect(row("Bookmark")).toHaveAttribute("aria-selected", "false");
    expect(
      screen
        .getAllByRole("treeitem")
        .filter((element) => element.tabIndex === 0),
    ).toHaveLength(1);
  });
  it.each(["Enter", " ", "F2", "ContextMenu", "ArrowRight", "F10"])(
    "does not activate or edit a disabled resource on %s",
    (key) => {
      const active = vi.fn(),
        rename = vi.fn(),
        move = vi.fn();
      render(
        <AISidebar
          defaultItems={items}
          defaultExpandedIds={["folder"]}
          onActiveChange={active}
          onRename={rename}
          onMove={move}
        />,
      );
      const locked = row("Locked");
      fireEvent.keyDown(locked, { key, shiftKey: key === "F10" });
      fireEvent.click(locked);
      fireEvent.doubleClick(locked);
      expect(active).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(within(locked).queryByRole("button")).not.toBeInTheDocument();
    },
  );
  it("allows navigation away from disabled children but suppresses move commands", async () => {
    render(<AISidebar defaultItems={items} defaultExpandedIds={["folder"]} />);
    moveKey("Locked", "ArrowRight");
    expect(row("Locked")).toHaveAttribute("aria-level", "2");
    fireEvent.keyDown(row("Locked"), { key: "ArrowLeft" });
    await waitFor(() => expect(row("Folder")).toHaveFocus());
  });
  it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])(
    "opens the resource menu using %j and returns focus after rename",
    async (event) => {
      render(<AISidebar defaultItems={items} />);
      fireEvent.keyDown(row("File"), event);
      const rename = await screen.findByRole("button", { name: "Rename" });
      expect(rename).toHaveFocus();
      fireEvent.click(rename);
      expect(screen.getByRole("textbox", { name: "Rename File" })).toHaveValue(
        "File",
      );
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    },
  );
});

describe("resource renaming transactions", () => {
  it.each(["Enter", "blur"])(
    "trims and commits a nested rename on %s",
    async (mode) => {
      const changed = vi.fn(),
        rename = vi.fn();
      render(
        <AISidebar
          defaultItems={items}
          defaultExpandedIds={["folder"]}
          onItemsChange={changed}
          onRename={rename}
        />,
      );
      fireEvent.keyDown(row("Child"), { key: "F2" });
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "  Renamed child  " } });
      if (mode === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.blur(input);
      expect(screen.getByText("Renamed child")).toBeInTheDocument();
      expect(changed.mock.lastCall?.[0][0].children[0].label).toBe(
        "Renamed child",
      );
      expect(rename).toHaveBeenCalledWith(
        expect.objectContaining({ id: "child", label: "Child" }),
        "Renamed child",
      );
    },
  );
  it.each(["   ", "File"])(
    "does not persist an empty or unchanged draft %j",
    (value) => {
      const rename = vi.fn();
      render(<AISidebar defaultItems={items} onRename={rename} />);
      fireEvent.doubleClick(row("File"));
      fireEvent.change(screen.getByRole("textbox"), { target: { value } });
      fireEvent.blur(screen.getByRole("textbox"));
      expect(rename).not.toHaveBeenCalled();
      expect(row("File")).toBeInTheDocument();
    },
  );
  it("rolls back a rejected rename and announces restoration", async () => {
    const rename = vi.fn().mockRejectedValue(new Error("denied"));
    render(<AISidebar defaultItems={items} onRename={rename} />);
    fireEvent.keyDown(row("File"), { key: "F2" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Changed" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(row("File")).toBeInTheDocument());
    expect(
      screen.getByText("Rename failed. File was restored."),
    ).toHaveAttribute("aria-live", "polite");
  });
});

describe("resource move transactions", () => {
  it("moves a file into a project, expands its destination, then moves it out", async () => {
    const move = vi.fn();
    render(<AISidebar defaultItems={items} onMove={move} />);
    await act(async () => moveKey("File", "ArrowRight"));
    expect(row("Project")).toHaveAttribute("aria-expanded", "true");
    expect(row("File")).toHaveAttribute("aria-level", "2");
    expect(move).toHaveBeenLastCalledWith({
      itemId: "file",
      targetId: "project",
      position: "inside",
    });
    await act(async () => moveKey("File", "ArrowLeft"));
    expect(row("File")).toHaveAttribute("aria-level", "1");
    expect(move).toHaveBeenLastCalledWith({
      itemId: "file",
      targetId: "project",
      position: "after",
    });
  });
  it("reorders siblings with keyboard moves and announces each destination", async () => {
    render(<AISidebar defaultItems={items} />);
    await act(async () => moveKey("File", "ArrowUp"));
    expect(labels()).toEqual(["Folder", "File", "Project", "Bookmark"]);
    expect(screen.getByText("Moved File before Project.")).toBeInTheDocument();
    await act(async () => moveKey("File", "ArrowDown"));
    expect(labels()).toEqual(["Folder", "Project", "File", "Bookmark"]);
  });
  it("serializes pending moves and restores the original tree after a rejection", async () => {
    let reject = (_error: Error) => {};
    const error = new Error("permission denied"),
      onError = vi.fn();
    const move = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(
      <AISidebar defaultItems={items} onMove={move} onMoveError={onError} />,
    );
    moveKey("File", "ArrowUp");
    expect(labels()).toEqual(["Folder", "File", "Project", "Bookmark"]);
    moveKey("File", "ArrowUp");
    expect(move).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Wait for the current move to finish."),
    ).toBeInTheDocument();
    await act(async () => reject(error));
    expect(labels()).toEqual(["Folder", "Project", "File", "Bookmark"]);
    expect(onError).toHaveBeenCalledWith(error, {
      itemId: "file",
      targetId: "project",
      position: "before",
    });
    expect(
      screen.getByText("Move failed. File was restored."),
    ).toBeInTheDocument();
  });
  it.each(["Move up", "Move down", "Move into Project"])(
    "offers the keyboard-equivalent %s action from the row menu",
    async (name) => {
      const move = vi.fn();
      render(<AISidebar defaultItems={items} onMove={move} />);
      fireEvent.click(screen.getByRole("button", { name: "Actions for File" }));
      fireEvent.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(move).toHaveBeenCalledOnce());
      if (name === "Move into Project")
        expect(row("File")).toHaveAttribute("aria-level", "2");
      else
        expect(labels()).toEqual(
          name === "Move up"
            ? ["Folder", "File", "Project", "Bookmark"]
            : ["Folder", "Project", "Bookmark", "File"],
        );
    },
  );
  it("offers move out only for nested resources and refuses to move a folder into its descendant", async () => {
    const move = vi.fn();
    render(
      <AISidebar
        defaultItems={items}
        defaultExpandedIds={["folder"]}
        onMove={move}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions for Child" }));
    expect(
      screen.queryByRole("button", { name: "Move into Folder" }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Move out" }));
    await waitFor(() =>
      expect(row("Child")).toHaveAttribute("aria-level", "1"),
    );
    await act(async () => moveKey("Folder", "ArrowDown"));
    expect(move).toHaveBeenCalledTimes(1);
  });
});

const transfer = () => ({ effectAllowed: "", setData: vi.fn() });
function dragOver(element: HTMLElement, clientY: number) {
  const event = createEvent.dragOver(element);
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}
describe("resource pointer drag policies", () => {
  it.each([
    { y: 2, position: "before" },
    { y: 50, position: "inside" },
    { y: 98, position: "after" },
  ])("moves relative to a container at $position", async ({ y, position }) => {
    const move = vi.fn();
    render(<AISidebar defaultItems={items} onMove={move} />);
    const target = row("Project");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);
    const dataTransfer = transfer();
    fireEvent.dragStart(row("File"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "file");
    dragOver(target, y);
    fireEvent.drop(target);
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith({
        itemId: "file",
        targetId: "project",
        position,
      }),
    );
    if (position === "inside") {
      expect(
        screen.queryByRole("treeitem", { name: /^File/ }),
      ).not.toBeInTheDocument();
      fireEvent.click(row("Project"));
      expect(row("File")).toHaveAttribute("aria-level", "2");
    } else expect(row("File")).toHaveAttribute("aria-level", "1");
  });
  it("drops nested files at the root and ignores self/descendant drag targets", async () => {
    const move = vi.fn();
    render(
      <AISidebar
        defaultItems={items}
        defaultExpandedIds={["folder"]}
        onMove={move}
      />,
    );
    fireEvent.dragStart(row("Folder"), { dataTransfer: transfer() });
    dragOver(row("Folder"), 1);
    dragOver(row("Child"), 1);
    fireEvent.drop(row("Child"));
    expect(move).not.toHaveBeenCalled();
    fireEvent.dragEnd(row("Folder"));
    fireEvent.dragStart(row("Child"), { dataTransfer: transfer() });
    fireEvent.dragOver(screen.getByRole("tree"));
    fireEvent.drop(screen.getByRole("tree"));
    await waitFor(() =>
      expect(row("Child")).toHaveAttribute("aria-level", "1"),
    );
    expect(move).toHaveBeenCalledWith({
      itemId: "child",
      targetId: null,
      position: "after",
    });
  });
});

describe("resource policy and controlled updates", () => {
  it("does not reparent into a disabled container, select folders, or select a row while its name is edited", async () => {
    const active = vi.fn(),
      move = vi.fn();
    render(
      <AISidebar
        defaultItems={[
          {
            id: "blocked",
            label: "Blocked folder",
            kind: "folder",
            disabled: true,
          },
          { id: "file", label: "File", kind: "file" },
        ]}
        onActiveChange={active}
        onMove={move}
      />,
    );
    await act(async () => moveKey("File", "ArrowRight"));
    expect(move).not.toHaveBeenCalled();
    expect(row("File")).toHaveAttribute("aria-level", "1");
    fireEvent.keyDown(row("File"), { key: "F2" });
    fireEvent.click(screen.getByRole("textbox"));
    fireEvent.doubleClick(screen.getByRole("textbox"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "x" });
    expect(active).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.click(row("File"));
    expect(row("File")).toHaveAttribute("aria-selected", "true");
    expect(active).toHaveBeenCalledWith("file");
  });
  it("accepts new controlled resources and falls back to a reachable tab stop after its focused item disappears", async () => {
    const { rerender } = render(<AISidebar items={items} activeId="file" />);
    expect(row("File")).toHaveAttribute("tabindex", "0");
    rerender(
      <AISidebar
        items={[{ id: "new", label: "New resource", kind: "bookmark" }]}
        activeId="file"
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: /^File/ }),
      ).not.toBeInTheDocument(),
    );
    expect(row("New resource")).toHaveAttribute("tabindex", "0");
  });
  it("supports a custom menu's rename control without activating its row", async () => {
    const active = vi.fn();
    render(
      <AISidebar
        defaultItems={items}
        onActiveChange={active}
        renderMenu={(_item, controls) => (
          <button type="button" onClick={controls.rename}>
            Edit label
          </button>
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions for File" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit label" }));
    expect(
      screen.getByRole("textbox", { name: "Rename File" }),
    ).toBeInTheDocument();
    expect(active).not.toHaveBeenCalled();
  });
  it.each([20, 80])(
    "treats the disabled folder as a sibling drop target rather than a parent at y=%s",
    async (y) => {
      const changed = vi.fn();
      render(
        <AISidebar
          defaultItems={[
            {
              id: "blocked",
              label: "Blocked folder",
              kind: "folder",
              disabled: true,
            },
            { id: "file", label: "File", kind: "file" },
          ]}
          onItemsChange={changed}
        />,
      );
      const target = row("Blocked folder");
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        top: 0,
        height: 100,
      } as DOMRect);
      fireEvent.dragStart(row("File"), { dataTransfer: transfer() });
      dragOver(target, y);
      fireEvent.drop(target);
      await waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(row("File")).toHaveAttribute("aria-level", "1");
      expect(
        changed.mock.lastCall?.[0].map((item: SidebarResource) => item.id),
      ).toEqual(y < 50 ? ["file", "blocked"] : ["blocked", "file"]);
    },
  );
});
