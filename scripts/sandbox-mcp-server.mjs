// MCP server for one agent sandbox. It exposes a small workspace
// surface over JSON-RPC HTTP: shell execution, bounded file operations, and a
// PTY terminal stream. Docker sandboxes run in a persistent container + volume.
// Connector sandboxes use a user-started WebSocket agent; this process proxies
// sandbox operations through the in-process connector broker.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pty from 'node-pty';

const NAME = process.env.MCP_NAME || 'sandbox';
const KIND = ['connector', 'hermes'].includes(process.env.SANDBOX_KIND)
  ? process.env.SANDBOX_KIND
  : 'docker';
const SANDBOX_ID = process.env.SANDBOX_ID || 'sandbox';
const IMAGE = process.env.SANDBOX_IMAGE || 'mcr.microsoft.com/devcontainers/javascript-node:24-bookworm';
const VOLUME = process.env.SANDBOX_VOLUME || `toolplane_sandbox_${SANDBOX_ID.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
const NETWORK = process.env.SANDBOX_NETWORK === 'none' ? 'none' : 'mcp-sandbox';
const CONNECTOR_REMOTE_ROOT = (process.env.SANDBOX_CONNECTOR_REMOTE_ROOT || '/tmp/toolplane-sandbox').replace(/\/+$/, '') || '.';
const CONNECTOR_BROKER_URL = (process.env.SANDBOX_CONNECTOR_BROKER_URL || 'http://127.0.0.1:9321').replace(/\/+$/, '');
const CONNECTOR_BROKER_TOKEN = process.env.SANDBOX_CONNECTOR_BROKER_TOKEN || '';
const CONTAINER = `toolplane-sandbox-${SANDBOX_ID.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
const USER_ENV = parseEnvJson(process.env.SANDBOX_ENV_JSON || '{}');
const HERMES_RUNTIME_ID = process.env.HERMES_RUNTIME_ID || '';
const HERMES_RUNTIME_API_KEY = process.env.HERMES_RUNTIME_API_KEY || '';
const HERMES_RUNTIME_MODEL_NAME = process.env.HERMES_RUNTIME_MODEL_NAME || 'hermes-agent';
const WORKSPACE_ROOT = KIND === 'hermes' ? '/opt/data/workspace' : '/workspace';
const PROTOCOL_VERSION = '2025-06-18';
const VERSION = '1.0.0';
const MAX_BODY = 4_000_000;
const MAX_HERMES_BODY = 12_000_000;
const MAX_HERMES_DASHBOARD_BODY = 32_000_000;
const MAX_OUTPUT = 128_000;
const MAX_WRITE = 2_000_000;
const DEFAULT_MAX_RUNTIME_UPLOAD = 1_000_000_000;
const configuredRuntimeUploadLimit = Number(process.env.TOOLPLANE_MAX_ATTACHMENT_BYTES);
const MAX_RUNTIME_UPLOAD = Number.isSafeInteger(configuredRuntimeUploadLimit) && configuredRuntimeUploadLimit > 0
  ? configuredRuntimeUploadLimit
  : DEFAULT_MAX_RUNTIME_UPLOAD;
const RUNTIME_UPLOAD_TIMEOUT_MS = 15 * 60_000;
const MAX_DOWNLOAD = 5_000_000;
const MAX_DOWNLOAD_BASE64 = Math.ceil(MAX_DOWNLOAD * 4 / 3) + 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROCESS_ARGS = 128;
const MAX_PROCESS_ARG_LENGTH = 8_192;
const MAX_PROCESS_ARG_TOTAL = 24_000;
const DOCKER_CREATE_TIMEOUT_MS = 15 * 60_000;
const MAX_TERMINAL_BUFFER = 200;
// KILL (but not SYS_ADMIN): CAP_DROP ALL would otherwise let root signal only
// its own uid, blocking root from restarting the non-root Hermes service
// processes that share the sandbox.
const DOCKER_SANDBOX_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'KILL'];
const HERMES_TERMINAL_PATH = '/opt/hermes/.venv/bin:/opt/hermes/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const HERMES_TERMINAL_SHELL = String.raw`
export VIRTUAL_ENV=/opt/hermes/.venv
export PATH=${HERMES_TERMINAL_PATH}
# The terminal runs as the image default user (root). The Hermes service owns
# /opt/data, so the CLI drops back to that user to keep service state files
# (config, gateway state, channel directory) maintainable by the service.
hermes_cli() {
  local hermes_bin
  hermes_bin="$(command -v hermes 2>/dev/null || true)"
  if [ -z "$hermes_bin" ]; then
    echo "hermes: command not found" >&2
    return 127
  fi
  if [ "$(id -u)" = "0" ] && id hermes >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid=hermes --regid=hermes --init-groups \
      env HERMES_HOME=/opt/data HOME=/opt/data "$hermes_bin" "$@"
  else
    "$hermes_bin" "$@"
  fi
}
if command -v bash >/dev/null 2>&1; then
  hermes() {
    local is_gateway_restart=0
    local previous_gateway_pid=0
    if [ "$#" -eq 2 ] && [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
      is_gateway_restart=1
      previous_gateway_pid="$(
        curl --silent --fail --max-time 2 \
          http://127.0.0.1:9119/api/status \
          | /opt/hermes/.venv/bin/python3 -c 'import json, sys; value = json.load(sys.stdin); running = value.get("gateway_running"); pid = int(value.get("gateway_pid") or 0); print(pid if running is True and pid > 0 else 0 if running is False else "")' \
          2>/dev/null || true
      )"
      if [[ ! "$previous_gateway_pid" =~ ^[0-9]+$ ]]; then
        echo "Hermes gateway status could not be verified before restart." >&2
        return 1
      fi
    fi

    hermes_cli "$@"
    local command_status=$?
    if [ "$command_status" -ne 0 ]; then
      return "$command_status"
    fi
    if [ "$is_gateway_restart" -ne 1 ]; then
      return 0
    fi

    # Upstream restart is s6-svc -t, which is a successful no-op for a slot
    # that is already want-down. Follow it with start (-u) and do not return a
    # successful terminal prompt until the real API gateway is healthy.
    hermes_cli gateway start >/dev/null || return $?
    local health_attempt=0
    while [ "$health_attempt" -lt 60 ]; do
      local current_gateway_pid
      current_gateway_pid="$(
        curl --silent --fail --max-time 2 \
          http://127.0.0.1:9119/api/status \
          | /opt/hermes/.venv/bin/python3 -c 'import json, sys; value = json.load(sys.stdin); pid = int(value.get("gateway_pid") or 0); print(pid if value.get("gateway_running") is True and value.get("gateway_state") == "running" and pid > 0 else "")' \
          2>/dev/null || true
      )"
      if [[ "$current_gateway_pid" =~ ^[0-9]+$ ]] \
        && [ "$current_gateway_pid" -gt 0 ] \
        && { [ "$previous_gateway_pid" -le 0 ] || [ "$current_gateway_pid" -ne "$previous_gateway_pid" ]; }; then
        local api_gateway_pid
        api_gateway_pid="$(
          curl --silent --fail --max-time 2 \
            --header "Authorization: Bearer $API_SERVER_KEY" \
            http://127.0.0.1:8642/health/detailed \
            | /opt/hermes/.venv/bin/python3 -c 'import json, sys; value = json.load(sys.stdin); pid = int(value.get("pid") or 0); print(pid if value.get("gateway_state") == "running" and pid > 0 else "")' \
            2>/dev/null || true
        )"
        if [ "$api_gateway_pid" = "$current_gateway_pid" ]; then
          echo "Hermes gateway restarted and is healthy."
          return 0
        fi
      fi
      health_attempt=$((health_attempt + 1))
      sleep 0.75
    done
    echo "Hermes gateway restart was submitted, but the gateway did not become healthy within 45 seconds." >&2
    return 1
  }
  export -f hermes_cli
  export -f hermes
  exec bash
