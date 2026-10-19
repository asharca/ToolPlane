import { act, cleanup, render, screen } from "@testing-library/react";
import type * as MotionReact from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextScramble } from "@/components/motion/text-scramble";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof MotionReact>()),
  useReducedMotion: () => preference.reduced,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  preference.reduced = false;
});

describe("text scramble transitions", () => {
  it("keeps the accessible target intact while progressively revealing visual characters and preserving spaces", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { rerender, container } = render(
      <TextScramble text="Initial" duration={200} glyphs="X" />,
    );
    expect(frames).toHaveLength(0);
    rerender(<TextScramble text="AB CD" duration={200} glyphs="X" />);
    expect(
      screen.getByText("AB CD", { selector: ".sr-only" }),
    ).toBeInTheDocument();
    act(() => frames[0](40));
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      "AX XX",
    );
    act(() => frames[1](200));
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      "AB CD",
    );
    expect(frames).toHaveLength(2);
  });

  it("cancels pending frames when the target changes or the text unmounts", () => {
    const request = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(77);
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const { rerender, unmount } = render(<TextScramble text="One" />);
    rerender(<TextScramble text="Two" />);
    expect(request).toHaveBeenCalledOnce();
    rerender(<TextScramble text="Three" />);
    expect(cancel).toHaveBeenCalledWith(77);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it.each(["reduced", "empty-glyphs"])(
    "reveals changes immediately for %s",
    (mode) => {
      const request = vi.spyOn(window, "requestAnimationFrame");
      const { rerender, container } = render(<TextScramble text="Before" />);
      preference.reduced = mode === "reduced";
      rerender(
        <TextScramble
          text="After"
          glyphs={mode === "empty-glyphs" ? "" : "X"}
        />,
      );
      expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
        "After",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
});
