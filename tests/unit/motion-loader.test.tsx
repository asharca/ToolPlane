import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Loader } from "@/components/motion/loader";
import type * as MotionReact from "motion/react";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof MotionReact>()),
  useReducedMotion: () => preference.reduced,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  preference.reduced = false;
});

describe("loader progress and motion preferences", () => {
  it.each([
    ["ascii", "⠋", "⠙", 10],
    ["ascii-line", "|", "/", 4],
    ["ascii-braille", "⣾", "⣽", 8],
    ["ascii-blocks", "▁", "▂", 14],
    ["ascii-bounce", "⠁", "⠂", 8],
  ] as const)(
    "cycles %s frames at the requested speed, wraps, and stops on unmount",
    (variant, first, second, count) => {
      vi.useFakeTimers();
      const { unmount } = render(
        <Loader
          variant={variant}
          speed={count / 10}
          label="Retrieving results"
        />,
      );
      expect(
        screen.getByRole("status", { name: "Retrieving results" }),
      ).toHaveTextContent(first);
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByRole("status")).toHaveTextContent(second);
      act(() => vi.advanceTimersByTime((count - 1) * 100));
      expect(screen.getByRole("status")).toHaveTextContent(first);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("slows glyph changes for reduced motion and reconfigures an existing interval", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Loader variant="ascii-line" speed={0.4} />);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("status")).toHaveTextContent("/");
    preference.reduced = true;
    rerender(<Loader variant="ascii-line" speed={0.4} />);
    act(() => vi.advanceTimersByTime(249));
    expect(screen.getByRole("status")).toHaveTextContent("/");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toHaveTextContent("-");
  });

  it.each([false, true])(
    "advances percent to completion then restarts, reduced motion=%s",
    (reduced) => {
      vi.useFakeTimers();
      preference.reduced = reduced;
      const { unmount } = render(<Loader variant="percent" speed={0.4} />);
      expect(screen.getByText("0%")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(reduced ? 400 : 200));
      expect(screen.getByText("50%")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(reduced ? 400 : 200));
      expect(screen.getByText("100%")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(40));
      expect(screen.getByText(reduced ? "5%" : "10%")).toBeInTheDocument();
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reveals scrambled loading text and stops scrambling when reduced motion is enabled", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender, unmount } = render(
      <Loader variant="scramble" speed={1.4} />,
    );
    act(() => vi.advanceTimersByTime(110));
    expect(screen.getByText("AAAAAAA")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(110));
    expect(screen.getByText("LAAAAAA")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(660));
    expect(screen.getByText("LOADING")).toBeInTheDocument();
    preference.reduced = true;
    rerender(<Loader variant="scramble" speed={1.4} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText("LOADING")).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scales SVG geometry without losing the minimum stroke and isolates concurrent filter IDs", () => {
    const { rerender } = render(<Loader size={8} />);
    const status = screen.getByRole("status");
    expect(status.querySelector("svg")).toHaveAttribute("viewBox", "0 0 8 8");
    expect(status.querySelector("circle")).toHaveAttribute("stroke-width", "2");
    rerender(<Loader size={100} />);
    expect(status.querySelector("circle")).toHaveAttribute("stroke-width", "9");
    rerender(
      <>
        <Loader variant="metaballs" />
        <Loader variant="metaballs" />
      </>,
    );
    const statuses = screen.getAllByRole("status");
    const ids = statuses.map((element) => element.querySelector("filter")?.id);
    expect(ids[0]).not.toBe(ids[1]);
    statuses.forEach((element, index) => {
      expect(element.querySelector("g")).toHaveAttribute(
        "filter",
        `url(#${ids[index]})`,
      );
    });
  });
});
