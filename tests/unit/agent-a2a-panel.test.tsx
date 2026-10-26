import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentA2APanel } from "@/components/dashboard/agents/AgentA2APanel";
import type { A2AConsoleView } from "@/lib/a2a/connection-info";
vi.mock("@/components/dashboard/agents/AgentA2ARemotes", () => ({
  AgentA2ARemotes: () => <h3>Connect an external Agent</h3>,
}));
vi.mock("@/components/dashboard/CopyButton", () => ({
  CopyButton: ({ text, label }: { text: string; label: string }) => (
    <button type="button" data-copy={text}>
      {label}
    </button>
  ),
}));
const view: A2AConsoleView = {
  canManage: true,
  local: { supported: true, ready: true },
  collaboration: { inboundEnabled: true, outboundEnabled: true },
  endpoint: {
    id: "agep_test",
    enabled: true,
    ready: true,
    revision: 1,
    clients: [],
  },
  connections: {
    localRpc: "https://tp.example/local",
    localCard: "https://tp.example/local",
    publicRpc: "https://tp.example/a2a",
    publicCard: "https://tp.example/a2a/card",
    publicMcp: "https://tp.example/a2a/mcp",
  },
};
let current: A2AConsoleView;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
beforeEach(() => {
  vi.clearAllMocks();
  current = structuredClone(view);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fetchMock.mockImplementation((_url, init) =>
    init?.method === "POST" ? json({ ok: true }) : json(current),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const show = async (runtimeKind = "pi-sdk") => {
  const rendered = render(
    <AgentA2APanel slug="team" agentId="agent" runtimeKind={runtimeKind} />,
  );
  await screen.findByRole("heading", {
    name: "Let external services call this Agent",
  });
  return rendered;
};
const posts = () =>
  fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");

describe("Agent A2A console panel", () => {
  it("opens ingress task history without requiring external A2A or submitting work", async () => {
    current.collaboration = { inboundEnabled: false, outboundEnabled: false };
    fetchMock.mockImplementation((url) =>
      String(url).includes("/tasks?")
        ? json({
            rootTaskId: "entry-task",
            restricted: false,
            nodes: [
              {
                id: "entry-task",
                parentTaskId: null,
                name: "Pi",
                state: "TASK_STATE_COMPLETED",
                phase: "completed",
              },
            ],
            selectedTask: {
              id: "entry-task",
              history: [
                {
                  messageId: "result",
                  role: "ROLE_AGENT",
                  parts: [{ text: "Pi task result" }],
                },
              ],
            },
          })
        : json(current),
    );
    render(
      <AgentA2APanel
        slug="team"
        agentId="agent"
        runtimeKind="pi-sdk"
        initialTaskId="entry-task"
      />,
    );
    expect(await screen.findByText("Pi task result")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Execution records / pending approvals",
      }),
    ).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("opens pending approvals from a task deep link without deciding automatically", async () => {
    fetchMock.mockImplementation((url) =>
      String(url).includes("/approvals?")
        ? json({
            approvals: [
              {
                id: "approval",
                taskId: "entry-task",
                toolName: "write",
                input: { path: "report.txt" },
                inputHash: "hash",
                status: "pending",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            ],
          })
        : String(url).includes("/tasks?")
          ? json({
              rootTaskId: "entry-task",
              restricted: false,
              nodes: [
                {
                  id: "entry-task",
                  parentTaskId: null,
                  name: "Pi",
                  state: "TASK_STATE_WORKING",
                  phase: "executing",
                  pendingApprovals: 1,
                },
              ],
              selectedTask: { id: "entry-task" },
            })
          : json(current),
    );
    render(
      <AgentA2APanel
        slug="team"
        agentId="agent"
        runtimeKind="pi-sdk"
        initialTaskId="entry-task"
      />,
    );
    expect(await screen.findByRole("button", { name: "Deny" })).toBeEnabled();
    expect(
      screen.getByRole("region", { name: "Native tool approvals" }),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("only reads settings on mount and links to public API documentation", async () => {
    await show();
    expect(posts()).toHaveLength(0);
    expect(
      screen.getAllByText("https://tp.example/local", { selector: "code" }),
    ).toHaveLength(2);
    expect(document.querySelector("pre")).not.toBeInTheDocument();
  });
  it("keeps internal selection and channel authorization without an execution playground", async () => {
    current.endpoint = null;
    current.channels = [
      {
        id: "channel",
        name: "Operations",
        platform: "telegram",
        enabled: true,
        mine: true,
      },
    ];
    await show();
    expect(
      screen.getAllByRole("heading", { name: "Internal collaboration" })[0],
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Connect an external Agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Let external services call this Agent",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Configure allowed delegates" }),
    ).toHaveAttribute("href", "?settings=subAgents");
    expect(
      screen.getByText(/only explicitly authorized targets/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Never give your account token to third parties/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Publish an active isolated Hermes/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Published service" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", {
        name: "Task message / additional input",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Execution records / pending approvals",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Channel execution operator" }),
    ).toBeInTheDocument();
  });
  it("keeps delegate configuration separate from independent default-deny policies", async () => {
    current.collaboration = { inboundEnabled: false, outboundEnabled: false };
    await show();
    expect(
      screen.getByRole("link", { name: "Configure allowed delegates" }),
    ).toHaveAttribute("href", "?settings=subAgents");
    expect(
      screen.getByRole("button", { name: "Enable inbound collaboration" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Enable outbound collaboration" }),
    ).toBeEnabled();
    expect(
      screen.getByText(/Inbound access is independent/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Outbound access is independent/),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("retains historical publication metadata without enabling or issuing credentials", async () => {
    await show();
    expect(
      screen.getByRole("heading", { name: "Published service" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Published revision: 1")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disable external A2A" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create client & key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add replacement key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Client name" }),
    ).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("disables admin controls for members while keeping integration documentation readable", async () => {
    current.canManage = false;
    current.connections = null;
    await show();
    expect(
      screen.getByRole("button", { name: "Disable inbound collaboration" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Create client & key" }),
    ).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it.each([false, true])(
    "changes each collaboration direction independently when enabled=%s",
    async (enabled) => {
      current.collaboration = {
        inboundEnabled: enabled,
        outboundEnabled: enabled,
      };
      await show();
      fireEvent.click(
        screen.getByRole("button", {
          name: enabled
            ? "Disable inbound collaboration"
            : "Enable inbound collaboration",
        }),
      );
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(JSON.parse(posts()[0][1].body)).toEqual({
        action: "set-inbound",
        enabled: !enabled,
      });
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: enabled
              ? "Disable outbound collaboration"
              : "Enable outbound collaboration",
          }),
        ).toBeEnabled(),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: enabled
            ? "Disable outbound collaboration"
            : "Enable outbound collaboration",
        }),
      );
      await waitFor(() => expect(posts()).toHaveLength(2));
      expect(JSON.parse(posts()[1][1].body)).toEqual({
        action: "set-outbound",
        enabled: !enabled,
      });
    },
  );
  it("reports a committed policy change with failed refresh without retrying the mutation", async () => {
    await show();
    fetchMock.mockImplementation((_url, init) =>
      init?.method === "POST" ? json({ ok: true }) : json({}, 500),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Disable inbound collaboration" }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Configuration saved.",
    );
    expect(posts()).toHaveLength(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("switches connection URLs without submitting tasks or exposing credentials in docs", async () => {
    await show();
    expect(
      screen.getAllByText("https://tp.example/local", { selector: "code" }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Published service" }));
    expect(
      screen.getByText("https://tp.example/a2a", { selector: "code" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "External A2A & channel access" }),
    );
    expect(
      screen.queryByText("https://tp.example/a2a", { selector: "code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("https://tp.example/local", { selector: "code" }),
    ).toHaveLength(2);
    expect(document.querySelector("pre")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
