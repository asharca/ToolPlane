import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, Trophy } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ServerCard } from '@/components/cards/ServerCard';
import { SITE } from '@/lib/site';
import { listPublicServers } from '../_lib/catalog';
import { siteMetadata } from '../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('leaderboards');
  return siteMetadata({
    title: `${t('top100')} ${t('mcpServers')} | ${SITE.name}`,
    description: t('theMostPopularModelContextProtocolServersRankedByGithubStars'),
    path: '/leaderboards',
  });
}

export default async function Page() {
  const [t, common, result] = await Promise.all([
    getTranslations('leaderboards'),
    getTranslations('common'),
    listPublicServers(1, 100),
  ]);

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label={common('breadcrumb')}>
        <Link href="/" className="transition-colors hover:text-foreground">{t('home')}</Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground" aria-current="page">{t('leaderboard')}</span>
      </nav>
      <header className="mt-6">
        <h1 className="flex items-center gap-3 font-mono text-4xl font-bold tracking-tight sm:text-6xl">
          <Trophy className="size-8 shrink-0 text-muted-foreground sm:size-10" />
          <span>{t('top100')} <span className="text-muted-foreground">{t('mcpServers')}</span></span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">{t('theMostPopularModelContextProtocolServersRankedByGithubStars')}</p>
      </header>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {result.items.map((server, index) => <ServerCard key={server.slug} server={server} rank={index + 1} statLabel={common('stars')} />)}
      </div>
    </div>
  );
}
