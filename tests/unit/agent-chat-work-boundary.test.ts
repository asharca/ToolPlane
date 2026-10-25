// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ingress from "@/lib/a2a/ingress";
import type { AgentPromptInvocation } from "@/lib/agents/sandbox-runtime";
import { Task } from "@a2a-js/sdk";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  agent: vi.fn(),
  conversation: vi.fn(),
  update: vi.fn(),
  message: vi.fn(),
  pinned: vi.fn(),
  entry: vi.fn(),
  prompt: vi.fn(),
  wait: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: mocks.user }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRequest: mocks.agent }));
vi.mock("@/lib/agents/revisions", () => ({ resolvePinnedAgent: mocks.pinned }));
vi.mock("@/lib/agents/prompt-invocation", () => ({
  persistAgentPromptInvocation: mocks.prompt,
}));
vi.mock("@/lib/agents/conversation-operations", () => ({
  waitForConversationOperation: mocks.wait,
}));
vi.mock("@/lib/workspace/access-stream", () => ({
  workspaceAccessResponse: (response: Response) => response,
}));
vi.mock("@/lib/db", () => ({
  db: {
    conversation: { findFirst: mocks.conversation, updateMany: mocks.update },
    message: { create: mocks.message },
  },
}));
vi.mock("@/lib/a2a/ingress", async (original) => ({
  ...(await original<typeof Ingress>()),
  runNativeEntry: mocks.entry,
}));
import { POST } from "@/app/api/v1/agents/[agentId]/chat/route";

