import 'server-only';
import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import { db } from '@/lib/db';
import { getAgent, getAgentForRequest } from '@/lib/agents/queries';
import {
  appendConversationTurn,
  createConversation,
  ensureConversationRuntimeSession,
} from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';
import { buildAgentToolSet } from '@/lib/agents/run';
import { uiMessagesToPi, runNativeAgent } from '@/lib/agents/native';
import { parseAgentMessageBody, type AgentMessageBody } from '@/lib/agents/chat-body';
import { isSilentAgentReply, normalizeAgentMessageEvent } from '@/lib/agents/messaging';
import { decryptChannelCredentials, touchAgentChannelEvent } from '@/lib/agents/channel-connections';
import { channelSenderAllowed } from '@/lib/agents/channel-access';
import { getChannelSandbox } from '@/lib/agents/channel-sandboxes';
import { runHermesText } from '@/lib/agents/hermes/client';
import {
  acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR,
} from '@/lib/agents/hermes/runtime';
import {
  implementedAgentRuntimeKind,
  isDedicatedSandboxRuntimeKind,
} from '@/lib/agents/runtime-kind';
import { runDedicatedSandboxTurn } from '@/lib/agents/sandbox-turn';
import { activeConversationMessages } from './conversation-context';
import { acquireConversationOperation, ConversationOperationError, operateConversation } from './conversation-operations';
import { executeRuntimeCommand, RuntimeCommandError } from './runtime-command-service';
import { RUNTIME_COMMANDS_PART, RUNTIME_USAGE_PART, sessionRuntimeCommands, type RuntimeCommand, type RuntimeUsage } from './runtime-commands';

type LoadedMessageAgent = NonNullable<Awaited<ReturnType<typeof getAgentForRequest>>>;

