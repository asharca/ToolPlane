import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WorkspaceTabBar,
  type WorkspaceTab,
} from "@/components/workspace/workspace-tab-bar";

const tabs: WorkspaceTab[] = [
  { id: "pinned", title: "Pinned", pinned: true },
  {
    id: "editor",
    title: "Editor",
    dirty: true,
    icon: <span>E</span>,
    tabId: "editor-tab",
    panelId: "editor-panel",
  },
  { id: "preview", title: "Preview", detachable: false },
  { id: "locked", title: "Locked", closable: false },
];

function tab(name: string) {
  return screen.getByRole("tab", { name });
}
function group(name: string) {
  return screen.getByRole("group", { name: `${name}标签及操作` });
}

describe("WorkspaceTabBar", () => {
  it("selects a fallback active tab, exposes panel relationships, and handles an empty workspace", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <WorkspaceTabBar tabs={tabs} activeTabId="missing" onSelect={onSelect} />,
    );
    expect(tab("Editor（未保存）")).toHaveAttribute("id", "editor-tab");
    expect(tab("Editor（未保存）")).toHaveAttribute(
      "aria-controls",
      "editor-panel",
    );
    expect(tab("Pinned")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tab("Preview"));
    expect(onSelect).toHaveBeenCalledWith("preview");
    expect(
      screen.queryByRole("button", { name: "Preview操作" }),
    ).not.toBeInTheDocument();
    rerender(
      <WorkspaceTabBar tabs={[]} activeTabId="missing" onSelect={onSelect} />,
    );
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("wraps keyboard navigation and honors RTL direction", () => {
    const onSelect = vi.fn();
    render(
      <WorkspaceTabBar tabs={tabs} activeTabId="pinned" onSelect={onSelect} />,
    );
    fireEvent.keyDown(tab("Pinned"), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("locked");
    expect(tab("Locked")).toHaveFocus();
    fireEvent.keyDown(tab("Locked"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("pinned");
    fireEvent.keyDown(tab("Pinned"), { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("locked");
    fireEvent.keyDown(tab("Locked"), { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("pinned");
    group("Pinned").style.direction = "rtl";
    fireEvent.keyDown(tab("Pinned"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("locked");
  });

  it("does not reorder across pinned boundaries or outside the list", () => {
    const onReorder = vi.fn();
    render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="preview"
        onSelect={vi.fn()}
        onReorder={onReorder}
      />,
    );
    fireEvent.keyDown(tab("Pinned"), { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(tab("Pinned"), { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(tab("Locked"), { key: "ArrowRight", altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(tab("Preview"), { key: "ArrowLeft", altKey: true });
    expect(onReorder).toHaveBeenCalledWith("preview", "editor");
    fireEvent.keyDown(tab("Preview"), { key: "ArrowRight", altKey: true });
    expect(onReorder).toHaveBeenLastCalledWith("preview", "locked");
  });

  it("closes only eligible tabs and restores focus after the active tab disappears", () => {
    const onClose = vi.fn();
    function StatefulTabs() {
      const [items, setItems] = useState(tabs);
      return (
        <WorkspaceTabBar
          tabs={items}
          activeTabId="preview"
          onSelect={vi.fn()}
          onClose={(id) => {
            onClose(id);
            setItems((current) => current.filter((item) => item.id !== id));
          }}
        />
      );
    }
    render(<StatefulTabs />);
    expect(
      screen.queryByRole("button", { name: "关闭 Pinned" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭 Locked" })).toBeDisabled();
    fireEvent.keyDown(tab("Pinned"), { key: "Delete" });
    fireEvent.keyDown(tab("Locked"), { key: "Delete" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭 Preview" }));
    expect(onClose).toHaveBeenCalledWith("preview");
    expect(tab("Pinned")).toHaveFocus();
    expect(tab("Pinned")).toHaveAttribute("aria-selected", "true");
  });

  it("supports optional double-click closing and never closes the final tab", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="preview"
        onSelect={vi.fn()}
        onClose={onClose}
        closeOnDoubleClick
      />,
    );
    fireEvent.doubleClick(tab("Preview"));
    expect(onClose).toHaveBeenCalledWith("preview");
    onClose.mockClear();
    rerender(
      <WorkspaceTabBar
        tabs={[{ id: "only", title: "Only" }]}
        activeTabId="only"
        onSelect={vi.fn()}
        onClose={onClose}
        closeOnDoubleClick
      />,
    );
    expect(screen.getByRole("button", { name: "关闭 Only" })).toBeDisabled();
    fireEvent.doubleClick(tab("Only"));
    fireEvent.keyDown(tab("Only"), { key: "Delete" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("provides pin, detach, move, and close menu actions with eligibility restrictions", async () => {
    const user = userEvent.setup();
    const onPinnedChange = vi.fn();
    const onOpenInNewWindow = vi.fn();
    const onReorder = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="preview"
        onSelect={vi.fn()}
        onPinnedChange={onPinnedChange}
        onOpenInNewWindow={onOpenInNewWindow}
        onReorder={onReorder}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Preview操作" }));
    expect(
      await screen.findByRole("menuitem", { name: "在独立窗口打开" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "固定标签" }));
    expect(onPinnedChange).toHaveBeenCalledWith("preview", true);
    expect(tab("Preview")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Pinned操作" }));
    expect(
      await screen.findByRole("menuitem", { name: "向左移动" }),
    ).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "向右移动" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "关闭标签" })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "取消固定" }));
    expect(onPinnedChange).toHaveBeenLastCalledWith("pinned", false);
    await user.click(screen.getByRole("button", { name: "Pinned操作" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "在独立窗口打开" }),
    );
    expect(onOpenInNewWindow).toHaveBeenCalledWith("pinned");
    await user.click(screen.getByRole("button", { name: "Preview操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "向左移动" }));
    expect(onReorder).toHaveBeenCalledWith("preview", "editor");
    await user.click(screen.getByRole("button", { name: "Preview操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "向右移动" }));
    expect(onReorder).toHaveBeenLastCalledWith("preview", "locked");
    await user.click(screen.getByRole("button", { name: "Preview操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "关闭标签" }));
    expect(onClose).toHaveBeenCalledWith("preview");
  });

  it.each(["ContextMenu", "F10"])(
    "opens actions with %s and restores keyboard focus",
    async (key) => {
      render(
        <WorkspaceTabBar
          tabs={tabs}
          activeTabId="preview"
          onSelect={vi.fn()}
          onPinnedChange={vi.fn()}
        />,
      );
      fireEvent.keyDown(tab("Preview"), { key, shiftKey: key === "F10" });
      const action = await screen.findByRole("menuitem", { name: "固定标签" });
      await userEvent.click(action);
      await waitFor(() => expect(tab("Preview")).toHaveFocus());
    },
  );

  it("ignores cross-workspace drag payloads and reorders local tabs", () => {
    const onReorder = vi.fn();
    render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="preview"
        onSelect={vi.fn()}
        onReorder={onReorder}
      />,
    );
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (kind: string, value: string) => data.set(kind, value),
      getData: (kind: string) => data.get(kind) ?? "",
      effectAllowed: "",
    };
    data.set("text/plain", "foreign:preview");
    fireEvent.drop(group("Locked"), { dataTransfer });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.dragStart(group("Preview"), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("move");
    fireEvent.dragOver(group("Locked"), { dataTransfer });
    fireEvent.drop(group("Locked"), { dataTransfer });
    expect(onReorder).toHaveBeenCalledWith("preview", "locked");
    onReorder.mockClear();
    fireEvent.drop(group("Preview"), { dataTransfer });
    fireEvent.drop(group("Pinned"), { dataTransfer });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("invokes creation and retains host-supplied strip actions", async () => {
    const onNewTab = vi.fn();
    render(
      <WorkspaceTabBar
        tabs={[]}
        activeTabId=""
        onSelect={vi.fn()}
        onNewTab={onNewTab}
        actions={<button type="button">Save all</button>}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "新建标签" }));
    expect(onNewTab).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Save all" }),
    ).toBeInTheDocument();
  });
  it("handles middle-click preferences without treating ordinary auxiliary clicks as close", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="preview"
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent(
      tab("Preview"),
      new MouseEvent("auxclick", { bubbles: true, button: 2 }),
    );
    fireEvent.doubleClick(tab("Preview"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent(
      tab("Preview"),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledWith("preview");
    onClose.mockClear();
    rerender(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="preview"
        onSelect={vi.fn()}
        onClose={onClose}
        closeOnMiddleClick={false}
      />,
    );
    fireEvent(
      tab("Preview"),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves native context menus alone when the host provides no tab actions", () => {
    render(
      <WorkspaceTabBar tabs={tabs} activeTabId="preview" onSelect={vi.fn()} />,
    );
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(group("Preview"), event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.keyDown(tab("Preview"), { key: "ContextMenu" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
