import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, Search } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';
import { AgentListingCard } from '@/components/cards/AgentListingCard';
import { getMarketingContent } from '@/lib/marketing/content';
import { searchPublicDirectory } from '@/lib/queries/public-search';
import { SITE } from '@/lib/site';
import { siteMetadata } from '../_lib/metadata';

type SearchParams = { q?: string | string[] };

function normalizedQuery(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value ?? '').trim().slice(0, 160);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 font-mono text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const [params, locale] = await Promise.all([searchParams, getLocale()]);
  const query = normalizedQuery(params.q);
  const description = getMarketingContent(locale).home.description;
  return siteMetadata({
    title: query ? `${query} — Search | ${SITE.name}` : `Search | ${SITE.name}`,
    description,
    path: '/search',
    index: false,
  });
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [t, agentT, common] = await Promise.all([
    getTranslations('search'),
    getTranslations('agentMarket'),
    getTranslations('common'),
  ]);
  const query = normalizedQuery((await searchParams).q);
  const { servers, clients, skills, agents } = query
    ? await searchPublicDirectory(query)
    : { servers: [], clients: [], skills: [], agents: [] };
  const total = servers.length + clients.length + skills.length + agents.length;

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label={common('breadcrumb')}>
        <Link href="/" className="transition-colors hover:text-foreground">{t('home')}</Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground" aria-current="page">{t('searchLabel')}</span>
      </nav>

      <h1 className="mt-6 text-3xl font-bold tracking-tight text-foreground">
        {t('searchLabel')}
      </h1>

      <form action="/search" className="relative mt-4 max-w-3xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          name="q"
          defaultValue={query}
          maxLength={160}
          placeholder={t('searchMcpServersSkillsAndClients')}
          aria-label={t('search')}
          className="ui-input ui-input-search h-12 bg-background"
        />
      </form>

      {!query ? (
        <p className="mt-8 text-sm text-muted-foreground">{t('enterASearchTermToFindMcpServersClientsAndAgentSkills')}</p>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted-foreground">
            {t('searchResultsFor')}{' '}
            <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>{' '}
            <span>({total})</span>
          </p>
          {total === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">{t('noResultsForQuery', { query })}</p>
          ) : (
            <div className="mt-8 space-y-10">
              {servers.length > 0 ? (
                <Section title={t('servers')}>
                  {servers.map((server) => <ServerCard key={server.slug} server={server} statLabel={common('stars')} />)}
                </Section>
              ) : null}
              {clients.length > 0 ? (
                <Section title={t('clients')}>
                  {clients.map((client) => <ClientCard key={client.slug} client={client} statLabel={common('stars')} />)}
                </Section>
              ) : null}
              {skills.length > 0 ? (
                <Section title={t('skills')}>
                  {skills.map((skill) => <SkillCard key={skill.slug} skill={skill} statLabel={common('score')} />)}
                </Section>
              ) : null}
              {agents.length > 0 ? (
                <Section title={t('agents')}>
                  {agents.map((agent) => (
                    <AgentListingCard key={agent.id} agent={agent} installLabel={agentT('clones')} />
                  ))}
                </Section>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
