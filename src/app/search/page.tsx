import type { ReactNode } from 'react';
import { searchAll } from '@/lib/queries/search';
import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';

export const dynamic = 'force-dynamic';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold tracking-tight text-foreground">
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
  const { q = '' } = await searchParams;
  const query = q.trim();
  const { servers, clients, skills } = query
    ? await searchAll(query)
    : { servers: [], clients: [], skills: [] };
  const total = servers.length + clients.length + skills.length;

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="mb-4 text-2xl font-bold tracking-tight text-foreground">
        Search
      </h1>

      <form action="/search" className="mb-8 flex max-w-xl items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search MCP servers, skills, clients…"
          aria-label="Search"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          className="inline-flex h-10 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Search
        </button>
      </form>

      {query === '' ? (
        <p className="text-sm text-muted-foreground">
          Enter a search term to find MCP servers, clients, and agent skills.
        </p>
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">
          No results for “{query}”.
        </p>
      ) : (
        <div className="space-y-10">
          {servers.length > 0 ? (
            <Section title="MCP Servers">
              {servers.map((s) => (
                <ServerCard key={s.slug} server={s} />
              ))}
            </Section>
          ) : null}
          {clients.length > 0 ? (
            <Section title="MCP Clients">
              {clients.map((c) => (
                <ClientCard key={c.slug} client={c} />
              ))}
            </Section>
          ) : null}
          {skills.length > 0 ? (
            <Section title="Agent Skills">
              {skills.map((k) => (
                <SkillCard key={k.slug} skill={k} />
              ))}
            </Section>
          ) : null}
        </div>
      )}
    </div>
  );
}
