'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Container, Monitor, Terminal, X } from 'lucide-react';
import {
  HERMES_EMBED_CLOSE_MESSAGE,
  HermesRuntimePanel,
  type HermesRuntimeView,
} from '@/components/dashboard/agents/HermesRuntimePanel';

const FOCUSABLE_ELEMENTS = [
  'button:not([disabled])',
  'iframe',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type HermesRuntimeDialogData = {
  name: string;
  agentId: string;
  deploymentId: string;
  dashboardUrl: string;
};

export function HermesRuntimeDialogLauncher({
  runtime,
  compact = false,
  className,
}: {
  runtime: HermesRuntimeDialogData;
  compact?: boolean;
  className?: string;
}) {
  const tAgents = useTranslations('console.agents');
  const tSandboxes = useTranslations('console.sandboxes');
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HermesRuntimeView>('web');
  const titleId = useId();
  const panelId = useId();
  const webTabId = useId();
  const terminalTabId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    const trigger = triggerRef.current;
    window.setTimeout(() => trigger?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENTS));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function handleMessage(event: MessageEvent) {
      if (
        event.data === HERMES_EMBED_CLOSE_MESSAGE
        && event.source === iframeRef.current?.contentWindow
      ) {
        close();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('message', handleMessage);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('message', handleMessage);
    };
  }, [close, open]);

  function openView(nextView: HermesRuntimeView, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setView(nextView);
    setOpen(true);
  }

  const triggerClass = compact
    ? 'ui-button-secondary ui-button-sm size-8 px-0 min-[1400px]:w-auto min-[1400px]:px-2.5'
    : 'ui-button-secondary ui-button-sm';
  const triggerLabelClass = compact ? 'hidden min-[1400px]:inline' : undefined;

  return (
    <>
      <div
        className={cx(
          compact ? 'flex items-center justify-end gap-2' : 'grid grid-cols-2 gap-2',
          className,
        )}
      >
        <button
          type="button"
          onClick={(event) => openView('web', event.currentTarget)}
          aria-label={tSandboxes('openHermes')}
          title={tSandboxes('openHermes')}
          className={triggerClass}
        >
          <Monitor className="size-3.5" />
          <span className={triggerLabelClass}>{tSandboxes('web')}</span>
        </button>
        <button
          type="button"
          onClick={(event) => openView('terminal', event.currentTarget)}
          aria-label={tSandboxes('openTerminal')}
          title={tSandboxes('openTerminal')}
          className={triggerClass}
        >
          <Terminal className="size-3.5" />
          <span className={triggerLabelClass}>{tSandboxes('terminal')}</span>
        </button>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-0 backdrop-blur-sm sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="ui-panel flex h-full w-full max-w-[96rem] flex-col overflow-hidden rounded-none shadow-xl sm:h-[calc(100dvh-2rem)] sm:rounded-md"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <Container className="size-[18px] shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
                    {tAgents('hermesRuntimeDialogTitle')}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{runtime.name}</p>
                </div>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label={tAgents('closeHermesRuntimeDialog')}
                title={tAgents('closeHermesRuntimeDialog')}
                onClick={close}
                className="ui-button-secondary h-11 w-11 shrink-0 px-0"
              >
                <X className="size-5" />
              </button>
            </header>

            <div role="tablist" aria-label={tAgents('hermesRuntimeDialogTitle')} className="grid shrink-0 grid-cols-2 gap-1 border-b border-border px-2 py-3 sm:flex sm:gap-2 sm:px-5">
              <button
                type="button"
                role="tab"
                id={webTabId}
                aria-selected={view === 'web'}
                aria-controls={panelId}
                onClick={() => setView('web')}
                className={cx(
                  'inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors',
                  view === 'web'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Monitor className="size-4 shrink-0" />
                {tAgents('hermesWebTab')}
              </button>
              <button
                type="button"
                role="tab"
                id={terminalTabId}
                aria-selected={view === 'terminal'}
                aria-controls={panelId}
                onClick={() => setView('terminal')}
                className={cx(
                  'inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors',
                  view === 'terminal'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Terminal className="size-4 shrink-0" />
                {tAgents('terminalSettingsTab')}
              </button>
            </div>

            <div
              id={panelId}
              role="tabpanel"
              aria-labelledby={view === 'web' ? webTabId : terminalTabId}
              className="min-h-0 flex-1 overflow-hidden"
            >
              <HermesRuntimePanel
                view={view}
                agentId={runtime.agentId}
                deploymentId={runtime.deploymentId}
                dashboardUrl={runtime.dashboardUrl}
                iframeRef={iframeRef}
              />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
