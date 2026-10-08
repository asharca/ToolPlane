import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getMarketServer: vi.fn(),
  listSandboxes: vi.fn(),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
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
    expect(screen.getByRole('link', { name: /github/i })).toHaveAttribute(
      'href',
      'https://github.com/acme/memory-mcp',
    );
    expect(screen.getByText('Search entities and relationships by query.')).toBeInTheDocument();
    expect(await screen.findByText('Text to search for')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'search_graph' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/mcp/memory/tools/search_graph',
    );
    expect(screen.queryByRole('button', { name: /addToWorkspace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'manualToolTesting' })).not.toBeInTheDocument();
  });

  it('opens a static server tool schema without a sandbox', async () => {
    render(await McpMarketToolPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory', toolName: 'search_graph' }),
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'Search graph' })).toBeInTheDocument();
    expect(await screen.findByText('query')).toBeInTheDocument();
    expect(screen.getByText(/"required": \[/)).toBeInTheDocument();
  });

  it.each(['running', 'stopped'])('routes installed connector tool links to their own %s deployment', async (status) => {
    mocks.getMarketServer.mockResolvedValue({
      ...server, mcpKind: 'connector', deploymentId: 'deployment-1', deploymentStatus: status,
    });
    await expect(McpMarketToolPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory', toolName: 'search_graph' }),
    })).rejects.toThrow('NEXT_REDIRECT:/app/acme%20team/mcp/deployment-1/tools/search_graph');
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
  });

  it('links installed connector tools to their runtime without a sandbox', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
      tools: [server.tools[0]],
      deploymentId: 'deployment-1',
      deploymentStatus: 'running',
    });

    render(await McpMarketDetailPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory' }),
    }));

    expect(screen.getByText('Search entities and relationships by query.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'manualToolTesting' })).toHaveAttribute('href', '/app/acme%20team/mcp/deployment-1?tab=tools');
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
  });

  it('keeps saved schemas and the runtime link when the deployment is stopped', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
      deploymentId: 'deployment-1',
      deploymentStatus: 'stopped',
    });
    render(await McpMarketDetailPage({
      params: Promise.resolve({ workspace: 'acme team', serverSlug: 'memory' }),
    }));
    expect(screen.getByText('Search entities and relationships by query.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'manualToolTesting' })).toHaveAttribute('href', '/app/acme%20team/mcp/deployment-1?tab=tools');
    expect(screen.getByRole('link', { name: 'manageDeployment' })).toHaveAttribute(
      'href', '/app/acme%20team/mcp/deployment-1',
    );
  });

  it('blocks an uninstalled connector tool deep link', async () => {
    mocks.getMarketServer.mockResolvedValue({
      ...server,
      mcpKind: 'connector',
      connector: { endpointHost: 'api.example.test', transport: 'streamable-http', authType: 'none' },
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
      toolCatalogKnown: false,
      tools: [],
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
