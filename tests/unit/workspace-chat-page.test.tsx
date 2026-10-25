import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { redirect } from "next/navigation";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listAssistants: vi.fn(),
  getThread: vi.fn(),
  listProviders: vi.fn(),
  listChatDeployments: vi.fn(),
  surface: vi.fn(),
  getAssistantMarketTemplate: vi.fn(),
  listAssistantMarketTemplates: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
}));
vi.mock("@/lib/agents/queries", () => ({
  listProviders: mocks.listProviders,
}));
vi.mock("@/lib/chat/resources", () => ({
  listChatDeploymentOptions: mocks.listChatDeployments,
}));
vi.mock("@/lib/chat/service", () => ({
  listChatAssistantsForWorkspace: mocks.listAssistants,
  getChatThreadForWorkspace: mocks.getThread,
  listRunningChatThreadIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/market/skills", () => ({
  getAssistantMarketTemplate: mocks.getAssistantMarketTemplate,
  listAssistantMarketTemplates: mocks.listAssistantMarketTemplates,
}));
vi.mock("@/lib/timezone", () => ({
  resolveUserTimeZone: () => "UTC",
  formatInTimeZone: (value: Date) => value.toISOString(),
}));
vi.mock("@/components/dashboard/DashboardHeader", () => ({
  DashboardHeader: () => <div>Header</div>,
}));
vi.mock("@/components/dashboard/chat/WorkspaceAssistantChat", () => ({
  WorkspaceAssistantChat: (props: unknown) => {
    mocks.surface(props);
    return <div>Chat surface</div>;
  },
}));

import WorkspaceChatPage from "@/app/app/[workspace]/chat/page";
import WorkspaceAgentChatPage from "@/app/app/[workspace]/work/chat/page";

