#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pty from 'node-pty';
import WebSocket from 'ws';

const VERSION = '0.1.0';
const MAX_OUTPUT = 128_000;
const MAX_WRITE = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`toolplane connector ${VERSION}

Usage:
  connector connect --server <url> --token <token> --root <path>

Example:
  npx -y @toolplane/connector connect --server http://localhost:3002 --token mcpcon_... --root ~/toolplane-sandbox
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') usage(0);
  if (command !== 'connect') usage(1);

  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) usage(1);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) usage(1);
    flags[key.slice(2)] = value;
    i += 1;
  }

  if (!flags.server || !flags.token) usage(1);
  return {
    server: flags.server,
    token: flags.token,
    root: flags.root || '~/toolplane-sandbox',
  };
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function truncate(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT).toString('utf8')}\n[output truncated]`;
}

function normalizeSandboxPath(raw = '.') {
  const input = String(raw || '.')
    .replace(/\\/g, '/')
    .replace(/^\/workspace\/?/, '')
    .replace(/^\/+/, '')
    .trim() || '.';
  if (input.includes('\0')) throw new Error('Invalid path.');
  const normal = path.posix.normalize(input);
  if (normal === '..' || normal.startsWith('../')) throw new Error('Path escapes connector root.');
  return normal === '.' ? '' : normal;
}

function createRuntime(rootInput) {
  const root = path.resolve(expandHome(rootInput));
  const terminals = new Map();

  function resolvePath(raw = '.') {
    const rel = normalizeSandboxPath(raw);
    const absolute = path.resolve(root, rel);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error('Path escapes connector root.');
    }
    return { rel: rel || '.', absolute };
  }

  async function shellExec(args = {}) {
    const command = String(args.command ?? '');
    if (!command) throw new Error('command is required.');
    const cwd = resolvePath(args.cwd ?? '.').absolute;
    const timeout = Math.min(Math.max(Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), MAX_TIMEOUT_MS);
    const shell = process.env.SHELL || '/bin/sh';

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(shell, ['-lc', command], {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);
      child.stdout.on('data', (chunk) => {
        stdout = truncate(stdout + chunk.toString('utf8'));
      });
      child.stderr.on('data', (chunk) => {
        stderr = truncate(stderr + chunk.toString('utf8'));
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: String(error.message) });
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut, stdout, stderr });
      });
      child.stdin.end(String(args.stdin ?? '').slice(0, MAX_WRITE));
    });
  }

  async function listDir(args = {}) {
    const target = resolvePath(args.path ?? '.');
    const names = await fs.readdir(target.absolute, { withFileTypes: true });
    const entries = await Promise.all(names.map(async (entry) => {
      const full = path.join(target.absolute, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat?.size ?? null,
      };
    }));
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: target.rel, entries };
  }

  async function readFile(args = {}) {
    const target = resolvePath(args.path);
    const content = await fs.readFile(target.absolute, 'utf8');
    return { path: target.rel, content: truncate(content) };
  }

  async function writeFile(args = {}) {
    const target = resolvePath(args.path);
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE) throw new Error('File content is too large.');
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, content, 'utf8');
    return { path: target.rel, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async function terminalCreate(ws, args = {}) {
    const terminalId = randomUUID();
    const cols = Math.min(Math.max(Number(args.cols) || 80, 20), 240);
    const rows = Math.min(Math.max(Number(args.rows) || 24, 6), 80);
    const shell = process.env.SHELL || '/bin/sh';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: root,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'C.UTF-8',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      },
    });
    terminals.set(terminalId, term);
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal_data', terminalId, data }));
      }
    });
    term.onExit(({ exitCode, signal }) => {
      terminals.delete(terminalId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal_exit', terminalId, exitCode, signal }));
      }
    });
    return { terminalId };
  }

  async function terminalInput(args = {}) {
    const term = terminals.get(String(args.terminalId ?? ''));
    if (!term) throw new Error('terminal session not found');
    term.write(String(args.data ?? '').slice(0, MAX_WRITE));
    return { ok: true };
  }

  async function terminalResize(args = {}) {
    const term = terminals.get(String(args.terminalId ?? ''));
    if (!term) throw new Error('terminal session not found');
    const cols = Math.min(Math.max(Number(args.cols) || 80, 20), 240);
    const rows = Math.min(Math.max(Number(args.rows) || 24, 6), 80);
    term.resize(cols, rows);
    return { ok: true };
  }

  async function terminalClose(args = {}) {
    const terminalId = String(args.terminalId ?? '');
    const term = terminals.get(terminalId);
    if (term) {
      term.kill();
      terminals.delete(terminalId);
    }
    return { ok: true };
  }

  function closeAllTerminals() {
    for (const term of terminals.values()) term.kill();
    terminals.clear();
  }

  async function handle(ws, op, args) {
    switch (op) {
      case 'ping':
        await fs.mkdir(root, { recursive: true });
        return { ok: true, root };
      case 'shell_exec':
        return shellExec(args);
      case 'list_dir':
        return listDir(args);
      case 'read_file':
        return readFile(args);
      case 'write_file':
        return writeFile(args);
      case 'terminal_create':
        return terminalCreate(ws, args);
      case 'terminal_input':
        return terminalInput(args);
      case 'terminal_resize':
        return terminalResize(args);
      case 'terminal_close':
        return terminalClose(args);
      default:
        throw new Error(`Unknown connector op: ${op}`);
    }
  }

  return { root, handle, closeAllTerminals };
}

async function bootstrap(server, token) {
  const url = new URL('/api/v1/connectors/bootstrap', server);
  url.searchParams.set('token', token);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `bootstrap failed (${res.status})`));
  if (!body.wsUrl) throw new Error('bootstrap did not return a wsUrl');
  return body;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOnce(wsUrl, runtime) {
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  console.log(`[connector] connected; root=${runtime.root}`);
  ws.send(JSON.stringify({ type: 'hello', version: VERSION, root: runtime.root }));

  ws.on('message', (raw) => {
    void (async () => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== 'request') return;
      try {
        const result = await runtime.handle(ws, msg.op, msg.args ?? {});
        ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result }));
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'response',
          id: msg.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
  });

  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.once('error', resolve);
  });
  runtime.closeAllTerminals();
  console.log('[connector] disconnected');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const boot = await bootstrap(args.server, args.token);
  const runtime = createRuntime(args.root || boot.root);
  await fs.mkdir(runtime.root, { recursive: true });
  console.log(`[connector] sandbox=${boot.name ?? boot.sandboxId}`);
  console.log(`[connector] broker=${boot.wsUrl.replace(args.token, '<token>')}`);

  for (;;) {
    try {
      await connectOnce(boot.wsUrl, runtime);
    } catch (error) {
      console.error(`[connector] ${error instanceof Error ? error.message : String(error)}`);
    }
    await wait(2000);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
