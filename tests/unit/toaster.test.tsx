import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Toaster, notify } from "@/components/dashboard/Toaster";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { useDismiss } from "@/lib/hooks/use-dismiss";

function extractZIndex(element: Element | null): number {
  const match = /\bz-\[(\d+)\]/.exec(element?.className ?? "");
  return match ? Number(match[1]) : 0;
}

function ConsumeDismissProbe({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onDismiss, ref, { behavior: "consume" });
  return <div ref={ref}>Consuming overlay</div>;
}

describe("Toaster", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it("layers above open modals and dismisses without closing the modal", async () => {
    const onModalChange = vi.fn();
    render(
      <>
        <Toaster />
        <CenterMorphModal open onOpenChange={onModalChange}>
          <CenterMorphModalContent ariaLabel="Settings modal">
            <div>Modal body</div>
          </CenterMorphModalContent>
        </CenterMorphModal>
      </>,
    );

    act(() => {
      notify("Saved");
    });

    const stack = document.querySelector("[data-toast-stack]");
    const backdrop = screen.getByRole("button", { name: "Dismiss modal" });
    const dialog = screen.getByRole("dialog", { name: "Settings modal" });
    const modalLayer = dialog.closest(".fixed");

    expect(stack).toBeInTheDocument();
    expect(extractZIndex(stack)).toBeGreaterThan(extractZIndex(backdrop));
    expect(extractZIndex(stack)).toBeGreaterThan(extractZIndex(modalLayer));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    });
    expect(onModalChange).not.toHaveBeenCalled();
  });

  it("does not dismiss open Popover, MorphPopover, or consume-mode overlays when dismissing a toast", async () => {
    const onPopoverChange = vi.fn();
    const onMorphChange = vi.fn();
    const onConsumeDismiss = vi.fn();

    render(
      <>
        <Toaster />
        <Popover open onOpenChange={onPopoverChange}>
          <PopoverTrigger>
            <button type="button">Popover trigger</button>
          </PopoverTrigger>
          <PopoverContent>Popover body</PopoverContent>
        </Popover>
        <MorphPopover open onOpenChange={onMorphChange}>
          <MorphPopoverTrigger>
            <button type="button">Morph trigger</button>
          </MorphPopoverTrigger>
          <MorphPopoverContent>Morph body</MorphPopoverContent>
        </MorphPopover>
        <ConsumeDismissProbe onDismiss={onConsumeDismiss} />
      </>,
    );

    act(() => {
      notify("Notice");
    });

    const closeButton = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(closeButton);
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByText("Notice")).not.toBeInTheDocument();
    });
    expect(onPopoverChange).not.toHaveBeenCalled();
    expect(onMorphChange).not.toHaveBeenCalled();
    expect(onConsumeDismiss).not.toHaveBeenCalled();
  });

  it("serializes afterReload warning toasts cleanly and restores them on mount", () => {
    notify("Warning after reload", {
      severity: "warning",
      afterReload: true,
    });

    const raw = sessionStorage.getItem("toolplane:pending-toasts");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "[]")).toEqual([
      { title: "Warning after reload", severity: "warning" },
    ]);

    render(<Toaster />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Warning after reload",
    );
    expect(sessionStorage.getItem("toolplane:pending-toasts")).toBeNull();
  });

  it("deduplicates identical active notifications", () => {
    render(<Toaster />);

    act(() => {
      notify("Duplicate error", { severity: "error" });
      notify("Duplicate error", { severity: "error" });
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Duplicate error");
  });

  it("pauses auto-dismiss on hover and resets pause when the last toast is dismissed", async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      notify("Hoverable");
    });

    const hoverable = screen.getByText("Hoverable");
    act(() => {
      fireEvent.pointerOver(hoverable);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("Hoverable")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Hoverable")).not.toBeInTheDocument();

    act(() => {
      notify("Next toast");
    });
    expect(screen.getByText("Next toast")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4300);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Next toast")).not.toBeInTheDocument();
  });
});
