import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { HomeView } from '@/components/home/HomeView';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import {
  getPublicHomeSections,
  getPublicServerCount,
  listPublicCategories,
} from './_lib/catalog';
import { siteMetadata } from './_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const { home } = getMarketingContent(locale);
  return siteMetadata({
    title: `${SITE.name} | ${home.eyebrow}`,
    description: home.description,
    path: '/',
  });
}

export default async function Home() {
  const [sections, allCategories, serverCount, messages] = await Promise.all([
    getPublicHomeSections(),
    listPublicCategories(),
    getPublicServerCount(),
    getMessages(),
  ]);

  const categories = [...allCategories]
    .sort((a, b) => b._count.servers - a._count.servers)
    .slice(0, 8)
    .map(({ slug, name }) => ({ slug, name }));

  return (
    <NextIntlClientProvider messages={{ common: messages.common, home: messages.home }}>
      <HomeView {...sections} categories={categories} serverCount={serverCount} />
    </NextIntlClientProvider>
  );
}
