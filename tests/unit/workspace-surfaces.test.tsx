import { assertDefined } from "../assert-defined";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceKnowledge } from "@/components/dashboard/knowledge/WorkspaceKnowledge";
import { WorkspaceWork } from "@/components/dashboard/work/WorkspaceWork";

const surfaceMocks = vi.hoisted(() => ({
  modelDialog: vi.fn(),
  pinAgentAction: vi.fn(),
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
  sandboxConsole: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: surfaceMocks.routerPush,
    refresh: surfaceMocks.routerRefresh,
  }),
}));
vi.mock("@/lib/agents/actions", () => ({
  deleteAgentAction: vi.fn(),
  pinAgentAction: surfaceMocks.pinAgentAction,
}));

vi.mock("@/components/dashboard/agents/AgentConversation", () => ({
  AgentConversation: () => <div>Conversation surface</div>,
}));

vi.mock("@/components/dashboard/agents/AgentModelDialog", () => ({
  AgentModelDialog: (props: { trigger: React.ReactNode }) => {
    surfaceMocks.modelDialog(props);
    return props.trigger;
  },
}));

vi.mock("@/components/dashboard/sandboxes/SandboxConsole", () => ({
  SandboxConsole: (props: { filesOnly?: boolean; terminalOnly?: boolean }) => {
    surfaceMocks.sandboxConsole(props);
    return <div>{props.filesOnly ? "Files surface" : "Terminal surface"}</div>;
  },
}));

