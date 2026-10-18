// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  toolkit: vi.fn(),
  recheck: vi.fn(),
  list: vi.fn(),
  targets: vi.fn(),
  installations: vi.fn(),
  tokens: vi.fn(),
  links: vi.fn(),
  create: vi.fn(),
  lock: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAccountRequestUser: m.user,
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: m.audit }));
vi.mock("@/lib/db", () => {
  const tx = {
    $queryRaw: m.lock,
    toolkit: { findFirst: m.recheck },
    toolkitInstallation: { findMany: m.targets, updateMany: m.installations },
    apiToken: { updateMany: m.tokens },
    toolkitInstallLink: { deleteMany: m.links, create: m.create },
  };
  return {
    db: {
      toolkit: { findFirst: m.toolkit },
      toolkitInstallation: { findMany: m.list },
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    },
  };
});
import {
  GET,
  POST,
} from "@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/installations/route";
const ctx = { params: Promise.resolve({ slug: "team", toolkitSlug: "kit" }) };
function request(
  body: unknown,
  headers: Record<string, string | undefined> = {
    "content-type": "application/json",
  },
) {
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) requestHeaders.set(name, value);
  }
  return new Request("https://tool.test/api", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}
describe("toolkit installation management authorization", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://tool.test");
    m.user.mockResolvedValue({ id: "user" });
    m.toolkit.mockResolvedValue({ id: "kit", workspaceId: "ws" });
    m.recheck.mockResolvedValue({ id: "kit" });
    m.targets.mockResolvedValue([{ id: "install" }]);
    m.list.mockResolvedValue([
      { id: "install", client: "claude", status: "active" },
    ]);
  });
  it("lists only the caller's installations with private cache headers", async () => {
    const response = await GET(new Request("https://tool.test/api"), ctx);
    expect(await response.json()).toMatchObject({
      installations: [{ id: "install" }],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user", toolkitId: "kit" },
        take: 200,
      }),
    );
    expect(m.toolkit).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: "kit",
          workspace: {
            slug: "team",
            status: "active",
            OR: [
              { ownerId: "user" },
              { members: { some: { userId: "user" } } },
            ],
          },
        },
      }),
    );
  });
  it.each(["user", "toolkit"] as const)(
    "conceals missing %s on reads and writes",
    async (missing) => {
      m[missing].mockResolvedValue(null);
      expect(
        (await GET(new Request("https://tool.test/api"), ctx)).status,
      ).toBe(404);
      expect(
        (await POST(request({ operation: "revoke-all" }), ctx)).status,
      ).toBe(404);
      expect(m.list).not.toHaveBeenCalled();
      expect(m.lock).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { "content-type": "text/plain" },
    { "content-type": "application/json", origin: "https://evil.test" },
  ])(
    "rejects unsafe request headers %j before authentication",
    async (headers) => {
      expect(
        (await POST(request({ operation: "revoke-all" }, headers), ctx)).status,
      ).toBe(403);
      expect(m.user).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { operation: "other" },
    { operation: "revoke" },
    { operation: "revoke", installationId: "" },
    { operation: "revoke-all", extra: true },
  ])("rejects invalid operation %j", async (body) => {
    expect((await POST(request(body), ctx)).status).toBe(400);
    expect(m.lock).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    expect(
      (
        await POST(
          new Request("https://tool.test/api", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
          ctx,
        )
      ).status,
    ).toBe(400);
  });
  it("rechecks membership inside the workspace lock", async () => {
    m.recheck.mockResolvedValue(null);
    expect((await POST(request({ operation: "revoke-all" }), ctx)).status).toBe(
      404,
    );
    expect(m.lock).toHaveBeenCalled();
    expect(m.tokens).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it("does not revoke somebody else's installation", async () => {
    m.targets.mockResolvedValue([]);
    expect(
      (
        await POST(
          request({ operation: "revoke", installationId: "foreign" }),
          ctx,
        )
      ).status,
    ).toBe(404);
    expect(m.targets).toHaveBeenCalledWith({
      where: { userId: "user", toolkitId: "kit", id: "foreign" },
      select: { id: true },
    });
    expect(m.installations).not.toHaveBeenCalled();
  });
  it.each(["revoke", "revoke-all"])(
    "revokes installation and scoped tokens atomically for %s",
    async (operation) => {
      const response = await POST(
        request(
          operation === "revoke"
            ? { operation, installationId: "install" }
            : { operation },
          {
            "content-type": "application/json; charset=utf-8",
            origin: "https://tool.test",
          },
        ),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(m.installations).toHaveBeenCalledWith({
        where: {
          userId: "user",
          toolkitId: "kit",
          ...(operation === "revoke" ? { id: "install" } : {}),
        },
        data: { status: "revoked" },
      });
      expect(m.tokens).toHaveBeenCalledWith({
        where: {
          userId: "user",
          toolkitId: "kit",
          ...(operation === "revoke" ? { installationId: "install" } : {}),
        },
        data: { expiresAt: expect.any(Date) },
      });
      expect(m.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: "user",
          action: `installation.${operation}`,
          changes: operation === "revoke" ? { installationId: "install" } : {},
        }),
      );
    },
  );
  it("rotates only the caller's install link without revoking installations", async () => {
    expect(
      (await POST(request({ operation: "rotate-link" }), ctx)).status,
    ).toBe(200);
    expect(m.links).toHaveBeenCalledWith({
      where: { toolkitId: "kit", userId: "user" },
    });
    expect(m.create).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        toolkitId: "kit",
        userId: "user",
      },
    });
    expect(m.tokens).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "installation.rotate-link",
        changes: {},
      }),
    );
  });
});
