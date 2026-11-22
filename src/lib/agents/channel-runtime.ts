import "server-only";
import { channelToolApprovalReply } from "./execution/tool-approvals";
import type { NormalizedMessagingSource } from "./messaging";
import {
  assertRuntimeOwner,
  runtimeCanOperate,
} from "@/lib/runtime/ownership-state";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/attachments/work";
import { deliverChannelReplyFiles } from "./channel-file-delivery";
import { db } from "@/lib/db";
import { logSystemEvent } from "@/lib/observability/system";
import { defineFailures } from "@/lib/errors/registry";
import { decryptChannelCredentials } from "./channel-connections";
import { hostedRunnerSpec } from "./platform-runner";
import { getMessagingPlatform, missingStartCredentialNames } from "./platforms";
import { appendAgentChannelLog } from "./channel-runtime-logs";
import { admitChannelSender } from "./channel-sender-access";
import { buildMessagingSessionKey, isSilentAgentReply } from "./messaging";
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
  type ChannelInboundFile,
  CHANNEL_EXECUTION_FAILURE_MESSAGE,
} from "./message-service";
import type {
  ChannelAdapter,
  ChannelCommandEvent,
  ChannelLogEvent,
  ChannelMessageEvent,
  ChannelStatusEvent,
  SendMessageOptions,
} from "./channels/ChannelAdapter";

const channelRuntimeFailures = defineFailures({
  CHANNEL_CONNECTION_FAILED: "Channel connection failed.",
  CHANNEL_DISCONNECTED: "Channel disconnected. Reconnecting…",
});

// Longer than every silent reply token, so a silent reply is never shown as progress.
const STREAM_MIN_CHARS = 16;

/** The final reply minus segments already sent as their own messages, matched in order. */
function undeliveredReply(reply: string, delivered: readonly string[]) {
  let position = 0;
  for (const segment of delivered) {
    const index = reply.indexOf(segment, position);
    if (index >= 0) position = index + segment.length;
  }
  return reply.slice(position).trim();
}

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
    } catch (error) {
      logSystemEvent("channel.runner.recovery_failed", {
        domain: "channel",
        channelId: channel.id,
        workspaceId: channel.workspaceId,
        error,
      });
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
): Promise<"sent" | "unavailable" | "failed"> {
  const state = runners().get(connectionId);
  if (state?.status !== "running" || !runtimeCanOperate()) return "unavailable";
  try {
    await state.adapter.sendMessage(chatId, text);
    return "sent";
  } catch {
    return "failed";
  }
}

