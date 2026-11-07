import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { admitChannelSender } from "./channel-sender-access";
import { buildMessagingSessionKey } from "./messaging";
import {
  channelConversationIds,
  assertChannelConversationIdle,
} from "./conversation-operations";
import {
  upgradeAgentConversationRevision,
  AgentConversationRevisionError,
} from "./conversation-revisions";
import { resolveAgentModelOverride } from "./turn-model";
import {
  persistChannelInboundEvent,
  processChannelInboundQueue,
  channelInboundDedupeKey,
  ChannelInboundConflictError,
} from "./channel-inbound-queue";
import {
  runAgentEntry,
  latestEntryText,
  agentEntryResult,
  agentEntryRuntimeParts,
} from "./execution/entries";
import type { NormalizedMessagingSource } from "./messaging";
import type { AgentForRun } from "./queries";
import { getAgent, getAgentForRequest } from "./queries";
import { createConversation } from "./mutations";
import { parseAgentMessageBody, type AgentMessageBody } from "./chat-body";
import { isSilentAgentReply, normalizeAgentMessageEvent } from "./messaging";
import {
  decryptChannelCredentials,
  touchAgentChannelEvent,
} from "./channel-connections";
import { getChannelSandbox } from "./channel-sandboxes";
import {
  acquireConversationOperation,
  waitForConversationOperation,
  ConversationOperationError,
  rotateChannelConversation,
} from "./conversation-operations";
import {
  executeRuntimeCommand,
  RuntimeCommandError,
} from "./runtime-command-service";
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
} from "./runtime-commands";
import { AgentRevisionError, resolvePinnedAgent } from "./revisions";
import { persistAgentPromptInvocation } from "./prompt-invocation";
import { parseRuntimeFailure } from "./runtime-failure";
import { notifyTaskOutput, taskOutput } from "./execution/live-output";

export const CHANNEL_EXECUTION_FAILURE_MESSAGE =
  "本次执行未能完成，未自动重试。请在工作区查看会话执行状态，检查模型或工具连接后再发送新消息。";

export type AgentMessageResult =
  | { status: number; body: { error: string } }
  | {
      status: 200;
      body: {
        agentId: string;
        conversationId: string;
        delivery: "message" | "silent";
        message: string;
        rawMessage: string;
        sessionKey: string;
        source: NormalizedMessagingSource;
        platform: string;
        externalUserId: string | null;
        channelId: string | null;
        confirmation?: { command: "new" | "upgrade"; token: string };
      };
    };

const ChannelCommandResultSchema: z.ZodType<AgentMessageResult> = z.union([
  z.object({ status: z.number(), body: z.object({ error: z.string() }) }),
  z.object({
    status: z.literal(200),
    body: z.object({
      agentId: z.string(),
      conversationId: z.string(),
      delivery: z.enum(["message", "silent"]),
      message: z.string(),
      rawMessage: z.string(),
      sessionKey: z.string(),
      platform: z.string(),
      externalUserId: z.string().nullable(),
      channelId: z.string().nullable(),
      source: z.object({
        platform: z.string(),
        chatType: z.enum(["dm", "group", "channel", "thread"]),
        chatId: z.string().optional(),
        chatName: z.string().optional(),
        userId: z.string().optional(),
        userName: z.string().optional(),
        threadId: z.string().optional(),
        parentChatId: z.string().optional(),
        scopeId: z.string().optional(),
        messageId: z.string().optional(),
      }),
      confirmation: z
        .object({ command: z.enum(["new", "upgrade"]), token: z.string() })
        .optional(),
    }),
  }),
]);

export async function runAgentMessage(params: {
  agentId: string;
  userId: string;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
}): Promise<AgentMessageResult> {
  const agent = await getAgentForRequest(params.agentId, params.userId);
  if (!agent) return { status: 404, body: { error: "Agent not found" } };
  return runLoadedAgentMessage({
    agent,
    actorId: params.userId,
    rawBody: params.rawBody,
    defaults: params.defaults,
  });
}

export async function runWorkspaceAgentMessage(params: {
  userId?: string;
  workspaceId: string;
  agentId: string;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
}): Promise<AgentMessageResult> {
  const agent = await getAgent(params.workspaceId, params.agentId);
  if (!agent) return { status: 404, body: { error: "Agent not found" } };
  return runLoadedAgentMessage({
    agent,
    actorId: params.userId,
    rawBody: params.rawBody,
    defaults: params.defaults,
  });
}

