export type LabelInput = {
  serverId: string | null;
  server: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
};

export type DeploymentLabel = { name: string; source: string; ref: string | null };

export function deploymentLabel(d: LabelInput): DeploymentLabel {
  if (d.serverId && d.server) {
    return { name: d.server.name, source: 'catalog', ref: null };
  }
  return {
    name: d.name ?? d.sourceRef ?? 'Untitled server',
    source: d.source ?? 'custom',
    ref: d.sourceRef ?? null,
  };
}
