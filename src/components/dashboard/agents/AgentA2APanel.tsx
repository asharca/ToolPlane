'use client';
import { BouncyAccordion } from '@/components/motion/bouncy-accordion';
import { Button, ButtonLink } from '@/components/motion/button/base';
import { Input } from '@/components/motion/input';

import { AnimatedBadge } from '@/components/motion/animated-badge';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { ArrowUpRight, BookOpen, KeyRound, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { AgentA2ARemotes } from './AgentA2ARemotes';
import { AgentA2ATaskMonitor } from './AgentA2ATaskMonitor';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { A2A_DOCS, a2aCurlExample, a2aMcpConnectionExample, type A2AConsoleView } from '@/lib/a2a/connection-info';
import type { A2AConsoleAction } from '@/lib/a2a/console-service';

const cardClass = 'space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5';

export function AgentA2APanel({ slug, agentId, runtimeKind, initialTaskId }: { slug: string; agentId: string; runtimeKind: string; initialTaskId?: string }) {
  const t = useTranslations('console.agents.a2a');
  const locale = useLocale();
  const [view, setView] = useState<A2AConsoleView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
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
  const doc = (key: keyof typeof A2A_DOCS) => locale.startsWith('zh') ? A2A_DOCS[key] : A2A_DOCS[key].replace('.zh-CN.md', '.md');
  const connection = view?.connections;
  const rpcUrl = mode === 'local' ? connection?.localRpc : connection?.publicRpc;
  const cardUrl = mode === 'local' ? connection?.localCard : connection?.publicCard;
  const tokenSetup = `export ${mode === 'local' ? 'TOOLPLANE_ACCOUNT_TOKEN' : 'TOOLPLANE_A2A_TOKEN'}='REPLACE_WITH_TOKEN'`;
  const locked = busy || !view?.canManage;

  return <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="mb-2 flex items-center gap-2"><Network className="size-5" /><h2 className="text-lg font-semibold">{t('title')}</h2><AnimatedBadge>A2A 1.0</AnimatedBadge></div>
        <p className="max-w-xl text-sm text-muted-foreground">{t('description')}</p></div>
      <Button disabled={busy} onClick={() => void operation(() => load())} variant={"secondary"} size={"sm"}><RefreshCw className="mr-1 size-4" />{t('refresh')}</Button>
    </header>
    {error ? <div role="alert" className="space-y-2 text-sm text-destructive">{error}</div> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    {!view ? <p role="status">{t('loading')}</p> : <>
      {!view.canManage ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('readOnly')}</div> : null}
      <section className={cardClass} aria-labelledby="a2a-internal-heading">
        <h3 id="a2a-internal-heading" className="font-semibold">{t('internalTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('internalDescription')}</p>
        <p className="text-sm text-muted-foreground">{t('authorizedTargetsOnly')}</p>
        <p className="text-sm text-muted-foreground">{t('sandboxWarning')}</p>
        {!view.local.supported ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('unsupportedLocal')}</div> : !view.local.ready ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('localNotReady')}</div> : null}
        <a className="text-sm underline underline-offset-4" href="?settings=subAgents">{t('configureTargets')}</a>
      </section>
      <section className={cardClass} aria-labelledby="a2a-local-heading">
        <div className="flex items-start justify-between gap-3"><div><h3 id="a2a-local-heading" className="font-semibold">{t('localTitle')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('localDescription')}</p></div><AnimatedBadge status={view.local.enabled ? 'success' : 'neutral'}>{t(view.local.enabled ? 'enabled' : 'disabled')}</AnimatedBadge></div>
        <Button disabled={locked || (!view.local.enabled && !view.local.ready)} onClick={() => {
          if (window.confirm(t(view.local.enabled ? 'disableLocalConfirm' : 'enableLocalConfirm'))) void mutate({ action: 'set-local', enabled: !view.local.enabled });
        }} variant={view.local.enabled ? 'secondary' : 'primary'}>{t(view.local.enabled ? 'disableLocal' : 'enableLocal')}</Button>
      {view.canManage && view.channels?.length ? <section className={cardClass} aria-labelledby="a2a-channel-operator-heading">
        <h3 id="a2a-channel-operator-heading" className="font-semibold">{t('channelOperator.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('channelOperator.hint')}</p>
        {view.channels.map((channel) => <div key={channel.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
          <span className="text-sm">{channel.name} · {channel.platform}</span>
          <Button type="button" disabled={busy || (!channel.enabled && !view.local.enabled)} onClick={() => {
            if (window.confirm(t('channelOperator.confirm'))) void mutate({ action: 'set-channel-operator', connectionId: channel.id, enabled: !channel.enabled });
          }} variant={"secondary"} size={"sm"}>{t(channel.enabled ? 'channelOperator.disable' : 'channelOperator.enable')}</Button>
        </div>)}
      </section> : null}
      </section>
      {view.local.supported ? <AgentA2ARemotes key={base} base={base} /> : null}
      {runtimeKind === 'hermes' ? <section className={cardClass} aria-labelledby="a2a-public-heading">
        <div className="flex items-start justify-between gap-3"><div><h3 id="a2a-public-heading" className="font-semibold">{t('publicTitle')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('publicDescription')}</p></div>
          <AnimatedBadge status={view.endpoint?.enabled ? 'success' : 'neutral'}>{t(view.endpoint?.enabled ? 'enabled' : 'disabled')}</AnimatedBadge></div>
        <p className="text-sm text-muted-foreground">{t('publicBoundary')}</p>
        {!view.endpoint?.ready ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('publishFirst')} {runtimeKind === 'hermes' ? <a className="underline" href="?settings=api">{t('openPublication')}</a> : null}</div> : <p className="text-xs text-muted-foreground">{t('revision', { version: view.endpoint.revision ?? '—' })}</p>}
        <Button disabled={locked || (!view.endpoint?.enabled && !view.endpoint?.ready)} onClick={() => {
          if (window.confirm(t(view.endpoint?.enabled ? 'disablePublicConfirm' : 'enablePublicConfirm'))) void mutate({ action: 'set-public', enabled: !view.endpoint?.enabled });
        }} variant={view.endpoint?.enabled ? 'secondary' : 'primary'}>{t(view.endpoint?.enabled ? 'disablePublic' : 'enablePublic')}</Button>
      </section> : null}
      <section className={cardClass} aria-labelledby="a2a-connect-heading">
        <h3 id="a2a-connect-heading" className="font-semibold">{t('connectionTitle')}</h3>
        {!connection ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">{t('invalidOrigin')}</div> : null}
        {runtimeKind === 'hermes' ? <div className="flex flex-wrap gap-2" role="group" aria-label={t('connectionMode')}>
          <Button aria-pressed={mode === 'local'} onClick={() => setMode('local')} variant={mode === 'local' ? 'primary' : 'secondary'} size={"sm"}>{t('localTitle')}</Button>
          <Button aria-pressed={mode === 'public'} onClick={() => setMode('public')} variant={mode === 'public' ? 'primary' : 'secondary'} size={"sm"}>{t('publicTitle')}</Button>
        </div> : null}
        <p className="text-sm text-muted-foreground">{t(mode === 'local' ? 'accountCredential' : 'serviceCredential')}</p>
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">{t('inboundGuide.title')}</h4>
          <p className="text-sm text-muted-foreground">{t('inboundGuide.whereToRun')}</p>
          <p className="text-sm text-muted-foreground">{t('inboundGuide.internalOnly')}</p>
          <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
            <li>{t(mode === 'local' ? 'inboundGuide.enableLocal' : 'inboundGuide.enablePublic')}</li>
            <li>{t(mode === 'local' ? 'inboundGuide.tokenLocal' : 'inboundGuide.tokenPublic')}
              {mode === 'local' ? <a className="ml-1 underline underline-offset-4" href={`/app/${encodeURIComponent(slug)}/settings/account?section=tokens`} target="_blank" rel="noopener noreferrer">{t('inboundGuide.openTokens')}</a> : null}
              <p className="mt-2">{t('inboundGuide.tokenSetup')}</p>
              <div className="mt-2 flex justify-end"><CopyButton text={tokenSetup} label={t('copy')} /></div>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">{tokenSetup}</pre>
            </li>
            <li>{t('inboundGuide.send')}
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted/40 p-3"><code className="text-xs">uuidgen</code><CopyButton text="uuidgen" label={t('copy')} /></div>
            </li>
            <li>{t('inboundGuide.result')}</li>
          </ol>
          <p className="text-xs text-muted-foreground">{t(mode === 'local' ? 'inboundGuide.serverOnly' : 'inboundGuide.publicIdentity')}</p>
        </div>
        {rpcUrl && cardUrl ? <>
          {[[t('rpcUrl'), rpcUrl], [t('cardUrl'), cardUrl]].map(([label, url]) => <div key={label} className="min-w-0 rounded-lg bg-muted/40 p-3">
            <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-medium">{label}</span><CopyButton text={url} label={t('copy')} /></div>
            <code className="block break-all text-xs">{url}</code></div>)}
          {(['card', 'SendMessage', 'GetTask', 'SubscribeToTask', 'CancelTask'] as const).map((method) => {
            const code = a2aCurlExample(method === 'card' ? cardUrl : rpcUrl, mode, method);
            const title = method === 'card' ? t('getCard') : method;
            const content = <>
              <p className="mt-3 text-sm text-muted-foreground">{t(`inboundGuide.${method}`)}</p>
              <div className="mt-3 flex justify-end"><CopyButton text={code} label={t('copy')} /></div><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{code}</pre></>;
            return method === 'card' || method === 'SendMessage'
              ? <section key={`${mode}:${method}`} className="min-w-0 rounded-lg border border-border p-3" aria-label={title}><h4 className="text-sm font-semibold">{title}</h4>{content}</section>
              : <BouncyAccordion key={`${mode}:${method}`} items={[{ id: 'details', title, description: content }]} />;
          })}
          {mode === 'public' && view.connections?.publicMcp ? <BouncyAccordion items={[{ id: 'details', title: <>{t('mcpConnection')}</>, description: <>
            <p className="mt-3 text-xs text-muted-foreground">{t('mcpConnectionHint')}</p>
            <div className="mt-3 flex justify-end"><CopyButton text={a2aMcpConnectionExample(view.connections.publicMcp)} label={t('copy')} /></div>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">{a2aMcpConnectionExample(view.connections.publicMcp)}</pre>
          </> }]} /> : null}
          <p className="text-xs text-muted-foreground">{t('exampleWarning')}</p>
        </> : <p className="text-sm text-muted-foreground">{t('connectionUnavailable')}</p>}
        <BouncyAccordion items={[{ id: 'responses', title: t('inboundGuide.responsesTitle'), description: <div className="space-y-3 pt-3 text-sm text-muted-foreground">
          <p>{t('inboundGuide.responses')}</p>
          <p>{t('inboundGuide.waiting')}</p>
          <p>{t('inboundGuide.continue')}</p>
          <p>{t('inboundGuide.terminal')}</p>
        </div> }, { id: 'troubleshooting', title: t('inboundGuide.errorsTitle'), description: <ul className="list-disc space-y-2 pl-5 pt-3 text-sm text-muted-foreground">
          {(['origin', 'unauthorized', 'forbidden', 'notFound', 'protocol', 'execution'] as const).map((key) => <li key={key}>{t(`inboundGuide.${key}`)}</li>)}
        </ul> }]} />
      </section>
      {runtimeKind === 'hermes' && view.canManage && view.endpoint ? <section className={cardClass} aria-labelledby="a2a-keys-heading">
        <h3 id="a2a-keys-heading" className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" />{t('credentials')}</h3>
        <p className="text-sm text-muted-foreground">{t('keyWarning')}</p>
        {secret ? <div role="alert" className="space-y-2 text-sm text-muted-foreground"><p>{t('secretOnce')}</p><code className="my-3 block break-all select-all text-xs">{secret}</code>
          <div className="flex flex-wrap items-center gap-3"><CopyButton text={secret} label={t('copyKey')} /><Button onClick={() => setSecret('')} variant={"secondary"} size={"sm"}>{t('hideKey')}</Button></div></div> : null}
        <form onSubmit={(event) => { event.preventDefault(); void mutate({ action: 'create-client', name }); }} className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 text-sm"><Input label={t('clientName')} className="mt-1" maxLength={100} value={name} placeholder={t('clientPlaceholder')} required onChange={(value) => setName(value)} /></div>
          <Button type="submit" disabled={busy || !!secret || !name.trim() || !view.endpoint.enabled || !view.endpoint.ready} variant={"ghost"}>{t('createClient')}</Button>
        </form>
        {!view.endpoint.clients.length ? <p className="text-sm text-muted-foreground">{t('noClients')}</p> : view.endpoint.clients.map((client) => <div key={client.id} className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-sm font-medium">{client.name}</p>
            <Button disabled={busy || !!secret || !view.endpoint?.enabled || !view.endpoint.ready || client.status !== 'active'} onClick={() => void mutate({ action: 'create-key', clientId: client.id })} variant={"secondary"} size={"sm"}>{t('createKey')}</Button></div>
          {client.keys.map((key) => <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
            <div><code>{key.prefix}</code><p className="mt-1 text-muted-foreground">{t(key.revokedAt ? 'revoked' : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? 'expired' : 'activeKey')}</p></div>
            <Button disabled={busy || !!key.revokedAt} onClick={() => { if (window.confirm(t('revokeConfirm'))) void mutate({ action: 'revoke-key', keyId: key.id }); }} variant={"secondary"} size={"sm"}>{t('revoke')}</Button>
          </div>)}
        </div>)}
      </section> : null}
      {initialTaskId ? <AgentA2ATaskMonitor key={initialTaskId} base={base} rootTaskId={initialTaskId} showHistory onRootState={() => {}} /> : null}
    </>}
    <footer className={cardClass}>
      <h3 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />{t('docs')}</h3>
      <div className="flex flex-wrap gap-4 text-sm">{(['console', 'public', 'local'] as const).map((key) => <ButtonLink key={key} href={doc(key)} target="_blank" rel="noopener noreferrer" variant="ghost">{t(key === 'console' ? 'consoleDocs' : key === 'public' ? 'publicDocs' : 'localDocs')}<ArrowUpRight className="size-3" /></ButtonLink>)}</div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4 shrink-0" />{t('boundaries')}</p>
    </footer>
  </div>;
}
