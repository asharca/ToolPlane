// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  owned: vi.fn(),
  begin: vi.fn(),
  release: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    sandboxMcpToken: {
      findMany: mocks.list,
      updateMany: mocks.update,
      count: mocks.count,
      create: mocks.create,
    },
  },
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: mocks.principal,
}));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: mocks.begin,
}));
vi.mock("@/lib/sandboxes/mcp-access", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), ownedSandbox: mocks.owned };
});
import {
  handleSandboxMcpTokens,
  sandboxManagementUser,
} from "@/lib/sandboxes/mcp-management";

const origin = "https://token-management.test";
function request(
  method = "POST",
  body: unknown = { name: " Read only ", allowedTools: ["read_file"] },
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/tokens`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TOOLPLANE_PUBLIC_URL", origin);
  mocks.principal.mockResolvedValue({
    credential: "personal-token",
    user: { id: "user" },
  });
  mocks.owned.mockResolvedValue({
    id: "sandbox",
    workspaceId: "workspace",
    kind: "docker",
  });
  mocks.begin.mockReturnValue(mocks.release);
  mocks.count.mockResolvedValue(0);
  mocks.list.mockResolvedValue([]);
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.create.mockImplementation(async ({ data }) => ({
    id: "grant",
    name: data.name,
    prefix: data.prefix,
    allowedTools: data.allowedTools,
    expiresAt: data.expiresAt,
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("sandbox token management", () => {
  it.each([null, { credential: "toolkit-token", user: { id: "user" } }])(
    "refuses missing or toolkit principals",
    async (principal) => {
      mocks.principal.mockResolvedValue(principal);
      expect((await handleSandboxMcpTokens(request(), "sandbox")).status).toBe(
        401,
      );
      expect(mocks.owned).not.toHaveBeenCalled();
    },
  );
  it.each(["session", "personal-token"])(
    "rejects cross-origin %s mutations",
    async (credential) => {
      mocks.principal.mockResolvedValue({ credential, user: { id: "user" } });
      expect(
        await sandboxManagementUser(
          request("POST", {}, { origin: "https://evil.test" }),
        ),
      ).toBeNull();
    },
  );
  it("requires same-origin for session mutations but not session reads", async () => {
    mocks.principal.mockResolvedValue({
      credential: "session",
      user: { id: "user" },
    });
    expect(await sandboxManagementUser(request())).toBeNull();
    expect(
      await sandboxManagementUser(request("POST", {}, { origin })),
    ).toEqual({ id: "user" });
    expect(await sandboxManagementUser(request("GET"))).toEqual({ id: "user" });
    vi.stubEnv("TOOLPLANE_PUBLIC_URL", "not-an-origin");
    expect(
      await sandboxManagementUser(request("POST", {}, { origin })),
    ).toBeNull();
  });
  it("hides inaccessible sandboxes and blocks mutations during workspace drain", async () => {
    mocks.owned.mockResolvedValueOnce(null);
    expect((await handleSandboxMcpTokens(request(), "sandbox")).status).toBe(
      404,
    );
    mocks.begin.mockReturnValueOnce(null);
    expect((await handleSandboxMcpTokens(request(), "sandbox")).status).toBe(
      409,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("lists only selected token metadata without entering a mutation gate", async () => {
    mocks.list.mockResolvedValue([
      { id: "grant", prefix: "prefix", revokedAt: null },
    ]);
    const response = await handleSandboxMcpTokens(request("GET"), "sandbox");
    expect(await response.json()).toEqual({
      tokens: [{ id: "grant", prefix: "prefix", revokedAt: null }],
      exportable: true,
      limit: 100,
    });
    expect(mocks.list.mock.calls[0][0].select).not.toHaveProperty("tokenHash");
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    "revokes workspace-scoped grants with affected count=%s",
    async (count) => {
      mocks.update.mockResolvedValue({ count });
      const response = await handleSandboxMcpTokens(
        request("DELETE"),
        "sandbox",
        "grant",
      );
      expect(response.status).toBe(count ? 200 : 404);
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: "grant", sandboxId: "sandbox" },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it.each(["legacy-host", "unsupported-backend"])(
    "refuses export of protected %s sandboxes",
    async (kind) => {
      mocks.owned.mockResolvedValue({ kind, workspaceId: "workspace" });
      expect((await handleSandboxMcpTokens(request(), "sandbox")).status).toBe(
        409,
      );
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { name: "" },
    { name: "Token", expiresInDays: 91 },
    { name: "Token", allowedTools: [] },
    { name: "Token", allowedTools: ["private_admin"] },
    { name: "Token", extra: true },
    { name: "Token", allowedTools: ["shell_exec"] },
    { name: "Token", allowedTools: ["process_exec"] },
  ])(
    "rejects invalid settings or unacknowledged execution permissions",
    async (body) => {
      expect(
        (await handleSandboxMcpTokens(request("POST", body), "sandbox")).status,
      ).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
  it("enforces the active grant limit", async () => {
    mocks.count.mockResolvedValue(100);
    expect((await handleSandboxMcpTokens(request(), "sandbox")).status).toBe(
      409,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns a real token once while storing only its hash and bounded expiry", async () => {
    const before = Date.now();
    const response = await handleSandboxMcpTokens(request(), "sandbox");
    expect(response.status).toBe(201);
    const body = await response.json();
    const data = mocks.create.mock.calls[0][0].data;
    expect(body.token).toMatch(/^mcpsbx_[a-f0-9]{64}$/);
    expect(body).not.toHaveProperty("tokenHash");
    expect(data).not.toHaveProperty("token");
    expect(data.tokenHash).not.toBe(body.token);
    expect(data).toMatchObject({
      sandboxId: "sandbox",
      userId: "user",
      name: "Read only",
      allowedTools: ["read_file"],
    });
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 7 * 86_400_000,
    );
    expect(body.endpoint).toBe("/api/v1/sandboxes/sandbox/mcp");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("accepts explicit execution acknowledgement", async () => {
    expect(
      (
        await handleSandboxMcpTokens(
          request("POST", {
            name: "Executor",
            allowedTools: ["process_exec"],
            acknowledgeExecutionAccess: true,
            expiresInDays: 1,
          }),
          "sandbox",
        )
      ).status,
    ).toBe(201);
  });
  it("releases the gate and hides storage errors", async () => {
    mocks.create.mockRejectedValue(new Error("private database password"));
    const response = await handleSandboxMcpTokens(request(), "sandbox");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Sandbox credential operation failed.",
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("rejects token-specific POST and missing-ID DELETE", async () => {
    expect(
      (await handleSandboxMcpTokens(request(), "sandbox", "grant")).status,
    ).toBe(405);
    expect(
      (await handleSandboxMcpTokens(request("DELETE"), "sandbox")).status,
    ).toBe(405);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});
