import { buildConnectorPackageTarball, CONNECTOR_TARBALL_FILENAME } from '@/lib/sandboxes/connector-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const body = await buildConnectorPackageTarball();
  return new Response(new Uint8Array(body), {
    headers: {
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${CONNECTOR_TARBALL_FILENAME}"`,
      'content-type': 'application/gzip',
    },
  });
}
