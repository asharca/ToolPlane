import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiPackageManifestV1 } from "@/lib/market/pi-package-manifest";
import {
  getPiPackageClientArtifact,
  projectPiPackageSkills,
} from "@/lib/pi-packages/client-artifact";
import type * as Installations from "@/lib/pi-packages/installations";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/pi-packages/installations", async (importOriginal) => ({
  ...(await importOriginal<typeof Installations>()),
  authenticatePiPackageInstallation: mocks.authenticate,
}));

function fixture(): PiPackageManifestV1 {
  const file = (path: string, text: string) => ({
    type: "file" as const,
    path,
    contentEncoding: "base64" as const,
    content: Buffer.from(text).toString("base64"),
    executable: false,
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  return {
    schemaVersion: 1,
    kind: "pi-package",
    listing: {
      slug: "projection",
      name: "Projection",
      summary: null,
      iconUrl: null,
      author: "fixture",
      tags: [],
    },
    package: {
      source: {
        kind: "toolplane",
        requested: "toolplane:projection",
        name: "projection",
        version: "1.0.0",
      },
      name: "projection",
      version: "1.0.0",
      root: "package",
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
        nodeMajor: 26,
        platform: "any",
        arch: "any",
      },
      resources: {
        extensions: ["package/extension.mjs"],
        skills: ["package/guide.md"],
        prompts: ["package/prompt.md"],
        themes: [],
      },
      entries: [
        file(
          "package/guide.md",
          "---\nname: guide\ndescription: Test skill\n---\nRead assets/example.txt",
        ),
        file("package/assets/example.txt", "reviewed data"),
        {
          type: "symlink",
          path: "package/assets/alias.txt",
          target: "example.txt",
        },
        file("package/extension.mjs", 'throw new Error("Pi only")'),
        file("package/prompt.md", "Pi prompt only"),
      ],
    },
  };
}

describe("third-party Skill projection", () => {
  it("preserves reviewed relative assets, dereferences internal links, and omits Pi code and prompts", () => {
    const skills = projectPiPackageSkills(fixture());
    expect(skills).toHaveLength(1);
    expect(skills[0].files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "assets/alias.txt",
      "assets/example.txt",
    ]);
    const alias = assertDefined(
      skills[0].files.find((file) => file.path === "assets/alias.txt"),
    );
    expect(Buffer.from(alias.content, "base64").toString()).toBe(
      "reviewed data",
    );
    expect(alias.sha256).toBe(
      createHash("sha256").update("reviewed data").digest("hex"),
    );
  });
  it("treats a declared SKILL.md directory as one skill rather than discovering nested asset skills", () => {
    const input = fixture();
    input.package.resources.skills = ["package"];
    const guide = assertDefined(
      input.package.entries.find((entry) => entry.path === "package/guide.md"),
    );
    guide.path = "package/SKILL.md";
    input.package.entries.push({
      ...guide,
      path: "package/examples/nested/SKILL.md",
    });
    const skills = projectPiPackageSkills(input);
    expect(skills).toHaveLength(1);
    expect(
      skills[0].files.find((file) => file.path === "SKILL.md"),
    ).toBeDefined();
  });
  it("rejects link recursion without emitting a partial Skill projection", () => {
    const input = fixture();
    input.package.entries.push({
      type: "symlink",
      path: "package/assets/cycle",
      target: ".",
    });
    expect(() => projectPiPackageSkills(input)).toThrow(
      "pi_package_symlink_cycle",
    );
  });
  it("discovers directory skills, skips hidden directories and ignores non-Markdown root files", () => {
    const input = fixture();
    input.package.resources.skills = [
      "package/collection",
      "package/missing",
      "package/data.txt",
    ];
    const file = assertDefined(
      input.package.entries.find((entry) => entry.type === "file"),
    );
    input.package.entries = [
      { ...file, path: "package/collection/z/SKILL.md" },
      { ...file, path: "package/collection/a/SKILL.md" },
      { ...file, path: "package/collection/.hidden/SKILL.md" },
      { ...file, path: "package/collection/README.md" },
      { ...file, path: "package/data.txt" },
    ];
    const result = projectPiPackageSkills(input);
    expect(result).toHaveLength(3);
    expect(result.map((skill) => skill.key)).toEqual(
      [
        "package/collection/README.md",
        "package/collection/a/SKILL.md",
        "package/collection/z/SKILL.md",
      ].map((path) =>
        createHash("sha256").update(path).digest("hex").slice(0, 20),
      ),
    );
  });
  it("detects cycles in linked resources before projection", () => {
    const input = fixture();
    input.package.resources.skills = ["package/a"];
    input.package.entries.push(
      { type: "symlink", path: "package/a", target: "b" },
      { type: "symlink", path: "package/b", target: "a" },
    );
    expect(() => projectPiPackageSkills(input)).toThrow(
      "pi_package_symlink_cycle",
    );
  });
  it("rejects projections exceeding the aggregate file count", () => {
    const input = fixture();
    const file = assertDefined(
      input.package.entries.find((entry) => entry.type === "file"),
    );
    input.package.entries.push(
      ...Array.from({ length: 20001 }, (_, index) => ({
        ...file,
        path: `package/assets/file-${index}`,
      })),
    );
    expect(() => projectPiPackageSkills(input)).toThrow(
      "pi_package_projection_too_large",
    );
  });
});

describe("package client artifact", () => {
  beforeEach(() => {
    mocks.authenticate.mockReset();
  });
  it.each(["pi", "claude-code"])(
    "builds a hashed artifact for %s",
    async (client) => {
      const manifest = fixture();
      mocks.authenticate.mockResolvedValue({
        installation: { client },
        manifest,
        release: { id: "release", checksum: "checksum" },
        bindings: {},
      });
      const { body, descriptor } = await getPiPackageClientArtifact(
        "installation",
        "Bearer token",
      );
      const artifact = JSON.parse(body);
      expect(artifact).toMatchObject({
        client,
        releaseId: "release",
        mcp: false,
        warnings: client === "pi" ? [] : ["pi_resources_omitted"],
      });
      if (client === "pi") expect(artifact.manifest).toEqual(manifest);
      else expect(artifact.skills).toHaveLength(1);
      expect(descriptor).toMatchObject({
        artifactSha256: createHash("sha256").update(body).digest("hex"),
        artifactBytes: Buffer.byteLength(body),
        artifactPath: "/api/v1/pi-packages/installations/installation/artifact",
      });
      expect(mocks.authenticate).toHaveBeenCalledWith(
        "installation",
        "Bearer token",
      );
    },
  );
  it("allows MCP-only client packages but rejects empty unsupported projections", async () => {
    const manifest = fixture();
    manifest.package.resources = {
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.authenticate.mockResolvedValue({
      installation: { client: "codex" },
      manifest,
      release: { id: "r", checksum: "c" },
      bindings: {},
    });
    await expect(
      getPiPackageClientArtifact("installation", null),
    ).rejects.toThrow("pi_package_client_unsupported");
    mocks.authenticate.mockResolvedValue({
      installation: { client: "codex" },
      manifest,
      release: { id: "r", checksum: "c" },
      bindings: { tools: {} },
    });
    const { body } = await getPiPackageClientArtifact("installation", null);
    expect(JSON.parse(body)).toMatchObject({
      mcp: true,
      skills: [],
      warnings: [],
    });
  });
  it("propagates authentication denial before exposing package contents", async () => {
    const denial = new Error("invalid installation token");
    mocks.authenticate.mockRejectedValue(denial);
    await expect(
      getPiPackageClientArtifact("installation", "Bearer wrong"),
    ).rejects.toBe(denial);
  });
});
