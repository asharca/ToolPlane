import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, Brain, FileArchive, GitBranch, Star } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getMarketSkill, getWorkspaceForUser } from '@/lib/workspace/queries';
import { installSkillAction } from '@/lib/workspace/actions';
import { DashboardPage, DashboardPanel } from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export const dynamic = 'force-dynamic';

export default async function SkillMarketDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; skillSlug: string }>;
}) {
  const [{ workspace: slug, skillSlug }, t] = await Promise.all([
    params,
    getTranslations('console.market'),
  ]);
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/skills/${skillSlug}`)}`);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const skill = await getMarketSkill(skillSlug, workspace.id);
  if (!skill) notFound();
  const fileCount = Array.isArray(skill.files) ? skill.files.length : 0;

  return (
    <DashboardPage className="space-y-6">
      <Link href={`/app/${encodeURIComponent(slug)}/market/skills`} className="ui-button-ghost w-fit">
        <ArrowLeft className="size-4" />
        {t('backToSkills')}
      </Link>

      <div className="flex flex-col gap-5 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {skill.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={skill.iconUrl} alt="" width={56} height={56} className="size-14 rounded-xl object-cover" />
          ) : (
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted"><Brain className="size-6 text-muted-foreground" /></span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{skill.name}</h1>
              <span className="rounded border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{t('curated')}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{skill.author ?? t('unknownPublisher')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Star className="size-3.5" />{skill.score.toLocaleString()}</span>
              <span className="inline-flex items-center gap-1"><FileArchive className="size-3.5" />{t('bundledFiles', { count: fileCount })}</span>
              <span className="inline-flex items-center gap-1"><GitBranch className="size-3.5" />{skill.githubSource ? t('github') : t('catalog')}</span>
            </div>
          </div>
        </div>
        {skill.installId ? (
          <Link href={`/app/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skill.installId)}`} className="ui-button-secondary shrink-0">
            {t('manageSkill')}
          </Link>
        ) : (
          <form action={installSkillAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="skillId" value={skill.id} />
            <SubmitButton pendingLabel={t('installing')} className="ui-button-primary shrink-0">{t('installToWorkspace')}</SubmitButton>
          </form>
        )}
      </div>

      {skill.description ? <p className="max-w-4xl text-sm leading-7 text-muted-foreground">{skill.description}</p> : null}

      {skill.categories.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {skill.categories.map((category) => (
            <Link
              key={category.slug}
              href={`/app/${encodeURIComponent(slug)}/market/skills?category=${encodeURIComponent(category.slug)}`}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      <DashboardPanel title="SKILL.md" description={t('skillContentDescription')}>
        {skill.content ? (
          <pre className="max-h-[42rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-5 font-mono text-xs leading-6 text-zinc-100">{skill.content}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noSkillContent')}</p>
        )}
      </DashboardPanel>
    </DashboardPage>
  );
}
