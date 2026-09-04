// The bridge spawns the `docker` CLI to run each MCP in a container. The CLI
// only needs a handful of variables (PATH + the DOCKER_* connection settings).
// Passing it the app's full env would hand app secrets to the MCP. Docker gets
// only this allowlist plus the exact environment named by the deployment.
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

export function buildBridgeChildEnv(hostEnv, serializedEnv) {
  let configured;
  try {
    configured = JSON.parse(serializedEnv || '{}');
  } catch {
    throw new Error('invalid MCP_CHILD_ENV');
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('invalid MCP_CHILD_ENV');
  }

  const entries = Object.entries(configured);
  if (entries.length > 100 || Buffer.byteLength(serializedEnv || '', 'utf8') > 64 * 1024) {
    throw new Error('invalid MCP_CHILD_ENV');
  }
  const out = filterEnv(hostEnv);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || key === 'PATH'
      || key.startsWith('DOCKER_')
      || typeof value !== 'string'
      || value.includes('\0')) {
      throw new Error('invalid MCP_CHILD_ENV');
    }
    out[key] = value;
  }
  return out;
}
