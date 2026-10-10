import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RotatingHeadline } from "@/components/home/RotatingHeadline";
import type * as MotionReact from "motion/react";

const words = ["MCP Servers", "Agent Skills", "MCP Clients", "Agent Tools"];

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof MotionReact>()),
  useReducedMotion: () => true,
}));

describe("RotatingHeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays static when reduced motion is requested", () => {
    vi.useFakeTimers();
    const { container } = render(<RotatingHeadline words={words} />);

    act(() => vi.advanceTimersByTime(5000));

    expect(container).toHaveTextContent("MCP Servers");
    expect(container).not.toHaveTextContent("Agent Skills");
  });
});
