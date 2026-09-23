'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button, Input } from '@asharca/ui';
import type { RemoteAgentAction, RemoteAgentView } from '@/lib/a2a/remote-registry';

export function AgentA2ARemotes({ base }: { base: string }) {
  const t = useTranslations('console.agents.a2a.remote');
  const [view, setView] = useState<RemoteAgentView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [cardUrl, setCardUrl] = useState('');
  const [rpcUrl, setRpcUrl] = useState('');
  const [token, setToken] = useState('');
  const [keyTarget, setKeyTarget] = useState<string | null>(null);
  const mounted = useRef(true), flight = useRef(false), generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const endpoint = `${base}/remotes`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    const response = await fetch(endpoint, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error();
    const next: RemoteAgentView = await response.json();
    if (!Array.isArray(next.agents) || typeof next.canManage !== 'boolean') throw new Error();
    if (mounted.current && current === generation.current && !signal?.aborted) setView(next);
  }, [endpoint]);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal).catch(() => { if (!abort.signal.aborted) setError(t('failed')); });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);
  useEffect(() => {
    const clear = () => { if (document.hidden) setToken(''); };
    document.addEventListener('visibilitychange', clear);
    const timer = token ? setTimeout(() => setToken(''), 180_000) : undefined;
    return () => { document.removeEventListener('visibilitychange', clear); if (timer) clearTimeout(timer); };
  }, [token]);
  async function mutate(action: RemoteAgentAction) {
    if (flight.current || !window.confirm(t('confirm'))) return;
    flight.current = true; setBusy(true); setError('');
    controller.current = new AbortController();
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action), signal: AbortSignal.any([controller.current.signal, AbortSignal.timeout(25_000)]) });
      if (!response.ok) {
        const value = await response.json();
        // Only the BFF's fixed, sanitized policy messages are returned here; never native network exceptions.
        throw new Error(typeof value.error === 'string' ? value.error : t('failed'));
      }
      if (!mounted.current) return;
      setToken(''); setKeyTarget(null);
      if (action.action === 'register') { setName(''); setCardUrl(''); setRpcUrl(''); }
      await load();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error && failure.message ? failure.message : t('failed'));
    } finally {
      flight.current = false;
      if (mounted.current) { setBusy(false); setToken(''); }
    }
  }
  return <section className="space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5" aria-labelledby="a2a-remotes-title">
    <div className="flex items-center justify-between gap-3"><h3 id="a2a-remotes-title" className="font-semibold">{t('title')}</h3>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setError(''); void load().catch(() => { if (mounted.current) setError(t('failed')); }); }}>{t('refresh')}</Button></div>
    <p className="text-sm text-muted-foreground">{t('boundary')}</p>
    <p className="text-xs text-muted-foreground">{t('allowlist')}</p>
    {error ? <Alert role="alert">{error}</Alert> : null}
    {view?.canManage ? <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">{t('name')}<Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
      <label className="text-sm">{t('card')}<Input value={cardUrl} maxLength={2000} onChange={(e) => setCardUrl(e.target.value)} placeholder="https://agent.example/.well-known/agent-card.json" /></label>
      <label className="text-sm">{t('rpc')}<Input value={rpcUrl} maxLength={2000} onChange={(e) => setRpcUrl(e.target.value)} placeholder="https://agent.example/a2a" /></label>
      <label className="text-sm">{keyTarget ? t('replacementKey') : t('token')}<Input type="password" autoComplete="off" value={token} maxLength={8192} onChange={(e) => setToken(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-2"><Button disabled={busy || !!keyTarget || !name.trim() || !cardUrl || !rpcUrl} onClick={() => void mutate({ action: 'register', name, cardUrl, rpcUrl, ...(token ? { token } : {}) })}>{t('register')}</Button>
        {keyTarget ? <><Button disabled={busy || !token} onClick={() => {
          const target = view.agents.find((row) => row.id === keyTarget);
          if (target) void mutate({ action: 'replace-key', id: target.id, revision: target.revision, token });
        }}>{t('saveKey')}</Button><Button variant="secondary" disabled={busy} onClick={() => { setKeyTarget(null); setToken(''); }}>{t('dismiss')}</Button></> : null}</div>
    </div> : null}
    {view?.agents.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
    <div className="space-y-3">{view?.agents.map((remote) => <div key={remote.id} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{remote.name}</strong><Badge>{t(remote.enabled ? 'enabled' : 'disabled')}</Badge><Badge>{t(remote.allowed ? 'allowed' : 'denied')}</Badge></div>
      <code className="block break-all text-xs text-muted-foreground">{remote.rpcUrl}</code>
      <code className="block break-all text-xs">{remote.id}</code>
      {view.canManage ? <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate({ action: 'configure', id: remote.id, revision: remote.revision, enabled: !remote.enabled })}>{t(remote.enabled ? 'disable' : 'enable')}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate({ action: 'configure', id: remote.id, revision: remote.revision, allowCurrentAgent: !remote.allowed })}>{t(remote.allowed ? 'revoke' : 'allow')}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setToken(''); setKeyTarget(remote.id); }}>{t('replaceKey')}</Button>
      </div> : null}
    </div>)}</div>
    <p className="text-xs text-muted-foreground">{t('workflow')}</p>
  </section>;
}
