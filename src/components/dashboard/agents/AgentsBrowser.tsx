'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Blocks,
  Box,
  Bot,
  CheckCircle2,
  CircleAlert,
  Container,
  Cpu,
  FileText,
  PackageCheck,
  Plus,
  Server,
  Settings2,
  Store,
  Wrench,
  Users,
  X,
} from 'lucide-react';
import { createAgentAction } from '@/lib/agents/actions';
import {
  DashboardEmptyState,
  DashboardPage,
} from '@/components/dashboard/DashboardUI';
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from '@/components/dashboard/agents/AgentResourceSelect';
import { HermesImageSelector } from '@/components/dashboard/agents/HermesImageSelector';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { CloneAgentButton } from '@/components/dashboard/agents/CloneAgentButton';
import { DeleteAgentButton } from '@/components/dashboard/agents/DeleteAgentButton';
import { ConnectDialog } from '@/components/dashboard/ConnectDialog';

export type AgentRow = {
  id: string;
  name: string;
  providerName: string | null;
  providerNames: string[];
  model: string | null;
  toolCount: number;
  subAgentCount: number;
  runtimeKind: string;
  runtimeStatus: string | null;
};

type CreateOptions = {
  providers: Array<{ id: string; name: string; models: string[] }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
  sandboxes?: AgentResourceOption[];
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function isAgentReady(agent: Pick<AgentRow, 'providerName' | 'providerNames' | 'model' | 'runtimeKind'>) {
  return agent.runtimeKind === 'hermes'
    ? agent.providerNames.length > 0
    : Boolean(agent.providerName && agent.model);
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
    <span className="inline-flex h-6 items-center gap-1.5 text-[11px] text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span>{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  );
}

export function AgentsBrowser({
  slug,
  agentControlEndpoint,
  agents,
  createOptions,
  hermesImages,
}: {
  slug: string;
  agentControlEndpoint?: string;
  agents: AgentRow[];
  createOptions: CreateOptions;
  hermesImages?: string[];
}) {
  const t = useTranslations('console.agents');
  const pathname = usePathname() ?? `/app/${encodeURIComponent(slug)}/agents`;
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const returnTo = `${pathname}${query ? `?${query}` : ''}`;
  const [creating, setCreating] = useState(false);
  const [runtime, setRuntime] = useState<'native' | 'hermes'>('native');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(() => new Set());
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<Set<string>>(() => new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [selectedToolkitIds, setSelectedToolkitIds] = useState<Set<string>>(() => new Set());
  const [selectedSandboxIds, setSelectedSandboxIds] = useState<Set<string>>(() => new Set());
  const setupCount = agents.filter((agent) => !isAgentReady(agent)).length;
  const hasProviders = createOptions.providers.length > 0;
  const creatingDraft = runtime === 'hermes'
    ? selectedProviderIds.size === 0
    : !providerId || !modelId;
  const models = createOptions.providers.find((provider) => provider.id === providerId)?.models ?? [];
  const providerOptions = createOptions.providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    description: t('providerModelCount', { count: provider.models.length }),
    keywords: provider.models,
  }));

  function closeCreateForm() {
    setCreating(false);
    setRuntime('native');
    setProviderId('');
    setModelId('');
    setSelectedProviderIds(new Set());
    setSelectedDeploymentIds(new Set());
    setSelectedSkillIds(new Set());
    setSelectedToolkitIds(new Set());
    setSelectedSandboxIds(new Set());
  }

  return (
    <DashboardPage className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-foreground">{t('agent')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentDescription')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {agentControlEndpoint ? (
            <ConnectDialog
              endpoint={agentControlEndpoint}
              name={`${slug}-agent-control`}
              label={t('connectAi')}
              variant="outline"
            />
          ) : null}
          <Link href={`/app/${encodeURIComponent(slug)}/market/agents`} className="ui-button-secondary h-10 gap-2 px-4">
            <Store className="size-[18px] shrink-0" />
            {t('browseAgentMarket')}
          </Link>
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
      </div>

      {!hasProviders ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('modelProviderRequired')}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('modelProviderRequiredDescription')}</p>
            </div>
          </div>
          <Link href={`/app/${encodeURIComponent(slug)}/providers`} className="ui-button-secondary shrink-0">
            <Cpu className="size-4" />
            {t('addModelProvider')}
          </Link>
        </div>
      ) : null}

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
            <HermesImageSelector
              id="create-hermes-version"
              images={hermesImages}
            />
          ) : null}

          {runtime === 'hermes' ? (
            <div className="space-y-2">
              <AgentResourceSelect
                icon={Cpu}
                label={t('modelProviders')}
                name="providerId"
                options={providerOptions}
                selectedIds={selectedProviderIds}
                onSelectionChange={setSelectedProviderIds}
              />
              <p className="text-xs text-muted-foreground">{t('hermesProviderSelectionHelp')}</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-foreground">
                  <Cpu className="size-4 text-muted-foreground" /> {t('provider')}
                </span>
                <NativeSelect
                  name="providerId"
                  value={providerId}
                  onChange={(event) => {
                    setProviderId(event.target.value);
                    setModelId('');
                  }}
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
                <NativeSelect
                  name="model"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  disabled={!providerId}
                  className="ui-input h-10 w-full disabled:opacity-60"
                >
                  <option value="">{t('select')}</option>
                  {models.map((model) => <option key={model} value={model}>{model}</option>)}
                </NativeSelect>
              </label>
            </div>
          )}

          {runtime === 'native' ? (
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-foreground">
                <FileText className="size-4 text-muted-foreground" /> {t('systemPrompt')}
              </span>
              <textarea
                name="systemPrompt"
                rows={3}
                placeholder={t('youAreAHelpfulAssistant')}
                className="ui-input min-h-24 w-full resize-y py-2.5"
              />
            </label>
          ) : null}

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
            {runtime === 'native' ? (
              <div className="space-y-1.5">
                <AgentResourceSelect
                  icon={Box}
                  label={t('sandboxes')}
                  name="sandboxId"
                  options={createOptions.sandboxes ?? []}
                  selectedIds={selectedSandboxIds}
                  onSelectionChange={setSelectedSandboxIds}
                />
                <p className="text-xs leading-5 text-muted-foreground">{t('nativeHarnessSandboxHelp')}</p>
              </div>
            ) : null}
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
              {creatingDraft ? t('createDraftAgent') : t('createAgent')}
            </SubmitButton>
          </div>
        </form>
      ) : null}

      {agents.length === 0 ? (
        <DashboardEmptyState
          icon={Bot}
          title={t('noAgentsYet')}
          description={hasProviders
            ? t('createAnAgentThenConnectItToToolsAndExternalMessagingAdapters')
            : t('addAModelProviderCreateAnAgentThenConnectItToToolsAndExternalMessagingAdapters')}
          actions={!hasProviders ? (
            <Link href={`/app/${encodeURIComponent(slug)}/providers`} className="ui-button-primary">
              <Cpu className="size-4" />
              {t('addModelProvider')}
            </Link>
          ) : undefined}
        />
      ) : (
        <section className="overflow-hidden border-y border-border bg-background lg:border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('agents')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {setupCount > 0
                  ? t('agentsNeedConfiguration', { count: setupCount })
                  : t('allAgentsConfigured')}
              </p>
            </div>
          </div>

          <ul className="divide-y divide-border">
            {agents.map((agent) => {
              const ready = isAgentReady(agent);
              const agentsHref = `/app/${encodeURIComponent(slug)}/agents`;
              const detailsHref = `${agentsHref}/${encodeURIComponent(agent.id)}?returnTo=${encodeURIComponent(returnTo)}`;
              const model = agent.runtimeKind === 'hermes'
                ? agent.providerNames.length > 0
                  ? t('providerSummary', {
                      count: agent.providerNames.length,
                      names: agent.providerNames.join(', '),
                    })
                  : t('noProviderSelected')
                : agent.providerName
                ? `${agent.providerName} / ${agent.model ?? t('noModelSelected')}`
                : t('noProviderSelected');

              return (
                <li key={agent.id} className="transition-colors hover:bg-muted/40">
                  <div className="grid gap-4 px-4 py-3.5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className={cx(
                          'flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted',
                          ready
                            ? 'text-muted-foreground'
                            : 'text-amber-700 dark:text-amber-300',
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
                              'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium',
                              ready
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                            )}
                          >
                            {ready ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                            {ready
                              ? t('ready')
                              : agent.runtimeKind === 'hermes' || !agent.providerName
                                ? t('needsProvider')
                                : t('needsModel')}
                          </span>
                          <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 text-[11px] font-medium text-muted-foreground">
                            {agent.runtimeKind === 'hermes' ? <Container className="size-3.5" /> : <Bot className="size-3.5" />}
                            {agent.runtimeKind === 'hermes' ? 'Hermes' : t('nativeRuntime')}
                            {agent.runtimeStatus ? ` · ${agent.runtimeStatus}` : ''}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {agent.runtimeKind === 'hermes' ? t('modelProviders') : t('model')}: {model}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-3">
                          <CountPill icon={Wrench} label={t('tools')} value={agent.toolCount} />
                          <CountPill icon={Users} label={t('subagents')} value={agent.subAgentCount} />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2.5 lg:justify-end">
                      <Link href={detailsHref} className="ui-button-secondary h-10 gap-2 px-4 text-sm">
                        <Settings2 className="size-[18px] shrink-0" />
                        {t('settings')}
                      </Link>
                      <CloneAgentButton
                        slug={slug}
                        agentId={agent.id}
                        agentName={agent.name}
                        runtimeKind={agent.runtimeKind}
                      />
                      <DeleteAgentButton slug={slug} agentId={agent.id} />
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
