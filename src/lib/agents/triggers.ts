import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Cron } from "croner";
import { Task, TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import type { A2ATask, AgentTrigger } from "@prisma/client";
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
export function triggerDto(trigger: AgentTrigger) {
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
    webhookUrl:
      trigger.kind === "webhook"
        ? `/api/v1/triggers/${trigger.id}/webhook`
        : null,
    createdAt: trigger.createdAt.toISOString(),
  };
}
function triggerError(error: unknown) {
  if (error instanceof Error && error.message === "TRIGGER_ACTOR_UNAVAILABLE")
    return error.message;
  return error instanceof Error
    ? (parseRuntimeFailure(error.message)?.code ?? "TRIGGER_EXECUTION_FAILED")
    : "TRIGGER_EXECUTION_FAILED";
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
      `${trigger.name} · ${new Date().toISOString()}`,
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
      where: { id: trigger.id },
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
    await db.agentTrigger.updateMany({
      where: { id: trigger.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: "failed",
        lastError: code,
        ...(conversationId ? { lastConversationId: conversationId } : {}),
      },
    });
    if (conversationId)
      await db.message.create({
        data: {
          conversationId,
          role: "assistant",
          parts: [{ type: "text", text: code }],
        },
      });
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
  const current = await db.a2ATask.findUnique({ where: { id: row.id } });
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
    const conversation = await tx.conversation.findUnique({
      where: { id: entry.conversationId },
    });
    if (!conversation) return;
    await tx.message.upsert({
      where: { id: `trigger-result-${row.id}` },
      create: {
        id: `trigger-result-${row.id}`,
        conversationId: conversation.id,
        role: "assistant",
        parts: [{ type: "text", text }, ...agentEntryRuntimeParts(task)],
        textCharacters: text.length,
      },
      update: {},
    });
    await tx.agentTrigger.updateMany({
      where: { id: entry.sourceId, lastConversationId: conversation.id },
      data: {
        lastStatus: succeeded ? "succeeded" : "failed",
        lastError: succeeded ? null : (error ?? "TRIGGER_EXECUTION_FAILED"),
      },
    });
  });
  notifyTaskOutput(row.id);
}
const globalTriggers = globalThis as typeof globalThis & {
  __agentTriggerTimer?: NodeJS.Timeout;
};
export function startAgentTriggerScheduler() {
  if (globalTriggers.__agentTriggerTimer) return;
  let busy = false;
  const tick = async () => {
    if (busy || !runtimeCanOperate()) return;
    busy = true;
    try {
      await trackRuntimeOperation(async () => {
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
