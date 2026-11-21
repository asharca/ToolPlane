import { describe, expect, it, vi } from "vitest";
import {
  analyzePreset,
  analyzeText,
  applyCreateItem,
  IntakeError,
} from "@/lib/workspace/mcp-intake";
import { mapRegistryRecord } from "@/lib/workspace/mcp-registry";

// Pure mapping must neither initialize the DB-backed settings module nor fetch a record.
vi.mock("@/lib/a2a/remote-network", () => ({
  fetchPublicWebText: () => {
    throw new Error("Unexpected network access");
  },
}));

const item = { id: "0", name: "example", values: {} };

describe("MCP intake", () => {
  it("keeps a GitHub preset in setup until its token is supplied", () => {
    const preset = analyzePreset("github");
    expect(preset.draft.fields).toEqual([
      expect.objectContaining({
        key: "GITHUB_TOKEN",
        secret: true,
        required: true,
        helpUrl: expect.stringMatching(/^https:\/\/github\.com\//),
      }),
    ]);
    expect(applyCreateItem(preset, item, false)).toMatchObject({
      status: "setup_required",
      installCfg: { requiredEnv: ["GITHUB_TOKEN"], env: { GITHUB_TOKEN: "" } },
    });
    expect(
      applyCreateItem(
        preset,
        { ...item, values: { GITHUB_TOKEN: "Bearer supplied-value" } },
        false,
      ),
    ).toMatchObject({
      status: "provisioning",
      installCfg: {
        bearerEnv: "GITHUB_TOKEN",
        env: { GITHUB_TOKEN: "supplied-value" },
      },
    });
  });

  it("extracts README placeholders from a multi-server Claude configuration", () => {
    const mcpServers = {
      one: {
        url: "https://example.com/mcp",
        headers: { Authorization: `Bearer \${GITHUB_TOKEN}` },
      },
      two: {
        command: "uvx",
        args: ["example"],
        env: { API_KEY: "<YOUR_API_KEY>", LOG_LEVEL: "<level>" },
        autoApprove: [],
      },
      three: {
        command: "docker",
        args: ["run", "-i", "--rm", "example:1.0.0"],
      },
    };
    const entries = analyzeText(JSON.stringify({ mcpServers }));
    expect(entries.map((entry) => entry.draft.name)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(entries[0].draft.fields[0].key).toBe("GITHUB_TOKEN");
    expect(applyCreateItem(entries[0], item, false).status).toBe(
      "setup_required",
    );
    expect(entries[1].draft.fields).toMatchObject([
      { key: "API_KEY", secret: true },
      { key: "LOG_LEVEL", secret: false },
    ]);
    expect(
      applyCreateItem(entries[1], item, false).installCfg.env.API_KEY,
    ).toBe("");
  });

  it("retains the submitted bearer token when a second probe yields no challenge", () => {
    const [entry] = analyzeText("https://example.com/mcp");
    entry.draft.reachability = "unreachable";
    const createItem = {
      ...item,
      values: { MCP_BEARER_TOKEN: "Bearer supplied-token" },
    };
    expect(applyCreateItem(entry, createItem, false)).toMatchObject({
      status: "provisioning",
      installCfg: {
        authType: "bearer",
        bearerEnv: "MCP_BEARER_TOKEN",
        env: { MCP_BEARER_TOKEN: "supplied-token" },
      },
    });
    expect(JSON.stringify(entry.draft)).not.toContain("supplied-token");
  });

  it("preserves both credentials when another header uses the default probe key", () => {
    const [entry] = analyzeText(
      JSON.stringify({
        url: "https://example.com/mcp",
        headers: { "X-Token": `\${MCP_BEARER_TOKEN}` },
      }),
    );
    const values = {
      MCP_BEARER_TOKEN: "header-value",
      MCP_AUTHORIZATION_TOKEN: "pat-value",
    };
    const result = applyCreateItem(entry, { ...item, values }, false);
    expect(result.installCfg).toMatchObject({
      authType: "headers",
      headerEnv: {
        "X-Token": "MCP_BEARER_TOKEN",
        Authorization: "MCP_AUTHORIZATION_TOKEN",
      },
      env: {
        MCP_BEARER_TOKEN: "header-value",
        MCP_AUTHORIZATION_TOKEN: "Bearer pat-value",
      },
    });
  });

  it("never returns pasted environment or header values in drafts", () => {
    const supplied = "example-private-value";
    const sources = [
      `API_KEY='${supplied}' npx -y example`,
      `docker run -i --rm -e API_KEY=${supplied} example`,
      JSON.stringify({
        url: "https://example.com/sse",
        headers: { "X-Api-Key": supplied },
      }),
    ];
    for (const source of sources) {
      const [entry] = analyzeText(source);
      expect(JSON.stringify(entry.draft)).not.toContain(supplied);
      expect(entry.draft.fields).toEqual([]);
      expect(
        Object.values(applyCreateItem(entry, item, false).installCfg.env),
      ).toContain(supplied);
    }
  });

  it("keeps public literals usable and visible but extracts credentials by key or value", () => {
    const env = {
      LOG_LEVEL: "debug",
      DEMO_API_KEY: "small",
      INPUT: "sk-secret-value",
      OPAQUE: "pZ1nq7Dj3FrVmW6xAtJ9eYc2b5Hk",
      LABEL: "<required>",
    };
    const [entry] = analyzeText(JSON.stringify({ command: "server", env }));
    expect(JSON.parse(entry.document).env).toEqual({
      LOG_LEVEL: "debug",
      DEMO_API_KEY: `\${DEMO_API_KEY}`,
      INPUT: `\${INPUT}`,
      OPAQUE: `\${OPAQUE}`,
      LABEL: `\${LABEL}`,
    });
    expect(entry.literals).toEqual({
      DEMO_API_KEY: env.DEMO_API_KEY,
      INPUT: env.INPUT,
      OPAQUE: env.OPAQUE,
    });
    expect(entry.draft.fields.map((field) => field.key)).toEqual(["LABEL"]);
    expect(applyCreateItem(entry, item, false)).toMatchObject({
      status: "setup_required",
      installCfg: {
        env: { ...env, LABEL: "" },
        documentEnvKeys: ["LOG_LEVEL"],
      },
    });
  });

  it.each([
    [
      "pnpm dlx @modelcontextprotocol/server-everything@2.3.1 stdio",
      "server-everything",
    ],
    ["npx -y @scope/awesome@latest", "awesome"],
    ["bunx --yes @scope/awesome@1.2.0", "awesome"],
    ["uvx great-mcp==1.2.0", "great-mcp"],
    ["pipx run great-mcp==1.2.0", "great-mcp"],
    ["node tools/local-server.mjs", "local-server"],
    ["python3 scripts/service.py", "service"],
    ["python -m package.service", "package.service"],
    [
      "deno run --allow-read https://example.org/path/my-server.ts",
      "my-server",
    ],
    ["/opt/bin/custom-service --stdio", "custom-service"],
  ])("names %s after its package or script", (text, name) => {
    expect(analyzeText(text)[0].draft.name).toBe(name);
  });

  it("normalizes quoted commands, install links and VS Code remotes", () => {
    const config = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    };
    const [command] = analyzeText(
      "npx -y @modelcontextprotocol/server-filesystem /tmp",
    );
    const url = new URL("cursor://anysphere.cursor-deeplink/mcp/install");
    url.search = new URLSearchParams({
      name: "files",
      config: Buffer.from(JSON.stringify(config)).toString("base64"),
    }).toString();
    const [link] = analyzeText(url.href);
    expect(JSON.parse(command.draft.config)).toMatchObject(config);
    expect(JSON.parse(link.draft.config)).toMatchObject(config);
    expect(link.draft).toMatchObject({ name: "files", origin: "link" });
    const document = JSON.stringify({
      name: "docs",
      url: "https://example.com/docs",
    });
    const sources = [
      `code --add-mcp '${JSON.stringify({ name: "docs", serverUrl: "https://example.com/docs" })}'`,
      `vscode-insiders:mcp/install?${encodeURIComponent(document)}`,
      "claude mcp add --transport http docs https://example.com/docs",
    ];
    for (const source of sources) {
      expect(analyzeText(source)[0].draft).toMatchObject({
        name: "docs",
        kind: "remote",
      });
    }
    const [arbitrary] = analyzeText("/usr/bin/python3 server.py");
    expect(JSON.parse(arbitrary.draft.config)).toMatchObject({
      command: "/usr/bin/python3",
      args: ["server.py"],
    });
    const [custom] = analyzeText(
      JSON.stringify({ command: "my-server", cwd: "/workspace/test" }),
    );
    expect(applyCreateItem(custom, item, false).installCfg).toMatchObject({
      command: "my-server",
      args: [],
      cwd: "/workspace/test",
    });
  });

  it("does not inherit plain HTTP consent from imported JSON", () => {
    const [entry] = analyzeText(
      JSON.stringify({
        url: "http://mcp.notion.com/sse",
        allowUnsafeHttp: true,
      }),
    );
    expect(entry.draft).toMatchObject({ name: "notion", insecureHttp: true });
    expect(() => applyCreateItem(entry, item, false)).toThrow(
      "unsafeHttpConfirmationRequired",
    );
    expect(
      applyCreateItem(entry, { ...item, allowUnsafeHttp: true }, false)
        .installCfg,
    ).toMatchObject({ transport: "sse", allowUnsafeHttp: true });
  });

  it("rejects oversized batches and moves sensitive argument values out of the document", () => {
    const servers = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        index,
        { url: "https://example.com" },
      ]),
    );
    expect(() => analyzeText(JSON.stringify({ servers }))).toThrow(
      "tooManyServers",
    );
    const [entry] = analyzeText("npx -y example --api-key private-input");
    expect(entry.document).not.toContain("private-input");
    expect(JSON.stringify(entry.draft)).not.toContain("private-input");
    expect(
      Object.values(applyCreateItem(entry, item, false).installCfg.env),
    ).toContain("private-input");
  });

  it("prefers GitHub's registry remote and maps its bearer field", () => {
    const server = {
      name: "io.github.github/github-mcp-server",
      title: "GitHub",
      version: "2.2.0",
      remotes: [
        {
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: [{ name: "Authorization", isSecret: true }],
        },
      ],
      packages: [
        {
          registryType: "oci",
          identifier: "ghcr.io/github/github-mcp-server:2.2.0",
        },
      ],
    };
    const entry = mapRegistryRecord({ server });
    expect(entry.draft).toMatchObject({
      name: "GitHub",
      kind: "remote",
      presetId: "github",
      fields: [
        {
          key: "GITHUB_TOKEN",
          label: "Personal access token",
          required: true,
          secret: true,
        },
      ],
    });
    expect(applyCreateItem(entry, item, false).installCfg).toMatchObject({
      authType: "bearer",
    });
  });

  it("only accepts registry packages with exact versions and representable arguments", () => {
    const server = { name: "example.org/example", version: "1.0.1" };
    const pkg = {
      registryType: "npm",
      identifier: "example",
      version: "1.0.1",
      environmentVariables: [
        { name: "MODE", choices: ["a", "b"], default: "a" },
      ],
    };
    const mapped = mapRegistryRecord({
      server: { ...server, packages: [pkg] },
    });
    expect(applyCreateItem(mapped, item, false).installCfg).toMatchObject({
      args: ["-y", "example@1.0.1"],
      env: { MODE: "a" },
    });
    const unsupportedPackages = [
      { ...pkg, version: "latest" },
      {
        ...pkg,
        packageArguments: [{ type: "positional", value: "{user_input}" }],
      },
    ];
    for (const unsupported of unsupportedPackages) {
      const record = { server: { ...server, packages: [unsupported] } };
      expect(() => mapRegistryRecord(record)).toThrow(
        "unsupportedRegistryEntry",
      );
    }
  });

  it("imports hardened docker launches with bind-mounted config as runtime files", () => {
    const mcpServers = {
      ros: {
        command: "docker",
        args: [
          "run",
          "--rm",
          "-i",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,size=16m",
          "-e",
          "ROS_TOKEN",
          "--mount",
          "type=bind,src=/absolute/path/to/devices.json,dst=/config/devices.json,readonly",
          "ghcr.io/asharca/ros-mcp:latest",
          "--config",
          "/config/devices.json",
        ],
      },
    };
    const [entry] = analyzeText(JSON.stringify({ mcpServers }));
    expect(entry.draft.files).toEqual([
      { path: "devices.json", target: "/config/devices.json" },
    ]);
    expect(entry.draft.fields).toMatchObject([{ key: "ROS_TOKEN" }]);
    expect(JSON.stringify(entry.draft)).not.toContain("/absolute/path");
    expect(applyCreateItem(entry, item, false).installCfg).toMatchObject({
      args: [
        "run",
        "--rm",
        "-i",
        "ghcr.io/asharca/ros-mcp:latest",
        "--config",
        "/toolplane/config/devices.json",
      ],
    });

    const rejected = (args: string[]) => {
      try {
        analyzeText(JSON.stringify({ command: "docker", args }));
      } catch (error) {
        if (error instanceof IntakeError) return error.issue;
        throw error;
      }
    };
    expect(rejected(["run", "-i", "--privileged", "example"])).toEqual({
      code: "unsupportedDockerOption",
      value: "--privileged",
    });
    expect(
      rejected(["run", "-i", "-v", "/host/data:/data", "example"]),
    ).toEqual({ code: "unreferencedDockerMount", value: "/data" });
  });
});
