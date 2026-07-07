import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ChevronRight, Server } from 'lucide-react';
import { listServers } from '@/lib/queries/servers';
import { ServerCard } from '@/components/cards/ServerCard';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const t = await getTranslations('daily');
  const { items } = await listServers({ page: 1, pageSize: 30 });

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="transition-colors hover:text-foreground">
          {t('home')}
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">{t('dailyMcpServerLists')}</span>
      </nav>

      <header className="mt-6">
        <h1 className="font-mono text-4xl font-bold tracking-tight sm:text-6xl">
          <span className="text-foreground">{t('daily')}</span>{' '}
          <span className="text-muted-foreground">{t('mcpServerLists')}</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
          {t('todayapossMostPopularModelContextProtocolServersRankedByGithubStars')}
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          {t('alsoExplore')}{' '}
          <Link href="/daily/skills" className="text-foreground hover:underline">
            {t('dailySkills')}
          </Link>{' '}
          <span className="text-border">·</span>{' '}
          <Link href="/leaderboards" className="text-foreground hover:underline">
            {t('alltimeTop100')}
          </Link>{' '}
          <span className="text-border">·</span>{' '}
          <Link href="/server" className="text-foreground hover:underline">
            {t('browseAllServers')}
          </Link>
        </p>
      </header>

      <section className="mt-8">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
          <Server className="size-5 text-muted-foreground" />
          {t('mcpServers')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((server, i) => (
            <ServerCard key={server.slug} server={server} rank={i + 1} />
          ))}
        </div>
      </section>
    </div>
  );
}
