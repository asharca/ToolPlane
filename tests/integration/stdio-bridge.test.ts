import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');
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
