'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  MessageSquare,
  Plus,
  Route,
  Settings,
  Users,
  Wrench,
} from 'lucide-react';
import { createAgentAction } from '@/lib/agents/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

export type AgentRow = {
  id: string;
  name: string;
  providerName: string | null;
  model: string | null;
  toolCount: number;
  subAgentCount: number;
  conversationCount: number;
};

function AgentStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
    </div>
  );
}

function InventoryMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-w-max items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function AgentsBrowser({ slug, agents }: { slug: string; agents: AgentRow[] }) {
  const [creating, setCreating] = useState(false);
  const readyCount = agents.filter((agent) => agent.model).length;
  const setupCount = agents.length - readyCount;
  const toolCount = agents.reduce((sum, agent) => sum + agent.toolCount, 0);
  const conversationCount = agents.reduce((sum, agent) => sum + agent.conversationCount, 0);

  return (
    <DashboardPage>
      <DashboardToolbar
        actions={
          <div className="relative">
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="ui-button-primary"
            >
              <Plus className="size-4" /> New agent
            </button>
            {creating ? (
              <div className="ui-panel absolute right-0 top-11 z-20 w-72 p-3">
                <form action={createAgentAction} className="space-y-2">
                  <input type="hidden" name="workspace" value={slug} />
                  <input
                    name="name"
                    autoFocus
                    required
                    maxLength={60}
                    placeholder="e.g. Research assistant"
                    className="ui-input h-9"
                  />
                  <button className="ui-button-primary w-full">
                    Create agent
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        }
      >
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Manage the agents that own model selection, tools, sandboxes, sub-agents, and external channels.
          </p>
          <p className="text-sm text-muted-foreground">
            Use this view to spot setup gaps, jump into a conversation, or tune an agent&apos;s runtime.
          </p>
        </div>
      </DashboardToolbar>

      {agents.length === 0 ? (
        <DashboardEmptyState
          icon={Bot}
          title="No agents yet"
          description="Add a model provider, create an agent, then connect it to tools and external messaging adapters."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AgentStat icon={Bot} label="Agents" value={agents.length} />
            <AgentStat icon={CheckCircle2} label="Ready" value={readyCount} />
            <AgentStat icon={Wrench} label="Tool bindings" value={toolCount} />
            <AgentStat icon={MessageSquare} label="Sessions" value={conversationCount} />
          </div>

          <div className="ui-panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Agent inventory</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {setupCount > 0
                    ? `${setupCount} agent${setupCount > 1 ? 's need' : ' needs'} a model before it can reply.`
                    : 'All agents have a model selected.'}
                </p>
              </div>
            </div>
            <ul className="divide-y divide-border">
              {agents.map((agent) => {
                const ready = Boolean(agent.model);
                const detailsHref = `/app/${slug}/agents/${agent.id}`;
                const provider = agent.providerName
                  ? `${agent.providerName} · ${agent.model ?? 'no model selected'}`
                  : 'No model provider selected';

                return (
                  <li key={agent.id} className="transition-colors hover:bg-accent/30">
                    <div className="grid gap-4 px-5 py-4 xl:grid-cols-[minmax(14rem,1fr)_auto_auto] xl:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={detailsHref}
                            className="truncate text-sm font-semibold text-foreground hover:underline"
                          >
                            {agent.name}
                          </Link>
                          <span className={`rounded-md px-2 py-1 text-[11px] font-medium ${ready ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
                            {ready ? 'ready' : 'needs model'}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{provider}</p>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs xl:flex-nowrap xl:justify-self-end">
                        <InventoryMetric icon={Route} label="Tools" value={agent.toolCount} />
                        <InventoryMetric icon={Users} label="Sub-agents" value={agent.subAgentCount} />
                        <InventoryMetric icon={MessageSquare} label="Sessions" value={agent.conversationCount} />
                      </div>

                      <div className="flex flex-wrap gap-2 xl:flex-nowrap xl:justify-end">
                        <Link href={`${detailsHref}?tab=chat`} className="ui-button-secondary h-8 px-2 text-xs">
                          <MessageSquare className="size-3.5" />
                          Chat
                        </Link>
                        <Link href={`${detailsHref}?tab=messaging`} className="ui-button-secondary h-8 px-2 text-xs">
                          <Route className="size-3.5" />
                          Channels
                        </Link>
                        <Link href={`${detailsHref}?tab=settings`} className="ui-button-secondary h-8 px-2 text-xs">
                          <Settings className="size-3.5" />
                          Settings
                        </Link>
                        <Link href={detailsHref} className="ui-button-primary h-8 px-2 text-xs">
                          Open
                          <ArrowRight className="size-3.5" />
                        </Link>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </DashboardPage>
  );
}
