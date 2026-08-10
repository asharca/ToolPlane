'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useFormStatus } from 'react-dom';
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  CircleSlash2,
  Code2,
  Globe2,
  KeyRound,
  Loader2,
  RotateCcwKey,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { CopyButton } from '@/components/dashboard/CopyButton';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  createAgentApiClientAction,
  createAgentApiKeyAction,
  createAgentClientTokenAction,
  publishAgentEndpointAction,
  revokeAgentApiKeyAction,
  setAgentEndpointStatusAction,
} from '@/lib/agents/public-api/actions';

export type AgentApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type AgentApiClientView = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  keys: AgentApiKeyView[];
};

export type AgentEndpointView = {
  id: string;
  status: string;
  name: string;
  isolationMode: string;
  rpmLimit: number;
  dailyRequestLimit: number;
  dailyOutputCharacterLimit: number;
  maxConcurrent: number;
  maxRuntimes: number;
  maxStoredCharacters: number;
  timeoutSeconds: number;
  retentionDays: number;
  systemPrompt: string;
  allowedOrigins: string[];
  revision: number;
  deploymentIds?: string[];
  skillIds?: string[];
  clients: AgentApiClientView[];
};

type ActionState = {
  error?: string | null;
  success?: boolean;
  savedAt?: string;
  endpointId?: string;
  clientId?: string;
  apiKey?: string;
  key?: string;
  secret?: string;
  token?: string;
  clientToken?: string;
  expiresAt?: string;
};

type StatefulAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const publishAction = publishAgentEndpointAction as StatefulAction;
const createClientAction = createAgentApiClientAction as StatefulAction;
const createKeyAction = createAgentApiKeyAction as StatefulAction;
const createClientTokenAction = createAgentClientTokenAction as StatefulAction;

function checkedIds(options: AgentResourceOption[], explicit?: string[]) {
  return new Set(explicit ?? options.filter((option) => option.checked).map((option) => option.id));
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function SubmitButton({ idle, pending }: { idle: string; pending: string }) {
  const status = useFormStatus();
  return (
    <button type="submit" disabled={status.pending} className="ui-button-primary gap-2 disabled:opacity-60">
      {status.pending ? <Loader2 className="size-4 animate-spin" /> : null}
      {status.pending ? pending : idle}
    </button>
  );
}

function ActionMessage({ state, success }: { state: ActionState; success: string }) {
  if (state.error) {
    return <p className="text-sm text-red-600 dark:text-red-400" role="alert">{state.error}</p>;
  }
  if (state.success || state.savedAt || state.endpointId || state.clientId) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-4" />
        {success}
      </p>
    );
  }
  return null;
}

function SecretReveal({
  label,
  warning,
  secret,
}: {
  label: string;
  warning: string;
  secret: string;
}) {
  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{label}</p>
      <p className="mt-1 text-xs leading-5 text-emerald-800 dark:text-emerald-300">{warning}</p>
      <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-emerald-200 bg-background px-3 py-2 font-mono text-xs text-foreground dark:border-emerald-500/30">
          {secret}
        </code>
        <CopyButton text={secret} />
      </div>
    </div>
  );
}

