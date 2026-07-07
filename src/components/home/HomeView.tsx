import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeSections } from '@/lib/queries/home';
import { ServerCard } from '@/components/cards/ServerCard';
import { ClientCard } from '@/components/cards/ClientCard';
import { SkillCard } from '@/components/cards/SkillCard';
import { FaqSection } from '@/components/home/FaqSection';
import { RotatingHeadline } from '@/components/home/RotatingHeadline';

type Category = { slug: string; name: string };

type HomeViewProps = HomeSections & {
  categories: Category[];
  serverCount: number;
};

function SectionGrid({
  title,
  viewAllHref,
  viewAllLabel,
  badge,
  children,
}: {
  title: string;
  viewAllHref: string;
  viewAllLabel: string;
  badge?: { label: string; href: string };
  children: ReactNode;
}) {
  const [first, ...rest] = title.split(' ');
  return (
    <section className="py-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            <span className="text-muted-foreground">{first}</span>{' '}
            <span className="text-foreground">{rest.join(' ')}</span>
          </h2>
          {badge ? (
            <Link
              href={badge.href}
              className="ui-chip hidden min-h-0 px-2 py-1 font-mono text-[10px] uppercase tracking-wider sm:inline-flex"
            >
              {badge.label}
            </Link>
          ) : null}
        </div>
        <Link
          href={viewAllHref}
          className="ui-button-secondary shrink-0"
        >
          {viewAllLabel}
          <ArrowRight className="size-4" />
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

function CategoryChip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`ui-chip ${active ? 'ui-chip-active' : ''}`}
    >
      {label}
    </Link>
  );
}

export function HomeView({
  officialServers,
  featuredServers,
  topServers,
  latestServers,
  clients,
  topSkills,
  categories,
  serverCount,
}: HomeViewProps) {
  const t = useTranslations('home');
  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <section className="relative py-16 sm:py-24">
        <div className="pointer-events-none absolute inset-0 hero-grid" aria-hidden />
        <div className="relative text-center">
          <div className="ui-panel mx-auto mb-6 inline-flex items-center gap-2 px-3 py-1 text-sm">
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <span className="size-2 rounded-full bg-brand" />
              <strong className="font-semibold">
                {serverCount.toLocaleString()}
              </strong>{' '}
              {t('servers')}
            </span>
            <span className="text-border">|</span>
            <span className="text-muted-foreground">{t('updatedJustNow')}</span>
          </div>

          <h1 className="mx-auto max-w-4xl text-balance text-5xl font-black tracking-tight sm:text-7xl">
            <span className="sr-only">
              {t('findTheBestMcpServersAgentSkillsMcpClientsAgentTools')}
            </span>
            <span aria-hidden className="text-foreground">
              {t('findTheBest')}
              <br />
              <RotatingHeadline />
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
            {t('directoryOfAwesomeMcpServersAndClientsToConnectAiAgentsWithYourFavoriteTools')}
          </p>

          <form action="/search" className="relative mx-auto mt-8 max-w-2xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              name="q"
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAriaLabel')}
              className="ui-input ui-input-search bg-card"
            />
          </form>

          <div className="no-scrollbar mx-auto mt-5 flex max-w-3xl gap-2 overflow-x-auto pb-1">
            <CategoryChip href="/categories" label={t('allCategories')} active />
            {categories.map((c) => (
              <CategoryChip
                key={c.slug}
                href={`/categories/${c.slug}`}
                label={c.name}
              />
            ))}
          </div>
        </div>
      </section>

      <SectionGrid
        title={t('officialServers')}
        viewAllHref="/categories/official"
        viewAllLabel={t('viewAllOfficialServers')}
      >
        {officialServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('featuredServers')}
        viewAllHref="/categories/featured"
        viewAllLabel={t('viewAllFeaturedServers')}
      >
        {featuredServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('topServers')}
        viewAllHref="/leaderboards"
        viewAllLabel={t('viewLeaderboard')}
      >
        {topServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('latestServers')}
        viewAllHref="/server"
        viewAllLabel={t('viewAllNewServers')}
      >
        {latestServers.map((s) => (
          <ServerCard key={s.slug} server={s} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('mcpClients')}
        viewAllHref="/client"
        viewAllLabel={t('viewAllClients')}
      >
        {clients.map((c) => (
          <ClientCard key={c.slug} client={c} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('topAgentSkills')}
        viewAllHref="/tools/skills"
        viewAllLabel={t('viewAllSkills')}
        badge={{ label: 'What are Agent Skills?', href: '/tools/skills' }}
      >
        {topSkills.map((k) => (
          <SkillCard key={k.slug} skill={k} />
        ))}
      </SectionGrid>

      <FaqSection />
    </div>
  );
}
