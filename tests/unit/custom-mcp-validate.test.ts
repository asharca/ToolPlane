import { describe, it, expect } from 'vitest';
import {
  parseCustomMcpInput,
  parseMcpDeploymentConfig,
  parseMcpJsonConfig,
  serializeMcpDeploymentConfig,
  serializeMcpJsonConfig,
} from '@/lib/workspace/custom-mcp';

describe('parseCustomMcpInput', () => {
  it('npm package', () => {
    expect(parseCustomMcpInput({ source: 'npm', ref: '@scope/server', name: 'S' })).toEqual({
      source: 'npm', ref: '@scope/server', name: 'S', installCfg: null,
    });
  });
  it('pypi package', () => {
    expect(parseCustomMcpInput({ source: 'pypi', ref: 'mcp-server-fetch', name: 'F' }).source).toBe('pypi');
  });
  it('github url accepted', () => {
    expect(parseCustomMcpInput({ source: 'github', ref: 'https://github.com/org/repo', name: 'G' }).ref).toBe('https://github.com/org/repo');
  });
  it('docker image + startCommand stored in installCfg', () => {
    expect(parseCustomMcpInput({ source: 'docker', ref: 'mcp/slack', name: 'D', startCommand: 'node a.js' }).installCfg).toEqual({ startCommand: 'node a.js', env: {} });
  });
  it.each([
    ['npm', '@scope/server'],
    ['pypi', 'mcp-server-fetch'],
    ['github', 'https://github.com/org/repo'],
    ['docker', 'mcp/slack'],
  ] as const)('stores the no-network mode for a %s deployment', (source, ref) => {
    expect(parseCustomMcpInput({ source, ref, name: 'Offline', network: 'none' }).installCfg)
      .toEqual({ env: {}, network: 'none' });
  });
  it('keeps isolated as the canonical default without a stored network field', () => {
    expect(parseCustomMcpInput({
      source: 'npm', ref: '@scope/server', name: 'S', network: 'isolated',
    }).installCfg).toBeNull();
  });
  it('rejects unsupported network modes', () => {
    expect(() => parseCustomMcpInput({
      source: 'npm', ref: '@scope/server', name: 'S', network: 'host',
    })).toThrow();
  });
  it('rejects non-github url for github source', () => {
    expect(() => parseCustomMcpInput({ source: 'github', ref: 'https://evil.com/x/y', name: 'G' })).toThrow();
  });
  it('rejects bad npm name', () => {
    expect(() => parseCustomMcpInput({ source: 'npm', ref: 'Bad Name!', name: 'S' })).toThrow();
  });
  it('rejects empty name', () => {
    expect(() => parseCustomMcpInput({ source: 'npm', ref: 'x', name: '  ' })).toThrow();
  });
  it('rejects unknown source', () => {
    expect(() => parseCustomMcpInput({ source: 'brew', ref: 'x', name: 'S' })).toThrow();
  });

  it('parses a command-and-args MCP JSON config', () => {
    const args = [
      '-y',
      '@fangjunjie/ssh-mcp-server',
      '--host',
      '192.168.1.1',
      '--port',
      '22',
    ];
    expect(parseCustomMcpInput({
      source: 'config',
      config: JSON.stringify({
        'ssh-mcp-server': {
          command: 'npx',
          args,
          env: { SSH_PASSWORD: 'secret' },
        },
      }),
    })).toEqual({
      source: 'config',
      ref: 'npx',
      name: 'ssh-mcp-server',
      installCfg: { command: 'npx', args, env: { SSH_PASSWORD: 'secret' } },
    });
  });

  it('accepts the common mcpServers wrapper and Windows npx executable', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        fetcher: { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'fetch-mcp'] },
      },
    }))).toMatchObject({ name: 'fetcher', installCfg: { command: 'npx' } });
  });

  it('accepts a single mcpServers entry copied without outer braces', () => {
    expect(parseMcpJsonConfig(`
      "fetcher": {
        "command": "uvx",
        "args": ["mcp-server-fetch"]
      }
    `)).toMatchObject({ name: 'fetcher', installCfg: { command: 'uvx' } });
  });

  it('accepts a direct command config and infers its name from the package', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    }))).toMatchObject({
      name: 'server-everything',
      source: 'config',
      installCfg: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
    });
  });

  it('uses the existing deployment name when editing a direct config', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      command: 'uvx',
      args: ['mcp-server-fetch'],
    }), 'My Fetch Server')).toMatchObject({
      name: 'My Fetch Server',
      installCfg: { command: 'uvx' },
    });
  });

  it('skips command option values when inferring a direct config name', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      command: 'uvx',
      args: [
        '--python',
        '3.13',
        '--index-url',
        'https://user:secret@repo.example',
        'mcp-server-fetch',
      ],
    })).name).toBe('mcp-server-fetch');
  });

  it('keeps legacy wrappers whose server name is a direct-format field', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      command: { command: 'npx', args: ['-y', 'some-mcp-server'] },
    }))).toMatchObject({
      name: 'command',
      installCfg: { command: 'npx', args: ['-y', 'some-mcp-server'] },
    });
  });

  it('serializes launch configuration separately from its runtime network mode', () => {
    const serialized = serializeMcpJsonConfig({
      command: 'npx',
      args: ['-y', '@fangjunjie/ssh-mcp-server', '--port', '22'],
      env: { SSH_USER: 'root' },
      network: 'none',
    });
    expect(JSON.parse(serialized)).toEqual({
      command: 'npx',
      args: ['-y', '@fangjunjie/ssh-mcp-server', '--port', '22'],
      env: { SSH_USER: 'root' },
    });
    expect(parseMcpJsonConfig(serialized)).toMatchObject({
      source: 'config',
      name: 'ssh-mcp-server',
      installCfg: { command: 'npx', env: { SSH_USER: 'root' } },
    });
    expect(parseMcpDeploymentConfig(serialized, 'config', undefined, 'none')).toMatchObject({
      installCfg: { command: 'npx', env: { SSH_USER: 'root' }, network: 'none' },
    });

    const masked = serializeMcpJsonConfig({
      command: 'npx',
      args: ['-y', 'ssh-mcp-server', '--password', 'secret', '--port', '22'],
      env: { SSH_USER: 'root', SSH_PASSWORD: 'secret' },
    }, { maskSecrets: true });
    expect(JSON.parse(masked)).toEqual({
      command: 'npx',
      args: ['-y', 'ssh-mcp-server', '--password', '********', '--port', '22'],
      env: { SSH_USER: '********', SSH_PASSWORD: '********' },
    });
  });

  it('masks credential URLs in command args', () => {
    const masked = serializeMcpJsonConfig({
      command: 'uvx',
      args: [
        '--index-url=https://user:secret@repo.example/simple',
        '--registry',
        'https://user:secret@registry.example',
        '--header=Authorization: Bearer token-value',
        '--auth-token',
        'auth-value',
        '--access-token=access-value',
        '--credential',
        'credential-value',
        'TOKEN=assignment-value',
        'https://token-value@private.example/path',
        '--url=https://api.example/run?access_token=query-secret',
        '--header',
        'X-API-Key: header-secret',
        'https://api.example/run?api_key=position-secret',
        'mcp-server-fetch',
      ],
    }, { maskSecrets: true });
    expect(JSON.parse(masked).args).toEqual([
      '--index-url=********',
      '--registry',
      '********',
      '--header=********',
      '--auth-token',
      '********',
      '--access-token=********',
      '--credential',
      '********',
      'TOKEN=********',
      '********',
      '--url=********',
      '--header',
      '********',
      '********',
      'mcp-server-fetch',
    ]);
  });

  it('rejects multiple servers and commands that would execute on the host', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      one: { command: 'npx' },
      two: { command: 'uvx' },
    }))).toThrow(/exactly one/);
    expect(() => parseMcpJsonConfig(JSON.stringify({
      unsafe: { command: 'bash', args: ['-lc', 'whoami'] },
    }))).toThrow(/npx or uvx/);
  });

  it('rejects malformed args, env, and unsupported fields', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      bad: { command: 'npx', args: '--yes' },
    }))).toThrow(/args must be an array/);
    expect(() => parseMcpJsonConfig(JSON.stringify({
      bad: { command: 'npx', args: ['package'], env: { 'BAD-KEY': 'x' } },
    }))).toThrow(/environment variable name/);
    expect(() => parseMcpJsonConfig(JSON.stringify({
      bad: { command: 'npx', cwd: '/tmp' },
    }))).toThrow(/unsupported field/);
    expect(() => parseMcpJsonConfig(JSON.stringify({
      bad: { command: 'npx', args: [] },
    }))).toThrow(/include the MCP package/);
  });
});

