// Executed ONLY inside the selected Docker sandbox. It never installs Hermes
// into the ToolPlane application, an operator home, or a legacy Hermes volume.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERMES_RPC_COMMIT = '3c27eb6234bf91b8ceee9e9071591b31e9b148cb';
export const UV_VERSION = '0.11.6';
export const UV_ASSETS = {
  x64: { name: 'uv-x86_64-unknown-linux-gnu', sha256: '0c6bab77a67a445dc849ed5e8ee8d3cb333b6e2eba863643ce1e228075f27943' },
  arm64: { name: 'uv-aarch64-unknown-linux-gnu', sha256: 'd5be4bf7015ea000378cb3c3aba53ba81a8673458ace9c7fa25a0be005b74802' },
};

function exec(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', (chunk) => { if (output.length < 65_536) output += chunk; });
    child.stderr.on('data', (chunk) => { if (output.length < 65_536) output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`Hermes RPC installation step failed (${binary}, exit ${code}). ${output.slice(-3000)}`)));
  });
}

export async function installHermesRpc(root) {
  if (!/^\/workspace\/\.toolplane\/runtime-packages\/hermes-rpc-[a-f0-9]{40}$/.test(root) || !root.endsWith(HERMES_RPC_COMMIT)) {
    throw new Error('Invalid pinned Hermes RPC installation directory.');
  }
  const asset = UV_ASSETS[process.arch];
  if (process.platform !== 'linux' || !asset || !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error('Hermes RPC requires a Linux glibc x64 or arm64 Docker sandbox.');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const source = join(root, 'source');
  const python = join(source, '.venv/bin/python');
  const marker = join(root, '.ready');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'build-home'), LANG: 'C.UTF-8',
    UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_CACHE_DIR: join(root, 'cache'),
    UV_NO_PROGRESS: '1', GIT_TERMINAL_PROMPT: '0',
    HERMES_HOME: join(root, 'probe-home'), HERMES_DISABLE_LAZY_INSTALLS: '1',
  };
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  const ready = await readFile(marker, 'utf8').then((value) => value === HERMES_RPC_COMMIT, () => false);
  if (ready) {
    await access(python);
    if (await exec('git', ['-C', source, 'rev-parse', 'HEAD'], { env }) !== HERMES_RPC_COMMIT) throw new Error('Hermes RPC source revision does not match its installation marker.');
    return python;
  }
  const uv = join(root, asset.name, 'uv');
  try { await access(uv); } catch {
    const archive = join(root, 'uv.tar.gz');
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.name}.tar.gz`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Cannot download pinned uv (${response.status}).`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 40 * 1024 * 1024) throw new Error('Pinned uv download exceeds its size limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Pinned uv integrity check failed.');
    await writeFile(archive, bytes, { mode: 0o600 });
    await exec('tar', ['-xzf', archive, '-C', root, `${asset.name}/uv`], { env });
    await chmod(uv, 0o700); await rm(archive);
  }
  await mkdir(source, { recursive: true, mode: 0o700 });
  await exec('git', ['init', source], { env });
  await exec('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/NousResearch/hermes-agent.git', HERMES_RPC_COMMIT], { env });
  await exec('git', ['-C', source, 'checkout', '--detach', '--force', HERMES_RPC_COMMIT], { env });
  if (await exec('git', ['-C', source, 'rev-parse', 'HEAD'], { env }) !== HERMES_RPC_COMMIT) throw new Error('Pinned Hermes RPC revision check failed.');
  await exec(uv, ['sync', '--frozen', '--no-dev', '--extra', 'mcp', '--extra', 'anthropic', '--managed-python', '--python', '3.13'], { cwd: source, env });
  await exec(python, ['-c', 'import tui_gateway.entry; print("Hermes RPC protocol ready")'], { cwd: source, env });
  await writeFile(marker + '.tmp', HERMES_RPC_COMMIT, { mode: 0o600 });
  await rename(marker + '.tmp', marker);
  await rm(env.HERMES_HOME, { recursive: true, force: true });
  return python;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const root = process.argv[2];
    // flock is held by the parent wrapper in the sandbox. Its kernel lifetime
    // allows safe retry after a killed install without deleting a guessed PID lock.
    console.log(await installHermesRpc(root));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
