import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Star, ChevronRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getServer, getRelatedServers } from '@/lib/queries/servers';
import { getRelatedSkills } from '@/lib/queries/skills';
import { getCurrentUser } from '@/lib/auth/current-user';

export const dynamic = 'force-dynamic';

type RelatedItem = {
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
};

function RelatedRow({ href, item }: { href: string; item: RelatedItem }) {
  return (
    <Link
      href={href}
      className="flex gap-2.5 px-4 py-3 transition-colors hover:bg-accent"
    >
      {item.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.iconUrl}
          alt=""
          width={20}
          height={20}
          className="mt-0.5 size-5 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="mt-0.5 size-5 shrink-0 rounded bg-muted" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {item.name}
        </span>
        {item.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {item.description}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await getTranslations('server');
  const { slug } = await params;
  const server = await getServer(slug);
  if (!server) notFound();

  const user = await getCurrentUser();
  const categoryIds = server.categories.map((c) => c.id);
  const [related, relatedSkills] = await Promise.all([
    getRelatedServers(server.id, categoryIds, 4),
    getRelatedSkills(categoryIds, 3),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-foreground">
          {t('home')}
        </Link>
        <ChevronRight className="size-3.5" />
        <Link href="/server" className="transition-colors hover:text-foreground">
          {t('servers')}
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">{server.name}</span>
      </nav>

      <header className="mt-6">
        <h1 className="font-mono text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          {server.name}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {server.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={server.iconUrl}
              alt={server.author ?? server.name}
              width={20}
              height={20}
              className="size-5 rounded-full object-cover"
            />
          ) : null}
          {server.author ? <span>by {server.author}</span> : null}
          <span className="text-border">·</span>
          <span className="inline-flex items-center gap-1">
            <Star className="size-4" />
            {server.stars.toLocaleString()}
          </span>
        </div>

        {server.categories.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {server.categories.map((category) => (
              <Link
                key={category.id}
                href={`/categories/${category.slug}`}
                className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent"
              >
                {category.name}
              </Link>
            ))}
          </div>
        ) : null}

        {server.description ? (
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-foreground">
            {server.description}
          </p>
        ) : null}
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="border-b border-border pb-2">
            <span className="border-b-2 border-foreground pb-2 text-sm font-medium text-foreground">
              About
            </span>
          </div>
          <p className="mt-5 text-base leading-relaxed text-foreground">
            {server.description ??
              `${server.name} is a Model Context Protocol server you can deploy to your workspace.`}
          </p>

          <section className="mt-8 rounded-lg border border-border bg-card p-5">
            <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-foreground">
              Deploy &amp; connect
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Deploy {server.name} to a workspace, then reach it over JSON-RPC
              through the ToolPlane gateway with your API token.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground">
{`POST /api/v1/mcp/<deployment-id>/rpc
Authorization: Bearer <your-api-token>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}`}
            </pre>
          </section>
        </div>

        <aside className="space-y-6">
          <div className="rounded-lg border border-border bg-card p-4">
            {!user ? (
              <Link
                href={`/app/login?next=${encodeURIComponent(`/server/${server.slug}`)}`}
                className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Sign in to run on ToolPlane
              </Link>
            ) : (
              <Link
                href="/app"
                className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Open dashboard
              </Link>
            )}
            <p className="mt-2 text-center text-xs text-muted-foreground">
              One-click cloud hosting
            </p>
          </div>

          {related.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  Related MCPs
                </h2>
                <Link
                  href="/server"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  View more
                </Link>
              </div>
              <div className="divide-y divide-border">
                {related.map((r) => (
                  <RelatedRow key={r.slug} href={`/server/${r.slug}`} item={r} />
                ))}
              </div>
            </div>
          ) : null}

          {relatedSkills.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {t('relatedSkills')}
                </h2>
                <Link
                  href="/tools/skills"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  View all
                </Link>
              </div>
              <div className="divide-y divide-border">
                {relatedSkills.map((r) => (
                  <RelatedRow
                    key={r.slug}
                    href={`/tools/skills/${r.slug}`}
                    item={r}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
