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
  return (
    <section className="my-4 rounded-[14px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
            {title}
          </h2>
          {badge ? (
            <Link
              href={badge.href}
              className="hidden min-h-6 items-center rounded-md bg-brand-soft px-2 text-[11px] font-medium text-brand sm:inline-flex"
            >
              {badge.label}
            </Link>
          ) : null}
        </div>
        <Link
          href={viewAllHref}
          className="ui-button-ghost ui-button-sm shrink-0"
        >
          {viewAllLabel}
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
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
      className={`ui-chip snap-start ${active ? 'ui-chip-active' : ''}`}
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
  const common = useTranslations('common');
  const headlineWords = [
    t('headlineMcpServers'),
    t('headlineAgentSkills'),
    t('headlineMcpClients'),
    t('headlineAgentTools'),
  ];

  return (
    <div className="mx-auto max-w-screen-xl px-2 sm:px-3">
      <section className="relative mt-1 overflow-hidden rounded-[14px] border border-border/80 bg-card px-5 py-11 sm:mt-2 sm:px-8 sm:py-14">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 size-80 rounded-full bg-brand/10 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/35 to-transparent" />
        <div className="relative text-center">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-lg border border-brand/15 bg-brand-soft/70 px-2.5 py-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-brand shadow-[0_0_0_3px_hsl(var(--brand)/0.12)]" />
              <strong className="font-semibold">
                {serverCount.toLocaleString()}
              </strong>{' '}
              {t('servers')}
            </span>
            <span className="text-border">|</span>
            <span className="text-muted-foreground">{t('updatedJustNow')}</span>
          </div>

          <h1 className="mx-auto max-w-4xl text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">
            <span className="sr-only">
              {t('findTheBestMcpServersAgentSkillsMcpClientsAgentTools')}
            </span>
            <span aria-hidden className="text-foreground">
              {t('findTheBest')}
              <br />
              <RotatingHeadline key={headlineWords.join('|')} words={headlineWords} />
            </span>
          </h1>

          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            {t('directoryOfAwesomeMcpServersAndClientsToConnectAiAgentsWithYourFavoriteTools')}
          </p>

          <form action="/search" className="relative mx-auto mt-7 max-w-2xl">
            <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              name="q"
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAriaLabel')}
              className="ui-input ui-input-search !h-12 !pl-11 bg-background shadow-sm"
            />
          </form>

          <nav
            aria-label={common('browseCategories')}
            className="mx-auto mt-4 flex max-w-3xl snap-x gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:justify-center sm:overflow-visible"
          >
            <CategoryChip href="/categories" label={t('allCategories')} />
            {categories.map((c) => (
              <CategoryChip
                key={c.slug}
                href={`/categories/${c.slug}`}
                label={c.name}
              />
            ))}
          </nav>
        </div>
      </section>

      <SectionGrid
        title={t('officialServers')}
        viewAllHref="/server"
        viewAllLabel={t('viewAllOfficialServers')}
      >
        {officialServers.map((s) => (
          <ServerCard key={s.slug} server={s} statLabel={common('stars')} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('featuredServers')}
        viewAllHref="/server"
        viewAllLabel={t('viewAllFeaturedServers')}
      >
        {featuredServers.map((s) => (
          <ServerCard key={s.slug} server={s} statLabel={common('stars')} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('topServers')}
        viewAllHref="/leaderboards"
        viewAllLabel={t('viewLeaderboard')}
      >
        {topServers.map((s) => (
          <ServerCard key={s.slug} server={s} statLabel={common('stars')} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('latestServers')}
        viewAllHref="/server"
        viewAllLabel={t('viewAllNewServers')}
      >
        {latestServers.map((s) => (
          <ServerCard key={s.slug} server={s} statLabel={common('stars')} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('mcpClients')}
        viewAllHref="/client"
        viewAllLabel={t('viewAllClients')}
      >
        {clients.map((c) => (
          <ClientCard key={c.slug} client={c} statLabel={common('stars')} />
        ))}
      </SectionGrid>

      <SectionGrid
        title={t('topAgentSkills')}
        viewAllHref="/tools/skills"
        viewAllLabel={t('viewAllSkills')}
        badge={{ label: t('whatAreAgentSkills'), href: '/tools/skills' }}
      >
        {topSkills.map((k) => (
          <SkillCard key={k.slug} skill={k} statLabel={common('score')} />
        ))}
      </SectionGrid>

      <FaqSection />
    </div>
  );
}
