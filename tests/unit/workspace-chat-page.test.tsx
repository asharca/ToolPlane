import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listAssistants: vi.fn(),
  getThread: vi.fn(),
  listProviders: vi.fn(),
  listDeployments: vi.fn(),
  listAgents: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  surface: vi.fn(),
  agentSurface: vi.fn(),
  getAssistantMarketTemplate: vi.fn(),
  listAssistantMarketTemplates: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/agents/queries', () => ({
  listProviders: mocks.listProviders,
  listAgentDeploymentOptions: mocks.listDeployments,
  listAgents: mocks.listAgents,
  listConversations: mocks.listConversations,
  getConversation: mocks.getConversation,
}));
vi.mock('@/lib/agents/messaging', () => ({ parseMessagingSessionTitle: () => null }));
vi.mock('@/lib/chat/service', () => ({
  listChatAssistantsForWorkspace: mocks.listAssistants,
  getChatThreadForWorkspace: mocks.getThread,
}));
vi.mock('@/lib/market/skills', () => ({
  getAssistantMarketTemplate: mocks.getAssistantMarketTemplate,
  listAssistantMarketTemplates: mocks.listAssistantMarketTemplates,
}));
vi.mock('@/lib/timezone', () => ({
  resolveUserTimeZone: () => 'UTC',
  formatInTimeZone: (value: Date) => value.toISOString(),
}));
vi.mock('@/components/dashboard/DashboardHeader', () => ({
  DashboardHeader: () => <div>Header</div>,
}));
vi.mock('@/components/dashboard/chat/WorkspaceAssistantChat', () => ({
  WorkspaceAssistantChat: (props: unknown) => {
    mocks.surface(props);
    return <div>Chat surface</div>;
  },
}));
vi.mock('@/components/dashboard/agents/WorkspaceChat', () => ({
  WorkspaceChat: (props: unknown) => {
    mocks.agentSurface(props);
    return <div>Agent chat surface</div>;
  },
}));

import WorkspaceChatPage from '@/app/app/[workspace]/chat/page';

describe('Workspace chat page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.listProviders.mockResolvedValue([]);
    mocks.listDeployments.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue([]);
    mocks.listConversations.mockResolvedValue([]);
    mocks.getConversation.mockResolvedValue(null);
    mocks.getAssistantMarketTemplate.mockResolvedValue(null);
    mocks.listAssistantMarketTemplates.mockResolvedValue([]);
    mocks.listAssistants.mockResolvedValue([{
      id: 'assistant-1',
      name: 'Helper',
      systemPrompt: null,
      modelProviderId: null,
      model: null,
      maxSteps: 8,
      modelProvider: null,
      mcpGrants: [],
      threads: [{
        id: 'thread-recent',
        title: 'Recent',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        messages: [],
      }],
    }]);
    mocks.getThread.mockResolvedValue({
      id: 'thread-old',
      assistantId: 'assistant-1',
      title: 'Older direct link',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      messages: [{
        id: 'message-old',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Loaded directly' }],
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
      }],
    });
  });

  it('loads an unlisted thread through the workspace and assistant boundary', async () => {
    render(await WorkspaceChatPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ assistant: 'assistant-1', thread: 'thread-old' }),
    }));

    expect(mocks.getThread).toHaveBeenCalledWith(
      'workspace-1',
      'assistant-1',
      'thread-old',
    );
    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      selectedAssistantId: 'assistant-1',
      selectedThreadId: 'thread-old',
      initialMessages: [expect.objectContaining({ id: 'message-old' })],
      assistants: [expect.objectContaining({
        threads: [
          expect.objectContaining({ id: 'thread-old' }),
          expect.objectContaining({ id: 'thread-recent' }),
        ],
      })],
    }));
  });

  it('opens the assistant creator from a direct market handoff', async () => {
    render(await WorkspaceChatPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ newAssistant: '1' }),
    }));

    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      startCreating: true,
      marketTemplates: [],
    }));
    expect(mocks.listAssistantMarketTemplates).toHaveBeenCalledWith({ limit: 12 });
  });

  it('resolves a market assistant template and matches portable resources', async () => {
    mocks.listProviders.mockResolvedValue([{
      id: 'provider-1', name: 'Anthropic', format: 'anthropic', models: ['claude-sonnet'],
    }]);
    mocks.listDeployments.mockResolvedValue([
      {
        id: 'deployment-1',
        label: 'Catalog search',
        catalogSlug: 'web-search',
        status: 'running',
        keywords: ['search'],
      },
      {
        id: 'deployment-decoy',
        label: 'Web Search',
        catalogSlug: 'different-server',
        status: 'running',
        keywords: ['web-search'],
      },
    ]);
    mocks.getAssistantMarketTemplate.mockResolvedValue({
      releaseId: 'release-1',
      listing: { summary: 'Research assistant', tags: ['research'] },
      manifest: {
        assistant: {
          name: 'Researcher',
          systemPrompt: 'Use primary sources.',
          maxSteps: 10,
          modelRequirement: { providerFormat: 'anthropic', model: 'claude-sonnet' },
          mcpRequirements: [{ catalogSlug: 'web-search', name: 'Web Search' }],
        },
      },
    });

    render(await WorkspaceChatPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ newAssistant: '1', template: 'release-1' }),
    }));

    expect(mocks.getAssistantMarketTemplate).toHaveBeenCalledWith('release-1');
    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      marketTemplate: expect.objectContaining({
        releaseId: 'release-1',
        providerFormat: 'anthropic',
        model: 'claude-sonnet',
        deploymentIds: ['deployment-1'],
      }),
      marketTemplates: [expect.objectContaining({
        releaseId: 'release-1',
        tags: ['research'],
      })],
    }));
  });

  it('routes a Hermes agent query to the existing agent chat surface', async () => {
    mocks.listProviders.mockResolvedValue([{
      id: 'provider-1',
      name: 'OpenAI',
      format: 'openai',
      models: ['gpt-5'],
    }]);
    mocks.listAgents.mockResolvedValue([{
      id: 'agent-hermes',
      name: 'Hermes researcher',
      runtimeKind: 'hermes',
      providerId: null,
      model: null,
      provider: null,
      modelProviders: [{
        providerId: 'provider-1',
        provider: { name: 'OpenAI', models: ['gpt-5'] },
      }],
      sandboxes: [],
    }]);
    mocks.listConversations.mockResolvedValue([{
      id: 'conversation-1',
      agentId: 'agent-hermes',
      title: 'Hermes chat',
      createdAt: new Date('2026-08-26T00:00:00.000Z'),
      messages: [{ createdAt: new Date('2026-08-26T00:01:00.000Z') }],
      publicApiConversation: null,
    }]);
    mocks.getConversation.mockResolvedValue({
      id: 'conversation-1',
      agentId: 'agent-hermes',
      workSession: null,
      messages: [{
        id: 'message-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Ready' }],
      }],
    });

    render(await WorkspaceChatPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ agent: 'agent-hermes', c: 'conversation-1' }),
    }));

    expect(mocks.listAssistants).not.toHaveBeenCalled();
    expect(mocks.agentSurface).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      agentId: 'agent-hermes',
      conversationId: 'conversation-1',
      initialMessages: [expect.objectContaining({ id: 'message-1' })],
      agents: [expect.objectContaining({
        id: 'agent-hermes',
        runtimeKind: 'hermes',
        ready: true,
        providerIds: ['provider-1'],
      })],
    }));
  });
});
