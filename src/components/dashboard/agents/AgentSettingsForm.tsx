'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import {
  Blocks,
  Bot,
  Box,
  BrainCircuit,
  Check,
  Container,
  Cpu,
  FileText,
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
  updateAgentAction,
  type ActionState,
} from '@/lib/agents/actions';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import { formatInTimeZone } from '@/lib/timezone';
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from '@/components/dashboard/agents/AgentResourceSelect';
import { useUserTimeZone } from '@/components/timezone/UserTimeZoneContext';

type Provider = { id: string; name: string; models: string[] };
type SaveStatus = 'idle' | 'dirty';

function checkedIds(options: AgentResourceOption[]) {
  return new Set(options.filter((option) => option.checked).map((option) => option.id));
}

export function AgentSettingsForm({
  slug,
  agentId,
  name,
  systemPrompt,
  providerId,
  model,
  maxSteps,
  providers,
  deployments,
  skills,
  toolkits,
  sandboxes,
  subAgents,
  runtime = null,
  className = 'max-w-2xl space-y-5 px-8 py-6',
}: {
  slug: string;
  agentId: string;
  name: string;
  systemPrompt: string;
  providerId: string | null;
  model: string | null;
  maxSteps: number;
  providers: Provider[];
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
  sandboxes: AgentResourceOption[];
  subAgents: AgentResourceOption[];
  runtime?: {
    kind: string;
    image: string;
    status: string;
    lastError: string | null;
    lastSyncedAt: string | null;
    sandboxId: string;
  } | null;
  className?: string;
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
  const [nameValue, setNameValue] = useState(name);
  const [systemPromptValue, setSystemPromptValue] = useState(systemPrompt);
  const [selectedProvider, setSelectedProvider] = useState(providerId ?? '');
  const [selectedModel, setSelectedModel] = useState(model ?? '');
  const [maxStepsValue, setMaxStepsValue] = useState(String(maxSteps));
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState(() => checkedIds(deployments));
  const [selectedSkillIds, setSelectedSkillIds] = useState(() => checkedIds(skills));
  const [selectedToolkitIds, setSelectedToolkitIds] = useState(() => checkedIds(toolkits));
  const [selectedSandboxIds, setSelectedSandboxIds] = useState(() => checkedIds(sandboxes));
  const [selectedSubAgentIds, setSelectedSubAgentIds] = useState(() => checkedIds(subAgents));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastRuntimeAction, setLastRuntimeAction] = useState<'sync' | 'stop' | null>(null);
  const models = useMemo(
    () => providers.find((p) => p.id === selectedProvider)?.models ?? [],
    [providers, selectedProvider],
  );
  const modelOptions = useMemo(() => {
    if (selectedModel && !models.includes(selectedModel)) return [selectedModel, ...models];
    return models;
  }, [models, selectedModel]);

  useEffect(() => {
    if (!state.savedAt) return;

    router.refresh();
  }, [router, state.savedAt]);

  useEffect(() => {
    if (!syncState.savedAt && !stopState.savedAt) return;

    router.refresh();
  }, [router, stopState.savedAt, syncState.savedAt]);

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

  const saveMessage = state.error
    ? state.error
    : isPending
      ? runtime?.kind === 'hermes' ? t('savingAndSyncingRuntime') : t('saving')
      : saveStatus === 'dirty'
        ? t('unsavedChanges')
        : state.savedAt
          ? t('saved')
          : t('autoSaveOn');
  const activeRuntimeState = lastRuntimeAction === 'sync' ? syncState : stopState;
  const runtimeActionPending = lastRuntimeAction === 'sync' ? isSyncPending : isStopPending;
  const runtimeActionMessage = runtimeActionPending
    ? lastRuntimeAction === 'sync' ? t('syncingRuntime') : t('stoppingRuntime')
    : activeRuntimeState.error
      ? activeRuntimeState.error
      : activeRuntimeState.savedAt
        ? lastRuntimeAction === 'sync' ? t('runtimeSynced') : t('runtimeStopped')
        : null;
  const runtimeControlsDisabled = isPending
    || saveStatus === 'dirty'
    || isSyncPending
    || isStopPending;

  return (
    <form
      ref={formRef}
      action={formAction}
      onChange={scheduleAutoSave}
      onSubmit={handleSubmit}
      className={className}
    >
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />

      <section className="rounded-md border border-border bg-background">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Bot className="size-[18px] shrink-0 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t('agent')}</h3>
        </div>
        <div className="space-y-4 px-4 py-4">
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

          {runtime?.kind !== 'hermes' ? (
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <FileText className="size-4 shrink-0" />
                {t('systemPrompt')}
              </span>
              <textarea
                name="systemPrompt"
                value={systemPromptValue}
                onChange={(event) => setSystemPromptValue(event.target.value)}
                rows={5}
                placeholder={t('youAreAHelpfulAssistant')}
                className="ui-input min-h-32 w-full resize-y py-3"
              />
            </label>
          ) : null}
        </div>
      </section>

      {runtime?.kind === 'hermes' ? (
        <section className="rounded-md border border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
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
              <span className="text-muted-foreground">Sandbox</span>
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
        </section>
      ) : null}

      <section className="rounded-md border border-border bg-background">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <BrainCircuit className="size-[18px] shrink-0 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t('model')}</h3>
        </div>
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Cpu className="size-4 shrink-0" />
              {t('provider')}
            </span>
            <select
              name="providerId"
              value={selectedProvider}
              onChange={(event) => {
                setSelectedProvider(event.target.value);
                setSelectedModel('');
              }}
              className="ui-input h-10 w-full"
            >
              <option value="">{t('none')}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <BrainCircuit className="size-4 shrink-0" />
              {t('model')}
            </span>
            <select
              name="model"
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className="ui-input h-10 w-full"
            >
              <option value="">{t('select')}</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="block">
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
          {selectedProvider && models.length === 0 ? (
            <p className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 sm:col-span-3">
              {t('thisProviderHasNoCachedModelsRefreshItsModelsOnTheModelProvidersTab')}
            </p>
          ) : null}
        </div>
      </section>

      <section className="rounded-md border border-border bg-background">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Blocks className="size-[18px] shrink-0 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t('tools')}</h3>
        </div>
        <div className="grid items-start gap-3 px-4 py-4 lg:grid-cols-2">
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
          <AgentResourceSelect
            icon={Box}
            label={t('sandboxes')}
            name="sandboxId"
            options={sandboxes}
            selectedIds={selectedSandboxIds}
            onSelectionChange={(next) => {
              setSelectedSandboxIds(next);
              scheduleAutoSave();
            }}
          />
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

      <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-5 py-3 backdrop-blur">
        <div
          className={`flex min-w-0 items-center gap-2 text-sm ${state.error ? 'text-red-600' : 'text-muted-foreground'}`}
          role={state.error ? 'alert' : 'status'}
        >
          {isPending ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : state.savedAt && saveStatus !== 'dirty' ? (
            <Check className="size-4 shrink-0 text-emerald-600" />
          ) : null}
          <span className="truncate">{saveMessage}</span>
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="ui-button-secondary h-10 gap-2 px-4 disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : state.savedAt && saveStatus !== 'dirty' ? (
            <Check className="size-4 shrink-0" />
          ) : (
            <Save className="size-4 shrink-0" />
          )}
          {isPending && runtime?.kind === 'hermes' ? t('savingAndSyncingRuntime') : isPending ? t('saving') : t('saveNow')}
        </button>
      </div>
    </form>
  );
}
