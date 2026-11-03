import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWork } from "@/components/dashboard/work/WorkspaceWork";
import type * as ConversationMessageModule from "@/components/dashboard/ConversationMessage";
import {
  finishWorkOutput,
  startWorkOutput,
  subscribeWorkOutput,
} from "@/lib/work/run-control";

const providers = [
  { id: "provider-1", name: "OpenAI", models: ["pinned-model"] },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/agents/actions", () => ({
  deleteAgentAction: vi.fn(),
  pinAgentAction: vi.fn(),
}));
vi.mock(
  "@/components/dashboard/ConversationMessage",
  async (importOriginal) => ({
    ...(await importOriginal<typeof ConversationMessageModule>()),
    AssistantMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
  }),
);
vi.mock("@/components/dashboard/sandboxes/SandboxConsole", () => ({
  SandboxConsole: ({
    deploymentId,
    rpcApiBase,
    terminalApiBase,
    readOnly,
  }: {
    deploymentId: string;
    rpcApiBase?: string;
    terminalApiBase?: string;
    readOnly?: boolean;
  }) => (
    <div
      data-testid="selected-workspace"
      data-rpc={rpcApiBase}
      data-terminal={terminalApiBase}
      data-read-only={readOnly}
    >
      {deploymentId}
    </div>
  ),
}));
const agent = {
  id: "worker",
  name: "Builder",
  pinned: false,
  supportsWork: true,
  ready: true,
  runtimeKind: "pi-sdk",
  sandboxes: [
    {
      id: "sandbox",
      name: "Work files",
      kind: "docker",
      deploymentId: "deployment",
      running: true,
      isDefault: true,
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
function show() {
  return render(
    <WorkspaceWork
      slug="team"
      workspaceId="workspace"
      providers={providers}
      agents={[agent]}
      sessions={[]}
      selectedWorkSessionId={null}
    />,
  );
}
type WorkSession = Parameters<typeof WorkspaceWork>[0]["sessions"][number];
const session: WorkSession = {
  id: "work",
  agentId: "worker",
  title: "Release",
  task: "Ship report",
  acceptanceCriteria: null,
  runtimeKind: "pi-sdk",
  agentRevisionId: "worker-revision-1",
  legacyRevisionUnresolved: false,
  readOnly: false,
  modelName: "pinned-model",
  status: "completed",
  waitingQuestion: null,
  result: null,
  error: null,
  artifacts: [],
  conversationId: "conversation",
  sandbox: agent.sandboxes[0] ?? null,
  messages: [],
};
function showSession(overrides: Partial<WorkSession> = {}) {
  const selected = { ...session, ...overrides };
  return render(
    <WorkspaceWork
      slug="team"
      workspaceId="workspace"
      providers={providers}
      agents={[{ ...agent, runtimeKind: selected.runtimeKind }]}
      sessions={[selected]}
      selectedWorkSessionId="work"
    />,
  );
}
describe("conversation workspace selection", () => {
  it("switches files and terminal together without falling back to Agent template files", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const props = {
      slug: "team",
      workspaceId: "workspace",
      providers,
      agents: [agent],
      sessions: [],
      selectedWorkSessionId: null,
    };
    const conversation = {
      id: "conversation-one",
      agentId: agent.id,
      source: null,
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      runtimeKind: undefined,
      modelName: null,
      messages: [],
      sandbox: {
        id: "isolated-one",
        name: "Conversation files",
        kind: "docker",
        running: true,
        deploymentId: "isolated-deployment-one",
      },
    };
    const view = render(
      <WorkspaceWork {...props} selectedConversation={conversation} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("selected-workspace")).toHaveTextContent(
      "isolated-deployment-one",
    );
    expect(screen.getByTestId("selected-workspace")).toHaveAttribute(
      "data-rpc",
      "/api/v1/agents/worker/conversations/conversation-one/sandbox/rpc",
    );
    expect(screen.getByTestId("selected-workspace")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toBeDisabled();
    view.rerender(
      <WorkspaceWork
        {...props}
        selectedConversation={{
          ...conversation,
          id: "conversation-two",
          sandbox: {
            ...conversation.sandbox,
            id: "isolated-two",
            deploymentId: "isolated-deployment-two",
          },
        }}
      />,
    );
    expect(screen.getByTestId("selected-workspace")).toHaveTextContent(
      "isolated-deployment-two",
    );
    expect(screen.getByTestId("selected-workspace")).toHaveAttribute(
      "data-terminal",
      "/api/v1/agents/worker/conversations/conversation-two/sandbox/terminal",
    );
    view.rerender(
      <WorkspaceWork
        {...props}
        selectedConversation={{
          ...conversation,
          sandbox: {
            ...conversation.sandbox,
            status: "copying",
            running: false,
          },
        }}
      />,
    );
    expect(screen.queryByTestId("selected-workspace")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Creating this conversation’s isolated workspace/),
    ).toBeInTheDocument();
    view.rerender(
      <WorkspaceWork
        {...props}
        selectedConversation={{
          ...conversation,
          id: "not-created",
          sandbox: null,
        }}
      />,
    );
    expect(screen.queryByTestId("selected-workspace")).not.toBeInTheDocument();
    expect(
      screen.getByText(/workspace will be created on its first execution/),
    ).toBeInTheDocument();
  });
});

describe("Work attachment transaction failures", () => {
  it("discards earlier uploads when a later attachment is rejected without submitting a task", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({ ok: true });
      if (url.includes("first.txt"))
        return Response.json({ id: "uploaded-first" });
      return Response.json(
        { error: "Attachment access denied" },
        { status: 403 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = show();
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
      { target: { value: "Prepare report" } },
    );
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Attachment picker missing");
    fireEvent.change(input, {
      target: {
        files: [
          new File(["first"], "first.txt"),
          new File(["second"], "second.txt"),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText("Attachment access denied");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/attachments/uploaded-first",
      { method: "DELETE" },
    );
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/v1/work-sessions"),
    ).toBe(false);
    expect(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
    ).toHaveValue("Prepare report");
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();
  });

  it("discards all staged attachments after task creation fails and keeps the draft retryable even when cleanup fails", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new TypeError("cleanup offline");
      if (url.includes("/attachments?")) return Response.json({ id: "staged" });
      return Response.json({ error: "Agent access revoked" }, { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = show();
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
      { target: { value: "  Keep my task  " } },
    );
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Attachment picker missing");
    fireEvent.change(input, {
      target: { files: [new File(["report"], "report.txt")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText("Agent access revoked");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work-sessions",
      expect.objectContaining({ body: expect.any(String) }),
    );
    const creation = fetchMock.mock.calls.find(
      ([url]) => url === "/api/v1/work-sessions",
    );
    expect(JSON.parse(String(creation?.[1]?.body))).toMatchObject({
      agentId: "worker",
      sandboxId: "sandbox",
      task: "Keep my task",
      attachmentIds: ["staged"],
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/attachments/staged", {
        method: "DELETE",
      }),
    );
    expect(
      screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      }),
    ).toHaveValue("  Keep my task  ");
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();
  });
  it("keeps a rejected follow-up draft and clears it only after the server accepts a retry", async () => {
    let inputAttempts = 0;
    const messages: WorkSession["messages"] = [
      {
        id: "accepted",
        role: "assistant",
        parts: [{ type: "text", text: "Follow-up accepted" }],
      },
    ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/input")) {
        inputAttempts += 1;
        return inputAttempts === 1
          ? Response.json({ error: "Work access denied" }, { status: 403 })
          : Response.json({ ok: true });
      }
      if (init?.method === "POST") return Response.json({ id: "uploaded" });
      return Response.json({ ...session, messages });
    });
    vi.stubGlobal("fetch", fetchMock);
    showSession();
    const input = screen.getByRole("combobox", {
      name: "What should the Agent accomplish?",
    });
    fireEvent.change(input, { target: { value: "Continue with review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText("Work access denied");
    expect(input).toHaveValue("Continue with review");
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work-sessions/work/input",
      expect.objectContaining({ body: '{"input":"Continue with review"}' }),
    );
  });

  it.each([`/compact ${"x".repeat(2000)}`, "/new"])(
    "rejects invalid Work command %s without losing the text",
    async (line) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      showSession();
      const input = screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      });
      fireEvent.change(input, { target: { value: line } });
      fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
      await waitFor(() => expect(input).toHaveValue(line));
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(false);
    },
  );

  it("forwards Pi extension commands and preserves the draft on runtime rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "Extension command rejected" }, { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    showSession();
    const input = screen.getByRole("combobox", {
      name: "What should the Agent accomplish?",
    });
    fireEvent.change(input, { target: { value: "/clear" } });
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText("Extension command rejected");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/agents/worker/conversations/conversation/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ line: "/clear" }),
      }),
    );
    expect(input).toHaveValue("/clear");
  });

  it.each([
    ["busy", "Wait for the current operation to finish."],
    ["Command forbidden", "Command forbidden"],
  ])(
    "keeps command text when the runtime returns %s",
    async (error, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ error }, { status: 409 })),
      );
      showSession();
      const input = screen.getByRole("combobox", {
        name: "What should the Agent accomplish?",
      });
      fireEvent.change(input, { target: { value: "/compact preserve paths" } });
      fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
      await screen.findByText(message);
      expect(input).toHaveValue("/compact preserve paths");
    },
  );

  it("recovers a running turn snapshot, ignores malformed events, and replaces streamed text with persisted completion", async () => {
    class WorkEvents {
      static latest: WorkEvents;
      handlers: Record<string, (event: MessageEvent) => void> = {};
      closed = false;
      constructor() {
        WorkEvents.latest = this;
      }
      addEventListener(type: string, handler: (event: MessageEvent) => void) {
        this.handlers[type] = handler;
      }
      close() {
        this.closed = true;
      }
      emit(type: string, value: unknown) {
        this.handlers[type]?.(
          new MessageEvent(type, { data: JSON.stringify(value) }),
        );
      }
    }
    vi.stubGlobal("EventSource", WorkEvents);
    const persisted = {
      ...session,
      messages: [
        {
          id: "answer",
          role: "assistant",
          parts: [{ type: "text", text: "Persisted final response" }],
        },
      ],
    };
    const fetchMock = vi.fn(async () => Response.json(persisted));
    vi.stubGlobal("fetch", fetchMock);
    showSession({ status: "running" });
    const events = WorkEvents.latest;
    act(() => {
      events.handlers.snapshot?.(
        new MessageEvent("snapshot", { data: "not json" }),
      );
      events.emit("delta", {});
      events.emit("activity", { activities: "bad" });
      events.emit("snapshot", {
        text: "Recovered partial",
        active: true,
        startedAt: Date.now() - 4000,
        runtimeKind: "pi-sdk",
        modelName: "live-model",
        activities: [
          {
            id: "reasoning",
            type: "reasoning",
            text: "Checking constraints",
            status: "running",
          },
        ],
      });
    });
    await screen.findByText("Recovered partial");
    expect(screen.getByText("Checking constraints")).toBeInTheDocument();
    act(() => events.emit("delta", { delta: " plus delta" }));
    await screen.findByText("Recovered partial plus delta");
    act(() => events.emit("snapshot", { text: "", done: true }));
    await screen.findByText("Persisted final response");
    expect(
      screen.queryByText("Recovered partial plus delta"),
    ).not.toBeInTheDocument();
    expect(events.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/work-sessions/work", {
      cache: "no-store",
    });
  });
});

