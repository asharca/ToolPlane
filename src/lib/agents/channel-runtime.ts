import "server-only";
import {
  assertRuntimeOwner,
  runtimeCanOperate,
} from "@/lib/runtime/ownership-state";
import type { UIMessage } from "ai";
import { db } from "@/lib/db";
import { decryptChannelCredentials } from "./channel-connections";
import { hostedRunnerSpec } from "./platform-runner";
import { getMessagingPlatform, missingStartCredentialNames } from "./platforms";
import { appendAgentChannelLog } from "./channel-runtime-logs";
import { admitChannelSender } from "./channel-sender-access";
import { buildMessagingSessionKey } from "./messaging";
import {
  persistChannelInboundEvent,
  processChannelInboundQueue,
  recoverChannelInboundEvents,
  registerChannelInboundHandler,
  channelInboundDedupeKey,
  startChannelInboundRecovery,
  stopChannelInboundRecovery,
} from "./channel-inbound-queue";
import type { Prisma } from "@prisma/client";
import { getChannelSandbox } from "./channel-sandboxes";
import { createChannelAdapter } from "./channels/create-adapter";
import {
  runAgentChannelMessage,
  CHANNEL_EXECUTION_FAILURE_MESSAGE,
} from "./message-service";
import type {
  ChannelAdapter,
  ChannelCommandEvent,
  ChannelLogEvent,
  ChannelMessageEvent,
  ChannelStatusEvent,
} from "./channels/ChannelAdapter";

type RunnerState = {
  adapter: ChannelAdapter;
  workspaceId: string;
  agentId: string;
  sandboxId: string | null;
  status: "running" | "starting";
  cleanup: () => void;
  pendingWrite: Promise<unknown>;
};
declare global {
  var __toolplaneAgentChannelAdapters: Map<string, RunnerState> | undefined;
  var __toolplaneAgentChannelStarts:
    | Map<string, Promise<{ error?: string }>>
    | undefined;
}
function runners() {
  globalThis.__toolplaneAgentChannelAdapters ??= new Map();
  return globalThis.__toolplaneAgentChannelAdapters;
}
function starts() {
  globalThis.__toolplaneAgentChannelStarts ??= new Map();
  return globalThis.__toolplaneAgentChannelStarts;
}

export function liveAgentChannelStatus(
  connectionId: string,
): "running" | "starting" | "stopped" {
  return runners().get(connectionId)?.status ?? "stopped";
}

export async function reconcileAgentChannelRunners() {
  startChannelInboundRecovery();
  const channels = await db.agentChannelConnection.findMany({
    where: { status: { in: ["running", "starting"] }, agentId: { not: null } },
    select: { id: true, workspaceId: true, platform: true },
  });
  let started = 0;
  for (const channel of channels) {
    if (!hostedRunnerSpec(channel.platform)) continue;
    try {
      if (
        !(await startAgentChannelRunner(channel.workspaceId, channel.id)).error
      )
        started += 1;
    } catch {
      appendAgentChannelLog(
        channel.id,
        "error",
        "Channel could not be restored after restart.",
      );
    }
  }
  void recoverChannelInboundEvents().catch(() => {});
  return started;
}

export async function sendChannelNotice(
  connectionId: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  const state = runners().get(connectionId);
  if (state?.status !== "running" || !runtimeCanOperate()) return false;
  try {
    await state.adapter.sendMessage(chatId, text);
    return true;
  } catch {
    return false;
  }
}

export function startAgentChannelRunner(
  workspaceId: string,
  connectionId: string,
): Promise<{ error?: string }> {
  assertRuntimeOwner();
  const key = `${workspaceId}:${connectionId}`;
  const pending = starts().get(key);
  if (pending) return pending;
  const operation = start(workspaceId, connectionId).finally(() =>
    starts().delete(key),
  );
  starts().set(key, operation);
  return operation;
}

