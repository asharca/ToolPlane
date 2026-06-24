import type { Server } from '@prisma/client';
import { EntityCard, StarStat } from './EntityCard';

type ServerCardData = Pick<
  Server,
  'slug' | 'name' | 'description' | 'author' | 'iconUrl' | 'stars'
> & { categories?: { name: string }[] };

export function ServerCard({
  server,
  rank,
}: {
  server: ServerCardData;
  rank?: number;
}) {
  return (
    <EntityCard
      href={`/server/${server.slug}`}
      name={server.name}
      description={server.description}
      author={server.author}
      iconUrl={server.iconUrl}
      category={server.categories?.[0]?.name ?? null}
      stat={<StarStat value={server.stars} />}
      rank={rank}
    />
  );
}
