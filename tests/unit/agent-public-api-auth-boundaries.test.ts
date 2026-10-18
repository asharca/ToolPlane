// @vitest-environment node
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  client: vi.fn(),
  key: vi.fn(),
  lookup: vi.fn(),
  touch: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
  attempt: vi.fn(),
  failure: vi.fn(),
  secret: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const db = {
    agentApiClient: { findFirst: m.client },
    agentApiKey: {
      findFirst: m.key,
      findUnique: m.lookup,
      updateMany: m.touch,
      create: m.create,
      findMany: m.list,
    },
  };
  return {
    db: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
  };
});
vi.mock("@/lib/runtime-env", () => ({ runtimeEnv: m.secret }));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: m.audit }));
vi.mock("@/lib/agents/public-api/rate-limit", () => ({
  takeAgentApiAuthAttemptLimit: m.attempt,
  takeAgentApiAuthFailureLimit: m.failure,
}));
import {
  createAgentApiKey,
  revokeAgentApiKey,
  verifyAgentApiKey,
  mintAgentClientToken,
  verifyAgentClientToken,
  resolveAgentApiPrincipal,
  resolveAgentApiPrincipalForAnyEndpoint,
  hashAgentApiSubject,
  hasAgentApiScope,
} from "@/lib/agents/public-api/auth";
const secret = "test-only-signing-key-for-public-api-auth";
const endpoint = {
  id: "endpoint",
  publicId: "public",
  workspaceId: "workspace",
  sourceAgentId: "source",
  currentRevisionId: "revision",
  allowedOrigins: ["https://example.com"],
  rpmLimit: 100,
  dailyRequestLimit: 1000,
  maxConcurrent: 5,
  timeoutSeconds: 2000,
  retentionDays: -1,
  sourceAgent: { workspaceId: "workspace" },
  workspace: { owner: { status: "active" } },
};
const client = {
  id: "client",
  scopes: ["responses:create", "responses:read"],
  rpmLimit: 10,
  dailyRequestLimit: 100,
  maxConcurrent: 2,
  endpoint,
};
const token = `tp_agent_${"a".repeat(43)}`;
const keyInput = {
  clientId: "client",
  endpointPublicId: "public",
  workspaceId: "workspace",
  sourceAgentId: "source",
  name: " Test ",
};
const mintInput = {
  endpointId: "endpoint",
  endpointPublicId: "public",
  clientId: "client",
  subject: "user",
  scopes: ["responses:create"],
  origin: "https://example.com",
};
const request = (credential: string | null = token, origin?: string) =>
  new Request("http://localhost", {
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(origin ? { origin } : {}),
    },
  });
