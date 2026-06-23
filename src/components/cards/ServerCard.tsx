import type { Server } from '@prisma/client';
import { EntityCard, StarStat } from './EntityCard';

type ServerCardData = Pick<
  Server,
  'slug' | 'name' | 'description' | 'author' | 'iconUrl' | 'stars'
>;

export function ServerCard({ server }: { server: ServerCardData }) {
  return (
    <EntityCard
      href={`/server/${server.slug}`}
      name={server.name}
      description={server.description}
      author={server.author}
      iconUrl={server.iconUrl}
      stat={<StarStat value={server.stars} />}
    />
  );
}
