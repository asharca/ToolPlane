// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
  agent: vi.fn(),
  deployments: vi.fn(),
  skills: vi.fn(),
  digest: vi.fn(),
  transaction: vi.fn(),
  endpoint: vi.fn(),
  createEndpoint: vi.fn(),
  updateEndpoint: vi.fn(),
  revision: vi.fn(),
  createRevision: vi.fn(),
  runs: vi.fn(),
  updateRuns: vi.fn(),
  client: vi.fn(),
  createClient: vi.fn(),
  key: vi.fn(),
  revoke: vi.fn(),
  mint: vi.fn(),
  abort: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: m.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/sandboxes/runtime", () => ({
  resolveDockerImageDigest: m.digest,
}));
vi.mock("@/lib/agents/public-api/auth", () => ({
  AGENT_API_MAX_TIMEOUT_SECONDS: 600,
  createAgentApiKey: m.key,
  revokeAgentApiKey: m.revoke,
  mintAgentClientToken: m.mint,
}));
vi.mock("@/lib/agents/public-api/run-control", () => ({
  abortAgentApiRun: m.abort,
}));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findUnique: m.member },
    agent: { findFirst: m.agent },
    deployment: { findMany: m.deployments },
    installedSkill: { findMany: m.skills },
    agentEndpoint: {
      findFirst: m.endpoint,
      findUnique: m.endpoint,
      create: m.createEndpoint,
      update: m.updateEndpoint,
    },
    agentEndpointRevision: { aggregate: m.revision, create: m.createRevision },
    agentRun: { findMany: m.runs, updateMany: m.updateRuns },
    agentApiClient: { findFirst: m.client, create: m.createClient },
    $transaction: m.transaction,
  },
}));
import { db } from "@/lib/db";
import {
  publishAgentEndpointAction as publish,
  setAgentEndpointStatusAction as setStatus,
  createAgentApiClientAction as createClient,
  createAgentApiKeyAction as createKey,
  revokeAgentApiKeyAction as revoke,
  createAgentClientTokenAction as mint,
} from "@/lib/agents/public-api/actions";
const image = "nousresearch/hermes-agent:v2026.8.3";
const pinned = `nousresearch/hermes-agent@sha256:${"a".repeat(64)}`;
function form(overrides: Record<string, string | string[] | undefined> = {}) {
  const data = new FormData();
  const values: Record<string, string | string[] | undefined> = {
    workspace: "team",
    agentId: "agent",
    endpointId: "public",
    clientId: "client",
    name: " Release API ",
    systemPrompt: " Be helpful ",
    rpmLimit: "60",
    dailyRequestLimit: "1000",
    dailyOutputCharacterLimit: "200000",
    maxConcurrent: "2",
    maxRuntimes: "10",
    maxStoredCharacters: "220000",
    timeoutSeconds: "60",
    retentionDays: "30",
    allowedOrigins: "https://example.com",
    deploymentIds: [" mcp ", "mcp", ""],
    skillIds: ["skill"],
    subject: " browser-user ",
    origin: "https://example.com",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      data.append(key, item);
  }
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "owner" });
  m.workspace.mockResolvedValue({ id: "workspace", ownerId: "owner" });
  m.agent.mockResolvedValue({
    id: "agent",
    maxSteps: 40,
    runtime: { kind: "hermes", image },
    modelProviders: [{ providerId: "provider" }],
  });
  m.digest.mockResolvedValue(pinned);
  m.deployments.mockResolvedValue([
    {
      id: "mcp",
      publicInvocable: true,
      mcpToolExposure: "allowlist",
      mcpAllowedTools: ["write", "read", "read"],
    },
  ]);
  m.skills.mockResolvedValue([{ id: "skill" }]);
  m.endpoint.mockResolvedValue({
    id: "endpoint",
    publicId: "public",
    rpmLimit: 60,
    dailyRequestLimit: 1000,
    dailyOutputCharacterLimit: 200000,
    maxConcurrent: 2,
    maxStoredCharacters: 220000,
  });
  m.createEndpoint.mockResolvedValue({
    id: "endpoint",
    publicId: "new-public",
  });
  m.revision.mockResolvedValue({ _max: { version: 2 } });
  m.createRevision.mockResolvedValue({ id: "revision" });
  m.transaction.mockImplementation(async (callback) => callback(db));
  m.runs.mockResolvedValue([{ id: "run-db", publicId: "run-public" }]);
  m.client.mockResolvedValue({
    id: "client",
    endpoint: {
      id: "endpoint",
      publicId: "public",
      allowedOrigins: ["https://example.com"],
    },
  });
  m.createClient.mockResolvedValue({ id: "client" });
  m.key.mockResolvedValue({ token: "new-secret" });
  m.mint.mockResolvedValue({
    token: "browser-secret",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
});

