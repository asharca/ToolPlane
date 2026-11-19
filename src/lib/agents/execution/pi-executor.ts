import "server-only";
import { TaskState } from "@a2a-js/sdk";
import { runSandboxAgentTurn } from "@/lib/agents/sandbox-runtime";
import { drainRetiredPiHarnessTask } from "@/lib/agents/pi-harness";
import { A2A_LIMITS, textArtifact } from "@/lib/a2a/model";
import { assertLiveGrant } from "@/lib/a2a/principal";
import type { TaskGrant } from "@/lib/a2a/principal";
import { localTaskOptions } from "@/lib/agents/execution/task-options";
import type { TaskExecutor } from "@/lib/agents/execution/executor";
import { LOCAL_COLLABORATION_INSTRUCTIONS } from "@/lib/a2a/instructions";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "@/lib/agents/runtime-commands";
import { isLocalGrant } from "@/lib/a2a/principal";
import { workRuntimeObserver } from "@/lib/work/run-control";
import { recordTaskExecutionStage } from "@/lib/a2a/store";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import { MeteredExecutionError } from "@/lib/agents/usage";
import type { StreamRuleTrigger } from "@/lib/agents/stream-rules";
import { getLogContext } from "@/lib/observability/context";
import { db } from "@/lib/db";
import { recordTaskToolActivity } from "@/lib/agents/evolution/tool-activity";
import { settleQueuedChannelMessage } from "@/lib/agents/channel-message-queue";
import { isSilentAgentReply } from "@/lib/agents/messaging";
import type { ContextMaintenance } from "@/lib/agents/context-maintenance";
import {
  startTaskOutput,
  taskOutput,
  configureTaskOutput,
  publishTaskText,
  publishTaskActivity,
  publishTaskStage,
  publishTaskModel,
  publishTaskMessageQueue,
  resetTaskMessageOutput,
} from "./live-output";

