import { describe, expect, it } from 'vitest';
import {
  parseMcpToolCatalog,
  parseMcpToolCatalogResult,
  redactMcpToolCatalog,
  redactMcpToolCatalogResult,
  readMcpToolCatalog,
  withMcpToolCatalog,
} from '@/lib/process/mcp-tool-catalog';

describe('MCP tool catalog', () => {
  it('normalizes display-safe tool details without exposing surrounding configuration', () => {
    const tools = parseMcpToolCatalog([
      {
        name: ' search ',
        title: 'Search',
        description: 'Search indexed documents.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
        outputSchema: { type: 'object', properties: { hits: { type: 'array' } } },
        annotations: { readOnlyHint: true, destructiveHint: false, custom: 'drop me' },
        env: { API_KEY: 'secret-value' },
        _meta: { authorization: 'Bearer secret-value' },
      },
      { name: 'search', description: 'duplicate' },
      { name: '' },
    ]);

    expect(tools).toEqual([{
      name: 'search',
      title: 'Search',
      description: 'Search indexed documents.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
      outputSchema: { type: 'object', properties: { hits: { type: 'array' } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }]);

    const stored = withMcpToolCatalog({ env: { API_KEY: 'secret-value' } }, tools);
    expect(readMcpToolCatalog(stored)).toEqual(tools);
    expect(JSON.stringify(readMcpToolCatalog(stored))).not.toContain('secret-value');
  });

  it('redacts exact known credential values from schema keys and values', () => {
    const secret = 'credential-value';
    expect(redactMcpToolCatalog([{
      name: 'echo',
      description: `Server echoed ${secret}`,
      inputSchema: { type: 'object', properties: { [secret]: { const: secret } } },
    }], [secret])).toEqual([{
      name: 'echo',
      description: 'Server echoed [REDACTED]',
      inputSchema: { type: 'object', properties: { '[REDACTED]': { const: '[REDACTED]' } } },
    }]);
  });

  it('drops the snapshot when a short secret is echoed', () => {
    expect(redactMcpToolCatalog([
      { name: 'echo', description: 'PIN 12', inputSchema: { type: 'object' } },
    ], ['12'])).toEqual([]);
  });

  it('keeps a catalog when a short credential value was not echoed', () => {
    expect(redactMcpToolCatalog([
      { name: 'search', inputSchema: { type: 'object' } },
    ], ['80'])).toEqual([
      { name: 'search', inputSchema: { type: 'object' } },
    ]);
  });

  it('redacts numeric and boolean credentials echoed as JSON primitives', () => {
    expect(redactMcpToolCatalog([{
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: {
          port: { default: 1234 },
          enabled: { default: true },
        },
      },
    }], ['1234', 'true'])).toEqual([{
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: {
          port: { default: '[REDACTED]' },
          enabled: { default: '[REDACTED]' },
        },
      },
    }]);
  });

  it('rejects a live tool whose input schema would be truncated', () => {
    expect(parseMcpToolCatalogResult([{
      name: 'oversized',
      inputSchema: { type: 'object', description: 'x'.repeat(256_001) },
    }])).toEqual({ ok: false, tools: [] });
  });

  it('rejects a live tool name that would change during normalization', () => {
    expect(parseMcpToolCatalogResult([{
      name: ' search ',
      inputSchema: { type: 'object' },
    }])).toEqual({ ok: false, tools: [] });
  });

  it('normalizes harmless trailing whitespace in live descriptions', () => {
    expect(parseMcpToolCatalogResult([{
      name: 'search',
      description: 'Search repositories.\n',
      inputSchema: { type: 'object' },
    }])).toEqual({
      ok: true,
      tools: [{ name: 'search', description: 'Search repositories.', inputSchema: { type: 'object' } }],
    });
  });

  it('rejects live metadata that would be dropped or changed', () => {
    expect(parseMcpToolCatalogResult([{
      name: 'long-description',
      description: 'x'.repeat(20_001),
      inputSchema: { type: 'object' },
    }])).toEqual({ ok: false, tools: [] });
    expect(parseMcpToolCatalogResult([{
      name: 'invalid-annotation',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: 'yes', extension: true },
    }])).toEqual({ ok: false, tools: [] });
  });

  it('rejects redaction that changes a tool identity', () => {
    expect(redactMcpToolCatalogResult([
      { name: 'credential-name', inputSchema: { type: 'object' } },
    ], ['credential-name'])).toEqual({ ok: false, tools: [] });
  });
});
