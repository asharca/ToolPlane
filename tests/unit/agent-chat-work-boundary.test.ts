// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  conversationFindFirst: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/agents/queries', () => ({ getAgentForRequest: mocks.getAgentForRequest }));
vi.mock('@/lib/db', () => ({
  db: { conversation: { findFirst: mocks.conversationFindFirst } },
}));
vi.mock('@/lib/agents/mutations', () => ({
  appendMessage: vi.fn(),
  ensureConversationRuntimeSession: vi.fn(),
}));
vi.mock('@/lib/agents/resolve', () => ({ resolveAgentTools: vi.fn() }));
vi.mock('@/lib/agents/system-prompt', () => ({ assembleSystemPrompt: vi.fn() }));
vi.mock('@/lib/agents/run', () => ({ buildAgentToolSet: vi.fn() }));
vi.mock('@/lib/agents/native', () => ({ uiMessagesToPi: vi.fn(), runNativeAgent: vi.fn() }));
vi.mock('@/lib/agents/hermes/client', () => ({ writeHermesChatStream: vi.fn() }));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: vi.fn(),
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR: 'Runtime busy',
}));
vi.mock('@/lib/agents/hermes/message-segments', () => ({ hermesAssistantSegments: vi.fn() }));

import { POST } from '@/app/api/v1/agents/[agentId]/chat/route';

const context = { params: Promise.resolve({ agentId: 'agent-1' }) };

function request(body: unknown) {
  return new Request('http://toolplane.test/api/v1/agents/agent-1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Chat and Work execution boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtimeKind: 'pi',
      runtime: null,
      provider: { id: 'provider-1' },
      model: 'model-1',
      modelProviders: [],
    });
  });

  it('rejects the legacy workSessionId transport', async () => {
    const response = await POST(request({ messages: [], workSessionId: 'work-1' }), context);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Work sessions must use the Work API');
    expect(mocks.conversationFindFirst).not.toHaveBeenCalled();
  });

  it('does not let Chat write into a Work conversation', async () => {
    mocks.conversationFindFirst.mockResolvedValue({
      id: 'conversation-1',
      workSession: { id: 'work-1' },
    });
    const response = await POST(request({ messages: [], conversationId: 'conversation-1' }), context);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Work conversations must use the Work API');
  });

  it('requires a saved Agent conversation for native attachments', async () => {
    const response = await POST(request({
      messages: [{
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'file', url: '/api/v1/attachments/attachment-1' }],
      }],
    }), context);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Attachments require a saved conversation.');
  });
});
