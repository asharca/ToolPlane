import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentCount: vi.fn(),
  skillCount: vi.fn(),
  toolkitCount: vi.fn(),
  agentCount: vi.fn(),
  assistantCount: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/db', () => ({
  db: {
    deployment: { count: mocks.deploymentCount },
    installedSkill: { count: mocks.skillCount },
    toolkit: { count: mocks.toolkitCount },
    agent: { count: mocks.agentCount },
    chatAssistant: { count: mocks.assistantCount },
  },
}));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));

import MarketPage from '@/app/app/[workspace]/market/page';

describe('workspace market home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme team' });
    mocks.deploymentCount.mockResolvedValue(2);
    mocks.skillCount.mockResolvedValue(3);
    mocks.agentCount.mockResolvedValue(4);
    mocks.assistantCount.mockResolvedValue(5);
    mocks.toolkitCount.mockResolvedValue(6);
  });

  it('offers direct starts, capability markets, and private resource creation', async () => {
    render(await MarketPage({ params: Promise.resolve({ workspace: 'acme team' }) }));

    expect(screen.getByRole('link', { name: /browseAgents/ })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/agents',
    );
    expect(screen.getByRole('link', { name: /openChat/ })).toHaveAttribute(
      'href',
      '/app/acme%20team/chat',
    );
    expect(screen.getByRole('link', { name: 'addMcp' })).toHaveAttribute('href', '/app/acme%20team/mcp?create=1');
    expect(screen.getByRole('link', { name: 'addSkill' })).toHaveAttribute('href', '/app/acme%20team/skills?create=1');
    expect(screen.getByRole('link', { name: 'createToolkit' })).toHaveAttribute('href', '/app/acme%20team/toolkits?create=1');
    expect(screen.getByRole('link', { name: 'createAgent' })).toHaveAttribute(
      'href',
      '/app/acme%20team/agents?create=1&returnTo=%2Fapp%2Facme%2520team%2Fmarket',
    );
    expect(screen.getByRole('link', { name: 'createAssistant' })).toHaveAttribute(
      'href',
      '/app/acme%20team/chat?newAssistant=1',
    );
    expect(screen.getByRole('link', { name: /^mcp\s*2$/i })).toHaveAttribute(
      'href',
      '/app/acme%20team/mcp',
    );
    expect(screen.getByRole('link', { name: /^skills\s*3$/i })).toHaveAttribute(
      'href',
      '/app/acme%20team/skills',
    );
    expect(screen.getByRole('link', { name: /^agents\s*4$/i })).toHaveAttribute(
      'href',
      '/app/acme%20team/agents',
    );
    expect(screen.getByRole('link', { name: /^assistants\s*5$/i })).toHaveAttribute(
      'href',
      '/app/acme%20team/chat',
    );
    expect(screen.getByRole('link', { name: /^toolkits\s*6$/i })).toHaveAttribute(
      'href',
      '/app/acme%20team/toolkits',
    );
    expect(mocks.deploymentCount).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
    });
    for (const count of [mocks.skillCount, mocks.agentCount, mocks.assistantCount, mocks.toolkitCount]) {
      expect(count).toHaveBeenCalledWith({ where: { workspaceId: 'workspace-1' } });
    }
    expect(screen.getByText('privateByDefault')).toBeInTheDocument();
  });
});
