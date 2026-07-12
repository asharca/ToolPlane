'use client';

import { useTranslations } from 'next-intl';
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

type Provider = { id: string; name: string; models: string[] };
type Option = { id: string; label: string; checked: boolean; running?: boolean };
type SaveStatus = 'idle' | 'dirty';

function checkedIds(options: Option[]) {
  return new Set(options.filter((option) => option.checked).map((option) => option.id));
}

function toggleId(previous: Set<string>, id: string, checked: boolean) {
  const next = new Set(previous);
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
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
  deployments: Option[];
  skills: Option[];
  toolkits: Option[];
  sandboxes: Option[];
  subAgents: Option[];
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
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(updateAgentAction, {});
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
      ? t('saving')
      : saveStatus === 'dirty'
        ? t('unsavedChanges')
        : state.savedAt
          ? t('saved')
          : t('autoSaveOn');

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
                formAction={syncAgentRuntimeAction}
                formNoValidate
                className="ui-button-secondary h-9 gap-2 px-3 text-xs"
              >
                <RefreshCw className="size-4" />
                {t('syncRuntime')}
              </button>
              <button
                type="submit"
                formAction={stopAgentRuntimeAction}
                formNoValidate
                className="ui-button-secondary h-9 gap-2 px-3 text-xs"
              >
                <Square className="size-3.5" />
                {t('stopRuntime')}
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
                <span className="text-xs text-foreground">{new Date(runtime.lastSyncedAt).toLocaleString()}</span>
              </div>
            ) : null}
            {runtime.lastError ? (
              <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {runtime.lastError}
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
        <div className="grid gap-3 px-4 py-4 lg:grid-cols-2">
          <CheckGroup
            icon={Server}
            legend="MCP"
            name="deploymentId"
            options={deployments}
            selectedIds={selectedDeploymentIds}
            onToggle={(id, checked) => setSelectedDeploymentIds((previous) => toggleId(previous, id, checked))}
          />
          <CheckGroup
            icon={PackageCheck}
            legend="Skills"
            name="installedSkillId"
            options={skills}
            selectedIds={selectedSkillIds}
            onToggle={(id, checked) => setSelectedSkillIds((previous) => toggleId(previous, id, checked))}
          />
          <CheckGroup
            icon={Blocks}
            legend="Toolkits"
            name="toolkitId"
            options={toolkits}
            selectedIds={selectedToolkitIds}
            onToggle={(id, checked) => setSelectedToolkitIds((previous) => toggleId(previous, id, checked))}
          />
          <CheckGroup
            icon={Box}
            legend="Sandboxes"
            name="sandboxId"
            options={sandboxes}
            selectedIds={selectedSandboxIds}
            onToggle={(id, checked) => setSelectedSandboxIds((previous) => toggleId(previous, id, checked))}
          />
          <CheckGroup
            icon={Users}
            legend="Sub-agents"
            name="subAgentId"
            options={subAgents}
            selectedIds={selectedSubAgentIds}
            onToggle={(id, checked) => setSelectedSubAgentIds((previous) => toggleId(previous, id, checked))}
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
          {isPending ? t('saving') : t('saveNow')}
        </button>
      </div>
    </form>
  );
}

function CheckGroup({
  icon: Icon,
  legend,
  name,
  options,
  selectedIds,
  onToggle,
}: {
  icon: typeof Bot;
  legend: string;
  name: string;
  options: Option[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const t = useTranslations('console.agents');
  return (
    <fieldset className="rounded-md border border-border bg-muted/15 p-3">
      <legend className="px-1">
        <span className="inline-flex items-center gap-2 text-xs font-semibold text-foreground">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {legend}
        </span>
      </legend>
      {options.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">{t('nothingAvailableInThisWorkspace')}</p>
      ) : (
        <div className="grid gap-2">
          {options.map((o) => (
            <label
              key={o.id}
              className="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-foreground transition-colors hover:bg-background"
            >
              <input
                type="checkbox"
                name={name}
                value={o.id}
                checked={selectedIds.has(o.id)}
                onChange={(event) => onToggle(o.id, event.target.checked)}
                className="size-4"
              />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.running === false ? (
                <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] uppercase text-muted-foreground">
                  {t('stopped')}
                </span>
              ) : null}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
