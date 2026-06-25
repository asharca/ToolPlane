import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-stdio-mcp.mjs');

function startBridge(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        MCP_PORT: '0',
        MCP_NAME: 'fake',
        MCP_COMMAND: process.execPath,
        MCP_ARGS: JSON.stringify([FIXTURE]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('bridge did not print LISTENING')), 8000);
    proc.stdout.on('data', (b: Buffer) => {
      const m = /LISTENING (\d+)/.exec(b.toString());
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.on('error', reject);
  });
}

async function rpc(port: number, method: string, params?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return res.json();
}

let proc: ChildProcess | undefined;
afterAll(() => {
  proc?.kill('SIGKILL');
});

describe('mcp-stdio-bridge', () => {
  it('handshakes then proxies tools/list and tools/call over HTTP', async () => {
    const started = await startBridge();
    proc = started.proc;

    const list = await rpc(started.port, 'tools/list');
    expect((list.result.tools as { name: string }[]).map((t) => t.name)).toContain('ping_tool');

    const call = await rpc(started.port, 'tools/call', { name: 'ping_tool', arguments: {} });
    expect(call.result.content[0].text).toBe('pong');
  });
});
