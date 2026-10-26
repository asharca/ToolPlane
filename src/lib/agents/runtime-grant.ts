import "server-only";
import { db } from "@/lib/db";
import type { AgentRuntimeTokenPayload } from "./runtime-access";
import type { PiPackageMcpToolPolicy } from "./pi-package-mcp";
import { requireAgentRevision } from "./revisions";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { assertAgentEnvironmentCredentialReferences } from "./environment-credentials";

/** A token identifies a pinned session; it never freezes live authorization. */
export async function resolveAgentRuntimeGrant(
  token: AgentRuntimeTokenPayload,
): Promise<{ mcpToolPolicy: PiPackageMcpToolPolicy } | null> {
  try {
    if (
      !token.agentRevisionId ||
      (!token.conversationId && !token.a2aContextId)
    )
      return null;
    if (token.a2aTaskId) await assertLocalRuntimeToken(token);
    return await db.$transaction(async (tx) => {
      const revision = await requireAgentRevision(
        tx,
        token.agentId,
        token.agentRevisionId,
      );
      const agent = await tx.agent.findFirst({
        where: {
          id: token.agentId,
          workspaceId: token.workspaceId,
          runtimeKind: "pi-sdk",
          retiredAt: null,
          workspace: { status: "active" },
          providerId: token.providerId,
        },
        select: {
          servers: { select: { deploymentId: true, allowedToolNames: true } },
        },
      });
      if (!agent || revision.config.providerId !== token.providerId)
        return null;
      if (token.conversationId) {
        const conversation = await tx.conversation.findFirst({
          where: {
            id: token.conversationId,
            agentId: token.agentId,
            agentRevisionId: token.agentRevisionId,
            legacyRevisionUnresolved: false,
            sandboxId: token.sandboxId,
          },
          select: { id: true },
        });
        if (!conversation) return null;
      }
      if (token.a2aContextId) {
        const context = await tx.a2AContext.findFirst({
          where: {
            id: token.a2aContextId,
            workspaceId: token.workspaceId,
            agentId: token.agentId,
            targetKind: "local",
            agentRevisionId: token.agentRevisionId,
            legacyRevisionUnresolved: false,
            sandboxId: token.sandboxId,
          },
          select: { id: true },
        });
        if (!context) return null;
      }
      await assertAgentEnvironmentCredentialReferences(
        tx,
        token.workspaceId,
        token.agentId,
        revision.config.environment.credentialReferences,
      );
      const currentDeployments = new Map<string, string[]>(
        agent.servers.map((server) => [
          server.deploymentId,
          server.allowedToolNames,
        ]),
      );
      const mcpToolPolicy: PiPackageMcpToolPolicy = {};
      for (const grant of revision.config.mcpGrants) {
        const liveTools = currentDeployments.get(grant.deploymentId);
        if (liveTools) {
          mcpToolPolicy[grant.deploymentId] = grant.allowedToolNames.filter(
            (name) => liveTools.includes(name),
          );
        }
      }
      if (token.deploymentIds.some((id) => !Object.hasOwn(mcpToolPolicy, id)))
        return null;
      return { mcpToolPolicy };
    });
  } catch {
    return null;
  }
}

export async function isAgentRuntimeGrantCurrent(
  token: AgentRuntimeTokenPayload,
): Promise<boolean> {
  return (await resolveAgentRuntimeGrant(token)) !== null;
}
