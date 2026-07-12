import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pty from 'node-pty';
import WebSocket from 'ws';

export const VERSION = '0.1.9';
export const PROTOCOL_VERSION = '2026-07-connector-ws-v2';
const MAX_OUTPUT = 128_000;
const MAX_WRITE = 2_000_000;
const MAX_DOWNLOAD = 5_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROCESS_ARGS = 128;
const MAX_PROCESS_ARG_LENGTH = 8_192;
const MAX_PROCESS_ARG_TOTAL = 24_000;
const DEFAULT_ROOT = '~/toolplane-sandbox';
const CONNECTOR_FLAGS = new Set(['server', 'token', 'root']);
const CONNECTOR_CAPABILITIES = ['process_exec', 'write_file_base64'];

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`toolplane connector ${VERSION}

Usage:
  connector connect --server <url> --token <token> [--root <path>]

Example:
  npx -y --package "http://localhost:3002/api/v1/connectors/package.tgz?v=${VERSION}" connector connect --server "http://localhost:3002" --token "mcpcon_..." --root "~/toolplane-sandbox"
`);
  process.exit(exitCode);
}

function parseFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--') || !CONNECTOR_FLAGS.has(key.slice(2))) {
      throw new Error(`Unknown connector option: ${key}`);
    }
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    flags[key.slice(2)] = value;
    i += 1;
  }
  return flags;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (command !== 'connect') throw new Error(`Unknown connector command: ${command}`);
  const flags = parseFlags(rest);

  if (!flags.server || !flags.token) throw new Error('Both --server and --token are required.');
  return {
    help: false,
    command,
    server: flags.server,
    token: flags.token,
    root: flags.root,
  };
}

export function expandHome(value, home = os.homedir(), pathApi = path) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return pathApi.join(home, value.slice(2));
  if (value.startsWith('~\\')) return pathApi.join(home, value.slice(2));
  return value;
}

export function resolveConnectorRoot(cliRoot, bootstrapRoot) {
  return String(cliRoot || bootstrapRoot || DEFAULT_ROOT);
}

