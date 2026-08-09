import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Bot, Copy, Network, PackageCheck } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import { getPublicAgentListing } from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';

function legacyIdentity(segments: string[]): [string, string] | null {
  return segments.length === 2 ? [segments[0], segments[1]] : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ segments: string[] }>;
}): Promise<Metadata> {
  const [{ segments }, locale] = await Promise.all([params, getLocale()]);
  const identity = legacyIdentity(segments);
  const fallback = getMarketingContent(locale).capabilities.agents.description;
  const path = `/agents/${segments.map(encodeURIComponent).join('/')}`;
  if (!identity) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: fallback,
      path,
      index: false,
    });
  }
  const detail = await getPublicAgentListing(...identity);
  if (!detail) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: fallback,
      path,
      index: false,
    });
  }
  return siteMetadata({
    title: `${detail.listing.name} | ${SITE.name}`,
    description: detail.listing.summary ?? fallback,
    path,
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ segments: string[] }>;
}) {
  const [{ segments }, t] = await Promise.all([
    params,
    getTranslations('agentMarket'),
  ]);
  const identity = legacyIdentity(segments);
  if (!identity) notFound();
  const detail = await getPublicAgentListing(...identity);
  if (!detail) notFound();
  const { listing, release, workspace } = detail;

  return (
    <article className="mx-auto max-w-4xl px-4 py-12">
      <Link href="/agents" className="text-sm font-medium text-muted-foreground hover:text-foreground">
        ← {t('market')}
      </Link>
      <header className="mt-8 rounded-xl border border-border bg-card p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          {listing.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={listing.iconUrl} alt="" width={64} height={64} className="size-16 rounded-xl object-cover" />
          ) : (
            <span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-accent-foreground">
              <Bot className="size-7" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-brand">{t('version', { version: release.version })}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{listing.name}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('publishedBy', { name: listing.author ?? workspace?.name ?? SITE.name })}
            </p>
            {listing.summary ? <p className="mt-5 text-base leading-7 text-muted-foreground">{listing.summary}</p> : null}
          </div>
        </div>
      </header>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <PackageCheck className="size-5 text-muted-foreground" />
          <p className="mt-3 text-2xl font-semibold">{release.summary.resourceCount}</p>
          <p className="text-xs text-muted-foreground">{t('mcpSkills')}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <Network className="size-5 text-muted-foreground" />
          <p className="mt-3 text-2xl font-semibold">{release.summary.subAgentCount}</p>
          <p className="text-xs text-muted-foreground">{t('subAgents')}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <Copy className="size-5 text-muted-foreground" />
          <p className="mt-3 text-2xl font-semibold">{listing.installCount.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('clones')}</p>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold text-foreground">{t('clonePanelTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('clonePanelDescription')}</p>
        <Link href="/app" className="ui-button-primary mt-4">{t('openConsole')}</Link>
      </section>
    </article>
  );
}
