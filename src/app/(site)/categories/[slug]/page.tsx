import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ServerCard } from '@/components/cards/ServerCard';
import { SkillCard } from '@/components/cards/SkillCard';
import { AgentListingCard } from '@/components/cards/AgentListingCard';
import { SITE } from '@/lib/site';
import { getPublicCategory } from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const [{ slug }, t] = await Promise.all([params, getTranslations('categories')]);
  const category = await getPublicCategory(slug);
  if (!category) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: t('exploreDirectoryByCategory'),
      path: `/categories/${encodeURIComponent(slug)}`,
      index: false,
    });
  }
  return siteMetadata({
    title: `${category.name} | ${SITE.name}`,
    description: t('exploreDirectoryByCategory'),
    path: `/categories/${encodeURIComponent(category.slug)}`,
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [t, searchT, agentT, common] = await Promise.all([
    getTranslations('categories'),
    getTranslations('search'),
    getTranslations('agentMarket'),
    getTranslations('common'),
  ]);
  const category = await getPublicCategory((await params).slug);
  if (!category) notFound();
  const hasEntries =
    category.servers.length > 0 ||
    category.skills.length > 0 ||
    category.agentListings.length > 0;

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{category.name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {category._count.servers.toLocaleString()} {t('mcpServers')}
        <span className="mx-1.5 text-border">·</span>
        {category._count.skills.toLocaleString()} {searchT('skills')}
        <span className="mx-1.5 text-border">·</span>
        {category._count.agentListings.toLocaleString()} {searchT('agents')}
      </p>

      {!hasEntries ? (
        <p className="mt-8 text-sm text-muted-foreground">{t('noEntriesInThisCategoryYet')}</p>
      ) : (
        <div className="mt-8 space-y-12">
          {category.servers.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{searchT('servers')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.servers.map((server) => <ServerCard key={server.slug} server={server} statLabel={common('stars')} />)}
              </div>
            </section>
          ) : null}
          {category.skills.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{searchT('skills')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.skills.map((skill) => <SkillCard key={skill.slug} skill={skill} statLabel={common('score')} />)}
              </div>
            </section>
          ) : null}
          {category.agentListings.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{searchT('agents')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.agentListings.map((agent) => (
                  <AgentListingCard key={agent.id} agent={agent} installLabel={agentT('clones')} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
