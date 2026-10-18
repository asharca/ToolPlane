import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActivity } from "@/components/agents/agent-activity";
import type { AgentActivityItem } from "@/components/agents/agent-activity";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("agent activity stream", () => {
  it("reveals chronological search evidence, tool diffs and reasoning while running, then collapses and can reopen", () => {
    const items: AgentActivityItem[] = [
      {
        id: "plan",
        type: "step",
        label: "Plan changes",
        status: "complete",
        meta: "2s",
      },
      { id: "check", type: "step", label: "Check files", status: "active" },
      { id: "pending", type: "step", label: "Publish", status: "pending" },
      {
        id: "text",
        type: "text",
        content: "The API needs a compatibility check.",
      },
      {
        id: "search",
        type: "search",
        query: "API compatibility",
        results: [
          {
            id: "public",
            title: "API documentation",
            domain: "example.org",
            url: "https://example.org/api",
          },
          { id: "local", title: "Local index", icon: <span>Index</span> },
        ],
        moreCount: 4,
      },
      { id: "read", type: "tool", action: "read", target: "src/api.ts" },
      {
        id: "edit",
        type: "tool",
        action: "edit",
        target: "src/client.ts",
        additions: 0,
        deletions: 3,
      },
      {
        id: "run",
        type: "tool",
        action: "run",
        target: "pnpm test",
        additions: 5,
      },
      { id: "custom", type: "tool", action: "inspect", target: "runtime" },
    ];
    const { rerender } = render(<AgentActivity items={items} />);
    expect(screen.getByRole("status")).toHaveTextContent("Working through it…");
    expect(screen.getAllByRole("listitem")).toHaveLength(items.length);
    expect(
      screen.getByRole("link", { name: /API documentation/ }),
    ).toHaveAttribute("href", "https://example.org/api");
    expect(screen.getByText("Local index").closest("a")).toBeNull();
    expect(screen.getByText("+4 more")).toBeInTheDocument();
    const diff = screen.getByText("src/client.ts").parentElement as HTMLElement;
    expect(diff).toHaveTextContent("+0");
    expect(diff).toHaveTextContent("−3");
    rerender(<AgentActivity items={items} status="complete" />);
    const toggle = screen.getByRole("button", { name: "Completed 9 steps" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("link", { name: /API documentation/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(items.length);
  });

  it("counts trace messages separately from tool calls and preserves the stream when configured", () => {
    const items: AgentActivityItem[] = [
      {
        id: "thought",
        type: "trace",
        kind: "thinking",
        label: "Reasoning",
        detail: "Compare options",
      },
      { id: "reply", type: "trace", kind: "message", label: "Reply" },
      {
        id: "write",
        type: "trace",
        kind: "write",
        label: "Patch",
        detail: "src/a.ts",
      },
      {
        id: "run",
        type: "trace",
        kind: "run",
        label: "Tests",
        detail: "pnpm test",
      },
      {
        id: "read",
        type: "trace",
        kind: "read",
        label: "Read",
        detail: "report.png",
      },
      {
        id: "tool",
        type: "trace",
        kind: "custom",
        label: "Inspect",
        icon: <span>Custom icon</span>,
      },
    ];
    const { rerender } = render(
      <AgentActivity items={items} collapseOnComplete={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Working through the run…",
    );
    rerender(
      <AgentActivity
        items={items}
        collapseOnComplete={false}
        status="complete"
      />,
    );
    expect(
      screen.getByRole("button", { name: "4 tool calls, 2 messages" }),
    ).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list");
    expect(within(list).getByText("Compare options")).toBeInTheDocument();
    expect(within(list).getByText("report.png")).toBeInTheDocument();
  });

  it.each([
    [0, "0s"],
    [-4, "0s"],
    [61, "1m 1s"],
    [120, "2m"],
  ] as const)(
    "formats completed reasoning duration %s as %s",
    (duration, label) => {
      render(
        <AgentActivity
          items={[{ id: "text", type: "text", content: "Reasoning details" }]}
          status="complete"
          duration={duration}
        />,
      );
      const toggle = screen.getByRole("button", {
        name: `Thought for ${label}`,
      });
      fireEvent.click(toggle);
      expect(screen.getByRole("region")).toHaveTextContent("Reasoning details");
    },
  );

  it("keeps disclosure under controlled ownership and renders supplied status summaries", () => {
    const changed = vi.fn();
    const { rerender } = render(
      <AgentActivity
        items={[
          { id: "tool", type: "tool", action: "write", target: "notes.txt" },
        ]}
        status="complete"
        open={false}
        onOpenChange={changed}
        renderCompletedStatus={({ summary, duration }) => (
          <span>
            {summary} in {duration}s
          </span>
        )}
        duration={3}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ran 1 tool in 3s" }));
    expect(changed).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    rerender(
      <AgentActivity
        items={[]}
        contentType="search"
        activeLabel="Checking references"
        renderWorkingStatus={({ label }) => <span>{label}</span>}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking references");
  });
});
