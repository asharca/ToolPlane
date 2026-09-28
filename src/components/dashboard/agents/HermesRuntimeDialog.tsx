'use client';
import { Button } from '@/components/motion/button/base';
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Container, Monitor, Settings, Terminal } from 'lucide-react';
import {
  HermesRuntimePanel,
  type HermesRuntimeView,
} from '@/components/dashboard/agents/HermesRuntimePanel';
import {
  HermesRuntimeManagement,
  type HermesRuntimeManagementData,
} from '@/components/dashboard/agents/HermesRuntimeManagement';
import { HERMES_EMBED_CLOSE_MESSAGE } from '@/lib/agents/hermes/embed-message';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type HermesRuntimeDialogData = {
  name: string;
  agentId: string;
  deploymentId: string;
  dashboardUrl: string;
  management?: HermesRuntimeManagementData;
};

type HermesRuntimeDialogView = HermesRuntimeView | 'settings';

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
  const [view, setView] = useState<HermesRuntimeDialogView>('web');
  const titleId = useId();
  const panelId = useId();
  const webTabId = useId();
  const terminalTabId = useId();
  const settingsTabId = useId();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    const trigger = triggerRef.current;
    window.setTimeout(() => trigger?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;

    function handleMessage(event: MessageEvent) {
      if (
        event.data === HERMES_EMBED_CLOSE_MESSAGE
        && event.source === iframeRef.current?.contentWindow
      ) {
        close();
      }
    }

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [close, open]);

  function openView(nextView: HermesRuntimeDialogView, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setView(nextView);
    setOpen(true);
  }

  const triggerLabelClass = compact ? 'hidden min-[1400px]:inline' : undefined;

  return (
    <>
      <div
        className={cx(
          compact
            ? 'flex items-center justify-end gap-2'
            : `grid ${runtime.management ? 'grid-cols-3' : 'grid-cols-2'} gap-2`,
          className,
        )}
      >
        <Button type="button" onClick={(event) => openView('web', event.currentTarget)} aria-label={tSandboxes('openHermes')} title={tSandboxes('openHermes')} variant="secondary" size="sm">
          <Monitor className="size-3.5" />
          <span className={triggerLabelClass}>{tSandboxes('web')}</span>
        </Button>
        <Button type="button" onClick={(event) => openView('terminal', event.currentTarget)} aria-label={tSandboxes('openTerminal')} title={tSandboxes('openTerminal')} variant="secondary" size="sm">
          <Terminal className="size-3.5" />
          <span className={triggerLabelClass}>{tSandboxes('terminal')}</span>
        </Button>
        {runtime.management ? (
          <Button type="button" onClick={(event) => openView('settings', event.currentTarget)} aria-label={tSandboxes('settings')} title={tSandboxes('settings')} variant="secondary" size="sm">
            <Settings className="size-3.5" />
            <span className={triggerLabelClass}>{tSandboxes('settings')}</span>
          </Button>
        ) : null}
      </div>

      <CenterMorphModal open={open} onOpenChange={(next) => { if (!next) close(); }}>
        <CenterMorphModalContent ariaLabel={tAgents('hermesRuntimeDialogTitle')} closeButtonLabel={tAgents('closeHermesRuntimeDialog')} className="flex h-[calc(100dvh-4rem)] max-w-[96rem] flex-col">
            <header className="flex shrink-0 items-center gap-3 border-b border-border pl-4 pr-16 py-3 sm:pl-5 sm:py-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <Container className="size-[18px] shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
                    {tAgents('hermesRuntimeDialogTitle')}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{runtime.name}</p>
                </div>
              </div>
            </header>

            <div
              role="tablist"
              aria-label={tAgents('hermesRuntimeDialogTitle')}
              className={`grid shrink-0 ${runtime.management ? 'grid-cols-3' : 'grid-cols-2'} gap-1 border-b border-border px-2 py-3 sm:flex sm:gap-2 sm:px-5`}
            >
              <Button type="button" role="tab" id={webTabId} aria-selected={view === 'web'} aria-controls={panelId} onClick={() => setView('web')} variant={view === 'web' ? 'secondary' : 'ghost'} size={"sm"}>
                <Monitor className="size-4 shrink-0" />
                {tAgents('hermesWebTab')}
              </Button>
              <Button type="button" role="tab" id={terminalTabId} aria-selected={view === 'terminal'} aria-controls={panelId} onClick={() => setView('terminal')} variant={view === 'terminal' ? 'secondary' : 'ghost'} size={"sm"}>
                <Terminal className="size-4 shrink-0" />
                {tAgents('terminalSettingsTab')}
              </Button>
              {runtime.management ? (
                <Button type="button" role="tab" id={settingsTabId} aria-selected={view === 'settings'} aria-controls={panelId} onClick={() => setView('settings')} variant={view === 'settings' ? 'secondary' : 'ghost'} size={"sm"}>
                  <Settings className="size-4 shrink-0" />
                  {tSandboxes('settings')}
                </Button>
              ) : null}
            </div>

            <div
              id={panelId}
              role="tabpanel"
              aria-labelledby={view === 'web' ? webTabId : view === 'terminal' ? terminalTabId : settingsTabId}
              className={view === 'settings' ? 'min-h-0 flex-1 overflow-y-auto' : 'min-h-0 flex-1 overflow-hidden'}
            >
              {view === 'settings' && runtime.management ? (
                <HermesRuntimeManagement {...runtime.management} />
              ) : (
                <HermesRuntimePanel
                  view={view as HermesRuntimeView}
                  agentId={runtime.agentId}
                  deploymentId={runtime.deploymentId}
                  dashboardUrl={runtime.dashboardUrl}
                  iframeRef={iframeRef}
                />
              )}
            </div>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </>
  );
}
