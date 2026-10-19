import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnimatedSidebar,
  AnimatedSidebarClose,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuSub,
  AnimatedSidebarMenuSubButton,
  AnimatedSidebarProvider,
  AnimatedSidebarRail,
  AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mobile() {
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
}

function Groups() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <AnimatedSidebarMenuButton
        ariaExpanded={open}
        onSelect={() => setOpen(!open)}
      >
        Projects
      </AnimatedSidebarMenuButton>
      <AnimatedSidebarMenuSub open={open}>
        <li>
          <AnimatedSidebarMenuSubButton>
            Project settings
          </AnimatedSidebarMenuSubButton>
        </li>
      </AnimatedSidebarMenuSub>
    </>
  );
}

describe("animated sidebar", () => {
  it("toggles desktop state by trigger, rail, close and platform keyboard shortcut", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <AnimatedSidebarProvider>
        <AnimatedSidebarTrigger ref={ref} />
        <AnimatedSidebar>
          <AnimatedSidebarGroupLabel>Workspace</AnimatedSidebarGroupLabel>
          <AnimatedSidebarRail aria-label="Resize rail" />
          <AnimatedSidebarClose />
          <Groups />
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Toggle sidebar" });
    expect(ref.current).toBe(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Workspace")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Project settings" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Resize rail" }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "B", ctrlKey: true });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "b" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps controlled desktop state under its owner and respects cancelled trigger actions", () => {
    const change = vi.fn();
    const { rerender } = render(
      <AnimatedSidebarProvider open onOpenChange={change}>
        <AnimatedSidebarTrigger />
        <AnimatedSidebar collapsible="offcanvas" side="right">
          <AnimatedSidebarClose />
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(change).toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).toHaveAttribute("aria-expanded", "true");
    rerender(
      <AnimatedSidebarProvider open={false} onOpenChange={change}>
        <AnimatedSidebarTrigger onClick={(event) => event.preventDefault()} />
        <AnimatedSidebar collapsible="none">
          <AnimatedSidebarClose onClick={(event) => event.preventDefault()} />
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    change.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-state",
      "expanded",
    );
  });

  it("traps mobile focus, restores body scrolling and returns focus when Escape dismisses", () => {
    mobile();
    document.body.style.overflow = "auto";
    render(
      <AnimatedSidebarProvider>
        <AnimatedSidebarTrigger />
        <AnimatedSidebar ariaLabel="Workspace navigation" side="right">
          <button type="button">First</button>
          <button type="button">Last</button>
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Toggle sidebar" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Workspace navigation" });
    const first = within(dialog).getByRole("button", { name: "First" });
    const last = within(dialog).getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");
    expect(trigger).toHaveFocus();
    document.body.style.overflow = "";
  });

  it("keeps mobile groups open, blocks disabled links, and closes when a child destination is selected", () => {
    mobile();
    const select = vi.fn();
    render(
      <AnimatedSidebarProvider defaultOpenMobile>
        <AnimatedSidebarTrigger />
        <AnimatedSidebar>
          <Groups />
          <AnimatedSidebarMenuButton href="#blocked" disabled onSelect={select}>
            Blocked destination
          </AnimatedSidebarMenuButton>
          <AnimatedSidebarMenuSubButton
            href="#blocked-child"
            disabled
            onSelect={select}
          >
            Blocked child
          </AnimatedSidebarMenuSubButton>
          <AnimatedSidebarMenuSubButton closeOnSelect={false} onSelect={select}>
            Keep open
          </AnimatedSidebarMenuSubButton>
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      fireEvent.click(
        screen.getByRole("link", { name: "Blocked destination" }),
      ),
    ).toBe(false);
    expect(
      fireEvent.click(screen.getByRole("link", { name: "Blocked child" })),
    ).toBe(false);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
    expect(select).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses an empty mobile panel and keeps Tab contained when no control is focusable", () => {
    mobile();
    render(
      <AnimatedSidebarProvider defaultOpenMobile>
        <AnimatedSidebar>
          <p>Empty navigation</p>
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(false);
    expect(dialog).toHaveFocus();
  });
});
