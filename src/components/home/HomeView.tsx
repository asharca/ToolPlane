import Link from 'next/link';
import type { ReactNode } from 'react';
import type { HomeSections } from '@/lib/queries/home';
import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';

function SectionGrid({
  title,
  viewAllHref,
  children,
}: {
  title: string;
  viewAllHref?: string;
  children: ReactNode;
}) {
  return (
    <section className="py-8">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            View all
          </Link>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

export function HomeView({
  officialServers,
  featuredServers,
  topServers,
  latestServers,
  clients,
  topSkills,
}: HomeSections) {
  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <section className="py-16 text-center sm:py-24">
        <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Find The Best MCP Servers - Agent Skills - MCP Clients - Agent Tools
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
          Discover and connect the Model Context Protocol ecosystem.
        </p>
        <form
          action="/search"
          className="mx-auto mt-8 flex max-w-md items-center gap-2"
        >
          <input
            type="search"
            name="q"
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
      </section>

      <SectionGrid title="Official MCP Servers" viewAllHref="/server">
        {officialServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid title="Featured MCP Servers" viewAllHref="/server">
        {featuredServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid title="Top MCP Servers" viewAllHref="/leaderboards">
        {topServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid title="Latest MCP Servers" viewAllHref="/server">
        {latestServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid title="MCP Clients" viewAllHref="/client">
        {clients.map((c) => (
          <ClientCard key={c.slug} client={c} />
        ))}
      </SectionGrid>

      <SectionGrid title="Top Agent Skills" viewAllHref="/tools/skills">
        {topSkills.map((k) => (
          <SkillCard key={k.slug} skill={k} />
        ))}
      </SectionGrid>
    </div>
  );
}
