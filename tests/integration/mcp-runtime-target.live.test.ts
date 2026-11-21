// @vitest-environment node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildStdioConfigSpawnSpec } from "@/lib/process/spawn-spec";
import {
  deploymentWorkspaceMount,
  removeDeploymentWorkspaceVolume,
} from "@/lib/process/deployment-workspace-volume";
import { MCP_RUNTIME_IMAGE } from "@/lib/process/sandbox";
import { dockerCliEnv } from "@/lib/process/supervisor/docker-env";

vi.hoisted(() =>
  vi.stubEnv("MCP_RUNTIME_IMAGE", `toolplane-test-stdio:${process.pid}`),
);
const docker = (...args: string[]) =>
  promisify(execFile)("docker", args, {
    timeout: 240_000,
    maxBuffer: 10_000_000,
  });
const id = `test-${randomUUID()}`;
const sandbox = `toolplane-sandbox-${id}`;
const managed = `toolplane-mcp-${id}`;
const marker = `fixture-'" $\\ ${randomUUID()}\n`;
const children = new Set<ChildProcess>();
let mount: string[];

async function launch(target: "managed" | "docker") {
  const commandArgs = ["server.mjs", `\${ACCESS_KEY}`];
  const spec = buildStdioConfigSpawnSpec(
    "node",
    commandArgs,
    { ACCESS_KEY: marker },
    false,
    "none",
    "server",
  );
  const child = spawn(process.execPath, ["scripts/mcp-stdio-bridge.mjs"], {
    env: {
      ...dockerCliEnv(),
      MCP_NAME: "live-test",
      MCP_PORT: "0",
      MCP_STARTUP_MAX_TIMEOUT_MS: "12000",
      MCP_CHILD_ENV: JSON.stringify(spec.env),
      ...(target === "managed"
        ? {
            MCP_COMMAND: "docker",
            MCP_IMAGE: spec.image,
            MCP_CONTAINER_NAME: managed,
            MCP_ARGS: JSON.stringify([
              "run",
              "--name",
              managed,
              ...mount,
              ...spec.args.slice(1),
            ]),
          }
        : {
            MCP_COMMAND: "node",
            MCP_ARGS: JSON.stringify(commandArgs),
            MCP_WORKSPACE_TRANSPORT: JSON.stringify({
              kind: "docker",
              container: sandbox,
              cwd: "/workspace/server",
            }),
          }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const exited = once(child, "exit").then(() => undefined);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (c) => {
    stderr += c;
  });
  try {
    const listening = Promise.withResolvers<number>();
    child.stdout.setEncoding("utf8").on("data", (line) => {
      const m = /LISTENING (\d+)/.exec(line);
      if (m) listening.resolve(Number(m[1]));
    });
    const port = await Promise.race([
      listening.promise,
      exited.then(() => {
        throw Error(
          `Bridge exited: ${stderr.replaceAll(marker, "[redacted]")}`,
        );
      }),
    ]);
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect((await response.json()).result.tools[0].name).toBe("ping_tool");
    const session = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { "x-toolplane-mcp-owner": "live" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "live", version: "1" },
        },
      }),
    });
    expect(await session.text()).toContain('"serverInfo"');
    expect(session.headers.get("mcp-session-id")).toBeTruthy();
    const inspection = (
      await docker("inspect", target === "managed" ? managed : sandbox)
    ).stdout;
    expect(inspection).not.toContain(marker.trim());
    expect(stderr).not.toContain(marker.trim());
  } finally {
    child.kill("SIGTERM");
    await exited;
    children.delete(child);
  }
}

describe.skipIf(process.env.SANDBOX_DOCKER_SMOKE !== "1")(
  "managed and workspace stdio on real Docker",
  () => {
    beforeAll(async () => {
      await docker(
        "build",
        "--target",
        "mcp-runtime",
        "-t",
        MCP_RUNTIME_IMAGE,
        ".",
      );
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        MCP_RUNTIME_IMAGE,
        "sh",
        "-ec",
        'for cmd in node npm npx pnpm bun bunx python python3 pip uv uvx deno java git gcc make; do command -v "$cmd"; done',
      );
      mount = await deploymentWorkspaceMount(id);
      // Fail initialization unless cwd, private argv, env and writable volume are correct.
      const fixture = `import fs from 'node:fs'; if (process.argv[2] !== process.env.ACCESS_KEY || process.cwd() !== '/workspace/server') process.exit(29); fs.appendFileSync('launches', 'started\\n'); setInterval(()=>{}, 60000);\n${await readFile("tests/fixtures/fake-stdio-mcp.mjs", "utf8")}`;
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        ...mount,
        MCP_RUNTIME_IMAGE,
        "node",
        "-e",
        "require('fs').mkdirSync('server');require('fs').writeFileSync('server/server.mjs',process.argv[1]);",
        fixture,
      );
      await docker(
        "run",
        "-d",
        "--network",
        "none",
        "--name",
        sandbox,
        ...mount,
        MCP_RUNTIME_IMAGE,
        "sleep",
        "infinity",
      );
    }, 300_000);
    afterAll(async () => {
      for (const child of children) child.kill("SIGKILL");
      await docker("rm", "-f", sandbox, managed);
      await removeDeploymentWorkspaceVolume(id);
      await docker("image", "rm", MCP_RUNTIME_IMAGE);
    }, 30_000);
    it(
      "runs a non-packaged server and lists its tools",
      () => launch("managed"),
      30_000,
    );
    it("restarts a workspace exec without orphaning its server or removing the sandbox", async () => {
      for (let i = 0; i < 2; i++) {
        await launch("docker");
        expect(
          (await docker("top", sandbox, "-eo", "pid,comm")).stdout,
        ).not.toMatch(/\snode\s*$/m);
      }
    }, 60_000);
  },
);
