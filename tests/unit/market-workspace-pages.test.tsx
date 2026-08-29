import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getDeployments: vi.fn(),
  getInstalledSkills: vi.fn(),
  listToolkits: vi.fn(),
  listAgents: vi.fn(),
  listChatAssistants: vi.fn(),
  listWorkspaceMarketInstalls: vi.fn(),
  listWorkspaceMarketCopies: vi.fn(),
  listWorkspacePublishedResources: vi.fn(),
  categories: vi.fn(),
  membership: vi.fn(),
  agentListings: vi.fn(),
  update: vi.fn(),
  ignore: vi.fn(),
  remove: vi.fn(),
  removeAssistant: vi.fn(),
  withdraw: vi.fn(),
  unpublish: vi.fn(),
  publishMcp: vi.fn(),
  publishSkill: vi.fn(),
  publishAssistant: vi.fn(),
  publishToolkit: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getDeployments: mocks.getDeployments,
  getInstalledSkills: mocks.getInstalledSkills,
}));
vi.mock('@/lib/toolkits/queries', () => ({ listToolkits: mocks.listToolkits }));
vi.mock('@/lib/agents/queries', () => ({ listAgents: mocks.listAgents }));
vi.mock('@/lib/chat/service', () => ({ listChatAssistantsForWorkspace: mocks.listChatAssistants }));
vi.mock('@/lib/market/skills', () => ({
  listWorkspaceMarketInstalls: mocks.listWorkspaceMarketInstalls,
  listWorkspacePublishedResources: mocks.listWorkspacePublishedResources,
}));
vi.mock('@/lib/market/copy-updates', () => ({
  listWorkspaceMarketCopies: mocks.listWorkspaceMarketCopies,
}));
vi.mock('@/lib/market/actions', () => ({
  updateMarketInstallAction: mocks.update,
  ignoreMarketUpdateAction: mocks.ignore,
  removeMarketInstallAction: mocks.remove,
  removeAssistantMarketCopyAction: mocks.removeAssistant,
  withdrawMarketReleaseAction: mocks.withdraw,
  unpublishMarketListingAction: mocks.unpublish,
  publishMcpReleaseAction: mocks.publishMcp,
  publishSkillReleaseAction: mocks.publishSkill,
  publishAssistantReleaseAction: mocks.publishAssistant,
  publishToolkitReleaseAction: mocks.publishToolkit,
}));
vi.mock('@/lib/db', () => ({
  db: {
    category: { findMany: mocks.categories },
    membership: { findUnique: mocks.membership },
    agentListing: { findMany: mocks.agentListings },
  },
}));

import InstalledMarketPage from '@/app/app/[workspace]/market/installed/page';
import MarketPublishPage from '@/app/app/[workspace]/market/publish/page';

const now = new Date('2026-08-27T12:00:00.000Z');

