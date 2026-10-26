// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
  agent: vi.fn(),
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
  m.agent.mockResolvedValue({ id: "agent", runtimeKind: "pi-sdk" });
  m.endpoint.mockResolvedValue({
    id: "endpoint",
    publicId: "public",
    sourceAgent: { runtimeKind: "pi-sdk" },
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
  it.each(["pi", "pi-sdk", "claude-code", "dsh"])(
    "rejects unsupported %s publication before creating records",
    async (runtimeKind) => {
      m.agent.mockResolvedValue({ runtimeKind });
      expect(await publish({}, form())).toEqual({
        error: "This Agent runtime does not support public endpoint execution.",
      });
      expect(m.transaction).not.toHaveBeenCalled();
      expect(m.createEndpoint).not.toHaveBeenCalled();
      expect(m.createRevision).not.toHaveBeenCalled();
    },
  );
  it("requires owner or administrator access", async () => {
    m.user.mockResolvedValue(null);
    expect(await publish({}, form())).toHaveProperty("error");
    expect(m.agent).not.toHaveBeenCalled();
  });
  it("conceals an inaccessible source agent", async () => {
    m.agent.mockResolvedValue(null);
    expect(await publish({}, form())).toEqual({ error: "Agent not found." });
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
    await expect(setStatus(form({ status: "active" }))).rejects.toMatchObject({
      code: "runtime_unsupported",
      status: 409,
    });
    expect(m.updateEndpoint).toHaveBeenCalledTimes(1);
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
      { origin: "https://example.com?query=1" },
      { origin: "https://example.com#fragment" },
      { origin: "https://user:password@example.com" },
      { origin: "file:///example.com" },
      { origin: "null" },
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
  it("normalizes browser origins consistently with the stored allowlist", async () => {
    m.client.mockResolvedValue({
      id: "client",
      endpoint: {
        id: "endpoint",
        publicId: "public",
        allowedOrigins: ["https://EXAMPLE.com:443/"],
      },
    });
    expect(
      await mint({}, form({ origin: "https://EXAMPLE.com:443/" })),
    ).toHaveProperty("success", true);
    expect(m.mint).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://example.com" }),
    );
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
