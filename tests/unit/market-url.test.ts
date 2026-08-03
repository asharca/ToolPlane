import { describe, expect, it } from 'vitest';
import { legacyMarketRedirectTarget } from '@/lib/workspace/market-url';

describe('legacyMarketRedirectTarget', () => {
  it('preserves scalar and repeated query parameters when moving MCP routes', () => {
    expect(legacyMarketRedirectTarget('acme team', 'mcp', {
      q: 'file search',
      page: '2',
      tag: ['local', 'safe'],
    })).toBe('/app/acme%20team/market/mcp?q=file+search&page=2&tag=local&tag=safe');
  });

  it('moves the legacy skill route without adding an empty query', () => {
    expect(legacyMarketRedirectTarget('acme', 'skills', {}))
      .toBe('/app/acme/market/skills');
  });
});
