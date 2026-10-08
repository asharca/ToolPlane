'use client';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { Button, ButtonLink } from '@/components/motion/button/base';
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio';
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';

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
  MessageSquare,
  PackageCheck,
  Plus,
  Server,
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
import { AgentResourceSelect } from '@/components/dashboard/agents/AgentResourceSelect';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';
import { HermesImageSelector } from '@/components/dashboard/agents/HermesImageSelector';
import { ModelPicker } from '@/components/dashboard/models/ModelPicker';
import type { ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { CloneAgentButton } from '@/components/dashboard/agents/CloneAgentButton';
import { DeleteAgentButton } from '@/components/dashboard/agents/DeleteAgentButton';
import { ConnectDialog } from '@/components/dashboard/ConnectDialog';
import { AgentMarketInstallForm } from '@/components/dashboard/market/AgentMarketInstallForm';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  isDedicatedSandboxRuntimeKind,
} from '@/lib/agents/runtime-kind';
import type { AgentRuntimeKind } from '@/lib/agents/runtime-kind';
import { AgentBuiltInTools } from '@/components/dashboard/agents/AgentBuiltInTools';
import { AgentSystemPromptEditor } from '@/components/dashboard/agents/AgentSystemPromptEditor';

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
  sandboxes?: AgentResourceOption[];
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

