'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Input, Textarea } from '@asharca/ui';
import { ArrowUpRight, BookOpen, KeyRound, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { AgentA2ARemotes } from './AgentA2ARemotes';
import { AgentA2ATaskMonitor } from './AgentA2ATaskMonitor';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { A2A_DOCS, a2aCurlExample, a2aMcpConnectionExample, type A2AConsoleView } from '@/lib/a2a/connection-info';
import type { A2AConsoleAction } from '@/lib/a2a/console-service';

type WireTask = { id: string; contextId?: string; status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
  artifacts?: Array<{ artifactId: string; name?: string; parts?: Array<{ text?: string }> }> };
const cardClass = 'space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5';

export function AgentA2APanel({ slug, agentId, runtimeKind }: { slug: string; agentId: string; runtimeKind: string }) {
  const t = useTranslations('console.agents.a2a');
  const locale = useLocale();
  const [view, setView] = useState<A2AConsoleView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tasks, setTasks] = useState<WireTask[]>([]);
  const [selected, setSelected] = useState<WireTask | null>(null);
  const [taskId, setTaskId] = useState('');
  const [mode, setMode] = useState<'local' | 'public'>(runtimeKind === 'hermes' ? 'public' : 'local');
  const flight = useRef(false);
  const mounted = useRef(true);
  const base = `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/console`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(base, { cache: 'no-store', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(t('loadFailed'));
    const next: A2AConsoleView = await response.json();
    if (mounted.current && !signal?.aborted) setView(next);
  }, [base, t]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError(t('loadFailed')); });
    return () => { mounted.current = false; controller.abort(); };
    // Translation function identity is not stable in all consumers; reload only on identity change of the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => setSecret(''), 180_000);
    return () => clearTimeout(timer);
  }, [secret]);

  async function operation(run: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); }
    catch { if (mounted.current) setError(t('operationFailed')); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function mutate(action: A2AConsoleAction) {
    await operation(async () => {
      const response = await fetch(base, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
      if (!response.ok) throw new Error();
      const result = await response.json() as { token?: string };
      if (!mounted.current) return;
      setSecret(result.token ?? ''); setName(''); setNotice(t('saved'));
      // A refresh failure must not hide the one-time key returned by the committed write.
      try { await load(); } catch { if (mounted.current) setError(t('refreshFailed')); }
    });
  }
  async function rpc(method: string, params: unknown) {
    const response = await fetch(`${base}/rpc`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
    const envelope = await response.json();
    if (!response.ok || envelope.error) throw new Error();
    return envelope.result as { task?: WireTask; tasks?: WireTask[] } & WireTask;
  }
  function selectTask(task: WireTask) { setSelected(task); setTaskId(task.id); }
  async function send(continuation = false) {
    await operation(async () => {
      const result = await rpc('SendMessage', {
        message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: prompt }],
          ...(continuation && selected ? { taskId: selected.id, contextId: selected.contextId } : {}) },
        configuration: { returnImmediately: true, historyLength: 0 },
      });
      if (!mounted.current) return;
      if (result.task) selectTask(result.task);
      setPrompt(''); setNotice(t('accepted'));
    });
  }
  const doc = (key: keyof typeof A2A_DOCS) => locale.startsWith('zh') ? A2A_DOCS[key] : A2A_DOCS[key].replace('.zh-CN.md', '.md');
  const active = selected?.status?.state;
  const terminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(active ?? '');
  const connection = view?.connections;
  const rpcUrl = mode === 'local' ? connection?.localRpc : connection?.publicRpc;
  const cardUrl = mode === 'local' ? connection?.localCard : connection?.publicCard;
  const locked = busy || !view?.canManage;

  return <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="mb-2 flex items-center gap-2"><Network className="size-5" /><h2 className="text-lg font-semibold">{t('title')}</h2><Badge>A2A 1.0</Badge></div>
        <p className="max-w-xl text-sm text-muted-foreground">{t('description')}</p></div>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void operation(() => load())}><RefreshCw className="mr-1 size-4" />{t('refresh')}</Button>
    </header>
    {error ? <Alert tone="danger" role="alert">{error}</Alert> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    {!view ? <p role="status">{t('loading')}</p> : <>
      {!view.canManage ? <Alert>{t('readOnly')}</Alert> : null}
      {!connection ? <Alert tone="warning">{t('invalidOrigin')}</Alert> : null}
      <section className={cardClass} aria-labelledby="a2a-local-heading">
        <div className="flex items-start justify-between gap-3"><div><h3 id="a2a-local-heading" className="font-semibold">{t('localTitle')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('localDescription')}</p></div><Badge tone={view.local.enabled ? 'success' : 'neutral'}>{t(view.local.enabled ? 'enabled' : 'disabled')}</Badge></div>
        <p className="text-sm text-muted-foreground">{t('sandboxWarning')}</p>
        {!view.local.supported ? <Alert>{t('unsupportedLocal')}</Alert> : !view.local.ready ? <Alert tone="warning">{t('localNotReady')}</Alert> : null}
        <div className="flex flex-wrap items-center gap-3"><Button variant={view.local.enabled ? 'secondary' : 'primary'} disabled={locked || (!view.local.enabled && !view.local.ready)} onClick={() => {
          if (window.confirm(t(view.local.enabled ? 'disableLocalConfirm' : 'enableLocalConfirm'))) void mutate({ action: 'set-local', enabled: !view.local.enabled });
        }}>{t(view.local.enabled ? 'disableLocal' : 'enableLocal')}</Button>
          <a className="text-sm underline underline-offset-4" href={`?settings=subAgents`}>{t('configureTargets')}</a></div>
      </section>
      <section className={cardClass} aria-labelledby="a2a-public-heading">
        <div className="flex items-start justify-between gap-3"><div><h3 id="a2a-public-heading" className="font-semibold">{t('publicTitle')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('publicDescription')}</p></div>
          <Badge tone={view.endpoint?.enabled ? 'success' : 'neutral'}>{t(view.endpoint?.enabled ? 'enabled' : 'disabled')}</Badge></div>
        <p className="text-sm text-muted-foreground">{t('publicBoundary')}</p>
        {!view.endpoint?.ready ? <Alert tone="warning">{t('publishFirst')} {runtimeKind === 'hermes' ? <a className="underline" href="?settings=api">{t('openPublication')}</a> : null}</Alert> : <p className="text-xs text-muted-foreground">{t('revision', { version: view.endpoint.revision ?? '—' })}</p>}
        <Button variant={view.endpoint?.enabled ? 'secondary' : 'primary'} disabled={locked || (!view.endpoint?.enabled && !view.endpoint?.ready)} onClick={() => {
          if (window.confirm(t(view.endpoint?.enabled ? 'disablePublicConfirm' : 'enablePublicConfirm'))) void mutate({ action: 'set-public', enabled: !view.endpoint?.enabled });
        }}>{t(view.endpoint?.enabled ? 'disablePublic' : 'enablePublic')}</Button>
      </section>
      <section className={cardClass} aria-labelledby="a2a-connect-heading">
        <h3 id="a2a-connect-heading" className="font-semibold">{t('connectionTitle')}</h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('connectionMode')}>
          <Button size="sm" variant={mode === 'local' ? 'primary' : 'secondary'} aria-pressed={mode === 'local'} onClick={() => setMode('local')}>{t('localTitle')}</Button>
          <Button size="sm" variant={mode === 'public' ? 'primary' : 'secondary'} aria-pressed={mode === 'public'} onClick={() => setMode('public')}>{t('publicTitle')}</Button>
        </div>
        <p className="text-sm text-muted-foreground">{t(mode === 'local' ? 'accountCredential' : 'serviceCredential')}</p>
        {rpcUrl && cardUrl ? <>
          {[[t('rpcUrl'), rpcUrl], [t('cardUrl'), cardUrl]].map(([label, url]) => <div key={label} className="min-w-0 rounded-lg bg-muted/40 p-3">
            <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-medium">{label}</span><CopyButton text={url} label={t('copy')} /></div>
            <code className="block break-all text-xs">{url}</code></div>)}
          {(['card', 'SendMessage', 'GetTask', 'SubscribeToTask', 'CancelTask'] as const).map((method) => {
            const code = a2aCurlExample(method === 'card' ? cardUrl : rpcUrl, mode, method);
            return <details key={`${mode}:${method}`} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{method === 'card' ? t('getCard') : method}</summary>
              <div className="mt-3 flex justify-end"><CopyButton text={code} label={t('copy')} /></div><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{code}</pre></details>;
          })}
          {mode === 'public' && view.connections?.publicMcp ? <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('mcpConnection')}</summary>
            <p className="mt-3 text-xs text-muted-foreground">{t('mcpConnectionHint')}</p>
            <div className="mt-3 flex justify-end"><CopyButton text={a2aMcpConnectionExample(view.connections.publicMcp)} label={t('copy')} /></div>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">{a2aMcpConnectionExample(view.connections.publicMcp)}</pre>
          </details> : null}
          <p className="text-xs text-muted-foreground">{t('exampleWarning')}</p>
        </> : <p className="text-sm text-muted-foreground">{t('connectionUnavailable')}</p>}
      </section>
      {view.canManage && view.endpoint ? <section className={cardClass} aria-labelledby="a2a-keys-heading">
        <h3 id="a2a-keys-heading" className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" />{t('credentials')}</h3>
        <p className="text-sm text-muted-foreground">{t('keyWarning')}</p>
        {secret ? <Alert tone="warning"><p>{t('secretOnce')}</p><code className="my-3 block break-all select-all text-xs">{secret}</code>
          <div className="flex flex-wrap items-center gap-3"><CopyButton text={secret} label={t('copyKey')} /><Button size="sm" variant="secondary" onClick={() => setSecret('')}>{t('hideKey')}</Button></div></Alert> : null}
        <form onSubmit={(event) => { event.preventDefault(); void mutate({ action: 'create-client', name }); }} className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-sm">{t('clientName')}<Input className="mt-1" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('clientPlaceholder')} required /></label>
          <Button type="submit" disabled={busy || !!secret || !name.trim() || !view.endpoint.enabled || !view.endpoint.ready}>{t('createClient')}</Button>
        </form>
        {!view.endpoint.clients.length ? <p className="text-sm text-muted-foreground">{t('noClients')}</p> : view.endpoint.clients.map((client) => <div key={client.id} className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-sm font-medium">{client.name}</p>
            <Button size="sm" variant="secondary" disabled={busy || !!secret || !view.endpoint?.enabled || !view.endpoint.ready || client.status !== 'active'} onClick={() => void mutate({ action: 'create-key', clientId: client.id })}>{t('createKey')}</Button></div>
          {client.keys.map((key) => <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
            <div><code>{key.prefix}</code><p className="mt-1 text-muted-foreground">{t(key.revokedAt ? 'revoked' : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? 'expired' : 'activeKey')}</p></div>
            <Button size="sm" variant="danger-secondary" disabled={busy || !!key.revokedAt} onClick={() => { if (window.confirm(t('revokeConfirm'))) void mutate({ action: 'revoke-key', keyId: key.id }); }}>{t('revoke')}</Button>
          </div>)}
        </div>)}
      </section> : null}
      {view.local.supported ? <section className={cardClass} aria-labelledby="a2a-tasks-heading">
        <h3 id="a2a-tasks-heading" className="font-semibold">{t('tasksTitle')}</h3><p className="text-sm text-muted-foreground">{t('taskWarning')}</p>
        <label className="block text-sm">{t('taskMessage')}<Textarea className="mt-2" rows={3} maxLength={20000} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !view.local.enabled || !view.local.ready || !prompt.trim()} onClick={() => void send()}>{t('sendTask')}</Button>
          {active === 'TASK_STATE_INPUT_REQUIRED' ? <Button variant="secondary" disabled={busy || !prompt.trim()} onClick={() => void send(true)}>{t('continueTask')}</Button> : null}
          <Button variant="secondary" disabled={busy || !view.local.enabled || !view.local.ready} onClick={() => void operation(async () => {
            const result = await rpc('ListTasks', { pageSize: 20, historyLength: 0, includeArtifacts: false });
            if (mounted.current) setTasks(result.tasks ?? []);
          })}>{t('myTasks')}</Button></div>
        <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm">Task ID<Input className="mt-1" value={taskId} onChange={(e) => setTaskId(e.target.value)} maxLength={200} /></label>
          <Button variant="secondary" disabled={busy || !taskId.trim() || !view.local.enabled} onClick={() => void operation(async () => {
            const result = await rpc('GetTask', { id: taskId, historyLength: 0 }); if (mounted.current) selectTask(result);
          })}>{t('getTask')}</Button></div>
        {tasks.length ? <div className="max-h-48 space-y-1 overflow-auto" aria-label={t('myTasks')}>{tasks.map((task) => <button key={task.id} type="button" className="block w-full rounded-md border border-border p-2 text-left text-xs hover:bg-muted" onClick={() => selectTask(task)}><span className="break-all">{task.id}</span><span className="mt-1 block text-muted-foreground">{task.status?.state}</span></button>)}</div> : null}
        {selected ? <div className="space-y-3 rounded-lg bg-muted/40 p-3"><p className="break-all font-mono text-xs">{selected.id}</p><Badge>{active ?? '—'}</Badge>
          <AgentA2ATaskMonitor key={selected.id} base={base} rootTaskId={selected.id} onRootState={(state) => setSelected((task) => task && task.id === selected.id ? { ...task, status: { ...task.status, state } } : task)} />
          {!terminal ? <Button size="sm" variant="danger-secondary" disabled={busy} onClick={() => {
            if (window.confirm(t('cancelConfirm'))) void operation(async () => { const result = await rpc('CancelTask', { id: selected.id }); if (mounted.current) selectTask(result); });
          }}>{t('cancelTask')}</Button> : null}
        </div> : null}
      </section> : null}
    </>}
    {view?.local.supported ? <AgentA2ARemotes key={base} base={base} /> : null}
    <footer className={cardClass}>
      <h3 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />{t('docs')}</h3>
      <div className="flex flex-wrap gap-4 text-sm">{(['console', 'public', 'local'] as const).map((key) => <a key={key} href={doc(key)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">{t(key === 'console' ? 'consoleDocs' : key === 'public' ? 'publicDocs' : 'localDocs')}<ArrowUpRight className="size-3" /></a>)}</div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4 shrink-0" />{t('boundaries')}</p>
    </footer>
  </div>;
}
