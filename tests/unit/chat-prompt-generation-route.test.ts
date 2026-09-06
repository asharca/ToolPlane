// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyApiTokenContext: vi.fn(),
  getCurrentUser: vi.fn(),
  getChatPromptGenerationModel: vi.fn(),
  runNativeAgent: vi.fn(),
}));

vi.mock('@/lib/auth/tokens', () => ({
  verifyApiToken: vi.fn(),
  verifyApiTokenContext: mocks.verifyApiTokenContext,
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/chat/service', () => ({
  ChatServiceError: class ChatServiceError extends Error {},
  getChatPromptGenerationModel: mocks.getChatPromptGenerationModel,
}));
vi.mock('@/lib/agents/native', () => ({ runNativeAgent: mocks.runNativeAgent }));

import { POST } from '@/app/api/v1/chat/assistants/generate-prompt/route';

describe('chat assistant prompt generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getChatPromptGenerationModel.mockResolvedValue({
      id: 'provider-1',
      name: 'Provider',
      format: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
    });
    mocks.runNativeAgent.mockResolvedValue('Be concise and cite primary sources.');
  });

  it('uses the selected workspace model without exposing its credentials', async () => {
    const response = await POST(new Request('http://toolplane.test/api/v1/chat/assistants/generate-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace-1',
        modelProviderId: 'provider-1',
        model: 'gpt-x',
        name: 'Research helper',
        description: 'Finds primary sources.',
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ prompt: 'Be concise and cite primary sources.' });
    expect(mocks.getChatPromptGenerationModel).toHaveBeenCalledWith('user-1', {
      workspaceId: 'workspace-1',
      modelProviderId: 'provider-1',
      model: 'gpt-x',
      name: 'Research helper',
      description: 'Finds primary sources.',
    });
    expect(mocks.runNativeAgent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'gpt-x',
      maxSteps: 1,
      modelParameters: { temperature: 0.4, maxOutputTokens: 4_096 },
      tools: {},
    }));
  });

  it('rejects toolkit-scoped credentials before invoking a model', async () => {
    mocks.verifyApiTokenContext.mockResolvedValue({
      user: { id: 'user-1' },
      token: { id: 'token-1', toolkitId: 'toolkit-1' },
    });

    const response = await POST(new Request('http://toolplane.test/api/v1/chat/assistants/generate-prompt', {
      method: 'POST',
      headers: { authorization: 'Bearer toolkit-token' },
    }));

    expect(response.status).toBe(401);
    expect(mocks.getChatPromptGenerationModel).not.toHaveBeenCalled();
    expect(mocks.runNativeAgent).not.toHaveBeenCalled();
  });
});
