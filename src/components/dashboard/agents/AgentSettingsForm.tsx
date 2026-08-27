'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import {
  Blocks,
  Bot,
  Box,
  BrainCircuit,
  Check,
  ChevronDown,
  Container,
  Cpu,
  FileText,
  Hammer,
  Loader2,
  PackageCheck,
  Save,
  Server,
  Square,
  RefreshCw,
  Users,
} from 'lucide-react';
import {
  stopAgentRuntimeAction,
  syncAgentRuntimeAction,
  upgradeHermesRuntimeAction,
  updateHermesRuntimeEnvAction,
  updateAgentAction,
  type ActionState,
} from '@/lib/agents/actions';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import {
  agentRuntimeBuiltinToolGroups,
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  isDedicatedSandboxRuntimeKind,
  type AgentRuntimeBuiltinToolCategory,
} from '@/lib/agents/runtime-kind';
import { formatInTimeZone } from '@/lib/timezone';
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from '@/components/dashboard/agents/AgentResourceSelect';
import { HermesImageSelector } from '@/components/dashboard/agents/HermesImageSelector';
import { ModelPicker } from '@/components/dashboard/models/ModelPicker';
import { useUserTimeZone } from '@/components/timezone/UserTimeZoneContext';

type Provider = { id: string; name: string; format: string; models: string[] };
type SaveStatus = 'idle' | 'dirty';
export type AgentSettingsSection = 'general' | 'instructions' | 'builtInTools' | 'mcp' | 'skills' | 'toolkits' | 'sandboxes' | 'subAgents' | 'advanced';

function checkedIds(options: AgentResourceOption[]) {
  return new Set(options.filter((option) => option.checked).map((option) => option.id));
}

