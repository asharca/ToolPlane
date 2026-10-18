import "server-only";
import type { A2ATask } from "@prisma/client";
import { db } from "@/lib/db";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import {
  ensureAgentConversationSandbox,
  findAgentConversationSandbox,
} from "@/lib/agents/conversation-sandbox";
import { assertLiveGrant, isLocalGrant, type TaskGrant } from "./principal";

/** Entry IDs come from the signed, revalidated ingress grant, never runtime input. */
export async function localTaskSandbox(
  row: A2ATask,
  cleanup = false,
  signal?: AbortSignal,
) {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant)) throw new Error("Local target unavailable.");
  if (cleanup) {
    assertRuntimeOwner();
    if (row.executionBackend !== "pi-harness" || !row.nativeOperationId)
      throw new Error("Native cleanup requires a bound operation.");
  } else await assertLiveGrant(grant, "send");
  let conversationId: string | undefined;
  if (!grant.ancestorTaskIds.length && grant.entryPolicy) {
    if (grant.entryPolicy.kind === "work") {
      const work = await db.workSession.findFirst({
        where: {
          id: grant.entryPolicy.sourceId,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
        },
        select: { conversationId: true },
      });
      if (!work) throw new Error("Local Work session unavailable.");
      conversationId = work.conversationId;
    } else conversationId = grant.entryPolicy.sourceId;
  }
  const identity = {
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    conversationId,
    contextId: row.contextId,
  };
  const mapping = cleanup
    ? await findAgentConversationSandbox({ ...identity, cleanup: true })
    : await ensureAgentConversationSandbox({ ...identity, signal });
  if (!mapping) throw new Error("Bound native sandbox unavailable.");
  if (conversationId && grant.entryPolicy?.kind === "work")
    await db.workSession.updateMany({
      where: {
        id: grant.entryPolicy.sourceId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        conversationId,
      },
      data: { sandboxId: mapping.sandboxId },
    });
  return { ...mapping, conversationId, a2aContextId: row.contextId };
}
