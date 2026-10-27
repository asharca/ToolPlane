import "server-only";
import { Task, Role, TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import { getAgentForRun } from "@/lib/agents/queries";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import {
  resolveAgentTools,
  resolveAgentPiPackages,
} from "@/lib/agents/resolve";
import { resolveModelContext } from "@/lib/agents/model";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import type {
  RunSandboxAgentTurnOptions,
  SandboxAgentRuntimeKind,
} from "@/lib/agents/sandbox-runtime";
import {
  createAgentRuntimeToken,
  runtimeMcpProxyUrl,
  runtimeModelProxyBase,
  sandboxRuntimeOrigin,
} from "@/lib/agents/runtime-access";
import { db } from "@/lib/db";
import { isLocalGrant } from "./principal";
import type { TaskGrant } from "./principal";
import { localTarget } from "./local-policy";
import { assertWorkPiPackageSnapshot } from "@/lib/work/sessions";
import { localTaskSandbox } from "./local-sandbox";
import { resolvePiSessionPackages } from "@/lib/agents/pi-session-packages";

import { recordLocalPromptInvocation } from "./store";
/** Mint new task-scoped credentials on every claim, never restore old tokens. */
export async function localTaskOptions(
  row: A2ATask,
  signal: AbortSignal,
  instructions: string,
): Promise<RunSandboxAgentTurnOptions> {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant) || !row.leaseToken)
    throw new Error("Not a claimed local task.");
  if (row.executionBackend !== "pi-sdk")
    throw new Error("Retired local execution cannot mint runtime credentials.");
  signal.throwIfAborted();
  const mapped = await localTaskSandbox(row, false, signal);
  const target = await localTarget(
    db,
    grant.workspaceId,
    grant.agentId,
    grant.ancestorTaskIds.length === 0 ? grant.entryPolicy : "delegation",
    grant.agentRevisionId,
  );
  const context = await db.a2AContext.findFirst({
    where: {
      id: row.contextId,
      targetKind: "local",
      agentId: grant.agentId,
      workspaceId: grant.workspaceId,
      ownerKey: grant.ownerKey,
      targetBinding: target.binding,
    },
  });
  if (
    !context ||
    context.legacyRevisionUnresolved ||
    !context.agentRevisionId ||
    context.agentRevisionId !== grant.agentRevisionId
  )
    throw new Error("Historical local context is read-only.");
  const liveAgent = await getAgentForRun(grant.agentId, grant.workspaceId);
  if (!liveAgent) throw new Error("Local target unavailable.");
  const agent = await resolvePinnedAgent(liveAgent, context.agentRevisionId, {
    workspaceId: grant.workspaceId,
  });
  if (
    agent.runtimeKind !== "pi-sdk" ||
    !agent.provider ||
    !agent.model ||
    agent.publicRuntimeAllocation
  )
    throw new Error("Local target unavailable.");
  const piSession =
    agent.runtimeKind === "pi-sdk"
      ? await resolvePiSessionPackages({
          workspaceId: grant.workspaceId,
          agentId: agent.id,
          sandboxId: mapped.sandboxId,
          conversationId: mapped.conversationId,
          contextId: context.id,
          runtimeSessionId: context.id,
        })
      : undefined;
  const piPackages = piSession?.packages ?? resolveAgentPiPackages(agent);
  const resolved = resolveAgentTools(
    piSession ? { ...agent, piPackages: [] } : agent,
  );
  if (piSession) resolved.deploymentIds = piSession.deploymentIds;
  const work =
    grant.entryPolicy?.kind === "work" && !grant.ancestorTaskIds.length
      ? await db.workSession.findUniqueOrThrow({
          where: {
            id: grant.entryPolicy.sourceId,
            workspaceId: grant.workspaceId,
            agentId: grant.agentId,
            agentRevisionId: context.agentRevisionId,
            legacyRevisionUnresolved: false,
            conversation: {
              agentRevisionId: context.agentRevisionId,
              legacyRevisionUnresolved: false,
            },
          },
        })
      : null;
  if (work)
    assertWorkPiPackageSnapshot(
      agent.runtimeKind,
      work.runtimeSnapshot,
      piPackages,
    );
  const saved = work?.runtimeSnapshot as {
    deploymentIds?: string[];
    installedSkillIds?: string[];
  } | null;
  const savedDeploymentIds = saved?.deploymentIds;
  if (savedDeploymentIds)
    resolved.deploymentIds = resolved.deploymentIds.filter(
      (id) =>
        savedDeploymentIds.includes(id) ||
        Boolean(piSession?.packageDeploymentIds.includes(id)),
    );
  const savedSkillIds = saved?.installedSkillIds;
  if (savedSkillIds)
    resolved.skills = resolved.skills.filter((skill) =>
      savedSkillIds.includes(
        "id" in skill && typeof skill.id === "string" ? skill.id : "",
      ),
    );
  const deploymentIds = resolved.deploymentIds;
  const exp = Math.floor(
    Math.min(
      row.deadlineAt.getTime(),
      grant.expiresAt,
      Date.now() + 55 * 60_000,
    ) / 1000,
  );
  const token = await createAgentRuntimeToken({
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    agentRevisionId: context.agentRevisionId,
    sandboxId: mapped.sandboxId,
    conversationId: mapped.conversationId,
    a2aContextId: mapped.a2aContextId,
    providerId: agent.provider.id,
    deploymentIds,
    exp,
    a2aTaskId: row.id,
    a2aLeaseToken: row.leaseToken,
    a2aApprovalRequired: true,
  });
  const modelContext = resolveModelContext(agent.provider, agent.model);
  const chat =
    row.executionBackend === "pi-sdk" && grant.entryPolicy?.kind === "chat"
      ? await db.conversation.findFirst({
          where: {
            id: grant.entryPolicy.sourceId,
            agentId: agent.id,
            agent: { workspaceId: grant.workspaceId },
          },
          select: { reasoningEffort: true },
        })
      : null;
  const reasoning = normalizeReasoningEffort(chat?.reasoningEffort);
  const communicationEnabled = agent.a2aOutboundEnabled;
  const history = Task.fromJSON(row.snapshot).history;
  const historyRequired =
    row.resumeCount > 0 ||
    history.length > 1 ||
    (await db.a2ATask.count({
      where: {
        contextId: row.contextId,
        id: { not: row.id },
        executionBackend: "pi-sdk",
        state: TaskState.TASK_STATE_COMPLETED,
      },
    })) > 0;
  return {
    runtimeKind: agent.runtimeKind as SandboxAgentRuntimeKind,
    workspaceId: grant.workspaceId,
    agentId: agent.id,
    sandboxId: mapped.sandboxId,
    conversationId: mapped.conversationId,
    a2aContextId: mapped.a2aContextId,
    provider: agent.provider,
    modelId: agent.model,
    maxSteps: agent.maxSteps,
    contextWindow: modelContext.maxTokens,
    contextWindowEstimated: modelContext.estimated,
    modelProxyBase: runtimeModelProxyBase(agent.provider.id),
    runtimeAccessToken: token,
    nativeApprovalUrl: `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/a2a/${row.id}/approvals`,
    workingDirectory: work ? grant.entryPolicy?.workingDirectory : undefined,
    systemPrompt: `${agent.systemPrompt ?? ""}${communicationEnabled ? `\n\n${instructions}` : ""}`,
    disabledBuiltinTools: agent.disabledBuiltinTools,
    skills: resolved.skills,
    runtimeSessionId: context.id,
    ...(agent.runtimeKind === "pi-sdk" ? { piPackages } : {}),
    messages: history.map((message) => ({
      role: message.role === Role.ROLE_USER ? "user" : "assistant",
      parts: message.parts.flatMap((part) =>
        part.content?.$case === "text"
          ? [{ type: "text", text: part.content.value }]
          : [],
      ),
    })),
    mcpServers: [
      ...deploymentIds.map((deploymentId) => ({
        deploymentId,
        url: runtimeMcpProxyUrl(deploymentId),
      })),
      ...(communicationEnabled
        ? [
            {
              deploymentId: "toolplane-a2a",
              url: `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/a2a/${row.id}/mcp`,
            },
          ]
        : []),
    ],
    signal,
    historyRequired,
    onPromptInvocation: async (invocation) => {
      const messageId = history.findLast(
        (message) => message.role === Role.ROLE_USER,
      )?.messageId;
      if (!messageId || !row.leaseToken)
        throw new Error("Admitted prompt message unavailable.");
      await recordLocalPromptInvocation(
        row.id,
        row.leaseToken,
        messageId,
        invocation,
      );
    },
    ...(reasoning && reasoning !== "default"
      ? { reasoningEffort: reasoning }
      : {}),
  };
}
