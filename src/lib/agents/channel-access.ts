import type { AgentMessageBody } from '@/lib/agents/chat-body';

export function channelSenderAllowed(platform: string, credentials: Record<string, string>, source: NonNullable<AgentMessageBody['source']>, roleIds?: unknown) {
  const prefix = platform.toUpperCase();
  const users = credentials[`${prefix}_ALLOWED_USERS`];
  const policy = credentials[`${prefix}_${source.chatType && source.chatType !== 'dm' ? 'GROUP' : 'DM'}_POLICY`];
  if (policy === 'disabled' || (['allowlist', 'pairing'].includes(policy) && !users?.trim())) return false;
  if (!users?.trim() && credentials[`${prefix}_ALLOW_ALL_USERS`] === 'false') return false;
  const chats = credentials[`${prefix}_ALLOWED_CHATS`] ?? credentials[`${prefix}_ALLOWED_CHANNELS`];
  const allows = (value: string | undefined, id: string | undefined) => {
    const ids = (value ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    return !ids.length || ids.includes('*') || Boolean(id && ids.includes(id));
  };
  const rawChatId = ['discord', 'qqbot'].includes(platform)
    ? source.chatId?.replace(/^(?:channel|dm|group|guild|c2c):/, '') : source.chatId;
  if (platform === 'discord' && credentials.DISCORD_ALLOWED_ROLES?.trim()) {
    if (!Array.isArray(roleIds) || !roleIds.some((id) => typeof id === 'string' && allows(credentials.DISCORD_ALLOWED_ROLES, id))) return false;
  }
  return allows(users, source.userId) && (allows(chats, source.chatId) || allows(chats, rawChatId));
}
