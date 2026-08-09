import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { notFound, permanentRedirect } from 'next/navigation';
import { ServerList } from '@/components/server/ServerList';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import { siteMetadata } from '../../../_lib/metadata';

function pageNumber(value: string): number | null {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ page: string }>;
}): Promise<Metadata> {
  const [{ page: value }, locale] = await Promise.all([params, getLocale()]);
  const page = pageNumber(value);
  const capability = getMarketingContent(locale).capabilities.mcp;
  if (!page) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: capability.description,
      path: '/server',
      index: false,
    });
  }
  return siteMetadata({
    title: page === 1
      ? `${capability.eyebrow} | ${SITE.name}`
      : `${capability.eyebrow} — ${page} | ${SITE.name}`,
    description: capability.description,
    path: page === 1 ? '/server' : `/server/page/${page}`,
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const page = pageNumber((await params).page);
  if (!page) notFound();
  if (page === 1) permanentRedirect('/server');
  return <ServerList page={page} />;
}
