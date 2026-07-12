import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { sandboxFlags, envFlags, MCP_NETWORK } from '@/lib/process/sandbox';
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_IMAGE_OPTIONS,
  findSandboxImageOption,
  resolveSandboxImage,
} from '@/lib/sandboxes/images';
import { parseSandboxDirectoryText } from '@/lib/sandboxes/file-list';
import { parseSandboxEnvText, readSandboxEnv, sandboxEnvToText } from '@/lib/sandboxes/env';

describe('sandboxFlags', () => {
  it('isolated: hardening flags + the dedicated sandbox network', () => {
    const f = sandboxFlags('isolated');
    expect(f).toEqual(
      expect.arrayContaining([
        '--rm',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--network',
        MCP_NETWORK,
      ]),
    );
    expect(f).toContain('--memory');
    expect(f).toContain('--pids-limit');
    expect(f).toContain('--cpus');
  });

  it('none: full network isolation', () => {
    expect(sandboxFlags('none')).toContain('none');
    expect(sandboxFlags('none')).not.toContain(MCP_NETWORK);
  });
});

describe('envFlags', () => {
  it('maps to -e KEY=VALUE pairs', () => {
    expect(envFlags({ A: '1', B: '2' })).toEqual(['-e', 'A=1', '-e', 'B=2']);
  });
  it('empty for no env', () => {
    expect(envFlags({})).toEqual([]);
  });
});

describe('sandbox env config', () => {
  it('parses KEY=value lines, comments, and empty lines', () => {
    expect(parseSandboxEnvText('A=1\n# comment\n\nB=two=parts')).toEqual({
      A: '1',
      B: 'two=parts',
    });
  });

  it('round-trips stored env as sorted text', () => {
    const env = readSandboxEnv({ env: { ZED: 'last', A: 'first', 'invalid-key': 'nope', N: 42 } });

    expect(env).toEqual({ A: 'first', ZED: 'last' });
    expect(sandboxEnvToText(env)).toBe('A=first\nZED=last');
  });
});

describe('persistent Docker sandbox runtime', () => {
  it('keeps connector proxies online before the user machine connects', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');

    expect(script).toContain("if (KIND === 'connector') return;");
    expect(script).not.toContain("await connectorRequest('ping', {}, 10_000);\n    return;");
  });

  it('uses structured process execution and binary-safe file writes', () => {
    const server = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');
    const connector = readFileSync(path.join(process.cwd(), 'packages/connector/bin/runtime.mjs'), 'utf8');

    expect(server).toContain("name: 'process_exec'");
    expect(server).toContain("decoded.encoding === 'base64' ? 'write_file_base64' : 'write_file'");
    expect(server).toContain('Buffer.isBuffer(opts.stdin)');
    expect(connector).toContain("case 'process_exec':");
    expect(connector).toContain("case 'write_file_base64':");
  });

  it('keeps the minimal capabilities apt needs inside user sandboxes', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');

    expect(script).toContain("const DOCKER_SANDBOX_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']");
    expect(script).toContain("'--cap-drop'");
    expect(script).toContain("'ALL'");
    expect(script).toContain("DOCKER_SANDBOX_CAPS.flatMap((cap) => ['--cap-add', cap])");
  });

  it('allows enough time for first-run Dev Container image pulls', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');

    expect(script).toContain('const DOCKER_CREATE_TIMEOUT_MS = 15 * 60_000');
    expect(script).toContain('timeoutMs: DOCKER_CREATE_TIMEOUT_MS');
  });

  it('keeps the Hermes API private while forwarding memory scope headers', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');

    expect(script).toContain('API_SERVER_HOST=127.0.0.1');
    expect(script).toContain("['x-hermes-session-id', 'x-hermes-session-key']");
    expect(script).toContain("if (KIND !== 'hermes')");
    expect(script).not.toContain("'--publish'");
  });

  it('starts the Hermes dashboard on container loopback without publishing its port', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');

    expect(script).toContain('HERMES_DASHBOARD=1');
    expect(script).toContain('HERMES_DASHBOARD_HOST=127.0.0.1');
    expect(script).toContain('HERMES_DASHBOARD_PORT=9119');
    expect(script).toContain('http://127.0.0.1:9119');
    expect(script).not.toContain("'--publish'");
  });

  it('runs interactive Hermes terminal sessions as the Hermes service user', () => {
    const script = readFileSync(path.join(process.cwd(), 'scripts/sandbox-mcp-server.mjs'), 'utf8');

    expect(script).toContain("...(KIND === 'hermes' ? ['--user', 'hermes'] : [])");
    expect(script).toContain("HERMES_TERMINAL_PATH = '/opt/hermes/.venv/bin:");
    expect(script).toContain('export VIRTUAL_ENV=/opt/hermes/.venv; export PATH=${HERMES_TERMINAL_PATH}');
    expect(script).toContain("chown \"$(id -u hermes):$(id -g hermes)\"");
  });

  it('does not self-terminate when the request worker parent changes in production', () => {
    for (const file of ['scripts/mcp-server.mjs', 'scripts/mcp-stdio-bridge.mjs', 'scripts/sandbox-mcp-server.mjs']) {
      const script = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(script).not.toContain('process.ppid');
      expect(script).not.toContain('initialPpid');
    }
  });
});

describe('sandbox image catalog', () => {
  it('includes the default Dev Container image and common language stacks', () => {
    expect(SANDBOX_IMAGE_OPTIONS[0].image).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(SANDBOX_IMAGE_OPTIONS.map((option) => option.image)).toEqual(
      expect.arrayContaining([
        'mcr.microsoft.com/devcontainers/typescript-node:24-bookworm',
        'mcr.microsoft.com/devcontainers/python:3.12-bookworm',
        'mcr.microsoft.com/devcontainers/go:1-bookworm',
        'mcr.microsoft.com/devcontainers/rust:1-bookworm',
        'mcr.microsoft.com/devcontainers/universal:2',
      ]),
    );
  });

  it('resolves preset, custom, and empty image choices', () => {
    expect(resolveSandboxImage('python-312', '')).toBe('mcr.microsoft.com/devcontainers/python:3.12-bookworm');
    expect(resolveSandboxImage('custom', 'ghcr.io/acme/sandbox:latest')).toBe('ghcr.io/acme/sandbox:latest');
    expect(resolveSandboxImage('', '')).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(findSandboxImageOption(DEFAULT_SANDBOX_IMAGE)?.name).toBe('JavaScript Node 24');
  });
});

describe('parseSandboxDirectoryText', () => {
  it('uses the requested path for legacy ls output without a path field', () => {
    const listing = parseSandboxDirectoryText(
      JSON.stringify({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'total 4\n-rw-r--r-- 1 root root 46 Jul 4 14:01 sample.csv\n',
        stderr: '',
      }),
      'data',
    );

    expect(listing).toEqual({
      path: 'data',
      entries: [{ name: 'sample.csv', type: 'file', size: 46 }],
    });
  });
});
