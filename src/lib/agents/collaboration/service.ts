import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AgentCollaborationTask } from '@prisma/client';
import { db } from '@/lib/db';
import { isDedicatedSandboxRuntimeKind } from '../runtime-kind';
import { writeAudit } from '@/lib/observability/audit';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { COLLABORATION_LIMITS as LIMITS, CollaborationError, type CollaborationArtifact } from './protocol';

type Tx = Prisma.TransactionClient;
export type CollaborationPrincipal =
  | { kind: 'runtime'; workspaceId: string; agentId: string; runId: string }
  | { kind: 'user'; workspaceId: string; agentId: string; userId: string };
const activeStates = ['submitted', 'working', 'input-required', 'auth-required'];
const missing = () => new CollaborationError('not_found', 'Task or Agent is not available.', 404);
const conflict = (message: string) => new CollaborationError('conflict', message, 409);
export function contentHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function activeWorkspace(tx: Tx, id: string) {
  if (!await tx.workspace.count({ where: { id, status: 'active' } })) throw missing();
}
export async function targetSnapshot(tx: Tx, workspaceId: string, agentId: string) {
  const row = await tx.agent.findFirst({
    where: { id: agentId, workspaceId, workspace: { status: 'active' }, publicRuntimeAllocation: null },
    select: { id: true, name: true, description: true, runtimeKind: true, providerId: true, model: true,
      systemPrompt: true, maxSteps: true, disabledBuiltinTools: true,
      provider: { select: { format: true, baseUrl: true } },
      sandboxes: { select: { sandboxId: true, sandbox: { select: { kind: true, workspaceId: true, network: true, image: true, config: true } } } },
      servers: { orderBy: { deploymentId: 'asc' }, select: { deploymentId: true } },
      skills: { orderBy: { installedSkillId: 'asc' }, select: { installedSkillId: true } },
      toolkits: { orderBy: { toolkitId: 'asc' }, select: { toolkitId: true, toolkit: { select: {
        servers: { orderBy: { deploymentId: 'asc' }, select: { deploymentId: true } },
        skills: { orderBy: { installedSkillId: 'asc' }, select: { installedSkillId: true } },
      } } } },
      subAgents: { orderBy: { childId: 'asc' }, select: { childId: true } },
    },
  });
  if (!row || !isDedicatedSandboxRuntimeKind(row.runtimeKind) || !row.providerId || !row.model
    || row.sandboxes.length !== 1 || row.sandboxes[0].sandbox.workspaceId !== workspaceId
    || row.sandboxes[0].sandbox.kind !== 'docker' || row.sandboxes[0].sandbox.network === 'none') {
    throw new CollaborationError('not_configured', 'Target requires a configured Pi, Claude Code, DSH or Hermes RPC Agent with an exclusive Docker sandbox.', 409);
  }
  const skillIds = [...new Set([...row.skills, ...row.toolkits.flatMap((link) => link.toolkit.skills)].map((link) => link.installedSkillId))];
  const deploymentIds = [...new Set([...row.servers, ...row.toolkits.flatMap((link) => link.toolkit.servers)].map((link) => link.deploymentId))];
  // Hash large bundle/config bodies in Postgres instead of copying credentials
  // or megabytes of files into the task or an application polling response.
  const skillRevisions = skillIds.length ? await tx.$queryRaw<Array<{ id: string; revision: string }>>`
    SELECT s.id, encode(sha256(convert_to(jsonb_build_array(to_jsonb(s), to_jsonb(k))::text, 'UTF8')), 'hex') AS revision
    FROM "InstalledSkill" s LEFT JOIN "Skill" k ON k.id=s."skillId"
    WHERE s."workspaceId"=${workspaceId} AND s.id IN (${Prisma.join(skillIds)}) ORDER BY s.id` : [];
  const deploymentRevisions = deploymentIds.length ? await tx.$queryRaw<Array<{ id: string; revision: string }>>`
    SELECT d.id, encode(sha256(convert_to(jsonb_build_array(d.source, d."sourceRef", d."installCfg", d."mcpToolExposure", d."mcpAllowedTools",
      (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM "DeploymentConfigFile" f WHERE f."deploymentId"=d.id))::text, 'UTF8')), 'hex') AS revision
    FROM "Deployment" d WHERE d."workspaceId"=${workspaceId} AND d.id IN (${Prisma.join(deploymentIds)}) ORDER BY d.id` : [];
  if (skillRevisions.length !== skillIds.length || deploymentRevisions.length !== deploymentIds.length) throw missing();
  return { binding: contentHash({ row, skillRevisions, deploymentRevisions }) };
}
async function liveEdge(tx: Tx, workspaceId: string, callerId: string, targetId: string) {
  if (!await tx.agentSubAgent.count({ where: { parentId: callerId, childId: targetId,
    parent: { workspaceId, publicRuntimeAllocation: null }, child: { workspaceId, publicRuntimeAllocation: null } } })) throw missing();
}

