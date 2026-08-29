// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { fetchServerSourceMetadata } from '@/lib/admin/server-source';

describe('fetchServerSourceMetadata', () => {
  it('fetches package metadata only from the fixed registry and normalizes its repository URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith('/latest')
        ? {
            name: '@acme/catalog-mcp',
            description: 'Search the catalog.',
            author: { name: 'Acme' },
            repository: { url: 'git+https://github.com/acme/catalog-mcp.git' },
          }
        : { readme: '# Catalog MCP' },
    ), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(fetchServerSourceMetadata({
      source: 'npm',
      ref: '@acme/catalog-mcp',
    }, fetchImpl)).resolves.toMatchObject({
      name: '@acme/catalog-mcp',
      description: 'Search the catalog.',
      readme: '# Catalog MCP',
      author: 'Acme',
      canonicalSourceUrl: 'https://github.com/acme/catalog-mcp',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40acme%2Fcatalog-mcp/latest',
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40acme%2Fcatalog-mcp',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('fetches GitHub metadata and decodes the repository README', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify(url.endsWith('/readme') ? {
        encoding: 'base64',
        content: Buffer.from('# Catalog MCP\n\nGitHub README').toString('base64'),
      } : {
        name: 'catalog-mcp',
        description: 'Search the catalog.',
        owner: { login: 'acme' },
        stargazers_count: 73,
      }), { status: 200 });
    });

    await expect(fetchServerSourceMetadata({
      source: 'github',
      ref: 'https://github.com/acme/catalog-mcp',
    }, fetchImpl)).resolves.toMatchObject({
      name: 'catalog-mcp',
      readme: '# Catalog MCP\n\nGitHub README',
      author: 'acme',
      canonicalSourceUrl: 'https://github.com/acme/catalog-mcp',
      stars: 73,
    });
    for (const suffix of ['', '/readme']) {
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://api.github.com/repos/acme/catalog-mcp${suffix}`,
        expect.objectContaining({ redirect: 'error' }),
      );
    }
  });

  it('fetches PyPI metadata from its fixed API and prefers a GitHub project URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      info: {
        name: 'catalog-mcp',
        summary: 'Search the catalog.',
        description: '# Catalog MCP',
        author: 'Acme',
        project_urls: { Repository: 'https://github.com/acme/catalog-mcp' },
      },
    }), { status: 200 }));

    await expect(fetchServerSourceMetadata({
      source: 'pypi',
      ref: 'catalog-mcp',
    }, fetchImpl)).resolves.toMatchObject({
      name: 'catalog-mcp',
      readme: '# Catalog MCP',
      canonicalSourceUrl: 'https://github.com/acme/catalog-mcp',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pypi.org/pypi/catalog-mcp/json',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    { source: 'github' as const, ref: 'http://169.254.169.254/latest/meta-data' },
    { source: 'github' as const, ref: 'https://untrusted.example/acme/server' },
    { source: 'npm' as const, ref: 'https://untrusted.example/package' },
    { source: 'pypi' as const, ref: 'file:///etc/passwd' },
  ])('rejects an untrusted $source URL without making a request', async (input) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(fetchServerSourceMetadata(input, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
