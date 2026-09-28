'use client';

import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs';

import { useState, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Folder, Monitor, Radio, TerminalIcon } from 'lucide-react';
import { SandboxConsole } from './SandboxConsole';
import { SandboxScreen, type SandboxDisplay } from './SandboxScreen';
import { AgentMessagingPanel } from '../agents/AgentMessagingPanel';

type View = 'terminal' | 'files' | 'screen' | 'channels';
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
  const tabs = [
    { id: 'terminal' as const, label: t('terminal'), icon: TerminalIcon },
    { id: 'files' as const, label: t('files'), icon: Folder },
    ...(displays.length ? [{ id: 'screen' as const, label: t('screen'), icon: Monitor }] : []),
    { id: 'channels' as const, label: t('channels'), icon: Radio },
  ];

  return (
    <Tabs value={view} onValueChange={(next) => setView(next as View)} className="flex h-[calc(100vh-13rem)] min-h-[34rem] flex-col overflow-hidden">
      <nav aria-label={t('sandboxViews')} className="shrink-0">
        <TabsList>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return <TabsTrigger key={tab.id} value={tab.id}><span className="flex items-center gap-2"><Icon className="size-4" />{tab.label}</span></TabsTrigger>;
          })}
        </TabsList>
      </nav>
      <div
        role="tabpanel"
        aria-label={tabs.find((tab) => tab.id === view)?.label}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {view === 'terminal' ? <SandboxConsole {...consoleProps} terminalOnly compact /> : null}
        {view === 'files' ? <SandboxConsole {...consoleProps} filesOnly compact /> : null}
        {view === 'channels' ? <AgentMessagingPanel slug={workspace} sandboxId={sandboxId} connections={[]} /> : null}
        {view === 'screen' && displays.length ? (
          <SandboxScreen
            workspace={workspace}
            sandboxId={sandboxId}
            displays={displays}
            running={consoleProps.running}
          />
        ) : null}
      </div>
    </Tabs>
  );
}
