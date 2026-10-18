// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  agent: vi.fn(),
  mapping: vi.fn(),
  port: vi.fn(),
  begin: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, fn: unknown) => fn,
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/db", () => ({ db: { agent: { findFirst: m.agent } } }));
vi.mock("@/lib/process/supervisor", () => ({ livePort: m.port }));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: m.mapping,
  beginAgentConversationSandboxAccess: m.begin,
}));
import {
  GET,
  POST,
} from "@/app/api/v1/agents/[agentId]/conversations/[conversationId]/sandbox/[[...path]]/route";
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "user" });
  m.agent.mockResolvedValue({ workspaceId: "workspace" });
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
  it.each(["membership", "credential", "mapping", "bridge"] as const)(
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
        if (boundary === "membership") m.agent.mockResolvedValue(null);
        if (boundary === "credential") m.user.mockResolvedValue(null);
        if (boundary === "mapping")
          m.mapping.mockRejectedValue(new Error("Source assignment revoked"));
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
