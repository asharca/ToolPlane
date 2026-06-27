export type SpawnSpec =
  | { kind: 'builtin'; name: string }
  | { kind: 'bridge'; name: string; command: string; args: string[]; env: Record<string, string> };

export type DeploymentForSpawn = {
  serverId: string | null;
  server: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
};

function splitArgs(s: string | undefined): string[] {
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

// `rebuild = true` forces the package/image to be re-fetched instead of served
// from cache, so a Rebuild picks up a newer version (vs. Restart, which reuses
// whatever is cached): npm revalidates the registry, uv refreshes its cache,
// docker re-pulls the image.
export function buildSpawnSpec(
  source: string,
  ref: string,
  startCommand?: string,
  env: Record<string, string> = {},
  rebuild = false,
): { command: string; args: string[] } {
  switch (source) {
    case 'npm':
    case 'github':
      return { command: 'npx', args: rebuild ? ['-y', '--prefer-online', ref] : ['-y', ref] };
    case 'pypi':
      return { command: 'uvx', args: rebuild ? ['--refresh', ref] : [ref] };
    case 'docker': {
      // A container does NOT inherit the host process env, so each variable must
      // be passed to `docker run` as an explicit `-e KEY=VALUE` flag.
      const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const pull = rebuild ? ['--pull', 'always'] : [];
      return { command: 'docker', args: ['run', '-i', '--rm', ...pull, ...envFlags, ref, ...splitArgs(startCommand)] };
    }
    default:
      throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
  }
}

function readCfg(installCfg: unknown): { env: Record<string, string>; startCommand?: string } {
  const c = (installCfg ?? {}) as { env?: Record<string, string>; startCommand?: string };
  return { env: c.env ?? {}, startCommand: c.startCommand };
}

export function resolveSpawnSpec(d: DeploymentForSpawn, rebuild = false): SpawnSpec {
  if (d.serverId && d.server) return { kind: 'builtin', name: d.server.name };
  const { env, startCommand } = readCfg(d.installCfg);
  const { command, args } = buildSpawnSpec(d.source ?? '', d.sourceRef ?? '', startCommand, env, rebuild);
  return { kind: 'bridge', name: d.name ?? d.sourceRef ?? 'custom', command, args, env };
}