describe('editable deployment configurations', () => {
  it.each([
    {
      source: 'npm' as const,
      ref: '@modelcontextprotocol/server-memory',
      installCfg: { env: { MEMORY_FILE_PATH: '/tmp/memory.json' }, network: 'none' as const },
    },
    {
      source: 'pypi' as const,
      ref: 'mcp-server-fetch',
      installCfg: { env: {} },
    },
    {
      source: 'github' as const,
      ref: 'https://github.com/modelcontextprotocol-servers/whois-mcp',
      installCfg: { env: {} },
    },
    {
      source: 'docker' as const,
      ref: 'mcp/filesystem',
      installCfg: { env: {}, startCommand: '/tmp', network: 'none' as const },
    },
  ])('round-trips a $source deployment config', ({ source, ref, installCfg }) => {
    const serialized = serializeMcpDeploymentConfig({
      source,
      sourceRef: ref,
      installCfg,
    });
    expect(parseMcpDeploymentConfig(
      serialized,
      source,
      undefined,
      installCfg.network === 'none' ? 'none' : 'isolated',
    )).toEqual({
      source,
      ref,
      installCfg,
    });
  });

  it('uses the explicit network selector instead of a legacy JSON field', () => {
    expect(parseMcpDeploymentConfig(JSON.stringify({
      source: 'npm', ref: 'pkg', network: 'none',
    }), 'npm', undefined, 'isolated')).toEqual({
      source: 'npm',
      ref: 'pkg',
      installCfg: { env: {} },
    });
  });

  it('masks package env and Docker startCommand secrets', () => {
    const masked = serializeMcpDeploymentConfig({
      source: 'docker',
      sourceRef: 'mcp/example',
      installCfg: {
        startCommand: '--token secret --registry=https://user:secret@repo.example',
        env: { API_TOKEN: 'secret' },
      },
    }, { maskSecrets: true });
    expect(JSON.parse(masked)).toEqual({
      source: 'docker',
      ref: 'mcp/example',
      startCommand: '********',
      env: { API_TOKEN: '********' },
    });
  });

  it('rejects source changes, invalid refs, fields, network, and startCommand misuse', () => {
    expect(() => parseMcpDeploymentConfig(JSON.stringify({
      source: 'pypi', ref: 'mcp-server-fetch',
    }), 'npm')).toThrow(/source must remain npm/);
    expect(() => parseMcpDeploymentConfig(JSON.stringify({
      source: 'github', ref: 'https://example.com/not-github/repo',
    }), 'github')).toThrow(/invalid github reference/);
    expect(() => parseMcpDeploymentConfig(JSON.stringify({
      source: 'npm', ref: 'pkg', args: ['unsupported'],
    }), 'npm')).toThrow(/unsupported field/);
    expect(() => parseMcpDeploymentConfig(JSON.stringify({
      source: 'npm', ref: 'pkg', network: 'host',
    }), 'npm')).toThrow(/network must be/);
    expect(() => parseMcpDeploymentConfig(JSON.stringify({
      source: 'npm', ref: 'pkg', startCommand: 'node server.js',
    }), 'npm')).toThrow(/only supported for docker/);
  });
});
