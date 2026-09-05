// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  turnUpdateMany: vi.fn(),
  turnCreate: vi.fn(),
  turnFindFirst: vi.fn(),
  assistantFindMany: vi.fn(),
  assistantFindFirst: vi.fn(),
  assistantUpdate: vi.fn(),
  queryRaw: vi.fn(),
  messageCreate: vi.fn(),
  messageDelete: vi.fn(),
  messageFindMany: vi.fn(),
  threadFindFirst: vi.fn(),
  threadFindUnique: vi.fn(),
  threadUpdate: vi.fn(),
  threadUpdateMany: vi.fn(),
  messageFindFirst: vi.fn(),
  messageUpdate: vi.fn(),
  messageUpdateMany: vi.fn(),
  rootMessageUpdateMany: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  attachmentFindUnique: vi.fn(),
}));

const tx = {
  $queryRaw: mocks.queryRaw,
  chatAssistant: { findFirst: mocks.assistantFindFirst, update: mocks.assistantUpdate },
  chatTurn: { create: mocks.turnCreate, findFirst: mocks.turnFindFirst, updateMany: mocks.turnUpdateMany },
  chatMessage: {
    create: mocks.messageCreate,
    delete: mocks.messageDelete,
    findFirst: mocks.messageFindFirst,
    findMany: mocks.messageFindMany,
    update: mocks.messageUpdate,
    updateMany: mocks.messageUpdateMany,
  },
  chatThread: {
    findFirst: mocks.threadFindFirst,
    findUnique: mocks.threadFindUnique,
    update: mocks.threadUpdate,
    updateMany: mocks.threadUpdateMany,
  },
  workspaceAttachment: {
    updateMany: mocks.attachmentUpdateMany,
    findUnique: mocks.attachmentFindUnique,
  },
};

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    chatTurn: { updateMany: mocks.turnUpdateMany },
    chatMessage: { updateMany: mocks.rootMessageUpdateMany },
    chatAssistant: {
      findMany: mocks.assistantFindMany,
      findFirst: mocks.assistantFindFirst,
    },
    chatThread: { findFirst: mocks.threadFindFirst, update: mocks.threadUpdate },
  },
}));

import {
  beginChatTurn,
  CHAT_TURN_STALE_AFTER_MS,
  ChatServiceError,
  completeChatTurn,
  finishChatTurn,
  getChatThreadForWorkspace,
  listChatAssistantsForWorkspace,
  reserveChatBranch,
  updateChatAssistant,
  updateChatThread,
} from '@/lib/chat/service';