async function signed(overrides: Record<string, unknown> = {}) {
  const issued = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "toolplane-agent-api",
    aud: "public",
    sub: "hash",
    iat: issued,
    exp: issued + 100,
    token_use: "agent_client",
    endpoint_id: "endpoint",
    endpoint_public_id: "public",
    client_id: "client",
    subject_hash: "hash",
    scopes: ["responses:create"],
    origin: null,
    ...overrides,
  };
  return `tp_client_${await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret))}`;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.secret.mockReturnValue(secret);
  m.client.mockResolvedValue(client);
  m.key.mockResolvedValue({ id: "key", client });
  m.lookup.mockResolvedValue({ client: { endpoint: { publicId: "public" } } });
  m.touch.mockResolvedValue({ count: 1 });
  m.create.mockResolvedValue({ id: "new-key", name: "Test" });
});
describe("API key lifecycle and policy", () => {
  it.each(["", " ", "x".repeat(101)])(
    "rejects invalid key names: %j",
    async (name) => {
      await expect(createAgentApiKey({ ...keyInput, name })).rejects.toThrow(
        "name is invalid",
      );
      expect(m.create).not.toHaveBeenCalled();
    },
  );
  it("rejects expired keys and missing workspace-bound clients", async () => {
    await expect(
      createAgentApiKey({ ...keyInput, expiresAt: new Date(0) }),
    ).rejects.toThrow("future");
    m.client.mockResolvedValue(null);
    await expect(createAgentApiKey(keyInput)).rejects.toThrow(
      "client not found",
    );
  });
  it("returns a one-time secret but persists only its hash and audited metadata", async () => {
    const result = await createAgentApiKey(keyInput);
    expect(result.token).toMatch(/^tp_agent_[\w-]{43}$/);
    expect(result.record).toEqual({ id: "new-key", name: "Test" });
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Test",
          expiresAt: null,
          tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(JSON.stringify(m.create.mock.calls)).not.toContain(result.token);
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: "system",
        action: "agentApiKey.created",
      }),
    );
  });
  it.each([0, 1])("audits only successful revocation (%s)", async (count) => {
    m.touch.mockResolvedValue({ count });
    expect(
      await revokeAgentApiKey({
        keyId: "key",
        endpointPublicId: "public",
        workspaceId: "workspace",
        sourceAgentId: "source",
      }),
    ).toBe(count === 1);
    expect(m.audit).toHaveBeenCalledTimes(count);
  });
  it.each([
    null,
    "Basic abc",
    "Bearer unknown",
    "Bearer tp_agent_short",
    "Bearer a,b",
  ])("rejects malformed permanent credentials: %s", async (authorization) => {
    expect(await verifyAgentApiKey(authorization, "public")).toBeNull();
    expect(m.key).not.toHaveBeenCalled();
  });
  it.each([
    "missing",
    "unpublished",
    "suspended",
    "foreign",
    "scope",
    "revoked-race",
  ])(
    "rejects unavailable credentials and scope boundaries: %s",
    async (condition) => {
      if (condition === "missing") m.key.mockResolvedValue(null);
      if (condition === "unpublished")
        m.key.mockResolvedValue({
          id: "key",
          client: {
            ...client,
            endpoint: { ...endpoint, currentRevisionId: null },
          },
        });
      if (condition === "suspended")
        m.key.mockResolvedValue({
          id: "key",
          client: {
            ...client,
            endpoint: {
              ...endpoint,
              workspace: { owner: { status: "disabled" } },
            },
          },
        });
      if (condition === "foreign")
        m.key.mockResolvedValue({
          id: "key",
          client: {
            ...client,
            endpoint: { ...endpoint, sourceAgent: { workspaceId: "foreign" } },
          },
        });
      if (condition === "revoked-race") m.touch.mockResolvedValue({ count: 0 });
      expect(
        await verifyAgentApiKey(
          `Bearer ${token}`,
          "public",
          condition === "scope" ? "conversations:delete" : "responses:create",
        ),
      ).toBeNull();
    },
  );
  it("uses the strictest limits and caps timeout and retention", async () => {
    expect(
      await verifyAgentApiKey(`Bearer ${token}`, "public", "responses:create"),
    ).toMatchObject({
      credentialType: "api_key",
      keyId: "key",
      workspaceId: "workspace",
      limits: {
        rpm: 10,
        dailyRequests: 100,
        maxConcurrent: 2,
        timeoutSeconds: 840,
        retentionDays: 0,
      },
    });
  });
  it("falls back safely when stored limits are invalid", async () => {
    m.key.mockResolvedValue({
      id: "key",
      client: {
        ...client,
        rpmLimit: 0,
        dailyRequestLimit: NaN,
        maxConcurrent: -1,
        endpoint: {
          ...endpoint,
          rpmLimit: -1,
          dailyRequestLimit: 0,
          maxConcurrent: 0,
          timeoutSeconds: 0,
        },
      },
    });
    expect(await verifyAgentApiKey(`Bearer ${token}`, "public")).toMatchObject({
      limits: {
        rpm: 1,
        dailyRequests: 1,
        maxConcurrent: 1,
        timeoutSeconds: 840,
      },
    });
  });
});
describe("scoped browser tokens with real signatures", () => {
  it.each([0, -1, 901, 1.5, NaN])(
    "rejects unsafe token lifetime %s",
    async (expiresInSeconds) => {
      await expect(
        mintAgentClientToken({ ...mintInput, expiresInSeconds }),
      ).rejects.toThrow("at most");
    },
  );
  it.each(["", "bad scope", "x".repeat(101)])(
    "rejects empty or invalid scopes: %j",
    async (scope) => {
      await expect(
        mintAgentClientToken({ ...mintInput, scopes: [scope] }),
      ).rejects.toThrow("at least one scope");
    },
  );
  it.each(["invalid", "https://example.com/path", "null"])(
    "rejects invalid bound origins: %s",
    async (origin) => {
      await expect(
        mintAgentClientToken({ ...mintInput, origin }),
      ).rejects.toThrow("origin");
    },
  );
  it.each(["client", "owner", "foreign", "scope", "origin"])(
    "refuses invalid grants: %s",
    async (condition) => {
      if (condition === "client") m.client.mockResolvedValue(null);
      if (condition === "owner")
        m.client.mockResolvedValue({
          ...client,
          endpoint: {
            ...endpoint,
            workspace: { owner: { status: "disabled" } },
          },
        });
      if (condition === "foreign")
        m.client.mockResolvedValue({
          ...client,
          endpoint: { ...endpoint, sourceAgent: { workspaceId: "foreign" } },
        });
      if (condition === "scope")
        m.client.mockResolvedValue({ ...client, scopes: [] });
      if (condition === "origin")
        m.client.mockResolvedValue({
          ...client,
          endpoint: { ...endpoint, allowedOrigins: [] },
        });
      await expect(mintAgentClientToken(mintInput)).rejects.toThrow();
    },
  );
  it("round-trips origin-bound tokens without exposing raw subject and enforces audience", async () => {
    const minted = await mintAgentClientToken({
      ...mintInput,
      scopes: [" responses:create ", "responses:create"],
    });
    expect(minted.token).not.toContain("user");
    expect(
      await verifyAgentClientToken(
        `Bearer ${minted.token}`,
        "public",
        "responses:create",
        "https://example.com",
      ),
    ).toMatchObject({
      credentialType: "client_token",
      clientId: "client",
      origin: "https://example.com",
      scopes: ["responses:create"],
    });
    expect(
      await verifyAgentClientToken(
        `Bearer ${minted.token}`,
        "foreign",
        undefined,
        "https://example.com",
      ),
    ).toBeNull();
  });
  it.each([
    { token_use: "other" },
    { endpoint_id: 1 },
    { endpoint_public_id: "foreign" },
    { client_id: null },
    { subject_hash: null },
    { sub: "mismatch" },
    { scopes: "responses:create" },
    { scopes: [false, 1] },
    { iat: null },
    { exp: null },
    { iat: 1, exp: 2 },
    { iat: 9999999999, exp: 10000000000 },
    { origin: false },
    { origin: "bad" },
  ])("rejects signed but invalid authorization claims: %j", async (claims) => {
    const credential = await signed(claims);
    expect(
      await verifyAgentClientToken(`Bearer ${credential}`, "public"),
    ).toBeNull();
    expect(m.client).not.toHaveBeenCalled();
  });
  it("rejects excessive signed lifetime even with valid JWT timestamps", async () => {
    const issued = Math.floor(Date.now() / 1000);
    expect(
      await verifyAgentClientToken(
        `Bearer ${await signed({ iat: issued, exp: issued + 901 })}`,
        "public",
      ),
    ).toBeNull();
  });
  it.each(["https://foreign.com", "invalid", null])(
    "enforces exact browser origin: %s",
    async (origin) => {
      const credential = await signed({ origin: "https://example.com" });
      expect(
        await verifyAgentClientToken(
          `Bearer ${credential}`,
          "public",
          undefined,
          origin,
        ),
      ).toBeNull();
    },
  );
  it.each([
    "missing",
    "unpublished",
    "owner",
    "foreign",
    "grant",
    "required",
    "origin",
  ])("rechecks current endpoint and client policy: %s", async (condition) => {
    if (condition === "missing") m.client.mockResolvedValue(null);
    if (condition === "unpublished")
      m.client.mockResolvedValue({
        ...client,
        endpoint: { ...endpoint, currentRevisionId: null },
      });
    if (condition === "owner")
      m.client.mockResolvedValue({
        ...client,
        endpoint: { ...endpoint, workspace: { owner: { status: "disabled" } } },
      });
    if (condition === "foreign")
      m.client.mockResolvedValue({
        ...client,
        endpoint: { ...endpoint, sourceAgent: { workspaceId: "foreign" } },
      });
    if (condition === "grant")
      m.client.mockResolvedValue({ ...client, scopes: [] });
    if (condition === "origin")
      m.client.mockResolvedValue({
        ...client,
        endpoint: { ...endpoint, allowedOrigins: [] },
      });
    const credential = await signed({ origin: "https://example.com" });
    expect(
      await verifyAgentClientToken(
        `Bearer ${credential}`,
        "public",
        condition === "required" ? "responses:read" : "responses:create",
        "https://example.com",
      ),
    ).toBeNull();
  });
  it("rejects bad signature and a missing server signing secret", async () => {
    const credential = await signed();
    m.secret.mockReturnValue("different");
    expect(
      await verifyAgentClientToken(`Bearer ${credential}`, "public"),
    ).toBeNull();
    m.secret.mockReturnValue(undefined);
    await expect(mintAgentClientToken(mintInput)).rejects.toThrow(
      "AUTH_SECRET",
    );
  });
  it.each([
    ["", "client", "user"],
    ["endpoint", "", "user"],
    ["endpoint", "client", " "],
    ["endpoint", "client", "x".repeat(201)],
  ])("rejects invalid subject namespaces", (endpointId, clientId, subject) => {
    expect(() => hashAgentApiSubject(endpointId, clientId, subject)).toThrow(
      "subject is invalid",
    );
  });
  it("namespaces the same end-user separately across clients and endpoints", () => {
    const hash = hashAgentApiSubject("endpoint", "client", " user ");
    expect(hash).toBe(hashAgentApiSubject("endpoint", "client", "user"));
    expect(hash).not.toBe(hashAgentApiSubject("other", "client", "user"));
    expect(hash).not.toBe(hashAgentApiSubject("endpoint", "other", "user"));
  });
  it.each([
    [[], undefined, true],
    [["*"], ["responses:create", "responses:read"], true],
    [["responses:create"], "responses:read", false],
    [["*"], "bad scope", false],
  ] as const)(
    "requires every valid requested scope",
    (scopes, required, allowed) => {
      expect(hasAgentApiScope(scopes, required)).toBe(allowed);
    },
  );
});
describe("credential resolution and untrusted endpoint hints", () => {
  it.each([null, "unknown", "tp_agent_short"])(
    "charges failed authentication attempts: %s",
    async (credential) => {
      expect(
        await resolveAgentApiPrincipal(request(credential), "public"),
      ).toBeNull();
      expect(
        await resolveAgentApiPrincipalForAnyEndpoint(request(credential)),
      ).toBeNull();
      expect(m.attempt).toHaveBeenCalledTimes(2);
      expect(m.failure).toHaveBeenCalledTimes(2);
    },
  );
  it("never accepts permanent keys from browser-origin requests", async () => {
    expect(
      await resolveAgentApiPrincipal(
        request(token, "https://example.com"),
        "public",
      ),
    ).toBeNull();
    expect(
      await resolveAgentApiPrincipalForAnyEndpoint(
        request(token, "https://example.com"),
      ),
    ).toBeNull();
    expect(m.key).not.toHaveBeenCalled();
  });
  it("resolves a key hint only through a second fully scoped verification", async () => {
    expect(
      await resolveAgentApiPrincipalForAnyEndpoint(request()),
    ).toMatchObject({ endpointPublicId: "public", keyId: "key" });
    m.key.mockResolvedValue(null);
    expect(await resolveAgentApiPrincipalForAnyEndpoint(request())).toBeNull();
    m.lookup.mockResolvedValue(null);
    expect(await resolveAgentApiPrincipalForAnyEndpoint(request())).toBeNull();
    expect(m.failure).toHaveBeenCalledTimes(2);
  });
  it("charges a failed scoped key check", async () => {
    m.touch.mockResolvedValue({ count: 0 });
    expect(await resolveAgentApiPrincipal(request(), "public")).toBeNull();
    expect(m.failure).toHaveBeenCalledTimes(1);
  });
  it("resolves signed client endpoint hints but rejects missing, malformed and forged hints", async () => {
    const credential = await signed();
    expect(
      await resolveAgentApiPrincipal(request(credential), "public"),
    ).toMatchObject({ credentialType: "client_token" });
    expect(
      await resolveAgentApiPrincipalForAnyEndpoint(request(credential)),
    ).toMatchObject({ endpointPublicId: "public" });
    for (const invalid of [
      "tp_client_not-jwt",
      await signed({ endpoint_public_id: 1 }),
      await signed({ endpoint_id: null }),
    ])
      expect(
        await resolveAgentApiPrincipalForAnyEndpoint(request(invalid)),
      ).toBeNull();
    expect(m.failure).toHaveBeenCalledTimes(3);
  });
  it("charges rejected signed browser tokens", async () => {
    expect(
      await resolveAgentApiPrincipal(
        request(await signed({ token_use: "other" })),
        "public",
      ),
    ).toBeNull();
    expect(m.failure).toHaveBeenCalledTimes(1);
  });
});
