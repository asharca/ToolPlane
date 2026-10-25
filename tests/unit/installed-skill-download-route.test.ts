// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  findInstall: vi.fn(),
  buildMarkdown: vi.fn(),
  skillLabel: vi.fn(),
  extraFiles: vi.fn(),
  logRequest: vi.fn(),
}));

vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: mocks.resolveRequestUser,
}));
vi.mock("@/lib/db", () => ({
  db: { installedSkill: { findFirst: mocks.findInstall } },
}));
vi.mock("@/lib/skills/artifact", () => ({
  buildInstalledSkillMarkdown: mocks.buildMarkdown,
  installedSkillExtraFiles: mocks.extraFiles,
}));
vi.mock("@/lib/workspace/skill-label", () => ({
  skillLabel: mocks.skillLabel,
}));
vi.mock("@/lib/observability/log", () => ({
  logRequest: mocks.logRequest,
}));

import { GET } from "@/app/api/v1/skills/[installId]/skill.md/route";
import { GET as download } from "@/app/api/v1/skills/[installId]/download/route";
import { readZip } from "@/lib/archives/zip";

const context = { params: Promise.resolve({ installId: "install-1" }) };

describe("installed skill.md download boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: "user-1" });
    mocks.findInstall.mockResolvedValue({
      id: "install-1",
      skillId: "skill-1",
      skill: { slug: "reviewed-skill", name: "Reviewed skill" },
      workspace: { id: "workspace-1" },
    });
    mocks.buildMarkdown.mockReturnValue("# Reviewed skill\n");
    mocks.extraFiles.mockReturnValue([
      { path: "images/icon.bin", content: "AP8=", encoding: "base64" },
    ]);
    mocks.skillLabel.mockReturnValue({
      slug: "reviewed-skill",
      name: "Reviewed skill",
    });
    mocks.logRequest.mockResolvedValue(undefined);
  });

  it("requires a session or Bearer-authenticated user before reading an install", async () => {
    mocks.resolveRequestUser.mockResolvedValue(null);

    const response = await GET(
      new Request("http://toolplane.test/api/v1/skills/install-1/skill.md"),
      context,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.findInstall).not.toHaveBeenCalled();
  });

  it("scopes the requested install to workspaces available to the caller", async () => {
    const response = await GET(
      new Request("http://toolplane.test/api/v1/skills/install-1/skill.md", {
        headers: { authorization: "Bearer api-token" },
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("# Reviewed skill\n");
    expect(mocks.resolveRequestUser).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.findInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "install-1",
          workspace: {
            status: "active",
            OR: [
              { ownerId: "user-1" },
              { members: { some: { userId: "user-1" } } },
            ],
          },
        },
      }),
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        path: "/skills/reviewed-skill/skill.md",
        statusCode: 200,
      }),
    );
  });

  it("does not reveal whether an install exists outside the caller workspaces", async () => {
    mocks.findInstall.mockResolvedValue(null);

    const response = await GET(
      new Request("http://toolplane.test/api/v1/skills/install-1/skill.md"),
      context,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(mocks.buildMarkdown).not.toHaveBeenCalled();
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("exports full ZIP by default with binary relative files and explicit markdown compatibility", async () => {
    const response = await download(
      new Request("http://toolplane.test/api/v1/skills/install-1/download"),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const files = readZip(Buffer.from(await response.arrayBuffer()), {
      maxBytes: 1000,
      maxArchiveBytes: 2000,
      maxFileBytes: 1000,
      maxFiles: 10,
    });
    expect(files).toEqual([
      { path: "SKILL.md", data: Buffer.from("# Reviewed skill\n") },
      { path: "images/icon.bin", data: Buffer.from([0, 255]) },
    ]);
    const markdown = await download(
      new Request(
        "http://toolplane.test/api/v1/skills/install-1/download?format=markdown",
      ),
      context,
    );
    expect(await markdown.text()).toBe("# Reviewed skill\n");
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
  });

  it("protects ZIP exports with the same auth boundary", async () => {
    mocks.resolveRequestUser.mockResolvedValue(null);
    expect(
      (
        await download(
          new Request("http://toolplane.test/api/v1/skills/install-1/download"),
          context,
        )
      ).status,
    ).toBe(401);
    expect(mocks.findInstall).not.toHaveBeenCalled();
    mocks.resolveRequestUser.mockResolvedValue({ id: "user-1" });
    mocks.findInstall.mockResolvedValue(null);
    expect(
      (
        await download(
          new Request("http://toolplane.test/api/v1/skills/install-1/download"),
          context,
        )
      ).status,
    ).toBe(404);
    expect(mocks.extraFiles).not.toHaveBeenCalled();
  });
});