describe('Chat turn admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:10:00.000Z'));
    mocks.threadFindFirst.mockResolvedValue({ id: 'thread-1' });
    mocks.turnUpdateMany.mockResolvedValue({ count: 0 });
    mocks.turnCreate.mockResolvedValue({ id: 'turn-1', threadId: 'thread-1', status: 'pending' });
    mocks.turnFindFirst.mockResolvedValue(null);
    mocks.assistantFindMany.mockResolvedValue([]);
    mocks.assistantFindFirst.mockResolvedValue({ id: 'assistant-2' });
    mocks.assistantUpdate.mockResolvedValue({ id: 'assistant-1', pinned: true });
    mocks.queryRaw.mockResolvedValue([]);
    mocks.messageCreate.mockImplementation(async ({ data }: { data: { role: string } }) => ({
      id: data.role === 'assistant' ? 'assistant-1' : 'user-1',
    }));
    mocks.messageDelete.mockResolvedValue({ id: 'message-1' });
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.messageUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
    mocks.messageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.rootMessageUpdateMany.mockResolvedValue({ count: 0 });
    mocks.threadFindUnique.mockResolvedValue({ activeMessageId: null, title: null, workspaceId: 'workspace-1' });
    mocks.threadUpdate.mockResolvedValue({ id: 'thread-1' });
    mocks.threadUpdateMany.mockResolvedValue({ count: 1 });
    mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authorizes before locking and reserves stable user and assistant messages', async () => {
    await expect(beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Hello' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
      { modelId: 'model-1' },
    )).resolves.toMatchObject({
      assistantMessageId: 'assistant-1',
      assistantParentId: 'user-1',
      historyLeafId: 'user-1',
    });

    expect(mocks.threadFindFirst.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.transaction.mock.invocationCallOrder[0]);
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        threadId: 'thread-1',
        turnId: 'turn-1',
        parentId: null,
        role: 'user',
      }),
    });
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        threadId: 'thread-1',
        turnId: 'turn-1',
        parentId: 'user-1',
        role: 'assistant',
        status: 'pending',
        modelId: 'model-1',
        parts: [],
      }),
    });
    expect(mocks.threadUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activeMessageId: 'assistant-1' }),
    }));
  });

  it('rejects an unauthorized thread before stale cleanup or a transaction', async () => {
    mocks.threadFindFirst.mockResolvedValueOnce(null);

    await expect(beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Hello' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
    )).rejects.toMatchObject({ status: 404 });

    expect(mocks.turnUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('fails stale pending turns before admitting a new turn', async () => {
    await expect(beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Hello' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
    ))
      .resolves.toMatchObject({ id: 'turn-1' });

    expect(mocks.turnUpdateMany).toHaveBeenCalledWith({
      where: {
        threadId: 'thread-1',
        status: 'pending',
        createdAt: {
          lt: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS),
        },
      },
      data: {
        status: 'failed',
        error: 'Chat turn expired before completion.',
        completedAt: new Date(),
      },
    });
    expect(mocks.turnCreate).toHaveBeenCalledWith({ data: { threadId: 'thread-1' } });
  });

  it('maps the pending-turn unique constraint race to conflict', async () => {
    mocks.transaction.mockRejectedValue({ code: 'P2002' });

    const promise = beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Hello' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
    );
    await expect(promise).rejects.toBeInstanceOf(ChatServiceError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      message: 'A chat turn is already running',
    });
  });

  it('claims internal attachments in the same transaction as the user message', async () => {
    const parts = [{ type: 'file', url: '/api/v1/attachments/attachment-1' }];

    await beginChatTurn(
      'thread-1',
      parts,
      { workspaceId: 'workspace-1', userId: 'user-1' },
    );

    expect(mocks.attachmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'attachment-1',
        workspaceId: 'workspace-1',
        uploadedById: 'user-1',
      }),
      data: { chatThreadId: 'thread-1' },
    }));
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ parts }),
    });
  });

  it('ignores a temporary client message id for a new submit', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: 'assistant-current',
      title: 'Existing thread',
      workspaceId: 'workspace-1',
    });

    await beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Next question' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
      { trigger: 'submit-message', clientLastMessageId: 'client-temp-id' },
    );

    expect(mocks.messageFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'assistant-current',
        threadId: 'thread-1',
        role: 'user',
        parts: { equals: [] },
      },
      select: { id: true },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ parentId: 'assistant-current', role: 'user' }),
    });
  });

  it('fills an active reserved branch before creating its pending assistant', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: 'reserved-user',
      title: 'Existing thread',
      workspaceId: 'workspace-1',
    });
    mocks.messageFindFirst.mockResolvedValueOnce({ id: 'reserved-user' });

    await beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Continue this branch' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
    );

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: 'reserved-user' },
      data: {
        turnId: 'turn-1',
        status: 'success',
        parts: [{ type: 'text', text: 'Continue this branch' }],
      },
    });
    expect(mocks.messageCreate).toHaveBeenCalledOnce();
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentId: 'reserved-user',
        role: 'assistant',
        status: 'pending',
      }),
    });
  });

  it('creates an explicit assistant sibling when regenerating a successful reply', async () => {
    mocks.messageFindFirst.mockResolvedValueOnce({
      id: 'assistant-old',
      parentId: 'user-1',
      siblingGroupId: null,
      turnId: 'turn-old',
      role: 'assistant',
      status: 'success',
      parts: [{ type: 'text', text: 'Old answer' }],
    });

    const turn = await beginChatTurn(
      'thread-1',
      [],
      { workspaceId: 'workspace-1', userId: 'user-1' },
      { trigger: 'regenerate-message', messageId: 'assistant-old', modelId: 'model-old' },
    );

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: 'assistant-old' },
      data: { siblingGroupId: 'turn-1' },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentId: 'user-1',
        siblingGroupId: 'turn-1',
        role: 'assistant',
        status: 'pending',
        modelId: 'model-old',
      }),
    });
    expect(turn.assistantMessageId).toBe('assistant-1');
  });

  it('retries a failed assistant placeholder in place', async () => {
    mocks.messageFindFirst.mockResolvedValueOnce({
      id: 'assistant-failed',
      parentId: 'user-1',
      siblingGroupId: null,
      turnId: 'turn-old',
      role: 'assistant',
      status: 'failed',
      parts: [],
    });

    const turn = await beginChatTurn(
      'thread-1',
      [],
      { workspaceId: 'workspace-1', userId: 'user-1' },
      { trigger: 'regenerate-message', messageId: 'assistant-failed', modelId: 'model-old' },
    );

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: 'assistant-failed' },
      data: {
        turnId: 'turn-1',
        status: 'pending',
        modelId: 'model-old',
        parts: [],
      },
    });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(turn.assistantMessageId).toBe('assistant-failed');
  });

  it('creates two selectable empty branches when branching from a leaf', async () => {
    mocks.threadFindUnique.mockResolvedValueOnce({
      id: 'thread-1',
      activeMessageId: 'assistant-leaf',
      turns: [],
    });
    mocks.messageFindFirst.mockResolvedValueOnce({ id: 'assistant-leaf', children: [] });
    mocks.messageCreate
      .mockResolvedValueOnce({ id: 'empty-1' })
      .mockResolvedValueOnce({ id: 'empty-2' });

    const branch = await reserveChatBranch('user-1', 'thread-1', 'assistant-leaf');

    expect(mocks.messageCreate).toHaveBeenCalledTimes(2);
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ parentId: 'assistant-leaf', role: 'user', parts: [] }),
    });
    expect(mocks.messageCreate.mock.calls[0]?.[0].data).not.toHaveProperty('siblingGroupId');
    expect(branch).toMatchObject({
      messages: [{ id: 'empty-1' }, { id: 'empty-2' }],
      activeMessageId: 'empty-2',
      activated: true,
    });
  });

  it('commits a completed reply and its turn in one transaction', async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.messageUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(completeChatTurn(
      'thread-1',
      'turn-1',
      'assistant-1',
      [{ type: 'text', text: 'Done' }],
    )).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'assistant-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        role: 'assistant',
        status: 'pending',
      },
      data: { status: 'success', parts: [{ type: 'text', text: 'Done' }] },
    });
  });

  it('persists a failed assistant placeholder with its turn', async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.messageUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(finishChatTurn(
      'thread-1',
      'turn-1',
      'failed',
      'provider failed',
      'assistant-1',
    )).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'assistant-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'pending',
      },
      data: { status: 'failed' },
    });
  });

  it('does not hide unrelated database failures', async () => {
    const failure = new Error('database unavailable');
    mocks.transaction.mockRejectedValue(failure);

    await expect(beginChatTurn(
      'thread-1',
      [],
      { workspaceId: 'workspace-1', userId: 'user-1' },
    )).rejects.toBe(failure);
  });

  it('scopes direct thread reads to both workspace and assistant', async () => {
    mocks.threadFindFirst.mockResolvedValue({ activeMessageId: null, id: 'thread-1', messages: [] });

    await getChatThreadForWorkspace('workspace-1', 'assistant-1', 'thread-1');

    expect(mocks.threadFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'thread-1',
        workspaceId: 'workspace-1',
        assistantId: 'assistant-1',
      },
    }));
  });

  it('projects only the active branch for a direct thread read', async () => {
    const createdAt = new Date();
    mocks.threadFindFirst.mockResolvedValue({
      activeMessageId: 'a-active',
      id: 'thread-1',
      messages: [
        { id: 'u-root', parentId: null, siblingGroupId: null, role: 'user', status: 'success', modelId: null, parts: [{ type: 'text', text: 'Hello' }], createdAt },
        { id: 'a-old', parentId: 'u-root', siblingGroupId: 'answers', role: 'assistant', status: 'success', modelId: 'model-1', parts: [], createdAt },
        { id: 'a-active', parentId: 'u-root', siblingGroupId: 'answers', role: 'assistant', status: 'success', modelId: 'model-1', parts: [], createdAt },
      ],
    });

    const thread = await getChatThreadForWorkspace('workspace-1', 'assistant-1', 'thread-1');

    expect(thread?.messages.map((message) => message.id)).toEqual(['u-root', 'a-active']);
    expect(thread?.branch.navigation).toEqual([expect.objectContaining({
      messageId: 'a-active',
      position: 2,
      total: 2,
      previousMessageId: 'a-old',
    })]);
  });

  it('switches a branch node to the latest leaf in its subtree', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      id: 'thread-1',
      messages: [
        { id: 'u-root', parentId: null, siblingGroupId: null, role: 'user' },
        { id: 'a-old', parentId: 'u-root', siblingGroupId: null, role: 'assistant' },
        { id: 'u-old', parentId: 'a-old', siblingGroupId: 'questions', role: 'user' },
        { id: 'a-old-leaf', parentId: 'u-old', siblingGroupId: null, role: 'assistant' },
        { id: 'u-new', parentId: 'a-old', siblingGroupId: 'questions', role: 'user' },
        { id: 'a-new-leaf', parentId: 'u-new', siblingGroupId: null, role: 'assistant' },
      ],
    });

    await updateChatThread('user-1', 'thread-1', { activeMessageId: 'a-old' });

    expect(mocks.threadUpdate).toHaveBeenCalledWith({
      where: { id: 'thread-1' },
      data: { activeMessageId: 'a-new-leaf' },
    });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
  });

  it('lists pinned assistants first without changing thread ordering', async () => {
    await listChatAssistantsForWorkspace('workspace-1');

    expect(mocks.assistantFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 'workspace-1' },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      include: expect.objectContaining({
        threads: expect.objectContaining({ orderBy: { updatedAt: 'desc' } }),
      }),
    }));
  });

  it('updates an assistant pinned state after workspace authorization', async () => {
    mocks.assistantFindFirst.mockResolvedValue({
      id: 'assistant-1',
      workspaceId: 'workspace-1',
    });

    await updateChatAssistant('user-1', 'assistant-1', { pinned: true });

    expect(mocks.assistantUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'assistant-1' },
      data: { pinned: true },
    }));
  });

  it('moves a thread only to an assistant in the same workspace', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      assistantId: 'assistant-1',
      id: 'thread-1',
      messages: [],
      workspaceId: 'workspace-1',
    });

    await updateChatThread('user-1', 'thread-1', { assistantId: 'assistant-2' });

    expect(mocks.assistantFindFirst).toHaveBeenCalledWith({
      where: { id: 'assistant-2', workspaceId: 'workspace-1' },
      select: { id: true },
    });
    expect(mocks.threadUpdate).toHaveBeenCalledWith({
      where: { id: 'thread-1' },
      data: { assistantId: 'assistant-2' },
    });
  });

  it('rejects moving a thread while a turn is running', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      assistantId: 'assistant-1',
      id: 'thread-1',
      messages: [],
      workspaceId: 'workspace-1',
    });
    mocks.turnFindFirst.mockResolvedValue({ id: 'turn-1' });

    await expect(updateChatThread('user-1', 'thread-1', { assistantId: 'assistant-2' }))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.threadUpdate).not.toHaveBeenCalled();
  });

  it('rejects moving a thread to an assistant outside its workspace', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      assistantId: 'assistant-1',
      id: 'thread-1',
      messages: [],
      workspaceId: 'workspace-1',
    });
    mocks.assistantFindFirst.mockResolvedValue(null);

    await expect(updateChatThread('user-1', 'thread-1', { assistantId: 'assistant-other' }))
      .rejects.toMatchObject({ status: 404 });
    expect(mocks.threadUpdate).not.toHaveBeenCalled();
  });

  it('rejects a turn when the thread moved after assistant resolution', async () => {
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: null,
      assistantId: 'assistant-2',
      title: null,
      workspaceId: 'workspace-1',
    });

    await expect(beginChatTurn(
      'thread-1',
      [{ type: 'text', text: 'Hello' }],
      { workspaceId: 'workspace-1', userId: 'user-1' },
      { expectedAssistantId: 'assistant-1' },
    )).rejects.toMatchObject({ status: 409 });
    expect(mocks.turnCreate).not.toHaveBeenCalled();
  });
});
