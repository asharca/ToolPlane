import type { Client } from '@prisma/client';
import { EntityCard, StarStat } from './EntityCard';

type ClientCardData = Pick<
  Client,
  'slug' | 'name' | 'description' | 'author' | 'iconUrl' | 'stars'
> & { categories?: { name: string }[] };

export function ClientCard({ client }: { client: ClientCardData }) {
  return (
    <EntityCard
      href={`/client/${client.slug}`}
      name={client.name}
      description={client.description}
      author={client.author}
      iconUrl={client.iconUrl}
      category={client.categories?.[0]?.name ?? null}
      stat={<StarStat value={client.stars} />}
    />
  );
}
