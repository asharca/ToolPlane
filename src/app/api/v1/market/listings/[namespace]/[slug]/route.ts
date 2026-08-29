import { getMarketListing } from '@/lib/market/listings';
import { getAgentMarketListingByDirectorySlug } from '@/lib/agents/market';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ namespace: string; slug: string }> },
) {
  const { namespace, slug } = await params;
  const listing = await getMarketListing(namespace, slug);
  if (listing) return Response.json(listing);
  const agent = await getAgentMarketListingByDirectorySlug(slug);
  const agentNamespace = agent?.workspace?.slug ?? 'toolplane';
  if (!agent || agentNamespace !== namespace) {
    return Response.json({ error: 'Market listing not found.' }, { status: 404 });
  }
  return Response.json({
    id: agent.listing.id,
    kind: 'agent',
    namespace: agentNamespace,
    slug: agent.listing.directorySlug,
    name: agent.listing.name,
    summary: agent.listing.summary,
    iconUrl: agent.listing.iconUrl,
    tags: agent.listing.tags,
    categories: agent.listing.categories,
    curated: agent.listing.curated,
    isFeatured: agent.listing.isFeatured,
    installCount: agent.listing.installCount,
    publishedAt: agent.listing.publishedAt,
    latestRelease: {
      ...agent.release,
      releaseSummary: agent.release.summary,
      manifest: agent.manifest,
    },
  });
}
