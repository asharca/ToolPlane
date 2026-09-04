import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');
const REMOTE_BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-http-bridge.mjs');
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-stdio-mcp.mjs');
const DELAYED_FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'delayed-stdio-mcp.mjs');
const processes = new Set<ChildProcess>();

type StartBridgeOptions = {
  args?: string[];
  env?: Record<string, string>;
};

type StartedBridge = {
  proc: ChildProcess;
  port: number;
  stderr: () => string;
};

function startBridge(options: StartBridgeOptions = {}): Promise<StartedBridge> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        MCP_PORT: '0',
        MCP_NAME: 'fake',
        MCP_COMMAND: process.execPath,
        MCP_ARGS: JSON.stringify(options.args ?? [FIXTURE]),
        MCP_RUNTIME_EVENT_TOKEN: 'bridge-test-runtime-token',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.add(proc);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('bridge did not print LISTENING\n' + stderr)));
    }, 8000);

    proc.stdout.on('data', (buffer: Buffer) => {
      const match = /LISTENING (\d+)/.exec(buffer.toString());
      if (!match) return;
      finish(() => resolve({ proc, port: Number(match[1]), stderr: () => stderr }));
    });
    proc.stderr.on('data', (buffer: Buffer) => {
      stderr += buffer.toString();
    });
    proc.once('error', (error) => {
      processes.delete(proc);
      finish(() => reject(error));
    });
    proc.once('exit', (code, signal) => {
      processes.delete(proc);
      const reason = signal ? 'signal ' + signal : String(code);
      finish(() => reject(new Error('bridge exited (' + reason + ')\n' + stderr)));
    });
  });
}

