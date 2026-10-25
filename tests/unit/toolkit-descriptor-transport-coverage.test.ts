// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelInput } from "@/lib/workspace/deployment-label";
import type { SkillLabelInput } from "@/lib/workspace/skill-label";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  toolkit: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: m.user,
}));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst: m.workspace },
    toolkit: { findFirst: m.toolkit },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/observability/log", () => ({ logRequest: m.log }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { GET as manifest } from "@/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest/route";
const ctx = { params: Promise.resolve({ slug: "team", toolkitSlug: "kit" }) };
const req = new Request("https://test/api");
describe("read-only historical toolkit descriptor transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.user.mockResolvedValue({ id: "user" });
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
  });
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
        download: "/api/v1/skills/skill/download?format=markdown",
        bundleDownload: "/api/v1/skills/skill/download",
      },
      {
        name: "Custom",
        slug: "custom",
        download: "/api/v1/skills/custom-skill/download?format=markdown",
        bundleDownload: "/api/v1/skills/custom-skill/download",
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
