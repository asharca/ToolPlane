import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpRequestLogs } from "@/components/dashboard/McpRequestLogs";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const logs = [
  {
    id: "ok",
    deploymentName: "Memory",
    deploymentHref: "/app/smoke/mcp/memory",
    method: "POST",
    path: "/mcp/memory/rpc#tools/call:remember",
    statusCode: 200,
    durationMs: 42,
    requestBody: JSON.stringify({ params: { name: "remember" } }),
    responseBody: JSON.stringify({
      result: { content: [{ type: "text", text: "Saved" }] },
    }),
    time: "Aug 12, 1:10 PM",
  },
  {
    id: "semantic-error",
    deploymentName: "Memory",
    deploymentHref: "/app/smoke/mcp/memory",
    method: "POST",
    path: "/mcp/memory/rpc#tools/call:private_tool",
    statusCode: 200,
    durationMs: 623,
    requestBody: JSON.stringify({ params: { name: "private_tool" } }),
    responseBody: JSON.stringify({
      error: { message: "Unknown tool: private_tool" },
    }),
    time: "Aug 12, 1:09 PM",
  },
];

describe("McpRequestLogs", () => {
  beforeEach(() => router.refresh.mockClear());
  afterEach(() => vi.useRealTimers());
  it("prioritizes the tool operation and semantic errors over an internal path", async () => {
    render(<McpRequestLogs logs={logs} showServer />);

    expect(screen.getAllByText("Call tool")).toHaveLength(2);
    expect(screen.getByText("private_tool")).toBeInTheDocument();
    expect(screen.getByText("Unknown tool: private_tool")).toBeInTheDocument();
    expect(screen.getAllByText("HTTP 200")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /failed 1/i }));
    expect(screen.queryByText("remember")).not.toBeInTheDocument();
    expect(screen.getByText("private_tool")).toBeInTheDocument();
  });

  it("keeps raw transport details behind an expandable row", async () => {
    render(<McpRequestLogs logs={logs} />);

    expect(
      screen.queryByText("/mcp/memory/rpc#tools/call:remember"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /call tool.*remember/i }),
    );
    expect(
      screen.getByText("/mcp/memory/rpc#tools/call:remember"),
    ).toBeInTheDocument();
    expect(screen.getByText("Raw endpoint:")).toBeInTheDocument();
  });

  it("shows internal MCP requests without fake HTTP metadata or empty details", () => {
    render(
      <McpRequestLogs
        logs={[
          {
            id: "internal-list",
            method: "MCP",
            path: "",
            statusCode: 0,
            durationMs: 18,
            requestBody: null,
            responseBody: null,
            time: "Aug 12, 1:11 PM",
            rpcMethod: "tools/list",
            outcome: "success",
          },
        ]}
      />,
    );

    const row = screen.getByRole("button", { name: /list tools/i });
    expect(row).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByText("HTTP 0")).not.toBeInTheDocument();
  });

  it("copies formatted JSON and preserves non-JSON payloads", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(
      <McpRequestLogs
        logs={[{ ...logs[0], responseBody: "plain response\nunchanged" }]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /call tool.*remember/i }),
    );
    await user.click(screen.getByRole("button", { name: "Copy Request" }));
    expect(copy).toHaveBeenLastCalledWith(
      JSON.stringify(JSON.parse(logs[0].requestBody), null, 2),
    );
    await user.click(screen.getByRole("button", { name: "Copy Response" }));
    expect(copy).toHaveBeenLastCalledWith("plain response\nunchanged");
  });

  it("explains absent payloads without offering a fake copy action", async () => {
    render(
      <McpRequestLogs
        logs={[{ ...logs[0], requestBody: null, responseBody: null }]}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /call tool.*remember/i }),
    );
    expect(screen.getAllByText("Not recorded or expired")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /Copy/ }),
    ).not.toBeInTheDocument();
  });

  it("pauses and resumes only automatic refresh while preserving filters and expanded records", async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <McpRequestLogs logs={logs} refreshIntervalMs={5000} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /failed 1/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /call tool.*private_tool/i }),
    );
    await act(async () => vi.advanceTimersByTime(5000));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Pause auto-refresh" }));
    await act(async () => vi.advanceTimersByTime(10000));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(router.refresh).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Resume auto-refresh" }),
    );
    await act(async () => vi.advanceTimersByTime(5000));
    expect(router.refresh).toHaveBeenCalledTimes(3);
    rerender(<McpRequestLogs logs={[...logs]} refreshIntervalMs={5000} />);
    expect(screen.queryByText("remember")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /call tool.*private_tool/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps manual refresh available for empty lists without a polling interval", () => {
    render(<McpRequestLogs logs={[]} />);
    expect(screen.getByText("No requests recorded yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Pause auto-refresh" }),
    ).not.toBeInTheDocument();
  });

  it("replaces local search with server controls and uses the 500ms slow boundary", () => {
    const { rerender } = render(<McpRequestLogs logs={logs} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "absent" },
    });
    rerender(
      <McpRequestLogs
        logs={[
          { ...logs[0], durationMs: 499 },
          { ...logs[1], durationMs: 500 },
        ]}
        searchControls={<input aria-label="Server keyword" />}
      />,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByText("remember")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /slow.*1/i }));
    expect(screen.queryByText("remember")).not.toBeInTheDocument();
    expect(screen.getByText("private_tool")).toBeInTheDocument();
  });
});
