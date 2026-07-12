import { describe, it, expect } from 'vitest';
import { buildSpawnSpec, resolveSpawnSpec } from '@/lib/process/spawn-spec';
import { MCP_NETWORK } from '@/lib/process/sandbox';
import {
  buildConnectorConfig,
  CONNECTOR_PACKAGE_VERSION,
  connectorClientCommand,
  connectorFromConfig,
  connectorServerUrlFromHeaders,
  hashConnectorToken,
} from '@/lib/sandboxes/connector';

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
  it('derives the connector server URL from trusted request routing headers', () => {
    const requestHeaders = new Headers({
      'x-forwarded-host': 'toolplane.example.com, proxy.internal',
      'x-forwarded-proto': 'https, http',
    });

    expect(connectorServerUrlFromHeaders(requestHeaders)).toBe('https://toolplane.example.com');
  });

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

  it('sandbox source resolves to the sandbox MCP server spec', () => {
    const spec = resolveSpawnSpec({
      serverId: null,
      server: null,
      name: 'Sandbox: Lab',
      source: 'sandbox',
      sourceRef: 'mcr.microsoft.com/devcontainers/javascript-node:24-bookworm',
      installCfg: {
        sandboxId: 'sb1',
        kind: 'docker',
        image: 'node:24-bookworm-slim',
        volumeName: 'vol1',
        network: 'none',
        env: { A: '1' },
      },
    });
    expect(spec).toEqual({
      kind: 'sandbox',
      name: 'Sandbox: Lab',
      sandboxId: 'sb1',
      sandboxKind: 'docker',
      image: 'node:24-bookworm-slim',
      volumeName: 'vol1',
      network: 'none',
      env: { A: '1' },
    });
  });

  it('sandbox source supports WebSocket connector specs', () => {
    const spec = resolveSpawnSpec({
      serverId: null,
      server: null,
      name: 'Sandbox: Remote lab',
      source: 'sandbox',
      sourceRef: 'connector://mcpcon_deadbeef/srv/workspace',
      installCfg: {
        sandboxId: 'sb-connector',
        kind: 'connector',
        network: 'isolated',
        connector: {
          provider: 'websocket',
          protocolVersion: '2026-07-connector-ws',
          serverUrl: 'https://app.example.com',
          remoteRoot: '/srv/workspace',
          tokenHash: hashConnectorToken('mcpcon_deadbeef'),
          tokenPrefix: 'mcpcon_deadb',
          packageName: '/api/v1/connectors/package.tgz',
          createdAt: '2026-07-05T00:00:00.000Z',
        },
      },
    });

    expect(spec).toEqual({
      kind: 'sandbox',
      name: 'Sandbox: Remote lab',
      sandboxId: 'sb-connector',
      sandboxKind: 'connector',
      network: 'isolated',
      env: {},
      connector: {
        provider: 'websocket',
        protocolVersion: '2026-07-connector-ws-v2',
        serverUrl: 'https://app.example.com',
        remoteRoot: '/srv/workspace',
        tokenHash: hashConnectorToken('mcpcon_deadbeef'),
        tokenPrefix: 'mcpcon_deadb',
        packageName: '/api/v1/connectors/package.tgz',
        createdAt: '2026-07-05T00:00:00.000Z',
      },
    });
  });

  it('sandbox source preserves the scoped Hermes runtime identity', () => {
    const spec = resolveSpawnSpec({
      serverId: null,
      server: null,
      name: 'Hermes runtime: Research',
      source: 'sandbox',
      sourceRef: 'nousresearch/hermes-agent:latest',
      installCfg: {
        sandboxId: 'sb-hermes',
        kind: 'hermes',
        image: 'nousresearch/hermes-agent:latest',
        volumeName: 'hermes-volume',
        network: 'isolated',
        runtimeId: 'runtime-1',
        runtimeModelName: 'research',
      },
    });

    expect(spec).toEqual({
      kind: 'sandbox',
      name: 'Hermes runtime: Research',
      sandboxId: 'sb-hermes',
      sandboxKind: 'hermes',
      image: 'nousresearch/hermes-agent:latest',
      volumeName: 'hermes-volume',
      network: 'isolated',
      env: {},
      runtimeId: 'runtime-1',
      runtimeModelName: 'research',
    });
  });

  it('generates the one-command WebSocket connector command', () => {
    const connector = buildConnectorConfig(
      {
        serverUrl: 'https://app.example.com/',
        remoteRoot: '/srv/workspace',
      },
      'mcpcon_deadbeef',
    );

    expect(connectorClientCommand(connector, 'mcpcon_deadbeef')).toBe(
      `npx -y --package "https://app.example.com/api/v1/connectors/package.tgz?v=${CONNECTOR_PACKAGE_VERSION}" connector connect --server "https://app.example.com" --token "mcpcon_deadbeef" --root "/srv/workspace"`,
    );
  });

  it('uses the exact same command for a Windows root with spaces', () => {
    const connector = buildConnectorConfig(
      {
        serverUrl: 'https://app.example.com/',
        remoteRoot: 'C:\\Users\\Ada Lovelace\\ToolPlane Sandbox',
      },
      'mcpcon_deadbeef',
    );

    expect(connectorClientCommand(connector, 'mcpcon_deadbeef')).toBe(
      `npx -y --package "https://app.example.com/api/v1/connectors/package.tgz?v=${CONNECTOR_PACKAGE_VERSION}" connector connect --server "https://app.example.com" --token "mcpcon_deadbeef" --root "C:\\Users\\Ada Lovelace\\ToolPlane Sandbox"`,
    );
  });

  it('drops URL path, credentials, query, and fragment before generating a command', () => {
    const connector = buildConnectorConfig(
      { serverUrl: 'https://user:pass@app.example.com/base?x=1&next=bad#hash' },
      'mcpcon_deadbeef',
    );

    expect(connector.serverUrl).toBe('https://app.example.com');
    expect(connectorClientCommand(connector, 'mcpcon_deadbeef')).toBe(
      `npx -y --package "https://app.example.com/api/v1/connectors/package.tgz?v=${CONNECTOR_PACKAGE_VERSION}" connector connect --server "https://app.example.com" --token "mcpcon_deadbeef" --root "~/toolplane-sandbox"`,
    );
  });

  it('rejects a token that contains shell syntax', () => {
    const connector = buildConnectorConfig({ serverUrl: 'https://app.example.com' }, 'mcpcon_deadbeef');

    expect(() => connectorClientCommand(connector, 'mcpcon_ok;whoami')).toThrow(/unsupported argument/i);
  });

  it('rejects percent expansion in a custom package argument for Windows cmd', () => {
    const connector = buildConnectorConfig({
      serverUrl: 'https://app.example.com',
      packageName: 'https://packages.example.com/%PATH%/connector.tgz',
    }, 'mcpcon_deadbeef');

    expect(connector.packageName).toBe('/api/v1/connectors/package.tgz');
    expect(connectorClientCommand(connector, 'mcpcon_deadbeef')).not.toContain('%PATH%');
  });

  it('normalizes legacy connector package and root names', () => {
    const legacyPackage = `@${['mcp', 'market'].join('-')}/connector`;
    const legacyRoot = `~/${['mcp', 'market'].join('')}-sandbox`;
    const connector = connectorFromConfig({
      connector: {
        provider: 'websocket',
        protocolVersion: '2026-07-connector-ws',
        serverUrl: 'http://localhost:3002',
        remoteRoot: legacyRoot,
        tokenHash: hashConnectorToken('mcpcon_deadbeef'),
        tokenPrefix: 'mcpcon_deadb',
        packageName: legacyPackage,
        createdAt: '2026-07-05T00:00:00.000Z',
      },
    });

    expect(connector).not.toBeNull();
    expect(connectorClientCommand(connector!, 'mcpcon_deadbeef')).toBe(
      `npx -y --package "http://localhost:3002/api/v1/connectors/package.tgz?v=${CONNECTOR_PACKAGE_VERSION}" connector connect --server "http://localhost:3002" --token "mcpcon_deadbeef" --root "~/toolplane-sandbox"`,
    );
  });

  it('normalizes the unpublished registry connector package to the hosted tarball', () => {
    const connector = connectorFromConfig({
      connector: {
        provider: 'websocket',
        protocolVersion: '2026-07-connector-ws',
        serverUrl: 'http://localhost:3002',
        remoteRoot: '~/toolplane-sandbox',
        tokenHash: hashConnectorToken('mcpcon_deadbeef'),
        tokenPrefix: 'mcpcon_deadb',
        packageName: '@toolplane/connector',
        createdAt: '2026-07-05T00:00:00.000Z',
      },
    });

    expect(connector).not.toBeNull();
    expect(connectorClientCommand(connector!, 'mcpcon_deadbeef')).toBe(
      `npx -y --package "http://localhost:3002/api/v1/connectors/package.tgz?v=${CONNECTOR_PACKAGE_VERSION}" connector connect --server "http://localhost:3002" --token "mcpcon_deadbeef" --root "~/toolplane-sandbox"`,
    );
  });

  it('replaces roots with shell expansion syntax before generating the portable command', () => {
    const connector = buildConnectorConfig({
      serverUrl: 'https://app.example.com',
      remoteRoot: '$HOME/private',
    }, 'mcpcon_deadbeef');

    expect(connector.remoteRoot).toBe('~/toolplane-sandbox');
    expect(connectorClientCommand(connector, 'mcpcon_deadbeef')).not.toContain('$HOME');
  });

  it('repairs a persisted platform URL that was written into remoteRoot', () => {
    const connector = connectorFromConfig({
      connector: {
        provider: 'websocket',
        serverUrl: 'http://localhost:3000',
        remoteRoot: 'http://localhost:3000',
        tokenHash: hashConnectorToken('mcpcon_deadbeef'),
        tokenPrefix: 'mcpcon_deadb',
        packageName: '/api/v1/connectors/package.tgz',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
    });

    expect(connector?.remoteRoot).toBe('~/toolplane-sandbox');
  });
});
