'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Blocks,
  Box,
  Bot,
  CheckCircle2,
  CircleAlert,
  Container,
  Cpu,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  MessageSquare,
  PackageCheck,
  Plus,
  Server,
  Sparkles,
  Settings2,
  Store,
  Zap,
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
import {
  ModelPicker,
  type ModelProviderOption,
} from '@/components/dashboard/models/ModelPicker';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { CloneAgentButton } from '@/components/dashboard/agents/CloneAgentButton';
import { DeleteAgentButton } from '@/components/dashboard/agents/DeleteAgentButton';
import { ConnectDialog } from '@/components/dashboard/ConnectDialog';
import { AgentMarketInstallForm } from '@/components/dashboard/market/AgentMarketInstallForm';
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  isDedicatedSandboxRuntimeKind,
  type AgentRuntimeKind,
} from '@/lib/agents/runtime-kind';

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
  sandboxReady: boolean;
};

type CreateOptions = {
  providers: Array<ModelProviderOption & { format: string }>;
  defaultModel?: { providerId: string; model: string } | null;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
};

export type AgentMarketOption = {
  id: string;
  releaseId: string;
  idempotencyKey: string;
  name: string;
  summary: string | null;
  iconUrl: string | null;
  publisher: string | null;
  tags: string[];
  runtimes: string[];
  resourceCount: number;
  sandboxCount: number;
  installCount: number;
};

