import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuTrigger,
} from "@/components/motion/context-menu";

function pointer(
  target: Element,
  type: string,
  pointerType: string,
  x = 20,
  y = 20,
) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}

function Menu({ disabled = false, prevent = false, onSelect = vi.fn() }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger disabled={disabled}>
        <button
          type="button"
          onContextMenu={(event) => {
            if (prevent) event.preventDefault();
          }}
        >
          Files
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>Archive</ContextMenuItem>
        <ContextMenuItem disabled onSelect={onSelect}>
          Blocked
        </ContextMenuItem>
        <ContextMenuItem
          textValue="copy"
          closeOnSelect={false}
          onSelect={onSelect}
        >
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem tone="destructive" onSelect={onSelect}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("context menu interactions", () => {
  it("supports keyboard wrapping, endpoints, typeahead, disabled skipping and Escape focus restoration", async () => {
    render(<Menu />);
    const trigger = screen.getByRole("button", { name: "Files" });
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");
    const archive = screen.getByRole("menuitem", { name: "Archive" });
    const copy = screen.getByRole("menuitem", { name: "Duplicate" });
    const last = screen.getByRole("menuitem", { name: "Delete" });
    await waitFor(() => expect(archive).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(copy).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(archive).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(archive).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(archive).toHaveFocus();
    fireEvent.keyDown(menu, { key: "c" });
    fireEvent.keyDown(menu, { key: "o" });
    expect(copy).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("allows persistent actions, ignores disabled actions and closes after normal selection", () => {
    const select = vi.fn();
    render(<Menu onSelect={select} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Files" }), {
      clientX: 30,
      clientY: 40,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Blocked" }));
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(select).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it.each(["resize", "scroll", "outside", "Tab"])(
    "dismisses on %s but not an inside pointer press",
    (dismissal) => {
      render(<Menu />);
      const trigger = screen.getByRole("button", { name: "Files" });
      fireEvent.keyDown(trigger, { key: "ContextMenu" });
      fireEvent.pointerDown(screen.getByRole("menu"));
      fireEvent.pointerDown(trigger);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      if (dismissal === "outside") fireEvent.pointerDown(document.body);
      else if (dismissal === "Tab")
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
      else fireEvent(window, new Event(dismissal));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );

  it.each([
    { disabled: true, prevent: false },
    { disabled: false, prevent: true },
  ])("respects trigger opt-outs %j", (props) => {
    render(<Menu {...props} />);
    const trigger = screen.getByRole("button", { name: "Files" });
    fireEvent.contextMenu(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    if (props.disabled) {
      fireEvent.keyDown(trigger, { key: "ContextMenu" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
  });

  it("opens on a held touch or pen, but cancels on drag, release and cancellation", () => {
    vi.useFakeTimers();
    render(<Menu />);
    const trigger = screen.getByRole("button", { name: "Files" });
    pointer(trigger, "pointerdown", "touch");
    act(() => vi.advanceTimersByTime(519));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    pointer(trigger, "pointermove", "touch", 40, 20);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    pointer(trigger, "pointerup", "touch");
    pointer(trigger, "pointerdown", "pen");
    pointer(trigger, "pointercancel", "pen");
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    pointer(trigger, "pointerdown", "touch");
    pointer(trigger, "pointerup", "touch");
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    pointer(trigger, "pointerdown", "pen");
    pointer(trigger, "pointermove", "pen", 22, 23);
    act(() => vi.advanceTimersByTime(520));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    pointer(trigger, "pointerup", "pen");
  });

  it("updates checkbox and radio semantics without closing when requested", () => {
    function Options() {
      const [checked, setChecked] = useState(false);
      const [sort, setSort] = useState("name");
      return (
        <ContextMenu defaultOpen>
          <ContextMenuContent>
            <ContextMenuCheckboxItem
              checked={checked}
              onCheckedChange={setChecked}
              closeOnSelect={false}
            >
              Hidden files
            </ContextMenuCheckboxItem>
            <ContextMenuRadioGroup value={sort} onValueChange={setSort}>
              <ContextMenuRadioItem value="name" closeOnSelect={false}>
                Name
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="date" closeOnSelect={false}>
                Date
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuContent>
        </ContextMenu>
      );
    }
    render(<Options />);
    const checkbox = screen.getByRole("menuitemcheckbox");
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Date" }));
    expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Name" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("honors controlled open state and forwards the trigger ref", () => {
    const changed = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <ContextMenu open={false} onOpenChange={changed}>
        <ContextMenuTrigger>
          <button type="button" ref={ref}>
            Controlled
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(ref.current as HTMLButtonElement);
    expect(changed).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    rerender(
      <ContextMenu open onOpenChange={changed}>
        <ContextMenuTrigger>
          <button type="button" ref={ref}>
            Controlled
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.click(screen.getByRole("menuitem"));
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
