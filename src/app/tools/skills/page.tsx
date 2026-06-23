import { listSkills } from '@/lib/queries/skills';
import { SkillCard } from '@/components/cards/SkillCard';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const skills = await listSkills();
  return (
    <div className="mx-auto max-w-screen-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        Agent Skills
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {skills.length.toLocaleString()} skills
      </p>
      {skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <SkillCard key={skill.slug} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}
