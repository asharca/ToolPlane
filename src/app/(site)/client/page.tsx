import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ClientCard } from '@/components/cards/ClientCard';
import { ListingHero } from '@/components/ListingHero';
import { Pagination } from '@/components/Pagination';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import {
  getPublicClientCount,
  listPublicCategories,
  listPublicClients,
} from '../_lib/catalog';
import { siteMetadata } from '../_lib/metadata';
import { publicPageNumber } from '../_lib/pagination';

const PAGE_SIZE = 30;
type SearchParams = { page?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const [params, locale] = await Promise.all([searchParams, getLocale()]);
  const page = publicPageNumber(params.page);
  const capability = getMarketingContent(locale).capabilities.clients;
  return siteMetadata({
    title: page && page > 1
      ? `${capability.eyebrow} — ${page} | ${SITE.name}`
      : `${capability.eyebrow} | ${SITE.name}`,
    description: capability.description,
    path: page && page > 1 ? `/client?page=${page}` : '/client',
    index: page !== null,
  });
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = publicPageNumber(params.page);
  if (!page) notFound();
  if (params.page !== undefined && page === 1) permanentRedirect('/client');
  const [t, common, total, categories] = await Promise.all([
    getTranslations('client'),
    getTranslations('common'),
    getPublicClientCount(),
    listPublicCategories(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) notFound();
  const { items: clients } = await listPublicClients(page, PAGE_SIZE);

  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <ListingHero
        lead={t('browseAll')}
        tail={t('mcpClients')}
        subtitle={t('mcpClientsConnectAiAgentsToModelContextProtocolServers')}
        placeholder={t('searchForMcpClients')}
        categories={categories.map(({ slug, name }) => ({ slug, name }))}
      />
      <div className="pb-14">
        {clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noClientsYet')}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map((client) => <ClientCard key={client.slug} client={client} statLabel={common('stars')} />)}
          </div>
        )}
        <Pagination
          page={page}
          totalPages={totalPages}
          hrefForPage={(value) => value === 1 ? '/client' : `/client?page=${value}`}
        />
      </div>
    </div>
  );
}