/** Local runtime port: Task context identity, not a private Conversation or old sub-agent runner. */
export const executeLocalTask: TaskExecutor = async (row, signal) => {
  if (row.executionBackend === "pi-harness")
    return drainRetiredPiHarnessTask(row, signal);
  if (row.executionBackend !== "pi-sdk")
    throw new Error("Unknown Agent execution backend.");
  const grant = row.grant as unknown as TaskGrant;
  if (!taskOutput(row.id)?.active)
    startTaskOutput(row.id, { runtimeKind: "pi-sdk" });
  const observer =
    isLocalGrant(grant) &&
    !grant.ancestorTaskIds.length &&
    grant.entryPolicy?.kind === "work"
      ? workRuntimeObserver(grant.entryPolicy.sourceId)
      : undefined;
  const onExecutionStage = async (stage: AgentExecutionStage) => {
    await recordTaskExecutionStage(row.id, row.leaseToken, stage);
    publishTaskStage(row.id, stage);
    await observer?.onExecutionStage?.(stage);
  };
  await onExecutionStage("preparing");
  const options = await localTaskOptions(
    row,
    signal,
    LOCAL_COLLABORATION_INSTRUCTIONS,
  );
  configureTaskOutput(
    row.id,
    [options.runtimeAccessToken, ...(getLogContext()?.secrets ?? [])],
    options.modelId,
  );
  const conversation =
    options.conversationId &&
    isLocalGrant(grant) &&
    !grant.ancestorTaskIds.length
      ? await db.conversation.findFirst({
          where: {
            id: options.conversationId,
            agentId: grant.agentId,
            agent: { workspaceId: grant.workspaceId },
          },
          select: { id: true, runtimeSessionKey: true },
        })
      : null;
  let commands: RuntimeCommand[] = [];
  let usage: RuntimeUsage | undefined;
  let commandResult: RuntimeCommandResult | undefined;
  const streamRuleTriggers: StreamRuleTrigger[] = [];
  const contextMaintenance: ContextMaintenance[] = [];
  let text: string;
  let queuedReplyText = "";
  try {
    text = await runSandboxAgentTurn({
      ...options,
      ...(conversation && isLocalGrant(grant)
        ? {
            messageQueue: {
              authorize: async () => {
                await assertLiveGrant(grant, "send");
              },
              workspaceId: grant.workspaceId,
              agentId: grant.agentId,
              conversationId: conversation.id,
              actorId: grant.actorId,
              taskId: row.id,
              channelId:
                grant.entryPolicy?.kind === "channel"
                  ? grant.entryPolicy.channelId
                  : undefined,
              sessionKey: conversation.runtimeSessionKey,
            },
          }
        : {}),
      onMessageQueue: async (queue) => {
        publishTaskMessageQueue(row.id, queue);
        await observer?.onMessageQueue?.(queue);
      },
      onQueuedMessage: async (message, assistantText) => {
        if (!conversation) throw new Error("Queued conversation unavailable.");
        await assertLiveGrant(grant, "send");
        if (assistantText && !isSilentAgentReply(assistantText))
          queuedReplyText += `${queuedReplyText ? "\n\n" : ""}${assistantText}`;
        await observer?.onQueuedMessage?.(message, assistantText);
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id=${conversation.id} FOR UPDATE`;
          const previous = await tx.message.findFirst({
            where: { conversationId: conversation.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { createdAt: true },
          });
          let timestamp = Math.max(
            Date.now(),
            (previous?.createdAt.getTime() ?? 0) + 1,
          );
          if (!observer && assistantText)
            await tx.message.create({
              data: {
                conversationId: conversation.id,
                role: "assistant",
                createdAt: new Date(timestamp++),
                parts: [{ type: "text", text: assistantText }],
              },
            });
          await tx.message.upsert({
            where: { id: `queued-message-${message.id}` },
            update: {},
            create: {
              id: `queued-message-${message.id}`,
              conversationId: conversation.id,
              role: "user",
              createdAt: new Date(timestamp),
              parts: [
                { type: "text", text: message.text },
                {
                  type: "data-agent-queued-message",
                  data: { id: message.id, mode: message.mode, taskId: row.id },
                },
              ],
            },
          });
          if (isLocalGrant(grant) && grant.entryPolicy?.kind === "channel") {
            const channelId = grant.entryPolicy.channelId;
            if (!channelId)
              throw new Error("Queued channel identity unavailable.");
            await settleQueuedChannelMessage(
              tx,
              message.id,
              channelId,
              conversation.id,
            );
          }
        });
        resetTaskMessageOutput(row.id);
      },
      onTextDelta: async (delta) => {
        publishTaskText(row.id, delta);
        await observer?.onTextDelta?.(delta);
      },
      onActivity: async (activity) => {
        publishTaskActivity(row.id, activity);
        if (isLocalGrant(grant)) {
          await recordTaskToolActivity(db, grant, row.id, activity);
        }
        await observer?.onActivity?.(activity);
      },
      onExecutionStage,
      onModelSelected: ({ model }) => publishTaskModel(row.id, model),
      onContextUsage: observer?.onContextUsage,
      onStreamRule: async (trigger) => {
        streamRuleTriggers.push(trigger);
        await observer?.onStreamRule?.(trigger);
      },
      onCommands: async (value) => {
        commands = value;
        await observer?.onCommands?.(value);
      },
      onUsage: async (value) => {
        usage = value;
        await observer?.onUsage?.(value);
      },
      onCommandResult: async (value) => {
        commandResult = value;
        await observer?.onCommandResult?.(value);
      },
      onContextMaintenance: async (marker) => {
        contextMaintenance.push(marker);
        await observer?.onContextMaintenance?.(marker);
      },
    });
    signal.throwIfAborted();
    await assertLiveGrant(grant, "send");
    if (text.length + queuedReplyText.length > A2A_LIMITS.outputCharacters)
      throw new Error("Task output limit exceeded.");
  } catch (error) {
    if (usage)
      throw new MeteredExecutionError(error, {
        usage,
        model: usage.actualModel?.model ?? options.modelId,
        providerId: usage.actualModel?.providerId ?? options.provider.id,
      });
    throw error;
  }
  const artifact = textArtifact(text);
  artifact.metadata = {
    toolplanePiSdk: {
      commands,
      streamRuleTriggers,
      model: usage?.actualModel ?? {
        providerId: options.provider.id,
        model: options.modelId,
      },
      ...(usage ? { usage } : {}),
      ...(commandResult ? { commandResult } : {}),
      ...(contextMaintenance.length ? { contextMaintenance } : {}),
    },
    ...(queuedReplyText ? { toolplaneQueuedReplyText: queuedReplyText } : {}),
  };
  return { state: TaskState.TASK_STATE_COMPLETED, artifact };
};
