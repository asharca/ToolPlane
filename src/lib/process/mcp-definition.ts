import { createHash } from "node:crypto";
import { resolveSpawnSpec, type DeploymentForSpawn } from "./spawn-spec";
import {
  prepareSessionMcpRuntimeImage,
  validateSessionMcpRuntimeImage,
} from "./mcp-runtime-image";
import type { Prisma } from "@prisma/client";
import { assertAssistantRemoteDeployment } from "@/lib/remote-mcp/classification";

export type McpRuntimeFileIdentity = {
  id: string;
  path: string;
  encryptedContent: unknown;
  size: number;
};

export function mcpRuntimeFilesIdentity(
  rows: readonly McpRuntimeFileIdentity[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          path: row.path,
          encryptedContent: row.encryptedContent,
          size: row.size,
        })),
      ),
    )
    .digest("hex");
}

/** A ciphertext identity pins secret config bytes without revealing or copying them. */
export async function mcpRuntimeFilesChecksum(
  tx: Prisma.TransactionClient,
  deploymentId: string,
): Promise<string> {
  const rows = await tx.deploymentConfigFile.findMany({
    where: { deploymentId },
    select: { id: true, path: true, encryptedContent: true, size: true },
    orderBy: [{ path: "asc" }, { id: "asc" }],
  });
  return mcpRuntimeFilesIdentity(rows);
}

/** Pins executable recipe configuration, never credential values or live catalogs. */
export function mcpDefinitionChecksum(deployment: DeploymentForSpawn): string {
  const cfg =
    deployment.installCfg &&
    typeof deployment.installCfg === "object" &&
    !Array.isArray(deployment.installCfg)
      ? (deployment.installCfg as Record<string, unknown>)
      : {};
  const env =
    cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
      ? (cfg.env as Record<string, unknown>)
      : {};
  const headerEnv =
    cfg.headerEnv &&
    typeof cfg.headerEnv === "object" &&
    !Array.isArray(cfg.headerEnv)
      ? Object.entries(cfg.headerEnv).sort(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: deployment.source,
        sourceRef: deployment.sourceRef,
        command: cfg.command ?? null,
        args: cfg.args ?? [],
        startCommand: cfg.startCommand ?? null,
        network: cfg.network ?? "isolated",
        transport: cfg.transport ?? "streamable-http",
        authType: cfg.authType ?? "none",
        bearerEnv: cfg.bearerEnv ?? null,
        headerEnv,
        timeoutMs: cfg.timeoutMs ?? 60_000,
        allowUnsafeHttp: cfg.allowUnsafeHttp === true,
        environmentKeys: Object.keys(env).sort(),
      }),
    )
    .digest("hex");
}

/** Launchers may select exact versions/commits, never floating registry tags. */
export function assertSessionMcpRecipePinned(
  deployment: DeploymentForSpawn,
): void {
  const exactNpm =
    /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const exactGit =
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?#[a-fA-F0-9]{40}$/;
  const exactPython =
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==\d[A-Za-z0-9.+!-]*$/;
  const fail: () => never = () => {
    throw new Error(
      "MCP_EXACT_PACKAGE_VERSION_REQUIRED: select an exact package version or Git commit before publishing.",
    );
  };
  if (deployment.source === "remote" || deployment.source === "docker") return;
  if (deployment.source === "npm") {
    if (!exactNpm.test(deployment.sourceRef ?? "")) fail();
    return;
  }
  if (deployment.source === "github") {
    if (!exactGit.test(deployment.sourceRef ?? "")) fail();
    return;
  }
  if (deployment.source === "pypi") {
    if (!exactPython.test(deployment.sourceRef ?? "")) fail();
    return;
  }
  if (deployment.source !== "config") fail();
  if (
    !deployment.installCfg ||
    typeof deployment.installCfg !== "object" ||
    Array.isArray(deployment.installCfg)
  )
    fail();
  const cfg = deployment.installCfg as { command?: string; args?: unknown };
  if (cfg.command === "docker") return;
  if (
    !Array.isArray(cfg.args) ||
    cfg.args.some((arg) => typeof arg !== "string")
  )
    fail();
  let args: string[] = cfg.args;
  if (cfg.command === "uv") {
    if (args[0] !== "tool" || args[1] !== "run") fail();
    args = args.slice(2);
  } else if (cfg.command !== "npx" && cfg.command !== "uvx") fail();
  const python = cfg.command !== "npx";
  let pinnedSelector = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      [
        "-y",
        "--yes",
        "--no",
        "--quiet",
        "--no-install",
        "--isolated",
        "--no-config",
        "--",
      ].includes(arg)
    )
      continue;
    const [flag, assigned] = arg.split(/=([\s\S]*)/, 2);
    if (
      (python && ["--from", "--with"].includes(flag)) ||
      (!python && ["-p", "--package"].includes(flag))
    ) {
      const value = assigned ?? args[++index];
      if (
        !value ||
        !(python
          ? exactPython.test(value)
          : exactNpm.test(value) || exactGit.test(value))
      )
        fail();
      pinnedSelector = true;
      continue;
    }
    if (arg.startsWith("-")) fail();
    if (
      !pinnedSelector &&
      !(python
        ? exactPython.test(arg)
        : exactNpm.test(arg) || exactGit.test(arg))
    )
      fail();
    return;
  }
  fail();
}

export type PreparedSessionMcpDefinition = {
  definitionChecksum: string;
  runtimeImageDigest: string | null;
};

/** Prepare immutable dependencies outside publication; never starts the MCP server or calls its tools. */
export async function prepareSessionMcpDefinition(
  deployment: DeploymentForSpawn,
  options: { prepare?: boolean } = {},
): Promise<PreparedSessionMcpDefinition> {
  if (deployment.source === "remote") {
    assertAssistantRemoteDeployment(deployment);
    return {
      definitionChecksum: mcpDefinitionChecksum(deployment),
      runtimeImageDigest: null,
    };
  }
  const spec = resolveSpawnSpec(deployment);
  if (spec.kind !== "bridge" || spec.command !== "docker" || !spec.image)
    throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
  assertSessionMcpRecipePinned(deployment);
  const definitionChecksum = mcpDefinitionChecksum(deployment);
  const runtimeImageDigest = await prepareSessionMcpRuntimeImage(
    deployment,
    spec,
    definitionChecksum,
    options,
  );
  return { definitionChecksum, runtimeImageDigest };
}

/** Publication validates the reviewed artifact without network, rebuild or mutable tag lookup. */
export async function prepareExistingSessionMcpDefinition(
  deployment: DeploymentForSpawn,
  pinnedDigest: string | null,
): Promise<PreparedSessionMcpDefinition> {
  const definitionChecksum = mcpDefinitionChecksum(deployment);
  if (deployment.source === "remote") {
    assertAssistantRemoteDeployment(deployment);
    if (pinnedDigest !== null) throw new Error("MCP_CAPTURE_IDENTITY_MISMATCH");
    return { definitionChecksum, runtimeImageDigest: null };
  }
  const spec = resolveSpawnSpec(deployment);
  assertSessionMcpRecipePinned(deployment);
  if (spec.kind !== "bridge" || spec.command !== "docker" || !pinnedDigest)
    throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
  return {
    definitionChecksum,
    runtimeImageDigest: await validateSessionMcpRuntimeImage(
      pinnedDigest,
      definitionChecksum,
    ),
  };
}
