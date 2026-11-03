import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportOmpConfig } from "../../scripts/export-omp-config.mjs";
import { OmpImportBundleSchema } from "@/lib/agents/omp-import-contract";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omp-export-"));
  temporary.push(root);
  async function put(path: string, value: string | object | Buffer) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(
      destination,
      typeof value === "object" && !Buffer.isBuffer(value)
        ? JSON.stringify(value)
        : value,
    );
  }
  await put("config.yml", "display:\n  showTokenUsage: true\n");
  await put("last-changelog-version", "18.14.0");
  return { root, put };
}
async function pluginFixture() {
  const f = await fixture();
  await f.put("plugins/package.json", { dependencies: { sample: "1.0.0" } });
  await f.put("plugins/omp-plugins.lock.json", {
    plugins: {
      sample: { version: "1.0.0", enabled: true, enabledFeatures: ["extra"] },
    },
    settings: { sample: { greeting: "Hello" } },
  });
  await f.put("plugins/node_modules/sample/package.json", {
    name: "sample",
    version: "1.0.0",
    omp: {
      extensions: ["index.mjs"],
      features: {
        extra: { extensions: ["extra.mjs"] },
        ignored: { default: true, extensions: ["not-selected.mjs"] },
      },
    },
    dependencies: { helper: "^2.0.0" },
  });
  await f.put(
    "plugins/node_modules/sample/index.mjs",
    'import value from "helper"; export default function(pi) { pi.registerTool(value); }',
  );
  await f.put(
    "plugins/node_modules/sample/extra.mjs",
    "export default function() {}\n",
  );
  await f.put("plugins/node_modules/helper/package.json", {
    name: "helper",
    version: "2.1.0",
    main: "index.cjs",
  });
  await f.put(
    "plugins/node_modules/helper/index.cjs",
    "module.exports = { name: 'sample_tool' };\n",
  );
  return f;
}

