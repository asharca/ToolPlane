import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import { getPublicSkill } from '../../../_lib/catalog';
import { siteMetadata } from '../../../_lib/metadata';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const [{ slug }, locale] = await Promise.all([params, getLocale()]);
  const skill = await getPublicSkill(slug);
  const fallback = getMarketingContent(locale).capabilities.skills.description;
  if (!skill) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: fallback,
      path: `/tools/skills/${encodeURIComponent(slug)}`,
      index: false,
    });
  }
  return siteMetadata({
    title: `${skill.name} | ${SITE.name}`,
    description: skill.description ?? fallback,
    path: `/tools/skills/${encodeURIComponent(skill.slug)}`,
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, t, locale] = await Promise.all([
    params,
    getTranslations('skills'),
    getLocale(),
  ]);
  const skill = await getPublicSkill(slug);
  if (!skill) notFound();
  const description =
    skill.description ?? getMarketingContent(locale).capabilities.skills.description;

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center gap-3">
        {skill.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={skill.iconUrl} alt="" width={40} height={40} className="size-10 rounded-full object-cover" />
        ) : (
          <span aria-hidden="true" className="size-10 rounded-full bg-muted" />
        )}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{skill.name}</h1>
          {skill.author ? <p className="text-sm text-muted-foreground">{skill.author}</p> : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-1 text-sm text-muted-foreground">
        <Star className="size-4" aria-hidden="true" />
        {skill.score.toLocaleString()}
      </div>
      <p className="mt-6 text-base leading-relaxed text-foreground">{description}</p>

      {skill.categories.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {skill.categories.map((category) => (
            <Link key={category.id} href={`/categories/${category.slug}`} className="ui-chip">
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-10 rounded-lg border border-border bg-card p-4">
        <Link
          href={skill.installable
            ? `/app?skill=${encodeURIComponent(skill.slug)}`
            : `/app?market=skills&q=${encodeURIComponent(skill.slug)}`}
          className="ui-button-primary flex min-h-10 w-full"
        >
          {skill.installable ? t('addToMyWorkspace') : t('browseInstallableSkills')}
        </Link>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {skill.installable ? t('oneclickInstall') : t('curatedSkillsOnly')}
        </p>
      </div>

      <section className="mt-10 rounded-lg border border-border bg-card p-5">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-foreground">{t('installThisSkill')}</h2>
        {skill.githubSource ? (
          <pre className="mt-3 overflow-x-auto rounded-md bg-muted px-4 py-3 font-mono text-sm text-foreground">
            <code>npx skillfish add {skill.githubSource}</code>
          </pre>
        ) : null}
        <Link href="/app" className="ui-button-secondary mt-3">
          {t('openDashboard')}
        </Link>
      </section>
    </article>
  );
}
