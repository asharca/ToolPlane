import 'server-only';
import { TaskState } from '@a2a-js/sdk';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import type { AgentRuntimeTokenPayload } from '@/lib/agents/runtime-access';
import { assertLiveGrant, isLocalGrant, type TaskGrant } from './principal';
import { localTarget } from './local-policy';

/** Signed task and execution lease are required; a normal model/MCP runtime token cannot delegate. */
export async function assertLocalRuntimeToken(token: AgentRuntimeTokenPayload, approvalChannel = false) {
  if (!token.a2aTaskId || !token.a2aLeaseToken) throw new TaskNotFoundError();
  const row = await db.a2ATask.findUnique({ where: { id: token.a2aTaskId } });
  if (!row || row.leaseToken !== token.a2aLeaseToken || row.state !== TaskState.TASK_STATE_WORKING
    || row.phase !== 'executing' || row.cancelRequestedAt || row.deadlineAt <= new Date()) throw new TaskNotFoundError();
  if (!approvalChannel && token.a2aApprovalRequired && row.approvalReadyLease !== row.leaseToken) throw new TaskNotFoundError();
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant) || grant.workspaceId !== token.workspaceId || grant.agentId !== token.agentId) throw new TaskNotFoundError();
  await assertLiveGrant(grant, 'send');
  const target = await localTarget(db, grant.workspaceId, grant.agentId);
  if (target.sandboxId !== token.sandboxId || target.providerId !== token.providerId) throw new TaskNotFoundError();
  return { row, grant, target };
}
