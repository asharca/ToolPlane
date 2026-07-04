import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments, getBrowseServers } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';
import { deployServerAction } from '@/lib/workspace/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSearchForm,
  DashboardSection,
  DashboardTable,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

export default async function BrowseMcpPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { workspace: slug } = await params;
  const { page: pageParam, q: qParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const q = (qParam ?? '').trim();
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [{ featured, all, total, pageSize }, deployed] = await Promise.all([
    getBrowseServers(page, q),
    getDeployments(ws.id),
  ]);
  const deployedIds = new Set(deployed.map((d) => d.serverId).filter((id): id is string => id !== null));
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'MCP Servers', href: `/app/${slug}/mcp` }, { label: 'Browse' }]}
      />
      <DashboardPage className="space-y-8">
        <DashboardToolbar
          actions={<DeployCustomMcpDialog slug={slug} />}
        >
          <DashboardSearchForm
            defaultValue={q}
            placeholder="Search MCP servers..."
            clearHref={`/app/${slug}/mcp/new`}
          />
        </DashboardToolbar>

        {featured.length > 0 ? (
          <DashboardSection title="Featured">
            <BrowseGrid items={featured} installedIds={deployedIds} slug={slug} action={deployServerAction} idField="serverId" actionLabel="Add" installedLabel="Added" />
          </DashboardSection>
        ) : null}

        <DashboardSection title={q ? `Results for "${q}"` : 'All MCPs'} count={total}>
          {all.length === 0 ? (
            <DashboardEmptyState
              description={q ? `No MCP servers match "${q}".` : 'No MCP servers found.'}
            />
          ) : (
            <>
              <DashboardTable
                headers={[
                  { label: 'Name' },
                  { label: 'Description' },
                  { align: 'right' },
                ]}
              >
                {all.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3 font-medium text-foreground">{s.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="line-clamp-1">{s.description}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {deployedIds.has(s.id) ? (
                        <span className="text-xs text-muted-foreground">Added</span>
                      ) : s.deployable ? (
                        <form action={deployServerAction} className="inline">
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="serverId" value={s.id} />
                          <button className="text-xs font-medium text-foreground hover:text-muted-foreground">Add</button>
                        </form>
                      ) : (
                        <span className="text-xs text-muted-foreground">Demo only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </DashboardTable>
              <DashboardPagination
                page={page}
                lastPage={lastPage}
                total={total}
                label="servers"
                hrefForPage={(nextPage) => `/app/${slug}/mcp/new?${q ? `q=${encodeURIComponent(q)}&` : ''}page=${nextPage}`}
              />
            </>
          )}
        </DashboardSection>
      </DashboardPage>
    </>
  );
}
