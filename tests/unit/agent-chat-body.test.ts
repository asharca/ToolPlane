import { describe, expect, it } from 'vitest';
import { parseAgentChatBody, parseAgentMessageBody } from '@/lib/agents/chat-body';
import {
  buildMessagingSessionKey,
  isSilentAgentReply,
  messageConversationTitle,
  normalizeAgentMessageEvent,
  parseMessagingSessionTitle,
} from '@/lib/agents/messaging';

describe('parseAgentChatBody', () => {
  it('accepts a normal UI message payload', () => {
    const parsed = parseAgentChatBody({
      conversationId: 'conv1',
      messages: [{ id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    });

    expect(parsed?.conversationId).toBe('conv1');
    expect(parsed?.messages).toHaveLength(1);
  });

  it('defaults missing messages to an empty list', () => {
    expect(parseAgentChatBody({})?.messages).toEqual([]);
  });

  it('rejects malformed payloads', () => {
    expect(parseAgentChatBody({ messages: 'hello' })).toBeNull();
    expect(parseAgentChatBody({ messages: [{ id: 'msg1', role: 'robot', parts: [] }] })).toBeNull();
    expect(parseAgentChatBody({ messages: [{ id: 'msg1', role: 'system', parts: [] }] })).toBeNull();
    expect(parseAgentChatBody({ messages: [{ id: 'msg1', role: 'user', parts: 'hello' }] })).toBeNull();
    expect(parseAgentChatBody({ messages: [{ role: 'user', parts: [] }] })).toBeNull();
  });
});

describe('parseAgentMessageBody', () => {
  it('accepts adapter-style messaging payloads', () => {
    const parsed = parseAgentMessageBody({
      message: 'hello',
      conversationId: 'conv1',
      platform: 'slack',
      externalUserId: 'U123',
      channelId: 'C123',
      messageId: 'M123',
      messageType: 'text',
      attachments: [{ type: 'file', name: 'report.pdf', mimeType: 'application/pdf' }],
      metadata: { threadTs: '1.2' },
    });

    expect(parsed).toMatchObject({
      message: 'hello',
      conversationId: 'conv1',
      platform: 'slack',
      externalUserId: 'U123',
      channelId: 'C123',
      messageId: 'M123',
    });
    expect(parsed?.attachments).toHaveLength(1);
  });

  it('accepts Hermes-style normalized source payloads', () => {
    const parsed = parseAgentMessageBody({
      message: 'hello from a thread',
      source: {
        platform: 'discord',
        chatType: 'thread',
        chatId: 'thread-1',
        parentChatId: 'channel-1',
        userId: 'user-1',
        scopeId: 'guild-1',
      },
    });

    expect(parsed?.source).toMatchObject({
      platform: 'discord',
      chatType: 'thread',
      chatId: 'thread-1',
      parentChatId: 'channel-1',
      userId: 'user-1',
      scopeId: 'guild-1',
    });
  });

  it('rejects empty or malformed messaging payloads', () => {
    expect(parseAgentMessageBody({})).toBeNull();
    expect(parseAgentMessageBody({ message: '   ' })).toBeNull();
    expect(parseAgentMessageBody({ message: 1 })).toBeNull();
  });
});

describe('agent messaging helpers', () => {
  it('detects exact intentional silence tokens only', () => {
    expect(isSilentAgentReply('[SILENT]')).toBe(true);
    expect(isSilentAgentReply(' no   reply ')).toBe(true);
    expect(isSilentAgentReply('Use [SILENT] when nothing changed')).toBe(false);
  });

  it('builds compact platform conversation titles', () => {
    expect(messageConversationTitle({ platform: 'slack', externalUserId: 'U123' })).toBe('msg:slack:dm:U123');
    expect(messageConversationTitle({ channelId: 'C123' })).toBe('msg:external:channel:C123');
  });

  it('parses messaging conversation titles for the dashboard', () => {
    expect(parseMessagingSessionTitle('msg:telegram:dm:753430113')).toEqual({
      platform: 'telegram',
      chatType: 'dm',
      chatId: '753430113',
    });
    expect(parseMessagingSessionTitle('msg:discord:thread:channel-1:thread-1')).toEqual({
      platform: 'discord',
      chatType: 'thread',
      chatId: 'channel-1',
      contextId: 'thread-1',
    });
    expect(parseMessagingSessionTitle(null)).toBeNull();
  });

  it('normalizes legacy adapter fields into a stable threaded event', () => {
    const event = normalizeAgentMessageEvent({
      message: 'deploy?',
      messageType: 'text',
      platform: 'slack',
      externalUserId: 'U123',
      channelId: 'C123',
      attachments: [],
      metadata: { threadTs: '1720000000.000100' },
    });

    expect(event.sessionKey).toBe('msg:slack:channel:C123:1720000000.000100');
    expect(event.source).toMatchObject({
      platform: 'slack',
      chatType: 'channel',
      chatId: 'C123',
      userId: 'U123',
      threadId: '1720000000.000100',
    });
    expect(event.promptText).toContain('platform=slack');
    expect(event.promptText).toContain('deploy?');
  });

  it('normalizes thread chat sources to parent chat plus thread id', () => {
    const event = normalizeAgentMessageEvent({
      message: 'thread reply',
      messageType: 'text',
      attachments: [],
      source: {
        platform: 'discord',
        chatType: 'thread',
        chatId: 'thread-1',
        parentChatId: 'channel-1',
        userId: 'user-1',
      },
    });

    expect(event.sessionKey).toBe('msg:discord:thread:channel-1:thread-1');
    expect(event.source).toMatchObject({
      chatId: 'channel-1',
      threadId: 'thread-1',
      userId: 'user-1',
    });
  });

  it('shares thread sessions while isolating unthreaded channel users', () => {
    expect(
      buildMessagingSessionKey({
        platform: 'discord',
        chatType: 'channel',
        chatId: 'C1',
        threadId: 'T1',
        userId: 'U1',
      }),
    ).toBe('msg:discord:channel:C1:T1');
    expect(
      buildMessagingSessionKey({
        platform: 'discord',
        chatType: 'channel',
        chatId: 'C1',
        userId: 'U1',
      }),
    ).toBe('msg:discord:channel:C1:U1');
  });
});
