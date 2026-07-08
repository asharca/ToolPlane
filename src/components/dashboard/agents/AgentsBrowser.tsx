'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  MessageCircle,
  Plus,
  Wrench,
  Users,
} from 'lucide-react';
import { createAgentAction } from '@/lib/agents/actions';
import {
  DashboardEmptyState,
  DashboardPage,
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

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function CountPill({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-muted-foreground">
      <Icon className="size-4 shrink-0" />
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );
}

export function AgentsBrowser({ slug, agents }: { slug: string; agents: AgentRow[] }) {
  const t = useTranslations('console.agents');
  const [creating, setCreating] = useState(false);
  const setupCount = agents.filter((agent) => !agent.model).length;

  return (
    <DashboardPage className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('agent')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentDescription')}</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          className="ui-button-primary h-10 gap-2 px-4"
        >
          <Plus className="size-[18px] shrink-0" />
          {t('newAgent')}
        </button>
      </div>

      {creating ? (
        <form
          action={createAgentAction}
          className="ui-panel grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <input type="hidden" name="workspace" value={slug} />
          <input
            name="name"
            autoFocus
            required
            maxLength={60}
            placeholder={t('egResearchAssistant')}
            className="ui-input h-10"
          />
          <button className="ui-button-primary h-10 gap-2 px-4">
            <Plus className="size-[18px] shrink-0" />
            {t('createAgent')}
          </button>
        </form>
      ) : null}

      {agents.length === 0 ? (
        <DashboardEmptyState
          icon={Bot}
          title={t('noAgentsYet')}
          description={t('addAModelProviderCreateAnAgentThenConnectItToToolsAndExternalMessagingAdapters')}
        />
      ) : (
        <section className="ui-panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('agents')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {setupCount > 0
                  ? t('agentsNeedModel', { count: setupCount })
                  : t('allAgentsHaveModel')}
              </p>
            </div>
          </div>

          <ul className="divide-y divide-border">
            {agents.map((agent) => {
              const ready = Boolean(agent.model);
              const detailsHref = `/app/${slug}/agents/${agent.id}`;
              const model = agent.providerName
                ? `${agent.providerName} / ${agent.model ?? t('noModelSelected')}`
                : t('noProviderSelected');

              return (
                <li key={agent.id} className="transition-colors hover:bg-accent/25">
                  <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className={cx(
                          'flex size-10 shrink-0 items-center justify-center rounded-md border',
                          ready
                            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                        )}
                      >
                        {ready ? <Bot className="size-[18px]" /> : <CircleAlert className="size-[18px]" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <Link
                            href={detailsHref}
                            className="truncate text-base font-semibold text-foreground hover:underline"
                          >
                            {agent.name}
                          </Link>
                          <span
                            className={cx(
                              'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium',
                              ready
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                            )}
                          >
                            {ready ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                            {ready ? t('ready') : t('needsModel')}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {t('model')}: {model}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <CountPill icon={Wrench} label={t('tools')} value={agent.toolCount} />
                          <CountPill icon={Users} label={t('subagents')} value={agent.subAgentCount} />
                          <CountPill icon={MessageCircle} label={t('conversations')} value={agent.conversationCount} />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2.5 lg:justify-end">
                      <Link href={detailsHref} className="ui-button-primary h-10 gap-2 px-4 text-sm">
                        <MessageCircle className="size-[18px] shrink-0" />
                        {t('chat')}
                      </Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </DashboardPage>
  );
}
