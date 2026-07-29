import Link from 'next/link';
import {
  Bot,
  Boxes,
  Copy,
  Network,
  PackageCheck,
} from 'lucide-react';
import { formatCount } from '@/components/cards/EntityCard';

export type AgentMarketCardData = {
  slug: string;
  name: string;
  summary: string | null;
  workspaceName: string;
  workspaceSlug: string;
  tags: string[];
  cloneCount: number;
  model: string | null;
  agentCount: number;
  serverCount: number;
  skillCount: number;
};

export type AgentMarketCardLabels = {
  model: string;
  bringYourOwn: string;
  mcpSkills: string;
  clones: string;
};

function avatarLabel(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? 'A';
}

function detailHref(agent: AgentMarketCardData) {
  return `/agents/${encodeURIComponent(agent.workspaceSlug)}/${encodeURIComponent(agent.slug)}`;
}

export function FeaturedAgentCard({
  agent,
  labels,
}: {
  agent: AgentMarketCardData;
  labels: AgentMarketCardLabels;
}) {
  return (
    <Link
      href={detailHref(agent)}
      className="group relative grid min-h-72 overflow-hidden rounded-xl bg-foreground p-7 text-background transition-transform duration-200 ease-out hover:-translate-y-0.5 motion-reduce:transform-none sm:grid-cols-[minmax(0,1fr)_12rem] sm:p-8"
    >
      <div className="relative z-[1] flex min-w-0 flex-col">
        <span className="flex size-13 items-center justify-center rounded-xl bg-background text-xl font-bold text-foreground">
          {avatarLabel(agent.name)}
        </span>
        <div className="mt-auto pt-12">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.03em] text-background">
            {agent.name}
          </h2>
          {agent.summary ? (
            <p className="mt-3 max-w-2xl text-pretty text-sm leading-6 text-background/70">
              {agent.summary}
            </p>
          ) : null}
          <p className="mt-5 text-xs text-background/55">{agent.workspaceName}</p>
        </div>
      </div>

      <dl className="relative z-[1] mt-8 self-end sm:mt-0">
        <div className="flex items-center justify-between gap-5 border-b border-background/15 py-2.5 text-xs">
          <dt className="text-background/55">{labels.model}</dt>
          <dd className="max-w-28 truncate font-semibold text-background">
            {agent.model ?? labels.bringYourOwn}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-5 border-b border-background/15 py-2.5 text-xs">
          <dt className="text-background/55">{labels.mcpSkills}</dt>
          <dd className="font-semibold text-background">
            {agent.serverCount} / {agent.skillCount}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-5 border-b border-background/15 py-2.5 text-xs">
          <dt className="text-background/55">{labels.clones}</dt>
          <dd className="font-semibold text-background">{formatCount(agent.cloneCount)}</dd>
        </div>
      </dl>

      <span
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -right-14 size-64 rounded-full border-[2.8rem] border-brand/30 transition-transform duration-300 ease-out group-hover:-translate-x-2 group-hover:-translate-y-2 motion-reduce:transform-none"
      />
    </Link>
  );
}

export function AgentMarketRow({ agent }: { agent: AgentMarketCardData }) {
  return (
    <Link
      href={detailHref(agent)}
      className="group grid gap-4 border-b border-border px-1 py-5 transition-colors hover:bg-accent/30 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto] sm:items-center sm:px-2"
    >
      <span className="flex size-11 items-center justify-center rounded-lg bg-brand-soft text-base font-bold text-accent-foreground">
        {avatarLabel(agent.name)}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground group-hover:underline">
            {agent.name}
          </span>
          {agent.agentCount > 1 ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-medium text-muted-foreground">
              <Network className="size-3" /> {agent.agentCount}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {agent.summary ?? agent.workspaceName}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground sm:justify-end">
        <span className="inline-flex items-center gap-1">
          <Boxes className="size-3.5" /> {agent.serverCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <PackageCheck className="size-3.5" /> {agent.skillCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <Copy className="size-3.5" /> {formatCount(agent.cloneCount)}
        </span>
        <span className="sr-only">{agent.workspaceName}</span>
      </span>
    </Link>
  );
}

export function AgentMarketEmptyCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center border-y border-dashed border-border px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Bot className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}
