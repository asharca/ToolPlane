import {
  sandboxFlags,
  envFlags,
  WRAP_IMAGE,
  CACHE_ENV,
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
      sandboxKind: 'docker' | 'connector' | 'hermes';
      image?: string;
      volumeName?: string;
      network: McpNetwork;
      env: Record<string, string>;
      connector?: SandboxConnectorConfig;
      runtimeId?: string;
      runtimeModelName?: string;
    };

export type DeploymentForSpawn = {
  serverId: string | null;
  server?: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
};

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

function readCfg(installCfg: unknown): {
  env: Record<string, string>;
  startCommand?: string;
  network: McpNetwork;
} {
  const c = (installCfg ?? {}) as {
    env?: Record<string, string>;
    startCommand?: string;
    network?: string;
  };
  return {
    env: c.env ?? {},
    startCommand: c.startCommand,
    network: c.network === 'none' ? 'none' : 'isolated',
  };
}

function readSandboxCfg(installCfg: unknown): {
  sandboxId: string;
  kind: 'docker' | 'connector' | 'hermes';
  image?: string;
  volumeName?: string;
  network: McpNetwork;
  env: Record<string, string>;
  connector?: SandboxConnectorConfig;
  runtimeId?: string;
  runtimeModelName?: string;
} {
  const c = (installCfg ?? {}) as {
    sandboxId?: string;
    kind?: string;
    image?: string;
    volumeName?: string;
    network?: string;
    env?: Record<string, string>;
    runtimeId?: string;
    runtimeModelName?: string;
  };
  const connector = connectorFromConfig(installCfg);
  const kind = c.kind === 'hermes' && c.runtimeId
    ? 'hermes'
    : c.kind === 'connector' && connector
      ? 'connector'
      : 'docker';
  return {
    sandboxId: c.sandboxId ?? '',
    kind,
    image: c.image,
    volumeName: c.volumeName,
    network: c.network === 'none' ? 'none' : 'isolated',
    env: c.env ?? {},
    connector: connector ?? undefined,
    runtimeId: c.runtimeId,
    runtimeModelName: c.runtimeModelName,
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
      network: cfg.network,
      env: cfg.env,
      ...(cfg.image ? { image: cfg.image } : {}),
      ...(cfg.volumeName ? { volumeName: cfg.volumeName } : {}),
      ...(cfg.connector ? { connector: cfg.connector } : {}),
      ...(cfg.runtimeId ? { runtimeId: cfg.runtimeId } : {}),
      ...(cfg.runtimeModelName ? { runtimeModelName: cfg.runtimeModelName } : {}),
    };
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
