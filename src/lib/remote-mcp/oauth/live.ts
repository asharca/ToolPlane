import "server-only";
import { db } from "@/lib/db";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { accessRevision } from "./store";
import {
  liveMcpRuntimeSnapshot,
  startProcess,
  killProcess,
  type LiveMcpRuntimeSnapshot,
} from "@/lib/process/supervisor";
import type { SpawnSpec } from "@/lib/process/spawn-spec";
import { resolveMcpConnectionSpawnSpec } from "@/lib/process/mcp-credentials";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";

/** A port alone isn't authority: the owner must still hold the same live grant. */
export async function checkedOAuthBridge(
  processId: string,
  deploymentId: string,
) {
  const row = await db.mcpOAuthCredential.findUnique({
    where: { deploymentId },
    select: {
      encryptedAccessToken: true,
      status: true,
      expiresAt: true,
      resource: true,
      issuer: true,
      deployment: {
        select: { source: true, sourceRef: true, installCfg: true },
      },
    },
  });
  if (!row) throw new Error("MCP_CREDENTIAL_REQUIRED");
  if (row.status !== "active") throw new Error("MCP_REAUTH_REQUIRED");
  const live = liveMcpRuntimeSnapshot(processId);
  const cfg = row.deployment.installCfg;
  if (
    (row.expiresAt && row.expiresAt.getTime() <= Date.now()) ||
    row.deployment.source !== "remote" ||
    !row.deployment.sourceRef ||
    new URL(row.deployment.sourceRef).href !== row.resource ||
    !cfg ||
    typeof cfg !== "object" ||
    Array.isArray(cfg) ||
    cfg.authType !== "oauth" ||
    cfg.issuer !== row.issuer ||
    !live?.oauthRevision ||
    live.oauthRevision !== accessRevision(row.encryptedAccessToken)
  ) {
    throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
  }
  if (
    row.resource.startsWith("http:") &&
    cfg.allowUnsafeHttp !== true &&
    !(await getTransportSettings()).allowHttp
  ) {
    throw new Error("MCP_CONNECTION_UNAVAILABLE");
  }
  return live;
}

/** Live-only access for callers that don't already hold the deployment operation lock. */
export async function withCurrentOAuthBridge<T>(
  workspaceId: string,
  deploymentId: string,
  operation: (
    spec: Extract<SpawnSpec, { kind: "remote" }>,
    snapshot: LiveMcpRuntimeSnapshot,
  ) => Promise<T>,
): Promise<T> {
  const result = await runMcpDeploymentOperation(
    workspaceId,
    deploymentId,
    async () => {
      if (!liveMcpRuntimeSnapshot(deploymentId))
        throw new Error("MCP_CONNECTION_UNAVAILABLE");
      try {
        const { spec } = await resolveMcpConnectionSpawnSpec({
          workspaceId,
          deploymentId,
        });
        if (spec.kind !== "remote" || !spec.oauth)
          throw new Error("MCP_DEFINITION_CHANGED");
        await startProcess(deploymentId, spec, { workspaceId });
        const snapshot = await checkedOAuthBridge(deploymentId, deploymentId);
        return operation(spec, snapshot);
      } catch (error) {
        if (
          error instanceof Error &&
          ["MCP_CREDENTIAL_REQUIRED", "MCP_REAUTH_REQUIRED"].includes(
            error.message,
          )
        ) {
          await killProcess(deploymentId, { finalStatus: "setup_required" });
        }
        throw error;
      }
    },
  );
  if (!result.accepted) throw new Error("MCP_CONNECTION_UNAVAILABLE");
  return result.value;
}
