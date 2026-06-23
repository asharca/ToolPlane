import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Star } from 'lucide-react';
import { getServer } from '@/lib/queries/servers';
import { getCurrentUser } from '@/lib/auth/current-user';
import { isInHub } from '@/lib/hub/queries';
import { addToHubAction, removeFromHubAction } from '@/lib/hub/actions';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const server = await getServer(slug);
  if (!server) notFound();

  const user = await getCurrentUser();
  const inHub = user ? await isInHub(user.id, server.id) : false;

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

      <div className="mt-6">
        {!user ? (
          <Link
            href="/login"
            className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Sign in to add to Hub
          </Link>
        ) : inHub ? (
          <form action={removeFromHubAction}>
            <input type="hidden" name="serverId" value={server.id} />
            <input type="hidden" name="slug" value={server.slug} />
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Remove from Hub
            </button>
          </form>
        ) : (
          <form action={addToHubAction}>
            <input type="hidden" name="serverId" value={server.id} />
            <input type="hidden" name="slug" value={server.slug} />
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Add to Hub
            </button>
          </form>
        )}
      </div>

      {server.description ? (
        <p className="mt-6 text-base leading-relaxed text-foreground">
          {server.description}
        </p>
      ) : null}

      {server.categories.length > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {server.categories.map((category) => (
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
    </article>
  );
}
