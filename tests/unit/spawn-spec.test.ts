import { describe, it, expect } from 'vitest';
import { buildSpawnSpec, resolveSpawnSpec } from '@/lib/process/spawn-spec';
import { MCP_NETWORK } from '@/lib/process/sandbox';

describe('buildSpawnSpec — every custom source runs in a hardened container', () => {
  it('always uses `docker run` with the hardening flags', () => {
    const cases: [string, string][] = [
      ['npm', 'pkg'],
      ['github', 'https://github.com/o/r'],
      ['pypi', 'pkg'],
      ['docker', 'img'],
    ];
    for (const [source, ref] of cases) {
      const { command, args } = buildSpawnSpec(source, ref);
      expect(command).toBe('docker');
      expect(args[0]).toBe('run');
      expect(args).toEqual(
        expect.arrayContaining([
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--read-only',
          '--network',
          MCP_NETWORK,
        ]),
      );
    }
  });

  it('npm/github wrap in node + npx, cache redirected to tmpfs', () => {
    const { args } = buildSpawnSpec('npm', 'mcp-server-fetch');
    expect(args).toContain('node:24-bookworm-slim');
    expect(args.slice(-3)).toEqual(['npx', '-y', 'mcp-server-fetch']);
    expect(args).toContain('npm_config_cache=/tmp/.npm');
  });

  it('pypi wraps in the uv image + uvx, cache redirected to tmpfs', () => {
    const { args } = buildSpawnSpec('pypi', 'mcp-server-fetch');
    expect(args.some((a) => a.startsWith('ghcr.io/astral-sh/uv'))).toBe(true);
    expect(args.slice(-2)).toEqual(['uvx', 'mcp-server-fetch']);
    expect(args).toContain('UV_CACHE_DIR=/tmp/.uv');
  });

  it('docker source runs the image directly with its start command', () => {
    const { args } = buildSpawnSpec('docker', 'mcp/slack', 'node app.js');
    expect(args.slice(-3)).toEqual(['mcp/slack', 'node', 'app.js']);
  });

  it('passes the MCP env in as -e flags (the only env the container gets)', () => {
    const { args } = buildSpawnSpec('npm', 'pkg', undefined, { TOKEN: 'secret', HOST: 'h' });
    expect(args).toContain('TOKEN=secret');
    expect(args).toContain('HOST=h');
  });

  it('network "none" swaps the sandbox bridge for full isolation', () => {
    const { args } = buildSpawnSpec('npm', 'pkg', undefined, {}, false, 'none');
    expect(args).toContain('none');
    expect(args).not.toContain(MCP_NETWORK);
  });

  it('rebuild re-fetches: npm --prefer-online, pypi --refresh, docker --pull always', () => {
    expect(buildSpawnSpec('npm', 'pkg', undefined, {}, true).args).toContain('--prefer-online');
    expect(buildSpawnSpec('pypi', 'pkg', undefined, {}, true).args).toContain('--refresh');
    const d = buildSpawnSpec('docker', 'img', undefined, {}, true).args;
    expect(d).toContain('--pull');
    expect(d).toContain('always');
  });

  it('throws on unsupported source', () => {
    expect(() => buildSpawnSpec('brew', 'x')).toThrow(/Unsupported MCP source/);
  });
});

describe('resolveSpawnSpec', () => {
  it('builtin for catalog (in-process, not containerized)', () => {
    expect(
      resolveSpawnSpec({ serverId: 's1', server: { name: 'Stripe' }, name: null, source: null, sourceRef: null, installCfg: null }),
    ).toEqual({ kind: 'builtin', name: 'Stripe' });
  });

  it('bridge for a catalog server that has an admin recipe (real package)', () => {
    const spec = resolveSpawnSpec({
      serverId: 's1',
      server: { name: 'Firecrawl' },
      name: null,
      source: 'npm',
      sourceRef: 'firecrawl-mcp',
      installCfg: { env: { FIRECRAWL_API_KEY: '' } },
    });
    expect(spec.kind).toBe('bridge');
    if (spec.kind === 'bridge') {
      expect(spec.name).toBe('Firecrawl');
      expect(spec.command).toBe('docker');
      expect(spec.args.slice(-1)).toEqual(['firecrawl-mcp']);
    }
  });

  it('bridge runs a hardened docker container for a custom deployment', () => {
    const spec = resolveSpawnSpec({
      serverId: null,
      server: null,
      name: 'Slack',
      source: 'docker',
      sourceRef: 'mcp/slack',
      installCfg: { env: { TOKEN: 'x' }, startCommand: 'node app.js' },
    });
    expect(spec.kind).toBe('bridge');
    if (spec.kind === 'bridge') {
      expect(spec.command).toBe('docker');
      expect(spec.args).toContain('--cap-drop');
      expect(spec.args).toContain('TOKEN=x');
      expect(spec.args.slice(-3)).toEqual(['mcp/slack', 'node', 'app.js']);
    }
  });

  it('installCfg.network="none" cuts the network', () => {
    const spec = resolveSpawnSpec({
      serverId: null,
      server: null,
      name: 'x',
      source: 'npm',
      sourceRef: 'pkg',
      installCfg: { network: 'none' },
    });
    if (spec.kind === 'bridge') {
      expect(spec.args).toContain('none');
      expect(spec.args).not.toContain(MCP_NETWORK);
    }
  });
});
