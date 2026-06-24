import { listServers } from '@/lib/queries/servers';
import { RankedList } from '@/components/RankedList';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { items } = await listServers({ page: 1, pageSize: 30 });
  return (
    <RankedList
      title="Top MCPs Today"
      subtitle="The most popular MCP servers right now"
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
