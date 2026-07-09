// Isolation policy for custom MCP servers. Every custom source runs in its own
// throwaway container: no capabilities, no privilege escalation, a read-only
// root fs (writable /tmp only), capped resources, and a dedicated network off
// the app/db network. Only the MCP's own env (installCfg.env) ever enters it.

export type McpNetwork = 'isolated' | 'none';

// Dedicated bridge network for MCP containers — present egress to the internet
// but not on the app/db compose network. `ensureSandboxNetwork()` creates it.
export const MCP_NETWORK = 'mcp-sandbox';
export const SANDBOX_WORKDIR = '/workspace';

export const SANDBOX = {
  memory: '512m',
  cpus: '1',
  pids: 256,
  tmpfs: '/tmp:rw,exec,size=256m',
} as const;

// npm/github packages run inside Node; PyPI packages inside the uv image (uv +
// a managed Python). docker-source MCPs use the user's own image.
export const WRAP_IMAGE = {
  npm: 'node:24-bookworm-slim',
  github: 'node:24-bookworm-slim',
  pypi: 'ghcr.io/astral-sh/uv:python3.13-bookworm-slim',
} as const;

// `--read-only` means npm/uv can't write their default cache dirs, so redirect
// them (and HOME) onto the writable tmpfs.
export const CACHE_ENV = {
  npm: { npm_config_cache: '/tmp/.npm', HOME: '/tmp' },
  pypi: { UV_CACHE_DIR: '/tmp/.uv', XDG_CACHE_HOME: '/tmp', HOME: '/tmp' },
} as const;

export function sandboxFlags(network: McpNetwork): string[] {
  return [
    '-i',
    '--rm',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    SANDBOX.tmpfs,
    '--pids-limit',
    String(SANDBOX.pids),
    '--memory',
    SANDBOX.memory,
    '--cpus',
    SANDBOX.cpus,
    '--network',
    network === 'none' ? 'none' : MCP_NETWORK,
  ];
}

export function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

export function sandboxContainerName(sandboxId: string): string {
  return `toolplane-sandbox-${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function sandboxVolumeName(sandboxId: string): string {
  return `toolplane_sandbox_${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}