fi
exec sh
`.trim();
// The official Hermes image restricts unattended writes to /opt/data, while
// gateway auto-TTS intentionally renders short-lived replies in this precise
// temp directory. Keep the exception narrow instead of allowing all of /tmp.
const HERMES_TTS_WRITE_SAFE_ROOT_ENV =
  'HERMES_WRITE_SAFE_ROOT=/opt/data:/tmp/hermes_voice';

const TOOLS = [
  {
    name: 'sandbox_info',
    description: 'Return sandbox identity, mode, image/root, and workspace path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shell_exec',
    description: 'Run a command using the sandbox native shell. Connector sandboxes use PowerShell on Windows and a POSIX shell on macOS/Linux. Call sandbox_info first and match its shellFamily.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Relative working directory under the sandbox workspace root.' },
        stdin: { type: 'string', description: 'Optional standard input.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds, max 120000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'process_exec',
    description: 'Run a Node.js, Python, or Bash script with a structured argument array. This avoids shell quoting differences across Windows, macOS, and Linux.',
    inputSchema: {
      type: 'object',
      properties: {
        runtime: { type: 'string', enum: ['node', 'python', 'bash'], description: 'Script runtime.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed directly to the runtime.' },
        cwd: { type: 'string', description: 'Relative working directory under the sandbox workspace root.' },
        stdin: { type: 'string', description: 'Optional standard input.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds, max 120000.' },
      },
      required: ['runtime', 'args'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files under a relative sandbox workspace path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path.' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a UTF-8 text file inside the sandbox workspace, creating parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path.' },
        content: { type: 'string', description: 'Text or base64-encoded file content.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding. Defaults to utf8.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'download_file',
    description: 'Return a file from the sandbox workspace as base64 content for download.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path.' } },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete one file from the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path.' } },
      required: ['path'],
    },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

function truncate(value, max = MAX_OUTPUT) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')}\n[output truncated]`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeRel(raw = '.') {
  const input = String(raw || '.').replace(/\\/g, '/').trim() || '.';
  if (input.startsWith('/') || input.includes('\0')) return null;
  const normal = path.posix.normalize(input);
  if (normal === '..' || normal.startsWith('../')) return null;
  return normal === '.' ? '' : normal;
}

function parseEnvJson(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
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
  return { content, encoding };
}

function parseProcessArgs(args) {
  const runtime = String(args.runtime ?? '');
  if (!['node', 'python', 'bash'].includes(runtime)) {
    throw new Error('runtime must be node, python, or bash.');
  }
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
  return { runtime, commandArgs };
}

async function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeout = Math.min(Math.max(Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (b) => {
      stdout = truncate(stdout + b.toString('utf8'), opts.maxOutput ?? MAX_OUTPUT);
    });
    child.stderr.on('data', (b) => {
      stderr = truncate(stderr + b.toString('utf8'), opts.maxOutput ?? MAX_OUTPUT);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: String(error.message) });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
    const maxInput = Math.min(Math.max(Number(opts.maxInput ?? MAX_WRITE), 0), MAX_WRITE);
    const input = Buffer.isBuffer(opts.stdin)
      ? opts.stdin.subarray(0, maxInput)
      : Buffer.from(String(opts.stdin ?? ''), 'utf8').subarray(0, maxInput);
    child.stdin.end(input);
  });
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > max) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => resolve(body));
  });
}

