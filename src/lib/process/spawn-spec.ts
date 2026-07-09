import {
  sandboxFlags,
  envFlags,
  WRAP_IMAGE,
  CACHE_ENV,
  MCP_NETWORK,
  SANDBOX_WORKDIR,
  sandboxContainerName,
  sandboxVolumeName,
  type McpNetwork,
} from './sandbox';
import { connectorFromConfig, type SandboxConnectorConfig } from '@/lib/sandboxes/connector';

export type SpawnSpec =
  | { kind: 'builtin'; name: string }
  | { kind: 'bridge'; name: string; command: string; args: string[]; env: Record<string, string> }
  | {
      kind: 'sandbox';
      name: string;
      sandboxId: string;
      sandboxKind: 'docker' | 'connector';
      image?: string;
      volumeName?: string;
      network: McpNetwork;
      connector?: SandboxConnectorConfig;
    };

export type DeploymentForSpawn = {
  serverId: string | null;
  server?: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
};

type CustomMcpSource = 'npm' | 'github' | 'pypi' | 'docker';

function splitArgs(s: string | undefined): string[] {
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

// Every custom MCP runs in its own hardened, throwaway container (see
// ./sandbox.ts) — npm/GitHub wrapped in Node, PyPI in the uv image, docker as
// its own image. `env` is the MCP's OWN env (installCfg.env) and is the only
// environment that enters the container: it goes in as `-e` flags, never the
// host's process.env.
//
// `rebuild = true` re-fetches instead of using cache (npm revalidates the
// registry, uv refreshes, docker re-pulls). `network` picks the sandbox network
// (egress) or full isolation (`none`).
export function buildSpawnSpec(
  source: string,
  ref: string,
  startCommand?: string,
  env: Record<string, string> = {},
  rebuild = false,
  network: McpNetwork = 'isolated',
): { command: string; args: string[] } {
  const run = ['run', ...sandboxFlags(network)];

  switch (source) {
    case 'npm':
    case 'github': {
      const inner = rebuild ? ['npx', '-y', '--prefer-online', ref] : ['npx', '-y', ref];
      return {
        command: 'docker',
        args: [...run, ...envFlags(CACHE_ENV.npm), ...envFlags(env), WRAP_IMAGE.npm, ...inner],
      };
    }
    case 'pypi': {
      const inner = rebuild ? ['uvx', '--refresh', ref] : ['uvx', ref];
      return {
        command: 'docker',
        args: [...run, ...envFlags(CACHE_ENV.pypi), ...envFlags(env), WRAP_IMAGE.pypi, ...inner],
      };
    }
    case 'docker': {
      const pull = rebuild ? ['--pull', 'always'] : [];
      return {
        command: 'docker',
        args: [...run, ...pull, ...envFlags(env), ref, ...splitArgs(startCommand)],
      };
    }
    default:
      throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
  }
}

export function buildSandboxMcpSpawnSpec({
  source,
  ref,
  sandboxId,
  volumeName,
  startCommand,
  env = {},
  rebuild = false,
}: {
  source: CustomMcpSource;
  ref: string;
  sandboxId: string;
  volumeName?: string;
  startCommand?: string;
  env?: Record<string, string>;
  rebuild?: boolean;
}): { command: string; args: string[] } {
  const container = sandboxContainerName(sandboxId);
  switch (source) {
    case 'npm':
    case 'github': {
      const inner = rebuild ? ['npx', '-y', '--prefer-online', ref] : ['npx', '-y', ref];
      return {
        command: 'docker',
        args: ['exec', '-i', '-w', SANDBOX_WORKDIR, ...envFlags(env), container, ...inner],
      };
    }
    case 'pypi': {
      const inner = rebuild ? ['uvx', '--refresh', ref] : ['uvx', ref];
      return {
        command: 'docker',
        args: ['exec', '-i', '-w', SANDBOX_WORKDIR, ...envFlags(env), container, ...inner],
      };
    }
    case 'docker': {
      const pull = rebuild ? ['--pull', 'always'] : [];
      return {
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          MCP_NETWORK,
          '--workdir',
          SANDBOX_WORKDIR,
          '--tmpfs',
          '/tmp:rw,exec,size=256m',
          '-v',
          `${volumeName ?? sandboxVolumeName(sandboxId)}:${SANDBOX_WORKDIR}`,
          ...pull,
          ...envFlags(env),
          ref,
          ...splitArgs(startCommand),
        ],
      };
    }
    default:
      throw new Error(`Unsupported sandbox MCP source: ${source || '(none)'}`);
  }
}

