import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, Star } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { SITE } from '@/lib/site';
import {
  getPublicRelatedServers,
  getPublicRelatedSkills,
  getPublicServer,
} from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';

type RelatedItem = {
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
};

function RelatedRow({ href, item }: { href: string; item: RelatedItem }) {
  return (
    <Link href={href} className="flex gap-2.5 px-4 py-3 transition-colors hover:bg-accent">
      {item.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.iconUrl}
          alt=""
          width={20}
          height={20}
          loading="lazy"
          className="mt-0.5 size-5 shrink-0 rounded object-cover"
        />
      ) : (
        <span aria-hidden="true" className="mt-0.5 size-5 shrink-0 rounded bg-muted" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
        {item.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>
        ) : null}
      </span>
    </Link>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const [{ slug }, t] = await Promise.all([params, getTranslations('server')]);
  const server = await getPublicServer(slug);
  if (!server) {
    return siteMetadata({
      title: `Page not found | ${SITE.name}`,
      description: t('browseEveryModelContextProtocolServerInTheDirectory'),
      path: `/server/${encodeURIComponent(slug)}`,
      index: false,
    });
  }
  return siteMetadata({
    title: `${server.name} MCP Server | ${SITE.name}`,
    description: server.description ?? t('defaultDescription', { name: server.name }),
    path: `/server/${encodeURIComponent(server.slug)}`,
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [t, common] = await Promise.all([
    getTranslations('server'),
    getTranslations('common'),
  ]);
  const { slug } = await params;
  const server = await getPublicServer(slug);
  if (!server) notFound();

  const categoryIds = server.categories.map((category) => category.id);
  const [related, relatedSkills] = await Promise.all([
    getPublicRelatedServers(server.id, categoryIds, 4),
    getPublicRelatedSkills(categoryIds, 3),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label={common('breadcrumb')}>
        <Link href="/" className="transition-colors hover:text-foreground">{t('home')}</Link>
        <ChevronRight className="size-3.5" />
        <Link href="/server" className="transition-colors hover:text-foreground">{t('servers')}</Link>
        <ChevronRight className="size-3.5" />
        <span className="truncate text-foreground" aria-current="page">{server.name}</span>
      </nav>

      <header className="mt-6">
        <h1 className="font-mono text-4xl font-bold tracking-tight text-foreground sm:text-5xl">{server.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {server.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={server.iconUrl} alt="" width={20} height={20} className="size-5 rounded-full object-cover" />
          ) : null}
          {server.author ? <span>{server.author}</span> : null}
          <span className="inline-flex items-center gap-1">
            <Star className="size-4" aria-hidden="true" />
            {server.stars.toLocaleString()}
          </span>
        </div>
        {server.categories.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {server.categories.map((category) => (
              <Link key={category.id} href={`/categories/${category.slug}`} className="ui-chip">
                {category.name}
              </Link>
            ))}
          </div>
        ) : null}
        {server.description ? (
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-foreground">{server.description}</p>
        ) : null}
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <div className="border-b border-border pb-2">
            <h2 className="inline border-b-2 border-foreground pb-2 text-sm font-medium text-foreground">{t('about')}</h2>
          </div>
          <p className="mt-5 text-base leading-relaxed text-foreground">
            {server.description ?? t('defaultDescription', { name: server.name })}
          </p>
          <section className="mt-8 rounded-lg border border-border bg-card p-5">
            <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-foreground">
              {server.deployable ? t('deployAmpConnect') : t('deploymentUnavailable')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {server.deployable
                ? t('workspaceDeployDescription', { name: server.name })
                : t('deploymentUnavailableDescription')}
            </p>
            {server.deployable ? (
              <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground">
{`POST /api/v1/mcp/<deployment-id>/rpc
Authorization: Bearer <your-api-token>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}`}
              </pre>
            ) : null}
          </section>
        </div>

        <aside className="min-w-0 space-y-6">
          <div className="rounded-lg border border-border bg-card p-4">
            <Link
              href={server.deployable
                ? `/app?server=${encodeURIComponent(server.slug)}`
                : `/app?market=mcp&q=${encodeURIComponent(server.slug)}`}
              className="ui-button-primary flex min-h-10 w-full"
            >
              {server.deployable ? t('signInToRunOnToolplane') : t('browseDeployableServers')}
            </Link>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {server.deployable ? t('oneclickCloudHosting') : t('verifiedRecipesOnly')}
            </p>
          </div>

          {related.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{t('relatedMcps')}</h2>
                <Link href="/server" className="text-xs text-muted-foreground hover:text-foreground">{t('viewMore')}</Link>
              </div>
              <div className="divide-y divide-border">
                {related.map((item) => <RelatedRow key={item.slug} href={`/server/${item.slug}`} item={item} />)}
              </div>
            </div>
          ) : null}

          {relatedSkills.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{t('relatedSkills')}</h2>
                <Link href="/tools/skills" className="text-xs text-muted-foreground hover:text-foreground">{t('viewAll')}</Link>
              </div>
              <div className="divide-y divide-border">
                {relatedSkills.map((item) => (
                  <RelatedRow key={item.slug} href={`/tools/skills/${item.slug}`} item={item} />
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
