import { randomUUID } from 'node:crypto';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import {
  appendMessage,
  ensureConversationRuntimeSession,
} from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';
import { buildAgentToolSet } from '@/lib/agents/run';
import { uiMessagesToPi, runNativeAgent } from '@/lib/agents/native';
import { parseAgentChatBody } from '@/lib/agents/chat-body';
import { writeHermesChatStream } from '@/lib/agents/hermes/client';
import {
  acquireHermesRuntimeWriteLease,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR,
} from '@/lib/agents/hermes/runtime';
import {
  hermesAssistantSegments,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return new Response('Not found', { status: 404 });
  const isHermes = agent.runtime?.kind === 'hermes';
  if (isHermes ? agent.modelProviders.length === 0 : !agent.provider || !agent.model) {
    return new Response(
      isHermes
        ? 'This Hermes agent has no model provider configured. Open Settings and select one or more providers.'
        : 'This agent has no model configured. Open Settings and pick a provider + model.',
      { status: 400 },
    );
  }

  // Keep the lease through Hermes' volume write and the matching database
  // persistence in onFinish. A clone closes this gate before it snapshots.
  const hermesWriteLease = isHermes
    ? acquireHermesRuntimeWriteLease(agent.workspaceId, agent.id)
    : null;
  if (isHermes && !hermesWriteLease) {
    return new Response(HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR, { status: 503 });
  }
  let streamOwnsHermesWriteLease = false;

  try {
    let body: { messages: UIMessage[]; conversationId?: string };
    try {
      const parsed = parseAgentChatBody(await req.json());
      if (!parsed) return new Response('Bad request', { status: 400 });
      body = parsed;
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const messages = (body.messages ?? []) as HermesUIMessage[];

    // Only persist to a conversation that belongs to THIS agent.
    const conversation = body.conversationId
      ? (
          await db.conversation.findFirst({
            where: { id: body.conversationId, agentId },
            select: { id: true },
          })
        ) ?? null
      : null;
    const conversationId = conversation?.id ?? null;
    const runtimeSession = isHermes && conversationId
      ? await ensureConversationRuntimeSession(agent.workspaceId, agent.id, conversationId)
      : null;

    const last = messages[messages.length - 1];

    if (isHermes) {
      const writeLease = hermesWriteLease!;
      const runtimeSessionId = runtimeSession?.runtimeSessionId ?? randomUUID();
      const runtimeSessionKey = runtimeSession?.runtimeSessionKey
        ?? `agent:${agent.id}:console:${runtimeSessionId}`;
      const stream = createUIMessageStream<HermesUIMessage>({
        originalMessages: messages,
        execute: ({ writer }) => writeHermesChatStream({
          agent,
          messages,
          conversationId: conversationId ?? runtimeSessionId,
          runtimeSessionId,
          sessionKey: runtimeSessionKey,
          writeLease,
          writer,
        }),
        onError: (error) => error instanceof Error ? error.message : 'Hermes runtime request failed.',
        onFinish: async ({ responseMessage, isAborted }) => {
          try {
            if (!conversationId || isAborted) return;
            if (last?.role === 'user') {
              await appendMessage(conversationId, 'user', last.parts as never);
            }
            const segments = hermesAssistantSegments(responseMessage.parts);
            if (!segments.length) {
              await appendMessage(conversationId, 'assistant', responseMessage.parts as never);
              return;
            }
            await db.$transaction(segments.map((segment) => db.message.create({
              data: {
                conversationId,
                role: 'assistant',
                parts: [{ type: 'text', text: segment.text, state: 'done' }],
              },
            })));
          } finally {
            writeLease.release();
          }
        },
      });
      const response = createUIMessageStreamResponse({ stream });
      streamOwnsHermesWriteLease = true;
      return response;
    }

    if (!agent.provider || !agent.model) {
      return new Response('This agent has no model configured.', { status: 400 });
    }

    const resolved = resolveAgentTools(agent);
    const tools = await buildAgentToolSet(resolved, {
      workspaceId: agent.workspaceId,
      depth: 0,
      visited: new Set([agentId]),
    });
    const system = assembleSystemPrompt(agent.systemPrompt, resolved.skills);
    const stream = createUIMessageStream<HermesUIMessage>({
      originalMessages: messages,
      execute: async ({ writer }) => {
        const textPartIds = new Map<number, string>();
        await runNativeAgent({
          provider: agent.provider!,
          modelId: agent.model!,
          systemPrompt: system,
          messages: uiMessagesToPi(messages),
          tools,
          maxSteps: agent.maxSteps,
          signal: req.signal,
          onEvent: (event) => {
            if (event.type === 'text_start') {
              const id = `native-${agent.id}-${event.contentIndex}`;
              textPartIds.set(event.contentIndex, id);
              writer.write({ type: 'text-start', id });
            } else if (event.type === 'text_delta') {
              let id = textPartIds.get(event.contentIndex);
              if (!id) {
                id = `native-${agent.id}-${event.contentIndex}`;
                textPartIds.set(event.contentIndex, id);
                writer.write({ type: 'text-start', id });
              }
              writer.write({ type: 'text-delta', id, delta: event.delta });
            } else if (event.type === 'text_end') {
              const id = textPartIds.get(event.contentIndex);
              if (id) writer.write({ type: 'text-end', id });
            } else if (event.type === 'toolcall_end') {
              writer.write({ type: 'tool-input-start', toolCallId: event.toolCall.id, toolName: event.toolCall.name });
              writer.write({
                type: 'tool-input-available',
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.name,
                input: event.toolCall.arguments,
              });
            }
          },
          onToolResult: (toolCall, output, isError) => {
            if (isError) {
              writer.write({
                type: 'tool-output-error',
                toolCallId: toolCall.id,
                errorText: output instanceof Error ? output.message : JSON.stringify(output),
              });
              return;
            }
            writer.write({ type: 'tool-output-available', toolCallId: toolCall.id, output });
          },
        });
      },
      onError: (error) => error instanceof Error ? error.message : 'Agent request failed.',
      onFinish: async ({ responseMessage, isAborted }) => {
        if (!conversationId || isAborted) return;
        if (last?.role === 'user') {
          await appendMessage(conversationId, 'user', last.parts as never);
        }
        await appendMessage(conversationId, 'assistant', responseMessage.parts as never);
      },
    });
    return createUIMessageStreamResponse({ stream });
  } finally {
    if (!streamOwnsHermesWriteLease) hermesWriteLease?.release();
  }
}