export async function authorizeRun(tx: Tx, principal: Extract<CollaborationPrincipal, { kind: 'runtime' }>) {
  const run = await tx.agentCollaborationRun.findFirst({ where: {
    id: principal.runId, agentId: principal.agentId, workspaceId: principal.workspaceId,
    closedAt: null, deadlineAt: { gt: new Date() }, workspace: { status: 'active' },
    agent: { publicRuntimeAllocation: null },
  } });
  if (!run) throw new CollaborationError('expired_grant', 'Collaboration execution grant is no longer active.', 403);
  if (!await tx.agentCollaborationRun.count({ where: { id: run.rootId, workspaceId: run.workspaceId, deadlineAt: { gt: new Date() } } })) throw new CollaborationError('expired_grant', 'Root execution authority was removed.', 403);
  if (run.parentTaskId && !await tx.agentCollaborationTask.count({ where: {
    id: run.parentTaskId, workspaceId: run.workspaceId, targetAgentId: run.agentId,
    state: 'working', cancelRequestedAt: null, deadlineAt: { gt: new Date() },
  } })) throw new CollaborationError('expired_grant', 'The parent task is no longer executing.', 403);
  if (run.workSessionId && !await tx.workSession.count({ where: {
    id: run.workSessionId, workspaceId: run.workspaceId,
    status: { notIn: ['failed', 'cancelling', 'archived'] }, cancelRequestedAt: null,
  } })) throw new CollaborationError('expired_grant', 'The originating Work session was canceled or failed.', 403);
  return run;
}

export async function assertCollaborationContext(conversationId: string, taskId?: string) {
  const reserved = await db.agentCollaborationTask.findUnique({ where: { contextId: conversationId }, select: { id: true } });
  if (reserved && reserved.id !== taskId) throw conflict('Delegation contexts can only be continued through the collaboration service.');
}

