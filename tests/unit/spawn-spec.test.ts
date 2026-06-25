import { describe, it, expect } from 'vitest';
import { buildSpawnSpec, resolveSpawnSpec } from '@/lib/process/spawn-spec';

describe('buildSpawnSpec', () => {
  it('npm → npx -y', () => {
    expect(buildSpawnSpec('npm', 'mcp-server-fetch')).toEqual({ command: 'npx', args: ['-y', 'mcp-server-fetch'] });
  });
  it('pypi → uvx', () => {
    expect(buildSpawnSpec('pypi', 'mcp-server-fetch')).toEqual({ command: 'uvx', args: ['mcp-server-fetch'] });
  });
  it('github → npx -y <url>', () => {
    expect(buildSpawnSpec('github', 'https://github.com/org/repo')).toEqual({
      command: 'npx',
      args: ['-y', 'https://github.com/org/repo'],
    });
  });
  it('docker → docker run -i --rm <image> <startCommand…>', () => {
    expect(buildSpawnSpec('docker', 'mcp/slack', 'node dist/index.js')).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', 'mcp/slack', 'node', 'dist/index.js'],
    });
  });
  it('docker without start command', () => {
    expect(buildSpawnSpec('docker', 'mcp/slack')).toEqual({ command: 'docker', args: ['run', '-i', '--rm', 'mcp/slack'] });
  });
  it('throws on unsupported source', () => {
    expect(() => buildSpawnSpec('brew', 'x')).toThrow(/Unsupported MCP source/);
  });
});

describe('resolveSpawnSpec', () => {
  it('builtin for catalog', () => {
    expect(
      resolveSpawnSpec({ serverId: 's1', server: { name: 'Stripe' }, name: null, source: null, sourceRef: null, installCfg: null }),
    ).toEqual({ kind: 'builtin', name: 'Stripe' });
  });
  it('bridge for custom docker with env + startCommand', () => {
    expect(
      resolveSpawnSpec({
        serverId: null,
        server: null,
        name: 'Slack',
        source: 'docker',
        sourceRef: 'mcp/slack',
        installCfg: { env: { TOKEN: 'x' }, startCommand: 'node app.js' },
      }),
    ).toEqual({ kind: 'bridge', name: 'Slack', command: 'docker', args: ['run', '-i', '--rm', 'mcp/slack', 'node', 'app.js'], env: { TOKEN: 'x' } });
  });
});
