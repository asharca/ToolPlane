import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pty from 'node-pty';
import WebSocket from 'ws';

export const VERSION = '0.1.13';
export const PROTOCOL_VERSION = '2026-07-connector-ws-v2';
const MAX_OUTPUT = 128_000;
const MAX_WRITE = 2_000_000;
const MAX_DOWNLOAD = 5_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROCESS_ARGS = 128;
const MAX_PROCESS_ARG_LENGTH = 8_192;
const MAX_PROCESS_ARG_TOTAL = 24_000;
const MAX_SCREEN_BUFFER = 8_000_000;
const APPLE_RFB_BANNER = Buffer.from('RFB 003.889\n');
const RFB_38_BANNER = Buffer.from('RFB 003.008\n');
const DEFAULT_ROOT = '~/toolplane-sandbox';
const CONNECTOR_FLAGS = new Set(['server', 'token', 'root', 'android', 'screen-vnc']);
const CONNECTOR_CAPABILITIES = ['process_exec', 'write_file_base64'];

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`toolplane connector ${VERSION}

Usage:
  connector connect --server <url> --token <token> [--root <path>] [--android <serial|auto>]
  connector connect --server <url> --token <token> [--root <path>] [--screen-vnc <127.0.0.1:port|auto>]

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
  const parsed = {
    help: false,
    command,
    server: flags.server,
    token: flags.token,
    root: flags.root,
  };
  if (flags.android) parsed.android = validateAndroidSelector(flags.android);
  if (flags['screen-vnc']) {
    parseVncEndpoint(flags['screen-vnc']);
    parsed.screenVnc = flags['screen-vnc'];
  }
  if (parsed.android && parsed.screenVnc) {
    throw new Error('--android and --screen-vnc cannot be used together.');
  }
  return parsed;
}

export function validateAndroidSelector(value) {
  const serial = String(value ?? '');
  if (serial === 'auto') return serial;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial)) {
    throw new Error('Android serial must be "auto" or a bounded ADB serial.');
  }
  return serial;
}

export function parseVncEndpoint(value) {
  const input = String(value ?? '');
  if (input === 'auto') return { host: '127.0.0.1', port: 5900 };
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(input);
  const port = Number(match?.[1]);
  if (!match || port > 65535) {
    throw new Error('--screen-vnc must be "auto" or 127.0.0.1:<port>.');
  }
  return { host: '127.0.0.1', port };
}

export function probeVncEndpoint(endpoint, timeoutMs = 750) {
  const target = typeof endpoint === 'string' ? parseVncEndpoint(endpoint) : endpoint;
  return new Promise((resolve) => {
    const socket = net.createConnection(target);
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(Math.min(Math.max(Number(timeoutMs) || 750, 1), 5000));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
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

export function createRuntime(rootInput, options = {}) {
  const root = path.resolve(expandHome(rootInput));
  const terminals = new Map();
  const screenSessions = new Map();
  const activeChildren = new Set();
  let canonicalRootPromise;
  const platform = process.platform;
  const shell = connectorShell(platform);
  const vnc = options.screenVnc
    ? (typeof options.screenVnc === 'string' ? parseVncEndpoint(options.screenVnc) : options.screenVnc)
    : null;
  const info = {
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform,
    arch: process.arch,
    shell,
    shellFamily: isWindows(platform) ? 'powershell' : 'posix',
    nodeVersion: process.versions.node,
    capabilities: vnc ? [...CONNECTOR_CAPABILITIES, 'screen'] : CONNECTOR_CAPABILITIES,
    root,
    ...(vnc ? {
      device: { kind: 'computer', name: os.hostname() },
      displays: [{ id: 'vnc', label: 'Screen', transport: 'rfb', control: true }],
    } : {}),
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
    const target = await assertCanonicalPath(resolvePath(args.cwd ?? '.'));
    if (!(await fs.stat(target.absolute)).isDirectory()) throw new Error('Terminal cwd is not a directory.');
    const term = pty.spawn(shell, terminalShellArgs(platform), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: target.absolute,
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

  function screenSourceUrl(raw) {
    if (!options.wsUrl || !options.token) throw new Error('Screen relay is not configured.');
    let source;
    let broker;
    try {
      source = new URL(String(raw ?? ''));
      broker = new URL(String(options.wsUrl));
    } catch {
      throw new Error('Invalid screen source URL.');
    }
    if (!['ws:', 'wss:'].includes(source.protocol)
      || source.protocol !== broker.protocol
      || source.host !== broker.host
      || source.username
      || source.password
      || source.hash) {
      throw new Error('Screen source URL must use the connector broker origin.');
    }
    return source.toString();
  }

  async function screenOpen(args = {}) {
    if (!vnc) throw new Error('VNC screen is not configured.');
    if (args.displayId !== 'vnc') throw new Error('Unknown display.');
    const sessionId = String(args.sessionId ?? '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid screen session id.');
    if (screenSessions.has(sessionId)) throw new Error('Screen session already exists.');
    const source = new WebSocket(screenSourceUrl(args.sourceUrl), {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: 8_000_000,
      perMessageDeflate: false,
    });
    const socket = net.createConnection(vnc);

    try {
      await new Promise((resolve, reject) => {
        let sourceReady = false;
        let socketReady = false;
        let settled = false;
        const timer = setTimeout(() => fail(new Error('Screen relay connection timed out.')), 10_000);
        const ready = () => {
          if (!settled && sourceReady && socketReady) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('Screen relay connection failed.'));
        };
        source.once('open', () => {
          sourceReady = true;
          ready();
        });
        source.once('unexpected-response', (_request, response) => {
          fail(new Error(`Screen relay rejected the connector (${response.statusCode}).`));
        });
        source.once('error', fail);
        source.once('close', () => fail(new Error('Screen relay closed during connection.')));
        socket.once('connect', () => {
          socketReady = true;
          ready();
        });
        socket.once('error', fail);
        socket.once('close', () => fail(new Error('VNC server closed during connection.')));
      });
    } catch (error) {
      source.close();
      socket.destroy();
      throw error;
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      screenSessions.delete(sessionId);
      socket.destroy();
      if (source.readyState === WebSocket.OPEN || source.readyState === WebSocket.CONNECTING) source.close();
    };
    screenSessions.set(sessionId, { close });
    const relayToViewer = (data) => {
      if (!data.length || source.readyState !== WebSocket.OPEN) return;
      if (source.bufferedAmount + data.byteLength > MAX_SCREEN_BUFFER) {
        close();
        return;
      }
      source.send(data, { binary: true }, (error) => {
        if (error) close();
      });
    };
    source.on('message', (data, binary) => {
      if (!binary) {
        source.close(1003, 'binary RFB data required');
        return;
      }
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (socket.writableLength + chunk.byteLength > MAX_SCREEN_BUFFER) {
        close();
        return;
      }
      socket.write(chunk);
    });
    let pendingVncBanner = Buffer.alloc(0);
    let pendingAppleSecurityTypes = null;
    socket.on('data', (chunk) => {
      let data = chunk;
      if (pendingVncBanner !== null) {
        pendingVncBanner = Buffer.concat([pendingVncBanner, chunk]);
        if (pendingVncBanner.length < APPLE_RFB_BANNER.length) return;
        const banner = pendingVncBanner.subarray(0, APPLE_RFB_BANNER.length);
        const apple = banner.equals(APPLE_RFB_BANNER);
        data = pendingVncBanner.subarray(APPLE_RFB_BANNER.length);
        pendingVncBanner = null;
        if (apple) pendingAppleSecurityTypes = Buffer.alloc(0);
        relayToViewer(apple ? RFB_38_BANNER : banner);
      }
      if (pendingAppleSecurityTypes !== null) {
        pendingAppleSecurityTypes = Buffer.concat([pendingAppleSecurityTypes, data]);
        if (!pendingAppleSecurityTypes.length) return;
        const count = pendingAppleSecurityTypes[0];
        if (count > 0 && pendingAppleSecurityTypes.length < count + 1) return;
        const offered = pendingAppleSecurityTypes.subarray(1, count + 1);
        data = Buffer.concat([
          offered.includes(2) ? Buffer.from([1, 2]) : pendingAppleSecurityTypes.subarray(0, count + 1),
          pendingAppleSecurityTypes.subarray(count + 1),
        ]);
        pendingAppleSecurityTypes = null;
      }
      relayToViewer(data);
    });
    source.once('close', close);
    source.once('error', close);
    socket.once('close', close);
    socket.once('error', close);
    return { ok: true, sessionId, displayId: 'vnc' };
  }

  function closeAllTerminals() {
    for (const term of terminals.values()) term.kill();
    terminals.clear();
    for (const session of screenSessions.values()) session.close();
    screenSessions.clear();
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
      case 'screen_open':
        return screenOpen(args);
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
  let runtime;
  if (args.android) {
    const { createAndroidRuntime, resolveAndroidRoot } = await import('./android.mjs');
    runtime = await createAndroidRuntime(
      resolveAndroidRoot(args.root, boot.root),
      args.android,
    );
  } else {
    let screenVnc = null;
    if (args.screenVnc) {
      const endpoint = parseVncEndpoint(args.screenVnc);
      if (await probeVncEndpoint(endpoint)) {
        screenVnc = endpoint;
      } else {
        console.log(`[connector] VNC unavailable at ${endpoint.host}:${endpoint.port}; screen disabled`);
      }
    }
    runtime = createRuntime(resolveConnectorRoot(args.root, boot.root), {
      screenVnc,
      token: args.token,
      wsUrl: boot.wsUrl,
    });
    await fs.mkdir(runtime.root, { recursive: true });
  }
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
