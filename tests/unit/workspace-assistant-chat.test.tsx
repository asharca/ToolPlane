import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  estimatePromptTokens,
  WorkspaceAssistantChat,
} from "@/components/dashboard/chat/WorkspaceAssistantChat";
import type * as AssistantConversationModule from "@/components/dashboard/chat/AssistantConversation";

const mocks = vi.hoisted(() => ({
  conversation: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("@/components/dashboard/chat/AssistantConversation", () => ({
  AssistantConversation: (props: unknown) => {
    const rendered = mocks.conversation(props);
    if (rendered !== undefined) return rendered;
    const conversation = props as {
      onBranchChange?: (messageId: string) => void;
      onStartBranch?: (messageId: string) => void;
    };
    return (
      <div>
        Chat surface
        <div id="chat-message-a1">Active message</div>
        <button
          type="button"
          onClick={() => conversation.onBranchChange?.("a1")}
        >
          Test active branch
        </button>
        <button
          type="button"
          onClick={() => conversation.onStartBranch?.("a1")}
        >
          Test new branch
        </button>
      </div>
    );
  },
}));

function renderChat(
  branch?: Parameters<typeof WorkspaceAssistantChat>[0]["branch"],
  startCreating = false,
  providers: Parameters<typeof WorkspaceAssistantChat>[0]["providers"] = [
    {
      id: "provider-1",
      name: "Provider",
      format: "openai",
      models: ["model-1"],
    },
    {
      id: "provider-2",
      name: "Second provider",
      format: "anthropic",
      models: ["model-2"],
    },
  ],
  marketTemplate: Parameters<
    typeof WorkspaceAssistantChat
  >[0]["marketTemplate"] = null,
  marketTemplates: Parameters<
    typeof WorkspaceAssistantChat
  >[0]["marketTemplates"] = [],
  assistants: Parameters<typeof WorkspaceAssistantChat>[0]["assistants"] = [
    {
      id: "assistant-1",
      name: "Helper",
      pinned: false,
      revision: 1,
      systemPrompt: null,
      modelProviderId: "provider-1",
      model: "model-1",
      maxSteps: 8,
      providerName: "Provider",
      deploymentIds: [],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          createdAt: "2026-08-25T00:00:00.000Z",
          lastMessageAt: null,
        },
      ],
    },
  ],
  initialSidebarOpen = true,
  initialExpandedAssistants: Parameters<
    typeof WorkspaceAssistantChat
  >[0]["initialExpandedAssistants"] = {},
  initialGroupPreferences: Parameters<
    typeof WorkspaceAssistantChat
  >[0]["initialGroupPreferences"] = undefined,
) {
  return render(
    <WorkspaceAssistantChat
      assistants={assistants}
      deployments={[]}
      initialMessages={[]}
      providers={providers}
      reasoningAvailable
      selectedAssistantId="assistant-1"
      selectedThreadId="thread-1"
      initialExpandedAssistants={initialExpandedAssistants}
      initialGroupPreferences={initialGroupPreferences}
      initialSidebarOpen={initialSidebarOpen}
      slug="acme"
      startCreating={startCreating}
      marketTemplate={marketTemplate}
      marketTemplates={marketTemplates}
      workspaceId="workspace-1"
      branch={branch}
    />,
  );
}

function stubMutationFetch(fetchMock: typeof fetch) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("&running=1")
      ? Promise.resolve(Response.json({ runningThreadIds: [] }))
      : fetchMock(input, init),
  );
}

function dragResource(
  sourceName: string,
  targetName: string,
  position: "before" | "after" | "inside",
) {
  const source = screen.getByRole("treeitem", { name: sourceName });
  const target = screen.getByRole("treeitem", { name: targetName });
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
  };
  fireEvent.dragStart(source, { dataTransfer });
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    top: 0,
    height: 100,
  } as DOMRect);
  const event = createEvent.dragOver(target, { dataTransfer });
  Object.defineProperty(event, "clientY", {
    value: position === "before" ? 1 : position === "after" ? 99 : 50,
  });
  fireEvent(target, event);
  fireEvent.drop(target, { dataTransfer });
}

const sidebarAssistants: Parameters<
  typeof WorkspaceAssistantChat
>[0]["assistants"] = [1, 2, 3].map((id) => ({
  id: `assistant-${id}`,
  name: ["Match Alpha", "Hidden assistant", "Match Gamma"][id - 1],
  pinned: false,
  revision: 1,
  systemPrompt: null,
  modelProviderId: "provider-1",
  model: "model-1",
  maxSteps: 8,
  providerName: "Provider",
  deploymentIds: [],
  threads: (id === 1 ? [1, 2, 3] : [id + 3]).map((threadId) => ({
    id: `thread-${threadId}`,
    title: threadId === 2 ? "Hidden thread" : `Find thread ${threadId}`,
    createdAt: "2026-08-25T00:00:00.000Z",
    lastMessageAt: null,
  })),
}));

