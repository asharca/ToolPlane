import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import pty from 'node-pty';
import WebSocket from 'ws';
import {
  normalizeSandboxPath,
  PROTOCOL_VERSION,
  validateAndroidSelector,
  VERSION,
} from './runtime.mjs';

const MAX_OUTPUT = 128_000;
const MAX_WRITE = 2_000_000;
const MAX_DOWNLOAD = 5_000_000;
const MAX_SCREENSHOT = 5_000_000;
const MAX_LISTING = 5_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROCESS_ARGS = 128;
const MAX_PROCESS_ARG_LENGTH = 8_192;
const MAX_PROCESS_ARG_TOTAL = 24_000;
const DEFAULT_ANDROID_ROOT = '/sdcard/ToolPlane';
const ANDROID_CAPABILITIES = [
  'process_exec',
  'write_file_base64',
  'terminal',
  'files',
  'screen_capture',
];

function adbExecutable(env = process.env) {
  const value = String(env.TOOLPLANE_CONNECTOR_ADB || 'adb');
  if (!value || value.includes('\0')) throw new Error('Invalid ADB executable.');
  return value;
}

function stopChild(child) {
  if (child.exitCode === null) child.kill('SIGKILL');
}

function runCommand(command, args, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), MAX_TIMEOUT_MS);
  const maxStdout = Number(options.maxStdout ?? MAX_OUTPUT);
  return new Promise((resolve) => {
    let stdoutSize = 0;
    let stderrSize = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let tooLarge = false;
    let timedOut = false;
    let settled = false;
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    options.children?.add(child);
    const append = (chunks, chunk, size, limit) => {
      const remaining = Math.max(limit - size, 0);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      return { size: size + Math.min(chunk.length, remaining), truncated: chunk.length > remaining };
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.children?.delete(child);
      resolve({
        ...result,
        timedOut,
        tooLarge,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutTruncated,
        stderrTruncated,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const next = append(stdout, chunk, stdoutSize, maxStdout);
      stdoutSize = next.size;
      stdoutTruncated ||= next.truncated;
      if (stdoutTruncated && options.rejectOverflow && !tooLarge) {
        tooLarge = true;
        stopChild(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      const next = append(stderr, chunk, stderrSize, MAX_OUTPUT);
      stderrSize = next.size;
      stderrTruncated ||= next.truncated;
    });
    child.once('error', (error) => finish({
      exitCode: null,
      signal: null,
      errorCode: typeof error.code === 'string' ? error.code : null,
      spawnError: error.message,
    }));
    child.once('close', (exitCode, signal) => finish({ exitCode, signal, errorCode: null, spawnError: null }));
    const input = Buffer.isBuffer(options.stdin)
      ? options.stdin
      : Buffer.from(String(options.stdin ?? ''), 'utf8');
    child.stdin.end(input.subarray(0, MAX_WRITE));
  });
}

function textResult(result) {
  const text = (buffer, truncated) => `${buffer.toString('utf8')}${truncated ? '\n[output truncated]' : ''}`;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: text(result.stdout, result.stdoutTruncated),
    stderr: text(result.stderr, result.stderrTruncated),
    errorCode: result.errorCode,
  };
}

function checked(result, label) {
  if (result.tooLarge) throw new Error(`${label} output is too large.`);
  if (result.timedOut) throw new Error(`${label} timed out.`);
  if (result.errorCode || result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.toString('utf8').trim();
    throw new Error(detail ? `${label} failed: ${detail}` : `${label} failed.`);
  }
  return result.stdout;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function remoteShellArgs(serial, script, raw = true) {
  return ['-s', serial, raw ? 'exec-out' : 'shell', `sh -c ${shellQuote(script)}`];
}

function cleanEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && typeof raw === 'string'
      && !raw.includes('\0')
      && raw.length <= MAX_PROCESS_ARG_LENGTH) env[key] = raw;
  }
  return env;
}

function exportEnv(value) {
  return Object.entries(cleanEnv(value)).map(([key, raw]) => `export ${key}=${shellQuote(raw)};`).join(' ');
}

function decodeFileContent(args) {
  const encoding = String(args.encoding ?? 'utf8');
  const raw = String(args.content ?? '');
  if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('Unsupported file encoding.');
  if (encoding === 'base64'
    && (raw.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw))) {
    throw new Error('Invalid base64 file content.');
  }
  const content = Buffer.from(raw, encoding);
  if (content.byteLength > MAX_WRITE) throw new Error('File content is too large.');
  return content;
}

