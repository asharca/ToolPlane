import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getMarketServer: vi.fn(),
  listSandboxes: vi.fn(),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
  getTranslations: vi.fn().mockResolvedValue((key: string, values?: { count?: number }) => (
    typeof values?.count === 'number' ? `${key}:${values.count}` : key
  )),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getMarketServer: mocks.getMarketServer,
}));
vi.mock('@/lib/sandboxes/queries', () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock('@/lib/workspace/actions', () => ({ deployServerAction: vi.fn() }));
vi.mock('@/lib/process/supervisor', () => ({ effectiveStatus: vi.fn((_id: string, status: string) => status) }));
vi.mock('@/components/dashboard/SafeStreamdown', () => ({
  SafeStreamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('@/components/dashboard/ToolPlayground', () => ({
  ToolPlayground: ({ deploymentId }: { deploymentId: string }) => (
    <div data-testid="market-inspector">{deploymentId}</div>
  ),
}));

import McpMarketDetailPage from '@/app/app/[workspace]/market/mcp/[serverSlug]/page';
import McpMarketToolPage from '@/app/app/[workspace]/market/mcp/[serverSlug]/tools/[toolName]/page';

const server = {
  id: 'server-1',
  slug: 'memory',
  name: 'Memory MCP',
  author: 'ToolPlane Labs',
  description: 'Store and search durable knowledge.',
  iconUrl: null,
  stars: 1250,
  isOfficial: true,
  readme: '# Memory\n\nPersist knowledge between conversations.',
  verifiedTools: 2,
  categories: [{ slug: 'memory', name: 'Memory' }],
  sourceUrl: 'https://github.com/acme/memory-mcp',
  mcpKind: 'server' as const,
  connector: null,
  recipe: { source: 'npm', ref: '@toolplane/memory', requiredEnv: [], network: 'isolated' },
  deploymentId: null,
  deploymentStatus: null,
  inspectorSandbox: null,
  toolCatalogKnown: true,
  tools: [{
    name: 'search_graph',
    title: 'Search graph',
    description: 'Search entities and relationships by query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for' } },
      required: ['query'],
    },
  }, {
    name: 'create_entities',
    description: 'Create knowledge graph entities.',
    inputSchema: { type: 'object', properties: {} },
  }],
};

describe('MCP market details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme team' });
    mocks.getMarketServer.mockResolvedValue(server);
    mocks.listSandboxes.mockResolvedValue([]);
  });

  it('shows a server overview and verified static schemas without deployment actions', async () => {
    render(await McpMarketDetailPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory' }),
    }));

    expect(screen.getByText(/Persist knowledge between conversations\./)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'detailNavigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'capabilities' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /github/i })).toHaveAttribute(
      'href',
      'https://github.com/acme/memory-mcp',
    );
    expect(screen.getByText('Search entities and relationships by query.')).toBeInTheDocument();
    expect(screen.getByText('Text to search for')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'search_graph' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/mcp/memory/tools/search_graph',
    );
    expect(screen.queryByRole('button', { name: /addToWorkspace/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('market-inspector')).not.toBeInTheDocument();
  });

  it('opens a static server tool schema without a sandbox', async () => {
    render(await McpMarketToolPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory', toolName: 'search_graph' }),
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'Search graph' })).toBeInTheDocument();
    expect(screen.getByText('query')).toBeInTheDocument();
    expect(screen.getByText(/"required": \[/)).toBeInTheDocument();
  });

  it('opens one connected connector tool with its schema and sibling navigation', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
      deploymentId: 'deployment-1',
      deploymentStatus: 'running',
      inspectorSandbox: {
        id: 'sandbox-1',
        deploymentId: 'sandbox-deployment-1',
        status: 'running',
        connectedAt: '2026-08-29T00:00:00.000Z',
      },
    });
    render(await McpMarketToolPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory', toolName: 'search_graph' }),
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'Search graph' })).toBeInTheDocument();
    expect(screen.getAllByText('Search entities and relationships by query.')).toHaveLength(2);
    expect(screen.getByText('query')).toBeInTheDocument();
    expect(screen.getByText(/"required": \[/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'create_entities' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/mcp/memory/tools/create_entities',
    );
    expect(screen.getByRole('link', { name: 'viewDetails' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/mcp/memory',
    );
  });

  it('shows tools and Inspector only after a connector was inspected through a running sandbox', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
      tools: [server.tools[0]],
      deploymentId: 'deployment-1',
      deploymentStatus: 'running',
      inspectorSandbox: {
        id: 'sandbox-1',
        deploymentId: 'sandbox-deployment-1',
        status: 'running',
        connectedAt: '2026-08-29T00:00:00.000Z',
      },
    });

    render(await McpMarketDetailPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory' }),
    }));

    expect(screen.getByText('Search entities and relationships by query.')).toBeInTheDocument();
    expect(screen.getByTestId('market-inspector')).toHaveTextContent('deployment-1');
  });

  it('hides connector schemas but keeps the connection controls when its sandbox is stopped', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
      deploymentId: 'deployment-1',
      deploymentStatus: 'running',
      inspectorSandbox: {
        id: 'sandbox-1',
        deploymentId: 'sandbox-deployment-1',
        status: 'stopped',
        connectedAt: '2026-08-29T00:00:00.000Z',
      },
    });
    render(await McpMarketDetailPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory' }),
    }));
    expect(screen.queryByText('Search entities and relationships by query.')).not.toBeInTheDocument();
    expect(screen.getByTestId('market-inspector')).toHaveTextContent('deployment-1');
  });

  it('blocks a stopped connector tool deep link', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
      inspectorSandbox: {
        id: 'sandbox-1',
        deploymentId: 'sandbox-deployment-1',
        status: 'stopped',
        connectedAt: '2026-08-29T00:00:00.000Z',
      },
    });

    await expect(McpMarketToolPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory', toolName: 'search_graph' }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('shows hosted connector facts and preserves the connector market view', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: {
        endpointHost: 'api.example.test',
        transport: 'streamable-http',
        authType: 'bearer',
      },
      recipe: {
        source: 'remote',
        ref: 'https://api.example.test/mcp',
        requiredEnv: ['MCP_BEARER_TOKEN'],
        network: 'isolated',
        transport: 'streamable-http',
        authType: 'bearer',
      },
      inspectorSandbox: null,
    });

    render(await McpMarketDetailPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory' }),
    }));

    expect(screen.getByText('kindMcpConnector')).toBeInTheDocument();
    expect(screen.getAllByText('api.example.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('transportStreamableHttp').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'backToMcp' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/mcp?type=connector',
    );
    expect(screen.queryByText('Search entities and relationships by query.')).not.toBeInTheDocument();
  });
});