describe('workspace market management pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme', ownerId: 'user-1' });
    mocks.getDeployments.mockResolvedValue([]);
    mocks.getInstalledSkills.mockResolvedValue([]);
    mocks.listToolkits.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue([]);
    mocks.listChatAssistants.mockResolvedValue([]);
    mocks.listWorkspaceMarketInstalls.mockResolvedValue([]);
    mocks.listWorkspaceMarketCopies.mockResolvedValue({ agents: [], assistants: [] });
    mocks.listWorkspacePublishedResources.mockResolvedValue([]);
    mocks.categories.mockResolvedValue([]);
    mocks.agentListings.mockResolvedValue([]);
  });

  it('shows tracked versions and update controls alongside legacy resources', async () => {
    mocks.listWorkspaceMarketInstalls.mockResolvedValue([{
      id: 'install-1',
      deploymentId: null,
      installedSkillId: 'skill-market',
      toolkitId: null,
      agentId: null,
      status: 'ready',
      updatedAt: now,
      currentReleaseId: 'release-1',
      currentRelease: { id: 'release-1', version: 1 },
      ignoredReleaseId: null,
      listing: {
        kind: 'skill',
        namespace: 'acme-labs',
        slug: 'writer',
        name: 'Writer',
        latestRelease: { id: 'release-2', version: 2, releaseNotes: 'Better output.' },
      },
      installedSkill: { id: 'skill-market', status: 'published' },
      toolkit: null,
      agent: null,
      updateAvailable: true,
    }]);
    mocks.getDeployments.mockResolvedValue([{
      id: 'mcp-legacy', serverId: null, server: null, name: 'Local MCP', source: 'custom',
      sourceRef: null, status: 'running', createdAt: now, updatedAt: now,
    }]);
    mocks.getInstalledSkills.mockResolvedValue([{
      id: 'skill-market', skillId: null, skill: null, name: 'Writer', slug: 'writer',
      description: null, source: 'market', sourceRef: null, status: 'published', createdAt: now,
    }]);
    mocks.listWorkspaceMarketCopies.mockResolvedValue({
      agents: [],
      assistants: [{
        kind: 'assistant', id: 'assistant-copy', resourceId: 'assistant-copy', name: 'Writer assistant',
        sourceDetail: 'acme-labs/writer-assistant', status: 'ready', updatedAt: now,
        currentReleaseId: 'assistant-release-1', currentVersion: 1, listingId: 'assistant-listing',
        latestReleaseId: 'assistant-release-2', latestVersion: 2, releaseNotes: 'Safer prompts.',
        updateAvailable: true,
      }],
    });

    render(await InstalledMarketPage({ params: Promise.resolve({ workspace: 'acme' }) }));

    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText('Local MCP')).toBeInTheDocument();
    expect(screen.getAllByText('updateAvailable')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ignoreThisVersion' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'uninstall: Writer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'uninstall: Writer assistant' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'createUpdatedCopy' })).toHaveAttribute(
      'href',
      '/app/acme/chat?newAssistant=1&template=assistant-release-2',
    );
    expect(screen.getByText('copyUpdateSafety')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /manage/ }).map((link) => link.getAttribute('href')))
      .toContain('/app/acme/mcp/mcp-legacy');
  });

  it('links agent publishing and exposes the real skill release form', async () => {
    mocks.getInstalledSkills.mockResolvedValue([{
      id: 'skill-1', skillId: null, skill: null, name: 'Release writer', slug: 'release-writer',
      description: 'Writes releases.', source: 'custom', sourceRef: null, status: 'published', createdAt: now,
    }]);
    mocks.listAgents.mockResolvedValue([{
      id: 'agent-1', name: 'Research agent', slug: 'research-agent', runtimeKind: 'native',
      runtime: null, createdAt: now, updatedAt: now,
    }]);
    mocks.listWorkspacePublishedResources.mockResolvedValue([{
      id: 'listing-1', sourceInstalledSkillId: 'skill-1', sourceDeploymentId: null,
      sourceToolkitId: null, name: 'Release writer', slug: 'release-writer', summary: 'Writes releases.',
      tags: ['writing'], categories: [], status: 'draft', latestVersion: 1, latestRelease: null,
      pendingRelease: { id: 'release-1', version: 1, reviewStatus: 'pending', reviewNote: null },
    }]);

    render(await MarketPublishPage({ params: Promise.resolve({ workspace: 'acme' }) }));

    expect(screen.getByText('publicationPending')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /publishToMarket/ })).toHaveAttribute(
      'href',
      '/app/acme/agents/agent-1/publish',
    );
    expect(screen.getByText('Publish new version')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdrawSubmission' })).toBeInTheDocument();
  });

  it('routes locally modified skills through the explicit overwrite review', async () => {
    mocks.listWorkspaceMarketInstalls.mockResolvedValue([{
      id: 'install-1', deploymentId: null, installedSkillId: 'skill-market', toolkitId: null,
      agentId: null, status: 'modified', updatedAt: now, currentReleaseId: 'release-1',
      currentRelease: { id: 'release-1', version: 1 }, ignoredReleaseId: null,
      listing: {
        kind: 'skill', namespace: 'acme-labs', slug: 'writer', name: 'Writer',
        latestRelease: { id: 'release-2', version: 2, releaseNotes: null },
      },
      installedSkill: { id: 'skill-market', status: 'published' }, toolkit: null, agent: null,
      updateAvailable: true,
    }]);

    render(await InstalledMarketPage({ params: Promise.resolve({ workspace: 'acme' }) }));

    expect(screen.getByRole('link', { name: 'reviewUpdate' })).toHaveAttribute(
      'href',
      '/app/acme/market/items/acme-labs/writer',
    );
    expect(screen.queryByRole('button', { name: 'update' })).not.toBeInTheDocument();
  });

  it('publishes chat assistants through the unified review flow', async () => {
    mocks.listChatAssistants.mockResolvedValue([{
      id: 'assistant-1',
      name: 'Market assistant',
      systemPrompt: 'Use verified sources.',
      model: 'gpt-5.6',
      maxSteps: 8,
    }]);
    mocks.listWorkspacePublishedResources.mockResolvedValue([{
      id: 'listing-assistant',
      sourceChatAssistantId: 'assistant-1',
      sourceInstalledSkillId: null,
      sourceDeploymentId: null,
      sourceToolkitId: null,
      name: 'Market assistant',
      slug: 'market-assistant',
      summary: 'A lightweight assistant.',
      tags: ['chat'],
      categories: [],
      status: 'published',
      latestVersion: 1,
      latestRelease: { id: 'release-1', version: 1, publishedAt: now },
      pendingRelease: null,
    }]);

    render(await MarketPublishPage({ params: Promise.resolve({ workspace: 'acme' }) }));

    expect(screen.getByText('Market assistant')).toBeInTheDocument();
    expect(document.querySelector('input[name="assistantId"]')).toHaveValue('assistant-1');
    expect(screen.getByText('Publish new version')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'unpublishListing' })).toBeInTheDocument();
  });

  it('keeps publishing available after a reviewed MCP receives a catalog identity', async () => {
    mocks.getDeployments.mockResolvedValue([{
      id: 'deployment-1', serverId: 'server-1',
      server: { name: 'Reviewed MCP', slug: 'reviewed-mcp' },
      name: null, source: 'npm', sourceRef: '@acme/reviewed-mcp',
      status: 'stopped', createdAt: now, updatedAt: now,
    }]);
    mocks.listWorkspacePublishedResources.mockResolvedValue([{
      id: 'listing-mcp', sourceDeploymentId: 'deployment-1', sourceInstalledSkillId: null,
      sourceToolkitId: null, sourceChatAssistantId: null,
      name: 'Reviewed MCP', slug: 'reviewed-mcp', summary: 'A reviewed MCP.',
      tags: ['mcp'], categories: [], status: 'published', latestVersion: 1,
      latestRelease: { id: 'release-1', version: 1, publishedAt: now }, pendingRelease: null,
    }]);

    render(await MarketPublishPage({ params: Promise.resolve({ workspace: 'acme' }) }));

    expect(document.querySelector('input[name="deploymentId"]')).toHaveValue('deployment-1');
    expect(screen.getByText('Publish new version')).toBeInTheDocument();
    expect(screen.queryByText('catalogAlreadyListed')).not.toBeInTheDocument();
  });
});