export async function openCollaborationRun(input: {
  workspaceId: string; agentId: string; sandboxId: string; providerId: string;
  conversationId?: string; targetIds: readonly string[]; taskId?: string; workSessionId?: string;
}) {
  assertRuntimeOwner();
  return db.$transaction(async (tx) => {
    await activeWorkspace(tx, input.workspaceId);
    if (!await tx.agentSandbox.count({ where: { agentId: input.agentId, sandboxId: input.sandboxId,
      agent: { workspaceId: input.workspaceId, providerId: input.providerId, publicRuntimeAllocation: null },
      sandbox: { workspaceId: input.workspaceId, kind: 'docker', network: { not: 'none' } } } })) throw missing();
    if (input.workSessionId && !await tx.workSession.count({ where: { id: input.workSessionId,
      workspaceId: input.workspaceId, agentId: input.agentId, conversationId: input.conversationId,
      status: 'running', cancelRequestedAt: null } })) throw conflict('Work execution changed.');
    const id = randomUUID();
    const conversation = input.conversationId ? await tx.conversation.findFirst({ where: { id: input.conversationId,
      agentId: input.agentId, agent: { workspaceId: input.workspaceId }, publicApiConversation: null },
      select: { id: true, workSession: { select: { id: true, status: true } } } }) : null;
    if (input.conversationId && !conversation) throw missing();
    if (conversation?.workSession && (conversation.workSession.status !== 'running'
      || (input.workSessionId && input.workSessionId !== conversation.workSession.id))) throw conflict('Work execution changed.');
    const reservedContext = input.conversationId ? await tx.agentCollaborationTask.findUnique({ where: { contextId: input.conversationId }, select: { id: true } }) : null;
    if (reservedContext && reservedContext.id !== input.taskId) throw conflict('Delegation contexts can only be continued through the collaboration service.');
    const parent = input.taskId ? await tx.agentCollaborationTask.findFirst({ where: {
      id: input.taskId, workspaceId: input.workspaceId, targetAgentId: input.agentId,
      state: 'working', cancelRequestedAt: null, deadlineAt: { gt: new Date() },
    }, include: { run: true } }) : null;
    if (input.taskId && (!parent || parent.contextId !== input.conversationId)) throw conflict('Delegated execution context is no longer active.');
    if (input.conversationId && !await tx.conversation.count({ where: { id: input.conversationId,
      agentId: input.agentId, agent: { workspaceId: input.workspaceId }, publicApiConversation: null } })) throw missing();
    const available = await tx.agentSubAgent.findMany({ where: { parentId: input.agentId,
      parent: { workspaceId: input.workspaceId, publicRuntimeAllocation: null },
      childId: { in: [...input.targetIds].slice(0, 100) }, child: { workspaceId: input.workspaceId, publicRuntimeAllocation: null } }, select: { childId: true } });
    const chain = parent ? [...parent.run.chain, input.agentId] : [input.agentId];
    return tx.agentCollaborationRun.create({ data: {
      id, workspaceId: input.workspaceId, agentId: input.agentId, sandboxId: input.sandboxId, providerId: input.providerId,
      scopeKey: input.conversationId ?? id, rootId: parent?.rootId ?? id, parentTaskId: parent?.id,
      workSessionId: parent?.run.workSessionId ?? conversation?.workSession?.id ?? input.workSessionId,
      chain, allowedAgentIds: available.map((a) => a.childId), deadlineAt: parent?.deadlineAt ?? new Date(Date.now() + LIMITS.deadlineMs),
    } });
  });
}
export async function closeCollaborationRun(id: string) {
  const run = await db.agentCollaborationRun.findUnique({ where: { id } });
  if (!run) return;
  await db.$transaction(async (tx) => {
    await lockRoot(tx, run.rootId);
    await tx.agentCollaborationRun.updateMany({ where: { id, closedAt: null }, data: { closedAt: new Date() } });
  });
}

