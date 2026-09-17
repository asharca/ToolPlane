'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

type Task = {
  id: string; callerAgentId: string; targetAgentId: string; targetName?: string; message?: string;
  status: { state: string; question: string | null; errorCode: string | null };
  cancelRequested: boolean; result: string | null; deadlineAt: string;
  artifacts: Array<{ artifactId: string; name: string; text: string }>;
};
const terminal = new Set(['completed', 'failed', 'canceled', 'rejected']);
export function AgentCollaborationPanel({ slug, agentId }: { slug: string; agentId: string }) {
  const t = useTranslations('console.agents.collaboration');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const requests = useRef(new Map<string, { text: string; id: string }>());
  const url = `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/collaboration`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('loadFailed');
    const value = await response.json();
    setTasks(value.tasks); setError('');
  }, [url]);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const poll = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { await refresh(controller.signal); }
      catch { if (!controller.signal.aborted) setError('loadFailed'); }
      finally { pending = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  async function act(task: Task, action: 'approve' | 'reject' | 'continue' | 'cancel') {
    setBusy(task.id); setError('');
    let extra = {};
    if (action === 'continue') {
      const text = (answers[task.id] ?? '').trim();
      if (!text) { setBusy(null); return; }
      let request = requests.current.get(task.id);
      if (!request || request.text !== text) {
        request = { text, id: crypto.randomUUID() }; requests.current.set(task.id, request);
      }
      extra = { message: text, messageId: request.id };
    }
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, taskId: task.id, ...extra }) });
      if (!response.ok) throw new Error(t('actionFailed'));
      if (action === 'continue') { requests.current.delete(task.id); setAnswers((v) => ({ ...v, [task.id]: '' })); }
      await refresh();
    } catch { setError('actionFailed'); }
    finally { setBusy(null); }
  }
  return <section className="mx-auto max-w-3xl space-y-4 p-6" aria-label={t('title')}>
    <h2 className="text-lg font-semibold">{t('title')}</h2>
    <p className="text-sm text-muted-foreground">{t('description')}</p>
    <p className="rounded-md border border-border p-3 text-sm">{t('approvalWarning')}</p>
    {error ? <p role="alert" className="text-sm text-destructive">{t(error)}</p> : null}
    {!tasks.length && !error ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
    {tasks.map((task) => <article key={task.id} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium"><a href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(task.targetAgentId)}?settings=agent`} className="underline underline-offset-2">{task.targetName ?? task.targetAgentId}</a></h3>
        <span className="text-sm">{t.has(`states.${task.status.state}`) ? t(`states.${task.status.state}`) : task.status.state}</span>
      </div>
      <p className="break-all text-xs text-muted-foreground">{task.id}</p>
      {task.message ? <p className="whitespace-pre-wrap break-words text-sm">{task.message}</p> : null}
      {task.status.question ? <p className="whitespace-pre-wrap text-sm">{task.status.question}</p> : null}
      {task.status.errorCode ? <p className="text-sm">{task.status.errorCode}</p> : null}
      {task.cancelRequested && !terminal.has(task.status.state) ? <p role="status" className="text-sm">{t('cancelPending')}</p> : null}
      {task.status.state === 'auth-required' ? <div className="flex gap-3">
        <button type="button" disabled={busy !== null} onClick={() => void act(task, 'approve')} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{t('approve')}</button>
        <button type="button" disabled={busy !== null} onClick={() => void act(task, 'reject')} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">{t('reject')}</button>
      </div> : null}
      {task.status.state === 'input-required' ? <div className="space-y-2">
        <textarea aria-label={t('answer')} value={answers[task.id] ?? ''} maxLength={8000}
          onChange={(event) => setAnswers((v) => ({ ...v, [task.id]: event.target.value }))}
          className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" />
        <button type="button" disabled={busy !== null || !answers[task.id]?.trim()} onClick={() => void act(task, 'continue')}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">{t('continue')}</button>
      </div> : null}
      {task.result ? <details><summary className="cursor-pointer text-sm">{t('result')}</summary><pre className="whitespace-pre-wrap break-words pt-2 text-sm">{task.result}</pre></details> : null}
      {task.artifacts.map((artifact) => <details key={artifact.artifactId}><summary className="cursor-pointer text-sm">{artifact.name}</summary><pre className="whitespace-pre-wrap break-words pt-2 text-sm">{artifact.text}</pre></details>)}
      {!terminal.has(task.status.state) ? <button type="button" disabled={busy !== null || task.cancelRequested} onClick={() => void act(task, 'cancel')}
        className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">{t('cancel')}</button> : null}
    </article>)}
    {tasks.length === 50 ? <p className="text-xs text-muted-foreground">{t('limit')}</p> : null}
  </section>;
}
