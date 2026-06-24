import { listServers } from '@/lib/queries/servers';
import { RankedList } from '@/components/RankedList';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { items } = await listServers({ page: 1, pageSize: 100 });
  return (
    <RankedList
      title="Top 100 MCP Servers"
      subtitle="Ranked by GitHub stars"
      items={items.map((s) => ({
        slug: s.slug,
        name: s.name,
        author: s.author,
        iconUrl: s.iconUrl,
        href: `/server/${s.slug}`,
        stat: s.stars,
      }))}
    />
  );
}
