import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { redirect } from 'next/navigation';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listAgents: vi.fn(),
  listProviders: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  listWorkSessions: vi.fn(),
  getWorkSession: vi.fn(),
  effectiveStatus: vi.fn(),
  surface: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('not found'); } }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/agents/queries', () => ({
  listAgents: mocks.listAgents,
  listProviders: mocks.listProviders,
  listConversations: mocks.listConversations,
  getConversation: mocks.getConversation,
}));
vi.mock('@/lib/work/sessions', () => ({
  listWorkSessions: mocks.listWorkSessions,
  getWorkSession: mocks.getWorkSession,
  workSessionWorkingDirectory: () => '.',
}));
vi.mock('@/lib/work/coordinator', () => ({ isWorkSessionTitlePending: () => false }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: mocks.effectiveStatus }));
vi.mock('@/lib/agents/model', () => ({ resolveModelContext: vi.fn() }));
vi.mock('@/components/dashboard/DashboardHeader', () => ({ DashboardHeader: () => null }));
vi.mock('@/components/dashboard/work/WorkspaceWork', () => ({
  WorkspaceWork: (props: unknown) => {
    mocks.surface(props);
    return <div>Work surface</div>;
  },
}));

import WorkspaceWorkPage from '@/app/app/[workspace]/work/page';

