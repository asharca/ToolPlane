'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Archive, Bot, Boxes, ChevronLeft, Circle, Plus, TerminalSquare, X } from 'lucide-react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import { SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

type WorkAgent = {
  id: string;
  name: string;
  ready: boolean;
  runtimeKind: string | null;
  sandboxes: Array<{ id: string; name: string; deploymentId: string; running: boolean; isDefault: boolean }>;
};

type WorkItem = {
  id: string;
  agentId: string;
  title: string | null;
  task: string | null;
  status: string;
  conversationId: string;
  sandbox: { id: string; name: string; deploymentId: string; running: boolean } | null;
  messages: HermesUIMessage[];
};

function statusClass(status: string) {
  if (status === 'completed') return 'bg-emerald-500';
  if (status === 'failed') return 'bg-red-500';
  if (status === 'running' || status === 'active') return 'bg-blue-500';
  return 'bg-zinc-400';
}

function workHref(slug: string, id: string) {
  return `/app/${encodeURIComponent(slug)}/work?w=${encodeURIComponent(id)}`;
}

export function WorkspaceWork({
  slug,
  agents,
  sessions,
  selectedWorkSessionId,
  requestedAgentId,
}: {
  slug: string;
  agents: WorkAgent[];
  sessions: WorkItem[];
  selectedWorkSessionId: string | null;
  requestedAgentId?: string;
}) {
  const t = useTranslations('console.work');
  const selected = sessions.find((item) => item.id === selectedWorkSessionId) ?? null;
  const [creatingMode, setCreatingMode] = useState(!selected);
  const [agentId, setAgentId] = useState(selected?.agentId ?? agents.find((item) => item.id === requestedAgentId)?.id ?? agents[0]?.id ?? '');
  const [sandboxId, setSandboxId] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const agent = useMemo(() => agents.find((item) => item.id === agentId) ?? null, [agents, agentId]);
  const selectedAgent = selected ? agents.find((item) => item.id === selected.agentId) ?? null : null;
  const sandboxOptions = agent?.sandboxes ?? [];
  const activeSandboxId = sandboxId || sandboxOptions.find((item) => item.isDefault)?.id || sandboxOptions[0]?.id || '';

  const statusLabels: Record<string, string> = {
    waiting: t('statusWaiting'), active: t('statusActive'), running: t('statusRunning'), completed: t('statusCompleted'), failed: t('statusFailed'), archived: t('statusArchived'),
  };

  async function createWork() {
    if (!agentId || !activeSandboxId || !task.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/work-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, sandboxId: activeSandboxId, task: task.trim() }),
      });
      const body = await response.json() as { workSessionId?: string; error?: string };
      if (!response.ok || !body.workSessionId) throw new Error(body.error || t('createError'));
      window.location.assign(workHref(slug, body.workSessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('createError'));
    } finally {
      setCreating(false);
    }
  }

  async function archiveWork(id: string) {
    const response = await fetch(`/api/v1/work-sessions/${id}`, { method: 'DELETE' });
    if (response.ok) window.location.assign(`/app/${encodeURIComponent(slug)}/work`);
  }

  return (
    <div className={`grid h-full min-h-0 overflow-hidden bg-background lg:grid-cols-[16.5rem_minmax(0,1fr)] ${selected ? 'xl:grid-cols-[16.5rem_minmax(30rem,1fr)_24rem]' : ''}`}>
      <aside className={`${selected ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col overflow-hidden border-r border-border bg-card`}>
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><TerminalSquare className="size-4 text-muted-foreground" />{t('sessions')}</div>
          <button type="button" onClick={() => setCreatingMode((value) => !value)} aria-label={t('newWork')} title={t('newWork')} className="ui-button-ghost ui-icon-button"><Plus className="size-4" /></button>
        </div>

        {creatingMode ? (
          <div className="shrink-0 border-b border-border p-3">
            <p className="mb-3 text-xs font-semibold text-foreground">{t('assignTask')}</p>
            <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground" htmlFor="work-agent">{t('agent')}</label>
            <select id="work-agent" value={agentId} onChange={(event) => { setAgentId(event.target.value); setSandboxId(''); }} className="ui-input mb-3 h-9 w-full">
              {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground" htmlFor="work-sandbox">{t('sandbox')}</label>
            <select id="work-sandbox" value={activeSandboxId} onChange={(event) => setSandboxId(event.target.value)} className="ui-input mb-3 h-9 w-full" disabled={!sandboxOptions.length}>
              {sandboxOptions.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? ` (${t('default')})` : ''}{item.running ? '' : ` (${t('stopped')})`}</option>)}
            </select>
            <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground" htmlFor="work-task">{t('task')}</label>
            <textarea id="work-task" value={task} onChange={(event) => setTask(event.target.value)} placeholder={t('taskPlaceholder')} rows={4} className="ui-input mb-2 !h-24 w-full resize-none py-2" />
            <button type="button" disabled={creating || !agentId || !activeSandboxId || !task.trim()} onClick={createWork} className="ui-button-primary w-full"><Plus className="size-4" />{creating ? t('starting') : t('startWork')}</button>
            {!sandboxOptions.length && agent ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('attachSandbox')}</p> : null}
            {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <p className="px-2 pb-2 pt-1 text-[11px] font-medium uppercase text-muted-foreground">{t('history')}</p>
          {sessions.length ? <ul className="space-y-1">
            {sessions.map((item) => (
              <li key={item.id} className={`group flex items-start rounded-md ${item.id === selected?.id ? 'bg-muted' : 'hover:bg-muted/60'}`}>
                <Link href={workHref(slug, item.id)} className="min-w-0 flex-1 px-2 py-2.5">
                  <span className="block truncate text-sm font-medium">{item.title || item.task || t('untitled')}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Circle className={`size-2 fill-current ${statusClass(item.status)}`} />{statusLabels[item.status] ?? item.status}<span aria-hidden="true">·</span>{item.sandbox?.name ?? t('sandboxUnavailable')}</span>
                </Link>
                <button type="button" onClick={() => void archiveWork(item.id)} aria-label={t('archive')} title={t('archive')} className="ui-button-ghost mt-1.5 size-7 shrink-0 px-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"><Archive className="size-3.5" /></button>
              </li>
            ))}
          </ul> : <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('noSessions')}</p>}
        </div>
      </aside>

      <main className={`${selected ? 'flex' : 'hidden lg:flex'} relative min-h-0 min-w-0 flex-col bg-background xl:border-r xl:border-border`}>
        {selected ? (
          <>
            <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-4">
              <div className="flex min-w-0 items-center gap-3">
                <Link href={`/app/${encodeURIComponent(slug)}/work`} aria-label={t('sessions')} title={t('sessions')} className="ui-button-ghost ui-icon-button lg:!hidden"><ChevronLeft className="size-4" /></Link>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Bot className="size-4" /></span>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">{selected.title || selected.task || t('untitled')}</h2>
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground"><span>{selectedAgent?.name ?? t('agent')}</span><span>·</span><span className="capitalize">{statusLabels[selected.status] ?? selected.status}</span><span className="hidden sm:inline" aria-hidden="true">·</span><span className="hidden sm:inline">{selected.sandbox?.name ?? t('sandboxUnavailable')}</span></p>
                </div>
              </div>
              <button type="button" onClick={() => setSandboxOpen(true)} aria-label={t('openWorkspace')} title={t('openWorkspace')} className="ui-button-secondary shrink-0 xl:!hidden"><TerminalSquare className="size-4" /><span className="hidden sm:inline">{t('workspace')}</span></button>
            </header>
            <AgentConversation
              key={selected.id}
              activeConversationId={selected.conversationId}
              agentId={selected.agentId}
              agentName={selectedAgent?.name ?? t('agent')}
              creatingConversation={false}
              ensureConversation={async () => selected.conversationId}
              initialMessages={selected.messages}
              ready={selectedAgent?.ready ?? false}
              runtimeKind={selectedAgent?.runtimeKind ?? null}
              workSessionId={selected.id}
            />
          </>
        ) : (
          <div className="m-auto max-w-sm px-6 text-center">
            <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Bot className="size-5" /></div>
            <h2 className="text-sm font-semibold">{t('emptyTitle')}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('emptyDescription')}</p>
          </div>
        )}
      </main>

      {selected ? <aside className="hidden min-h-0 overflow-hidden bg-background xl:block">
        {selected.sandbox ? (
          <SandboxConsole compact deploymentId={selected.sandbox.deploymentId} running={selected.sandbox.running} initialPath="." initialEntries={[]} terminalLabel={selected.sandbox.name} terminalSubtitle={t('sandboxSubtitle')} rpcApiBase={`/api/v1/work-sessions/${selected.id}/sandbox/rpc`} terminalApiBase={`/api/v1/work-sessions/${selected.id}/sandbox/terminal`} />
        ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Boxes className="mr-2 size-4" />{t('noSandbox')}</div>}
      </aside> : null}

      {sandboxOpen ? (
        <div role="dialog" aria-modal="true" aria-label={t('sandboxDialog')} className="fixed inset-0 z-50 flex flex-col bg-background xl:hidden">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3"><span className="text-sm font-medium">{t('workspace')}</span><button type="button" onClick={() => setSandboxOpen(false)} aria-label={t('closeWorkspace')} className="ui-button-ghost ui-icon-button"><X className="size-4" /></button></header>
          <div className="min-h-0 flex-1 overflow-hidden">{selected?.sandbox ? <SandboxConsole compact deploymentId={selected.sandbox.deploymentId} running={selected.sandbox.running} initialPath="." initialEntries={[]} terminalLabel={selected.sandbox.name} terminalSubtitle={t('sandboxSubtitle')} rpcApiBase={`/api/v1/work-sessions/${selected.id}/sandbox/rpc`} terminalApiBase={`/api/v1/work-sessions/${selected.id}/sandbox/terminal`} /> : null}</div>
        </div>
      ) : null}
    </div>
  );
}
