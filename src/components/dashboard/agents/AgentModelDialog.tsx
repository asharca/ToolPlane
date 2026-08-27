'use client';

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
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
  DialogTrigger,
} from '@/components/ui/Dialog';
import { updateAgentModelAction, type ActionState } from '@/lib/agents/actions';
import { agentRuntimeSupportsProviderFormat } from '@/lib/agents/runtime-kind';
import { ModelPicker, type ModelSelection } from '@/components/dashboard/models/ModelPicker';

type Provider = { id: string; name: string; format: string; models: string[] };

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
  trigger,
  confirmationMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  agent: ModelAgent;
  providers: Provider[];
  trigger: ReactNode;
  confirmationMessage?: string;
}) {
  const t = useTranslations('console.agents');
  const router = useRouter();
  const isHermes = agent.runtimeKind === 'hermes';
  const [pendingSelection, setPendingSelection] = useState<ModelSelection | null>(null);
  const [providerIds, setProviderIds] = useState(() => new Set(agent.providerIds));
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(updateAgentModelAction, {});
  const compatibleProviders = providers.filter((provider) => (
    agentRuntimeSupportsProviderFormat(agent.runtimeKind ?? '', provider.format)
  ));

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setPendingSelection(null);
    if (nextOpen) setProviderIds(new Set(agent.providerIds));
    onOpenChange(nextOpen);
  }, [agent.providerIds, onOpenChange]);

  useEffect(() => {
    if (!state.savedAt) return;
    onOpenChange(false);
    router.refresh();
  }, [onOpenChange, router, state.savedAt]);

  const selectModel = useCallback(({ providerId, model }: ModelSelection) => {
    if (confirmationMessage && !window.confirm(confirmationMessage)) return;
    const data = new FormData();
    data.set('workspace', slug);
    data.set('agentId', agent.id);
    data.set('providerId', providerId);
    data.set('model', model);
    setPendingSelection({ providerId, model });
    startTransition(() => formAction(data));
  }, [agent.id, confirmationMessage, formAction, slug]);

  if (!isHermes) {
    return (
      <ModelPicker
        open={open}
        onOpenChange={handleOpenChange}
        providers={compatibleProviders}
        value={agent.providerId && agent.model ? { providerId: agent.providerId, model: agent.model } : null}
        pending={isPending}
        pendingValue={pendingSelection}
        error={state.error}
        closeOnSelect={false}
        onSelect={selectModel}
        onConfigure={() => {
          const returnTo = `${window.location.pathname}${window.location.search}`;
          router.push(`/app/${encodeURIComponent(slug)}/settings/providers?returnTo=${encodeURIComponent(returnTo)}`);
        }}
        trigger={trigger}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
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