type CreateStep = 'basic' | 'instructions' | 'tools';
type CreateSource = 'choose' | 'blank' | 'market';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function isAgentReady(agent: Pick<AgentRow, 'providerName' | 'providerNames' | 'model' | 'runtimeKind' | 'sandboxReady'>) {
  if (agent.runtimeKind === 'hermes') return agent.providerNames.length > 0;
  if (isDedicatedSandboxRuntimeKind(agent.runtimeKind)) {
    return Boolean(agent.providerName && agent.model && agent.sandboxReady);
  }
  return false;
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
  marketAgents = [],
}: {
  slug: string;
  agentControlEndpoint?: string;
  agents: AgentRow[];
  createOptions: CreateOptions;
  hermesImages?: string[];
  marketAgents?: AgentMarketOption[];
}) {
  const t = useTranslations('console.agents');
  const marketT = useTranslations('agentMarket');
  const router = useRouter();
  const pathname = usePathname() ?? `/app/${encodeURIComponent(slug)}/agents`;
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const returnTo = `${pathname}${query ? `?${query}` : ''}`;
  const requestedReturnTo = searchParams.get('returnTo') ?? '';
  const createOnly = searchParams.get('create') === '1';
  const [creating, setCreating] = useState(createOnly);
  const [createSource, setCreateSource] = useState<CreateSource>(
    createOnly && searchParams.get('source') === 'market' ? 'market' : 'choose',
  );
  const [createStep, setCreateStep] = useState<CreateStep>('basic');
  const [agentName, setAgentName] = useState('');
  const [runtime, setRuntime] = useState<AgentRuntimeKind | null>(null);
  const [providerId, setProviderId] = useState(createOptions.defaultModel?.providerId ?? '');
  const [modelId, setModelId] = useState(createOptions.defaultModel?.model ?? '');
  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(() => (
    new Set(createOptions.defaultModel?.providerId ? [createOptions.defaultModel.providerId] : [])
  ));
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<Set<string>>(() => new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [selectedToolkitIds, setSelectedToolkitIds] = useState<Set<string>>(() => new Set());
  const setupCount = agents.filter((agent) => !isAgentReady(agent)).length;
  const hasProviders = createOptions.providers.length > 0;
  const compatibleProviders = createOptions.providers.filter((provider) => (
    !runtime || agentRuntimeSupportsProviderFormat(runtime, provider.format)
  ));
  const creatingDraft = runtime === null
    || (runtime === 'hermes' ? selectedProviderIds.size === 0 : !providerId || !modelId);
  const selectedProvider = compatibleProviders.find((provider) => provider.id === providerId) ?? null;
  const providerOptions = createOptions.providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    description: t('providerModelCount', { count: provider.models.length }),
    keywords: provider.models,
  }));
  const createSteps: Array<{ id: CreateStep; label: string; description: string }> = [
    { id: 'basic', label: t('basic'), description: t('generalSettingsDescription') },
    ...(runtime === 'hermes' ? [] : [{
      id: 'instructions' as const,
      label: t('instructions'),
      description: t('instructionsSettingsDescription'),
    }]),
    { id: 'tools', label: t('tools'), description: t('resourceSettingsDescription') },
  ];
  const createStepIndex = Math.max(0, createSteps.findIndex((step) => step.id === createStep));
  const activeCreateStep = createSteps[createStepIndex]?.id ?? 'basic';
  const lastCreateStep = createStepIndex === createSteps.length - 1;
  const marketReturnParams = new URLSearchParams(searchParams.toString());
  marketReturnParams.set('create', '1');
  marketReturnParams.set('source', 'market');
  marketReturnParams.delete('cloneError');
  const marketReturnTo = `${pathname}?${marketReturnParams}`;
  const cloneError = searchParams.get('cloneError');

  function selectRuntime(nextRuntime: AgentRuntimeKind) {
    setRuntime(nextRuntime);
    const selectedProvider = createOptions.providers.find((provider) => provider.id === providerId);
    if (selectedProvider && !agentRuntimeSupportsProviderFormat(nextRuntime, selectedProvider.format)) {
      setProviderId('');
      setModelId('');
    }
  }

  function closeCreateForm() {
    if (createOnly) {
      router.push(requestedReturnTo || `/app/${encodeURIComponent(slug)}/work`);
      return;
    }
    setCreating(false);
    setCreateSource('choose');
    setCreateStep('basic');
    setAgentName('');
    setRuntime(null);
    setProviderId(createOptions.defaultModel?.providerId ?? '');
    setModelId(createOptions.defaultModel?.model ?? '');
    setSelectedProviderIds(new Set(createOptions.defaultModel?.providerId ? [createOptions.defaultModel.providerId] : []));
    setSelectedDeploymentIds(new Set());
    setSelectedSkillIds(new Set());
    setSelectedToolkitIds(new Set());
  }

  return (
    <DashboardPage className={createOnly ? 'h-full max-w-none p-0' : 'space-y-5'}>
      {!createOnly ? (
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-foreground">{t('agent')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('agentDescription')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!createOnly && agentControlEndpoint ? (
            <ConnectDialog
              endpoint={agentControlEndpoint}
              name={`${slug}-agent-control`}
              label={t('connectAi')}
              variant="outline"
            />
          ) : null}
          {!createOnly ? (
            <Link href={`/app/${encodeURIComponent(slug)}/market/agents`} className="ui-button-secondary h-10 gap-2 px-4">
              <Store className="size-[18px] shrink-0" />
              {t('browseAgentMarket')}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (creating) closeCreateForm();
              else {
                setCreateSource('choose');
                setCreating(true);
              }
            }}
            aria-controls={createSource === 'blank'
              ? 'agent-create-form'
              : createSource === 'market'
                ? 'agent-market-source'
                : 'agent-create-source'}
            aria-expanded={creating}
            className={creating ? 'ui-button-secondary h-10 gap-2 px-4' : 'ui-button-primary h-10 gap-2 px-4'}
          >
            {creating ? <X className="size-[18px] shrink-0" /> : <Plus className="size-[18px] shrink-0" />}
            {creating ? t('cancel') : t('newAgent')}
          </button>
        </div>
      </div>
      ) : null}

      {!hasProviders && !creating ? (
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

      {creating && createSource === 'choose' ? (
        <section
          id="agent-create-source"
          className={cx(
            'flex min-h-0 flex-col bg-background',
            createOnly ? 'h-full' : 'ui-panel min-h-[32rem]',
          )}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 py-10 sm:px-8">
            <div>
              <h3 className="text-xl font-semibold text-foreground">{t('chooseAgentStartingPoint')}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('chooseAgentStartingPointDescription')}</p>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setCreateSource('blank')}
                aria-label={t('createBlankAgent')}
                className="group flex min-h-32 items-start gap-4 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-muted/40"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-accent-foreground">
                  <Plus className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-foreground">{t('createBlankAgent')}</span>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{t('createBlankAgentDescription')}</span>
                </span>
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
              <button
                type="button"
                onClick={() => setCreateSource('market')}
                aria-label={t('chooseFromAgentMarket')}
                className="group flex min-h-32 items-start gap-4 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-muted/40"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Store className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-foreground">{t('chooseFromAgentMarket')}</span>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{t('chooseFromAgentMarketDescription')}</span>
                </span>
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          </div>
          <div className="flex shrink-0 justify-end border-t border-border/60 px-4 py-3 sm:px-6">
            <button type="button" onClick={closeCreateForm} className="ui-button-secondary h-10 gap-2 px-4">
              <X className="size-4 shrink-0" />
              {t('cancel')}
            </button>
          </div>
        </section>
      ) : creating && createSource === 'market' ? (
        <section
          id="agent-market-source"
          className={cx(
            'flex min-h-0 flex-col overflow-hidden bg-background',
            createOnly ? 'h-full' : 'ui-panel min-h-[38rem] max-h-[calc(100dvh-10rem)]',
          )}
        >
          <header className="flex shrink-0 items-start gap-3 px-5 py-4 sm:px-6">
            <button
              type="button"
              onClick={() => setCreateSource('choose')}
              aria-label={t('back')}
              className="ui-button-ghost ui-icon-button shrink-0"
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-foreground">{t('chooseFromAgentMarket')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('chooseFromAgentMarketDescription')}</p>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
            {cloneError ? (
              <p role="alert" className="mb-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {cloneError === 'release_not_found' || cloneError === 'listing_unavailable'
                  ? marketT('releaseUnavailable')
                  : marketT('invalidInstall')}
              </p>
            ) : null}
            {marketAgents.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {marketAgents.map((agent) => (
                  <article key={agent.id} className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start gap-3">
                      {agent.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={agent.iconUrl} alt="" width={40} height={40} className="size-10 rounded-lg object-cover" />
                      ) : (
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft font-semibold text-accent-foreground">
                          {Array.from(agent.name.trim())[0]?.toUpperCase() ?? 'A'}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <h4 className="truncate text-sm font-semibold text-foreground">{agent.name}</h4>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {agent.publisher ?? agent.runtimes.map(agentRuntimeDisplayName).join(' · ')}
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
                      {agent.summary ?? t('chooseFromAgentMarketDescription')}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {agent.runtimes.map((runtimeKind) => (
                        <span key={runtimeKind} className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                          {agentRuntimeDisplayName(runtimeKind)}
                        </span>
                      ))}
                      {agent.tags.slice(0, 2).map((tag) => (
                        <span key={tag} className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">{tag}</span>
                      ))}
                    </div>
                    <dl className="mt-4 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                      <div><dt>{marketT('resources')}</dt><dd className="mt-0.5 font-semibold text-foreground">{agent.resourceCount}</dd></div>
                      <div><dt>{marketT('sandboxes')}</dt><dd className="mt-0.5 font-semibold text-foreground">{agent.sandboxCount}</dd></div>
                      <div className="text-right"><dt>{marketT('clones')}</dt><dd className="mt-0.5 font-semibold text-foreground">{agent.installCount}</dd></div>
                    </dl>
                    <div className="mt-auto pt-4">
                      <AgentMarketInstallForm
                        workspace={slug}
                        releaseId={agent.releaseId}
                        idempotencyKey={agent.idempotencyKey}
                        returnTo={marketReturnTo}
                        labels={{ submit: marketT('cloneAgent'), pending: marketT('cloningAgent') }}
                      />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <DashboardEmptyState
                icon={Store}
                title={marketT('emptyTitle')}
                description={marketT('emptyDescription')}
              />
            )}
          </div>

          <footer className="flex shrink-0 justify-end border-t border-border/60 px-4 py-3 sm:px-6">
            <button type="button" onClick={closeCreateForm} className="ui-button-secondary h-10 gap-2 px-4">
              <X className="size-4 shrink-0" />
              {t('cancel')}
            </button>
          </footer>
        </section>
      ) : creating ? (
        <form
          id="agent-create-form"
          action={createAgentAction}
          className={cx(
            'flex min-h-0 flex-col overflow-hidden bg-background',
            createOnly ? 'h-full' : 'ui-panel min-h-[38rem] max-h-[calc(100dvh-10rem)]',
          )}
        >
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="returnTo" value={requestedReturnTo} />
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav
              aria-label={t('configurationNavigation')}
              className="shrink-0 border-b border-border/60 bg-muted/20 sm:w-48 sm:border-b-0 sm:border-r"
            >
              <ol className="flex gap-1 overflow-x-auto p-2 sm:block sm:space-y-1 sm:p-3">
                {createSteps.map((step, index) => {
                  const active = index === createStepIndex;
                  const done = index < createStepIndex;
                  return (
                    <li key={step.id} className="shrink-0 sm:w-full">
                      <button
                        type="button"
                        aria-current={active ? 'step' : undefined}
                        disabled={index > createStepIndex}
                        onClick={() => {
                          if (done) setCreateStep(step.id);
                        }}
                        className={cx(
                          'flex h-10 min-w-max items-center gap-2 rounded-md px-3 text-sm transition-colors sm:w-full',
                          active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                          'disabled:cursor-default disabled:opacity-55',
                        )}
                      >
                        <span className={cx(
                          'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium',
                          active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground',
                        )}>
                          {index + 1}
                        </span>
                        <span>{step.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <section
                hidden={activeCreateStep !== 'basic'}
                aria-labelledby="agent-create-basic-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-basic-title" className="text-base font-semibold text-foreground">{t('basic')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('generalSettingsDescription')}</p>
                </div>

                {!hasProviders ? (
                  <div className="flex items-start gap-3 rounded-md bg-amber-500/10 px-4 py-3">
                    <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">{t('modelProviderRequired')}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('modelProviderRequiredDescription')}</p>
                    </div>
                    <Link href={`/app/${encodeURIComponent(slug)}/providers`} className="ui-button-secondary shrink-0">
                      <Cpu className="size-4" />
                      {t('addModelProvider')}
                    </Link>
                  </div>
                ) : null}

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('name')}</span>
                  <input
                    name="name"
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                    autoFocus
                    required
                    maxLength={60}
                    placeholder={t('egResearchAssistant')}
                    className="ui-input h-10 w-full"
                  />
                </label>

                <fieldset>
                  <legend className="mb-1.5 text-xs font-semibold text-foreground">{t('runtime')}</legend>
                  <div className="space-y-2">
                    {([
                      {
                        value: 'claude-code' as const,
                        label: t('claudeCodeRuntime'),
                        description: t('claudeCodeRuntimeDescription'),
                        icon: Sparkles,
                      },
                      {
                        value: 'pi' as const,
                        label: t('piRuntime'),
                        description: t('piRuntimeDescription'),
                        icon: Zap,
                      },
                      {
                        value: 'dsh' as const,
                        label: t('deepSeekHarnessRuntime'),
                        description: t('deepSeekHarnessRuntimeDescription'),
                        icon: Cpu,
                      },
                      {
                        value: 'hermes' as const,
                        label: t('hermesManagedRuntime'),
                        description: t('hermesManagedRuntimeDescription'),
                        icon: Container,
                      },
                    ]).map((option) => {
                      const Icon = option.icon;
                      const selected = runtime === option.value;
                      return (
                        <label
                          key={option.value}
                          className={cx(
                            'flex min-h-16 cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 text-left transition-colors hover:bg-muted/40',
                            selected ? 'border-foreground/20 bg-muted/60' : 'border-border',
                          )}
                        >
                          <input
                            type="radio"
                            name="runtime"
                            value={option.value}
                            checked={selected}
                            onChange={() => selectRuntime(option.value)}
                            required
                            className="sr-only"
                          />
                          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-foreground">{option.label}</span>
                            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>
                          </span>
                          <CheckCircle2 className={cx('mt-0.5 size-4 shrink-0', selected ? 'text-foreground' : 'invisible')} />
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                {runtime === 'hermes' ? (
                  <HermesImageSelector id="create-hermes-version" images={hermesImages} />
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
                ) : runtime ? (
                  <div>
                    <input type="hidden" name="providerId" value={providerId} />
                    <input type="hidden" name="model" value={modelId} />
                    <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Cpu className="size-4 text-muted-foreground" /> {t('model')}
                    </span>
                    <ModelPicker
                      providers={compatibleProviders}
                      value={providerId && modelId ? { providerId, model: modelId } : null}
                      onSelect={(selection) => {
                        setProviderId(selection.providerId);
                        setModelId(selection.model);
                      }}
                      onConfigure={() => {
                        window.location.assign(`/app/${encodeURIComponent(slug)}/providers`);
                      }}
                      trigger={(
                        <button type="button" aria-label={`${t('model')}: ${modelId || t('selectModel')}`} className="ui-input flex h-10 w-full items-center gap-2 px-3 text-left text-sm text-foreground">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                            {selectedProvider?.name.charAt(0).toUpperCase() || 'M'}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{modelId || t('selectModel')}</span>
                          <span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span>
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      )}
                    />
                  </div>
                ) : null}

                {runtime && runtime !== 'hermes' ? (
                  <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                    <Box className="mt-0.5 size-4 shrink-0" />
                    <p>{t('automaticSandboxHelp')}</p>
                  </div>
                ) : null}
              </section>

              <section
                hidden={activeCreateStep !== 'instructions'}
                aria-labelledby="agent-create-instructions-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-instructions-title" className="text-base font-semibold text-foreground">{t('instructions')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('instructionsSettingsDescription')}</p>
                </div>
                <label className="block">
                  <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-foreground">
                    <FileText className="size-4 text-muted-foreground" /> {t('systemPrompt')}
                  </span>
                  <textarea
                    name="systemPrompt"
                    rows={12}
                    placeholder={t('youAreAHelpfulAssistant')}
                    className="ui-input min-h-72 w-full resize-y py-3"
                  />
                </label>
              </section>

              <section
                hidden={activeCreateStep !== 'tools'}
                aria-labelledby="agent-create-tools-title"
                className="mx-auto max-w-4xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-tools-title" className="text-base font-semibold text-foreground">{t('tools')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('resourceSettingsDescription')}</p>
                </div>
                <div className="grid items-start gap-4 lg:grid-cols-2">
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
              </section>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-3 sm:px-6">
            <button type="button" onClick={closeCreateForm} className="ui-button-secondary h-10 gap-2 px-4">
              <X className="size-4 shrink-0" />
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (createStepIndex > 0) setCreateStep(createSteps[createStepIndex - 1]!.id);
                else setCreateSource('choose');
              }}
              className="ui-button-secondary h-10 gap-2 px-4"
            >
              <ChevronLeft className="size-4 shrink-0" />
              {t('back')}
            </button>
            {lastCreateStep ? (
              <SubmitButton
                pendingLabel={t('creatingAgent')}
                savedLabel={t('agentCreated')}
                disabled={!runtime || !agentName.trim()}
                className="ui-button-primary h-10 gap-2 px-4"
              >
                <Plus className="size-[18px] shrink-0" />
                {creatingDraft ? t('createDraftAgent') : t('createAgent')}
              </SubmitButton>
            ) : (
              <button
                type="button"
                onClick={() => {
                  const form = document.getElementById('agent-create-form') as HTMLFormElement | null;
                  if (activeCreateStep === 'basic' && form && !form.reportValidity()) return;
                  setCreateStep(createSteps[createStepIndex + 1]!.id);
                }}
                className="ui-button-primary h-10 gap-2 px-4"
              >
                {t('next')}
                <ChevronRight className="size-4 shrink-0" />
              </button>
            )}
          </div>
        </form>
      ) : null}

      {!creating && (agents.length === 0 ? (
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
                              : isDedicatedSandboxRuntimeKind(agent.runtimeKind) && !agent.sandboxReady
                                ? t('needsSandbox')
                                : agent.runtimeKind === 'hermes' || !agent.providerName
                                ? t('needsProvider')
                                : t('needsModel')}
                          </span>
                          <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 text-[11px] font-medium text-muted-foreground">
                            {agent.runtimeKind === 'hermes' ? <Container className="size-3.5" /> : <Bot className="size-3.5" />}
                            {agentRuntimeDisplayName(agent.runtimeKind)}
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
                      {ready ? (
                        <Link
                          href={`/app/${encodeURIComponent(slug)}/chat?agent=${encodeURIComponent(agent.id)}`}
                          aria-label={t('chat')}
                          title={t('chat')}
                          className="ui-button-primary size-10 shrink-0 px-0"
                        >
                          <MessageSquare className="size-[18px] shrink-0" />
                        </Link>
                      ) : null}
                      <Link
                        href={detailsHref}
                        aria-label={t('settings')}
                        title={t('settings')}
                        className="ui-button-secondary size-10 shrink-0 px-0"
                      >
                        <Settings2 className="size-[18px] shrink-0" />
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
      ))}
    </DashboardPage>
  );
}