describe("offline OMP exporter semantic boundaries", () => {
  it("externalizes model routing and MCP secrets without copying auth databases or local paths", async () => {
    const { root, put } = await fixture();
    const secret = "never-export-this-credential";
    await put(
      "config.yml",
      `modelRoles:\n  default: sample/model-a\nservice:\n  apiKey: ${secret}\nlocalPath: /home/private-user/docs\ndisplay:\n  showTokenUsage: true\n`,
    );
    await put("auth.json", { credential: "unread-auth-sentinel" });
    await put("models.yml", "apiKey: unread-model-sentinel");
    await put("mcp.json", {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: `Bearer ${secret}` },
        },
        stdio: {
          command: "docker",
          args: ["run", "-i", "--rm", "image@sha256:123", "node"],
          env: { ACCESS_TOKEN: `\${ACCESS_TOKEN}` },
        },
      },
    });
    const bundle = await exportOmpConfig({ root });
    expect(OmpImportBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.model).toEqual({ provider: "sample", model: "model-a" });
    expect(bundle.settings.display).toEqual({ showTokenUsage: true });
    const serialized = JSON.stringify(bundle);
    for (const privateValue of [
      secret,
      "unread-auth-sentinel",
      "unread-model-sentinel",
      "/home/private-user",
      root,
    ])
      expect(serialized).not.toContain(privateValue);
    const remote = bundle.mcpServers.find(
      (v: { name: string }) => v.name === "remote",
    );
    expect(remote?.requiredSecrets).toHaveLength(1);
    expect(remote?.config.headers).toEqual({
      Authorization: `Bearer \${${remote?.requiredSecrets[0]}}`,
    });
    const stdio = bundle.mcpServers.find(
      (v: { name: string }) => v.name === "stdio",
    );
    expect(stdio?.requiredSecrets).toEqual(["ACCESS_TOKEN"]);
    expect(stdio?.config.env).toEqual({ ACCESS_TOKEN: `\${ACCESS_TOKEN}` });
  });

  it("preserves skill support bytes, materializes safe links and blocks escaping or broken links", async () => {
    const { root, put } = await fixture();
    await put(
      "skills/demo/SKILL.md",
      "---\nname: demo\ndescription: Example skill\n---\nRead references/data.json.\n",
    );
    await put("skills/demo/references/data.json", { value: 42 });
    await put("skills/demo/image.bin", Buffer.from([0, 255, 1, 2]));
    await symlink(
      "references/data.json",
      join(root, "skills/demo/data-link.json"),
    );
    const outside = await mkdtemp(join(tmpdir(), "omp-outside-"));
    temporary.push(outside);
    await writeFile(
      join(outside, "private.txt"),
      "must-not-export-outside-content",
    );
    await symlink(
      join(outside, "private.txt"),
      join(root, "skills/demo/escape.txt"),
    );
    await symlink("missing.txt", join(root, "skills/demo/broken.txt"));
    const bundle = await exportOmpConfig({ root });
    const skill = bundle.skills[0];
    expect(
      skill.files.find((v) => v.path === "references/data.json")?.content,
    ).toBe('{"value":42}');
    expect(skill.files.find((v) => v.path === "data-link.json")?.content).toBe(
      '{"value":42}',
    );
    expect(
      skill.files.find((v: { path: string }) => v.path === "image.bin"),
    ).toMatchObject({ encoding: "base64", content: "AP8BAg==" });
    expect(JSON.stringify(bundle)).not.toContain(
      "must-not-export-outside-content",
    );
    expect(bundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNSAFE_LINK", resourceId: skill.id }),
        expect.objectContaining({
          code: "RESOURCE_MISSING",
          resourceId: skill.id,
        }),
      ]),
    );
  });

  it("captures enabled features and the installed transitive dependency closure without running hooks", async () => {
    const { root, put } = await pluginFixture();
    await put("plugins/node_modules/helper/package.json", {
      name: "helper",
      version: "2.1.0",
      main: "index.cjs",
      dependencies: { leaf: "1.0.0" },
      scripts: { postinstall: "touch SHOULD_NOT_EXIST" },
    });
    await put("plugins/node_modules/leaf/package.json", {
      name: "leaf",
      version: "1.0.0",
    });
    await put("plugins/node_modules/leaf/index.js", "module.exports = 42;");
    await put("config.yml.backup-20261003", "backup-local-secret-sentinel");
    await put(
      "plugins/node_modules/sample/._index.mjs",
      "filesystem-metadata-sentinel",
    );
    const bundle = await exportOmpConfig({ root });
    expect(OmpImportBundleSchema.safeParse(bundle).success).toBe(true);
    const plugin = bundle.plugins[0].plugin;
    expect(plugin.enabledFeatures).toEqual(["extra"]);
    expect(plugin.extensions).toEqual(["index.mjs", "extra.mjs"]);
    expect(plugin.config).toEqual({ greeting: "Hello" });
    expect(plugin.files.map((v: { path: string }) => v.path)).toEqual(
      expect.arrayContaining([
        "node_modules/helper/package.json",
        "node_modules/helper/index.cjs",
        "node_modules/helper/node_modules/leaf/index.js",
      ]),
    );
    expect(
      bundle.issues.filter(
        (v: { severity: string }) => v.severity === "blocked",
      ),
    ).toEqual([]);
    expect(JSON.stringify(bundle)).not.toContain(
      "backup-local-secret-sentinel",
    );
    expect(JSON.stringify(bundle)).not.toContain(
      "filesystem-metadata-sentinel",
    );
    await expect(
      readFile(join(root, "SHOULD_NOT_EXIST")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports missing dependencies and unresolved selected resources rather than silently dropping them", async () => {
    const { root, put } = await pluginFixture();
    await put("plugins/node_modules/sample/package.json", {
      name: "sample",
      version: "1.0.0",
      omp: { extensions: ["missing.mjs"] },
      dependencies: { missing: "1.0.0" },
    });
    const bundle = await exportOmpConfig({ root });
    const id = bundle.plugins[0].id;
    expect(bundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: id,
          code: "DEPENDENCY_MISSING",
          severity: "blocked",
        }),
        expect.objectContaining({
          resourceId: id,
          code: "PLUGIN_ENTRY_UNRESOLVED",
          severity: "blocked",
        }),
      ]),
    );
  });

  it("keeps cyclic package dependencies resolvable in a finite snapshot", async () => {
    const { root, put } = await pluginFixture();
    await put("plugins/node_modules/helper/package.json", {
      name: "helper",
      version: "2.1.0",
      dependencies: { sample: "1.0.0" },
    });
    const bundle = await exportOmpConfig({ root });
    const files = bundle.plugins[0].plugin.files.map(
      (v: { path: string }) => v.path,
    );
    expect(files).toContain(
      "node_modules/helper/node_modules/sample/package.json",
    );
    expect(files.length).toBeLessThan(30);
    expect(
      bundle.issues.some(
        (v: { code: string }) => v.code === "DEPENDENCY_LIMIT",
      ),
    ).toBe(false);
  });

  it("exposes native-platform and source-version incompatibilities", async () => {
    const { root, put } = await pluginFixture();
    await put("last-changelog-version", "18.15.0");
    await put(
      "plugins/node_modules/sample/addon.node",
      Buffer.from("MZ-not-a-linux-ELF"),
    );
    const bundle = await exportOmpConfig({ root });
    expect(bundle.ompVersion).toBe("18.15.0");
    expect(bundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "VERSION_MISMATCH",
          severity: "blocked",
        }),
        expect.objectContaining({
          code: "NATIVE_PLATFORM_MISMATCH",
          severity: "blocked",
        }),
      ]),
    );
  });

  it("packages native roles and commands privately and makes shell hooks explicit blockers", async () => {
    const { root, put } = await fixture();
    await put(
      "config.yml",
      "modelRoles:\n  default: sample/parent\n  backend: sample/backend:auto\ntask:\n  agentModelOverrides:\n    reviewer: '@backend'\n",
    );
    await put(
      "agents/reviewer.md",
      "---\nname: reviewer\nmodel: '@backend'\ndescription: Review changes\n---\nReview the diff.\n",
    );
    await put("commands/check.md", "Check the selected files.");
    await put("hooks/pre/bash.sh", "#!/bin/sh\nexit 0\n");
    const bundle = await exportOmpConfig({ root });
    const roles = bundle.plugins.find(
      (v: { plugin: { name: string } }) =>
        v.plugin.name === "omp-import-agents",
    );
    expect(roles?.plugin.runtimeKind).toBe("omp");
    expect(roles?.plugin.subagents).toEqual(["reviewer.md"]);
    expect(
      roles?.plugin.files.find((file) => file.path === "reviewer.md")?.content,
    ).toContain("model: '@backend'");
    expect(bundle.modelRoles).toEqual({
      default: "sample/parent",
      backend: "sample/backend:auto",
    });
    expect(bundle.taskModelOverrides).toEqual({ reviewer: "@backend" });
    expect(
      bundle.issues
        .filter((issue) => issue.code === "ROLE_MODEL_MAPPING_REQUIRED")
        .every((issue) => issue.severity === "warning"),
    ).toBe(true);
    expect(
      bundle.issues.some((issue) => issue.code === "ROLE_MODEL_UNRESOLVED"),
    ).toBe(false);
    expect(OmpImportBundleSchema.safeParse(bundle).success).toBe(true);
    expect(
      bundle.plugins.find((v) => v.plugin.name === "omp-import-commands")
        ?.plugin.commands,
    ).toEqual(["check.md"]);
    expect(bundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "NATIVE_RESOURCE_UNMAPPED",
          severity: "blocked",
        }),
      ]),
    );
    expect(bundle.instructions).toEqual([]);
  });
  it("never serializes secrets from private plugin setting declarations or URL credentials", async () => {
    const { root, put } = await pluginFixture();
    const secret = "custom-declared-secret-value";
    await put("plugins/omp-plugins.lock.json", {
      plugins: {
        sample: { version: "1.0.0", enabled: true, enabledFeatures: [] },
      },
      settings: { sample: { account: secret } },
    });
    await put("plugins/node_modules/sample/package.json", {
      name: "sample",
      version: "1.0.0",
      omp: {
        extensions: ["index.mjs"],
        settings: { account: { type: "string", secret: true } },
      },
    });
    await put("mcp.json", {
      mcpServers: {
        private: {
          url: "https://example.com/mcp?apiKey=url-credential-sentinel",
        },
        local: { command: "/home/private-user/bin/server", args: [] },
      },
    });
    const bundle = await exportOmpConfig({ root });
    for (const privateValue of [
      secret,
      "url-credential-sentinel",
      "/home/private-user",
    ])
      expect(JSON.stringify(bundle)).not.toContain(privateValue);
    expect(bundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PLUGIN_CONFIG_PRIVATE" }),
        expect.objectContaining({ code: "MCP_VALUE_REQUIRES_MAPPING" }),
        expect.objectContaining({ code: "MCP_EXECUTABLE_UNRESOLVED" }),
      ]),
    );
  });

  it("detects ancestor-directory skill cycles instead of traversing indefinitely", async () => {
    const { root, put } = await fixture();
    await put("skills/nested/child/support.txt", "No skill entrypoint");
    await symlink("../..", join(root, "skills/nested/child/loop"));
    const bundle = await exportOmpConfig({ root });
    expect(bundle.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNSAFE_LINK" }),
      ]),
    );
  });
});
