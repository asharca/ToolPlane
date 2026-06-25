import Link from 'next/link';
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

      {skill.categories.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {skill.categories.map((category) => (
            <Link
              key={category.id}
              href={`/categories/${category.slug}`}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
            >
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      <section className="mt-10 rounded-lg border border-border bg-card p-5">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-foreground">
          Install this skill
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Install {skill.name} into a workspace, then export it as a
          ready-to-use <code className="font-mono">SKILL.md</code> for your agent.
        </p>
        <Link
          href="/app"
          className="mt-3 inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          Open dashboard
        </Link>
      </section>
    </article>
  );
}
