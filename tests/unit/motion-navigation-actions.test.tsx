import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewRail } from "@/components/motion/preview-rail";
import { ActionSwapButton } from "@/components/motion/action-swap";

function pointer(
  target: Element,
  type: string,
  pointerType: string,
  buttons = 0,
) {
  const event = new MouseEvent(type, { bubbles: true, buttons });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: 1 },
  });
  fireEvent(target, event);
}

afterEach(cleanup);

const sections = [
  { id: "intro", label: "Introduction", description: "Start here" },
  { id: "api", label: "API", description: "API reference" },
  {
    id: "examples",
    label: "Examples",
    href: "#examples",
    target: "_blank" as const,
  },
];

describe("preview rail", () => {
  it("previews on resting mouse hover and clears on leave without selecting", () => {
    const select = vi.fn();
    render(<PreviewRail items={sections} onItemSelect={select} />);
    const api = screen.getByRole("button", { name: "API" });
    pointer(api, "pointerover", "mouse");
    expect(screen.getByText("API reference")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Introduction" }),
    ).toHaveAttribute("aria-current", "location");
    pointer(screen.getByRole("navigation"), "pointerout", "mouse", 1);
    expect(screen.queryByText("API reference")).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });

  it("pins a touch preview until an outside press and requires a second tap to follow a link", () => {
    const active = vi.fn();
    const select = vi.fn();
    render(
      <PreviewRail
        items={sections}
        onActiveChange={active}
        onItemSelect={select}
      />,
    );
    const link = screen.getByRole("link", { name: "Examples" });
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    pointer(link, "pointerdown", "touch", 1);
    expect(fireEvent.click(link)).toBe(false);
    expect(active).not.toHaveBeenCalled();
    expect(screen.getByText("Examples")).toBeInTheDocument();
    pointer(screen.getByRole("navigation"), "pointerout", "touch");
    expect(screen.getByText("Examples")).toBeInTheDocument();
    pointer(link, "pointerdown", "touch", 1);
    fireEvent.click(link);
    expect(active).toHaveBeenCalledWith("examples");
    expect(select).toHaveBeenCalledWith(sections[2]);
    expect(link).toHaveAttribute("aria-current", "page");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("Examples")).not.toBeInTheDocument();
  });

  it("selects button items immediately on touch and discards cancelled or keyboard-replaced tap records", () => {
    const active = vi.fn();
    render(
      <PreviewRail
        items={sections}
        onActiveChange={active}
        orientation="horizontal"
        previewSide="before"
      />,
    );
    const api = screen.getByRole("button", { name: "API" });
    pointer(api, "pointerdown", "touch", 1);
    fireEvent.click(api);
    expect(api).toHaveAttribute("aria-current", "location");
    expect(screen.getByText("API reference")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Examples" });
    pointer(link, "pointerdown", "touch", 1);
    fireEvent.pointerCancel(link);
    fireEvent.click(link);
    expect(active).toHaveBeenLastCalledWith("examples");
    pointer(link, "pointerdown", "touch", 1);
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent.click(link);
    expect(active).toHaveBeenCalledTimes(3);
    fireEvent.blur(api, { relatedTarget: document.body });
    expect(screen.queryByText("API reference")).not.toBeInTheDocument();
  });

  it("keeps controlled selection with its owner, falls back after removal, and supports hiding previews", () => {
    const active = vi.fn();
    const { rerender } = render(
      <PreviewRail
        items={sections}
        activeId="intro"
        onActiveChange={active}
        showPreview={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "API" }));
    expect(active).toHaveBeenCalledWith("api");
    expect(
      screen.getByRole("button", { name: "Introduction" }),
    ).toHaveAttribute("aria-current", "location");
    rerender(
      <PreviewRail
        items={sections.slice(1)}
        activeId="intro"
        highlightActive
        renderPreview={(item) => <p>{item.id} preview</p>}
      />,
    );
    expect(screen.getByRole("button", { name: "API" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    pointer(
      screen.getByRole("button", { name: "API" }),
      "pointerover",
      "mouse",
    );
    expect(screen.getByText("api preview")).toBeInTheDocument();
    rerender(<PreviewRail items={[]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

const actions = [
  { id: "play", label: "Play", icon: <span>▶</span> },
  {
    id: "pause",
    label: "Pause",
    icon: <span>Ⅱ</span>,
    ariaLabel: "Pause playback",
  },
];

describe("action swap", () => {
  it("cycles from the requested item and wraps while preserving an icon-only accessible name", () => {
    const changed = vi.fn();
    render(
      <ActionSwapButton
        items={actions}
        defaultValue="pause"
        size="icon"
        animation="roll"
        onValueChange={changed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause playback" }));
    expect(changed).toHaveBeenLastCalledWith("play", actions[0]);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(changed).toHaveBeenLastCalledWith("pause", actions[1]);
    expect(
      screen.getByRole("button", { name: "Pause playback" }),
    ).toBeInTheDocument();
  });

  it("requests controlled changes but only changes its label when its owner updates", () => {
    const changed = vi.fn();
    const { rerender } = render(
      <ActionSwapButton
        items={actions}
        value="play"
        size="icon"
        onValueChange={changed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(changed).toHaveBeenCalledWith("pause", actions[1]);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    rerender(<ActionSwapButton items={actions} value="pause" size="icon" />);
    expect(
      screen.getByRole("button", { name: "Pause playback" }),
    ).toBeInTheDocument();
  });

  it.each(["prevented", "disabled", "no-cycle"])(
    "does not advance when %s",
    (mode) => {
      const changed = vi.fn();
      render(
        <ActionSwapButton
          items={actions}
          size="icon"
          disabled={mode === "disabled"}
          cycle={mode !== "no-cycle"}
          onClick={(event) => {
            if (mode === "prevented") event.preventDefault();
          }}
          onValueChange={changed}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(changed).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    },
  );

  it("falls back for an unavailable value, keeps cascade labels accessible, and renders nothing with no actions", () => {
    const { rerender } = render(
      <ActionSwapButton
        items={[{ id: "save", label: "Save now" }]}
        value="missing"
        animation="cascade"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Save now" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(
      screen.getByRole("button", { name: "Save now" }),
    ).toBeInTheDocument();
    rerender(<ActionSwapButton items={[]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
