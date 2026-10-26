// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationUpdateMany: vi.fn(),
  appendMessage: vi.fn(),
  ensureConversationRuntimeSession: vi.fn(),
  transaction: vi.fn(),
  messageCreate: vi.fn(),
  messageFindMany: vi.fn(),
  resolveAgentTools: vi.fn(),
  runDedicatedSandboxTurn: vi.fn(),
  runNativeEntry: vi.fn(),
}));

vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: mocks.resolveRequestUser,
}));
vi.mock("@/lib/workspace/access-stream", () => ({
  workspaceAccessResponse: (response: Response) => response,
}));
vi.mock("@/lib/agents/queries", () => ({
  getAgentForRequest: mocks.getAgentForRequest,
}));
vi.mock("@/lib/db", () => ({
  db: {
    conversation: {
      findFirst: mocks.conversationFindFirst,
      updateMany: mocks.conversationUpdateMany,
    },
    message: { create: mocks.messageCreate, findMany: mocks.messageFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/agents/mutations", () => ({
  appendMessage: mocks.appendMessage,
  ensureConversationRuntimeSession: mocks.ensureConversationRuntimeSession,
}));
vi.mock("@/lib/agents/resolve", () => ({
  resolveAgentTools: mocks.resolveAgentTools,
}));
vi.mock("@/lib/agents/system-prompt", () => ({
  assembleSystemPrompt: vi.fn(),
}));
vi.mock("@/lib/agents/run", () => ({ buildAgentToolSet: vi.fn() }));
vi.mock("@/lib/agents/native", () => ({
  uiMessagesToPi: vi.fn(),
  runNativeAgent: vi.fn(),
}));
vi.mock("@/lib/agents/sandbox-turn", () => ({
  runDedicatedSandboxTurn: mocks.runDedicatedSandboxTurn,
}));

vi.mock("@/lib/a2a/ingress", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runNativeEntry: mocks.runNativeEntry,
}));

import { Task } from "@a2a-js/sdk";
import { POST } from "@/app/api/v1/agents/[agentId]/chat/route";

const context = { params: Promise.resolve({ agentId: "agent-1" }) };

function request(body: unknown) {
  return new Request("http://toolplane.test/api/v1/agents/agent-1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Chat and Work execution boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: "user-1" });
    mocks.getAgentForRequest.mockResolvedValue({
      id: "agent-1",
      workspaceId: "workspace-1",
      runtimeKind: "pi",
      runtime: null,
      provider: { id: "provider-1" },
      model: "model-1",
    });
    mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.resolveAgentTools.mockReturnValue({ skills: [], deploymentIds: [] });
    mocks.runNativeEntry.mockResolvedValue({
      task: Task.fromJSON({
        id: "native-1",
        contextId: "context-1",
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ artifactId: "result", parts: [{ text: "OK" }] }],
      }),
      path: "/native-task",
    });
  });

  it("rejects the legacy workSessionId transport", async () => {
    const response = await POST(
      request({ messages: [], workSessionId: "work-1" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Work sessions must use the Work API");
    expect(mocks.conversationFindFirst).not.toHaveBeenCalled();
  });

  it("does not let Chat write into a Work conversation", async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      workSession: { id: "work-1" },
    });
    const response = await POST(
      request({ messages: [], conversationId: "conversation-1" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Work conversations must use the Work API",
    );
  });

  it("requires a saved Agent conversation for native attachments", async () => {
    const response = await POST(
      request({
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "file", url: "/api/v1/attachments/attachment-1" }],
          },
        ],
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Attachments require a saved conversation.",
    );
  });

  it("does not persist a failed native task as an empty assistant reply", async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      title: null,
      reasoningEffort: null,
      publicApiConversation: null,
      workSession: null,
    });
    mocks.runNativeEntry.mockRejectedValue(new Error("Runtime failed"));

    const response = await POST(
      request({
        conversationId: "conversation-1",
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "Hello" }],
          },
        ],
      }),
      context,
    );

    expect(await response.text()).toContain("Runtime failed");
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });

  it("persists a completed native task projection", async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      title: null,
      reasoningEffort: null,
      publicApiConversation: null,
      workSession: null,
    });

    const response = await POST(
      request({
        conversationId: "conversation-1",
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "Hello" }],
          },
        ],
      }),
      context,
    );
    await response.text();

    expect(mocks.appendMessage).toHaveBeenNthCalledWith(
      2,
      "conversation-1",
      "assistant",
      [{ type: "text", text: "OK", state: "done" }],
    );
  });

  it("submits only fresh input to native DSH without replaying old compacted tool history", async () => {
    mocks.getAgentForRequest.mockResolvedValue({
      id: "agent-1",
      workspaceId: "workspace-1",
      runtimeKind: "dsh",
      provider: { id: "provider-1" },
      model: "model-1",
    });
    mocks.conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      title: null,
      workSession: null,
      publicApiConversation: null,
    });
    const old = {
      id: "old-user",
      role: "user",
      parts: [{ type: "text", text: "Old detailed history" }],
    };
    mocks.messageFindMany.mockResolvedValue([
      old,
      {
        id: "old-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Old answer" }],
      },
      {
        id: "marker",
        role: "system",
        parts: [
          {
            type: "data-conversation-compaction",
            data: {
              boundaryId: "old-assistant",
              summary: "Saved concise context",
              beforeTokens: 4000,
              afterTokens: 200,
              completedAt: "2026-09-06T00:00:00Z",
            },
          },
        ],
      },
    ]);
    const next = {
      id: "new-user",
      role: "user",
      parts: [{ type: "text", text: "Continue" }],
    };
    const response = await POST(
      request({ conversationId: "conversation-1", messages: [old, next] }),
      context,
    );
    await response.text();
    expect(mocks.runNativeEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "chat",
        actorId: "user-1",
        agentId: "agent-1",
        sourceId: "conversation-1",
        messageId: "new-user",
        text: "Continue",
      }),
    );
    expect(mocks.runDedicatedSandboxTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.runNativeEntry.mock.calls[0][0])).not.toContain(
      "Old detailed history",
    );
    expect(JSON.stringify(mocks.runNativeEntry.mock.calls[0][0])).not.toContain(
      "Saved concise context",
    );
  });
});
