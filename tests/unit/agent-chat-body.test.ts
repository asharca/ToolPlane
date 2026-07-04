import { describe, expect, it } from 'vitest';
import { parseAgentChatBody } from '@/lib/agents/chat-body';

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
    expect(parseAgentChatBody({ messages: [{ id: 'msg1', role: 'user', parts: 'hello' }] })).toBeNull();
    expect(parseAgentChatBody({ messages: [{ role: 'user', parts: [] }] })).toBeNull();
  });
});
