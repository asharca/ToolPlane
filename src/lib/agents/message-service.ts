import "server-only";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { db } from "@/lib/db";
import {
  runNativeEntry,
  latestEntryText,
  nativeEntryResult,
  nativeEntryRuntimeParts,
} from "@/lib/a2a/ingress";
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
import { channelSenderAllowed } from "./channel-access";
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
      };
    };

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
  onAccepted?: (message: string) => Promise<void>;
}): Promise<AgentMessageResult> {
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
  if (
    !channelSenderAllowed(
      channel.platform,
      decryptChannelCredentials(channel.credentials),
      event.source,
      body.metadata?.roleIds,
    )
  )
    return { status: 403, body: { error: "Sender or chat is not allowed" } };
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
          "Authorize a native channel operator in Agent A2A settings first.",
      },
    };
  const sessionKey = `channel:${channel.id}:${event.sessionKey}`;
  const command = body.message
    .trim()
    .match(/^\/([a-z][a-z0-9_:-]{0,99})(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command) {
    const name = command[1];
    const prior = await db.conversation.findFirst({
      where: { agentId: agent.id, runtimeSessionKey: sessionKey },
      orderBy: { createdAt: "desc" },
      include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    let conversationId = prior?.id ?? "";
    let message: string;
    if (name === "help") {
      message = [
        "/new - Start a new conversation",
        ...sessionRuntimeCommands("pi-sdk", prior?.messages ?? []).map(
          (item) =>
            `/${item.name}${item.description ? ` - ${item.description}` : ""}`,
        ),
        "/whoami - Show your chat and user IDs",
        "/help - Show commands",
      ].join("\n");
    } else if (name === "whoami") {
      message = `User ID: ${event.source.userId ?? "-"}\nChat ID: ${event.source.chatId ?? "-"}\nPlatform: ${channel.platform}`;
    } else if (
      body.message.length > 2000 ||
      body.attachments.length ||
      params.attachmentParts?.length
    ) {
      message = "Commands accept at most 2,000 characters and no attachments.";
    } else if (name !== "new" && !event.source.messageId) {
      message =
        "A stable channel message ID is required for native task deduplication.";
    } else {
      try {
        if (!prior) {
          const release = acquireConversationOperation(sessionKey);
          if (!release) throw new ConversationOperationError("busy");
          try {
            const created = await createConversation(
              params.workspaceId,
              agent.id,
              event.conversationTitle,
              { runtimeSessionKey: sessionKey },
            );
            if (!created) throw new ConversationOperationError("notFound", 404);
            conversationId = created.id;
          } finally {
            release();
          }
        }
        if (name === "new") {
          if (prior) {
            const result = await rotateChannelConversation({
              workspaceId: params.workspaceId,
              agentId: agent.id,
              conversationId: prior.id,
            });
            conversationId = result.conversationId;
          }
          message = "New conversation started.";
        } else {
          const result = await executeRuntimeCommand({
            workspaceId: params.workspaceId,
            agentId: agent.id,
            conversationId,
            actorId: channel.a2aActorId,
            line: `/${name}${command[2] ? ` ${command[2]}` : ""}`,
            signal: params.signal,
            entry: { kind: "channel", channelId: channel.id },
            messageId: event.source.messageId,
          });
          message =
            result.kind === "output" ? result.text : "Command completed.";
        }
      } catch (error) {
        message =
          (error instanceof ConversationOperationError &&
            error.code === "busy") ||
          (error instanceof RuntimeCommandError && error.message === "busy")
            ? "This conversation is busy. Please wait for the current operation to finish."
            : error instanceof RuntimeCommandError && error.status === 502
              ? error.message
              : "The runtime command failed. Your history has not been changed.";
      }
    }
    await touchAgentChannelEvent(channel.id);
    return {
      status: 200,
      body: {
        agentId: agent.id,
        conversationId,
        delivery: "message",
        message,
        rawMessage: message,
        sessionKey,
        source: event.source,
        platform: channel.platform,
        externalUserId: event.source.userId ?? null,
        channelId: event.source.chatId ?? null,
      },
    };
  }
  const result = await runLoadedAgentMessage({
    agent,
    rawBody: body,
    defaults: params.defaults,
    connectionId: channel.id,
    actorId: channel.a2aActorId,
    onAccepted: params.onAccepted,
    attachmentParts: params.attachmentParts,
    signal: params.signal,
  });
  if (result.status === 200) await touchAgentChannelEvent(params.connectionId);
  return result;
}

async function runLoadedAgentMessage(params: {
  agent: AgentForRun;
  actorId?: string;
  onAccepted?: (message: string) => Promise<void>;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
  connectionId?: string;
  attachmentParts?: UIMessage["parts"];
  signal?: AbortSignal;
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
    event.sessionKey = `channel:${params.connectionId}:${event.sessionKey}`;
  if (params.connectionId && !event.source.messageId)
    return {
      status: 400,
      body: {
        error:
          "A stable channel message ID is required for native task deduplication.",
      },
    };
  const command = parseRuntimeCommand(body.message, "pi-sdk");
  if (command && body.message.length > 2000)
    return {
      status: 400,
      body: { error: "Commands accept at most 2,000 characters." },
    };
  const operationKey = params.connectionId
    ? event.sessionKey
    : (body.conversationId ?? `agent-message:${agent.id}:${event.sessionKey}`);
  let releaseConversation: (() => void) | null = null;
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
    const loaded = await db.conversation.findFirst({
      where: {
        agentId: agent.id,
        ...(body.conversationId
          ? { id: body.conversationId }
          : params.connectionId
            ? {}
            : { title: event.conversationTitle }),
        ...(params.connectionId ? { runtimeSessionKey: event.sessionKey } : {}),
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
    const userParts = [
      {
        type: "text" as const,
        text: command ? body.message : event.promptText,
      },
    ];
    const userMessage: UIMessage = {
      id: randomUUID(),
      role: "user",
      parts: userParts,
    };
    const savedUser = await db.message.create({
      data: {
        id: userMessage.id,
        conversationId: conversation.id,
        role: "user",
        parts: userParts,
      },
    });
    const result = await runNativeEntry({
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
      onPromptInvocation: (invocation) =>
        persistAgentPromptInvocation({
          conversationId: conversation.id,
          messageId: savedUser.id,
          invocation,
        }),
      onAccepted: (_task, path) =>
        params.onAccepted?.(
          `Native task accepted. Approvals and progress (authorized console operator only): ${path}`,
        ),
    });
    const text = nativeEntryResult(result.task, result.path);
    const runtimeParts = nativeEntryRuntimeParts(result.task);
    params.signal?.throwIfAborted();
    await db.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        parts: [{ type: "text", text }, ...runtimeParts],
      },
    });
    const silent = isSilentAgentReply(text);
    return {
      status: 200,
      body: {
        agentId: agent.id,
        conversationId: conversation.id,
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
  } catch (error) {
    if (error instanceof AgentRevisionError)
      return { status: 409, body: { error: error.code } };
    throw error;
  } finally {
    releaseConversation?.();
  }
}
