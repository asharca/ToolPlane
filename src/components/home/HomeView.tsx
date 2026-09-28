import { ArrowDown, ArrowRight, ArrowUpRight, Bot, Layers3, Search, Server, Sparkles, Star } from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import { useLocale, useTranslations } from 'next-intl';
import type { HomeSections } from '@/lib/queries/home';
import { SITE } from '@/lib/site';
import { FaqSection } from '@/components/home/FaqSection';
import { RotatingHeadline } from '@/components/home/RotatingHeadline';
import { Button, ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { TiltCard } from '@/components/motion/tilt-card';
import { ShaderBackground } from '@/components/motion/shader-background';

type HomeViewProps = HomeSections & {
  categories: { slug: string; name: string }[];
  serverCount: number;
};

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
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const headlineWords = [t('headlineMcpServers'), t('headlineAgentSkills'), t('headlineMcpClients'), t('headlineAgentTools')];
  const capabilities = [
    { icon: Server, title: t('headlineMcpServers'), description: t('connectTools'), href: '/server' },
    { icon: Sparkles, title: t('headlineAgentSkills'), description: t('teachSkills'), href: '/tools/skills' },
    { icon: Bot, title: t('agents'), description: t('launchAgents'), href: '/agents' },
  ];
  const collections = [
    { id: 'official', label: t('tabOfficial'), title: t('officialServers'), href: '/server', link: t('viewAllOfficialServers'), path: '/server', items: officialServers, icon: Server },
    { id: 'featured', label: t('tabFeatured'), title: t('featuredServers'), href: '/server', link: t('viewAllFeaturedServers'), path: '/server', items: featuredServers, icon: Server },
    { id: 'top', label: t('tabPopular'), title: t('topServers'), href: '/leaderboards', link: t('viewLeaderboard'), path: '/server', items: topServers, icon: Server },
    { id: 'latest', label: t('tabLatest'), title: t('latestServers'), href: '/server', link: t('viewAllNewServers'), path: '/server', items: latestServers, icon: Server },
    { id: 'skills', label: t('headlineAgentSkills'), title: t('topAgentSkills'), href: '/tools/skills', link: t('viewAllSkills'), path: '/tools/skills', items: topSkills, icon: Sparkles },
    { id: 'clients', label: t('headlineMcpClients'), title: t('mcpClients'), href: '/client', link: t('viewAllClients'), path: '/client', items: clients, icon: Layers3 },
  ];

  return (
    <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-12">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <ShaderBackground
          variant="metaballs"
          colors={["#c4b5fd", "#818cf8", "#38bdf8", "#f0abfc"]}
          colorBack="#00000000"
          speed={0.25}
          className="opacity-30"
        />
      </div>
      <section className="grid items-center gap-12 pb-14 pt-12 sm:pb-20 sm:pt-20 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:pb-24 lg:pt-24">
        <div className="min-w-0">
          <h1 className="text-balance text-[clamp(2.75rem,6.6vw,6rem)] font-semibold leading-[1.04] tracking-[-0.065em]">
            {t('heroTitle')}
            <span className="block text-primary">{t('heroAccent')}</span>
          </h1>
          <p className="mt-6 max-w-lg text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            {t('heroDescription')}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href="/app" size="lg">
              {t('openWorkspace')}
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </ButtonLink>
            <ButtonLink href="#discover" variant="outline" size="lg">
              {t('exploreCatalog')}
              <ArrowDown aria-hidden="true" className="size-4" />
            </ButtonLink>
          </div>
          <p className="mt-5 text-xs leading-5 text-muted-foreground">{t('heroNote')}</p>
        </div>

        <div className="relative min-w-0 text-foreground">
          <TiltCard max={6} className="border border-border bg-card p-6 sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs tracking-widest text-muted-foreground">TOOLPLANE / 01</span>
              <AnimatedBadge size="sm" status="info" showIcon={false}>{t('ecosystem')}</AnimatedBadge>
            </div>
            <div className="py-10 sm:py-12">
              <p className="mb-3 text-sm text-muted-foreground">{t('oneWorkspace')}</p>
              <div className="min-h-10 text-2xl font-semibold tracking-tight sm:text-3xl">
                <span className="sr-only">{t('findTheBestMcpServersAgentSkillsMcpClientsAgentTools')}</span>
                <span aria-hidden="true">
                  <RotatingHeadline key={headlineWords.join('|')} words={headlineWords} />
                </span>
              </div>
            </div>
            <div className="space-y-3">
              {capabilities.map(({ icon: Icon, title, description, href }, index) => (
                <div key={href} className="flex items-center gap-4 border-t border-border pt-4">
                  <Icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
                  </div>
                  <ButtonLink href={href} variant="ghost" size="icon" aria-label={title}>
                    <ArrowUpRight aria-hidden="true" className="size-4" />
                  </ButtonLink>
                  <span aria-hidden="true" className="hidden font-mono text-[10px] text-muted-foreground sm:block">0{index + 1}</span>
                </div>
              ))}
            </div>
          </TiltCard>
        </div>
      </section>

      <section id="discover" aria-labelledby="discover-heading" className="scroll-mt-24 border-t border-border py-12 sm:py-16">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div>
            <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('discoveryEyebrow')}</p>
            <h2 id="discover-heading" className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">{t('discoveryTitle')}</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              <strong className="font-medium text-foreground">{serverCount.toLocaleString(locale)}</strong> {t('catalogCount')}
            </p>
          </div>
          <form action="/search" method="get" role="search" className="flex w-full gap-2 lg:max-w-sm">
            <Input
              type="search"
              name="q"
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAriaLabel')}
              leftIcon={<Search aria-hidden="true" />}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="secondary" aria-label={t('searchAriaLabel')}>
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </form>
        </div>
        <nav aria-label={common('browseCategories')} className="mt-6 flex flex-wrap gap-2">
          <ButtonLink href="/categories" variant="ghost" size="sm">{t('allCategories')}</ButtonLink>
          {categories.map((category) => (
            <ButtonLink key={category.slug} href={`/categories/${category.slug}`} variant="ghost" size="sm">
              {category.name}
            </ButtonLink>
          ))}
        </nav>

        <Tabs defaultValue={collections.find((collection) => collection.items.length)?.id ?? 'official'} variant="underline" className="mt-8 min-w-0">
          <TabsList>
            {collections.map((collection) => (
              <TabsTrigger key={collection.id} value={collection.id}>{collection.label}</TabsTrigger>
            ))}
          </TabsList>
          {collections.map(({ id, title, href, link, path, items, icon: Icon }) => (
            <TabsContent key={id} value={id}>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 pt-3">
                <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
                <ButtonLink href={href} variant="ghost" size="sm">
                  {link}<ArrowRight aria-hidden="true" className="size-3.5" />
                </ButtonLink>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((item) => (
                  <TiltCard key={item.slug} max={4} glare={false} className="flex h-full flex-col border border-border bg-card p-5">
                    <div className="mb-5 flex items-center justify-between gap-3">
                      <Icon aria-hidden="true" className="size-5 text-primary" />
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Star aria-hidden="true" className="size-3" />
                        <span className="sr-only">{'score' in item ? common('score') : common('stars')}: </span>
                        {number.format('score' in item ? item.score : item.stars)}
                      </span>
                    </div>
                    <h4 className="break-words text-base font-semibold tracking-tight">{item.name}</h4>
                    {item.author && <p className="mt-1 truncate text-xs text-muted-foreground">{item.author}</p>}
                    <p className="mb-5 mt-3 line-clamp-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
                    <div className="mt-auto">
                      <ButtonLink href={`${path}/${item.slug}`} variant="outline" size="sm" aria-label={`${t('viewResource')}: ${item.name}`}>
                        {t('viewResource')}<ArrowUpRight aria-hidden="true" className="size-3.5" />
                      </ButtonLink>
                    </div>
                  </TiltCard>
                ))}
              </div>
              {items.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">{t('emptyCollection')}</p>}
            </TabsContent>
          ))}
        </Tabs>
      </section>

      <div className="mx-auto max-w-3xl border-t border-border">
        <FaqSection />
      </div>

      <section className="flex flex-col items-start justify-between gap-6 border-t border-border py-12 sm:flex-row sm:items-center sm:py-16">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('closingTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('closingDescription')}</p>
        </div>
        <ButtonLink href={SITE.sourceUrl} target="_blank" rel="noopener noreferrer" variant="outline">
          <FaGithub aria-hidden="true" className="size-4" />{t('viewSource')}
          <ArrowUpRight aria-hidden="true" className="size-4" />
        </ButtonLink>
      </section>
    </div>
  );
}
