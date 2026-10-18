import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as MotionReact from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
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

function Options({ second = true }: { second?: boolean }) {
  return (
    <>
      <SelectTrigger aria-label="Model">
        <SelectValue placeholder="Choose model" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="fast">Fast model</SelectItem>
        {second ? (
          <SelectItem value="accurate">Accurate model</SelectItem>
        ) : null}
        <SelectItem value="offline" disabled>
          Offline model
        </SelectItem>
        <SelectItem value="custom">
          <span>Custom display</span>
        </SelectItem>
      </SelectContent>
    </>
  );
}

describe("select state ownership and accessibility", () => {
  it.each([false, true])(
    "updates selection via pointer and keeps its label after closing with reduced motion=%s",
    (reduced) => {
      preference.reduced = reduced;
      const changed = vi.fn(),
        opened = vi.fn();
      render(
        <Select onValueChange={changed} onOpenChange={opened}>
          <Options />
        </Select>,
      );
      const trigger = screen.getByRole("combobox", { name: "Model" });
      expect(trigger).toHaveTextContent("Choose model");
      fireEvent.click(trigger);
      const list = screen.getByRole("listbox");
      expect(trigger).toHaveAttribute("aria-controls", list.id);
      fireEvent.click(screen.getByRole("option", { name: "Offline model" }));
      expect(changed).not.toHaveBeenCalled();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(screen.getByRole("option", { name: "Accurate model" }));
      expect(changed).toHaveBeenCalledWith("accurate");
      expect(opened).toHaveBeenLastCalledWith(false);
      expect(trigger).toHaveTextContent("Accurate model");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      const hidden = document.getElementById(list.id);
      expect(hidden).toHaveAttribute("inert");
      expect(hidden).toHaveAttribute("aria-hidden", "true");
    },
  );
  it("honors externally controlled values/open state and requests rather than taking ownership", () => {
    const changed = vi.fn(),
      opened = vi.fn();
    const { rerender } = render(
      <Select
        value="fast"
        open={false}
        onOpenChange={opened}
        onValueChange={changed}
      >
        <Options />
      </Select>,
    );
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    expect(opened).toHaveBeenCalledWith(true);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    rerender(
      <Select value="fast" open onOpenChange={opened} onValueChange={changed}>
        <Options />
      </Select>,
    );
    fireEvent.click(screen.getByRole("option", { name: "Accurate model" }));
    expect(changed).toHaveBeenCalledWith("accurate");
    expect(trigger).toHaveTextContent("Fast model");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "Fast model" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    rerender(
      <Select value="accurate" open={false}>
        <Options />
      </Select>,
    );
    expect(trigger).toHaveTextContent("Accurate model");
  });
  it("removes stale item labels after options change and uses a stable value for rich option content", () => {
    const { rerender } = render(
      <Select defaultValue="accurate">
        <Options />
      </Select>,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Accurate model");
    rerender(
      <Select defaultValue="accurate">
        <Options second={false} />
      </Select>,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Choose model");
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Custom display" }));
    expect(screen.getByRole("combobox")).toHaveTextContent("custom");
  });
  it("supports native keyboard activation without opening disabled selects", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Select disabled>
        <Options />
      </Select>,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    rerender(
      <Select>
        <Options />
      </Select>,
    );
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    screen.getByRole("option", { name: "Fast model" }).focus();
    await user.keyboard(" ");
    expect(trigger).toHaveTextContent("Fast model");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  it("dismisses on outside pointer or Escape while leaving inside interactions and unrelated keys alone", () => {
    render(
      <Select>
        <Options />
      </Select>,
    );
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("option", { name: "Fast model" }));
    fireEvent.keyDown(window, { key: "a" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  it.each([
    { top: 700, bottom: 730, expected: "bottom-full" },
    { top: 20, bottom: 50, expected: "top-full" },
  ])(
    "keeps a 200px panel inside the viewport near trigger top=$top",
    ({ top, bottom, expected }) => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
        200,
      );
      render(
        <Select>
          <Options />
        </Select>,
      );
      const trigger = screen.getByRole("combobox");
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        top,
        bottom,
      } as DOMRect);
      fireEvent.click(trigger);
      expect(screen.getByRole("listbox")).toHaveClass(expected);
    },
  );
  it("provides the built-in placeholder when no label or placeholder exists", () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Select");
  });
});
