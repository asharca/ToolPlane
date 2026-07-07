import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getClient } from '@/lib/queries/clients';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await getTranslations('client');
  const { slug } = await params;
  const client = await getClient(slug);
  if (!client) notFound();

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center gap-3">
        {client.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={client.iconUrl}
            alt={client.author ?? client.name}
            width={40}
            height={40}
            className="size-10 rounded-full object-cover"
          />
        ) : null}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {client.name}
          </h1>
          {client.author ? (
            <p className="text-sm text-muted-foreground">{client.author}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Star className="size-4" />
          {client.stars.toLocaleString()}
        </span>
      </div>

      {client.description ? (
        <p className="mt-6 text-base leading-relaxed text-foreground">
          {client.description}
        </p>
      ) : null}

      {client.categories.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {client.categories.map((category) => (
            <Link
              key={category.id}
              href={`/categories/${category.slug}`}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
            >
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      <section className="mt-10 rounded-lg border border-border bg-card p-5">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-foreground">
          Use {client.name} with MCP servers
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {client.name} speaks the Model Context Protocol. Browse the directory to
          find MCP servers it can connect to.
        </p>
        <Link
          href="/server"
          className="mt-3 inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          {t('browseMcpServers')}
        </Link>
      </section>
    </article>
  );
}
