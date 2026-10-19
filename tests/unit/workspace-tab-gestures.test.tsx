import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabBar } from "@/components/workspace/workspace-tab-bar";
import type * as MotionReact from "motion/react";

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof MotionReact>()),
  useReducedMotion: () => true,
}));
const tabs = [
  { id: "one", title: "First" },
  { id: "two", title: "Second" },
];
class TouchPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerType = init.pointerType || "touch";
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function touch(
  node: Element,
  type: string,
  x = 0,
  y = 0,
  pointerType = "touch",
) {
  fireEvent(
    node,
    new TouchPointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerType,
    }),
  );
}

describe("workspace tab touch gestures", () => {
  it("opens a pen long press at its deadline and restores tab focus when dismissed", () => {
    vi.useFakeTimers();
    render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const tab = screen.getByRole("tab", { name: "First" });
    touch(tab, "pointerdown", 50, 70, "pen");
    act(() => vi.advanceTimersByTime(519));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("menuitem", { name: "关闭标签" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tab).toHaveFocus();
  });

  it.each(["pointerup", "pointercancel", "move"])(
    "cancels pending touch menus for %s",
    (cancellation) => {
      vi.useFakeTimers();
      render(
        <WorkspaceTabBar
          tabs={tabs}
          activeTabId="one"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      const tab = screen.getByRole("tab", { name: "First" });
      touch(tab, "pointerdown", 20, 20);
      if (cancellation === "move") touch(tab, "pointermove", 40, 20);
      else touch(tab, cancellation, 20, 20);
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("permits small touch movements but clears the timer before a context menu opens", () => {
    vi.useFakeTimers();
    render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const tab = screen.getByRole("tab", { name: "First" });
    touch(tab, "pointerdown", 10, 10);
    touch(tab, "pointermove", 14, 14);
    fireEvent.contextMenu(tab);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("does not prevent native context menus or schedule touch menus when no actions are available", () => {
    vi.useFakeTimers();
    render(
      <WorkspaceTabBar tabs={tabs} activeTabId="one" onSelect={vi.fn()} />,
    );
    const tab = screen.getByRole("tab", { name: "First" });
    expect(fireEvent.contextMenu(tab)).toBe(true);
    touch(tab, "pointerdown", 10, 10);
    touch(tab, "pointermove", 30, 40);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("cancels its long-press timer when the tab strip is unmounted", () => {
    vi.useFakeTimers();
    const view = render(
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    touch(screen.getByRole("tab", { name: "First" }), "pointerdown");
    view.unmount();
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("workspace tab scroll visibility", () => {
  it("scrolls left and right only when the selected tab crosses the viewport edge", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const key = this.getAttribute("data-tab-key");
        const [left, right] =
          key === "one" ? [50, 150] : key === "two" ? [250, 400] : [100, 300];
        return {
          left,
          right,
          top: 0,
          bottom: 40,
          width: right - left,
          height: 40,
          x: left,
          y: 0,
          toJSON: () => ({}),
        };
      },
    );
    const { container, rerender } = render(
      <WorkspaceTabBar tabs={tabs} activeTabId="one" onSelect={vi.fn()} />,
    );
    const scroller = container.querySelector('[data-slot="workspace-tab-bar"]');
    expect(scroller?.scrollLeft).toBe(-50);
    rerender(
      <WorkspaceTabBar tabs={tabs} activeTabId="two" onSelect={vi.fn()} />,
    );
    expect(scroller?.scrollLeft).toBe(50);
  });
});
