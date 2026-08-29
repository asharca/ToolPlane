import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getMarketListing: vi.fn(),
  marketInstall: vi.fn(),
  marketListingFindUnique: vi.fn(),
  parseAssistantReleaseManifest: vi.fn(),
  parseMcpMarketManifest: vi.fn(),
  sandboxFindFirst: vi.fn(),
  listSandboxes: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  redirect: vi.fn(),
}));
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/sandboxes/queries', () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock('@/lib/market/listings', () => ({ getMarketListing: mocks.getMarketListing }));
vi.mock('@/lib/market/assistant-manifest', () => ({
  parseAssistantReleaseManifest: mocks.parseAssistantReleaseManifest,
}));
vi.mock('@/lib/market/skill-manifest', () => ({ parseSkillReleaseManifest: vi.fn() }));
vi.mock('@/lib/market/resources', () => ({
  parseMcpMarketManifest: mocks.parseMcpMarketManifest,
  parseToolkitMarketManifest: vi.fn(),
}));
vi.mock('@/lib/market/actions', () => ({
  ignoreMarketUpdateAction: vi.fn(),
  installMarketResourceAction: vi.fn(),
  installMarketSkillAction: vi.fn(),
  updateMarketInstallAction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    marketInstall: { findUnique: mocks.marketInstall },
    marketListing: { findUnique: mocks.marketListingFindUnique },
    sandbox: { findFirst: mocks.sandboxFindFirst },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  effectiveStatus: vi.fn((_id: string, status: string) => status),
}));
vi.mock('@/components/dashboard/ToolPlayground', () => ({
  ToolPlayground: ({ deploymentId }: { deploymentId: string }) => (
    <div data-testid="market-item-inspector">{deploymentId}</div>
  ),
}));

import MarketItemPage from '@/app/app/[workspace]/market/items/[namespace]/[listingSlug]/page';
import MarketItemToolPage from '@/app/app/[workspace]/market/items/[namespace]/[listingSlug]/tools/[toolName]/page';

const mcpListing = {
  id: 'listing-mcp',
  kind: 'mcp',
  namespace: 'acme-labs',
  slug: 'catalog-search',
  name: 'Catalog Search',
  summary: 'Search a product catalog.',
  iconUrl: null,
  tags: ['search'],
  categories: [{ slug: 'search', name: 'Search' }],
  installCount: 4,
  publishedAt: new Date('2026-08-20T00:00:00.000Z'),
  latestRelease: {
    id: 'release-mcp',
    version: 2,
    manifest: {},
    checksum: 'checksum',
    publishedAt: new Date('2026-08-27T00:00:00.000Z'),
  },
};

const mcpManifest = {
  mcp: {
    name: 'Catalog Search',
    description: 'Search a product catalog.',
    readme: '# Catalog Search\n\nUse this server to search products.',
    recipe: {
      source: 'npm',
      ref: '@acme/catalog-search',
      sourceUrl: 'https://github.com/acme/catalog-search',
      env: ['CATALOG_TOKEN'],
    },
    toolExposure: 'all',
    allowedTools: [],
    toolCatalog: [{
      name: 'search_products',
      description: 'Search products by keyword.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search term' } },
        required: ['query'],
      },
    }],
  },
};

const connectorManifest = {
  mcp: {
    ...mcpManifest.mcp,
    recipe: {
      source: 'remote',
      ref: 'https://api.example.test/mcp',
      sourceUrl: 'https://github.com/acme/catalog-search',
      env: [],
      transport: 'streamable-http',
      authType: 'none',
    },
  },
};

