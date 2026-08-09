import { redirect } from 'next/navigation';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

// Keep the former marketplace URL working for bookmarks and old clients.
export default async function LegacyToolkitMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string | string[]; q?: string | string[] }>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  const next = new URLSearchParams();
  const q = firstParam(query.q).trim();
  const page = firstParam(query.page).trim();
  if (q) next.set('q', q);
  if (page) next.set('page', page);
  const suffix = next.size > 0 ? `?${next.toString()}` : '';
  redirect(`/app/${encodeURIComponent(workspace)}/market/toolkits${suffix}`);
}