describe("WorkspaceAssistantChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom lacks Cookie Store; expire the actual document cookie between tests.
    document.cookie =
      "toolplane_assistant_chat_sidebar_workspace-1=; Path=/; Max-Age=0";
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom lacks Cookie Store; expire the actual document cookie between tests.
    document.cookie =
      "toolplane_assistant_chat_expanded_workspace-1=; Path=/; Max-Age=0";
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom lacks Cookie Store; expire the actual document cookie between tests.
    document.cookie =
      "toolplane_assistant_chat_group_preferences_workspace-1=; Path=/; Max-Age=0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.conversation.mockReset();
  });

  it("stops the newly admitted Run rather than the previous completed snapshot and reports a refused stop", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const stream: { controller?: ReadableStreamDefaultController<Uint8Array> } =
      {};
    const stopped: string[] = [];
    let admitted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/turns") && init?.method === "POST") {
          admitted = true;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream.controller = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"start","messageId":"new-answer"}\n\ndata: {"type":"text-start","id":"text"}\n\ndata: {"type":"text-delta","id":"text","delta":"New Run is active"}\n\n',
                  ),
                );
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "x-vercel-ai-ui-message-stream": "v1",
                "X-Chat-Run-Id": "new-run",
                "X-Chat-Cursor": "3",
              },
            },
          );
        }
        if (url.endsWith("/turns") && init?.method === "DELETE") {
          stopped.push(JSON.parse(String(init.body)).turnId);
          return Response.json({
            stopRequested: false,
            turnId: stopped.at(-1),
          });
        }
        if (url.includes("state=1"))
          return Response.json({
            runId: admitted ? "new-run" : "old-run",
            cursor: 3,
            status: admitted ? "pending" : "completed",
            phase: admitted ? "generating" : "completed",
            stopRequested: false,
            confirmations: [],
            messages: [
              {
                id: admitted ? "new-answer" : "old-answer",
                role: "assistant",
                parts: [
                  {
                    type: "text",
                    text: admitted
                      ? "New Run is active"
                      : "Previous completed Run",
                  },
                ],
              },
            ],
          });
        return Response.json({ revision: 1, templates: [] });
      }),
    );
    const view = render(
      <AssistantConversation
        threadId="thread-1"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    try {
      await screen.findByText("Previous completed Run");
      await userEvent.type(
        screen.getByRole("textbox", { name: "Send message" }),
        "Next intentional turn",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await screen.findByText("New Run is active");
      await userEvent.click(
        screen.getByRole("button", { name: "Request stop" }),
      );
      await waitFor(() => expect(stopped).toEqual(["new-run"]));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "did not accept a stop request",
      );
      expect(
        screen.queryByText("Stop requested · awaiting confirmation"),
      ).not.toBeInTheDocument();
    } finally {
      stream.controller?.close();
      view.unmount();
    }
  });

  it("stops another tab's pending Run restored by polling after this tab completed its own turn", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const intervals = vi.spyOn(globalThis, "setInterval");
    let admitted = false;
    let remotePending = false;
    let stopRequested = false;
    let acknowledged = false;
    const stopped: string[] = [];
    const submissions: string[] = [];
    const requests = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/turns") && init?.method === "POST") {
          admitted = true;
          submissions.push(String(init.body));
          const frames = [
            { type: "start", messageId: "answer-A" },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "Local A completed" },
            { type: "text-end", id: "text" },
            { type: "finish", finishReason: "stop" },
          ];
          return new Response(
            `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
            {
              headers: {
                "content-type": "text/event-stream",
                "x-vercel-ai-ui-message-stream": "v1",
                "X-Chat-Run-Id": "run-A",
                "X-Chat-Cursor": "5",
              },
            },
          );
        }
        if (url.endsWith("/turns") && init?.method === "DELETE") {
          stopped.push(JSON.parse(String(init.body)).turnId);
          stopRequested = true;
          return Response.json({ stopRequested: true, turnId: stopped.at(-1) });
        }
        if (url.includes("state=1")) {
          if (!admitted) return new Response(null, { status: 204 });
          return Response.json({
            runId: remotePending ? "run-B" : "run-A",
            cursor: remotePending ? 8 : 5,
            status: acknowledged
              ? "cancelled"
              : remotePending
                ? "pending"
                : "completed",
            phase: acknowledged
              ? "cancelled"
              : remotePending
                ? "generating"
                : "completed",
            stopRequested,
            confirmations: [],
            messages: [
              {
                id: remotePending ? "user-B" : "user-A",
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: remotePending
                      ? "Another tab's intentional request"
                      : "This tab's intentional request",
                  },
                ],
              },
              {
                id: remotePending ? "answer-B" : "answer-A",
                role: "assistant",
                parts: [
                  {
                    type: "text",
                    text: remotePending
                      ? "Other tab B is generating"
                      : "Local A completed",
                  },
                ],
              },
            ],
          });
        }
        if (url.endsWith("/templates"))
          return Response.json({ revision: 1, templates: [] });
        throw new Error(`Unexpected cross-tab lifecycle request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", requests);
    const view = render(
      <AssistantConversation
        threadId="thread-1"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    try {
      const send = screen.getByRole("button", { name: "Send message" });
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "Send message" }),
        ).toBeEnabled(),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Send message" }),
        "This tab's intentional request",
      );
      await userEvent.click(send);
      await screen.findByText("Local A completed");
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Request stop" }),
        ).not.toBeInTheDocument(),
      );
      remotePending = true;
      const poll = intervals.mock.calls.find(
        ([, delay]) => delay === 2000,
      )?.[0];
      if (typeof poll !== "function")
        throw new Error("Assistant snapshot polling was not registered");
      await act(async () => {
        poll();
      });
      await screen.findByText("Other tab B is generating");
      await userEvent.click(
        screen.getByRole("button", { name: "Request stop" }),
      );
      await waitFor(() => expect(stopped).toEqual(["run-B"]));
      expect(
        await screen.findByText(/Stop requested · awaiting confirmation/),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Local A completed")).toHaveLength(1);
      expect(screen.getAllByText("Other tab B is generating")).toHaveLength(1);
      expect(submissions).toHaveLength(1);
      expect(
        requests.mock.calls.some(([url]) =>
          String(url).includes("afterSequence="),
        ),
      ).toBe(false);
      acknowledged = true;
      await act(async () => {
        poll();
      });
      await waitFor(() => {
        expect(
          screen.queryByText(/Stop requested · awaiting confirmation/),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Request stop" }),
        ).not.toBeInTheDocument();
      });
    } finally {
      view.unmount();
      intervals.mockRestore();
    }
  });

  it("reconciles one canonical turn without duplicating optimistic users or streamed assistant IDs", async () => {
    const { reconcileAssistantMessages } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const messages: Parameters<typeof reconcileAssistantMessages>[0] = [
      {
        id: "history",
        role: "user",
        parts: [{ type: "text", text: "Earlier turn" }],
      },
      {
        id: "client-user",
        role: "user",
        parts: [{ type: "text", text: "Raw template args" }],
      },
      {
        id: "server-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Before" }],
      },
      {
        id: "server-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Before disconnect." }],
      },
    ];
    const saved: Parameters<typeof reconcileAssistantMessages>[1] = [
      {
        id: "server-user",
        role: "user",
        parts: [{ type: "text", text: "Expanded server prompt" }],
      },
      {
        id: "server-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Before" }],
      },
    ];
    const visible = reconcileAssistantMessages(
      messages,
      saved,
      "client-user",
      true,
    );
    expect(visible.map((message) => message.id)).toEqual([
      "history",
      "server-user",
      "server-assistant",
    ]);
    expect(visible[1].parts).toEqual([
      { type: "text", text: "Expanded server prompt" },
    ]);
    expect(visible[2].parts).toEqual([
      { type: "text", text: "Before disconnect." },
    ]);
    expect(
      reconcileAssistantMessages(visible, saved, "client-user", true),
    ).toEqual(visible);
    expect(
      reconcileAssistantMessages(visible, saved, "client-user")[2].parts,
    ).toEqual(saved[1].parts);
  });

  it("never presents an empty thread as disconnected while restoring or after a no-run response", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const deferred: { resolve?: (response: Response) => void } = {};
    const stateResponse = new Promise<Response>((resolve) => {
      deferred.resolve = resolve;
    });
    const requests = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("state=1")
        ? stateResponse
        : Response.json({ revision: 1, templates: [] }),
    );
    vi.stubGlobal("fetch", requests);
    render(
      <AssistantConversation
        threadId="thread-empty"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Disconnected/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect/ }),
    ).not.toBeInTheDocument();
    deferred.resolve?.(new Response(null, { status: 204 }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Send message" }),
      "A new intentional turn",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText(/Disconnected/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect/ }),
    ).not.toBeInTheDocument();
    expect(
      requests.mock.calls.every(([url]) => !String(url).endsWith("/turns")),
    ).toBe(true);
  });

  it("offers reconnection only after a saved pending run loses its subscription", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const requests = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("state=1"))
        return Response.json({
          runId: "run-pending",
          cursor: 7,
          status: "pending",
          phase: "running",
          stopRequested: false,
          messages: [],
          confirmations: [],
        });
      if (url.includes("/turns/stream?"))
        throw new Error("Subscription disconnected");
      return Response.json({ revision: 1, templates: [] });
    });
    vi.stubGlobal("fetch", requests);
    render(
      <AssistantConversation
        threadId="thread-pending"
        revision={1}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Reconnect/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Disconnected/)).toBeInTheDocument();
    expect(requests).toHaveBeenCalledWith(
      "/api/v1/chat/threads/thread-pending/turns/stream?runId=run-pending&afterSequence=7",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(
      requests.mock.calls.every(([url]) => !String(url).endsWith("/turns")),
    ).toBe(true);
  });

  it("restores unknown tool outcomes and readable text without submitting execution", async () => {
    const { AssistantConversation } = await vi.importActual<
      typeof AssistantConversationModule
    >("@/components/dashboard/chat/AssistantConversation");
    const requests = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("state=1")
        ? Response.json({
            runId: "run-1",
            cursor: 9,
            status: "failed",
            phase: "execution_unknown",
            stopRequested: false,
            messages: [
              {
                id: "answer",
                role: "assistant",
                parts: [
                  {
                    type: "data-prompt-template",
                    data: { unrecognized: true },
                  },
                  { type: "text", text: "Saved readable answer" },
                ],
              },
            ],
            confirmations: [
              {
                id: "confirm-1",
                toolName: "remote_write",
                input: { value: 1 },
                status: "execution_unknown",
              },
              {
                id: "confirmed-success",
                toolName: "remote_lookup",
                input: { query: "saved" },
                status: "succeeded",
                result: {
                  content: [
                    {
                      type: "text",
                      text: "Durably committed result before output publication",
                    },
                  ],
                },
              },
            ],
          })
        : Response.json({ revision: 1, templates: [] }),
    );
    vi.stubGlobal("fetch", requests);
    render(
      <AssistantConversation
        threadId="thread-1"
        revision={2}
        revisionId="revision-1"
        readOnly={false}
        initialMessages={[]}
        onConversationChanged={vi.fn()}
        onBranchChange={vi.fn()}
        onStartBranch={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Saved readable answer"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Outcome unknown");
    expect(
      screen.getByText(/Durably committed result before output publication/),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved tool result")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve this tool call" }),
    ).not.toBeInTheDocument();
    expect(
      requests.mock.calls.every(([url]) => !String(url).endsWith("/turns")),
    ).toBe(true);
  });

  it.each(["ambiguous transport failure", "runtime_not_ready"])(
    "reuses the exact admitted request and key after %s",
    async (failure) => {
      const { AssistantConversation } = await vi.importActual<
        typeof AssistantConversationModule
      >("@/components/dashboard/chat/AssistantConversation");
      const bodies: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith("/turns") && init?.method === "POST") {
            bodies.push(String(init.body));
            return failure === "runtime_not_ready"
              ? Response.json(
                  { error: "runtime_not_ready" },
                  { status: 503, headers: { "Retry-After": "5" } },
                )
              : new Response("Transport unavailable", { status: 503 });
          }
          if (String(input).includes("state=1"))
            return new Response(null, { status: 204 });
          return Response.json({ revision: 1, templates: [] });
        }),
      );
      render(
        <AssistantConversation
          threadId="thread-1"
          revision={1}
          revisionId="revision-1"
          readOnly={false}
          initialMessages={[]}
          onConversationChanged={vi.fn()}
          onBranchChange={vi.fn()}
          onStartBranch={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled(),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Send message" }),
        "Only one intentional turn",
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      const retryButton = await screen.findByRole("button", {
        name: "Retry the same submission",
      });
      if (failure === "runtime_not_ready") {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "platform runtime owner",
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
          "No new turn was started",
        );
        expect(
          screen.queryByRole("button", { name: /Reconnect/ }),
        ).not.toBeInTheDocument();
      }
      expect(bodies).toHaveLength(1);
      await userEvent.click(retryButton);
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[1]).toBe(bodies[0]);
      expect(JSON.parse(bodies[0]).idempotencyKey).toEqual(expect.any(String));
    },
  );

  it("shows running badges from server state and removes them when execution settles", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ runningThreadIds: ["thread-1"] }))
      .mockResolvedValueOnce(Response.json({ runningThreadIds: [] }));
    vi.stubGlobal("fetch", status);
    renderChat();
    expect(
      await screen.findByRole("status", { name: "Helper: Running" }),
    ).toBeVisible();
    expect(
      screen.getByRole("status", { name: "First thread: Running" }),
    ).toBeVisible();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => {
      expect(
        screen.queryByRole("status", { name: "Helper: Running" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("status", { name: "First thread: Running" }),
      ).not.toBeInTheDocument();
    });
  });

  it.each(["Close", "Cancel", "Escape", "Dismiss modal"])(
    "keeps assistant configuration mounted through the native exit after %s",
    async (method) => {
      renderChat();
      await userEvent.click(
        screen.getByRole("button", { name: "Assistant settings: Helper" }),
      );
      const panel = screen.getByRole("dialog", { name: "Assistant settings" });
      await userEvent.clear(
        within(panel).getByRole("textbox", { name: "Name" }),
      );
      await userEvent.type(
        within(panel).getByRole("textbox", { name: "Name" }),
        "Discarded",
      );
      if (method === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: method }));

      expect(panel).toBeInTheDocument();
      expect(panel.closest("[inert]")).not.toBeNull();
      await waitFor(() => expect(panel).not.toBeInTheDocument());
      await userEvent.click(
        screen.getByRole("button", { name: "Assistant settings: Helper" }),
      );
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Helper",
      );
    },
  );

  it("estimates mixed CJK and Latin system prompt tokens", () => {
    expect(estimatePromptTokens("你好 hello")).toBe(4);
    expect(estimatePromptTokens("   ")).toBe(0);
  });

  it("uses the sidebar header to add assistants and list existing conversations", async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole("button", { name: "List options" }));
    expect(
      screen.getByRole("button", { name: "Expand all" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse all" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "List options" }));
    await user.click(screen.getByRole("button", { name: "Add assistant" }));
    expect(
      screen.getByRole("dialog", { name: "Add assistant" }),
    ).toBeInTheDocument();
  });

  it("selects a thread from the assistant tree", async () => {
    const user = userEvent.setup();
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    const tree = screen.getByRole("tree", { name: "Assistants" });

    expect(
      within(tree).getByRole("treeitem", { name: /Match Alpha/ }),
    ).toBeInTheDocument();
    expect(
      within(tree).getByRole("treeitem", { name: /Find thread 1/ }),
    ).toBeInTheDocument();
    expect(
      within(tree).getByRole("treeitem", { name: /Find thread 3/ }),
    ).toBeInTheDocument();
    await user.click(
      within(tree).getByRole("treeitem", { name: /Find thread 3/ }),
    );
    expect(mocks.push).toHaveBeenCalledWith(
      "/app/acme/chat?assistant=assistant-1&thread=thread-3",
    );
  });

  it("closes the mobile assistant drawer after selecting a thread", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);

    await user.click(
      screen.getByRole("button", { name: "Show assistants and chats" }),
    );
    await user.click(screen.getByRole("treeitem", { name: /Find thread 3/ }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/app/acme/chat?assistant=assistant-1&thread=thread-3",
    );
    expect(
      screen.getByRole("button", { name: "Show assistants and chats" }),
    ).toBeInTheDocument();
  });

  it("keeps Assistant identity and pinned thread separate from Agent execution", async () => {
    renderChat();
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        revision: 1,
        onBranchChange: expect.any(Function),
        onStartBranch: expect.any(Function),
      }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Assistant settings: Helper" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP access" }));
    expect(
      screen.getByRole("spinbutton", { name: "Maximum tool-call rounds" }),
    ).toHaveAttribute("max", "1000");
  });

  it("edits, pins, and confirms deletion from the assistant resource menu", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            assistant: { id: "assistant-1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const confirmMock = vi.fn().mockReturnValue(false);
    stubMutationFetch(fetchMock);
    vi.stubGlobal("confirm", confirmMock);
    renderChat();

    await user.click(
      screen.getByRole("button", { name: "Actions for Helper" }),
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("dialog", { name: "Assistant settings" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(
      screen.getByRole("button", { name: "Actions for Helper" }),
    );
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/chat/assistants/assistant-1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned: true, expectedRevision: 1 }),
        },
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Helper" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmMock).toHaveBeenCalledWith(
      "Delete this assistant and all of its chats?",
    );
  });

  it("unpins an assistant from its resource menu", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          assistant: { id: "assistant-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    stubMutationFetch(fetchMock);
    renderChat(
      undefined,
      false,
      undefined,
      null,
      [],
      [
        {
          id: "assistant-1",
          name: "Helper",
          pinned: true,
          revision: 1,
          systemPrompt: null,
          modelProviderId: "provider-1",
          model: "model-1",
          maxSteps: 8,
          providerName: "Provider",
          deploymentIds: [],
          threads: [],
        },
      ],
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Helper" }),
    );
    await user.click(screen.getByRole("button", { name: "Unpin" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/chat/assistants/assistant-1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned: false, expectedRevision: 1 }),
        },
      ),
    );
  });

  it("offers deletion but rejects cross-Assistant drag rebinding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          thread: { id: "thread-1", assistantId: "assistant-2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    stubMutationFetch(fetchMock);
    renderChat(
      undefined,
      false,
      undefined,
      null,
      [],
      [
        {
          id: "assistant-1",
          name: "Helper",
          pinned: false,
          revision: 1,
          systemPrompt: null,
          modelProviderId: "provider-1",
          model: "model-1",
          maxSteps: 8,
          providerName: "Provider",
          deploymentIds: [],
          threads: [
            {
              id: "thread-1",
              title: "First thread",
              createdAt: "2026-08-25T00:00:00.000Z",
              lastMessageAt: null,
            },
          ],
        },
        {
          id: "assistant-2",
          name: "Writer",
          pinned: false,
          revision: 1,
          systemPrompt: null,
          modelProviderId: "provider-1",
          model: "model-1",
          maxSteps: 8,
          providerName: "Provider",
          deploymentIds: [],
          threads: [],
        },
      ],
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Actions for First thread" }),
    );
    const menu = document.querySelector(
      '[data-sidebar-resource-menu="thread:thread-1"]',
    ) as HTMLElement;
    expect(
      within(menu)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Delete chat"]);
    await user.keyboard("{Escape}");
    const source = screen.getByRole("treeitem", { name: /First thread/ });
    const target = screen.getByRole("treeitem", { name: /Writer/ });
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
    };
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      bottom: 132,
      left: 0,
      right: 200,
      width: 200,
      height: 32,
      toJSON: () => ({}),
    });
    fireEvent.dragStart(source, { dataTransfer });
    const over = createEvent.dragOver(target, { dataTransfer });
    Object.defineProperty(over, "clientY", { value: 116 });
    fireEvent(target, over);
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps editor values and shows the server error when saving fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Provider rejected the configuration",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    renderChat();
    await userEvent.click(
      screen.getByRole("button", { name: "Assistant settings: Helper" }),
    );

    const name = screen.getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Unsaved helper");
    await userEvent.click(
      screen.getByRole("button", { name: "System prompt" }),
    );
    const prompt = screen.getByRole("textbox", { name: "System prompt" });
    await userEvent.type(prompt, "Keep this prompt");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider rejected the configuration",
    );
    expect(name).toHaveValue("Unsaved helper");
    expect(prompt).toHaveValue("Keep this prompt");
  });

  it("generates a prompt and saves description and model parameters", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            prompt: "Find primary sources, cite them, and state uncertainty.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Keep page mounted" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    stubMutationFetch(fetchMock);
    renderChat();

    await userEvent.click(
      screen.getByRole("button", { name: "Assistant settings: Helper" }),
    );
    const description = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(description, {
      target: { value: "Finds primary sources." },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "System prompt" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate prompt" }),
    );

    expect(
      await screen.findByRole("textbox", { name: "System prompt" }),
    ).toHaveValue("Find primary sources, cite them, and state uncertainty.");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/chat/assistants/generate-prompt",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          name: "Helper",
          description: "Finds primary sources.",
          systemPrompt: null,
          modelProviderId: "provider-1",
          model: "model-1",
        }),
      },
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Preview system prompt" }),
    );
    expect(
      screen.getByText(
        "Find primary sources, cite them, and state uncertainty.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `Estimated tokens: ${estimatePromptTokens("Find primary sources, cite them, and state uncertainty.")}`,
      ),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Model parameters" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Use custom temperature" }),
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Temperature" }), {
      target: { value: "0.4" },
    });
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Use custom Top P" }),
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Top P" }), {
      target: { value: "0.8" },
    });
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Use custom maximum output tokens",
      }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Max output tokens" }),
      { target: { value: "2048" } },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add parameter" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Custom parameter name" }),
      { target: { value: "top_k" } },
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "Custom parameter type" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "number" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Value: top_k" }), {
      target: { value: "40" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/v1/chat/assistants/assistant-1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: 1,
            name: "Helper",
            description: "Finds primary sources.",
            systemPrompt:
              "Find primary sources, cite them, and state uncertainty.",
            modelProviderId: "provider-1",
            model: "model-1",
            modelParameters: {
              temperature: 0.4,
              topP: 0.8,
              maxOutputTokens: 2048,
              customParameters: [{ name: "top_k", type: "number", value: 40 }],
            },
            maxSteps: 8,
            mcpGrants: [],
          }),
        },
      ),
    );
  });

  it("steps through assistant creation without losing entered values", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Add assistant" }));
    const dialog = screen.getByRole("dialog", { name: "Add assistant" });

    expect(
      within(dialog).getByRole("navigation", {
        name: "Assistant configuration",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Basic" }),
    ).toHaveAttribute("aria-current", "step");

    const name = within(dialog).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Research helper" } });
    await user.click(within(dialog).getByRole("button", { name: "Next" }));

    expect(
      within(dialog).getByRole("button", { name: "System prompt" }),
    ).toHaveAttribute("aria-current", "step");
    const prompt = within(dialog).getByRole("textbox", {
      name: "System prompt",
    });
    fireEvent.change(prompt, { target: { value: "Use primary sources." } });
    await user.click(within(dialog).getByRole("button", { name: "Back" }));

    expect(name).toHaveValue("Research helper");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(prompt).toHaveValue("Use primary sources.");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));

    expect(
      within(dialog).getByRole("button", { name: "Model parameters" }),
    ).toHaveAttribute("aria-current", "step");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));

    expect(
      within(dialog).getByRole("button", { name: "MCP access" }),
    ).toHaveAttribute("aria-current", "step");
    expect(
      within(dialog).getByRole("spinbutton", {
        name: "Maximum tool-call rounds",
      }),
    ).toHaveValue(100);
    expect(
      within(dialog).getByRole("button", { name: "Create assistant" }),
    ).toBeInTheDocument();
  });

  it("requires a name and model before advancing assistant creation", async () => {
    const user = userEvent.setup();
    renderChat(undefined, false, []);
    await user.click(screen.getByRole("button", { name: "Add assistant" }));
    const dialog = screen.getByRole("dialog", { name: "Add assistant" });

    const next = within(dialog).getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name" }),
      "Draft helper",
    );
    expect(next).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Basic" }),
    ).toHaveAttribute("aria-current", "step");
  });

  it("shows unresolved market template MCP requirements before creation", async () => {
    const user = userEvent.setup();
    const template = {
      releaseId: "release-1",
      name: "Market researcher",
      summary: null,
      tags: [],
      systemPrompt: null,
      maxSteps: 8,
      providerFormat: null,
      model: null,
      deploymentIds: [],
      missingMcpNames: ["Search MCP"],
    };
    renderChat(undefined, false, undefined, null, [template]);
    await user.click(screen.getByRole("button", { name: "Add assistant" }));
    let dialog = screen.getByRole("dialog", { name: "Add assistant" });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Choose from assistant market",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Market researcher/ }),
    );
    dialog = await screen.findByRole("dialog", { name: "Add assistant" });
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Required MCP servers are not installed: Search MCP.",
    );
    expect(
      within(dialog).getByRole("link", { name: "Browse MCP market" }),
    ).toHaveAttribute("href", "/app/acme/market?type=mcp&target=assistant");
  });

  it("selects a market template and prefills the assistant creator", async () => {
    const user = userEvent.setup();
    const template = {
      releaseId: "release-1",
      name: "Market researcher",
      summary: "Researches primary sources.",
      tags: ["research"],
      systemPrompt: "Use primary sources.",
      maxSteps: 12,
      providerFormat: "anthropic",
      model: "model-2",
      deploymentIds: [],
    };
    renderChat(undefined, false, undefined, null, [template]);
    await user.click(screen.getByRole("button", { name: "Add assistant" }));
    let dialog = screen.getByRole("dialog", { name: "Add assistant" });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Choose from assistant market",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Market researcher/ }),
    );
    dialog = await screen.findByRole("dialog", { name: "Add assistant" });

    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Market researcher",
    );
    expect(
      within(dialog).getByRole("button", { name: "Model: model-2" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Market template selected" }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Edit system prompt" }),
    );
    expect(
      within(dialog).getByRole("textbox", { name: "System prompt" }),
    ).toHaveValue("Use primary sources.");
  });

  it("opens revision-scoped settings instead of mutating a pinned model in chat", async () => {
    renderChat();
    expect(
      screen.queryByRole("button", { name: "Model: model-1" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Assistant settings: Helper" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("always exposes branches and creates one from an assistant message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          branch: { activeMessageId: "draft-1", activated: true },
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    stubMutationFetch(fetchMock);
    renderChat({
      activeMessageId: "a1",
      branchCount: 1,
      navigation: [],
      nodes: [
        {
          id: "a1",
          parentId: null,
          role: "assistant",
          status: "success",
          modelId: "model-1",
          createdAt: "2026-08-25T00:00:00.000Z",
          preview: "Answer",
          active: true,
          awaitingInput: false,
        },
      ],
    });

    expect(
      screen.getByRole("button", { name: "Show conversation branches" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Test new branch" }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/chat/threads/thread-1/branches",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId: "a1" }),
        },
      );
      expect(mocks.refresh).toHaveBeenCalled();
    });
  });

  it("locates an active-path node without issuing a branch switch", async () => {
    const fetchMock = vi.fn();
    const scrollIntoView = vi.fn();
    stubMutationFetch(fetchMock);
    Element.prototype.scrollIntoView = scrollIntoView;
    renderChat({
      activeMessageId: "a1",
      branchCount: 1,
      navigation: [],
      nodes: [
        {
          id: "a1",
          parentId: null,
          role: "assistant",
          status: "success",
          modelId: "model-1",
          createdAt: "2026-08-25T00:00:00.000Z",
          preview: "Answer",
          active: true,
          awaitingInput: false,
        },
      ],
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Test active branch" }),
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["Test active branch", "Test new branch"])(
    "keeps the current conversation after %s is denied and permits retry",
    async (action) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { error: "Conversation access denied" },
            { status: 403 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ branch: { activated: true, activeMessageId: "a1" } }),
        );
      stubMutationFetch(fetchMock);
      renderChat();
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Conversation access denied",
      );
      expect(screen.getByText("Chat surface")).toBeInTheDocument();
      expect(mocks.refresh).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each(["New chat", "Pin"])(
    "reports a denied %s from the assistant menu",
    async (action) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "Workspace role cannot modify assistants" },
            { status: 403 },
          ),
        );
      stubMutationFetch(fetchMock);
      renderChat();
      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Helper" }),
      );
      await userEvent.click(screen.getByRole("button", { name: action }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Workspace role cannot modify assistants",
      );
      expect(screen.getByText("Chat surface")).toBeInTheDocument();
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );

  it("does not destroy an assistant after cancelled confirmation or rejected deletion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({}, { status: 403 }));
    stubMutationFetch(fetchMock);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderChat();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Helper" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      if (attempt === 0) expect(fetchMock).not.toHaveBeenCalled();
    }
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Chat surface")).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("preserves the last running state across authorization or network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ runningThreadIds: ["thread-1"] }))
      .mockResolvedValueOnce(
        Response.json({ error: "Forbidden" }, { status: 403 }),
      )
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json({ runningThreadIds: [] }));
    vi.stubGlobal("fetch", fetchMock);
    renderChat();
    await screen.findByRole("status", { name: "Helper: Running" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("status", { name: "Helper: Running" }),
    ).toBeInTheDocument();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(
      screen.getByRole("status", { name: "Helper: Running" }),
    ).toBeInTheDocument();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Helper: Running" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("creates, renames, collapses and deletes an assistant group without deleting its assistants", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "List options" }));
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(
      screen.getByRole("textbox", { name: "Group name" }),
      "Research",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByRole("treeitem", { name: "Research" }),
    ).toBeInTheDocument();
    const dragInto = (source: HTMLElement, target: HTMLElement) => {
      const dataTransfer = {
        effectAllowed: "none",
        dropEffect: "none",
        setData: vi.fn(),
      };
      fireEvent.dragStart(source, { dataTransfer });
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        top: 0,
        height: 100,
      } as DOMRect);
      const event = createEvent.dragOver(target, { dataTransfer });
      Object.defineProperty(event, "clientY", { value: 50 });
      fireEvent(target, event);
      fireEvent.drop(target, { dataTransfer });
    };
    dragInto(
      screen.getByRole("treeitem", { name: "Helper" }),
      screen.getByRole("treeitem", { name: "Research" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "Helper" })).toHaveAttribute(
        "aria-level",
        "2",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Actions for Research" }),
    );
    await user.click(screen.getByRole("button", { name: "Rename group" }));
    const name = screen.getByRole("textbox", { name: "Group name" });
    await user.clear(name);
    await user.type(name, "Writing");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("treeitem", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "List options" }));
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      screen.queryByRole("treeitem", { name: "Helper" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "List options" }));
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(
      screen.getByRole("treeitem", { name: "Helper" }),
    ).toBeInTheDocument();
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(
        screen.getByRole("button", { name: "Actions for Writing" }),
      );
      await user.click(screen.getByRole("button", { name: "Delete group" }));
      if (attempt === 0)
        expect(
          screen.getByRole("treeitem", { name: "Writing" }),
        ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("treeitem", { name: "Writing" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Helper" })).toHaveAttribute(
      "aria-level",
      "1",
    );
    confirm.mockRestore();
  });

  it("persists thread order through resource moves without changing the selected conversation", async () => {
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    const thread = screen.getByRole("treeitem", { name: "Find thread 3" });
    fireEvent.keyDown(thread, { key: "ArrowUp", altKey: true, shiftKey: true });
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(
          "toolplane:assistant-chat-groups:workspace-1",
        ) || "{}",
      );
      expect(saved.conversationOrder?.["assistant-1"]).toEqual([
        "thread-1",
        "thread-3",
        "thread-2",
      ]);
    });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByText("Chat surface")).toBeInTheDocument();
  });

  it("does not archive a thread if confirmation is cancelled or the server denies deletion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({}, { status: 403 }));
    stubMutationFetch(fetchMock);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderChat();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await userEvent.click(
        screen.getByRole("button", { name: "Actions for First thread" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Delete chat" }),
      );
      if (attempt === 0) expect(fetchMock).not.toHaveBeenCalled();
    }
    await screen.findByRole("alert");
    expect(
      screen.getByRole("treeitem", { name: "First thread" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/chat/threads/thread-1", {
      method: "DELETE",
    });
    confirm.mockRestore();
  });
  it.each(["before", "after"] as const)(
    "persists assistant %s ordering without moving their conversations",
    async (position) => {
      renderChat(undefined, false, undefined, null, [], sidebarAssistants);
      dragResource("Match Gamma", "Match Alpha", position);
      await waitFor(() => {
        const saved = JSON.parse(
          window.localStorage.getItem(
            "toolplane:assistant-chat-groups:workspace-1",
          ) || "{}",
        );
        expect(saved.entityOrder).toEqual(
          position === "before"
            ? ["assistant-3", "assistant-1", "assistant-2"]
            : ["assistant-1", "assistant-3", "assistant-2"],
        );
      });
      expect(
        screen.getByRole("treeitem", { name: "Find thread 1" }),
      ).toBeInTheDocument();
      expect(mocks.push).not.toHaveBeenCalled();
    },
  );

  it("moves a thread to the end of its owning assistant without a server mutation", async () => {
    const fetchMock = vi.fn();
    stubMutationFetch(fetchMock);
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    dragResource("Find thread 1", "Match Alpha", "inside");
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(
          "toolplane:assistant-chat-groups:workspace-1",
        ) || "{}",
      );
      expect(saved.conversationOrder?.["assistant-1"]).toEqual([
        "thread-2",
        "thread-3",
        "thread-1",
      ]);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends a thread rebind request on cross-Assistant drops", async () => {
    const fetchMock = vi.fn();
    stubMutationFetch(fetchMock);
    renderChat(undefined, false, undefined, null, [], sidebarAssistants);
    dragResource("Find thread 1", "Match Gamma", "inside");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("reorders groups, moves assistants back to ungrouped, and persists both changes", async () => {
    renderChat(
      undefined,
      false,
      undefined,
      null,
      [],
      sidebarAssistants,
      true,
      {},
      {
        groups: [
          { id: "a", name: "Alpha group" },
          { id: "b", name: "Beta group" },
        ],
        assignments: { "assistant-1": "a" },
        collapsed: {},
      },
    );
    dragResource("Beta group", "Alpha group", "before");
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(
          "toolplane:assistant-chat-groups:workspace-1",
        ) || "{}",
      );
      expect(saved.groups.map((group: { id: string }) => group.id)).toEqual([
        "b",
        "a",
      ]);
    });
    dragResource("Match Alpha", "Ungrouped", "inside");
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(
          "toolplane:assistant-chat-groups:workspace-1",
        ) || "{}",
      );
      expect(saved.assignments["assistant-1"]).toBeUndefined();
    });
    expect(
      screen.getByRole("treeitem", { name: "Match Alpha" }),
    ).toHaveAttribute("aria-level", "2");
  });
});
