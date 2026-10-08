import 'server-only';
import { Task, Role } from '@a2a-js/sdk';
import type { A2ATask } from '@prisma/client';
import { getAgentForRun } from '@/lib/agents/queries';
import { resolveAgentTools, resolveAgentPiPackages } from '@/lib/agents/resolve';
import { resolveModelContext } from '@/lib/agents/model';
import { normalizeReasoningEffort } from '@/lib/agents/constants';
import type { RunSandboxAgentTurnOptions, SandboxAgentRuntimeKind } from '@/lib/agents/sandbox-runtime';
import { createAgentRuntimeToken, runtimeMcpProxyUrl, runtimeModelProxyBase, sandboxRuntimeOrigin } from '@/lib/agents/runtime-access';
import { liveStatus } from '@/lib/process/supervisor';
import { db } from '@/lib/db';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { assertLiveGrant, isLocalGrant } from './principal';
import type { TaskGrant } from './principal';
import { localTarget } from './local-policy';
import { assertWorkPiPackageSnapshot } from '@/lib/work/sessions';

/** Mint new task-scoped credentials on every claim, never restore old tokens. */
export async function localTaskOptions(row: A2ATask, signal: AbortSignal, instructions: string, cleanup = false): Promise<RunSandboxAgentTurnOptions> {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant) || !row.leaseToken) throw new Error('Not a claimed local task.');
  if (cleanup && (row.executionBackend !== 'pi-harness' || !row.nativeOperationId)) throw new Error('Native cleanup requires a bound Pi operation.');
  if (cleanup) assertRuntimeOwner();
  else { await assertLiveGrant(grant, 'send'); signal.throwIfAborted(); }
  const assigned = cleanup ? await db.agentSandbox.findMany({ where: { agentId: grant.agentId,
    agent: { workspaceId: grant.workspaceId }, sandbox: { workspaceId: grant.workspaceId, kind: 'docker' } } }) : [];
  if (cleanup && assigned.length !== 1) throw new Error('Native cleanup sandbox assignment changed.');
  const target = cleanup ? { sandboxId: assigned[0].sandboxId, binding: grant.targetBinding }
    : await localTarget(db, grant.workspaceId, grant.agentId, grant.ancestorTaskIds.length === 0 ? grant.entryPolicy : 'delegation');
  const context = await db.a2AContext.findFirst({ where: { id: row.contextId, targetKind: 'local',
    agentId: grant.agentId, workspaceId: grant.workspaceId, ownerKey: grant.ownerKey, targetBinding: target.binding } });
  if (!context) throw new Error('Local task context changed.');
  const agent = await getAgentForRun(grant.agentId, grant.workspaceId);
  if (!agent?.provider || !agent.model || agent.publicRuntimeAllocation) throw new Error('Local target unavailable.');
  const resolved = resolveAgentTools(agent);
  const piPackages = resolveAgentPiPackages(agent);
  const work = grant.entryPolicy?.kind === 'work' && !grant.ancestorTaskIds.length
    ? await db.workSession.findUniqueOrThrow({ where: { id: grant.entryPolicy.sourceId } }) : null;
  if (work) assertWorkPiPackageSnapshot(agent.runtimeKind, work.runtimeSnapshot, piPackages);
  const saved = work?.runtimeSnapshot as { deploymentIds?: string[]; installedSkillIds?: string[]; systemPrompt?: string } | null;
  if (saved?.deploymentIds) resolved.deploymentIds = resolved.deploymentIds.filter((id) => saved.deploymentIds!.includes(id));
  if (saved?.installedSkillIds) resolved.skills = resolved.skills.filter((skill) => saved.installedSkillIds!.includes((skill as { id?: string }).id ?? ''));
  const deploymentIds = cleanup ? [] : resolved.deploymentIds.filter((id) => liveStatus(id) === 'running');
  const exp = Math.floor((cleanup ? Date.now() + 60_000 : Math.min(row.deadlineAt.getTime(), grant.expiresAt, Date.now() + 55 * 60_000)) / 1000);
  const token = await createAgentRuntimeToken({ workspaceId: grant.workspaceId, agentId: grant.agentId,
    sandboxId: target.sandboxId, providerId: agent.provider.id, deploymentIds, exp,
    a2aTaskId: row.id, a2aLeaseToken: row.leaseToken, a2aApprovalRequired: true });
  const modelContext = resolveModelContext(agent.provider, agent.model);
  const chat = row.executionBackend === 'pi-harness' && grant.entryPolicy?.kind === 'chat'
    ? await db.conversation.findFirst({ where: { id: grant.entryPolicy.sourceId, agentId: agent.id,
      agent: { workspaceId: grant.workspaceId } }, select: { reasoningEffort: true } }) : null;
  const reasoning = normalizeReasoningEffort(chat?.reasoningEffort);
  const communicationEnabled = !cleanup && (agent.a2aInternalEnabled || agent.subAgents.length > 0);
  return { runtimeKind: agent.runtimeKind as SandboxAgentRuntimeKind,
    workspaceId: grant.workspaceId, agentId: agent.id, sandboxId: target.sandboxId, provider: agent.provider,
    modelId: agent.model, maxSteps: agent.maxSteps, contextWindow: modelContext.maxTokens, contextWindowEstimated: modelContext.estimated,
    modelProxyBase: runtimeModelProxyBase(agent.provider.id), runtimeAccessToken: token,
    nativeApprovalUrl: `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/a2a/${row.id}/approvals`,
    workingDirectory: work ? grant.entryPolicy?.workingDirectory : undefined,
    systemPrompt: `${saved?.systemPrompt ?? agent.systemPrompt ?? ''}${communicationEnabled ? `\n\n${instructions}` : ''}`,
    disabledBuiltinTools: agent.disabledBuiltinTools, skills: resolved.skills, runtimeSessionId: context.id,
    ...(agent.runtimeKind === 'pi-sdk' ? { piPackages } : {}),
    messages: Task.fromJSON(row.snapshot).history.map((message) => ({ role: message.role === Role.ROLE_USER ? 'user' : 'assistant',
      parts: message.parts.flatMap((part) => part.content?.$case === 'text' ? [{ type: 'text', text: part.content.value }] : []) })),
    mcpServers: [...deploymentIds.map((deploymentId) => ({ deploymentId, url: runtimeMcpProxyUrl(deploymentId) })),
      ...(communicationEnabled ? [{ deploymentId: 'toolplane-a2a', url: `${sandboxRuntimeOrigin()}/api/v1/agent-runtime/a2a/${row.id}/mcp` }] : [])], signal,
    ...(row.executionBackend === 'pi-harness' ? { piHarness: { communicationEnabled,
      ...(reasoning && reasoning !== 'default' ? { thinkingLevel: reasoning } : {}),
      historyRequired: await db.a2ATask.count({ where: { contextId: row.contextId, id: { not: row.id }, executionBackend: 'legacy' } }) > 0,
      sessionRequired: await db.a2ATask.count({ where: { contextId: row.contextId, executionBackend: 'pi-harness', nativeOperationId: { not: null } } }) > 0 } } : {}),
  };
}
