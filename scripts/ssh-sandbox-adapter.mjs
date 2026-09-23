import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const WORKER = readFileSync(new URL('./ssh-sandbox-worker.py', import.meta.url), 'utf8');
const MAX_RESPONSE = 7_500_000;
const TOOLS = new Set(['sandbox_info', 'shell_exec', 'process_exec', 'list_dir', 'read_file', 'write_file', 'download_file', 'delete_file']);
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function validateSshTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('SSH target is not configured.');
  const { host, username, root, identityFile, knownHostsFile, port = 22 } = raw;
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(host)) throw new Error('Invalid SSH host.');
  if (typeof username !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)) throw new Error('Invalid SSH username.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port.');
  for (const value of [root, identityFile, knownHostsFile]) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value) || value.split('/').includes('..')) throw new Error('SSH paths must be absolute POSIX paths without parent traversal.');
  }
  // OpenSSH config option values containing whitespace have parser-specific
  // quoting. Keep credential paths unambiguous; remote workspace allows spaces.
  if (/\s/.test(identityFile) || /\s/.test(knownHostsFile)) throw new Error('SSH credential paths cannot contain whitespace.');
  return { host, username, root, identityFile, knownHostsFile, port };
}

export function sshArguments(raw, remoteCommand, terminal = false) {
  const target = validateSshTarget(raw);
  return ['-F', '/dev/null', terminal ? '-tt' : '-T', '-e', 'none', '-p', String(target.port), '-l', target.username,
    '-i', target.identityFile,
    ...['BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=yes', `UserKnownHostsFile=${target.knownHostsFile}`,
      'GlobalKnownHostsFile=/dev/null', 'UpdateHostKeys=no', 'ForwardAgent=no', 'ClearAllForwardings=yes',
      'PermitLocalCommand=no', 'ControlMaster=no', 'ControlPath=none', 'ProxyCommand=none', 'ProxyJump=none',
      'CanonicalizeHostname=no', 'ConnectTimeout=10', 'ServerAliveInterval=15', 'ServerAliveCountMax=2',
    ].flatMap((value) => ['-o', value]), '--', target.host, remoteCommand];
}

export function sshTerminalSpec(raw, cwd = '.') {
  const target = validateSshTarget(raw);
  if (typeof cwd !== 'string' || cwd.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(cwd) || cwd.split('/').includes('..')) throw new Error('Invalid SSH terminal cwd.');
  const directory = path.posix.join(target.root, cwd);
  return { command: '/usr/bin/ssh', args: sshArguments(target, `cd ${quote(directory)} && exec /bin/sh -l`, true) };
}

export function createSshSandbox(raw, identity = {}) {
  const target = validateSshTarget(raw);
  const active = new Set();
  for (const [filename, secret] of [[target.identityFile, true], [target.knownHostsFile, false]]) {
    const info = statSync(filename);
    if (!info.isFile() || (info.mode & (secret ? 0o077 : 0o022))) throw new Error('SSH credential files have unsafe permissions.');
  }
  const localEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent' };

  async function request(tool, args = {}, env = {}) {
    if (!TOOLS.has(tool)) throw new Error('Unknown SSH sandbox tool.');
    const timeout = tool === 'shell_exec' || tool === 'process_exec' ? args.timeoutMs ?? 30000 : 30000;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > 120000) throw new Error('Invalid SSH timeout.');
    const body = JSON.stringify({ root: target.root, tool, args, env }) + '\n';
    if (Buffer.byteLength(body) > 4_000_000) throw new Error('SSH request exceeds limit.');
    if (active.size >= 4) throw new Error('SSH sandbox is busy.');
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/ssh', sshArguments(target, `/usr/bin/python3 -u -c ${quote(WORKER)}`), {
        shell: false, env: localEnv, stdio: ['pipe', 'pipe', 'pipe'],
      });
      active.add(child);
      let settled = false;
      let size = 0;
      const chunks = [];
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.destroy();
        child.kill('SIGKILL');
        reject(new Error('SSH sandbox unavailable; verify the pinned host key, identity, remote Python and root directory.'));
      };
      // Remote timeout owns process cleanup; this is a transport backstop.
      const timer = setTimeout(fail, timeout + 15000);
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stderr.resume(); // Never forward OpenSSH diagnostics containing paths.
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) fail();
        else chunks.push(chunk);
      });
      child.on('close', (code) => {
        active.delete(child);
        if (settled) return;
        if (code !== 0) return fail();
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!response.ok || !response.result || typeof response.result !== 'object') return fail();
          settled = true;
          clearTimeout(timer);
          resolve(response);
        } catch { fail(); }
      });
      // Keep stdin open. EOF is the worker's disconnect/cancellation signal.
      child.stdin.write(body);
    });
  }
  return {
    async ready() { await request('sandbox_info'); },
    async callTool(tool, args, env) {
      if (!TOOLS.has(tool)) return null;
      try {
        const response = await request(tool, args, env);
        const result = tool === 'sandbox_info' ? { ...response.result, ...identity } : response.result;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: response.isError === true };
      } catch (error) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    },
    terminal(cwd) { return { ...sshTerminalSpec(target, cwd), env: localEnv }; },
    close() { for (const child of active) { child.stdin.destroy(); child.kill('SIGKILL'); } active.clear(); },
  };
}