async function rpc(port: number, method: string, params?: unknown) {
  const res = await fetch('http://127.0.0.1:' + port + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return res.json();
}

function runRemoteBridge(
  config: unknown,
  nodeArgs: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(process.execPath, [...nodeArgs, REMOTE_BRIDGE], {
      env: {
        ...process.env,
        ...env,
        MCP_PORT: '0',
        MCP_NAME: 'remote-test',
        MCP_REMOTE_CONFIG: JSON.stringify(config),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.add(proc);
    proc.stdout.on('data', (buffer: Buffer) => { stdout += buffer.toString(); });
    proc.stderr.on('data', (buffer: Buffer) => { stderr += buffer.toString(); });
    proc.once('error', reject);
    proc.once('exit', (code) => {
      processes.delete(proc);
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('remote bridge did not exit'));
    }, 8000);
  });
}

afterAll(() => {
  for (const proc of processes) proc.kill('SIGKILL');
  processes.clear();
});

describe('mcp-stdio-bridge', () => {
  it('handshakes then proxies tools/list and tools/call over HTTP', async () => {
    const started = await startBridge();

    const list = await rpc(started.port, 'tools/list');
    expect((list.result.tools as { name: string }[]).map((tool) => tool.name)).toContain('ping_tool');

    const call = await rpc(started.port, 'tools/call', { name: 'ping_tool', arguments: {} });
    expect(call.result.content[0].text).toBe('pong');
  });

  it('passes only the configured MCP environment to the child', async () => {
    const started = await startBridge({
      env: {
        MCP_CHILD_ENV: JSON.stringify({ MCP_TEST_SECRET: 'forwarded-secret' }),
        DATABASE_URL: 'app-secret-must-not-reach-child',
      },
    });

    const configured = await rpc(started.port, 'tools/call', {
      name: 'ping_tool', arguments: { env: 'MCP_TEST_SECRET' },
    });
    const appSecret = await rpc(started.port, 'tools/call', {
      name: 'ping_tool', arguments: { env: 'DATABASE_URL' },
    });
    expect(configured.result.content[0].text).toBe('forwarded-secret');
    expect(appSecret.result.content[0].text).toBe('');
  });

  it('keeps a delayed initialize alive while the MCP reports progress', async () => {
    const started = await startBridge({
      args: [DELAYED_FIXTURE, '--delay-ms=600', '--progress-ms=35'],
      env: {
        MCP_STARTUP_IDLE_TIMEOUT_MS: '250',
        MCP_STARTUP_MAX_TIMEOUT_MS: '3000',
      },
    });

    const list = await rpc(started.port, 'tools/list');
    expect((list.result.tools as { name: string }[]).map((tool) => tool.name)).toContain('ping_tool');
    expect(started.stderr()).toContain('"phase":"initializing"');
    expect(started.stderr()).toContain('"phase":"ready"');
    expect(started.stderr()).toContain('"token":"bridge-test-runtime-token"');
  });

  it('fails when initialization is silent past the idle deadline', async () => {
    await expect(startBridge({
      args: [DELAYED_FIXTURE, '--delay-ms=600', '--progress-ms=0'],
      env: {
        MCP_STARTUP_IDLE_TIMEOUT_MS: '150',
        MCP_STARTUP_MAX_TIMEOUT_MS: '3000',
      },
    })).rejects.toThrow(/startup idle timeout/);
  });
});

describe('mcp-http-bridge', () => {
  it('blocks private endpoints without logging credentials', async () => {
    const secret = 'connector-secret-that-must-not-leak';
    const result = await runRemoteBridge({
      url: 'https://127.0.0.1/mcp',
      transport: 'streamable-http',
      headers: { authorization: `Bearer ${secret}` },
      timeoutMs: 1000,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('LISTENING');
    expect(result.stderr).toContain('non-public address');
    expect(result.stderr).not.toContain(secret);
  });

  it('allows configured wildcard hosts and exact RFC1918 addresses only', async () => {
    const preload = `data:text/javascript,${encodeURIComponent(`
      import dns from 'node:dns/promises';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      dns.lookup = async () => [{ address: '10.0.10.42', family: 4 }];
      syncBuiltinESMExports();
      globalThis.fetch = () => Promise.reject(new Error('unexpected global fetch'));
      const require = createRequire(${JSON.stringify(REMOTE_BRIDGE)});
      const undici = require('undici');
      undici.Agent = class {
        constructor(options) { this.options = options; }
        async close() {}
      };
      undici.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        await new Promise((resolve, reject) => init.dispatcher.options.connect.lookup(
          url.hostname,
          { all: true },
          (error, addresses) => {
            if (error) reject(error);
            else if (!Array.isArray(addresses) || addresses[0]?.address !== '10.0.10.42') {
              reject(new Error('test did not use pinned address'));
            } else resolve();
          },
        ));
        throw new Error('test fetch reached');
      };
    `)}`;
    const config = {
      url: 'https://mcp.rhzy.ai/mcp',
      transport: 'sse',
      headers: {},
      timeoutMs: 1000,
    };
    const allowed = await runRemoteBridge(config, ['--import', preload], {
      MCP_REMOTE_PRIVATE_HOSTS: '*.rhzy.ai,10.0.10.42',
    });

    expect(allowed.stderr).toContain('test fetch reached');
    expect(allowed.stderr).not.toContain('non-public address');

    const exactIp = await runRemoteBridge({ ...config, url: 'https://10.0.10.42/mcp' }, ['--import', preload], {
      MCP_REMOTE_PRIVATE_HOSTS: '*.rhzy.ai,10.0.10.42',
    });
    expect(exactIp.stderr).toContain('test fetch reached');
    expect(exactIp.stderr).not.toContain('non-public address');

    const unlisted = await runRemoteBridge({ ...config, url: 'https://other.example.com/mcp' }, ['--import', preload], {
      MCP_REMOTE_PRIVATE_HOSTS: '*.rhzy.ai,10.0.10.42',
    });
    expect(unlisted.stderr).toContain('non-public address');
  }, 10_000);

  it('bounds an SSE connection that never completes startup', async () => {
    const preload = `data:text/javascript,${encodeURIComponent(`
      import dns from 'node:dns/promises';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      syncBuiltinESMExports();
      const require = createRequire(${JSON.stringify(REMOTE_BRIDGE)});
      require('undici').fetch = () => new Promise(() => {});
    `)}`;
    const result = await runRemoteBridge({
      url: 'https://example.com/mcp',
      transport: 'sse',
      headers: {},
      timeoutMs: 1000,
    }, ['--import', preload]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('connection timed out');
  });
});
