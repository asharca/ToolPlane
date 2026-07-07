import { getTranslations } from 'next-intl/server';
import { listSkills } from '@/lib/queries/skills';
import { listCategories } from '@/lib/queries/categories';
import { SkillCard } from '@/components/cards/SkillCard';
import { ListingHero } from '@/components/ListingHero';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const t = await getTranslations('skills');
  const [skills, categories] = await Promise.all([
    listSkills(),
    listCategories(),
  ]);
  return (
    <div className="mx-auto max-w-screen-xl px-4">
      <ListingHero
        lead={t('browseAll')}
        tail={t('agentSkills')}
        subtitle={t('discoverAgentSkillsYouCanInstallIntoYourWorkspace')}
        placeholder={t('searchForAgentSkills')}
        categories={categories.map((c) => ({ slug: c.slug, name: c.name }))}
      />
      <div className="pb-14">
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSkillsYet')}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => (
              <SkillCard key={skill.slug} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
