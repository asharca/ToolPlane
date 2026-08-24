import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    conversation: {
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
    },
  },
}));

import { deleteConsoleConversation, renameConsoleConversation } from '@/lib/agents/mutations';

describe('console conversation mutations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not alter externally routed or public API conversations', async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: 'conversation-1', title: 'msg:telegram:dm:123', publicApiConversation: null });
    await expect(renameConsoleConversation('workspace-1', 'agent-1', 'conversation-1', 'Renamed')).resolves.toBe(false);

    mocks.findFirst.mockResolvedValueOnce({ id: 'conversation-2', title: 'Private API chat', publicApiConversation: { id: 'public-1' } });
    await expect(deleteConsoleConversation('workspace-1', 'agent-1', 'conversation-2')).resolves.toBe(false);

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('updates workspace-owned console conversations only', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'conversation-1', title: 'Old title', publicApiConversation: null });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(renameConsoleConversation('workspace-1', 'agent-1', 'conversation-1', 'New title')).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-1', agentId: 'agent-1', agent: { workspaceId: 'workspace-1' } },
      data: { title: 'New title' },
    });
  });
});
