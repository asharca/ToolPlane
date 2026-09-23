'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CopyButton } from '@/components/dashboard/CopyButton';

type Grant = { id: string; name: string; allowedTools: string[]; expiresAt: string; revokedAt: string | null; oauthExpiresAt?: string | null };
export function SandboxMcpExport({ sandboxId, endpoint, exportable }: { sandboxId: string; endpoint: string | null; exportable: boolean }) {
  const t = useTranslations('console.sandboxes');
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/sandboxes/${sandboxId}/mcp-tokens`, { cache: 'no-store' });
      if (!response.ok) throw new Error(t('mcpOperationFailed'));
      setGrants((await response.json()).tokens);
    } catch { setError(t('mcpOperationFailed')); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/sandboxes/${sandboxId}/mcp-tokens/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(t('mcpOperationFailed'));
      setGrants((items) => items?.map((grant) => grant.id === id ? { ...grant, revokedAt: new Date().toISOString() } : grant) ?? null);
    } catch { setError(t('mcpOperationFailed')); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 py-5">
    <h3 className="text-sm font-semibold text-foreground">{t('mcpExportTitle')}</h3>
    {!exportable ? <p className="text-xs text-muted-foreground">{t('mcpProtectedRuntime')}</p> : <>
      <p className="text-xs leading-5 text-muted-foreground">{t('mcpChatgptInstructions')}</p>
      {endpoint ? <div className="flex items-center gap-2 rounded-md border border-border p-3">
        <code className="min-w-0 flex-1 break-all text-xs">{endpoint}</code>
        <CopyButton text={endpoint} label={t('mcpCopyEndpoint')} />
      </div> : <p role="alert" className="text-xs text-destructive">{t('mcpConfigureOrigin')}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{t('mcpScopeWarning')}</p>
    </>}
    <button type="button" disabled={busy} onClick={refresh} className="ui-button-secondary h-8 text-xs">{t('mcpViewGrants')}</button>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {grants ? <div className="space-y-2" aria-live="polite">
      {grants.length === 0 ? <p className="text-xs text-muted-foreground">{t('mcpNoGrants')}</p> : grants.map((grant) => <div key={grant.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
        <div className="min-w-0"><p className="break-all text-sm">{grant.name}</p><p className="break-all text-xs text-muted-foreground">{grant.allowedTools.join(', ')}</p>
          <p className="text-xs text-muted-foreground">{grant.revokedAt ? t('mcpRevoked') : t('mcpGrantExpiry', { date: new Date(grant.oauthExpiresAt ?? grant.expiresAt).toLocaleString() })}</p></div>
        {!grant.revokedAt ? <button type="button" disabled={busy} onClick={() => revoke(grant.id)} className="ui-button-secondary h-8 shrink-0 text-xs">{t('mcpRevoke')}</button> : null}
      </div>)}
    </div> : null}
  </section>;
}
