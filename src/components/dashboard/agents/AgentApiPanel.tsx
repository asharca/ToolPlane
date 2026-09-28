'use client';
import { BouncyAccordion } from '@/components/motion/bouncy-accordion';
import { Button } from '@/components/motion/button/base';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';
import { FormCheckbox } from '@/components/ui/FormCheckbox';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  CircleSlash2,
  Code2,
  Globe2,
  KeyRound,
  RotateCcwKey,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { CopyButton } from '@/components/dashboard/CopyButton';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';

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

function ActionMessage({ state, success }: { state: ActionState; success: string }) {
  if (state.error) {
    return <p className="text-sm text-destructive text-destructive" role="alert">{state.error}</p>;
  }
  if (state.success || state.savedAt || state.endpointId || state.clientId) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground text-muted-foreground">
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
    <div className="rounded-md border border-border bg-muted p-4 border-border bg-muted">
      <p className="text-sm font-semibold text-muted-foreground text-muted-foreground">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground text-muted-foreground">{warning}</p>
      <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground border-border">
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
            <div key={option.id} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-accent/50">
              <FormCheckbox name={name} value={option.id} checked={selected.has(option.id)} label={option.label} disabled={disabled} onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(option.id);
                  else next.delete(option.id);
                  setSelected(next);
                }} />
              <span className="min-w-0">
                {option.description || option.status ? (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {[option.description, option.status].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function CodeSnippet({ title, code }: { title: string; code: string }) {
  const t = useTranslations('console.agents');
  return (
    <section className="overflow-hidden rounded-md border border-border bg-muted">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <CopyButton text={code} label={t('copyCode')} />
      </header>
      <pre className="overflow-x-auto p-4 text-xs leading-5 text-muted-foreground"><code>{code}</code></pre>
    </section>
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
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-base font-semibold text-foreground">{t('agentApiTitle')}</h3>
              {endpoint ? <AnimatedBadge status={endpointActive ? 'success' : 'neutral'}>{t(endpointActive ? 'agentApiActive' : 'agentApiDisabled')}</AnimatedBadge> : null}
              {endpoint ? (
                <AnimatedBadge status="neutral">
                  {t('agentApiRevision', { revision: endpoint.revision })}
                </AnimatedBadge>
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
              <Button type="submit" variant={"secondary"}>
                {endpointActive ? <CircleSlash2 className="size-4" /> : <Globe2 className="size-4" />}
                {endpointActive ? t('disableAgentApi') : t('enableAgentApi')}
              </Button>
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
        <div className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground text-muted-foreground">
          {t('agentApiManagePermissionRequired')}
        </div>
      ) : null}

      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold text-foreground">{t('agentApiConfiguration')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('agentApiConfigurationHelp')}</p>
        </div>
        <form action={publishFormAction} className="space-y-5 px-5 py-5">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="agentId" value={agentId} />
          {endpoint ? <input type="hidden" name="endpointId" value={endpoint.id} /> : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              
              <Input label={t('agentApiEndpointName')} name="name" maxLength={80} required disabled={!canManage} defaultValue={String(endpoint?.name ?? agentName)} />
            </div>
            <div className="space-y-1.5">
              <span className="block text-xs font-semibold text-foreground">{t('agentApiIsolationMode')}</span>
              <FormSelect name="isolationMode" defaultValue={endpoint?.isolationMode ?? 'subject'} disabled={!canManage} label={t('agentApiIsolationMode')} options={[({ value: "subject", label: t('agentApiSubjectIsolation') }), ({ value: "shared", label: t('agentApiSharedIsolation') })].flat().filter((option) => option != null)} />
            </div>
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
              className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <div key={name} className="space-y-1.5">
                
                <Input label={label} type="number" name={name} min={min} max={max} required disabled={!canManage} defaultValue={String(defaultValue)} />
              </div>
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
              className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <SubmitButton pendingLabel={t('publishingAgentApi')} flash={false}>{endpoint ? t('publishNewRevision') : t('publishAgentApi')}</SubmitButton>
            ) : null}
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-border bg-card overflow-hidden">
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
              <div className="min-w-0 flex-1 space-y-1.5">
                
                <Input label={t('agentApiClientName')} name="name" placeholder={t('agentApiClientNamePlaceholder')} maxLength={80} required />
              </div>
              <SubmitButton pendingLabel={t('creatingAgentApiClient')} flash={false}>{t('createAgentApiClient')}</SubmitButton>
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
                        <div className="space-y-1">
                          
                          <Input label={t('agentApiKeyName')} name="name" placeholder={t('agentApiKeyNamePlaceholder')} maxLength={80} required className="w-40" />
                        </div>
                        <SubmitButton pendingLabel={t('creatingAgentApiKey')} flash={false}>{t('createAgentApiKey')}</SubmitButton>
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
                              <Button type="submit" variant={"secondary"} size={"sm"}>
                                <Trash2 className="size-3.5" />
                                {t('revokeAgentApiKey')}
                              </Button>
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
            <BouncyAccordion items={[{ id: 'details', title: <>
                {t('agentApiBrowserToken')}
              </>, description: <>
              
              <form action={tokenFormAction} className="grid gap-3 border-t border-border px-4 py-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
                <input type="hidden" name="workspace" value={workspaceSlug} />
                <input type="hidden" name="agentId" value={agentId} />
                <input type="hidden" name="endpointId" value={endpoint.id} />
                <div className="space-y-1.5">
                  <span className="block text-xs font-semibold text-foreground">{t('agentApiClient')}</span>
                  <FormSelect name="clientId" label={t('agentApiClient')} options={[endpoint.clients.map((client) => ({ value: client.id, label: client.name }))].flat().filter((option) => option != null)} />
                </div>
                <div className="space-y-1.5">
                  
                  <Input label={t('agentApiSubject')} name="subject" maxLength={200} required placeholder="customer_42" />
                </div>
                <div className="space-y-1.5">
                  <span className="block text-xs font-semibold text-foreground">{t('agentApiAllowedOrigins')}</span>
                  <FormSelect name="origin" required label={t('agentApiAllowedOrigins')} options={[endpoint.allowedOrigins.length === 0 ? (
                      ({ value: "", label: t('agentApiAllowedOrigins') })
                    ) : endpoint.allowedOrigins.map((origin) => (
                      ({ value: origin, label: origin })
                    ))].flat().filter((option) => option != null)} />
                </div>
                <SubmitButton pendingLabel={t('creatingAgentClientToken')} flash={false}>{t('createAgentClientToken')}</SubmitButton>
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
              {tokenState.error ? <p className="px-4 pb-4 text-sm text-destructive text-destructive" role="alert">{tokenState.error}</p> : null}
            </> }]} />
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card overflow-hidden">
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
              <Button key={value} type="button" role="tab" aria-selected={snippet === value} onClick={() => setSnippet(value)} variant={"secondary"} size={"sm"}>
                {value === 'curl' ? <Braces className="size-3.5" /> : <Code2 className="size-3.5" />}
                {label}
              </Button>
            ))}
          </div>
          <CodeSnippet
            title={snippet === 'curl' ? t('agentApiCurl') : snippet === 'javascript' ? t('agentApiJavaScript') : t('agentApiPython')}
            code={snippets[snippet]}
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-border bg-muted p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-muted-foreground text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground text-muted-foreground">{t('agentApiKeepKeysServerSide')}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground text-muted-foreground">{t('agentApiKeepKeysServerSideHelp')}</p>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted p-4">
          <div className="flex items-start gap-3">
            {endpoint?.isolationMode === 'shared'
              ? <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground text-muted-foreground" />
              : <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground text-muted-foreground" />}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground text-muted-foreground">
                {endpoint?.isolationMode === 'shared' ? t('agentApiSharedIsolationWarning') : t('agentApiSubjectIsolationNotice')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground text-muted-foreground">
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
