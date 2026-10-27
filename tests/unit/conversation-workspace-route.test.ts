// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SandboxRuntime from "@/lib/sandboxes/runtime";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  agent: vi.fn(),
  owner: vi.fn(),
  revision: vi.fn(),
  conversation: vi.fn(),
  mapping: vi.fn(),
  port: vi.fn(),
  begin: vi.fn(),
  release: vi.fn(),
  readHistorical: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, fn: unknown) => fn,
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/db", () => {
  const db = {
    agent: { findFirst: m.agent, findUnique: m.owner },
    agentRevision: { findFirst: m.revision },
    conversation: { findFirst: m.conversation },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});
vi.mock("@/lib/process/supervisor", () => ({ livePort: m.port }));
vi.mock("@/lib/sandboxes/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SandboxRuntime>()),
  readHistoricalSandboxVolume: m.readHistorical,
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: m.mapping,
  beginAgentConversationSandboxAccess: m.begin,
}));
import {
  GET,
  POST,
} from "@/app/api/v1/agents/[agentId]/conversations/[conversationId]/sandbox/[[...path]]/route";
const session = {
  id: "conversation",
  agentRevisionId: "revision-1",
  legacyRevisionUnresolved: false,
};
const revision = {
  id: "revision-1",
  version: 1,
  config: {
    schemaVersion: 1,
    runtimeKind: "pi-sdk",
    systemPrompt: null,
    providerId: null,
    model: null,
    modelProviderIds: [],
    maxSteps: 20,
    disabledBuiltinTools: [],
    sandboxTemplateId: "template",
    environment: {
      kind: "docker",
      image: `native@sha256:${"a".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    },
    skills: [],
    knowledgeBaseIds: [],
    packages: [],
    mcpGrants: [],
    a2a: {
      inboundEnabled: false,
      outboundEnabled: false,
      policy: { schemaVersion: 1, targets: [] },
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "user" });
  m.agent.mockResolvedValue({
    id: "agent",
    workspaceId: "workspace",
    runtimeKind: "pi-sdk",
    retiredAt: null,
    conversations: [session],
    skills: [],
    servers: [],
    disabledBuiltinTools: [],
    knowledgeBases: [],
  });
  m.owner.mockResolvedValue({
    runtimeKind: "pi-sdk",
    retiredAt: null,
    workspace: { status: "active" },
  });
  m.revision.mockImplementation(async ({ where }) =>
    where.id === revision.id && where.agentId === "agent" ? revision : null,
  );
  m.conversation.mockResolvedValue(session);
  m.mapping.mockResolvedValue({
    sandboxId: "isolated",
    deploymentId: "isolated-deployment",
  });
  m.port.mockReturnValue(4312);
  m.begin.mockReturnValue(m.release);
});
const context = (path = ["rpc"]) => ({
  params: Promise.resolve({
    agentId: "agent",
    conversationId: "conversation",
    path,
  }),
});
describe("conversation workspace authorization and activity", () => {
  it("requires workspace membership and the exact Agent/conversation relationship before resolving a mapping", async () => {
    m.agent.mockResolvedValue(null);
    expect(
      (
        await POST(
          new Request("http://localhost/rpc", { method: "POST" }),
          context(),
        )
      ).status,
    ).toBe(404);
    expect(m.mapping).not.toHaveBeenCalled();
    expect(m.agent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "agent",
          conversations: {
            some: { id: "conversation", publicApiConversation: null },
          },
          workspace: {
            status: "active",
            OR: [
              { ownerId: "user" },
              { members: { some: { userId: "user" } } },
            ],
          },
        }),
      }),
    );
  });
  it("does not provision or fall back to the template when no mapping exists", async () => {
    m.mapping.mockResolvedValue(null);
    expect(
      (await GET(new Request("http://localhost/rpc"), context())).status,
    ).toBe(404);
    expect(m.port).not.toHaveBeenCalled();
    expect(m.begin).not.toHaveBeenCalled();
  });
  it.each([false, true])("reads old files %s", async (root) => {
    m.agent.mockResolvedValue({
      id: "agent",
      workspaceId: "workspace",
      runtimeKind: "pi",
      conversations: [
        {
          ...session,
          agentRevisionId: null,
          sandbox: {
            id: "historical",
            kind: "docker",
            config: { readOnly: true },
            deployment: {
              installCfg: {
                readOnly: true,
                volumeName: "retained-volume",
                ...(root ? { historicalRoot: "workspace" } : {}),
              },
            },
          },
        },
      ],
    });
    m.readHistorical.mockResolvedValue({ text: "retained" });
    const response = await POST(
      new Request("http://localhost/rpc", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_file", arguments: { path: "notes.txt" } },
        }),
      }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(m.readHistorical).toHaveBeenCalledWith("retained-volume", {
      operation: "read_file",
      path: "notes.txt",
      ...(root ? { root: "workspace" } : {}),
    });
    expect(m.mapping).not.toHaveBeenCalled();
    expect(m.port).not.toHaveBeenCalled();
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("rejects historical terminals and mutations without opening a bridge", async () => {
    m.agent.mockResolvedValue({
      runtimeKind: "pi",
      conversations: [{ ...session, agentRevisionId: null }],
    });
    expect(
      (
        await GET(
          new Request("http://localhost/stream"),
          context(["terminal", "session", "stream"]),
        )
      ).status,
    ).toBe(410);
    expect(
      (
        await POST(
          new Request("http://localhost/rpc", {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "tools/call",
              params: {
                name: "write_file",
                arguments: { path: "notes.txt", content: "changed" },
              },
            }),
          }),
          context(),
        )
      ).status,
    ).toBe(410);
    expect(m.readHistorical).not.toHaveBeenCalled();
    expect(m.mapping).not.toHaveBeenCalled();
    expect(m.port).not.toHaveBeenCalled();
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("holds sandbox activity until a terminal stream is canceled", async () => {
    const upstreamCancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel: upstreamCancel })),
        ),
    );
    try {
      const response = await GET(
        new Request("http://localhost/stream"),
        context(["terminal", "session", "stream"]),
      );
      expect(m.mapping).toHaveBeenCalledWith({
        workspaceId: "workspace",
        agentId: "agent",
        conversationId: "conversation",
      });
      expect(m.begin).toHaveBeenCalledWith("isolated");
      expect(m.release).not.toHaveBeenCalled();
      await response.body?.cancel();
      expect(upstreamCancel).toHaveBeenCalledOnce();
      expect(m.release).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    "membership",
    "credential",
    "identity",
    "revision",
    "mapping",
    "bridge",
  ] as const)(
    "closes an existing terminal stream when its %s changes",
    async (boundary) => {
      vi.useFakeTimers();
      const upstreamCancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(new ReadableStream({ cancel: upstreamCancel })),
          ),
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await GET(
          new Request("http://localhost/stream"),
          context(["terminal", "session", "stream"]),
        );
        reader = response.body?.getReader();
        if (!reader) throw new Error("Missing terminal stream");
        const pending = reader.read();
        if (boundary === "membership") m.conversation.mockResolvedValue(null);
        if (boundary === "credential") m.user.mockResolvedValue(null);
        if (boundary === "identity")
          m.user.mockResolvedValue({ id: "different-user" });
        if (boundary === "revision") m.revision.mockResolvedValue(null);
        if (boundary === "mapping")
          m.mapping.mockRejectedValue(new Error("Session mapping revoked"));
        if (boundary === "bridge") m.port.mockReturnValue(4313);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(upstreamCancel).toHaveBeenCalledOnce();
        await expect(pending).resolves.toMatchObject({ done: true });
        expect(m.release).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await reader?.cancel();
        reader?.releaseLock();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});
