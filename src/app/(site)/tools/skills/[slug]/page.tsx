import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getSkill } from '@/lib/queries/skills';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const skill = await getSkill(slug);
  if (!skill) notFound();

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center gap-3">
        {skill.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={skill.iconUrl}
            alt={skill.author ?? skill.name}
            width={40}
            height={40}
            className="size-10 rounded-full object-cover"
          />
        ) : null}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {skill.name}
          </h1>
          {skill.author ? (
            <p className="text-sm text-muted-foreground">{skill.author}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Star className="size-4" />
          {skill.score.toLocaleString()}
        </span>
      </div>

      {skill.description ? (
        <p className="mt-6 text-base leading-relaxed text-foreground">
          {skill.description}
        </p>
      ) : null}
    </article>
  );
}