function truncate(value) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT).toString('utf8')}\n[output truncated]`;
}

function cleanEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof raw === 'string') env[key] = raw;
  }
  return env;
}

export function isWindows(platform = process.platform) {
  return platform === 'win32';
}

export function connectorShell(platform = process.platform, env = process.env) {
  const override = env.TOOLPLANE_CONNECTOR_SHELL;
  if (isWindows(platform)) {
    if (override && ['powershell.exe', 'pwsh.exe'].includes(path.win32.basename(override).toLowerCase())) return override;
    return 'powershell.exe';
  }
  return override || env.SHELL || '/bin/sh';
}

export function shellExecArgs(command, platform = process.platform) {
  return isWindows(platform)
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['-lc', command];
}

export function terminalShellArgs(platform = process.platform) {
  return isWindows(platform) ? ['-NoLogo'] : [];
}

export function normalizeSandboxPath(raw = '.') {
  const input = String(raw || '.')
    .replace(/\\/g, '/')
    .replace(/^\/workspace(?:\/|$)/, '')
    .replace(/^\/+/, '')
    .trim() || '.';
  if (input.includes('\0')) throw new Error('Invalid path.');
  const normal = path.posix.normalize(input);
  if (normal === '..' || normal.startsWith('../')) throw new Error('Path escapes connector root.');
  return normal === '.' ? '' : normal;
}

export function pathIsInside(root, candidate, pathApi = path) {
  const relative = pathApi.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function validBase64(value) {
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeFileContent(args) {
  const encoding = String(args.encoding ?? 'utf8');
  const raw = String(args.content ?? '');
  if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('Unsupported file encoding.');
  if (encoding === 'base64' && !validBase64(raw)) throw new Error('Invalid base64 file content.');
  const content = Buffer.from(raw, encoding);
  if (content.byteLength > MAX_WRITE) throw new Error('File content is too large.');
  return content;
}

function executableCandidates(names, env = process.env) {
  const pathValue = String(env.PATH || '');
  const directories = pathValue.split(path.delimiter).map((entry) => entry.replace(/^"|"$/g, '')).filter(Boolean);
  return directories.flatMap((directory) => names.map((name) => path.resolve(directory, name)));
}

function configuredCandidates(value, fallbackNames, env = process.env) {
  if (value) {
    return path.isAbsolute(value)
      ? [value]
      : executableCandidates([value], env);
  }
  return executableCandidates(fallbackNames, env);
}

function processRuntimeCandidates(runtime, platform = process.platform, env = process.env) {
  if (runtime === 'node') return [{ command: process.execPath, prefixArgs: [] }];
  if (runtime === 'python') {
    const names = isWindows(platform) ? ['py.exe', 'python.exe'] : ['python3', 'python'];
    return configuredCandidates(env.TOOLPLANE_CONNECTOR_PYTHON, names, env).map((command) => ({
      command,
      prefixArgs: isWindows(platform) && path.basename(command).toLowerCase() === 'py.exe' ? ['-3'] : [],
    }));
  }
  if (runtime === 'bash') {
    if (isWindows(platform) && !env.TOOLPLANE_CONNECTOR_BASH) return [];
    const names = isWindows(platform) ? [] : ['bash'];
    return configuredCandidates(env.TOOLPLANE_CONNECTOR_BASH, names, env)
      .map((command) => ({ command, prefixArgs: [] }));
  }
  throw new Error('runtime must be node, python, or bash.');
}

function terminateChild(child, platform = process.platform) {
  if (isWindows(platform) && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      if (child.exitCode === null) child.kill();
    });
    killer.once('close', (exitCode) => {
      if (exitCode !== 0 && child.exitCode === null) child.kill();
    });
    return;
  }
  if (child.exitCode === null && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export function createRuntime(rootInput) {
  const root = path.resolve(expandHome(rootInput));
  const terminals = new Map();
  const activeChildren = new Set();
  let canonicalRootPromise;
  const platform = process.platform;
  const shell = connectorShell(platform);
  const info = {
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform,
    arch: process.arch,
    shell,
    shellFamily: isWindows(platform) ? 'powershell' : 'posix',
    nodeVersion: process.versions.node,
    capabilities: CONNECTOR_CAPABILITIES,
    root,
  };

  function resolvePath(raw = '.') {
    const rel = normalizeSandboxPath(raw);
    const absolute = path.resolve(root, rel);
    if (!pathIsInside(root, absolute)) throw new Error('Path escapes connector root.');
    return { rel: rel || '.', absolute };
  }

  function canonicalRoot() {
    canonicalRootPromise ??= fs.mkdir(root, { recursive: true }).then(() => fs.realpath(root));
    return canonicalRootPromise;
  }

  async function assertCanonicalPath(target, writable = false) {
    const canonical = await canonicalRoot();
    let existing = target.absolute;
    if (writable) {
      for (;;) {
        try {
          await fs.lstat(existing);
          break;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          existing = parent;
        }
      }
    }
    const actual = await fs.realpath(existing);
    if (!pathIsInside(canonical, actual)) throw new Error('Path escapes connector root through a link.');
    return target;
  }

  function runChild(command, commandArgs, args = {}) {
    const timeout = Math.min(Math.max(Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), MAX_TIMEOUT_MS);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(command, commandArgs, {
        cwd: args.cwd,
        env: { ...process.env, ...cleanEnv(args.env), TERM: process.env.TERM || 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows(platform),
      });
      activeChildren.add(child);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        activeChildren.delete(child);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, platform);
      }, timeout);
      child.stdout.on('data', (chunk) => {
        stdout = truncate(stdout + chunk.toString('utf8'));
      });
      child.stderr.on('data', (chunk) => {
        stderr = truncate(stderr + chunk.toString('utf8'));
      });
      child.once('error', (error) => {
        finish({
          exitCode: null,
          signal: null,
          timedOut,
          stdout,
          stderr: String(error.message),
          errorCode: typeof error.code === 'string' ? error.code : null,
        });
      });
      child.once('close', (exitCode, signal) => {
        finish({ exitCode, signal, timedOut, stdout, stderr, errorCode: null });
      });
      const stdin = Buffer.from(String(args.stdin ?? ''), 'utf8').subarray(0, MAX_WRITE);
      child.stdin.end(stdin);
    });
  }

  async function shellExec(args = {}) {
    const command = String(args.command ?? '');
    if (!command) throw new Error('command is required.');
    const cwd = (await assertCanonicalPath(resolvePath(args.cwd ?? '.'))).absolute;
    return runChild(shell, shellExecArgs(command, platform), { ...args, cwd });
  }

  async function processExec(args = {}) {
    const runtime = String(args.runtime ?? '');
    const commandArgs = args.args ?? [];
    const totalLength = Array.isArray(commandArgs)
      ? commandArgs.reduce((total, arg) => total + (typeof arg === 'string' ? arg.length : MAX_PROCESS_ARG_TOTAL + 1), 0)
      : MAX_PROCESS_ARG_TOTAL + 1;
    if (!Array.isArray(commandArgs)
      || commandArgs.length > MAX_PROCESS_ARGS
      || totalLength > MAX_PROCESS_ARG_TOTAL
      || commandArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_PROCESS_ARG_LENGTH)) {
      throw new Error(`args must contain at most ${MAX_PROCESS_ARGS} bounded strings.`);
    }
    const cwd = (await assertCanonicalPath(resolvePath(args.cwd ?? '.'))).absolute;
    const candidates = processRuntimeCandidates(runtime, platform);
    for (const candidate of candidates) {
      const result = await runChild(candidate.command, [...candidate.prefixArgs, ...commandArgs], { ...args, cwd });
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(result.errorCode)) {
        return { ...result, runtime, executable: candidate.command };
      }
    }
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: `${runtime} runtime is unavailable on this connector.`,
      errorCode: 'RUNTIME_UNAVAILABLE',
      runtime,
      executable: null,
    };
  }

  async function listDir(args = {}) {
    const target = await assertCanonicalPath(resolvePath(args.path ?? '.'));
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
    const target = await assertCanonicalPath(resolvePath(args.path));
    const content = await fs.readFile(target.absolute, 'utf8');
    return { path: target.rel, content: truncate(content) };
  }

  async function writeFile(args = {}) {
    const target = await assertCanonicalPath(resolvePath(args.path), true);
    const content = decodeFileContent(args);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, content);
    return { path: target.rel, bytes: content.byteLength };
  }

  async function downloadFile(args = {}) {
    const target = await assertCanonicalPath(resolvePath(args.path));
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile()) throw new Error('Path is not a file.');
    if (stat.size > MAX_DOWNLOAD) throw new Error(`File is too large to download from the sidebar. Max ${MAX_DOWNLOAD} bytes.`);
    const content = await fs.readFile(target.absolute);
    return {
      path: target.rel,
      filename: path.basename(target.absolute),
      encoding: 'base64',
      content: content.toString('base64'),
      size: stat.size,
    };
  }

  async function deleteFile(args = {}) {
    const target = await assertCanonicalPath(resolvePath(args.path));
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile()) throw new Error('Path is not a file.');
    await fs.rm(target.absolute, { force: true });
    return { path: target.rel, deleted: true };
  }

  async function terminalCreate(ws, args = {}) {
    const terminalId = randomUUID();
    const cols = Math.min(Math.max(Number(args.cols) || 80, 20), 240);
    const rows = Math.min(Math.max(Number(args.rows) || 24, 6), 80);
    const term = pty.spawn(shell, terminalShellArgs(platform), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: root,
      env: {
        ...process.env,
        ...cleanEnv(args.env),
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
    for (const child of activeChildren) terminateChild(child, platform);
    activeChildren.clear();
  }

  async function handle(ws, op, args) {
    switch (op) {
      case 'ping':
        await fs.mkdir(root, { recursive: true });
        return { ok: true, ...info };
      case 'shell_exec':
        return shellExec(args);
      case 'process_exec':
        return processExec(args);
      case 'list_dir':
        return listDir(args);
      case 'read_file':
        return readFile(args);
      case 'write_file':
        return writeFile(args);
      case 'write_file_base64':
        return writeFile({ ...args, encoding: 'base64' });
      case 'download_file':
        return downloadFile(args);
      case 'delete_file':
        return deleteFile(args);
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

  return { root, info, handle, closeAllTerminals };
}

async function bootstrap(server, token) {
  const url = new URL('/api/v1/connectors/bootstrap', server);
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `bootstrap failed (${res.status})`));
  if (!body.wsUrl) throw new Error('bootstrap did not return a wsUrl');
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`connector protocol mismatch: expected ${PROTOCOL_VERSION}`);
  }
  return body;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOnce(wsUrl, token, runtime) {
  const ws = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${token}` },
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  console.log(`[connector] connected; root=${runtime.root}`);
  ws.send(JSON.stringify({ type: 'hello', ...runtime.info }));

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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result }));
        }
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'response',
            id: msg.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    })();
  });

  const closed = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.once('close', (code, reason) => finish({ code, reason: reason.toString() }));
    ws.once('error', () => finish({ code: 1006, reason: 'connection error' }));
  });
  runtime.closeAllTerminals();
  console.log('[connector] disconnected');
  return closed;
}

async function runSandboxConnector(args) {
  const boot = await bootstrap(args.server, args.token);
  const runtime = createRuntime(resolveConnectorRoot(args.root, boot.root));
  await fs.mkdir(runtime.root, { recursive: true });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.closeAllTerminals();
    setTimeout(() => process.exit(0), 500);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`[connector] sandbox=${boot.name ?? boot.sandboxId}`);
  console.log(`[connector] broker=${boot.wsUrl}`);

  for (;;) {
    try {
      const closed = await connectOnce(boot.wsUrl, args.token, runtime);
      if ([4000, 4001, 4002].includes(closed.code)) {
        console.error(`[connector] session closed by server (${closed.code}): ${closed.reason}`);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[connector] ${message}`);
      if (/unexpected server response:\s*(?:401|403)/i.test(message)) return;
    }
    await wait(2000);
  }
}

export async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage(1);
    return;
  }
  if (args.help) {
    usage(0);
    return;
  }
  await runSandboxConnector(args);
}
