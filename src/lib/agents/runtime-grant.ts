import "server-only";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import type { AgentRuntimeTokenPayload } from "./runtime-access";
import type { PiPackageMcpToolPolicy } from "./pi-package-mcp";
import { requireAgentRevision } from "./revisions";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { assertAgentEnvironmentCredentialReferences } from "./environment-credentials";
import {
  resolveAgentModelOverride,
  conversationModelOverride,
} from "./turn-model";
import type { SandboxMcpTool } from "@/lib/sandboxes/mcp-policy";
import {
  externalSandboxTools,
  isExternalSandboxAccess,
  narrowExternalSandboxAccess,
} from "@/lib/sandboxes/external";
import { AgentRevisionConfigSchema } from "./revision-types";
import { enrichLogContext } from "@/lib/observability/context";

/** A token identifies a pinned session; it never freezes live authorization. */
export async function resolveAgentRuntimeGrant(
  token: AgentRuntimeTokenPayload,
  modelTarget?: { providerId: string; model: string },
): Promise<{
  mcpToolPolicy: PiPackageMcpToolPolicy;
  runtimeKind: "pi-sdk";
  model: string | null;
  /** Attached sandbox ID → tools allowed by both the pinned revision and the live attachment. */
  externalSandboxTools: Record<string, SandboxMcpTool[]>;
} | null> {
  try {
    if (
      !token.agentRevisionId ||
      (!token.conversationId && !token.a2aContextId)
    )
      return null;
    if (token.a2aTaskId) await assertLocalRuntimeToken(token);
    let verifiedConversationId: string | undefined;
    const grant = await db.$transaction(async (tx) => {
      const revision = await requireAgentRevision(
        tx,
        token.agentId,
        token.agentRevisionId,
      );
      if (revision.config.runtimeKind !== "pi-sdk") return null;
      const agent = await tx.agent.findFirst({
        where: {
          id: token.agentId,
          workspaceId: token.workspaceId,
          runtimeKind: revision.config.runtimeKind,
          retiredAt: null,
          workspace: { status: "active" },
        },
        select: {
          servers: { select: { deploymentId: true, allowedToolNames: true } },
          externalSandboxes: {
            where: { sandbox: { workspaceId: token.workspaceId } },
            select: { sandboxId: true, access: true },
          },
        },
      });
      if (!agent) return null;
      const provider = revision.config.providerId
        ? await tx.modelProvider.findFirst({
            where: {
              id: token.modelOverride?.providerId ?? revision.config.providerId,
              workspaceId: token.workspaceId,
            },
            select: { apiKey: true },
          })
        : null;
      if (!provider?.apiKey.trim()) return null;
      if (token.modelOverride) {
        if (token.modelOverride.providerId !== token.providerId) return null;
        await resolveAgentModelOverride(
          token.workspaceId,
          token.modelOverride,
          revision.config.runtimeKind,
          tx,
        );
      } else if (revision.config.providerId !== token.providerId) return null;
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
      let contextConversationId: string | undefined;
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
          select: {
            id: true,
            entryBindings: { select: { kind: true, sourceId: true } },
          },
        });
        if (!context) return null;
        const conversations = new Set<string>();
        for (const entry of context.entryBindings) {
          if (["chat", "control", "channel", "trigger"].includes(entry.kind))
            conversations.add(entry.sourceId);
          if (entry.kind === "work") {
            const work = await tx.workSession.findFirst({
              where: {
                id: entry.sourceId,
                workspaceId: token.workspaceId,
                agentId: token.agentId,
              },
              select: { conversationId: true },
            });
            if (work?.conversationId) conversations.add(work.conversationId);
          }
        }
        if (conversations.size > 1) return null;
        contextConversationId = [...conversations][0];
        if (
          token.conversationId &&
          contextConversationId !== token.conversationId
        )
          return null;
        if (
          contextConversationId &&
          !token.conversationId &&
          !(await tx.conversation.findFirst({
            where: {
              id: contextConversationId,
              agentId: token.agentId,
              agentRevisionId: token.agentRevisionId,
              legacyRevisionUnresolved: false,
              sandboxId: token.sandboxId,
            },
            select: { id: true },
          }))
        )
          return null;
      }
      const sandbox = await tx.sandbox.findFirst({
        where: {
          id: token.sandboxId,
          workspaceId: token.workspaceId,
          kind: "docker",
        },
        select: { config: true },
      });
      if (!sandbox) return null;
      const config =
        sandbox.config &&
        typeof sandbox.config === "object" &&
        !Array.isArray(sandbox.config)
          ? sandbox.config
          : {};
      if (config.readOnly === true) return null;
      const conversationId = token.conversationId ?? contextConversationId;
      if (
        conversationId &&
        Array.isArray(config.pendingWorkspaceDeletes) &&
        config.pendingWorkspaceDeletes.includes(conversationId)
      )
        return null;
      if (config.scope === "agent") {
        if (
          config.managedBy !== "agent-conversation" ||
          config.agentId !== token.agentId ||
          typeof config.agentRevisionId !== "string"
        )
          return null;
        const pinned = await tx.agentRevision.findFirst({
          where: { id: config.agentRevisionId, agentId: token.agentId },
          select: { config: true },
        });
        if (!pinned) return null;
        const environmentOwner = AgentRevisionConfigSchema.parse(pinned.config);
        if (
          environmentOwner.runtimeKind !== revision.config.runtimeKind ||
          !isDeepStrictEqual(
            environmentOwner.environment,
            revision.config.environment,
          )
        )
          return null;
      }
      await assertAgentEnvironmentCredentialReferences(
        tx,
        token.workspaceId,
        token.agentId,
        revision.config.environment.credentialReferences,
      );
      if (modelTarget && modelTarget.providerId !== token.providerId)
        return null;
      if (
        token.modelOverride &&
        modelTarget &&
        token.modelOverride.model !== modelTarget.model
      )
        return null;
      if (conversationId && token.modelOverride) {
        const session = await tx.conversation.findFirst({
          where: {
            id: conversationId,
            agentId: token.agentId,
            agent: { workspaceId: token.workspaceId },
          },
          select: { modelOverride: true, runtimeSessionKey: true },
        });
        if (session?.runtimeSessionKey?.startsWith("channel:")) {
          const current = conversationModelOverride(session.modelOverride);
          if (
            !current ||
            current.providerId !== token.modelOverride.providerId ||
            current.model !== token.modelOverride.model
          )
            return null;
        }
      }
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
      // A detached sandbox loses only its own tools, never the whole session grant.
      const externalTools: Record<string, SandboxMcpTool[]> = {};
      for (const pinned of revision.config.externalSandboxes) {
        const live = agent.externalSandboxes.find(
          (entry) => entry.sandboxId === pinned.sandboxId,
        );
        if (live && isExternalSandboxAccess(live.access))
          externalTools[pinned.sandboxId] = externalSandboxTools(
            narrowExternalSandboxAccess(pinned.access, live.access),
          );
      }
      verifiedConversationId = conversationId;
      return {
        mcpToolPolicy,
        externalSandboxTools: externalTools,
        runtimeKind: revision.config.runtimeKind,
        model:
          modelTarget?.model ??
          token.modelOverride?.model ??
          revision.config.model,
      };
    });
    if (grant)
      enrichLogContext({
        ...(token.a2aTaskId ? { taskId: token.a2aTaskId } : {}),
        ...(verifiedConversationId
          ? { conversationId: verifiedConversationId }
          : {}),
      });
    return grant;
  } catch {
    return null;
  }
}

export async function isAgentRuntimeGrantCurrent(
  token: AgentRuntimeTokenPayload,
): Promise<boolean> {
  return (await resolveAgentRuntimeGrant(token)) !== null;
}
