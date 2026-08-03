import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/auth/admin';
import { parseAgentReleaseManifest } from '@/lib/agents/market';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ releaseId: string }> },
) {
  await requireAdmin();
  const { releaseId } = await params;
  const release = await db.agentRelease.findUnique({
    where: { id: releaseId },
    select: {
      id: true,
      listingId: true,
      version: true,
      checksum: true,
      manifest: true,
    },
  });
  if (!release) return Response.json({ error: 'Not found' }, { status: 404 });

  let manifest;
  try {
    manifest = parseAgentReleaseManifest(release.manifest, release.checksum);
  } catch {
    return Response.json({ error: 'Invalid manifest or checksum' }, { status: 422 });
  }

  return new Response(JSON.stringify({
    releaseId: release.id,
    listingId: release.listingId,
    version: release.version,
    checksum: `sha256:${release.checksum}`,
    manifest,
  }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `inline; filename="agent-release-v${release.version}.json"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