function readBuffer(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > max) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function dockerEnv() {
  const keys = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function connectorHeaders(extra = {}) {
  return {
    ...extra,
    'x-connector-broker-token': CONNECTOR_BROKER_TOKEN,
  };
}

async function connectorFetch(pathname, init = {}) {
  return fetch(`${CONNECTOR_BROKER_URL}${pathname}`, {
    ...init,
    headers: connectorHeaders(init.headers ?? {}),
  });
}

async function connectorRequest(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await connectorFetch(`/internal/connectors/${encodeURIComponent(SANDBOX_ID)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args, timeoutMs }),
    signal: AbortSignal.timeout(Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS) + 1000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error ?? `connector broker request failed (${res.status})`));
  return json.result;
}

async function connectorTool(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS, isError = () => false) {
  try {
    const result = await connectorRequest(op, args, timeoutMs);
    return textResult(result, isError(result));
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

async function dockerInspectJson() {
  const inspected = await run('docker', ['inspect', CONTAINER], { env: dockerEnv(), timeoutMs: 10_000 });
  if (inspected.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(inspected.stdout);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch {
    return null;
  }
}

function hasExpectedDockerSandboxCaps(info) {
  const hostConfig = info?.HostConfig ?? {};
  const capDrop = new Set((hostConfig.CapDrop ?? []).map((cap) => String(cap).toUpperCase()));
  const capAdd = new Set((hostConfig.CapAdd ?? []).map((cap) => String(cap).toUpperCase()));
  const mountTarget = KIND === 'hermes' ? '/opt/data' : '/workspace';
  const expectedMount = (info?.Mounts ?? []).some(
    (mount) => mount?.Destination === mountTarget && mount?.Name === VOLUME,
  );
  const containerEnv = new Set(info?.Config?.Env ?? []);
  const hermesRuntimeConfigured = KIND !== 'hermes' || [
    'HERMES_HOME=/opt/data',
    'HERMES_DASHBOARD=1',
    'HERMES_DASHBOARD_HOST=127.0.0.1',
    'HERMES_DASHBOARD_PORT=9119',
    'GATEWAY_MULTIPLEX_PROFILES=1',
    HERMES_TTS_WRITE_SAFE_ROOT_ENV,
  ].every((entry) => containerEnv.has(entry));
  return capDrop.has('ALL')
    && DOCKER_SANDBOX_CAPS.every((cap) => capAdd.has(cap))
    && info?.Config?.Image === IMAGE
    && expectedMount
    && hermesRuntimeConfigured;
}

function dockerCreateArgs() {
  const base = [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--label',
    `toolplane.sandbox=${SANDBOX_ID}`,
    '--workdir',
    WORKSPACE_ROOT,
    '--network',
    NETWORK,
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '512',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    ...DOCKER_SANDBOX_CAPS.flatMap((cap) => ['--cap-add', cap]),
    ...Object.entries(USER_ENV).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
  ];

  if (KIND === 'hermes') {
    if (!HERMES_RUNTIME_ID || !HERMES_RUNTIME_API_KEY) {
      throw new Error('Hermes runtime identity is missing.');
    }
    return [
      ...base,
      '--label',
      `toolplane.agent-runtime=${HERMES_RUNTIME_ID}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--env',
      'API_SERVER_ENABLED=true',
      '--env',
      'HERMES_HOME=/opt/data',
      '--env',
      'API_SERVER_HOST=127.0.0.1',
      '--env',
      'API_SERVER_PORT=8642',
      '--env',
      `API_SERVER_KEY=${HERMES_RUNTIME_API_KEY}`,
      '--env',
      `API_SERVER_MODEL_NAME=${HERMES_RUNTIME_MODEL_NAME}`,
      '--env',
      'HERMES_DASHBOARD=1',
      '--env',
      'HERMES_DASHBOARD_HOST=127.0.0.1',
      '--env',
      'HERMES_DASHBOARD_PORT=9119',
      '--env',
      'HERMES_ACCEPT_HOOKS=1',
      // ToolPlane exposes one fixed gateway API port. A multiplexed default
      // gateway owns every profile's channel connections without allowing
      // imported per-profile services to race for that port.
      '--env',
      'GATEWAY_MULTIPLEX_PROFILES=1',
      '--env',
      HERMES_TTS_WRITE_SAFE_ROOT_ENV,
      '--env',
      'HERMES_ENVIRONMENT_HINT=This Hermes instance is managed by ToolPlane. Use only the configured ToolPlane MCP server and the files under /opt/data.',
      '-v',
      `${VOLUME}:/opt/data`,
      IMAGE,
      'gateway',
      'run',
    ];
  }

  return [
    ...base,
    '-v',
    `${VOLUME}:/workspace`,
    IMAGE,
    'sleep',
    'infinity',
  ];
}

async function createDockerContainer() {
  const created = await run('docker', dockerCreateArgs(), { env: dockerEnv(), timeoutMs: DOCKER_CREATE_TIMEOUT_MS });
  if (created.exitCode !== 0) throw new Error(created.stderr || `docker run failed (${created.exitCode})`);
}

async function ensureDockerContainer() {
  const info = await dockerInspectJson();
  if (info) {
    if (!hasExpectedDockerSandboxCaps(info)) {
      const removed = await run('docker', ['rm', '-f', CONTAINER], { env: dockerEnv(), timeoutMs: 30_000 });
      if (removed.exitCode !== 0) throw new Error(removed.stderr || `docker rm failed (${removed.exitCode})`);
      await createDockerContainer();
      return;
    }
    if (info.State?.Running === true) return;
    const started = await run('docker', ['start', CONTAINER], { env: dockerEnv(), timeoutMs: 30_000 });
    if (started.exitCode !== 0) throw new Error(started.stderr || `docker start failed (${started.exitCode})`);
    return;
  }

  await createDockerContainer();
}

async function ensureRuntime() {
  if (KIND === 'connector') return;
  await ensureDockerContainer();
}

function workspacePath(raw) {
  const rel = safeRel(raw);
  if (rel === null) return null;
  return `${WORKSPACE_ROOT}${rel ? `/${rel}` : ''}`;
}