describe("Workspace chat page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: "workspace-1" });
    mocks.listProviders.mockResolvedValue([]);
    mocks.listChatDeployments.mockResolvedValue([
      {
        id: "remote-search",
        name: "Remote search",
        status: "running",
        available: true,
        definitionChecksum: "a".repeat(64),
        tools: [{ name: "search", description: "Search reviewed sources" }],
      },
    ]);
    mocks.getAssistantMarketTemplate.mockResolvedValue(null);
    mocks.listAssistantMarketTemplates.mockResolvedValue([]);
    mocks.cookies.mockResolvedValue({
      get: vi.fn().mockReturnValue(undefined),
    });
    mocks.listAssistants.mockResolvedValue([
      {
        id: "assistant-1",
        name: "Helper",
        pinned: true,
        currentRevisionVersion: 3,
        systemPrompt: null,
        modelProviderId: null,
        model: null,
        maxSteps: 8,
        modelProvider: null,
        mcpGrants: [
          { deploymentId: "remote-search", allowedToolNames: ["search"] },
        ],
        threads: [
          {
            id: "thread-recent",
            assistantRevisionId: "revision-3",
            assistantRevision: { version: 3 },
            legacyRevisionUnresolved: false,
            title: "Recent",
            createdAt: new Date("2026-08-25T00:00:00.000Z"),
            messages: [],
          },
        ],
      },
    ]);
    mocks.getThread.mockResolvedValue({
      id: "thread-old",
      assistantId: "assistant-1",
      assistantRevisionId: "revision-2",
      assistantRevision: { version: 2 },
      legacyRevisionUnresolved: false,
      title: "Older direct link",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      messages: [
        {
          id: "message-old",
          role: "assistant",
          parts: [{ type: "text", text: "Loaded directly" }],
          createdAt: new Date("2026-01-01T00:01:00.000Z"),
        },
      ],
    });
  });

  it("loads an unlisted thread through the workspace and assistant boundary", async () => {
    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({
          assistant: "assistant-1",
          thread: "thread-old",
        }),
      }),
    );

    expect(mocks.getThread).toHaveBeenCalledWith(
      "workspace-1",
      "assistant-1",
      "thread-old",
    );
    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAssistantId: "assistant-1",
        selectedThreadId: "thread-old",
        initialMessages: [expect.objectContaining({ id: "message-old" })],
        assistants: [
          expect.objectContaining({
            pinned: true,
            revision: 3,
            mcpGrants: [
              { deploymentId: "remote-search", allowedToolNames: ["search"] },
            ],
            threads: [
              expect.objectContaining({
                id: "thread-old",
                revisionId: "revision-2",
                revision: 2,
                legacyRevisionUnresolved: false,
              }),
              expect.objectContaining({
                id: "thread-recent",
                revisionId: "revision-3",
                revision: 3,
                legacyRevisionUnresolved: false,
              }),
            ],
          }),
        ],
      }),
    );
    expect(mocks.listChatDeployments).toHaveBeenCalledWith(
      "user-1",
      "workspace-1",
    );
    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        deployments: [
          {
            id: "remote-search",
            name: "Remote search",
            status: "running",
            available: true,
            definitionChecksum: "a".repeat(64),
            tools: [{ name: "search", description: "Search reviewed sources" }],
          },
        ],
      }),
    );
  });

  it("preserves unresolved historical revision state instead of binding history to the current revision", async () => {
    mocks.getThread.mockResolvedValue({
      id: "thread-legacy",
      assistantId: "assistant-1",
      assistantRevisionId: null,
      assistantRevision: null,
      legacyRevisionUnresolved: true,
      title: "Read-only history",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      messages: [
        {
          id: "legacy-message",
          role: "assistant",
          parts: [{ type: "text", text: "Historical reply" }],
          createdAt: new Date("2026-01-01T00:01:00.000Z"),
        },
      ],
    });
    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({
          assistant: "assistant-1",
          thread: "thread-legacy",
        }),
      }),
    );
    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMessages: [expect.objectContaining({ id: "legacy-message" })],
        assistants: [
          expect.objectContaining({
            revision: 3,
            threads: [
              expect.objectContaining({
                id: "thread-legacy",
                revisionId: null,
                revision: null,
                legacyRevisionUnresolved: true,
              }),
              expect.objectContaining({
                id: "thread-recent",
                revisionId: "revision-3",
                revision: 3,
              }),
            ],
          }),
        ],
      }),
    );
  });

  it("enables reasoning for the selected assistant model capability", async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        name: "OpenAI",
        format: "openai",
        baseUrl: "",
        apiKey: "",
        models: ["gpt-5"],
        modelRecords: [{ modelId: "gpt-5", capabilities: ["reasoning"] }],
      },
    ]);
    mocks.listAssistants.mockResolvedValue([
      {
        id: "assistant-1",
        name: "Helper",
        pinned: false,
        currentRevisionVersion: 1,
        systemPrompt: null,
        modelProviderId: "provider-1",
        model: "gpt-5",
        maxSteps: 8,
        modelProvider: { name: "OpenAI" },
        mcpGrants: [],
        threads: [],
      },
    ]);

    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ assistant: "assistant-1" }),
      }),
    );

    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningAvailable: true }),
    );
  });

  it("seeds the assistant sidebar from its workspace cookie", async () => {
    mocks.cookies.mockResolvedValue({
      get: vi.fn().mockReturnValue({ value: "false" }),
    });

    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ assistant: "assistant-1" }),
      }),
    );

    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({ initialSidebarOpen: false }),
    );
  });

  it("seeds assistant disclosures from its workspace cookie", async () => {
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "toolplane_assistant_chat_expanded_workspace-1"
          ? { value: "%7B%22assistant-1%22%3Afalse%7D" }
          : undefined,
      ),
    });

    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ assistant: "assistant-1" }),
      }),
    );

    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        initialExpandedAssistants: { "assistant-1": false },
      }),
    );
  });

  it("seeds assistant groups from its workspace cookie", async () => {
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) =>
        name === "toolplane_assistant_chat_group_preferences_workspace-1"
          ? {
              value:
                "%7B%22groups%22%3A%5B%7B%22id%22%3A%22group-1%22%2C%22name%22%3A%22Research%22%7D%5D%2C%22assignments%22%3A%7B%22assistant-1%22%3A%22group-1%22%7D%2C%22collapsed%22%3A%7B%22group-1%22%3Atrue%7D%7D",
            }
          : undefined,
      ),
    });

    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ assistant: "assistant-1" }),
      }),
    );

    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        initialGroupPreferences: {
          groups: [{ id: "group-1", name: "Research" }],
          assignments: { "assistant-1": "group-1" },
          collapsed: { "group-1": true },
        },
      }),
    );
  });

  it("opens the assistant creator from a direct market handoff", async () => {
    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ newAssistant: "1" }),
      }),
    );

    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        startCreating: true,
        marketTemplates: [],
      }),
    );
    expect(mocks.listAssistantMarketTemplates).toHaveBeenCalledWith({
      limit: 12,
    });
  });

  it("resolves a market assistant template without implicitly authorizing matching resources", async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        name: "Anthropic",
        format: "anthropic",
        models: ["claude-sonnet"],
        modelRecords: [],
      },
    ]);
    mocks.listChatDeployments.mockResolvedValue([
      {
        id: "deployment-1",
        name: "Web Search",
        status: "running",
        available: true,
        definitionChecksum: "b".repeat(64),
        tools: [{ name: "search", description: "Search" }],
      },
    ]);
    mocks.getAssistantMarketTemplate.mockResolvedValue({
      releaseId: "release-1",
      listing: { summary: "Research assistant", tags: ["research"] },
      manifest: {
        assistant: {
          name: "Researcher",
          systemPrompt: "Use primary sources.",
          maxSteps: 10,
          modelRequirement: {
            providerFormat: "anthropic",
            model: "claude-sonnet",
          },
          mcpRequirements: [{ catalogSlug: "web-search", name: "Web Search" }],
        },
      },
    });

    render(
      await WorkspaceChatPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({
          newAssistant: "1",
          template: "release-1",
        }),
      }),
    );

    expect(mocks.getAssistantMarketTemplate).toHaveBeenCalledWith("release-1");
    expect(mocks.surface).toHaveBeenCalledWith(
      expect.objectContaining({
        marketTemplate: expect.objectContaining({
          releaseId: "release-1",
          providerFormat: "anthropic",
          model: "claude-sonnet",
          deploymentIds: [],
          missingMcpNames: ["Web Search"],
        }),
        marketTemplates: [
          expect.objectContaining({
            releaseId: "release-1",
            tags: ["research"],
          }),
        ],
      }),
    );
  });

  it("redirects legacy Agent links out of the assistant route without loading assistant data", async () => {
    await WorkspaceChatPage({
      params: Promise.resolve({ workspace: "acme" }),
      searchParams: Promise.resolve({
        agent: "agent-hermes",
        c: "conversation-1",
      }),
    });
    expect(redirect).toHaveBeenCalledWith(
      "/app/acme/work?agent=agent-hermes&c=conversation-1",
    );
    expect(mocks.listAssistants).not.toHaveBeenCalled();
    expect(mocks.surface).not.toHaveBeenCalled();
  });

  it("redirects the retired Agent chat page to the main Work surface", async () => {
    await WorkspaceAgentChatPage({
      params: Promise.resolve({ workspace: "acme" }),
      searchParams: Promise.resolve({
        agent: "agent-hermes",
        c: "conversation-1",
      }),
    });
    expect(redirect).toHaveBeenCalledWith(
      "/app/acme/work?agent=agent-hermes&c=conversation-1",
    );
    expect(mocks.listAssistants).not.toHaveBeenCalled();
    expect(mocks.listChatDeployments).not.toHaveBeenCalled();
  });
});
