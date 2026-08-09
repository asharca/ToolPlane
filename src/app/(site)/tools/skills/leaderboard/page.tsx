import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RankedList } from '@/components/RankedList';
import { SITE } from '@/lib/site';
import { listPublicTopSkills } from '../../../_lib/catalog';
import { siteMetadata } from '../../../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skills');
  return siteMetadata({
    title: `${t('top100Skills')} | ${SITE.name}`,
    description: t('rankedByScore'),
    path: '/tools/skills/leaderboard',
  });
}

export default async function Page() {
  const [t, skills] = await Promise.all([
    getTranslations('skills'),
    listPublicTopSkills(),
  ]);
  return (
    <RankedList
      title={t('top100Skills')}
      subtitle={t('rankedByScore')}
      statLabel={t('rankedByScore')}
      items={skills.map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        author: skill.author,
        iconUrl: skill.iconUrl,
        href: `/tools/skills/${skill.slug}`,
        stat: skill.score,
      }))}
    />
  );
}
