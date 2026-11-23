import "server-only";
import { TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import type {
  AgentPluginProxyTokenPayload,
  AgentRuntimeTokenPayload,
} from "@/lib/agents/runtime-access";
import { assertLiveGrant, isLocalGrant, type TaskGrant } from "./principal";
import { localTarget } from "./local-policy";
import { findAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";

export type LocalTaskLeaseSubject = Pick<
  AgentRuntimeTokenPayload | AgentPluginProxyTokenPayload,
  | "workspaceId"
  | "agentId"
  | "agentRevisionId"
  | "sandboxId"
  | "conversationId"
  | "a2aContextId"
  | "a2aTaskId"
  | "a2aLeaseToken"
>;

export async function assertLocalTaskLease(token: LocalTaskLeaseSubject) {
  if (!token.a2aTaskId || !token.a2aLeaseToken) throw new TaskNotFoundError();
  const row = await db.a2ATask.findUnique({ where: { id: token.a2aTaskId } });
  if (
    !row ||
    row.leaseToken !== token.a2aLeaseToken ||
    row.state !== TaskState.TASK_STATE_WORKING ||
    row.phase !== "executing" ||
    row.cancelRequestedAt ||
    row.deadlineAt <= new Date()
  )
    throw new TaskNotFoundError();
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    grant.workspaceId !== token.workspaceId ||
    grant.agentId !== token.agentId ||
    grant.agentRevisionId !== token.agentRevisionId
  )
    throw new TaskNotFoundError();
  await assertLiveGrant(grant, "send");
  if (token.a2aContextId !== row.contextId) throw new TaskNotFoundError();
  const mapped = await findAgentConversationSandbox({
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    conversationId: token.conversationId,
    contextId: row.contextId,
  });
  const target = await localTarget(
    db,
    grant.workspaceId,
    grant.agentId,
    grant.ancestorTaskIds.length === 0 ? grant.entryPolicy : "delegation",
    grant.agentRevisionId,
  );
  if (mapped?.sandboxId !== token.sandboxId) throw new TaskNotFoundError();
  return { row, grant, target };
}

/** Signed task and execution lease are required; a normal model/MCP runtime token cannot delegate. */
export async function assertLocalRuntimeToken(token: AgentRuntimeTokenPayload) {
  const { row, grant, target } = await assertLocalTaskLease(token);
  if (
    (grant.modelOverride?.providerId ?? target.providerId) !==
      token.providerId ||
    grant.modelOverride?.model !== token.modelOverride?.model ||
    grant.modelOverride?.providerId !== token.modelOverride?.providerId
  )
    throw new TaskNotFoundError();
  return { row, grant, target };
}
