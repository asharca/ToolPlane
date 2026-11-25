import "server-only";
import { createHash } from "node:crypto";
import { SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import {
  assertLocalActor,
  assertLocalGrant,
  localEntryOwnerKey,
  localOwnerKey,
  localTarget,
} from "@/lib/a2a/local-policy";
import { assertEntryPolicy } from "./entry-policy";
import type { Prisma } from "@prisma/client";
import type { FileUIPart } from "ai";
import { settled, terminal } from "@/lib/a2a/model";
import {
  assertLiveGrant,
  isLocalGrant,
  type TaskGrant,
} from "@/lib/a2a/principal";
import { persistAgentPromptInvocation } from "@/lib/agents/prompt-invocation";
import { db } from "@/lib/db";
import type { AgentEntryRuntimePart } from "./entries";
import { notifyTaskOutput } from "./live-output";
import { recordedTaskOutput } from "./live-output-read";
import { nativeUiView, type NativeUiProjection } from "./native-ui";
import {
  captureReplyArtifacts,
  listReplyArtifacts,
  replyArtifactParts,
} from "./reply-artifacts";

export function chatUserMessageId(
  conversationId: string,
  actorId: string,
  messageId: string,
) {
  const key = createHash("sha256")
    .update(JSON.stringify([conversationId, actorId, messageId]))
    .digest("hex");
  return `agent-chat-user-${key}`;
}

type ChatReplyPart =
  | AgentEntryRuntimePart
  | { type: "text"; text: string; state: "done" }
  | {
      type: "data-hook-activity";
      id: string;
      data: NativeUiProjection["hooks"][number];
    }
  | {
      type: "data-subagent-activity";
      id: string;
      data: NativeUiProjection["activities"][number];
    }
  | FileUIPart;

type ChatOwner = {
  workspaceId: string;
  agentId: string;
  actorId: string;
  conversationId: string;
};
const projecting = new Map<string, Promise<ChatReplyPart[]>>();

/** Called after task settlement. A reconnect can recover a committed task whose projection was interrupted. */
export async function persistSettledChatReply(
  taskId: string,
  expected?: ChatOwner,
): Promise<ChatReplyPart[] | null> {
  const row = await db.a2ATask.findFirst({
    where: {
      id: taskId,
      rootTaskId: taskId,
      parentTaskId: null,
      entryReceipts: { some: { binding: { kind: "chat" } } },
    },
    include: {
      context: {
        select: {
          workspaceId: true,
          agentId: true,
          targetKind: true,
          ownerKey: true,
          expiresAt: true,
          workspace: { select: { slug: true } },
        },
      },
    },
  });
  if (!row || !settled(row.state)) return null;
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    grant.entryPolicy?.kind !== "chat" ||
    grant.ancestorTaskIds.length
  )
    return null;
  const { workspaceId, agentId, actorId } = grant;
  const conversationId = grant.entryPolicy.sourceId;
  if (
    grant.entryPolicy.sourceAgentId !== agentId ||
    row.context.workspaceId !== workspaceId ||
    row.context.agentId !== agentId ||
    row.context.targetKind !== "local" ||
    row.context.ownerKey !== grant.ownerKey ||
    row.context.expiresAt <= new Date() ||
    (expected &&
      (expected.workspaceId !== workspaceId ||
        expected.agentId !== agentId ||
        expected.actorId !== actorId ||
        expected.conversationId !== conversationId))
  )
    throw new TaskNotFoundError();
  const policy = grant.entryPolicy;
  // A failed execution can reach its deadline before settlement. Archiving its
  // recorded output authorizes no further execution, file reads or HTTP access.
  const archivedFailure =
    !expected &&
    row.state === TaskState.TASK_STATE_FAILED &&
    grant.expiresAt <= Date.now();
  const checkProjectionAuthority = async (tx: Prisma.TransactionClient) => {
    if (!archivedFailure) return assertLocalGrant(grant, tx);
    if (
      !grant.agentRevisionId ||
      grant.ancestorAgentIds.length ||
      (grant.ownerKey !==
        localEntryOwnerKey(workspaceId, agentId, actorId, policy) &&
        grant.ownerKey !== localOwnerKey(workspaceId, agentId, actorId))
    )
      throw new TaskNotFoundError();
    await assertLocalActor(tx, workspaceId, actorId);
    await assertEntryPolicy(tx, grant);
    const target = await localTarget(
      tx,
      workspaceId,
      agentId,
      policy,
      grant.agentRevisionId,
    );
    if (target.binding !== grant.targetBinding) throw new TaskNotFoundError();
  };
  if (archivedFailure) await checkProjectionAuthority(db);
  else await assertLiveGrant(grant, "read");
  const receipt = await db.a2AEntryReceipt.findFirst({
    where: {
      taskId,
      binding: {
        kind: "chat",
        sourceId: conversationId,
        ownerKey: grant.ownerKey,
        contextId: row.contextId,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { messageId: true },
  });
  if (!receipt) throw new TaskNotFoundError();
  const requestMessageId = SendMessageRequest.fromJSON(row.request).message
    ?.messageId;
  const id = terminal(row.state)
    ? `agent-task-reply-${taskId}`
    : `agent-task-reply-${taskId}-${requestMessageId}`;
  const existing = await db.message.findFirst({
    where: { id, conversationId, role: "assistant" },
    select: { parts: true },
  });
  if (existing) return existing.parts as unknown as ChatReplyPart[];

  const { state, snapshot, uiProjection, statusAt } = row;
  const slug = row.context.workspace.slug;
  const userId = chatUserMessageId(conversationId, actorId, receipt.messageId);
  let result = projecting.get(id);
  if (!result) {
    result = projectReply().finally(() => projecting.delete(id));
    projecting.set(id, result);
  }
  const parts = await result;
  if (expected) await assertLiveGrant(grant, "read");
  return parts;

  async function projectReply(): Promise<ChatReplyPart[]> {
    // Entry admission imports the task store, whose settlement hook calls this module.
    const {
      agentEntryResult,
      agentEntryRuntimeParts,
      agentEntryPromptInvocations,
    } = await import("./entries");
    const task = Task.fromJSON(snapshot);
    const user = await db.message.findFirst({
      where: { id: userId, conversationId, role: "user" },
      select: { id: true },
    });
    if (user) {
      for (const invocation of agentEntryPromptInvocations(
        task,
        requestMessageId,
      )) {
        await persistAgentPromptInvocation({
          conversationId,
          messageId: userId,
          invocation,
        });
      }
    } else {
      // Older receipts used generated message IDs. Reuse their projection on replay.
      const previous = await db.message.findFirst({
        where: {
          conversationId,
          role: "assistant",
          parts: {
            array_contains: [{ type: "data-agent-task", data: { taskId } }],
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { parts: true },
      });
      if (previous) return previous.parts as unknown as ChatReplyPart[];
    }
    const projection = nativeUiView(uiProjection);
    const reply: ChatReplyPart[] = [...agentEntryRuntimeParts(task)];
    for (const hook of projection.hooks) {
      reply.push({
        type: "data-hook-activity",
        id: `native-hook:${hook.id}`,
        data: hook,
      });
    }
    for (const activity of projection.activities) {
      const key = JSON.stringify([
        activity.type,
        activity.source.subagentId,
        activity.toolCallId ?? null,
      ]);
      reply.push({
        type: "data-subagent-activity",
        id: `native-child:${taskId}:${key}`,
        data: activity,
      });
    }
    if (
      state === TaskState.TASK_STATE_COMPLETED ||
      state === TaskState.TASK_STATE_INPUT_REQUIRED
    ) {
      const query = new URLSearchParams({ agent: agentId, c: conversationId });
      const path = `/app/${encodeURIComponent(slug)}/work?${query}`;
      reply.push({
        type: "text",
        text: agentEntryResult(task, path),
        state: "done",
      });
      const artifacts = await captureReplyArtifacts({
        workspaceId,
        conversationId,
        uploaderId: actorId,
        privateEntry: true,
        entryTaskId: taskId,
        artifacts: await listReplyArtifacts(taskId),
      });
      reply.push(...replyArtifactParts(artifacts));
    } else {
      const { text } = await recordedTaskOutput(taskId);
      if (text.trim()) reply.push({ type: "text", text, state: "done" });
    }
    const saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await checkProjectionAuthority(tx);
      const previous = await tx.message.findFirst({
        where: {
          conversationId,
          role: "user",
          OR: [
            { id: userId },
            {
              parts: {
                array_contains: [
                  { type: "data-agent-queued-message", data: { taskId } },
                ],
              },
            },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { createdAt: true },
      });
      return tx.message.upsert({
        where: { id },
        update: {},
        create: {
          id,
          conversationId,
          role: "assistant",
          parts: reply as Prisma.InputJsonValue,
          createdAt: new Date(
            Math.max(
              statusAt.getTime(),
              (previous?.createdAt.getTime() ?? 0) + 1,
            ),
          ),
        },
        select: { parts: true },
      });
    });
    notifyTaskOutput(taskId);
    return saved.parts as unknown as ChatReplyPart[];
  }
}