describe("Agent API publication", () => {
  it.each([
    { agentId: "" },
    { name: "" },
    { name: "x".repeat(81) },
    { systemPrompt: "x".repeat(20001) },
    { rpmLimit: "0" },
    { dailyRequestLimit: "1000001" },
    { dailyOutputCharacterLimit: "199999" },
    { maxConcurrent: "1.5" },
    { maxRuntimes: "1001" },
    { maxStoredCharacters: "1" },
    { timeoutSeconds: "9" },
    { retentionDays: "366" },
    { allowedOrigins: "https://example.com/path" },
    {
      allowedOrigins: Array.from(
        { length: 51 },
        (_, i) => `https://site${i}.com`,
      ).join(","),
    },
  ])("rejects invalid public boundary configuration: %j", async (values) => {
    expect(await publish({}, form(values))).toEqual({
      error: "The Agent API configuration is invalid.",
    });
    expect(m.agent).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("allows only owners or admins to publish", async () => {
    m.user.mockResolvedValueOnce(null);
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "Only a workspace owner or administrator can publish an Agent API.",
    );
    m.workspace.mockResolvedValueOnce(null);
    expect(await publish({}, form())).toHaveProperty("error");
    m.workspace.mockResolvedValue({ id: "workspace", ownerId: "other" });
    m.member
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ role: "admin" });
    expect(await publish({}, form())).toHaveProperty("error");
    expect(await publish({}, form())).toHaveProperty("error");
    expect(await publish({}, form())).toMatchObject({
      success: true,
      endpointId: "public",
    });
    expect(m.member).toHaveBeenCalledWith({
      where: {
        workspaceId_userId: { workspaceId: "workspace", userId: "owner" },
      },
      select: { role: true },
    });
  });
  it("requires a workspace Hermes agent, reviewed immutable image and providers", async () => {
    m.agent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ runtime: { kind: "pi" } });
    for (let i = 0; i < 2; i++)
      expect(await publish({}, form())).toEqual({
        error: "Only a Hermes Agent can be published.",
      });
    m.agent.mockResolvedValueOnce({
      runtime: { kind: "hermes", image: "untrusted:latest" },
    });
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "Public Agent APIs require a reviewed versioned Hermes image or an operator-allowlisted digest.",
    );
    m.digest.mockRejectedValueOnce(new Error("registry offline"));
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "The reviewed Hermes image could not be pulled and pinned to a registry digest.",
    );
    m.digest.mockResolvedValueOnce(image);
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "The Hermes image registry did not return an approved immutable digest.",
    );
    m.agent.mockResolvedValueOnce({
      runtime: { kind: "hermes", image },
      modelProviders: [],
    });
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "Select at least one model provider before publishing.",
    );
    expect(m.agent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "agent",
          workspaceId: "workspace",
          publicRuntimeAllocation: { is: null },
        },
      }),
    );
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("rejects unavailable or unsafe deployments and non-invocable skills", async () => {
    m.deployments.mockResolvedValueOnce([]);
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "One or more MCP deployments are unavailable.",
    );
    for (const unsafe of [
      {
        publicInvocable: false,
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["read"],
      },
      {
        publicInvocable: true,
        mcpToolExposure: "all",
        mcpAllowedTools: ["read"],
      },
      {
        publicInvocable: true,
        mcpToolExposure: "allowlist",
        mcpAllowedTools: [],
      },
    ]) {
      m.deployments.mockResolvedValueOnce([{ id: "mcp", ...unsafe }]);
      expect(await publish({}, form())).toHaveProperty(
        "error",
        "Every public MCP deployment must be explicitly approved for public Agents and use a non-empty tool allowlist.",
      );
    }
    m.skills.mockResolvedValueOnce([]);
    expect(await publish({}, form())).toHaveProperty(
      "error",
      "One or more selected skills are unavailable or not Agent-invocable.",
    );
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("publishes a versioned snapshot with deduplicated policy and normalized origins", async () => {
    const result = await publish(
      {},
      form({
        isolationMode: "shared",
        allowedOrigins:
          "https://example.com,https://example.com\nhttps://other.com",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      endpointId: "public",
      savedAt: expect.any(String),
    });
    expect(m.updateEndpoint).toHaveBeenCalledWith({
      where: { id: "endpoint" },
      data: expect.objectContaining({
        name: "Release API",
        isolationMode: "shared",
        allowedOrigins: ["https://example.com", "https://other.com"],
      }),
    });
    expect(m.createRevision).toHaveBeenCalledWith({
      data: {
        endpointId: "endpoint",
        version: 3,
        systemPrompt: "Be helpful",
        maxSteps: 20,
        runtimeImage: pinned,
        providerIds: ["provider"],
        deploymentIds: ["mcp"],
        installedSkillIds: ["skill"],
        toolPolicy: { mcp: ["read", "write"] },
      },
      select: { id: true },
    });
    expect(m.updateEndpoint).toHaveBeenLastCalledWith({
      where: { id: "endpoint" },
      data: { currentRevisionId: "revision" },
    });
    expect(m.revalidate).toHaveBeenCalledWith("/app/team/agents/agent");
  });
  it("creates new endpoints disabled and starts revision numbering at one", async () => {
    m.endpoint.mockResolvedValue(null);
    m.revision.mockResolvedValue({ _max: { version: null } });
    expect(await publish({}, form())).toMatchObject({
      success: true,
      endpointId: "new-public",
    });
    expect(m.createEndpoint).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "disabled",
        isolationMode: "subject",
        workspaceId: "workspace",
        createdById: "owner",
        sourceAgentId: "agent",
      }),
      select: { id: true, publicId: true },
    });
    expect(m.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 1 }),
      }),
    );
  });
  it("reports transactional failures without announcing a successful publication", async () => {
    m.transaction.mockRejectedValue(new Error("serialization"));
    expect(await publish({}, form())).toEqual({
      error: "The endpoint could not be published. Retry the request.",
    });
    expect(m.revalidate).not.toHaveBeenCalled();
  });
});

