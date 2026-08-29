// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyApiToken: vi.fn(),
  verifyApiTokenContext: vi.fn(),
  getCurrentUser: vi.fn(),
  createChatAssistant: vi.fn(),
  updateChatAssistant: vi.fn(),
}));

vi.mock('@/lib/auth/tokens', () => ({
  verifyApiToken: mocks.verifyApiToken,
  verifyApiTokenContext: mocks.verifyApiTokenContext,
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/chat/service', () => ({
  ChatServiceError: class ChatServiceError extends Error {},
  createChatAssistant: mocks.createChatAssistant,
  deleteChatAssistant: vi.fn(),
  getChatAssistantForUser: vi.fn(),
  listChatAssistantsForUser: vi.fn(),
  updateChatAssistant: mocks.updateChatAssistant,
}));

import { POST } from '@/app/api/v1/chat/assistants/route';
import { PATCH } from '@/app/api/v1/chat/assistants/[assistantId]/route';

describe('chat assistant route authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: 'user-1' },
      token: { id: 'token-1', toolkitId: 'toolkit-1' },
    });
  });

  it('rejects scoped credentials before collection or item mutations run', async () => {
    const create = await POST(new Request('http://toolplane.test/api/v1/chat/assistants', {
      method: 'POST',
      headers: { authorization: 'Bearer toolkit-token' },
    }));
    const update = await PATCH(new Request('http://toolplane.test/api/v1/chat/assistants/assistant-1', {
      method: 'PATCH',
      headers: { authorization: 'Bearer toolkit-token' },
    }), { params: Promise.resolve({ assistantId: 'assistant-1' }) });

    expect(create.status).toBe(401);
    expect(update.status).toBe(401);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.createChatAssistant).not.toHaveBeenCalled();
    expect(mocks.updateChatAssistant).not.toHaveBeenCalled();
  });
});
