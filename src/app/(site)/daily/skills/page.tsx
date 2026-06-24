import { listSkills } from '@/lib/queries/skills';
import { RankedList } from '@/components/RankedList';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const skills = await listSkills();
  return (
    <RankedList
      title="Top Agent Skills Today"
      subtitle="The most popular agent skills right now"
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
