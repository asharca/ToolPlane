'use client';

import { useActionState, useState } from 'react';
import { updateAgentAction, type ActionState } from '@/lib/agents/actions';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';

type Provider = { id: string; name: string; models: string[] };
type Option = { id: string; label: string; checked: boolean; running?: boolean };

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
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateAgentAction, {});
  const [selectedProvider, setSelectedProvider] = useState(providerId ?? '');
  const models = providers.find((p) => p.id === selectedProvider)?.models ?? [];

  const input =
    'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';

  return (
    <form action={formAction} className="max-w-2xl space-y-5 px-8 py-6">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />

      <label className="block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Name
        <input name="name" defaultValue={name} required className={input} />
      </label>

      <label className="block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
        System prompt
        <textarea
          name="systemPrompt"
          defaultValue={systemPrompt}
          rows={4}
          placeholder="You are a helpful assistant…"
          className="w-full rounded-md border border-zinc-200 bg-white p-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Provider
          <select
            name="providerId"
            defaultValue={providerId ?? ''}
            onChange={(e) => setSelectedProvider(e.target.value)}
            className={input}
          >
            <option value="">— none —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Model
          <select name="model" defaultValue={model ?? ''} className={input}>
            <option value="">— select —</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Max tool steps
          <input name="maxSteps" type="number" min={AGENT_STEP_BOUNDS.min} max={AGENT_STEP_BOUNDS.max} defaultValue={maxSteps} className={input} />
        </label>
      </div>
      {selectedProvider && models.length === 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This provider has no cached models. Refresh its models on the Model Providers tab.
        </p>
      ) : null}

      <CheckGroup legend="MCP servers" name="deploymentId" options={deployments} />
      <CheckGroup legend="Skills" name="installedSkillId" options={skills} />
      <CheckGroup legend="Toolkits" name="toolkitId" options={toolkits} />

      <div className="flex items-center gap-3">
        <button className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
          Save changes
        </button>
        {state.error ? (
          <span className="text-sm text-red-600" role="alert">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}

function CheckGroup({ legend, name, options }: { legend: string; name: string; options: Option[] }) {
  return (
    <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {legend}
      </legend>
      {options.length === 0 ? (
        <p className="px-1 py-2 text-sm text-zinc-400">Nothing available in this workspace.</p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" name={name} value={o.id} defaultChecked={o.checked} className="size-4" />
              <span>{o.label}</span>
              {o.running === false ? (
                <span className="rounded bg-zinc-100 px-1 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  stopped
                </span>
              ) : null}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