function readCfg(installCfg: unknown): {
  env: Record<string, string>;
  startCommand?: string;
  network: McpNetwork;
  mcpSource?: CustomMcpSource;
  sandboxId?: string;
  sandboxDeploymentId?: string;
  sandboxVolumeName?: string;
} {
  const c = (installCfg ?? {}) as {
    env?: Record<string, string>;
    startCommand?: string;
    network?: string;
    mcpSource?: string;
    sandboxId?: string;
    sandboxDeploymentId?: string;
    sandboxVolumeName?: string;
  };
  return {
    env: c.env ?? {},
    startCommand: c.startCommand,
    network: c.network === 'none' ? 'none' : 'isolated',
    mcpSource: c.mcpSource === 'npm' || c.mcpSource === 'github' || c.mcpSource === 'pypi' || c.mcpSource === 'docker'
      ? c.mcpSource
      : undefined,
    sandboxId: c.sandboxId,
    sandboxDeploymentId: c.sandboxDeploymentId,
    sandboxVolumeName: c.sandboxVolumeName,
  };
}

function readSandboxCfg(installCfg: unknown): {
  sandboxId: string;
  kind: 'docker' | 'connector';
  image?: string;
  volumeName?: string;
  network: McpNetwork;
  connector?: SandboxConnectorConfig;
} {
  const c = (installCfg ?? {}) as {
    sandboxId?: string;
    kind?: string;
    image?: string;
    volumeName?: string;
    network?: string;
  };
  const connector = connectorFromConfig(installCfg);
  return {
    sandboxId: c.sandboxId ?? '',
    kind: c.kind === 'connector' && connector ? 'connector' : 'docker',
    image: c.image,
    volumeName: c.volumeName,
    network: c.network === 'none' ? 'none' : 'isolated',
    connector: connector ?? undefined,
  };
}

export function resolveSpawnSpec(d: DeploymentForSpawn, rebuild = false): SpawnSpec {
  if (d.source === 'sandbox') {
    const cfg = readSandboxCfg(d.installCfg);
    return {
      kind: 'sandbox',
      name: d.name ?? 'Sandbox',
      sandboxId: cfg.sandboxId,
      sandboxKind: cfg.kind,
      image: cfg.image,
      volumeName: cfg.volumeName,
      network: cfg.network,
      connector: cfg.connector,
    };
  }

  if (d.source === 'sandbox-mcp') {
    const cfg = readCfg(d.installCfg);
    if (!cfg.mcpSource || !cfg.sandboxId) throw new Error('Sandbox MCP deployment is missing mcpSource or sandboxId.');
    const { command, args } = buildSandboxMcpSpawnSpec({
      source: cfg.mcpSource,
      ref: d.sourceRef ?? '',
      sandboxId: cfg.sandboxId,
      volumeName: cfg.sandboxVolumeName,
      startCommand: cfg.startCommand,
      env: cfg.env,
      rebuild,
    });
    return { kind: 'bridge', name: d.name ?? d.sourceRef ?? 'sandbox-mcp', command, args, env: cfg.env };
  }

  // No real package source → the builtin demo server. This covers legacy catalog
  // rows that have no admin-wired recipe (serverId set, source null). A catalog
  // deployment WITH a source runs its real package in a container, same path as
  // a custom deployment.
  if (!d.source) return { kind: 'builtin', name: d.server?.name ?? d.name ?? 'mcp' };
  const { env, startCommand, network } = readCfg(d.installCfg);
  const { command, args } = buildSpawnSpec(
    d.source,
    d.sourceRef ?? '',
    startCommand,
    env,
    rebuild,
    network,
  );
  return { kind: 'bridge', name: d.name ?? d.server?.name ?? d.sourceRef ?? 'custom', command, args, env };
}
