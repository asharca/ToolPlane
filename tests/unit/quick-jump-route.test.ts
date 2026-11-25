// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  scope: null as { workspaceId: string; role: "owner" } | null,
}));

const dbMock = vi.hoisted(() => ({
  chatAssistant: { findMany: vi.fn() },
  chatThread: { findMany: vi.fn() },
  agent: { findMany: vi.fn() },
  workSession: { findMany: vi.fn() },
  deployment: { findMany: vi.fn() },
  sandbox: { findMany: vi.fn() },
}));

vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: vi.fn(async () => state.user),
}));

vi.mock("@/lib/workspace/scope", () => ({
  resolveWorkspaceScope: vi.fn(async () => state.scope),
  workspaceScopeWhere: vi.fn((scope: { workspaceId: string }) => ({
    id: scope.workspaceId,
  })),
}));

vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: <A extends unknown[], R>(
    _route: string,
    handler: (req: Request, ...args: A) => R,
  ) => handler,
}));

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

import { GET } from "@/app/api/v1/workspaces/[slug]/quick-jump/route";

describe("GET /api/v1/workspaces/[slug]/quick-jump", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = null;
    state.scope = null;
  });

  it("rejects unauthenticated callers with 401", async () => {
    const response = await GET(
      new Request("http://localhost/api/v1/workspaces/smoke/quick-jump"),
      {
        params: Promise.resolve({ slug: "smoke" }),
      },
    );
    expect(response.status).toBe(401);
    expect(dbMock.chatAssistant.findMany).not.toHaveBeenCalled();
  });

  it("returns 404 when caller lacks workspace access", async () => {
    state.user = { id: "user-1" };
    state.scope = null;

    const response = await GET(
      new Request("http://localhost/api/v1/workspaces/secret/quick-jump"),
      {
        params: Promise.resolve({ slug: "secret" }),
      },
    );
    expect(response.status).toBe(404);
    expect(dbMock.chatAssistant.findMany).not.toHaveBeenCalled();
  });

  it("returns workspace-scoped entities without secret fields", async () => {
    const now = new Date("2026-11-25T08:00:00.000Z");
    state.user = { id: "user-1" };
    state.scope = { workspaceId: "ws-1", role: "owner" };

    dbMock.chatAssistant.findMany.mockResolvedValue([
      {
        id: "asst-1",
        name: "Research Assistant",
        model: "gpt-4.1",
        pinned: true,
        updatedAt: now,
      },
    ]);
    dbMock.chatThread.findMany.mockResolvedValue([
      {
        id: "thread-1",
        title: "Q4 Review",
        assistantId: "asst-1",
        assistant: { name: "Research Assistant" },
        updatedAt: now,
      },
    ]);
    dbMock.agent.findMany.mockResolvedValue([
      {
        id: "agent-1",
        name: "Coder Agent",
        model: "claude-sonnet",
        pinned: false,
        currentRevisionVersion: 3,
        updatedAt: now,
      },
    ]);
    dbMock.workSession.findMany.mockResolvedValue([
      {
        id: "work-1",
        title: null,
        task: "Inspect CI logs ".repeat(20),
        status: "running",
        agentId: "agent-1",
        agent: { name: "Coder Agent" },
        updatedAt: now,
      },
    ]);
    dbMock.deployment.findMany.mockResolvedValue([
      {
        id: "dep-1",
        name: "GitHub MCP",
        status: "running",
        server: { name: "GitHub" },
        sandbox: { id: "sb-1", name: "default" },
        updatedAt: now,
      },
    ]);
    dbMock.sandbox.findMany.mockResolvedValue([
      {
        id: "sb-1",
        name: "dev-box",
        kind: "docker",
        updatedAt: now,
      },
    ]);

    const response = await GET(
      new Request("http://localhost/api/v1/workspaces/smoke/quick-jump"),
      {
        params: Promise.resolve({ slug: "smoke" }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response.json();

    expect(dbMock.chatAssistant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspace: { id: "ws-1" } },
      }),
    );
    expect(dbMock.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspace: { id: "ws-1" }, retiredAt: null },
      }),
    );

    expect(payload.assistants).toEqual([
      {
        id: "asst-1",
        name: "Research Assistant",
        model: "gpt-4.1",
        pinned: true,
        updatedAt: now.toISOString(),
      },
    ]);
    expect(payload.threads[0]).toEqual({
      id: "thread-1",
      title: "Q4 Review",
      assistantId: "asst-1",
      assistantName: "Research Assistant",
      updatedAt: now.toISOString(),
    });
    expect(payload.agents[0]).toEqual({
      id: "agent-1",
      name: "Coder Agent",
      model: "claude-sonnet",
      pinned: false,
      ready: true,
      updatedAt: now.toISOString(),
    });
    expect(payload.sessions[0].task.length).toBe(120);
    expect(payload.mcpServers[0]).toEqual({
      id: "dep-1",
      name: "GitHub MCP",
      status: "running",
      sandboxName: "default",
      updatedAt: now.toISOString(),
    });
    expect(payload.sandboxes[0]).toEqual({
      id: "sb-1",
      name: "dev-box",
      kind: "docker",
      updatedAt: now.toISOString(),
    });
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });
});
