import { installationName, type InstallationIdentity } from './installation-identity';
import { resolveInstallClient } from './clients';

// Fetching or previewing the link does not rotate anyone's credentials. Only
// running this bootstrap registers/rotates the current local installation.
export function buildInstallBootstrap(opts: InstallationIdentity & { linkId: string; client: string; uninstall?: boolean }): string {
  const client = resolveInstallClient(opts.client);
  const name = installationName(opts);
  const config = Buffer.from(JSON.stringify({
    endpoint: `${opts.base}/install/${encodeURIComponent(opts.linkId)}`, client, name, uninstall: opts.uninstall === true,
  })).toString('base64');
  return String.raw`#!/usr/bin/env bash
set -eo pipefail
umask 077
command -v node >/dev/null 2>&1 || { echo 'Node is required' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '%s' '${config}' | base64 -d > "$TMP/config.json"
node - "$TMP" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const tmp = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
const home = process.env.HOME || os.homedir();
const roots = {
  'claude-code': path.join(home, '.claude', 'plugins'),
  codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'toolplane'),
  opencode: path.join(process.env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode'), 'toolplane'),
  hermes: path.join(process.env.HERMES_HOME || path.join(home, '.hermes'), 'toolplane'),
};
const root = path.join(roots[cfg.client], cfg.name);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Refusing a symlinked installation directory');
// Per-client configuration is shared by all Toolkits: serialize installers,
// not just registrations, to avoid read-modify-write races in that config.
const lock = path.join(roots[cfg.client], '.toolplane-install-lock');
try { fs.mkdirSync(lock, { mode: 0o700 }); }
catch { throw new Error('Another install is active (or a previous process stopped). Confirm it is stopped before removing ' + lock); }
fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
process.on('exit', () => fs.rmSync(lock, { recursive: true, force: true }));
const stateFile = path.join(root, 'installation.json');
const incomplete = path.join(root, 'pending-install.sh');
if (fs.existsSync(incomplete)) {
  if (fs.lstatSync(incomplete).isSymbolicLink()) throw new Error('Invalid pending install');
  const resumed = spawnSync('bash', [incomplete], { stdio: 'inherit' });
  if (resumed.status !== 0) throw new Error('Pending local install could not be recovered');
  fs.rmSync(incomplete);
}
let registration = null;
let token = '';
if (fs.existsSync(stateFile)) {
  if (fs.lstatSync(stateFile).isSymbolicLink() || fs.lstatSync(path.join(root, '.mcp.json')).isSymbolicLink()) throw new Error('Invalid symlinked installation state');
  registration = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (registration.name !== cfg.name || registration.client !== cfg.client) throw new Error('Installation identity mismatch');
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  token = String(mcp.mcpServers[cfg.name]?.headers?.Authorization || '').replace(/^Bearer /i, '');
  if (!token) throw new Error('Existing installation credential is missing; re-register explicitly');
}
if (cfg.uninstall && !registration) throw new Error('No registration for this client; legacy installations are preserved');
const body = { client: cfg.client, operation: cfg.uninstall ? 'revoke' : 'install',
  ...(registration ? { installationId: registration.id } : {}),
  label: String(process.env.TOOLPLANE_DEVICE_NAME || os.hostname()).slice(0, 80) };
fs.writeFileSync(path.join(tmp, 'request.json'), JSON.stringify(body), { mode: 0o600 });
const responseFile = path.join(tmp, 'response.json');
const output = fs.openSync(responseFile, 'w', 0o600);
const result = spawnSync('curl', ['-fsS', '--max-time', '60', '--max-filesize', '1048576',
  '-H', 'Content-Type: application/json', ...(token ? ['-H', 'Authorization: Bearer ' + token] : []),
  '--data-binary', '@' + path.join(tmp, 'request.json'), cfg.endpoint], { stdio: ['ignore', output, 'inherit'] });
fs.closeSync(output);
if (result.status !== 0) throw new Error('Registration failed; existing credentials were not removed. Retry or re-register explicitly.');
const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
if (typeof response.script !== 'string' || typeof response.installationId !== 'string' || !response.installationId || response.installationId.length > 128) throw new Error('Invalid installer response');
const scriptFile = path.join(tmp, 'install.sh');
fs.writeFileSync(scriptFile, response.script, { mode: 0o700 });
const pending = path.join(root, 'pending-install.sh');
if (!cfg.uninstall) {
  fs.writeFileSync(pending, response.script, { mode: 0o600 });
  const next = stateFile + '.tmp';
  fs.writeFileSync(next, JSON.stringify({ id: response.installationId, name: cfg.name, client: cfg.client }) + '\n', { mode: 0o600 });
  fs.renameSync(next, stateFile);
}
const applied = spawnSync('bash', [scriptFile], { stdio: 'inherit' });
if (applied.status !== 0) throw new Error('Local update failed. Resume the private pending-install.sh after resolving the error; do not share that file.');
if (!cfg.uninstall) {
  const next = stateFile + '.tmp';
  fs.writeFileSync(next, JSON.stringify({ id: response.installationId, name: cfg.name, client: cfg.client }) + '\n', { mode: 0o600 });
  fs.renameSync(next, stateFile);
  fs.rmSync(pending, { force: true });
}
NODE
`;
}
