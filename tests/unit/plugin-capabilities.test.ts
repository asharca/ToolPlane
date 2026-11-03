import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computePluginCapabilities,
  readCapabilities,
  requiresReview,
} from "@/lib/plugins/capabilities";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";

function manifest(
  version = "1.0.0",
  code = "export default 1",
  skill = "# Skill",
): PiPackageManifestV1 {
  return {
    schemaVersion: 1,
    kind: "pi-package",
    listing: {
      slug: "sample",
      name: "Sample",
      summary: null,
      iconUrl: null,
      tags: [],
      author: "acme",
    },
    package: {
      source: {
        kind: "git",
        requested: `https://github.com/acme/sample.git#${"a".repeat(40)}`,
        url: "https://github.com/acme/sample.git",
        commit: "a".repeat(40),
      },
      name: "sample",
      version,
      root: "package",
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
        nodeMajor: 26,
        platform: "any",
        arch: "any",
      },
      resources: {
        extensions: ["package/extensions/main.ts"],
        skills: ["package/skills"],
        prompts: ["package/prompts"],
        themes: ["package/themes"],
      },
      entries: Object.entries({
        "package.json": JSON.stringify({
          name: "sample",
          version,
          pi: { skills: ["skills"] },
        }),
        "extensions/main.ts": code,
        "skills/example/SKILL.md": skill,
      }).map(([path, content]) => ({
        type: "file",
        path: `package/${path}`,
        contentEncoding: "base64",
        content: Buffer.from(content).toString("base64"),
        executable: false,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
      toolplane: {
        schemaVersion: 1,
        mcp: [
          { key: "documents", name: "Documents", tools: ["read", "search"] },
        ],
      },
    },
  };
}

describe("plugin capability review", () => {
  it("requires review when executable code changes", () => {
    expect(
      requiresReview(
        computePluginCapabilities(manifest()),
        computePluginCapabilities(manifest("1.1.0", "export default 2")),
      ),
    ).toBe(true);
  });
  it("requires review when fingerprints are absent or malformed", () => {
    const caps = computePluginCapabilities(manifest());
    expect(readCapabilities({ capabilities: caps })).toEqual(caps);
    expect(requiresReview(readCapabilities({}), caps)).toBe(true);
    expect(
      requiresReview(
        caps,
        readCapabilities({ capabilities: { mcp: [], codeDigest: "invalid" } }),
      ),
    ).toBe(true);
  });
  it("requires review for an added MCP tool or requirement", () => {
    const from = computePluginCapabilities(manifest());
    expect(
      requiresReview(from, {
        ...from,
        mcp: [{ key: "documents", tools: ["read", "search", "write"] }],
      }),
    ).toBe(true);
    expect(
      requiresReview(from, {
        ...from,
        mcp: [...from.mcp, { key: "new", tools: ["run"] }],
      }),
    ).toBe(true);
  });
  it("does not require review for removal-only MCP changes", () => {
    const from = computePluginCapabilities(manifest());
    expect(
      requiresReview(from, {
        ...from,
        mcp: [{ key: "documents", tools: ["read"] }],
      }),
    ).toBe(false);
    expect(requiresReview(from, { ...from, mcp: [] })).toBe(false);
  });
  it("normalizes version-only package.json changes and excludes declared non-code resources", () => {
    const from = computePluginCapabilities(manifest());
    const to = computePluginCapabilities(
      manifest("2.0.0", undefined, "# Changed instructions"),
    );
    expect(to.codeDigest).toBe(from.codeDigest);
    expect(requiresReview(from, to)).toBe(false);
    expect(from.mcp).toEqual([{ key: "documents", tools: ["read", "search"] }]);
  });
  it("resolves non-code resource declarations relative to the snapshot root", () => {
    const from = manifest();
    const to = manifest("2.0.0", undefined, "# Changed instructions");
    to.package.resources.skills = ["./skills/"];
    expect(computePluginCapabilities(to).codeDigest).toBe(
      computePluginCapabilities(from).codeDigest,
    );
  });
});
