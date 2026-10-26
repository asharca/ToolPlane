// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelInput } from "@/lib/workspace/deployment-label";
import type { SkillLabelInput } from "@/lib/workspace/skill-label";
const m = vi.hoisted(() => ({
  principal: vi.fn(),
  user: vi.fn(),
  workspace: vi.fn(),
  toolkit: vi.fn(),
  link: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: m.principal,
  resolveRequestUser: m.user,
}));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst: m.workspace },
    toolkit: { findFirst: m.toolkit },
  },
}));
vi.mock("@/lib/toolkits/install-link", () => ({
  getOrCreateToolkitInstallLink: m.link,
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: m.log }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { GET as install } from "@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/install/route";
import { GET as manifest } from "@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest/route";
const ctx = { params: Promise.resolve({ slug: "team", toolkitSlug: "kit" }) };
const req = new Request("https://test/api");
describe("toolkit descriptor and bootstrap transport", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://test");
    m.user.mockResolvedValue({ id: "user" });
    m.principal.mockResolvedValue({
      user: { id: "user" },
      token: { toolkitId: null },
      credential: "personal-token",
    });
    m.workspace.mockResolvedValue({ id: "ws", slug: "team", name: "Team" });
    m.toolkit.mockResolvedValue({
      id: "kit",
      workspaceId: "ws",
      name: "Kit",
      slug: "kit",
      visibility: "private",
      servers: [],
      skills: [],
    });
    m.link.mockResolvedValue({ id: "install-link" });
  });
  it.each([null, { credential: "session" }, { credential: "toolkit-token" }])(
    "requires personal token rather than %j",
    async (principal) => {
      m.principal.mockResolvedValue(principal);
      const response = await install(req, ctx);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(m.toolkit).not.toHaveBeenCalled();
      expect(m.principal).toHaveBeenCalledWith(req, { allowSession: false });
    },
  );
  it("hides a toolkit inaccessible to a personal token", async () => {
    m.toolkit.mockResolvedValue(null);
    expect((await install(req, ctx)).status).toBe(404);
    expect(m.link).not.toHaveBeenCalled();
  });
  it.each(["codex", "opencode", "unknown", ""])(
    "returns a real bootstrap for client %s without embedding authorization",
    async (client) => {
      const response = await install(
        new Request(`https://test/api?client=${client}`, {
          headers: { authorization: "Bearer PERSONAL_SECRET" },
        }),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/x-shellscript",
      );
      const body = await response.text();
      const encoded = body.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
      expect(encoded).not.toBeNull();
      const config = JSON.parse(
        Buffer.from(encoded?.[1] ?? "", "base64").toString("utf8"),
      );
      expect(config).toMatchObject({
        endpoint: "https://test/install/install-link",
        client: client === "unknown" || !client ? "claude-code" : client,
        uninstall: false,
      });
      expect(body).not.toContain("PERSONAL_SECRET");
      expect(m.link).toHaveBeenCalledWith("kit", "user");
    },
  );
  it("requires account access before exporting a manifest", async () => {
    m.user.mockResolvedValue(null);
    expect((await manifest(req, ctx)).status).toBe(401);
    expect(m.workspace).not.toHaveBeenCalled();
  });
  it.each(["workspace", "toolkit"] as const)(
    "conceals missing manifest %s",
    async (missing) => {
      m[missing].mockResolvedValue(null);
      expect((await manifest(req, ctx)).status).toBe(404);
    },
  );
  it("exports only toolkit resources using catalog, custom and identifier fallbacks", async () => {
    const server: LabelInput & {
      id: string;
      status: string;
      server: { name: string; slug: string } | null;
    } = {
      id: "dep",
      status: "running",
      serverId: "catalog",
      server: { name: "Catalog", slug: "catalog" },
      name: null,
      source: null,
      sourceRef: null,
    };
    const skill: SkillLabelInput & { id: string } = {
      id: "skill",
      skillId: "catalog",
      skill: { name: "Skill", slug: "skill" },
      name: null,
      slug: null,
      source: null,
    };
    m.toolkit.mockResolvedValue({
      name: "Kit",
      slug: "kit",
      visibility: "private",
      servers: [
        server,
        {
          ...server,
          id: "custom",
          serverId: null,
          server: null,
          sourceRef: "custom-ref",
        },
        { ...server, id: "bare", serverId: null, server: null },
      ].map((deployment) => ({ deployment })),
      skills: [
        skill,
        {
          ...skill,
          id: "custom-skill",
          skillId: null,
          skill: null,
          name: "Custom",
          slug: "custom",
        },
      ].map((installedSkill) => ({ installedSkill })),
    });
    const response = await manifest(req, ctx);
    const body = await response.json();
    expect(body.servers).toEqual([
      {
        name: "Catalog",
        slug: "catalog",
        status: "running",
        endpoint: "/api/v1/mcp/dep/rpc",
      },
      {
        name: "custom-ref",
        slug: "custom-ref",
        status: "running",
        endpoint: "/api/v1/mcp/custom/rpc",
      },
      {
        name: "Untitled server",
        slug: "bare",
        status: "running",
        endpoint: "/api/v1/mcp/bare/rpc",
      },
    ]);
    expect(body.skills).toEqual([
      {
        name: "Skill",
        slug: "skill",
        download: "/api/v1/skills/skill/download",
      },
      {
        name: "Custom",
        slug: "custom",
        download: "/api/v1/skills/custom-skill/download",
      },
    ]);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="kit.toolkit.json"',
    );
    expect(m.toolkit).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws", slug: "kit" } }),
    );
  });
});
