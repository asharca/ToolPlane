'use client';
import { Select as BeuiSelect, Button as BeuiButton } from '@/components/ui/Controls';


import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Task, TaskState, taskStateFromJSON, taskStateToJSON } from '@a2a-js/sdk';
import { Alert, Badge, Button, Textarea } from "@/components/ui";
import { ArrowLeft, ArrowUpRight, Network, Plus, RefreshCw, Send } from 'lucide-react';
import { AgentA2ATaskMonitor } from '@/components/dashboard/agents/AgentA2ATaskMonitor';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { isWorkbenchTerminal, workbenchHref, workbenchMessage, workbenchRpc, workbenchTask } from '@/lib/a2a/workbench-client';
import type { WorkbenchAgent } from '@/lib/a2a/workbench';

type PendingSend = { params: Record<string, unknown>; messageId: string };

/** Daily task entry. URL navigation only reads state; all writes use the existing native A2A BFF. */
export function A2AWorkbench({ slug, agents, agentId, initialTaskId }: {
  slug: string; agents: WorkbenchAgent[]; agentId: string; initialTaskId?: string;
}) {
  const t = useTranslations('console.a2aWorkbench');
  const router = useRouter();
  const agent = agents.find((item) => item.id === agentId);
  const enabled = Boolean(agent?.enabled && agent.configured);
  const base = `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/console`;
  const [selected, setSelected] = useState<Task | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState('');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(Boolean(initialTaskId) && enabled);
  const [listFailed, setListFailed] = useState(false);
  const [listLoading, setListLoading] = useState(enabled);
  const [listRequest, setListRequest] = useState({ pageToken: '', revision: 0 });
  const [readFailed, setReadFailed] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const [monitorVersion, setMonitorVersion] = useState(0);
  const [cancelPending, setCancelPending] = useState(false);
  const alive = useRef(true);
  const writing = useRef(false);
  const listing = useRef(false);
  const flights = useRef(new Set<AbortController>());

  useEffect(() => {
    alive.current = true;
    const current = flights.current;
    return () => { alive.current = false; for (const flight of current) flight.abort(); current.clear(); };
  }, []);
  const rpc = useCallback(async (method: string, params: Record<string, unknown>) => {
    const controller = new AbortController(); flights.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try { return await workbenchRpc(base, method, params, controller.signal); }
    finally { clearTimeout(timeout); flights.current.delete(controller); }
  }, [base]);
  const refreshTasks = useCallback((pageToken = '') => {
    if (!enabled || listing.current) return;
    setListLoading(true);
    setListRequest((request) => ({ pageToken, revision: request.revision + 1 }));
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    listing.current = true;
    const pageToken = listRequest.pageToken;
    void rpc('ListTasks', { pageSize: 20, pageToken, historyLength: 0, includeArtifacts: false }).then((result) => {
      if (!Array.isArray(result.tasks) || result.tasks.length > 20 || typeof result.nextPageToken !== 'string') throw new Error('Invalid task list.');
      const rows = result.tasks.map(workbenchTask);
      if (stopped || !alive.current) return;
      setTasks((previous) => pageToken ? [...new Map([...previous, ...rows].map((task) => [task.id, task])).values()].slice(0, 200) : rows);
      setCursor(result.nextPageToken); setListFailed(false);
    }).catch(() => { if (!stopped && alive.current) setListFailed(true); })
      .finally(() => { if (!stopped) { listing.current = false; if (alive.current) setListLoading(false); } });
    return () => { stopped = true; listing.current = false; };
  }, [enabled, rpc, listRequest]);
  useEffect(() => {
    if (!initialTaskId || !enabled) return;
    let stopped = false;
    void rpc('GetTask', { id: initialTaskId, historyLength: 0 }).then((result) => {
      const task = workbenchTask(result);
      if (task.id !== initialTaskId) throw new Error('Task identity mismatch.');
      if (!stopped && alive.current) { setSelected(task); setReadFailed(false); }
    }).catch(() => { if (!stopped && alive.current) setReadFailed(true); })
      .finally(() => { if (!stopped && alive.current) setLoading(false); });
    return () => { stopped = true; };
  }, [initialTaskId, enabled, rpc, readVersion]);
  const selectTask = (task: Task) => {
    if (pending || writing.current) return;
    router.push(workbenchHref(slug, agentId, task.id), { scroll: false });
  };
  const submit = async () => {
    if (!enabled || writing.current || loading || readFailed || (!pending && cancelPending)) return;
    let attempt: PendingSend;
    try {
      if (pending) attempt = pending;
      else {
        const messageId = crypto.randomUUID();
        attempt = { messageId, params: workbenchMessage(prompt, selected, messageId) };
      }
    }
    catch { setError(t('notReady')); return; }
    writing.current = true; setBusy(true); setPending(attempt); setError(''); setNotice('');
    try {
      const result = await rpc('SendMessage', attempt.params);
      const task = workbenchTask(result.task);
      const message = attempt.params.message as { taskId?: string; contextId?: string };
      if ((message.taskId && task.id !== message.taskId) || (message.contextId && task.contextId !== message.contextId)) {
        throw new Error('Task identity mismatch.');
      }
      if (!alive.current) return;
      setSelected(task); setPending(null); setPrompt(''); setCancelPending(false); setMonitorVersion((n) => n + 1);
      setNotice(t('accepted')); void refreshTasks();
      router.replace(workbenchHref(slug, agentId, task.id), { scroll: false });
    } catch { if (alive.current) setError(t('sendUncertain')); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const cancel = async () => {
    if (!selected || writing.current || pending || !window.confirm(t('cancelConfirm'))) return;
    writing.current = true; setBusy(true); setError(''); setCancelPending(true);
    try {
      const result = await rpc('CancelTask', { id: selected.id });
      const task = workbenchTask(result);
      if (task.id !== selected.id) throw new Error('Task identity mismatch.');
      if (alive.current) { setSelected(task); setCancelPending(!isWorkbenchTerminal(task.status!.state)); setMonitorVersion((n) => n + 1); setNotice(t('cancelCheck')); }
    } catch { if (alive.current) setError(t('cancelCheck')); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const state = selected?.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
  const terminal = isWorkbenchTerminal(state);
  const canSend = enabled && !loading && !readFailed && !cancelPending
    && (!selected || terminal || state === TaskState.TASK_STATE_INPUT_REQUIRED);
  const onRootState = useCallback((wireState: string) => {
    const next = taskStateFromJSON(wireState);
    if (next === TaskState.UNRECOGNIZED || next === TaskState.TASK_STATE_UNSPECIFIED) return;
    setReadFailed(false);
    setSelected((task) => task?.status ? { ...task, status: { ...task.status, state: next } } : task);
    if (isWorkbenchTerminal(next)) setCancelPending(false);
  }, []);
  const onUnavailable = useCallback(() => setReadFailed(true), []);
  const newSession = () => {
    if (pending || writing.current) return;
    if (!initialTaskId) { setSelected(null); setPrompt(''); setNotice(''); setError(''); setReadFailed(false); setCancelPending(false); }
    router.push(workbenchHref(slug, agentId));
  };
  const navigateAway = () => !pending || window.confirm(t('leavePending'));

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3"><Network className="size-5 text-muted-foreground" /><div><h1 className="text-base font-semibold">{t('title')}</h1><p className="text-xs text-muted-foreground">{t('subtitle')}</p></div></div>
      <Link href={`/app/${encodeURIComponent(slug)}/work`} onClick={(e) => { if (!navigateAway()) e.preventDefault(); }} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t('legacy')}</Link>
    </header>
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[16rem_minmax(0,1fr)] md:overflow-hidden">
      <aside className="space-y-4 border-b border-border p-4 md:overflow-y-auto md:border-r md:border-b-0">
        <label className="block text-sm font-medium">{t('agent')}<BeuiSelect className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-2 text-sm" aria-label={t('agent')} value={agentId}
          disabled={busy || Boolean(pending)} onChange={(event) => router.push(workbenchHref(slug, event.target.value))}>
          {!agents.length ? <option value="">{t('noAgents')}</option> : null}
          {agents.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.enabled ? ` · ${t('disabled')}` : ''}</option>)}
        </BeuiSelect></label>
        {agent ? <Link href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}?settings=a2a`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4" onClick={(e) => { if (!navigateAway()) e.preventDefault(); }}>{t('settings')}<ArrowUpRight className="size-3" /></Link> : null}
        <Button variant="secondary" className="w-full" disabled={busy || Boolean(pending)} onClick={newSession}><Plus className="size-4" />{t('newSession')}</Button>
        <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('recent')}</h2><Button size="sm" variant="ghost" aria-label={t('refresh')} disabled={listLoading || !enabled} onClick={() => { setListLoading(true); void refreshTasks(); }}><RefreshCw className="size-4" /></Button></div>
        {listFailed ? <Alert tone="warning">{t('listFailed')}</Alert> : null}
        <ul className="max-h-60 space-y-2 overflow-auto md:max-h-none">{tasks.map((task) => <li key={task.id}><BeuiButton nativeButton unstyled type="button" disabled={busy || Boolean(pending)} aria-current={selected?.id === task.id ? 'page' : undefined}
          className="w-full rounded-lg border border-border p-3 text-left hover:bg-muted disabled:opacity-60 aria-[current=page]:bg-muted" onClick={() => selectTask(task)}>
          <code className="block truncate text-xs">{task.id}</code><span className="mt-1 block text-[11px] text-muted-foreground">{taskStateToJSON(task.status!.state)}</span></BeuiButton></li>)}</ul>
        {!tasks.length && !listLoading ? <p className="text-xs text-muted-foreground">{t('noTasks')}</p> : null}
        {cursor ? <Button size="sm" variant="secondary" disabled={listLoading || tasks.length >= 200} onClick={() => { setListLoading(true); void refreshTasks(cursor); }}>{t('more')}</Button> : null}
      </aside>
      <div className="min-w-0 space-y-5 p-4 sm:p-6 md:overflow-y-auto">
        <Alert tone="info">{t('boundary')}</Alert>
        {!enabled ? <Alert tone="warning">{t('notReady')}</Alert> : null}
        {loading ? <p role="status">{t('loading')}</p> : null}
        {readFailed ? <div className="space-y-2"><Alert tone="warning">{t('readFailed')}</Alert>{initialTaskId ? <Button variant="secondary" size="sm" disabled={loading || busy} onClick={() => { setLoading(true); setReadVersion((n) => n + 1); }}>{t('retryRead')}</Button> : null}</div> : null}
        {selected ? <><div className="flex flex-wrap items-center gap-2"><Badge>{taskStateToJSON(state)}</Badge><code className="break-all text-xs">{selected.id}</code>
          <CopyButton text={workbenchHref(slug, agentId, selected.id)} label={t('copyLink')} /></div>
          <p className="break-all text-xs text-muted-foreground">Context: {selected.contextId}</p>
          <AgentA2ATaskMonitor key={`${selected.id}:${monitorVersion}`} base={base} rootTaskId={selected.id} showHistory onRootState={onRootState} onUnavailable={onUnavailable} />
        </> : !loading && !readFailed ? <div className="rounded-xl border border-dashed border-border px-5 py-8"><h2 className="font-semibold">{t('emptyTitle')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('emptyHint')}</p></div> : null}
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
        {error ? <Alert tone="warning" role="alert">{error}</Alert> : null}
        {pending ? <div className="space-y-2 rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{t('pendingHint')}</p><code className="block break-all text-xs">{pending.messageId}</code>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { if (window.confirm(t('leavePending'))) { setPending(null); setError(''); } }}>{t('discardPending')}</Button></div> : null}
        <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="block text-sm font-medium" htmlFor="a2a-workbench-prompt">{t(state === TaskState.TASK_STATE_INPUT_REQUIRED ? 'answer' : selected ? 'followUp' : 'prompt')}</label>
          <Textarea id="a2a-workbench-prompt" rows={4} value={prompt} maxLength={20000} disabled={busy || Boolean(pending) || !canSend} onChange={(e) => setPrompt(e.target.value)} placeholder={t('placeholder')} />
          <p className="text-xs text-muted-foreground">{t(state === TaskState.TASK_STATE_AUTH_REQUIRED ? 'authorizationRequired' : selected && !terminal && state !== TaskState.TASK_STATE_INPUT_REQUIRED ? 'working' : terminal ? 'terminalHint' : 'sendHint')}</p>
          <div className="flex flex-wrap items-center justify-between gap-2"><Button type="submit" disabled={busy || (!pending && (!canSend || !prompt.trim()))}><Send className="size-4" />{t(pending ? 'retry' : state === TaskState.TASK_STATE_INPUT_REQUIRED ? 'sendAnswer' : selected ? 'sendFollowUp' : 'send')}</Button>
            {selected && !terminal ? <Button type="button" variant="danger-secondary" disabled={busy || Boolean(pending) || cancelPending} onClick={() => void cancel()}>{t('cancel')}</Button> : null}</div>
        </form>
      </div>
    </div>
  </div>;
}
