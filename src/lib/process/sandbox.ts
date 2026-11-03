// Isolation policy for custom MCP servers. Every custom source runs in its own
// throwaway container: no capabilities, no privilege escalation, a read-only
// root fs (writable /tmp only), capped resources, and a dedicated network off
// the app/db network. Only the MCP's own env (installCfg.env) ever enters it.

export type McpNetwork = "isolated" | "none";

// Dedicated bridge network for MCP containers — present egress to the internet
// but not on the app/db compose network. `ensureSandboxNetwork()` creates it.
export const MCP_NETWORK = "mcp-sandbox";

export const SANDBOX = {
  memory: "512m",
  cpus: "1",
  pids: 256,
  tmpfs: "/tmp:rw,exec,size=256m",
} as const;

// npm/github packages run inside Node; PyPI packages inside the uv image (uv +
// a managed Python). docker-source MCPs use the user's own image.
export const WRAP_IMAGE = {
  npm: "node:26-bookworm-slim",
  npmGit: "node:26-bookworm",
  github: "node:26-bookworm-slim",
  pypi: "ghcr.io/astral-sh/uv:python3.13-bookworm-slim",
  pypiGit: "ghcr.io/astral-sh/uv:python3.13-bookworm",
} as const;

// `--read-only` means npm/uv can't write their default cache dirs, so redirect
// them (and HOME) onto the writable tmpfs.
export const CACHE_ENV = {
  npm: { npm_config_cache: "/tmp/.npm", HOME: "/tmp" },
  pypi: { UV_CACHE_DIR: "/tmp/.uv", XDG_CACHE_HOME: "/tmp", HOME: "/tmp" },
} as const;

export function sandboxFlags(network: McpNetwork): string[] {
  return [
    "-i",
    "--rm",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    SANDBOX.tmpfs,
    "--pids-limit",
    String(SANDBOX.pids),
    "--memory",
    SANDBOX.memory,
    "--cpus",
    SANDBOX.cpus,
    "--network",
    network === "none" ? "none" : MCP_NETWORK,
  ];
}

export function envFlags(env: Record<string, string>): string[] {
  return Object.keys(env).flatMap((key) => ["-e", key]);
}

export type AgentSandboxCompanion = {
  container: string;
  volume: string;
  user: string;
};

/**
 * Run an MCP inside an Agent session sandbox: it joins the sandbox's network
 * and process namespaces and shares its /workspace volume as the same user.
 * The sandbox can therefore read the MCP's environment, including credentials.
 */
export function agentSandboxCompanionArgs(
  args: string[],
  imageIndex: number,
  companion: AgentSandboxCompanion,
  keepWorkdir: boolean,
): string[] {
  if (args[0] !== "run" || imageIndex < 1)
    throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
  const flags: string[] = [];
  for (let index = 1; index < imageIndex; index += 1) {
    const arg = args[index];
    if (arg === "--read-only") continue;
    if (arg === "--network") {
      index += 1;
      continue;
    }
    flags.push(arg);
  }
  return [
    "run",
    "--network",
    `container:${companion.container}`,
    "--pid",
    `container:${companion.container}`,
    "--mount",
    `type=volume,src=${companion.volume},dst=/workspace`,
    "--user",
    companion.user,
    ...(keepWorkdir ? [] : ["--workdir", "/workspace"]),
    ...flags,
    // Same filesystem reach as the sandbox itself (a subset of its caps), so
    // the MCP can write its package dir and files the sandbox user created.
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER"].flatMap((cap) => ["--cap-add", cap]),
    ...args.slice(imageIndex),
  ];
}
