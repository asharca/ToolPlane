import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentToolApproval, Prisma } from "@prisma/client";
import { TaskState } from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { lockTask } from "@/lib/a2a/store";
import { refreshTaskStorage } from "@/lib/a2a/quotas";
import { assertLocalGrant } from "@/lib/a2a/local-policy";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { toolApprovalDecision } from "@/lib/agents/tool-approval-policy";
import { sanitizeLog } from "@/lib/observability/redaction";
import { getLogContext } from "@/lib/observability/context";
import { admitChannelSender } from "@/lib/agents/channel-sender-access";
import { decryptChannelCredentials } from "@/lib/agents/channel-connections";
import type { NormalizedMessagingSource } from "@/lib/agents/messaging";
import { notifyTaskOutput } from "./live-output";
import { sendChannelApprovalNotice } from "@/lib/agents/channel-runtime";

const identifier = z.string().min(1).max(512);
export const RuntimeToolApprovalInput = z
  .object({
    action: z.enum(["request", "poll", "consume"]),
    toolCallId: identifier,
    toolName: identifier,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export const ToolApprovalResponse = z
  .object({
    id: z.string().min(1).max(200),
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function toolArgumentHash(toolName: string, args: unknown) {
  return createHash("sha256")
    .update(canonical([toolName, args]))
    .digest("hex");
}
async function live(
  tx: Prisma.TransactionClient,
  taskId: string,
  lease: string,
) {
  const row = await lockTask(tx, taskId);
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    row.leaseToken !== lease ||
    row.phase !== "executing" ||
    row.state !== TaskState.TASK_STATE_WORKING ||
    row.cancelRequestedAt ||
    row.deadlineAt <= new Date()
  )
    throw new TaskNotFoundError();
  await assertLocalGrant(grant, tx);
  return { row, grant };
}
async function audit(
  tx: Prisma.TransactionClient,
  approval: AgentToolApproval,
  outcome: "success" | "denied",
  decision: string,
) {
  const context = getLogContext();
  await tx.logEvent.create({
    data: {
      domain: "agent",
      eventName: "agent.tool_approval",
      message: "agent.tool_approval",
      outcome,
      workspaceId: approval.workspaceId,
      agentId: approval.agentId,
      taskId: approval.taskId,
      conversationId: approval.conversationId,
      channelId: approval.channelId,
      toolName: approval.toolName,
      actorId: approval.decidedBy,
      traceId: context?.traceId ?? randomUUID(),
      spanId: randomUUID(),
      attributes: {
        data: {
          approvalId: approval.id,
          entryKind: approval.entryKind,
          argumentHash: approval.argumentHash,
          decision,
        },
      },
    },
  });
}
export function toolApprovalCard(row: AgentToolApproval): ToolApprovalCard {
  return {
    id: row.id,
    taskId: row.taskId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    argumentHash: row.argumentHash,
    argumentSummary: row.argumentSummary,
    entryKind: row.entryKind,
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    shortCode: row.shortCode,
  };
}
export type ToolApprovalCard = {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  argumentHash: string;
  argumentSummary: string;
  entryKind: string;
  expiresAt: string;
  status: string;
  shortCode: string;
};
export async function pendingToolApprovals(
  taskId: string,
  lease: string | null,
  tx: Prisma.TransactionClient = db,
) {
  if (!lease) return [];
  const rows = await tx.agentToolApproval.findMany({
    where: {
      taskId,
      lease,
      status: "pending",
      consumedAt: null,
      expiresAt: { gt: new Date() },
      task: {
        leaseToken: lease,
        phase: "executing",
        state: TaskState.TASK_STATE_WORKING,
        cancelRequestedAt: null,
        deadlineAt: { gt: new Date() },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 32,
  });
  return rows.map(toolApprovalCard);
}

export async function runtimeToolApproval(
  token: AgentRuntimeTokenPayload,
  input: z.infer<typeof RuntimeToolApprovalInput>,
) {
  const taskId = token.a2aTaskId,
    lease = token.a2aLeaseToken;
  if (!taskId || !lease) throw new TaskNotFoundError();
  await assertLocalRuntimeToken(token);
  const argumentHash = toolArgumentHash(input.toolName, input.arguments);
  const result = await db.$transaction(async (tx) => {
    const { row: task, grant } = await live(tx, taskId, lease);
    let approval = await tx.agentToolApproval.findUnique({
      where: {
        taskId_lease_toolCallId: {
          taskId,
          lease,
          toolCallId: input.toolCallId,
        },
      },
    });
    let created = false;
    if (
      approval &&
      (approval.argumentHash !== argumentHash ||
        approval.toolName !== input.toolName)
    ) {
      await tx.agentToolApproval.update({
        where: { id: approval.id },
        data: { status: "denied", consumedAt: new Date() },
      });
      await audit(tx, approval, "denied", "parameter_mismatch");
      return { allowed: false, status: "denied" };
    }
    if (!approval) {
      if (input.action !== "request")
        return { allowed: false, status: "denied" };
      const entryKind =
        grant.ancestorTaskIds.length || !grant.entryPolicy
          ? "a2a"
          : grant.entryPolicy.kind;
      const unattended = entryKind === "a2a" || entryKind === "trigger";
      const revision = await requireAgentRevision(
        tx,
        grant.agentId,
        grant.agentRevisionId,
      );
      const decision = unattended
        ? "allow"
        : toolApprovalDecision(
            revision.config.runtimeKind === "pi-sdk"
              ? revision.config.toolApproval
              : undefined,
            input.toolName,
          );
      if (
        decision === "ask" &&
        (await tx.agentToolApproval.count({
          where: {
            taskId,
            lease,
            status: { in: ["pending", "approved"] },
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
        })) >= 32
      )
        return { allowed: false, status: "denied" };
      approval = await tx.agentToolApproval.create({
        data: {
          taskId,
          lease,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
          conversationId: token.conversationId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          argumentHash,
          argumentSummary: JSON.stringify(
            sanitizeLog(input.arguments, getLogContext()?.secrets).data,
          ).slice(0, 2000),
          entryKind,
          channelId:
            entryKind === "channel" ? grant.entryPolicy?.channelId : undefined,
          ...(entryKind === "channel" && grant.entryPolicy?.channelSource
            ? { channelSource: grant.entryPolicy.channelSource }
            : {}),
          shortCode: randomBytes(5).toString("hex"),
          status:
            decision === "ask"
              ? "pending"
              : decision === "allow"
                ? "allowed"
                : "denied",
          expiresAt: new Date(
            Math.min(
              Date.now() + 120_000,
              task.deadlineAt.getTime(),
              token.exp * 1000,
            ),
          ),
        },
      });
      await refreshTaskStorage(tx, taskId);
      created = true;
      if (decision !== "ask")
        await audit(
          tx,
          approval,
          decision === "allow" ? "success" : "denied",
          unattended ? "unattended_allow" : `policy_${decision}`,
        );
    }
    if (approval.expiresAt <= new Date() && !approval.consumedAt) {
      approval = await tx.agentToolApproval.update({
        where: { id: approval.id },
        data: { status: "expired", consumedAt: new Date() },
      });
      await audit(tx, approval, "denied", "expired");
    }
    if (input.action === "consume") {
      const allowed =
        !approval.consumedAt &&
        ["allowed", "approved"].includes(approval.status) &&
        approval.expiresAt > new Date();
      if (!approval.consumedAt) {
        await tx.agentToolApproval.update({
          where: { id: approval.id },
          data: {
            consumedAt: new Date(),
            status: allowed ? "consumed" : "denied",
          },
        });
        await audit(
          tx,
          approval,
          allowed ? "success" : "denied",
          allowed ? "consumed" : "denied",
        );
      }
      return { allowed, status: allowed ? "consumed" : "denied" };
    }
    return {
      allowed: false,
      status: approval.consumedAt ? "denied" : approval.status,
      expiresAt: approval.expiresAt.toISOString(),
      ...(created ? { created: approval } : {}),
    };
  });
  if ("created" in result && result.created) {
    notifyTaskOutput(taskId);
    if (
      result.created.entryKind === "channel" &&
      result.created.status === "pending"
    )
      await deliverChannelApproval(result.created);
  }
  const { created: _created, ...response } = result as typeof result & {
    created?: AgentToolApproval;
  };
  return response;
}
async function deliverChannelApproval(approval: AgentToolApproval) {
  const source = approval.channelSource as NormalizedMessagingSource | null;
  let sent = false;
  if (approval.channelId && source?.chatId) {
    const t = await getTranslations({
      locale: "zh",
      namespace: "console.toolApproval",
    });
    sent = await sendChannelApprovalNotice(
      approval.channelId,
      source,
      t("channelRequest", {
        tool: approval.toolName,
        summary: approval.argumentSummary,
        code: approval.shortCode,
      }),
    );
  }
  if (!sent)
    await db.$transaction(async (tx) => {
      await live(tx, approval.taskId, approval.lease);
      const current = await tx.agentToolApproval.findUniqueOrThrow({
        where: { id: approval.id },
      });
      if (current.status !== "pending") return;
      await tx.agentToolApproval.update({
        where: { id: approval.id },
        data: { status: "denied", decidedAt: new Date() },
      });
      await audit(tx, current, "denied", "delivery_unavailable");
    });
}
export async function decideToolApproval(input: {
  id: string;
  decision: "approve" | "deny";
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const initial = await tx.agentToolApproval.findFirst({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
      },
    });
    if (!initial) throw new TaskNotFoundError();
    await live(tx, initial.taskId, initial.lease);
    const current = await tx.agentToolApproval.findUniqueOrThrow({
      where: { id: initial.id },
    });
    if (
      current.entryKind === "channel" ||
      current.status !== "pending" ||
      current.consumedAt ||
      current.expiresAt <= new Date()
    )
      throw new UnsupportedOperationError(
        "Tool approval is no longer pending.",
      );
    const updated = await tx.agentToolApproval.update({
      where: { id: current.id },
      data: {
        status: input.decision === "approve" ? "approved" : "denied",
        decidedAt: new Date(),
        decidedBy: input.actorId,
      },
    });
    await audit(
      tx,
      updated,
      input.decision === "approve" ? "success" : "denied",
      input.decision,
    );
    return updated.taskId;
  });
}

/** Called only AFTER live sender admission, BEFORE queueing or taking a conversation lock. */
export async function channelToolApprovalReply(input: {
  connectionId: string;
  workspaceId: string;
  agentId: string;
  source: NormalizedMessagingSource;
  text: string;
  roleIds?: unknown;
}) {
  if (!/^\/(approve|deny)(?:\s|$)/i.test(input.text.trim())) return null;
  const match = /^\/(approve|deny)(?:\s+([a-f0-9]{10}))?\s*$/i.exec(
    input.text.trim(),
  );
  if (!match)
    return (
      await getTranslations({ locale: "zh", namespace: "console.toolApproval" })
    )("channelInvalid");
  const t = await getTranslations({
    locale: "zh",
    namespace: "console.toolApproval",
  });
  if (!match[2]) return t("channelInvalid");
  const connection = await db.agentChannelConnection.findFirst({
    where: {
      id: input.connectionId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      status: { in: ["running", "starting", "waiting_callback"] },
    },
  });
  if (
    !connection ||
    !(
      await admitChannelSender({
        connection,
        credentials: decryptChannelCredentials(connection.credentials),
        source: input.source,
        roleIds: input.roleIds,
      })
    ).allowed
  )
    return t("channelInvalid");
  const taskId = await db
    .$transaction(async (tx) => {
      const initial = await tx.agentToolApproval.findFirst({
        where: {
          shortCode: match[2].toLowerCase(),
          channelId: input.connectionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          entryKind: "channel",
        },
      });
      if (!initial) return null;
      await live(tx, initial.taskId, initial.lease);
      const approval = await tx.agentToolApproval.findUniqueOrThrow({
        where: { id: initial.id },
      });
      const source = approval.channelSource as NormalizedMessagingSource | null;
      // Short codes are not credentials; bind to the original sender and exact chat/thread.
      if (
        !source?.userId ||
        source.userId !== input.source.userId ||
        source.chatId !== input.source.chatId ||
        source.threadId !== input.source.threadId ||
        source.platform !== input.source.platform ||
        source.chatType !== input.source.chatType ||
        approval.status !== "pending" ||
        approval.consumedAt ||
        approval.expiresAt <= new Date()
      )
        return null;
      const approved = match[1].toLowerCase() === "approve";
      const updated = await tx.agentToolApproval.update({
        where: { id: approval.id },
        data: {
          status: approved ? "approved" : "denied",
          decidedAt: new Date(),
          decidedBy: input.source.userId,
        },
      });
      await audit(
        tx,
        updated,
        approved ? "success" : "denied",
        approved ? "channel_approve" : "channel_deny",
      );
      return approval.taskId;
    })
    .catch((error: unknown) => {
      if (error instanceof TaskNotFoundError) return null;
      throw error;
    });
  if (taskId) notifyTaskOutput(taskId);
  return t(taskId ? "channelRecorded" : "channelInvalid");
}
