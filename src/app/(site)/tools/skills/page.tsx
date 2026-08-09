import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { SkillCard } from '@/components/cards/SkillCard';
import { ListingHero } from '@/components/ListingHero';
import { Pagination } from '@/components/Pagination';
import { getMarketingContent } from '@/lib/marketing/content';
import { SITE } from '@/lib/site';
import {
  getPublicSkillCount,
  listPublicCategories,
  listPublicSkills,
} from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';
import { publicPageNumber } from '../../_lib/pagination';

const PAGE_SIZE = 30;
type SearchParams = { page?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const [params, locale] = await Promise.all([searchParams, getLocale()]);
  const page = publicPageNumber(params.page);
  const capability = getMarketingContent(locale).capabilities.skills;
  return siteMetadata({
    title: page && page > 1
      ? `${capability.eyebrow} — ${page} | ${SITE.name}`
      : `${capability.eyebrow} | ${SITE.name}`,
    description: capability.description,
    path: page && page > 1 ? `/tools/skills?page=${page}` : '/tools/skills',
    index: page !== null,
  });
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = publicPageNumber(params.page);
  if (!page) notFound();
  if (params.page !== undefined && page === 1) permanentRedirect('/tools/skills');
  const [t, common, total, categories] = await Promise.all([
    getTranslations('skills'),
    getTranslations('common'),
    getPublicSkillCount(),
    listPublicCategories(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) notFound();
  const { items: skills } = await listPublicSkills(page, PAGE_SIZE);

  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <ListingHero
        lead={t('browseAll')}
        tail={t('agentSkills')}
        subtitle={t('discoverAgentSkillsYouCanInstallIntoYourWorkspace')}
        placeholder={t('searchForAgentSkills')}
        categories={categories.map(({ slug, name }) => ({ slug, name }))}
      />
      <div className="pb-14">
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSkillsYet')}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => <SkillCard key={skill.slug} skill={skill} statLabel={common('score')} />)}
          </div>
        )}
        <Pagination
          page={page}
          totalPages={totalPages}
          hrefForPage={(value) => (
            value === 1 ? '/tools/skills' : `/tools/skills?page=${value}`
          )}
        />
      </div>
    </div>
  );
}