describe('market detail pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme team' });
    mocks.getMarketListing.mockResolvedValue({
      id: 'listing-1',
      kind: 'assistant',
      namespace: 'acme-labs',
      slug: 'research-chat',
      name: 'Research Chat',
      summary: 'A reviewed research helper.',
      iconUrl: null,
      tags: ['research', 'chat'],
      categories: [{ slug: 'research', name: 'Research' }],
      installCount: 12,
      publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      latestRelease: {
        id: 'release-1',
        version: 3,
        manifest: {},
        checksum: 'checksum',
        publishedAt: new Date('2026-08-27T00:00:00.000Z'),
      },
    });
    mocks.parseAssistantReleaseManifest.mockReturnValue({
      assistant: {
        name: 'Research Chat',
        systemPrompt: 'Verify every source before answering.',
        maxSteps: 8,
        modelRequirement: { providerFormat: 'openai-compatible', model: 'gpt-5.6' },
        mcpRequirements: [{ catalogSlug: 'filesystem', name: 'Filesystem MCP' }],
      },
    });
    mocks.marketInstall.mockResolvedValue(null);
    mocks.marketListingFindUnique.mockResolvedValue(null);
    mocks.sandboxFindFirst.mockResolvedValue(null);
    mocks.listSandboxes.mockResolvedValue([]);
  });

  it('shows assistant type, attributes, capabilities, and the template creation link', async () => {
    render(await MarketItemPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'research-chat',
      }),
    }));

    expect(screen.getByText('kindAssistant')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'backToAssistants' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/assistants',
    );
    expect(screen.getByRole('navigation', { name: 'detailNavigation' })).toBeInTheDocument();
    expect(screen.getByText('Verify every source before answering.')).toBeInTheDocument();
    expect(screen.getByText('Filesystem MCP')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.6')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Research' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/assistants?category=research',
    );
    expect(screen.getByRole('link', { name: /createFromTemplate/ })).toHaveAttribute(
      'href',
      '/app/acme%20team/chat?newAssistant=1&template=release-1',
    );
    expect(mocks.marketInstall).not.toHaveBeenCalled();
  });

  it('shows a published server with its verified static tools but no actions', async () => {
    mocks.getMarketListing.mockResolvedValue(mcpListing);
    mocks.parseMcpMarketManifest.mockReturnValue(mcpManifest);
    mocks.marketInstall.mockResolvedValue(null);
    mocks.marketListingFindUnique.mockResolvedValue({
      sourceServer: {
        installCfg: { toolCatalog: mcpManifest.mcp.toolCatalog },
        verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
        verifiedTools: 1,
      },
    });

    render(await MarketItemPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'catalog-search',
      }),
    }));

    expect(screen.getByText('Use this server to search products.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /npm/i })).toHaveAttribute(
      'href',
      'https://github.com/acme/catalog-search',
    );
    expect(screen.getByText('@acme/catalog-search')).toBeInTheDocument();
    expect(screen.getByText('CATALOG_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('Search products by keyword.')).toBeInTheDocument();
    expect(screen.getByText('Search term')).toBeInTheDocument();
    expect(screen.getByText('inputSchema')).toBeInTheDocument();
    expect(screen.getByText(/"required"/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'search_products' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/items/acme-labs/catalog-search/tools/search_products',
    );
    expect(screen.queryByRole('button', { name: /installToWorkspace/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('market-item-inspector')).not.toBeInTheDocument();
  });

  it('does not fall back to an unverified tool snapshot for a server', async () => {
    mocks.getMarketListing.mockResolvedValue(mcpListing);
    mocks.parseMcpMarketManifest.mockReturnValue(mcpManifest);

    render(await MarketItemPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'catalog-search',
      }),
    }));

    expect(screen.queryByText('Search products by keyword.')).not.toBeInTheDocument();
    expect(screen.queryByText('Search term')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'search_products' })).not.toBeInTheDocument();
  });

  it('shows connector tools and Inspector only for a running sandbox connection', async () => {
    mocks.getMarketListing.mockResolvedValue(mcpListing);
    mocks.parseMcpMarketManifest.mockReturnValue(connectorManifest);
    mocks.marketInstall.mockResolvedValue({
      id: 'install-1',
      currentReleaseId: 'release-mcp',
      status: 'installed',
      currentRelease: { version: 2 },
      installedSkill: null,
      toolkit: null,
      deployment: {
        id: 'deployment-1',
        workspaceId: 'workspace-1',
        status: 'running',
        installCfg: {
          toolCatalog: mcpManifest.mcp.toolCatalog,
          mcpInspector: { sandboxId: 'sandbox-1', connectedAt: '2026-08-29T00:00:00.000Z' },
        },
      },
    });
    mocks.sandboxFindFirst.mockResolvedValue({
      deployment: { id: 'sandbox-deployment-1', status: 'running' },
    });

    render(await MarketItemPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'catalog-search',
      }),
    }));

    expect(screen.getByTestId('market-item-inspector')).toHaveTextContent('deployment-1');
    expect(screen.getByRole('link', { name: 'inspector' })).toHaveAttribute('href', '#inspector');
  });

  it.each([
    ['stopped', 'workspace-1'],
    ['running', 'another-workspace'],
  ])('hides connector tools for a %s sandbox connection in %s', async (status, workspaceId) => {
    mocks.getMarketListing.mockResolvedValue(mcpListing);
    mocks.parseMcpMarketManifest.mockReturnValue(connectorManifest);
    mocks.marketInstall.mockResolvedValue({
      id: 'install-1',
      currentReleaseId: 'release-mcp',
      status: 'installed',
      currentRelease: { version: 2 },
      installedSkill: null,
      toolkit: null,
      deployment: {
        id: 'deployment-1',
        workspaceId,
        status,
        installCfg: {
          toolCatalog: mcpManifest.mcp.toolCatalog,
          mcpInspector: { sandboxId: 'sandbox-1', connectedAt: '2026-08-29T00:00:00.000Z' },
        },
      },
    });
    mocks.sandboxFindFirst.mockResolvedValue({
      deployment: { id: 'sandbox-deployment-1', status },
    });

    render(await MarketItemPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'catalog-search',
      }),
    }));

    if (workspaceId === 'workspace-1') {
      expect(screen.getByTestId('market-item-inspector')).toHaveTextContent('deployment-1');
    } else {
      expect(screen.queryByTestId('market-item-inspector')).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Search products by keyword.')).not.toBeInTheDocument();
    if (workspaceId !== 'workspace-1') {
      expect(screen.queryByRole('link', { name: 'manage' })).not.toBeInTheDocument();
    }
  });

  it('shows a verified server tool schema without an installation', async () => {
    mocks.getMarketListing.mockResolvedValue(mcpListing);
    mocks.parseMcpMarketManifest.mockReturnValue(mcpManifest);
    mocks.marketListingFindUnique.mockResolvedValue({
      sourceServer: {
        installCfg: { toolCatalog: mcpManifest.mcp.toolCatalog },
        verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
        verifiedTools: 1,
      },
    });

    render(await MarketItemToolPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'catalog-search',
        toolName: 'search_products',
      }),
    }));

    expect(screen.getByText('Search term')).toBeInTheDocument();
    expect(screen.getByText(/"required"/)).toBeInTheDocument();
    expect(mocks.marketInstall).not.toHaveBeenCalled();
  });

  it('shows a connected connector tool schema while its sandbox is running', async () => {
    mocks.getMarketListing.mockResolvedValue(mcpListing);
    mocks.parseMcpMarketManifest.mockReturnValue(connectorManifest);
    mocks.marketInstall.mockResolvedValue({
      deployment: {
        workspaceId: 'workspace-1',
        installCfg: {
          toolCatalog: mcpManifest.mcp.toolCatalog,
          mcpInspector: { sandboxId: 'sandbox-1', connectedAt: '2026-08-29T00:00:00.000Z' },
        },
      },
    });
    mocks.sandboxFindFirst.mockResolvedValue({
      deployment: { id: 'sandbox-deployment-1', status: 'running' },
    });

    render(await MarketItemToolPage({
      params: Promise.resolve({
        workspace: 'acme team',
        namespace: 'acme-labs',
        listingSlug: 'catalog-search',
        toolName: 'search_products',
      }),
    }));

    expect(screen.getByText('Search term')).toBeInTheDocument();
    expect(screen.getByText(/"required"/)).toBeInTheDocument();
  });
});
