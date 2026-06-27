// The bridge spawns the `docker` CLI to run each MCP in a container. The CLI
// only needs a handful of variables (PATH + the DOCKER_* connection settings).
// Passing it the app's full env would hand the app's secrets to anything that
// can read the process table — and the MCP itself only ever sees the `-e` flags
// baked into the docker command, never this env. So scrub down to an allowlist.
export const BRIDGE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'LANG',
  'LC_ALL',
];

export function filterEnv(env) {
  const out = {};
  for (const k of BRIDGE_ENV_ALLOWLIST) {
    if (env[k] != null) out[k] = env[k];
  }
  return out;
}