function boundedCommand(value, name) {
  const command = String(value ?? '');
  if (!command || command.includes('\0') || command.length > MAX_PROCESS_ARG_TOTAL) {
    throw new Error(`${name} is required and must be bounded.`);
  }
  return command;
}

function processArgs(value) {
  const args = value ?? [];
  const totalLength = Array.isArray(args)
    ? args.reduce((total, arg) => total + (typeof arg === 'string' ? arg.length : MAX_PROCESS_ARG_TOTAL + 1), 0)
    : MAX_PROCESS_ARG_TOTAL + 1;
  if (!Array.isArray(args)
    || args.length > MAX_PROCESS_ARGS
    || totalLength > MAX_PROCESS_ARG_TOTAL
    || args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_PROCESS_ARG_LENGTH)) {
    throw new Error(`args must contain at most ${MAX_PROCESS_ARGS} bounded strings.`);
  }
  return args;
}

export function resolveAndroidRoot(cliRoot, bootstrapRoot) {
  const input = String(cliRoot || bootstrapRoot || DEFAULT_ANDROID_ROOT).trim();
  if (!input || /[\0\r\n]/.test(input) || Buffer.byteLength(input) > 1024) {
    throw new Error('Invalid Android root.');
  }
  const expanded = input === '~'
    ? '/data/local/tmp'
    : input.startsWith('~/')
      ? `/data/local/tmp/${input.slice(2)}`
      : input;
  if (!path.posix.isAbsolute(expanded)) throw new Error('Android root must be an absolute device path.');
  const root = path.posix.normalize(expanded);
  if (root === '/') throw new Error('Android root cannot be the device filesystem root.');
  return root;
}

export async function resolveAndroidSerial(selector, options = {}) {
  const requested = validateAndroidSelector(selector);
  const adb = options.adb || adbExecutable(options.env);
  if (requested !== 'auto') {
    const result = await runCommand(adb, ['-s', requested, 'get-state'], { timeoutMs: 10_000 });
    checked(result, 'ADB device check');
    if (result.stdout.toString('utf8').trim() !== 'device') throw new Error(`Android device ${requested} is not ready.`);
    return requested;
  }

  const result = await runCommand(adb, ['devices'], { timeoutMs: 10_000 });
  checked(result, 'ADB device discovery');
  const devices = result.stdout.toString('utf8').split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+device(?:\s|$)/.exec(line.trim());
    if (!match) return [];
    try {
      return [validateAndroidSelector(match[1])];
    } catch {
      return [];
    }
  });
  if (devices.length !== 1) {
    throw new Error(devices.length ? 'More than one Android device is ready; pass --android <serial>.' : 'No authorized Android device is ready.');
  }
  return devices[0];
}

