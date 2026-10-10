import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentActivity } from "@/components/agents/agent-activity";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fits short live reasoning, caps growth, and releases space on completion", async () => {
  let height = 74;
  let resize!: () => void;
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    () => height,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const items = [
    { id: "reasoning", type: "text" as const, content: "Compare the options." },
  ];
  const { rerender } = render(<AgentActivity items={items} status="working" />);
  const region = screen.getByRole("region");
  (region.firstElementChild as HTMLElement).scrollTo = vi.fn();
  expect(region).toHaveStyle({ height: "74px" });
  act(() => {
    height = 320;
    resize();
  });
  expect(region).toHaveStyle({ height: "208px" });
  rerender(<AgentActivity items={items} status="complete" />);
  expect(region).toHaveStyle({ height: "0px" });
  fireEvent.click(screen.getByRole("button"));
  expect(region).toHaveStyle({ height: "208px" });
  await waitFor(() =>
    expect(screen.getByText("Compare the options.")).toBeVisible(),
  );
});
