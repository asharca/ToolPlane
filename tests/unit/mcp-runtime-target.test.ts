// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  buildStdioConfigSpawnSpec,
  resolveSpawnSpec,
} from "@/lib/process/spawn-spec";
import { MCP_RUNTIME_IMAGE, sandboxFlags } from "@/lib/process/sandbox";
import {
  deploymentWorkspaceMount,
  deploymentWorkspaceVolumeName,
} from "@/lib/process/deployment-workspace-volume";
import { validateMcpRuntimeTarget } from "@/lib/process/mcp-runtime-target";

vi.mock("@/lib/sandboxes/runtime", () => ({ createDockerVolume: vi.fn() }));
const runtime = vi.hoisted(() => ({
  findFirst: vi.fn(),
  liveRegistry: vi.fn(),
  connectorStatus: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { sandbox: { findFirst: runtime.findFirst } },
}));
vi.mock("@/lib/process/supervisor/registry", () => ({
  liveRegistry: runtime.liveRegistry,
}));
vi.mock("@/lib/sandboxes/connector-broker", () => ({
  connectorStatus: runtime.connectorStatus,
}));

it("isolates arbitrary commands with bounded resources, a deployment-private writable mount and no env in argv", async () => {
  const spec = buildStdioConfigSpawnSpec(
    "pnpm",
    ["dlx", "server"],
    { KEY: "private-marker" },
    false,
    "none",
    "src/server",
  );
  expect(spec.command).toBe("docker");
  expect(spec.args).toEqual([
    "run",
    ...sandboxFlags("none"),
    "--workdir",
    "/workspace/src/server",
    MCP_RUNTIME_IMAGE,
    "pnpm",
    "dlx",
    "server",
  ]);
  expect(spec.env.KEY).toBe("private-marker");
  const mount = await deploymentWorkspaceMount("id-a");
  expect(mount).toEqual([
    "--mount",
    `type=volume,src=${deploymentWorkspaceVolumeName("id-a")},dst=/workspace`,
  ]);
  expect(await deploymentWorkspaceMount("id-b")).not.toEqual(mount);
});

it.each([
  "../../etc",
  "/etc",
  "/workspace-other",
  "/toolplane/config-writable",
  "../toolplane/config",
  "bad\0path",
])("rejects escaping workdir %s", (cwd) => {
  expect(() =>
    buildStdioConfigSpawnSpec("node", [], {}, false, "none", cwd),
  ).toThrow("MCP_CWD_INVALID");
});

it("accepts an explicit config subdirectory without overriding packaged defaults", () => {
  expect(
    buildStdioConfigSpawnSpec(
      "npx",
      [],
      {},
      false,
      "none",
      "/toolplane/config/subdir",
    ).args,
  ).toContain("/toolplane/config/subdir");
  expect(buildStdioConfigSpawnSpec("npx", []).args).not.toContain("--workdir");
});

it.each([
  { source: "docker" },
  { source: "config", command: "docker" },
  { source: "remote" },
  { sandboxId: null },
  { sandboxId: "not-found" },
])("rejects unavailable workspace targets %o", async (input) => {
  await expect(
    validateMcpRuntimeTarget({
      workspaceId: "w",
      target: "workspace_sandbox",
      sandboxId: "s",
      ...input,
    }),
  ).resolves.toEqual({ ok: false, error: "sandboxUnavailable" });
});

it("requires a live supervisor and a raw stdio capability, not just process_exec", async () => {
  const target = {
    workspaceId: "w",
    target: "workspace_sandbox" as const,
    sandboxId: "connector",
    command: "node",
  };
  const row = {
    id: "connector",
    deploymentId: "worker",
    kind: "connector",
    config: {},
  };
  runtime.findFirst.mockResolvedValue(row);
  runtime.liveRegistry.mockReturnValue(null);
  expect(await validateMcpRuntimeTarget(target)).toEqual({
    ok: false,
    error: "sandboxUnavailable",
  });
  runtime.liveRegistry.mockReturnValue({ status: "running" });
  runtime.connectorStatus.mockReturnValue({
    capabilities: ["process_exec", "write_file_base64"],
  });
  expect(await validateMcpRuntimeTarget(target)).toEqual({
    ok: false,
    error: "sandboxUnavailable",
  });
  runtime.connectorStatus.mockReturnValue({
    capabilities: ["process_exec", "mcp_stdio"],
  });
  expect(await validateMcpRuntimeTarget(target)).toEqual({ ok: true });
});

it("never falls back to a managed launch when a referenced sandbox is deleted", () => {
  expect(() =>
    resolveSpawnSpec({
      name: "mcp",
      serverId: null,
      source: "config",
      sourceRef: null,
      runtimeTarget: "workspace_sandbox",
      runtimeSandboxId: null,
      installCfg: { command: "node" },
    }),
  ).toThrow("sandboxUnavailable");
});
