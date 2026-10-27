import { assertDefined } from "../assert-defined";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { AgentConversation } from "@/components/dashboard/agents/AgentConversation";
import type { AgentUIMessage } from "@/lib/agents/message-segments";

const chatMocks = vi.hoisted(() => ({
  useChat: vi.fn(),
  sendMessage: vi.fn(),
  regenerate: vi.fn(),
  setMessages: vi.fn(),
  stop: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { id?: string }) => ({
    ...chatMocks.useChat(options),
    id: options.id ?? "test-chat",
  }),
}));

vi.mock("@assistant-ui/react-streamdown", async () => {
  const assistantUi = await vi.importActual<
    typeof import("@assistant-ui/react")
  >("@assistant-ui/react");
  return {
    StreamdownTextPrimitive: () => {
      const part = assistantUi.useMessagePartText();
      return <div>{part.text}</div>;
    },
  };
});

vi.mock("streamdown", () => ({
  defaultRehypePlugins: {},
  defaultRemarkPlugins: {},
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@streamdown/code", () => ({ code: {} }));

const initialMessages: AgentUIMessage[] = [
  { id: "m1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
];

type ConversationProps = ComponentProps<typeof AgentConversation>;

function renderConversation(overrides: Partial<ConversationProps> = {}) {
  const ensureConversation =
    overrides.ensureConversation ??
    vi.fn().mockResolvedValue(overrides.activeConversationId ?? "conv-new");
  const props: ConversationProps = {
    activeConversationId: "conv-1",
    agentId: "agent-1",
    agentName: "Test agent",
    creatingConversation: false,
    ensureConversation,
    initialMessages,
    ready: true,
    runtimeKind: "pi-sdk",
    ...overrides,
  };
  return {
    ensureConversation,
    props,
    ...render(<AgentConversation {...props} />),
  };
}

describe("AgentConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetch.mockReset();
    window.localStorage.clear();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    apiMocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ conversationId: "conv-new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", apiMocks.fetch);
    chatMocks.useChat.mockReturnValue({
      messages: initialMessages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: "ready",
      error: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explicitly stops the server turn without treating unmount as cancellation", async () => {
    chatMocks.useChat.mockReturnValue({
      ...chatMocks.useChat(),
      status: "streaming",
    });
    apiMocks.fetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "X-Chat-Turn-Id": "server-turn-1",
        },
      }),
    );
    const view = renderConversation({
      serverManaged: true,
      apiPath: "/api/v1/chat/threads/conv-1/turns",
      includeConversationIdInBody: false,
    });
    const { transport } = assertDefined(chatMocks.useChat.mock.calls.at(-1))[0];
    const stream = await transport.sendMessages({
      chatId: "conv-1",
      trigger: "submit-message",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Work on the server" }],
        },
      ],
      abortSignal: new AbortController().signal,
    });
    await stream.cancel();
    apiMocks.fetch.mockResolvedValueOnce(Response.json({ cancelled: true }));
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() =>
      expect(apiMocks.fetch).toHaveBeenCalledWith(
        "/api/v1/chat/threads/conv-1/turns",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ turnId: "server-turn-1" }),
        },
      ),
    );
    expect(chatMocks.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(
      apiMocks.fetch.mock.calls.filter(
        ([, options]) => options?.method === "DELETE",
      ),
    ).toHaveLength(1);
  });

  it("syncs local messages when the active conversation changes", async () => {
    const firstMessages: AgentUIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "first" }] },
    ];
    const secondMessages: AgentUIMessage[] = [
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "second" }],
      },
    ];
    const { props, rerender } = renderConversation({
      activeConversationId: "conv-1",
      initialMessages: firstMessages,
    });

    rerender(
      <AgentConversation
        {...props}
        activeConversationId="conv-2"
        initialMessages={secondMessages}
      />,
    );

    await waitFor(() =>
      expect(chatMocks.setMessages).toHaveBeenCalledWith(secondMessages),
    );
  });

  it("creates a conversation before the first message is sent", async () => {
    const ensureConversation = vi.fn().mockResolvedValue("conv-new");
    renderConversation({
      activeConversationId: null,
      ensureConversation,
      initialMessages: [],
    });

    await userEvent.type(
      screen.getByPlaceholderText("Message this agent"),
      "Start here",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));

    await waitFor(() => {
      expect(ensureConversation).toHaveBeenCalledOnce();
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          parts: [{ type: "text", text: "Start here" }],
        }),
        expect.objectContaining({ body: { conversationId: "conv-new" } }),
      );
    });
  });

  it("enables attachments only for configured native uploads", async () => {
    const { props, rerender } = renderConversation();

    const toolsButton = screen.getByRole("button", { name: "Open tools" });
    expect(toolsButton).toBeEnabled();
    await userEvent.click(toolsButton);
    expect(
      screen.getByRole("menuitem", { name: /Add attachment/ }),
    ).toBeDisabled();

    rerender(
      <AgentConversation
        {...props}
        attachmentUploadUrl="/api/v1/workspaces/workspace-1/attachments"
      />,
    );

    expect(
      screen.getByRole("menuitem", { name: /Add attachment/ }),
    ).toBeEnabled();
  });

  it("uploads a native attachment as an internal file part", async () => {
    apiMocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "attachment-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          url: "/api/v1/attachments/attachment-1",
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    renderConversation({
      attachmentUploadUrl: "/api/v1/workspaces/workspace-1/attachments",
      runtimeKind: "pi-sdk",
    });

    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Add attachment/ }),
    );
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(
      assertDefined(fileInput),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    await userEvent.type(
      screen.getByPlaceholderText("Message this agent"),
      "Read this",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));

    await waitFor(() =>
      expect(apiMocks.fetch).toHaveBeenCalledWith(
        "/api/v1/workspaces/workspace-1/attachments?filename=notes.txt",
        expect.objectContaining({ method: "POST", body: expect.any(File) }),
      ),
    );
    await waitFor(() =>
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "file",
              filename: "notes.txt",
              mediaType: "text/plain",
              url: "/api/v1/attachments/attachment-1",
            }),
          ]),
        }),
        expect.objectContaining({ body: { conversationId: "conv-1" } }),
      ),
    );
  });

  it("restores the composer when a native attachment upload fails", async () => {
    apiMocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Attachment storage is unavailable.",
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    renderConversation({
      attachmentUploadUrl: "/api/v1/workspaces/workspace-1/attachments",
    });

    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Add attachment/ }),
    );
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(
      assertDefined(fileInput),
      new File(["one"], "one.txt", { type: "text/plain" }),
    );
    const composer = screen.getByPlaceholderText("Message this agent");
    await userEvent.type(composer, "Keep the file and text");
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Attachment storage is unavailable.",
    );
    expect(composer).toHaveValue("Keep the file and text");
    expect(screen.getByText("one.txt")).toBeInTheDocument();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("stops a streaming response", async () => {
    const streamingMessages: AgentUIMessage[] = [
      { id: "m-streaming", role: "assistant", parts: [] },
    ];
    chatMocks.useChat.mockReturnValue({
      messages: streamingMessages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
      addToolResult: vi.fn(),
      addToolOutput: vi.fn(),
      addToolApprovalResponse: vi.fn(),
      status: "streaming",
      error: undefined,
    });
    renderConversation({ initialMessages: streamingMessages });

    await userEvent.click(
      screen.getByRole("button", { name: "Stop generating" }),
    );

    expect(chatMocks.stop).toHaveBeenCalledOnce();
  });

  it("offers runtime slash commands and sends them through the command endpoint", async () => {
    const user = userEvent.setup();
    const onConversationChanged = vi.fn();
    renderConversation({ runtimeKind: "pi-sdk", onConversationChanged });

    const input = screen.getByPlaceholderText("Message this agent");
    await user.type(input, "/");
    const menu = await screen.findByRole("menu", { name: "Tools" });
    expect(
      within(menu).getByRole("menuitem", { name: /compact/ }),
    ).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /compact/ }));
    expect(input).toHaveValue("/compact ");

    await user.type(input, "preserve paths");
    await user.click(screen.getByRole("button", { name: "Send prompt" }));

    await waitFor(() =>
      expect(apiMocks.fetch).toHaveBeenCalledWith(
        "/api/v1/agents/agent-1/conversations/conv-1/commands",
        expect.objectContaining({ body: '{"line":"/compact preserve paths"}' }),
      ),
    );
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    expect(onConversationChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["notFound", "Conversation not found."],
    ["Forbidden command execution", "Forbidden command execution"],
    [null, "The runtime command failed. The input has been kept."],
  ])(
    "restores the command draft when the server rejects %s",
    async (error, message) => {
      apiMocks.fetch.mockResolvedValueOnce(
        Response.json({ error }, { status: 403 }),
      );
      const onConversationChanged = vi.fn();
      renderConversation({ runtimeKind: "pi-sdk", onConversationChanged });
      const input = screen.getByPlaceholderText("Message this agent");
      await userEvent.type(input, "/compact preserve files");
      await userEvent.click(
        screen.getByRole("button", { name: "Send prompt" }),
      );
      expect(await screen.findByText(message)).toBeInTheDocument();
      await waitFor(() => expect(input).toHaveValue("/compact preserve files"));
      expect(chatMocks.sendMessage).not.toHaveBeenCalled();
      expect(onConversationChanged).not.toHaveBeenCalled();
    },
  );

  it.each(["dsh", "pi", "claude-code", null])(
    "keeps retired %s history read-only",
    async (runtimeKind) => {
      renderConversation({ runtimeKind });
      expect(screen.getByText("hello")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Message this agent")).toBeDisabled();
      await userEvent.click(
        screen.getByRole("button", { name: "Send prompt" }),
      );
      expect(apiMocks.fetch).not.toHaveBeenCalled();
      expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("retains a normal message when conversation creation fails and sends it on retry", async () => {
    const ensureConversation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Forbidden"))
      .mockResolvedValueOnce("conv-new");
    renderConversation({ activeConversationId: null, ensureConversation });
    const input = screen.getByPlaceholderText("Message this agent");
    await userEvent.type(input, "Keep this draft");
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() => expect(input).toHaveValue("Keep this draft"));
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() =>
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "Keep this draft" }),
          ]),
        }),
        expect.objectContaining({
          body: expect.objectContaining({ conversationId: "conv-new" }),
        }),
      ),
    );
  });

  it("reports server cancellation denial without stopping the local observer", async () => {
    chatMocks.useChat.mockReturnValue({
      ...chatMocks.useChat(),
      status: "streaming",
    });
    apiMocks.fetch.mockResolvedValueOnce(
      new Response("data: [DONE]\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "X-Chat-Turn-Id": "turn-denied",
        },
      }),
    );
    renderConversation({
      serverManaged: true,
      apiPath: "/api/v1/chat/threads/conv-1/turns",
      includeConversationIdInBody: false,
    });
    const { transport } = assertDefined(chatMocks.useChat.mock.calls.at(-1))[0];
    const stream = await transport.sendMessages({
      chatId: "conv-1",
      trigger: "submit-message",
      messages: [
        {
          id: "user-denied",
          role: "user",
          parts: [{ type: "text", text: "Continue" }],
        },
      ],
      abortSignal: new AbortController().signal,
    });
    await stream.cancel();
    apiMocks.fetch.mockResolvedValueOnce(
      Response.json(
        { error: "Not allowed to cancel this turn" },
        { status: 403 },
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    await screen.findByText("Not allowed to cancel this turn");
    expect(chatMocks.stop).not.toHaveBeenCalled();
  });
  it("enforces attachment count, lets users remove a file and accepts a replacement", async () => {
    renderConversation({
      attachmentUploadUrl: "/api/v1/workspaces/workspace/attachments",
    });
    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Add attachment/ }),
    );
    const input = assertDefined(
      document.querySelector<HTMLInputElement>('input[type="file"]'),
    );
    const files = Array.from(
      { length: 6 },
      (_, index) => new File(["data"], `file-${index}.txt`),
    );
    await userEvent.upload(input, files);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can attach up to 5 files.",
    );
    expect(screen.queryByText("file-5.txt")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove file-0.txt" }),
    );
    expect(screen.queryByText("file-0.txt")).not.toBeInTheDocument();
    await userEvent.upload(input, new File(["replacement"], "replacement.txt"));
    expect(await screen.findByText("replacement.txt")).toBeInTheDocument();
    expect(apiMocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps an unresolved native session read-only", async () => {
    renderConversation({ readOnly: true, runtimeKind: "pi-sdk" });
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message this agent")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(apiMocks.fetch).not.toHaveBeenCalled();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("retains attachments when runtime commands reject attached input locally", async () => {
    renderConversation({
      runtimeKind: "pi-sdk",
      attachmentUploadUrl: "/api/v1/workspaces/workspace/attachments",
    });
    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Add attachment/ }),
    );
    await userEvent.upload(
      assertDefined(
        document.querySelector<HTMLInputElement>('input[type="file"]'),
      ),
      new File(["notes"], "notes.txt"),
    );
    await userEvent.type(
      screen.getByPlaceholderText("Message this agent"),
      "/compact",
    );
    apiMocks.fetch.mockResolvedValueOnce(
      Response.json({ url: "/api/v1/attachments/notes" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText(
      "Send attachments and references in a regular message, separately from commands.",
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Message this agent")).toHaveValue(
        "/compact",
      ),
    );
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires an explicit tool approval decision approved=%s",
    async (approved) => {
      const addToolApprovalResponse = vi.fn();
      const messages = [
        {
          id: "approval-message",
          role: "assistant",
          parts: [
            {
              type: "tool-delete_file",
              toolCallId: "delete-call",
              state: "approval-requested",
              input: { path: "important.md" },
              approval: { id: "approval-id" },
            },
          ],
        },
      ] as AgentUIMessage[];
      chatMocks.useChat.mockReturnValue({
        ...chatMocks.useChat(),
        messages,
        addToolApprovalResponse,
      });
      renderConversation({ initialMessages: messages });
      await userEvent.click(
        screen.getByRole("button", { name: approved ? "Allow once" : "Deny" }),
      );
      await waitFor(() =>
        expect(addToolApprovalResponse).toHaveBeenCalledWith(
          expect.objectContaining({ id: "approval-id", approved }),
        ),
      );
      expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("shows a regeneration creation error without losing persisted history", async () => {
    renderConversation({
      activeConversationId: null,
      ensureConversation: vi.fn().mockRejectedValue(new Error("Forbidden")),
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Retry response" }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(chatMocks.regenerate).not.toHaveBeenCalled();
  });
});
