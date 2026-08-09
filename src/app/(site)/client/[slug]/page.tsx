import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import { getPublicClient } from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const [{ slug }, locale] = await Promise.all([params, getLocale()]);
  const client = await getPublicClient(slug);
  const fallback = getMarketingContent(locale).capabilities.clients.description;
  if (!client) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: fallback,
      path: `/client/${encodeURIComponent(slug)}`,
      index: false,
    });
  }
  return siteMetadata({
    title: `${client.name} MCP Client | ${SITE.name}`,
    description: client.description ?? fallback,
    path: `/client/${encodeURIComponent(client.slug)}`,
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, t, locale] = await Promise.all([
    params,
    getTranslations('client'),
    getLocale(),
  ]);
  const client = await getPublicClient(slug);
  if (!client) notFound();
  const description =
    client.description ?? getMarketingContent(locale).capabilities.clients.description;

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center gap-3">
        {client.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={client.iconUrl} alt="" width={40} height={40} className="size-10 rounded-full object-cover" />
        ) : (
          <span aria-hidden="true" className="size-10 rounded-full bg-muted" />
        )}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{client.name}</h1>
          {client.author ? <p className="text-sm text-muted-foreground">{client.author}</p> : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-1 text-sm text-muted-foreground">
        <Star className="size-4" aria-hidden="true" />
        {client.stars.toLocaleString()}
      </div>
      <p className="mt-6 text-base leading-relaxed text-foreground">{description}</p>

      {client.categories.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {client.categories.map((category) => (
            <Link key={category.id} href={`/categories/${category.slug}`} className="ui-chip">
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      <section className="mt-10 rounded-lg border border-border bg-card p-5">
        <Link href="/server" className="ui-button-secondary">
          {t('browseMcpServers')}
        </Link>
      </section>
    </article>
  );
}
