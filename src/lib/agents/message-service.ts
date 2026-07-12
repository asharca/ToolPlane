import 'server-only';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, generateText, stepCountIs, type UIMessage } from 'ai';
import { db } from '@/lib/db';
import { getAgent, getAgentForRequest } from '@/lib/agents/queries';
import { appendMessage, createConversation } from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { assembleSystemPrompt, prependSystemModelMessage } from '@/lib/agents/system-prompt';
import { buildAgentToolSet } from '@/lib/agents/run';
import { buildModel } from '@/lib/agents/model';
import { resolveMaxSteps } from '@/lib/agents/constants';
import { parseAgentMessageBody, type AgentMessageBody } from '@/lib/agents/chat-body';
import { isSilentAgentReply, normalizeAgentMessageEvent } from '@/lib/agents/messaging';
import { touchAgentChannelEvent } from '@/lib/agents/channel-connections';
import { runHermesText } from '@/lib/agents/hermes/client';

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

export async function runAgentChannelMessage(params: {
  connectionId: string;
  workspaceId: string;
  agentId: string;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
}): Promise<AgentMessageResult> {
  const agent = await getAgent(params.workspaceId, params.agentId);
  if (!agent) return { status: 404, body: { error: 'Agent not found' } };
  const result = await runLoadedAgentMessage({
    agent,
    rawBody: params.rawBody,
    defaults: params.defaults,
  });
  if (result.status === 200) await touchAgentChannelEvent(params.connectionId);
  return result;
}

async function runLoadedAgentMessage(params: {
  agent: LoadedMessageAgent;
  rawBody: unknown;
  defaults?: Partial<AgentMessageBody>;
}): Promise<AgentMessageResult> {
  const { agent } = params;
  if (!agent.provider || !agent.model) {
    return {
      status: 400,
      body: { error: 'This agent has no model configured. Open Settings and pick a provider + model.' },
    };
  }

  const body = parseAgentMessageBody({ ...params.defaults, ...(params.rawBody as object) });
  if (!body) return { status: 400, body: { error: 'Bad request' } };

  const event = normalizeAgentMessageEvent(body);
  const loadedConversation = await db.conversation.findFirst({
    where: body.conversationId
      ? { id: body.conversationId, agentId: agent.id }
      : { agentId: agent.id, title: event.conversationTitle },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  if (body.conversationId && !loadedConversation) {
    return { status: 404, body: { error: 'Conversation not found' } };
  }
  const createdConversation = loadedConversation
    ? null
    : await createConversation(agent.workspaceId, agent.id, event.conversationTitle);
  const conversation = loadedConversation ?? createdConversation;
  if (!conversation) return { status: 404, body: { error: 'Conversation not found' } };

  const priorMessages: UIMessage[] = (loadedConversation?.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role as UIMessage['role'],
    parts: m.parts as UIMessage['parts'],
  }));
  const userMessage: UIMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: event.promptText }],
  };

  let text: string;
  if (agent.runtime?.kind === 'hermes') {
    try {
      text = await runHermesText({
        agent,
        messages: [...priorMessages, userMessage],
        sessionId: conversation.id,
        sessionKey: event.sessionKey,
      });
    } catch (error) {
      return {
        status: 502,
        body: { error: error instanceof Error ? error.message : 'Hermes runtime request failed.' },
      };
    }
  } else {
    const resolved = resolveAgentTools(agent);
    const tools = await buildAgentToolSet(resolved, {
      workspaceId: agent.workspaceId,
      depth: 0,
      visited: new Set([agent.id]),
    });
    const system = assembleSystemPrompt(agent.systemPrompt, resolved.skills);
    const model = buildModel(agent.provider, agent.model);
    const modelMessages = prependSystemModelMessage(
      system,
      await convertToModelMessages([...priorMessages, userMessage]),
    );

    const result = await generateText({
      model,
      allowSystemInMessages: true,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(resolveMaxSteps(agent.maxSteps)),
    });
    text = result.text;
  }
  const silent = isSilentAgentReply(text);

  await appendMessage(conversation.id, 'user', userMessage.parts as never);
  await appendMessage(conversation.id, 'assistant', [{ type: 'text', text }] as never);

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
}
