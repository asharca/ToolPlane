import { listServers } from '@/lib/queries/servers';
import { listCategories } from '@/lib/queries/categories';
import { ServerCard } from '@/components/cards/ServerCard';
import { ListingHero } from '@/components/ListingHero';
import { Pagination } from '@/components/Pagination';

const PAGE_SIZE = 30;

export async function ServerList({ page }: { page: number }) {
  const [{ items, total }, categories] = await Promise.all([
    listServers({ page, pageSize: PAGE_SIZE }),
    listCategories(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <ListingHero
        lead="Browse All"
        tail="MCP Servers"
        subtitle="Browse every Model Context Protocol server in the directory."
        placeholder="Search for MCP servers..."
        categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
      />

      <div className="pb-14">
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
    </div>
  );
}
