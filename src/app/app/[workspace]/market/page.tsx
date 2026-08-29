import { redirect } from 'next/navigation';

const LEGACY_KIND_ROUTES: Record<string, string> = {
  mcp: 'mcp',
  skill: 'skills',
  agent: 'agents',
  assistant: 'assistants',
  toolkit: 'toolkits',
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default async function MarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace }, query] = await Promise.all([params, searchParams]);
  const section = LEGACY_KIND_ROUTES[firstParam(query.kind)] ?? 'mcp';
  const nextQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key !== 'kind' && firstParam(value)) nextQuery.set(key, firstParam(value));
  }
  const suffix = nextQuery.toString();
  redirect(`/app/${encodeURIComponent(workspace)}/market/${section}${suffix ? `?${suffix}` : ''}`);
}
