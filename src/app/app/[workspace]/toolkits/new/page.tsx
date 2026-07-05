import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Brain, CopyPlus, Plug, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getBrowseToolkits } from '@/lib/toolkits/queries';
import { clonePublicToolkitAction } from '@/lib/toolkits/actions';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSearchForm,
  DashboardSection,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

function fmt(d: Date) {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function preview(names: string[], fallback: string) {
  if (names.length === 0) return <span className="text-muted-foreground">{fallback}</span>;
  return (
    <span className="truncate">
      {names.join(', ')}
    </span>
  );
}

export default async function BrowseToolkitsPage({
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

  const { items, total, pageSize } = await getBrowseToolkits(ws.id, page, q);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'Toolkits', href: `/app/${slug}/toolkits` }, { label: 'Market' }]}
      />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <Link href={`/app/${slug}/toolkits`} className="ui-button-ghost">
              Back to toolkits
            </Link>
          }
        >
          <DashboardSearchForm
            defaultValue={q}
            placeholder="Search public toolkits..."
            clearHref={`/app/${slug}/toolkits/new`}
          />
        </DashboardToolbar>

        <DashboardSection title={q ? `Results for "${q}"` : 'Public Toolkits'} count={total}>
          {items.length === 0 ? (
            <DashboardEmptyState
              icon={Wrench}
              description={q ? `No public toolkits match "${q}".` : 'No public toolkits yet.'}
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {items.map((toolkit) => (
                <article key={toolkit.id} className="ui-panel p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{toolkit.workspaceName}</span>
                        <span>/</span>
                        <span>{fmt(toolkit.createdAt)}</span>
                      </div>
                      <h3 className="truncate text-lg font-semibold text-foreground">
                        {toolkit.name}
                      </h3>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium text-muted-foreground">
                        <Wrench className="size-4" />
                        {toolkit.toolCount}
                      </span>
                      <form action={clonePublicToolkitAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="toolkitId" value={toolkit.id} />
                        <button className="ui-button-primary ui-button-sm">
                          <CopyPlus className="size-4" />
                          Import
                        </button>
                      </form>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border border-border bg-muted/35 p-3">
                      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                        <Plug className="size-3.5" />
                        MCP · {toolkit.serverCount}
                      </div>
                      <p className="truncate text-sm text-foreground">
                        {preview(toolkit.serverNames, 'No MCP')}
                      </p>
                    </div>
                    <div className="rounded-md border border-border bg-muted/35 p-3">
                      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                        <Brain className="size-3.5" />
                        Skills · {toolkit.skillCount}
                      </div>
                      <p className="truncate text-sm text-foreground">
                        {preview(toolkit.skillNames, 'No skills')}
                      </p>
                    </div>
                  </div>

                  {toolkit.customServerCount > 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {toolkit.customServerCount} custom MCP {toolkit.customServerCount === 1 ? 'entry' : 'entries'} will need manual setup after import.
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </DashboardSection>

        <DashboardPagination
          page={page}
          lastPage={lastPage}
          total={total}
          label="toolkits"
          hrefForPage={(nextPage) => `/app/${slug}/toolkits/new?${q ? `q=${encodeURIComponent(q)}&` : ''}page=${nextPage}`}
        />
      </DashboardPage>
    </>
  );
}
