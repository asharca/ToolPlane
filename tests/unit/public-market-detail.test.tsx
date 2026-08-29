import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getMarketListing: vi.fn(),
  parseMcpMarketManifest: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/db', () => ({
  db: { marketListing: { findUnique: mocks.findUnique } },
}));
vi.mock('@/lib/market/listings', () => ({ getMarketListing: mocks.getMarketListing }));
vi.mock('@/lib/market/resources', () => ({
  parseMcpMarketManifest: mocks.parseMcpMarketManifest,
  parseToolkitMarketManifest: vi.fn(),
}));

import PublicMarketDetailPage from '@/app/(site)/market/[namespace]/[slug]/page';

const listing = {
  id: 'listing-1',
  kind: 'mcp',
  namespace: 'acme',
  slug: 'search',
  name: 'Remote Search',
  summary: 'Search from MCP.',
  iconUrl: null,
  categories: [],
  latestRelease: {
    version: 1,
    manifest: {},
    checksum: 'checksum',
  },
};

function manifest(source: 'npm' | 'remote') {
  return {
    mcp: {
      name: 'Remote Search',
      description: 'Search from MCP.',
      readme: 'Public documentation.',
      recipe: {
        source,
        ref: source === 'remote' ? 'https://example.com/mcp' : '@acme/search',
        sourceUrl: 'https://github.com/acme/search',
        env: [],
        ...(source === 'remote' ? { transport: 'sse', authType: 'bearer' } : {}),
      },
      toolCatalog: [{ name: 'release_tool', inputSchema: { type: 'object', properties: {} } }],
    },
  };
}

describe('public MCP market detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMarketListing.mockResolvedValue(listing);
    mocks.findUnique.mockResolvedValue(null);
  });

  it('shows a verified Server tool snapshot without exposing install configuration', async () => {
    mocks.parseMcpMarketManifest.mockReturnValue(manifest('npm'));
    mocks.findUnique.mockResolvedValue({
      sourceServer: {
        verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
        verifiedTools: 1,
        installCfg: {
          envValues: { PRIVATE_TOKEN: 'do-not-render' },
          toolCatalog: [{
            name: 'search_docs',
            description: 'Search public documentation.',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string', description: 'Search query.' } },
              required: ['query'],
            },
          }],
        },
      },
    });

    render(await PublicMarketDetailPage({
      params: Promise.resolve({ namespace: 'acme', slug: 'search' }),
    }));

    expect(screen.getByText('Public documentation.')).toBeInTheDocument();
    expect(screen.getByText('search_docs')).toBeInTheDocument();
    expect(screen.getByText('Search query.')).toBeInTheDocument();
    expect(screen.getByText(/"required": \[/)).toBeInTheDocument();
    expect(screen.queryByText('release_tool')).not.toBeInTheDocument();
    expect(screen.queryByText('do-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('installToWorkspace')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'addToWorkspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'connectToWorkspace' })).not.toBeInTheDocument();
  });

  it('shows only Connector metadata before entering the workspace connection flow', async () => {
    mocks.parseMcpMarketManifest.mockReturnValue(manifest('remote'));

    render(await PublicMarketDetailPage({
      params: Promise.resolve({ namespace: 'acme', slug: 'search' }),
    }));

    expect(screen.getByText(/kindMcpConnector/)).toBeInTheDocument();
    expect(screen.getByText('connectorEndpoint')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/mcp')).toBeInTheDocument();
    expect(screen.getByText('transportSse')).toBeInTheDocument();
    expect(screen.getByText('authBearer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /remote/ })).toHaveAttribute('href', 'https://github.com/acme/search');
    expect(screen.queryByText('release_tool')).not.toBeInTheDocument();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(screen.getByText('readyToConnect')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'connectToWorkspace' })).toHaveAttribute(
      'href',
      '/app?market=mcp&q=Remote%20Search',
    );
    expect(screen.queryByText('installToWorkspace')).not.toBeInTheDocument();
  });
});
