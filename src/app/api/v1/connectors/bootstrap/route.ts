import { NextResponse } from 'next/server';
import { connectorPublicWsUrl, ensureConnectorBroker } from '@/lib/sandboxes/connector-broker';
import { CONNECTOR_PROTOCOL_VERSION } from '@/lib/sandboxes/connector';
import { findSandboxByConnectorToken } from '@/lib/sandboxes/connector-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')?.[1] ?? '';
  const sandbox = await findSandboxByConnectorToken(token);
  if (!sandbox) {
    return NextResponse.json({ error: 'invalid connector token' }, { status: 401 });
  }

  await ensureConnectorBroker();
  return NextResponse.json({
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    sandboxId: sandbox.id,
    workspaceId: sandbox.workspaceId,
    name: sandbox.name,
    slug: sandbox.slug,
    root: sandbox.connector.remoteRoot,
    wsUrl: connectorPublicWsUrl(sandbox.connector.serverUrl),
  });
}
