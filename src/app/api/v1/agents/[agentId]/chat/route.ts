import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai';
import { db } from '@/lib/db';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { getAgentForRequest } from '@/lib/agents/queries';
import { appendMessage } from '@/lib/agents/mutations';
import { resolveAgentTools } from '@/lib/agents/resolve';
import { assembleSystemPrompt } from '@/lib/agents/system-prompt';
import { buildToolSet } from '@/lib/agents/tools';
import { buildModel } from '@/lib/agents/model';

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

  const body = (await req.json()) as { messages: UIMessage[]; conversationId?: string };
  const messages = body.messages ?? [];

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
  if (conversationId && last?.role === 'user') {
    await appendMessage(conversationId, 'user', last.parts as never);
  }

  const { deploymentIds, skills } = resolveAgentTools(agent);
  const tools = await buildToolSet(deploymentIds);
  const system = assembleSystemPrompt(agent.systemPrompt, skills);
  const model = buildModel(agent.provider, agent.model);

  // v6: convertToModelMessages is async (returns Promise<ModelMessage[]>)
  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model,
    system: system || undefined,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(agent.maxSteps),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ responseMessage }) => {
      if (conversationId) {
        await appendMessage(conversationId, 'assistant', responseMessage.parts as never);
      }
    },
  });
}
