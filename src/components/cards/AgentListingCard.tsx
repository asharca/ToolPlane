import { Copy } from 'lucide-react';
import { SITE } from '@/lib/site';
import { EntityCard, formatCount } from './EntityCard';

export type AgentListingCardData = {
  id: string;
  slug: string;
  directorySlug: string;
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
  const href = agent.publisherWorkspace
    ? `/agents/${encodeURIComponent(agent.publisherWorkspace.slug)}/${encodeURIComponent(agent.slug)}`
    : `/agents/${encodeURIComponent(agent.directorySlug)}`;

  return (
    <EntityCard
      href={href}
      name={agent.name}
      description={agent.summary}
      author={agent.author ?? agent.publisherWorkspace?.name ?? SITE.name}
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
