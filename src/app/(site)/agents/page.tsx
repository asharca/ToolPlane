import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Search } from 'lucide-react';
import { CapabilityPage } from '@/components/marketing/CapabilityPage';
import { AgentListingCard } from '@/components/cards/AgentListingCard';
import { getMarketingContent } from '@/lib/marketing/content';
import { listPublicAgents } from '../_lib/catalog';
import { capabilityMetadata } from '../_lib/metadata';

export function generateMetadata(): Promise<Metadata> {
  return capabilityMetadata('agents', '/agents');
}

export default async function Page() {
  const [locale, t, agents] = await Promise.all([
    getLocale(),
    getTranslations('agentMarket'),
    listPublicAgents(),
  ]);
  return (
    <>
      <CapabilityPage
        capability="agents"
        content={getMarketingContent(locale)}
      />
      <section id="directory" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:px-8 lg:py-24">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-tight text-foreground">{t('communityAgents')}</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('heroDescription')}</p>
            </div>
            <form action="/search" className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                name="q"
                maxLength={160}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
                className="ui-input ui-input-search bg-card"
              />
            </form>
          </div>
          {agents.length === 0 ? (
            <div className="ui-empty mt-10 min-h-48">
              <h3 className="font-semibold text-foreground">{t('emptyTitle')}</h3>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">{t('emptyDescription')}</p>
            </div>
          ) : (
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <AgentListingCard key={agent.id} agent={agent} installLabel={t('clones')} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
