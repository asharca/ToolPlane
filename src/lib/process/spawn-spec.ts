import {
  sandboxFlags,
  envFlags,
  WRAP_IMAGE,
  CACHE_ENV,
  type McpNetwork,
} from './sandbox';
import { commandArgsNeedGit } from './git-source';
import { connectorFromConfig, type SandboxConnectorConfig } from '@/lib/sandboxes/connector';
import { parseDockerJsonArgs } from '@/lib/workspace/docker-json-command';

export type SpawnSpec =
  | { kind: 'builtin'; name: string }
  | {
      kind: 'bridge';
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      // Kept separately from the docker argv so the supervisor can expose the
      // image lifecycle without ever recording a command line that may contain
      // `-e KEY=value` secrets.
      image?: string;
      // JSON-configured npx/uvx/uv MCPs may use relative config file arguments.
      // When runtime files are attached, the supervisor supplies the managed
      // config mount and makes it the container working directory.
      configWorkingDirectory?: boolean;
    }
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
      allowSudo?: boolean;
    };

export type DeploymentForSpawn = {
  serverId: string | null;
  server?: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
};

export type DockerSpawnSpec = {
  command: string;
  args: string[];
  image: string;
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
): DockerSpawnSpec {
  const run = ['run', ...sandboxFlags(network)];

  switch (source) {
    case 'npm':
    case 'github': {
      const inner = rebuild ? ['npx', '-y', '--prefer-online', ref] : ['npx', '-y', ref];
      const image = source === 'github' ? WRAP_IMAGE.npmGit : WRAP_IMAGE.npm;
      return {
        command: 'docker',
        args: [...run, ...envFlags(CACHE_ENV.npm), ...envFlags(env), image, ...inner],
        image,
      };
    }
    case 'pypi': {
      const inner = rebuild ? ['uvx', '--refresh', ref] : ['uvx', ref];
      return {
        command: 'docker',
        args: [...run, ...envFlags(CACHE_ENV.pypi), ...envFlags(env), WRAP_IMAGE.pypi, ...inner],
        image: WRAP_IMAGE.pypi,
      };
    }
    case 'docker': {
      const pull = rebuild ? ['--pull', 'always'] : [];
      return {
        command: 'docker',
        args: [...run, ...pull, ...envFlags(env), ref, ...splitArgs(startCommand)],
        image: ref,
      };
    }
    default:
      throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
  }
}

export function buildStdioConfigSpawnSpec(
  command: string,
  commandArgs: string[],
  env: Record<string, string> = {},
  rebuild = false,
  network: McpNetwork = 'isolated',
): DockerSpawnSpec {
  const run = ['run', ...sandboxFlags(network)];
  if (command === 'npx') {
    const refresh = rebuild ? ['--prefer-online'] : [];
    const image = commandArgsNeedGit(command, commandArgs) ? WRAP_IMAGE.npmGit : WRAP_IMAGE.npm;
    return {
      command: 'docker',
      args: [
        ...run,
        ...envFlags(CACHE_ENV.npm),
        ...envFlags(env),
        image,
        'npx',
        ...refresh,
        ...commandArgs,
      ],
      image,
    };
  }
  if (command === 'uvx' || command === 'uv') {
    const refresh = command === 'uvx' && rebuild ? ['--refresh'] : [];
    const image = commandArgsNeedGit(command, commandArgs) ? WRAP_IMAGE.pypiGit : WRAP_IMAGE.pypi;
    return {
      command: 'docker',
      args: [
        ...run,
        ...envFlags(CACHE_ENV.pypi),
        ...envFlags(env),
        image,
        command,
        ...refresh,
        ...commandArgs,
      ],
      image,
    };
  }
  if (command === 'docker') {
    const { image, commandArgs: containerArgs } = parseDockerJsonArgs(commandArgs);
    const pull = rebuild ? ['--pull', 'always'] : [];
    return {
      command: 'docker',
      args: [
        ...run,
        ...pull,
        ...envFlags(env),
        image,
        ...containerArgs,
      ],
      image,
    };
  }
  throw new Error(`Unsupported stdio MCP command: ${command || '(none)'}`);
}

function readCfg(installCfg: unknown): {
  env: Record<string, string>;
  startCommand?: string;
  command?: string;
  args: string[];
  network: McpNetwork;
} {
  const c = (installCfg ?? {}) as {
    env?: Record<string, string>;
    startCommand?: string;
    command?: string;
    args?: string[];
    network?: string;
  };
  return {
    env: c.env ?? {},
    startCommand: c.startCommand,
    command: c.command,
    args: Array.isArray(c.args) ? c.args : [],
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
  allowSudo: boolean;
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
    allowSudo?: boolean;
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
    allowSudo: c.allowSudo === true,
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
      ...(cfg.allowSudo ? { allowSudo: true } : {}),
    };
  }

  // No real package source → the builtin demo server. This covers legacy catalog
  // rows that have no admin-wired recipe (serverId set, source null). A catalog
  // deployment WITH a source runs its real package in a container, same path as
  // a custom deployment.
  if (!d.source) return { kind: 'builtin', name: d.name ?? d.server?.name ?? 'mcp' };
  const { env, startCommand, command, args: commandArgs, network } = readCfg(d.installCfg);
  if (d.source === 'config') {
    const configSpec = buildStdioConfigSpawnSpec(
      command ?? '',
      commandArgs,
      env,
      rebuild,
      network,
    );
    return {
      kind: 'bridge',
      name: d.name ?? 'custom',
      command: configSpec.command,
      args: configSpec.args,
      env,
      image: configSpec.image,
      // Docker JSON preserves the image's own WORKDIR. Its mounted runtime
      // files are still available at /toolplane/config via absolute paths.
      ...(command !== 'docker' ? { configWorkingDirectory: true } : {}),
    };
  }
  const packageSpec = buildSpawnSpec(
    d.source,
    d.sourceRef ?? '',
    startCommand,
    env,
    rebuild,
    network,
  );
  return {
    kind: 'bridge',
    name: d.name ?? d.server?.name ?? d.sourceRef ?? 'custom',
    command: packageSpec.command,
    args: packageSpec.args,
    env,
    image: packageSpec.image,
  };
}