export async function runAgentChannelMessage(params: {
  connectionId: string;
  workspaceId: string;
  agentId: string | null;
  sandboxId?: string | null;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
  attachmentParts?: UIMessage["parts"];
  signal?: AbortSignal;
  onUiRequired?: (message: string) => Promise<void>;
  inboundPersisted?: boolean;
  hostedIngress?: boolean;
  inboundDedupeKey?: string;
  legacySessionKey?: string;
}): Promise<AgentMessageResult> {
  params.signal?.throwIfAborted();
  const channel = await db.agentChannelConnection.findFirst({
    where: {
      id: params.connectionId,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      sandboxId: params.sandboxId,
    },
  });
  if (!channel) return { status: 404, body: { error: "Channel not found" } };
  if (!params.agentId)
    return { status: 409, body: { error: "Channel has no bound agent" } };
  if (channel.sandboxId) {
    const sandbox = await getChannelSandbox(
      params.workspaceId,
      channel.sandboxId,
    );
    if (sandbox?.agentId !== params.agentId)
      return {
        status: 409,
        body: {
          error: "Channel sandbox binding changed. Restart the channel.",
        },
      };
  }
  if (!["running", "starting", "waiting_callback"].includes(channel.status))
    return { status: 409, body: { error: "Channel is stopped" } };
  const body = parseAgentMessageBody(params.rawBody);
  if (!body) return { status: 400, body: { error: "Bad request" } };
  body.source = { ...body.source, platform: channel.platform };
  const event = normalizeAgentMessageEvent(body);
  const decision = await admitChannelSender({
    connection: channel,
    credentials: decryptChannelCredentials(channel.credentials),
    source: event.source,
    roleIds: body.metadata?.roleIds,
  });
  if (!decision.allowed) {
    if (!decision.reply)
      return { status: 403, body: { error: "Sender or chat is not allowed" } };
    return {
      status: 200,
      body: {
        agentId: params.agentId,
        conversationId: "",
        delivery: "message",
        message: decision.reply,
        rawMessage: decision.reply,
        sessionKey: "",
        source: event.source,
        platform: channel.platform,
        externalUserId: event.source.userId ?? null,
        channelId: event.source.chatId ?? null,
      },
    };
  }
  // A command's receipt commits with its mutation, before hosted reply delivery.
  if (params.inboundPersisted && params.inboundDedupeKey) {
    const inbound = await db.agentChannelInboundEvent.findFirst({
      where: {
        connectionId: channel.id,
        dedupeKey: params.inboundDedupeKey,
        connection: {
          workspaceId: params.workspaceId,
          agentId: params.agentId,
        },
      },
      select: { payload: true },
    });
    const payload = inbound?.payload;
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.result
    )
      return ChannelCommandResultSchema.parse(payload.result);
  }
  const agent = await getAgent(params.workspaceId, params.agentId);
  if (!agent) return { status: 404, body: { error: "Agent not found" } };
  if (agent.runtimeKind !== "pi-sdk")
    return {
      status: 410,
      body: {
        error: "Historical Agents are read-only. Create a new Pi Agent.",
      },
    };
  if (!channel.a2aActorId)
    return {
      status: 409,
      body: {
        error:
          "Channel execution identity is unavailable. Re-enable the channel to bind your account.",
      },
    };
  let sessionKey = `channel:${channel.id}:${buildMessagingSessionKey(event.source, channel)}`;
  const canonicalSessionKey = sessionKey;
  let ids = await channelConversationIds(
    agent.id,
    params.workspaceId,
    sessionKey,
    11,
  );
  if (!ids.length) {
    const legacySource = params.hostedIngress
      ? {
          ...event.source,
          chatType: "dm" as const,
          threadId:
            event.source.platform === "feishu" && event.source.threadId
              ? `thread:${event.source.threadId}`
              : undefined,
        }
      : event.source;
    const legacyKey = `channel:${channel.id}:${!params.hostedIngress && params.legacySessionKey ? params.legacySessionKey : buildMessagingSessionKey(legacySource)}`;
    if (legacyKey !== sessionKey) {
      const legacyIds = await channelConversationIds(
        agent.id,
        params.workspaceId,
        legacyKey,
        11,
      );
      if (legacyIds.length) {
        sessionKey = legacyKey;
        ids = legacyIds;
      }
    }
  }
  if (
    body.conversationId &&
    !(await db.conversation.count({
      where: {
        id: body.conversationId,
        agentId: agent.id,
        agent: { workspaceId: params.workspaceId },
        runtimeSessionKey: sessionKey,
      },
    }))
  )
    return { status: 404, body: { error: "Conversation not found" } };
  if (!params.inboundPersisted) {
    const normalizedBody = {
      message: body.message,
      conversationId: body.conversationId,
      messageType: body.messageType,
      source: event.source,
      attachments: body.attachments.map(
        ({ type, url, name, mimeType, size }) => ({
          type,
          url,
          name,
          mimeType,
          size,
        }),
      ),
      metadata: {
        roleIds: Array.isArray(body.metadata?.roleIds)
          ? body.metadata.roleIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      },
    };
    const dedupeKey = channelInboundDedupeKey(
      event.source.messageId,
      normalizedBody,
      channel.platform === "telegram" ? event.source.chatId : undefined,
    );
    normalizedBody.source.messageId ??= dedupeKey;
    const saved = await persistChannelInboundEvent({
      connectionId: channel.id,
      workspaceId: channel.workspaceId,
      queueKey: sessionKey,
      dedupeKey,
      kind: "callback",
      payload: JSON.parse(
        JSON.stringify({
          body: normalizedBody,
          dedupeKey,
          hostedIngress: Boolean(params.hostedIngress),
          legacySessionKey: params.legacySessionKey,
          workspaceId: channel.workspaceId,
          agentId: channel.agentId,
          sandboxId: channel.sandboxId,
        }),
      ) as Prisma.InputJsonValue,
    }).catch((error: unknown) => {
      if (error instanceof ChannelInboundConflictError) return null;
      throw error;
    });
    if (!saved)
      return {
        status: 400,
        body: {
          error: "Channel message ID was reused with different content.",
        },
      };
    const observerKey = `${channel.id}:${dedupeKey}`;
    const observer = {
      signal: params.signal,
      onUiRequired: params.onUiRequired,
      attachmentParts: params.attachmentParts,
    };
    if (!callbackObservers.has(observerKey))
      callbackObservers.set(observerKey, observer);
    try {
      await processChannelInboundQueue(channel.id, saved.event.queueKey);
    } finally {
      if (callbackObservers.get(observerKey) === observer)
        callbackObservers.delete(observerKey);
    }
    params.signal?.throwIfAborted();
    const completed = await db.agentChannelInboundEvent.findUniqueOrThrow({
      where: { id: saved.event.id },
    });
    const payload = completed.payload as { result?: AgentMessageResult };
    if (payload.result) return payload.result;
    return {
      status: 409,
      body: { error: "Channel message is queued for delivery." },
    };
  }
  const command = body.message
    .trim()
    .match(/^\/([a-z][a-z0-9_:-]{0,99})(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command) {
    const enteredName = command[1];
    const name = enteredName.toLowerCase();
    const args = command[2]?.trim() ?? "";
    const prior = ids[0]
      ? await db.conversation.findFirst({
          where: {
            id: ids[0],
            agentId: agent.id,
            agent: { workspaceId: params.workspaceId },
          },
          include: {
            messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
            agentRevision: { select: { version: true } },
          },
        })
      : null;
    let conversationId = prior?.id ?? "";
    let message: string;
    let confirmation: { command: "new" | "upgrade"; token: string } | undefined;
    let atomicResult: AgentMessageResult | undefined;
    const commandResult = (
      text: string,
      selectedId = conversationId,
      selectedKey = sessionKey,
    ): AgentMessageResult => ({
      status: 200,
      body: {
        agentId: agent.id,
        conversationId: selectedId,
        delivery: "message",
        message: text,
        rawMessage: text,
        sessionKey: selectedKey,
        source: event.source,
        platform: channel.platform,
        externalUserId: event.source.userId ?? null,
        channelId: event.source.chatId ?? null,
        ...(confirmation ? { confirmation } : {}),
      },
    });
    const rememberResult = async (
      tx: Prisma.TransactionClient,
      result: AgentMessageResult,
    ) => {
      if (!params.inboundDedupeKey) return;
      const inbound = await tx.agentChannelInboundEvent.findFirstOrThrow({
        where: {
          connectionId: channel.id,
          dedupeKey: params.inboundDedupeKey,
          connection: { workspaceId: params.workspaceId, agentId: agent.id },
        },
      });
      if (
        !inbound.payload ||
        typeof inbound.payload !== "object" ||
        Array.isArray(inbound.payload)
      )
        throw new Error("Invalid channel inbound payload.");
      await tx.agentChannelInboundEvent.update({
        where: { id: inbound.id },
        data: {
          payload: JSON.parse(
            JSON.stringify({ ...inbound.payload, result }),
          ) as Prisma.InputJsonValue,
        },
      });
      atomicResult = result;
    };
    const adminOnly = name === "model" || name === "upgrade";
    if (adminOnly && decision.role !== "admin") {
      message = `User ID: ${event.source.userId ?? "-"}. /${name} requires a channel admin. Ask a workspace owner/admin to add this platform user ID to the connection's channel admin IDs in ToolPlane.`;
    } else if (
      body.message.length > 2000 ||
      body.attachments.length ||
      params.attachmentParts?.length
    ) {
      message = "Commands accept at most 2,000 characters and no attachments.";
    } else if (name === "help") {
      message = [
        "/help - Show commands",
        "/whoami - Show IDs and role",
        "/status - Show session status",
        "/new - Start a new conversation (confirmation required)",
        "/resume [n] - List or resume prior conversations",
        ...sessionRuntimeCommands(agent.runtimeKind, prior?.messages ?? []).map(
          (item) =>
            `/${item.name}${item.description ? ` - ${item.description}` : ""}`,
        ),
        "/model [list|provider:model|model|reset] - Session model (channel admin)",
        "/upgrade - Upgrade pinned revision (channel admin; confirmation required)",
      ].join("\n");
    } else if (name === "whoami") {
      message = `User ID: ${event.source.userId ?? "-"}\nChat ID: ${event.source.chatId ?? "-"}\nPlatform: ${channel.platform}\nRole: ${decision.role}`;
    } else if (name === "status") {
      const pinned = prior
        ? await resolvePinnedAgent(agent, prior.agentRevisionId)
        : agent;
      const override = prior?.modelOverride as { model?: string } | null;
      message = `Agent: ${agent.name}\nConversation: ${prior?.id.slice(0, 10) ?? "none"}\nRevision: v${prior?.agentRevision?.version ?? agent.currentRevisionVersion} / current v${agent.currentRevisionVersion}${prior?.agentRevision && prior.agentRevision.version < agent.currentRevisionVersion ? " (outdated; ask an admin to /upgrade)" : ""}\nModel: ${override?.model ?? pinned.model ?? "none"}${override ? " (session override)" : ""}\nRole: ${decision.role}\nRouting: ${event.source.threadId ? (channel.threadSessionsPerUser ? "thread per user" : "shared thread") : event.source.chatType === "dm" ? "direct message" : channel.groupSessionsPerUser ? "group per user" : "shared group"}`;
    } else {
      try {
        if (name === "resume") {
          const release = acquireConversationOperation(sessionKey, "resume");
          if (!release) throw new ConversationOperationError("busy");
          try {
            if (prior)
              await assertChannelConversationIdle(prior.id, params.workspaceId);
            const choices = ids.slice(1, 11);
            if (!args)
              message = choices.length
                ? (
                    await Promise.all(
                      choices.map(async (id, index) => {
                        const row = await db.conversation.findUniqueOrThrow({
                          where: { id },
                        });
                        return `${index + 1}. ${id.slice(0, 10)} ${row.createdAt.toISOString()} ${row.title ?? ""}`;
                      }),
                    )
                  ).join("\n")
                : "No prior conversations under this routing key.";
            else {
              const index = /^\d+$/.test(args) ? Number(args) - 1 : -1;
              const target = choices[index];
              if (!target)
                message = "Choose a conversation from /resume (1–10).";
              else {
                await assertChannelConversationIdle(target, params.workspaceId);
                conversationId = target;
                message = `Resumed conversation ${target.slice(0, 10)}.`;
                await db.$transaction(async (tx) => {
                  await tx.conversation.update({
                    where: { id: target },
                    data: { channelSelectedAt: new Date() },
                  });
                  await rememberResult(tx, commandResult(message));
                });
              }
            }
          } finally {
            release();
          }
        } else if (
          (name === "new" || name === "upgrade") &&
          !confirmChannelCommand({
            connectionId: channel.id,
            sessionKey,
            userId: event.source.userId ?? "",
            name,
            args,
            conversationId,
          })
        ) {
          const token = randomUUID().replaceAll("-", "");
          pendingConfirmations.set(
            `${channel.id}:${sessionKey}:${event.source.userId}:${name}`,
            { token, expiresAt: Date.now() + 120_000, conversationId },
          );
          confirmation = { command: name, token };
          message = `Confirm /${name} within 2 minutes using the button, or send /${name} now. Existing history is preserved.`;
        } else if (name === "model" && (!args || args === "list")) {
          const providers = await db.modelProvider.findMany({
            where: { workspaceId: params.workspaceId },
            select: { id: true, name: true, models: true },
          });
          message =
            providers
              .flatMap((provider) =>
                provider.models.map(
                  (model) => `${provider.id}:${model} (${provider.name})`,
                ),
              )
              .join("\n") || "No workspace models are available.";
        } else {
          if (!prior) {
            const release = acquireConversationOperation(sessionKey);
            if (!release) throw new ConversationOperationError("busy");
            try {
              const created = await createConversation(
                params.workspaceId,
                agent.id,
                event.conversationTitle,
                { runtimeSessionKey: sessionKey },
                name === "new"
                  ? (tx, id) =>
                      rememberResult(
                        tx,
                        commandResult("New conversation started.", id),
                      )
                  : undefined,
              );
              if (!created)
                throw new ConversationOperationError("notFound", 404);
              conversationId = created.id;
            } finally {
              release();
            }
          }
          if (name === "new") {
            if (prior) {
              const releaseCanonical =
                canonicalSessionKey !== sessionKey
                  ? acquireConversationOperation(canonicalSessionKey, "new")
                  : () => {};
              if (!releaseCanonical)
                throw new ConversationOperationError("busy");
              try {
                conversationId = (
                  await rotateChannelConversation({
                    workspaceId: params.workspaceId,
                    agentId: agent.id,
                    conversationId: prior.id,
                    runtimeSessionKey: canonicalSessionKey,
                    onCreated: (tx, id) =>
                      rememberResult(
                        tx,
                        commandResult(
                          "New conversation started.",
                          id,
                          canonicalSessionKey,
                        ),
                      ),
                  })
                ).conversationId;
                sessionKey = canonicalSessionKey;
              } finally {
                releaseCanonical();
              }
            }
            message = "New conversation started.";
          } else if (name === "upgrade") {
            const result = await upgradeAgentConversationRevision(
              {
                workspaceId: params.workspaceId,
                agentId: agent.id,
                conversationId,
                targetVersion: agent.currentRevisionVersion,
              },
              (tx, upgraded) =>
                rememberResult(
                  tx,
                  commandResult(
                    `Conversation upgraded to v${upgraded.version}. Session model override is unchanged.`,
                  ),
                ),
            );
            message = `Conversation upgraded to v${result.version}. Session model override is unchanged.`;
          } else if (name === "model") {
            const release = acquireConversationOperation(sessionKey, "model");
            if (!release) throw new ConversationOperationError("busy");
            try {
              await assertChannelConversationIdle(
                conversationId,
                params.workspaceId,
              );
              if (args === "reset") {
                message =
                  "Session model override cleared. Using the pinned Agent model.";
                await db.$transaction(async (tx) => {
                  await tx.conversation.update({
                    where: { id: conversationId },
                    data: { modelOverride: Prisma.DbNull },
                  });
                  await rememberResult(tx, commandResult(message));
                });
              } else {
                const providers = await db.modelProvider.findMany({
                  where: { workspaceId: params.workspaceId },
                  select: { id: true, models: true },
                });
                const explicit = providers.find((provider) =>
                  args.startsWith(`${provider.id}:`),
                );
                const model = explicit
                  ? args.slice(explicit.id.length + 1)
                  : args;
                const matches = explicit
                  ? [explicit]
                  : providers.filter((provider) =>
                      provider.models.includes(model),
                    );
                if (matches.length !== 1 || !matches[0].models.includes(model))
                  message =
                    "Model unavailable or ambiguous. Choose a workspace provider:model from /model list.";
                else {
                  await resolveAgentModelOverride(
                    params.workspaceId,
                    { providerId: matches[0].id, model },
                    agent.runtimeKind,
                  );
                  message = `Session model set to ${model}. Agent defaults and pinned revision are unchanged.`;
                  await db.$transaction(async (tx) => {
                    await tx.conversation.update({
                      where: { id: conversationId },
                      data: {
                        modelOverride: {
                          providerId: matches[0].id,
                          model,
                          setBy: event.source.userId ?? "",
                          setAt: new Date().toISOString(),
                        },
                      },
                    });
                    await rememberResult(tx, commandResult(message));
                  });
                }
              }
            } finally {
              release();
            }
          } else {
            const result = await executeRuntimeCommand({
              workspaceId: params.workspaceId,
              agentId: agent.id,
              conversationId,
              actorId: channel.a2aActorId,
              line: `/${enteredName}${args ? ` ${args}` : ""}`,
              signal: params.signal,
              entry: { kind: "channel", channelId: channel.id },
              messageId: event.source.messageId,
            });
            message =
              result.kind === "output" ? result.text : "Command completed.";
          }
        }
      } catch (error) {
        atomicResult = undefined;
        message =
          (error instanceof ConversationOperationError &&
            error.code === "busy") ||
          (error instanceof RuntimeCommandError && error.message === "busy") ||
          (error instanceof AgentConversationRevisionError &&
            error.code === "busy")
            ? "This conversation is busy. Please wait for the current operation to finish."
            : error instanceof AgentConversationRevisionError
              ? `Revision upgrade unavailable (${error.code}). Review this conversation in ToolPlane.`
              : "Command unavailable. Review workspace models and session configuration in ToolPlane; history has not been changed.";
      }
    }
    await touchAgentChannelEvent(channel.id);
    if (!atomicResult && params.inboundDedupeKey)
      await db.$transaction((tx) => rememberResult(tx, commandResult(message)));
    return atomicResult ?? commandResult(message);
  }
  const result = await runLoadedAgentMessage({
    agent,
    rawBody: body,
    defaults: params.defaults,
    connectionId: channel.id,
    actorId: channel.a2aActorId,
    onUiRequired: params.onUiRequired,
    attachmentParts: params.attachmentParts,
    signal: params.signal,
    channelSessionKey: sessionKey,
  });
  if (result.status === 200) await touchAgentChannelEvent(params.connectionId);
  return result;
}

