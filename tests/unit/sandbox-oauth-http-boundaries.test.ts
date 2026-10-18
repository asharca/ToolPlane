// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  code: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    sandboxMcpOAuthClient: {
      findUnique: mocks.client,
      count: mocks.count,
      create: mocks.create,
    },
    sandboxMcpOAuthRefresh: { findUnique: mocks.refresh },
    sandboxMcpToken: { updateMany: mocks.revoke },
    sandboxMcpOAuthCode: { findUnique: mocks.code },
  },
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: vi.fn(),
}));
import { handleSandboxOAuth } from "@/lib/sandboxes/oauth-http";

const origin = "https://oauth-boundary.test";
const resource = `${origin}/api/v1/sandboxes/sandbox-1/mcp`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function post(
  action: "register" | "token" | "revoke",
  body: string,
  headers: Record<string, string> = {},
) {
  return handleSandboxOAuth(
    new Request(`${origin}/${action}`, {
      method: "POST",
      body,
      headers: {
        "content-type":
          action === "register"
            ? "application/json"
            : "application/x-www-form-urlencoded",
        ...headers,
      },
    }),
    action,
  );
}
async function errorResponse(
  response: Response,
  status: number,
  error: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  await expect(response.json()).resolves.toEqual({ error });
  if (status === 401)
    expect(response.headers.get("www-authenticate")).toBe(
      'Basic realm="toolplane-sandbox-oauth"',
    );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TOOLPLANE_PUBLIC_URL", origin);
  mocks.client.mockResolvedValue({
    id: "public-client",
    tokenEndpointAuthMethod: "none",
    redirectUris: ["https://client.test/callback"],
  });
  mocks.count.mockResolvedValue(0);
  mocks.create.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(null);
  mocks.revoke.mockResolvedValue({ count: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("sandbox OAuth HTTP trust boundaries", () => {
  it.each(["register", "token", "revoke", "authorize"] as const)(
    "rejects unsupported methods for %s",
    async (action) => {
      await errorResponse(
        await handleSandboxOAuth(
          new Request(`${origin}/${action}`, { method: "DELETE" }),
          action,
        ),
        405,
        "invalid_request",
      );
    },
  );
  it("rejects cross-origin writes before accessing stored credentials", async () => {
    await errorResponse(
      await post("token", "client_id=public-client", {
        origin: "https://evil.test",
      }),
      403,
      "access_denied",
    );
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each([
    ["client_id=public-client&client_id=other", {}, 400],
    ["client_id=public-client", { "content-type": "application/json" }, 415],
    [`x=${"a".repeat(16_384)}`, {}, 413],
  ] as const)("rejects malformed form input", async (body, headers, status) => {
    await errorResponse(
      await post("token", body, headers),
      status,
      "invalid_request",
    );
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each([
    ["Bearer private", "client_id=public-client"],
    [`Basic ${Buffer.from("no-colon").toString("base64")}`, ""],
    [`Basic ${Buffer.from("bad%ZZ:secret").toString("base64")}`, ""],
    [
      `Basic ${Buffer.from("different:secret").toString("base64")}`,
      "client_id=public-client",
    ],
    [
      `Basic ${Buffer.from("public-client:secret").toString("base64")}`,
      "client_secret=also-secret",
    ],
  ])(
    "rejects ambiguous or malformed authentication",
    async (authorization, body) => {
      await errorResponse(
        await post("token", body, { authorization }),
        401,
        "invalid_client",
      );
      expect(mocks.client).not.toHaveBeenCalled();
    },
  );
  it.each(["", `client_id=${"x".repeat(101)}`])(
    "rejects absent or oversized client identifiers",
    async (body) => {
      await errorResponse(await post("token", body), 401, "invalid_client");
    },
  );
  it("does not authenticate an unknown client", async () => {
    mocks.client.mockResolvedValue(null);
    await errorResponse(
      await post("token", "client_id=missing"),
      401,
      "invalid_client",
    );
  });
  it.each([
    ["none", "client_secret=unexpected", false],
    ["none", "", true],
    ["client_secret_basic", "client_secret=secret", false],
    ["client_secret_post", "", true],
    ["client_secret_post", "client_secret=wrong", false],
    ["client_secret_post", "", false],
  ])(
    "enforces the registered %s authentication method",
    async (method, extra, basic) => {
      mocks.client.mockResolvedValue({
        id: "public-client",
        tokenEndpointAuthMethod: method,
        secretHash: hash("secret"),
      });
      await errorResponse(
        await post(
          "token",
          `client_id=public-client&${extra}`,
          basic
            ? {
                authorization: `Basic ${Buffer.from("public-client:secret").toString("base64")}`,
              }
            : {},
        ),
        401,
        "invalid_client",
      );
    },
  );
  it.each(["client_secret_basic", "client_secret_post"])(
    "accepts correct %s credentials and still validates the resource",
    async (method) => {
      mocks.client.mockResolvedValue({
        id: "public-client",
        tokenEndpointAuthMethod: method,
        secretHash: hash("secret"),
      });
      const basic = method === "client_secret_basic";
      await errorResponse(
        await post(
          "token",
          `client_id=public-client${basic ? "" : "&client_secret=secret"}&resource=https://evil.test/mcp`,
          basic
            ? {
                authorization: `Basic ${Buffer.from("public-client:secret").toString("base64")}`,
              }
            : {},
        ),
        400,
        "invalid_target",
      );
    },
  );
  it("rejects unsupported grant types and unknown authorization codes", async () => {
    await errorResponse(
      await post(
        "token",
        new URLSearchParams({
          client_id: "public-client",
          resource,
          grant_type: "password",
        }).toString(),
      ),
      400,
      "unsupported_grant_type",
    );
    mocks.code.mockResolvedValue(null);
    await errorResponse(
      await post(
        "token",
        new URLSearchParams({
          client_id: "public-client",
          resource,
          grant_type: "authorization_code",
          code: "unknown",
        }).toString(),
      ),
      400,
      "invalid_grant",
    );
  });
  it.each([null, { grantId: "grant-1" }])(
    "revokes tokens without exposing whether they exist",
    async (refresh) => {
      mocks.refresh.mockResolvedValue(refresh);
      const response = await post(
        "revoke",
        "client_id=public-client&token=opaque-token",
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.revoke).toHaveBeenCalledWith({
        where: {
          oauthClientId: "public-client",
          OR: [
            { tokenHash: hash("opaque-token") },
            ...(refresh ? [{ id: "grant-1" }] : []),
          ],
        },
        data: { revokedAt: expect.any(Date) },
      });
    },
  );
  it("never redirects an authorization error to an unregistered callback", async () => {
    const response = await handleSandboxOAuth(
      new Request(
        `${origin}/authorize?client_id=public-client&redirect_uri=https://evil.test/callback`,
      ),
      "authorize",
    );
    await errorResponse(response, 400, "invalid_request");
    expect(response.headers.has("location")).toBe(false);
  });
  it("rejects duplicate authorization parameters before looking up clients", async () => {
    await errorResponse(
      await handleSandboxOAuth(
        new Request(
          `${origin}/authorize?client_id=one&client_id=two&redirect_uri=https://client.test/callback`,
        ),
        "authorize",
      ),
      400,
      "invalid_request",
    );
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each([
    { redirect_uris: ["http://external.test/callback"] },
    {
      redirect_uris: ["https://client.test/callback"],
      grant_types: ["refresh_token"],
    },
    { redirect_uris: [] },
  ])("rejects invalid client metadata", async (body) => {
    await errorResponse(
      await post("register", JSON.stringify(body)),
      400,
      "invalid_client_metadata",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuses registration at the stored client limit", async () => {
    mocks.count.mockResolvedValue(10_000);
    await errorResponse(
      await post(
        "register",
        JSON.stringify({ redirect_uris: ["https://client.test/callback"] }),
      ),
      429,
      "temporarily_unavailable",
    );
  });
  it.each(["none", "client_secret_post"])(
    "registers a %s client with hashed-only persisted secrets",
    async (method) => {
      const response = await post(
        "register",
        JSON.stringify({
          redirect_uris: [
            "https://client.test/callback",
            "https://client.test/callback",
          ],
          token_endpoint_auth_method: method,
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.client_id).toMatch(/^mcpsbc_/);
      expect(mocks.create).toHaveBeenCalledWith({
        data: {
          id: body.client_id,
          name: "MCP client",
          redirectUris: ["https://client.test/callback"],
          tokenEndpointAuthMethod: method,
          secretHash: method === "none" ? null : hash(body.client_secret),
        },
      });
      if (method === "none") expect(body).not.toHaveProperty("client_secret");
      else expect(body.client_secret_expires_at).toBe(0);
    },
  );
});