type CreateStep = 'basic' | 'instructions' | 'builtInTools' | 'mcp' | 'skills' | 'toolkits';
type CreateSource = 'blank' | 'market';

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
  workspaceId = '',
  agentControlEndpoint,
  agents,
  createOptions,
  hermesImages,
  marketAgents = [],
}: {
  slug: string;
  workspaceId?: string;
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
  const configuredDefaultNativeModel = createOptions.defaultModel && createOptions.providers.some((provider) => (
    provider.id === createOptions.defaultModel?.providerId
    && provider.models.includes(createOptions.defaultModel.model)
    && agentRuntimeSupportsProviderFormat('pi', provider.format)
  ))
    ? createOptions.defaultModel
    : null;
  const defaultNativeModel = configuredDefaultNativeModel ?? (() => {
    const provider = createOptions.providers.find((option) => (
      agentRuntimeSupportsProviderFormat('pi', option.format) && option.models.length > 0
    ));
    return provider ? { providerId: provider.id, model: provider.models[0]! } : null;
  })();
  const [creating, setCreating] = useState(createOnly);
  const [createSource, setCreateSource] = useState<CreateSource>(
    createOnly && searchParams.get('source') === 'market' ? 'market' : 'blank',
  );
  const [createStep, setCreateStep] = useState<CreateStep>('basic');
  const [agentName, setAgentName] = useState('');
  const [agentDescription, setAgentDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [runtime, setRuntime] = useState<AgentRuntimeKind>(createOnly && searchParams.get('runtime') === 'pi-sdk' ? 'pi-sdk' : 'pi');
  const [providerId, setProviderId] = useState(defaultNativeModel?.providerId ?? '');
  const [modelId, setModelId] = useState(defaultNativeModel?.model ?? '');
  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(() => (
    new Set(createOptions.defaultModel?.providerId ? [createOptions.defaultModel.providerId] : [])
  ));
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<Set<string>>(() => new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [selectedToolkitIds, setSelectedToolkitIds] = useState<Set<string>>(() => new Set());
  const [sandboxId, setSandboxId] = useState('');
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<Set<string>>(() => new Set());
  const setupCount = agents.filter((agent) => !isAgentReady(agent)).length;
  const hasProviders = createOptions.providers.length > 0;
  const compatibleProviders = createOptions.providers.filter((provider) => (
    !runtime || agentRuntimeSupportsProviderFormat(runtime, provider.format)
  ));
  const selectedProvider = compatibleProviders.find((provider) => provider.id === providerId) ?? null;
  const createReady = Boolean(agentName.trim()) && (
    runtime === 'hermes'
      ? selectedProviderIds.size > 0
      : Boolean(selectedProvider && modelId && selectedProvider.models.includes(modelId))
  );
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
    { id: 'builtInTools', label: t('builtInTools'), description: t('builtInToolsDescription', { runtime: agentRuntimeDisplayName(runtime) }) },
    { id: 'mcp', label: t('mcp'), description: t('mcpSettingsDescription') },
    { id: 'skills', label: t('skills'), description: t('skillsSettingsDescription') },
    { id: 'toolkits', label: t('toolkits'), description: t('toolkitsSettingsDescription') },
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
    setCreateSource('blank');
    setCreateStep('basic');
    setAgentName('');
    setAgentDescription('');
    setSystemPrompt('');
    setRuntime('pi');
    setProviderId(defaultNativeModel?.providerId ?? '');
    setModelId(defaultNativeModel?.model ?? '');
    setSelectedProviderIds(new Set(createOptions.defaultModel?.providerId ? [createOptions.defaultModel.providerId] : []));
    setSelectedDeploymentIds(new Set());
    setSelectedSkillIds(new Set());
    setSelectedToolkitIds(new Set());
    setDisabledBuiltinTools(new Set());
    setSandboxId('');
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
            <ButtonLink href={`/app/${encodeURIComponent(slug)}/market/agents`} variant="secondary">
              <Store className="size-[18px] shrink-0" />
              {t('browseAgentMarket')}
            </ButtonLink>
          ) : null}
          <Button type="button" onClick={() => {
              if (creating) closeCreateForm();
              else {
                setCreateSource('blank');
                setCreating(true);
              }
            }} aria-controls={createSource === 'market' ? 'agent-market-source' : 'agent-create-form'} aria-expanded={creating} variant={"primary"}>
            {creating ? <X className="size-[18px] shrink-0" /> : <Plus className="size-[18px] shrink-0" />}
            {creating ? t('cancel') : t('newAgent')}
          </Button>
        </div>
      </div>
      ) : null}

      {!hasProviders && !creating ? (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground text-muted-foreground" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('modelProviderRequired')}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('modelProviderRequiredDescription')}</p>
            </div>
          </div>
          <ButtonLink href={`/app/${encodeURIComponent(slug)}/providers`} variant="secondary" className="shrink-0">
            <Cpu className="size-4" />
            {t('addModelProvider')}
          </ButtonLink>
        </div>
      ) : null}

      {creating && createSource === 'market' ? (
        <section
          id="agent-market-source"
          className={cx(
            'flex min-h-0 flex-col overflow-hidden bg-background',
            createOnly ? 'h-full' : 'rounded-2xl border border-border bg-card min-h-[38rem] max-h-[calc(100dvh-10rem)]',
          )}
        >
          <header className="flex shrink-0 items-start gap-3 px-5 py-4 sm:px-6">
            <Button type="button" onClick={() => setCreateSource('blank')} aria-label={t('back')} variant={"ghost"} size={"icon"} className="shrink-0">
              <ChevronLeft className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-foreground">{t('chooseFromAgentMarket')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('chooseFromAgentMarketDescription')}</p>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
            {cloneError ? (
              <p role="alert" className="text-sm text-destructive">
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
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted font-semibold text-accent-foreground">
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
                        <AnimatedBadge key={runtimeKind} status="neutral">
                          {agentRuntimeDisplayName(runtimeKind)}
                        </AnimatedBadge>
                      ))}
                      {agent.tags.slice(0, 2).map((tag) => (
                        <AnimatedBadge key={tag} status="neutral">{tag}</AnimatedBadge>
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
            <Button type="button" onClick={closeCreateForm} variant={"secondary"}>
              <X className="size-4 shrink-0" />
              {t('cancel')}
            </Button>
          </footer>
        </section>
      ) : creating ? (
        <form
          id="agent-create-form"
          action={createAgentAction}
          className={cx(
            'flex min-h-0 flex-col overflow-hidden bg-background',
            createOnly ? 'h-full' : 'rounded-2xl border border-border bg-card min-h-[38rem] max-h-[calc(100dvh-10rem)]',
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
                      <Button type="button" aria-current={active ? 'step' : undefined} disabled={index > createStepIndex} onClick={() => {
                          if (done) setCreateStep(step.id);
                        }} variant={active ? 'secondary' : 'ghost'}>
                        <span className={cx(
                          'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium',
                          active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground',
                        )}>
                          {index + 1}
                        </span>
                        <span>{step.label}</span>
                      </Button>
                    </li>
                  );
                })}
              </ol>
            </nav>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <section
                hidden={activeCreateStep !== 'basic'}
                aria-labelledby="agent-create-basic-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-basic-title" className="text-base font-semibold text-foreground">{t('basic')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('generalSettingsDescription')}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/35 p-2">
                  <Button type="button" aria-pressed={createSource === 'blank'} onClick={() => setCreateSource('blank')} variant={"secondary"} size={"sm"}>
                    <Plus className="size-3.5" />
                    {t('createBlankAgent')}
                  </Button>
                  <Button type="button" aria-pressed={createSource === 'market'} onClick={() => setCreateSource('market')} variant={"secondary"} size={"sm"}>
                    <Store className="size-3.5" />
                    {t('chooseFromAgentMarket')}
                  </Button>
                </div>

                {!hasProviders ? (
                  <div className="flex items-start gap-3 rounded-md bg-muted px-4 py-3">
                    <CircleAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">{t('modelProviderRequired')}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('modelProviderRequiredDescription')}</p>
                    </div>
                    <ButtonLink href={`/app/${encodeURIComponent(slug)}/providers`} variant="secondary" className="shrink-0">
                      <Cpu className="size-4" />
                      {t('addModelProvider')}
                    </ButtonLink>
                  </div>
                ) : null}

                <div className="block">
                  
                  <Input label={t('name')} name="name" autoFocus required maxLength={60} placeholder={t('egResearchAssistant')} value={String(agentName)} onChange={(value) => setAgentName(value)} className="w-full" />
                </div>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('description')}</span>
                  <textarea
                    name="description"
                    value={agentDescription}
                    onChange={(event) => setAgentDescription(event.target.value)}
                    maxLength={500}
                    rows={3}
                    placeholder={t('agentDescriptionPlaceholder')}
                    className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>

                <fieldset>
                  <legend className="mb-1.5 text-xs font-semibold text-foreground">{t('runtime')}</legend>
                  <RadioGroup value={runtime} onValueChange={(next) => selectRuntime(next as AgentRuntimeKind)}>
                    {[{
                      value: 'pi' as const,
                      label: t('piRuntime'),
                      description: t('piRuntimeDescription'),
                      icon: Zap,
                    }, {
                      value: 'pi-sdk' as const,
                      label: t('piSdkRuntime'),
                      description: t('piSdkRuntimeDescription'),
                      icon: PackageCheck,
                    }].map((option) => {
                      const Icon = option.icon;
                      const selected = runtime === option.value;
                      return (
                        <div key={option.value} className={cx(
                            'relative flex min-h-16 cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 text-left transition-colors hover:bg-muted/40',
                            selected ? 'border-foreground/20 bg-muted/60' : 'border-border',
                          )}>
                          <input type="radio" name="runtime" value={option.value} checked={selected} required onChange={() => selectRuntime(option.value)} className="sr-only" tabIndex={-1} aria-hidden="true" aria-label={option.label} />
                          <RadioGroupItem value={option.value} label={option.label} />
                          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                              <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{option.description}</span>
                          </span>
                          <CheckCircle2 className={cx('mt-0.5 size-4 shrink-0', selected ? 'text-foreground' : 'invisible')} />
                        </div>
                      );
                    })}
                  </RadioGroup>
                </fieldset>
                {runtime === 'pi-sdk' ? <div className="space-y-2 rounded-lg border border-border p-3 text-xs leading-5 text-muted-foreground">
                  <p>{t('piPackageSecurity')}</p>
                  <p>{t('piPackageHeadless')}</p>
                  <p>{t('piSdkCreateHelp')}</p>
                  <p>{t('piSdkUnsupportedEntrypoints')}</p>
                </div> : null}

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
                        <Button variant="secondary" type="button" aria-label={`${t('model')}: ${modelId || t('selectModel')}`} className="w-full text-left"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                          {selectedProvider?.name.charAt(0).toUpperCase() || 'M'}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{modelId || t('selectModel')}</span>
                        <span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></Button>
                      )}
                    />
                  </div>
                ) : null}

                {runtime === 'hermes-rpc' ? (
                  <div className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-foreground">{t('hermesRpcSandbox')}</span>
                    <FormSelect name={sandboxId ? 'sandboxId' : undefined} value={sandboxId} label={t('hermesRpcSandbox')} options={[({ value: "", label: t('hermesRpcNewSandbox') }), (createOptions.sandboxes ?? []).map((sandbox) => ({ value: sandbox.id, label: sandbox.label }))].flat().filter((option) => option != null)} onValueChange={(value) => setSandboxId(value)} className="w-full" />
                    <span className="mt-1.5 block text-xs text-muted-foreground">{t('hermesRpcSandboxHelp')}</span>
                  </div>
                ) : null}
                {runtime && runtime !== 'hermes' && runtime !== 'hermes-rpc' ? (
                  <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                    <Box className="mt-0.5 size-4 shrink-0" />
                    <p>{t('automaticSandboxHelp')}</p>
                  </div>
                ) : null}
                <div className="block max-w-48 text-xs font-medium text-muted-foreground">
                  
                  <Input label={t('maxToolSteps')} name="maxSteps" type="number" min={AGENT_STEP_BOUNDS.min} max={AGENT_STEP_BOUNDS.max} defaultValue={String(AGENT_STEP_BOUNDS.default)} className="mt-1.5 w-full" />
                </div>
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
                <AgentSystemPromptEditor
                  workspaceId={workspaceId}
                  name={agentName}
                  description={agentDescription}
                  providerId={providerId}
                  model={modelId}
                  value={systemPrompt}
                  onChange={setSystemPrompt}
                />
              </section>

              <section
                hidden={activeCreateStep !== 'builtInTools'}
                aria-labelledby="agent-create-built-in-tools-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-built-in-tools-title" className="text-base font-semibold text-foreground">{t('builtInTools')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('builtInToolsDescription', { runtime: agentRuntimeDisplayName(runtime) })}
                  </p>
                </div>
                <AgentBuiltInTools
                  runtimeKind={runtime}
                  disabledTools={disabledBuiltinTools}
                  onDisabledToolsChange={setDisabledBuiltinTools}
                />
              </section>

              <section
                hidden={activeCreateStep !== 'mcp'}
                aria-labelledby="agent-create-mcp-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-mcp-title" className="text-base font-semibold text-foreground">{t('mcp')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('mcpSettingsDescription')}</p>
                </div>
                <AgentResourceSelect
                  icon={Server}
                  label={t('mcp')}
                  name="deploymentId"
                  options={createOptions.deployments}
                  selectedIds={selectedDeploymentIds}
                  onSelectionChange={setSelectedDeploymentIds}
                />
              </section>

              <section
                hidden={activeCreateStep !== 'skills'}
                aria-labelledby="agent-create-skills-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-skills-title" className="text-base font-semibold text-foreground">{t('skills')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('skillsSettingsDescription')}</p>
                </div>
                <AgentResourceSelect
                  icon={PackageCheck}
                  label={t('skills')}
                  name="installedSkillId"
                  options={createOptions.skills}
                  selectedIds={selectedSkillIds}
                  onSelectionChange={setSelectedSkillIds}
                />
              </section>

              <section
                hidden={activeCreateStep !== 'toolkits'}
                aria-labelledby="agent-create-toolkits-title"
                className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8"
              >
                <div>
                  <h3 id="agent-create-toolkits-title" className="text-base font-semibold text-foreground">{t('toolkits')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('toolkitsSettingsDescription')}</p>
                </div>
                <AgentResourceSelect
                  icon={Blocks}
                  label={t('toolkits')}
                  name="toolkitId"
                  options={createOptions.toolkits}
                  selectedIds={selectedToolkitIds}
                  onSelectionChange={setSelectedToolkitIds}
                />
              </section>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-3 sm:px-6">
            <Button type="button" onClick={closeCreateForm} variant={"secondary"}>
              <X className="size-4 shrink-0" />
              {t('cancel')}
            </Button>
            {createStepIndex > 0 ? (
              <Button type="button" onClick={() => setCreateStep(createSteps[createStepIndex - 1]!.id)} variant={"secondary"}>
                <ChevronLeft className="size-4 shrink-0" />
                {t('back')}
              </Button>
            ) : null}
            {lastCreateStep ? (
              <SubmitButton
                pendingLabel={t('creatingAgent')}
                savedLabel={t('agentCreated')}
                disabled={!createReady}
                variant="primary"
              >
                <Plus className="size-[18px] shrink-0" />
                {t('createAgent')}
              </SubmitButton>
            ) : (
              <Button type="button" disabled={activeCreateStep === 'basic' && !createReady} onClick={() => {
                  const form = document.getElementById('agent-create-form') as HTMLFormElement | null;
                  if (activeCreateStep === 'basic' && form && !form.reportValidity()) return;
                  setCreateStep(createSteps[createStepIndex + 1]!.id);
                }} variant={"primary"}>
                {t('next')}
                <ChevronRight className="size-4 shrink-0" />
              </Button>
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
            <ButtonLink href={`/app/${encodeURIComponent(slug)}/providers`} variant="secondary">
              <Cpu className="size-4" />
              {t('addModelProvider')}
            </ButtonLink>
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
                            : 'text-muted-foreground text-muted-foreground',
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
                          <AnimatedBadge status={ready ? 'success' : 'warning'}>
                            {ready ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                            {ready
                              ? t('ready')
                              : isDedicatedSandboxRuntimeKind(agent.runtimeKind) && !agent.sandboxReady
                                ? t('needsSandbox')
                                : agent.runtimeKind === 'hermes' || !agent.providerName
                                ? t('needsProvider')
                                : t('needsModel')}
                          </AnimatedBadge>
                          <AnimatedBadge status="neutral">
                            {agent.runtimeKind === 'hermes' ? <Container className="size-3.5" /> : <Bot className="size-3.5" />}
                            {agentRuntimeDisplayName(agent.runtimeKind)}
                            {agent.runtimeStatus ? ` · ${agent.runtimeStatus}` : ''}
                          </AnimatedBadge>
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
                        <ButtonLink href={`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(agent.id)}`} aria-label={t('chat')} title={t('chat')} variant="primary" size="icon" className="shrink-0">
                          <MessageSquare className="size-[18px] shrink-0" />
                        </ButtonLink>
                      ) : null}
                      <ButtonLink href={detailsHref} aria-label={t('settings')} title={t('settings')} variant="secondary" size="icon" className="shrink-0">
                        <Settings2 className="size-[18px] shrink-0" />
                      </ButtonLink>
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
