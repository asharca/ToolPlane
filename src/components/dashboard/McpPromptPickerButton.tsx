'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Loader2, ScrollText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';

type McpPromptOption = {
  deploymentId: string;
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{
    name: string;
    title?: string;
    description?: string;
    required: boolean;
  }>;
};

export function McpPromptPickerButton({
  apiPath,
  disabled,
  onError,
  onInsert,
}: {
  apiPath?: string;
  disabled: boolean;
  onError: (message: string | null) => void;
  onInsert: (text: string) => void;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [prompts, setPrompts] = useState<McpPromptOption[]>([]);
  const [selected, setSelected] = useState<McpPromptOption | null>(null);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const loadPrompts = useCallback(async () => {
    if (!apiPath) return;
    setLoading(true);
    setError(null);
    onError(null);
    try {
      const response = await fetch(apiPath, { cache: 'no-store' });
      const body = await response.json().catch(() => ({})) as { prompts?: McpPromptOption[]; error?: string };
      if (!response.ok) throw new Error(body.error || t('loadMcpPromptsFailed'));
      setPrompts(Array.isArray(body.prompts) ? body.prompts : []);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('loadMcpPromptsFailed');
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  }, [apiPath, onError, t]);

  const setDialogOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setSelected(null);
      setArgumentsValue({});
      setError(null);
      return;
    }
    void loadPrompts();
  }, [loadPrompts]);

  const choosePrompt = useCallback((prompt: McpPromptOption) => {
    setSelected(prompt);
    setArgumentsValue(Object.fromEntries(prompt.arguments.map((argument) => [argument.name, ''])));
    setError(null);
  }, []);

  const insertPrompt = useCallback(async () => {
    if (!apiPath || !selected) return;
    setResolving(true);
    setError(null);
    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deploymentId: selected.deploymentId,
          name: selected.name,
          arguments: argumentsValue,
        }),
      });
      const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!response.ok || typeof body.text !== 'string') {
        throw new Error(body.error || t('resolveMcpPromptFailed'));
      }
      onInsert(body.text);
      setDialogOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('resolveMcpPromptFailed');
      setError(message);
      onError(message);
    } finally {
      setResolving(false);
    }
  }, [apiPath, argumentsValue, onError, onInsert, selected, setDialogOpen, t]);

  if (!apiPath) return null;
  const selectedLabel = selected?.title ?? selected?.name;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={t('openMcpPrompts')}
        title={t('openMcpPrompts')}
        onClick={() => setDialogOpen(true)}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ScrollText className="size-[17px]" />
      </button>
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          <DialogContent aria-describedby={undefined} className="!z-[51] !flex !max-h-[min(38rem,calc(100vh-2rem))] !w-full !max-w-xl !flex-col !gap-0 !overflow-hidden !rounded-xl !p-0">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <DialogTitle className="!text-sm !tracking-normal">
                  {selected ? selectedLabel : t('mcpPrompts')}
                </DialogTitle>
                {selected ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{selected.serverName}</p> : null}
              </div>
              {selected ? (
                <button
                  type="button"
                  onClick={() => { setSelected(null); setArgumentsValue({}); setError(null); }}
                  aria-label={common('back')}
                  title={common('back')}
                  className="ui-button-ghost ui-icon-button shrink-0"
                >
                  <ChevronLeft className="size-4" />
                </button>
              ) : null}
            </header>
            {loading ? (
              <div className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {common('loading')}
              </div>
            ) : selected ? (
              <form
                onSubmit={(event) => { event.preventDefault(); void insertPrompt(); }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  {selected.description ? <p className="mb-4 text-sm leading-5 text-muted-foreground">{selected.description}</p> : null}
                  <div className="space-y-3">
                    {selected.arguments.map((argument) => (
                      <label key={argument.name} className="block text-xs font-medium text-foreground">
                        <span className="flex items-center gap-1">
                          {argument.title ?? argument.name}
                          {argument.required ? <span className="text-destructive">*</span> : null}
                        </span>
                        <input
                          value={argumentsValue[argument.name] ?? ''}
                          onChange={(event) => setArgumentsValue((current) => ({
                            ...current,
                            [argument.name]: event.target.value,
                          }))}
                          required={argument.required}
                          maxLength={20_000}
                          placeholder={argument.description ?? argument.name}
                          className="ui-input mt-1.5 h-9 w-full text-sm"
                        />
                      </label>
                    ))}
                  </div>
                  {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
                </div>
                <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
                  <button type="button" onClick={() => setDialogOpen(false)} className="ui-button-secondary h-8 px-3 text-xs">
                    {common('cancel')}
                  </button>
                  <button type="submit" disabled={resolving} className="ui-button-primary h-8 px-3 text-xs">
                    {resolving ? <Loader2 className="size-3.5 animate-spin" /> : <ScrollText className="size-3.5" />}
                    {t('insertMcpPrompt')}
                  </button>
                </footer>
              </form>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {error ? <p role="alert" className="px-2 py-2 text-sm text-destructive">{error}</p> : null}
                {prompts.length ? prompts.map((prompt) => (
                  <button
                    key={`${prompt.deploymentId}:${prompt.name}`}
                    type="button"
                    onClick={() => choosePrompt(prompt)}
                    className="flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-muted"
                  >
                    <ScrollText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{prompt.title ?? prompt.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{prompt.serverName}</span>
                      {prompt.description ? <span className="mt-1 block line-clamp-2 text-xs leading-4 text-muted-foreground">{prompt.description}</span> : null}
                    </span>
                    {prompt.arguments.length ? <span className="shrink-0 text-[11px] text-muted-foreground">{prompt.arguments.length}</span> : null}
                  </button>
                )) : (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">{t('noMcpPrompts')}</p>
                )}
              </div>
            )}
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  );
}
