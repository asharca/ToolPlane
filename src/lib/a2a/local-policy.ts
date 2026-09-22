import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { TaskState } from '@a2a-js/sdk';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';
import { ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import { A2A_SCOPES, isLocalGrant, type LocalA2AGrant, type TaskGrant } from './principal';

export const LOCAL_LIMITS = { depth: 3, tasksPerRoot: 16, resumes: 16, activePerWorkspace: 16,
  tasksPerOwner: 256, requestBytes: 65_536 } as const;
type Database = Prisma.TransactionClient;
const missing = () => new TaskNotFoundError();
export function localOwnerKey(...values: string[]) {
  return createHash('sha256').update(JSON.stringify(['toolplane:a2a:local:v1', ...values])).digest('hex');
}
export async function assertLocalActor(tx: Database, workspaceId: string, actorId: string) {
  if (!await tx.workspace.count({ where: { id: workspaceId, status: 'active', owner: { status: 'active' }, OR: [
    { ownerId: actorId }, { members: { some: { userId: actorId, user: { status: 'active' } } } },
  ] } }) || !await tx.user.count({ where: { id: actorId, status: 'active' } })) throw missing();
}
/** Hash configured capabilities, never persist their credentials in a grant or task. */
export async function localTarget(tx: Database, workspaceId: string, agentId: string) {
  const agent = await tx.agent.findFirst({ where: { ...ORDINARY_AGENT_FILTER, id: agentId,
    workspaceId, a2aInternalEnabled: true }, select: {
    id: true, name: true, runtimeKind: true, systemPrompt: true, model: true, maxSteps: true,
    disabledBuiltinTools: true, provider: { select: { id: true, format: true, baseUrl: true, apiKey: true } },
    sandboxes: { select: { sandboxId: true, sandbox: { select: { workspaceId: true, kind: true, network: true, image: true, config: true } } } },
    servers: { orderBy: { deploymentId: 'asc' }, select: { deploymentId: true } },
    skills: { orderBy: { installedSkillId: 'asc' }, select: { installedSkillId: true } },
    toolkits: { orderBy: { toolkitId: 'asc' }, select: { toolkit: { select: {
      servers: { orderBy: { deploymentId: 'asc' }, select: { deploymentId: true } },
      skills: { orderBy: { installedSkillId: 'asc' }, select: { installedSkillId: true } },
    } } } },
    subAgents: { orderBy: { childId: 'asc' }, select: { childId: true } },
  } });
  if (!agent || !isDedicatedSandboxRuntimeKind(agent.runtimeKind) || !agent.provider || !agent.model
    || agent.sandboxes.length !== 1 || agent.sandboxes[0].sandbox.workspaceId !== workspaceId
    || agent.sandboxes[0].sandbox.kind !== 'docker' || agent.sandboxes[0].sandbox.network === 'none') throw missing();
  const deployments = [...new Set([...agent.servers, ...agent.toolkits.flatMap((t) => t.toolkit.servers)].map((r) => r.deploymentId))].sort();
  const skills = [...new Set([...agent.skills, ...agent.toolkits.flatMap((t) => t.toolkit.skills)].map((r) => r.installedSkillId))].sort();
  // Database-side digests avoid materializing potentially large secret-bearing bundles.
  const dependencies = await tx.$queryRaw<Array<{ kind: string; id: string; hash: string }>>`
    SELECT 'deployment' AS kind, d.id, encode(sha256(convert_to(jsonb_build_array(d.source, d."sourceRef", d."installCfg", d."mcpToolExposure", d."mcpAllowedTools",
      (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM "DeploymentConfigFile" f WHERE f."deploymentId"=d.id))::text, 'UTF8')), 'hex') AS hash
      FROM "Deployment" d WHERE d."workspaceId"=${workspaceId} AND d.id = ANY(${deployments}::text[])
    UNION ALL
    SELECT 'skill' AS kind, s.id, encode(sha256(convert_to(jsonb_build_array(to_jsonb(s), to_jsonb(k))::text, 'UTF8')), 'hex') AS hash
      FROM "InstalledSkill" s LEFT JOIN "Skill" k ON k.id=s."skillId"
      WHERE s."workspaceId"=${workspaceId} AND s.id = ANY(${skills}::text[])
    ORDER BY kind, id`;
  if (dependencies.length !== deployments.length + skills.length) throw missing();
  const binding = createHash('sha256').update(JSON.stringify({ agent, dependencies })).digest('hex');
  return { id: agent.id, name: agent.name, binding, sandboxId: agent.sandboxes[0].sandboxId,
    providerId: agent.provider.id, targets: agent.subAgents.map((s) => s.childId) };
}
export async function assertLocalGrant(grant: LocalA2AGrant, tx: Database = db) {
  if (grant.expiresAt <= Date.now() || grant.ancestorTaskIds.length > LOCAL_LIMITS.depth
    || grant.ancestorTaskIds.length !== grant.ancestorAgentIds.length) throw missing();
  await assertLocalActor(tx, grant.workspaceId, grant.actorId);
  if ((await localTarget(tx, grant.workspaceId, grant.agentId)).binding !== grant.targetBinding) throw missing();
  for (let index = 0; index < grant.ancestorTaskIds.length; index++) {
    const ancestor = await tx.a2ATask.findUnique({ where: { id: grant.ancestorTaskIds[index] } });
    if (!ancestor || ancestor.cancelRequestedAt || ancestor.deadlineAt <= new Date()
      || [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED].includes(ancestor.state)) throw missing();
    const authority = ancestor.grant as unknown as TaskGrant;
    if (!isLocalGrant(authority) || authority.workspaceId !== grant.workspaceId || authority.actorId !== grant.actorId
      || authority.agentId !== grant.ancestorAgentIds[index]) throw missing();
    const current = await localTarget(tx, grant.workspaceId, authority.agentId);
    const next = grant.ancestorAgentIds[index + 1] ?? grant.agentId;
    if (current.binding !== authority.targetBinding || !current.targets.includes(next)) throw missing();
  }
}
export async function createLocalRootGrant(workspaceId: string, agentId: string, actorId: string): Promise<LocalA2AGrant> {
  await assertLocalActor(db, workspaceId, actorId);
  const target = await localTarget(db, workspaceId, agentId);
  return { kind: 'local', workspaceId, agentId, actorId, targetBinding: target.binding,
    ownerKey: localOwnerKey(workspaceId, agentId, actorId), expiresAt: Date.now() + 840_000,
    scopes: [...A2A_SCOPES], maxConcurrent: 4, timeoutSeconds: 840, retentionDays: 7,
    ancestorTaskIds: [], ancestorAgentIds: [] };
}
export async function childGrant(parentId: string, lease: string, targetId: string): Promise<LocalA2AGrant> {
  const parent = await db.a2ATask.findUnique({ where: { id: parentId } });
  if (!parent || parent.state !== TaskState.TASK_STATE_WORKING || parent.phase !== 'executing'
    || parent.leaseToken !== lease || parent.cancelRequestedAt) throw missing();
  const authority = parent.grant as unknown as TaskGrant;
  if (!isLocalGrant(authority)) throw missing();
  await assertLocalGrant(authority);
  const chain = [...authority.ancestorAgentIds, authority.agentId];
  if (chain.includes(targetId) || chain.length > LOCAL_LIMITS.depth) throw new UnsupportedOperationError('Delegation cycle or depth limit.');
  const caller = await localTarget(db, authority.workspaceId, authority.agentId);
  if (!caller.targets.includes(targetId)) throw missing();
  const target = await localTarget(db, authority.workspaceId, targetId);
  return { ...authority, agentId: targetId, targetBinding: target.binding,
    parentTaskId: parentId, rootTaskId: parent.rootTaskId ?? parent.id,
    ancestorTaskIds: [...authority.ancestorTaskIds, parent.id], ancestorAgentIds: chain,
    ownerKey: localOwnerKey(authority.workspaceId, parent.id, targetId, authority.actorId),
    expiresAt: Math.min(authority.expiresAt, parent.deadlineAt.getTime()) };
}
