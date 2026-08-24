'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Check, Cpu, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';
import { updateAgentModelAction, type ActionState } from '@/lib/agents/actions';
import { NativeSelect } from '@/components/ui/NativeSelect';

type Provider = { id: string; name: string; models: string[] };

type ModelAgent = {
  id: string;
  name: string;
  runtimeKind: string | null;
  providerId: string | null;
  providerIds: string[];
  model: string | null;
};

export function AgentModelDialog({
  open,
  onOpenChange,
  slug,
  agent,
  providers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  agent: ModelAgent;
  providers: Provider[];
}) {
  const t = useTranslations('console.agents');
  const router = useRouter();
  const isHermes = agent.runtimeKind === 'hermes';
  const [providerId, setProviderId] = useState(agent.providerId ?? '');
  const [model, setModel] = useState(agent.model ?? '');
  const [providerIds, setProviderIds] = useState(() => new Set(agent.providerIds));
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(updateAgentModelAction, {});
  const models = useMemo(
    () => providers.find((provider) => provider.id === providerId)?.models ?? [],
    [providerId, providers],
  );

  useEffect(() => {
    if (!state.savedAt) return;
    onOpenChange(false);
    router.refresh();
  }, [onOpenChange, router, state.savedAt]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="!bg-black/45 backdrop-blur-[1px]" />
        <DialogContent className="max-w-xl">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              <Cpu className="size-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t('modelConfiguration')}</DialogTitle>
              <DialogDescription className="mt-1">{t('modelConfigurationDescription', { agent: agent.name })}</DialogDescription>
            </div>
          </div>

          <form action={formAction} className="space-y-4">
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="agentId" value={agent.id} />
            {isHermes ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{t('modelProviders')}</legend>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
                  {providers.map((provider) => {
                    const checked = providerIds.has(provider.id);
                    return (
                      <label key={provider.id} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted">
                        <input
                          type="checkbox"
                          name="providerId"
                          value={provider.id}
                          checked={checked}
                          onChange={(event) => {
                            setProviderIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(provider.id);
                              else next.delete(provider.id);
                              return next;
                            });
                          }}
                          className="size-4 rounded border-input"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{provider.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{t('providerModelCount', { count: provider.models.length })}</span>
                        </span>
                        {checked ? <Check className="size-4 text-emerald-600" /> : null}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">{t('provider')}</span>
                  <NativeSelect
                    name="providerId"
                    value={providerId}
                    onChange={(event) => {
                      setProviderId(event.target.value);
                      setModel('');
                    }}
                    className="ui-input h-10 w-full"
                  >
                    <option value="">{t('select')}</option>
                    {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </NativeSelect>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">{t('model')}</span>
                  <NativeSelect name="model" value={model} onChange={(event) => setModel(event.target.value)} className="ui-input h-10 w-full" disabled={!providerId}>
                    <option value="">{t('select')}</option>
                    {models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                  </NativeSelect>
                </label>
              </div>
            )}
            {state.error ? <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{state.error}</p> : null}
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <DialogClose asChild><button type="button" className="ui-button-secondary" disabled={isPending}>{t('cancel')}</button></DialogClose>
              <button type="submit" className="ui-button-primary gap-2" disabled={isPending}>
                {isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                {t('save')}
              </button>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
