import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getOrCreateDefaultWorkspace } from '@/lib/workspace/queries';

export const dynamic = 'force-dynamic';

function intentSlug(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._-]{1,200}$/.test(candidate) ? candidate : null;
}

export default async function AppIndexPage({
  searchParams,
}: {
  searchParams: Promise<{
    server?: string | string[];
    skill?: string | string[];
    market?: string | string[];
    q?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const server = intentSlug(query.server);
  const skill = intentSlug(query.skill);
  const rawMarket = Array.isArray(query.market) ? query.market[0] : query.market;
  const market = rawMarket === 'mcp' || rawMarket === 'skills' ? rawMarket : null;
  const rawTerm = Array.isArray(query.q) ? query.q[0] : query.q;
  const term = rawTerm?.trim().slice(0, 160) ?? '';
  const marketIntent = market
    ? `/app?market=${market}${term ? `&q=${encodeURIComponent(term)}` : ''}`
    : null;
  const intent = server
    ? `/app?server=${encodeURIComponent(server)}`
    : skill
      ? `/app?skill=${encodeURIComponent(skill)}`
      : marketIntent ?? '/app';
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(intent)}`);
  const ws = await getOrCreateDefaultWorkspace(user.id, user.email);
  if (server) {
    redirect(`/app/${encodeURIComponent(ws.slug)}/market/mcp/${encodeURIComponent(server)}`);
  }
  if (skill) {
    redirect(`/app/${encodeURIComponent(ws.slug)}/market/skills/${encodeURIComponent(skill)}`);
  }
  if (market) {
    const marketPath = `/app/${encodeURIComponent(ws.slug)}/market/${market}`;
    redirect(`${marketPath}${term ? `?q=${encodeURIComponent(term)}` : ''}`);
  }
  redirect(`/app/${encodeURIComponent(ws.slug)}/mcp`);
}
