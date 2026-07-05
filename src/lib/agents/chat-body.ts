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

const MessagingSourceSchema = z
  .object({
    platform: z.string().trim().min(1).max(40).optional(),
    chatId: z.string().trim().min(1).max(240).optional(),
    chatName: z.string().trim().min(1).max(240).optional(),
    chatType: z.enum(['dm', 'group', 'channel', 'thread']).optional(),
    userId: z.string().trim().min(1).max(240).optional(),
    userName: z.string().trim().min(1).max(240).optional(),
    threadId: z.string().trim().min(1).max(240).optional(),
    parentChatId: z.string().trim().min(1).max(240).optional(),
    scopeId: z.string().trim().min(1).max(240).optional(),
    messageId: z.string().trim().min(1).max(240).optional(),
  })
  .passthrough();

const MessagingAttachmentSchema = z
  .object({
    type: z.enum(['image', 'file', 'audio', 'voice', 'video', 'location']).default('file'),
    url: z.string().trim().min(1).max(4000).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    mimeType: z.string().trim().min(1).max(120).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const AgentMessageBodySchema = z
  .object({
    message: z.string().trim().min(1).max(20000),
    conversationId: z.string().trim().min(1).optional(),
    platform: z.string().trim().min(1).max(40).optional(),
    externalUserId: z.string().trim().min(1).max(200).optional(),
    channelId: z.string().trim().min(1).max(200).optional(),
    messageId: z.string().trim().min(1).max(240).optional(),
    messageType: z
      .enum(['text', 'command', 'image', 'file', 'audio', 'voice', 'video', 'location'])
      .default('text'),
    source: MessagingSourceSchema.optional(),
    attachments: z.array(MessagingAttachmentSchema).max(20).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type AgentChatBody = {
  messages: UIMessage[];
  conversationId?: string;
};

export type AgentMessageBody = {
  message: string;
  conversationId?: string;
  platform?: string;
  externalUserId?: string;
  channelId?: string;
  messageId?: string;
  messageType: 'text' | 'command' | 'image' | 'file' | 'audio' | 'voice' | 'video' | 'location';
  source?: {
    platform?: string;
    chatId?: string;
    chatName?: string;
    chatType?: 'dm' | 'group' | 'channel' | 'thread';
    userId?: string;
    userName?: string;
    threadId?: string;
    parentChatId?: string;
    scopeId?: string;
    messageId?: string;
  };
  attachments: Array<{
    type: 'image' | 'file' | 'audio' | 'voice' | 'video' | 'location';
    url?: string;
    name?: string;
    mimeType?: string;
    size?: number;
  }>;
  metadata?: Record<string, unknown>;
};

export function parseAgentChatBody(raw: unknown): AgentChatBody | null {
  const parsed = ChatBody.safeParse(raw);
  if (!parsed.success) return null;
  return {
    conversationId: parsed.data.conversationId,
    messages: parsed.data.messages as unknown as UIMessage[],
  };
}

export function parseAgentMessageBody(raw: unknown): AgentMessageBody | null {
  const parsed = AgentMessageBodySchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