export type AgentMessageResult =
  | { status: number; body: { error: string } }
  | {
      status: 200;
      body: {
        agentId: string;
        conversationId: string;
        delivery: 'message' | 'silent';
        message: string;
        rawMessage: string;
        sessionKey: string;
        source: ReturnType<typeof normalizeAgentMessageEvent>['source'];
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
  if (!agent) return { status: 404, body: { error: 'Agent not found' } };
  return runLoadedAgentMessage({
    agent,
    rawBody: params.rawBody,
    defaults: params.defaults,
  });
}

// Workspace-scoped variant for authenticated control-plane integrations. The
// URL workspace remains a hard boundary even when the caller can access more
// than one workspace.
export async function runWorkspaceAgentMessage(params: {
  workspaceId: string;
  agentId: string;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
}): Promise<AgentMessageResult> {
  const agent = await getAgent(params.workspaceId, params.agentId);
  if (!agent) return { status: 404, body: { error: 'Agent not found' } };
  return runLoadedAgentMessage({
    agent,
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
  attachmentParts?: UIMessage['parts'];
  signal?: AbortSignal;
}): Promise<AgentMessageResult> {
  const channel = await db.agentChannelConnection.findFirst({
    where: { id: params.connectionId, workspaceId: params.workspaceId, agentId: params.agentId, sandboxId: params.sandboxId },
  });
  if (!channel) return { status: 404, body: { error: 'Channel not found' } };
  if (!params.agentId) return { status: 409, body: { error: 'Channel has no bound agent' } };
  if (channel.sandboxId) {
    const sandbox = await getChannelSandbox(params.workspaceId, channel.sandboxId);
    if (sandbox?.agentId !== params.agentId) return { status: 409, body: { error: 'Channel sandbox binding changed. Restart the channel.' } };
  }
  if (!['running', 'starting', 'waiting_callback'].includes(channel.status)) {
    return { status: 409, body: { error: 'Channel is stopped' } };
  }
  const body = parseAgentMessageBody(params.rawBody);
  if (!body) return { status: 400, body: { error: 'Bad request' } };
  body.source = { ...body.source, platform: channel.platform };
  const event = normalizeAgentMessageEvent(body);
  if (!channelSenderAllowed(channel.platform, decryptChannelCredentials(channel.credentials), event.source, body.metadata?.roleIds)) {
    return { status: 403, body: { error: 'Sender or chat is not allowed' } };
  }
  const agent = await getAgent(params.workspaceId, params.agentId);
  if (!agent) return { status: 404, body: { error: 'Agent not found' } };
  const sessionKey = `channel:${channel.id}:${event.sessionKey}`;
  const command = body.message.trim().match(/^\/([a-z][a-z0-9_:-]{0,99})(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command) {
    const name = command[1].toLowerCase();
    const prior = await db.conversation.findFirst({
      where: { agentId: agent.id, runtimeSessionKey: sessionKey }, orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    const commands = sessionRuntimeCommands(agent.runtimeKind, prior?.messages ?? []);
    let conversationId = prior?.id ?? '';
    let message: string;
    if (name === 'help') {
      message = ['/new - Start a new conversation', ...commands.map((item) => `/${item.name}${item.description ? ` - ${item.description}` : ''}`), '/whoami - Show your chat and user IDs', '/help - Show commands'].join('\n');
    } else if (name === 'whoami') {
      message = `User ID: ${event.source.userId ?? '-'}\nChat ID: ${event.source.chatId ?? '-'}\nPlatform: ${channel.platform}`;
    } else if (name === 'compact' && !prior) {
      message = 'No active conversation to compact.';
    } else if (name !== 'new' && !commands.some((item) => item.name === name)) {
      message = 'This command is not supported by the current runtime. Send /help to see available commands.';
    } else if (body.message.length > 2000 || params.attachmentParts?.length) {
      message = 'Commands accept at most 2,000 characters and no attachments.';
    } else if (name !== 'new' && (name !== 'compact' || agent.runtimeKind !== 'hermes')) {
      try {
        if (!prior) {
          const release = acquireConversationOperation(sessionKey);
          if (!release) throw new RuntimeCommandError('busy', 409);
          try {
            const created = await createConversation(params.workspaceId, agent.id, event.conversationTitle, { runtimeSessionKey: sessionKey });
            if (!created) throw new RuntimeCommandError('notFound', 404);
            conversationId = created.id;
          } finally { release(); }
        }
        const result = await executeRuntimeCommand({ workspaceId: params.workspaceId, agentId: agent.id, conversationId,
          sandboxId: channel.sandboxId ?? undefined, line: `/${name}${command[2] ? ` ${command[2]}` : ''}`, signal: params.signal });
        message = result.kind === 'output' ? result.text : 'Command completed.';
      } catch (error) {
        message = error instanceof RuntimeCommandError && error.message === 'busy' ? 'This conversation is busy. Please wait for the current operation to finish.'
          : error instanceof RuntimeCommandError && error.status === 502 ? error.message : 'The runtime command failed. Send /help to see available commands.';
      }
    } else {
      try {
        if (name === 'new' && !prior) {
          const release = acquireConversationOperation(sessionKey, 'new');
          if (!release) throw new ConversationOperationError('busy');
          try {
            const created = await createConversation(params.workspaceId, agent.id, event.conversationTitle, { runtimeSessionKey: sessionKey });
            if (!created) throw new ConversationOperationError('notFound', 404);
            conversationId = created.id;
          } finally { release(); }
          message = 'New conversation started.';
        } else {
          const result = await operateConversation({ workspaceId: params.workspaceId, agentId: agent.id, conversationId: prior!.id,
            action: name as 'new' | 'compact', instructions: command[2]?.trim().slice(0, 2000), signal: params.signal });
          conversationId = result.conversationId;
          message = name === 'new' ? 'New conversation started.' : result.compacted
            ? `Conversation compacted. Estimated context: ${result.beforeTokens} -> ${result.afterTokens} tokens. History is preserved.`
            : 'The current context is already short enough; no history was changed.';
        }
      } catch (error) {
        message = error instanceof ConversationOperationError && error.code === 'busy'
          ? 'This conversation is busy. Please wait for the current operation to finish.'
          : 'The conversation operation failed. Your history has not been changed.';
      }
    }
    await touchAgentChannelEvent(channel.id);
    return { status: 200, body: {
      agentId: agent.id, conversationId, delivery: 'message', message, rawMessage: message,
      sessionKey, source: event.source, platform: channel.platform,
      externalUserId: event.source.userId ?? null, channelId: event.source.chatId ?? null,
    } };
  }
  const result = await runLoadedAgentMessage({
    agent,
    rawBody: body,
    defaults: params.defaults,
    connectionId: channel.id,
    sandboxId: channel.sandboxId ?? undefined,
    attachmentParts: params.attachmentParts,
    signal: params.signal,
  });
  if (result.status === 200) await touchAgentChannelEvent(params.connectionId);
  return result;
}

async function runLoadedAgentMessage(params: {
  agent: LoadedMessageAgent;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
  connectionId?: string;
  sandboxId?: string;
  attachmentParts?: UIMessage['parts'];
  signal?: AbortSignal;
}): Promise<AgentMessageResult> {
  const { agent } = params;
  const runtimeKind = implementedAgentRuntimeKind(agent.runtimeKind);
  if (!runtimeKind) {
    return { status: 400, body: { error: `Agent runtime "${agent.runtimeKind}" is not available.` } };
  }
  const isHermes = runtimeKind === 'hermes';
  if (isHermes ? agent.modelProviders.length === 0 : !agent.provider || !agent.model) {
    return {
      status: 400,
      body: {
        error: isHermes
          ? 'This Hermes agent has no model provider configured. Open Settings and select one or more providers.'
          : 'This agent has no model configured. Open Settings and pick a provider + model.',
      },
    };
  }

  const hermesWriteLease = isHermes
    ? acquireHermesRuntimeWriteLease(agent.workspaceId, agent.id)
    : null;
  if (isHermes && !hermesWriteLease) {
    return { status: 503, body: { error: HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR } };
  }

  let releaseConversation: (() => void) | null = null;
  try {
  const body = parseAgentMessageBody({ ...params.defaults, ...(params.rawBody as object) });
  if (!body) return { status: 400, body: { error: 'Bad request' } };

  const event = normalizeAgentMessageEvent(body);
  if (params.connectionId) event.sessionKey = `channel:${params.connectionId}:${event.sessionKey}`;
  const operationKey = params.connectionId ? event.sessionKey : body.conversationId;
  if (operationKey) {
    releaseConversation = acquireConversationOperation(operationKey);
    if (!releaseConversation) return { status: 409, body: { error: 'This conversation is busy.' } };
  }
  const loadedConversation = await db.conversation.findFirst({
    where: {
      agentId: agent.id,
      ...(body.conversationId ? { id: body.conversationId } : params.connectionId ? {} : { title: event.conversationTitle }),
      ...(params.connectionId ? { runtimeSessionKey: event.sessionKey } : {}),
    },
    include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    orderBy: { createdAt: 'desc' },
  });
  if (body.conversationId && !loadedConversation) {
    return { status: 404, body: { error: 'Conversation not found' } };
  }
  const createdConversation = loadedConversation
    ? null
    : await createConversation(agent.workspaceId, agent.id, event.conversationTitle, {
        runtimeSessionKey: event.sessionKey,
      });
  const conversation = loadedConversation ?? createdConversation;
  if (!conversation) return { status: 404, body: { error: 'Conversation not found' } };

  const runtimeSession = isHermes
    ? await ensureConversationRuntimeSession(
        agent.workspaceId,
        agent.id,
        conversation.id,
        { runtimeSessionKey: event.sessionKey },
      )
    : null;
  if (isHermes && !runtimeSession) {
    return { status: 404, body: { error: 'Conversation not found' } };
  }

  const priorMessages: UIMessage[] = activeConversationMessages(loadedConversation?.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role as UIMessage['role'],
    parts: m.parts as UIMessage['parts'],
  }));
  const userMessage: UIMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: event.promptText }, ...(params.attachmentParts ?? [])],
  };

  let text: string;
  let commands: RuntimeCommand[] | undefined;
  let usage: RuntimeUsage | undefined;
  if (isHermes) {
    try {
      text = await runHermesText({
        agent,
        messages: [...priorMessages, userMessage],
        sessionId: runtimeSession!.runtimeSessionId,
        sessionKey: runtimeSession!.runtimeSessionKey,
        writeLease: hermesWriteLease ?? undefined,
        signal: params.signal,
      });
    } catch (error) {
      return {
        status: 502,
        body: { error: error instanceof Error ? error.message : 'Hermes runtime request failed.' },
      };
    }
  } else {
    if (!agent.provider || !agent.model) {
      return { status: 400, body: { error: 'This agent has no model configured.' } };
    }
    const resolved = resolveAgentTools(agent);
    if (isDedicatedSandboxRuntimeKind(runtimeKind)) {
      text = await runDedicatedSandboxTurn({
        agent,
        sandboxId: params.sandboxId,
        runtimeSessionId: conversation.id,
        signal: params.signal,
        systemPrompt: agent.systemPrompt,
        messages: [...priorMessages, userMessage] as never,
        skills: resolved.skills,
        deploymentIds: resolved.deploymentIds,
        onCommands: (next) => { commands = next; },
        onUsage: (next) => { usage = next; },
      });
    } else {
      const tools = await buildAgentToolSet(resolved, {
        workspaceId: agent.workspaceId,
        depth: 0,
        visited: new Set([agent.id]),
      });
      const system = assembleSystemPrompt(agent.systemPrompt, resolved.skills, Boolean(resolved.knowledgeBases?.length));
      text = await runNativeAgent({
        provider: agent.provider,
        modelId: agent.model,
        systemPrompt: system,
        messages: uiMessagesToPi([...priorMessages, userMessage]),
        tools,
        maxSteps: agent.maxSteps,
        signal: params.signal,
      });
    }
  }
  const silent = isSilentAgentReply(text);

  params.signal?.throwIfAborted();
  await appendConversationTurn(
    conversation.id,
    userMessage.parts as never,
    [{ type: 'text', text },
      ...(commands ? [{ type: RUNTIME_COMMANDS_PART, data: { runtimeKind, commands } }] : []),
      ...(usage ? [{ type: RUNTIME_USAGE_PART, data: usage }] : []),
    ] as never,
  );

  return {
    status: 200,
    body: {
      agentId: agent.id,
      conversationId: conversation.id,
      delivery: silent ? 'silent' : 'message',
      message: silent ? '' : text,
      rawMessage: text,
      sessionKey: event.sessionKey,
      source: event.source,
      platform: event.source.platform,
      externalUserId: event.source.userId ?? null,
      channelId: event.source.chatId ?? null,
    },
  };
  } finally {
    releaseConversation?.();
    hermesWriteLease?.release();
  }
}
