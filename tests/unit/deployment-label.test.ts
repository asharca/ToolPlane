import { describe, it, expect } from 'vitest';
import { deploymentLabel } from '@/lib/workspace/deployment-label';

describe('deploymentLabel', () => {
  it('uses the catalog server name for catalog deployments', () => {
    expect(
      deploymentLabel({ serverId: 's1', server: { name: 'Stripe' }, name: null, source: null, sourceRef: null }),
    ).toEqual({ name: 'Stripe', source: 'catalog', ref: null });
  });

  it('falls back to name/source/ref for custom deployments', () => {
    expect(
      deploymentLabel({ serverId: null, server: null, name: 'Fetcher', source: 'npm', sourceRef: 'mcp-server-fetch' }),
    ).toEqual({ name: 'Fetcher', source: 'npm', ref: 'mcp-server-fetch' });
  });
});
