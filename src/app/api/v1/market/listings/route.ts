import { listMarketListings } from '@/lib/market/listings';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const query = new URL(req.url).searchParams;
  const requestedSort = query.get('sort');
  const result = await listMarketListings({
    kind: query.get('kind') ?? undefined,
    q: query.get('q') ?? undefined,
    tag: query.get('tag') ?? undefined,
    category: query.get('category') ?? undefined,
    sort: requestedSort === 'newest' || requestedSort === 'name' ? requestedSort : 'popular',
    page: Number(query.get('page')),
    pageSize: Number(query.get('pageSize')),
  });
  return Response.json(result);
}
