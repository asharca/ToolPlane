import 'server-only';
import { db } from '@/lib/db';
import { connectorFromConfig, hashConnectorToken, type SandboxConnectorConfig } from './connector';

export type ConnectorSandboxRecord = {
  id: string;
  workspaceId: string;
  deploymentId: string;
  name: string;
  slug: string;
  connector: SandboxConnectorConfig;
};

export async function findSandboxByConnectorToken(token: string): Promise<ConnectorSandboxRecord | null> {
  const hash = hashConnectorToken(token.trim());
  if (!hash) return null;

  const rows = await db.sandbox.findMany({
    where: { kind: 'connector' },
    select: {
      id: true,
      workspaceId: true,
      deploymentId: true,
      name: true,
      slug: true,
      config: true,
    },
  });

  for (const row of rows) {
    const connector = connectorFromConfig(row.config);
    if (connector?.tokenHash === hash) {
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        deploymentId: row.deploymentId,
        name: row.name,
        slug: row.slug,
        connector,
      };
    }
  }

  return null;
}
