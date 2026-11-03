import "server-only";
import { db } from "@/lib/db";
import { recordEvent } from "@/lib/observability/events";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { refreshAgentRevisionMcpGrants } from "@/lib/agents/revisions";
import { refreshAssistantRevisionMcpGrants } from "@/lib/chat/service";

/** Names a binding grants: the deployment's stored catalog. */
export function catalogToolNames(installCfg: unknown): string[] {
  return readMcpToolCatalog(installCfg).map((tool) => tool.name);
}

async function syncNow(deploymentId: string) {
  const deployment = await db.deployment.findUnique({
    where: { id: deploymentId },
    select: { workspaceId: true, installCfg: true },
  });
  if (!deployment) return;
  const names = catalogToolNames(deployment.installCfg);
  const followsCatalog = {
    deploymentId,
    NOT: { allowedToolNames: { equals: names } },
  };
  await db.agentServer.updateMany({
    where: followsCatalog,
    data: { allowedToolNames: names },
  });
  await db.chatAssistantMcpGrant.updateMany({
    where: followsCatalog,
    data: { allowedToolNames: names },
  });
  const [agents, assistants] = await Promise.all([
    db.agentServer.findMany({
      where: { deploymentId, agent: { workspaceId: deployment.workspaceId } },
      select: { agentId: true },
    }),
    db.chatAssistantMcpGrant.findMany({
      where: {
        deploymentId,
        assistant: { workspaceId: deployment.workspaceId },
      },
      select: { assistantId: true },
    }),
  ]);
  const refreshes: Array<[string, () => Promise<unknown>]> = [
    ...agents.map(
      ({ agentId }) =>
        [
          agentId,
          () => refreshAgentRevisionMcpGrants(deployment.workspaceId, agentId),
        ] as [string, () => Promise<unknown>],
    ),
    ...assistants.map(
      ({ assistantId }) =>
        [assistantId, () => refreshAssistantRevisionMcpGrants(assistantId)] as [
          string,
          () => Promise<unknown>,
        ],
    ),
  ];
  for (const [ownerId, refresh] of refreshes) {
    try {
      await refresh();
    } catch (error) {
      // One owner's unpublishable revision must not block the others.
      await recordEvent({
        workspaceId: deployment.workspaceId,
        deploymentId,
        domain: "mcp",
        eventName: "mcp.grant_sync",
        attributes: { ownerId },
        error,
      });
    }
  }
}

const running = new Map<string, Promise<void>>();
const queued = new Set<string>();

/**
 * Follow a deployment's catalog: refresh bindings and publish the next
 * Agent/Assistant revision whose applied MCP grants are out of date. Runs are
 * serialized per deployment; a request during a run schedules one more run.
 */
export function syncDeploymentMcpGrants(deploymentId: string): Promise<void> {
  const active = running.get(deploymentId);
  if (active) {
    queued.add(deploymentId);
    return active;
  }
  const run = (async () => {
    try {
      do {
        queued.delete(deploymentId);
        await syncNow(deploymentId);
      } while (queued.has(deploymentId));
    } finally {
      running.delete(deploymentId);
    }
  })();
  running.set(deploymentId, run);
  return run;
}
