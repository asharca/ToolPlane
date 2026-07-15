'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import {
  Blocks,
  Bot,
  CheckCircle2,
  CircleAlert,
  Container,
  Cpu,
  MessageCircle,
  PackageCheck,
  Plus,
  Server,
  Wrench,
  Users,
  X,
} from 'lucide-react';
import { createAgentAction } from '@/lib/agents/actions';
import { DEFAULT_HERMES_IMAGE } from '@/lib/agents/hermes/constants';
import {
  DashboardEmptyState,
  DashboardPage,
} from '@/components/dashboard/DashboardUI';
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from '@/components/dashboard/agents/AgentResourceSelect';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { NativeSelect } from '@/components/ui/NativeSelect';

export type AgentRow = {
  id: string;
  name: string;
  providerName: string | null;
  model: string | null;
  toolCount: number;
  subAgentCount: number;
  conversationCount: number;
  runtimeKind: string;
  runtimeStatus: string | null;
};

type CreateOptions = {
  providers: Array<{ id: string; name: string; models: string[] }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function isAgentReady(agent: Pick<AgentRow, 'providerName' | 'model'>) {
  return Boolean(agent.providerName && agent.model);
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

export function AgentsBrowser({
  slug,
  agents,
  createOptions,
}: {
  slug: string;
  agents: AgentRow[];
  createOptions: CreateOptions;
}) {
  const t = useTranslations('console.agents');
  const [creating, setCreating] = useState(false);
  const [runtime, setRuntime] = useState<'native' | 'hermes'>('native');
  const [providerId, setProviderId] = useState('');
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<Set<string>>(() => new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [selectedToolkitIds, setSelectedToolkitIds] = useState<Set<string>>(() => new Set());
  const setupCount = agents.filter((agent) => !isAgentReady(agent)).length;
  const models = createOptions.providers.find((provider) => provider.id === providerId)?.models ?? [];

  function closeCreateForm() {
    setCreating(false);
    setRuntime('native');
    setProviderId('');
    setSelectedDeploymentIds(new Set());
    setSelectedSkillIds(new Set());
    setSelectedToolkitIds(new Set());
  }

  return (
    <DashboardPage className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('agent')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentDescription')}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (creating) closeCreateForm();
            else setCreating(true);
          }}
          aria-controls="agent-create-form"
          aria-expanded={creating}
          className={creating ? 'ui-button-secondary h-10 gap-2 px-4' : 'ui-button-primary h-10 gap-2 px-4'}
        >
          {creating ? <X className="size-[18px] shrink-0" /> : <Plus className="size-[18px] shrink-0" />}
          {creating ? t('cancel') : t('newAgent')}
        </button>
      </div>

      {creating ? (
        <form
          id="agent-create-form"
          action={createAgentAction}
          className="ui-panel space-y-5 p-5"
        >
          <input type="hidden" name="workspace" value={slug} />
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('name')}</span>
              <input
                name="name"
                autoFocus
                required
                maxLength={60}
                placeholder={t('egResearchAssistant')}
                className="ui-input h-10 w-full"
              />
            </label>
            <fieldset>
              <legend className="mb-1.5 text-xs font-semibold text-foreground">{t('runtime')}</legend>
              <div className="grid grid-cols-2 rounded-md border border-border bg-muted/20 p-1">
                {([
                  { value: 'native' as const, label: t('nativeRuntime'), icon: Bot },
                  { value: 'hermes' as const, label: 'Hermes', icon: Container },
                ]).map((option) => {
                  const Icon = option.icon;
                  return (
                    <label
                      key={option.value}
                      className={cx(
                        'flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors',
                        runtime === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                      )}
                    >
                      <input
                        type="radio"
                        name="runtime"
                        value={option.value}
                        checked={runtime === option.value}
                        onChange={() => setRuntime(option.value)}
                        className="sr-only"
                      />
                      <Icon className="size-4" />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>

          {runtime === 'hermes' ? (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('dockerImage')}</span>
              <input
                name="hermesImage"
                defaultValue={DEFAULT_HERMES_IMAGE}
                className="ui-input h-10 w-full font-mono text-sm"
              />
            </label>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-foreground">
                <Cpu className="size-4 text-muted-foreground" /> {t('provider')}
              </span>
              <NativeSelect
                name="providerId"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                className="ui-input h-10 w-full"
              >
                <option value="">{t('none')}</option>
                {createOptions.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </NativeSelect>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('model')}</span>
              <NativeSelect name="model" disabled={!providerId} className="ui-input h-10 w-full disabled:opacity-60">
                <option value="">{t('select')}</option>
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </NativeSelect>
            </label>
          </div>

          <div className="grid items-start gap-3 lg:grid-cols-2">
            <AgentResourceSelect
              icon={Server}
              label={t('mcp')}
              name="deploymentId"
              options={createOptions.deployments}
              selectedIds={selectedDeploymentIds}
              onSelectionChange={setSelectedDeploymentIds}
            />
            <AgentResourceSelect
              icon={PackageCheck}
              label={t('skills')}
              name="installedSkillId"
              options={createOptions.skills}
              selectedIds={selectedSkillIds}
              onSelectionChange={setSelectedSkillIds}
            />
            <AgentResourceSelect
              icon={Blocks}
              label={t('toolkits')}
              name="toolkitId"
              options={createOptions.toolkits}
              selectedIds={selectedToolkitIds}
              onSelectionChange={setSelectedToolkitIds}
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <button type="button" onClick={closeCreateForm} className="ui-button-secondary h-10 gap-2 px-4">
              <X className="size-4 shrink-0" />
              {t('cancel')}
            </button>
            <SubmitButton
              pendingLabel={t('creatingAgent')}
              savedLabel={t('agentCreated')}
              className="ui-button-primary h-10 gap-2 px-4"
            >
              <Plus className="size-[18px] shrink-0" />
              {t('createAgent')}
            </SubmitButton>
          </div>
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
              const ready = isAgentReady(agent);
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
                          <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 text-xs font-medium text-muted-foreground">
                            {agent.runtimeKind === 'hermes' ? <Container className="size-3.5" /> : <Bot className="size-3.5" />}
                            {agent.runtimeKind === 'hermes' ? 'Hermes' : t('nativeRuntime')}
                            {agent.runtimeStatus ? ` · ${agent.runtimeStatus}` : ''}
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
