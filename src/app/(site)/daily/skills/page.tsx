import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RankedList } from '@/components/RankedList';
import { SITE } from '@/lib/site';
import { listPublicTopSkills } from '../../_lib/catalog';
import { siteMetadata } from '../../_lib/metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('daily');
  return siteMetadata({
    title: `${t('topSkillsToday')} | ${SITE.name}`,
    description: t('theMostPopularAgentSkillsRightNow'),
    path: '/daily/skills',
  });
}

export default async function Page() {
  const [t, skills] = await Promise.all([
    getTranslations('daily'),
    listPublicTopSkills(),
  ]);
  return (
    <RankedList
      title={t('topSkillsToday')}
      subtitle={t('theMostPopularAgentSkillsRightNow')}
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
