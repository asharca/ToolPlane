// @vitest-environment node
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { assemblePiPackage } from "@/lib/market/pi-package-assembly";
import { flattenPiPackages } from "@/lib/pi-packages/flatten";
import {
  parsePromptTemplate,
  expandPromptTemplate,
} from "@/lib/pi-packages/prompts";
import {
  parsePiPackageReleaseManifest,
  type PiPackageEntryV1,
  type PiPackageSnapshotV1,
} from "@/lib/market/pi-package-manifest";
import { marketReleaseChecksum } from "@/lib/market/artifact";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

function file(path: string, content: string): PiPackageEntryV1 {
  return {
    type: "file",
    path: `package/${path}`,
    executable: false,
    contentEncoding: "base64",
    content: Buffer.from(content).toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
function source(name: string, prompt = "Review $1"): PiPackageSnapshotV1 {
  return {
    name,
    version: "1.0.0",
    source: {
      kind: "toolplane",
      name,
      version: "1.0.0",
      requested: `toolplane:${name}@1.0.0`,
    },
    root: "package",
    runtime: {
      kind: "pi-sdk",
      piVersion: "0.87.1",
      nodeMajor: 26,
      platform: "any",
      arch: "any",
    },
    resources: {
      extensions: [],
      skills: [],
      prompts: ["package/prompts/review.md"],
      themes: [],
    },
    entries: [file("prompts/review.md", prompt)],
  };
}
const listing = {
  slug: "assembled",
  name: "Assembled",
  summary: null,
  iconUrl: null,
  tags: [],
  author: "Author",
};

describe("immutable Pi package assembly", () => {
  it("rejects oversized file contents before querying workspace resources", async () => {
    const query = vi.fn();
    const tx = {
      installedSkill: { findMany: query },
    } as unknown as Prisma.TransactionClient;
    await expect(
      assemblePiPackage(tx, {
        workspaceId: "workspace",
        name: "safe-package",
        version: "1.0.0",
        installedSkillIds: [],
        mcps: [],
        themes: [{ name: "large", content: "x".repeat(1024 * 1024 + 1) }],
      }),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts Theme-only assembly without a dummy extension and retains all four declarations", async () => {
    const tx = {
      installedSkill: { findMany: async () => [] },
      deployment: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient;
    const { snapshot } = await assemblePiPackage(tx, {
      workspaceId: "private-workspace-id",
      name: "theme-package",
      version: "1.0.0",
      installedSkillIds: [],
      mcps: [],
      themes: [{ name: "night", content: '{"name":"night"}' }],
    });
    expect(snapshot.resources.extensions).toEqual([]);
    expect(snapshot.resources.themes).toHaveLength(1);
    const manifest = parsePiPackageReleaseManifest({
      schemaVersion: 1,
      kind: "pi-package",
      listing,
      package: snapshot,
    });
    expect(manifest.package.toolplane?.origins).toHaveLength(1);
    const entry = snapshot.entries.find(
      (entry) => entry.path === "package/package.json",
    );
    if (entry?.type !== "file") throw new Error("Missing package manifest");
    expect(
      Object.keys(
        JSON.parse(Buffer.from(entry.content, "base64").toString()).pi,
      ).sort(),
    ).toEqual(["extensions", "prompts", "skills", "themes"]);
    expect(JSON.stringify(snapshot)).not.toContain("private-workspace-id");
  });

  it("deduplicates identical Skill and Prompt content while retaining both source references", () => {
    const first = source("first");
    first.resources.skills.push("package/skills/review/SKILL.md");
    first.entries.push(
      file("skills/review/SKILL.md", "---\nname: review\n---\nReview"),
      file("skills/review/ref.txt", "Reference"),
    );
    const second = structuredClone(first);
    second.name = "second";
    const flat = flattenPiPackages([first, second]);
    expect(flat.resources.prompts).toHaveLength(1);
    expect(flat.resources.skills).toHaveLength(1);
    expect(
      flat.toolplane?.origins?.map((origin) => origin.sources.length),
    ).toEqual([2, 2]);
  });

  it("assembles an immutable selected package (preserving its pass-through Prompt declaration as-is) together with a standalone Theme file", async () => {
    const pkg = source("existing");
    pkg.resources = {
      extensions: ["package/index.ts"],
      skills: ["package/skills/help/SKILL.md"],
      prompts: ["package/prompts/legacy.md"],
      themes: [],
    };
    pkg.entries = [
      file(
        "index.ts",
        "export default pi => pi.registerCommand('analyze', {});",
      ),
      file("skills/help/SKILL.md", "---\nname: help\n---\nHelp"),
      file("prompts/legacy.md", "Legacy prompt, preserved as-is"),
      file("LICENSE", "MIT"),
    ];
    const manifest = {
      schemaVersion: 1,
      kind: "pi-package",
      listing,
      package: pkg,
    };
    const releases = vi.fn(async () => [
      { manifest, checksum: marketReleaseChecksum(manifest) },
    ]);
    const tx = {
      installedSkill: { findMany: async () => [] },
      deployment: { findMany: async () => [] },
      marketRelease: { findMany: releases },
    } as unknown as Prisma.TransactionClient;
    const { snapshot } = await assemblePiPackage(tx, {
      workspaceId: "workspace-private",
      name: "composed",
      version: "1.0.0",
      installedSkillIds: [],
      mcps: [],
      packageReleaseIds: ["immutable-release"],
      themes: [{ name: "night", content: '{"name":"night"}' }],
    });
    expect(
      Object.values(snapshot.resources).map((paths) => paths.length),
    ).toEqual([1, 1, 1, 1]);
    expect(
      parsePiPackageReleaseManifest({
        schemaVersion: 1,
        kind: "pi-package",
        listing,
        package: snapshot,
      }).package.toolplane?.origins,
    ).toHaveLength(4);
    expect(releases).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reviewStatus: "approved",
          id: { in: ["immutable-release"] },
        }),
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("workspace-private");
    expect(JSON.stringify(snapshot)).not.toContain("immutable-release");
  });

  it("rejects incompatible logical versions and same native names rather than renaming", () => {
    expect(() =>
      flattenPiPackages([source("same"), source("same", "Different")]),
    ).toThrow("Incompatible versions");
    expect(() =>
      flattenPiPackages([source("first"), source("second", "Different")]),
    ).toThrow("command:review conflicts");
    const extension = source("extension");
    extension.resources = {
      extensions: ["package/index.ts"],
      skills: [],
      prompts: [],
      themes: [],
    };
    extension.entries = [
      file("index.ts", "import './commands.js';"),
      file(
        "commands.js",
        "export default pi => pi.registerCommand('review', {});",
      ),
    ];
    // Native registration runs at revision publication/runtime; source text is not a parser.
    const flattened = flattenPiPackages([extension, source("prompt")]);
    expect(flattened.resources.extensions).toHaveLength(1);
    expect(flattened.resources.prompts).toHaveLength(1);
    expect(flattened).not.toHaveProperty("origins");
    expect(() =>
      flattenPiPackages([
        source("reserved", "text"),
        {
          ...source("builtin"),
          resources: {
            extensions: [],
            skills: [],
            prompts: ["package/prompts/model.md"],
            themes: [],
          },
          entries: [file("prompts/model.md", "text")],
        },
      ]),
    ).toThrow("built-in command");
  });

  it("retains relative imports, dependency trees, symlinks, lockfiles and licenses for four-resource assembly", () => {
    const snapshot = source("complete");
    snapshot.resources.extensions.push("package/src/index.ts");
    snapshot.resources.skills.push("package/skills/help/SKILL.md");
    snapshot.resources.themes.push("package/themes/night.json");
    snapshot.entries.push(
      file(
        "src/index.ts",
        "import helper from './helper.js'; export default helper;",
      ),
      file("src/helper.js", "export default () => {};"),
      file("node_modules/dependency/index.js", "export default 1;"),
      file("package-lock.json", '{"lockfileVersion":3}'),
      file("LICENSE", "MIT"),
      file("skills/help/SKILL.md", "---\nname: help\n---\nHelp"),
      file("themes/night.json", '{"name":"night"}'),
      { type: "symlink", path: "package/src/alias.js", target: "helper.js" },
    );
    const flat = flattenPiPackages([snapshot]);
    expect(Object.values(flat.resources).map((paths) => paths.length)).toEqual([
      1, 1, 1, 1,
    ]);
    const root = flat.resources.extensions[0].slice(0, -"src/index.ts".length);
    for (const path of [
      "src/helper.js",
      "node_modules/dependency/index.js",
      "package-lock.json",
      "LICENSE",
    ])
      expect(
        flat.entries.some((entry) => entry.path === `${root}${path}`),
      ).toBe(true);
    expect(
      flat.entries.find((entry) => entry.path === `${root}src/alias.js`),
    ).toMatchObject({ type: "symlink", target: "helper.js" });
    expect(flat.toolplane?.reproducibility).toEqual([]);
  });
});

describe("Pi 0.87.1 static Prompt semantics", () => {
  it("parses BOM/newlines/frontmatter and native filename identity without treating prose as executable", () => {
    const template = parsePromptTemplate(
      '\uFEFF---\r\ndescription: "Review code"\r\nargument-hint: "<target>"\r\n---\r\nAsk the user to run shell commands. $1',
      {
        identity: "release-digest",
        path: "prompts/review.md",
        version: "1.2.3",
      },
    );
    expect(template).toMatchObject({
      name: "review",
      description: "Review code",
      argumentHint: "<target>",
      assistantCompatible: true,
      content: "Ask the user to run shell commands. $1",
    });
    expect(template.source.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      parsePromptTemplate("text", { identity: "x", path: "../escape.md" }),
    ).toThrow("prompt_source_invalid");
    expect(() =>
      parsePromptTemplate("text", {
        identity: "x",
        path: "safe.md",
        checksum: "0".repeat(64),
      }),
    ).toThrow("prompt_checksum_mismatch");
  });
  it("expands quoted positions, defaults and slices exactly once, without evaluating expressions", () => {
    const template = parsePromptTemplate(
      `$1|$2|$@|\${3:-default}|\${@:2:1}|\${ARGUMENTS:-empty}|$(whoami)|\${HOME}`,
      { identity: "x", path: "review.md" },
    );
    expect(expandPromptTemplate(template, "\"hello world\" '$1'")).toBe(
      `hello world|$1|hello world $1|default|$1|hello world $1|$(whoami)|\${HOME}`,
    );
    expect(expandPromptTemplate(template, [])).toBe(
      `|||default||empty|$(whoami)|\${HOME}`,
    );
  });
  it("rejects explicit standalone Assistant dependencies without rejecting ordinary prose", () => {
    const template = parsePromptTemplate(
      "---\ntoolplane:\n  requires:\n    skills: [review]\n    shell: true\n    localFiles: [README.md]\n    extensions: [helper]\n    commands: [deploy]\n---\nReview",
      { identity: "x", path: "review.md" },
    );
    expect(template.assistantCompatible).toBe(false);
    expect(template.incompatibilities).toHaveLength(5);
    expect(
      parsePromptTemplate("Discuss shell and Skill design", {
        identity: "x",
        path: "discuss.md",
      }).assistantCompatible,
    ).toBe(true);
    expect(
      parsePromptTemplate(
        "---\ntoolplane:\n  requires:\n    futureRuntime: true\n---\nReview",
        { identity: "x", path: "review.md" },
      ).assistantCompatible,
    ).toBe(false);
  });
});
