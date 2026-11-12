import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Cron } from "croner";
import { Task, TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import type {
  A2ATask,
  AgentTrigger,
  AgentChannelConnection,
  Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { assertLocalActor } from "@/lib/a2a/local-policy";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { settled } from "@/lib/a2a/model";
import { createConversation } from "./mutations";
import {
  submitAgentEntry,
  agentEntryResult,
  agentEntryRuntimeParts,
} from "./execution/entries";
import { parseRuntimeFailure } from "./runtime-failure";
import {
  runtimeCanOperate,
  assertRuntimeOwner,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { logSystemEvent } from "@/lib/observability/system";
import { notifyTaskOutput } from "./execution/live-output";
import { sendChannelNotice } from "./channel-runtime";
import { hostedRunnerSpec } from "./platform-runner";
import { isSilentAgentReply } from "./messaging";

export const triggerSecretHash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export function newTriggerSecret() {
  const secret = `tpt_${randomBytes(32).toString("hex")}`;
  return { secret, secretHash: triggerSecretHash(secret) };
}
export function verifyTriggerSecret(hash: string | null, secret: string) {
  const actual = Buffer.from(triggerSecretHash(secret), "hex");
  const expected = Buffer.from(hash ?? "", "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function nextTriggerRun(
  cron: string,
  timezone: string,
  after = new Date(),
) {
  const job = new Cron(cron, { timezone, paused: true });
  try {
    const next = job.nextRun(after);
    if (!next) throw new Error("INVALID_TRIGGER");
    return next;
  } finally {
    job.stop();
  }
}
export function triggerDto(
  trigger: AgentTrigger & {
    deliveryConnection: Pick<
      AgentChannelConnection,
      "id" | "name" | "platform"
    > | null;
  },
) {
  return {
    id: trigger.id,
    kind: trigger.kind,
    name: trigger.name,
    enabled: trigger.enabled,
    cron: trigger.cron,
    timezone: trigger.timezone,
    prompt: trigger.prompt,
    nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
    lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
    lastStatus: trigger.lastStatus,
    lastError: trigger.lastError,
    lastConversationId: trigger.lastConversationId,
    delivery:
      trigger.deliveryConnection && trigger.deliveryChatId
        ? {
            connectionId: trigger.deliveryConnection.id,
            connectionName: trigger.deliveryConnection.name,
            platform: trigger.deliveryConnection.platform,
            chatId: trigger.deliveryChatId,
          }
        : null,
    lastDeliveryStatus: trigger.lastDeliveryStatus,
    lastDeliveryError: trigger.lastDeliveryError,
    lastDeliveryAt: trigger.lastDeliveryAt?.toISOString() ?? null,
    webhookUrl:
      trigger.kind === "webhook"
        ? `/api/v1/triggers/${trigger.id}/webhook`
        : null,
    createdAt: trigger.createdAt.toISOString(),
  };
}
/** Short run time in the trigger's own zone, e.g. "11-12 09:00". */
function triggerRunLabel(date: Date, timezone: string | null) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? "UTC",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function triggerError(error: unknown) {
  if (error instanceof Error && error.message === "TRIGGER_ACTOR_UNAVAILABLE")
    return error.message;
  return error instanceof Error
    ? (parseRuntimeFailure(error.message)?.code ?? "TRIGGER_EXECUTION_FAILED")
    : "TRIGGER_EXECUTION_FAILED";
}

async function queueTriggerDelivery(
  tx: Prisma.TransactionClient,
  scope: {
    id: string;
    workspaceId: string;
    agentId: string;
    lastConversationId: string;
  },
  text: string,
  error: string | null,
) {
  const trigger = await tx.agentTrigger.findFirst({ where: scope });
  if (!trigger?.deliveryConnectionId || !trigger.deliveryChatId) return;
  const outbound = error
    ? `Trigger "${trigger.name}" failed (${error}).`
    : text;
  const skipped = !outbound.trim() || isSilentAgentReply(outbound);
  await tx.agentTrigger.updateMany({
    where: {
      ...scope,
      deliveryConnectionId: trigger.deliveryConnectionId,
      deliveryChatId: trigger.deliveryChatId,
    },
    data: {
      lastDeliveryStatus: skipped ? "skipped" : "pending",
      lastDeliveryError: null,
      lastDeliveryAt: new Date(),
      lastDeliveryText: skipped ? null : outbound,
    },
  });
}

function logDeliveryFailure(
  trigger: Pick<
    AgentTrigger,
    "id" | "workspaceId" | "agentId" | "deliveryConnectionId"
  >,
  errorCode: string,
) {
  logSystemEvent("agent.trigger.delivery_failed", {
    domain: "agent",
    level: "warn",
    workspaceId: trigger.workspaceId,
    agentId: trigger.agentId,
    errorCode,
    attributes: {
      triggerId: trigger.id,
      channelId: trigger.deliveryConnectionId,
    },
  });
}

// The persisted queued timestamp doubles as a generation guard for overlapping runs.
export async function deliverPendingTrigger(triggerId: string) {
  let trigger: AgentTrigger | null = null;
  try {
    trigger = await db.agentTrigger.findUnique({ where: { id: triggerId } });
    if (trigger?.lastDeliveryStatus !== "pending") return;
    const current = trigger;
    const scope = {
      id: trigger.id,
      workspaceId: trigger.workspaceId,
      agentId: trigger.agentId,
      lastConversationId: trigger.lastConversationId,
      lastDeliveryAt: trigger.lastDeliveryAt,
      deliveryConnectionId: trigger.deliveryConnectionId,
      deliveryChatId: trigger.deliveryChatId,
    };
    const claimed = await db.agentTrigger.updateMany({
      where: { ...scope, lastDeliveryStatus: "pending" },
      data: { lastDeliveryStatus: "sending" },
    });
    if (!claimed.count) return;
    const finish = async (
      status: "pending" | "delivered" | "failed",
      errorCode: string | null = null,
    ) => {
      const updated = await db.agentTrigger.updateMany({
        where: { ...scope, lastDeliveryStatus: "sending" },
        data: {
          lastDeliveryStatus: status,
          lastDeliveryError: errorCode,
          ...(status === "pending"
            ? {}
            : { lastDeliveryAt: new Date(), lastDeliveryText: null }),
        },
      });
      if (updated.count && errorCode) logDeliveryFailure(current, errorCode);
    };
    const { deliveryConnectionId, deliveryChatId } = trigger;
    const connection =
      deliveryConnectionId && deliveryChatId
        ? await db.agentChannelConnection.findFirst({
            where: {
              id: deliveryConnectionId,
              workspaceId: trigger.workspaceId,
              agentId: trigger.agentId,
            },
            select: { platform: true },
          })
        : null;
    if (
      !deliveryConnectionId ||
      !deliveryChatId ||
      !connection ||
      !hostedRunnerSpec(connection.platform)
    ) {
      await finish("failed", "TRIGGER_DELIVERY_TARGET_INVALID");
      return;
    }
    const result = await sendChannelNotice(
      deliveryConnectionId,
      deliveryChatId,
      trigger.lastDeliveryText ?? "",
    );
    if (result === "unavailable") {
      if (
        !trigger.lastDeliveryAt ||
        Date.now() - trigger.lastDeliveryAt.getTime() >= 10 * 60_000
      )
        await finish("failed", "CHANNEL_UNAVAILABLE");
      else await finish("pending");
    } else if (result === "failed")
      await finish("failed", "TRIGGER_DELIVERY_FAILED");
    else await finish("delivered");
  } catch {
    // Never include outbound text, credentials, or transport exception strings.
    if (trigger) logDeliveryFailure(trigger, "TRIGGER_DELIVERY_FAILED");
    else
      logSystemEvent("agent.trigger.delivery_failed", {
        domain: "agent",
        level: "warn",
        errorCode: "TRIGGER_DELIVERY_FAILED",
        attributes: { triggerId },
      });
  }
}
export async function runAgentTrigger(
  trigger: AgentTrigger,
  payload?: unknown,
) {
  assertRuntimeOwner();
  let conversationId: string | undefined;
  try {
    try {
      await assertLocalActor(db, trigger.workspaceId, trigger.actorId);
    } catch (error) {
      if (error instanceof TaskNotFoundError)
        throw new Error("TRIGGER_ACTOR_UNAVAILABLE");
      throw error;
    }
    const prompt = trigger.prompt.replaceAll(
      "{{payload}}",
      payload === undefined ? "" : JSON.stringify(payload),
    );
    const conversation = await createConversation(
      trigger.workspaceId,
      trigger.agentId,
      `${trigger.name} · ${triggerRunLabel(new Date(), trigger.timezone)}`,
      undefined,
      async (tx, id) => {
        await tx.conversation.update({
          where: {
            id,
            agentId: trigger.agentId,
            agent: { workspaceId: trigger.workspaceId },
          },
          data: { triggerId: trigger.id },
        });
      },
    );
    if (!conversation) throw new Error("TRIGGER_EXECUTION_FAILED");
    conversationId = conversation.id;
    const message = await db.message.create({
      data: {
        conversationId,
        role: "user",
        parts: [{ type: "text", text: prompt }],
        textCharacters: prompt.length,
      },
    });
    await db.agentTrigger.update({
      where: {
        id: trigger.id,
        workspaceId: trigger.workspaceId,
        agentId: trigger.agentId,
      },
      data: {
        lastRunAt: new Date(),
        lastStatus: "running",
        lastError: null,
        lastConversationId: conversationId,
      },
    });
    await submitAgentEntry({
      kind: "trigger",
      sourceId: trigger.id,
      conversationId,
      workspaceId: trigger.workspaceId,
      agentId: trigger.agentId,
      actorId: trigger.actorId,
      messageId: message.id,
      text: prompt,
    });
    return { conversationId };
  } catch (error) {
    const code = triggerError(error);
    await db.$transaction(async (tx) => {
      await tx.agentTrigger.updateMany({
        where: {
          id: trigger.id,
          workspaceId: trigger.workspaceId,
          agentId: trigger.agentId,
        },
        data: {
          lastRunAt: new Date(),
          lastStatus: "failed",
          lastError: code,
          ...(conversationId ? { lastConversationId: conversationId } : {}),
        },
      });
      if (conversationId) {
        await tx.message.create({
          data: {
            conversationId,
            role: "assistant",
            parts: [{ type: "text", text: code }],
          },
        });
        await queueTriggerDelivery(
          tx,
          {
            id: trigger.id,
            workspaceId: trigger.workspaceId,
            agentId: trigger.agentId,
            lastConversationId: conversationId,
          },
          "",
          code,
        );
      }
    });
    if (conversationId) void deliverPendingTrigger(trigger.id);
    throw error;
  }
}
export async function settleAgentTriggerTask(row: A2ATask) {
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    grant.ancestorTaskIds.length ||
    grant.entryPolicy?.kind !== "trigger"
  )
    return;
  const entry = grant.entryPolicy;
  if (!entry.conversationId) return;
  const current = await db.a2ATask.findFirst({
    where: {
      id: row.id,
      context: { workspaceId: grant.workspaceId, agentId: grant.agentId },
    },
  });
  if (!current || !settled(current.state)) return;
  const task = Task.fromJSON(current.snapshot);
  let text: string;
  let error: string | null = null;
  try {
    text = agentEntryResult(task, "");
  } catch (cause) {
    error = triggerError(cause);
    text = error;
  }
  const succeeded = current.state === TaskState.TASK_STATE_COMPLETED;
  await db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: {
        id: entry.conversationId,
        agentId: grant.agentId,
        agent: { workspaceId: grant.workspaceId },
      },
    });
    if (!conversation) return;
    const created = await tx.message.createMany({
      skipDuplicates: true,
      data: {
        id: `trigger-result-${row.id}`,
        conversationId: conversation.id,
        role: "assistant",
        parts: [{ type: "text", text }, ...agentEntryRuntimeParts(task)],
        textCharacters: text.length,
      },
    });
    await tx.agentTrigger.updateMany({
      where: {
        id: entry.sourceId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        lastConversationId: conversation.id,
      },
      // A late settled run must not replace the latest run's result or delivery.
      data: {
        lastStatus: succeeded ? "succeeded" : "failed",
        lastError: succeeded ? null : (error ?? "TRIGGER_EXECUTION_FAILED"),
      },
    });
    if (created.count) {
      const deliveryText = succeeded
        ? task.artifacts
            .flatMap((artifact) =>
              artifact.parts.flatMap((part) =>
                part.content?.$case === "text" ? [part.content.value] : [],
              ),
            )
            .join("\n\n")
        : "";
      await queueTriggerDelivery(
        tx,
        {
          id: entry.sourceId,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
          lastConversationId: conversation.id,
        },
        deliveryText,
        succeeded ? null : (error ?? "TRIGGER_EXECUTION_FAILED"),
      );
    }
  });
  notifyTaskOutput(row.id);
  void deliverPendingTrigger(entry.sourceId);
}
const globalTriggers = globalThis as typeof globalThis & {
  __agentTriggerTimer?: NodeJS.Timeout;
};
export function startAgentTriggerScheduler() {
  if (globalTriggers.__agentTriggerTimer) return;
  let busy = false;
  let recoverSending = true;
  const tick = async () => {
    if (busy || !runtimeCanOperate()) return;
    busy = true;
    try {
      await trackRuntimeOperation(async () => {
        if (recoverSending) {
          const interrupted = await db.agentTrigger.findMany({
            where: { lastDeliveryStatus: "sending" },
          });
          for (const trigger of interrupted) {
            const updated = await db.agentTrigger.updateMany({
              where: {
                id: trigger.id,
                workspaceId: trigger.workspaceId,
                agentId: trigger.agentId,
                lastDeliveryStatus: "sending",
                lastDeliveryAt: trigger.lastDeliveryAt,
                lastConversationId: trigger.lastConversationId,
              },
              data: {
                lastDeliveryStatus: "failed",
                lastDeliveryError: "TRIGGER_DELIVERY_INTERRUPTED",
                lastDeliveryAt: new Date(),
                lastDeliveryText: null,
              },
            });
            if (updated.count)
              logDeliveryFailure(trigger, "TRIGGER_DELIVERY_INTERRUPTED");
          }
          recoverSending = false;
        }
        const pending = await db.agentTrigger.findMany({
          where: { lastDeliveryStatus: "pending" },
          orderBy: { lastDeliveryAt: "asc" },
          take: 100,
          select: { id: true },
        });
        for (const trigger of pending) {
          if (!runtimeCanOperate()) break;
          await deliverPendingTrigger(trigger.id);
        }
        // Terminal task state is durable even if shutdown interrupted message projection.
        const running = await db.agentTrigger.findMany({
          where: { lastStatus: "running", lastConversationId: { not: null } },
          take: 100,
        });
        for (const trigger of running) {
          if (trigger.lastConversationId === null) continue;
          const binding = await db.a2AEntryBinding.findFirst({
            where: {
              kind: "trigger",
              sourceId: trigger.lastConversationId,
              context: {
                workspaceId: trigger.workspaceId,
                agentId: trigger.agentId,
              },
            },
            include: { lastTask: true },
          });
          if (binding?.lastTask) await settleAgentTriggerTask(binding.lastTask);
        }
        const due = await db.agentTrigger.findMany({
          where: {
            kind: "schedule",
            enabled: true,
            nextRunAt: { lte: new Date() },
          },
          take: 20,
          orderBy: { nextRunAt: "asc" },
        });
        for (const trigger of due) {
          if (!runtimeCanOperate()) break;
          if (trigger.cron === null) continue;
          const nextRunAt = nextTriggerRun(
            trigger.cron,
            trigger.timezone ?? "UTC",
          );
          const claimed = await db.agentTrigger.updateMany({
            where: {
              id: trigger.id,
              workspaceId: trigger.workspaceId,
              agentId: trigger.agentId,
              enabled: true,
              nextRunAt: trigger.nextRunAt,
            },
            data: { nextRunAt },
          });
          if (!claimed.count) continue;
          try {
            await runAgentTrigger(trigger);
          } catch (error) {
            logSystemEvent("scheduler.triggers.admission_failed", {
              domain: "agent",
              level: "warn",
              error,
              agentId: trigger.agentId,
              workspaceId: trigger.workspaceId,
              errorCode: triggerError(error),
              attributes: { triggerId: trigger.id },
            });
          }
        }
      });
    } catch (error) {
      logSystemEvent("scheduler.triggers.tick_failed", { error });
    } finally {
      busy = false;
    }
  };
  globalTriggers.__agentTriggerTimer = setInterval(() => {
    void tick();
  }, 15_000);
  globalTriggers.__agentTriggerTimer.unref?.();
  void tick();
}
export function stopAgentTriggerScheduler() {
  clearInterval(globalTriggers.__agentTriggerTimer);
  delete globalTriggers.__agentTriggerTimer;
}
