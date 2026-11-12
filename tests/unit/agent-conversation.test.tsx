import { assertDefined } from "../assert-defined";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

const fetchResponses = new Map<string, Response>();

function mockFetchResponse(method: string, url: string, response: Response) {
  fetchResponses.set(`${method} ${url}`, response);
}

function requestMethod(input: RequestInfo | URL, options?: RequestInit) {
  return (
    options?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function expectNoMutations() {
  expect(
    apiMocks.fetch.mock.calls.filter(
      ([input, options]) =>
        !["GET", "HEAD"].includes(requestMethod(input, options)),
    ),
  ).toHaveLength(0);
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: unknown) => chatMocks.useChat(options),
}));

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
    fetchResponses.clear();
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
    apiMocks.fetch.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = requestMethod(input, options);
        const response = fetchResponses.get(`${method} ${url}`);
        if (response) return response.clone();
        // Feedback reads must never consume a command, upload, or turn response.
        if (
          method === "GET" &&
          /^\/api\/v1\/agents\/agent-1\/conversations\/[^/]+\/messages\/[^/]+\/feedback$/.test(
            url,
          )
        ) {
          return Response.json({ data: null });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", apiMocks.fetch);
    chatMocks.useChat.mockReturnValue({
      messages: initialMessages,
      sendMessage: chatMocks.sendMessage,
      setMessages: chatMocks.setMessages,
      stop: chatMocks.stop,
      regenerate: chatMocks.regenerate,
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
    mockFetchResponse(
      "POST",
      "/api/v1/chat/threads/conv-1/turns",
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
    mockFetchResponse(
      "DELETE",
      "/api/v1/chat/threads/conv-1/turns",
      Response.json({ cancelled: true }),
    );
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

  it("clears the submitted draft immediately and keeps the next draft when execution ends", async () => {
    const { promise: pendingSend, resolve: finishSend } =
      Promise.withResolvers<void>();
    chatMocks.sendMessage.mockReturnValueOnce(pendingSend);
    renderConversation();
    const input = screen.getByPlaceholderText("Message this agent");
    await userEvent.type(input, "Run this request");
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));

    expect(input).toHaveValue("");
    await waitFor(() => expect(chatMocks.sendMessage).toHaveBeenCalledOnce());
    await userEvent.type(input, "Draft the next request");
    await act(async () => finishSend());

    expect(input).toHaveValue("Draft the next request");
    expect(chatMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [{ type: "text", text: "Run this request" }],
      }),
      expect.any(Object),
    );
  });

  it("merges a rejected submission back without overwriting a newer draft", async () => {
    const { promise: pendingCreation, reject: rejectCreation } =
      Promise.withResolvers<string>();
    const ensureConversation = vi.fn().mockReturnValue(pendingCreation);
    renderConversation({ activeConversationId: null, ensureConversation });
    const input = screen.getByPlaceholderText("Message this agent");
    await userEvent.type(input, "Keep the rejected request");
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(input).toHaveValue("");
    await userEvent.type(input, "Newer draft");
    await act(async () => {
      rejectCreation(new Error("Forbidden"));
    });

    await waitFor(() =>
      expect(input).toHaveValue("Keep the rejected request\nNewer draft"),
    );
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("replaces an edited user turn through AI SDK while retaining its files and the next draft", async () => {
    const file = {
      type: "file" as const,
      filename: "notes.txt",
      mediaType: "text/plain",
      url: "/api/v1/attachments/notes",
    };
    const messages: AgentUIMessage[] = [
      {
        id: "user-edit",
        role: "user",
        parts: [{ type: "text", text: "Original request" }, file],
      },
      ...initialMessages,
    ];
    chatMocks.useChat.mockReturnValue({ ...chatMocks.useChat(), messages });
    renderConversation({ initialMessages: messages, allowEdit: true });
    const composer = screen.getByPlaceholderText("Message this agent");
    await userEvent.type(composer, "Next draft");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const message = within(
      assertDefined(document.getElementById("chat-message-user-edit")),
    );
    const cancelledEditor = message.getByRole("textbox");
    await userEvent.clear(cancelledEditor);
    await userEvent.type(cancelledEditor, "Discard this edit");
    await userEvent.click(message.getByRole("button", { name: "Cancel" }));
    expect(message.getByText("Original request")).toBeInTheDocument();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue("Next draft");
    await userEvent.click(message.getByRole("button", { name: "Edit" }));
    const editor = message.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Revised request");
    await userEvent.click(message.getByRole("button", { name: "Send prompt" }));

    await waitFor(() =>
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          messageId: "user-edit",
          parts: [{ type: "text", text: "Revised request" }, file],
        }),
        expect.objectContaining({ body: { conversationId: "conv-1" } }),
      ),
    );
    expect(composer).toHaveValue("Next draft");
    expect(message.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("regenerates the original AI SDK message when an expanded response is selected", async () => {
    const messages: AgentUIMessage[] = [
      {
        id: "response-original",
        role: "assistant",
        parts: [
          {
            type: "data-assistant-messages",
            data: {
              segments: [
                { id: "first", text: "First response" },
                { id: "second", text: "Second response" },
              ],
            },
          },
        ],
      },
    ];
    chatMocks.useChat.mockReturnValue({ ...chatMocks.useChat(), messages });
    renderConversation({ initialMessages: messages });
    await userEvent.click(
      assertDefined(
        screen.getAllByRole("button", { name: "Retry response" }).at(-1),
      ),
    );

    await waitFor(() =>
      expect(chatMocks.regenerate).toHaveBeenCalledWith({
        messageId: "response-original",
        body: { conversationId: "conv-1" },
      }),
    );
  });

  it("preserves branch selection and branch creation callbacks", async () => {
    const messages: AgentUIMessage[] = [
      {
        id: "user-branch",
        role: "user",
        parts: [{ type: "text", text: "Ask" }],
      },
      ...initialMessages,
    ];
    const onBranchChange = vi.fn();
    const onStartBranch = vi.fn();
    chatMocks.useChat.mockReturnValue({ ...chatMocks.useChat(), messages });
    renderConversation({
      initialMessages: messages,
      onBranchChange,
      onStartBranch,
      branchNavigation: [
        {
          messageId: "user-branch",
          position: 2,
          total: 3,
          previousMessageId: "branch-previous",
          nextMessageId: "branch-next",
        },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Start a new branch" }),
    );

    expect(onBranchChange.mock.calls).toEqual([
      ["branch-previous"],
      ["branch-next"],
    ]);
    expect(onStartBranch).toHaveBeenCalledWith("m1");
  });

  it("enables attachments only for configured native uploads", async () => {
    const { props, rerender } = renderConversation();

    const toolsButton = screen.getByRole("button", { name: "Open tools" });
    expect(toolsButton).toBeEnabled();
    await userEvent.click(toolsButton);
    expect(
      screen.getByRole("option", { name: /Add attachment/ }),
    ).toBeDisabled();

    rerender(
      <AgentConversation
        {...props}
        attachmentUploadUrl="/api/v1/workspaces/workspace-1/attachments"
      />,
    );

    expect(
      screen.getByRole("option", { name: /Add attachment/ }),
    ).toBeEnabled();
  });

  it.each(["Read this", ""])(
    "uploads a native attachment with draft %j as an internal file part",
    async (text) => {
      mockFetchResponse(
        "POST",
        "/api/v1/workspaces/workspace-1/attachments?filename=notes.txt",
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
        screen.getByRole("option", { name: /Add attachment/ }),
      );
      const fileInput =
        document.querySelector<HTMLInputElement>('input[type="file"]');
      expect(fileInput).not.toBeNull();
      await userEvent.upload(
        assertDefined(fileInput),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      );
      if (text)
        await userEvent.type(
          screen.getByPlaceholderText("Message this agent"),
          text,
        );
      await userEvent.click(
        screen.getByRole("button", {
          name: text ? "Send prompt" : "Send",
        }),
      );

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
    },
  );

  it("restores the composer when a native attachment upload fails", async () => {
    mockFetchResponse(
      "POST",
      "/api/v1/workspaces/workspace-1/attachments?filename=one.txt",
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
      screen.getByRole("option", { name: /Add attachment/ }),
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

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Message this agent")).toHaveValue(
        "Keep the file and text",
      );
      expect(screen.getByText("one.txt")).toBeInTheDocument();
    });
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
      status: "streaming",
      error: undefined,
    });
    renderConversation({ initialMessages: streamingMessages });

    await userEvent.click(
      screen.getByRole("button", { name: "Stop generating" }),
    );

    expect(chatMocks.stop).toHaveBeenCalledOnce();
  });

  it.each(["notFound", "Forbidden command execution", null])(
    "restores the command draft when the server rejects %s",
    async (error) => {
      mockFetchResponse(
        "POST",
        "/api/v1/agents/agent-1/conversations/conv-1/commands",
        Response.json({ error }, { status: 403 }),
      );
      const onConversationChanged = vi.fn();
      renderConversation({ runtimeKind: "pi-sdk", onConversationChanged });
      const input = screen.getByPlaceholderText("Message this agent");
      await userEvent.type(input, "/compact preserve files");
      await userEvent.click(
        screen.getByRole("button", { name: "Send prompt" }),
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(apiMocks.fetch).toHaveBeenCalledWith(
        "/api/v1/agents/agent-1/conversations/conv-1/commands",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ line: "/compact preserve files" }),
        }),
      );
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
      expectNoMutations();
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
    mockFetchResponse(
      "POST",
      "/api/v1/chat/threads/conv-1/turns",
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
    mockFetchResponse(
      "DELETE",
      "/api/v1/chat/threads/conv-1/turns",
      Response.json(
        { error: "Not allowed to cancel this turn" },
        { status: 403 },
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(apiMocks.fetch).toHaveBeenCalledWith(
      "/api/v1/chat/threads/conv-1/turns",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ turnId: "turn-denied" }),
      }),
    );
    expect(chatMocks.stop).not.toHaveBeenCalled();
  });
  it("enforces attachment count, lets users remove a file and accepts a replacement", async () => {
    renderConversation({
      attachmentUploadUrl: "/api/v1/workspaces/workspace/attachments",
    });
    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    await userEvent.click(
      screen.getByRole("option", { name: /Add attachment/ }),
    );
    const input = assertDefined(
      document.querySelector<HTMLInputElement>('input[type="file"]'),
    );
    const files = Array.from(
      { length: 6 },
      (_, index) => new File(["data"], `file-${index}.txt`),
    );
    await userEvent.upload(input, files);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("file-5.txt")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove file-0.txt" }),
    );
    expect(screen.queryByText("file-0.txt")).not.toBeInTheDocument();
    await userEvent.upload(
      assertDefined(
        document.querySelector<HTMLInputElement>('input[type="file"]'),
      ),
      new File(["replacement"], "replacement.txt"),
    );
    expect(await screen.findByText("replacement.txt")).toBeInTheDocument();
    expectNoMutations();
  });

  it("keeps an unresolved native session read-only", async () => {
    renderConversation({ readOnly: true, runtimeKind: "pi-sdk" });
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message this agent")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expectNoMutations();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

  it("retains attachments when runtime commands reject attached input locally", async () => {
    renderConversation({
      runtimeKind: "pi-sdk",
      attachmentUploadUrl: "/api/v1/workspaces/workspace/attachments",
    });
    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    await userEvent.click(
      screen.getByRole("option", { name: /Add attachment/ }),
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
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Message this agent")).toHaveValue(
        "/compact",
      ),
    );
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expectNoMutations();
  });

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
