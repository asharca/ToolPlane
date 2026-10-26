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
    runtimeKind: null,
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

  it("renders branch position and delegates sibling navigation", async () => {
    const onBranchChange = vi.fn();
    renderConversation({
      branchNavigation: [
        {
          messageId: "m1",
          position: 2,
          total: 3,
          previousMessageId: "m0",
          nextMessageId: "m2",
        },
      ],
      onBranchChange,
    });

    expect(screen.getByText("2/3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onBranchChange).toHaveBeenNthCalledWith(1, "m0");
    expect(onBranchChange).toHaveBeenNthCalledWith(2, "m2");
  });

  it("starts a new branch from the assistant message actions", async () => {
    const onStartBranch = vi.fn();
    renderConversation({ onStartBranch });

    await userEvent.click(
      screen.getByRole("button", { name: "Start a new branch" }),
    );

    expect(onStartBranch).toHaveBeenCalledWith("m1");
  });

  it("disables the composer while a branch switch is being committed", () => {
    renderConversation({ branchBusy: true });

    expect(screen.getByPlaceholderText("Message this agent")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();
  });

  it("sends an edited user message with its source id", async () => {
    const messages: AgentUIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "original question" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "original answer" }],
      },
    ];
    chatMocks.useChat.mockReturnValue({
      messages,
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
    renderConversation({
      allowEdit: true,
      initialMessages: messages,
      includeConversationIdInBody: false,
    });

    await userEvent.hover(screen.getByText("original question"));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByDisplayValue("original question");
    await userEvent.clear(editor);
    await userEvent.type(editor, "edited question");
    await userEvent.click(
      within(assertDefined(editor.closest("form"))).getByRole("button", {
        name: "Send prompt",
      }),
    );

    await waitFor(() =>
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ toolplaneEditMessageId: "u1" }),
          parts: [{ type: "text", text: "edited question" }],
        }),
        expect.any(Object),
      ),
    );
  });

  it("shows context usage and token details in the composer", async () => {
    const messages: AgentUIMessage[] = [
      {
        id: "m-usage",
        role: "assistant",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "data-context-usage",
            data: {
              usedTokens: 42,
              maxTokens: 100,
              modelName: "gpt-test",
              estimated: false,
            },
          },
        ],
      },
    ];
    chatMocks.useChat.mockReturnValue({
      messages,
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

    renderConversation({ initialMessages: messages });

    const meter = screen.getByRole("meter", { name: "Context usage" });
    expect(meter).toHaveProperty("value", 42);
    await userEvent.hover(meter);
    expect(
      (await screen.findAllByText("42 / 100 (42%)")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("gpt-test").length).toBeGreaterThan(0);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

  it("keeps the conversation and work context when regenerating", async () => {
    renderConversation({
      activeConversationId: "conv-1",
      workSessionId: "work-1",
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Retry response" }),
    );

    await waitFor(() =>
      expect(chatMocks.regenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { conversationId: "conv-1", workSessionId: "work-1" },
        }),
      ),
    );
  });

  it("passes the persisted assistant id when regenerating a chat branch", async () => {
    renderConversation({ includeConversationIdInBody: false });

    await userEvent.click(
      screen.getByRole("button", { name: "Retry response" }),
    );

    await waitFor(() =>
      expect(chatMocks.regenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "m1",
        }),
      ),
    );
  });

  it("refreshes persisted branch state when a request finishes", () => {
    const onConversationChanged = vi.fn();
    renderConversation({ onConversationChanged });

    const config = chatMocks.useChat.mock.calls.at(-1)?.[0] as {
      onFinish?: () => void;
    };
    config.onFinish?.();

    expect(onConversationChanged).toHaveBeenCalledOnce();
  });

  it("can disable regeneration for a transport that persists every submitted turn", () => {
    renderConversation({ allowRegenerate: false });

    expect(
      screen.queryByRole("button", { name: "Retry response" }),
    ).not.toBeInTheDocument();
    expect(chatMocks.regenerate).not.toHaveBeenCalled();
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

  it("renders reasoning and tool activity inside the assistant message", async () => {
    const messages = [
      {
        id: "m-process",
        role: "assistant" as const,
        parts: [
          { type: "reasoning", text: "Checking the available sources." },
          {
            type: "tool-web_search",
            toolCallId: "call-1",
            state: "output-available",
            input: { query: "ToolPlane" },
            output: {
              content: [{ type: "text", text: "Search result with citation" }],
            },
          },
          { type: "text", text: "Here is the answer." },
        ],
      },
    ] as AgentUIMessage[];
    chatMocks.useChat.mockReturnValue({
      messages,
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

    renderConversation({ initialMessages: messages });

    const reasoning = screen.getByRole("button", { name: "Thought" });
    expect(reasoning).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(reasoning);
    expect(reasoning).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Checking the available sources."),
    ).toBeInTheDocument();
    const tool = screen.getByRole("button", { name: /web_search/ });
    expect(tool).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(tool);
    expect(tool).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Search result with citation/)).toBeInTheDocument();
    expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
    expect(screen.queryByText("Agent is responding")).not.toBeInTheDocument();
  });

  it("renders live reasoning and tools directly without a generic process heading", async () => {
    const messages = [
      {
        id: "m-live-process",
        role: "assistant" as const,
        parts: [
          {
            type: "reasoning",
            text: "Checking the available sources.",
            state: "streaming",
          },
          {
            type: "tool-mcp__tp_1_dep-one__read/file",
            toolCallId: "call-1",
            state: "input-available",
            input: { path: "README.md" },
          },
        ],
      },
    ] as AgentUIMessage[];
    chatMocks.useChat.mockReturnValue({
      messages,
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

    renderConversation({ initialMessages: messages });

    await waitFor(() =>
      expect(screen.getByText("Checking the available sources.")).toBeVisible(),
    );
    expect(
      screen.getByRole("button", { name: /read\/file/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("mcp__tp_1_dep-one__read/file"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Processing")).not.toBeInTheDocument();
    expect(screen.queryByText("Processed")).not.toBeInTheDocument();
  });

  it.each(["menu", "slash", "pinned"])(
    "shows web search state and sends it when toggled from %s",
    async (entry) => {
      const user = userEvent.setup();
      if (entry === "pinned") {
        window.localStorage.setItem(
          "toolplane.conversation.composer.toolbar",
          '["web-search"]',
        );
      }
      renderConversation({ webSearchAvailable: true });

      if (entry === "pinned") {
        await user.click(
          screen.getByRole("button", {
            name: "Enable web search",
            pressed: false,
          }),
        );
      } else {
        if (entry === "slash") {
          await user.type(
            screen.getByPlaceholderText("Message this agent"),
            "/",
          );
        } else {
          await user.click(screen.getByRole("button", { name: "Open tools" }));
        }
        await user.click(
          await screen.findByRole("menuitem", { name: "Enable web search" }),
        );
      }
      const toggle = screen.getByRole("button", {
        name: "Disable web search",
        pressed: true,
      });
      expect(toggle).toBeVisible();
      expect(
        document.querySelectorAll('[data-composer-shortcut="web-search"]'),
      ).toHaveLength(1);
      const input = screen.getByPlaceholderText("Message this agent");
      await user.type(input, "Find current sources");
      await user.click(screen.getByRole("button", { name: "Send prompt" }));
      await waitFor(() =>
        expect(chatMocks.sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({
            body: expect.objectContaining({ webSearchEnabled: true }),
          }),
        ),
      );

      await user.click(toggle);
      expect(
        screen.queryByRole("button", { name: "Disable web search" }),
      ).not.toBeInTheDocument();
      if (entry === "pinned") {
        expect(
          screen.getByRole("button", {
            name: "Enable web search",
            pressed: false,
          }),
        ).toBeVisible();
      }
      await user.type(input, "Answer without searching");
      await user.click(screen.getByRole("button", { name: "Send prompt" }));
      await waitFor(() =>
        expect(chatMocks.sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({
            body: expect.objectContaining({ webSearchEnabled: false }),
          }),
        ),
      );
    },
  );

  it("reuses assistant chat tools for + and /", async () => {
    const user = userEvent.setup();
    const onNewConversation = vi.fn();
    renderConversation({
      mcpPromptApiPath: "/prompts",
      mcpResourceApiPath: "/composer",
      onNewConversation,
      webSearchAvailable: true,
    });

    const tools = screen.getByRole("button", { name: "Open tools" });
    await user.click(tools);
    const plusMenu = await screen.findByRole("menu", { name: "Tools" });
    expect(
      within(plusMenu).queryByRole("menuitem", { name: /Add attachment/ }),
    ).not.toBeInTheDocument();
    expect(
      within(plusMenu).getByRole("menuitem", { name: "MCP" }),
    ).toBeInTheDocument();
    expect(
      within(plusMenu).getByRole("menuitem", { name: "MCP resources" }),
    ).toBeInTheDocument();
    expect(
      within(plusMenu).getByRole("menuitem", { name: "MCP prompts" }),
    ).toBeInTheDocument();
    expect(
      within(plusMenu).getByRole("menuitem", { name: /Clear context/ }),
    ).toBeInTheDocument();
    expect(
      within(plusMenu).getByRole("menuitem", { name: "Enable web search" }),
    ).toBeInTheDocument();
    await user.click(tools);

    await user.type(screen.getByPlaceholderText("Message this agent"), "/");
    const menu = await screen.findByRole("menu", { name: "Tools" });
    expect(
      within(menu).queryByRole("menuitem", { name: "Add attachment" }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "MCP" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "MCP resources" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "MCP prompts" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: /Clear context/ }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Enable web search" }),
    ).toBeInTheDocument();

    await user.click(
      within(menu).getByRole("menuitem", { name: /Clear context/ }),
    );
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it("pins MCP resources in the toolbar and inserts the selected resource", async () => {
    const user = userEvent.setup();
    apiMocks.fetch.mockImplementation(async (input, init) => {
      if (String(input) === "/composer?section=resources") {
        return Response.json({
          items: [
            {
              kind: "resource",
              id: "docs://plan",
              deploymentId: "dep-1",
              label: "Project plan",
              description: "Workspace docs",
            },
          ],
        });
      }
      if (String(input) === "/composer" && init?.method === "POST") {
        return Response.json({
          text: "Reference material (resource): Project plan\ndocs://plan\nShip it.",
        });
      }
      return Response.json({ conversationId: "conv-new" });
    });
    renderConversation({ mcpResourceApiPath: "/composer" });

    await user.click(screen.getByRole("button", { name: "Open tools" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Customize toolbar" }),
    );
    const customizer = await screen.findByRole("dialog", {
      name: "Customize toolbar",
    });
    await user.click(
      within(customizer).getByRole("checkbox", { name: "MCP resources" }),
    );
    expect(
      [...document.querySelectorAll("[data-composer-shortcut]")].map((el) =>
        el.getAttribute("aria-label"),
      ),
    ).toEqual(["MCP resources"]);
    await user.click(within(customizer).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "MCP resources" }));
    const picker = await screen.findByRole("dialog", { name: "MCP resources" });
    await user.click(
      await within(picker).findByRole("button", { name: /Project plan/ }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByPlaceholderText(
            "Message this agent",
          ) as HTMLTextAreaElement
        ).value,
      ).toContain("docs://plan"),
    );

    await user.click(screen.getByRole("button", { name: "Open tools" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Customize toolbar" }),
    );
    const resetDialog = await screen.findByRole("dialog", {
      name: "Customize toolbar",
    });
    await user.click(
      within(resetDialog).getByRole("button", {
        name: "Restore default toolbar",
      }),
    );
    expect(document.querySelector("[data-composer-shortcut]")).toBeNull();
    await user.click(
      within(resetDialog).getByRole("button", { name: "Close" }),
    );
    await user.click(screen.getByRole("button", { name: "Open tools" }));
    expect(
      await screen.findByRole("menuitem", { name: "MCP resources" }),
    ).toBeInTheDocument();
  });

  it("offers runtime slash commands and sends them through the command endpoint", async () => {
    const user = userEvent.setup();
    const onConversationChanged = vi.fn();
    renderConversation({ runtimeKind: "dsh", onConversationChanged });

    const input = screen.getByPlaceholderText("Message this agent");
    await user.type(input, "/");
    const menu = await screen.findByRole("menu", { name: "Tools" });
    expect(
      within(menu).getByRole("menuitem", { name: /compact/ }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: /goal/ }),
    ).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /compact/ }));
    expect(input).toHaveValue("/compact ");

    await user.type(input, "preserve paths");
    await user.click(screen.getByRole("button", { name: "Send prompt" }));

    await waitFor(() =>
      expect(apiMocks.fetch).toHaveBeenCalledWith(
        "/api/v1/agents/agent-1/conversations/conv-new/commands",
        expect.objectContaining({ body: '{"line":"/compact preserve paths"}' }),
      ),
    );
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
    expect(onConversationChanged).toHaveBeenCalledTimes(1);
  });

  it("shows supported thinking efforts and snapshots the selection for send and regenerate", async () => {
    renderConversation({
      activeConversationId: "conv-1",
      initialReasoningEffort: "medium",
      reasoningAvailable: true,
    });

    const effort = screen.getByRole("button", {
      name: "Thinking effort: Medium",
    });
    await userEvent.click(effort);
    const slider = screen.getByRole("slider", { name: "Thinking effort" });
    expect(slider).toHaveAttribute("aria-valuetext", "Medium");
    slider.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    await userEvent.keyboard("{Escape}");
    await userEvent.type(
      screen.getByPlaceholderText("Message this agent"),
      "Think carefully",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));

    await waitFor(() =>
      expect(chatMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          body: expect.objectContaining({
            conversationId: "conv-1",
            reasoningEffort: "high",
          }),
        }),
      ),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Retry response" }),
    );
    await waitFor(() =>
      expect(chatMocks.regenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            conversationId: "conv-1",
            reasoningEffort: "high",
          }),
        }),
      ),
    );
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
      renderConversation({ runtimeKind: "dsh", onConversationChanged });
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

  it("rejects unsupported runtime commands locally and keeps the draft", async () => {
    renderConversation({ runtimeKind: "dsh" });
    const input = screen.getByPlaceholderText("Message this agent");
    await userEvent.type(input, "/clear");
    await userEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText(
      "This command is not supported by the current runtime.",
    );
    await waitFor(() => expect(input).toHaveValue("/clear"));
    expect(apiMocks.fetch).not.toHaveBeenCalled();
    expect(chatMocks.sendMessage).not.toHaveBeenCalled();
  });

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
  it("offers no file upload control in chat", async () => {
    renderConversation({ runtimeKind: "pi" });

    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    expect(
      screen.queryByRole("menuitem", { name: /Add attachment/ }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
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
