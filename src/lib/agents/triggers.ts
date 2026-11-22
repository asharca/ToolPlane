import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Cron } from "croner";
import { Task, TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import {
  Prisma,
  type A2ATask,
  type AgentTrigger,
  type AgentTriggerEvent,
  type AgentChannelConnection,
} from "@prisma/client";
import { db } from "@/lib/db";
import { assertLocalActor } from "@/lib/a2a/local-policy";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { settled } from "@/lib/a2a/model";
import { createConversation } from "./conversation-mutations";
import {
  submitAgentEntry,
  agentEntryResult,
  agentEntryRuntimeParts,
  artifactReplyText,
} from "./execution/entries";
import { decryptSecretText } from "@/lib/security/secrets";
import { postGithubComment, type GithubReplyResult } from "./trigger-webhooks";
import { parseRuntimeFailure } from "./runtime-failure";
import { appendBudgetWarningText } from "./budget-warning";
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
    webhook:
      trigger.kind === "webhook"
        ? {
            url: `/api/v1/triggers/${trigger.id}/webhook`,
            auth: trigger.webhookAuth,
            ignoredSenders: trigger.webhookIgnoredSenders,
            replyEnabled:
              trigger.webhookAuth === "github" && !!trigger.webhookReplyToken,
          }
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
export function triggerPrompt(
  trigger: Pick<AgentTrigger, "prompt">,
  payload?: unknown,
  event = "",
) {
  return trigger.prompt
    .replaceAll("{{payload}}", () =>
      payload === undefined ? "" : JSON.stringify(payload),
    )
    .replaceAll("{{event}}", () => event);
}
export async function runAgentTrigger(
  trigger: AgentTrigger,
  input?: { prompt: string; conversationId?: string },
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
    const prompt = input?.prompt ?? triggerPrompt(trigger);
    if (input?.conversationId) conversationId = input.conversationId;
    else {
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
    }
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
    const accepted = await submitAgentEntry({
      kind: "trigger",
      sourceId: trigger.id,
      conversationId,
      workspaceId: trigger.workspaceId,
      agentId: trigger.agentId,
      actorId: trigger.actorId,
      messageId: message.id,
      text: prompt,
    });
    return { conversationId, taskId: accepted.row.id };
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

const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const UNSUBMITTED_EVENT_MS = 5 * 60_000;

export type TriggerEventStatus = "queued" | "running" | "duplicate";

/** Records one webhook delivery; a reused dedupe key returns the original outcome. */
export async function acceptTriggerEvent(
  trigger: AgentTrigger,
  input: { dedupeKey: string; threadKey: string | null; prompt: string },
): Promise<{ status: TriggerEventStatus; conversationId: string | null }> {
  assertRuntimeOwner();
  let event: AgentTriggerEvent;
  try {
    event = await db.agentTriggerEvent.create({
      data: { triggerId: trigger.id, ...input, status: "queued" },
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    )
      throw error;
    const existing = await db.agentTriggerEvent.findUniqueOrThrow({
      where: {
        triggerId_dedupeKey: {
          triggerId: trigger.id,
          dedupeKey: input.dedupeKey,
        },
      },
      select: { conversationId: true },
    });
    return { status: "duplicate", conversationId: existing.conversationId };
  }
  await db.agentTriggerEvent.deleteMany({
    where: {
      triggerId: trigger.id,
      status: { in: ["done", "failed"] },
      createdAt: { lt: new Date(Date.now() - EVENT_RETENTION_MS) },
    },
  });
  if (input.threadKey === null) {
    await db.agentTriggerEvent.update({
      where: { id: event.id },
      data: { status: "running" },
    });
    const started = await startTriggerEvent(trigger, event);
    return { status: "running", conversationId: started };
  }
  await dispatchTriggerThread(trigger, input.threadKey);
  const current = await db.agentTriggerEvent.findUniqueOrThrow({
    where: { id: event.id },
    select: { status: true, conversationId: true },
  });
  return {
    status: current.status === "queued" ? "queued" : "running",
    conversationId: current.conversationId,
  };
}

async function threadConversation(trigger: AgentTrigger, threadKey: string) {
  const where = {
    triggerId_threadKey: { triggerId: trigger.id, threadKey },
  };
  const found = await db.agentTriggerThread.findUnique({ where });
  if (found) return found.conversationId;
  const conversation = await createConversation(
    trigger.workspaceId,
    trigger.agentId,
    `${trigger.name} · ${threadKey}`.slice(0, 200),
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
      await tx.agentTriggerThread.create({
        data: { triggerId: trigger.id, threadKey, conversationId: id },
      });
    },
  );
  if (!conversation) throw new Error("TRIGGER_EXECUTION_FAILED");
  return conversation.id;
}

/** Starts a claimed (running) event; failures settle the event and never throw. */
async function startTriggerEvent(
  trigger: AgentTrigger,
  event: { id: string; threadKey: string | null; prompt: string },
) {
  let conversationId: string | undefined;
  try {
    if (event.threadKey !== null)
      conversationId = await threadConversation(trigger, event.threadKey);
    const started = await runAgentTrigger(trigger, {
      prompt: event.prompt,
      conversationId,
    });
    await db.agentTriggerEvent.updateMany({
      where: { id: event.id, status: "running" },
      data: { conversationId: started.conversationId, taskId: started.taskId },
    });
    return started.conversationId;
  } catch (error) {
    const code = triggerError(error);
    const failed = await db.agentTriggerEvent.updateMany({
      where: { id: event.id, status: "running" },
      data: {
        status: "failed",
        error: code,
        ...(conversationId ? { conversationId } : {}),
        ...replyFields(trigger, event, "", code),
      },
    });
    if (failed.count) void sendTriggerReply(event.id).catch(() => {});
    if (event.threadKey !== null)
      void dispatchTriggerThread(trigger, event.threadKey).catch(() => {});
    return conversationId ?? null;
  }
}

/** Starts the oldest queued event of one thread when none of its events is running. */
export async function dispatchTriggerThread(
  trigger: AgentTrigger,
  threadKey: string,
) {
  const claimed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${trigger.id}), hashtext(${threadKey}))`;
    const where = { triggerId: trigger.id, threadKey };
    if (
      await tx.agentTriggerEvent.count({
        where: { ...where, status: "running" },
      })
    )
      return null;
    const next = await tx.agentTriggerEvent.findFirst({
      where: { ...where, status: "queued" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!next) return null;
    await tx.agentTriggerEvent.update({
      where: { id: next.id },
      data: { status: "running" },
    });
    return next;
  });
  if (claimed) await startTriggerEvent(trigger, claimed);
}

/** Closes events whose task settled and starts each thread's next queued event. */
async function completeTriggerEvents(
  where: Prisma.AgentTriggerEventWhereInput,
) {
  const events = await db.agentTriggerEvent.findMany({
    where: { ...where, status: "running" },
    include: { trigger: true },
    take: 100,
  });
  for (const event of events) {
    let status: "done" | "failed" | null = null;
    let error: string | null = null;
    let reply = "";
    if (event.taskId) {
      const task = await db.a2ATask.findUnique({
        where: { id: event.taskId },
        select: { state: true, snapshot: true },
      });
      if (!task || settled(task.state)) {
        status =
          task?.state === TaskState.TASK_STATE_COMPLETED ? "done" : "failed";
        if (status === "failed") error = "TRIGGER_EXECUTION_FAILED";
        else if (task)
          reply = artifactReplyText(Task.fromJSON(task.snapshot), false);
      }
    } else if (Date.now() - event.updatedAt.getTime() >= UNSUBMITTED_EVENT_MS) {
      status = "failed";
      error = "TRIGGER_EXECUTION_INTERRUPTED";
    }
    if (!status) continue;
    const closed = await db.agentTriggerEvent.updateMany({
      where: { id: event.id, status: "running", updatedAt: event.updatedAt },
      data: {
        status,
        error,
        ...replyFields(event.trigger, event, reply, error),
      },
    });
    if (closed.count) void sendTriggerReply(event.id).catch(() => {});
    if (closed.count && event.threadKey !== null && event.trigger.enabled)
      await dispatchTriggerThread(event.trigger, event.threadKey);
  }
}

/** A GitHub-mode thread with a reply token gets one comment per settled event. */
function replyFields(
  trigger: AgentTrigger,
  event: { threadKey: string | null },
  text: string,
  error: string | null,
) {
  if (
    trigger.webhookAuth !== "github" ||
    !trigger.webhookReplyToken ||
    event.threadKey === null
  )
    return {};
  const body = error
    ? `ToolPlane trigger "${trigger.name}" failed (${error}).`
    : text.trim();
  return !body || isSilentAgentReply(body)
    ? { replyStatus: "skipped", replyAt: new Date() }
    : { replyStatus: "pending", replyText: body, replyAt: new Date() };
}

// Measured from the event's acceptance; transient GitHub failures retry within it.
const REPLY_RETRY_MS = 60 * 60_000;

/** Claims one pending reply and posts it; only fixed error codes are persisted. */
export async function sendTriggerReply(eventId: string) {
  const event = await db.agentTriggerEvent.findUnique({
    where: { id: eventId },
    include: { trigger: true },
  });
  if (event?.replyStatus !== "pending" || !event.replyText || !event.threadKey)
    return;
  const claimed = await db.agentTriggerEvent.updateMany({
    where: { id: event.id, replyStatus: "pending", replyAt: event.replyAt },
    data: { replyStatus: "sending" },
  });
  if (!claimed.count) return;
  let result: GithubReplyResult = {
    status: "failed",
    code: "GITHUB_REPLY_UNAVAILABLE",
  };
  try {
    if (
      event.trigger.webhookAuth === "github" &&
      event.trigger.webhookReplyToken
    )
      result = await postGithubComment(
        decryptSecretText(event.trigger.webhookReplyToken),
        event.threadKey,
        event.replyText,
      );
  } catch {
    result = { status: "failed", code: "GITHUB_REPLY_FAILED" };
  }
  const expired =
    !event.replyAt || Date.now() - event.createdAt.getTime() >= REPLY_RETRY_MS;
  const next =
    result.status === "sent"
      ? { replyStatus: "sent", replyText: null, replyError: null }
      : result.status === "retry" && !expired
        ? { replyStatus: "pending" }
        : {
            replyStatus: "failed",
            replyText: null,
            replyError:
              result.status === "failed" ? result.code : "GITHUB_REPLY_FAILED",
          };
  await db.agentTriggerEvent.updateMany({
    where: { id: event.id, replyStatus: "sending" },
    data: { ...next, replyAt: new Date() },
  });
  if (next.replyStatus === "failed")
    logSystemEvent("agent.trigger.reply_failed", {
      domain: "agent",
      level: "warn",
      workspaceId: event.trigger.workspaceId,
      agentId: event.trigger.agentId,
      errorCode: next.replyError ?? undefined,
      attributes: { triggerId: event.triggerId },
    });
}

/** Scheduler recovery: settle interrupted events and restart idle threads. */
async function recoverTriggerEvents() {
  await completeTriggerEvents({});
  // A reply interrupted mid-send is retried; GitHub may then show it twice.
  await db.agentTriggerEvent.updateMany({
    where: {
      replyStatus: "sending",
      replyAt: { lte: new Date(Date.now() - 2 * 60_000) },
    },
    data: { replyStatus: "pending" },
  });
  const replies = await db.agentTriggerEvent.findMany({
    where: {
      replyStatus: "pending",
      replyAt: { lte: new Date(Date.now() - 30_000) },
    },
    orderBy: { replyAt: "asc" },
    take: 50,
    select: { id: true },
  });
  for (const reply of replies) {
    if (!runtimeCanOperate()) break;
    await sendTriggerReply(reply.id);
  }
  const queued = await db.agentTriggerEvent.findMany({
    where: {
      status: "queued",
      threadKey: { not: null },
      trigger: { enabled: true },
    },
    distinct: ["triggerId", "threadKey"],
    include: { trigger: true },
    take: 100,
  });
  for (const event of queued) {
    if (!runtimeCanOperate()) break;
    if (event.threadKey !== null)
      await dispatchTriggerThread(event.trigger, event.threadKey);
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
    text = await appendBudgetWarningText(agentEntryResult(task, ""), {
      workspaceId: grant.workspaceId,
      agentId: grant.agentId,
      taskId: row.id,
    });
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
      const deliveryText = succeeded ? text : "";
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
  try {
    await completeTriggerEvents({ taskId: row.id });
  } catch (error) {
    logSystemEvent("agent.trigger.event_dispatch_failed", {
      domain: "agent",
      level: "warn",
      error,
      workspaceId: grant.workspaceId,
      agentId: grant.agentId,
      attributes: { triggerId: entry.sourceId },
    });
  }
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
        await recoverTriggerEvents();
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
          const [claimed] = await db.agentTrigger.updateManyAndReturn({
            where: {
              id: trigger.id,
              workspaceId: trigger.workspaceId,
              agentId: trigger.agentId,
              enabled: true,
              nextRunAt: trigger.nextRunAt,
              updatedAt: trigger.updatedAt,
            },
            data: { nextRunAt },
          });
          if (!claimed) continue;
          try {
            await runAgentTrigger(claimed);
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
