'use client';
import { Button } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalClose } from '@/components/motion/center-morph-modal';
import { Input } from '@/components/motion/input';


import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Loader2, ScrollText } from 'lucide-react';

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
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  apiPath?: string;
  disabled: boolean;
  onError: (message: string | null) => void;
  onInsert: (text: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [prompts, setPrompts] = useState<McpPromptOption[]>([]);
  const [selected, setSelected] = useState<McpPromptOption | null>(null);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const loadPrompts = useCallback(async () => {
    if (!apiPath) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setResolving(false);
    setError(null);
    onError(null);
    try {
      const response = await fetch(apiPath, { cache: 'no-store', signal: controller.signal });
      const body = await response.json().catch(() => ({})) as { prompts?: McpPromptOption[]; error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || t('loadMcpPromptsFailed'));
      setPrompts(Array.isArray(body.prompts) ? body.prompts : []);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : t('loadMcpPromptsFailed');
      setError(message);
      onError(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [apiPath, onError, t]);

  const setDialogOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) {
      requestRef.current?.abort();
      setSelected(null);
      setArgumentsValue({});
      setError(null);
      return;
    }
  }, [onOpenChange]);

  const loadOpenedPrompts = useEffectEvent(() => { void loadPrompts(); });
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => loadOpenedPrompts(), 0);
    return () => { window.clearTimeout(timer); requestRef.current?.abort(); };
  }, [open, apiPath]);

  const choosePrompt = useCallback((prompt: McpPromptOption) => {
    setSelected(prompt);
    setArgumentsValue(Object.fromEntries(prompt.arguments.map((argument) => [argument.name, ''])));
    setError(null);
  }, []);

  const insertPrompt = useCallback(async () => {
    if (!apiPath || !selected) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setResolving(true);
    setError(null);
    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deploymentId: selected.deploymentId,
          name: selected.name,
          arguments: argumentsValue,
        }),
      });
      const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok || typeof body.text !== 'string') {
        throw new Error(body.error || t('resolveMcpPromptFailed'));
      }
      onInsert(body.text);
      setDialogOpen(false);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : t('resolveMcpPromptFailed');
      setError(message);
      onError(message);
    } finally {
      if (!controller.signal.aborted) setResolving(false);
    }
  }, [apiPath, argumentsValue, onError, onInsert, selected, setDialogOpen, t]);

  if (!apiPath) return null;
  const selectedLabel = selected?.title ?? selected?.name;

  return (
    <>
      {!hideTrigger && <Button type="button" disabled={disabled} aria-label={t('openMcpPrompts')} title={t('openMcpPrompts')} onClick={() => setDialogOpen(true)} variant="ghost" size="icon" className="flex shrink-0 items-center justify-center"><ScrollText className="size-[17px]" /></Button>}
      <CenterMorphModal open={open} onOpenChange={setDialogOpen}>
        
          
          <CenterMorphModalContent ariaLabel={selectedLabel ?? t('mcpPrompts')} closeButtonLabel={common('close')} className="flex max-h-[calc(100dvh-6rem)] w-full max-w-xl flex-col">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border pl-4 pr-16 py-3">
              <div className="min-w-0">
                <h2 className="!text-sm !tracking-normal">
                  {selected ? selectedLabel : t('mcpPrompts')}
                </h2>
                {selected ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{selected.serverName}</p> : null}
              </div>
              {selected ? (
                <Button type="button" onClick={() => { setSelected(null); setArgumentsValue({}); setError(null); }} aria-label={common('back')} title={common('back')} variant="ghost" size="icon" className="shrink-0"><ChevronLeft className="size-4" /></Button>
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
                        <Input value={argumentsValue[argument.name] ?? ''} onChange={(value) => setArgumentsValue((current) => ({
                            ...current,
                            [argument.name]: value,
                          }))} required={argument.required} maxLength={20_000} placeholder={argument.description ?? argument.name} className="mt-1.5 w-full" />
                      </label>
                    ))}
                  </div>
                  {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
                </div>
                <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
                  <CenterMorphModalClose><Button type="button" variant="secondary" size="sm">{common('cancel')}</Button></CenterMorphModalClose>
                  <Button type="submit" disabled={resolving} variant="primary" size="sm">{resolving ? <Loader2 className="size-3.5 animate-spin" /> : <ScrollText className="size-3.5" />}
                  {t('insertMcpPrompt')}</Button>
                </footer>
              </form>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {error ? <p role="alert" className="px-2 py-2 text-sm text-destructive">{error}</p> : null}
                {prompts.length ? prompts.map((prompt) => (
                  <Button key={`${prompt.deploymentId}:${prompt.name}`} type="button" onClick={() => choosePrompt(prompt)} variant="ghost" size="lg" className="w-full min-w-0 justify-start text-left"><ScrollText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{prompt.title ?? prompt.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{prompt.serverName}</span>
                    {prompt.description ? <span className="mt-1 block line-clamp-2 text-xs leading-4 text-muted-foreground">{prompt.description}</span> : null}
                  </span>
                  {prompt.arguments.length ? <span className="shrink-0 text-[11px] text-muted-foreground">{prompt.arguments.length}</span> : null}</Button>
                )) : (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">{t('noMcpPrompts')}</p>
                )}
              </div>
            )}
          </CenterMorphModalContent>
        
      </CenterMorphModal>
    </>
  );
}