async function dockerShell({ command, cwd = '.', stdin = '', timeoutMs }) {
  const rel = safeRel(cwd);
  if (rel === null) return textResult('Invalid cwd.', true);
  const workdir = `${WORKSPACE_ROOT}${rel ? `/${rel}` : ''}`;
  const result = await dockerTrackedExec({
    workdir,
    executable: 'sh',
    args: ['-lc', String(command ?? '')],
    stdin,
    timeoutMs,
  });
  return textResult(result, result.exitCode !== 0 || result.timedOut);
}

function dockerRuntimeCandidates(runtime) {
  if (runtime === 'node') return ['node'];
  if (runtime === 'python') {
    return KIND === 'hermes' ? ['/opt/hermes/.venv/bin/python3'] : ['python3', 'python'];
  }
  return ['bash'];
}

async function resolveDockerRuntime(runtime) {
  for (const candidate of dockerRuntimeCandidates(runtime)) {
    const result = await run(
      'docker',
      ['exec', CONTAINER, 'sh', '-c', 'command -v "$1"', 'toolplane-runtime', candidate],
      { env: dockerEnv(), timeoutMs: 10_000 },
    );
    const executable = result.stdout.trim().split('\n')[0];
    if (result.exitCode === 0 && executable) return executable;
  }
  return null;
}