export async function sendChannelApprovalNotice(
  connectionId: string,
  source: NormalizedMessagingSource,
  text: string,
): Promise<boolean> {
  const state = runners().get(connectionId);
  if (state?.status !== "running" || !runtimeCanOperate() || !source.chatId)
    return false;
  try {
    await state.adapter.sendMessage(source.chatId, text, {
      replyToMessageId:
        source.platform === "telegram"
          ? source.messageId && /^\d+$/.test(source.messageId)
            ? Number(source.messageId)
            : undefined
          : source.platform === "discord"
            ? source.messageId
            : (source.threadId ?? source.messageId),
      replyInThread: Boolean(source.threadId),
    });
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
  const log = (level: "info" | "warn" | "error", message: string) =>
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
        .catch((error) => {
          logSystemEvent("channel.runner.status_write_failed", {
            domain: "channel",
            channelId: connectionId,
            workspaceId,
            error,
          });
        });
    };
    adapter.on("log", (entry: ChannelLogEvent) => {
      if (current())
        log(entry.level === "error" ? "error" : "info", entry.message);
    });
    adapter.on("statusChange", (event: ChannelStatusEvent) => {
      if (!current()) return;
      active.status = event.connected ? "running" : "starting";
      if (event.error) log("error", event.error);
      update({
        status: active.status,
        lastError: event.error
          ? channelRuntimeFailures.text("CHANNEL_DISCONNECTED")
          : null,
      });
    });
    adapter.on("fatal", (message: string) => {
      if (!current()) return;
      active.cleanup();
      runners().delete(connectionId);
      void adapter.disconnect().catch(() => {});
      log("error", message);
      const error = channelRuntimeFailures.text("CHANNEL_CONNECTION_FAILED");
      void active.pendingWrite
        .then(() =>
          runners().has(connectionId)
            ? undefined
            : db.agentChannelConnection.updateMany({
                where: { id: connectionId, workspaceId },
                data: { status: "error", runnerPid: null, lastError: error },
              }),
        )
        .catch((error) => {
          logSystemEvent("channel.runner.status_write_failed", {
            domain: "channel",
            channelId: connectionId,
            workspaceId,
            error,
          });
        });
    });

    const streamingChats = new Set<string>();
    /**
     * Pumps reply segments to the adapter without blocking execution. Like
     * Hermes, text before each tool call is finalized as its own message, so
     * later text starts a new message instead of piling into one.
     */
    const channelReplyStream = (chatId: string, opts: SendMessageOptions) => {
      streamingChats.add(chatId);
      let pending: readonly string[] | null = null;
      const delivered: string[] = [];
      let sealed = 0;
      let open: string | null = null;
      let failed = false;
      let closed = false;
      let pump: Promise<void> | null = null;
      const drain = async () => {
        while (pending !== null && !failed) {
          const segments: readonly string[] = pending;
          pending = null;
          try {
            for (; sealed < segments.length - 1; sealed++) {
              const text = segments[sealed].trim();
              if (!text || isSilentAgentReply(text)) continue;
              if (
                open === null ||
                !(await adapter.onStreamSegment(chatId, text, opts))
              )
                await adapter.sendMessage(chatId, text, opts);
              open = null;
              delivered.push(text);
            }
            const last = segments.at(-1) ?? "";
            // Short text may still become a silent reply token; never show it early.
            if (last.trim().length >= STREAM_MIN_CHARS && last !== open) {
              await adapter.onTextUpdate(chatId, last, opts);
              open = last;
            }
          } catch {
            failed = true;
            log(
              "info",
              "Channel progress could not be updated; the final reply is sent separately.",
            );
          }
        }
        pump = null;
      };
      return {
        update: (segments: readonly string[]) => {
          if (closed || failed || controller.signal.aborted) return;
          pending = segments;
          pump ??= drain();
        },
        close: () => {
          closed = true;
        },
        /** Finalized segment texts and the still-open streamed text, if any. */
        settled: async () => {
          await pump;
          return { delivered, open };
        },
        release: () => streamingChats.delete(chatId),
      };
    };
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
          await adapter.sendMessage(event.chatId, admission.reply, {
            replyToMessageId: event.messageId,
          });
        else
          await adapter.sendPendingReply(
            event.chatId,
            "This command is not allowed by the channel access policy.",
            { replyToMessageId: event.messageId },
          );
        return;
      }
      const replyOptions = {
        replyToMessageId:
          row.platform === "telegram"
            ? event.messageId && /^\d+$/.test(event.messageId)
              ? Number(event.messageId)
              : undefined
            : row.platform === "discord"
              ? event.messageId
              : (event.threadId ?? event.messageId),
        replyInThread: event.replyInThread,
      };
      await adapter
        .sendTypingIndicator(event.chatId, replyOptions)
        .catch(() => {});
      const images = (event.images ?? []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      const files = (event.files ?? []).slice(
        0,
        MAX_ATTACHMENTS_PER_MESSAGE - images.length,
      );
      const inboundFiles: ChannelInboundFile[] = [
        ...images.map(({ media_type: mediaType, data }, index) => {
          const extension =
            (
              {
                "image/jpeg": "jpg",
                "image/png": "png",
                "image/gif": "gif",
                "image/webp": "webp",
              } as Record<string, string>
            )[mediaType] ?? "bin";
          return {
            filename: `image-${index + 1}.${extension}`,
            mediaType,
            data,
            size: Buffer.byteLength(data, "base64"),
          };
        }),
        ...files.map(({ filename, media_type: mediaType, data }) => ({
          filename,
          mediaType,
          data,
          size: Buffer.byteLength(data, "base64"),
        })),
      ];
      if (
        (event.images?.length ?? 0) + (event.files?.length ?? 0) >
        MAX_ATTACHMENTS_PER_MESSAGE
      )
        await adapter.sendMessage(
          event.chatId,
          "仅处理了前 5 个附件。",
          replyOptions,
        );
      // Progress is edited into one message per chat; concurrent sessions in the
      // same chat and commands keep the single final reply.
      const stream =
        !event.text.trim().startsWith("/") && !streamingChats.has(event.chatId)
          ? channelReplyStream(event.chatId, replyOptions)
          : null;
      const result = await runAgentChannelMessage({
        workspaceId,
        connectionId,
        agentId: active.agentId,
        sandboxId: active.sandboxId,
        inboundFiles,
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
        onReplySegments: stream?.update,
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
          attachments: inboundFiles.map((file, index) => ({
            type: index < images.length ? "image" : "file",
            mimeType: file.mediaType,
            name: file.filename.slice(0, 240),
            size: file.size,
          })),
        },
      })
        .catch(() => {
          if (!controller.signal.aborted)
            log("error", "Channel execution failed.");
          return null;
        })
        .finally(() => stream?.close());
      const progress = (await stream?.settled()) ?? {
        delivered: [],
        open: null,
      };
      try {
        if (!current() || controller.signal.aborted)
          throw new Error("Channel delivery interrupted.");
        if (!result || "error" in result.body) {
          if (result?.status === 413) {
            await adapter.sendMessage(
              event.chatId,
              "附件超出大小限制或存储空间不足，未处理这条消息。",
              replyOptions,
            );
            return;
          }
          if (result?.status === 403) {
            await adapter.sendPendingReply(
              event.chatId,
              "This command is not allowed by the channel access policy.",
              replyOptions,
            );
            return;
          }
          if (result && "error" in result.body)
            log(
              "error",
              `Channel execution was rejected (${result.status}): ${result.body.error}`,
            );
          if (progress.open)
            await adapter.onStreamError(
              event.chatId,
              CHANNEL_EXECUTION_FAILURE_MESSAGE,
              replyOptions,
            );
          else
            await adapter.sendMessage(
              event.chatId,
              CHANNEL_EXECUTION_FAILURE_MESSAGE,
              replyOptions,
            );
          return;
        }
        if (progress.open && result.body.failed) {
          await adapter.onStreamError(
            event.chatId,
            result.body.message,
            replyOptions,
          );
          return;
        }
        const reply =
          result.body.delivery !== "message"
            ? ""
            : result.body.failed
              ? result.body.message
              : undeliveredReply(result.body.message, progress.delivered);
        const finalOptions = {
          ...replyOptions,
          confirmation: result.body.confirmation,
        };
        // A silent final reply leaves the already visible progress unchanged.
        const handled =
          progress.open &&
          (await adapter.onStreamComplete(
            event.chatId,
            reply || progress.open,
            finalOptions,
          ));
        if (!handled && reply)
          await adapter.sendMessage(event.chatId, reply, finalOptions);
        if (
          !result.body.failed &&
          (result.body.files?.length || result.body.fallbackFilenames?.length)
        ) {
          await deliverChannelReplyFiles({
            adapter,
            chatId: event.chatId,
            workspaceId,
            files: result.body.files,
            fallbackFilenames: result.body.fallbackFilenames,
            detailUrl: result.body.detailUrl,
            options: finalOptions,
            log,
          });
        }
      } finally {
        stream?.release();
      }
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
            await adapter.sendMessage(event.chatId, decision.reply, {
              replyToMessageId: event.messageId,
            });
          else
            await adapter.sendPendingReply(
              event.chatId,
              "This command is not allowed by the channel access policy.",
              { replyToMessageId: event.messageId },
            );
          return;
        }
        const approvalReply = await channelToolApprovalReply({
          connectionId,
          workspaceId,
          agentId: active.agentId,
          source: {
            ...event,
            platform: row.platform,
            chatType: event.chatType ?? "dm",
          },
          text: event.text,
          roleIds: event.roleIds,
        });
        if (approvalReply !== null) {
          await adapter.sendMessage(event.chatId, approvalReply, {
            replyToMessageId: event.threadId ?? event.messageId,
            replyInThread: event.replyInThread,
          });
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
      })().catch(async () => {
        log("error", "Channel inbound event could not be queued or delivered.");
        await adapter
          .sendPendingReply(event.chatId, CHANNEL_EXECUTION_FAILURE_MESSAGE, {
            replyToMessageId: event.messageId,
          })
          .catch(() =>
            log("error", "Channel command failure could not be delivered."),
          );
      });
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
        .catch((error) => {
          logSystemEvent("channel.runner.heartbeat_failed", {
            domain: "channel",
            channelId: connectionId,
            workspaceId,
            error,
          });
        });
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
    logSystemEvent("channel.runner.start_failed", {
      domain: "channel",
      channelId: connectionId,
      workspaceId,
      error,
    });
    const message = channelRuntimeFailures.text("CHANNEL_CONNECTION_FAILED");
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
  const active = [...runners()];
  runners().clear();
  for (const [, runner] of active) runner.cleanup();
  await stopChannelInboundRecovery();
  await Promise.all(
    active.map(async ([channelId, runner]) => {
      // The connection closes with this process; a failed farewell request
      // (e.g. Telegram's final getUpdates) leaves nothing for the next owner.
      await runner.adapter.disconnect().catch((error: unknown) => {
        logSystemEvent("channel.runner.disconnect_failed", {
          domain: "channel",
          level: "warn",
          channelId,
          workspaceId: runner.workspaceId,
          error,
        });
      });
      await runner.pendingWrite;
    }),
  );
}