async function lockRoot(tx: Tx, rootId: string, required = true) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "AgentCollaborationRun" WHERE id=${rootId} FOR UPDATE`;
  if (!rows.length && required) throw missing();
}
async function authorizeTask(tx: Tx, principal: CollaborationPrincipal, taskId: string, mutation = false) {
  await activeWorkspace(tx, principal.workspaceId);
  const run = principal.kind === 'runtime' ? await authorizeRun(tx, principal) : null;
  const task = await tx.agentCollaborationTask.findFirst({ where: {
    id: taskId, workspaceId: principal.workspaceId,
    ...(run ? { callerAgentId: principal.agentId, scopeKey: run.scopeKey } : {}),
  } });
  if (!task) throw missing();
  if (principal.kind === 'user' && task.callerAgentId !== principal.agentId) {
    if (!await tx.agentCollaborationRun.count({ where: { id: task.rootId, workspaceId: principal.workspaceId, agentId: principal.agentId } })) throw missing();
  }
  if (principal.kind === 'user'  && !await tx.workspace.count({ where: { id: principal.workspaceId,
    OR: [{ ownerId: principal.userId, owner: { status: 'active' } }, { members: { some: { userId: principal.userId, user: { status: 'active' } } } }] } })) throw missing();
  // Revocation removes runtime access to results too. Users may still inspect
  // or cancel their authorized workspace's historical tasks.
  if (run || mutation) await liveEdge(tx, task.workspaceId, task.callerAgentId, task.targetAgentId);
  return task;
}
export function taskView(task: AgentCollaborationTask) {
  return { protocolVersion: '1.0', id: task.id, contextId: task.contextId,
    callerAgentId: task.callerAgentId, targetAgentId: task.targetAgentId, parentTaskId: task.parentTaskId,
    status: { state: task.state, timestamp: task.updatedAt.toISOString(), question: task.question, errorCode: task.errorCode },
    cancelRequested: Boolean(task.cancelRequestedAt), requiresApproval: task.requiresApproval,
    result: task.result, artifacts: task.artifacts, usage: task.usage,
    deadlineAt: task.deadlineAt.toISOString(), createdAt: task.createdAt.toISOString(),
  };
}
export async function listDelegateAgents(principal: Extract<CollaborationPrincipal, { kind: 'runtime' }>) {
  const run = await authorizeRun(db, principal);
  const links = await db.agentSubAgent.findMany({ where: { parentId: principal.agentId,
    childId: { in: run.allowedAgentIds }, parent: { workspaceId: principal.workspaceId },
    child: { workspaceId: principal.workspaceId, publicRuntimeAllocation: null } },
    select: { child: { select: { id: true, name: true, description: true, runtimeKind: true } } }, take: 100 });
  return links.map(({ child }) => ({ ...child, description: child.description?.slice(0, 2000) ?? '',
    supported: isDedicatedSandboxRuntimeKind(child.runtimeKind) }));
}
export async function submitDelegation(principal: Extract<CollaborationPrincipal, { kind: 'runtime' }>, input: {
  agentId: string; messageId: string; message: string;
}) {
  assertRuntimeOwner();
  return db.$transaction(async (tx) => {
    const run = await authorizeRun(tx, principal);
    if (!run.allowedAgentIds.includes(input.agentId)) throw missing();
    await liveEdge(tx, run.workspaceId, run.agentId, input.agentId);
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${run.workspaceId} FOR UPDATE`;
    await lockRoot(tx, run.rootId);
    await authorizeRun(tx, principal);
    const hash = contentHash(input);
    const prior = await tx.agentCollaborationTask.findUnique({ where: { callerAgentId_scopeKey_requestId: {
      callerAgentId: run.agentId, scopeKey: run.scopeKey, requestId: input.messageId,
    } } });
    if (prior) {
      if (prior.requestHash !== hash) throw conflict('messageId was already used for different content.');
      return taskView(prior);
    }
    if (run.parentTaskId && (await tx.agentCollaborationTask.findUnique({ where: { id: run.parentTaskId }, select: { question: true } }))?.question) throw conflict('Finish this turn after requesting input.');
    if (run.chain.includes(input.agentId)) throw new CollaborationError('cycle', 'Delegation cycle refused.', 409);
    if (run.chain.length > LIMITS.depth) throw new CollaborationError('depth_exceeded', 'Delegation depth limit reached.', 409);
    const root = await tx.agentCollaborationRun.findUniqueOrThrow({ where: { id: run.rootId } });
    if (root.taskCount >= LIMITS.tasksPerRoot || root.deadlineAt <= new Date()) throw conflict('Root execution task budget or deadline exceeded.');
    const activeCount = await tx.agentCollaborationTask.count({ where: { workspaceId: run.workspaceId, state: { in: activeStates } } });
    if (activeCount >= LIMITS.activePerWorkspace) throw new CollaborationError('capacity', 'Workspace collaboration capacity reached.', 429);
    const { binding } = await targetSnapshot(tx, run.workspaceId, input.agentId);
    const ancestor = run.parentTaskId ? await tx.agentCollaborationTask.findUniqueOrThrow({ where: { id: run.parentTaskId } }) : null;
    const context = await tx.conversation.create({ data: { agentId: input.agentId, title: 'Delegated task' } });
    const task = await tx.agentCollaborationTask.create({ data: {
      workspaceId: run.workspaceId, callerAgentId: run.agentId, targetAgentId: input.agentId,
      runId: run.id, rootId: root.id, scopeKey: run.scopeKey, parentTaskId: ancestor?.id,
      ancestorTaskIds: ancestor ? [...ancestor.ancestorTaskIds, ancestor.id] : [],
      contextId: context.id, requestId: input.messageId, requestHash: hash, targetBinding: binding,
      message: input.message, state: run.workSessionId ? 'auth-required' : 'submitted',
      requiresApproval: Boolean(run.workSessionId), deadlineAt: root.deadlineAt,
      messages: { create: { requestId: input.messageId, content: input.message } },
    } });
    await tx.agentCollaborationRun.update({ where: { id: root.id }, data: { taskCount: { increment: 1 } } });
    return taskView(task);
  });
}
export async function getDelegation(principal: CollaborationPrincipal, taskId: string) {
  return taskView(await authorizeTask(db, principal, taskId));
}
export async function continueDelegation(principal: CollaborationPrincipal, input: { taskId: string; messageId: string; message: string }) {
  assertRuntimeOwner();
  return db.$transaction(async (tx) => {
    const task = await authorizeTask(tx, principal, input.taskId, true);
    await lockRoot(tx, task.rootId);
    await authorizeTask(tx, principal, task.id, true);
    const current = await tx.agentCollaborationTask.findUniqueOrThrow({ where: { id: task.id } });
    const prior = await tx.agentCollaborationMessage.findUnique({ where: { taskId_requestId: { taskId: task.id, requestId: input.messageId } } });
    if (prior) {
      if (prior.content !== input.message) throw conflict('messageId was already used for different content.');
      return taskView(current);
    }
    if (current.state !== 'input-required' || current.cancelRequestedAt || current.deadlineAt <= new Date()) throw conflict('Only a live input-required task can receive new input.');
    if (await tx.agentCollaborationMessage.count({ where: { taskId: task.id } }) >= LIMITS.messagesPerTask) throw conflict('Task input limit reached.');
    const { binding } = await targetSnapshot(tx, task.workspaceId, task.targetAgentId);
    if (binding !== task.targetBinding) throw conflict('Target configuration changed; start a new task.');
    await tx.agentCollaborationMessage.create({ data: { taskId: task.id, requestId: input.messageId, content: input.message } });
    return taskView(await tx.agentCollaborationTask.update({ where: { id: task.id }, data: {
      state: task.requiresApproval ? 'auth-required' : 'submitted', message: input.message, question: null,
      approvedById: null, errorCode: null, completedAt: null,
    } }));
  });
}
export async function decideDelegation(principal: Extract<CollaborationPrincipal, { kind: 'user' }>, taskId: string, allow: boolean) {
  assertRuntimeOwner();
  return db.$transaction(async (tx) => {
    const task = await authorizeTask(tx, principal, taskId, allow);
    await lockRoot(tx, task.rootId);
    await authorizeTask(tx, principal, task.id, allow);
    const current = await tx.agentCollaborationTask.findUniqueOrThrow({ where: { id: task.id } });
    if (current.state !== 'auth-required' || current.cancelRequestedAt || current.deadlineAt <= new Date()) throw conflict('Task is not waiting for authorization.');
    if (allow) {
      const { binding } = await targetSnapshot(tx, task.workspaceId, task.targetAgentId);
      if (binding !== task.targetBinding) throw conflict('Target configuration changed; start a new task.');
    }
    await writeAudit(tx, { actorId: principal.userId, workspaceId: task.workspaceId,
      action: allow ? 'agent.collaboration.authorize' : 'agent.collaboration.reject',
      targetType: 'AgentCollaborationTask', targetId: task.id,
      changes: { targetAgentId: task.targetAgentId, targetBinding: task.targetBinding, attempt: task.attempt + 1 } });
    return taskView(await tx.agentCollaborationTask.update({ where: { id: task.id }, data: {
      state: allow ? 'submitted' : 'rejected', approvedById: allow ? principal.userId : null,
      completedAt: allow ? null : new Date(), errorCode: allow ? null : 'authorization_denied',
    } }));
  });
}
// Set a cancellation flag for running tasks; only the executor can confirm stop.
export async function cancelTree(tx: Tx, task: Pick<AgentCollaborationTask, 'id' | 'rootId' | 'workspaceId'>) {
  const filter = { workspaceId: task.workspaceId, rootId: task.rootId,
    OR: [{ id: task.id }, { ancestorTaskIds: { has: task.id } }] };
  const now = new Date();
  await tx.agentCollaborationTask.updateMany({ where: { ...filter, state: 'working' }, data: { cancelRequestedAt: now } });
  await tx.agentCollaborationTask.updateMany({ where: { ...filter, state: { in: ['submitted', 'input-required', 'auth-required'] } },
    data: { state: 'canceled', cancelRequestedAt: now, completedAt: now } });
}
export async function cancelDelegation(principal: CollaborationPrincipal, taskId: string) {
  assertRuntimeOwner();
  return db.$transaction(async (tx) => {
    const task = await authorizeTask(tx, principal, taskId);
    await lockRoot(tx, task.rootId);
    await cancelTree(tx, task);
    return taskView(await tx.agentCollaborationTask.findUniqueOrThrow({ where: { id: task.id } }));
  });
}
export async function cancelRunTasks(runId: string) {
  const run = await db.agentCollaborationRun.findUnique({ where: { id: runId } });
  if (!run) return;
  await db.$transaction(async (tx) => {
    await lockRoot(tx, run.rootId);
    const tasks = await tx.agentCollaborationTask.findMany({ where: { runId } });
    for (const task of tasks) await cancelTree(tx, task);
  });
}
export async function currentTask(principal: Extract<CollaborationPrincipal, { kind: 'runtime' }>) {
  const run = await authorizeRun(db, principal);
  return run.parentTaskId ? taskView(await db.agentCollaborationTask.findUniqueOrThrow({ where: { id: run.parentTaskId } })) : null;
}
export async function updateCurrentTask(principal: Extract<CollaborationPrincipal, { kind: 'runtime' }>, input: { question: string } | CollaborationArtifact) {
  return db.$transaction(async (tx) => {
    const run = await authorizeRun(tx, principal);
    if (!run.parentTaskId) throw conflict('This execution is not a delegated task.');
    await lockRoot(tx, run.rootId);
    await authorizeRun(tx, principal);
    const task = await tx.agentCollaborationTask.findUniqueOrThrow({ where: { id: run.parentTaskId } });
    if (task.state !== 'working' || task.cancelRequestedAt) throw conflict('Task is no longer working.');
    if ('question' in input) {
      if (task.question && task.question !== input.question) throw conflict('A different input request is already pending.');
      await tx.agentCollaborationTask.update({ where: { id: task.id }, data: { question: input.question } });
      return { recorded: true, instruction: 'End the turn now. Input-required is committed only after clean runtime completion.' };
    }
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts as unknown as CollaborationArtifact[] : [];
    const prior = artifacts.find((a) => a.artifactId === input.artifactId);
    if (prior && contentHash(prior) !== contentHash(input)) throw conflict('artifactId already contains different content.');
    if (!prior) {
      if (artifacts.length >= LIMITS.artifactsPerTask) throw conflict('Artifact limit reached.');
      await tx.agentCollaborationTask.update({ where: { id: task.id }, data: { artifacts: [...artifacts, input] as unknown as Prisma.InputJsonValue } });
    }
    return { recorded: true, artifactId: input.artifactId };
  });
}
export async function listDelegations(principal: Extract<CollaborationPrincipal, { kind: 'user' }>) {
  await activeWorkspace(db, principal.workspaceId);
  if (!await db.workspace.count({ where: { id: principal.workspaceId, OR: [{ ownerId: principal.userId, owner: { status: 'active' } },
    { members: { some: { userId: principal.userId, user: { status: 'active' } } } }] } })) throw missing();
  const roots = await db.agentCollaborationRun.findMany({ where: { workspaceId: principal.workspaceId,
    agentId: principal.agentId, parentTaskId: null }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true } });
  return (await db.agentCollaborationTask.findMany({ where: { workspaceId: principal.workspaceId,
    OR: [{ callerAgentId: principal.agentId }, { rootId: { in: roots.map((run) => run.id) } }] },
    include: { target: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 })).map((task) => ({
      ...taskView(task), targetName: task.target.name, message: task.message,
    }));
}

export { activeStates, liveEdge, lockRoot };
