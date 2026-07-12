'use client';

import type { Ref } from 'react';
import { useTranslations } from 'next-intl';
import { SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';

export type HermesRuntimeView = 'web' | 'terminal';

export function HermesRuntimePanel({
  view,
  agentId,
  deploymentId,
  dashboardUrl,
  iframeRef,
}: {
  view: HermesRuntimeView;
  agentId: string;
  deploymentId: string;
  dashboardUrl: string;
  iframeRef?: Ref<HTMLIFrameElement>;
}) {
  const t = useTranslations('console.agents');

  if (view === 'terminal') {
    return (
      <SandboxConsole
        deploymentId={deploymentId}
        running
        initialPath="."
        initialEntries={[]}
        terminalOnly
        terminalApiBase={`/api/v1/agents/${agentId}/terminal`}
        terminalLabel={t('hermesTerminalTitle')}
        terminalSubtitle="/opt/data/workspace"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 sm:px-5">
        {t('hermesManagedFieldsWarning')}
      </div>
      <iframe
        ref={iframeRef}
        key={dashboardUrl}
        src={dashboardUrl}
        title={t('hermesDashboardTitle')}
        sandbox="allow-downloads allow-modals allow-popups allow-same-origin allow-scripts"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-black"
      />
    </div>
  );
}
