import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import {
  resolveSpawnSpec,
  type DeploymentForSpawn,
  type SpawnSpec,
} from "@/lib/process/spawn-spec";
import { mcpEnvironmentState } from "@/lib/workspace/mcp-environment";

// Supervisor launches survive route-module instances and development reloads.
// Keep their comparison key process-private for that same lifetime, not per bundle.
const identityState = globalThis as typeof globalThis & {
  __mcpRemoteConnectionIdentityKey?: Buffer;
};
identityState.__mcpRemoteConnectionIdentityKey ??= randomBytes(32);
const identityKey = identityState.__mcpRemoteConnectionIdentityKey;

/** Classify the actual recipe, never a display label or a gateway URL. */
export function assertAssistantRemoteDeployment(
  deployment: DeploymentForSpawn,
): Extract<SpawnSpec, { kind: "remote" }> {
  const cfg = deployment.installCfg as Record<string, unknown> | null;
  const spec = resolveSpawnSpec(
    cfg?.credentialEnvelope
      ? { ...deployment, installCfg: { ...cfg, env: mcpEnvironmentState(cfg) } }
      : deployment,
  );
  if (spec.kind !== "remote") throw new Error("ASSISTANT_REMOTE_MCP_REQUIRED");
  const path = decodeURIComponent(new URL(spec.url).pathname);
  if (
    /\/mcp\/[^/]+\/rpc(?:\/|$)|\/api\/.*(?:agents|a2a)(?:\/|$)|\/a2a(?:\/|$)|\/api\/v\d+\/(?:pi-packages\/installations\/[^/]+|sandboxes\/[^/]+|agent-runtimes\/[^/]+|workspaces\/[^/]+\/toolkits\/[^/]+)\/mcp(?:\/|$)/i.test(
      path,
    )
  ) {
    throw new Error("ASSISTANT_REMOTE_MCP_REQUIRED");
  }
  return spec;
}

export function isRemoteMcpDeployment(deployment: DeploymentForSpawn): boolean {
  try {
    assertAssistantRemoteDeployment(deployment);
    return true;
  } catch {
    return false;
  }
}

/** Launch-private identity includes credential values, unlike persisted recipe checksums. */
export function remoteMcpConnectionIdentity(
  spec: Extract<SpawnSpec, { kind: "remote" }>,
): string {
  return createHmac("sha256", identityKey)
    .update(
      JSON.stringify({
        url: spec.url,
        transport: spec.transport,
        timeoutMs: spec.timeoutMs,
        allowUnsafeHttp: spec.allowUnsafeHttp,
        headers: Object.entries(spec.headers ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      }),
    )
    .digest("hex");
}
