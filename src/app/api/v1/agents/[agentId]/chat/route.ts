import { randomUUID } from 'node:crypto';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from 'ai';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { appendMessage } from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { assembleSystemPrompt, prependSystemModelMessage } from '@/lib/agents/system-prompt';
import { buildAgentToolSet } from '@/lib/agents/run';
import { buildModel } from '@/lib/agents/model';
import { resolveMaxSteps } from '@/lib/agents/constants';
import { parseAgentChatBody } from '@/lib/agents/chat-body';
import { writeHermesChatStream } from '@/lib/agents/hermes/client';
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
  if (!agent.provider || !agent.model) {
    return new Response(
      'This agent has no model configured. Open Settings and pick a provider + model.',
      { status: 400 },
    );
  }

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
  const conversationId = body.conversationId
    ? (
        await db.conversation.findFirst({
          where: { id: body.conversationId, agentId },
          select: { id: true },
        })
      )?.id ?? null
    : null;

  const last = messages[messages.length - 1];

  if (agent.runtime?.kind === 'hermes') {
    const runtimeSessionId = conversationId ?? randomUUID();
    const stream = createUIMessageStream<HermesUIMessage>({
      originalMessages: messages,
      execute: ({ writer }) => writeHermesChatStream({
        agent,
        messages,
        conversationId: runtimeSessionId,
        writer,
      }),
      onError: (error) => error instanceof Error ? error.message : 'Hermes runtime request failed.',
      onFinish: async ({ responseMessage, isAborted }) => {
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
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const resolved = resolveAgentTools(agent);
  const tools = await buildAgentToolSet(resolved, {
    workspaceId: agent.workspaceId,
    depth: 0,
    visited: new Set([agentId]),
  });
  const system = assembleSystemPrompt(agent.systemPrompt, resolved.skills);
  const model = buildModel(agent.provider, agent.model);

  // v6: convertToModelMessages is async (returns Promise<ModelMessage[]>)
  const modelMessages = prependSystemModelMessage(system, await convertToModelMessages(messages));

  const result = streamText({
    model,
    allowSystemInMessages: true,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(resolveMaxSteps(agent.maxSteps)),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ responseMessage, isAborted }) => {
      // Persist the exchange only on a completed turn, so a failed/aborted
      // stream never leaves an orphaned user message with no reply.
      if (!conversationId || isAborted) return;
      if (last?.role === 'user') {
        await appendMessage(conversationId, 'user', last.parts as never);
      }
      await appendMessage(conversationId, 'assistant', responseMessage.parts as never);
    },
  });
}
