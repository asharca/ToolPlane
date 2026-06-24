import Link from 'next/link';
import { ChevronRight, Trophy } from 'lucide-react';
import { listServers } from '@/lib/queries/servers';
import { ServerCard } from '@/components/cards/ServerCard';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { items } = await listServers({ page: 1, pageSize: 100 });

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-foreground">
          Home
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">Leaderboard</span>
      </nav>

      <header className="mt-6">
        <h1 className="flex items-center gap-3 font-mono text-4xl font-bold tracking-tight sm:text-6xl">
          <Trophy className="size-8 shrink-0 text-muted-foreground sm:size-10" />
          <span>
            <span className="text-foreground">Top 100</span>{' '}
            <span className="text-muted-foreground">MCP Servers</span>
          </span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
          The most popular Model Context Protocol servers, ranked by GitHub
          stars.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Also explore:{' '}
          <Link href="/daily" className="text-foreground hover:underline">
            Top MCPs Today
          </Link>{' '}
          <span className="text-border">·</span>{' '}
          <Link href="/server" className="text-foreground hover:underline">
            Browse All
          </Link>
        </p>
      </header>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((server, i) => (
          <ServerCard key={server.slug} server={server} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}
