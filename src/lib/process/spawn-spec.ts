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

export function buildSpawnSpec(
  source: string,
  ref: string,
  startCommand?: string,
): { command: string; args: string[] } {
  switch (source) {
    case 'npm':
      return { command: 'npx', args: ['-y', ref] };
    case 'github':
      return { command: 'npx', args: ['-y', ref] };
    case 'pypi':
      return { command: 'uvx', args: [ref] };
    case 'docker':
      return { command: 'docker', args: ['run', '-i', '--rm', ref, ...splitArgs(startCommand)] };
    default:
      throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
  }
}

function readCfg(installCfg: unknown): { env: Record<string, string>; startCommand?: string } {
  const c = (installCfg ?? {}) as { env?: Record<string, string>; startCommand?: string };
  return { env: c.env ?? {}, startCommand: c.startCommand };
}

export function resolveSpawnSpec(d: DeploymentForSpawn): SpawnSpec {
  if (d.serverId && d.server) return { kind: 'builtin', name: d.server.name };
  const { env, startCommand } = readCfg(d.installCfg);
  const { command, args } = buildSpawnSpec(d.source ?? '', d.sourceRef ?? '', startCommand);
  return { kind: 'bridge', name: d.name ?? d.sourceRef ?? 'custom', command, args, env };
}
