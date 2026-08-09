import { Copy } from 'lucide-react';
import { EntityCard, formatCount } from './EntityCard';

export type AgentListingCardData = {
  id: string;
  slug: string;
  name: string;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  installCount: number;
  categories: { name: string }[];
  publisherWorkspace: { slug: string; name: string } | null;
};

export function AgentListingCard({
  agent,
  installLabel,
}: {
  agent: AgentListingCardData;
  installLabel: string;
}) {
  if (!agent.publisherWorkspace) return null;

  return (
    <EntityCard
      href={`/agents/${encodeURIComponent(agent.publisherWorkspace.slug)}/${encodeURIComponent(agent.slug)}`}
      name={agent.name}
      description={agent.summary}
      author={agent.author ?? agent.publisherWorkspace.name}
      iconUrl={agent.iconUrl}
      category={agent.categories[0]?.name ?? null}
      stat={
        <span className="flex items-center font-mono text-xs text-muted-foreground">
          <Copy aria-hidden="true" className="mr-1 size-3" />
          <span aria-hidden="true">{formatCount(agent.installCount)}</span>
          <span className="sr-only">{installLabel}: {agent.installCount.toLocaleString()}</span>
        </span>
      }
    />
  );
}
