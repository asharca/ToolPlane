import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments, getBrowseServers } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';
import { deployServerAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function BrowseMcpPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { workspace: slug } = await params;
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [{ featured, all, total, pageSize }, deployed] = await Promise.all([
    getBrowseServers(page),
    getDeployments(ws.id),
  ]);
  const deployedIds = new Set(deployed.map((d) => d.serverId).filter((id): id is string => id !== null));
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'MCP Servers', href: `/app/${slug}/mcp` }, { label: 'Browse' }]}
      />
      <div className="space-y-8 px-8 py-6">
        <div className="flex items-center justify-end">
          <DeployCustomMcpDialog slug={slug} />
        </div>

        {featured.length > 0 ? (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Featured</h2>
            <BrowseGrid items={featured} installedIds={deployedIds} slug={slug} action={deployServerAction} idField="serverId" actionLabel="Add" installedLabel="Added" />
          </section>
        ) : null}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">All MCPs</h2>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 text-right font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {all.map((s) => (
                  <tr key={s.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{s.name}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      <span className="line-clamp-1">{s.description}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {deployedIds.has(s.id) ? (
                        <span className="text-xs text-muted-foreground">Added</span>
                      ) : (
                        <form action={deployServerAction} className="inline">
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="serverId" value={s.id} />
                          <button className="text-xs font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">Add</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
            <span>Showing page {page} of {lastPage} · {total} servers</span>
            <div className="flex gap-2">
              {page > 1 ? <Link href={`/app/${slug}/mcp/new?page=${page - 1}`} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Prev</Link> : null}
              {page < lastPage ? <Link href={`/app/${slug}/mcp/new?page=${page + 1}`} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Next</Link> : null}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
