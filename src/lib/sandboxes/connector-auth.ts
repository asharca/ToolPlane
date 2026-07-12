import 'server-only';
import { db } from '@/lib/db';
import {
  connectorFromConfig,
  hashConnectorToken,
  isConnectorToken,
  type SandboxConnectorConfig,
} from './connector';

export type ConnectorSandboxRecord = {
  id: string;
  workspaceId: string;
  deploymentId: string;
  name: string;
  slug: string;
  connector: SandboxConnectorConfig;
};

export async function findSandboxByConnectorToken(token: string): Promise<ConnectorSandboxRecord | null> {
  const normalizedToken = token.trim();
  if (!isConnectorToken(normalizedToken)) return null;
  const hash = hashConnectorToken(normalizedToken);

  const rows = await db.sandbox.findMany({
    where: {
      kind: 'connector',
      deployment: { status: { in: ['running', 'provisioning'] } },
    },
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
