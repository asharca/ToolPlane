import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, Search } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { searchAll } from '@/lib/queries/search';
import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';

export const dynamic = 'force-dynamic';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 font-mono text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const t = await getTranslations('search');
  const { q = '' } = await searchParams;
  const query = q.trim();
  const { servers, clients, skills } = query
    ? await searchAll(query)
    : { servers: [], clients: [], skills: [] };
  const total = servers.length + clients.length + skills.length;

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-foreground">
          {t('home')}
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">
          {query ? `Search for "${query}"` : t('searchLabel')}
        </span>
      </nav>

      <form action="/search" className="relative mt-6 max-w-3xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search MCP servers, skills, and clients…"
          aria-label="Search"
          className="h-12 w-full border border-input bg-background pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </form>

      {query === '' ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Enter a search term to find MCP servers, clients, and agent skills.
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted-foreground">
            Search results for{' '}
            <span className="font-medium text-foreground">
              &ldquo;{query}&rdquo;
            </span>{' '}
            <span className="text-muted-foreground">({total})</span>
          </p>

          {total === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;.
            </p>
          ) : (
            <div className="mt-8 space-y-10">
              {servers.length > 0 ? (
                <Section title={t('servers')}>
                  {servers.map((s) => (
                    <ServerCard key={s.slug} server={s} />
                  ))}
                </Section>
              ) : null}
              {clients.length > 0 ? (
                <Section title={t('clients')}>
                  {clients.map((c) => (
                    <ClientCard key={c.slug} client={c} />
                  ))}
                </Section>
              ) : null}
              {skills.length > 0 ? (
                <Section title={t('skills')}>
                  {skills.map((k) => (
                    <SkillCard key={k.slug} skill={k} />
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