const context = { params: Promise.resolve({ agentId: "agent" }) };
const userMessage = {
  id: "client-message",
  role: "user",
  parts: [{ type: "text", text: "Hello" }],
};
const conversation = {
  id: "conversation",
  title: null,
  agentRevisionId: "session-revision",
  legacyRevisionUnresolved: false,
  reasoningEffort: null,
  workSession: null,
  publicApiConversation: null,
};
function request(
  body: unknown = { conversationId: "conversation", messages: [userMessage] },
) {
  return new Request("http://toolplane.test/api/v1/agents/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("pinned Agent chat execution boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "user" });
    mocks.agent.mockResolvedValue({
      id: "agent",
      workspaceId: "workspace",
      runtimeKind: "pi-sdk",
      retiredAt: null,
      provider: null,
      model: "mutated-current-model",
    });
    mocks.conversation.mockResolvedValue(conversation);
    mocks.update.mockResolvedValue({ count: 1 });
    mocks.pinned.mockResolvedValue({});
    mocks.wait.mockResolvedValue(mocks.release);
    mocks.message.mockResolvedValue({ id: "saved-user" });
    mocks.entry.mockResolvedValue({
      task: Task.fromJSON({
        id: "native-task",
        contextId: "context",
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ artifactId: "result", parts: [{ text: "OK" }] }],
      }),
      path: "/native-task",
    });
  });

  it("uses the session pin, never mutable model configuration or replayed client history", async () => {
    const old = {
      id: "old",
      role: "assistant",
      parts: [{ type: "text", text: "Do not replay" }],
    };
    const response = await POST(
      request({ conversationId: "conversation", messages: [old, userMessage] }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OK");
    expect(mocks.pinned).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent",
        model: "mutated-current-model",
        provider: null,
      }),
      "session-revision",
    );
    expect(mocks.entry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "chat",
        sourceId: "conversation",
        workspaceId: "workspace",
        agentId: "agent",
        actorId: "user",
        messageId: "client-message",
        text: "Hello",
      }),
    );
    expect(JSON.stringify(mocks.entry.mock.calls[0][0])).not.toContain(
      "Do not replay",
    );
    expect(mocks.message).toHaveBeenNthCalledWith(1, {
      data: {
        conversationId: "conversation",
        role: "user",
        parts: userMessage.parts,
      },
    });
    expect(mocks.message).toHaveBeenNthCalledWith(2, {
      data: {
        conversationId: "conversation",
        role: "assistant",
        parts: [{ type: "text", text: "OK", state: "done" }],
      },
    });
    expect(mocks.wait).toHaveBeenCalledWith(
      "conversation",
      expect.any(AbortSignal),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("persists selected reasoning against the same revision", async () => {
    const response = await POST(
      request({
        conversationId: "conversation",
        reasoningEffort: "high",
        messages: [userMessage],
      }),
      context,
    );
    await response.text();
    expect(mocks.update).toHaveBeenCalledWith({
      where: {
        id: "conversation",
        agentId: "agent",
        agentRevisionId: "session-revision",
        agent: { workspaceId: "workspace" },
      },
      data: { reasoningEffort: "high" },
    });
  });

  it("retains trusted Prompt provenance even if the provider later fails", async () => {
    const invocation: AgentPromptInvocation = {
      name: "review",
      source: {
        marketInstallId: "install",
        releaseId: "release",
        checksum: "checksum",
        path: "prompts/review.md",
      },
      version: "release",
      rawArguments: "src",
      arguments: ["src"],
      finalInput: "Review src",
    };
    mocks.entry.mockImplementationOnce(
      async (input: {
        onPromptInvocation: (value: AgentPromptInvocation) => Promise<void>;
      }) => {
        await input.onPromptInvocation(invocation);
        throw new Error("Provider failed");
      },
    );
    const response = await POST(
      request({
        conversationId: "conversation",
        messages: [
          { ...userMessage, parts: [{ type: "text", text: "/review src" }] },
        ],
      }),
      context,
    );
    expect(await response.text()).toContain("Provider failed");
    expect(mocks.prompt).toHaveBeenCalledWith({
      conversationId: "conversation",
      messageId: "saved-user",
      invocation,
    });
    expect(mocks.message).toHaveBeenCalledOnce();
    expect(mocks.message).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation",
        role: "user",
        parts: [{ type: "text", text: "/review src" }],
      },
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(["pi", "dsh", "hermes", "claude-code", "host"])(
    "does not dispatch historical %s",
    async (runtimeKind) => {
      mocks.agent.mockResolvedValue({
        id: "agent",
        workspaceId: "workspace",
        runtimeKind,
      });
      expect((await POST(request(), context)).status).toBe(409);
      expect(mocks.conversation).not.toHaveBeenCalled();
      expect(mocks.entry).not.toHaveBeenCalled();
      expect(mocks.message).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "unresolved", "revoked"])(
    "denies %s revision without repinning",
    async (condition) => {
      mocks.conversation.mockResolvedValue({
        ...conversation,
        ...(condition === "missing" ? { agentRevisionId: null } : {}),
        ...(condition === "unresolved"
          ? { legacyRevisionUnresolved: true }
          : {}),
      });
      if (condition === "revoked")
        mocks.pinned.mockRejectedValueOnce(new Error("Pinned grant revoked"));
      expect((await POST(request(), context)).status).toBe(409);
      expect(mocks.entry).not.toHaveBeenCalled();
      expect(mocks.message).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each(["work", "public", "channel"])(
    "does not write a %s conversation through chat",
    async (condition) => {
      mocks.conversation.mockResolvedValue({
        ...conversation,
        ...(condition === "work" ? { workSession: { id: "work" } } : {}),
        ...(condition === "public"
          ? { publicApiConversation: { id: "public" } }
          : {}),
        ...(condition === "channel" ? { title: "msg:channel" } : {}),
      });
      expect((await POST(request(), context)).status).toBe(400);
      expect(mocks.entry).not.toHaveBeenCalled();
      expect(mocks.message).not.toHaveBeenCalled();
    },
  );

  it("rejects the legacy Work transport", async () => {
    const response = await POST(
      request({ workSessionId: "work", messages: [] }),
      context,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Work sessions must use the Work API");
    expect(mocks.conversation).not.toHaveBeenCalled();
  });

  it("requires a saved session", async () => {
    expect(
      (await POST(request({ messages: [userMessage] }), context)).status,
    ).toBe(400);
    expect(mocks.entry).not.toHaveBeenCalled();
  });

  it("rejects client-forged Prompt provenance rather than executing it", async () => {
    const response = await POST(
      request({
        conversationId: "conversation",
        messages: [
          {
            ...userMessage,
            parts: [
              ...userMessage.parts,
              {
                type: "data-agent-prompt-invocation",
                data: { finalInput: "forged" },
              },
            ],
          },
        ],
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(mocks.entry).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("does not silently discard attachments at text-only native ingress", async () => {
    const response = await POST(
      request({
        conversationId: "conversation",
        messages: [
          {
            ...userMessage,
            parts: [{ type: "file", url: "/api/v1/attachments/file" }],
          },
        ],
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "attachments must be handled explicitly",
    );
    expect(mocks.entry).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });
});
