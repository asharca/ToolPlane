import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, Server } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ServerCard } from '@/components/cards/ServerCard';
import { SITE } from '@/lib/site';
import { listPublicServers } from '../_lib/catalog';
import { siteMetadata } from '../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('daily');
  return siteMetadata({
    title: `${t('daily')} ${t('mcpServerLists')} | ${SITE.name}`,
    description: t('todayapossMostPopularModelContextProtocolServersRankedByGithubStars'),
    path: '/daily',
  });
}

export default async function Page() {
  const [t, common, result] = await Promise.all([
    getTranslations('daily'),
    getTranslations('common'),
    listPublicServers(1, 30),
  ]);
  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label={common('breadcrumb')}>
        <Link href="/" className="transition-colors hover:text-foreground">{t('home')}</Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground" aria-current="page">{t('dailyMcpServerLists')}</span>
      </nav>
      <header className="mt-6">
        <h1 className="font-mono text-4xl font-bold tracking-tight sm:text-6xl">
          {t('daily')} <span className="text-muted-foreground">{t('mcpServerLists')}</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">{t('todayapossMostPopularModelContextProtocolServersRankedByGithubStars')}</p>
      </header>
      <section className="mt-8">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
          <Server className="size-5 text-muted-foreground" /> {t('mcpServers')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.items.map((server, index) => <ServerCard key={server.slug} server={server} rank={index + 1} statLabel={common('stars')} />)}
        </div>
      </section>
    </div>
  );
}
