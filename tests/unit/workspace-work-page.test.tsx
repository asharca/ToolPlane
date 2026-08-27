import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listAgents: vi.fn(),
  listProviders: vi.fn(),
  listWorkSessions: vi.fn(),
  getWorkSession: vi.fn(),
  surface: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/agents/queries', () => ({
  listAgents: mocks.listAgents,
  listProviders: mocks.listProviders,
}));
vi.mock('@/lib/work/sessions', () => ({
  listWorkSessions: mocks.listWorkSessions,
  getWorkSession: mocks.getWorkSession,
  workSessionWorkingDirectory: () => '.',
}));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: vi.fn() }));
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
    mocks.listWorkSessions.mockResolvedValue([]);
    mocks.getWorkSession.mockResolvedValue(null);
    mocks.listAgents.mockResolvedValue([
      {
        id: 'agent-hermes', name: 'Hermes researcher', runtimeKind: 'hermes',
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
        providerId: null, model: null, provider: null, sandboxes: [], runtime: null,
      },
    ]);
  });

  it('passes every Agent to the sidebar while marking Work support', async () => {
    render(await WorkspaceWorkPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    expect(mocks.surface).toHaveBeenCalledWith(expect.objectContaining({
      agents: [
        expect.objectContaining({
          id: 'agent-hermes',
          supportsWork: true,
          ready: true,
          providerIds: ['provider-1'],
          sandboxes: [expect.objectContaining({ id: 'sandbox-hermes', kind: 'hermes', isDefault: true })],
        }),
        expect.objectContaining({ id: 'agent-pi', supportsWork: true }),
      ],
    }));
  });
});
