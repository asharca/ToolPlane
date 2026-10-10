import "server-only";
import { db } from "@/lib/db";
import type { AgentRuntimeTokenPayload } from "./runtime-access";
import { isDedicatedSandboxRuntimeKind } from "./runtime-kind";
import { readAgentPiPackageMcpPolicy } from "./pi-package-mcp-access";
import type { PiPackageMcpToolPolicy } from "./pi-package-mcp";

export async function resolveAgentRuntimeGrant(
  token: AgentRuntimeTokenPayload,
): Promise<{ mcpToolPolicy: PiPackageMcpToolPolicy } | null> {
  if (token.a2aTaskId) {
    const { assertLocalRuntimeToken } = await import("@/lib/a2a/local-runtime");
    try {
      await assertLocalRuntimeToken(token);
    } catch {
      return null;
    }
  }
  const agent = await db.agent.findFirst({
    where: {
      id: token.agentId,
      workspaceId: token.workspaceId,
      workspace: { status: "active" },
      OR: [
        { providerId: token.providerId },
        { modelProviders: { some: { providerId: token.providerId } } },
      ],
    },
    select: {
      runtimeKind: true,
      servers: { select: { deploymentId: true } },
      toolkits: {
        select: {
          toolkit: { select: { servers: { select: { deploymentId: true } } } },
        },
      },
      sandboxes: {
        select: {
          sandboxId: true,
          sandbox: { select: { workspaceId: true, kind: true, network: true } },
        },
      },
    },
  });
  const link = agent?.sandboxes[0];
  const currentDeployments = new Set([
    ...(agent?.servers.map((server) => server.deploymentId) ?? []),
    ...(agent?.toolkits.flatMap((entry) =>
      entry.toolkit.servers.map((server) => server.deploymentId),
    ) ?? []),
  ]);
  let mcpToolPolicy: PiPackageMcpToolPolicy = {};
  if (agent?.runtimeKind === "pi-sdk") {
    try {
      mcpToolPolicy = await readAgentPiPackageMcpPolicy(
        db,
        token.workspaceId,
        token.agentId,
      );
    } catch {
      return null;
    }
    for (const id of Object.keys(mcpToolPolicy)) {
      if (currentDeployments.has(id)) delete mcpToolPolicy[id];
      else currentDeployments.add(id);
    }
  }
  return agent &&
    isDedicatedSandboxRuntimeKind(agent.runtimeKind) &&
    agent.sandboxes.length === 1 &&
    link?.sandboxId === token.sandboxId &&
    link.sandbox.workspaceId === token.workspaceId &&
    link.sandbox.kind === "docker" &&
    link.sandbox.network !== "none" &&
    token.deploymentIds.every((deploymentId) =>
      currentDeployments.has(deploymentId),
    )
    ? { mcpToolPolicy }
    : null;
}

export async function isAgentRuntimeGrantCurrent(
  token: AgentRuntimeTokenPayload,
): Promise<boolean> {
  return (await resolveAgentRuntimeGrant(token)) !== null;
}
