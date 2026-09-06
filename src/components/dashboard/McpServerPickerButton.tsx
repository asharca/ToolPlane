'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Circle, Loader2, Server } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';

type McpServerOption = {
  id: string;
  label: string;
  status: 'running' | 'unavailable';
};

export function McpServerPickerButton({
  apiPath,
  disabled,
  hideTrigger = false,
  open: controlledOpen,
  onOpenChange,
}: {
  apiPath?: string;
  disabled: boolean;
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [loading, setLoading] = useState(false);
  const [servers, setServers] = useState<McpServerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const setDialogOpen = useCallback((next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
    if (!next) {
      requestRef.current?.abort();
      setError(null);
    }
  }, [onOpenChange]);

  const loadServers = useCallback(async () => {
    if (!apiPath) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const separator = apiPath.includes('?') ? '&' : '?';
      const response = await fetch(`${apiPath}${separator}section=mcp`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as { items?: McpServerOption[]; error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || t('loadMcpServersFailed'));
      setServers(Array.isArray(body.items) ? body.items : []);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : t('loadMcpServersFailed'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [apiPath, t]);

  const loadOpenedServers = useEffectEvent(() => { void loadServers(); });
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => loadOpenedServers(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [apiPath, open]);

  if (!apiPath) return null;

  return (
    <>
      {!hideTrigger ? (
        <button
          type="button"
          disabled={disabled}
          aria-label={t('openMcp')}
          title={t('openMcp')}
          onClick={() => setDialogOpen(true)}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Server className="size-[17px]" />
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          <DialogContent aria-describedby={undefined} className="!z-[51] !flex !max-h-[min(38rem,calc(100vh-2rem))] !w-full !max-w-xl !flex-col !gap-0 !overflow-hidden !rounded-xl !p-0">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
              <DialogTitle className="!text-sm !tracking-normal">{t('mcp')}</DialogTitle>
            </header>
            {loading ? (
              <div className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {common('loading')}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {error ? <p role="alert" className="px-2 py-2 text-sm text-destructive">{error}</p> : null}
                {servers.length ? servers.map((server) => (
                  <div key={server.id} className="flex min-h-12 items-center gap-3 rounded-md px-3 py-2.5">
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{server.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Circle className={`size-2 fill-current ${server.status === 'running' ? 'text-emerald-500' : 'text-muted-foreground'}`} />
                      {server.status === 'running' ? t('mcpRunning') : t('mcpUnavailable')}
                    </span>
                  </div>
                )) : (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">{t('noMcpServers')}</p>
                )}
              </div>
            )}
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  );
}
