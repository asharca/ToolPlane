import type { UIMessage } from 'ai';
import { z } from 'zod';

const ChatMessage = z
  .object({
    id: z.string().min(1),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.custom<UIMessage['parts']>((value) => Array.isArray(value)),
  })
  .passthrough();

const ChatBody = z
  .object({
    messages: z.array(ChatMessage).default([]),
    conversationId: z.string().min(1).optional(),
  })
  .passthrough();

export type AgentChatBody = {
  messages: UIMessage[];
  conversationId?: string;
};

export function parseAgentChatBody(raw: unknown): AgentChatBody | null {
  const parsed = ChatBody.safeParse(raw);
  if (!parsed.success) return null;
  return {
    conversationId: parsed.data.conversationId,
    messages: parsed.data.messages as unknown as UIMessage[],
  };
}
