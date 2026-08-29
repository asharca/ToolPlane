import { getMarketListing } from '@/lib/market/listings';
import { parseSkillReleaseManifest } from '@/lib/market/skill-manifest';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; slug: string }> },
) {
  const { namespace, slug } = await params;
  const listing = await getMarketListing(namespace, slug);
  if (!listing?.latestRelease || listing.kind !== 'skill') {
    return Response.json({ error: 'Market skill not found.' }, { status: 404 });
  }
  const manifest = parseSkillReleaseManifest(
    listing.latestRelease.manifest,
    listing.latestRelease.checksum,
  );
  const filename = `${manifest.skill.slug.replace(/[^A-Za-z0-9._-]/g, '-') || 'skill'}-SKILL.md`;
  return new Response(manifest.skill.content, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