async function terminateDockerExec(pid) {
  const script = `
pid=$1
case "$pid" in ''|*[!0-9]*) exit 3 ;; esac
kill_tree() {
  for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -KILL "$1" 2>/dev/null || true
}
kill_tree "$pid"
`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await run(
      'docker',
      ['exec', CONTAINER, 'sh', '-c', script, 'toolplane-kill', String(pid)],
      { env: dockerEnv(), timeoutMs: 10_000 },
    );
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function dockerTrackedExec({ workdir, executable, args, stdin, timeoutMs }) {
  const executionId = randomUUID();
  const controlPrefix = `__TOOLPLANE_EXEC_PID_${executionId}__`;
  const wrapper = `printf '${controlPrefix}%s\\n' "$$"; exec "$@"`;
  const result = await run(
    'docker',
    ['exec', '-i', '-w', workdir, CONTAINER, 'sh', '-c', wrapper, 'toolplane-exec', executable, ...args],
    { env: dockerEnv(), stdin, timeoutMs },
  );
  const controlPattern = new RegExp(`^${controlPrefix}(\\d+)\\r?\\n`);
  const match = controlPattern.exec(result.stdout);
  const cleaned = { ...result, stdout: result.stdout.replace(controlPattern, '') };
  if (result.timedOut && match) await terminateDockerExec(Number(match[1]));
  return cleaned;
}

async function processExec(args = {}) {
  if (KIND === 'connector') {
    return connectorTool('process_exec', { ...args, env: USER_ENV }, Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      (result) => Boolean(result?.timedOut) || result?.exitCode !== 0);
  }

  let parsed;
  try {
    parsed = parseProcessArgs(args);
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
  const rel = safeRel(args.cwd ?? '.');
  if (rel === null) return textResult('Invalid cwd.', true);
  const workdir = `${WORKSPACE_ROOT}${rel ? `/${rel}` : ''}`;
  const executable = await resolveDockerRuntime(parsed.runtime);
  if (!executable) return textResult(`${parsed.runtime} runtime is unavailable in this sandbox.`, true);
  const result = await dockerTrackedExec({
    workdir,
    executable,
    args: parsed.commandArgs,
    stdin: args.stdin,
    timeoutMs: args.timeoutMs,
  });
  return textResult({ ...result, runtime: parsed.runtime, executable }, result.exitCode !== 0 || result.timedOut);
}

async function listDir(args = {}) {
  if (KIND === 'connector') {
    return connectorTool('list_dir', args, 10_000);
  }
  const p = workspacePath(args.path ?? '.');
  if (!p) return textResult('Invalid path.', true);
  const result = await run(
    'docker',
    ['exec', CONTAINER, 'sh', '-lc', `find ${shQuote(p)} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\n' | sort`],
    { env: dockerEnv() },
  );
  if (result.exitCode !== 0) return textResult(result, true);
  const entries = result.stdout.trim()
    ? result.stdout.trim().split('\n').map((line) => {
        const [name, kind, size] = line.split('\t');
        return { name, type: kind === 'd' ? 'dir' : 'file', size: Number(size) || null };
      })
    : [];
  return textResult({ path: safeRel(args.path ?? '.') || '.', entries, stderr: result.stderr });
}

async function readSandboxFile(args = {}) {
  if (KIND === 'connector') {
    return connectorTool('read_file', args, 10_000);
  }
  const p = workspacePath(args.path);
  if (!p) return textResult('Invalid path.', true);
  const result = await run('docker', ['exec', CONTAINER, 'cat', p], { env: dockerEnv() });
  return textResult({ path: safeRel(args.path), content: truncate(result.stdout), stderr: result.stderr }, result.exitCode !== 0);
}

async function writeSandboxFile(args = {}) {
  const rel = safeRel(args.path);
  if (!rel) return textResult('Invalid path.', true);
  let decoded;
  try {
    decoded = decodeFileContent(args);
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
  if (KIND === 'connector') {
    const op = decoded.encoding === 'base64' ? 'write_file_base64' : 'write_file';
    return connectorTool(op, { path: rel, content: String(args.content ?? '') }, 30_000);
  }
  const p = workspacePath(rel);
  const parent = path.posix.dirname(p);
  const created = await run('docker', ['exec', CONTAINER, 'mkdir', '-p', '--', parent], { env: dockerEnv() });
  if (created.exitCode !== 0) return textResult(created, true);
  const result = await run('docker', ['exec', '-i', CONTAINER, 'sh', '-c', 'cat > "$1"', 'toolplane-write', p], {
    env: dockerEnv(),
    stdin: decoded.content,
  });
  return textResult({ path: rel, bytes: decoded.content.byteLength, stderr: result.stderr }, result.exitCode !== 0);
}

async function downloadSandboxFile(args = {}) {
  const rel = safeRel(args.path);
  if (!rel) return textResult('Invalid path.', true);
  if (KIND === 'connector') {
    return connectorTool('download_file', { ...args, path: rel }, 30_000);
  }
  const p = workspacePath(rel);
  const stat = await run('docker', ['exec', CONTAINER, 'sh', '-lc', `test -f ${shQuote(p)} && wc -c < ${shQuote(p)}`], {
    env: dockerEnv(),
  });
  const size = Number(String(stat.stdout).trim());
  if (stat.exitCode !== 0 || !Number.isFinite(size)) return textResult(stat.stderr || 'File not found.', true);
  if (size > MAX_DOWNLOAD) return textResult(`File is too large to download from the sidebar. Max ${MAX_DOWNLOAD} bytes.`, true);
  const result = await run('docker', ['exec', CONTAINER, 'sh', '-lc', `base64 -w 0 ${shQuote(p)}`], {
    env: dockerEnv(),
    timeoutMs: 30_000,
    maxOutput: MAX_DOWNLOAD_BASE64,
  });
  return textResult({ path: rel, filename: path.posix.basename(rel), encoding: 'base64', content: result.stdout, size, stderr: result.stderr }, result.exitCode !== 0);
}

async function deleteSandboxFile(args = {}) {
  const rel = safeRel(args.path);
  if (!rel) return textResult('Invalid path.', true);
  if (KIND === 'connector') {
    return connectorTool('delete_file', { ...args, path: rel }, 10_000);
  }
  const p = workspacePath(rel);
  const result = await run('docker', ['exec', CONTAINER, 'sh', '-lc', `test -f ${shQuote(p)} && rm -f -- ${shQuote(p)}`], {
    env: dockerEnv(),
  });
  return textResult({ path: rel, deleted: result.exitCode === 0, stderr: result.stderr }, result.exitCode !== 0);
}

const terminalSessions = new Map();

function pushTerminalEvent(session, event, value) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  session.buffer.push(payload);
  if (session.buffer.length > MAX_TERMINAL_BUFFER) session.buffer.shift();
  for (const stream of session.streams) stream.write(payload);
}

function terminalEnv() {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
  };
}

function createTerminal(cols = 80, rows = 24) {
  const id = randomUUID();
  const safeCols = Math.min(Math.max(Number(cols) || 80, 20), 240);
  const safeRows = Math.min(Math.max(Number(rows) || 24, 6), 80);
  const shellCommand = KIND === 'hermes'
    ? HERMES_TERMINAL_SHELL
    : 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh; fi';
  const shellArgs = KIND === 'hermes'
    // The wrapper defines and exports a Bash function. The Hermes image ships
    // Bash, while its /bin/sh is dash and rejects `export -f`.
    ? ['bash', '-lc', shellCommand]
    : ['sh', '-lc', shellCommand];
  // No --user: interactive sessions run as the image default user (root in the
  // Hermes image), matching the MCP shell/file tools. The hermes_cli wrapper
  // re-drops to the service user for Hermes state changes.
  const term = pty.spawn('docker', [
    'exec',
    '-it',
    '-w',
    WORKSPACE_ROOT,
    CONTAINER,
    ...shellArgs,
  ], {
    name: 'xterm-256color',
    cols: safeCols,
    rows: safeRows,
    cwd: process.cwd(),
    env: { ...dockerEnv(), ...terminalEnv() },
  });
  const session = {
    id,
    term,
    streams: new Set(),
    buffer: [],
    exitCode: null,
  };
  terminalSessions.set(id, session);
  term.onData((data) => pushTerminalEvent(session, 'data', { data }));
  term.onExit(({ exitCode, signal }) => {
    session.exitCode = exitCode;
    pushTerminalEvent(session, 'exit', { exitCode, signal });
    setTimeout(() => {
      terminalSessions.delete(id);
      for (const stream of session.streams) stream.end();
    }, 3000).unref();
  });
  return session;
}

async function pipeConnectorStream(upstream, req, res) {
  if (!upstream.body) {
    sendJson(res, 502, { error: 'terminal stream unavailable' });
    return;
  }
  res.writeHead(upstream.status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const reader = upstream.body.getReader();
  req.on('close', () => {
    void reader.cancel().catch(() => null);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function proxyConnectorTerminal(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/terminal/session') {
    const body = await readJson(req).catch(() => ({}));
    const upstream = await connectorFetch(`/internal/connectors/${encodeURIComponent(SANDBOX_ID)}/terminal/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, env: USER_ENV }),
      signal: AbortSignal.timeout(10_000),
    });
    sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    return true;
  }

  const match = /^\/terminal\/session\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return false;
  const [, sessionId, action] = match;
  const basePath = `/internal/connectors/${encodeURIComponent(SANDBOX_ID)}/terminal/session/${encodeURIComponent(sessionId)}`;

  if (req.method === 'GET' && action === 'stream') {
    const upstream = await connectorFetch(`${basePath}/stream`, { headers: { accept: 'text/event-stream' } });
    await pipeConnectorStream(upstream, req, res);
    return true;
  }

  if (req.method === 'POST' && (action === 'input' || action === 'resize')) {
    const body = await readBody(req).catch(() => '{}');
    const upstream = await connectorFetch(`${basePath}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body || '{}',
      signal: AbortSignal.timeout(10_000),
    });
    sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    return true;
  }

  if (req.method === 'DELETE' && !action) {
    const upstream = await connectorFetch(basePath, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
    sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    return true;
  }

  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

function getTerminalSession(id, res) {
  const session = terminalSessions.get(id);
  if (!session) {
    sendJson(res, 404, { error: 'terminal session not found' });
    return null;
  }
  return session;
}

async function handleTerminal(req, res) {
  if (KIND === 'connector') return proxyConnectorTerminal(req, res);

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/terminal/session') {
    const body = await readJson(req).catch(() => ({}));
    const session = createTerminal(body.cols, body.rows);
    sendJson(res, 201, { id: session.id });
    return true;
  }

  const match = /^\/terminal\/session\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return false;
  const [, sessionId, action] = match;
  const session = getTerminalSession(sessionId, res);
  if (!session) return true;

  if (req.method === 'GET' && action === 'stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('event: ready\ndata: {}\n\n');
    for (const payload of session.buffer) res.write(payload);
    session.streams.add(res);
    req.on('close', () => session.streams.delete(res));
    return true;
  }

  if (req.method === 'POST' && action === 'input') {
    const body = await readJson(req).catch(() => ({}));
    session.term.write(String(body.data ?? '').slice(0, MAX_WRITE));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && action === 'resize') {
    const body = await readJson(req).catch(() => ({}));
    const cols = Math.min(Math.max(Number(body.cols) || 80, 20), 240);
    const rows = Math.min(Math.max(Number(body.rows) || 24, 6), 80);
    session.term.resize(cols, rows);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'DELETE' && !action) {
    session.term.kill();
    terminalSessions.delete(sessionId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function handleRuntimeFiles(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/files/upload') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  if (KIND !== 'hermes') {
    sendJson(res, 404, { error: 'Runtime attachment upload is only available for Hermes agents.' });
    return true;
  }

  const rel = safeRel(url.searchParams.get('path'));
  if (!rel) {
    sendJson(res, 400, { error: 'A safe relative path is required.' });
    return true;
  }
  const requestedLimit = Number(req.headers['x-toolplane-max-upload-bytes']);
  const uploadLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : MAX_RUNTIME_UPLOAD;
  const announcedSize = Number(req.headers['content-length'] ?? 0);
  if (announcedSize > uploadLimit) {
    req.resume();
    sendJson(res, 413, { error: `Attachment exceeds ${uploadLimit} bytes.` });
    return true;
  }

  const target = workspacePath(rel);
  const parent = path.posix.dirname(target);
  const temporary = `${target}.toolplane-upload-${randomUUID()}`;
  const command = [
    `mkdir -p ${shQuote(parent)}`,
    `cat > ${shQuote(temporary)}`,
  ].join(' && ');
  const result = await new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', CONTAINER, 'sh', '-lc', command], {
      env: dockerEnv(),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let size = 0;
    let stderr = '';
    let tooLarge = false;
    let timedOut = false;
    let aborted = false;
    let childClosed = false;
    let settled = false;
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      childClosed = true;
      clearTimeout(timer);
      req.resume();
      resolve({ exitCode, size, stderr: error || stderr, tooLarge, timedOut, aborted });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUNTIME_UPLOAD_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr = truncate(stderr + chunk.toString('utf8'), 8_000);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.on('drain', () => req.resume());
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (exitCode) => finish(exitCode, ''));
    req.on('aborted', () => {
      aborted = true;
      child.kill('SIGKILL');
    });
    req.on('error', (error) => {
      aborted = true;
      stderr = truncate(stderr + error.message, 8_000);
      child.kill('SIGKILL');
    });
    req.on('data', (chunk) => {
      if (childClosed || tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > uploadLimit) {
        tooLarge = true;
        child.stdin.destroy();
        child.kill('SIGKILL');
        req.resume();
        return;
      }
      if (!child.stdin.write(buffer)) req.pause();
    });
    req.on('end', () => {
      if (!childClosed && !tooLarge && !aborted) child.stdin.end();
    });
  });
  const cleanupTemporary = () => run(
    'docker',
    ['exec', CONTAINER, 'rm', '-f', '--', temporary],
    { env: dockerEnv(), timeoutMs: 30_000 },
  );
  if (result.aborted) {
    await cleanupTemporary();
    if (!res.destroyed) res.destroy();
    return true;
  }
  if (result.tooLarge) {
    await cleanupTemporary();
    sendJson(res, 413, { error: `Attachment exceeds ${uploadLimit} bytes.` });
    return true;
  }
  if (result.timedOut) {
    await cleanupTemporary();
    sendJson(res, 504, { error: 'Attachment upload timed out.' });
    return true;
  }
  if (result.size <= 0) {
    await cleanupTemporary();
    sendJson(res, 400, { error: 'A non-empty attachment is required.' });
    return true;
  }
  if (result.exitCode !== 0) {
    await cleanupTemporary();
    sendJson(res, 500, { error: result.stderr || 'Could not write attachment.' });
    return true;
  }
  const finalizeCommand = [
    `test -f ${shQuote(temporary)}`,
    `if id hermes >/dev/null 2>&1; then chown "$(id -u hermes):$(id -g hermes)" ${shQuote(parent)} ${shQuote(temporary)}; fi`,
    `mv -f ${shQuote(temporary)} ${shQuote(target)}`,
  ].join(' && ');
  const finalized = await run('docker', ['exec', CONTAINER, 'sh', '-lc', finalizeCommand], {
    env: dockerEnv(),
    timeoutMs: 30_000,
  });
  if (finalized.exitCode !== 0) {
    await cleanupTemporary();
    sendJson(res, 500, { error: finalized.stderr || 'Could not finalize attachment.' });
    return true;
  }
  sendJson(res, 201, { path: target, relativePath: rel, size: result.size });
  return true;
}

function hermesProxyPath(req) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/hermes/')) return null;
  const path = url.pathname.slice('/hermes'.length);
  const sessionMessages = /^\/api\/sessions\/[^/]+\/messages$/.test(path);
  const sessionDelete = req.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(path);
  if (!(path === '/health' || path === '/health/detailed' || path.startsWith('/v1/') || sessionMessages || sessionDelete)) {
    return false;
  }
  return `${path}${url.search}`;
}

function parseCurlHeaders(raw, allowedNames = ['content-type', 'cache-control', 'x-hermes-session-id', 'x-hermes-session-key']) {
  const text = raw.toString('latin1');
  const lines = text.split(/\r?\n/);
  const statusMatch = /^HTTP\/\S+\s+(\d+)/.exec(lines[0] || '');
  const headers = {};
  const allowed = new Set(allowedNames);
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index < 1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (allowed.has(name)) {
      headers[name] = value;
    }
  }
  return { status: Number(statusMatch?.[1] || 502), headers };
}

function streamCurlResponse(req, res, args, body, responseHeaders) {
  const child = spawn('docker', args, { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let headerBuffer = Buffer.alloc(0);
  let responseStarted = false;
  let responseFinished = false;
  let childClosed = false;
  let stderr = '';

  const stopChild = () => {
    if (!childClosed && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  const writeChunk = (chunk) => {
    if (res.destroyed || responseFinished) {
      stopChild();
      return;
    }
    try {
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once('drain', () => child.stdout.resume());
      }
    } catch {
      stopChild();
    }
  };

  child.stdout.on('data', (chunk) => {
    if (responseStarted) {
      writeChunk(chunk);
      return;
    }
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    if (headerBuffer.length > 64 * 1024) {
      stopChild();
      responseStarted = true;
      sendJson(res, 502, { error: 'Hermes proxy response headers were too large.' });
      return;
    }
    const marker = headerBuffer.indexOf('\r\n\r\n');
    const fallbackMarker = marker === -1 ? headerBuffer.indexOf('\n\n') : -1;
    const splitAt = marker === -1 ? fallbackMarker : marker;
    if (splitAt === -1) return;
    const markerLength = marker === -1 ? 2 : 4;
    const parsed = parseCurlHeaders(headerBuffer.subarray(0, splitAt), responseHeaders);
    res.writeHead(parsed.status, parsed.headers);
    responseStarted = true;
    const rest = headerBuffer.subarray(splitAt + markerLength);
    if (rest.length) writeChunk(rest);
    headerBuffer = Buffer.alloc(0);
  });
  child.stderr.on('data', (chunk) => {
    stderr = truncate(stderr + chunk.toString('utf8'), 8_000);
  });
  child.on('error', (error) => {
    childClosed = true;
    if (!responseStarted) {
      responseStarted = true;
      sendJson(res, 502, { error: error.message });
    } else {
      responseFinished = true;
      res.end();
    }
  });
  child.on('close', (code) => {
    childClosed = true;
    if (!responseStarted) {
      sendJson(res, 502, { error: stderr || `Hermes proxy exited with code ${code}` });
      return;
    }
    if (!responseFinished) {
      responseFinished = true;
      res.end();
    }
  });
  req.once('aborted', stopChild);
  req.once('error', stopChild);
  res.once('error', stopChild);
  res.once('close', () => {
    if (!responseFinished) stopChild();
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(body);
}

async function handleHermesProxy(req, res) {
  const targetPath = hermesProxyPath(req);
  if (targetPath === null) return false;
  if (KIND !== 'hermes') {
    sendJson(res, 404, { error: 'Hermes runtime is not enabled for this sandbox.' });
    return true;
  }
  if (targetPath === false) {
    sendJson(res, 404, { error: 'Hermes endpoint is not exposed.' });
    return true;
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  let body = '';
  if (req.method === 'POST') {
    try {
      body = await readBody(req, MAX_HERMES_BODY);
    } catch (error) {
      sendJson(res, 413, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const args = [
    'exec',
    '-i',
    CONTAINER,
    'curl',
    '--silent',
    '--show-error',
    '--no-buffer',
    '--include',
    '--connect-timeout',
    '10',
    '--max-time',
    '3600',
    '--request',
    req.method || 'GET',
    `http://127.0.0.1:8642${targetPath}`,
    '--header',
    `Authorization: Bearer ${HERMES_RUNTIME_API_KEY}`,
    '--header',
    'Expect:',
  ];
  for (const name of ['x-hermes-session-id', 'x-hermes-session-key']) {
    const value = req.headers[name];
    if (typeof value === 'string' && value) {
      args.push('--header', `${name}: ${value}`);
    }
  }
  if (body) {
    args.push('--header', `Content-Type: ${req.headers['content-type'] || 'application/json'}`, '--data-binary', '@-');
  }

  streamCurlResponse(
    req,
    res,
    args,
    body,
    ['content-type', 'cache-control', 'x-hermes-session-id', 'x-hermes-session-key'],
  );
  return true;
}

async function handleHermesControl(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/hermes/control/gateway/default/up') return false;
  if (KIND !== 'hermes') {
    sendJson(res, 404, { error: 'Hermes runtime is not enabled for this sandbox.' });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  // `hermes gateway restart` maps to s6-svc -t upstream. That signal is a
  // no-op when the service is already want-down, so explicitly restore the
  // default slot's want-up state. The Hermes CLI also persists desired_state,
  // which keeps the repaired gateway enabled across container restarts.
  const started = await run('docker', [
    'exec',
    '--user',
    'hermes',
    '--env',
    'HERMES_HOME=/opt/data',
    CONTAINER,
    '/opt/hermes/.venv/bin/hermes',
    'gateway',
    'start',
  ], { env: dockerEnv(), timeoutMs: 15_000 });
  if (started.exitCode !== 0 || started.timedOut) {
    sendJson(res, 502, { error: 'Could not bring the default Hermes gateway online.' });
    return true;
  }
  sendJson(res, 200, { ok: true });
  return true;
}

function hermesDashboardProxyPath(req) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/hermes-dashboard' && !url.pathname.startsWith('/hermes-dashboard/')) return null;
  const targetPath = url.pathname.slice('/hermes-dashboard'.length) || '/';
  return `${targetPath}${url.search}`;
}

async function handleHermesDashboardProxy(req, res) {
  const targetPath = hermesDashboardProxyPath(req);
  if (targetPath === null) return false;
  if (KIND !== 'hermes') {
    sendJson(res, 404, { error: 'Hermes runtime is not enabled for this sandbox.' });
    return true;
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  let body = Buffer.alloc(0);
  if (!['GET', 'HEAD'].includes(req.method || '')) {
    try {
      body = await readBuffer(req, MAX_HERMES_DASHBOARD_BODY);
    } catch (error) {
      sendJson(res, 413, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const args = [
    'exec',
    '-i',
    CONTAINER,
    'curl',
    '--silent',
    '--show-error',
    '--no-buffer',
    '--include',
    '--connect-timeout',
    '10',
    '--max-time',
    '3600',
    '--request',
    req.method || 'GET',
    `http://127.0.0.1:9119${targetPath}`,
    '--header',
    'Expect:',
  ];
  for (const name of [
    'accept',
    'content-type',
    'if-modified-since',
    'if-none-match',
    'range',
    'x-hermes-session-token',
  ]) {
    const value = req.headers[name];
    if (typeof value === 'string' && value) args.push('--header', `${name}: ${value}`);
  }
  const forwardedPrefix = req.headers['x-forwarded-prefix'];
  if (typeof forwardedPrefix === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(forwardedPrefix)) {
    args.push('--header', `X-Forwarded-Prefix: ${forwardedPrefix}`);
  }
  if (body.length) args.push('--data-binary', '@-');

  streamCurlResponse(
    req,
    res,
    args,
    body,
    [
      'accept-ranges',
      'cache-control',
      'content-disposition',
      'content-range',
      'content-type',
      'etag',
      'last-modified',
      'location',
    ],
  );
  return true;
}

async function sandboxInfoResult() {
  let connectorRuntime = null;
  let connectorError = null;
  if (KIND === 'connector') {
    try {
      connectorRuntime = await connectorRequest('ping', {}, 10_000);
    } catch (error) {
      connectorError = error instanceof Error ? error.message : String(error);
    }
  }
  const workspace = connectorRuntime?.root || (KIND === 'connector' ? CONNECTOR_REMOTE_ROOT : WORKSPACE_ROOT);
  return textResult({
    id: SANDBOX_ID,
    name: NAME,
    kind: KIND,
    platform: KIND === 'connector' ? (connectorRuntime?.platform ?? 'unknown') : 'linux',
    arch: KIND === 'connector' ? (connectorRuntime?.arch ?? null) : null,
    shell: KIND === 'connector' ? (connectorRuntime?.shell ?? null) : 'sh',
    shellFamily: KIND === 'connector' ? (connectorRuntime?.shellFamily ?? null) : 'posix',
    image: KIND === 'connector' ? null : IMAGE,
    container: KIND === 'connector' ? null : CONTAINER,
    volume: KIND === 'connector' ? null : VOLUME,
    runtimeId: KIND === 'hermes' ? HERMES_RUNTIME_ID : null,
    connector: KIND === 'connector'
      ? {
          configuredRoot: CONNECTOR_REMOTE_ROOT,
          actualRoot: connectorRuntime?.root ?? null,
          broker: CONNECTOR_BROKER_URL,
          version: connectorRuntime?.version ?? null,
          nodeVersion: connectorRuntime?.nodeVersion ?? null,
          capabilities: connectorRuntime?.capabilities ?? [],
          error: connectorError,
        }
      : null,
    workspace,
  });
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'sandbox_info':
      return sandboxInfoResult();
    case 'shell_exec':
      if (!args.command) return textResult('command is required.', true);
      return KIND === 'connector'
        ? connectorTool('shell_exec', { ...args, env: USER_ENV }, Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), (result) => Boolean(result?.timedOut) || result?.exitCode !== 0)
        : dockerShell(args);
    case 'process_exec':
      return processExec(args);
    case 'list_dir':
      return listDir(args);
    case 'read_file':
      return readSandboxFile(args);
    case 'write_file':
      return writeSandboxFile(args);
    case 'download_file':
      return downloadSandboxFile(args);
    case 'delete_file':
      return deleteSandboxFile(args);
    default:
      return null;
  }
}

function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return Promise.resolve(callTool(params?.name, params?.arguments)).then((result) =>
        result === null ? fail(-32602, `Unknown tool: ${params?.name}`) : ok(result),
      );
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: NAME, kind: KIND }));
    return;
  }
  try {
    if (await handleRuntimeFiles(req, res)) return;
    if (await handleHermesDashboardProxy(req, res)) return;
    if (await handleHermesControl(req, res)) return;
    if (await handleHermesProxy(req, res)) return;
    if (await handleTerminal(req, res)) return;
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  readBody(req)
    .then(async (body) => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const response = await handleRpc(parsed);
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
    })
    .catch((error) => sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }));
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of terminalSessions.values()) session.term.kill();
  server.close();
  if (KIND === 'hermes') {
    void run('docker', ['stop', '--time', '10', CONTAINER], { env: dockerEnv(), timeoutMs: 30_000 })
      .finally(() => process.exit(0));
    return;
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

ensureRuntime()
  .then(() => {
    server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.stdout.write(`LISTENING ${port}\n`);
    });
  })
  .catch((error) => {
    process.stderr.write(`sandbox-mcp-server: startup failed: ${error.message}\n`);
    process.exit(1);
  });
