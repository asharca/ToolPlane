import { getTranslations } from 'next-intl/server';
import { listSkills } from '@/lib/queries/skills';
import { RankedList } from '@/components/RankedList';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const t = await getTranslations('daily');
  const skills = await listSkills();
  return (
    <RankedList
      title={t('topSkillsToday')}
      subtitle={t('theMostPopularAgentSkillsRightNow')}
      items={skills.map((s) => ({
        slug: s.slug,
        name: s.name,
        author: s.author,
        iconUrl: s.iconUrl,
        href: `/tools/skills/${s.slug}`,
        stat: s.score,
      }))}
    />
  );
}