describe("Work completion notification consumer", () => {
  it("keeps the live subscription until SSE done even when REST already reports a terminal turn", async () => {
    const workId = "notification-work";
    const startedAt = 1_000;
    const notifications = vi.fn();
    class BrowserNotification {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        notifications(title, options);
      }
    }
    // Only the network/browser boundary is replaced. Frames below come from
    // the production Work output lifecycle, not from the notification helper.
    class WorkEvents extends EventTarget {
      static latest: WorkEvents;
      closed = false;
      private unsubscribe: () => void;
      constructor() {
        super();
        WorkEvents.latest = this;
        const subscription = subscribeWorkOutput(workId, (event) => {
          this.dispatchEvent(
            new MessageEvent(event.type, {
              data: JSON.stringify(event.snapshot),
            }),
          );
        });
        this.unsubscribe = subscription.unsubscribe;
        queueMicrotask(() => {
          if (!this.closed) {
            this.dispatchEvent(
              new MessageEvent("snapshot", {
                data: JSON.stringify(subscription.snapshot),
              }),
            );
          }
        });
      }
      close() {
        this.closed = true;
        this.unsubscribe();
      }
    }
    vi.stubGlobal("EventSource", WorkEvents);
    vi.stubGlobal("Notification", BrowserNotification);
    vi.stubGlobal("isSecureContext", true);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.stubGlobal(
      "navigator",
      Object.create(navigator, {
        locks: {
          value: {
            request: async (
              _key: string,
              _options: unknown,
              callback: (lock: object) => void,
            ) => {
              callback({});
            },
          },
        },
      }),
    );
    window.localStorage.setItem(
      "toolplane:work-completion-enabled:workspace",
      "true",
    );
    const terminal = { ...session, id: workId, status: "idle" };
    const fetchMock = vi.fn(async () => Response.json(terminal));
    vi.stubGlobal("fetch", fetchMock);
    startWorkOutput(workId, { startedAt });
    const view = render(
      <WorkspaceWork
        slug="team"
        workspaceId="workspace"
        providers={providers}
        agents={[agent]}
        sessions={[{ ...terminal, status: "running" }]}
        selectedWorkSessionId={workId}
      />,
    );
    try {
      await act(async () => {});
      const events = WorkEvents.latest;
      // start's real consumer refresh observes the terminal DB status before
      // the coordinator's finally block emits its terminal SSE frame.
      act(() => startWorkOutput(workId, { startedAt }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await act(async () => {});
      expect(events.closed).toBe(false);
      expect(notifications).not.toHaveBeenCalled();

      await act(async () => finishWorkOutput(workId));
      await waitFor(() => expect(notifications).toHaveBeenCalledTimes(1));
      expect(
        window.localStorage.getItem(
          `toolplane:work-completion:workspace:${workId}`,
        ),
      ).toBe(String(startedAt));
      expect(notifications.mock.calls[0]?.[1]).not.toHaveProperty("body");
      expect(events.closed).toBe(true);
      act(() => finishWorkOutput(workId));
      expect(notifications).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      finishWorkOutput(workId);
      focus.mockRestore();
    }
  });
});
