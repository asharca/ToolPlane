import { describe, it, expect } from 'vitest';
import { parseCustomMcpInput, parseMcpJsonConfig } from '@/lib/workspace/custom-mcp';

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
    expect(parseCustomMcpInput({ source: 'docker', ref: 'mcp/slack', name: 'D', startCommand: 'node a.js' }).installCfg).toEqual({ startCommand: 'node a.js' });
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