async function runLoadedAgentMessage(params: {
  agent: AgentForRun;
  actorId?: string;
  onUiRequired?: (message: string) => Promise<void>;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
  connectionId?: string;
  attachmentParts?: UIMessage["parts"];
  signal?: AbortSignal;
  channelSessionKey?: string;
}): Promise<AgentMessageResult> {
  const agent = params.agent;
  if (agent.runtimeKind !== "pi-sdk")
    return {
      status: 410,
      body: {
        error: "Historical Agents are read-only. Create a new Pi Agent.",
      },
    };
  const body = parseAgentMessageBody({
    ...params.defaults,
    ...(params.rawBody as object),
  });
  if (!body) return { status: 400, body: { error: "Bad request" } };
  if (!params.actorId)
    return {
      status: 403,
      body: { error: "An authenticated native execution actor is required." },
    };
  if (body.attachments.length || params.attachmentParts?.length)
    return {
      status: 415,
      body: { error: "Native message ingress accepts text only." },
    };
  const event = normalizeAgentMessageEvent(body);
  if (params.connectionId)
    event.sessionKey =
      params.channelSessionKey ??
      `channel:${params.connectionId}:${event.sessionKey}`;
  if (params.connectionId && !event.source.messageId)
    return {
      status: 400,
      body: {
        error:
          "A stable channel message ID is required for native task deduplication.",
      },
    };
  const command = parseRuntimeCommand(body.message, agent.runtimeKind);
  if (command && body.message.length > 2000)
    return {
      status: 400,
      body: { error: "Commands accept at most 2,000 characters." },
    };
  const operationKey = params.connectionId
    ? event.sessionKey
    : (body.conversationId ?? `agent-message:${agent.id}:${event.sessionKey}`);
  let releaseConversation: (() => void) | null = null;
  let persistedConversationId: string | null = null;
  let persistedTaskId: string | null = null;
  let assistantMessageId: string = randomUUID();
  const response = (
    conversationId: string,
    text: string,
  ): AgentMessageResult => {
    const silent = isSilentAgentReply(text);
    return {
      status: 200,
      body: {
        agentId: agent.id,
        conversationId,
        delivery: silent ? "silent" : "message",
        message: silent ? "" : text,
        rawMessage: text,
        sessionKey: event.sessionKey,
        source: event.source,
        platform: event.source.platform,
        externalUserId: event.source.userId ?? null,
        channelId: event.source.chatId ?? null,
      },
    };
  };
  try {
    if (
      body.conversationId &&
      !(await db.conversation.count({
        where: {
          id: body.conversationId,
          agentId: agent.id,
          agent: { workspaceId: agent.workspaceId },
        },
      }))
    )
      return { status: 404, body: { error: "Conversation not found" } };
    releaseConversation = await waitForConversationOperation(
      operationKey,
      params.signal,
    );
    const selectedIds = params.connectionId
      ? await channelConversationIds(
          agent.id,
          agent.workspaceId,
          event.sessionKey,
          1,
        )
      : [];
    const loaded = await db.conversation.findFirst({
      where: {
        agentId: agent.id,
        agent: { workspaceId: agent.workspaceId },
        ...(params.connectionId
          ? {
              id: body.conversationId ?? selectedIds[0] ?? "",
              runtimeSessionKey: event.sessionKey,
            }
          : body.conversationId
            ? { id: body.conversationId }
            : { title: event.conversationTitle }),
      },
      orderBy: { createdAt: "desc" },
    });
    if (body.conversationId && !loaded)
      return { status: 404, body: { error: "Conversation not found" } };
    const conversation =
      loaded ??
      (await createConversation(
        agent.workspaceId,
        agent.id,
        event.conversationTitle,
        { runtimeSessionKey: event.sessionKey },
      ));
    if (!conversation)
      return { status: 404, body: { error: "Conversation not found" } };
    if (conversation.legacyRevisionUnresolved)
      return {
        status: 410,
        body: {
          error:
            "This conversation has no executable immutable revision and is read-only.",
        },
      };
    const pinned = await resolvePinnedAgent(
      agent,
      conversation.agentRevisionId,
    );
    if (!pinned.provider || !pinned.model)
      return {
        status: 409,
        body: { error: "The pinned Agent revision has no available model." },
      };
    if (operationKey !== conversation.id) {
      const releaseSession = await waitForConversationOperation(
        conversation.id,
        params.signal,
      );
      const releaseRouting = releaseConversation;
      releaseConversation = () => {
        releaseSession();
        releaseRouting?.();
      };
    }
    const projectionKey =
      params.connectionId && event.source.messageId
        ? createHash("sha256")
            .update(
              JSON.stringify([
                params.connectionId,
                conversation.id,
                event.source.messageId,
              ]),
            )
            .digest("hex")
        : null;
    if (projectionKey) assistantMessageId = `channel-reply-${projectionKey}`;
    const userMessageId = projectionKey
      ? `channel-message-${projectionKey}`
      : randomUUID();
    const previousUser = projectionKey
      ? await db.message.findUnique({ where: { id: userMessageId } })
      : null;
    const text = command ? body.message : event.promptText;
    if (previousUser && latestEntryText(previousUser) !== text.trim())
      return {
        status: 400,
        body: {
          error: "Channel message ID was reused with different content.",
        },
      };
    // A failed transport send may retry the same saved reply, but never the execution/history.
    const previousReply = projectionKey
      ? await db.message.findUnique({ where: { id: assistantMessageId } })
      : null;
    if (previousReply?.conversationId === conversation.id) {
      const parts = previousReply.parts as Array<{
        type?: string;
        text?: string;
      }>;
      return response(
        conversation.id,
        parts
          .filter(
            (part) => part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n"),
      );
    }
    const userParts = [
      {
        type: "text" as const,
        text,
      },
    ];
    const userMessage: UIMessage = {
      id: userMessageId,
      role: "user",
      parts: userParts,
    };
    const savedUser = await db.message.upsert({
      where: { id: userMessage.id },
      update: {},
      create: {
        id: userMessage.id,
        conversationId: conversation.id,
        role: "user",
        parts: userParts,
      },
    });
    persistedConversationId = conversation.id;
    const result = await runAgentEntry({
      kind: params.connectionId
        ? "channel"
        : event.source.platform === "mcp"
          ? "control"
          : "chat",
      sourceId: conversation.id,
      channelId: params.connectionId,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      actorId: params.actorId,
      messageId: event.source.messageId ?? userMessage.id,
      text: latestEntryText(userMessage),
      signal: params.signal,
      onAccepted: (task) => {
        persistedTaskId = task.id;
      },
      onPromptInvocation: (invocation) =>
        persistAgentPromptInvocation({
          conversationId: conversation.id,
          messageId: savedUser.id,
          invocation,
        }),
      onUiRequired: (path) =>
        params.onUiRequired?.(`Pi 扩展需要你的输入，请打开会话：${path}`),
    });
    const replyText = agentEntryResult(result.task, result.path);
    const runtimeParts = agentEntryRuntimeParts(result.task);
    params.signal?.throwIfAborted();
    await db.message.create({
      data: {
        id: assistantMessageId,
        conversationId: conversation.id,
        role: "assistant",
        parts: [{ type: "text", text: replyText }, ...runtimeParts],
      },
    });
    notifyTaskOutput(result.task.id);
    return response(conversation.id, replyText);
  } catch (error) {
    const failureCode =
      error instanceof Error
        ? parseRuntimeFailure(error.message)?.code
        : undefined;
    const failureMessage =
      failureCode === "MODEL_OVERRIDE_UNAVAILABLE"
        ? "MODEL_OVERRIDE_UNAVAILABLE: The session model is no longer available. Ask a channel admin to run /model reset or choose another workspace model."
        : failureCode === "AGENT_BUDGET_EXCEEDED"
          ? "AGENT_BUDGET_EXCEEDED"
          : CHANNEL_EXECUTION_FAILURE_MESSAGE;
    // Aborting a channel observer (including shutdown) is not a failed execution.
    if (params.signal?.aborted) throw error;
    if (persistedConversationId) {
      let startedAt = persistedTaskId
        ? taskOutput(persistedTaskId)?.startedAt
        : undefined;
      if (persistedTaskId && startedAt === undefined) {
        const task = await db.a2ATask.findUnique({
          where: { id: persistedTaskId },
          select: { snapshot: true },
        });
        const replay = z
          .object({
            metadata: z.object({
              toolplaneLiveOutput: z.object({ startedAt: z.number().finite() }),
            }),
          })
          .safeParse(task?.snapshot);
        if (replay.success)
          startedAt = replay.data.metadata.toolplaneLiveOutput.startedAt;
      }
      await db.message.create({
        data: {
          id: assistantMessageId,
          conversationId: persistedConversationId,
          role: "assistant",
          parts: [
            ...(persistedTaskId
              ? [
                  {
                    type: "data-agent-task",
                    data: {
                      taskId: persistedTaskId,
                      ...(startedAt === undefined ? {} : { startedAt }),
                    },
                  },
                ]
              : []),
            { type: "text", text: failureMessage },
            {
              type: "data-agent-execution",
              data: {
                status: "failed",
                error: {
                  code:
                    failureCode === "MODEL_OVERRIDE_UNAVAILABLE" ||
                    failureCode === "AGENT_BUDGET_EXCEEDED"
                      ? failureCode
                      : "AGENT_EXECUTION_FAILED",
                  message: failureMessage,
                },
              },
            },
          ],
        },
      });
      if (persistedTaskId) notifyTaskOutput(persistedTaskId);
      return response(persistedConversationId, failureMessage);
    }
    if (error instanceof AgentRevisionError)
      return { status: 409, body: { error: error.code } };
    throw error;
  } finally {
    releaseConversation?.();
  }
}

const pendingConfirmations = new Map<
  string,
  { token: string; expiresAt: number; conversationId: string }
>();
function confirmChannelCommand(input: {
  connectionId: string;
  sessionKey: string;
  userId: string;
  name: string;
  args: string;
  conversationId: string;
}) {
  for (const [key, pending] of pendingConfirmations)
    if (pending.expiresAt < Date.now()) pendingConfirmations.delete(key);
  const key = `${input.connectionId}:${input.sessionKey}:${input.userId}:${input.name}`;
  if (/(?:^|\s)(?:now|--yes|-y)(?:\s|$)/.test(input.args)) {
    pendingConfirmations.delete(key);
    return true;
  }
  const match = input.args.match(/^--confirm ([a-f0-9]+)$/);
  const pending = pendingConfirmations.get(key);
  if (
    !match ||
    !pending ||
    pending.token !== match[1] ||
    pending.expiresAt < Date.now() ||
    pending.conversationId !== input.conversationId
  )
    return false;
  pendingConfirmations.delete(key);
  return true;
}

const callbackObservers = new Map<
  string,
  {
    signal?: AbortSignal;
    onUiRequired?: (message: string) => Promise<void>;
    attachmentParts?: UIMessage["parts"];
  }
>();

export async function runPersistedChannelCallback(
  connectionId: string,
  payload: Prisma.JsonValue,
  signal?: AbortSignal,
  inboundDedupeKey?: string,
): Promise<AgentMessageResult> {
  const saved = payload as {
    body: unknown;
    dedupeKey?: string;
    hostedIngress?: boolean;
    legacySessionKey?: string;
    workspaceId: string;
    agentId: string | null;
    sandboxId: string | null;
  };
  const connection = await db.agentChannelConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection) return { status: 404, body: { error: "Channel not found" } };
  if (
    connection.workspaceId !== saved.workspaceId ||
    connection.agentId !== saved.agentId ||
    connection.sandboxId !== saved.sandboxId
  )
    return {
      status: 409,
      body: {
        error: "Channel binding changed before this message was processed.",
      },
    };
  const observer = callbackObservers.get(`${connectionId}:${saved.dedupeKey}`);
  const observerSignal = observer?.signal;
  return runAgentChannelMessage({
    connectionId,
    workspaceId: connection.workspaceId,
    agentId: connection.agentId,
    rawBody: saved.body,
    inboundPersisted: true,
    inboundDedupeKey: inboundDedupeKey ?? saved.dedupeKey,
    hostedIngress: saved.hostedIngress,
    legacySessionKey: saved.legacySessionKey,
    signal:
      signal && observerSignal
        ? AbortSignal.any([signal, observerSignal])
        : (observerSignal ?? signal),
    onUiRequired: observer?.onUiRequired,
    attachmentParts: observer?.attachmentParts,
  });
}
