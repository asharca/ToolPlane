// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentMarket from "@/lib/agents/market";
import type * as ChatService from "@/lib/chat/service";
import type * as MarketSkills from "@/lib/market/skills";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  release: vi.fn(),
  agentRelease: vi.fn(),
  agents: vi.fn(),
  assistants: vi.fn(),
  installs: vi.fn(),
  materialize: vi.fn(),
  assistant: vi.fn(),
  install: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAccountRequestUser: m.user,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/db", () => ({
  db: {
    marketRelease: { findUnique: m.release },
    agentRelease: { findUnique: m.agentRelease },
    agentInstall: { findMany: m.agents },
    chatAssistant: { findMany: m.assistants },
  },
}));
vi.mock("@/lib/agents/market", async (original) => ({
  ...(await original<typeof AgentMarket>()),
  materializeAgentRelease: m.materialize,
}));
vi.mock("@/lib/chat/service", async (original) => ({
  ...(await original<typeof ChatService>()),
  installAssistantMarketRelease: m.assistant,
}));
vi.mock("@/lib/market/skills", async (original) => ({
  ...(await original<typeof MarketSkills>()),
  listWorkspaceMarketInstalls: m.installs,
}));
vi.mock("@/lib/market/resources", () => ({ installMarketRelease: m.install }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import {
  AgentMarketError,
  type AgentMarketErrorCode,
} from "@/lib/agents/market";
import { ChatServiceError } from "@/lib/chat/service";
import {
  GET,
  POST,
} from "@/app/api/v1/workspaces/[slug]/market/installs/route";
const ctx = { params: Promise.resolve({ slug: "team" }) };
function request(body: unknown = { releaseId: "release" }) {
  return new Request("https://test/api", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const date = new Date("2026-01-01");
const listing = {
  id: "listing",
  kind: "skill",
  status: "published",
  latestRelease: { id: "new", version: "2" },
};
describe("market installation dispatch and output policies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.user.mockResolvedValue({ id: "user" });
    m.workspace.mockResolvedValue({ id: "ws" });
    m.release.mockResolvedValue({ listing: { kind: "skill" } });
    m.agentRelease.mockResolvedValue(null);
    m.installs.mockResolvedValue([]);
    m.agents.mockResolvedValue([]);
    m.assistants.mockResolvedValue([]);
    m.install.mockResolvedValue({
      install: { id: "install", status: "ready" },
      resource: { id: "resource" },
      kind: "skill",
      reused: false,
    });
  });
  it.each(["user", "workspace"] as const)(
    "denies collection access without %s",
    async (missing) => {
      m[missing].mockResolvedValue(null);
      expect((await GET(new Request("https://test/api"), ctx)).status).toBe(
        401,
      );
      expect((await POST(request(), ctx)).status).toBe(401);
      expect(m.release).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { releaseId: "" },
    { releaseId: "release", extra: true },
    { releaseId: "release", maxSteps: 0 },
    {
      releaseId: "release",
      mcpBindings: { Invalid: { deploymentId: "dep", tools: [] } },
    },
  ])("validates install body %j", async (body) => {
    expect((await POST(request(body), ctx)).status).toBe(400);
    expect(m.install).not.toHaveBeenCalled();
  });
  it("returns missing release and unsupported-kind errors", async () => {
    m.release.mockResolvedValueOnce(null);
    expect((await POST(request(), ctx)).status).toBe(404);
    m.release.mockResolvedValueOnce({ listing: { kind: "unknown" } });
    expect((await POST(request(), ctx)).status).toBe(422);
  });
  it.each(["skill", "mcp", "toolkit", "pi-package"])(
    "serializes %s installation identifiers and bindings",
    async (kind) => {
      m.release.mockResolvedValue({ listing: { kind } });
      m.install.mockResolvedValue({
        install: { id: "install", status: "ready" },
        resource: { id: "resource" },
        kind,
        reused: true,
      });
      const response = await POST(
        request({
          releaseId: "release",
          idempotencyKey: "key",
          mcpBindings: { search: { deploymentId: "dep", tools: ["find"] } },
        }),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        installId: "install",
        kind,
        resourceId: kind === "pi-package" ? null : "resource",
        ...(kind === "skill"
          ? { installedSkillId: "resource" }
          : kind === "mcp"
            ? { deploymentId: "resource" }
            : kind === "toolkit"
              ? { toolkitId: "resource" }
              : {}),
        status: "ready",
        reused: true,
      });
      expect(m.install).toHaveBeenCalledWith({
        releaseId: "release",
        idempotencyKey: "key",
        targetWorkspaceId: "ws",
        installedById: "user",
        mcpBindings: { search: { deploymentId: "dep", tools: ["find"] } },
      });
    },
  );
  it.each([false, true])(
    "serializes materialized agent installation with reused=%s",
    async (reused) => {
      m.release.mockResolvedValue(null);
      m.agentRelease.mockResolvedValue({ id: "release" });
      m.materialize.mockResolvedValue({
        install: { id: "install", status: "ready" },
        agent: { id: "agent" },
        reused,
      });
      const response = await POST(
        request({ releaseId: "release", name: " Named " }),
        ctx,
      );
      expect(response.status).toBe(reused ? 200 : 201);
      expect(await response.json()).toEqual({
        installId: "agent:install",
        kind: "agent",
        resourceId: "agent",
        agentId: "agent",
        status: "ready",
        reused,
      });
      expect(m.materialize).toHaveBeenCalledWith({
        releaseId: "release",
        targetWorkspaceId: "ws",
        name: "Named",
        idempotencyKey: expect.any(String),
        installedById: "user",
      });
    },
  );
  it("normalizes assistant options and deduplicates selected deployments", async () => {
    m.release.mockResolvedValue({ listing: { kind: "assistant" } });
    m.assistant.mockResolvedValue({ id: "assistant" });
    const response = await POST(
      request({
        releaseId: "release",
        name: " Name ",
        systemPrompt: null,
        modelProviderId: " provider ",
        model: null,
        deploymentIds: ["dep", "dep"],
      }),
      ctx,
    );
    expect(response.status).toBe(201);
    expect(m.assistant).toHaveBeenCalledWith(
      "user",
      expect.objectContaining({
        workspaceId: "ws",
        name: "Name",
        systemPrompt: null,
        modelProviderId: "provider",
        model: null,
        deploymentIds: ["dep"],
      }),
    );
  });
  it("maps assistant service errors", async () => {
    m.release.mockResolvedValue({ listing: { kind: "assistant" } });
    m.assistant.mockRejectedValue(new ChatServiceError(409, "Conflict"));
    const response = await POST(request(), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Conflict",
      code: "assistant_install_failed",
    });
  });
  it.each<[AgentMarketErrorCode, number]>([
    ["not_authorized", 403],
    ["release_not_found", 404],
    ["target_workspace_not_found", 404],
    ["invalid_manifest", 422],
    ["invalid_categories", 422],
    ["not_portable", 422],
    ["install_failed", 409],
  ])("maps materializer error %s", async (code, status) => {
    m.release.mockResolvedValue(null);
    m.agentRelease.mockResolvedValue({ id: "release" });
    m.materialize.mockRejectedValue(new AgentMarketError(code, "Denied"));
    const response = await POST(request(), ctx);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Denied", code });
  });
  it("hides unexpected installer error details", async () => {
    m.install.mockRejectedValue(new Error("secret"));
    const response = await POST(request(), ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Market operation failed.",
    });
  });
  it("combines typed installs with correct resource precedence and package metadata", async () => {
    const base = {
      id: "install",
      status: "ready",
      listing,
      currentRelease: { id: "old" },
      updateAvailable: false,
      createdAt: date,
      updatedAt: date,
    };
    m.installs.mockResolvedValue([
      {
        ...base,
        deploymentId: "dep",
        installedSkillId: "skill",
        toolkitId: "kit",
        agentId: "agent",
      },
      {
        ...base,
        id: "skill-install",
        deploymentId: null,
        installedSkillId: "skill",
      },
      {
        ...base,
        id: "kit-install",
        deploymentId: null,
        installedSkillId: null,
        toolkitId: "kit",
      },
      {
        ...base,
        id: "agent-install",
        deploymentId: null,
        installedSkillId: null,
        toolkitId: null,
        agentId: "agent",
      },
      {
        ...base,
        id: "package",
        listing: { ...listing, kind: "pi-package" },
        piPackage: { id: "pi" },
        agentPiPackages: [],
      },
    ]);
    const body = await (await GET(new Request("https://test/api"), ctx)).json();
    expect(
      body.items.map((item: { resourceId?: string }) => item.resourceId),
    ).toEqual(["dep", "skill", "kit", "agent", undefined]);
    expect(body.items[4]).toMatchObject({
      piPackage: { id: "pi" },
      agentPiPackages: [],
    });
  });
  it.each([
    { status: "published", latestRelease: { id: "new" }, update: true },
    { status: "draft", latestRelease: { id: "new" }, update: false },
    { status: "published", latestRelease: null, update: false },
    { status: "published", latestRelease: { id: "old" }, update: false },
  ])(
    "reports updates only for newer published releases %j",
    async ({ status, latestRelease, update }) => {
      const release = {
        id: "old",
        version: "1",
        listing: { ...listing, status, latestRelease },
      };
      m.agents.mockResolvedValue([
        { id: "install", release, agent: null, status: "ready" },
      ]);
      m.assistants.mockResolvedValue([
        { id: "assistant", name: "Assistant", marketTemplateRelease: release },
        { id: "local", marketTemplateRelease: null },
      ]);
      const body = await (
        await GET(new Request("https://test/api"), ctx)
      ).json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toMatchObject({
        id: "agent:install",
        resourceId: null,
        updateAvailable: update,
      });
      expect(body.items[1]).toMatchObject({
        id: "assistant:assistant",
        resourceId: "assistant",
        updateAvailable: update,
      });
    },
  );
});
