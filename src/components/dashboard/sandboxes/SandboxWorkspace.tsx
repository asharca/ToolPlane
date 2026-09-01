'use client';

import { useId, useState, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Folder, Monitor, TerminalIcon } from 'lucide-react';
import { SandboxConsole } from './SandboxConsole';
import { SandboxScreen, type SandboxDisplay } from './SandboxScreen';

type View = 'terminal' | 'files' | 'screen';
type ConsoleProps = Omit<ComponentProps<typeof SandboxConsole>, 'compact' | 'filesOnly' | 'terminalOnly'>;

export function SandboxWorkspace({
  workspace,
  sandboxId,
  displays,
  ...consoleProps
}: ConsoleProps & {
  workspace: string;
  sandboxId: string;
  displays: SandboxDisplay[];
}) {
  const t = useTranslations('console.sandboxes');
  const [view, setView] = useState<View>('terminal');
  const id = useId();
  const tabs = [
    { id: 'terminal' as const, label: t('terminal'), icon: TerminalIcon },
    { id: 'files' as const, label: t('files'), icon: Folder },
    ...(displays.length ? [{ id: 'screen' as const, label: t('screen'), icon: Monitor }] : []),
  ];

  return (
    <div className="ui-panel flex h-[calc(100vh-13rem)] min-h-[34rem] flex-col overflow-hidden">
      <div role="tablist" aria-label={t('sandboxViews')} className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === view;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${id}-${tab.id}-tab`}
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              onClick={() => setView(tab.id)}
              className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}`}
            >
              <Icon className="size-4" />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${view}-tab`}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {view === 'terminal' ? <SandboxConsole {...consoleProps} terminalOnly compact /> : null}
        {view === 'files' ? <SandboxConsole {...consoleProps} filesOnly compact /> : null}
        {view === 'screen' && displays.length ? (
          <SandboxScreen
            workspace={workspace}
            sandboxId={sandboxId}
            displays={displays}
            running={consoleProps.running}
          />
        ) : null}
      </div>
    </div>
  );
}