describe('Workspace Work page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.listProviders.mockResolvedValue([]);
    mocks.listConversations.mockResolvedValue([]);
    mocks.getConversation.mockResolvedValue(null);
    mocks.listWorkSessions.mockResolvedValue([]);
    mocks.getWorkSession.mockResolvedValue(null);
    mocks.effectiveStatus.mockReturnValue('provisioning');
    mocks.cookies.mockResolvedValue({ get: vi.fn().mockReturnValue(undefined) });
    mocks.listAgents.mockResolvedValue([
      {
        id: 'agent-hermes', name: 'Hermes researcher', runtimeKind: 'hermes',
        pinned: true,
        providerId: null, model: null, provider: null,
        modelProviders: [{ providerId: 'provider-1', provider: { name: 'OpenAI', models: [] } }],
        sandboxes: [],
        runtime: {
          kind: 'hermes',
          sandbox: {
            id: 'sandbox-hermes', name: 'Hermes researcher runtime', kind: 'hermes', network: 'isolated',
            deploymentId: 'deployment-hermes', deployment: { status: 'stopped' },
          },
        },
      },
      {
        id: 'agent-pi', name: 'Pi worker', runtimeKind: 'pi',
        pinned: false,
        providerId: null, model: null, provider: null, sandboxes: [], runtime: null,
      },
    ]);
  });

  it('passes every Agent to the sidebar while marking Work support', async () => {
    render(await WorkspaceWorkPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ agent: 'agent-pi' }),
    }));

    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      requestedAgentId: 'agent-pi',
      agents: [
        expect.objectContaining({
          id: 'agent-hermes',
          pinned: true,
          supportsWork: true,
          ready: true,
          providerIds: ['provider-1'],
          sandboxes: [expect.objectContaining({
            id: 'sandbox-hermes', kind: 'hermes', status: 'provisioning', running: false, isDefault: true,
          })],
        }),
        expect.objectContaining({ id: 'agent-pi', pinned: false, supportsWork: true }),
      ],
    }));
  });

  it('seeds the Work sidebar from its workspace cookie', async () => {
    mocks.cookies.mockResolvedValue({ get: vi.fn().mockReturnValue({ value: 'false' }) });

    render(await WorkspaceWorkPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({ initialSidebarOpen: false }));
  });

  it('seeds Work agent disclosures from its workspace cookie', async () => {
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) => name === 'toolplane_work_agent_groups_workspace-1'
        ? { value: '%7B%22agent-pi%22%3Afalse%7D' }
        : undefined),
    });

    render(await WorkspaceWorkPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      initialExpandedAgents: { 'agent-pi': false },
    }));
  });

  it('seeds Work agent groups from its workspace cookie', async () => {
    mocks.cookies.mockResolvedValue({
      get: vi.fn((name: string) => name === 'toolplane_work_agent_group_preferences_workspace-1'
        ? { value: '%7B%22groups%22%3A%5B%7B%22id%22%3A%22group-1%22%2C%22name%22%3A%22Engineering%22%7D%5D%2C%22assignments%22%3A%7B%22agent-pi%22%3A%22group-1%22%7D%2C%22collapsed%22%3A%7B%22group-1%22%3Afalse%7D%7D' }
        : undefined),
    });

    render(await WorkspaceWorkPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      initialGroupPreferences: {
        groups: [{ id: 'group-1', name: 'Engineering' }],
        assignments: { 'agent-pi': 'group-1' },
        collapsed: { 'group-1': false },
      },
    }));
  });

  it('includes existing channel history without converting it into a Work session', async () => {
    const agents = await mocks.listAgents();
    agents[1]._count = { channels: 1 };
    mocks.listConversations.mockResolvedValue([
      { id: 'wechat-history', agentId: 'agent-pi', title: 'msg:weixin:dm:contact' },
      { id: 'ordinary-chat', agentId: 'agent-pi', title: 'Notes' },
    ]);

    render(await WorkspaceWorkPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    expect(mocks.listConversations).toHaveBeenCalledWith('workspace-1', ['agent-hermes', 'agent-pi']);
    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      hasChannels: true,
      sessions: [],
      conversations: [{
        id: 'wechat-history', agentId: 'agent-pi', title: 'msg:weixin:dm:contact',
        source: { platform: 'weixin', chatType: 'dm', chatId: 'contact' },
      }, { id: 'ordinary-chat', agentId: 'agent-pi', title: 'Notes', source: null }],
    }));
  });

  it('loads channel history into the same Work surface without creating a task', async () => {
    mocks.getConversation.mockResolvedValue({
      id: 'wechat-history', agentId: 'agent-pi', title: 'msg:weixin:dm:contact',
      workSession: null, publicApiConversation: null, reasoningEffort: null,
      messages: [{ id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'WeChat reply' }], createdAt: new Date('2026-09-06T00:00:00Z') }],
    });
    render(await WorkspaceWorkPage({ params: Promise.resolve({ workspace: 'acme' }), searchParams: Promise.resolve({ agent: 'agent-pi', c: 'wechat-history' }) }));
    expect(mocks.getConversation).toHaveBeenCalledWith('wechat-history', 'workspace-1');
    expect(mocks.getWorkSession).not.toHaveBeenCalled();
    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkSessionId: null,
      selectedConversation: expect.objectContaining({
        id: 'wechat-history', agentId: 'agent-pi', readOnly: true,
        source: { platform: 'weixin', chatType: 'dm', chatId: 'contact' },
        messages: [expect.objectContaining({ id: 'reply', createdAt: '2026-09-06T00:00:00.000Z' })],
      }),
    }));
  });

  it.each([null, { id: 'history', agentId: 'other-agent' }, { id: 'history', agentId: 'agent-hermes' }])('rejects missing, hidden, or differently bound history: %s', async (conversation) => {
    mocks.getConversation.mockResolvedValue(conversation);
    await expect(WorkspaceWorkPage({ params: Promise.resolve({ workspace: 'acme' }), searchParams: Promise.resolve({ agent: 'agent-pi', c: 'history' }) })).rejects.toThrow('not found');
    expect(mocks.surface).not.toHaveBeenCalled();
  });

  it('resolves an old Work conversation link to its existing task', async () => {
    mocks.getConversation.mockResolvedValue({ id: 'history', agentId: 'agent-pi', workSession: { id: 'work-1' } });
    await WorkspaceWorkPage({ params: Promise.resolve({ workspace: 'acme' }), searchParams: Promise.resolve({ c: 'history' }) });
    expect(redirect).toHaveBeenCalledWith('/app/acme/work?w=work-1');
  });

  it('preserves ordinary Hermes chat selection inside Work', async () => {
    mocks.getConversation.mockResolvedValue({ id: 'history', agentId: 'agent-hermes', title: 'Notes',
      workSession: null, publicApiConversation: null, hermesProfile: 'research', hermesProvider: 'provider-1', hermesModel: 'model-1', messages: [] });
    render(await WorkspaceWorkPage({ params: Promise.resolve({ workspace: 'acme' }), searchParams: Promise.resolve({ c: 'history' }) }));
    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({ selectedConversation: expect.objectContaining({
      id: 'history', agentId: 'agent-hermes', readOnly: false, hermesProfile: 'research', hermesProvider: 'provider-1', hermesModel: 'model-1',
    }) }));
  });
});
