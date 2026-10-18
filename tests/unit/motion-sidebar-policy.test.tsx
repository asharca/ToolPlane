import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type * as MotionReact from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnimatedSidebar,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuSub,
  AnimatedSidebarMenuSubButton,
  AnimatedSidebarMenuSubItem,
  AnimatedSidebarProvider,
  AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof MotionReact>()),
  useReducedMotion: () => preference.reduced,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  preference.reduced = false;
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

describe("sidebar navigation policies", () => {
  it.each([false, true])(
    "retains accessible names, safe links and active state in the collapsed rail with reduced=%s",
    (reduced) => {
      preference.reduced = reduced;
      const select = vi.fn();
      render(
        <AnimatedSidebarProvider defaultOpen={false}>
          <AnimatedSidebarTrigger />
          <AnimatedSidebar side="right" variant="floating">
            <AnimatedSidebarMenuButton
              href="#current"
              target="_blank"
              isActive
              icon={<span>icon</span>}
              badge="12 unread"
            >
              Current destination
            </AnimatedSidebarMenuButton>
            <AnimatedSidebarMenuButton ariaExpanded={false} onSelect={select}>
              Expand projects
            </AnimatedSidebarMenuButton>
            <AnimatedSidebarMenuSub open>
              <AnimatedSidebarMenuSubItem>
                <AnimatedSidebarMenuSubButton>
                  Project child
                </AnimatedSidebarMenuSubButton>
              </AnimatedSidebarMenuSubItem>
            </AnimatedSidebarMenuSub>
          </AnimatedSidebar>
        </AnimatedSidebarProvider>,
      );
      const destination = screen.getByRole("link", {
        name: "Current destination",
      });
      expect(destination).toHaveAttribute("aria-current", "page");
      expect(destination).toHaveAttribute("rel", "noreferrer noopener");
      expect(screen.queryByText("12 unread")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Project child" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Expand projects" }));
      expect(select).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("button", { name: "Toggle sidebar" }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("12 unread")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Project child" }),
      ).toBeInTheDocument();
    },
  );
  it.each([false, true])(
    "closes a mobile sheet on ordinary navigation and honors explicit group retention with reduced=%s",
    (reduced) => {
      preference.reduced = reduced;
      mobile();
      const selected = vi.fn();
      render(
        <AnimatedSidebarProvider defaultOpenMobile>
          <AnimatedSidebarTrigger />
          <AnimatedSidebar>
            <AnimatedSidebarMenuButton
              closeOnSelect={false}
              onSelect={selected}
            >
              Keep sheet
            </AnimatedSidebarMenuButton>
            <AnimatedSidebarMenuButton
              ariaExpanded
              closeOnSelect
              onSelect={selected}
            >
              Group closes sheet
            </AnimatedSidebarMenuButton>
            <AnimatedSidebarMenuButton onSelect={selected}>
              Navigate
            </AnimatedSidebarMenuButton>
          </AnimatedSidebar>
        </AnimatedSidebarProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Keep sheet" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Group closes sheet" }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(selected).toHaveBeenCalledTimes(3);
    },
  );
  it("requests mobile closing from its controlled owner without making navigation disappear prematurely", () => {
    mobile();
    const change = vi.fn();
    render(
      <AnimatedSidebarProvider openMobile onOpenMobileChange={change}>
        <AnimatedSidebarTrigger />
        <AnimatedSidebar>
          <AnimatedSidebarMenuButton>Navigate</AnimatedSidebarMenuButton>
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(change).toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "a" });
    expect(change).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(change).toHaveBeenCalledTimes(2);
  });
  it("preserves explicit link relationships and disabled/current destination semantics for child links", () => {
    const selected = vi.fn();
    render(
      <AnimatedSidebarProvider>
        <AnimatedSidebar variant="inset">
          <AnimatedSidebarMenuSub open>
            <AnimatedSidebarMenuSubItem>
              <AnimatedSidebarMenuSubButton
                href="#external"
                target="_blank"
                rel="external"
                isActive
                icon={<span>icon</span>}
                onSelect={selected}
              >
                External child
              </AnimatedSidebarMenuSubButton>
            </AnimatedSidebarMenuSubItem>
            <AnimatedSidebarMenuSubItem>
              <AnimatedSidebarMenuSubButton href="#default" target="_blank">
                Safe child
              </AnimatedSidebarMenuSubButton>
            </AnimatedSidebarMenuSubItem>
            <AnimatedSidebarMenuSubItem>
              <AnimatedSidebarMenuSubButton disabled onSelect={selected}>
                Disabled child
              </AnimatedSidebarMenuSubButton>
            </AnimatedSidebarMenuSubItem>
          </AnimatedSidebarMenuSub>
          <AnimatedSidebarMenuButton disabled onSelect={selected}>
            <span>Disabled parent</span>
          </AnimatedSidebarMenuButton>
        </AnimatedSidebar>
      </AnimatedSidebarProvider>,
    );
    expect(
      screen.getByRole("link", { name: "External child" }),
    ).toHaveAttribute("rel", "external");
    expect(
      screen.getByRole("link", { name: "External child" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Safe child" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    const panel = screen.getByRole("complementary");
    fireEvent.click(
      within(panel).getByRole("button", { name: "Disabled child" }),
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: "Disabled parent" }),
    );
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "External child" }));
    expect(selected).toHaveBeenCalledOnce();
  });
});
