import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
  type PiPackageEntryV1,
  type PiPackageManifestV1,
} from "@/lib/market/pi-package-manifest";

function file(
  path: string,
  content = "export default function () {}",
): PiPackageEntryV1 {
  const bytes = Buffer.from(content);
  return {
    type: "file",
    path,
    contentEncoding: "base64",
    content: bytes.toString("base64"),
    executable: false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fixture(): PiPackageManifestV1 {
  return {
    schemaVersion: 1,
    kind: "pi-package",
    listing: {
      slug: "example",
      name: "Example",
      summary: null,
      iconUrl: null,
      tags: [],
      author: "Publisher",
    },
    package: {
      source: {
        kind: "npm",
        requested: "npm:example@^1.0.0",
        name: "example",
        version: "1.2.3",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      },
      name: "example",
      version: "1.2.3",
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
        nodeMajor: 24,
        platform: "linux",
        arch: "arm64",
      },
      root: "package",
      resources: {
        extensions: ["package/index.ts"],
        skills: [],
        prompts: [],
        themes: [],
      },
      entries: [
        { type: "directory", path: "package" },
        file("package/index.ts"),
      ],
    },
  };
}

function withEntries(entries: PiPackageEntryV1[]): PiPackageManifestV1 {
  const manifest = fixture();
  manifest.package.entries.push(...entries);
  return manifest;
}

describe("immutable Pi package manifests", () => {
  it("accepts resource-only portable ToolPlane packages without executable placeholders", () => {
    const manifest = fixture();
    manifest.package.source = {
      kind: "toolplane",
      requested: "toolplane:example@1.2.3",
      name: "example",
      version: "1.2.3",
    };
    manifest.package.runtime = {
      kind: "pi-sdk",
      piVersion: "0.87.1",
      nodeMajor: 24,
      platform: "any",
      arch: "any",
    };
    manifest.package.resources = {
      extensions: [],
      skills: ["package/skills/review/SKILL.md"],
      prompts: [],
      themes: [],
    };
    manifest.package.entries = [
      file(
        "package/skills/review/SKILL.md",
        "---\nname: review\ndescription: Review changes\n---\nReview the changes.",
      ),
    ];
    expect(
      parsePiPackageReleaseManifest(manifest, marketReleaseChecksum(manifest)),
    ).toEqual(manifest);
    manifest.package.toolplane = {
      schemaVersion: 1,
      mcp: [{ key: "search", name: "Search", tools: ["find"] }],
    };
    expect(
      parsePiPackageReleaseManifest(manifest).package.toolplane?.mcp[0].tools,
    ).toEqual(["find"]);
    expect(() =>
      parsePiPackageReleaseManifest({
        ...manifest,
        package: {
          ...manifest.package,
          toolplane: {
            schemaVersion: 1,
            mcp: [
              {
                key: "search",
                name: "Search",
                tools: ["find"],
                deploymentId: "private-id",
              },
            ],
          },
        },
      }),
    ).toThrow("pi_package_invalid");
  });

  it("records a private registry without allowing credentials in provenance", () => {
    const manifest = fixture();
    if (manifest.package.source.kind !== "npm") throw new Error("fixture");
    manifest.package.source.registry = "https://registry.example.com/team/";
    expect(parsePiPackageReleaseManifest(manifest).package.source).toEqual(
      manifest.package.source,
    );
    manifest.package.source.registry =
      "https://user:secret@registry.example.com/team/";
    expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
      "pi_package_invalid_source",
    );
  });
  it("validates the complete artifact digest independent of object key order", () => {
    const manifest = fixture();
    const checksum = marketReleaseChecksum(manifest);
    expect(parsePiPackageReleaseManifest(manifest, checksum)).toEqual(manifest);
    expect(
      parsePiPackageReleaseManifest(
        {
          package: manifest.package,
          listing: manifest.listing,
          kind: manifest.kind,
          schemaVersion: 1,
        },
        checksum,
      ),
    ).toEqual(manifest);
  });

  it.each([
    "content",
    "sha256",
    "executable",
    "listing",
    "source",
    "resources",
    "symlink",
  ] as const)("rejects tampering in %s", (channel) => {
    const manifest = withEntries([
      file("package/other.ts", "export default () => 1"),
      { type: "symlink", path: "package/alias.ts", target: "index.ts" },
    ]);
    const checksum = marketReleaseChecksum(manifest);
    const entry = manifest.package.entries[1];
    if (entry.type !== "file") throw new Error("fixture");
    if (channel === "content")
      Object.assign(entry, file(entry.path, "export default () => 2"));
    if (channel === "sha256") entry.sha256 = "0".repeat(64);
    if (channel === "executable") entry.executable = true;
    if (channel === "listing") manifest.listing.name = "Changed";
    if (channel === "source")
      manifest.package.source.requested = "npm:example@latest";
    if (channel === "resources")
      manifest.package.resources.extensions = ["package/other.ts"];
    if (channel === "symlink")
      manifest.package.entries[3] = {
        type: "symlink",
        path: "package/alias.ts",
        target: "other.ts",
      };
    expect(() => parsePiPackageReleaseManifest(manifest, checksum)).toThrow(
      /checksum_mismatch/,
    );
  });

  it.each([
    "../outside",
    "/package/x",
    "package/../x",
    "package/./x",
    "package//x",
    "package\\x",
    "package/x\0",
    "other/x",
  ])("rejects unsafe path %j", (path) => {
    expect(() =>
      parsePiPackageReleaseManifest(withEntries([file(path)])),
    ).toThrow("pi_package_invalid_path");
  });

  it.each(["file", "directory", "symlink"] as const)(
    "rejects duplicate %s paths",
    (type) => {
      const entry: PiPackageEntryV1 =
        type === "file"
          ? file("package/index.ts")
          : type === "directory"
            ? { type, path: "package/index.ts" }
            : { type, path: "package/index.ts", target: "index.ts" };
      expect(() => parsePiPackageReleaseManifest(withEntries([entry]))).toThrow(
        "pi_package_invalid_path",
      );
    },
  );

  it.each([false, true])(
    "rejects descendants beneath files and links in either ordering (%s)",
    (reverse) => {
      for (const parent of [
        file("package/parent"),
        {
          type: "symlink",
          path: "package/parent",
          target: "index.ts",
        } as const,
      ]) {
        const entries = [parent, file("package/parent/child.ts")];
        expect(() =>
          parsePiPackageReleaseManifest(
            withEntries(reverse ? entries.reverse() : entries),
          ),
        ).toThrow("pi_package_parent_conflict");
      }
    },
  );

  it("resolves internal directory links and multi-hop relative links", () => {
    const manifest = withEntries([
      { type: "directory", path: "package/lib" },
      file("package/lib/extension.ts"),
      { type: "symlink", path: "package/lib/next.ts", target: "extension.ts" },
      { type: "symlink", path: "package/alias.ts", target: "lib/next.ts" },
      { type: "symlink", path: "package/linked", target: "lib" },
      { type: "symlink", path: "package/lib/back.ts", target: "../index.ts" },
    ]);
    manifest.package.resources.extensions = [
      "package/alias.ts",
      "package/linked/extension.ts",
      "package/lib/back.ts",
    ];
    expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
  });

  it.each(
    (
      [
        [{ type: "symlink", path: "package/a", target: "a" }],
        [
          { type: "symlink", path: "package/a", target: "b" },
          { type: "symlink", path: "package/b", target: "a" },
        ],
        [{ type: "symlink", path: "package/a", target: "../outside" }],
        [{ type: "symlink", path: "package/a", target: "/package/index.ts" }],
        [{ type: "symlink", path: "package/a", target: "missing" }],
        [{ type: "symlink", path: "package/a", target: "lib\\index.ts" }],
      ] as PiPackageEntryV1[][]
    ).map((entries) => ({ entries })),
  )(
    "rejects escaping, cyclic, dangling and malformed links %#",
    ({ entries }) => {
      expect(() => parsePiPackageReleaseManifest(withEntries(entries))).toThrow(
        /pi_package_(symlink|invalid_symlink)/,
      );
    },
  );

  it("handles long symlink chains without recursive stack exhaustion", () => {
    const manifest = withEntries(
      Array.from({ length: 1_000 }, (_, i) => ({
        type: "symlink" as const,
        path: `package/link${i}.ts`,
        target: i === 999 ? "index.ts" : `link${i + 1}.ts`,
      })),
    );
    manifest.package.resources.extensions = ["package/link0.ts"];
    expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
  });

  it("resolves links before .. rather than lexical path normalization", () => {
    const manifest = withEntries([
      { type: "directory", path: "package/deep" },
      { type: "directory", path: "package/deep/nested" },
      { type: "symlink", path: "package/link", target: "deep/nested" },
      file("package/deep/target.ts"),
      {
        type: "symlink",
        path: "package/alias.ts",
        target: "link/../target.ts",
      },
    ]);
    manifest.package.resources.extensions = ["package/alias.ts"];
    expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
  });

  it.each(["Zg", "Z g==", "Zg===", "Zg==\n", "Zh==", "Zm9=", "====", "_w=="])(
    "rejects noncanonical base64 %j",
    (content) => {
      const manifest = fixture();
      const entry = manifest.package.entries[1];
      if (entry.type !== "file") throw new Error("fixture");
      entry.content = content;
      entry.sha256 = createHash("sha256")
        .update(Buffer.from(content, "base64"))
        .digest("hex");
      expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
        "pi_package_invalid_base64",
      );
    },
  );

  it("accepts zero-byte files and exact single-file byte limit", () => {
    const manifest = withEntries([
      file("package/empty"),
      file("package/large", "x".repeat(16 * 1024 * 1024)),
    ]);
    expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
  });

  it("rejects file, entry, decoded total and serialized JSON limits", () => {
    expect(() =>
      parsePiPackageReleaseManifest(
        withEntries([file("package/large", "x".repeat(16 * 1024 * 1024 + 1))]),
      ),
    ).toThrow("pi_package_file_too_large");
    const entries = Array.from({ length: 19_999 }, (_, i) => ({
      type: "directory" as const,
      path: `package/d${i}`,
    }));
    expect(() => parsePiPackageReleaseManifest(withEntries(entries))).toThrow(
      "pi_package_entries_limit",
    );
    const large = file("package/large", "x".repeat(13 * 1024 * 1024));
    expect(() =>
      parsePiPackageReleaseManifest(
        withEntries(
          Array.from({ length: 5 }, (_, i) => ({
            ...large,
            path: `package/large${i}`,
          })),
        ),
      ),
    ).toThrow("pi_package_snapshot_too_large");
    const manifest = fixture();
    manifest.listing.summary = "x".repeat(96 * 1024 * 1024);
    expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
      "pi_package_manifest_too_large",
    );
  });

  it("accepts exactly 20,000 entries", () => {
    const manifest = withEntries(
      Array.from({ length: 19_998 }, (_, i) => ({
        type: "directory" as const,
        path: `package/d${i}`,
      })),
    );
    expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
  });

  it.each(["fifo", "device", "hardlink", "sparse"])(
    "rejects unsupported entry type %s",
    (type) => {
      const manifest = fixture();
      (manifest.package.entries as unknown[]).push({
        type,
        path: "package/unsafe",
        target: "package/index.ts",
      });
      expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
        "pi_package_invalid",
      );
    },
  );

  it("rejects unknown fields and unsafe or absent resources", () => {
    expect(() =>
      parsePiPackageReleaseManifest({ ...fixture(), unexpected: true }),
    ).toThrow("pi_package_invalid");
    for (const extensions of [
      [],
      ["../index.ts"],
      ["package/missing.ts"],
      ["package/index.ts", "package/index.ts"],
      ["package"],
    ]) {
      const manifest = fixture();
      manifest.package.resources.extensions = extensions;
      expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
        /pi_package_(resources_missing|invalid_resource|symlink_missing)/,
      );
    }
  });

  it("requires actual extension files and validates every resource class", () => {
    const manifest = withEntries([file("package/readme.txt")]);
    manifest.package.resources.extensions = ["package/readme.txt"];
    expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
      "pi_package_invalid_resource",
    );
    for (const kind of ["skills", "prompts", "themes"] as const) {
      const invalidManifest = fixture();
      invalidManifest.package.resources[kind] = ["../outside"];
      expect(() => parsePiPackageReleaseManifest(invalidManifest)).toThrow(
        "pi_package_invalid_resource",
      );
    }
  });

  it.each([
    { name: "different" },
    { version: "latest" },
    { version: "1.2.3-01" },
    { requested: "npm:example@https://private.invalid/archive" },
    { requested: "npm:other@latest" },
    { integrity: "sha512-Zg==" },
  ])("rejects imprecise npm provenance %#", (change) => {
    const manifest = fixture();
    Object.assign(manifest.package.source, change);
    expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
      "pi_package_invalid_source",
    );
  });
  it("accepts scoped npm names and semver ranges with spaces", () => {
    const manifest = fixture();
    manifest.package.name = "@scope/example";
    if (manifest.package.source.kind !== "npm") throw new Error("fixture");
    manifest.package.source.name = "@scope/example";
    manifest.package.source.requested = "npm:@scope/example@>=1.0.0 <2.0.0";
    expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
  });

  it.each([
    "git@code.example:owner/repo.git@main",
    "git:code.example/owner/repo.git@main",
    "git:https://code.example/owner/repo.git@main",
    "https://code.example/owner/repo.git#main",
  ])(
    "accepts public Git provenance %s with pinned SHA and absent package version",
    (requested) => {
      const manifest = fixture();
      manifest.package.version = null;
      manifest.package.source = {
        kind: "git",
        requested,
        url: "https://code.example/owner/repo.git",
        commit: "a".repeat(40),
      };
      expect(parsePiPackageReleaseManifest(manifest)).toEqual(manifest);
    },
  );

  it.each([
    "https://user:password@code.example/repo.git",
    "https://code.example/repo.git?token=secret",
    "http://code.example/repo.git",
    "file:///tmp/repo",
  ])("rejects credentialed or nonpublic Git provenance %s", (url) => {
    const manifest = fixture();
    manifest.package.source = {
      kind: "git",
      requested: url,
      url,
      commit: "a".repeat(40),
    };
    expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
      "pi_package_invalid_source",
    );
  });

  it("rejects unpinned Git refs and wrong runtime identity", () => {
    const manifest = fixture();
    manifest.package.source = {
      kind: "git",
      requested: "https://code.example/repo.git",
      url: "https://code.example/repo.git",
      commit: "main",
    };
    expect(() => parsePiPackageReleaseManifest(manifest)).toThrow(
      "pi_package_invalid_source",
    );
    expect(() =>
      parsePiPackageReleaseManifest({
        ...fixture(),
        package: {
          ...fixture().package,
          runtime: { ...fixture().package.runtime, piVersion: "0.80.3" },
        },
      }),
    ).toThrow("pi_package_invalid");
  });

  it("scans decoded text even with NUL bytes, listing and notes without disclosing credentials", () => {
    const secret = "sk-proj-1234567890abcdefghijklmnop";
    const manifest = withEntries([file("package/config", `\0${secret}`)]);
    manifest.listing.summary = secret;
    const result = scanPiPackageReleaseManifest(manifest, `Notes ${secret}`);
    expect(result.status).toBe("blocked");
    expect(result.findings).toContainEqual({
      kind: "openai_key",
      path: "manifest.package.entries[2].content(decoded)",
    });
    expect(result.findings).toContainEqual({
      kind: "openai_key",
      path: "manifest.listing.summary",
    });
    expect(result.findings).toContainEqual({
      kind: "openai_key",
      path: "releaseNotes",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns stable safe errors rather than untrusted paths or package content", () => {
    const secret = "sk-proj-1234567890abcdefghijklmnop";
    try {
      parsePiPackageReleaseManifest(
        withEntries([file(`../${secret}`, secret)]),
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toBe("pi_package_invalid_path");
    }
  });
});
