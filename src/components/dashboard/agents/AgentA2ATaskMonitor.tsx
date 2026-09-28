'use client';
import { Button } from '@/components/motion/button/base';
import { AnimatedBadge } from '@/components/motion/animated-badge';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { A2AToolApprovals } from './A2AToolApprovals';
import { A2AArtifactParts, type A2AWirePart } from './A2AArtifactParts';

import type { ConsoleTaskTree } from '@/lib/a2a/console-tasks';

type ResultTask = { id: string; status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
  history?: Array<{ messageId: string; role: string; parts?: A2AWirePart[] }>;
  artifacts?: Array<{ artifactId: string; name?: string; parts?: A2AWirePart[] }> };
const terminal = (state: string) => ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state);

/** Read-only task monitoring never resubmits work, even after a network failure. */
export function AgentA2ATaskMonitor({ base, rootTaskId, onRootState, onUnavailable, showHistory = false }: {
  base: string; rootTaskId: string; onRootState: (state: string) => void; onUnavailable?: () => void; showHistory?: boolean;
}) {
  const t = useTranslations('console.agents.a2a');
  const [tree, setTree] = useState<ConsoleTaskTree | null>(null);
  const [selectedId, setSelectedId] = useState(rootTaskId);
  const [automatic, setAutomatic] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const notify = useRef(onRootState);
  const unavailable = useRef(onUnavailable);
  useEffect(() => { unavailable.current = onUnavailable; }, [onUnavailable]);
  useEffect(() => { notify.current = onRootState; }, [onRootState]);
  useEffect(() => {
    let stopped = false;
    let flight: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let done = false;
    const load = async () => {
      if (stopped || flight || document.hidden) return;
      const controller = new AbortController(); flight = controller;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
      try {
        const query = new URLSearchParams({ rootTaskId, selectedTaskId: selectedId });
        if (showHistory) query.set('historyLength', '32');
        const response = await fetch(`${base}/tasks?${query}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if ([401, 403, 404].includes(response.status)) {
          if (!stopped && !controller.signal.aborted) {
            done = true; setTree(null); setFailed(true); unavailable.current?.();
          }
          return;
        }
        if (!response.ok) throw new Error('Task tree unavailable');
        const value = await response.json() as ConsoleTaskTree;
        if (stopped || controller.signal.aborted) return;
        if (value.rootTaskId !== rootTaskId || !Array.isArray(value.nodes)) throw new Error('Invalid task tree');
        setTree(value); setFailed(false); failures = 0;
        const root = value.nodes.find((node) => node.id === rootTaskId);
        if (root) notify.current(root.state);
        done = value.nodes.length > 0 && value.nodes.every((node) => terminal(node.state));
      } catch {
        if (!stopped && (!controller.signal.aborted || timedOut)) { failures++; setFailed(true); }
      } finally {
        clearTimeout(timeout);
        if (flight === controller) flight = undefined;
        if (!stopped && automatic && !done && failures < 3 && !document.hidden) {
          timer = setTimeout(() => { timer = undefined; void load(); }, Math.min(20_000, 2500 * 2 ** failures));
        }
      }
    };
    const visibility = () => {
      if (timer) clearTimeout(timer); timer = undefined;
      if (document.hidden) flight?.abort();
      else if (automatic && !done) { failures = 0; void load(); }
    };
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); flight?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [base, rootTaskId, selectedId, automatic, refresh, showHistory]);

  const selected = tree?.selectedTask as ResultTask | undefined;
  const depthOf = (id: string) => {
    let depth = 0;
    let node = tree?.nodes.find((item) => item.id === id);
    const visited = new Set<string>();
    while (node?.parentTaskId && depth < 3 && !visited.has(node.id)) {
      visited.add(node.id); depth++; node = tree?.nodes.find((item) => item.id === node!.parentTaskId);
    }
    return depth;
  };
  return <section className="space-y-3" aria-label={t('taskTree')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold">{t('taskTree')}</h4>
      <div className="flex gap-2"><Button aria-pressed={automatic} onClick={() => setAutomatic((value) => !value)} variant={"secondary"} size={"sm"}>{t(automatic ? 'pauseMonitoring' : 'resumeMonitoring')}</Button>
        <Button onClick={() => setRefresh((value) => value + 1)} variant={"secondary"} size={"sm"}>{t('refreshTasks')}</Button></div>
    </div>
    <p className="text-xs text-muted-foreground">{t('monitoringHint')}</p>
    {failed ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('monitoringFailed')}</div> : null}
    {tree?.restricted ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('restrictedTasks')}</div> : null}
    {!tree && !failed ? <p role="status">{t('loading')}</p> : null}
    <ul className="space-y-2">{tree?.nodes.map((node) => <li key={node.id} style={{ marginInlineStart: `${depthOf(node.id)}rem` }}>
      <Button type="button" aria-pressed={selectedId === node.id} onClick={() => { setSelectedId(node.id); setRefresh((value) => value + 1); }} variant={selectedId === node.id ? 'secondary' : 'ghost'} className="w-full flex-wrap justify-between text-left">
        <span className="min-w-0"><span className="block text-sm font-medium">{node.name}</span><code className="block break-all text-xs text-muted-foreground">{node.id}</code></span>
        <span className="flex flex-wrap items-center gap-2 text-xs"><AnimatedBadge>{node.state}</AnimatedBadge>{node.pendingApprovals ? <AnimatedBadge>{t('approvals.pending', { count: node.pendingApprovals })}</AnimatedBadge> : null}<span>{t(node.executionBackend === 'pi-harness' && node.phase === 'resumable' ? 'phase_recovering' : `phase_${node.phase}`)}</span>{node.cancelRequested ? <span>{t('cancellationPending')}</span> : null}</span>
      </Button>
    </li>)}</ul>
    {selected ? <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" role="region" aria-label={t('taskResult')}>
      <code className="block break-all text-xs">{selected.id}</code>
      {tree?.nodes.find(node=>node.id===selected.id)?.phase === 'executing' ? <A2AToolApprovals key={`${rootTaskId}:${selected.id}`} base={base} rootTaskId={rootTaskId} taskId={selected.id} /> : null}
      {showHistory && selected.history?.length ? <ol className="space-y-3" aria-label={t('taskHistory')}>{selected.history.map((message) => <li key={message.messageId} className="rounded-lg border border-border p-3"><p className="mb-2 text-xs font-medium text-muted-foreground">{t(message.role === 'ROLE_USER' ? 'historyUser' : 'historyAgent')}</p><A2AArtifactParts name={message.messageId} parts={message.parts ?? []} /></li>)}</ol> : null}
      {selected.status?.message?.parts?.map((part, index) => part.text ? <p key={index} className="whitespace-pre-wrap break-words text-sm">{part.text}</p> : null)}
      {selected.artifacts?.map((artifact) => <div key={artifact.artifactId}><h5 className="text-sm font-medium">{artifact.name || artifact.artifactId}</h5>
        <A2AArtifactParts name={artifact.name || artifact.artifactId} parts={artifact.parts ?? []} /></div>)}
    </div> : null}
  </section>;
}
