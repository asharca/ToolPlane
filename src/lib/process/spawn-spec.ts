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

export function buildSpawnSpec(
  source: string,
  ref: string,
  args: string[],
): { command: string; args: string[] } {
  if (source === 'npm') {
    return { command: 'npx', args: ['-y', ref, ...args] };
  }
  throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
}

function readCfg(installCfg: unknown): { env: Record<string, string>; args: string[] } {
  const c = (installCfg ?? {}) as { env?: Record<string, string>; args?: string[] };
  return { env: c.env ?? {}, args: Array.isArray(c.args) ? c.args : [] };
}

export function resolveSpawnSpec(d: DeploymentForSpawn): SpawnSpec {
  if (d.serverId && d.server) {
    return { kind: 'builtin', name: d.server.name };
  }
  const { env, args } = readCfg(d.installCfg);
  const ref = d.sourceRef ?? '';
  const { command, args: cmdArgs } = buildSpawnSpec(d.source ?? '', ref, args);
  return { kind: 'bridge', name: d.name ?? (ref || 'custom'), command, args: cmdArgs, env };
}
