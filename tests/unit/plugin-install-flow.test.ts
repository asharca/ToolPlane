// @vitest-environment node
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPluginInstallScript,
  buildToolkitInstallScript,
} from "@/lib/plugin/install-script";

const execFileAsync = promisify(execFile);
let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(tmp, rel), "utf8"));
}

function writeFakeCurl(
  bin: string,
  skill = {
    slug: "alpha",
    content: "# Alpha\n\nBody",
    filePath: "scripts/alpha.py",
    fileContent: "print(1)",
  },
) {
  writeFileSync(
    path.join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$HOME/curl-calls.log"',
      'case "$*" in',
      '  *"/api/v1/plugin/baseline"*)',
      `    printf "%s\\n" '${JSON.stringify({
        data: {
          schemaVersion: 1,
          snapshotComplete: true,
          workspaceSlug: "ws",
          toolkitSlug: "tk",
          skills: [
            {
              slug: skill.slug,
              content: skill.content,
              files: [{ path: skill.filePath, content: skill.fileContent }],
              version: createHash("sha256")
                .update(
                  JSON.stringify({
                    content: skill.content,
                    files: [
                      { path: skill.filePath, content: skill.fileContent },
                    ],
                  }),
                )
                .digest("hex")
                .slice(0, 12),
            },
          ],
        },
      }).replace(/'/g, "'\\''")}'`,
      "    ;;",
      '  *"/api/v1/plugin/sync-applied"*|*"/api/v1/plugin/sync-failure"*)',
      "    exit 0",
      "    ;;",
      "  *)",
      '    echo "Unexpected test curl request" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

describe("generated Claude Code plugin installer", () => {
  it("installs the plugin files and registers through the claude CLI", () => {
    tmp = mkdtempSync(path.join(tmpdir(), "toolplane-install-"));
    const bin = path.join(tmp, ".local/bin");
    mkdirSync(bin, { recursive: true });
    const claudeStub = path.join(bin, "claude");
    writeFileSync(
      claudeStub,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$HOME/claude-calls.log"\nexit 0\n',
      { mode: 0o755 },
    );

    const installer = path.join(tmp, "install.sh");
    writeFileSync(
      installer,
      buildPluginInstallScript({
        base: "https://mcp.example.com",
        workspaceSlug: "ws",
        toolkitSlug: "tk",
        token: "sk_user_TEST",
        client: "claude-code",
      }),
      { mode: 0o755 },
    );

    execFileSync("/bin/bash", [installer], {
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    });

    const root = ".claude/plugins/toolplane-775ff1e300598486cd833e1c";
    const marketplace = readJson(`${root}/.claude-plugin/marketplace.json`) as {
      name: string;
      plugins: { name: string; source: string }[];
    };
    expect(marketplace.name).toBe("toolplane-775ff1e300598486cd833e1c");
    expect(marketplace.plugins[0]).toEqual({
      name: "toolplane-775ff1e300598486cd833e1c",
      source: "./",
    });

    const plugin = readJson(`${root}/.claude-plugin/plugin.json`) as {
      skills: string;
      mcpServers: string;
    };
    expect(plugin.skills).toBe("./skills/");
    expect(plugin.mcpServers).toBe("./.mcp.json");

    const mcp = readJson(`${root}/.mcp.json`) as {
      mcpServers: Record<
        string,
        { url: string; headers: { Authorization: string } }
      >;
    };
    expect(mcp.mcpServers["toolplane-775ff1e300598486cd833e1c"]).toEqual({
      url: "https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp",
      headers: { Authorization: "Bearer sk_user_TEST" },
    });

    const hooks = readJson(`${root}/hooks/hooks.json`) as {
      hooks: {
        SessionStart: unknown[];
        PostToolUse: unknown[];
        PostToolUseFailure: unknown[];
      };
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.PostToolUseFailure).toHaveLength(1);
    expect(
      statSync(path.join(tmp, `${root}/shared/sync.sh`)).mode & 0o111,
    ).toBeTruthy();
    expect(
      statSync(path.join(tmp, `${root}/shared/skill-invocation.sh`)).mode &
        0o111,
    ).toBeTruthy();

    const calls = readFileSync(path.join(tmp, "claude-calls.log"), "utf8");
    expect(calls).toContain(`plugin marketplace add ${path.join(tmp, root)}`);
    expect(calls).toContain(
      "plugin uninstall toolplane-775ff1e300598486cd833e1c@toolplane-775ff1e300598486cd833e1c",
    );
    expect(calls).toContain(
      "plugin install toolplane-775ff1e300598486cd833e1c@toolplane-775ff1e300598486cd833e1c",
    );
  });
});

describe("generated Codex installer", () => {
  it("configures Codex MCP, hooks, and synced user skills", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "toolplane-codex-install-"));
    const bin = path.join(tmp, ".local/bin");
    mkdirSync(bin, { recursive: true });
    // sync.sh prepends ~/.local/bin: keep every child on the test runner's Node.
    symlinkSync(process.execPath, path.join(bin, "node"));
    writeFakeCurl(bin);

    const installer = path.join(tmp, "install-codex.sh");
    writeFileSync(
      installer,
      buildToolkitInstallScript({
        base: "https://mcp.example.com",
        workspaceSlug: "ws",
        toolkitSlug: "tk",
        token: "sk_user_CODEX",
        client: "codex",
      }),
      { mode: 0o755 },
    );

    // This exercises several real Node processes and durable filesystem writes,
    // not a single unit call. Bound the child independently of Vitest's budget
    // and await it so cleanup cannot race an installer that is still running.
    const { stdout, stderr } = await execFileAsync("/bin/bash", [installer], {
      env: {
        ...process.env,
        HOME: tmp,
        CODEX_HOME: path.join(tmp, ".codex"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        TOOLPLANE_MCP_CONFIG: "",
        TOOLPLANE_SYNC_ROOT: "",
        TOOLPLANE_SKILLS_DIR: "",
        TOOLPLANE_SKILL_DIR_PREFIX: "",
      },
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("ToolPlane sync committed:");
    const curlCalls = readFileSync(path.join(tmp, "curl-calls.log"), "utf8")
      .trim()
      .split("\n");
    expect(curlCalls).toHaveLength(2);
    expect(curlCalls[0]).toContain(
      "/api/v1/plugin/baseline?workspace=ws&toolkit=tk",
    );
    expect(curlCalls[1]).toContain("/api/v1/plugin/sync-applied");

    const config = readFileSync(path.join(tmp, ".codex/config.toml"), "utf8");
    expect(config).toContain(
      "[mcp_servers.toolplane-775ff1e300598486cd833e1c]",
    );
    expect(config).toContain(
      'url = "https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp"',
    );
    expect(config).toContain(
      'http_headers = { Authorization = "Bearer sk_user_CODEX" }',
    );

    const hooks = readJson(".codex/hooks.json") as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
      ".codex/toolplane/toolplane-775ff1e300598486cd833e1c/shared/sync.sh",
    );

    const mcp = readJson(
      ".codex/toolplane/toolplane-775ff1e300598486cd833e1c/.mcp.json",
    ) as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    expect(
      mcp.mcpServers["toolplane-775ff1e300598486cd833e1c"].headers
        .Authorization,
    ).toBe("Bearer sk_user_CODEX");
    expect(
      statSync(
        path.join(
          tmp,
          ".codex/toolplane/toolplane-775ff1e300598486cd833e1c/shared/sync.sh",
        ),
      ).mode & 0o111,
    ).toBeTruthy();
    const skill = readFileSync(
      path.join(
        tmp,
        ".agents/skills/toolplane-775ff1e300598486cd833e1c-alpha/SKILL.md",
      ),
      "utf8",
    );
    expect(skill).not.toContain(
      "name: toolplane-775ff1e300598486cd833e1c-alpha",
    );
    expect(skill).toContain("# Alpha");
    expect(
      readFileSync(
        path.join(
          tmp,
          ".agents/skills/toolplane-775ff1e300598486cd833e1c-alpha/scripts/alpha.py",
        ),
        "utf8",
      ),
    ).toBe("print(1)");
  }, 20_000);
});

describe("generated opencode installer", () => {
  it("configures remote MCP, a toolkit command, and synced skill cache", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "toolplane-opencode-install-"));
    const bin = path.join(tmp, ".local/bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, path.join(bin, "node"));
    writeFakeCurl(bin);
    const configDir = path.join(tmp, "opencode-config");

    const installer = path.join(tmp, "install-opencode.sh");
    writeFileSync(
      installer,
      buildToolkitInstallScript({
        base: "https://mcp.example.com",
        workspaceSlug: "ws",
        toolkitSlug: "tk",
        token: "sk_user_OC",
        client: "opencode",
      }),
      { mode: 0o755 },
    );

    // Like Codex, OpenCode starts real Node children and commits synced files.
    // Isolate its runtime and bound the child before the enclosing test expires.
    const { stdout, stderr } = await execFileAsync("/bin/bash", [installer], {
      env: {
        ...process.env,
        HOME: tmp,
        OPENCODE_CONFIG_DIR: configDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        TOOLPLANE_MCP_CONFIG: "",
        TOOLPLANE_SYNC_ROOT: "",
        TOOLPLANE_SKILLS_DIR: "",
        TOOLPLANE_SKILL_DIR_PREFIX: "",
      },
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("ToolPlane sync committed:");
    const curlCalls = readFileSync(path.join(tmp, "curl-calls.log"), "utf8")
      .trim()
      .split("\n");
    expect(curlCalls).toHaveLength(2);
    expect(curlCalls[0]).toContain(
      "/api/v1/plugin/baseline?workspace=ws&toolkit=tk",
    );
    expect(curlCalls[1]).toContain("/api/v1/plugin/sync-applied");

    const cfg = JSON.parse(
      readFileSync(path.join(configDir, "opencode.json"), "utf8"),
    ) as {
      mcp: Record<string, unknown>;
      command: Record<string, { template: string }>;
    };
    expect(cfg.mcp["toolplane-775ff1e300598486cd833e1c"]).toEqual({
      type: "remote",
      url: "https://mcp.example.com/api/v1/workspaces/ws/toolkits/tk/mcp",
      enabled: true,
      oauth: false,
      headers: { Authorization: "Bearer sk_user_OC" },
    });
    expect(
      cfg.command["toolplane-775ff1e300598486cd833e1c"].template,
    ).toContain(
      path.join(
        configDir,
        "toolplane/toolplane-775ff1e300598486cd833e1c/skills",
      ),
    );
    expect(
      cfg.command["toolplane-775ff1e300598486cd833e1c"].template,
    ).toContain("$ARGUMENTS");
    expect(
      readFileSync(
        path.join(
          configDir,
          "toolplane/toolplane-775ff1e300598486cd833e1c/skills/alpha/SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("# Alpha");
    expect(
      readFileSync(
        path.join(
          configDir,
          "toolplane/toolplane-775ff1e300598486cd833e1c/skills/alpha/scripts/alpha.py",
        ),
        "utf8",
      ),
    ).toBe("print(1)");
  }, 20_000);
});