export async function createAndroidRuntime(rootInput, selector, options = {}) {
  const root = resolveAndroidRoot(rootInput);
  const adb = options.adb || adbExecutable(options.env);
  const serial = await resolveAndroidSerial(selector, { adb });
  const terminals = new Map();
  const activeChildren = new Set();
  const run = (script, runOptions = {}) => runCommand(adb, remoteShellArgs(serial, script), {
    ...runOptions,
    children: activeChildren,
  });
  checked(await run(`mkdir -p ${shellQuote(root)} && (command -v realpath >/dev/null 2>&1 || command -v readlink >/dev/null 2>&1)`), 'Android root setup');
  const metadata = checked(await run('printf "%s\\n" "$(getprop ro.product.model)" "$(uname -m)"'), 'Android device metadata')
    .toString('utf8').split(/\r?\n/);
  const model = metadata[0]?.trim().slice(0, 128) || serial;
  const arch = metadata[1]?.trim().slice(0, 64) || 'unknown';
  const info = {
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: 'android',
    arch,
    shell: '/system/bin/sh',
    shellFamily: 'posix',
    capabilities: ANDROID_CAPABILITIES,
    root,
    device: { kind: 'android', name: model },
    displays: [{ id: 'main', label: 'Screen', transport: 'snapshot', control: false }],
  };

  function targetPath(raw = '.', requireChild = false) {
    const value = String(raw ?? '.');
    if (/[\0\r\n]/.test(value) || Buffer.byteLength(value) > 1024) throw new Error('Invalid Android path.');
    const rel = normalizeSandboxPath(value);
    if (requireChild && !rel) throw new Error('A file path is required.');
    return { rel: rel || '.', absolute: rel ? path.posix.join(root, rel) : root };
  }

  async function assertPath(target, writable = false) {
    const script = `canonical() { if command -v realpath >/dev/null 2>&1; then realpath "$1"; else readlink -f "$1"; fi; }
root_path=${shellQuote(root)}
root_canon=$(canonical "$root_path") || exit 40
probe=${shellQuote(target.absolute)}
${writable ? 'while [ ! -e "$probe" ] && [ ! -L "$probe" ]; do [ "$probe" = "$root_path" ] && break; probe=${probe%/*}; done' : ''}
actual=$(canonical "$probe") || exit 41
case "$actual" in "$root_canon"|"$root_canon"/*) exit 0 ;; *) exit 42 ;; esac`;
    const result = await run(script, { timeoutMs: 10_000 });
    if (result.exitCode === 42) throw new Error('Path escapes Android connector root through a link.');
    checked(result, 'Android path validation');
    return target;
  }

  async function ping() {
    const result = await runCommand(adb, ['-s', serial, 'get-state'], { timeoutMs: 10_000, children: activeChildren });
    checked(result, 'ADB device check');
    if (result.stdout.toString('utf8').trim() !== 'device') throw new Error('Android device is not ready.');
    return { ok: true, ...info };
  }

  async function shellExec(args = {}) {
    const command = boundedCommand(args.command, 'command');
    const cwd = await assertPath(targetPath(args.cwd ?? '.'));
    const result = await run(`cd ${shellQuote(cwd.absolute)} || exit 44; ${exportEnv(args.env)} exec sh -c ${shellQuote(command)}`, {
      stdin: String(args.stdin ?? ''),
      timeoutMs: args.timeoutMs,
    });
    return textResult(result);
  }

  async function processExec(args = {}) {
    const runtime = String(args.runtime ?? '');
    if (!['node', 'python', 'bash'].includes(runtime)) throw new Error('runtime must be node, python, or bash.');
    const commandArgs = processArgs(args.args);
    const cwd = await assertPath(targetPath(args.cwd ?? '.'));
    const selectorScript = runtime === 'python'
      ? 'exe=$(command -v python3 || command -v python)'
      : `exe=$(command -v ${runtime === 'bash' ? 'sh' : 'node'})`;
    const result = await run(`cd ${shellQuote(cwd.absolute)} || exit 44; ${selectorScript} || exit 127; ${exportEnv(args.env)} exec "$exe" ${commandArgs.map(shellQuote).join(' ')}`, {
      stdin: String(args.stdin ?? ''),
      timeoutMs: args.timeoutMs,
    });
    return {
      ...textResult(result),
      errorCode: result.exitCode === 127 ? 'RUNTIME_UNAVAILABLE' : result.errorCode,
      runtime,
      executable: result.exitCode === 127 ? null : runtime === 'bash' ? 'sh' : runtime,
    };
  }

  async function listDir(args = {}) {
    const target = await assertPath(targetPath(args.path ?? '.'));
    const script = `target=${shellQuote(target.absolute)}
[ -d "$target" ] || exit 44
for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=${'${entry##*/}'}
  if [ -d "$entry" ]; then type=dir; size=; else type=file; size=$(wc -c < "$entry" 2>/dev/null || true); fi
  printf '%s\\0%s\\0%s\\0' "$name" "$type" "$size"
done`;
    const result = await run(script, { maxStdout: MAX_LISTING, rejectOverflow: true });
    const output = checked(result, 'Android directory listing');
    const fields = output.toString('utf8').split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3 !== 0) throw new Error('Android directory listing was malformed.');
    const entries = [];
    for (let index = 0; index < fields.length; index += 3) {
      entries.push({
        name: fields[index],
        type: fields[index + 1],
        size: fields[index + 2] === '' ? null : Number(fields[index + 2]),
      });
    }
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: target.rel, entries };
  }

  async function readFile(args = {}) {
    const target = await assertPath(targetPath(args.path, true));
    const result = await run(`[ -f ${shellQuote(target.absolute)} ] || exit 44; head -c ${MAX_OUTPUT + 1} ${shellQuote(target.absolute)}`, {
      maxStdout: MAX_OUTPUT + 1,
    });
    const output = checked(result, 'Android file read');
    const truncated = output.length > MAX_OUTPUT;
    return {
      path: target.rel,
      content: `${output.subarray(0, MAX_OUTPUT).toString('utf8')}${truncated ? '\n[output truncated]' : ''}`,
    };
  }

  async function writeFile(args = {}) {
    const target = await assertPath(targetPath(args.path, true), true);
    const content = decodeFileContent(args);
    const parent = path.posix.dirname(target.absolute);
    const result = await run(`mkdir -p ${shellQuote(parent)} && [ ! -L ${shellQuote(target.absolute)} ] && cat > ${shellQuote(target.absolute)}`, {
      stdin: content,
      timeoutMs: args.timeoutMs,
    });
    checked(result, 'Android file write');
    return { path: target.rel, bytes: content.byteLength };
  }

  async function downloadFile(args = {}) {
    const target = await assertPath(targetPath(args.path, true));
    const result = await run(`[ -f ${shellQuote(target.absolute)} ] || exit 44; head -c ${MAX_DOWNLOAD + 1} ${shellQuote(target.absolute)}`, {
      maxStdout: MAX_DOWNLOAD + 1,
    });
    const output = checked(result, 'Android file download');
    if (output.length > MAX_DOWNLOAD) throw new Error(`File is too large to download from the sidebar. Max ${MAX_DOWNLOAD} bytes.`);
    return {
      path: target.rel,
      filename: path.posix.basename(target.absolute),
      encoding: 'base64',
      content: output.toString('base64'),
      size: output.length,
    };
  }

  async function deleteFile(args = {}) {
    const target = await assertPath(targetPath(args.path, true));
    const result = await run(`[ -f ${shellQuote(target.absolute)} ] || exit 44; rm -f ${shellQuote(target.absolute)}`);
    checked(result, 'Android file delete');
    return { path: target.rel, deleted: true };
  }

  async function terminalCreate(ws, args = {}) {
    const terminalId = randomUUID();
    const cols = Math.min(Math.max(Number(args.cols) || 80, 20), 240);
    const rows = Math.min(Math.max(Number(args.rows) || 24, 6), 80);
    const cwd = await assertPath(targetPath(args.cwd ?? '.'));
    const script = `cd ${shellQuote(cwd.absolute)} || exit 44; ${exportEnv(args.env)} exec sh -i`;
    const term = pty.spawn(adb, ['-s', serial, 'shell', '-tt', `sh -c ${shellQuote(script)}`], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    terminals.set(terminalId, term);
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_data', terminalId, data }));
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

  async function screenCapture(args = {}) {
    if ((args.displayId ?? 'main') !== 'main') throw new Error('Unknown display.');
    const result = await runCommand(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      timeoutMs: Math.min(Number(args.timeoutMs) || 15_000, 30_000),
      maxStdout: MAX_SCREENSHOT,
      rejectOverflow: true,
      children: activeChildren,
    });
    const data = checked(result, 'Android screen capture');
    if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('Android screen capture did not return a PNG image.');
    }
    return { data: data.toString('base64'), contentType: 'image/png', size: data.length };
  }

  function closeAllTerminals() {
    for (const term of terminals.values()) term.kill();
    terminals.clear();
    for (const child of activeChildren) stopChild(child);
    activeChildren.clear();
  }

  async function handle(ws, op, args) {
    switch (op) {
      case 'ping': return ping();
      case 'shell_exec': return shellExec(args);
      case 'process_exec': return processExec(args);
      case 'list_dir': return listDir(args);
      case 'read_file': return readFile(args);
      case 'write_file': return writeFile(args);
      case 'write_file_base64': return writeFile({ ...args, encoding: 'base64' });
      case 'download_file': return downloadFile(args);
      case 'delete_file': return deleteFile(args);
      case 'terminal_create': return terminalCreate(ws, args);
      case 'terminal_input': return terminalInput(args);
      case 'terminal_resize': return terminalResize(args);
      case 'terminal_close': return terminalClose(args);
      case 'screen_capture': return screenCapture(args);
      default: throw new Error(`Unknown connector op: ${op}`);
    }
  }

  return { root, info, handle, closeAllTerminals };
}