async function start(
  workspaceId: string,
  connectionId: string,
): Promise<{ error?: string }> {
  const row = await db.agentChannelConnection.findFirst({
    where: { id: connectionId, workspaceId },
  });
  if (!row) return { error: "Channel connection not found." };
  if (row.sandboxId) {
    const sandbox = await getChannelSandbox(workspaceId, row.sandboxId);
    if (!sandbox?.agentId)
      return {
        error: "Assign an Agent to this sandbox before starting the channel.",
      };
    if (row.agentId !== sandbox.agentId) {
      if (runners().has(connectionId))
        return { error: "Stop the channel before changing its sandbox Agent." };
      await db.agentChannelConnection.update({
        where: { id: row.id },
        data: { agentId: sandbox.agentId },
      });
      row.agentId = sandbox.agentId;
    }
  }
  if (!row.agentId)
    return { error: "Bind an agent before starting the channel." };
  const agent = await db.agent.findFirst({
    where: { id: row.agentId, workspaceId },
    select: { runtimeKind: true, currentRevisionVersion: true },
  });
  if (agent?.runtimeKind !== "pi-sdk" || !agent.currentRevisionVersion)
    return {
      error:
        "Historical Agents are read-only. Bind a newly authorized Pi Agent.",
    };
  if (runners().has(connectionId)) return {};
  const platform = getMessagingPlatform(row.platform);
  if (!platform || !hostedRunnerSpec(row.platform))
    return { error: "This platform has no native channel transport." };
  const credentials = decryptChannelCredentials(row.credentials);
  const secrets = platform.credentials
    .filter((field) => field.secret)
    .map((field) => credentials[field.name]);
  const log = (level: "info" | "error", message: string) =>
    appendAgentChannelLog(connectionId, level, message, secrets);
  const missing = missingStartCredentialNames(platform, credentials);
  if (missing.length) {
    const error = `Missing required credentials: ${missing.join(", ")}`;
    await db.agentChannelConnection.updateMany({
      where: { id: connectionId, workspaceId },
      data: { status: "setup_required", lastError: error },
    });
    return { error };
  }

  let state: RunnerState | undefined;
  try {
    const adapter = await createChannelAdapter({
      id: row.id,
      agentId: row.agentId,
      platform: row.platform,
      credentials,
    });
    const active: RunnerState = {
      adapter,
      workspaceId,
      agentId: row.agentId,
      sandboxId: row.sandboxId,
      status: "starting",
      cleanup: () => {},
      pendingWrite: Promise.resolve(),
    };
    state = active;
    const controller = new AbortController();
    active.cleanup = () => controller.abort();
    runners().set(connectionId, active);
    const current = () =>
      runtimeCanOperate() && runners().get(connectionId) === active;
    const update = (data: { status?: string; lastError: string | null }) => {
      active.pendingWrite = active.pendingWrite
        .then(() =>
          current()
            ? db.agentChannelConnection.updateMany({
                where: { id: connectionId, workspaceId },
                data,
              })
            : undefined,
        )
        .catch(() => {});
    };
    adapter.on("log", (entry: ChannelLogEvent) => {
      if (current())
        log(entry.level === "error" ? "error" : "info", entry.message);
    });
    adapter.on("statusChange", (event: ChannelStatusEvent) => {
      if (!current()) return;
      active.status = event.connected ? "running" : "starting";
      update({
        status: active.status,
        lastError: event.error ? log("error", event.error) : null,
      });
    });
    adapter.on("fatal", (message: string) => {
      if (!current()) return;
      active.cleanup();
      runners().delete(connectionId);
      void adapter.disconnect().catch(() => {});
      const error = log("error", message);
      void active.pendingWrite
        .then(() =>
          runners().has(connectionId)
            ? undefined
            : db.agentChannelConnection.updateMany({
                where: { id: connectionId, workspaceId },
                data: { status: "error", runnerPid: null, lastError: error },
              }),
        )
        .catch(() => {});
    });

    const processEvent = async (
      event: ChannelMessageEvent,
      dedupeKey: string,
    ) => {
      if (!current()) throw new Error("Channel runner unavailable.");
      const connection = await db.agentChannelConnection.findFirst({
        where: { id: connectionId, workspaceId },
      });
      if (!connection) return;
      const admission = await admitChannelSender({
        connection,
        credentials: decryptChannelCredentials(connection.credentials),
        source: event,
        roleIds: event.roleIds,
      });
      if (!admission.allowed) {
        if (admission.reply)
          await adapter.sendMessage(event.chatId, admission.reply);
        return;
      }
      const replyOptions = {
        replyToMessageId:
          row.platform === "telegram"
            ? event.messageId && /^\d+$/.test(event.messageId)
              ? Number(event.messageId)
              : undefined
            : (event.threadId ?? event.messageId),
        replyInThread: event.replyInThread,
      };
      await adapter
        .sendTypingIndicator(event.chatId, replyOptions)
        .catch(() => {});
      const images = (event.images ?? []).slice(0, 20);
      const files = (event.files ?? []).slice(0, 20 - images.length);
      const attachmentParts: UIMessage["parts"] = [...images, ...files].map(
        (file) => ({
          type: "file",
          mediaType: file.media_type,
          url: `data:${file.media_type};base64,${file.data}`,
          ...("filename" in file ? { filename: String(file.filename) } : {}),
        }),
      );
      const result = await runAgentChannelMessage({
        workspaceId,
        connectionId,
        agentId: active.agentId,
        sandboxId: active.sandboxId,
        attachmentParts,
        signal: controller.signal,
        inboundPersisted: true,
        inboundDedupeKey: dedupeKey,
        hostedIngress: true,
        onUiRequired: async (message) => {
          if (current() && !controller.signal.aborted)
            await adapter
              .sendMessage(event.chatId, message, replyOptions)
              .catch(() =>
                log("error", "Native UI notification could not be delivered."),
              );
        },
        rawBody: {
          message: event.text.trim() || "Attachment",
          metadata: { roleIds: event.roleIds },
          source: {
            platform: row.platform,
            chatId: event.chatId,
            userId: event.userId || undefined,
            userName: event.userName || undefined,
            messageId: event.messageId,
            chatType: event.chatType,
            threadId: event.threadId,
          },
          attachments: [
            ...images.map((image) => ({
              type: "image",
              mimeType: image.media_type,
            })),
            ...files.map((file) => ({
              type: "file",
              mimeType: file.media_type,
              name: file.filename.slice(0, 240),
              size: file.size,
            })),
          ],
        },
      }).catch(() => {
        if (!controller.signal.aborted)
          log("error", "Channel execution failed.");
        return null;
      });
      if (!current() || controller.signal.aborted)
        throw new Error("Channel delivery interrupted.");
      if (!result || "error" in result.body) {
        if (result?.status === 403) return;
        if (result && "error" in result.body)
          log(
            "error",
            `Channel execution was rejected (${result.status}): ${result.body.error}`,
          );
        await adapter.sendMessage(
          event.chatId,
          CHANNEL_EXECUTION_FAILURE_MESSAGE,
          replyOptions,
        );
        return;
      }
      if (result.body.delivery === "message")
        await adapter.sendMessage(event.chatId, result.body.message, {
          ...replyOptions,
          confirmation: result.body.confirmation,
        });
    };
    const unregister = registerChannelInboundHandler(
      connectionId,
      async (payload, dedupeKey) => {
        const saved = payload as unknown as {
          event: ChannelMessageEvent;
          agentId: string;
          sandboxId: string | null;
        };
        if (
          saved.agentId !== active.agentId ||
          saved.sandboxId !== active.sandboxId
        )
          return;
        await processEvent(saved.event, dedupeKey);
      },
    );
    const enqueue = (event: ChannelMessageEvent) => {
      void (async () => {
        if (!current()) return;
        const connection = await db.agentChannelConnection.findFirst({
          where: { id: connectionId, workspaceId },
        });
        if (!connection) return;
        const decision = await admitChannelSender({
          connection,
          credentials: decryptChannelCredentials(connection.credentials),
          source: event,
          roleIds: event.roleIds,
        });
        if (!decision.allowed) {
          if (decision.reply)
            await adapter.sendMessage(event.chatId, decision.reply);
          return;
        }
        const bounded: ChannelMessageEvent = {
          chatId: event.chatId,
          userId: event.userId,
          userName: event.userName,
          text: event.text.slice(0, 100_000),
          messageId: event.messageId,
          chatType: event.chatType,
          threadId: event.threadId,
          conversationId: event.conversationId,
          roleIds: event.roleIds,
          replyInThread: event.replyInThread,
          images: event.images?.slice(0, 20),
          files: event.files?.slice(
            0,
            Math.max(0, 20 - (event.images?.length ?? 0)),
          ),
        };
        const dedupeKey = channelInboundDedupeKey(
          event.messageId,
          bounded,
          row.platform === "telegram" ? event.chatId : undefined,
        );
        bounded.messageId ??= dedupeKey;
        const queueKey = `channel:${connectionId}:${buildMessagingSessionKey({ ...event, platform: row.platform, chatType: event.chatType ?? "dm" }, connection)}`;
        await persistChannelInboundEvent({
          connectionId,
          workspaceId,
          queueKey,
          dedupeKey,
          kind: "hosted",
          payload: JSON.parse(
            JSON.stringify({
              event: bounded,
              agentId: active.agentId,
              sandboxId: active.sandboxId,
            }),
          ) as Prisma.InputJsonValue,
        });
        await processChannelInboundQueue(connectionId, queueKey);
      })().catch(() =>
        log("error", "Channel inbound event could not be queued or delivered."),
      );
    };
    adapter.on("message", enqueue);
    adapter.on("command", (event: ChannelCommandEvent) =>
      enqueue({
        ...event,
        text: `/${event.command}${event.args ? ` ${event.args}` : ""}`,
      }),
    );
    const bindingTimer = setInterval(() => {
      void Promise.all([
        db.agentChannelConnection.findFirst({
          where: {
            id: connectionId,
            workspaceId,
            agentId: active.agentId,
            sandboxId: active.sandboxId,
          },
          select: { id: true },
        }),
        active.sandboxId
          ? getChannelSandbox(workspaceId, active.sandboxId)
          : null,
      ])
        .then(([bound, sandbox]) => {
          if (
            (!bound ||
              (active.sandboxId && sandbox?.agentId !== active.agentId)) &&
            current()
          )
            return stopAgentChannelRunner(workspaceId, connectionId);
        })
        .catch(() => {});
    }, 5000);
    bindingTimer.unref?.();
    active.cleanup = () => {
      clearInterval(bindingTimer);
      unregister();
      controller.abort();
    };
    await db.agentChannelConnection.updateMany({
      where: { id: connectionId, workspaceId },
      data: {
        status: "starting",
        lastError: null,
        runnerPid: null,
        lastStartedAt: new Date(),
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        adapter.connect(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Channel connection timed out.")),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const recoveryTimer = setInterval(() => {
      if (current())
        void recoverChannelInboundEvents(connectionId).catch(() => {});
    }, 30_000);
    recoveryTimer.unref?.();
    const cleanup = active.cleanup;
    active.cleanup = () => {
      clearInterval(recoveryTimer);
      cleanup();
    };
    void recoverChannelInboundEvents(connectionId).catch(() => {});
    await active.pendingWrite;
    return {};
  } catch (error) {
    state?.cleanup();
    if (state && runners().get(connectionId) === state)
      runners().delete(connectionId);
    await state?.adapter.disconnect().catch(() => {});
    await state?.pendingWrite;
    const message = log(
      "error",
      error instanceof Error ? error.message : "Channel connection failed.",
    );
    await db.agentChannelConnection.updateMany({
      where: { id: connectionId, workspaceId },
      data: { status: "error", runnerPid: null, lastError: message },
    });
    return { error: message };
  }
}

export async function stopAgentChannelRunner(
  workspaceId: string,
  connectionId: string,
) {
  await starts()
    .get(`${workspaceId}:${connectionId}`)
    ?.catch(() => {});
  const state = runners().get(connectionId);
  if (state?.workspaceId === workspaceId) {
    state.cleanup();
    runners().delete(connectionId);
    await state.adapter.disconnect().catch(() => {
      appendAgentChannelLog(
        connectionId,
        "error",
        "Channel disconnect failed.",
      );
    });
    await state.pendingWrite;
    appendAgentChannelLog(connectionId, "info", "Channel stopped.");
  }
  await db.agentChannelConnection.updateMany({
    where: { id: connectionId, workspaceId },
    data: { status: "stopped", runnerPid: null, lastError: null },
  });
}

export async function shutdownAgentChannelRunners() {
  // Do not write persisted channel state: running channels should resume on a clean restart.
  await Promise.allSettled([...starts().values()]);
  const active = [...runners().values()];
  runners().clear();
  for (const runner of active) runner.cleanup();
  await stopChannelInboundRecovery();
  await Promise.all(
    active.map(async (runner) => {
      await runner.adapter.disconnect();
      await runner.pendingWrite;
    }),
  );
}
