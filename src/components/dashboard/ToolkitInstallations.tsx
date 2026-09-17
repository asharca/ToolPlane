'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

type Installation = { id: string; client: string; label: string; status: string; lastUsedAt: string | null };
export function ToolkitInstallations({ mcpUrl }: { mcpUrl: string }) {
  const t = useTranslations('console.toolkits');
  const router = useRouter();
  const [items, setItems] = useState<Installation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Use a relative same-origin API path, never send cookies to a configured external origin.
  const endpoint = new URL(mcpUrl, 'https://toolplane.invalid').pathname.replace(/\/mcp$/, '/installations');
  async function load() {
    setBusy(true); setError(false);
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed');
      const data = await response.json();
      setItems(data.installations);
    } catch { setError(true); } finally { setBusy(false); }
  }
  async function mutate(operation: 'revoke' | 'revoke-all' | 'rotate-link', installationId?: string) {
    if (!window.confirm(t(operation === 'rotate-link' ? 'installationRotateWarning' : 'installationRevokeWarning'))) return;
    setBusy(true); setError(false);
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, ...(installationId ? { installationId } : {}) }) });
      if (!response.ok) throw new Error('Failed');
      await load();
      if (operation === 'rotate-link') router.refresh();
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <section className="mt-4 border-t border-border pt-3 text-sm">
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} onClick={load} className="underline disabled:opacity-50">{t('installationDevices')}</button>
      <button type="button" disabled={busy} onClick={() => mutate('revoke-all')} className="underline disabled:opacity-50">{t('installationRevokeAll')}</button>
      <button type="button" disabled={busy} onClick={() => mutate('rotate-link')} className="underline disabled:opacity-50">{t('installationRotateLink')}</button>
    </div>
    {error && <p role="alert" className="mt-2">{t('installationError')}</p>}
    {items && <ul className="mt-2 space-y-2">{items.length === 0 && <li>{t('installationEmpty')}</li>}
      {items.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>{item.label} · {item.client} · {t(item.status === 'active' ? 'installationActive' : 'installationRevoked')} · {t('installationLastUsed')}: {item.lastUsedAt ? new Date(item.lastUsedAt).toISOString() : '—'}</span>
        {item.status === 'active' && <button type="button" disabled={busy} onClick={() => mutate('revoke', item.id)} className="underline">{t('installationRevoke')}</button>}
      </li>)}
    </ul>}
  </section>;
}
