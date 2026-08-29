import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  FileArchive,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getMarketSkill, getWorkspaceForUser } from '@/lib/workspace/queries';
import { installSkillAction } from '@/lib/workspace/actions';
import { DashboardPage } from '@/components/dashboard/DashboardUI';
import {
  MarketDetailHeader,
  MarketDetailShell,
} from '@/components/dashboard/market/MarketDetailShell';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export const dynamic = 'force-dynamic';

export default async function SkillMarketDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; skillSlug: string }>;
}) {
  const [{ workspace: slug, skillSlug }, t, locale] = await Promise.all([
    params,
    getTranslations('console.market'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/skills/${skillSlug}`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const skill = await getMarketSkill(skillSlug, workspace.id);
  if (!skill) notFound();
  const fileCount = Array.isArray(skill.files) ? skill.files.length : 0;
  const marketHref = `/app/${encodeURIComponent(slug)}/market/skills`;
  const source = skill.githubSource ? t('github') : t('catalog');

  return (
    <DashboardPage className="space-y-7">
      <MarketDetailHeader
        backHref={marketHref}
        backLabel={t('backToSkills')}
        iconUrl={skill.iconUrl}
        icon={<Brain className="size-7" />}
        type={t('kindSkill')}
        title={skill.name}
        publisher={t('publishedBy', { name: skill.author ?? t('unknownPublisher') })}
        summary={skill.description ?? t('noDescription')}
        facts={[
          { label: t('popularity'), value: skill.score.toLocaleString(locale) },
          { label: t('bundledFilesLabel'), value: fileCount },
          { label: t('source'), value: source },
        ]}
        tags={[
          { label: t('curated') },
          ...skill.categories.map((category) => ({
            label: category.name,
            href: `${marketHref}?category=${encodeURIComponent(category.slug)}`,
          })),
        ]}
      />

      <MarketDetailShell
        navigationLabel={t('detailNavigation')}
        tabs={[
          { href: '#overview', label: t('overview') },
          { href: '#capabilities', label: t('capabilities') },
        ]}
        aside={(
          <section className="rounded-lg bg-muted/35 p-5">
            <div className="flex items-start gap-2.5">
              {skill.installId ? (
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              ) : (
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-foreground" />
              )}
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {skill.installId ? t('alreadyAddedTitle') : t('readyToDeploy')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('skillContentDescription')}</p>
              </div>
            </div>
            {skill.installId ? (
              <Link href={`/app/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skill.installId)}`} className="ui-button-primary mt-5 h-10 w-full">
                {t('manageSkill')} <ArrowRight className="size-4" />
              </Link>
            ) : (
              <form action={installSkillAction} className="mt-5">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="skillId" value={skill.id} />
                <SubmitButton pendingLabel={t('installing')} flash={false} className="ui-button-primary h-10 w-full">
                  {t('installToWorkspace')} <ArrowRight className="size-4" />
                </SubmitButton>
              </form>
            )}
          </section>
        )}
      >
        <section id="overview" className="scroll-mt-24">
          <div className="flex items-center gap-2.5">
            <Brain className="size-[18px] text-muted-foreground" />
            <h2 className="font-semibold text-foreground">SKILL.md</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('skillContentDescription')}</p>
          {skill.content ? (
            <pre className="mt-4 max-h-[42rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/35 p-5 font-mono text-xs leading-6 text-foreground">{skill.content}</pre>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">{t('noSkillContent')}</p>
          )}
        </section>

        <section id="capabilities" className="scroll-mt-24">
          <div className="flex items-center gap-2.5">
            <FileArchive className="size-[18px] text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('resourceDetails')}</h2>
          </div>
          <dl className="mt-4 divide-y divide-border/60 border-y border-border/60 text-sm">
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="inline-flex items-center gap-2 text-muted-foreground"><GitBranch className="size-4" />{t('source')}</dt>
              <dd className="font-medium text-foreground">{source}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="inline-flex items-center gap-2 text-muted-foreground"><FileArchive className="size-4" />{t('bundledFilesLabel')}</dt>
              <dd className="font-medium text-foreground">{fileCount}</dd>
            </div>
          </dl>
        </section>
      </MarketDetailShell>
    </DashboardPage>
  );
}
