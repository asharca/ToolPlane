import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CheckCircle2, Store } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getInstalledSkills } from '@/lib/workspace/queries';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { uninstallSkillAction } from '@/lib/workspace/actions';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardTable,
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

function fileCount(files: unknown): number {
  return Array.isArray(files) ? files.length : 0;
}

const STEPS = [
  {
    n: '01',
    title: 'Create or import',
    body: 'Write a skill from scratch, or pull one from a GitHub repo.',
  },
  {
    n: '02',
    title: 'Refine in place',
    body: "Iterate and refine. Every save is versioned, so it's safe to experiment.",
  },
  {
    n: '03',
    title: 'Sync everywhere',
    body: 'Skills stay in sync across every client and toolkit. Update once, ship everywhere.',
  },
];

export default async function SkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ imported?: string | string[] }>;
}) {
  const t = await getTranslations('console.skills');
  const { workspace: slug } = await params;
  const query = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const skills = await getInstalledSkills(ws.id);
  const importedIds = new Set(
    String(Array.isArray(query.imported) ? query.imported[0] : query.imported || '')
      .split(',')
      .filter(Boolean),
  );
  const importedSkills = skills.filter((skill) => importedIds.has(skill.id));

  return (
    <>
      <DashboardHeader title={t('skills')} />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <>
              <Link href={`/app/${slug}/skills/new`} className="ui-button-secondary">
                <Store className="size-4" />
                {t('browseSkillMarket')}
              </Link>
              <AddSkillDialog slug={slug} />
            </>
          }
        >
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t('instructionsAndAssetsYourAgentLoadsOnDemandAuthorOrSyncFromGithub')}
          </p>
        </DashboardToolbar>

        {importedSkills.length > 0 ? (
          <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/70 dark:bg-emerald-950/30">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                  <CheckCircle2 className="size-4" />
                  {t('importedSkills', { count: importedSkills.length })}
                </div>
                <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
                  {t('importedSkillsDescription')}
                </p>
              </div>
              <Link href={`/app/${slug}/skills`} className="text-xs font-medium text-emerald-800 underline-offset-4 hover:underline dark:text-emerald-200">
                {t('clear')}
              </Link>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {importedSkills.map((skill) => {
                const label = skillLabel(skill);
                return (
                  <Link
                    key={skill.id}
                    href={`/app/${slug}/skills/${skill.id}`}
                    className="min-w-0 rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-900/60 dark:bg-zinc-950 dark:hover:bg-emerald-950/40"
                  >
                    <span className="block truncate font-medium text-foreground">
                      {label.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {skill.sourceRef || label.slug} · {fileCount(skill.files)} {t('bundledFiles')}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}

        {skills.length === 0 ? (
          <DashboardEmptyState
            title={t('createRefineSync')}
            description={t('skillsAddFocusedCapabilitiesToYourAgent')}
            actions={
              <>
                <AddSkillDialog slug={slug} />
                <Link
                  href={`/app/${slug}/skills/new`}
                  className="ui-button-secondary"
                >
                  {t('browseSkillMarket')}
                </Link>
              </>
            }
          >
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step) => (
                <div key={step.n}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('step')} {step.n}
                  </p>
                  <p className="mt-1.5 text-sm font-semibold text-foreground">
                    {step.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </DashboardEmptyState>
        ) : null}

        {skills.length > 0 ? (
          <DashboardTable
            headers={[
              { label: 'Skill' },
              { label: 'Added' },
              { label: 'Actions', align: 'right' },
            ]}
          >
            {skills.map((s) => {
              const label = skillLabel(s);
              return (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      {s.skill?.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.skill.iconUrl}
                          alt=""
                          width={20}
                          height={20}
                          className="size-5 rounded object-cover"
                        />
                      ) : (
                        <span className="size-5 rounded bg-muted" />
                      )}
                      <Link
                        href={`/app/${slug}/skills/${s.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {label.name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {fmt(s.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/app/${slug}/skills/${s.id}`}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Use
                      </Link>
                      <a
                        href={`/api/v1/skills/${s.id}/download`}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {t('downloadSkillmd')}
                      </a>
                      <form action={uninstallSkillAction}>
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="installId" value={s.id} />
                        <button className="text-xs text-muted-foreground transition-colors hover:text-red-600">
                          {t('uninstall')}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </DashboardTable>
        ) : null}
      </DashboardPage>
    </>
  );
}