class WorkEventSource {
  static latest: WorkEventSource | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    WorkEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  WorkEventSource.latest = null;
  window.localStorage.removeItem("toolplane:work-sidebar:workspace-1");
  window.localStorage.removeItem("toolplane:work-agent-groups:workspace-1");
  window.localStorage.removeItem(
    "toolplane:work-agent-sidebar-groups:workspace-1",
  );
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom lacks Cookie Store; expire the actual document cookie between tests.
  document.cookie = "toolplane_work_sidebar_workspace-1=; Path=/; Max-Age=0";
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom lacks Cookie Store; expire the actual document cookie between tests.
  document.cookie =
    "toolplane_work_agent_groups_workspace-1=; Path=/; Max-Age=0";
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom lacks Cookie Store; expire the actual document cookie between tests.
  document.cookie =
    "toolplane_work_agent_group_preferences_workspace-1=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Chat, Work, and Knowledge surfaces", () => {
  it("persists the Work sidebar visibility preference", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "pi",
      sandboxes: [],
    };
    const firstRender = render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[agent]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Hide Agents and work sessions" }),
    );
    expect(
      window.localStorage.getItem("toolplane:work-sidebar:workspace-1"),
    ).toBe("false");
    firstRender.unmount();

    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        initialSidebarOpen={false}
        agents={[agent]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );
    expect(document.querySelector("aside")).toHaveClass("hidden");
    expect(
      screen.getAllByRole("button", { name: "Show Agents and work sessions" }),
    ).toHaveLength(1);
  });

  it("keeps the Work sidebar focused on the assistant list with creation and per-assistant session actions", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "pi",
      sandboxes: [],
    };
    const settingUpAgent = {
      ...agent,
      id: "agent-2",
      name: "Setting up",
      ready: false,
    };
    const brokenAgent = {
      ...settingUpAgent,
      id: "agent-3",
      name: "Broken",
      sandboxes: [
        {
          id: "sandbox-1",
          name: "Broken",
          kind: "docker",
          deploymentId: "deployment-1",
          status: "error",
          running: false,
          isDefault: true,
        },
      ],
    };
    const runningAgent = {
      ...agent,
      id: "agent-4",
      name: "Running agent",
      sandboxes: [
        {
          id: "sandbox-2",
          name: "Running",
          kind: "docker",
          deploymentId: "deployment-2",
          status: "running",
          running: true,
          isDefault: true,
        },
      ],
    };
    const session = (id: string, status: string, agentId = agent.id) => ({
      id,
      agentId,
      title: id,
      task: id,
      acceptanceCriteria: null,
      runtimeKind: "pi",
      status,
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      conversationId: id,
      sandbox: null,
      messages: [],
      approvals: [],
    });
    const sessions = [
      session("Failed task", "failed"),
      session("Waiting task", "waiting_approval"),
      session("Running task", "running", runningAgent.id),
      session("Completed task", "completed"),
    ];
    const runningSession = assertDefined(
      sessions.find((item) => item.id === "Running task"),
    );
    const workspaceProps = {
      slug: "acme",
      workspaceId: "workspace-1",
      agents: [agent, settingUpAgent, brokenAgent, runningAgent],
      selectedWorkSessionId: runningSession.id,
      selectedSession: runningSession,
      initialExpandedAgents: { "agent-1": true, "agent-4": true },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...runningSession, status: "completed" }),
      );
    vi.stubGlobal("EventSource", WorkEventSource);
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkspaceWork {...workspaceProps} sessions={sessions} />);

    expect(
      screen.queryByRole("textbox", { name: "Search" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^New work$/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add agent" })).toHaveAttribute(
      "href",
      expect.stringContaining("/agents?create=1"),
    );
    expect(
      screen.getByRole("link", { name: "Add agent" }).parentElement,
    ).not.toHaveTextContent("Agents");
    expect(
      screen
        .getByRole("treeitem", { name: "Builder" })
        .querySelector("span.absolute"),
    ).toBeNull();
    expect(
      screen
        .getByRole("treeitem", { name: "Setting up" })
        .querySelector("span.absolute"),
    ).toHaveClass("bg-amber-500");
    expect(
      screen
        .getByRole("treeitem", { name: "Broken" })
        .querySelector("span.absolute"),
    ).toHaveClass("bg-destructive");
    expect(
      screen
        .getByRole("treeitem", { name: "Running agent" })
        .querySelector("span.absolute"),
    ).toHaveClass("bg-green-500");
    expect(
      screen
        .getByRole("treeitem", { name: "Running task" })
        .querySelector("svg.lucide-circle"),
    ).toHaveClass("text-green-500");
    expect(
      screen
        .getByRole("treeitem", { name: "Failed task" })
        .querySelector("svg.lucide-circle"),
    ).toHaveClass("text-destructive");
    expect(
      screen
        .getByRole("treeitem", { name: "Waiting task" })
        .querySelector("svg.lucide-circle"),
    ).toHaveClass("text-amber-500");
    expect(
      screen
        .getByRole("treeitem", { name: "Completed task" })
        .querySelector("svg.lucide-circle"),
    ).toBeNull();
    WorkEventSource.latest?.emit("done", {});
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(
        screen
          .getByRole("treeitem", { name: "Running agent" })
          .querySelector("span.absolute"),
      ).toBeNull();
      expect(
        screen
          .getByRole("treeitem", { name: "Running task" })
          .querySelector("svg.lucide-circle"),
      ).toBeNull();
    });
    const newWork = screen.getByRole("button", { name: "New work Builder" });
    const actions = screen.getByRole("button", { name: "Actions for Builder" });
    expect(
      newWork.compareDocumentPosition(actions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(newWork.parentElement).toBe(actions.parentElement?.parentElement);
    expect(newWork.parentElement).toHaveClass("gap-0.5");
    expect(newWork).toHaveClass(
      "opacity-0",
      "group-hover/resource:opacity-100",
    );
    expect(actions).toHaveClass(
      "opacity-0",
      "group-hover/resource:opacity-100",
    );
    await user.click(screen.getByRole("button", { name: "List options" }));
    expect(screen.queryByText("List options")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "List options" }),
    ).not.toHaveAttribute("title");
    const expandAll = screen.getByRole("button", { name: "Expand all" });
    expect(expandAll).toHaveClass("justify-start", "rounded-md");
    expect(expandAll.querySelector("svg")).toHaveClass("shrink-0");
    await user.click(screen.getByRole("button", { name: "List options" }));

    await user.click(newWork);
    expect(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
    ).toBeInTheDocument();
  });
  it("renders native and legacy command output as ordinary copyable assistant replies, without a command accordion", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "claude-code",
      sandboxes: [],
    };
    const session = {
      id: "work-1",
      agentId: agent.id,
      title: "Task",
      task: "Task",
      acceptanceCriteria: null,
      runtimeKind: "claude-code",
      status: "completed",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      conversationId: "conversation-1",
      sandbox: null,
      approvals: [],
      messages: [
        {
          id: "usage",
          role: "assistant",
          parts: [
            { type: "text", text: "Total cost: $0.03" },
            {
              type: "data-command-result",
              data: { command: "usage", text: "Total cost: $0.03" },
            },
          ],
        },
        {
          id: "legacy-context",
          role: "system",
          parts: [
            {
              type: "data-command-result",
              data: { command: "context", text: "Context Usage: 123 tokens" },
            },
          ],
        },
      ],
    };
    const { container } = render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[agent]}
        sessions={[session]}
        selectedWorkSessionId={session.id}
      />,
    );
    for (const output of ["Total cost: $0.03", "Context Usage: 123 tokens"]) {
      const text = screen.getByText(output);
      expect(text.closest("details")).toBeNull();
      const reply = within(text.closest("[data-message-id]") as HTMLElement);
      await user.click(reply.getByRole("button", { name: "Copy response" }));
      expect(await navigator.clipboard.readText()).toBe(output);
    }
    expect(
      container.querySelector('[data-ui="conversation.command"]'),
    ).toBeNull();
    const helpful = within(
      screen
        .getByText("Context Usage: 123 tokens")
        .closest("[data-message-id]") as HTMLElement,
    ).getByRole("button", { name: "Helpful" });
    await user.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "true");
    await user.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "false");
  });

  it("shares tools between / and + without New task, reserves /new for channels, and retains explicit compaction", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "dsh",
      sandboxes: [],
    };
    const session = {
      id: "work-1",
      agentId: agent.id,
      title: "Task",
      task: "Task",
      acceptanceCriteria: null,
      runtimeKind: "dsh",
      status: "completed",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      conversationId: "conversation-1",
      sandbox: null,
      messages: [
        {
          id: "reply",
          role: "assistant",
          parts: [{ type: "text", text: "Original reply" }],
        },
      ],
      approvals: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ compacted: true }))
      .mockResolvedValueOnce(Response.json({ session }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[agent]}
        sessions={[session]}
        selectedWorkSessionId={session.id}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "What should the Agent accomplish?",
    });
    await user.type(input, "/");
    const menu = screen.getByRole("listbox", { name: "Tools" });
    const options = within(menu).getAllByRole("option");
    expect(
      within(menu).queryByRole("option", { name: "New task" }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).getByRole("option", { name: /\/compact/ }),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-controls", menu.id);
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{ArrowUp}");
    expect(options.at(-1)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Open tools" }));
    expect(
      screen.queryByRole("option", { name: "New task" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.type(input, "/new{Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Original reply")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "/compact preserve file paths");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/agents/agent-1/conversations/conversation-1/commands",
        expect.objectContaining({
          body: '{"line":"/compact preserve file paths"}',
        }),
      ),
    );
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByText("Original reply")).toBeInTheDocument();
    fetchMock.mockClear();

    await user.type(input, "/");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(input).toHaveValue("/");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("/");
    await user.clear(input);
    await user.type(input, "/task");
    expect(
      screen.queryByRole("option", { name: "New task" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("/task");
    expect(screen.getByText("Original reply")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps slash suggestions out of paths, selections and busy turns, and never sends an empty compaction to the model", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", WorkEventSource);
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "dsh",
      sandboxes: [
        {
          id: "sandbox-1",
          name: "Workspace",
          kind: "docker",
          deploymentId: "deployment-1",
          running: true,
          isDefault: true,
        },
      ],
    };
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      agents: [agent],
      sessions: [],
      selectedWorkSessionId: null,
    };
    const { rerender } = render(<WorkspaceWork {...props} />);
    let input = screen.getByRole("combobox", {
      name: "What should the Agent accomplish?",
    });
    await user.type(input, "/");
    expect(
      screen.getByRole("option", { name: /\/compact/ }),
    ).toBeInTheDocument();
    for (const value of [
      "/workspace/file",
      "https://example.com",
      "read /new",
      "/compact preserve details",
    ]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    }
    fireEvent.change(input, { target: { value: "/compact" } });
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("/compact ");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(
      screen.getByText("Start a task before running this command."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "/n");
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "/");
    await user.click(screen.getByRole("button", { name: "List options" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(input);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("/\n");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    const session = {
      id: "work-1",
      agentId: agent.id,
      title: "Task",
      task: "Task",
      acceptanceCriteria: null,
      runtimeKind: "dsh",
      status: "running",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      conversationId: "conversation-1",
      sandbox: null,
      messages: [],
      approvals: [],
    };
    rerender(
      <WorkspaceWork
        {...props}
        sessions={[session]}
        selectedWorkSessionId={session.id}
      />,
    );
    input = screen.getByRole("combobox", {
      name: "What should the Agent accomplish?",
    });
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["idle", "running", "completed"])(
    "keeps only file and terminal actions in the %s Work header",
    (status) => {
      vi.stubGlobal("EventSource", WorkEventSource);
      const sandbox = {
        id: "sandbox-1",
        name: "Workspace",
        kind: "docker",
        deploymentId: "deployment-1",
        running: false,
        isDefault: true,
      };
      const agent = {
        id: "agent-1",
        name: "Builder",
        pinned: false,
        supportsWork: true,
        ready: true,
        runtimeKind: "dsh",
        sandboxes: [sandbox],
      };
      const session = {
        id: "work-1",
        agentId: agent.id,
        title: "Task",
        task: "Task",
        acceptanceCriteria: null,
        runtimeKind: "dsh",
        status,
        waitingQuestion: null,
        result: null,
        error: null,
        artifacts: [],
        conversationId: "conversation-1",
        sandbox,
        messages: [],
        approvals: [],
      };
      const { rerender } = render(
        <WorkspaceWork
          slug="acme"
          workspaceId="workspace-1"
          agents={[agent]}
          sessions={[session]}
          selectedWorkSessionId={session.id}
        />,
      );

      const header = screen.getByRole("banner");
      expect(
        within(header)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Hide Agents and work sessions", "Files", "Terminal"]);
      fireEvent.click(within(header).getByRole("button", { name: "Files" }));
      expect(screen.getByRole("dialog", { name: "Files" })).toHaveTextContent(
        "Files surface",
      );
      fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
      fireEvent.click(within(header).getByRole("button", { name: "Terminal" }));
      expect(
        screen.getByRole("dialog", { name: "Terminal" }),
      ).toHaveTextContent("Terminal surface");
      fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));

      rerender(
        <WorkspaceWork
          slug="acme"
          workspaceId="workspace-1"
          selectedWorkSessionId={null}
          sessions={[]}
          agents={[agent]}
          selectedConversation={{
            id: "channel-chat",
            agentId: agent.id,
            source: { platform: "weixin", chatType: "dm", chatId: "contact" },
            readOnly: true,
            messages: [],
          }}
        />,
      );
      expect(
        within(screen.getByRole("banner"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Hide Agents and work sessions", "Files", "Terminal"]);
    },
  );

  it("shows channel conversations under their Agent and refreshes before the first message", () => {
    vi.useFakeTimers();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: false,
      runtimeKind: "dsh",
      sandboxes: [],
    };
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      selectedWorkSessionId: null,
      agents: [agent, { ...agent, id: "agent-wechat", name: "WeChat agent" }],
      sessions: [],
      hasChannels: true,
    };
    const { rerender, unmount } = render(<WorkspaceWork {...props} />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(surfaceMocks.routerRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceWork
        {...props}
        conversations={[
          {
            id: "wechat-history",
            agentId: "agent-wechat",
            source: { platform: "weixin", chatType: "dm", chatId: "contact" },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("treeitem", { name: "WeChat agent" }));
    const channelResource = screen.getByRole("treeitem", {
      name: "WeChat · contact",
    });
    expect(channelResource).toHaveAttribute("aria-level", "2");
    fireEvent.click(channelResource);
    expect(surfaceMocks.routerPush).toHaveBeenCalledWith(
      "/app/acme/work?agent=agent-wechat&c=wechat-history",
    );
    expect(
      screen.getByRole("treeitem", { name: "Builder" }),
    ).toBeInTheDocument();
    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(surfaceMocks.routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the Work sidebar and sandbox tools while switching between task and channel messages", () => {
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "dsh",
      sandboxes: [
        {
          id: "sandbox-1",
          name: "Workspace",
          kind: "docker",
          deploymentId: "dep-1",
          running: true,
          isDefault: true,
        },
      ],
    };
    const session = {
      id: "work-1",
      agentId: agent.id,
      title: "Task history",
      task: "Task history",
      acceptanceCriteria: null,
      runtimeKind: "dsh",
      status: "completed",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      conversationId: "task-conversation",
      sandbox: agent.sandboxes[0],
      messages: [
        {
          id: "task-reply",
          role: "assistant",
          parts: [{ type: "text", text: "Task reply" }],
        },
      ],
      approvals: [],
    };
    const channel = {
      id: "wechat-history",
      agentId: agent.id,
      source: {
        platform: "weixin",
        chatType: "dm" as const,
        chatId: "contact",
      },
      readOnly: true,
      messages: [
        {
          id: "inbound",
          role: "user",
          parts: [
            {
              type: "text",
              text: "[Messaging source: platform=weixin]\n\nIncoming message",
            },
          ],
        },
        {
          id: "reply",
          role: "assistant",
          parts: [{ type: "text", text: "WeChat reply" }],
        },
      ],
    };
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      agents: [agent],
      sessions: [session],
      conversations: [channel],
    };
    const { container, rerender } = render(
      <WorkspaceWork {...props} selectedWorkSessionId="work-1" />,
    );
    expect(screen.getByText("Task reply")).toBeInTheDocument();
    rerender(
      <WorkspaceWork
        {...props}
        selectedWorkSessionId={null}
        selectedConversation={channel}
      />,
    );
    expect(
      screen.getByText("WeChat reply").closest('[data-ui="work.transcript"]'),
    ).toBeInTheDocument();
    expect(screen.getByText("Incoming message")).toBeInTheDocument();
    expect(screen.queryByText(/Messaging source:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: "WeChat · contact" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("treeitem", { name: "Task history" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Terminal" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-ui="chat.composer"]'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: "Builder" }));
    rerender(
      <WorkspaceWork
        {...props}
        selectedWorkSessionId="work-1"
        selectedConversation={null}
      />,
    );
    expect(screen.getByRole("treeitem", { name: "Builder" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.getByRole("treeitem", { name: "Task history" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: "Builder" }));
    expect(screen.getByText("Task reply")).toBeInTheDocument();
    expect(
      container.querySelector('[data-ui="chat.composer"]'),
    ).toBeInTheDocument();
  });
  it.each(["pi", "hermes"] as const)(
    "refreshes a newly created %s Agent until its runtime leaves provisioning",
    (runtimeKind) => {
      vi.useFakeTimers();
      const agent = {
        id: "agent-1",
        name: "Builder",
        pinned: false,
        supportsWork: true,
        ready: true,
        runtimeKind,
        sandboxes: [
          {
            id: "sandbox-1",
            name: "Workspace",
            kind: "docker",
            deploymentId: "deployment-1",
            status: "provisioning",
            running: false,
            isDefault: true,
          },
        ],
      };
      const props = {
        slug: "acme",
        workspaceId: "workspace-1",
        sessions: [],
        selectedWorkSessionId: null,
      };
      const { rerender, unmount } = render(
        <WorkspaceWork {...props} agents={[agent]} />,
      );

      act(() => vi.advanceTimersByTime(1_500));
      expect(surfaceMocks.routerRefresh).toHaveBeenCalledTimes(1);

      rerender(
        <WorkspaceWork
          {...props}
          agents={[
            {
              ...agent,
              sandboxes: [
                { ...agent.sandboxes[0], status: "running", running: true },
              ],
            },
          ]}
        />,
      );
      act(() => vi.advanceTimersByTime(3_000));
      expect(surfaceMocks.routerRefresh).toHaveBeenCalledTimes(1);
      unmount();
    },
  );

  it("starts Work from the chat composer without a task form", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [
              {
                id: "sandbox-1",
                name: "Workspace",
                kind: "docker",
                deploymentId: "deployment-1",
                running: true,
                isDefault: true,
              },
            ],
          },
          {
            id: "agent-hermes",
            name: "Hermes researcher",
            pinned: true,
            supportsWork: true,
            ready: false,
            runtimeKind: "hermes",
            providerIds: ["provider-hermes"],
            providerLabel: "OpenAI",
            sandboxes: [
              {
                id: "sandbox-hermes",
                name: "Hermes runtime",
                kind: "hermes",
                deploymentId: "deployment-hermes",
                running: false,
                isDefault: true,
              },
            ],
          },
          {
            id: "agent-chat",
            name: "Chat only",
            pinned: false,
            supportsWork: false,
            ready: false,
            runtimeKind: null,
            sandboxes: [],
          },
        ]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );

    expect(screen.getByRole("link", { name: "Add agent" })).toHaveAttribute(
      "href",
      "/app/acme/agents?create=1&returnTo=%2Fapp%2Facme%2Fwork",
    );
    fireEvent.click(screen.getByRole("button", { name: "List options" }));
    expect(
      screen.getByRole("button", { name: "Collapse all" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Manage agents" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const builderActions = screen.getByRole("button", {
      name: "Actions for Builder",
    });
    await user.click(builderActions);
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(surfaceMocks.pinAgentAction).toHaveBeenCalledOnce(),
    );
    const pinForm = surfaceMocks.pinAgentAction.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(pinForm)).toEqual({
      agentId: "agent-1",
      pinned: "true",
      workspace: "acme",
    });
    expect(surfaceMocks.routerRefresh).toHaveBeenCalledOnce();
    await user.click(
      screen.getByRole("button", { name: "Actions for Hermes researcher" }),
    );
    const hermesMenu = document.querySelector<HTMLElement>(
      '[data-sidebar-resource-menu="agent:agent-hermes"]',
    );
    expect(hermesMenu).not.toBeNull();
    await user.click(
      within(assertDefined(hermesMenu)).getByRole("button", {
        name: "Delete agent",
      }),
    );
    const deleteDialog = screen.getByRole("dialog", { name: "Delete agent" });
    expect(deleteDialog).toHaveTextContent(
      "Delete this agent, its sandboxes, and all its conversations?",
    );
    expect(deleteDialog.querySelector('input[name="returnTo"]')).toHaveValue(
      "/app/acme/work",
    );
    expect(
      screen.queryByRole("button", { name: /Thinking effort/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Acceptance criteria")).not.toBeInTheDocument();
    expect(screen.queryByText("Run budget")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("groups Work agents through the resource tree and persists the assignment", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "pi",
      sandboxes: [],
    };
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[agent]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "List options" }));
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(
      screen.getByRole("textbox", { name: "Group name" }),
      "Engineering",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
    };
    const builder = screen.getByRole("treeitem", { name: "Builder" });
    const engineering = screen.getByRole("treeitem", { name: "Engineering" });
    fireEvent.dragStart(builder, { dataTransfer });
    const dragOver = createEvent.dragOver(engineering, { dataTransfer });
    Object.defineProperty(dragOver, "clientY", { value: 10 });
    vi.spyOn(engineering, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 20,
    } as DOMRect);
    fireEvent(engineering, dragOver);
    fireEvent.drop(engineering, { dataTransfer });
    await waitFor(() =>
      expect(
        JSON.parse(
          assertDefined(
            window.localStorage.getItem(
              "toolplane:work-agent-sidebar-groups:workspace-1",
            ),
          ),
        ).assignments["agent-1"],
      ).toBeTruthy(),
    );
    expect(screen.getByRole("treeitem", { name: "Builder" })).toHaveAttribute(
      "aria-level",
      "2",
    );
    expect(
      JSON.parse(
        assertDefined(
          window.localStorage.getItem(
            "toolplane:work-agent-sidebar-groups:workspace-1",
          ),
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        groups: [expect.objectContaining({ name: "Engineering" })],
        assignments: { "agent-1": expect.any(String) },
      }),
    );
  });

  it("reorders Work projects from resource actions and restores the saved order", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "pi",
      sandboxes: [],
    };
    const agents = [
      agent,
      { ...agent, id: "agent-2", name: "Reviewer" },
      { ...agent, id: "agent-3", name: "Researcher" },
    ];
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      agents,
      sessions: [],
      selectedWorkSessionId: null,
    };
    const storageKey = "toolplane:work-agent-sidebar-groups:workspace-1";
    const { unmount } = render(<WorkspaceWork {...props} />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Researcher" }),
    );
    await user.click(screen.getByRole("button", { name: "Move up" }));
    expect(
      screen.getAllByRole("treeitem").map((item) => item.textContent?.trim()),
    ).toEqual(["Builder", "Researcher", "Reviewer"]);
    expect(
      JSON.parse(assertDefined(window.localStorage.getItem(storageKey))),
    ).toEqual(
      expect.objectContaining({
        entityOrder: ["agent-1", "agent-3", "agent-2"],
      }),
    );
    unmount();

    render(<WorkspaceWork {...props} />);
    expect(
      screen.getAllByRole("treeitem").map((item) => item.textContent?.trim()),
    ).toEqual(["Builder", "Researcher", "Reviewer"]);
  });
  it("lists Work threads, navigates from tree items, and preserves hidden-thread order when moving one", async () => {
    const user = userEvent.setup();
    const agent = {
      id: "agent-1",
      name: "Builder",
      pinned: false,
      supportsWork: true,
      ready: true,
      runtimeKind: "pi",
      sandboxes: [],
    };
    const session = (id: string, title: string) => ({
      id,
      agentId: agent.id,
      title,
      task: title,
      acceptanceCriteria: null,
      runtimeKind: "pi",
      status: "completed",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      conversationId: `${id}-conversation`,
      sandbox: null,
      messages: [],
      approvals: [],
    });
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      agents: [agent],
      sessions: [
        session("hidden", "Hidden task"),
        session("work-1", "Visible first"),
        session("work-2", "Visible second"),
      ],
      selectedWorkSessionId: null,
      initialExpandedAgents: { "agent-1": true },
      initialGroupPreferences: {
        groups: [],
        assignments: {},
        collapsed: {},
        conversationOrder: { "agent-1": ["hidden", "work-1", "work-2"] },
      },
    };
    const storageKey = "toolplane:work-agent-sidebar-groups:workspace-1";
    const { unmount } = render(<WorkspaceWork {...props} />);
    expect(
      screen.getByRole("treeitem", { name: "Visible second" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: "Visible second" }));
    expect(surfaceMocks.routerPush).toHaveBeenCalledWith(
      "/app/acme/work?w=work-2",
    );
    await user.click(
      screen.getByRole("button", { name: "Actions for Visible second" }),
    );
    await user.click(screen.getByRole("button", { name: "Move up" }));
    expect(
      JSON.parse(assertDefined(window.localStorage.getItem(storageKey)))
        .conversationOrder["agent-1"],
    ).toEqual(["hidden", "work-2", "work-1"]);
    expect(
      screen.getAllByRole("treeitem").map((item) => item.textContent?.trim()),
    ).toEqual(["Builder", "Hidden task", "Visible second", "Visible first"]);
    unmount();

    render(<WorkspaceWork {...props} />);
    expect(
      screen.getAllByRole("treeitem").map((item) => item.textContent?.trim()),
    ).toEqual(["Builder", "Hidden task", "Visible second", "Visible first"]);
  });

  it("selects thinking effort for Hermes Work", async () => {
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-hermes",
            name: "Hermes researcher",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "hermes",
            providerIds: ["provider-hermes"],
            providerLabel: "OpenAI",
            sandboxes: [
              {
                id: "sandbox-hermes",
                name: "Hermes runtime",
                kind: "hermes",
                deploymentId: "deployment-hermes",
                running: true,
                isDefault: true,
              },
            ],
          },
        ]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );

    const effort = screen.getByRole("button", { name: /Thinking effort/ });
    await userEvent.click(effort);
    const slider = screen.getByRole("slider", { name: "Thinking effort" });
    slider.focus();
    await userEvent.keyboard("{End}{ArrowLeft}");
    expect(slider).toHaveAttribute("aria-valuetext", "Extra high");
    await userEvent.keyboard("{Escape}");
    expect(effort).toHaveAccessibleName("Thinking effort: Extra high");
  });

  it("sends a draft Hermes model with the first Work task", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "stop after capture" }, { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-hermes",
            name: "Hermes researcher",
            pinned: false,
            supportsWork: true,
            ready: false,
            runtimeKind: "hermes",
            providerIds: [],
            providerLabel: "OpenAI",
            sandboxes: [
              {
                id: "sandbox-hermes",
                name: "Hermes runtime",
                kind: "hermes",
                deploymentId: "deployment-hermes",
                running: true,
                isDefault: true,
              },
            ],
          },
        ]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );
    const dialogProps = surfaceMocks.modelDialog.mock.calls.at(-1)?.[0] as {
      hermesConversation: { id: string | null; editable: boolean };
      onHermesDraftChange: (selection: {
        profile: string;
        provider: string | null;
        model: string | null;
      }) => void;
    };
    expect(dialogProps.hermesConversation).toMatchObject({
      id: null,
      editable: true,
    });
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
      { target: { value: "Research it" } },
    );
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();
    act(() =>
      dialogProps.onHermesDraftChange({
        profile: "research",
        provider: "openrouter",
        model: "model-b",
      }),
    );
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/work-sessions",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const request = fetchMock.mock.calls.find(
      ([url]) => url === "/api/v1/work-sessions",
    )?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      hermesProfile: "research",
      hermesProvider: "openrouter",
      hermesModel: "model-b",
    });
  });

  it("keeps legacy Hermes Work creation unchanged until a model is explicitly selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "stop after capture" }, { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-hermes",
            name: "Hermes researcher",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "hermes",
            providerIds: ["provider-hermes"],
            sandboxes: [
              {
                id: "sandbox-hermes",
                name: "Hermes runtime",
                kind: "hermes",
                deploymentId: "deployment-hermes",
                running: true,
                isDefault: true,
              },
            ],
          },
        ]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
      { target: { value: "Run it" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/work-sessions",
        expect.anything(),
      ),
    );
    const request = fetchMock.mock.calls.find(
      ([url]) => url === "/api/v1/work-sessions",
    )?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).not.toHaveProperty("hermesProfile");
    expect(body).not.toHaveProperty("hermesProvider");
    expect(body).not.toHaveProperty("hermesModel");
  });

  it("inserts an attached MCP prompt into the Work composer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            prompts: [
              {
                deploymentId: "prompt-deployment",
                serverName: "Prompt Studio",
                name: "summarize_text",
                title: "Summarize text",
                description: "Turn long text into a concise summary.",
                arguments: [
                  {
                    name: "text",
                    title: "Text",
                    description: "Text to summarize",
                    required: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            text: "Summarize the following text:\n\nRelease notes",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [
              {
                id: "sandbox-1",
                name: "Workspace",
                kind: "docker",
                deploymentId: "deployment-1",
                running: true,
                isDefault: true,
              },
            ],
          },
        ]}
        sessions={[]}
        selectedWorkSessionId={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.click(screen.getByRole("option", { name: "MCP prompts" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Summarize text/ }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Text/ }), {
      target: { value: "Release notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Insert prompt" }));

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", {
          name: "What should the Agent accomplish?",
        }),
      ).toHaveValue("Summarize the following text:\n\nRelease notes"),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/agents/agent-1/prompts",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/agents/agent-1/prompts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deploymentId: "prompt-deployment",
          name: "summarize_text",
          arguments: { text: "Release notes" },
        }),
      }),
    );
  });

  it("opens separate Work file and terminal drawers for a selected session", () => {
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [],
          },
        ]}
        sessions={[
          {
            id: "work-1",
            agentId: "agent-1",
            title: "Ship release",
            task: "Ship release",
            acceptanceCriteria: "Release is live",
            runtimeKind: "pi",
            status: "completed",
            waitingQuestion: null,
            result: null,
            error: null,
            artifacts: [],
            approvals: [],
            conversationId: "conversation-1",
            messages: [
              {
                id: "message-user",
                role: "user",
                createdAt: "2026-09-03T01:02:03.000Z",
                parts: [{ type: "text", text: "Ship it" }],
              },
              {
                id: "message-assistant",
                role: "assistant",
                createdAt: "2026-09-03T01:02:04.000Z",
                parts: [
                  { type: "text", text: "Release shipped" },
                  {
                    type: "data-context-usage",
                    data: {
                      usedTokens: 64,
                      maxTokens: 100,
                      modelName: "gpt-test",
                      estimated: false,
                    },
                  },
                ],
              },
            ],
            sandbox: {
              id: "sandbox-1",
              name: "Workspace",
              kind: "docker",
              deploymentId: "deployment-1",
              running: true,
            },
          },
        ]}
        selectedWorkSessionId="work-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByRole("dialog", { name: "Files" })).toHaveTextContent(
      "Files surface",
    );
    expect(surfaceMocks.sandboxConsole).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filesOnly: true,
        terminalOnly: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("dialog", { name: "Terminal" })).toHaveTextContent(
      "Terminal surface",
    );
    expect(surfaceMocks.sandboxConsole).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filesOnly: false,
        terminalOnly: true,
      }),
    );

    const agentGroup = screen.getByRole("treeitem", { name: "Builder" });
    expect(agentGroup).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("treeitem", { name: "Ship release" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\d+ \/ \d+ runs/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    const reply = screen
      .getByText("Release shipped")
      .closest("[data-message-id]");
    expect(
      reply?.querySelector('[data-ui="assistant-reply-model"]'),
    ).toHaveTextContent("gpt-test");
    const replyTime = reply?.querySelector('time[data-ui="work-message-time"]');
    expect(replyTime).toHaveAttribute("dateTime", "2026-09-03T01:02:04.000Z");
    expect(screen.getByRole("meter", { name: "Context usage" })).toHaveProperty(
      "value",
      64,
    );
  });

  it("renders Work deltas before loading the final persisted reply", async () => {
    const finalSession = {
      id: "work-1",
      agentId: "agent-1",
      title: "Streaming response test",
      task: "Stream reply",
      acceptanceCriteria: null,
      runtimeKind: "pi",
      status: "idle",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      approvals: [],
      conversationId: "conversation-1",
      messages: [
        {
          id: "message-user",
          role: "user",
          parts: [{ type: "text", text: "Reply slowly" }],
        },
        {
          id: "message-assistant",
          role: "assistant",
          parts: [
            {
              type: "work-tool",
              toolCallId: "call-1",
              toolName: "read_file",
              deploymentName: "Local filesystem",
              originalToolName: "read_file",
              durationMs: 1200,
              input: "{}",
              output: "contents",
              isError: false,
              status: "completed" as const,
            },
            { type: "text", text: "Hello" },
            {
              type: "data-work-timing",
              data: {
                startedAt: 1_700_000_000_000,
                completedAt: 1_700_000_029_000,
                durationMs: 29_000,
                runtimeKind: "pi",
                modelName: "model-a",
              },
            },
          ],
        },
      ],
      sandbox: {
        id: "sandbox-1",
        name: "Workspace",
        kind: "docker",
        deploymentId: "deployment-1",
        running: true,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(finalSession), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", WorkEventSource);

    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [],
          },
        ]}
        sessions={[
          {
            ...finalSession,
            title: finalSession.task,
            status: "running",
            messages: finalSession.messages.slice(0, 1),
          },
        ]}
        selectedWorkSessionId="work-1"
      />,
    );

    expect(screen.queryByText("Generating")).not.toBeInTheDocument();
    expect(WorkEventSource.latest?.url).toBe(
      "/api/v1/work-sessions/work-1/events",
    );
    expect(
      screen.getByRole("treeitem", { name: "Stream reply" }),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    act(() =>
      WorkEventSource.latest?.emit("activity", {
        activities: [
          {
            id: "tool:call-1",
            type: "tool",
            status: "running",
            toolCallId: "call-1",
            toolName: "read_file",
            input: "{}",
          },
        ],
      }),
    );
    expect(screen.queryByText("Using read_file")).not.toBeInTheDocument();
    act(() =>
      WorkEventSource.latest?.emit("activity", {
        activities: [
          {
            id: "tool:call-1",
            type: "tool",
            status: "completed",
            toolCallId: "call-1",
            toolName: "read_file",
            deploymentName: "Local filesystem",
            originalToolName: "read_file",
            durationMs: 1200,
            input: "{}",
            output: "contents",
          },
        ],
      }),
    );

    act(() => WorkEventSource.latest?.emit("delta", { delta: "Hel" }));
    expect(await screen.findByText("Hel")).toBeInTheDocument();
    act(() => WorkEventSource.latest?.emit("delta", { delta: "lo" }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => WorkEventSource.latest?.emit("done", {}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText("Hello")).toHaveLength(1));
    expect(
      await screen.findByRole("treeitem", { name: "Streaming response test" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: "Stream reply" }),
    ).not.toBeInTheDocument();
    const completedProcess = document.querySelector('[data-ui="work-process"]');
    expect(completedProcess).not.toBeNull();
    expect(
      within(completedProcess as HTMLElement).getByRole("button", {
        name: /Processed/,
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      completedProcess?.querySelector('[data-ui="work-process-duration"]'),
    ).toHaveTextContent("29 s");
    expect(screen.getByText("Hello").closest("details")).toBeNull();
  });

  it("replaces a persisted turn stream without hiding identical replies from different turns", () => {
    vi.stubGlobal("EventSource", WorkEventSource);
    const startedAt = 1_700_000_000_000;
    const reply = (id: string, turnStart: number) => ({
      id,
      role: "assistant",
      parts: [
        { type: "text", text: "Same reply" },
        {
          type: "data-work-timing",
          data: { startedAt: turnStart, completedAt: turnStart + 1_000 },
        },
      ],
    });
    const session = {
      id: "work-1",
      agentId: "agent-1",
      title: "Repeated replies",
      task: "Reply again",
      acceptanceCriteria: null,
      runtimeKind: "dsh",
      status: "running",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      approvals: [],
      conversationId: "conversation-1",
      sandbox: null,
      messages: [
        reply("previous-reply", startedAt - 10_000),
        { id: "user", role: "user", parts: [{ type: "text", text: "Again" }] },
      ],
    };
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      selectedWorkSessionId: session.id,
      agents: [
        {
          id: "agent-1",
          name: "Builder",
          pinned: false,
          supportsWork: true,
          ready: true,
          runtimeKind: "dsh",
          sandboxes: [],
        },
      ],
    };
    const { rerender } = render(
      <WorkspaceWork {...props} sessions={[session]} />,
    );
    act(() =>
      WorkEventSource.latest?.emit("snapshot", {
        text: "Same reply",
        startedAt,
        active: true,
      }),
    );
    expect(screen.getAllByText("Same reply")).toHaveLength(2);

    rerender(
      <WorkspaceWork
        {...props}
        sessions={[
          {
            ...session,
            messages: [...session.messages, reply("current-reply", startedAt)],
          },
        ]}
      />,
    );
    expect(screen.getAllByText("Same reply")).toHaveLength(2);
    expect(
      document.querySelector('[data-message-id="work-stream"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-message-id="current-reply"]'),
    ).not.toBeNull();
  });

  it("refreshes a background title without keeping the reply busy and stops polling when naming finishes", async () => {
    vi.useFakeTimers();
    const session = {
      id: "work-1",
      agentId: "agent-1",
      title: "Reply slowly",
      task: "Reply slowly",
      titlePending: true,
      acceptanceCriteria: null,
      runtimeKind: "dsh",
      status: "idle",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      approvals: [],
      conversationId: "conversation-1",
      sandbox: null,
      messages: [
        {
          id: "assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Reply is ready" }],
        },
      ],
    };
    const fetchMock = vi.fn().mockImplementation(async () =>
      Response.json({
        ...session,
        title: "Generated title",
        titlePending: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        selectedWorkSessionId={session.id}
        sessions={[session]}
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "dsh",
            sandboxes: [],
          },
        ]}
      />,
    );
    expect(screen.getAllByText("Reply is ready")).toHaveLength(1);
    expect(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
    ).toBeEnabled();
    expect(
      document.querySelector('[data-message-id="work-stream"]'),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(
      screen.getByRole("treeitem", { name: "Generated title" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: "Reply slowly" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps a text-only completed Work reply free of an empty process group", () => {
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [],
          },
        ]}
        sessions={[
          {
            id: "work-text-only",
            agentId: "agent-1",
            title: "Text reply",
            task: "Say hello",
            acceptanceCriteria: null,
            runtimeKind: "pi",
            status: "idle",
            startedAt: "2026-09-03T01:00:00.000Z",
            completedAt: "2026-09-03T01:00:29.041Z",
            waitingQuestion: null,
            result: null,
            error: null,
            artifacts: [],
            approvals: [],
            conversationId: "conversation-text-only",
            messages: [
              {
                id: "message-user",
                role: "user",
                createdAt: "2026-09-03T01:00:00.000Z",
                parts: [{ type: "text", text: "Hello" }],
              },
              {
                id: "message-assistant",
                role: "assistant",
                parts: [
                  {
                    type: "work-runtime",
                    runtimeKind: "pi",
                    status: "completed" as const,
                  },
                  { type: "text", text: "Hi" },
                ],
                createdAt: "2026-09-03T01:00:29.041Z",
              },
            ],
            sandbox: {
              id: "sandbox-1",
              name: "Workspace",
              kind: "docker",
              deploymentId: "deployment-1",
              running: true,
            },
          },
        ]}
        selectedWorkSessionId="work-text-only"
      />,
    );

    const reply = screen.getByText("Hi").closest("[data-message-id]");
    expect(
      reply?.querySelector('[data-ui="work-message-duration"]'),
    ).toHaveTextContent("29 s");
    expect(reply).not.toHaveTextContent("Pi");
    expect(screen.queryByText("Processed")).not.toBeInTheDocument();
    expect(document.querySelector('[data-ui="work-process"]')).toBeNull();
  });

  it("renders live Work activities in arrival order", async () => {
    vi.stubGlobal("EventSource", WorkEventSource);
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [],
          },
        ]}
        sessions={[
          {
            id: "work-live-order",
            agentId: "agent-1",
            title: "Live order",
            task: "Trace order",
            acceptanceCriteria: null,
            runtimeKind: "claude-code",
            status: "running",
            waitingQuestion: null,
            result: null,
            error: null,
            artifacts: [],
            approvals: [],
            conversationId: "conversation-live-order",
            messages: [
              {
                id: "message-user",
                role: "user",
                parts: [{ type: "text", text: "Trace this" }],
              },
            ],
            sandbox: {
              id: "sandbox-1",
              name: "Workspace",
              kind: "docker",
              deploymentId: "deployment-1",
              running: true,
            },
          },
        ]}
        selectedWorkSessionId="work-live-order"
      />,
    );

    expect(screen.queryByText("Generating")).not.toBeInTheDocument();
    expect(screen.getByText("Processing")).toBeInTheDocument();
    act(() =>
      WorkEventSource.latest?.emit("activity", {
        activities: [
          {
            id: "runtime",
            type: "runtime",
            status: "running",
            runtimeKind: "claude-code",
          },
          {
            id: "reasoning:1",
            type: "reasoning",
            status: "completed",
            text: "thought before",
          },
          {
            id: "tool:call-1",
            type: "tool",
            status: "completed",
            toolCallId: "call-1",
            toolName: "live_tool",
            input: {},
          },
          {
            id: "runtime:final",
            type: "runtime",
            status: "failed",
            runtimeKind: "claude-code",
          },
        ],
      }),
    );

    const content =
      document.querySelector('[data-ui="work.transcript"]')?.textContent ?? "";
    const thought = content.indexOf("thought before");
    const tool = content.indexOf("live_tool");
    const terminalRuntime = content.indexOf("Claude Code");
    expect(
      [thought, tool, terminalRuntime].every((position) => position >= 0),
    ).toBe(true);
    expect([thought, tool, terminalRuntime]).toEqual([
      ...[thought, tool, terminalRuntime].sort((left, right) => left - right),
    ]);
  });

  it("keeps persisted Work process parts in execution order", () => {
    render(
      <WorkspaceWork
        slug="acme"
        workspaceId="workspace-1"
        agents={[
          {
            id: "agent-1",
            name: "Builder",
            pinned: false,
            supportsWork: true,
            ready: true,
            runtimeKind: "pi",
            sandboxes: [],
          },
        ]}
        sessions={[
          {
            id: "work-order",
            agentId: "agent-1",
            title: "Trace order",
            task: "Trace order",
            acceptanceCriteria: null,
            runtimeKind: "pi",
            status: "failed",
            waitingQuestion: null,
            result: null,
            error: "Stopped",
            artifacts: [],
            approvals: [],
            conversationId: "conversation-order",
            messages: [
              {
                id: "message-user",
                role: "user",
                parts: [{ type: "text", text: "Trace this" }],
              },
              {
                id: "message-assistant",
                role: "assistant",
                parts: [
                  { type: "reasoning", text: "plan-before" },
                  {
                    type: "work-tool",
                    toolCallId: "call-1",
                    toolName: "first_tool",
                    input: {},
                  },
                  {
                    type: "work-runtime",
                    runtimeKind: "claude-code",
                    status: "failed" as const,
                  },
                  { type: "reasoning", text: "plan-after" },
                  {
                    type: "work-tool",
                    toolCallId: "call-2",
                    toolName: "second_tool",
                    input: {},
                  },
                  { type: "text", text: "Done" },
                ],
              },
            ],
            sandbox: {
              id: "sandbox-1",
              name: "Workspace",
              kind: "docker",
              deploymentId: "deployment-1",
              running: true,
            },
          },
        ]}
        selectedWorkSessionId="work-order"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Stopped");
    const transcript = document.querySelector('[data-ui="work.transcript"]');
    const content = transcript?.textContent ?? "";
    const positions = [
      "plan-before",
      "first_tool",
      "Claude Code",
      "plan-after",
      "second_tool",
    ].map((marker) => content.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
  });

  it("keeps a Work reader above streaming output while scrolled back", () => {
    const session = {
      id: "work-scroll",
      agentId: "agent-1",
      title: "Scroll reply",
      task: "Scroll reply",
      acceptanceCriteria: null,
      runtimeKind: "pi",
      status: "idle",
      waitingQuestion: null,
      result: null,
      error: null,
      artifacts: [],
      approvals: [],
      conversationId: "conversation-scroll",
      messages: [
        {
          id: "message-user",
          role: "user" as const,
          parts: [{ type: "text", text: "Show the transcript" }],
        },
        {
          id: "message-assistant",
          role: "assistant" as const,
          parts: [{ type: "text", text: "First reply" }],
        },
      ],
      sandbox: {
        id: "sandbox-1",
        name: "Workspace",
        kind: "docker",
        deploymentId: "deployment-1",
        running: true,
      },
    };
    const props = {
      slug: "acme",
      workspaceId: "workspace-1",
      agents: [
        {
          id: "agent-1",
          name: "Builder",
          pinned: false,
          supportsWork: true,
          ready: true,
          runtimeKind: "pi",
          sandboxes: [],
        },
      ],
      selectedWorkSessionId: session.id,
    };
    const { rerender } = render(
      <WorkspaceWork {...props} sessions={[session]} />,
    );
    const viewport = document.querySelector(
      '[data-ui="work.transcript"]',
    ) as HTMLDivElement;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
    });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      viewport.scrollTop = top ?? 0;
    });
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    viewport.scrollTop = 120;

    fireEvent.scroll(viewport);
    scrollTo.mockClear();

    rerender(
      <WorkspaceWork
        {...props}
        sessions={[
          {
            ...session,
            messages: [
              ...session.messages,
              {
                id: "message-latest",
                role: "assistant" as const,
                parts: [{ type: "text", text: "Latest reply" }],
              },
            ],
          },
        ]}
      />,
    );
    expect(viewport.scrollTop).toBe(120);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("switches Knowledge task views without stacking all controls", () => {
    render(
      <WorkspaceKnowledge
        slug="acme"
        providers={[
          {
            id: "provider-1",
            name: "OpenAI",
            models: ["text-embedding-3-small"],
          },
        ]}
        sandboxes={[]}
        agents={[{ id: "agent-1", name: "Researcher" }]}
        initialBases={[
          {
            id: "base-1",
            name: "Handbook",
            providerId: "provider-1",
            providerName: "OpenAI",
            embeddingModel: "text-embedding-3-small",
            chunkSize: 1200,
            chunkOverlap: 200,
            topK: 6,
            threshold: 0.2,
            agentIds: [],
            documents: [],
          },
        ]}
      />,
    );

    expect(screen.getByText("No documents indexed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Recall test" }));
    expect(screen.getByText("Test semantic retrieval")).toBeInTheDocument();
    expect(screen.queryByText("No documents indexed")).not.toBeInTheDocument();
  });
});
