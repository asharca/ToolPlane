import { describe, expect, it } from 'vitest';
import { conversationTitleFromParts } from '@/lib/agents/conversation-title';

describe('conversationTitleFromParts', () => {
  it('uses the first non-empty text part and normalizes whitespace', () => {
    expect(conversationTitleFromParts([
      { type: 'text', text: '  Plan\n\nour   launch  ' },
      { type: 'text', text: 'ignored' },
    ])).toBe('Plan our launch');
  });

  it('truncates long titles without splitting Unicode code points', () => {
    expect(conversationTitleFromParts([
      { type: 'text', text: '你好，帮我检查这个部署配置' },
    ], 8)).toBe('你好，帮我检查…');
  });

  it('returns null when there is no usable text', () => {
    expect(conversationTitleFromParts([{ type: 'file', url: '/x' }])).toBeNull();
    expect(conversationTitleFromParts([{ type: 'text', text: '   ' }])).toBeNull();
  });
});
