import { listServers } from '@/lib/queries/servers';
import { ServerCard } from '@/components/cards/ServerCard';
import { Pagination } from '@/components/Pagination';

const PAGE_SIZE = 30;

export async function ServerList({ page }: { page: number }) {
  const { items, total } = await listServers({ page, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        Browse All MCP Servers
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {total.toLocaleString()} servers
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No servers yet. Run the scraper to populate the catalog.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((server) => (
            <ServerCard key={server.slug} server={server} />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        basePath="/server"
        pagePath="/server/page"
      />
    </div>
  );
}
