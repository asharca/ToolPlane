import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Brain, MessageSquare, Plug, Wrench, type LucideIcon } from 'lucide-react';
import { ServerCard } from '@/components/cards/ServerCard';
import { SkillCard } from '@/components/cards/SkillCard';
import { AgentListingCard } from '@/components/cards/AgentListingCard';
import { SITE } from '@/lib/site';
import { getPublicCategory } from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';

function MarketResourceCard({
  name,
  description,
  publisher,
  href,
  icon: Icon,
}: {
  name: string;
  description?: string | null;
  publisher: string;
  href: string;
  icon: LucideIcon;
}) {
  return (
    <Link href={href} className="ui-panel flex min-h-40 flex-col p-4 transition-colors hover:border-foreground/25">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-foreground">{name}</h3>
          <p className="truncate text-[11px] leading-4 text-muted-foreground">{publisher}</p>
        </div>
      </div>
      {description ? (
        <p className="mt-3 line-clamp-3 text-[13px] leading-5 text-muted-foreground">{description}</p>
      ) : null}
    </Link>
  );
}

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
    category.agentListings.length > 0 ||
    category.communityMcps.length > 0 ||
    category.communitySkills.length > 0 ||
    category.assistants.length > 0 ||
    category.toolkits.length > 0;

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="text-3xl font-bold tracking-tight text-foreground">{category.name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('categoryCounts', {
          servers: category._count.servers,
          skills: category._count.skills,
          agents: category._count.agentListings,
          assistants: category._count.assistants,
          toolkits: category._count.toolkits,
        })}
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
          {category.communityMcps.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{t('communityMcps')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.communityMcps.map((server) => (
                  <MarketResourceCard
                    key={server.id}
                    name={server.name}
                    description={server.summary}
                    publisher={server.namespace}
                    href={`/market/${encodeURIComponent(server.namespace)}/${encodeURIComponent(server.slug)}`}
                    icon={Plug}
                  />
                ))}
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
          {category.communitySkills.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{t('communitySkills')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.communitySkills.map((skill) => (
                  <MarketResourceCard
                    key={skill.id}
                    name={skill.name}
                    description={skill.summary}
                    publisher={skill.namespace}
                    href={`/market/${encodeURIComponent(skill.namespace)}/${encodeURIComponent(skill.slug)}`}
                    icon={Brain}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {category.assistants.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{t('assistants')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.assistants.map((assistant) => (
                  <MarketResourceCard
                    key={assistant.id}
                    name={assistant.name}
                    description={assistant.summary}
                    publisher={assistant.namespace}
                    href={`/market/${encodeURIComponent(assistant.namespace)}/${encodeURIComponent(assistant.slug)}`}
                    icon={MessageSquare}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {category.toolkits.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold text-foreground">{t('toolkits')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.toolkits.map((toolkit) => (
                  <MarketResourceCard
                    key={toolkit.id}
                    name={toolkit.name}
                    description={toolkit.resourceSummary ?? t('toolkitResources', {
                      servers: '_count' in toolkit ? toolkit._count.servers : 0,
                      skills: '_count' in toolkit ? toolkit._count.skills : 0,
                    })}
                    publisher={toolkit.publisher}
                    href={toolkit.href}
                    icon={Wrench}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
