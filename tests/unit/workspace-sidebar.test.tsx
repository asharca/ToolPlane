import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnimatedSidebarProvider,
  AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

const groups = [
  {
    id: "main",
    items: [
      { id: "chat", label: "Chat" },
      { id: "files", label: "Files", href: "#files" },
      { id: "blocked", label: "Blocked", disabled: true },
    ],
  },
];
afterEach(() => vi.restoreAllMocks());

describe("workspace sidebar composition", () => {
  it("expands the active child's parent and selects nested destinations without navigating the parent", () => {
    const select = vi.fn();
    render(
      <AnimatedSidebarProvider>
        <WorkspaceSidebar
          activeId="providers"
          onSelect={select}
          groups={[
            {
              id: "settings",
              title: "Settings",
              items: [
                {
                  id: "manage",
                  label: "Manage",
                  href: "#manage",
                  children: [
                    { id: "providers", label: "Providers", href: "#providers" },
                    { id: "tokens", label: "Tokens", disabled: true },
                  ],
                },
              ],
            },
          ]}
        />
      </AnimatedSidebarProvider>,
    );
    const parent = screen.getByRole("button", { name: "Manage" });
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Providers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("link", { name: "Providers" }));
    expect(select).toHaveBeenLastCalledWith("providers");
    select.mockClear();
    fireEvent.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(parent);
    expect(screen.getByRole("button", { name: "Tokens" })).toBeDisabled();
  });
  it("retains keyboard focus in its footer when desktop navigation collapses", () => {
    const select = vi.fn();
    render(
      <AnimatedSidebarProvider>
        <WorkspaceSidebar
          groups={groups}
          activeId="chat"
          onSelect={select}
          logo={<span>Brand</span>}
          footer={<button type="button">Account</button>}
        />
      </AnimatedSidebarProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(select).toHaveBeenLastCalledWith("chat");
    fireEvent.click(screen.getByRole("link", { name: "Files" }));
    expect(select).toHaveBeenLastCalledWith("files");
    const footer = screen.getByRole("button", { name: "Account" });
    act(() => footer.focus());
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(footer).toHaveFocus();
    const trigger = screen.getByRole("button", { name: "展开工作区侧栏" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(
      screen.getByRole("button", { name: "折叠工作区侧栏" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("retains focus on its collapsing trigger and leaves outside focus untouched", () => {
    render(
      <AnimatedSidebarProvider>
        <button type="button">Outside</button>
        <WorkspaceSidebar groups={groups} />
      </AnimatedSidebarProvider>,
    );
    act(() => screen.getByRole("button", { name: "折叠工作区侧栏" }).focus());
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(
      screen.getByRole("button", { name: "展开工作区侧栏" }),
    ).toHaveFocus();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(outside).toHaveFocus();
  });

  it("keeps its collapsed branded toggle keyboard-operable while hover changes", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => true,
    }));
    render(
      <AnimatedSidebarProvider defaultOpen={false}>
        <WorkspaceSidebar logo={<span>Brand</span>} groups={groups} />
      </AnimatedSidebarProvider>,
    );
    const trigger = screen.getByRole("button", { name: "展开工作区侧栏" });
    const header = trigger.closest('[data-slot="sidebar-header"]');
    if (!header) throw new Error("Sidebar header missing");
    fireEvent.mouseEnter(header.firstElementChild as Element);
    act(() => trigger.focus());
    expect(trigger).toHaveFocus();
    fireEvent.mouseLeave(header.firstElementChild as Element);
    fireEvent.blur(trigger);
    fireEvent.click(trigger);
    expect(
      screen.getByRole("button", { name: "折叠工作区侧栏" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it.each([true, false])(
    "opens and dismisses mobile navigation with logo=%s",
    (withLogo) => {
      vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => true,
      }));
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      render(
        <AnimatedSidebarProvider>
          <AnimatedSidebarTrigger />
          <WorkspaceSidebar
            title="Project"
            groups={groups}
            logo={withLogo ? <span>Brand</span> : undefined}
          />
        </AnimatedSidebarProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      const dialog = screen.getByRole("dialog", { name: "Project导航" });
      expect(within(dialog).getByText("Project")).toBeInTheDocument();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "关闭工作区导航" }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );
});

describe("workspace shell scroll ownership", () => {
  it("renders actual optional slots and switches content scrolling to child-owned scrolling", () => {
    const { container, rerender } = render(
      <WorkspaceShell
        sidebar={<aside>Navigation</aside>}
        mobileHeader={<button type="button">Open navigation</button>}
        tabBar={<div role="tablist" aria-label="Editors" />}
        header={<h1>Files</h1>}
        footer={<button type="button">Save changes</button>}
        contentProps={{
          "aria-label": "Editor",
          role: "region",
          className: "editor-pane",
        }}
      >
        <textarea aria-label="File contents" defaultValue="Initial document" />
      </WorkspaceShell>,
    );
    expect(screen.getByRole("region", { name: "Editor" })).toHaveAttribute(
      "data-scroll",
      "content",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), {
      target: { value: "Updated document" },
    });
    expect(screen.getByRole("textbox", { name: "File contents" })).toHaveValue(
      "Updated document",
    );
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).toBeInTheDocument();
    rerender(
      <WorkspaceShell
        sidebar={false}
        tabBar={null}
        mobileHeader={false}
        header={undefined}
        footer={false}
        scroll="none"
      >
        <p>Child owns scrolling</p>
      </WorkspaceShell>,
    );
    expect(
      container.querySelector('[data-slot="workspace-content"]'),
    ).toHaveAttribute("data-scroll", "none");
    expect(
      container.querySelector('[data-slot="workspace-shell-tabs"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Child owns scrolling")).toBeInTheDocument();
  });
});
