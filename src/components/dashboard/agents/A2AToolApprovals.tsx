'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@asharca/ui';
type Approval = { id: string; taskId: string; toolName: string; input: unknown; inputHash: string; status: string; expiresAt: string };
/** Decisions remain a same-origin human control plane, never an A2A message from a model. */
export function A2AToolApprovals({ base, rootTaskId, taskId }: { base: string; rootTaskId: string; taskId: string }) {
  const t = useTranslations('console.agents.a2a.approvals');
  const [items, setItems] = useState<Approval[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [observedAt, setObservedAt] = useState(0);
  const mounted = useRef(true);
  const decisionFlight = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; decisionFlight.current?.abort(); }; }, []);
  useEffect(() => {
    let alive = true, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flight: AbortController | undefined;
    async function load() {
      if (!alive || document.hidden || flight) return;
      const controller = new AbortController(); flight = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const params = new URLSearchParams({ rootTaskId, taskId });
        const response = await fetch(`${base}/approvals?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if ([401,403,404].includes(response.status)) { failures = 3; throw new Error(); }
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.approvals) || body.approvals.length > 32) throw new Error();
        if (alive && !controller.signal.aborted) { setItems(body.approvals); setObservedAt(Date.now()); setFailed(false); failures = 0; }
      } catch { if (alive) { failures++; setFailed(true); setItems([]); } }
      finally {
        clearTimeout(timeout); flight = undefined;
        if (alive && failures < 3 && !document.hidden) timer = setTimeout(load, 2500 * (1 + failures));
      }
    }
    const visible = () => { if(timer)clearTimeout(timer);if(document.hidden)flight?.abort();else if(failures<3)void load(); };
    document.addEventListener('visibilitychange', visible); void load();
    return () => { alive=false;if(timer)clearTimeout(timer);flight?.abort();document.removeEventListener('visibilitychange', visible); };
  }, [base, rootTaskId, taskId, revision]);
  async function decide(item: Approval, decision: 'approved' | 'denied') {
    if (decisionFlight.current) return;
    const controller = new AbortController(); decisionFlight.current = controller; setBusy(item.id);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base}/approvals`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: {'content-type':'application/json'}, body: JSON.stringify({rootTaskId,taskId,approvalId:item.id,inputHash:item.inputHash,decision}) });
      if (!response.ok) throw new Error();
      if(mounted.current)setRevision(value=>value+1);
    } catch { if(mounted.current){setFailed(true);setItems([]);} }
    finally {clearTimeout(timeout);decisionFlight.current=null;if(mounted.current)setBusy(null);}
  }
  return <section aria-label={t('title')} className="space-y-3">
    <h5 className="text-sm font-semibold">{t('title')}</h5><p className="text-xs text-muted-foreground">{t('hint')}</p>
    {failed ? <Alert tone="warning">{t('failed')} <Button type="button" size="sm" variant="secondary" onClick={()=>setRevision(value=>value+1)}>{t('refresh')}</Button></Alert> : null}
    {items.map(item=><article key={item.id} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap justify-between gap-2"><strong className="text-sm">{item.toolName}</strong><span className="text-xs">{item.status}</span></div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item.input,null,2)}</pre>
      {item.status==='pending' && Date.parse(item.expiresAt)>observedAt ? <div className="flex gap-2">
        <Button type="button" size="sm" disabled={Boolean(busy)} onClick={()=>void decide(item,'approved')}>{t('approve')}</Button>
        <Button type="button" size="sm" variant="secondary" disabled={Boolean(busy)} onClick={()=>void decide(item,'denied')}>{t('deny')}</Button>
      </div> : null}
    </article>)}
  </section>;
}
