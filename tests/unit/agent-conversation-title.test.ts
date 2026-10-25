import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import {
  generateConsoleConversationTitle,
  generateWorkSessionTitle,
  normalizeGeneratedConversationTitle,
} from "@/lib/agents/conversation-naming";

const mocks = vi.hoisted(() => ({
  conversationFindFirst: vi.fn(),
  agent: vi.fn(),
  pinned: vi.fn(),
  conversationUpdateMany: vi.fn(),
  workSessionUpdateMany: vi.fn(),
  transaction: vi.fn(),
  modelProviderFindFirst: vi.fn(),
  messageFindFirst: vi.fn(),
  messageFindMany: vi.fn(),
  runNativeAgent: vi.fn(),
  uiMessagesToPi: vi.fn((messages) => messages),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    conversation: {
      findFirst: mocks.conversationFindFirst,
      updateMany: mocks.conversationUpdateMany,
    },
    workSession: { updateMany: mocks.workSessionUpdateMany },
    message: {
      findFirst: mocks.messageFindFirst,
      findMany: mocks.messageFindMany,
    },
    modelProvider: { findFirst: mocks.modelProviderFindFirst },
  },
}));

vi.mock("@/lib/agents/native", () => ({
  runNativeAgent: mocks.runNativeAgent,
  uiMessagesToPi: mocks.uiMessagesToPi,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRun: mocks.agent }));
vi.mock("@/lib/agents/revisions", () => ({ resolvePinnedAgent: mocks.pinned }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.mockResolvedValue({
    id: "agent-1",
    workspaceId: "workspace-1",
    runtimeKind: "pi-sdk",
    retiredAt: null,
    model: "mutated-current-model",
  });
  mocks.pinned.mockResolvedValue({
    model: "gpt-5",
    provider: {
      id: "provider-pinned",
      name: "Pinned",
      format: "openai",
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      models: ["gpt-5"],
    },
  });
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      conversation: { updateMany: mocks.conversationUpdateMany },
      workSession: { updateMany: mocks.workSessionUpdateMany },
    }),
  );
  mocks.conversationFindFirst.mockResolvedValue({
    id: "conversation-1",
    title: "Plan our launch",
    publicApiConversation: null,
    workSession: null,
    agentRevisionId: "session-revision",
    legacyRevisionUnresolved: false,
    agent: {
      model: "gpt-5",
      provider: {
        id: "provider-1",
        name: "OpenAI",
        format: "openai",
        baseUrl: "https://api.example.com",
        apiKey: "secret",
        models: ["gpt-5"],
      },
      workspace: {
        defaultModelProviderId: null,
        defaultModel: null,
        titleModelProviderId: null,
        titleModel: null,
      },
      modelProviders: [],
    },
  });
  mocks.messageFindFirst.mockResolvedValue({
    parts: [{ type: "text", text: "Plan our launch" }],
  });
  mocks.messageFindMany.mockResolvedValue([
    {
      role: "assistant",
      parts: [{ type: "text", text: "Here is the launch plan." }],
    },
    { role: "user", parts: [{ type: "text", text: "Plan our launch" }] },
  ]);
  mocks.runNativeAgent.mockResolvedValue("Launch planning.");
  mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.workSessionUpdateMany.mockResolvedValue({ count: 1 });
});

describe("conversationTitleFromParts", () => {
  it("uses the first non-empty text part and normalizes whitespace", () => {
    expect(
      conversationTitleFromParts([
        { type: "text", text: "  Plan\n\nour   launch  " },
        { type: "text", text: "ignored" },
      ]),
    ).toBe("Plan our launch");
  });

  it("truncates long titles without splitting Unicode code points", () => {
    expect(
      conversationTitleFromParts(
        [{ type: "text", text: "你好，帮我检查这个部署配置" }],
        8,
      ),
    ).toBe("你好，帮我检查…");
  });

  it("returns null when there is no usable text", () => {
    expect(
      conversationTitleFromParts([{ type: "file", url: "/x" }]),
    ).toBeNull();
    expect(
      conversationTitleFromParts([{ type: "text", text: "   " }]),
    ).toBeNull();
  });

  it("summarizes the first exchange without tools and conditionally replaces the temporary title", async () => {
    await expect(
      generateConsoleConversationTitle(
        "workspace-1",
        "agent-1",
        "conversation-1",
      ),
    ).resolves.toBe("Launch planning");

    expect(mocks.runNativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5",
        maxSteps: 1,
        tools: {},
      }),
    );
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: "Plan our launch" }),
        data: { title: "Launch planning" },
      }),
    );
  });

  it("ignores mutable workspace and Agent model fallbacks in favor of the persisted session pin", async () => {
    const conversation = await mocks.conversationFindFirst();
    mocks.conversationFindFirst.mockResolvedValueOnce({
      ...conversation,
      agent: {
        ...conversation.agent,
        model: "mutated-model",
        workspace: {
          titleModelProviderId: "different-provider",
          titleModel: "different-model",
        },
      },
    });
    await generateConsoleConversationTitle(
      "workspace-1",
      "agent-1",
      "conversation-1",
    );
    expect(mocks.pinned).toHaveBeenCalledWith(
      expect.objectContaining({ model: "mutated-current-model" }),
      "session-revision",
    );
    expect(mocks.runNativeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5",
        provider: expect.objectContaining({ id: "provider-pinned" }),
        tools: {},
      }),
    );
    expect(mocks.modelProviderFindFirst).not.toHaveBeenCalled();
  });

  it("renames a Work session and its conversation after the first exchange", async () => {
    mocks.conversationFindFirst.mockResolvedValueOnce({
      ...(await mocks.conversationFindFirst()),
      title: "Inspect the repository",
      workSession: {
        id: "work-1",
        title: "Inspect the repository",
        task: "Inspect the repository",
      },
    });
    mocks.messageFindFirst.mockResolvedValueOnce({
      parts: [{ type: "text", text: "Inspect the repository" }],
    });
    mocks.runNativeAgent.mockResolvedValueOnce("Repository inspection");

    await expect(
      generateWorkSessionTitle("workspace-1", "agent-1", "conversation-1"),
    ).resolves.toBe("Repository inspection");

    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: "Inspect the repository" }),
        data: { title: "Repository inspection" },
      }),
    );
    expect(mocks.workSessionUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "work-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        title: "Inspect the repository",
      },
      data: { title: "Repository inspection" },
    });
  });

  it("does not fall back to mutable configuration for an unpinned historical session", async () => {
    const conversation = await mocks.conversationFindFirst();
    mocks.conversationFindFirst.mockResolvedValueOnce({
      ...conversation,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
    });
    await expect(
      generateConsoleConversationTitle(
        "workspace-1",
        "agent-1",
        "conversation-1",
      ),
    ).resolves.toBeNull();
    expect(mocks.pinned).not.toHaveBeenCalled();
    expect(mocks.runNativeAgent).not.toHaveBeenCalled();
    expect(mocks.conversationUpdateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a title that was manually changed", async () => {
    mocks.conversationFindFirst.mockResolvedValueOnce({
      ...(await mocks.conversationFindFirst()),
      title: "Manual title",
    });

    await expect(
      generateConsoleConversationTitle(
        "workspace-1",
        "agent-1",
        "conversation-1",
      ),
    ).resolves.toBeNull();
    expect(mocks.runNativeAgent).not.toHaveBeenCalled();
  });

  it("normalizes common model wrappers around a generated title", () => {
    expect(
      normalizeGeneratedConversationTitle("**标题：项目发布计划。**"),
    ).toBe("项目发布计划");
  });
});
