import { describe, expect, it } from 'vitest';
import {
  chatBranchNavigation,
  chatMessagePath,
  latestChatBranchLeaf,
} from '@/lib/chat/branches';

const messages = [
  { id: 'u1', parentId: null, role: 'user' },
  { id: 'a1', parentId: 'u1', siblingGroupId: 'assistant-versions', role: 'assistant' },
  { id: 'u2', parentId: 'a1', role: 'user' },
  { id: 'a2', parentId: 'u2', role: 'assistant' },
  { id: 'a1-alt', parentId: 'u1', siblingGroupId: 'assistant-versions', role: 'assistant' },
  { id: 'a1-loose', parentId: 'u1', role: 'assistant' },
  { id: 'u3', parentId: 'a1-alt', siblingGroupId: 'user-versions', role: 'user' },
  { id: 'a3', parentId: 'u3', role: 'assistant' },
  { id: 'u3-alt', parentId: 'a1-alt', siblingGroupId: 'user-versions', role: 'user' },
  { id: 'a3-alt', parentId: 'u3-alt', role: 'assistant' },
];

describe('chat message branches', () => {
  it('projects only the active path', () => {
    expect(chatMessagePath(messages, 'a2').map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('navigates only explicit sibling groups on the active path', () => {
    const path = chatMessagePath(messages, 'a2');

    expect(chatBranchNavigation(messages, path)).toEqual([{
      messageId: 'a1',
      position: 1,
      total: 2,
      previousMessageId: 'a1-alt',
      nextMessageId: 'a1-alt',
    }]);
  });

  it('exposes nested assistant and user sibling groups', () => {
    const path = chatMessagePath(messages, 'a3-alt');

    expect(chatBranchNavigation(messages, path)).toEqual([
      expect.objectContaining({ messageId: 'a1-alt', position: 2, total: 2 }),
      expect.objectContaining({ messageId: 'u3-alt', position: 2, total: 2 }),
    ]);
  });

  it('restores the latest leaf below the selected branch node', () => {
    expect(latestChatBranchLeaf(messages, 'a1-alt')).toBe('a3-alt');
    expect(chatMessagePath(messages, 'a3-alt').map((message) => message.id)).toEqual([
      'u1',
      'a1-alt',
      'u3-alt',
      'a3-alt',
    ]);
  });
});