describe("Agent API access management", () => {
  it("disabling an endpoint cancels all active runs; enabling requires a revision", async () => {
    await setStatus(form({ status: "disabled" }));
    expect(m.updateEndpoint).toHaveBeenCalledWith({
      where: { id: "endpoint" },
      data: { status: "disabled" },
    });
    expect(m.updateRuns).toHaveBeenCalledWith({
      where: { id: { in: ["run-db"] } },
      data: { cancelRequestedAt: expect.any(Date) },
    });
    expect(m.abort).toHaveBeenCalledWith("run-public");
    m.runs.mockClear();
    await setStatus(form({ status: "active" }));
    expect(m.endpoint).toHaveBeenLastCalledWith({
      where: {
        publicId: "public",
        workspaceId: "workspace",
        sourceAgentId: "agent",
        currentRevisionId: { not: null },
      },
      select: { id: true },
    });
    expect(m.runs).not.toHaveBeenCalled();
  });
  it("does not mutate statuses outside management scope or for unknown endpoints", async () => {
    m.user.mockResolvedValueOnce(null);
    await setStatus(form());
    m.endpoint.mockResolvedValueOnce(null);
    await setStatus(form());
    expect(m.updateEndpoint).not.toHaveBeenCalled();
  });
  it("validates client and key names and conceals inaccessible entities", async () => {
    for (const name of ["", "x".repeat(81)]) {
      expect(await createClient({}, form({ name }))).toEqual({
        error: "Client name is required.",
      });
      expect(await createKey({}, form({ name }))).toEqual({
        error: "Key name is required.",
      });
    }
    expect(await createKey({}, form({ clientId: "" }))).toHaveProperty("error");
    m.user.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await createClient({}, form())).toEqual({
      error: "Not authorized.",
    });
    expect(await createKey({}, form())).toEqual({ error: "Not authorized." });
    m.endpoint.mockResolvedValueOnce(null);
    expect(await createClient({}, form())).toEqual({
      error: "Endpoint not found.",
    });
    m.client.mockResolvedValueOnce(null);
    expect(await createKey({}, form())).toEqual({
      error: "API client not found.",
    });
    expect(m.key).not.toHaveBeenCalled();
  });
  it("creates clients with endpoint limits and reveals the newly issued key", async () => {
    expect(await createClient({}, form())).toMatchObject({
      success: true,
      clientId: "client",
      token: "new-secret",
    });
    expect(m.createClient).toHaveBeenCalledWith({
      data: {
        endpointId: "endpoint",
        createdById: "owner",
        name: "Release API",
        rpmLimit: 60,
        dailyRequestLimit: 1000,
        dailyOutputCharacterLimit: 200000,
        maxConcurrent: 2,
        maxStoredCharacters: 220000,
      },
      select: { id: true },
    });
    expect(m.key).toHaveBeenCalledWith({
      actorId: "owner",
      clientId: "client",
      endpointPublicId: "public",
      workspaceId: "workspace",
      sourceAgentId: "agent",
      name: "Default",
    });
  });
  it("issues scoped named keys and handles key creation failure", async () => {
    expect(await createKey({}, form())).toMatchObject({
      success: true,
      clientId: "client",
      token: "new-secret",
    });
    expect(m.client).toHaveBeenCalledWith({
      where: {
        id: "client",
        status: "active",
        endpoint: {
          publicId: "public",
          workspaceId: "workspace",
          sourceAgentId: "agent",
        },
      },
      select: { id: true },
    });
    m.key.mockRejectedValueOnce(new Error("key store"));
    expect(await createKey({}, form())).toEqual({
      error: "The API key could not be created.",
    });
  });
  it("revokes only under management authorization", async () => {
    m.user.mockResolvedValueOnce(null);
    await revoke(form({ keyId: "key" }));
    expect(m.revoke).not.toHaveBeenCalled();
    await revoke(form({ keyId: "key" }));
    expect(m.revoke).toHaveBeenCalledWith({
      actorId: "owner",
      keyId: "key",
      endpointPublicId: "public",
      workspaceId: "workspace",
      sourceAgentId: "agent",
    });
  });
  it("requires a valid browser subject, active scoped client and allowlisted origin", async () => {
    for (const values of [
      { clientId: "" },
      { subject: " " },
      { subject: "x".repeat(201) },
      { origin: "https://example.com/path" },
    ])
      expect(await mint({}, form(values))).toHaveProperty(
        "error",
        "Client, subject and an allowed browser origin are required.",
      );
    m.user.mockResolvedValueOnce(null);
    expect(await mint({}, form())).toEqual({ error: "Not authorized." });
    m.client.mockResolvedValueOnce(null);
    expect(await mint({}, form())).toEqual({ error: "API client not found." });
    expect(await mint({}, form({ origin: "https://foreign.com" }))).toEqual({
      error: "The selected browser origin is not allowed by this endpoint.",
    });
    expect(m.mint).not.toHaveBeenCalled();
  });
  it("mints a fifteen-minute browser token with explicit conversation and response scopes", async () => {
    expect(await mint({}, form())).toEqual({
      success: true,
      token: "browser-secret",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(m.mint).toHaveBeenCalledWith({
      endpointId: "endpoint",
      endpointPublicId: "public",
      clientId: "client",
      subject: "browser-user",
      scopes: [
        "responses:create",
        "responses:read",
        "conversations:read",
        "conversations:delete",
      ],
      expiresInSeconds: 900,
      origin: "https://example.com",
    });
  });
});
