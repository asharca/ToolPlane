import 'server-only';
import { db } from '@/lib/db';
import { ORDINARY_AGENT_FILTER } from '@/lib/agents/queries';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';
import { assertLocalActor } from './local-policy';

export type WorkbenchAgent = { id: string; name: string; runtimeKind: string; enabled: boolean; configured: boolean };
/** Navigation metadata only. Actual admission rechecks the live local grant and full configuration. */
export async function listWorkbenchAgents(workspaceId: string, actorId: string): Promise<WorkbenchAgent[]> {
  await assertLocalActor(db, workspaceId, actorId);
  const agents = await db.agent.findMany({ where: { ...ORDINARY_AGENT_FILTER, workspaceId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, runtimeKind: true,
      a2aInternalEnabled: true, providerId: true, model: true,
      sandboxes: { select: { sandbox: { select: { kind: true, network: true, workspaceId: true } } } },
    } });
  return agents.filter((agent) => isDedicatedSandboxRuntimeKind(agent.runtimeKind)).map((agent) => ({
    id: agent.id, name: agent.name, runtimeKind: agent.runtimeKind, enabled: agent.a2aInternalEnabled,
    configured: Boolean(agent.providerId && agent.model && agent.sandboxes.length === 1
      && agent.sandboxes[0].sandbox.workspaceId === workspaceId && agent.sandboxes[0].sandbox.kind === 'docker'
      && agent.sandboxes[0].sandbox.network !== 'none'),
  }));
}
