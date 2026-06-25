import { describe, it, expect } from 'vitest';
import { buildSpawnSpec, resolveSpawnSpec } from '@/lib/process/spawn-spec';

describe('buildSpawnSpec', () => {
  it('maps npm to npx -y <pkg> with extra args', () => {
    expect(buildSpawnSpec('npm', 'mcp-server-fetch', ['--flag'])).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-server-fetch', '--flag'],
    });
  });

  it('throws on unsupported sources', () => {
    expect(() => buildSpawnSpec('pypi', 'x', [])).toThrow(/Unsupported MCP source/);
  });
});

describe('resolveSpawnSpec', () => {
  it('returns a builtin spec for catalog deployments', () => {
    expect(
      resolveSpawnSpec({
        serverId: 'srv1',
        server: { name: 'GitHub' },
        name: null,
        source: null,
        sourceRef: null,
        installCfg: null,
      }),
    ).toEqual({ kind: 'builtin', name: 'GitHub' });
  });

  it('returns a bridge spec for custom deployments', () => {
    expect(
      resolveSpawnSpec({
        serverId: null,
        server: null,
        name: 'Fetcher',
        source: 'npm',
        sourceRef: 'mcp-server-fetch',
        installCfg: { env: { TOKEN: 'x' }, args: ['--v'] },
      }),
    ).toEqual({
      kind: 'bridge',
      name: 'Fetcher',
      command: 'npx',
      args: ['-y', 'mcp-server-fetch', '--v'],
      env: { TOKEN: 'x' },
    });
  });
});
