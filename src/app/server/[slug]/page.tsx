import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getServer } from '@/lib/queries/servers';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const server = await getServer(slug);
  if (!server) notFound();

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center gap-3">
        {server.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={server.iconUrl}
            alt={server.author ?? server.name}
            width={40}
            height={40}
            className="size-10 rounded-full object-cover"
          />
        ) : null}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {server.name}
          </h1>
          {server.author ? (
            <p className="text-sm text-muted-foreground">{server.author}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Star className="size-4" />
          {server.stars.toLocaleString()}
        </span>
      </div>

      {server.description ? (
        <p className="mt-6 text-base leading-relaxed text-foreground">
          {server.description}
        </p>
      ) : null}

      {server.categories.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {server.categories.map((category) => (
            <span
              key={category.id}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground"
            >
              {category.name}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
