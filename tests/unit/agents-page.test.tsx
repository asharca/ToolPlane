import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
  getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'workspace-1' }),
  listAgents: vi.fn().mockResolvedValue([]),
  listProviders: vi.fn().mockResolvedValue([]),
  listAgentDeploymentOptions: vi.fn().mockResolvedValue([]),
  listAgentSkillOptions: vi.fn().mockResolvedValue([]),
  listToolkits: vi.fn().mockResolvedValue([]),
  listAgentMarketListings: vi.fn().mockResolvedValue({ items: [] }),
  sandboxFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn().mockResolvedValue((key: string) => key) }));
vi.mock('@/lib/db', () => ({ db: { sandbox: { findMany: mocks.sandboxFindMany } } }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/agents/queries', () => ({
  listAgents: mocks.listAgents,
  listProviders: mocks.listProviders,
  listAgentDeploymentOptions: mocks.listAgentDeploymentOptions,
  listAgentSkillOptions: mocks.listAgentSkillOptions,
}));
vi.mock('@/lib/toolkits/queries', () => ({ listToolkits: mocks.listToolkits }));
vi.mock('@/lib/agents/market', () => ({ listAgentMarketListings: mocks.listAgentMarketListings }));
vi.mock('@/lib/agents/hermes/constants', () => ({ HERMES_IMAGE_OPTIONS: [], resolveHermesImage: () => 'hermes:latest' }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: vi.fn() }));
vi.mock('@/lib/http/origin', () => ({ originFromHeaders: () => 'http://localhost' }));
vi.mock('@/components/dashboard/agents/AgentsBrowser', () => ({ AgentsBrowser: () => null }));
vi.mock('@/components/dashboard/SettingsModal', () => ({ SettingsModal: ({ children }: { children: ReactNode }) => children }));

import AgentsPage from '@/app/app/[workspace]/agents/page';

beforeEach(() => vi.clearAllMocks());

describe('workspace agent page', () => {
  it('redirects the removed manager route to Work', async () => {
    await expect(AgentsPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow('redirect:/app/acme/work');
    expect(mocks.redirect).toHaveBeenCalledWith('/app/acme/work');
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('keeps the create-only route available', async () => {
    const page = await AgentsPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ create: '1' }),
    });

    expect(page).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