function ResourceChecklist({
  legend,
  options,
  selected,
  setSelected,
  name,
  disabled,
}: {
  legend: string;
  options: AgentResourceOption[];
  selected: ReadonlySet<string>;
  setSelected: (next: Set<string>) => void;
  name: string;
  disabled: boolean;
}) {
  const t = useTranslations('console.agents');

  return (
    <fieldset className="min-w-0 rounded-md border border-border bg-muted/10 p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-semibold text-foreground">{legend}</legend>
      {options.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t('nothingAvailableInThisWorkspace')}</p>
      ) : (
        <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
          {options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
            >
              <input
                type="checkbox"
                name={name}
                value={option.id}
                checked={selected.has(option.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(option.id);
                  else next.delete(option.id);
                  setSelected(next);
                }}
                className="mt-0.5 size-4 rounded border-border"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{option.label}</span>
                {option.description || option.status ? (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {[option.description, option.status].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function CodeSnippet({ title, code }: { title: string; code: string }) {
  const t = useTranslations('console.agents');
  return (
    <section className="overflow-hidden rounded-md border border-border bg-zinc-950">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium text-zinc-300">{title}</span>
        <CopyButton text={code} label={t('copyCode')} />
      </header>
      <pre className="overflow-x-auto p-4 text-xs leading-5 text-zinc-100"><code>{code}</code></pre>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('console.agents');
  const active = status === 'active' || status === 'enabled' || status === 'published';
  return (
    <span className={cx(
      'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium',
      active
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
    )}>
      <span className={cx('size-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-zinc-400')} />
      {active ? t('agentApiActive') : t('agentApiDisabled')}
    </span>
  );
}

export function AgentApiPanel({
  workspaceSlug,
  agentId,
  agentName,
  origin,
  canManage,
  endpoint,
  deployments,
  skills,
}: {
  workspaceSlug: string;
  agentId: string;
  agentName: string;
  origin: string;
  canManage: boolean;
  endpoint: AgentEndpointView | null;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
}) {
  const t = useTranslations('console.agents');
  const router = useRouter();
  const [publishState, publishFormAction] = useActionState<ActionState, FormData>(publishAction, {});
  const [clientState, clientFormAction] = useActionState<ActionState, FormData>(createClientAction, {});
  const [keyState, keyFormAction] = useActionState<ActionState, FormData>(createKeyAction, {});
  const [tokenState, tokenFormAction] = useActionState<ActionState, FormData>(createClientTokenAction, {});
  const [selectedDeployments, setSelectedDeployments] = useState(
    () => checkedIds(deployments, endpoint?.deploymentIds),
  );
  const [selectedSkills, setSelectedSkills] = useState(
    () => checkedIds(skills, endpoint?.skillIds),
  );
  const [snippet, setSnippet] = useState<'curl' | 'javascript' | 'python'>('curl');
  const apiKey = keyState.token ?? keyState.apiKey ?? keyState.key ?? keyState.secret
    ?? clientState.token ?? clientState.apiKey ?? clientState.key ?? clientState.secret ?? null;
  const clientToken = tokenState.clientToken ?? tokenState.token ?? tokenState.secret ?? null;
  const responseUrl = endpoint
    ? `${origin}/api/v1/agent-endpoints/${endpoint.id}/responses`
    : `${origin}/api/v1/agent-endpoints/{endpoint_id}/responses`;
  const openAiBaseUrl = `${origin}/api/openai/v1`;
  const model = endpoint?.id ?? 'agep_your_endpoint';
  const snippets = useMemo(() => ({
    curl: [
      `curl ${JSON.stringify(responseUrl)} \\`,
      '  -H "Authorization: Bearer $TOOLPLANE_AGENT_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -H "Idempotency-Key: request-$(uuidgen)" \\',
      `  -d '${JSON.stringify({
        input: `Ask ${agentName} a question`,
        end_user: 'customer_42',
        stream: false,
      })}'`,
    ].join('\n'),
    javascript: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.TOOLPLANE_AGENT_API_KEY,
  baseURL: ${JSON.stringify(openAiBaseUrl)},
});

const response = await client.chat.completions.create({
  model: ${JSON.stringify(model)},
  messages: [{ role: "user", content: "Hello" }],
  user: "customer_42",
});

console.log(response.choices[0].message.content);`,
    python: `from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ["TOOLPLANE_AGENT_API_KEY"],
    base_url=${JSON.stringify(openAiBaseUrl)},
)

response = client.chat.completions.create(
    model=${JSON.stringify(model)},
    messages=[{"role": "user", "content": "Hello"}],
    user="customer_42",
)

print(response.choices[0].message.content)`,
  }), [agentName, model, openAiBaseUrl, responseUrl]);

  useEffect(() => {
    if (
      publishState.savedAt || publishState.endpointId || publishState.success
      || clientState.savedAt || clientState.clientId || clientState.success
      || keyState.savedAt || keyState.clientId || keyState.success
    ) {
      router.refresh();
    }
  }, [
    clientState.clientId,
    clientState.savedAt,
    clientState.success,
    keyState.clientId,
    keyState.savedAt,
    keyState.success,
    publishState.endpointId,
    publishState.savedAt,
    publishState.success,
    router,
  ]);

  const endpointActive = endpoint
    ? ['active', 'enabled', 'published'].includes(endpoint.status)
    : false;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 sm:px-6">
      <section className="ui-panel overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-base font-semibold text-foreground">{t('agentApiTitle')}</h3>
              {endpoint ? <StatusBadge status={endpoint.status} /> : null}
              {endpoint ? (
                <span className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {t('agentApiRevision', { revision: endpoint.revision })}
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {t('agentApiDescription')}
            </p>
          </div>
          {endpoint && canManage ? (
            <form action={setAgentEndpointStatusAction}>
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="endpointId" value={endpoint.id} />
              <input type="hidden" name="status" value={endpointActive ? 'disabled' : 'active'} />
              <button
                type="submit"
                className={cx(
                  'ui-button-secondary shrink-0 gap-2',
                  endpointActive && 'text-red-600 dark:text-red-400',
                )}
              >
                {endpointActive ? <CircleSlash2 className="size-4" /> : <Globe2 className="size-4" />}
                {endpointActive ? t('disableAgentApi') : t('enableAgentApi')}
              </button>
            </form>
          ) : null}
        </div>

        {endpoint ? (
          <div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <label className="min-w-0 space-y-1.5">
              <span className="block text-xs font-semibold text-foreground">{t('responsesEndpoint')}</span>
              <code className="block overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs text-foreground">
                {responseUrl}
              </code>
            </label>
            <CopyButton text={responseUrl} label={t('copyEndpoint')} />
          </div>
        ) : (
          <div className="px-5 py-4 text-sm text-muted-foreground">
            {canManage ? t('publishAgentApiToCreateEndpoint') : t('agentApiNotPublished')}
          </div>
        )}
      </section>

      {!canManage ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {t('agentApiManagePermissionRequired')}
        </div>
      ) : null}

      <section className="ui-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold text-foreground">{t('agentApiConfiguration')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentApiConfigurationHelp')}</p>
        </div>
        <form action={publishFormAction} className="space-y-5 px-5 py-5">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="agentId" value={agentId} />
          {endpoint ? <input type="hidden" name="endpointId" value={endpoint.id} /> : null}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="block text-xs font-semibold text-foreground">{t('agentApiEndpointName')}</span>
              <input
                className="ui-input h-10"
                name="name"
                defaultValue={endpoint?.name ?? agentName}
                maxLength={80}
                required
                disabled={!canManage}
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-xs font-semibold text-foreground">{t('agentApiIsolationMode')}</span>
              <NativeSelect
                name="isolationMode"
                defaultValue={endpoint?.isolationMode ?? 'subject'}
                disabled={!canManage}
                className="h-10"
              >
                <option value="subject">{t('agentApiSubjectIsolation')}</option>
                <option value="shared">{t('agentApiSharedIsolation')}</option>
              </NativeSelect>
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="block text-xs font-semibold text-foreground">{t('agentApiSystemPrompt')}</span>
            <textarea
              name="systemPrompt"
              defaultValue={endpoint?.systemPrompt ?? ''}
              rows={4}
              maxLength={20_000}
              disabled={!canManage}
              placeholder={t('agentApiSystemPromptPlaceholder')}
              className="ui-input min-h-28 resize-y py-2.5"
            />
            <span className="block text-xs leading-5 text-muted-foreground">{t('agentApiSystemPromptHelp')}</span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ['rpmLimit', t('agentApiRpmLimit'), endpoint?.rpmLimit ?? 60, 1, 10_000],
              ['dailyRequestLimit', t('agentApiDailyLimit'), endpoint?.dailyRequestLimit ?? 1_000, 1, 1_000_000],
              ['dailyOutputCharacterLimit', t('agentApiDailyOutputLimit'), endpoint?.dailyOutputCharacterLimit ?? 100_000_000, 200_000, 1_000_000_000],
              ['maxConcurrent', t('agentApiConcurrency'), endpoint?.maxConcurrent ?? 5, 1, 100],
              ['maxRuntimes', t('agentApiRuntimeLimit'), endpoint?.maxRuntimes ?? 100, 1, 1_000],
              ['maxStoredCharacters', t('agentApiStorageLimit'), endpoint?.maxStoredCharacters ?? 250_000_000, 220_000, 1_000_000_000],
              ['timeoutSeconds', t('agentApiTimeout'), endpoint?.timeoutSeconds ?? 300, 10, 840],
              ['retentionDays', t('agentApiRetention'), endpoint?.retentionDays ?? 30, 0, 365],
            ] as const).map(([name, label, defaultValue, min, max]) => (
              <label key={name} className="space-y-1.5">
                <span className="block text-xs font-semibold text-foreground">{label}</span>
                <input
                  className="ui-input h-10"
                  type="number"
                  name={name}
                  defaultValue={defaultValue}
                  min={min}
                  max={max}
                  required
                  disabled={!canManage}
                />
              </label>
            ))}
          </div>

          <label className="block space-y-1.5">
            <span className="block text-xs font-semibold text-foreground">{t('agentApiAllowedOrigins')}</span>
            <textarea
              name="allowedOrigins"
              defaultValue={endpoint?.allowedOrigins.join('\n') ?? ''}
              rows={3}
              disabled={!canManage}
              placeholder="https://app.example.com"
              className="ui-input min-h-24 resize-y py-2.5 font-mono text-xs"
            />
            <span className="block text-xs leading-5 text-muted-foreground">{t('agentApiAllowedOriginsHelp')}</span>
          </label>

          <div>
            <div className="mb-3">
              <h4 className="text-sm font-semibold text-foreground">{t('agentApiPublicResources')}</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentApiPublicResourcesHelp')}</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <ResourceChecklist
                legend={t('agentApiAllowedMcp')}
                name="deploymentIds"
                options={deployments}
                selected={selectedDeployments}
                setSelected={setSelectedDeployments}
                disabled={!canManage}
              />
              <ResourceChecklist
                legend={t('agentApiAllowedSkills')}
                name="skillIds"
                options={skills}
                selected={selectedSkills}
                setSelected={setSelectedSkills}
                disabled={!canManage}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <ActionMessage state={publishState} success={t('agentApiPublished')} />
            {canManage ? (
              <SubmitButton
                idle={endpoint ? t('publishNewRevision') : t('publishAgentApi')}
                pending={t('publishingAgentApi')}
              />
            ) : null}
          </div>
        </form>
      </section>

      <section className="ui-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="size-4 text-muted-foreground" />
            {t('agentApiClientsAndKeys')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentApiClientsAndKeysHelp')}</p>
        </div>
        <div className="space-y-5 px-5 py-5">
          {apiKey ? (
            <SecretReveal
              label={t('agentApiNewKey')}
              warning={t('agentApiSecretRevealWarning')}
              secret={apiKey}
            />
          ) : null}

          {endpoint && canManage ? (
            <form action={clientFormAction} className="flex flex-col gap-3 rounded-md border border-border bg-muted/10 p-4 sm:flex-row sm:items-end">
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="endpointId" value={endpoint.id} />
              <label className="min-w-0 flex-1 space-y-1.5">
                <span className="block text-xs font-semibold text-foreground">{t('agentApiClientName')}</span>
                <input
                  name="name"
                  className="ui-input h-10"
                  placeholder={t('agentApiClientNamePlaceholder')}
                  maxLength={80}
                  required
                />
              </label>
              <SubmitButton idle={t('createAgentApiClient')} pending={t('creatingAgentApiClient')} />
            </form>
          ) : null}
          <ActionMessage state={clientState} success={t('agentApiClientCreated')} />

          {!endpoint || endpoint.clients.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
              <KeyRound className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium text-foreground">{t('noAgentApiClients')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('noAgentApiClientsHelp')}</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {endpoint.clients.map((client) => (
                <li key={client.id} className="rounded-md border border-border">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/10 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{client.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('agentApiClientMetadata', { createdAt: client.createdAt, count: client.keys.length })}
                      </p>
                    </div>
                    {canManage ? (
                      <form action={keyFormAction} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="workspace" value={workspaceSlug} />
                        <input type="hidden" name="agentId" value={agentId} />
                        <input type="hidden" name="endpointId" value={endpoint.id} />
                        <input type="hidden" name="clientId" value={client.id} />
                        <label className="space-y-1">
                          <span className="block text-xs font-semibold text-foreground">{t('agentApiKeyName')}</span>
                          <input
                            name="name"
                            className="ui-input h-9 w-40"
                            placeholder={t('agentApiKeyNamePlaceholder')}
                            maxLength={80}
                            required
                          />
                        </label>
                        <SubmitButton idle={t('createAgentApiKey')} pending={t('creatingAgentApiKey')} />
                      </form>
                    ) : null}
                  </div>
                  {client.keys.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-muted-foreground">{t('noActiveAgentApiKeys')}</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {client.keys.map((key) => (
                        <li key={key.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-foreground">{key.name}</p>
                            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{key.prefix}…</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {key.revokedAt
                                ? t('agentApiKeyRevokedAt', { date: key.revokedAt })
                                : key.lastUsedAt
                                  ? t('agentApiKeyLastUsedAt', { date: key.lastUsedAt })
                                  : t('agentApiKeyNeverUsed')}
                              {key.expiresAt ? ` · ${t('agentApiKeyExpiresAt', { date: key.expiresAt })}` : ''}
                            </p>
                          </div>
                          {!key.revokedAt && canManage ? (
                            <form action={revokeAgentApiKeyAction}>
                              <input type="hidden" name="workspace" value={workspaceSlug} />
                              <input type="hidden" name="agentId" value={agentId} />
                              <input type="hidden" name="endpointId" value={endpoint.id} />
                              <input type="hidden" name="keyId" value={key.id} />
                              <button type="submit" className="ui-button-secondary ui-button-sm gap-1.5 text-red-600 dark:text-red-400">
                                <Trash2 className="size-3.5" />
                                {t('revokeAgentApiKey')}
                              </button>
                            </form>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <ActionMessage state={keyState} success={t('agentApiKeyCreated')} />

          {endpoint && endpoint.clients.length > 0 && canManage ? (
            <details className="rounded-md border border-border bg-muted/10">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">
                {t('agentApiBrowserToken')}
              </summary>
              <form action={tokenFormAction} className="grid gap-3 border-t border-border px-4 py-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
                <input type="hidden" name="workspace" value={workspaceSlug} />
                <input type="hidden" name="agentId" value={agentId} />
                <input type="hidden" name="endpointId" value={endpoint.id} />
                <label className="space-y-1.5">
                  <span className="block text-xs font-semibold text-foreground">{t('agentApiClient')}</span>
                  <NativeSelect name="clientId" className="h-10">
                    {endpoint.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                  </NativeSelect>
                </label>
                <label className="space-y-1.5">
                  <span className="block text-xs font-semibold text-foreground">{t('agentApiSubject')}</span>
                  <input name="subject" className="ui-input h-10" maxLength={200} required placeholder="customer_42" />
                </label>
                <label className="space-y-1.5">
                  <span className="block text-xs font-semibold text-foreground">{t('agentApiAllowedOrigins')}</span>
                  <NativeSelect name="origin" className="h-10" required>
                    {endpoint.allowedOrigins.length === 0 ? (
                      <option value="">{t('agentApiAllowedOrigins')}</option>
                    ) : endpoint.allowedOrigins.map((origin) => (
                      <option key={origin} value={origin}>{origin}</option>
                    ))}
                  </NativeSelect>
                </label>
                <SubmitButton idle={t('createAgentClientToken')} pending={t('creatingAgentClientToken')} />
              </form>
              {clientToken ? (
                <div className="border-t border-border p-4">
                  <SecretReveal
                    label={t('agentApiNewClientToken')}
                    warning={t('agentApiClientTokenWarning')}
                    secret={clientToken}
                  />
                </div>
              ) : null}
              {tokenState.error ? <p className="px-4 pb-4 text-sm text-red-600 dark:text-red-400" role="alert">{tokenState.error}</p> : null}
            </details>
          ) : null}
        </div>
      </section>

      <section className="ui-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Code2 className="size-4 text-muted-foreground" />
            {t('agentApiIntegration')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentApiIntegrationHelp')}</p>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-border bg-muted/10 p-3">
              <p className="text-xs font-semibold text-foreground">{t('responsesEndpoint')}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{responseUrl}</p>
            </div>
            <div className="rounded-md border border-border bg-muted/10 p-3">
              <p className="text-xs font-semibold text-foreground">{t('openAiCompatibleBaseUrl')}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{openAiBaseUrl}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('agentApiCodeExamples')}>
            {([
              ['curl', t('agentApiCurl')],
              ['javascript', t('agentApiJavaScript')],
              ['python', t('agentApiPython')],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={snippet === value}
                onClick={() => setSnippet(value)}
                className={cx(
                  'ui-button-secondary ui-button-sm gap-1.5',
                  snippet === value && 'border-primary/40 bg-accent text-foreground',
                )}
              >
                {value === 'curl' ? <Braces className="size-3.5" /> : <Code2 className="size-3.5" />}
                {label}
              </button>
            ))}
          </div>
          <CodeSnippet
            title={snippet === 'curl' ? t('agentApiCurl') : snippet === 'javascript' ? t('agentApiJavaScript') : t('agentApiPython')}
            code={snippets[snippet]}
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-300" />
            <div>
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">{t('agentApiKeepKeysServerSide')}</h3>
              <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200">{t('agentApiKeepKeysServerSideHelp')}</p>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-4">
          <div className="flex items-start gap-3">
            {endpoint?.isolationMode === 'shared'
              ? <Server className="mt-0.5 size-5 shrink-0 text-blue-600 dark:text-blue-300" />
              : <ShieldCheck className="mt-0.5 size-5 shrink-0 text-blue-600 dark:text-blue-300" />}
            <div>
              <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                {endpoint?.isolationMode === 'shared' ? t('agentApiSharedIsolationWarning') : t('agentApiSubjectIsolationNotice')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-blue-800 dark:text-blue-200">
                {endpoint?.isolationMode === 'shared' ? t('agentApiSharedIsolationWarningHelp') : t('agentApiSubjectIsolationNoticeHelp')}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-4 py-3 text-xs leading-5 text-muted-foreground">
        <RotateCcwKey className="mt-0.5 size-4 shrink-0" />
        <span>{t('agentApiRotationHint')}</span>
      </div>
    </div>
  );
}
