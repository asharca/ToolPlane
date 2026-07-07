import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getInstalledSkills, getBrowseSkills } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { installSkillAction } from '@/lib/workspace/actions';
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

export default async function BrowseSkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const t = await getTranslations('console.skills');
  const { workspace: slug } = await params;
  const { page: pageParam, q: qParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const q = (qParam ?? '').trim();
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [{ featured, all, total, pageSize }, installed] = await Promise.all([
    getBrowseSkills(page, q),
    getInstalledSkills(ws.id),
  ]);
  const installedIds = new Set(installed.map((i) => i.skillId).filter((id): id is string => id !== null));
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'Skills', href: `/app/${slug}/skills` }, { label: 'Market' }]}
      />
      <DashboardPage className="space-y-8">
        <DashboardToolbar
          actions={
            <Link href={`/app/${slug}/skills`} className="ui-button-ghost">
              {t('backToInstalled')}
            </Link>
          }
        >
          <DashboardSearchForm
            defaultValue={q}
            placeholder={t('searchSkills')}
            clearHref={`/app/${slug}/skills/new`}
            width="sm:w-72"
          />
        </DashboardToolbar>

        {featured.length > 0 ? (
          <DashboardSection title={t('featuredSkills')}>
            <BrowseGrid
              items={featured}
              installedIds={installedIds}
              slug={slug}
              action={installSkillAction}
              idField="skillId"
              actionLabel="Install"
              installedLabel="Installed"
            />
          </DashboardSection>
        ) : null}

        <DashboardSection title={q ? `Results for "${q}"` : t('allSkills')} count={total}>
          {all.length === 0 ? (
            <DashboardEmptyState
              description={q ? `No skills match "${q}".` : t('noSkillsFound')}
            />
          ) : (
            <>
              <DashboardTable
                headers={[
                  { label: 'Skill' },
                  { label: 'Source' },
                  { label: 'Description' },
                  { align: 'right' },
                ]}
              >
                {all.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {s.iconUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.iconUrl}
                            alt=""
                            width={20}
                            height={20}
                            className="size-5 rounded object-cover"
                          />
                        ) : (
                          <span className="size-5 rounded bg-muted" />
                        )}
                        <Link
                          href={`/tools/skills/${s.slug}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {s.name}
                        </Link>
                        {s.curated ? (
                          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] uppercase text-muted-foreground">
                            {t('curated')}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.githubSource ? t('github') : s.author ?? 'Market'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="line-clamp-1">{s.description}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {installedIds.has(s.id) ? (
                        <span className="text-xs text-muted-foreground">{t('installed')}</span>
                      ) : (
                        <form action={installSkillAction} className="inline">
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="skillId" value={s.id} />
                          <button className="text-xs font-medium text-foreground hover:text-muted-foreground">
                            {t('install')}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </DashboardTable>
              <DashboardPagination
                page={page}
                lastPage={lastPage}
                total={total}
                label={t('skills')}
                hrefForPage={(nextPage) => `/app/${slug}/skills/new?${q ? `q=${encodeURIComponent(q)}&` : ''}page=${nextPage}`}
              />
            </>
          )}
        </DashboardSection>
      </DashboardPage>
    </>
  );
}
