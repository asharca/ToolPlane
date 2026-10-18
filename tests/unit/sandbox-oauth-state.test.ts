// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  code: vi.fn(),
  consumeCode: vi.fn(),
  createCode: vi.fn(),
  deleteCodes: vi.fn(),
  refresh: vi.fn(),
  consumeRefresh: vi.fn(),
  createRefresh: vi.fn(),
  createToken: vi.fn(),
  lock: vi.fn(),
  update: vi.fn(),
  owned: vi.fn(),
  principal: vi.fn(),
  begin: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    sandboxMcpOAuthClient: { findUnique: mocks.client },
    sandboxMcpOAuthCode: {
      findUnique: mocks.code,
      create: mocks.createCode,
      deleteMany: mocks.deleteCodes,
    },
    sandboxMcpOAuthRefresh: { findUnique: mocks.refresh },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        sandboxMcpOAuthCode: { updateMany: mocks.consumeCode },
        sandboxMcpOAuthRefresh: {
          updateMany: mocks.consumeRefresh,
          create: mocks.createRefresh,
        },
        sandboxMcpToken: {
          create: mocks.createToken,
          updateMany: mocks.lock,
          update: mocks.update,
        },
      }),
  },
}));
vi.mock("@/lib/sandboxes/mcp-access", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ownedSandbox: mocks.owned,
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: mocks.principal,
}));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: mocks.begin,
}));
import { handleSandboxOAuth } from "@/lib/sandboxes/oauth-http";
const origin = "https://oauth-state.test";
const resource = `${origin}/api/v1/sandboxes/sandbox-1/mcp`;
const redirect = "https://client.test/callback";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
function authorization(overrides: Record<string, string> = {}) {
  return new Request(
    `${origin}/authorize?${new URLSearchParams({ client_id: "client", redirect_uri: redirect, resource, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "sandbox:read sandbox:write sandbox:execute offline_access", state: "opaque-state", ...overrides })}`,
  );
}
function exchange(
  grant = "authorization_code",
  overrides: Record<string, string> = {},
) {
  return handleSandboxOAuth(
    new Request(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "client",
        resource,
        grant_type: grant,
        code: "authorization-code",
        redirect_uri: redirect,
        code_verifier: verifier,
        refresh_token: "refresh-token",
        ...overrides,
      }),
    }),
    "token",
  );
}
function codeRecord(overrides: Record<string, unknown> = {}) {
  return {
    codeHash: "code-hash",
    clientId: "client",
    sandboxId: "sandbox-1",
    userId: "user",
    resource,
    redirectUri: redirect,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60000),
    codeChallenge: challenge,
    scopes: ["sandbox:read", "offline_access"],
    ...overrides,
  };
}
function refreshRecord(
  overrides: Record<string, unknown> = {},
  grantOverrides: Record<string, unknown> = {},
) {
  return {
    tokenHash: "refresh-hash",
    expiresAt: new Date(Date.now() + 120000),
    consumedAt: null,
    grant: {
      id: "grant",
      oauthClientId: "client",
      oauthResource: resource,
      sandboxId: "sandbox-1",
      userId: "user",
      revokedAt: null,
      oauthExpiresAt: new Date(Date.now() + 120000),
      oauthScopes: ["sandbox:read", "sandbox:write", "offline_access"],
      ...grantOverrides,
    },
    ...overrides,
  };
}
async function consentForm(
  decision = "allow",
  scopes = ["sandbox:read", "offline_access"],
) {
  const response = await handleSandboxOAuth(authorization(), "authorize");
  expect(response.status).toBe(200);
  const html = await response.text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1];
  expect(consent).toBeTruthy();
  if (!consent) throw new Error("Missing consent token");
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0],
    form: new URLSearchParams({
      consent,
      decision,
      ...Object.fromEntries(scopes.map((scope) => [scope, "yes"])),
    }),
  };
}
async function approve(form: URLSearchParams, cookie: string) {
  return handleSandboxOAuth(
    new Request(`${origin}/authorize`, {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    }),
    "authorize",
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TOOLPLANE_PUBLIC_URL", origin);
  vi.stubEnv("AUTH_SECRET", "test-consent-secret-long-enough");
  mocks.client.mockResolvedValue({
    id: "client",
    name: '<script>"&evil</script>',
    redirectUris: [redirect],
    tokenEndpointAuthMethod: "none",
  });
  mocks.principal.mockResolvedValue({
    credential: "session",
    user: { id: "user" },
  });
  mocks.owned.mockResolvedValue({
    kind: "docker",
    workspaceId: "workspace",
    name: "<unsafe sandbox>",
  });
  mocks.begin.mockReturnValue(mocks.release);
  mocks.code.mockResolvedValue(codeRecord());
  mocks.refresh.mockResolvedValue(refreshRecord());
  mocks.consumeCode.mockResolvedValue({ count: 1 });
  mocks.consumeRefresh.mockResolvedValue({ count: 1 });
  mocks.lock.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("sandbox OAuth consent state machine", () => {
  it.each([
    [{ resource: "https://evil.test/mcp" }, "invalid_target"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ scope: "private:admin" }, "invalid_scope"],
  ] as const)(
    "returns validation errors only to the registered redirect",
    async (override, error) => {
      const response = await handleSandboxOAuth(
        authorization(override),
        "authorize",
      );
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe(redirect);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe("opaque-state");
      expect(location.searchParams.get("iss")).toBe(origin);
      expect(mocks.owned).not.toHaveBeenCalled();
    },
  );
  it("sends unauthenticated browsers to login with the original request but denies non-session credentials", async () => {
    mocks.principal.mockResolvedValueOnce(null);
    const login = await handleSandboxOAuth(authorization(), "authorize");
    expect(new URL(login.headers.get("location") ?? "").pathname).toBe(
      "/app/login",
    );
    expect(
      new URL(login.headers.get("location") ?? "").searchParams.get("next"),
    ).toContain("code_challenge=");
    mocks.principal.mockResolvedValueOnce({
      credential: "personal-token",
      user: { id: "user" },
    });
    const denied = await handleSandboxOAuth(authorization(), "authorize");
    expect(
      new URL(denied.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("access_denied");
  });
  it.each([null, { kind: "hermes" }])(
    "denies consent for inaccessible or protected sandboxes",
    async (sandbox) => {
      mocks.owned.mockResolvedValue(sandbox);
      const response = await handleSandboxOAuth(authorization(), "authorize");
      expect(
        new URL(response.headers.get("location") ?? "").searchParams.get(
          "error",
        ),
      ).toBe("access_denied");
    },
  );
  it("escapes untrusted names and sets clickjacking, referrer and signed-consent protections", async () => {
    const response = await handleSandboxOAuth(authorization(), "authorize");
    const html = await response.text();
    expect(html).not.toContain('<script>"&evil</script>');
    expect(html).toContain("&lt;unsafe sandbox&gt;");
    expect(html).toContain("&lt;script&gt;&quot;&amp;evil&lt;/script&gt;");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("set-cookie")).toMatch(
      /HttpOnly; SameSite=Lax; Secure$/,
    );
  });
  it.each(["wrong-cookie", "tampered-token", "changed-user"])(
    "rejects consent with %s",
    async (failure) => {
      const { form, cookie } = await consentForm();
      if (failure === "tampered-token")
        form.set("consent", `${form.get("consent")}x`);
      if (failure === "changed-user")
        mocks.principal.mockResolvedValue({
          credential: "session",
          user: { id: "different" },
        });
      const response = await approve(
        form,
        failure === "wrong-cookie" ? "toolplane_mcp_consent=wrong" : cookie,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "access_denied" });
      expect(mocks.createCode).not.toHaveBeenCalled();
    },
  );
  it.each([
    "denied",
    "empty",
    "sandbox-removed",
    "workspace-closed",
    "redirect-removed",
  ])(
    "rechecks current authority before approving consent: %s",
    async (failure) => {
      const { form, cookie } = await consentForm(
        failure === "denied" ? "deny" : "allow",
        failure === "empty" ? [] : undefined,
      );
      if (failure === "sandbox-removed") mocks.owned.mockResolvedValue(null);
      if (failure === "workspace-closed") mocks.begin.mockReturnValue(null);
      if (failure === "redirect-removed")
        mocks.client.mockResolvedValue({ redirectUris: [] });
      const response = await approve(form, cookie);
      expect(response.status).toBe(failure === "redirect-removed" ? 400 : 303);
      if (response.status === 303) {
        expect(
          new URL(response.headers.get("location") ?? "").searchParams.get(
            "error",
          ),
        ).toBe(
          failure === "empty"
            ? "invalid_scope"
            : failure === "workspace-closed"
              ? "temporarily_unavailable"
              : "access_denied",
        );
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      }
      expect(mocks.createCode).not.toHaveBeenCalled();
    },
  );
  it("issues a single-use code only for selected scopes, storing its hash not plaintext", async () => {
    const { form, cookie } = await consentForm();
    const response = await approve(form, cookie);
    expect(response.status).toBe(303);
    const code = new URL(
      response.headers.get("location") ?? "",
    ).searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    expect(code).toMatch(/^mcpsba_[a-f0-9]{64}$/);
    expect(mocks.createCode).toHaveBeenCalledWith({
      data: expect.objectContaining({
        codeHash: createHash("sha256").update(code).digest("hex"),
        scopes: ["sandbox:read", "offline_access"],
        userId: "user",
        sandboxId: "sandbox-1",
        codeChallenge: challenge,
      }),
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe("sandbox OAuth token rotation", () => {
  it.each([
    { clientId: "other" },
    { resource: "other" },
    { redirectUri: "https://evil.test/" },
    { consumedAt: new Date() },
    { expiresAt: new Date(0) },
    { codeChallenge: "wrong" },
  ])("rejects invalid authorization code state %j", async (override) => {
    mocks.code.mockResolvedValue(codeRecord(override));
    const response = await exchange();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(mocks.createToken).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "exchanges code with offline_access=%s",
    async (offline) => {
      mocks.code.mockResolvedValue(
        codeRecord({
          scopes: offline
            ? ["sandbox:read", "offline_access"]
            : ["sandbox:read"],
        }),
      );
      const response = await exchange();
      expect(response.status).toBe(200);
      const token = await response.json();
      expect(token.access_token).toMatch(/^mcpsbx_[a-f0-9]{64}$/);
      expect(token.expires_in).toBe(3600);
      expect(mocks.createToken.mock.calls[0][0].data.tokenHash).toBe(
        createHash("sha256").update(token.access_token).digest("hex"),
      );
      if (offline) expect(token.refresh_token).toMatch(/^mcpsbr_/);
      else expect(token).not.toHaveProperty("refresh_token");
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it("rejects a code consumed by a concurrent exchange", async () => {
    mocks.consumeCode.mockResolvedValue({ count: 0 });
    expect((await exchange()).status).toBe(400);
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([null, { kind: "hermes" }])(
    "rejects code and refresh for inaccessible or protected sandboxes",
    async (sandbox) => {
      mocks.owned.mockResolvedValue(sandbox);
      for (const grant of ["authorization_code", "refresh_token"]) {
        const response = await exchange(grant);
        expect(await response.json()).toEqual({ error: "invalid_grant" });
      }
    },
  );
  it.each(["authorization_code", "refresh_token"])(
    "rejects %s while workspace mutations are blocked",
    async (grant) => {
      mocks.begin.mockReturnValue(null);
      const response = await exchange(grant);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "temporarily_unavailable",
      });
    },
  );
  it.each([
    { oauthClientId: "other" },
    { oauthResource: "other" },
    { revokedAt: new Date() },
    { oauthExpiresAt: null },
    { oauthExpiresAt: new Date(0) },
  ])("rejects refresh family state %j", async (override) => {
    mocks.refresh.mockResolvedValue(refreshRecord({}, override));
    expect(await (await exchange("refresh_token")).json()).toEqual({
      error: "invalid_grant",
    });
  });
  it("rejects unknown and expired refresh generations", async () => {
    mocks.refresh
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(refreshRecord({ expiresAt: new Date(0) }));
    for (let index = 0; index < 2; index++)
      expect(await (await exchange("refresh_token")).json()).toEqual({
        error: "invalid_grant",
      });
  });
  it.each(["private:admin", "sandbox:execute"])(
    "rejects invalid or expanded refresh scope %s",
    async (scope) => {
      expect(await (await exchange("refresh_token", { scope })).json()).toEqual(
        { error: "invalid_scope" },
      );
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "rotates refresh while narrowing offline access=%s",
    async (offline) => {
      const scope = offline ? "sandbox:read offline_access" : "sandbox:read";
      const response = await exchange("refresh_token", { scope });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.scope).toBe(scope);
      expect(body.expires_in).toBeGreaterThan(0);
      expect(body.expires_in).toBeLessThanOrEqual(120);
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: "grant" },
        data: expect.objectContaining({
          oauthScopes: scope.split(" "),
          allowedTools: [
            "sandbox_info",
            "list_dir",
            "read_file",
            "download_file",
          ],
        }),
      });
      if (offline) {
        expect(body.refresh_token).toMatch(/^mcpsbr_/);
        expect(mocks.createRefresh.mock.calls[0][0].data.tokenHash).toBe(
          createHash("sha256").update(body.refresh_token).digest("hex"),
        );
      } else {
        expect(body).not.toHaveProperty("refresh_token");
        expect(mocks.createRefresh).not.toHaveBeenCalled();
      }
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it("revokes the entire family on consumed refresh replay", async () => {
    mocks.consumeRefresh.mockResolvedValue({ count: 0 });
    expect(await (await exchange("refresh_token")).json()).toEqual({
      error: "invalid_grant",
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "grant" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mocks.createRefresh).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("fails closed if revocation wins the grant lock", async () => {
    mocks.lock.mockResolvedValue({ count: 0 });
    expect(await (await exchange("refresh_token")).json()).toEqual({
      error: "invalid_grant",
    });
    expect(mocks.consumeRefresh).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
