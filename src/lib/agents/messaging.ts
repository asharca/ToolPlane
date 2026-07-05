import type { AgentMessageBody } from '@/lib/agents/chat-body';

const SILENCE_TOKENS = new Set(['[silent]', 'silent', 'no_reply', 'no reply']);

export function isSilentAgentReply(text: string): boolean {
  return SILENCE_TOKENS.has(text.trim().toLowerCase().replace(/\s+/g, ' '));
}

function cleanSegment(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .trim()
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/:+/g, '_')
    .slice(0, 120);
  return cleaned || fallback;
}

function stringMetadataValue(metadata: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export type NormalizedMessagingSource = {
  platform: string;
  chatId?: string;
  chatName?: string;
  chatType: 'dm' | 'group' | 'channel' | 'thread';
  userId?: string;
  userName?: string;
  threadId?: string;
  parentChatId?: string;
  scopeId?: string;
  messageId?: string;
};

export type NormalizedMessagingEvent = {
  message: string;
  messageType: AgentMessageBody['messageType'];
  source: NormalizedMessagingSource;
  sessionKey: string;
  conversationTitle: string;
  promptText: string;
  attachments: AgentMessageBody['attachments'];
  metadata?: Record<string, unknown>;
};

export function normalizeAgentMessageEvent(body: AgentMessageBody): NormalizedMessagingEvent {
  const source = body.source ?? {};
  const platform = cleanSegment(source.platform ?? body.platform, 'external').toLowerCase();
  const inferredThreadId = stringMetadataValue(body.metadata, ['threadId', 'thread_id', 'threadTs', 'thread_ts']);
  const chatType = source.chatType ?? (body.channelId ? 'channel' : 'dm');
  let chatId = source.chatId ?? body.channelId ?? body.externalUserId;
  let threadId = source.threadId ?? inferredThreadId;
  if (chatType === 'thread' && !threadId && chatId && source.parentChatId) {
    threadId = chatId;
    chatId = source.parentChatId;
  }
  const normalizedSource: NormalizedMessagingSource = {
    platform,
    chatId,
    chatName: source.chatName,
    chatType,
    userId: source.userId ?? body.externalUserId,
    userName: source.userName,
    threadId,
    parentChatId: source.parentChatId,
    scopeId: source.scopeId,
    messageId: source.messageId ?? body.messageId,
  };
  const sessionKey = buildMessagingSessionKey(normalizedSource);
  return {
    message: body.message,
    messageType: body.messageType,
    source: normalizedSource,
    sessionKey,
    conversationTitle: sessionKey.slice(0, 120),
    promptText: renderMessagingPromptText(body.message, normalizedSource, body.attachments),
    attachments: body.attachments,
    metadata: body.metadata,
  };
}

export function buildMessagingSessionKey(source: NormalizedMessagingSource): string {
  const platform = cleanSegment(source.platform, 'external').toLowerCase();
  if (source.chatType === 'dm') {
    const dmId = cleanSegment(source.chatId ?? source.userId, 'session');
    const parts = ['msg', platform, 'dm', dmId];
    if (source.threadId) parts.push(cleanSegment(source.threadId, 'thread'));
    return parts.join(':');
  }

  const parts = [
    'msg',
    platform,
    cleanSegment(source.chatType, 'channel'),
    cleanSegment(source.chatId ?? source.parentChatId, 'chat'),
  ];
  if (source.threadId) {
    parts.push(cleanSegment(source.threadId, 'thread'));
  } else if (source.userId) {
    parts.push(cleanSegment(source.userId, 'user'));
  }
  return parts.join(':');
}

export type ParsedMessagingSession = {
  platform: string;
  chatType: 'dm' | 'group' | 'channel' | 'thread';
  chatId: string;
  contextId?: string;
};

export function parseMessagingSessionTitle(title: string | null | undefined): ParsedMessagingSession | null {
  if (!title?.startsWith('msg:')) return null;
  const [, platform, chatType, chatId, ...rest] = title.split(':');
  if (!platform || !chatType || !chatId) return null;
  if (!['dm', 'group', 'channel', 'thread'].includes(chatType)) return null;
  const suffix = rest.join(':') || undefined;
  return {
    platform,
    chatType: chatType as ParsedMessagingSession['chatType'],
    chatId,
    ...(suffix ? { contextId: suffix } : {}),
  };
}

export function renderMessagingPromptText(
  message: string,
  source: NormalizedMessagingSource,
  attachments: AgentMessageBody['attachments'] = [],
): string {
  const context = [
    `platform=${source.platform}`,
    `chatType=${source.chatType}`,
    source.chatId ? `chatId=${source.chatId}` : null,
    source.threadId ? `threadId=${source.threadId}` : null,
    source.userId ? `userId=${source.userId}` : null,
    source.userName ? `userName=${source.userName}` : null,
    source.scopeId ? `scopeId=${source.scopeId}` : null,
    source.messageId ? `messageId=${source.messageId}` : null,
    attachments.length ? `attachments=${attachments.length}` : null,
  ].filter(Boolean);
  const attachmentLines = attachments.map((a, index) => {
    const label = a.name || a.url || `attachment-${index + 1}`;
    return `- ${a.type}: ${label}${a.mimeType ? ` (${a.mimeType})` : ''}`;
  });
  return [
    `[Messaging source: ${context.join(', ')}]`,
    attachmentLines.length ? `Attachments:\n${attachmentLines.join('\n')}` : null,
    message,
  ].filter(Boolean).join('\n\n');
}

export function messageConversationTitle(input: {
  platform?: string;
  externalUserId?: string;
  channelId?: string;
  source?: AgentMessageBody['source'];
  metadata?: Record<string, unknown>;
}): string {
  return normalizeAgentMessageEvent({
    message: 'title',
    messageType: 'text',
    attachments: [],
    ...input,
  }).conversationTitle;
}
