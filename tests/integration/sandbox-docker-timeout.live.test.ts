// @vitest-environment node
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Live Docker regression; skipped unless explicitly requested with:
// SANDBOX_DOCKER_SMOKE=1 pnpm vitest run tests/integration/sandbox-docker-timeout.live.test.ts
const RUN = process.env.SANDBOX_DOCKER_SMOKE === '1';
const SERVER = path.join(process.cwd(), 'scripts', 'sandbox-mcp-server.mjs');
const execFileAsync = promisify(execFile);
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const sandboxId = `timeout-smoke-${suffix}`;
const container = `toolplane-sandbox-${sandboxId}`;
const volume = `toolplane_sandbox_${sandboxId}`;

let server: ChildProcess | undefined;
let port = 0;

async function docker(args: string[], timeout = 30_000): Promise<string> {
  const result = await execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 1_000_000,
  });
  return result.stdout;
}

async function startServer(): Promise<{ process: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        SANDBOX_ID: sandboxId,
        SANDBOX_IMAGE: 'node:24-bookworm-slim',
        SANDBOX_NETWORK: 'none',
        MCP_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, listeningPort?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        reject(error);
      }
      else resolve({ process: child, port: listeningPort! });
    };
    const timer = setTimeout(() => {
      finish(new Error(`sandbox MCP server did not start: ${stderr || stdout}`));
    }, 180_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /LISTENING (\d+)/.exec(stdout);
      if (match) finish(undefined, Number(match[1]));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`sandbox MCP server exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function processExec(code: string, marker: string) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'process_exec',
        arguments: {
          runtime: 'node',
          args: ['-e', code, marker],
          timeoutMs: 500,
        },
      },
    }),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<{
    result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  }>;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

(RUN ? describe : describe.skip)('sandbox Docker process timeout (live)', () => {
  beforeAll(async () => {
    const started = await startServer();
    server = started.process;
    port = started.port;
  }, 190_000);

  afterAll(async () => {
    if (server) await waitForExit(server);
    await docker(['rm', '-f', container]).catch(() => undefined);
    await docker(['volume', 'rm', '-f', volume]).catch(() => undefined);
  }, 30_000);

  it('kills the timed-out process tree even when the command removes old control files', async () => {
    const marker = `toolplane-timeout-${suffix}`;
    const target = `/workspace/${marker}.txt`;
    const childCode = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(target)}, 'survived'), 2000)`;
    const parentCode = [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      "process.stdout.write('VISIBLE_USER_STDOUT\\n');",
      "for (const name of fs.readdirSync('/tmp')) if (name.startsWith('toolplane-exec-')) fs.rmSync('/tmp/' + name, { force: true });",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}, process.argv[1] + '-child'], { stdio: 'ignore' });`,
      'setTimeout(() => {}, 10000);',
    ].join(' ');

    const rpc = await processExec(parentCode, marker);
    const execution = JSON.parse(rpc.result.content[0].text) as {
      timedOut: boolean;
      signal: string | null;
      stdout: string;
    };
    expect(rpc.result.isError).toBe(true);
    expect(execution).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(execution.stdout).toBe('VISIBLE_USER_STDOUT\n');
    expect(execution.stdout).not.toContain('__TOOLPLANE_EXEC_PID_');

    const survivingProcesses = await docker([
      'exec',
      '-e',
      `REVIEW_MARKER=${marker}`,
      container,
      'sh',
      '-c',
      'for f in /proc/[0-9]*/cmdline; do command=$(tr "\\000" " " < "$f" 2>/dev/null || true); case "$command" in *"$REVIEW_MARKER"*) printf "%s\\n" "$command";; esac; done',
    ]);
    expect(survivingProcesses.trim()).toBe('');

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await expect(docker(['exec', container, 'test', '!', '-e', target])).resolves.toBe('');

    const pidFiles = await docker([
      'exec',
      container,
      'sh',
      '-c',
      'for f in /tmp/toolplane-exec-*.pid; do if [ -e "$f" ]; then printf "%s\\n" "$f"; fi; done',
    ]);
    expect(pidFiles.trim()).toBe('');
  }, 30_000);
});
