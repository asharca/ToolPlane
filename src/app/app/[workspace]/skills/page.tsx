
import { ButtonLink } from '@/components/motion/button';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CheckCircle2, Store } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getSkillImportSettings } from '@/lib/admin/settings';
import { getWorkspaceForUser, getInstalledSkills } from '@/lib/workspace/queries';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';
import { DashboardEmptyState, DashboardPage, DashboardToolbar } from '@/components/dashboard/DashboardUI';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { InstalledSkillsTable } from '@/components/dashboard/InstalledSkillsTable';

export const dynamic = 'force-dynamic';

function fmt(d: Date, timeZone: string, locale: string) {
  return formatInTimeZone(d, timeZone, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }, locale);
}

function fileCount(files: unknown): number {
  return Array.isArray(files) ? files.length : 0;
}

export default async function SkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ create?: string | string[]; imported?: string | string[] }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations('console.skills'),
    getLocale(),
  ]);
  const { workspace: slug } = await params;
  const query = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const [skills, skillImportSettings] = await Promise.all([
    getInstalledSkills(ws.id),
    getSkillImportSettings(),
  ]);
  const importedIds = new Set(
    String(Array.isArray(query.imported) ? query.imported[0] : query.imported || '')
      .split(',')
      .filter(Boolean),
  );
  const importedSkills = skills.filter((skill) => importedIds.has(skill.id));
  const steps = [
    { n: '01', title: t('createOrImport'), body: t('createOrImportDescription') },
    { n: '02', title: t('refineInPlace'), body: t('refineInPlaceDescription') },
    { n: '03', title: t('syncEverywhere'), body: t('syncEverywhereDescription') },
  ];

  return (
    <>
      <DashboardHeader title={t('skills')} />
      <DashboardPage>
        <DashboardToolbar
          actions={
            <>
              <ButtonLink href={`/app/${slug}/market/skills`} variant="secondary" size="md">
                <Store className="size-4" />
                {t('browseSkillMarket')}
              </ButtonLink>
              <AddSkillDialog
                slug={slug}
                maxSkillImportSkills={skillImportSettings.maxSkills}
                defaultOpen={(Array.isArray(query.create) ? query.create[0] : query.create) === '1'}
              />
            </>
          }
        >
          <p className="text-sm text-foreground dark:text-foreground">
            {t('instructionsAndAssetsYourAgentLoadsOnDemandAuthorOrSyncFromGithub')}
          </p>
        </DashboardToolbar>

        {importedSkills.length > 0 ? (
          <section className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <CheckCircle2 className="size-4" />
                  {t('importedSkills', { count: importedSkills.length })}
                </div>
                <p className="mt-1 text-sm text-(--color-success) dark:text-(--color-success)">
                  {t('importedSkillsDescription')}
                </p>
              </div>
              <Link href={`/app/${slug}/skills`} className="text-xs font-medium text-(--color-success) underline-offset-4 hover:underline dark:text-(--color-success)">
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
                    className="min-w-0 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted"
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
                <AddSkillDialog slug={slug} maxSkillImportSkills={skillImportSettings.maxSkills} />
                <ButtonLink href={`/app/${slug}/market/skills`} variant="secondary" size="md">
                  {t('browseSkillMarket')}
                </ButtonLink>
              </>
            }
          >
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              {steps.map((step) => (
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
          <InstalledSkillsTable
            slug={slug}
            skills={skills.map((skill) => ({
              id: skill.id,
              name: skillLabel(skill).name,
              iconUrl: skill.skill?.iconUrl ?? null,
              createdAt: fmt(skill.createdAt, timeZone, locale),
            }))}
          />
        ) : null}
      </DashboardPage>
    </>
  );
}