export function AgentSettingsForm({
  slug,
  agentId,
  runtimeKind,
  name,
  systemPrompt,
  providerId,
  providerIds = [],
  model,
  maxSteps,
  providers,
  deployments,
  skills,
  toolkits,
  defaultSandboxId = null,
  sandboxes,
  subAgents,
  runtime = null,
  hermesImages,
  className = 'max-w-2xl space-y-5 px-8 py-6',
  activeSection: controlledActiveSection,
  onSectionChange,
  showNavigation = true,
}: {
  slug: string;
  agentId: string;
  runtimeKind: string;
  name: string;
  systemPrompt: string;
  providerId: string | null;
  providerIds?: string[];
  model: string | null;
  maxSteps: number;
  providers: Provider[];
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
  defaultSandboxId?: string | null;
  sandboxes: AgentResourceOption[];
  subAgents: AgentResourceOption[];
  runtime?: {
    kind: string;
    image: string;
    status: string;
    lastError: string | null;
    lastSyncedAt: string | null;
    sandboxId: string;
    environment?: string;
  } | null;
  hermesImages?: string[];
  className?: string;
  activeSection?: AgentSettingsSection;
  onSectionChange?: (section: AgentSettingsSection) => void;
  showNavigation?: boolean;
}) {
  const t = useTranslations('console.agents');
  const locale = useLocale();
  const { timeZone } = useUserTimeZone();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(updateAgentAction, {});
  const [syncState, syncFormAction, isSyncPending] = useActionState<ActionState, FormData>(
    syncAgentRuntimeAction,
    {},
  );
  const [stopState, stopFormAction, isStopPending] = useActionState<ActionState, FormData>(
    stopAgentRuntimeAction,
    {},
  );
  const [upgradeState, upgradeFormAction, isUpgradePending] = useActionState<ActionState, FormData>(
    upgradeHermesRuntimeAction,
    {},
  );
  const [envState, envFormAction, isEnvPending] = useActionState<ActionState, FormData>(
    updateHermesRuntimeEnvAction,
    {},
  );
  const singleSandboxRuntime = isDedicatedSandboxRuntimeKind(runtimeKind);
  const [nameValue, setNameValue] = useState(name);
  const [systemPromptValue, setSystemPromptValue] = useState(systemPrompt);
  const [selectedProvider, setSelectedProvider] = useState(() => {
    const provider = providers.find((entry) => entry.id === providerId);
    return provider && agentRuntimeSupportsProviderFormat(runtimeKind, provider.format) ? provider.id : '';
  });
  const [selectedProviderIds, setSelectedProviderIds] = useState(() => new Set(providerIds));
  const [selectedModel, setSelectedModel] = useState(model ?? '');
  const [maxStepsValue, setMaxStepsValue] = useState(String(maxSteps));
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState(() => checkedIds(deployments));
  const [selectedSkillIds, setSelectedSkillIds] = useState(() => checkedIds(skills));
  const [selectedToolkitIds, setSelectedToolkitIds] = useState(() => checkedIds(toolkits));
  const [selectedSandboxIds, setSelectedSandboxIds] = useState(() => {
    const selected = checkedIds(sandboxes);
    return singleSandboxRuntime
      ? new Set([...selected].filter((id) => sandboxes.some((sandbox) => (
          sandbox.id === id && sandbox.kind === 'docker' && sandbox.network !== 'none'
        ))).slice(0, 1))
      : selected;
  });
  const [selectedDefaultSandboxId, setSelectedDefaultSandboxId] = useState(() => (
    singleSandboxRuntime
      ? sandboxes.find((sandbox) => (
          sandbox.checked && sandbox.kind === 'docker' && sandbox.network !== 'none'
        ))?.id ?? ''
      : defaultSandboxId ?? ''
  ));
  const [selectedSubAgentIds, setSelectedSubAgentIds] = useState(() => checkedIds(subAgents));
  const [uncontrolledActiveSection, setUncontrolledActiveSection] = useState<AgentSettingsSection>('general');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastRuntimeAction, setLastRuntimeAction] = useState<'sync' | 'stop' | 'upgrade' | null>(null);
  const compatibleProviders = useMemo(
    () => providers.filter((provider) => agentRuntimeSupportsProviderFormat(runtimeKind, provider.format)),
    [providers, runtimeKind],
  );
  const models = useMemo(
    () => compatibleProviders.find((p) => p.id === selectedProvider)?.models ?? [],
    [compatibleProviders, selectedProvider],
  );
  const selectedProviderOption = compatibleProviders.find((provider) => provider.id === selectedProvider) ?? null;
  const providerOptions = useMemo(() => providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    description: t('providerModelCount', { count: provider.models.length }),
    keywords: provider.models,
  })), [providers, t]);
  const sandboxOptions = useMemo(
    () => singleSandboxRuntime
      ? sandboxes.filter((sandbox) => sandbox.kind === 'docker' && sandbox.network !== 'none')
      : sandboxes,
    [sandboxes, singleSandboxRuntime],
  );
  const isHermes = runtimeKind === 'hermes';
  const runtimeLabel = agentRuntimeDisplayName(runtimeKind);
  const builtInToolGroups = agentRuntimeBuiltinToolGroups(runtimeKind);
  const builtInToolCount = builtInToolGroups.reduce((count, group) => count + group.tools.length, 0);
  const builtInToolCategoryLabels: Record<AgentRuntimeBuiltinToolCategory, string> = {
    file: t('toolCategoryFile'),
    shell: t('toolCategoryShell'),
    search: t('toolCategorySearch'),
    context: t('toolCategoryContext'),
    orchestration: t('toolCategoryOrchestration'),
    browser: t('toolCategoryBrowser'),
    media: t('toolCategoryMedia'),
  };
  const selectedProviderNames = providers
    .filter((provider) => selectedProviderIds.has(provider.id))
    .map((provider) => provider.name);
  const selectedCapabilityCount = selectedDeploymentIds.size
    + selectedSkillIds.size
    + selectedToolkitIds.size
    + selectedSandboxIds.size
    + selectedSubAgentIds.size;
  const modelSummary = isHermes
    ? selectedProviderNames.length > 0
      ? t('providerSummary', { count: selectedProviderNames.length, names: selectedProviderNames.join(', ') })
      : t('noModelProvidersSelected')
    : selectedProvider && selectedModel
      ? `${providers.find((provider) => provider.id === selectedProvider)?.name ?? selectedProvider} · ${selectedModel}`
      : selectedProvider
        ? t('needsModel')
        : t('needsProvider');
  const navigationGroups: Array<{
    label: string;
    items: Array<{ id: AgentSettingsSection; label: string; count?: number; icon: typeof Bot }>;
  }> = [
    {
      label: t('basic'),
      items: [
        { id: 'general', label: t('general'), icon: Bot },
        { id: 'instructions', label: t('instructions'), icon: FileText },
      ],
    },
    {
      label: t('tools'),
      items: [
        { id: 'builtInTools', label: t('builtInTools'), count: builtInToolCount, icon: Hammer },
        { id: 'mcp', label: t('mcp'), count: selectedDeploymentIds.size, icon: Server },
        { id: 'skills', label: t('skills'), count: selectedSkillIds.size, icon: PackageCheck },
        { id: 'toolkits', label: t('toolkits'), count: selectedToolkitIds.size, icon: Blocks },
        { id: 'sandboxes', label: t('sandboxes'), count: selectedSandboxIds.size, icon: Box },
        { id: 'subAgents', label: t('subAgents'), count: selectedSubAgentIds.size, icon: Users },
      ],
    },
    {
      label: t('advanced'),
      items: [{ id: 'advanced', label: t('advanced'), icon: BrainCircuit }],
    },
  ];
  const activeSection = controlledActiveSection ?? uncontrolledActiveSection;

  function selectSection(section: AgentSettingsSection) {
    if (controlledActiveSection === undefined) setUncontrolledActiveSection(section);
    onSectionChange?.(section);
  }

  useEffect(() => {
    if (!state.savedAt) return;

    router.refresh();
  }, [router, state.savedAt]);

  useEffect(() => {
    if (!syncState.savedAt && !stopState.savedAt && !upgradeState.savedAt && !envState.savedAt) return;

    router.refresh();
  }, [envState.savedAt, router, stopState.savedAt, syncState.savedAt, upgradeState.savedAt]);

  useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
  }, []);

  function clearAutoSaveTimer() {
    if (!autoSaveTimerRef.current) return;
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
  }

  function scheduleAutoSave() {
    setSaveStatus('dirty');
    clearAutoSaveTimer();
    autoSaveTimerRef.current = setTimeout(() => {
      formRef.current?.requestSubmit();
    }, 700);
  }

  function handleSubmit() {
    clearAutoSaveTimer();
    setSaveStatus('idle');
  }

  function flushAutoSave(event: FocusEvent<HTMLFormElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (!autoSaveTimerRef.current) return;
    clearAutoSaveTimer();
    event.currentTarget.requestSubmit();
  }

  const activeRuntimeState = lastRuntimeAction === 'sync'
    ? syncState
    : lastRuntimeAction === 'stop'
      ? stopState
      : upgradeState;
  const runtimeActionPending = lastRuntimeAction === 'sync'
    ? isSyncPending
    : lastRuntimeAction === 'stop'
      ? isStopPending
      : isUpgradePending;
  const runtimeActionMessage = runtimeActionPending
    ? lastRuntimeAction === 'sync'
      ? t('syncingRuntime')
      : lastRuntimeAction === 'stop'
        ? t('stoppingRuntime')
        : t('upgradingHermesRuntime')
    : activeRuntimeState.error
      ? activeRuntimeState.error
      : activeRuntimeState.savedAt
        ? lastRuntimeAction === 'sync'
          ? t('runtimeSynced')
          : lastRuntimeAction === 'stop'
            ? t('runtimeStopped')
            : t('hermesRuntimeUpgraded')
        : null;
  const runtimeControlsDisabled = isPending
    || saveStatus === 'dirty'
    || isSyncPending
    || isStopPending
    || isUpgradePending
    || isEnvPending;
  const envMessage = isEnvPending
    ? t('savingAndSyncingEnvironment')
    : envState.error
      ? envState.error
      : envState.savedAt
        ? t('environmentSaved')
        : null;

  return (
    <form
      ref={formRef}
      action={formAction}
      onBlur={flushAutoSave}
      onChange={scheduleAutoSave}
      onSubmit={handleSubmit}
      className={className}
    >
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />

      <div className={showNavigation
        ? 'overflow-hidden rounded-xl border border-border bg-background lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)]'
        : 'min-w-0'}>
        {showNavigation ? (
          <nav
            aria-label={t('configurationNavigation')}
            className="bg-muted/20 p-2 lg:p-3"
          >
            <div className="flex min-w-max gap-4 overflow-x-auto px-1 py-1 lg:block lg:min-w-0 lg:space-y-5 lg:overflow-visible">
              {navigationGroups.map((group) => (
                <div key={group.label} className="flex shrink-0 items-center gap-1.5 lg:block lg:space-y-1">
                  <p className="hidden px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground lg:block">
                    {group.label}
                  </p>
                  {group.items.map(({ id, label, count, icon: Icon }) => {
                    const active = activeSection === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => selectSection(id)}
                        className={`inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:w-full ${active
                          ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                          : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="whitespace-nowrap">{label}</span>
                        {typeof count === 'number' ? (
                          <span className={`ml-auto rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${active ? 'bg-muted text-foreground' : 'bg-background/80 text-muted-foreground'}`}>
                            {count}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </nav>
        ) : null}

        <div className={`min-w-0 space-y-5 ${showNavigation ? 'p-4 sm:p-5' : ''}`}>
          {state.error ? (
            <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {state.error}
            </p>
          ) : null}
      <section hidden={activeSection !== 'general'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Bot className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('general')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('generalSettingsDescription')}</p>
          </div>
        </div>
        <div className="space-y-4 px-4 py-4">
          <div className="rounded-lg border border-border bg-muted/25 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {isHermes ? <Container className="size-4 shrink-0 text-muted-foreground" /> : <Bot className="size-4 shrink-0 text-muted-foreground" />}
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('runtimeSummary')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="rounded-md bg-background px-2 py-1 text-xs font-medium text-foreground ring-1 ring-border">
                  {runtimeLabel}
                </span>
                {isHermes && runtime?.status ? (
                  <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{runtime.status}</span>
                ) : null}
              </div>
            </div>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('model')}</dt>
                <dd className="mt-0.5 truncate font-medium text-foreground" title={modelSummary}>{modelSummary}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('tools')}</dt>
                <dd className="mt-0.5 font-medium text-foreground">{t('attachedCapabilities', { count: selectedCapabilityCount })}</dd>
              </div>
            </dl>
          </div>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Bot className="size-4 shrink-0" />
              {t('name')}
            </span>
            <input
              name="name"
              value={nameValue}
              onChange={(event) => setNameValue(event.target.value)}
              required
              className="ui-input h-10 w-full"
            />
          </label>
        </div>
      </section>

      <section hidden={activeSection !== 'instructions'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <FileText className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('instructions')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('instructionsSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          {isHermes ? (
            <p className="rounded-lg border border-border bg-muted/25 px-3 py-3 text-sm leading-6 text-muted-foreground">
              {t('hermesPromptManaged')}
            </p>
          ) : (
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <FileText className="size-4 shrink-0" />
                {t('systemPrompt')}
              </span>
              <textarea
                name="systemPrompt"
                value={systemPromptValue}
                onChange={(event) => setSystemPromptValue(event.target.value)}
                rows={9}
                placeholder={t('youAreAHelpfulAssistant')}
                className="ui-input min-h-52 w-full resize-y py-3"
              />
            </label>
          )}
        </div>
      </section>

      <section hidden={activeSection !== 'advanced'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Blocks className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('advanced')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('advancedSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <label className="block max-w-xs">
            <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Blocks className="size-4 shrink-0" />
              {t('maxToolSteps')}
            </span>
            <input
              name="maxSteps"
              type="number"
              min={AGENT_STEP_BOUNDS.min}
              max={AGENT_STEP_BOUNDS.max}
              value={maxStepsValue}
              onChange={(event) => setMaxStepsValue(event.target.value)}
              className="ui-input h-10 w-full"
            />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('0NoLimit')}</span>
          </label>
        </div>
      </section>

      {isHermes && runtime ? (
        <section hidden={activeSection !== 'advanced'} className="rounded-lg border border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Container className="size-[18px] shrink-0 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Hermes</h3>
              <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 text-xs font-medium text-muted-foreground">
                {runtime.status}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                formAction={syncFormAction}
                formNoValidate
                disabled={runtimeControlsDisabled}
                aria-busy={isSyncPending}
                onClick={() => setLastRuntimeAction('sync')}
                className="ui-button-secondary h-9 gap-2 px-3 text-xs disabled:cursor-wait disabled:opacity-70"
              >
                {isSyncPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : lastRuntimeAction === 'sync' && syncState.savedAt ? (
                  <Check className="size-4 text-emerald-600" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {isSyncPending ? t('syncingRuntime') : lastRuntimeAction === 'sync' && syncState.savedAt ? t('runtimeSynced') : t('syncRuntime')}
              </button>
              <button
                type="submit"
                formAction={stopFormAction}
                formNoValidate
                disabled={runtimeControlsDisabled}
                aria-busy={isStopPending}
                onClick={() => setLastRuntimeAction('stop')}
                className="ui-button-secondary h-9 gap-2 px-3 text-xs disabled:cursor-wait disabled:opacity-70"
              >
                {isStopPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : lastRuntimeAction === 'stop' && stopState.savedAt ? (
                  <Check className="size-4 text-emerald-600" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {isStopPending ? t('stoppingRuntime') : lastRuntimeAction === 'stop' && stopState.savedAt ? t('runtimeStopped') : t('stopRuntime')}
              </button>
            </div>
          </div>
          <div className="space-y-2 px-4 py-4 text-sm">
            <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <span className="text-muted-foreground">{t('dockerImage')}</span>
              <code className="min-w-0 break-all text-xs text-foreground">{runtime.image}</code>
            </div>
            <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <span className="text-muted-foreground">{t('sandbox')}</span>
              <code className="min-w-0 break-all text-xs text-foreground">{runtime.sandboxId}</code>
            </div>
            {runtime.lastSyncedAt ? (
              <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <span className="text-muted-foreground">{t('lastSynced')}</span>
                <span className="text-xs text-foreground">
                  {formatInTimeZone(
                    runtime.lastSyncedAt,
                    timeZone,
                    { dateStyle: 'medium', timeStyle: 'short' },
                    locale,
                  )}
                </span>
              </div>
            ) : null}
            {runtime.lastError ? (
              <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {runtime.lastError}
              </p>
            ) : null}
            {runtimeActionMessage ? (
              <p
                role={activeRuntimeState.error ? 'alert' : 'status'}
                aria-live="polite"
                className={activeRuntimeState.error
                  ? 'rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300'
                  : 'text-xs text-muted-foreground'}
              >
                {runtimeActionMessage}
              </p>
            ) : null}
          </div>
          <div className="space-y-3 border-t border-border px-4 py-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">{t('hermesVersion')}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('hermesRuntimeUpgradeHelp')}</p>
            </div>
            <HermesImageSelector
              key={runtime.image}
              id="settings-hermes-version"
              images={hermesImages}
              value={runtime.image}
              disabled={runtimeControlsDisabled}
            />
            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                type="submit"
                formAction={upgradeFormAction}
                formNoValidate
                disabled={runtimeControlsDisabled}
                aria-busy={isUpgradePending}
                onClick={() => {
                  clearAutoSaveTimer();
                  setLastRuntimeAction('upgrade');
                }}
                className="ui-button-secondary h-9 gap-2 px-3 text-xs disabled:cursor-wait disabled:opacity-70"
              >
                {isUpgradePending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : lastRuntimeAction === 'upgrade' && upgradeState.savedAt ? (
                  <Check className="size-4 text-emerald-600" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {isUpgradePending
                  ? t('upgradingHermesRuntime')
                  : lastRuntimeAction === 'upgrade' && upgradeState.savedAt
                    ? t('hermesRuntimeUpgraded')
                    : t('upgradeHermesRuntime')}
              </button>
            </div>
          </div>
          <div className="space-y-3 border-t border-border px-4 py-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">{t('hermesEnvironmentVariables')}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('hermesEnvironmentHelp')}</p>
            </div>
            <textarea
              name="hermesEnv"
              defaultValue={runtime.environment ?? ''}
              onChange={(event) => event.stopPropagation()}
              rows={6}
              spellCheck={false}
              placeholder={t('hermesEnvPlaceholder')}
              className="ui-input min-h-32 w-full resize-y font-mono text-xs leading-5"
              aria-label={t('hermesEnvironmentVariables')}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p
                role={envState.error ? 'alert' : 'status'}
                aria-live="polite"
                className={envState.error ? 'text-xs text-red-600' : 'text-xs text-muted-foreground'}
              >
                {envMessage}
              </p>
              <button
                type="submit"
                formAction={envFormAction}
                formNoValidate
                disabled={runtimeControlsDisabled}
                aria-busy={isEnvPending}
                onClick={clearAutoSaveTimer}
                className="ui-button-secondary h-9 gap-2 px-3 text-xs disabled:cursor-wait disabled:opacity-70"
              >
                {isEnvPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {isEnvPending ? t('savingAndSyncingEnvironment') : t('saveEnvironment')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section hidden={activeSection !== 'builtInTools'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Hammer className="size-[18px] shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{t('builtInTools')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isHermes
                ? t('hermesBuiltInToolsDescription')
                : t('builtInToolsDescription', { runtime: runtimeLabel })}
            </p>
          </div>
        </div>
        <div className="px-4 py-4">
          <div
            role="list"
            aria-label={t('builtInTools')}
            className="grid gap-x-8 gap-y-5 sm:grid-cols-2"
          >
            {builtInToolGroups.map((group) => (
              <div key={group.category} role="listitem" className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {builtInToolCategoryLabels[group.category]}
                </p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {group.tools.map((tool) => (
                    <code key={tool} className="text-xs text-foreground">{tool}</code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section hidden={activeSection !== 'mcp'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Server className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('mcp')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('resourceSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <AgentResourceSelect
            icon={Server}
            label={t('mcp')}
            name="deploymentId"
            options={deployments}
            selectedIds={selectedDeploymentIds}
            onSelectionChange={(next) => {
              setSelectedDeploymentIds(next);
              scheduleAutoSave();
            }}
          />
        </div>
      </section>

      <section hidden={activeSection !== 'skills'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <PackageCheck className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('skills')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('resourceSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <AgentResourceSelect
            icon={PackageCheck}
            label={t('skills')}
            name="installedSkillId"
            options={skills}
            selectedIds={selectedSkillIds}
            onSelectionChange={(next) => {
              setSelectedSkillIds(next);
              scheduleAutoSave();
            }}
          />
        </div>
      </section>

      <section hidden={activeSection !== 'toolkits'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Blocks className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('toolkits')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('resourceSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <AgentResourceSelect
            icon={Blocks}
            label={t('toolkits')}
            name="toolkitId"
            options={toolkits}
            selectedIds={selectedToolkitIds}
            onSelectionChange={(next) => {
              setSelectedToolkitIds(next);
              scheduleAutoSave();
            }}
          />
        </div>
      </section>

      <section hidden={activeSection !== 'sandboxes'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Box className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('sandboxes')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('resourceSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <AgentResourceSelect
            icon={Box}
            label={t('sandboxes')}
            name="sandboxId"
            options={sandboxOptions}
            selectedIds={selectedSandboxIds}
            onSelectionChange={(next) => {
              setSelectedSandboxIds(next);
              if (!next.has(selectedDefaultSandboxId)) setSelectedDefaultSandboxId([...next][0] ?? '');
              scheduleAutoSave();
            }}
            selectionMode={singleSandboxRuntime ? 'single-required' : 'multiple'}
          />
          {!singleSandboxRuntime && selectedSandboxIds.size ? (
            <label className="mt-3 block text-xs text-muted-foreground">
              <span className="mb-1 block">Default Work sandbox</span>
              <select name="defaultSandboxId" value={selectedDefaultSandboxId} onChange={(event) => { setSelectedDefaultSandboxId(event.target.value); scheduleAutoSave(); }} className="ui-input h-9 w-full">
                {[...selectedSandboxIds].map((id) => <option key={id} value={id}>{sandboxOptions.find((item) => item.id === id)?.label ?? id}</option>)}
              </select>
            </label>
          ) : null}
          {!isHermes ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('nativeHarnessSandboxHelp')}</p> : null}
        </div>
      </section>

      <section hidden={activeSection !== 'subAgents'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Users className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{t('subAgents')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('resourceSettingsDescription')}</p>
          </div>
        </div>
        <div className="px-4 py-4">
          <AgentResourceSelect
            icon={Users}
            label={t('subAgents')}
            name="subAgentId"
            options={subAgents}
            selectedIds={selectedSubAgentIds}
            onSelectionChange={(next) => {
              setSelectedSubAgentIds(next);
              scheduleAutoSave();
            }}
          />
        </div>
      </section>

      <section hidden={activeSection !== 'general'} className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <BrainCircuit className="size-[18px] shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">{isHermes ? t('modelProviders') : t('model')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('generalSettingsDescription')}</p>
          </div>
        </div>
        <div className="grid items-start gap-3 px-4 py-4 sm:grid-cols-2">
          {isHermes ? (
            <div className="space-y-2 sm:col-span-2">
              <AgentResourceSelect
                icon={Cpu}
                label={t('modelProviders')}
                name="providerId"
                options={providerOptions}
                selectedIds={selectedProviderIds}
                onSelectionChange={(next) => {
                  setSelectedProviderIds(next);
                  scheduleAutoSave();
                }}
              />
              <p className="text-xs text-muted-foreground">{t('hermesProviderSelectionHelp')}</p>
            </div>
          ) : (
            <div className="sm:col-span-2">
              <input type="hidden" name="providerId" value={selectedProvider} />
              <input type="hidden" name="model" value={selectedModel} />
              <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <BrainCircuit className="size-4 shrink-0" />
                {t('model')}
              </span>
              <ModelPicker
                providers={compatibleProviders}
                value={selectedProvider && selectedModel
                  ? { providerId: selectedProvider, model: selectedModel }
                  : null}
                onSelect={(selection) => {
                  setSelectedProvider(selection.providerId);
                  setSelectedModel(selection.model);
                  scheduleAutoSave();
                }}
                onConfigure={() => {
                  const returnTo = `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}?settings=agent`;
                  window.location.assign(`/app/${encodeURIComponent(slug)}/settings/providers?returnTo=${encodeURIComponent(returnTo)}`);
                }}
                trigger={(
                  <button type="button" aria-label={`${t('model')}: ${selectedModel || t('selectModel')}`} className="ui-input flex h-10 w-full items-center gap-2 px-3 text-left text-sm text-foreground">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                      {selectedProviderOption?.name.charAt(0).toUpperCase() || 'M'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{selectedModel || t('selectModel')}</span>
                    <span className="hidden max-w-44 truncate text-xs text-muted-foreground sm:block">{selectedProviderOption?.name}</span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                )}
              />
            </div>
          )}
          {!isHermes && selectedProvider && models.length === 0 ? (
            <p className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 sm:col-span-2">
              {t('thisProviderHasNoCachedModelsRefreshItsModelsOnTheModelProvidersTab')}
            </p>
          ) : null}
        </div>
      </section>

        </div>
      </div>
    </form>
  );
}
